// The Cx Credits Calculator's Impact (public/calculator/model.js trImpact): what using the triage &
// remediation credits gives back, in hours and money, from the projection's rows by severity.
import test from 'node:test';
import assert from 'node:assert/strict';

import { HOURS_A_YEAR, IMPACT_DEFAULTS, fusionImpact, impactSettings, overallImpact, trImpact } from '../public/calculator/model.js';

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

const fusionRows = [
  { included: true, units: 42, lines: 420000, scans: 2 },
  { included: true, units: 5, lines: 41000, scans: 12 },
  { included: false, units: 9, lines: 90000, scans: 4 },
];
const trRows = { Critical: { fusionExtra: 10, fp: 20 }, High: { fusionExtra: 40, fp: 30 }, Medium: { fusionExtra: 100, fp: 50 } };

test('Fusion: the expert review it replaces, how often each line is read, and what a team would need', () => {
  const f = fusionImpact(fusionRows, 500, 12, { linesPerHour: 200, reviewers: 3 }, trRows);
  assert.equal(f.linesOnce, 461000, 'only the projects counted');
  assert.equal(f.linesRead, 420000 * 2 + 41000 * 12);
  assert.equal(f.expertHours, f.linesRead / 200);
  assert.equal(f.timesRead, f.linesRead / f.linesOnce);
  assert.equal(f.reviewersNeeded, f.expertHours / HOURS_A_YEAR);
  assert.equal(f.teamWeeks, 461000 / 200 / (3 * 40));
  assert.equal(f.expertValue, null, 'no money until an hour has a price');
});

test('Fusion: found earlier and fixed cheaper, and the breach cost avoided, counted only when asked', () => {
  const f = fusionImpact(fusionRows, 500, 12, { hourlyRate: 85, creditPrice: 1.5, laterFixMultiplier: 5, fixMinutes: 120, breachChancePercent: 0.5, breachCost: 4880000 }, trRows);
  assert.equal(f.extraTrue, 10 * 0.8 + 40 * 0.7 + 100 * 0.5);
  assert.equal(f.extraCriticalHigh, 10 * 0.8 + 40 * 0.7);
  assert.equal(f.earlyHours, (f.extraTrue * 4 * 120) / 60);
  assert.equal(f.breachAvoided, f.extraCriticalHigh * 0.005 * 4880000);
  assert.equal(f.cost, 750);
  assert.equal(f.value, f.expertValue + f.earlyValue, 'the breach cost is not in the value unless counted');
  assert.equal(f.costPer10k, 750 / (f.linesRead / 10000));
  assert.equal(f.expertPer10k, (10000 / 200) * 85);
  const counted = fusionImpact(fusionRows, 500, 12, { hourlyRate: 85, creditPrice: 1.5, countBreach: true }, trRows);
  assert.equal(counted.value, counted.expertValue + counted.earlyValue + counted.breachAvoided);
  // Without a triage & remediation projection there is nothing found earlier to count.
  assert.equal(fusionImpact(fusionRows, 500, 12, { hourlyRate: 85 }).earlyHours, null);
});

test('overall: every credit\'s value against every credit\'s cost', () => {
  const assumptions = { hourlyRate: 85, creditPrice: 1.5 };
  const tr = trImpact(rows, 12, assumptions);
  const fu = fusionImpact(fusionRows, 500, 12, assumptions, trRows);
  const o = overallImpact(tr, fu);
  assert.equal(o.value, tr.value + fu.value);
  assert.equal(o.cost, tr.cost + fu.cost);
  assert.equal(o.roi, (o.value - o.cost) / o.cost);
  assert.deepEqual(o.sources.map((x) => x.key), ['triage', 'fixes', 'expert', 'early']);
  assert.equal(overallImpact(null, null), null);
});
