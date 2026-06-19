resource "aws_cognito_user_pool" "main" {
  name = "oldforest-users"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length    = 12
    require_uppercase = true
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false
  }

  # Enable WebAuthn / passkey support
  web_authn_configuration {
    relying_party_id  = var.domain_name   # "oldforest.net"
    user_verification = "preferred"       # prompt for passkey but don't require it
  }
}

resource "aws_cognito_user_group" "members" {
  name         = "members"
  user_pool_id = aws_cognito_user_pool.main.id
}

resource "aws_cognito_user_group" "editors" {
  name         = "editors"
  user_pool_id = aws_cognito_user_pool.main.id
}

resource "aws_cognito_user_group" "admins" {
  name         = "admins"
  user_pool_id = aws_cognito_user_pool.main.id
}

resource "aws_cognito_user_pool_client" "main" {
  name         = "oldforest-web"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret = false

  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_AUTH",   # required for passkey sign-in
  ]

  supported_identity_providers = ["COGNITO"]

  callback_urls = [
    "https://${var.domain_name}/editor/index.html",
    "https://${var.domain_name}/index.html",
    "https://${var.domain_name}/admin/index.html",
    "https://${var.domain_name}/apps.html",
    "https://${var.domain_name}/apps/reading-log/",
  ]

  logout_urls = [
    "https://${var.domain_name}/editor/index.html",
    "https://${var.domain_name}/index.html",
    "https://${var.domain_name}/admin/index.html",
    "https://${var.domain_name}/apps.html",
    "https://${var.domain_name}/apps/reading-log/",
  ]

  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile", "aws.cognito.signin.user.admin"]
  allowed_oauth_flows_user_pool_client = true

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  access_token_validity  = 24   # 24 hours (Cognito max)
  id_token_validity      = 24   # keep in sync with access token
  refresh_token_validity = 30   # 30 days (unchanged)
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = "auth-${data.aws_caller_identity.current.account_id}"
  user_pool_id = aws_cognito_user_pool.main.id
  # Note: Managed Login v2 (required for passkeys) must be activated via CLI after apply.
  # See TERRAFORM_MIGRATION.md for the two commands needed.
}
