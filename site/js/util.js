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
