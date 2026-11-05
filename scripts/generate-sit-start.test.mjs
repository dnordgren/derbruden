import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  actualLineupScore,
  aggregateCareer,
  aggregateMwaCareer,
  aggregateMwaSeason,
  aggregateSeason,
  computeWeekAvg,
  efficiencyOf,
  EXCLUDED_OWNERS,
  findManagerWinsAdded,
  optimalLineup,
  renderOwnerSection,
  renderPageContent,
  rosterWeek,
  scoreTeamWeek,
  SLOT_COUNT_FALLBACK,
  starterSlotList,
  STARTER_SLOTS,
  weekScoreOf,
} from './generate-sit-start.mjs'

const SLOTS = starterSlotList(null)

function entry(slot, points, elig) {
  return { playerId: Math.random(), points, lineupSlotId: slot, elig }
}

test('starterSlotList uses fallback counts for the standard 9-starter lineup', () => {
  assert.deepEqual(
    SLOTS.sort((a, b) => a - b),
    [0, 2, 2, 4, 4, 6, 16, 17, 23]
  )
  assert.deepEqual(starterSlotList(SLOT_COUNT_FALLBACK).length, 9)
})

test('starterSlotList honors real mSettings counts', () => {
  const counts = { 0: 1, 2: 2, 4: 3, 6: 1, 16: 1, 17: 1, 20: 7, 23: 1 }
  const slots = starterSlotList(counts)
  assert.equal(slots.length, 10)
  assert.equal(slots.filter(s => s === 4).length, 3)
  assert.ok(!slots.includes(20))
})

test('weekScoreOf reads the actual-stat split for the week', () => {
  const player = {
    stats: [
      { statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 5, appliedTotal: 14.2 },
      { statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 6, appliedTotal: 3.1 },
      { statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 5, appliedTotal: 99 },
    ],
  }
  assert.equal(weekScoreOf(player, 5), 14.2)
  assert.equal(weekScoreOf(player, 6), 3.1)
  assert.equal(weekScoreOf(player, 7), null)
})

test('rosterWeek keeps lineupSlotId, points, and starter eligibility', () => {
  const league = {
    teams: [
      {
        id: 8,
        roster: {
          entries: [
            {
              playerId: 1,
              lineupSlotId: 0,
              playerPoolEntry: {
                player: {
                  eligibleSlots: [0],
                  stats: [{ statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 3, appliedTotal: 20 }],
                },
              },
            },
            {
              playerId: 2,
              lineupSlotId: 20, // bench
              playerPoolEntry: {
                player: {
                  eligibleSlots: [2, 23],
                  stats: [{ statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 3, appliedTotal: 25 }],
                },
              },
            },
            {
              playerId: 3, // bye week: no split
              lineupSlotId: 2,
              playerPoolEntry: { player: { eligibleSlots: [2], stats: [] } },
            },
          ],
        },
      },
    ],
  }
  const out = rosterWeek(league, 3)
  assert.equal(out[8].length, 2)
  assert.deepEqual(out[8][0], { playerId: 1, points: 20, lineupSlotId: 0, elig: [0] })
})

test('actualLineupScore sums only starter slots', () => {
  const entries = [entry(0, 20, [0]), entry(20, 25, [2, 23]), entry(2, 10, [2])]
  assert.equal(actualLineupScore(entries), 30)
})

test('actualLineupScore keeps negative starter scores so actual matches official totals', () => {
  const entries = [entry(0, 20, [0]), entry(16, -2, [16]), entry(20, 25, [2, 23])]
  assert.equal(actualLineupScore(entries), 18)
})

test('optimalLineup fills FLEX with the best leftover', () => {
  const pool = [
    { points: 20, elig: [2] },
    { points: 18, elig: [2] },
    { points: 15, elig: [2, 23] },
    { points: 12, elig: [4] },
    { points: 11, elig: [4] },
    { points: 9, elig: [4, 23] },
  ]
  // slots: 2 RB + FLEX(23) + 2 WR
  const best = optimalLineup(pool, [2, 2, 23, 4, 4])
  assert.equal(best, 20 + 18 + 15 + 12 + 11)
})

test('optimal is never below actual for the same entries', () => {
  const entries = [
    entry(0, 12, [0]),
    entry(2, 8, [2]),
    entry(2, 22, [2, 23]),
    entry(20, 25, [2, 23]),
    entry(4, 10, [4]),
    entry(4, 9, [4]),
    entry(6, 5, [6]),
    entry(16, 7, [16]),
    entry(17, 8, [17]),
    entry(23, 3, [2, 4, 23]),
  ]
  const { actual, optimal, perfect } = scoreTeamWeek(entries, SLOTS)
  assert.ok(optimal >= actual)
  // optimal benches the 3-pt FLEX for the 25-pt RB and slides the 8-pt RB to FLEX:
  // QB12 RB22 RB25 WR10 WR9 TE5 D/ST7 K8 FLEX8 = 106
  assert.equal(optimal, 106)
  assert.equal(actual, 12 + 8 + 22 + 10 + 9 + 5 + 7 + 8 + 3)
  assert.equal(perfect, false)
})

test('perfect week detected when actual equals optimal', () => {
  const entries = [entry(0, 20, [0]), entry(2, 15, [2]), entry(20, 5, [2])]
  const slots = [0, 2]
  const { actual, optimal, perfect } = scoreTeamWeek(entries, slots)
  assert.equal(actual, 35)
  assert.equal(optimal, 35)
  assert.equal(perfect, true)
})

test('efficiencyOf handles zero optimal', () => {
  assert.equal(efficiencyOf(50, 100), 0.5)
  assert.equal(efficiencyOf(0, 0), 0)
})

test('aggregateSeason rolls up weeks, efficiency, and perfect counts', () => {
  const rows = aggregateSeason([
    { owner: 'DN', team: 'T', teamId: 8, week: 1, actual: 100, optimal: 110, perfect: false },
    { owner: 'DN', team: 'T', teamId: 8, week: 2, actual: 120, optimal: 120, perfect: true },
    { owner: 'GM', team: 'G', teamId: 1, week: 1, actual: 90, optimal: 130, perfect: false },
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].owner, 'DN') // higher efficiency first
  assert.equal(rows[0].weeks, 2)
  assert.equal(rows[0].actual, 220)
  assert.equal(rows[0].optimal, 230)
  assert.equal(rows[0].perfectWeeks, 1)
  assert.equal(rows[0].perfectPct, 0.5)
  assert.ok(rows[0].rank === 1 && rows[1].rank === 2)
})

test('aggregateCareer weights by totals, not by averaging efficiencies', () => {
  const career = aggregateCareer({
    2024: [
      { owner: 'DN', team: 'T', teamId: 8, weeks: 10, actual: 1000, optimal: 1100, perfectWeeks: 2 },
      { owner: 'GM', team: 'G', teamId: 1, weeks: 10, actual: 900, optimal: 1000, perfectWeeks: 1 },
    ],
    2025: [{ owner: 'DN', team: 'T', teamId: 8, weeks: 5, actual: 600, optimal: 610, perfectWeeks: 3 }],
  })
  const dn = career.find(r => r.owner === 'DN')
  assert.equal(dn.weeks, 15)
  assert.equal(dn.seasons, 2)
  assert.equal(dn.efficiency, 0.936) // 1600/1710, not mean(0.909, 0.984)
  assert.equal(dn.perfectWeeks, 5)
})

test('STARTER_SLOTS covers the nine starting positions', () => {
  for (const s of [0, 2, 4, 6, 16, 17, 23]) assert.ok(STARTER_SLOTS.has(s))
  assert.ok(!STARTER_SLOTS.has(20) && !STARTER_SLOTS.has(21))
})

test('excluded owners never appear in season or career aggregates', () => {
  assert.ok(EXCLUDED_OWNERS.has('SHEN'))
  const weekRows = [
    { owner: 'SHEN', team: 'GuiceBox', teamId: 6, week: 1, actual: 100, optimal: 110, perfect: false },
    { owner: 'DN', team: 'T', teamId: 8, week: 1, actual: 90, optimal: 100, perfect: false },
  ]
  const season = aggregateSeason(weekRows)
  assert.ok(!season.some(r => r.owner === 'SHEN'))
  assert.deepEqual(
    season.map(r => r.owner),
    ['DN']
  )
  const career = aggregateCareer({ 2018: season })
  assert.ok(!career.some(r => r.owner === 'SHEN'))
})

test('upsertOwnerPage places sit/start ahead of draft history', async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { renderOwnerSection, upsertOwnerPage, SITSTART_START, SITSTART_END } = await import('./generate-sit-start.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'sitstart-'))
  const page = join(dir, 'dn.html')
  const section = renderOwnerSection(
    [{ season: 2025, weeks: 13, actual: 100, optimal: 110, perfectWeeks: 1, efficiency: 0.909, perfectPct: 0.077 }],
    { weeks: 13, actual: 100, optimal: 110, perfectWeeks: 1, efficiency: 0.909, perfectPct: 0.077 }
  )
  // Existing section sits after drafts: upsert must move it ahead.
  writeFileSync(page, '<main><!-- DRAFT_HISTORY_START -->drafts<!-- DRAFT_HISTORY_END -->' + section + '</main>')
  const status = upsertOwnerPage(page, section)
  assert.equal(status, 'moved')
  const out = readFileSync(page, 'utf8')
  assert.ok(out.indexOf(SITSTART_START) !== -1 && out.indexOf(SITSTART_END) !== -1)
  assert.ok(out.indexOf(SITSTART_START) < out.indexOf('<!-- DRAFT_HISTORY_START -->'))
  assert.equal(out.indexOf(SITSTART_START), out.lastIndexOf(SITSTART_START))
})

test('loadWinPct maps two-digit csv seasons to full years', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { loadWinPct } = await import('./generate-sit-start.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'winpct-'))
  const csv = join(dir, 'stats.csv')
  writeFileSync(csv, 'Season,Owner,W,L\n25,DN,8,5\n24,DN,4,9\n')
  const map = loadWinPct(csv)
  assert.deepEqual(map.DN[2025], { wins: 8, losses: 5, winPct: 0.615 })
  assert.deepEqual(map.DN[2024], { wins: 4, losses: 9, winPct: 0.308 })
  assert.equal(map.DN[2026], undefined)
})

// Merged from generate-mwa.test.mjs: MWA (Manager Wins Added) coverage
// lives with the sit-start tests since it exercises generate-sit-start.mjs.
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
  const html = renderPageContent({ defaultSeason: 2025, career: [], perSeason: {} })
  assert.ok(html.includes('Manager Wins Added'))
})

test('renderOwnerSection shows Stolen/Avoidable/MWA columns, no Winnable column, and dashes legacy rows', async () => {
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
