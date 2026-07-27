# Security Audit — oldforest.net

> Principal Application Security Engineer + Abuse Prevention review.
> Scope: all Lambda functions, Terraform infrastructure, and frontend HTML.
> Date: 2026-07-26

---

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
