import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { respond } from './http.mjs';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient());

export const handler = async () => {
  try {
    const result = await dynamo.send(new ScanCommand({
      TableName: process.env.APPS_TABLE,
      FilterExpression: 'enabled = :true',
      ExpressionAttributeValues: { ':true': true },
    }));

    const apps = (result.Items || [])
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

    return respond(200, { apps });
  } catch (e) {
    console.error('list-apps error:', e);
    return respond(500, { message: 'Internal error' });
  }
};
