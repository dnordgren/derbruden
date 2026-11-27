terraform {
  backend "s3" {
    bucket       = "derbruden-terraform-state"
    key          = "bootstrap/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
