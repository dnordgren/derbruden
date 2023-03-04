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

ESPN_S2 AEAT9BWbrRk4eskk%2FAfHhWToJQB8cEILffJq1T3Lt%2BJYCxrOoibrrXrZpbMTCUCxmUVgjRDKCeexlnZEKk2NUw28K5QAbfpipAEIHkfJ1bOcsYLbg%2Bs3MtiZz5XLi0iV42EhYo94EVQZWLiTxtt3yB2%2BjW0MVxSvtzod4uX%2F4Vttb4Flr38lVfkAmGegtmD05WSNj%2FHNSKjkO29sDlvLNaZNBUwKW%2BIEpzo3rHYXvZphu3e9eD0H%2Bgpk7L8ZTNw0cQIem6T5oS74tBhH%2FuoExVFJYyt0DUg09kkSR8PZB8eXuA%3D%3D

SWID {5C2D9689-2028-4E3B-94C9-D30D06FDC27D}
