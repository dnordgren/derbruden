# DerBruden.com Terraform Infrastructure

Defines all AWS infrastructure for **DerBruden.com** (account `354450307824`, region `us-east-1`):

- **S3** (`s3.tf`): Primary static site bucket (`derbruden.com`) and legacy redirect bucket (`www.derbruden.com`).
- **CloudFront** (`cloudfront.tf`): Distribution `E3CDWEEK40CKI2` (`derbruden.com`, `www.derbruden.com`), AWS `Managed-CachingOptimized` cache policy, existing `originMutation:1` Lambda@Edge association, and existing legacy v1 logging config (which also keeps `IncludeCookies = true` enabled distribution-wide).
- **DNS & TLS** (`dns.tf`): Route 53 hosted zone (`Z067903716YSP4PCFII5B`), apex `A` alias, `www` `CNAME`, active ACM certificate (`derbruden.com` + `www.derbruden.com`), and DNS validation records.
- **Analytics** (`analytics.tf`): Private S3 log bucket (`derbruden-logs`, 90-day lifecycle expiration, public access blocked) and CloudFront Standard Logging v2 JSON delivery (`cs(Cookie)` included) for `scripts/analytics.mjs`.
- **IAM** (`iam.tf`): `derbruden-deploy` user and least-privilege policy covering site deploys, CloudFront invalidations, and read-only access to `derbruden-logs` for `make logs`. Access keys are intentionally left outside Terraform state.
- **Remote State** (`backend.tf` + `bootstrap/`): Self-hosted in S3 (`derbruden-terraform-state`) with **native S3 lockfiles** (`use_lockfile = true`, Terraform `>= 1.11`) — no DynamoDB table required.

## Prerequisites

- **Terraform CLI `>= 1.11`** (required for GA S3 native state locking).
- **Admin AWS credentials** (e.g., `AWS_PROFILE=derbruden-admin`). The `derbruden-deploy` IAM user only has S3 object writes and CloudFront invalidation permissions and cannot run Terraform.

## First-time setup (bootstrap + import existing infra)

### 1. Bootstrap the remote state bucket (one-time)

Creates the versioned, encrypted, private `derbruden-terraform-state` S3 bucket:

```sh
cd terraform/bootstrap
AWS_PROFILE=<admin-profile> terraform init
AWS_PROFILE=<admin-profile> terraform apply
```

### 2. Import existing AWS resources & provision Analytics v2 logging

`terraform/imports.tf` contains declarative `import {}` blocks for all 17 pre-existing AWS resources. Applying imports them cleanly into `s3://derbruden-terraform-state/prod/terraform.tfstate`, creates the new `derbruden-logs` bucket + CloudFront v2 JSON log delivery, and adds read-only log access to the `derbruden-deploy` IAM policy:

```sh
cd terraform
AWS_PROFILE=<admin-profile> terraform init
AWS_PROFILE=<admin-profile> terraform plan
```

Expected initial plan summary:

```text
Plan: 17 to import, 8 to add, 1 to change, 0 to destroy.
```

- **17 to import**: `derbruden.com` and `www.derbruden.com` S3 buckets/configs/policies, CloudFront `E3CDWEEK40CKI2`, Route 53 zone + 4 DNS records, active ACM cert, and `derbruden-deploy` IAM user/policy/attachment.
- **8 to add**: `derbruden-logs` S3 bucket (public access block, encryption, 90-day lifecycle, bucket policy) + CloudWatch Log Delivery source, S3 JSON destination, and delivery.
- **1 to change**: `aws_iam_policy.deploy` adds `DerBrudenLogsReadAccess` (`s3:ListBucket` + `s3:GetObject` on `derbruden-logs`).

Once the plan looks right:

```sh
AWS_PROFILE=<admin-profile> terraform apply
```

### 3. Clean up `imports.tf`

After `terraform apply` succeeds and writes the remote state file to S3, delete `terraform/imports.tf` and confirm zero drift:

```sh
rm terraform/imports.tf
AWS_PROFILE=<admin-profile> terraform plan
# Expected: No changes. Your infrastructure matches the configuration.
```

### 4. Pull analytics logs

After traffic flows through CloudFront (usually within a few minutes), pull and report on logs using the `logs_sync_uri` output:

```sh
make logs CLOUDFRONT_LOG_BUCKET="$(terraform -chdir=terraform output -raw logs_sync_uri)"
make analytics
```

## Notes from the AWS audit (optional future cleanups)

- **Legacy `originMutation:1` Lambda@Edge (`nodejs14.x`)**: Attached to `E3CDWEEK40CKI2` on `origin-request` to append `index.html` to directory paths. Because `nodejs14.x` is EOL, it is referenced read-only via `data.aws_lambda_function` rather than managed as a resource. Good future candidate to replace with a lightweight CloudFront Function.
- **Empty `www.derbruden.com` S3 bucket**: Tracked in `s3.tf`. Route 53 points `www.derbruden.com` via CNAME to `derbruden.com` (served directly by CloudFront), so this bucket receives no traffic and can be removed from `s3.tf` later if no longer needed.
- **Legacy v1 logging (`logs.dereknordgren.com`)**: `E3CDWEEK40CKI2` writes legacy TSV logs to the shared `logs.dereknordgren.com` bucket (not managed here because other sites share it). Keeping `logging_config` with `include_cookies = true` also preserves the distribution-wide `IncludeCookies` switch needed by v2 logging.
- **Orphaned account leftovers (not managed here)**:
  - Unused CloudFront Origin Access Identity `E1RJ5VZP47J071` (`access-identity-derbruden.com.s3.us-east-1.amazonaws.com`) — not attached to `E3CDWEEK40CKI2`.
  - Expired, unused ACM certificate `1a9b6e5f-be76-4382-8646-b7933dfaaf52` for `derbruden.com`.
  - Empty ECS cluster `fun-and-profit` (0 services; ECR is already empty).
