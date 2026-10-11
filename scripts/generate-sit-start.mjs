#!/usr/bin/env node
// Sit/start efficiency generator. For every decided regular-season week
// (2018 on, matching the luck/power-rankings convention), compare each
// team's actual starter points (lineupSlotId set at fetch time) against the
// optimal starter total from the same rostered pool (backtracking, same
// approach as the trade-grades optimalLineup).
//
// Usage:
//   node scripts/generate-sit-start.mjs [--offline] [season]
// --offline reuses scripts/.sitstart-cache and never hits the network.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import Papa from 'papaparse'
import { TEAM_OWNERS } from './team-owners.js'
import { extractRegularSeasonGames, makeOwnerLookup, seasonTeamMeta } from './generate-luck.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const LEAGUE_ID = process.env.FANTASY_LEAGUE_ID || '794521'
const API_BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl'
const USER_AGENT = 'derbruden.com sit-start efficiency generator'
const API_FIRST_SEASON = 2018

const CACHE_DIR = path.join(__dirname, '.sitstart-cache')
const DATA_PATH = path.join(__dirname, '../static/data/sit-start.json')
const PAGE_PATH = path.join(__dirname, '../src/sit-start.html')
const SRC_DIR = path.join(__dirname, '../src')

// ESPN lineupSlotIds: QB 0, RB 2, WR 4, TE 6, D/ST 16, K 17, FLEX 23.
// Bench/IR slots (20, 21, ...) never start.
export const STARTER_SLOTS = new Set([0, 2, 4, 6, 16, 17, 23])
export const SLOT_COUNT_FALLBACK = { 0: 1, 2: 2, 4: 2, 6: 1, 23: 1, 16: 1, 17: 1 }
export const SITSTART_START = '<!-- SITSTART_START -->'
export const SITSTART_END = '<!-- SITSTART_END -->'
// Two scores that differ only by float dust or sub-cent display rounding
// count as a perfect week.
export const PERFECT_EPS = 0.005
// Regular-season W-L per owner per full year, from stats.csv (seasons are
// two-digit there: 25 -> 2025). The in-progress season has no row yet.
export function loadWinPct(csvPath = path.join(__dirname, 'stats.csv')) {
  const parsed = Papa.parse(fs.readFileSync(csvPath, 'utf8'), {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
  }).data
  const out = {}
  for (const row of parsed) {
    if (!row.Owner || row.W == null || row.L == null) continue
    const year = 2000 + Number(row.Season)
    const w = Number(row.W)
    const l = Number(row.L)
    if (!Number.isFinite(year) || !Number.isFinite(w) || !Number.isFinite(l) || w + l === 0) continue
    if (!out[row.Owner]) out[row.Owner] = {}
    out[row.Owner][year] = { wins: w, losses: l, winPct: Math.round((w / (w + l)) * 1000) / 1000 }
  }
  return out
}
function fmtWinPct(r) {
  if (r.winPct == null) return '\u2014'
  return r.winPct.toFixed(3).replace('0.', '.')
}
function winPctTitle(r) {
  if (r.winPct == null) return 'No final record yet'
  return `${r.wins}-${r.losses}`
}
// Former owners removed from sit/start tables (kicked out of the league).
// Filtered in both aggregate functions so season rows, ranks, and career
// all stay consistent. Add future removals here.
export const EXCLUDED_OWNERS = new Set(['SHEN'])

export function defaultSeason() {
  const now = new Date()
  return now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1
}

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env')
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
  return { Cookie: cookie, 'User-Agent': USER_AGENT }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function cacheRead(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, name), 'utf8'))
  } catch {
    return null
  }
}

function cacheWrite(name, data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  fs.writeFileSync(path.join(CACHE_DIR, name), JSON.stringify(data))
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) throw new Error(`ESPN API returned ${res.status} for ${url}`)
  return res.json()
}

// Starter slot list from mSettings lineupSlotCounts, e.g.
// [0, 2, 2, 4, 4, 6, 23, 16, 17] for the standard 9-starter lineup.
export function starterSlotList(slotCounts) {
  const counts = slotCounts || SLOT_COUNT_FALLBACK
  const slots = []
  for (const slot of STARTER_SLOTS) {
    const n = Number(counts[slot] ?? counts[String(slot)] ?? 0)
    for (let i = 0; i < n; i++) slots.push(slot)
  }
  return slots
}

// Applied fantasy total for one scoring period, or null when the player
// has no actual-stat split that week (bye, injured, not yet playing).
export function weekScoreOf(player, week) {
  const split = (player.stats || []).find(
    s => s.statSourceId === 0 && s.statSplitTypeId === 1 && s.scoringPeriodId === week
  )
  return split ? Number(split.appliedTotal) || 0 : null
}

// Per-team weekly rosters: every rostered player with that week's score,
// actual starting slot, and the starter slots he is eligible to fill.
export function rosterWeek(league, week) {
  const out = {}
  for (const t of league.teams || []) {
    const entries = []
    for (const e of t.roster?.entries || []) {
      const player = e.playerPoolEntry?.player
      if (!player) continue
      const points = weekScoreOf(player, week)
      if (points == null) continue
      entries.push({
        playerId: e.playerId,
        points,
        lineupSlotId: e.lineupSlotId,
        elig: (player.eligibleSlots || []).filter(s => STARTER_SLOTS.has(s)),
      })
    }
    out[t.id] = entries
  }
  return out
}

// Points the manager actually started: sum of week scores for entries
// whose lineupSlotId is a starter slot. Negative scores (e.g. D/ST) are
// kept as-is so actual matches the official matchup total; optimal still
// benches negatives for 0 per the trade-grades convention.
export function actualLineupScore(entries) {
  let total = 0
  for (const e of entries) {
    if (STARTER_SLOTS.has(e.lineupSlotId)) total += e.points
  }
  return Math.round(total * 100) / 100
}

// Best achievable starter total from a pool of {points, elig[]}.
// Backtracking over at most ~9 starter slots; empty slots score 0.
export function optimalLineup(pool, slots) {
  const sorted = [...pool].sort((a, b) => b.points - a.points)
  const used = new Array(slots.length).fill(false)
  let best = 0
  const prefix = [0]
  for (const p of sorted) prefix.push(prefix[prefix.length - 1] + Math.max(0, p.points))
  function bound(i, total) {
    const remainingSlots = used.filter(u => !u).length
    return total + (prefix[Math.min(i + remainingSlots, sorted.length)] - prefix[i])
  }
  function search(i, total) {
    if (i >= sorted.length) {
      if (total > best) best = total
      return
    }
    if (bound(i, total) <= best) return
    const p = sorted[i]
    for (let s = 0; s < slots.length; s++) {
      if (!used[s] && p.elig.includes(slots[s])) {
        used[s] = true
        search(i + 1, total + Math.max(0, p.points))
        used[s] = false
      }
    }
    search(i + 1, total)
  }
  search(0, 0)
  return Math.round(best * 100) / 100
}

// One team's week: { actual, optimal, perfect }.
export function scoreTeamWeek(entries, slots) {
  const actual = actualLineupScore(entries)
  const optimal = optimalLineup(
    entries.map(p => ({ points: p.points, elig: p.elig })),
    slots
  )
  return { actual, optimal, perfect: Math.abs(actual - optimal) < PERFECT_EPS }
}

export function efficiencyOf(actual, optimal) {
  if (!(optimal > 0)) return 0
  return Math.round((actual / optimal) * 1000) / 1000
}

function round1(n) {
  return Math.round(n * 10) / 10
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function ownerLink(owner) {
  const mapped = Object.values(TEAM_OWNERS).find(m => m.owner === owner)
  return mapped ? `<a href="./${mapped.page}">${escapeHtml(owner)}</a>` : escapeHtml(owner)
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

// ---------------------------------------------------------------------------
// Fetching (network with file cache, --offline for cache only)
// ---------------------------------------------------------------------------

async function loadSchedule(season, offline) {
  const name = `schedule-${season}.json`
  if (offline) {
    const cached = cacheRead(name)
    if (!cached) throw new Error(`No cached schedule for ${season} (offline mode)`)
    return cached
  }
  try {
    const url = `${API_BASE}/seasons/${season}/segments/0/leagues/${LEAGUE_ID}?view=mTeam&view=mMatchupScore`
    const data = await fetchJson(url)
    cacheWrite(name, data)
    await sleep(120)
    return data
  } catch (err) {
    const cached = cacheRead(name)
    if (cached) {
      console.warn(`Season ${season}: ${err.message}; using cache.`)
      return cached
    }
    throw err
  }
}

async function loadSettings(season, offline) {
  const name = `settings-${season}.json`
  const cached = cacheRead(name)
  if (cached) return cached
  if (offline) return null
  const url = `${API_BASE}/seasons/${season}/segments/0/leagues/${LEAGUE_ID}?view=mSettings`
  const data = await fetchJson(url)
  const counts = data.settings?.rosterSettings?.lineupSlotCounts || null
  cacheWrite(name, counts)
  await sleep(120)
  return counts
}

async function loadRoster(season, week, offline) {
  const name = `roster-${season}-sp-${week}.json`
  const cached = cacheRead(name)
  if (cached) return cached
  if (offline) throw new Error(`No cached roster for ${season} week ${week} (offline mode)`)
  const url = `${API_BASE}/seasons/${season}/segments/0/leagues/${LEAGUE_ID}?view=mRoster&scoringPeriodId=${week}`
  const data = await fetchJson(url)
  cacheWrite(name, data)
  await sleep(120)
  return data
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function aggregateSeason(ownerWeekRows) {
  // ownerWeekRows: [{ owner, team, teamId, week, actual, optimal, perfect }]
  const byOwner = new Map()
  for (const r of ownerWeekRows) {
    if (EXCLUDED_OWNERS.has(r.owner)) continue
    if (!byOwner.has(r.owner)) {
      byOwner.set(r.owner, {
        owner: r.owner,
        team: r.team,
        teamId: r.teamId,
        weeks: 0,
        actual: 0,
        optimal: 0,
        perfectWeeks: 0,
      })
    }
    const row = byOwner.get(r.owner)
    row.team = r.team || row.team
    row.weeks += 1
    row.actual = Math.round((row.actual + r.actual) * 100) / 100
    row.optimal = Math.round((row.optimal + r.optimal) * 100) / 100
    if (r.perfect) row.perfectWeeks += 1
  }
  const rows = [...byOwner.values()].map(r => ({
    ...r,
    actual: round1(r.actual),
    optimal: round1(r.optimal),
    efficiency: efficiencyOf(r.actual, r.optimal),
    perfectPct: r.weeks ? Math.round((r.perfectWeeks / r.weeks) * 1000) / 1000 : 0,
  }))
  rows.sort((a, b) => b.efficiency - a.efficiency || b.optimal - a.optimal || a.owner.localeCompare(b.owner))
  rows.forEach((r, i) => (r.rank = i + 1))
  return rows
}

export function aggregateCareer(perSeasonRows) {
  // perSeasonRows: { season: rows[] } -> career rows keyed by owner
  const byOwner = new Map()
  for (const [season, rows] of Object.entries(perSeasonRows)) {
    for (const r of rows) {
      if (EXCLUDED_OWNERS.has(r.owner)) continue
      if (!byOwner.has(r.owner)) {
        byOwner.set(r.owner, {
          owner: r.owner,
          team: r.team,
          teamId: r.teamId,
          seasons: 0,
          weeks: 0,
          actual: 0,
          optimal: 0,
          perfectWeeks: 0,
        })
      }
      const c = byOwner.get(r.owner)
      c.team = r.team || c.team
      c.seasons += 1
      c.weeks += r.weeks
      c.actual = Math.round((c.actual + r.actual) * 100) / 100
      c.optimal = Math.round((c.optimal + r.optimal) * 100) / 100
      c.perfectWeeks += r.perfectWeeks
      void season
    }
  }
  const rows = [...byOwner.values()].map(r => ({
    ...r,
    actual: round1(r.actual),
    optimal: round1(r.optimal),
    efficiency: efficiencyOf(r.actual, r.optimal),
    perfectPct: r.weeks ? Math.round((r.perfectWeeks / r.weeks) * 1000) / 1000 : 0,
  }))
  rows.sort((a, b) => b.efficiency - a.efficiency || b.weeks - a.weeks || a.owner.localeCompare(b.owner))
  rows.forEach((r, i) => (r.rank = i + 1))
  return rows
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderCareerTable(rows) {
  if (!rows.length) return `<p class="section-note">No seasons with decided games yet.</p>`
  const body = rows
    .map(
      r => `<tr>
        <td class="number">${r.rank}</td>
        <td class="owner">${ownerLink(r.owner)}</td>
        <td>${escapeHtml(r.team)}</td>
        <td class="number">${r.seasons}</td>
        <td class="number">${r.weeks}</td>
        <td class="number">${fmt(r.actual)}</td>
        <td class="number">${fmt(r.optimal)}</td>
        <td class="number">${(r.efficiency * 100).toFixed(1)}%</td>
        <td class="number" title="${winPctTitle(r)}">${fmtWinPct(r)}</td>
        <td class="number">${r.perfectWeeks}</td>
        <td class="number">${(r.perfectPct * 100).toFixed(0)}%</td>
      </tr>`
    )
    .join('\n')
  return `<div class="table-container"><table class="stats-table">
    <caption class="visually-hidden">Career sit-start efficiency</caption>
    <thead>
      <tr>
        <th scope="col" class="number">Rank</th>
        <th scope="col">Owner</th>
        <th scope="col">Team</th>
        <th scope="col" class="number">Seasons</th>
        <th scope="col" class="number">Weeks</th>
        <th scope="col" class="number">Actual</th>
        <th scope="col" class="number">Optimal</th>
        <th scope="col" class="number">Eff%</th>
        <th scope="col" class="number">Win%</th>
        <th scope="col" class="number">Perfect</th>
        <th scope="col" class="number">Perfect%</th>
      </tr>
    </thead>
    <tbody>
${body}
    </tbody>
  </table></div>`
}

function renderSeasonTable(rows, caption) {
  if (!rows.length) return `<p class="section-note">No decided regular-season games for this season.</p>`
  const body = rows
    .map(
      r => `<tr>
        <td class="number">${r.rank}</td>
        <td class="owner">${ownerLink(r.owner)}</td>
        <td>${escapeHtml(r.team)}</td>
        <td class="number">${r.weeks}</td>
        <td class="number">${fmt(r.actual)}</td>
        <td class="number">${fmt(r.optimal)}</td>
        <td class="number">${(r.efficiency * 100).toFixed(1)}%</td>
        <td class="number" title="${winPctTitle(r)}">${fmtWinPct(r)}</td>
        <td class="number">${r.perfectWeeks}</td>
      </tr>`
    )
    .join('\n')
  return `<div class="table-container"><table class="stats-table">
    <caption class="visually-hidden">${escapeHtml(caption)}</caption>
    <thead>
      <tr>
        <th scope="col" class="number">Rank</th>
        <th scope="col">Owner</th>
        <th scope="col">Team</th>
        <th scope="col" class="number">Weeks</th>
        <th scope="col" class="number">Actual</th>
        <th scope="col" class="number">Optimal</th>
        <th scope="col" class="number">Eff%</th>
        <th scope="col" class="number">Win%</th>
        <th scope="col" class="number">Perfect</th>
      </tr>
    </thead>
    <tbody>
${body}
    </tbody>
  </table></div>`
}

function renderSeasonSelector(seasons, selected) {
  if (seasons.length <= 1) return ''
  const options = seasons
    .slice()
    .sort((a, b) => b - a)
    .map(s => `<option value="${s}" ${String(s) === String(selected) ? 'selected' : ''}>${s}</option>`)
    .join('\n')
  return `<p class="section-note"><label for="sitstart-season-select">Season: </label><select id="sitstart-season-select">${options}</select></p>`
}

export function renderPageContent(data) {
  const seasons = Object.keys(data.perSeason)
    .map(Number)
    .sort((a, b) => a - b)
  const currentRows = data.perSeason[data.defaultSeason]?.rows || []
  const selector = renderSeasonSelector(seasons, data.defaultSeason)
  const json = JSON.stringify(data).replace(/<\//g, '<\\/')
  return `<h2>Career Efficiency</h2>
<p class="section-note">Actual starter points divided by optimal starter points across every decided regular-season week since 2018. A perfect week means the manager started the highest-scoring legal lineup. Regular season only.</p>
${renderCareerTable(data.career)}
<h2>Efficiency Trend</h2>
<p class="section-note">Season-by-season efficiency for every owner. Y-axis starts at 75% so the gaps are visible. Select an owner below to toggle their line; isolate a single owner to overlay their win% (dashed, right axis). Starts with one random owner isolated.</p>
<div class="legend-row" id="sitstart-legend"></div>
<div class="viz-chart" id="sitstart-chart" tabindex="0" role="region" aria-label="Season-by-season sit-start efficiency by owner, percent. Y-axis starts at 75 percent."></div>
<h2>By Season</h2>
${selector}
<div id="sitstart-table-wrap">
${renderSeasonTable(currentRows, `${data.defaultSeason} sit-start efficiency`)}
</div>
<script type="application/json" id="sitstart-data">${json}</script>
<script src="../static/js/d3.v7.min.js" defer></script>
<script src="../static/js/sit-start.js?v=5"></script>`
}

function pageTemplate(content) {
  return `<!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DerBruden.com | Sit/Start Efficiency</title>
  <meta property="og:title" content="DerBruden.com | Sit/Start Efficiency">
  <meta property="og:description" content="Sit/start efficiency for the Der Bruden fantasy football league: actual starter points versus the optimal lineup, season by season.">
  <meta property="og:url" content="https://derbruden.com/sit-start.html">
  <meta property="og:image" content="https://derbruden.com/static/img/league-logo.webp?v=1">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="DerBruden.com | Sit/Start Efficiency">
  <meta name="twitter:description" content="Actual starter points versus the optimal lineup, season by season.">
  <meta name="twitter:image" content="https://derbruden.com/static/img/league-logo.webp?v=1">
  <!--#include file="partials/head-common.html" -->
  <style>
    .section-note {
      color: #666;
      font-size: 0.9em;
    }
    h2 { margin-top: 40px; }
    .stats-table td.owner {
      font-weight: 500;
      white-space: nowrap;
    }
    select {
      font-size: 0.95em;
      padding: 4px 8px;
    }
    .legend-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 8px 0 4px;
    }
    .legend-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 0.85em;
      padding: 3px 10px 3px 6px;
      border: 1px solid var(--line, #ddd);
      border-radius: 999px;
      background: var(--surface, #fff);
      color: inherit;
      cursor: pointer;
    }
    .legend-chip .swatch {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      display: inline-block;
    }
    .legend-chip.off {
      opacity: 0.45;
    }
    .legend-chip.legend-all {
      font-weight: 700;
    }
    .methodology {
      margin-top: 30px;
      font-size: 0.85em;
      color: #666;
    }
    .methodology code {
      background: #f4f4f4;
      padding: 1px 4px;
      border-radius: 3px;
    }
  </style>
</head>

<body>
  <!--#include file="partials/site-header.html" -->

  <!--#include file="partials/nav.html" -->

  <main id="main">
    <div class="owner-logo-header">
      <img src="../static/img/league-logo.webp?v=1" alt="DB Logo" width="100" height="100"
        style="border-radius: 50%; object-fit: cover;">
      <h1>Sit/Start Efficiency</h1>
    </div>
    ${SITSTART_START}
${content}
${SITSTART_END}
    <details class="methodology">
      <summary>How these numbers work</summary>
      <p><strong>Actual:</strong> points scored by the lineup the manager actually started that week (ESPN lineupSlotId at kickoff: QB, 2 RB, 2 WR, TE, FLEX, D/ST, K).</p>
      <p><strong>Optimal:</strong> the highest-scoring legal lineup chosen from the same week's rostered players (backtracking over eligible slots; empty slots score 0).</p>
      <p><strong>Efficiency</strong> = actual / optimal. <strong>Perfect</strong> weeks are weeks where actual equals optimal. Regular-season decided weeks only, 2018 on.</p>
      <p>Regenerate with <code>make sitstart</code>.</p>
    </details>
  </main>

  <!--#include file="partials/footer.html" -->
</body>

</html>
`
}

export function upsertPage(contentHtml, pagePath = PAGE_PATH) {
  const section = `${SITSTART_START}\n${contentHtml}\n${SITSTART_END}`
  if (!fs.existsSync(pagePath)) {
    fs.writeFileSync(pagePath, pageTemplate(contentHtml))
    console.log(`Created ${pagePath}`)
    return
  }
  const content = fs.readFileSync(pagePath, 'utf8')
  const startIdx = content.indexOf(SITSTART_START)
  const endIdx = content.indexOf(SITSTART_END)
  if (startIdx === -1 || endIdx === -1) {
    console.warn(`Markers missing in ${pagePath}; page left untouched`)
    return
  }
  fs.writeFileSync(pagePath, content.slice(0, startIdx) + section + content.slice(endIdx + SITSTART_END.length))
  console.log(`Updated ${pagePath}`)
}

// Owner-page section: season-by-season table plus a career row. Inserted
// after the draft-history block so generate-stats.js tables are untouched.
export function renderOwnerSection(ownerRows, careerRow) {
  const body = ownerRows
    .map(
      r => `<tr>
        <td class="number">${r.season}</td>
        <td class="number">${r.weeks}</td>
        <td class="number">${fmt(r.actual)}</td>
        <td class="number">${fmt(r.optimal)}</td>
        <td class="number">${(r.efficiency * 100).toFixed(1)}%</td>
        <td class="number" title="${winPctTitle(r)}">${fmtWinPct(r)}</td>
        <td class="number">${r.perfectWeeks}</td>
      </tr>`
    )
    .join('\n')
  const career = careerRow
    ? `<tr class="totals-row">
        <td class="number">Career</td>
        <td class="number">${careerRow.weeks}</td>
        <td class="number">${fmt(careerRow.actual)}</td>
        <td class="number">${fmt(careerRow.optimal)}</td>
        <td class="number">${(careerRow.efficiency * 100).toFixed(1)}%</td>
        <td class="number" title="${winPctTitle(careerRow)}">${fmtWinPct(careerRow)}</td>
        <td class="number">${careerRow.perfectWeeks}</td>
      </tr>`
    : ''
  return `${SITSTART_START}
  <section class="sit-start">
    <h2>Sit/Start Efficiency</h2>
    <p class="section-note">Actual starter points versus the best legal lineup from the same roster. <a href="./sit-start.html">League leaderboard</a>.</p>
    <div class="table-container" tabindex="0"><table class="stats-table">
  <caption class="visually-hidden">Season-by-season sit-start efficiency</caption>
  <thead>
    <tr>
      <th scope="col" class="number">Season</th>
      <th scope="col" class="number">Weeks</th>
      <th scope="col" class="number">Actual</th>
      <th scope="col" class="number">Optimal</th>
      <th scope="col" class="number">Eff%</th>
      <th scope="col" class="number">Win%</th>
      <th scope="col" class="number">Perfect</th>
    </tr>
  </thead>
  <tbody>
${body}
${career}
  </tbody>
</table></div>
  </section>
  ${SITSTART_END}`
}

export function upsertOwnerPage(pagePath, sectionHtml) {
  let content = fs.readFileSync(pagePath, 'utf8')
  const startIdx = content.indexOf(SITSTART_START)
  const endIdx = content.indexOf(SITSTART_END)
  const hadSection = startIdx !== -1 && endIdx !== -1
  if (hadSection) {
    content = content.slice(0, startIdx) + content.slice(endIdx + SITSTART_END.length)
  }
  // Sit/start sits ahead of historical drafts on owner pages.
  const anchor = '<!-- DRAFT_HISTORY_START -->'
  const anchorIdx = content.indexOf(anchor)
  if (anchorIdx !== -1) {
    fs.writeFileSync(pagePath, content.slice(0, anchorIdx) + sectionHtml + '\n  ' + content.slice(anchorIdx))
    return hadSection ? 'moved' : 'inserted'
  }
  const mainClose = content.lastIndexOf('</main>')
  if (mainClose !== -1) {
    fs.writeFileSync(pagePath, content.slice(0, mainClose) + '  ' + sectionHtml + '\n  ' + content.slice(mainClose))
    return 'appended'
  }
  return 'skipped'
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  loadEnvFile()
  authHeaders()

  const args = process.argv.slice(2)
  const offline = args.includes('--offline')
  const seasonArg = args.find(a => /^\d{4}$/.test(a))
  const current = Number(seasonArg) || defaultSeason()

  const metaBySeason = {}
  const perSeason = {}
  const ownerSeasons = {} // owner -> { owner, page, seasons: { season: row } }
  const winPct = loadWinPct()

  for (let season = current; season >= API_FIRST_SEASON; season--) {
    let league
    try {
      league = await loadSchedule(season, offline)
    } catch (err) {
      console.warn(`Skipping ${season}: ${err.message}`)
      continue
    }
    metaBySeason[season] = seasonTeamMeta(league)
    const games = extractRegularSeasonGames(league, season)
    const weeks = [...new Set(games.map(g => g.week))].sort((a, b) => a - b)
    if (!weeks.length) {
      console.log(`Season ${season}: no decided regular-season games`)
      continue
    }
    const slotCounts = await loadSettings(season, offline).catch(err => {
      console.warn(`Season ${season}: settings fetch failed (${err.message}); using fallback counts.`)
      return null
    })
    const slots = starterSlotList(slotCounts)

    const ownerOf = makeOwnerLookup(metaBySeason)
    const nameOf = (s, teamId) => metaBySeason[s]?.[teamId]?.name ?? ''
    const weekRows = []
    for (const week of weeks) {
      let rosterLeague
      try {
        rosterLeague = await loadRoster(season, week, offline)
      } catch (err) {
        console.warn(`Season ${season} week ${week}: ${err.message}; skipping week.`)
        continue
      }
      const rosters = rosterWeek(rosterLeague, week)
      for (const [teamId, entries] of Object.entries(rosters)) {
        const tid = Number(teamId)
        const { actual, optimal, perfect } = scoreTeamWeek(entries, slots)
        weekRows.push({
          owner: ownerOf(tid),
          team: nameOf(season, tid) || metaBySeason[season]?.[tid]?.name || '',
          teamId: tid,
          week,
          actual,
          optimal,
          perfect,
        })
      }
    }
    const rows = aggregateSeason(weekRows)
    perSeason[season] = { season, weeks: weeks.length, rows }
    console.log(`Season ${season}: ${weeks.length} weeks, ${weekRows.length} team-weeks`)
    for (const r of rows) {
      const wl = winPct[r.owner]?.[season]
      r.wins = wl?.wins ?? null
      r.losses = wl?.losses ?? null
      r.winPct = wl?.winPct ?? null
      const page = Object.values(TEAM_OWNERS).find(m => m.owner === r.owner)?.page || null
      if (!ownerSeasons[r.owner]) ownerSeasons[r.owner] = { owner: r.owner, page, seasons: {} }
      ownerSeasons[r.owner].seasons[season] = { ...r }
    }
  }

  const seasonKeys = Object.keys(perSeason)
    .map(Number)
    .sort((a, b) => a - b)
  if (!seasonKeys.length) throw new Error('No seasons with decided games; nothing to write')

  let defaultYear = current
  if (!perSeason[defaultYear]) defaultYear = seasonKeys[seasonKeys.length - 1]

  const career = aggregateCareer(Object.fromEntries(seasonKeys.map(s => [s, perSeason[s].rows])))
  for (const c of career) {
    let w = 0
    let l = 0
    for (const s of seasonKeys) {
      const wl = winPct[c.owner]?.[s]
      if (!wl) continue
      w += wl.wins
      l += wl.losses
    }
    c.wins = w + l ? w : null
    c.losses = w + l ? l : null
    c.winPct = w + l ? Math.round((w / (w + l)) * 1000) / 1000 : null
  }
  const careerByOwner = Object.fromEntries(career.map(r => [r.owner, r]))

  const data = {
    generated: new Date().toISOString().slice(0, 10),
    leagueId: LEAGUE_ID,
    seasons: seasonKeys,
    defaultSeason: defaultYear,
    scopeNote:
      'Regular-season decided weeks only, 2018 on. Actual = points from the started lineup; optimal = best legal lineup from the same weekly roster. Efficiency = actual / optimal.',
    perSeason,
    owners: ownerSeasons,
    career,
  }

  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true })
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n')
  console.log(`Wrote ${DATA_PATH}`)

  upsertPage(renderPageContent(data))

  for (const [owner, entry] of Object.entries(ownerSeasons)) {
    if (!entry.page) continue
    const pagePath = path.join(SRC_DIR, entry.page)
    if (!fs.existsSync(pagePath)) continue
    const ownerRows = seasonKeys.filter(s => entry.seasons[s]).map(s => ({ season: s, ...entry.seasons[s] }))
    const status = upsertOwnerPage(pagePath, renderOwnerSection(ownerRows, careerByOwner[owner]))
    console.log(`${entry.page}: sit/start section ${status}`)
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch(err => {
    console.error(err.message)
    process.exit(1)
  })
}
