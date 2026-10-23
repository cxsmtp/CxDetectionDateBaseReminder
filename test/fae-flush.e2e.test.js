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
  // Counted as Checkmarx One counts them (results: 'e' twice), and in distinct findings (similarity ids).
  assert.deepEqual([c.toVerify, c.toVerifyFindings], [4, 3]);
  assert.equal(c.reported, 1);
  assert.deepEqual(c.notReportedList.map((r) => [r.similarityId, r.results]), [['b', 1], ['e', 2]]);
  assert.equal(c.notReported, 3, 'one mark on e covers both its results');
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
  // Project 8: Checkmarx One no longer keeps its code, but its repository is known: flushed from there.
  assert.equal(preview.projects.length, 10);
  assert.equal(preview.eligible, 10);
  const p8 = preview.projects.find((p) => p.id === 'p8');
  assert.deepEqual([p8.leftOut, p8.codeKept, p8.repoUrl, p8.commit], ['', false, 'https://github.com/acme/p8', 'abc123']);
  assert.equal(preview.toVerify, 10 * 30);

  // Delete or keep: the initiator must say.
  assert.equal((await admin('POST', '/api/fae-flush/start', { concurrency: 3 })).status, 400);
  const started = await admin('POST', '/api/fae-flush/start', { concurrency: 3, deleteFae: true });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.deepEqual(started.body.job.options, { source: 'auto', mode: 'mark', markAs: 'pne', sensitivity: 'normal' });
  assert.equal((await admin('POST', '/api/fae-flush/start', { deleteFae: true })).status, 409, 'one run at a time');

  const done = await until((v) => v.job?.state === 'done', 60000);
  // Each project: 30 To verify, 10 of them added by the AI engine (left as they are: the FAE scan is SAST only); the
  // FAE scan reports 10 of the other 20 (and 2 of its own): 10 marked.
  assert.equal(done.summary.totals.toVerify, 200);
  assert.equal(done.summary.totals.aiLeft, 100);
  assert.equal(done.summary.totals.reported, 100);
  assert.equal(done.summary.totals.marked, 100);
  assert.equal(done.summary.totals.revalidated, 100);
  assert.equal(done.summary.steps.done, 10);
  assert.equal(done.summary.faeKept, 0);
  // Downloaded (from storage that wants the access token, as on a real tenant) and uploaded again for every project
  // whose code Checkmarx One keeps; the repository for project 8.
  const scans = Object.values((await mock('/__fae')).scans);
  assert.deepEqual([scans.filter((x) => x.code === 'upload').length, scans.filter((x) => x.code === 'git').map((x) => x.source)], [9, ['p8']]);
  assert.deepEqual(done.job.projects.find((p) => p.id === 'p8').codeSource, 'git');
  assert.ok(done.job.projects.find((p) => p.id === 'p0').attempts.some((a) => a.what === 'code: download and upload' && a.ok), 'each project says how its code came');
  const marks = await mock('/__predicates');
  assert.equal(Object.values(marks).filter((s) => s === 'PROPOSED_NOT_EXPLOITABLE').length, 100);
  // Only in the original projects, and the copies are gone.
  assert.ok(Object.keys(marks).every((k) => /^p\d+\|/.test(k)));
  assert.deepEqual((await mock('/__fae')).projects, {});

  const audit = (await admin('GET', '/api/audit?q=FAE%20Flush&limit=200')).body;
  const reasons = audit.entries.map((e) => e.reason).join('\n');
  assert.match(reasons, /FAE Flush started for 10 projects, 3 scans at a time; marks them Proposed not exploitable; code: auto; stops to ask: normal; the _FAE projects are deleted/);
  assert.match(reasons, /FAE Flush marked 10 of Project 0's 20 results To verify Proposed not exploitable/);
  assert.match(reasons, /code from download and upload/);
  assert.match(reasons, /FAE Flush finished: 100 of 200 results/);

  // Kept after the run: the value it brought.
  const value = (await admin('GET', '/api/fae-flush/value')).body;
  assert.deepEqual([value.total.marked, value.total.kept, value.saved.credits, value.saved.hours, value.saved.minutesPerTriage, value.runs.length, value.projects.length], [100, 100, 100, 33.3, 20, 1, 10]);
  assert.equal(Object.values(value.total.bySeverity).reduce((a, b) => a + b, 0), 100);

  const undo = await admin('POST', '/api/fae-flush/undo');
  assert.equal(undo.status, 200);
  assert.equal(undo.body.restored, 100);
  assert.equal(Object.values(await mock('/__predicates')).filter((s) => s === 'TO_VERIFY').length, 100);
  assert.equal(undo.body.summary.steps.undone, 10);
  const after = (await admin('GET', '/api/fae-flush/value')).body;
  assert.deepEqual([after.total.marked, after.total.undone, after.total.kept, after.saved.credits, after.runs[0].undone], [100, 100, 0, 0, 100], 'the history keeps the run and what was undone');
});

test('a report-only run marks nothing until "Mark now"; the copies are kept for it', async () => {
  const started = await admin('POST', '/api/fae-flush/start', { concurrency: 5, deleteFae: true, mode: 'report', projectIds: ['p0', 'p1'] });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.job.projects.length, 2, 'only the projects chosen');
  const reported = await until((v) => v.job?.state === 'done', 60000);
  assert.deepEqual([reported.summary.steps.reported, reported.summary.totals.notReported, reported.summary.totals.marked], [2, 20, 0]);
  assert.equal(Object.values(await mock('/__predicates')).filter((s) => s === 'PROPOSED_NOT_EXPLOITABLE').length, 0, 'nothing marked');
  assert.equal(Object.keys((await mock('/__fae')).projects).length, 2, 'kept until marked');
  assert.equal((await user('POST', '/api/fae-flush/mark-now')).status, 403);
  assert.equal((await admin('POST', '/api/fae-flush/mark-now')).status, 200);
  const marked = await until((v) => v.job?.state === 'done' && !v.summary.steps.reported, 60000);
  assert.deepEqual([marked.summary.totals.marked, marked.summary.steps.done, marked.summary.faeKept], [20, 2, 0]);
  assert.equal((await admin('POST', '/api/fae-flush/mark-now')).status, 409, 'nothing left to mark');
});

test('troubleshoot: test one project (nothing made), and a debug log of every call, signatures hidden', async () => {
  const before = Object.keys((await mock('/__fae')).projects).length;
  const tested = await admin('POST', '/api/fae-flush/test', { projectId: 'p3' });
  assert.equal(tested.status, 200, JSON.stringify(tested.body));
  const check = Object.fromEntries(tested.body.checks.map((c) => [c.check, c]));
  assert.equal(check['Code kept by Checkmarx One'].ok, true);
  assert.equal(check['Its stored copy (signed download address)'].ok, true);
  assert.match(check['Its stored copy (signed download address)'].detail, /302 → same host \/storage\/repostore\.mock\/tenant-1\/… · valid 900 s/);
  // The upload address wants the access token too (as on a live tenant): an empty zip, sent with it, accepted.
  assert.equal(check['The upload address takes the code'].ok, true, check['The upload address takes the code']?.detail);
  assert.match(check['The upload address takes the code'].detail, /same host \/__upload\/[^ ]+ · an empty zip accepted/);
  assert.equal(check['The signed address answers'].ok, true);
  assert.match(check['The signed address answers'].detail, /^206 with the access token/, 'read as a browser does, with the access token on the same host');
  assert.match(check['Its repository and commit'].detail, /github\.com\/acme\/p3 · main · abc123/);
  assert.equal(check['The API key may make and delete projects, start scans and change states'].ok, null);
  assert.equal(Object.keys((await mock('/__fae')).projects).length, before, 'nothing made');
  assert.equal((await user('POST', '/api/fae-flush/test', { projectId: 'p3' })).status, 403);

  assert.equal((await admin('PUT', '/api/fae-flush/debug', { on: true })).body.on, true);
  await admin('POST', '/api/fae-flush/test', { projectId: 'p3' });
  const { log } = (await admin('GET', '/api/fae-flush/debug')).body;
  const text = JSON.stringify(log);
  assert.ok(log.some((e) => /repostore\/code/.test(e.url)), 'the calls are there');
  assert.ok(!/mocksig/.test(text) && /X-Amz-Signature=\[hidden\]/.test(text), 'signatures hidden');
  assert.ok(!/Bearer (?!\[hidden\])/.test(text), 'the access token never in it');
  assert.equal((await admin('DELETE', '/api/fae-flush/debug')).body.entries, 0);
  assert.equal((await admin('PUT', '/api/fae-flush/debug', { on: false })).body.on, false);
});

test('a run that keeps the _FAE copies, then "Delete all _FAE projects" with one click', async () => {
  // The marks of the report-only run go back first, so this run has the same results To verify to mark.
  assert.equal((await admin('POST', '/api/fae-flush/undo')).status, 200);
  const started = await admin('POST', '/api/fae-flush/start', { concurrency: 5, deleteFae: false });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const done = await until((v) => v.job?.state === 'done', 60000);
  assert.equal(done.summary.totals.marked, 100);
  assert.equal(done.summary.faeKept, 10);
  assert.equal(Object.keys((await mock('/__fae')).projects).length, 10);
  // The copies are not part of the backlog anywhere else.
  const projects = (await admin('GET', '/api/projects')).body;
  if (Array.isArray(projects?.projects)) assert.ok(projects.projects.every((p) => !/_FAE$/.test(p.name)));

  const gone = await admin('POST', '/api/fae-flush/delete-fae');
  assert.equal(gone.status, 200);
  assert.equal(gone.body.deleted, 10);
  assert.equal(gone.body.summary.faeKept, 0);
  assert.deepEqual((await mock('/__fae')).projects, {});
  // Every run stays in the value: 100 + 20 + 100 marked, the first 100 and the report run's 20 undone.
  const value = (await admin('GET', '/api/fae-flush/value')).body;
  assert.deepEqual([value.runs.length, value.total.marked, value.total.kept], [3, 220, 100]);
});

test('Not exploitable is for Admins alone: another role that may run FAE Flush is refused it', async () => {
  const role = await admin('POST', '/api/iam/roles', { name: 'FAE operator', permissions: ['beta.use', 'integration.cxone', 'settings.view'] });
  assert.equal(role.status, 201, JSON.stringify(role.body));
  const people = (await admin('GET', '/api/iam')).body.users;
  const id = role.body.roles.find((r) => r.name === 'FAE operator').id;
  assert.equal((await admin('PATCH', `/api/iam/users/${people.find((u) => u.email === 'uma@acme.io').id}`, { role: id })).status, 200);
  const me = (await user('GET', '/api/me')).body;
  assert.ok(!me.permissions.includes('faeFlush.notExploitable'), 'never given to another role');
  const refused = await user('POST', '/api/fae-flush/start', { concurrency: 1, deleteFae: true, markAs: 'ne', projectIds: ['p0'] });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.match(refused.body.error, /Only an Admin can mark them Not exploitable/);
  assert.ok((await admin('GET', '/api/me')).body.permissions.includes('faeFlush.notExploitable'), 'the Admin role holds it');
  assert.equal((await admin('POST', '/api/iam/roles', { name: 'Sneaky', permissions: ['beta.use', 'faeFlush.notExploitable'] })).status, 400, 'it cannot be given to another role');
});

test('a setting Checkmarx One will not copy stops a project to ask; skipped, it can be brought back', async () => {
  await mock('/__refuse-setting?key=scan.config.sast.extendedAnalysis');
  const started = await admin('POST', '/api/fae-flush/start', { concurrency: 2, deleteFae: true, mode: 'report', projectIds: ['p2'] });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const asked = await until((v) => v.job?.projects?.[0]?.step === 'needs-ok');
  const p = asked.job.projects[0];
  assert.equal(p.exception.code, 'settings');
  assert.match(p.exception.text, /would not copy this setting to Project 2_FAE: extendedAnalysis \(.*403/);
  assert.ok(p.attempts.some((a) => a.what === 'project made' && /0 of 1 SAST setting\(s\) copied; refused: extendedAnalysis/.test(a.detail)), 'empty settings are not copied');
  assert.equal((await admin('POST', '/api/fae-flush/bring-back')).status, 409, 'nothing skipped yet');
  assert.equal((await admin('POST', '/api/fae-flush/decide', { projectId: 'p2', decision: 'skip' })).status, 200);
  const skipped = await until((v) => v.job?.state === 'done');
  assert.equal(skipped.job.projects[0].step, 'skipped');

  await mock('/__refuse-setting?key=');
  const back = await admin('POST', '/api/fae-flush/bring-back', { projectIds: ['p2'] });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.job.state, 'running');
  assert.match(back.body.job.projects[0].note, /^Brought back by admin@acme\.io$/);
  const done = await until((v) => v.job?.state === 'done', 60000);
  // Compared this time (its results were marked by the run before, so none is left to mark).
  assert.equal(done.job.projects[0].step, 'reported');
  assert.ok(done.job.projects[0].attempts.some((a) => a.what === 'project made' && /1 of 1 SAST setting\(s\) copied\)$/.test(a.detail)));
  const reasons = (await admin('GET', '/api/audit?q=FAE%20Flush&limit=50')).body.entries.map((e) => e.reason).join('\n');
  assert.match(reasons, /FAE Flush: admin@acme\.io brought back 1 skipped project \(Project 2\)\./);
});

test('a tenant that groups similar results by attack vector: marked and undone by attack vector id', async () => {
  await mock('/__triage-by?by=av');
  // Their results as the scans found them (an earlier run marked them).
  await mock('/__predicates?clear=p4');
  await mock('/__predicates?clear=p5');
  const started = await admin('POST', '/api/fae-flush/start', { concurrency: 3, deleteFae: true, projectIds: ['p4', 'p5'] });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const done = await until((v) => v.job?.state === 'done', 60000);
  assert.deepEqual([done.summary.steps.done, done.summary.totals.marked, done.summary.totals.revalidated], [2, 20, 20]);
  assert.ok(done.job.projects.some((p) => p.attempts.some((a) => a.what === 'marks by attack vector')), 'said once, for the run');
  assert.equal(done.job.markBy, 0);
  assert.equal(Object.entries(await mock('/__predicates')).filter(([k, s]) => /^p[45]\|/.test(k) && s === 'PROPOSED_NOT_EXPLOITABLE').length, 20);
  const undo = await admin('POST', '/api/fae-flush/undo');
  assert.equal(undo.body.restored, 20);
  await mock('/__triage-by?by=similarity');
});
