"""Cognito sign-in for the plugin: authorization code + PKCE over a loopback
redirect (RFC 8252).

The plugin never handles the user's password. The system browser drives sign-in
against the existing Cognito Hosted UI — password, passkey and TOTP MFA all work
unchanged — and only the resulting short-lived authorization code comes back, to
an HTTP server bound to localhost for a few seconds.

Standard library only: Calibre does not bundle `requests`.
"""

import base64
import hashlib
import json
import secrets
import time
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

# Must match callback_urls on the Cognito app client (infra/cognito.tf).
# Cognito compares redirect_uri exactly, so each port is registered there too;
# several exist so sign-in survives one of them already being in use.
CALLBACK_PORTS = (8788, 8789, 8790)
CALLBACK_PATH = '/callback'
SCOPES = 'openid email profile'

# Refresh a little early so a token can't expire mid-request.
_EXPIRY_SKEW_SECONDS = 120


class AuthError(Exception):
    pass


def _b64url(raw):
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def _page(title, message):
    return (
        '<!doctype html><meta charset="utf-8">'
        '<title>{t}</title>'
        '<body style="font-family:-apple-system,Segoe UI,sans-serif;'
        'background:#0d1a0b;color:#e8d8b0;display:flex;align-items:center;'
        'justify-content:center;height:100vh;margin:0;text-align:center">'
        '<div><h1 style="color:#78a84e;font-size:22px">{t}</h1>'
        '<p style="color:#859e6a">{m}</p></div>'
    ).format(t=title, m=message)


_PAGE_OK = _page('Signed in', 'You can close this tab and return to Calibre.')
_PAGE_ERR = _page('Sign-in failed', 'Return to Calibre and try again.')


class _CallbackHandler(BaseHTTPRequestHandler):
    """Captures the ?code= Cognito appends to the loopback redirect."""

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path != CALLBACK_PATH:
            # Browsers also ask for /favicon.ico; ignore without ending the wait.
            self.send_error(404)
            return

        params = parse_qs(parsed.query)
        code = (params.get('code') or [None])[0]
        error = (params.get('error_description') or params.get('error') or [None])[0]
        self.server.auth_result = {
            'code': code,
            'state': (params.get('state') or [None])[0],
            'error': error,
        }

        body = (_PAGE_OK if code else _PAGE_ERR).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # keep calibre's console clean


def _bind_callback_server():
    last_error = None
    for port in CALLBACK_PORTS:
        try:
            server = HTTPServer(('127.0.0.1', port), _CallbackHandler)
            server.auth_result = None
            server.timeout = 1  # poll interval, lets us honour cancellation
            return server, port
        except OSError as exc:
            last_error = exc
    raise AuthError(
        'Could not open a local callback port (tried %s). Another program is '
        'using them — close it and try again. [%s]'
        % (', '.join(str(p) for p in CALLBACK_PORTS), last_error))


def _post_form(url, fields, timeout=30):
    data = urlencode(fields).encode('utf-8')
    request = Request(
        url, data=data, method='POST',
        headers={'Content-Type': 'application/x-www-form-urlencoded',
                 'Accept': 'application/json'})
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode('utf-8'))
    except HTTPError as exc:
        detail = ''
        try:
            detail = exc.read().decode('utf-8', 'replace')[:300]
        except Exception:
            pass
        raise AuthError('Cognito rejected the request (HTTP %s). %s'
                        % (exc.code, detail))
    except URLError as exc:
        raise AuthError('Could not reach Cognito: %s' % exc.reason)


def authorize_url(cfg, challenge, state, redirect_uri):
    params = {
        'response_type': 'code',
        'client_id': cfg['client_id'],
        'redirect_uri': redirect_uri,
        'scope': SCOPES,
        'state': state,
        'code_challenge_method': 'S256',
        'code_challenge': challenge,
    }
    return 'https://%s/oauth2/authorize?%s' % (cfg['cognito_domain'], urlencode(params))


def sign_in(cfg, open_browser, timeout=300, should_cancel=None):
    """Run the interactive sign-in. Blocking — call from a worker thread.

    `open_browser` is called with the authorize URL (injected so the GUI can
    show it as a fallback link). `should_cancel` is polled once a second.
    Returns a token dict ready for `store_tokens`.
    """
    verifier = _b64url(secrets.token_bytes(32))
    challenge = _b64url(hashlib.sha256(verifier.encode('ascii')).digest())
    state = _b64url(secrets.token_bytes(16))

    server, port = _bind_callback_server()
    redirect_uri = 'http://localhost:%d%s' % (port, CALLBACK_PATH)

    try:
        open_browser(authorize_url(cfg, challenge, state, redirect_uri))

        deadline = time.monotonic() + timeout
        while server.auth_result is None:
            if should_cancel is not None and should_cancel():
                raise AuthError('Sign-in cancelled.')
            if time.monotonic() > deadline:
                raise AuthError('Timed out waiting for the browser sign-in.')
            server.handle_request()  # returns after server.timeout if idle
    finally:
        server.server_close()

    result = server.auth_result
    if result.get('error'):
        raise AuthError('Sign-in failed: %s' % result['error'])
    if not result.get('code'):
        raise AuthError('Sign-in did not return an authorization code.')
    # Guards against a stray/forged callback landing on our loopback port.
    if result.get('state') != state:
        raise AuthError('Sign-in state mismatch — aborting for safety.')

    tokens = _post_form('https://%s/oauth2/token' % cfg['cognito_domain'], {
        'grant_type': 'authorization_code',
        'client_id': cfg['client_id'],
        'redirect_uri': redirect_uri,
        'code': result['code'],
        'code_verifier': verifier,
    })
    if not tokens.get('access_token'):
        raise AuthError('Cognito did not return an access token.')
    return _with_expiry(tokens)


def refresh(cfg, refresh_token):
    """Exchange a refresh token for a new access token."""
    tokens = _post_form('https://%s/oauth2/token' % cfg['cognito_domain'], {
        'grant_type': 'refresh_token',
        'client_id': cfg['client_id'],
        'refresh_token': refresh_token,
    })
    if not tokens.get('access_token'):
        raise AuthError('Refresh did not return an access token.')
    # A refresh response omits refresh_token; keep the one we already hold.
    tokens.setdefault('refresh_token', refresh_token)
    return _with_expiry(tokens)


def _with_expiry(tokens):
    tokens = dict(tokens)
    tokens['expires_at'] = time.time() + int(tokens.get('expires_in') or 3600)
    return tokens


def is_expired(tokens):
    if not tokens or not tokens.get('access_token'):
        return True
    return time.time() >= (tokens.get('expires_at') or 0) - _EXPIRY_SKEW_SECONDS


def decode_claims(token):
    """Read a JWT payload without verifying — display purposes only.

    Never used for an access decision: the API re-validates every token
    server-side at the API Gateway authorizer.
    """
    try:
        payload = token.split('.')[1]
        payload += '=' * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload).decode('utf-8'))
    except Exception:
        return {}


def groups_from(tokens):
    """Cognito groups on the access token, for a pre-flight editor check."""
    claims = decode_claims((tokens or {}).get('access_token') or '')
    raw = claims.get('cognito:groups') or []
    if isinstance(raw, str):
        raw = [g for g in raw.strip('[]').replace(',', ' ').split() if g]
    return list(raw)


def describe(tokens):
    """Short 'signed in as …' string for the config screen."""
    claims = decode_claims((tokens or {}).get('id_token')
                           or (tokens or {}).get('access_token') or '')
    return claims.get('email') or claims.get('username') or claims.get('sub') or 'unknown'
