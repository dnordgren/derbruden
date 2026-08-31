import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { TEAM_OWNERS } from './team-owners.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const LEAGUE_ID = process.env.FANTASY_LEAGUE_ID || '794521'
const API_BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl'
const CORE_BASE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl'
const USER_AGENT = 'derbruden.com draft history generator'

// ESPN keeps draft detail for this league back to 2018.
const FIRST_SEASON = 2018
const CONCURRENCY = 8

const CACHE_PATH = path.join(__dirname, 'draft-players.json')
const SRC_DIR = path.join(__dirname, '../src')
const PAGE_PATH = path.join(SRC_DIR, 'drafts.html')

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!match || process.env[match[1]]) continue
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
  }
}

function authHeaders() {
  const espnS2 = process.env.ESPN_S2
  const swid = process.env.SWID
  if (!espnS2) {
    throw new Error('This league is private. Set ESPN_S2 in scripts/.env or your environment.')
  }
  const cookie = swid ? `SWID=${swid}; espn_s2=${espnS2}` : `espn_s2=${espnS2}`
  return {
    Cookie: cookie,
    'User-Agent': USER_AGENT,
  }
}

// The fantasy season runs August through early February.
export function defaultSeason() {
  const now = new Date()
  return now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1
}

export function seasonRange(first, last) {
  const seasons = []
  for (let year = last; year >= first; year--) seasons.push(year)
  return seasons
}

export function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers })
  if (!res.ok) {
    throw new Error(`ESPN API returned ${res.status} for ${url}`)
  }
  return res.json()
}

async function fetchDraft(season) {
  const url = `${API_BASE}/seasons/${season}/segments/0/leagues/${LEAGUE_ID}` + '?view=mDraftDetail&view=mTeam'
  const league = await fetchJson(url, authHeaders())
  const teams = {}
  for (const team of league.teams || []) {
    teams[team.id] = { name: team.name || team.nickname || team.abbrev || `Team ${team.id}` }
  }
  const picks = league.draftDetail && Array.isArray(league.draftDetail.picks) ? league.draftDetail.picks : []
  return { picks, teams }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  async function run() {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'))
  } catch {
    return { version: 1, players: {}, teams: {} }
  }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2))
}

async function resolveTeamAbbr(teamRef, cache) {
  if (!teamRef) return ''
  if (cache.teams[teamRef]) return cache.teams[teamRef]
  const data = await fetchJson(teamRef)
  const abbr = data.abbreviation || ''
  cache.teams[teamRef] = abbr
  return abbr
}

// D/ST slots carry negative ids shaped like -(16000 + NFL team core id).
export function dslNflTeamId(playerId) {
  return playerId <= -16001 ? -playerId - 16000 : null
}

// Before a live draft ESPN pre-fills every slot with playerId -1.
export function isFilledPick(pick) {
  return Boolean(pick && pick.playerId && pick.playerId !== -1)
}

// Names come from the public core API, scoped to the season so the pro team
// reflects the year the player was drafted. No auth needed on this host.
// Some season records are thin (position "Unknown", no team); those fall back
// to the base athlete record.
async function resolveAthlete(season, playerId, cache) {
  const key = `${season}:${playerId}`
  if (cache.players[key]) return cache.players[key]
  const nflTeamId = dslNflTeamId(playerId)
  let info
  if (nflTeamId) {
    const teamData = await fetchJson(`${CORE_BASE}/seasons/${season}/teams/${nflTeamId}`)
    info = {
      name: `${teamData.displayName || `Team ${nflTeamId}`} D/ST`,
      pos: 'D/ST',
      pro: teamData.abbreviation || '',
    }
  } else {
    const data = await fetchJson(`${CORE_BASE}/seasons/${season}/athletes/${playerId}`)
    info = {
      name: data.displayName || data.fullName || `Player ${playerId}`,
      pos: cleanPosition(data.position && data.position.abbreviation),
      pro: '',
    }
    if (data.team) {
      info.pro = await resolveTeamAbbr(data.team.$ref, cache)
    } else {
      try {
        const base = await fetchJson(`${CORE_BASE}/athletes/${playerId}`)
        if (!info.pos) info.pos = cleanPosition(base.position && base.position.abbreviation)
        info.pro = await resolveTeamAbbr(base.team && base.team.$ref, cache)
      } catch {
        // Leave whatever the season record gave us.
      }
    }
  }
  cache.players[key] = info
  return info
}

function cleanPosition(abbrev) {
  return abbrev && abbrev !== '-' ? abbrev : ''
}

// Resolve every pick across every draft. Cached entries skip the network.
export async function resolvePicks(draftsBySeason) {
  const cache = loadCache()
  const jobs = []
  for (const [season, picks] of Object.entries(draftsBySeason)) {
    for (const pick of picks) {
      if (isFilledPick(pick)) jobs.push({ season: Number(season), playerId: pick.playerId })
    }
  }
  let misses = 0
  await mapLimit(jobs, CONCURRENCY, async job => {
    try {
      await resolveAthlete(job.season, job.playerId, cache)
    } catch {
      misses++
    }
  })
  saveCache(cache)
  if (misses > 0) console.warn(`Could not resolve ${misses} players; they will show as placeholders.`)
  return cache
}

export function pickRoundLabel(pick) {
  return `R${pick.roundId}P${pick.roundPickNumber}`
}

// "R3P6 (52 overall): Joe Johnson (RB, ATL)"
export function formatPickSummary(pick, info) {
  const head = `${pickRoundLabel(pick)} (${pick.overallPickNumber} overall): `
  if (!pick.playerId) return head + 'no player'
  const name = (info && info.name) || `Player ${pick.playerId}`
  const parts = [info && info.pos, info && info.pro].filter(Boolean)
  const descriptor = parts.length > 0 ? ` (${parts.join(', ')})` : ''
  const keeper = pick.keeper ? ' (keeper)' : ''
  return head + name + descriptor + keeper
}

export function picksByOwner(picks) {
  const grouped = {}
  for (const pick of picks) {
    if (!grouped[pick.teamId]) grouped[pick.teamId] = []
    grouped[pick.teamId].push(pick)
  }
  for (const teamPicks of Object.values(grouped)) {
    teamPicks.sort((a, b) => a.overallPickNumber - b.overallPickNumber)
  }
  return grouped
}

// Draft slot order, left to right on the board: the team making overall
// pick 1 leads round one, and so on.
export function slotOrder(picks) {
  return picks
    .filter(pick => pick.roundId === 1)
    .sort((a, b) => a.overallPickNumber - b.overallPickNumber)
    .map(pick => pick.teamId)
}

// Grid of picks keyed by round then team. A team can hold several picks in
// one round through trades, so each cell keeps an ordered list.
export function buildBoard(picks) {
  const order = slotOrder(picks)
  const rounds = []
  for (const pick of picks) {
    const round = pick.roundId - 1
    if (!rounds[round]) rounds[round] = {}
    if (!rounds[round][pick.teamId]) rounds[round][pick.teamId] = []
    rounds[round][pick.teamId].push(pick)
  }
  for (const row of rounds) {
    for (const cell of Object.values(row)) {
      cell.sort((a, b) => a.overallPickNumber - b.overallPickNumber)
    }
  }
  return { order, rounds }
}

// Board color group for a fantasy position.
export function positionClass(pos) {
  switch (pos) {
    case 'QB':
      return 'qb'
    case 'TE':
      return 'te'
    case 'K':
      return 'k'
    case 'D/ST':
      return 'dst'
    case 'RB':
    case 'WR':
      return 'skill'
    default:
      return 'unknown'
  }
}

function boardPickHtml(pick, cache, season) {
  const info = cache.players[`${season}:${pick.playerId}`] || {}
  let name = info.name || `Player ${pick.playerId}`
  const pos = info.pos === 'D/ST' ? 'DST' : info.pos
  if (info.pos === 'D/ST') name = name.replace(/ D\/ST$/, '')
  const sub = [info.pro, pos].filter(Boolean).join(' ~ ')
  const keeperAttrs = pick.keeper ? ' keeper" title="Keeper pick' : ''
  const keeperLabel = pick.keeper ? '<span class="visually-hidden"> (keeper)</span>' : ''
  return (
    `<div class="pick ${positionClass(info.pos)}${keeperAttrs}">` +
    `<span class="pick-name">${escapeHtml(name)}${keeperLabel}</span>` +
    `<span class="pick-sub">${escapeHtml(sub) || '&nbsp;'}</span></div>`
  )
}

function renderSeasonBoard(season, picks, teams, cache) {
  const board = buildBoard(picks)
  const headCells = board.order
    .map(teamId => {
      const mapped = TEAM_OWNERS[teamId]
      const team = teams && teams[teamId]
      const label = team ? escapeHtml(team.name) : mapped ? mapped.owner : `Team ${teamId}`
      const owner = mapped ? `<span class="head-owner">${mapped.owner}</span>` : ''
      return `<th scope="col" class="team-head">${label}${owner}</th>`
    })
    .join('')

  const rows = board.rounds
    .map((row, index) => {
      const round = index + 1
      // Serpentine draft: odd rounds snake left to right, even rounds back.
      const dir = round % 2 === 1 ? '&rarr;' : '&larr;'
      const cells = board.order
        .map(teamId => {
          const cellPicks = (row && row[teamId]) || []
          const body = cellPicks.map(pick => boardPickHtml(pick, cache, season)).join('')
          return `<td class="board-cell">${body}</td>`
        })
        .join('')
      return `<tr><th scope="row" class="round-head">ROUND #${round}<span class="dir">${dir}</span></th>${cells}</tr>`
    })
    .join('\n')

  return `<section class="draft-season" id="draft-${season}">
    <h2>${season} Draft</h2>
    <div class="table-container">
      <table class="draft-board">
        <caption class="visually-hidden">${season} draft board</caption>
        <thead>
          <tr><th scope="col" class="round-head"></th>${headCells}</tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  </section>`
}

function renderContent(draftsBySeason, teamsBySeason, cache, meta) {
  const seasons = Object.keys(draftsBySeason)
    .map(Number)
    .sort((a, b) => b - a)

  const links = seasons.map(season => `<a href="#draft-${season}">${season}</a>`).join(' ')
  const sections = seasons
    .map(season => renderSeasonBoard(season, draftsBySeason[season], teamsBySeason[season], cache))
    .join('\n')

  return `<div class="owner-logo-header">
      <img src="../static/img/league-logo.webp" alt="DB Logo" width="100" height="100"
        style="border-radius: 50%; object-fit: cover;" />
      <h1>Draft History</h1>
    </div>
    <p class="draft-meta">${seasons[seasons.length - 1]}&ndash;${seasons[0]} drafts &middot; generated ${meta.generated}</p>
    <p class="season-links">${links}</p>
    <p class="legend">
      <span class="chip skill"></span>RB/WR
      <span class="chip qb"></span>QB
      <span class="chip te"></span>TE
      <span class="chip k"></span>K
      <span class="chip dst"></span>DST
      <span class="chip keeper-chip"></span>Keeper
    </p>
    ${sections}
    <details class="methodology">
      <summary>About this page</summary>
      <p>Every draft since the league moved to ESPN in 2018, laid out as the serpentine draft board. Columns follow first-round slot order; the arrow on each round shows the snake direction. The folded corner marks a keeper pick. Pro teams reflect the season of the draft.</p>
      <p>The current year appears once its live draft has results.</p>
      <p>Data comes from the ESPN fantasy API. Regenerate with <code>make drafts</code>.</p>
    </details>`
}

function pageTemplate(content) {
  return `<!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DerBruden.com | Draft History</title>
  <!--#include file="partials/head-common.html" -->
  <style>
    .legend {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      color: var(--muted);
      font-size: 0.8em;
      margin-bottom: 10px;
    }

    .chip {
      display: inline-block;
      width: 14px;
      height: 14px;
      border-radius: 3px;
      margin-left: 10px;
    }

    .chip.skill { background: #b5e0ae; }
    .chip.qb { background: #cdb9f5; }
    .chip.te { background: #f49e9e; }
    .chip.k { background: #f6bd7a; }
    .chip.dst { background: #c9d2da; }
    .chip.keeper-chip {
      background: linear-gradient(135deg, transparent 0 50%, #00000055 50% 100%), var(--paper);
      border: 1px solid var(--line);
    }

    .draft-board {
      border-collapse: separate;
      border-spacing: 2px;
      margin: 20px 0 40px;
      font-size: 0.9em;
    }

    .draft-board .round-head {
      position: sticky;
      left: 0;
      z-index: 1;
      background: var(--surface);
      font-size: 0.8em;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      text-align: left;
      white-space: nowrap;
      padding: 8px 14px 8px 2px;
      vertical-align: middle;
    }

    .draft-board .round-head .dir {
      display: block;
      font-size: 1.1em;
    }

    .draft-board .team-head {
      font-size: 0.8em;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      text-align: center;
      vertical-align: bottom;
      max-width: 118px;
      min-width: 104px;
      padding: 6px 8px;
    }

    .draft-board .head-owner {
      display: block;
      color: var(--muted);
      letter-spacing: 0.1em;
    }

    .draft-board .board-cell {
      vertical-align: top;
      padding: 0;
      height: 1px;
    }

    .pick {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 3px;
      border-radius: 3px;
      padding: 8px 10px;
      min-height: 52px;
      height: 100%;
      color: #1f2937;
    }

    .pick-name {
      font-weight: 700;
      line-height: 1.25;
    }

    .pick-sub {
      font-size: 0.78em;
      opacity: 0.75;
      white-space: nowrap;
    }

    .pick.skill { background: #b5e0ae; }
    .pick.qb { background: #cdb9f5; }
    .pick.te { background: #f49e9e; }
    .pick.k { background: #f6bd7a; }
    .pick.dst { background: #c9d2da; }
    .pick.unknown { background: #ececec; }

    .pick.keeper::after {
      content: '';
      position: absolute;
      top: 0;
      right: 0;
      border-style: solid;
      border-width: 0 10px 10px 0;
      border-color: transparent #00000040 transparent transparent;
      border-top-right-radius: 3px;
    }

    .draft-meta,
    .season-links {
      color: var(--muted);
      font-size: 0.9em;
    }

    .season-links a {
      color: var(--accent);
      text-decoration: underline;
      margin-right: 8px;
    }

    .draft-season h2 {
      margin-bottom: 0;
    }

    .methodology {
      margin-top: 30px;
      font-size: 0.85em;
      color: var(--muted);
    }
  </style>
</head>

<body>
  <!--#include file="partials/site-header.html" -->

  <!--#include file="partials/nav.html" -->

  <main id="main">
    ${content}
  </main>

  <!--#include file="partials/footer.html" -->
</body>

</html>
`
}

function writeDraftsPage(draftsBySeason, teamsBySeason, cache) {
  const meta = { generated: new Date().toISOString().slice(0, 10) }
  const html = pageTemplate(renderContent(draftsBySeason, teamsBySeason, cache, meta))
  fs.writeFileSync(PAGE_PATH, html)
  console.log(`Wrote ${PAGE_PATH}`)
}

function renderOwnerSection(draftsBySeason, cache, ownerCode) {
  const teamIds = Object.entries(TEAM_OWNERS)
    .filter(([, v]) => v.owner === ownerCode)
    .map(([k]) => Number(k))

  const seasons = Object.keys(draftsBySeason)
    .map(Number)
    .sort((a, b) => b - a)

  const paragraphs = []
  for (const season of seasons) {
    const grouped = picksByOwner(draftsBySeason[season])
    const picks = teamIds.flatMap(id => grouped[id] || [])
    if (picks.length === 0) continue
    const summaries = picks.map(pick => formatPickSummary(pick, cache.players[`${season}:${pick.playerId}`]))
    paragraphs.push(`<p><strong>${season}:</strong> ${summaries.map(escapeHtml).join('; ')}</p>`)
  }

  return `<!-- DRAFT_HISTORY_START -->
  <section class="draft-history">
    <h2>Draft Picks</h2>
    ${paragraphs.join('\n    ')}
  </section>
  <!-- DRAFT_HISTORY_END -->`
}

function updateOwnerPages(draftsBySeason, cache) {
  const START = '<!-- DRAFT_HISTORY_START -->'
  const END = '<!-- DRAFT_HISTORY_END -->'
  for (const { owner, page } of Object.values(TEAM_OWNERS)) {
    const filePath = path.join(SRC_DIR, page)
    if (!fs.existsSync(filePath)) {
      console.warn(`File not found: ${filePath}`)
      continue
    }
    let content = fs.readFileSync(filePath, 'utf8')
    const section = renderOwnerSection(draftsBySeason, cache, owner)

    if (content.includes(START) && content.includes(END)) {
      const startIdx = content.indexOf(START)
      const endIdx = content.indexOf(END)
      if (endIdx < startIdx) {
        console.warn(`Malformed draft markers in ${page}; skipping.`)
        continue
      }
      content = content.slice(0, startIdx) + section + content.slice(endIdx + END.length)
    } else if (content.includes('</main>')) {
      content = content.replace('</main>', `${section}\n  </main>`)
    } else {
      console.warn(`Could not find insertion point in ${page}`)
      continue
    }

    fs.writeFileSync(filePath, content)
    console.log(`Updated ${page}`)
  }
}

async function main() {
  loadEnvFile()
  authHeaders()

  const lastSeason = defaultSeason()
  const draftsBySeason = {}
  const teamsBySeason = {}
  for (const season of seasonRange(FIRST_SEASON, lastSeason)) {
    const { picks, teams } = await fetchDraft(season)
    if (picks.length > 0) {
      draftsBySeason[season] = picks.filter(isFilledPick)
      teamsBySeason[season] = teams
      console.log(`${season}: ${picks.length} picks`)
    } else {
      console.log(`${season}: no completed draft, skipping`)
    }
  }

  if (Object.keys(draftsBySeason).length === 0) {
    throw new Error('No draft data found for any season.')
  }

  const cache = await resolvePicks(draftsBySeason)

  writeDraftsPage(draftsBySeason, teamsBySeason, cache)
  updateOwnerPages(draftsBySeason, cache)
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch(err => {
    console.error(err.message)
    process.exit(1)
  })
}
