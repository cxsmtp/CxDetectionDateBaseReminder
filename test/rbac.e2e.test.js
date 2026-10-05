// Runs the real server against the mock Checkmarx One and checks what each
// role may do, sign-in by password and by Checkmarx One key, the first-admin
// setup, and that nobody can raise their own access.
import test from 'node:test';
import { freePort } from './free-port.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FIRST_PASSWORD, NEXT_PASSWORD, mockApiKey } from './test-credentials.js';

const MOCK_PORT = await freePort();
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const key = (claims) => mockApiKey({ iss: `${MOCK}/auth/realms/acme`, ...claims });
const PW = NEXT_PASSWORD;
const children = [];
let log = '';

async function waitFor(check, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out; server log:\n${log}`);
}

/** A browser: keeps its own session cookie. */
function browser() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(BASE + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let json = null;
    try {
      json = await res.json();
    } catch {}
    return { status: res.status, body: json };
  };
}

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbac-'));
  const env = { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '3', RISKS: '4' };
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io',
      BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: key({ azp: 'integration' }),
      CX_BASE_URL: MOCK,
      CX_IAM_URL: MOCK,
      CX_TENANT: 'acme',
      REPORT_SIGNING_KEY: 'rbac-test',
      ADMIN_EMAIL: '',
      ADMIN_PASSWORD: '',
      FIRST_ADMIN: 'setup-code',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  children.push(server);
  await waitFor(async () => /setup code/.test(log) && /Successfully authenticated/.test(log));
});

test.after(() => {
  for (const child of children) child.kill();
});

const as = {};

test('first start: nothing works until the first administrator is created with the setup code from the log', async () => {
  const anon = browser();
  assert.equal((await anon('GET', '/api/session')).body.setup, true);
  assert.equal((await anon('GET', '/api/scan')).status, 401, 'no shared CX_API_KEY session for anonymous visitors');
  assert.equal((await anon('POST', '/api/setup', { code: 'WRONG', email: 'admin@acme.io', password: PW })).status, 403);
  const code = /^\s+([A-Z0-9]{4}(?:-[A-Z0-9]{1,4})+)\s*$/m.exec(log)[1];
  as.admin = browser();
  const setup = await as.admin('POST', '/api/setup', { code, email: 'admin@acme.io', name: 'Ada', password: PW });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  assert.equal(setup.body.role.name, 'Admin');
  assert.equal(setup.body.connected, true, 'password users reach Checkmarx One through the integration');
  assert.equal((await anon('POST', '/api/setup', { code, email: 'evil@acme.io', password: PW })).status, 409, 'setup works once');
});

test('the admin adds a Security Analyst and a User; both choose a new password at first sign-in', async () => {
  for (const [email, role] of [['ana@acme.io', 'analyst'], ['uma@acme.io', 'user']]) {
    const r = await as.admin('POST', '/api/iam/users', { email, role, password: FIRST_PASSWORD });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  for (const [name, email] of [['analyst', 'ana@acme.io'], ['user', 'uma@acme.io']]) {
    as[name] = browser();
    const signIn = await as[name]('POST', '/api/session/password', { email, password: FIRST_PASSWORD });
    assert.equal(signIn.status, 201);
    assert.equal(signIn.body.user.mustChangePassword, true);
    assert.equal((await as[name]('GET', '/api/credits')).body.mustChangePassword, true);
    const changed = await as[name]('POST', '/api/me/password', { current: FIRST_PASSWORD, next: PW });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
  }
  const wrong = await browser()('POST', '/api/session/password', { email: 'ana@acme.io', password: 'nope nope nope' });
  assert.equal(wrong.status, 401);
});

// [method, path, body, admin, analyst, user] — true: allowed (anything but 401/403).
const MATRIX = [
  ['GET', '/api/scan', null, true, true, true],
  ['GET', '/api/credits', null, true, true, true],
  ['GET', '/api/tracked-reports', null, true, true, true],
  ['POST', '/api/reports/html', {}, true, true, true],
  ['GET', '/api/automation', null, true, true, true],
  ['GET', '/api/credits/usage', null, true, true, true],
  ['GET', '/api/scope/options', null, true, true, true],
  ['GET', '/api/settings/connections', null, true, true, true],
  ['POST', '/api/settings/notices/ack', {}, true, true, true],
  ['POST', '/api/tracked-reports', {}, true, true, false],
  ['POST', '/api/triage/run', {}, true, true, false],
  ['POST', '/api/credits/allocate', {}, true, true, false],
  ['POST', '/api/credits/give', {}, true, true, false],
  ['GET', '/api/credits/projects', null, true, true, false],
  ['PUT', '/api/settings', { template: { subject: 'Hi {{tenant}}' } }, true, true, false],
  ['PUT', '/api/automation', {}, true, true, false],
  ['GET', '/api/iam', null, true, true, false],
  ['GET', '/api/audit', null, true, true, false],
  ['GET', '/api/audit/export?format=csv', null, true, true, false],
  ['GET', '/api/backup', null, true, true, false],
  ['GET', '/api/beta/github/logins', null, true, true, false],
  ['GET', '/api/metrics', null, true, true, false],
  ['PUT', '/api/settings', { aiTriage: { monthlyCreditLimit: 500 } }, true, false, false],
  ['PUT', '/api/settings', { smtp: { host: 'mail.acme.io' } }, true, false, false],
  ['POST', '/api/integration/cxone', { apiKey: '' }, true, false, false],
  ['POST', '/api/discover', {}, true, false, false],
  ['POST', '/api/automation/arm', {}, true, false, false],
  ['POST', '/api/settings/connections/check', {}, true, false, false],
  ['PUT', '/api/integration/cxone/draft', {}, true, false, false],
  ['PUT', '/api/settings', { aiTriage: { poolPeriod: 'all' } }, true, false, false],
  ['POST', '/api/settings/import-env', { text: 'SMTP_HOST=mail.acme.io' }, true, false, false],
  ['GET', '/api/backup/download', null, true, false, false],
];

test('each role can do exactly what it should', async () => {
  const problems = [];
  for (const [method, url, body, ...expected] of MATRIX) {
    for (const [i, role] of ['admin', 'analyst', 'user'].entries()) {
      const { status } = await as[role](method, url, body);
      const allowed = status !== 401 && status !== 403;
      if (process.env.SHOW) console.log(role, method, url, status);
      if (allowed !== expected[i]) problems.push(`${role} ${method} ${url} ${JSON.stringify(body ?? '')} → ${status}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('a mixed settings save keeps only the sections the role may change', async () => {
  const r = await as.analyst('PUT', '/api/settings', { template: { subject: 'Analyst {{tenant}}' }, aiTriage: { monthlyCreditLimit: 9, allowRetriage: true } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.ignored, ['aiTriage.monthlyCreditLimit']);
  assert.equal(r.body.template.subject, 'Analyst {{tenant}}');
  assert.equal(r.body.aiTriage.allowRetriage, true);
  assert.notEqual(r.body.aiTriage.monthlyCreditLimit, 9);
});

test('nobody can raise their own access: an analyst cannot make or change admins', async () => {
  const { body } = await as.analyst('GET', '/api/iam');
  const admin = body.users.find((u) => u.email === 'admin@acme.io');
  const user = body.users.find((u) => u.email === 'uma@acme.io');
  const analyst = body.users.find((u) => u.email === 'ana@acme.io');
  assert.equal(admin.canManage, false);
  assert.equal(body.roles.find((r) => r.id === 'admin').canAssign, false);
  assert.equal((await as.analyst('POST', '/api/iam/users', { email: 'x@acme.io', role: 'admin' })).status, 403);
  assert.equal((await as.analyst('PATCH', `/api/iam/users/${admin.id}`, { disabled: true })).status, 403);
  assert.equal((await as.analyst('PATCH', `/api/iam/users/${analyst.id}`, { role: 'user' })).status, 400, 'not your own role');
  assert.equal((await as.analyst('POST', '/api/iam/roles', { name: 'Mail', permissions: ['integration.smtp'] })).status, 403);
  assert.equal((await as.analyst('POST', `/api/iam/users/${admin.id}/password`, { password: 'hijacked password 1' })).status, 403);
  // Within their own permissions it works.
  const role = await as.analyst('POST', '/api/iam/roles', { name: 'Auditor', permissions: ['audit.view', 'audit.export'] });
  assert.equal(role.status, 201);
  assert.equal((await as.user('GET', '/api/iam')).status, 403, 'IAM is hidden from users');
  assert.equal(user.role, 'user');
});

test('a role change applies at once, and disabling someone ends their session', async () => {
  const { body } = await as.admin('GET', '/api/iam');
  const user = body.users.find((u) => u.email === 'uma@acme.io');
  assert.equal((await as.user('GET', '/api/audit')).status, 403);
  await as.admin('PATCH', `/api/iam/users/${user.id}`, { role: 'analyst' });
  assert.equal((await as.user('GET', '/api/audit')).status, 200);
  await as.admin('PATCH', `/api/iam/users/${user.id}`, { role: 'user' });
  await as.admin('PATCH', `/api/iam/users/${user.id}`, { disabled: true });
  assert.equal((await as.user('GET', '/api/credits')).status, 401);
  assert.equal((await browser()('POST', '/api/session/password', { email: 'uma@acme.io', password: PW })).status, 403);
  await as.admin('PATCH', `/api/iam/users/${user.id}`, { disabled: false });
});

test('signing in with a Checkmarx One key needs a user mapped to that identity, in the same tenant', async () => {
  const cx = browser();
  const refused = await cx('POST', '/api/session', { apiKey: key({ email: 'carol@acme.io' }) });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /carol@acme\.io.*no access/);
  await as.admin('POST', '/api/iam/users', { email: 'carol.work@acme.io', role: 'user', cxoneIdentities: ['carol@acme.io'] });
  const ok = await cx('POST', '/api/session', { apiKey: key({ email: 'carol@acme.io' }) });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.user.email, 'carol.work@acme.io');
  assert.equal(ok.body.via, 'cxone');
  assert.equal((await cx('GET', '/api/scan')).status, 200);
  assert.equal((await cx('GET', '/api/iam')).status, 403);
  // Addresses from the browser (or the key) are ignored: the key is only ever sent to the integration's Checkmarx One.
  const lookalike = await browser()('POST', '/api/session', { apiKey: key({ email: 'carol@acme.io' }), iamUrl: 'http://127.0.0.1:9', baseUrl: 'http://127.0.0.1:9', tenant: 'other-tenant' });
  assert.equal(lookalike.status, 201, 'went to the trusted Checkmarx One, not port 9');
  assert.equal(lookalike.body.connection.iamUrl, MOCK);
  assert.equal(lookalike.body.connection.tenant, 'acme');
  const foreignIssuer = mockApiKey({ iss: 'http://127.0.0.1:9/auth/realms/evil', email: 'carol@acme.io' });
  const pinned = await browser()('POST', '/api/session', { apiKey: foreignIssuer });
  assert.equal(pinned.body.connection?.iamUrl, MOCK, 'the issuer inside the key is not trusted either');
});

test('sign-ins, refusals and access changes are in the audit log', async () => {
  const { body } = await as.admin('GET', '/api/audit?types=access,iam&limit=200');
  const reasons = body.entries.map((e) => e.reason).join('\n');
  assert.match(reasons, /First administrator admin@acme\.io created with the setup code/);
  assert.match(reasons, /Added ana@acme\.io as Security Analyst/);
  assert.match(reasons, /Sign-in refused for ana@acme\.io/);
  assert.match(reasons, /role User → Security Analyst/);
  assert.match(reasons, /carol@acme\.io" has no access/);
  assert.match(reasons, /signed in with a Checkmarx One API key/);
  const verify = await as.admin('GET', '/api/audit/verify');
  assert.equal(verify.body.ok, true);
});

test("the email's button downloads the very report that was attached, through a signed link", async () => {
  assert.equal((await as.admin('GET', '/api/scan')).status, 200);
  const created = await as.admin('POST', '/api/tracked-reports', { name: 'Payments' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const preview = await as.admin('POST', `/api/tracked-reports/${created.body.id}/remind`, { dryRun: true, attachHtml: true, onlyTo: 'dev@acme.io' });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const href = /href="([^"]+\/r\/[0-9a-f-]{36}\?s=[^"]+)"[^>]*>Let&#39;s start fixing the vulnerabilities</.exec(preview.body.html)?.[1];
  assert.ok(href, preview.body.html);
  const url = href.replace(/&amp;/g, '&');
  assert.ok(url.startsWith(BASE), 'points at the reminder server');

  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="Payments-\d{4}-\d{2}-\d{2}\.html"$/);
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  const html = await res.text();
  assert.match(html, /id="report-data"/);
  assert.match(html, new RegExp(`"relayUrl":"${BASE.replace(/[.]/g, '\\.')}/?"`), 'the downloaded report knows its reminder server');

  const id = /\/r\/([0-9a-f-]{36})/.exec(url)[1];
  assert.equal((await fetch(url.replace(/s=[^&]+/, 's=forged'))).status, 404);
  assert.equal((await fetch(`${BASE}/r/${id}`)).status, 404, 'no signature, no report');
  const other = '00000000-0000-4000-8000-000000000000';
  assert.equal((await fetch(url.replace(id, other))).status, 404, 'a signature is only good for its own report');
  const { body } = await as.admin('GET', '/api/audit?types=report&q=downloaded');
  assert.ok(body.entries.some((e) => e.actor?.reportId === id));
});

test('a finding triaged through the utility is never charged again while re-triage is off, and reports say it was triaged', async () => {
  const { ReportGrants } = await import('../src/report-grants.js');
  const grants = new ReportGrants({ secret: 'rbac-test' });
  assert.equal((await as.admin('PUT', '/api/settings', { aiTriage: { enabled: true, allowRetriage: false } })).status, 200);
  assert.equal((await as.admin('GET', '/api/scan')).status, 200);
  const alloc = await as.admin('POST', '/api/credits/allocate', { projectIds: ['p0'], triageAdd: 10 });
  assert.equal(alloc.status, 200, JSON.stringify(alloc.body));
  const base = { projectId: 'p0', projectName: 'Project 0', riskId: 'p0-r1', scanId: 'scan-p0', scanner: 'SAST', alternateId: 'alt-p0-r1', groupId: 'sim-p0-r1' };
  const finding = { ...base, ...grants.issue(base) };
  const relay = async (path, body) => (await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();

  const first = await relay('/api/relay/triage', { findings: [finding] });
  assert.equal(first.results[0].ok, true, JSON.stringify(first));
  const second = await relay('/api/relay/triage', { findings: [finding] });
  assert.equal(second.results[0].retriage, true, 'still "To verify" in Checkmarx One, but already triaged: refused, not charged');
  const results = await relay('/api/relay/triage-results', { findings: [finding] });
  assert.ok(results.results[0].triagedAt, 'the report learns it was triaged');

  // The dashboard's "triage now" skips it too, and the allocation does not count it as still to triage.
  const credits = (await as.admin('GET', '/api/credits')).body;
  const used = credits.projects?.find?.((p) => p.projectId === 'p0')?.triage?.used ?? null;
  if (used !== null) assert.equal(used, 1);
});

test('pages carry the security headers, and a state change from another site is refused', async () => {
  const page = await fetch(`${BASE}/`);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self' 'sha256-/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-powered-by'), null);
  const cross = await fetch(`${BASE}/api/session/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ email: 'admin@acme.io', password: PW }),
  });
  assert.equal(cross.status, 403);
  const same = await fetch(`${BASE}/api/session/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ email: 'admin@acme.io', password: PW }),
  });
  assert.equal(same.status, 201);
});
