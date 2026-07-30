/**
 * Shared API Gateway Lambda-proxy response helpers.
 *
 * Deliberately low-level: callers keep their own thin ok()/err()/fail() wrappers
 * so each Lambda's external JSON envelope (key names like `message` vs `error`,
 * status-code defaults) stays exactly as it was — this only removes the repeated
 * `{ statusCode, headers, body: JSON.stringify(...) }` boilerplate and the
 * copy-pasted CORS header constant.
 */

export const CORS_HEADERS = { 'Access-Control-Allow-Origin': 'https://oldforest.net', 'Content-Type': 'application/json' };
export const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * Build an API Gateway Lambda-proxy response.
 * @param {number} status
 * @param {any} [body] - JSON-stringified if present; omit for an empty body (e.g. 204).
 * @param {object} [headers] - defaults to CORS_HEADERS.
 */
export function respond(status, body, headers = CORS_HEADERS) {
  return {
    statusCode: status,
    headers,
    body: body === undefined ? '' : JSON.stringify(body),
  };
}
