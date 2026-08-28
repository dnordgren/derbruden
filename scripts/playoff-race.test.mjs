import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  computeClinchEliminated,
  computeStandings,
  currentLeaderForGame,
  extractGames,
  standingsList,
  buildScenarios,
  DEFAULT_START_WEEK,
} from './generate-playoff-race.mjs'

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
function league(schedule, teams) {
  return { schedule, teams: teams ?? [{ id: 1, abbrev: 'A' }, { id: 2, abbrev: 'B' }, { id: 3, abbrev: 'C' }, { id: 4, abbrev: 'D' }] }
}

test('extractGames splits decided vs undecided and flags playoff', () => {
  const games = extractGames(
    league([
      matchup({ winner: 'HOME', playoffTierType: 'NONE' }),
      matchup({ matchupPeriodId: 2, winner: 'UNDECIDED', home: { teamId: 1, totalPoints: 50 }, away: { teamId: 2, totalPoints: 60 }, playoffTierType: 'NONE' }),
      matchup({ matchupPeriodId: 3, winner: 'AWAY', playoffTierType: 'WINNERS_BRACKET', home: { teamId: 1, totalPoints: 100 }, away: { teamId: 2, totalPoints: 110 } }),
    ])
  )
  assert.equal(games.length, 3)
  assert.equal(games[0].decided, true)
  assert.equal(games[0].playoff, false)
  assert.equal(games[1].decided, false)
  assert.equal(games[2].playoff, true)
})

test('computeStandings tallies wins and PF', () => {
  const teamsById = { 1: { id: 1, abbrev: 'A', name: 'A' }, 2: { id: 2, abbrev: 'B', name: 'B' } }
  const games = [
    { week: 1, homeId: 1, awayId: 2, homeScore: 100, awayScore: 90, winner: 'home', playoff: false, decided: true },
    { week: 2, homeId: 2, awayId: 1, homeScore: 80, awayScore: 85, winner: 'away', playoff: false, decided: true },
    { week: 3, homeId: 1, awayId: 2, homeScore: 90, awayScore: 90, winner: 'tie', playoff: false, decided: true },
  ]
  const stats = computeStandings(games, teamsById)
  assert.equal(stats[1].wins, 2) // 1 win + 1 win from away + tie not win but tie
  assert.equal(stats[1].ties, 1)
  assert.equal(stats[2].ties, 1)
  assert.equal(stats[1].pf, 100 + 85 + 90)
})

test('standingsList sorts by winValue then PF', () => {
  const teamsById = { 1: { id: 1, abbrev: 'A', name: 'A' }, 2: { id: 2, abbrev: 'B', name: 'B' }, 3: { id: 3, abbrev: 'C', name: 'C' } }
  const stats = {
    1: { teamId: 1, wins: 5, losses: 5, ties: 0, pf: 1000, pa: 900 },
    2: { teamId: 2, wins: 5, losses: 5, ties: 0, pf: 1100, pa: 900 },
    3: { teamId: 3, wins: 6, losses: 4, ties: 0, pf: 900, pa: 900 },
  }
  const list = standingsList(stats, teamsById)
  assert.equal(list[0].teamId, 3)
  assert.equal(list[1].teamId, 2) // PF breaks tie
  assert.equal(list[1].rank, 2)
})

test('computeClinchEliminated with 0 remaining uses PF tiebreak', () => {
  const teamsById = {
    1: { id: 1, abbrev: 'A', name: 'Team A' },
    2: { id: 2, abbrev: 'B', name: 'Team B' },
    3: { id: 3, abbrev: 'C', name: 'Team C' },
    4: { id: 4, abbrev: 'D', name: 'Team D' },
  }
  const stats = {
    1: { teamId: 1, wins: 8, losses: 5, ties: 0, pf: 1500, pa: 1300 },
    2: { teamId: 2, wins: 8, losses: 5, ties: 0, pf: 1400, pa: 1300 },
    3: { teamId: 3, wins: 6, losses: 7, ties: 0, pf: 1500, pa: 1300 },
    4: { teamId: 4, wins: 6, losses: 7, ties: 0, pf: 1300, pa: 1300 },
  }
  const res = computeClinchEliminated(stats, [], 2, teamsById)
  // top 2 make playoffs: 1 and 2 clinched
  assert.deepEqual(new Set(res.clinched), new Set([1, 2]))
  assert.deepEqual(new Set(res.eliminated), new Set([3, 4]))
})

test('computeClinchEliminated clinches with head-to-head conflicts', () => {
  // 4 teams, 2 make playoffs, 1 game remaining: 3 vs 4
  // Current: A 8-0, B 7-1, C 6-2, D 6-2
  // Remaining: C @ D (one game). So max wins: C or D can get to 7, but both cannot.
  // A worst rank: if A loses out? But A has no remaining, so A stays 8 -> rank 1 clinched.
  // B 7 wins: remaining doesn't affect B, but C/D max 7 so B could be tied 7 with one of them -> worst rank 3? If tiebreak worst, B would be 3rd (needs top2) -> not clinched? Let's design.
  const teamsById = {
    1: { id: 1, abbrev: 'A', name: 'A' },
    2: { id: 2, abbrev: 'B', name: 'B' },
    3: { id: 3, abbrev: 'C', name: 'C' },
    4: { id: 4, abbrev: 'D', name: 'D' },
  }
  const stats = {
    1: { teamId: 1, wins: 8, losses: 0, ties: 0, pf: 1000, pa: 0 },
    2: { teamId: 2, wins: 7, losses: 1, ties: 0, pf: 900, pa: 0 },
    3: { teamId: 3, wins: 6, losses: 2, ties: 0, pf: 800, pa: 0 },
    4: { teamId: 4, wins: 6, losses: 2, ties: 0, pf: 800, pa: 0 },
  }
  const remaining = [{ week: 10, homeId: 3, awayId: 4, homeScore: 0, awayScore: 0, winner: 'undecided', playoff: false }]
  const res = computeClinchEliminated(stats, remaining, 2, teamsById)
  // A clinched (worst rank 1), B worst rank 3? Let's see: if C wins, C 7 ties B 7 -> B worst 3 -> not clinched.
  assert.ok(res.clinched.includes(1))
  assert.ok(!res.clinched.includes(2))
  // D and C not clinched, but also not eliminated? D best rank 2? If D wins, D 7 ties B -> best 2 (if wins tiebreak) -> not eliminated.
  assert.ok(!res.eliminated.includes(3))
})

test('computeClinchEliminated respects ENUM_LIMIT', () => {
  const teamsById = { 1: { id: 1, abbrev: 'A', name: 'A' }, 2: { id: 2, abbrev: 'B', name: 'B' } }
  const stats = { 1: { teamId: 1, wins: 0, losses: 0, ties: 0, pf: 0, pa: 0 }, 2: { teamId: 2, wins: 0, losses: 0, ties: 0, pf: 0, pa: 0 } }
  const remaining = Array.from({ length: 25 }, (_, i) => ({ week: i + 1, homeId: 1, awayId: 2, homeScore: 0, awayScore: 0, winner: 'undecided', playoff: false }))
  const res = computeClinchEliminated(stats, remaining, 1, teamsById)
  assert.equal(res.note?.includes('too many'), true)
  assert.equal(res.clinched.length, 0)
})

test('currentLeaderForGame picks score leader', () => {
  assert.equal(currentLeaderForGame({ homeId: 1, awayId: 2, homeScore: 100, awayScore: 90, decided: false }), 1)
  assert.equal(currentLeaderForGame({ homeId: 1, awayId: 2, homeScore: 90, awayScore: 100, decided: false }), 2)
  assert.equal(currentLeaderForGame({ homeId: 1, awayId: 2, homeScore: 90, awayScore: 90, decided: false }), null)
  assert.equal(currentLeaderForGame({ homeId: 1, awayId: 2, homeScore: 100, awayScore: 90, winner: 'home', decided: true }), 1)
})

test('buildScenarios creates hold vs flip', () => {
  const teamsById = {
    1: { id: 1, abbrev: 'A', name: 'A' },
    2: { id: 2, abbrev: 'B', name: 'B' },
    3: { id: 3, abbrev: 'C', name: 'C' },
    4: { id: 4, abbrev: 'D', name: 'D' },
  }
  const stats = {
    1: { teamId: 1, wins: 5, losses: 4, ties: 0, pf: 1000, pa: 0 },
    2: { teamId: 2, wins: 5, losses: 4, ties: 0, pf: 1000, pa: 0 },
    3: { teamId: 3, wins: 5, losses: 4, ties: 0, pf: 1000, pa: 0 },
    4: { teamId: 4, wins: 5, losses: 4, ties: 0, pf: 1000, pa: 0 },
  }
  const remaining = [
    { week: 10, homeId: 1, awayId: 2, homeScore: 100, awayScore: 90, winner: 'undecided', playoff: false },
    { week: 11, homeId: 3, awayId: 4, homeScore: 0, awayScore: 0, winner: 'undecided', playoff: false },
  ]
  const sc = buildScenarios(stats, remaining, 2, teamsById)
  assert.equal(sc.currentWeek, 10)
  assert.equal(sc.currentWeekGames.length, 1)
  assert.equal(sc.hold.standings.find(r => r.teamId === 1).wins, 6) // hold winner 1 gets win
  assert.equal(sc.flip.standings.find(r => r.teamId === 2).wins, 6)
  assert.equal(sc.futureRemainingCount, 1)
})

test('DEFAULT_START_WEEK is 11', () => {
  assert.equal(DEFAULT_START_WEEK, 11)
})
