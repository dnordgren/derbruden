# derbruden

## Develop

The site is build with [Gatsby](https://www.gatsbyjs.com/docs/quick-start/).

```cli
npm i -g gatsby-cli
```

Run the following command to build the static front-end website locally:

```cli
gatsby develop
```

The site is served at <http://localhost:8000>. The GraphQL endpoint is at <http://localhost:8000/___graphql>.

If you'd like to build and host the production site locally, run:

```cli
gatsby build && gatsby serve
```

The site is served at <http://localhost:9000>.

## Deploy

The site is hosted on Amazon S3 and deployed via [Gatsby's tooling](https://www.gatsbyjs.com/docs/deploying-to-s3-cloudfront/). _Still TODO: Set up CloudFront_.

In order to deploy, run the command:

```cli
yarn run deploy
```

This uses the `aws` CLI. If you have multiple profiles set up in your credentials, you can declare the correct credentials like:

```cli
AWS_PROFILE=yourprofilename yarn run deploy
```

## Run ESPN Fantasy Bot

### Current - Docker container running on EC2

- Pull image (requires AWS credentials)
```sh
$ docker login -u AWS -p $(aws ecr get-login-password --region us-east-1) 354450307824.dkr.ecr.us-east-1.amazonaws.com
$ docker pull 354450307824.dkr.ecr.us-east-1.amazonaws.com/fantasy_football_chat_bot:latest
```

- Run container
```sh
docker container run -it --name=discord_bot --env-file fantasy-chatbot-env.txt 354450307824.dkr.ecr.us-east-1.amazonaws.com/fantasy_football_chat_bot:latest # env file stored on EC2 instance
```

### Previous - ECS on Fargate

Was running on ECS/Fargate. Was a bit cost-prohibitive so moved to EC2 instance since it doesn't need to scale. Could just restart task from ECR image if desired.

## Ideas

Set up trade activity notifications. Poll the following endpoint with headers via new API SDK:

```txt
https://fantasy.espn.com/apis/v3/games/ffl/seasons/2021/segments/0/leagues/794521/communication/

X-Fantasy-Filter: {"topics":{"filterType":{"value":["ACTIVITY_TRANSACTIONS"]},"limit":25,"limitPerMessageSet":{"value":25},"offset":0,"sortMessageDate":{"sortPriority":1,"sortAsc":false},"sortFor":{"sortPriority":2,"sortAsc":false},"filterDateRange":{"value":1625439600000,"additionalValue":1628809199999},"filterExcludeMessageTypeIds":{"value":[106,202,232,184,183,229,228,227,230,231,188]}}}~]
```
