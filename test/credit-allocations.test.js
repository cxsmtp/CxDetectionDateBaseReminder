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

test('the default triage allocation covers the critical and high findings still to verify', () => {
  const { allocations } = setup();
  const found = risks({ CRITICAL: 3, HIGH: 5, 'HIGH:CONFIRMED': 2, MEDIUM: 9 });
  assert.equal(toTriageCount(found, ['CRITICAL', 'HIGH']), 8);
  allocations.applyDefault('p1', 'Payments', found);
  const b = allocations.balance('p1');
  assert.deepEqual([b.triage.allocated, b.triage.remaining, b.remediation.allocated], [8, 8, 0]);
});

test('defaults follow usage but never shrink, and never override the administrator', () => {
  const { ledger, allocations } = setup();
  allocations.applyDefault('p1', 'Payments', risks({ CRITICAL: 4 }));
  ledger.record({ projectId: 'p1', credits: 4, kind: 'triage' });
  // Next fetch: those 4 are triaged, 2 new criticals appeared.
  allocations.applyDefault('p1', 'Payments', risks({ 'CRITICAL:CONFIRMED': 4, CRITICAL: 2 }));
  assert.deepEqual(allocations.balance('p1').triage, { allocated: 6, used: 4, remaining: 2 });
  allocations.applyDefault('p1', 'Payments', []);
  assert.equal(allocations.balance('p1').triage.allocated, 6, 'a default never shrinks');

  allocations.add('p1', 'Payments', 'triage', 10);
  allocations.applyDefault('p1', 'Payments', risks({ CRITICAL: 50 }));
  assert.equal(allocations.balance('p1').triage.allocated, 16, 'an administrator allocation is left alone');
});

test('allocating by severity gives exactly enough, and credits can be added per kind', () => {
  const { ledger, allocations, d } = setup();
  ledger.record({ projectId: 'p1', credits: 3, kind: 'triage' });
  allocations.allocateTriageFor('p1', 'Payments', risks({ CRITICAL: 2, HIGH: 1, MEDIUM: 4, LOW: 7 }), ['CRITICAL', 'MEDIUM']);
  assert.deepEqual(allocations.balance('p1').triage, { allocated: 9, used: 3, remaining: 6 });
  allocations.add('p1', 'Payments', 'remediation', 5);
  allocations.add('p1', 'Payments', 'remediation', 2);
  allocations.save();
  const reloaded = new CreditAllocations({ file: path.join(d, 'alloc.json'), ledger });
  assert.deepEqual(reloaded.balance('p1').remediation, { allocated: 7, used: 0, remaining: 7 });
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
