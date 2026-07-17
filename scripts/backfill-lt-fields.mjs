#!/usr/bin/env node
/**
 * backfill-lt-fields.mjs
 *
 * Matches books in the oldforest-books DynamoDB table against a LibraryThing
 * TSV export and fills in any missing pageCount and/or tags from the TSV.
 *
 * Rules:
 *   - Only updates books whose bookId starts with "lt-" (i.e. imported from LT).
 *   - pageCount: written only if the DynamoDB book has no pageCount.
 *   - tags:      written only if the DynamoDB book has no tags (or an empty list).
 *   - Existing values are never overwritten.
 *
 * Usage:
 *   AWS_PROFILE=oldforest node scripts/backfill-lt-fields.mjs \
 *       librarything_KeyMasterOfGozer_202606162043.tsv [--dry-run]
 */

import { readFileSync } from 'fs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const DRY_RUN     = process.argv.includes('--dry-run');
const TSV_FILE    = process.argv.find(a => a.endsWith('.tsv'));
const BOOKS_TABLE = process.env.BOOKS_TABLE ?? 'oldforest-books';
const REGION      = process.env.AWS_REGION  ?? 'us-east-1';

if (!TSV_FILE) {
  console.error('Usage: node scripts/backfill-lt-fields.mjs <file.tsv> [--dry-run]');
  process.exit(1);
}

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// ── TSV helpers ───────────────────────────────────────────────────────────────

function parseTsvLine(line) {
  return line.split('\t').map(f => {
    f = f.trim();
    if (f.startsWith('"') && f.endsWith('"')) {
      f = f.slice(1, -1).replace(/""/g, '"');
    }
    return f;
  });
}

/**
 * Parse the TSV and return a Map keyed by "lt-{BookId}" with the fields we care about.
 * TSV column indices (0-based):
 *   0  Book Id
 *   21 Page Count
 *   28 Tags
 */
function parseTsv(filePath) {
  const raw   = readFileSync(filePath, 'utf8');
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // Verify header columns
  const header = parseTsvLine(lines[0]);
  const checks = { 0: 'Book Id', 21: 'Page Count', 28: 'Tags' };
  for (const [idx, name] of Object.entries(checks)) {
    if (header[+idx] !== name) {
      console.warn(`⚠  Column ${+idx + 1} expected "${name}", got "${header[+idx]}" — check your TSV`);
    }
  }

  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields  = parseTsvLine(line);
    const ltId    = fields[0]?.trim();
    if (!ltId) continue;

    const bookId   = `lt-${ltId}`;
    const pageRaw  = fields[21]?.trim();
    const tagsRaw  = fields[28]?.trim();

    const pageCount = parseInt(pageRaw) || null;

    const tags = tagsRaw
      ? [...new Set(tagsRaw.split(/[,;|]/).map(t => t.trim().toLowerCase()).filter(Boolean))]
      : [];

    // Only store if at least one field has data
    if (pageCount || tags.length) {
      map.set(bookId, { pageCount, tags });
    }
  }

  return map;
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

async function updateBook(bookId, fields) {
  const sets    = ['updatedAt = :updatedAt'];
  const names   = {};
  const values  = { ':updatedAt': new Date().toISOString() };

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

  console.log(`Parsing TSV: ${TSV_FILE}…`);
  const tsvMap = parseTsv(TSV_FILE);
  console.log(`  TSV rows with pageCount or tags: ${tsvMap.size}\n`);

  console.log(`Scanning ${BOOKS_TABLE}…`);
  const allBooks = await scanAll();
  console.log(`  Total books in DB: ${allBooks.length}`);

  // Only LT-imported books can be matched
  const ltBooks = allBooks.filter(b => b.bookId?.startsWith('lt-'));
  console.log(`  Books with lt- prefix: ${ltBooks.length}\n`);

  let updated = 0, skipped = 0, noMatch = 0;

  for (const book of ltBooks) {
    const tsv = tsvMap.get(book.bookId);
    if (!tsv) { noMatch++; continue; }

    const patch = {};

    // pageCount: only if missing in DB and present in TSV
    if (!book.pageCount && tsv.pageCount) {
      patch.pageCount = tsv.pageCount;
    }

    // tags: only if missing/empty in DB and present in TSV
    const hasTags = Array.isArray(book.tags) && book.tags.length > 0;
    if (!hasTags && tsv.tags.length > 0) {
      patch.tags = tsv.tags;
    }

    if (!Object.keys(patch).length) { skipped++; continue; }

    const patchDesc = Object.entries(patch)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join('  ');
    console.log(`  ${book.bookId}  "${book.title}"`);
    console.log(`    → ${patchDesc}`);

    if (!DRY_RUN) await updateBook(book.bookId, patch);
    updated++;
  }

  console.log('\n──────────────────────────────────────────────');
  const verb = DRY_RUN ? 'Would update' : 'Updated';
  console.log(`${verb}:       ${updated}`);
  console.log(`Already complete: ${skipped}`);
  console.log(`No TSV match:     ${noMatch}`);
  if (DRY_RUN) console.log('\nRe-run without --dry-run to apply changes.');
}

main().catch(e => { console.error(e); process.exit(1); });
