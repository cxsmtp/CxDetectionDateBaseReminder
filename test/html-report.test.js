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
    remediateHere: false,
    repositories: {},
    adminContact: '',
  });
  assert.ok(!/apiKey|refresh_token"\s*:/.test(JSON.stringify(island(html))), 'no credential is embedded');
});

test("beyond the top 50, each project opens its own report from the reminder server, never Checkmarx One", () => {
  const connection = { baseUrl: 'https://eu.ast.checkmarx.net' };
  const risks = [risk(1, 'HIGH'), { ...risk(2, 'LOW'), projectId: 'p2', projectName: 'Other' }];
  const data = buildReportData(risks, { tenant: 't', connection, links: DEFAULT_LINK_TEMPLATES });
  const html = generateHtmlReport(data, { signProjectReport: (id) => ({ exp: 1, sig: `sig-${id}` }), projectReportScope: { severities: ['HIGH'] } });
  const more = html.match(/<section class="more">[\s\S]*?<\/section>/)[0];
  assert.match(more, /<button type="button" class="btn btn-outline" data-project-report="0"[^>]*><span translate="no">Proj<\/span> \(1\) →<\/button>/);
  assert.match(more, /data-project-report="1"[^>]*><span translate="no">Other<\/span> \(1\) →/);
  assert.doesNotMatch(more, /checkmarx|riskhub|<a /i, 'no link to Checkmarx One');
  const payload = JSON.parse(html.match(/id="report-data">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(payload.projectReports.map((p) => [p.projectId, p.sig, p.scope.severities]), [['p1', 'sig-p1', ['HIGH']], ['p2', 'sig-p2', ['HIGH']]]);
  // One project: its own report already; no buttons, and no Checkmarx One link either.
  const single = generateHtmlReport(buildReportData([risk(1, 'HIGH')], { tenant: 't', connection, links: DEFAULT_LINK_TEMPLATES }), { signProjectReport: () => ({ exp: 1, sig: 's' }) });
  assert.doesNotMatch(single, /data-project-report=|See every finding in Checkmarx One|Open in Checkmarx One:/);
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
  const resolved = { ...risk(1, 'CRITICAL'), state: 'CONFIRMED', alternateId: 'alt-1', groupId: '1', scanId: 's1', url: 'https://eu.ast.checkmarx.net/riskhub/p1?resultId=r1' };
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

test('the fence: Remediate is disabled for any finding not confirmed (to verify, proposed not exploitable…)', () => {
  for (const state of ['TO_VERIFY', 'PROPOSED_NOT_EXPLOITABLE', 'URGENT', '']) {
    const f = { ...risk(1, 'CRITICAL'), state, alternateId: 'alt-1', groupId: '1', scanId: 's1' };
    const html = generateHtmlReport(buildReportData([f], { tenant: 't' }), { findings: [f], bulkFindings: [], relayUrl: 'https://r.example', remediationViaRelay: true, sign: () => ({ exp: 1, grant: 'g' }) });
    assert.match(html, /<button[^>]*data-action="remediate" disabled title="Remediate works once triage has confirmed this finding/, state);
  }
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
  const resolved = { ...risk(1, 'CRITICAL'), state: 'CONFIRMED', alternateId: 'alt-1', groupId: '1', scanId: 's1' };
  const build = (relayUrl) =>
    generateHtmlReport(buildReportData([resolved], { tenant: 't' }), {
      findings: [resolved],
      bulkFindings: [],
      relayUrl,
      remediationViaRelay: true,
      sign: () => ({ exp: 1, grant: 'g' }),
    });

  const withServer = build('https://cx-reminder.corp.example/');
  assert.match(withServer, /<code id="server-url" class="server-url" translate="no">https:\/\/cx-reminder\.corp\.example<\/code>/);
  assert.match(withServer, /id="server-change"[^>]*>Change</);
  assert.ok(!/id="connect"[^>]*disabled/.test(withServer));

  const without = build('');
  assert.match(without, /<code id="server-url" class="server-url" translate="no">not set<\/code>/);
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

test('rows that are one Checkmarx One result are marked, and the report says how many results there are', () => {
  const risks = [
    { ...risk(1, 'HIGH'), alternateId: 'ALT-A', groupId: 'g1' },
    { ...risk(2, 'HIGH'), alternateId: 'ALT-A', groupId: 'g1' }, // another code path of the same result
    { ...risk(3, 'HIGH'), alternateId: 'ALT-B', groupId: 'g2' },
  ];
  const html = generateHtmlReport(buildReportData(risks, { tenant: 't' }));
  assert.match(html, /3 findings here are 2 Checkmarx One results/);
  assert.equal((html.match(/class="shared-note"/g) ?? []).length, 2, 'both rows of the shared result are marked');
  assert.match(html, /Same result R1<\/span> <span>Also listed:<\/span> <a class="shared-link" href="#row-\d" data-twin="\d">(below ↓|above ↑)<\/a>/);
  assert.match(html, /Triaged together, 1 credit/);
  assert.match(html, /<summary>why\?<\/summary><p><span>Checkmarx One gave these 2 rows the same result ID, so they are one result \(R1\)\.<\/span> <code>ALT-A<\/code>/);

  const unique = generateHtmlReport(buildReportData([risk(4, 'HIGH'), risk(5, 'HIGH')], { tenant: 't' }));
  assert.ok(!unique.includes('class="shared-explainer"'), 'no note when every row is its own result');
  assert.ok(!unique.includes('class="shared-note"'));
});

test('two shared results are told apart: each has its own label and colour, and each row links to its own twin', () => {
  // As in a real report: two Reflected_XSS results, each listed twice, interleaved.
  const at = (i, alt, location) => ({ ...risk(i, 'HIGH'), title: 'Reflected_XSS', alternateId: alt, groupId: `g-${alt}`, location });
  const risks = [at(1, 'h75gg1234567', 'session.js :: render'), at(2, 'hoHyR7654321', 'contributions.js :: render'), at(3, 'h75gg1234567', 'session.js :: render'), at(4, 'solo', 'memos.js :: render'), at(5, 'hoHyR7654321', 'contributions.js :: render')];
  const html = generateHtmlReport(buildReportData(risks, { tenant: 't' }));
  const row = (key) => html.slice(html.indexOf(`<tr data-key="${key}"`), html.indexOf('</tr>', html.indexOf(`<tr data-key="${key}"`)));
  const keyOf = (n) => String(island(html).findings.findIndex((f) => f.riskId === `r${n}`));
  const [k1, k2, k3, k4, k5] = [1, 2, 3, 4, 5].map(keyOf);
  const label = (key) => /data-result="(R\d)"/.exec(row(key))?.[1];
  assert.equal(label(k1), label(k3), 'rows 1 and 3 are one result');
  assert.equal(label(k2), label(k5), 'rows 2 and 5 are one result');
  assert.notEqual(label(k1), label(k2), 'the two results have different labels');
  assert.notEqual(/shared-c\d/.exec(row(k1))[0], /shared-c\d/.exec(row(k2))[0], 'and different colours');
  assert.equal(label(k4), undefined, 'a result listed once is not marked');
  assert.match(row(k1), new RegExp(`href="#row-${k3}"`), 'row 1 links to row 3');
  assert.match(row(k5), new RegExp(`href="#row-${k2}"`), 'row 5 links to row 2');
  assert.ok(!row(k1).includes(`href="#row-${k2}"`), 'and not to the other result');
  assert.match(row(k1), /Here every path ends at session\.js :: render/);
  assert.match(html, /5 findings here are 3 Checkmarx One results/);
});

test('a confirmed finding says why and how to fix it, with "why?" for the details', () => {
  const confirmed = { ...risk(1, 'HIGH'), title: 'Reflected_XSS', state: 'CONFIRMED', alternateId: 'a1', groupId: 'g1', url: 'https://eu.ast.checkmarx.net/r/1' };
  const open = { ...risk(2, 'HIGH'), title: 'Reflected_XSS', state: 'TO_VERIFY', alternateId: 'a2', groupId: 'g2' };
  const html = generateHtmlReport(buildReportData([confirmed, open], { tenant: 't' }), { remediationViaRelay: true });
  const row = (n) => {
    const key = island(html).findings.findIndex((f) => f.riskId === `r${n}`);
    return html.slice(html.indexOf(`<tr data-key="${key}"`), html.indexOf('</tr>', html.indexOf(`<tr data-key="${key}"`)));
  };
  assert.match(row(1), /<b>Why:<\/b> <span translate="no">Input from the request is written into the page without encoding, so an attacker can run script in a victim&#39;s browser\.<\/span><\/p>/);
  assert.match(row(1), /<b>Fix:<\/b> <span translate="no">Encode output for its context \(HTML, attribute, JavaScript, URL\) or use the template engine&#39;s auto-escaping; validate input against an allow-list\.<\/span><\/p>/);
  assert.match(row(1), /<summary>why\?<\/summary>[\s\S]*Checkmarx One followed the data from where it enters the application to this code[\s\S]*AI Remediation/);
  // Said once: the why and the fix are not repeated under "why?", and nobody is credited with confirming it.
  assert.equal(row(1).split('Input from the request is written').length - 1, 1, 'the why appears once');
  assert.equal(row(1).split('Encode output for its context').length - 1, 1, 'the fix appears once');
  assert.doesNotMatch(row(1), /Someone|Possible solution|Confirmed in Checkmarx One/);
  assert.ok(!row(2).includes('Why:'), 'only confirmed findings get the note');
  assert.ok(island(html).findings.every((f) => f.advice?.fix), 'the script gets the advice too, to render it after triage');
});

test('each finding carries its file and line, and each project its repository, for Open in IDE and Apply fix', () => {
  const data = buildReportData([risk(1, 'CRITICAL'), risk(2, 'HIGH'), risk(3, 'LOW')], { tenant: 't' });
  const [first, second, third] = selectTopFindings(data);
  first.codeLocation = { path: '/src/db.js', line: 42, column: 7 };
  second.codeLocation = { path: '../../etc/passwd', line: 1 };
  third.codeLocation = { path: 'a.tf', line: 'x' };
  const html = generateHtmlReport(data, {
    findings: [first, second, third],
    repositories: { p1: { url: 'https://github.com/acme/app', branch: 'main' }, p2: { url: 42 } },
  });
  const { config, findings } = island(html);
  assert.deepEqual(findings[0].loc, { path: 'src/db.js', line: 42, column: 7 });
  assert.equal(findings[1].loc, undefined, 'a path leaving the repository is dropped');
  assert.deepEqual(findings[2].loc, { path: 'a.tf', line: 0, column: 0 });
  assert.deepEqual(config.repositories, { p1: { url: 'https://github.com/acme/app', branch: 'main' } });
  assert.match(html, /const MZPatch = /, 'the patcher is inlined before the report script');
});

test('a package finding says which version to upgrade to', () => {
  const html = generateHtmlReport(buildReportData([{ ...risk(1, 'HIGH'), scanner: 'SCA', fixVersion: '4.17.21' }, risk(2, 'LOW')], { tenant: 't' }));
  assert.match(html, /data-l="upgrade to \{0\}" data-v="\[&quot;4\.17\.21&quot;\]" translate="no">upgrade to 4\.17\.21</);
  assert.equal((html.match(/>upgrade to /g) ?? []).length, 1);
});
