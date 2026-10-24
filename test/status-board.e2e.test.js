// Labs → Status board (Beta), for real against the mock Checkmarx One: held back until its activation code is applied,
// then for whoever may load findings; built from the Workbench's fetch (engines, applications, failed scans), never a
// Checkmarx One call per page view; the side panel lists a project's last scans.
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
const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-key-'));
const script = (...args) => execFileSync(process.execPath, ['scripts/activation.mjs', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const publicKey = script('keygen', path.join(keyDir, 'issuer.pem')).split('\n').pop();
let log = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const user = browser();
const reader = browser();
const stats = async () => (await (await fetch(`${MOCK}/__stats`)).json()).counts;
const total = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

async function signIn(b, email) {
  await b('POST', '/api/session/password', { email, password: FIRST_PASSWORD });
  assert.equal((await b('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD })).status, 200);
}

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-board-'));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '12', RISKS: '8', FAILED_SCANS: '1' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
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
  assert.equal((await admin('POST', '/api/iam/users', { email: 'uma@acme.io', role: 'user', password: FIRST_PASSWORD })).status, 201);
  // A role that may see reports, but not load findings.
  const roles = await admin('POST', '/api/iam/roles', { name: 'Report reader', permissions: ['reports.view'] });
  assert.equal(roles.status, 201, JSON.stringify(roles.body));
  const role = roles.body.roles.find((r) => r.name === 'Report reader');
  assert.equal((await admin('POST', '/api/iam/users', { email: 'rita@acme.io', role: role.id, password: FIRST_PASSWORD })).status, 201);
  await signIn(user, 'uma@acme.io');
  await signIn(reader, 'rita@acme.io');
});

test.after(() => {
  for (const child of children) child.kill();
});

test('held back until its activation code is applied, even for Admins', async () => {
  const locked = await admin('GET', '/api/status-board');
  assert.equal(locked.status, 403);
  assert.equal(locked.body.locked, true);
  assert.ok(!(await admin('GET', '/api/me')).body.permissions.includes('feature.statusBoard'));
  assert.equal((await admin('GET', '/api/me')).body.unlocked.statusBoard, false);
  // A fetch while it is locked reads nothing more than before (no failed scans, no applications).
  const before = await stats();
  assert.equal((await user('GET', '/api/scan')).status, 200);
  const after = await stats();
  assert.equal((after.applications ?? 0) - (before.applications ?? 0), 0, 'no applications read for a locked board');
  const applied = await admin('POST', '/api/activation', { code: script('feature', path.join(keyDir, 'issuer.pem'), 'Acme', 'statusBoard', 'on') });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.match(applied.body.applied, /Status board \(Labs\) turned on/);
  const me = (await admin('GET', '/api/me')).body;
  assert.equal(me.unlocked.statusBoard, true);
  assert.ok(me.permissions.includes('feature.statusBoard'));
  assert.equal(me.features.statusBoard, 'beta');
});

test('for whoever may load findings: a User sees it, a role without findings is refused', async () => {
  assert.ok((await user('GET', '/api/me')).body.permissions.includes('feature.statusBoard'), 'a User (findings.fetch) has it in Beta');
  assert.ok(!(await reader('GET', '/api/me')).body.permissions.includes('feature.statusBoard'));
  assert.equal((await reader('GET', '/api/status-board')).status, 403);
  assert.equal((await reader('GET', '/api/status-board/projects/p3/scans')).status, 403);
});

test('built from the Workbench fetch: severities, engines, applications, failed scans; no Checkmarx One call per view', async () => {
  // This session's earlier fetch was made while the board was locked: fetched again, it has the board's facts.
  const fetched = await user('GET', '/api/scan');
  assert.equal(fetched.status, 200);
  const before = await stats();
  const view = await user('GET', '/api/status-board');
  assert.equal(view.status, 200, JSON.stringify(view.body));
  for (let i = 0; i < 5; i += 1) await user('GET', '/api/status-board');
  assert.equal(total(await stats()) - total(before), 0, 'reading the board never calls Checkmarx One');
  const { board } = view.body;
  assert.equal(board.rows.length, 12);
  const p3 = board.rows.find((r) => r.projectId === 'p3');
  // Project 3's SAST scan failed after its latest completed scan: the board says why and that its results are older.
  assert.equal(p3.health, 'failed');
  assert.match(p3.failed.reason, /SAST: out of memory/);
  assert.deepEqual(p3.failed.engines, ['sast']);
  assert.ok(p3.engines.includes('sast') && p3.engines.includes('kics'), JSON.stringify(p3.engines));
  assert.deepEqual(p3.applications, ['Web'], 'the mock puts project i in application i % 4');
  assert.deepEqual(p3.groups, ['team-a']);
  assert.equal(p3.sev.critical + p3.sev.high + p3.sev.medium + p3.sev.low, p3.total);
  assert.equal(p3.ch, p3.sev.critical + p3.sev.high);
  assert.ok(p3.scanAt && p3.ageDays < 2);
  // Projects 3 and 10 have a failed scan in the last 7 days; every other project is healthy.
  assert.deepEqual(board.rows.filter((r) => r.failed).map((r) => r.projectId).sort(), ['p10', 'p3']);
  assert.equal(board.figures.failed7, 2);
  assert.equal(board.figures.projects, 12);
  assert.equal(board.figures.scanned30, 12);
  assert.equal(board.figures.ch, board.rows.reduce((n, r) => n + r.ch, 0));
  // Fusion and LAST scans (the mock: every sixth project from 4 ran LAST; projects not 2 mod 3 ran the AI engine).
  assert.equal(board.rows.find((r) => r.projectId === 'p4').scanType, 'last');
  assert.equal(board.rows.find((r) => r.projectId === 'p0').scanType, 'fusion');
});

test('the side panel: a project\'s last scans, with the failed one first and why', async () => {
  const r = await user('GET', '/api/status-board/projects/p3/scans');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.scans.length >= 1 && r.body.scans.length <= 5);
  assert.equal(r.body.scans[0].status, 'Failed');
  assert.match(r.body.scans[0].reason, /out of memory/);
  // Read once, then kept: opening it again calls nothing.
  const before = await stats();
  assert.equal((await user('GET', '/api/status-board/projects/p3/scans')).status, 200);
  assert.equal(total(await stats()) - total(before), 0);
  assert.equal((await user('GET', '/api/status-board/projects/nope/scans')).status, 404);
});
