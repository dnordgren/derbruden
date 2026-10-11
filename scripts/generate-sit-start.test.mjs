import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  actualLineupScore,
  aggregateCareer,
  aggregateSeason,
  efficiencyOf,
  EXCLUDED_OWNERS,
  optimalLineup,
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
