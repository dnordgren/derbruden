import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname as pathDirname, join } from 'path'
import { TEAM_OWNERS } from './team-owners.js'

const __dirname = pathDirname(fileURLToPath(import.meta.url))

const LEAGUE_ID = process.env.FANTASY_LEAGUE_ID || '794521'
const API_BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl'
// The league joined ESPN in 2018; earlier seasons live only in stats.csv.
const API_FIRST_SEASON = 2018
const USER_AGENT = 'derbruden.com all-time records generator'

const DATA_PATH = join(__dirname, '../static/data/alltime-records.json')
const PAGE_PATH = join(__dirname, '../src/records.html')

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
  const url =
    `${API_BASE}/seasons/${season}/segments/0/leagues/${LEAGUE_ID}` +
    '?view=mTeam&view=mMatchupScore'
  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) throw new Error(`ESPN API returned ${res.status} for season ${season}`)
  return res.json()
}

// Decided games only. Unplayed matchups carry winner "UNDECIDED" and zero
// points; ties come back lowercase "tie". Playoff games keep their tier.
export function extractGames(league, season) {
  const games = []
  for (const m of league.schedule || []) {
    const { home, away } = m
    if (
      !home ||
      !away ||
      typeof home.totalPoints !== 'number' ||
      typeof away.totalPoints !== 'number'
    ) {
      continue
    }
    const winner = String(m.winner || '').toLowerCase()
    if (!['home', 'away', 'tie'].includes(winner)) continue
    if (winner !== 'tie' && home.totalPoints === 0 && away.totalPoints === 0) continue
    // Consolation ladder/losers brackets are NOT the playoffs; only the
    // winners bracket marks teams that actually qualified.
    const tier = m.playoffTierType
    games.push({
      season,
      week: m.matchupPeriodId,
      homeId: home.teamId,
      awayId: away.teamId,
      homeScore: home.totalPoints,
      awayScore: away.totalPoints,
      playoff: tier !== 'NONE',
      winnersBracket: tier === 'WINNERS_BRACKET',
      winner,
    })
  }
  return games.sort((a, b) => a.season - b.season || a.week - b.week)
}

export function seasonTeamMeta(league) {
  const meta = {}
  for (const t of league.teams || []) {
    meta[t.id] = { id: t.id, abbrev: t.abbrev, name: t.name || t.nickname || t.abbrev }
  }
  return meta
}

// The championship game is the winners-bracket matchup in the latest week.
// Its winner existing also tells us the season is complete.
export function detectChampion(league) {
  let final = null
  for (const m of league.schedule || []) {
    if (m.playoffTierType !== 'WINNERS_BRACKET') continue
    const winner = String(m.winner || '').toLowerCase()
    if (!['home', 'away'].includes(winner)) continue
    if (!final || m.matchupPeriodId > final.matchupPeriodId) final = m
  }
  if (!final) return null
  return final.winner.toLowerCase() === 'home' ? final.home.teamId : final.away.teamId
}

export function makeOwnerLookup(metaBySeason) {
  // Franchises outside TEAM_OWNERS get their first-seen ESPN abbreviation so
  // labels stay stable across seasons.
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

export function computeSeasonTotals(games, ownerOf) {
  const totals = new Map()
  for (const g of games) {
    for (const [id, pts] of [
      [g.homeId, g.homeScore],
      [g.awayId, g.awayScore],
    ]) {
      const key = `${ownerOf(id)}|${g.season}`
      if (!totals.has(key)) {
        totals.set(key, {
          owner: ownerOf(id),
          teamId: id,
          season: g.season,
          points: 0,
          wins: 0,
          losses: 0,
          ties: 0,
        })
      }
      const row = totals.get(key)
      row.points += pts
      if (g.winner === 'tie') row.ties += 1
      else if ((g.winner === 'home') === (id === g.homeId)) row.wins += 1
      else row.losses += 1
    }
  }
  return [...totals.values()].map(r => ({ ...r, points: round1(r.points) }))
}

export function computeRecords(games, ownerOf, nameOf) {
  let highest = null
  let lowest = null
  let mostPointsInALoss = null
  let blowout = null

  for (const g of games) {
    const sides = [
      { id: g.homeId, points: g.homeScore, oppId: g.awayId, oppPoints: g.awayScore },
      { id: g.awayId, points: g.awayScore, oppId: g.homeId, oppPoints: g.homeScore },
    ]
    for (const s of sides) {
      if (!highest || s.points > highest.raw) {
        highest = { ...entry(g, s, ownerOf, nameOf), raw: s.points }
      }
      if (!lowest || s.points < lowest.raw) {
        lowest = { ...entry(g, s, ownerOf, nameOf), raw: s.points }
      }
      const margin = Math.abs(s.points - s.oppPoints)
      if (s.points > s.oppPoints && (!blowout || margin > blowout.raw)) {
        blowout = { ...entry(g, s, ownerOf, nameOf), margin: round1(margin), raw: margin }
      }
      const lost =
        g.winner === 'tie' ? false : (g.winner === 'home') !== (s.id === g.homeId)
      if (lost && (!mostPointsInALoss || s.points > mostPointsInALoss.raw)) {
        mostPointsInALoss = { ...entry(g, s, ownerOf, nameOf), raw: s.points }
      }
    }
  }

  const strip = e => {
    if (!e) return null
    const { raw, ...rest } = e
    void raw
    return rest
  }
  const totals = computeSeasonTotals(games, ownerOf)
  let bestSeason = null
  for (const row of totals) {
    if (!bestSeason || row.points > bestSeason.points) bestSeason = row
  }

  return {
    highestScore: strip(highest),
    lowestScore: strip(lowest),
    mostPointsInALoss: strip(mostPointsInALoss),
    biggestBlowout: strip(blowout),
    longestWinStreak: longestWinStreak(games, ownerOf),
    mostPointsInASeason:
      bestSeason && {
        owner: bestSeason.owner,
        team: nameOf(bestSeason.season, bestSeason.teamId),
        points: bestSeason.points,
        season: bestSeason.season,
        wins: bestSeason.wins,
        losses: bestSeason.losses,
        ties: bestSeason.ties,
      },
  }
}

function entry(g, s, ownerOf, nameOf) {
  return {
    owner: ownerOf(s.id),
    team: nameOf(g.season, s.id),
    points: round1(s.points),
    opponent: ownerOf(s.oppId),
    opponentPoints: round1(s.oppPoints),
    season: g.season,
    week: g.week,
  }
}

// Streaks span seasons and include playoff wins. A tie or loss resets.
export function longestWinStreak(games, ownerOf) {
  let best = null
  let current = new Map()
  for (const g of games) {
    const winnerOwner = g.winner === 'tie' ? null : ownerOf(g.winner === 'home' ? g.homeId : g.awayId)
    const touched = new Set([ownerOf(g.homeId), ownerOf(g.awayId)])
    for (const owner of touched) {
      if (owner !== winnerOwner) {
        current.delete(owner)
        continue
      }
      const prev = current.get(owner)
      const streak = {
        owner,
        length: (prev ? prev.length : 0) + 1,
        fromSeason: prev ? prev.fromSeason : g.season,
        fromWeek: prev ? prev.fromWeek : g.week,
        toSeason: g.season,
        toWeek: g.week,
      }
      current.set(owner, streak)
      if (!best || streak.length > best.length) best = streak
    }
  }
  return best
}

export function computeH2H(games, ownerOf) {
  const cells = new Map()
  const pf = new Map()
  for (const g of games) {
    for (const [id, pts] of [
      [g.homeId, g.homeScore],
      [g.awayId, g.awayScore],
    ]) {
      const o = ownerOf(id)
      pf.set(o, (pf.get(o) || 0) + pts)
    }
    const a = ownerOf(g.homeId)
    const b = ownerOf(g.awayId)
    if (a === b) continue
    const key = [a, b].sort().join('|')
    if (!cells.has(key)) {
      const [first, second] = key.split('|')
      cells.set(key, { a: first, b: second, wA: 0, wB: 0, ties: 0 })
    }
    const cell = cells.get(key)
    const winnerOwner =
      g.winner === 'tie' ? null : ownerOf(g.winner === 'home' ? g.homeId : g.awayId)
    if (winnerOwner === null) cell.ties += 1
    else if (winnerOwner === cell.a) cell.wA += 1
    else cell.wB += 1
  }
  const rows = [...pf.keys()].map(owner => ({ owner, pf: round1(pf.get(owner)), rivals: {} }))
  rows.sort((x, y) => y.pf - x.pf)
  const byOwner = new Map(rows.map(r => [r.owner, r]))
  for (const cell of cells.values()) {
    byOwner.get(cell.a).rivals[cell.b] = { wins: cell.wA, losses: cell.wB, ties: cell.ties }
    byOwner.get(cell.b).rivals[cell.a] = { wins: cell.wB, losses: cell.wA, ties: cell.ties }
  }
  return { order: rows.map(r => r.owner), rows }
}

// stats.csv backs everything before the ESPN era: playoff flags and
// champions. Weekly data does not exist there, so game records stay API-only.
export function parseStatsCsv(text) {
  const lines = text.split('\n').filter(l => l.trim())
  const header = lines[0].split(',').map(h => h.trim())
  const col = name => header.indexOf(name)
  return lines.slice(1).map(line => {
    const c = line.split(',')
    return {
      season: Number(c[col('Season')]),
      owner: (c[col('Owner')] || '').trim(),
      wins: Number(c[col('W')]),
      losses: Number(c[col('L')]),
      playoffs: (c[col('PO?')] || '').trim().toUpperCase() === 'Y',
      champion: (c[col('Champ')] || '').trim().toUpperCase() === 'Y',
    }
  })
}

export function csvHistory(rows) {
  const history = new Map()
  for (const row of rows) {
    if (!row.owner) continue
    if (!history.has(row.owner)) history.set(row.owner, new Map())
    history.get(row.owner).set(2000 + row.season, row.playoffs)
  }
  return history
}

export function seasonSummaries(league, season, ownerOf) {
  const games = extractGames(league, season)
  const rows = new Map()
  const ensureRow = id => {
    const o = ownerOf(id)
    if (!rows.has(o)) {
      rows.set(o, {
        owner: o,
        year: season,
        madePlayoffs: false,
        champion: false,
        wins: 0,
        losses: 0,
        ties: 0,
      })
    }
    return rows.get(o)
  }
  for (const t of league.teams || []) ensureRow(t.id)
  for (const g of games) {
    if (g.winnersBracket) {
      ensureRow(g.homeId).madePlayoffs = true
      ensureRow(g.awayId).madePlayoffs = true
      continue
    }
    if (g.playoff) continue
    for (const id of [g.homeId, g.awayId]) {
      const row = ensureRow(id)
      if (g.winner === 'tie') row.ties += 1
      else if ((g.winner === 'home') === (id === g.homeId)) row.wins += 1
      else row.losses += 1
    }
  }
  const champId = detectChampion(league)
  if (champId !== null) ensureRow(champId).champion = true
  return { summaries: [...rows.values()], championTeamId: champId }
}

// A drought counts consecutive completed league seasons an owner missed the
// playoffs. Seasons an owner sat out break the run instead of extending it.
export function computeDroughts(ownerHistory, lastCompletedSeason) {
  const droughts = []
  for (const [owner, yearsOut] of ownerHistory) {
    const years = [...yearsOut.keys()].filter(y => y <= lastCompletedSeason).sort((a, b) => a - b)
    let best = null
    let run = null
    let prevYear = null
    for (const year of years) {
      if (yearsOut.get(year)) {
        if (run) {
          // >= so equal-length runs resolve to the most recent one.
          if (!best || run.length >= best.length) best = run
          run = null
        }
      } else {
        if (run && year - prevYear > 1) {
          if (!best || run.length >= best.length) best = run
          run = null
        }
        if (!run) run = { owner, startYear: year, endYear: year, length: 0 }
        run.endYear = year
        run.length += 1
      }
      prevYear = year
    }
    if (run && (!best || run.length >= best.length)) best = run
    if (best) droughts.push({ ...best, active: best.endYear === lastCompletedSeason })
  }
  droughts.sort((a, b) => b.length - a.length || a.startYear - b.startYear)
  return droughts
}

// stats.csv marks six 2018 playoff berths, but ESPN ran a four-team bracket
// that year (settings say playoffTeamCount=4; both owners also lack a PORnk).
// The API wins, so these csv cells are expected mismatches.
const KNOWN_CSV_PLAYOFF_MISMATCH = new Set(['2018|JO', '2018|DN'])

// Regression harness: per-owner regular-season records, playoff flags, and
// champions from the API must match stats.csv wherever they overlap.
export function crossCheck(apiRows, csvRows) {
  const problems = []
  const byKey = new Map(apiRows.map(r => [`${r.owner}|${r.year}`, r]))
  for (const csv of csvRows) {
    const year = 2000 + csv.season
    if (year < API_FIRST_SEASON) continue
    const api = byKey.get(`${csv.owner}|${year}`)
    if (!api) {
      problems.push(`stats.csv has ${csv.owner} ${year} but the API produced nothing`)
      continue
    }
    for (const [label, got, want] of [
      ['W', api.wins, csv.wins],
      ['L', api.losses, csv.losses],
    ]) {
      if (got !== want) problems.push(`${csv.owner} ${year}: api ${label}=${got}, stats.csv ${label}=${want}`)
    }
    if (
      api.madePlayoffs !== csv.playoffs &&
      !KNOWN_CSV_PLAYOFF_MISMATCH.has(`${year}|${csv.owner}`)
    ) {
      problems.push(`${csv.owner} ${year}: api playoffs=${api.madePlayoffs}, stats.csv=${csv.playoffs}`)
    }
    if (api.champion !== csv.champion) {
      problems.push(`${csv.owner} ${year}: api champion=${api.champion}, stats.csv=${csv.champion}`)
    }
  }
  return problems
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

function ownerLink(owner) {
  const mapped = Object.values(TEAM_OWNERS).find(m => m.owner === owner)
  return mapped ? `<a href="./${mapped.page}">${escapeHtml(owner)}</a>` : escapeHtml(owner)
}

function detail(entry, result) {
  return `${result} ${ownerLink(entry.opponent)} ${fmt(entry.points)}-${fmt(
    entry.opponentPoints
  )}, ${entry.season} wk ${entry.week}`
}

export function renderRecordsSection(records) {
  const r = records
  const hs = r.highestScore
  const bb = r.biggestBlowout
  const st = r.longestWinStreak
  const ms = r.mostPointsInASeason
  return `<h2>All-time records</h2>
<p class="section-note">Every decided game, regular season and playoffs.</p>
<div class="table-container"><table class="stats-table">
  <thead>
    <tr><th>Record</th><th class="number">Value</th><th class="detail">Details</th></tr>
  </thead>
  <tbody>
    <tr><td>Highest weekly score</td><td class="number">${hs ? fmt(hs.points) : '&ndash;'}</td><td class="detail">${hs ? detail(hs, 'beat') : ''}</td></tr>
    <tr><td>Biggest blowout</td><td class="number">${bb ? '+' + fmt(bb.margin) : '&ndash;'}</td><td class="detail">${bb ? detail(bb, 'beat') : ''}</td></tr>
    <tr><td>Longest win streak</td><td class="number">${st ? st.length : '&ndash;'}</td><td class="detail">${st ? `${ownerLink(st.owner)}, ${st.fromSeason} wk ${st.fromWeek} &ndash; ${st.toSeason} wk ${st.toWeek}` : ''}</td></tr>
    <tr><td>Most points in a season</td><td class="number">${ms ? fmt(ms.points) : '&ndash;'}</td><td class="detail">${ms ? `${ownerLink(ms.owner)}, ${ms.season} (${ms.wins}-${ms.losses}${ms.ties ? `-${ms.ties}` : ''})` : ''}</td></tr>
  </tbody>
</table></div>`
}

export function renderH2HSection(h2h) {
  if (!h2h.rows.length) return ''
  const head = h2h.order.map(o => `<th class="number">${escapeHtml(o)}</th>`).join('')
  const body = h2h.rows
    .map(row => {
      const cells = h2h.order
        .map(o => {
          if (o === row.owner) return `<td class="number diag">${fmt(row.pf)}</td>`
          const c = row.rivals[o]
          if (!c) return '<td class="number muted">&ndash;</td>'
          return `<td class="number">${c.ties ? `${c.wins}-${c.losses}-${c.ties}` : `${c.wins}-${c.losses}`}</td>`
        })
        .join('')
      return `<tr><td class="owner">${ownerLink(row.owner)}</td>${cells}</tr>`
    })
    .join('\n')
  return `<h2>Head-to-head, all time</h2>
<p class="section-note">Regular season plus playoffs. Row beats column;
the diagonal is lifetime points scored.</p>
<div class="table-container"><table class="stats-table">
  <thead>
    <tr><th></th>${head}</tr>
  </thead>
  <tbody>
${body}
  </tbody>
</table></div>`
}

export function renderTrophiesSection({ champions, lowestScore, mostPointsInALoss, droughts }) {
  const ls = lowestScore
  const ml = mostPointsInALoss
  const droughtRows = droughts
    .slice(0, 5)
    .map(
      d =>
        `<tr><td>${ownerLink(d.owner)}</td><td class="number">${d.length}</td><td class="detail">${d.startYear}&ndash;${d.endYear}${d.active ? ' (active)' : ''}</td></tr>`
    )
    .join('\n')
  return `<h2>Trophy case</h2>
<div class="table-container"><table class="stats-table">
  <thead><tr><th class="number">Season</th><th>Champion</th></tr></thead>
  <tbody>
${champions.map(c => `<tr><td class="number">${c.season}</td><td><strong>${ownerLink(c.owner)}</strong>${c.team ? ` <span class="muted">${escapeHtml(c.team)}</span>` : ''}</td></tr>`).join('\n')}
  </tbody>
</table></div>
<h2>Hall of shame</h2>
<div class="table-container"><table class="stats-table">
  <thead><tr><th>Dishonor</th><th class="number">Value</th><th class="detail">Details</th></tr></thead>
  <tbody>
    <tr><td>Lowest weekly score ever</td><td class="number">${ls ? fmt(ls.points) : '&ndash;'}</td><td class="detail">${ls ? detail(ls, 'lost to') : ''}</td></tr>
    <tr><td>Most points in a loss</td><td class="number">${ml ? fmt(ml.points) : '&ndash;'}</td><td class="detail">${ml ? detail(ml, 'lost to') : ''}</td></tr>
  </tbody>
</table></div>
<h3>Longest playoff droughts</h3>
<div class="table-container"><table class="stats-table">
  <thead><tr><th>Owner</th><th class="number">Seasons out</th><th class="detail">Span</th></tr></thead>
  <tbody>
${droughtRows}
  </tbody>
</table></div>`
}

export function renderPageContent(data) {
  return [
    renderRecordsSection(data.records),
    renderH2HSection(data.h2h),
    renderTrophiesSection({
      champions: data.champions,
      lowestScore: data.records.lowestScore,
      mostPointsInALoss: data.records.mostPointsInALoss,
      droughts: data.hallOfShame.playoffDroughts,
    }),
  ].join('\n')
}

const START = '<!-- RECORDS_START -->'
const END = '<!-- RECORDS_END -->'

export function upsertRecordsPage(contentHtml, pagePath = PAGE_PATH) {
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
  <title>DerBruden.com | All-Time Records</title>
  <meta property="og:title" content="DerBruden.com | All-Time Records">
  <meta property="og:description" content="Every record that matters in the Der Bruden fantasy football league: weekly highs, blowouts, streaks, lifetime head-to-head, and the hall of shame.">
  <meta property="og:url" content="https://derbruden.com/records.html">
  <meta property="og:image" content="https://derbruden.com/static/img/league-logo.webp">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="DerBruden.com | All-Time Records">
  <meta name="twitter:description" content="Records, rivalries, and the hall of shame for the Der Bruden fantasy football league.">
  <meta name="twitter:image" content="https://derbruden.com/static/img/league-logo.webp">
  <!--#include file="partials/head-common.html" -->
  <style>
    .section-note {
      color: #666;
      font-size: 0.9em;
    }

    h2 {
      margin-top: 40px;
    }

    .stats-table .detail {
      color: #555;
      font-size: 0.95em;
    }

    .stats-table td.owner {
      font-weight: 500;
      white-space: nowrap;
    }

    .stats-table .diag {
      color: #999;
    }

    .stats-table .muted {
      color: #999;
    }
  </style>
</head>

<body>
  <!--#include file="partials/site-header.html" -->

  <!--#include file="partials/nav.html" -->

  <main>
    <div class="owner-logo-header">
      <img src="../static/img/league-logo.webp" alt="DB Logo" width="100" height="100"
        style="border-radius: 50%; object-fit: cover;">
      <h1>All-Time Records</h1>
    </div>
    <!-- RECORDS_START -->
${content}
<!-- RECORDS_END -->
    <p class="section-note">Weekly records and head-to-head cover every decided game
    since the league joined ESPN in 2018. Champions and playoff droughts reach back
    to 2014 through recorded league history. Regenerate with <code>make records</code>.</p>
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
  const checkOnly = args.includes('--check')
  const current = Number(args.find(a => /^\d{4}$/.test(a))) || defaultSeason()

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

  const allGames = []
  const apiRows = []
  const champions = []
  for (const [season, league] of [...leaguesBySeason].sort((a, b) => a[0] - b[0])) {
    allGames.push(...extractGames(league, season))
    const { summaries, championTeamId } = seasonSummaries(league, season, ownerOf)
    apiRows.push(...summaries)
    if (championTeamId === null) continue
    champions.push({
      season,
      owner: ownerOf(championTeamId),
      team: nameOf(season, championTeamId),
    })
  }

  const csvRows = loadStatsCsv()
  const csvYears = csvRows.map(r => 2000 + r.season)
  const preEraCsv = csvRows.filter(r => 2000 + r.season < API_FIRST_SEASON)

  // Only completed seasons (champion decided) feed droughts and history.
  const completedYears = new Set(champions.map(c => c.season))
  const history = csvHistory(preEraCsv)
  let lastCompleted
  let droughts = []
  if (completedYears.size) {
    for (const row of apiRows) {
      if (!completedYears.has(row.year)) continue
      if (!history.has(row.owner)) history.set(row.owner, new Map())
      history.get(row.owner).set(row.year, row.madePlayoffs)
    }
    const newestDone = Math.max(...completedYears)
    lastCompleted = Math.max(
      ...completedYears,
      ...csvYears.filter(y => y <= newestDone),
      ...(preEraCsv.length ? [] : [API_FIRST_SEASON])
    )
    droughts = computeDroughts(history, lastCompleted)
  } else {
    lastCompleted = csvYears.length ? Math.max(...csvYears) : API_FIRST_SEASON - 1
  }

  champions.push(
    ...preEraCsv.filter(r => r.champion).map(r => ({ season: 2000 + r.season, owner: r.owner, team: '' }))
  )
  champions.sort((a, b) => a.season - b.season)

  const allRecords = computeRecords(allGames, ownerOf, nameOf)
  const data = {
    generated: new Date().toISOString().slice(0, 10),
    leagueId: LEAGUE_ID,
    scopeNote:
      'Weekly records and head-to-head include every decided regular-season and postseason game since 2018. Droughts and champions also include recorded pre-ESPN history.',
    records: {
      highestScore: allRecords.highestScore,
      biggestBlowout: allRecords.biggestBlowout,
      longestWinStreak: allRecords.longestWinStreak,
      mostPointsInASeason: allRecords.mostPointsInASeason,
    },
    hallOfShame: {
      lowestScore: allRecords.lowestScore,
      mostPointsInALoss: allRecords.mostPointsInALoss,
      playoffDroughts: droughts,
    },
    h2h: computeH2H(allGames, ownerOf),
    champions,
    generatedFrom: {
      weeklyScope: [...new Set(allGames.map(g => g.season))].sort((a, b) => a - b),
      fullScope: [
        preEraCsv.length ? 2000 + Math.min(...preEraCsv.map(r => r.season)) : API_FIRST_SEASON,
        lastCompleted,
      ],
    },
  }

  if (checkOnly) {
    const problems = crossCheck(apiRows.filter(r => completedYears.has(r.year)), csvRows)
    if (problems.length) {
      for (const p of problems) console.error(p)
      process.exitCode = 1
    } else {
      console.log(`Cross-check passed against stats.csv for seasons >= ${API_FIRST_SEASON}`)
    }
    return
  }

  fs.mkdirSync(pathDirname(DATA_PATH), { recursive: true })
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n')
  console.log(`Wrote ${DATA_PATH}`)
  upsertRecordsPage(renderPageContent(data))
}

function loadStatsCsv() {
  const csvPath = join(__dirname, 'stats.csv')
  if (!fs.existsSync(csvPath)) return []
  return parseStatsCsv(fs.readFileSync(csvPath, 'utf8'))
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch(err => {
    console.error(err.message)
    process.exit(1)
  })
}
