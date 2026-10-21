// Making a Beta feature final, for real: an Admin promotes "Code authors"; from then on
// someone who may only send reminders can use it, scheduled reminders can email the code
// authors, and the change is audited. Only an Admin may change a stage.
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
let log = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A browser of its own (its own cookie). */
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

let dataDir = '';

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'features-'));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '2', RISKS: '4' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: KEY, CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD,
      // Never a real git host from a test: no token from the machine running it.
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

test('while Beta: only people with Beta access can use it, and the Admin sees the switch', async () => {
  const list = await admin('GET', '/api/features');
  assert.equal(list.status, 200);
  assert.equal(list.body.canManage, true);
  assert.deepEqual(list.body.features.map((f) => [f.id, f.stage]), [['codeAuthors', 'beta'], ['sla', 'beta'], ['identityMatching', 'beta'], ['fusionResults', 'beta']]);
  const me = (await user('GET', '/api/me')).body;
  assert.equal(me.features.codeAuthors, 'beta');
  assert.ok(!me.permissions.includes('feature.codeAuthors'));
  assert.equal((await user('POST', '/api/beta/authors/find', {})).status, 403);
  assert.equal((await user('GET', '/api/features')).body.canManage, false);
});

test('only an Admin can make it final; then whoever may send reminders can use it, and it is audited', async () => {
  assert.equal((await user('PUT', '/api/features/codeAuthors', { stage: 'final' })).status, 403);
  assert.equal((await admin('PUT', '/api/features/codeAuthors', { stage: 'gold' })).status, 400);
  assert.equal((await admin('PUT', '/api/features/nope', { stage: 'final' })).status, 404);
  const made = await admin('PUT', '/api/features/codeAuthors', { stage: 'final' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.features[0].stage, 'final');
  assert.equal(made.body.features[0].changedBy, 'admin@acme.io');

  const me = (await user('GET', '/api/me')).body;
  assert.equal(me.features.codeAuthors, 'final');
  assert.ok(me.permissions.includes('feature.codeAuthors'));
  assert.ok(!me.permissions.includes('feature.identityMatching'), 'the other one is still Beta');
  // Allowed now: it only asks for a fetch first.
  assert.equal((await user('POST', '/api/beta/authors/find', {})).status, 409);
  assert.equal((await user('GET', '/api/beta/scm/logins?provider=github')).status, 403, 'identity matching is still Beta');

  const audit = await admin('GET', '/api/audit?type=system');
  const reasons = (audit.body.entries ?? audit.body.events ?? []).map((e) => e.reason).join('\n');
  assert.match(reasons, /Code authors \(git blame\)” made final/);
});

test('scheduled reminders also look up the code authors of what crossed, once switched on', async () => {
  const saved = await admin('PUT', '/api/automation', { notifyCodeAuthors: true, dryRun: true, mode: 'digest', thresholds: '1' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.config.notifyCodeAuthors, true);
  const ran = await admin('POST', '/api/automation/run', {});
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  const run = ran.body.run;
  assert.ok(run.crossed > 0, JSON.stringify(run));
  assert.ok(run.codeAuthors && typeof run.codeAuthors.findings === 'number', JSON.stringify(run.codeAuthors));
  assert.ok(!run.codeAuthors.error, run.codeAuthors.error);
});

test('back to Beta: access closes again, and scheduled runs leave the code authors alone', async () => {
  assert.equal((await admin('PUT', '/api/features/codeAuthors', { stage: 'beta' })).status, 200);
  assert.equal((await user('POST', '/api/beta/authors/find', {})).status, 403);
  const run = (await admin('POST', '/api/automation/run', {})).body.run;
  assert.match(run.codeAuthors?.skipped ?? '', /still a Beta feature/);
});

test('SLAs (Beta): only those who may use them change them; fetched projects carry overdue and due-soon; runs escalate once', async () => {
  // Not for someone without Beta access, while Beta.
  assert.ok(!(await user('GET', '/api/me')).body.permissions.includes('feature.sla'));
  const refused = await user('PUT', '/api/settings', { sla: { days: { CRITICAL: 1 } } });
  assert.ok(refused.status === 403 || refused.body?.ignored?.includes('sla') || refused.body?.sla?.days?.CRITICAL !== 1, JSON.stringify(refused.body).slice(0, 200));

  const set = await admin('PUT', '/api/settings', { sla: { days: { CRITICAL: 2, HIGH: 2, MEDIUM: 2, LOW: 2 }, escalate: true, escalateTo: 'lead@acme.io' } });
  assert.equal(set.status, 200, JSON.stringify(set.body).slice(0, 300));
  assert.deepEqual(set.body.sla.days, { CRITICAL: 2, HIGH: 2, MEDIUM: 2, LOW: 2 });
  assert.deepEqual(set.body.sla.escalateTo, ['lead@acme.io']);

  const scan = await admin('GET', '/api/scan');
  assert.equal(scan.status, 200);
  const overdue = scan.body.projects.reduce((n, p) => n + p.sla.overdue, 0);
  assert.ok(overdue > 0, 'the mock findings are weeks old: past a 2-day SLA');
  assert.equal(scan.body.totals.sla.overdue, overdue);
  const last = await admin('GET', '/api/scan/last');
  assert.equal(last.body.totals.sla.overdue, overdue, 'a reload shows them as they are now');

  // Test mode: counted, nothing sent, nothing remembered.
  await admin('PUT', '/api/automation', { dryRun: true, notifyCodeAuthors: false });
  const run = (await admin('POST', '/api/automation/run', {})).body.run;
  assert.equal(run.escalation?.dryRun, true, JSON.stringify(run));
  assert.ok(run.escalation.escalated > 0);
  const again = (await admin('POST', '/api/automation/run', {})).body.run;
  assert.equal(again.escalation.escalated, run.escalation.escalated, 'test mode remembered nothing, so the same findings are counted again');

  // Issues in the repositories: the mock projects are on github.com, and no token is connected,
  // so each project is skipped with the reason, and nothing is remembered.
  const withIssues = await admin('PUT', '/api/settings', { sla: { openIssues: true } });
  assert.equal(withIssues.body.sla.openIssues, true);
  const issuesRun = (await admin('POST', '/api/automation/run', {})).body.run;
  assert.equal(issuesRun.escalation.issues.opened, 0, JSON.stringify(issuesRun.escalation));
  assert.ok(issuesRun.escalation.issues.skipped.length > 0);
  assert.ok(issuesRun.escalation.issues.skipped.every((s) => /No GitHub token/.test(s.reason)), JSON.stringify(issuesRun.escalation.issues.skipped));

  // Escalation off: nothing about SLAs in the run.
  await admin('PUT', '/api/settings', { sla: { escalate: false, openIssues: false } });
  const off = (await admin('POST', '/api/automation/run', {})).body.run;
  assert.equal(off.escalation, undefined);
});

test('who gets reminders is one choice: scheduled runs follow it, and "both" with an empty fixed list says so', async () => {
  const set = await admin('PUT', '/api/settings', { reminders: { audience: 'both' }, recipients: { to: '', cc: '', bcc: '' } });
  assert.equal(set.status, 200, JSON.stringify(set.body).slice(0, 200));
  assert.equal(set.body.reminders.audience, 'both');
  await admin('PUT', '/api/automation', { dryRun: true, mode: 'digest', thresholds: '1', notifyCodeAuthors: false });
  const run = (await admin('POST', '/api/automation/run', {})).body.run;
  assert.ok(run.crossed > 0, JSON.stringify(run));
  assert.ok((run.failures ?? []).some((f) => /fixed list is empty/.test(f.error)), JSON.stringify(run.failures));
  // Someone who may not change the list cannot change who gets reminders either.
  const theirs = await user('PUT', '/api/settings', { reminders: { audience: 'list' } });
  assert.notEqual(theirs.body?.reminders?.audience, 'list');
  await admin('PUT', '/api/settings', { reminders: { audience: 'initiator' } });
});

test('full image update (Beta): the server says it started, and asks the companion only when it is there, once at a time', async () => {
  const dir = path.join(dataDir, 'updater');
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  const ack = JSON.parse(fs.readFileSync(path.join(dir, 'ack.json'), 'utf8'));
  assert.equal(ack.version, version, 'written at start, for the companion');

  assert.equal((await user('POST', '/api/system/update/full', { tag: 'latest' })).status, 403, 'Admins only');
  const before = await admin('GET', '/api/system/update');
  assert.equal(before.body.companion.connected, false);
  const refused = await admin('POST', '/api/system/update/full', { tag: 'latest' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /not running/);

  fs.writeFileSync(path.join(dir, 'companion.json'), JSON.stringify({ at: new Date().toISOString(), engine: 'ok', container: 'mission-zero' }));
  assert.equal((await admin('POST', '/api/system/update/full', { tag: 'latest; reboot' })).status, 400);
  const asked = await admin('POST', '/api/system/update/full', { tag: 'latest' });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  assert.equal(asked.body.companion.pending.tag, 'latest');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8')).tag, 'latest');
  assert.equal((await admin('POST', '/api/system/update/full', { tag: 'latest' })).status, 409, 'one at a time');
  fs.rmSync(path.join(dir, 'request.json'));
  fs.rmSync(path.join(dir, 'companion.json'));
});

test('Fusion results (Beta): its own fetch, Fusion results only, by new severity; once final, for whoever loads findings', async () => {
  assert.equal((await user('POST', '/api/beta/fusion/fetch', {})).status, 403, 'Beta: not for a role without Beta access');
  // Nothing loaded from the Workbench: the page's own line, nothing named, is every project.
  const read = await admin('POST', '/api/beta/fusion/fetch', {});
  assert.equal(read.status, 200, JSON.stringify(read.body).slice(0, 300));
  const { fusion, scope } = read.body;
  assert.equal(fusion.available, true);
  assert.equal(scope.projects, 2);
  // The mock: p0 has one result raised to critical; p1 one raised to high and one lowered to low.
  assert.deepEqual(
    { total: fusion.totals.total, CRITICAL: fusion.totals.CRITICAL, HIGH: fusion.totals.HIGH, LOW: fusion.totals.LOW, raisedToTop: fusion.totals.raisedToTop, lowered: fusion.totals.lowered },
    { total: 3, CRITICAL: 1, HIGH: 1, LOW: 1, raisedToTop: 2, lowered: 1 },
  );
  assert.equal(fusion.projects.p1.total, 2);
  // Each result opens in Checkmarx One: its project's Risk Hub, with the result open.
  assert.match(fusion.results.find((r) => r.projectId === 'p1').url, /\/riskhub\/p1\?.*resultId=p1-r/);
  assert.equal(fusion.applications.find((a) => a.id === 'app-0').scan.status, 'Completed');
  assert.equal((await admin('GET', '/api/beta/fusion')).body.fusion.totals.total, 3, 'kept with the session');
  // Narrowed on its line: by a project's name (wildcards), and nothing that matches is said.
  const one = await admin('POST', '/api/beta/fusion/fetch', { projects: 'Project 1*' });
  assert.equal(one.status, 200, JSON.stringify(one.body).slice(0, 300));
  assert.deepEqual([one.body.scope.projects, one.body.fusion.totals.total], [1, 2]);
  assert.deepEqual(one.body.scope.own, { applications: [], projects: ['Project 1*'] });
  assert.equal((await admin('POST', '/api/beta/fusion/read', {})).body.scope.projects, 1, 'read again: what the line loaded');
  assert.equal((await admin('POST', '/api/beta/fusion/fetch', { applications: 'No such app' })).status, 400);
  await admin('POST', '/api/beta/fusion/fetch', {});

  assert.equal((await admin('PUT', '/api/features/fusionResults', { stage: 'final' })).status, 200);
  assert.ok((await user('GET', '/api/me')).body.permissions.includes('feature.fusionResults'), 'whoever loads findings');
  assert.equal((await user('POST', '/api/beta/fusion/fetch', {})).body.fusion.totals.total, 3);
  assert.equal((await admin('PUT', '/api/features/fusionResults', { stage: 'beta' })).status, 200);
  assert.equal((await user('GET', '/api/beta/fusion')).status, 403);
});

test('Fusion results: an Admin allocates for and triages only the findings Fusion re-scored; nobody else may', async () => {
  // Acting needs the findings themselves, which the Workbench loads; only those Fusion lists are acted on.
  await admin('GET', '/api/scan');
  const read = await admin('POST', '/api/beta/fusion/fetch', {});
  const { credits } = read.body;
  // The mock's Fusion results are p0-r0 (critical), p1-r0 (critical) and p1-r1 (high), all awaiting triage.
  assert.equal(credits.matched, 3, JSON.stringify(credits));
  assert.deepEqual(credits.triage, { CRITICAL: 2, HIGH: 1, MEDIUM: 0, LOW: 0 });
  assert.equal(credits.projects, 2);

  const given = await admin('POST', '/api/beta/fusion/allocate', { kind: 'triage', severities: ['CRITICAL', 'HIGH'] });
  assert.equal(given.status, 200, JSON.stringify(given.body).slice(0, 300));
  assert.ok(given.body.credits.left.triage >= 3, 'enough for the three, and no more needed');
  const run = await admin('POST', '/api/beta/fusion/triage', { severities: ['CRITICAL', 'HIGH'], notifyInitiators: false });
  assert.equal(run.status, 200, JSON.stringify(run.body).slice(0, 300));
  assert.equal(run.body.requested, 3, 'only the Fusion results, not the projects\' other findings');
  assert.deepEqual(run.body.credits.triage, { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }, 'sent: no longer waiting');

  await admin('PUT', '/api/features/fusionResults', { stage: 'final' });
  await user('GET', '/api/scan');
  await user('POST', '/api/beta/fusion/fetch', {});
  assert.equal((await user('POST', '/api/beta/fusion/triage', { severities: ['CRITICAL'] })).status, 403, 'Admins only');
  await admin('PUT', '/api/features/fusionResults', { stage: 'beta' });
});

test('Fusion troubleshooting: test paths (only under /api, read-only), debug log with the token hidden, pin the one that answers', async () => {
  await admin('POST', '/api/beta/fusion/fetch', {});
  assert.equal((await admin('POST', '/api/beta/fusion/probe', { paths: ['http://169.254.169.254/latest'] })).status, 400, 'never another host');
  assert.equal((await admin('POST', '/api/beta/fusion/probe', { paths: ['/api/a/../../etc'] })).status, 400);
  const probe = await admin('POST', '/api/beta/fusion/probe', { paths: ['/api/correlation/results/applications', '/api/fusion-results/applications', '/api/correlation/dispatcher/{appId}/scan-status'] });
  assert.equal(probe.status, 200, JSON.stringify(probe.body).slice(0, 300));
  assert.deepEqual(probe.body.results.map((r) => r.status), [200, 404, 200]);
  assert.match(probe.body.results[0].answer, /app-0/);
  assert.ok(probe.body.exchanges.length >= 3, 'every call in full');
  assert.ok(!JSON.stringify(probe.body.exchanges).includes('.tok'), 'the access token is never in it');
  assert.equal(probe.body.exchanges[0].request.headers.Authorization, 'Bearer [hidden]');

  const on = await admin('PUT', '/api/beta/fusion/debug', { on: true, clear: true });
  assert.equal(on.body.on, true);
  await admin('POST', '/api/beta/fusion/read', {});
  const log = (await admin('GET', '/api/beta/fusion/debug')).body;
  assert.ok(log.log.some((e) => e.url.endsWith('/api/correlation/results/applications') && e.status === 200 && e.body.includes('app-0')), 'the read logged in full');
  assert.ok(!JSON.stringify(log.log).includes('.tok'));
  await admin('PUT', '/api/beta/fusion/debug', { on: false, clear: true });

  const pinned = await admin('PUT', '/api/settings', { endpoints: { fusionResultsPath: '/api/correlation/results' } });
  assert.equal(pinned.status, 200);
  assert.equal((await admin('GET', '/api/beta/fusion/debug')).body.pinned.results, '/api/correlation/results');
  assert.equal((await admin('PUT', '/api/settings', { endpoints: { fusionResultsPath: 'https://evil.example/api' } })).body.endpoints?.fusionResultsPath ?? '', '', 'a bad path is not kept');
  assert.equal((await admin('POST', '/api/beta/fusion/read', {})).body.fusion.available, true, 'read from the pinned path');
  await admin('PUT', '/api/settings', { endpoints: { fusionResultsPath: '' } });

  await admin('PUT', '/api/features/fusionResults', { stage: 'final' });
  assert.equal((await user('POST', '/api/beta/fusion/probe', { paths: ['/api/flags'] })).status, 403, 'only who manages the Checkmarx One integration');
  assert.equal((await user('GET', '/api/beta/fusion/debug')).status, 403);
  await admin('PUT', '/api/features/fusionResults', { stage: 'beta' });
});
