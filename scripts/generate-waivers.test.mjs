import test from 'node:test'
import assert from 'node:assert/strict'
import { dslNflTeamId, mapMove, buildOrder, prunePlayers, parseArgs, defaultSeason } from './generate-waivers.mjs'

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

const NAMES = { 4040715: 'Jason Myers', '-16005': 'Seahawks D/ST' }

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
    NAMES
  )
  assert.equal(move.owner, 'JO')
  assert.deepEqual(move.adds, ['Jason Myers'])
  assert.deepEqual(move.drops, ['Seahawks D/ST'])
  assert.equal(move.bid, 3)
  assert.equal(move.date, new Date(1756000000000).toISOString())
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
