import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { requireEditor } from './auth.mjs';
import { respond, JSON_HEADERS } from './http.mjs';

const s3 = new S3Client();

// ContentType is derived exclusively from the validated extension — never from
// caller input. Anything absent from this map is rejected outright, which is
// what keeps .html/.svg (script-capable when served inline) off the site.
const MIME_MAP = {
  // images
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  gif:  'image/gif',
  webp: 'image/webp',
  // documents
  pdf:  'application/pdf',
  txt:  'text/plain',
  md:   'text/plain',  // serve as plain text, not text/markdown
  csv:  'text/csv',
  // archives, ebooks and data
  zip:  'application/zip',
  gz:   'application/gzip',
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/vnd.amazon.ebook',
  json: 'application/json',
};

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

// Soft, caller-declared guards. The presigned PUT itself is not size-limited —
// these stop honest mistakes rather than a determined editor.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;   //  10 MB
const MAX_FILE_BYTES = 100 * 1024 * 1024;   // 100 MB

// images/ and files/ are readable through CloudFront; private/ deliberately is
// not, and is reachable only via a presigned URL from the download-url function.
const PREFIX = {
  image:   'images',
  public:  'files',
  private: 'private',
};

function fail(status, message) {
  return respond(status, { message }, JSON_HEADERS);
}

/** Lowercase, punctuation-stripped filename stem safe for an S3 key. */
function sanitizeStem(raw) {
  return raw
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9.\-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^[-.]|[-.]$/g, '')
    .slice(0, 80) || 'file';
}

export const handler = async (event) => {
  try {
    requireEditor(event);
  } catch (e) {
    return fail(e.statusCode ?? 403, e.message ?? 'Forbidden');
  }

  try {
    const body = JSON.parse(event.body ?? '{}');

    // Defaults keep the original image-upload contract working untouched:
    // the post editor still posts only {filename, size}.
    const kind = body.kind === 'file' ? 'file' : 'image';
    const access = body.access === 'private' ? 'private' : 'public';
    const stable = body.stable === true;

    const filename = body.filename ?? 'upload.bin';
    const parts = filename.split('.');
    const ext = (parts.pop() || '').toLowerCase();
    const base = parts.join('.') || 'file';

    if (!Object.hasOwn(MIME_MAP, ext)) {
      return fail(400, `File type .${ext} not allowed`);
    }
    if (kind === 'image' && !IMAGE_EXTENSIONS.has(ext)) {
      return fail(400, `.${ext} is not an image`);
    }

    const limit = kind === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    const declaredSize = Number(body.size ?? 0);
    if (declaredSize > limit) {
      return fail(413, `File too large (max ${Math.round(limit / 1024 / 1024)} MB)`);
    }

    const contentType = MIME_MAP[ext];
    const safeName = sanitizeStem(base);

    const prefix = kind === 'image' ? PREFIX.image : PREFIX[access];

    // A stable key overwrites in place, so a published URL keeps pointing at the
    // newest build (used for release artifacts like the Calibre plugin). Anything
    // else gets a date folder plus a UUID so uploads can never collide.
    let key;
    if (stable && kind === 'file') {
      key = `${prefix}/${safeName}.${ext}`;
    } else {
      const now = new Date();
      const yyyy = now.getUTCFullYear();
      const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
      key = `${prefix}/${yyyy}/${mm}/${randomUUID()}-${safeName}.${ext}`;
    }

    const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({
      Bucket: process.env.CONTENT_BUCKET,
      Key: key,
      ContentType: contentType,
    }), { expiresIn: 300 });

    // publicUrl is null for private/ — those are only reachable through
    // download.html, which swaps the key for a short-lived presigned GET.
    const publicUrl = prefix === PREFIX.private
      ? null
      : `${process.env.SITE_BASE_URL}/${key}`;

    return respond(200, {
      uploadUrl,
      key,
      contentType,
      access: prefix === PREFIX.private ? 'private' : 'public',
      publicUrl,
      downloadPath: prefix === PREFIX.private
        ? `/download.html?key=${encodeURIComponent(key)}`
        : `/${key}`,
    }, JSON_HEADERS);
  } catch (e) {
    console.error('upload-url error:', e);
    return fail(500, 'Internal server error');
  }
};
