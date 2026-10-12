import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  parseArgs,
  latestCompletedWeek,
  slimRosters,
  loadSnapshots,
  mergeSnapshot,
  missingWeeks,
  main
} from './capture-rosters.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function rosterPayload(week, rosters) {
  return {
    status: { currentScoringPeriodId: week + 1 },
    teams: Object.entries(rosters).map(([teamId, ids]) => ({
      id: Number(teamId),
      roster: { entries: ids.map(id => ({ playerId: id })) }
    }))
  }
}

test('parseArgs handles flags', () => {
  assert.deepEqual(parseArgs([]), { backfill: false, week: null, dryRun: false })
  assert.deepEqual(parseArgs(['--backfill']), { backfill: true, week: null, dryRun: false })
  assert.deepEqual(parseArgs(['--week=3']), { backfill: false, week: 3, dryRun: false })
  assert.deepEqual(parseArgs(['--dry-run']), { backfill: false, week: null, dryRun: true })
})

test('parseArgs rejects junk and conflicting modes', () => {
  assert.throws(() => parseArgs(['--nope']), /Unknown argument/)
  assert.throws(() => parseArgs(['--week=0']), /Bad --week/)
  assert.throws(() => parseArgs(['--week=x']), /Bad --week/)
  assert.throws(() => parseArgs(['--backfill', '--week=2']), /not both/)
})

test('latestCompletedWeek returns the finished week', () => {
  assert.equal(latestCompletedWeek({ currentScoringPeriodId: 5 }), 4)
  assert.equal(latestCompletedWeek({ currentScoringPeriodId: 1 }), null)
  // Finished season: no currentScoringPeriodId; latest is one past the end.
  assert.equal(latestCompletedWeek({ latestScoringPeriod: 19, finalScoringPeriod: 16 }), 18)
  assert.equal(latestCompletedWeek({ currentMatchupPeriod: 2 }), 1)
  assert.equal(latestCompletedWeek({}), null)
  assert.equal(latestCompletedWeek(null), null)
})

test('slimRosters keeps team -> sorted player ids only', () => {
  const slim = slimRosters([
    { id: 2, roster: { entries: [{ playerId: 9 }, { playerId: 3 }, { playerId: -1 }, { playerId: 0 }] } },
    { id: 1, roster: { entries: [{ playerId: 7 }] } },
    { id: 3, roster: null }
  ])
  assert.deepEqual(slim, { 1: [7], 2: [3, 9], 3: [] })
})

test('mergeSnapshot adds a week and is idempotent', () => {
  let snap = loadSnapshots('/nonexistent')
  const first = mergeSnapshot(snap, 2026, 4, { 1: [10], 2: [20] })
  assert.equal(first.changed, true)
  snap = first.snapshots
  assert.deepEqual(snap.seasons['2026'][4], { 1: [10], 2: [20] })

  const again = mergeSnapshot(snap, 2026, 4, { 1: [99] })
  assert.equal(again.changed, false)
  assert.deepEqual(again.snapshots.seasons['2026'][4], { 1: [10], 2: [20] })

  const nextWeek = mergeSnapshot(snap, 2026, 5, { 1: [11] })
  assert.equal(nextWeek.changed, true)
  assert.deepEqual(Object.keys(nextWeek.snapshots.seasons['2026']).sort(), ['4', '5'])
})

test('missingWeeks fills gaps without recapturing', () => {
  const snap = loadSnapshots('/nonexistent')
  const merged = mergeSnapshot(snap, 2026, 2, { 1: [1] })
  assert.deepEqual(missingWeeks(merged.snapshots, 2026, 4), [1, 3, 4])
  assert.deepEqual(missingWeeks(merged.snapshots, 2025, 2), [1, 2])
})

test('main captures the latest completed week and skips when current', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'capture-rosters-'))
  const file = path.join(dir, 'roster-snapshots.json')
  const urls = []
  // League is in scoring period 5, so weeks 1-4 are complete and the
  // default (non-backfill) run should capture exactly week 4.
  const fetchImpl = async (url) => {
    urls.push(url)
    const sp = Number(new URL(url).searchParams.get('scoringPeriodId'))
    const payload = rosterPayload(sp, { 1: [100 + sp], 2: [200 + sp] })
    payload.status.currentScoringPeriodId = 5
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  const env = { LEAGUE_ID: '794521', LEAGUE_YEAR: '2026', ESPN_S2: 'x', SWID: 'y' }
  const realEnv = { ...process.env }
  Object.assign(process.env, env)
  try {
    assert.equal(await main([], fetchImpl, { snapshotFile: file }), 0)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(saved.leagueId, '794521')
    assert.deepEqual(saved.seasons['2026']['4'], { 1: [104], 2: [204] })
    assert.ok(saved.updated)

    // Second run: nothing to do, no extra roster fetch beyond the probe.
    const before = urls.length
    assert.equal(await main([], fetchImpl, { snapshotFile: file }), 0)
    assert.equal(urls.length, before + 1)

    // Backfill picks up the earlier weeks the single-run mode skipped.
    assert.equal(await main(['--backfill'], fetchImpl, { snapshotFile: file }), 0)
    const filled = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(Object.keys(filled.seasons['2026']).sort(), ['1', '2', '3', '4'])
  } finally {
    Object.assign(process.env, realEnv)
  }
})

test('main --week captures a specific week', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'capture-rosters-'))
  const file = path.join(dir, 'roster-snapshots.json')
  const fetchImpl = async (url) => {
    const sp = Number(new URL(url).searchParams.get('scoringPeriodId'))
    const payload = rosterPayload(sp, { 1: [sp] })
    payload.status.currentScoringPeriodId = 3
    return new Response(JSON.stringify(payload), { status: 200 })
  }
  process.env.LEAGUE_ID = '794521'
  process.env.LEAGUE_YEAR = '2026'
  process.env.ESPN_S2 = 'x'
  process.env.SWID = 'y'
  assert.equal(await main(['--week=2', '--dry-run'], fetchImpl, { snapshotFile: file }), 0)
  assert.throws(() => readFileSync(file), /ENOENT/)
  assert.equal(await main(['--week=2'], fetchImpl, { snapshotFile: file }), 0)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(Object.keys(saved.seasons['2026']), ['2'])
})

test('loadEnvFile import surface matches watch-trades', () => {
  // The capture script shares env parsing with the watcher; if the export
  // ever moves, this fails fast instead of at CI runtime.
  const src = readFileSync(path.join(HERE, 'capture-rosters.mjs'), 'utf8')
  assert.match(src, /import \{ loadEnvFile \} from '\.\/watch-trades\.mjs'/)
})
