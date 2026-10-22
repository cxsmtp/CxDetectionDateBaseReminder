// FAE Flush's runner with a stand-in Checkmarx One: a project that looks off stops and asks, and goes on as answered.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FaeFlushRunner, FaeFlushStore } from '../src/fae-flush.js';

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

test('automatic: Checkmarx One refuses its own copy in place, so the code is downloaded and uploaded instead', async () => {
  const client = fakeClient({ faeKeeps: 10 });
  const posted = [];
  client.redirectOf = async () => ({ status: 302, location: 'https://cx.example/storage/repostore.x/t/repos/r/scan-1?X-Amz-Expires=900&X-Amz-Signature=s' });
  const request = client.request;
  client.request = async (p, opts = {}) => {
    if (p === '/api/scans' && opts.method === 'POST') {
      posted.push(opts.body.handler.uploadUrl);
      if (opts.body.handler.uploadUrl.includes('/storage/')) throw Object.assign(new Error('invalid upload url'), { status: 400 });
    }
    return request(p, opts);
  };
  const r = runner(client, 'fallback');
  await turns(r, 1);
  const p = r.job.projects[0];
  assert.equal(p.step, 'scanning');
  assert.equal(p.codeSource, 'upload');
  assert.deepEqual(posted.map((u) => (u.includes('/storage/') ? 'link' : 'upload')), ['link', 'upload']);
  assert.deepEqual(p.attempts.filter((a) => a.what.startsWith('code:')).map((a) => [a.what, a.ok]), [['code: Checkmarx One’s own copy', false], ['code: download and upload', true]]);
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
