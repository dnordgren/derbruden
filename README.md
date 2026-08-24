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

Setup:

```sh
cp .env.example .env  # fill in ESPN_S2, SWID, DISCORD_WEBHOOK_URL
node scripts/watch-trades.mjs --dry-run
```

Run it on a schedule (crontab example):

```txt
*/10 9-23 * * * cd /path/to/derbruden && node scripts/watch-trades.mjs >> data/watch.log 2>&1
```

Flags:

- `--dry-run`: print what would be posted. No writes, no Discord.
- `--backfill N`: seed the ledger with the last N trades. No notifications.

ESPN auth: trade data needs `ESPN_S2` and `SWID` copied from the same
signed-in browser session (DevTools > Application > Cookies on
fantasy.espn.com). `ESPN_S2` alone only reads basic league data.

Tests: `node --test scripts/watch-trades.test.mjs`.

## Ideas

Set up trade activity notifications. Poll the following endpoint with headers via new API SDK:

```txt
https://fantasy.espn.com/apis/v3/games/ffl/seasons/2021/segments/0/leagues/794521/communication/

X-Fantasy-Filter: {"topics":{"filterType":{"value":["ACTIVITY_TRANSACTIONS"]},"limit":25,"limitPerMessageSet":{"value":25},"offset":0,"sortMessageDate":{"sortPriority":1,"sortAsc":false},"sortFor":{"sortPriority":2,"sortAsc":false},"filterDateRange":{"value":1625439600000,"additionalValue":1628809199999},"filterExcludeMessageTypeIds":{"value":[106,202,232,184,183,229,228,227,230,231,188]}}}~]
```
