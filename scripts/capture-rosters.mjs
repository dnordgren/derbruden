#!/usr/bin/env node
// Weekly roster snapshot capture. ESPN's mRoster terms age out of old
// transaction detail, but per-week rosters are still served historically —
// until they aren't. This writes a slim first-party record (team -> player
// ids per scoring period) so trade reconstruction never depends on ESPN
// retaining anything. Diffing consecutive weeks recovers trade terms:
// reciprocal hops are confident trades, one-way hops are flagged for review.
//
// Usage:
//   node scripts/capture-rosters.mjs [--backfill] [--week N] [--dry-run]
// Config comes from the environment or a .env file at the repo root.
// See .env.example.

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

import { loadEnvFile } from './watch-trades.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_SNAPSHOT_FILE = path.join(ROOT, 'static', 'data', 'roster-snapshots.json')
const ENV_FILE = path.join(ROOT, '.env')
const SCRIPTS_ENV_FILE = path.join(ROOT, 'scripts', '.env')

const LEAGUE_PATH = '/apis/v3/games/ffl/seasons/{year}/segments/0/leagues/{league}'
const DEFAULT_LEAGUE_HOST = 'https://lm-api-reads.fantasy.espn.com'

// A snapshot of scoring period N is only final once period N+1 has started;
// Tuesday morning after the prior week's Monday game is the natural capture
// point. Weekly cadence keeps the API footprint at ~52 calls/year.

export function parseArgs(argv) {
  const args = { backfill: false, week: null, dryRun: false }
  for (const arg of argv) {
    if (arg === '--backfill') args.backfill = true
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg.startsWith('--week=')) {
      const n = Number(arg.slice('--week='.length))
      if (!Number.isInteger(n) || n < 1) throw new Error(`Bad --week value: ${arg}`)
      args.week = n
    } else throw new Error(`Unknown argument: ${arg}`)
  }
  if (args.backfill && args.week != null) throw new Error('Use --week or --backfill, not both')
  return args
}

export function resolveConfig() {
  return { ...loadEnvFile(ENV_FILE), ...loadEnvFile(SCRIPTS_ENV_FILE), ...process.env }
}

function authCookie(env) {
  return `espn_s2=${env.ESPN_S2}; SWID=${env.SWID}`
}

async function fetchJson(fetchImpl, url, options) {
  const res = await fetchImpl(url, options)
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(
      `ESPN returned non-JSON (HTTP ${res.status}). Cookies are likely expired ` +
        'or missing SWID. Copy espn_s2 and SWID together from one signed-in session.'
    )
  }
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`)
  return body
}

async function fetchRoster(fetchImpl, env, season, week) {
  const url =
    (env.LEAGUE_HOST ?? DEFAULT_LEAGUE_HOST) +
    LEAGUE_PATH.replace('{year}', String(season)).replace('{league}', env.LEAGUE_ID) +
    `?view=mRoster&scoringPeriodId=${week}`
  return fetchJson(fetchImpl, url, { headers: { Cookie: authCookie(env) } })
}

// Last scoring period whose games have finished. Active season: the period
// before the in-progress one. Finished season: ESPN drops
// currentScoringPeriodId and latestScoringPeriod points one past the last
// real week (playoffs run past finalScoringPeriod, so don't clamp there).
export function latestCompletedWeek(status) {
  if (!status) return null
  const current = Number(status.currentScoringPeriodId)
  if (Number.isFinite(current) && current >= 2) return current - 1
  const latest = Number(status.latestScoringPeriod)
  if (Number.isFinite(latest) && latest >= 2) return latest - 1
  const matchup = Number(status.currentMatchupPeriod)
  if (Number.isFinite(matchup) && matchup >= 2) return matchup - 1
  return null
}

// Slim the ESPN roster payload to the trade-analysis essentials:
// team id -> sorted player ids. Everything else ESPN serves (slots,
// stats, acquisition metadata) is either weekly-recoverable or already
// lost to history; keeping this minimal keeps snapshots cheap to commit.
export function slimRosters(teams) {
  const out = {}
  for (const t of teams ?? []) {
    const ids = (t.roster?.entries ?? [])
      .map(e => e.playerId)
      .filter(id => Number.isInteger(id) && id > 0)
      .sort((a, b) => a - b)
    out[t.id] = ids
  }
  return out
}

export function loadSnapshots(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { leagueId: null, updated: null, seasons: {}, ...s }
  } catch {
    return { leagueId: null, updated: null, seasons: {} }
  }
}

// Idempotent merge: existing weeks are never overwritten, so a re-run or a
// late-arriving older week fills gaps without clobbering captured data.
export function mergeSnapshot(snapshots, season, week, rosters) {
  const key = String(season)
  const seasons = { ...snapshots.seasons }
  const existing = seasons[key] ?? {}
  if (week in existing) return { snapshots, changed: false }
  seasons[key] = { ...existing, [week]: rosters }
  return {
    snapshots: { ...snapshots, seasons },
    changed: true
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + '\n')
  fs.renameSync(tmp, file)
}

// Weeks worth capturing for a season: 1..latestCompleted, minus anything
// already in the snapshot file.
export function missingWeeks(snapshots, season, latestCompleted) {
  const existing = snapshots.seasons[String(season)] ?? {}
  const out = []
  for (let w = 1; w <= latestCompleted; w++) if (!(w in existing)) out.push(w)
  return out
}

export async function main(argv, fetchImpl = globalThis.fetch, paths = {}) {
  const args = parseArgs(argv)
  const env = resolveConfig()
  const required = ['LEAGUE_ID', 'LEAGUE_YEAR', 'ESPN_S2', 'SWID']
  for (const key of required)
    if (!env[key]) throw new Error(`Missing required config: ${key}`)

  const snapshotFile = paths.snapshotFile ?? env.ROSTER_SNAPSHOT_FILE ?? DEFAULT_SNAPSHOT_FILE
  const season = Number(env.LEAGUE_YEAR)

  const probe = await fetchRoster(fetchImpl, env, season, args.week ?? 1)
  const latest = latestCompletedWeek(probe.status)
  if (latest == null) {
    console.log(`Season ${season} has no completed weeks yet; nothing to capture.`)
    return 0
  }

  const snapshots = loadSnapshots(snapshotFile)
  snapshots.leagueId = env.LEAGUE_ID
  const weeks = args.week != null
    ? (args.week <= latest ? [args.week] : [])
    : args.backfill
      ? missingWeeks(snapshots, season, latest)
      : [latest].filter(w => missingWeeks(snapshots, season, latest).includes(w))

  if (weeks.length === 0) {
    console.log(`Season ${season} snapshots already current through week ${latest}.`)
    return 0
  }

  let captured = 0
  for (const week of weeks) {
    const data = week === 1 && args.week == null && !args.backfill
      ? probe
      : await fetchRoster(fetchImpl, env, season, week)
    const { snapshots: merged, changed } = mergeSnapshot(snapshots, season, week, slimRosters(data.teams))
    if (!changed) {
      console.log(`Week ${week} already captured; skipping.`)
      continue
    }
    snapshots.seasons = merged.seasons
    captured++
    console.log(`Captured season ${season} week ${week}.`)
  }

  if (args.dryRun) {
    console.log(`[dry-run] would persist ${captured} snapshot(s); nothing written.`)
    return 0
  }
  if (captured > 0) {
    snapshots.updated = new Date().toISOString()
    writeJsonAtomic(snapshotFile, snapshots)
  }
  console.log(`Captured ${captured} week(s); file now has seasons ${Object.keys(snapshots.seasons).join(', ')}.`)
  return 0
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e.message)
      process.exit(1)
    })
}
