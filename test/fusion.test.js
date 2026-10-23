// Labs → Fusion: only what the AI engine reported (no traditional SAST, SCA… results), for each project whose latest
// scan ran it, with Risk Hub's states (src/fusion-ai.js), and the figures, rows and report the page makes of it (public/fusion-view.js).
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

test('only what the AI engine reported: the traditional engines’ risks are left out; New, Recurrent and Fixed as Risk Hub says', async () => {
  const client = tenant([AI, ...TRADITIONAL]);
  const hub = riskHub({ p1: RISKS });
  const f = await readRiskFusion(client, P1, SCANS, { engines: FUSION_SCAN, riskSource: hub });
  assert.deepEqual(hub.calls, ['p1'], 'read with the Workbench’s Risk Hub reader');
  assert.equal(f.source, 'risk-hub');
  assert.deepEqual([f.totals.total, f.totals.CRITICAL, f.totals.HIGH, f.totals.MEDIUM], [1, 1, 0, 0], 'the AI engine’s one; SCA and traditional SAST left out');
  assert.deepEqual([f.totals.NEW, f.totals.RECURRENT, f.totals.FIXED], [1, 0, 0], 'Risk Hub’s own statuses');
  const listed = client.calls.find((c) => c.path === '/api/sast-results').query;
  assert.deepEqual([listed['scan-id'], listed['is-ai-generated'], listed['is-ai-generated-operation']], ['s1', 1, 'EQUAL'], 'what the AI engine found, to say which');
  assert.deepEqual(f.results.map((r) => [r.resultId, r.scanner, r.ai, r.engine, r.status]), [[AI.resultHash, 'SAST', true, 'FUSION', 'NEW']]);
  const r = f.results[0];
  assert.deepEqual([r.name, r.language, r.cwe, r.sourceFile, r.sourceLine, r.sinkLine, r.coveredAs], ['Improper Authentication', 'TypeScript', 287, '/juice-shop-20.3.0/routes/nftMint.ts', 41, 42, 'TypeScript'], 'the AI engine’s own result adds its detail');
});

test('an AI result Risk Hub does not list is listed from the SAST result, with its description; one with none gets its query’s', async () => {
  const own = { ...AI, resultHash: 'own1', description: '<p>User input reaches <b>eval()</b>.</p>' };
  const known = { ...AI, resultHash: 'q1', queryID: 4321, description: '' };
  const client = fakeClient({
    '/api/sast-results': () => ({ results: [own, known], totalCount: 2 }),
    '/api/queries/descriptions': (q) => (q.ids.includes('4321') ? [{ queryId: 4321, resultDescription: 'The query’s own words.' }] : []),
  });
  const f = await readRiskFusion(client, P1, SCANS, { engines: FUSION_SCAN, riskSource: riskHub({ p1: RISKS.slice(1) }) });
  assert.deepEqual(f.results.map((r) => [r.resultId, r.scanner, r.description]).sort(), [['own1', 'SAST', 'User input reaches eval() .'], ['q1', 'SAST', 'The query’s own words.']]);
  assert.equal(f.projects.p1.total, 2);
});

test('a project whose latest scan’s AI engine reported nothing is left out, and counted', async () => {
  const f = await readRiskFusion(tenant([]), [...P1, { id: 'p2', name: 'Quiet LAST' }], { ...SCANS, p2: { id: 's2' } }, { types: { p1: 'fusion', p2: 'last' }, riskSource: riskHub({ p1: [RISKS[0]], p2: RISKS.slice(1) }) });
  assert.deepEqual([Object.keys(f.projects), f.noAi, f.kinds], [['p1'], 1, { fusion: 1, last: 0 }]);
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
  assert.deepEqual([engine.sol1, engine.tf1, engine[AI.resultHash], engine.sca1], ['LAST', 'LAST', 'FUSION', undefined], 'by the AI result’s language, else the risk’s file');
  const { FUSION, LAST } = f.projects.p1.engines;
  assert.deepEqual([FUSION.total, LAST.total, LAST.HIGH, LAST.NEW, LAST.RECURRENT], [1, 2, 1, 1, 1]);
  assert.deepEqual([f.totals.engines.LAST.total, f.totals.total], [2, 3]);
  assert.ok(!f.results.some((r) => ['sast2', 'h1', 'h2', 'sca1'].includes(r.resultId)), 'a traditional result the unfiltered answer also gave is not taken for the AI engine’s');
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
  assert.deepEqual(projects[0].risks.map((r) => [r.riskId, r.alternateId, r.groupId, r.scanner, r.severity, r.state, r.scanId]), [[AI.resultHash, 'alt-1', 'g-1', 'SAST', 'CRITICAL', 'CONFIRMED', 's1']], 'only the AI engine’s');
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
  assert.deepEqual([t.found.results, t.found.CRITICAL, t.found.HIGH, t.found.projects, t.found.of, t.change.NEW, t.change.RECURRENT, t.change.FIXED], [2, 1, 1, 1, 3, 1, 1, 0], 'both: the AI engine’s open ones');
  const fusionOnly = fusionTiles(f, scope, ['FUSION']);
  assert.deepEqual([fusionOnly.found.results, fusionOnly.found.HIGH, fusionOnly.change.FIXED], [1, 0, 0]);
  assert.deepEqual([fusionTiles(f, scope, ['LAST']).found.results, fusionTiles(f, scope, ['LAST']).found.HIGH], [1, 1]);
  const [row] = fusionRows(f, scope, ['FUSION']);
  assert.deepEqual([row.name, row.CRITICAL, row.HIGH, row.total, row.NEW, row.RECURRENT, row.FIXED, row.url], ['Juice Shop', 1, 0, 1, 1, 0, 0, f.projects.p1.url]);
  const rows = fusionResultRows(f, scope, ['FUSION', 'LAST'], 'p1');
  assert.deepEqual(rows.map((r) => [r.severity, r.scanner, r.engine, r.status]), [['CRITICAL', 'SAST', 'FUSION', 'New'], ['HIGH', 'SAST', 'LAST', 'Recurrent']]);
  assert.equal(rows[0].source, '/juice-shop-20.3.0/routes/nftMint.ts:41');
  assert.equal(rows[0].projectUrl, f.projects.p1.url);
  assert.deepEqual(fusionResultRows(f, scope, ['LAST']).map((r) => r.id), ['sol']);
  assert.equal(fusionTotalOf(null, 'p1'), null);
  assert.deepEqual([fusionTotalOf(f, 'p1'), fusionTotalOf(f, 'p1', ['LAST'])], [2, 1]);
  assert.equal(engineLabel(['LAST', 'FUSION']), 'Fusion and LAST');
  const html = fusionReportHtml(f, scope, { organisation: 'Acme <Bank>', generatedAt: '2026-10-21T10:00:00Z' });
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes('Fusion and LAST results — Acme &lt;Bank&gt;'), 'titled by the ticks, escaped');
  assert.ok(html.includes('href="https://deu.ast.checkmarx.net/riskhub/p1?resultId=AZTOOZ"'), 'each result links to Checkmarx One');
  assert.ok(html.includes('CWE-287') && html.includes('nftMint.ts:41') && !html.includes('lodash'), 'no traditional result in it');
  assert.ok(!/<script|src="http/i.test(html), 'nothing runs, nothing loaded from elsewhere');
  const fusionReport = fusionReportHtml(f, scope, { engines: ['FUSION'] });
  assert.ok(fusionReport.includes('<title>Fusion results</title>') && !fusionReport.includes('Token.sol'), 'Fusion only: no LAST result');
  const one = fusionReportHtml(f, scope, { engines: ['LAST'], projectId: 'p1' });
  assert.ok(one.includes('LAST results — Juice Shop') && one.includes('Token.sol') && !one.includes('nftMint.ts'), 'one project, LAST only');
  assert.equal(fusionReportHtml(f, scope, { projectId: 'nope' }).includes('No Fusion and LAST results.'), true);
});

test('the page narrowed by status, state and AI Triage; projects by scan type, gold and pink', async () => {
  const risks = [{ ...RISKS[0], stateChangedBy: 'ai' }, RISKS[1], { ...RISKS[2], state: 'PROPOSED_NOT_EXPLOITABLE' }, RISKS[3]];
  // The AI engine's results of Juice Shop's scan only (abap-last's AI result is in Risk Hub; Quiet has none).
  const onlyS1 = fakeClient({ '/api/sast-results': (q) => ({ results: q['scan-id'] === 's1' && !q.offset ? [AI] : [], totalCount: q['scan-id'] === 's1' ? 1 : 0 }) });
  const f = await readRiskFusion(onlyS1, [...P1, { id: 'p2', name: 'abap-last' }, { id: 'p3', name: 'Quiet' }], { ...SCANS, p2: { id: 's2' }, p3: { id: 's3' } }, { types: { p1: 'fusion', p2: 'last', p3: 'last' }, riskSource: riskHub({ p1: risks, p2: [{ id: 'abap1', riskName: 'Missing Authorization', severity: 'HIGH', status: 'NEW', state: 'TO_VERIFY', isAiGenerated: true }], p3: [] }) });
  Object.assign(f.projects.p1, { model: 'haiku-4.5', modelFrom: 'scan', aiReported: 273, aiDuplicates: 47, aiAdded: 226, loc: 91970, files: 929 });
  Object.assign(f.projects.p2, { model: 'opus-4.7', modelFrom: 'environment', loc: 910, files: 5 });
  const scope = { projects: 5, names: { p1: 'Juice Shop', p2: 'abap-last', p3: 'Quiet' } };
  const all = fusionRows(f, scope);
  assert.deepEqual(all.map((r) => [r.name, r.scanType]), [['Juice Shop', 'fusion'], ['abap-last', 'last']], 'one whose AI engine reported nothing is left out');
  assert.equal(f.noAi, 1);
  assert.deepEqual(fusionRows(f, scope, ['FUSION']).map((r) => r.name), ['Juice Shop'], 'Fusion ticked alone: Fusion scans (and AI results of theirs)');
  assert.deepEqual(fusionRows(f, scope, ['LAST']).map((r) => r.name), ['abap-last']);
  const t = fusionTiles(f, scope);
  assert.deepEqual([t.states.TO_VERIFY, t.states.CONFIRMED, t.states.PROPOSED_NOT_EXPLOITABLE, t.found.aiTriaged, t.kinds], [1, 1, 0, 1, { fusion: 1, last: 1 }]);
  assert.deepEqual([t.added.found, t.added.duplicates, t.added.added, t.models, t.code], [273, 47, 226, [['haiku-4.5', 1], ['opus-4.7', 1]], { loc: 92880, files: 934 }]);
  const confirmed = { state: 'CONFIRMED' };
  assert.deepEqual(fusionRows(f, scope, null, confirmed).map((r) => [r.name, r.total, r.CONFIRMED]), [['Juice Shop', 1, 1]], 'only the projects with a match, counted by their matches');
  assert.deepEqual(fusionResultRows(f, scope, null, null, { aiTriaged: true }).map((r) => [r.id, r.stateKey, r.aiTriaged]), [[AI.resultHash, 'CONFIRMED', true]]);
  assert.deepEqual(fusionResultRows(f, scope, null, null, { status: 'NEW', state: 'TO_VERIFY' }).map((r) => r.id), ['abap1']);
  assert.equal(fusionTiles(f, scope, null, { status: 'FIXED' }).change.FIXED, 0, 'the fixed one was traditional SAST');
  const html = fusionReportHtml(f, scope, { filter: confirmed, colours: { fusion: '#0f766e', last: 'red;}' } });
  assert.ok(html.includes('--fusion: #0f766e') && html.includes('--last: #d6337a'), 'the reader’s colours, only real ones');
  assert.ok(html.includes(' · Confirmed · ') && html.includes('Juice Shop') && !html.includes('abap-last'), 'narrowed: said, and only the projects with a match');
  const both = fusionReportHtml(f, scope, {});
  assert.ok(both.includes('<tr class="fusion">') && both.includes('<tr class="last">') && both.includes('set by Checkmarx One'));
  assert.ok(!both.includes('273 → 226') && !both.includes('AI found'), 'only what the AI engine found: no count of what SAST also found');
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

test('each project’s model (its scan, else what Checkmarx One resolved for the scan, else its settings) and lines of code', async () => {
  const { projectFacts, modelIn } = await import('../src/fusion-usage.js');
  assert.equal(modelIn({ configs: [{ type: 'sast', value: {} }, { type: 'ai', value: { llmModel: 'opus-5.5' } }] }), 'opus-5.5');
  assert.equal(modelIn([{ key: 'scan.config.ai.llmModel', value: 'haiku-4.5' }]), 'haiku-4.5');
  assert.equal(modelIn({ llmModel: '' }), '');
  const client = fakeClient({
    '/api/scans/s1': { engines: ['sast', 'ai'], statusDetails: [{ name: 'sast', loc: 177362 }], metadata: { configs: [{ type: 'ai', value: { llmModel: 'haiku-4.5', fusionEnabled: 'true' } }] } },
    '/api/scans/s2': { engines: ['sast', 'ai'], statusDetails: [{ name: 'sast' }], metadata: { configs: [{ type: 'ai', value: { fusionEnabled: 'false' } }] } },
    '/api/scans/s3': { engines: ['sast', 'sca'], statusDetails: [] },
    '/api/configuration/scan': (q) => [{ key: 'scan.config.ai.llmModel', value: q['scan-id'] === 's2' ? 'opus-4.7' : 'x', originLevel: 'Environment' }],
    '/api/scans/s1/workflow': [{ Source: 'checkmarx-fusion-credit-seize-frankfurt', Info: 'checkmarx-fusion-credit-seize-frankfurt Fusion credits are disabled; skipping credit reservation.' }, { Source: 'last-worker-fusion-frankfurt', Info: 'started' }, { Source: 'last-result-handler-frankfurt', Info: 'last-result-handler-frankfurt Deduplicated 47 out of 273 total results' }],
    '/api/scans/s2/workflow': [{ Source: 'last-worker-frankfurt', Info: 'started' }],
    '/api/sast-metadata': { scans: [{ scanId: 's1', loc: 91970, fileCount: 929 }, { scanId: 's2', loc: 910, fileCount: 5 }] },
    '/api/sast-metadata/engine-version': [{ scanId: 's1', engineVersion: '9.7.7-679962' }],
  });
  const facts = await projectFacts(client, ['p1', 'p2', 'p3'], { p1: { id: 's1' }, p2: { id: 's2' }, p3: { id: 's3' } });
  assert.deepEqual(facts.p1, { scanType: 'fusion', fusionEnabled: true, model: 'haiku-4.5', modelFrom: 'scan', loc: 177362, files: 929, engineVersion: '9.7.7-679962', scanEngines: ['sast', 'ai'], aiReported: 273, aiDuplicates: 47, aiAdded: 226, fusionCredits: 'off' });
  assert.deepEqual([facts.p2.scanType, facts.p2.model, facts.p2.modelFrom, facts.p2.loc, facts.p2.files, facts.p2.aiReported], ['last', 'opus-4.7', 'environment', 910, 5, null], 'Fusion off: a LAST scan, the model as Checkmarx One resolved it, and where');
  assert.deepEqual([facts.p3.scanType, facts.p3.model], ['none', ''], 'no AI engine: nothing more read');
  assert.equal(client.calls.filter((c) => c.path === '/api/configuration/scan').length, 1, 'only for a scan that does not say');
  assert.ok(!client.calls.some((c) => c.path === '/api/scans/s3/workflow'));
  // An older Checkmarx One: no resolved settings, so the project's, then the tenant's.
  const older = fakeClient({
    '/api/scans/s2': { engines: ['sast', 'ai'], statusDetails: [] },
    '/api/configuration/project': [{ key: 'scan.config.ai.llmModel', value: '' }],
    '/api/configuration/tenant': [{ key: 'scan.config.ai.llmModel', value: 'opus-5.5' }],
  });
  const old = await projectFacts(older, ['p2'], { p2: { id: 's2' } });
  assert.deepEqual([old.p2.scanType, old.p2.model, old.p2.modelFrom], ['fusion', 'opus-5.5', 'tenant'], 'no Fusion setting said: taken as Fusion, as before');
  const silent = await projectFacts(fakeClient({}), ['p1'], { p1: { id: 's1' } });
  assert.deepEqual([silent.p1.scanType, silent.p1.model, silent.p1.modelFrom, silent.p1.loc], ['none', '', '', null], 'nothing answered: nothing made up');
});

test('a scan’s steps say which AI worker ran, what it added, and whether Fusion credits were reserved', async () => {
  const { readSteps, scanTypeOf, scanAiConfig } = await import('../src/fusion-usage.js');
  assert.deepEqual(readSteps([{ Source: 'last-worker-frankfurt', Info: 'last-worker-frankfurt started' }]), { worker: 'last', aiFound: null, aiDuplicates: null, aiAdded: null, fusionCredits: '' });
  assert.deepEqual(readSteps('nonsense'), { worker: '', aiFound: null, aiDuplicates: null, aiAdded: null, fusionCredits: '' });
  assert.equal(readSteps([{ Source: 'checkmarx-fusion-credit-seize-frankfurt', Info: 'Reserved 12 credits' }]).fusionCredits, 'reserved');
  assert.deepEqual([scanTypeOf(['sast', 'ai'], true), scanTypeOf(['sast', 'AI'], false), scanTypeOf(['sast'], true), scanTypeOf(['sast', 'ai'], null)], ['fusion', 'last', 'none', 'fusion']);
  assert.deepEqual(scanAiConfig({ metadata: { configs: [{ type: 'sast' }, { type: 'ai', value: { fusionEnabled: 'false' } }] } }), { fusionEnabled: 'false' });
  assert.equal(scanAiConfig({}), null);
});

test('the Workbench’s scan types: no AI said by the engines is none; the rest asked a hundred at a time', async () => {
  const { scanTypes } = await import('../src/fusion-usage.js');
  const client = fakeClient({
    '/api/scans': (q) => ({ scans: q['scan-ids'].map((id) => ({ id, engines: ['sast', 'ai'], metadata: { configs: [{ type: 'ai', value: { fusionEnabled: id === 's2' ? 'false' : 'true' } }] } })) }),
  });
  const types = await scanTypes(client, { p1: { id: 's1' }, p2: { id: 's2', engines: ['sast', 'ai'] }, p3: { id: 's3', engines: ['sast', 'sca'] }, p4: { id: 's4', engines: ['ai'], metadata: { configs: [{ type: 'ai', value: { fusionEnabled: 'false' } }] } }, p5: {} });
  assert.deepEqual(types, { p1: 'fusion', p2: 'last', p3: 'none', p4: 'last' });
  assert.equal(client.calls.length, 1, 'one call for the scans that do not say');
  assert.deepEqual(client.calls[0].query['scan-ids'], ['s1', 's2']);
  assert.deepEqual(await scanTypes(fakeClient({}), { p1: { id: 's1' } }), {}, 'not answered: not known');
});

test('the tenant’s credits and AI settings, as Checkmarx One gives them', async () => {
  const { tenantCredits, tenantAi } = await import('../src/fusion-usage.js');
  const client = fakeClient({
    '/api/credits/info': { available: '28854', total: '30000', used: '1146', actionsAvailable: 6557, actionsPerformed: 3475, enforcement: { state: 'active' } },
    '/api/configuration/tenant': [{ key: 'scan.config.ai.fusionEnabled', value: 'true' }, { key: 'scan.config.sast.extendedAnalysis', value: 'true' }, { key: 'scan.config.ai.llmModel', value: '', valuetypeparams: 'opus-4.7,haiku-4.5,opus-5.0,opus-5.5,mythos-5.1' }],
  });
  const c = await tenantCredits(client);
  assert.deepEqual([c.available, c.total, c.used, c.actionsPerformed, c.state], [28854, 30000, 1146, 3475, 'active']);
  assert.deepEqual(await tenantAi(client), { fusionEnabled: true, llmBased: true, model: '', models: ['opus-4.7', 'haiku-4.5', 'opus-5.0', 'opus-5.5', 'mythos-5.1'] });
  assert.equal(await tenantCredits(fakeClient({ '/api/credits/info': () => { throw new CxApiError('Forbidden', { status: 403 }); } })), null, 'no permission: unknown');
  assert.equal(await tenantCredits(fakeClient({ '/api/credits/info': { available: 'n/a' } })), null);
});

test('each project’s AI scans and credits over a period, from the scans and the credit consumption by project', async () => {
  const { fusionUsage, usageRow } = await import('../src/fusion-usage.js');
  assert.deepEqual(usageRow({ creditsUsed: 20, actionsPerformed: { actions: [{ actionType: 'triage', transactionCount: 4 }, { actionType: 'remediation', transactionCount: 2 }, { actionType: 'fusion', transactionCount: 3 }] } }), { credits: 20, fusion: 10, actions: { triage: 4, remediation: 2, other: 3 } });
  const recent = new Date().toISOString();
  const fusion = { configs: [{ type: 'ai', value: { fusionEnabled: 'true' } }] };
  const last = { configs: [{ type: 'ai', value: { fusionEnabled: 'false' } }] };
  const P1_SCANS = [{ id: 'a', projectId: 'p1', engines: ['sast', 'ai'], metadata: fusion, createdAt: recent }, { id: 'b', projectId: 'p1', engines: ['sast'], createdAt: recent }, { id: 'c', projectId: 'p1', engines: ['SAST', 'AI'], createdAt: recent }];
  const consumption = (q) => (q.viewBy === 'project' && q.period === 'last_90_days' ? { items: [{ name: 'Juice Shop', creditsUsed: 13, actionsPerformed: { actions: [{ actionType: 'triage', transactionCount: 1 }] } }], totalPages: 1 } : { items: [] });
  // The tenant's scans, every project at once.
  const client = fakeClient({
    '/api/scans': (q) => (q['project-id'] ? { scans: [] } : { scans: [...P1_SCANS, { id: 'd', projectId: 'p2', engines: ['sast', 'ai'], metadata: last, createdAt: recent }, { id: 'e', projectId: 'p9', engines: ['ai'], metadata: fusion, createdAt: recent }], filteredTotalCount: 5 }),
    '/api/credits/consumption': consumption,
  });
  const u = await fusionUsage(client, [{ id: 'p1', name: 'Juice Shop' }, { id: 'p2', name: 'Other' }], { period: 'last_90_days', scopeIds: ['p1', 'p2', 'p9', 'p10'] });
  assert.deepEqual([u.period, u.days, u.creditsKnown], ['last_90_days', 90, true]);
  assert.deepEqual(u.projects.p1, { scans: 2, fusionScans: 2, lastScans: 0, credits: 13, fusion: 12, actions: { triage: 1, remediation: 0, other: 0 }, perScan: 6 }, 'matched by name; 2 of 3 scans ran the AI engine');
  assert.deepEqual([u.projects.p2.scans, u.projects.p2.fusionScans, u.projects.p2.lastScans, u.projects.p2.credits], [1, 0, 1, 0], 'Fusion off: a LAST scan; no consumption: 0');
  assert.deepEqual(u.totals, { scans: 3, fusionScans: 2, lastScans: 1, credits: 13, fusion: 12 });
  assert.deepEqual(u.scope, { projects: 4, withFusion: 2, withLast: 1 }, 'of the line’s projects, those with a Fusion scan and with a LAST scan');
  assert.ok(!client.calls.some((c) => c.query['project-id']), 'one list for the tenant, not one per project');
  // A Checkmarx One that does not list the tenant's scans: each project's own.
  const own = await fusionUsage(fakeClient({ '/api/scans': (q) => (q['project-id'] === 'p1' ? { scans: P1_SCANS } : q['project-id'] ? { scans: [{ id: 'd', createdAt: recent }] } : (() => { throw new CxApiError('Forbidden', { status: 403 }); })()), '/api/credits/consumption': consumption }), [{ id: 'p1', name: 'Juice Shop' }, { id: 'p2', name: 'Other' }], { period: 'last_90_days' });
  assert.deepEqual([own.projects.p1.scans, own.projects.p2.scans, own.scope], [2, 1, null], 'no engines said: every completed scan');
  const denied = await fusionUsage(fakeClient({ '/api/scans': { scans: [] }, '/api/credits/consumption': () => { throw new CxApiError('Forbidden', { status: 403 }); } }), [{ id: 'p1', name: 'x' }], { period: 'nonsense' });
  assert.deepEqual([denied.period, denied.creditsKnown, denied.projects.p1.credits], ['last_30_days', false, null], 'no permission: unknown, not 0');
});

test('a LAST scan’s AI results are all LAST’s; states, AI-found and AI-triaged are counted', async () => {
  const { readRiskFusion } = await import('../src/fusion-ai.js');
  const risks = [
    { ...RISKS[0], stateChangedBy: 'ai' },
    { ...RISKS[2], state: 'PROPOSED_NOT_EXPLOITABLE' },
    { id: 'abap1', riskName: 'Missing Authorization', severity: 'HIGH', status: 'NEW', state: 'TO_VERIFY', engine: 'SAST', fileName: 'zreport.abap', isAiGenerated: true },
    RISKS[3],
  ];
  const f = await readRiskFusion(tenant([]), [...P1, { id: 'p2', name: 'abap-last' }], { ...SCANS, p2: { id: 's2' } }, { types: { p1: 'fusion', p2: 'last' }, riskSource: riskHub({ p1: risks, p2: [risks[2]] }) });
  assert.deepEqual([f.kinds, f.projects.p1.scanType, f.projects.p2.scanType], [{ fusion: 1, last: 1 }, 'fusion', 'last']);
  assert.deepEqual(f.results.filter((r) => r.projectId === 'p2').map((r) => r.engine), ['LAST'], 'everything a LAST scan found');
  const p1 = f.projects.p1;
  assert.deepEqual([p1.TO_VERIFY, p1.CONFIRMED, p1.PROPOSED_NOT_EXPLOITABLE, p1.NOT_EXPLOITABLE, p1.URGENT, p1.FIXED], [1, 1, 0, 0, 0, 0], 'states of the AI engine’s open results');
  assert.deepEqual([p1.aiFound, p1.aiTriaged, f.totals.aiFound, f.totals.aiTriaged], [2, 1, 3, 1]);
  assert.equal(f.results.find((r) => r.resultId === AI.resultHash).aiTriaged, true);
});
