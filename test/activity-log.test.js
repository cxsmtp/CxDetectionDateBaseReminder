// The user activity log: what is kept (and what never is), filters, paging, the CSV, and the words
// each request is described with.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActivityLog, describe, fieldNames, recordsGet, targetOf } from '../src/activity-log.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'activity-')), 'activity.jsonl');

test('an entry keeps only its own fields, cut to size and without control characters', () => {
  const log = new ActivityLog({ file: tmpFile() });
  const row = log.record({ user: 'dev@acme.io', name: 'Dev\n<b>', kind: 'nonsense', action: 'x'.repeat(500), fields: ['a', 'b'], status: 200, ms: 12.6, password: 'secret' });
  assert.equal(row.kind, 'action', 'an unknown kind is an action');
  assert.equal(row.name, 'Dev <b>');
  assert.equal(row.action.length, 200);
  assert.equal(row.ms, 13);
  assert.equal('password' in row, false, 'nothing but the known fields is kept');
  log.flush();
});

test('entries are written to the file and read back by a new log', () => {
  const file = tmpFile();
  const log = new ActivityLog({ file });
  log.record({ user: 'a@acme.io', action: 'Changed settings' });
  log.record({ user: 'b@acme.io', action: 'Signed out' });
  log.flush();
  const again = new ActivityLog({ file });
  assert.deepEqual(again.list().entries.map((e) => e.user), ['b@acme.io', 'a@acme.io'], 'newest first');
});

test('filters: person, kind, text, time window; paging; everyone seen', () => {
  const log = new ActivityLog({ file: tmpFile() });
  const now = Date.now();
  const at = (minutes) => new Date(now - minutes * 60_000).toISOString();
  log.record({ at: at(30), user: 'a@acme.io', name: 'Ann', kind: 'sign-in', action: 'Signed in with a password', ip: '10.0.0.1' });
  log.record({ at: at(20), user: 'a@acme.io', name: 'Ann', kind: 'page', action: 'Opened Credit Control' });
  log.record({ at: at(10), user: 'b@acme.io', name: 'Bo', kind: 'action', action: 'Changed settings', fields: ['smtp.host'] });
  log.record({ at: at(400 * 24 * 60), user: 'old@acme.io', action: 'Too old' });
  assert.equal(log.list().total, 3, 'entries older than a year are not shown');
  assert.equal(log.list({ user: 'a@acme.io' }).total, 2);
  assert.equal(log.list({ kind: 'sign-in' }).entries[0].ip, '10.0.0.1');
  assert.equal(log.list({ q: 'SMTP.HOST' }).entries[0].user, 'b@acme.io', 'search covers field names, any case');
  assert.equal(log.list({ from: at(25), to: at(15) }).entries[0].action, 'Opened Credit Control');
  const page = log.list({ limit: 1, offset: 1 });
  assert.equal(page.total, 3);
  assert.deepEqual(page.entries.map((e) => e.action), ['Opened Credit Control']);
  assert.deepEqual(log.list().people, [{ email: 'a@acme.io', name: 'Ann' }, { email: 'b@acme.io', name: 'Bo' }]);
});

test('the file moves aside when it grows too large; both are exported', () => {
  const file = tmpFile();
  const log = new ActivityLog({ file, maxBytes: 300 });
  for (let i = 0; i < 3; i++) {
    log.record({ user: `p${i}@acme.io`, action: `Action ${i}` });
    log.flush();
  }
  assert.ok(fs.existsSync(file.replace(/\.jsonl$/, '.1.jsonl')));
  const csv = log.csv();
  assert.match(csv, /^at,user,name,role,ip,kind,action,target,fields,status,ms\n/);
  assert.match(csv, /p1@acme\.io/);
  assert.match(csv, /p2@acme\.io/);
});

test('CSV cells never become formulas and quote commas', () => {
  const log = new ActivityLog({ file: tmpFile() });
  log.record({ user: 'x@acme.io', name: '=HYPERLINK("bad")', action: 'Changed a, b' });
  const csv = log.csv();
  assert.match(csv, /"'=HYPERLINK\(""bad""\)"/);
  assert.match(csv, /"Changed a, b"/);
});

test('requests are described in words', () => {
  assert.equal(describe('PUT', '/api/settings'), 'Changed settings');
  assert.equal(describe('DELETE', '/api/projections/:id'), 'Deleted a calculator customer');
  assert.equal(describe('PUT', '/api/iam/users/:id/role'), 'Changed iam › users › role');
  assert.equal(describe('POST', '/api/some-thing'), 'Did some thing');
});

test('field names (two levels), never values; the item; which reads are recorded', () => {
  assert.deepEqual(fieldNames({ password: 'secret', smtp: { host: 'h', pass: 'p' }, list: [1, 2] }), ['password', 'smtp.host', 'smtp.pass', 'list']);
  assert.deepEqual(fieldNames(null), []);
  assert.deepEqual(fieldNames(['a']), []);
  assert.equal(targetOf({ id: 'abc' }), 'id abc');
  assert.equal(recordsGet('/api/backup/download'), true);
  assert.equal(recordsGet('/api/audit/export'), true);
  assert.equal(recordsGet('/api/me'), false);
});
