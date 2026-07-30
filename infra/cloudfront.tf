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

# ── Security Response Headers Policy ─────────────────────────────────────────
resource "aws_cloudfront_response_headers_policy" "security" {
  name = "oldforest-security-headers"

  security_headers_config {
    # Prevent MIME-type sniffing
    content_type_options {
      override = true
    }
    # Deny embedding in iframes (clickjacking protection)
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    # Don't send full Referer to cross-origin destinations
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    # Enforce HTTPS for 1 year, include subdomains
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
    }
    # Content Security Policy
    # - scripts: unsafe-inline required — all page JS is in inline <script> blocks
    # - styles: unsafe-inline required — all CSS is in inline <style> blocks
    # - images: self, https (cover art, OG images), data: (inline SVGs)
    # - connect: self (CloudFront /v1/* proxy) + direct API GW URL used in CFG.apiBase
    #            + Cognito token endpoint (PKCE code exchange + token refresh)
    #            + OpenLibrary + Google Books (book search)
    # - frame-ancestors: none (belt-and-suspenders with X-Frame-Options)
    content_security_policy {
      content_security_policy = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; img-src 'self' https: data:; connect-src 'self' https://*.execute-api.us-east-1.amazonaws.com https://*.amazoncognito.com https://openlibrary.org https://www.googleapis.com https://*.s3.us-east-1.amazonaws.com; frame-ancestors 'none';"
      override                = true
    }
  }
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

    viewer_protocol_policy      = "redirect-to-https"
    allowed_methods             = ["GET", "HEAD"]
    cached_methods              = ["GET", "HEAD"]
    cache_policy_id             = "658327ea-f89d-4fab-a63d-7e88639e58f6"  # CachingOptimized
    response_headers_policy_id  = aws_cloudfront_response_headers_policy.security.id
  }

  # /v1/* → API Gateway (not cached, pass all headers except Host)
  ordered_cache_behavior {
    path_pattern     = "/v1/*"
    target_origin_id = "ApiOrigin"

    viewer_protocol_policy      = "https-only"
    allowed_methods             = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods              = ["GET", "HEAD"]
    cache_policy_id             = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"  # CachingDisabled
    origin_request_policy_id    = "b689b0a8-53d0-40ab-baf2-68738e2966ac"  # AllViewerExceptHostHeader
    response_headers_policy_id  = aws_cloudfront_response_headers_policy.security.id
  }

  # Default → site bucket (cached, with www redirect)
  default_cache_behavior {
    target_origin_id = "SiteS3Origin"

    viewer_protocol_policy      = "redirect-to-https"
    allowed_methods             = ["GET", "HEAD"]
    cached_methods              = ["GET", "HEAD"]
    cache_policy_id             = "658327ea-f89d-4fab-a63d-7e88639e58f6"  # CachingOptimized
    response_headers_policy_id  = aws_cloudfront_response_headers_policy.security.id

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
