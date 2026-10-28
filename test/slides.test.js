// The projection's three-page PDF summary (public/calculator/slides.js): what each page says, and
// a PDF any reader opens (the pages themselves are drawn in the browser).
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyse, creditSummary, fusionEstimate, fusionImpact, overallImpact, planForecast, seriesRows, trImpact, trProjection } from '../public/calculator/model.js';
import { numberContents, pdfFromJpegs, slideContent, slidesFileName } from '../public/calculator/slides.js';

const totals = { weeks: ['2026-01-03', '2026-02-07', '2026-03-07', '2026-04-04'], bySeverity: { Critical: [10, 12, 14, 16], High: [100, 110, 120, 130], Medium: [5, 5, 5, 5], Low: [1, 1, 1, 1] } };
const fixed = { weeks: ['2026-03-07', '2026-04-04'], bySeverity: { Critical: [1, 2], High: [3, 4] } };

function impactOf(projection, est) {
  const assumptions = { hourlyRate: 90, creditPrice: 2, currency: 'EUR' };
  const tr = trImpact(projection.rows, 12, assumptions);
  const fusion = est ? fusionImpact(est.rows, est.totals.credits, 12, assumptions, projection.rows) : null;
  return { tr, fusion, overall: overallImpact(tr, fusion) };
}

function reportData({ withFusion = true, withTr = true, withImpact = false, plan = {} } = {}) {
  const { totalRows, fixedRows } = seriesRows(totals, fixed);
  const analysis = analyse(totalRows, fixedRows, 3);
  const projection = trProjection(analysis, plan, { months: 12, fusion: withFusion });
  const est = fusionEstimate([{ id: 'x', name: 'Payments', loc: 25000, frequency: 'month' }, { id: 'y', name: 'Mobile', loc: 4000, frequency: 'week' }], { models: [{ id: 'm', name: 'Opus-4.7', creditsPer10k: 2.5 }], defaultScans: 2 });
  return {
    customer: 'Globex', organisation: 'Acme', generatedAt: '2026-10-09T10:00:00Z', months: 12, preparedBy: 'ana@acme.io',
    summary: creditSummary(withTr ? projection.totals.credits : null, withFusion ? est.totals.credits : null, { extraPercent: 10 }),
    tr: withTr ? { lookbackMonths: 3, months: 12, fusion: withFusion, ahead: projection.ahead, rows: projection.rows, totals: projection.totals, analysis: { ...analysis.perSeverity, total: analysis.total }, monthlyChange: analysis.monthlyChange, forecast: planForecast(analysis, projection) } : null,
    fusion: withFusion ? { periodMonths: 12, byFrequency: est.byFrequency, byModel: est.byModel, totals: est.totals } : null,
    impact: withTr && withImpact ? impactOf(projection, withFusion ? est : null) : null,
  };
}

test('three pages: triage & remediation with its forecast, then Fusion, then the credits needed overall', () => {
  const data = reportData();
  // Unless the calculations are asked for, the pages to present only.
  const lean = slideContent(data);
  assert.deepEqual(lean.pages.map((p) => p.kind), ['tr', 'fusion', 'total']);
  assert.deepEqual(lean.appendix, []);
  const s = slideContent(data, { calculations: true });
  assert.deepEqual(s.pages.map((p) => p.kind), ['tr', 'fusion', 'total', 'section', 'trend']);
  const [tr, fusion, total, section, trend] = s.pages;
  assert.equal(section.title, 'Appendix – Calculations', 'the fourth slide opens the appendix');
  assert.equal(s.heading(tr), 'Globex: Triage & remediation');
  assert.deepEqual(tr.figures.map((f) => f.label), ['Total open vulnerabilities today', 'Still to come, 2% fewer over a year with AI', 'To triage', 'Triage & remediation credits']);
  assert.equal(tr.figures[0].value, '152');
  assert.equal(tr.figures[0].small, true, 'the total, small: what the plan takes comes next');
  assert.deepEqual(tr.figures[2].notes, [`${Math.round(data.tr.totals.truePositives).toLocaleString()} to remediate`, 'Included: Critical 16 · High 130 · Medium 5 · Low 1']);
  assert.deepEqual(tr.figures[3].notes, ['30% taken as false positives: triaged, not remediated.']);
  assert.equal(tr.chart.kind, 'forecast');
  assert.ok(tr.chart.points.length > 3, 'the backlog so far and over the next months');
  assert.match(tr.lines[0], /^Each month, new findings add [\d.]+% to the backlog and fixes take away [\d.]+%\.$/);
  assert.equal(fusion.figures.at(-1).value, Math.round(data.fusion.totals.credits).toLocaleString());
  assert.ok(fusion.bars.items.length >= 1 && fusion.bars.items.every((b) => b.value > 0));
  assert.equal(total.total, Math.round(data.summary.total).toLocaleString());
  assert.deepEqual(total.parts.map((p) => p.label), ['Backlog today', 'Findings ahead', 'Fusion scans', 'Extra credits']);
  assert.ok(total.lines.some((l) => /Bundles of 10,000 credits/.test(l)), 'the assumptions, as plain text');
  assert.ok(total.lines.every((l) => !/[<>]|&amp;/.test(l)));
  assert.equal(s.footer, `Made ${new Date('2026-10-09T10:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })} by ana@acme.io`);
  assert.equal(slidesFileName('Globex & Co', '2026-10-09T10:00:00Z').endsWith('_summary.pdf'), true);
  // The trend by severity, and every number's calculation in one line, with the figures in.
  assert.deepEqual(trend.trend.head, ['Severity', 'Open now', 'Added a month', 'Fixed a month', 'Change a month']);
  assert.equal(trend.trend.rows.length, 5, 'four severities and the total');
  assert.equal(trend.trend.rows.at(-1)[1], '152');
  const T = data.tr.totals;
  const toTriage = trend.calc.find((c) => c.label === 'To triage');
  assert.equal(toTriage.formula, `${Math.round(T.selected).toLocaleString()} + ${Math.round(T.future).toLocaleString()} + ${Math.round(T.fusionExtra).toLocaleString()} = ${Math.round(T.toTriage).toLocaleString()}`);
  assert.ok(trend.calc.some((c) => c.label === 'Total credits required' && c.formula.includes(`→ ${data.summary.bundles}`)));
  // The appendix: every number, step by step, as plain text.
  assert.deepEqual(s.appendix.map((x) => x.title), ['Backlog today', 'Still to come', 'More found by Fusion', 'To triage', 'To remediate', 'Credits', 'Fusion credits', 'Total credits required']);
  assert.ok(s.appendix.every((x) => x.lines.length && x.lines.every((l) => !/[<>]|&amp;/.test(l.text))));
});

test('the plan in part: which severities are whole and which in part, each false positive %; no findings still to come when they are not counted', () => {
  const s = slideContent(reportData({ plan: { selected: { Critical: null, High: null, Medium: 2, Low: 0 }, fpPercent: { Critical: 20, High: 30, Medium: 30, Low: 30 }, includeFuture: false } }));
  const tr = s.pages[0];
  assert.deepEqual(tr.figures.map((f) => f.label), ['Total open vulnerabilities today', 'To triage', 'Triage & remediation credits'], 'Still to come is left out, not shown as +0');
  assert.deepEqual(tr.figures[1].notes.slice(1), ['Included: Critical 16 · High 130 · Medium 2', 'Excluded: Medium 3 · Low 1'], 'what is left out, by severity; none left out of a severity: not said');
  assert.match(tr.subtitle, /^The backlog today, triaged and remediated over the next 12 months$/);
  assert.deepEqual(tr.figures[2].notes, ['Taken as false positives, triaged and not remediated: Critical 20%, High 30%, Medium 30%.']);
});

test('a part that is not in the projection says so on its page; the wording follows the reader\'s language', () => {
  const s = slideContent(reportData({ withFusion: false }), { t: (text) => (text === 'Checkmarx Fusion' ? 'Fusion (fr)' : text), lang: 'fr' });
  assert.equal(s.pages[1].title, 'Fusion (fr)');
  assert.deepEqual(s.pages[1].lines, ['Fusion is not in this projection.']);
  assert.equal(s.pages[0].figures[0].value, (152).toLocaleString('fr'));
  const noTr = slideContent(reportData({ withTr: false }));
  assert.deepEqual(noTr.pages[0].lines, ['Triage & remediation is not in this projection.']);
  assert.deepEqual(noTr.pages[2].parts.map((p) => p.label), ['Fusion scans', 'Extra credits']);
});

test('the PDF: one picture filling each 16:9 page, with a cross-reference table that points at every object', () => {
  const jpeg = (n) => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n, 1, 2, 3, 0xff, 0xd9]), width: 1920, height: 1080 });
  const pdf = pdfFromJpegs([jpeg(1), jpeg(2), jpeg(3)], { title: 'Globex: 合計 credits' });
  const text = Buffer.from(pdf).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4\n') && text.endsWith('%%EOF\n'));
  assert.match(text, /\/Type \/Pages \/Kids \[4 0 R 7 0 R 10 0 R\] \/Count 3/);
  assert.equal((text.match(/\/MediaBox \[0 0 960 540\]/g) ?? []).length, 3);
  assert.equal((text.match(/\/Filter \/DCTDecode \/Length 10 >>/g) ?? []).length, 3);
  assert.match(text, /\/Title <FEFF0047006C006F006200650078003A002054088A08/, 'the title in UTF-16, so any language');
  const xref = Number(text.match(/startxref\n(\d+)/)[1]);
  assert.ok(text.slice(xref).startsWith('xref\n0 13\n'));
  const offsets = text.slice(xref).split('\n').slice(3, 15).map((line) => Number(line.slice(0, 10)));
  offsets.forEach((at, i) => assert.ok(text.slice(at).startsWith(`${i + 1} 0 obj\n`), `object ${i + 1} is where the table says`));
});

test('the fourth slide opens the appendix and says on which pages its parts are', () => {
  const s = slideContent(reportData(), { calculations: true });
  // As the PDF lays them out: the five pages, then the step-by-step appendix over two pages.
  const all = [...s.pages, { kind: 'appendix' }, { kind: 'appendix' }];
  numberContents(all);
  assert.equal(all.length, 7, 'seven slides in all');
  assert.equal(all[3].kind, 'section');
  assert.deepEqual(all[3].contents.map((c) => c.pages), ['5', '6–7']);
});

test('with the impact worked out, slide 4 is what the credits give back and the appendix follows it', () => {
  const data = reportData({ withImpact: true });
  assert.deepEqual(slideContent(data).pages.map((p) => p.kind), ['tr', 'fusion', 'total', 'impact'], 'no appendix unless asked for');
  const s = slideContent(data, { calculations: true });
  assert.deepEqual(s.pages.map((p) => p.kind), ['tr', 'fusion', 'total', 'impact', 'section', 'trend']);
  const impact = s.pages[3];
  const o = data.impact.overall;
  assert.equal(impact.title, 'What the credits give back');
  assert.equal(impact.subtitle, 'Triage & remediation and Fusion over 12 months');
  assert.deepEqual(impact.figures.map((f) => f.label), ['All the credits give back', 'What the credits cost', 'Return', 'Hours given back']);
  assert.match(impact.figures[0].value, /€/, 'all the credits give back, in the customer\'s currency');
  assert.match(impact.figures[2].value, /^[\d,]+%$/, 'the return, as a percentage');
  assert.equal(impact.figures[3].value, Math.round(o.hours).toLocaleString());
  // Where the value comes from: triage, fixes, the expert review Fusion replaces, and what it finds earlier.
  assert.deepEqual(impact.bars.items.map((b) => b.label), ['AI Triage', 'AI Remediation', 'Expert review replaced', 'Found earlier, fixed cheaper']);
  assert.ok(impact.lines.some((l) => /Breach cost avoided, an expected cost not counted/.test(l)), 'the breach cost is said, not counted');
  const all = [...s.pages, { kind: 'appendix' }, { kind: 'appendix' }];
  numberContents(all);
  assert.equal(all.length, 8, 'eight slides with the impact');
  assert.deepEqual(all[4].contents.map((c) => c.pages), ['6', '7–8']);
  // The appendix explains the impact too, step by step.
  assert.ok(s.appendix.some((x) => x.title === 'Hours given back'));
  assert.ok(s.appendix.some((x) => x.title === 'Value and return'));
  assert.ok(s.appendix.some((x) => x.title === 'Expert review replaced'));
  assert.ok(s.appendix.some((x) => x.title === 'Return on all the credits'));
});
