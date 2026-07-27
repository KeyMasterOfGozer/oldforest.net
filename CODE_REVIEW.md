# Code Review — oldforest.net

> Principal engineer review. Focus: quality, tidiness, maintainability.
> Files covered: `site/apps/reading-log/index.html`, `src/functions/reading-log/index.mjs`,
> `scripts/backfill-lt-fields.mjs`, `scripts/import-calibre-series.mjs`

---

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
