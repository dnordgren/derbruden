import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractWeeklyGames,
  buildHistory,
  rankDesc,
  ordinal,
  detectBlowout,
  detectHighScoreLoss,
  detectLowScoreWin,
  detectTopPlayerShare,
  detectBenchFlip,
  detectHeartbreaker,
  detectHardLuck,
  mondayFlip,
  detectMondayFlip,
  detectH2HStreak,
  optimalLineupTotal,
  isPerfectWeek,
  detectPerfectWeek,
  detectMilestones,
  detectFutility,
  detectPlayerRecord,
  parseArgs,
  currentCacheFiles,
  clearCurrentCache,
  snapshotWeek,
  liveGames,
  weekScoreOf,
  rosterWeek,
} from './generate-wacky-stat.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TEAMS = {
  1: { id: 1, name: 'Alpha', owner: 'AA' },
  2: { id: 2, name: 'Beta', owner: 'BB' },
}

function game(season, week, winnerPts, loserPts, winnerId = 1, loserId = 2) {
  return {
    season,
    week,
    homeId: winnerId,
    awayId: loserId,
    homePts: winnerPts,
    awayPts: loserPts,
    winnerId,
    loserId,
    winnerPts,
    loserPts,
    margin: winnerPts - loserPts,
  }
}

test('extractWeeklyGames keeps decided regular-season games only', () => {
  const league = {
    schedule: [
      {
        matchupPeriodId: 1,
        winner: 'HOME',
        playoffTierType: 'NONE',
        home: { teamId: 1, totalPoints: 120 },
        away: { teamId: 2, totalPoints: 100 },
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
        home: { teamId: 1, totalPoints: 90 },
        away: { teamId: 2, totalPoints: 95 },
      },
    ],
  }
  const games = extractWeeklyGames(league, 2026)
  assert.equal(games.length, 1)
  assert.equal(games[0].margin, 20)
  assert.equal(games[0].winnerId, 1)
})

test('buildHistory excludes the target week and later seasons', () => {
  const map = new Map([
    [2025, [game(2025, 13, 150, 90)]],
    [2026, [game(2026, 8, 140, 95), game(2026, 9, 160, 80)]],
  ])
  const history = buildHistory(map, 2026, 9)
  assert.equal(history.length, 2)
  assert.ok(history.every(g => g.season < 2026 || g.week < 9))
})

test('rankDesc ranks and finds the most recent greater entry', () => {
  const entries = [game(2024, 3, 170, 90), game(2025, 7, 165, 95), game(2023, 1, 130, 100)]
  const { rank, lastGreater } = rankDesc(entries, 60, g => g.margin)
  assert.equal(rank, 3)
  assert.equal(lastGreater.season, 2025)
  assert.equal(rankDesc(entries, 85, g => g.margin).lastGreater, null)
})

test('ordinal handles the teens', () => {
  assert.equal(ordinal(1), '1st')
  assert.equal(ordinal(2), '2nd')
  assert.equal(ordinal(3), '3rd')
  assert.equal(ordinal(11), '11th')
  assert.equal(ordinal(23), '23rd')
})

test('detectBlowout reports rank against history', () => {
  const history = [game(2025, 1, 170, 90), game(2025, 2, 140, 100)]
  const [cand] = detectBlowout([game(2026, 9, 160, 95)], history, TEAMS)
  assert.equal(cand.type, 'blowout')
  assert.equal(cand.facts.rank, 2)
  assert.match(cand.headline, /largest since Week 1, 2025/)
})

test('detectHighScoreLoss and detectLowScoreWin rank the right tails', () => {
  const history = [game(2025, 1, 170, 130), game(2025, 2, 110, 60)]
  const [loss] = detectHighScoreLoss([game(2026, 9, 150, 140)], history, TEAMS)
  assert.equal(loss.facts.rank, 1)
  const [win] = detectLowScoreWin([game(2026, 9, 95, 80)], history, TEAMS)
  assert.equal(win.facts.rank, 1)
})

test('detectTopPlayerShare ranks against prior weeks of the season', () => {
  const roster = pts => ({
    1: {
      starters: [
        { name: 'Star', points: pts, lineupSlotId: 0, elig: [0] },
        { name: 'Other', points: 35, lineupSlotId: 2, elig: [2] },
      ],
      bench: [],
    },
  })
  const games = [game(2026, 9, 100, 80)]
  const [cand] = detectTopPlayerShare(games, roster(45), [roster(30)], TEAMS)
  assert.equal(cand.type, 'one-man-team')
  assert.equal(cand.facts.rank, 1)
  assert.equal(cand.facts.share, 0.56)
})

test('rarity floor suppresses a blowout ranked worse than 30th', () => {
  const history = []
  for (let i = 0; i < 35; i++) history.push(game(2025, (i % 13) + 1, 200 - i, 90))
  assert.deepEqual(detectBlowout([game(2026, 9, 160, 95)], history, TEAMS), [])
  const [cand] = detectBlowout([game(2026, 9, 160, 95)], history, TEAMS, 40)
  assert.equal(cand.facts.rank, 36)
})

test('detectHeartbreaker ranks the closest game and respects the floor', () => {
  const history = [game(2025, 1, 130, 100), game(2025, 2, 120, 110)]
  const [cand] = detectHeartbreaker([game(2026, 9, 101, 100)], history, TEAMS)
  assert.equal(cand.type, 'heartbreaker')
  assert.equal(cand.facts.rank, 1)
})

test('detectHardLuck fires when a loser would have beaten 8 of 9', () => {
  const week = [
    game(2026, 9, 135, 130, 1, 2),
    game(2026, 9, 110, 90, 3, 4),
    game(2026, 9, 105, 95, 5, 6),
    game(2026, 9, 100, 85, 7, 8),
    game(2026, 9, 98, 80, 9, 10),
  ]
  const teams = {}
  for (let i = 1; i <= 10; i++) teams[i] = { id: i, name: `T${i}`, owner: `O${i}` }
  const history = [game(2025, 1, 120, 70, 1, 2), game(2025, 1, 115, 75, 3, 4)]
  const [cand] = detectHardLuck(week, history, teams)
  assert.equal(cand.type, 'hard-luck')
  assert.equal(cand.facts.wouldBeat, 8)
  assert.equal(cand.facts.prior, 0)
  const quiet = [game(2026, 9, 135, 100, 1, 2), ...week.slice(1)]
  assert.deepEqual(detectHardLuck(quiet, history, teams), [])
})

test('mondayFlip reconstructs the pre-MNF lead and detectMondayFlip ranks it', () => {
  const g = { ...game(2026, 9, 105, 100, 2, 1), homeId: 1, awayId: 2, homePts: 100, awayPts: 105 }
  const rosters = {
    1: { starters: [{ name: 'H', points: 100, proTeamId: 3, lineupSlotId: 0, elig: [0] }], bench: [] },
    2: {
      starters: [
        { name: 'Monday Star', points: 30, proTeamId: 7, lineupSlotId: 2, elig: [2] },
        { name: 'Sunday Guy', points: 75, proTeamId: 4, lineupSlotId: 0, elig: [0] },
      ],
      bench: [],
    },
  }
  const flip = mondayFlip(g, rosters, new Set([7]))
  assert.equal(flip.blownLead, 25)
  assert.equal(flip.winnerMondayPts, 30)
  assert.equal(flip.topScorer.name, 'Monday Star')
  const [cand] = detectMondayFlip([g], rosters, new Set([7]), [30, 28], TEAMS)
  assert.equal(cand.facts.rank, 3)
  assert.deepEqual(detectMondayFlip([g], rosters, new Set([7]), Array(31).fill(40), TEAMS), [])
  // No Monday players for the winner -> lead holds -> no flip.
  assert.equal(mondayFlip(g, rosters, new Set([99])), null)
})

test('detectH2HStreak fires at five straight wins over the same opponent', () => {
  const history = [1, 2, 3, 4].map(w => game(2025, w, 120, 100, 1, 2))
  const [cand] = detectH2HStreak([game(2026, 9, 110, 90, 1, 2)], history, TEAMS)
  assert.equal(cand.facts.streak, 5)
  const short = [1, 2, 3].map(w => game(2025, w, 120, 100, 1, 2))
  assert.deepEqual(detectH2HStreak([game(2026, 9, 110, 90, 1, 2)], short, TEAMS), [])
})

test('optimalLineupTotal and isPerfectWeek agree with the sit/start convention', () => {
  const mk = (name, points, slot, elig) => ({ name, points, lineupSlotId: slot, elig })
  const perfect = {
    starters: [mk('QB1', 20, 0, [0]), mk('RB1', 15, 2, [2, 23])],
    bench: [mk('RB2', 10, 20, [2, 23])],
  }
  assert.equal(isPerfectWeek(perfect), true)
  const flawed = {
    starters: [mk('QB1', 20, 0, [0]), mk('RB1', 15, 2, [2, 23])],
    bench: [mk('RB2', 18, 20, [2, 23])],
  }
  assert.equal(isPerfectWeek(flawed), false)
  assert.equal(optimalLineupTotal([...flawed.starters, ...flawed.bench], [0, 2]), 38)
})

test('detectMilestones fires when a career threshold is crossed that week', () => {
  const history = []
  for (let i = 0; i < 49; i++) history.push(game(2024, (i % 13) + 1, 120, 100, 1, 2))
  const out = detectMilestones([game(2026, 9, 110, 90, 1, 2)], history, TEAMS)
  assert.ok(out.some(c => c.facts.kind === 'wins' && c.facts.value === 50))
})

test('detectFutility catches a snapped losing streak and a sub-100 streak', () => {
  const history = [1, 2, 3, 4, 5].map(w => game(2026, w, 130, 95, 2, 1))
  const out = detectFutility([game(2026, 9, 105, 99, 1, 2)], history, TEAMS)
  assert.ok(out.some(c => c.facts.kind === 'streak-snapped' && c.facts.streak === 5))
  const drought = [1, 2, 3].map(w => game(2026, w, 120, 90, 2, 1))
  const out2 = detectFutility([game(2026, 9, 125, 92, 2, 1)], drought, TEAMS)
  assert.ok(out2.some(c => c.facts.kind === 'sub-100-streak' && c.facts.streak === 4))
})

test('detectPlayerRecord ranks a positional game against history', () => {
  const rosters = {
    1: { starters: [{ name: 'QB Hero', points: 38, pos: 1, proTeamId: 1, lineupSlotId: 0, elig: [0] }], bench: [] },
    2: { starters: [], bench: [] },
  }
  const playerHistory = [
    { pos: 1, points: 40 },
    { pos: 1, points: 35 },
    { pos: 2, points: 50 },
  ]
  const [cand] = detectPlayerRecord([game(2026, 9, 110, 90)], rosters, playerHistory, TEAMS)
  assert.equal(cand.facts.rank, 2)
  assert.equal(cand.facts.pos, 'QB')
})

test('detectBenchFlip fires only when the swap flips the result', () => {
  const rosters = {
    2: {
      starters: [{ name: 'Starter', points: 5, lineupSlotId: 4, elig: [4] }],
      bench: [{ name: 'Bench Star', points: 30, lineupSlotId: 20, elig: [4, 23] }],
    },
  }
  const [flip] = detectBenchFlip([game(2026, 9, 110, 100)], rosters, TEAMS)
  assert.equal(flip.type, 'bench-flip')
  assert.equal(flip.facts.netGain, 15)
  assert.deepEqual(detectBenchFlip([game(2026, 9, 140, 100)], rosters, TEAMS), [])
})

test('parseArgs: fresh/snapshot default off and parse as flags', () => {
  const base = parseArgs([])
  assert.equal(base.fresh, false)
  assert.equal(base.snapshot, false)
  assert.equal(parseArgs(['--fresh']).fresh, true)
  assert.equal(parseArgs(['--snapshot']).snapshot, true)
  assert.throws(() => parseArgs(['--bogus']), /Unknown argument/)
})

test('currentCacheFiles: season phase names the season file, week phase names only week files', () => {
  assert.deepEqual(currentCacheFiles(2026), ['season-2026.json'])
  assert.deepEqual(currentCacheFiles(2026, 10), ['roster-2026-10.json', 'nfl-2026-10.json'])
})

test('clearCurrentCache two-phase flow keeps the re-fetched season file and history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wacky-cache-'))
  for (const name of [
    'season-2026.json',
    'roster-2026-10.json',
    'nfl-2026-10.json',
    'season-2019.json',
    'roster-2026-9.json',
  ]) {
    fs.writeFileSync(path.join(dir, name), '{}')
  }
  // Mirror main(): phase 1 clears the season file, the league is
  // re-fetched live (rewriting it), phase 2 clears the week files.
  clearCurrentCache(2026, null, dir)
  assert.equal(fs.existsSync(path.join(dir, 'season-2026.json')), false)
  fs.writeFileSync(path.join(dir, 'season-2026.json'), '{"refetched":true}')
  clearCurrentCache(2026, 10, dir)
  // Regression: the re-fetched season file must survive phase 2.
  assert.equal(fs.existsSync(path.join(dir, 'season-2026.json')), true)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['roster-2026-9.json', 'season-2019.json', 'season-2026.json'])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('snapshotWeek prefers the league current scoring period', () => {
  assert.equal(snapshotWeek({ scoringPeriodId: 10, schedule: [] }), 10)
  const decided = (week, winner) => ({
    matchupPeriodId: week,
    playoffTierType: 'NONE',
    winner,
    home: { teamId: 1, totalPoints: 100 },
    away: { teamId: 2, totalPoints: 90 },
  })
  // Thursday game of week 10 is final, week 10 still in progress:
  // scoringPeriodId wins over lastCompletedWeek (which would say 10 -> 11).
  assert.equal(snapshotWeek({ scoringPeriodId: 10, schedule: [decided(9, 'HOME'), decided(10, 'AWAY')] }), 10)
  // Fallback when the payload lacks scoringPeriodId.
  assert.equal(snapshotWeek({ schedule: [decided(9, 'HOME')] }), 10)
})

test('parseArgs: --live defaults off and parses', () => {
  assert.equal(parseArgs([]).live, false)
  assert.equal(parseArgs(['--live']).live, true)
})

const LIVE_LEAGUE = {
  schedule: [
    { matchupPeriodId: 10, playoffTierType: 'NONE', home: { teamId: 1 }, away: { teamId: 2 } },
    { matchupPeriodId: 10, playoffTierType: 'NONE', home: { teamId: 3 }, away: { teamId: 4 } },
    { matchupPeriodId: 10, playoffTierType: 'NONE', home: { teamId: 5 }, away: { teamId: 6 } },
    { matchupPeriodId: 10, playoffTierType: 'WINNERS_BRACKET', home: { teamId: 7 }, away: { teamId: 8 } },
    { matchupPeriodId: 9, playoffTierType: 'NONE', home: { teamId: 1 }, away: { teamId: 3 } },
  ],
}
const rosterOf = (starterPts, benchPts = []) => ({
  starters: starterPts.map(points => ({ points })),
  bench: benchPts.map(points => ({ points })),
})

test('liveGames sums starters only, picks the provisional winner, rounds to 2dp', () => {
  const rosters = {
    1: rosterOf([60.1, 40.2], [99.9]), // bench points must not count
    2: rosterOf([50.05, 30.05]),
  }
  const games = liveGames(LIVE_LEAGUE, 2026, 10, rosters)
  assert.equal(games.length, 1) // other matchups lack rosters / are playoff / wrong week
  const g = games[0]
  assert.equal(g.homePts, 100.3)
  assert.equal(g.awayPts, 80.1)
  assert.equal(g.winnerId, 1)
  assert.equal(g.loserId, 2)
  assert.equal(g.winnerPts, 100.3)
  assert.equal(g.loserPts, 80.1)
  assert.equal(g.margin, 20.2)
  assert.equal(g.provisional, true)
})

test('liveGames skips an exactly tied matchup (no provisional winner yet)', () => {
  const rosters = { 1: rosterOf([50]), 2: rosterOf([25, 25]) }
  assert.deepEqual(liveGames(LIVE_LEAGUE, 2026, 10, rosters), [])
})

test('weekScoreOf returns null without an actual split (projection/other week only)', () => {
  const player = {
    stats: [
      { statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 11, appliedTotal: 30.1 },
      { statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 10, appliedTotal: 22.5 },
    ],
  }
  assert.equal(weekScoreOf(player, 11), null)
  assert.equal(weekScoreOf(player, 10), 22.5)
})

test('rosterWeek scores not-yet-played players 0, never the stale pool total (issue #71)', () => {
  // Week 11 live: JSN has only a projection entry; his appliedStatTotal
  // is his most recent completed game, not this week's score. CMC's real
  // line has posted and must come through unchanged.
  const raw = {
    teams: [
      {
        id: 1,
        roster: {
          entries: [
            {
              playerId: 1,
              lineupSlotId: 20,
              playerPoolEntry: {
                appliedStatTotal: 30.1,
                player: {
                  fullName: 'Jaxon Smith-Njigba',
                  defaultPositionId: 3,
                  proTeamId: 12,
                  eligibleSlots: [2, 23],
                  stats: [{ statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 11, appliedTotal: 31.2 }],
                },
              },
            },
            {
              playerId: 2,
              lineupSlotId: 2,
              playerPoolEntry: {
                appliedStatTotal: 47.8,
                player: {
                  fullName: 'Christian McCaffrey',
                  defaultPositionId: 2,
                  proTeamId: 25,
                  eligibleSlots: [2, 23],
                  stats: [{ statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 11, appliedTotal: 1.4 }],
                },
              },
            },
          ],
        },
      },
    ],
  }
  const week = rosterWeek(raw, 11)
  const bench = week[1].bench.find(p => p.name === 'Jaxon Smith-Njigba')
  assert.equal(bench.points, 0)
  assert.equal(bench.played, false)
  const starter = week[1].starters.find(p => p.name === 'Christian McCaffrey')
  assert.equal(starter.points, 1.4)
  assert.equal(starter.played, true)
})

test('detectBenchFlip skips unplayed pairs in live mode, still fires on a completed-week DNP', () => {
  const rosters = {
    2: {
      starters: [{ name: 'Pending Starter', points: 0, played: false, lineupSlotId: 4, elig: [4] }],
      bench: [{ name: 'Banked Bench', points: 21.92, played: true, lineupSlotId: 20, elig: [4, 23] }],
    },
  }
  const games = [game(2026, 11, 100, 84.3, 1, 2)]
  // Live: the starter has no actual line, so "flips the game" is
  // undecidable -> skipped (accepted gap: it never surfaces later).
  assert.deepEqual(detectBenchFlip(games, rosters, TEAMS, true), [])
  // Completed week: a 0 is final (DNP) -> the flip is a real fact.
  const [flip] = detectBenchFlip(games, rosters, TEAMS, false)
  assert.equal(flip.type, 'bench-flip')
  assert.equal(flip.facts.netGain, 6.22)
})

test('isPerfectWeek is false for an all-zero lineup (live week, nobody kicked off)', () => {
  const notYet = {
    starters: [
      { name: 'QB1', points: 0, lineupSlotId: 0, elig: [0] },
      { name: 'RB1', points: 0, lineupSlotId: 2, elig: [2, 23] },
    ],
    bench: [{ name: 'RB2', points: 0, lineupSlotId: 20, elig: [2, 23] }],
  }
  assert.equal(isPerfectWeek(notYet), false)
})

test('detectPerfectWeek holds a roster with pending players in live mode only', () => {
  const rosters = {
    1: {
      starters: [
        { name: 'Played', points: 20, played: true, lineupSlotId: 0, elig: [0] },
        { name: 'Pending', points: 0, played: false, lineupSlotId: 2, elig: [2, 23] },
      ],
      bench: [{ name: 'Bench', points: 0, played: false, lineupSlotId: 20, elig: [2, 23] }],
    },
  }
  const games = [game(2026, 11, 20, 10, 1, 2)]
  // Live: pending players could still spoil the lineup -> hold.
  assert.deepEqual(detectPerfectWeek(games, rosters, TEAMS, 0, true), [])
  // Completed: 0s are final, the lineup was perfect.
  const [cand] = detectPerfectWeek(games, rosters, TEAMS, 0, false)
  assert.equal(cand.type, 'perfect-week')
})
