resource "aws_dynamodb_table" "books" {
  name         = "oldforest-books"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "bookId"

  attribute {
    name = "bookId"
    type = "S"
  }

  attribute {
    name = "updatedAt"
    type = "S"
  }

  # GSI: all books ordered by last-updated (for editor "recently updated" list)
  global_secondary_index {
    name            = "byUpdated"
    hash_key        = "allBooks"   # constant partition key written by Lambda
    range_key       = "updatedAt"
    projection_type = "ALL"
  }

  attribute {
    name = "allBooks"
    type = "S"
  }
}

resource "aws_dynamodb_table" "reads" {
  name         = "oldforest-reads"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "readId"

  attribute {
    name = "readId"
    type = "S"
  }

  attribute {
    name = "bookId"
    type = "S"
  }

  attribute {
    name = "finished"
    type = "S"
  }

  attribute {
    name = "started"
    type = "S"
  }

  attribute {
    name = "allReads"
    type = "S"
  }

  # GSI 1: all reads for a specific book, sorted by finish date
  global_secondary_index {
    name            = "byBook"
    hash_key        = "bookId"
    range_key       = "finished"
    projection_type = "ALL"
  }

  # GSI 2: all reads sorted by finish date (for timeline date-range queries)
  global_secondary_index {
    name            = "byFinished"
    hash_key        = "allReads"
    range_key       = "finished"
    projection_type = "ALL"
  }

  # GSI 3: all reads sorted by start date (for in-progress / started-range queries)
  global_secondary_index {
    name            = "byStarted"
    hash_key        = "allReads"
    range_key       = "started"
    projection_type = "ALL"
  }
}

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
