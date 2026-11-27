variable "aws_region" {
  description = "AWS region for all resources (CloudFront, ACM, and CloudWatch Log Delivery v2 require us-east-1)."
  type        = string
  default     = "us-east-1"
}

variable "domain_name" {
  description = "Primary domain name and S3 site bucket name."
  type        = string
  default     = "derbruden.com"
}

variable "logs_bucket_name" {
  description = "Private S3 bucket for CloudFront Standard Logging v2 (JSON analytics logs)."
  type        = string
  default     = "derbruden-logs"
}

variable "logs_retention_days" {
  description = "Number of days to retain CloudFront analytics access logs before automatic expiration."
  type        = number
  default     = 90
}

variable "legacy_logs_bucket_domain" {
  description = "Existing shared S3 bucket domain receiving CloudFront legacy v1 access logs."
  type        = string
  default     = "logs.dereknordgren.com.s3.amazonaws.com"
}

variable "legacy_logs_prefix" {
  description = "Prefix inside the legacy logs bucket for derbruden.com CloudFront logs."
  type        = string
  default     = "derbruden.com/cloudfront"
}

variable "github_repo" {
  description = "GitHub repository (owner/name) permitted to assume the Terraform CI IAM role via OIDC."
  type        = string
  default     = "dnordgren/derbruden"
}
