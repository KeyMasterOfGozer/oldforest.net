import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';

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

  const body = JSON.parse(event.body ?? '{}');
  const filename = body.filename ?? 'upload.bin';
  const parts = filename.split('.');
  const ext  = parts.pop().toLowerCase();
  const base = parts.join('.') || 'file';

  // Allowed extensions
  const allowed = ['jpg','jpeg','png','gif','webp','svg','pdf','txt','md'];
  if (!allowed.includes(ext)) {
    return { statusCode: 400, body: JSON.stringify({ message: `File type .${ext} not allowed` }) };
  }

  // Sanitize original filename for use in the S3 key
  const safeName = base
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9.\-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^[-.]|[-.]$/g, '')
    .slice(0, 80) || 'file';

  // Date-based prefix: images/YYYY/MM/{uuid}-{original-name}.ext
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm   = String(now.getUTCMonth() + 1).padStart(2, '0');
  const key  = `images/${yyyy}/${mm}/${randomUUID()}-${safeName}.${ext}`;
  const contentType = body.contentType || 'application/octet-stream';

  const url = await getSignedUrl(s3, new PutObjectCommand({
    Bucket: process.env.CONTENT_BUCKET,
    Key: key,
    ContentType: contentType,
  }), { expiresIn: 300 });

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadUrl: url, key }),
  };
};
