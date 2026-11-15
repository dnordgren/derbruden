import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(__dirname, '../src')
const OUT_DIR = path.join(__dirname, '../pub')

const INCLUDE_RE = /<!--#include\s+([\s\S]*?)-->/g
const ATTR_RE = /([a-zA-Z-]+)="([^"]*)"/g
const VAR_RE = /\{\{(\w+)\}\}/g

export function resolveIncludes(html, stack = [], baseDir = SRC_DIR) {
  return html.replace(INCLUDE_RE, (_, attrSource) => {
    const attrs = Object.fromEntries([...attrSource.matchAll(ATTR_RE)].map(m => [m[1], m[2]]))
    const file = attrs.file
    if (!file) throw new Error(`Include without file attribute: ${attrSource.trim().slice(0, 80)}`)

    const resolved = path.resolve(baseDir, file)
    if (!fs.existsSync(resolved)) throw new Error(`Include not found: ${file}`)
    if (stack.includes(resolved)) {
      throw new Error(`Circular include: ${[...stack, resolved].map(p => path.relative(SRC_DIR, p)).join(' -> ')}`)
    }

    let partial = fs.readFileSync(resolved, 'utf8')
    partial = partial.replace(VAR_RE, (raw, key) => (key in attrs ? attrs[key] : raw))
    return resolveIncludes(partial, [...stack, resolved], baseDir)
  })
}

export function buildPage(html, name) {
  const out = resolveIncludes(html)
  if (INCLUDE_RE.test(out)) throw new Error(`${name}: unresolved include remains`)
  INCLUDE_RE.lastIndex = 0
  return out
}

// All .html pages under src/, recursively (e.g. votes/relegation.html),
// excluding the partials directory, as paths relative to src/.
export function listPages(srcDir = SRC_DIR) {
  const pages = []
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === 'partials') continue
        walk(path.join(dir, entry.name), path.join(rel, entry.name))
      } else if (entry.name.endsWith('.html')) {
        pages.push(path.join(rel, entry.name))
      }
    }
  }
  walk(srcDir, '')
  return pages.sort()
}

function build() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const pages = listPages()
  for (const page of pages) {
    const html = fs.readFileSync(path.join(SRC_DIR, page), 'utf8')
    const outPath = path.join(OUT_DIR, page)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, buildPage(html, page))
    console.log(`built ${page}`)
  }
  console.log(`Built ${pages.length} pages into pub/`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  build()
}
