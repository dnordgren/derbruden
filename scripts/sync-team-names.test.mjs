import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import {
  bumpLogoVersion,
  fetchLogoBytes,
  logoFilename,
  optimizeLogo,
  syncTeams,
  updatePageHeading,
  validateLogoUrl,
} from './sync-team-names.js'

function makeOwnerHtml(owner, teamName, version = 1) {
  const slug = owner.toLowerCase()
  const ver = version == null ? '' : `?v=${version}`
  return `<!DOCTYPE html>
<html>
<body>
  <main id="main">
    <div class="owner-logo-header">
      <img src="../static/img/owner-${slug}-logo.webp${ver}" alt="${owner} Logo" class="owner-logo-image" width="100" height="100">
      <h1>${owner} - ${teamName}</h1>
    </div>
  </main>
</body>
</html>
`
}

async function makePng(width, height, color = { r: 20, g: 104, b: 60, alpha: 1 }) {
  return sharp({ create: { width, height, channels: 4, background: color } })
    .png()
    .toBuffer()
}

function makeSvg(size, fill = '#14683c') {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
      `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 2}" fill="${fill}"/>` +
      `</svg>`
  )
}

function makeWorkspace(pages) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'derbruden-sync-logos-'))
  const srcDir = path.join(root, 'src')
  const imgDir = path.join(root, 'static', 'img')
  const stateFile = path.join(root, 'owner-logos-state.json')
  fs.mkdirSync(srcDir, { recursive: true })
  fs.mkdirSync(imgDir, { recursive: true })
  for (const [name, content] of Object.entries(pages)) {
    fs.writeFileSync(path.join(srcDir, name), content)
  }
  return { root, srcDir, imgDir, stateFile, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test('validateLogoUrl accepts http(s) and protocol-relative URLs and rejects unsafe schemes', () => {
  assert.equal(validateLogoUrl('https://g.espncdn.com/logo.svg'), 'https://g.espncdn.com/logo.svg')
  assert.equal(validateLogoUrl('  http://example.com/a.png  '), 'http://example.com/a.png')
  assert.equal(validateLogoUrl('//g.espncdn.com/logo.png'), 'https://g.espncdn.com/logo.png')
  assert.equal(validateLogoUrl(''), null)
  assert.equal(validateLogoUrl(null), null)
  assert.equal(validateLogoUrl('data:image/png;base64,AAAA'), null)
  assert.equal(validateLogoUrl('file:///etc/passwd'), null)
  assert.equal(validateLogoUrl('not a url'), null)
})

test('bumpLogoVersion increments existing ?v=N and initializes unversioned references', () => {
  const html1 = makeOwnerHtml('DN', 'Team', 1)
  const r1 = bumpLogoVersion(html1, 'DN')
  assert.equal(r1.found, true)
  assert.equal(r1.changed, true)
  assert.equal(r1.version, 2)
  assert.match(r1.updated, /owner-dn-logo\.webp\?v=2/)

  const r2 = bumpLogoVersion(r1.updated, 'DN')
  assert.equal(r2.version, 3)
  assert.match(r2.updated, /owner-dn-logo\.webp\?v=3/)

  const unversioned = makeOwnerHtml('DN', 'Team', null)
  const r3 = bumpLogoVersion(unversioned, 'DN')
  assert.equal(r3.found, true)
  assert.equal(r3.version, 2)
  assert.match(r3.updated, /owner-dn-logo\.webp\?v=2/)

  const wrongOwner = bumpLogoVersion(html1, 'JO')
  assert.equal(wrongOwner.found, false)
  assert.equal(wrongOwner.changed, false)
})

test('updatePageHeading updates heading with escaped HTML and detects no-op', () => {
  const html = makeOwnerHtml('DN', 'Old Name', 1)
  const r1 = updatePageHeading(html, 'DN', 'Tom & Jerry <2>')
  assert.equal(r1.found, true)
  assert.equal(r1.changed, true)
  assert.match(r1.updated, /<h1>DN - Tom &amp; Jerry &lt;2&gt;<\/h1>/)

  const r2 = updatePageHeading(r1.updated, 'DN', 'Tom & Jerry <2>')
  assert.equal(r2.found, true)
  assert.equal(r2.changed, false)
})

test('optimizeLogo produces 200x200 WebP for large rasters and SVGs without enlarging tiny rasters', async () => {
  const bigPng = await makePng(600, 400)
  const bigOut = await optimizeLogo(bigPng)
  const bigMeta = await sharp(bigOut).metadata()
  assert.equal(bigMeta.format, 'webp')
  assert.equal(bigMeta.width, 200)
  assert.equal(bigMeta.height, 200)

  const smallPng = await makePng(120, 80)
  const smallOut = await optimizeLogo(smallPng)
  const smallMeta = await sharp(smallOut).metadata()
  assert.equal(smallMeta.format, 'webp')
  assert.equal(smallMeta.width, 120)
  assert.equal(smallMeta.height, 80)

  const smallSvg = makeSvg(64)
  const svgOut = await optimizeLogo(smallSvg)
  const svgMeta = await sharp(svgOut).metadata()
  assert.equal(svgMeta.format, 'webp')
  assert.equal(svgMeta.width, 200)
  assert.equal(svgMeta.height, 200)

  await assert.rejects(() => optimizeLogo(Buffer.from('<html>not an image</html>')))
})

test('fetchLogoBytes never sends Cookie header and rejects bad status, HTML, or oversized bodies', async () => {
  const png = await makePng(64, 64)
  let seenHeaders = null
  const okFetch = async (url, opts) => {
    seenHeaders = opts.headers
    return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })
  }
  const bytes = await fetchLogoBytes('https://example.com/pic.png', { fetchImpl: okFetch })
  assert.equal(bytes.equals(png), true)
  assert.equal('Cookie' in seenHeaders, false)
  assert.equal('cookie' in seenHeaders, false)

  await assert.rejects(
    () =>
      fetchLogoBytes('https://example.com/missing.png', {
        fetchImpl: async () => new Response('nope', { status: 404 }),
      }),
    /HTTP 404/
  )

  await assert.rejects(
    () =>
      fetchLogoBytes('https://example.com/page', {
        fetchImpl: async () =>
          new Response('<html>hi</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      }),
    /Unexpected content-type/
  )

  await assert.rejects(
    () =>
      fetchLogoBytes('https://example.com/huge.png', {
        fetchImpl: async () =>
          new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'content-length': '99999999' } }),
        maxBytes: 1024,
      }),
    /exceeds size limit/
  )
})

test('syncTeams downloads, optimizes, versions logos and stays idempotent on repeat runs', async () => {
  const ws = makeWorkspace({ 'dn.html': makeOwnerHtml('DN', 'Old Name', 1) })
  try {
    const img1 = await makePng(400, 400, { r: 20, g: 104, b: 60, alpha: 1 })
    const img2 = await makePng(400, 400, { r: 161, g: 98, b: 7, alpha: 1 })
    let currentBytes = img1
    let optimizeCalls = 0
    const fetchImpl = async () => new Response(currentBytes, { status: 200, headers: { 'content-type': 'image/png' } })
    const trackedOptimize = async buf => {
      optimizeCalls += 1
      return optimizeLogo(buf)
    }

    const league = {
      seasonId: 2026,
      teams: [{ id: 8, abbrev: 'DN', name: 'New Name', logo: 'https://cdn.example.com/dn.png' }],
    }

    // 1. Initial sync updates name, writes optimized WebP, bumps ?v=1 -> ?v=2, writes state.
    const r1 = await syncTeams({
      league,
      srcDir: ws.srcDir,
      imgDir: ws.imgDir,
      stateFile: ws.stateFile,
      fetchImpl,
      optimizeImpl: trackedOptimize,
    })
    assert.equal(r1.namesChanged, 1)
    assert.equal(r1.logosChanged, 1)
    assert.equal(r1.logoErrors, 0)
    assert.equal(optimizeCalls, 1)

    const logoPath = path.join(ws.imgDir, logoFilename('DN'))
    assert.equal(fs.existsSync(logoPath), true)
    const meta1 = await sharp(fs.readFileSync(logoPath)).metadata()
    assert.equal(meta1.format, 'webp')
    assert.equal(meta1.width, 200)
    assert.equal(meta1.height, 200)

    const html1 = fs.readFileSync(path.join(ws.srcDir, 'dn.html'), 'utf8')
    assert.match(html1, /<h1>DN - New Name<\/h1>/)
    assert.match(html1, /owner-dn-logo\.webp\?v=2/)

    // 2. Repeat run with identical source bytes short-circuits without re-optimizing or bumping ?v=.
    const r2 = await syncTeams({
      league,
      srcDir: ws.srcDir,
      imgDir: ws.imgDir,
      stateFile: ws.stateFile,
      fetchImpl,
      optimizeImpl: trackedOptimize,
    })
    assert.equal(r2.namesChanged, 0)
    assert.equal(r2.logosChanged, 0)
    assert.equal(r2.stateChanged, false)
    assert.equal(optimizeCalls, 1)
    assert.match(fs.readFileSync(path.join(ws.srcDir, 'dn.html'), 'utf8'), /owner-dn-logo\.webp\?v=2/)

    // 3. New image bytes at the same URL trigger re-optimization and bump ?v=2 -> ?v=3.
    currentBytes = img2
    const r3 = await syncTeams({
      league,
      srcDir: ws.srcDir,
      imgDir: ws.imgDir,
      stateFile: ws.stateFile,
      fetchImpl,
      optimizeImpl: trackedOptimize,
    })
    assert.equal(r3.namesChanged, 0)
    assert.equal(r3.logosChanged, 1)
    assert.equal(optimizeCalls, 2)
    assert.match(fs.readFileSync(path.join(ws.srcDir, 'dn.html'), 'utf8'), /owner-dn-logo\.webp\?v=3/)

    // 4. Switching URL to a byte-identical image updates state without bumping ?v=3.
    const leagueMovedUrl = {
      seasonId: 2026,
      teams: [{ id: 8, abbrev: 'DN', name: 'New Name', logo: 'https://cdn.example.com/dn-renamed.png' }],
    }
    const r4 = await syncTeams({
      league: leagueMovedUrl,
      srcDir: ws.srcDir,
      imgDir: ws.imgDir,
      stateFile: ws.stateFile,
      fetchImpl,
      optimizeImpl: trackedOptimize,
    })
    assert.equal(r4.logosChanged, 0)
    assert.equal(r4.stateChanged, true)
    assert.match(fs.readFileSync(path.join(ws.srcDir, 'dn.html'), 'utf8'), /owner-dn-logo\.webp\?v=3/)
    const savedState = JSON.parse(fs.readFileSync(ws.stateFile, 'utf8'))
    assert.equal(savedState.DN.url, 'https://cdn.example.com/dn-renamed.png')
  } finally {
    ws.cleanup()
  }
})

test('syncTeams --dry-run writes nothing to disk', async () => {
  const ws = makeWorkspace({ 'dn.html': makeOwnerHtml('DN', 'Old Name', 1) })
  try {
    const svg = makeSvg(128)
    const fetchImpl = async () => new Response(svg, { status: 200, headers: { 'content-type': 'image/svg+xml' } })
    const league = {
      seasonId: 2026,
      teams: [{ id: 8, abbrev: 'DN', name: 'New Name', logo: 'https://g.espncdn.com/pack/logo.svg' }],
    }

    const res = await syncTeams({
      league,
      srcDir: ws.srcDir,
      imgDir: ws.imgDir,
      stateFile: ws.stateFile,
      dryRun: true,
      fetchImpl,
    })
    assert.equal(res.namesChanged, 1)
    assert.equal(res.logosChanged, 1)
    assert.equal(fs.existsSync(path.join(ws.imgDir, logoFilename('DN'))), false)
    assert.equal(fs.existsSync(ws.stateFile), false)
    assert.match(fs.readFileSync(path.join(ws.srcDir, 'dn.html'), 'utf8'), /owner-dn-logo\.webp\?v=1/)
    assert.match(fs.readFileSync(path.join(ws.srcDir, 'dn.html'), 'utf8'), /<h1>DN - Old Name<\/h1>/)
  } finally {
    ws.cleanup()
  }
})

test('syncTeams keeps existing logo on fetch/decode errors and continues syncing other owners', async () => {
  const ws = makeWorkspace({
    'dn.html': makeOwnerHtml('DN', 'DN Team', 1),
    'jo.html': makeOwnerHtml('JO', 'JO Old', 1),
  })
  try {
    const existingDn = Buffer.from('existing-dn-webp-bytes')
    const dnLogoPath = path.join(ws.imgDir, logoFilename('DN'))
    fs.writeFileSync(dnLogoPath, existingDn)

    const joSvg = makeSvg(100, '#a16207')
    const fetchImpl = async url => {
      if (url.includes('broken')) return new Response('not found', { status: 404 })
      return new Response(joSvg, { status: 200, headers: { 'content-type': 'image/svg+xml' } })
    }

    const league = {
      seasonId: 2026,
      teams: [
        { id: 8, abbrev: 'DN', name: 'DN Updated', logo: 'https://broken.example.com/404.png' },
        { id: 9, abbrev: 'JO', name: 'JO Updated', logo: 'https://g.espncdn.com/pack/jo.svg' },
      ],
    }

    const res = await syncTeams({
      league,
      srcDir: ws.srcDir,
      imgDir: ws.imgDir,
      stateFile: ws.stateFile,
      fetchImpl,
    })

    assert.equal(res.namesChanged, 2)
    assert.equal(res.logosChanged, 1)
    assert.equal(res.logoErrors, 1)

    // DN's name updated, existing logo untouched, ?v=1 not bumped.
    assert.equal(fs.readFileSync(dnLogoPath).equals(existingDn), true)
    const dnHtml = fs.readFileSync(path.join(ws.srcDir, 'dn.html'), 'utf8')
    assert.match(dnHtml, /<h1>DN - DN Updated<\/h1>/)
    assert.match(dnHtml, /owner-dn-logo\.webp\?v=1/)

    // JO's name and SVG logo both synced cleanly.
    const joHtml = fs.readFileSync(path.join(ws.srcDir, 'jo.html'), 'utf8')
    assert.match(joHtml, /<h1>JO - JO Updated<\/h1>/)
    assert.match(joHtml, /owner-jo-logo\.webp\?v=2/)
    assert.equal(fs.existsSync(path.join(ws.imgDir, logoFilename('JO'))), true)
  } finally {
    ws.cleanup()
  }
})
