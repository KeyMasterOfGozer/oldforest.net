#!/usr/bin/env node
/**
 * purge-lt-migration.mjs
 *
 * Removes all books (and their reads) that were imported by the original
 * migrate-lt-to-dynamo.mjs run but are NOT present in a given TSV export.
 *
 * Books added via the editor UI (no "lt-" prefix) are never touched.
 *
 * Usage:
 *   AWS_PROFILE=oldforest node scripts/purge-lt-migration.mjs NewBooks.tsv [--dry-run]
 */

import { readFileSync } from 'fs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  DeleteCommand,
  QueryCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';

const DRY_RUN     = process.argv.includes('--dry-run');
const TSV_FILE    = process.argv.find(a => a.endsWith('.tsv')) ?? 'NewBooks.tsv';
const BOOKS_TABLE = process.env.BOOKS_TABLE ?? 'oldforest-books';
const READS_TABLE = process.env.READS_TABLE ?? 'oldforest-reads';
const REGION      = process.env.AWS_REGION  ?? 'us-east-1';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// ── Read TSV to get the set of valid lt- book IDs ─────────────────────────────
function tsvBookIds(tsvPath) {
  const lines = readFileSync(tsvPath, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const ids = new Set();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const ltId = line.split('\t')[0].trim().replace(/^"|"$/g, '');
    if (ltId) ids.add(`lt-${ltId}`);
  }
  return ids;
}

// ── Scan all books ────────────────────────────────────────────────────────────
async function scanBooks() {
  const items = [];
  let lastKey;
  do {
    const result = await dynamo.send(new ScanCommand({
      TableName: BOOKS_TABLE,
      ProjectionExpression: 'bookId',
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(result.Items ?? []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

// ── Get all read IDs for a book ───────────────────────────────────────────────
async function getReadIds(bookId) {
  const result = await dynamo.send(new QueryCommand({
    TableName: READS_TABLE,
    IndexName: 'byBook',
    KeyConditionExpression: 'bookId = :bid',
    ExpressionAttributeValues: { ':bid': bookId },
    ProjectionExpression: 'readId',
  }));
  return (result.Items ?? []).map(r => r.readId);
}

// ── Batch delete reads ────────────────────────────────────────────────────────
async function deleteReads(readIds) {
  for (let i = 0; i < readIds.length; i += 25) {
    const chunk = readIds.slice(i, i + 25);
    if (!DRY_RUN) {
      await dynamo.send(new BatchWriteCommand({
        RequestItems: {
          [READS_TABLE]: chunk.map(readId => ({ DeleteRequest: { Key: { readId } } })),
        },
      }));
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (DRY_RUN) console.log('DRY RUN — no deletes will occur.\n');

  const keepIds = tsvBookIds(TSV_FILE);
  console.log(`Books to keep from ${TSV_FILE}: ${keepIds.size}`);

  const allBooks = await scanBooks();
  console.log(`Total books in DynamoDB: ${allBooks.length}`);

  // Only touch lt- prefixed books not in the TSV
  const toDelete = allBooks
    .map(b => b.bookId)
    .filter(id => id.startsWith('lt-') && !keepIds.has(id));

  console.log(`Books to delete (old lt-proxy migration, not in TSV): ${toDelete.length}`);
  if (!toDelete.length) {
    console.log('\nNothing to delete.');
    return;
  }

  // Preview first 10
  console.log('\nSample book IDs to delete:');
  toDelete.slice(0, 10).forEach(id => console.log(' ', id));
  if (toDelete.length > 10) console.log(`  ... and ${toDelete.length - 10} more`);

  // Count reads that will be removed
  let totalReads = 0;
  const allReadIds = [];
  for (const bookId of toDelete) {
    const readIds = await getReadIds(bookId);
    allReadIds.push(...readIds);
    totalReads += readIds.length;
  }
  console.log(`\nAssociated reads to delete: ${totalReads}`);

  if (DRY_RUN) {
    console.log('\nDry run complete. Re-run without --dry-run to delete.');
    return;
  }

  // Delete reads first, then books
  console.log('\nDeleting reads…');
  await deleteReads(allReadIds);

  console.log('Deleting books…');
  let deleted = 0;
  for (const bookId of toDelete) {
    await dynamo.send(new DeleteCommand({ TableName: BOOKS_TABLE, Key: { bookId } }));
    deleted++;
    process.stdout.write(`\r  ${deleted}/${toDelete.length}`);
  }

  console.log(`\n\n✓ Done. Removed ${toDelete.length} books and ${totalReads} reads.`);
}

main().catch(e => { console.error(e); process.exit(1); });
