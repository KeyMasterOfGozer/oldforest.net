import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
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
    const { postId } = event.pathParameters;

    const existing = await dynamo.send(new GetCommand({
      TableName: process.env.POSTS_TABLE,
      Key: { postId },
    }));

    if (!existing.Item) return fail(404, 'Not found');

    await s3.send(new DeleteObjectCommand({
      Bucket: process.env.CONTENT_BUCKET,
      Key: existing.Item.contentKey,
    }));

    await dynamo.send(new DeleteCommand({
      TableName: process.env.POSTS_TABLE,
      Key: { postId },
    }));

    return respond(204, undefined, JSON_HEADERS);
  } catch (e) {
    console.error('delete-post error:', e);
    return fail(500, 'Internal server error');
  }
};
