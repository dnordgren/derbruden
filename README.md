# derbruden

Strange dreams lately? DerBruden.com 🛸

## Develop

### Install tools

- `cwebp` for image optimization (macOS: `brew install cwebp`)
- `node` (version >= 18)

### Local Development

Install dependencies and start the local development server:

```sh
npm install
npm run serve
```
This will start a hot-reloading server at `http://localhost:8080`.

### Stats Data

The site data is driven by `scripts/stats.csv`. To update the stats on the site:

1. Update `scripts/stats.csv` with the latest data.
2. The site will automatically rebuild if you are running `npm run serve`.
3. Otherwise, run `npm run build` to generate the static files in `_site/`.

**CSV Format:**
```csv
Season,Owner,W,L,%,RGPF,RGPA,TPF,DIFF,PO?,RGRnk,Champ,PORnk
24,ZS,9,4,0.692,1553,1365,1942.1,10.2,Y,3,N,5
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

This will:
1. Run `npm install` and `npm run build` to generate the static site in `_site/`.
2. Sync `_site/*.html` to the S3 bucket root.
3. Sync `static/` assets to S3.
4. Invalidate the CloudFront cache.

## Ideas

Set up trade activity notifications. Poll the following endpoint with headers via new API SDK:

```txt
https://fantasy.espn.com/apis/v3/games/ffl/seasons/2021/segments/0/leagues/794521/communication/

X-Fantasy-Filter: {"topics":{"filterType":{"value":["ACTIVITY_TRANSACTIONS"]},"limit":25,"limitPerMessageSet":{"value":25},"offset":0,"sortMessageDate":{"sortPriority":1,"sortAsc":false},"sortFor":{"sortPriority":2,"sortAsc":false},"filterDateRange":{"value":1625439600000,"additionalValue":1628809199999},"filterExcludeMessageTypeIds":{"value":[106,202,232,184,183,229,228,227,230,231,188]}}}~]
```
