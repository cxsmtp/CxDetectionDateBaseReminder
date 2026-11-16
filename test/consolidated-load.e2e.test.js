// Labs → Consolidated view loads the tenants itself (from MZ-01.01.14), for real with three tenants against the mock
// Checkmarx One: on opening, every tenant never loaded is read with its own stored connection (findings and credits),
// with progress the page follows; Refresh reads again; a tenant with no connection says why; a narrowed Workbench load
// does not replace a tenant's figures; and loading needs Fetch findings as well as the view.
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidated-load-'));
const dataDir = path.join(dir, 'data');
const keyFile = path.join(dir, 'issuer.pem');
const script = (...args) => execFileSync(process.execPath, ['scripts/activation.mjs', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const publicKey = script('keygen', keyFile).split('\n').pop();
let log = '';
let eu = '';
let us = '';
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
  // Cara works in every tenant (a User).
  const made = await admin('POST', '/api/iam/users', { email: 'cara@acme.io', role: 'user', password: FIRST_PASSWORD });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  caraId = made.body.users.find((u) => u.email === 'cara@acme.io').id;
  // Acme US is a tenant nobody has connected to Checkmarx One.
  const third = await admin('POST', '/api/tenants', { name: 'Acme US' });
  assert.equal(third.status, 201, JSON.stringify(third.body));
  us = third.body.added.id;
  assert.equal((await admin('PUT', `/api/iam/users/${caraId}/tenants`, { tenants: ['default', eu, us] })).status, 200);
  await signIn(cara, 'cara@acme.io');
  // Acme EU is connected to Checkmarx One with a key of its own.
  assert.equal((await admin('POST', '/api/me/tenant', { id: eu })).status, 200);
  const connected = await admin('POST', '/api/integration/cxone', { apiKey: KEY });
  assert.equal(connected.status, 200, JSON.stringify(connected.body));
  assert.equal((await admin('POST', '/api/me/tenant', { id: 'default' })).status, 200);
  // The view is unlocked, and Cara may see it.
  assert.equal((await admin('POST', '/api/activation', { code: script('feature', keyFile, 'Acme', 'consolidated', 'on') })).status, 200);
  assert.equal((await admin('PUT', `/api/iam/users/${caraId}/consolidated`, { on: true })).status, 200);
  // Her role (User) holds Labs: Consolidated view, as an Admin ticks it for the roles that are to use it.
  const role = (await admin('GET', '/api/iam')).body.roles.find((r) => r.id === 'user');
  assert.equal((await admin('PUT', '/api/iam/roles/user', { name: role.name, description: role.description, permissions: [...role.permissions, 'labs.consolidated'] })).status, 200);
});

test.after(() => {
  for (const child of children) child.kill();
});


/** Wait until no tenant of Cara's is being loaded; the last answer of GET /api/consolidated/load. */
async function loadsFinished() {
  const end = Date.now() + 30000;
  for (;;) {
    const r = await cara('GET', '/api/consolidated/load');
    assert.equal(r.status, 200, r.raw);
    if (!r.body.tenants.some((t) => t.loading)) return r.body;
    if (Date.now() > end) throw new Error(`still loading: ${r.raw}\n${log.slice(-2000)}`);
    await sleep(150);
  }
}
const tenantOf = (body, id) => body.tenants.find((t) => t.id === id);
const auditOf = async (id) => {
  assert.equal((await admin('POST', '/api/me/tenant', { id })).status, 200);
  const entries = (await admin('GET', '/api/audit?limit=100')).body.entries;
  assert.equal((await admin('POST', '/api/me/tenant', { id: 'default' })).status, 200);
  return entries;
};

test('nothing loaded yet: the view says so, and that this person may load from it', async () => {
  const r = await cara('GET', '/api/consolidated');
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.canLoad, true);
  assert.ok(r.body.tenants.every((t) => t.health === 'notLoaded' && t.loading === null), r.raw.slice(0, 800));
  const status = (await cara('GET', '/api/consolidated/load')).body;
  assert.equal(status.canLoad, true);
  assert.deepEqual(status.tenants.map((t) => [t.health, t.loading]), [['notLoaded', null], ['notLoaded', null], ['notLoaded', null]]);
});

test('opening the view loads every tenant never loaded: each with its own connection, findings and credits, with its progress', async () => {
  const before = await stats();
  const asked = await cara('POST', '/api/consolidated/load', { only: 'missing' });
  assert.equal(asked.status, 202, asked.raw);
  assert.deepEqual([...asked.body.started].sort(), ['default', eu, us].sort());
  assert.deepEqual(asked.body.skipped, []);
  // Answered at once: the loads go on behind, and the page is told how far each has got.
  const during = (await cara('GET', '/api/consolidated/load')).body;
  assert.ok(during.tenants.every((t) => !t.loading || (typeof t.loading.done === 'number' && 'total' in t.loading && typeof t.loading.waiting === 'boolean')), JSON.stringify(during));
  // Asked again while they run: none is started twice.
  const again = await cara('POST', '/api/consolidated/load', { only: 'missing' });
  assert.equal(again.status, 202);
  assert.ok(again.body.started.every((id) => !asked.body.started.includes(id) || !tenantOf(during, id)?.loading), 'a tenant being loaded is left to finish');
  await loadsFinished();
  assert.ok(total(await stats()) - total(before) > 0, 'Checkmarx One was read');

  const view = (await cara('GET', '/api/consolidated')).body;
  for (const id of ['default', eu]) {
    const t = tenantOf(view, id);
    assert.deepEqual([t.loaded, t.health, t.projects, t.loading, t.fetchedBy], [true, 'healthy', 9, null, 'cara@acme.io'], JSON.stringify(t).slice(0, 600));
    assert.ok(t.total > 0, 'its open findings are counted');
    assert.ok(t.credits && Number.isFinite(t.credits.available), `its Checkmarx One credits are read with it: ${JSON.stringify(t.credits)}`);
  }
  assert.equal(view.projects.length, 18);
  // The tenant nobody connected says why, and is not a reason for the others to fail.
  const lost = tenantOf(view, us);
  assert.deepEqual([lost.loaded, lost.health], [false, 'failed']);
  assert.match(lost.error.message, /no stored Checkmarx One connection/);
  // Each tenant's own audit log has the read, with who asked and why.
  for (const id of ['default', eu, us]) {
    const reasons = (await auditOf(id)).map((e) => e.reason).join('\n');
    assert.match(reasons, /Findings and credits read for the consolidated view, asked by cara@acme\.io \(on opening the view\)\./, id);
  }
});

test('opened again: tenants loaded within the day are left alone, and one that failed is not tried over and over', async () => {
  const before = await stats();
  const asked = await cara('POST', '/api/consolidated/load', { only: 'missing' });
  assert.equal(asked.status, 202);
  assert.deepEqual(asked.body.started, []);
  assert.deepEqual([...asked.body.skipped].sort(), ['default', eu, us].sort());
  await sleep(200);
  assert.equal(total(await stats()) - total(before), 0, 'no Checkmarx One call');
});

test('Refresh reads a tenant again, on its card or all at once; a tenant that is not this person\'s is never read', async () => {
  const first = tenantOf((await cara('GET', '/api/consolidated/summary')).body, eu).fetchedAt;
  await sleep(20);
  const one = await cara('POST', '/api/consolidated/load', { tenants: [eu, 'someone-elses'] });
  assert.equal(one.status, 202);
  assert.deepEqual(one.body.started, [eu]);
  await loadsFinished();
  const second = tenantOf((await cara('GET', '/api/consolidated/summary')).body, eu).fetchedAt;
  assert.ok(Date.parse(second) > Date.parse(first), `${second} is after ${first}`);
  const all = await cara('POST', '/api/consolidated/load', {});
  assert.deepEqual([...all.body.started].sort(), ['default', eu, us].sort());
  await loadsFinished();
  // Cara leaves Acme US: it is not read for her any more.
  assert.equal((await admin('PUT', `/api/iam/users/${caraId}/tenants`, { tenants: ['default', eu] })).status, 200);
  const fewer = await cara('POST', '/api/consolidated/load', { tenants: [us] });
  assert.deepEqual(fewer.body.started, []);
  assert.deepEqual((await cara('GET', '/api/consolidated/load')).body.tenants.map((t) => t.id).sort(), ['default', eu].sort());
});

test('a Workbench load narrowed to an age, a search or named projects does not replace the tenant\'s figures; a whole one does', async () => {
  const kept = tenantOf((await cara('GET', '/api/consolidated/summary')).body, 'default');
  for (const narrowed of ['detectionPreset=7d', 'vulnerability=SQL%20injection', 'project=p1', 'branches=all']) {
    assert.equal((await admin('GET', `/api/scan?${narrowed}`)).status, 200, narrowed);
    const now = tenantOf((await cara('GET', '/api/consolidated/summary')).body, 'default');
    assert.deepEqual([now.fetchedAt, now.fetchedBy, now.projects, now.total], [kept.fetchedAt, kept.fetchedBy, kept.projects, kept.total], narrowed);
  }
  assert.equal((await admin('GET', '/api/scan')).status, 200);
  const whole = tenantOf((await cara('GET', '/api/consolidated/summary')).body, 'default');
  assert.equal(whole.fetchedBy, 'admin@acme.io');
  assert.ok(Date.parse(whole.fetchedAt) > Date.parse(kept.fetchedAt));
});

test('loading needs Fetch findings as well as the view: without it the view is read as before, and says so', async () => {
  const role = (await admin('GET', '/api/iam')).body.roles.find((r) => r.id === 'user');
  const without = await admin('PUT', '/api/iam/roles/user', { name: role.name, description: role.description, permissions: role.permissions.filter((p) => p !== 'findings.fetch') });
  assert.equal(without.status, 200, without.raw);
  const before = await stats();
  assert.equal((await cara('POST', '/api/consolidated/load', {})).status, 403);
  const view = await cara('GET', '/api/consolidated');
  assert.equal(view.status, 200);
  assert.equal(view.body.canLoad, false);
  assert.equal((await cara('GET', '/api/consolidated/load')).body.canLoad, false);
  assert.equal(total(await stats()) - total(before), 0, 'no Checkmarx One call');
  // And nobody who is not signed in, or has not been given the view.
  assert.equal((await fetch(`${BASE}/api/consolidated/load`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await admin('POST', '/api/consolidated/load', {})).status, 403, 'not even an Admin without the grant');
});
