// Several Checkmarx One tenants on the real server (src/tenancy.js): off until a tenants
// activation code is in date; then a Super Admin adds tenants, and each keeps its own settings
// and audit log. People added in a tenant work only there, without the server-wide permissions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenancy-e2e-'));
const dataDir = path.join(dir, 'data');
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
const local = browser();
let eu = '';

test.before(async () => {
  let log = '';
  const server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HTTPS: 'off', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0', SMTP_HOST: '', GITHUB_TOKEN: '', CX_API_KEY: '', ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: 'temporary password 1', MZ_ACTIVATION_TEST_KEY: publicKey },
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
  await admin('POST', '/api/session/password', { email: 'admin@acme.io', password: 'temporary password 1' });
  await admin('POST', '/api/me/password', { current: 'temporary password 1', next: 'correct horse battery' });
});
test.after(() => {
  for (const child of children) child.kill();
});

test('without a tenants activation code, several tenants stay off and cannot be turned on', async () => {
  const view = await admin('GET', '/api/tenants');
  assert.equal(view.status, 200);
  assert.equal(view.body.enabled, false);
  assert.equal(view.body.unlocked, false);
  assert.equal(view.body.tenants.length, 1);
  const on = await admin('POST', '/api/tenants/enabled', { on: true });
  assert.equal(on.status, 403);
  assert.match(on.body.error, /activation code/);
  assert.equal((await admin('POST', '/api/tenants', { name: 'Acme EU' })).status, 403);
});

test('with the code, a Super Admin turns tenants on and adds one, up to the code\'s limit', async () => {
  const code = await admin('POST', '/api/activation', { code: script('issue', keyFile, 'Acme Bank', '3') });
  assert.equal(code.status, 200, JSON.stringify(code.body));
  assert.equal((await admin('POST', '/api/tenants', { name: 'Acme EU' })).status, 409, 'not before the switch is on');
  const on = await admin('POST', '/api/tenants/enabled', { on: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.enabled, true);
  const added = await admin('POST', '/api/tenants', { name: 'Acme EU' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  eu = added.body.added.id;
  assert.equal(added.body.tenants.length, 2);
  assert.equal((await admin('POST', '/api/tenants', { name: 'Acme EU' })).status, 409, 'names are unique');
  assert.equal((await admin('POST', '/api/tenants', { name: 'Acme US' })).status, 201);
  const full = await admin('POST', '/api/tenants', { name: 'Acme APAC' });
  assert.equal(full.status, 409);
  assert.match(full.body.error, /up to 3 tenants/);
  assert.ok(fs.existsSync(path.join(dataDir, 'tenants', eu)), 'each further tenant has its own folder');
  const me = await admin('GET', '/api/me');
  assert.equal(me.body.tenancy.superAdmin, true);
  assert.equal(me.body.tenancy.tenants.length, 3);
});

test('each tenant keeps its own settings and audit log', async () => {
  assert.equal((await admin('PUT', '/api/settings', { branding: { appName: 'Main tenant tool' } })).status, 200);
  const switched = await admin('POST', '/api/me/tenant', { id: eu });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.current.name, 'Acme EU');
  assert.equal((await admin('GET', '/api/settings')).body.branding.appName, 'CxMissionZero', 'a new tenant starts from the defaults');
  assert.equal((await admin('PUT', '/api/settings', { branding: { appName: 'EU tool' } })).status, 200);
  const euAudit = await admin('GET', '/api/audit');
  const reasons = euAudit.body.entries.map((e) => e.reason).join('\n');
  assert.match(reasons, /added by Super Admin admin@acme\.io/);
  assert.match(reasons, /Super Admin admin@acme\.io opened this tenant/);
  assert.doesNotMatch(reasons, /Several Checkmarx One tenants turned on/, 'server-wide events stay in the first tenant\'s log');
  assert.equal((await admin('POST', '/api/me/tenant', { id: 'default' })).status, 200);
  assert.equal((await admin('GET', '/api/settings')).body.branding.appName, 'Main tenant tool');
  const mainReasons = (await admin('GET', '/api/audit')).body.entries.map((e) => e.reason).join('\n');
  assert.match(mainReasons, /Several Checkmarx One tenants turned on/);
  assert.match(mainReasons, /Tenant "Acme EU" added/);
  assert.ok(fs.existsSync(path.join(dataDir, 'tenants', eu, 'settings.json')));
});

test('someone added in a tenant works only there, without server-wide permissions', async () => {
  await admin('POST', '/api/me/tenant', { id: eu });
  const added = await admin('POST', '/api/iam/users', { email: 'eu-admin@acme.io', name: 'EU Admin', role: 'admin', password: 'eu admin password 1' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const user = added.body.users.find((u) => u.email === 'eu-admin@acme.io');
  assert.deepEqual(user.tenants, [eu]);
  await admin('POST', '/api/me/tenant', { id: 'default' });

  await local('POST', '/api/session/password', { email: 'eu-admin@acme.io', password: 'eu admin password 1' });
  await local('POST', '/api/me/password', { current: 'eu admin password 1', next: 'eu admin password 22' });
  await local('POST', '/api/terms/accept', { version: (await local('GET', '/api/terms')).body.version });
  const me = await local('GET', '/api/me');
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body.tenancy.current.id, eu);
  assert.equal(me.body.tenancy.superAdmin, false);
  assert.deepEqual(me.body.tenancy.tenants.map((t) => t.id), [eu]);
  for (const p of ['backup.manage', 'security.https', 'system.update', 'activation.manage', 'tenants.manage']) assert.ok(!me.body.permissions.includes(p), p);
  assert.ok(me.body.permissions.includes('integration.cxone'), 'still the Admin of their own tenant');
  assert.equal((await local('GET', '/api/settings')).body.branding.appName, 'EU tool');
  assert.equal((await local('POST', '/api/me/tenant', { id: 'default' })).status, 404);
  assert.equal((await local('GET', '/api/backup')).status, 403);
  assert.equal((await local('POST', '/api/tenants', { name: 'Mine' })).status, 403);
  const people = await local('GET', '/api/iam');
  // The people who can work in their tenant: themselves, and the Super Admin (whom they cannot change).
  assert.deepEqual(people.body.users.map((u) => u.email).sort(), ['admin@acme.io', 'eu-admin@acme.io']);
  assert.equal(people.body.users.find((u) => u.email === 'admin@acme.io').canManage, false);
  assert.equal((await local('POST', '/api/iam/roles', { name: 'Tenant role', permissions: ['findings.fetch'] })).status, 403, 'roles are shared: not theirs to change');
});

test('a Super Admin chooses who works in which tenant', async () => {
  const people = await admin('GET', '/api/iam');
  const user = people.body.users.find((u) => u.email === 'eu-admin@acme.io');
  assert.ok(people.body.tenants.length === 3, 'a Super Admin sees the tenants to choose from');
  const both = await admin('PUT', `/api/iam/users/${user.id}/tenants`, { tenants: [eu, 'default'] });
  assert.equal(both.status, 200, JSON.stringify(both.body));
  // An Admin who also works in the first tenant holds the whole Admin role again, Super Admin included.
  const now = (await local('GET', '/api/me')).body;
  assert.equal(now.tenancy.superAdmin, true);
  assert.equal(now.tenancy.tenants.length, 3);
  assert.equal((await admin('PUT', `/api/iam/users/${user.id}/tenants`, { tenants: ['nope'] })).status, 400);
  assert.equal((await admin('PUT', `/api/iam/users/${user.id}/tenants`, { tenants: [eu] })).status, 200);
});

test('backups include every tenant', async () => {
  const { collectStateFiles } = await import('../src/backup.js');
  const names = collectStateFiles(dataDir).map((f) => f.name);
  assert.ok(names.includes('tenants.json'));
  assert.ok(names.includes(`tenants/${eu}/settings.json`), names.join(', '));
});

test('removing a tenant needs its name typed; its people lose access, its files are kept', async () => {
  assert.equal((await admin('DELETE', `/api/tenants/${eu}`, { confirm: 'wrong' })).status, 400);
  assert.equal((await admin('DELETE', '/api/tenants/default', { confirm: 'x' })).status, 400);
  const gone = await admin('DELETE', `/api/tenants/${eu}`, { confirm: 'Acme EU' });
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.ok(!gone.body.tenants.some((t) => t.id === eu));
  const me = await local('GET', '/api/me');
  assert.equal(me.status, 403);
  assert.match(me.body.error, /not in any Checkmarx One tenant/);
  assert.ok(fs.readdirSync(path.join(dataDir, 'tenants')).some((name) => name.startsWith(`${eu}.removed-`)));
});
