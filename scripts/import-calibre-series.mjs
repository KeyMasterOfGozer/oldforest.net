#!/usr/bin/env node
/**
 * import-calibre-series.mjs
 *
 * Reads CalibreCatalog.csv and backfills the 'series' and 'seriesIndex'
 * fields into the oldforest-books DynamoDB table for any book that:
 *   - does not already have a series set, AND
 *   - can be confidently matched to a Calibre row by title + author
 *
 * Matching strategy:
 *   1. Normalize both sides: lowercase, strip punctuation, collapse whitespace.
 *   2. Compute word-overlap scores for title and author independently.
 *   3. Require title overlap ≥ 0.7 AND author overlap ≥ 0.5 for a confident match.
 *   4. If multiple Calibre rows match a book, pick the highest-scoring one.
 *
 * Usage:
 *   AWS_PROFILE=oldforest node scripts/import-calibre-series.mjs \
 *       CalibreCatalog.csv [--dry-run] [--verbose] [--unmatched unmatched.csv]
 *
 * Options:
 *   --dry-run    Print proposed updates without writing to DynamoDB.
 *   --verbose    Show every book checked, including those skipped.
 */

import { readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const require  = createRequire(import.meta.url);

const DRY_RUN   = process.argv.includes('--dry-run');
const VERBOSE   = process.argv.includes('--verbose');
const CSV_FILE  = process.argv.find(a => a.endsWith('.csv'));

// --unmatched <outfile.csv>
const unmatchedIdx  = process.argv.indexOf('--unmatched');
const UNMATCHED_OUT = unmatchedIdx !== -1 ? process.argv[unmatchedIdx + 1] : null;
const BOOKS_TABLE = process.env.BOOKS_TABLE ?? 'oldforest-books';
const REGION    = process.env.AWS_REGION  ?? 'us-east-1';

if (!CSV_FILE) {
  console.error('Usage: node scripts/import-calibre-series.mjs <file.csv> [--dry-run] [--verbose]');
  process.exit(1);
}

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// ── CSV parsing (handles quoted fields with embedded commas/newlines) ─────────

function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"')                     { inQuote = false; }
      else                                     { cur += ch; }
    } else {
      if      (ch === '"') { inQuote = true; }
      else if (ch === ',') { fields.push(cur); cur = ''; }
      else                 { cur += ch; }
    }
  }
  fields.push(cur);
  return fields;
}

function parseCsv(filePath) {
  // Strip BOM, normalize line endings
  let raw = readFileSync(filePath, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Reassemble logical lines (quoted fields can contain newlines)
  const logicalLines = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      inQuote = !inQuote;
      cur += ch;
    } else if (ch === '\n' && !inQuote) {
      logicalLines.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) logicalLines.push(cur);

  const header = parseCsvLine(logicalLines[0]).map(h => h.trim().toLowerCase().replace(/^#/, ''));
  const rows = [];
  for (let i = 1; i < logicalLines.length; i++) {
    if (!logicalLines[i].trim()) continue;
    const vals = parseCsvLine(logicalLines[i]);
    const obj = {};
    header.forEach((h, j) => { obj[h] = (vals[j] ?? '').trim(); });
    rows.push(obj);
  }
  return rows;
}

// ── Text normalisation ────────────────────────────────────────────────────────

function norm(s) {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordSet(s) {
  return new Set(norm(s).split(' ').filter(Boolean));
}

function overlap(a, b) {
  const sa = wordSet(a);
  const sb = wordSet(b);
  if (!sa.size || !sb.size) return 0;
  const common = [...sa].filter(w => sb.has(w)).length;
  return common / Math.max(sa.size, sb.size);
}

/**
 * Return an ordered list of title strings to try when matching.
 *
 * DB titles often carry noise that Calibre omits.  We generate variants from
 * two "bases": the full title and the part after the first colon (the subtitle).
 * Both bases then get stripped of parentheticals and/or trailing colon clauses.
 *
 * Examples:
 *   "Proven Guilty (Dresden Files #8)"
 *     → "Proven Guilty"                          (strip parens)
 *
 *   "Foundation: Edge"
 *     → "Foundation"                             (strip colon-and-after)
 *
 *   "Hard Luck Hank: Suck My Cosmos (Volume 4)"
 *     after-colon base = "Suck My Cosmos (Volume 4)"
 *     → "Suck My Cosmos"                         (strip parens from base)
 *
 *   "A Thousand Li: the Fourth Stage: An Epic Progression Fantasy Novel"
 *     after-colon base = "the Fourth Stage: An Epic Progression Fantasy Novel"
 *     → "the Fourth Stage"                       (strip trailing colon from base)
 *
 * Duplicates are removed; original title always comes first (highest precision).
 */
function titleVariants(title) {
  const t = title ?? '';

  const stripParens      = s => s.replace(/\s*\([^)]*\)/g, '').trim();
  const stripAfterColon  = s => s.replace(/\s*:.*$/, '').trim();

  // Build two bases: full title, and the text after the first colon
  const bases = [t];
  const colonIdx = t.indexOf(':');
  if (colonIdx !== -1) {
    const sub = t.slice(colonIdx + 1).trim();
    if (sub) bases.push(sub);
  }

  // For each base generate four variants (original, no-parens, no-trailing-colon, both)
  const candidates = [];
  for (const base of bases) {
    candidates.push(base);
    candidates.push(stripParens(base));
    candidates.push(stripAfterColon(base));
    candidates.push(stripParens(stripAfterColon(base)));
    candidates.push(stripAfterColon(stripParens(base)));
  }

  // Deduplicate, preserving order (most specific first)
  const seen = new Set();
  return candidates.filter(v => {
    if (!v || seen.has(v)) return false;
    seen.add(v);
    return true;
  });
}

// ── DynamoDB helpers ──────────────────────────────────────────────────────────

async function scanAll() {
  const items = [];
  let lastKey;
  do {
    const result = await dynamo.send(new ScanCommand({
      TableName: BOOKS_TABLE,
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(result.Items ?? []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

/** Update arbitrary book fields (object keys become DynamoDB attribute names). */
async function updateBook(bookId, fields) {
  const sets   = ['updatedAt = :updatedAt'];
  const names  = {};
  const values = { ':updatedAt': new Date().toISOString() };
  for (const [k, v] of Object.entries(fields)) {
    names[`#${k}`] = k;
    sets.push(`#${k} = :${k}`);
    values[`:${k}`] = v;
  }
  await dynamo.send(new UpdateCommand({
    TableName: BOOKS_TABLE,
    Key: { bookId },
    UpdateExpression: 'SET ' + sets.join(', '),
    ExpressionAttributeNames:  names,
    ExpressionAttributeValues: values,
  }));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (DRY_RUN) console.log('DRY RUN — no changes will be written.\n');

  console.log(`Parsing CSV: ${CSV_FILE}…`);
  const calibreRows = parseCsv(CSV_FILE);
  const withSeries  = calibreRows.filter(r => r.series?.trim());
  console.log(`  Total Calibre rows: ${calibreRows.length}`);
  console.log(`  Rows with series data: ${withSeries.length}\n`);

  console.log(`Scanning ${BOOKS_TABLE}…`);
  const allBooks = await scanAll();
  console.log(`  Total books in DB: ${allBooks.length}\n`);

  let updated = 0, titleOnly = 0, noChange = 0, noMatch = 0;
  const unmatchedBooks = [];

  for (const book of allBooks) {
    let best      = null;
    let bestScore = 0;
    let matchedVariant = book.title;

    // Try each title variant in order; stop as soon as one yields a confident match.
    for (const variant of titleVariants(book.title)) {
      let variantBest  = null;
      let variantScore = 0;

      for (const row of withSeries) {
        const titleScore  = overlap(variant,      row.title);
        const authorScore = overlap(book.author,  row.authors);
        const score = titleScore * 0.65 + authorScore * 0.35;

        if (titleScore >= 0.7 && authorScore >= 0.5 && score > variantScore) {
          variantScore = score;
          variantBest  = row;
        }
      }

      if (variantBest) {
        best           = variantBest;
        bestScore      = variantScore;
        matchedVariant = variant;
        break;
      }
    }

    if (!best) {
      noMatch++;
      unmatchedBooks.push(book);
      if (VERBOSE) console.log(`  NO MATCH  "${book.title}" by ${book.author}`);
      continue;
    }

    const calibreTitle = best.title.trim();
    const seriesName   = best.series.trim();
    const _si          = parseFloat(best.series_index);
    const seriesIndex  = isNaN(_si) ? 1 : _si;  // preserve 0 (valid prequel index)
    const titleChanged = calibreTitle !== book.title;
    const seriesMissing = !book.series;
    const variantNote  = matchedVariant !== book.title ? ` [matched as "${matchedVariant}"]` : '';

    // Nothing to do — title already matches and series was set in a prior run
    if (!titleChanged && !seriesMissing) {
      noChange++;
      if (VERBOSE) console.log(`  NO CHANGE "${book.title}" by ${book.author}`);
      continue;
    }

    // Build the update payload
    const fields = {};
    if (titleChanged)  fields.title = calibreTitle;
    if (seriesMissing) { fields.series = seriesName; fields.seriesIndex = seriesIndex; }

    const action = seriesMissing ? 'MATCH+SERIES' : 'TITLE UPDATE';
    console.log(`  ${action}  "${book.title}" by ${book.author}`);
    if (titleChanged)  console.log(`    title  "${book.title}" → "${calibreTitle}"`);
    if (seriesMissing) console.log(`    series → ${seriesName} [${seriesIndex}]  (score: ${bestScore.toFixed(2)}${variantNote})`);

    if (!DRY_RUN) await updateBook(book.bookId, fields);
    if (seriesMissing) updated++; else titleOnly++;
  }

  console.log('\n──────────────────────────────────────────────');
  const verb = DRY_RUN ? 'Would update' : 'Updated';
  console.log(`${verb} (series + title): ${updated}`);
  console.log(`${verb} (title only):     ${titleOnly}`);
  console.log(`No match found:           ${noMatch}`);
  console.log(`Already up to date:       ${noChange}`);
  if (DRY_RUN) console.log('\nRe-run without --dry-run to apply changes.');

  // Write unmatched CSV if requested
  if (UNMATCHED_OUT && unmatchedBooks.length) {
    function csvField(v) {
      const s = String(v ?? '');
      // Quote if the value contains a comma, double-quote, or newline
      return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }
    const lines = ['bookId,author,title'];
    for (const b of unmatchedBooks) {
      lines.push([csvField(b.bookId), csvField(b.author), csvField(b.title)].join(','));
    }
    writeFileSync(UNMATCHED_OUT, lines.join('\n') + '\n', 'utf8');
    console.log(`\nUnmatched books written to: ${UNMATCHED_OUT} (${unmatchedBooks.length} rows)`);
  } else if (UNMATCHED_OUT) {
    console.log('\nNo unmatched books — nothing written to', UNMATCHED_OUT);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
