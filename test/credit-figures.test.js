// The credit figures of a project, worked out in one pass, are exactly what
// the per-severity functions give (they were called a dozen times per project).
import test from 'node:test';
import assert from 'node:assert/strict';

import { creditFigures, remediationCandidates, toTriageCount, triageRows } from '../src/credit-allocations.js';

test('one pass gives the same counts as the per-severity functions, for any mix of findings', () => {
  const pick = (list, i) => list[i % list.length];
  const now = Date.now();
  const risks = Array.from({ length: 600 }, (_, i) => ({
    riskId: `r${i}`,
    severity: pick(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'], i * 7),
    scanner: pick(['SAST', 'sca', 'KICS', 'SAST'], i * 3),
    state: pick(['', 'TO_VERIFY', 'CONFIRMED', 'NOT_EXPLOITABLE', 'CONFIRMED', 'URGENT'], i * 5),
    alternateId: i % 4 === 0 ? `alt${i % 40}` : '',
    groupId: i % 3 === 0 ? `g${i % 25}` : '',
    triageRequestedAt: i % 29 === 0 ? now - 60_000 : 0,
  }));
  const triaged = new Map([['r10', 'x'], ['a:alt8', 'x'], ['g:g6', 'x']]);
  const remediated = new Set(['r2', 'r14', 'r26']);
  const figures = creditFigures(risks, { now, triaged, remediated });
  for (const severities of [['CRITICAL'], ['HIGH'], ['MEDIUM'], ['LOW'], ['CRITICAL', 'HIGH'], ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'], ['high']]) {
    assert.equal(figures.toTriage(severities), toTriageCount(risks, severities, now, triaged), `to triage ${severities}`);
    assert.deepEqual(figures.triageRows(severities), triageRows(risks, severities, now, triaged), `rows ${severities}`);
    assert.equal(figures.toRemediate(severities), remediationCandidates(risks, severities, remediated).length, `to remediate ${severities}`);
  }
});
