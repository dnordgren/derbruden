#!/usr/bin/env node
// ESPN fantasy waivers page generator. Fetches the current waiver order and
// this season's waiver moves, then writes static/data/waivers.json for
// src/waivers.html to render client-side.
//
// The JSON is rebuilt from scratch on every run, so only the current season
// is ever retained. The player-name cache (scripts/waiver-players.json) is
// pruned to the current season too.
//
// Usage:
//   node scripts/generate-waivers.mjs [--dry-run]
// Config comes from the environment or a .env file at the repo root.
// Transactions need BOTH ESPN_S2 and SWID, like the trade watcher.

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { TEAM_OWNERS } from './team-owners.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_FILE = path.join(ROOT, 'static', 'data', 'waivers.json')
const PLAYERS_FILE = path.join(ROOT, 'scripts', 'waiver-players.json')
const ENV_FILE = path.join(ROOT, '.env')

// Same read host and cookie rules as the trade watcher: lm-api-reads serves
// transactions only with the full espn_s2 + SWID pair.
const LEAGUE_PATH = '/apis/v3/games/ffl/seasons/{year}/segments/0/leagues/{league}'
const DEFAULT_LEAGUE_HOST = 'https://lm-api-reads.fantasy.espn.com'
const CORE_BASE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl'

const MOVE_TYPES = ['FREEAGENT', 'WAIVER']
const KEPT_STATUSES = new Set(['EXECUTED', 'PROPOSED'])
const MAX_MOVES = 150

const CONFIG_KEYS = ['LEAGUE_ID', 'LEAGUE_YEAR', 'ESPN_S2', 'SWID', 'LEAGUE_HOST', 'WAIVERS_FILE']

export function loadEnvFile(file) {
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
  for (const key of CONFIG_KEYS) {
    // Blank env vars (e.g. make passing unset values through) fall back to
    // the .env file instead of shadowing it.
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
  return (
    (env.LEAGUE_HOST ?? DEFAULT_LEAGUE_HOST) +
    LEAGUE_PATH.replace('{year}', env.LEAGUE_YEAR).replace('{league}', env.LEAGUE_ID)
  )
}

async function fetchJson(fetchImpl, url, options = {}) {
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

function writeJsonAtomic(file, data) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

export function parseArgs(argv) {
  const args = { dryRun: false }
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

function txDate(tx) {
  const ms = tx.processDate ?? tx.proposedDate ?? tx.statusDate
  const n = Number(ms)
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null
}

// D/ST ids are -(16000 + NFL team core id), same shape as draft slots.
export function dslNflTeamId(playerId) {
  return playerId <= -16001 ? -playerId - 16000 : null
}

function ownerFor(teamId) {
  return TEAM_OWNERS[teamId]?.owner ?? null
}

// Turn one raw transaction into a move record, or null when it should not
// appear on the page (other statuses, malformed payloads).
export function mapMove(tx, playerNames) {
  if (!KEPT_STATUSES.has(tx.status)) return null
  const items = Array.isArray(tx.items) ? tx.items : []
  const adds = []
  const drops = []
  // FAAB bids sit on the transaction; totalValue on items is the fallback.
  let bid = Number(tx.bidAmount)
  if (!Number.isFinite(bid) || bid < 0) bid = 0

  for (const item of items) {
    const playerId = item.playerId ?? item.player?.id
    if (!playerId || playerId === -1) continue
    const fallback = [item.firstName, item.lastName].filter(Boolean).join(' ')
    const name = playerNames[`${playerId}`] ?? playerNames[playerId] ?? (fallback || `Player ${playerId}`)
    if (item.type === 'ADD') {
      adds.push(name)
      const value = Number(item.totalValue)
      if (Number.isFinite(value) && value > bid) bid = value
    } else if (item.type === 'DROP') {
      drops.push(name)
    }
  }

  // Waivers with no items are failed or empty claims; skip them.
  if (adds.length === 0 && drops.length === 0) return null

  return {
    id: String(tx.id ?? tx.transactionId),
    date: txDate(tx),
    event: typeof tx.type === 'string' ? tx.type : 'WAIVER',
    status: tx.status,
    teamId: tx.teamId,
    owner: ownerFor(tx.teamId),
    adds,
    drops,
    bid: bid > 0 ? bid : null,
  }
}

export function buildOrder(teams, movesByTeam) {
  const rows = (teams ?? [])
    .filter(t => t && t.id != null)
    .map(t => ({
      rank: t.waiverRank ?? 9999,
      teamId: t.id,
      owner: ownerFor(t.id),
      name: t.name || [t.location, t.nickname].filter(Boolean).join(' ') || `Team ${t.id}`,
      wins: t.record?.overall?.wins ?? null,
      losses: t.record?.overall?.losses ?? null,
      ties: t.record?.overall?.ties ?? null,
      moves: movesByTeam[t.id] ?? 0,
    }))
  rows.sort((a, b) => a.rank - b.rank || a.teamId - b.teamId)
  return rows
}

function loadPlayerCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8'))
    return parsed.players ?? {}
  } catch {
    return {}
  }
}

// Only the current season stays in the cache file.
export function prunePlayers(players, season) {
  const prefix = `${season}:`
  const kept = {}
  for (const [key, value] of Object.entries(players)) if (key.startsWith(prefix)) kept[key] = value
  return kept
}

async function resolvePlayerName(fetchImpl, season, playerId, players) {
  const key = `${season}:${playerId}`
  if (players[key]) return players[key]
  let name
  try {
    const nflTeamId = dslNflTeamId(playerId)
    if (nflTeamId) {
      const teamData = await fetchJson(fetchImpl, `${CORE_BASE}/seasons/${season}/teams/${nflTeamId}`)
      name = `${teamData.displayName || `Team ${nflTeamId}`} D/ST`
    } else {
      const data = await fetchJson(fetchImpl, `${CORE_BASE}/seasons/${season}/athletes/${playerId}`)
      name = data.displayName || data.fullName || `Player ${playerId}`
    }
  } catch {
    name = `Player ${playerId}`
  }
  players[key] = name
  return name
}

async function fetchTeams(fetchImpl, url, env) {
  const data = await fetchJson(fetchImpl, `${url}?view=mTeam`, {
    headers: { Cookie: authCookie(env) },
  })
  return Array.isArray(data.teams) ? data.teams : []
}

async function fetchMovesRaw(fetchImpl, url, env) {
  const filter = { transactions: { filterType: { value: MOVE_TYPES } } }
  const data = await fetchJson(fetchImpl, `${url}?view=mTransactions2`, {
    headers: {
      Cookie: authCookie(env),
      'X-Fantasy-Filter': JSON.stringify(filter),
    },
  })
  return Array.isArray(data.transactions) ? data.transactions : []
}

// Season year: Aug-Dec maps to the current calendar year, Jan-Jul to the
// prior one. Same convention as the power rankings and trade watcher.
export function defaultSeason(now = new Date()) {
  return now.getMonth() + 1 >= 8 ? now.getFullYear() : now.getFullYear() - 1
}

export async function main(argv, fetchImpl = globalThis.fetch, paths = {}) {
  const args = parseArgs(argv)
  const env = resolveConfig()

  // League id and season default like the other generators; cookies are
  // always required because the league is private.
  env.LEAGUE_ID = env.LEAGUE_ID ?? '794521'
  env.LEAGUE_YEAR = String(env.LEAGUE_YEAR ?? defaultSeason())

  const required = ['ESPN_S2', 'SWID']
  for (const key of required) if (!env[key]) throw new Error(`Missing required config: ${key}`)

  const season = Number(env.LEAGUE_YEAR)
  const dataFile = paths.dataFile ?? env.WAIVERS_FILE ?? DATA_FILE
  const players = prunePlayers(loadPlayerCache(), season)

  const url = leagueUrl(env)
  const [teams, raw] = await Promise.all([fetchTeams(fetchImpl, url, env), fetchMovesRaw(fetchImpl, url, env)])

  // Resolve every name first so no move ever shows a "Player N" placeholder.
  const kept = raw.filter(tx => KEPT_STATUSES.has(tx.status))
  const playerIds = new Set()
  for (const tx of kept)
    for (const item of Array.isArray(tx.items) ? tx.items : []) {
      const playerId = item.playerId ?? item.player?.id
      if (playerId && playerId !== -1) playerIds.add(playerId)
    }
  let unresolved = [...playerIds].filter(id => !players[`${season}:${id}`])
  while (unresolved.length > 0) {
    for (const id of unresolved.splice(0, 10)) {
      await resolvePlayerName(fetchImpl, season, id, players)
    }
  }

  const withNames = kept
    .map(tx => mapMove(tx, players))
    .filter(Boolean)
    .sort((a, b) => new Date(b.date ?? 0) - new Date(a.date ?? 0))
    .slice(0, MAX_MOVES)

  const movesByTeam = {}
  for (const move of withNames) {
    if (move.status !== 'EXECUTED') continue
    movesByTeam[move.teamId] = (movesByTeam[move.teamId] ?? 0) + 1
  }

  const order = buildOrder(teams, movesByTeam)

  const output = {
    leagueId: String(env.LEAGUE_ID),
    season,
    updated: new Date().toISOString(),
    order,
    moves: withNames,
  }

  if (args.dryRun) {
    console.log(`[dry-run] season ${season}: ${order.length} teams, ${withNames.length} moves`)
    console.log(JSON.stringify(output, null, 2))
    return 0
  }

  writeJsonAtomic(dataFile, output)
  writeJsonAtomic(PLAYERS_FILE, { season, updated: output.updated, players })
  console.log(
    `Wrote ${dataFile} (${order.length} teams, ${withNames.length} moves); ` +
      `cache holds ${Object.keys(players).length} names for ${season}.`
  )
  return 0
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(e => {
      console.error(e.message)
      process.exit(1)
    })
}
