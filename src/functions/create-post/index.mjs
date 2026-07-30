import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { requireEditor } from './auth.mjs';
import { respond, JSON_HEADERS } from './http.mjs';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient());
const s3 = new S3Client();

function fail(status, message) { return respond(status, { message }, JSON_HEADERS); }

export const handler = async (event) => {
  try {
    requireEditor(event);
  } catch (e) {
    return fail(e.statusCode ?? 403, e.message ?? 'Forbidden');
  }

  try {
    const claims = event.requestContext.authorizer.jwt.claims;
    const body = JSON.parse(event.body ?? '{}');
    if (!body.slug?.trim())  return fail(400, 'slug is required');
    if (!body.title?.trim()) return fail(400, 'title is required');

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
      slug: body.slug.trim(),
      title: body.title.trim(),
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

    return respond(201, item, JSON_HEADERS);
  } catch (e) {
    console.error('create-post error:', e);
    return fail(500, 'Internal server error');
  }
};
