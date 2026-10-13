import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  aggregateWinnableCareer,
  aggregateWinnableSeason,
  EXCLUDED_OWNERS,
  findWinnableLosses,
} from './generate-sit-start.mjs'

function game(season, week, homeId, awayId, homeScore, awayScore, winner) {
  return { season, week, homeId, awayId, homeScore, awayScore, winner }
}

const ownerOf = id => ({ 1: 'GM', 8: 'DN', 9: 'JO' })[id] ?? `team ${id}`
const nameOf = id => ({ 1: 'Fat Joe', 8: 'Lady Killers', 9: 'Starr Struck' })[id] ?? ''

test('a loss flips when optimal beats the winner actual score', () => {
  const games = [game(2025, 3, 8, 1, 100, 120, 'away')] // DN loses at home
  const optimalByKey = new Map([['2025:3:8', { actual: 100, optimal: 125 }]])
  const details = findWinnableLosses(games, optimalByKey, ownerOf)
  assert.equal(details.length, 1)
  assert.deepEqual(details[0], {
    season: 2025,
    week: 3,
    owner: 'DN',
    teamId: 8,
    opp: 'GM',
    actual: 100,
    optimal: 125,
    oppScore: 120,
  })
})

test('a loss holds when optimal still trails the winner', () => {
  const games = [game(2025, 3, 8, 1, 100, 120, 'away')]
  const optimalByKey = new Map([['2025:3:8', { actual: 100, optimal: 118 }]])
  assert.equal(findWinnableLosses(games, optimalByKey, ownerOf).length, 0)
})

test('optimal exactly tying the winner is not a flip', () => {
  const games = [game(2025, 3, 8, 1, 100, 120, 'away')]
  const optimalByKey = new Map([['2025:3:8', { actual: 100, optimal: 120 }]])
  assert.equal(findWinnableLosses(games, optimalByKey, ownerOf).length, 0)
})

test('ties are skipped and missing weeks are skipped', () => {
  const games = [
    game(2025, 4, 8, 1, 110, 110, 'tie'),
    game(2025, 5, 8, 1, 90, 130, 'away'), // no roster entry: skipped
  ]
  const optimalByKey = new Map()
  assert.equal(findWinnableLosses(games, optimalByKey, ownerOf).length, 0)
})

test('away winners flip against the home optimal', () => {
  const games = [game(2025, 6, 1, 8, 130, 100, 'home')] // DN loses on the road
  const optimalByKey = new Map([['2025:6:8', { actual: 100, optimal: 135 }]])
  const details = findWinnableLosses(games, optimalByKey, ownerOf)
  assert.equal(details.length, 1)
  assert.equal(details[0].owner, 'DN')
  assert.equal(details[0].opp, 'GM')
  assert.equal(details[0].oppScore, 130)
})

test('aggregateWinnableSeason counts losses for every loser, ranks most winnable first', () => {
  const games = [
    game(2025, 1, 8, 1, 100, 120, 'away'), // DN loss, winnable
    game(2025, 2, 8, 9, 100, 110, 'away'), // DN loss, holds
    game(2025, 3, 1, 9, 90, 100, 'away'), // GM loss, holds
  ]
  const details = [
    { season: 2025, week: 1, owner: 'DN', teamId: 8, opp: 'GM', actual: 100, optimal: 125, oppScore: 120 },
  ]
  const rows = aggregateWinnableSeason(details, games, ownerOf, nameOf)
  assert.equal(rows.length, 2)
  const dn = rows.find(r => r.owner === 'DN')
  const gm = rows.find(r => r.owner === 'GM')
  assert.equal(dn.losses, 2)
  assert.equal(dn.winnable, 1)
  assert.equal(dn.winnablePct, 0.5)
  assert.equal(dn.games.length, 1)
  assert.equal(gm.losses, 1)
  assert.equal(gm.winnable, 0)
  assert.equal(rows[0].owner, 'DN') // most winnable first
  assert.ok(rows[0].rank === 1 && rows[1].rank === 2)
})

test('aggregateWinnableSeason ignores ties in the loss denominator', () => {
  const games = [game(2025, 1, 8, 1, 110, 110, 'tie')]
  const rows = aggregateWinnableSeason([], games, ownerOf, nameOf)
  assert.equal(rows.length, 0)
})

test('excluded owners never appear in winnable aggregates', () => {
  assert.ok(EXCLUDED_OWNERS.has('SHEN'))
  const shenOwnerOf = id => (id === 6 ? 'SHEN' : ownerOf(id))
  const games = [game(2025, 1, 6, 8, 100, 120, 'away')]
  const optimalByKey = new Map([['2025:1:6', { actual: 100, optimal: 150 }]])
  const details = findWinnableLosses(games, optimalByKey, shenOwnerOf)
  assert.equal(details.length, 0) // excluded at flip time, so details match the tables
  const rows = aggregateWinnableSeason(
    [{ season: 2025, week: 1, owner: 'SHEN', teamId: 6, opp: 'DN', actual: 100, optimal: 150, oppScore: 120 }],
    games,
    shenOwnerOf,
    nameOf
  )
  assert.ok(!rows.some(r => r.owner === 'SHEN'))
  const career = aggregateWinnableCareer({ 2025: { season: 2025, rows } })
  assert.ok(!career.some(r => r.owner === 'SHEN'))
})

test('aggregateWinnableCareer sums seasons and recomputes the pct', () => {
  const career = aggregateWinnableCareer({
    2024: {
      season: 2024,
      rows: [
        { owner: 'DN', team: 'T', teamId: 8, losses: 5, winnable: 2, winnablePct: 0.4, games: [] },
        { owner: 'GM', team: 'G', teamId: 1, losses: 4, winnable: 3, winnablePct: 0.75, games: [] },
      ],
    },
    2025: {
      season: 2025,
      rows: [{ owner: 'DN', team: 'T', teamId: 8, losses: 5, winnable: 1, winnablePct: 0.2, games: [] }],
    },
  })
  const dn = career.find(r => r.owner === 'DN')
  assert.equal(dn.seasons, 2)
  assert.equal(dn.losses, 10)
  assert.equal(dn.winnable, 3)
  assert.equal(dn.winnablePct, 0.3)
  assert.equal(career[0].owner, 'DN') // tied 3-3 on winnable -> more losses first
})

test('renderPageContent includes the winnable section and v8 script', async () => {
  const { renderPageContent } = await import('./generate-sit-start.mjs')
  const html = renderPageContent({
    defaultSeason: 2025,
    career: [],
    perSeason: { 2024: { season: 2024, rows: [] }, 2025: { season: 2025, rows: [] } },
    winnableLosses: { perSeason: { 2025: { season: 2025, rows: [] } }, career: [] },
  })
  assert.ok(html.includes('Winnable Games Lost'))
  assert.ok(html.includes('id="winnable-table-wrap"'))
  assert.ok(html.includes('id="winnable-season-select"'))
  assert.ok(html.includes('sit-start.js?v=8'))
})

test('renderPageContent tolerates JSON without winnableLosses', async () => {
  const { renderPageContent } = await import('./generate-sit-start.mjs')
  const html = renderPageContent({ defaultSeason: 2025, career: [], perSeason: {} })
  assert.ok(html.includes('Winnable Games Lost'))
})

test('renderOwnerSection shows the winnable column and dashes legacy rows', async () => {
  const { renderOwnerSection } = await import('./generate-sit-start.mjs')
  const withWinnable = renderOwnerSection(
    [
      {
        season: 2025,
        weeks: 13,
        actual: 100,
        optimal: 110,
        perfectWeeks: 1,
        efficiency: 0.909,
        perfectPct: 0.077,
        winnable: 2,
        decidedLosses: 5,
      },
    ],
    {
      weeks: 13,
      actual: 100,
      optimal: 110,
      perfectWeeks: 1,
      efficiency: 0.909,
      perfectPct: 0.077,
      winnable: 2,
      decidedLosses: 5,
    }
  )
  assert.ok(withWinnable.includes('<th scope="col" class="number">Winnable</th>'))
  assert.ok(withWinnable.includes('2 of 5 losses were winnable'))
  const legacy = renderOwnerSection(
    [{ season: 2025, weeks: 13, actual: 100, optimal: 110, perfectWeeks: 1, efficiency: 0.909, perfectPct: 0.077 }],
    null
  )
  assert.ok(legacy.includes('\u2014'))
})
