import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { contentSecurityPolicy, inlineScriptHashes, sameOriginGuard, securityHeaders } from '../src/security.js';
import { parseAddressList, parseOverrides } from '../src/settings.js';

function run(middleware, req) {
  const headers = {};
  let status = 200;
  let passed = false;
  const res = { set: (k, v) => (headers[k] = v), status: (s) => ((status = s), res), json: () => res };
  middleware({ method: 'GET', path: '/', headers: {}, ...req }, res, () => (passed = true));
  return { headers, status, passed };
}

test('every response forbids framing and sniffing, and allows only this server\'s scripts', () => {
  const { headers, passed } = run(securityHeaders({ scriptHashes: ["'sha256-abc'"] }), {});
  assert.ok(passed);
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(headers['Content-Security-Policy'], /script-src 'self' 'sha256-abc'(;|$)/);
  assert.doesNotMatch(headers['Content-Security-Policy'], /script-src[^;]*unsafe-inline/);
  assert.match(headers['Content-Security-Policy'], /object-src 'none'/);
  assert.equal(headers['Strict-Transport-Security'], undefined, 'HSTS only over HTTPS');
  assert.ok(run(securityHeaders(), { headers: { 'x-forwarded-proto': 'https' } }).headers['Strict-Transport-Security']);
});

test('the inline theme script in index.html is allowed by its hash, and nothing else inline', () => {
  const html = fs.readFileSync('public/index.html', 'utf8');
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  assert.equal(inline.length, 1);
  assert.deepEqual(inlineScriptHashes('public/index.html'), [`'sha256-${createHash('sha256').update(inline[0]).digest('base64')}'`]);
  assert.doesNotMatch(html, /\son(click|load|change|submit|error|input)=/i, 'no inline event handlers');
  assert.match(contentSecurityPolicy(inlineScriptHashes('public/index.html')), /sha256-/);
});

test('a state-changing request from another site is refused; this site, scripts and the report relay pass', () => {
  const guard = sameOriginGuard({ exempt: ['/relay'] });
  const post = (headers, path = '/settings') => run(guard, { method: 'POST', path, headers: { host: 'mz.acme.io', ...headers } });
  assert.equal(post({ origin: 'https://evil.example' }).status, 403);
  assert.equal(post({ origin: 'null' }).status, 403, 'a sandboxed or file page');
  assert.equal(post({ referer: 'https://evil.example/page' }).status, 403);
  assert.ok(post({ origin: 'https://mz.acme.io' }).passed);
  assert.ok(post({ origin: 'https://proxy.acme.io', 'x-forwarded-host': 'proxy.acme.io' }).passed, 'behind a reverse proxy');
  assert.ok(post({}).passed, 'no browser: nothing ambient to abuse');
  assert.ok(post({ origin: 'null' }, '/relay/triage').passed, 'reports opened from disk call the relay');
  assert.ok(run(guard, { method: 'GET', path: '/settings', headers: { host: 'mz.acme.io', origin: 'https://evil.example' } }).passed, 'reads are not state changes');
});

test('initiator overrides never accept keys that reach an object\'s prototype', () => {
  const parsed = parseOverrides('__proto__ = a@acme.io\nconstructor = b@acme.io\nsudha = sudha@acme.io');
  assert.deepEqual(Object.keys(parsed), ['sudha']);
  assert.deepEqual(Object.keys(parseOverrides({ ['__proto__']: 'a@acme.io', prototype: 'b@acme.io', sean: 'sean@acme.io' })), ['sean']);
  assert.equal({}.polluted, undefined);
});

test('email checks stay fast on hostile input (no catastrophic backtracking)', () => {
  const hostile = `a@${'.'.repeat(100_000)}@`;
  const started = Date.now();
  assert.deepEqual(parseAddressList([hostile, `${'a'.repeat(300)}@acme.io`, 'ok@acme.io']), ['ok@acme.io'], 'over 254 characters is not an address');
  assert.ok(Date.now() - started < 200, `took ${Date.now() - started} ms`);
});
