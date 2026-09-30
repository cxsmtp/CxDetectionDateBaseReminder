import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CreditLedger } from '../src/credits.js';
import { CreditAllocations, toTriageCount } from '../src/credit-allocations.js';

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

test('by default triage credits cover the critical and high findings still to verify', () => {
  const { allocations } = setup();
  const found = risks({ CRITICAL: 3, HIGH: 5, 'HIGH:CONFIRMED': 2, MEDIUM: 9 });
  assert.equal(toTriageCount(found, ['CRITICAL', 'HIGH']), 8);
  allocations.applyRule('p1', 'Payments', found);
  const b = allocations.balance('p1');
  assert.deepEqual([b.triage.allocated, b.triage.remaining, b.remediation.allocated], [8, 8, 0]);
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

test('allocations saved before rules existed keep what was granted above the default as extra', () => {
  const d = dir();
  const ledger = new CreditLedger({ file: path.join(d, 'ledger.json') });
  fs.writeFileSync(path.join(d, 'alloc.json'), JSON.stringify({ projects: { p1: { triage: 12, remediation: 3, source: 'admin' } } }));
  const allocations = new CreditAllocations({ file: path.join(d, 'alloc.json'), ledger });
  allocations.applyRule('p1', 'Payments', risks({ CRITICAL: 2, HIGH: 3 }));
  const b = allocations.balance('p1');
  assert.deepEqual([b.triage.allocated, b.extraTriage, b.remediation.allocated], [12, 7, 3]);
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
  ledger.record({ projectId: 'p1', projectName: 'Payments', credits: 3, kind: 'remediation' });
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
