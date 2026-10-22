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
function fakeClient({ faeKeeps = 1, scanStatus = 'Completed' } = {}) {
  const states = new Map();
  const calls = [];
  return {
    calls,
    states,
    download: async (p, file) => (fs.writeFileSync(file, 'PK'), 2),
    uploadFile: async () => 2,
    request: async (p, { method = 'GET', body, query } = {}) => {
      calls.push(`${method} ${p}`);
      if (p === '/api/projects' && method === 'POST') return { id: 'fae-1' };
      if (p === '/api/uploads') return { url: 'https://storage.example/u1' };
      if (p === '/api/scans' && method === 'POST') return { id: 'scan-fae' };
      if (p.startsWith('/api/scans/')) return { status: scanStatus, statusDetails: [{ name: 'sast', status: scanStatus, loc: 1000 }] };
      if (p === '/api/sast-results') {
        if (query.offset > 0) return { results: [] };
        if (query['scan-id'] === 'scan-fae') return { results: original.slice(0, faeKeeps) };
        return { results: original.map((r) => ({ ...r, state: states.get(r.similarityID) ?? r.state })) };
      }
      if (p === '/api/sast-results-predicates') for (const m of body) states.set(m.similarityId, m.state);
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
  assert.throws(() => r.decide('p1', 'later', 'a@acme.io'), /Mark, skip or retry/);
  r.decide('p1', 'mark', 'a@acme.io');
  await turns(r, 4);
  assert.equal(p.step, 'done');
  assert.equal(p.counts.marked, 29);
  assert.equal(p.counts.revalidated, 29);
  assert.equal(p.faeDeleted, true);
  assert.equal(r.job.state, 'done');
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
