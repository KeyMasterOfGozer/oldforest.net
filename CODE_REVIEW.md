# Code Review — oldforest.net

> Principal engineer review. Focus: quality, tidiness, maintainability.
> Round 1 files covered: `site/apps/reading-log/index.html`, `src/functions/reading-log/index.mjs`,
> `scripts/backfill-lt-fields.mjs`, `scripts/import-calibre-series.mjs`
> Round 2 (2026-07-30): full pass — all `src/functions/*`, `src/shared/auth.mjs`, all `infra/*.tf`,
> all `site/**/*.html` + `site/js/util.js`. No cost/billing impact from any Round 2 finding —
> this is organization and resilience, not infrastructure scaling. Called out per-item below
> where relevant.

---

# Round 2 — 2026-07-30

## Critical Issues

### R2-1 — `create-post`, `update-post`, `delete-post` have no top-level `try/catch`; an AWS SDK error crashes the Lambda unhandled

**Location:** `src/functions/create-post/index.mjs`, `src/functions/update-post/index.mjs`, `src/functions/delete-post/index.mjs`

Confirmed by grep: each file has exactly one `catch` block, and it only wraps `requireEditor(event)`:

```js
export const handler = async (event) => {
  try {
    requireEditor(event);
  } catch (e) {
    return { statusCode: e.statusCode, body: JSON.stringify({ message: e.message }) };
  }
  // everything below — S3 PutObject, DynamoDB PutCommand/UpdateCommand — is unguarded
  const item = { postId, slug: body.slug, title: body.title, ... };
  await dynamo.send(new PutCommand({ TableName: process.env.POSTS_TABLE, Item: item }));
  ...
};
```

Neither `create-post` nor `update-post` validates that `body.title`/`body.slug` are present (unlike `admin-apps`, which checks `name`/`url`, or `reading-log`, which checks `title`/`author`). `DynamoDBDocumentClient.from(new DynamoDBClient())` is constructed with default marshall options (`removeUndefinedValues: false`), so a `PutCommand`/`UpdateCommand` with an `undefined` field throws:

```
Pass options.removeUndefinedValues=true to remove undefined values from map/array/set.
```

A `POST /v1/editor/posts` from a valid editor session that simply omits `title` or `slug` — an easy client bug, not an attack — crashes the Lambda outright: no clean `{message: ...}` JSON, no CORS headers on the response (the crash happens before the response object is built), so the browser reports a CORS failure that masks the real 500. Every other Lambda in this codebase (`admin-apps`, `admin-files`, `admin-users`, `reading-log`, `list-apps`, `lt-proxy`, `rss-feed`) wraps its body in try/catch and returns `fail(500, 'Internal server error')`. These three don't.

`delete-post` has the same missing-try/catch structure; it takes no body input so the `undefined`-marshalling crash doesn't apply, but a transient S3/DynamoDB error (throttling, network blip) still crashes it unhandled instead of returning a clean 500.

**Fix:** see Refactored Snippet A.

---

### R2-2 — Full PKCE/auth/token-refresh stack duplicated across up to 7 HTML pages

**Location:** `site/index.html`, `site/apps.html`, `site/profile.html`, `site/admin/index.html`, `site/editor/index.html`, `site/books/index.html`, `site/books/book.html` (and a smaller read-only subset in `site/post.html`)

`b64url()`, `generatePKCE()`, `login()`, `logout()`, `parseJWT()`, token-expiry checks, and `refreshTokens()`/`apiFetch()` are copy-pasted near-verbatim — 70 to 120 lines per file. This is the same shared-helper gap `util.js` already exists to solve for `esc()`/`safeUrl()`/`seriesLabel()`, just not applied to the much larger auth surface. It has already produced observable drift, not just theoretical risk:

- `index.html` guards against clobbering a pending deep link: `if (!sessionStorage.getItem('return_to')) sessionStorage.setItem('return_to', ...)`.
- `apps.html` does not: `sessionStorage.setItem('return_to', window.location.href);` unconditionally.

A user redirected to sign-in mid-flow from `apps.html` silently loses any previously stored deep-link intent. A fix applied to one copy doesn't reach the other six.

**Fix:** extract to `site/js/auth.js`, loaded the same way `util.js` already is.

---

### R2-3 — Unpaginated DynamoDB Scans in `list-posts` and `rss-feed` will silently drop content past ~1MB

**Location:** `src/functions/list-posts/index.mjs`, `src/functions/rss-feed/index.mjs`

Both issue a single `ScanCommand` and use whatever page DynamoDB returns, with no `LastEvaluatedKey` loop. `reading-log`'s `listReads` (full-scan branch) does this correctly:

```js
// reading-log/index.mjs — correct pattern, already in this codebase
let lastKey;
do {
  const result = await dynamo.send(new ScanCommand({ TableName: READS_TABLE, ExclusiveStartKey: lastKey }));
  reads.push(...(result.Items ?? []));
  lastKey = result.LastEvaluatedKey;
} while (lastKey);
```

`list-posts` and `rss-feed` don't loop. DynamoDB `Scan` truncates at ~1MB per call and returns whatever arbitrary subset fit — not guaranteed to be the newest posts. Once the `posts` table crosses that size, both the post list and the RSS feed can silently omit real, published posts with no error surfaced anywhere — this gets worse as the blog grows, and nothing will flag it when it starts happening.

**Fix:** apply the same `ExclusiveStartKey` loop already used in `reading-log`.

---

### R2-4 — Modal/dialog rendering hand-duplicated per entity type in `admin/index.html`

**Location:** `site/admin/index.html` — `confirmDeleteFile` (~503-516), `openModal` for users (~599-664), `openAppModal` for apps (~851-881)

Three separate implementations of "write title/body/actions into the modal shell and open it," one per entity type (files/users/apps). Adding a fourth admin entity means copy-pasting a fourth time. A single parameterized `showModal({ title, bodyHtml, actionsHtml })` collapses all three.

---

## Minor Polish

- **`esc()` reimplemented independently in 4 places**, each missing different escape rules, despite `/js/util.js` already centralizing a correct version: `site/apps.html` (never loads util.js), `site/admin/index.html` (never loads util.js; local copy drops the `'` → `&#39;` rule), `site/editor/index.html` (loads util.js, then immediately shadows it with a weaker local `esc()` missing the same rule), `site/apps/bookcsvgen/index.html` (never loads util.js; drops `"`/`'`). `site/editor/index.html:750` has a *third*, even-weaker inline variant that only escapes `&`/`<`. Note: `rss-feed/index.mjs`'s `esc()` is legitimately separate — it escapes to XML entities (`&apos;`), a different output format, not a duplicate.
- **Star-rating rendering reimplemented 3 times** with 3 different names/rounding: `stars()` in `booktimeline/index.html`, `starsHtml()` in `books/index.html`, `starsHtml()` in `book.html`.
- **Date parsing/formatting reimplemented 3 times**, each separately working around timezone shift: `isoToDate()` in `booktimeline/index.html`, `parseDate()` in `bookcsvgen/index.html`, `formatDate()` in `book.html`.
- **Every backend Lambda defines its own JSON response wrapper** with a different name/signature — `ok`/`fail` (admin-apps), `ok`/`err` (admin-files), `ok`/`errRes` (admin-users), `ok`/`err` (reading-log) — plus a repeated, byte-identical `CORS` constant in each file. `get-post`/`list-posts`/`rss-feed`/`lt-proxy`/`profile` skip the helper entirely and return raw literals inline. Move to `src/shared/http.mjs` next to `auth.mjs`.
- `admin-users`'s `GET /v1/admin/users` makes one `AdminListGroupsForUserCommand` call per user via `Promise.all` — an N+1 pattern against the Cognito API. Fine at current scale (capped at 60 users), will start hitting Cognito throttling as the user base grows.
- `site/editor/index.html`: `fetchPost()` is defined but never called — `loadPostContent()` calls `apiFetch` directly instead. Dead code.
- `site/books/book.html`: `let editBookRating = 0;  // unused but reserved` — dead, self-admitted in its own comment.
- `site/profile.html`'s `refreshTokens`/`apiFetch` leave unconditional `console.log` of token expiry/claims on every page load and every API call — reads like leftover debugging instrumentation, never gated behind a debug flag.
- `site/index.html`'s `applyFilter` runs a DOM class-toggle loop over `.tag-cloud-item` whose effect is immediately discarded — the very next line, `buildTagCloud(allPosts)`, fully overwrites `#tag-cloud-inner.innerHTML`. Dead-in-effect code with a fragile `textContent.startsWith(tag || '\0')` match that never gets a chance to matter.
- Unhandled clipboard-write promises: `site/admin/index.html:497` and `site/editor/index.html:787` both call `navigator.clipboard.writeText(...)` and fire a "URL copied!" toast unconditionally, without `await`/`.catch()` — the toast lies if the write is rejected (permissions, non-secure context).
- `site/editor/index.html`'s `loadPostContent` silently blanks the editor to `''` on any fetch failure (network blip, transient 500). If the user then clicks Save, the real post content is overwritten with an empty string — a narrow but real data-loss path with no warning.
- `site/books/index.html`'s `loadData()` treats a failed `/v1/reading/books` fetch as a hard error, but a failed `/v1/reading/reads` fetch silently continues with an empty read map — two sibling API calls in the same function, two different failure-handling policies, no indication to the user that ratings/read-counts are missing due to an error rather than genuinely absent data.
- `src/functions/profile/index.mjs`: `event.requestMethod || event.httpMethod || event.requestContext?.http?.method` — the first two properties never exist on an API Gateway HTTP API v2 payload; dead fallback clutter that always resolves through the third clause.
- `site/books/book.html`'s login flow hardcodes `redirect_uri` back to `/books/`; signing in from a specific book's detail page returns the user to the books list, not the book they were viewing.
- Global mutable state (`accessToken`, `allPosts`/`allBooks`/`allApps`, filter/sort state) is read and written directly by 8-10 functions per page across `index.html`, `apps.html`, `books/index.html`, `booktimeline/index.html`. None of this is unit-testable without reconstructing the full global/DOM setup — not urgent to fix on a static site with no test suite, but worth naming as the reason a future test suite would be expensive to write.
- **Terraform (`iam.tf`/`lambdas.tf`/`api.tf`):** an almost-identical ~15-line block (IAM role + policy attachment + policy + Lambda permission + integration) repeats per Lambda, 14 times. A `for_each`-driven module would collapse this, but it's a real migration exercise (`terraform state mv` per resource to avoid destroy/recreate) — not urgent given the current file works and changes infrequently. **No AWS cost either way**; the risk is operational (a botched `state mv` sequence could cause a brief window where a role doesn't exist), not financial.

---

## Refactored Snippet

### A: Give `create-post`/`update-post`/`delete-post` a real error boundary + required-field validation

```js
// src/functions/create-post/index.mjs
import { requireEditor } from './auth.mjs';

function fail(status, message) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) };
}

export const handler = async (event) => {
  try { requireEditor(event); }
  catch (e) { return fail(e.statusCode ?? 403, e.message ?? 'Forbidden'); }

  try {
    const claims = event.requestContext.authorizer.jwt.claims;
    const body = JSON.parse(event.body ?? '{}');
    if (!body.slug?.trim())  return fail(400, 'slug is required');
    if (!body.title?.trim()) return fail(400, 'title is required');

    const postId = randomUUID();
    const now = new Date().toISOString();
    const contentKey = `posts/${postId}/body.md`;

    await s3.send(new PutObjectCommand({
      Bucket: process.env.CONTENT_BUCKET, Key: contentKey,
      Body: body.content ?? '', ContentType: 'text/markdown',
    }));

    const item = {
      postId, slug: body.slug.trim(), title: body.title.trim(),
      summary: body.summary ?? '', author: body.author ?? '',
      authorSub: claims.sub, createdAt: now, updatedAt: now,
      status: body.status ?? 'draft', visibility: body.visibility ?? 'public',
      tags: body.tags ?? [], thumbnail: body.thumbnail ?? '', contentKey,
    };
    await dynamo.send(new PutCommand({ TableName: process.env.POSTS_TABLE, Item: item }));

    return { statusCode: 201, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item) };
  } catch (e) {
    console.error('create-post error:', e);
    return fail(500, 'Internal server error');
  }
};
```

Apply the same shape (validate required fields, wrap the body in try/catch, log-then-return-clean-500) to `update-post` and `delete-post`.

### B: Sketch of a shared `site/js/auth.js` to kill the 7-file PKCE duplication

```js
// site/js/auth.js — one copy, loaded via <script src="/js/auth.js"> after util.js
function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
async function generatePKCE() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}
function parseJWT(token) {
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))); }
  catch { return {}; }
}
// login(cfg) always guards return_to so a pending deep link is never clobbered —
// the one behavior that had already drifted between index.html and apps.html.
async function login(cfg) {
  const { verifier, challenge } = await generatePKCE();
  sessionStorage.setItem('pkce_verifier', verifier);
  if (!sessionStorage.getItem('return_to')) sessionStorage.setItem('return_to', window.location.href);
  const p = new URLSearchParams({
    response_type: 'code', client_id: cfg.clientId, redirect_uri: cfg.redirectUri,
    scope: 'openid email profile aws.cognito.signin.user.admin',
    code_challenge_method: 'S256', code_challenge: challenge,
  });
  window.location.href = `https://${cfg.cognitoDomain}/oauth2/authorize?${p}`;
}
function logout(cfg) {
  sessionStorage.clear();
  const p = new URLSearchParams({ client_id: cfg.clientId, logout_uri: cfg.redirectUri });
  window.location.href = `https://${cfg.cognitoDomain}/logout?${p}`;
}
// refreshTokens/apiFetch would follow the same pattern, parameterized on `cfg`.
```

Every page keeps its own `CFG` object (client ID, redirect URI already differ legitimately per page) and calls `login(CFG)`/`logout(CFG)` instead of carrying its own copy of the implementation.

---

## Round 2 TODO Checklist

- [x] **[CRITICAL]** Add top-level try/catch + required-field validation to `create-post`, `update-post`, `delete-post` — fixed 2026-07-30
- [x] **[CRITICAL]** Extract PKCE/auth/token-refresh stack to `site/js/auth.js`; update all 7 pages to use it — fixed 2026-07-30 (b64url/generatePKCE/parseJWT/login/logout/exchangeCode consolidated; per-page refresh/apiFetch orchestration deliberately left as-is, see note below)
- [x] **[CRITICAL]** Add `ExclusiveStartKey` pagination loop to `list-posts` and `rss-feed` Scans — fixed 2026-07-30
- [x] **[CRITICAL]** Replace per-entity modal duplication in `admin/index.html` with one parameterized `showModal()` — fixed 2026-07-30, verified live
- [x] **[MEDIUM]** Consolidate `esc()` — remove the 4 reimplementations, make every page load `/js/util.js` — fixed 2026-07-30 (also found and fixed a 5th instance in post.html missed by the original review)
- [x] **[MEDIUM]** Move `stars()`/`starsHtml()` rating rendering into `util.js` — fixed 2026-07-30, verified live
- [x] **[MEDIUM]** Move date parsing/formatting (`isoToDate`/`parseDate`/`formatDate`) into `util.js` — fixed 2026-07-30 as `parseISODate()` + `fmtShortDate()` (kept as two functions, not merged — they anchor to different timezones on purpose, see code comment). Verified live.
- [x] **[MEDIUM]** Consolidate backend response helpers (`ok`/`err`/`fail`/`errRes`) + `CORS` constant into `src/shared/http.mjs` — fixed 2026-07-30 for the 8 lambdas that had a named helper or CORS constant to deduplicate; get-post/list-posts/rss-feed/lt-proxy/profile intentionally left alone (no existing duplication there to remove)
- [x] **[LOW]** Remove dead `fetchPost()` in `editor/index.html` — fixed 2026-07-30
- [x] **[LOW]** Remove dead `editBookRating` in `books/book.html` — fixed 2026-07-30
- [x] **[LOW]** Remove unconditional debug `console.log`s from `profile.html` — fixed 2026-07-30
- [x] **[LOW]** Remove dead-in-effect tag-cloud loop in `index.html`'s `applyFilter` — fixed 2026-07-30
- [x] **[LOW]** Add `.catch()` (or await + check) to clipboard-write calls in `admin/index.html` and `editor/index.html` — fixed 2026-07-30
- [x] **[LOW]** Surface a toast/warning in `editor/index.html`'s `loadPostContent` catch instead of silently blanking the editor — fixed 2026-07-30
- [x] **[LOW]** Make `books/index.html`'s reads-fetch failure surface the same way its books-fetch failure does — fixed 2026-07-30 (non-fatal toast, matches severity — books still render)
- [x] **[LOW]** Remove dead `event.requestMethod || event.httpMethod` fallbacks in `profile/index.mjs` — fixed 2026-07-30
- [x] **[LOW]** Fix `book.html` login `redirect_uri` to return to the specific book, not `/books/` — fixed 2026-07-30 via return_to handling added to books/index.html's init() (Cognito's callback URI is fixed to /books/, so this hop is the only way back to the specific book)
- [ ] **[LOW]** Consider a `for_each`-driven Terraform module for the per-Lambda IAM/API Gateway boilerplate (14x repeated block) — no cost impact, real migration effort — DEFERRED, not done: pure reorganization with real state-migration risk (terraform state mv) and zero functional benefit

---

# Round 1 — 2026-07-26

## Critical Issues

### 1. DEBUG console.log statements in production Lambda (`reading-log/index.mjs` lines 46–47)

```js
// MUST REMOVE — logs full JWT claims on every editor API call
console.log('DEBUG isEditor claims:', JSON.stringify(claims));
console.log('DEBUG groups value:', JSON.stringify(groups), 'type:', typeof groups);
```

These are live in the deployed Lambda. Every `PUT`, `POST`, or `DELETE` from the editor
dumps the raw token claims to CloudWatch. This is a **PII/security exposure** (email,
sub, group membership) and will inflate log costs over time. Remove immediately.

---

### 2. `isEditor` uses `String.prototype.includes` — substring match, not element match

```js
const groups = claims['cognito:groups'] ?? '';
return groups.includes('editors') || groups.includes('admins');
```

If `groups` is a string (Cognito occasionally returns a comma-separated string), then
`'non-editors'.includes('editors')` returns `true`. A group named `"non-editors"` or
`"ex-admins"` would pass the check. Fix: always coerce to an array before testing.

```js
const raw    = claims['cognito:groups'] ?? '';
const groups = Array.isArray(raw) ? raw : raw.split(',').map(g => g.trim()).filter(Boolean);
return groups.includes('editors') || groups.includes('admins');
```

---

### 3. `deleteBook` uses GSI for reads; `getBook` uses Scan — they disagree on which reads exist

`getBook` has this comment:
> "Scan with filter instead of querying the byBook GSI — the GSI uses 'finished' as its
> sort key, so reads without a finish date are excluded from the index."

`deleteBook` queries that same GSI:
```js
const readsResult = await dynamo.send(new QueryCommand({
  TableName: READS_TABLE,
  IndexName: 'byBook',          // <-- misses reads with no finished date
  ...
}));
```

**Result: books with in-progress reads (no `finished` date) will have those reads orphaned
in DynamoDB after a delete.** Either GSI should be redesigned so all reads are indexed
(use a constant sort key instead of `finished`), or `deleteBook` should also use a Scan
with filter, the same way `getBook` does.

---

### 4. `amzScore` defined inside `searchAmazon` — re-created on every call

```js
async function searchAmazon(title, author, container) {
  ...
  function amzScore(doc) { ... }   // new function object on every searchAmazon call
  items.sort((a, b) => amzScore(b) - amzScore(a));
```

Inner function definitions inside async functions are allocated fresh on every invocation.
This is also invisible to anyone reading the file from top to bottom, since `amzScore`
is sandwiched inside `searchAmazon`'s body. Move it to module scope next to
`isbn13ToIsbn10`.

---

### 5. `renderSearchResults` mutates the doc objects it's about to serialize

```js
if (doc._source === 'amz') {
  ...
  doc._amzLabel = hasBcode ? 'AMZ ✓' : hasId ? 'AMZ' : 'AMZ';   // mutation
}
...
container.dataset.results = JSON.stringify(items);   // serializes the mutation
```

The function mutates `doc` in place, then serializes the mutated array. `applySearchResult`
then deserializes this JSON. The mutation is intentional but invisible: it looks like a
local render concern but is actually persisting state through the dataset string. This
also means `doc._amzLabel` and `doc._amzLabel` are two different properties that can
diverge if the render logic is ever touched.

The cleanest fix: compute `badgeLabel` as a local variable without touching `doc`.

---

### 6. Four `apply*Result` functions are ~70% duplicate DOM write code (DRY violation)

`applyOLResult`, `applyGBResult`, `applyAmazonResult`, `applyGoodreadsResult` all:
- extract `thumb`, `isbn13`, `olKey`
- write `f-title`, `f-author` unconditionally
- write `f-pages`, `f-isbn`, `f-olid` conditionally
- check `f-cover` before writing it
- call `updateCoverPreview()` and `toast()`

The only differences are: where the data comes from (OL vs GB shape), and which
ID-specific field gets populated. The refactored snippet below consolidates this.

---

### 7. After creating a new book, `allBooks` is sorted by title regardless of current sort settings

```js
} else {
  const { book } = await api('POST', '/v1/reading/books', payload);
  ...
  allBooks.sort((a,b) => a.title.localeCompare(b.title));   // ignores sortField/sortDir
```

The left panel respects `sortField`/`sortDir`, but after creation the backing array is
sorted by title. This doesn't affect the rendered filtered list (which calls
`applyFilter()` → `compareBooks()`), but is a latent bug if anything iterates `allBooks`
directly expecting consistent order. Fix: remove the manual sort; `applyFilter` already
re-sorts via `compareBooks`.

---

### 8. `deleteBook` in the Lambda has no check that the book exists before deleting reads

```js
async function deleteBook(event) {
  const readsResult = await dynamo.send(new QueryCommand({ ... }));  // query reads
  // ... delete reads ...
  await dynamo.send(new DeleteCommand({ TableName: BOOKS_TABLE, Key: { bookId } }));
```

There's no `ConditionExpression: 'attribute_exists(bookId)'` on the `DeleteCommand`, and
no pre-flight `GetCommand`. A DELETE to a non-existent `bookId` will silently return 200.
The reads query will return nothing (no orphan cleanup to do), and the DeleteCommand will
succeed vacuously. The response will be `{ deleted: bookId }` even though nothing existed.

---

### 9. `#gb-results` is a stale ID — it now serves 4 sources, not just Google Books

The element `<div id="gb-results">`, its CSS, its JS variable `gbResults`, and the
`container.dataset.results` key are all named for Google Books. The UI now has
OpenLibrary, Google Books, Amazon, and Goodreads tabs. This will confuse any future
reader who opens the file, and it's the kind of thing that bites when someone searches
for "gb" in the codebase.

Rename to `#search-results` / `searchResults` throughout.

---

## Minor Polish

- **`badge-ol2` and `badge-gb2` are duplicates of `badge-ol` and `badge-gb`** (same
  colors). They exist only to distinguish "search result badge" from "link badge" context.
  Either unify them or document the intentional split.

- **`hasId = true` as default in `renderSearchResults`** — if a new source is added
  without updating the `if` chain, it silently gets `hasId = true` (no dimming). Invert
  the default: start `hasId = false` and require sources to explicitly opt in. Or better,
  use a source-keyed map of extractor functions (see refactored snippet).

- **`parseFloat(best.series_index) || 1`** in `import-calibre-series.mjs` line 275:
  if `series_index` is `"0"` (index zero, technically valid for a prequel), this
  returns `1`. Use `?? 1` after `parseFloat` with a NaN check instead:
  ```js
  const n = parseFloat(best.series_index);
  const seriesIndex = isNaN(n) ? 1 : n;
  ```

- **`backfill-lt-fields.mjs` doesn't strip the BOM** from the TSV file. The Calibre
  script does (`raw.replace(/^﻿/, '')`). If the LT export has a BOM, the header
  validation will silently warn but not abort, and the first BookId may include the BOM
  character, causing a silent no-match for that row.

- **`createBook` uses `googleBooksId` as the item's primary key** (`bookId: body.googleBooksId ?? randomUUID()`). This dual-use of a domain identifier as a DynamoDB PK is fragile — if a book has no Google Books ID, it gets a UUID. The field is then also stored separately as `googleBooksId`. The two sources of truth can drift. Consider always using `randomUUID()` as `bookId` and keeping `googleBooksId` strictly as metadata.

- **`collapseTagBar` is called via `requestAnimationFrame` but `tagBarExpanded` is never
  reset** when `renderTagFilterBar` is called (e.g. after toggling a tag). If the user
  expands the bar and then changes the tag filter, the bar remains expanded permanently
  for that session even if only 2 tags remain. Decide: is this intentional? If so,
  document it. If not, reset `tagBarExpanded = false` before re-rendering.

- **`esc()` is copy-pasted across at least 3 HTML files** (reading-log, booktimeline,
  homepage). At minimum it should be in a `<script src="/js/util.js">` shared file.
  Right now if a bug is found in the escaping logic, it needs to be fixed in three places.

- **Inline `onclick=` attributes in rendered HTML** (e.g. `onclick="selectBook('${esc(b.bookId)}')"`)
  couple the HTML string template directly to global function names. Any rename of
  `selectBook` won't be caught by a search without also grepping template strings.
  Consider using event delegation on the list container instead.

- **`seriesLabel` is also copy-pasted into `site/index.html` and `booktimeline/index.html`**.
  Same DRY violation as `esc()`.

---

## Refactored Snippet

### A: Consolidate `apply*Result` into a shared writer

```js
// ── Shared OL data extractor ──────────────────────────────────────────────────
function extractOLFields(doc) {
  return {
    title:   doc.title ?? '',
    author:  (doc.author_name ?? []).join(', '),
    pages:   doc.number_of_pages_median ?? '',
    isbn13:  (doc.isbn ?? []).find(x => x.length === 13) ?? (doc.isbn ?? [])[0] ?? '',
    olKey:   (doc.key ?? '').replace('/works/', ''),
    thumb:   doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : '',
    desc:    '',
  };
}

function extractGBFields(doc) {
  const info  = doc.volumeInfo ?? {};
  const ids   = info.industryIdentifiers ?? [];
  return {
    title:  info.title ?? '',
    author: (info.authors ?? []).join(', '),
    pages:  info.pageCount ?? '',
    isbn13: ids.find(x => x.type === 'ISBN_13')?.identifier ?? ids[0]?.identifier ?? '',
    olKey:  '',
    thumb:  info.imageLinks?.thumbnail?.replace('http:', 'https:').replace('zoom=1', 'zoom=2') ?? '',
    desc:   info.description?.replace(/<[^>]+>/g, '') ?? '',
    gbId:   doc.id ?? '',
  };
}

/** Write common book fields to the form. Only writes non-empty values; never clears. */
function applyFieldsToForm({ title, author, pages, isbn13, olKey, thumb, desc, gbId, amazonId, goodreadsUrl }) {
  const set = (id, val) => { if (val) document.getElementById(id).value = val; };
  set('f-title',  title);
  set('f-author', author);
  set('f-pages',  pages);
  set('f-isbn',   isbn13);
  set('f-olid',   olKey);
  if (gbId)         set('f-gbid',  gbId);
  if (amazonId)     set('f-amzid', amazonId);
  if (goodreadsUrl) set('f-grurl', goodreadsUrl);
  if (thumb && !document.getElementById('f-cover').value) document.getElementById('f-cover').value = thumb;
  if (desc  && !document.getElementById('f-desc').value)  document.getElementById('f-desc').value  = desc.substring(0, 300);
  updateCoverPreview();
}

function applyOLResult(doc) {
  const fields = extractOLFields(doc);
  const desc   = typeof doc.first_sentence === 'object'
    ? (doc.first_sentence?.value ?? '') : (doc.first_sentence ?? '');
  applyFieldsToForm({ ...fields, desc });
  toast('Applied metadata from OpenLibrary.');
}

function applyGBResult(doc) {
  applyFieldsToForm(extractGBFields(doc));
  toast('Applied metadata from Google Books.');
}

function applyAmazonResult(doc) {
  const fields   = extractOLFields(doc);
  const bCode    = (doc.id_amazon ?? []).find(x => /^B/i.test(x)) ?? '';
  const isbn10rw = (doc.id_amazon ?? []).find(x => /^\d{9}[\dX]$/i.test(x)) ?? '';
  const isbn10   = bCode || isbn10rw || isbn13ToIsbn10(fields.isbn13);
  applyFieldsToForm({ ...fields, amazonId: isbn10 });
  const msg = bCode   ? `Applied + Kindle ASIN ${bCode}.`
            : isbn10rw ? `Applied + physical ASIN ${isbn10rw} (ISBN-10).`
            : isbn10   ? `Applied + physical ASIN ${isbn10} (derived).`
            : 'Applied metadata — no Amazon ID found.';
  toast(msg);
}

function applyGoodreadsResult(doc) {
  const fields = extractOLFields(doc);
  const grId   = (doc.id_goodreads ?? [])[0] ?? '';
  const grUrl  = grId ? `https://www.goodreads.com/book/show/${grId}` : '';
  applyFieldsToForm({ ...fields, goodreadsUrl: grUrl });
  toast(grUrl ? 'Applied metadata + Goodreads URL.' : 'Applied metadata (no Goodreads ID).');
}
```

---

### B: Fix `isEditor` — remove debug logs, fix substring match bug

```js
function isEditor(event) {
  const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
  const raw    = claims['cognito:groups'] ?? '';
  const groups = Array.isArray(raw)
    ? raw
    : raw.split(',').map(g => g.trim()).filter(Boolean);
  return groups.includes('editors') || groups.includes('admins');
}
```

---

### C: Fix `deleteBook` — use Scan (not GSI) to catch unfinished reads

```js
async function deleteBook(event) {
  if (!isEditor(event)) return err('Forbidden', 403);
  const { bookId } = event.pathParameters;

  // Guard: ensure the book exists before touching anything
  const existing = await dynamo.send(new GetCommand({
    TableName: BOOKS_TABLE, Key: { bookId }, ProjectionExpression: 'bookId',
  }));
  if (!existing.Item) return err('Book not found', 404);

  // Scan for reads (not GSI) — GSI on 'finished' misses in-progress reads
  const readsResult = await dynamo.send(new ScanCommand({
    TableName: READS_TABLE,
    FilterExpression: 'bookId = :bid',
    ExpressionAttributeValues: { ':bid': bookId },
    ProjectionExpression: 'readId',
  }));
  const readIds = (readsResult.Items ?? []).map(r => r.readId);

  for (let i = 0; i < readIds.length; i += 25) {
    const chunk = readIds.slice(i, i + 25);
    await dynamo.send(new BatchWriteCommand({
      RequestItems: {
        [READS_TABLE]: chunk.map(readId => ({ DeleteRequest: { Key: { readId } } })),
      },
    }));
  }

  await dynamo.send(new DeleteCommand({ TableName: BOOKS_TABLE, Key: { bookId } }));
  return ok({ deleted: bookId });
}
```

---

### D: Move `amzScore` to module scope, remove `doc` mutation in render

```js
// Module-level — not inside searchAmazon
function amzScore(doc) {
  if ((doc.id_amazon ?? []).some(x => /^B/i.test(x))) return 2;
  const isbn13 = (doc.isbn ?? []).find(x => x.length === 13 && x.startsWith('978')) ?? '';
  if ((doc.id_amazon ?? []).some(x => /^\d{9}[\dX]$/i.test(x)) || isbn13) return 1;
  return 0;
}

// In renderSearchResults — compute badge label locally, don't mutate doc
function getAmzBadgeLabel(doc) {
  const hasBcode = (doc.id_amazon ?? []).some(x => /^B/i.test(x));
  const score    = amzScore(doc);
  return hasBcode ? 'AMZ ✓' : score > 0 ? 'AMZ' : 'AMZ';
}
```

---

## TODO Checklist

- [x] **[CRITICAL]** Remove DEBUG `console.log` statements from `isEditor()` in Lambda
- [x] **[CRITICAL]** Fix `isEditor` substring match — split to array before `.includes()`
- [x] **[CRITICAL]** Fix `deleteBook` to use Scan (not GSI byBook) to avoid orphaned in-progress reads
- [x] **[CRITICAL]** Add existence check on `deleteBook` — pre-flight GetCommand before deleting
- [x] **[HIGH]** Remove `amzScore` from inside `searchAmazon`; move to module scope
- [x] **[HIGH]** Eliminate `doc._amzLabel` mutation inside `renderSearchResults`
- [x] **[HIGH]** Consolidate 4 `apply*Result` functions using `extractOLFields`/`extractGBFields`/`applyFieldsToForm`
- [x] **[HIGH]** Remove manual `allBooks.sort()` after new book creation in `saveBook`
- [x] **[MEDIUM]** Rename `#gb-results` → `#search-results` and `gbResults` variable throughout
- [x] **[MEDIUM]** Move `esc()` and `seriesLabel()` to a shared `util.js` — currently copy-pasted across 3 HTML files
- [x] **[MEDIUM]** Fix `parseFloat(best.series_index) || 1` → use NaN check to handle index 0 correctly (`import-calibre-series.mjs`)
- [x] **[MEDIUM]** Add BOM strip to `backfill-lt-fields.mjs` (the Calibre script already does this)
- [x] **[LOW]** Unify or document `badge-ol` vs `badge-ol2` (and `badge-gb` vs `badge-gb2`) — removed duplicate rules; `updateBookLinksFromValues` now uses `badge-ol`/`badge-gb`
- [x] **[LOW]** Document or reset `tagBarExpanded` on re-render — reset to `false` in `toggleTagFilter()` before re-rendering
- [ ] **[LOW]** Replace `createBook`'s `googleBooksId ?? randomUUID()` as PK — use always-UUID PK to avoid dual-use confusion
- [ ] **[LOW]** Replace inline `onclick=` string templates with event delegation where practical
