"""Check whether a newer plugin build has been published.

scripts/publish-plugin.sh writes a small manifest next to the zip:

    https://oldforest.net/files/oldforest-books-plugin.json
    {"version": "1.0.1", "url": "…/oldforest-books-plugin.zip", "published": "…"}

Deliberately quiet: an update check must never interrupt or slow a push, so any
network, HTTP or parse problem simply means "no information available".

Standard library only — Calibre does not bundle `requests`.
"""

import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

MANIFEST_PATH = '/files/oldforest-books-plugin.json'
DOWNLOAD_PATH = '/files/oldforest-books-plugin.zip'
TIMEOUT_SECONDS = 8


def parse_version(text):
    """'1.2.3' → (1, 2, 3). None when unparseable."""
    if text is None:
        return None
    parts = str(text).strip().split('.')
    numbers = []
    for part in parts:
        part = part.strip()
        if not part.isdigit():
            return None
        numbers.append(int(part))
    return tuple(numbers) or None


def fetch_manifest(api_base, timeout=TIMEOUT_SECONDS):
    """The published manifest as a dict, or None when unavailable."""
    url = (api_base or '').rstrip('/') + MANIFEST_PATH
    try:
        request = Request(url, headers={'Accept': 'application/json'})
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode('utf-8'))
    except (HTTPError, URLError, ValueError, OSError):
        # No manifest published yet, offline, or malformed — all equally "unknown".
        return None


def newer_available(current_version, api_base, manifest=None):
    """(version_string, download_url) when an upgrade exists, else None.

    `current_version` is the plugin's own version tuple, e.g. (1, 0, 0).
    Pass `manifest` to compare against an already-fetched one (used by tests).
    """
    if manifest is None:
        manifest = fetch_manifest(api_base)
    if not manifest:
        return None

    latest = parse_version(manifest.get('version'))
    if latest is None:
        return None

    # Compare as equal-length tuples so 1.1 doesn't read as older than 1.0.0.
    current = tuple(current_version or ())
    width = max(len(latest), len(current))
    latest_padded = latest + (0,) * (width - len(latest))
    current_padded = current + (0,) * (width - len(current))
    if latest_padded <= current_padded:
        return None

    url = manifest.get('url') or ((api_base or '').rstrip('/') + DOWNLOAD_PATH)
    return (manifest.get('version'), url)


# ── Self-test ────────────────────────────────────────────────────────────────
# Run with:  python3 calibre-plugin/updates.py

if __name__ == '__main__':
    failures = []

    def check(label, got, want):
        if got != want:
            failures.append('%s\n     got:  %r\n     want: %r' % (label, got, want))

    check('parse simple', parse_version('1.2.3'), (1, 2, 3))
    check('parse whitespace', parse_version('  2.0 '), (2, 0))
    check('parse rejects text', parse_version('1.2.x'), None)
    check('parse rejects empty', parse_version(''), None)
    check('parse rejects None', parse_version(None), None)

    BASE = 'https://example.test'

    def newer(latest, current):
        return newer_available(current, BASE, manifest={'version': latest})

    check('newer patch detected', newer('1.0.1', (1, 0, 0))[0], '1.0.1')
    check('newer minor detected', newer('1.1.0', (1, 0, 9))[0], '1.1.0')
    check('newer major detected', newer('2.0.0', (1, 9, 9))[0], '2.0.0')
    check('same version → no update', newer('1.0.0', (1, 0, 0)), None)
    check('older published → no update', newer('0.9.0', (1, 0, 0)), None)
    # Ragged lengths must not compare lexicographically.
    check('1.1 is newer than 1.0.0', newer('1.1', (1, 0, 0))[0], '1.1')
    check('1.0 is not newer than 1.0.0', newer('1.0', (1, 0, 0)), None)
    check('1.0.0 is not newer than 1.0', newer('1.0.0', (1, 0)), None)

    check('falls back to default download url',
          newer('9.9.9', (1, 0, 0))[1], BASE + DOWNLOAD_PATH)
    check('uses manifest url when present',
          newer_available((1, 0, 0), BASE,
                          manifest={'version': '2.0', 'url': 'https://x.test/p.zip'})[1],
          'https://x.test/p.zip')

    check('missing manifest → no update', newer_available((1, 0, 0), BASE, manifest={}), None)
    check('unparseable version → no update',
          newer_available((1, 0, 0), BASE, manifest={'version': 'latest'}), None)

    if failures:
        print('FAILED (%d):' % len(failures))
        for f in failures:
            print('  - ' + f)
        raise SystemExit(1)
    print('updates: all checks passed')
