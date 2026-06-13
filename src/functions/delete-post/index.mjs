import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';

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

  const { postId } = event.pathParameters;

  const existing = await dynamo.send(new GetCommand({
    TableName: process.env.POSTS_TABLE,
    Key: { postId },
  }));

  if (!existing.Item) return { statusCode: 404, body: JSON.stringify({ message: 'Not found' }) };

  await s3.send(new DeleteObjectCommand({
    Bucket: process.env.CONTENT_BUCKET,
    Key: existing.Item.contentKey,
  }));

  await dynamo.send(new DeleteCommand({
    TableName: process.env.POSTS_TABLE,
    Key: { postId },
  }));

  return { statusCode: 204, body: '' };
};
