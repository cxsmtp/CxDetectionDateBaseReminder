// Each person's own profile against the real server: name, language, time zone, programming
// languages and picture; what is refused; who may see a picture; what goes in the audit log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort } from './free-port.js';
import { FIRST_PASSWORD, mockApiKey } from './test-credentials.js';

const MOCK_PORT = await freePort();
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const KEY = mockApiKey({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' });
const PW = FIRST_PASSWORD;
const children = [];
let log = '';

function browser() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(BASE + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') ?? '';
    const payload = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: payload, type };
  };
}

// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const dataUrl = (type, bytes) => `data:${type};base64,${bytes.toString('base64')}`;

const admin = browser();
const member = browser();

test.before(async () => {
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '2', RISKS: '2' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HTTPS: 'off', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'profile-')), ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0', CX_API_KEY: KEY, CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme', ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: PW, SMTP_HOST: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  children.push(server);
  for (let i = 0; i < 200 && !/Successfully authenticated/.test(log); i++) await new Promise((r) => setTimeout(r, 100));
  const ok = (r) => assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}\n${log.slice(-500)}`);
  ok(await admin('POST', '/api/session/password', { email: 'admin@acme.io', password: PW }));
  ok(await admin('POST', '/api/me/password', { current: PW, next: `${PW}2` }));
  const created = await admin('POST', '/api/iam/users', { email: 'dev@acme.io', name: 'Dev', role: 'user', password: PW });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ok(await member('POST', '/api/session/password', { email: 'dev@acme.io', password: PW }));
  ok(await member('POST', '/api/me/password', { current: PW, next: `${PW}3` }));
});

test.after(() => {
  for (const child of children) child.kill();
});

test('a person sets their own name, language, time zone and programming languages', async () => {
  const before = (await member('GET', '/api/me')).body.user;
  assert.deepEqual(before.profile, { language: '', timeZone: '', timeZoneAuto: true, programmingLanguages: [] });
  const saved = await member('PUT', '/api/me/profile', { name: 'Dev Tanaka', language: 'ja', timeZoneAuto: false, timeZone: 'Asia/Tokyo', programmingLanguages: ['TypeScript', 'Java'] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.user.name, 'Dev Tanaka');
  assert.deepEqual(saved.body.user.profile, { language: 'ja', timeZone: 'Asia/Tokyo', timeZoneAuto: false, programmingLanguages: ['Java', 'TypeScript'] });
  assert.equal(saved.body.user.email, 'dev@acme.io', 'the email is shown, and cannot be changed here');
  assert.equal((await member('PUT', '/api/me/profile', { email: 'other@acme.io' })).body.user.email, 'dev@acme.io');
});

test('what is not a language, a time zone or a programming language is refused', async () => {
  assert.equal((await member('PUT', '/api/me/profile', { language: 'xx' })).status, 400);
  assert.equal((await member('PUT', '/api/me/profile', { timeZone: 'Mars/Olympus' })).status, 400);
  assert.equal((await member('PUT', '/api/me/profile', { programmingLanguages: ['Java', '<script>'] })).status, 400);
  assert.equal((await member('GET', '/api/me')).body.user.profile.language, 'ja', 'nothing changed');
});

test('a picture: checked by its bytes, kept small, and shown only to its owner and to people who see users', async () => {
  assert.equal((await member('PUT', '/api/me/avatar', { image: dataUrl('image/png', Buffer.from('<svg onload=alert(1)>')) })).status, 400, 'not a PNG');
  assert.equal((await member('PUT', '/api/me/avatar', { image: dataUrl('image/svg+xml', PNG) })).status, 400, 'SVG is not accepted');
  assert.equal((await member('PUT', '/api/me/avatar', { image: dataUrl('image/png', Buffer.concat([PNG, Buffer.alloc(210 * 1024)])) })).status, 413);
  const saved = await member('PUT', '/api/me/avatar', { image: dataUrl('image/png', PNG) });
  assert.equal(saved.status, 200);
  assert.ok(saved.body.user.avatarAt);
  const id = saved.body.user.id;
  const own = await member('GET', `/api/users/${id}/avatar`);
  assert.equal(own.status, 200);
  assert.equal(own.type, 'image/png');
  assert.deepEqual(own.body, PNG);
  assert.equal((await admin('GET', `/api/users/${id}/avatar`)).status, 200, 'an Admin sees people');
  const adminId = (await admin('GET', '/api/me')).body.user.id;
  assert.equal((await member('GET', `/api/users/${adminId}/avatar`)).status, 403, 'a User does not see other people');
  assert.equal((await member('PUT', '/api/me/avatar', { image: '' })).body.user.avatarAt, '');
  assert.equal((await member('GET', `/api/users/${id}/avatar`)).status, 404);
});

test('changes are audited; the computer’s own time zone and first language are noted quietly', async () => {
  const reasons = async () => (await admin('GET', '/api/audit?types=iam&limit=50')).body.entries.map((x) => x.reason);
  const count = (list) => list.filter((r) => r.startsWith('admin@acme.io updated their profile')).length;
  const start = count(await reasons());
  await admin('PUT', '/api/me/profile', { timeZone: 'Europe/Madrid', language: 'es', quiet: true });
  assert.equal(count(await reasons()), start, 'quiet: the zone picked up from the computer');
  await admin('PUT', '/api/me/profile', { programmingLanguages: ['Go'], quiet: true });
  assert.equal(count(await reasons()), start + 1, 'quiet covers only the time zone and language, never other changes');
  const all = await reasons();
  assert.ok(all.some((r) => r === 'dev@acme.io changed their picture.'));
  assert.ok(all.some((r) => r === 'dev@acme.io removed their picture.'));
});
