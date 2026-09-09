#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DATA_FILE = path.join(ROOT, 'static', 'data', 'playoff-race.json')
const ENV_FILE = path.join(ROOT, '.env')
const PAGE_URL = 'https://derbruden.com/playoff-race.html'

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
  if (data.remainingCount === 0) return `Playoff Race — ${data.season} Final`
  if (data.currentWeek) return `Playoff Race — ${data.season} Week ${data.throughWeek} → ${data.currentWeek}`
  return `Playoff Race — ${data.season} Week ${data.throughWeek}`
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
  // standings: top playoffTeamCount + bubble
  const playoffCount = data.playoffTeamCount ?? 6
  const standings = data.standings || []
  // Show all teams but truncated? Show top 8 for brevity: 6 in + 2 bubble
  const displayCount = Math.min(standings.length, playoffCount + 2)
  for (let i = 0; i < displayCount; i++) {
    const r = standings[i]
    const rank = r.rank
    const owner = r.owner
    const rec = formatRecord(r)
    let marker = ''
    if (r.clinched) marker = ' 🔒'
    else if (r.eliminated) marker = ' ❌'
    const pf = r.pf.toFixed(1)
    // Highlight cutoff
    const cutoff = i === playoffCount - 1 ? ' ——— cut ———' : ''
    lines.push(`**${rank}. ${owner}** ${rec} (${pf} PF)${marker}${cutoff ? ` ${cutoff}` : ''}`)
  }
  if (standings.length > displayCount) {
    const rest = standings.slice(displayCount)
    const eliminatedLine = rest.filter(r => r.eliminated).map(r => `${r.owner} ${formatRecord(r)} ❌`).join(', ')
    if (eliminatedLine) lines.push(`\nEliminated: ${eliminatedLine}`)
  }

  let description = lines.join('\n')

  if (data.clinchedOwners?.length) description += `\n\n**Clinched:** ${data.clinchedOwners.join(', ')} 🔒`
  if (data.eliminatedOwners?.length) description += `\n**Eliminated:** ${data.eliminatedOwners.join(', ')} ❌`
  if (!data.clinchedOwners?.length && !data.eliminatedOwners?.length) description += `\n\n_No clinches yet — magic numbers still to come._`

  if (data.scenarios) {
    const sc = data.scenarios
    const holdClinched = sc.hold.clinchedOwners
    const flipClinched = sc.flip.clinchedOwners
    const holdOnly = holdClinched.filter(o => !flipClinched.includes(o))
    const flipOnly = flipClinched.filter(o => !holdClinched.includes(o))
    const common = holdClinched.filter(o => flipClinched.includes(o))
    let hypo = '\n\n**Monday hypotheticals**\n'
    // Show current week games
    const gamesDesc = sc.currentWeekGames.map(g => `${g.awayOwner} @ ${g.homeOwner} (${g.leader ?? 'tied'} leads)`).join(', ')
    hypo += `Week ${sc.currentWeek}: ${gamesDesc}\n`
    hypo += `• If leaders hold: ${holdClinched.length ? holdClinched.join(', ') + ' clinch' : 'no new clinches'}`
    if (common.length && holdOnly.length) hypo += ` (${common.join(', ')} anyway)`
    hypo += `\n• If underdogs rally: ${flipClinched.length ? flipClinched.join(', ') + ' clinch' : 'no new clinches'}`
    if (common.length && flipOnly.length) hypo += ` (${common.join(', ')} anyway)`
    // Also note flipped elimination differences?
    const holdElim = sc.hold.eliminatedOwners
    const flipElim = sc.flip.eliminatedOwners
    const holdOnlyElim = holdElim.filter(o => !flipElim.includes(o))
    const flipOnlyElim = flipElim.filter(o => !holdElim.includes(o))
    if (holdOnlyElim.length || flipOnlyElim.length) {
      if (holdOnlyElim.length) hypo += `\n• Hold eliminates: ${holdOnlyElim.join(', ')} ❌`
      if (flipOnlyElim.length) hypo += `\n• Flip eliminates: ${flipOnlyElim.join(', ')} ❌`
    }
    description += hypo
  } else if (data.remainingCount > 0 && data.currentWeek) {
    description += `\n\nNext: Week ${data.currentWeek} — ${data.remainingCount} games left`
  }

  description += `\n\nFull race: ${url}`

  return {
    username: 'Der Bruden Playoff Race',
    embeds: [
      {
        title: periodLabel(data),
        url,
        description,
        color: 0x00429f,
        footer: { text: `Top ${playoffCount} make playoffs · tiebreak PF · ${data.throughWeek ? `through week ${data.throughWeek}` : 'preseason'} · ${data.remainingCount} games left` },
      },
    ],
  }
}

async function main() {
  loadFromFile()
  const webhook = process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_PLAYOFFRACE
  const dryRun = process.argv.includes('--dry-run')
  const force = process.argv.includes('--force')

  if (!fs.existsSync(DATA_FILE)) {
    console.error(`Missing ${DATA_FILE}. Run generate-playoff-race.mjs first.`)
    process.exit(1)
  }
  const data = loadData(DATA_FILE)

  // Late-season gate: skip posting before startWeek unless --force
  if (!force && !dryRun && !data.isLateSeason) {
    console.log(`Before start week ${data.startWeek} (through ${data.throughWeek}). Skipping Discord post.`)
    return
  }
  // Also skip if no games decided? Generation still runs.
  // Build payload
  const payload = buildPayload(data)

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  if (!webhook) {
    console.warn('DISCORD_WEBHOOK_URL / DISCORD_WEBHOOK_PLAYOFFRACE not set. Skipping Discord post.')
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
  console.log('Posted playoff race to Discord.')
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch(err => { console.error(err.message); process.exit(1) })
}
