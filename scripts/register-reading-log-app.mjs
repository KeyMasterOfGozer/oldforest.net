#!/usr/bin/env node
/**
 * register-reading-log-app.mjs
 *
 * Adds the Reading Log editor to the oldforest-apps DynamoDB table
 * so it appears on the Apps page for editors.
 *
 * Usage:
 *   AWS_PROFILE=<profile> node scripts/register-reading-log-app.mjs
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const REGION     = process.env.AWS_REGION ?? 'us-east-1';
const APPS_TABLE = process.env.APPS_TABLE ?? 'oldforest-apps';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const item = {
  appId:       'reading-log',
  name:        'Reading Log',
  description: 'Add and manage books and reading history. Powers the Book Timeline.',
  icon:        '📖',
  url:         '/apps/reading-log/',
  visibility:  'editors',
  external:    false,
  order:       20,
  createdAt:   new Date().toISOString(),
  updatedAt:   new Date().toISOString(),
};

await dynamo.send(new PutCommand({ TableName: APPS_TABLE, Item: item }));
console.log('Registered app:', item.name);
