import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const client = DynamoDBDocumentClient.from(new DynamoDBClient());

export const handler = async (event) => {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const groups = claims?.['cognito:groups'] ?? [];
  const isEditor = groups.includes('editors');
  const isEditorPath = event.rawPath?.startsWith('/v1/editor');

  // Editor list: return all posts (all statuses + visibility)
  if (isEditorPath) {
    if (!isEditor) {
      return { statusCode: 403, body: JSON.stringify({ message: 'Editors only' }) };
    }
    const result = await client.send(new ScanCommand({
      TableName: process.env.POSTS_TABLE,
      ProjectionExpression: 'postId, slug, title, summary, author, createdAt, updatedAt, #s, visibility, tags',
      ExpressionAttributeNames: { '#s': 'status' },
    }));
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ posts: result.Items }),
    };
  }

  // Public list: all published posts (both public and members-only).
  // Content is gated at the post level — showing the title/summary is fine.
  const result = await client.send(new ScanCommand({
    TableName: process.env.POSTS_TABLE,
    FilterExpression: '#s = :published',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':published': 'published' },
    ProjectionExpression: 'postId, slug, title, summary, author, createdAt, tags, visibility',
  }));

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ posts: result.Items }),
  };
};
