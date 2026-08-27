# AGENTS.md

Guidance for AI coding agents working in this repo.

## Project

DerBruden.com. Static fantasy football league site for the Der Bruden
ESPN league (id 794521). Plain HTML in `src/`, assets in `static/`.
Deploys to S3 + CloudFront with `make deploy` (profile `derbruden`).
No framework; shared page chunks are inlined at build time by
`scripts/build.mjs` into git-ignored `pub/`.

## Commands

- `make build` — inline `<!--#include -->` directives from `src/*.html`
  into git-ignored `pub/`. `deploy-html` runs it automatically; never
  edit `pub/` or deploy `src/` directly.
- `node scripts/generate-stats.js owners index|all|<owner>` — rebuild
  stats tables into owner pages from `scripts/stats.csv`.
- `make power` — regenerate `src/power-rankings.html` from the ESPN API.
- `make drafts` — rebuild `src/drafts.html` and per-owner draft sections
  from the ESPN API.
- `make waivers` — regenerate `static/data/waivers.json` (waiver order +
  season moves) for `src/waivers.html`.
- `make records` — regenerate `src/records.html` (all-time records,
  head-to-head matrix, trophy case, hall of shame) and
  `static/data/alltime-records.json` from the ESPN API. See
  "All-time records" below.
- `node scripts/sync-team-names.js [--dry-run] [season]` — sync ESPN
  team names into owner page headers.
- `AWS_PROFILE=derbruden make deploy` — S3 sync + CloudFront invalidation.
  The apt `aws` binary is broken on the dev machine (old pyOpenSSL clash).
  `~/.zshenv` pins PATH to the working `~/.venvs/awscli` install, so fresh
  shells just work. If a stale session resolves `/usr/bin/aws`, run
  `export PATH="$HOME/.venvs/awscli/bin:$PATH"` first.
- `npx prettier --check <file>` — repo uses the `.prettierrc` config.
  Legacy HTML pages fail prettier; do not reformat them wholesale.
- Static assets deploy with immutable year-long caching. Whenever a file
  under `static/` changes, bump the `?v=N` query in every HTML page (and
  generator template) that references it — e.g. `site.css?v=1` becomes
  `?v=2`. Invalidation clears CloudFront edges but not browser caches,
  so unversioned renames leave returning visitors stale for a year.
  Deploy invalidation intentionally stays a wildcard (`/*`): it costs
  one path regardless of count and avoids missing newly added pages;
  versioned asset names are what actually protect browser caches.
- Shared page CSS lives in `static/css/site.css`. Pages link it and keep
  only page-specific rules in a small inline `<style>`.
- Shared page chunks (head links, site header, sponsor box, nav, footer)
  live in `src/partials/` and are pulled in with
  `<!--#include file="partials/x.html" key="value" -->`; `{{key}}` in a
  partial is replaced by the attribute value. The directives work in
  source pages AND in generator output: `generate-drafts.js` /
  `generate-power-rankings.js` templates emit them, and `build.mjs`
  expands everything before deploy.
- Commit style: `feat:` / `chore:` / `fix:` prefixes, imperative mood,
  Tim Pope guidelines.

## Power rankings

- Requires `scripts/.env` with `ESPN_S2=<cookie>` (git ignored). `SWID`
  is not required. Cookie expires periodically; re-grab from any signed-in
  browser. See README "Generate power rankings".
- A weekly GitHub Action (`.github/workflows/power-rankings.yml`) runs
  Tuesday mornings in season. It needs repo secrets `ESPN_S2`, `SWID`,
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  `DISCORD_WEBHOOK_POWERRANKINGS`. Rotate the ESPN secret when the
  action starts failing with 302s.
- `scripts/post-discord.js` posts top-five rankings to Discord from
  `power-rankings-state.json`. Supports `--dry-run`. It skips posting
  when no regular season games have been played (`week === 0`).
- `TEAM_OWNERS` in `scripts/team-owners.js` maps ESPN team ids to
  owner codes and pages. Both generators import it. Team ids are stable
  franchise slots but verify against the league after each August draft.
- Algorithm: Elo, K=20, margin-of-victory multiplier, seeded from prior
  season win percentage in `stats.csv`. Regular season only
  (`playoffTierType === 'NONE'`).
- Season selection: no argument means August through December maps to
  the current calendar year, January through July to the prior year.
  If that fetch fails, the script falls back one year.
- Regression check: `node scripts/generate-power-rankings.js 2025` must
  rank JO #1 (1564) through DM #10 (1440).

## Trade watcher

- `scripts/watch-trades.mjs` polls league transactions every 10 minutes via
  `.github/workflows/trade-watcher.yml` on `master`. Accepted trades post to
  Discord; proposals land on the web page only (accepted == confirmed, there
  is no third state). Declines/vetoes are page-only when
  `NOTIFY_DECLINED=true`. The watcher commits ledger and dedupe state under
  `static/data/` and publishes `trades.json` to S3 with a single-path
  invalidation.
- Repo secrets: `ESPN_S2`, `SWID`, `DISCORD_WEBHOOK_TRADES`,
  `OPENCODE_GO_API_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.
- Roast agent: right after a trade post, the workflow runs
  `scripts/roast-trade.mjs <posted-trades.json>`. It reads the handoff file
  the watcher wrote to `$RUNNER_TEMP`, pulls rosters, standings, traded-player
  news, and NFL headlines from ESPN, then asks OpenCode Go
  (`muse-spark-1.2-contributor` by default, `ROAST_MODEL` to override) for one
  pithy, evidence-free verdict on
  the losing owner and posts it as a second Discord message. The step is
  `continue-on-error`; LLM failures never block ledger commit or S3 publish.
- Local roast dry run: `LEAGUE_ID=794521 LEAGUE_YEAR=2026 node scripts/
  roast-trade.mjs posted-trades.json --dry-run` prints the research packet;
  no API key needed.
- Transaction IDs are UUIDs; dedupe state lives in
  `static/data/trades-state.json`. Empty state seeds silently on first run
  and never back-posts.
- ESPN auth quirk: transactions need BOTH `ESPN_S2` and `SWID` from one
  login session, served from `lm-api-reads.fantasy.espn.com`. The
  `fantasy.espn.com` host 302s everything now. Player names resolve from
  `sports.core.api.espn.com` without auth.
- Tests: `node --test scripts/watch-trades.test.mjs scripts/roast-trade.test.mjs`.
- GitHub disables schedules after 60 days without commits; re-enable each
  offseason when the notice email arrives.

## Draft history

- `scripts/generate-drafts.js` fetches `view=mDraftDetail` per season
  (ESPN keeps drafts back to 2018) and writes `src/drafts.html` plus a
  "Draft Picks" section into every owner page between
  `<!-- DRAFT_HISTORY_START -->` / `<!-- DRAFT_HISTORY_END -->` markers
  (first run inserts them before `</main>`).
- Requires the same `scripts/.env` `ESPN_S2` as power rankings.
- Player info resolves from `sports.core.api.espn.com`, season-scoped:
  `/seasons/<year>/athletes/<id>` gives draft-day team; some records are
  thin and fall back to `/athletes/<id>`. Free agents show no position.
- `scripts/draft-players.json` caches player lookups keyed
  `<season>:<playerId>`. Commit it; reruns only fetch new picks.
- ESPN quirks: pre-draft slots carry `playerId: -1` (filter or phantom
  picks appear); D/ST ids are `-(16000 + NFL team core id)`; negative
  ids other than `-1` resolve via `/seasons/<year>/teams/<n>`.
- Tests: `node --test scripts/generate-drafts.test.mjs`.
- Rerun each year after the live draft finishes.

## Waivers

- `scripts/generate-waivers.mjs` fetches `view=mTeam` (teams carry
  `waiverRank`, lower is better priority) and waiver transactions
  (`view=mTransactions2`, filter types `FREEAGENT` + `WAIVER`) and rewrites
  `static/data/waivers.json` from scratch. Only the current season is ever
  retained; there is no ledger or dedupe state.
- Needs BOTH `ESPN_S2` and `SWID` (same auth quirk as trades). Player names
  resolve from `sports.core.api.espn.com`; cache lives in
  `scripts/waiver-players.json` keyed `<season>:<playerId>`, pruned to the
  current season each run. Commit it.
- A daily GitHub Action (`.github/workflows/waivers.yml`, two cron windows
  for DST) publishes `waivers.html` + `waivers.json` with a two-path
  invalidation, then commits when files changed. Idle runs change nothing.
- Moves keep statuses EXECUTED and PROPOSED only; declined/failed claims are
  dropped. List is capped at the 150 most recent.
- `deploy-static` excludes `data/waivers.json` from the recursive rm/sync
  (like `trades.json`) so full deploys never delete it or give it immutable
  caching.
- Tests: `node --test scripts/generate-waivers.test.mjs`.

## All-time records

- `scripts/generate-records.js` fetches every season from 2018 (ESPN
  keeps nothing earlier; 2014–2017 live only in stats.csv) and writes
  `static/data/alltime-records.json` plus the body of
  `src/records.html` between `<!-- RECORDS_START -->` /
  `<!-- RECORDS_END -->` markers (first run creates the page; its
  template emits partial includes like the other generators).
- Requires the same `scripts/.env` `ESPN_S2` as power rankings.
- Sections: records, head-to-head matrix, trophy case, hall of shame.
  Weekly marks and h2h include playoffs; droughts and champions merge
  stats.csv back to 2014.
- Playoff berth = played a `WINNERS_BRACKET` game. Consolation ladder
  and losers bracket are consolation rounds. Champion = winner of the
  latest-week winners-bracket game; its existence also marks the season
  complete for drought purposes.
- Win streaks span seasons, count playoff wins, reset on ties.
- Regression check: `node scripts/generate-records.js --check` must
  pass. It compares per-owner regular-season W-L, playoff flags, and
  champions against stats.csv since 2018. Two known csv errors are
  whitelisted: JO and DN marked as 2018 playoff teams, but that
  bracket had four teams (`playoffTeamCount=4`; both lack `PORnk`).
  Derek chose to leave the csv untouched.
- Tests: `node --test scripts/generate-records.test.mjs`.
- Rerun after each week or whenever records change; no scheduled
  action exists.

## Team name sync

- A weekly GitHub Action (`.github/workflows/team-names.yml`) runs
  Tuesdays at 8am ET year round (two cron windows cover DST). Same repo
  secrets as power rankings minus the Discord webhook.
- `scripts/sync-team-names.js` rewrites each `<h1>` inside
  `.owner-logo-header` as `OWNER - <ESPN team name>`. It deploys and
  commits only when a name changed; no-op weeks skip S3 and CloudFront.

## ESPN fantasy API gotchas

- Base URL is `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/...
seasons/<year>/segments/0/leagues/794521`. The older
  `fantasy.espn.com/apis/v3` domain 302s for every request now.
- The league is private. Anonymous calls return 302. Send the espn_s2
  cookie. Never commit cookies or AWS keys.
- `schedule[].winner` values are uppercase: `HOME`, `AWAY`,
  `UNDECIDED`, or lowercase `tie`.
- Future matchups carry numeric `totalPoints: 0` and `winner:
UNDECIDED`. Filter on decided winners only or phantom ties appear.
- Team abbreviations change year to year; team `id`s do not.
