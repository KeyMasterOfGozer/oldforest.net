#!/usr/bin/env node
/**
 * enrich-books.mjs
 *
 * Scans the oldforest-books DynamoDB table, finds books with missing data,
 * queries the chosen metadata source, and updates the table.
 *
 * Sources:
 *   --source google  (default) — Google Books API; fills googleBooksId, pageCount, coverUrl, isbn
 *   --source ol                — OpenLibrary;      fills openLibraryId, pageCount, coverUrl, isbn
 *
 * Google Books setup:
 *   1. Go to https://console.cloud.google.com/
 *   2. Create or select a project
 *   3. APIs & Services → Library → search "Books API" → Enable
 *   4. APIs & Services → Credentials → Create Credentials → API Key
 *   Set GOOGLE_BOOKS_API_KEY env var.  (Not needed for --source ol)
 *
 * Usage:
 *   # Google Books (default)
 *   GOOGLE_BOOKS_API_KEY=your_key AWS_PROFILE=oldforest node scripts/enrich-books.mjs [--dry-run] [--all]
 *
 *   # OpenLibrary (no API key required)
 *   AWS_PROFILE=oldforest node scripts/enrich-books.mjs --source ol [--dry-run] [--all]
 *
 * Options:
 *   --dry-run      Print proposed updates without writing to DynamoDB
 *   --all          Re-check every book, even those that already seem complete
 *   --source ol    Use OpenLibrary instead of Google Books
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const DRY_RUN     = process.argv.includes('--dry-run');
const CHECK_ALL   = process.argv.includes('--all');
const BOOKS_TABLE = process.env.BOOKS_TABLE ?? 'oldforest-books';
const REGION      = process.env.AWS_REGION  ?? 'us-east-1';

const sourceArg = process.argv.find(a => a.startsWith('--source=')) ?? process.argv[process.argv.indexOf('--source') + 1];
const SOURCE    = (sourceArg === 'ol') ? 'ol' : 'google';

const GB_KEY = process.env.GOOGLE_BOOKS_API_KEY;
if (SOURCE === 'google' && !GB_KEY) {
  console.error('Error: GOOGLE_BOOKS_API_KEY environment variable is not set.');
  console.error('See the script header for setup instructions, or use --source ol instead.');
  process.exit(1);
}

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

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

async function updateBook(bookId, fields) {
  const sets = ['updatedAt = :updatedAt'];
  const names = {};
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
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

// ── Shared ────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normStr(s) {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
}

function wordOverlap(a, b) {
  const setA = new Set(normStr(a).split(' ').filter(Boolean));
  const setB = new Set(normStr(b).split(' ').filter(Boolean));
  return [...setA].filter(w => setB.has(w)).length / Math.max(setA.size, 1);
}

// ── Google Books ──────────────────────────────────────────────────────────────

async function searchGoogleBooks(title, author) {
  const q = [
    title  ? `intitle:${encodeURIComponent(title)}`  : '',
    author ? `inauthor:${encodeURIComponent(author)}` : '',
  ].filter(Boolean).join('+');
  const url = `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=5&key=${GB_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Books API ${res.status}: ${await res.text()}`);
  return (await res.json()).items ?? [];
}

function pickBestGBMatch(items, book) {
  let best = null, bestScore = -1;
  for (const item of items) {
    const info = item.volumeInfo ?? {};
    const titleOverlap  = wordOverlap(book.title,  info.title);
    const authorOverlap = wordOverlap(book.author, (info.authors ?? []).join(' '));
    const bonus = (info.pageCount ? 0.1 : 0) + (info.imageLinks?.thumbnail ? 0.1 : 0)
                + ((info.industryIdentifiers ?? []).some(x => x.type === 'ISBN_13') ? 0.1 : 0);
    const score = titleOverlap * 0.5 + authorOverlap * 0.4 + bonus;
    if (score > bestScore) { bestScore = score; best = { item, score }; }
  }
  return best && best.score >= 0.25 ? best.item : null;
}

function extractGBFields(item, existing) {
  const info = item.volumeInfo ?? {};
  const updates = {};
  // Write to googleBooksId — not openLibraryId
  if (!existing.googleBooksId && item.id) updates.googleBooksId = item.id;
  if (!existing.pageCount && info.pageCount) updates.pageCount = info.pageCount;
  if (!existing.coverUrl && info.imageLinks?.thumbnail) {
    updates.coverUrl = info.imageLinks.thumbnail.replace('http://', 'https://').replace('zoom=1', 'zoom=2');
  }
  if (!existing.isbn) {
    const isbn = (info.industryIdentifiers ?? []).find(x => x.type === 'ISBN_13')
              ?? (info.industryIdentifiers ?? []).find(x => x.type === 'ISBN_10');
    if (isbn) updates.isbn = isbn.identifier;
  }
  return updates;
}

// ── OpenLibrary ───────────────────────────────────────────────────────────────

async function searchOpenLibrary(title, author) {
  const params = new URLSearchParams({
    fields: 'key,title,author_name,isbn,cover_i,number_of_pages_median',
    limit:  '5',
  });
  if (title)  params.set('title',  title);
  if (author) params.set('author', author);
  const res = await fetch(`https://openlibrary.org/search.json?${params}`);
  if (!res.ok) throw new Error(`OpenLibrary API ${res.status}: ${await res.text()}`);
  return (await res.json()).docs ?? [];
}

function pickBestOLMatch(docs, book) {
  let best = null, bestScore = -1;
  for (const doc of docs) {
    const titleOverlap  = wordOverlap(book.title,  doc.title);
    const authorOverlap = wordOverlap(book.author, (doc.author_name ?? []).join(' '));
    const bonus = (doc.number_of_pages_median ? 0.1 : 0) + (doc.cover_i ? 0.1 : 0)
                + ((doc.isbn ?? []).length ? 0.1 : 0);
    const score = titleOverlap * 0.5 + authorOverlap * 0.4 + bonus;
    if (score > bestScore) { bestScore = score; best = { doc, score }; }
  }
  return best && best.score >= 0.25 ? best.doc : null;
}

function extractOLFields(doc, existing) {
  const updates = {};
  // Write to openLibraryId — not googleBooksId
  const olKey = (doc.key ?? '').replace('/works/', '');
  if (!existing.openLibraryId && olKey) updates.openLibraryId = olKey;
  if (!existing.pageCount && doc.number_of_pages_median) updates.pageCount = doc.number_of_pages_median;
  if (!existing.coverUrl && doc.cover_i) {
    updates.coverUrl = `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
  }
  if (!existing.isbn) {
    const isbn13 = (doc.isbn ?? []).find(x => x.length === 13) ?? (doc.isbn ?? [])[0];
    if (isbn13) updates.isbn = isbn13;
  }
  return updates;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (DRY_RUN) console.log('DRY RUN — no changes will be written.\n');
  console.log(`Source: ${SOURCE === 'ol' ? 'OpenLibrary' : 'Google Books'}`);
  console.log(`Scanning ${BOOKS_TABLE}…`);
  const allBooks = await scanAll();
  console.log(`  Total books: ${allBooks.length}\n`);

  // Fields checked depend on the source being used
  const needsEnrich = CHECK_ALL ? allBooks : allBooks.filter(b => {
    if (SOURCE === 'ol')     return !b.openLibraryId || !b.pageCount || !b.coverUrl || !b.isbn;
    /* google */             return !b.googleBooksId  || !b.pageCount || !b.coverUrl || !b.isbn;
  });

  console.log(`  Books needing enrichment: ${needsEnrich.length}`);
  if (!needsEnrich.length) {
    console.log('\nAll books already have complete metadata. Use --all to re-check anyway.');
    return;
  }

  let updated = 0, skipped = 0, noMatch = 0, errors = 0;

  for (let i = 0; i < needsEnrich.length; i++) {
    const book = needsEnrich[i];
    const missingFields = SOURCE === 'ol'
      ? [!book.openLibraryId && 'openLibraryId', !book.pageCount && 'pageCount', !book.coverUrl && 'coverUrl', !book.isbn && 'isbn']
      : [!book.googleBooksId  && 'googleBooksId',  !book.pageCount && 'pageCount', !book.coverUrl && 'coverUrl', !book.isbn && 'isbn'];

    process.stdout.write(`[${i + 1}/${needsEnrich.length}] "${book.title}" — missing: ${missingFields.filter(Boolean).join(', ')} … `);

    try {
      let results;
      let lastError;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await sleep(attempt === 1 ? 250 : 10_000);
          results = SOURCE === 'ol'
            ? await searchOpenLibrary(book.title, book.author)
            : await searchGoogleBooks(book.title, book.author);
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
          if (attempt < 3) process.stdout.write(`(error, retrying ${attempt}/2) `);
        }
      }
      if (lastError) throw lastError;

      if (!results?.length) { console.log('no results'); noMatch++; continue; }

      const match = SOURCE === 'ol' ? pickBestOLMatch(results, book) : pickBestGBMatch(results, book);
      if (!match) { console.log('no confident match'); noMatch++; continue; }

      const updates = SOURCE === 'ol' ? extractOLFields(match, book) : extractGBFields(match, book);
      if (!Object.keys(updates).length) { console.log('nothing new to add'); skipped++; continue; }

      const matchTitle = SOURCE === 'ol' ? match.title : (match.volumeInfo?.title ?? '');
      console.log(`matched "${matchTitle}"`);
      for (const [k, v] of Object.entries(updates)) console.log(`    ${k}: ${v}`);

      if (!DRY_RUN) await updateBook(book.bookId, updates);
      updated++;
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      errors++;
    }
  }

  console.log('\n──────────────────────────────────────');
  const verb = DRY_RUN ? 'Would update' : 'Updated';
  console.log(`${verb}: ${updated}  |  No match: ${noMatch}  |  Already complete: ${skipped}  |  Errors: ${errors}`);
  if (DRY_RUN) console.log('\nRe-run without --dry-run to apply changes.');
}

main().catch(e => { console.error(e); process.exit(1); });
