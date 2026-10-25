// Govern (beta): credit requests — ask, approve (at most what was asked, for a while or for good), deny, ask back, expire.
import test from 'node:test';
import assert from 'node:assert/strict';

import { approveRequest, cancelRequest, commentRequest, createRequest, denyRequest, expireRequests, waitingMinutes } from '../src/govern/requests.js';
import { cleanBudget } from '../src/govern/store.js';
import { effectiveAmount } from '../src/govern/evaluate.js';

const NOW = new Date('2026-10-24T12:00:00Z');
const by = { email: 'Uma@acme.io', name: 'Uma' };

test('a request is for oneself, or for a project, group or application, with an amount and a reason', () => {
  const r = createRequest({ amount: 20, reason: 'release' }, { by, self: 'u-uma', now: NOW });
  assert.deepEqual([r.entityType, r.entityId, r.by, r.status, r.until], ['user', 'u-uma', 'uma@acme.io', 'open', 'period']);
  assert.throws(() => createRequest({ amount: 20, reason: 'x' }, { by, self: null }), /not a Checkmarx One user/);
  assert.throws(() => createRequest({ entityId: 'u-other', amount: 20, reason: 'x' }, { by, self: 'u-uma' }), { status: 403 });
  assert.throws(() => createRequest({ entityType: 'project', entityId: 'p1', amount: 0, reason: 'x' }, { by }), /at least/);
  assert.throws(() => createRequest({ entityType: 'project', entityId: 'p1', amount: 5 }, { by }), /why/);
  assert.throws(() => createRequest({ entityType: 'project', entityId: 'p1', amount: 5, reason: 'x', until: '2020-01-01' }, { by, now: NOW }), /future/);
  assert.equal(createRequest({ entityType: 'project', entityId: 'p1', amount: 5, reason: 'x', until: '2026-12-01' }, { by, now: NOW }).until, '2026-12-01T00:00:00.000Z');
});

test('approval raises the budget: a top-up until the period ends (or a date), or for good; never more than asked', () => {
  const budget = { ...cleanBudget({ entityType: 'user', entityId: 'u-uma', amount: 10 }), version: 3 };
  const r = createRequest({ amount: 20, reason: 'release' }, { by, self: 'u-uma', now: NOW });
  assert.throws(() => approveRequest(r, budget, { amount: 21, by: 'c', now: NOW }), /At most/);
  assert.throws(() => approveRequest(r, null, { by: 'c', now: NOW }), { status: 409 });
  const temp = approveRequest(r, budget, { amount: 15, periodEnd: '2026-11-01T00:00:00Z', by: 'c', note: 'ok', now: NOW });
  assert.equal(temp.request.approvedAmount, 15);
  assert.equal(temp.request.expiresAt, '2026-11-01T00:00:00.000Z');
  assert.equal(effectiveAmount(temp.budget, NOW.getTime()), 25);
  assert.equal(effectiveAmount(temp.budget, Date.parse('2026-11-02')), 10, 'the top-up ends');
  assert.equal(temp.request.thread[0].text, 'ok');
  assert.throws(() => approveRequest(temp.request, budget, { by: 'c' }), { status: 409 });
  const perm = approveRequest(r, budget, { permanent: true, by: 'c', now: NOW });
  assert.equal(perm.budget.amount, 30);
  assert.equal(perm.request.expiresAt, null);
});

test('deny with a reason, a question thread, cancel, expiry, waiting time', () => {
  const r = createRequest({ amount: 5, reason: 'x' }, { by, self: 'u-uma', now: NOW });
  assert.throws(() => denyRequest(r, { reason: '', by: 'c' }), /why/);
  assert.equal(denyRequest(r, { reason: 'no', by: 'c' }).status, 'denied');
  const asked = commentRequest(r, { text: 'Which project?', by: 'c' });
  assert.equal(asked.thread.length, 1);
  assert.equal(cancelRequest(asked, { by: 'uma@acme.io' }).status, 'cancelled');
  const old = { ...r, createdAt: '2026-09-01T00:00:00Z' };
  assert.deepEqual(expireRequests(new Map([[old.id, old]]), { days: 14, now: NOW }).map((x) => x.status), ['expired']);
  assert.equal(waitingMinutes(r, NOW.getTime() + 120 * 60_000), 120);
});
