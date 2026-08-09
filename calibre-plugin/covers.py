"""Optional cover upload.

The books API stores a `coverUrl`, but calibre holds cover art as local image
bytes. This uploads those bytes through the site's existing presigned-S3 upload
endpoint (the same one the web editor uses) and returns the resulting public URL.
"""

import re

# Extensions the upload endpoint will sign — it derives Content-Type from the
# filename extension server-side and rejects anything not on its allowlist.
# Deliberately excludes SVG, which the API permits but which can execute script.
_MAGIC = (
    (b'\xff\xd8\xff', 'jpg'),
    (b'\x89PNG\r\n\x1a\n', 'png'),
    (b'GIF87a', 'gif'),
    (b'GIF89a', 'gif'),
)

# The endpoint's own cap. Checked here too so an oversized cover is reported as a
# clean skip rather than a 413 mid-push.
MAX_COVER_BYTES = 10 * 1024 * 1024


def detect_extension(data):
    """Image type from magic bytes, or None if unrecognised.

    Sniffed rather than trusted from a filename because calibre stores covers
    with inconsistent extensions.
    """
    if not data:
        return None
    for magic, ext in _MAGIC:
        if data.startswith(magic):
            return ext
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'webp'
    return None


def safe_stem(title, fallback='cover'):
    """Filename stem for the upload; the server sanitises again on its side."""
    stem = re.sub(r'[^A-Za-z0-9]+', '-', (title or '')).strip('-').lower()
    return (stem[:60] or fallback)


class CoverError(Exception):
    pass


def upload_cover(client, api_base, cover_bytes, title):
    """Upload cover bytes, returning the public URL.

    Raises CoverError for anything the caller should report as a per-book
    warning rather than a failed push.
    """
    if not cover_bytes:
        raise CoverError('no cover in calibre')

    extension = detect_extension(cover_bytes)
    if extension is None:
        raise CoverError('unrecognised image format')

    if len(cover_bytes) > MAX_COVER_BYTES:
        raise CoverError('cover is larger than 10 MB')

    filename = '%s.%s' % (safe_stem(title), extension)
    grant = client.request_upload(filename, len(cover_bytes))

    upload_url = grant.get('uploadUrl')
    key = grant.get('key')
    if not upload_url or not key:
        raise CoverError('upload endpoint did not return a signed URL')

    # Content-Type must match exactly what the server signed, or S3 rejects it.
    client.put_signed(upload_url, cover_bytes, grant.get('contentType'))

    return '%s/%s' % (api_base.rstrip('/'), key.lstrip('/'))


# ── Self-test ────────────────────────────────────────────────────────────────
# Run with:  python3 calibre-plugin/covers.py

if __name__ == '__main__':
    failures = []

    def check(label, got, want):
        if got != want:
            failures.append('%s\n     got:  %r\n     want: %r' % (label, got, want))

    check('jpeg magic', detect_extension(b'\xff\xd8\xff\xe0' + b'\x00' * 20), 'jpg')
    check('png magic', detect_extension(b'\x89PNG\r\n\x1a\n' + b'\x00' * 20), 'png')
    check('gif87a magic', detect_extension(b'GIF87a' + b'\x00' * 20), 'gif')
    check('gif89a magic', detect_extension(b'GIF89a' + b'\x00' * 20), 'gif')
    check('webp magic', detect_extension(b'RIFF\x00\x00\x00\x00WEBPVP8 '), 'webp')
    check('riff that is not webp', detect_extension(b'RIFF\x00\x00\x00\x00WAVEfmt '), None)
    check('empty', detect_extension(b''), None)
    check('none', detect_extension(None), None)
    check('random bytes', detect_extension(b'not an image at all'), None)
    # An SVG would be served with a script-capable content type; must not sniff.
    check('svg rejected', detect_extension(b'<svg xmlns="http://www.w3.org/2000/svg">'), None)

    check('stem slugified', safe_stem('A Game of Thrones!'), 'a-game-of-thrones')
    check('stem of empty title falls back', safe_stem(''), 'cover')
    check('stem of punctuation-only falls back', safe_stem('!!! ???'), 'cover')
    check('stem truncated', len(safe_stem('x' * 200)) <= 60, True)

    class _FakeClient:
        def __init__(self):
            self.put = None

        def request_upload(self, filename, size):
            self.filename, self.size = filename, size
            return {'uploadUrl': 'https://s3.example/signed',
                    'key': 'images/2026/08/uuid-a-book.jpg',
                    'contentType': 'image/jpeg'}

        def put_signed(self, url, data, content_type):
            self.put = (url, len(data), content_type)

    client = _FakeClient()
    url = upload_cover(client, 'https://oldforest.net/',
                       b'\xff\xd8\xff\xe0' + b'\x00' * 100, 'A Book')
    check('public url built', url, 'https://oldforest.net/images/2026/08/uuid-a-book.jpg')
    check('filename carries sniffed extension', client.filename, 'a-book.jpg')
    check('declared size is real byte length', client.size, 104)
    check('signed content type echoed back', client.put[2], 'image/jpeg')

    for label, data in (('no cover', b''), ('unknown format', b'garbage bytes')):
        try:
            upload_cover(_FakeClient(), 'https://x', data, 'T')
            failures.append('%s should have raised CoverError' % label)
        except CoverError:
            pass

    try:
        upload_cover(_FakeClient(), 'https://x',
                     b'\xff\xd8\xff' + b'\x00' * MAX_COVER_BYTES, 'T')
        failures.append('oversized cover should have raised CoverError')
    except CoverError:
        pass

    if failures:
        print('FAILED (%d):' % len(failures))
        for f in failures:
            print('  - ' + f)
        raise SystemExit(1)
    print('covers: all checks passed')
