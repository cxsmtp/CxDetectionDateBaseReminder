import test from 'node:test';
import assert from 'node:assert/strict';
import { SendGuard } from '../src/send-guard.js';

const f = (riskId, extra = {}) => ({ projectId: 'p1', riskId, ...extra });

test('a finding claimed by one request is busy for every other until released', () => {
  const guard = new SendGuard();
  const a = guard.claim('triage', [f('r1', { alternateId: 'A1' }), f('r2')]);
  assert.equal(a.claimed.length, 2);

  // Same vulnerability under another identity: same result id, or same group.
  const b = guard.claim('triage', [f('r9', { alternateId: 'A1' }), f('r2'), f('r3')]);
  assert.deepEqual(b.busy.map((x) => x.riskId), ['r9', 'r2']);
  assert.deepEqual(b.claimed.map((x) => x.riskId), ['r3']);

  // Triage and remediation are separate actions on the same finding.
  assert.equal(guard.claim('remediation', [f('r1')]).claimed.length, 1);

  a.release();
  a.release(); // safe twice
  const c = guard.claim('triage', [f('r1', { alternateId: 'A1' })]);
  assert.equal(c.claimed.length, 1, 'free again once the first request is done');
  b.release();
  c.release();
});

test('the same group in another project is a different vulnerability', () => {
  const guard = new SendGuard();
  guard.claim('triage', [{ projectId: 'p1', riskId: 'x', groupId: 'G' }]);
  assert.equal(guard.claim('triage', [{ projectId: 'p2', riskId: 'y', groupId: 'G' }]).claimed.length, 1);
});
