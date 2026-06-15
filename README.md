# oldforest.net

A fully serverless blog and community platform hosted on AWS. All infrastructure is defined in Terraform, deployments are automated via GitHub Actions, and there is no web server — the frontend is static HTML served from S3 through CloudFront.

---

## Architecture

```
Browser
  │
  ├─▶ CloudFront (CDN + HTTPS)
  │     ├─▶ /images/*       → S3 content bucket  (uploaded media)
  │     ├─▶ /v1/*           → API Gateway HTTP API
  │     │                         └─▶ Lambda functions (Node.js 20 ES modules)
  │     │                               ├─▶ DynamoDB  (posts, apps)
  │     │                               ├─▶ S3        (post content, images)
  │     │                               └─▶ Cognito   (user management)
  │     └─▶ default         → S3 site bucket     (HTML, favicon)
  │
  └─▶ Cognito Managed Login (auth redirect)
```

**AWS services used:** CloudFront, S3 (×2), API Gateway HTTP API v2, Lambda, DynamoDB (×2), Cognito User Pool, ACM, IAM, CloudFront Functions.

---

## Repository layout

```
.
├── site/                   # Static frontend (deployed to S3)
│   ├── index.html          # Public blog home
│   ├── post.html           # Individual post view
│   ├── profile.html        # User profile / password change
│   ├── apps.html           # Apps directory page
│   ├── editor/index.html   # Post editor (editors group)
│   ├── admin/index.html    # Admin dashboard (admins group)
│   └── favicon.svg
│
├── src/functions/          # Lambda function source (one directory per function)
│   ├── list-posts/
│   ├── get-post/
│   ├── create-post/
│   ├── update-post/
│   ├── delete-post/
│   ├── profile/
│   ├── upload-url/
│   ├── admin-files/
│   ├── admin-users/
│   ├── list-apps/
│   └── admin-apps/
│
├── infra/                  # Terraform (all AWS infrastructure)
│   ├── main.tf             # Provider, backend, data sources
│   ├── variables.tf
│   ├── outputs.tf
│   ├── terraform.tfvars    # ACM certificate ARN (not committed to public repos)
│   ├── s3.tf               # Site + content buckets
│   ├── cloudfront.tf       # Distribution, OAC, CloudFront Function (www redirect)
│   ├── cognito.tf          # User pool, groups, app client, domain
│   ├── dynamodb.tf         # Posts table + Apps table
│   ├── lambdas.tf          # Archive packaging + Lambda functions
│   ├── api.tf              # API Gateway HTTP API, routes, integrations
│   └── iam.tf              # Per-function IAM roles and policies
│
└── .github/workflows/
    └── deploy.yml          # CI/CD: terraform apply + S3 sync on push to main
```

---

## Frontend pages

| Page | Path | Access |
|------|------|--------|
| Blog home | `/` | Public |
| Post | `/post.html?slug=…` | Public (members-only posts require login) |
| Apps | `/apps.html` | Public (some cards may require login) |
| Profile | `/profile.html` | Authenticated users |
| Editor | `/editor/` | `editors` group |
| Admin | `/admin/` | `admins` group |

All pages use PKCE OAuth2 for authentication — users are redirected to the Cognito Managed Login page and returned with a short-lived access token stored in `sessionStorage`.

---

## Lambda functions

### Public API (`/v1/…`)

**`list-posts`** — `GET /v1/posts`  
Scans DynamoDB for all posts with `visibility = public`. Also serves `GET /v1/editor/posts` (editors only) which returns all posts including drafts and personal posts.

**`get-post`** — `GET /v1/posts/{slug}`  
Fetches post metadata from DynamoDB by slug, then retrieves the Markdown body from S3. Also serves `GET /v1/posts/members/{slug}` (authenticated members only).

**`list-apps`** — `GET /v1/apps`  
Scans the apps DynamoDB table for all enabled apps, sorted by `order`. Public — visibility filtering happens client-side based on the user's group membership.

### Editor API (`/v1/editor/…` — requires `editors` group)

**`create-post`** — `POST /v1/editor/posts`  
Creates a DynamoDB record and writes the post body to S3 under a UUID key.

**`update-post`** — `PUT /v1/editor/posts/{postId}`  
Updates post metadata in DynamoDB and replaces the S3 body object.

**`delete-post`** — `DELETE /v1/editor/posts/{postId}`  
Deletes the DynamoDB record and the S3 body object.

**`upload-url`** — `POST /v1/editor/upload`  
Returns a presigned S3 PUT URL for direct browser-to-S3 image upload. Keys are stored as `images/YYYY/MM/{uuid}-{filename}.ext`.

### Profile API (`/v1/profile` — authenticated)

**`profile`** — `GET /v1/profile`, `PUT /v1/profile`, `POST /v1/profile/password`  
Reads and updates Cognito user attributes (name, email). Handles password changes via `ChangePassword`.

### Admin API (`/v1/admin/…` — requires `admins` group)

**`admin-files`** — `GET /v1/admin/files`, `DELETE /v1/admin/files`  
Lists all objects in the content S3 bucket with metadata and presigned download URLs. Supports deletion.

**`admin-users`** — `GET /v1/admin/users`, `POST /v1/admin/users`, `PUT /v1/admin/users/{username}`, `DELETE /v1/admin/users/{username}`  
Full Cognito user management: list, create (with temporary password email), update attributes, delete, and manage group membership (`members`, `editors`, `admins`).

**`admin-apps`** — `GET /v1/admin/apps`, `POST /v1/admin/apps`, `PUT /v1/admin/apps/{appId}`, `DELETE /v1/admin/apps/{appId}`  
CRUD for the apps directory. Fields: name, description, icon (emoji), URL, external flag, visibility (`public` / `members` / `editors` / `admins`), sort order, enabled flag.

---

## User roles

| Group | Can do |
|-------|--------|
| (none) | Read public posts and public apps |
| `members` | Read members-only posts and apps |
| `editors` | Everything above + create/edit/delete posts, upload images |
| `admins` | Everything above + manage users, files, and apps |

---

## Infrastructure

### Terraform state backend

State is stored in S3 with native locking (`use_lockfile = true`, requires Terraform ≥ 1.10). No DynamoDB lock table is needed.

```
Bucket: oldforest-net-tfstate-165395066552
Key:    oldforest/terraform.tfstate
Region: us-east-1
```

See `TERRAFORM_MIGRATION.md` for one-time bootstrap instructions.

### Key Terraform files

| File | What it manages |
|------|-----------------|
| `s3.tf` | Site bucket (HTML), content bucket (images/post bodies), OAC bucket policies |
| `cloudfront.tf` | CDN distribution with three origins, www→apex redirect CloudFront Function |
| `cognito.tf` | User pool with passkey (WebAuthn) config, user groups, app client, Managed Login domain |
| `dynamodb.tf` | `oldforest-posts` (postId PK, slug GSI) and `oldforest-apps` (appId PK) tables |
| `lambdas.tf` | `archive_file` zip packaging for each function + `aws_lambda_function` resources |
| `api.tf` | HTTP API v2, Cognito JWT authorizer, all routes and Lambda integrations |
| `iam.tf` | Least-privilege IAM role + inline policy per Lambda |

---

## Local development

**Prerequisites:** Terraform ≥ 1.10, AWS CLI ≥ 2.17, an AWS profile named `oldforest`.

```bash
# Plan infrastructure changes
cd infra
AWS_PROFILE=oldforest terraform plan

# Apply infrastructure + get outputs
AWS_PROFILE=oldforest terraform apply

# Sync site files manually (e.g. after a frontend-only change)
BUCKET=$(AWS_PROFILE=oldforest terraform output -raw site_bucket_name)
DIST=$(AWS_PROFILE=oldforest terraform output -raw cloudfront_distribution_id)
cd ..
aws s3 sync ./site s3://$BUCKET --delete --profile oldforest
aws cloudfront create-invalidation --distribution-id $DIST --paths "/*" --profile oldforest
```

---

## CI/CD

Pushing to `main` triggers `.github/workflows/deploy.yml` which:

1. Authenticates to AWS via OIDC (no long-lived keys) using the role in the `AWS_DEPLOY_ROLE_ARN` repository secret.
2. Runs `terraform init` + `terraform apply -auto-approve`.
3. Syncs `./site` to the S3 site bucket.
4. Invalidates the CloudFront cache.

**Required GitHub secret:** `AWS_DEPLOY_ROLE_ARN` — the ARN of an IAM role that trusts `token.actions.githubusercontent.com` and has permissions to manage all resources in `infra/`.

---

## One-time post-deploy steps

Some features cannot be fully configured by Terraform and require a manual step after the first `terraform apply`. These are documented in `TERRAFORM_MIGRATION.md`.

**Passkeys (Managed Login v2):**
```bash
USER_POOL_ID=$(cd infra && AWS_PROFILE=oldforest terraform output -raw user_pool_id)
CLIENT_ID=$(cd infra && AWS_PROFILE=oldforest terraform output -raw user_pool_client_id)

# 1. Create minimal branding (activates Managed Login pages)
AWS_PROFILE=oldforest aws cognito-idp create-managed-login-branding \
  --user-pool-id "$USER_POOL_ID" --client-id "$CLIENT_ID" \
  --use-cognito-provided-values --region us-east-1

# 2. Switch domain to Managed Login v2
AWS_PROFILE=oldforest aws cognito-idp update-user-pool-domain \
  --domain "auth-165395066552" --user-pool-id "$USER_POOL_ID" \
  --managed-login-version 2 --region us-east-1
```

**DNS:** After the first apply, point the `oldforest.net` and `www.oldforest.net` Route 53 A/AAAA alias records to the new CloudFront domain (`terraform output cloudfront_domain`).

**First admin user:**
```bash
aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username you@example.com \
  --temporary-password "TempPass123!" \
  --region us-east-1 --profile oldforest

aws cognito-idp admin-add-user-to-group \
  --user-pool-id "$USER_POOL_ID" \
  --username you@example.com \
  --group-name admins \
  --region us-east-1 --profile oldforest
```
