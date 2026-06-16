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
    userid:     process.env.LT_USER_ID,
    resultsets: 'books,bookdates,booktags',
    limit:      'bookswithstartorfinishdates',
    max:        '2000',
  });
  return `${LT_BASE}?${p}`;
}

/**
 * Walk `str` starting at `startIdx` (which must be a `{`) and return the
 * substring from `{` to its matching `}`, respecting nested objects and
 * quoted strings.  Returns null if no balanced match is found.
 */
function extractObject(str, startIdx) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIdx; i < str.length; i++) {
    const c = str[i];
    if (escape)   { escape = false; continue; }
    if (inString) {
      if (c === '\\') { escape = true; continue; }
      if (c === '"')    inString = false;
      continue;
    }
    if (c === '"')  { inString = true;  continue; }
    if (c === '{')    depth++;
    else if (c === '}') {
      if (--depth === 0) return str.slice(startIdx, i + 1);
    }
  }
  return null;
}

export const handler = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const url = ltUrl();
    console.log('Fetching LT URL:', url);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Some endpoints block non-browser user-agents
        'User-Agent': 'Mozilla/5.0 (compatible; oldforest-lt-proxy/1.0)',
        'Accept':     'text/javascript, application/json, */*',
      },
    });
    clearTimeout(timer);

    console.log('LT HTTP status:', res.status);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('LT API error body:', body.slice(0, 200));
      return {
        statusCode: 502,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'LibraryThing API error', status: res.status }),
      };
    }

    const text = await res.text();
    console.log('LT response length:', text.length);
    console.log('LT response start:', text.slice(0, 120));

    // LT returns a JS bootstrap file that looks like:
    //   /* comment */
    //   if (!LibraryThing) { var LibraryThing = {}; }
    //   LibraryThing.widgetResults = {};   ← namespace init, empty object, SKIP
    //   widgetResults = {"books": {...}};  ← actual data, this is what we want
    //
    // Strategy: find `widgetResults = {"` (not preceded by `.`, with a quoted key)
    // using a negative lookbehind to skip LibraryThing.widgetResults.
    let data;
    const dataMatch = text.match(/(?<![.\w])widgetResults\s*=\s*(\{")/);
    if (dataMatch) {
      // Position of the opening `{`
      const bracePos = dataMatch.index + dataMatch[0].lastIndexOf('{');
      // Walk braces to find the exact matching `}` (ignores `}` inside strings)
      const jsonPart = extractObject(text, bracePos);
      if (!jsonPart) throw new Error('Could not find matching } for widgetResults object');
      console.log('Data JSON start:', jsonPart.slice(0, 80));
      try {
        data = JSON.parse(jsonPart);
      } catch (parseErr) {
        console.error('Parse failed. Preview:', jsonPart.slice(0, 300));
        throw new Error(`JSON parse failed: ${parseErr.message}`);
      }
    } else {
      // Fallback: try treating the whole response as plain JSON
      console.warn('widgetResults not found; trying raw JSON. Preview:', text.slice(0, 150));
      try {
        data = JSON.parse(text.trim());
      } catch (parseErr) {
        throw new Error(`No widgetResults and raw JSON failed. Starts: ${text.slice(0, 100)}`);
      }
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type':  'application/json',
        'Cache-Control': 'public, max-age=3600',
      },
      body: JSON.stringify(data),
    };

  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === 'AbortError';
    console.error('lt-proxy error:', err.message);
    return {
      statusCode: isTimeout ? 504 : 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: isTimeout ? 'LibraryThing API timeout' : err.message,
      }),
    };
  }
};
