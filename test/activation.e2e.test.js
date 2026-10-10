// Activation codes on the real server: Hebrew is neither offered nor served until a code from
// the maintainer turns it on, and then only to the people an Admin chose. Also: until a code from
// the maintainer turns it on, and a deactivation code turns it off again. A multi-tenant code is
// recorded. Only an Admin may enter codes, and every attempt is in the audit log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';
import { FIRST_PASSWORD, NEXT_PASSWORD } from './test-credentials.js';

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-e2e-'));
const keyFile = path.join(dir, 'issuer.pem');
const script = (...args) => execFileSync(process.execPath, ['scripts/activation.mjs', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const publicKey = script('keygen', keyFile).split('\n').pop();

function browser() {
  let cookie = '';
  return async (method, url, body) => {
    const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const admin = browser();

test.before(async () => {
  let log = '';
  const server = spawn(process.execPath, ['src/server.js'], {
    // The test key is trusted only under `node --test` (NODE_TEST_CONTEXT, passed on from this runner).
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HTTPS: 'off', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'act-')), ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0', SMTP_HOST: '', GITHUB_TOKEN: '', CX_API_KEY: '', ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD, MZ_ACTIVATION_TEST_KEY: publicKey },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  children.push(server);
  const end = Date.now() + 15000;
  while (!(/running on/.test(log) && /First administrator created/.test(log))) {
    if (Date.now() > end) throw new Error(log);
    await sleep(100);
  }
  await admin('POST', '/api/session/password', { email: 'admin@acme.io', password: FIRST_PASSWORD });
  await admin('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD });
});
test.after(() => {
  for (const child of children) child.kill();
});

const heServed = async () => (await fetch(`${BASE}/i18n/he.json`)).status;

test('German and French can be chosen in a profile (they are offered everywhere)', async () => {
  for (const language of ['de', 'fr', 'ar']) {
    const r = await admin('PUT', '/api/me/profile', { language });
    assert.equal(r.status, 200, `${language}: ${JSON.stringify(r.body)}`);
  }
});

test('Hebrew is neither offered nor served before activation', async () => {
  assert.equal(await heServed(), 404);
  assert.ok(!(await admin('GET', '/api/health')).body.languages.includes('he'));
  assert.ok(!(await admin('GET', '/api/me/profile/options')).body.languages.includes('he'));
  const r = await admin('PUT', '/api/me/profile', { language: 'he' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not available/);
  assert.equal((await fetch(`${BASE}/i18n/de.json`)).status, 200, 'open languages are served');
  // Nothing a code has not unlocked is listed: the page names no add-on before its code.
  const page = await admin('GET', '/api/activation');
  assert.deepEqual(page.body.languages, {});
  assert.equal(page.body.tenants, null);
  assert.equal((await admin('GET', '/api/me')).body.unlocked.tenants, false, 'Settings → Tenants stays hidden');
});

test('a Hebrew activation code turns it on; a deactivation code turns it off', async () => {
  assert.equal((await admin('POST', '/api/activation', { code: 'MZ1.nonsense.code' })).status, 400);
  const on = await admin('POST', '/api/activation', { code: script('lang', keyFile, 'Acme Bank', 'he', 'on') });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.match(on.body.applied, /Hebrew turned on until/);
  assert.equal(on.body.languages.he.on, true);
  assert.equal(on.body.languages.he.org, 'Acme Bank');
  assert.match(on.body.applied, /for the roles with its permission/);
  assert.equal('users' in on.body.languages.he, false, 'no list of people any more');
  assert.equal('people' in on.body, false);
  assert.ok((await admin('GET', '/api/me')).body.languages.includes('he'), 'Admins always have it, so they see it at once');
  assert.equal((await admin('GET', '/i18n/he.json')).status, 200);
  assert.equal((await admin('PUT', '/api/me/profile', { language: 'he' })).status, 200);

  // A Security Analyst sees it once an Admin ticks the Hebrew permission for the role.
  const analyst = browser();
  const added = await admin('POST', '/api/iam/users', { email: 'analyst@acme.io', name: 'Analyst', role: 'analyst', password: 'analyst password 1' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  await analyst('POST', '/api/session/password', { email: 'analyst@acme.io', password: 'analyst password 1' });
  await analyst('POST', '/api/me/password', { current: 'analyst password 1', next: 'analyst password 22' });
  assert.equal((await analyst('GET', '/i18n/he.json')).status, 404, 'never sent to a role without it');
  assert.ok(!(await analyst('GET', '/api/health')).body.languages.includes('he'));
  assert.equal(await heServed(), 404, 'nor to someone not signed in');
  const iam = (await admin('GET', '/api/iam')).body;
  assert.ok(iam.permissions.some((p) => p.id === 'language.he'), 'listed on People & roles while Hebrew is on');
  const role = iam.roles.find((r) => r.id === 'analyst');
  assert.ok(!role.permissions.includes('language.he'));
  const ticked = await admin('PUT', '/api/iam/roles/analyst', { name: role.name, description: role.description, permissions: [...role.permissions, 'language.he'] });
  assert.equal(ticked.status, 200, JSON.stringify(ticked.body));
  assert.equal((await analyst('GET', '/i18n/he.json')).status, 200);
  assert.ok((await analyst('GET', '/api/me')).body.languages.includes('he'));
  assert.equal((await analyst('PUT', '/api/me/profile', { language: 'he' })).status, 200);
  assert.equal((await admin('PUT', '/api/activation/languages/he/users', { users: [] })).status, 404, 'the old list of people is gone');

  const off = await admin('POST', '/api/activation', { code: script('lang', keyFile, 'Acme Bank', 'he', 'off') });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.match(off.body.applied, /Hebrew turned off/);
  assert.equal((await admin('GET', '/i18n/he.json')).status, 404);
  assert.ok(!(await admin('GET', '/api/health')).body.languages.includes('he'));
  assert.equal((await analyst('GET', '/i18n/he.json')).status, 404);
  // Off: not listed on People & roles, and a role saved meanwhile keeps it for when Hebrew is back.
  const after = (await admin('GET', '/api/iam')).body;
  assert.ok(!after.permissions.some((p) => p.id === 'language.he'));
  const kept = after.roles.find((r) => r.id === 'analyst');
  const saved = await admin('PUT', '/api/iam/roles/analyst', { name: kept.name, description: kept.description, permissions: kept.permissions.filter((p) => p !== 'language.he') });
  assert.equal(saved.status, 200);
  assert.ok(saved.body.roles.find((r) => r.id === 'analyst').permissions.includes('language.he'));
});

test('a multi-tenant code is recorded; a code from another key is refused; all of it audited', async () => {
  const r = await admin('POST', '/api/activation', { code: script('issue', keyFile, 'Acme Bank', '4') });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.tenants.org, 'Acme Bank');
  assert.equal(r.body.tenants.maxTenants, 4);
  assert.equal(r.body.tenants.valid, true);
  assert.equal((await admin('GET', '/api/me')).body.unlocked.tenants, true, 'Settings → Tenants appears at once');
  // Signed by someone else's key.
  const other = path.join(dir, 'other.pem');
  script('keygen', other);
  const forged = await admin('POST', '/api/activation', { code: script('lang', other, 'Acme Bank', 'he', 'on') });
  assert.equal(forged.status, 400);
  assert.match(forged.body.error, /not valid/);
  const audit = (await admin('GET', '/api/audit?types=settings&limit=50')).body;
  const reasons = audit.entries.map((e) => e.reason).join('\n');
  assert.match(reasons, /Activation code applied: Hebrew turned on/);
  assert.match(reasons, /Activation code applied: Hebrew turned off/);
  assert.match(reasons, /Activation code applied: several Checkmarx One tenants unlocked for Acme Bank/);
  assert.match(reasons, /Activation code refused/);
  const roles = (await admin('GET', '/api/audit?types=iam&limit=50')).body.entries.map((e) => e.reason).join('\n');
  assert.match(roles, /Changed role "Security Analyst": added language\.he/, 'who may see Hebrew is a role change, on record');
});
