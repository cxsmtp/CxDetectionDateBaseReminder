// Labs → Fusion: the Risk Hub list of each project whose latest scan was a Fusion scan, with what the AI engine
// found among it (src/fusion-ai.js), and the figures, rows and report the page makes of it (public/fusion-view.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { CxApiError } from '../src/cxone/client.js';
import { aiFindings, cleanAiResult, cleanEngines, readRiskFusion } from '../src/fusion-ai.js';
import { sastCoverage } from '../src/sast-languages.js';
import { engineLabel, fusionReportHtml, fusionResultRows, fusionRows, fusionTiles, fusionTotalOf } from '../public/fusion-view.js';

/** A Checkmarx One that answers `routes` (path → body or function of query) and 404 elsewhere. */
function fakeClient(routes) {
  const calls = [];
  return {
    calls,
    async request(path, { query } = {}) {
      calls.push({ path, query: query ?? {} });
      const hit = routes[path];
      if (hit === undefined) throw new CxApiError('Not Found', { status: 404, path });
      return typeof hit === 'function' ? hit(query ?? {}) : hit;
    },
  };
}

// The result behind the user's Risk Hub link: Fusion's critical SAST finding, and two traditional ones.
const AI = { resultHash: 'AZTOOZ+t2mzaZy9qAn1As5Zzudg=', similarityID: -282866862, queryID: 0, queryName: 'Improper_Authentication', group: 'TypeScript_CRITICAL', languageName: 'TypeScript', cweID: 287, severity: 'CRITICAL', state: 'CONFIRMED', status: 'NEW', firstFoundAt: '2026-10-20T06:55:45Z', foundAt: '2026-10-20T06:55:45Z', nodes: [{ fileName: '/juice-shop-20.3.0/routes/nftMint.ts', line: 41, name: 'metamaskAddress' }, { fileName: '/juice-shop-20.3.0/routes/nftMint.ts', line: 42, name: 'metamaskAddress' }], isAiGenerated: true };
const TRADITIONAL = [
  { resultHash: 'h1', queryName: 'SQL_Injection', severity: 'HIGH', state: 'TO_VERIFY', status: 'RECURRENT', isAiGenerated: false },
  { resultHash: 'h2', queryName: 'XSS', severity: 'MEDIUM', state: 'TO_VERIFY', status: 'NEW', isAiGenerated: false },
];

/** Risk Hub's list for a project (what the Workbench reads), as a risk source. */
const riskHub = (lists) => ({ calls: [], async fetchForProject(project) { this.calls.push(project.id); return lists[project.id] ?? []; } });
/** A tenant whose AI engine found `ai` in scan s1 (the filter honoured unless `ignoreFilter`). */
function tenant(ai, { ignoreFilter = false } = {}) {
  return fakeClient({
    '/api/sast-results': (q) => {
      const rows = ignoreFilter ? ai : ai.filter((r) => (q['is-ai-generated'] === 1 ? r.isAiGenerated : true));
      return { results: rows.slice(Number(q.offset ?? 0), Number(q.offset ?? 0) + Number(q.limit ?? 20)), totalCount: rows.length };
    },
  });
}
// Risk Hub's list for Juice Shop's Fusion scan: the AI engine's critical one (its id is the result's hash), a
// high SCA risk and a medium SAST one the deterministic engine found, and one Risk Hub says is fixed.
const RISKS = [
  { id: AI.resultHash, riskName: 'Improper_Authentication', severity: 'CRITICAL', status: 'NEW', state: 'CONFIRMED', engine: 'SAST', fileName: 'routes/nftMint.ts', firstDetectionDate: '2026-10-20T06:55:45Z', isAiGenerated: true },
  { id: 'sca1', riskName: 'CVE-2026-1111', severity: 'HIGH', status: 'RECURRENT', state: 'TO_VERIFY', engine: 'SCA', packageName: 'lodash', firstDetectionDate: '2026-09-01T00:00:00Z', isAiGenerated: false },
  { id: 'sast2', riskName: 'SQL_Injection', severity: 'MEDIUM', status: 'NEW', state: 'TO_VERIFY', engine: 'SAST', fileName: 'routes/search.ts', cweId: 89, firstDetectionDate: '2026-10-20T06:55:45Z' },
  { id: 'gone', riskName: 'XSS', severity: 'HIGH', status: 'FIXED', state: 'TO_VERIFY', engine: 'SAST', fileName: 'routes/old.ts' },
];
const P1 = [{ id: 'p1', name: 'Juice Shop' }];
const SCANS = { p1: { id: 's1', updatedAt: '2026-10-20T06:56:00Z' } };
const FUSION_SCAN = { p1: ['sast', 'sca', 'ai'] };

test('Fusion is the Risk Hub list of a project whose latest scan was a Fusion scan; New, Recurrent and Fixed as Risk Hub says', async () => {
  const client = tenant([AI, ...TRADITIONAL]);
  const hub = riskHub({ p1: RISKS });
  const f = await readRiskFusion(client, P1, SCANS, { engines: FUSION_SCAN, riskSource: hub });
  assert.deepEqual(hub.calls, ['p1'], 'read with the Workbench’s Risk Hub reader');
  assert.equal(f.source, 'risk-hub');
  assert.deepEqual([f.totals.total, f.totals.CRITICAL, f.totals.HIGH, f.totals.MEDIUM], [3, 1, 1, 1], 'every scanner, the fixed one apart');
  assert.deepEqual([f.totals.NEW, f.totals.RECURRENT, f.totals.FIXED], [2, 1, 1], 'Risk Hub’s own statuses');
  const listed = client.calls.find((c) => c.path === '/api/sast-results').query;
  assert.deepEqual([listed['scan-id'], listed['is-ai-generated'], listed['is-ai-generated-operation']], ['s1', 1, 'EQUAL'], 'what the AI engine found, to say which');
  assert.deepEqual(f.results.map((r) => [r.resultId, r.scanner, r.ai, r.engine, r.status]), [[AI.resultHash, 'SAST', true, 'FUSION', 'NEW'], ['sca1', 'SCA', false, 'FUSION', 'RECURRENT'], ['sast2', 'SAST', false, 'FUSION', 'NEW'], ['gone', 'SAST', false, 'FUSION', 'FIXED']], 'open ones by severity, the fixed one last');
  const r = f.results[0];
  assert.deepEqual([r.name, r.language, r.cwe, r.sourceFile, r.sourceLine, r.sinkLine, r.coveredAs], ['Improper Authentication', 'TypeScript', 287, '/juice-shop-20.3.0/routes/nftMint.ts', 41, 42, 'TypeScript'], 'the AI engine’s own result adds its detail');
  assert.equal(f.results[1].location, 'lodash');
});

test('a project whose latest scan was not a Fusion scan is left out, and said; one never scanned too', async () => {
  const hub = riskHub({ p1: RISKS, p2: RISKS });
  const f = await readRiskFusion(tenant([AI]), [...P1, { id: 'p2', name: 'Plain SAST' }, { id: 'p3', name: 'Never scanned' }], { ...SCANS, p2: { id: 's2' } }, { engines: { ...FUSION_SCAN, p2: ['sast', 'sca'] }, riskSource: hub });
  assert.deepEqual(hub.calls, ['p1']);
  assert.deepEqual([f.scanned, f.notFusion, f.noScan, Object.keys(f.projects)], [1, 1, 1, ['p1']]);
});

test('LAST: what the AI engine found in a language only it covers; a Checkmarx One that ignores the filter changes nothing', async () => {
  const sol = { ...AI, resultHash: 'sol1', languageName: 'Solidity', severity: 'HIGH', nodes: [{ fileName: 'contracts/Token.sol', line: 9 }] };
  const risks = [...RISKS, { id: 'sol1', riskName: 'Reentrancy', severity: 'HIGH', status: 'NEW', state: 'TO_VERIFY', engine: 'SAST', fileName: 'contracts/Token.sol' }, { id: 'tf1', riskName: 'Open bucket', severity: 'LOW', status: 'RECURRENT', engine: 'SAST', fileName: 'infra/main.tf', isAiGenerated: true }];
  const f = await readRiskFusion(tenant([AI, sol, ...TRADITIONAL], { ignoreFilter: true }), P1, SCANS, { engines: FUSION_SCAN, riskSource: riskHub({ p1: risks }) });
  const engine = Object.fromEntries(f.results.map((r) => [r.resultId, r.engine]));
  assert.deepEqual([engine.sol1, engine.tf1, engine[AI.resultHash], engine.sca1], ['LAST', 'LAST', 'FUSION', 'FUSION'], 'by the AI result’s language, else the risk’s file');
  const { FUSION, LAST } = f.projects.p1.engines;
  assert.deepEqual([FUSION.total, LAST.total, LAST.HIGH, LAST.NEW, LAST.RECURRENT], [3, 2, 1, 1, 1]);
  assert.deepEqual([f.totals.engines.LAST.total, f.totals.total], [2, 5]);
  assert.equal(f.results.find((r) => r.resultId === 'sast2').ai, false, 'a traditional result the unfiltered answer also gave is not taken for the AI engine’s');
});

test('every page of the AI engine’s results is read', async () => {
  const many = Array.from({ length: 1203 }, (_, i) => ({ ...AI, resultHash: `r${i}` }));
  const client = tenant(many);
  const f = await readRiskFusion(client, P1, SCANS, { engines: FUSION_SCAN, riskSource: riskHub({ p1: [{ id: 'r1202', riskName: 'x', severity: 'LOW', status: 'NEW' }] }) });
  assert.equal(client.calls.filter((c) => c.path === '/api/sast-results').length, 3);
  assert.equal(f.results[0].ai, true, 'the last page’s result matched');
});

test('the open risks as findings the credit, triage and remediation code acts on, with Risk Hub’s ids', async () => {
  const f = await readRiskFusion(tenant([AI]), P1, SCANS, { engines: FUSION_SCAN, riskSource: riskHub({ p1: [{ ...RISKS[0], alternateId: 'alt-1', groupId: 'g-1', similarityId: '-282866862' }, ...RISKS.slice(1)] }) });
  const { projects, initiators } = aiFindings(f);
  assert.deepEqual(projects[0].risks.map((r) => [r.riskId, r.alternateId, r.groupId, r.scanner, r.severity, r.state, r.scanId]), [[AI.resultHash, 'alt-1', 'g-1', 'SAST', 'CRITICAL', 'CONFIRMED', 's1'], ['sca1', 'sca1', '', 'SCA', 'HIGH', 'TO_VERIFY', 's1'], ['sast2', 'sast2', '', 'SAST', 'MEDIUM', 'TO_VERIFY', 's1']], 'the fixed one is not acted on');
  assert.deepEqual(initiators, { p1: { scanId: 's1' } });
});

test('the page: figures, project rows, Checkmarx-style result rows and the HTML report, for the engines ticked', async () => {
  const sol = { ...AI, resultHash: 'sol', languageName: 'Solidity', severity: 'HIGH', status: 'RECURRENT', state: 'TO_VERIFY', nodes: [{ fileName: 'contracts/Token.sol', line: 9 }] };
  const risks = [...RISKS, { id: 'sol', riskName: 'Reentrancy', severity: 'HIGH', status: 'RECURRENT', state: 'TO_VERIFY', engine: 'SAST', fileName: 'contracts/Token.sol' }];
  const f = await readRiskFusion(tenant([AI, sol]), P1, SCANS, { engines: FUSION_SCAN, riskSource: riskHub({ p1: risks }) });
  f.results.find((r) => r.resultId === AI.resultHash).url = 'https://deu.ast.checkmarx.net/riskhub/p1?resultId=AZTOOZ';
  f.projects.p1.url = 'https://deu.ast.checkmarx.net/projects/p1/overview';
  const scope = { projects: 3, names: { p1: 'Juice Shop' } };
  const t = fusionTiles(f, scope);
  assert.deepEqual([t.found.results, t.found.CRITICAL, t.found.HIGH, t.found.projects, t.found.of, t.change.NEW, t.change.RECURRENT, t.change.FIXED], [4, 1, 2, 1, 3, 2, 2, 1], 'both: every open risk');
  const fusionOnly = fusionTiles(f, scope, ['FUSION']);
  assert.deepEqual([fusionOnly.found.results, fusionOnly.found.HIGH, fusionOnly.change.FIXED], [3, 1, 1]);
  assert.deepEqual([fusionTiles(f, scope, ['LAST']).found.results, fusionTiles(f, scope, ['LAST']).found.HIGH], [1, 1]);
  const [row] = fusionRows(f, scope, ['FUSION']);
  assert.deepEqual([row.name, row.CRITICAL, row.HIGH, row.total, row.NEW, row.RECURRENT, row.FIXED, row.url], ['Juice Shop', 1, 1, 3, 2, 1, 1, f.projects.p1.url]);
  const rows = fusionResultRows(f, scope, ['FUSION', 'LAST'], 'p1');
  assert.deepEqual(rows.map((r) => [r.severity, r.scanner, r.engine, r.status]), [['CRITICAL', 'SAST', 'FUSION', 'New'], ['HIGH', 'SAST', 'LAST', 'Recurrent'], ['HIGH', 'SCA', 'FUSION', 'Recurrent'], ['MEDIUM', 'SAST', 'FUSION', 'New'], ['HIGH', 'SAST', 'FUSION', 'Fixed']], 'the fixed one last');
  assert.equal(rows[0].source, '/juice-shop-20.3.0/routes/nftMint.ts:41');
  assert.equal(rows[2].location, 'lodash');
  assert.equal(rows[0].projectUrl, f.projects.p1.url);
  assert.deepEqual(fusionResultRows(f, scope, ['LAST']).map((r) => r.id), ['sol']);
  assert.equal(fusionTotalOf(null, 'p1'), null);
  assert.deepEqual([fusionTotalOf(f, 'p1'), fusionTotalOf(f, 'p1', ['LAST'])], [4, 1]);
  assert.equal(engineLabel(['LAST', 'FUSION']), 'Fusion and LAST');
  const html = fusionReportHtml(f, scope, { organisation: 'Acme <Bank>', generatedAt: '2026-10-21T10:00:00Z' });
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes('Fusion and LAST results — Acme &lt;Bank&gt;'), 'titled by the ticks, escaped');
  assert.ok(html.includes('href="https://deu.ast.checkmarx.net/riskhub/p1?resultId=AZTOOZ"'), 'each result links to Checkmarx One');
  assert.ok(html.includes('CWE-287') && html.includes('nftMint.ts:41') && html.includes('lodash'));
  assert.ok(!/<script|src="http/i.test(html), 'nothing runs, nothing loaded from elsewhere');
  const fusionReport = fusionReportHtml(f, scope, { engines: ['FUSION'] });
  assert.ok(fusionReport.includes('<title>Fusion results</title>') && !fusionReport.includes('Token.sol'), 'Fusion only: no LAST result');
  const one = fusionReportHtml(f, scope, { engines: ['LAST'], projectId: 'p1' });
  assert.ok(one.includes('LAST results — Juice Shop') && one.includes('Token.sol') && !one.includes('nftMint.ts'), 'one project, LAST only');
  assert.equal(fusionReportHtml(f, scope, { projectId: 'nope' }).includes('No Fusion and LAST results.'), true);
});

test('a result cleaned keeps what the results page shows, and nothing it does not have', () => {
  const r = cleanAiResult({ resultHash: 'h', queryName: 'Path_Traversal', severity: 'weird', isAiGenerated: 1 }, { id: 'p', name: 'P' }, 's');
  assert.deepEqual([r.name, r.severity, r.cwe, r.sourceFile, r.ai], ['Path Traversal', 'INFO', null, '', true]);
});

test('Fusion is AI-generated in a language or framework traditional SAST supports; LAST, in any other', () => {
  const as = (language, extra = {}) => sastCoverage({ language, ...extra })?.language ?? 'LAST';
  assert.deepEqual(['TypeScript', 'CSharp', 'C#', 'CPP', 'VbNet', 'PLSQL', 'Objc', 'GO Language', 'Kotlin', 'Rust', 'Cobol'].map((l) => as(l)), ['TypeScript', 'C#', 'C#', 'C++', 'VB.NET', 'PL/SQL', 'Objective-C', 'Go', 'Kotlin', 'Rust', 'Cobol']);
  assert.deepEqual(['Vue', 'ReactJS', 'Node.js', 'Spring Boot', 'Django', 'Flutter', 'ASP.NET Core', 'Ruby on Rails'].map((l) => as(l)), ['JavaScript', 'JavaScript', 'JavaScript', 'Java', 'Python', 'Dart', 'C#', 'Ruby'], 'its frameworks count too');
  assert.deepEqual(['Solidity', 'Terraform', 'Elixir', 'Svelte', 'Bash'].map((l) => as(l)), ['LAST', 'LAST', 'LAST', 'LAST', 'LAST']);
  assert.equal(as('', { group: 'Java_Spring' }), 'Java', 'no language: its group');
  assert.equal(as('', { file: 'contracts/Token.sol' }), 'LAST', 'nor group: its file');
  assert.equal(as('', { file: 'app/views.py' }), 'Python');
  assert.deepEqual([cleanEngines(['last', 'x']), cleanEngines(''), cleanEngines('FUSION,LAST')], [['LAST'], ['FUSION', 'LAST'], ['FUSION', 'LAST']]);
});

test('Checkmarx One marks a Fusion result with isAiGenerated (the UI’s "LLM-Based: Yes"): only true counts', () => {
  // As /api/sast-results returns them for scan c40779dc… (Juice Shop 20.3.0).
  const ai = { resultHash: 'qvurq/MI9Xru4OPKyRSrcqzxjao=', queryID: 0, queryName: 'Missing Authentication for Critical Function', group: 'TypeScript_CRITICAL', severity: 'CRITICAL', changeDetails: { engineVersionChanged: false, queryChanged: false, codeChanged: false }, isAiGenerated: true };
  assert.equal(cleanAiResult(ai, P1[0], 's1').ai, true, 'LLM-Based: Yes');
  for (const value of [false, 'false', null, undefined, 0, '']) assert.equal(cleanAiResult({ ...ai, isAiGenerated: value }, P1[0], 's1').ai, false, String(value));
});

test('each project’s model (its scan, else its settings, else the tenant’s) and lines of code', async () => {
  const { projectFacts, modelIn } = await import('../src/fusion-usage.js');
  assert.equal(modelIn({ configs: [{ type: 'sast', value: {} }, { type: 'ai', value: { llmModel: 'opus-5.5' } }] }), 'opus-5.5');
  assert.equal(modelIn([{ key: 'scan.config.ai.llmModel', value: 'haiku-4.5' }]), 'haiku-4.5');
  assert.equal(modelIn({ llmModel: '' }), '');
  const client = fakeClient({
    '/api/scans/s1': { statusDetails: [{ name: 'sast', loc: 177362 }], metadata: { configs: [{ type: 'ai', value: { llmModel: 'mythos-5.1' } }] } },
    '/api/scans/s2': { statusDetails: [{ name: 'sast' }] },
    '/api/scans/s3': { statusDetails: [] },
    '/api/configuration/project': (q) => [{ key: 'scan.config.ai.llmModel', value: q['project-id'] === 'p2' ? 'opus-5.0' : '' }],
    '/api/configuration/tenant': [{ key: 'scan.config.ai.llmModel', value: 'opus-5.5' }],
  });
  const facts = await projectFacts(client, ['p1', 'p2', 'p3'], { p1: { id: 's1' }, p2: { id: 's2' }, p3: { id: 's3' } });
  assert.deepEqual(facts, { p1: { model: 'mythos-5.1', modelFrom: 'scan', loc: 177362, scanEngines: [] }, p2: { model: 'opus-5.0', modelFrom: 'project', loc: null, scanEngines: [] }, p3: { model: 'opus-5.5', modelFrom: 'tenant', loc: null, scanEngines: [] } });
  assert.equal(client.calls.filter((c) => c.path === '/api/configuration/tenant').length, 1, 'the tenant’s settings read once');
  const silent = await projectFacts(fakeClient({}), ['p1'], { p1: { id: 's1' } });
  assert.deepEqual(silent, { p1: { model: '', modelFrom: '', loc: null, scanEngines: [] } }, 'nothing answered: nothing made up');
});

test('each project’s AI scans and credits over a period, from the scans and the credit consumption by project', async () => {
  const { fusionUsage, usageRow } = await import('../src/fusion-usage.js');
  assert.deepEqual(usageRow({ creditsUsed: 20, actionsPerformed: { actions: [{ actionType: 'triage', transactionCount: 4 }, { actionType: 'remediation', transactionCount: 2 }, { actionType: 'fusion', transactionCount: 3 }] } }), { credits: 20, fusion: 10, actions: { triage: 4, remediation: 2, other: 3 } });
  const recent = new Date().toISOString();
  const client = fakeClient({
    '/api/scans': (q) => ({ scans: q['project-id'] === 'p1' ? [{ id: 'a', engines: ['sast', 'ai'], createdAt: recent }, { id: 'b', engines: ['sast'], createdAt: recent }, { id: 'c', engines: ['SAST', 'AI'], createdAt: recent }] : [{ id: 'd', createdAt: recent }] }),
    '/api/credits/consumption': (q) => (q.viewBy === 'project' && q.period === 'last_90_days' ? { items: [{ name: 'Juice Shop', creditsUsed: 13, actionsPerformed: { actions: [{ actionType: 'triage', transactionCount: 1 }] } }], totalPages: 1 } : { items: [] }),
  });
  const u = await fusionUsage(client, [{ id: 'p1', name: 'Juice Shop' }, { id: 'p2', name: 'Other' }], { period: 'last_90_days' });
  assert.deepEqual([u.period, u.days, u.creditsKnown], ['last_90_days', 90, true]);
  assert.deepEqual(u.projects.p1, { scans: 2, credits: 13, fusion: 12, actions: { triage: 1, remediation: 0, other: 0 }, perScan: 6 }, 'matched by name; 2 of 3 scans ran the AI engine');
  assert.deepEqual([u.projects.p2.scans, u.projects.p2.credits], [1, 0], 'no engines said: every completed scan; no consumption: 0');
  assert.deepEqual(u.totals, { scans: 3, credits: 13, fusion: 12 });
  const denied = await fusionUsage(fakeClient({ '/api/scans': { scans: [] }, '/api/credits/consumption': () => { throw new CxApiError('Forbidden', { status: 403 }); } }), [{ id: 'p1', name: 'x' }], { period: 'nonsense' });
  assert.deepEqual([denied.period, denied.creditsKnown, denied.projects.p1.credits], ['last_30_days', false, null], 'no permission: unknown, not 0');
});
