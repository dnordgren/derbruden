import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  computeDroughts,
  computeH2H,
  computeRecords,
  crossCheck,
  csvHistory,
  detectChampion,
  extractGames,
  longestWinStreak,
  makeOwnerLookup,
  parseStatsCsv,
  renderH2HChartSection,
  seasonSummaries,
} from './generate-records.js'

const ownerOf = id => `O${id}`

function matchup(overrides = {}) {
  return {
    matchupPeriodId: 1,
    home: { teamId: 1, totalPoints: 100 },
    away: { teamId: 2, totalPoints: 90 },
    winner: 'HOME',
    playoffTierType: 'NONE',
    ...overrides,
  }
}

function league(matchups, teams) {
  return { schedule: matchups, teams: teams || [] }
}

test('extractGames keeps decided games and drops unplayed ones', () => {
  const games = extractGames(
    league([
      matchup({ winner: 'HOME' }),
      matchup({
        matchupPeriodId: 2,
        winner: 'UNDECIDED',
        home: { teamId: 1, totalPoints: 0 },
        away: { teamId: 2, totalPoints: 0 },
      }),
    ]),
    2024
  )
  assert.equal(games.length, 1)
  assert.equal(games[0].week, 1)
  assert.equal(games[0].playoff, false)
})

test('extractGames flags playoff tiers and keeps lowercase ties', () => {
  const games = extractGames(
    league([
      matchup({ playoffTierType: 'WINNERS_BRACKET' }),
      matchup({
        matchupPeriodId: 2,
        winner: 'tie',
        home: { teamId: 1, totalPoints: 88.5 },
        away: { teamId: 2, totalPoints: 88.5 },
      }),
      matchup({
        matchupPeriodId: 3,
        playoffTierType: 'LOSERS_CONSOLATION_LADDER',
        winner: 'AWAY',
        home: { teamId: 1, totalPoints: 70 },
        away: { teamId: 2, totalPoints: 99 },
      }),
    ]),
    2024
  )
  assert.equal(games.length, 3)
  assert.deepEqual(
    games.map(g => g.winnersBracket),
    [true, false, false]
  )
  assert.equal(games[1].winner, 'tie')
})

test('detectChampion takes the latest winners-bracket game only', () => {
  const l = league([
    matchup({
      matchupPeriodId: 14,
      playoffTierType: 'WINNERS_BRACKET',
      winner: 'AWAY',
      home: { teamId: 1, totalPoints: 10 },
      away: { teamId: 2, totalPoints: 20 },
    }),
    matchup({
      matchupPeriodId: 15,
      playoffTierType: 'LOSERS_CONSOLATION_LADDER',
      winner: 'HOME',
      home: { teamId: 3, totalPoints: 30 },
      away: { teamId: 4, totalPoints: 5 },
    }),
    matchup({
      matchupPeriodId: 15,
      playoffTierType: 'WINNERS_BRACKET',
      winner: 'HOME',
      home: { teamId: 9, totalPoints: 55 },
      away: { teamId: 2, totalPoints: 40 },
    }),
  ])
  assert.equal(detectChampion(l), 9)
  assert.equal(detectChampion(league([matchup({ winner: 'UNDECIDED' })])), null)
})

test('computeRecords finds extremes, blowout, and tough losses', () => {
  const games = [
    g(2023, 1, 1, 2, 120.5, 60),
    g(2023, 2, 1, 2, 55.5, 50.5),
    g(2024, 1, 1, 2, 130, 129.5),
    g(2024, 2, 2, 1, 40, 140),
  ]
  const r = computeRecords(games, ownerOf, (season, id) => `T${id}`)
  assert.equal(r.highestScore.points, 140)
  assert.equal(r.highestScore.owner, 'O1')
  assert.equal(r.lowestScore.points, 40)
  assert.equal(r.lowestScore.owner, 'O2')
  assert.equal(r.biggestBlowout.margin, 100)
  assert.equal(r.biggestBlowout.owner, 'O1')
  assert.equal(r.mostPointsInALoss.points, 129.5)
  assert.equal(r.mostPointsInALoss.owner, 'O2')
  const ms = r.mostPointsInASeason
  assert.equal(ms.owner, 'O1')
  assert.equal(ms.season, 2024)
  assert.equal(ms.points, 270)
  assert.equal(ms.wins, 2)
  assert.equal(ms.losses, 0)
})

test('computeRecords hall of shame carries lowest score and best loss', () => {
  const r = computeRecords([g(2024, 1, 1, 2, 33.3, 99)], ownerOf, () => '')
  assert.equal(r.lowestScore.points, 33.3)
  assert.equal(r.lowestScore.week, 1)
  assert.equal(r.mostPointsInALoss.points, 33.3)
})

function g(season, week, homeId, awayId, homeScore, awayScore, winner) {
  if (!winner) winner = homeScore === awayScore ? 'tie' : homeScore > awayScore ? 'home' : 'away'
  return { season, week, homeId, awayId, homeScore, awayScore, playoff: false, winner }
}

test('longestWinStreak spans seasons and playoffs; ties reset it', () => {
  const games = [
    g(2023, 13, 1, 2, 100, 50),
    g(2023, 14, 1, 3, 100, 50),
    g(2023, 15, 1, 4, 100, 50, 'home'),
    g(2024, 1, 1, 2, 90, 90, 'tie'),
    g(2024, 2, 1, 2, 100, 50),
    g(2024, 3, 3, 1, 200, 10),
  ]
  const streak = longestWinStreak(games, ownerOf)
  assert.equal(streak.owner, 'O1')
  assert.equal(streak.length, 3)
  assert.equal(streak.fromSeason, 2023)
  assert.equal(streak.fromWeek, 13)
  assert.equal(streak.toSeason, 2023)
  assert.equal(streak.toWeek, 15)
})

test('computeH2H tallies both directions plus ties', () => {
  const games = [
    g(2024, 1, 1, 2, 100, 50),
    g(2024, 2, 2, 1, 100, 50),
    g(2024, 3, 1, 2, 70, 70, 'tie'),
    g(2024, 4, 1, 3, 10, 20),
  ]
  const h2h = computeH2H(games, ownerOf)
  const o1 = h2h.rows.find(r => r.owner === 'O1')
  const o2 = h2h.rows.find(r => r.owner === 'O2')
  assert.deepEqual(o1.rivals.O2, { wins: 1, losses: 1, ties: 1 })
  assert.deepEqual(o2.rivals.O1, { wins: 1, losses: 1, ties: 1 })
  assert.deepEqual(o1.rivals.O3, { wins: 0, losses: 1, ties: 0 })
  assert.ok(h2h.order.indexOf('O1') < h2h.order.indexOf('O3'))
})

test('seasonSummaries counts only regular-season W-L and winners-bracket playoffs', () => {
  const l = league([
    matchup({ matchupPeriodId: 1, winner: 'HOME' }),
    matchup({
      matchupPeriodId: 14,
      playoffTierType: 'LOSERS_CONSOLATION_LADDER',
      winner: 'HOME',
      home: { teamId: 1, totalPoints: 80 },
      away: { teamId: 2, totalPoints: 60 },
    }),
    matchup({
      matchupPeriodId: 15,
      playoffTierType: 'WINNERS_BRACKET',
      winner: 'AWAY',
      home: { teamId: 3, totalPoints: 80 },
      away: { teamId: 2, totalPoints: 95 },
    }),
    matchup({
      matchupPeriodId: 16,
      playoffTierType: 'WINNERS_BRACKET',
      winner: 'AWAY',
      home: { teamId: 2, totalPoints: 95 },
      away: { teamId: 4, totalPoints: 90 },
    }),
  ])
  const { summaries, championTeamId } = seasonSummaries(l, 2024, ownerOf)
  const t1 = summaries.find(s => s.owner === 'O1')
  assert.deepEqual({ w: t1.wins, l: t1.losses, p: t1.madePlayoffs }, { w: 1, l: 0, p: false })
  const t2 = summaries.find(s => s.owner === 'O2')
  assert.equal(t2.madePlayoffs, true)
  const t3 = summaries.find(s => s.owner === 'O3')
  assert.equal(t3.madePlayoffs, true)
  assert.equal(championTeamId, 4)
})

const CSV = `Season,Owner,W,L,%,RGPF,RGPA,TPF,DIFF,PO?,RGRnk,Champ,PORnk
16,AB,9,4,0.692,1500,1400,,,N,1,N,1
17,AB,4,9,0.308,1300,1500,,,Y,8,N,6
18,AB,4,9,0.308,1300,1500,,,N,9,N,9
19,AB,12,1,0.923,1800,1200,,,Y,1,Y,1`

test('parseStatsCsv reads records, playoff, and champion flags', () => {
  const rows = parseStatsCsv(CSV)
  assert.equal(rows.length, 4)
  assert.deepEqual(rows[1], { season: 17, owner: 'AB', wins: 4, losses: 9, playoffs: true, champion: false })
  assert.equal(rows[3].champion, true)
})

test('computeDroughts spans csv into api history and marks active runs', () => {
  const history = csvHistory(parseStatsCsv(CSV))
  history.get('AB').set(2020, true)
  history.get('AB').set(2021, false)
  history.set(
    'CD',
    new Map([
      [2019, true],
      [2020, false],
      [2021, false],
    ])
  )
  const d = computeDroughts(history, 2021)
  const ab = d.find(x => x.owner === 'AB')
  assert.equal(ab.length, 1)
  assert.equal(ab.active, true)
  const cd = d.find(x => x.owner === 'CD')
  assert.equal(cd.length, 2)
  assert.equal(cd.startYear, 2020)
  assert.equal(cd.endYear, 2021)
  assert.equal(cd.active, true)
})

test('computeDroughts skips seasons an owner sat out entirely', () => {
  const history = new Map()
  history.set(
    'EF',
    new Map([
      [2018, false],
      [2020, false],
      [2021, false],
    ])
  )
  const d = computeDroughts(history, 2021)
  assert.equal(d[0].length, 2)
  assert.equal(d[0].startYear, 2020)
})

test('crossCheck flags record mismatches against stats.csv', () => {
  const apiRows = [
    { owner: 'AB', year: 2018, wins: 4, losses: 9, madePlayoffs: false, champion: false },
    { owner: 'AB', year: 2019, wins: 12, losses: 1, madePlayoffs: true, champion: true },
  ]
  assert.deepEqual(crossCheck(apiRows, parseStatsCsv(CSV)), [])
  apiRows[1].wins = 11
  assert.match(crossCheck(apiRows, parseStatsCsv(CSV))[0], /api W=11/)
})

test('crossCheck tolerates the known 2018 stats.csv playoff over-marking', () => {
  const rows = [
    { season: 18, owner: 'JO', wins: 8, losses: 5, playoffs: true, champion: false },
    { season: 18, owner: 'DN', wins: 5, losses: 8, playoffs: true, champion: false },
  ]
  const apiRows = [
    { owner: 'JO', year: 2018, wins: 8, losses: 5, madePlayoffs: false, champion: false },
    { owner: 'DN', year: 2018, wins: 5, losses: 8, madePlayoffs: false, champion: false },
  ]
  assert.deepEqual(crossCheck(apiRows, rows), [])
})

test('makeOwnerLookup falls back to first-seen abbreviations', () => {
  const lookup = makeOwnerLookup({
    2024: { 100: { id: 100, abbrev: 'NEW', name: 'New Guy' } },
    2025: { 100: { id: 100, abbrev: 'RENAMED', name: 'Renamed' } },
  })
  assert.equal(lookup(100), 'NEW')
})

test('renderH2HChartSection embeds matrix payload and script tags', () => {
  const html = renderH2HChartSection({
    order: ['AA', 'BB'],
    rows: [
      { owner: 'AA', rivals: { BB: { wins: 3, losses: 1, ties: 0 } } },
      { owner: 'BB', rivals: { AA: { wins: 1, losses: 3, ties: 0 } } },
    ],
  })
  assert.ok(html.includes('id="records-h2h-chart"'))
  assert.ok(html.includes('id="records-h2h-data"'))
  assert.ok(html.includes('records-h2h.js?v=2'))
  const match = html.match(/id="records-h2h-data">([\s\S]*?)<\/script>/)
  assert.ok(match)
  const parsed = JSON.parse(match[1])
  assert.deepEqual(parsed.owners, ['AA', 'BB'])
  assert.deepEqual(parsed.records.AA.BB, { wins: 3, losses: 1, ties: 0 })
})

test('renderH2HChartSection returns empty string when no rows', () => {
  assert.equal(renderH2HChartSection({ order: [], rows: [] }), '')
})
