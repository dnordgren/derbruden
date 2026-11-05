// Shared ESPN API plumbing. Every generator used to carry its own copy of
// this: env-file parsing, cookie auth, league URL building, fetch with
// ESPN-flavored errors, and the Aug-Jul season convention. One copy lives
// here now.
import fs from 'node:fs'

export const LEAGUE_ID_DEFAULT = '794521'
export const API_BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl'
export const DEFAULT_LEAGUE_HOST = 'https://lm-api-reads.fantasy.espn.com'
export const LEAGUE_PATH = '/apis/v3/games/ffl/seasons/{year}/segments/0/leagues/{league}'

// Parse a .env-style file into an object. No side effects; missing file -> {}.
// Handles comments, blank lines, and single/double-quoted values.
export function loadEnvFile(file) {
  if (!file || !fs.existsSync(file)) return {}
  const out = {}
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

// Merge a .env-style file into process.env without overwriting real
// environment variables. For scripts that historically read scripts/.env.
export function applyEnvFile(file) {
  for (const [key, value] of Object.entries(loadEnvFile(file))) {
    if (process.env[key] == null) process.env[key] = value
  }
}

// Real environment variables win over the .env file; blank env vars fall
// back to the file instead of shadowing it.
export function resolveConfig(envFile, keys) {
  const fromFile = loadEnvFile(envFile)
  const env = {}
  for (const key of keys) {
    const value = process.env[key] || fromFile[key]
    env[key] = value === '' ? undefined : value
  }
  return env
}

// Cookie header value for the ESPN reads host. The league is private and
// the reads host needs BOTH espn_s2 and SWID from one login session.
export function authCookie(env) {
  const parts = []
  if (env.ESPN_S2) parts.push(`espn_s2=${env.ESPN_S2}`)
  if (env.SWID) parts.push(`SWID=${env.SWID}`)
  return parts.join('; ')
}

// Full headers for ESPN calls, thrown from private-league scripts when the
// cookie is missing. Reads directly off an env-like object so both
// process.env and resolveConfig() output work.
export function espnAuthHeaders(env, userAgent) {
  if (!env.ESPN_S2) {
    throw new Error('This league is private. Set ESPN_S2 in scripts/.env or your environment.')
  }
  return { Cookie: authCookie(env), 'User-Agent': userAgent }
}

export function leagueUrl(env) {
  return (
    (env.LEAGUE_HOST ?? DEFAULT_LEAGUE_HOST) +
    LEAGUE_PATH.replace('{year}', env.LEAGUE_YEAR).replace('{league}', env.LEAGUE_ID)
  )
}

export function seasonLeagueUrl(season, leagueId = process.env.FANTASY_LEAGUE_ID || LEAGUE_ID_DEFAULT) {
  return `${API_BASE}/seasons/${season}/segments/0/leagues/${leagueId}`
}

// fetch with ESPN-flavored errors: the reads host returns non-JSON (or a
// 302 body) when cookies are expired, so surface that instead of a parse
// SyntaxError. fetchImpl is injectable for tests.
export async function fetchJson(fetchImpl, url, options = {}) {
  const res = await fetchImpl(url, options)
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(
      `ESPN returned non-JSON (HTTP ${res.status}). Cookies are likely expired ` +
        'or missing SWID. Copy espn_s2 and SWID together from one signed-in session.'
    )
  }
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status}: ${JSON.stringify(body).slice(0, 500)}`)
  return body
}

// One league document with the given ?view= set.
export async function fetchLeague({
  season,
  views,
  leagueId = process.env.FANTASY_LEAGUE_ID || LEAGUE_ID_DEFAULT,
  headers,
  fetchImpl = globalThis.fetch,
}) {
  const url = `${seasonLeagueUrl(season, leagueId)}?view=${views.join('&view=')}`
  return fetchJson(fetchImpl, url, { headers })
}

// The fantasy season runs August through early February: Aug-Dec maps to
// the current calendar year, Jan-Jul to the prior year.
export function defaultSeason(now = new Date()) {
  return now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1
}
