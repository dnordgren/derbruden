#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DATA_FILE = path.join(ROOT, 'static', 'data', 'diaper-race.json')
const ENV_FILE = path.join(ROOT, '.env')
const PAGE_URL = 'https://derbruden.com/diaper-race.html'

function loadEnvFile(file = ENV_FILE) {
  if (!fs.existsSync(file)) return {}
  const out = {}
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    out[key] = value
  }
  return out
}

function loadFromFile() {
  const envFile = loadEnvFile(ENV_FILE)
  for (const [k, v] of Object.entries(envFile)) if (!process.env[k]) process.env[k] = v
}

function loadData(file = DATA_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function periodLabel(data) {
  if (data.remainingCount === 0) return `Diaper Race — ${data.season} Final`
  if (data.currentWeek) return `Diaper Race — ${data.season} Week ${data.throughWeek} → ${data.currentWeek}`
  return `Diaper Race — ${data.season} Week ${data.throughWeek}`
}

function pageUrl(data) {
  return `${PAGE_URL}?x=${data.season}-w${data.throughWeek || 0}`
}

function formatRecord(r) {
  return `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''}`
}

export function buildPayload(data) {
  const url = pageUrl(data)
  const lines = []
  // Worst-first: the bottom 4 plus the bubble team above them.
  const standings = [...(data.standings || [])].sort((a, b) => a.rank - b.rank).reverse()
  const displayCount = Math.min(standings.length, 5)
  for (let i = 0; i < displayCount; i++) {
    const r = standings[i]
    const owner = r.owner
    const rec = formatRecord(r)
    let marker = ''
    if (r.doomed) marker = ' 🍼'
    else if (r.safe) marker = ' ✅'
    const pf = r.pf.toFixed(1)
    const pip = i === 0 ? ' ——— diaper ———' : ''
    lines.push(`**${owner}** ${rec} (${pf} PF)${marker}${pip ? ` ${pip}` : ''}`)
  }
  const rest = standings.slice(displayCount)
  if (rest.length) {
    const safeLine = rest.filter(r => r.safe).map(r => `${r.owner} ${formatRecord(r)} ✅`).join(', ')
    const mixLine = rest.filter(r => !r.safe && !r.doomed).map(r => `${r.owner} ${formatRecord(r)}`).join(', ')
    if (safeLine) lines.push(`\nSafe: ${safeLine}`)
    if (mixLine) lines.push(`In the mix: ${mixLine}`)
  }

  let description = lines.join('\n')

  if (data.doomedOwners?.length) description += `\n\n**Fitted for the diaper:** 🍼 ${data.doomedOwners.join(', ')}`
  if (data.safeOwners?.length) description += `\n**Safe:** ${data.safeOwners.join(', ')} ✅`
  if (!data.doomedOwners?.length && !data.safeOwners?.length) description += `\n\n_No locks yet — everyone can still dodge the diaper._`

  if (data.scenarios) {
    const sc = data.scenarios
    const holdDoomed = sc.hold.doomedOwners
    const flipDoomed = sc.flip.doomedOwners
    const common = holdDoomed.filter(o => flipDoomed.includes(o))
    let hypo = '\n\n**Monday hypotheticals**\n'
    const gamesDesc = sc.currentWeekGames.map(g => `${g.awayOwner} @ ${g.homeOwner} (${g.leader ?? 'tied'} leads)`).join(', ')
    hypo += `Week ${sc.currentWeek}: ${gamesDesc}\n`
    hypo += `• If leaders hold: ${holdDoomed.length ? '🍼 ' + holdDoomed.join(', ') + ' locked in' : 'no new locks'}`
    if (common.length && holdDoomed.length > common.length) hypo += ` (${common.join(', ')} anyway)`
    hypo += `\n• If underdogs rally: ${flipDoomed.length ? '🍼 ' + flipDoomed.join(', ') + ' locked in' : 'no new locks'}`
    if (common.length && flipDoomed.length > common.length) hypo += ` (${common.join(', ')} anyway)`
    const holdSafe = sc.hold.safeOwners
    const flipSafe = sc.flip.safeOwners
    const holdOnlySafe = holdSafe.filter(o => !flipSafe.includes(o))
    const flipOnlySafe = flipSafe.filter(o => !holdSafe.includes(o))
    if (holdOnlySafe.length || flipOnlySafe.length) {
      if (holdOnlySafe.length) hypo += `\n• Hold saves: ${holdOnlySafe.join(', ')} ✅`
      if (flipOnlySafe.length) hypo += `\n• Flip saves: ${flipOnlySafe.join(', ')} ✅`
    }
    description += hypo
  } else if (data.remainingCount > 0 && data.currentWeek) {
    description += `\n\nNext: Week ${data.currentWeek} — ${data.remainingCount} games left`
  }

  description += `\n\nFull race: ${url}`

  return {
    username: 'Der Bruden Diaper Race',
    embeds: [
      {
        title: periodLabel(data),
        url,
        description,
        color: 0x7b4b00,
        footer: { text: `Last place wears the diaper · worst record, lower PF breaks ties · ${data.throughWeek ? `through week ${data.throughWeek}` : 'preseason'} · ${data.remainingCount} games left` },
      },
    ],
  }
}

async function main() {
  loadFromFile()
  const webhook = process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_DIAPERRACE
  const dryRun = process.argv.includes('--dry-run')
  const force = process.argv.includes('--force')

  if (!fs.existsSync(DATA_FILE)) {
    console.error(`Missing ${DATA_FILE}. Run generate-diaper-race.mjs first.`)
    process.exit(1)
  }
  const data = loadData(DATA_FILE)

  // Late-season gate: skip posting before startWeek unless --force
  if (!force && !dryRun && !data.isLateSeason) {
    console.log(`Before start week ${data.startWeek} (through ${data.throughWeek}). Skipping Discord post.`)
    return
  }

  // Build payload
  const payload = buildPayload(data)

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  if (!webhook) {
    console.warn('DISCORD_WEBHOOK_URL / DISCORD_WEBHOOK_DIAPERRACE not set. Skipping Discord post.')
    return
  }

  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Discord webhook returned ${res.status}: ${text.slice(0, 500)}`)
  }
  console.log('Posted diaper race to Discord.')
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch(err => { console.error(err.message); process.exit(1) })
}
