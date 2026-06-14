# ── Package each function as a zip ───────────────────────────────────────────
data "archive_file" "list_posts" {
  type        = "zip"
  source_dir  = "${path.module}/../src/functions/list-posts"
  output_path = "${path.module}/.lambda-zips/list-posts.zip"
}

data "archive_file" "get_post" {
  type        = "zip"
  source_dir  = "${path.module}/../src/functions/get-post"
  output_path = "${path.module}/.lambda-zips/get-post.zip"
}

data "archive_file" "create_post" {
  type        = "zip"
  source_dir  = "${path.module}/../src/functions/create-post"
  output_path = "${path.module}/.lambda-zips/create-post.zip"
}

data "archive_file" "update_post" {
  type        = "zip"
  source_dir  = "${path.module}/../src/functions/update-post"
  output_path = "${path.module}/.lambda-zips/update-post.zip"
}

data "archive_file" "delete_post" {
  type        = "zip"
  source_dir  = "${path.module}/../src/functions/delete-post"
  output_path = "${path.module}/.lambda-zips/delete-post.zip"
}

data "archive_file" "profile" {
  type        = "zip"
  source_dir  = "${path.module}/../src/functions/profile"
  output_path = "${path.module}/.lambda-zips/profile.zip"
}

data "archive_file" "upload_url" {
  type        = "zip"
  source_dir  = "${path.module}/../src/functions/upload-url"
  output_path = "${path.module}/.lambda-zips/upload-url.zip"
}

data "archive_file" "admin_files" {
  type        = "zip"
  source_dir  = "${path.module}/../src/functions/admin-files"
  output_path = "${path.module}/.lambda-zips/admin-files.zip"
}

data "archive_file" "admin_users" {
  type        = "zip"
  source_dir  = "${path.module}/../src/functions/admin-users"
  output_path = "${path.module}/.lambda-zips/admin-users.zip"
}

# ── Shared Lambda settings ────────────────────────────────────────────────────
locals {
  lambda_runtime = "nodejs20.x"
  lambda_handler = "index.handler"
  lambda_timeout = 10
  lambda_memory  = 256

  common_env = {
    POSTS_TABLE    = aws_dynamodb_table.posts.name
    CONTENT_BUCKET = aws_s3_bucket.content.id
  }
}

# ── list-posts ────────────────────────────────────────────────────────────────
resource "aws_lambda_function" "list_posts" {
  function_name    = "oldforest-list-posts"
  role             = aws_iam_role.list_posts.arn
  runtime          = local.lambda_runtime
  handler          = local.lambda_handler
  timeout          = local.lambda_timeout
  memory_size      = local.lambda_memory
  filename         = data.archive_file.list_posts.output_path
  source_code_hash = data.archive_file.list_posts.output_base64sha256

  environment {
    variables = local.common_env
  }
}

# ── get-post ──────────────────────────────────────────────────────────────────
resource "aws_lambda_function" "get_post" {
  function_name    = "oldforest-get-post"
  role             = aws_iam_role.get_post.arn
  runtime          = local.lambda_runtime
  handler          = local.lambda_handler
  timeout          = local.lambda_timeout
  memory_size      = local.lambda_memory
  filename         = data.archive_file.get_post.output_path
  source_code_hash = data.archive_file.get_post.output_base64sha256

  environment {
    variables = local.common_env
  }
}

# ── create-post ───────────────────────────────────────────────────────────────
resource "aws_lambda_function" "create_post" {
  function_name    = "oldforest-create-post"
  role             = aws_iam_role.create_post.arn
  runtime          = local.lambda_runtime
  handler          = local.lambda_handler
  timeout          = local.lambda_timeout
  memory_size      = local.lambda_memory
  filename         = data.archive_file.create_post.output_path
  source_code_hash = data.archive_file.create_post.output_base64sha256

  environment {
    variables = local.common_env
  }
}

# ── update-post ───────────────────────────────────────────────────────────────
resource "aws_lambda_function" "update_post" {
  function_name    = "oldforest-update-post"
  role             = aws_iam_role.update_post.arn
  runtime          = local.lambda_runtime
  handler          = local.lambda_handler
  timeout          = local.lambda_timeout
  memory_size      = local.lambda_memory
  filename         = data.archive_file.update_post.output_path
  source_code_hash = data.archive_file.update_post.output_base64sha256

  environment {
    variables = local.common_env
  }
}

# ── delete-post ───────────────────────────────────────────────────────────────
resource "aws_lambda_function" "delete_post" {
  function_name    = "oldforest-delete-post"
  role             = aws_iam_role.delete_post.arn
  runtime          = local.lambda_runtime
  handler          = local.lambda_handler
  timeout          = local.lambda_timeout
  memory_size      = local.lambda_memory
  filename         = data.archive_file.delete_post.output_path
  source_code_hash = data.archive_file.delete_post.output_base64sha256

  environment {
    variables = local.common_env
  }
}

# ── profile ───────────────────────────────────────────────────────────────────
resource "aws_lambda_function" "profile" {
  function_name    = "oldforest-profile"
  role             = aws_iam_role.profile.arn
  runtime          = local.lambda_runtime
  handler          = local.lambda_handler
  timeout          = local.lambda_timeout
  memory_size      = local.lambda_memory
  filename         = data.archive_file.profile.output_path
  source_code_hash = data.archive_file.profile.output_base64sha256

  environment {
    variables = local.common_env
  }
}

# ── upload-url ────────────────────────────────────────────────────────────────
resource "aws_lambda_function" "upload_url" {
  function_name    = "oldforest-upload-url"
  role             = aws_iam_role.upload_url.arn
  runtime          = local.lambda_runtime
  handler          = local.lambda_handler
  timeout          = local.lambda_timeout
  memory_size      = local.lambda_memory
  filename         = data.archive_file.upload_url.output_path
  source_code_hash = data.archive_file.upload_url.output_base64sha256

  environment {
    variables = local.common_env
  }
}

# ── admin-files ───────────────────────────────────────────────────────────────
resource "aws_lambda_function" "admin_files" {
  function_name    = "oldforest-admin-files"
  role             = aws_iam_role.admin_files.arn
  runtime          = local.lambda_runtime
  handler          = local.lambda_handler
  timeout          = local.lambda_timeout
  memory_size      = local.lambda_memory
  filename         = data.archive_file.admin_files.output_path
  source_code_hash = data.archive_file.admin_files.output_base64sha256

  environment {
    variables = local.common_env
  }
}

# ── list-apps ────────────────────────────────────────────────────────────────
data "archive_file" "list_apps" {
  type        = "zip"
  source_dir  = "${path.module}/../src/functions/list-apps"
  output_path = "${path.module}/.lambda-zips/list-apps.zip"
}

resource "aws_lambda_function" "list_apps" {
  function_name    = "oldforest-list-apps"
  role             = aws_iam_role.list_apps.arn
  runtime          = local.lambda_runtime
  handler          = local.lambda_handler
  timeout          = local.lambda_timeout
  memory_size      = local.lambda_memory
  filename         = data.archive_file.list_apps.output_path
  source_code_hash = data.archive_file.list_apps.output_base64sha256

  environment {
    variables = { APPS_TABLE = aws_dynamodb_table.apps.name }
  }
}

# ── admin-apps ────────────────────────────────────────────────────────────────
data "archive_file" "admin_apps" {
  type        = "zip"
  source_dir  = "${path.module}/../src/functions/admin-apps"
  output_path = "${path.module}/.lambda-zips/admin-apps.zip"
}

resource "aws_lambda_function" "admin_apps" {
  function_name    = "oldforest-admin-apps"
  role             = aws_iam_role.admin_apps.arn
  runtime          = local.lambda_runtime
  handler          = local.lambda_handler
  timeout          = local.lambda_timeout
  memory_size      = local.lambda_memory
  filename         = data.archive_file.admin_apps.output_path
  source_code_hash = data.archive_file.admin_apps.output_base64sha256

  environment {
    variables = { APPS_TABLE = aws_dynamodb_table.apps.name }
  }
}

# ── admin-users ───────────────────────────────────────────────────────────────
resource "aws_lambda_function" "admin_users" {
  function_name    = "oldforest-admin-users"
  role             = aws_iam_role.admin_users.arn
  runtime          = local.lambda_runtime
  handler          = local.lambda_handler
  timeout          = local.lambda_timeout
  memory_size      = local.lambda_memory
  filename         = data.archive_file.admin_users.output_path
  source_code_hash = data.archive_file.admin_users.output_base64sha256

  environment {
    variables = merge(local.common_env, {
      USER_POOL_ID = aws_cognito_user_pool.main.id
    })
  }
}
