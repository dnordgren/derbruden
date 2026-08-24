import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { TEAM_OWNERS } from './team-owners.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const LEAGUE_ID = process.env.FANTASY_LEAGUE_ID || '794521'
const API_BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl'
const USER_AGENT = 'derbruden.com team name sync'
const SRC_DIR = join(__dirname, '../src')

function loadEnvFile() {
  const envPath = join(__dirname, '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!match || process.env[match[1]]) continue
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
  }
}

function authHeaders() {
  const espnS2 = process.env.ESPN_S2
  const swid = process.env.SWID
  if (!espnS2) {
    throw new Error('This league is private. Set ESPN_S2 in scripts/.env or your environment.')
  }
  const cookie = swid ? `SWID=${swid}; espn_s2=${espnS2}` : `espn_s2=${espnS2}`
  return {
    Cookie: cookie,
    'User-Agent': USER_AGENT,
  }
}

async function fetchLeague(season) {
  const url = `${API_BASE}/seasons/${season}/segments/0/leagues/${LEAGUE_ID}?view=mTeam`
  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) {
    throw new Error(`ESPN API returned ${res.status} for season ${season}`)
  }
  return res.json()
}

function defaultSeason() {
  const now = new Date()
  // The fantasy season runs August through early February.
  return now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1
}

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function syncPage(owner, page, name) {
  const filePath = join(SRC_DIR, page)
  if (!fs.existsSync(filePath)) {
    console.warn(`File not found: ${filePath}`)
    return false
  }

  const content = fs.readFileSync(filePath, 'utf8')
  const headerRegex = /(<div class="owner-logo-header">[\s\S]*?<h1>)[^<]*(<\/h1>)/
  if (!headerRegex.test(content)) {
    console.warn(`Could not find owner header in ${page}`)
    return false
  }

  const heading = `${owner} - ${escapeHtml(name)}`
  const updated = content.replace(headerRegex, (match, prefix, suffix) => `${prefix}${heading}${suffix}`)
  if (updated === content) return false

  if (!dryRun) fs.writeFileSync(filePath, updated)
  console.log(`${owner}: ${heading}`)
  return true
}

let dryRun = false

async function main() {
  loadEnvFile()
  authHeaders()
  dryRun = process.argv.includes('--dry-run')

  const [seasonArg] = process.argv.filter(arg => /^\d{4}$/.test(arg))
  const preferred = Number(seasonArg) || defaultSeason()

  let league
  try {
    league = await fetchLeague(preferred)
  } catch (err) {
    if (seasonArg) throw err
    const fallback = preferred - 1
    console.warn(`${err.message} Falling back to season ${fallback}.`)
    league = await fetchLeague(fallback)
  }

  let changed = 0
  let synced = 0
  for (const team of league.teams) {
    const mapped = TEAM_OWNERS[team.id]
    const name = (team.name || team.nickname || team.abbrev).trim()
    if (!mapped) {
      console.warn(`Unmapped ESPN team id ${team.id} (${team.abbrev}). Check TEAM_OWNERS after the draft.`)
      continue
    }
    synced += 1
    if (syncPage(mapped.owner, mapped.page, name)) changed += 1
  }

  console.log(
    `Synced ${synced} owner pages from season ${league.seasonId}. ` +
      `${changed} ${changed === 1 ? 'page' : 'pages'} changed${dryRun ? ' (dry run)' : ''}.`
  )
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
