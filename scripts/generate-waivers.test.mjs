import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dslNflTeamId, mapMove, buildOrder, prunePlayers, parseArgs, defaultSeason, mergeMoves, main } from './generate-waivers.mjs'

test('defaultSeason maps Aug-Dec to the current year', () => {
  assert.equal(defaultSeason(new Date('2026-08-25')), 2026)
  assert.equal(defaultSeason(new Date('2026-12-31')), 2026)
})

test('defaultSeason maps Jan-Jul to the prior year', () => {
  assert.equal(defaultSeason(new Date('2026-01-01')), 2025)
  assert.equal(defaultSeason(new Date('2026-07-31')), 2025)
})

test('parseArgs accepts --dry-run and rejects junk', () => {
  assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true })
  assert.deepEqual(parseArgs([]), { dryRun: false })
  assert.throws(() => parseArgs(['--wat']), /Unknown argument/)
})

test('dslNflTeamId decodes D/ST ids and ignores players', () => {
  assert.equal(dslNflTeamId(-16005), 5)
  assert.equal(dslNflTeamId(-1), null)
  assert.equal(dslNflTeamId(4040715), null)
})

const NAMES = { '2026:4040715': 'Jason Myers', '2026:-16005': 'Seahawks D/ST' }

test('mapMove groups adds and drops with owner and bid', () => {
  const move = mapMove(
    {
      id: 'abc',
      type: 'WAIVER',
      status: 'EXECUTED',
      teamId: 9,
      processDate: 1756000000000,
      items: [
        { type: 'ADD', playerId: 4040715, totalValue: 3 },
        { type: 'DROP', playerId: -16005 },
      ],
    },
    NAMES,
    2026
  )
  assert.equal(move.owner, 'JO')
  assert.deepEqual(move.adds, ['Jason Myers'])
  assert.deepEqual(move.drops, ['Seahawks D/ST'])
  assert.equal(move.bid, 3)
  assert.equal(move.date, new Date(1756000000000).toISOString())
})

test('mapMove resolves season-scoped cache entries (no Player N placeholders)', () => {
  // Regression: production cache keys are "<season>:<playerId>". mapMove
  // once ignored the prefix and rendered "added Player 4429086".
  const cache = { '2026:4429086': 'Kayshon Boutte', '2026:-16024': 'Broncos D/ST' }
  const move = mapMove(
    {
      id: '1',
      type: 'FREEAGENT',
      status: 'EXECUTED',
      teamId: 8,
      processDate: 1757833440000,
      items: [
        { type: 'ADD', playerId: 4429086 },
        { type: 'DROP', playerId: -16024 },
      ],
    },
    cache,
    2026
  )
  assert.deepEqual(move.adds, ['Kayshon Boutte'])
  assert.deepEqual(move.drops, ['Broncos D/ST'])
})

test('mapMove still honours bare player ids without a season', () => {
  const move = mapMove(
    {
      id: 'bare',
      type: 'WAIVER',
      status: 'EXECUTED',
      teamId: 9,
      processDate: 1756000000000,
      items: [{ type: 'ADD', playerId: 4040715 }],
    },
    { 4040715: 'Jason Myers' }
  )
  assert.deepEqual(move.adds, ['Jason Myers'])
})

test('mapMove falls back to item names then placeholders', () => {
  const move = mapMove(
    {
      id: 'x',
      type: 'FREE_AGENT',
      status: 'EXECUTED',
      teamId: 99,
      items: [{ type: 'ADD', playerId: 7, firstName: 'Some', lastName: 'Rookie' }],
    },
    {}
  )
  assert.equal(move.owner, null)
  assert.equal(move.teamId, 99)
  assert.deepEqual(move.adds, ['Some Rookie'])
  assert.equal(move.bid, null)

  const unknown = mapMove(
    {
      id: 'y',
      status: 'EXECUTED',
      teamId: 1,
      items: [{ type: 'ADD', playerId: 8 }],
    },
    {}
  )
  assert.deepEqual(unknown.adds, ['Player 8'])
})

test('mapMove skips declined claims and empty payloads', () => {
  const base = { id: 'z', type: 'WAIVER', teamId: 1 }
  assert.equal(mapMove({ ...base, status: 'DECLINED', items: [{ type: 'ADD', playerId: 2 }] }, {}), null)
  assert.equal(mapMove({ ...base, status: 'PROPOSED', items: [] }, {}), null)
  // Pending claims stay on the page.
  const pending = mapMove({ ...base, status: 'PROPOSED', items: [{ type: 'ADD', playerId: 2 }] }, { 2: 'Player Two' })
  assert.equal(pending.status, 'PROPOSED')
})

test('buildOrder sorts by rank and counts executed moves', () => {
  const teams = [
    { id: 2, name: 'B', waiverRank: 1 },
    { id: 1, name: 'A', waiverRank: 3, record: { overall: { wins: 1, losses: 2, ties: 0 } } },
    { id: 3, name: 'C' },
  ]
  const order = buildOrder(teams, { 2: 5 })
  assert.deepEqual(
    order.map(r => r.teamId),
    [2, 1, 3]
  )
  assert.equal(order[0].moves, 5)
  assert.equal(order[0].owner, 'DM')
  assert.equal(order[1].wins, 1)
  assert.equal(order[2].rank, 9999)
})

test('prunePlayers keeps only the current season', () => {
  const kept = prunePlayers({ '2026:1': 'A', '2026:-16005': 'Sea D/ST', '2025:1': 'Old' }, 2026)
  assert.deepEqual(Object.keys(kept).sort(), ['2026:-16005', '2026:1'])
})

// Regression: on 2026-09-15 ESPN's mTransactions2 returned zero transactions
// and the run published "moves": [], wiping the page. Transactions only
// accumulate in-season, so an empty fetch over existing moves must not
// overwrite the file.
const jsonRes = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })

function runMainWith(transactions, seedData) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waivers-'))
  const dataFile = path.join(dir, 'waivers.json')
  const playersFile = path.join(dir, 'waiver-players.json')
  if (seedData !== undefined) fs.writeFileSync(dataFile, JSON.stringify(seedData))
  const fetchImpl = async url => {
    const u = String(url)
    if (u.includes('view=mTransactions2')) return jsonRes({ transactions })
    if (u.includes('view=mTeam')) return jsonRes({ teams: [{ id: 1, waiverRank: 1, name: 'T' }] })
    throw new Error(`unexpected fetch: ${u}`)
  }
  const saved = {}
  for (const k of ['LEAGUE_ID', 'LEAGUE_YEAR', 'ESPN_S2', 'SWID']) {
    saved[k] = process.env[k]
    process.env[k] = k === 'LEAGUE_YEAR' ? '2026' : 'x'
  }
  return main([], fetchImpl, { dataFile, playersFile })
    .then(code => ({ code, dataFile, playersFile }))
    .finally(() => {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    })
}

const SEED_MOVE = {
  id: '1',
  date: '2026-09-13T18:45:37.190Z',
  event: 'FREEAGENT',
  status: 'EXECUTED',
  teamId: 8,
  owner: 'DN',
  adds: ['Tyler Allgeier'],
  drops: [],
  bid: null,
}

test('mergeMoves unions by id, prefers fresh records, sorts newest first', () => {
  const old = { id: 'a', date: '2026-09-10T00:00:00Z', status: 'PROPOSED' }
  const updated = { id: 'a', date: '2026-09-10T00:00:00Z', status: 'EXECUTED' }
  const fresh = { id: 'b', date: '2026-09-16T00:00:00Z', status: 'EXECUTED' }
  const merged = mergeMoves([old], [updated, fresh], 10)
  assert.equal(merged.length, 2)
  assert.equal(merged[0].id, 'b')
  assert.equal(merged[1].status, 'EXECUTED')
})

test('mergeMoves caps at maxMoves keeping the newest', () => {
  const mk = i => ({ id: String(i), date: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z` })
  const merged = mergeMoves([mk(0), mk(1)], [mk(2), mk(3)], 3)
  assert.deepEqual(
    merged.map(m => m.id),
    ['3', '2', '1']
  )
})

test('main merges a fresh fetch into the existing season ledger', async () => {
  const seed = { leagueId: '794521', season: 2026, updated: '2026-09-14T18:21:43Z', order: [], moves: [SEED_MOVE] }
  const freshTx = {
    id: 'new-uuid',
    type: 'WAIVER',
    status: 'EXECUTED',
    teamId: 1,
    processDate: new Date('2026-09-16T13:00:00Z').getTime(),
    items: [{ type: 'ADD', playerId: 999 }],
  }
  const fetchImpl = async url => {
    const u = String(url)
    if (u.includes('view=mTransactions2')) return jsonRes({ transactions: [freshTx] })
    if (u.includes('view=mTeam')) return jsonRes({ teams: [{ id: 1, waiverRank: 1, name: 'T' }] })
    if (u.includes('/athletes/999')) return jsonRes({ displayName: 'New Guy' })
    throw new Error(`unexpected fetch: ${u}`)
  }
  const saved = {}
  for (const k of ['LEAGUE_ID', 'LEAGUE_YEAR', 'ESPN_S2', 'SWID']) {
    saved[k] = process.env[k]
    process.env[k] = k === 'LEAGUE_YEAR' ? '2026' : 'x'
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waivers-'))
  const dataFile = path.join(dir, 'waivers.json')
  const playersFile = path.join(dir, 'waiver-players.json')
  fs.writeFileSync(dataFile, JSON.stringify(seed))
  let code
  try {
    code = await main([], fetchImpl, { dataFile, playersFile })
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
  assert.equal(code, 0)
  const written = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
  assert.equal(written.moves.length, 2)
  // Newest first: the fresh move sorts above the seeded one.
  assert.equal(written.moves[0].id, 'new-uuid')
  assert.deepEqual(written.moves[0].adds, ['New Guy'])
  assert.equal(written.moves[1].id, '1')
})

test('main writes normally when there is no previous file', async () => {
  const { code, dataFile } = await runMainWith([], undefined)
  assert.equal(code, 0)
  const written = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
  assert.equal(written.season, 2026)
  assert.deepEqual(written.moves, [])
})

test('main writes normally when the previous file is a different season', async () => {
  const seed = { leagueId: '794521', season: 2025, updated: '2025-12-01T00:00:00Z', order: [], moves: [SEED_MOVE] }
  const { code, dataFile } = await runMainWith([], seed)
  assert.equal(code, 0)
  const written = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
  assert.equal(written.season, 2026)
  assert.deepEqual(written.moves, [])
})
