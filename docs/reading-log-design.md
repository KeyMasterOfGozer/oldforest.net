# Reading Log — Design Document

## Goals

Replace the LibraryThing widget API (which stopped returning new entries after ~January 2025) with a self-hosted reading database that:

- Stores books and multiple read-through dates with full ownership
- Pulls book metadata (cover, page count, description) from a real search API
- Links each book entry to its GoodReads page
- Provides a browser-based UI to add books, log read dates, and edit existing entries
- Powers the existing Book Timeline app without structural changes

---

## Data Storage: DynamoDB (recommended over S3)

### Why not S3?

A single JSON file in S3 works for read-only display but breaks down for editing:

- No atomic updates — concurrent saves overwrite each other
- The entire file must be read and rewritten for every change
- No query capability — every operation is a full download

### Why DynamoDB

- Already used by the blog for posts; infrastructure and IAM roles exist
- Atomic conditional writes prevent lost updates
- Efficient scans and projections for timeline queries
- Cost: at personal-blog scale (thousands of books, occasional writes), comfortably within free tier

---

## Data Model

Two tables: `books` (one item per unique book) and `reads` (one item per reading session). This separation allows efficient queries by date range, and each read can carry its own review, rating, and notes without complicating the book record.

### `books` Table

```
PK: bookId  (string — Google Books ID preferred; UUID fallback)

Required fields:
  title         string
  author        string    — display form, e.g. "Brandon Sanderson"

Optional metadata (populated from Google Books search):
  googleBooksId string
  goodreadsUrl  string    — full URL, entered manually or from search
  coverUrl      string    — Google Books thumbnail URL
  pageCount     number
  description   string    — short blurb
  isbn          string

Taxonomy:
  tags          string set  — e.g. ["fantasy", "kindle", "audiobook"]

Housekeeping:
  createdAt     ISO 8601 string
  updatedAt     ISO 8601 string
```

### `reads` Table

```
PK: readId     (UUID v4)
SK: bookId     (string — FK to books table)

Reading session:
  started       ISO 8601 date string  (optional — book may be in-progress)
  finished      ISO 8601 date string  (optional — book may be unfinished)
  rating        number  1–5  (optional)
  review        string  — longer-form written review or reaction (optional)
  notes         string  — short private notes, e.g. "audiobook, re-read" (optional)
  format        string  — "print" | "kindle" | "audiobook" | "ebook" (optional)

Housekeeping:
  createdAt     ISO 8601 string
  updatedAt     ISO 8601 string
```

#### GSI 1: `byBook`
- PK: `bookId`
- SK: `finished`

Fetches all reads for a given book, ordered chronologically.

#### GSI 2: `byFinished`
- PK: a constant partition key (`ALL`)
- SK: `finished`

Queries reads within a date range — e.g. "books I finished in 2024", or the timeline's date-window filter. At personal scale a full scan with a filter expression also works, but the GSI avoids a full table scan as the read count grows.

#### GSI 3: `byStarted`
- PK: `ALL`
- SK: `started`

Same pattern as `byFinished` — useful for "books I started in Q1" or finding currently-in-progress reads (started but no finished date).

---

## Book Metadata Source: Google Books API

GoodReads shut down its developer API in December 2020. Google Books provides equivalent metadata and is free with no API key required for the search endpoint we need.

### Search endpoint

```
GET https://www.googleapis.com/books/v1/volumes?q={query}&maxResults=10
```

Returns: `title`, `authors`, `description`, `pageCount`, `imageLinks.thumbnail`, `industryIdentifiers` (ISBN).

No API key required for unauthenticated search at low volume. If rate limits become an issue, a free Google Cloud API key lifts the limit to 1,000 req/day.

### GoodReads link

Since GoodReads has no API, we handle the link in two ways:

1. **Auto-generated search link** (always available, zero effort):  
   `https://www.goodreads.com/search?q={isbn}` or `?q={title}+{author}`  
   This opens GoodReads search pre-filled — user clicks the right result.

2. **Stored URL** (optional, precise):  
   The editor UI lets you paste the exact GoodReads book URL after searching manually. Once saved, the timeline shows a direct link.

This means every book immediately gets a working GoodReads link (via search), and the user can optionally upgrade it to a direct link when they care enough to look it up.

---

## API Endpoints

Add a new Lambda (`reading-log`) behind the existing API Gateway, or add routes to the existing Lambda. Recommend a dedicated Lambda for clean separation.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/v1/reading/books` | Public | All books (metadata only, no reads) |
| GET | `/v1/reading/books?q={term}` | Public | Search/autocomplete by title or author |
| GET | `/v1/reading/books/{id}` | Public | Single book with all its reads joined |
| POST | `/v1/reading/books` | Editors | Create book |
| PUT | `/v1/reading/books/{id}` | Editors | Update book metadata |
| DELETE | `/v1/reading/books/{id}` | Editors | Delete book (and all its reads) |
| GET | `/v1/reading/reads` | Public | All reads (joined with book title/author); supports `?from=` & `?to=` date params |
| GET | `/v1/reading/reads?bookId={id}` | Public | All reads for a specific book |
| POST | `/v1/reading/reads` | Editors | Log a new read (body includes `bookId`) |
| PUT | `/v1/reading/reads/{readId}` | Editors | Update a read (dates, rating, review, notes) |
| DELETE | `/v1/reading/reads/{readId}` | Editors | Delete a read |

The **timeline endpoint** is `GET /v1/reading/reads?from=&to=` — it returns reads in a date window, each joined with the book's title, author, cover, and tags. The timeline app replaces its `lt-proxy` call with this endpoint; response normalization is a thin adapter layer.

For the **editor's book detail view**, `GET /v1/reading/books/{id}` returns the book record with its reads embedded in the response (the Lambda joins across both tables server-side).

---

## Editor UI (`/apps/reading-log/`)

A single-page app, accessible to editors. Three panes:

### 1 — Book Search / Select

- Text input → live search against `GET /v1/reading/books?q=` (existing database)
- If not found, a "Search Google Books" button queries the Google Books API client-side and shows a result list with covers
- Clicking a result pre-fills the book form; user can adjust and save

### 2 — Book Detail Form

Fields: Title, Author, Google Books ID (auto-filled), Cover URL (auto-filled, editable), Page Count, Description (truncated), GoodReads URL (optional paste), Tags.

Save creates or updates the book record.

### 3 — Read Log (for selected book)

Table of existing reads for this book, each row showing: Started, Finished, Format, Rating (stars), Notes preview, Edit/Delete buttons.

"Add Read" opens an inline form:
- **Started** / **Finished** — date pickers (each optional)
- **Format** — dropdown: Print, Kindle, Audiobook, E-book
- **Rating** — 1–5 star picker
- **Notes** — short private field (e.g. "listened during commute")
- **Review** — longer text area for a written reaction or review (shown publicly on the timeline tooltip if present)

---

## Migration from LibraryThing

The existing `lt-proxy` Lambda returns ~717 books with reading dates (up to January 2025). Migration steps:

1. **Export script**: call `lt-proxy` once, transform each book into the DynamoDB `books` schema, batch-write to the new table.
2. **Post-migration audit**: compare counts against LT GUI; manually add the ~hundreds of post-January 2025 entries using the new editor UI.
3. **Cutover**: update the timeline app's fetch URL from `lt-proxy` to the new reading API.
4. **Retire lt-proxy**: leave it in place for 30 days, then remove.

The LT export provides: title, author, tags, and read dates. It does not provide covers or page counts — those can be back-filled lazily via the editor's Google Books search.

---

## Timeline Integration

The timeline app (`/apps/booktimeline/`) needs minimal changes:

- Replace the `lt-proxy` fetch URL with `GET /v1/reading/books`
- Normalize the response: the new API returns an array of book objects; map each `reads[]` entry to a timeline item
- Each timeline item can now include a direct link: GoodReads URL if stored, else the auto-generated GoodReads search URL
- Cover thumbnails can be shown in the vis-timeline tooltip

---

## Implementation Order

1. Create DynamoDB `books` table with GSI
2. Build `reading-log` Lambda (CRUD endpoints)
3. Add routes to API Gateway
4. Migration script (LT → DynamoDB)
5. Build editor UI at `/apps/reading-log/`
6. Update timeline to use new API
7. Register the editor as an app in the apps registry (editors-only visibility)
