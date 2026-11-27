# Deploy IAM user used locally (AWS_PROFILE=derbruden-deploy) and in GitHub Actions.
# Access keys are intentionally NOT managed in Terraform so existing deploy secrets
# stay undisturbed and never enter Terraform state.

resource "aws_iam_user" "deploy" {
  name = "derbruden-deploy"
  path = "/"
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid    = "DerBrudenS3BucketAccess"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:DeleteObject",
      "s3:ListBucket",
    ]
    resources = [
      "${aws_s3_bucket.site.arn}/*",
      aws_s3_bucket.site.arn,
    ]
  }

  statement {
    sid    = "CloudFrontInvalidation"
    effect = "Allow"
    actions = [
      "cloudfront:CreateInvalidation",
      "cloudfront:GetInvalidation",
    ]
    resources = [
      "arn:aws:cloudfront::*:distribution/${aws_cloudfront_distribution.site.id}",
    ]
  }

  # Read-only access to the analytics logs bucket for `make logs`.
  statement {
    sid    = "DerBrudenLogsReadAccess"
    effect = "Allow"
    actions = [
      "s3:ListBucket",
      "s3:GetObject",
    ]
    resources = [
      aws_s3_bucket.logs.arn,
      "${aws_s3_bucket.logs.arn}/*",
    ]
  }
}

resource "aws_iam_policy" "deploy" {
  name        = "derbruden-deploy"
  path        = "/"
  description = "Push files to derbruden.com bucket for static site + invalidate CloudFront distribution."
  policy      = data.aws_iam_policy_document.deploy.json
}

resource "aws_iam_user_policy_attachment" "deploy" {
  user       = aws_iam_user.deploy.name
  policy_arn = aws_iam_policy.deploy.arn
}
