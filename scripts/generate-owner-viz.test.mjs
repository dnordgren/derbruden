import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeH2H,
  computeElo,
  seedsFromStats,
  extractGames,
  renderSection,
  injectSection,
  payloadFor,
  VIZ_START,
  VIZ_END,
} from './generate-owner-viz.mjs'

const OWNERS_BY_ID = { 1: 'AA', 2: 'BB' }
const OWNERS = ['AA', 'BB']

function game(week, homeId, awayId, homeScore, awayScore, winner, playoff = false) {
  return { week, homeId, awayId, homeScore, awayScore, winner, playoff }
}

test('extractGames drops unmapped, undecided, and zero-point games', () => {
  const league = {
    teams: [{ id: 1 }, { id: 2 }],
    schedule: [
      {
        matchupPeriodId: 1,
        playoffTierType: 'WINNERS_BRACKET',
        winner: 'HOME',
        home: { teamId: 1, totalPoints: 100 },
        away: { teamId: 2, totalPoints: 90 },
      },
      {
        matchupPeriodId: 2,
        playoffTierType: 'NONE',
        winner: 'UNDECIDED',
        home: { teamId: 1, totalPoints: 0 },
        away: { teamId: 2, totalPoints: 0 },
      },
      {
        matchupPeriodId: 3,
        playoffTierType: 'NONE',
        winner: 'AWAY',
        home: { teamId: 1, totalPoints: 101.5 },
        away: { teamId: 2, totalPoints: 110.25 },
      },
    ],
  }
  const games = extractGames(league)
  assert.equal(games.length, 2)
  assert.equal(games[0].playoff, true)
  assert.equal(games[0].week, 1)
  assert.equal(games[1].winner, 'away')
  assert.equal(games[1].playoff, false)
})

test('computeH2H is symmetric and counts wins, losses, ties, pf, pa', () => {
  const seasons = [
    {
      season: 2020,
      games: [game(1, 1, 2, 120, 100, 'home'), game(2, 2, 1, 105.5, 105.5, 'tie'), game(3, 1, 2, 90, 130, 'away')],
    },
  ]
  const { records, counted, skipped } = computeH2H(seasons, OWNERS_BY_ID, OWNERS)
  assert.equal(counted, 3)
  assert.equal(skipped, 0)
  assert.deepEqual(records.AA.BB, { w: 1, l: 1, t: 1, pf: 315.5, pa: 335.5 })
  assert.deepEqual(records.BB.AA, { w: 1, l: 1, t: 1, pf: 335.5, pa: 315.5 })
})

test('computeH2H includes playoff games', () => {
  const seasons = [
    {
      season: 2020,
      games: [game(14, 1, 2, 120, 100, 'home'), game(15, 1, 2, 80, 99, 'away', true)],
    },
  ]
  const { records } = computeH2H(seasons, OWNERS_BY_ID, OWNERS)
  assert.deepEqual(records.AA.BB, { w: 1, l: 1, t: 0, pf: 200, pa: 199 })
})

test('computeH2H skips games with unmapped teams', () => {
  const seasons = [
    {
      season: 2020,
      games: [game(1, 1, 99, 120, 100, 'home'), game(2, 1, 2, 50, 60, 'away')],
    },
  ]
  const { records, counted, skipped } = computeH2H(seasons, OWNERS_BY_ID, OWNERS)
  assert.equal(counted, 1)
  assert.equal(skipped, 1)
  assert.deepEqual(records.AA.BB, { w: 0, l: 1, t: 0, pf: 50, pa: 60 })
  assert.equal(records.AA[99], undefined)
})

test('seedsFromStats derives ratings from prior season win pct', () => {
  const rows = [
    { Season: 19, Owner: 'AA', W: 10, L: 3 },
    { Season: 19, Owner: 'BB', W: 3, L: 10 },
  ]
  const seeds = seedsFromStats(rows, 2020, OWNERS_BY_ID)
  assert.equal(seeds[1], Math.round(1500 + (10 / 13 - 0.5) * 100))
  assert.equal(seeds[2], Math.round(1500 + (3 / 13 - 0.5) * 100))
})

test('seedsFromStats falls back to base rating without history', () => {
  const seeds = seedsFromStats([], 2014, OWNERS_BY_ID)
  assert.equal(seeds[1], 1500)
  assert.equal(seeds[2], 1500)
})

const EPSILON_GAME = game(1, 1, 2, 120, 100, 'home')

function expectedDelta(ratings, g) {
  const K = 20
  const homeExpected = 1 / (1 + 10 ** ((ratings[g.awayId] - ratings[g.homeId]) / 400))
  const margin = Math.abs(g.homeScore - g.awayScore)
  const base = Math.log(1 + margin / 10)
  const cap = 2.2 / ((ratings[g.homeId] - ratings[g.awayId]) * 0.001 + 2.2)
  return Math.round(K * Math.min(base * cap, 2.4) * (1 - homeExpected))
}

test('computeElo replays games and snapshots preseason plus weekly points', () => {
  const seasons = [{ season: 2020, games: [EPSILON_GAME] }]
  const statsRows = []
  const elo = computeElo(seasons, statsRows, OWNERS_BY_ID, OWNERS)

  const delta = expectedDelta({ 1: 1500, 2: 1500 }, EPSILON_GAME)
  assert.ok(delta > 0)

  assert.deepEqual(elo.seasonStarts, [[0, 2020]])
  assert.deepEqual(elo.series.AA, [
    [0, 1500],
    [1, 1500 + delta],
  ])
  assert.deepEqual(elo.series.BB, [
    [0, 1500],
    [1, 1500 - delta],
  ])
  assert.equal(elo.finals.AA, 1500 + delta)
  assert.equal(elo.finals.BB, 1500 - delta)
})

test('computeElo ignores playoff games', () => {
  const seasons = [
    {
      season: 2020,
      games: [game(1, 1, 2, 120, 100, 'home'), game(15, 1, 2, 200, 10, 'home', true)],
    },
  ]
  const elo = computeElo(seasons, [], OWNERS_BY_ID, OWNERS)
  const delta = expectedDelta({ 1: 1500, 2: 1500 }, game(1, 1, 2, 120, 100, 'home'))
  assert.deepEqual(elo.series.AA, [
    [0, 1500],
    [1, 1500 + delta],
  ])
})

test('computeElo reseeds each season from stats.csv win pct', () => {
  const seasons = [
    { season: 2019, games: [game(1, 1, 2, 120, 100, 'home')] },
    { season: 2020, games: [game(1, 2, 1, 130, 90, 'away')] },
  ]
  const statsRows = [{ Season: 19, Owner: 'BB', W: 12, L: 1 }]
  const elo = computeElo(seasons, statsRows, OWNERS_BY_ID, OWNERS)

  assert.deepEqual(elo.seasonStarts, [
    [0, 2019],
    [2, 2020],
  ])
  // Season 2020 opens from the seed, not the 2019 final rating.
  const seedAA = 1500
  const seedBB = Math.round(1500 + (12 / 13 - 0.5) * 100)
  assert.deepEqual(
    elo.series.AA.map(p => p[0]),
    [0, 1, 2, 3]
  )
  assert.equal(elo.series.AA[2][1], seedAA)
  assert.equal(elo.series.BB[2][1], seedBB)
})

test('computeElo ignores seasons without decided games', () => {
  const elo = computeElo([{ season: 2026, games: [] }], [], OWNERS_BY_ID, OWNERS)
  assert.deepEqual(elo.seasonStarts, [])
  assert.deepEqual(elo.series.AA, [])
  assert.equal(elo.finals.AA, null)
})

test('payloadFor slices per-owner data only', () => {
  const viz = {
    generated: '2026-08-25',
    pfpa: { AA: [{ season: 2014, pf: 100, pa: 90 }], BB: [] },
    elo: {
      series: { AA: [[0, 1500]], BB: [[0, 1490]] },
      seasonStarts: [[0, 2014]],
      finals: { AA: 1500, BB: 1490 },
    },
    h2h: { records: { AA: { BB: { w: 1, l: 0, t: 0, pf: 100, pa: 90 } }, BB: {} } },
    owners: OWNERS,
  }
  const payload = payloadFor('AA', viz)
  assert.deepEqual(payload.pfpa, [{ season: 2014, pf: 100, pa: 90 }])
  assert.deepEqual(payload.elo.points, [[0, 1500]])
  assert.deepEqual(payload.h2h.row.BB, { w: 1, l: 0, t: 0, pf: 100, pa: 90 })
  assert.deepEqual(payload.h2h.owners, OWNERS)
})

test('renderSection embeds JSON payload and chart mounts', () => {
  const html = renderSection({
    generated: '2026-08-25',
    owner: 'DN',
    pfpa: [],
    elo: { seasonStarts: [], points: [] },
    h2h: { owners: ['DN'], row: {} },
  })
  assert.ok(html.includes(VIZ_START))
  assert.ok(html.includes(VIZ_END))
  assert.ok(html.includes('id="viz-pfpa"'))
  assert.ok(html.includes('id="viz-elo"'))
  assert.ok(html.includes('id="viz-h2h"'))
  assert.ok(html.includes('type="application/json" id="owner-viz-data"'))
  assert.ok(html.includes('owner-charts.js?v=1'))
  const match = html.match(/<script type="application\/json" id="owner-viz-data">([\s\S]*?)<\/script>/)
  assert.ok(match)
  const parsed = JSON.parse(match[1])
  assert.equal(parsed.owner, 'DN')
})

test('injectSection replaces existing markers', () => {
  const page = `<main><p>stats</p>\n${VIZ_START}\n<old/>\n${VIZ_END}\n</main>`
  const out = injectSection(page, `${VIZ_START}\n<new/>\n${VIZ_END}`)
  assert.ok(out.includes('<new/>'))
  assert.ok(!out.includes('<old/>'))
  assert.equal(out.match(new RegExp(VIZ_START, 'g')).length, 1)
})

test('injectSection inserts before closing main on first run', () => {
  const page = '<main><p>stats</p></main>'
  const out = injectSection(page, `${VIZ_START}<new/>${VIZ_END}`)
  assert.ok(out.startsWith('<main><p>stats</p>'))
  assert.ok(out.endsWith(`${VIZ_START}<new/>${VIZ_END}\n  </main>`))
})
