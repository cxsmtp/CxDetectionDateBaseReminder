// Labs → Consolidated view (Beta), for real with two tenants against the mock Checkmarx One: behind its activation
// code and a per-person grant no role holds (not even Admin); it reads each tenant's own memory (no Checkmarx One
// call, no write), names the tenant on every row, and writes a line to each tenant's audit log per visit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';
import { FIRST_PASSWORD, NEXT_PASSWORD, mockApiKey } from './test-credentials.js';

const MOCK_PORT = await freePort();
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const KEY = mockApiKey({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' });
const children = [];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidated-e2e-'));
const dataDir = path.join(dir, 'data');
const keyFile = path.join(dir, 'issuer.pem');
const script = (...args) => execFileSync(process.execPath, ['scripts/activation.mjs', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const publicKey = script('keygen', keyFile).split('\n').pop();
let log = '';
let eu = '';
let caraId = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function browser() {
  let cookie = '';
  return async (method, url, body) => {
    const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const raw = await r.text();
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {}
    return { status: r.status, body: json, raw };
  };
}
const admin = browser();
const cara = browser();
const analyst = browser();
const stats = async () => (await (await fetch(`${MOCK}/__stats`)).json()).counts;
const total = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

async function signIn(b, email) {
  await b('POST', '/api/session/password', { email, password: FIRST_PASSWORD });
  assert.equal((await b('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD })).status, 200);
}

/**
 * Every file in the state folder and when it last changed, but the audit logs (each visit is written there) and the
 * server-wide index of who is signed in (refreshed every minute whatever is asked).
 */
function files(root = dataDir, out = new Map()) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'audit' && entry.name !== 'sessions') files(full, out);
    } else out.set(path.relative(dataDir, full), `${fs.statSync(full).mtimeMs}:${fs.statSync(full).size}`);
  }
  return out;
}

test.before(async () => {
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '9', RISKS: '8', FAILED_SCANS: '1' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HTTPS: 'off', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0', SMTP_HOST: '',
      CX_API_KEY: KEY, CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme', MZ_ACTIVATION_TEST_KEY: publicKey,
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD,
      GITHUB_TOKEN: '', GITLAB_TOKEN: '', AZURE_DEVOPS_TOKEN: '', BITBUCKET_TOKEN: '',
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
  // Two tenants: the first (Checkmarx One "acme"), and Acme EU with an integration of its own.
  assert.equal((await admin('POST', '/api/activation', { code: script('issue', keyFile, 'Acme Bank', '3') })).status, 200);
  assert.equal((await admin('POST', '/api/tenants/enabled', { on: true })).status, 200);
  const added = await admin('POST', '/api/tenants', { name: 'Acme EU' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  eu = added.body.added.id;
  // People: Cara works in both tenants (a User); Ana is a Security Analyst (manages people, is not an Admin).
  const made = await admin('POST', '/api/iam/users', { email: 'cara@acme.io', role: 'user', password: FIRST_PASSWORD });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  caraId = made.body.users.find((u) => u.email === 'cara@acme.io').id;
  assert.equal((await admin('PUT', `/api/iam/users/${caraId}/tenants`, { tenants: ['default', eu] })).status, 200);
  assert.equal((await admin('POST', '/api/iam/users', { email: 'ana@acme.io', role: 'analyst', password: FIRST_PASSWORD })).status, 201);
  await signIn(cara, 'cara@acme.io');
  await signIn(analyst, 'ana@acme.io');
  // Acme EU is connected to Checkmarx One with a key of its own.
  assert.equal((await admin('POST', '/api/me/tenant', { id: eu })).status, 200);
  const connected = await admin('POST', '/api/integration/cxone', { apiKey: KEY });
  assert.equal(connected.status, 200, JSON.stringify(connected.body));
  assert.equal((await admin('POST', '/api/me/tenant', { id: 'default' })).status, 200);
});

/** Each tenant fetched once on the Workbench (by the Admin): what the consolidated view then reads. */
async function fetchBoth() {
  assert.equal((await admin('GET', '/api/scan')).status, 200);
  assert.equal((await admin('POST', '/api/me/tenant', { id: eu })).status, 200);
  const euFetch = await admin('GET', '/api/scan');
  assert.equal(euFetch.status, 200, JSON.stringify(euFetch.body).slice(0, 300));
  assert.equal((await admin('POST', '/api/me/tenant', { id: 'default' })).status, 200);
}

test.after(() => {
  for (const child of children) child.kill();
});

test('held back until its activation code is applied: 403 without the feature, even with the grant\'s permission', async () => {
  for (const url of ['/api/consolidated', '/api/consolidated/summary', '/api/consolidated/projects', '/api/consolidated/status-board']) {
    const r = await admin('GET', url);
    assert.equal(r.status, 403, url);
    assert.equal(r.body.locked, true);
  }
  assert.equal((await admin('PUT', `/api/iam/users/${caraId}/consolidated`, { on: true })).status, 403, 'nothing to grant yet');
  const applied = await admin('POST', '/api/activation', { code: script('feature', keyFile, 'Acme', 'consolidated', 'on') });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.match(applied.body.applied, /Consolidated view \(Labs\) turned on/);
});

test('in no role, not even Admin: 403 without the grant, and no tenant named', async () => {
  const me = (await admin('GET', '/api/me')).body;
  assert.ok(!me.permissions.includes('consolidated.view'));
  assert.ok(!me.permissions.includes('feature.consolidated'), 'not even Beta access opens it');
  const roles = (await admin('GET', '/api/iam')).body.roles;
  assert.ok(roles.every((r) => !r.permissions.includes('consolidated.view')), 'no role holds it');
  for (const b of [admin, cara, analyst]) {
    for (const url of ['/api/consolidated', '/api/consolidated/summary', '/api/consolidated/projects', '/api/consolidated/status-board']) {
      const r = await b('GET', url);
      assert.equal(r.status, 403, url);
      assert.doesNotMatch(r.raw, /Acme EU|"acme"/, 'no tenant is named to someone without the grant');
    }
  }
});

test('an Admin ticks it for one person (audited); a Security Analyst cannot', async () => {
  await fetchBoth();
  assert.equal((await analyst('PUT', `/api/iam/users/${caraId}/consolidated`, { on: true })).status, 403);
  const view = await admin('GET', '/api/iam');
  assert.equal(view.body.consolidatedGrant, true);
  const granted = await admin('PUT', `/api/iam/users/${caraId}/consolidated`, { on: true });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.equal(granted.body.users.find((u) => u.id === caraId).consolidated, true);
  const me = (await cara('GET', '/api/me')).body;
  assert.ok(me.permissions.includes('consolidated.view'));
  assert.ok(me.permissions.includes('feature.consolidated'));
  // The switcher knows when each tenant last fetched.
  assert.deepEqual(me.tenancy.tenants.map((t) => Boolean(t.fetchedAt)), [true, true]);
  // Cara's own role is unchanged, and the Admin still manages her.
  assert.equal(granted.body.users.find((u) => u.id === caraId).role, 'user');
  assert.equal(granted.body.users.find((u) => u.id === caraId).canManage, true);
  const reasons = (await admin('GET', '/api/audit?limit=50')).body.entries.map((e) => e.reason).join('\n');
  assert.match(reasons, /cara@acme\.io may now see the consolidated view/);
});

test('both tenants, each row naming its tenant; every call in each tenant\'s audit log; no Checkmarx One call, no write', async () => {
  // What earlier requests wrote is on disk first (the activity log half a second after, known addresses a second after).
  await sleep(1600);
  const before = await stats();
  const filesBefore = files();
  const r = await cara('GET', '/api/consolidated');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (const url of ['/api/consolidated/summary', '/api/consolidated/projects', '/api/consolidated/status-board']) assert.equal((await cara('GET', url)).status, 200, url);
  assert.equal(total(await stats()) - total(before), 0, 'no Checkmarx One call');
  await sleep(300);
  const filesAfter = files();
  const changed = [...filesAfter].filter(([f, v]) => filesBefore.get(f) !== v).map(([f]) => f);
  assert.deepEqual(changed, [], `nothing written but the audit logs: ${changed.join(', ')}`);

  const { tenants, projects, figures } = r.body;
  assert.deepEqual(tenants.map((t) => t.name).sort(), ['Acme EU', 'acme']);
  assert.ok(tenants.every((t) => t.loaded && t.health === 'healthy' && t.projects === 9), JSON.stringify(tenants).slice(0, 1500));
  assert.equal(figures.tenants, 2);
  assert.equal(figures.projects, 18);
  assert.equal(projects.length, 18);
  assert.ok(projects.every((p) => p.tenantId && p.tenantName && Number.isInteger(p.colour)), 'every row names its tenant');
  assert.deepEqual([...new Set(projects.map((p) => p.tenantName))].sort(), ['Acme EU', 'acme']);
  // A tenant keeps its colour.
  const colours = Object.fromEntries(tenants.map((t) => [t.id, t.colour]));
  assert.ok(projects.every((p) => p.colour === colours[p.tenantId]));
  // The status board feed across tenants: the failed scans of each.
  const board = (await cara('GET', '/api/consolidated/status-board')).body;
  assert.deepEqual(board.rows.filter((x) => x.failed).map((x) => `${x.tenantName}:${x.projectId}`).sort(), ['Acme EU:p3', 'acme:p3'], 'project 3 failed, in each tenant');

  for (const id of ['default', eu]) {
    assert.equal((await admin('POST', '/api/me/tenant', { id })).status, 200);
    const entries = (await admin('GET', '/api/audit?limit=100')).body.entries.filter((e) => /Viewed in the consolidated view by cara@acme\.io/.test(e.reason));
    assert.ok(entries.length >= 4, `${id}: ${entries.length} visits recorded`);
  }
  assert.equal((await admin('POST', '/api/me/tenant', { id: 'default' })).status, 200);
});

test('a tenant never fetched says so: Not loaded', async () => {
  const us = await admin('POST', '/api/tenants', { name: 'Acme US' });
  assert.equal(us.status, 201);
  assert.equal((await admin('PUT', `/api/iam/users/${caraId}/tenants`, { tenants: ['default', eu, us.body.added.id] })).status, 200);
  const r = await cara('GET', '/api/consolidated/summary');
  const t = r.body.tenants.find((x) => x.name === 'Acme US');
  assert.equal(t.health, 'notLoaded');
  assert.equal(t.projects, null);
});

test('turned off again: 403 for the person granted, and the grant is kept for later', async () => {
  assert.equal((await admin('POST', '/api/activation', { code: script('feature', keyFile, 'Acme', 'consolidated', 'off') })).status, 200);
  const r = await cara('GET', '/api/consolidated');
  assert.equal(r.status, 403);
  assert.equal(r.body.locked, true);
  assert.ok(!(await cara('GET', '/api/me')).body.permissions.includes('feature.consolidated'));
});
