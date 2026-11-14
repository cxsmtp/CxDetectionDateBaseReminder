// "Only Admins may still sign in with a password" is an Admin's switch, and stays one: on a server whose only
// address is the one under Settings (no REPORT_SERVER_URL), someone who may change that address must not be
// able to bring passwords back, or take single sign-on away, by making the address unusable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';
import { FIRST_PASSWORD, MEMBER_NEXT_PASSWORD, NEXT_PASSWORD, mockApiKey } from './test-credentials.js';

const MOCK_PORT = await freePort();
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const DEV_PASSWORD = MEMBER_NEXT_PASSWORD;
const children = [];
let log = '';
let serial = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function browser() {
  let cookie = '';
  const ip = `198.51.100.${(serial += 1)}`;
  const call = async (method, url, body) => {
    const res = await fetch(BASE + url, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.getSetCookie().find((c) => c.startsWith('cxdr_sid='));
    if (set) cookie = set.split(';')[0];
    return { status: res.status, location: res.headers.get('location') ?? '', body: await res.json().catch(() => null) };
  };
  return call;
}
const admin = browser();
const analyst = browser();
const address = (b, value) => b('PUT', '/api/settings', { links: { reportServerUrl: value } });
const setSso = (sso) => admin('PUT', '/api/iam/sign-in', { sso });
const devPassword = () => browser()('POST', '/api/session/password', { email: 'dev@acme.io', password: DEV_PASSWORD });
const offered = async () => (await browser()('GET', '/api/session')).body.sso;

async function until(check, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out\n${log.slice(-2000)}`);
}

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sso-address-'));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '1', RISKS: '1' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HTTPS: 'off', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: mockApiKey({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' }), CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD, REPORT_SERVER_URL: '', PUBLIC_URL: '', LETSENCRYPT_DOMAIN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  children.push(server);
  await until(() => /Successfully authenticated/.test(log) && /First administrator created/.test(log));
  await admin('POST', '/api/session/password', { email: 'admin@acme.io', password: FIRST_PASSWORD });
  await admin('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD });
  for (const [email, role, b, pw] of [['dev@acme.io', 'user', browser(), DEV_PASSWORD], ['analyst@acme.io', 'analyst', analyst, `analyst-${randomBytes(12).toString('base64url')}`]]) {
    assert.equal((await admin('POST', '/api/iam/users', { email, role, password: FIRST_PASSWORD })).status, 201);
    await b('POST', '/api/session/password', { email, password: FIRST_PASSWORD });
    assert.equal((await b('POST', '/api/me/password', { current: FIRST_PASSWORD, next: pw })).status, 200);
  }
  // The server's address is the one under Settings; single sign-on is on, with passwords for Admins only.
  // (Turning it on reads nothing from the provider: none is needed here.)
  assert.equal((await address(admin, BASE)).status, 200);
  assert.equal((await setSso({ enabled: true, issuer: 'https://login.acme.example/realms/acme', clientId: 'mission-zero', passwordAdminsOnly: true })).status, 200);
});

test.after(() => {
  for (const child of children) child.kill();
});

test('as set: the button is offered, and a password is not enough for someone who is not an Admin', async () => {
  assert.deepEqual(await offered(), { label: 'Sign in with single sign-on', passwordAdminsOnly: true });
  assert.equal((await devPassword()).status, 403);
});

test('someone who may change the server address cannot use it to take single sign-on away or bring passwords back', async () => {
  for (const value of ['http://mz.example', '', 'https://elsewhere.example']) {
    const r = await address(analyst, value);
    assert.equal(r.status, 400, JSON.stringify(value));
    assert.match(r.body.error, /so only an Admin changes it\./);
  }
  const upload = await analyst('POST', '/api/settings/import-env', { text: 'REPORT_SERVER_URL=http://mz.example\n' });
  assert.ok(upload.status >= 400, `the uploaded .env is refused too (${upload.status})`);
  // An Admin cannot break it by accident either: here there is no other address to fall back on.
  for (const value of ['http://mz.example', '']) {
    const r = await address(admin, value);
    assert.equal(r.status, 400, JSON.stringify(value));
    assert.match(r.body.error, /it must stay an https address/);
  }
  assert.equal((await admin('GET', '/api/settings')).body.links.reportServerUrl, BASE, 'the address is as it was');
  assert.deepEqual(await offered(), { label: 'Sign in with single sign-on', passwordAdminsOnly: true });
  assert.equal((await devPassword()).status, 403, 'still not enough');
});

test('even with no usable address at all, "only Admins" holds: the switch decides, not whether single sign-on can work', async () => {
  // The state the finding was about, reached the only way left: single sign-on off, the address taken out, on again.
  assert.equal((await setSso({ enabled: false })).status, 200);
  assert.equal((await devPassword()).status, 201, 'with single sign-on off, passwords are for everyone');
  assert.equal((await address(analyst, '')).status, 200);
  const on = await setSso({ enabled: true, passwordAdminsOnly: true });
  assert.equal(on.status, 200);
  assert.match(on.body.signIn.security.missing.join(' '), /No https address for this server is set/);
  assert.equal(await offered(), null, 'single sign-on cannot work, and the page does not offer it');
  assert.equal((await browser()('GET', '/api/session/oidc/start')).location, '/#sso=setup');
  const refused = await devPassword();
  assert.equal(refused.status, 403, 'and a password is still not enough for someone who is not an Admin');
  assert.match(refused.body.error, /turned off for this account/);
  assert.equal((await browser()('POST', '/api/session/password', { email: 'admin@acme.io', password: NEXT_PASSWORD })).status, 201, 'an Admin gets in and puts it right');
  // Giving it a usable address again is allowed while single sign-on is on (an Admin's change).
  assert.equal((await address(analyst, BASE)).status, 400);
  assert.equal((await address(admin, BASE)).status, 200);
  assert.deepEqual(await offered(), { label: 'Sign in with single sign-on', passwordAdminsOnly: true });
});
