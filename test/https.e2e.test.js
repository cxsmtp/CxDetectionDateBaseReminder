// HTTPS served by Mission Zero itself: a self-signed certificate made with no
// extra tools, or the company's own (PEM or .pfx). Plain http redirects to it,
// cookies are Secure, HSTS is on, and forwarded headers from just anyone are ignored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';
import { ensureSelfSigned, selfSignedCertificate, tlsConfig, watchCertificate } from '../src/tls.js';

const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test.after(() => {
  for (const child of children) child.kill();
});

function start(env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'https-'));
  let log = '';
  const child = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, HOST: '127.0.0.1', DATA_DIR: dataDir, BACKUP_INTERVAL_HOURS: '0', REPORT_SIGNING_KEY: 'https-test', SMTP_HOST: '', GITHUB_TOKEN: '', CX_API_KEY: '', ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: 'temporary password 1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  children.push(child);
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, dataDir, exited, log: () => log };
}
async function until(check, ms = 15000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(100);
  }
}
/** One request; resolves {status, headers, body}. */
function request(url, { method = 'GET', headers = {}, body, ca } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, { method, headers, ca, rejectUnauthorized: Boolean(ca), servername: 'localhost' }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('a self-signed certificate is made with node alone, and covers the names asked for', () => {
  const { cert, key } = selfSignedCertificate(['localhost', '127.0.0.1', 'mz.acme.io', '::1']);
  const x509 = new X509Certificate(cert);
  assert.ok(x509.verify(x509.publicKey), 'signed by its own key');
  assert.equal(x509.ca, false);
  assert.equal(x509.subjectAltName, 'DNS:localhost, IP Address:127.0.0.1, DNS:mz.acme.io, IP Address:0:0:0:0:0:0:0:1');
  assert.ok(Date.parse(x509.validTo) - Date.now() > 390 * 86_400_000);
  assert.match(key, /BEGIN PRIVATE KEY/);
  // Kept, not remade, while it still covers the names and is not about to expire.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-'));
  const first = ensureSelfSigned(dir, ['localhost', '::1']);
  const pem = fs.readFileSync(first.cert, 'utf8');
  ensureSelfSigned(dir, ['localhost', '::1']);
  assert.equal(fs.readFileSync(first.cert, 'utf8'), pem);
  ensureSelfSigned(dir, ['localhost', 'other.acme.io']);
  assert.notEqual(fs.readFileSync(first.cert, 'utf8'), pem, 'a new name: made again');
  assert.equal(fs.statSync(first.key).mode & 0o777, 0o600, 'the key is private');
});

test('over self-signed HTTPS: health, HSTS, Secure cookie, http redirects, faked forwarded headers ignored', async () => {
  const port = await freePort();
  const redirect = await freePort();
  const server = start({ PORT: String(port), TLS_SELF_SIGNED: '1', TLS_HOSTNAMES: 'mz.acme.io', HTTP_REDIRECT_PORT: String(redirect), HTTPS_PUBLIC_PORT: String(port) });
  await until(() => /First administrator created/.test(server.log()) || /running on https/.test(server.log()));
  await sleep(500);
  assert.match(server.log(), /running on https:\/\//);
  const ca = fs.readFileSync(path.join(server.dataDir, 'tls', 'self-signed.crt'));
  const base = `https://127.0.0.1:${port}`;

  const health = await request(`${base}/api/health`, { ca });
  assert.equal(health.status, 200, 'the certificate verifies for this address');
  assert.match(health.headers['strict-transport-security'], /max-age=31536000/);

  const signIn = await request(`${base}/api/session/password`, { method: 'POST', ca, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@acme.io', password: 'temporary password 1' }) });
  assert.ok(signIn.status < 300, `signed in (${signIn.status})`);
  assert.match(String(signIn.headers['set-cookie']), /;\s*HttpOnly;.*Secure/);

  const moved = await request(`http://127.0.0.1:${redirect}/dashboard?tab=credits`);
  assert.equal(moved.status, 308);
  assert.equal(moved.headers.location, `https://127.0.0.1:${port}/dashboard?tab=credits`);

  // Serving HTTPS itself, the server faces clients directly: X-Forwarded-For from them is not believed,
  // so it cannot be used to dodge the sign-in limit (30 per address in 10 minutes).
  const codes = [];
  for (let i = 0; i < 32; i++) {
    const r = await request(`${base}/api/session/password`, { method: 'POST', ca, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `203.0.113.${i}` }, body: JSON.stringify({ email: 'nobody@acme.io', password: 'wrong' }) });
    codes.push(r.status);
  }
  assert.equal(codes.at(-1), 429, codes.join(','));
});

test('the company\'s own certificate (PEM), checked at start: a key that does not match stops it with a reason', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-own-'));
  const own = selfSignedCertificate(['localhost', '127.0.0.1']);
  const other = selfSignedCertificate(['localhost']);
  fs.writeFileSync(path.join(dir, 'server.crt'), own.cert);
  fs.writeFileSync(path.join(dir, 'server.key'), own.key);
  fs.writeFileSync(path.join(dir, 'other.key'), other.key);

  const port = await freePort();
  const good = start({ PORT: String(port), TLS_CERT_FILE: path.join(dir, 'server.crt'), TLS_KEY_FILE: path.join(dir, 'server.key') });
  await until(() => /\[https\] Certificate: CN=localhost/.test(good.log()));
  assert.equal((await request(`https://127.0.0.1:${port}/api/health`, { ca: own.cert })).status, 200);

  const bad = start({ PORT: String(await freePort()), TLS_CERT_FILE: path.join(dir, 'server.crt'), TLS_KEY_FILE: path.join(dir, 'other.key') });
  assert.equal(await bad.exited, 1);
  assert.match(bad.log(), /HTTPS is not set up correctly: The private key does not belong to the certificate/);

  const half = start({ PORT: String(await freePort()), TLS_CERT_FILE: path.join(dir, 'server.crt') });
  assert.equal(await half.exited, 1);
  assert.match(half.log(), /needs both TLS_CERT_FILE and TLS_KEY_FILE/);
});

test('a renewed certificate is picked up without a restart; a broken one is refused and the old one kept', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-renew-'));
  const first = selfSignedCertificate(['localhost']);
  fs.writeFileSync(path.join(dir, 'c.crt'), first.cert);
  fs.writeFileSync(path.join(dir, 'c.key'), first.key);
  const tls = tlsConfig({ TLS_CERT_FILE: path.join(dir, 'c.crt'), TLS_KEY_FILE: path.join(dir, 'c.key') });
  const applied = [];
  const logs = [];
  const fakeServer = { setSecureContext: (options) => applied.push(String(options.cert)) };
  const stop = watchCertificate(fakeServer, tls, { intervalMs: 50, log: { log: (m) => logs.push(m), warn: (m) => logs.push(m) } });
  try {
    await sleep(120);
    assert.equal(applied.length, 0, 'unchanged: nothing reloaded');
    const renewed = selfSignedCertificate(['localhost', 'renewed.acme.io']);
    fs.writeFileSync(path.join(dir, 'c.key'), renewed.key);
    fs.writeFileSync(path.join(dir, 'c.crt'), renewed.cert);
    await until(() => applied.length === 1, 3000);
    assert.equal(applied[0], renewed.cert);
    fs.writeFileSync(path.join(dir, 'c.crt'), 'not a certificate');
    await until(() => logs.some((m) => /could not be used/.test(m)), 3000);
    assert.equal(applied.length, 1, 'the broken file was not applied');
  } finally {
    stop();
  }
});
