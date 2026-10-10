// Your branding, end to end: a Security Analyst presents with their own names,
// logo and colours (the reports and reminders they make carry them); everyone
// else, and every scheduled run, keeps the organisation's. Plus who may see the
// Branding and Activation codes pages, and that analysts never see the Admins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';
import { FIRST_PASSWORD, NEXT_PASSWORD, mockApiKey } from './test-credentials.js';

const MOCK_PORT = await freePort();
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const children = [];
let log = '';

function browser() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, text };
  };
}
const admin = browser();
const ana = browser();
const uma = browser();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branding-'));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '2', RISKS: '3' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: mockApiKey({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' }), CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  children.push(server);
  const end = Date.now() + 15000;
  while (!/Successfully authenticated/.test(log)) {
    if (Date.now() > end) throw new Error(log);
    await sleep(100);
  }
  await admin('POST', '/api/session/password', { email: 'admin@acme.io', password: FIRST_PASSWORD });
  await admin('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD });
  await admin('PUT', '/api/settings', { branding: { appName: 'Acme AppSec', companyName: 'Acme Corp', accentColor: '#112233' } });
  for (const [as, email, role] of [[ana, 'ana@acme.io', 'analyst'], [uma, 'uma@acme.io', 'user']]) {
    assert.equal((await admin('POST', '/api/iam/users', { email, name: email.split('@')[0], role, password: FIRST_PASSWORD })).status, 201);
    await as('POST', '/api/session/password', { email, password: FIRST_PASSWORD });
    assert.equal((await as('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD })).status, 200);
  }
});

test.after(() => {
  for (const child of children) child.kill();
});

test('a Security Analyst presents with their own branding; everyone else keeps the organisation’s', async () => {
  const empty = await ana('GET', '/api/me/branding');
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.equal(empty.body.branding.on, false);
  assert.equal(empty.body.organisation.companyName, 'Acme Corp', 'what each empty field falls back to');

  assert.equal((await ana('PUT', '/api/me/branding', { accentColor: 'red; background:url(x)' })).status, 400);
  assert.equal((await ana('PUT', '/api/me/branding', { logoUrl: 'javascript:alert(1)' })).status, 400);
  const saved = await ana('PUT', '/api/me/branding', { on: true, appName: 'Demo Studio', companyName: 'Globex Inc', accentColor: '#ff5500' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.me.branding, { appName: 'Demo Studio', logoUrl: '', own: true });
  assert.equal((await admin('GET', '/api/me')).body.branding.appName, 'Acme AppSec', 'only theirs');

  // What they make carries it: the report they download, and the reminder they preview.
  assert.equal((await ana('GET', '/api/scan')).status, 200);
  const report = await ana('POST', '/api/reports/html', {});
  assert.equal(report.status, 200, report.text.slice(0, 300));
  assert.match(report.text, /Globex Inc/);
  assert.doesNotMatch(report.text, /Acme Corp/);
  const reminder = await ana('POST', '/api/reminders', { dryRun: true, groupBy: 'none' });
  assert.equal(reminder.status, 200, JSON.stringify(reminder.body));
  assert.match(reminder.body.html, /Globex Inc/);
  // The organisation's settings are untouched.
  assert.equal((await admin('GET', '/api/settings')).body.branding.companyName, 'Acme Corp');
  assert.equal((await admin('GET', '/api/scan')).status, 200);
  assert.match((await admin('POST', '/api/reports/html', {})).text, /Acme Corp/);

  // Off again: back to the organisation's, with what they typed kept for next time.
  const off = await ana('PUT', '/api/me/branding', { on: false });
  assert.equal(off.body.me.branding.own, false);
  assert.equal(off.body.branding.companyName, 'Globex Inc');
  assert.match((await ana('POST', '/api/reports/html', {})).text, /Acme Corp/);
});

test('who may brand, and who may see the Branding and Activation codes pages', async () => {
  // A User has neither by default; the Branding page's data is not sent to them.
  assert.equal((await uma('GET', '/api/me/branding')).status, 403);
  assert.equal((await uma('GET', '/api/settings')).body.branding, undefined);
  assert.equal((await ana('GET', '/api/settings')).body.branding.companyName, 'Acme Corp');
  // Activation codes: Admins enter them; seeing the page is a permission an Admin hands out.
  assert.equal((await ana('GET', '/api/activation')).status, 403);
  const role = await admin('POST', '/api/iam/roles', { name: 'Presenter', permissions: ['findings.fetch', 'settings.view', 'branding.view', 'branding.personal', 'activation.view'] });
  assert.equal(role.status, 201, JSON.stringify(role.body));
  const id = role.body.roles.find((r) => r.name === 'Presenter').id;
  const people = (await admin('GET', '/api/iam')).body.users;
  assert.equal((await admin('PATCH', `/api/iam/users/${people.find((u) => u.email === 'uma@acme.io').id}`, { role: id })).status, 200);
  assert.equal((await uma('GET', '/api/me/branding')).status, 200);
  const seen = await uma('GET', '/api/activation');
  assert.equal(seen.status, 200, JSON.stringify(seen.body));
  assert.equal(seen.body.canManage, false);
  assert.equal(seen.body.people, undefined, 'no list of people: who sees Hebrew is a role permission now');
  assert.equal((await uma('POST', '/api/activation', { code: 'MZ1.x' })).status, 403, 'seeing is not entering codes');
  assert.equal((await admin('GET', '/api/activation')).body.canManage, true);
});

test('a Security Analyst sees analysts and below, never the Admins', async () => {
  const view = (await ana('GET', '/api/iam')).body;
  // Uma's Presenter role holds activation.view, which analysts do not: beyond their reach, so out of sight too.
  assert.deepEqual(view.users.map((u) => u.email).sort(), ['ana@acme.io']);
  assert.ok(!view.roles.some((r) => r.name === 'Presenter'));
  assert.ok(view.roles.some((r) => r.id === 'user'));
  assert.ok(!view.roles.some((r) => r.id === 'admin'));
  const all = (await admin('GET', '/api/iam')).body;
  assert.equal(all.users.length, 3);
  assert.ok(all.roles.some((r) => r.id === 'admin'));
});
