import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseArgs, summarizePlayer, buildLeagueContext, buildRoastPrompt, extractRoast, main } from './roast-trade.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const LEAGUE = JSON.parse(readFileSync(path.join(HERE, 'test/fixtures/league-sample.json'), 'utf8'))

const TRADE = {
  id: '2001',
  event: 'TRADE_ACCEPT',
  date: '2026-08-23T00:00:00.000Z',
  teams: [
    { teamId: 5, name: 'Feel It In My Plums', gives: ['Jason Myers'] },
    { teamId: 8, name: 'Toe Burrows Ice Box', gives: ['CeeDee Lamb'] },
  ],
}

test('parseArgs handles file and flags', () => {
  assert.deepEqual(parseArgs(['posted.json']), { tradesFile: 'posted.json', dryRun: false })
  assert.deepEqual(parseArgs(['--dry-run', 'posted.json']), {
    tradesFile: 'posted.json',
    dryRun: true,
  })
  assert.throws(() => parseArgs([]), /Usage:/)
  assert.throws(() => parseArgs(['a', 'b']), /Unknown argument/)
})

test('summarizePlayer maps position, injury, and points', () => {
  const entry = LEAGUE.teams[1].roster.entries[0]
  assert.equal(summarizePlayer(entry), 'Jason Myers (QB, QUESTIONABLE, 88.4 pts)')
  const clean = LEAGUE.teams[0].roster.entries[0]
  assert.equal(summarizePlayer(clean), 'CeeDee Lamb (WR, 61.2 pts)')
  assert.equal(summarizePlayer({}), null)
  assert.equal(summarizePlayer(null), null)
})

test('buildLeagueContext adds ranks, rosters, and traded player news', () => {
  const ctx = buildLeagueContext(LEAGUE, TRADE)
  assert.equal(ctx.week, 3)
  assert.equal(ctx.sides[0].name, 'Feel It In My Plums')
  assert.equal(ctx.sides[0].line, '1 of 3 (3-1, 610.2 pts)')
  assert.equal(ctx.sides[1].line, '3 of 3 (1-3, 402.9 pts)')
  assert.ok(ctx.sides[0].roster.some(p => p.startsWith('CeeDee Lamb')))
  const news = Object.fromEntries(ctx.playerNews.map(n => [n.player, n.items]))
  assert.equal(news['Jason Myers'][0].headline, 'Myers limited at practice with knee issue')
  assert.equal(news['CeeDee Lamb'][0].headline, 'Cowboys expect Lamb to see heavy target share')
})

test('buildRoastPrompt includes trade, standings, and news context', () => {
  const ctx = buildLeagueContext(LEAGUE, TRADE)
  const { system, user } = buildRoastPrompt(ctx, ['- Star RB ruled out for week 3'])
  assert.match(system, /Der Bruden Trade Oracle/)
  assert.match(system, /ONE sentence/)
  assert.match(system, /never explain/i)
  assert.match(system, /never mention any player/i)
  // Research packet stays complete even though the verdict must stay opaque.
  assert.match(user, /Feel It In My Plums sends: Jason Myers/)
  assert.match(user, /1 of 3 \(3-1/)
  assert.match(user, /Kyren Williams/)
  assert.match(user, /Star RB ruled out/)
  assert.match(user, /knee issue/)
})

test('extractRoast pulls content and rejects junk', () => {
  assert.equal(extractRoast({ choices: [{ message: { content: '  nice try. ' } }] }), 'nice try.')
  assert.equal(extractRoast({ choices: [{ message: { content: '"quoted"' } }] }), 'quoted')
  assert.throws(() => extractRoast({}), /no content/)
  assert.throws(() => extractRoast({ choices: [] }), /no content/)
})

test('main researches the trade and posts the roast to Discord', async () => {
  const envBackup = { ...process.env }
  process.env.LEAGUE_ID = '794521'
  process.env.LEAGUE_YEAR = '2026'
  process.env.ESPN_S2 = 's2'
  process.env.SWID = 'swid'
  process.env.OPENCODE_GO_API_KEY = 'key123'
  process.env.DISCORD_WEBHOOK_URL = 'https://discord.example/hook'

  const dir = mkdtempSync(path.join(os.tmpdir(), 'roast-'))
  const postedFile = path.join(dir, 'posted.json')
  writeFileSync(postedFile, JSON.stringify([TRADE]))

  const llmCalls = []
  const discordPosts = []
  const fakeFetch = async (url, options = {}) => {
    const u = String(url)
    if (u.includes('/chat/completions')) {
      llmCalls.push({
        auth: options.headers.Authorization,
        body: JSON.parse(options.body),
      })
      return jsonResponse({ choices: [{ message: { content: 'What a heist.' } }] })
    }
    if (u.includes('site.api.espn.com'))
      return jsonResponse({
        articles: [
          { headline: 'Star RB ruled out', description: 'Practice squad callup expected.' },
          { headline: 'Kicker carousel spins again' },
        ],
      })
    if (u.includes('discord.example')) {
      discordPosts.push(JSON.parse(options.body))
      return { ok: true, status: 204 }
    }
    if (u.includes('view=mTeam&view=mRoster')) return jsonResponse(LEAGUE)
    throw new Error(`Unexpected fetch: ${u}`)
  }
  const jsonResponse = body => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    headers: new Map(),
  })

  try {
    const code = await main([postedFile], fakeFetch)
    assert.equal(code, 0)
    assert.equal(llmCalls.length, 1)
    assert.equal(llmCalls[0].auth, 'Bearer key123')
    assert.equal(llmCalls[0].body.model, 'muse-spark-1.2-contributor')
    assert.match(llmCalls[0].body.messages[1].content, /Jason Myers/)
    assert.match(llmCalls[0].body.messages[1].content, /Star RB ruled out/)
    assert.equal(discordPosts.length, 1)
    assert.equal(discordPosts[0].username, 'Der Bruden Trades')
    assert.equal(discordPosts[0].content, 'What a heist.')

    // LLM failure posts nothing and reports failure.
    const failingFetch = async url => {
      if (String(url).includes('/chat/completions')) return jsonResponse({ error: 'boom' })
      if (String(url).includes('site.api.espn.com')) return jsonResponse({ articles: [] })
      if (String(url).includes('view=mTeam&view=mRoster')) return jsonResponse(LEAGUE)
      throw new Error(`Unexpected fetch: ${url}`)
    }
    const code2 = await main([postedFile], failingFetch)
    assert.equal(code2, 1)
    assert.equal(discordPosts.length, 1)

    // Dry run prints context and calls nothing downstream.
    llmCalls.length = 0
    discordPosts.length = 0
    const code3 = await main(['--dry-run', postedFile], fakeFetch)
    assert.equal(code3, 0)
    assert.equal(llmCalls.length, 0)
    assert.equal(discordPosts.length, 0)

    // Empty handoff file is a no-op.
    const emptyFile = path.join(dir, 'empty.json')
    writeFileSync(emptyFile, '[]')
    const code4 = await main([emptyFile], fakeFetch)
    assert.equal(code4, 0)
    assert.equal(llmCalls.length, 0)
  } finally {
    for (const key of Object.keys(envBackup)) process.env[key] = envBackup[key]
    for (const key of Object.keys(process.env)) if (!(key in envBackup)) delete process.env[key]
  }
})

test('main requires config and rejects missing key without posting', async () => {
  const envBackup = { ...process.env }
  delete process.env.OPENCODE_GO_API_KEY
  process.env.DISCORD_WEBHOOK_URL = 'https://discord.example/hook'

  const dir = mkdtempSync(path.join(os.tmpdir(), 'roast-cfg-'))
  const postedFile = path.join(dir, 'posted.json')
  writeFileSync(postedFile, '[{"id":"x","teams":[]}]')

  let called = false
  const fakeFetch = async () => {
    called = true
    throw new Error('should not fetch')
  }

  try {
    await assert.rejects(main([postedFile], fakeFetch), /Missing required config/)
    assert.equal(called, false)
  } finally {
    for (const key of Object.keys(envBackup)) process.env[key] = envBackup[key]
    for (const key of Object.keys(process.env)) if (!(key in envBackup)) delete process.env[key]
  }
})
