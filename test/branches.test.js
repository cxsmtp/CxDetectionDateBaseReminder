// One branch per project (its primary branch, else main, else master) unless every branch is asked for,
// and projects with nothing to analyse left out: on the Dashboard, its reports, tracked reports, credits,
// scheduled runs and the calculator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BRANCH_HOW, branchOf, branchScopeOf, forgetBranches, linesOfCode, onBranch, primaryScans, withCode } from '../src/cxone/branches.js';
import { DEFAULT_AUTOMATION, mergeAutomation } from '../src/automation.js';
import { SettingsStore } from '../src/settings.js';
import { FindingJournal } from '../src/finding-journal.js';
import { cleanScope, inScope, openFindings, scopeActive } from '../public/calculator/model.js';
import { freePort } from './free-port.js';
import { FIRST_PASSWORD, NEXT_PASSWORD, mockApiKey } from './test-credentials.js';

/** A client that answers from a table of paths, and counts what it was asked. */
function fakeClient(routes) {
  const calls = [];
  return {
    calls,
    async request(pathname, { query = {} } = {}) {
      calls.push({ pathname, query });
      for (const [match, answer] of routes) if (match(pathname, query)) return typeof answer === 'function' ? answer(pathname, query) : answer;
      throw Object.assign(new Error(`no route for ${pathname}`), { status: 404 });
    },
  };
}

test('a branch is named the same however Checkmarx One gives it; "all" is the only other choice', () => {
  assert.equal(branchOf({ branch: 'refs/heads/main' }), 'main');
  assert.equal(branchOf({ branchName: 'master' }), 'master');
  assert.equal(branchOf({ metadata: { Handler: { GitHandler: { branch: 'develop' } } } }), 'develop');
  assert.equal(branchOf(null), '');
  assert.equal(branchScopeOf('ALL'), 'all');
  assert.equal(branchScopeOf(undefined), 'primary');
  assert.equal(branchScopeOf('feature/x'), 'primary');
});

test('each project counts its primary branch, else main, else master, else its latest scan; a primary branch never scanned counts nothing', async () => {
  forgetBranches();
  const projects = [
    { id: 'a', mainBranch: 'develop' }, // latest scan on develop: as it is
    { id: 'b', mainBranch: 'release' }, // latest on a feature branch: release looked up
    { id: 'c', mainBranch: '' }, // no primary branch, latest on master: guessed
    { id: 'd', mainBranch: '' }, // no primary branch, latest on a feature branch, main scanned before: guessed main
    { id: 'e', mainBranch: '' }, // no primary, nothing on main or master: the latest scan's branch
    { id: 'f', mainBranch: 'prod' }, // prod never scanned: nothing counts
    { id: 'g', mainBranch: 'main' }, // the tenant does not say branches: as before
  ];
  const last = {
    a: { id: 'a1', branch: 'develop' },
    b: { id: 'b2', branch: 'feature/x' },
    c: { id: 'c1', branch: 'master' },
    d: { id: 'd2', branch: 'feature/y' },
    e: { id: 'e1', branch: 'trunk' },
    f: { id: 'f2', branch: 'feature/z' },
    g: { id: 'g1' },
  };
  const history = {
    b: [{ id: 'b2', branch: 'feature/x', createdAt: '2026-10-02' }, { id: 'b1', branch: 'release', createdAt: '2026-10-01' }],
    d: [{ id: 'd2', branch: 'feature/y', createdAt: '2026-10-02' }, { id: 'd1', branch: 'main', createdAt: '2026-10-01' }],
    e: [{ id: 'e1', branch: 'trunk', createdAt: '2026-10-02' }],
    f: [{ id: 'f2', branch: 'feature/z', createdAt: '2026-10-02' }],
  };
  const client = fakeClient([
    [(p) => p === '/api/projects/last-scan', last],
    // This tenant ignores the branch asked for: the answer is checked, not trusted.
    [(p, q) => p === '/api/scans' && q['project-id'], (p, q) => ({ scans: history[q['project-id']] ?? [] })],
  ]);
  const choice = await primaryScans(client, projects, { identity: 'k1' });
  const how = Object.fromEntries(projects.map((p) => [p.id, [choice.branches[p.id].how, choice.branches[p.id].branch, choice.scans[p.id]?.id ?? null]]));
  assert.deepEqual(how, {
    a: [BRANCH_HOW.primary, 'develop', 'a1'],
    b: [BRANCH_HOW.primary, 'release', 'b1'],
    c: [BRANCH_HOW.guessed, 'master', 'c1'],
    d: [BRANCH_HOW.guessed, 'main', 'd1'],
    e: [BRANCH_HOW.latest, 'trunk', 'e1'],
    f: [BRANCH_HOW.none, 'prod', null],
    g: [BRANCH_HOW.unknown, '', 'g1'],
  });
  assert.equal(client.calls.find((c) => c.query['project-id'] === 'b').query.branch, 'release', 'the primary branch is asked for');
  assert.equal(choice.anyBranch.b.id, 'b2', 'the latest scan of any branch is kept too');

  // Looked up once: while a project's latest scan is the same, the answer is too.
  const before = client.calls.length;
  await primaryScans(client, projects, { identity: 'k1' });
  assert.equal(client.calls.length - before, 1, 'only the last-scan list is read again');

  const all = await primaryScans(client, projects, { identity: 'k1', all: true });
  assert.equal(all.scans.b.id, 'b2');
  assert.ok(Object.values(all.branches).every((b) => b.how === BRANCH_HOW.any));
});

test("only the findings of a project's branch are kept; a finding whose branch cannot be told is kept", async () => {
  forgetBranches();
  const client = fakeClient([[(p, q) => p === '/api/scans' && q['scan-ids'], (p, q) => ({ scans: q['scan-ids'].filter((id) => id !== 'gone').map((id) => ({ id, branch: id.startsWith('m') ? 'main' : 'feature/x' })) })]]);
  const choice = { branches: { p: { branch: 'main', how: BRANCH_HOW.primary }, q: { branch: 'main', how: BRANCH_HOW.none }, r: { branch: '', how: BRANCH_HOW.unknown } } };
  const risks = [{ riskId: 1, scanId: 'm1' }, { riskId: 2, scanId: 'f1' }, { riskId: 3, scanId: '' }, { riskId: 4, scanId: 'gone' }, { riskId: 5, scanId: 'f1', branch: 'main' }];
  assert.deepEqual((await onBranch(client, choice, 'p', risks, { identity: 'k' })).map((r) => r.riskId), [1, 3, 4, 5]);
  assert.equal(client.calls.length, 1, 'the scans named are read together');
  await onBranch(client, choice, 'p', risks, { identity: 'k' });
  assert.equal(client.calls.length, 1, 'a scan never changes branch: known after the first read');
  assert.deepEqual(await onBranch(client, choice, 'q', risks), [], 'a primary branch never scanned: nothing counts');
  assert.equal((await onBranch(client, choice, 'r', risks)).length, 5, 'a tenant that does not say branches: everything, as before');
});

test('projects whose scan counted no lines of code are left out; unknown is kept', async () => {
  forgetBranches();
  const client = fakeClient([[(p) => p.startsWith('/api/sast-metadata/'), (p) => {
    const id = p.split('/').pop();
    if (id === 'none') throw Object.assign(new Error('no SAST'), { status: 404 });
    return { loc: id === 'empty' ? 0 : 1200 };
  }]]);
  assert.equal(await linesOfCode(client, { id: 'x', statusDetails: [{ name: 'sast', loc: 0 }] }), 0, 'the scan says it: nothing to ask');
  assert.equal(client.calls.length, 0);
  const projects = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }];
  const { kept, noCode } = await withCode(client, projects, { p1: { id: 'full' }, p2: { id: 'empty' }, p3: { id: 'none' } });
  assert.deepEqual(kept.map((p) => p.id), ['p1', 'p3', 'p4']);
  assert.deepEqual(noCode.map((p) => p.id), ['p2']);
});

test('a load of some engines still records fixes of those engines, and only of those', () => {
  const journal = new FindingJournal();
  const p = { projectId: 'p', projectName: 'P' };
  journal.observe(p, [{ riskId: 's1', scanner: 'sast', severity: 'HIGH' }, { riskId: 'k1', scanner: 'kics', severity: 'LOW' }], { complete: true });
  journal.observe(p, [], { complete: true, engines: ['SAST', 'SCA'] });
  const byId = Object.fromEntries(journal.entries().map((e) => [e.r, e]));
  assert.ok(byId.s1.g, 'the SAST finding no longer listed: fixed');
  assert.equal(byId.k1.g, undefined, 'the IaC finding was not read: still open');
  assert.equal(byId.k1.k, 'KICS');
});

test('a new schedule reads primary branches and leaves out projects with no code; one saved before keeps every branch', () => {
  assert.equal(DEFAULT_AUTOMATION.branches, 'primary');
  assert.equal(DEFAULT_AUTOMATION.leaveOutNoCode, true);
  assert.equal(mergeAutomation(DEFAULT_AUTOMATION, { branches: 'all', leaveOutNoCode: false }).branches, 'all');
  assert.equal(mergeAutomation(DEFAULT_AUTOMATION, { branches: 'x' }).branches, 'primary');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branches-'));
  const old = path.join(dir, 'old.json');
  fs.writeFileSync(old, JSON.stringify({ automation: { enabled: true } }));
  const saved = new SettingsStore({ file: old }).get().automation;
  assert.deepEqual([saved.branches, saved.leaveOutNoCode], ['all', false]);
});

test('the calculator scope leaves out projects with no code (by default) and, when asked, those with no open findings', () => {
  assert.deepEqual([cleanScope({}).leaveOutNoCode, cleanScope({}).leaveOutNoFindings], [true, false]);
  assert.equal(scopeActive({}), false, 'the leave-out options alone pick nothing');
  const empty = { id: 'e', loc: 0, openByEngine: { SAST: 3 } };
  const typedIn = { id: 't', loc: 0, locOverride: 5000 };
  const clean = { id: 'c', loc: 9000, openByEngine: { SAST: 0, KICS: 4 } };
  const unknown = { id: 'u', loc: null };
  assert.equal(inScope(empty, {}), false);
  assert.equal(inScope(empty, { leaveOutNoCode: false }), true);
  assert.equal(inScope(typedIn, {}), true, 'lines typed in count');
  assert.equal(inScope(unknown, { leaveOutNoFindings: true }), true, 'not known: kept');
  assert.equal(inScope(clean, { leaveOutNoFindings: true }, ['SAST', 'SCA']), false, 'nothing open in the engines counted');
  assert.equal(inScope(clean, { leaveOutNoFindings: true }, ['SAST', 'KICS']), true);
  assert.equal(openFindings(clean), 4);
});

// ---------------------------------------------------------------------------------------------
// The server, against a mock tenant of 16 projects scanned on several branches (BRANCHES=1):
// primary branch main, master, develop or unset (i % 4); 6 and 14 never had their primary branch
// scanned; 5 and 15 counted no lines of code; 9 has no findings; on even projects 2 findings in 10
// come from a feature branch scan.
// ---------------------------------------------------------------------------------------------

const MOCK_PORT = await freePort();
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const children = [];
let log = '';
let cookie = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function admin(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Origin: BASE, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, body: json, text };
}

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branches-e2e-'));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '16', RISKS: '10', INITIATORS: '1', BRANCHES: '1' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: mockApiKey({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' }), CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD, SMTP_HOST: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  children.push(server);
  const end = Date.now() + 20000;
  while (!/Successfully authenticated/.test(log)) {
    if (Date.now() > end) throw new Error(log);
    await sleep(100);
  }
  await admin('POST', '/api/session/password', { email: 'admin@acme.io', password: FIRST_PASSWORD });
  await admin('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD });
});

test.after(() => {
  for (const child of children) child.kill();
});

test("loading findings reads each project's primary branch once, and leaves out projects with nothing to analyse", async () => {
  const r = await admin('GET', '/api/scan');
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.deepEqual(r.body.leftOut, { noPrimaryScan: 2, noCode: 2, noFindings: 0 });
  assert.equal(r.body.totals.projects, 12);
  // Even projects: 8 of 10 (2 are a feature branch's); odd ones all 10, and project 9 has none.
  assert.equal(r.body.totals.risks, 6 * 8 + 5 * 10);
  const row = Object.fromEntries(r.body.projects.map((p) => [p.projectId, p]));
  assert.deepEqual([row.p0.branch, row.p0.branchHow], ['main', 'primary']);
  assert.deepEqual([row.p2.branch, row.p2.branchHow], ['develop', 'primary']);
  assert.deepEqual([row.p3.branch, row.p3.branchHow], ['main', 'guessed']);
  assert.deepEqual([row.p7.branch, row.p7.branchHow], ['trunk', 'latest']);
  assert.ok(!row.p6 && !row.p5, 'never scanned on its primary branch; no lines of code');
  assert.equal(r.body.branches.scope, 'primary');
  assert.deepEqual((await admin('GET', '/api/scan/last')).body.request.branches, 'primary');
});

test('every branch, keeping projects with no code, and leaving out those with no open findings, each when asked', async () => {
  const all = await admin('GET', '/api/scan?branches=all');
  assert.equal(all.body.totals.projects, 14, 'every project but the two with no lines of code');
  assert.equal(all.body.totals.risks, 13 * 10);
  const everything = await admin('GET', '/api/scan?branches=all&zeroLoc=keep');
  assert.equal(everything.body.totals.projects, 16);
  assert.equal(everything.body.totals.risks, 15 * 10);
  const busy = await admin('GET', '/api/scan?noFindings=leave-out');
  assert.equal(busy.body.totals.projects, 11);
  assert.equal(busy.body.leftOut.noFindings, 1);
  assert.equal(busy.body.totals.risks, 98);
});

test("a read of every branch never changes what the Impact page counts open; the primary branch's does", async () => {
  await admin('GET', '/api/scan');
  const before = (await admin('GET', '/api/impact?days=30')).body;
  await admin('GET', '/api/scan?branches=all&zeroLoc=keep');
  const after = (await admin('GET', '/api/impact?days=30')).body;
  assert.equal(after.debt.now, before.debt.now, `the open backlog stays ${before.debt.now}`);
});

test('the report says its branch; credits verified twice keep to it; a tracked report saves it', async () => {
  await admin('GET', '/api/scan');
  const report = await admin('POST', '/api/reports/html', { projectIds: null, severities: null, buckets: [] });
  assert.equal(report.status, 200);
  assert.match(report.text, /class="branch-focus">[^<]*<?[^>]*>?Branch: each project(&#39;|')s primary branch/);
  assert.doesNotMatch(report.text, /p0-r4\b/, 'a feature branch finding is not in the report');

  const v = await admin('POST', '/api/credits/verify', { projectIds: ['p0'], severities: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.verified[0].agreed, true);
  assert.equal(v.body.projects.p0.totalRisks, 8, 'the verified read keeps to the primary branch too');

  const made = await admin('POST', '/api/tracked-reports', { name: 'Main only', severities: [], buckets: [], windows: {} });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const listed = (await admin('GET', '/api/tracked-reports')).body.reports.find((r) => r.name === 'Main only');
  assert.equal(listed.filters?.branches, 'primary');
  const refreshed = await admin('POST', `/api/tracked-reports/${listed.id}/refresh`, {});
  assert.equal(refreshed.status, 200, refreshed.text.slice(0, 300));
});

test('the calculator counts primary-branch scans, says how each branch was chosen, and each project’s open findings', async () => {
  const read = await admin('POST', '/api/projections/fusion/read', {});
  assert.equal(read.status, 200, read.text.slice(0, 300));
  const byId = Object.fromEntries(read.body.projects.map((p) => [p.id, p]));
  assert.deepEqual([byId.p0.branch, byId.p0.branchHow], ['main', 'primary']);
  assert.equal(byId.p6.branchHow, 'none');
  assert.equal(byId.p6.scanCount, 0, 'its primary branch was never scanned');
  assert.equal(byId.p5.loc, 0);
  assert.ok(byId.p1.openByEngine && byId.p1.openByEngine.SAST > 0, JSON.stringify(byId.p1.openByEngine));
  assert.equal(read.body.tr.totals.meta.branches, 'primary');
  // p0 is scanned 400 times a year, one scan in three on a feature branch: those are not counted.
  const every = await admin('POST', '/api/projections/fusion/read', { branches: 'all' });
  const all0 = every.body.projects.find((p) => p.id === 'p0');
  assert.ok(all0.scanCount > byId.p0.scanCount, `${all0.scanCount} > ${byId.p0.scanCount}`);
  assert.equal(every.body.tr.totals.meta.branches, 'all');
});

test("a scheduled run reminds about each project's primary branch only, unless it is set to every branch", async () => {
  const saved = await admin('PUT', '/api/automation', { dryRun: true, mode: 'digest', thresholds: '1' });
  assert.equal(saved.status, 200, saved.text.slice(0, 300));
  assert.deepEqual([saved.body.config.branches, saved.body.config.leaveOutNoCode], ['primary', true]);
  const primary = await admin('POST', '/api/automation/run', {});
  assert.equal(primary.status, 200, primary.text.slice(0, 300));
  assert.equal(primary.body.run.scanned, 98, JSON.stringify(primary.body.run).slice(0, 300));
  await admin('PUT', '/api/automation', { branches: 'all', leaveOutNoCode: false });
  const every = await admin('POST', '/api/automation/run', {});
  assert.equal(every.body.run.scanned, 150);
});
