import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FindingJournal } from '../src/finding-journal.js';
import { computeImpact } from '../src/impact.js';

const DAY = 86_400_000;
const t0 = new Date('2026-09-01T00:00:00Z');
const at = (days) => new Date(t0.getTime() + days * DAY);
const risk = (riskId, severity, extra = {}) => ({ riskId, severity, state: 'TO_VERIFY', firstDetectedAt: '2026-08-01T00:00:00Z', ...extra });

test('the journal records first seen, verdicts and gone, and marks gone only on a complete read', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'journal-')), 'finding-journal.json');
  const journal = new FindingJournal({ file, writeDelayMs: 0 });
  const p = { projectId: 'p1', projectName: 'Payments' };
  journal.observe(p, [risk('a', 'HIGH'), risk('b', 'LOW'), risk('c', 'CRITICAL')], { complete: true, now: at(0) });
  // A partial read (a date window) never marks anything gone.
  journal.observe(p, [risk('a', 'HIGH')], { complete: false, now: at(1) });
  assert.ok(journal.entries().every((e) => !e.g));
  // b is judged not exploitable; c no longer reported.
  journal.observe(p, [risk('a', 'HIGH', { state: 'CONFIRMED' }), risk('b', 'LOW', { state: 'PROPOSED_NOT_EXPLOITABLE' })], { complete: true, now: at(2) });
  const byId = Object.fromEntries(journal.entries().map((e) => [e.r, e]));
  assert.equal(byId.a.c, at(2).toISOString());
  assert.equal(byId.b.x, at(2).toISOString());
  assert.equal(byId.c.g, at(2).toISOString());
  assert.equal(byId.a.d, '2026-08-01');
  // Reported again: not fixed after all.
  journal.observe(p, [risk('a', 'HIGH'), risk('b', 'LOW', { state: 'NOT_EXPLOITABLE' }), risk('c', 'CRITICAL')], { complete: true, now: at(3) });
  assert.equal(journal.entries().find((e) => e.r === 'c').g, undefined);
  journal.flush();
  assert.equal(new FindingJournal({ file }).size, 3, 'kept across restarts');
});

test('impact: hours saved, noise removed, AI against manual time to fix, debt and its pace, each result once', () => {
  const journal = [
    // Fixed with AI Remediation: two rows of one Checkmarx One result, gone on day 10.
    { p: 'p1', n: 'Payments', r: 'a1', u: 'a:R1', s: 'CRITICAL', d: '2026-08-01', o: at(0).toISOString(), g: at(10).toISOString() },
    { p: 'p1', n: 'Payments', r: 'a2', u: 'a:R1', s: 'CRITICAL', d: '2026-08-01', o: at(0).toISOString(), g: at(10).toISOString() },
    // Fixed by hand on day 20.
    { p: 'p1', n: 'Payments', r: 'm', u: 'r:m', s: 'CRITICAL', d: '2026-08-01', o: at(0).toISOString(), g: at(20).toISOString() },
    // AI Triage showed it not exploitable on day 5.
    { p: 'p2', n: 'Portal', r: 'n', u: 'r:n', s: 'HIGH', d: '2026-08-15', o: at(0).toISOString(), x: at(5).toISOString() },
    // Still open.
    { p: 'p2', n: 'Portal', r: 'o', u: 'r:o', s: 'LOW', d: '2026-08-15', o: at(0).toISOString() },
  ];
  const ledger = [
    { at: at(1).toISOString(), projectId: 'p1', kind: 'triage', credits: 1, riskIds: ['a1', 'a2'], alternateIds: ['R1'] },
    { at: at(1).toISOString(), projectId: 'p2', kind: 'triage', credits: 1, riskIds: ['n'] },
    { at: at(3).toISOString(), projectId: 'p1', kind: 'remediation', credits: 3, riskIds: ['a1'] },
  ];
  const impact = computeImpact({ journal, ledger, settings: { triageMinutes: 30, fixMinutes: 120, hourlyRate: 100, creditPrice: 2 }, from: at(0).toISOString(), now: at(28) });
  assert.equal(impact.aiFixed, 1, 'two rows, one result, one fix');
  assert.equal(impact.manualFixed, 1);
  assert.equal(impact.noiseRemoved, 1);
  assert.equal(impact.aiTriaged, 2);
  assert.deepEqual(impact.credits, { triage: 2, remediation: 3, total: 5 });
  // 2 results × 30 min + 1 fix × 120 min = 3 h.
  assert.deepEqual(impact.hours, { triage: 1, fix: 2, total: 3 });
  assert.deepEqual(impact.money, { value: 300, cost: 10, net: 290, currency: 'USD' });
  assert.equal(impact.creditsPerClosed, 2.5);
  const critical = impact.timeToFix.find((r) => r.severity === 'CRITICAL');
  assert.deepEqual([critical.ai, critical.manual], [41, 51], 'days from first detection (1 Aug) to gone');
  // Debt: critical 10 + critical 10 + high 5 + low 1 = 26 at the start; only the low one is left.
  assert.equal(impact.debt.start, 26);
  assert.equal(impact.debt.now, 1);
  assert.equal(impact.debt.change, -96);
  assert.ok(impact.series.length >= 4 && impact.series.at(-1).score === 1);
  assert.match(impact.debt.zeroBy ?? '', /^2026-/);
  const portal = impact.byProject.find((p) => p.projectId === 'p2');
  assert.deepEqual([portal.notExploitable, portal.open, portal.credits], [1, 1, 1]);
  // Without a rate or price, no money figures.
  const plain = computeImpact({ journal, ledger, from: at(0).toISOString(), now: at(28) });
  assert.deepEqual([plain.money.value, plain.money.cost, plain.money.net], [null, null, null]);
  assert.equal(plain.hours.total, round(2 * 20 / 60 + 2), 'defaults: 20 min per triage, 120 per fix');
});

const round = (n) => Math.round(n * 10) / 10;
