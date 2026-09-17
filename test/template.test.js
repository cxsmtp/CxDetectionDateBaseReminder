import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_TEMPLATE, TemplateError, render } from '../src/template.js';
import { buildReminder, groupByProject } from '../src/reminder.js';

const risk = (over = {}) => ({
  projectId: 'p1',
  projectName: 'Payments API',
  title: 'SQL_Injection',
  severity: 'HIGH',
  location: 'src/db.js :: Fill',
  firstDetectedAt: '2026-01-01T00:00:00.000Z',
  ageDays: 259,
  bucket: '60+',
  state: 'CONFIRMED',
  scanner: 'SAST',
  ...over,
});

test('values are HTML-escaped by default and raw with triple braces', () => {
  const data = { name: '<b>x</b>' };
  assert.equal(render('{{name}}', data), '&lt;b&gt;x&lt;/b&gt;');
  assert.equal(render('{{{name}}}', data), '<b>x</b>');
  // A plain-text render must not escape, or ampersands get mangled.
  assert.equal(render('{{name}}', { name: 'A & B' }, { escape: false }), 'A & B');
});

test('sections repeat over arrays and can still see outer values', () => {
  const data = { total: 2, rows: [{ n: 'a' }, { n: 'b' }] };
  assert.equal(render('{{#rows}}[{{n}}/{{total}}]{{/rows}}', data), '[a/2][b/2]');
});

test('nested sections render once per inner item', () => {
  const data = { groups: [{ items: [1, 2] }, { items: [3] }] };
  assert.equal(render('{{#groups}}({{#items}}{{.}}{{/items}}){{/groups}}', data), '(12)(3)');
});

test('inverted sections show only when the value is empty', () => {
  assert.equal(render('{{^rows}}none{{/rows}}', { rows: [] }), 'none');
  assert.equal(render('{{^rows}}none{{/rows}}', { rows: [1] }), '');
  assert.equal(render('{{^missing}}none{{/missing}}', {}), 'none');
});

test('unknown names render as empty rather than throwing', () => {
  assert.equal(render('a{{nope}}b', {}), 'ab');
});

test('unbalanced sections are reported with the offending name', () => {
  assert.throws(() => render('{{#a}}x', {}), TemplateError);
  assert.throws(() => render('{{#a}}x{{/b}}', {}), /is closed by/);
  assert.throws(() => render('{{/a}}', {}), /no matching opening tag/);
});

test('rendering is not confused by a second call (no shared regex state)', () => {
  const tpl = '{{#rows}}{{n}}{{/rows}}';
  const data = { rows: [{ n: 1 }, { n: 2 }] };
  assert.equal(render(tpl, data), '12');
  assert.equal(render(tpl, data), '12', 'second render must match the first');
});

test('groupByProject truncates long lists and reports the remainder', () => {
  const many = Array.from({ length: 30 }, (_, i) => risk({ id: String(i) }));
  const [group] = groupByProject(many, { maxRowsPerProject: 10 });
  assert.equal(group.riskCount, 30);
  assert.equal(group.risks.length, 10);
  assert.equal(group.hiddenCount, 20);
});

test('groupByProject orders findings by severity then age', () => {
  const [group] = groupByProject([
    risk({ severity: 'MEDIUM', ageDays: 300 }),
    risk({ severity: 'CRITICAL', ageDays: 70 }),
    risk({ severity: 'HIGH', ageDays: 90 }),
  ]);
  assert.deepEqual(group.risks.map((r) => r.severity), ['CRITICAL', 'HIGH', 'MEDIUM']);
});

test('buildReminder renders the administrator template with real values', () => {
  const reminder = buildReminder([risk(), risk({ severity: 'CRITICAL' })], DEFAULT_TEMPLATE, {
    buckets: ['60+'],
    tenant: 'acme',
    now: new Date('2026-09-17T12:00:00Z'),
  });

  assert.match(reminder.subject, /2 open finding/);
  assert.match(reminder.subject, /more than 60 days/);
  assert.match(reminder.html, /SQL_Injection/);
  assert.match(reminder.html, /1 critical, 1 high/);
  assert.match(reminder.html, /acme/);
  assert.match(reminder.text, /Payments API \(2\)/);
  assert.match(reminder.text, /first detected 2026-01-01/);
});

test('findings cannot inject markup through the template', () => {
  const reminder = buildReminder([risk({ title: '<img src=x onerror=alert(1)>' })], DEFAULT_TEMPLATE, {
    buckets: ['60+'],
    tenant: 'acme',
  });
  assert.ok(!reminder.html.includes('<img src=x'));
  assert.match(reminder.html, /&lt;img src=x/);
});

test('a custom template controls the whole message', () => {
  const template = {
    subject: '[{{tenant}}] {{totalRisks}} overdue',
    html: '<h1>{{projectCount}}</h1>{{#projects}}<p>{{projectName}}: {{riskCount}}</p>{{/projects}}',
  };
  const reminder = buildReminder([risk(), risk({ projectId: 'p2', projectName: 'Web' })], template, {
    buckets: ['60+'],
    tenant: 'acme',
  });

  assert.equal(reminder.subject, '[acme] 2 overdue');
  assert.match(reminder.html, /<h1>2<\/h1>/);
  assert.match(reminder.html, /<p>Payments API: 1<\/p>/);
});
