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
  ]

  supported_identity_providers = ["COGNITO"]

  callback_urls = [
    "https://${var.domain_name}/editor/index.html",
    "https://${var.domain_name}/index.html",
    "https://${var.domain_name}/admin/index.html",
    "https://${var.domain_name}/apps.html",
  ]

  logout_urls = [
    "https://${var.domain_name}/editor/index.html",
    "https://${var.domain_name}/index.html",
    "https://${var.domain_name}/admin/index.html",
    "https://${var.domain_name}/apps.html",
  ]

  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile", "aws.cognito.signin.user.admin"]
  allowed_oauth_flows_user_pool_client = true
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = "auth-${data.aws_caller_identity.current.account_id}"
  user_pool_id = aws_cognito_user_pool.main.id
}
