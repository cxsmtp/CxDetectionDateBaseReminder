import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConnectionGuard, describeCxone, describeSmtp } from '../src/connection-guard.js';
import { parseEnvText, settingsFromEnv } from '../src/env-import.js';
import { poolSummary, resolveRange, usageSeries } from '../src/credit-usage.js';
import { CreditLedger } from '../src/credits.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));

test('the last known good configuration survives a restart and is kept owner-readable', () => {
  const file = path.join(tmp(), 'connection-guard.json');
  const guard = new ConnectionGuard({ file });
  assert.equal(guard.lastGood('smtp'), null);
  guard.recordGood('smtp', { host: 'mail.acme.io', port: 587, password: 'secret' });
  guard.recordGood('cxone', { apiKey: 'k', overrides: { tenant: 'acme' }, connection: { tenant: 'acme', baseUrl: 'https://eu.ast', iamUrl: 'https://eu.iam' } });
  const again = new ConnectionGuard({ file });
  assert.equal(again.lastGood('smtp').host, 'mail.acme.io');
  assert.equal(again.lastGood('cxone').apiKey, 'k');
  assert.ok(again.lastGood('smtp').at);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a rollback notice is shown to each administrator once', () => {
  const guard = new ConnectionGuard({ file: path.join(tmp(), 'g.json') });
  const notice = guard.addNotice({ trigger: 'server start', parts: [{ part: 'smtp', error: 'timed out', restored: describeSmtp({ host: 'h', port: 25 }) }] });
  assert.equal(guard.unseen('ada').length, 1);
  assert.equal(guard.unseen('ada')[0].seenBy, undefined, 'who has seen it is not given out');
  assert.equal(guard.acknowledge('ada', [notice.id]), 1);
  assert.equal(guard.unseen('ada').length, 0);
  assert.equal(guard.unseen('bob').length, 1, 'another administrator still sees it');
  assert.equal(guard.acknowledge('ada', [notice.id]), 0, 'acknowledging twice changes nothing');
});

test('notices describe connections without their secrets', () => {
  assert.deepEqual(Object.keys(describeSmtp({ host: 'h', port: 1, password: 'pw', user: 'u' })).includes('password'), false);
  assert.deepEqual(describeCxone({ apiKey: 'secret', overrides: { tenant: 't' }, connection: { baseUrl: 'b', iamUrl: 'i' } }), { tenant: 't', baseUrl: 'b', iamUrl: 'i' });
});

test('.env text: comments, export, quotes, multi-line values and inline comments', () => {
  const vars = parseEnvText([
    '# CxMissionZero',
    'export CX_API_KEY="abc.def.ghi"',
    "SMTP_HOST='mail.acme.io'",
    'SMTP_PORT=465 # implicit TLS',
    'SMTP_PASS="p#ss word"',
    'MULTI="line one',
    'line two"',
    'not a line',
    'EMPTY=',
  ].join('\r\n'));
  assert.deepEqual(vars, { CX_API_KEY: 'abc.def.ghi', SMTP_HOST: 'mail.acme.io', SMTP_PORT: '465', SMTP_PASS: 'p#ss word', MULTI: 'line one\nline two', EMPTY: '' });
  assert.throws(() => parseEnvText('A=1\n'.repeat(20_000)), /too large/);
});

test('.env variables become settings, only those this person may change', () => {
  const vars = { CX_API_KEY: 'k', CX_TENANT: 'acme', SMTP_HOST: 'mail', SMTP_PORT: '587', SMTP_SECURE: 'false', SMTP_USER: 'bot@acme.io', SMTP_PASS: 'pw', REPORT_SERVER_URL: 'https://mz.acme.io', PORT: '3000', SMTP_FROM_NAME: '' };
  const all = settingsFromEnv(vars);
  assert.deepEqual(all.changes.cxone, { apiKey: 'k', tenant: 'acme' });
  assert.deepEqual(all.changes.smtp, { host: 'mail', port: 587, secure: false, user: 'bot@acme.io', fromAddress: 'bot@acme.io', password: 'pw' });
  assert.deepEqual(all.changes.links, { reportServerUrl: 'https://mz.acme.io' });
  assert.deepEqual(all.ignored, ['PORT']);
  assert.ok(!all.applied.includes('SMTP_FROM_NAME'), 'an empty value never wipes a setting');

  const linksOnly = settingsFromEnv(vars, (permission) => permission === 'settings.links');
  assert.deepEqual(Object.keys(linksOnly.changes), ['links']);
  assert.deepEqual(linksOnly.refused.sort(), ['CX_API_KEY', 'CX_TENANT', 'SMTP_HOST', 'SMTP_PASS', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER']);
});

test('a .env file can set the GitHub connection for the Beta features, only for people who may use them', () => {
  const vars = parseEnvText('GITHUB_TOKEN=ghp_example\nGITHUB_API_URL=https://github.acme.io/api/v3\nGITHUB_ORG=acme\n');
  const all = settingsFromEnv(vars);
  assert.deepEqual(all.changes.github, { token: 'ghp_example', apiUrl: 'https://github.acme.io/api/v3', org: 'acme' });
  const noBeta = settingsFromEnv(vars, (permission) => permission !== 'beta.use');
  assert.equal(noBeta.changes.github, undefined);
  assert.deepEqual(noBeta.refused.sort(), ['GITHUB_API_URL', 'GITHUB_ORG', 'GITHUB_TOKEN']);
});

test('the credit pool: used by kind, left, given to projects and free to give', () => {
  const allocations = [
    { triage: { allocated: 10, used: 4, remaining: 6 }, remediation: { allocated: 9, used: 3, remaining: 6 } },
    { triage: { allocated: 5, used: 5, remaining: 0 }, remediation: { allocated: 0, used: 0, remaining: 0 } },
  ];
  const pool = poolSummary({ size: 50, period: 'month', used: { triage: 9, remediation: 3, total: 12 }, allocations });
  assert.equal(pool.remaining, 38);
  assert.equal(pool.outstanding.total, 12);
  assert.equal(pool.unallocated, 26);
  assert.equal(pool.overAllocated, 0);
  const tight = poolSummary({ size: 20, period: 'all', used: { triage: 9, remediation: 3, total: 12 }, allocations });
  assert.equal(tight.unallocated, 0);
  assert.equal(tight.overAllocated, 4);
  const none = poolSummary({ size: 0, used: { triage: 1, remediation: 0, total: 1 }, allocations });
  assert.equal(none.limited, false);
  assert.equal(none.remaining, null);
  assert.equal(none.unallocated, null);
});

test('the ledger counts the pool period: this month, or since the start', () => {
  const ledger = new CreditLedger({ file: path.join(tmp(), 'l.json'), writeDelayMs: 0 });
  ledger.record({ projectId: 'p', credits: 4, kind: 'triage' }, new Date('2026-09-20T10:00:00Z'));
  ledger.record({ projectId: 'p', credits: 3, kind: 'remediation' }, new Date('2026-10-01T10:00:00Z'));
  const now = new Date('2026-10-02T00:00:00Z');
  assert.deepEqual(ledger.usedInPeriod('month', now), { triage: 0, remediation: 3, total: 3 });
  assert.deepEqual(ledger.usedInPeriod('all', now), { triage: 4, remediation: 3, total: 7 });
  assert.equal(ledger.remaining(5, now, 'month'), 2);
  assert.equal(ledger.remaining(5, now, 'all'), 0);
  assert.equal(ledger.reserve(1, 5, now, { period: 'all' }), null, 'a one-off pool that is used up refuses');
  assert.ok(ledger.reserve(1, 5, now, { period: 'month' }), 'the monthly pool has room this month');
});

test('usage over a period: buckets by day, week or month, by kind and by project', () => {
  const entries = [
    { at: '2026-09-28T09:00:00.000Z', projectId: 'a', projectName: 'Alpha', credits: 2, kind: 'triage' },
    { at: '2026-09-28T11:00:00.000Z', projectId: 'a', projectName: 'Alpha', credits: 3, kind: 'remediation' },
    { at: '2026-10-01T08:00:00.000Z', projectId: 'b', projectName: 'Beta', credits: 1, kind: 'triage' },
    { at: '2026-08-01T08:00:00.000Z', projectId: 'b', projectName: 'Beta', credits: 9, kind: 'triage' },
  ];
  const range = resolveRange({ from: '2026-09-27', to: '2026-10-02' });
  assert.equal(range.bucket, 'day');
  const days = usageSeries(entries, range);
  assert.equal(days.series.length, 6);
  assert.deepEqual(days.series[1], { start: '2026-09-28', triage: 2, remediation: 3, credits: 5, requests: 2, cumulative: 5 });
  assert.deepEqual(days.totals, { triage: 3, remediation: 3, credits: 6, requests: 3, projects: 2 });
  assert.equal(days.byProject[0].projectName, 'Alpha');
  const weeks = usageSeries(entries, resolveRange({ from: '2026-09-27', to: '2026-10-02', bucket: 'week' }));
  assert.deepEqual(weeks.series.map((r) => [r.start, r.credits]), [['2026-09-21', 0], ['2026-09-28', 6]], 'weeks start on Monday');
  const months = usageSeries(entries, resolveRange({ from: '2026-08-01', to: '2026-10-02', bucket: 'month' }));
  assert.deepEqual(months.series.map((r) => r.credits), [9, 5, 1]);
  assert.equal(usageSeries(entries, { ...range, projectId: 'b' }).totals.credits, 1);
  assert.throws(() => resolveRange({ from: '2026-10-05', to: '2026-10-01' }), /on or before/);
  assert.throws(() => resolveRange({ from: '2020-01-01', to: '2026-10-01' }), /at most/);
  assert.throws(() => resolveRange({ from: '2026-02-30' }), /date/);
});
