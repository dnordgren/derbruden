# derbruden

## Current Issues

I'm unable to build on M1 macOS.

- <https://github.com/gatsbyjs/gatsby/discussions/29854>
- <https://github.com/lovell/sharp/issues/2460#issuecomment-809499444>

I think I need to upgrade to Gatsby v4, and then upgrade *-sharp Gatsby packages.

Without this, I can't run `gatsby build` before deploying (on M1 macOS). Windows XPS is also being a little shit presently for some reason.

## Develop

It's recommended to use the [Node Version Manager](https://github.com/nvm-sh/nvm) (`nvm`) to manage your Node.js and NPM version:

```sh
nvm use
```

The site is build with [Gatsby](https://www.gatsbyjs.com/docs/quick-start/).

```sh
npm i -g gatsby-cli@2.19.3
```

Run the following command to build the static front-end website locally:

```sh
gatsby develop
```

The site is served at <http://localhost:8000>. The GraphQL endpoint is at <http://localhost:8000/___graphql>.

If you'd like to build and host the production site locally, run:

```sh
gatsby build && gatsby serve
```

The site is served at <http://localhost:9000>.

## Deploy

The site is hosted on Amazon S3 and deployed via [Gatsby's tooling](https://www.gatsbyjs.com/docs/deploying-to-s3-cloudfront/). _Still TODO: Set up CloudFront_.

In order to deploy, run the command:

```sh
yarn run deploy
```

This uses the `aws` CLI. If you have multiple profiles set up in your credentials, you can declare the correct credentials like:

```sh
AWS_PROFILE=yourprofilename yarn run deploy
```

## Ideas

Set up trade activity notifications. Poll the following endpoint with headers via new API SDK:

```txt
https://fantasy.espn.com/apis/v3/games/ffl/seasons/2021/segments/0/leagues/794521/communication/

X-Fantasy-Filter: {"topics":{"filterType":{"value":["ACTIVITY_TRANSACTIONS"]},"limit":25,"limitPerMessageSet":{"value":25},"offset":0,"sortMessageDate":{"sortPriority":1,"sortAsc":false},"sortFor":{"sortPriority":2,"sortAsc":false},"filterDateRange":{"value":1625439600000,"additionalValue":1628809199999},"filterExcludeMessageTypeIds":{"value":[106,202,232,184,183,229,228,227,230,231,188]}}}~]
```

## TODO

- Update vulnerabilities

```sh
npm audit
npm audit fix --force
```
