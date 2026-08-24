# Plan: trade tracker

Track trades proposed and accepted in ESPN league 794521, post them to a
Discord webhook, and publish a feed that derbruden.com can render.

## Goal

1. Poll ESPN for league transactions on a schedule.
2. Detect new `TRADE_PROPOSAL` and `TRADE_ACCEPT` events.
3. Post each event as a Discord message.
4. Publish all events as `trades.json` so the site can show a trade log.

## Research findings

Verified against the live API and community libraries (`espn-api`,
`espn-fantasy-football-api`, `fantasy_football_chat_bot`):

- League endpoint:
  `https://fantasy.espn.com/apis/v3/games/ffl/seasons/{YEAR}/segments/0/leagues/794521`
- The league is private. Requests without cookies redirect. Transaction
  reads need `Cookie: espn_s2={...}; SWID={...}` from the SAME login
  session. With only `espn_s2`, league meta loads but transaction views
  return empty.
- Host quirk (verified live): use `lm-api-reads.fantasy.espn.com` for all
  API calls. It serves JSON with the full cookie pair. The older
  `fantasy.espn.com` host 302s every request regardless of cookies.
- Verified payload shape (`view=mTransactions2`):
  - `transactions[].id` is a UUID string, not a number.
  - Types seen: `TRADE_ACCEPT`, `ROSTER` (lineup moves). Filter server-side
    with `X-Fantasy-Filter` values `TRADE_PROPOSAL` / `TRADE_ACCEPT`.
  - Items carry `type` of `TRADE`, `DRAFT_TRADE`, or `LINEUP`, with
    `fromTeamId` / `toTeamId`. Draft-pick legs have `playerId: 0` plus
    `overallPickNumber`. LINEUP items belong to `ROSTER` transactions only.
  - Dates are epoch-ms in `proposedDate` / `processDate`.
  - Team display names come from `mTeam`: `teams[].name` (not
    location/nickname).
  - Player names resolve via
    `sports.core.api.espn.com/v2/sports/football/leagues/nfl/athletes/{id}`
    (`fullName`). No auth needed.
- Transactions come from `view=mTransactions2` plus an `X-Fantasy-Filter`
  header. Filter by string types:
  `TRADE_PROPOSAL`, `TRADE_ACCEPT`, `TRADE_DECLINE`, `TRADE_VETO`.
- Fallback source: `/communication/` endpoint with topic filter
  `ACTIVITY_TRANSACTIONS`. Notification type IDs: `239` = trade proposed,
  `244` = trade accepted.
- Each transaction has a numeric `id`, a timestamp, `items[]` with players and
  team IDs, and status fields.
- Cookies expire after roughly a year. Refresh them from browser DevTools when
  they do.

## Architecture

```
cron / systemd timer (every 5-10 min)
  -> scripts/watch-trades.mjs   (Node >= 18, no dependencies, uses global fetch)
       1. GET ESPN transactions with cookies
       2. Diff against state file (highest seen transaction ID)
       3. For each new trade event:
            - POST Discord webhook embed
            - Append record to static/data/trades.json
            - Save state atomically
       4. Optional: sync data to S3 + invalidate CloudFront path
```

Runs anywhere: Raspberry Pi, WSL, laptop cron, or later a Lambda. The script
stays small and dependency-free so low-RAM hosts work well (~40 MB RSS).

## Components

### 1. Poller: `scripts/watch-trades.mjs`

New ESM script. Matches the existing `scripts/` stack (Node 18+, `"type":
"module"`). No npm dependencies needed.

Flow:

1. Read config from environment variables.
2. Request `mTransactions2` with filter
   `{"transactions":{"filterType":{"value":["TRADE_PROPOSAL","TRADE_ACCEPT"]}}}`.
3. Sort by `id`. Keep events with `id > state.lastId`.
4. Map each event to a trade record (see schema below).
5. Post Discord webhook. Then update state. Never post twice for one ID.
6. Write state file atomically: write temp file, then rename.

Flags:

- `--dry-run`: fetch and print what would happen. No webhook, no writes.
- `--backfill N`: seed the ledger with the last N trades, no notifications.

### 2. State: `data/state.json` (gitignored)

```json
{
  "lastId": 123456789,
  "updatedAt": "2026-08-23T15:04:05Z"
}
```

One number does the dedupe. If the file is missing, first run seeds it with
the current maximum ID and posts nothing (prevents startup spam).

### 3. Ledger: `static/data/trades.json` (committed)

Full season history, newest first. The site fetches this file directly, so
CloudFront serves it like any other static asset. Existing `make deploy`
already syncs `static/`.

Schema:

```json
{
  "leagueId": 794521,
  "season": 2026,
  "updated": "2026-08-23T15:04:05Z",
  "trades": [
    {
      "id": 123456789,
      "event": "TRADE_ACCEPT",
      "date": "2026-08-23T15:04:05Z",
      "teams": [
        { "teamId": 5, "name": "Team A", "gives": ["Player 1", "Player 2"] },
        { "teamId": 8, "name": "Team B", "gives": ["Player 3"] }
      ]
    }
  ]
}
```

A proposal and its later acceptance are two records with different IDs. The
site can pair them by player set if we want proposal-to-accept timing later.

### 4. Notifier: Discord webhook

- One `POST` per event to `DISCORD_WEBHOOK_URL`.
- Embed format:
  - Title: `Trade accepted` or `Trade proposed`.
  - Description: one line per side, `Team A sends X, Y <-> Team B sends Z`.
  - Color: green for accepted, gray for proposed.
  - Timestamp: event date.
- Handle HTTP 429: respect `retry_after`, then retry once. Failures must not
  block the state write for other events; log and continue.

### 5. Site page: `src/trades.html`

Small static page in the style of existing pages. Vanilla JS fetches
`static/data/trades.json` and renders a simple table: date, teams, players
moved, status. No build step, consistent with the rest of the site.

## Config

Read from environment or `.env` (add `.env` to `.gitignore`; keep a
`.env.example`):

| Variable | Required | Purpose |
| --- | --- | --- |
| `LEAGUE_ID` | Yes | `794521` |
| `LEAGUE_YEAR` | Yes | Current season year |
| `ESPN_S2` | Yes | Private league cookie |
| `SWID` | Yes | Private league cookie |
| `DISCORD_WEBHOOK_URL` | Yes | Webhook secret URL |
| `STATE_FILE` | No | Default `data/state.json` |
| `NOTIFY_DECLINED` | No | Also report declines/vetoes. Default off |

Secrets never go in git. Note: `terraform/runbook/README.md` currently
contains live `ESPN_S2` and `SWID` values. Rotate those cookies before launch
and move future values into `.env` or SSM.

## Scheduling

Chosen: GitHub Actions cron, every 10 minutes, year-round. Free on the public
repo. The workflow commits ledger and state changes back to the branch it
runs on and publishes `trades.json` to S3 with a targeted CloudFront
invalidation when trades land. Schedule only activates after this work merges
to the default branch; `workflow_dispatch` can run it from any branch.

Local alternative unchanged: cron or systemd timer every 5-10 minutes.

```
*/10 9-23 * * *  cd ~/repos/derbruden && node scripts/watch-trades.mjs >> data/watch.log 2>&1
```

## Edge cases

- Cookie expiry: API returns redirect/HTML instead of JSON. Detect non-JSON
  response, log clear message, exit non-zero so cron mail/log shows it.
- Missed polls: query window covers more than one interval, dedupe by ID makes
  gaps safe.
- Vetoed or declined proposals: skip by default; flag enables them.
- Trade deadline and offseason: poller exits quietly when no events.
- API shape change: validate expected keys, fail loud with context.
- Clock skew: use event timestamps from ESPN, not local time, for display.

## Testing

1. Unit-test the diff and record mapping with fixture payloads saved from real
   responses (`scripts/test/fixtures/*.json`). Plain `node --test`, no new
   dev dependencies.
2. `--dry-run` against live API once cookies are fresh.
3. Fake webhook endpoint (webhook.site or local server) to check embed output.
4. Kill/restart mid-run to confirm atomic state writes prevent duplicates.

## Rollout

1. **MVP**: poller with `--dry-run`, fresh cookies, verify real payload shape.
2. **Discord**: live webhook posts, state dedupe, cron entry on Pi/WSL.
3. **Site**: `trades.json` publisher, `src/trades.html`, deploy integration,
   backfill prior seasons through the same endpoint.
4. **Harden**: retries, logging, README section, systemd unit example.
5. **Later options**: Lambda migration, decline/veto notifications,
   proposal-to-close timing stats on owner pages.

## Open questions

1. Map ESPN team IDs to owner initials (DN, ZS, ...) for friendlier messages?
2. Notify proposals in Discord, or accepted trades only?
3. Backfill how many past seasons into the site ledger?
