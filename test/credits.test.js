import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CreditLedger } from '../src/credits.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'credits-')), 'triage-credits.json');
const sept = new Date('2026-09-15T10:00:00Z');

test('credits are totalled per project for the month, most used first, and survive a restart', () => {
  const file = tmpFile();
  const ledger = new CreditLedger({ file });
  ledger.record({ projectId: 'p1', projectName: 'Payments', credits: 3 }, sept);
  ledger.record({ projectId: 'p2', projectName: 'HospitalMS', credits: 10 }, sept);
  ledger.record({ projectId: 'p1', projectName: 'Payments', credits: 2 }, new Date('2026-09-20T10:00:00Z'));
  ledger.record({ projectId: 'p1', credits: 7 }, new Date('2026-08-31T23:00:00Z'));
  ledger.flush(); // writes are batched; a restart after this sees them all

  const summary = new CreditLedger({ file }).summary('2026-09');
  assert.equal(summary.total, 15);
  assert.deepEqual(summary.projects.map((p) => [p.projectName, p.credits, p.requests]), [['HospitalMS', 10, 1], ['Payments', 5, 2]]);
  assert.equal(new CreditLedger({ file }).summary('2026-08').total, 7);
  assert.deepEqual(new CreditLedger({ file }).months(), ['2026-09', '2026-08']);
});

test('the monthly limit holds, including against reservations still in flight', () => {
  const ledger = new CreditLedger({ file: tmpFile() });
  ledger.record({ projectId: 'p1', credits: 6 }, sept);

  const first = ledger.reserve(3, 10, sept);
  assert.ok(first, 'fits: 6 used + 3');
  assert.equal(ledger.reserve(2, 10, sept), null, 'the in-flight 3 counts: 6 + 3 + 2 > 10');
  assert.equal(ledger.remaining(10, sept), 1);
  first.release();
  first.release();
  assert.equal(ledger.remaining(10, sept), 4, 'releasing twice does not double-count');
  assert.equal(ledger.remaining(0, sept), null, '0 means no limit');
  assert.ok(ledger.reserve(1_000, 0, sept));
});

test('triage and remediation credits are totalled separately and together', () => {
  const ledger = new CreditLedger({ file: tmpFile() });
  ledger.record({ projectId: 'p1', projectName: 'Payments', credits: 4, kind: 'triage' }, sept);
  ledger.record({ projectId: 'p1', projectName: 'Payments', credits: 1, kind: 'remediation' }, sept);
  ledger.record({ projectId: 'p2', credits: 2 }, sept);

  const summary = ledger.summary('2026-09');
  assert.deepEqual([summary.total, summary.triageTotal, summary.remediationTotal], [7, 6, 1]);
  const payments = summary.projects.find((p) => p.projectId === 'p1');
  assert.deepEqual([payments.triageCredits, payments.remediationCredits, payments.credits], [4, 1, 5]);
});

test('balances come from running totals, and match a full recount after reload', () => {
  const file = tmpFile();
  const ledger = new CreditLedger({ file, writeDelayMs: 0 });
  for (let i = 0; i < 500; i += 1) {
    ledger.record({ projectId: `p${i % 7}`, credits: 3, kind: i % 2 ? 'remediation' : 'triage', riskIds: [`r${i}`], covered: i % 3 ? 3 : 0 }, sept);
  }
  const reloaded = new CreditLedger({ file });
  for (let p = 0; p < 7; p += 1) {
    for (const kind of ['triage', 'remediation']) {
      assert.equal(reloaded.usedBy(`p${p}`, kind), ledger.usedBy(`p${p}`, kind));
      assert.equal(reloaded.coveredBy(`p${p}`, kind), ledger.coveredBy(`p${p}`, kind));
    }
  }
  assert.equal(ledger.usedInMonth('2026-09'), 1500);
  assert.ok(ledger.remediatedIds('p1').has('r1'));
  assert.ok(!ledger.remediatedIds('p1').has('r0'), 'triage entries are not remediations');
});
