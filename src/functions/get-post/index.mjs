import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient());
const s3 = new S3Client();

export const handler = async (event) => {
  const { slug } = event.pathParameters;

  const result = await dynamo.send(new QueryCommand({
    TableName: process.env.POSTS_TABLE,
    IndexName: 'slug-index',
    KeyConditionExpression: 'slug = :slug',
    ExpressionAttributeValues: { ':slug': slug },
    Limit: 1,
  }));

  const post = result.Items?.[0];
  if (!post) return { statusCode: 404, body: JSON.stringify({ message: 'Not found' }) };

  // Enforce visibility
  if (post.visibility === 'members') {
    const claims = event.requestContext?.authorizer?.jwt?.claims;
    const groups = claims?.['cognito:groups'] ?? [];
    if (!groups.includes('members') && !groups.includes('editors')) {
      return { statusCode: 403, body: JSON.stringify({ message: 'Members only' }) };
    }
  }

  // Fetch Markdown body from S3
  const s3Obj = await s3.send(new GetObjectCommand({
    Bucket: process.env.CONTENT_BUCKET,
    Key: post.contentKey,
  }));
  post.content = await s3Obj.Body.transformToString();

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(post),
  };
};
