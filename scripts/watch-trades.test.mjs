import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  loadEnvFile,
  parseArgs,
  newTransactions,
  mapTransaction,
  buildEmbed,
  main
} from './watch-trades.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

test('parseArgs handles flags', () => {
  assert.deepEqual(parseArgs([]), { dryRun: false, backfill: null })
  assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true, backfill: null })
  assert.deepEqual(parseArgs(['--backfill=5']), { dryRun: false, backfill: 5 })
  assert.deepEqual(parseArgs(['--backfill', '5']), { dryRun: false, backfill: 5 })
})

test('parseArgs rejects junk', () => {
  assert.throws(() => parseArgs(['--nope']), /Unknown argument/)
  assert.throws(() => parseArgs(['--backfill=0']), /positive number/)
})

test('loadEnvFile parses values, quotes, and comments', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'env-'))
  const file = path.join(dir, '.env')
  writeFileSync(
    file,
    '# comment\nA=1\nB="two words"\nC=three\n\nD=  spaced  \nBAD LINE\nE=x=y\n'
  )
  const parsed = loadEnvFile(file)
  assert.equal(parsed.A, '1')
  assert.equal(parsed.B, 'two words')
  assert.equal(parsed.C, 'three')
  assert.equal(parsed.D, 'spaced')
  assert.equal(parsed.E, 'x=y')
  assert.equal(parsed['BAD LINE'], undefined)
})

test('newTransactions filters seen IDs and sorts oldest first', () => {
  const txs = [
    { id: 'c', proposedDate: 3 },
    { id: 'a', processDate: 1 },
    { id: 'b', proposedDate: 2 },
    { id: 'seen', proposedDate: 0 }
  ]
  assert.deepEqual(newTransactions(txs, ['seen']).map((t) => t.id), ['a', 'b', 'c'])
})

test('mapTransaction groups directional items under the sending team', () => {
  const tx = {
    id: '900',
    typeId: 244,
    date: 1755086400000,
    items: [
      { playerId: 111, fromTeamId: 5, toTeamId: 8 },
      { playerId: 222, fromTeamId: 8, toTeamId: 5 },
      { playerId: 333, fromTeamId: 8, toTeamId: 5 }
    ]
  }
  const names = { 111: 'Player One', 222: 'Player Two', 333: 'Player Three' }
  const record = mapTransaction(tx, {}, names)
  assert.equal(record.event, 'TRADE_ACCEPT')
  assert.equal(record.date, new Date(1755086400000).toISOString())
  assert.deepEqual(record.teams, [
    { teamId: 5, name: 'Team 5', gives: ['Player One'] },
    { teamId: 8, name: 'Team 8', gives: ['Player Two', 'Player Three'] }
  ])
})

test('mapTransaction supports ADD/DROP style items', () => {
  const tx = {
    id: '901',
    type: 'TRADE_PROPOSAL',
    statusDate: 1755000000000,
    items: [
      { playerId: 444, type: 'ADD', teamId: 5 },
      { playerId: 444, type: 'DROP', teamId: 8 },
      { playerId: 555, type: 'ADD', teamId: 8 },
      { playerId: 555, type: 'DROP', teamId: 5 }
    ]
  }
  const record = mapTransaction(tx, {}, {})
  assert.equal(record.event, 'TRADE_PROPOSAL')
  assert.deepEqual(record.teams, [
    { teamId: 5, name: 'Team 5', gives: ['Player 555'] },
    { teamId: 8, name: 'Team 8', gives: ['Player 444'] }
  ])
})

test('mapTransaction attributes draft picks and skips non-player items', () => {
  const tx = {
    id: 'b4f8f7af-cb66-4b32-95d0-7040cf565023',
    type: 'TRADE_ACCEPT',
    proposedDate: 1783617131690,
    items: [
      { playerId: 2473037, fromTeamId: 4, toTeamId: 11, type: 'TRADE' },
      { playerId: 0, fromTeamId: 11, toTeamId: 4, overallPickNumber: 67, type: 'DRAFT_TRADE' }
    ]
  }
  const record = mapTransaction(tx, {}, {})
  assert.equal(record.id, 'b4f8f7af-cb66-4b32-95d0-7040cf565023')
  assert.equal(record.date, new Date(1783617131690).toISOString())
  assert.deepEqual(record.teams, [
    { teamId: 4, name: 'Team 4', gives: ['Player 2473037'] },
    { teamId: 11, name: 'Team 11', gives: ['Draft pick #67'] }
  ])
})

test('mapTransaction returns null for unknown types and tolerates empty items', () => {
  assert.equal(mapTransaction({ id: 1, type: 'WAIVER' }, {}, {}), null)
  assert.deepEqual(mapTransaction({ id: 2, type: 'TRADE_ACCEPT' }, {}, {}).teams, [])
})

test('buildEmbed maps titles and colors', () => {
  const accepted = buildEmbed({
    id: 1,
    event: 'TRADE_ACCEPT',
    date: '2026-08-23T00:00:00.000Z',
    teams: [{ teamId: 5, name: 'A', gives: ['X'] }, { teamId: 8, name: 'B', gives: ['Y'] }]
  })
  assert.equal(accepted.title, 'Trade accepted')
  assert.equal(accepted.color, 0x2ecc71)
  assert.equal(accepted.timestamp, '2026-08-23T00:00:00.000Z')
  assert.match(accepted.description, /\*\*A\*\* sends X/)

  const proposed = buildEmbed({ id: 2, event: 'TRADE_PROPOSAL', date: null, teams: [] })
  assert.equal(proposed.color, 0x95a5a6)
  assert.match(proposed.description, /Players unknown/)
})

test('fixture payload maps end to end', () => {
  const fixture = JSON.parse(readFileSync(path.join(HERE, 'test/fixtures/transactions-sample.json'), 'utf8'))
  const pending = newTransactions(fixture.transactions, [])
  assert.equal(pending.length, 3) // includes one non-trade event
  const records = pending
    .map((tx) => mapTransaction(tx, { 5: 'Significant Figures', 8: 'Ice Box' }, {}))
    .filter(Boolean)
  assert.deepEqual(records.map((r) => r.id), ['1002', '1003'])
  assert.equal(records[0].event, 'TRADE_PROPOSAL')
  assert.equal(records[0].teams.length, 2)
  assert.equal(records[1].event, 'TRADE_ACCEPT')
})

test('main posts new trades and dedupes on second run', async () => {
  const envBackup = { ...process.env }
  process.env.LEAGUE_ID = '794521'
  process.env.LEAGUE_YEAR = '2026'
  process.env.ESPN_S2 = 's2'
  process.env.SWID = 'swid'
  process.env.DISCORD_WEBHOOK_URL = 'https://discord.example/hook'

  const dir = mkdtempSync(path.join(os.tmpdir(), 'trades-'))
  const stateFile = path.join(dir, 'state.json')
  const ledgerFile = path.join(dir, 'trades.json')

  const espnBody = {
    transactions: [
      {
        id: '2001',
        type: 'TRADE_ACCEPT',
        date: 1755900000000,
        items: [{ playerId: 111, fromTeamId: 5, toTeamId: 8 }]
      },
      {
        id: '2002',
        type: 'TRADE_PROPOSAL',
        proposedDate: 1755986400000,
        items: [{ playerId: 222, fromTeamId: 8, toTeamId: 5 }]
      }
    ]
  }
  const posts = []
  const fakeFetch = async (url, options) => {
    if (String(url).includes('discord.example')) {
      posts.push(JSON.parse(options.body))
      return { ok: true, status: 204 }
    }
    if (String(url).includes('view=mTeam')) return makeJson({ teams: [
      { id: 5, name: 'Feel It In My Plums', location: 'Feel It In My', nickname: 'Plums' },
      { id: 8, name: 'Toe Burrows Ice Box', location: 'Toe Burrows', nickname: 'Ice Box' }
    ] })
    if (String(url).includes('/athletes/')) return makeJson({ fullName: 'Jason Myers' })
    return makeJson(espnBody)
  }
  const makeJson = (body) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    headers: new Map()
  })

  try {
    // First run ever: seeds state silently, no spam.
    writeFileSync(stateFile, JSON.stringify({ processedIds: [] }))
    const code = await main([], fakeFetch, { stateFile, ledgerFile })
    assert.equal(code, 0)
    assert.equal(posts.length, 0)
    const seeded = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.deepEqual(seeded.processedIds, ['2001', '2002'])

    // Established watcher sees both events: accept posts, proposal only records.
    writeFileSync(stateFile, JSON.stringify({ processedIds: ['1000'] }))
    const code2 = await main([], fakeFetch, { stateFile, ledgerFile })
    assert.equal(code2, 0)
    assert.equal(posts.length, 1) // accepted trades only
    assert.equal(posts[0].embeds[0].title, 'Trade accepted')
    assert.match(posts[0].embeds[0].description, /\*\*Feel It In My Plums\*\* sends Jason Myers/)
    const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'))
    assert.equal(ledger.trades.length, 2)
    assert.equal(ledger.trades[0].id, '2002')
    assert.equal(ledger.trades[0].event, 'TRADE_PROPOSAL')
    assert.equal(ledger.trades[1].id, '2001')
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).players['111'], 'Jason Myers')

    // Second identical poll dedupes.
    const code3 = await main([], fakeFetch, { stateFile, ledgerFile })
    assert.equal(code3, 0)
    assert.equal(posts.length, 1)
  } finally {
    for (const key of Object.keys(envBackup)) process.env[key] = envBackup[key]
    for (const key of Object.keys(process.env))
      if (!(key in envBackup)) delete process.env[key]
  }
})
