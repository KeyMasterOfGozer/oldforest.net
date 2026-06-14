import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient());
const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

export const handler = async () => {
  try {
    const result = await dynamo.send(new ScanCommand({
      TableName: process.env.APPS_TABLE,
      FilterExpression: 'enabled = :true',
      ExpressionAttributeValues: { ':true': true },
    }));

    const apps = (result.Items || [])
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ apps }),
    };
  } catch (e) {
    console.error('list-apps error:', e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ message: 'Internal error' }) };
  }
};
