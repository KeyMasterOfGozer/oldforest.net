/**
 * GET /v1/proxy/librarything
 *
 * Server-side proxy for the LibraryThing JSON Books API.
 * Solves mixed-content / CORS issues: the browser calls this Lambda
 * over HTTPS same-origin, and this Lambda calls LibraryThing server-side.
 *
 * LibraryThing returns a JavaScript variable assignment:
 *   widgetResults = { books: { ... }, ... };
 * We strip that wrapper and return clean JSON.
 */

const LT_BASE = 'https://www.librarything.com/api/json_books.php';

function ltUrl() {
  const p = new URLSearchParams({
    key:        process.env.LT_API_KEY,
    libraries:  '',
    resultsets: 'books,bookdates,booktags',
    limit:      'bookswithstartorfinishdates',
    max:        '2000',
    userid:     process.env.LT_USER_ID,
  });
  return `${LT_BASE}?${p}`;
}

export const handler = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(ltUrl(), { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      return {
        statusCode: 502,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'LibraryThing API error', status: res.status }),
      };
    }

    const text = await res.text();

    // Strip JS variable assignment wrapper: `widgetResults = {...};`
    const match = text.trim().match(/^[a-zA-Z_$][\w$]*\s*=\s*([\s\S]+?);?\s*$/);
    const jsonStr = match ? match[1] : text.trim();
    const data = JSON.parse(jsonStr);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600',  // cache 1 hour at CDN
      },
      body: JSON.stringify(data),
    };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === 'AbortError';
    return {
      statusCode: isTimeout ? 504 : 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: isTimeout ? 'LibraryThing API timeout' : err.message }),
    };
  }
};
