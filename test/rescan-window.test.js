// The developer's turn to rescan: when it opens, when it ends, and who may use it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { GRACE_HOURS, graceHoursOf, newWindow, rescanGrants, windowAction, windowState } from '../src/rescan-window.js';

const report = (over = {}) => ({ round: 1, verify: { auto: true, graceHours: 48 }, latest: { closure: { closed: true, open: 0 } }, ...over });

test('the window lasts 24 hours to 14 days, 48 by default', () => {
  assert.equal(graceHoursOf({}), GRACE_HOURS.default);
  assert.equal(graceHoursOf({ verify: { graceHours: 2 } }), 24);
  assert.equal(graceHoursOf({ verify: { graceHours: 72 } }), 72);
  assert.equal(graceHoursOf({ verify: { graceHours: 9999 } }), 336);
  assert.equal(graceHoursOf({ verify: { graceHours: 'soon' } }), 48);
});

test("closed → the developers' turn; ended with nobody rescanning → on their behalf; reopened → closed again", () => {
  const now = Date.parse('2026-10-04T10:00:00Z');
  const r = report();
  assert.equal(windowAction(r, now), 'open');
  r.verifyWindow = newWindow(r, [{ email: 'dev@acme.io' }], now);
  assert.equal(windowAction(r, now + 47 * 3_600_000), null, 'still their turn');
  assert.equal(windowAction(r, now + 48 * 3_600_000), 'start');
  assert.equal(windowAction({ ...r, verify: { auto: false } }, now + 99 * 3_600_000), null, 'automatic rescan off: it waits');
  assert.equal(windowAction({ ...r, latest: { closure: { closed: false } } }, now), 'cancel', 'a finding came back: nothing to prove yet');
  assert.equal(windowAction({ ...r, verifyWindow: { ...r.verifyWindow, startedAt: 'x' } }, now + 99 * 3_600_000), null, 'the developer rescanned');
  assert.equal(windowAction({ ...r, verification: { round: 1 } }, now), null, 'this round is verified');
  assert.equal(windowAction({ ...r, round: 2 }, now), 'open', 'a new round gets its own window');
  const state = windowState(r, now + 46 * 3_600_000);
  assert.equal(state.state, 'ready');
  assert.equal(state.hoursLeft, 2);
});

test('rescan grants: signed, for one report, round and person, and they expire', () => {
  const grants = rescanGrants((text) => createHmac('sha256', 'k').update(text).digest('base64url'));
  const token = grants.issue({ reportId: 'r1', round: 2, email: 'dev@acme.io', exp: Date.now() + 60_000 });
  assert.deepEqual(grants.verify(token), { reportId: 'r1', round: 2, email: 'dev@acme.io' });
  const [body, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), r: 'mallory@evil.io' })).toString('base64url');
  assert.equal(grants.verify(`${forged}.${sig}`), null);
  assert.equal(grants.verify(grants.issue({ reportId: 'r1', round: 1, email: 'a', exp: Date.now() - 1 })), null, 'expired');
  assert.equal(rescanGrants((t) => createHmac('sha256', 'other').update(t).digest('base64url')).verify(token), null, "another server's key");
  assert.equal(grants.verify('garbage'), null);
});
