# oldforest.net — Serverless Blog Design Document

## Overview

A serverless blog hosted on AWS at **oldforest.net**. Features public and access-controlled posts, and a browser-based editor for creating and managing content.

---

## Architecture

### High-Level Stack

| Layer | Service |
|---|---|
| DNS | Route 53 |
| CDN / HTTPS | CloudFront |
| Frontend | S3 (static assets) |
| API | API Gateway + Lambda |
| Auth | Amazon Cognito |
| Content Storage | DynamoDB (metadata) + S3 (post body/assets) |
| Editor UI | Single-page app served from S3 |

### Request Flow

```
Browser
  └─▶ Route 53 (oldforest.net)
        └─▶ CloudFront
              ├─▶ S3 (static HTML/CSS/JS for public site + editor)
              └─▶ API Gateway
                    └─▶ Lambda functions
                          ├─▶ Cognito (auth validation)
                          ├─▶ DynamoDB (post metadata)
                          └─▶ S3 (post content)
```

---

## Data Model

### DynamoDB Table: `Posts`

| Attribute | Type | Description |
|---|---|---|
| `postId` | String (PK) | UUID |
| `slug` | String (GSI) | URL-friendly identifier |
| `title` | String | Post title |
| `summary` | String | Short excerpt shown in listings |
| `author` | String | Author display name |
| `createdAt` | String (ISO 8601) | Creation timestamp |
| `updatedAt` | String (ISO 8601) | Last edit timestamp |
| `status` | String | `published` \| `draft` |
| `visibility` | String | `public` \| `members` |
| `tags` | List\<String\> | Categorization tags |
| `contentKey` | String | S3 key for post body (Markdown) |
| `coverImageKey` | String | S3 key for cover image (optional) |

### S3 Buckets

| Bucket | Purpose |
|---|---|
| `oldforest-net-site` | Static site assets (CloudFront origin) |
| `oldforest-net-content` | Post Markdown bodies + uploaded images |

---

## Authentication

Powered by **Amazon Cognito User Pool**.

- Public posts are readable without authentication.
- Posts with `visibility: members` require a valid Cognito JWT in the `Authorization` header.
- The editor is entirely behind authentication — only users in the `editors` Cognito group can create or modify posts.
- Auth flow: Cognito Hosted UI or custom login page → JWT tokens → stored in memory (not localStorage) for the session.

### User Roles

| Role | Cognito Group | Permissions |
|---|---|---|
| Visitor | — | Read public posts |
| Member | `members` | Read public + members-only posts |
| Editor | `editors` | All member permissions + create/edit/delete posts |

---

## API Design

Base path: `https://api.oldforest.net/v1`

### Public Endpoints (no auth required)

| Method | Path | Description |
|---|---|---|
| GET | `/posts` | List published public posts (paginated) |
| GET | `/posts/{slug}` | Get a single public post |

### Authenticated Endpoints (Cognito JWT required)

| Method | Path | Required Group | Description |
|---|---|---|---|
| GET | `/posts/members` | `members` | List published members-only posts |
| GET | `/posts/members/{slug}` | `members` | Get a single members-only post |
| GET | `/editor/posts` | `editors` | List all posts (all statuses/visibility) |
| GET | `/editor/posts/{postId}` | `editors` | Get post for editing |
| POST | `/editor/posts` | `editors` | Create a new post |
| PUT | `/editor/posts/{postId}` | `editors` | Update a post |
| DELETE | `/editor/posts/{postId}` | `editors` | Delete a post |
| POST | `/editor/upload` | `editors` | Get a presigned S3 URL for image upload |

---

## Frontend

### Public Site

- Statically generated or rendered from API calls at page load.
- Pages: Home/listing, individual post, login/signup.
- Posts rendered from Markdown (e.g., using `marked.js` in-browser or pre-rendered at publish time).
- Members-only posts show a "login to read" gate if the user is not authenticated.

### Browser-Based Editor

A single-page app at `oldforest.net/editor` (or `editor.oldforest.net`).

**Features:**
- Login wall — redirects to Cognito login if no valid session.
- Post list view — shows all posts with status, visibility, and last-updated date.
- Post editor:
  - Title, slug (auto-generated, editable), summary, tags fields.
  - Visibility toggle: **Public** / **Members only**.
  - Status toggle: **Draft** / **Published**.
  - Markdown editor with live preview (e.g., using [EasyMDE](https://github.com/Ionaru/easy-markdown-editor)).
  - Image upload via presigned S3 URL, with auto-inserted Markdown link.
  - Save (draft) and Publish buttons.
- Delete post with confirmation.

---

## Infrastructure as Code

All AWS resources defined with **AWS SAM** (or CDK as an alternative).

Key resources:
- Cognito User Pool + App Client
- DynamoDB table with GSI on `slug`
- S3 buckets (site, content) with appropriate bucket policies
- Lambda functions (Node.js 20.x or Python 3.12)
- API Gateway (HTTP API for lower cost/latency)
- CloudFront distributions
- Route 53 records for `oldforest.net` and `api.oldforest.net`
- ACM certificate (us-east-1 for CloudFront)

---

## Security Considerations

- All S3 content bucket objects are **private**; Lambda generates presigned URLs for content delivery to authenticated users.
- Public post Markdown can be served directly via CloudFront with a public S3 path.
- API Gateway validates Cognito JWTs via a Cognito authorizer — no custom token verification needed in Lambda.
- CORS configured on API Gateway to allow only `oldforest.net` origin.
- Editor UI served over HTTPS only; no mixed content.
- Cognito MFA optional but recommended for editor accounts.

---

## Deployment Pipeline

1. Code pushed to GitHub (`main` branch).
2. GitHub Actions runs lint/tests.
3. On success, SAM `build` + `deploy` to AWS.
4. Frontend assets synced to S3, CloudFront cache invalidated.

### AWS Authentication

The pipeline authenticates to AWS using a **named profile** rather than hardcoded access keys. The profile name is stored as a GitHub Actions secret (`AWS_PROFILE`) and the credentials file is configured in the runner environment.

**Recommended approach — OIDC (preferred):**  
Use GitHub Actions' native AWS OIDC federation so no long-lived credentials are stored at all. The workflow assumes an IAM role via `aws-actions/configure-aws-credentials`, which internally resolves to a named profile:

```yaml
- name: Configure AWS credentials
  uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: arn:aws:iam::${{ secrets.AWS_ACCOUNT_ID }}:role/GitHubActionsDeployRole
    aws-region: us-east-1
```

**Alternative — profile from credentials file:**  
If OIDC is not available, write a `~/.aws/credentials` file in the workflow and pass `--profile` to SAM and AWS CLI commands:

```yaml
- name: Write AWS profile
  run: |
    mkdir -p ~/.aws
    echo "[oldforest]" >> ~/.aws/credentials
    echo "aws_access_key_id=${{ secrets.AWS_ACCESS_KEY_ID }}" >> ~/.aws/credentials
    echo "aws_secret_access_key=${{ secrets.AWS_SECRET_ACCESS_KEY }}" >> ~/.aws/credentials

- name: Deploy
  run: |
    sam build
    sam deploy --profile oldforest
    aws s3 sync ./site s3://oldforest-net-site --profile oldforest
    aws cloudfront create-invalidation --distribution-id ${{ secrets.CF_DISTRIBUTION_ID }} \
      --paths "/*" --profile oldforest
  env:
    AWS_DEFAULT_REGION: us-east-1
```

All SAM and AWS CLI commands in the pipeline must include `--profile <name>` (or rely on `AWS_PROFILE` env var) so the correct credential set is used consistently. The profile name (`oldforest`) should be consistent across local development and CI.

---

## Future Considerations

- RSS/Atom feed endpoint.
- Comment system (e.g., via a separate Lambda + DynamoDB table, or a third-party like Giscus).
- Full-text search via OpenSearch Serverless or DynamoDB + Lambda search.
- Email notifications to members on new post via SES + SNS.
- Post scheduling (publish at future date via EventBridge).
