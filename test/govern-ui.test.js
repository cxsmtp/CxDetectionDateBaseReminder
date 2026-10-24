// Labs → Govern (Beta), the page's pure parts (public/govern.js): formatting, statuses and their badges, what each
// person sees and may do, the pool guard and bar, the chart's rows, and the CSV / HTML exports of what a table shows.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUDGET_STATUS, STATUS_ORDER, attributionActions, budgetActions, budgetColumns, budgetWhy, changeText, chartSvg, credits, deliveryText, importColumns, isPersonal,
  mayRun, niceScale, periodText, poolGuard, poolParts, requestActions, requestColumns, restrictionColumns, statusBadge, tableCsv, tableReport, tableRows, tabsFor, trendRows, useBar, waitingLabel,
} from '../public/govern.js';

const ALL = ['govern.view', 'govern.request', 'govern.approve', 'govern.budgets', 'govern.enforce', 'govern.restore', 'govern.attribution', 'govern.settings'];
const budget = (over = {}) => ({ id: 'b1', version: 1, entityType: 'user', entityId: 'u-1', entityLabel: 'Ana Lima · ana@acme.io', amount: 100, limit: 100, topUps: [], period: 'monthly', warnPct: 80, mode: 'monitor', active: true, exempt: false, used: 50, pct: 50, status: 'within', restrictions: { total: 0, applied: 0, partial: 0, failed: 0, pending: 0, skipped: 0, reasons: [] }, updatedAt: '2026-10-02T10:00:00Z', updatedBy: 'mei@acme.io', notes: '', ...over });

test('credits and waiting times read as people say them', () => {
  assert.equal(credits(null), '—');
  assert.equal(credits(''), '—');
  assert.equal(credits(1234.567), (1234.57).toLocaleString(undefined, { maximumFractionDigits: 2 }));
  assert.deepEqual([waitingLabel(25), waitingLabel(120), waitingLabel(60 * 27), waitingLabel(60 * 48), waitingLabel(null)], ['waiting 25 min', 'waiting 2 h', 'waiting 1 d 3 h', 'waiting 2 d', '']);
});

test('every budget status has its own words and badge; the worst sort first', () => {
  for (const s of ['within', 'near', 'over', 'restricted', 'partial', 'restricting', 'exempt', 'not_reported', 'inactive', 'not_open', 'needs_confirmation', 'not_evaluated']) {
    assert.ok(BUDGET_STATUS[s], s);
    assert.ok(STATUS_ORDER.includes(s), s);
  }
  const pairs = Object.values(BUDGET_STATUS).map(([label, cls]) => `${label}|${cls}`);
  assert.equal(new Set(pairs).size, pairs.length, 'no two statuses look the same');
  assert.match(statusBadge('restricted'), /class="badge gv-restricted">Restricted</);
  assert.match(statusBadge('not_reported'), /gv-dashed">Not reported</);
  assert.ok(STATUS_ORDER.indexOf('restricted') < STATUS_ORDER.indexOf('within'));
  // An unknown status is shown as it is, escaped.
  assert.match(statusBadge('<x>'), /&lt;x&gt;/);
});

test('a budget\'s bar: the fill from the left, the warn tick, near and over; nothing to show without a figure', () => {
  assert.match(useBar(budget({ pct: 90, warnPct: 80 })), /gv-fill near" style="width:90.0%".*inset-inline-start:calc\(80% - 1px\).*<b class="near">90%/);
  assert.match(useBar(budget({ pct: 140 })), /gv-fill over" style="width:100.0%".*>140%</);
  assert.match(useBar(budget({ pct: null })), /gv-use na/);
  assert.match(useBar(budget({ limit: 0, pct: 100 })), /gv-use na/);
});

test('the line under a budget says why it is in that state', () => {
  assert.match(budgetWhy(budget({ status: 'partial', restrictions: { applied: 1, reasons: ['team-a grants view-risk-management-tab'] } })), /warn.*team-a grants/);
  assert.match(budgetWhy(budget({ status: 'restricted', restrictions: { applied: 2, reasons: [] } })), /2 restrictions in force/);
  assert.match(budgetWhy(budget({ status: 'over', mode: 'monitor' })), /Monitor: warned, nothing removed/);
  assert.match(budgetWhy(budget({ status: 'not_reported', entityType: 'group' })), /does not report usage per group/);
  assert.equal(budgetWhy(budget()), '');
});

test('periods in words, custom with its dates', () => {
  assert.equal(periodText(budget()), 'Monthly');
  assert.equal(periodText(budget({ period: 'lifetime' })), 'Lifetime');
  assert.match(periodText(budget({ period: 'custom', customStart: '2026-10-01T00:00:00Z', customEnd: '2026-12-15T00:00:00Z' })), /^Custom .+ – .+2026$/);
});

test('who sees which tab: request-only people get their own view; Run now for budgets, settings or enforce', () => {
  assert.deepEqual(tabsFor(ALL), ['overview', 'budgets', 'requests', 'restrictions', 'attribution', 'settings']);
  assert.deepEqual(tabsFor(['govern.request']), ['overview', 'requests']);
  assert.deepEqual(tabsFor(['govern.view', 'govern.request']), ['overview', 'budgets', 'requests', 'restrictions', 'attribution']);
  assert.deepEqual(tabsFor(['govern.attribution']), ['attribution']);
  assert.equal(isPersonal(['govern.request']), true);
  assert.equal(isPersonal(['govern.view', 'govern.request']), false);
  assert.equal(mayRun(['govern.view', 'govern.request']), false);
  assert.equal(mayRun(['govern.enforce']), true);
});

test('the budgets action bar offers only what changes something, and Enforce only to holders of govern.enforce', () => {
  const rows = [budget({ mode: 'enforce' }), budget({ id: 'b2', active: false, exempt: true })];
  assert.deepEqual(budgetActions(rows, ALL), ['amount', 'warn', 'monitor', 'enforce', 'pause', 'resume', 'exempt', 'unexempt']);
  assert.deepEqual(budgetActions([budget()], ['govern.budgets']), ['amount', 'warn', 'pause', 'exempt']);
  assert.deepEqual(budgetActions(rows, ['govern.view']), [], 'nothing without govern.budgets');
  assert.deepEqual(budgetActions([], ALL), []);
});

test('requests: approvers approve or deny open ones; a requester withdraws only their own', () => {
  const open = { id: 'r1', status: 'open', by: 'ana@acme.io' };
  const done = { id: 'r2', status: 'approved', by: 'ana@acme.io' };
  assert.deepEqual(requestActions([open, done], ALL, 'admin@acme.io'), ['approve', 'deny']);
  assert.deepEqual(requestActions([open], ['govern.request'], 'ana@acme.io'), ['cancel']);
  assert.deepEqual(requestActions([open], ['govern.request'], 'uma@acme.io'), []);
  assert.deepEqual(requestActions([done], ALL, 'ana@acme.io'), []);
});

test('attribution: ignore what is not ignored, clear what was decided; only with govern.attribution', () => {
  const rows = [{ status: 'disputed', decision: null }, { status: 'ignored', decision: { ignored: true } }];
  assert.deepEqual(attributionActions(rows, ['govern.attribution']), ['ignore', 'clear']);
  assert.deepEqual(attributionActions(rows, ['govern.view']), []);
});

test('the pool guard: over the pool with this budget, an edit replacing its old amount, paused budgets not counted', () => {
  assert.deepEqual(poolGuard({ assigned: 40_000, poolLimit: 40_000, amount: 1500 }), { assignedAfter: 41_500, over: 1500 });
  assert.equal(poolGuard({ assigned: 36_500, poolLimit: 40_000, amount: 3000 }), null);
  assert.equal(poolGuard({ assigned: 40_000, poolLimit: 40_000, oldLimit: 2000, amount: 2000 }), null, 'unchanged amount');
  assert.equal(poolGuard({ assigned: 40_000, poolLimit: 40_000, amount: 5000, active: false }), null, 'a paused budget is not assigned');
  assert.equal(poolGuard({ assigned: 1e9, poolLimit: 0, amount: 1 }), null, 'no pool set');
});

test('the pool bar from the left: used, assigned not used, free; over the pool when assigned is more', () => {
  const p = poolParts({ pool: { limit: 40_000 }, assigned: 36_500, usedThisPeriod: 18_920 });
  assert.equal(p.unusedAssigned, 17_580);
  assert.equal(p.free, 3500);
  assert.equal(p.over, 0);
  assert.equal(Math.round(p.usedPct + p.assignedPct + p.freePct), 100);
  const over = poolParts({ pool: { limit: 400 }, assigned: 891, usedThisPeriod: 288 });
  assert.equal(over.over, 491);
  assert.equal(over.free, 0);
  assert.equal(over.scale, 891);
});

test('credits over time: 7 days, this period, 90 days, by month; sums per action; a clean axis', () => {
  const days = Array.from({ length: 90 }, (_, i) => new Date(Date.UTC(2026, 6, 27) + i * 86_400_000).toISOString().slice(0, 10));
  const trend = { days, series: { triage: days.map(() => 1), fusion: days.map((_, i) => (i === 89 ? 10 : 0)), custom_thing: days.map(() => 0.5) } };
  const now = Date.parse(`${days[89]}T12:00:00Z`);
  const week = trendRows(trend, '7d', now);
  assert.equal(week.rows.length, 7);
  assert.deepEqual(week.actions, ['triage', 'fusion', 'custom_thing'], 'the known actions first, in their order');
  assert.equal(week.sums.fusion, 10);
  assert.equal(week.rows[6].total, 11.5);
  const period = trendRows(trend, 'period', now);
  assert.ok(period.rows.every((r) => r.key.slice(0, 7) === days[89].slice(0, 7)));
  assert.equal(trendRows(trend, '90d', now).rows.length, 90);
  const months = trendRows(trend, '12m', now);
  assert.equal(months.bucket, 'month');
  assert.equal(months.rows.reduce((n, r) => n + r.values.triage, 0), 90);
  assert.deepEqual(niceScale(1548), { top: 2000, step: 500 });
  assert.deepEqual(niceScale(0), { top: 4, step: 1 });
  const svg = chartSvg(week, 800);
  assert.equal((svg.match(/<g class="col"/g) ?? []).length, 7);
  assert.match(svg, /class="bar-triage"/);
  assert.match(svg, /class="bar-fusion"/);
  assert.match(svg, /class="bar-other"/);
  assert.match(svg, /tabindex="0" role="img" aria-label="[^"]*AI Triage/);
});

test('deliveries per channel in words', () => {
  assert.equal(deliveryText('email', { status: 'sent', attempts: 1 }), 'Email sent');
  assert.equal(deliveryText('webhook', { status: 'failed', attempts: 2 }), 'Webhook failed 2×, retrying');
  assert.equal(deliveryText('webhook', { status: 'pending', attempts: 0 }), 'Webhook waiting');
  assert.equal(deliveryText('direct', { status: 'given_up', attempts: 5 }), 'Email to the requester not delivered');
});

test('exports are what the table shows: its columns in order, every row, cells quoted; HTML escapes names', () => {
  const cols = budgetColumns().filter((c) => ['who', 'budget', 'status', 'mode'].includes(c.id));
  const rows = [budget(), budget({ id: 'b2', entityLabel: 'web, "portal"', entityType: 'project', limit: 4000, status: 'over', mode: 'enforce' })];
  assert.deepEqual(tableRows(rows, cols), [['Applies to', 'Budget', 'Status', 'Mode'], ['Ana Lima · ana@acme.io', 100, 'Within', 'Monitor'], ['web, "portal"', 4000, 'Over', 'Enforce']]);
  assert.equal(tableCsv(rows, cols).split('\n')[2], '"web, ""portal""",4000,Over,Enforce');
  const html = tableReport({ title: 'Govern: budgets', rows: [budget({ entityLabel: '<script>x</script>' })], cols });
  assert.match(html, /<title>Govern: budgets<\/title>/);
  assert.doesNotMatch(html, /<script>x/);
  // Columns without an export (the row's buttons) are left out.
  const restore = restrictionColumns({ canRestore: true });
  assert.equal(restore.at(-1).id, 'act');
  assert.ok(!tableRows([], restore)[0].includes(''));
});

test('requests columns: "Me" for one\'s own, waiting or decided, until the period or a date', () => {
  const cols = requestColumns({ me: 'uma@acme.io' });
  const r = { id: 'r', status: 'open', by: 'uma@acme.io', entityType: 'user', entityId: 'u-uma', entityLabel: 'Uma', amount: 15, until: 'period', reason: 'x', waitingMinutes: 130, createdAt: '2026-10-24T10:00:00Z' };
  const [head, row] = tableRows([r], cols.filter((c) => !c.off));
  assert.deepEqual(head, ['Asked by', 'Status', 'Waiting / decided', 'For', 'Credits', 'Until', 'Why']);
  assert.deepEqual(row, ['uma@acme.io', 'Waiting', 'waiting 2 h', 'Me', 15, 'period', 'x']);
  const approved = tableRows([{ ...r, status: 'approved', approvedAmount: 10, decidedAt: '2026-10-22T10:00:00Z', decidedBy: 'admin@acme.io', by: 'ana@acme.io' }], cols.filter((c) => !c.off))[1];
  assert.match(approved[2], /^10 · .+ · admin$/);
  assert.equal(approved[3], 'Uma');
});

test('the import check: old struck through → new, a create without a before, errors in place', () => {
  assert.equal(changeText({ field: 'amount', before: 3000, after: 3500 }), 'Budget: 3000 → 3500');
  assert.equal(changeText({ field: 'mode', before: null, after: 'monitor' }), 'Mode: monitor');
  assert.equal(changeText({ field: 'exempt', before: true, after: false }), 'Exempt: Yes → No');
  const cols = importColumns({ labelOf: (r) => r.entityId });
  const cell = cols.find((c) => c.id === 'changes').cell;
  assert.match(cell({ line: 4, action: 'update', entityType: 'user', entityId: 'u', changes: [{ field: 'amount', before: 3000, after: 3500 }] }), /<s>3000<\/s> → <ins>3500<\/ins>/);
  assert.doesNotMatch(cell({ line: 2, action: 'create', entityType: 'project', entityId: 'p', changes: [{ field: 'amount', before: null, after: 2500 }] }), /<s>/);
  assert.match(cell({ line: 9, action: 'error', error: 'amount <b>bad</b>' }), /amount &lt;b&gt;bad&lt;\/b&gt;/);
  assert.match(cell({ line: 5, action: 'unchanged', changes: [] }), /Same as now/);
});
