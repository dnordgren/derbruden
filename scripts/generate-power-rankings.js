import fs from 'fs'
import Papa from 'papaparse'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { TEAM_OWNERS } from './team-owners.js'
import {
  applyEnvFile,
  defaultSeason,
  espnAuthHeaders,
  fetchLeague,
} from './lib/espn.mjs'
import { escapeHtml } from './lib/html.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const USER_AGENT = 'derbruden.com power rankings generator'

const K_FACTOR = 20
const BASE_RATING = 1500

const STATE_PATH = join(__dirname, 'power-rankings-state.json')
const SRC_DIR = join(__dirname, '../src')
const PAGE_PATH = join(SRC_DIR, 'index.html')

function authHeaders() {
  return espnAuthHeaders(process.env, USER_AGENT)
}

async function fetchSeason(season) {
  return fetchLeague({ season, views: ['mTeam', 'mMatchupScore'], headers: authHeaders() })
}

function priorSeasonRows(season) {
  const csvPath = join(__dirname, 'stats.csv')
  if (!fs.existsSync(csvPath)) return []
  const parsed = Papa.parse(fs.readFileSync(csvPath, 'utf8'), {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
  }).data
  return parsed.filter(row => row.Owner && row.Season === season % 100)
}

function seedRatings(season, teamsById) {
  const rows = priorSeasonRows(season - 1)
  const seeds = {}
  for (const team of Object.values(teamsById)) {
    const mapped = TEAM_OWNERS[team.id]
    const row = mapped && rows.find(r => r.Owner === mapped.owner)
    if (row && row.W + row.L > 0) {
      const winPct = row.W / (row.W + row.L)
      seeds[team.id] = Math.round(BASE_RATING + (winPct - 0.5) * 100)
    } else {
      seeds[team.id] = BASE_RATING
    }
  }
  return seeds
}

function extractTeams(league) {
  const teamsById = {}
  for (const team of league.teams) {
    teamsById[team.id] = {
      id: team.id,
      abbrev: team.abbrev,
      name: team.name || team.nickname || team.abbrev,
    }
  }
  return teamsById
}

function regularSeasonGames(league, teamsById) {
  const games = []
  let throughWeek = 0
  for (const matchup of league.schedule) {
    if (matchup.playoffTierType !== 'NONE') continue
    const home = matchup.home
    const away = matchup.away
    if (
      !teamsById[home.teamId] ||
      !teamsById[away.teamId] ||
      typeof home.totalPoints !== 'number' ||
      typeof away.totalPoints !== 'number'
    ) {
      continue
    }
    // ESPN sends "HOME" or "AWAY"; ties come back as "tie".
    // Unplayed games carry "UNDECIDED" and zero points.
    const winner = String(matchup.winner || '').toLowerCase()
    if (!['home', 'away', 'tie'].includes(winner)) continue
    games.push({
      week: matchup.matchupPeriodId,
      homeId: home.teamId,
      awayId: away.teamId,
      homeScore: home.totalPoints,
      awayScore: away.totalPoints,
      winner,
    })
    if (matchup.matchupPeriodId > throughWeek) throughWeek = matchup.matchupPeriodId
  }
  return games
}

function movMultiplier(margin, winnerRating, loserRating) {
  const base = Math.log(1 + margin / 10)
  // Beat a stronger opponent and the win counts extra.
  const cap = 2.2 / ((winnerRating - loserRating) * 0.001 + 2.2)
  return Math.min(base * cap, 2.4)
}

function computeRankings(games, seeds, teamsById) {
  const ratings = { ...seeds }
  const stats = {}
  for (const id of Object.keys(teamsById).map(Number)) {
    stats[id] = { wins: 0, losses: 0, ties: 0, pf: 0, pa: 0, opponents: [] }
  }

  const orderedGames = [...games].sort((a, b) => a.week - b.week)
  for (const game of orderedGames) {
    const { homeId, awayId, homeScore, awayScore, winner } = game
    const homeRating = ratings[homeId]
    const awayRating = ratings[awayId]
    const homeExpected = 1 / (1 + 10 ** ((awayRating - homeRating) / 400))
    const homeActual = winner === 'home' ? 1 : winner === 'away' ? 0 : 0.5
    const margin = Math.abs(homeScore - awayScore)

    if (margin > 0) {
      const [winnerId, loserId] = homeScore > awayScore ? [homeId, awayId] : [awayId, homeId]
      const mult = movMultiplier(margin, ratings[winnerId], ratings[loserId])
      const delta = Math.round(K_FACTOR * mult * (homeActual - homeExpected))
      ratings[homeId] += delta
      ratings[awayId] -= delta
    }

    stats[homeId].pf += homeScore
    stats[homeId].pa += awayScore
    stats[awayId].pf += awayScore
    stats[awayId].pa += homeScore
    stats[homeId].opponents.push(awayId)
    stats[awayId].opponents.push(homeId)
    if (winner === 'home') {
      stats[homeId].wins += 1
      stats[awayId].losses += 1
    } else if (winner === 'away') {
      stats[awayId].wins += 1
      stats[homeId].losses += 1
    } else {
      stats[homeId].ties += 1
      stats[awayId].ties += 1
    }
  }

  return Object.values(teamsById)
    .map(team => {
      const s = stats[team.id]
      const gamesPlayed = s.wins + s.losses + s.ties
      const sos =
        s.opponents.length > 0
          ? s.opponents.reduce((sum, id) => sum + ratings[id], 0) / s.opponents.length
          : ratings[team.id]
      return {
        ...team,
        rating: ratings[team.id],
        wins: s.wins,
        losses: s.losses,
        ties: s.ties,
        pf: s.pf,
        pa: s.pa,
        ppg: gamesPlayed > 0 ? s.pf / gamesPlayed : 0,
        sos,
        gamesPlayed,
      }
    })
    .sort((a, b) => b.rating - a.rating || b.pf - a.pf)
    .map((row, index) => ({ ...row, rank: index + 1 }))
}

function loadPreviousRanks(season) {
  if (!fs.existsSync(STATE_PATH)) return null
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
    if (state.season !== season) return null
    return state.ranks
  } catch {
    return null
  }
}

function saveState(season, rankings, meta) {
  const ranks = {};
  const published = rankings.map(row => ({
    rank: row.rank,
    id: row.id,
    owner: TEAM_OWNERS[row.id]?.owner ?? row.abbrev,
    name: row.name,
    rating: row.rating,
    record: `${row.wins}-${row.losses}${row.ties ? `-${row.ties}` : ''}`,
  }));
  for (const row of rankings) ranks[row.id] = row.rank;
  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify(
      {
        season,
        week: meta.throughWeek,
        generated: meta.generated,
        ranks,
        published,
      },
      null,
      2
    )
  );
}

function deltaCell(row, previousRanks) {
  if (!previousRanks || !(row.id in previousRanks)) {
    return '<td class="number delta">&ndash;</td>'
  }
  const diff = previousRanks[row.id] - row.rank
  if (diff > 0) return `<td class="number delta up">&#9650;${diff}</td>`
  if (diff < 0) return `<td class="number delta down">&#9660;${-diff}</td>`
  return '<td class="number delta">&ndash;</td>'
}

function renderTable(rankings, meta) {
  const previousRanks = meta.previousRanks
  const rows = rankings
    .map(row => {
      const mapped = TEAM_OWNERS[row.id]
      const ownerCell = mapped
        ? `<td class="owner"><a href="./${mapped.page}">${mapped.owner}</a></td>`
        : `<td class="owner">${row.abbrev}</td>`
      return `<tr${row.rank === 1 ? ' class="leader-row"' : ''}>
      ${deltaCell(row, previousRanks)}
      <td class="number">${row.rank}</td>
      ${ownerCell}
      <td>${escapeHtml(row.name)}</td>
      <td class="number">${row.wins}-${row.losses}${row.ties ? `-${row.ties}` : ''}</td>
      <td class="number">${row.ppg.toFixed(1)}</td>
      <td class="number">${Math.round(row.sos)}</td>
      <td class="number"><strong>${row.rating}</strong></td>
    </tr>`
    })
    .join('\n')

  return `<p class="pr-meta">${meta.season} season &middot; through week ${meta.throughWeek} &middot; generated ${meta.generated}</p>
  <div class="table-container" tabindex="0"><table class="stats-table">
  <caption class="visually-hidden">${meta.season} Elo power rankings</caption>
  <thead>
    <tr>
      <th scope="col" class="number">&Delta;</th>
      <th scope="col" class="number">Rank</th>
      <th scope="col">Owner</th>
      <th scope="col">Team</th>
      <th scope="col" class="number">W-L</th>
      <th scope="col" class="number">PF/G</th>
      <th scope="col" class="number">Avg Opp</th>
      <th scope="col" class="number">Rating | &darr;</th>
    </tr>
  </thead>
  <tbody>
    ${rows}
  </tbody>
</table></div>`
}

function updatePage(rendered) {
  if (!fs.existsSync(PAGE_PATH)) {
    throw new Error(`Index page not found: ${PAGE_PATH}`)
  }

  let content = fs.readFileSync(PAGE_PATH, 'utf8')

  const metaRegex = /<p class="pr-meta">[\s\S]*?<\/p>/
  const tableRegex = /<div class="table-container"[^>]*>[\s\S]*?<\/div>/

  if (!metaRegex.test(content) || !tableRegex.test(content)) {
    // First run after the move: insert the rankings section at the top of <main>.
    const section = `<section id="power-rankings" aria-labelledby="power-rankings-heading">
      <h2 id="power-rankings-heading">Power Rankings</h2>
      ${rendered}
    </section>`
    const mainRegex = /<main id="main">\s*/
    if (!mainRegex.test(content)) {
      throw new Error(`Could not find <main id="main"> in ${PAGE_PATH}`)
    }
    content = content.replace(mainRegex, match => `${match}${section}\n    `)
    fs.writeFileSync(PAGE_PATH, content)
    console.log(`Inserted power rankings into ${PAGE_PATH}`)
    return
  }

  content = content.replace(metaRegex, rendered.split('\n')[0])
  const tableBlock = rendered.split('\n').slice(1).join('\n')
  content = content.replace(tableRegex, tableBlock)
  fs.writeFileSync(PAGE_PATH, content)
  console.log(`Updated ${PAGE_PATH}`)
}

async function main() {
  applyEnvFile(join(__dirname, '.env'))
  authHeaders()
  const [seasonArg] = process.argv.slice(2)
  const preferred = Number(seasonArg) || defaultSeason()

  let league
  try {
    league = await fetchSeason(preferred)
  } catch (err) {
    if (seasonArg) throw err
    const fallback = preferred - 1
    console.warn(`${err.message} Falling back to season ${fallback}.`)
    league = await fetchSeason(fallback)
  }

  const season = league.seasonId
  const teamsById = extractTeams(league)
  const games = regularSeasonGames(league, teamsById)
  const seeds = seedRatings(season, teamsById)
  const rankings = computeRankings(games, seeds, teamsById)

  const throughWeek = games.reduce((max, g) => Math.max(max, g.week), 0)
  const meta = {
    season,
    throughWeek,
    generated: new Date().toISOString().slice(0, 10),
    previousRanks: loadPreviousRanks(season),
  }

  saveState(season, rankings, meta)
  updatePage(renderTable(rankings, meta))

  for (const row of rankings) {
    console.log(
      `${String(row.rank).padStart(2)}. ${TEAM_OWNERS[row.id]?.owner ?? row.abbrev}` +
        ` (${row.name}) ${row.rating} ${row.wins}-${row.losses}${row.ties ? `-${row.ties}` : ''}`
    )
  }
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
