# Terraform Migration Guide

Steps to destroy the existing CloudFormation stack and stand up fresh infrastructure with Terraform.

---

## 1. Bootstrap Terraform state backend (one-time, run locally)

Terraform needs an S3 bucket and DynamoDB table for remote state **before** you can run `terraform init`. Create them manually:

```bash
# State bucket
aws s3api create-bucket \
  --bucket oldforest-net-tfstate-165395066552 \
  --region us-east-1 \
  --profile oldforest

aws s3api put-bucket-versioning \
  --bucket oldforest-net-tfstate-165395066552 \
  --versioning-configuration Status=Enabled \
  --profile oldforest

aws s3api put-bucket-encryption \
  --bucket oldforest-net-tfstate-165395066552 \
  --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' \
  --profile oldforest

# State lock table
aws dynamodb create-table \
  --table-name oldforest-tfstate-lock \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1 \
  --profile oldforest
```

---

## 2. Destroy the CloudFormation stack

CloudFormation cannot delete non-empty S3 buckets, so empty them first.

```bash
# Empty the site bucket
aws s3 rm s3://oldforest-net-site-165395066552 --recursive --profile oldforest

# Empty the content bucket
aws s3 rm s3://oldforest-net-content-165395066552 --recursive --profile oldforest

# Delete the stack
aws cloudformation delete-stack \
  --stack-name oldforest-net \
  --profile oldforest

# Wait for deletion to complete (takes ~5 minutes)
aws cloudformation wait stack-delete-complete \
  --stack-name oldforest-net \
  --profile oldforest
```

> **Note:** After deletion, you will need to re-add your user to the new Cognito `admins` and `editors` groups (Terraform creates fresh groups with new IDs).

---

## 3. Initialize and apply Terraform

```bash
cd infra

AWS_PROFILE=oldforest terraform init

# Preview what will be created
AWS_PROFILE=oldforest terraform plan

# Create all resources
AWS_PROFILE=oldforest terraform apply
```

After `apply`, note the outputs — especially `api_url`, `user_pool_id`, and `user_pool_client_id`.

---

## 4. Update site configuration

The new Terraform apply creates a **new** API Gateway and Cognito User Pool, so the IDs in the site HTML files need updating. Check the Terraform outputs:

```bash
cd infra
AWS_PROFILE=oldforest terraform output
```

Update the `CFG` block in these files if the IDs differ from the old stack:

- `site/index.html`
- `site/post.html`
- `site/profile.html`
- `site/editor/index.html`
- `site/admin/index.html`

The values to update are:
- `cognitoDomain` — format: `auth-165395066552.auth.us-east-1.amazoncognito.com` (unchanged, same account)
- `clientId` — get from `terraform output user_pool_client_id`
- `apiBase` — get from `terraform output api_url`

---

## 5. Sync site to S3 and invalidate CloudFront

```bash
BUCKET=$(cd infra && AWS_PROFILE=oldforest terraform output -raw site_bucket_name)
DIST_ID=$(cd infra && AWS_PROFILE=oldforest terraform output -raw cloudfront_distribution_id)

aws s3 sync ./site s3://$BUCKET --delete --profile oldforest
aws cloudfront create-invalidation --distribution-id $DIST_ID --paths "/*" --profile oldforest
```

---

## 6. Update DNS (if needed)

If CloudFront was recreated, get the new domain name:

```bash
cd infra && AWS_PROFILE=oldforest terraform output cloudfront_domain
```

Update your Route 53 (or other DNS) A/AAAA alias records for `oldforest.net` and `www.oldforest.net` to point at the new CloudFront domain.

---

## 7. Re-add your user to Cognito groups

```bash
USER_POOL_ID=$(cd infra && AWS_PROFILE=oldforest terraform output -raw user_pool_id)

aws cognito-idp admin-add-user-to-group \
  --user-pool-id $USER_POOL_ID \
  --username bombadil@oldforest.net \
  --group-name admins \
  --profile oldforest

aws cognito-idp admin-add-user-to-group \
  --user-pool-id $USER_POOL_ID \
  --username bombadil@oldforest.net \
  --group-name editors \
  --profile oldforest
```

---

## 8. GitHub Actions — add required IAM permissions

The OIDC deploy role (`AWS_DEPLOY_ROLE_ARN`) needs permission to read/write the Terraform state backend. Add this to the role's policy if it isn't already covered:

```json
{
  "Effect": "Allow",
  "Action": [
    "s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"
  ],
  "Resource": [
    "arn:aws:s3:::oldforest-net-tfstate-165395066552",
    "arn:aws:s3:::oldforest-net-tfstate-165395066552/*"
  ]
},
{
  "Effect": "Allow",
  "Action": [
    "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"
  ],
  "Resource": "arn:aws:dynamodb:us-east-1:165395066552:table/oldforest-tfstate-lock"
}
```

Push to `main` to trigger the first Terraform-based deploy.
