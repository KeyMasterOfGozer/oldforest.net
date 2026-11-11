import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { requireAdmin } from './auth.mjs';
import { respond } from './http.mjs';

const s3 = new S3Client();
const BUCKET = process.env.CONTENT_BUCKET;

// The three areas of the content bucket the admin UI manages. posts/ is
// deliberately absent — those objects are post bodies owned by the editor flow,
// not user-managed uploads, and deleting one would silently gut a live post.
const AREAS = [
  { prefix: 'images/', access: 'public', kind: 'image' },
  { prefix: 'files/', access: 'public', kind: 'file' },
  { prefix: 'private/', access: 'private', kind: 'file' },
];

const MAX_KEYS_PER_AREA = 1000;

// Strips the UUID that upload-url prepends to non-stable keys, so the UI shows
// the name the editor actually uploaded.
const UUID_PREFIX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/;

function ok(body) {
  return respond(200, body);
}
function err(status, message) {
  return respond(status, { message });
}

function describe(object, area) {
  const basename = object.Key.split('/').pop();
  const filename = basename.replace(UUID_PREFIX, '') || basename;
  return {
    key: object.Key,
    size: object.Size,
    lastModified: object.LastModified,
    filename,
    ext: (basename.split('.').pop() || '').toLowerCase(),
    access: area.access,
    kind: area.kind,
    // Public objects are served straight off CloudFront; gated ones must go
    // through download.html, which swaps the key for a presigned URL.
    url: area.access === 'public'
      ? `${process.env.SITE_BASE_URL}/${object.Key}`
      : `${process.env.SITE_BASE_URL}/download.html?key=${encodeURIComponent(object.Key)}`,
  };
}

export const handler = async (event) => {
  try { requireAdmin(event); }
  catch (e) { return err(e.statusCode ?? 403, e.message ?? 'Forbidden'); }

  const method = event.requestContext?.http?.method;

  try {
    // ── GET /v1/admin/files ────────────────────
    if (method === 'GET') {
      const listings = await Promise.all(AREAS.map(async (area) => {
        const result = await s3.send(new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: area.prefix,
          MaxKeys: MAX_KEYS_PER_AREA,
        }));
        return (result.Contents || [])
          // Skip the zero-byte marker objects that represent a folder itself.
          .filter(object => !object.Key.endsWith('/'))
          .map(object => describe(object, area));
      }));

      return ok({ files: listings.flat() });
    }

    // ── DELETE /v1/admin/files?key=… ───────────
    if (method === 'DELETE') {
      const key = event.queryStringParameters?.key || '';
      const allowed = AREAS.some(area => key.startsWith(area.prefix));
      if (!key || !allowed || key.includes('..')) {
        return err(400, 'Invalid or missing key parameter');
      }
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
      return respond(204);
    }

    return err(405, 'Method not allowed');
  } catch (e) {
    console.error('admin-files error:', e);
    return err(500, 'Internal server error');
  }
};
