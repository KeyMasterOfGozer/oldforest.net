resource "aws_cognito_user_pool" "main" {
  name = "oldforest-users"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length    = 12
    require_uppercase = true
    require_lowercase = true
    require_numbers   = true
    require_symbols   = true
  }

  # Enable WebAuthn / passkey support
  web_authn_configuration {
    relying_party_id  = var.domain_name   # "oldforest.net"
    user_verification = "required"        # biometric/PIN required for passkey sign-in
  }

  # Optional TOTP MFA — a free fallback second factor for users signing in with a
  # password instead of a passkey. Not enforced: passkey sign-in already provides
  # phishing-resistant possession+biometric auth for users who enroll one.
  mfa_configuration = "OPTIONAL"

  software_token_mfa_configuration {
    enabled = true
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
    "https://${var.domain_name}/books/",
  ]

  logout_urls = [
    "https://${var.domain_name}/editor/index.html",
    "https://${var.domain_name}/index.html",
    "https://${var.domain_name}/admin/index.html",
    "https://${var.domain_name}/apps.html",
    "https://${var.domain_name}/apps/reading-log/",
    "https://${var.domain_name}/books/",
  ]

  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile", "aws.cognito.signin.user.admin"]
  allowed_oauth_flows_user_pool_client = true

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  access_token_validity  = 1    # 1 hour — silent refresh via refresh token
  id_token_validity      = 1    # keep in sync with access token
  refresh_token_validity = 7    # 7 days — shrinks the exfiltration window for a stolen refresh token
}

# ── Desktop app client (Calibre plugin) ───────────────────────────────────────
# Deliberately separate from the web client above: the plugin needs loopback
# (http://localhost) callback URLs, and registering those on the browser client
# would widen its redirect surface for no reason. Public client — it ships on
# user machines, so it can't hold a secret; PKCE is what protects the exchange.
resource "aws_cognito_user_pool_client" "calibre_plugin" {
  name         = "oldforest-calibre-plugin"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret = false

  explicit_auth_flows = [
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_USER_AUTH", # passkey sign-in, same as the web client
  ]

  supported_identity_providers = ["COGNITO"]

  # RFC 8252 loopback redirect. Cognito matches redirect_uri exactly, so every
  # port the plugin might bind has to be pre-registered — three are listed so
  # sign-in still works when one is already in use. http://localhost is the one
  # documented exception to Cognito's HTTPS-only callback rule.
  callback_urls = [
    "http://localhost:8788/callback",
    "http://localhost:8789/callback",
    "http://localhost:8790/callback",
  ]

  logout_urls = [
    "http://localhost:8788/callback",
    "http://localhost:8789/callback",
    "http://localhost:8790/callback",
  ]

  allowed_oauth_flows = ["code"] # authorization code + PKCE only, no implicit
  # Narrower than the web client: the plugin only calls our own API, so it never
  # needs aws.cognito.signin.user.admin (that scope exists for Cognito's own
  # self-service user APIs, which the plugin doesn't touch).
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  allowed_oauth_flows_user_pool_client = true

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 7 # matches the web client
}

# ⚠ Managed Login v2 serves sign-in pages *per app client* and answers
# "Login pages unavailable" for any client with no branding record. A new client
# is therefore unusable until branding is created for it. The AWS provider still
# has no resource for this as of 5.100.0, so it is a one-time CLI step — see
# TERRAFORM_MIGRATION.md §9, which now covers this client as well as the web one.

resource "aws_cognito_user_pool_domain" "main" {
  domain       = "auth-${data.aws_caller_identity.current.account_id}"
  user_pool_id = aws_cognito_user_pool.main.id
  # Note: Managed Login v2 (required for passkeys) must be activated via CLI after apply.
  # See TERRAFORM_MIGRATION.md for the two commands needed.
}
