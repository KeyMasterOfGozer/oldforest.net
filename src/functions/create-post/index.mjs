import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient());
const s3 = new S3Client();

function requireEditor(event) {
  const groups = event.requestContext?.authorizer?.jwt?.claims?.['cognito:groups'] ?? [];
  if (!groups.includes('editors')) throw { statusCode: 403, message: 'Editors only' };
}

export const handler = async (event) => {
  try {
    requireEditor(event);
  } catch (e) {
    return { statusCode: e.statusCode, body: JSON.stringify({ message: e.message }) };
  }

  const claims = event.requestContext.authorizer.jwt.claims;
  const body = JSON.parse(event.body ?? '{}');
  const postId = randomUUID();
  const now = new Date().toISOString();
  const contentKey = `posts/${postId}/body.md`;

  await s3.send(new PutObjectCommand({
    Bucket: process.env.CONTENT_BUCKET,
    Key: contentKey,
    Body: body.content ?? '',
    ContentType: 'text/markdown',
  }));

  const item = {
    postId,
    slug: body.slug,
    title: body.title,
    summary: body.summary ?? '',
    author: body.author ?? '',
    authorSub: claims.sub,          // Cognito user ID — used to gate personal posts
    createdAt: now,
    updatedAt: now,
    status: body.status ?? 'draft',
    visibility: body.visibility ?? 'public',
    tags: body.tags ?? [],
    thumbnail: body.thumbnail ?? '',
    contentKey,
  };

  await dynamo.send(new PutCommand({ TableName: process.env.POSTS_TABLE, Item: item }));

  return {
    statusCode: 201,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  };
};
