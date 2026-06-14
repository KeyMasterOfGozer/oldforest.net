# ── Shared Lambda trust policy ───────────────────────────────────────────────
data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

locals {
  dynamo_read_actions = [
    "dynamodb:GetItem",
    "dynamodb:Scan",
    "dynamodb:Query",
  ]
  dynamo_crud_actions = [
    "dynamodb:GetItem",
    "dynamodb:Scan",
    "dynamodb:Query",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
    "dynamodb:DeleteItem",
  ]
  s3_crud_actions = [
    "s3:GetObject",
    "s3:PutObject",
    "s3:DeleteObject",
    "s3:ListBucket",
    "s3:AbortMultipartUpload",
  ]
  dynamo_arns = [
    aws_dynamodb_table.posts.arn,
    "${aws_dynamodb_table.posts.arn}/index/*",
  ]
}

# ── list-posts ────────────────────────────────────────────────────────────────
resource "aws_iam_role" "list_posts" {
  name               = "oldforest-list-posts"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}
resource "aws_iam_role_policy_attachment" "list_posts_logs" {
  role       = aws_iam_role.list_posts.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}
resource "aws_iam_role_policy" "list_posts" {
  name   = "dynamo-read"
  role   = aws_iam_role.list_posts.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = local.dynamo_read_actions
      Resource = local.dynamo_arns
    }]
  })
}

# ── get-post ──────────────────────────────────────────────────────────────────
resource "aws_iam_role" "get_post" {
  name               = "oldforest-get-post"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}
resource "aws_iam_role_policy_attachment" "get_post_logs" {
  role       = aws_iam_role.get_post.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}
resource "aws_iam_role_policy" "get_post" {
  name   = "dynamo-read-s3-read"
  role   = aws_iam_role.get_post.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = local.dynamo_read_actions
        Resource = local.dynamo_arns
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.content.arn}/*"
      },
    ]
  })
}

# ── create-post ───────────────────────────────────────────────────────────────
resource "aws_iam_role" "create_post" {
  name               = "oldforest-create-post"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}
resource "aws_iam_role_policy_attachment" "create_post_logs" {
  role       = aws_iam_role.create_post.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}
resource "aws_iam_role_policy" "create_post" {
  name   = "dynamo-crud-s3-crud"
  role   = aws_iam_role.create_post.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = local.dynamo_crud_actions
        Resource = local.dynamo_arns
      },
      {
        Effect   = "Allow"
        Action   = local.s3_crud_actions
        Resource = ["${aws_s3_bucket.content.arn}", "${aws_s3_bucket.content.arn}/*"]
      },
    ]
  })
}

# ── update-post ───────────────────────────────────────────────────────────────
resource "aws_iam_role" "update_post" {
  name               = "oldforest-update-post"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}
resource "aws_iam_role_policy_attachment" "update_post_logs" {
  role       = aws_iam_role.update_post.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}
resource "aws_iam_role_policy" "update_post" {
  name   = "dynamo-crud-s3-crud"
  role   = aws_iam_role.update_post.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = local.dynamo_crud_actions
        Resource = local.dynamo_arns
      },
      {
        Effect   = "Allow"
        Action   = local.s3_crud_actions
        Resource = ["${aws_s3_bucket.content.arn}", "${aws_s3_bucket.content.arn}/*"]
      },
    ]
  })
}

# ── delete-post ───────────────────────────────────────────────────────────────
resource "aws_iam_role" "delete_post" {
  name               = "oldforest-delete-post"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}
resource "aws_iam_role_policy_attachment" "delete_post_logs" {
  role       = aws_iam_role.delete_post.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}
resource "aws_iam_role_policy" "delete_post" {
  name   = "dynamo-crud-s3-crud"
  role   = aws_iam_role.delete_post.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = local.dynamo_crud_actions
        Resource = local.dynamo_arns
      },
      {
        Effect   = "Allow"
        Action   = local.s3_crud_actions
        Resource = ["${aws_s3_bucket.content.arn}", "${aws_s3_bucket.content.arn}/*"]
      },
    ]
  })
}

# ── profile ───────────────────────────────────────────────────────────────────
resource "aws_iam_role" "profile" {
  name               = "oldforest-profile"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}
resource "aws_iam_role_policy_attachment" "profile_logs" {
  role       = aws_iam_role.profile.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}
resource "aws_iam_role_policy" "profile" {
  name   = "cognito-user"
  role   = aws_iam_role.profile.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "cognito-idp:GetUser",
        "cognito-idp:UpdateUserAttributes",
        "cognito-idp:ChangePassword",
      ]
      Resource = aws_cognito_user_pool.main.arn
    }]
  })
}

# ── upload-url ────────────────────────────────────────────────────────────────
resource "aws_iam_role" "upload_url" {
  name               = "oldforest-upload-url"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}
resource "aws_iam_role_policy_attachment" "upload_url_logs" {
  role       = aws_iam_role.upload_url.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}
resource "aws_iam_role_policy" "upload_url" {
  name   = "s3-crud"
  role   = aws_iam_role.upload_url.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = local.s3_crud_actions
      Resource = ["${aws_s3_bucket.content.arn}", "${aws_s3_bucket.content.arn}/*"]
    }]
  })
}

# ── admin-files ───────────────────────────────────────────────────────────────
resource "aws_iam_role" "admin_files" {
  name               = "oldforest-admin-files"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}
resource "aws_iam_role_policy_attachment" "admin_files_logs" {
  role       = aws_iam_role.admin_files.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}
resource "aws_iam_role_policy" "admin_files" {
  name   = "s3-crud"
  role   = aws_iam_role.admin_files.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = local.s3_crud_actions
      Resource = ["${aws_s3_bucket.content.arn}", "${aws_s3_bucket.content.arn}/*"]
    }]
  })
}

# ── admin-users ───────────────────────────────────────────────────────────────
resource "aws_iam_role" "admin_users" {
  name               = "oldforest-admin-users"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}
resource "aws_iam_role_policy_attachment" "admin_users_logs" {
  role       = aws_iam_role.admin_users.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}
resource "aws_iam_role_policy" "admin_users" {
  name   = "cognito-admin"
  role   = aws_iam_role.admin_users.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "cognito-idp:ListUsers",
        "cognito-idp:AdminCreateUser",
        "cognito-idp:AdminUpdateUserAttributes",
        "cognito-idp:AdminDeleteUser",
        "cognito-idp:AdminAddUserToGroup",
        "cognito-idp:AdminRemoveUserFromGroup",
        "cognito-idp:AdminListGroupsForUser",
      ]
      Resource = aws_cognito_user_pool.main.arn
    }]
  })
}
