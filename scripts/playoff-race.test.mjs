import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  computeClinchEliminated,
  computeDiaperFate,
  computeOdds,
  computePivotalGames,
  computeScoreStats,
  computeStandings,
  currentLeaderForGame,
  extractGames,
  gameWinProb,
  hashSeed,
  mulberry32,
  normalCdf,
  standingsList,
  buildScenarios,
  raceDataEqual,
  renderStandingsTable,
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

test('raceDataEqual ignores only the generated date', () => {
  const a = { generated: '2026-11-16', season: 2026, throughWeek: 10, remainingCount: 15, clinchedOwners: ['DM'] }
  const b = { generated: '2026-11-23', season: 2026, throughWeek: 10, remainingCount: 15, clinchedOwners: ['DM'] }
  assert.equal(raceDataEqual(a, b), true)
  assert.equal(raceDataEqual(a, { ...b, generated: '2026-11-16' }), true)
})

test('raceDataEqual detects real race changes', () => {
  const a = { generated: '2026-11-16', season: 2026, throughWeek: 10, remainingCount: 15, clinchedOwners: [] }
  assert.equal(raceDataEqual(a, { ...a, throughWeek: 11 }), false)
  assert.equal(raceDataEqual(a, { ...a, remainingCount: 10 }), false)
  assert.equal(raceDataEqual(a, { ...a, clinchedOwners: ['DM'] }), false)
  assert.equal(raceDataEqual(a, null), false)
  assert.equal(raceDataEqual(null, a), false)
})

test('computeOdds with 0 remaining resolves ties by PF', () => {
  const stats = {
    1: { teamId: 1, wins: 8, losses: 5, ties: 0, pf: 1500, pa: 0 },
    2: { teamId: 2, wins: 8, losses: 5, ties: 0, pf: 1400, pa: 0 },
    3: { teamId: 3, wins: 6, losses: 7, ties: 0, pf: 1500, pa: 0 },
    4: { teamId: 4, wins: 6, losses: 7, ties: 0, pf: 1300, pa: 0 },
  }
  const odds = computeOdds(stats, [], 2, { season: 2026 })
  assert.deepEqual(odds[1], { playoff: 100, diaper: 0 })
  assert.deepEqual(odds[2], { playoff: 100, diaper: 0 })
  assert.deepEqual(odds[3], { playoff: 0, diaper: 0 })
  assert.deepEqual(odds[4], { playoff: 0, diaper: 100 })
})

test('computeOdds splits tied teams evenly at the cut', () => {
  // A 8-0 locked; B 7-1; C and D 6-2 with C @ D left, top 2.
  // C wins -> B/C split the second spot; D wins -> B/D split it.
  // Diaper: the loser finishes alone at the bottom each time.
  const stats = {
    1: { teamId: 1, wins: 8, losses: 0, ties: 0, pf: 1200, pa: 0 },
    2: { teamId: 2, wins: 7, losses: 1, ties: 0, pf: 1100, pa: 0 },
    3: { teamId: 3, wins: 6, losses: 2, ties: 0, pf: 800, pa: 0 },
    4: { teamId: 4, wins: 6, losses: 2, ties: 0, pf: 700, pa: 0 },
  }
  const remaining = [{ week: 10, homeId: 3, awayId: 4, homeScore: 0, awayScore: 0, winner: 'undecided', playoff: false }]
  const odds = computeOdds(stats, remaining, 2, { season: 2026 })
  assert.deepEqual(odds[1], { playoff: 100, diaper: 0 })
  assert.deepEqual(odds[2], { playoff: 50, diaper: 0 })
  assert.deepEqual(odds[3], { playoff: 25, diaper: 50 })
  assert.deepEqual(odds[4], { playoff: 25, diaper: 50 })
})

test('computeOdds Monte Carlo is deterministic and bounded', () => {
  const stats = {
    1: { teamId: 1, wins: 6, losses: 2, ties: 0, pf: 1000, pa: 0 },
    2: { teamId: 2, wins: 2, losses: 6, ties: 0, pf: 800, pa: 0 },
  }
  const remaining = Array.from({ length: 25 }, (_, i) => ({ week: i + 1, homeId: 1, awayId: 2, homeScore: 0, awayScore: 0, winner: 'undecided', playoff: false }))
  const a = computeOdds(stats, remaining, 1, { season: 2026 })
  const b = computeOdds(stats, remaining, 1, { season: 2026 })
  assert.deepEqual(a, b)
  for (const id of [1, 2]) {
    assert.ok(a[id].playoff >= 0 && a[id].playoff <= 100)
    assert.ok(a[id].diaper >= 0 && a[id].diaper <= 100)
  }
  // 6-2 vs 2-6 with 25 head-to-head coin flips: leader wins ~79% (exact)
  assert.ok(a[1].playoff >= 70 && a[1].playoff <= 90)
  assert.ok(a[2].diaper >= 70 && a[2].diaper <= 90)
  // different season seed input still runs (seed covers inputs; just check shape)
  const c = computeOdds(stats, remaining, 1, { season: 2025 })
  assert.ok(c[1].playoff >= 0 && c[1].playoff <= 100)
})

test('mulberry32 and hashSeed are deterministic', () => {
  assert.equal(hashSeed('abc'), hashSeed('abc'))
  const r1 = mulberry32(42)
  const r2 = mulberry32(42)
  assert.equal(r1(), r2())
  assert.ok(r1() >= 0 && r1() < 1)
})

test('renderStandingsTable renders PO% and D% columns', () => {
  const standings = [
    { rank: 1, teamId: 1, owner: 'A', abbrev: 'A', name: 'A', wins: 8, losses: 0, ties: 0, pf: 1000, playoffPct: 98, diaperPct: 0, remaining: 0 },
    { rank: 2, teamId: 2, owner: 'B', abbrev: 'B', name: 'B', wins: 0, losses: 8, ties: 0, pf: 700, playoffPct: 0, diaperPct: 71, remaining: 0 },
  ]
  const html = renderStandingsTable(standings, new Set(), new Set([2]), new Set([2]), new Set())
  assert.ok(html.includes('<th class="number">PO%</th>'))
  assert.ok(html.includes('<th class="number">D%</th>'))
  assert.ok(html.includes('<td class="number">98</td>'))
  assert.ok(html.includes('<td class="number">71</td>'))
})

test('normalCdf and gameWinProb behave', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6)
  assert.ok(normalCdf(1.96) > 0.97 && normalCdf(1.96) < 0.98)
  assert.equal(gameWinProb(120, 25, 120, 25), 0.5)
  const fav = gameWinProb(140, 25, 100, 25)
  assert.ok(fav > 0.85 && fav < 1)
  // symmetry: swapping sides complements
  assert.ok(Math.abs(fav + gameWinProb(100, 25, 140, 25) - 1) < 1e-9)
})

test('computeScoreStats blends toward league average', () => {
  const games = [
    { week: 1, homeId: 1, awayId: 2, homeScore: 120, awayScore: 100 },
    { week: 2, homeId: 2, awayId: 1, homeScore: 110, awayScore: 130 },
  ]
  const s = computeScoreStats(games)
  // team 1 scored 120+130: raw mean 125, blended toward league mean 115
  assert.ok(s[1].mean > 115 && s[1].mean < 125)
  // team 2 scored 100+110: raw mean 105, blended up toward 115
  assert.ok(s[2].mean > 105 && s[2].mean < 115)
  assert.ok(s[1].sd >= 12 && s[2].sd >= 12)
  assert.deepEqual(computeScoreStats([]), {})
})

test('computeOdds weights games by scoring strength', () => {
  // A outscores B by ~30/wk. One game left between them, both 5-3, top 1.
  const stats = {
    1: { teamId: 1, wins: 5, losses: 3, ties: 0, pf: 1040, pa: 0 },
    2: { teamId: 2, wins: 5, losses: 3, ties: 0, pf: 800, pa: 0 },
  }
  const decided = Array.from({ length: 8 }, (_, i) => ({
    week: i + 1, homeId: 1, awayId: 2,
    homeScore: 130, awayScore: 100,
  }))
  const scoreStats = computeScoreStats(decided)
  const remaining = [{ week: 9, homeId: 1, awayId: 2, homeScore: 0, awayScore: 0, winner: 'undecided', playoff: false }]
  const weighted = computeOdds(stats, remaining, 1, { season: 2026, scoreStats })
  const coinflip = computeOdds(stats, remaining, 1, { season: 2026 })
  assert.equal(coinflip[1].playoff, 50)
  assert.ok(weighted[1].playoff > 70)
  assert.equal(weighted[1].playoff + weighted[2].playoff, 100)
  assert.equal(weighted[1].diaper + weighted[2].diaper, 100)
})

test('computeOdds weighted Monte Carlo is deterministic', () => {
  const stats = {
    1: { teamId: 1, wins: 6, losses: 2, ties: 0, pf: 1100, pa: 0 },
    2: { teamId: 2, wins: 2, losses: 6, ties: 0, pf: 850, pa: 0 },
  }
  const decided = Array.from({ length: 8 }, (_, i) => ({
    week: i + 1, homeId: 1, awayId: 2, homeScore: 137.5, awayScore: 106.25,
  }))
  const scoreStats = computeScoreStats(decided)
  const remaining = Array.from({ length: 25 }, (_, i) => ({ week: i + 1, homeId: 1, awayId: 2, homeScore: 0, awayScore: 0, winner: 'undecided', playoff: false }))
  const a = computeOdds(stats, remaining, 1, { season: 2026, scoreStats })
  const b = computeOdds(stats, remaining, 1, { season: 2026, scoreStats })
  assert.deepEqual(a, b)
  // stronger team should beat its coin-flip share (79)
  assert.ok(a[1].playoff >= 79)
})

test('computePivotalGames ranks the decisive game first', () => {
  // A 8-0 locked; B 7-1; C and D 6-2. Two games left: C @ D (decisive)
  // and A @ B (matters little: A stays top-2 either way... B could fall
  // to a tie but stays in range). Top 2.
  const stats = {
    1: { teamId: 1, wins: 8, losses: 0, ties: 0, pf: 1200, pa: 0 },
    2: { teamId: 2, wins: 7, losses: 1, ties: 0, pf: 1100, pa: 0 },
    3: { teamId: 3, wins: 6, losses: 2, ties: 0, pf: 800, pa: 0 },
    4: { teamId: 4, wins: 6, losses: 2, ties: 0, pf: 700, pa: 0 },
  }
  const remaining = [
    { week: 10, homeId: 3, awayId: 4, homeScore: 0, awayScore: 0, winner: 'undecided', playoff: false },
    { week: 10, homeId: 1, awayId: 2, homeScore: 0, awayScore: 0, winner: 'undecided', playoff: false },
  ]
  const piv = computePivotalGames(stats, remaining, 2, { season: 2026, pivotSamples: 2000 })
  assert.equal(piv.length, 2)
  assert.ok(piv[0].swing >= piv[1].swing)
  const decider = piv.find(p => p.homeId === 3)
  assert.ok(decider.swing >= 50)
  const movedIds = decider.shifts.map(s => s.teamId)
  assert.ok(movedIds.includes(3) || movedIds.includes(4))
  // determinism: same inputs, same ranking
  const again = computePivotalGames(stats, remaining, 2, { season: 2026, pivotSamples: 2000 })
  assert.deepEqual(piv, again)
})

test('computePivotalGames handles no remaining games', () => {
  const stats = { 1: { teamId: 1, wins: 8, losses: 0, ties: 0, pf: 1000, pa: 0 } }
  assert.deepEqual(computePivotalGames(stats, [], 1, {}), [])
})
