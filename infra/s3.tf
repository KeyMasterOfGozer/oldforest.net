# ── Site bucket (serves static HTML/JS/CSS via CloudFront) ──────────────────
resource "aws_s3_bucket" "site" {
  bucket = "oldforest-net-site-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.site.arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.main.arn
        }
      }
    }]
  })
  depends_on = [aws_cloudfront_distribution.main]
}

# ── Content bucket (post markdown + uploaded images) ────────────────────────
resource "aws_s3_bucket" "content" {
  bucket = "oldforest-net-content-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_cors_configuration" "content" {
  bucket = aws_s3_bucket.content.id

  cors_rule {
    allowed_origins = ["https://${var.domain_name}"]
    allowed_methods = ["GET", "PUT"]
    allowed_headers = ["*"]
    max_age_seconds = 3600
  }
}

resource "aws_s3_bucket_policy" "content" {
  bucket = aws_s3_bucket.content.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.content.arn}/images/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.main.arn
        }
      }
    }]
  })
  depends_on = [aws_cloudfront_distribution.main]
}
