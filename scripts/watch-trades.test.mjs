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
  rememberProposals,
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
    {
      teamId: 5,
      name: 'Team 5',
      gives: ['Player One'],
      assets: [{ name: 'Player One', playerId: 111, overallPickNumber: null }]
    },
    {
      teamId: 8,
      name: 'Team 8',
      gives: ['Player Two', 'Player Three'],
      assets: [
        { name: 'Player Two', playerId: 222, overallPickNumber: null },
        { name: 'Player Three', playerId: 333, overallPickNumber: null }
      ]
    }
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
    {
      teamId: 5,
      name: 'Team 5',
      gives: ['Player 555'],
      assets: [{ name: 'Player 555', playerId: 555, overallPickNumber: null }]
    },
    {
      teamId: 8,
      name: 'Team 8',
      gives: ['Player 444'],
      assets: [{ name: 'Player 444', playerId: 444, overallPickNumber: null }]
    }
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
    {
      teamId: 4,
      name: 'Team 4',
      gives: ['Player 2473037'],
      assets: [{ name: 'Player 2473037', playerId: 2473037, overallPickNumber: null }]
    },
    {
      teamId: 11,
      name: 'Team 11',
      gives: ['Draft pick #67'],
      assets: [{ name: 'Draft pick #67', playerId: null, overallPickNumber: 67 }]
    }
  ])
})

test('mapTransaction resolves empty accept items via relatedTransactionId', () => {
  const proposal = {
    id: 'prop-1',
    type: 'TRADE_PROPOSAL',
    proposedDate: 1792506160084,
    items: [
      { playerId: 4430737, fromTeamId: 2, toTeamId: 12, type: 'TRADE' },
      { playerId: 4431611, fromTeamId: 2, toTeamId: 12, type: 'TRADE' },
      { playerId: 4362628, fromTeamId: 12, toTeamId: 2, type: 'TRADE' }
    ]
  }
  const accept = {
    id: 'accept-1',
    type: 'TRADE_ACCEPT',
    proposedDate: 1792516488380,
    relatedTransactionId: 'prop-1',
    items: []
  }
  const names = { 4430737: 'Kyren Williams', 4431611: 'Caleb Williams', 4362628: "Ja'Marr Chase" }
  const teams = { 2: 'Cracked Unc', 12: 'ORACLE AI' }
  // Without the proposal index the accept maps to zero sides (the bug).
  assert.deepEqual(mapTransaction(accept, teams, names).teams, [])
  // With it, the embed names players instead of "Players unknown".
  const record = mapTransaction(accept, teams, names, { 'prop-1': proposal })
  assert.equal(record.event, 'TRADE_ACCEPT')
  assert.deepEqual(record.teams.map((t) => t.name), ['Cracked Unc', 'ORACLE AI'])
  assert.deepEqual(record.teams[0].gives, ['Kyren Williams', 'Caleb Williams'])
  assert.deepEqual(record.teams[1].gives, ["Ja'Marr Chase"])
  assert.match(buildEmbed(record).description, /Kyren Williams/)
})

test('rememberProposals caches proposals with legs and caps size', () => {
  const cache = rememberProposals({}, [
    { id: 'a', type: 'TRADE_PROPOSAL', items: [{ playerId: 1 }] },
    { id: 'b', type: 'TRADE_PROPOSAL', items: [] }, // empty: skipped
    { id: 'c', type: 'TRADE_ACCEPT', items: [] } // not a proposal: skipped
  ])
  assert.deepEqual(Object.keys(cache), ['a'])
  const big = {}
  const txs = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, type: 'TRADE_PROPOSAL', items: [{ playerId: i }] }))
  rememberProposals(big, txs, 3)
  assert.deepEqual(Object.keys(big), ['p2', 'p3', 'p4'])
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
    const postedFile = path.join(dir, 'posted.json')
    process.env.POSTED_TRADES_FILE = postedFile
    const code2 = await main([], fakeFetch, { stateFile, ledgerFile })
    assert.equal(code2, 0)
    assert.equal(posts.length, 1) // accepted trades only
    // Successful posts are handed to the roast agent.
    const posted = JSON.parse(readFileSync(postedFile, 'utf8'))
    assert.deepEqual(
      posted.map((r) => r.id),
      ['2001']
    )
    delete process.env.POSTED_TRADES_FILE
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

test('main resolves a later accept from a cached proposal', async () => {
  const envBackup = { ...process.env }
  process.env.LEAGUE_ID = '794521'
  process.env.LEAGUE_YEAR = '2026'
  process.env.ESPN_S2 = 's2'
  process.env.SWID = 'swid'
  process.env.DISCORD_WEBHOOK_URL = 'https://discord.example/hook'

  const dir = mkdtempSync(path.join(os.tmpdir(), 'trades-accept-'))
  const stateFile = path.join(dir, 'state.json')
  const ledgerFile = path.join(dir, 'trades.json')
  writeFileSync(stateFile, JSON.stringify({ processedIds: ['seed'] }))

  const proposalItems = [
    { playerId: 4430737, fromTeamId: 2, toTeamId: 12, type: 'TRADE' },
    { playerId: 4362628, fromTeamId: 12, toTeamId: 2, type: 'TRADE' }
  ]
  let espnBody = {
    transactions: [
      { id: 'prop-9', type: 'TRADE_PROPOSAL', proposedDate: 1792506160084, items: proposalItems }
    ]
  }
  const posts = []
  const fakeFetch = async (url, options) => {
    if (String(url).includes('discord.example')) {
      posts.push(JSON.parse(options.body))
      return { ok: true, status: 204 }
    }
    if (String(url).includes('view=mTeam'))
      return makeJson({ teams: [{ id: 2, name: 'Cracked Unc' }, { id: 12, name: 'ORACLE AI' }] })
    if (String(url).includes('/athletes/4227356')) return makeJson({ fullName: 'Caleb Placeholder' })
    if (String(url).includes('/athletes/')) {
      const id = Number(String(url).match(/athletes\/(\d+)/)[1])
      const star = { 4430737: 'Kyren Williams', 4362628: "Ja'Marr Chase" }[id]
      return makeJson(star ? { fullName: star } : {})
    }
    return makeJson(espnBody)
  }
  const makeJson = (body) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    headers: new Map()
  })

  try {
    // Run 1: proposal is recorded (no Discord post) and cached in state.
    assert.equal(await main([], fakeFetch, { stateFile, ledgerFile }), 0)
    assert.equal(posts.length, 0)
    const afterProposal = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.ok(afterProposal.proposals['prop-9'], 'proposal cached in state')

    // Run 2: ESPN drops the executed proposal; only the item-less accept remains.
    espnBody = {
      transactions: [
        {
          id: 'accept-9',
          type: 'TRADE_ACCEPT',
          proposedDate: 1792516488380,
          relatedTransactionId: 'prop-9',
          items: []
        }
      ]
    }
    assert.equal(await main([], fakeFetch, { stateFile, ledgerFile }), 0)
    assert.equal(posts.length, 1)
    assert.match(posts[0].embeds[0].description, /Kyren Williams/)
    assert.match(posts[0].embeds[0].description, /Ja'Marr Chase/)
    const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'))
    assert.equal(ledger.trades[0].id, 'accept-9')
    assert.equal(ledger.trades[0].teams.length, 2)
  } finally {
    for (const key of Object.keys(envBackup)) process.env[key] = envBackup[key]
    for (const key of Object.keys(process.env))
      if (!(key in envBackup)) delete process.env[key]
  }
})

test('main persists proposal cache when there are no new events', async () => {
  const envBackup = { ...process.env }
  process.env.LEAGUE_ID = '794521'
  process.env.LEAGUE_YEAR = '2026'
  process.env.ESPN_S2 = 's2'
  process.env.SWID = 'swid'
  process.env.DISCORD_WEBHOOK_URL = 'https://discord.example/hook'

  const dir = mkdtempSync(path.join(os.tmpdir(), 'trades-cache-'))
  const stateFile = path.join(dir, 'state.json')
  const ledgerFile = path.join(dir, 'trades.json')
  // Proposal was already processed before the cache existed: pending is
  // empty, but its legs must still land in state for a later accept.
  writeFileSync(stateFile, JSON.stringify({ processedIds: ['prop-old'] }))

  const espnBody = {
    transactions: [
      {
        id: 'prop-old',
        type: 'TRADE_PROPOSAL',
        proposedDate: 1792506160084,
        items: [{ playerId: 4430737, fromTeamId: 2, toTeamId: 12, type: 'TRADE' }]
      }
    ]
  }
  const posts = []
  const fakeFetch = async (url, options) => {
    if (String(url).includes('discord.example')) {
      posts.push(JSON.parse(options.body))
      return { ok: true, status: 204 }
    }
    if (String(url).includes('view=mTeam'))
      return makeJson({ teams: [{ id: 2, name: 'Cracked Unc' }, { id: 12, name: 'ORACLE AI' }] })
    return makeJson(espnBody)
  }
  const makeJson = (body) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    headers: new Map()
  })

  try {
    assert.equal(await main([], fakeFetch, { stateFile, ledgerFile }), 0)
    assert.equal(posts.length, 0)
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.ok(state.proposals['prop-old'], 'proposal cached in state despite no new events')
    assert.equal(state.proposals['prop-old'].items[0].playerId, 4430737)
  } finally {
    for (const key of Object.keys(envBackup)) process.env[key] = envBackup[key]
    for (const key of Object.keys(process.env))
      if (!(key in envBackup)) delete process.env[key]
  }
})
