import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

const s3 = new S3Client();
const BUCKET = process.env.CONTENT_BUCKET;

const CORS = {
  'Access-Control-Allow-Origin': 'https://oldforest.net',
  'Content-Type': 'application/json',
};

function requireAdmin(event) {
  const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
  const raw    = claims['cognito:groups'] ?? '';
  const groups = Array.isArray(raw)
    ? raw
    : raw.split(',').map(g => g.trim()).filter(Boolean);
  if (!groups.includes('admins')) {
    const e = new Error('Admin access required');
    e.statusCode = 403;
    throw e;
  }
}

function ok(body) {
  return { statusCode: 200, headers: CORS, body: JSON.stringify(body) };
}
function err(status, message) {
  return { statusCode: status, headers: CORS, body: JSON.stringify({ message }) };
}

export const handler = async (event) => {
  try { requireAdmin(event); }
  catch (e) { return err(e.statusCode || 403, e.message); }

  const method = event.requestContext?.http?.method;

  try {
    // ── GET /v1/admin/files ────────────────────
    if (method === 'GET') {
      const result = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: 'images/',
        MaxKeys: 1000,
      }));

      const files = (result.Contents || [])
        .filter(obj => obj.Key !== 'images/')
        .map(obj => {
          const basename = obj.Key.split('/').pop();
          // Strip UUID prefix from new-format keys: {uuid}-{original-name}.ext
          const displayName = basename.replace(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/, ''
          ) || basename;
          return {
            key: obj.Key,
            size: obj.Size,
            lastModified: obj.LastModified,
            filename: displayName,
            ext: (basename.split('.').pop() || '').toLowerCase(),
          };
        });

      return ok({ files });
    }

    // ── DELETE /v1/admin/files?key=images/... ──
    if (method === 'DELETE') {
      const key = event.queryStringParameters?.key || '';
      if (!key || !key.startsWith('images/')) {
        return err(400, 'Invalid or missing key parameter');
      }
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
      return { statusCode: 204, headers: CORS, body: '' };
    }

    return err(405, 'Method not allowed');
  } catch (e) {
    console.error('admin-files error:', e);
    return err(500, 'Internal server error');
  }
};
