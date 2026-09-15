import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ageInDays,
  bucketForAge,
  normalizeRisk,
  parseDate,
  selectRisks,
  summariseProject,
} from '../src/cxone/risks.js';

const NOW = new Date('2026-09-15T12:00:00Z');
const daysAgo = (days) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const project = { id: 'p1', name: 'Payments API', repoUrl: '', tags: {} };

test('parseDate handles ISO strings, epoch seconds and epoch milliseconds', () => {
  assert.equal(parseDate('2026-01-02T03:04:05Z').toISOString(), '2026-01-02T03:04:05.000Z');
  assert.equal(parseDate(1767322445).toISOString(), '2026-01-02T02:54:05.000Z');
  assert.equal(parseDate(1767322445000).toISOString(), '2026-01-02T02:54:05.000Z');
  assert.equal(parseDate(''), null);
  assert.equal(parseDate('not a date'), null);
});

test('ageInDays and bucketForAge honour the 30 / 60 / 60+ boundaries', () => {
  assert.equal(ageInDays(daysAgo(45), NOW), 45);
  assert.equal(bucketForAge(0), '0-30');
  assert.equal(bucketForAge(30), '0-30');
  assert.equal(bucketForAge(31), '31-60');
  assert.equal(bucketForAge(60), '31-60');
  assert.equal(bucketForAge(61), '60+');
  assert.equal(bucketForAge(3650), '60+');
  assert.equal(bucketForAge(null), 'unknown');
});

test('normalizeRisk resolves first-detection date across field-name variants', () => {
  const variants = ['firstFoundAt', 'firstDetectionDate', 'firstSeenAt', 'introducedAt'];
  for (const field of variants) {
    const risk = normalizeRisk({ id: 'r', [field]: daysAgo(90) }, project, NOW);
    assert.equal(risk.ageDays, 90, `expected ${field} to be recognised`);
    assert.equal(risk.bucket, '60+');
  }
});

test('normalizeRisk falls back to the unknown bucket when no date is present', () => {
  const risk = normalizeRisk({ id: 'r', severity: 'high' }, project, NOW);
  assert.equal(risk.firstDetectedAt, null);
  assert.equal(risk.ageDays, null);
  assert.equal(risk.bucket, 'unknown');
  assert.equal(risk.severity, 'HIGH');
});

test('summariseProject counts each bucket and reports the oldest detection', () => {
  const risks = [
    normalizeRisk({ id: '1', firstFoundAt: daysAgo(5), severity: 'LOW' }, project, NOW),
    normalizeRisk({ id: '2', firstFoundAt: daysAgo(45), severity: 'HIGH' }, project, NOW),
    normalizeRisk({ id: '3', firstFoundAt: daysAgo(400), severity: 'HIGH' }, project, NOW),
    normalizeRisk({ id: '4', severity: 'MEDIUM' }, project, NOW),
  ];

  const summary = summariseProject(project, risks);
  assert.deepEqual(summary.counts, { '0-30': 1, '31-60': 1, '60+': 1, unknown: 1 });
  assert.deepEqual(summary.bySeverity, { LOW: 1, HIGH: 2, MEDIUM: 1 });
  assert.equal(summary.maxAgeDays, 400);
  assert.equal(summary.oldestFirstDetectedAt, daysAgo(400));
  assert.equal(summary.totalRisks, 4);
});

test('selectRisks filters by bucket, project and severity', () => {
  const other = { id: 'p2', name: 'Web', repoUrl: '', tags: {} };
  const summaries = [
    summariseProject(project, [
      normalizeRisk({ id: '1', firstFoundAt: daysAgo(10), severity: 'HIGH' }, project, NOW),
      normalizeRisk({ id: '2', firstFoundAt: daysAgo(100), severity: 'HIGH' }, project, NOW),
    ]),
    summariseProject(other, [
      normalizeRisk({ id: '3', firstFoundAt: daysAgo(100), severity: 'LOW' }, other, NOW),
    ]),
  ];

  assert.equal(selectRisks(summaries, { buckets: ['60+'] }).length, 2);
  assert.equal(selectRisks(summaries, { buckets: ['0-30'] }).length, 1);
  assert.equal(selectRisks(summaries, { buckets: ['60+'], projectIds: ['p1'] }).length, 1);
  assert.equal(selectRisks(summaries, { buckets: ['60+'], severities: ['high'] }).length, 1);
});
