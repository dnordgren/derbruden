#!/usr/bin/env node
// Playoff race tracker. Fetches the league schedule, computes current
// standings, and enumerates remaining-game outcomes to find clinched and
// eliminated teams. Late-season only (default start week 10 for a 13-week
// regular season). Writes static/data/playoff-race.json and updates
// src/playoff-race.html.
//
// Usage:
//   node scripts/generate-playoff-race.mjs [--dry-run] [--start-week=N] [season]
// Season defaults like the other generators: Aug-Dec -> current year,
// Jan-Jul -> prior year. Start week controls Discord posting and the "late
// season" gate; enumeration still runs any week but posting is skipped
// before startWeek.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEAM_OWNERS } from './team-owners.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DATA_FILE = path.join(ROOT, 'static', 'data', 'playoff-race.json')
const PAGE_PATH = path.join(ROOT, 'src', 'playoff-race.html')
const ENV_FILE = path.join(ROOT, '.env')
const DEFAULT_LEAGUE_HOST = 'https://lm-api-reads.fantasy.espn.com'
const LEAGUE_PATH = '/apis/v3/games/ffl/seasons/{year}/segments/0/leagues/{league}'
const USER_AGENT = 'derbruden.com playoff race generator'

// Late-season gate: with 13 regular weeks and 6 playoff spots, clinches
// first appear around week 10 (3 weeks left, 15 games) and eliminations
// around week 12. Starting at 11 gives 3 weeks of signal without early
// noise; 10 catches the earliest JH-type clinch. Configurable via
// --start-week or PLAYOFF_START_WEEK env.
export const DEFAULT_START_WEEK = 11
export const DEFAULT_PLAYOFF_TEAM_COUNT = 6
export const ENUM_LIMIT = 20

export function loadEnvFile(file = ENV_FILE) {
  if (!fs.existsSync(file)) return {}
  const out = {}
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

function resolveConfig() {
  const fromFile = loadEnvFile(ENV_FILE)
  const env = {}
  const keys = ['LEAGUE_ID', 'LEAGUE_YEAR', 'ESPN_S2', 'SWID', 'LEAGUE_HOST', 'PLAYOFF_START_WEEK']
  for (const key of keys) {
    const value = process.env[key] || fromFile[key]
    env[key] = value === '' ? undefined : value
  }
  return env
}

function authCookie(env) {
  const parts = []
  if (env.ESPN_S2) parts.push(`espn_s2=${env.ESPN_S2}`)
  if (env.SWID) parts.push(`SWID=${env.SWID}`)
  return parts.join('; ')
}

function leagueUrl(env) {
  return (env.LEAGUE_HOST ?? DEFAULT_LEAGUE_HOST) + LEAGUE_PATH.replace('{year}', env.LEAGUE_YEAR).replace('{league}', env.LEAGUE_ID)
}

async function fetchJson(fetchImpl, url, options = {}) {
  const res = await fetchImpl(url, options)
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`ESPN returned non-JSON (HTTP ${res.status}). Cookies are likely expired or missing SWID.`)
  }
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status}: ${JSON.stringify(body).slice(0, 500)}`)
  return body
}

export function defaultSeason(now = new Date()) {
  return now.getMonth() + 1 >= 8 ? now.getFullYear() : now.getFullYear() - 1
}

export function parseArgs(argv) {
  const args = { dryRun: false, startWeek: null, season: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') args.dryRun = true
    else if (arg.startsWith('--start-week=')) args.startWeek = Number(arg.split('=')[1])
    else if (arg === '--start-week') args.startWeek = Number(argv[++i])
    else if (/^\d{4}$/.test(arg)) args.season = Number(arg)
    else if (/^\d+$/.test(arg) && !args.startWeek) args.startWeek = Number(arg)
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (args.startWeek != null && (!Number.isInteger(args.startWeek) || args.startWeek < 1)) throw new Error('--start-week needs a positive integer')
  return args
}

export function extractTeams(league) {
  const map = {}
  for (const t of league.teams || []) {
    map[t.id] = { id: t.id, abbrev: t.abbrev, name: t.name || [t.location, t.nickname].filter(Boolean).join(' ') || `Team ${t.id}`, record: t.record?.overall || null }
  }
  return map
}

export function extractGames(league) {
  const games = []
  for (const m of league.schedule || []) {
    const home = m.home
    const away = m.away
    if (!home || !away || typeof home.totalPoints !== 'number' || typeof away.totalPoints !== 'number') continue
    const winner = String(m.winner || '').toLowerCase()
    const isDecided = ['home', 'away', 'tie'].includes(winner)
    const isZeroZero = winner !== 'tie' && home.totalPoints === 0 && away.totalPoints === 0
    // playoff flag
    const playoff = m.playoffTierType !== 'NONE'
    games.push({
      week: m.matchupPeriodId,
      homeId: home.teamId,
      awayId: away.teamId,
      homeScore: home.totalPoints,
      awayScore: away.totalPoints,
      winner, // lowercased
      playoff,
      winnersBracket: m.playoffTierType === 'WINNERS_BRACKET',
      decided: isDecided && !isZeroZero,
      rawWinner: m.winner,
    })
  }
  return games.sort((a, b) => a.week - b.week)
}

export function computeStandings(decidedGames, teamsById) {
  const stats = {}
  for (const id of Object.keys(teamsById).map(Number)) {
    stats[id] = { teamId: id, wins: 0, losses: 0, ties: 0, pf: 0, pa: 0 }
  }
  for (const g of decidedGames) {
    if (!g.decided) continue
    const hid = g.homeId, aid = g.awayId
    if (!(hid in stats) || !(aid in stats)) continue
    stats[hid].pf += g.homeScore
    stats[hid].pa += g.awayScore
    stats[aid].pf += g.awayScore
    stats[aid].pa += g.homeScore
    if (g.winner === 'home') { stats[hid].wins += 1; stats[aid].losses += 1 }
    else if (g.winner === 'away') { stats[aid].wins += 1; stats[hid].losses += 1 }
    else if (g.winner === 'tie') { stats[hid].ties += 1; stats[aid].ties += 1 }
  }
  return stats
}

export function standingsList(stats, teamsById) {
  const rows = Object.values(stats).map(s => {
    const team = teamsById[s.teamId]
    const owner = TEAM_OWNERS[s.teamId]?.owner ?? team?.abbrev ?? `Team ${s.teamId}`
    const winValue = s.wins + s.ties * 0.5
    return {
      teamId: s.teamId,
      owner,
      abbrev: team?.abbrev ?? '',
      name: team?.name ?? '',
      wins: s.wins,
      losses: s.losses,
      ties: s.ties,
      winValue,
      pf: s.pf,
      pa: s.pa,
    }
  })
  rows.sort((a, b) => b.winValue - a.winValue || b.pf - a.pf)
  // assign rank with ties broken by order (1..n)
  rows.forEach((r, i) => r.rank = i + 1)
  // games back: leader winValue - team winValue
  const leader = rows[0]?.winValue ?? 0
  rows.forEach(r => r.gamesBack = leader - r.winValue)
  // remaining games count is filled later
  return rows
}

export function currentLeaderForGame(g) {
  if (g.decided) {
    if (g.winner === 'home') return g.homeId
    if (g.winner === 'away') return g.awayId
    return null // tie
  }
  // undecided/in-progress: use current score leader
  if (g.homeScore > g.awayScore) return g.homeId
  if (g.awayScore > g.homeScore) return g.awayId
  return null
}

// Enumerate remaining regular-season games to find clinch/elimination.
// Returns {clinched, eliminated, bestRank, worstRank, note}
export function computeClinchEliminated(currentStats, remainingGames, playoffTeamCount, teamsById) {
  const teamIds = Object.keys(currentStats).map(Number)
  const n = remainingGames.length
  if (n === 0) {
    const standings = standingsList(currentStats, teamsById)
    const clinched = standings.slice(0, playoffTeamCount).map(r => r.teamId)
    const eliminated = standings.slice(playoffTeamCount).map(r => r.teamId)
    const bestRank = {}
    const worstRank = {}
    for (const r of standings) { bestRank[r.teamId] = r.rank; worstRank[r.teamId] = r.rank }
    return { clinched, eliminated, bestRank, worstRank, remaining: 0 }
  }
  if (n > ENUM_LIMIT) {
    return { clinched: [], eliminated: [], bestRank: {}, worstRank: {}, note: `too many remaining games (${n}) to enumerate`, remaining: n }
  }
  // current win values
  const baseWins = {}
  for (const id of teamIds) baseWins[id] = currentStats[id].wins + currentStats[id].ties * 0.5

  const bestRank = {}
  const worstRank = {}
  for (const id of teamIds) { bestRank[id] = Infinity; worstRank[id] = -Infinity }

  const total = 1 << n
  // For each mask, compute final wins
  for (let mask = 0; mask < total; mask++) {
    const finalWins = { ...baseWins }
    for (let i = 0; i < n; i++) {
      const g = remainingGames[i]
      const homeWin = (mask >> i) & 1
      const winner = homeWin ? g.homeId : g.awayId
      // only count if team is in our tracked set (should be)
      if (winner in finalWins) finalWins[winner] += 1
    }
    // For each team, compute best/worst rank under wins-only tie grouping
    for (const tid of teamIds) {
      const w = finalWins[tid]
      let greater = 0, greaterOrEqual = 0
      for (const oid of teamIds) {
        const ow = finalWins[oid]
        if (ow > w) greater++
        if (ow >= w) greaterOrEqual++
      }
      const best = greater + 1
      const worst = greaterOrEqual // count >= includes self
      if (best < bestRank[tid]) bestRank[tid] = best
      if (worst > worstRank[tid]) worstRank[tid] = worst
    }
  }

  const clinched = []
  const eliminated = []
  for (const id of teamIds) {
    if (worstRank[id] <= playoffTeamCount) clinched.push(id)
    if (bestRank[id] > playoffTeamCount) eliminated.push(id)
  }
  return { clinched, eliminated, bestRank, worstRank, remaining: n }
}

// For Monday hypotheticals: current week undecided games
export function buildScenarios(currentStats, remainingGames, playoffTeamCount, teamsById) {
  if (!remainingGames.length) return null
  const weeks = [...new Set(remainingGames.map(g => g.week))].sort((a, b) => a - b)
  const currentWeek = weeks[0]
  const currentWeekGames = remainingGames.filter(g => g.week === currentWeek)
  // If no games in current week have a current leader (all 0-0 scheduled), still we can show hold/flip as home/away split
  const futureRemaining = remainingGames.filter(g => g.week !== currentWeek)

  // hold: leaders hold
  const holdStats = cloneStats(currentStats)
  const flipStats = cloneStats(currentStats)
  for (const g of currentWeekGames) {
    const leader = currentLeaderForGame(g)
    // For hold: leader wins, if tie/no leader, default to home
    const holdWinner = leader ?? g.homeId
    const flipWinner = holdWinner === g.homeId ? g.awayId : g.homeId
    // Apply to stats clones as wins
    // holdStats winner gets +1 win
    if (holdWinner in holdStats) holdStats[holdWinner].wins += 1
    else holdStats[holdWinner] = { wins: 1, losses: 0, ties: 0, pf: 0, pa: 0 }
    // flip
    if (flipWinner in flipStats) flipStats[flipWinner].wins += 1
    else flipStats[flipWinner] = { wins: 1, losses: 0, ties: 0, pf: 0, pa: 0 }
    // losers get loss (not needed for winValue but for completeness)
    const holdLoser = holdWinner === g.homeId ? g.awayId : g.homeId
    const flipLoser = flipWinner === g.homeId ? g.awayId : g.homeId
    if (holdLoser in holdStats) holdStats[holdLoser].losses += 1
    if (flipLoser in flipStats) flipStats[flipLoser].losses += 1
  }

  const holdClinched = computeClinchEliminated(holdStats, futureRemaining, playoffTeamCount, teamsById)
  const flipClinched = computeClinchEliminated(flipStats, futureRemaining, playoffTeamCount, teamsById)

  const holdStandings = standingsList(holdStats, teamsById)
  const flipStandings = standingsList(flipStats, teamsById)

  // Mark remaining counts for display: after current week, future remaining per team
  const remByTeamHold = countRemainingByTeam(futureRemaining)
  const remByTeamFlip = remByTeamHold

  holdStandings.forEach(r => r.remaining = remByTeamHold[r.teamId] ?? 0)
  flipStandings.forEach(r => r.remaining = remByTeamFlip[r.teamId] ?? 0)

  return {
    currentWeek,
    currentWeekGames: currentWeekGames.map(g => ({
      week: g.week,
      homeId: g.homeId,
      awayId: g.awayId,
      homeOwner: TEAM_OWNERS[g.homeId]?.owner ?? `Team ${g.homeId}`,
      awayOwner: TEAM_OWNERS[g.awayId]?.owner ?? `Team ${g.awayId}`,
      homeScore: g.homeScore,
      awayScore: g.awayScore,
      leader: currentLeaderForGame(g) ? (TEAM_OWNERS[currentLeaderForGame(g)]?.owner ?? `Team ${currentLeaderForGame(g)}`) : null,
      leaderId: currentLeaderForGame(g),
      holdWinner: (currentLeaderForGame(g) ?? g.homeId),
      flipWinner: (currentLeaderForGame(g) ?? g.homeId) === g.homeId ? g.awayId : g.homeId,
    })),
    hold: { stats: holdStats, clinched: holdClinched, standings: holdStandings },
    flip: { stats: flipStats, clinched: flipClinched, standings: flipStandings },
    futureRemainingCount: futureRemaining.length,
  }
}

function cloneStats(stats) {
  const out = {}
  for (const [k, v] of Object.entries(stats)) out[k] = { ...v }
  return out
}

function countRemainingByTeam(remainingGames) {
  const map = {}
  for (const g of remainingGames) {
    map[g.homeId] = (map[g.homeId] ?? 0) + 1
    map[g.awayId] = (map[g.awayId] ?? 0) + 1
  }
  return map
}

function ownerFor(teamId) { return TEAM_OWNERS[teamId]?.owner ?? `Team ${teamId}` }

function teamNameFor(teamId, teamsById) { return teamsById[teamId]?.name ?? ownerFor(teamId) }

export function renderStandingsTable(standings, clinchedSet, eliminatedSet) {
  const rows = standings.map(r => {
    const isClinched = clinchedSet.has(r.teamId)
    const isEliminated = eliminatedSet.has(r.teamId)
    const badge = isClinched ? ' <span class="badge clinched">x</span>' : isEliminated ? ' <span class="badge eliminated">e</span>' : ''
    const ownerCell = TEAM_OWNERS[r.teamId] ? `<a href="./${TEAM_OWNERS[r.teamId].page}">${r.owner}</a>` : r.owner
    const record = `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''}`
    return `<tr class="${isClinched ? 'clinched' : isEliminated ? 'eliminated' : ''}"><td class="number">${r.rank}</td><td class="owner">${ownerCell}${badge}</td><td>${escapeHtml(r.name)}</td><td class="number">${record}</td><td class="number">${r.pf.toFixed(1)}</td><td class="number">${r.remaining ?? '-'}</td></tr>`
  }).join('\n')
  return `<div class="table-container"><table class="stats-table">
  <caption class="visually-hidden">Standings</caption>
  <thead><tr><th class="number">#</th><th>Owner</th><th>Team</th><th class="number">W-L</th><th class="number">PF</th><th class="number">Rem</th></tr></thead>
  <tbody>${rows}</tbody></table></div>`
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function renderPageContent(data, teamsById) {
  const clinchedSet = new Set(data.clinchedTeamIds || [])
  const eliminatedSet = new Set(data.eliminatedTeamIds || [])
  const standingsWithRem = data.standings.map(r => ({ ...r, remaining: data.remainingByTeam?.[r.teamId] ?? r.remaining ?? 0 }))
  // sort for display already sorted
  let html = `<h2>Playoff Race</h2>
<p class="section-note">${data.season} regular season &middot; ${data.regularSeasonWeeks} weeks &middot; top ${data.playoffTeamCount} make playoffs &middot; tiebreak is points for &middot; through week ${data.throughWeek} &middot; ${data.remainingCount} games left${data.currentWeek ? ` &middot; current week ${data.currentWeek}` : ''} &middot; generated ${data.generated}</p>
${data.note ? `<p class="callout">${escapeHtml(data.note)}</p>` : ''}
<h3>Current Standings</h3>
<p class="section-note">x = clinched, e = eliminated (wins-only guarantee, tiebreak could still flip).</p>
${renderStandingsTable(standingsWithRem, clinchedSet, eliminatedSet)}`

  if (data.clinchedOwners?.length) html += `<p><strong>Clinched:</strong> ${data.clinchedOwners.map(o => escapeHtml(o)).join(', ')}</p>`
  if (data.eliminatedOwners?.length) html += `<p><strong>Eliminated:</strong> ${data.eliminatedOwners.map(o => escapeHtml(o)).join(', ')}</p>`
  if (!data.clinchedOwners?.length && !data.eliminatedOwners?.length) html += `<p>No teams have clinched or been eliminated yet.</p>`

  if (data.remainingGames?.length) {
    html += `<h3>Remaining Games</h3><div class="table-container"><table class="stats-table"><thead><tr><th>Wk</th><th>Matchup</th><th>Score (if live)</th></tr></thead><tbody>`
    for (const g of data.remainingGames) {
      html += `<tr><td class="number">${g.week}</td><td>${escapeHtml(g.awayOwner)} @ ${escapeHtml(g.homeOwner)}</td><td class="number">${g.awayScore.toFixed(1)} - ${g.homeScore.toFixed(1)}${g.leader ? ` (${escapeHtml(g.leader)} leads)` : ''}</td></tr>`
    }
    html += `</tbody></table></div>`
  }

  if (data.scenarios) {
    const sc = data.scenarios
    html += `<h3>Monday Hypotheticals — Week ${sc.currentWeek}</h3>
<p class="section-note">If current leaders hold vs if they flip, how clinches shift (remaining after this week).</p>
<div class="scenario-grid">
<div><h4>If leaders hold</h4><p class="muted">${sc.currentWeekGames.map(g => `${g.awayOwner} @ ${g.homeOwner}: ${g.leader ?? 'tied'} leads → hold to ${ownerFor(g.holdWinner)}`).join('<br>')}</p>
${renderStandingsTable(sc.hold.standings, new Set(sc.hold.clinched.clinched), new Set(sc.hold.clinched.eliminated))}
${sc.hold.clinched.clinched.length ? `<p><strong>Would clinch:</strong> ${sc.hold.clinched.clinched.map(id => ownerFor(id)).join(', ')}</p>` : ''}
</div>
<div><h4>If underdogs rally</h4><p class="muted">${sc.currentWeekGames.map(g => `${g.awayOwner} @ ${g.homeOwner}: flip to ${ownerFor(g.flipWinner)}`).join('<br>')}</p>
${renderStandingsTable(sc.flip.standings, new Set(sc.flip.clinched.clinched), new Set(sc.flip.clinched.eliminated))}
${sc.flip.clinched.clinched.length ? `<p><strong>Would clinch:</strong> ${sc.flip.clinched.clinched.map(id => ownerFor(id)).join(', ')}</p>` : ''}
</div>
</div>`
  }

  html += `<details class="methodology"><summary>How this works</summary>
<p>Standings count only regular-season games (playoffTierType NONE). Wins + 0.5×ties sorted, then points for. Clinched means even losing all remaining games, the team still finishes top ${data.playoffTeamCount} even if every tied team wins the tiebreak. Eliminated means even winning out, the team cannot reach top ${data.playoffTeamCount} even with tiebreak help. Enumeration tries all 2<sup>n</sup> outcomes for the ${data.remainingCount} remaining regular games (capped at ${ENUM_LIMIT}); head-to-head conflicts are respected, so not every team can win out simultaneously. Future points are ignored for tiebreak — wins grouping is conservative. Hypotheticals show Monday-night "hold vs flip" for the current in-progress week only.</p>
<p>Data from the ESPN fantasy API. Regenerate with <code>make playoff</code> or wait for the Monday night GitHub Action. Page and JSON refresh together; start week is ${data.startWeek} (regular season is ${data.regularSeasonWeeks} weeks).</p>
</details>`
  return html
}

const START = '<!-- PLAYOFF_RACE_START -->'
const END = '<!-- PLAYOFF_RACE_END -->'

export function upsertPage(contentHtml, pagePath = PAGE_PATH) {
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
  <title>DerBruden.com | Playoff Race</title>
  <meta property="og:title" content="DerBruden.com | Playoff Race">
  <meta property="og:description" content="Late-season playoff clinch and elimination scenarios for the Der Bruden fantasy football league. Updated Mondays with hold vs flip hypotheticals.">
  <meta property="og:url" content="https://derbruden.com/playoff-race.html">
  <meta property="og:image" content="https://derbruden.com/static/img/league-logo.webp">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="DerBruden.com | Playoff Race">
  <meta name="twitter:description" content="Playoff clinch and elimination scenarios for the Der Bruden league.">
  <meta name="twitter:image" content="https://derbruden.com/static/img/league-logo.webp">
  <!--#include file="partials/head-common.html" -->
  <style>
    .section-note { color: #666; font-size: 0.9em; }
    h2 { margin-top: 40px; }
    h3 { margin-top: 32px; }
    h4 { margin-top: 16px; margin-bottom: 8px; }
    .stats-table .number { text-align: right; }
    .stats-table .owner { font-weight: 500; white-space: nowrap; }
    .badge { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 0.8em; font-weight: 700; color: #fff; margin-left: 6px; }
    .badge.clinched { background: #1a7f37; }
    .badge.eliminated { background: #c0392b; }
    tr.clinched { background: #e6f4ea; }
    tr.eliminated { background: #fce8e6; }
    .muted { color: #666; font-size: 0.9em; }
    .scenario-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
    @media (max-width: 800px) { .scenario-grid { grid-template-columns: 1fr; } }
    .callout { background: #fff8e1; border: 1px solid #ffecb3; padding: 10px 12px; border-radius: 6px; }
    .methodology { margin-top: 30px; font-size: 0.85em; color: #666; }
  </style>
</head>

<body>
  <!--#include file="partials/site-header.html" -->

  <!--#include file="partials/nav.html" -->

  <main id="main">
    <div class="owner-logo-header">
      <img src="../static/img/league-logo.webp" alt="DB Logo" width="100" height="100"
        style="border-radius: 50%; object-fit: cover;">
      <h1>Playoff Race</h1>
    </div>
    <!-- PLAYOFF_RACE_START -->
${content}
<!-- PLAYOFF_RACE_END -->
    <p class="section-note">Regular season only. Regenerate with <code>make playoff</code>. Clinch math enumerates all remaining outcomes head-to-head.</p>
  </main>

  <!--#include file="partials/footer.html" -->
</body>

</html>
`
}

function writeJsonAtomic(file, data) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

export async function main(argv, fetchImpl = globalThis.fetch, paths = {}) {
  const args = parseArgs(argv)
  const env = resolveConfig()
  env.LEAGUE_ID = env.LEAGUE_ID ?? '794521'
  const preferredSeason = args.season ?? Number(env.LEAGUE_YEAR ?? defaultSeason())
  const startWeek = args.startWeek ?? Number(env.PLAYOFF_START_WEEK ?? DEFAULT_START_WEEK)
  env.LEAGUE_YEAR = String(preferredSeason)

  const required = ['ESPN_S2']
  for (const key of required) if (!env[key]) throw new Error(`Missing required config: ${key}`)

  const url = leagueUrl(env)
  let league
  try {
    league = await fetchJson(fetchImpl, `${url}?view=mSettings&view=mTeam&view=mMatchupScore`, { headers: { Cookie: authCookie(env), 'User-Agent': USER_AGENT } })
  } catch (err) {
    if (!args.season) {
      const fallback = preferredSeason - 1
      console.warn(`${err.message} Falling back to season ${fallback}.`)
      env.LEAGUE_YEAR = String(fallback)
      league = await fetchJson(fetchImpl, `${leagueUrl(env)}?view=mSettings&view=mTeam&view=mMatchupScore`, { headers: { Cookie: authCookie(env), 'User-Agent': USER_AGENT } })
    } else throw err
  }

  const season = league.seasonId ?? Number(env.LEAGUE_YEAR)
  const settings = league.settings?.scheduleSettings ?? {}
  const playoffTeamCount = settings.playoffTeamCount ?? DEFAULT_PLAYOFF_TEAM_COUNT
  const regularSeasonWeeks = settings.matchupPeriodCount ?? 13

  const teamsById = extractTeams(league)
  const allGames = extractGames(league)
  const regularGames = allGames.filter(g => !g.playoff)
  const decided = regularGames.filter(g => g.decided)
  const remaining = regularGames.filter(g => !g.decided)

  const stats = computeStandings(decided, teamsById)
  const standings = standingsList(stats, teamsById)
  const remainingByTeam = countRemainingByTeam(remaining)
  standings.forEach(r => r.remaining = remainingByTeam[r.teamId] ?? 0)

  const throughWeek = decided.reduce((m, g) => Math.max(m, g.week), 0)
  const currentWeek = remaining.length ? Math.min(...remaining.map(g => g.week)) : null

  const clinch = computeClinchEliminated(stats, remaining, playoffTeamCount, teamsById)

  // Late-season gate note
  let note = null
  if (throughWeek < startWeek - 1 && remaining.length) {
    note = `Playoff race starts week ${startWeek}. Through week ${throughWeek} no clinches are posted.`
  } else if (remaining.length === 0) {
    note = `Regular season complete. Final playoff field is set.`
  } else if (clinch.note) {
    note = clinch.note
  }

  // Scenarios only when there's an in-progress current week. Gate to late season.
  let scenarios = null
  const isLateSeasonGate = throughWeek >= startWeek - 1 || remaining.length === 0
  if (isLateSeasonGate && remaining.length && currentWeek && remaining.filter(g => g.week === currentWeek).length) {
    scenarios = buildScenarios(stats, remaining, playoffTeamCount, teamsById)
  }

  const clinchedOwners = clinch.clinched.map(id => ownerFor(id))
  const eliminatedOwners = clinch.eliminated.map(id => ownerFor(id))

  // Prepare remainingGames for JSON/page
  const remainingGamesJson = remaining.map(g => ({
    week: g.week,
    homeId: g.homeId,
    awayId: g.awayId,
    homeOwner: ownerFor(g.homeId),
    awayOwner: ownerFor(g.awayId),
    homeScore: g.homeScore,
    awayScore: g.awayScore,
    leader: currentLeaderForGame(g) ? ownerFor(currentLeaderForGame(g)) : null,
  }))

  const output = {
    generated: new Date().toISOString().slice(0, 10),
    leagueId: String(env.LEAGUE_ID),
    season,
    playoffTeamCount,
    regularSeasonWeeks,
    startWeek,
    throughWeek,
    currentWeek,
    remainingCount: remaining.length,
    remainingByTeam,
    standings: standings.map(r => ({
      rank: r.rank,
      teamId: r.teamId,
      owner: r.owner,
      abbrev: r.abbrev,
      name: r.name,
      wins: r.wins,
      losses: r.losses,
      ties: r.ties,
      winValue: r.winValue,
      pf: Math.round(r.pf * 10) / 10,
      pa: Math.round(r.pa * 10) / 10,
      gamesBack: r.gamesBack,
      remaining: r.remaining,
      bestRank: clinch.bestRank[r.teamId],
      worstRank: clinch.worstRank[r.teamId],
      clinched: clinch.clinched.includes(r.teamId),
      eliminated: clinch.eliminated.includes(r.teamId),
    })),
    clinchedTeamIds: clinch.clinched,
    eliminatedTeamIds: clinch.eliminated,
    clinchedOwners,
    eliminatedOwners,
    remainingGames: remainingGamesJson,
    scenarios: scenarios ? {
      currentWeek: scenarios.currentWeek,
      currentWeekGames: scenarios.currentWeekGames,
      hold: {
        clinched: scenarios.hold.clinched.clinched,
        eliminated: scenarios.hold.clinched.eliminated,
        clinchedOwners: scenarios.hold.clinched.clinched.map(id => ownerFor(id)),
        eliminatedOwners: scenarios.hold.clinched.eliminated.map(id => ownerFor(id)),
        standings: scenarios.hold.standings,
      },
      flip: {
        clinched: scenarios.flip.clinched.clinched,
        eliminated: scenarios.flip.clinched.eliminated,
        clinchedOwners: scenarios.flip.clinched.clinched.map(id => ownerFor(id)),
        eliminatedOwners: scenarios.flip.clinched.eliminated.map(id => ownerFor(id)),
        standings: scenarios.flip.standings,
      },
      futureRemainingCount: scenarios.futureRemainingCount,
    } : null,
    note,
    isLateSeason: isLateSeasonGate,
  }

  // Render page content
  const pageContent = renderPageContent({
    season,
    generated: output.generated,
    playoffTeamCount,
    regularSeasonWeeks,
    throughWeek,
    currentWeek,
    remainingCount: remaining.length,
    startWeek,
    standings: standings.map(r => ({ ...r, remaining: remainingByTeam[r.teamId] ?? 0 })),
    clinchedTeamIds: clinch.clinched,
    eliminatedTeamIds: clinch.eliminated,
    clinchedOwners,
    eliminatedOwners,
    remainingByTeam,
    remainingGames: remainingGamesJson,
    scenarios,
    note,
  }, teamsById)

  if (args.dryRun) {
    console.log(`[dry-run] season ${season} through week ${throughWeek}, ${remaining.length} remaining, clinched ${clinchedOwners.join(',') || 'none'}, eliminated ${eliminatedOwners.join(',') || 'none'}`)
    console.log(JSON.stringify(output, null, 2))
    return 0
  }

  writeJsonAtomic(paths.dataFile ?? DATA_FILE, output)
  console.log(`Wrote ${paths.dataFile ?? DATA_FILE} (${standings.length} teams, ${remaining.length} remaining)`)

  upsertPage(pageContent, paths.pagePath ?? PAGE_PATH)
  return 0
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(e => { console.error(e.message); process.exit(1) })
}
