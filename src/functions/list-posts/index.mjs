import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const client = DynamoDBDocumentClient.from(new DynamoDBClient());

/** Scan repeatedly until DynamoDB stops returning a LastEvaluatedKey — a single
 * Scan truncates at ~1MB and silently omits whatever didn't fit on that page. */
async function scanAll(params) {
  const items = [];
  let lastKey;
  do {
    const result = await client.send(new ScanCommand({ ...params, ExclusiveStartKey: lastKey }));
    items.push(...(result.Items ?? []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

export const handler = async (event) => {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const groups = claims?.['cognito:groups'] ?? [];
  const isEditor = groups.includes('editors');
  const isEditorPath = event.rawPath?.startsWith('/v1/editor');
  const currentSub = claims?.sub;

  // Editor list: all posts, but personal posts only from the current user
  if (isEditorPath) {
    if (!isEditor) {
      return { statusCode: 403, body: JSON.stringify({ message: 'Editors only' }) };
    }
    const items = await scanAll({
      TableName: process.env.POSTS_TABLE,
      FilterExpression: 'visibility <> :personal OR authorSub = :sub',
      ExpressionAttributeValues: {
        ':personal': 'personal',
        ':sub': currentSub,
      },
      ProjectionExpression: 'postId, slug, title, summary, author, authorSub, createdAt, updatedAt, #s, visibility, tags, thumbnail',
      ExpressionAttributeNames: { '#s': 'status' },
    });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ posts: items }),
    };
  }

  // Public list: published posts only, never personal; optional ?tag= filter
  const tag = event.queryStringParameters?.tag;
  const filterParts = ['#s = :published', 'visibility <> :personal'];
  const exprNames  = { '#s': 'status' };
  const exprValues = { ':published': 'published', ':personal': 'personal' };

  if (tag) {
    filterParts.push('contains(tags, :tag)');
    exprValues[':tag'] = tag;
  }

  const items = await scanAll({
    TableName: process.env.POSTS_TABLE,
    FilterExpression: filterParts.join(' AND '),
    ExpressionAttributeNames: exprNames,
    ExpressionAttributeValues: exprValues,
    ProjectionExpression: 'postId, slug, title, summary, author, createdAt, tags, visibility, thumbnail',
  });

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ posts: items }),
  };
};
