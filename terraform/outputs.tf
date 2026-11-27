output "site_bucket_name" {
  description = "Primary S3 bucket hosting DerBruden.com."
  value       = aws_s3_bucket.site.bucket
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID (matches DISTRIBUTION_ID in Makefile)."
  value       = aws_cloudfront_distribution.site.id
}

output "cloudfront_domain_name" {
  description = "CloudFront distribution domain name."
  value       = aws_cloudfront_distribution.site.domain_name
}

output "route53_zone_id" {
  description = "Route 53 hosted zone ID for derbruden.com."
  value       = aws_route53_zone.site.zone_id
}

output "acm_certificate_arn" {
  description = "Active ACM TLS certificate ARN for derbruden.com and www.derbruden.com."
  value       = aws_acm_certificate.site.arn
}

output "logs_bucket_name" {
  description = "Private S3 bucket storing CloudFront Standard Logging v2 JSON logs."
  value       = aws_s3_bucket.logs.bucket
}

output "logs_sync_uri" {
  description = "S3 URI to pass as CLOUDFRONT_LOG_BUCKET to `make logs`."
  value       = "s3://${aws_s3_bucket.logs.bucket}/AWSLogs/${data.aws_caller_identity.current.account_id}/CloudFront/"
}

output "deploy_user_arn" {
  description = "ARN of the derbruden-deploy IAM user."
  value       = aws_iam_user.deploy.arn
}

output "github_terraform_role_arn" {
  description = "IAM role ARN to store in the AWS_TERRAFORM_ROLE_ARN GitHub Actions repository variable."
  value       = aws_iam_role.github_terraform.arn
}
