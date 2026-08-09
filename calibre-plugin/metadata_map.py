"""Translate Calibre book metadata into oldforest.net books-API payloads.

Kept free of Qt and of any hard Calibre import so it can be exercised outside a
running Calibre (see the self-test at the bottom of this file).
"""

import re

GOODREADS_URL = 'https://www.goodreads.com/book/show/{}'

# Calibre writes unknown authors as this literal string rather than leaving the
# field empty, so it has to be filtered out or it gets pushed as a real author.
_UNKNOWN_AUTHOR = 'unknown'


def _clean_html(raw):
    """Calibre comments are HTML; the API stores plain text."""
    if not raw:
        return None
    text = None
    try:
        from calibre.utils.html2text import html2text
        text = html2text(raw)
    except Exception:
        # Outside Calibre, or html2text choked — fall back to a crude strip.
        text = re.sub(r'<[^>]+>', '', raw)
    text = text.replace(' ', ' ').strip()
    return text or None


def _first(identifiers, *keys):
    """First non-empty value among `keys` in the identifiers dict."""
    for key in keys:
        value = identifiers.get(key)
        if value:
            value = str(value).strip()
            if value:
                return value
    return None


def book_payload(mi):
    """Build the JSON body for POST/PUT /v1/reading/books.

    `mi` is a calibre.ebooks.metadata.book.base.Metadata object.
    Returns None when the book lacks the title/author the API requires, so
    callers can report it as skipped rather than getting a 400.
    """
    identifiers = {str(k).lower(): v for k, v in (mi.identifiers or {}).items()}

    title = (mi.title or '').strip()
    authors = [a.strip() for a in (mi.authors or []) if a and a.strip()]
    authors = [a for a in authors if a.lower() != _UNKNOWN_AUTHOR]
    author = ', '.join(authors)
    if not title or not author:
        return None

    payload = {'title': title, 'author': author}

    if mi.series and str(mi.series).strip():
        payload['series'] = str(mi.series).strip()
        if mi.series_index is not None:
            try:
                payload['seriesIndex'] = float(mi.series_index)
            except (TypeError, ValueError):
                pass

    isbn = _first(identifiers, 'isbn')
    if isbn:
        payload['isbn'] = isbn

    google = _first(identifiers, 'google')
    if google:
        payload['googleBooksId'] = google

    amazon = _first(identifiers, 'amazon', 'mobi-asin', 'asin', 'amazon_us')
    if amazon:
        payload['amazonId'] = amazon

    openlibrary = _first(identifiers, 'openlibrary', 'olid')
    if openlibrary:
        payload['openLibraryId'] = openlibrary

    # Royal Road titles are self-published and carry none of the trade
    # identifiers, so this is often the only stable ID such a book will ever
    # have. Add it in calibre as a custom identifier, e.g. royalroad:21220.
    royalroad = _first(identifiers, 'royalroad', 'royal_road', 'royalroadid')
    if royalroad:
        payload['royalRoadId'] = royalroad

    goodreads = _first(identifiers, 'goodreads')
    if goodreads:
        # Calibre stores the bare numeric id, but the API stores a full URL and
        # rejects anything that isn't http(s).
        payload['goodreadsUrl'] = (
            goodreads if goodreads.lower().startswith('http')
            else GOODREADS_URL.format(goodreads))

    description = _clean_html(mi.comments)
    if description:
        payload['description'] = description

    tags = [t.strip() for t in (mi.tags or []) if t and t.strip()]
    if tags:
        payload['tags'] = tags

    # Calibre has no native page count. Picked up only if the library happens to
    # define a #pages custom column.
    try:
        pages = mi.get('#pages', None)
    except Exception:
        pages = None
    if pages:
        try:
            payload['pageCount'] = int(pages)
        except (TypeError, ValueError):
            pass

    return payload


def _norm(value):
    """Loose key for title/author comparison — case and punctuation agnostic."""
    return re.sub(r'[^a-z0-9]+', '', (value or '').lower())


def _norm_id(value):
    """Identifiers compare case-insensitively, ignoring ISBN hyphens/spaces."""
    if value is None:
        return ''
    return re.sub(r'[\s-]+', '', str(value).strip().lower())


# How much to trust a candidate match. Anything at or above AUTO_UPDATE_ABOVE is
# applied automatically; weaker matches are offered but default to creating a new
# book, because a wrong update silently corrupts an existing record while a
# spurious duplicate is merely annoying and easy to delete.
EXACT = 3    # same ISBN / ASIN / Google Books / Royal Road / OpenLibrary id
STRONG = 2   # same title AND author
WEAK = 1     # same title, different author
AUTO_UPDATE_ABOVE = STRONG

# payload field -> (index bucket, human label)
_ID_FIELDS = (
    ('googleBooksId', 'google', 'Google Books ID'),
    ('isbn', 'isbn', 'ISBN'),
    ('amazonId', 'amazon', 'ASIN'),
    ('royalRoadId', 'royalroad', 'Royal Road ID'),
    ('openLibraryId', 'openlibrary', 'OpenLibrary ID'),
)


def build_index(remote_books):
    """Bucket the site's books for O(1) lookup.

    Built once per push. Matching each selected book against the full list
    directly would be O(selected x remote) — already ~80k comparisons for 100
    books against the current library, and growing.
    """
    index = {bucket: {} for _, bucket, _ in _ID_FIELDS}
    index['title_author'] = {}
    index['title'] = {}

    for book in remote_books:
        for field, bucket, _ in _ID_FIELDS:
            value = _norm_id(book.get(field))
            if value:
                index[bucket].setdefault(value, []).append(book)
        # The API derives bookId from googleBooksId, so an older record may carry
        # the id only in the key.
        book_id = _norm_id(book.get('bookId'))
        if book_id and book_id not in index['google']:
            index['google'].setdefault(book_id, []).append(book)

        title, author = _norm(book.get('title')), _norm(book.get('author'))
        if title:
            index['title'].setdefault(title, []).append(book)
            index['title_author'].setdefault((title, author), []).append(book)

    return index


def find_candidates(payload, index):
    """Rank the site's books that might already be this book.

    Returns [{'book', 'confidence', 'reason'}] best-first, deduplicated. An empty
    list means it is definitely new.
    """
    candidates = []
    seen = set()

    def add(book, confidence, reason):
        key = book.get('bookId') or id(book)
        if key in seen:
            return
        seen.add(key)
        candidates.append({'book': book, 'confidence': confidence, 'reason': reason})

    for field, bucket, label in _ID_FIELDS:
        value = _norm_id(payload.get(field))
        if value:
            for book in index.get(bucket, {}).get(value, ()):
                add(book, EXACT, 'same %s' % label)

    title, author = _norm(payload.get('title')), _norm(payload.get('author'))
    if title and author:
        for book in index.get('title_author', {}).get((title, author), ()):
            add(book, STRONG, 'same title and author')
    if title:
        for book in index.get('title', {}).get(title, ()):
            add(book, WEAK, 'same title, different author')

    return candidates


def best_candidate(candidates):
    """The candidate to apply automatically, or None to create a new book."""
    if not candidates:
        return None
    top = candidates[0]
    if top['confidence'] < AUTO_UPDATE_ABOVE:
        return None
    # Two records matching equally well is a genuine ambiguity (duplicate data on
    # the site, or a real title collision) — surface it rather than guess.
    if len(candidates) > 1 and candidates[1]['confidence'] == top['confidence']:
        return None
    return top


def parse_tag_list(raw):
    """Split a comma-separated tag setting into a clean list."""
    return [tag.strip() for tag in (raw or '').split(',') if tag.strip()]


def with_extra_tags(payload, extra_tags):
    """Copy of `payload` with `extra_tags` merged into its tags.

    Matching is case-insensitive so a book calibre already tags "To Read" does
    not also gain a lowercase "to read"; existing tags keep their own casing.
    """
    merged = list(payload.get('tags') or [])
    if not extra_tags:
        return dict(payload)

    seen = {tag.strip().lower() for tag in merged if tag}
    for tag in extra_tags:
        tag = (tag or '').strip()
        if tag and tag.lower() not in seen:
            merged.append(tag)
            seen.add(tag.lower())

    result = dict(payload)
    result['tags'] = merged
    return result


def missing_tags(payload, extra_tags):
    """Which of `extra_tags` the payload doesn't already carry — for the preview."""
    have = {tag.strip().lower() for tag in (payload.get('tags') or []) if tag}
    out = []
    for tag in extra_tags or ():
        tag = (tag or '').strip()
        if tag and tag.lower() not in have and tag.lower() not in {t.lower() for t in out}:
            out.append(tag)
    return out


def changed_fields(payload, existing):
    """Fields in `payload` that differ from the already-stored `existing` book.

    Used to skip no-op updates so a re-push of an unchanged library doesn't
    issue hundreds of pointless PUTs.
    """
    diff = {}
    for key, new in payload.items():
        old = existing.get(key)
        if key == 'tags':
            if sorted(new or []) != sorted(old or []):
                diff[key] = new
        elif key == 'seriesIndex':
            try:
                if old is None or abs(float(old) - float(new)) > 1e-9:
                    diff[key] = new
            except (TypeError, ValueError):
                diff[key] = new
        elif (old or None) != (new or None):
            diff[key] = new
    return diff


# ── Self-test ────────────────────────────────────────────────────────────────
# Run with:  calibre-debug calibre-plugin/metadata_map.py
# (also runs under plain python3 — nothing here needs Calibre)

if __name__ == '__main__':
    class _FakeMI:
        def __init__(self, **kw):
            self.title = kw.get('title')
            self.authors = kw.get('authors') or []
            self.series = kw.get('series')
            self.series_index = kw.get('series_index')
            self.identifiers = kw.get('identifiers') or {}
            self.comments = kw.get('comments')
            self.tags = kw.get('tags') or []
            self._custom = kw.get('custom') or {}

        def get(self, key, default=None):
            return self._custom.get(key, default)

    failures = []

    def check(label, got, want):
        if got != want:
            failures.append('%s\n     got:  %r\n     want: %r' % (label, got, want))

    full = book_payload(_FakeMI(
        title='  A Game of Thrones ',
        authors=['George R R Martin'],
        series='A Song of Ice and Fire', series_index=1.0,
        identifiers={'ISBN': '9780553103540', 'google': 'abc123',
                     'goodreads': '13496', 'mobi-asin': 'B000QCS8TW'},
        comments='<p>Long ago in a land <b>far</b> away.</p>',
        tags=['fantasy', ' epic '],
        custom={'#pages': '694'},
    ))
    check('title trimmed', full['title'], 'A Game of Thrones')
    check('series index float', full['seriesIndex'], 1.0)
    check('isbn key lowercased', full['isbn'], '9780553103540')
    check('goodreads id -> url', full['goodreadsUrl'],
          'https://www.goodreads.com/book/show/13496')
    check('amazon from mobi-asin', full['amazonId'], 'B000QCS8TW')
    check('tags trimmed', full['tags'], ['fantasy', 'epic'])
    check('pageCount from custom col', full['pageCount'], 694)
    if '<b>' in (full.get('description') or ''):
        failures.append('description still contains HTML: %r' % full['description'])

    check('multiple authors joined',
          book_payload(_FakeMI(title='T', authors=['A One', 'B Two']))['author'],
          'A One, B Two')
    check('unknown author rejected',
          book_payload(_FakeMI(title='T', authors=['Unknown'])), None)
    check('missing title rejected',
          book_payload(_FakeMI(title='', authors=['A'])), None)
    check('already-a-url goodreads left alone',
          book_payload(_FakeMI(title='T', authors=['A'],
                               identifiers={'goodreads': 'https://x.example/b/1'}))['goodreadsUrl'],
          'https://x.example/b/1')

    check('royalroad identifier mapped',
          book_payload(_FakeMI(title='T', authors=['A'],
                               identifiers={'royalroad': '21220'}))['royalRoadId'],
          '21220')

    remote = [
        {'bookId': 'g1', 'googleBooksId': 'g1', 'title': 'One', 'author': 'A'},
        {'bookId': 'u2', 'isbn': '978-0-553-10354-0', 'title': 'Two', 'author': 'B'},
        {'bookId': 'u3', 'title': 'The Third!', 'author': 'C. Writer'},
        {'bookId': 'rr', 'royalRoadId': '21220', 'title': 'Web Serial', 'author': 'D'},
        {'bookId': 'az', 'amazonId': 'B000QCS8TW', 'title': 'Kindle One', 'author': 'E'},
        # Same title as u3 but a different author — a weak match only.
        {'bookId': 'dup', 'title': 'The Third!', 'author': 'Someone Else'},
    ]
    index = build_index(remote)

    def top(payload):
        found = find_candidates(payload, index)
        return (found[0]['book']['bookId'], found[0]['confidence']) if found else None

    check('match by googleBooksId', top({'googleBooksId': 'g1'}), ('g1', EXACT))
    check('match by isbn ignoring hyphens',
          top({'isbn': '9780553103540', 'title': 'x'}), ('u2', EXACT))
    check('match by royalRoadId (no other identifiers)',
          top({'royalRoadId': '21220', 'title': 'Web Serial', 'author': 'D'}), ('rr', EXACT))
    check('match by ASIN', top({'amazonId': 'b000qcs8tw'}), ('az', EXACT))
    check('match by normalized title+author',
          top({'title': 'the third', 'author': 'c writer'}), ('u3', STRONG))
    check('no candidates for a genuinely new book',
          find_candidates({'title': 'Nope', 'author': 'Z'}, index), [])

    # Identifier beats a title collision.
    ranked = find_candidates({'isbn': '9780553103540', 'title': 'The Third!',
                              'author': 'C. Writer'}, index)
    check('identifier ranks above title match', ranked[0]['book']['bookId'], 'u2')

    # Fail-safe behaviour: weak/ambiguous matches must not auto-update.
    weak = find_candidates({'title': 'The Third!', 'author': 'Nobody At All'}, index)
    check('title-only match is weak', weak[0]['confidence'], WEAK)
    check('weak match does not auto-update', best_candidate(weak), None)
    check('strong match does auto-update',
          best_candidate(find_candidates(
              {'title': 'One', 'author': 'A'}, index))['book']['bookId'], 'g1')

    tie_index = build_index([
        {'bookId': 'x1', 'title': 'Same', 'author': 'Same'},
        {'bookId': 'x2', 'title': 'Same', 'author': 'Same'},
    ])
    tied = find_candidates({'title': 'Same', 'author': 'Same'}, tie_index)
    check('ambiguous tie is surfaced, not guessed', best_candidate(tied), None)
    check('both tied candidates offered', len(tied), 2)

    check('parse tag list', parse_tag_list(' to read , owned ,, '), ['to read', 'owned'])
    check('parse empty tag list', parse_tag_list(''), [])
    check('extra tag appended',
          with_extra_tags({'tags': ['fantasy']}, ['to read'])['tags'],
          ['fantasy', 'to read'])
    check('extra tag added when none present',
          with_extra_tags({'title': 'T'}, ['to read'])['tags'], ['to read'])
    check('existing tag not duplicated (case-insensitive)',
          with_extra_tags({'tags': ['To Read']}, ['to read'])['tags'], ['To Read'])
    check('no extra tags leaves payload alone',
          with_extra_tags({'tags': ['a']}, [])['tags'], ['a'])
    check('with_extra_tags does not mutate its input',
          (lambda p: (with_extra_tags(p, ['to read']), p['tags'])[1])({'tags': ['x']}),
          ['x'])
    check('missing_tags reports only what is absent',
          missing_tags({'tags': ['To Read']}, ['to read', 'owned']), ['owned'])

    check('unchanged -> empty diff',
          changed_fields({'title': 'One', 'author': 'A'}, remote[0]), {})
    check('changed title detected',
          changed_fields({'title': 'Changed'}, remote[0]), {'title': 'Changed'})
    check('tag order ignored',
          changed_fields({'tags': ['b', 'a']}, {'tags': ['a', 'b']}), {})

    if failures:
        print('FAILED (%d):' % len(failures))
        for f in failures:
            print('  - ' + f)
        raise SystemExit(1)
    print('metadata_map: all checks passed')
