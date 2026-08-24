# PERFORMANCE_FINDINGS.md

Audit of derbruden.com for web performance, layout, and styling issues.
Audit date: 2026-08-23. Repo state: `master` at time of writing.

## How to use this file

Each numbered finding is self-contained. "Fix finding N" should be
actionable with no other context. Each finding lists affected files with
line numbers, evidence, a step-by-step fix plan, and verification steps.

## Constraints every fix must respect

- Do not break `scripts/generate-stats.js`. It rewrites the first
  `<div class="table-container">...</div>` block in each owner page via
  regex (scripts/generate-stats.js:167). Keep that wrapper element and its
  inner `<table class="stats-table">` structure intact.
- Do not reformat legacy HTML pages wholesale. They fail prettier today;
  per AGENTS.md that is accepted. Only touch the lines a finding requires.
  Run `npx prettier --check <file>` on files you create (new CSS/JS files).
- Static assets deploy with `Cache-Control: max-age=31536000, immutable`
  (Makefile:40). After changing any file under `static/`, a CloudFront
  invalidation is required (`make invalidate-cache`). See finding 10 for
  why browser caches stay stale anyway.
- Deploy is `AWS_PROFILE=derbruden make deploy`. Never commit cookies or
  AWS keys.
- Commit style: `perf:` / `fix:` / `chore:` prefixes, imperative mood.

## Summary

| # | Severity | Area | Finding |
|---|----------|------|---------|
| 1 | Critical | Images | Sponsor image is 1400x1400, 1.15 MB, rendered at ~100 px on all 14 pages |
| 2 | High | Core Web Vitals | LCP image lazy-loaded on index.html |
| 3 | High | Images | Content images oversized (up to 2824 px wide, 300-412 KB) |
| 4 | High | CLS | Most `<img>` tags lack intrinsic width/height attributes |
| 5 | Medium | Fonts | Google Fonts loads full variable range, roman + italic, render-blocking |
| 6 | Medium | JS | dn.html loads D3 v7 render-blocking from d3js.org; chart code has runtime bug |
| 7 | Low | Assets | Unused 890 KB image deployed to S3 |
| 8 | Medium | CSS | ~150-line identical inline CSS block duplicated across 14 pages |
| 9 | Low | JS | Prefetch script fetches all visible links immediately on load |
| 10 | Medium | Caching | Immutable caching with unversioned asset names; wildcard invalidation; icon type mismatches |
| 11 | Low | Deploy hygiene | Stub pages deployed live (leaders.html, minutes.html) |
| 12 | Low | Layout/styling | Header/nav inconsistencies between pages; dead CSS rules; wrong og:image metadata |
| 13 | Medium | Navigation | Header/nav visibly reflows on every cross-page navigation (MPA reload + unstable header geometry + font swap); no nav caching between pages |

---

## Finding 1 — Sponsor image is 1.15 MB rendered at ~100 px on every page

**Severity:** Critical. Single largest bandwidth waste on the site.
**Area:** Images.

### Evidence

- `static/img/about-sponsor.webp` is **1,175,852 bytes**, dimensions
  **1400x1400**.
- It renders inside `.sponsor-box img { max-width: 100px }`, so browsers
  decode 1400x1400 to draw a 100 px thumbnail.
- Referenced in the header of **all 14 real pages**: src/index.html:196,
  src/about.html:197, src/owners.html:232, src/power-rankings.html:193,
  and line 223 of each owner page (an, ar, cr, dm, dn, gm, ik, jh, jo,
  zs). Every page view downloads 1.15 MB for a logo thumbnail.

### Fix plan

1. Create a 200x200 version (200 px covers 2x DPR display density):
   ```sh
   dwebp static/img/about-sponsor.webp -o /tmp/opencode/sponsor.png
   cwebp -q 80 -resize 200 200 /tmp/opencode/sponsor.png -o /tmp/opencode/sponsor-200.webp
   ```
   If ImageMagick is available, `magick static/img/about-sponsor.webp -resize 200x200 -quality 80 /tmp/opencode/sponsor-200.webp` does it in one step.
2. Confirm output is under ~15 KB (`ls -l`). If larger, drop to `-q 70`.
3. Replace `static/img/about-sponsor.webp` with the resized file,
   keeping the same filename so no HTML edits are needed:
   ```sh
   cp /tmp/opencode/sponsor-200.webp static/img/about-sponsor.webp
   ```
4. While editing, add intrinsic dimensions to each sponsor `<img>` tag:
   change
   `<img src="../static/img/about-sponsor.webp" alt="Booze Better"></a>`
   to
   `<img src="../static/img/about-sponsor.webp" alt="Booze Better" width="200" height="200"></a>`
   in all 14 locations listed above. The CSS `max-width: 100px;
   height: auto` keeps the rendered size at 100 px; the attributes only
   reserve layout space before CSS applies.
5. Run `make invalidate-cache` (or note that the next `make deploy`
   invalidates) so the new bytes propagate.

### Verification

- `ls -la static/img/about-sponsor.webp` shows roughly 5-20 KB.
- Serve locally: `python3 -m http.server 8000 --directory .` then open
  `http://localhost:8000/src/index.html`. Sponsor logo renders correctly
  at 100 px in the header box; no distortion.
- DevTools Network tab: sponsor image transfer is now kilobytes, not megabytes.

---

## Finding 2 — LCP image lazy-loaded on index.html

**Severity:** High.
**Area:** Core Web Vitals (LCP).

### Evidence

src/index.html:225:

```html
<img src="../static/img/index-2025.webp" alt="2025 Championship"
  class="post-image" loading="lazy" style="max-height: 30rem;">
```

This is the first content image, positioned in the initial viewport on
desktop. `loading="lazy"` defers it until after layout, which delays LCP
by a full network round trip after the preload scanner would otherwise
have started the download.

### Fix plan

1. In src/index.html:225 remove `loading="lazy"` and add
   `fetchpriority="high"`:
   ```html
   <img src="../static/img/index-2025.webp" alt="2025 Championship"
     class="post-image" fetchpriority="high" style="max-height: 30rem;">
   ```
2. Add a preload hint in `<head>` (after the favicon links, before the
   fonts stylesheet):
   ```html
   <link rel="preload" as="image" href="../static/img/index-2025.webp"
     fetchpriority="high">
   ```
3. Leave `loading="lazy"` on the nine older championship images
   (index-2016 through index-2024). That is correct behavior for them.

### Verification

- Open the page locally with DevTools > Performance, throttle to Fast 3G,
  reload. LCP candidate should be `index-2025.webp` and start loading
  during HTML parse, not after layout.
- No console errors; page layout unchanged.

---

## Finding 3 — Content images oversized

**Severity:** High.
**Area:** Images / bandwidth.

### Evidence

The main column is capped at 1200 px (body `max-width: 1200px`), and post
images occupy the `2fr` column (~760 px wide desktop, full width below
768 px). Several sources are far larger than needed:

| File | Bytes | Dimensions | Rendered at |
|------|-------|------------|-------------|
| static/img/index-2019.webp | 412,188 | 2000x1708 | ≤760 px |
| static/img/index-2020.webp | 381,824 | 1933x2000 | ≤760 px |
| static/img/about-leadership.webp | 330,484 | 2816x1536 | ≤760 px |
| static/img/index-2023.webp | 315,904 | 2000x1500 | ≤760 px |
| static/img/index-2021.webp | 308,044 | 1500x2000 | ≤760 px |
| static/img/index-2025.webp | 304,340 | 2824x1570 | ≤760 px |
| static/img/about-excommunicado-ramrod.webp | 161,876 | 1792x2400 | ≤760 px |
| static/img/index-2024.webp | 125,916 | 1280x854 | ≤760 px |
| static/img/index-2016.webp | 72,646 | 1125x1058 | ≤760 px |
| static/img/league-logo.webp | 85,860 | 861x893 | 100 px circle (also og:image) |

Files already near target size and safe to leave: index-2016 (72 KB),
index-2017 (56 KB), index-2018 (51 KB), index-2022 (72 KB).

### Fix plan

1. For each file in the table above except league-logo, produce an
   800 px-wide (or 800 px-tall for portrait) version at quality 78:
   ```sh
   mkdir -p /tmp/opencode/resized
   for f in index-2019 index-2020 about-leadership index-2023 index-2021 index-2025 index-2024 about-excommunicado-ramrod index-2016; do
     magick "static/img/$f.webp" -resize 'x800>' -quality 78 "/tmp/opencode/resized/$f.webp"
   done
   ```
   Use `-resize '800x>' instead for portrait images if aspect matters;
   either way cap the long edge at ~800 px. If `magick` is unavailable,
   use `dwebp` then `cwebp -q 78 -resize <w> <h>`.
2. Target under ~80 KB per image. Re-run with `-quality 70` for any
   straggler.
3. Overwrite the originals in place (filenames unchanged, no HTML edits):
   ```sh
   cp /tmp/opencode/resized/*.webp static/img/
   ```
4. league-logo.webp renders as a 100 px circle on owners.html,
   power-rankings.html, and all owner pages, but it doubles as og:image
   for power-rankings.html (src/power-rankings.html:11), where some
   scrapers want ≥200 px. Resize to 400x400 (not 200) and overwrite:
   ```sh
   magick static/img/league-logo.webp -resize 400x400 -quality 80 /tmp/opencode/resized/league-logo.webp
   cp /tmp/opencode/resized/league-logo.webp static/img/league-logo.webp
   ```
5. Invalidate CloudFront after deploying (see finding 1 note).

### Verification

- `du -sh static/img` drops from ~4.8 MB to well under 1 MB.
- Spot-check index.html, about.html, one owner page locally. Images look
  acceptable at 760 px wide and at 100 px circle crop.
- No HTML diffs required; `git status` should show only binary changes
  under static/img.

---

## Finding 4 — Missing intrinsic image dimensions (CLS)

**Severity:** High.
**Area:** Cumulative Layout Shift.

### Evidence

Images without `width`/`height` attributes shift layout as they load:

- Sponsor `<img>` on all 14 pages (fixed by finding 1 step 4).
- Header logo: present on owners/power-rankings/owner pages but missing
  on src/index.html:186, src/about.html:187, src/trades.html:160.
- Post images on index.html and about.html (`.post-image` has
  `max-width: 100%; height: auto` only).
- Owner logos: src/owners.html:252 and all owner pages line 243 use
  `.owner-logo-image` (CSS fixes size at 100x100, so shift risk is low,
  but attributes are still correct practice).

### Fix plan

Add `width`/`height` matching each source's intrinsic aspect ratio.
After finding 3's resize, dimensions are:

1. Header logo (all three locations): add `width="100" height="75"`
   (matches existing pages; `.logo` CSS already forces 100x75).
2. Post images on index/about: add width/height equal to the *resized*
   file's actual pixel dimensions (read them with `magick identify` or
   `file <f>`). Example for a 800x453 result:
   `width="800" height="453"`.
3. Owner logos + owners.html league logo: add `width="100" height="100"`
   (CSS class enforces the same box).

### Verification

- Run Lighthouse (Chrome DevTools) on index.html and about.html before
  and after; CLS metric should be ~0 and "Image elements do not have
  explicit width and height" audit passes.
- Visual check: no stretching; images keep aspect ratio.

---

## Finding 5 — Google Fonts: full variable font range, render-blocking

**Severity:** Medium.
**Area:** Fonts / render-blocking CSS.

### Evidence

Every page includes (e.g. src/index.html:34):

```html
<link href="https://fonts.googleapis.com/css2?family=Archivo:ital,wght@0,100..900;1,100..900&display=swap" rel="stylesheet">
```

This requests the Archivo variable font covering weights 100-900 for
both normal and italic. The site uses only: regular 400 body text, bold
700 (`<strong>`, `.sponsor-name`), 500 (`.stats-table .owner`), 600
(trades badges), and italic 400 (`<em>`). The extra axis range forces
larger font files than necessary, and the stylesheet link blocks first
render.

### Fix plan

1. On every page, replace the fonts URL with:
   ```
   https://fonts.googleapis.com/css2?family=Archivo:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap
   ```
   Files: src/index.html:34, src/about.html:34, src/owners.html:12,
   src/trades.html:14, src/power-rankings.html:21, all 10 owner pages
   (same line number pattern, search for `fonts.googleapis.com`).
2. Keep both `preconnect` hints (fonts.googleapis.com, fonts.gstatic.com)
   exactly as they are.
3. Optional (bigger win, more work): self-host two subset woff2 files
   (Archivo 400+700 roman, plus italic 400) under `static/fonts/`,
   reference via `@font-face` in the shared stylesheet from finding 8,
   with `font-display: swap` and `<link rel="preload" as="font">`. Skip
   this unless asked; step 1 is the agreed scope.

### Verification

- Open a page with DevTools Network filtered to `fonts.gstatic`; the
  downloaded woff2 responses are smaller than before (compare sizes
  before/after on one page).
- Text still renders bold/italic correctly; no FOUT regression beyond
  the existing swap behavior.

---

## Finding 6 — dn.html: render-blocking third-party D3 + broken chart JS

**Severity:** Medium (performance) / High (correctness bug inside).
**Area:** JavaScript.

### Evidence

1. src/dn.html:14 loads the whole D3 bundle synchronously in `<head>`
   from a third-party origin:
   ```html
   <script src="https://d3js.org/d3.v7.min.js"></script>
   ```
   ~280 KB minified (~95 KB compressed), parser-heavy, and
   d3js.org is a shared community CDN with no SLA. It blocks first
   paint of the entire page.
2. Runtime bug: src/dn.html:725 and src/dn.html:739 call `.data(data)`
   where `data` is undefined (the parameter is `team`, the array is
   `team.data`). This throws `ReferenceError: data is not defined`
   mid-`renderChart`, so the tooltip bindings and the blue/red data
   point circles never attach, and execution of `teamsData.forEach`
   aborts.

### Fix plan

1. Fix the bug: in src/dn.html change `.data(data)` to
   `.data(team.data)` in both places (lines ~725 and ~739).
2. Move the script tag out of `<head>` to just before the closing
   `</body>` (above the existing inline `<script>` at src/dn.html:492)
   and add `defer` is unnecessary once moved; simply placing it there
   unblocks rendering. Result:
   ```html
   <script src="https://d3js.org/d3.v7.min.js"></script>
   ```
   placed immediately before the inline chart script.
3. Preferred alternative if permitted: download D3 into the repo and
   self-host, removing the third-party dependency entirely:
   ```sh
   curl -o static/js/d3.v7.min.js https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js
   mkdir -p static/js && mv /tmp/opencode/d3.v7.min.js static/js/
   ```
   then reference `src="../static/js/d3.v7.min.js"`. Note `static/js/`
   deploys with immutable caching; bump the filename (or accept
   invalidation) when upgrading versions.
4. Optional follow-up (out of scope unless asked): replace D3 with a
   small hand-rolled SVG chart; the chart is a single bar+line series.

### Verification

- Load src/dn.html locally (needs internet for the CDN path unless
  step 3 was taken). Chart renders bars, two lines, hover tooltips work
  on bars AND on the line points.
- Console shows zero errors.
- Other pages unaffected.

---

## Finding 7 — Unused asset deployed: index-2025-sticker.webp

**Severity:** Low.
**Area:** Asset hygiene.

### Evidence

`static/img/index-2025-sticker.webp` (889,902 bytes, 2048x2048) is not
referenced by any HTML, script, or doc in the repo. It deploys to S3 via
`make deploy-static`.

### Fix plan

1. Confirm nothing references it:
   `grep -rn "index-2025-sticker" . --exclude-dir=.git`
2. `git rm static/img/index-2025-sticker.webp` and commit.
3. Remove the deployed copy: the next `aws s3 sync ... --delete`
   (Makefile:40) removes it automatically on deploy.

### Verification

- Grep returns nothing; `git status` shows the deletion; next deploy
  succeeds.

---

## Finding 8 — Identical ~150-line inline CSS duplicated on 14 pages

**Severity:** Medium.
**Area:** Maintainability + repeat-view performance.

### Evidence

Every page embeds essentially the same `<style>` block (body/header/
sponsor/nav/footer/table styles): src/index.html:36-178, src/about.html:
36-179, src/owners.html:14-214, src/power-rankings.html:23-175,
trades has its own variant (src/trades.html:17-152), and each owner page
repeats the owners-style block (e.g. src/dn.html:15-256). Pages deploy
with `max-age=0, must-revalidate`, so this CSS re-downloads inside the
HTML on every visit and cannot be cached independently.

### Fix plan

1. Create `static/css/site.css` containing the shared rules: body,
   .header, .header-container, .logo, .site-title, .tagline,
   .sponsor-box (+ img/content/name/tagline), nav, footer, base `a`
   rules, table styles (.table-container, .stats-table...),
   .owner-logo-header, .owner-logo-image, and the shared
   `@media (max-width: 768px)` responsive block. Format it with prettier
   (it must pass `npx prettier --check static/css/site.css`).
2. Exclude page-specific rules that differ per page: keep the D3 styles
   (#tooltip, .chart-title...) inline in dn.html or move to a second
   `static/css/chart.css`; keep trades.html badge/table-card styles
   inline in trades.html; keep power-rankings `.delta/.methodology`
   inline there. Shared-only extraction avoids touching generator logic.
3. Replace each page's big `<style>` block with:
   ```html
   <link rel="stylesheet" href="../static/css/site.css?v=1">
   ```
   keeping any page-specific `<style>` after it. Preserve the
   `<div class="table-container">` wrappers (generator constraint).
4. The `?v=1` query pairs with immutable caching (finding 10): bump to
   `?v=2` whenever site.css meaningfully changes.

### Verification

- `python3 -m http.server 8000` and eyeball every page type: index,
  about, owners, power-rankings, trades, one owner page. Styling matches
  pre-change rendering.
- `node scripts/generate-stats.js owners index` runs and rewrites the
  owners table without corrupting markup (`git diff` shows only the
  regenerated table).
- Repeat-view Network waterfall: site.css served from disk cache (check
  "Size" column shows "(disk cache)").

---

## Finding 9 — Prefetch script over-fetches on load

**Severity:** Low.
**Area:** JavaScript / bandwidth prioritization.

### Evidence

src/index.html:351-402: an IntersectionObserver observes every `<a>`;
any link entering the viewport triggers an immediate `fetch()` of the
full HTML document. On load, the four visible nav links prefetch
immediately, competing with the LCP image for bandwidth. `fetch()` also
performs a CORS-mode request with credentials rather than the lighter,
dedicated `<link rel="prefetch">` mechanism.

### Fix plan

1. Respect data-saver and slow connections: at the top of the IIFE,
   bail out early:
   ```js
   const conn = navigator.connection;
   if (conn && (conn.saveData || /2g/.test(conn.effectiveType))) return;
   ```
2. Delay viewport-triggered prefetches until the page is idle:
   wrap observer creation/link registration in
   `requestIdleCallback` (fallback `setTimeout(..., 1500)`).
3. Prefer `<link rel="prefetch">`: replace the `fetch(url, {priority:
   'low'})` call with injecting
   `const l = document.createElement('link'); l.rel = 'prefetch'; l.href = url; document.head.appendChild(l);`
   Keep the dedupe Set.
4. Copy the tuned script to the other pages only if they get the same
   prefetcher later; today it exists solely on index.html, which keeps
   scope small.

### Verification

- Load index.html: nav-link prefetch requests fire after load event /
  idle, not before LCP image completes (check Performance panel
  ordering).
- No double-fetches for the same URL (Network tab, dedupe works).
- With DevTools "Slow 3G" + saveData emulation skipped, no errors.

---

## Finding 10 — Caching strategy: immutable URLs without versioning, wildcard invalidation, icon type mismatches

**Severity:** Medium.
**Area:** HTTP caching / correctness over time.

### Evidence

- Makefile:40 deploys everything under `static/` with
  `public, max-age=31536000, immutable`, but asset filenames carry no
  hash/version. CloudFront invalidation clears the edge, **not browser
  caches** — a visitor who loaded the current sponsor image keeps it for
  up to a year even after the file changes on S3. Any image update
  silently serves stale bytes to returning visitors.
- Makefile:48 invalidates `/*` on every deploy. Cheap-ish (one wildcard
  path) but masks staleness problems instead of surfacing them.
- `static/ico/header-icon-32.png` and `header-icon-192.png` are actually
  WebP bytes with a `.png` name (verified: RIFF/WebP magic, served as
  `content-type: image/png`). Safari does not support WebP favicons /
  apple-touch-icons reliably, so iOS home-screen icons can fail.
- Every page declares both `rel="icon"` and `rel="shortcut icon"` to the
  same URL (harmless duplication), and `rel="apple-touch-icon"` points
  at the WebP-in-.png file.

### Fix plan

1. Adopt query-string versioning as the convention for changed assets:
   whenever a static file's content changes, append/update `?v=N` in the
   referencing HTML (site.css already does this per finding 8). Document
   the rule in AGENTS.md under Commands:
   "Bump ?v=N in referencing HTML whenever a static asset changes."
2. Regenerate true PNG icons:
   ```sh
   dwebp static/ico/header-icon-32.png -o /tmp/opencode/icon32.png
   dwebp static/ico/header-icon-192.png -o /tmp/opencode/icon192.png
   cp /tmp/opencode/icon32.png static/ico/header-icon-32.png
   cp /tmp/opencode/icon192.png static/ico/header-icon-192.png
   ```
   Filenames stay the same; bytes become real PNGs.
3. Drop the redundant `<link rel="shortcut icon" ...>` line from every
   page (keep `rel="icon"`).
4. Narrow the invalidation once comfortable: replace `"/*"` in
   Makefile:48 with explicit paths (`"/index.html" "/about.html" ...`
   plus `"/static/*"`), or leave as-is if wildcard cost is acceptable —
   document the tradeoff in AGENTS.md.

### Verification

- `file static/ico/*.png` reports PNG, not RIFF/WebP.
- Favicon renders in Chrome and Safari tab; curl confirms
  `content-type: image/png` with PNG magic bytes (`xxd | head -1` shows
  `.PNG`).
- Pages have single icon link; no console 404s.

---

## Finding 11 — Stub pages deployed live

**Severity:** Low.
**Area:** Deploy hygiene.

### Evidence

- https://derbruden.com/leaders.html returns 200 with body `TODO`
  (src/leaders.html is a one-line stub).
- src/minutes.html contains unprocessed template syntax (`{{ stub: ... }}`)
  for a build system that does not exist in this repo; it deploys raw.

### Fix plan

1. Delete both files: `git rm src/leaders.html src/minutes.html`.
2. Next `make deploy-html` already `rm`s remote HTML then syncs with
   `--delete`, so they disappear from S3 automatically; run
   `make invalidate-cache`.
3. If either page is planned future work, move the intent to `TODO`
   (the existing TODO file) instead of shipping placeholder pages.

### Verification

- `curl -s -o /dev/null -w "%{http_code}" https://derbruden.com/leaders.html`
  returns 404 after deploy.
- No internal links point to either page:
  `grep -rn "leaders.html\|minutes.html" src/` is empty.

---

## Finding 12 — Layout/styling inconsistencies and metadata bugs

**Severity:** Low.
**Area:** Consistency.

### Evidence

1. **Header drift:** trades.html omits the sponsor box entirely
   (src/trades.html:156-168 vs every other page). Nav links drift too:
   trades.html nav lacks the Trades link (src/trades.html:170-175) while
   other pages include their own section links.
2. **Dead CSS:** `.sponsor-ribbon` rules match no element (media-query
   blocks, e.g. src/index.html:168-172, src/dn.html:196-200). Duplicate
   `.stats-table .owner` rule at src/owners.html:163-169. `body` declares
   `margin: 0` then `margin: 0 auto` (harmless duplicate, e.g.
   src/index.html:40-43). `.post-date`/`.post-category` classes unused
   in most pages' markup.
3. **og:image metadata wrong:** src/index.html:13-15 claims
   `1200x630` but index-2025.webp is 2824x1570 (and becomes 800-wide
   after finding 3); src/index.html:24 twitter:image points at
   index-2024.webp while og:image points at index-2025.webp;
   about.html points both at index-2024.webp.
4. **Mobile trades table readability:** src/trades.html:129-151 turns
   rows into stacked blocks but cells lose their column identity (no
   `data-label` pseudo-content), so "Date/Status/Details" context
   disappears on phones.
5. **Page titles:** every page uses title
   `DerBruden.com | Strange dreams lately?` except trades/power-rankings;
   harmless for a fun site but inconsistent.

### Fix plan

1. Copy the standard sponsor-box markup block from src/index.html:194-205
   into trades.html header (inside `.header-container`, after `.header`),
   and add the missing Trades nav link. Adjust trades.html media query
   for `.sponsor-box` to match other pages.
2. Remove dead rules listed above in whatever pages the fix touches
   (do not sweep all legacy pages just for this).
3. Social metadata: pick one canonical share image per page. Simplest:
   set index.html og:image and twitter:image to the same absolute URL
   (`https://derbruden.com/static/img/index-2025.webp`), and set
   `og:image:width/height` to the actual post-resize dimensions from
   finding 3 (`magick identify static/img/index-2025.webp`). Point
   about.html at its own leadership image or the league logo.
4. Mobile trades table: add `data-label="Date"` etc. to each `<th>`-
   corresponding cell is not possible for server-rendered rows here
   (rows come from JSON), so instead extend the mobile CSS to show a
   small label using `td:nth-child(n)::before { content: "Date"; ... }`
   matching the three columns, with `td { display: block; }` in the
   media query.
5. Titles: give each page a distinct `<title>` ("DerBruden.com | About",
   "| Owners", "| DN", ...) while keeping the tagline in the header.

### Verification

- Side-by-side screenshots of headers on index, trades, one owner page
  at 375 px and 1280 px widths look consistent.
- Share-debug each updated URL (paste into a social debugger or curl the
  og tags) — image URL resolves 200 and declared dims match actual.
- Resize to 375 px on trades.html: each stacked row shows field labels.

---

## Finding 13 — Header/nav reflows on every cross-page navigation

**Severity:** Medium.
**Area:** Navigation / perceived performance.

### Evidence

Every page is a standalone HTML document, so each navigation tears down
and rebuilds the full header. Three things make that rebuild visible
instead of seamless:

1. **Unstable header geometry from undimensioned images.**
   - Header logo has no `width`/`height` on src/index.html:186,
     src/about.html:187, src/trades.html:160 (other pages have it).
   - The sponsor `<img>` has no dimensions anywhere (finding 1) and CSS
     only constrains `max-width: 100px; height: auto`, so the box is
     short/collapsed until a 1.15 MB image finishes loading, then grows.
   - HTML deploys with `max-age=0, must-revalidate` (Makefile:33), so
     every navigation re-parses the document and replays this
     collapse-then-grow sequence even when images are cached.
2. **Font swap reflow.** Archivo loads via render-blocking Google Fonts
   CSS with `display=swap`. Fallback sans-serif paints first; when
   Archivo swaps in, different glyph metrics shift the title/tagline/nav
   baseline. Visible on every first-in-session navigation.
3. **Structural drift between pages.** src/trades.html has NO sponsor
   box at all (header-container holds only the logo block) and its nav
   omits the Trades link. Navigating index -> trades -> index changes
   the header's height and content both ways. Nav link sets otherwise
   match across pages.

### Fix plan

Part A — make the header geometry deterministic (removes the visible jump):

1. Add `width="100" height="75"` to the three header logo tags listed
   above (overlaps finding 4).
2. Add `width="200" height="200"` to every sponsor `<img>` (finding 1,
   step 4) and give `.sponsor-box img { max-height: 100px; }` so the box
   reserves its height before the bytes arrive.
3. Reduce font-swap shift: add a metric-compatible fallback stack:
   `font-family: "Archivo", "Helvetica Neue", Arial, sans-serif;` on
   body in all pages, or (better) self-host per finding 5's optional
   step and preload the woff2 so swap happens before first paint.

Part B — unify header markup:

4. Copy the standard sponsor-box block (src/index.html:194-205) into
   src/trades.html inside `.header-container`, and append the missing
   `<a href="./trades.html">Trades</a>` to its nav (overlaps finding 12,
   items 1). After this, the header DOM is byte-identical across pages,
   which also lets browsers reuse layout patterns and keeps future edits
   copy-paste consistent.

Part C — actually cache navigation between pages:

5. Extend the prefetcher beyond index.html. The existing script exists
   only on src/index.html. After fixing finding 9 (idle-delayed), embed
   it in all pages, or replace it with Speculation Rules, which Chrome
   supports natively and which prerenders instead of just fetching:
   ```html
   <script type="speculationrules">
   {
     "prefetch": [{ "source": "document",
       "where": { "href_matches": "./*.html" },
       "eagerness": "moderate" }]
   }
   </script>
   ```
   With `"moderate"`, links prefetch on hover; use `"prerender"` with
   `"eagerness": "conservative"` for instant navigations. Firefox/Safari
   ignore the tag harmlessly.
6. Let the browser serve HTML from cache on back/forward and short
   hops: change Makefile:33 cache-control for HTML from
   `public, max-age=0, must-revalidate` to
   `public, max-age=60, stale-while-revalidate=300`. CloudFront
   invalidation on deploy still makes updates visible at the edge;
   returning visitors may see content up to 60 seconds old — acceptable
   for a site updated weekly. Note: `fetch()`-based prefetch responses
   currently get revalidated (304 round trip) before display because of
   `must-revalidate`; the relaxed TTL is what turns prefetched pages into
   zero-request instant loads.
7. Do not add a service worker or SPA routing for this. The repo is
   plain static HTML by design; parts A-C achieve cached-feeling
   navigation without a framework.

### Verification

- Click through index -> about -> owners -> trades -> an owner page with
  DevTools Performance panel (CPU 4x throttle): the header band should
  occupy identical pixels on every page before and after images load.
- Network tab during hover-prefetch: destination HTML shows up as
  prefetched before click; after click, navigation serves from cache
  (no document request, or a 304 at worst pre-step-6).
- Back button returns instantly (bfcache hit; confirm no
  `unload`/`pagehide` blockers were added).

---

## Suggested fix order

1 → 2 → 3 → 4 → 6 → 5 → 8 → 10 → 7 → 9 → 11 → 12

Findings 1-4 deliver nearly all of the measurable win (multi-MB per
page view down to low hundreds of KB, stable LCP/CLS). Finding 6
includes the only outright JS bug. 5, 8, 10 are structural improvements;
the rest are hygiene. Finding 13's Part A rides along with findings 1
and 4 for free; do Part C (navigation caching) last so the idle-delayed
prefetcher from finding 9 is what gets distributed.

## Expected impact after findings 1-5

- First visit to index.html drops from ~2.5 MB+ of images alone to
  roughly 250-350 KB total weight.
- Repeat visits stop re-downloading 1.15 MB of sponsor pixels on every
  page (cached, tiny file).
- LCP no longer waits behind a lazily discovered image; CLS approaches
  zero with intrinsic dimensions everywhere.
