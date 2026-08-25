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

async function fetchDraftPicks(season) {
  const url = `${API_BASE}/seasons/${season}/segments/0/leagues/${LEAGUE_ID}` + '?view=mDraftDetail'
  const league = await fetchJson(url, authHeaders())
  return league.draftDetail && Array.isArray(league.draftDetail.picks) ? league.draftDetail.picks : []
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

function ownerCell(teamId) {
  const mapped = TEAM_OWNERS[teamId]
  if (mapped) return `<td class="owner"><a href="./${mapped.page}">${mapped.owner}</a></td>`
  return '<td class="owner">&ndash;</td>'
}

function playerCell(pick, cache, season) {
  if (!pick.playerId) return '<td>&ndash;</td>'
  const info = cache.players[`${season}:${pick.playerId}`]
  const name = escapeHtml(info ? info.name : `Player ${pick.playerId}`)
  const keeper = pick.keeper ? ' <span class="keeper" title="Keeper pick">K</span>' : ''
  return `<td>${name}${keeper}</td>`
}

function renderSeasonTable(season, picks, cache) {
  const rows = [...picks]
    .sort((a, b) => a.overallPickNumber - b.overallPickNumber)
    .map(
      pick => `<tr>
        <td class="number">${pick.overallPickNumber}</td>
        <td class="number">${pick.roundId}</td>
        <td class="number">${pick.roundPickNumber}</td>
        ${ownerCell(pick.teamId)}
        ${playerCell(pick, cache, season)}
        <td>${(cache.players[`${season}:${pick.playerId}`] || {}).pos || '&ndash;'}</td>
        <td>${(cache.players[`${season}:${pick.playerId}`] || {}).pro || '&ndash;'}</td>
      </tr>`
    )
    .join('\n')

  return `<section class="draft-season" id="draft-${season}">
    <h2>${season} Draft</h2>
    <div class="table-container">
      <table class="stats-table">
        <thead>
          <tr>
            <th class="number">#</th>
            <th class="number">Rd</th>
            <th class="number">Pk</th>
            <th>Owner</th>
            <th>Player</th>
            <th>Pos</th>
            <th>NFL</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  </section>`
}

function renderContent(draftsBySeason, cache, meta) {
  const seasons = Object.keys(draftsBySeason)
    .map(Number)
    .sort((a, b) => b - a)

  const links = seasons.map(season => `<a href="#draft-${season}">${season}</a>`).join(' ')
  const sections = seasons.map(season => renderSeasonTable(season, draftsBySeason[season], cache)).join('\n')

  return `<div class="owner-logo-header">
      <img src="../static/img/league-logo.webp" alt="DB Logo" width="100" height="100"
        style="border-radius: 50%; object-fit: cover;" />
      <h1>Draft History</h1>
    </div>
    <p class="draft-meta">${seasons[seasons.length - 1]}&ndash;${seasons[0]} drafts &middot; generated ${meta.generated}</p>
    <p class="season-links">${links}</p>
    ${sections}
    <details class="methodology">
      <summary>About this page</summary>
      <p>Every draft pick since the league moved to ESPN in 2018. K marks a keeper pick. Pro teams reflect the season of the draft.</p>
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
  <link rel="icon" href="../static/ico/header-icon-32.png" type="image/x-icon">
  <link rel="shortcut icon" href="../static/ico/header-icon-32.png" type="image/x-icon">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Archivo:ital,wght@0,100..900;1,100..900&display=swap"
    rel="stylesheet">
  <style>
    body {
      font-family: "Archivo", sans-serif;
      line-height: 1.6;
      margin: 0;
      padding: 20px;
      max-width: 1200px;
      margin: 0 auto;
    }

    .header {
      display: flex;
      align-items: center;
    }

    .header-container {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0px;
    }

    .logo {
      width: 100px;
      height: 75px;
    }

    .site-title {
      margin: 0;
      font-size: 24px;
    }

    .tagline {
      margin: 0;
      color: #666;
    }

    nav {
      margin-bottom: 30px;
    }

    footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #eee;
    }

    a {
      color: #000;
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }

    .table-container { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .stats-table {
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
      font-size: 0.9em;
    }

    .stats-table th {
      background-color: #f4f4f4;
      padding: 12px;
      text-align: left;
      border-bottom: 2px solid #ddd;
    }

    .stats-table td {
      padding: 10px 12px;
      border-bottom: 1px solid #eee;
    }

    .stats-table tbody tr:hover {
      background-color: #f8f8f8;
    }

    .stats-table .number {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    .stats-table .owner {
      font-weight: 500;
    }

    .stats-table td a {
      color: #00429f;
      text-decoration: underline;
    }

    .owner-logo-header {
      display: flex;
      align-items: center;
      gap: 20px;
      margin-bottom: 20px;
    }

    .draft-meta,
    .season-links {
      color: #666;
      font-size: 0.9em;
    }

    .season-links a {
      color: #00429f;
      text-decoration: underline;
      margin-right: 8px;
    }

    .draft-season h2 {
      margin-bottom: 0;
    }

    .keeper {
      display: inline-block;
      margin-left: 4px;
      padding: 0 6px;
      border-radius: 8px;
      background: #b8860b;
      color: #fff;
      font-size: 0.75em;
      font-weight: 600;
    }

    .methodology {
      margin-top: 30px;
      font-size: 0.85em;
      color: #666;
    }

    @media (max-width: 768px) {
      .header-container {
        flex-direction: column;
        text-align: center;
      }
    }
  </style>
</head>

<body>
  <header>
    <div class="header-container">
      <div class="header">
        <a href="./index.html">
          <img src="../static/img/header-logo.webp" alt="DerBruden.com" class="logo" width="100" height="75">
        </a>
        <div>
          <h1 class="site-title">DerBruden.com</h1>
          <p class="tagline">Strange dreams lately?</p>
        </div>
      </div>
    </div>
  </header>

  <nav>
    <p><a href="./about.html">About</a> || <a href="./owners.html">League Owners</a> || <a
        href="./power-rankings.html">Power Rankings</a> || <a href="./trades.html">Trades</a> || <a
        href="./drafts.html">Drafts</a></p>
  </nav>

  <main>
    ${content}
  </main>

  <footer>
    <p>
      <a href="https://fantasy.espn.com/football/league?leagueId=794521" target="_blank">ESPN</a> /
      <a href="https://discord.com/channels/870404843582406696/870404844681322549" target="_blank">Discord</a>
    </p>
  </footer>
</body>

</html>
`
}

function writeDraftsPage(draftsBySeason, cache) {
  const meta = { generated: new Date().toISOString().slice(0, 10) }
  const html = pageTemplate(renderContent(draftsBySeason, cache, meta))
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
  for (const season of seasonRange(FIRST_SEASON, lastSeason)) {
    const picks = (await fetchDraftPicks(season)).filter(isFilledPick)
    if (picks.length > 0) {
      draftsBySeason[season] = picks
      console.log(`${season}: ${picks.length} picks`)
    } else {
      console.log(`${season}: no completed draft, skipping`)
    }
  }

  if (Object.keys(draftsBySeason).length === 0) {
    throw new Error('No draft data found for any season.')
  }

  const cache = await resolvePicks(draftsBySeason)

  writeDraftsPage(draftsBySeason, cache)
  updateOwnerPages(draftsBySeason, cache)
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch(err => {
    console.error(err.message)
    process.exit(1)
  })
}
