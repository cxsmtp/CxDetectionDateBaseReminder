// The product licence on the real server (src/activation.js): past its end, every page says the product has been
// deactivated and every request is refused, except the health check and the licence itself; a product code from
// the maintainer brings it back. The server here has already seen February 2027 (its licence clock never goes
// back), which is how a cut-off on 31 December 2026 is tested before then.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';
import { FIRST_PASSWORD } from './test-credentials.js';

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'licence-e2e-'));
const keyFile = path.join(dir, 'issuer.pem');
const script = (...args) => execFileSync(process.execPath, ['scripts/activation.mjs', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const publicKey = script('keygen', keyFile).split('\n').pop();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'licence-data-'));
fs.writeFileSync(path.join(dataDir, 'activation.json'), JSON.stringify({ seenAt: '2027-02-01T00:00:00.000Z' }));

const ask = async (method, url, body) => {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, text, body: json };
};

test.before(async () => {
  let log = '';
  const server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HTTPS: 'off', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0', SMTP_HOST: '', GITHUB_TOKEN: '', CX_API_KEY: '', ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD, MZ_ACTIVATION_TEST_KEY: publicKey },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  children.push(server);
  const end = Date.now() + 15000;
  while (!/running on/.test(log)) {
    if (Date.now() > end) throw new Error(log);
    await sleep(100);
  }
});
test.after(() => {
  for (const child of children) child.kill();
});

test('past its end: every page says it has been deactivated, and nothing else answers', async () => {
  for (const url of ['/', '/index.html', '/r/some-report']) {
    const page = await ask('GET', url);
    assert.equal(page.status, 503, url);
    assert.match(page.text, /The product has been deactivated\./);
    assert.match(page.text, /Bhawani Singh/);
  }
  for (const [method, url] of [['GET', '/api/me'], ['POST', '/api/session/password'], ['GET', '/app.js'], ['POST', '/api/relay/credits']]) {
    const r = await ask(method, url, method === 'POST' ? {} : undefined);
    assert.equal(r.status, 503, `${method} ${url}`);
  }
  assert.deepEqual((await ask('GET', '/api/me')).body, { error: 'The product has been deactivated. Please reach out to Bhawani Singh.', deactivated: true });
  assert.equal((await ask('GET', '/api/health')).status, 200, 'the container’s health check still answers');
  assert.equal((await ask('GET', '/deactivated.js')).status, 200, 'and what the page needs');
  const licence = (await ask('GET', '/api/licence')).body;
  assert.deepEqual([licence.active, licence.until, licence.message], [false, '2027-01-01T00:00:00.000Z', 'The product has been deactivated. Please reach out to Bhawani Singh.']);
});

test('only a product code from the maintainer, in date, brings it back', async () => {
  assert.equal((await ask('POST', '/api/licence/activate', { code: 'MZ1.nonsense.x' })).status, 400);
  const other = script('lang', keyFile, 'Acme Bank', 'he', 'on');
  assert.match((await ask('POST', '/api/licence/activate', { code: other })).body.error, /not a CxMissionZero activation code/);
  // In date by today's clock, but before what this server has already seen: refused.
  const ended = script('product', keyFile, '2027-01-15');
  assert.match((await ask('POST', '/api/licence/activate', { code: ended })).body.error, /ended on 2027-01-16/);
  assert.equal((await ask('GET', '/')).status, 503, 'still deactivated');

  const code = script('product', keyFile, '2027-06-30');
  const applied = await ask('POST', '/api/licence/activate', { code });
  assert.equal(applied.status, 200, applied.text);
  assert.deepEqual(applied.body, { active: true, until: '2027-07-01T00:00:00.000Z' });
  assert.equal((await ask('GET', '/')).status, 200, 'the app again');
  assert.equal((await ask('GET', '/deactivated.html')).status, 302, 'its deactivation page is not shown while it works');
  const signIn = await fetch(`${BASE}/api/session/password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@acme.io', password: FIRST_PASSWORD }) });
  assert.ok(signIn.ok, `signing in works again (${signIn.status})`);
});
