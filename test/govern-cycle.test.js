// Govern (beta): one tenant's cycle — its own Checkmarx One budget, one run at a time, complete polls only, and
// MZ's own spend refused for a scope whose Enforce budget is used up.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GovernService, governClient } from '../src/govern/cycle.js';
import { CreditLedger } from '../src/credits.js';
import { cleanBudget } from '../src/govern/store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake tenant: two users, two projects, consumption for every view (group falls back to the user view). */
function fakeClient({ failUserPage = false, delay = 0 } = {}) {
  const calls = [];
  const users = [{ name: 'Ada', userEmail: 'ada@acme.io', creditsUsed: 40 }, { name: 'bob@acme.io', creditsUsed: 2 }];
  const views = { user: users, project: [{ projectId: 'p1', name: 'P1', creditsUsed: 30 }, { projectId: 'p2', name: 'P2', creditsUsed: 1 }], action: [{ actionType: 'Triage', creditsUsed: 42, transactionCount: 42 }], application: [] };
  return {
    calls,
    async request(p, { query = {}, background } = {}) {
      calls.push({ p, query, background });
      if (delay) await sleep(delay);
      if (p.endsWith('/users/v2')) return { users: [{ id: 'u1', username: 'ada', email: 'ada@acme.io' }, { id: 'u2', username: 'bob', email: 'bob@acme.io' }], filteredCount: 2 };
      if (p.endsWith('/groups')) return [];
      if (p === '/api/projects') return { projects: [{ id: 'p1', name: 'P1', groups: [] }, { id: 'p2', name: 'P2', groups: [] }], totalCount: 2 };
      if (p === '/api/applications') return { applications: [], totalCount: 0 };
      if (p === '/api/credits/info') return { available: '100', total: '200', used: '100' };
      if (p === '/api/credits/consumption') {
        const rows = views[query.viewBy] ?? views.user;
        if (failUserPage && query.viewBy === 'user') throw Object.assign(new Error('503'), { status: 503 });
        return { items: rows.slice((query.page - 1) * query.size, query.page * query.size), totalItems: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / query.size)), currentPage: query.page };
      }
      throw Object.assign(new Error(`404 ${p}`), { status: 404 });
    },
  };
}

function service(client, { audits = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'govern-cycle-'));
  return new GovernService({ dir, clientOf: () => client, connectionOf: () => ({ iamUrl: 'https://iam.acme.io', tenant: 'acme' }), audit: (e) => audits.push(e), sendMail: async () => {} });
}

test("Govern's own Checkmarx One budget: at most 4 calls at once, at most `rate` a second, at background priority", async () => {
  let active = 0;
  let peak = 0;
  const seen = [];
  const client = {
    async request(p, o) {
      seen.push(o.background);
      active += 1;
      peak = Math.max(peak, active);
      await sleep(20);
      active -= 1;
      return null;
    },
  };
  const cx = governClient(client, { concurrency: 4, rate: 50 });
  const started = Date.now();
  await Promise.all(Array.from({ length: 12 }, () => cx.request('/x')));
  assert.ok(peak <= 4, `peak ${peak}`);
  assert.ok(Date.now() - started >= 200, 'spaced by the rate');
  assert.ok(seen.every((b) => b === true));
  assert.equal(cx.stats.calls, 12);
});

test('one cycle at a time per tenant: Run now answers at once with the running run; no client means skipped', async () => {
  const svc = service(fakeClient({ delay: 5 }));
  const first = svc.runNow({ trigger: 'manual', by: 'a' });
  const second = svc.runNow({ trigger: 'manual', by: 'b' });
  assert.equal(first.started, true);
  assert.deepEqual([second.started, second.runId], [false, first.runId]);
  assert.equal(svc.running, true);
  await svc.settled();
  const run = svc.run(first.runId);
  assert.equal(run.status, 'success', JSON.stringify(run));
  assert.equal(run.steps.consumption.group.supported, false);
  assert.ok(run.steps.calls > 0);
  const none = service(null);
  none.runNow({ trigger: 'schedule' });
  await none.settled();
  assert.equal(none.runs()[0].status, 'skipped');
});

test('a dimension that fails stays at its last complete poll and is stale; budgets on it neither hold nor release', async () => {
  const client = fakeClient();
  const svc = service(client);
  svc.runNow();
  await svc.settled();
  const b = { ...cleanBudget({ entityType: 'user', entityId: 'u1', amount: 10, countExisting: true, mode: 'enforce' }, null, { canEnforce: true, actor: 'c' }), version: 1 };
  svc.store.budgets.set(b.id, b);
  svc.store.saveBudgets();
  svc.changed();
  await svc.settled();
  // Held (the fake tenant has no IAM to change, so the restriction itself fails and is retried).
  assert.ok(['restricting', 'partial', 'restricted'].includes(svc.view.budgets[0].status), svc.view.budgets[0].status);
  const refsBefore = [...svc.holds.targets.values()].map((r) => Object.keys(r.refs));
  const failing = fakeClient({ failUserPage: true });
  client.request = (...a) => failing.request(...a);
  svc.runNow();
  await svc.settled();
  assert.equal(svc.runs()[0].status, 'partial');
  assert.equal(svc.view.budgets[0].stale, true);
  assert.deepEqual([...svc.holds.targets.values()].map((r) => Object.keys(r.refs)), refsBefore, 'no hold made or released on a stale dimension');
  assert.equal(svc.view.overview.banners.stale.includes('user'), true);
});

test("MZ's own spend is refused for a project or person whose Enforce budget is used up — not for Monitor, not in a grace", async () => {
  const audits = [];
  const svc = service(fakeClient(), { audits });
  svc.runNow();
  await svc.settled();
  const add = (o) => {
    const b = { ...cleanBudget(o, null, { canEnforce: true, actor: 'c' }), version: 1 };
    svc.store.budgets.set(b.id, b);
    return b;
  };
  add({ entityType: 'project', entityId: 'p1', amount: 5, countExisting: true, mode: 'enforce' });
  add({ entityType: 'project', entityId: 'p2', amount: 0.5, countExisting: true });
  const user = add({ entityType: 'user', entityId: 'u1', amount: 1, countExisting: true, mode: 'enforce' });
  svc.store.saveBudgets();
  svc.changed();
  assert.match(svc.spendRefusal({ projectId: 'p1' }), /project budget for P1 is used up/);
  assert.equal(svc.spendRefusal({ projectId: 'p2' }), '', 'Monitor never refuses');
  assert.match(svc.spendRefusal({ requester: 'ADA@acme.io' }), /user budget/);
  assert.equal(svc.spendRefusal({ requester: 'bob@acme.io' }), '');
  // Through the ledger, as server.js wires it.
  const ledger = new CreditLedger({ file: path.join(svc.dir, 'ledger.json'), writeDelayMs: 0 });
  ledger.setSpendGuard((q) => svc.spendRefusal(q));
  assert.equal(ledger.reserve(1, 0, new Date(), { projectId: 'p1' }), null);
  assert.match(ledger.lastRefusal, /used up/);
  assert.ok(ledger.reserve(1, 0, new Date(), { projectId: 'p2' }));
  assert.equal(ledger.lastRefusal, '');
  assert.equal(ledger.reserve(1, 0, new Date(), { forProject: 'p1' }), null, 'a reservation not counted per project is checked too');
  // An admin restore of the user's roles gives a grace: MZ may spend again.
  await svc.settled();
  svc.restore(['user_roles|u1'], { by: 'champ@acme.io', actor: {} });
  assert.equal(svc.spendRefusal({ requester: 'ada@acme.io' }), '');
  assert.ok(audits.some((a) => a.type === 'govern' && a.details.govern.event === 'restore'));
  assert.ok(svc.store.periods.get(`${user.id}|${new Date().toISOString().slice(0, 7)}`).grace);
  await svc.settled();
});

test('diagnose a figure walks org, dimension, attribution and period', async () => {
  const svc = service(fakeClient());
  svc.runNow();
  await svc.settled();
  const d = svc.diagnose('user', 'u1');
  assert.equal(d.steps[0].ok, true);
  assert.equal(d.steps[2].ok, true);
  assert.equal(svc.diagnose('user', 'nobody').verdict, 'not_in_org');
});

test('scheduled: the first cycle soon after start, then every interval (jittered), never while one runs; 0 is off', async () => {
  const svc = service(fakeClient());
  const t0 = Date.now();
  assert.equal(svc.tick(t0 - 1), null, 'not due yet');
  const first = svc.tick(t0 + 61_000);
  assert.equal(first.started, true, 'due within a minute of start, and stays due');
  assert.equal(svc.tick(t0 + 62_000), null, 'never two at once');
  await svc.settled();
  assert.ok(svc.nextRunAt >= Date.parse(svc.runs()[0].startedAt) + 14 * 60_000, 'next one an interval later');
  assert.equal(svc.tick(Date.now() + 60_000), null);
  svc.store.settings.cycleMinutes = 0;
  assert.equal(svc.tick(Date.now() + 86_400_000), null, 'off');
});
