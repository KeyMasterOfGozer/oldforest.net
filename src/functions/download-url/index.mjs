/**
 * GET /v1/files/download?key=private/...
 *
 * Hands a signed-in user a short-lived presigned GET URL for a gated file.
 *
 * Gated downloads cannot be a plain <a href>: the browser will not attach an
 * Authorization header to a normal navigation, and the site's tokens live in
 * sessionStorage rather than cookies, so neither CloudFront nor S3 can see
 * them. download.html therefore reads the token in JS, calls this endpoint, and
 * forwards the browser to the URL it returns.
 *
 * The route sits behind the API Gateway JWT authorizer, so reaching this code
 * already means a valid token — no group is required beyond being signed in.
 */

import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { respond, JSON_HEADERS } from './http.mjs';

const s3 = new S3Client();

// Only this prefix may ever be presigned. Without the check, any signed-in user
// could mint a URL for posts/<id>/body.md and read unpublished or personal post
// content straight out of the bucket.
const ALLOWED_PREFIX = 'private/';

// Long enough to survive the redirect and a slow connection starting, short
// enough that a leaked URL is near-worthless.
const URL_TTL_SECONDS = 120;

function fail(status, message) {
  return respond(status, { message }, JSON_HEADERS);
}

export const handler = async (event) => {
  try {
    const key = event.queryStringParameters?.key || '';

    if (!key) {
      return fail(400, 'Missing key parameter');
    }
    // Reject traversal before the prefix test, so a key like
    // "private/../posts/x" cannot slip through.
    if (key.includes('..')) {
      return fail(400, 'Invalid key');
    }
    if (!key.startsWith(ALLOWED_PREFIX)) {
      return fail(403, 'That file is not available for gated download');
    }

    // Presigning succeeds for a key that does not exist, which would hand the
    // caller a URL that 404s only after the redirect. Check first so the error
    // surfaces on the page the user is actually looking at.
    try {
      await s3.send(new HeadObjectCommand({
        Bucket: process.env.CONTENT_BUCKET,
        Key: key,
      }));
    } catch (e) {
      if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) {
        return fail(404, 'File not found');
      }
      throw e;
    }

    const url = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: process.env.CONTENT_BUCKET,
      Key: key,
      // Browsers save the file under its own name rather than the UUID-prefixed
      // S3 key, and never render it inline.
      ResponseContentDisposition:
        `attachment; filename="${key.split('/').pop().replace(/"/g, '')}"`,
    }), { expiresIn: URL_TTL_SECONDS });

    return respond(200, {
      url,
      key,
      filename: key.split('/').pop(),
      expiresIn: URL_TTL_SECONDS,
    }, JSON_HEADERS);
  } catch (e) {
    console.error('download-url error:', e);
    return fail(500, 'Internal server error');
  }
};
