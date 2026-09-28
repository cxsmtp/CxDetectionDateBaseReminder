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

  // The subject leads with the project (when the mail covers just one) and the
  // age of the oldest finding, which is the number that prompts action.
  assert.match(reminder.subject, /2 open finding/);
  assert.match(reminder.subject, /\[Payments API\]/);
  assert.match(reminder.subject, /oldest 259 days/);
  assert.match(reminder.html, /SQL_Injection/);
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

test('the summary header carries a count per severity', () => {
  const reminder = buildReminder(
    [
      risk({ id: '1', severity: 'CRITICAL' }),
      risk({ id: '2', severity: 'CRITICAL' }),
      risk({ id: '3', severity: 'HIGH' }),
      risk({ id: '4', severity: 'LOW' }),
    ],
    DEFAULT_TEMPLATE,
    { buckets: [], tenant: 'acme' },
  );

  assert.match(reminder.html, /2<\/div>\s*<div[^>]*>Critical/, 'critical count');
  assert.match(reminder.html, /1<\/div>\s*<div[^>]*>High/, 'high count');
  assert.match(reminder.html, /0<\/div>\s*<div[^>]*>Medium/, 'medium shows zero, not blank');
  assert.match(reminder.html, /1<\/div>\s*<div[^>]*>Low/, 'low count');
});

test('branding renders a logo header and the call to action', () => {
  const branding = {
    companyName: 'Acme Corp',
    logoUrl: 'https://acme.example/logo.png',
    logoHeight: 48,
    accentColor: '#aa0000',
    callToAction: 'Fix the criticals before Friday.',
  };
  const reminder = buildReminder([risk()], DEFAULT_TEMPLATE, { buckets: [], tenant: 'acme', branding });

  assert.match(reminder.html, /<img src="https:\/\/acme\.example\/logo\.png"/);
  assert.match(reminder.html, /alt="Acme Corp"/);
  assert.match(reminder.html, /height:48px/);
  assert.match(reminder.html, /#aa0000/);
  assert.match(reminder.html, /Fix the criticals before Friday\./);
});

test('with no logo the company name still gives the mail a header', () => {
  const reminder = buildReminder([risk()], DEFAULT_TEMPLATE, {
    buckets: [],
    tenant: 'acme',
    branding: { companyName: 'Acme Corp', accentColor: '#1d4ed8' },
  });

  assert.ok(!reminder.html.includes('<img'), 'no broken image when no logo is set');
  assert.match(reminder.html, /Acme Corp/);
});

test('a single-project reminder names the project; a multi-project one does not', () => {
  const one = buildReminder([risk()], DEFAULT_TEMPLATE, { buckets: [], tenant: 'acme' });
  assert.match(one.subject, /\[Payments API\]/);

  const many = buildReminder([risk(), risk({ projectId: 'p2', projectName: 'Web' })], DEFAULT_TEMPLATE, {
    buckets: [],
    tenant: 'acme',
  });
  assert.ok(!many.subject.includes('['), 'no project prefix when several are covered');
  assert.match(many.html, /Open security findings need attention/);
});
