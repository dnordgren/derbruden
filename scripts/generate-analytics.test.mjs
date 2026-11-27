import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalize } from './analytics.mjs'
import { parseEdgeLocation } from './lib/edge-locations.mjs'
import {
  analyticsDataEqual,
  buildAnalyticsPayload,
  classifyBot,
  computeDailyRollups,
  mergeAllTimeDays,
  normalizePageUri,
  summarizeWindow,
} from './generate-analytics.mjs'

const CID_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const CID_B = '11111111-2222-4333-8444-555555555555'

function logRec(overrides = {}) {
  return normalize({
    date: '2026-11-26',
    time: '15:20:00',
    'c-ip': '203.0.113.10',
    'cs-method': 'GET',
    'cs-uri-stem': '/',
    'sc-status': 200,
    'cs(Referer)': '-',
    'cs(User-Agent)': 'Mozilla/5.0 (Macintosh) Safari/605.1',
    'cs(Cookie)': `db_cid=${CID_A}`,
    'sc-bytes': 12000,
    'x-edge-result-type': 'Hit',
    'x-edge-location': 'SEA73-P1',
    ...overrides,
  })
}

test('parseEdgeLocation maps known US and global POPs and falls back cleanly', () => {
  assert.deepEqual(parseEdgeLocation('SEA73-P1'), { code: 'SEA', city: 'Seattle', country: 'US' })
  assert.deepEqual(parseEdgeLocation('FRA56-P2'), { code: 'FRA', city: 'Frankfurt', country: 'DE' })
  assert.deepEqual(parseEdgeLocation('NRT57-C1'), { code: 'NRT', city: 'Tokyo', country: 'JP' })
  assert.deepEqual(parseEdgeLocation('ZZZ99-P1'), { code: 'ZZZ', city: 'ZZZ', country: 'Unknown' })
  assert.equal(parseEdgeLocation('-'), null)
  assert.equal(parseEdgeLocation(''), null)
})

test('classifyBot groups automated traffic into readable categories', () => {
  assert.equal(classifyBot('Mozilla/5.0%20(compatible;%20GPTBot/1.0)'), 'AI Crawlers')
  assert.equal(classifyBot('ClaudeBot/1.0'), 'AI Crawlers')
  assert.equal(classifyBot('Mozilla/5.0 (compatible; Discordbot/2.0)'), 'Social Previews')
  assert.equal(classifyBot('Mozilla/5.0 (compatible; Googlebot/2.1)'), 'Search Crawlers')
  assert.equal(classifyBot('curl/8.4.0'), 'CLI & Scripts')
  assert.equal(classifyBot('masscan/1.3'), 'Scanners & Other')
})

test('normalizePageUri merges /index.html into / and strips query strings', () => {
  assert.equal(normalizePageUri('/index.html'), '/')
  assert.equal(normalizePageUri('/index.html?v=2'), '/')
  assert.equal(normalizePageUri('/records.html?tab=1'), '/records.html')
})

test('summarizeWindow separates humans, bots, self-referrals, hours, and POP locations', () => {
  const records = [
    logRec({ 'cs-uri-stem': '/index.html', 'cs(Referer)': 'https://discord.com/channels/1/2' }),
    logRec({ 'cs-uri-stem': '/records.html', 'cs(Referer)': 'https://derbruden.com/' }),
    logRec({
      'c-ip': '198.51.100.7',
      'cs(Cookie)': `db_cid=${CID_A}`,
      'cs-uri-stem': '/static/css/site.css',
      'x-edge-location': 'SEA73-P2',
    }),
    logRec({
      'c-ip': '192.0.2.55',
      'cs(Cookie)': '',
      'cs-uri-stem': '/dn.html',
      'x-edge-location': 'ORD58-P3',
      time: '20:15:00',
    }),
    logRec({
      'c-ip': '198.51.100.99',
      'cs(Cookie)': '',
      'cs-uri-stem': '/robots.txt',
      'cs(User-Agent)': 'Mozilla/5.0 (compatible; GPTBot/1.0)',
      'x-edge-location': 'FRA56-P2',
      'x-edge-result-type': 'Miss',
      time: '04:05:00',
    }),
  ]

  const win = summarizeWindow(records, 7)
  assert.equal(win.total, 5)
  assert.equal(win.humanHits, 4)
  assert.equal(win.botHits, 1)
  assert.equal(win.botShare, 0.2)
  assert.equal(win.pageViews, 3)
  assert.equal(win.uniqueClients, 1)
  assert.equal(win.ipOnlyVisitors, 1)
  assert.equal(win.uniqueVisitors, 2)
  assert.equal(win.clientsAcrossMultipleIps, 1)
  assert.equal(win.cookieCoverage, 0.75, '3 of 4 human requests carried db_cid, bots excluded')
  assert.equal(win.cacheHitRatio, 0.8)

  // /index.html merged into /; assets and bot paths excluded from Top Pages
  assert.deepEqual(win.pages, [
    ['/', 1],
    ['/dn.html', 1],
    ['/records.html', 1],
  ])

  // Internal derbruden.com referral excluded; discord.com + (direct) kept
  assert.deepEqual(win.referrers, [
    ['(direct)', 1],
    ['discord.com', 1],
  ])

  // 24 UTC hour buckets
  assert.equal(win.hours.length, 24)
  assert.deepEqual(win.hours[15], ['15', 3, 0])
  assert.deepEqual(win.hours[20], ['20', 1, 0])
  assert.deepEqual(win.hours[4], ['04', 0, 1])

  // Bots
  assert.deepEqual(win.bots.categories, [['AI Crawlers', 1]])
  assert.deepEqual(win.bots.topPaths, [['/robots.txt', 1]])

  // Edge POPs grouped by 3-letter IATA code (SEA73-P1 + SEA73-P2 -> SEA)
  assert.deepEqual(win.locations, [
    { code: 'SEA', city: 'Seattle', country: 'US', human: 3, bot: 0, total: 3 },
    { code: 'ORD', city: 'Chicago', country: 'US', human: 1, bot: 0, total: 1 },
    { code: 'FRA', city: 'Frankfurt', country: 'DE', human: 0, bot: 1, total: 1 },
  ])
  assert.deepEqual(win.countries, [
    ['US', 4, 0],
    ['DE', 0, 1],
  ])
})

test('summarizeWindow and daily rollups count a spoofed-UA scan as bots, not French visitors', () => {
  // The 2026-11-27 Paris scan: browser UA, CloudFront-host probes for
  // secrets, 301 on HTTP then 403 on HTTPS. None of it may land in human
  // hits, page views, visitors, or the CDG human location count.
  const spoofed = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  const scan = [
    logRec({
      'c-ip': '192.0.2.96',
      'cs(Cookie)': '',
      'cs(User-Agent)': spoofed,
      'cs-uri-stem': '/.env',
      'sc-status': 301,
      'x-edge-location': 'CDG50-P1',
    }),
    logRec({
      'c-ip': '192.0.2.96',
      'cs(Cookie)': '',
      'cs(User-Agent)': spoofed,
      'cs-uri-stem': '/.env',
      'sc-status': 403,
      'x-edge-location': 'CDG50-P1',
    }),
    logRec({
      'c-ip': '192.0.2.96',
      'cs(Cookie)': '',
      'cs(User-Agent)': spoofed,
      'cs-uri-stem': '/.git/HEAD',
      'sc-status': 403,
      'x-edge-location': 'CDG50-P1',
    }),
  ]
  const records = [...scan, logRec({ 'cs-uri-stem': '/index.html' })]

  const win = summarizeWindow(records, 7)
  assert.equal(win.total, 4)
  assert.equal(win.humanHits, 1)
  assert.equal(win.botHits, 3)
  assert.equal(win.pageViews, 1)
  assert.deepEqual(win.bots.categories, [['Scanners & Other', 3]])
  assert.deepEqual(
    win.locations.find(l => l.code === 'CDG'),
    {
      code: 'CDG',
      city: 'Paris',
      country: 'FR',
      human: 0,
      bot: 3,
      total: 3,
    }
  )
  assert.deepEqual(
    win.countries.find(c => c[0] === 'FR'),
    ['FR', 0, 3]
  )

  const rollups = computeDailyRollups(records)
  assert.equal(rollups.length, 1)
  assert.deepEqual(rollups[0].slice(1, 5), [1, 1, 3, 1], 'pageViews, humanHits, botHits, visitors')
})

test('mergeAllTimeDays preserves expired history while updating overlapping live days', () => {
  const existing = [
    ['2026-08-01', 20, 80, 15, 5, 500000],
    ['2026-11-26', 10, 40, 5, 3, 200000],
  ]
  const fresh = [
    ['2026-11-26', 35, 120, 25, 7, 800000],
    ['2026-11-27', 12, 50, 10, 4, 300000],
  ]

  const merged = mergeAllTimeDays(existing, fresh)
  assert.equal(merged.firstDate, '2026-08-01')
  assert.equal(merged.lastDate, '2026-11-27')
  assert.equal(merged.days.length, 3)
  // Aug 1 preserved verbatim; Nov 26 updated from authoritative fresh logs
  assert.deepEqual(merged.days[0], ['2026-08-01', 20, 80, 15, 5, 500000])
  assert.deepEqual(merged.days[1], ['2026-11-26', 35, 120, 25, 7, 800000])
  assert.deepEqual(merged.totals.peakDay, { date: '2026-11-26', pageViews: 35, visitors: 7 })
  assert.equal(merged.totals.pageViews, 67)
  assert.equal(merged.totals.botHits, 50)
})

test('analyticsDataEqual ignores updatedAt so no-op runs skip writes', () => {
  const records = [logRec()]
  const a = buildAnalyticsPayload(records, null, new Date('2026-11-26T14:00:00Z'))
  const b = buildAnalyticsPayload(records, a, new Date('2026-11-27T14:00:00Z'))
  assert.equal(analyticsDataEqual(a, b), true)

  const c = buildAnalyticsPayload([...records, logRec({ date: '2026-11-27' })], a, new Date('2026-11-27T15:00:00Z'))
  assert.equal(analyticsDataEqual(a, c), false)
})

test('serialized analytics payload never leaks IPs, client cookies, or raw user agents', () => {
  const records = [
    logRec({
      'c-ip': '203.0.113.42',
      'cs(Cookie)': `db_cid=${CID_B}`,
      'cs(User-Agent)': 'SuperUniqueSecretAgent/9.9',
    }),
    logRec({
      'c-ip': '198.51.100.77',
      'cs(Cookie)': '',
      'cs(User-Agent)': 'CustomBotScanner/4.2-secret',
    }),
  ]
  const json = JSON.stringify(buildAnalyticsPayload(records, null, new Date('2026-11-26T16:00:00Z')))
  assert.equal(json.includes('203.0.113.42'), false)
  assert.equal(json.includes('198.51.100.77'), false)
  assert.equal(json.includes(CID_B), false)
  assert.equal(json.includes('SuperUniqueSecretAgent'), false)
  assert.equal(json.includes('CustomBotScanner'), false)

  // Daily rollup smoke check
  const rollups = computeDailyRollups(records)
  assert.equal(rollups.length, 1)
  assert.equal(rollups[0][0], '2026-11-26')
})
