import fs from 'fs'
import path from 'path'
import Papa from 'papaparse'
import { fileURLToPath } from 'url'
import { TEAM_OWNERS } from './team-owners.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const LEAGUE_ID = process.env.FANTASY_LEAGUE_ID || '794521'
const API_BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl'
const USER_AGENT = 'derbruden.com owner viz generator'
const CACHE_DIR = join(__dirname, '.viz-cache')
const SRC_DIR = join(__dirname, '../src')
const FIRST_SEASON = 2014

const K_FACTOR = 20
const BASE_RATING = 1500

export const VIZ_START = '<!-- OWNER_VIZ_START -->'
export const VIZ_END = '<!-- OWNER_VIZ_END -->'

function join(...parts) {
  return path.join(...parts)
}

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

function defaultSeason() {
  const now = new Date()
  return now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1
}

function ownerById() {
  const map = {}
  for (const [teamId, entry] of Object.entries(TEAM_OWNERS)) {
    map[Number(teamId)] = entry.owner
  }
  return map
}

function ownerCodes() {
  return [...new Set(Object.values(TEAM_OWNERS).map(e => e.owner))].sort()
}

async function fetchLeague(season) {
  const url = `${API_BASE}/seasons/${season}/segments/0/leagues/${LEAGUE_ID}` + '?view=mTeam&view=mMatchupScore'
  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) {
    throw new Error(`ESPN API returned ${res.status} for season ${season}`)
  }
  return res.json()
}

function cachePath(season) {
  return join(CACHE_DIR, `season-${season}.json`)
}

async function loadLeague(season, offline) {
  if (!offline) {
    try {
      const league = await fetchLeague(season)
      fs.mkdirSync(CACHE_DIR, { recursive: true })
      fs.writeFileSync(cachePath(season), JSON.stringify(league))
      return { league, source: 'network' }
    } catch (err) {
      if (fs.existsSync(cachePath(season))) {
        return { league: JSON.parse(fs.readFileSync(cachePath(season), 'utf8')), source: 'cache' }
      }
      console.warn(`Season ${season}: ${err.message}; skipping.`)
      return null
    }
  }
  if (fs.existsSync(cachePath(season))) {
    return { league: JSON.parse(fs.readFileSync(cachePath(season), 'utf8')), source: 'cache' }
  }
  return null
}

export function extractGames(league) {
  const teamIds = new Set(league.teams.map(t => t.id))
  const games = []
  for (const matchup of league.schedule || []) {
    const home = matchup.home
    const away = matchup.away
    if (
      !home ||
      !away ||
      !teamIds.has(home.teamId) ||
      !teamIds.has(away.teamId) ||
      typeof home.totalPoints !== 'number' ||
      typeof away.totalPoints !== 'number'
    ) {
      continue
    }
    const winner = String(matchup.winner || '').toLowerCase()
    if (!['home', 'away', 'tie'].includes(winner)) continue
    if (winner !== 'tie' && home.totalPoints === 0 && away.totalPoints === 0) continue
    games.push({
      week: matchup.matchupPeriodId,
      homeId: home.teamId,
      awayId: away.teamId,
      homeScore: home.totalPoints,
      awayScore: away.totalPoints,
      winner,
      playoff: matchup.playoffTierType !== 'NONE',
    })
  }
  return games.sort((a, b) => a.week - b.week)
}

export function computeH2H(seasonGamesList, ownersById, owners) {
  const blank = () => ({ w: 0, l: 0, t: 0, pf: 0, pa: 0 })
  const records = {}
  for (const a of owners) {
    records[a] = {}
    for (const b of owners) {
      if (a !== b) records[a][b] = blank()
    }
  }
  let counted = 0
  let skipped = 0
  for (const { games } of seasonGamesList) {
    for (const g of games) {
      const a = ownersById[g.homeId]
      const b = ownersById[g.awayId]
      if (!a || !b || a === b) {
        skipped += 1
        continue
      }
      counted += 1
      const ab = records[a][b]
      const ba = records[b][a]
      ab.pf += g.homeScore
      ab.pa += g.awayScore
      ba.pf += g.awayScore
      ba.pa += g.homeScore
      if (g.winner === 'home') {
        ab.w += 1
        ba.l += 1
      } else if (g.winner === 'away') {
        ab.l += 1
        ba.w += 1
      } else {
        ab.t += 1
        ba.t += 1
      }
    }
  }
  return { records, counted, skipped }
}

export function seedsFromStats(statsRows, season, ownersById) {
  const rows = statsRows.filter(row => row.Owner && row.Season === (season - 1) % 100)
  const seeds = {}
  for (const [teamId, owner] of Object.entries(ownersById)) {
    const row = rows.find(r => r.Owner === owner)
    if (row && row.W + row.L > 0) {
      const winPct = row.W / (row.W + row.L)
      seeds[Number(teamId)] = Math.round(BASE_RATING + (winPct - 0.5) * 100)
    } else {
      seeds[Number(teamId)] = BASE_RATING
    }
  }
  return seeds
}

function movMultiplier(margin, winnerRating, loserRating) {
  const base = Math.log(1 + margin / 10)
  const cap = 2.2 / ((winnerRating - loserRating) * 0.001 + 2.2)
  return Math.min(base * cap, 2.4)
}

export function computeElo(seasonGamesList, statsRows, ownersById, owners) {
  const idByOwner = {}
  for (const [teamId, owner] of Object.entries(ownersById)) {
    idByOwner[owner] = Number(teamId)
  }
  const trackIds = owners.map(owner => idByOwner[owner]).filter(id => id != null)

  const ratings = {}
  const series = {}
  for (const owner of owners) series[owner] = []
  const seasonStarts = []
  let idx = 0

  const snapshot = () => {
    for (const id of trackIds) {
      if (ratings[id] != null) {
        series[ownersById[id]].push([idx, ratings[id]])
      }
    }
  }

  const ordered = [...seasonGamesList].sort((a, b) => a.season - b.season)
  for (const { season, games } of ordered) {
    const regular = games.filter(g => !g.playoff)
    if (regular.length === 0) continue
    const seeds = seedsFromStats(statsRows, season, ownersById)

    const ids = new Set()
    for (const g of regular) {
      ids.add(g.homeId)
      ids.add(g.awayId)
    }
    for (const id of ids) {
      ratings[id] = seeds[id] ?? BASE_RATING
    }

    seasonStarts.push([idx, season])
    snapshot()

    let week = null
    for (const g of regular) {
      if (week === null) week = g.week
      if (g.week !== week) {
        week = g.week
        idx += 1
        snapshot()
      }
      const { homeId, awayId, homeScore, awayScore, winner } = g
      const homeExpected = 1 / (1 + 10 ** ((ratings[awayId] - ratings[homeId]) / 400))
      const homeActual = winner === 'home' ? 1 : winner === 'away' ? 0 : 0.5
      const margin = Math.abs(homeScore - awayScore)
      if (margin > 0) {
        const [winnerId, loserId] = homeScore > awayScore ? [homeId, awayId] : [awayId, homeId]
        const mult = movMultiplier(margin, ratings[winnerId], ratings[loserId])
        const delta = Math.round(K_FACTOR * mult * (homeActual - homeExpected))
        ratings[homeId] += delta
        ratings[awayId] -= delta
      }
    }
    idx += 1
    snapshot()
    idx += 1
  }

  const finals = {}
  for (const owner of owners) {
    const pts = series[owner]
    finals[owner] = pts.length ? pts[pts.length - 1][1] : null
  }
  return { series, seasonStarts, finals }
}

export function pfpaFromStats(statsRows, owners) {
  const out = {}
  for (const owner of owners) {
    out[owner] = statsRows
      .filter(row => row.Owner === owner)
      .map(row => ({ season: 2000 + row.Season, pf: row.RGPF, pa: row.RGPA }))
      .sort((a, b) => a.season - b.season)
  }
  return out
}

export function payloadFor(owner, { generated, pfpa, elo, h2h, owners }) {
  return {
    generated,
    owner,
    pfpa: pfpa[owner],
    elo: {
      seasonStarts: elo.seasonStarts,
      points: elo.series[owner],
    },
    h2h: {
      owners,
      row: h2h.records[owner],
    },
  }
}

export function renderSection(payload) {
  const json = JSON.stringify(payload).replace(/<\//g, '<\\/')
  return `${VIZ_START}
  <section class="owner-viz">
    <h2>Points For vs Points Against</h2>
    <p class="viz-note">Each dot pair shows one season. Green is points scored, red is points allowed.</p>
    <div class="viz-chart" id="viz-pfpa"></div>
    <h2>Elo Trajectory</h2>
    <p class="viz-note">Weekly Elo rating, 1500 is league average.</p>
    <div class="viz-chart" id="viz-elo"></div>
    <h2>Career Head-to-Head</h2>
    <p class="viz-note">Record against each owner, regular season and playoffs, since 2018.</p>
    <div class="viz-chart viz-chart-h2h" id="viz-h2h"></div>
    <script type="application/json" id="owner-viz-data">${json}</script>
  </section>
  <script src="../static/js/d3.v7.min.js"></script>
  <script src="../static/js/owner-charts.js?v=1"></script>
  ${VIZ_END}`
}

export function injectSection(content, sectionHtml) {
  const markerRe = new RegExp(`${VIZ_START}[\\s\\S]*?${VIZ_END}`)
  const stripped = content.replace(markerRe, '')

  const draftStart = '<!-- DRAFT_HISTORY_START -->'
  const draftIdx = stripped.indexOf(draftStart)
  if (draftIdx !== -1) {
    return stripped.slice(0, draftIdx) + sectionHtml + '\n  ' + stripped.slice(draftIdx)
  }
  const closeIdx = stripped.lastIndexOf('</main>')
  if (closeIdx === -1) return stripped
  return stripped.slice(0, closeIdx) + sectionHtml + '\n  ' + stripped.slice(closeIdx)
}

function statsRows() {
  const csvPath = join(__dirname, 'stats.csv')
  return Papa.parse(fs.readFileSync(csvPath, 'utf8'), {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
  }).data.filter(row => row.Owner)
}

async function main() {
  const offline = process.argv.includes('--offline')
  if (!offline) loadEnvFile()

  const owners = ownerCodes()
  const ownersMap = ownerById()
  const seasons = []
  for (let s = FIRST_SEASON; s <= defaultSeason(); s++) seasons.push(s)

  const seasonGamesList = []
  for (const season of seasons) {
    const loaded = await loadLeague(season, offline)
    if (!loaded) continue
    const games = extractGames(loaded.league)
    if (loaded.source === 'network') {
      console.log(`Season ${season}: ${games.length} decided games fetched`)
    } else {
      console.log(`Season ${season}: ${games.length} decided games from cache`)
    }
    seasonGamesList.push({ season, games })
  }

  const rows = statsRows()
  const h2h = computeH2H(seasonGamesList, ownersMap, owners)
  const elo = computeElo(seasonGamesList, rows, ownersMap, owners)
  const pfpa = pfpaFromStats(rows, owners)
  const generated = new Date().toISOString().slice(0, 10)

  console.log(`H2H games counted: ${h2h.counted}, skipped (unmapped): ${h2h.skipped}`)

  for (const [teamId, entry] of Object.entries(TEAM_OWNERS)) {
    const payload = payloadFor(entry.owner, { generated, pfpa, elo, h2h, owners })
    const sectionHtml = renderSection(payload)
    const pagePath = join(SRC_DIR, entry.page)
    if (!fs.existsSync(pagePath)) {
      console.warn(`File not found: ${pagePath}`)
      continue
    }
    const updated = injectSection(fs.readFileSync(pagePath, 'utf8'), sectionHtml)
    fs.writeFileSync(pagePath, updated)
    console.log(`Updated ${entry.page} (${entry.owner}, final Elo ${elo.finals[entry.owner] ?? '-'})`)
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch(err => {
    console.error(err.message)
    process.exit(1)
  })
}
