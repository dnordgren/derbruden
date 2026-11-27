# First-party analytics via CloudFront Standard Logging v2 (gzipped NDJSON to S3).
# See README.md "Analytics" and scripts/analytics.mjs.
#
# Cookie logging (IncludeCookies) is a distribution-wide switch; it is already
# enabled on aws_cloudfront_distribution.site.logging_config so cs(Cookie)
# delivers the first-party db_cid cookie here as well.

resource "aws_s3_bucket" "logs" {
  bucket = var.logs_bucket_name

  tags = {
    Project   = "derbruden"
    ManagedBy = "terraform"
    Purpose   = "cloudfront-analytics-logs-v2"
  }
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket = aws_s3_bucket.logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    id     = "expire-cloudfront-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = var.logs_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_cloudwatch_log_delivery_source" "cloudfront" {
  name         = "derbruden-cloudfront-access-logs"
  log_type     = "ACCESS_LOGS"
  resource_arn = aws_cloudfront_distribution.site.arn
}

data "aws_iam_policy_document" "logs_bucket" {
  statement {
    sid     = "AWSLogDeliveryWrite"
    effect  = "Allow"
    actions = ["s3:PutObject"]

    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }

    resources = ["${aws_s3_bucket.logs.arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/CloudFront/*"]

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_log_delivery_source.cloudfront.arn]
    }
  }

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    resources = [
      aws_s3_bucket.logs.arn,
      "${aws_s3_bucket.logs.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "logs" {
  bucket = aws_s3_bucket.logs.id
  policy = data.aws_iam_policy_document.logs_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.logs]
}

resource "aws_cloudwatch_log_delivery_destination" "s3" {
  name          = "derbruden-cloudfront-s3-json"
  output_format = "json"

  delivery_destination_configuration {
    destination_resource_arn = aws_s3_bucket.logs.arn
  }

  depends_on = [aws_s3_bucket_policy.logs]
}

resource "aws_cloudwatch_log_delivery" "cloudfront_to_s3" {
  delivery_source_name     = aws_cloudwatch_log_delivery_source.cloudfront.name
  delivery_destination_arn = aws_cloudwatch_log_delivery_destination.s3.arn

  # Explicit field selection matching scripts/analytics.mjs (including cs(Cookie)).
  record_fields = [
    "date",
    "time",
    "x-edge-location",
    "sc-bytes",
    "c-ip",
    "cs-method",
    "cs(Host)",
    "cs-uri-stem",
    "sc-status",
    "cs(Referer)",
    "cs(User-Agent)",
    "cs-uri-query",
    "cs(Cookie)",
    "x-edge-result-type",
    "x-edge-request-id",
    "cs-protocol",
    "time-taken",
    "x-edge-response-result-type",
  ]

  depends_on = [aws_s3_bucket_policy.logs]
}
