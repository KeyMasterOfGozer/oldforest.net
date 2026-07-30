'use strict';

/**
 * util.js — shared helpers used across site pages.
 *
 * Load before any page script that calls these functions:
 *   <script src="/js/util.js"></script>
 */

/**
 * HTML-escape a value for safe insertion into HTML attributes and text content.
 * Escapes & < > " and ' so the result is safe in both attribute and text contexts.
 */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Validate a stored URL before it's ever placed in an href/src attribute.
 * Only http:/https: are allowed — blocks javascript:/data:/vbscript: XSS payloads
 * that would otherwise survive esc()'s HTML-entity escaping untouched.
 * Returns '' (falsy) for anything unsafe or unparseable.
 */
function safeUrl(u) {
  try {
    const parsed = new URL(String(u ?? ''), window.location.origin);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
}

/**
 * Format a book's series + index as "Series Name [N]", or "" if the book has no series.
 * Integer indices are shown without a decimal point (e.g. [8] not [8.0]).
 */
function seriesLabel(book) {
  if (!book?.series) return '';
  if (book.seriesIndex == null) return book.series;
  const n = parseFloat(book.seriesIndex);
  const idx = isNaN(n) ? '' : (n % 1 === 0 ? String(Math.round(n)) : String(n));
  return idx ? `${book.series} [${idx}]` : book.series;
}

/** Render a 0-5 star rating as "★★★☆☆"-style text. Returns '' for falsy/zero ratings. */
function starsHtml(rating) {
  if (!rating || rating <= 0) return '';
  const r = Math.round(rating);
  return '★'.repeat(r) + '☆'.repeat(5 - r);
}

/**
 * Parse a date-only ISO string ("YYYY-MM-DD") or full ISO datetime into a Date,
 * anchored at noon UTC for date-only strings so it round-trips safely through
 * further date math (comparisons, timeline positioning) without shifting a day
 * in timezones on either side of UTC. Returns null for falsy/invalid input.
 * For *display* formatting, use fmtShortDate() instead — see its comment for why.
 */
function parseISODate(str) {
  if (!str) return null;
  const d = new Date(str.length === 10 ? str + 'T12:00:00Z' : str);
  return isNaN(d) ? null : d;
}

/**
 * Format a date-only ISO string ("YYYY-MM-DD") for display, e.g. "Mar 15, 2025".
 * Deliberately anchors at LOCAL midnight (not noon UTC like parseISODate) —
 * parsing and formatting both in the viewer's local timezone cancel out exactly,
 * so the displayed date always matches the input date with no timezone-dependent
 * off-by-one risk. (Noon-UTC anchoring is fine for parseISODate's date-math use
 * cases, but would risk shifting the displayed day for viewers in UTC+13/+14.)
 */
function fmtShortDate(str) {
  if (!str) return '';
  const d = new Date(str + 'T00:00:00');
  return isNaN(d) ? '' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
