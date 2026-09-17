import test from 'node:test';
import assert from 'node:assert/strict';

import { WindowError, describeWindow, resolveWindow, withinWindow } from '../src/window.js';
import { candidatesFor, isProbeMiss } from '../src/cxone/discovery.js';
import { CxApiError } from '../src/cxone/client.js';
import { lastScanDate } from '../src/cxone/projects.js';

const NOW = new Date('2026-09-15T12:00:00Z');

test('presets resolve to a start date and no end date', () => {
  assert.equal(resolveWindow({ preset: 'any' }, 'x', NOW), null);
  assert.equal(resolveWindow(null, 'x', NOW), null);

  const week = resolveWindow({ preset: '7d' }, 'x', NOW);
  assert.equal(week.from.toISOString(), '2026-09-08T12:00:00.000Z');
  assert.equal(week.to, null);

  assert.equal(resolveWindow({ preset: '365d' }, 'x', NOW).from.toISOString(), '2025-09-15T12:00:00.000Z');
});

test('a custom range covers the whole of its end day', () => {
  const window = resolveWindow({ preset: 'custom', from: '2026-01-01', to: '2026-03-31' }, 'x', NOW);
  assert.equal(window.from.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(window.to.toISOString(), '2026-03-31T23:59:59.999Z');
  // A finding detected late on the end day is still inside the range.
  assert.equal(withinWindow(window, '2026-03-31T22:00:00Z'), true);
  assert.equal(withinWindow(window, '2026-04-01T00:30:00Z'), false);
});

test('an explicit timestamp end is used as given', () => {
  const window = resolveWindow({ preset: 'custom', to: '2026-03-31T06:00:00Z' }, 'x', NOW);
  assert.equal(window.to.toISOString(), '2026-03-31T06:00:00.000Z');
});

test('bad ranges and unknown presets are rejected with a usable message', () => {
  assert.throws(() => resolveWindow({ preset: 'custom', from: 'nope' }, 'Detection', NOW), WindowError);
  assert.throws(
    () => resolveWindow({ preset: 'custom', from: '2026-05-01', to: '2026-01-01' }, 'Detection', NOW),
    /starts after it ends/,
  );
  assert.throws(() => resolveWindow({ preset: 'last-tuesday' }, 'Activity', NOW), /Unknown Activity window/);
});

test('an empty custom range is treated as unbounded', () => {
  assert.equal(resolveWindow({ preset: 'custom' }, 'x', NOW), null);
});

test('withinWindow excludes undated items but an absent window admits everything', () => {
  const window = resolveWindow({ preset: '30d' }, 'x', NOW);
  assert.equal(withinWindow(window, null), false);
  assert.equal(withinWindow(window, 'not a date'), false);
  assert.equal(withinWindow(null, null), true);
  assert.equal(withinWindow(window, '2026-09-10T00:00:00Z'), true);
  assert.equal(withinWindow(window, '2026-01-10T00:00:00Z'), false);
});

test('describeWindow renders both bounded and unbounded windows', () => {
  assert.deepEqual(describeWindow(null), { active: false, label: 'Any time', from: null, to: null });
  const described = describeWindow(resolveWindow({ preset: '7d' }, 'x', NOW));
  assert.equal(described.active, true);
  assert.equal(described.label, 'Last week');
});

test('every "wrong path" status counts as a probe miss, 400 included', () => {
  for (const status of [400, 403, 404, 405, 501]) {
    assert.equal(isProbeMiss(new CxApiError('x', { status })), true, `${status} should be a miss`);
  }
  assert.equal(isProbeMiss(new CxApiError('x', { status: 500 })), false);
  assert.equal(isProbeMiss(new Error('plain')), false);
});

test('candidatesFor puts the configured path first and never repeats it', () => {
  const list = candidatesFor('/api/risk-management/risks/{projectId}');
  assert.equal(list[0], '/api/risk-management/risks/{projectId}');
  assert.equal(new Set(list).size, list.length);
  // The documented endpoint is always among the candidates.
  assert.ok(list.includes('/api/risks/'));

  assert.equal(candidatesFor('/custom/path')[0], '/custom/path');
  assert.equal(candidatesFor('')[0], '/api/risks/');
});

test('lastScanDate reads whichever date field the tenant returns', () => {
  assert.equal(lastScanDate({ updatedAt: 'a', createdAt: 'b' }), 'a');
  assert.equal(lastScanDate({ scanDate: 'c' }), 'c');
  assert.equal(lastScanDate({ completedAt: 'd' }), 'd');
  assert.equal(lastScanDate(undefined), null);
  assert.equal(lastScanDate({}), null);
});
