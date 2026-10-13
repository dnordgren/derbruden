import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  aggregateMwaCareer,
  aggregateMwaSeason,
  computeWeekAvg,
  EXCLUDED_OWNERS,
  findManagerWinsAdded,
} from './generate-sit-start.mjs'

function game(season, week, homeId, awayId, homeScore, awayScore, winner) {
  return { season, week, homeId, awayId, homeScore, awayScore, winner }
}

const ownerOf = id => ({ 1: 'GM', 8: 'DN', 9: 'JO' })[id] ?? `team ${id}`
const nameOf = id => ({ 1: 'Fat Joe', 8: 'Lady Killers', 9: 'Starr Struck' })[id] ?? ''

test('computeWeekAvg divides total actual by total optimal per week', () => {
  const rows = [
    { season: 2025, week: 3, owner: 'GM', teamId: 1, actual: 100, optimal: 125 },
    { season: 2025, week: 3, owner: 'DN', teamId: 8, actual: 140, optimal: 175 },
    { season: 2025, week: 4, owner: 'GM', teamId: 1, actual: 90, optimal: 100 },
    { season: 2025, week: 4, owner: 'DN', teamId: 8, actual: 110, optimal: 200 },
  ]
  const avg = computeWeekAvg(rows)
  assert.equal(avg.get('2025:3'), 240 / 300) // 0.8
  assert.equal(avg.get('2025:4'), 200 / 300)
})

test('computeWeekAvg excludes SHEN team-weeks', () => {
  const rows = [
    { season: 2025, week: 3, owner: 'SHEN', teamId: 6, actual: 200, optimal: 200 },
    { season: 2025, week: 3, owner: 'DN', teamId: 8, actual: 80, optimal: 100 },
  ]
  assert.equal(computeWeekAvg(rows).get('2025:3'), 0.8)
})

test('a win is stolen when an average manager loses it', () => {
  // DN beats GM 105-100; DN optimal 120 at a 0.8 league week => expected 96 < 100.
  const games = [game(2025, 3, 8, 1, 105, 100, 'home')]
  const scores = new Map([
    ['2025:3:8', { actual: 105, optimal: 120 }],
    ['2025:3:1', { actual: 100, optimal: 110 }],
  ])
  const avg = new Map([['2025:3', 0.8]])
  const details = findManagerWinsAdded(games, scores, avg, ownerOf)
  assert.equal(details.length, 1)
  assert.deepEqual(details[0], {
    season: 2025,
    week: 3,
    owner: 'DN',
    teamId: 8,
    opp: 'GM',
    actual: 105,
    expected: 96,
    oppScore: 100,
    result: 'stolen',
  })
})

test('a win holds when an average manager wins it too', () => {
  // DN beats GM 105-100 but DN optimal 140 at 0.8 => expected 112 > 100: no steal.
  const games = [game(2025, 3, 8, 1, 105, 100, 'home')]
  const scores = new Map([
    ['2025:3:8', { actual: 105, optimal: 140 }],
    ['2025:3:1', { actual: 100, optimal: 110 }],
  ])
  assert.equal(findManagerWinsAdded(games, scores, new Map([['2025:3', 0.8]]), ownerOf).length, 0)
})

test('a loss is avoidable when an average manager wins it', () => {
  // DN loses 100-120; DN optimal 160 at 0.8 => expected 128 > 120.
  const games = [game(2025, 3, 8, 1, 100, 120, 'away')]
  const scores = new Map([
    ['2025:3:8', { actual: 100, optimal: 160 }],
    ['2025:3:1', { actual: 120, optimal: 130 }],
  ])
  const details = findManagerWinsAdded(games, scores, new Map([['2025:3', 0.8]]), ownerOf)
  assert.equal(details.length, 1)
  assert.equal(details[0].owner, 'DN')
  assert.equal(details[0].result, 'avoidable')
  assert.equal(details[0].expected, 128)
  assert.equal(details[0].oppScore, 120)
})

test('a loss holds when an average manager loses it too', () => {
  // DN loses 100-120 and DN optimal 130 at 0.8 => expected 104 < 120: no flag.
  const games = [game(2025, 3, 8, 1, 100, 120, 'away')]
  const scores = new Map([
    ['2025:3:8', { actual: 100, optimal: 130 }],
    ['2025:3:1', { actual: 120, optimal: 150 }],
  ])
  assert.equal(findManagerWinsAdded(games, scores, new Map([['2025:3', 0.8]]), ownerOf).length, 0)
})

test('one game can steal and burn at once', () => {
  // DN steals (105 > 100, expected 96 < 100) while GM burns (100 < 105, expected 112 > 105).
  const games = [game(2025, 3, 8, 1, 105, 100, 'home')]
  const scores = new Map([
    ['2025:3:8', { actual: 105, optimal: 120 }],
    ['2025:3:1', { actual: 100, optimal: 140 }],
  ])
  const details = findManagerWinsAdded(games, scores, new Map([['2025:3', 0.8]]), ownerOf)
  assert.equal(details.length, 2)
  assert.deepEqual(
    details.map(d => [d.owner, d.result]),
    [
      ['DN', 'stolen'],
      ['GM', 'avoidable'],
    ]
  )
})

test('ties are skipped and expected exactly equal is neutral', () => {
  const tieGames = [game(2025, 4, 8, 1, 110, 110, 'tie')]
  const scores = new Map([
    ['2025:4:8', { actual: 110, optimal: 200 }],
    ['2025:4:1', { actual: 110, optimal: 200 }],
  ])
  assert.equal(findManagerWinsAdded(tieGames, scores, new Map([['2025:4', 0.8]]), ownerOf).length, 0)
  // Expected exactly equals the opponent score: strict inequality keeps it neutral.
  const edge = [game(2025, 5, 8, 1, 105, 100, 'home')]
  const edgeScores = new Map([
    ['2025:5:8', { actual: 105, optimal: 125 }], // 125 * 0.8 = 100.0 == opp
    ['2025:5:1', { actual: 100, optimal: 100 }],
  ])
  assert.equal(findManagerWinsAdded(edge, edgeScores, new Map([['2025:5', 0.8]]), ownerOf).length, 0)
})

test('missing scores and missing week averages are skipped', () => {
  const games = [game(2025, 5, 8, 1, 90, 130, 'away')]
  assert.equal(findManagerWinsAdded(games, new Map(), new Map([['2025:5', 0.8]]), ownerOf).length, 0)
  const scores = new Map([['2025:5:8', { actual: 90, optimal: 200 }]])
  assert.equal(findManagerWinsAdded(games, scores, new Map(), ownerOf).length, 0)
})

test('excluded owners never appear in MWA details or aggregates', () => {
  assert.ok(EXCLUDED_OWNERS.has('SHEN'))
  const shenOwnerOf = id => (id === 6 ? 'SHEN' : ownerOf(id))
  const games = [game(2025, 1, 6, 8, 130, 100, 'home')] // SHEN wins big
  const scores = new Map([
    ['2025:1:6', { actual: 130, optimal: 140 }],
    ['2025:1:8', { actual: 100, optimal: 170 }],
  ])
  const details = findManagerWinsAdded(games, scores, new Map([['2025:1', 0.8]]), shenOwnerOf)
  assert.ok(!details.some(d => d.owner === 'SHEN'))
  assert.equal(details.length, 1) // DN's avoidable loss still counts
  assert.equal(details[0].owner, 'DN')
  const rows = aggregateMwaSeason(details, games, shenOwnerOf, nameOf)
  assert.ok(!rows.some(r => r.owner === 'SHEN'))
  const career = aggregateMwaCareer({ 2025: { season: 2025, rows } })
  assert.ok(!career.some(r => r.owner === 'SHEN'))
})

test('aggregateMwaSeason counts every decided game and ranks MWA descending', () => {
  const games = [
    game(2025, 1, 8, 1, 105, 100, 'home'), // DN win, stolen
    game(2025, 2, 8, 9, 100, 110, 'away'), // DN loss, holds
    game(2025, 3, 1, 9, 90, 100, 'away'), // GM loss, avoidable
  ]
  const details = [
    {
      season: 2025,
      week: 1,
      owner: 'DN',
      teamId: 8,
      opp: 'GM',
      actual: 105,
      expected: 96,
      oppScore: 100,
      result: 'stolen',
    },
    {
      season: 2025,
      week: 3,
      owner: 'GM',
      teamId: 1,
      opp: 'JO',
      actual: 90,
      expected: 110,
      oppScore: 100,
      result: 'avoidable',
    },
  ]
  const rows = aggregateMwaSeason(details, games, ownerOf, nameOf)
  assert.equal(rows.length, 3)
  const dn = rows.find(r => r.owner === 'DN')
  const gm = rows.find(r => r.owner === 'GM')
  const jo = rows.find(r => r.owner === 'JO')
  assert.equal(dn.games, 2)
  assert.equal(dn.stolen, 1)
  assert.equal(dn.avoidable, 0)
  assert.equal(dn.mwa, 1)
  assert.equal(dn.plays.length, 1)
  assert.equal(gm.mwa, -1)
  assert.equal(jo.games, 2)
  assert.equal(jo.mwa, 0)
  assert.deepEqual(
    rows.map(r => r.owner),
    ['DN', 'JO', 'GM']
  )
  assert.ok(rows[0].rank === 1 && rows[2].rank === 3)
})

test('aggregateMwaSeason ignores ties in the games denominator', () => {
  const games = [game(2025, 1, 8, 1, 110, 110, 'tie')]
  assert.equal(aggregateMwaSeason([], games, ownerOf, nameOf).length, 0)
})

test('aggregateMwaCareer sums seasons and recomputes MWA', () => {
  const career = aggregateMwaCareer({
    2024: {
      season: 2024,
      rows: [
        { owner: 'DN', team: 'T', teamId: 8, games: 13, stolen: 2, avoidable: 1, mwa: 1, plays: [] },
        { owner: 'GM', team: 'G', teamId: 1, games: 13, stolen: 0, avoidable: 3, mwa: -3, plays: [] },
      ],
    },
    2025: {
      season: 2025,
      rows: [{ owner: 'DN', team: 'T', teamId: 8, games: 13, stolen: 1, avoidable: 1, mwa: 0, plays: [] }],
    },
  })
  const dn = career.find(r => r.owner === 'DN')
  assert.equal(dn.seasons, 2)
  assert.equal(dn.games, 26)
  assert.equal(dn.stolen, 3)
  assert.equal(dn.avoidable, 2)
  assert.equal(dn.mwa, 1)
  assert.equal(career[0].owner, 'DN')
})

test('renderPageContent includes the MWA section and v10 script, with no winnable section', async () => {
  const { renderPageContent } = await import('./generate-sit-start.mjs')
  const html = renderPageContent({
    defaultSeason: 2025,
    career: [],
    perSeason: { 2024: { season: 2024, rows: [] }, 2025: { season: 2025, rows: [] } },
    managerWinsAdded: { perSeason: { 2025: { season: 2025, rows: [] } }, career: [] },
  })
  assert.ok(html.includes('Manager Wins Added'))
  assert.ok(html.includes('id="mwa-table-wrap"'))
  assert.ok(html.includes('id="mwa-season-select"'))
  assert.ok(html.includes('sit-start.js?v=10'))
  assert.ok(!html.toLowerCase().includes('winnable'))
})

test('renderPageContent tolerates JSON without managerWinsAdded', async () => {
  const { renderPageContent } = await import('./generate-sit-start.mjs')
  const html = renderPageContent({ defaultSeason: 2025, career: [], perSeason: {} })
  assert.ok(html.includes('Manager Wins Added'))
})

test('renderOwnerSection shows Stolen/Avoidable/MWA columns, no Winnable column, and dashes legacy rows', async () => {
  const { renderOwnerSection } = await import('./generate-sit-start.mjs')
  const withMwa = renderOwnerSection(
    [
      {
        season: 2025,
        weeks: 13,
        actual: 100,
        optimal: 110,
        perfectWeeks: 1,
        efficiency: 0.909,
        perfectPct: 0.077,
        stolen: 3,
        avoidable: 1,
        mwa: 2,
      },
    ],
    {
      weeks: 13,
      actual: 100,
      optimal: 110,
      perfectWeeks: 1,
      efficiency: 0.909,
      perfectPct: 0.077,
      stolen: 3,
      avoidable: 1,
      mwa: 2,
    }
  )
  assert.ok(withMwa.includes('<th scope="col" class="number">MWA</th>'))
  assert.ok(withMwa.includes('3 stolen wins, 1 avoidable losses'))
  assert.ok(!withMwa.toLowerCase().includes('winnable'))
  const legacy = renderOwnerSection(
    [{ season: 2025, weeks: 13, actual: 100, optimal: 110, perfectWeeks: 1, efficiency: 0.909, perfectPct: 0.077 }],
    null
  )
  assert.ok(legacy.includes('Manager wins added'))
  assert.ok(legacy.includes('—'))
})
