import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPayload, parseArgs, postWackyStat, WACKY_USERNAME, DISCORD_MAX_LEN } from './post-wacky-discord.mjs'

test('buildPayload trims and stamps the wacky username', () => {
  assert.deepEqual(buildPayload('  crazy stat  '), { username: WACKY_USERNAME, content: 'crazy stat' })
})

test('buildPayload rejects empty and over-long text', () => {
  assert.throws(() => buildPayload('   '), /empty/)
  assert.throws(() => buildPayload('x'.repeat(DISCORD_MAX_LEN + 1)), /limit/)
  assert.equal(buildPayload('x'.repeat(DISCORD_MAX_LEN)).content.length, DISCORD_MAX_LEN)
})

test('parseArgs defaults to dry-run and joins positional words', () => {
  assert.deepEqual(parseArgs(['some', 'stat', 'text']), { send: false, file: null, text: 'some stat text' })
  assert.equal(parseArgs(['--send', 'text']).send, true)
  assert.equal(parseArgs(['--send', '--dry-run', 'text']).send, false)
  assert.deepEqual(parseArgs(['--file=a.txt']), { send: false, file: 'a.txt', text: '' })
  assert.throws(() => parseArgs(['--nope']), /Unknown argument/)
})

test('dry-run never calls fetch, even with a webhook configured', async () => {
  let calls = 0
  const result = await postWackyStat({
    text: 'stat',
    send: false,
    env: { DISCORD_WEBHOOK_WACKYSTAT: 'https://example.invalid/hook' },
    fetchImpl: async () => {
      calls++
      return { ok: true, status: 204 }
    },
  })
  assert.equal(calls, 0)
  assert.equal(result.posted, false)
  assert.equal(result.payload.content, 'stat')
})

test('--send posts the payload to the configured webhook exactly once', async () => {
  const seen = []
  const result = await postWackyStat({
    text: 'stat',
    send: true,
    env: { DISCORD_WEBHOOK_WACKYSTAT: 'https://example.invalid/hook' },
    fetchImpl: async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body) })
      return { ok: true, status: 204 }
    },
  })
  assert.equal(result.posted, true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, 'https://example.invalid/hook')
  assert.deepEqual(seen[0].body, { username: WACKY_USERNAME, content: 'stat' })
})

test('--send without a webhook throws before any fetch', async () => {
  await assert.rejects(
    () =>
      postWackyStat({
        text: 'stat',
        send: true,
        env: {},
        fetchImpl: async () => {
          throw new Error('fetch must not be called')
        },
      }),
    /DISCORD_WEBHOOK_WACKYSTAT is not set/
  )
})
