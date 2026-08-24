# derbruden

Strange dreams lately? DerBruden.com 🛸

## Develop

### Install tools

- `cwebp` for image optimization

macOS:

```sh
brew install cweb
```

### Generate stats

#### Owners table index

```sh
cd scripts/
nvm use
npm install
node generate-stats.js owners index # updates src/owners.html with updated stats
```

#### Individual owners table

Generate single owner:

```sh
# .. same directory as above
node generate-stats.js owners {owner} # like DN, updates src/{owner}.html
```

Generate all owners:

```sh
# .. same directory as above
node generate-stats.js owners all # updates all src/{owner}.html
```

#### Owners input data

Assumes `/scripts/stats.csv` exists of the form:

```csv
Season,Owner,W,L,%,RGPF,RGPA,TPF,DIFF,PO?,RGRnk,Champ,PORnk
24,ZS,9,4,0.692,1553,1365,1942.1,10.2,Y,3,N,5
24,IK,3,10,0.231,1256,1523,1602.6,18.9,N,10,N,9
...
```

### Generate power rankings

Pulls the league from the ESPN fantasy API. Computes Elo ratings with a
margin-of-victory factor. Writes `src/power-rankings.html`.

The league is private. Put the `espn_s2` cookie value from espn.com in
`scripts/.env` (git ignored):

```sh
echo "ESPN_S2=<espn_s2 cookie value>" > scripts/.env
```

To grab the cookie from iOS Safari: sign in at fantasy.espn.com, then run a
bookmarklet that shows `document.cookie`. Copy the `espn_s2` value. The
`SWID` cookie is not required.

Generate for the current season:

```sh
node scripts/generate-power-rankings.js
```

Generate for a past season:

```sh
node scripts/generate-power-rankings.js 2025
```

Notes:

- Team ids map to owners in `TEAM_OWNERS` inside the script. Verify the map
  after each draft.
- `scripts/power-rankings-state.json` stores the last published ranks. The
  script and the weekly GitHub Action use it to render rank deltas.
  Delete it to reset deltas.

### Weekly update

Regenerate and publish in one pass:

```sh
make power && AWS_PROFILE=derbruden make deploy
```

Run after the Monday night game settles. The deploy profile lives in
`~/.aws`. If the system `aws` binary is broken (Ubuntu apt v1 often is),
use the local install:

```sh
export PATH="$HOME/.venvs/awscli/bin:$PATH"
```

### Discord post

The weekly action posts the top five rankings to Discord and links the
page. Create a webhook in your server under server settings >
integrations > webhooks. Add its URL as the
`DISCORD_WEBHOOK_POWERRANKINGS` repository secret.

Post or preview locally:

```sh
node scripts/post-discord.js            # posts
node scripts/post-discord.js --dry-run  # prints payload only
```

Posts are skipped before week 1 of a new season. The preseason board is
a seed table, so it stays off Discord until real games happen.

The page also carries Open Graph tags, so pasting the link anywhere
unfurls into a card with the league logo.

## Deploy

### Image optimization

- Use `make webp` to optimize and convert any `jpg` or `png` files in
  `static/img` to `webp`.

### Run Deploy

``` sh
AWS_PROFILE=derbruden make deploy
```

This:

- Clears S3 bucket of prior `*.html` and images in `static/`
- Syncs `*.html` from `src/` to S3 root to host site
- Syncs `static/` to S3 `static/`
- Invalidates the CloudFront cache

## Trade watcher

`scripts/watch-trades.mjs` polls ESPN for trade activity, posts new events to
Discord, and updates `static/data/trades.json` for the
[trade log](https://derbruden.com/trades.html).

### GitHub Action (production)

`.github/workflows/trade-watcher.yml` runs every 10 minutes on `master`.
On a new trade it posts to Discord, commits the ledger and dedupe state
under `static/data/`, publishes `trades.json` to S3, and invalidates that
single CloudFront path. Idle runs change nothing.

Repo secrets: `ESPN_S2`, `SWID`, `DISCORD_WEBHOOK_TRADES`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.

Notes:

- Free on this public repo. GitHub may delay scheduled runs a few minutes.
- GitHub disables schedules after 60 days without a commit; re-enable the
  workflow when that email arrives each offseason.
- Run it manually from Actions ("Trade watcher" > "Run workflow") or with
  `gh workflow run trade-watcher.yml`.
- Season year derives from the month: Aug-Dec is the current calendar year,
  Jan-Jul the prior one.

### Local runs

```sh
cp .env.example .env  # fill in ESPN_S2, SWID, DISCORD_WEBHOOK_URL
node scripts/watch-trades.mjs --dry-run
```

Local cron alternative (skips the S3 publish; ledger updates land on the
next deploy):

```txt
*/10 9-23 * * * cd /path/to/derbruden && node scripts/watch-trades.mjs >> data/watch.log 2>&1
```

Flags:

- `--dry-run`: print what would be posted. No writes, no Discord.
- `--backfill N`: seed the ledger with the last N trades. No notifications.

Notification rules: accepted trades post to Discord. Proposed trades appear
on the web page only. Declines and vetoes are ignored unless
`NOTIFY_DECLINED=true`, which lists them on the page too (never Discord).

ESPN auth: trade data needs `ESPN_S2` and `SWID` copied from the same
signed-in browser session (DevTools > Application > Cookies).
`ESPN_S2` alone only reads basic league data.

Tests: `node --test scripts/watch-trades.test.mjs`.

## Ideas

Set up trade activity notifications. Poll the following endpoint with headers via new API SDK:

```txt
https://fantasy.espn.com/apis/v3/games/ffl/seasons/2021/segments/0/leagues/794521/communication/

X-Fantasy-Filter: {"topics":{"filterType":{"value":["ACTIVITY_TRANSACTIONS"]},"limit":25,"limitPerMessageSet":{"value":25},"offset":0,"sortMessageDate":{"sortPriority":1,"sortAsc":false},"sortFor":{"sortPriority":2,"sortAsc":false},"filterDateRange":{"value":1625439600000,"additionalValue":1628809199999},"filterExcludeMessageTypeIds":{"value":[106,202,232,184,183,229,228,227,230,231,188]}}}~]
```
