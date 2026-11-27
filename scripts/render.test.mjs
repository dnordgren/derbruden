import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM, VirtualConsole, requestInterceptor } from 'jsdom'
import { buildPage, listPages } from './build.mjs'

// Renders each built page in jsdom with its real scripts and data.
//
// This covers the contract between the generators and the browser: the
// generator writes a JSON payload into the page, the page's script reads
// it and mounts tables and charts. Unit tests verify the generator's
// objects; nothing else verifies the browser can consume them, and the
// site's scripts guard with `typeof d3 === 'undefined'` or `if (!entry)
// return`, so schema drift fails silently. These tests assert rendered
// output instead of absence of errors.
//
// Assets are served from disk through a jsdom request interceptor, so the
// suite needs no network, no server, and no port.

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = join(SCRIPTS_DIR, '..')
const SRC_DIR = join(ROOT, 'src')
const STATIC_DIR = join(ROOT, 'static')
const ORIGIN = 'https://derbruden.com'

// pub/ holds only HTML: on S3 the pages sit at the bucket root next to
// static/, so local rendering needs both mounted at the same origin.
const MIME = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.html': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

const OWNER_PAGES = ['an', 'ar', 'cr', 'dm', 'dn', 'gm', 'ik', 'jh', 'jo', 'zs']

function buildInto(dir) {
  for (const page of listPages()) {
    const html = readFileSync(join(SRC_DIR, page), 'utf8')
    const outPath = join(dir, page)
    // Some pages live in subdirectories (e.g. votes/relegation.html).
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, buildPage(html, page))
  }
  return dir
}

function readAsset(buildDir, pathname) {
  const file = pathname.startsWith('/static/')
    ? join(STATIC_DIR, pathname.slice('/static/'.length))
    : join(buildDir, pathname)
  try {
    return { body: readFileSync(decodeURIComponent(file)), type: MIME[extname(file)] || 'application/octet-stream' }
  } catch {
    return null
  }
}

function serveFrom(buildDir) {
  return requestInterceptor(request => {
    const asset = readAsset(buildDir, new URL(request.url).pathname)
    if (!asset) return new Response('not found', { status: 404 })
    return new Response(asset.body, { status: 200, headers: { 'Content-Type': asset.type } })
  })
}

// jsdom does not implement fetch. The transactions page loads its JSON
// feeds with it, so provide one that reads the same files from disk.
const installFetch = buildDir => window => {
  window.fetch = async input => {
    const href = typeof input === 'string' ? input : input.url
    const { pathname } = new URL(href, window.location.href)
    const asset = readAsset(buildDir, pathname)
    if (!asset) throw new TypeError(`fetch failed: ${pathname}`)
    return new Response(asset.body, { status: 200, headers: { 'Content-Type': asset.type } })
  }
}

function waitFor(check, { timeout = 10000, interval = 25 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      let value
      try {
        value = check()
      } catch (err) {
        reject(err)
        return
      }
      if (value) {
        resolve(value)
        return
      }
      if (Date.now() - started > timeout) {
        reject(new Error('timed out waiting for condition'))
        return
      }
      setTimeout(tick, interval)
    }
    tick()
  })
}

async function render(buildDir, page) {
  const errors = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', err => errors.push(`jsdomError: ${err.message}`))
  virtualConsole.on('error', (...args) => errors.push(`console.error: ${args.join(' ')}`))

  const dom = new JSDOM(readFileSync(join(buildDir, page), 'utf8'), {
    url: `${ORIGIN}/${page}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    resources: { interceptors: [serveFrom(buildDir)] },
    beforeParse: installFetch(buildDir),
  })

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${page} never fired load`)), 15000)
    dom.window.addEventListener('load', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  return { dom, doc: dom.window.document, errors }
}

function countShape(doc) {
  return doc.querySelectorAll('svg path, svg rect, svg circle, svg line, svg text').length
}

let buildDir
test.before(() => {
  buildDir = buildInto(mkdtempSync(join(tmpdir(), 'derbruden-render-')))
})

test.after(() => {
  if (buildDir) rmSync(buildDir, { recursive: true, force: true })
})

test('owner pages mount charts from the generated payload', async () => {
  for (const owner of OWNER_PAGES) {
    const page = `${owner}.html`
    const { dom, doc, errors } = await render(buildDir, page)
    try {
      assert.deepEqual(errors, [], `${page} logged errors`)
      const svgs = doc.querySelectorAll('svg')
      assert.ok(svgs.length >= 1, `${page} mounted no svg`)
      assert.ok(countShape(doc) > 20, `${page} mounted too few chart shapes`)
    } finally {
      dom.window.close()
    }
  }
})

test('sit-start page renders its season table and trend chart', async () => {
  const { dom, doc, errors } = await render(buildDir, 'sit-start.html')
  try {
    assert.deepEqual(errors, [])
    assert.ok(doc.querySelectorAll('#sitstart-table-wrap table tr').length > 10)
    assert.equal(doc.querySelectorAll('#sitstart-chart svg').length, 1)
    assert.ok(countShape(doc) > 20)
  } finally {
    dom.window.close()
  }
})

test('sit-start season selector swaps the table', async () => {
  const { dom, doc, errors } = await render(buildDir, 'sit-start.html')
  try {
    const select = doc.getElementById('sitstart-season-select')
    assert.ok(select, 'season selector missing')
    assert.ok(select.options.length > 1, 'need more than one season to switch')

    const wrap = doc.getElementById('sitstart-table-wrap')
    const before = wrap.textContent
    select.selectedIndex = 1
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))

    await waitFor(() => wrap.textContent !== before)
    assert.notEqual(select.value, '', 'selector value should be set')
    assert.deepEqual(errors, [])
  } finally {
    dom.window.close()
  }
})

test('records page builds its tables', async () => {
  const { dom, doc, errors } = await render(buildDir, 'records.html')
  try {
    assert.deepEqual(errors, [])
    assert.ok(doc.querySelectorAll('table tr').length > 20)
  } finally {
    dom.window.close()
  }
})

test('transactions page fills tables from the JSON feeds', async () => {
  const { dom, doc, errors } = await render(buildDir, 'transactions.html')
  try {
    // The page fetches static/data/*.json at runtime; rows only appear
    // after those resolve, so this asserts the interceptor really served
    // the real feeds rather than an empty page passing silently.
    await waitFor(() => doc.querySelectorAll('table tr').length > 1, { timeout: 15000 })
    assert.deepEqual(errors, [])
  } finally {
    dom.window.close()
  }
})

test('analytics page renders KPIs, D3 charts, bot report, and global locations', async () => {
  const fixture = {
    version: 1,
    updatedAt: '2026-11-27T14:00:00Z',
    latestLogDate: '2026-11-27',
    allTime: {
      firstDate: '2026-11-25',
      lastDate: '2026-11-27',
      totals: {
        days: 3,
        total: 320,
        pageViews: 95,
        humanHits: 240,
        botHits: 80,
        botShare: 0.25,
        bytes: 4200000,
        avgDailyPageViews: 31.7,
        avgDailyVisitors: 6.3,
        peakDay: { date: '2026-11-26', pageViews: 42, visitors: 8 },
      },
      days: [
        ['2026-11-25', 25, 70, 20, 5, 1100000],
        ['2026-11-26', 42, 100, 35, 8, 1800000],
        ['2026-11-27', 28, 70, 25, 6, 1300000],
      ],
    },
    windows: {
      '7d': {
        days: 7,
        startDate: '2026-11-25',
        endDate: '2026-11-27',
        total: 320,
        humanHits: 240,
        botHits: 80,
        botShare: 0.25,
        pageViews: 95,
        uniqueVisitors: 10,
        uniqueClients: 8,
        ipOnlyVisitors: 2,
        clientsAcrossMultipleIps: 2,
        cookieCoverage: 0.78,
        cacheHitRatio: 0.92,
        bytes: 4200000,
        daily: [
          ['2026-11-25', 25, 70, 20, 5, 1100000],
          ['2026-11-26', 42, 100, 35, 8, 1800000],
          ['2026-11-27', 28, 70, 25, 6, 1300000],
        ],
        hours: Array.from({ length: 24 }, (_, h) => [String(h).padStart(2, '0'), (h % 5) + 1, h % 3]),
        pages: [
          ['/', 45],
          ['/records.html', 25],
          ['/dn.html', 15],
        ],
        referrers: [
          ['(direct)', 70],
          ['discord.com', 25],
        ],
        bots: {
          categories: [
            ['AI Crawlers', 45],
            ['Search Crawlers', 35],
          ],
          topPaths: [
            ['/', 50],
            ['/robots.txt', 30],
          ],
        },
        locations: [
          { code: 'SEA', city: 'Seattle', country: 'US', human: 180, bot: 10, total: 190 },
          { code: 'FRA', city: 'Frankfurt', country: 'DE', human: 0, bot: 50, total: 50 },
        ],
        countries: [
          ['US', 180, 10],
          ['DE', 0, 50],
        ],
      },
      '30d': null,
      '90d': null,
    },
  }
  fixture.windows['30d'] = fixture.windows['7d']
  fixture.windows['90d'] = fixture.windows['7d']

  const errors = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', err => errors.push(`jsdomError: ${err.message}`))
  virtualConsole.on('error', (...args) => errors.push(`console.error: ${args.join(' ')}`))

  const dom = new JSDOM(readFileSync(join(buildDir, 'analytics.html'), 'utf8'), {
    url: `${ORIGIN}/analytics.html`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    resources: { interceptors: [serveFrom(buildDir)] },
    beforeParse: window => {
      window.fetch = async input => {
        const href = typeof input === 'string' ? input : input.url
        const { pathname } = new URL(href, window.location.href)
        if (pathname === '/static/data/analytics.json') {
          return new Response(JSON.stringify(fixture), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        const asset = readAsset(buildDir, pathname)
        if (!asset) throw new TypeError(`fetch failed: ${pathname}`)
        return new Response(asset.body, { status: 200, headers: { 'Content-Type': asset.type } })
      }
    },
  })

  try {
    const doc = dom.window.document
    await waitFor(() => doc.querySelectorAll('#kpi-grid .kpi-card').length === 5, { timeout: 15000 })
    assert.match(doc.getElementById('kpi-grid').textContent, /Avg Pages \/ Visitor/)
    assert.equal(doc.querySelectorAll('#daily-chart svg').length, 1)
    assert.equal(doc.querySelectorAll('#hourly-chart svg').length, 1)
    assert.ok(countShape(doc) > 30)
    assert.match(doc.getElementById('locations-wrap').textContent, /Seattle, United States/)
    assert.match(doc.getElementById('locations-wrap').textContent, /Frankfurt, Germany/)

    // Switching to All Time swaps the KPI cards and shows the 90d detail note
    const allBtn = doc.querySelector('button[data-window="all"]')
    allBtn.click()
    await waitFor(() => !doc.getElementById('alltime-detail-banner').hidden)
    assert.match(doc.getElementById('kpi-grid').textContent, /Peak Day/)

    // Filtering locations to Bots hides human-only rows and ranks Frankfurt #1
    const botLocBtn = doc.querySelector('button[data-loc-filter="bot"]')
    botLocBtn.click()
    const firstRow = doc.querySelector('#locations-wrap tbody tr td').textContent
    assert.match(firstRow, /Frankfurt/)
    assert.deepEqual(errors, [])
  } finally {
    dom.window.close()
  }
})

test('every page builds and runs without console errors', async () => {
  for (const page of listPages()) {
    const { dom, errors } = await render(buildDir, page)
    try {
      assert.deepEqual(errors, [], `${page} logged errors`)
    } finally {
      dom.window.close()
    }
  }
})
