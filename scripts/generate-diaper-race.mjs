#!/usr/bin/env node
// Diaper race tracker. Last place in the regular season wears a diaper for
// the annual league pic. Worst record takes it, lower PF breaks ties.
// Same machinery as the playoff race (generate-playoff-race.mjs), mirrored:
// enumerate remaining-game outcomes to find teams locked into the diaper
// (doomed) vs teams that cannot finish last (safe). Late-season only.
// Writes static/data/diaper-race.json (the Discord post reads it; the
// single races page renders diaper badges from the playoff generator).
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
  buildScenarios,
  computeDiaperFate,
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
const ENV_FILE = path.join(ROOT, '.env')
const DEFAULT_LEAGUE_HOST = 'https://lm-api-reads.fantasy.espn.com'
const LEAGUE_PATH = '/apis/v3/games/ffl/seasons/{year}/segments/0/leagues/{league}'
const USER_AGENT = 'derbruden.com diaper race generator'


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

  if (args.dryRun) {
    console.log(`[dry-run] season ${season} through week ${throughWeek}, ${remaining.length} remaining, doomed ${doomedOwners.join(',') || 'none'}, safe ${safeOwners.length} teams`)
    console.log(JSON.stringify(output, null, 2))
    return 0
  }

  const dataFile = paths.dataFile ?? DATA_FILE

  // Repeat-post guard: unchanged race (only the `generated` date would
  // differ) leaves the JSON untouched so the workflow stays silent.
  if (fs.existsSync(dataFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
      if (raceDataEqual(existing, output)) {
        console.log('Diaper race unchanged since last run; leaving files untouched.')
        return 0
      }
    } catch {
      // Unreadable existing state: fall through and write fresh files.
    }
  }

  writeJsonAtomic(dataFile, output)
  console.log(`Wrote ${dataFile} (${standings.length} teams, ${remaining.length} remaining)`)
  return 0
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(e => { console.error(e.message); process.exit(1) })
}
