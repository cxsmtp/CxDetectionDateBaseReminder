// FAE Flush's runner with a stand-in Checkmarx One: a project that looks off stops and asks, and goes on as answered.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FaeFlushRunner, FaeFlushStore, FaeHistory, cleanOptions, valueOf, whyRefused } from '../src/fae-flush.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fae-unit-'));
const original = Array.from({ length: 30 }, (_, k) => ({ similarityID: `s${k}`, state: 'TO_VERIFY', severity: 'HIGH' }));

/** Checkmarx One as FAE Flush uses it; the FAE scan reports only `faeKeeps` of the project's results. */
function fakeClient({ gone = new Set(), faeExtra = 0, faeKeeps = 1, scanStatus = 'Completed', settings = [], refuse = [], refuseMark = [], results = original, avField = '', latest = null, rescanned = null } = {}) {
  const states = new Map();
  const calls = [];
  const patches = [];
  const posts = [];
  let made = 0;
  return {
    calls,
    states,
    patches,
    posts,
    download: async (p, file) => (fs.writeFileSync(file, 'PK'), 2),
    uploadFile: async () => 2,
    request: async (p, { method = 'GET', body, query } = {}) => {
      calls.push(`${method} ${p}`);
      if (p === '/api/projects' && method === 'POST') return { id: `fae-${(made += 1)}` };
      if (p === '/api/configuration/project' && method === 'GET') return settings;
      if (p === '/api/projects/last-scan') return latest ? { p1: { id: latest() } } : {};
      if (p === '/api/configuration/project' && method === 'PATCH') {
        patches.push(body.map((e) => e.key));
        if (body.some((e) => refuse.includes(e.key))) throw Object.assign(new Error('PATCH /api/configuration/project failed: 403 Forbidden'), { status: 403, body: '{"code":403,"message":"Forbidden"}' });
        return null;
      }
      if (p === '/api/uploads') return { url: 'https://storage.example/u1' };
      if (p.startsWith('/api/projects/') && gone.has(p.slice('/api/projects/'.length))) throw Object.assign(new Error(`GET ${p} failed: 404 Not Found`), { status: 404, body: '{"code":137,"message":"Project not found"}' });
      if (p === '/api/scans' && method === 'POST') {
        if (gone.has(body.project.id)) throw Object.assign(new Error('POST /api/scans failed: 404 Not Found'), { status: 404, body: `{"code":137,"message":"Project not found, ID: ${body.project.id}"}` });
        return { id: 'scan-fae' };
      }
      if (p.startsWith('/api/scans/')) return { status: scanStatus, statusDetails: [{ name: 'sast', status: scanStatus, loc: 1000 }] };
      if (p === '/api/sast-results') {
        if (query.offset > 0) return { results: [] };
        if (query['scan-id'] === 'scan-fae') return { results: [...results.filter((r) => !r.isAiGenerated).slice(0, faeKeeps), ...Array.from({ length: faeExtra }, (_, k) => ({ similarityID: `x${k}`, state: 'TO_VERIFY', severity: 'LOW' }))] };
        if (rescanned && query['scan-id'] === 'scan-2') return { results: rescanned.map((r) => ({ ...r, state: states.get(r.similarityID) ?? r.state })) };
        return { results: results.map((r) => ({ ...r, state: states.get(r.similarityID) ?? r.state })) };
      }
      if (p === '/api/sast-results-predicates/attack-vector' && method === 'POST') {
        posts.push('attack-vector');
        if (!avField || body.some((m) => !/^[0-9a-f]{16}$/.test(m.attackVectorId) || !m.filterBySimilarityId || !m.scanId)) throw Object.assign(new Error('POST /api/sast-results-predicates/attack-vector failed: 400 Bad Request'), { status: 400, body: '{"message":"bad"}' });
        for (const m of body) states.set(m.filterBySimilarityId, m.state);
        return {};
      }
      if (p === '/api/sast-results-predicates' && method === 'POST') {
        posts.push('similarity');
        // A tenant that groups similar results by attack vector refuses every mark by similarity id.
        if (avField) throw Object.assign(new Error('POST /api/sast-results-predicates failed: 400 Bad Request'), { status: 400, body: '{"code":4002,"message":"Account is configured to use Attack Vector IDs. Updates by Similarity ID are not allowed.","data":null}' });
        if (body.some((m) => refuseMark.includes(m.similarityId))) throw Object.assign(new Error('POST /api/sast-results-predicates failed: 400 Bad Request'), { status: 400, body: '{"code":400,"message":"invalid severity for this result"}' });
        for (const m of body) states.set(m.similarityId, m.state);
      }
      return [];
    },
  };
}

function runner(client, name) {
  const store = new FaeFlushStore({ file: path.join(dir, `${name}.json`) });
  const r = new FaeFlushRunner({ store, clientOf: () => client, tmpDir: dir });
  r.start({ by: 'a@acme.io', deleteFae: true, preview: { projects: [{ id: 'p1', name: 'Payments', sourceScanId: 'scan-1', loc: 1000, toVerify: 30 }] } });
  return r;
}
const turns = async (r, n) => {
  for (let i = 0; i < n; i += 1) await r.tick();
};

test('marking nearly everything stops and asks; "Mark anyway" goes on, and the run finishes', async () => {
  const client = fakeClient({ faeKeeps: 1 });
  const r = runner(client, 'many');
  await turns(r, 4);
  const p = r.job.projects[0];
  assert.equal(p.step, 'needs-ok');
  assert.equal(p.exception.code, 'many');
  assert.equal(client.states.size, 0, 'nothing marked before an answer');
  assert.equal(r.job.state, 'running');
  assert.throws(() => r.decide('p1', 'later', 'a@acme.io'), /Mark, continue, skip or retry/);
  r.decide('p1', 'mark', 'a@acme.io');
  await turns(r, 4);
  assert.equal(p.step, 'done');
  assert.equal(p.counts.marked, 29);
  assert.equal(p.counts.revalidated, 29);
  assert.equal(p.faeDeleted, true);
  assert.equal(r.job.state, 'done');
});

test('nothing to mark: no question, even when the FAE scan reported results the project does not have', async () => {
  // Every result To verify still reported, and 9 more the project does not have: nothing would be marked.
  const r = runner(fakeClient({ faeKeeps: 30, faeExtra: 9 }), 'nothing-to-mark');
  await turns(r, 5);
  const p = r.job.projects[0];
  assert.equal(p.counts.notReported, 0);
  assert.equal(p.counts.extra, 9);
  assert.equal(p.exception, null);
  assert.equal(p.step, 'done');
  assert.equal(p.counts.marked ?? 0, 0);
});

test('several projects asking: "Mark anyway" for all of them at once; those it does not fit are left, and said why', async () => {
  const client = fakeClient({ faeKeeps: 1 });
  const store = new FaeFlushStore({ file: path.join(dir, 'many-at-once.json') });
  const r = new FaeFlushRunner({ store, clientOf: () => client, tmpDir: dir });
  r.start({ by: 'a@acme.io', deleteFae: true, preview: { projects: ['p1', 'p2', 'p3'].map((id) => ({ id, name: id, sourceScanId: 'scan-1', loc: 1000, toVerify: 30 })) } });
  await turns(r, 6);
  assert.deepEqual(r.job.projects.map((p) => p.step), ['needs-ok', 'needs-ok', 'needs-ok']);
  // One of them has a question marking cannot answer.
  r.job.projects[2].exception = { code: 'scan', text: 'The FAE scan failed.' };
  const out = r.decideMany(['p1', 'p2', 'p3'], 'mark', 'a@acme.io');
  assert.equal(out.done, 2);
  assert.deepEqual(out.skipped.map((s) => s.project), ['p3']);
  await turns(r, 6);
  assert.deepEqual(r.job.projects.map((p) => p.step), ['done', 'done', 'needs-ok']);
});

test('a failed FAE scan marks nothing; Skip leaves its _FAE project to look at', async () => {
  const client = fakeClient({ scanStatus: 'Failed' });
  const r = runner(client, 'failed');
  await turns(r, 3);
  const p = r.job.projects[0];
  assert.equal(p.exception.code, 'scan');
  assert.throws(() => r.decide('p1', 'mark', 'a@acme.io'), /Nothing to mark/);
  r.decide('p1', 'skip', 'a@acme.io');
  await turns(r, 1);
  assert.equal(p.step, 'skipped');
  assert.equal(p.faeDeleted, false);
  assert.equal(r.job.state, 'done');
  assert.ok(!client.calls.includes('POST /api/sast-results-predicates'));
});

test('the run is kept on disk and carries on from where it was', async () => {
  const client = fakeClient({ faeKeeps: 10 });
  const r = runner(client, 'restart');
  await turns(r, 1);
  assert.equal(r.job.projects[0].step, 'scanning');
  const again = new FaeFlushRunner({ store: new FaeFlushStore({ file: path.join(dir, 'restart.json') }), clientOf: () => client, tmpDir: dir });
  await turns(again, 5);
  assert.equal(again.job.projects[0].step, 'done');
  assert.equal(again.job.projects[0].counts.marked, 20);
});

test('automatic: downloaded and uploaded, else the repository; Checkmarx One\'s own copy in place no longer offered', async () => {
  const client = fakeClient({ faeKeeps: 10 });
  const posted = [];
  client.redirectOf = async () => ({ status: 302, location: 'https://cx.example/storage/repostore.x/t/repos/r/scan-1?X-Amz-Expires=900&X-Amz-Signature=s' });
  client.download = async () => {
    throw Object.assign(new Error('GET the storage address of /api/repostore/code/scan-1 failed: 401 with the access token, 401 without it'), { status: 401 });
  };
  const request = client.request;
  client.request = async (p, opts = {}) => {
    if (p === '/api/scans' && opts.method === 'POST') posted.push(opts.body.type === 'git' ? 'git' : opts.body.handler.uploadUrl.includes('/storage/') ? 'link' : 'upload');
    return request(p, opts);
  };
  const store = new FaeFlushStore({ file: path.join(dir, 'auto-order.json') });
  const r = new FaeFlushRunner({ store, clientOf: () => client, tmpDir: dir });
  r.start({ by: 'a@acme.io', deleteFae: true, preview: { projects: [{ id: 'p1', name: 'Payments', sourceScanId: 'scan-1', loc: 1000, toVerify: 30, codeKept: true, repoUrl: 'https://github.com/acme/payments', commit: 'abc123' }] } });
  await turns(r, 1);
  const p = r.job.projects[0];
  assert.equal(p.step, 'scanning');
  assert.equal(p.codeSource, 'git');
  assert.deepEqual(posted, ['git'], 'the signed address is never handed to the scanner unless chosen');
  assert.deepEqual(p.attempts.filter((a) => a.what.startsWith('code:')).map((a) => [a.what, a.ok]), [['code: download and upload', false], ['code: the repository', true]]);
  assert.match(p.attempts[p.attempts.length - 2].detail, /401 with the access token, 401 without it/, 'the timeline says how the storage address was tried');

  // Checkmarx One's own copy in place is no longer offered (a live tenant's scanner refuses it): such a run is Automatic.
  assert.equal(cleanOptions({ source: 'link' }).source, 'auto');
});

test('report only, then "Mark now"; and how readily it stops to ask', async () => {
  const { SENSITIVITY } = await import('../src/fae-flush.js');
  const client = fakeClient({ faeKeeps: 10 });
  const store = new FaeFlushStore({ file: path.join(dir, 'report.json') });
  const r = new FaeFlushRunner({ store, clientOf: () => client, tmpDir: dir });
  r.start({ by: 'a@acme.io', deleteFae: false, options: { mode: 'report', sensitivity: 'often' }, preview: { projects: [{ id: 'p1', name: 'Payments', sourceScanId: 'scan-1', loc: 1000, toVerify: 30 }] } });
  assert.equal(r.limitsNow, SENSITIVITY.often);
  await turns(r, 4);
  const p = r.job.projects[0];
  assert.deepEqual([p.step, p.counts.notReported, client.states.size, r.job.state], ['reported', 20, 0, 'done']);
  r.markReported('a@acme.io');
  await turns(r, 3);
  assert.deepEqual([p.step, p.counts.marked, client.states.size], ['done', 20, 20]);
});

test('one mark covers every result sharing a similarity id: counted as Checkmarx One counts them; Not exploitable; money saved', async () => {
  const client = fakeClient({ faeKeeps: 10 });
  // The last 5 findings each show up twice in the project's scan (the same similarity id).
  const twice = original.slice(25).map((r) => ({ ...r }));
  const request = client.request;
  client.request = async (p, opts = {}) => {
    const out = await request(p, opts);
    if (p === '/api/sast-results' && opts.query['scan-id'] !== 'scan-fae' && !(opts.query.offset > 0)) out.results.push(...twice.map((r) => ({ ...r, state: client.states.get(r.similarityID) ?? r.state })));
    return out;
  };
  const history = new FaeHistory({ file: path.join(dir, 'twice-history.json') });
  const r = new FaeFlushRunner({ store: new FaeFlushStore({ file: path.join(dir, 'twice.json') }), clientOf: () => client, history, tmpDir: dir });
  r.start({ by: 'a@acme.io', deleteFae: true, options: { markAs: 'ne' }, preview: { projects: [{ id: 'p1', name: 'Payments', sourceScanId: 'scan-1', loc: 1000, toVerify: 35, codeKept: true }] } });
  await turns(r, 8);
  const p = r.job.projects[0];
  assert.equal(p.step, 'done', JSON.stringify(p.exception));
  assert.deepEqual([p.counts.toVerify, p.counts.toVerifyFindings], [35, 30]);
  assert.deepEqual([p.counts.marked, p.counts.markedFindings, p.counts.revalidated], [25, 20, 25], '20 findings marked, 25 results');
  assert.equal([...client.states.values()].filter((s) => s === 'NOT_EXPLOITABLE').length, 20, 'one predicate per finding, Not exploitable');

  const v = valueOf(history, { triageMinutes: 30, hourlyRate: 60, creditPrice: 2, currency: 'EUR' });
  assert.deepEqual([v.total.kept, v.total.keptFindings, v.total.byState.NOT_EXPLOITABLE], [25, 20, 25]);
  // A person triages each finding once (20 × 30 min = 10 h × 60 = 600); AI Triage costs a credit a result (25 × 2 = 50).
  assert.deepEqual([v.saved.hours, v.saved.hoursCost, v.saved.credits, v.saved.creditsCost, v.saved.money, v.saved.currency], [10, 600, 25, 50, 650, 'EUR']);
  assert.equal(v.runs[0].money, 650);
  assert.equal(v.projects[0].money, 650);
  assert.equal(valueOf(history, {}).saved.money, null, 'no hourly cost or credit price: no money');

  // Undo: every result back to To verify, counted the same way.
  const undone = await r.undo('a@acme.io');
  assert.deepEqual(undone, { restored: 25, changedSince: 0 });
  assert.deepEqual([valueOf(history, {}).total.kept, valueOf(history, {}).total.keptFindings], [0, 0]);
});

test('a refused call says why, in Checkmarx One\'s own words when its answer gives them', () => {
  const error = (message, body) => Object.assign(new Error(message), { body });
  assert.equal(whyRefused(error('POST /api/scans failed: 404 Not Found', '{"code":104,"message":"repository not found or no access"}')), 'POST /api/scans failed: 404 Not Found: 104 repository not found or no access');
  assert.equal(whyRefused(error('PUT upload failed: 401 with the access token', 'Unauthorized\n')), 'PUT upload failed: 401 with the access token: Unauthorized');
  assert.equal(whyRefused(error('GET x failed: 500', '')), 'GET x failed: 500');
  assert.equal(whyRefused(error('failed: Unauthorized', 'Unauthorized')), 'failed: Unauthorized', 'not said twice');
});

// Checkmarx One lists every setting as the project's own, most of them empty.
const SETTINGS = [
  { key: 'scan.config.sast.presetName', originLevel: 'Project', value: 'ASA Premium' },
  { key: 'scan.config.sast.filter', originLevel: 'Project', value: '!**/test/**' },
  { key: 'scan.config.sast.fastScanMode', originLevel: 'Project', value: '' },
  { key: 'scan.config.sast.engineVerbose', originLevel: 'Project', value: '' },
  { key: 'scan.config.sast.findingsAnalysis', originLevel: 'Project', value: '' },
  { key: 'scan.config.sast.languageMode', originLevel: 'Tenant', value: 'multi' },
  { key: 'scan.config.sca.filter', originLevel: 'Project', value: 'x' },
];

test('the _FAE project gets only the settings that have a value, and Findings Analysis, in one call', async () => {
  const client = fakeClient({ faeKeeps: 25, settings: SETTINGS });
  const r = runner(client, 'settings-ok');
  await turns(r, 6);
  const p = r.job.projects[0];
  assert.deepEqual(client.patches, [['scan.config.sast.presetName', 'scan.config.sast.filter', 'scan.config.sast.findingsAnalysis']]);
  assert.equal(p.faeConfigured, true);
  assert.match(p.attempts.find((a) => a.what === 'project made').detail, /2 of 2 SAST setting\(s\) copied\)$/);
  assert.equal(p.step, 'done');
});

test('a refused setting that does not change the results is left out and named; the run goes on', async () => {
  const client = fakeClient({ faeKeeps: 25, settings: SETTINGS, refuse: ['scan.config.sast.filter'] });
  const r = runner(client, 'settings-filter');
  await turns(r, 6);
  const p = r.job.projects[0];
  // All together, then Findings Analysis alone, then each setting alone.
  assert.deepEqual(client.patches, [['scan.config.sast.presetName', 'scan.config.sast.filter', 'scan.config.sast.findingsAnalysis'], ['scan.config.sast.findingsAnalysis'], ['scan.config.sast.presetName'], ['scan.config.sast.filter']]);
  assert.match(p.attempts.find((a) => a.what === 'project made').detail, /1 of 2 SAST setting\(s\) copied; refused: filter \(.*403 Forbidden\)/);
  assert.equal(p.step, 'done');
  assert.equal(p.counts.marked, 5);
});

test('a refused preset stops to ask before any scan; "Carry on without them" scans, Retry tries again', async () => {
  const client = fakeClient({ faeKeeps: 25, settings: SETTINGS, refuse: ['scan.config.sast.presetName'] });
  const r = runner(client, 'settings-preset');
  await turns(r, 2);
  const p = r.job.projects[0];
  assert.equal(p.step, 'needs-ok');
  assert.equal(p.exception.code, 'settings');
  assert.match(p.exception.text, /would not copy this setting to Payments_FAE: presetName \(.*403 Forbidden\)\. Without it/);
  assert.ok(!client.calls.includes('POST /api/scans'), 'nothing scanned');
  assert.throws(() => r.decide('p1', 'mark', 'a@acme.io'), /Nothing to mark/);
  r.decide('p1', 'retry', 'a@acme.io');
  await turns(r, 2);
  assert.equal(p.exception.code, 'settings', 'still refused: asks again');
  assert.equal(p.faeProjectId, 'fae-1', 'the same _FAE project');
  r.decide('p1', 'continue', 'a@acme.io');
  await turns(r, 6);
  assert.equal(p.step, 'done');
  assert.ok(p.attempts.some((a) => a.what === 'carried on without settings' && /presetName/.test(a.detail)));
  assert.throws(() => r.decide('p1', 'continue', 'a@acme.io'), /not waiting/);
});

test('Findings Analysis refused: the project asks with Checkmarx One\'s reason', async () => {
  const client = fakeClient({ settings: [], refuse: ['scan.config.sast.findingsAnalysis'] });
  const r = runner(client, 'settings-fa');
  await turns(r, 2);
  const p = r.job.projects[0];
  assert.equal(p.exception.code, 'copy');
  assert.match(p.exception.text, /Findings Analysis could not be turned on for Payments_FAE: .*403 Forbidden/);
  assert.throws(() => r.decide('p1', 'continue', 'a@acme.io'), /Only a project whose settings could not be copied/);
});

test('skipped projects come back: a finished run carries on for them, with a new _FAE project if it was removed', async () => {
  const client = fakeClient({ faeKeeps: 25, settings: SETTINGS, refuse: ['scan.config.sast.presetName'] });
  const r = runner(client, 'bring-back');
  assert.throws(() => r.bringBack(null, 'a@acme.io'), /Nothing skipped/);
  await turns(r, 2);
  const p = r.job.projects[0];
  r.decide('p1', 'skip', 'a@acme.io');
  await turns(r, 2);
  assert.equal(p.step, 'skipped');
  assert.equal(p.faeDeleted, true, 'its _FAE project removed (deleteFae)');
  assert.equal(r.job.state, 'done');
  client.patches.length = 0;
  // The preset is allowed now.
  const allowed = fakeClient({ faeKeeps: 25, settings: SETTINGS });
  r.clientOf = () => allowed;
  assert.equal(r.bringBack(['p1'], 'b@acme.io'), 1);
  assert.equal(p.step, 'waiting');
  assert.equal(p.note, 'Brought back by b@acme.io');
  assert.equal(r.job.state, 'running');
  assert.equal(p.faeProjectId, '');
  await turns(r, 6);
  assert.equal(p.step, 'done');
  assert.equal(p.faeProjectId, 'fae-1', 'a new _FAE project');
  assert.equal(p.counts.marked, 5);
  assert.equal(r.job.state, 'done');
});

test('its _FAE project removed in Checkmarx One: Retry makes a new one, and a finished run carries on for it', async () => {
  const gone = new Set();
  const client = fakeClient({ gone, scanStatus: 'Failed' });
  const r = runner(client, 'gone');
  await turns(r, 4);
  const p = r.job.projects[0];
  assert.equal(p.step, 'needs-ok');
  assert.equal(p.exception.code, 'scan');
  // Someone deletes Payments_FAE in Checkmarx One; the run is otherwise over.
  gone.add(p.faeProjectId);
  r.job.state = 'done';
  client.calls.length = 0;
  r.decide('p1', 'retry', 'a@acme.io');
  assert.equal(r.job.state, 'running', 'an answer puts a finished run back to work');
  await turns(r, 1);
  assert.equal(p.faeProjectId, 'fae-2', 'a new _FAE project');
  assert.ok(p.attempts.some((a) => a.what === 'project removed'));
  assert.equal(client.calls.filter((c) => c === 'POST /api/projects').length, 1);
});

test('Retry after its _FAE project was removed makes a new one', async () => {
  const client = fakeClient({ scanStatus: 'Failed' });
  const r = runner(client, 'retry-removed');
  await turns(r, 3);
  const p = r.job.projects[0];
  assert.equal(p.exception.code, 'scan');
  await r.deleteAll();
  assert.equal(p.faeDeleted, true);
  r.decide('p1', 'retry', 'a@acme.io');
  assert.equal(p.faeProjectId, '');
  assert.equal(p.faeDeleted, false);
  await turns(r, 1);
  assert.equal(p.faeProjectId, 'fae-2');
});

test('results the AI engine added are left out: the FAE scan (SAST only) cannot report them, so none is marked', async () => {
  const withAi = [...original.slice(0, 20), ...original.slice(20).map((r) => ({ ...r, queryID: 0, isAiGenerated: true }))];
  const client = fakeClient({ faeKeeps: 15, results: withAi });
  const r = runner(client, 'ai-left');
  await turns(r, 6);
  const p = r.job.projects[0];
  assert.equal(p.step, 'done');
  assert.deepEqual([p.counts.toVerify, p.counts.aiLeft, p.counts.reported, p.counts.marked], [20, 10, 15, 5]);
  assert.ok([...client.states.keys()].every((k) => Number(k.slice(1)) < 20), 'no AI-engine result marked');
  assert.match(p.attempts.find((a) => a.what === 'compared').detail, /10 found by the AI engine, left as they are/);
});

test('a result Checkmarx One will not mark does not hold back the rest; its reason is kept', async () => {
  const client = fakeClient({ faeKeeps: 25, refuseMark: ['s27'] });
  const r = runner(client, 'refused-mark');
  await turns(r, 6);
  const p = r.job.projects[0];
  assert.equal(p.step, 'done');
  assert.deepEqual([p.counts.marked, p.counts.notMarked, p.counts.revalidated], [4, 1, 4]);
  assert.equal(p.notMarked[0].similarityId, 's27');
  assert.match(p.attempts.find((a) => a.what === 'not marked').detail, /1 result\(s\) Checkmarx One would not mark: .*400 Bad Request: 400 invalid severity for this result/);
});

test('a tenant that groups by attack vector: marks and Undo go to the attack-vector endpoint, kept for the run', async () => {
  const withAv = original.map((r, i) => ({ ...r, attackVectorID: (0xabc0000000000000n + BigInt(i)).toString(16) }));
  const client = fakeClient({ faeKeeps: 25, results: withAv, avField: true });
  const r = runner(client, 'by-attack-vector');
  await turns(r, 6);
  const p = r.job.projects[0];
  assert.equal(p.step, 'done');
  assert.deepEqual([p.counts.marked, p.counts.revalidated], [5, 5]);
  assert.equal(r.job.markBy, 'attackVector');
  // By similarity id first, refused; then by attack vector, and from then on straight there.
  assert.deepEqual(client.posts, ['similarity', 'attack-vector']);
  assert.ok(p.attempts.some((a) => a.what === 'marks by attack vector'));
  const undone = await r.undo('a@acme.io');
  assert.equal(undone.restored, 5);
  assert.deepEqual(client.posts.slice(2), ['attack-vector']);
  assert.ok([...client.states.values()].every((st) => st === 'TO_VERIFY'));
});

test('a tenant that groups by attack vector, and a result without one: it is left To verify, named', async () => {
  const withAv = original.map((r, i) => (i === 27 ? r : { ...r, attackVectorID: (0xabc0000000000000n + BigInt(i)).toString(16) }));
  const client = fakeClient({ faeKeeps: 25, results: withAv, avField: true });
  const r = runner(client, 'by-attack-vector-missing');
  await turns(r, 6);
  const p = r.job.projects[0];
  assert.equal(p.step, 'done');
  assert.deepEqual([p.counts.marked, p.counts.notMarked], [4, 1]);
  assert.equal(r.job.markBy, 'attackVector');
  assert.match(p.notMarked[0].why, /no attack vector id/);
});

test('grouped by attack vector, a latest scan with none: it asks to scan again; Retry after a new scan marks', async () => {
  let scan = 'scan-1';
  const withAv = original.map((r, i) => ({ ...r, attackVectorID: (0xabc0000000000000n + BigInt(i)).toString(16) }));
  const client = fakeClient({ faeKeeps: 25, avField: true, latest: () => scan, rescanned: withAv });
  const r = runner(client, 'rescan');
  await turns(r, 5);
  const p = r.job.projects[0];
  assert.equal(p.step, 'needs-ok');
  assert.equal(p.exception.code, 'rescan');
  assert.match(p.exception.text, /groups similar results by Attack Vector ID .* gives no attack vector id with Payments's results: it takes no mark FAE Flush can send\. Nothing was marked\./);
  assert.throws(() => r.decide('p1', 'mark', 'a@acme.io'), /Nothing to mark/);
  scan = 'scan-2';
  r.decide('p1', 'retry', 'a@acme.io');
  await turns(r, 7);
  assert.equal(p.sourceScanId, 'scan-2');
  assert.equal(p.step, 'done');
  assert.deepEqual([p.counts.marked, p.counts.revalidated], [5, 5]);
});

test('code waiting between download and upload sits in a private folder with an unguessable name, never loose in the temp folder', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fae-tmp-'));
  const a = new FaeFlushRunner({ store: new FaeFlushStore({ file: path.join(root, 'a.json') }), clientOf: () => null, tmpDir: root });
  const b = new FaeFlushRunner({ store: new FaeFlushStore({ file: path.join(root, 'b.json') }), clientOf: () => null, tmpDir: root });
  const own = a.tmpDir;
  assert.equal(path.dirname(own), root);
  assert.match(path.basename(own), /^mz-fae-[A-Za-z0-9]{6}$/);
  assert.notEqual(own, b.tmpDir, 'each runner its own');
  assert.equal(fs.statSync(own).mode & 0o777, 0o700);
  assert.equal(a.tmpDir, own, 'the same folder while it is there');
  fs.rmSync(own, { recursive: true });
  const again = a.tmpDir;
  assert.notEqual(again, own, 'cleared away: made again, under a new name');
  assert.equal(fs.statSync(again).mode & 0o777, 0o700);
});

test('the private code folder goes away with the process that made it', { skip: process.platform === 'win32' }, async () => {
  const { execFileSync } = await import('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fae-exit-'));
  const script = `
    import { FaeFlushRunner, FaeFlushStore } from ${JSON.stringify(new URL('../src/fae-flush.js', import.meta.url).href)};
    import fs from 'node:fs';
    import path from 'node:path';
    const r = new FaeFlushRunner({ store: new FaeFlushStore({ file: ${JSON.stringify(path.join(root, 's.json'))} }), clientOf: () => null, tmpDir: ${JSON.stringify(root)} });
    fs.writeFileSync(path.join(r.tmpDir, 'left-behind.zip'), 'PK');
    console.log(r.tmpDir);
  `;
  const made = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).trim();
  assert.match(path.basename(made), /^mz-fae-/);
  assert.equal(fs.existsSync(made), false, 'removed, with what was left in it');
  assert.deepEqual(fs.readdirSync(root).filter((f) => f.startsWith('mz-fae-')), []);
});
