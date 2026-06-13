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
  const ext = (body.filename ?? 'image.jpg').split('.').pop();
  const key = `images/${randomUUID()}.${ext}`;

  const url = await getSignedUrl(s3, new PutObjectCommand({
    Bucket: process.env.CONTENT_BUCKET,
    Key: key,
    ContentType: body.contentType ?? 'image/jpeg',
  }), { expiresIn: 300 });

  return {
    statusCode: 200,
    body: JSON.stringify({ uploadUrl: url, key }),
  };
};
