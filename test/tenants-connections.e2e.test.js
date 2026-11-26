// Thirty tenants, each on its own Checkmarx One (from MZ-01.01.21). A server is usually started with the first
// tenant's endpoints in its environment (CX_BASE_URL, CX_IAM_URL, CX_TENANT). Until MZ-01.01.20 those filled in
// the endpoints of every tenant's key, so a tenant added later and connected with a key alone read the first
// tenant's Checkmarx One. Here the first tenant is on mock A ("acme", 3 projects) and the others connect with a key
// for mock B ("beta", 7 projects): each must read its own, before and after a restart, and two tenants on the
// same Checkmarx One tenant are told so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';
import { FIRST_PASSWORD, NEXT_PASSWORD, mockApiKey } from './test-credentials.js';

const TENANTS = 30;
const [PORT_A, PORT_B, PORT] = [await freePort(), await freePort(), await freePort()];
const A = `http://127.0.0.1:${PORT_A}`;
const B = `http://127.0.0.1:${PORT_B}`;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY_A = mockApiKey({ iss: `${A}/auth/realms/acme`, azp: 'integration' });
const KEY_B = mockApiKey({ iss: `${B}/auth/realms/beta`, azp: 'integration' });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenants-connections-'));
const keyFile = path.join(dir, 'issuer.pem');
const script = (...args) => execFileSync(process.execPath, ['scripts/activation.mjs', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const publicKey = script('keygen', keyFile).split('\n').pop();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
let server = null;
let log = '';
let cookie = '';
const ids = ['default'];

const env = {
  ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HTTPS: 'off', DATA_DIR: path.join(dir, 'data'), ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0', BACKUP_ENCRYPTION: 'off', SMTP_HOST: '',
  // The first tenant's Checkmarx One, pinned in the environment as a real server is started.
  CX_API_KEY: KEY_A, CX_BASE_URL: A, CX_IAM_URL: A, CX_TENANT: 'acme', ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD, MZ_ACTIVATION_TEST_KEY: publicKey,
};

async function start() {
  log = '';
  server = spawn(process.execPath, ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  children.push(server);
  for (let i = 0; i < 200 && !/Successfully authenticated/.test(log); i++) await sleep(100);
}
async function api(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const raw = await r.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {}
  return { status: r.status, body: json, raw };
}
const projectsAsked = async (mock) => (await (await fetch(`${mock}/__stats`)).json()).counts?.projects ?? 0;

/** Load the Workbench in every tenant: each must read its own Checkmarx One, and only it. */
async function loadEveryTenant() {
  for (const id of ids) {
    assert.equal((await api('POST', '/api/me/tenant', { id })).status, 200);
    const [a0, b0] = [await projectsAsked(A), await projectsAsked(B)];
    const r = await api('GET', '/api/scan');
    assert.equal(r.status, 200, `${id}: ${r.raw.slice(0, 300)}`);
    const [a1, b1] = [await projectsAsked(A), await projectsAsked(B)];
    if (id === 'default') {
      assert.equal(r.body.totals.projects, 3, 'the first tenant reads acme');
      assert.equal(b1 - b0, 0, 'and never beta');
    } else {
      assert.equal(r.body.totals.projects, 7, `${id} reads beta, its own`);
      assert.equal(a1 - a0, 0, `${id} never asks the first tenant's Checkmarx One`);
    }
  }
}

test.before(async () => {
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(PORT_A), LAT: '0', PROJECTS: '3', RISKS: '2' }, stdio: 'ignore' }));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(PORT_B), LAT: '0', PROJECTS: '7', RISKS: '2' }, stdio: 'ignore' }));
  await start();
  await api('POST', '/api/session/password', { email: 'admin@acme.io', password: FIRST_PASSWORD });
  assert.equal((await api('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD })).status, 200);
});

test.after(() => {
  for (const child of children) child.kill();
});

test(`${TENANTS} tenants, each connected with a key alone, read their own Checkmarx One`, async () => {
  assert.equal((await api('POST', '/api/activation', { code: script('issue', keyFile, 'Acme Bank', String(TENANTS)) })).status, 200);
  assert.equal((await api('POST', '/api/tenants/enabled', { on: true })).status, 200);
  for (let n = 2; n <= TENANTS; n++) {
    const added = await api('POST', '/api/tenants', { name: `Tenant ${n}` });
    assert.equal(added.status, 201, added.raw);
    ids.push(added.body.added.id);
  }
  assert.equal((await api('POST', '/api/tenants', { name: 'One too many' })).status, 409, `up to ${TENANTS}, as the code says`);
  for (const id of ids.slice(1)) {
    await api('POST', '/api/me/tenant', { id });
    const connected = await api('POST', '/api/integration/cxone', { apiKey: KEY_B });
    assert.equal(connected.status, 200, connected.raw);
    assert.equal(connected.body.connection.tenant, 'beta', `${id} connects where its key says, not to the first tenant's`);
    assert.equal(connected.body.connection.baseUrl, B);
  }
  await loadEveryTenant();
});

test('two tenants on the same Checkmarx One tenant are told so; the first one is not', async () => {
  await api('POST', '/api/me/tenant', { id: ids[1] });
  const shared = (await api('GET', '/api/integration')).body.sharedWith;
  assert.equal(shared.length, TENANTS - 2, 'every other tenant on beta');
  assert.ok(shared.includes('Tenant 3'));
  await api('POST', '/api/me/tenant', { id: 'default' });
  assert.deepEqual((await api('GET', '/api/integration')).body.sharedWith, []);
});

test('after a restart, every tenant reconnects with its own stored key, to its own Checkmarx One', async () => {
  server.kill();
  await sleep(800);
  await start();
  cookie = '';
  assert.equal((await api('POST', '/api/session/password', { email: 'admin@acme.io', password: NEXT_PASSWORD })).status, 201);
  // Each tenant reconnects in the background at start-up (a one-project read of its own Checkmarx One): measured
  // once they have, so a tenant's count is its own load only.
  let before = -1;
  for (let i = 0; i < 100; i++) {
    const now = await projectsAsked(B);
    if (now === before) break;
    before = now;
    await sleep(300);
  }
  await loadEveryTenant();
});

test("a tenant from before the fix: what it read from the first tenant's Checkmarx One is set aside once, and said", async () => {
  const dataDir = path.join(dir, 'data');
  const [old, recent] = [ids[1], ids[2]];
  const folder = (id) => path.join(dataDir, 'tenants', id);
  server.kill();
  await sleep(800);
  // As a tenant added before MZ-01.01.21 left it: never checked, with what it had read (the first tenant's projects).
  fs.rmSync(path.join(folder(old), 'cxone-origin.json'));
  for (const id of [old, recent]) {
    fs.writeFileSync(path.join(folder(id), 'finding-journal.json'), JSON.stringify({ version: 1, entries: [{ p: 'p0', n: 'Project 0 of acme', r: 'r1', s: 'HIGH', o: '2026-11-01T00:00:00.000Z' }] }));
    fs.writeFileSync(path.join(folder(id), 'branch-settings.json'), JSON.stringify({ version: 1, order: null, read: { at: '2026-11-01T00:00:00.000Z', projects: [{ id: 'p0', name: 'Project 0 of acme' }] } }));
  }
  await start();
  cookie = '';
  assert.equal((await api('POST', '/api/session/password', { email: 'admin@acme.io', password: NEXT_PASSWORD })).status, 201);
  const aside = fs.readdirSync(folder(old)).find((n) => n.startsWith('set-aside-'));
  assert.ok(aside, 'a set-aside folder');
  assert.ok(fs.existsSync(path.join(folder(old), aside, 'finding-journal.json')), 'the Impact history moved aside whole');
  assert.ok(!fs.existsSync(path.join(folder(old), 'finding-journal.json')));
  const branches = JSON.parse(fs.readFileSync(path.join(folder(old), 'branch-settings.json'), 'utf8'));
  assert.equal(branches.read, null, 'only the last read is taken out of a file that holds choices too');
  const origin = JSON.parse(fs.readFileSync(path.join(folder(old), 'cxone-origin.json'), 'utf8'));
  assert.equal(origin.setAside, true);
  assert.deepEqual([origin.from.tenant, origin.connects.tenant], ['acme', 'beta']);
  // A tenant added after the fix keeps what it read: it never took the first tenant's endpoints.
  assert.ok(fs.existsSync(path.join(folder(recent), 'finding-journal.json')));
  assert.ok(!fs.readdirSync(folder(recent)).some((n) => n.startsWith('set-aside-')));
  // Said in the tenant's own audit log; its Workbench reads its own Checkmarx One.
  assert.equal((await api('POST', '/api/me/tenant', { id: old })).status, 200);
  // Written once every tenant has reconnected at start-up.
  let reasons = '';
  for (let i = 0; i < 100 && !/now connects to its own/.test(reasons); i++) {
    reasons = (await api('GET', '/api/audit?limit=50')).body.entries.map((e) => e.reason).join('\n');
    await sleep(100);
  }
  assert.match(reasons, /connected to the first tenant's Checkmarx One \(acme\).*now connects to its own \(beta\)/);
  assert.equal((await api('GET', '/api/scan')).body.totals.projects, 7);
  // Once: the next start leaves it as it is.
  server.kill();
  await sleep(800);
  await start();
  assert.equal(fs.readdirSync(folder(old)).filter((n) => n.startsWith('set-aside-')).length, 1);
});

/** A second browser: someone signed in with their own Checkmarx One API key (made in the first tenant's). */
let keyCookie = '';
async function keyApi(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(keyCookie ? { Cookie: keyCookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) keyCookie = set.split(';')[0];
  const raw = await r.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {}
  return { status: r.status, body: json, raw };
}

test("signed in with a key of the first tenant's, another tenant still reads only its own Checkmarx One", async () => {
  // Wait for every tenant to have reconnected after the restarts above.
  for (let i = 0, before = -1; i < 100; i++) {
    const now = await projectsAsked(B);
    if (now === before) break;
    before = now;
    await sleep(300);
  }
  const personal = mockApiKey({ iss: `${A}/auth/realms/acme`, email: 'admin@acme.io', azp: 'admin-key' });
  assert.equal((await keyApi('POST', '/api/session', { apiKey: personal })).status, 201);
  for (const id of ['default', ids.at(-1)]) {
    assert.equal((await keyApi('POST', '/api/me/tenant', { id })).status, 200);
    const [a0, b0] = [await projectsAsked(A), await projectsAsked(B)];
    const r = await keyApi('GET', '/api/scan');
    const [a1, b1] = [await projectsAsked(A), await projectsAsked(B)];
    assert.equal(r.status, 200, r.raw.slice(0, 300));
    if (id === 'default') assert.deepEqual([r.body.totals.projects, b1 - b0], [3, 0], 'the first tenant, with the key itself');
    else assert.deepEqual([r.body.totals.projects, a1 - a0], [7, 0], `${id}: its own Checkmarx One, never the key's`);
    // The connection shown at the top of the page is the tenant's.
    assert.equal((await keyApi('GET', '/api/session')).body.connection.tenant, id === 'default' ? 'acme' : 'beta');
  }
  // "The key you signed in with" never connects another tenant: there it is no key at all.
  assert.equal((await keyApi('POST', '/api/integration/cxone', {})).status, 400);
});

test("no other tenant connects to the first tenant's Checkmarx One: refused when connecting, not used when stored", async () => {
  const target = ids.at(-2);
  await api('POST', '/api/me/tenant', { id: target });
  const refused = await api('POST', '/api/integration/cxone', { apiKey: KEY_A });
  assert.equal(refused.status, 409, refused.raw);
  assert.match(refused.body.error, /first tenant's Checkmarx One/);
  assert.equal((await api('GET', '/api/integration')).body.connection.tenant, 'beta', 'its own connection stays');

  // As MZ-01.01.21 could leave it: the first tenant's key stored in another tenant, checked only for the endpoints.
  const folder = path.join(dir, 'data', 'tenants', target);
  server.kill();
  await sleep(800);
  const settingsFile = path.join(folder, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, automationApiKey: KEY_A, integrationOverrides: {} }));
  fs.writeFileSync(path.join(folder, 'cxone-origin.json'), JSON.stringify({ checkedAt: '2026-11-24T00:00:00.000Z', setAside: false }));
  fs.writeFileSync(path.join(folder, 'finding-journal.json'), JSON.stringify({ version: 1, entries: [{ p: 'p0', n: 'Project 0 of acme', r: 'r1', s: 'HIGH', o: '2026-11-01T00:00:00.000Z' }] }));
  await start();
  cookie = '';
  assert.equal((await api('POST', '/api/session/password', { email: 'admin@acme.io', password: NEXT_PASSWORD })).status, 201);
  await api('POST', '/api/me/tenant', { id: target });
  const [a0] = [await projectsAsked(A)];
  const r = await api('GET', '/api/scan');
  assert.equal(r.status, 503, `not connected: never the first tenant's data: ${r.raw.slice(0, 300)}\n${log.slice(-2500)}`);
  assert.equal((await projectsAsked(A)) - a0, 0);
  const status = (await api('GET', '/api/integration')).body;
  assert.equal(status.connected, false);
  assert.match(status.refused, /first tenant's Checkmarx One/);
  assert.ok(fs.readdirSync(folder).some((n) => n.startsWith('set-aside-')), 'what it read is set aside');
  assert.ok(!fs.existsSync(path.join(folder, 'finding-journal.json')));
  let reasons = '';
  for (let i = 0; i < 100 && !/no longer used here/.test(reasons); i++) {
    reasons = (await api('GET', '/api/audit?limit=50')).body.entries.map((e) => e.reason).join('\n');
    await sleep(100);
  }
  assert.match(reasons, /stored Checkmarx One key is for acme, the first tenant's Checkmarx One: it is no longer used here/);
  // Its Admin connects it with its own key: it reads its own again.
  assert.equal((await api('POST', '/api/integration/cxone', { apiKey: KEY_B })).status, 200);
  assert.equal((await api('GET', '/api/scan')).body.totals.projects, 7);
});
