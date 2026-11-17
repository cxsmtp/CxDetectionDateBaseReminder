// Primary branches and the Workbench's branch choices (from MZ-01.01.20), for real against the mock Checkmarx One,
// which also answers as GitHub for each project's repository: what each repository protects is read; a project with
// no primary branch is loaded on its protected branch, in the order an Admin can change; one branch (or a pattern)
// for every project that has it, the others on their primary branch; a branch chosen for one project; and a primary
// branch written to Checkmarx One by an Admin only.
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
const KEY = mockApiKey({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' });
const children = [];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'primary-branches-'));
let log = '';
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
const analyst = browser();
const stats = async () => (await (await fetch(`${MOCK}/__stats`)).json()).counts;

async function signIn(b, email) {
  await b('POST', '/api/session/password', { email, password: FIRST_PASSWORD });
  assert.equal((await b('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD })).status, 200);
}
const rows = (r) => Object.fromEntries(r.body.projects.map((p) => [p.projectId, p]));
const how = (row) => [row?.branch, row?.branchHow];

test.before(async () => {
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '0', PROJECTS: '16', RISKS: '10', BRANCHES: '1', REPOS: '1' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HTTPS: 'off', DATA_DIR: path.join(dir, 'data'), ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0', BACKUP_ENCRYPTION: 'off', SMTP_HOST: '', CX_API_KEY: KEY, CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme', ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD, GITHUB_API_URL: `${MOCK}/api/v3`, GITHUB_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  children.push(server);
  for (let i = 0; i < 150 && !/Successfully authenticated/.test(log); i++) await sleep(100);
  await signIn(admin, 'admin@acme.io');
  assert.equal((await admin('POST', '/api/iam/users', { email: 'sam@acme.io', role: 'analyst', password: FIRST_PASSWORD })).status, 201);
  await signIn(analyst, 'sam@acme.io');
});

test.after(() => {
  for (const child of children) child.kill();
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch {}
});

test('before any read, a project with no primary branch is loaded as before: main or master, else its latest scan', async () => {
  const r = await admin('GET', '/api/scan');
  assert.equal(r.status, 200, r.raw.slice(0, 300));
  const row = rows(r);
  assert.deepEqual(how(row.p0), ['main', 'primary']);
  assert.deepEqual(how(row.p3), ['main', 'guessed']);
  assert.deepEqual(how(row.p7), ['trunk', 'latest']);
  assert.equal(row.p0.mainBranch, 'main');
});

test('reading the projects finds what each repository protects, and suggests a primary branch for those with none', async () => {
  assert.equal((await analyst('POST', '/api/branches/read')).status, 403, 'reading needs the Checkmarx One permission');
  assert.equal((await admin('POST', '/api/branches/read')).status, 202);
  let view;
  for (let i = 0; i < 200; i++) {
    view = (await admin('GET', '/api/branches')).body;
    if (view.job.state === 'done') break;
    assert.notEqual(view.job.state, 'failed', view.job.error);
    await sleep(100);
  }
  assert.equal(view.job.state, 'done');
  assert.ok((await stats())['github-branches'] >= 16, 'every repository asked');
  const p = Object.fromEntries(view.projects.map((x) => [x.id, x]));
  assert.equal(p.p3.provider, 'github');
  assert.deepEqual(p.p3.protectedNames, ['main', 'develop']);
  assert.deepEqual([p.p3.suggestion.branch, p.p3.suggestion.why, p.p3.state], ['main', 'protected', 'suggested']);
  assert.deepEqual([p.p7.suggestion.branch, p.p7.suggestion.why], ['trunk', 'protected']);
  assert.equal(p.p0.state, 'set');
  assert.ok(p.p3.options.find((o) => o.name === 'main').protected);
  assert.deepEqual(view.protectedCounts.map((c) => c.name).slice(0, 2), ['main', 'master']);
  assert.equal(view.order[0], 'main');
});

test('a project with no primary branch is then loaded on its protected branch', async () => {
  const row = rows(await admin('GET', '/api/scan'));
  assert.deepEqual(how(row.p7), ['trunk', 'protected']);
  assert.deepEqual(how(row.p3), ['main', 'protected']);
  assert.deepEqual(how(row.p0), ['main', 'primary'], 'a primary branch set in Checkmarx One still comes first');
});

test('one branch for every project: those that have it are loaded on it, the others on their primary branch', async () => {
  // Only the projects whose primary branch is develop (p2, p10, …) have scans on it.
  for (const branch of ['develop', 'dev*']) {
    const r = await admin('GET', `/api/scan?branches=one&branch=${encodeURIComponent(branch)}`);
    assert.equal(r.status, 200, r.raw.slice(0, 300));
    const row = rows(r);
    assert.deepEqual(how(row.p2), ['develop', 'chosen'], branch);
    assert.deepEqual(how(row.p1), ['master', 'primary']);
    assert.equal(row.p1.branchWanted, branch);
    assert.deepEqual(how(row.p7), ['trunk', 'protected'], 'no develop scan: its protected branch');
    assert.equal((await admin('GET', '/api/scan/last')).body.request.branch, branch);
  }
  assert.equal((await admin('GET', '/api/scan?branches=one&branch=%3Cscript%3E')).status, 400);
});

test('a branch chosen for one project is loaded for it alone', async () => {
  const r = await admin('GET', `/api/scan?branchFor=${encodeURIComponent(JSON.stringify({ p0: 'feature/login', p1: 'nope/never' }))}`);
  const row = rows(r);
  assert.deepEqual(how(row.p0), ['feature/login', 'chosen']);
  assert.deepEqual(how(row.p2), ['develop', 'primary']);
  assert.ok(!row.p1, 'a branch never scanned has nothing to load');
  assert.equal(r.body.leftOut.noPrimaryScan, 3);
  assert.equal((await admin('GET', '/api/scan?branchFor=%7Bnot-json')).status, 400);
});

test("the Workbench's list for one project: protected branches first, then the others scanned", async () => {
  const r = await analyst('GET', '/api/branches/project?id=p4');
  assert.equal(r.status, 200, r.raw);
  assert.deepEqual(r.body.protected.map((b) => b.name), ['main', 'develop']);
  assert.ok(r.body.protected[0].primary);
  assert.ok(r.body.others.some((b) => b.name === 'feature/login' && b.lastScanAt));
  assert.deepEqual(r.body.host, { label: 'GitHub', repo: 'acme/project-4' });
});

test('only an Admin changes the order, and the suggestions follow it', async () => {
  assert.equal((await analyst('PUT', '/api/branches/order', { order: ['develop'] })).status, 403);
  const changed = await admin('PUT', '/api/branches/order', { order: ['develop', 'main', 'bad branch!', 'release/*'] });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body.order, ['develop', 'main', 'release/*']);
  assert.equal(changed.body.projects.find((p) => p.id === 'p3').suggestion.branch, 'develop');
  const reset = await admin('PUT', '/api/branches/order', { reset: true });
  assert.equal(reset.body.custom, false);
  assert.equal(reset.body.projects.find((p) => p.id === 'p3').suggestion.branch, 'main');
});

test('an Admin writes a primary branch to Checkmarx One; nobody else can', async () => {
  assert.equal((await analyst('POST', '/api/branches/primary', { projects: [{ id: 'p3', branch: 'main' }] })).status, 403);
  assert.equal((await admin('POST', '/api/branches/primary', { projects: [{ id: 'p3', branch: 'release/*' }] })).status, 400, 'a pattern is not a branch');
  const before = (await stats())['project-update'] ?? 0;
  const r = await admin('POST', '/api/branches/primary', { projects: [{ id: 'p3', branch: 'main' }, { id: 'p7', branch: 'trunk' }] });
  assert.equal(r.status, 200, r.raw);
  assert.ok(r.body.results.every((x) => x.ok), JSON.stringify(r.body.results));
  assert.equal((await stats())['project-update'], before + 2);
  assert.equal(r.body.projects.find((p) => p.id === 'p3').state, 'set');
  const row = rows(await admin('GET', '/api/scan'));
  assert.deepEqual(how(row.p3), ['main', 'primary']);
  assert.deepEqual(how(row.p7), ['trunk', 'primary']);
  const entries = (await admin('GET', '/api/audit?limit=50')).body.entries;
  assert.ok(entries.some((e) => /Primary branch set in Checkmarx One: none → main/.test(e.reason)));
});
