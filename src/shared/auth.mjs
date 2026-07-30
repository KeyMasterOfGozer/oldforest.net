/**
 * Shared auth utilities for Lambda functions.
 *
 * API Gateway HTTP API JWT authorizer passes Cognito array claims (cognito:groups)
 * as a space-separated string, e.g. "editors members". Some older SDK versions may
 * use comma-separated. parseGroups handles all known formats plus raw JS arrays.
 */

/**
 * Parse the cognito:groups claim into an array of group name strings.
 * @param {string|string[]|undefined} raw - Value from JWT claims
 * @returns {string[]}
 */
export function parseGroups(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(g => String(g).trim()).filter(Boolean);
  // API Gateway serializes Cognito group arrays as "[group1 group2]" (bracket-wrapped,
  // space-separated, no quotes). Strip brackets before splitting.
  // Also handles plain space/comma-separated strings and JSON arrays as fallbacks.
  const s = String(raw).trim().replace(/^\[/, '').replace(/\]$/, '');
  return s.split(/[\s,]+/).filter(Boolean);
}

/**
 * Extract and parse groups from a Lambda event (API Gateway HTTP API v2 payload).
 * @param {object} event
 * @returns {string[]}
 */
export function getGroups(event) {
  const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
  return parseGroups(claims['cognito:groups']);
}

/**
 * Throws {statusCode, message} if the caller is not in the editors or admins group.
 * @param {object} event
 */
export function requireEditor(event) {
  const groups = getGroups(event);
  if (!groups.includes('editors') && !groups.includes('admins')) {
    throw { statusCode: 403, message: 'Editors only' };
  }
}

/**
 * Throws {statusCode, message} if the caller is not in the admins group.
 * @param {object} event
 */
export function requireAdmin(event) {
  const groups = getGroups(event);
  if (!groups.includes('admins')) {
    throw { statusCode: 403, message: 'Admins only' };
  }
}
