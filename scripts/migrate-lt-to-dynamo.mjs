#!/usr/bin/env node
/**
 * migrate-lt-to-dynamo.mjs
 *
 * Fetches all reading data from the lt-proxy Lambda, transforms it into the
 * new books/reads DynamoDB schema, and batch-writes everything.
 *
 * Usage:
 *   AWS_PROFILE=<profile> node scripts/migrate-lt-to-dynamo.mjs [--dry-run]
 *
 * Prerequisites:
 *   npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
 *   (run from the repo root, or install globally)
 *
 * Environment variables (optional overrides):
 *   LT_PROXY_URL   — URL of the lt-proxy API endpoint
 *   BOOKS_TABLE    — DynamoDB table name for books (default: oldforest-books)
 *   READS_TABLE    — DynamoDB table name for reads (default: oldforest-reads)
 *   AWS_REGION     — AWS region (default: us-east-1)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'crypto';

// Deterministic ID: same book + same dates always produces the same readId,
// so re-running the migration is safe (upsert, no duplicates).
function deterministicReadId(bookId, started, finished, index) {
  const key = `${bookId}|${started ?? ''}|${finished ?? ''}|${index}`;
  return 'lt-' + createHash('sha256').update(key).digest('hex').slice(0, 32);
}

const DRY_RUN     = process.argv.includes('--dry-run');
const LT_URL      = process.env.LT_PROXY_URL ?? 'https://aijo86kijl.execute-api.us-east-1.amazonaws.com/v1/proxy/librarything';
const BOOKS_TABLE = process.env.BOOKS_TABLE ?? 'oldforest-books';
const READS_TABLE = process.env.READS_TABLE ?? 'oldforest-reads';
const REGION      = process.env.AWS_REGION  ?? 'us-east-1';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// ── Fetch from lt-proxy ───────────────────────────────────────────────────────
async function fetchLT() {
  console.log('Fetching from lt-proxy…');
  const res = await fetch(LT_URL);
  if (!res.ok) throw new Error(`lt-proxy returned ${res.status}`);
  const data = await res.json();
  return data;
}

// ── Transform ─────────────────────────────────────────────────────────────────
/**
 * LT book shape (from widgetResults):
 *   book_id, title, primary_author, startfinishdates[], tags[], rating,
 *   cover (url), ISBN, pages
 *
 * startfinishdates entries:
 *   { started_stamp, finished_stamp, started, finished } (stamps are Unix seconds as strings)
 */
function transformBook(ltBook) {
  const now = new Date().toISOString();
  const bookId = `lt-${ltBook.book_id}`;

  // Build cover URL (LT serves small/medium covers)
  const coverUrl = ltBook.cover?.replace('/s/', '/m/') ?? null;

  // Sanitize tags — LT returns an object keyed by tag name with count values
  let tags = [];
  if (ltBook.tags && typeof ltBook.tags === 'object') {
    tags = Object.keys(ltBook.tags).map(t => t.toLowerCase().trim()).filter(Boolean);
  } else if (Array.isArray(ltBook.tags)) {
    tags = ltBook.tags.map(t => String(t).toLowerCase().trim());
  }

  const book = {
    bookId,
    allBooks: 'ALL',
    title:    (ltBook.title ?? '').trim(),
    // LT provides author_fl ("First Last") and primary_author ("Last, First")
    // Prefer author_fl since it's already display-ready
    author:   (ltBook.author_fl ?? formatAuthor(ltBook.primary_author) ?? '').trim(),
    coverUrl: coverUrl || undefined,
    pageCount: ltBook.pages ? parseInt(ltBook.pages) || undefined : undefined,
    isbn:     ltBook.ISBN || undefined,
    tags,
    createdAt: now,
    updatedAt: now,
  };

  // Clean undefined
  Object.keys(book).forEach(k => { if (book[k] === undefined) delete book[k]; });

  // Build reads
  const reads = [];
  const dates = ltBook.startfinishdates ?? [];
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const started  = stampToDate(d.started_stamp  ?? d.started);
    const finished = stampToDate(d.finished_stamp ?? d.finished);
    if (!started && !finished) continue;

    const readId = deterministicReadId(bookId, started, finished, i);
    const read = {
      readId,
      allReads: 'ALL',
      bookId,
      started:  started  || undefined,
      finished: finished || undefined,
      // LT stores a single rating per book, not per read — attach to last read only
      createdAt: now,
      updatedAt: now,
    };
    Object.keys(read).forEach(k => { if (read[k] === undefined) delete read[k]; });
    reads.push(read);
  }

  // Attach LT rating to the most recent read (by finished date)
  if (ltBook.rating && reads.length) {
    const rating = parseInt(ltBook.rating);
    if (rating >= 1 && rating <= 5) {
      const lastRead = reads.slice().sort((a, b) =>
        (b.finished ?? b.started ?? '').localeCompare(a.finished ?? a.started ?? '')
      )[0];
      lastRead.rating = rating;
    }
  }

  return { book, reads };
}

function formatAuthor(raw) {
  if (!raw) return '';
  // LT stores as "Last, First" — convert to "First Last" for display
  const parts = raw.split(',').map(s => s.trim());
  if (parts.length === 2) return `${parts[1]} ${parts[0]}`.trim();
  return raw.trim();
}

function stampToDate(val) {
  if (!val) return null;
  // Could be Unix timestamp (string or number) or YYYY-MM-DD already
  if (typeof val === 'string' && val.match(/^\d{4}-\d{2}-\d{2}$/)) return val;
  const ts = parseInt(val);
  if (isNaN(ts) || ts <= 0) return null;
  // Unix timestamp in seconds
  return new Date(ts * 1000).toISOString().slice(0, 10);
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

  const ltData = await fetchLT();

  // lt-proxy returns { books: { <bookId>: bookObj, … } } or an array
  let ltBooks;
  if (Array.isArray(ltData.books)) {
    ltBooks = ltData.books;
  } else if (ltData.books && typeof ltData.books === 'object') {
    ltBooks = Object.values(ltData.books);
  } else {
    throw new Error('Unexpected lt-proxy response shape: ' + JSON.stringify(Object.keys(ltData)));
  }

  console.log(`Found ${ltBooks.length} books from LibraryThing.`);

  const allBookItems = [];
  const allReadItems = [];
  let booksWithReads = 0;

  for (const ltBook of ltBooks) {
    const { book, reads } = transformBook(ltBook);
    if (!book.title) continue; // skip empty
    allBookItems.push(book);
    if (reads.length) {
      booksWithReads++;
      allReadItems.push(...reads);
    }
  }

  console.log(`Transformed: ${allBookItems.length} books, ${allReadItems.length} reads (${booksWithReads} books have at least one read).`);

  if (DRY_RUN) {
    console.log('\nSample book:', JSON.stringify(allBookItems[0], null, 2));
    if (allReadItems.length) {
      console.log('\nSample read:', JSON.stringify(allReadItems[0], null, 2));
    }
    console.log('\nDry run complete. Re-run without --dry-run to write to DynamoDB.');
    return;
  }

  console.log(`\nWriting to DynamoDB (region: ${REGION})…`);
  await batchWrite(BOOKS_TABLE, allBookItems);
  await batchWrite(READS_TABLE, allReadItems);

  console.log('\nMigration complete.');
  console.log(`  Books written: ${allBookItems.length}`);
  console.log(`  Reads written: ${allReadItems.length}`);
  console.log('\nNext steps:');
  console.log('  1. Open the Reading Log editor and verify a few entries.');
  console.log('  2. Manually add any books/reads logged after 2025-01-26.');
  console.log('  3. Update the Book Timeline to use GET /v1/reading/reads instead of lt-proxy.');
}

main().catch(e => { console.error(e); process.exit(1); });
