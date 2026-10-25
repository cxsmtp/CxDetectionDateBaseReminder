// Govern (beta): evaluating budgets (pure), the usage index, and what a breach restricts.
import test from 'node:test';
import assert from 'node:assert/strict';

import { effectiveAmount, evaluateBudget, periodWindow, planTargets } from '../src/govern/evaluate.js';
import { UsageSeries } from '../src/govern/ingest.js';
import { UsageIndex } from '../src/govern/usage-index.js';
import { cleanBudget } from '../src/govern/store.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 24, 12);

/** An index with one user's and some projects' usage: `credits` spent evenly over the 30 days before NOW. */
function indexWith({ user = 0, projects = {}, stale = false, supported = {} } = {}) {
  const series = {};
  const attribution = {};
  for (const [dim, rows] of [['user', { 'ada@acme.io': user }], ['project', projects]]) {
    const s = new UsageSeries({});
    s.add({ at: NOW - DAY, window: 'last_30_days', rows: new Map(Object.entries(rows).map(([k, v]) => [k, { key: k, credits: v, name: k, email: '', id: k }])) });
    series[dim] = s;
    attribution[dim] = new Map(Object.keys(rows).map((k) => [k, dim === 'user' ? 'u1' : k]));
  }
  const org = {
    users: new Map([['u1', { id: 'u1', email: 'ada@acme.io', username: 'ada', firstName: 'Ada', lastName: 'L', groups: ['/eng'] }]]),
    groups: new Map([['g1', { id: 'g1', name: 'eng', path: '/eng' }], ['g2', { id: 'g2', name: 'web', path: '/eng/web' }]]),
    projects: new Map([['p1', { id: 'p1', name: 'P1', groups: ['g1'], repoId: '7' }], ['p2', { id: 'p2', name: 'P2', groups: ['g2'], repoId: '' }]]),
    applications: new Map([['a1', { id: 'a1', name: 'App', projectIds: ['p1', 'p2'] }]]),
  };
  const dims = { user: { supported: true, stale }, project: { supported: true }, group: { supported: false }, application: { supported: supported.application ?? false }, action: { supported: true } };
  return new UsageIndex({ at: NOW, series, org, attribution, dims });
}
const ctx = (index, exempt = new Set()) => ({ index, isExempt: (t, id) => exempt.has(`${t}:${id}`), graceGrowBy: 1 });
const budget = (over = {}) => ({ ...cleanBudget({ entityType: 'user', entityId: 'u1', amount: 10, countExisting: true, ...over }, null, { canEnforce: true, actor: 'c@acme.io', now: new Date(NOW - 40 * DAY) }) });

test('periods: monthly, quarterly, custom (from its own start), lifetime (from creation)', () => {
  assert.deepEqual(periodWindow({ period: 'monthly' }, NOW), { key: '2026-10', start: Date.UTC(2026, 9, 1), end: Date.UTC(2026, 10, 1), open: true });
  assert.equal(periodWindow({ period: 'quarterly' }, NOW).key, '2026-Q4');
  const c = periodWindow({ period: 'custom', customStart: '2026-10-20', customEnd: null }, NOW);
  assert.equal(c.key, 'custom:20261020:open');
  assert.equal(periodWindow({ period: 'custom', customStart: '2026-11-01' }, NOW).open, false);
  assert.equal(periodWindow({ period: 'lifetime', createdAt: '2026-01-01T00:00:00Z' }, NOW).start, Date.UTC(2026, 0, 1));
  assert.ok(periodWindow({ period: 'custom', customStart: 'nope' }, NOW).error);
  assert.equal(effectiveAmount({ amount: 10, topUps: [{ amount: 5, until: new Date(NOW + DAY).toISOString() }, { amount: 99, until: new Date(NOW - DAY).toISOString() }] }, NOW), 15);
});

test('within, near once per period, over (breach once), and Monitor never holds', () => {
  const near = evaluateBudget(budget({ amount: 30, warnPct: 50 }), null, ctx(indexWith({ user: 20 })), NOW);
  assert.equal(near.state.status, 'near');
  assert.equal(near.notices[0].kind, 'warning');
  const again = evaluateBudget(budget({ amount: 30, warnPct: 50 }), near.state, ctx(indexWith({ user: 20 })), NOW + 1000);
  assert.equal(again.notices.length, 0, 'warned once per period');
  const over = evaluateBudget(budget(), null, ctx(indexWith({ user: 20 })), NOW);
  assert.equal(over.state.status, 'over');
  assert.equal(over.hold, false, 'Monitor: nothing restricted');
  assert.equal(over.releaseReason, 'limit_removed');
  assert.equal(over.notices.find((n) => n.kind === 'breach').severity, 'warning');
  const enforce = evaluateBudget(budget({ mode: 'enforce' }), null, ctx(indexWith({ user: 20 })), NOW);
  assert.equal(enforce.hold, true);
  assert.equal(enforce.notices.find((n) => n.kind === 'breach').severity, 'critical');
  assert.equal(enforce.state.breachSeq, 1);
});

test('exempt entities are warned, never held; usage not reported or stale is never held or released (B10)', () => {
  const ex = evaluateBudget(budget({ mode: 'enforce' }), null, ctx(indexWith({ user: 20 }), new Set(['user:u1'])), NOW);
  assert.equal(ex.state.status, 'exempt');
  assert.equal(ex.hold, false);
  assert.equal(ex.releaseReason, 'exempted');
  const stale = evaluateBudget(budget({ mode: 'enforce' }), null, ctx(indexWith({ user: 20, stale: true })), NOW);
  assert.equal(stale.hold, null);
  assert.equal(stale.state.stale, true);
  const group = evaluateBudget(budget({ entityType: 'group', entityId: 'g1', mode: 'enforce' }), null, ctx(new UsageIndex({})), NOW);
  assert.equal(group.state.status, 'not_reported');
  assert.equal(group.hold, null, 'unknown is never 0');
});

test('re-breach: an automatic release never blocks a new hold; an admin grace lasts until usage grows', () => {
  const b = budget({ mode: 'enforce' });
  const first = evaluateBudget(b, null, ctx(indexWith({ user: 20 })), NOW);
  // Credits raised: back under, released (credit_increased).
  const raised = { ...b, topUps: [{ amount: 50 }] };
  const under = evaluateBudget(raised, first.state, ctx(indexWith({ user: 20 })), NOW + 1000);
  assert.equal(under.hold, false);
  assert.equal(under.releaseReason, 'credit_increased');
  assert.equal(under.notices[0].kind, 'recovered');
  // Usage grows past the raised limit in the same period: a new breach, a new hold (B4).
  const rebreach = evaluateBudget(raised, under.state, ctx(indexWith({ user: 80 })), NOW + 2000);
  assert.equal(rebreach.hold, true);
  assert.equal(rebreach.state.breachSeq, 2);
  // An admin restore: grace while usage stays put.
  const graced = { ...rebreach.state, grace: { until: null, usageAtRestore: rebreach.state.used, growBy: 1 } };
  const held = evaluateBudget(raised, graced, ctx(indexWith({ user: 80 })), NOW + 3000);
  assert.equal(held.hold, false);
  assert.equal(held.releaseReason, 'admin');
  assert.ok(held.state.grace);
  const grown = evaluateBudget(raised, graced, ctx(indexWith({ user: 90 })), NOW + 4000);
  assert.equal(grown.hold, true, 'the grace ends once usage grows');
  assert.equal(grown.state.grace, null);
});

test('a budget that cannot be evaluated is one alert, never an exception for the others (B13)', () => {
  const broken = { ...budget(), period: 'custom', customStart: 'x' };
  const r = evaluateBudget(broken, null, ctx(indexWith()), NOW);
  assert.equal(r.notices[0].kind, 'misconfigured');
  const bad = evaluateBudget(budget(), null, { index: { usage: () => { throw new Error('boom'); } }, isExempt: () => false }, NOW);
  assert.equal(bad.hold, null);
  assert.equal(bad.notices[0].kind, 'error');
});

test('usage index: applications and groups not reported are their projects summed; subgroups and members on request', () => {
  const index = indexWith({ user: 6, projects: { p1: 9, p2: 3 } });
  // Only part of the seed falls in the last 10 days.
  assert.equal(index.usage('project', 'p1', { from: NOW - 11 * DAY }).used, 3);
  const all = (t, id, o = {}) => index.usage(t, id, { from: -Infinity, ...o });
  assert.equal(all('project', 'p1').used, 9);
  assert.equal(all('application', 'a1').used, 12);
  assert.equal(all('application', 'a1').source, 'projects');
  assert.equal(all('group', 'g1').used, 9);
  assert.equal(all('group', 'g1', { includeSubgroups: true }).used, 12);
  assert.equal(all('group', 'g1', { includeMembers: true }).used, 15, 'projects plus the members');
  assert.equal(all('user', 'nobody').used, 0, 'absent from a complete poll is 0');
  assert.equal(all('user', 'u1').estimated, true, 'from the seed: an estimate');
  assert.deepEqual(index.projectsOf('group', 'g1', { includeSubgroups: true }).sort(), ['p1', 'p2']);
});

test('a breach restricts: a user loses the AI roles; each project its Auto Triage, and PR remediation when it has a repository; exempt projects skipped', () => {
  const index = indexWith();
  assert.deepEqual(planTargets(budget(), index, () => false).map((t) => t.kind), ['user_roles']);
  const app = planTargets({ ...budget(), entityType: 'application', entityId: 'a1' }, index, (t, id) => id === 'p2');
  assert.deepEqual(app.map((t) => `${t.kind}|${t.targetId}`), ['auto_triage|p1', 'pr_remediation|p1']);
});
