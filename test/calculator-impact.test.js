// The Cx Credits Calculator's Impact (public/calculator/model.js trImpact): what using the triage &
// remediation credits gives back, in hours and money, from the projection's rows by severity.
import test from 'node:test';
import assert from 'node:assert/strict';

import { HOURS_A_YEAR, IMPACT_DEFAULTS, impactSettings, trImpact } from '../public/calculator/model.js';

const rows = {
  Critical: { toTriage: 100, truePositives: 40, credits: 220 },
  High: { toTriage: 300, truePositives: 90, credits: 570 },
};

test('hours: every finding triaged by hand, every fix by hand less the review of the AI fix', () => {
  const m = trImpact(rows, 12, { triageMinutes: 20, fixMinutes: 120, reviewMinutes: 15 });
  assert.equal(m.triaged, 400);
  assert.equal(m.fixes, 130);
  assert.equal(m.cleared, 270, 'the false positives cleared: triaged − true positives');
  assert.equal(m.triageHours, (400 * 20) / 60);
  assert.equal(m.fixHours, (130 * 105) / 60);
  assert.equal(m.hours, m.triageHours + m.fixHours);
  assert.equal(m.developerYears, m.hours / HOURS_A_YEAR);
  assert.equal(m.value, null, 'no money until an hour has a price');
  assert.equal(m.roi, null);
});

test('money: the value of the time against what the credits cost, the return and the payback', () => {
  const m = trImpact(rows, 12, { hourlyRate: 80, creditPrice: 2 });
  assert.equal(m.credits, 790);
  assert.equal(m.cost, 1580);
  assert.equal(m.value, m.hours * 80);
  assert.equal(m.net, m.value - 1580);
  assert.equal(m.roi, m.net / 1580);
  assert.equal(m.paybackMonths, 1580 / (m.value / 12));
  // Without a credit price: the value stands alone, with no return worked out.
  const free = trImpact(rows, 12, { hourlyRate: 80 });
  assert.equal(free.cost, null);
  assert.equal(free.net, free.value);
  assert.equal(free.roi, null);
});

test('a review longer than the fix by hand never makes hours negative', () => {
  const m = trImpact(rows, 12, { fixMinutes: 10, reviewMinutes: 30 });
  assert.equal(m.fixHours, 0);
});

test('assumptions are cleaned: numbers within bounds, a three-letter currency, defaults for the rest', () => {
  assert.deepEqual(impactSettings({}), IMPACT_DEFAULTS);
  const s = impactSettings({ triageMinutes: '-5', fixMinutes: 'abc', hourlyRate: 1e9, currency: 'eur!' }, { fixMinutes: 90 });
  assert.equal(s.triageMinutes, 20, 'a negative number is not read: the default');
  assert.equal(s.fixMinutes, 90, 'an unreadable number takes the base');
  assert.equal(s.hourlyRate, 100000);
  assert.equal(s.currency, 'EUR');
});
