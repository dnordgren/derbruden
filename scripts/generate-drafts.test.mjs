import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  dslNflTeamId,
  escapeHtml,
  formatPickSummary,
  isFilledPick,
  pickRoundLabel,
  picksByOwner,
  seasonRange,
} from './generate-drafts.js'

test('pickRoundLabel formats round and pick number', () => {
  assert.equal(pickRoundLabel({ roundId: 3, roundPickNumber: 6 }), 'R3P6')
})

test('formatPickSummary matches the site format', () => {
  const pick = { roundId: 3, roundPickNumber: 6, overallPickNumber: 52, playerId: 1, keeper: false }
  const info = { name: 'Joe Johnson', pos: 'RB', pro: 'ATL' }
  assert.equal(formatPickSummary(pick, info), 'R3P6 (52 overall): Joe Johnson (RB, ATL)')
})

test('formatPickSummary flags keepers and missing positions', () => {
  const pick = { roundId: 1, roundPickNumber: 1, overallPickNumber: 1, playerId: 2, keeper: true }
  assert.equal(formatPickSummary(pick, { name: 'Star', pos: '', pro: 'KC' }), 'R1P1 (1 overall): Star (KC) (keeper)')
})

test('formatPickSummary handles picks without a player', () => {
  const pick = { roundId: 10, roundPickNumber: 4, overallPickNumber: 124, keeper: false }
  assert.equal(formatPickSummary(pick), 'R10P4 (124 overall): no player')
})

test('escapeHtml neutralizes markup in player names', () => {
  assert.equal(escapeHtml("Le'Veon <Bell> & Co"), "Le'Veon &lt;Bell&gt; &amp; Co")
})

test('picksByOwner groups and sorts by overall pick', () => {
  const picks = [
    { teamId: 9, overallPickNumber: 30 },
    { teamId: 2, overallPickNumber: 1 },
    { teamId: 9, overallPickNumber: 11 },
  ]
  const grouped = picksByOwner(picks)
  assert.deepEqual(
    grouped[9].map(p => p.overallPickNumber),
    [11, 30]
  )
  assert.equal(grouped[2].length, 1)
})

test('seasonRange lists seasons newest first', () => {
  assert.deepEqual(seasonRange(2018, 2021), [2021, 2020, 2019, 2018])
})

test('dslNflTeamId decodes D/ST player ids', () => {
  assert.equal(dslNflTeamId(-16030), 30)
  assert.equal(dslNflTeamId(-1), null)
  assert.equal(dslNflTeamId(4362628), null)
})

test('isFilledPick rejects pre-draft placeholder slots', () => {
  assert.equal(isFilledPick({ playerId: -1 }), false)
  assert.equal(isFilledPick({ playerId: 0 }), false)
  assert.equal(isFilledPick({ playerId: 4362628 }), true)
  assert.equal(isFilledPick({ playerId: -16030 }), true)
})
