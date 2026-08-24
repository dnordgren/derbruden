#!/usr/bin/env node
// ESPN fantasy trade watcher. Polls league transactions, posts new trade
// events to Discord, and appends them to static/data/trades.json.
//
// Usage:
//   node scripts/watch-trades.mjs [--dry-run] [--backfill N]
// Config comes from the environment or a .env file at the repo root.
// See .env.example.

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_STATE_FILE = path.join(ROOT, 'data', 'state.json')
const LEDGER_FILE = path.join(ROOT, 'static', 'data', 'trades.json')
const ENV_FILE = path.join(ROOT, '.env')

// Transaction data comes from the read host and needs BOTH espn_s2 and SWID
// from the same login session. The fantasy.espn.com host 302s every request
// now, and lm-api-reads returns transactions only with the full cookie pair.
const LEAGUE_PATH = '/apis/v3/games/ffl/seasons/{year}/segments/0/leagues/{league}'
const DEFAULT_LEAGUE_HOST = 'https://lm-api-reads.fantasy.espn.com'
const PLAYER_URL =
  'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/athletes/{id}'

const TYPE_BY_ID = {
  239: 'TRADE_PROPOSAL',
  244: 'TRADE_ACCEPT',
  245: 'TRADE_DECLINE',
  246: 'TRADE_VETO'
}

const NOTIFY_TYPES_BASE = ['TRADE_PROPOSAL', 'TRADE_ACCEPT']
const NOTIFY_TYPES_EXTRA = ['TRADE_DECLINE', 'TRADE_VETO']
const TRADE_TYPES = new Set([...NOTIFY_TYPES_BASE, ...NOTIFY_TYPES_EXTRA])

const EVENT_TITLES = {
  TRADE_PROPOSAL: 'Trade proposed',
  TRADE_ACCEPT: 'Trade accepted',
  TRADE_DECLINE: 'Trade declined',
  TRADE_VETO: 'Trade vetoed'
}

const EVENT_COLORS = {
  TRADE_PROPOSAL: 0x95a5a6,
  TRADE_ACCEPT: 0x2ecc71,
  TRADE_DECLINE: 0xe74c3c,
  TRADE_VETO: 0xe74c3c
}

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
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

function writeJsonAtomic(file, data) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

const CONFIG_KEYS = [
  'LEAGUE_ID',
  'LEAGUE_YEAR',
  'ESPN_S2',
  'SWID',
  'DISCORD_WEBHOOK_URL',
  'STATE_FILE',
  'NOTIFY_DECLINED',
  'LEAGUE_HOST'
]

function authCookie(env) {
  const parts = []
  if (env.ESPN_S2) parts.push(`espn_s2=${env.ESPN_S2}`)
  if (env.SWID) parts.push(`SWID=${env.SWID}`)
  return parts.join('; ')
}

// Real environment variables win over the .env file.
function resolveConfig() {
  const fromFile = loadEnvFile(ENV_FILE)
  const env = {}
  for (const key of CONFIG_KEYS) env[key] = process.env[key] ?? fromFile[key]
  return env
}

export function parseArgs(argv) {
  const args = { dryRun: false, backfill: null }
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true
    else if (arg.startsWith('--backfill=')) args.backfill = Number(arg.split('=')[1])
    else if (arg === '--backfill') args.backfill = null // value in next arg
    else if (/^\d+$/.test(arg) && argv.includes('--backfill')) args.backfill = Number(arg)
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (args.backfill !== null && (!Number.isInteger(args.backfill) || args.backfill < 1))
    throw new Error('--backfill needs a positive number')
  return args
}

// Keep only unseen events, oldest first. IDs are UUID strings, so seen-state
// is an array, not a high-water mark.
export function newTransactions(transactions, processedIds = []) {
  const seen = new Set(processedIds.map(String))
  return transactions
    .filter((t) => t.id != null && !seen.has(String(t.id)))
    .sort((a, b) => (a.proposedDate ?? a.processDate ?? 0) - (b.proposedDate ?? b.processDate ?? 0))
}

function txType(tx) {
  if (typeof tx.type === 'string') return tx.type
  return TYPE_BY_ID[tx.typeId] ?? null
}

function txDate(tx) {
  const ms = tx.date ?? tx.proposedDate ?? tx.processDate ?? tx.statusDate
  const n = Number(ms)
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null
}

// Group transaction items into per-team sides. A moved player is attributed
// to the team that sends him: directional items use fromTeamId, ADD/DROP
// items use the DROP side. ADD-only legs duplicate a DROP leg, so they are
// skipped. Returns null for non-trade events.
export function mapTransaction(tx, teamNames, playerNames) {
  const type = txType(tx)
  if (!TRADE_TYPES.has(type)) return null

  const items = Array.isArray(tx.items) ? tx.items : []
  const sides = new Map()

  for (const item of items) {
    const playerId = item.playerId ?? item.player?.id
    const joined = [item.firstName, item.lastName].filter(Boolean).join(' ')
    let name
    if (!playerId && item.type === 'DRAFT_TRADE') {
      name = item.overallPickNumber > 0 ? `Draft pick #${item.overallPickNumber}` : 'Draft pick'
    } else if (!playerId) {
      continue
    } else {
      name = playerNames[playerId] || item.player?.fullName || joined || `Player ${playerId}`
    }

    let from = item.fromTeamId
    if (from == null && item.type === 'DROP') from = item.teamId
    if (from != null) pushPlayer(sides, from, name)
  }

  const teams = [...sides.entries()]
    .map(([teamId, players]) => ({
      teamId,
      name: teamNames[teamId] ?? `Team ${teamId}`,
      gives: players
    }))
    .sort((a, b) => a.teamId - b.teamId)

  return {
    id: String(tx.id ?? tx.transactionId),
    event: type,
    date: txDate(tx),
    teams
  }
}

function pushPlayer(sides, teamId, player) {
  const list = sides.get(teamId) ?? []
  list.push(player)
  sides.set(teamId, list)
}

export function buildEmbed(record) {
  const description =
    record.teams.length > 0
      ? record.teams.map((t) => `**${t.name}** sends ${t.gives.join(', ')}`).join('\n')
      : 'Players unknown (payload missing details)'
  return {
    title: EVENT_TITLES[record.event] ?? record.event,
    description,
    color: EVENT_COLORS[record.event] ?? 0x95a5a6,
    timestamp: record.date ?? undefined
  }
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

async function fetchTransactions(fetchImpl, env, notifyTypes) {
  const url =
    (env.LEAGUE_HOST ?? DEFAULT_LEAGUE_HOST) +
    LEAGUE_PATH.replace('{year}', env.LEAGUE_YEAR).replace('{league}', env.LEAGUE_ID)
  const filter = { transactions: { filterType: { value: notifyTypes } } }
  const data = await fetchJson(fetchImpl, `${url}?view=mTransactions2`, {
    headers: {
      Cookie: authCookie(env),
      'X-Fantasy-Filter': JSON.stringify(filter)
    }
  })
  return Array.isArray(data.transactions) ? data.transactions : []
}

async function fetchTeamNames(fetchImpl, env) {
  const url =
    (env.LEAGUE_HOST ?? DEFAULT_LEAGUE_HOST) +
    LEAGUE_PATH.replace('{year}', env.LEAGUE_YEAR).replace('{league}', env.LEAGUE_ID)
  try {
    const data = await fetchJson(fetchImpl, `${url}?view=mTeam`, {
      headers: { Cookie: authCookie(env) }
    })
    const map = {}
    for (const t of data.teams ?? []) {
      map[t.id] = t.name || [t.location, t.nickname].filter(Boolean).join(' ') || `Team ${t.id}`
    }
    return map
  } catch (e) {
    console.warn(`Could not load team names: ${e.message}`)
    return {}
  }
}

async function resolvePlayerNames(fetchImpl, state, playerIds) {
  // Retry placeholder entries so bad lookups heal; drop junk IDs (0 = draft picks).
  for (const [id, value] of Object.entries(state.players))
    if (/^Player \d+$/.test(value) || Number(id) <= 0) delete state.players[id]

  const missing = [...playerIds].filter((id) => id > 0 && !(id in state.players))
  for (const id of missing.slice(0, 25)) {
    try {
      const data = await fetchJson(
        fetchImpl,
        PLAYER_URL.replace('{id}', String(id)),
        {}
      )
      state.players[id] = data.fullName ?? data.displayName ?? `Player ${id}`
    } catch {
      state.players[id] = `Player ${id}`
    }
  }
  return state.players
}

async function postDiscord(fetchImpl, webhookUrl, embed) {
  const res = await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'DerBruden Trades', embeds: [embed] })
  })
  if (res.status === 429) {
    const body = res.headers.get('content-type')?.includes('json') ? await res.json() : {}
    const waitMs = (body.retry_after ?? Number(res.headers.get('retry-after')) ?? 1) * 1000
    await new Promise((r) => setTimeout(r, Math.min(waitMs, 10000)))
    const retry = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'DerBruden Trades', embeds: [embed] })
    })
    if (!retry.ok && retry.status !== 204)
      throw new Error(`Discord retry failed with HTTP ${retry.status}`)
    return
  }
  if (!res.ok && res.status !== 204) throw new Error(`Discord failed with HTTP ${res.status}`)
}

function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    const processedIds = Array.isArray(s.processedIds) ? s.processedIds.map(String) : []
    return { processedIds, players: s.players ?? {} }
  } catch {
    return { processedIds: [], players: {} }
  }
}

function loadLedger(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { leagueId: null, season: null, updated: null, trades: [] }
  }
}

export async function main(argv, fetchImpl = globalThis.fetch, paths = {}) {
  const args = parseArgs(argv)
  if (args.dryRun && args.backfill !== null)
    throw new Error('Use --dry-run or --backfill, not both')
  const env = resolveConfig()

  const required = ['LEAGUE_ID', 'LEAGUE_YEAR', 'ESPN_S2', 'SWID']
  for (const key of required)
    if (!env[key]) throw new Error(`Missing required config: ${key}`)
  if (!args.dryRun && !args.backfill && !env.DISCORD_WEBHOOK_URL)
    throw new Error('Missing required config: DISCORD_WEBHOOK_URL (or use --dry-run)')

  const notifyTypes = env.NOTIFY_DECLINED === 'true'
    ? [...NOTIFY_TYPES_BASE, ...NOTIFY_TYPES_EXTRA]
    : NOTIFY_TYPES_BASE

  const stateFile = paths.stateFile ?? env.STATE_FILE ?? DEFAULT_STATE_FILE
  const ledgerFile = paths.ledgerFile ?? LEDGER_FILE
  const state = loadState(stateFile)
  const ledger = loadLedger(ledgerFile)
  ledger.leagueId = env.LEAGUE_ID
  ledger.season = Number(env.LEAGUE_YEAR)

  const raw = await fetchTransactions(fetchImpl, env, notifyTypes)
  const teamNames = await fetchTeamNames(fetchImpl, env)

  const pending = newTransactions(raw, state.processedIds)
  const mapped = []
  for (const tx of pending) {
    const record = mapTransaction(tx, teamNames, state.players)
    if (record) mapped.push(record)
  }

  const playerIds = new Set()
  for (const tx of pending)
    for (const item of tx.items ?? [])
      if (item.playerId > 0) playerIds.add(item.playerId)
  await resolvePlayerNames(fetchImpl, state, playerIds)
  for (let i = 0; i < mapped.length; i++) {
    const remapped = mapTransaction(pending[i], teamNames, state.players)
    if (remapped) mapped[i] = remapped
  }

  if (args.backfill !== null) {
    const picked = mapped
      .slice(-args.backfill)
      .reverse()
      .filter((record) => !ledger.trades.some((t) => t.id === record.id))
    for (const tx of pending)
      state.processedIds = [...state.processedIds, String(tx.id)].slice(-1000)
    ledger.trades = [...picked, ...ledger.trades].slice(0, 500)
    ledger.updated = new Date().toISOString()
    writeJsonAtomic(ledgerFile, ledger)
    writeJsonAtomic(stateFile, state)
    console.log(`Backfilled ${picked.length} trades. State tracks ${state.processedIds.length} events.`)
    return 0
  }

  if (pending.length === 0) {
    console.log('No new trade events.')
    return 0
  }

  if (args.dryRun) {
    for (const record of mapped)
      console.log(`[dry-run] would post: ${JSON.stringify(buildEmbed(record))}`)
    return 0
  }

  if (state.processedIds.length === 0) {
    // First run: mark everything seen without notifying so restarts never spam.
    state.processedIds = pending.map((tx) => String(tx.id))
    writeJsonAtomic(stateFile, state)
    console.log(
      `Seeded state with ${state.processedIds.length} known events; nothing notified on first run.`
    )
    return 0
  }

  let failures = 0
  for (const record of mapped) {
    if (!ledger.trades.some((t) => t.id === record.id)) {
      ledger.trades.unshift(record)
      ledger.trades = ledger.trades.slice(0, 500)
      ledger.updated = new Date().toISOString()
      writeJsonAtomic(ledgerFile, ledger)
    }
    try {
      await postDiscord(fetchImpl, env.DISCORD_WEBHOOK_URL, buildEmbed(record))
      console.log(`Posted ${record.event} ${record.id} to Discord.`)
    } catch (e) {
      failures++
      console.error(`Discord post failed for ${record.id}: ${e.message}`)
    }
    state.processedIds = [...state.processedIds, String(record.id)].slice(-1000)
    writeJsonAtomic(stateFile, state)
  }

  return failures > 0 ? 1 : 0
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e.message)
      process.exit(1)
    })
}
