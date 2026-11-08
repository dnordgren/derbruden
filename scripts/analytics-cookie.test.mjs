import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(path.join(__dirname, '../static/js/analytics.js'), 'utf8')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// Runs analytics.js against a stub browser and returns what it did.
function run({ cookie = '', stored = null, storageThrows = false } = {}) {
  const written = []
  const saved = {}
  const ctx = {
    document: {
      cookie,
      set cookie(value) {
        written.push(value)
      },
      get cookie() {
        return cookie
      },
    },
    localStorage: {
      getItem(key) {
        return key in saved ? saved[key] : stored
      },
      setItem(key, value) {
        if (storageThrows) throw new Error('denied')
        saved[key] = value
      },
    },
    crypto: { randomUUID: () => '11111111-2222-4333-8444-555555555555' },
  }
  ctx.window = ctx
  vm.createContext(ctx)
  vm.runInContext(SOURCE, ctx)
  return { written, saved }
}

function cookieValue(written) {
  const match = written[0]?.match(/^db_cid=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

test('mints a client id when the visitor has neither cookie nor storage', () => {
  const { written, saved } = run()
  assert.equal(written.length, 1)
  assert.equal(cookieValue(written), '11111111-2222-4333-8444-555555555555')
  assert.match(written[0], /; Max-Age=31536000; Path=\/; Secure; SameSite=Lax$/)
  assert.equal(saved.db_cid, '11111111-2222-4333-8444-555555555555')
})

test('reuses an existing cookie instead of minting a new id', () => {
  const existing = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const { written, saved } = run({ cookie: `other=1; db_cid=${existing}` })
  assert.deepEqual(written, [], 'no rewrite when the cookie is already valid')
  assert.equal(saved.db_cid, existing)
})

test('recovers the id from localStorage when the cookie was cleared', () => {
  const stored = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const { written, saved } = run({ stored })
  assert.equal(cookieValue(written), stored, 'cookie is restored, not regenerated')
  assert.equal(saved.db_cid, stored)
})

test('replaces a malformed cookie rather than trusting it', () => {
  const { written } = run({ cookie: 'db_cid=not-a-uuid' })
  assert.equal(written.length, 1)
  assert.match(cookieValue(written), UUID_RE)
})

test('survives storage that throws and still sets the cookie', () => {
  const { written } = run({ storageThrows: true })
  assert.equal(written.length, 1)
  assert.match(cookieValue(written), UUID_RE)
})

test('falls back to a hand-built uuid without crypto.randomUUID', () => {
  const written = []
  const ctx = {
    document: {
      cookie: '',
      set cookie(value) {
        written.push(value)
      },
      get cookie() {
        return ''
      },
    },
    localStorage: { getItem: () => null, setItem: () => {} },
  }
  ctx.window = ctx
  vm.createContext(ctx)
  vm.runInContext(SOURCE, ctx)
  assert.match(cookieValue(written), UUID_RE)
})
