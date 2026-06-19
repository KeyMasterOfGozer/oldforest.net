#!/usr/bin/env node
/**
 * import-lt-tsv.mjs
 *
 * Imports books (and their reading dates) from a LibraryThing TSV export
 * into the oldforest-books and oldforest-reads DynamoDB tables.
 *
 * Usage:
 *   AWS_PROFILE=oldforest node scripts/import-lt-tsv.mjs NewBooks.tsv [--dry-run]
 *
 * Columns used from the LT export:
 *   1  Book Id        — used as part of bookId ("lt-<id>")
 *   2  Title
 *   4  Primary Author — "Last, First" → converted to "First Last"
 *   10 Review
 *   11 Rating         — 1–5 (decimals rounded); empty = null
 *   15 Media          — mapped to format: audiobook / ebook / print
 *   22 Page Count
 *   25 Date Started   — [YYYY-MM-DD] or empty
 *   26 Date Read      — [YYYY-MM-DD] or empty (= finished date)
 *   29 Tags           — "Kindle" → format override
 *   34 ISBN           — [ISBN] or []
 *
 * Re-running is safe: books are upserted (same bookId); reads use a
 * deterministic SHA-256 readId so duplicates are never created.
 */

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

const DRY_RUN     = process.argv.includes('--dry-run');
const TSV_FILE    = process.argv.find(a => a.endsWith('.tsv')) ?? 'NewBooks.tsv';
const BOOKS_TABLE = process.env.BOOKS_TABLE ?? 'oldforest-books';
const READS_TABLE = process.env.READS_TABLE ?? 'oldforest-reads';
const REGION      = process.env.AWS_REGION  ?? 'us-east-1';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// ── TSV parsing ───────────────────────────────────────────────────────────────
/**
 * Split a single TSV line into fields.
 * LT wraps fields containing commas in double-quotes; tabs are never quoted.
 * Strips surrounding quotes and unescapes internal "".
 */
function parseTsvLine(line) {
  return line.split('\t').map(f => {
    f = f.trim();
    if (f.startsWith('"') && f.endsWith('"')) {
      f = f.slice(1, -1).replace(/""/g, '"');
    }
    return f;
  });
}

// ── Field helpers ─────────────────────────────────────────────────────────────

/** "Last, First" → "First Last"; handles "Single" and "First Last" too */
function formatAuthor(raw) {
  if (!raw) return '';
  const parts = raw.split(',').map(s => s.trim());
  if (parts.length === 2 && parts[1]) return `${parts[1]} ${parts[0]}`.trim();
  return raw.trim();
}

/** Strip [brackets] from LT date/ISBN fields → null if empty or [] */
function stripBrackets(val) {
  const s = val.replace(/^\[/, '').replace(/\]$/, '').trim();
  return s || null;
}

/** Parse [YYYY-MM-DD] → "YYYY-MM-DD" or null */
function parseDate(val) {
  const s = stripBrackets(val);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

/**
 * Determine read format from Media field and Tags.
 * Tags "Kindle" → kindle; Media "audiobook" → audiobook; ebook/digital → ebook; else → print
 */
function detectFormat(media, tags) {
  const tagsLower = tags.toLowerCase();
  const mediaLower = media.toLowerCase();

  if (tagsLower.includes('kindle')) return 'kindle';
  if (mediaLower.includes('audiobook')) return 'audiobook';
  if (mediaLower.includes('ebook') || mediaLower.includes('digital')) return 'ebook';
  if (media) return 'print';
  return null;
}

/** Deterministic readId — same book + dates always yields same ID (safe to re-run) */
function deterministicReadId(bookId, started, finished) {
  const key = `${bookId}|${started ?? ''}|${finished ?? ''}`;
  return 'lt-' + createHash('sha256').update(key).digest('hex').slice(0, 32);
}

// ── Transform ─────────────────────────────────────────────────────────────────
function transformRow(fields) {
  // 1-indexed in LT docs; 0-indexed in the array
  const ltId      = fields[0];
  const title     = fields[1]?.trim();
  const author    = formatAuthor(fields[3]);
  const review    = fields[9]?.trim()  || null;
  const ratingRaw = fields[10]?.trim() || null;
  const media     = fields[14]?.trim() || '';
  const pageCount = parseInt(fields[21]) || null;
  const started   = parseDate(fields[24]);
  const finished  = parseDate(fields[25]);
  const tags      = fields[28]?.trim() || '';
  const isbnRaw   = stripBrackets(fields[33] ?? '');

  if (!ltId || !title) return null;

  const bookId = `lt-${ltId}`;
  const now    = new Date().toISOString();

  // Tags: split comma/semicolon separated, lowercase, dedupe
  const tagList = tags
    ? [...new Set(tags.split(/[,;|]/).map(t => t.trim().toLowerCase()).filter(Boolean))]
    : [];

  const book = {
    bookId,
    allBooks:  'ALL',
    title,
    author,
    ...(isbnRaw    && { isbn: isbnRaw }),
    ...(pageCount  && { pageCount }),
    ...(tagList.length && { tags: tagList }),
    createdAt: now,
    updatedAt: now,
  };

  // Only create a read if there's at least one date
  let read = null;
  if (started || finished) {
    const rating = ratingRaw ? Math.round(parseFloat(ratingRaw)) : null;
    const format = detectFormat(media, tags);

    read = {
      readId:   deterministicReadId(bookId, started, finished),
      allReads: 'ALL',
      bookId,
      ...(started  && { started }),
      ...(finished && { finished }),
      ...(format   && { format }),
      ...(rating   && rating >= 1 && rating <= 5 && { rating }),
      ...(review   && { review }),
      createdAt: now,
      updatedAt: now,
    };
  }

  return { book, read };
}

// ── Batch write ───────────────────────────────────────────────────────────────
async function batchWrite(tableName, items) {
  const CHUNK = 25;
  let written = 0;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    if (!DRY_RUN) {
      await dynamo.send(new BatchWriteCommand({
        RequestItems: {
          [tableName]: chunk.map(Item => ({ PutRequest: { Item } })),
        },
      }));
    }
    written += chunk.length;
    process.stdout.write(`\r  ${tableName}: ${written}/${items.length}`);
  }
  console.log('');
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (DRY_RUN) console.log('DRY RUN — no writes will occur.\n');

  const raw = readFileSync(TSV_FILE, 'utf8');
  // Normalize line endings
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // First line is header — use it to verify we have the expected columns
  const header = parseTsvLine(lines[0]);
  const expectedCols = { 0: 'Book Id', 1: 'Title', 3: 'Primary Author', 24: 'Date Started', 25: 'Date Read' };
  for (const [idx, name] of Object.entries(expectedCols)) {
    if (header[idx] !== name) {
      console.warn(`⚠  Column ${parseInt(idx)+1} expected "${name}", got "${header[idx]}" — continuing anyway`);
    }
  }
  console.log(`Columns verified. Parsing ${lines.length - 1} rows from ${TSV_FILE}…\n`);

  const bookItems = [];
  const readItems = [];
  let skipped = 0;
  let noDate  = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = parseTsvLine(line);
    const result = transformRow(fields);

    if (!result) { skipped++; continue; }

    const { book, read } = result;
    bookItems.push(book);
    if (read) {
      readItems.push(read);
    } else {
      noDate++;
    }
  }

  console.log(`Books parsed:        ${bookItems.length}`);
  console.log(`Reads parsed:        ${readItems.length}`);
  console.log(`Books without dates: ${noDate} (added to books table only)`);
  if (skipped) console.log(`Rows skipped:        ${skipped}`);

  if (DRY_RUN) {
    console.log('\n── Sample book ──');
    console.log(JSON.stringify(bookItems[0], null, 2));
    if (readItems.length) {
      console.log('\n── Sample read ──');
      console.log(JSON.stringify(readItems[0], null, 2));
    }
    // Show a few books without reads
    const noReads = bookItems.filter(b => !readItems.find(r => r.bookId === b.bookId));
    if (noReads.length) {
      console.log(`\n── Sample book without dates (first 3) ──`);
      noReads.slice(0, 3).forEach(b => console.log(`  ${b.bookId}  ${b.title}`));
    }
    console.log('\nDry run complete. Re-run without --dry-run to write to DynamoDB.');
    return;
  }

  console.log(`\nWriting to DynamoDB (region: ${REGION})…`);
  await batchWrite(BOOKS_TABLE, bookItems);
  await batchWrite(READS_TABLE, readItems);

  console.log('\n✓ Import complete.');
  console.log(`  Books written: ${bookItems.length}`);
  console.log(`  Reads written: ${readItems.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
