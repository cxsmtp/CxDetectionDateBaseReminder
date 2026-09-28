import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AutomationState,
  DEFAULT_AUTOMATION,
  applyLedger,
  findCrossings,
  mergeAutomation,
  parseThresholds,
} from '../src/automation.js';

const THRESHOLDS = [30, 60, 90];
const emptyLedger = () => ({ notified: {}, runs: [] });

const risk = (id, ageDays, over = {}) => ({
  id,
  projectId: 'p1',
  projectName: 'Payments API',
  severity: 'HIGH',
  ageDays,
  ...over,
});

test('parseThresholds accepts a typed list and rejects nonsense', () => {
  assert.deepEqual(parseThresholds('30, 60, 90'), [30, 60, 90]);
  assert.deepEqual(parseThresholds('90 30 60'), [30, 60, 90], 'sorted ascending');
  assert.deepEqual(parseThresholds([60, 60, 30]), [30, 60], 'duplicates collapse');
  assert.deepEqual(parseThresholds('0, -5, abc'), DEFAULT_AUTOMATION.thresholds, 'falls back');
  assert.deepEqual(parseThresholds(''), DEFAULT_AUTOMATION.thresholds);
});

test('the run interval is clamped to something sensible', () => {
  assert.equal(mergeAutomation(DEFAULT_AUTOMATION, { intervalMinutes: 1 }).intervalMinutes, 15);
  assert.equal(mergeAutomation(DEFAULT_AUTOMATION, { intervalMinutes: 999999 }).intervalMinutes, 10_080);
  assert.equal(mergeAutomation(DEFAULT_AUTOMATION, { intervalMinutes: 360 }).intervalMinutes, 360);
  assert.equal(mergeAutomation(DEFAULT_AUTOMATION, { intervalMinutes: 'x' }).intervalMinutes, 360);
});

test('severities are filtered to the ones Checkmarx actually reports', () => {
  assert.deepEqual(mergeAutomation(DEFAULT_AUTOMATION, { severities: 'critical, high, bogus' }).severities, [
    'CRITICAL',
    'HIGH',
  ]);
});

test('a finding below every threshold is not reported', () => {
  const { crossed } = findCrossings([risk('a', 10)], THRESHOLDS, emptyLedger());
  assert.equal(crossed.length, 0);
});

test('a finding reaching a threshold is reported exactly once', () => {
  const ledger = emptyLedger();
  const first = findCrossings([risk('a', 30)], THRESHOLDS, ledger);

  assert.equal(first.crossed.length, 1);
  assert.equal(first.crossed[0].threshold, 30);
  applyLedger(ledger, first.crossed, first.seen);

  // The daily sweep must not nag about the same finding again.
  for (const age of [31, 45, 59]) {
    const again = findCrossings([risk('a', age)], THRESHOLDS, ledger);
    assert.equal(again.crossed.length, 0, `age ${age} should stay quiet`);
  }
});

test('crossing the next threshold reports again', () => {
  const ledger = emptyLedger();
  let run = findCrossings([risk('a', 30)], THRESHOLDS, ledger);
  applyLedger(ledger, run.crossed, run.seen);

  run = findCrossings([risk('a', 61)], THRESHOLDS, ledger);
  assert.equal(run.crossed.length, 1);
  assert.equal(run.crossed[0].threshold, 60);
  applyLedger(ledger, run.crossed, run.seen);

  run = findCrossings([risk('a', 95)], THRESHOLDS, ledger);
  assert.equal(run.crossed[0].threshold, 90);
  applyLedger(ledger, run.crossed, run.seen);

  // Past the last threshold there is nothing further to announce.
  assert.equal(findCrossings([risk('a', 400)], THRESHOLDS, ledger).crossed.length, 0);
});

test('an already-ancient finding produces one message, not one per threshold', () => {
  const ledger = emptyLedger();
  const { crossed, seen } = findCrossings([risk('a', 200)], THRESHOLDS, ledger);

  assert.equal(crossed.length, 1, 'one message');
  assert.equal(crossed[0].threshold, 90, 'reported against the highest threshold passed');
  assert.deepEqual(crossed[0].newThresholds, [30, 60, 90]);

  // And all three are marked, so none of them fires later.
  applyLedger(ledger, crossed, seen);
  assert.deepEqual(Object.keys(ledger.notified['p1:a']).sort(), ['30', '60', '90']);
  assert.equal(findCrossings([risk('a', 250)], THRESHOLDS, ledger).crossed.length, 0);
});

test('a finding with no first-detection date is never reported', () => {
  assert.equal(findCrossings([risk('a', null)], THRESHOLDS, emptyLedger()).crossed.length, 0);
  assert.equal(findCrossings([risk('a', undefined)], THRESHOLDS, emptyLedger()).crossed.length, 0);
});

test('digest mode re-reports everything past a threshold every run', () => {
  const ledger = emptyLedger();
  const options = { mode: 'digest' };

  const first = findCrossings([risk('a', 100)], THRESHOLDS, ledger, options);
  applyLedger(ledger, first.crossed, first.seen);

  const second = findCrossings([risk('a', 101)], THRESHOLDS, ledger, options);
  assert.equal(second.crossed.length, 1, 'digest keeps reporting');
});

test('a fixed finding is forgotten, and a regression is reported again', () => {
  const ledger = emptyLedger();
  let run = findCrossings([risk('a', 40), risk('b', 40)], THRESHOLDS, ledger);
  applyLedger(ledger, run.crossed, run.seen);
  assert.equal(Object.keys(ledger.notified).length, 2);

  // 'b' is fixed, so it disappears from the results.
  run = findCrossings([risk('a', 41)], THRESHOLDS, ledger);
  const { pruned } = applyLedger(ledger, run.crossed, run.seen);
  assert.equal(pruned, 1);
  assert.deepEqual(Object.keys(ledger.notified), ['p1:a']);

  // If it comes back, it is news again.
  run = findCrossings([risk('a', 42), risk('b', 42)], THRESHOLDS, ledger);
  assert.deepEqual(run.crossed.map((r) => r.id), ['b']);
});

test('findings are keyed per project, so the same id in two projects is distinct', () => {
  const ledger = emptyLedger();
  const run = findCrossings(
    [risk('same', 40), risk('same', 40, { projectId: 'p2' })],
    THRESHOLDS,
    ledger,
  );

  assert.equal(run.crossed.length, 2);
  applyLedger(ledger, run.crossed, run.seen);
  assert.deepEqual(Object.keys(ledger.notified).sort(), ['p1:same', 'p2:same']);
});

test('a custom threshold list is honoured', () => {
  const { crossed } = findCrossings([risk('a', 8)], [7, 14], emptyLedger());
  assert.equal(crossed[0].threshold, 7);
});

test('the ledger survives a restart and can be reset', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cxdr-')), 'automation.json');
  const state = new AutomationState({ file });

  const run = findCrossings([risk('a', 40)], THRESHOLDS, state.ledger);
  applyLedger(state.ledger, run.crossed, run.seen);
  state.recordRun({ ok: true, sent: 1 });

  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);

  const reloaded = new AutomationState({ file });
  assert.ok(reloaded.ledger.notified['p1:a'], 'reported pairs survive a restart');
  assert.equal(reloaded.runs.length, 1);
  // Which means no duplicate mail after a restart.
  assert.equal(findCrossings([risk('a', 41)], THRESHOLDS, reloaded.ledger).crossed.length, 0);

  reloaded.reset();
  assert.equal(findCrossings([risk('a', 41)], THRESHOLDS, reloaded.ledger).crossed.length, 1);
});

test('a corrupt state file falls back to an empty ledger', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cxdr-')), 'automation.json');
  fs.writeFileSync(file, '{ not json');
  const state = new AutomationState({ file });
  assert.deepEqual(state.ledger.notified, {});
  assert.deepEqual(state.runs, []);
});
