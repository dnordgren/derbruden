data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

# Existing 2021 Lambda@Edge (nodejs14.x, deprecated runtime) that rewrites directory
# requests to index.html. Referenced read-only here so we don't attempt to manage an
# EOL runtime in Terraform; candidate to replace with a CloudFront Function later.
data "aws_lambda_function" "origin_mutation" {
  function_name = "originMutation"
  qualifier     = "1"
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  http_version        = "http2"
  price_class         = "PriceClass_100"

  aliases = [
    var.domain_name,
    "www.${var.domain_name}",
  ]

  origin {
    domain_name         = aws_s3_bucket.site.bucket_regional_domain_name
    origin_id           = aws_s3_bucket.site.bucket_regional_domain_name
    connection_attempts = 3
    connection_timeout  = 10
  }

  default_cache_behavior {
    target_origin_id       = aws_s3_bucket.site.bucket_regional_domain_name
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.caching_optimized.id

    lambda_function_association {
      event_type   = "origin-request"
      include_body = false
      lambda_arn   = data.aws_lambda_function.origin_mutation.qualified_arn
    }
  }

  # Existing legacy v1 logging to shared logs.dereknordgren.com bucket.
  # Keeping include_cookies = true also enables the distribution-wide IncludeCookies
  # switch required by CloudFront Standard Logging v2 (analytics.tf) so cs(Cookie)
  # carries the first-party db_cid cookie.
  logging_config {
    bucket          = var.legacy_logs_bucket_domain
    include_cookies = true
    prefix          = var.legacy_logs_prefix
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate.site.arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}
