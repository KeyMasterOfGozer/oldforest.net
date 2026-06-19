# ── Origin Access Controls ────────────────────────────────────────────────────
resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "oldforest-site-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_origin_access_control" "content" {
  name                              = "oldforest-content-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# ── www → apex redirect (CloudFront Function) ─────────────────────────────────
resource "aws_cloudfront_function" "www_redirect" {
  name    = "oldforest-www-redirect"
  runtime = "cloudfront-js-2.0"
  comment = "Redirect www.oldforest.net to oldforest.net"
  publish = true
  code    = <<-EOT
    function handler(event) {
      var request = event.request;
      var host = request.headers.host.value;

      // www → apex redirect
      if (host.startsWith('www.')) {
        return {
          statusCode: 301,
          statusDescription: 'Moved Permanently',
          headers: {
            location: { value: 'https://' + host.slice(4) + request.uri }
          }
        };
      }

      // Rewrite directory-style URLs so S3 serves the index.html
      // e.g. /apps/reading-log/ → /apps/reading-log/index.html
      var uri = request.uri;
      if (uri.endsWith('/')) {
        request.uri = uri + 'index.html';
      } else if (uri.lastIndexOf('.') <= uri.lastIndexOf('/')) {
        // No file extension after the last slash — treat as directory
        request.uri = uri + '/index.html';
      }

      return request;
    }
  EOT
}

# ── CloudFront Distribution ───────────────────────────────────────────────────
resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  aliases             = [var.domain_name, "www.${var.domain_name}"]
  default_root_object = "index.html"
  price_class         = "PriceClass_100"

  viewer_certificate {
    acm_certificate_arn      = var.acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  # ── Origins ────────────────────────────────────────────────────────────────
  origin {
    origin_id                = "SiteS3Origin"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id

    s3_origin_config {
      origin_access_identity = ""
    }
  }

  origin {
    origin_id                = "ContentS3Origin"
    domain_name              = aws_s3_bucket.content.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.content.id

    s3_origin_config {
      origin_access_identity = ""
    }
  }

  origin {
    origin_id   = "ApiOrigin"
    domain_name = "${aws_apigatewayv2_api.main.id}.execute-api.${var.aws_region}.amazonaws.com"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # ── Cache Behaviors ────────────────────────────────────────────────────────

  # /images/* → content bucket (cached)
  ordered_cache_behavior {
    path_pattern     = "/images/*"
    target_origin_id = "ContentS3Origin"

    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]

    # CachingOptimized managed policy
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  # /v1/* → API Gateway (not cached, pass all headers except Host)
  ordered_cache_behavior {
    path_pattern     = "/v1/*"
    target_origin_id = "ApiOrigin"

    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]

    # CachingDisabled managed policy
    cache_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    # AllViewerExceptHostHeader managed origin request policy
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  }

  # Default → site bucket (cached, with www redirect)
  default_cache_behavior {
    target_origin_id = "SiteS3Origin"

    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]

    # CachingOptimized managed policy
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.www_redirect.arn
    }
  }

  # ── Custom Error Responses (SPA routing) ──────────────────────────────────
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}
