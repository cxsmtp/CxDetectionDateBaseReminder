import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CreditLedger } from '../src/credits.js';
import { CreditAllocations, toRemediateCount, toTriageCount } from '../src/credit-allocations.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'alloc-'));
const setup = () => {
  const d = dir();
  const ledger = new CreditLedger({ file: path.join(d, 'ledger.json') });
  return { ledger, allocations: new CreditAllocations({ file: path.join(d, 'alloc.json'), ledger }), d };
};
const risks = (spec) =>
  Object.entries(spec).flatMap(([key, n]) => {
    const [severity, state = 'TO_VERIFY'] = key.split(':');
    return Array.from({ length: n }, () => ({ severity, state, scanner: 'SAST' }));
  });

test('nothing is ever allocated on its own: a project only shows what its findings need', () => {
  const { allocations } = setup();
  const found = risks({ CRITICAL: 3, HIGH: 5, 'HIGH:CONFIRMED': 2, MEDIUM: 9, 'MEDIUM:CONFIRMED': 4 });
  assert.equal(toTriageCount(found, ['CRITICAL', 'HIGH']), 8);
  const view = allocations.need('p1', found);
  assert.deepEqual(view.need, { triage: 8, remediation: 6 }, '8 to verify; 2 confirmed highs × 3');
  assert.deepEqual(view.shortfall, { triage: 8, remediation: 6 });
  assert.deepEqual(allocations.balance('p1').triage, { allocated: 0, used: 0, remaining: 0 });
  assert.deepEqual(allocations.list(), [], 'working out the need allocated nothing');
});

test('allocating what is needed gives the shortfall once; asking again gives nothing more', () => {
  const { ledger, allocations } = setup();
  const found = risks({ CRITICAL: 4 });
  assert.equal(allocations.allocateNeeded('p1', 'Payments', 'triage', found), 4);
  assert.equal(allocations.allocateNeeded('p1', 'Payments', 'triage', found), 0);
  ledger.record({ projectId: 'p1', credits: 4, kind: 'triage' });
  // Two new findings arrive: only they are short.
  assert.deepEqual(allocations.need('p1', risks({ 'CRITICAL:CONFIRMED': 4, CRITICAL: 2 })).shortfall.triage, 2);
  assert.deepEqual(allocations.balance('p1').triage, { allocated: 4, used: 4, remaining: 0 }, 'still nothing until someone allocates');
});

test('a project that used more than it was allocated (older data) still ends up with what it needs', () => {
  const { ledger, allocations } = setup();
  ledger.record({ projectId: 'p1', credits: 10, kind: 'triage' });
  assert.equal(allocations.allocateNeeded('p1', 'Payments', 'triage', risks({ CRITICAL: 4 })), 14);
  assert.equal(allocations.balance('p1').triage.remaining, 4);
});

test('changing the severities changes what is needed, never what is allocated', () => {
  const { allocations } = setup();
  const found = risks({ CRITICAL: 3, HIGH: 5, MEDIUM: 4 });
  allocations.allocateNeeded('p1', 'Payments', 'triage', found);
  allocations.setSeverities('p1', 'Payments', ['CRITICAL']);
  assert.equal(allocations.balance('p1').triage.allocated, 8, 'allocations stay as given');
  assert.deepEqual(allocations.need('p1', found).need.triage, 3);
  allocations.setSeverities('p1', 'Payments', ['CRITICAL', 'HIGH', 'MEDIUM']);
  assert.deepEqual(allocations.need('p1', found).shortfall.triage, 4, 'the mediums are short');
  assert.deepEqual(allocations.balance('p1').severities, ['CRITICAL', 'HIGH', 'MEDIUM']);
});

test('remediation is needed only for confirmed findings — never proposed not exploitable — 3 credits each, until remediated', () => {
  const { ledger, allocations } = setup();
  const found = [
    { riskId: 'a', severity: 'CRITICAL', state: 'CONFIRMED', scanner: 'SAST' },
    { riskId: 'b', severity: 'HIGH', state: 'URGENT', scanner: 'SCA' },
    { riskId: 'c', severity: 'HIGH', state: 'TO_VERIFY', scanner: 'SAST' },
    { riskId: 'd', severity: 'CRITICAL', state: 'CONFIRMED', scanner: 'KICS' },
    { riskId: 'e', severity: 'HIGH', state: 'PROPOSED_NOT_EXPLOITABLE', scanner: 'SAST' },
    { riskId: 'f', severity: 'HIGH', state: 'NOT_EXPLOITABLE', scanner: 'SAST' },
  ];
  assert.equal(toRemediateCount(found, ['CRITICAL', 'HIGH']), 1, 'only a: confirmed, and an engine AI Remediation supports');
  assert.equal(allocations.allocateNeeded('p1', 'Payments', 'remediation', found), 3);
  // Triage confirms c: 3 more needed, given only when asked.
  found[2].state = 'CONFIRMED';
  assert.equal(allocations.need('p1', found).shortfall.remediation, 3);
  assert.equal(allocations.balance('p1').remediation.allocated, 3);
  assert.equal(allocations.allocateNeeded('p1', 'Payments', 'remediation', found), 3);
  // a is remediated through the utility: no longer needed.
  ledger.record({ projectId: 'p1', credits: 3, kind: 'remediation', riskIds: ['a'], covered: 3 });
  assert.deepEqual(allocations.need('p1', found).need.remediation, 3);
  assert.deepEqual(allocations.balance('p1').remediation, { allocated: 6, used: 3, remaining: 3 });
});

test('extra credits come on top and can be taken back, never below what was used', () => {
  const { ledger, allocations } = setup();
  allocations.allocateNeeded('p1', 'Payments', 'triage', risks({ CRITICAL: 2 }));
  allocations.add('p1', 'Payments', 'triage', 10);
  allocations.add('p1', 'Payments', 'remediation', 6);
  assert.deepEqual([allocations.balance('p1').triage.allocated, allocations.balance('p1').extraTriage], [12, 10]);
  ledger.record({ projectId: 'p1', credits: 3, kind: 'remediation', covered: 0 });
  allocations.clearExtras('p1');
  const b = allocations.balance('p1');
  assert.deepEqual([b.triage.allocated, b.remediation.allocated, b.extraTriage, b.extraRemediation], [2, 3, 0, 0]);
});

test('upgrading: allocations an earlier release made on its own are removed; used credits and unused extras stay', () => {
  const d = dir();
  const ledger = new CreditLedger({ file: path.join(d, 'ledger.json') });
  ledger.record({ projectId: 'p1', credits: 4, kind: 'triage', covered: 3 });
  // Version 2 allocated 20 triage (incl. 5 extra, 1 of them used) and 3 remediation on its own.
  fs.writeFileSync(path.join(d, 'alloc.json'), JSON.stringify({ projects: {
    p1: { projectName: 'Payments', triage: 20, remediation: 3, extraTriage: 5, extraRemediation: 0, severities: ['CRITICAL'], version: 2 },
    p2: { projectName: 'Web', triage: 0, remediation: 3, version: 2 },
  } }));
  const allocations = new CreditAllocations({ file: path.join(d, 'alloc.json'), ledger });
  const b = allocations.balance('p1');
  assert.deepEqual([b.triage.allocated, b.triage.remaining, b.extraTriage, b.remediation.allocated], [8, 4, 4, 0]);
  assert.deepEqual(b.severities, ['CRITICAL'], 'the chosen severities stay');
  assert.equal(allocations.balance('p2').remediation.allocated, 0, 'the 3 remediation credits nobody gave are gone');
  assert.deepEqual(allocations.migrated.map((m) => m.projectId).sort(), ['p1', 'p2']);
  const again = new CreditAllocations({ file: path.join(d, 'alloc.json'), ledger });
  assert.deepEqual(again.migrated, [], 'once');
});

test('coverage: triage covers the rule severities, remediation only confirmed findings of them', () => {
  const { allocations } = setup();
  const info = new Map([
    ['a', { severity: 'CRITICAL', state: 'TO_VERIFY' }],
    ['b', { severity: 'MEDIUM', state: 'CONFIRMED' }],
    ['c', { severity: 'HIGH', state: 'CONFIRMED' }],
  ]);
  assert.equal(allocations.covered('p1', 'triage', ['a', 'b', 'c'], info), 2);
  assert.equal(allocations.covered('p1', 'remediation', ['a', 'b', 'c'], info), 1);
  assert.equal(allocations.covered('p1', 'triage', ['unknown'], info), 1, 'unknown findings never charge the extras');
});

test('a project cannot spend beyond its allocation, including requests still in flight', () => {
  const { ledger, allocations } = setup();
  allocations.add('p1', 'Payments', 'triage', 5);
  const allowance = allocations.balance('p1').triage.allocated;
  const first = ledger.reserve(3, 0, new Date(), { projectId: 'p1', kind: 'triage', allowance });
  assert.ok(first);
  assert.equal(ledger.reserve(3, 0, new Date(), { projectId: 'p1', kind: 'triage', allowance }), null);
  assert.equal(allocations.balance('p1').triage.remaining, 2);
  assert.ok(ledger.reserve(3, 0, new Date(), { projectId: 'p2', kind: 'triage', allowance: 3 }), 'other projects are unaffected');
  assert.equal(ledger.reserve(1, 0, new Date(), { projectId: 'p1', kind: 'remediation', allowance: 0 }), null, 'no remediation credits');
  first.release();
  assert.equal(allocations.balance('p1').triage.remaining, 5);
});

test('only findings AI Triage can act on count: SAST/SCA, to verify, not just sent', () => {
  const now = Date.now();
  const found = [
    { severity: 'HIGH', scanner: 'SAST', state: 'TO_VERIFY' },
    { severity: 'HIGH', scanner: 'SCA', state: '' },
    { severity: 'HIGH', scanner: 'KICS', state: 'TO_VERIFY' },
    { severity: 'HIGH', scanner: 'SAST', state: 'TO_VERIFY', triageRequestedAt: now - 60_000 },
    { severity: 'HIGH', scanner: 'SAST', state: 'TO_VERIFY', triageRequestedAt: now - 3_600_000 },
  ];
  assert.equal(toTriageCount(found, ['HIGH'], now), 3);
});

test('the allocation list shows what was first allocated, what is allocated now and what was used', () => {
  const { ledger, allocations } = setup();
  assert.equal(allocations.allocateNeeded('p1', 'Payments', 'triage', risks({ CRITICAL: 3, HIGH: 2 })), 5);
  ledger.record({ projectId: 'p1', projectName: 'Payments', credits: 2, kind: 'triage' });
  allocations.add('p1', 'Payments', 'remediation', 6);
  allocations.add('p1', 'Payments', 'triage', 4);
  ledger.record({ projectId: 'p1', projectName: 'Payments', credits: 3, kind: 'remediation', covered: 0 });

  const [p1] = allocations.list();
  assert.equal(p1.projectName, 'Payments');
  assert.equal(p1.triage.initial, 5, 'first allocation: 3 critical + 2 high');
  assert.equal(p1.triage.used, 2);
  assert.equal(p1.triage.allocated, 5 + 4, 'what was allocated + extra');
  assert.equal(p1.triage.remaining, 7);
  assert.deepEqual([p1.remediation.allocated, p1.remediation.used, p1.remediation.remaining], [6, 3, 3]);
  assert.ok(p1.initialAt);
});

test('an administrator can set one project\'s extra credits exactly, up or down', () => {
  const { allocations } = setup();
  allocations.allocateNeeded('p1', 'Payments', 'triage', risks({ CRITICAL: 2 }));
  allocations.setExtra('p1', 'Payments', 'triage', 5);
  allocations.setExtra('p1', 'Payments', 'remediation', 6);
  let b = allocations.balance('p1');
  assert.deepEqual([b.triage.allocated, b.extraTriage, b.remediation.allocated, b.extraRemediation], [7, 5, 6, 6]);
  allocations.setExtra('p1', 'Payments', 'triage', 1);
  allocations.setExtra('p1', 'Payments', 'remediation', 0);
  b = allocations.balance('p1');
  assert.deepEqual([b.triage.allocated, b.extraTriage, b.remediation.allocated, b.extraRemediation], [3, 1, 0, 0]);
  assert.deepEqual(allocations.balance('p2').triage.allocated, 0, 'other projects untouched');
});

test('findings already triaged through the utility stay counted as done, even while Checkmarx One keeps them "To verify"', () => {
  const { ledger, allocations, d } = setup();
  // 6 critical findings, all To verify; 4 of them were sent for AI Triage (judged vulnerable, so still To verify).
  const found = Array.from({ length: 6 }, (_, i) => ({ riskId: `r${i}`, severity: 'CRITICAL', state: 'TO_VERIFY', scanner: 'SAST' }));
  allocations.allocateNeeded('p1', 'Payments', 'triage', found);
  assert.equal(allocations.balance('p1').triage.allocated, 6);
  ledger.record({ projectId: 'p1', projectName: 'Payments', credits: 4, kind: 'triage', riskIds: ['r0', 'r1', 'r2', 'r3'], covered: 4 });

  // Later (the "recently requested" window long gone) they are not needed again, and allocating again gives nothing.
  assert.equal(allocations.allocateNeeded('p1', 'Payments', 'triage', found), 0);
  const b = allocations.balance('p1');
  assert.deepEqual([b.triage.allocated, b.triage.used, b.triage.remaining], [6, 4, 2], 'was 10 allocated / 6 left before the fix');
  assert.equal(toTriageCount(found, ['CRITICAL'], Date.now(), ledger.triagedAt('p1')), 2);

  // And the ledger remembers it across restarts.
  ledger.flush();
  const reopened = new CreditLedger({ file: path.join(d, 'ledger.json') });
  assert.deepEqual([...reopened.triagedAt('p1').keys()].sort(), ['r0', 'r1', 'r2', 'r3']);
});
