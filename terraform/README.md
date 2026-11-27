# DerBruden.com Terraform Infrastructure

Defines all AWS infrastructure for **DerBruden.com** (account `354450307824`, region `us-east-1`):

- **S3** (`s3.tf`): Primary static site bucket (`derbruden.com`) and legacy redirect bucket (`www.derbruden.com`).
- **CloudFront** (`cloudfront.tf`): Distribution `E3CDWEEK40CKI2` (`derbruden.com`, `www.derbruden.com`), AWS `Managed-CachingOptimized` cache policy, read-only reference to existing `originMutation:1` Lambda@Edge, and existing legacy v1 logging config (which keeps `IncludeCookies = true` enabled distribution-wide).
- **DNS & TLS** (`dns.tf`): Route 53 hosted zone (`Z067903716YSP4PCFII5B`), apex `A` alias, `www` `CNAME`, active ACM certificate (`derbruden.com` + `www.derbruden.com`), and DNS validation records.
- **Analytics** (`analytics.tf`): Private S3 log bucket (`derbruden-logs`, 90-day lifecycle expiration, public access blocked) and CloudFront Standard Logging v2 JSON delivery (`cs(Cookie)` included) for `scripts/analytics.mjs`.
- **IAM** (`iam.tf`): `derbruden-deploy` user and least-privilege policy covering site deploys, CloudFront invalidations, and read-only access to `derbruden-logs` for `make logs`. Access keys are intentionally left outside Terraform state.
- **Remote State** (`backend.tf`, `bootstrap/`): Self-hosted in `s3://derbruden-terraform-state` with **native S3 lockfiles** (`use_lockfile = true`, Terraform `>= 1.11`) — no DynamoDB table required.
  - Main stack state: `prod/terraform.tfstate`
  - Bootstrap state: `bootstrap/terraform.tfstate`

## Prerequisites

- **Terraform CLI `>= 1.11`** (required for GA S3 native state locking; validated with `1.17.2`).
- **Admin AWS credentials** (e.g., `AWS_PROFILE=<admin-profile>`). The `derbruden-deploy` IAM user only holds site S3 writes, CloudFront invalidations, and read-only access to `derbruden-logs` — it cannot run Terraform.

## Day-2 usage

```sh
cd terraform
AWS_PROFILE=<admin-profile> terraform init
AWS_PROFILE=<admin-profile> terraform plan
AWS_PROFILE=<admin-profile> terraform apply
```

## State bucket (`terraform/bootstrap/`)

`terraform/bootstrap/` manages the `derbruden-terraform-state` S3 bucket itself (versioning, SSE-AES256, public access block, 90-day noncurrent version lifecycle, TLS-only policy, `prevent_destroy = true`). It stores its own state in the same bucket under `bootstrap/terraform.tfstate`.

### One-time migration from local bootstrap state

If you bootstrapped `derbruden-terraform-state` locally before `bootstrap/backend.tf` existed, run once from the machine holding `terraform/bootstrap/terraform.tfstate`:

```sh
cd terraform/bootstrap
AWS_PROFILE=<admin-profile> terraform init -migrate-state
# Answer "yes" when prompted to copy existing state to S3.
AWS_PROFILE=<admin-profile> terraform plan   # Expect: No changes.
```

Once verified, you can delete the leftover local `terraform/bootstrap/terraform.tfstate*` backup files.

*(If ever bootstrapping from scratch in a brand-new AWS account, temporarily comment out `bootstrap/backend.tf`, run `terraform init && terraform apply`, then restore `backend.tf` and run `terraform init -migrate-state`.)*

## Analytics logs

CloudFront continuously delivers gzipped NDJSON logs to `derbruden-logs` (and S3 automatically expires them after 90 days). Pull and summarize anytime using the `derbruden` deploy profile:

```sh
AWS_PROFILE=derbruden make logs CLOUDFRONT_LOG_BUCKET=s3://derbruden-logs/AWSLogs/354450307824/CloudFront/
make analytics
```

## Follow-up cleanups

Optional cleanup candidates identified during the initial AWS audit (replacing EOL `originMutation:1` Lambda@Edge, retiring empty `www.derbruden.com`, reviewing legacy v1 logging, and account leftovers) are tracked in [issue #80](https://github.com/dnordgren/derbruden/issues/80).
