# derbruden

## Develop

The site is build with [Gatsby](https://www.gatsbyjs.com/docs/quick-start/).

Run the following command to build the static front-end website locally:

```
$ gatsby develop
```

The site is served at <http://localhost:8000>. The GraphQL endpoint is at <http://localhost:8000/___graphql>.

If you'd like to build and host the production site locally, run:

```
$ gatsby build && gatsby serve
```

The site is served at <http://localhost:9000>.

## Deploy

The site is hosted on Amazon S3 and deployed via [Gatsby's tooling](https://www.gatsbyjs.com/docs/deploying-to-s3-cloudfront/). *Still TODO: Set up CloudFront*.

In order to deploy, run the command:

```
$ yarn run deploy
```

This uses the `aws` CLI. If you have multiple profiles set up in your credentials, you can declare the correct credentials like:

```
$ AWS_PROFILE=yourprofilename yarn run deploy
```
