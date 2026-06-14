# ── HTTP API (v2) ─────────────────────────────────────────────────────────────
resource "aws_apigatewayv2_api" "main" {
  name          = "oldforest-api"
  protocol_type = "HTTP"
  description   = "oldforest.net blog API"

  cors_configuration {
    allow_origins = ["https://${var.domain_name}"]
    allow_headers = ["Authorization", "Content-Type"]
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
  }
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true
}

# ── JWT Authorizer (Cognito) ──────────────────────────────────────────────────
resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.main.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "CognitoAuthorizer"

  jwt_configuration {
    issuer   = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.main.id}"
    audience = [aws_cognito_user_pool_client.main.id]
  }
}

# ── Helper: grant API Gateway permission to invoke a Lambda ──────────────────
resource "aws_lambda_permission" "list_posts" {
  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.list_posts.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "get_post" {
  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.get_post.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "create_post" {
  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.create_post.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "update_post" {
  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.update_post.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "delete_post" {
  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.delete_post.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "profile" {
  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.profile.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "upload_url" {
  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.upload_url.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "admin_files" {
  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.admin_files.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "admin_users" {
  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.admin_users.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

# ── Integrations (Lambda proxy) ───────────────────────────────────────────────
resource "aws_apigatewayv2_integration" "list_posts" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.list_posts.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "get_post" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.get_post.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "create_post" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.create_post.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "update_post" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.update_post.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "delete_post" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.delete_post.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "profile" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.profile.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "upload_url" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.upload_url.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "admin_files" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.admin_files.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "admin_users" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.admin_users.invoke_arn
  payload_format_version = "2.0"
}

# ── Routes ────────────────────────────────────────────────────────────────────

# Public (no auth)
resource "aws_apigatewayv2_route" "get_posts" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /v1/posts"
  target    = "integrations/${aws_apigatewayv2_integration.list_posts.id}"
}

resource "aws_apigatewayv2_route" "get_post_public" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /v1/posts/{slug}"
  target    = "integrations/${aws_apigatewayv2_integration.get_post.id}"
}

# Authenticated routes
resource "aws_apigatewayv2_route" "get_posts_editor" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "GET /v1/editor/posts"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
  target             = "integrations/${aws_apigatewayv2_integration.list_posts.id}"
}

resource "aws_apigatewayv2_route" "get_post_members" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "GET /v1/posts/members/{slug}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
  target             = "integrations/${aws_apigatewayv2_integration.get_post.id}"
}

resource "aws_apigatewayv2_route" "create_post" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "POST /v1/editor/posts"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
  target             = "integrations/${aws_apigatewayv2_integration.create_post.id}"
}

resource "aws_apigatewayv2_route" "update_post" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "PUT /v1/editor/posts/{postId}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
  target             = "integrations/${aws_apigatewayv2_integration.update_post.id}"
}

resource "aws_apigatewayv2_route" "delete_post" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "DELETE /v1/editor/posts/{postId}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
  target             = "integrations/${aws_apigatewayv2_integration.delete_post.id}"
}

resource "aws_apigatewayv2_route" "get_profile" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "GET /v1/profile"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
  target             = "integrations/${aws_apigatewayv2_integration.profile.id}"
}

resource "aws_apigatewayv2_route" "update_profile" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "PUT /v1/profile"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
  target             = "integrations/${aws_apigatewayv2_integration.profile.id}"
}

resource "aws_apigatewayv2_route" "change_password" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "POST /v1/profile/password"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
  target             = "integrations/${aws_apigatewayv2_integration.profile.id}"
}

resource "aws_apigatewayv2_route" "upload_url" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "POST /v1/editor/upload"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
  target             = "integrations/${aws_apigatewayv2_integration.upload_url.id}"
}

resource "aws_apigatewayv2_route" "list_admin_files" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "GET /v1/admin/files"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
  target             = "integrations/${aws_apigatewayv2_integration.admin_files.id}"
}

resource "aws_apigatewayv2_route" "delete_admin_file" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "DELETE /v1/admin/files"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
  target             = "integrations/${aws_apigatewayv2_integration.admin_files.id}"
}

resource "aws_apigatewayv2_route" "list_admin_users" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "GET /v1/admin/users"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
  target             = "integrations/${aws_apigatewayv2_integration.admin_users.id}"
}

resource "aws_apigatewayv2_route" "create_admin_user" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "POST /v1/admin/users"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
  target             = "integrations/${aws_apigatewayv2_integration.admin_users.id}"
}

resource "aws_apigatewayv2_route" "update_admin_user" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "PUT /v1/admin/users/{username}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
  target             = "integrations/${aws_apigatewayv2_integration.admin_users.id}"
}

resource "aws_apigatewayv2_route" "delete_admin_user" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "DELETE /v1/admin/users/{username}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
  target             = "integrations/${aws_apigatewayv2_integration.admin_users.id}"
}

# ── Apps ──────────────────────────────────────────────────────────────────────

resource "aws_lambda_permission" "list_apps" {
  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.list_apps.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "admin_apps" {
  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.admin_apps.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

resource "aws_apigatewayv2_integration" "list_apps" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.list_apps.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "admin_apps" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.admin_apps.invoke_arn
  payload_format_version = "2.0"
}

# Public
resource "aws_apigatewayv2_route" "list_apps" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /v1/apps"
  target    = "integrations/${aws_apigatewayv2_integration.list_apps.id}"
}

# Admin CRUD
resource "aws_apigatewayv2_route" "list_admin_apps" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "GET /v1/admin/apps"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
  target             = "integrations/${aws_apigatewayv2_integration.admin_apps.id}"
}

resource "aws_apigatewayv2_route" "create_admin_app" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "POST /v1/admin/apps"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
  target             = "integrations/${aws_apigatewayv2_integration.admin_apps.id}"
}

resource "aws_apigatewayv2_route" "update_admin_app" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "PUT /v1/admin/apps/{appId}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
  target             = "integrations/${aws_apigatewayv2_integration.admin_apps.id}"
}

resource "aws_apigatewayv2_route" "delete_admin_app" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "DELETE /v1/admin/apps/{appId}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
  target             = "integrations/${aws_apigatewayv2_integration.admin_apps.id}"
}
