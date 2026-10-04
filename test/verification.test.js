import test from 'node:test';
import assert from 'node:assert/strict';

import { closure, newerThan, rescanRequest, verificationResult } from '../src/verification.js';

const report = {
  projects: [{ projectId: 'p', projectName: 'P' }],
  baseline: { findings: ['a', 'b', 'c', 'd', 'e'].map((riskId) => ({ projectId: 'p', riskId, title: riskId, severity: 'HIGH' })) },
};
const now = (states) => new Map([['p', Object.entries(states).map(([riskId, state]) => ({ riskId, state }))]]);

test('a round is closed only when nothing in scope is waiting for triage or for remediation', () => {
  const sent = () => new Set(['c']);
  // a: gone, b: not exploitable, c: confirmed and remediated, d: confirmed only, e: to verify
  const open = closure(report, now({ b: 'NOT_EXPLOITABLE', c: 'CONFIRMED', d: 'CONFIRMED', e: 'TO_VERIFY' }), sent);
  assert.deepEqual({ gone: open.gone, ne: open.notExploitable, rem: open.remediated, todo: open.open, closed: open.closed }, { gone: 1, ne: 1, rem: 1, todo: 2, closed: false });
  assert.equal(closure(report, now({ b: 'PROPOSED_NOT_EXPLOITABLE', c: 'CONFIRMED' }), sent).closed, true);
  assert.equal(closure({ ...report, baseline: { findings: [] } }, new Map(), sent).closed, false, 'an empty scope is not "closed"');
});

test('the rescan proves fixes: gone is fixed, still there after remediation did not work, unchecked projects are counted', () => {
  const result = verificationResult(report, now({ b: 'NOT_EXPLOITABLE', c: 'CONFIRMED' }), { verifiedProjects: new Set(['p']), remediated: () => new Set(['c']), newInScope: 0 });
  assert.equal(result.fixed, 3);
  assert.equal(result.accepted, 1);
  assert.deepEqual(result.stillFound.map((f) => [f.riskId, f.remediated]), [['c', true]]);
  assert.equal(result.ineffective, 1);
  assert.equal(result.zero, false);
  const clean = verificationResult(report, now({ b: 'NOT_EXPLOITABLE' }), { verifiedProjects: new Set(['p']), remediated: () => new Set(), newInScope: 0 });
  assert.equal(clean.zero, true);
  assert.equal(verificationResult(report, now({}), { verifiedProjects: new Set(['p']), remediated: () => new Set(), newInScope: 2 }).zero, false, 'new findings in scope');
  assert.equal(verificationResult(report, now({}), { verifiedProjects: new Set(), remediated: () => new Set() }).notChecked, 5);
});

test('a rescan repeats the last scan (repository, branch, engines); uploaded code waits for its next scan', () => {
  const git = { engines: ['sast', 'sca', 'apisec', 'unknown'], metadata: { Handler: { GitHandler: { repo_url: 'https://github.com/acme/app', branch: 'release/2' } } } };
  const request = rescanRequest('p1', git);
  assert.deepEqual(request.body, {
    project: { id: 'p1' },
    type: 'git',
    handler: { repoUrl: 'https://github.com/acme/app', branch: 'release/2' },
    config: [{ type: 'sast', value: { incremental: 'false' } }, { type: 'sca', value: {} }, { type: 'apisec', value: {} }],
    tags: { cxmissionzero: 'verification' },
  });
  assert.equal(rescanRequest('p1', { sourceType: 'upload', engines: ['sast'] }).waiting, true);
  assert.equal(rescanRequest('p1', { metadata: { Handler: { GitHandler: { repo_url: 'git@github.com:acme/app.git', branch: 'main' } } } }).waiting, true, 'only http(s) repositories');
  assert.equal(rescanRequest('p1', {}, { repoUrl: 'https://gitlab.com/a/b', mainBranch: 'main' }).body.handler.repoUrl, 'https://gitlab.com/a/b', "the project's repository when the scan does not name one");
  assert.equal(newerThan({ updatedAt: '2026-10-04T10:00:00Z' }, '2026-10-04T09:00:00Z'), true);
  assert.equal(newerThan({ updatedAt: '2026-10-04T08:00:00Z' }, '2026-10-04T09:00:00Z'), false);
});
