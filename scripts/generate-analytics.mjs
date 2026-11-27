// Build aggregate analytics JSON for src/analytics.html from CloudFront
// standard logs v2 (gzipped NDJSON).
//
// Usage:
//   node scripts/generate-analytics.mjs [logDir] [--out path] [--dry-run]
//
// Reads existing static/data/analytics.json (if present) and merges fresh daily
// rollups into allTime.days so compact long-term trends survive past the 90-day
// S3 log expiration window. Rolling 7d / 30d / 90d detailed views are computed
// fresh from the raw logs on each run.
//
// Raw IPs, db_cid UUIDs, and full User-Agents are never written to disk.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { clientIdFromCookie, hostOf, isBot, isPageView, lastNDays, readCloudFrontLogs } from './analytics.mjs'
import { parseEdgeLocation } from './lib/edge-locations.mjs'
import { writeJsonAtomic } from './lib/html.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_LOG_DIR = path.join(__dirname, '../logs/cloudfront')
export const DEFAULT_OUT_PATH = path.join(__dirname, '../static/data/analytics.json')

const SELF_HOSTS = new Set(['derbruden.com'])
const WINDOW_DAYS = [7, 30, 90]

function decodeSafe(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function classifyBot(userAgent) {
  const ua = decodeSafe(userAgent || '')
  if (
    /gptbot|oai-searchbot|chatgpt-user|claudebot|claude-web|anthropic|perplexitybot|bytespider|ccbot|meta-externalagent|amazonbot|cohere-ai/i.test(
      ua
    )
  ) {
    return 'AI Crawlers'
  }
  if (/discordbot|slackbot|twitterbot|facebookexternalhit|bingpreview|embedly|pinterest|quora/i.test(ua)) {
    return 'Social Previews'
  }
  if (/googlebot|bingbot|duckduckbot|applebot|slurp|yandex|baidu|petalbot|semrush|ahrefs|mj12|dotbot/i.test(ua)) {
    return 'Search Crawlers'
  }
  if (/curl|wget|python-requests|go-http-client|headless/i.test(ua)) {
    return 'CLI & Scripts'
  }
  return 'Scanners & Other'
}

export function normalizePageUri(uri) {
  const stem = String(uri || '').split('?')[0]
  if (stem === '/index.html') return '/'
  return stem
}

function roundRatio(num, den) {
  if (!den) return 0
  return Math.round((num / den) * 10000) / 10000
}

function topEntries(map, limit) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit)
}

function bump(map, key, by = 1) {
  if (!key) return
  map.set(key, (map.get(key) || 0) + by)
}

function resolveVisitors(clients, cookieIps, ipOnly) {
  const cookieIpSet = new Set()
  for (const ips of cookieIps.values()) {
    for (const ip of ips) cookieIpSet.add(ip)
  }
  const ipOnlyResolvedByCookie = [...ipOnly].filter(ip => cookieIpSet.has(ip)).length
  const ipOnlyVisitors = ipOnly.size - ipOnlyResolvedByCookie
  return {
    uniqueClients: clients.size,
    ipOnlyVisitors,
    uniqueVisitors: clients.size + ipOnlyVisitors,
    clientsAcrossMultipleIps: [...cookieIps.values()].filter(ips => ips.size > 1).length,
  }
}

// Returns sorted array of compact 6-tuples:
// [date, pageViews, humanHits, botHits, visitors, bytes]
export function computeDailyRollups(records) {
  const byDay = new Map()
  for (const record of records) {
    if (!record.time) continue
    const t = Date.parse(record.time)
    if (Number.isNaN(t)) continue
    const date = new Date(t).toISOString().slice(0, 10)
    let bucket = byDay.get(date)
    if (!bucket) {
      bucket = {
        pageViews: 0,
        humanHits: 0,
        botHits: 0,
        bytes: 0,
        clients: new Set(),
        cookieIps: new Map(),
        ipOnly: new Set(),
      }
      byDay.set(date, bucket)
    }
    const bot = isBot(record.userAgent)
    if (bot) bucket.botHits += 1
    else bucket.humanHits += 1
    bucket.bytes += record.bytes
    if (!bot && isPageView(record.uri)) bucket.pageViews += 1

    const cid = clientIdFromCookie(record.cookie)
    if (cid) {
      bucket.clients.add(cid)
      if (!bucket.cookieIps.has(cid)) bucket.cookieIps.set(cid, new Set())
      if (record.ip) bucket.cookieIps.get(cid).add(record.ip)
    } else if (!bot && record.ip && isPageView(record.uri)) {
      bucket.ipOnly.add(record.ip)
    }
  }

  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, b]) => {
      const { uniqueVisitors } = resolveVisitors(b.clients, b.cookieIps, b.ipOnly)
      return [date, b.pageViews, b.humanHits, b.botHits, uniqueVisitors, b.bytes]
    })
}

export function mergeAllTimeDays(existingDays = [], freshDays = []) {
  const merged = new Map()
  for (const row of existingDays || []) {
    if (Array.isArray(row) && row.length >= 6 && /^\d{4}-\d{2}-\d{2}$/.test(row[0])) {
      merged.set(row[0], [
        row[0],
        Number(row[1]) || 0,
        Number(row[2]) || 0,
        Number(row[3]) || 0,
        Number(row[4]) || 0,
        Number(row[5]) || 0,
      ])
    }
  }
  for (const row of freshDays || []) {
    if (Array.isArray(row) && row.length >= 6 && /^\d{4}-\d{2}-\d{2}$/.test(row[0])) {
      merged.set(row[0], row)
    }
  }
  const days = [...merged.values()].sort((a, b) => a[0].localeCompare(b[0]))
  let pageViews = 0
  let humanHits = 0
  let botHits = 0
  let bytes = 0
  let visitorDaySum = 0
  let peakDay = null
  for (const [date, pv, hh, bh, vis, b] of days) {
    pageViews += pv
    humanHits += hh
    botHits += bh
    bytes += b
    visitorDaySum += vis
    if (!peakDay || pv > peakDay.pageViews || (pv === peakDay.pageViews && date > peakDay.date)) {
      peakDay = { date, pageViews: pv, visitors: vis }
    }
  }
  const totalRequests = humanHits + botHits
  return {
    firstDate: days.length ? days[0][0] : null,
    lastDate: days.length ? days[days.length - 1][0] : null,
    totals: {
      days: days.length,
      total: totalRequests,
      pageViews,
      humanHits,
      botHits,
      botShare: roundRatio(botHits, totalRequests),
      bytes,
      avgDailyPageViews: days.length ? Math.round((pageViews / days.length) * 10) / 10 : 0,
      avgDailyVisitors: days.length ? Math.round((visitorDaySum / days.length) * 10) / 10 : 0,
      peakDay,
    },
    days,
  }
}

export function summarizeWindow(records, days) {
  const subset = lastNDays(records, days)
  const pages = new Map()
  const referrers = new Map()
  const botCategories = new Map()
  const botPaths = new Map()
  const locations = new Map()
  const countries = new Map()
  const hours = Array.from({ length: 24 }, (_, h) => [String(h).padStart(2, '0'), 0, 0])

  const clients = new Set()
  const cookieIps = new Map()
  const ipOnly = new Set()

  let total = 0
  let humanHits = 0
  let botHits = 0
  let pageViews = 0
  let cookieHits = 0
  let bytes = 0
  let hits = 0
  let misses = 0

  for (const record of subset) {
    total += 1
    const bot = isBot(record.userAgent)
    if (bot) botHits += 1
    else humanHits += 1

    bytes += record.bytes

    if (record.edgeResult === 'Hit' || record.edgeResult === 'RefreshHit') hits += 1
    if (record.edgeResult === 'Miss') misses += 1

    const isPage = isPageView(record.uri)
    if (!bot && isPage) {
      pageViews += 1
      bump(pages, normalizePageUri(record.uri))
      const refHost = hostOf(record.referer)
      if (!SELF_HOSTS.has(refHost)) {
        bump(referrers, refHost)
      }
    }

    if (bot) {
      bump(botCategories, classifyBot(record.userAgent))
      const stem = String(record.uri || '').split('?')[0] || '(none)'
      bump(botPaths, stem)
    }

    const loc = parseEdgeLocation(record.edgeLocation)
    if (loc) {
      let entry = locations.get(loc.code)
      if (!entry) {
        entry = { code: loc.code, city: loc.city, country: loc.country, human: 0, bot: 0, total: 0 }
        locations.set(loc.code, entry)
      }
      if (bot) entry.bot += 1
      else entry.human += 1
      entry.total += 1

      let countryEntry = countries.get(loc.country)
      if (!countryEntry) {
        countryEntry = [loc.country, 0, 0]
        countries.set(loc.country, countryEntry)
      }
      if (bot) countryEntry[2] += 1
      else countryEntry[1] += 1
    }

    if (record.time) {
      const t = Date.parse(record.time)
      if (!Number.isNaN(t)) {
        const h = new Date(t).getUTCHours()
        if (bot) hours[h][2] += 1
        else hours[h][1] += 1
      }
    }

    const cid = clientIdFromCookie(record.cookie)
    if (cid) {
      cookieHits += 1
      clients.add(cid)
      if (!cookieIps.has(cid)) cookieIps.set(cid, new Set())
      if (record.ip) cookieIps.get(cid).add(record.ip)
    } else if (!bot && record.ip && isPage) {
      ipOnly.add(record.ip)
    }
  }

  const daily = computeDailyRollups(subset)
  const identity = resolveVisitors(clients, cookieIps, ipOnly)

  const sortedLocations = [...locations.values()]
    .sort((a, b) => b.total - a.total || b.human - a.human || a.code.localeCompare(b.code))
    .slice(0, 25)

  const sortedCountries = [...countries.values()]
    .sort((a, b) => b[1] + b[2] - (a[1] + a[2]) || b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 15)

  return {
    days,
    startDate: daily.length ? daily[0][0] : null,
    endDate: daily.length ? daily[daily.length - 1][0] : null,
    total,
    humanHits,
    botHits,
    botShare: roundRatio(botHits, total),
    pageViews,
    uniqueVisitors: identity.uniqueVisitors,
    uniqueClients: identity.uniqueClients,
    ipOnlyVisitors: identity.ipOnlyVisitors,
    clientsAcrossMultipleIps: identity.clientsAcrossMultipleIps,
    cookieCoverage: roundRatio(cookieHits, total),
    cacheHitRatio: roundRatio(hits, hits + misses),
    bytes,
    daily,
    hours,
    pages: topEntries(pages, 20),
    referrers: topEntries(referrers, 12),
    bots: {
      categories: topEntries(botCategories, 10),
      topPaths: topEntries(botPaths, 12),
    },
    locations: sortedLocations,
    countries: sortedCountries,
  }
}

export function buildAnalyticsPayload(records, existing = null, now = new Date()) {
  const freshDays = computeDailyRollups(records)
  const allTime = mergeAllTimeDays(existing?.allTime?.days, freshDays)
  const windows = {}
  for (const n of WINDOW_DAYS) {
    windows[`${n}d`] = summarizeWindow(records, n)
  }
  return {
    version: 1,
    updatedAt: now.toISOString(),
    latestLogDate: allTime.lastDate,
    allTime,
    windows,
  }
}

// Ignore updatedAt when comparing so idle runs with no new logs leave
// static/data/analytics.json untouched and skip publish/commit.
export function analyticsDataEqual(a, b) {
  if (!a || !b) return false
  const strip = obj => {
    const { updatedAt: _u, ...rest } = obj
    return rest
  }
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b))
}

function readExistingJson(filePath) {
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

async function main() {
  const args = process.argv.slice(2)
  let logDir = DEFAULT_LOG_DIR
  let outPath = DEFAULT_OUT_PATH
  let dryRun = false
  const positional = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--out') {
      outPath = path.resolve(args[++i])
    } else if (arg.startsWith('--out=')) {
      outPath = path.resolve(arg.slice('--out='.length))
    } else if (!arg.startsWith('--')) {
      positional.push(arg)
    }
  }
  if (positional[0]) logDir = path.resolve(positional[0])

  if (!fs.existsSync(logDir)) {
    console.error(`No log directory at ${logDir}`)
    console.error('Sync CloudFront logs first: make logs')
    process.exitCode = 1
    return
  }

  const records = []
  for await (const record of readCloudFrontLogs(logDir)) {
    records.push(record)
  }

  if (!records.length) {
    console.log(`No .gz log records found under ${logDir}; leaving ${path.relative(process.cwd(), outPath)} unchanged.`)
    return
  }

  const existing = readExistingJson(outPath)
  const payload = buildAnalyticsPayload(records, existing)

  if (analyticsDataEqual(existing, payload)) {
    console.log(`Analytics unchanged (${payload.allTime.totals.days} days tracked); skipping write.`)
    return
  }

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  writeJsonAtomic(outPath, payload, 2)
  console.log(
    `Wrote ${path.relative(process.cwd(), outPath)} (${records.length} log records, ${payload.allTime.totals.days} all-time days, latest ${payload.latestLogDate})`
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
