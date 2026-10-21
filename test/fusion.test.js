// Labs → Fusion: the AI-generated SAST results of each project's latest scan (src/fusion-ai.js), and the
// figures, rows and report the page makes of them (public/fusion-view.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { CxApiError } from '../src/cxone/client.js';
import { aiFindings, cleanAiResult, cleanEngines, readAiFusion } from '../src/fusion-ai.js';
import { sastCoverage } from '../src/sast-languages.js';
import { fusionReportHtml, fusionResultRows, fusionRows, fusionTiles, fusionTotalOf } from '../public/fusion-view.js';

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

/** A tenant whose scan s1 (project p1, scan before s0) has `rows`; the filter honoured unless `ignoreFilter`. */
function tenant(rows, { ignoreFilter = false, fixed = 2, aggregate = true } = {}) {
  return fakeClient({
    '/api/sast-results': (q) => {
      const ai = ignoreFilter ? rows : rows.filter((r) => (q['is-ai-generated'] === 1 ? r.isAiGenerated : true));
      return { results: ai.slice(Number(q.offset ?? 0), Number(q.offset ?? 0) + Number(q.limit ?? 20)), totalCount: ai.length };
    },
    ...(aggregate ? { '/api/sast-scan-summary/aggregate': (q) => ({ summaries: [{ severity: 'CRITICAL', count: rows.filter((r) => r.isAiGenerated && r.severity === 'CRITICAL').length }], totalCount: 1, asked: q }) } : {}),
    '/api/scans': { scans: [{ id: 's1', status: 'Completed', createdAt: '2026-10-20T06:46:28Z' }, { id: 's0', status: 'Completed', createdAt: '2026-10-10T06:46:28Z' }] },
    '/api/sast-scan-summary/compare/aggregate': (q) => ({ summaries: q.status === 'FIXED' && q['is-ai-generated'] === 1 && q['group-by-field'] === 'LANGUAGE' ? [{ language: 'TypeScript', count: fixed }] : [], totalCount: 1 }),
  });
}
const P1 = [{ id: 'p1', name: 'Juice Shop' }];
const SCANS = { p1: { id: 's1', updatedAt: '2026-10-20T06:56:00Z' } };

test('Fusion is the SAST results Checkmarx One marks AI-generated, asked for with is-ai-generated=1 (EQUAL)', async () => {
  const client = tenant([AI, ...TRADITIONAL]);
  const f = await readAiFusion(client, P1, SCANS);
  const listed = client.calls.find((c) => c.path === '/api/sast-results').query;
  assert.deepEqual([listed['scan-id'], listed['is-ai-generated'], listed['is-ai-generated-operation']], ['s1', 1, 'EQUAL']);
  const counted = client.calls.find((c) => c.path === '/api/sast-scan-summary/aggregate').query;
  assert.deepEqual([counted['group-by-field'], counted['is-ai-generated'], counted['is-ai-generated-operation']], ['SEVERITY', 1, 'EQUAL']);
  assert.deepEqual([f.totals.total, f.totals.CRITICAL, f.totals.NEW, f.totals.FIXED], [1, 1, 1, 2]);
  assert.equal(f.projects.p1.reported, 1, 'Checkmarx One’s own count, beside the listed');
  const compare = client.calls.find((c) => c.path === '/api/sast-scan-summary/compare/aggregate').query;
  assert.deepEqual([compare['scan-id'], compare['base-scan-id'], compare.status], ['s1', 's0', 'FIXED'], 'compared with the scan before');
  const r = f.results[0];
  assert.deepEqual([r.name, r.severity, r.state, r.status, r.cwe, r.language, r.sourceFile, r.sourceLine, r.sinkLine, r.firstFoundAt], ['Improper Authentication', 'CRITICAL', 'CONFIRMED', 'NEW', 287, 'TypeScript', '/juice-shop-20.3.0/routes/nftMint.ts', 41, 42, '2026-10-20T06:55:45.000Z']);
  assert.equal(r.hash, AI.resultHash, 'its hash, which opens it in Risk Hub');
});

test('a Checkmarx One that ignores the filter does not pass every SAST result off as Fusion’s', async () => {
  const f = await readAiFusion(tenant([AI, ...TRADITIONAL], { ignoreFilter: true }), P1, SCANS);
  assert.equal(f.totals.total, 1, 'only the one marked isAiGenerated');
  const unmarked = await readAiFusion(tenant(TRADITIONAL.map(({ isAiGenerated, ...r }) => r), { ignoreFilter: true }), P1, SCANS);
  assert.deepEqual([unmarked.totals.total, unmarked.unmarked], [0, 2], 'no flag at all: none counted, and said');
});

test('every page of results is read; a project with no scan before has no Fixed; one without a scan is counted apart', async () => {
  const many = Array.from({ length: 1203 }, (_, i) => ({ ...AI, resultHash: `r${i}`, severity: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'][i % 4], status: i % 3 ? 'RECURRENT' : 'NEW' }));
  const client = tenant(many);
  client.request = ((request) => async (path, opts) => (path === '/api/scans' ? { scans: [{ id: 's1', status: 'Completed' }] } : request(path, opts)))(client.request);
  const f = await readAiFusion(client, [...P1, { id: 'p2', name: 'Never scanned' }], SCANS);
  assert.equal(f.totals.total, 1203);
  assert.deepEqual([f.totals.CRITICAL, f.totals.LOW, f.totals.NEW, f.totals.RECURRENT], [301, 300, 401, 802]);
  assert.equal(f.projects.p1.fixedKnown, false, 'nothing to compare with');
  assert.equal(f.noScan, 1);
});

test('the results as findings the credit, triage and remediation code acts on, ids as Risk Hub’s', async () => {
  const f = await readAiFusion(tenant([AI]), P1, SCANS);
  const { projects, initiators } = aiFindings(f);
  assert.equal(projects.length, 1);
  const r = projects[0].risks[0];
  assert.deepEqual([r.riskId, r.alternateId, r.scanner, r.severity, r.state, r.scanId], [AI.resultHash, AI.resultHash, 'SAST', 'CRITICAL', 'CONFIRMED', 's1']);
  assert.deepEqual(initiators, { p1: { scanId: 's1' } });
});

test('the page: tiles, project rows, Checkmarx-style result rows, and the HTML report', async () => {
  const f = await readAiFusion(tenant([AI, { ...AI, resultHash: 'x', severity: 'HIGH', status: 'RECURRENT', state: 'TO_VERIFY' }]), P1, SCANS);
  f.results[0].url = 'https://deu.ast.checkmarx.net/riskhub/p1?resultId=AZTOOZ';
  f.projects.p1.url = 'https://deu.ast.checkmarx.net/projects/p1/overview';
  const scope = { projects: 3, names: { p1: 'Juice Shop' } };
  const t = fusionTiles(f, scope, '');
  assert.deepEqual([t.found.results, t.found.CRITICAL, t.found.projects, t.found.of, t.change.NEW, t.change.RECURRENT, t.change.FIXED], [2, 1, 1, 3, 1, 1, 2]);
  assert.equal(fusionTiles(f, scope, '').perCredit.results, null, 'no credits entered: nothing made up');
  const [row] = fusionRows(f, scope);
  assert.deepEqual([row.name, row.CRITICAL, row.HIGH, row.total, row.NEW, row.FIXED, row.url], ['Juice Shop', 1, 1, 2, 1, 2, f.projects.p1.url]);
  const rows = fusionResultRows(f, scope);
  assert.deepEqual(rows.map((r) => [r.severity, r.name, r.status, r.state]), [['CRITICAL', 'Improper Authentication', 'New', 'Confirmed'], ['HIGH', 'Improper Authentication', 'Recurrent', 'To verify']]);
  assert.equal(rows[0].source, '/juice-shop-20.3.0/routes/nftMint.ts:41');
  assert.equal(rows[0].projectUrl, f.projects.p1.url);
  assert.equal(fusionTotalOf(null, 'p1'), null);
  assert.equal(fusionTotalOf(f, 'p1'), 2);
  const html = fusionReportHtml(f, scope, { organisation: 'Acme <Bank>', generatedAt: '2026-10-21T10:00:00Z' });
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes('Acme &lt;Bank&gt;'), 'escaped');
  assert.ok(html.includes('href="https://deu.ast.checkmarx.net/riskhub/p1?resultId=AZTOOZ"'), 'each result links to Checkmarx One');
  assert.ok(html.includes('CWE-287') && html.includes('nftMint.ts:41'));
  assert.ok(!/<script|src="http/i.test(html), 'nothing runs, nothing loaded from elsewhere');
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

test('each project and the totals count Fusion and LAST apart, Fixed split by language', async () => {
  const sol = { ...AI, resultHash: 'sol1', languageName: 'Solidity', severity: 'HIGH', status: 'RECURRENT', nodes: [{ fileName: '/c/Token.sol', line: 9 }] };
  const client = tenant([AI, sol]);
  const compare = client.request;
  client.request = async (path, opts) => (path === '/api/sast-scan-summary/compare/aggregate' ? { summaries: [{ language: 'TypeScript', count: 2 }, { language: 'Solidity', count: 3 }] } : compare(path, opts));
  const f = await readAiFusion(client, P1, SCANS);
  assert.deepEqual(f.results.map((r) => [r.hash, r.engine]), [['AZTOOZ+t2mzaZy9qAn1As5Zzudg=', 'FUSION'], ['sol1', 'LAST']]);
  const { FUSION, LAST } = f.projects.p1.engines;
  assert.deepEqual([FUSION.total, FUSION.CRITICAL, FUSION.FIXED, LAST.total, LAST.HIGH, LAST.FIXED], [1, 1, 2, 1, 1, 3]);
  assert.deepEqual([f.totals.total, f.totals.FIXED, f.totals.engines.LAST.RECURRENT], [2, 5, 1]);
  const unnamed = tenant([AI]);
  unnamed.request = ((request) => async (path, opts) => (path === '/api/sast-scan-summary/compare/aggregate' ? { summaries: [{ cweID: 89, count: 4 }] } : request(path, opts)))(unnamed.request);
  const g = await readAiFusion(unnamed, P1, SCANS);
  assert.equal(g.projects.p1.engines.FUSION.fixedKnown, false, 'counts that do not say their language: not guessed');
});
