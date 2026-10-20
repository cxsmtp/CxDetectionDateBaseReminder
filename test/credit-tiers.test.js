import test from 'node:test';
import assert from 'node:assert/strict';
import { creditTiers, tierName } from '../public/credit-tiers.js';

test('the run button takes the widest tier the credits cover, the allocate button the next', () => {
  const need = { CRITICAL: 5, HIGH: 10, MEDIUM: 20, LOW: 4 };
  const t = creditTiers(need, 16);
  assert.equal(t.total, 39);
  assert.deepEqual(t.covered.severities, ['CRITICAL', 'HIGH']);
  assert.equal(t.covered.name, 'critical & high');
  assert.equal(t.next.name, 'critical, high & medium');
  assert.equal(t.next.need, 35);
});

test('credits that cover everything make one "all" button and nothing to allocate', () => {
  const t = creditTiers({ CRITICAL: 2, HIGH: 3, MEDIUM: 0, LOW: 0 }, 9);
  assert.equal(t.covered.name, 'all');
  assert.deepEqual(t.covered.severities, ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
  assert.equal(t.next, null);
});

test('a severity with nothing to do adds no tier of its own', () => {
  // No critical findings: the first tier is critical & high.
  const t = creditTiers({ CRITICAL: 0, HIGH: 6, MEDIUM: 3, LOW: 0 }, 0);
  assert.equal(t.covered, null);
  assert.equal(t.next.name, 'critical & high');
  assert.equal(creditTiers({ CRITICAL: 0, HIGH: 6, MEDIUM: 3, LOW: 0 }, 6).next.name, 'all');
});

test('nothing needed: no button to run or allocate', () => {
  const t = creditTiers({}, 40);
  assert.equal(t.total, 0);
  assert.equal(t.covered, null);
  assert.equal(t.next, null);
});

test('ticked severities are named by their tier', () => {
  assert.equal(tierName(['HIGH', 'CRITICAL']), 'critical & high');
  assert.equal(tierName(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']), 'all');
  assert.equal(tierName(['HIGH', 'LOW']), 'ticked severities');
});
