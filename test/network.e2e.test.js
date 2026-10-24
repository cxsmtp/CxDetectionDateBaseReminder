// Settings → Network & proxy: check the way to Checkmarx One with a proxy before saving it,
// save it only when the proxy lets Checkmarx One through, never show its password, and say
// what the network team needs to allow. Admins of the first tenant only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { proxyEnvironment } from '../src/network.js';
import { fakeCheckmarx, testProxy } from './fake-proxy.js';
import { freePort } from './free-port.js';
import { FIRST_PASSWORD, NEXT_PASSWORD } from './test-credentials.js';

// The test proxy's password: made afresh on every run, never written in the code.
const PROXY_PASSWORD = `proxy-${randomBytes(12).toString('base64url')}`;
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'network-e2e-'));
let server;
let cx;
let proxy;
let log = '';
let cookie = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function admin(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Origin: BASE, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}

test.before(async () => {
  cx = await fakeCheckmarx();
  proxy = await testProxy({ user: 'svc', pass: PROXY_PASSWORD, refuse: ['blocked.checkmarx.test'] });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_proxy$/i.test(k)));
  server = spawn(process.execPath, ['src/server.js'], {
    env: { ...env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0', CX_API_KEY: '', ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD, SMTP_HOST: 'smtp.acme.test', GITHUB_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const end = Date.now() + 20000;
  while ((await admin('POST', '/api/session/password', { email: 'admin@acme.io', password: FIRST_PASSWORD }).catch(() => ({ status: 0 }))).status !== 201) {
    if (Date.now() > end) throw new Error(log);
    await sleep(100);
  }
  await admin('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD });
});

test.after(() => {
  server?.kill();
  cx?.close();
  proxy?.close();
});

const target = () => `iam.checkmarx.test:${cx.port}`;

test('direct to begin with, and the sheet already lists what to allow', async () => {
  const view = await admin('GET', '/api/network');
  assert.equal(view.status, 200);
  assert.equal(view.body.proxy, null);
  const what = view.body.requirements.map((r) => `${r.what}|${r.host}|${r.port}`);
  assert.ok(what.includes('Checkmarx One|<region>.iam.checkmarx.net|443'), 'no key yet: the pattern');
  assert.ok(what.some((w) => w.startsWith('Email server|smtp.acme.test|')));
  assert.match(view.body.text, /Outgoing web traffic goes directly/);
});

test('the check says where it stops: no sign-in, refused, wrong port, or through to the certificate', async () => {
  const noAuth = await admin('POST', '/api/network/check', { url: proxy.url, target: target() });
  assert.equal(noAuth.status, 200);
  assert.equal(noAuth.body.ok, false);
  assert.deepEqual(noAuth.body.results[0].steps.map((s) => [s.step, s.ok, s.status ?? 0]), [['proxy', true, 0], ['tunnel', false, 407]]);

  const through = await admin('POST', '/api/network/check', { url: proxy.url, username: 'svc', password: PROXY_PASSWORD, target: target() });
  assert.deepEqual(through.body.results[0].steps.map((s) => [s.step, s.ok]), [['proxy', true], ['tunnel', true], ['certificate', false]]);
  assert.equal(through.body.via, proxy.url.replace('127.0.0.1', '127.0.0.1'));

  const refused = await admin('POST', '/api/network/check', { url: proxy.url, username: 'svc', password: PROXY_PASSWORD, target: `blocked.checkmarx.test:${cx.port}` });
  assert.equal(refused.body.results[0].steps.at(-1).status, 403);

  const bad = await admin('POST', '/api/network/check', { url: 'socks5://x:1080', target: target() });
  assert.equal(bad.status, 400);
  assert.equal((await admin('POST', '/api/network/check', { url: proxy.url, target: 'not a host!' })).status, 400);
});

test('a proxy that does not let Checkmarx One through is not saved; one that does is, without showing its password', async () => {
  const wrong = await admin('PUT', '/api/network', { url: proxy.url, username: 'svc', password: 'wrong', target: target() });
  assert.equal(wrong.status, 422);
  assert.match(wrong.body.error, /Not saved/);
  assert.equal(fs.existsSync(path.join(dataDir, 'network.json')), false);

  const saved = await admin('PUT', '/api/network', { url: proxy.url, username: 'svc', password: PROXY_PASSWORD, noProxy: '.acme.local', target: target() });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.restarting, false, 'started without the launcher: it says to restart');
  assert.equal(saved.body.proxy.source, 'settings');
  assert.equal(saved.body.proxy.hasPassword, true);
  assert.ok(!JSON.stringify(saved.body).includes(PROXY_PASSWORD), 'the password never comes back');
  assert.ok(saved.body.changedAt);
  assert.equal(fs.statSync(path.join(dataDir, 'network.json')).mode & 0o777, 0o600);

  // What the launcher starts the server with next time.
  const env = proxyEnvironment(dataDir, {});
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
  assert.equal(env.HTTPS_PROXY, proxy.url.replace('http://', `http://svc:${PROXY_PASSWORD}@`));
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1,.acme.local');

  // Left blank, the saved password is used.
  const again = await admin('POST', '/api/network/check', { url: proxy.url, username: 'svc', password: '', target: target() });
  assert.equal(again.body.results[0].steps[1].ok, true);

  const view = await admin('GET', '/api/network');
  assert.match(view.body.text, /goes through the proxy http:\/\/127\.0\.0\.1/);
  assert.ok(view.body.requirements.some((r) => r.what === 'Checkmarx One' && r.route === 'Through the proxy'));

  const audit = await admin('GET', '/api/audit?type=settings');
  assert.ok(JSON.stringify(audit.body).includes('now go through the proxy'));
  assert.ok(!JSON.stringify(audit.body).includes(PROXY_PASSWORD));

  const removed = await admin('DELETE', '/api/network');
  assert.equal(removed.status, 200);
  assert.equal(removed.body.proxy, null);
  assert.deepEqual(proxyEnvironment(dataDir, {}), {});
  assert.equal((await admin('DELETE', '/api/network')).status, 404);
});

test('without a session nothing is shown or changed', async () => {
  for (const [method, url] of [['GET', '/api/network'], ['POST', '/api/network/check'], ['PUT', '/api/network'], ['DELETE', '/api/network']]) {
    const status = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Origin: BASE }, body: method === 'GET' ? undefined : '{}' }).then((r) => r.status);
    assert.equal(status, 401, `${method} ${url}`);
  }
});
