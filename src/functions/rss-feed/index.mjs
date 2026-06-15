import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient());

const SITE_URL   = 'https://oldforest.net';
const FEED_TITLE = 'Old Forest';
const FEED_DESC  = 'Stories and reflections from the digital forest.';
const MAX_ITEMS  = 20;

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export const handler = async () => {
  const result = await dynamo.send(new ScanCommand({
    TableName: process.env.POSTS_TABLE,
    FilterExpression: '#s = :published AND visibility = :public',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':published': 'published', ':public': 'public' },
    ProjectionExpression: 'postId, slug, title, summary, author, createdAt, updatedAt, tags',
  }));

  const posts = (result.Items ?? [])
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, MAX_ITEMS);

  const now = new Date().toUTCString();

  const items = posts.map(p => {
    const link     = `${SITE_URL}/post.html?slug=${encodeURIComponent(p.slug)}`;
    const pubDate  = p.createdAt ? new Date(p.createdAt).toUTCString() : now;
    const updated  = p.updatedAt ? new Date(p.updatedAt).toUTCString() : pubDate;
    const categories = (p.tags ?? []).map(t => `    <category>${esc(t)}</category>`).join('\n');
    return `  <item>
    <title>${esc(p.title)}</title>
    <link>${esc(link)}</link>
    <guid isPermaLink="true">${esc(link)}</guid>
    <pubDate>${pubDate}</pubDate>
    <lastBuildDate>${updated}</lastBuildDate>
    ${p.author ? `<author>${esc(p.author)}</author>` : ''}
    ${p.summary ? `<description>${esc(p.summary)}</description>` : ''}
${categories}
  </item>`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(FEED_TITLE)}</title>
    <link>${SITE_URL}</link>
    <description>${esc(FEED_DESC)}</description>
    <language>en-us</language>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link href="${SITE_URL}/v1/feed.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`;

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/rss+xml; charset=UTF-8',
      'Cache-Control': 'public, max-age=900',  // 15 min CDN cache
    },
    body: xml,
  };
};
