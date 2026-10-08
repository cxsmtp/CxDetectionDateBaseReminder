// Credit projections: the Fusion arithmetic (each project rounded up to whole bundles on its own),
// the saved profiles, what is kept of what the page sends, and the calculator page it frames.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bundlesFor, fusionEstimate, fusionTerms, linesOf, wholeNumber } from '../public/projections/fusion.js';
import { MAX_PROFILE_BYTES, ProjectionStore, cleanAlaCarte, cleanFusion, readProjectLines } from '../src/projections.js';
import { securityHeaders } from '../src/security.js';

test('Fusion: 12,000 and 18,000 lines are 2 + 2 = 4 bundles, not the 3 their 30,000 lines would make', () => {
  const estimate = fusionEstimate([{ id: 'a', loc: 12000 }, { id: 'b', loc: 18000 }], { bundleLoc: 10000, creditsPerBundle: 1 });
  assert.deepEqual(estimate.rows.map((r) => r.bundles), [2, 2]);
  assert.equal(estimate.bundles, 4);
  assert.equal(estimate.pooledBundles, 3);
  assert.equal(estimate.roundingBundles, 1);
  assert.equal(estimate.loc, 30000);
  assert.equal(estimate.credits, 4);
});

test('Fusion: bundle edges, prices, typed counts, left-out and unknown projects', () => {
  assert.equal(bundlesFor(10000, 10000), 1);
  assert.equal(bundlesFor(10001, 10000), 2);
  assert.equal(bundlesFor(1, 10000), 1);
  assert.equal(bundlesFor(0, 10000), 0, 'no lines, no bundle');
  assert.equal(bundlesFor(null, 10000), 0);
  assert.equal(wholeNumber('12,345'), 12345);
  assert.equal(wholeNumber(' 1 000 '), 1000);
  assert.equal(wholeNumber('-5'), null);
  assert.equal(wholeNumber('abc'), null);
  assert.equal(linesOf({ loc: 500, locOverride: 25000 }), 25000, 'what was typed wins');
  assert.equal(linesOf({ loc: 500, locOverride: null }), 500);
  assert.deepEqual(fusionTerms({ bundleLoc: 0, creditsPerBundle: -1 }), { bundleLoc: 10000, creditsPerBundle: 1 }, 'nonsense terms fall back to the defaults');

  const estimate = fusionEstimate(
    [
      { id: 'a', loc: 25000, creditsPerBundle: 99 },
      { id: 'b', loc: 4000, locOverride: 40001 },
      { id: 'c', loc: 90000, included: false },
      { id: 'd', loc: null },
    ],
    { bundleLoc: 20000, creditsPerBundle: 2.5 },
  );
  assert.deepEqual(estimate.rows.map((r) => r.bundles), [2, 3, 0, 0]);
  assert.equal(estimate.projects, 2, 'left out and unknown projects are not counted');
  assert.equal(estimate.unknown, 1);
  assert.equal(estimate.loc, 65001);
  assert.equal(estimate.bundles, 5);
  assert.equal(estimate.pooledBundles, 4);
  assert.equal(estimate.credits, 12.5);
});

test('profiles: create, list newest first, save each part, reopen from disk, remove', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projections-'));
  const file = path.join(dir, 'projections.json');
  const store = new ProjectionStore({ file });
  const a = store.create({ name: 'Acme', by: 'sam@acme.io' });
  const b = store.create({ name: '', by: 'sam@acme.io' });
  assert.equal(b.name, 'New projection');
  assert.deepEqual(a.fusion, { bundleLoc: 10000, creditsPerBundle: 1, readAt: null, projects: [] });

  store.update(a.id, { fusion: { bundleLoc: 5000, creditsPerBundle: 2, projects: [{ id: 'p1', name: 'One', loc: 12000, source: 'sast-metadata' }] } }, 'kim@acme.io');
  const summary = store.update(a.id, { alaCarte: { customer: 'Acme Corp', totals: { weeks: ['2026-01-05'], bySeverity: { High: [3] } } } }, 'kim@acme.io');
  assert.equal(summary.customer, 'Acme Corp');
  assert.equal(summary.fusionProjects, 1);
  assert.equal(summary.hasAlaCarte, false, 'both exports are needed');
  assert.equal(store.list()[0].id, a.id, 'the one changed last comes first');

  const again = new ProjectionStore({ file });
  const reopened = again.get(a.id);
  assert.equal(reopened.updatedBy, 'kim@acme.io');
  assert.equal(reopened.fusion.bundleLoc, 5000);
  assert.equal(reopened.fusion.projects[0].loc, 12000);
  assert.deepEqual(reopened.alaCarte.totals.bySeverity.High, [3]);
  assert.deepEqual(reopened.alaCarte.totals.bySeverity.Low, [0]);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');

  again.remove(b.id);
  assert.throws(() => again.get(b.id), (e) => e.status === 404);
  assert.throws(() => again.remove(b.id), (e) => e.status === 404);
  assert.throws(() => again.update(a.id, { alaCarte: { customer: 'x', totals: { weeks: Array(2000).fill('2026-01-05'), bySeverity: { High: Array(2000).fill(1e15) } }, fixed: { weeks: Array(2000).fill('2026-01-05'), bySeverity: Object.fromEntries(['Critical', 'High', 'Medium', 'Low', 'Info'].map((s) => [s, Array(2000).fill(123456789.123)])) }, logoDataUrl: `data:image/png;base64,${'A'.repeat(MAX_PROFILE_BYTES)}` } }), (e) => e.status === 413);
});

test('what is kept of what the page sends: numbers, dates and text only, and a logo only as an image', () => {
  const kept = cleanAlaCarte({
    customer: 'Acme\u0000 Corp',
    logoDataUrl: 'data:text/html;base64,PHNjcmlwdD4=',
    totals: { weeks: ['2026-01-05', '<b>'], bySeverity: { Critical: ['7', 'x'], Bogus: [1] }, meta: { fileName: 'total.xlsx', extra: 'dropped' } },
    plan: { High: { selected: -3, fp: 250 }, Other: { selected: 1 } },
    assumptions: { triageCredits: '2', remediationCredits: -1, falsePositive: { High: 140 } },
    pace: 'fast',
    script: '<script>alert(1)</script>',
  });
  assert.equal(kept.customer, 'Acme  Corp');
  assert.equal(kept.logoDataUrl, null, 'only PNG, JPEG or SVG images');
  assert.deepEqual(kept.totals.bySeverity.Critical, [7, 0]);
  assert.equal('Bogus' in kept.totals.bySeverity, false);
  assert.deepEqual(kept.totals.meta, { fileName: 'total.xlsx', sheet: '', layout: '', exportedAt: null, filters: [] });
  assert.deepEqual(kept.plan, { High: { selected: 0, fp: 100 } });
  assert.deepEqual(kept.assumptions, { triageCredits: 2, remediationCredits: 0, falsePositive: { High: 100 } });
  assert.equal(kept.pace, null);
  assert.equal('script' in kept, false);
  assert.equal(cleanAlaCarte('nope'), null);
  assert.equal(cleanAlaCarte({ logoDataUrl: 'data:image/png;base64,iVBORw0KGgo=' }).logoDataUrl, 'data:image/png;base64,iVBORw0KGgo=');

  const fusion = cleanFusion({ bundleLoc: '0', creditsPerBundle: 'x', projects: [{ name: 'Typed', locOverride: '12,000', source: 'evil' }, { id: 'p2', loc: -4, included: false }] });
  assert.equal(fusion.bundleLoc, 10000);
  assert.equal(fusion.creditsPerBundle, 1);
  assert.match(fusion.projects[0].id, /^manual-/);
  assert.equal(fusion.projects[0].locOverride, 12000);
  assert.equal(fusion.projects[0].source, 'manual');
  assert.equal(fusion.projects[1].name, 'Unnamed project');
  assert.equal(fusion.projects[1].loc, null);
  assert.equal(fusion.projects[1].included, false);
});

test('lines of code: SAST scan metadata, else the scan’s SAST details, else none', async () => {
  const calls = [];
  const client = {
    async *paginate() {
      yield* [{ id: 'p1', name: 'Bravo' }, { id: 'p2', name: 'Alpha' }, { id: 'p3', name: 'Charlie' }, { id: 'p4', name: 'Delta' }];
    },
    async request(url) {
      calls.push(url);
      if (url === '/api/projects/last-scan') return { p1: { id: 's1', updatedAt: '2026-10-01T00:00:00Z' }, p2: { id: 's2', updatedAt: '2026-10-02T00:00:00Z' }, p3: { id: 's3', updatedAt: '2026-10-03T00:00:00Z' } };
      if (url === '/api/sast-metadata/s1') return { loc: 12000 };
      if (url === '/api/sast-metadata/s2') throw Object.assign(new Error('not found'), { status: 404 });
      if (url === '/api/scans/s2') return { statusDetails: [{ name: 'sast', loc: 18000 }] };
      if (url === '/api/sast-metadata/s3') return {};
      if (url === '/api/scans/s3') return { statusDetails: [{ name: 'sast' }] };
      throw new Error(`unexpected ${url}`);
    },
  };
  const rows = await readProjectLines(client);
  assert.deepEqual(
    rows.map((r) => [r.name, r.loc, r.source, r.scanId]),
    [
      ['Alpha', 18000, 'scan', 's2'],
      ['Bravo', 12000, 'sast-metadata', 's1'],
      ['Charlie', null, 'none', 's3'],
      ['Delta', null, 'none', ''],
    ],
  );
  assert.equal(calls.includes('/api/scans/s1'), false, 'the scan is read only when the metadata has no count');
});

test('only the calculator may be framed, and only by this server’s own pages', () => {
  const headers = (pathName, method = 'GET') => {
    const set = {};
    securityHeaders({ hsts: false, frameable: (req) => req.method === 'GET' && req.path.startsWith('/projections/calculator/') })({ path: pathName, method, secure: false }, { set: (k, v) => (set[k] = v) }, () => {});
    return set;
  };
  const calculator = headers('/projections/calculator/index.html');
  assert.equal(calculator['X-Frame-Options'], 'SAMEORIGIN');
  assert.match(calculator['Content-Security-Policy'], /frame-ancestors 'self'/);
  assert.doesNotMatch(calculator['Content-Security-Policy'], /frame-ancestors 'none'/);
  for (const other of ['/', '/index.html', '/api/projections', '/projections/fusion.js']) {
    const h = headers(other);
    assert.equal(h['X-Frame-Options'], 'DENY', other);
    assert.match(h['Content-Security-Policy'], /frame-ancestors 'none'/, other);
  }
});

test('the calculator page has every file it loads, inside what the image copies, and nothing from elsewhere', () => {
  const root = new URL('../public/projections/calculator/', import.meta.url);
  const html = fs.readFileSync(new URL('index.html', root), 'utf8');
  const refs = [...html.matchAll(/\b(?:src|href)="([^"#]+)"/g)].map((m) => m[1]).filter((ref) => !ref.startsWith('data:'));
  assert.ok(refs.length >= 8, refs.join(', '));
  for (const ref of refs) {
    assert.doesNotMatch(ref, /^(https?:)?\/\//, `${ref}: nothing is loaded from another site`);
    assert.ok(fs.existsSync(new URL(ref, root)), `${ref} is missing`);
  }
  const app = fs.readFileSync(new URL('assets/js/app.js', root), 'utf8');
  for (const [, sample] of app.matchAll(/['"](samples\/[^'"]+)['"]/g)) assert.ok(fs.existsSync(new URL(sample, root)), `${sample} is missing`);
  // Its messages go only to this server's own page, and only that page is listened to.
  assert.match(app, /e(vent)?\.origin !== location\.origin/);
  assert.doesNotMatch(app, /postMessage\([^)]*['"]\*['"]/);
  const dockerfile = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /^COPY public \.\/public$/m);
  assert.match(dockerfile, /^COPY src \.\/src$/m);
  const ignored = fs.readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const pattern of ignored) assert.ok(!/public|projections|xlsx|samples/.test(pattern), `.dockerignore leaves out ${pattern}`);
});
