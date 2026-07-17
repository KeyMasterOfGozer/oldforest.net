#!/usr/bin/env node
/**
 * migrate-ol-ids.mjs
 *
 * One-time migration: copies any OpenLibrary Work ID stored in the
 * googleBooksId field (values starting with "OL") into the new
 * openLibraryId field, then removes it from googleBooksId.
 *
 * Usage:
 *   AWS_PROFILE=oldforest node scripts/migrate-ol-ids.mjs --dry-run
 *   AWS_PROFILE=oldforest node scripts/migrate-ol-ids.mjs
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const DRY_RUN     = process.argv.includes('--dry-run');
const BOOKS_TABLE = process.env.BOOKS_TABLE ?? 'oldforest-books';
const REGION      = process.env.AWS_REGION  ?? 'us-east-1';

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

  // Books where googleBooksId holds an OL key (starts with "OL")
  const toMigrate = allBooks.filter(b =>
    typeof b.googleBooksId === 'string' && b.googleBooksId.startsWith('OL')
  );

  // Books that already have openLibraryId (shouldn't overwrite)
  const alreadyMigrated = toMigrate.filter(b => b.openLibraryId);
  const needsMigration  = toMigrate.filter(b => !b.openLibraryId);

  console.log(`  Books with OL key in googleBooksId:  ${toMigrate.length}`);
  console.log(`  Already have openLibraryId (skip):   ${alreadyMigrated.length}`);
  console.log(`  Need migration:                      ${needsMigration.length}\n`);

  if (alreadyMigrated.length) {
    console.log('Skipping (already have openLibraryId):');
    for (const b of alreadyMigrated) {
      console.log(`  "${b.title}" — openLibraryId=${b.openLibraryId}, googleBooksId=${b.googleBooksId}`);
    }
    console.log();
  }

  if (!needsMigration.length) {
    console.log('Nothing to migrate.');
    return;
  }

  console.log('Migrating:');
  let updated = 0;
  for (const book of needsMigration) {
    console.log(`  "${book.title}"`);
    console.log(`    googleBooksId: ${book.googleBooksId}  →  openLibraryId: ${book.googleBooksId}`);
    console.log(`    googleBooksId will be cleared`);

    if (!DRY_RUN) {
      await dynamo.send(new UpdateCommand({
        TableName: BOOKS_TABLE,
        Key: { bookId: book.bookId },
        // Set openLibraryId, remove googleBooksId, touch updatedAt
        UpdateExpression: 'SET openLibraryId = :olid, updatedAt = :ts REMOVE googleBooksId',
        ExpressionAttributeValues: {
          ':olid': book.googleBooksId,
          ':ts':   new Date().toISOString(),
        },
      }));
    }
    updated++;
  }

  console.log(`\n${DRY_RUN ? 'Would update' : 'Updated'}: ${updated} book(s).`);
  if (DRY_RUN) console.log('Re-run without --dry-run to apply changes.');
}

main().catch(e => { console.error(e); process.exit(1); });
