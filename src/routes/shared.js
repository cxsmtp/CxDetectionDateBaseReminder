/**
 * Small helpers the server and its route modules (src/routes/) share. Nothing of the server's state is in them
 * (no store, no settings, no session), so a module imports what it needs from here; everything that does
 * depend on the running server is handed to a module by src/server.js when it calls it.
 */

/** One line of untrusted text for the server log: no line breaks or control characters (log forging). */
export const logSafe = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').slice(0, 500);

/** At most `max` distinct ids from a request field that should be an array of ids. */
export const idList = (value, max = 5000) => (Array.isArray(value) ? [...new Set(value.map(String))].slice(0, max) : []);

export const escapeHtml = (text) => String(text ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export const escapeHtmlText = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The client's address: X-Forwarded-For only from a trusted proxy (see TRUST_PROXY), so it cannot be faked.
export const clientIp = (req) => req.ip || req.socket?.remoteAddress || '';

/** Who an audit entry names when the server acted by itself. */
export const SYSTEM_ACTOR = { kind: 'system', user: 'CxMissionZero server' };
