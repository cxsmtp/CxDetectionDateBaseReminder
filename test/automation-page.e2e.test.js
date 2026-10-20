// Act → Automation, for real against a mock Checkmarx One: limits per severity, focus, the preview
// (who would get what, nothing sent or remembered), and the branded reminder email.
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

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-page-'));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '6', RISKS: '8' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: KEY, CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme',
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
  await user('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD });
});

test.after(() => {
  for (const child of children) child.kill();
});

test('a new installation: on a weekday schedule, with the branded email and the portal behind "Same as the portal"', async () => {
  const a = (await admin('GET', '/api/automation')).body;
  assert.equal(a.config.when, 'schedule');
  assert.deepEqual(a.config.days, [1, 2, 3, 4, 5]);
  assert.equal(a.reminderEmail.style, 'simple');
  assert.ok(a.portal.senderName && a.portal.colours.head);
  assert.ok(Date.parse(a.wouldRunAt) > Date.now(), 'when it would go out, though off');
  assert.ok(a.placeholders.includes('firstName'));
});

test('what cannot be sent on is refused: no day, a time that is not one, an unknown time zone', async () => {
  assert.equal((await admin('PUT', '/api/automation', { days: [] })).status, 400);
  assert.equal((await admin('PUT', '/api/automation', { at: '25:00' })).status, 400);
  assert.equal((await admin('PUT', '/api/automation', { timeZone: 'Mars/Olympus' })).status, 400);
  const saved = await admin('PUT', '/api/automation', { when: 'schedule', days: [1, 3], at: '08:30', timeZone: 'Europe/Berlin' });
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.body.config.days, saved.body.config.at, saved.body.config.timeZone], [[1, 3], '08:30', 'Europe/Berlin']);
});

test('preview: who would get what, per severity’s own limits, with nothing sent and nothing remembered', async () => {
  const set = await admin('PUT', '/api/automation', { perSeverity: true, severityLimits: { CRITICAL: '1', HIGH: '1', MEDIUM: '', LOW: '' }, dryRun: false });
  assert.equal(set.status, 200);
  const before = (await admin('GET', '/api/automation')).body;
  const p = await admin('POST', '/api/automation/preview', {});
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.ok(p.body.findings > 0, 'findings past a limit');
  assert.equal(p.body.bySeverity.MEDIUM, 0, 'medium has no limit');
  assert.equal(p.body.bySeverity.LOW, 0);
  assert.equal(p.body.findings, p.body.bySeverity.CRITICAL + p.body.bySeverity.HIGH);
  const listed = p.body.rows.reduce((n, r) => n + r.critical + r.high + r.medium, 0) + (p.body.noAddress ? p.body.noAddress.critical + p.body.noAddress.high + p.body.noAddress.medium : 0);
  assert.equal(listed, p.body.findings, 'every finding past a limit is someone’s, or waits for an address');
  assert.ok(p.body.rows.every((r) => r.medium === 0 && /^(Critical|High) 1 d/.test(r.limits)));
  assert.equal(p.body.total, 6);

  const after = (await admin('GET', '/api/automation')).body;
  assert.equal(after.runs.length, before.runs.length, 'a preview is not a run');
  assert.equal(after.trackedFindings, 0, 'nothing remembered as reported');
  assert.equal(after.lastPreview.findings, p.body.findings);

  const mail = await admin('GET', '/api/automation/preview/0');
  assert.equal(mail.status, 200);
  assert.equal(mail.body.to, p.body.rows[0].to);
  assert.match(mail.body.subject, /findings in your projects are past our limits/);
  assert.equal((await admin('GET', '/api/automation/preview/999')).status, 404);
});

test('focus: how many projects the names match, and a preview of a focus that covers nothing', async () => {
  const all = await admin('POST', '/api/automation/focus/match', {});
  assert.equal(all.status, 200);
  assert.equal(all.body.matched, all.body.total);
  const none = await admin('POST', '/api/automation/focus/match', { projects: ['nothing-*'], applications: ['Nowhere'] });
  assert.equal(none.body.matched, 0);
  assert.deepEqual(none.body.unknownApplications, ['Nowhere']);
  assert.equal((await admin('PUT', '/api/automation', { focus: { projects: ['nothing-*'] } })).status, 200);
  const p = (await admin('POST', '/api/automation/preview', {})).body;
  assert.deepEqual([p.inFocus, p.findings, p.people], [0, 0, 0]);
  await admin('PUT', '/api/automation', { focus: { projects: [] } });
});

test('the email: checked when saved, what is typed is text in the preview, and restore puts back the default', async () => {
  assert.equal((await admin('PUT', '/api/automation/email', { replyTo: 'not an address' })).status, 400);
  const saved = await admin('PUT', '/api/automation/email', { senderName: 'Acme <AppSec>', opening: '<script>alert(1)</script> {{count}} past', replyTo: 'appsec@acme.io' });
  assert.equal(saved.status, 200);
  const preview = await admin('POST', '/api/automation/email/preview', saved.body.reminderEmail);
  assert.equal(preview.status, 200);
  assert.ok(!preview.body.html.includes('<script>'));
  assert.match(preview.body.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; \d+ past/);
  assert.match(preview.body.html, /Acme &lt;AppSec&gt;/);
  const restored = await admin('PUT', '/api/automation/email', { restore: true });
  assert.equal(restored.body.reminderEmail.senderName, '');
  assert.equal(restored.body.reminderEmail.subject, '{{count}} findings in your projects are past our limits');
});

test('as today: someone who may only view settings sees Automation, but cannot preview, change or test it', async () => {
  assert.equal((await user('GET', '/api/automation')).status, 200);
  assert.equal((await user('POST', '/api/automation/preview', {})).status, 403);
  assert.equal((await user('GET', '/api/automation/preview/0')).status, 403);
  assert.equal((await user('PUT', '/api/automation/email', { subject: 'x' })).status, 403);
  assert.equal((await user('POST', '/api/automation/email/preview', {})).status, 403);
  assert.equal((await user('POST', '/api/automation/email/test', {})).status, 403);
  assert.equal((await user('POST', '/api/automation/focus/match', {})).status, 403);
  assert.equal((await user('PUT', '/api/automation', { enabled: true })).status, 403);
});
