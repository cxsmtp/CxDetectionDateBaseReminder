// Govern (beta), for real against the mock Checkmarx One: held back until its activation code; consumption read for
// every dimension (the unknown-viewBy trap caught); attribution with sticky decisions; budgets in Monitor and Enforce;
// restrictions as holds (AI roles off, partly when a group grants them; Auto Triage and PR remediation off and put
// back exactly); an admin's restore with its grace, and a re-breach; credit requests; the lossless CSV; a partial
// poll that changes nothing; signed webhooks; per-person alert state; permissions; and the audit chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';
import { FIRST_PASSWORD, NEXT_PASSWORD, mockApiKey } from './test-credentials.js';

const MOCK_PORT = await freePort();
const PORT = await freePort();
const HOOK_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const KEY = mockApiKey({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' });
const SECRET = `whsec-${randomBytes(12).toString('hex')}`;
const children = [];
const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'govern-key-'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'govern-'));
const script = (...args) => execFileSync(process.execPath, ['scripts/activation.mjs', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const publicKey = script('keygen', path.join(keyDir, 'issuer.pem')).split('\n').pop();
let log = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hooks = [];
const hookServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    hooks.push({ headers: req.headers, body });
    res.writeHead(204);
    res.end();
  });
});

function browser() {
  let cookie = '';
  return async (method, url, body, headers = {}) => {
    const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, body: json, text, headers: r.headers };
  };
}
const admin = browser();
const champ = browser();
const ana = browser();
const uma = browser();
const mock = async (p) => (await fetch(MOCK + p)).json();

/** Ask until `done` says so. */
async function until(read, done, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(value).slice(0, 1200)}\n${log.slice(-1500)}`);
    await sleep(100);
  }
}
/** Run a cycle now and wait for it to finish. */
async function cycle(as = admin) {
  const started = await as('POST', '/api/govern/run');
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { body } = await until(() => as('GET', `/api/govern/runs/${started.body.runId}`), (r) => r.body?.run?.finishedAt, 'the cycle');
  return body.run;
}
const restrictions = async () => (await admin('GET', '/api/govern/restrictions')).body.items;
const budgetRow = async (id) => (await admin('GET', `/api/govern/budgets/${id}`)).body.budget;

test.before(async () => {
  await new Promise((r) => hookServer.listen(HOOK_PORT, '127.0.0.1', r));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '8', RISKS: '4', GOVERN: '1' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: KEY, CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme', MZ_ACTIVATION_TEST_KEY: publicKey, GOVERN_TICK_MS: '300',
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
  for (const [as, email, role] of [[champ, 'champ@acme.io', 'champion'], [ana, 'ana@acme.io', 'analyst'], [uma, 'uma@acme.io', 'user']]) {
    assert.equal((await admin('POST', '/api/iam/users', { email, role, password: FIRST_PASSWORD })).status, 201, role);
    await as('POST', '/api/session/password', { email, password: FIRST_PASSWORD });
    assert.equal((await as('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD })).status, 200);
  }
});

test.after(() => {
  for (const child of children) child.kill();
  hookServer.close();
});

test('held back until its activation code; then for Govern permission holders, each seeing what their role allows', async () => {
  const locked = await admin('GET', '/api/govern/overview');
  assert.equal(locked.status, 403);
  assert.equal(locked.body.locked, true);
  const applied = await admin('POST', '/api/activation', { code: script('feature', path.join(keyDir, 'issuer.pem'), 'Acme', 'govern', 'on') });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.match(applied.body.applied, /Govern \(Labs\) turned on/);
  // Cycles on demand only in this test (the tick still drains notifications).
  assert.equal((await admin('PUT', '/api/govern/settings', { cycleMinutes: 0 })).status, 200);
  assert.equal((await admin('GET', '/api/me')).body.unlocked.govern, true);
  const me = (await admin('GET', '/api/govern/me')).body;
  assert.equal(me.permissions.length, 8, 'Admin holds every govern permission');
  assert.ok((await champ('GET', '/api/me')).body.permissions.includes('feature.govern'), 'the Security Champion without Beta access');
  assert.deepEqual((await uma('GET', '/api/govern/me')).body.permissions, ['govern.request']);
  assert.deepEqual((await ana('GET', '/api/govern/me')).body.permissions, ['govern.view', 'govern.request']);
  // What each may do.
  assert.equal((await uma('GET', '/api/govern/restrictions')).status, 403);
  assert.equal((await ana('POST', '/api/govern/budgets', { entityType: 'project', entityId: 'p1', amount: 5 })).status, 403);
  assert.equal((await champ('GET', '/api/govern/settings')).status, 403, 'not Govern settings');
  const settings = (await admin('GET', '/api/govern/settings')).body.settings;
  assert.deepEqual(settings.aiRoles, ['view-risk-management', 'view-risk-management-dashboard', 'view-risk-management-tab']);
});

test('a cycle reads every dimension once, catches the unknown-viewBy trap, and the org; GETs answer from memory', async () => {
  await mock('/__reset');
  const run = await cycle();
  assert.equal(run.status, 'success', JSON.stringify(run));
  assert.equal(run.steps.consumption.group.supported, false, 'group answers with the user view: not reported');
  assert.equal(run.steps.consumption.user.complete, true);
  assert.equal(run.steps.org.users, 6, 'users/v2 paged with first/max');
  assert.equal(run.steps.org.groups, 4);
  const overview = await admin('GET', '/api/govern/overview');
  assert.equal(overview.status, 200);
  assert.deepEqual(overview.body.banners.notReported, ['group']);
  assert.ok(overview.body.byAction.some((a) => a.action === 'triage'));
  assert.equal(overview.body.figures.tenantCredits.total, 30000);
  assert.ok(overview.body.top.user.some((u) => u.entityId === 'u-admin' && u.credits === 40));
  // Groups: their projects summed, since Checkmarx One does not report them.
  assert.equal(overview.body.top.group, null);
  // An unchanged view answers 304, and no read reaches Checkmarx One.
  const etag = overview.headers.get('etag');
  const before = (await mock('/__stats')).counts;
  assert.equal((await admin('GET', '/api/govern/overview', undefined, { 'If-None-Match': etag })).status, 304);
  for (let i = 0; i < 5; i += 1) await admin('GET', '/api/govern/budgets');
  assert.deepEqual((await mock('/__stats')).counts, before, 'no Checkmarx One call per page view');
});

test('attribution: exact, automation and bots apart, duplicate names disputed; a rejection sticks across cycles', async () => {
  const all = (await admin('GET', '/api/govern/attribution?dimension=user&limit=100')).body.items;
  const by = (name) => all.find((r) => r.name === name);
  assert.equal(by('julian-chuan').status, 'exact', 'cx- prefixed username matched');
  assert.equal(by('julian-chuan').entityId, 'u-julian');
  assert.equal(by('Sean Casey').tab, 'disputes', 'two Sean Caseys are never merged');
  assert.equal(by('Sean Casey').suggestions.length, 2);
  assert.equal(by('Auto-triage').status, 'automation');
  assert.equal(by('dependabot[bot]').status, 'bot');
  // Reject the match: it must never re-attach.
  const reject = await champ('POST', '/api/govern/attribution/decide', { key: by('julian-chuan').key, action: 'reject', why: 'a shared account' });
  assert.equal(reject.status, 200, JSON.stringify(reject.body));
  assert.notEqual(reject.body.row.entityId, 'u-julian');
  await cycle();
  const again = (await admin('GET', '/api/govern/attribution?dimension=user&limit=100')).body.items.find((r) => r.name === 'julian-chuan');
  assert.notEqual(again.entityId, 'u-julian', 'still rejected after another cycle');
  assert.deepEqual(again.decision.rejected, ['u-julian']);
  // Pin a disputed one.
  const pin = await champ('POST', '/api/govern/attribution/decide', { key: by('Sean Casey').key, action: 'pin', entityId: 'u-sean1' });
  assert.equal(pin.body.row.status, 'pinned');
  assert.equal((await uma('POST', '/api/govern/attribution/decide', { key: by('Sean Casey').key, action: 'clear' })).status, 403);
});

let adminBudget;
let umaBudget;

test('Enforce: a used-up user budget removes the AI roles (view-scans kept); one a group grants is only partly restricted', async () => {
  // Monitor is the default, and only a holder of govern.enforce switches a budget to Enforce.
  const monitor = await admin('POST', '/api/govern/budgets', { entityType: 'user', entityId: 'u-champ', amount: 1, countExisting: true });
  assert.equal(monitor.status, 201, JSON.stringify(monitor.body));
  assert.equal(monitor.body.budget.mode, 'monitor');
  assert.equal(monitor.body.budget.status, 'over');
  const create = await champ('POST', '/api/govern/budgets', { entityType: 'user', entityId: 'u-admin', amount: 10, period: 'monthly', countExisting: true, mode: 'enforce' });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  adminBudget = create.body.budget;
  assert.equal(adminBudget.used, 40);
  const r = await until(restrictions, (list) => list.some((x) => x.key === 'user_roles|u-admin' && x.state === 'applied'), 'the restriction');
  assert.equal(r.find((x) => x.key === 'user_roles|u-admin').because[0].budgetId, adminBudget.id);
  const iam = await mock('/__iam');
  assert.deepEqual(iam.direct['u-admin'], ['view-scans'], 'the AI roles removed; view-scans is not in the default list');
  assert.equal((await budgetRow(adminBudget.id)).status, 'restricted');
  // Uma: view-risk-management directly (removed), view-risk-management-tab from her group team-a (not AI-only): partial.
  const u = await admin('POST', '/api/govern/budgets', { entityType: 'user', entityId: 'u-uma', amount: 5, countExisting: true, mode: 'enforce' });
  umaBudget = u.body.budget;
  const list = await until(restrictions, (l) => l.some((x) => x.key === 'user_roles|u-uma' && x.state === 'partial'), 'the partial restriction');
  assert.match(list.find((x) => x.key === 'user_roles|u-uma').partial.join(' '), /team-a grants view-risk-management-tab/);
  assert.deepEqual((await mock('/__iam')).direct['u-uma'], []);
  assert.equal((await budgetRow(umaBudget.id)).status, 'partial', 'never "restricted" while an AI role remains');
  // MZ's own spend is not stopped by a Monitor budget.
  const feed = (await admin('GET', '/api/govern/alerts?category=enforcement')).body;
  assert.ok(feed.items.some((a) => a.severity === 'critical' && /Restricted: AI roles removed/.test(a.title)));
});

test('an admin restore puts the roles back with a grace; more usage re-breaches and restricts again', async () => {
  assert.equal((await ana('POST', '/api/govern/restrictions/restore', { keys: ['user_roles|u-admin'] })).status, 403);
  const restore = await champ('POST', '/api/govern/restrictions/restore', { keys: ['user_roles|u-admin'] });
  assert.equal(restore.status, 202, JSON.stringify(restore.body));
  await until(restrictions, (l) => !l.some((x) => x.key === 'user_roles|u-admin'), 'the restore');
  assert.deepEqual((await mock('/__iam')).direct['u-admin'].sort(), ['view-risk-management', 'view-risk-management-dashboard', 'view-scans']);
  const row = await budgetRow(adminBudget.id);
  assert.equal(row.grace.usageAtRestore, 40);
  await cycle();
  assert.ok(!(await restrictions()).some((x) => x.key === 'user_roles|u-admin'), 'the grace holds while usage does not grow');
  // Usage grows: the grace ends and a new hold is made in the same period (B4).
  await mock('/__consumption?key=user:admin@acme.io&add=5');
  await cycle();
  await until(restrictions, (l) => l.some((x) => x.key === 'user_roles|u-admin' && x.state === 'applied'), 're-breach');
  assert.deepEqual((await mock('/__iam')).direct['u-admin'], ['view-scans']);
});

test('credit requests: a User asks for themself and sees only their own; approval raises the budget and lifts the restriction', async () => {
  const asked = await uma('POST', '/api/govern/requests', { entityType: 'user', amount: 50, reason: 'Triage backlog for the release' });
  assert.equal(asked.status, 201, JSON.stringify(asked.body));
  assert.equal(asked.body.request.entityId, 'u-uma');
  assert.equal((await uma('POST', '/api/govern/requests', { entityType: 'user', entityId: 'u-admin', amount: 5, reason: 'x' })).status, 403, 'only for themself');
  const mine = (await uma('GET', '/api/govern/requests')).body;
  assert.equal(mine.total, 1);
  const personal = (await uma('GET', '/api/govern/overview')).body;
  assert.equal(personal.personal, true);
  assert.equal(personal.budget.entityId, 'u-uma');
  assert.equal(personal.requests.length, 1);
  assert.equal((await uma('GET', '/api/govern/budgets')).body.total, 1, 'only her own budget');
  const id = asked.body.request.id;
  assert.equal((await uma('POST', `/api/govern/requests/${id}/decide`, { decision: 'approve' })).status, 403);
  assert.equal((await champ('POST', `/api/govern/requests/${id}/decide`, { decision: 'approve', amount: 60 })).status, 400, 'never more than asked');
  const q = await champ('POST', `/api/govern/requests/${id}/comment`, { text: 'Which release?' });
  assert.equal(q.body.request.thread.length, 1);
  const ok = await champ('POST', `/api/govern/requests/${id}/decide`, { decision: 'approve', amount: 50 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.budget.limit, 55);
  assert.equal(ok.body.request.status, 'approved');
  await until(restrictions, (l) => !l.some((x) => x.key === 'user_roles|u-uma'), 'the release after approval');
  assert.deepEqual((await mock('/__iam')).direct['u-uma'], ['view-risk-management']);
  assert.equal((await champ('POST', `/api/govern/requests/${id}/decide`, { decision: 'deny', reason: 'late' })).status, 409);
});

test('a project budget turns Auto Triage and PR remediation off, keeping the rest of the configuration; deleting it puts both back', async () => {
  const p = await champ('POST', '/api/govern/budgets', { entityType: 'project', entityId: 'p2', amount: 1, countExisting: true, mode: 'enforce' });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  await until(restrictions, (l) => ['auto_triage|p2', 'pr_remediation|p2'].every((k) => l.some((x) => x.key === k && x.state === 'applied')), 'project restrictions');
  const state = await mock('/__autotriage');
  const config = state.autoTriage.p2;
  assert.equal(config.configurations.find((c) => c.feature === 'auto_triage').enabled, false);
  assert.deepEqual(config.configurations.find((c) => c.feature === 'auto_triage').allowOverride, { branches: true }, 'allowOverride kept');
  assert.ok(config.configurations.some((c) => c.feature === 'auto_remediation'), 'other features kept');
  assert.equal(config.scope, 'project');
  assert.deepEqual(state.pr['228402|p2'], []);
  const del = await champ('DELETE', `/api/govern/budgets/${p.body.budget.id}`);
  assert.equal(del.status, 200);
  await until(restrictions, (l) => !l.some((x) => x.key.endsWith('|p2')), 'project release');
  const after = await mock('/__autotriage');
  assert.equal(after.autoTriage.p2.configurations.find((c) => c.feature === 'auto_triage').enabled, true);
  assert.deepEqual(after.pr['228402|p2'], ['CRITICAL', 'HIGH']);
});

test('CSV: export then validate changes nothing; one edited cell is exactly one change; apply needs the plan hash and fresh versions', async () => {
  const csv = await admin('GET', '/api/govern/budgets.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /govern-budgets-/);
  const same = await admin('POST', '/api/govern/csv/validate', { csv: csv.text });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.deepEqual([same.body.summary.create, same.body.summary.update, same.body.summary.errors], [0, 0, 0]);
  // One cell: Uma's amount 5 → 7.
  const lines = csv.text.split('\n');
  const i = lines.findIndex((l) => l.includes(',u-uma,'));
  const cells = lines[i].split(',');
  cells[5] = '7.5';
  lines[i] = cells.join(',');
  const edited = lines.join('\n');
  const one = await admin('POST', '/api/govern/csv/validate', { csv: edited });
  assert.equal(one.body.summary.update, 1);
  assert.deepEqual(one.body.rows.find((r) => r.action === 'update').changes, [{ field: 'amount', before: 5, after: 7.5 }]);
  assert.equal((await admin('POST', '/api/govern/csv/apply', { csv: edited, planHash: 'nope' })).status, 409);
  const applied = await admin('POST', '/api/govern/csv/apply', { csv: edited, planHash: one.body.planHash });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal((await budgetRow(umaBudget.id)).amount, 7.5);
  // The first export is now out of date for that budget.
  const stale = await admin('POST', '/api/govern/csv/validate', { csv: edited });
  assert.match(stale.body.errors[0].error, /changed since this file was exported/);
  // A header typo is refused, not silently ignored.
  assert.equal((await admin('POST', '/api/govern/csv/validate', { csv: csv.text.replace('mode', 'enforced') })).status, 400);
  // Switching to Enforce by CSV needs govern.enforce too: a Monitor budget turned Enforce by an analyst… is refused (no govern.budgets).
  assert.equal((await ana('POST', '/api/govern/csv/validate', { csv: csv.text })).status, 403);
});

test('a partial poll changes nothing: the dimension is stale, no restriction is lifted or made', async () => {
  assert.equal((await admin('PUT', '/api/govern/settings', { pageSize: 2 })).status, 200);
  await mock('/__govern-fail?view=user&on=1');
  // Usage falls under the budget in a poll that is incomplete: nothing may be released on it.
  const before = (await restrictions()).filter((x) => x.key === 'user_roles|u-admin');
  const run = await cycle();
  assert.equal(run.status, 'partial');
  assert.equal(run.steps.consumption.user.complete, false);
  assert.deepEqual((await restrictions()).filter((x) => x.key === 'user_roles|u-admin').map((x) => x.state), before.map((x) => x.state));
  const overview = (await admin('GET', '/api/govern/overview')).body;
  assert.ok(overview.banners.stale.includes('user'));
  assert.equal((await budgetRow(adminBudget.id)).stale, true);
  await mock('/__govern-fail?view=user&on=0');
  assert.equal((await cycle()).steps.consumption.user.complete, true, 'read in pages of 2 when it answers');
  assert.equal((await admin('PUT', '/api/govern/settings', { pageSize: 1000 })).status, 200);
});

test('notifications: a signed webhook (HMAC over timestamp and body), the secret never shown; read state per person', async () => {
  assert.equal((await admin('PUT', '/api/govern/settings', { notify: { webhook: { url: 'http://example.com/hook' } } })).status, 400, 'https only');
  assert.equal((await admin('PUT', '/api/govern/settings', { notify: { webhook: { url: 'https://169.254.169.254/latest' } } })).status, 400, 'never cloud metadata');
  const set = await admin('PUT', '/api/govern/settings', { notify: { minSeverity: 'info', webhook: { on: true, url: `http://127.0.0.1:${HOOK_PORT}/hook`, secret: SECRET, minSeverity: 'info' } } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.settings.notify.webhook.secretSet, true);
  assert.ok(!JSON.stringify(set.body).includes(SECRET));
  assert.ok(!JSON.stringify((await admin('GET', '/api/govern/settings')).body).includes(SECRET));
  const tested = await admin('POST', '/api/govern/settings/test', { channel: 'webhook' });
  assert.equal(tested.status, 200, JSON.stringify(tested.body));
  const verify = (h) => h.headers['x-mz-signature'] === `sha256=${createHmac('sha256', SECRET).update(`${h.headers['x-mz-timestamp']}.`).update(h.body).digest('hex')}`;
  assert.ok(hooks.length >= 1 && verify(hooks.at(-1)), 'signed: sha256=hex(HMAC(secret, ts + "." + body))');
  // A new alert goes out through the outbox, on its own, signed.
  await champ('POST', '/api/govern/budgets', { entityType: 'project', entityId: 'p3', amount: 1000, warnPct: 1, countExisting: true });
  const delivered = await until(async () => hooks.filter((h) => JSON.parse(h.body).title?.includes('near its budget')), (l) => l.length > 0, 'the webhook delivery');
  assert.ok(verify(delivered[0]));
  assert.ok(JSON.parse(delivered[0].body).id.endsWith(':webhook'), 'carries a delivery id');
  assert.ok(delivered[0].headers['x-mz-delivery']);
  // Read state is each person's own.
  assert.equal((await admin('POST', '/api/govern/alerts/read', { all: true })).body.unread, 0);
  assert.ok((await champ('GET', '/api/govern/alerts')).body.unread > 0, 'the champion has not read them');
});

test('permission check, diagnose a figure, and the audit chain records every change without the secret', async () => {
  assert.equal((await admin('POST', '/api/govern/permissions/check')).status, 202);
  const check = await until(() => admin('GET', '/api/govern/permissions'), (r) => r.body?.check?.reads?.length, 'the permission check');
  assert.ok(check.body.check.reads.filter((x) => x.ok !== null).every((x) => x.ok), JSON.stringify(check.body.check.reads));
  const diag = (await admin('GET', '/api/govern/diagnose?entityType=user&entityId=u-admin')).body;
  // Govern has less history than the lookback window yet: the figure is an estimate, and says so.
  assert.equal(diag.verdict, 'estimated');
  assert.equal(diag.steps.length, 6);
  assert.equal((await admin('GET', '/api/govern/diagnose?entityType=user&entityId=__proto__')).status, 400);
  const entries = (await admin('GET', '/api/audit?types=govern&limit=1000')).body.entries ?? (await admin('GET', '/api/audit?types=govern&limit=1000')).body.items;
  const events = new Set(entries.map((e) => e.details?.govern?.event));
  for (const e of ['budget.created', 'budget.deleted', 'budget.imported', 'restore', 'request.approved', 'attribution.decided', 'settings.updated', 'enforcement.applied', 'enforcement.released', 'enforcement.partial']) assert.ok(events.has(e), e);
  const created = entries.find((e) => e.details.govern.event === 'budget.created');
  assert.equal(created.details.govern.before, null);
  assert.ok(created.details.govern.after.budget.id);
  assert.ok(!JSON.stringify(entries).includes(SECRET), 'the webhook secret never reaches the audit log');
  assert.equal((await admin('GET', '/api/audit/verify')).body.ok ?? true, true);
  // Govern's files: owner-only.
  for (const f of fs.readdirSync(path.join(dataDir, 'govern'))) {
    const st = fs.statSync(path.join(dataDir, 'govern', f));
    if (st.isFile()) assert.equal(st.mode & 0o077, 0, f);
  }
});

test('govern.budgets without govern.enforce: an Enforce budget is never widened, by edit, bulk edit or CSV; narrowed, it is', async () => {
  const role = await admin('POST', '/api/iam/roles', { name: 'Budget keeper', permissions: ['govern.view', 'govern.budgets'] });
  assert.equal(role.status, 201, JSON.stringify(role.body));
  const id = role.body.roles.find((r) => r.name === 'Budget keeper').id;
  const keeper = browser();
  assert.equal((await admin('POST', '/api/iam/users', { email: 'keeper@acme.io', role: id, password: FIRST_PASSWORD })).status, 201);
  await keeper('POST', '/api/session/password', { email: 'keeper@acme.io', password: FIRST_PASSWORD });
  assert.equal((await keeper('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD })).status, 200);
  const b = await budgetRow(adminBudget.id);
  assert.equal(b.mode, 'enforce');
  const refused = (r) => {
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.permission, 'govern.enforce');
    assert.equal(r.body.error, 'Only someone allowed to enforce budgets can change what an Enforce budget restricts.');
  };
  refused(await keeper('PUT', `/api/govern/budgets/${b.id}`, { version: b.version, maxTargets: 10_000 }));
  refused(await keeper('PUT', `/api/govern/budgets/${b.id}`, { version: b.version, amount: 0 }));
  refused(await keeper('PUT', `/api/govern/budgets/${b.id}`, { version: b.version, period: 'lifetime' }));
  refused(await keeper('POST', '/api/govern/budgets/bulk', { ids: [b.id], changes: { amount: 0 } }));
  const csv = await keeper('GET', '/api/govern/budgets.csv');
  assert.equal(csv.status, 200);
  const lines = csv.text.split('\n');
  const i = lines.findIndex((l) => l.includes(',u-admin,'));
  const cells = lines[i].split(',');
  cells[16] = '10000';
  lines[i] = cells.join(',');
  const wider = await keeper('POST', '/api/govern/csv/validate', { csv: lines.join('\n') });
  assert.equal(wider.status, 200, JSON.stringify(wider.body));
  assert.match(wider.body.errors.map((e) => e.error).join(' '), /Only someone allowed to enforce budgets can change what an Enforce budget restricts/);
  assert.equal(wider.body.planHash, null);
  assert.equal((await keeper('POST', '/api/govern/csv/apply', { csv: lines.join('\n'), planHash: 'x' })).status, 400);
  const still = await budgetRow(b.id);
  assert.deepEqual([still.version, still.maxTargets, still.amount, still.period], [b.version, b.maxTargets, b.amount, b.period], 'nothing changed');
  // Narrowing is allowed: fewer targets per breach, a note.
  const narrowed = await keeper('PUT', `/api/govern/budgets/${b.id}`, { version: b.version, maxTargets: b.maxTargets - 1, notes: 'kept narrow' });
  assert.equal(narrowed.status, 200, JSON.stringify(narrowed.body));
  assert.equal(narrowed.body.budget.maxTargets, b.maxTargets - 1);
  assert.equal(narrowed.body.budget.mode, 'enforce');
  // An enforcer may widen it again.
  const widened = await admin('PUT', `/api/govern/budgets/${b.id}`, { version: narrowed.body.budget.version, maxTargets: b.maxTargets });
  assert.equal(widened.status, 200, JSON.stringify(widened.body));
});
