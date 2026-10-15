import test from 'node:test';
import assert from 'node:assert/strict';

import { PER_ACCOUNT_GAP_MS, PER_IP_PER_WINDOW, PasswordResets, RESET_TTL_MS, TOKEN_PATTERN, maskEmail, resetAllowed } from '../src/password-reset.js';

const clock = () => {
  let now = Date.parse('2026-10-15T09:00:00Z');
  return { now: () => now, advance: (ms) => (now += ms) };
};
const people = () => {
  const users = { u1: { id: 'u1', email: 'dev@acme.io', passwordHash: 'scrypt$a' }, u2: { id: 'u2', email: 'ops@acme.io', passwordHash: 'scrypt$b' } };
  return { users, userOf: (id) => users[id] ?? null };
};

test('a link is 256 random bits, works once, and only for its own person', () => {
  const resets = new PasswordResets();
  const { users, userOf } = people();
  const { token, exp } = resets.issue(users.u1);
  assert.match(token, TOKEN_PATTERN);
  assert.ok(exp > Date.now());
  assert.equal(resets.check(token, userOf)?.id, 'u1');
  assert.equal(resets.check(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'), userOf), null, 'one character off: nothing');
  assert.equal(resets.check('', userOf), null);
  assert.equal(resets.check('../../etc/passwd', userOf), null);
  resets.consume(token);
  assert.equal(resets.check(token, userOf), null, 'used: never again');
  assert.equal(resets.size, 0);
});

test('only the latest link works, it ends after 30 minutes, and a changed password ends it', () => {
  const t = clock();
  const resets = new PasswordResets({ now: t.now });
  const { users, userOf } = people();
  const first = resets.issue(users.u1).token;
  const second = resets.issue(users.u1).token;
  assert.equal(resets.check(first, userOf), null, 'asking again replaces the earlier link');
  assert.equal(resets.check(second, userOf)?.id, 'u1');
  const other = resets.issue(users.u2).token;
  t.advance(RESET_TTL_MS - 1);
  assert.equal(resets.check(second, userOf)?.id, 'u1', 'still in time');
  t.advance(1);
  assert.equal(resets.check(second, userOf), null, 'expired');
  const third = resets.issue(users.u1).token;
  users.u1.passwordHash = 'scrypt$changed';
  assert.equal(resets.check(third, userOf), null, 'the password changed another way: the link ends');
  assert.equal(resets.check(other, userOf), null, 'the other person’s link expired with time too');
  const fourth = resets.issue(users.u1).token;
  users.u1.disabled = true;
  assert.equal(resets.check(fourth, userOf), null, 'a disabled account cannot be reset');
  users.u1.disabled = false;
  const fifth = resets.issue(users.u1).token;
  delete users.u1;
  assert.equal(resets.check(fifth, userOf), null, 'a removed account cannot be reset');
});

test('no flooding: 3 links an hour a minute apart per person, and a cap per network address', () => {
  const t = clock();
  const resets = new PasswordResets({ now: t.now });
  const { users } = people();
  assert.equal(resets.maySend('u1'), true);
  resets.issue(users.u1);
  assert.equal(resets.maySend('u1'), false, 'not twice within a minute');
  t.advance(PER_ACCOUNT_GAP_MS);
  resets.issue(users.u1);
  t.advance(PER_ACCOUNT_GAP_MS);
  resets.issue(users.u1);
  t.advance(PER_ACCOUNT_GAP_MS);
  assert.equal(resets.maySend('u1'), false, 'three in the hour');
  assert.equal(resets.maySend('u2'), true, 'others are not affected');
  t.advance(60 * 60 * 1000);
  assert.equal(resets.maySend('u1'), true, 'an hour later');

  for (let i = 0; i < PER_IP_PER_WINDOW; i++) {
    assert.equal(resets.ipBlocked('10.0.0.1'), false);
    resets.noteIp('10.0.0.1');
  }
  assert.equal(resets.ipBlocked('10.0.0.1'), true);
  assert.equal(resets.ipBlocked('10.0.0.2'), false);
  t.advance(15 * 60 * 1000);
  assert.equal(resets.ipBlocked('10.0.0.1'), false, 'a quarter of an hour later');
});

test('who may reset by email, and the address shown on the page', () => {
  assert.equal(resetAllowed('everyone', { isAdmin: true }), true);
  assert.equal(resetAllowed('not-admins', { isAdmin: true }), false);
  assert.equal(resetAllowed('not-admins', { isAdmin: false }), true);
  assert.equal(resetAllowed('off', { isAdmin: false }), false);
  assert.equal(maskEmail('dev@acme.io'), 'd••@acme.io');
  assert.equal(maskEmail('a@b.io'), 'a••@b.io');
  assert.equal(maskEmail('nobody'), '');
});
