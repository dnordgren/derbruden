import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TEMPLATE_13,
  WEEK_14,
  computeAllPlay,
  seedOrder,
  simulateSeason,
  playoffFields,
} from './generate-relegation.mjs'

test('template: every week is a perfect matching of slots 0-9', () => {
  for (const week of [...TEMPLATE_13, WEEK_14]) {
    assert.equal(week.length, 5)
    const slots = week.flat().sort((a, b) => a - b)
    assert.deepEqual(slots, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  }
})

test('template: intra-division pairs meet twice, cross pairs once over 13 weeks', () => {
  const counts = new Map()
  for (const week of TEMPLATE_13) {
    for (const [a, b] of week) {
      const key = `${Math.min(a, b)}-${Math.max(a, b)}`
      counts.set(key, (counts.get(key) || 0) + 1)
    }
  }
  assert.equal(counts.size, 45)
  for (const [key, n] of counts) {
    const [a, b] = key.split('-').map(Number)
    const sameDiv = a < 5 === b < 5
    assert.equal(n, sameDiv ? 2 : 1, `pair ${key}`)
  }
})

function weeklyFromScores(perTeam) {
  // perTeam: { id: [week1pts, week2pts, ...] }
  const weekly = new Map()
  for (const [id, scores] of Object.entries(perTeam)) {
    weekly.set(Number(id), new Map(scores.map((pts, i) => [i + 1, pts])))
  }
  return weekly
}

test('computeAllPlay: a team that outscores everyone every week is 100%', () => {
  const weekly = weeklyFromScores({ 1: [100, 100], 2: [90, 80], 3: [80, 90] })
  const rows = computeAllPlay(weekly)
  assert.equal(rows.get(1).pct, 1)
  assert.equal(rows.get(1).w, 4)
  assert.equal(rows.get(2).pf, 170)
})

test('seedOrder ranks by all-play pct, PF tiebreak', () => {
  const weekly = weeklyFromScores({ 1: [100], 2: [95], 3: [90] })
  assert.deepEqual(seedOrder(weekly, [], 'allplay'), [1, 2, 3])
})

test('simulateSeason: constant scores produce a sweep for the top seed', () => {
  // 13 weeks, team in slot 0 scores 200 weekly, everyone else less,
  // descending by slot so standings must come out in slot order by PF.
  const perTeam = {}
  const order = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]
  order.forEach((id, slot) => {
    perTeam[id] = Array(13).fill(200 - slot * 10)
  })
  const weekly = weeklyFromScores(perTeam)
  const sim = simulateSeason(weekly, order)
  assert.equal(sim.standings[0].id, 11)
  assert.equal(sim.standings[0].w, 13)
  assert.equal(sim.standings[9].l, 13)
  assert.equal(sim.medianMargin, 30)
  assert.equal(sim.close10Pct, 26.2)
  // Top seed is in division A and logged 8 divisional games.
  const top = sim.standings[0]
  assert.equal(top.divW + top.divL + top.divT, 8)
})

test('playoffFields: division winners are protected in winners variants only', () => {
  // B-division leader has the 8th-best record but the best PF in B.
  const standings = [
    { id: 1, w: 10, l: 3, t: 0, pf: 1500 },
    { id: 2, w: 9, l: 4, t: 0, pf: 1450 },
    { id: 3, w: 9, l: 4, t: 0, pf: 1400 },
    { id: 4, w: 8, l: 5, t: 0, pf: 1380 },
    { id: 5, w: 8, l: 5, t: 0, pf: 1350 },
    { id: 6, w: 7, l: 6, t: 0, pf: 1330 },
    { id: 7, w: 7, l: 6, t: 0, pf: 1300 },
    { id: 8, w: 5, l: 8, t: 0, pf: 1520 },
    { id: 9, w: 4, l: 9, t: 0, pf: 1200 },
    { id: 10, w: 3, l: 10, t: 0, pf: 1100 },
  ]
  const divisionOf = new Map([
    [1, 'A'],
    [2, 'A'],
    [3, 'A'],
    [4, 'A'],
    [5, 'A'],
    [6, 'B'],
    [7, 'B'],
    [8, 'B'],
    [9, 'B'],
    [10, 'B'],
  ])
  const fields = playoffFields(standings, divisionOf)
  assert.ok(!fields.straight.includes(8))
  assert.ok(fields.winnersPlusRecord.includes(6)) // B winner by record
  assert.ok(!fields.winnersPlusRecord.includes(8))
  assert.equal(fields.straight.length, 6)
  assert.equal(fields.winnersPlusRecord.length, 6)
  assert.equal(fields.winnersPlusPf.length, 6)
})
