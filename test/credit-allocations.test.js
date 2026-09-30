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

test('by default credits cover the critical and high findings: to verify for triage, confirmed for remediation', () => {
  const { allocations } = setup();
  const found = risks({ CRITICAL: 3, HIGH: 5, 'HIGH:CONFIRMED': 2, MEDIUM: 9, 'MEDIUM:CONFIRMED': 4 });
  assert.equal(toTriageCount(found, ['CRITICAL', 'HIGH']), 8);
  allocations.applyRule('p1', 'Payments', found);
  const b = allocations.balance('p1');
  assert.deepEqual([b.triage.allocated, b.triage.remaining, b.remediation.allocated], [8, 8, 6], '2 confirmed highs × 3');
  assert.deepEqual(b.severities, ['CRITICAL', 'HIGH']);
});

test('unticking a severity lowers the allocation at once, and later fetches keep the new rule', () => {
  const { allocations } = setup();
  const found = risks({ CRITICAL: 3, HIGH: 5 });
  allocations.applyRule('p1', 'Payments', found);
  allocations.applyRule('p1', 'Payments', found, ['CRITICAL']);
  assert.deepEqual(allocations.balance('p1').triage, { allocated: 3, used: 0, remaining: 3 });
  // Next fetch, no rule passed: still critical only, not back to critical + high.
  allocations.applyRule('p1', 'Payments', risks({ CRITICAL: 4, HIGH: 5 }));
  assert.equal(allocations.balance('p1').triage.allocated, 4);
  assert.deepEqual(allocations.balance('p1').severities, ['CRITICAL']);
  allocations.applyRule('p1', 'Payments', found, []);
  assert.equal(allocations.balance('p1').triage.allocated, 0, 'no severities: nothing but extras');
});

test('the rule follows usage: triaged findings move from to-verify into used', () => {
  const { ledger, allocations } = setup();
  allocations.applyRule('p1', 'Payments', risks({ CRITICAL: 4 }));
  ledger.record({ projectId: 'p1', credits: 4, kind: 'triage' });
  allocations.applyRule('p1', 'Payments', risks({ 'CRITICAL:CONFIRMED': 4, CRITICAL: 2 }));
  assert.deepEqual(allocations.balance('p1').triage, { allocated: 6, used: 4, remaining: 2 });
});

test('extra credits survive rule changes and recalculation; remediation is granted separately', () => {
  const { allocations, ledger, d } = setup();
  const found = risks({ CRITICAL: 2, HIGH: 1, MEDIUM: 4, LOW: 7 });
  allocations.applyRule('p1', 'Payments', found);
  allocations.add('p1', 'Payments', 'triage', 10);
  allocations.applyRule('p1', 'Payments', found, ['CRITICAL', 'MEDIUM']);
  assert.equal(allocations.balance('p1').triage.allocated, 16, '6 to triage + 10 extra');
  allocations.add('p1', 'Payments', 'remediation', 5);
  allocations.add('p1', 'Payments', 'remediation', 2);
  allocations.save();
  const reloaded = new CreditAllocations({ file: path.join(d, 'alloc.json'), ledger });
  reloaded.applyRule('p1', 'Payments', found);
  assert.equal(reloaded.balance('p1').triage.allocated, 16);
  assert.deepEqual(reloaded.balance('p1').remediation, { allocated: 7, used: 0, remaining: 7 });
});

test('allocations saved before the current rule drop standing grants and follow the rule', () => {
  const d = dir();
  const ledger = new CreditLedger({ file: path.join(d, 'ledger.json') });
  ledger.record({ projectId: 'p1', credits: 1, kind: 'triage' });
  // e.g. "give each project 10" from an earlier release.
  fs.writeFileSync(path.join(d, 'alloc.json'), JSON.stringify({ projects: { p1: { triage: 12, remediation: 10, extraTriage: 10, severities: ['CRITICAL'] } } }));
  const allocations = new CreditAllocations({ file: path.join(d, 'alloc.json'), ledger });
  assert.deepEqual([allocations.balance('p1').triage.allocated, allocations.balance('p1').remediation.allocated], [2, 0], 'at once, before any fetch');
  allocations.applyRule('p1', 'Payments', risks({ HIGH: 3 }));
  const b = allocations.balance('p1');
  assert.deepEqual([b.triage.allocated, b.triage.remaining, b.extraTriage, b.remediation.allocated], [1, 0, 0, 0], 'only critical ticked and none left');
});

test('remediation credits follow confirmed findings, and drop once a finding is remediated', () => {
  const { ledger, allocations } = setup();
  const found = [
    { riskId: 'a', severity: 'CRITICAL', state: 'CONFIRMED', scanner: 'SAST' },
    { riskId: 'b', severity: 'HIGH', state: 'URGENT', scanner: 'SCA' },
    { riskId: 'c', severity: 'HIGH', state: 'TO_VERIFY', scanner: 'SAST' },
    { riskId: 'd', severity: 'CRITICAL', state: 'CONFIRMED', scanner: 'KICS' },
  ];
  assert.equal(toRemediateCount(found, ['CRITICAL', 'HIGH']), 2);
  allocations.applyRule('p1', 'Payments', found);
  assert.deepEqual(allocations.balance('p1').remediation, { allocated: 6, used: 0, remaining: 6 });
  // c is triaged and confirmed: one more remediation needed.
  found[2].state = 'CONFIRMED';
  allocations.applyRule('p1', 'Payments', found);
  assert.equal(allocations.balance('p1').remediation.remaining, 9);
  // a is remediated through the utility.
  ledger.record({ projectId: 'p1', credits: 3, kind: 'remediation', riskIds: ['a'], covered: 3 });
  allocations.applyRule('p1', 'Payments', found);
  assert.deepEqual(allocations.balance('p1').remediation, { allocated: 9, used: 3, remaining: 6 });
});

test('extra credits are used up by actions outside the rule, not by covered ones', () => {
  const { ledger, allocations } = setup();
  const found = risks({ CRITICAL: 2, MEDIUM: 5 });
  allocations.applyRule('p1', 'Payments', found, ['CRITICAL']);
  allocations.add('p1', 'Payments', 'triage', 3);
  allocations.applyRule('p1', 'Payments', found);
  assert.equal(allocations.balance('p1').triage.remaining, 5, '2 critical + 3 extra');
  // Two mediums triaged from a report: out of the extras.
  ledger.record({ projectId: 'p1', credits: 2, kind: 'triage', covered: 0 });
  allocations.applyRule('p1', 'Payments', risks({ CRITICAL: 2, MEDIUM: 3, 'MEDIUM:CONFIRMED': 2 }));
  assert.equal(allocations.balance('p1').triage.remaining, 3);
  // The two criticals: covered by the rule.
  ledger.record({ projectId: 'p1', credits: 2, kind: 'triage', covered: 2 });
  allocations.applyRule('p1', 'Payments', risks({ 'CRITICAL:CONFIRMED': 2, MEDIUM: 3, 'MEDIUM:CONFIRMED': 2 }));
  assert.deepEqual(allocations.balance('p1').triage, { allocated: 5, used: 4, remaining: 1 });
});

test('clearing extras leaves only what the rule needs', () => {
  const { allocations } = setup();
  allocations.applyRule('p1', 'Payments', risks({ CRITICAL: 2 }));
  allocations.add('p1', 'Payments', 'triage', 10);
  allocations.add('p1', 'Payments', 'remediation', 10);
  allocations.clearExtras('p1');
  allocations.applyRule('p1', 'Payments', risks({ CRITICAL: 2 }));
  const b = allocations.balance('p1');
  assert.deepEqual([b.triage.allocated, b.remediation.allocated, b.extraTriage, b.extraRemediation], [2, 0, 0, 0]);
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
  allocations.applyRule('p1', 'Payments', risks({ CRITICAL: 3, HIGH: 2 }));
  ledger.record({ projectId: 'p1', projectName: 'Payments', credits: 2, kind: 'triage' });
  allocations.add('p1', 'Payments', 'remediation', 6);
  allocations.add('p1', 'Payments', 'triage', 4);
  ledger.record({ projectId: 'p1', projectName: 'Payments', credits: 3, kind: 'remediation', covered: 0 });
  allocations.applyRule('p1', 'Payments', risks({ CRITICAL: 1, HIGH: 2 }));

  const [p1] = allocations.list();
  assert.equal(p1.projectName, 'Payments');
  assert.equal(p1.triage.initial, 5, 'first allocation: 3 critical + 2 high');
  assert.equal(p1.triage.used, 2);
  assert.equal(p1.triage.allocated, 2 + 3 + 4, 'used + still to verify + extra');
  assert.equal(p1.triage.remaining, 7);
  assert.deepEqual([p1.remediation.initial, p1.remediation.allocated, p1.remediation.used, p1.remediation.remaining], [0, 6, 3, 3]);
  assert.ok(p1.initialAt);
});

test('an administrator can set one project\'s extra credits exactly, up or down', () => {
  const { allocations } = setup();
  allocations.applyRule('p1', 'Payments', risks({ CRITICAL: 2 }));
  allocations.setExtra('p1', 'Payments', 'triage', 5);
  allocations.setExtra('p1', 'Payments', 'remediation', 6);
  allocations.applyRule('p1', 'Payments', risks({ CRITICAL: 2 }));
  let b = allocations.balance('p1');
  assert.deepEqual([b.triage.allocated, b.extraTriage, b.remediation.allocated, b.extraRemediation], [7, 5, 6, 6]);
  allocations.setExtra('p1', 'Payments', 'triage', 1);
  allocations.setExtra('p1', 'Payments', 'remediation', 0);
  allocations.applyRule('p1', 'Payments', risks({ CRITICAL: 2 }));
  b = allocations.balance('p1');
  assert.deepEqual([b.triage.allocated, b.extraTriage, b.remediation.allocated, b.extraRemediation], [3, 1, 0, 0]);
  assert.deepEqual(allocations.balance('p2').triage.allocated, 0, 'other projects untouched');
});
