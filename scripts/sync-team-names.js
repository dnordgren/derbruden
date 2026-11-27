import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { TEAM_OWNERS } from './team-owners.js'
import { applyEnvFile, defaultSeason, espnAuthHeaders, fetchLeague } from './lib/espn.mjs'
import { escapeHtml, writeJsonAtomic } from './lib/html.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const USER_AGENT = 'derbruden.com team name sync'
const SRC_DIR = path.join(__dirname, '../src')
const IMG_DIR = path.join(__dirname, '../static/img')
const STATE_FILE = path.join(__dirname, 'owner-logos-state.json')

export const LOGO_SIZE = 200
export const LOGO_QUALITY = 80
export const MAX_LOGO_BYTES = 10 * 1024 * 1024
export const LOGO_FETCH_TIMEOUT_MS = 15_000

const NON_IMAGE_CONTENT_TYPES = ['text/html', 'text/plain', 'application/json', 'application/xml']

function authHeaders() {
  return espnAuthHeaders(process.env, USER_AGENT)
}

async function fetchSeason(season) {
  return fetchLeague({ season, views: ['mTeam'], headers: authHeaders() })
}

export function logoFilename(owner) {
  return `owner-${owner.toLowerCase()}-logo.webp`
}

export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

export function updatePageHeading(content, owner, name) {
  const headerRegex = /(<div class="owner-logo-header">[\s\S]*?<h1>)[^<]*(<\/h1>)/
  if (!headerRegex.test(content)) return { found: false, changed: false, updated: content, heading: null }

  const heading = `${owner} - ${escapeHtml(name)}`
  const updated = content.replace(headerRegex, (match, prefix, suffix) => `${prefix}${heading}${suffix}`)
  return { found: true, changed: updated !== content, updated, heading }
}

export function bumpLogoVersion(content, owner) {
  const filename = logoFilename(owner).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(static/img/${filename})(?:\\?v=(\\d+))?`, 'g')
  let found = false
  let nextVersion = null
  const updated = content.replace(re, (match, base, ver) => {
    found = true
    nextVersion = ver ? Number(ver) + 1 : 2
    return `${base}?v=${nextVersion}`
  })
  return { found, changed: found && updated !== content, updated, version: nextVersion }
}

export function validateLogoUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null
  let trimmed = rawUrl.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('//')) trimmed = `https:${trimmed}`
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return parsed.href
}

// Fetch raw logo bytes without sending ESPN auth cookies — team.logo can
// point to an arbitrary third-party image host.
export async function fetchLogoBytes(
  logoUrl,
  { fetchImpl = globalThis.fetch, timeoutMs = LOGO_FETCH_TIMEOUT_MS, maxBytes = MAX_LOGO_BYTES } = {}
) {
  const res = await fetchImpl(logoUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'image/*,*/*;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${logoUrl}`)
  }

  const contentType = (res.headers?.get?.('content-type') || '').toLowerCase().split(';')[0].trim()
  if (contentType && NON_IMAGE_CONTENT_TYPES.includes(contentType)) {
    throw new Error(`Unexpected content-type ${contentType} from ${logoUrl}`)
  }

  const contentLength = Number(res.headers?.get?.('content-length') || 0)
  if (contentLength > maxBytes) {
    throw new Error(`Logo exceeds size limit (${contentLength} > ${maxBytes} bytes)`)
  }

  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length === 0) {
    throw new Error(`Empty response body from ${logoUrl}`)
  }
  if (buffer.length > maxBytes) {
    throw new Error(`Logo exceeds size limit (${buffer.length} > ${maxBytes} bytes)`)
  }
  return buffer
}

// Normalize any supported image (SVG vector pack or raster PNG/JPEG/GIF/WebP)
// into a 200px WebP (2x retina for the 100x100 circular avatar).
export async function optimizeLogo(inputBuffer, { size = LOGO_SIZE, quality = LOGO_QUALITY } = {}) {
  const meta = await sharp(inputBuffer).metadata()
  if (meta.format === 'svg') {
    const minDim = Math.min(meta.width || size, meta.height || size)
    const density = minDim < size ? Math.min(1200, Math.ceil((size / Math.max(1, minDim)) * 72 * 2)) : 72
    return sharp(inputBuffer, { density })
      .resize(size, size, { fit: 'cover', position: 'centre' })
      .webp({ quality, effort: 6 })
      .toBuffer()
  }

  return sharp(inputBuffer)
    .rotate()
    .resize(size, size, { fit: 'cover', position: 'centre', withoutEnlargement: true })
    .webp({ quality, effort: 6 })
    .toBuffer()
}

export function loadLogoState(stateFile = STATE_FILE) {
  if (!fs.existsSync(stateFile)) return {}
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'))
}

function writeBufferAtomic(filePath, buffer) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`)
  fs.writeFileSync(tmp, buffer)
  fs.renameSync(tmp, filePath)
}

export function syncPage(owner, page, name, { srcDir = SRC_DIR, dryRun = false } = {}) {
  const filePath = path.join(srcDir, page)
  if (!fs.existsSync(filePath)) {
    console.warn(`File not found: ${filePath}`)
    return false
  }

  const content = fs.readFileSync(filePath, 'utf8')
  const { found, changed, updated, heading } = updatePageHeading(content, owner, name)
  if (!found) {
    console.warn(`Could not find owner header in ${page}`)
    return false
  }
  if (!changed) return false

  if (!dryRun) fs.writeFileSync(filePath, updated)
  console.log(`${owner}: ${heading}`)
  return true
}

export async function syncOwnerLogo({
  owner,
  page,
  logoUrl,
  state = {},
  srcDir = SRC_DIR,
  imgDir = IMG_DIR,
  dryRun = false,
  fetchImpl = globalThis.fetch,
  optimizeImpl = optimizeLogo,
}) {
  if (!logoUrl || !String(logoUrl).trim()) {
    return { status: 'skipped', reason: 'no logo url' }
  }

  const validUrl = validateLogoUrl(logoUrl)
  if (!validUrl) {
    console.warn(`${owner}: skipping invalid logo URL (${logoUrl})`)
    return { status: 'error', reason: 'invalid logo url' }
  }

  let rawBytes
  try {
    rawBytes = await fetchLogoBytes(validUrl, { fetchImpl })
  } catch (err) {
    console.warn(`${owner}: failed to fetch logo (${err.message}); keeping existing image`)
    return { status: 'error', reason: err.message }
  }

  const sourceSha256 = sha256Hex(rawBytes)
  const filename = logoFilename(owner)
  const logoPath = path.join(imgDir, filename)
  const prev = state[owner]

  if (prev && prev.url === validUrl && prev.sha256 === sourceSha256 && fs.existsSync(logoPath)) {
    return { status: 'unchanged' }
  }

  let optimizedBytes
  try {
    optimizedBytes = await optimizeImpl(rawBytes)
  } catch (err) {
    console.warn(`${owner}: failed to optimize logo from ${validUrl} (${err.message}); keeping existing image`)
    return { status: 'error', reason: err.message }
  }

  const stateEntry = { url: validUrl, sha256: sourceSha256 }

  if (fs.existsSync(logoPath) && fs.readFileSync(logoPath).equals(optimizedBytes)) {
    return { status: 'state-updated', stateEntry }
  }

  const pagePath = path.join(srcDir, page)
  if (!fs.existsSync(pagePath)) {
    console.warn(`${owner}: page not found (${pagePath}); skipping logo update`)
    return { status: 'error', reason: 'page not found' }
  }

  const pageContent = fs.readFileSync(pagePath, 'utf8')
  const bumped = bumpLogoVersion(pageContent, owner)
  if (!bumped.found) {
    console.warn(`${owner}: could not find ${filename} reference in ${page}; skipping logo update`)
    return { status: 'error', reason: 'logo reference missing' }
  }

  if (!dryRun) {
    writeBufferAtomic(logoPath, optimizedBytes)
    fs.writeFileSync(pagePath, bumped.updated)
  }

  const kb = (optimizedBytes.length / 1024).toFixed(1)
  console.log(`${owner}: logo -> ${filename}?v=${bumped.version} (${kb} KB)`)
  return { status: 'updated', bytes: optimizedBytes.length, version: bumped.version, stateEntry }
}

export async function syncTeams({
  league,
  srcDir = SRC_DIR,
  imgDir = IMG_DIR,
  stateFile = STATE_FILE,
  dryRun = false,
  fetchImpl = globalThis.fetch,
  optimizeImpl = optimizeLogo,
  teamOwners = TEAM_OWNERS,
}) {
  const state = loadLogoState(stateFile)
  let synced = 0
  let namesChanged = 0
  let logosChanged = 0
  let logoErrors = 0
  let stateChanged = false

  for (const team of league.teams) {
    const mapped = teamOwners[team.id]
    const name = (team.name || team.nickname || team.abbrev).trim()
    if (!mapped) {
      console.warn(`Unmapped ESPN team id ${team.id} (${team.abbrev}). Check TEAM_OWNERS after the draft.`)
      continue
    }
    synced += 1
    if (syncPage(mapped.owner, mapped.page, name, { srcDir, dryRun })) {
      namesChanged += 1
    }

    const logoRes = await syncOwnerLogo({
      owner: mapped.owner,
      page: mapped.page,
      logoUrl: team.logo,
      state,
      srcDir,
      imgDir,
      dryRun,
      fetchImpl,
      optimizeImpl,
    })

    if (logoRes.status === 'updated') {
      logosChanged += 1
      state[mapped.owner] = logoRes.stateEntry
      stateChanged = true
    } else if (logoRes.status === 'state-updated') {
      state[mapped.owner] = logoRes.stateEntry
      stateChanged = true
    } else if (logoRes.status === 'error') {
      logoErrors += 1
    }
  }

  if (stateChanged && !dryRun) {
    const sortedState = Object.fromEntries(Object.entries(state).sort(([a], [b]) => a.localeCompare(b)))
    writeJsonAtomic(stateFile, sortedState)
  }

  console.log(
    `Synced ${synced} owner pages from season ${league.seasonId}. ` +
      `${namesChanged} ${namesChanged === 1 ? 'name' : 'names'} changed, ` +
      `${logosChanged} ${logosChanged === 1 ? 'logo' : 'logos'} changed` +
      `${logoErrors ? `, ${logoErrors} logo ${logoErrors === 1 ? 'warning' : 'warnings'}` : ''}` +
      `${dryRun ? ' (dry run)' : ''}.`
  )

  return { synced, namesChanged, logosChanged, logoErrors, stateChanged }
}

async function main(argv = process.argv.slice(2)) {
  applyEnvFile(path.join(__dirname, '.env'))
  authHeaders()
  const dryRun = argv.includes('--dry-run')

  const [seasonArg] = argv.filter(arg => /^\d{4}$/.test(arg))
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

  await syncTeams({ league, dryRun })
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(err => {
    console.error(err.message)
    process.exit(1)
  })
}
