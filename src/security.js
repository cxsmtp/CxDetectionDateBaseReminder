/**
 * HTTP hardening for every response, and a same-origin check for every
 * request that changes something.
 *
 * Headers: no framing (clickjacking), no MIME sniffing, a Content Security
 * Policy that allows only this server's own scripts (plus the hashed inline
 * theme snippet in index.html), no referrer to other sites, HSTS when served
 * over HTTPS, and no X-Powered-By.
 *
 * Cross-site request forgery: the session cookie is SameSite=Lax, and on top
 * of that a browser request that changes state (POST, PUT, PATCH, DELETE) to
 * /api must come from this server's own pages: its Origin (or, failing that,
 * Referer) must name this host. Requests without either (curl, scripts,
 * tests) carry no ambient browser credentials to abuse and pass. The report
 * relay (/api/relay) is called cross-origin from reports opened from disk on
 * purpose, and authorises every action with signed grants instead of cookies.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';

/** sha256 CSP sources for the inline <script> blocks of an HTML file. */
export function inlineScriptHashes(file) {
  let html = '';
  try {
    html = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
}

export function contentSecurityPolicy(scriptHashes = []) {
  return [
    "default-src 'self'",
    `script-src 'self'${scriptHashes.length ? ` ${scriptHashes.join(' ')}` : ''}`,
    // Inline style attributes are used for computed widths and colours; no inline script is.
    "style-src 'self' 'unsafe-inline'",
    // Logos may be https URLs or pasted data: images.
    "img-src 'self' data: blob: https:",
    // "Test" checks the reminder server address readers use, which may be another host.
    "connect-src 'self' https: http:",
    "font-src 'self' data:",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Whose X-Forwarded-For / -Proto / -Host to believe (TRUST_PROXY, as Express reads it:
 * "loopback", IPs or CIDRs, a hop count, on or off). By default only a proxy on this
 * machine: on a company network anyone else could send those headers and pass as any
 * address, so a proxy elsewhere (another container, another machine) is named in
 * TRUST_PROXY. Nobody when this server does HTTPS itself, because then it faces the
 * clients directly.
 */
export function trustProxySetting(value, servingHttps) {
  const text = String(value ?? '').trim();
  if (!text) return servingHttps ? false : 'loopback';
  if (/^(off|false|no|0|none)$/i.test(text)) return false;
  if (/^(on|true|yes|all)$/i.test(text)) return true;
  if (/^\d+$/.test(text)) return Number(text);
  return text;
}

/**
 * Keep a map of attempt times per address (oldest-touched first) under `max` entries:
 * first drop addresses whose attempts are all older than the window, then, if still too
 * many, the least recently seen. Never the whole map, which would hand a guesser a fresh
 * start just by sending from enough addresses.
 */
export function pruneAttempts(attempts, now = Date.now(), { windowMs, max }) {
  if (attempts.size <= max) return;
  for (const [key, times] of attempts) if (!times.some((t) => now - t < windowMs)) attempts.delete(key);
  for (const key of attempts.keys()) {
    if (attempts.size <= max) break;
    attempts.delete(key);
  }
}

/**
 * Whether this request came through a proxy this server trusts (TRUST_PROXY), so its
 * X-Forwarded-* headers can be believed. Anyone else could set them to anything.
 */
export function viaTrustedProxy(req) {
  const trust = req.app?.get?.('trust proxy fn');
  return Boolean(trust && trust(req.socket?.remoteAddress ?? '', 0));
}

// req.secure already counts X-Forwarded-Proto, but only from a trusted proxy.
const isHttps = (req) => Boolean(req.secure);

/**
 * `hsts`: true (a year, with subdomains), false, or a function giving the header value per
 * response ('' for none): the HTTPS settings decide, and never with a self-signed certificate,
 * where pinning browsers to HTTPS would only lock them out if the server goes back to http.
 */
export function securityHeaders({ scriptHashes = [], hsts = true } = {}) {
  const csp = contentSecurityPolicy(scriptHashes);
  return (req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'same-origin');
    res.set('Cross-Origin-Opener-Policy', 'same-origin');
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.set('Content-Security-Policy', csp);
    const value = typeof hsts === 'function' ? hsts() : hsts ? 'max-age=31536000; includeSubDomains' : '';
    if (value && isHttps(req)) res.set('Strict-Transport-Security', value);
    next();
  };
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The host[:port] of an Origin / Referer value, lower-cased; '' when it has none. */
function hostOf(value) {
  try {
    return new URL(String(value)).host.toLowerCase();
  } catch {
    return '';
  }
}

/** The hosts this request may legitimately come from: this server's Host, and a trusted proxy's forwarded host. */
function ownHosts(req) {
  const hosts = new Set();
  const add = (value) => {
    for (const part of String(value ?? '').split(',')) {
      const host = part.trim().toLowerCase();
      if (host) hosts.add(host);
    }
  };
  add(req.headers.host);
  if (viaTrustedProxy(req)) add(req.headers['x-forwarded-host']);
  return hosts;
}

/**
 * Refuse a state-changing /api request a browser sent from another site.
 * `exempt` lists path prefixes (under /api) authorised without cookies.
 */
export function sameOriginGuard({ exempt = ['/relay'] } = {}) {
  return (req, res, next) => {
    if (!UNSAFE.has(req.method) || exempt.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))) return next();
    const origin = req.headers.origin;
    const source = origin && origin !== 'null' ? origin : origin === 'null' ? 'null' : req.headers.referer;
    if (!source) return next();
    if (source !== 'null' && ownHosts(req).has(hostOf(source))) return next();
    return res.status(403).json({ error: 'This request came from another site, so it was refused. Use this server’s own pages.' });
  };
}
