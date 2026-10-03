// A report covering several projects offers each project's own report instead of
// links to Checkmarx One: the reminder server builds it (same scope, signed), and
// a report can only ask for the projects and scope it was made with.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';

const MOCK_PORT = await freePort();
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const KEY = (() => {
  const e = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${e({ alg: 'none' })}.${e({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' })}.sig`;
})();
const children = [];
let log = '';
let cookie = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function admin(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, text, body: json };
}
const relay = (body) => fetch(`${BASE}/api/relay/project-report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const payloadOf = (html) => JSON.parse(html.match(/<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/)[1]);

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-report-'));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '5', PROJECTS: '3', RISKS: '40', INITIATORS: '2' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: KEY, CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme', REPORT_SIGNING_KEY: 'project-report-test',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: 'temporary password 1', SMTP_HOST: '', GITHUB_TOKEN: '',
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
  await admin('POST', '/api/session/password', { email: 'admin@acme.io', password: 'temporary password 1' });
  await admin('POST', '/api/me/password', { current: 'temporary password 1', next: 'correct horse battery' });
  await admin('PUT', '/api/settings', { aiTriage: { enabled: true, remediationEnabled: true }, links: { reportServerUrl: BASE } });
  assert.equal((await admin('GET', '/api/scan')).status, 200);
});

test.after(() => {
  for (const child of children) child.kill();
});

test('a report of several projects offers each project its own report, never a Checkmarx One link', async () => {
  const report = await admin('POST', '/api/reports/html', { projectIds: ['p0', 'p1', 'p2'], severities: ['CRITICAL', 'HIGH'] });
  assert.equal(report.status, 200);
  assert.doesNotMatch(report.text, /See every finding in Checkmarx One|Open in Checkmarx One:/);
  assert.match(report.text, /Open one project's own report/);
  const { projectReports } = payloadOf(report.text);
  assert.deepEqual(projectReports.map((p) => [p.projectId, p.count]), [['p0', 20], ['p1', 20], ['p2', 20]]);
  assert.deepEqual(projectReports[0].scope.severities, ['CRITICAL', 'HIGH'], 'the scope travels with the link');

  // The server builds that project's report: the same kind of report, that project only, same scope.
  const one = await relay(projectReports[1]);
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal(one.body.filename, 'Project-1-report.html');
  assert.equal(one.body.total, 20);
  const inner = payloadOf(one.body.html);
  assert.ok(inner.findings.length > 0);
  assert.ok(inner.findings.every((f) => f.projectId === 'p1'), 'only that project');
  assert.ok(inner.findings.every((f) => ['CRITICAL', 'HIGH'].includes(f.severity)), 'within the original scope');
  assert.ok(inner.findings.filter((f) => !f.aiUnavailable).every((f) => f.grant), 'triage-ready: every finding is signed');
  assert.deepEqual(inner.projectReports, [], 'one project: no further project links');
  assert.match(one.body.html, /Project 1 — vulnerability report/);
});

test('a report can only ask for the projects and scope it was signed with', async () => {
  const { projectReports } = payloadOf((await admin('POST', '/api/reports/html', { projectIds: ['p0', 'p1'], severities: ['CRITICAL'] })).text);
  const link = projectReports[0];
  for (const forged of [
    { ...link, projectId: 'p2' },
    { ...link, projectName: 'Something else' },
    { ...link, scope: { ...link.scope, severities: [] } },
    { ...link, exp: link.exp + 1000 },
    { ...link, sig: 'x'.repeat(link.sig.length) },
    { ...link, sig: undefined },
  ]) {
    const r = await relay(forged);
    assert.equal(r.status, 403, JSON.stringify(forged));
  }
  assert.equal((await relay(link)).status, 200);
});
