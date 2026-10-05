#!/usr/bin/env node
// Trade grades generator. Ranks historical trades by replaying every
// post-trade week with optimal lineups: each side's actual optimal score
// versus a no-trade counterfactual where given players stay and received
// players leave. Draft picks are credited with data-driven round values.
//
// Usage:
//   node scripts/generate-trade-grades.mjs [--offline] [season]
// Seasons cover 2024 on: older ACCEPT legs lost their item detail on ESPN,
// so only trades with surviving terms (or ledger names) grade.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { TEAM_OWNERS } from './team-owners.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const LEAGUE_ID = process.env.FANTASY_LEAGUE_ID || '794521'
const API_BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl'
const CORE_BASE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl'
const USER_AGENT = 'derbruden.com trade grades generator'

const FIRST_SEASON = 2024
const MAX_SCORING_PERIOD = 18
const SEASON_WEEKS = 17
const CONCURRENCY = 4

const CACHE_DIR = path.join(__dirname, '.trade-cache')
const PLAYERS_CACHE_PATH = path.join(__dirname, 'trade-players.json')
const LEDGER_PATH = path.join(__dirname, '../static/data/trades.json')
const DATA_PATH = path.join(__dirname, '../static/data/trade-grades.json')
const PAGE_PATH = path.join(__dirname, '../src/trade-grades.html')

// Lineup slots that start in this league. Counts come from mSettings; the
// ids are ESPN lineupSlotIds: QB 0, RB 2, WR 4, TE 6, D/ST 16, K 17,
// FLEX (RB/WR/TE) 23.
const STARTER_SLOTS = new Set([0, 2, 4, 6, 16, 17, 23])
const SLOT_COUNT_FALLBACK = { 0: 1, 2: 2, 4: 2, 6: 1, 23: 1, 16: 1, 17: 1 }

export function defaultSeason() {
  const now = new Date()
  return now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1
}

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
  return { Cookie: cookie, 'User-Agent': USER_AGENT }
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`ESPN API returned ${res.status} for ${url}`)
  return res.json()
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  async function run() {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index], index)
      await sleep(120)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}

function cacheRead(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, name), 'utf8'))
  } catch {
    return null
  }
}

function cacheWrite(name, data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  fs.writeFileSync(path.join(CACHE_DIR, name), JSON.stringify(data))
}

// ---------------------------------------------------------------------------
// Trade discovery
// ---------------------------------------------------------------------------

// Group raw transaction legs by relatedTransactionId. An accepted trade is
// one TRADE_ACCEPT leg plus one TRADE_UPHOLD leg sharing that id; only the
// legs' teamIds survive on old seasons, the item detail ages out.
export function groupTradeLegs(transactions) {
  const groups = new Map()
  for (const tx of transactions) {
    const key = tx.relatedTransactionId || tx.id
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(tx)
  }
  return groups
}

// Counterparties to a trade: every teamId appearing on ACCEPT or UPHOLD legs.
export function tradeTeams(legs) {
  const teams = new Set()
  for (const leg of legs) {
    if (leg.type !== 'TRADE_ACCEPT' && leg.type !== 'TRADE_UPHOLD') continue
    if (leg.teamId != null) teams.add(leg.teamId)
  }
  return [...teams].sort((a, b) => a - b)
}

// Player/pick assets with direction. TRADE items carry fromTeamId/toTeamId;
// DROP items (old D/ST legs) only name the sender.
export function extractTradeAssets(legs) {
  const assets = []
  for (const leg of legs) {
    for (const item of leg.items || []) {
      if (item.type === 'DRAFT_TRADE') {
        if (!item.overallPickNumber) continue
        assets.push({
          kind: 'pick',
          overallPickNumber: item.overallPickNumber,
          fromTeamId: item.fromTeamId ?? leg.teamId,
          toTeamId: item.toTeamId,
        })
      } else if (item.type === 'TRADE' && item.playerId) {
        assets.push({
          kind: 'player',
          playerId: item.playerId,
          fromTeamId: item.fromTeamId ?? leg.teamId,
          toTeamId: item.toTeamId,
        })
      } else if (item.type === 'DROP' && item.playerId && item.playerId !== -1) {
        assets.push({
          kind: 'player',
          playerId: item.playerId,
          fromTeamId: item.fromTeamId ?? leg.teamId ?? item.teamId,
          toTeamId: item.toTeamId || null,
          partial: true,
        })
      }
    }
  }
  return assets
}

// A trade grades only when every asset has a known destination side.
export function tradeSides(teamIds, assets) {
  const sides = teamIds.map(teamId => ({ teamId, gives: [], receives: [] }))
  const byId = new Map(sides.map(s => [s.teamId, s]))
  for (const a of assets) {
    const from = byId.get(a.fromTeamId)
    const to = a.toTeamId != null ? byId.get(a.toTeamId) : null
    if (!from || (a.kind === 'player' && !a.partial && !to)) return null
    from.gives.push(a)
    if (to) to.receives.push(a)
    else from.receives.push({ ...a, unknownDestination: true })
  }
  return sides
}

async function fetchSeasonTransactions(season) {
  const filter = { transactions: { filterType: { value: ['TRADE_ACCEPT', 'TRADE_UPHOLD'] } } }
  const headers = { ...authHeaders(), 'X-Fantasy-Filter': JSON.stringify(filter) }
  const weeks = Array.from({ length: MAX_SCORING_PERIOD }, (_, i) => i + 1)
  const perWeek = await mapLimit(weeks, CONCURRENCY, async sp => {
    const cached = cacheRead(`tx-${season}-sp-${sp}.json`)
    if (cached) return cached
    const url = `${API_BASE}/seasons/${season}/segments/0/leagues/${LEAGUE_ID}?view=mTransactions2&scoringPeriodId=${sp}`
    const data = await fetchJson(url, headers)
    const tx = Array.isArray(data.transactions) ? data.transactions : []
    cacheWrite(`tx-${season}-sp-${sp}.json`, tx)
    return tx
  })
  return perWeek.flat()
}

async function fetchTeamNames(season) {
  const cached = cacheRead(`teams-${season}.json`)
  if (cached) return cached
  const url = `${API_BASE}/seasons/${season}/segments/0/leagues/${LEAGUE_ID}?view=mTeam`
  const data = await fetchJson(url, authHeaders())
  const map = {}
  for (const t of data.teams || []) {
    map[t.id] = t.name || [t.location, t.nickname].filter(Boolean).join(' ') || `Team ${t.id}`
  }
  cacheWrite(`teams-${season}.json`, map)
  return map
}

async function fetchSettings(season) {
  const cached = cacheRead(`settings-${season}.json`)
  if (cached) return cached
  const url = `${API_BASE}/seasons/${season}/segments/0/leagues/${LEAGUE_ID}?view=mSettings`
  const data = await fetchJson(url, authHeaders())
  const counts = data.settings?.rosterSettings?.lineupSlotCounts || null
  cacheWrite(`settings-${season}.json`, counts)
  return counts
}

export function starterSlotList(slotCounts) {
  const counts = slotCounts || SLOT_COUNT_FALLBACK
  const slots = []
  for (const slot of STARTER_SLOTS) {
    const n = Number(counts[slot] ?? counts[String(slot)] ?? 0)
    for (let i = 0; i < n; i++) slots.push(slot)
  }
  return slots
}

// ---------------------------------------------------------------------------
// Weekly rosters and scores
// ---------------------------------------------------------------------------

async function fetchRoster(season, scoringPeriod) {
  const cached = cacheRead(`roster-${season}-sp-${scoringPeriod}.json`)
  if (cached) return cached
  const url = `${API_BASE}/seasons/${season}/segments/0/leagues/${LEAGUE_ID}?view=mRoster&scoringPeriodId=${scoringPeriod}`
  const data = await fetchJson(url, authHeaders())
  cacheWrite(`roster-${season}-sp-${scoringPeriod}.json`, data)
  return data
}

async function fetchSchedule(season) {
  const cached = cacheRead(`schedule-${season}.json`)
  if (cached) return cached
  const url = `${API_BASE}/seasons/${season}/segments/0/leagues/${LEAGUE_ID}?view=mMatchupScore`
  const data = await fetchJson(url, authHeaders())
  cacheWrite(`schedule-${season}.json`, data)
  return data
}

// Decided weeks (regular season and playoffs) with official scores.
export function extractDecidedWeeks(league, season) {
  const weeks = []
  for (const m of league.schedule || []) {
    const { home, away } = m
    if (!home || !away || typeof home.totalPoints !== 'number' || typeof away.totalPoints !== 'number') continue
    const winner = String(m.winner || '').toLowerCase()
    if (!['home', 'away', 'tie'].includes(winner)) continue
    if (winner !== 'tie' && home.totalPoints === 0 && away.totalPoints === 0) continue
    weeks.push({
      season,
      week: m.matchupPeriodId,
      homeId: home.teamId,
      awayId: away.teamId,
      homeScore: home.totalPoints,
      awayScore: away.totalPoints,
      winner,
    })
  }
  return weeks.sort((a, b) => a.week - b.week)
}

// Unique sorted weeks with decided games. `decided` holds one entry per
// matchup (five per week), so grade windows must dedupe or every week
// counts five times.
export function uniqueWeeksAfter(decided, execWeek, maxWeek) {
  return [...new Set(decided.map(d => d.week))].filter(w => w > execWeek && w <= maxWeek).sort((a, b) => a - b)
}

export function weekScoreOf(player, week) {
  const split = (player.stats || []).find(
    s => s.statSourceId === 0 && s.statSplitTypeId === 1 && s.scoringPeriodId === week
  )
  return split ? Number(split.appliedTotal) || 0 : null
}

export function seasonTotalOf(player, season) {
  const split = (player.stats || []).find(s => s.statSourceId === 0 && s.statSplitTypeId === 0 && s.seasonId === season)
  return split ? Number(split.appliedTotal) || 0 : null
}

// Per-team weekly roster: every rostered player with that week's actual
// score and the starter slots he can fill.
export function rosterWeek(league, week) {
  const out = {}
  for (const t of league.teams || []) {
    const entries = []
    for (const e of t.roster?.entries || []) {
      const player = e.playerPoolEntry?.player
      if (!player) continue
      const points = weekScoreOf(player, week)
      if (points == null) continue
      const elig = (player.eligibleSlots || []).filter(s => STARTER_SLOTS.has(s))
      entries.push({ playerId: e.playerId, points, elig })
    }
    out[t.id] = entries
  }
  return out
}

// Global per-week score + eligibility lookup for traded players, wherever
// they are rostered that week.
export function playerWeekIndex(league, week, index = new Map()) {
  for (const t of league.teams || []) {
    for (const e of t.roster?.entries || []) {
      const player = e.playerPoolEntry?.player
      if (!player) continue
      const points = weekScoreOf(player, week)
      if (points == null) continue
      const key = `${week}:${e.playerId}`
      if (!index.has(key)) {
        index.set(key, {
          points,
          elig: (player.eligibleSlots || []).filter(s => STARTER_SLOTS.has(s)),
          name: player.fullName || `Player ${e.playerId}`,
        })
      }
    }
  }
  return index
}

// ---------------------------------------------------------------------------
// Optimal lineup
// ---------------------------------------------------------------------------

// Best achievable starter total from a pool of {id, points, elig[]}.
// Backtracking over at most ~9 starter slots; empty slots score 0.
export function optimalLineup(pool, slots) {
  const sorted = [...pool].sort((a, b) => b.points - a.points)
  const used = new Array(slots.length).fill(false)
  let best = 0
  // Prefix sums of sorted points bound the best any suffix can add.
  const prefix = [0]
  for (const p of sorted) prefix.push(prefix[prefix.length - 1] + Math.max(0, p.points))
  function bound(i, total) {
    const remainingSlots = used.filter(u => !u).length
    return total + (prefix[Math.min(i + remainingSlots, sorted.length)] - prefix[i])
  }
  function search(i, total) {
    if (i >= sorted.length) {
      if (total > best) best = total
      return
    }
    if (bound(i, total) <= best) return
    const p = sorted[i]
    for (let s = 0; s < slots.length; s++) {
      if (!used[s] && p.elig.includes(slots[s])) {
        used[s] = true
        search(i + 1, total + p.points)
        used[s] = false
      }
    }
    search(i + 1, total)
  }
  search(0, 0)
  return Math.round(best * 100) / 100
}

// ---------------------------------------------------------------------------
// Draft pick valuation
// ---------------------------------------------------------------------------

export function roundOfPick(overallPickNumber, teamsPerRound = 10) {
  return Math.max(1, Math.ceil(overallPickNumber / teamsPerRound))
}

// Decreasing isotonic regression (pool adjacent violators): later draft
// rounds are worth no more than earlier ones.
export function isotonizeDecreasing(values) {
  const blocks = values.map(v => ({ sum: v, count: 1 }))
  const out = []
  for (const b of blocks) {
    out.push(b)
    while (out.length >= 2) {
      const n = out.length
      const a = out[n - 2]
      const c = out[n - 1]
      if (a.sum / a.count >= c.sum / c.count) break
      out.splice(n - 2, 2, { sum: a.sum + c.sum, count: a.count + c.count })
    }
  }
  const fitted = []
  for (const b of out) {
    const mean = b.sum / b.count
    for (let i = 0; i < b.count; i++) fitted.push(mean)
  }
  return fitted
}

function median(values) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// Weekly pick value per round: smoothed round-mean season total minus the
// median drafted-player total (replacement level), spread over a season.
export function computePickValues(roundTotals) {
  const rounds = [...roundTotals.keys()].sort((a, b) => a - b)
  const means = rounds.map(r => {
    const vals = roundTotals.get(r)
    return vals.reduce((a, b) => a + b, 0) / vals.length
  })
  const fitted = isotonizeDecreasing(means)
  const all = [...roundTotals.values()].flat()
  const replacement = median(all)
  const perRound = {}
  rounds.forEach((r, i) => {
    perRound[r] = Math.max(0, Math.round(((fitted[i] - replacement) / SEASON_WEEKS) * 10) / 10)
  })
  return { perRound, replacement: Math.round(replacement * 10) / 10, rounds }
}

async function fetchDraftPicks(season) {
  const cached = cacheRead(`draft-${season}.json`)
  if (cached) return cached
  const url = `${API_BASE}/seasons/${season}/segments/0/leagues/${LEAGUE_ID}?view=mDraftDetail`
  const data = await fetchJson(url, authHeaders())
  const picks = ((data.draftDetail && data.draftDetail.picks) || []).filter(p => p.playerId && p.playerId !== -1)
  cacheWrite(`draft-${season}.json`, picks)
  return picks
}

// ---------------------------------------------------------------------------
// Player names
// ---------------------------------------------------------------------------

function loadPlayersCache() {
  try {
    return JSON.parse(fs.readFileSync(PLAYERS_CACHE_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function cleanPosition(pos) {
  const known = ['QB', 'RB', 'WR', 'TE', 'K', 'D/ST']
  return known.includes(pos) ? pos : 'Unknown'
}

async function resolvePlayerName(season, playerId, cache) {
  const key = `${season}:${playerId}`
  if (cache[key]) return cache[key]
  let info
  if (playerId <= -16001) {
    const data = await fetchJson(`${CORE_BASE}/seasons/${season}/teams/${-playerId - 16000}`)
    info = { name: `${data.displayName || 'Team'} D/ST`, pos: 'D/ST' }
  } else {
    const data = await fetchJson(`${CORE_BASE}/seasons/${season}/athletes/${playerId}`)
    info = {
      name: data.displayName || data.fullName || `Player ${playerId}`,
      pos: cleanPosition(data.position && data.position.abbreviation),
    }
    if (!info.name || info.name.startsWith('Player ')) {
      try {
        const base = await fetchJson(`${CORE_BASE}/athletes/${playerId}`)
        info.name = base.displayName || base.fullName || info.name
      } catch {
        // keep placeholder
      }
    }
  }
  cache[key] = info
  await sleep(80)
  return info
}

// Resolve ledger-only names ("Daniel Jones", "Draft pick #67") to assets by
// matching full names across the season's roster snapshots.
export function resolveLedgerGives(names, nameIndex) {
  const assets = []
  const unresolved = []
  for (const name of names) {
    const pickMatch = String(name).match(/draft pick #(\d+)/i)
    if (pickMatch) {
      assets.push({ kind: 'pick', overallPickNumber: Number(pickMatch[1]), name })
      continue
    }
    const hits = nameIndex.get(String(name).toLowerCase()) || []
    if (hits.length === 1) {
      assets.push({ kind: 'player', playerId: hits[0].playerId, name: hits[0].name })
    } else {
      unresolved.push(name)
    }
  }
  return { assets, unresolved }
}

export function ownerOf(teamId) {
  return TEAM_OWNERS[teamId]?.owner ?? `Team ${teamId}`
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

export function gradeTradeSides({ sides, rostersByWeek, scoreIndex, gradedWeeks, schedule, slots, pickValues }) {
  const results = []
  let incomplete = false
  for (const side of sides) {
    let gained = 0
    let pickCredit = 0
    let winsFlippedFor = 0
    let winsFlippedAgainst = 0
    const weekly = []
    const receivedIds = new Set(side.receives.filter(a => a.kind === 'player').map(a => a.playerId))
    for (const week of gradedWeeks) {
      const pool = rostersByWeek[week]?.[side.teamId] || []
      const actual = optimalLineup(
        pool.map(p => ({ id: p.playerId, points: p.points, elig: p.elig })),
        slots
      )
      const counterPool = []
      for (const p of pool) {
        if (receivedIds.has(p.playerId)) continue
        counterPool.push({ id: p.playerId, points: p.points, elig: p.elig })
      }
      for (const a of side.gives.filter(x => x.kind === 'player')) {
        const rec = scoreIndex.get(`${week}:${a.playerId}`)
        if (!rec) {
          incomplete = true
          continue
        }
        counterPool.push({ id: a.playerId, points: rec.points, elig: rec.elig })
      }
      const counter = optimalLineup(counterPool, slots)
      const delta = Math.round((actual - counter) * 100) / 100
      gained += delta
      const game = schedule.find(g => g.week === week && (g.homeId === side.teamId || g.awayId === side.teamId))
      let flip = null
      if (game) {
        const isHome = game.homeId === side.teamId
        const official = isHome ? game.homeScore : game.awayScore
        const opp = isHome ? game.awayScore : game.homeScore
        const cf = official - actual + counter
        const wonOfficial = official > opp
        const tiedOfficial = official === opp
        const wonCf = cf > opp
        const tiedCf = cf === opp
        if (!tiedOfficial && !tiedCf && wonOfficial !== wonCf) {
          flip = wonCf ? 'for' : 'against'
          if (wonCf) winsFlippedFor++
          else winsFlippedAgainst++
        }
      }
      weekly.push({ week, actual, counter, delta, flip })
    }
    for (const a of side.receives.filter(x => x.kind === 'pick')) {
      const round = roundOfPick(a.overallPickNumber)
      const perWeek = pickValues.perRound[round] ?? 0
      pickCredit += perWeek * gradedWeeks.length
    }
    pickCredit = Math.round(pickCredit * 10) / 10
    gained = Math.round((gained + pickCredit) * 10) / 10
    results.push({
      teamId: side.teamId,
      owner: ownerOf(side.teamId),
      gives: side.gives,
      receives: side.receives,
      gained,
      pickCredit,
      winsFlippedFor,
      winsFlippedAgainst,
      weekly,
    })
  }
  return { sides: results, incomplete }
}

// ---------------------------------------------------------------------------
// Trade assembly from API legs + ledger
// ---------------------------------------------------------------------------

export function assembleApiTrades(allLegs, teamNames) {
  const trades = []
  for (const [key, legs] of groupTradeLegs(allLegs)) {
    const acceptLegs = legs.filter(l => l.type === 'TRADE_ACCEPT')
    if (!acceptLegs.length) continue
    const teamIds = tradeTeams(legs)
    if (teamIds.length < 2) continue
    const assets = extractTradeAssets(legs)
    if (!assets.length) continue
    const sides = tradeSides(teamIds, assets)
    if (!sides) continue
    const execWeek = Math.min(...legs.map(l => Number(l.scoringPeriodId) || 0))
    const dateMs = Math.min(...acceptLegs.map(l => Number(l.date ?? l.proposedDate ?? l.processDate ?? 0) || 0))
    trades.push({
      id: acceptLegs[0].id,
      season: null,
      date: dateMs ? new Date(dateMs).toISOString() : null,
      execWeek,
      teamNames,
      sides: sides.map(s => ({ teamId: s.teamId, gives: s.gives, receives: s.receives })),
      source: 'espn',
      related: key,
    })
  }
  return trades
}

export function mergeLedgerTrades(trades, ledger, nameIndex, season) {
  const byId = new Map(trades.map(t => [t.id, t]))
  for (const entry of ledger.trades || []) {
    if (byId.has(entry.id)) continue
    if (entry.event && entry.event !== 'TRADE_ACCEPT') continue
    const teamIds = (entry.teams || []).map(t => t.teamId).filter(v => v != null)
    if (teamIds.length < 2) continue
    const sides = []
    let unresolved = []
    for (const team of entry.teams) {
      // Prefer watcher-recorded asset ids; fall back to name resolution.
      let assets
      if (Array.isArray(team.assets) && team.assets.length) {
        assets = []
        for (const a of team.assets) {
          if (a.overallPickNumber) {
            assets.push({ kind: 'pick', overallPickNumber: a.overallPickNumber, name: a.name })
          } else if (a.playerId) {
            assets.push({ kind: 'player', playerId: a.playerId, name: a.name })
          } else {
            unresolved.push(a.name || 'unknown asset')
          }
        }
      } else {
        const resolved = resolveLedgerGives(team.gives || [], nameIndex)
        assets = resolved.assets
        unresolved = unresolved.concat(resolved.unresolved)
      }
      sides.push({ teamId: team.teamId, gives: assets, receives: [] })
    }
    // Attribute destinations. Only two-sided ledger deals get exact
    // receives; anything bigger grades with gives only and a flag.
    const twoSided = sides.length === 2
    for (const side of sides) {
      if (twoSided) {
        for (const other of sides) {
          if (other === side) continue
          for (const a of other.gives) {
            side.receives.push({ ...a, fromTeamId: other.teamId, toTeamId: side.teamId })
          }
        }
      }
      for (const a of side.gives) {
        a.fromTeamId = side.teamId
        if (twoSided) {
          const other = sides.find(s => s !== side)
          a.toTeamId = other.teamId
        }
      }
    }
    if (!twoSided) unresolved = unresolved.concat(['multi-team deal: receives unattributed'])
    trades.push({
      id: entry.id,
      season,
      date: entry.date || null,
      execWeek: 0,
      teamNames: Object.fromEntries((entry.teams || []).map(t => [t.teamId, t.name])),
      sides,
      source: 'ledger',
      unresolved,
    })
  }
  return trades
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmt(n) {
  const r = Math.round(n * 10) / 10
  return (r > 0 ? '+' : '') + (Number.isInteger(r) ? String(r) : r.toFixed(1))
}

function assetLabel(a, names) {
  if (a.kind === 'pick') return `Pick #${a.overallPickNumber} (R${roundOfPick(a.overallPickNumber)})`
  return names?.[`${a.playerId}`] || a.name || `Player ${a.playerId}`
}

function ownerLink(owner) {
  const mapped = Object.values(TEAM_OWNERS).find(m => m.owner === owner)
  return mapped ? `<a href="./${mapped.page}">${escapeHtml(owner)}</a>` : escapeHtml(owner)
}

export function renderGradesTable(trades, names) {
  if (!trades.length) return '<p class="section-note">No graded trades yet.</p>'
  const body = trades
    .map((t, i) => {
      const [a, b] = t.sides
      const net = Math.round((a.gained - (b ? b.gained : 0)) * 10) / 10
      const winner = !b || a.gained >= b.gained ? a : b
      const loser = !b || a.gained >= b.gained ? b : a
      const flipLabel = s =>
        s.winsFlippedFor || s.winsFlippedAgainst ? `${s.winsFlippedFor}F/${s.winsFlippedAgainst}A` : '—'
      const detail = t.sides
        .map(
          s =>
            `<strong>${escapeHtml(s.owner)}</strong> sends ` +
            (s.gives.length
              ? s.gives.map(g => escapeHtml(assetLabel(g, names))).join(', ')
              : '<em>nothing tracked</em>')
        )
        .join('<br>')
      return `<tr>
        <td class="number">${i + 1}</td>
        <td class="number">${t.season}</td>
        <td>${escapeHtml(t.date ? t.date.slice(0, 10) : '')}</td>
        <td><strong>${ownerLink(winner.owner)}</strong><br><span class="muted">beats ${loser ? escapeHtml(loser.owner) : '—'}</span></td>
        <td class="number"><strong>${fmt(net)}</strong></td>
        <td class="number">${fmt(a.gained)}${b ? `<br><span class="muted">${fmt(b.gained)}</span>` : ''}</td>
        <td class="number">${flipLabel(a)}${b ? `<br><span class="muted">${flipLabel(b)}</span>` : ''}</td>
        <td class="detail">${detail}${t.incomplete ? '<br><span class="muted">Partial data: a moved player has no recorded score in some weeks.</span>' : ''}</td>
      </tr>`
    })
    .join('\n')
  return `<div class="table-container" tabindex="0"><table class="stats-table">
    <caption class="visually-hidden">Trade grades ranked by net optimal points</caption>
    <thead>
      <tr><th scope="col" class="number">#</th><th scope="col" class="number">Season</th><th scope="col">Date</th><th scope="col">Winner</th><th scope="col" class="number">Net pts</th><th scope="col" class="number">Gained</th><th scope="col" class="number">Wins flip</th><th scope="col" class="detail">Terms</th></tr>
    </thead>
    <tbody>
${body}
    </tbody>
  </table></div>`
}

export function renderPickTable(pickValues) {
  const rows = pickValues.rounds
    .map(
      r => `<tr><td class="number">Round ${r}</td><td class="number">${pickValues.perRound[r].toFixed(1)}/wk</td></tr>`
    )
    .join('\n')
  return `<div class="table-container" tabindex="0"><table class="stats-table pick-values">
    <caption class="visually-hidden">Draft pick values per week</caption>
    <thead><tr><th scope="col" class="number">Pick round</th><th scope="col" class="number">Credit</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`
}

export function renderPageContent(data) {
  const json = JSON.stringify(data).replace(/<\//g, '<\\/')
  return `<h2>Ranked trades</h2>
<p class="section-note">Net optimal points for the winning side, regular season and playoffs after the trade. Gained shows each side's points versus the no-trade world; wins flip counts head-to-head results that would change (for/against).</p>
<p class="section-note"><label for="grades-season-select">Season: </label><select id="grades-season-select"><option value="all">All seasons</option>${data.seasons.map(s => `<option value="${s}">${s}</option>`).join('')}</select></p>
<div id="grades-table-wrap">
${renderGradesTable(data.trades, data.playerNames)}
</div>
<h2>Draft pick values</h2>
<p class="section-note">A traded pick credits its new owner every graded week. Values come from 2024–2025 drafts: mean season points by round, smoothed so later rounds never outrank earlier ones, minus the median drafted player (replacement level), spread over a ${SEASON_WEEKS}-week season.</p>
${renderPickTable(data.pickValues)}
<script type="application/json" id="trade-grades-data">${json}</script>
<script>
;(function () {
  const data = JSON.parse(document.getElementById('trade-grades-data').textContent)
  const select = document.getElementById('grades-season-select')
  const wrap = document.getElementById('grades-table-wrap')
  const names = data.playerNames
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const fmtN = n => { const r = Math.round(n * 10) / 10; return (r > 0 ? '+' : '') + (Number.isInteger(r) ? String(r) : r.toFixed(1)) }
  select.addEventListener('change', () => {
    const v = select.value
    const rows = data.trades.filter(t => v === 'all' || String(t.season) === v)
    if (!rows.length) { wrap.innerHTML = '<p class="section-note">No graded trades for this season.</p>'; return }
    wrap.innerHTML = '<div class="table-container" tabindex="0"><table class="stats-table"><caption class="visually-hidden">Trade grades</caption><thead><tr><th scope="col" class="number">#</th><th scope="col" class="number">Season</th><th scope="col">Date</th><th scope="col">Winner</th><th scope="col" class="number">Net pts</th><th scope="col" class="number">Gained</th><th scope="col" class="number">Wins flip</th><th scope="col" class="detail">Terms</th></tr></thead><tbody>' +
      rows.map((t, i) => {
        const a = t.sides[0], b = t.sides[1]
        const net = Math.round((a.gained - (b ? b.gained : 0)) * 10) / 10
        const winner = !b || a.gained >= b.gained ? a : b
        const loser = !b || a.gained >= b.gained ? b : a
        const flip = s => (s.winsFlippedFor || s.winsFlippedAgainst) ? (s.winsFlippedFor + 'F/' + s.winsFlippedAgainst + 'A') : '—'
        const label = g => g.kind === 'pick' ? 'Pick #' + g.overallPickNumber + ' (R' + Math.ceil(g.overallPickNumber / 10) + ')' : esc(names[g.playerId] || g.name || ('Player ' + g.playerId))
        const detail = t.sides.map(s => '<strong>' + esc(s.owner) + '</strong> sends ' + (s.gives.length ? s.gives.map(label).join(', ') : '<em>nothing tracked</em>')).join('<br>')
        return '<tr><td class="number">' + (i + 1) + '</td><td class="number">' + t.season + '</td><td>' + esc((t.date || '').slice(0, 10)) + '</td><td><strong>' + esc(winner.owner) + '</strong><br><span class="muted">beats ' + (loser ? esc(loser.owner) : '—') + '</span></td><td class="number"><strong>' + fmtN(net) + '</strong></td><td class="number">' + fmtN(a.gained) + (b ? '<br><span class="muted">' + fmtN(b.gained) + '</span>' : '') + '</td><td class="number">' + flip(a) + (b ? '<br><span class="muted">' + flip(b) + '</span>' : '') + '</td><td class="detail">' + detail + '</td></tr>'
      }).join('') + '</tbody></table></div>'
  })
})()
</script>`
}

const START = '<!-- TRADE_GRADES_START -->'
const END = '<!-- TRADE_GRADES_END -->'

export function upsertGradesPage(contentHtml, pagePath = PAGE_PATH) {
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
  <title>DerBruden.com | Trade Grades</title>
  <meta property="og:title" content="DerBruden.com | Trade Grades">
  <meta property="og:description" content="Every graded trade in Der Bruden fantasy football history, replayed week by week with optimal lineups: who won, who lost, and by how much.">
  <meta property="og:url" content="https://derbruden.com/trade-grades.html">
  <meta property="og:image" content="https://derbruden.com/static/img/league-logo.webp?v=1">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="DerBruden.com | Trade Grades">
  <meta name="twitter:description" content="Trade grades for the Der Bruden fantasy football league: optimal-lineup replays of every deal.">
  <meta name="twitter:image" content="https://derbruden.com/static/img/league-logo.webp?v=1">
  <!--#include file="partials/head-common.html" -->
  <style>
    .section-note {
      color: var(--muted);
      font-size: 0.9em;
    }

    h2 {
      margin-top: 40px;
    }

    .stats-table .detail {
      color: var(--muted);
      font-size: 0.95em;
    }

    .stats-table td.owner {
      font-weight: 500;
      white-space: nowrap;
    }

    .stats-table .muted {
      color: var(--muted);
    }

    .stats-table.pick-values {
      min-width: 0;
      max-width: 420px;
    }

    select {
      font-size: 0.95em;
      padding: 4px 8px;
    }

    .methodology {
      margin-top: 30px;
      font-size: 0.85em;
      color: var(--muted);
    }

    .methodology code {
      background: var(--code-bg, #f4f4f4);
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
      <img src="../static/img/league-logo.webp?v=1" alt="DB Logo" class="owner-logo-image" width="100" height="100">
      <h1>Trade Grades</h1>
    </div>
    <!-- TRADE_GRADES_START -->
${content}
<!-- TRADE_GRADES_END -->
    <details class="methodology">
      <summary>How these grades work</summary>
      <p><strong>Window:</strong> every decided week after the trade executes, regular season and playoffs. Preseason deals grade from week 1.</p>
      <p><strong>Points:</strong> each week, each side's actual roster is scored with its optimal lineup (best starters at QB, 2 RB, 2 WR, TE, FLEX, D/ST, K). The counterfactual swaps the deal back: received players leave, given players return at their actual weekly scores. Gained is actual minus counterfactual, summed over the window.</p>
      <p><strong>Wins flip:</strong> the official head-to-head result stands unless swapping actual for counterfactual team points changes it. Manager start/sit skill is held constant; only the trade effect moves.</p>
      <p><strong>Picks:</strong> a traded draft pick credits its new owner every graded week at the round value above.</p>
      <p><strong>Limits:</strong> ESPN drops old transaction detail, so only trades with surviving terms grade. Regenerate with <code>make trade-grades</code>.</p>
    </details>
  </main>

  <!--#include file="partials/footer.html" -->
</body>

</html>
`
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const offline = process.argv.includes('--offline')
  if (!offline) loadEnvFile()
  authHeaders()
  const seasonArg = process.argv.slice(2).find(a => /^\d{4}$/.test(a))
  const current = Number(seasonArg) || defaultSeason()
  const seasons = []
  for (let s = Math.min(current, defaultSeason()); s >= FIRST_SEASON; s--) seasons.push(s)

  const playersCache = loadPlayersCache()
  const data = {
    generated: new Date().toISOString().slice(0, 10),
    leagueId: LEAGUE_ID,
    seasons: [...seasons].sort((a, b) => a - b),
    scopeNote:
      'Optimal-lineup replay of graded trades, 2024 on. Window covers every decided week after execution, regular season and playoffs.',
    pickValues: null,
    playerNames: {},
    trades: [],
  }

  // Draft pick calibration from completed seasons.
  const roundTotals = new Map()
  for (const season of seasons) {
    if (season >= current) continue
    try {
      const picks = await fetchDraftPicks(season)
      const latest =
        cacheRead(`roster-${season}-sp-${MAX_SCORING_PERIOD}.json`) || (await fetchRoster(season, MAX_SCORING_PERIOD))
      const totals = new Map()
      for (const t of latest.teams || []) {
        for (const e of t.roster?.entries || []) {
          const total = seasonTotalOf(e.playerPoolEntry?.player || {}, season)
          if (total != null) totals.set(e.playerId, total)
        }
      }
      let missing = 0
      for (const p of picks) {
        if (!totals.has(p.playerId)) {
          missing++
          continue
        }
        const round = roundOfPick(p.overallPickNumber)
        if (!roundTotals.has(round)) roundTotals.set(round, [])
        roundTotals.get(round).push(totals.get(p.playerId))
      }
      console.log(`Season ${season} draft: ${picks.length} picks, ${missing} without season totals`)
    } catch (err) {
      console.warn(`Skipping pick calibration for ${season}: ${err.message}`)
    }
  }
  const pickValues = computePickValues(roundTotals)
  data.pickValues = pickValues
  console.log('Pick values per week:', JSON.stringify(pickValues.perRound))

  for (const season of seasons) {
    console.log(`--- Season ${season} ---`)
    const [teamNames, slotCounts, schedule] = await Promise.all([
      fetchTeamNames(season),
      fetchSettings(season),
      fetchSchedule(season),
    ])
    const slots = starterSlotList(slotCounts)
    const decided = extractDecidedWeeks(schedule, season)
    console.log(`Season ${season}: ${new Set(decided.map(d => d.week)).size} decided weeks, slots [${slots.join(',')}]`)
    if (!decided.length) continue
    const maxWeek = Math.max(...decided.map(d => d.week))

    const legs = await fetchSeasonTransactions(season)
    const trades = assembleApiTrades(legs, teamNames)
    for (const t of trades) t.season = season
    console.log(`Season ${season}: ${legs.length} legs, ${trades.length} API trades with terms`)

    // Roster weeks needed: everything after the earliest execution week.
    const minExec = trades.length ? Math.min(...trades.map(t => t.execWeek)) : 0
    const firstWeek = Math.max(1, minExec + 1)
    const rosterWeeks = decided.map(d => d.week).filter(w => w >= firstWeek && w <= maxWeek)
    const rostersByWeek = {}
    const scoreIndex = new Map()
    const nameIndex = new Map()
    await mapLimit(
      [...new Set(rosterWeeks)].sort((a, b) => a - b),
      CONCURRENCY,
      async week => {
        const league = await fetchRoster(season, week)
        rostersByWeek[week] = rosterWeek(league, week)
        playerWeekIndex(league, week, scoreIndex)
        for (const t of league.teams || []) {
          for (const e of t.roster?.entries || []) {
            const name = e.playerPoolEntry?.player?.fullName
            if (!name) continue
            const key = name.toLowerCase()
            if (!nameIndex.has(key)) nameIndex.set(key, [])
            if (!nameIndex.get(key).some(h => h.playerId === e.playerId)) {
              nameIndex.get(key).push({ playerId: e.playerId, name })
            }
          }
        }
      }
    )

    // Ledger names for anything the API no longer details (preseason deals).
    try {
      const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'))
      if (Number(ledger.season) === season) mergeLedgerTrades(trades, ledger, nameIndex, season)
    } catch (err) {
      console.warn(`Ledger merge skipped: ${err.message}`)
    }

    for (const trade of trades) {
      const gradedWeeks = uniqueWeeksAfter(decided, trade.execWeek, maxWeek)
      if (!gradedWeeks.length) {
        console.log(`Trade ${trade.id.slice(0, 8)}: no decided weeks after execution; skipped`)
        continue
      }
      // Resolve display names for every traded player.
      for (const side of trade.sides) {
        for (const asset of [...side.gives, ...side.receives]) {
          if (asset.kind !== 'player' || data.playerNames[asset.playerId]) continue
          const info = await resolvePlayerName(season, asset.playerId, playersCache)
          data.playerNames[asset.playerId] = info.name
        }
      }
      const { sides, incomplete } = gradeTradeSides({
        sides: trade.sides,
        rostersByWeek,
        scoreIndex,
        gradedWeeks,
        schedule: decided,
        slots,
        pickValues,
      })
      const net = sides.length > 1 ? Math.round((sides[0].gained - sides[1].gained) * 10) / 10 : sides[0].gained
      data.trades.push({
        id: trade.id,
        season,
        date: trade.date,
        execWeek: trade.execWeek,
        gradedWeeks,
        source: trade.source,
        incomplete: incomplete || (trade.unresolved && trade.unresolved.length > 0),
        unresolved: trade.unresolved || [],
        net,
        sides: sides.map(s => ({
          ...s,
          team: trade.teamNames[s.teamId] || teamNames[s.teamId] || `Team ${s.teamId}`,
          gives: s.gives.map(a => ({ ...a })),
          receives: s.receives.map(a => ({ ...a })),
        })),
      })
      console.log(
        `Trade ${trade.id.slice(0, 8)} (${trade.source}): ` +
          sides.map(s => `${s.owner} ${s.gained >= 0 ? '+' : ''}${s.gained}`).join(' vs ')
      )
    }
  }

  data.trades.sort((a, b) => Math.abs(b.net) - Math.abs(a.net))

  fs.writeFileSync(PLAYERS_CACHE_PATH, JSON.stringify(playersCache, null, 2) + '\n')
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true })
  const out = {
    ...data,
    trades: data.trades.map(t => ({
      ...t,
      sides: t.sides.map(s => ({ ...s, weekly: undefined })),
    })),
  }
  fs.writeFileSync(DATA_PATH, JSON.stringify(out, null, 2) + '\n')
  console.log(`Wrote ${DATA_PATH}`)
  upsertGradesPage(renderPageContent(out))
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch(err => {
    console.error(err.message)
    process.exit(1)
  })
}
