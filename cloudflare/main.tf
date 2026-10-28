# The Cloudflare resources the deploy-cloudflare workflow deploys onto: the KV
# namespace and the R2 bucket the Worker binds, and a deploy token that can
# change Workers on this account and nothing else.
#
# Run it with an account token that can create tokens, KV namespaces and R2
# buckets. The state holds the deploy token, so it lives outside the repo:
#   terraform -chdir=cloudflare init -backend-config="path=$HOME/.your-attention/cloudflare.tfstate"
#   terraform -chdir=cloudflare apply -var account_id=<id>
terraform {
  backend "local" {}
}

variable "account_id" {
  type        = string
  description = "The Cloudflare account that runs the inbox."
}

provider "cloudflare" {}

resource "cloudflare_workers_kv_namespace" "invites" {
  account_id = var.account_id
  title      = "your-attention-invites"
}

resource "cloudflare_r2_bucket" "files" {
  account_id = var.account_id
  name       = "your-attention-files"
}

# R2 deletes each attached file 30 days after its upload. The card stays, and its file link answers 410.
resource "cloudflare_r2_bucket_lifecycle" "files" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.files.name
  rules = [{
    id                        = "delete-after-30-days"
    enabled                   = true
    conditions                = { prefix = "" }
    delete_objects_transition = { condition = { type = "Age", max_age = 30 * 24 * 60 * 60 } }
  }]
}

data "cloudflare_account_api_token_permission_groups_list" "scripts_write" {
  account_id = var.account_id
  name       = "Workers Scripts Write"
}

data "cloudflare_account_api_token_permission_groups_list" "settings_read" {
  account_id = var.account_id
  name       = "Account Settings Read"
}

# Deploying uploads the Worker, its Durable Object migrations and its secrets, which Workers Scripts Write covers.
# Wrangler reads the account to check it, which needs Account Settings Read.
resource "cloudflare_account_token" "deploy" {
  account_id = var.account_id
  name       = "your-attention deploy"
  policies = [{
    effect = "allow"
    permission_groups = [
      { id = one(data.cloudflare_account_api_token_permission_groups_list.scripts_write.result).id },
      { id = one(data.cloudflare_account_api_token_permission_groups_list.settings_read.result).id },
    ]
    resources = jsonencode({ "com.cloudflare.api.account.${var.account_id}" = "*" })
  }]
}

output "kv_namespace_id" {
  value = cloudflare_workers_kv_namespace.invites.id
}

output "deploy_token" {
  value     = cloudflare_account_token.deploy.value
  sensitive = true
}
