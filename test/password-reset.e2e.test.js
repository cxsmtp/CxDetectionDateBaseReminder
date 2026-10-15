// Forgotten password, end to end: the link goes only to the account’s own address, at the
// server's own address; asking never says whether an account exists; the link works once,
// signs everyone out, and a confirmation follows; Admins decide who may use it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';
import { fakeSmtp } from './fake-smtp.js';
import { FIRST_PASSWORD, NEXT_PASSWORD, mockApiKey } from './test-credentials.js';

const MOCK_PORT = await freePort();
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const children = [];
let log = '';
let smtp;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEV_PASSWORD = `dev-${randomBytes(12).toString('base64url')}`;
const NEW_PASSWORD = `new-${randomBytes(12).toString('base64url')}`;

function browser() {
  let cookie = '';
  return async (method, url, body, headers = {}) => {
    const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
const admin = browser();
const dev = browser();
const stranger = browser();

const readable = (raw) => raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const mailTo = (address, pattern) => smtp.messages.filter((m) => m.to.includes(address) && (!pattern || pattern.test(readable(m.raw))));
const linkIn = (message) => /(http\S+\/#reset=([A-Za-z0-9_-]{43}))/.exec(readable(message.raw));
async function until(check, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out\n${log.slice(-2000)}`);
}
const accessLog = async () => (await admin('GET', '/api/audit?types=access,iam&limit=100')).body.entries.map((e) => e.reason);

test.before(async () => {
  smtp = await fakeSmtp();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-'));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '1', RISKS: '1' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HTTPS: 'off', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: mockApiKey({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' }), CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD, REPORT_SERVER_URL: BASE, MAINTAINER_EMAIL: 'maintainer@vendor.example',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  children.push(server);
  await until(() => /Successfully authenticated/.test(log) && /First administrator created/.test(log));
  await admin('POST', '/api/session/password', { email: 'admin@acme.io', password: FIRST_PASSWORD });
  await admin('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD });
  assert.equal((await admin('POST', '/api/iam/users', { email: 'dev@acme.io', name: 'Dev', role: 'user', password: FIRST_PASSWORD })).status, 201);
  assert.equal((await admin('POST', '/api/iam/users', { email: 'keyonly@acme.io', name: 'Key only', role: 'user' })).status, 201);
  await dev('POST', '/api/session/password', { email: 'dev@acme.io', password: FIRST_PASSWORD });
  assert.equal((await dev('POST', '/api/me/password', { current: FIRST_PASSWORD, next: DEV_PASSWORD })).status, 200);
});

test.after(async () => {
  for (const child of children) child.kill();
  await smtp?.close();
});

test('not offered until email is set up and tested; asking then sends nothing', async () => {
  assert.equal((await stranger('GET', '/api/session')).body.passwordReset, false);
  const asked = await stranger('POST', '/api/session/password-reset', { email: 'dev@acme.io' });
  assert.equal(asked.status, 202, 'the same answer either way');
  await sleep(300);
  assert.equal(mailTo('dev@acme.io').length, 0);
  assert.match((await accessLog()).join('\n'), /Password reset asked for dev@acme\.io: no link sent \(email or the server address is not set up\)/);
  await admin('PUT', '/api/settings', { smtp: { host: '127.0.0.1', port: smtp.port, secure: false, requireAuth: true, user: 'mz@acme.io', password: 'x', rejectUnauthorized: false, fromAddress: 'mz@acme.io', fromName: 'MissionZero' } });
  assert.equal((await admin('POST', '/api/settings/connections/check', { rollback: false })).body.smtp.ok, true);
  assert.equal((await stranger('GET', '/api/session')).body.passwordReset, true);
});

test('asking never says whether an address has an account', async () => {
  const known = await stranger('POST', '/api/session/password-reset', { email: 'keyonly@acme.io' });
  const unknown = await stranger('POST', '/api/session/password-reset', { email: 'Wrong-Password-Typed-Here' });
  assert.deepEqual([known.status, unknown.status], [202, 202]);
  assert.deepEqual(known.body, unknown.body, 'word for word the same');
  await sleep(300);
  assert.equal(mailTo('keyonly@acme.io').length, 0, 'an account with key sign-in only gets no password');
  const reasons = (await accessLog()).join('\n');
  assert.match(reasons, /for an address with no account here: no link sent/);
  assert.doesNotMatch(reasons, /Wrong-Password-Typed-Here/, 'what was typed is not kept when it is no account');
  assert.equal((await stranger('POST', '/api/session/password-reset', {})).status, 400);
});

test('the link: to the account’s own address, at the server’s own address, once, and everyone is signed out', async () => {
  assert.equal((await dev('GET', '/api/me')).status, 200, 'signed in before');
  // A forged Host cannot steer the link elsewhere.
  assert.equal((await stranger('POST', '/api/session/password-reset', { email: ' DEV@acme.io ' }, { 'X-Forwarded-Host': 'evil.example' })).status, 202);
  const mail = await until(() => mailTo('dev@acme.io', /Choose a new password/)[0]);
  const [, link, token] = linkIn(mail) ?? [];
  assert.ok(link, readable(mail.raw));
  assert.ok(link.startsWith(`${BASE}/#reset=`), `only this server's own address: ${link}`);
  assert.doesNotMatch(readable(mail.raw), /evil\.example/);
  assert.equal(mail.to.length, 1, 'to that address only');

  // A second request within the minute sends nothing more.
  await stranger('POST', '/api/session/password-reset', { email: 'dev@acme.io' });
  await sleep(300);
  assert.equal(mailTo('dev@acme.io', /Choose a new password/).length, 1);

  const check = await stranger('POST', '/api/session/password-reset/check', { token });
  assert.equal(check.status, 200);
  assert.equal(check.body.email, 'd••@acme.io', 'whose account, partly hidden');
  assert.equal((await stranger('POST', '/api/session/password-reset/check', { token: token.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) })).status, 400);

  assert.equal((await stranger('POST', '/api/session/password-reset/confirm', { token, password: 'short' })).status, 400);
  const same = await stranger('POST', '/api/session/password-reset/confirm', { token, password: DEV_PASSWORD });
  assert.equal(same.status, 400);
  assert.match(same.body.error, /different from the current one/);
  const done = await stranger('POST', '/api/session/password-reset/confirm', { token, password: NEW_PASSWORD });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.email, 'dev@acme.io');
  assert.equal((await stranger('GET', '/api/me')).status, 401);

  assert.equal((await dev('GET', '/api/me')).status, 401, 'the old session is signed out');
  assert.equal((await stranger('POST', '/api/session/password-reset/confirm', { token, password: `${NEW_PASSWORD}-again` })).status, 400, 'used: never again');
  assert.equal((await dev('POST', '/api/session/password', { email: 'dev@acme.io', password: DEV_PASSWORD })).status, 401, 'the old password no longer works');
  assert.equal((await dev('POST', '/api/session/password', { email: 'dev@acme.io', password: NEW_PASSWORD })).status, 201);
  await until(() => mailTo('dev@acme.io', /password was changed/)[0]);
  const reasons = (await accessLog()).join('\n');
  assert.match(reasons, /Password reset link sent to dev@acme\.io/);
  assert.match(reasons, /dev@acme\.io reset their password with an emailed link/);
  assert.doesNotMatch(JSON.stringify(await admin('GET', '/api/audit?limit=200')), new RegExp(token), 'the link is never written down');
});

test('Admins decide who may reset by email; only they can change it', async () => {
  const view = await admin('GET', '/api/iam');
  assert.deepEqual([view.body.signIn.policy, view.body.signIn.ready, view.body.signIn.canChange], ['everyone', true, true]);
  assert.equal((await dev('GET', '/api/iam')).body?.signIn ?? null, null);
  assert.equal((await dev('PUT', '/api/iam/policy', { passwordReset: 'off' })).status, 403);
  assert.equal((await admin('PUT', '/api/iam/policy', { passwordReset: 'sometimes' })).status, 400);

  const notAdmins = await admin('PUT', '/api/iam/policy', { passwordReset: 'not-admins' });
  assert.equal(notAdmins.status, 200);
  assert.equal(notAdmins.body.policy, 'not-admins');
  await stranger('POST', '/api/session/password-reset', { email: 'admin@acme.io' });
  await sleep(300);
  assert.equal(mailTo('admin@acme.io', /Choose a new password/).length, 0, 'no link for an Admin');
  assert.match((await accessLog()).join('\n'), /Password reset asked for admin@acme\.io: no link sent \(resetting by email is not allowed for this account\)/);
  assert.match((await accessLog()).join('\n'), /Password reset by email: everyone → everyone but Admins/);

  assert.equal((await admin('PUT', '/api/iam/policy', { passwordReset: 'off' })).body.ready, false);
  assert.equal((await stranger('GET', '/api/session')).body.passwordReset, false, 'the link is no longer shown');
  assert.equal((await admin('PUT', '/api/iam/policy', { passwordReset: 'everyone' })).body.ready, true);
});

test('an Admin edits someone’s profile: email, name, language, time zone, languages, look; checked whole, audited, both addresses told', async () => {
  const devId = (await admin('GET', '/api/iam')).body.users.find((u) => u.email === 'dev@acme.io').id;
  const adminId = (await admin('GET', '/api/me')).body.user.id;
  const opened = await admin('GET', `/api/iam/users/${devId}/profile`);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.ok(opened.body.languages.includes('ja'));
  assert.equal(opened.body.user.passwordHash, undefined, 'never the password hash');

  const saved = await admin('PUT', `/api/iam/users/${devId}/profile`, { name: 'Dev Tanaka', language: 'ja', timeZoneAuto: false, timeZone: 'Asia/Tokyo', programmingLanguages: ['TypeScript', 'Java'], look: 'classic', accent: 'violet' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const me = (await dev('GET', '/api/me')).body.user;
  assert.equal(me.name, 'Dev Tanaka');
  assert.deepEqual([me.profile.language, me.profile.timeZone, me.profile.timeZoneAuto, me.profile.look, me.profile.accent], ['ja', 'Asia/Tokyo', false, 'classic', 'violet']);
  assert.deepEqual(me.profile.programmingLanguages, ['Java', 'TypeScript']);

  // A bad field: nothing is saved, the email included.
  const bad = await admin('PUT', `/api/iam/users/${devId}/profile`, { email: 'developer@acme.io', timeZone: 'Mars/Olympus' });
  assert.equal(bad.status, 400);
  assert.equal((await dev('GET', '/api/me')).body.user.email, 'dev@acme.io', 'checked whole first');
  assert.equal((await admin('PUT', `/api/iam/users/${devId}/profile`, { email: 'admin@acme.io' })).status, 409, 'not someone else’s address');
  assert.equal((await admin('PUT', `/api/iam/users/${devId}/profile`, { email: 'not an address' })).status, 400);
  assert.equal((await admin('PUT', `/api/iam/users/${adminId}/profile`, { name: 'Me' })).status, 400, 'their own is Your profile');
  assert.equal((await dev('PUT', `/api/iam/users/${adminId}/profile`, { name: 'Taken over' })).status, 403, 'only people who may manage people');
  assert.equal((await dev('GET', `/api/iam/users/${adminId}/profile`)).status, 403);

  const moved = await admin('PUT', `/api/iam/users/${devId}/profile`, { email: ' Developer@ACME.io ' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.user.email, 'developer@acme.io');
  await until(() => mailTo('dev@acme.io', /sign-in email was changed/)[0]);
  await until(() => mailTo('developer@acme.io', /sign-in email was changed/)[0]);
  assert.equal((await dev('GET', '/api/me')).body.user.email, 'developer@acme.io', 'their session carries on');
  const fresh = browser();
  assert.equal((await fresh('POST', '/api/session/password', { email: 'dev@acme.io', password: NEW_PASSWORD })).status, 401, 'the old address no longer signs in');
  assert.equal((await fresh('POST', '/api/session/password', { email: 'developer@acme.io', password: NEW_PASSWORD })).status, 201);
  const reasons = (await admin('GET', '/api/audit?types=iam&limit=50')).body.entries.map((e) => e.reason).join('\n');
  assert.match(reasons, /Changed dev@acme\.io's profile: name, language, timeZone, timeZoneAuto, programmingLanguages, look, accent\./);
  assert.match(reasons, /Changed dev@acme\.io's profile: email dev@acme\.io → developer@acme\.io\./);

  assert.equal((await admin('PUT', `/api/iam/users/${devId}/avatar`, { image: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 400, 'pictures are checked as for anyone');
  assert.equal((await admin('PUT', `/api/iam/users/${devId}/avatar`, { image: '' })).status, 200);
});
