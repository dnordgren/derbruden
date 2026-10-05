import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  groupTradeLegs,
  tradeTeams,
  extractTradeAssets,
  tradeSides,
  assembleApiTrades,
  optimalLineup,
  starterSlotList,
  roundOfPick,
  isotonizeDecreasing,
  computePickValues,
  resolveLedgerGives,
  extractDecidedWeeks,
  uniqueWeeksAfter,
  gradeTradeSides,
  ownerOf,
} from './generate-trade-grades.mjs'

const SLOTS = [0, 2, 2, 4, 4, 6, 23, 16, 17]

function player(id, points, elig) {
  return { id, points, elig }
}

test('optimalLineup fills every slot with the best eligible players', () => {
  const pool = [
    player(1, 20, [0]),
    player(2, 15, [2, 23]),
    player(3, 14, [2, 23]),
    player(4, 5, [2, 23]),
    player(5, 12, [4, 23]),
    player(6, 11, [4, 23]),
    player(7, 9, [6, 23]),
    player(8, 8, [16]),
    player(9, 7, [17]),
    player(10, 30, [20]), // bench-only, never starts
  ]
  // 20 + 15 + 14 + 12 + 11 + 9 + 5 (flex takes next-best RB/WR/TE) + 8 + 7 = 101
  assert.equal(optimalLineup(pool, SLOTS), 101)
})

test('optimalLineup leaves unfillable slots at zero', () => {
  const pool = [player(1, 20, [0])]
  assert.equal(optimalLineup(pool, SLOTS), 20)
})

test('optimalLineup picks the best flex candidate across positions', () => {
  const pool = [
    player(1, 20, [0]),
    player(2, 4, [2, 23]),
    player(3, 3, [2, 23]),
    player(4, 2, [4, 23]),
    player(5, 1, [4, 23]),
    player(6, 25, [6, 23]), // star TE beats RB/WR for flex? no: TE slot first
    player(8, 8, [16]),
    player(9, 7, [17]),
  ]
  // QB 20 + RB 4 + 3 + WR 2 + 1 + TE 25 + FLEX 0 (nothing left eligible) + 8 + 7 = 70
  assert.equal(optimalLineup(pool, SLOTS), 70)
})

test('starterSlotList expands settings counts', () => {
  assert.deepEqual(
    starterSlotList({ 0: 1, 2: 2, 4: 2, 6: 1, 23: 1, 16: 1, 17: 1, 20: 7 }).sort((a, b) => a - b),
    [...SLOTS].sort((a, b) => a - b)
  )
})

test('groupTradeLegs pairs accept and uphold legs by related id', () => {
  const legs = [
    { id: 'a', type: 'TRADE_ACCEPT', teamId: 2, relatedTransactionId: 'rel-1' },
    { id: 'u', type: 'TRADE_UPHOLD', teamId: 1, relatedTransactionId: 'rel-1' },
    { id: 'b', type: 'TRADE_ACCEPT', teamId: 4, relatedTransactionId: 'rel-2' },
  ]
  const groups = groupTradeLegs(legs)
  assert.equal(groups.size, 2)
  assert.deepEqual(tradeTeams(groups.get('rel-1')), [1, 2])
})

test('extractTradeAssets keeps direction from TRADE items', () => {
  const legs = [
    {
      type: 'TRADE_ACCEPT',
      teamId: 2,
      items: [
        { type: 'TRADE', playerId: 100, fromTeamId: 4, toTeamId: 2 },
        { type: 'TRADE', playerId: 200, fromTeamId: 2, toTeamId: 4 },
      ],
    },
  ]
  const assets = extractTradeAssets(legs)
  assert.equal(assets.length, 2)
  assert.deepEqual(assets[0], { kind: 'player', playerId: 100, fromTeamId: 4, toTeamId: 2 })
})

test('extractTradeAssets keeps draft picks with overall numbers', () => {
  const legs = [
    {
      type: 'TRADE_ACCEPT',
      teamId: 2,
      items: [{ type: 'DRAFT_TRADE', overallPickNumber: 41, fromTeamId: 2, toTeamId: 4 }],
    },
  ]
  const assets = extractTradeAssets(legs)
  assert.deepEqual(assets, [{ kind: 'pick', overallPickNumber: 41, fromTeamId: 2, toTeamId: 4 }])
})

test('tradeSides rejects trades with unknown destinations', () => {
  const sides = tradeSides([2, 4], [{ kind: 'player', playerId: 100, fromTeamId: 2, toTeamId: null }])
  assert.equal(sides, null)
})

test('tradeSides builds gives and receives per team', () => {
  const sides = tradeSides(
    [2, 4],
    [
      { kind: 'player', playerId: 100, fromTeamId: 4, toTeamId: 2 },
      { kind: 'player', playerId: 200, fromTeamId: 2, toTeamId: 4 },
    ]
  )
  assert.equal(sides[0].teamId, 2)
  assert.equal(sides[0].gives[0].playerId, 200)
  assert.equal(sides[0].receives[0].playerId, 100)
  assert.equal(sides[1].gives[0].playerId, 100)
})

test('assembleApiTrades skips legs without terms', () => {
  const trades = assembleApiTrades(
    [
      { id: 'empty', type: 'TRADE_ACCEPT', teamId: 2, relatedTransactionId: 'r1', scoringPeriodId: 9, items: [] },
      { id: 'uphold', type: 'TRADE_UPHOLD', teamId: 1, relatedTransactionId: 'r1', scoringPeriodId: 9 },
    ],
    {}
  )
  assert.equal(trades.length, 0)
})

test('assembleApiTrades keeps the earliest execution week', () => {
  const trades = assembleApiTrades(
    [
      {
        id: 'full',
        type: 'TRADE_ACCEPT',
        teamId: 8,
        relatedTransactionId: 'r2',
        scoringPeriodId: 9,
        proposedDate: 1000,
        date: 2000,
        items: [
          { type: 'TRADE', playerId: 1, fromTeamId: 2, toTeamId: 8 },
          { type: 'TRADE', playerId: 2, fromTeamId: 8, toTeamId: 2 },
        ],
      },
      { id: 'u2', type: 'TRADE_UPHOLD', teamId: 2, relatedTransactionId: 'r2', scoringPeriodId: 8 },
    ],
    {}
  )
  assert.equal(trades.length, 1)
  assert.equal(trades[0].execWeek, 8)
})

test('roundOfPick maps overall numbers to ten-team rounds', () => {
  assert.equal(roundOfPick(1), 1)
  assert.equal(roundOfPick(10), 1)
  assert.equal(roundOfPick(11), 2)
  assert.equal(roundOfPick(67), 7)
  assert.equal(roundOfPick(117), 12)
})

test('isotonizeDecreasing smooths later rounds down', () => {
  assert.deepEqual(isotonizeDecreasing([10, 8, 9, 4]), [10, 8.5, 8.5, 4])
  assert.deepEqual(isotonizeDecreasing([5, 4, 3]), [5, 4, 3])
})

test('computePickValues prices rounds over replacement', () => {
  const roundTotals = new Map([
    [1, [240, 260]],
    [2, [200, 210]],
    [3, [100, 110]],
  ])
  const { perRound, replacement } = computePickValues(roundTotals)
  // median of [240,260,200,210,100,110] = (200+210)/2 = 205
  assert.equal(replacement, 205)
  assert.equal(perRound[1], Math.round(((250 - 205) / 17) * 10) / 10)
  assert.equal(perRound[2], Math.round(((205 - 205) / 17) * 10) / 10)
  assert.equal(perRound[3], 0)
})

test('resolveLedgerGives parses picks and matches unique names', () => {
  const index = new Map([['daniel jones', [{ playerId: 3917792, name: 'Daniel Jones' }]]])
  const { assets, unresolved } = resolveLedgerGives(['Daniel Jones', 'Draft pick #67', 'Some Guy'], index)
  assert.deepEqual(assets, [
    { kind: 'player', playerId: 3917792, name: 'Daniel Jones' },
    { kind: 'pick', overallPickNumber: 67, name: 'Draft pick #67' },
  ])
  assert.deepEqual(unresolved, ['Some Guy'])
})

test('resolveLedgerGives flags ambiguous names', () => {
  const index = new Map([
    [
      'mike williams',
      [
        { playerId: 1, name: 'Mike Williams' },
        { playerId: 2, name: 'Mike Williams' },
      ],
    ],
  ])
  const { assets, unresolved } = resolveLedgerGives(['Mike Williams'], index)
  assert.deepEqual(assets, [])
  assert.deepEqual(unresolved, ['Mike Williams'])
})

test('extractDecidedWeeks drops future and undecided matchups', () => {
  const league = {
    schedule: [
      {
        matchupPeriodId: 1,
        winner: 'HOME',
        playoffTierType: 'NONE',
        home: { teamId: 1, totalPoints: 100 },
        away: { teamId: 2, totalPoints: 90 },
      },
      {
        matchupPeriodId: 2,
        winner: 'UNDECIDED',
        playoffTierType: 'NONE',
        home: { teamId: 1, totalPoints: 0 },
        away: { teamId: 2, totalPoints: 0 },
      },
      {
        matchupPeriodId: 15,
        winner: 'AWAY',
        playoffTierType: 'WINNERS_BRACKET',
        home: { teamId: 1, totalPoints: 80 },
        away: { teamId: 2, totalPoints: 99 },
      },
    ],
  }
  const weeks = extractDecidedWeeks(league, 2025)
  assert.equal(weeks.length, 2)
  assert.equal(weeks[1].week, 15)
})

test('uniqueWeeksAfter dedupes one entry per matchup', () => {
  const decided = [{ week: 2 }, { week: 2 }, { week: 2 }, { week: 3 }, { week: 3 }]
  assert.deepEqual(uniqueWeeksAfter(decided, 1, 18), [2, 3])
  assert.deepEqual(uniqueWeeksAfter(decided, 2, 18), [3])
  assert.deepEqual(uniqueWeeksAfter(decided, 0, 2), [2])
})

test('ownerOf falls back for unknown franchises', () => {
  assert.equal(ownerOf(9), 'JO')
  assert.equal(ownerOf(99), 'Team 99')
})

function gradeFixture() {
  // Team 4 trades player 100 to team 11 for player 200 after week 1.
  // Week 2 rosters (actual, post-trade):
  //   team 4: QB 20, player 200 scores 15 at RB, bench RB 6
  //   team 11: QB 20, player 100 scores 25 at RB, bench RB 6
  const rb = [2, 23]
  const rostersByWeek = {
    2: {
      4: [
        { playerId: 1, points: 20, elig: [0] },
        { playerId: 200, points: 15, elig: rb },
        { playerId: 300, points: 6, elig: rb },
      ],
      11: [
        { playerId: 2, points: 20, elig: [0] },
        { playerId: 100, points: 25, elig: rb },
        { playerId: 400, points: 6, elig: rb },
      ],
    },
  }
  const scoreIndex = new Map([
    ['2:100', { points: 25, elig: rb }],
    ['2:200', { points: 15, elig: rb }],
  ])
  const schedule = [{ season: 2026, week: 2, homeId: 4, awayId: 11, homeScore: 100, awayScore: 110, winner: 'away' }]
  const sides = [
    {
      teamId: 4,
      gives: [{ kind: 'player', playerId: 100, fromTeamId: 4, toTeamId: 11 }],
      receives: [{ kind: 'player', playerId: 200, fromTeamId: 11, toTeamId: 4 }],
    },
    {
      teamId: 11,
      gives: [{ kind: 'player', playerId: 200, fromTeamId: 11, toTeamId: 4 }],
      receives: [{ kind: 'player', playerId: 100, fromTeamId: 4, toTeamId: 11 }],
    },
  ]
  return { rostersByWeek, scoreIndex, schedule, sides }
}

test('gradeTradeSides credits the side that got the better player', () => {
  const { rostersByWeek, scoreIndex, schedule, sides } = gradeFixture()
  const slots = [0, 2, 23]
  const { sides: results, incomplete } = gradeTradeSides({
    sides,
    rostersByWeek,
    scoreIndex,
    gradedWeeks: [2],
    schedule,
    slots,
    pickValues: { perRound: {} },
  })
  assert.equal(incomplete, false)
  // Team 4: actual 20+15=35, counterfactual 20+25=45 -> -10
  // Team 11: actual 20+25=45, counterfactual 20+15=35 -> +10
  assert.equal(results[0].gained, -10)
  assert.equal(results[1].gained, 10)
})

test('gradeTradeSides detects a flipped head-to-head result', () => {
  const { rostersByWeek, scoreIndex, schedule, sides } = gradeFixture()
  // Official: team 4 scored 100, team 11 scored 110. Team 4's optimal was
  // 35 but it actually scored 100? Mismatched scales flip nothing sensibly,
  // so rescale: official scores near optimal totals.
  const close = [{ season: 2026, week: 2, homeId: 4, awayId: 11, homeScore: 36, awayScore: 44, winner: 'away' }]
  const { sides: results } = gradeTradeSides({
    sides,
    rostersByWeek,
    scoreIndex,
    gradedWeeks: [2],
    schedule: close,
    slots: [0, 2, 23],
    pickValues: { perRound: {} },
  })
  // Team 4 counterfactual: 36 - 35 + 45 = 46 > 44 -> flips for team 4.
  assert.equal(results[0].winsFlippedFor, 1)
  assert.equal(results[1].winsFlippedAgainst, 1)
})

test('gradeTradeSides flags missing counterfactual scores', () => {
  const { rostersByWeek, schedule, sides } = gradeFixture()
  const { incomplete } = gradeTradeSides({
    sides,
    rostersByWeek,
    scoreIndex: new Map(),
    gradedWeeks: [2],
    schedule,
    slots: [0, 2, 23],
    pickValues: { perRound: {} },
  })
  assert.equal(incomplete, true)
})

test('gradeTradeSides credits traded picks every graded week', () => {
  const { rostersByWeek, scoreIndex, schedule } = gradeFixture()
  const sides = [
    { teamId: 4, gives: [], receives: [{ kind: 'pick', overallPickNumber: 15 }] },
    { teamId: 11, gives: [{ kind: 'pick', overallPickNumber: 15 }], receives: [] },
  ]
  const { sides: results } = gradeTradeSides({
    sides,
    rostersByWeek,
    scoreIndex,
    gradedWeeks: [2, 3],
    schedule,
    slots: [0, 2, 23],
    pickValues: { perRound: { 2: 2.5 } },
  })
  assert.equal(results[0].pickCredit, 5)
  assert.equal(results[1].pickCredit, 0)
})
