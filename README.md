# oldforest.net

A fully serverless blog, reading log, and community platform hosted on AWS. All infrastructure is defined in Terraform, deployments are automated via GitHub Actions, and there is no web server — the frontend is static HTML served from S3 through CloudFront.

---

## Architecture

```
Browser
  │
  ├─▶ CloudFront (CDN + HTTPS)
  │     ├─▶ /images/*                → S3 content bucket  (uploaded media)
  │     ├─▶ /v1/feed.xml             → API Gateway  (cached 15 min)
  │     ├─▶ /v1/proxy/librarything   → API Gateway  (cached 1 hr)
  │     ├─▶ /v1/*                    → API Gateway HTTP API  (uncached)
  │     │                                  └─▶ Lambda (Node.js 20 ES modules)
  │     │                                        ├─▶ DynamoDB  (posts, apps, books, reads)
  │     │                                        ├─▶ S3        (post content, images)
  │     │                                        ├─▶ Cognito   (user management)
  │     │                                        └─▶ LibraryThing API (via SSM-held key)
  │     └─▶ default                  → S3 site bucket  (HTML, JS, favicon)
  │
  └─▶ Cognito Managed Login v2 (auth redirect, passkey + TOTP capable)

Calibre (desktop)
  └─▶ Cognito Managed Login v2 (loopback PKCE) ─▶ /v1/reading/books
```

**AWS services used:** CloudFront, S3 (×2), API Gateway HTTP API v2, Lambda (×15), DynamoDB (×4), Cognito User Pool, SSM Parameter Store, ACM, IAM, CloudFront Functions.

---

## Repository layout

```
.
├── site/                       # Static frontend (deployed to S3)
│   ├── index.html              # Public blog home + "currently reading"
│   ├── post.html               # Individual post view
│   ├── profile.html            # User profile / password change
│   ├── apps.html               # Apps directory page
│   ├── books/
│   │   ├── index.html          # Book library (search, tags, sort)
│   │   └── book.html           # Book detail + reads
│   ├── apps/
│   │   ├── booktimeline/       # Reading history timeline (vis-timeline)
│   │   ├── bookcsvgen/         # Yearly stats + CSV export
│   │   └── reading-log/        # Book/read editor (editors group)
│   ├── download.html           # Gated-download redirect page
│   ├── editor/index.html       # Post editor (editors group)
│   ├── admin/index.html        # Admin dashboard (admins group)
│   ├── js/
│   │   ├── util.js             # esc, safeUrl, seriesLabel, starsHtml, dates
│   │   └── auth.js             # Shared Cognito PKCE helpers
│   └── favicon.svg
│
├── src/
│   ├── functions/              # Lambda source (one directory per function)
│   │   ├── list-posts/  get-post/  create-post/  update-post/  delete-post/
│   │   ├── profile/  upload-url/  rss-feed/
│   │   ├── list-apps/  admin-apps/  admin-files/  admin-users/
│   │   ├── reading-log/        # Books + reads CRUD
│   │   ├── download-url/        # Presigned GET for gated files
│   │   └── lt-proxy/           # LibraryThing API proxy
│   └── shared/                 # Bundled into function zips by lambdas.tf
│       ├── auth.mjs            # Cognito group parsing, requireEditor/requireAdmin
│       └── http.mjs            # Shared response/CORS helpers
│
├── calibre-plugin/             # Calibre plugin — push books to the reading log
│   └── README.md               # Build, install, matching rules, security notes
│
├── infra/                      # Terraform (all AWS infrastructure)
│   ├── main.tf                 # Provider, S3 backend, SSM parameter
│   ├── variables.tf  outputs.tf  terraform.tfvars
│   ├── s3.tf                   # Site + content buckets, public access blocks
│   ├── cloudfront.tf           # Distribution, OAC, security headers, www redirect
│   ├── cognito.tf              # User pool, groups, web + plugin app clients, domain
│   ├── dynamodb.tf             # posts, apps, books, reads tables
│   ├── lambdas.tf              # Archive packaging + Lambda functions
│   ├── api.tf                  # HTTP API, JWT authorizer, routes, integrations
│   └── iam.tf                  # Per-function IAM roles and policies
│
├── scripts/                    # Deploy + one-off data migration tooling
│   ├── deploy.sh               # Primary deploy path (see below)
│   ├── publish-plugin.sh       # Build + publish the Calibre plugin
│   └── …                       # LibraryThing/Calibre/Joomla import + cleanup scripts
│
├── docs/
│   └── reading-log-design.md   # Reading log data model + API design
│
└── .github/workflows/
    └── deploy.yml              # CI/CD: terraform apply + S3 sync on push to main
```

---

## Documentation

| Document | Covers |
|----------|--------|
| `README.md` | This file — structure, deployment, setup |
| `DESIGN.md` | Full architecture and design rationale |
| `docs/reading-log-design.md` | Reading log data model, API, LibraryThing migration |
| `calibre-plugin/README.md` | Calibre plugin build, usage, matching rules |
| `TERRAFORM_MIGRATION.md` | One-time bootstrap + manual post-apply steps |
| `SECURITY_AUDIT.md` | Security review findings and remediation status |
| `CODE_REVIEW.md` | Code quality review findings and status |

---

## Frontend pages

| Page | Path | Access |
|------|------|--------|
| Blog home | `/` | Public |
| Post | `/post.html?slug=…` | Public (members-only posts require login) |
| Books | `/books/` | Public |
| Book detail | `/books/book.html?id=…` | Public (editing requires `editors`) |
| Book timeline | `/apps/booktimeline/` | Public |
| Stats & CSV | `/apps/bookcsvgen/` | Public |
| Apps | `/apps.html` | Public (some cards may require login) |
| Profile | `/profile.html` | Authenticated users |
| Reading log editor | `/apps/reading-log/` | `editors` group |
| Editor | `/editor/` | `editors` group |
| Admin | `/admin/` | `admins` group |

All pages use PKCE OAuth2 — users are redirected to Cognito Managed Login and returned with a short-lived access token in `sessionStorage`. Shared PKCE logic lives in `site/js/auth.js`.

---

## Lambda functions

### Public API (`/v1/…`)

**`list-posts`** — `GET /v1/posts`
Scans DynamoDB (paginated) for published, non-personal posts. Also serves `GET /v1/editor/posts` (editors only), returning drafts and the caller's own personal posts.

**`get-post`** — `GET /v1/posts/{slug}`
Fetches post metadata by slug, then the Markdown body from S3. Also serves `GET /v1/posts/members/{slug}` for members-only posts. Strips `authorSub` and `contentKey` from responses.

**`list-apps`** — `GET /v1/apps`
Returns enabled apps sorted by `order`. Visibility filtering happens client-side by group.

**`rss-feed`** — `GET /v1/feed.xml`
RSS 2.0 feed of the 20 most recent public published posts. Cached 15 minutes at CloudFront.

**`lt-proxy`** — `GET /v1/proxy/librarything`
Server-side proxy for the LibraryThing JSON API (avoids mixed-content/CORS). API key held in SSM. Cached 1 hour at CloudFront.

**`reading-log`** (read paths) — `GET /v1/reading/books`, `GET /v1/reading/books/{bookId}`, `GET /v1/reading/reads`
Public book library and reading history, with book metadata joined onto reads.

### Editor API (requires `editors` or `admins`)

**`create-post`** / **`update-post`** / **`delete-post`** — `POST|PUT|DELETE /v1/editor/posts[/{postId}]`
DynamoDB record plus the Markdown body in S3. Personal posts are editable only by their author.

**`upload-url`** — `POST /v1/editor/upload`
Returns a presigned S3 PUT URL for direct browser-to-S3 upload. Content-Type is derived server-side from an extension allowlist, never from caller input. Keys: `images/YYYY/MM/{uuid}-{name}.ext`.

**`reading-log`** (write paths) — `POST|PUT|DELETE /v1/reading/books[/{bookId}]`, `POST|PUT|DELETE /v1/reading/reads[/{readId}]`
Book and read CRUD. Deleting a book also removes its reads. Also the endpoint the Calibre plugin writes to.

### Profile API (`/v1/profile` — authenticated)

**`profile`** — `GET`, `PUT /v1/profile`, `POST /v1/profile/password`
Reads/updates Cognito attributes and handles password changes.

### Admin API (requires `admins`)

**`admin-files`** — `GET|DELETE /v1/admin/files`
Lists and deletes objects under `images/` in the content bucket.

**`admin-users`** — `GET|POST /v1/admin/users`, `PUT|DELETE /v1/admin/users/{username}`
Cognito user management: list, invite, update, delete, and group membership.

**`admin-apps`** — `GET|POST /v1/admin/apps`, `PUT|DELETE /v1/admin/apps/{appId}`
CRUD for the apps directory (name, description, icon, URL, visibility, order, enabled).

---

## User roles

| Group | Can do |
|-------|--------|
| (none) | Read public posts, books, and public apps |
| `members` | Read members-only posts and apps |
| `editors` | Everything above + create/edit/delete posts and books, upload images |
| `admins` | Everything above + manage users, files, and apps |

---

## Calibre plugin

Pushes book metadata from a [Calibre](https://calibre-ebook.com/) library straight into the reading log, so books don't have to be re-entered by hand.

**Download the latest build:** <https://oldforest.net/files/oldforest-books-plugin.zip> (also linked from the Apps page). Install via **Preferences → Plugins → Load plugin from file**.

Or build from source — the zip is gitignored, so it is produced locally:

```bash
bash calibre-plugin/build.sh --install    # build + install into calibre
bash calibre-plugin/build.sh              # build only → calibre-plugin/oldforest-books-plugin.zip
```

Publish a new release — **bump `PLUGIN_VERSION` in `calibre-plugin/__init__.py` first**, then:

```bash
AWS_PROFILE=oldforest bash scripts/publish-plugin.sh
```

This tests, builds, uploads the zip plus a version manifest, invalidates the CDN, and verifies what is served. It refuses to republish an already-published version (`FORCE=1` overrides). The installed plugin polls that manifest and shows an in-app notice when it is out of date.

Then **restart Calibre** (plugins are not loaded live). The action adds itself to the main toolbar and the book right-click menu on first launch.

Without `--install`, load the zip via **Preferences → Plugins → Load plugin from file**.

Configure and sign in under **Preferences → Plugins → Push to oldforest.net → Customize plugin**. Connection settings are pre-filled; sign-in opens a browser using loopback PKCE, so the plugin never sees your credentials. Your account needs the `editors` group.

See [`calibre-plugin/README.md`](calibre-plugin/README.md) for match/dedup rules, cover upload, tagging, and security notes.

> The plugin uses its **own** Cognito app client. A newly created client needs a one-time Managed Login branding record or sign-in fails with *"Login pages unavailable"* — see [One-time post-deploy steps](#one-time-post-deploy-steps).

---

## File hosting and downloads

Editors can upload a file and share a link, optionally requiring sign-in.

| | Public | Sign-in required |
|---|---|---|
| S3 prefix | `files/` | `private/` |
| Served by | CloudFront, cached | presigned URL, 2-minute expiry |
| Link shape | `/files/…` | `/download.html?key=…` |
| Bucket policy | readable by CloudFront | **not** readable by CloudFront |

**Uploading.** In the post editor, *Insert download button* uploads a file and drops a Markdown link at the cursor; tick *Require sign-in* first for a gated file. `post.html` styles any link to `/files/…` or `/download.html?…` as a button, prefixed ⬇ or 🔒. The admin **Files** tab lists everything across `images/`, `files/` and `private/`, flags gated files, and copies the correct shareable link per file.

**How gating works.** A plain `<a href>` cannot send an `Authorization` header, and tokens live in `sessionStorage` rather than cookies, so neither CloudFront nor S3 can see them. `/download.html` therefore reads the token in JS, calls `GET /v1/files/download` (JWT-gated), and forwards the browser to a short-lived presigned URL.

Two independent layers keep `private/` closed: the bucket policy never grants CloudFront read access to it, and the `download-url` Lambda refuses to presign any key outside `private/` — so a bug in either alone is not enough to expose a file. Its IAM role is likewise scoped to `private/*` only.

> Direct `/private/…` URLs return the site homepage rather than an error. That is the SPA 404 fallback, not a leak — the object is never fetched.

Allowed upload types: images, `pdf`, `txt`, `md`, `csv`, `json`, `zip`, `gz`, `epub`, `mobi`, `azw3`. Content-Type is derived server-side from the extension, never from the caller, which keeps script-capable types (`.html`, `.svg`) off the site entirely.

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
| `main.tf` | Provider, S3 backend, SSM parameter for the LibraryThing key |
| `s3.tf` | Site + content buckets, OAC bucket policies, public access blocks |
| `cloudfront.tf` | CDN distribution, cache behaviours, security headers (CSP/HSTS), www→apex redirect |
| `cognito.tf` | User pool (passkey + optional TOTP MFA), groups, web **and** Calibre plugin app clients, Managed Login domain |
| `dynamodb.tf` | `oldforest-posts`, `oldforest-apps`, `oldforest-books`, `oldforest-reads` |
| `lambdas.tf` | `archive_file` packaging (bundling `src/shared/`) + `aws_lambda_function` resources |
| `api.tf` | HTTP API v2, Cognito JWT authorizer, all routes and integrations |
| `iam.tf` | Least-privilege IAM role + inline policy per Lambda |

---

## Local development

**Prerequisites:** Terraform ≥ 1.10, AWS CLI ≥ 2.17, an AWS profile named `oldforest`. Calibre ≥ 6 only if working on the plugin.

### Deploying

`scripts/deploy.sh` is the normal path — it applies Terraform, syncs the site, and invalidates CloudFront:

```bash
AWS_PROFILE=oldforest bash scripts/deploy.sh              # everything
AWS_PROFILE=oldforest bash scripts/deploy.sh --skip-tf    # frontend only (no infra change)
AWS_PROFILE=oldforest bash scripts/deploy.sh --skip-sync  # infra only (no frontend change)
```

Review infrastructure changes before applying:

```bash
cd infra && AWS_PROFILE=oldforest terraform plan
```

### Tests

The Calibre plugin's pure logic self-tests without Calibre or Qt:

```bash
python3 calibre-plugin/metadata_map.py   # field mapping + match ranking
python3 calibre-plugin/covers.py         # image sniffing + upload flow
python3 calibre-plugin/updates.py        # version comparison
```

---

## CI/CD

Pushing to `main` triggers `.github/workflows/deploy.yml` which:

1. Authenticates to AWS via OIDC (no long-lived keys) using the `AWS_DEPLOY_ROLE_ARN` repository secret.
2. Runs `terraform init` + `terraform apply -auto-approve`.
3. Syncs `./site` to the S3 site bucket.
4. Invalidates the CloudFront cache.

**Required GitHub secret:** `AWS_DEPLOY_ROLE_ARN` — an IAM role trusting `token.actions.githubusercontent.com` with permission to manage everything in `infra/`.

---

## One-time post-deploy steps

Some things Terraform cannot fully configure. Full detail in `TERRAFORM_MIGRATION.md`.

### 1. Managed Login branding — required for **every** app client

Managed Login v2 serves sign-in pages per app client and answers *"Login pages unavailable"* for any client without a branding record. Run for the website **and** the Calibre plugin clients:

```bash
cd infra
USER_POOL_ID=$(AWS_PROFILE=oldforest terraform output -raw user_pool_id)

for CLIENT_ID in \
  "$(AWS_PROFILE=oldforest terraform output -raw user_pool_client_id)" \
  "$(AWS_PROFILE=oldforest terraform output -raw calibre_plugin_client_id)"
do
  AWS_PROFILE=oldforest aws cognito-idp create-managed-login-branding \
    --user-pool-id "$USER_POOL_ID" --client-id "$CLIENT_ID" \
    --use-cognito-provided-values --region us-east-1
done

# Switch the domain to Managed Login v2 (enables passkeys)
AWS_PROFILE=oldforest aws cognito-idp update-user-pool-domain \
  --domain "auth-165395066552" --user-pool-id "$USER_POOL_ID" \
  --managed-login-version 2 --region us-east-1
```

### 2. LibraryThing API key

`infra/main.tf` creates the SSM parameter with a `PLACEHOLDER` value and ignores later changes. The `lt-proxy` Lambda returns errors until the real key is set:

```bash
AWS_PROFILE=oldforest aws ssm put-parameter \
  --name /oldforest/lt_api_key --value "<key>" \
  --type SecureString --overwrite --region us-east-1
```

Redeploy the Lambda afterwards so it picks up the new value. Repeat after rotating the key.

### 3. DNS

Point the `oldforest.net` and `www.oldforest.net` Route 53 A/AAAA alias records at the CloudFront domain (`terraform output cloudfront_domain`).

### 4. First admin user

```bash
aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" --username you@example.com \
  --temporary-password "TempPass123!" --region us-east-1 --profile oldforest

aws cognito-idp admin-add-user-to-group \
  --user-pool-id "$USER_POOL_ID" --username you@example.com \
  --group-name admins --region us-east-1 --profile oldforest
```
