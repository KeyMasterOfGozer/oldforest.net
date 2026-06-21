#!/usr/bin/env node
/**
 * enrich-books.mjs
 *
 * Scans the oldforest-books DynamoDB table, finds books with missing data
 * (pageCount, googleBooksId, coverUrl, isbn), queries the Google Books API
 * to fill in the blanks, and updates the table.
 *
 * Setup:
 *   1. Get a free Google Books API key:
 *      - Go to https://console.cloud.google.com/
 *      - Create or select a project
 *      - Go to APIs & Services → Library → search "Books API" → Enable it
 *      - Go to APIs & Services → Credentials → Create Credentials → API Key
 *      - (Optional) Restrict the key to the Books API only
 *
 * Usage:
 *   GOOGLE_BOOKS_API_KEY=your_key AWS_PROFILE=oldforest node scripts/enrich-books.mjs --dry-run
 *   GOOGLE_BOOKS_API_KEY=your_key AWS_PROFILE=oldforest node scripts/enrich-books.mjs
 *
 * Options:
 *   --dry-run    Print proposed updates without writing to DynamoDB (default-safe)
 *   --all        Re-check every book, even those that already have all four fields
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const DRY_RUN     = process.argv.includes('--dry-run');
const CHECK_ALL   = process.argv.includes('--all');
const BOOKS_TABLE = process.env.BOOKS_TABLE ?? 'oldforest-books';
const REGION      = process.env.AWS_REGION  ?? 'us-east-1';
const GB_KEY      = process.env.GOOGLE_BOOKS_API_KEY;

if (!GB_KEY) {
  console.error('Error: GOOGLE_BOOKS_API_KEY environment variable is not set.');
  console.error('See the script header for setup instructions.');
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

// ── Google Books API ──────────────────────────────────────────────────────────

// Pause between API calls to stay well within the default 1 req/s rate limit
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function searchGoogleBooks(title, author) {
  const q = [
    title  ? `intitle:${encodeURIComponent(title)}`  : '',
    author ? `inauthor:${encodeURIComponent(author)}` : '',
  ].filter(Boolean).join('+');

  const url = `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=5&key=${GB_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google Books API error ${res.status}: ${body}`);
  }
  const data = await res.json();
  return data.items ?? [];
}

/**
 * Pick the best matching volume from Google Books results.
 * Scores by: title similarity + author similarity + presence of wanted fields.
 */
function pickBestMatch(items, book) {
  const norm = s => (s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const titleWords  = new Set(norm(book.title).split(' ').filter(Boolean));
  const authorWords = new Set(norm(book.author).split(' ').filter(Boolean));

  let best = null;
  let bestScore = -1;

  for (const item of items) {
    const info = item.volumeInfo ?? {};
    const gbTitle  = norm(info.title);
    const gbAuthor = norm((info.authors ?? []).join(' '));

    // Title overlap (0-1)
    const gbTitleWords = new Set(gbTitle.split(' ').filter(Boolean));
    const titleOverlap = [...titleWords].filter(w => gbTitleWords.has(w)).length / Math.max(titleWords.size, 1);

    // Author overlap (0-1)
    const gbAuthorWords = new Set(gbAuthor.split(' ').filter(Boolean));
    const authorOverlap = [...authorWords].filter(w => gbAuthorWords.has(w)).length / Math.max(authorWords.size, 1);

    // Bonus for having useful data
    const hasPages  = info.pageCount ? 0.1 : 0;
    const hasCover  = info.imageLinks?.thumbnail ? 0.1 : 0;
    const hasIsbn   = (info.industryIdentifiers ?? []).some(x => x.type === 'ISBN_13') ? 0.1 : 0;

    const score = titleOverlap * 0.5 + authorOverlap * 0.4 + hasPages + hasCover + hasIsbn;

    if (score > bestScore) {
      bestScore = score;
      best = { item, score };
    }
  }

  // Require at least a 50% title match to avoid false positives
  if (!best || best.score < 0.25) return null;
  return best.item;
}

function extractFields(item, existing) {
  const info    = item.volumeInfo ?? {};
  const updates = {};

  if (!existing.googleBooksId && item.id) {
    updates.googleBooksId = item.id;
  }
  if (!existing.pageCount && info.pageCount) {
    updates.pageCount = info.pageCount;
  }
  if (!existing.coverUrl && info.imageLinks?.thumbnail) {
    // Upgrade to a larger image and force HTTPS
    updates.coverUrl = info.imageLinks.thumbnail
      .replace('http://', 'https://')
      .replace('zoom=1', 'zoom=2');
  }
  if (!existing.isbn) {
    const isbn13 = (info.industryIdentifiers ?? []).find(x => x.type === 'ISBN_13');
    const isbn10 = (info.industryIdentifiers ?? []).find(x => x.type === 'ISBN_10');
    const isbn = isbn13 ?? isbn10;
    if (isbn) updates.isbn = isbn.identifier;
  }

  return updates;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (DRY_RUN) console.log('DRY RUN — no changes will be written.\n');

  console.log(`Scanning ${BOOKS_TABLE}…`);
  const allBooks = await scanAll();
  console.log(`  Total books: ${allBooks.length}\n`);

  // Filter to only books missing at least one field (unless --all)
  const needsEnrich = CHECK_ALL
    ? allBooks
    : allBooks.filter(b => !b.pageCount || !b.googleBooksId || !b.coverUrl || !b.isbn);

  console.log(`  Books needing enrichment: ${needsEnrich.length}`);
  if (!needsEnrich.length) {
    console.log('\nAll books already have complete metadata. Use --all to re-check anyway.');
    return;
  }

  let updated = 0;
  let skipped = 0;
  let noMatch = 0;
  let errors  = 0;

  for (let i = 0; i < needsEnrich.length; i++) {
    const book = needsEnrich[i];
    const missing = [
      !book.googleBooksId && 'googleBooksId',
      !book.pageCount     && 'pageCount',
      !book.coverUrl      && 'coverUrl',
      !book.isbn          && 'isbn',
    ].filter(Boolean);

    process.stdout.write(`[${i + 1}/${needsEnrich.length}] "${book.title}" by ${book.author} — missing: ${missing.join(', ')} … `);

    let items;
    try {
      let lastError;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await sleep(attempt === 1 ? 250 : 10_000); // 250ms normally, 10s on retry
          items = await searchGoogleBooks(book.title, book.author);
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
          if (attempt < 3) process.stdout.write(`(error, retrying ${attempt}/2) `);
        }
      }
      if (lastError) throw lastError;

      if (!items?.length) {
        console.log('no results');
        noMatch++;
        continue;
      }

      const match = pickBestMatch(items, book);
      if (!match) {
        console.log('no confident match');
        noMatch++;
        continue;
      }

      const updates = extractFields(match, book);
      if (!Object.keys(updates).length) {
        console.log('nothing new to add');
        skipped++;
        continue;
      }

      const gbInfo = match.volumeInfo ?? {};
      console.log(`matched "${gbInfo.title}" (id: ${match.id})`);
      for (const [k, v] of Object.entries(updates)) {
        console.log(`    ${k}: ${v}`);
      }

      if (!DRY_RUN) {
        await updateBook(book.bookId, updates);
        updated++;
      } else {
        updated++; // count as "would update" in dry run
      }
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      errors++;
    }
  }

  console.log(`\n──────────────────────────────────────`);
  if (DRY_RUN) {
    console.log(`Would update: ${updated}  |  No match: ${noMatch}  |  Already complete: ${skipped}  |  Errors: ${errors}`);
    console.log('\nRe-run without --dry-run to apply changes.');
  } else {
    console.log(`Updated: ${updated}  |  No match: ${noMatch}  |  Already complete: ${skipped}  |  Errors: ${errors}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
