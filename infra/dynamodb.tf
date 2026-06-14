resource "aws_dynamodb_table" "apps" {
  name         = "oldforest-apps"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "appId"

  attribute {
    name = "appId"
    type = "S"
  }
}

resource "aws_dynamodb_table" "posts" {
  name         = "oldforest-posts"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "postId"

  attribute {
    name = "postId"
    type = "S"
  }

  attribute {
    name = "slug"
    type = "S"
  }

  global_secondary_index {
    name            = "slug-index"
    hash_key        = "slug"
    projection_type = "ALL"
  }
}
