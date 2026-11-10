import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { clientIdFromCookie, formatReport, isBot, isPageView, lastNDays, normalize, summarize } from './analytics.mjs'

const CID_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const CID_B = '11111111-2222-4333-8444-555555555555'
const CID_C = '99999999-8888-4777-8666-555555555555'

function v2(overrides = {}) {
  return {
    timestamp: '2026-11-03T14:02:11Z',
    'c-ip': '203.0.113.10',
    'cs-method': 'GET',
    'cs-uri-stem': '/power-rankings.html',
    'sc-status': 200,
    'cs(Referer)': '-',
    'cs(User-Agent)': 'Mozilla/5.0 (Macintosh) Safari/605.1',
    'cs(Cookie)': '',
    'sc-bytes': 18000,
    'x-edge-result-type': 'Hit',
    'x-edge-location': 'ORD52',
    ...overrides,
  }
}

test('extracts a valid client id from the raw Cookie header', () => {
  assert.equal(clientIdFromCookie(`db_cid=${CID_A}`), CID_A)
  assert.equal(clientIdFromCookie(`_ga=GA1.1; db_cid=${CID_A}; other=2`), CID_A)
})

test('ignores cookies without a usable client id', () => {
  assert.equal(clientIdFromCookie(''), null)
  assert.equal(clientIdFromCookie('-'), null)
  assert.equal(clientIdFromCookie('_ga=GA1.1'), null)
  assert.equal(clientIdFromCookie('db_cid=not-a-uuid'), null)
  assert.equal(clientIdFromCookie('db_cid=%zz'), null)
})

test('flags bots and scanners by user agent', () => {
  assert.ok(isBot('curl/8.4.0'))
  assert.ok(isBot('Mozilla/5.0 (compatible; AhrefsBot/7.0)'))
  assert.ok(isBot('python-requests/2.31.0'))
  assert.equal(isBot('Mozilla/5.0 (Windows NT 10.0) Chrome/131.0'), false)
})

test('normalizes v2 fields and falls back to v1 names', () => {
  const record = normalize(v2())
  assert.equal(record.ip, '203.0.113.10')
  assert.equal(record.uri, '/power-rankings.html')
  assert.equal(record.status, 200)

  const v1 = normalize({ 'c-ip': '198.51.100.5', 'cs-uri': '/index.html', 'sc-status': '304' })
  assert.equal(v1.uri, '/index.html')
  assert.equal(v1.status, 304)
})

test('counts a returning visitor as one client even across IPs', () => {
  const report = summarize([
    normalize(v2({ 'c-ip': '203.0.113.10', 'cs(Cookie)': `db_cid=${CID_A}` })),
    normalize(v2({ 'c-ip': '198.51.100.7', 'cs(Cookie)': `db_cid=${CID_A}` })),
    normalize(v2({ 'c-ip': '192.0.2.44', 'cs(Cookie)': `db_cid=${CID_B}` })),
  ])
  assert.equal(report.uniqueClients, 2, 'two cookie ids, three addresses')
  assert.equal(report.clientsAcrossMultipleIps, 1)
  assert.equal(report.cookieHits, 3)
})

test('counts cookie-less requests as IP-only instead of dropping them', () => {
  const report = summarize([normalize(v2({ 'c-ip': '203.0.113.10' })), normalize(v2({ 'c-ip': '203.0.113.10' }))])
  assert.equal(report.uniqueClients, 0)
  assert.equal(report.ipOnlyVisitors, 1, 'same address collapses to one visitor')
  assert.equal(report.total, 2, 'both requests still counted')
})

test('separates bot traffic from human traffic and the cache ratio', () => {
  const report = summarize([
    normalize(v2()),
    normalize(v2({ 'cs(User-Agent)': 'curl/8.4.0', 'x-edge-result-type': 'Miss' })),
  ])
  assert.equal(report.humanHits, 1)
  assert.equal(report.botHits, 1)
  assert.equal(report.cacheHitRatio, 0.5)
})

test('sorts referrers by host and groups direct traffic', () => {
  const report = summarize([
    normalize(v2({ 'cs(Referer)': 'https://discord.com/channels/1/2' })),
    normalize(v2({ 'cs(Referer)': 'https://discord.com/channels/3/4' })),
    normalize(v2()),
  ])
  const top = report.referrers[0]
  assert.deepEqual(top, ['discord.com', 2])
  assert.ok(report.referrers.some(([host, n]) => host === '(direct)' && n === 1))
})

test('renders a report with the identity and coverage lines', () => {
  const text = formatReport(
    summarize([normalize(v2({ 'cs(Cookie)': `db_cid=${CID_A}` })), normalize(v2({ 'c-ip': '198.51.100.9' }))])
  )
  assert.match(text, /Requests carrying db_cid/)
  assert.match(text, /IP-only visitors/)
  assert.match(text, /Top pages/)
})

test('reads gzipped v2 logs out of a nested directory', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cf-logs-'))
  try {
    const nested = path.join(dir, 'E3CDWEEK40CKI2.2026-11-03-14.abcd')
    mkdirSync(nested, { recursive: true })
    const body = [v2({ 'cs(Cookie)': `db_cid=${CID_C}` }), v2({ 'c-ip': '198.51.100.9' })]
      .map(r => JSON.stringify(r))
      .join('\n')
    writeFileSync(path.join(nested, 'log.gz'), gzipSync(body))

    const { readCloudFrontLogs } = await import('./analytics.mjs')
    const records = []
    for await (const record of readCloudFrontLogs(dir)) records.push(record)
    assert.equal(records.length, 2)
    assert.equal(records[0].uri, '/power-rankings.html')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('separates page views from asset requests', () => {
  assert.ok(isPageView('/index.html'))
  assert.ok(isPageView('/'))
  assert.ok(isPageView('/owners/'))
  assert.ok(isPageView('/power-rankings.html?v=2'))
  assert.equal(isPageView('/static/css/site.css'), false)
  assert.equal(isPageView('/static/fonts/archivo-latin-var.woff2'), false)
  assert.equal(isPageView('/static/data/trades.json'), false)
})

test('top pages excludes assets that would otherwise top the list', () => {
  const report = summarize([
    normalize(v2({ 'cs-uri-stem': '/static/fonts/archivo-latin-var.woff2' })),
    normalize(v2({ 'cs-uri-stem': '/static/fonts/archivo-latin-var.woff2' })),
    normalize(v2({ 'cs-uri-stem': '/static/css/site.css' })),
    normalize(v2({ 'cs-uri-stem': '/index.html' })),
  ])
  assert.deepEqual(report.pages, [['/index.html', 1]], 'only HTML counts as a page')
  assert.equal(report.uris[0][0], '/static/fonts/archivo-latin-var.woff2', 'assets still visible under URIs')
})

test('page views count human HTML requests only', () => {
  const report = summarize([
    normalize(v2()),
    normalize(v2({ 'cs(User-Agent)': 'curl/8.4.0' })),
    normalize(v2({ 'cs-uri-stem': '/static/css/site.css' })),
  ])
  assert.equal(report.pageViews, 1)
})

test('an IP that later carries a cookie is not also an IP-only visitor', () => {
  const report = summarize([
    // First HTML request: no cookie yet, same address.
    normalize(v2({ 'c-ip': '203.0.113.10' })),
    // Later requests carry the id minted on that first page load.
    normalize(v2({ 'c-ip': '203.0.113.10', 'cs(Cookie)': `db_cid=${CID_A}` })),
    // A genuinely distinct cookie-less visitor on another address.
    normalize(v2({ 'c-ip': '198.51.100.9' })),
  ])
  assert.equal(report.uniqueClients, 1)
  assert.equal(report.ipOnlyResolvedByCookie, 1)
  assert.equal(report.ipOnlyVisitors, 1, 'the resolved address is not double counted')
})

test('counts RefreshHit as a cache hit', () => {
  const report = summarize([
    normalize(v2({ 'x-edge-result-type': 'Hit' })),
    normalize(v2({ 'x-edge-result-type': 'RefreshHit' })),
    normalize(v2({ 'x-edge-result-type': 'Miss' })),
  ])
  assert.equal(report.cacheHitRatio, 2 / 3)
})

test('warns when no request carried a client id', () => {
  const text = formatReport(summarize([normalize(v2())]))
  assert.match(text, /No request carried db_cid/)
  assert.match(text, /cookie logging/)
})

test('stays quiet about cookies when coverage is healthy', () => {
  const text = formatReport(summarize([normalize(v2({ 'cs(Cookie)': `db_cid=${CID_A}` }))]))
  assert.doesNotMatch(text, /No request carried db_cid/)
})

test('lastNDays keeps the window ending at the newest record', () => {
  const records = [
    normalize(v2({ timestamp: '2026-11-01T08:00:00Z' })),
    normalize(v2({ timestamp: '2026-11-05T08:00:00Z' })),
    normalize(v2({ timestamp: '2026-11-08T08:00:00Z' })),
  ]
  const kept = lastNDays(records, 3)
  assert.equal(kept.length, 2, 'only records within three days of the newest')
  assert.deepEqual(
    kept.map(r => r.time),
    ['2026-11-05T08:00:00Z', '2026-11-08T08:00:00Z']
  )
})

test('lastNDays ignores records with unparseable timestamps instead of dropping them', () => {
  const records = [
    normalize(v2({ timestamp: '2026-11-08T08:00:00Z' })),
    normalize({ 'c-ip': '203.0.113.10', 'cs-uri': '/x.html' }),
  ]
  assert.equal(lastNDays(records, 1).length, 2)
})
