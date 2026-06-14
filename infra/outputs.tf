output "api_url" {
  description = "API Gateway base URL"
  value       = "https://${aws_apigatewayv2_api.main.id}.execute-api.${var.aws_region}.amazonaws.com"
}

output "user_pool_id" {
  description = "Cognito User Pool ID"
  value       = aws_cognito_user_pool.main.id
}

output "user_pool_client_id" {
  description = "Cognito User Pool Client ID"
  value       = aws_cognito_user_pool_client.main.id
}

output "cloudfront_distribution_id" {
  description = "CloudFront Distribution ID"
  value       = aws_cloudfront_distribution.main.id
}

output "cloudfront_domain" {
  description = "CloudFront Domain Name"
  value       = aws_cloudfront_distribution.main.domain_name
}

output "site_bucket_name" {
  description = "S3 bucket name for static site files"
  value       = aws_s3_bucket.site.id
}

output "content_bucket_name" {
  description = "S3 bucket name for post content and images"
  value       = aws_s3_bucket.content.id
}
