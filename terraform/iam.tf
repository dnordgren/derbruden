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

# ---------------------------------------------------------------------------
# GitHub Actions OIDC for Terraform CI (PR plan/apply & Actions UI)
# ---------------------------------------------------------------------------

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "github_terraform_assume" {
  statement {
    sid     = "GitHubActionsOIDC"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:*"]
    }
  }
}

# Single role used by Terraform plan & apply in GitHub Actions.
# AdministratorAccess matches the local admin profile because Terraform manages
# IAM itself (this file) plus arbitrary AWS services for the site.
resource "aws_iam_role" "github_terraform" {
  name                 = "derbruden-terraform-ci"
  description          = "Assumed via OIDC by GitHub Actions in ${var.github_repo} to run Terraform plan/apply."
  assume_role_policy   = data.aws_iam_policy_document.github_terraform_assume.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "github_terraform_admin" {
  role       = aws_iam_role.github_terraform.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}
