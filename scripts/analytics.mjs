// Report on CloudFront standard logs v2 (gzipped NDJSON).
//
// The site's only analytics source is the CDN access log: every request,
// including ones from browsers that block JavaScript. `static/js/analytics.js`
// sets a first-party `db_cid` cookie so a returning visitor keeps one identity
// across IP changes; requests without it are still counted, just not stitchable.
//
// Usage:
//   node scripts/analytics.mjs [logDir] [--days N] [--json]
//
// Pull logs first:
//   aws s3 sync s3://<log-bucket>/AWSLogs/.../CloudFront/ ./logs/cloudfront/
//
// No dependencies: gzip and NDJSON are both in the Node standard library.

import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Known crawlers and scanners. CloudFront logs everything, so a bare UA
// filter is what keeps "traffic" from meaning "the internet's port scans".
const BOT_RE =
  /bot|crawler|spider|crawl|slurp|curl|wget|python-requests|go-http-client|headless|scanner|nmap|masscan|zgrab|fuzz|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|facebookexternalhit|discordbot|slackbot|twitterbot|bingpreview|embedly|quora|pinterest/i

export function isBot(userAgent) {
  return BOT_RE.test(userAgent || '')
}

// Pulls `db_cid` out of the raw request Cookie header. Returns null when the
// visitor sent no cookie (first request, JS blocked, cookies disabled).
export function clientIdFromCookie(cookieHeader) {
  if (!cookieHeader || cookieHeader === '-') return null
  const match = /(?:^|;\s*)db_cid=([^;]+)/.exec(cookieHeader)
  if (!match) return null
  let value
  try {
    value = decodeURIComponent(match[1])
  } catch {
    return null
  }
  return UUID_RE.test(value) ? value : null
}

// CloudFront v2 log records are JSON with header-shaped keys like "cs-uri-stem"
// and "cs(Cookie)". Normalize the handful we report on, tolerating the v1 TSV
// field names too so an older log pull still works.
export function normalize(record) {
  const get = (...keys) => {
    for (const key of keys) {
      if (record[key] !== undefined && record[key] !== '') return record[key]
    }
    return ''
  }
  return {
    time: get('timestamp', 'date', 'time'),
    ip: get('c-ip'),
    method: get('cs-method'),
    uri: get('cs-uri-stem', 'cs-uri'),
    status: Number(get('sc-status', 'status')) || 0,
    referer: get('cs(Referer)', 'cs-referer', 'referer'),
    userAgent: get('cs(User-Agent)', 'cs-user-agent'),
    cookie: get('cs(Cookie)', 'cs-cookie', 'cookie'),
    bytes: Number(get('sc-bytes', 'bytes')) || 0,
    edgeResult: get('x-edge-result-type'),
    edgeLocation: get('x-edge-location'),
  }
}

function topOf(map, limit) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
}

function bump(map, key, by = 1) {
  if (!key) return
  map.set(key, (map.get(key) || 0) + by)
}

function hostOf(referer) {
  if (!referer || referer === '-') return '(direct)'
  try {
    return new URL(referer).hostname.replace(/^www\./, '')
  } catch {
    return '(malformed)'
  }
}

// Aggregate a stream of normalized records into the report shape.
export function summarize(records) {
  const pages = new Map()
  const referrers = new Map()
  const statuses = new Map()
  const days = new Map()
  const hours = new Map()
  const edges = new Map()
  const clients = new Set()
  let total = 0
  let botHits = 0
  let humanHits = 0
  let cookieHits = 0
  let bytes = 0
  let hits = 0
  let misses = 0
  const ipOnly = new Set()
  const cookieIps = new Map()
  const ipClients = new Map()

  for (const record of records) {
    total += 1
    const bot = isBot(record.userAgent)
    if (bot) botHits += 1
    else humanHits += 1

    bytes += record.bytes
    bump(statuses, String(record.status))
    bump(pages, record.uri || '(none)')
    bump(referrers, hostOf(record.referer))
    bump(edges, record.edgeLocation)
    if (record.edgeResult === 'Hit') hits += 1
    if (record.edgeResult === 'Miss') misses += 1

    if (record.time) {
      const day = record.time.slice(0, 10)
      bump(days, day)
      const hour = new Date(record.time).getUTCHours()
      if (!Number.isNaN(hour)) bump(hours, String(hour).padStart(2, '0'))
    }

    const cid = clientIdFromCookie(record.cookie)
    if (cid) {
      cookieHits += 1
      clients.add(cid)
      if (!cookieIps.has(cid)) cookieIps.set(cid, new Set())
      cookieIps.get(cid).add(record.ip)
    } else if (!bot && record.ip) {
      ipOnly.add(record.ip)
      if (!ipClients.has(record.ip)) ipClients.set(record.ip, new Set())
      ipClients.get(record.ip).add(cid || `ip:${record.ip}`)
    }
  }

  const multiIpClients = [...cookieIps.values()].filter(ips => ips.size > 1).length
  const requestHitRatio = hits + misses > 0 ? hits / (hits + misses) : 0

  return {
    total,
    botHits,
    humanHits,
    cookieHits,
    cookieCoverage: total > 0 ? cookieHits / total : 0,
    uniqueClients: clients.size,
    ipOnlyVisitors: ipOnly.size,
    // A client id seen from more than one address is exactly the case the
    // cookie exists to fix; IP alone would have counted them twice.
    clientsAcrossMultipleIps: multiIpClients,
    cacheHitRatio: requestHitRatio,
    bytes,
    pages: topOf(pages, 25),
    referrers: topOf(referrers, 15),
    statuses: topOf(statuses, 10),
    days: [...days.entries()].sort(),
    hours: [...hours.entries()].sort(),
    edges: topOf(edges, 10),
  }
}

export async function* readCloudFrontLogs(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      for await (const record of readCloudFrontLogs(full)) yield record
    } else if (entry.name.endsWith('.gz')) {
      files.push(full)
    }
  }
  for (const file of files) {
    const text = gunzipSync(fs.readFileSync(file)).toString('utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        yield normalize(JSON.parse(line))
      } catch {
        // Truncated or partial line; skip it rather than aborting the report.
      }
    }
  }
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`
}

function kb(value) {
  return `${(value / 1024).toFixed(0)} KB`
}

export function formatReport(report) {
  const lines = []
  const row = (label, value) => lines.push(`  ${label.padEnd(34)} ${value}`)

  lines.push('')
  lines.push('CloudFront request log')
  lines.push('─'.repeat(60))
  row('Requests', report.total)
  row('Human requests', report.humanHits)
  row('Bot / scanner requests', report.botHits)
  row('Requests carrying db_cid', `${report.cookieHits} (${pct(report.cookieCoverage)})`)
  row('Unique client ids', report.uniqueClients)
  row('IP-only visitors', `${report.ipOnlyVisitors} (no cookie)`)
  row('Clients seen from >1 IP', report.clientsAcrossMultipleIps)
  row('Edge cache hit ratio', pct(report.cacheHitRatio))
  row('Bytes served', kb(report.bytes))

  const section = (title, entries, limit = 15) => {
    if (!entries.length) return
    lines.push('')
    lines.push(title)
    lines.push('─'.repeat(60))
    for (const [key, value] of entries.slice(0, limit)) {
      lines.push(`  ${String(value).padStart(6)}  ${key}`)
    }
  }

  section('Top pages', report.pages, 20)
  section('Referrers', report.referrers)
  section('Status codes', report.statuses)
  section('Edge locations', report.edges, 10)

  if (report.days.length) {
    lines.push('')
    lines.push('Requests by day (UTC)')
    lines.push('─'.repeat(60))
    const peak = Math.max(...report.days.map(([, n]) => n))
    for (const [day, count] of report.days) {
      const bar = '█'.repeat(Math.max(1, Math.round((count / peak) * 40)))
      lines.push(`  ${day}  ${String(count).padStart(6)}  ${bar}`)
    }
  }

  if (report.hours.length) {
    lines.push('')
    lines.push('Requests by hour (UTC)')
    lines.push('─'.repeat(60))
    const peak = Math.max(...report.hours.map(([, n]) => n))
    for (const [hour, count] of report.hours) {
      const bar = '█'.repeat(Math.max(1, Math.round((count / peak) * 40)))
      lines.push(`  ${hour}:00  ${String(count).padStart(6)}  ${bar}`)
    }
  }

  lines.push('')
  return lines.join('\n')
}

async function main() {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const dir = args.find(a => !a.startsWith('--')) || 'logs/cloudfront'

  if (!fs.existsSync(dir)) {
    console.error(`No log directory at ${dir}`)
    console.error('')
    console.error('Pull CloudFront standard logs v2 first:')
    console.error('  aws s3 sync s3://<log-bucket>/AWSLogs/<account>/CloudFront/ logs/cloudfront/')
    process.exitCode = 1
    return
  }

  const records = []
  for await (const record of readCloudFrontLogs(dir)) records.push(record)

  if (!records.length) {
    console.error(`No .gz log files found under ${dir}`)
    process.exitCode = 1
    return
  }

  const report = summarize(records)
  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
