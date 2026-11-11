# ── Site bucket (serves static HTML/JS/CSS via CloudFront) ──────────────────
resource "aws_s3_bucket" "site" {
  bucket = "oldforest-net-site-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
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

resource "aws_s3_bucket_public_access_block" "content" {
  bucket                  = aws_s3_bucket.content.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
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
      # Only these two prefixes are world-readable through the CDN.
      #
      # Deliberately NOT listed:
      #   private/ — gated downloads, reachable only via a presigned URL minted
      #              by the download-url Lambda for a signed-in caller
      #   posts/   — Markdown bodies of posts, including drafts and personal
      #              posts, fetched server-side by get-post after it has checked
      #              visibility
      # Adding either here would bypass those checks entirely.
      Resource = [
        "${aws_s3_bucket.content.arn}/images/*",
        "${aws_s3_bucket.content.arn}/files/*",
      ]
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.main.arn
        }
      }
    }]
  })
  depends_on = [aws_cloudfront_distribution.main]
}
