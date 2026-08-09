"""Thin client for the oldforest.net reading-log API.

Standard library only — Calibre does not bundle `requests`.
"""

import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_TIMEOUT = 30


class ApiError(Exception):
    def __init__(self, message, status=None):
        Exception.__init__(self, message)
        self.status = status


class ApiClient:
    """Calls the books endpoints, refreshing the access token when needed.

    `token_provider` returns a currently-valid access token; it is re-invoked
    with force_refresh=True once if the API still answers 401, which covers a
    token revoked server-side before its local expiry.
    """

    def __init__(self, api_base, token_provider, timeout=DEFAULT_TIMEOUT):
        self.api_base = (api_base or '').rstrip('/')
        self.token_provider = token_provider
        self.timeout = timeout

    # ── plumbing ─────────────────────────────────────────────────────────────

    def _send(self, method, path, body=None, token=None):
        url = self.api_base + path
        data = None
        headers = {'Accept': 'application/json'}
        if body is not None:
            data = json.dumps(body).encode('utf-8')
            headers['Content-Type'] = 'application/json'
        if token:
            headers['Authorization'] = 'Bearer ' + token

        request = Request(url, data=data, headers=headers, method=method)
        with urlopen(request, timeout=self.timeout) as response:
            raw = response.read().decode('utf-8')
            return response.status, (json.loads(raw) if raw.strip() else None)

    def _request(self, method, path, body=None, authenticated=True):
        token = self.token_provider() if authenticated else None
        try:
            _, payload = self._send(method, path, body, token)
            return payload
        except HTTPError as exc:
            if exc.code == 401 and authenticated:
                # Token may have been revoked before its stated expiry.
                token = self.token_provider(force_refresh=True)
                try:
                    _, payload = self._send(method, path, body, token)
                    return payload
                except HTTPError as retry_exc:
                    raise self._as_api_error(retry_exc)
            raise self._as_api_error(exc)
        except URLError as exc:
            raise ApiError('Could not reach %s: %s' % (self.api_base, exc.reason))

    @staticmethod
    def _as_api_error(exc):
        detail = ''
        try:
            raw = exc.read().decode('utf-8', 'replace')
            parsed = json.loads(raw)
            detail = parsed.get('error') or parsed.get('message') or raw[:200]
        except Exception:
            detail = getattr(exc, 'reason', '') or ''
        if exc.code == 401:
            detail = detail or 'Not signed in, or the session expired.'
        elif exc.code == 403:
            detail = detail or 'Your account is not in the editors group.'
        return ApiError('HTTP %s — %s' % (exc.code, detail), status=exc.code)

    # ── endpoints ────────────────────────────────────────────────────────────

    def list_books(self):
        """Every book already in the reading log (public endpoint).

        Fetched once per push so books can be matched locally — the API has no
        find-by-isbn route, and this avoids a lookup request per book.
        """
        payload = self._request('GET', '/v1/reading/books', authenticated=False)
        return (payload or {}).get('books') or []

    def create_book(self, book):
        payload = self._request('POST', '/v1/reading/books', body=book)
        return (payload or {}).get('book') or {}

    def update_book(self, book_id, fields):
        from urllib.parse import quote
        payload = self._request(
            'PUT', '/v1/reading/books/%s' % quote(str(book_id), safe=''), body=fields)
        return (payload or {}).get('book') or {}

    def request_upload(self, filename, size):
        """Ask for a presigned S3 PUT URL. Returns {uploadUrl, key, contentType}."""
        return self._request('POST', '/v1/editor/upload',
                             body={'filename': filename, 'size': size}) or {}

    def put_signed(self, upload_url, data, content_type):
        """PUT bytes to a presigned S3 URL.

        Deliberately sends no Authorization header: the signature lives in the
        URL's query string, and adding one makes S3 reject the request.
        """
        headers = {'Content-Length': str(len(data))}
        if content_type:
            headers['Content-Type'] = content_type
        request = Request(upload_url, data=data, headers=headers, method='PUT')
        try:
            with urlopen(request, timeout=self.timeout) as response:
                return response.status
        except HTTPError as exc:
            raise ApiError('Cover upload rejected by S3 (HTTP %s)' % exc.code,
                           status=exc.code)
        except URLError as exc:
            raise ApiError('Cover upload failed: %s' % exc.reason)
