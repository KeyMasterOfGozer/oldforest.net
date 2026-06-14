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
  const ext = filename.split('.').pop().toLowerCase();

  // Allowed extensions
  const allowed = ['jpg','jpeg','png','gif','webp','svg','pdf','txt','md'];
  if (!allowed.includes(ext)) {
    return { statusCode: 400, body: JSON.stringify({ message: `File type .${ext} not allowed` }) };
  }

  const key = `images/${randomUUID()}.${ext}`;
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
