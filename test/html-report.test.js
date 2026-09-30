import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReportData, buildReportEmail } from '../src/reminder.js';
import { DEFAULT_LINK_TEMPLATES } from '../src/links.js';
import { generateHtmlReport, selectTopFindings } from '../src/html-report.js';

const risk = (i, severity) => ({
  id: `r${i}`,
  riskId: `r${i}`,
  scanId: 's1',
  projectId: 'p1',
  projectName: 'Proj',
  title: `Vuln ${i}`,
  severity,
  scanner: 'SAST',
  location: `a.js:${i}`,
  state: 'TO_VERIFY',
  firstDetectedAt: '2025-01-01T00:00:00.000Z',
  ageDays: 100 + i,
});

const island = (html) => JSON.parse(html.match(/<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/)[1]);

test('the report shows the top 50 findings, worst severity then oldest, and says how many more exist', () => {
  const risks = Array.from({ length: 60 }, (_, i) => risk(i, i % 3 ? 'HIGH' : 'CRITICAL'));
  const data = buildReportData(risks, { tenant: 't' });
  const top = selectTopFindings(data);
  const html = generateHtmlReport(data);

  assert.equal(top.length, 50);
  assert.equal(top[0].severity, 'CRITICAL');
  assert.equal(top[0].riskId, 'r57', 'oldest critical first');
  assert.ok(top.slice(0, 20).every((f) => f.severity === 'CRITICAL'));
  assert.equal((html.match(/<tr data-key=/g) ?? []).length, 50);
  assert.match(html, /Showing 50 of 60 findings/);
  assert.ok(!html.slice(0, html.indexOf('<script')).includes('undefined'));
});

test('the report script parses and hostile finding text cannot break out of it', () => {
  const hostile = { ...risk(1, 'CRITICAL'), title: '</script><script>alert(1)</script>', location: '<img src=x onerror=alert(1)>' };
  const html = generateHtmlReport(buildReportData([hostile, risk(2, 'LOW')], { tenant: 't' }));

  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
  assert.ok(!html.includes('<img src=x'));
  assert.equal(island(html).findings[0].title, hostile.title);
});

test('AI actions are enabled only for SAST/SCA findings whose Checkmarx One ids were resolved', () => {
  const resolved = { ...risk(1, 'CRITICAL'), alternateId: 'alt-1', groupId: '123', scanId: 's1' };
  const unresolved = { ...risk(2, 'HIGH') };
  const iac = { ...risk(3, 'HIGH'), scanner: 'KICS', alternateId: 'alt-3', groupId: 'g', scanId: 's1' };
  const data = buildReportData([resolved, unresolved, iac], { tenant: 't' });
  const findings = selectTopFindings(data);
  const html = generateHtmlReport(data, { findings, connection: { tenant: 'acme', baseUrl: 'https://eu.ast.checkmarx.net' } });

  const byTitle = Object.fromEntries(island(html).findings.map((f) => [f.title, f]));
  assert.equal(byTitle['Vuln 1'].aiUnavailable, '');
  assert.equal(byTitle['Vuln 1'].alternateId, 'alt-1');
  assert.match(byTitle['Vuln 2'].aiUnavailable, /identifiers/);
  assert.match(byTitle['Vuln 3'].aiUnavailable, /SAST and SCA only/);
  assert.deepEqual(island(html).config, {
    tenant: 'acme',
    iamUrl: '',
    apiBaseUrl: 'https://eu.ast.checkmarx.net',
    portalUrl: 'https://eu.ast.checkmarx.net',
    relayUrl: '',
  });
  assert.ok(!/apiKey|refresh_token"\s*:/.test(JSON.stringify(island(html))), 'no credential is embedded');
});

test('each project links to Checkmarx One for everything beyond the top 50', () => {
  const connection = { baseUrl: 'https://eu.ast.checkmarx.net' };
  const data = buildReportData([risk(1, 'HIGH')], { tenant: 't', connection, links: DEFAULT_LINK_TEMPLATES });
  const html = generateHtmlReport(data);
  assert.match(html, /href="https:\/\/eu\.ast\.checkmarx\.net\/riskhub\/p1"[^>]*>Proj \(1\) →/);
});

test('the report email has a Start triaging button into Checkmarx One for each project', () => {
  const connection = { baseUrl: 'https://eu.ast.checkmarx.net' };
  const risks = [risk(1, 'HIGH'), { ...risk(2, 'LOW'), projectId: 'p2', projectName: 'Other <b>' }];
  const one = buildReportEmail(buildReportData([risk(1, 'HIGH')], { connection, links: DEFAULT_LINK_TEMPLATES }), { topCount: 1 });
  assert.match(one.html, /href="https:\/\/eu\.ast\.checkmarx\.net\/riskhub\/p1"[^>]*>Start triaging<\/a>/);
  assert.match(one.text, /Start triaging Proj: https:\/\/eu\.ast\.checkmarx\.net\/riskhub\/p1/);

  const two = buildReportEmail(buildReportData(risks, { connection, links: DEFAULT_LINK_TEMPLATES }), { greeting: 'Hi <Ann>', topCount: 2 });
  assert.equal((two.html.match(/>Start triaging — /g) ?? []).length, 2);
  assert.ok(two.html.includes('Other &lt;b&gt;') && two.html.includes('Hi &lt;Ann&gt;'));
});

test('"Triage all critical / high" cover every critical and high finding, not only the 50 shown', () => {
  const risks = [
    ...Array.from({ length: 30 }, (_, i) => risk(i, 'CRITICAL')),
    ...Array.from({ length: 40 }, (_, i) => risk(100 + i, 'HIGH')),
    ...Array.from({ length: 10 }, (_, i) => risk(200 + i, 'LOW')),
  ];
  const html = generateHtmlReport(buildReportData(risks, { tenant: 't' }));
  const data = island(html);

  assert.equal((html.match(/<tr data-key=/g) ?? []).length, 50);
  assert.equal(data.findings.filter((f) => f.shown).length, 50);
  assert.equal(data.findings.filter((f) => f.severity === 'CRITICAL').length, 30);
  assert.equal(data.findings.filter((f) => f.severity === 'HIGH').length, 40);
  assert.equal(data.findings.filter((f) => f.severity === 'LOW').length, 0, 'low findings past the top 50 are not carried');
  assert.match(html, /data-severity="CRITICAL"[^>]*>Triage all critical \(30\)/);
  assert.match(html, /data-severity="HIGH"[^>]*>Triage all high \(40\)/);
});
