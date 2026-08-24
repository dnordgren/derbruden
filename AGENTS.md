# AGENTS.md

Guidance for AI coding agents working in this repo.

## Project

DerBruden.com. Static fantasy football league site for the Der Bruden
ESPN league (id 794521). Plain HTML in `src/`, assets in `static/`.
Deploys to S3 + CloudFront with `make deploy` (profile `derbruden`).
No framework, no build step besides two Node generators in `scripts/`.

## Commands

- `node scripts/generate-stats.js owners index|all|<owner>` — rebuild
  stats tables into owner pages from `scripts/stats.csv`.
- `make power` — regenerate `src/power-rankings.html` from the ESPN API.
- `AWS_PROFILE=derbruden make deploy` — S3 sync + CloudFront invalidation.
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
- `TEAM_OWNERS` in `generate-power-rankings.js` maps ESPN team ids to
  owner codes. Team ids are stable franchise slots but verify against the
  league after each August draft.
- Algorithm: Elo, K=20, margin-of-victory multiplier, seeded from prior
  season win percentage in `stats.csv`. Regular season only
  (`playoffTierType === 'NONE'`).
- Season selection: no argument means August through December maps to
  the current calendar year, January through July to the prior year.
  If that fetch fails, the script falls back one year.
- Regression check: `node scripts/generate-power-rankings.js 2025` must
  rank JO #1 (1564) through DM #10 (1440).

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
