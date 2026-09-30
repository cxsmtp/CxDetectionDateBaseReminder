import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TrackedReports, computeProgress, outcomeOf, reportSummary } from '../src/tracked-reports.js';
import { resolveWindow } from '../src/window.js';

const now = new Date('2026-09-30T12:00:00Z');
const daysAgo = (n) => new Date(now - n * 86_400_000).toISOString();
const risk = (riskId, severity, state = 'TO_VERIFY', age = 10) => ({ riskId, severity, state, firstDetectedAt: daysAgo(age), bucket: age <= 30 ? '0-30' : '60+' });

function setup(filters = { severities: ['CRITICAL', 'HIGH'], buckets: [], detection: { preset: '90d' } }) {
  const store = new TrackedReports({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'track-')), 't.json') });
  const report = store.create(
    {
      name: 'Q4 critical & high',
      filters,
      scopeLabel: 'test',
      projects: [{ projectId: 'p1', projectName: 'Payments' }, { projectId: 'p2', projectName: 'HospitalMS' }],
      findings: [
        { projectId: 'p1', ...risk('a', 'CRITICAL') },
        { projectId: 'p1', ...risk('b', 'HIGH') },
        { projectId: 'p1', ...risk('c', 'HIGH') },
        { projectId: 'p2', ...risk('d', 'CRITICAL') },
        { projectId: 'p2', ...risk('e', 'HIGH') },
      ],
    },
    new Date('2026-09-01T00:00:00Z'),
  );
  return { store, report };
}

test('outcomes follow each finding\'s current Checkmarx One state', () => {
  assert.equal(outcomeOf(undefined), 'resolved');
  assert.equal(outcomeOf({ state: 'TO_VERIFY' }), 'awaiting');
  assert.equal(outcomeOf({ state: 'URGENT' }), 'confirmed');
  assert.equal(outcomeOf({ state: 'PROPOSED_NOT_EXPLOITABLE' }), 'notExploitable');
});

test('progress counts actioned baseline findings, new matching findings and AI credits', () => {
  const { report } = setup();
  const current = new Map([
    ['p1', [risk('a', 'CRITICAL', 'CONFIRMED'), risk('b', 'HIGH', 'PROPOSED_NOT_EXPLOITABLE'), risk('x', 'HIGH'), risk('y', 'LOW'), risk('z', 'HIGH', 'TO_VERIFY', 200)]],
    ['p2', [risk('d', 'CRITICAL')]],
  ]);
  let asked;
  const progress = computeProgress(report, current, resolveWindow({ preset: '90d' }, 'x', now), (ids, since) => {
    asked = { ids, since };
    return { triage: 4, remediation: 1 };
  }, now);

  assert.deepEqual(progress.outcomes, { awaiting: 1, confirmed: 1, notExploitable: 1, resolved: 2 });
  assert.equal(progress.baseline, 5);
  assert.equal(progress.actioned, 4);
  assert.equal(progress.percentActioned, 80);
  assert.equal(progress.changed, 4, 'all four moved from To verify at baseline');
  assert.equal(progress.newFindings, 1, 'x is new; y is LOW and z is outside the 90-day window');
  assert.equal(progress.currentMatching, 4, 'a, b and x in p1, d in p2');
  assert.deepEqual(progress.aiActions, { triage: 4, remediation: 1 });
  assert.deepEqual(asked, { ids: ['p1', 'p2'], since: report.createdAt });
  const p1 = progress.byProject.find((p) => p.projectId === 'p1');
  assert.deepEqual([p1.baseline, p1.confirmed, p1.notExploitable, p1.resolved, p1.newFindings], [3, 1, 1, 1, 1]);
});

test('readings are kept as history, and reports can be deleted', () => {
  const { store, report } = setup();
  const reading = (awaiting) => ({ at: now.toISOString(), outcomes: { awaiting, confirmed: 0, notExploitable: 0, resolved: 5 - awaiting }, newFindings: 0, currentMatching: 5 });
  store.record(report, reading(5));
  store.record(report, reading(2));
  const summary = reportSummary(report);
  assert.equal(summary.baselineCount, 5);
  assert.equal(summary.history.length, 2);
  assert.equal(summary.baseline, undefined, 'listings leave out the bulky baseline');
  assert.equal(store.delete(report.id), true);
  assert.equal(store.get(report.id), null);
});

test('progress counts the open findings AI Triage can still act on, by severity', () => {
  const { report } = setup();
  const sast = (r) => ({ ...r, scanner: 'SAST' });
  const current = new Map([
    ['p1', [sast(risk('a', 'CRITICAL')), sast(risk('b', 'HIGH', 'CONFIRMED')), { ...risk('c', 'HIGH'), scanner: 'KICS' }, sast(risk('x', 'HIGH'))]],
    ['p2', [{ ...risk('d', 'CRITICAL'), scanner: 'SCA' }, sast(risk('e', 'HIGH', 'PROPOSED_NOT_EXPLOITABLE'))]],
  ]);
  const progress = computeProgress(report, current, resolveWindow({ preset: '90d' }, 'x', now), () => ({ triage: 0, remediation: 0 }), now);
  // a and d (baseline, still to verify) and x (new); b, e have verdicts, c is KICS.
  assert.deepEqual(progress.toTriage, { CRITICAL: 2, HIGH: 1 });
});
