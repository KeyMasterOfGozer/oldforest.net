# Push to oldforest.net — a Calibre plugin

Pushes book metadata from a Calibre library into the oldforest.net reading-log
database (`/v1/reading/books`).

Metadata only — Calibre has no native concept of "date read", so *reads* are
still logged through the website.

## Install

**Easiest — download the latest published build:**

<https://oldforest.net/files/oldforest-books-plugin.zip>

That URL is stable and always serves the newest release; it is also listed on
the site's **Apps** page. Install it with **Preferences → Plugins → Load plugin
from file**.

**Or build from source:**

```bash
bash calibre-plugin/build.sh --install   # build + install
bash calibre-plugin/build.sh             # build only
```

### Staying up to date

The push dialog checks the published manifest in the background and shows a
notice when a newer build exists. The check is entirely non-blocking — if it
fails for any reason the notice just stays hidden.

### Publishing a new release (maintainer)

**Bump `PLUGIN_VERSION` in `__init__.py` first**, then:

```bash
AWS_PROFILE=oldforest bash scripts/publish-plugin.sh
```

That runs the self-tests, builds, uploads the zip *and* a version manifest,
invalidates both CDN paths, and verifies what the CDN actually serves.

It **refuses to publish a version that is already published** (override with
`FORCE=1`). Shipping two different builds under one version number is what
leaves a stale install unable to tell it is out of date — the exact failure the
manifest exists to prevent.

**Calibre must be restarted after installing** — plugins are not loaded live.

### Where the button appears

Calibre does not place plugin actions anywhere by itself, so on first launch
this plugin adds itself to **the main toolbar** and the **right-click menu** on
the book list. That happens once; if you later move or remove the button, your
choice sticks.

If it still doesn't show up, add it by hand:

**Preferences → Toolbars & menus → The main toolbar** → select
*Push to oldforest.net* in the left list → **&gt;** → **Apply**.

(No restart needed for the manual route — the button appears immediately.)

## First-time setup

All three connection fields are **pre-filled** with the current deployment, so
normally you only need to sign in.

Open **Preferences → Plugins → Push to oldforest.net → Customize plugin**:

| Field | Default |
|---|---|
| Site URL | `https://oldforest.net` |
| Cognito domain | `auth-165395066552.auth.us-east-1.amazoncognito.com` |
| App client ID | `4iba7ad3ddrfopa26cfuu3m99j` |

If the infrastructure is ever rebuilt, refresh these from Terraform:

```bash
cd infra && AWS_PROFILE=oldforest terraform output calibre_plugin_client_id
cd infra && AWS_PROFILE=oldforest terraform output cognito_domain
```

Then click **Sign in…**. Your browser opens the normal oldforest.net sign-in
page; password, passkey and TOTP MFA all work. The plugin never sees your
credentials — it only receives an authorization code on a localhost port.

> **If the browser shows "Login pages unavailable"**, the plugin's Cognito app
> client has no Managed Login branding record. Cognito serves sign-in pages per
> app client and refuses for any client without one. Fix with the loop in
> TERRAFORM_MIGRATION.md §9 — it is a one-time CLI step per client, because the
> AWS Terraform provider still has no resource for it as of 5.100.0.

Your account must be in the **editors** (or admins) Cognito group; the settings
screen warns you if it isn't.

## Usage

Select books in the library → click **Push to oldforest.net**.

The dialog downloads the site's current book list, works out what each selected
book would do, and shows you a row per book. **The Action column is a dropdown
you can change** — every proposed match can be overridden, either accepting the
suggested update or forcing *Create new book*.

Two bulk buttons help with large selections: **Set all to "Create new"** and
**Accept all suggested matches**.

Nothing is written until you press **Push**.

## How books are matched

Repeat pushes should update, not duplicate. Each book is matched against the
site's existing books and every candidate is ranked by confidence:

| Confidence | Basis | Default |
|---|---|---|
| **Exact** | same ISBN, ASIN, Google Books ID, Royal Road ID or OpenLibrary ID | update |
| **Strong** | same title *and* author (case/punctuation insensitive) | update |
| **Weak** | same title, *different* author | **create new** |

Only exact and strong matches update automatically. A weak match is still shown
in the dropdown, but defaults to creating a new book — a wrong update silently
corrupts an existing record, whereas a spurious duplicate is obvious and easy to
delete. Same reasoning when two records match *equally* well: that ambiguity is
surfaced with a ⚠ and defaults to create, rather than being guessed at.

The summary line tells you how many books fell into that uncertain bucket, so
they're never quietly buried in a long list.

The full book list is fetched once per push and indexed locally — the API has no
find-by-identifier endpoint, and matching each book against the whole library
directly would be tens of thousands of comparisons.

### Books without identifiers (Royal Road, self-published)

These have no ISBN or ASIN, so they can only ever match on title + author. To
make them match reliably, give them a Royal Road identifier in calibre — edit
metadata → **Ids** → add:

```
royalroad:25137
```

That maps to the API's `royalRoadId` and upgrades the book to an *exact* match,
so re-pushes update cleanly instead of relying on the title staying identical.

## Tagging new books

Books the plugin **creates** are tagged `to read` by default — pushing from
calibre generally means "I have this book but haven't logged reading it", which
is what the site's pinned *to read* filter is for.

Change or clear the list in the plugin settings (**Tags to add to newly created
books**, comma-separated; blank adds nothing).

Two deliberate limits:

- **Creates only, never updates.** An update won't re-add the tag, so removing
  *to read* on the site once you've read something isn't undone by the next push.
- **No duplicates.** A book calibre already tags *To Read* doesn't gain a second
  lowercase copy — matching is case-insensitive and existing casing wins.

The preview names the tags each book will gain, and follows the Action dropdown:
flip a row from *Update* to *Create new* and the tag annotation appears.

## Cover art

Off by default. Enable **Upload cover art** in the plugin settings.

When on, the plugin reads the cover from calibre, detects its real format from
the file's magic bytes (not its extension), uploads it through the site's
existing presigned-S3 endpoint, and sets `coverUrl`.

Covers are uploaded **only for books the site has no cover for**, so re-pushing
a library doesn't fill S3 with duplicate images. To replace one, clear it on the
site first.

A cover failure never loses the metadata push — the book still goes up and the
row is annotated with why the cover was skipped (unrecognised format, over the
10 MB limit, upload rejected).

## Field mapping

| Calibre | API field |
|---|---|
| Title | `title` |
| Authors | `author` (comma-joined) |
| Series / index | `series` / `seriesIndex` |
| `isbn` identifier | `isbn` |
| `google` identifier | `googleBooksId` |
| `amazon` / `mobi-asin` / `asin` | `amazonId` |
| `openlibrary` / `olid` | `openLibraryId` |
| `royalroad` / `royal_road` | `royalRoadId` |
| `goodreads` identifier | `goodreadsUrl` (expanded to a full URL) |
| Comments | `description` (HTML stripped) |
| Tags | `tags` |
| `#pages` custom column, if present | `pageCount` |
| Cover art | `coverUrl` (optional — see above) |

Identifier values are compared case-insensitively, and ISBNs ignore hyphens, so
`978-0-553-10354-0` and `9780553103540` are the same book.

## Security notes

- Sign-in uses OAuth 2.0 authorization code + **PKCE** over a loopback redirect
  ([RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252)) — the standard for
  native apps. `http://localhost` is the one documented exception to Cognito's
  HTTPS-only callback rule.
- The plugin uses its **own Cognito app client** (`oldforest-calibre-plugin`),
  separate from the website's. Its localhost callback URLs are registered only
  on that client, so the browser client's redirect surface is untouched. It also
  requests narrower scopes — no `aws.cognito.signin.user.admin`.
- ⚠️ **Tokens are stored in plaintext** in calibre's config directory
  (`plugins/oldforest_books.json`), because calibre offers no OS-keychain
  integration. The refresh token lasts 7 days. Anyone with read access to your
  user account's files could use it until it expires — use **Sign out** on a
  shared machine.
- The `state` parameter is verified on the callback, so a stray request hitting
  the loopback port can't inject a foreign authorization code.

## Development

The mapping/matching and cover logic have no Calibre or Qt dependency and
self-test under plain python3:

```bash
python3 calibre-plugin/metadata_map.py   # field mapping + match ranking
python3 calibre-plugin/covers.py         # image sniffing + upload flow
```

### Toolbar icon

`images/icon.png` is rendered from the site favicon (`site/favicon.svg`), so the
button matches the site. Regenerate it after changing the favicon:

```bash
/Applications/calibre.app/Contents/MacOS/calibre-debug calibre-plugin/make_icon.py
```

The dark rounded background is kept deliberately: without it the tree's outer
foliage (`#163e10`) nearly disappears against a dark toolbar theme, and the
crown gets clipped at every edge. `make_icon.py` is a dev tool and is excluded
from the built zip.

Debug the plugin inside calibre with:

```bash
/Applications/calibre.app/Contents/MacOS/calibre-debug -g
```

Rebuild-and-reload cycle: `bash calibre-plugin/build.sh --install`, then restart
calibre.
