# derbruden

Strange dreams lately? DerBruden.com 🛸

## Develop

### Install tools

- `cwebp` for image optimization

macOS:

```sh
brew install cwebp
```

### Generate stats

#### Owners table index

```sh
cd scripts/
nvm use
npm install
node generate-stats.js owners index # produces scripts/owners-index.html
```

#### Individual owners table

Generate single owner:

```sh
# .. same directory as above
node generate-stats.js owners {owner} # like DN, produces scripts/owners-{owner}.html
```

Generate all owners:

```sh
# .. same directory as above
node generate-stats.js owners all # produces all scripts/owners-{owner}.html
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

### Deploy

``` sh
AWS_PROFILE=derbruden make deploy
```

This:

- Clears S3 bucket of prior `*.html` and images in `static/`
- Syncs `*.html` from `src/` to S3 root to host site
- Syncs `static/` to S3 `static/`
- Invalidates the CloudFront cache

## Ideas

Set up trade activity notifications. Poll the following endpoint with headers via new API SDK:

```txt
https://fantasy.espn.com/apis/v3/games/ffl/seasons/2021/segments/0/leagues/794521/communication/

X-Fantasy-Filter: {"topics":{"filterType":{"value":["ACTIVITY_TRANSACTIONS"]},"limit":25,"limitPerMessageSet":{"value":25},"offset":0,"sortMessageDate":{"sortPriority":1,"sortAsc":false},"sortFor":{"sortPriority":2,"sortAsc":false},"filterDateRange":{"value":1625439600000,"additionalValue":1628809199999},"filterExcludeMessageTypeIds":{"value":[106,202,232,184,183,229,228,227,230,231,188]}}}~]
```
