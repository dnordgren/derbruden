#!/usr/bin/env node
// Diaper race tracker. Last place in the regular season wears a diaper for
// the annual league pic. Worst record takes it, lower PF breaks ties.
// Same machinery as the playoff race (generate-playoff-race.mjs), mirrored:
// enumerate remaining-game outcomes to find teams locked into the diaper
// (doomed) vs teams that cannot finish last (safe). Late-season only.
// Writes static/data/diaper-race.json and updates src/diaper-race.html.
//
// Usage:
//   node scripts/generate-diaper-race.mjs [--dry-run] [--start-week=N] [season]
// Season defaults like the other generators: Aug-Dec -> current year,
// Jan-Jul -> prior year.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEAM_OWNERS } from './team-owners.js'
import {
  DEFAULT_START_WEEK,
  ENUM_LIMIT,
  buildScenarios,
  computeClinchEliminated,
  computeStandings,
  currentLeaderForGame,
  defaultSeason,
  extractGames,
  extractTeams,
  loadEnvFile,
  parseArgs,
  raceDataEqual,
  standingsList,
} from './generate-playoff-race.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DATA_FILE = path.join(ROOT, 'static', 'data', 'diaper-race.json')
const PAGE_PATH = path.join(ROOT, 'src', 'playoff-race.html')
const ENV_FILE = path.join(ROOT, '.env')
const DEFAULT_LEAGUE_HOST = 'https://lm-api-reads.fantasy.espn.com'
const LEAGUE_PATH = '/apis/v3/games/ffl/seasons/{year}/segments/0/leagues/{league}'
const USER_AGENT = 'derbruden.com diaper race generator'

// The diaper is the mirror image of a playoff berth: with N teams, finishing
// "top N-1" means safe and rank N means the diaper. Reuse the playoff
// enumeration with a cutoff of N-1: clinched -> safe, eliminated -> doomed.
export function computeDiaperFate(currentStats, remainingGames, teamCount, teamsById) {
  const res = computeClinchEliminated(currentStats, remainingGames, teamCount - 1, teamsById)
  return {
    doomed: res.eliminated,
    safe: res.clinched,
    bestRank: res.bestRank,
    worstRank: res.worstRank,
    note: res.note,
    remaining: res.remaining,
  }
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

function ownerFor(teamId) { return TEAM_OWNERS[teamId]?.owner ?? `Team ${teamId}` }

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function renderDiaperTable(standingsWorstFirst, doomedSet, safeSet) {
  const rows = standingsWorstFirst.map(r => {
    const isDoomed = doomedSet.has(r.teamId)
    const isSafe = safeSet.has(r.teamId)
    const badge = isDoomed ? ' <span class="badge doomed">d</span>' : isSafe ? ' <span class="badge safe">s</span>' : ''
    const ownerCell = TEAM_OWNERS[r.teamId] ? `<a href="./${TEAM_OWNERS[r.teamId].page}">${r.owner}</a>` : r.owner
    const record = `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''}`
    return `<tr class="${isDoomed ? 'doomed' : isSafe ? 'safe' : ''}"><td class="number">${r.rank}</td><td class="owner">${ownerCell}${badge}</td><td>${escapeHtml(r.name)}</td><td class="number">${record}</td><td class="number">${r.pf.toFixed(1)}</td><td class="number">${r.remaining ?? '-'}</td></tr>`
  }).join('\n')
  return `<div class="table-container"><table class="stats-table">
  <caption class="visually-hidden">Diaper race standings, worst first</caption>
  <thead><tr><th class="number">#</th><th>Owner</th><th>Team</th><th class="number">W-L</th><th class="number">PF</th><th class="number">Rem</th></tr></thead>
  <tbody>${rows}</tbody></table></div>`
}

export function renderPageContent(data, teamsById) {
  const doomedSet = new Set(data.doomedTeamIds || [])
  const safeSet = new Set(data.safeTeamIds || [])
  const worstFirst = [...data.standings].sort((a, b) => a.rank - b.rank).reverse()
  worstFirst.forEach(r => r.remaining = data.remainingByTeam?.[r.teamId] ?? r.remaining ?? 0)
  let html = `<h2>Diaper Race</h2>
<p class="section-note">${data.season} regular season &middot; ${data.regularSeasonWeeks} weeks &middot; last place wears a diaper for the league pic &middot; worst record, lower PF breaks ties &middot; through week ${data.throughWeek} &middot; ${data.remainingCount} games left${data.currentWeek ? ` &middot; current week ${data.currentWeek}` : ''} &middot; generated ${data.generated}</p>
${data.note ? `<p class="callout">${escapeHtml(data.note)}</p>` : ''}
<h3>Diaper Watch — worst first</h3>
<p class="section-note">d = locked into the diaper, s = mathematically safe (wins-only guarantee, tiebreak could still flip).</p>
${renderDiaperTable(worstFirst, doomedSet, safeSet)}`

  if (data.doomedOwners?.length) html += `<p><strong>Fitted for the diaper:</strong> 🍼 ${data.doomedOwners.map(o => escapeHtml(o)).join(', ')}</p>`
  if (data.safeOwners?.length) html += `<p><strong>Safe:</strong> ${data.safeOwners.map(o => escapeHtml(o)).join(', ')}</p>`
  if (!data.doomedOwners?.length && !data.safeOwners?.length) html += `<p>Nobody is locked in or safe yet — every team can still dodge the diaper.</p>`

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
<p class="section-note">If current leaders hold vs if they flip, how diaper locks shift (remaining after this week).</p>
<div class="scenario-grid">
<div><h4>If leaders hold</h4><p class="muted">${sc.currentWeekGames.map(g => `${g.awayOwner} @ ${g.homeOwner}: ${g.leader ?? 'tied'} leads → hold to ${ownerFor(g.holdWinner)}`).join('<br>')}</p>
${renderDiaperTable([...sc.hold.standings].sort((a, b) => a.rank - b.rank).reverse(), new Set(sc.hold.doomed), new Set(sc.hold.safe))}
${sc.hold.doomed.length ? `<p><strong>Would lock in:</strong> 🍼 ${sc.hold.doomed.map(id => ownerFor(id)).join(', ')}</p>` : ''}
</div>
<div><h4>If underdogs rally</h4><p class="muted">${sc.currentWeekGames.map(g => `${g.awayOwner} @ ${g.homeOwner}: flip to ${ownerFor(g.flipWinner)}`).join('<br>')}</p>
${renderDiaperTable([...sc.flip.standings].sort((a, b) => a.rank - b.rank).reverse(), new Set(sc.flip.doomed), new Set(sc.flip.safe))}
${sc.flip.doomed.length ? `<p><strong>Would lock in:</strong> 🍼 ${sc.flip.doomed.map(id => ownerFor(id)).join(', ')}</p>` : ''}
</div>
</div>`
  }

  html += `<details class="methodology"><summary>How this works</summary>
<p>Standings count only regular-season games (playoffTierType NONE). Wins + 0.5×ties sorted, then points for — the diaper goes to the worst record with lower PF as the tiebreak. Doomed means even winning all remaining games, the team still finishes last even with tiebreak help. Safe means even losing out, the team cannot finish last even losing tiebreaks. Enumeration tries all 2<sup>n</sup> outcomes for the ${data.remainingCount} remaining regular games (capped at ${ENUM_LIMIT}); head-to-head conflicts are respected, so not every team can win out simultaneously. Future points are ignored for tiebreak — wins grouping is conservative. Hypotheticals show Monday-night "hold vs flip" for the current in-progress week only.</p>
<p>Data from the ESPN fantasy API. Regenerate with <code>make diaper</code> or wait for the Monday night GitHub Action. Page and JSON refresh together; start week is ${data.startWeek} (regular season is ${data.regularSeasonWeeks} weeks).</p>
</details>`
  return html
}

const START = '<!-- DIAPER_RACE_START -->'
const END = '<!-- DIAPER_RACE_END -->'

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
  <title>DerBruden.com | Races</title>
  <meta property="og:title" content="DerBruden.com | Races">
  <meta property="og:description" content="Playoff clinch scenarios and the last-place diaper watch for the Der Bruden fantasy football league. Updated Mondays with hold vs flip hypotheticals.">
  <meta property="og:url" content="https://derbruden.com/playoff-race.html">
  <meta property="og:image" content="https://derbruden.com/static/img/league-logo.webp">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="DerBruden.com | Races">
  <meta name="twitter:description" content="Playoff race and diaper watch for the Der Bruden league.">
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
    .badge.doomed { background: #7b4b00; }
    .badge.safe { background: #1a7f37; }
    tr.doomed { background: #f3e8d3; }
    tr.safe { background: #e6f4ea; }
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
      <h1>Playoff & Diaper Races</h1>
    </div>
    <!-- PLAYOFF_RACE_START -->
<!-- PLAYOFF_RACE_END -->
    <section id="diaper">
    <!-- DIAPER_RACE_START -->
${content}
<!-- DIAPER_RACE_END -->
    </section>
    <p class="section-note">Regular season only. Regenerate with <code>make races</code>. Clinch and diaper math enumerate all remaining outcomes head-to-head.</p>
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
  const regularSeasonWeeks = settings.matchupPeriodCount ?? 13

  const teamsById = extractTeams(league)
  const teamCount = Object.keys(teamsById).length
  const allGames = extractGames(league)
  const regularGames = allGames.filter(g => !g.playoff)
  const decided = regularGames.filter(g => g.decided)
  const remaining = regularGames.filter(g => !g.decided)

  const stats = computeStandings(decided, teamsById)
  const standings = standingsList(stats, teamsById)
  const remainingByTeam = {}
  for (const g of remaining) {
    remainingByTeam[g.homeId] = (remainingByTeam[g.homeId] ?? 0) + 1
    remainingByTeam[g.awayId] = (remainingByTeam[g.awayId] ?? 0) + 1
  }
  standings.forEach(r => r.remaining = remainingByTeam[r.teamId] ?? 0)

  const throughWeek = decided.reduce((m, g) => Math.max(m, g.week), 0)
  const currentWeek = remaining.length ? Math.min(...remaining.map(g => g.week)) : null

  const fate = computeDiaperFate(stats, remaining, teamCount, teamsById)

  // Late-season gate note
  let note = null
  if (throughWeek < startWeek - 1 && remaining.length) {
    note = `Diaper race starts week ${startWeek}. Through week ${throughWeek} no locks are posted.`
  } else if (remaining.length === 0) {
    note = `Regular season complete. The diaper is fitted.`
  } else if (fate.note) {
    note = fate.note
  }

  // Scenarios only when there's an in-progress current week. Gate to late season.
  let scenarios = null
  const isLateSeasonGate = throughWeek >= startWeek - 1 || remaining.length === 0
  if (isLateSeasonGate && remaining.length && currentWeek && remaining.filter(g => g.week === currentWeek).length) {
    const raw = buildScenarios(stats, remaining, teamCount - 1, teamsById)
    scenarios = {
      currentWeek: raw.currentWeek,
      currentWeekGames: raw.currentWeekGames,
      hold: {
        doomed: raw.hold.clinched.eliminated,
        safe: raw.hold.clinched.clinched,
        doomedOwners: raw.hold.clinched.eliminated.map(id => ownerFor(id)),
        safeOwners: raw.hold.clinched.clinched.map(id => ownerFor(id)),
        standings: raw.hold.standings,
      },
      flip: {
        doomed: raw.flip.clinched.eliminated,
        safe: raw.flip.clinched.clinched,
        doomedOwners: raw.flip.clinched.eliminated.map(id => ownerFor(id)),
        safeOwners: raw.flip.clinched.clinched.map(id => ownerFor(id)),
        standings: raw.flip.standings,
      },
      futureRemainingCount: raw.futureRemainingCount,
    }
  }

  const doomedOwners = fate.doomed.map(id => ownerFor(id))
  const safeOwners = fate.safe.map(id => ownerFor(id))

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
    teamCount,
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
      bestRank: fate.bestRank[r.teamId],
      worstRank: fate.worstRank[r.teamId],
      doomed: fate.doomed.includes(r.teamId),
      safe: fate.safe.includes(r.teamId),
    })),
    doomedTeamIds: fate.doomed,
    safeTeamIds: fate.safe,
    doomedOwners,
    safeOwners,
    remainingGames: remainingGamesJson,
    scenarios,
    note,
    isLateSeason: isLateSeasonGate,
  }

  // Render page content
  const pageData = {
    season,
    generated: output.generated,
    teamCount,
    regularSeasonWeeks,
    throughWeek,
    currentWeek,
    remainingCount: remaining.length,
    startWeek,
    standings: standings.map(r => ({ ...r, remaining: remainingByTeam[r.teamId] ?? 0 })),
    doomedTeamIds: fate.doomed,
    safeTeamIds: fate.safe,
    doomedOwners,
    safeOwners,
    remainingByTeam,
    remainingGames: remainingGamesJson,
    scenarios: scenarios ? {
      currentWeek: scenarios.currentWeek,
      currentWeekGames: scenarios.currentWeekGames,
      hold: { ...scenarios.hold, standings: scenarios.hold.standings },
      flip: { ...scenarios.flip, standings: scenarios.flip.standings },
    } : null,
    note,
  }
  // renderPageContent reads sc.hold.doomed / sc.hold.safe directly.
  const pageContent = renderPageContent({ ...pageData, scenarios }, teamsById)

  if (args.dryRun) {
    console.log(`[dry-run] season ${season} through week ${throughWeek}, ${remaining.length} remaining, doomed ${doomedOwners.join(',') || 'none'}, safe ${safeOwners.length} teams`)
    console.log(JSON.stringify(output, null, 2))
    return 0
  }

  const dataFile = paths.dataFile ?? DATA_FILE
  const pagePath = paths.pagePath ?? PAGE_PATH

  // Repeat-post guard: same as the playoff race — unchanged race (only the
  // `generated` date would differ) leaves both files untouched so the
  // workflow stays silent.
  if (fs.existsSync(dataFile) && fs.existsSync(pagePath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
      if (raceDataEqual(existing, output)) {
        const existingPage = fs.readFileSync(pagePath, 'utf8')
        const startIdx = existingPage.indexOf(START)
        const endIdx = existingPage.indexOf(END)
        if (startIdx !== -1 && endIdx !== -1) {
          const rerendered = renderPageContent({ ...pageData, generated: existing.generated, scenarios }, teamsById)
          if (existingPage.slice(startIdx + START.length, endIdx) === `\n${rerendered}\n`) {
            console.log('Diaper race unchanged since last run; leaving files untouched.')
            return 0
          }
        }
      }
    } catch {
      // Unreadable existing state: fall through and write fresh files.
    }
  }

  writeJsonAtomic(dataFile, output)
  console.log(`Wrote ${dataFile} (${standings.length} teams, ${remaining.length} remaining)`)

  upsertPage(pageContent, pagePath)
  return 0
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(e => { console.error(e.message); process.exit(1) })
}
