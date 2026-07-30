'use strict';

/**
 * auth.js — shared Cognito PKCE helpers used across authenticated pages.
 *
 * Load after util.js and before any page script that calls these functions:
 *   <script src="/js/util.js"></script>
 *   <script src="/js/auth.js"></script>
 *
 * Each page keeps its own CFG object (cognitoDomain/clientId/redirectUri differ
 * legitimately per page), its own token-refresh/apiFetch orchestration (those
 * vary meaningfully across pages and aren't consolidated here), and a one-line
 * wrapper with its original name so no call site elsewhere in the page changes:
 *
 *   function login()  { return pkceLogin(CFG); }
 *   function logout() { return pkceLogout(CFG); }
 *   async function exchangeCode(code) { return pkceExchangeCode(CFG, code); }
 *
 * (Named pkceLogin/pkceLogout/pkceExchangeCode here — not login/logout/exchangeCode —
 * so each page's same-named wrapper doesn't recurse into itself.)
 */

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function generatePKCE() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
}

function parseJWT(token) {
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); }
  catch { return {}; }
}

/**
 * Redirect to the Cognito Hosted UI to sign in.
 * Guards `return_to` so a pending deep link is never clobbered by a second
 * login call (e.g. a 401 mid-session triggering another sign-in redirect).
 */
async function pkceLogin(cfg) {
  const { verifier, challenge } = await generatePKCE();
  sessionStorage.setItem('pkce_verifier', verifier);
  if (!sessionStorage.getItem('return_to')) {
    sessionStorage.setItem('return_to', window.location.href);
  }
  const p = new URLSearchParams({
    response_type: 'code', client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri, scope: 'openid email profile aws.cognito.signin.user.admin',
    code_challenge_method: 'S256', code_challenge: challenge,
  });
  window.location.href = `https://${cfg.cognitoDomain}/oauth2/authorize?${p}`;
}

function pkceLogout(cfg) {
  sessionStorage.clear();
  const p = new URLSearchParams({ client_id: cfg.clientId, logout_uri: cfg.redirectUri });
  window.location.href = `https://${cfg.cognitoDomain}/logout?${p}`;
}

/** Exchange an OAuth authorization code for tokens using the stored PKCE verifier. */
async function pkceExchangeCode(cfg, code) {
  const verifier = sessionStorage.getItem('pkce_verifier');
  const res = await fetch(`https://${cfg.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri, code, code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error('Token exchange failed');
  return res.json();
}
