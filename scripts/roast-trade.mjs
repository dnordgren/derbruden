#!/usr/bin/env node
// Trade roast agent. Reads accepted trades the watcher just posted to
// Discord, researches them against ESPN league data and NFL news, then asks
// an LLM to roast whichever owner got fleeced. Posts the verdict as a second
// Discord message.
//
// Usage:
//   node scripts/roast-trade.mjs <posted-trades.json> [--dry-run]
// Config comes from the environment or a .env file at the repo root.
// See .env.example.

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

import { loadEnvFile, postDiscordMessage } from './watch-trades.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENV_FILE = path.join(ROOT, '.env')

const LEAGUE_PATH = '/apis/v3/games/ffl/seasons/{year}/segments/0/leagues/{league}'
const DEFAULT_LEAGUE_HOST = 'https://lm-api-reads.fantasy.espn.com'
const NFL_NEWS_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=25'
const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go'
const DEFAULT_MODEL = 'kimi-k3'
const DISCORD_LIMIT = 1990

const POSITIONS = {
  1: 'QB',
  2: 'RB',
  3: 'WR',
  4: 'TE',
  5: 'K',
  16: 'DST',
}

const CONFIG_KEYS = [
  'LEAGUE_ID',
  'LEAGUE_YEAR',
  'ESPN_S2',
  'SWID',
  'DISCORD_WEBHOOK_URL',
  'OPENCODE_GO_API_KEY',
  'ROAST_MODEL',
  'OPENCODE_GO_BASE_URL',
  'LEAGUE_HOST',
]

function authCookie(env) {
  const parts = []
  if (env.ESPN_S2) parts.push(`espn_s2=${env.ESPN_S2}`)
  if (env.SWID) parts.push(`SWID=${env.SWID}`)
  return parts.join('; ')
}

function resolveConfig() {
  const fromFile = loadEnvFile(ENV_FILE)
  const env = {}
  for (const key of CONFIG_KEYS) env[key] = process.env[key] ?? fromFile[key]
  return env
}

export function parseArgs(argv) {
  const args = { tradesFile: null, dryRun: false }
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true
    else if (!arg.startsWith('--') && args.tradesFile === null) args.tradesFile = arg
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!args.tradesFile) throw new Error('Usage: node scripts/roast-trade.mjs <posted-trades.json>')
  return args
}

export function summarizePlayer(entry) {
  const player = entry?.playerPoolEntry?.player
  if (!player) return null
  const pos = POSITIONS[player.defaultPositionId] ?? `POS${player.defaultPositionId}`
  const injured = player.injuryStatus && player.injuryStatus !== 'NORMAL' ? `, ${player.injuryStatus}` : ''
  let points = ''
  const stat = (player.stats ?? []).find(
    s => s.statSourceId === 1 && s.statSplitTypeId === 0 && Number.isFinite(Number(s.appliedTotal))
  )
  if (stat) points = `, ${Math.round(Number(stat.appliedTotal) * 10) / 10} pts`
  return `${player.fullName} (${pos}${injured}${points})`
}

function teamRankMap(teams) {
  const sorted = [...teams].sort((a, b) => {
    const aw = a.record?.overall?.wins ?? 0
    const bw = b.record?.overall?.wins ?? 0
    if (bw !== aw) return bw - aw
    const apf = a.record?.overall?.pointsFor ?? 0
    const bpf = b.record?.overall?.pointsFor ?? 0
    return bpf - apf
  })
  const ranks = new Map()
  sorted.forEach((t, i) => ranks.set(t.id, i + 1))
  return ranks
}

function recordLine(team) {
  const o = team?.record?.overall ?? {}
  const pf = Math.round(Number(o.pointsFor ?? 0) * 10) / 10
  return `${o.wins ?? 0}-${o.losses ?? 0}${o.ties ? `-${o.ties}` : ''}, ${pf} pts`
}

// Build the research packet for one trade: standings position, both rosters,
// news on the traded players. All data comes straight from the ESPN payload;
// nothing here is invented.
export function buildLeagueContext(leagueData, tradeRecord) {
  const teams = Array.isArray(leagueData?.teams) ? leagueData.teams : []
  const byId = new Map(teams.map(t => [t.id, t]))
  const ranks = teamRankMap(teams)

  const sides = tradeRecord.teams.map(side => {
    const team = byId.get(side.teamId)
    const roster = (team?.roster?.entries ?? []).map(summarizePlayer).filter(Boolean)
    const rank = ranks.get(side.teamId) ?? '?'
    const of = teams.length || '?'
    return {
      name: side.name,
      line: `${rank} of ${of} (${recordLine(team)})`,
      gives: side.gives,
      roster,
    }
  })

  // Traded players sit on their new team's roster now, so search every
  // roster for their names and collect recent fantasy news blurbs.
  const wanted = new Set(sides.flatMap(s => s.gives))
  const playerNews = []
  for (const team of teams) {
    for (const entry of team?.roster?.entries ?? []) {
      const player = entry?.playerPoolEntry?.player
      if (!player || !wanted.has(player.fullName)) continue
      const items = (player.news ?? [])
        .slice(0, 4)
        .map(n => ({ headline: n.headline ?? n.summary ?? '', date: n.date ?? null }))
        .filter(n => n.headline)
      if (items.length > 0) playerNews.push({ player: player.fullName, items })
      wanted.delete(player.fullName)
    }
  }

  return {
    week: leagueData?.scoringPeriodId ?? null,
    sides,
    playerNews,
  }
}

async function fetchJson(fetchImpl, url, options) {
  const res = await fetchImpl(url, options)
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`ESPN returned non-JSON (HTTP ${res.status}). Cookies are likely expired.`)
  }
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`)
  return body
}

async function fetchNflHeadlines(fetchImpl) {
  try {
    const body = await fetchJson(fetchImpl, NFL_NEWS_URL, {})
    return (body.articles ?? [])
      .slice(0, 25)
      .map(a => `- ${a.headline}${a.description ? `: ${a.description}` : ''}`)
      .filter(l => l.length > 4)
  } catch (e) {
    console.warn(`Could not load NFL headlines: ${e.message}`)
    return []
  }
}

export function buildRoastPrompt(context, headlines) {
  const system =
    'You are the Der Bruden Trade Oracle, an ancient and slightly bored authority on a ' +
    'fantasy football league. You receive one accepted trade with both rosters, standings, ' +
    'and real NFL news. Study all of it carefully, then deliver your verdict: ONE sentence ' +
    'of at most 35 words declaring which owner lost the trade hardest, named by their exact ' +
    'team name. Rules: never explain, never justify, never mention any player, statistic, ' +
    'or headline you were shown - the research is yours alone, the mystery is the point. Be ' +
    'blunt; contempt and insults are welcome. Vary your wording every time; never reuse a ' +
    'formula. No emojis, no markdown, no preamble. Output only the sentence.'

  const lines = [`TRADE UNDER REVIEW (week ${context.week ?? '?'})`]
  for (const side of context.sides) {
    lines.push(`${side.name} sends: ${side.gives.join(', ')}`)
  }
  lines.push('')
  lines.push('STANDINGS POSITION')
  for (const side of context.sides) lines.push(`${side.name}: ${side.line}`)
  lines.push('')
  lines.push('ROSTERS AFTER THE TRADE')
  for (const side of context.sides) {
    lines.push(`${side.name} (${side.line}):`)
    for (const p of side.roster) lines.push(`  ${p}`)
  }
  if (context.playerNews.length > 0) {
    lines.push('')
    lines.push('RECENT NEWS ON TRADED PLAYERS')
    for (const pn of context.playerNews) for (const item of pn.items) lines.push(`${pn.player}: ${item.headline}`)
  }
  if (headlines.length > 0) {
    lines.push('')
    lines.push('CURRENT NFL HEADLINES')
    lines.push(...headlines.slice(0, 20))
  }

  return { system, user: lines.join('\n') }
}

export function extractRoast(body) {
  const content = body?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.trim() === '') throw new Error('LLM returned no content')
  return content.trim().replace(/^["']|["']$/g, '')
}

async function callLlmOnce(fetchImpl, env, prompt) {
  const base = (env.OPENCODE_GO_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const res = await fetchImpl(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENCODE_GO_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.ROAST_MODEL ?? DEFAULT_MODEL,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      temperature: 1,
      max_tokens: 200,
    }),
    signal: AbortSignal.timeout(180000),
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`LLM returned non-JSON (HTTP ${res.status})`)
  }
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`)
  return extractRoast(body)
}

// Open models on the gateway can be slow; give each trade one retry.
async function callLlm(fetchImpl, env, prompt) {
  try {
    return await callLlmOnce(fetchImpl, env, prompt)
  } catch (e) {
    console.warn(`First oracle attempt failed (${e.message}); retrying once.`)
    await new Promise(r => setTimeout(r, 5000))
    return callLlmOnce(fetchImpl, env, prompt)
  }
}

export async function main(argv, fetchImpl = globalThis.fetch) {
  const args = parseArgs(argv)
  const env = resolveConfig()
  const required = ['LEAGUE_ID', 'LEAGUE_YEAR', 'ESPN_S2', 'SWID']
  for (const key of required) if (!env[key]) throw new Error(`Missing required config: ${key}`)
  if (!args.dryRun) {
    if (!env.OPENCODE_GO_API_KEY) throw new Error('Missing required config: OPENCODE_GO_API_KEY (or use --dry-run)')
    if (!env.DISCORD_WEBHOOK_URL) throw new Error('Missing required config: DISCORD_WEBHOOK_URL (or use --dry-run)')
  }

  const postedRecords = JSON.parse(fs.readFileSync(args.tradesFile, 'utf8'))
  if (!Array.isArray(postedRecords) || postedRecords.length === 0) {
    console.log('No posted trades to roast.')
    return 0
  }

  const url =
    (env.LEAGUE_HOST ?? DEFAULT_LEAGUE_HOST) +
    LEAGUE_PATH.replace('{year}', env.LEAGUE_YEAR).replace('{league}', env.LEAGUE_ID)
  const leagueData = await fetchJson(fetchImpl, `${url}?view=mTeam&view=mRoster`, {
    headers: { Cookie: authCookie(env) },
  })
  const headlines = await fetchNflHeadlines(fetchImpl)

  let failures = 0
  for (const record of postedRecords) {
    try {
      const context = buildLeagueContext(leagueData, record)
      const prompt = buildRoastPrompt(context, headlines)

      if (args.dryRun) {
        console.log(`[dry-run] roast for trade ${record.id}:`)
        console.log(prompt.user)
        continue
      }

      const roast = await callLlm(fetchImpl, env, prompt)
      await postDiscordMessage(fetchImpl, env.DISCORD_WEBHOOK_URL, {
        username: 'Der Bruden Trades',
        content: roast.slice(0, DISCORD_LIMIT),
      })
      console.log(`Posted roast for trade ${record.id}.`)
    } catch (e) {
      failures++
      console.error(`Roast failed for trade ${record.id}: ${e.message}`)
    }
  }

  return failures > 0 ? 1 : 0
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(e => {
      console.error(e.message)
      process.exit(1)
    })
}
