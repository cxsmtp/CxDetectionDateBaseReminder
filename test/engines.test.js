// Engines: SAST and SCA (the engines AI Triage and AI Remediation work on) unless more are chosen,
// on the Dashboard, its reports, tracked reports, scheduled runs, credits and the calculator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_ENGINES, ENGINE_KEYS, cleanEngines, describeEngines, engineOf, engineScope, inEngines } from '../src/engines.js';
import { DEFAULT_AUTOMATION, mergeAutomation } from '../src/automation.js';
import { DEFAULT_SETTINGS, SettingsStore } from '../src/settings.js';
import { selectRisks } from '../src/cxone/risks.js';
import { matchesFilters } from '../src/tracked-reports.js';
import { TenantReadStore, cleanTr, countersOf, seriesFor, weeklyBacklog } from '../src/projections.js';
import { freePort } from './free-port.js';
import { FIRST_PASSWORD, NEXT_PASSWORD, mockApiKey } from './test-credentials.js';

test('every name Checkmarx One gives an engine means one engine; a choice keeps known engines, in order', () => {
  assert.deepEqual(DEFAULT_ENGINES, ['SAST', 'SCA']);
  for (const [name, key] of [['sast', 'SAST'], ['IaC', 'KICS'], ['kics', 'KICS'], ['scaContainers', 'CONTAINERS'], ['Containers', 'CONTAINERS'], ['apiSec', 'APISEC'], ['API Security', 'APISEC'], ['secret-detection', 'SECRETS'], ['secretDetection', 'SECRETS']]) {
    assert.equal(engineOf(name), key, name);
  }
  assert.deepEqual(cleanEngines('sca, bogus, SAST, iac'), ['SAST', 'SCA', 'KICS']);
  assert.deepEqual(cleanEngines(null), []);
  assert.equal(engineScope([]), null, 'none chosen: no filter');
  assert.equal(engineScope(ENGINE_KEYS), null, 'every engine: no filter (and an unknown engine is kept too)');
  assert.deepEqual(engineScope(['SCA', 'SAST']), ['SAST', 'SCA']);
  assert.ok(inEngines({ scanner: 'SAST' }, ['SAST']) && !inEngines({ scanner: 'KICS' }, ['SAST']));
  assert.ok(inEngines({ scanner: 'SOMETHING-NEW' }, null), 'no choice keeps everything');
  assert.equal(describeEngines(['SAST', 'KICS']), 'SAST, IaC');
  assert.equal(describeEngines([]), 'all engines');
});

test('findings are selected by engine, and a tracked report keeps its engines (none saved: every engine)', () => {
  const risk = (id, scanner) => ({ riskId: id, scanner, severity: 'HIGH', bucket: '0-30', firstDetectedAt: new Date().toISOString() });
  const summaries = [{ projectId: 'p', risks: [risk('a', 'SAST'), risk('b', 'SCA'), risk('c', 'KICS'), risk('d', 'Containers')] }];
  assert.deepEqual(selectRisks(summaries, { engines: ['SAST'] }).map((r) => r.riskId), ['a']);
  assert.deepEqual(selectRisks(summaries, { engines: DEFAULT_ENGINES }).map((r) => r.riskId), ['a', 'b']);
  assert.equal(selectRisks(summaries, {}).length, 4);
  assert.ok(!matchesFilters(risk('c', 'KICS'), { engines: ['SAST', 'SCA'] }, null));
  assert.ok(matchesFilters(risk('c', 'KICS'), {}, null), 'a report saved before engines keeps every engine');
});

test('a new schedule reminds about SAST and SCA; one saved before engines keeps every engine', () => {
  assert.deepEqual(DEFAULT_AUTOMATION.engines, ['SAST', 'SCA']);
  assert.deepEqual(DEFAULT_SETTINGS.automation.engines, ['SAST', 'SCA']);
  assert.deepEqual(mergeAutomation(DEFAULT_AUTOMATION, { engines: ['kics', 'SAST', 'nope'] }).engines, ['SAST', 'KICS']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engines-'));
  const old = path.join(dir, 'old.json');
  fs.writeFileSync(old, JSON.stringify({ automation: { enabled: true, severities: ['HIGH'] } }));
  assert.deepEqual(new SettingsStore({ file: old }).get().automation.engines, [], 'saved before: every engine, as it always was');
  assert.deepEqual(new SettingsStore({ file: path.join(dir, 'none.json') }).get().automation.engines, ['SAST', 'SCA']);
});

test('the calculator counts each engine apart: the tenant total, any project and engine set, and an older read', () => {
  const c = countersOf({
    sastCounters: { severityCounters: [{ severity: 'HIGH', counter: 4 }], severityStatusCounters: [{ severity: 'HIGH', status: 'NEW', counter: 1 }] },
    kicsCounters: { severityCounters: [{ severity: 'HIGH', counter: 3 }] },
    scaCounters: { severityCounters: [{ severity: 'LOW', counter: 2 }] },
  });
  assert.equal(c.total.High, 7, 'every engine together, as before');
  assert.deepEqual([c.byEngine.SAST.total.High, c.byEngine.KICS.total.High, c.byEngine.SCA.total.Low, c.byEngine.SAST.fresh.High], [4, 3, 2, 1]);

  const now = Date.parse('2026-10-09T00:00:00Z');
  const at = (days) => new Date(now - days * 86400000).toISOString();
  const summary = (sast, kics) => countersOf({ sastCounters: { severityCounters: [{ severity: 'HIGH', counter: sast }] }, kicsCounters: { severityCounters: [{ severity: 'HIGH', counter: kics }] } });
  const summaries = new Map([['s1', summary(10, 5)], ['s2', summary(6, 5)]]);
  const perProject = [{ project: { id: 'pa' }, before: null, scans: [{ id: 's2', createdAt: at(2) }, { id: 's1', createdAt: at(10) }] }];
  const sastOnly = weeklyBacklog(perProject, summaries, { now, weeks: 3, engines: ['SAST'] });
  assert.deepEqual(sastOnly.totals.bySeverity.High, [0, 10, 6]);
  assert.deepEqual(sastOnly.fixed.bySeverity.High, [0, 0, 4]);
  assert.deepEqual(weeklyBacklog(perProject, summaries, { now, weeks: 3 }).totals.bySeverity.High, [0, 15, 11], 'no choice: every engine');

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'read-')), 'read.json');
  new TenantReadStore({ file }).save({ readAt: at(0), weeks: sastOnly.totals.weeks, byProject: sastOnly.byProject });
  const read = new TenantReadStore({ file }).get();
  assert.deepEqual(seriesFor(read, ['pa'], ['KICS']).totals.bySeverity.High, [0, 5, 5]);
  assert.deepEqual(seriesFor(read, ['pa'], ['SAST', 'KICS']).totals.bySeverity.High, [0, 15, 11]);
  assert.deepEqual(seriesFor(read, ['pa'], ['SAST', 'KICS']).totals.meta.engines, ['SAST', 'KICS']);
  assert.equal(seriesFor(read, ['pa'], ['SAST']).totals.meta.engineSplit, true);
  // A read saved by an older version: every engine together, and the page is told so.
  const older = { readAt: at(0), weeks: read.weeks, series: { pa: { scans: 2, t: { High: [0, 15, 11] }, f: { High: [0, 0, 4] } } } };
  const fromOld = seriesFor(older, ['pa'], ['SAST']);
  assert.deepEqual(fromOld.totals.bySeverity.High, [0, 15, 11]);
  assert.equal(fromOld.totals.meta.engineSplit, false);

  assert.deepEqual(cleanTr({}).engines, ['SAST', 'SCA']);
  assert.deepEqual(cleanTr({ engines: ['kics', 'sast'] }).engines, ['SAST', 'KICS']);
});

// ---------------------------------------------------------------------------------------------
// The server, against a mock tenant whose findings come from SAST, SCA, IaC and containers.
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engines-e2e-'));
  // 3 projects of 12 findings: per project 6 SAST, 2 SCA, 2 IaC and 2 container findings.
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '3', RISKS: '12', INITIATORS: '1', MIXED_ENGINES: '1' }, stdio: 'ignore' }));
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

test('loading findings keeps the engines chosen, and a reload remembers them', async () => {
  const all = await admin('GET', '/api/scan');
  assert.equal(all.status, 200);
  assert.equal(all.body.totals.risks, 36, 'no engines asked for: every engine');
  assert.equal(all.body.engines, null);

  const ai = await admin('GET', '/api/scan?engines=SAST,SCA');
  assert.equal(ai.body.totals.risks, 24, 'SAST and SCA: 8 of each project\'s 12');
  assert.deepEqual(ai.body.engines, ['SAST', 'SCA']);
  const last = await admin('GET', '/api/scan/last');
  assert.deepEqual(last.body.request.engines, ['SAST', 'SCA']);

  const sast = await admin('GET', '/api/scan?engines=sast');
  assert.equal(sast.body.totals.risks, 18);
});

test('a narrowed load never counts the findings it left out as fixed (engines, or a vulnerability search)', async () => {
  await admin('GET', '/api/scan');
  const before = (await admin('GET', '/api/impact?days=30')).body;
  await admin('GET', '/api/scan?engines=SAST');
  await admin('GET', '/api/scan?vulnerability=Finding%20p0-r1');
  const after = (await admin('GET', '/api/impact?days=30')).body;
  assert.equal(after.debt.now, before.debt.now, `the open backlog stays ${before.debt.now}`);
});

test('the report says its engines and lists only theirs; credits verified twice keep to them', async () => {
  await admin('GET', '/api/scan?engines=SAST,SCA');
  const report = await admin('POST', '/api/reports/html', { projectIds: null, severities: null, buckets: [] });
  assert.equal(report.status, 200);
  assert.match(report.text, /class="engine-focus"><span data-l="Engines: \{0\}" data-v="\[&quot;SAST, SCA&quot;\]" translate="no">Engines: SAST, SCA<\/span>/);
  assert.doesNotMatch(report.text, /<td class="meta-cell" data-label="Type" title="(KICS|CONTAINERS)"/i);

  const v = await admin('POST', '/api/credits/verify', { projectIds: ['p0'], severities: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.verified[0].agreed, true, JSON.stringify(v.body.verified[0]));
  assert.equal(v.body.projects.p0.totalRisks, 8, 'the verified read replaces the loaded findings with the same engines only');
});

test('a tracked report saves the engines it was made with', async () => {
  await admin('GET', '/api/scan?engines=SAST');
  const made = await admin('POST', '/api/tracked-reports', { name: 'SAST only', severities: [], buckets: [], windows: {} });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const list = await admin('GET', '/api/tracked-reports');
  const report = list.body.reports.find((r) => r.name === 'SAST only');
  assert.ok(report, 'listed');
  assert.deepEqual(report.filters?.engines, ['SAST']);
});
