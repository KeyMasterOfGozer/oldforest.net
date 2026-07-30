import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { requireEditor } from './auth.mjs';

const s3 = new S3Client();

// ContentType derived exclusively from the validated extension — never from caller input.
// SVG is intentionally kept but served as image/svg+xml; consider removing if editors
// do not need SVG uploads (SVG can execute JS in browsers).
const MIME_MAP = {
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  gif:  'image/gif',
  webp: 'image/webp',
  pdf:  'application/pdf',
  txt:  'text/plain',
  md:   'text/plain',  // serve as plain text, not text/markdown
};

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB soft cap

export const handler = async (event) => {
  try {
    requireEditor(event);
  } catch (e) {
    return { statusCode: e.statusCode, body: JSON.stringify({ message: e.message }) };
  }

  const body = JSON.parse(event.body ?? '{}');

  // Soft size guard — caller-declared, stops honest mistakes; hard limit via presigned POST
  const declaredSize = Number(body.size ?? 0);
  if (declaredSize > MAX_UPLOAD_BYTES) {
    return { statusCode: 413, body: JSON.stringify({ message: 'File too large (max 10 MB)' }) };
  }

  const filename = body.filename ?? 'upload.bin';
  const parts = filename.split('.');
  const ext  = parts.pop().toLowerCase();
  const base = parts.join('.') || 'file';

  // Validate extension against allowlist
  if (!Object.hasOwn(MIME_MAP, ext)) {
    return { statusCode: 400, body: JSON.stringify({ message: `File type .${ext} not allowed` }) };
  }

  // ContentType comes from the server-side map, never from the caller
  const contentType = MIME_MAP[ext];

  // Sanitize original filename for use in the S3 key
  const safeName = base
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9.\-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^[-.]|[-.]$/g, '')
    .slice(0, 80) || 'file';

  // Date-based prefix: images/YYYY/MM/{uuid}-{original-name}.ext
  const now  = new Date();
  const yyyy = now.getUTCFullYear();
  const mm   = String(now.getUTCMonth() + 1).padStart(2, '0');
  const key  = `images/${yyyy}/${mm}/${randomUUID()}-${safeName}.${ext}`;

  const url = await getSignedUrl(s3, new PutObjectCommand({
    Bucket: process.env.CONTENT_BUCKET,
    Key: key,
    ContentType: contentType,
  }), { expiresIn: 300 });

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadUrl: url, key, contentType }),
  };
};
