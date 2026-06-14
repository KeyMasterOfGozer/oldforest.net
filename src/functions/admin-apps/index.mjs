import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand, UpdateCommand, DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient());
const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

function requireAdmin(event) {
  const groups = event.requestContext?.authorizer?.jwt?.claims?.['cognito:groups'] ?? '';
  if (!String(groups).includes('admins')) {
    const err = new Error('Admin access required');
    err.statusCode = 403;
    throw err;
  }
}

function ok(body)            { return { statusCode: 200, headers: CORS, body: JSON.stringify(body) }; }
function created(body)       { return { statusCode: 201, headers: CORS, body: JSON.stringify(body) }; }
function noContent()         { return { statusCode: 204, headers: CORS, body: '' }; }
function fail(status, msg)   { return { statusCode: status, headers: CORS, body: JSON.stringify({ message: msg }) }; }

export const handler = async (event) => {
  try { requireAdmin(event); }
  catch (e) { return fail(e.statusCode || 403, e.message); }

  const method  = event.requestContext?.http?.method;
  const appId   = event.pathParameters?.appId;

  try {
    // ── GET /v1/admin/apps ────────────────────────
    if (method === 'GET') {
      const result = await dynamo.send(new ScanCommand({ TableName: process.env.APPS_TABLE }));
      const apps = (result.Items || []).sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
      return ok({ apps });
    }

    // ── POST /v1/admin/apps ───────────────────────
    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      if (!body.name?.trim()) return fail(400, 'name is required');
      if (!body.url?.trim())  return fail(400, 'url is required');

      const item = {
        appId:       randomUUID(),
        name:        body.name.trim(),
        description: body.description?.trim() ?? '',
        icon:        body.icon?.trim() || '🧩',
        url:         body.url.trim(),
        external:    body.external === true,
        visibility:  body.visibility || 'public',
        order:       Number(body.order) || 99,
        enabled:     body.enabled !== false,
      };
      await dynamo.send(new PutCommand({ TableName: process.env.APPS_TABLE, Item: item }));
      return created(item);
    }

    // ── PUT /v1/admin/apps/{appId} ────────────────
    if (method === 'PUT') {
      if (!appId) return fail(400, 'appId required');
      const body = JSON.parse(event.body ?? '{}');
      if (!body.name?.trim()) return fail(400, 'name is required');
      if (!body.url?.trim())  return fail(400, 'url is required');

      const existing = await dynamo.send(new GetCommand({
        TableName: process.env.APPS_TABLE, Key: { appId },
      }));
      if (!existing.Item) return fail(404, 'App not found');

      await dynamo.send(new UpdateCommand({
        TableName: process.env.APPS_TABLE,
        Key: { appId },
        UpdateExpression: 'SET #n = :name, description = :desc, icon = :icon, #u = :url, #ext = :ext, visibility = :vis, #ord = :order, enabled = :enabled',
        ExpressionAttributeNames: { '#n': 'name', '#u': 'url', '#ext': 'external', '#ord': 'order' },
        ExpressionAttributeValues: {
          ':name':    body.name.trim(),
          ':desc':    body.description?.trim() ?? '',
          ':icon':    body.icon?.trim() || '🧩',
          ':url':     body.url.trim(),
          ':ext':     body.external === true,
          ':vis':     body.visibility || 'public',
          ':order':   Number(body.order) || 99,
          ':enabled': body.enabled !== false,
        },
      }));
      return ok({ appId });
    }

    // ── DELETE /v1/admin/apps/{appId} ─────────────
    if (method === 'DELETE') {
      if (!appId) return fail(400, 'appId required');
      await dynamo.send(new DeleteCommand({ TableName: process.env.APPS_TABLE, Key: { appId } }));
      return noContent();
    }

    return fail(405, 'Method not allowed');
  } catch (e) {
    console.error('admin-apps error:', e);
    return fail(500, e.message || 'Internal server error');
  }
};
