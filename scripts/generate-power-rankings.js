import fs from 'fs'
import Papa from 'papaparse'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

const LEAGUE_ID = process.env.FANTASY_LEAGUE_ID || '794521'
const API_BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl'
const USER_AGENT = 'derbruden.com power rankings generator'

const K_FACTOR = 20
const BASE_RATING = 1500

// ESPN team id -> owner code and page. Team ids are stable franchise slots,
// but verify against the league each August and adjust after the draft.
// Cross-check: 2025 W-L-PF per team matched stats.csv season 25 exactly.
const TEAM_OWNERS = {
  1: { owner: 'GM', page: 'gm.html' },
  2: { owner: 'DM', page: 'dm.html' },
  4: { owner: 'AN', page: 'an.html' },
  5: { owner: 'AR', page: 'ar.html' },
  7: { owner: 'CR', page: 'cr.html' },
  8: { owner: 'DN', page: 'dn.html' },
  9: { owner: 'JO', page: 'jo.html' },
  10: { owner: 'ZS', page: 'zs.html' },
  11: { owner: 'IK', page: 'ik.html' },
  12: { owner: 'JH', page: 'jh.html' },
}

const STATE_PATH = join(__dirname, 'power-rankings-state.json')
const SRC_DIR = join(__dirname, '../src')
const PAGE_PATH = join(SRC_DIR, 'power-rankings.html')

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
  const url = `${API_BASE}/seasons/${season}/segments/0/leagues/${LEAGUE_ID}` + '?view=mTeam&view=mMatchupScore'
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

function saveState(season, rankings) {
  const ranks = {}
  for (const row of rankings) ranks[row.id] = row.rank
  fs.writeFileSync(STATE_PATH, JSON.stringify({ season, ranks }, null, 2))
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
      return `<tr>
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
  <div class="table-container"><table class="stats-table">
  <thead>
    <tr>
      <th class="number">&Delta;</th>
      <th class="number">Rank</th>
      <th>Owner</th>
      <th>Team</th>
      <th class="number">W-L</th>
      <th class="number">PF/G</th>
      <th class="number">Avg Opp</th>
      <th class="number">Rating | &darr;</th>
    </tr>
  </thead>
  <tbody>
    ${rows}
  </tbody>
</table></div>`
}

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function pageTemplate(content) {
  return `<!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DerBruden.com | Power Rankings</title>
  <link rel="icon" href="../static/ico/header-icon-32.png" type="image/x-icon">
  <link rel="shortcut icon" href="../static/ico/header-icon-32.png" type="image/x-icon">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Archivo:ital,wght@0,100..900;1,100..900&display=swap"
    rel="stylesheet">
  <style>
    body {
      font-family: "Archivo", sans-serif;
      line-height: 1.6;
      margin: 0;
      padding: 20px;
      max-width: 1200px;
      margin: 0 auto;
    }

    .header {
      display: flex;
      align-items: center;
    }

    .header-container {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0px;
    }

    .logo {
      width: 100px;
      height: 75px;
    }

    .site-title {
      margin: 0;
      font-size: 24px;
    }

    .tagline {
      margin: 0;
      color: #666;
    }

    .sponsor-box {
      border: 1px solid #eee;
      padding: 15px;
      border-radius: 5px;
      display: flex;
      align-items: center;
      gap: 15px;
      min-width: 300px;
    }

    .sponsor-box img {
      max-width: 100px;
      height: auto;
      margin-bottom: 0px;
    }

    .sponsor-content {
      flex: 1;
      text-align: left;
      font-size: 0.7em;
    }

    .sponsor-name {
      font-weight: bold;
      margin: 0;
    }

    .sponsor-tagline {
      color: #666;
      margin: 5px 0 0 0;
      max-width: 200px;
    }

    nav {
      margin-bottom: 30px;
    }

    footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #eee;
    }

    a {
      color: #000;
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }

    .table-container { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .stats-table {
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
      font-size: 0.9em;
    }

    .stats-table th {
      background-color: #f4f4f4;
      padding: 12px;
      text-align: left;
      border-bottom: 2px solid #ddd;
    }

    .stats-table td {
      padding: 10px 12px;
      border-bottom: 1px solid #eee;
    }

    .stats-table tbody tr:hover {
      background-color: #f8f8f8;
    }

    .stats-table .number {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    .stats-table .owner {
      font-weight: 500;
    }

    .stats-table td a {
      color: #00429f;
      text-decoration: underline;
    }

    .pr-meta {
      color: #666;
      font-size: 0.9em;
    }

    .delta.up { color: #1a7f37; }
    .delta.down { color: #c0392b; }

    .methodology {
      margin-top: 30px;
      font-size: 0.85em;
      color: #666;
    }

    @media (max-width: 768px) {
      .header-container {
        flex-direction: column;
        text-align: center;
      }

      .sponsor-box {
        margin-top: 20px;
        width: 100%;
      }
    }
  </style>
</head>

<body>
  <header>
    <div class="header-container">
      <div class="header">
        <a href="./index.html">
          <img src="../static/img/header-logo.webp" alt="DerBruden.com" class="logo" width="100" height="75">
        </a>
        <div>
          <h1 class="site-title">DerBruden.com</h1>
          <p class="tagline">Strange dreams lately?</p>
        </div>
      </div>

      <div class="sponsor-box">
        <a href="https://www.supplementsolutions.us/boozebetter?utm_source=derbruden.com&utm_medium=banner&utm_campaign=strangedreamslately"
          target="_blank" rel="noopener noreferrer"><img src="../static/img/about-sponsor.webp" alt="Booze Better"></a>
        <div class="sponsor-content">
          <p class="sponsor-tagline"><em>Brought to you by:</em></p>
          <p class="sponsor-name">Booze Better</p>
          <p class="sponsor-tagline">Drink Smart, Feel Better. The scientific solution to hangovers has finally arrived.
          </p>
          <a href="https://www.supplementsolutions.us/boozebetter?utm_source=derbruden.com&utm_medium=banner&utm_campaign=strangedreamslately"
            target="_blank" rel="noopener noreferrer">Learn more</a>.
        </div>
      </div>
    </div>
  </header>

  <nav>
    <p><a href="./about.html">About</a> || <a href="./owners.html">League Owners</a> || <a
        href="./power-rankings.html">Power Rankings</a></p>
  </nav>

  <main>
    <div class="owner-logo-header">
      <img src="../static/img/league-logo.webp" alt="DB Logo" width="100" height="100"
        style="border-radius: 50%; object-fit: cover;">
      <h1>Power Rankings</h1>
    </div>
    ${content}
    <details class="methodology">
      <summary>How these rankings work</summary>
      <p>Each team carries an Elo rating. Teams start near 1500. Last season's win percentage sets the starting point.</p>
      <p>After each game, the winner takes points from the loser. Blowouts move ratings more than close games. An upset moves ratings more than a win over a weaker team. Regular season games only.</p>
      <p>Avg Opp is the average rating of opponents faced. A low number means an easy schedule so far. Delta (&Delta;) compares this publish to the last one.</p>
      <p>Data comes from the ESPN fantasy API. This page regenerates weekly.</p>
    </details>
  </main>

  <footer>
    <p>
      <a href="https://fantasy.espn.com/football/league?leagueId=794521" target="_blank">ESPN</a> /
      <a href="https://discord.com/channels/870404843582406696/870404844681322549" target="_blank">Discord</a>
    </p>
  </footer>
</body>

</html>
`
}

function updatePage(rendered) {
  if (!fs.existsSync(PAGE_PATH)) {
    fs.writeFileSync(PAGE_PATH, pageTemplate(rendered))
    console.log(`Created ${PAGE_PATH}`)
    return
  }

  let content = fs.readFileSync(PAGE_PATH, 'utf8')

  const metaRegex = /<p class="pr-meta">[\s\S]*?<\/p>/
  const tableRegex = /<div class="table-container">[\s\S]*?<\/div>/

  if (metaRegex.test(content)) {
    content = content.replace(metaRegex, rendered.split('\n')[0])
  }
  const tableBlock = rendered.split('\n').slice(1).join('\n')
  if (tableRegex.test(content)) {
    content = content.replace(tableRegex, tableBlock)
    fs.writeFileSync(PAGE_PATH, content)
    console.log(`Updated ${PAGE_PATH}`)
  } else {
    console.warn(`Could not find table container in ${PAGE_PATH}`)
  }
}

async function main() {
  loadEnvFile()
  authHeaders()
  const [seasonArg] = process.argv.slice(2)
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

  saveState(season, rankings)
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
