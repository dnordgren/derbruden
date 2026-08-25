# AGENTS.md

Guidance for AI coding agents working in this repo.

## Project

DerBruden.com. Static fantasy football league site for the Der Bruden
ESPN league (id 794521). Plain HTML in `src/`, assets in `static/`.
Deploys to S3 + CloudFront with `make deploy` (profile `derbruden`).
No framework, no build step besides the Node scripts in `scripts/`.

## Commands

- `node scripts/generate-stats.js owners index|all|<owner>` — rebuild
  stats tables into owner pages from `scripts/stats.csv`.
- `make power` — regenerate `src/power-rankings.html` from the ESPN API.
- `make drafts` — rebuild `src/drafts.html` and per-owner draft sections
  from the ESPN API.
- `node scripts/sync-team-names.js [--dry-run] [season]` — sync ESPN
  team names into owner page headers.
- `AWS_PROFILE=derbruden make deploy` — S3 sync + CloudFront invalidation.
  The apt `aws` binary is broken on the dev machine (old pyOpenSSL clash).
  `~/.zshenv` pins PATH to the working `~/.venvs/awscli` install, so fresh
  shells just work. If a stale session resolves `/usr/bin/aws`, run
  `export PATH="$HOME/.venvs/awscli/bin:$PATH"` first.
- `npx prettier --check <file>` — repo uses the `.prettierrc` config.
  Legacy HTML pages fail prettier; do not reformat them wholesale.
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
  news, and NFL headlines from ESPN, then asks OpenCode Go (`kimi-k3` by
  default, `ROAST_MODEL` to override) for one pithy, evidence-free verdict on
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
