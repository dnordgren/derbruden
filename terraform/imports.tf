# Declarative import blocks for pre-existing AWS infrastructure.
# After running `terraform apply` to populate the remote S3 state file and
# verifying `terraform plan` reports no changes, this file can be deleted.

# --- S3: derbruden.com ---

import {
  to = aws_s3_bucket.site
  id = "derbruden.com"
}

import {
  to = aws_s3_bucket_public_access_block.site
  id = "derbruden.com"
}

import {
  to = aws_s3_bucket_website_configuration.site
  id = "derbruden.com"
}

import {
  to = aws_s3_bucket_policy.site
  id = "derbruden.com"
}

# --- S3: www.derbruden.com ---

import {
  to = aws_s3_bucket.www
  id = "www.derbruden.com"
}

import {
  to = aws_s3_bucket_public_access_block.www
  id = "www.derbruden.com"
}

import {
  to = aws_s3_bucket_website_configuration.www
  id = "www.derbruden.com"
}

# --- CloudFront ---

import {
  to = aws_cloudfront_distribution.site
  id = "E3CDWEEK40CKI2"
}

# --- Route 53 & ACM ---

import {
  to = aws_route53_zone.site
  id = "Z067903716YSP4PCFII5B"
}

import {
  to = aws_acm_certificate.site
  id = "arn:aws:acm:us-east-1:354450307824:certificate/93ad97eb-3113-4cda-8398-f5a9c04cb01d"
}

import {
  to = aws_route53_record.apex
  id = "Z067903716YSP4PCFII5B_derbruden.com_A"
}

import {
  to = aws_route53_record.www
  id = "Z067903716YSP4PCFII5B_www.derbruden.com_CNAME"
}

import {
  to = aws_route53_record.acm_validation["derbruden.com"]
  id = "Z067903716YSP4PCFII5B__03f5b80910bea2ded069863e96471b00.derbruden.com_CNAME"
}

import {
  to = aws_route53_record.acm_validation["www.derbruden.com"]
  id = "Z067903716YSP4PCFII5B__8262649c59fb4cf893e7ac43aae1af50.www.derbruden.com_CNAME"
}

# --- IAM ---

import {
  to = aws_iam_user.deploy
  id = "derbruden-deploy"
}

import {
  to = aws_iam_policy.deploy
  id = "arn:aws:iam::354450307824:policy/derbruden-deploy"
}

import {
  to = aws_iam_user_policy_attachment.deploy
  id = "derbruden-deploy/arn:aws:iam::354450307824:policy/derbruden-deploy"
}
