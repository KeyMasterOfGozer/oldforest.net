import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

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
  const { postId } = event.pathParameters;
  const body = JSON.parse(event.body ?? '{}');
  const now = new Date().toISOString();
  const contentKey = `posts/${postId}/body.md`;

  // For personal posts, only the original author can edit
  const existing = await dynamo.send(new GetCommand({
    TableName: process.env.POSTS_TABLE,
    Key: { postId },
  }));
  if (existing.Item?.visibility === 'personal' && existing.Item?.authorSub !== claims.sub) {
    return { statusCode: 403, body: JSON.stringify({ message: 'Not your personal post' }) };
  }

  if (body.content !== undefined) {
    await s3.send(new PutObjectCommand({
      Bucket: process.env.CONTENT_BUCKET,
      Key: contentKey,
      Body: body.content,
      ContentType: 'text/markdown',
    }));
  }

  await dynamo.send(new UpdateCommand({
    TableName: process.env.POSTS_TABLE,
    Key: { postId },
    UpdateExpression: 'SET #t = :title, slug = :slug, summary = :summary, author = :author, updatedAt = :now, #s = :status, visibility = :visibility, tags = :tags',
    ExpressionAttributeNames: { '#t': 'title', '#s': 'status' },
    ExpressionAttributeValues: {
      ':title': body.title,
      ':slug': body.slug,
      ':summary': body.summary ?? '',
      ':author': body.author ?? '',
      ':now': now,
      ':status': body.status ?? 'draft',
      ':visibility': body.visibility ?? 'public',
      ':tags': body.tags ?? [],
    },
  }));

  return { statusCode: 200, body: JSON.stringify({ postId, updatedAt: now }) };
};
