# Docker container - `fantasy_football_chat_bot`

## Push to ECR

Get login:

```cli
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 354450307824.dkr.ecr.us-east-1.amazonaws.com
```

Tag the image:

```cli
docker images
docker tag <image-id> docker tag e6c6bc7f2fea 354450307824.dkr.ecr.us-east-1.amazonaws.com/fantasy_football_chat_bot:<version>
```

Push to ECR:

```cli
docker push 354450307824.dkr.ecr.us-east-1.amazonaws.com/fantasy_football_chat_bot:latest
```

## Configuration

See <https://github.com/dtcarls/fantasy_football_chat_bot>. Currently running from [ECR container](354450307824.dkr.ecr.us-east-1.amazonaws.com/fantasy_football_chat_bot) in Fargate ECS.

START_DATE 2021-08-28
END_DATE 2021-12-30
LEAGUE_YEAR 2021
DISCORD_WEBHOOK_URL `from Discord`
LEAGUE_ID 794521
INIT_MSG "hi fella"
ESPN_S2 `ESPN cookie`
SWID `ESPN cookie`
