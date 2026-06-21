#!/usr/bin/env node
/**
 * clean-book-tags.mjs
 *
 * Removes invalid tags ("0", "1") from all books in oldforest-books.
 *
 * Usage:
 *   AWS_PROFILE=oldforest node scripts/clean-book-tags.mjs --dry-run
 *   AWS_PROFILE=oldforest node scripts/clean-book-tags.mjs
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const DRY_RUN     = process.argv.includes('--dry-run');
const BOOKS_TABLE = process.env.BOOKS_TABLE ?? 'oldforest-books';
const REGION      = process.env.AWS_REGION  ?? 'us-east-1';

const INVALID_TAGS = new Set(['0', '1']);

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

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

async function main() {
  if (DRY_RUN) console.log('DRY RUN — no changes will be written.\n');

  console.log(`Scanning ${BOOKS_TABLE}…`);
  const allBooks = await scanAll();
  console.log(`  Total books: ${allBooks.length}\n`);

  const toFix = allBooks.filter(b =>
    (b.tags ?? []).some(t => INVALID_TAGS.has(t))
  );

  console.log(`  Books with invalid tags: ${toFix.length}`);
  if (!toFix.length) {
    console.log('\nNo invalid tags found.');
    return;
  }

  let updated = 0;
  for (const book of toFix) {
    const before = book.tags ?? [];
    const after  = before.filter(t => !INVALID_TAGS.has(t));
    console.log(`  "${book.title}": [${before.join(', ')}] → [${after.join(', ')}]`);

    if (!DRY_RUN) {
      await dynamo.send(new UpdateCommand({
        TableName: BOOKS_TABLE,
        Key: { bookId: book.bookId },
        UpdateExpression: 'SET #tags = :tags, updatedAt = :ts',
        ExpressionAttributeNames: { '#tags': 'tags' },
        ExpressionAttributeValues: { ':tags': after, ':ts': new Date().toISOString() },
      }));
      updated++;
    } else {
      updated++;
    }
  }

  console.log(`\n${DRY_RUN ? 'Would update' : 'Updated'}: ${updated} book(s).`);
  if (DRY_RUN) console.log('Re-run without --dry-run to apply changes.');
}

main().catch(e => { console.error(e); process.exit(1); });
