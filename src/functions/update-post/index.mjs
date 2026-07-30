import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
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
    const { postId } = event.pathParameters;
    const body = JSON.parse(event.body ?? '{}');
    if (!body.slug?.trim())  return fail(400, 'slug is required');
    if (!body.title?.trim()) return fail(400, 'title is required');

    const now = new Date().toISOString();
    const contentKey = `posts/${postId}/body.md`;

    // Verify the post exists before doing anything
    const existing = await dynamo.send(new GetCommand({
      TableName: process.env.POSTS_TABLE,
      Key: { postId },
    }));
    if (!existing.Item) {
      return fail(404, 'Not found');
    }

    // For personal posts, only the original author can edit
    if (existing.Item.visibility === 'personal' && existing.Item.authorSub !== claims.sub) {
      return fail(403, 'Not your personal post');
    }

    if (body.content !== undefined) {
      await s3.send(new PutObjectCommand({
        Bucket: process.env.CONTENT_BUCKET,
        Key: contentKey,
        Body: body.content,
        ContentType: 'text/markdown',
      }));
    }

    const updateExpr = [
      '#t = :title',
      'slug = :slug',
      'summary = :summary',
      'author = :author',
      'updatedAt = :now',
      '#s = :status',
      'visibility = :visibility',
      'tags = :tags',
      'thumbnail = :thumbnail',
      'authorSub = :authorSub',
    ];
    const exprValues = {
      ':title':     body.title.trim(),
      ':slug':      body.slug.trim(),
      ':summary':   body.summary ?? '',
      ':author':    body.author ?? '',
      ':now':       now,
      ':status':    body.status ?? 'draft',
      ':visibility': body.visibility ?? 'public',
      ':tags':      body.tags ?? [],
      ':thumbnail': body.thumbnail ?? '',
      ':authorSub': claims.sub,
    };

    // Allow overriding the original publish date (useful for imported posts)
    if (body.createdAt) {
      updateExpr.push('createdAt = :createdAt');
      exprValues[':createdAt'] = body.createdAt;
    }

    await dynamo.send(new UpdateCommand({
      TableName: process.env.POSTS_TABLE,
      Key: { postId },
      UpdateExpression: 'SET ' + updateExpr.join(', '),
      ExpressionAttributeNames: { '#t': 'title', '#s': 'status' },
      ExpressionAttributeValues: exprValues,
    }));

    return respond(200, { postId, updatedAt: now }, JSON_HEADERS);
  } catch (e) {
    console.error('update-post error:', e);
    return fail(500, 'Internal server error');
  }
};
