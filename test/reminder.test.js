import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReminder, groupByProject } from '../src/reminder.js';

const NOW = new Date('2026-09-15T12:00:00Z');

const risk = (overrides) => ({
  id: 'r',
  projectId: 'p1',
  projectName: 'Payments API',
  title: 'SQL Injection',
  severity: 'HIGH',
  location: 'src/db.js',
  firstDetectedAt: '2026-01-01T00:00:00.000Z',
  ageDays: 257,
  bucket: '60+',
  ...overrides,
});

test('groupByProject orders projects by volume and risks by severity then age', () => {
  const groups = groupByProject([
    risk({ id: '1', severity: 'MEDIUM', ageDays: 300 }),
    risk({ id: '2', severity: 'CRITICAL', ageDays: 70 }),
    risk({ id: '3', projectId: 'p2', projectName: 'Web' }),
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].projectName, 'Payments API');
  assert.deepEqual(
    groups[0].risks.map((r) => r.severity),
    ['CRITICAL', 'MEDIUM'],
  );
});

test('buildReminder summarises the selection in the subject and body', () => {
  const reminder = buildReminder([risk({ id: '1' }), risk({ id: '2', severity: 'CRITICAL' })], {
    buckets: ['60+'],
    now: NOW,
  });

  assert.match(reminder.subject, /2 open vulnerabilities/);
  assert.match(reminder.subject, /more than 60 days/);
  assert.equal(reminder.totalRisks, 2);
  assert.equal(reminder.groups.length, 1);
  assert.match(reminder.text, /Payments API \(2\)/);
  assert.match(reminder.text, /first detected 2026-01-01/);
  assert.match(reminder.html, /SQL Injection/);
});

test('buildReminder escapes HTML in project and finding names', () => {
  const reminder = buildReminder([risk({ title: '<img src=x onerror=alert(1)>' })], {
    buckets: ['60+'],
    now: NOW,
  });

  assert.ok(!reminder.html.includes('<img src=x'));
  assert.match(reminder.html, /&lt;img src=x/);
});

test('buildReminder truncates long project listings', () => {
  const many = Array.from({ length: 30 }, (_, index) => risk({ id: String(index) }));
  const reminder = buildReminder(many, { buckets: ['60+'], now: NOW, maxRowsPerProject: 10 });

  assert.match(reminder.text, /\.\.\. and 20 more/);
  assert.match(reminder.html, /and 20 more/);
});
