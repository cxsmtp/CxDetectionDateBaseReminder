import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LINK_TEMPLATES,
  PREVIOUS_LINK_DEFAULTS,
  engineSlug,
  exampleLinks,
  fillTemplate,
  projectUrl,
  riskUrl,
  safeUrl,
} from '../src/links.js';
import { buildReminder } from '../src/reminder.js';
import { DEFAULT_TEMPLATE } from '../src/template.js';
import { migrateLinks } from '../src/settings.js';

const RESULTS_ROUTE = { ...DEFAULT_LINK_TEMPLATES, risk: PREVIOUS_LINK_DEFAULTS.risk[0], project: PREVIOUS_LINK_DEFAULTS.project[0] };

const connection = { baseUrl: 'https://us.ast.checkmarx.net' };
const risk = (over = {}) => ({
  projectId: 'p-1',
  projectName: 'Payments API',
  scanId: 's-1',
  id: 'cye0DZkmtm6xwMN4J1Td3BKw03o=',
  scanner: 'SAST',
  title: 'SQL_Injection',
  severity: 'HIGH',
  location: '/db.cs',
  firstDetectedAt: '2026-01-01T00:00:00.000Z',
  ageDays: 260,
  bucket: '60+',
  ...over,
});

test('a finding opens Risk Hub with its details panel, and projects open Risk Hub', () => {
  assert.equal(
    riskUrl(risk(), connection),
    'https://us.ast.checkmarx.net/riskhub/p-1?pagination=%7B%22pageSize%22%3A50%2C%22currentPage%22%3A1%7D' +
      '&grouping=%7B%22groups%22%3A%5B%22severity%22%5D%7D&resultId=cye0DZkmtm6xwMN4J1Td3BKw03o%3D',
  );
  assert.equal(projectUrl({ projectId: 'p-1' }, connection), 'https://us.ast.checkmarx.net/riskhub/p-1');
  // Risk Hub needs no scan, so a finding without one still gets its own link.
  assert.match(riskUrl(risk({ scanId: '' }), connection), /resultId=cye0/);
});

test('a scan-based results template still gets the engine tab', () => {
  assert.equal(
    riskUrl(risk(), connection, RESULTS_ROUTE),
    'https://us.ast.checkmarx.net/results/s-1/p-1/sast?result-id=cye0DZkmtm6xwMN4J1Td3BKw03o%3D',
  );
  assert.match(riskUrl(risk({ scanner: 'SCA' }), connection, RESULTS_ROUTE), /\/sca\?/);
  assert.match(riskUrl(risk({ scanner: 'IAC' }), connection, RESULTS_ROUTE), /\/kics\?/);
});

test('ids are URL-encoded, since they contain +, / and =', () => {
  const url = riskUrl(risk({ id: 'P/Dq+jWE=' }), connection);
  assert.match(url, /resultId=P%2FDq%2BjWE%3D/);
  // The raw characters must not leak into the path or query.
  assert.ok(!url.endsWith('P/Dq+jWE='));
});

test('engineSlug maps known engines and degrades gracefully', () => {
  assert.equal(engineSlug('SAST'), 'sast');
  assert.equal(engineSlug('iac'), 'kics');
  assert.equal(engineSlug('CONTAINERS'), 'containers');
  assert.equal(engineSlug('something-new'), 'something-new');
  assert.equal(engineSlug(''), 'sast', 'an unknown engine still produces a usable link');
});

test('with a scan-based template, a finding with no scan falls back to the project page', () => {
  assert.equal(riskUrl(risk({ scanId: '' }), connection, RESULTS_ROUTE), 'https://us.ast.checkmarx.net/projects/p-1/overview');
  // A scan id passed alongside (from the project's latest scan) is used.
  assert.match(riskUrl(risk({ scanId: '' }), connection, RESULTS_ROUTE, 's-9'), /\/results\/s-9\//);
});

test('settings saved with the old default links move to Risk Hub; customised links are kept', () => {
  const migrated = migrateLinks({ baseUrl: "", project: PREVIOUS_LINK_DEFAULTS.project[0], risk: PREVIOUS_LINK_DEFAULTS.risk[0] });
  assert.equal(migrated.project, DEFAULT_LINK_TEMPLATES.project);
  assert.equal(migrated.risk, DEFAULT_LINK_TEMPLATES.risk);
  const custom = { baseUrl: '', project: '{baseUrl}/my/{projectId}', risk: '{baseUrl}/r/{riskId}' };
  assert.deepEqual(migrateLinks(custom), custom);
});

test('no base URL means no link, rather than a broken one', () => {
  assert.equal(riskUrl(risk(), {}), '');
  assert.equal(projectUrl({ projectId: 'p-1' }, {}), '');
  assert.equal(projectUrl({ projectId: '' }, connection), '');
});

test('an explicit base URL overrides the API host', () => {
  const templates = { ...DEFAULT_LINK_TEMPLATES, baseUrl: 'https://portal.example.com/' };
  assert.match(projectUrl({ projectId: 'p-1' }, connection, templates), /^https:\/\/portal\.example\.com\/riskhub\//);
});

test('only http(s) links are emitted', () => {
  assert.equal(safeUrl('javascript:alert(1)'), '');
  assert.equal(safeUrl('data:text/html,x'), '');
  assert.equal(safeUrl('not a url'), '');
  assert.equal(safeUrl('https://x.com/a'), 'https://x.com/a');
});

test('fillTemplate leaves unknown placeholders alone', () => {
  assert.equal(fillTemplate('{baseUrl}/x/{nope}', { baseUrl: 'https://a' }), 'https://a/x/{nope}');
  assert.equal(fillTemplate('{baseUrl}/{id}', { baseUrl: 'https://a/', id: 'a b' }), 'https://a/a%20b');
});

test('the default mail template renders a link per finding and per project', () => {
  const reminder = buildReminder([risk(), risk({ id: 'x2', title: 'XSS' })], DEFAULT_TEMPLATE, {
    buckets: ['60+'],
    tenant: 'acme',
    connection,
    links: DEFAULT_LINK_TEMPLATES,
  });

  const hrefs = [...reminder.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(hrefs.length, 3, 'one project link plus one per finding');
  assert.ok(hrefs.some((h) => h === 'https://us.ast.checkmarx.net/riskhub/p-1'));
  assert.ok(hrefs.every((h) => h.startsWith('https://us.ast.checkmarx.net')));

  // The plain-text part carries them too, for clients that strip HTML.
  assert.match(reminder.text, /https:\/\/us\.ast\.checkmarx\.net\/riskhub\/p-1\?.*resultId=/);
});

test('without a resolvable base URL the mail still renders, just unlinked', () => {
  const reminder = buildReminder([risk()], DEFAULT_TEMPLATE, {
    buckets: ['60+'],
    tenant: 'acme',
    connection: {},
    links: DEFAULT_LINK_TEMPLATES,
  });

  assert.ok(!reminder.html.includes('href="'), 'no empty or broken anchors');
  assert.match(reminder.html, /SQL_Injection/, 'the finding is still listed');
});

test('exampleLinks produces both worked examples for the settings page', () => {
  const examples = exampleLinks(connection, DEFAULT_LINK_TEMPLATES);
  assert.match(examples.project, /^https:\/\/us\.ast\.checkmarx\.net\/riskhub\//);
  assert.match(examples.risk, /\/riskhub\/.+&resultId=/);
});
