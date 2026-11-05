// Shared HTML/JSON file helpers. escapeHtml, ownerLink, marker-section
// upserts, and atomic JSON writes each existed in 3-8 copies across the
// generators; one copy lives here now.
import fs from 'node:fs'
import path from 'node:path'
import { TEAM_OWNERS } from '../team-owners.js'

// Drafts had the only copy that escaped quotes too; the others assumed
// strings and skipped `"`. This is the strictest of the former copies.
export function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function ownerLink(owner) {
  const mapped = Object.values(TEAM_OWNERS).find(m => m.owner === owner)
  return mapped ? `<a href="./${mapped.page}">${escapeHtml(owner)}</a>` : escapeHtml(owner)
}

// Crash-safe JSON write: temp file in the same directory, then rename.
export function writeJsonAtomic(file, data, indent = 2) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(data, null, indent) + '\n')
  fs.renameSync(tmp, file)
}

// Replace (or create) a <!-- MARKER_START -->...<!-- MARKER_END --> section
// in a page. Creates the page via renderFull when it does not exist yet;
// warns and leaves the page untouched when the markers are missing.
export function upsertSection({ pagePath, start, end, contentHtml, renderFull }) {
  const section = `${start}\n${contentHtml}\n${end}`
  if (!fs.existsSync(pagePath)) {
    fs.writeFileSync(pagePath, renderFull(contentHtml))
    console.log(`Created ${pagePath}`)
    return
  }
  const content = fs.readFileSync(pagePath, 'utf8')
  const startIdx = content.indexOf(start)
  const endIdx = content.indexOf(end)
  if (startIdx === -1 || endIdx === -1) {
    console.warn(`Markers missing in ${pagePath}; page left untouched`)
    return
  }
  fs.writeFileSync(pagePath, content.slice(0, startIdx) + section + content.slice(endIdx + end.length))
  console.log(`Updated ${pagePath}`)
}
