import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STATE_PATH = join(__dirname, 'power-rankings-state.json')
const PAGE_URL = 'https://derbruden.com/power-rankings.html'

function loadEnvFile() {
  const envPath = join(__dirname, '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!match || process.env[match[1]]) continue
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
  }
}

function loadSummary() {
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
}

function periodLabel(state) {
  if (!state.week) return `${state.season} Preseason`
  return `${state.season} Week ${state.week}`
}

function pageUrl(state) {
  // Bust scraper caches (Discord) so each week unfurls fresh.
  return `${PAGE_URL}?x=${state.season}-w${state.week || 0}`
}

function buildPayload(state) {
  const medals = ['🥇', '🥈', '🥉']
  const lines = state.published.slice(0, 5).map(row => {
    const medal = medals[row.rank - 1] ?? `**${row.rank}.**`
    return `${medal} **${row.owner}** — ${row.name} \`${row.rating}\` (${row.record})`
  })
  const url = pageUrl(state)
  return {
    username: 'Der Bruden Power Rankings',
    embeds: [
      {
        title: `Power Rankings — ${periodLabel(state)}`,
        url,
        description: lines.join('\n') + `\n\nFull table and movement: ${url}`,
        color: 0x00429f,
        footer: { text: 'Elo ratings · margin-of-victory adjusted · regular season only' },
      },
    ],
  }
}

async function main() {
  loadEnvFile()
  const webhook = process.env.DISCORD_WEBHOOK_URL
  const dryRun = process.argv.includes('--dry-run')

  const payload = buildPayload(loadSummary())
  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  if (!webhook) {
    console.warn('DISCORD_WEBHOOK_URL not set. Skipping Discord post.')
    return
  }

  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    throw new Error(`Discord webhook returned ${res.status}`)
  }
  console.log('Posted to Discord.')
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
