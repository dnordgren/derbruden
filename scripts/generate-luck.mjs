import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname as pathDirname, join } from 'path'
import { TEAM_OWNERS } from './team-owners.js'

const __dirname = pathDirname(fileURLToPath(import.meta.url))

const LEAGUE_ID = process.env.FANTASY_LEAGUE_ID || '794521'
const API_BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl'
const API_FIRST_SEASON = 2018
const USER_AGENT = 'derbruden.com luck-allplay generator'
const CLOSE_MARGIN = 10

const DATA_PATH = join(__dirname, '../static/data/luck.json')
const PAGE_PATH = join(__dirname, '../src/luck.html')

export function defaultSeason() {
  const now = new Date()
  return now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1
}

function loadEnvFile() {
  const envPath = join(__dirname, '.env')
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
  return { Cookie: cookie, 'User-Agent': USER_AGENT }
}

async function fetchLeague(season) {
  const url = `${API_BASE}/seasons/${season}/segments/0/leagues/${LEAGUE_ID}` + '?view=mTeam&view=mMatchupScore'
  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) throw new Error(`ESPN API returned ${res.status} for season ${season}`)
  return res.json()
}

export function extractRegularSeasonGames(league, season) {
  const games = []
  for (const m of league.schedule || []) {
    if (m.playoffTierType !== 'NONE') continue
    const { home, away } = m
    if (!home || !away || typeof home.totalPoints !== 'number' || typeof away.totalPoints !== 'number') continue
    const winner = String(m.winner || '').toLowerCase()
    if (!['home', 'away', 'tie'].includes(winner)) continue
    if (winner !== 'tie' && home.totalPoints === 0 && away.totalPoints === 0) continue
    games.push({
      season,
      week: m.matchupPeriodId,
      homeId: home.teamId,
      awayId: away.teamId,
      homeScore: home.totalPoints,
      awayScore: away.totalPoints,
      winner,
    })
  }
  return games.sort((a, b) => a.week - b.week)
}

export function seasonTeamMeta(league) {
  const meta = {}
  for (const t of league.teams || []) {
    meta[t.id] = { id: t.id, abbrev: t.abbrev, name: t.name || t.nickname || t.abbrev }
  }
  return meta
}

export function makeOwnerLookup(metaBySeason) {
  const fallback = {}
  for (const meta of Object.values(metaBySeason)) {
    for (const team of Object.values(meta)) {
      if (!TEAM_OWNERS[team.id] && !(team.id in fallback)) fallback[team.id] = team.abbrev
    }
  }
  return teamId => TEAM_OWNERS[teamId]?.owner ?? fallback[teamId] ?? `team ${teamId}`
}

function round1(n) {
  return Math.round(n * 10) / 10
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

// Compute all-play standings for a single season
export function computeAllPlayStandings(games, ownerOf, nameOf) {
  if (!games.length) return []

  const actual = new Map() // ownerKey -> object
  const ensureActual = (teamId, season) => {
    const owner = ownerOf(teamId)
    const key = owner
    if (!actual.has(key)) {
      actual.set(key, {
        owner,
        teamId,
        team: nameOf(season, teamId),
        actualW: 0,
        actualL: 0,
        actualT: 0,
        pf: 0,
        pa: 0,
      })
    }
    // Keep team name fresh (last seen)
    actual.get(key).team = nameOf(season, teamId) || actual.get(key).team
    return actual.get(key)
  }

  for (const g of games) {
    const homeOwner = ownerOf(g.homeId)
    const awayOwner = ownerOf(g.awayId)
    const homeRow = ensureActual(g.homeId, g.season)
    const awayRow = ensureActual(g.awayId, g.season)
    homeRow.pf += g.homeScore
    homeRow.pa += g.awayScore
    awayRow.pf += g.awayScore
    awayRow.pa += g.homeScore
    if (g.winner === 'tie') {
      homeRow.actualT += 1
      awayRow.actualT += 1
    } else if (g.winner === 'home') {
      homeRow.actualW += 1
      awayRow.actualL += 1
    } else {
      awayRow.actualW += 1
      homeRow.actualL += 1
    }
  }

  // Group by season-week composite so all-time aggregation does not collapse weeks across seasons
  const weekGroups = new Map() // `${season}-${week}` -> [{teamId, score}]
  for (const g of games) {
    const key = `${g.season}-${g.week}`
    if (!weekGroups.has(key)) weekGroups.set(key, [])
    weekGroups.get(key).push({ teamId: g.homeId, score: g.homeScore })
    weekGroups.get(key).push({ teamId: g.awayId, score: g.awayScore })
  }

  const allPlay = new Map() // owner -> {w,l,t}
  for (const row of actual.values()) {
    allPlay.set(row.owner, { w: 0, l: 0, t: 0 })
  }

  for (const entries of weekGroups.values()) {
    // For each team, compare to every other team that week
    for (let i = 0; i < entries.length; i++) {
      const a = entries[i]
      const ownerA = ownerOf(a.teamId)
      const rec = allPlay.get(ownerA)
      if (!rec) continue
      for (let j = 0; j < entries.length; j++) {
        if (i === j) continue
        const b = entries[j]
        if (a.score > b.score) rec.w += 1
        else if (a.score < b.score) rec.l += 1
        else rec.t += 1
      }
    }
  }

  const rows = []
  for (const [owner, act] of actual) {
    const ap = allPlay.get(owner) || { w: 0, l: 0, t: 0 }
    const allPlayGames = ap.w + ap.l + ap.t
    const allPlayPct = allPlayGames ? (ap.w + ap.t * 0.5) / allPlayGames : 0
    const actualGames = act.actualW + act.actualL + act.actualT
    const actualPct = actualGames ? (act.actualW + act.actualT * 0.5) / actualGames : 0
    const expectedWins = Math.round(allPlayPct * actualGames * 10) / 10
    const delta = Math.round((act.actualW + act.actualT * 0.5 - expectedWins) * 10) / 10
    rows.push({
      owner,
      team: act.team,
      teamId: act.teamId,
      actualW: act.actualW,
      actualL: act.actualL,
      actualT: act.actualT,
      pf: round1(act.pf),
      pa: round1(act.pa),
      ppg: actualGames ? round1(act.pf / actualGames) : 0,
      allPlayW: ap.w,
      allPlayL: ap.l,
      allPlayT: ap.t,
      allPlayPct: Math.round(allPlayPct * 1000) / 1000,
      actualPct: Math.round(actualPct * 1000) / 1000,
      expectedWins,
      delta, // positive = benefited from schedule
    })
  }

  // Sort by all-play win pct, then PF, then owner
  rows.sort((a, b) => b.allPlayPct - a.allPlayPct || b.pf - a.pf || a.owner.localeCompare(b.owner))

  // Compute rankings
  rows.forEach((r, idx) => {
    r.allPlayRank = idx + 1
  })

  // Also compute PF rank for cross referencing
  const pfSorted = [...rows].sort((a, b) => b.pf - a.pf)
  const pfRankMap = new Map(pfSorted.map((r, i) => [r.owner, i + 1]))
  rows.forEach(r => (r.pfRank = pfRankMap.get(r.owner)))

  // And actual rank
  const actualSorted = [...rows].sort((a, b) => b.actualW - a.actualW || b.pf - a.pf)
  const actualRankMap = new Map(actualSorted.map((r, i) => [r.owner, i + 1]))
  rows.forEach(r => (r.actualRank = actualRankMap.get(r.owner)))

  return rows
}

// Compute luck index for a single season
export function computeLuckIndex(games, ownerOf, nameOf) {
  if (!games.length) return []

  const pfMap = new Map() // owner -> pf
  const closeMap = new Map() // owner -> {w,l,t, games}

  const ensurePf = (teamId, season) => {
    const owner = ownerOf(teamId)
    if (!pfMap.has(owner)) pfMap.set(owner, { owner, team: nameOf(season, teamId), pf: 0, teamId })
    const row = pfMap.get(owner)
    row.team = nameOf(season, teamId) || row.team
    return row
  }
  const ensureClose = owner => {
    if (!closeMap.has(owner)) closeMap.set(owner, { w: 0, l: 0, t: 0 })
    return closeMap.get(owner)
  }

  // Initialize pfMap entries for all owners seen
  for (const g of games) {
    ensurePf(g.homeId, g.season).pf += g.homeScore
    ensurePf(g.awayId, g.season).pf += g.awayScore
    ensureClose(ownerOf(g.homeId))
    ensureClose(ownerOf(g.awayId))
  }

  for (const g of games) {
    const margin = Math.abs(g.homeScore - g.awayScore)
    if (!(margin < CLOSE_MARGIN)) continue
    const homeOwner = ownerOf(g.homeId)
    const awayOwner = ownerOf(g.awayId)
    const homeRec = ensureClose(homeOwner)
    const awayRec = ensureClose(awayOwner)
    if (g.winner === 'tie') {
      homeRec.t += 1
      awayRec.t += 1
    } else if (g.winner === 'home') {
      homeRec.w += 1
      awayRec.l += 1
    } else {
      awayRec.w += 1
      homeRec.l += 1
    }
  }

  // Build rows
  const pfRows = [...pfMap.values()].map(r => ({ ...r, pf: round1(r.pf) }))

  pfRows.sort((a, b) => b.pf - a.pf || a.owner.localeCompare(b.owner))
  const pfRankMap = new Map(pfRows.map((r, i) => [r.owner, i + 1]))

  // Build close pct
  const rows = pfRows.map(r => {
    const cr = closeMap.get(r.owner) || { w: 0, l: 0, t: 0 }
    const closeGames = cr.w + cr.l + cr.t
    const closePct = closeGames ? (cr.w + cr.t * 0.5) / closeGames : null
    return {
      owner: r.owner,
      team: r.team,
      teamId: r.teamId,
      pf: r.pf,
      pfRank: pfRankMap.get(r.owner),
      closeW: cr.w,
      closeL: cr.l,
      closeT: cr.t,
      closeGames,
      closePct: closePct != null ? Math.round(closePct * 1000) / 1000 : null,
    }
  })

  // Rank by closePct (nulls at bottom), then closeWins
  const ranked = [...rows]
    .filter(r => r.closeGames > 0)
    .sort((a, b) => b.closePct - a.closePct || b.closeW - a.closeW || a.owner.localeCompare(b.owner))
  const closeRankMap = new Map()
  ranked.forEach((r, i) => closeRankMap.set(r.owner, i + 1))
  // For owners with no close games, no rank
  rows.forEach(r => {
    r.closeRank = closeRankMap.get(r.owner) ?? null
    if (r.closeRank != null && r.pfRank != null) {
      r.luckDiff = r.pfRank - r.closeRank // positive = lucky (wins close despite low scoring)
    } else {
      r.luckDiff = null
    }
    r.luckLabel = luckLabel(r)
  })

  // Sort luck table by luckDiff descending (most lucky first), then closePct
  // But we want to return rows in a consistent order for display: luckDiff desc
  const luckSorted = [...rows].sort((a, b) => {
    if (a.luckDiff == null && b.luckDiff == null) return (b.closePct ?? -1) - (a.closePct ?? -1)
    if (a.luckDiff == null) return 1
    if (b.luckDiff == null) return -1
    return b.luckDiff - a.luckDiff || (b.closePct ?? 0) - (a.closePct ?? 0)
  })

  // Preserve pfRank ordering for alternative view? But return luckSorted
  return luckSorted
}

export function luckLabel(row) {
  if (row.closeGames === 0) return 'No close games'
  if (row.closeGames < 3) return 'Small sample'
  if (row.luckDiff == null) return '—'
  if (row.luckDiff >= 4) return '🍀 Very Lucky'
  if (row.luckDiff >= 2) return '🍀 Lucky'
  if (row.luckDiff <= -4) return '💀 Very Unlucky'
  if (row.luckDiff <= -2) return '💀 Unlucky'
  if (row.closePct != null && row.closePct >= 0.75) return '🍀 Lucky'
  if (row.closePct != null && row.closePct <= 0.25) return '💀 Unlucky'
  return 'Neutral'
}

export function allPlayVerdict(row) {
  const d = row.delta
  if (d >= 2) return 'Benefited from schedule'
  if (d >= 1) return 'Slightly lucky schedule'
  if (d <= -2) return 'Hurt by schedule'
  if (d <= -1) return 'Tough schedule'
  return 'As expected'
}

// Aggregation for all-time (regular season 2018+)
export function computeAllTimeAllPlay(allGames, ownerOf, nameOf) {
  // Group by owner across all seasons already via computeAllPlayStandings on combined games
  // But need to handle owner lookup per season: ownerOf must be season-aware. For all-time we pass ownerOf that is already season-aware via closure; but we have games with season field so we could use teamId->owner via TEAM_OWNERS stable.
  return computeAllPlayStandings(allGames, ownerOf, (season, teamId) => nameOf(season, teamId))
}

export function computeAllTimeLuck(allGames, ownerOf, nameOf) {
  return computeLuckIndex(allGames, ownerOf, nameOf)
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function ownerLink(owner) {
  const mapped = Object.values(TEAM_OWNERS).find(m => m.owner === owner)
  return mapped ? `<a href="./${mapped.page}">${escapeHtml(owner)}</a>` : escapeHtml(owner)
}

function renderAllPlayTable(rows, caption) {
  if (!rows.length) return `<p class="section-note">No regular-season games for this season.</p>`
  const body = rows
    .map(
      r => `<tr>
        <td class="number">${r.allPlayRank}</td>
        <td class="owner">${ownerLink(r.owner)}</td>
        <td>${escapeHtml(r.team)}</td>
        <td class="number">${r.actualW}-${r.actualL}${r.actualT ? `-${r.actualT}` : ''}</td>
        <td class="number">${fmt(r.pf)}</td>
        <td class="number">${r.allPlayW}-${r.allPlayL}${r.allPlayT ? `-${r.allPlayT}` : ''}</td>
        <td class="number">${(r.allPlayPct * 100).toFixed(1)}%</td>
        <td class="number">${r.delta > 0 ? `+${fmt(r.delta)}` : fmt(r.delta)}</td>
        <td class="detail">${escapeHtml(allPlayVerdict(r))}</td>
      </tr>`
    )
    .join('\n')
  return `<div class="table-container"><table class="stats-table">
    <caption class="visually-hidden">${escapeHtml(caption)}</caption>
    <thead>
      <tr>
        <th scope="col" class="number">AP Rank</th>
        <th scope="col">Owner</th>
        <th scope="col">Team</th>
        <th scope="col" class="number">Record</th>
        <th scope="col" class="number">PF</th>
        <th scope="col" class="number">All-Play</th>
        <th scope="col" class="number">AP %</th>
        <th scope="col" class="number">Luck (W-AP)</th>
        <th scope="col">Schedule</th>
      </tr>
    </thead>
    <tbody>
${body}
    </tbody>
  </table></div>`
}

function renderLuckTable(rows, caption) {
  if (!rows.length) return `<p class="section-note">No regular-season games for this season.</p>`
  const body = rows
    .map(
      r => {
        const closeRecord = `${r.closeW}-${r.closeL}${r.closeT ? `-${r.closeT}` : ''}`
        const closePct = r.closePct != null ? `${(r.closePct * 100).toFixed(0)}%` : '—'
        const diffCell = r.luckDiff != null ? (r.luckDiff > 0 ? `+${r.luckDiff}` : `${r.luckDiff}`) : '—'
        const pfRankCell = r.pfRank
        return `<tr>
        <td class="owner">${ownerLink(r.owner)}</td>
        <td>${escapeHtml(r.team)}</td>
        <td class="number">${fmt(r.pf)}</td>
        <td class="number">${pfRankCell}</td>
        <td class="number">${closeRecord}</td>
        <td class="number">${closePct}</td>
        <td class="number">${diffCell}</td>
        <td class="detail">${escapeHtml(r.luckLabel)}</td>
      </tr>`
      }
    )
    .join('\n')
  return `<div class="table-container"><table class="stats-table">
    <caption class="visually-hidden">${escapeHtml(caption)}</caption>
    <thead>
      <tr>
        <th scope="col">Owner</th>
        <th scope="col">Team</th>
        <th scope="col" class="number">PF</th>
        <th scope="col" class="number">PF Rank</th>
        <th scope="col" class="number">Close &lt;10</th>
        <th scope="col" class="number">Close %</th>
        <th scope="col" class="number">Luck (PF−Close)</th>
        <th scope="col">Verdict</th>
      </tr>
    </thead>
    <tbody>
${body}
    </tbody>
  </table></div>`
}

export function renderAllPlaySection(perSeason, allTimeRows, defaultSeasonYear) {
  const currentRows = perSeason[defaultSeasonYear]?.allPlay || []
  const currentCap = `${defaultSeasonYear} All-Play Standings`
  const selector = renderSeasonSelector(Object.keys(perSeason).sort(), defaultSeasonYear, 'allplay')
  return `<h2>All-Play Standings</h2>
<p class="section-note">Every team plays every other team each week. A 10-team league produces nine All-Play results per week. This strips schedule luck and shows who was actually strong. Regular season only, 2018 on.</p>
${selector}
<div id="allplay-table-wrap">
${renderAllPlayTable(currentRows, currentCap)}
</div>
<h3>All-Time All-Play (2018–${Math.max(...Object.keys(perSeason).map(Number))})</h3>
<p class="section-note">Aggregate All-Play record across every regular-season week since ESPN.</p>
${renderAllPlayTable(allTimeRows, 'All-Time All-Play')}
`
}

export function renderLuckSection(perSeason, allTimeLuckRows, defaultSeasonYear) {
  const currentRows = perSeason[defaultSeasonYear]?.luck || []
  const currentCap = `${defaultSeasonYear} Luck Index`
  const selector = renderSeasonSelector(Object.keys(perSeason).sort(), defaultSeasonYear, 'luck')
  return `<h2>Luck Index</h2>
<p class="section-note">Close games (&lt;10 pts) flip on a few points. Luck Index shows close-game record against points-for rank. High PF rank with a bad close record is unlucky; low PF rank with a great close record is lucky. Regular season only.</p>
${selector}
<div id="luck-table-wrap">
${renderLuckTable(currentRows, currentCap)}
</div>
<h3>All-Time Luck Index (2018–${Math.max(...Object.keys(perSeason).map(Number))})</h3>
<p class="section-note">Cumulative close-game record versus total PF rank since 2018.</p>
${renderLuckTable(allTimeLuckRows, 'All-Time Luck Index')}
`
}

function renderSeasonSelector(seasons, selected, prefix) {
  if (seasons.length <= 1) return ''
  const options = seasons
    .slice()
    .sort((a, b) => b - a)
    .map(s => `<option value="${s}" ${String(s) === String(selected) ? 'selected' : ''}>${s}</option>`)
    .join('\n')
  const id = `${prefix}-season-select`
  return `<p class="section-note"><label for="${id}">Season: </label><select id="${id}">${options}</select></p>`
}

export function renderPageContent(data) {
  const perSeason = data.perSeason
  const defaultYear = data.defaultSeason
  const allPlayAllTime = data.allTime.allPlay
  const luckAllTime = data.allTime.luck
  const allPlaySection = renderAllPlaySection(perSeason, allPlayAllTime, defaultYear)
  const luckSection = renderLuckSection(perSeason, luckAllTime, defaultYear)
  const json = JSON.stringify(data).replace(/<\//g, '<\\/')
  return `${allPlaySection}\n${luckSection}\n<script type="application/json" id="luck-data">${json}</script>\n<script src="../static/js/luck.js?v=1"></script>`
}

const START = '<!-- LUCK_START -->'
const END = '<!-- LUCK_END -->'

export function upsertLuckPage(contentHtml, pagePath = PAGE_PATH) {
  const section = `${START}\n${contentHtml}\n${END}`
  if (!fs.existsSync(pagePath)) {
    fs.writeFileSync(pagePath, pageTemplate(contentHtml))
    console.log(`Created ${pagePath}`)
    return
  }
  const content = fs.readFileSync(pagePath, 'utf8')
  const startIdx = content.indexOf(START)
  const endIdx = content.indexOf(END)
  if (startIdx === -1 || endIdx === -1) {
    console.warn(`Markers missing in ${pagePath}; page left untouched`)
    return
  }
  fs.writeFileSync(pagePath, content.slice(0, startIdx) + section + content.slice(endIdx + END.length))
  console.log(`Updated ${pagePath}`)
}

function pageTemplate(content) {
  return `<!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DerBruden.com | Luck & All-Play</title>
  <meta property="og:title" content="DerBruden.com | Luck & All-Play">
  <meta property="og:description" content="All-Play standings and Luck Index for the Der Bruden fantasy football league: who was good, who was lucky, and who got screwed by the schedule.">
  <meta property="og:url" content="https://derbruden.com/luck.html">
  <meta property="og:image" content="https://derbruden.com/static/img/league-logo.webp">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="DerBruden.com | Luck & All-Play">
  <meta name="twitter:description" content="All-Play standings and Luck Index for the Der Bruden fantasy football league.">
  <meta name="twitter:image" content="https://derbruden.com/static/img/league-logo.webp">
  <!--#include file="partials/head-common.html" -->
  <style>
    .section-note {
      color: #666;
      font-size: 0.9em;
    }
    h2 { margin-top: 40px; }
    h3 { margin-top: 32px; }
    .stats-table .detail {
      color: #555;
      font-size: 0.95em;
    }
    .stats-table td.owner {
      font-weight: 500;
      white-space: nowrap;
    }
    .luck-controls {
      margin: 12px 0;
    }
    select {
      font-size: 0.95em;
      padding: 4px 8px;
    }
    .methodology {
      margin-top: 30px;
      font-size: 0.85em;
      color: #666;
    }
    .methodology code {
      background: #f4f4f4;
      padding: 1px 4px;
      border-radius: 3px;
    }
  </style>
</head>

<body>
  <!--#include file="partials/site-header.html" -->

  <!--#include file="partials/nav.html" -->

  <main id="main">
    <div class="owner-logo-header">
      <img src="../static/img/league-logo.webp" alt="DB Logo" width="100" height="100"
        style="border-radius: 50%; object-fit: cover;">
      <h1>Luck &amp; All-Play</h1>
    </div>
    <!-- LUCK_START -->
${content}
<!-- LUCK_END -->
    <details class="methodology">
      <summary>How these numbers work</summary>
      <p><strong>All-Play:</strong> Each week every team plays every other team. In a 10-team league that is 9 All-Play games per team per week. We tally All-Play W-L across the regular season. Comparing actual wins to All-Play wins exposes schedule luck: a team with 8 actual wins but 65 All-Play wins faced an easy slate; a team with 5 actual wins but 80 All-Play wins got screwed.</p>
      <p><strong>Luck Index:</strong> Close games are those decided by &lt;10 points. Close win % versus points-for rank defines luck. Example: a team ranked 9th in PF but 1st in close win % is lucky; a team ranked 1st in PF but 9th in close win % is unlucky. Luck diff = PF rank − close rank. Positive means lucky, negative means unlucky. Teams with fewer than three close games show Small sample.</p>
      <p>Both tables cover regular-season weeks only and start in 2018 when the league joined ESPN. Weekly scores before 2018 are not available.</p>
      <p>Regenerate with <code>make luck</code>.</p>
    </details>
  </main>

  <!--#include file="partials/footer.html" -->
</body>

</html>
`
}

async function main() {
  loadEnvFile()
  authHeaders()

  const args = process.argv.slice(2)
  const seasonArg = args.find(a => /^\d{4}$/.test(a))
  const current = Number(seasonArg) || defaultSeason()

  const leaguesBySeason = new Map()
  for (let season = current; season >= API_FIRST_SEASON; season--) {
    try {
      leaguesBySeason.set(season, await fetchLeague(season))
    } catch (err) {
      console.warn(`Skipping ${season}: ${err.message}`)
    }
  }
  if (!leaguesBySeason.size) throw new Error('No seasons fetched from the ESPN API')

  const metaBySeason = {}
  for (const [season, league] of leaguesBySeason) {
    metaBySeason[season] = seasonTeamMeta(league)
  }
  const ownerOf = makeOwnerLookup(metaBySeason)
  const nameOf = (season, teamId) => metaBySeason[season]?.[teamId]?.name ?? ''

  const perSeason = {}
  const allGames = []
  for (const [season, league] of [...leaguesBySeason].sort((a, b) => a[0] - b[0])) {
    const games = extractRegularSeasonGames(league, season)
    allGames.push(...games)
    const allPlay = computeAllPlayStandings(games, ownerOf, nameOf)
    const luck = computeLuckIndex(games, ownerOf, nameOf)
    perSeason[season] = { season, gameCount: games.length, allPlay, luck }
    console.log(`Season ${season}: ${games.length} regular-season games`)
  }

  // Determine default display season: prefer requested current if it has games, else latest with games
  let defaultYear = current
  if (!perSeason[defaultYear] || perSeason[defaultYear].gameCount === 0) {
    const withGames = Object.values(perSeason)
      .filter(s => s.gameCount > 0)
      .sort((a, b) => b.season - a.season)[0]
    if (withGames) defaultYear = withGames.season
    else defaultYear = Math.max(...Object.keys(perSeason).map(Number))
  }

  const allTimeAllPlay = computeAllTimeAllPlay(allGames, ownerOf, nameOf)
  const allTimeLuck = computeAllTimeLuck(allGames, ownerOf, nameOf)

  const data = {
    generated: new Date().toISOString().slice(0, 10),
    leagueId: LEAGUE_ID,
    seasons: Object.keys(perSeason).map(Number).sort((a, b) => a - b),
    defaultSeason: defaultYear,
    scopeNote: 'Regular-season weeks only, 2018 on. All-Play replays each week as if every team played every other team. Luck Index contrasts <10 pt close record with points-for rank.',
    perSeason,
    allTime: {
      allPlay: allTimeAllPlay,
      luck: allTimeLuck,
    },
  }

  fs.mkdirSync(pathDirname(DATA_PATH), { recursive: true })
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n')
  console.log(`Wrote ${DATA_PATH}`)
  upsertLuckPage(renderPageContent(data))
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch(err => {
    console.error(err.message)
    process.exit(1)
  })
}
