terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.61"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }

  backend "s3" {
    bucket       = "oldforest-net-tfstate-165395066552"
    key          = "oldforest/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.aws_region
}


data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# ── SSM Parameter: LibraryThing API key ───────────────────────────────────────
# The parameter value is managed outside Terraform (set manually after first apply):
#   aws ssm put-parameter --name /oldforest/lt_api_key \
#     --value "<key>" --type SecureString --overwrite
# After rotating the key at LibraryThing, update SSM and redeploy the Lambda.
resource "aws_ssm_parameter" "lt_api_key" {
  name  = "/oldforest/lt_api_key"
  type  = "SecureString"
  value = "PLACEHOLDER"   # replaced manually — see comment above
  lifecycle { ignore_changes = [value] }
}

data "aws_ssm_parameter" "lt_api_key" {
  name            = "/oldforest/lt_api_key"
  with_decryption = true
  depends_on      = [aws_ssm_parameter.lt_api_key]
}
