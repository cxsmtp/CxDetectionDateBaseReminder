import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AuditLog } from '../src/audit-log.js';
import { ReportGrants } from '../src/report-grants.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
const open = (root) => new AuditLog({ dir: path.join(root, 'audit'), keyFile: path.join(root, 'audit.key') });
const charge = (project, charged, extra = {}) => ({
  type: 'triage',
  outcome: charged ? 'charged' : 'refused',
  actor: { kind: 'report', recipient: 'dev@acme.io', ip: '10.0.0.1' },
  project: { id: project, name: project.toUpperCase() },
  credits: { kind: 'triage', requested: 3, charged },
  ...extra,
});

test('entries are chained, numbered, written in order and survive a restart', async () => {
  const root = tmpDir();
  const log = open(root);
  log.record(charge('p1', 3), new Date('2026-08-31T23:59:00Z'));
  log.record(charge('p1', 0), new Date('2026-09-01T00:01:00Z'));
  await log.settled();
  assert.deepEqual(log.files(), ['audit-2026-08.jsonl', 'audit-2026-09.jsonl']);

  const again = open(root);
  const third = again.record(charge('p2', 1), new Date('2026-09-02T10:00:00Z'));
  await again.settled();
  assert.equal(third.seq, 3);
  const result = again.verify();
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.entries, 3);
});

test('editing, deleting or reordering an entry is detected', async () => {
  for (const tamper of ['edit', 'delete', 'swap']) {
    const root = tmpDir();
    const log = open(root);
    for (let i = 0; i < 4; i += 1) log.record(charge('p1', 1), new Date(`2026-09-0${i + 1}T10:00:00Z`));
    await log.settled();
    const file = path.join(root, 'audit', 'audit-2026-09.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    if (tamper === 'edit') lines[1] = lines[1].replace('"charged":1', '"charged":0');
    if (tamper === 'delete') lines.splice(1, 1);
    if (tamper === 'swap') [lines[1], lines[2]] = [lines[2], lines[1]];
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const result = open(root).verify();
    assert.equal(result.ok, false, tamper);
    assert.ok(result.problems.some((p) => p.seq === 2 || p.seq === 3), `${tamper}: ${JSON.stringify(result.problems)}`);
  }
});

test('a different key cannot forge a valid chain', async () => {
  const root = tmpDir();
  const log = open(root);
  log.record(charge('p1', 2));
  await log.settled();
  fs.writeFileSync(path.join(root, 'audit.key'), Buffer.alloc(32, 7));
  assert.equal(open(root).verify().ok, false);
});

test('a torn last line (crash mid-write) is reported, and the log carries on from the entry before', async () => {
  const root = tmpDir();
  const log = open(root);
  log.record(charge('p1', 1), new Date('2026-09-01T10:00:00Z'));
  log.record(charge('p1', 1), new Date('2026-09-01T11:00:00Z'));
  await log.settled();
  fs.appendFileSync(path.join(root, 'audit', 'audit-2026-09.jsonl'), '{"seq":3,"id":"x","at":"2026-09');
  const reopened = open(root);
  assert.equal(reopened.record(charge('p1', 1), new Date('2026-09-01T12:00:00Z')).seq, 3);
  await reopened.settled();
  const result = reopened.verify();
  assert.equal(result.entries, 3);
  assert.ok(result.problems.some((p) => /Unreadable/.test(p.problem)));
});

test('query filters, pages newest first and totals credits over every match', async () => {
  const root = tmpDir();
  const log = open(root);
  log.record(charge('p1', 3), new Date('2026-09-01T10:00:00Z'));
  log.record(charge('p2', 5, { type: 'remediation', credits: { kind: 'remediation', requested: 5, charged: 5 } }), new Date('2026-09-02T10:00:00Z'));
  log.record(charge('p1', 0, { outcome: 'failed', upstream: { status: 500, error: 'boom' } }), new Date('2026-09-03T10:00:00Z'));
  log.record(charge('p1', 2), new Date('2026-09-04T10:00:00Z'));
  await log.settled();

  const all = log.query({ limit: 2 });
  assert.deepEqual(all.entries.map((e) => e.seq), [4, 3]);
  assert.equal(all.more, true);
  assert.equal(all.totals.charged, 10);
  assert.equal(all.totals.triageCharged, 5);
  assert.equal(all.totals.remediationCharged, 5);
  assert.equal(all.totals.byOutcome.failed, 1);
  assert.deepEqual(log.query({ limit: 2, before: all.next }).entries.map((e) => e.seq), [2, 1]);

  assert.equal(log.query({ project: 'P2' }).totals.charged, 5);
  assert.equal(log.query({ outcomes: ['failed'] }).entries[0].upstream.error, 'boom');
  assert.equal(log.query({ q: 'BOOM' }).entries.length, 1);
  assert.deepEqual(log.query({ from: '2026-09-02', to: '2026-09-03' }).entries.map((e) => e.seq), [3, 2]);
  assert.equal(log.query({ types: ['remediation'] }).totals.entries, 1);
});

test('flushSync writes what is still queued (shutdown)', () => {
  const root = tmpDir();
  const log = open(root);
  log.record(charge('p1', 1));
  log.flushSync();
  assert.equal(open(root).verify().entries >= 1, true);
});

test('report tokens identify the report and recipient, and cannot be altered', () => {
  const grants = new ReportGrants({ secret: 'x'.repeat(40) });
  const token = grants.signReport({ id: 'r1', recipient: 'dev@acme.io', issuedAt: '2026-09-30T10:00:00Z' });
  assert.deepEqual(grants.verifyReport(token), { id: 'r1', recipient: 'dev@acme.io', issuedAt: '2026-09-30T10:00:00Z' });
  assert.equal(grants.verifyReport({ ...token, recipient: 'boss@acme.io' }), null);
  assert.equal(grants.verifyReport({ ...token, sig: '' }), null);
  assert.equal(grants.verifyReport(null), null);
  assert.equal(new ReportGrants({ secret: 'y'.repeat(40) }).verifyReport(token), null);
});

test('when the disk refuses a write, entries are held and written in order once it can', async () => {
  const root = tmpDir();
  const log = open(root);
  log.record(charge('p1', 1), new Date('2026-09-01T10:00:00Z'));
  const month = path.join(root, 'audit', 'audit-2026-09.jsonl');
  fs.chmodSync(month, 0o400);
  const blocked = process.getuid?.() !== 0; // root ignores file modes
  const errors = console.error;
  console.error = () => {};
  try {
    log.record(charge('p1', 2), new Date('2026-09-01T11:00:00Z'));
    if (blocked) assert.equal(log.writeError.entries, 1);
  } finally {
    console.error = errors;
    fs.chmodSync(month, 0o600);
  }
  log.record(charge('p1', 3), new Date('2026-09-01T12:00:00Z'));
  assert.equal(log.writeError, null);
  const result = log.verify();
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.entries, 3);
});
