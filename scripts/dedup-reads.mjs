#!/usr/bin/env node
/**
 * dedup-reads.mjs
 *
 * Finds duplicate reads in oldforest-reads and deletes the extras.
 * Two reads are considered duplicates if they share the same bookId + started
 * date, regardless of whether both have a finished date — the read with more
 * fields populated (especially one that has a finished date) is kept.
 *
 * Usage:
 *   AWS_PROFILE=oldforest node scripts/dedup-reads.mjs --dry-run
 *   AWS_PROFILE=oldforest node scripts/dedup-reads.mjs
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

const DRY_RUN     = process.argv.includes('--dry-run');
const READS_TABLE = process.env.READS_TABLE ?? 'oldforest-reads';
const REGION      = process.env.AWS_REGION  ?? 'us-east-1';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// ── Scan all reads ────────────────────────────────────────────────────────────
async function scanAll() {
  const items = [];
  let lastKey;
  do {
    const result = await dynamo.send(new ScanCommand({
      TableName: READS_TABLE,
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(result.Items ?? []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

// Score a read by how many useful fields are populated (higher = keep this one)
function score(read) {
  let s = 0;
  if (read.started)  s++;
  if (read.finished) s++;
  if (read.rating)   s++;
  if (read.format)   s++;
  if (read.review)   s += 2;   // review is high-value
  if (read.notes)    s++;
  // Prefer lt- prefixed IDs (migrated from LT) over random UUIDs for stability
  if (read.readId?.startsWith('lt-')) s += 0.5;
  return s;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (DRY_RUN) console.log('DRY RUN — no deletes will occur.\n');

  console.log(`Scanning ${READS_TABLE}…`);
  const all = await scanAll();
  console.log(`  Total reads: ${all.length}`);

  // Group by bookId|started — same book + same start date = same read event,
  // even if one entry is missing the finished date.
  const groups = new Map();
  for (const read of all) {
    const key = `${read.bookId ?? ''}|${read.started ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(read);
  }

  const dupeGroups = [...groups.values()].filter(g => g.length > 1);
  console.log(`  Duplicate groups: ${dupeGroups.length}`);

  if (dupeGroups.length === 0) {
    console.log('\nNo duplicates found. Nothing to do.');
    return;
  }

  const toDelete = [];
  for (const group of dupeGroups) {
    // Sort descending by score; keep the first (best)
    group.sort((a, b) => score(b) - score(a));
    const keep = group[0];
    const drop = group.slice(1);

    console.log(`\nGroup key: bookId=${keep.bookId} started=${keep.started ?? '—'} finished=${keep.finished ?? '—'}`);
    console.log(`  KEEP  readId=${keep.readId} (score=${score(keep)})`);
    for (const d of drop) {
      console.log(`  DROP  readId=${d.readId} (score=${score(d)})`);
      toDelete.push(d.readId);
    }
  }

  console.log(`\nReads to delete: ${toDelete.length}`);

  if (DRY_RUN) {
    console.log('\nDry run complete. Re-run without --dry-run to delete.');
    return;
  }

  let deleted = 0;
  for (const readId of toDelete) {
    await dynamo.send(new DeleteCommand({ TableName: READS_TABLE, Key: { readId } }));
    deleted++;
    process.stdout.write(`\r  Deleted ${deleted}/${toDelete.length}`);
  }
  console.log(`\n\nDone. Removed ${deleted} duplicate read(s). ${all.length - deleted} reads remain.`);
}

main().catch(e => { console.error(e); process.exit(1); });
