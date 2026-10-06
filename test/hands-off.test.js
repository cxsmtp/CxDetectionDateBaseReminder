import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findReferences, peekTenant, readAction, replyReference, signAction } from '../src/action-links.js';
import { mergeHandsOff, parseCommand, statusDue, systemEmail } from '../src/hands-off.js';
import { Watchdog, rollbackTarget, shouldNotify, shouldRaiseCase } from '../src/watchdog.js';

const mac = (text) => createHmac('sha256', 'test-key').update(text).digest('base64url');

test('one-click links: signed, for one person, one action, until they expire', () => {
  const now = Date.now();
  const token = signAction(mac, { a: 'pause', e: 'Lead@Acme.io', t: 'acme-eu' }, now);
  assert.deepEqual({ ...readAction(mac, token, now), x: 0 }, { a: 'pause', e: 'lead@acme.io', t: 'acme-eu', x: 0 });
  assert.equal(peekTenant(token), 'acme-eu');
  assert.equal(readAction(mac, `${token}x`, now), null, 'a changed signature');
  const [body, sig] = token.split('.');
  const other = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), a: 'run' })).toString('base64url');
  assert.equal(readAction(mac, `${other}.${sig}`, now), null, 'a changed action');
  assert.equal(readAction((t) => createHmac('sha256', 'other').update(t).digest('base64url'), token, now), null, 'another server');
  assert.equal(readAction(mac, token, now + 31 * 86_400_000), null, 'expired');
  assert.throws(() => signAction(mac, { a: 'delete-everything', e: 'x@y.z' }));
});

test('reply references: short, tied to the address, found in a subject or a quoted reply', () => {
  const ref = replyReference(mac, 'Lead@Acme.io');
  assert.match(ref, /^MZR-[A-Za-z0-9]{12}$/);
  assert.equal(ref, replyReference(mac, 'lead@acme.io'));
  assert.notEqual(ref, replyReference(mac, 'other@acme.io'));
  assert.deepEqual(findReferences(`Re: status [${ref}]\n> ${ref}`), [ref]);
});

test('a reply says one word above the quote; anything else is ignored', () => {
  assert.deepEqual(parseCommand('PAUSE 14\n\nOn Monday someone wrote:\n> RUN'), { command: 'pause', days: 14 });
  assert.deepEqual(parseCommand('\n  pause'), { command: 'pause', days: 7 });
  assert.deepEqual(parseCommand('pause 999'), { command: 'pause', days: 90 });
  assert.deepEqual(parseCommand('Close it, thanks'), { command: 'solved' });
  assert.deepEqual(parseCommand('unsubscribe'), { command: 'stop' });
  assert.equal(parseCommand('> resume'), null, 'only the quote');
  assert.equal(parseCommand('Thanks for this!'), null);
  assert.equal(parseCommand(''), null);
});

test('hands-off settings are checked, and the weekly status is due once a week at its hour', () => {
  assert.throws(() => mergeHandsOff({}, { statusDay: 7 }), /day/);
  assert.throws(() => mergeHandsOff({}, { imapHost: 'bad host!' }), /host name/);
  const s = mergeHandsOff({}, { on: true, statusTo: 'a@acme.io, junk', statusDay: 1, statusHour: 8 });
  assert.deepEqual(s.statusTo, ['a@acme.io']);
  const monday9 = new Date(2026, 9, 5, 9, 0); // a Monday, 09:00 local
  assert.equal(statusDue(s, monday9), true);
  assert.equal(statusDue({ ...s, lastStatusAt: new Date(2026, 9, 5, 8, 1).toISOString() }, monday9), false, 'already sent this week');
  assert.equal(statusDue(s, new Date(2026, 9, 5, 7, 0)), true, 'last week\'s is still due before the hour');
  assert.equal(statusDue({ ...s, lastStatusAt: new Date(2026, 8, 28, 8, 5).toISOString() }, new Date(2026, 9, 5, 7, 0)), false);
  assert.equal(statusDue({ ...s, pausedUntil: new Date(2026, 9, 9).toISOString() }, monday9), false, 'not while paused');
  assert.equal(statusDue({ ...s, on: false }, monday9), false);
});

test('system emails: buttons, facts and the reference, the same in text and HTML', () => {
  const m = systemEmail({ subject: 'Status', lines: ['Hello <b>'], facts: [['Fixed', '3']], buttons: [{ label: 'Pause', url: 'https://mz/a/x' }], reference: 'MZR-abcdefabcdef' });
  assert.equal(m.subject, 'Status [MZR-abcdefabcdef]');
  assert.match(m.text, /Pause: https:\/\/mz\/a\/x/);
  assert.match(m.text, /reply to this email with one word: PAUSE, RESUME, RUN, STATUS, STOP\./);
  assert.match(m.html, /Hello &lt;b&gt;/);
});

test('the watchdog: tells after two checks, raises a case after three (only with auto-update and the internet), notes recovery', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wd-')), 'watchdog.json');
  const w = new Watchdog({ file });
  const smtp = { key: 'smtp:default', title: 'Email server', detail: 'refused', tenant: 'default' };
  let r = w.record([smtp], { version: '1.0.56' });
  assert.equal(r.started.length, 1);
  assert.equal(shouldNotify(w.problem('smtp:default')), false);
  w.record([smtp]);
  assert.equal(shouldNotify(w.problem('smtp:default')), true);
  w.markNotified('smtp:default');
  w.record([smtp]);
  const p = w.problem('smtp:default');
  assert.equal(shouldNotify(p), false, 'told once');
  assert.equal(shouldRaiseCase(p, { autoUpdate: true, online: true }), true);
  assert.equal(shouldRaiseCase(p, { autoUpdate: false, online: true }), false);
  assert.equal(shouldRaiseCase(p, { autoUpdate: true, online: false }), false);
  w.tried('smtp:default', 'Tried again', 'did not help');
  assert.equal(w.hasTried('smtp:default', 'Tried again'), true);
  w.markCase('smtp:default', 'SUP-0003');
  assert.equal(shouldRaiseCase(w.problem('smtp:default'), { autoUpdate: true, online: true }), false, 'one case per problem');
  r = new Watchdog({ file }).record([], { version: '1.0.56' });
  assert.equal(r.recovered[0].caseId, 'SUP-0003', 'kept across a restart');
  assert.equal(new Watchdog({ file }).wasHealthy('1.0.56'), true);
});

test('going back to the previous version: only for a day, only once, only to a version that worked', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const problem = { key: 'errors', checks: 2, since: '2026-10-06T11:00:00Z' };
  const base = { problems: [problem], running: '1.0.56', previous: '1.0.55', switchedAt: '2026-10-06T10:00:00Z', wasHealthy: (v) => v === '1.0.55', hasRolledBack: () => false, now };
  assert.equal(rollbackTarget(base), '1.0.55');
  assert.equal(rollbackTarget({ ...base, switchedAt: '2026-10-04T10:00:00Z' }), '', 'more than a day ago');
  assert.equal(rollbackTarget({ ...base, problems: [{ ...problem, since: '2026-10-06T09:00:00Z' }] }), '', 'the problem was there before');
  assert.equal(rollbackTarget({ ...base, problems: [{ ...problem, checks: 1 }] }), '', 'not yet confirmed');
  assert.equal(rollbackTarget({ ...base, wasHealthy: () => false }), '', 'the previous one never passed a check');
  assert.equal(rollbackTarget({ ...base, hasRolledBack: () => true }), '', 'once');
});
