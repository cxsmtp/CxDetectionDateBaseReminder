// FAE Flush (Labs), for real against the mock Checkmarx One: every project's code scanned again on a "<name>_FAE"
// copy with Findings Analysis on, what that scan no longer reports marked Proposed not exploitable in the original
// project, revalidated, and the copies deleted (or kept, then deleted with one click). Undo puts every mark back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compareResults, exceptionOf, summaryOf } from '../src/fae-flush.js';
import { freePort } from './free-port.js';
import { FIRST_PASSWORD, NEXT_PASSWORD, mockApiKey } from './test-credentials.js';

const MOCK_PORT = await freePort();
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const KEY = mockApiKey({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' });
const children = [];
// A key of the test's own to sign the FAE Flush activation code (never the maintainer's).
const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fae-key-'));
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
const mock = async (p) => (await fetch(MOCK + p)).json();
/** The page's view, asked again until `done` says so. */
async function until(done, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const view = (await admin('GET', '/api/fae-flush')).body;
    if (done(view)) return view;
    if (Date.now() > end) throw new Error(`Timed out: ${JSON.stringify(view?.job?.projects?.filter((p) => p.exception).map((p) => [p.name, p.exception]) ?? view).slice(0, 900)}\n${log.slice(-2000)}`);
    await sleep(150);
  }
}

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fae-flush-'));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '10', RISKS: '30', FAE_SCAN_MS: '500' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: KEY, CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme', FAE_FLUSH_TICK_MS: '150', MZ_ACTIVATION_TEST_KEY: publicKey,
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
  await user('POST', '/api/session/password', { email: 'uma@acme.io', password: FIRST_PASSWORD });
  assert.equal((await user('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD })).status, 200);
});

test.after(() => {
  for (const child of children) child.kill();
});

test('compare: only results still To verify, matched by similarity id; what FAE judged not exploitable counts as not reported', () => {
  const original = [
    { similarityID: 'a', state: 'TO_VERIFY', severity: 'HIGH', queryName: 'SQL_Injection' },
    { similarityID: 'b', state: 'TO_VERIFY', severity: 'LOW' },
    { similarityID: 'c', state: 'CONFIRMED', severity: 'HIGH' },
    { similarityID: 'd', state: 'TO_VERIFY', status: 'FIXED', severity: 'HIGH' },
    { similarityID: 'e', state: 'TO_VERIFY', severity: 'MEDIUM' },
    { similarityID: 'e', state: 'TO_VERIFY', severity: 'MEDIUM' },
  ];
  const fae = [{ similarityID: 'a', state: 'TO_VERIFY' }, { similarityID: 'e', state: 'PROPOSED_NOT_EXPLOITABLE' }, { similarityID: 'z', state: 'TO_VERIFY' }];
  const c = compareResults(original, fae);
  assert.equal(c.toVerify, 3);
  assert.equal(c.reported, 1);
  assert.deepEqual(c.notReported.map((r) => r.similarityId), ['b', 'e']);
  assert.equal(c.extra, 1);
});

test('exceptions: other code, nearly everything marked, or many results the project does not have', () => {
  assert.equal(exceptionOf({ loc: 1000, faeLoc: 1010, counts: { toVerify: 10, notReported: 5, faeReported: 5, extra: 0 } }), null);
  assert.equal(exceptionOf({ loc: 1000, faeLoc: 1100, counts: {} }).code, 'loc');
  assert.equal(exceptionOf({ counts: { toVerify: 40, notReported: 39, faeReported: 1, extra: 0 } }).code, 'many');
  // Too few to judge by share.
  assert.equal(exceptionOf({ counts: { toVerify: 5, notReported: 5, faeReported: 0, extra: 0 } }), null);
  assert.equal(exceptionOf({ counts: { toVerify: 10, notReported: 2, faeReported: 10, extra: 4 } }).code, 'extra');
  assert.equal(summaryOf(null).projects, 0);
});

test('held back until its activation code is applied, even for Admins', async () => {
  const locked = await admin('GET', '/api/fae-flush');
  assert.equal(locked.status, 403);
  assert.equal(locked.body.locked, true);
  assert.ok(!(await admin('GET', '/api/me')).body.permissions.includes('feature.faeFlush'));
  assert.ok(!(await admin('GET', '/api/features')).body.features.some((f) => f.id === 'faeFlush'), 'not even listed under Beta features');
  const applied = await admin('POST', '/api/activation', { code: script('feature', path.join(keyDir, 'issuer.pem'), 'Acme', 'faeFlush', 'on') });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.match(applied.body.applied, /FAE Flush \(Labs\) turned on/);
  assert.equal((await admin('GET', '/api/me')).body.unlocked.faeFlush, true);
  assert.ok((await admin('GET', '/api/me')).body.permissions.includes('feature.faeFlush'));
  assert.equal((await admin('GET', '/api/fae-flush')).status, 200);
});

test('a Beta feature for the Checkmarx One integration: others are refused', async () => {
  assert.equal((await user('GET', '/api/fae-flush')).status, 403);
  assert.equal((await user('POST', '/api/fae-flush/preview')).status, 403);
  const me = (await admin('GET', '/api/me')).body;
  assert.equal(me.features.faeFlush, 'beta');
});

test('preview, then a run that deletes the _FAE copies: marked, revalidated, audited; Undo puts them back', async () => {
  assert.equal((await admin('POST', '/api/fae-flush/start', { deleteFae: true })).status, 409, 'nothing to start before a preview');
  assert.equal((await admin('POST', '/api/fae-flush/preview')).status, 202);
  const { preview } = await until((v) => v.preview && !v.previewing);
  // Project 8: Checkmarx One no longer keeps its code.
  assert.equal(preview.projects.length, 10);
  assert.equal(preview.eligible, 9);
  assert.match(preview.projects.find((p) => p.id === 'p8').leftOut, /does not keep the code/);
  assert.equal(preview.toVerify, 9 * 30);

  // Delete or keep: the initiator must say.
  assert.equal((await admin('POST', '/api/fae-flush/start', { concurrency: 3 })).status, 400);
  const started = await admin('POST', '/api/fae-flush/start', { concurrency: 3, deleteFae: true });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal((await admin('POST', '/api/fae-flush/start', { deleteFae: true })).status, 409, 'one run at a time');

  const done = await until((v) => v.job?.state === 'done', 60000);
  // Each project: 30 To verify, the FAE scan reports 10 of them (and 2 of its own): 20 marked.
  assert.equal(done.summary.totals.toVerify, 270);
  assert.equal(done.summary.totals.reported, 90);
  assert.equal(done.summary.totals.marked, 180);
  assert.equal(done.summary.totals.revalidated, 180);
  assert.equal(done.summary.steps.done, 9);
  assert.equal(done.summary.steps['left-out'], 1);
  assert.equal(done.summary.faeKept, 0);
  const marks = await mock('/__predicates');
  assert.equal(Object.values(marks).filter((s) => s === 'PROPOSED_NOT_EXPLOITABLE').length, 180);
  // Only in the original projects, and the copies are gone.
  assert.ok(Object.keys(marks).every((k) => /^p\d+\|/.test(k)));
  assert.deepEqual((await mock('/__fae')).projects, {});

  const audit = (await admin('GET', '/api/audit?q=FAE%20Flush&limit=200')).body;
  const reasons = audit.entries.map((e) => e.reason).join('\n');
  assert.match(reasons, /FAE Flush started for 9 projects, 3 scans at a time; the _FAE projects are deleted/);
  assert.match(reasons, /FAE Flush marked 20 of Project 0's 30 results To verify Proposed not exploitable/);
  assert.match(reasons, /FAE Flush finished: 180 of 270 results/);

  const undo = await admin('POST', '/api/fae-flush/undo');
  assert.equal(undo.status, 200);
  assert.equal(undo.body.restored, 180);
  assert.equal(Object.values(await mock('/__predicates')).filter((s) => s === 'TO_VERIFY').length, 180);
  assert.equal(undo.body.summary.steps.undone, 9);
});

test('a run that keeps the _FAE copies, then "Delete all _FAE projects" with one click', async () => {
  const started = await admin('POST', '/api/fae-flush/start', { concurrency: 5, deleteFae: false });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const done = await until((v) => v.job?.state === 'done', 60000);
  assert.equal(done.summary.totals.marked, 180);
  assert.equal(done.summary.faeKept, 9);
  assert.equal(Object.keys((await mock('/__fae')).projects).length, 9);
  // The copies are not part of the backlog anywhere else.
  const projects = (await admin('GET', '/api/projects')).body;
  if (Array.isArray(projects?.projects)) assert.ok(projects.projects.every((p) => !/_FAE$/.test(p.name)));

  const gone = await admin('POST', '/api/fae-flush/delete-fae');
  assert.equal(gone.status, 200);
  assert.equal(gone.body.deleted, 9);
  assert.equal(gone.body.summary.faeKept, 0);
  assert.deepEqual((await mock('/__fae')).projects, {});
});
