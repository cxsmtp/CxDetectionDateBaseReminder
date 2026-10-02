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
    allowRetriage: false,
    allowReremediation: false,
    adminContact: '',
  });
  assert.ok(!/apiKey|refresh_token"\s*:/.test(JSON.stringify(island(html))), 'no credential is embedded');
});

test('each project links to Checkmarx One for everything beyond the top 50', () => {
  const connection = { baseUrl: 'https://eu.ast.checkmarx.net' };
  const data = buildReportData([risk(1, 'HIGH')], { tenant: 't', connection, links: DEFAULT_LINK_TEMPLATES });
  const html = generateHtmlReport(data);
  assert.match(html, /href="https:\/\/eu\.ast\.checkmarx\.net\/riskhub\/p1"[^>]*>Proj \(1\) →/);
});

test("the report email's button downloads the attached report from the reminder server", () => {
  const connection = { baseUrl: 'https://eu.ast.checkmarx.net' };
  const data = buildReportData([risk(1, 'HIGH')], { connection, links: DEFAULT_LINK_TEMPLATES });
  const url = 'https://cx-reminder.corp.example/r/0f8fad5b-d9cb-469f-a165-70867728950e?s=abc';
  const email = buildReportEmail(data, { topCount: 1, downloadUrl: url });
  assert.match(email.html, /href="https:\/\/cx-reminder\.corp\.example\/r\/0f8fad5b[^"]*"[^>]*>Let&#39;s start fixing the vulnerabilities<\/a>/);
  assert.match(email.html, /Downloads your interactive report/);
  assert.match(email.html, /Or open in Checkmarx One: <a href="https:\/\/eu\.ast\.checkmarx\.net\/riskhub\/p1"/);
  assert.match(email.text, /Let's start fixing the vulnerabilities \(downloads your interactive report\): https:\/\/cx-reminder/);
  assert.ok(!/Start triaging/.test(email.html + email.text));
  // Never a link to anything but http(s).
  assert.ok(!buildReportEmail(data, { downloadUrl: 'javascript:alert(1)' }).html.includes('javascript:'));
});

test('without a download link the button opens each project in Checkmarx One', () => {
  const connection = { baseUrl: 'https://eu.ast.checkmarx.net' };
  const risks = [risk(1, 'HIGH'), { ...risk(2, 'LOW'), projectId: 'p2', projectName: 'Other <b>' }];
  const one = buildReportEmail(buildReportData([risk(1, 'HIGH')], { connection, links: DEFAULT_LINK_TEMPLATES }), { topCount: 1 });
  assert.match(one.html, /href="https:\/\/eu\.ast\.checkmarx\.net\/riskhub\/p1"[^>]*>Let&#39;s start fixing the vulnerabilities<\/a>/);
  const two = buildReportEmail(buildReportData(risks, { connection, links: DEFAULT_LINK_TEMPLATES }), { greeting: 'Hi <Ann>', topCount: 2 });
  assert.equal((two.html.match(/>Let&#39;s start fixing the vulnerabilities — /g) ?? []).length, 2);
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

test('Remediate runs through the reminder server only when the administrator allowed it', () => {
  const resolved = { ...risk(1, 'CRITICAL'), alternateId: 'alt-1', groupId: '1', scanId: 's1', url: 'https://eu.ast.checkmarx.net/riskhub/p1?resultId=r1' };
  const build = (remediationViaRelay) =>
    generateHtmlReport(buildReportData([resolved], { tenant: 't' }), {
      findings: [resolved],
      bulkFindings: [],
      relayUrl: 'https://reminder.example',
      remediationViaRelay,
      sign: () => ({ exp: 1, grant: 'g' }),
    });

  assert.match(build(true), /<button[^>]*data-action="remediate">Remediate<\/button>/);
  const off = build(false);
  assert.ok(!/data-action="remediate"/.test(off.slice(0, off.indexOf('<script'))));
  assert.match(off, /<a[^>]*data-action="remediate-link" href="https:\/\/eu\.ast\.checkmarx\.net\/riskhub\/p1\?resultId=r1"/);
});

test('the report carries the re-triage switch, a valid administrator contact and the credits dialog', () => {
  const data = buildReportData([risk(1, 'CRITICAL')], { tenant: 't' });
  const allowed = island(generateHtmlReport(data, { allowRetriage: true, adminContact: 'appsec@example.com' })).config;
  assert.equal(allowed.allowRetriage, true);
  assert.equal(allowed.adminContact, 'appsec@example.com');

  const html = generateHtmlReport(data, { adminContact: 'not an address"><script>' });
  assert.equal(island(html).config.allowRetriage, false);
  assert.equal(island(html).config.adminContact, '');
  assert.match(html, /<dialog id="credit-dialog"/);
});

test('the report shows its reminder server address, and one without an address can still be connected', () => {
  const resolved = { ...risk(1, 'CRITICAL'), alternateId: 'alt-1', groupId: '1', scanId: 's1' };
  const build = (relayUrl) =>
    generateHtmlReport(buildReportData([resolved], { tenant: 't' }), {
      findings: [resolved],
      bulkFindings: [],
      relayUrl,
      remediationViaRelay: true,
      sign: () => ({ exp: 1, grant: 'g' }),
    });

  const withServer = build('https://cx-reminder.corp.example/');
  assert.match(withServer, /<code id="server-url" class="server-url">https:\/\/cx-reminder\.corp\.example<\/code>/);
  assert.match(withServer, /id="server-change"[^>]*>Change</);
  assert.ok(!/id="connect"[^>]*disabled/.test(withServer));

  const without = build('');
  assert.match(without, /<code id="server-url" class="server-url">not set<\/code>/);
  assert.match(without, /id="server-change"[^>]*>Enter address</);
  assert.ok(!/id="connect"[^>]*disabled/.test(without), 'Connect asks for the address instead of being disabled');
  assert.equal(island(without).findings[0].grant, 'g', 'findings are signed, so the reader can triage once connected');
  assert.match(without, /data-action="remediate">Remediate</);

  const hostile = build('javascript:alert(1)');
  assert.equal(island(hostile).config.relayUrl, '');
});

test('findings AI cannot act on (IaC) say so, and offer a fix in Checkmarx One instead of Triage / Remediate', () => {
  const iac = { ...risk(1, 'CRITICAL'), scanner: 'IAC', url: 'https://eu.ast.checkmarx.net/r/1', aiUnavailable: 'AI Triage and Remediation support SAST and SCA only (this is IAC).' };
  const html = generateHtmlReport(buildReportData([iac], { tenant: 't' }), { findings: [iac], bulkFindings: [], relayUrl: 'https://r.example', remediationViaRelay: true, sign: () => ({ exp: 1, grant: 'g' }) });
  const row = html.slice(html.indexOf('<tr data-key="0"'), html.indexOf('</tr>', html.indexOf('<tr data-key="0"')));
  assert.match(row, /Manual fix/);
  assert.match(row, /No AI for IaC findings/);
  assert.match(row, />Fix in Checkmarx One</);
  assert.ok(!/data-action="triage"|data-action="remediate"/.test(row));
});
