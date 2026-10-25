// Govern (beta): holds per target — reference counted, written ahead, verified, put back exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CxOps, HoldStore, enforce, reconcileRefs, refKeyOf, targetKeyOf } from '../src/govern/enforce.js';
import { DEFAULT_SETTINGS } from '../src/govern/store.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'govern-holds-'));
const settings = (o = {}) => ({ ...DEFAULT_SETTINGS, driftEveryCycles: 0, ...o });
const IAM = 'https://iam.acme.io/auth/admin/realms/acme';

/** A tiny Checkmarx One: users' direct roles, group roles, Auto Triage configurations, PR severities. Records every call. */
function tenant() {
  const direct = new Map([['u1', new Set(['view-risk-management', 'view-scans'])], ['u2', new Set(['view-risk-management'])]]);
  const members = new Map([['u2', new Set(['g1'])]]);
  const groupRoles = new Map([['g1', ['view-risk-management-tab']]]);
  const config = new Map([['p1', { scope: 'project', projectId: 'p1', configurations: [{ feature: 'auto_triage', enabled: true, config: { branches: ['main'] }, allowOverride: { x: true } }, { feature: 'other', enabled: true }] }]]);
  const pr = new Map([['7|p1', ['HIGH']]]);
  const calls = [];
  let failWrites = 0;
  const ref = (n) => ({ id: `r-${n}`, name: n });
  const request = async (p, { method = 'GET', body, query = {} } = {}) => {
    calls.push(`${method} ${p.replace(IAM, '')}`);
    if (method !== 'GET' && failWrites > 0) {
      failWrites -= 1;
      throw Object.assign(new Error(`${method} failed: 503`), { status: 503 });
    }
    let m;
    if (p === `${IAM}/clients`) return [{ id: 'uuid', clientId: 'ast-app' }];
    if ((m = p.match(/\/users\/(\w+)\/role-mappings\/clients\/uuid(\/composite)?$/))) {
      const set = direct.get(m[1]) ?? new Set();
      if (method === 'GET') return [...(m[2] ? new Set([...set, ...[...(members.get(m[1]) ?? [])].flatMap((g) => groupRoles.get(g) ?? [])]) : set)].map(ref);
      if (method === 'DELETE') body.forEach((r) => set.delete(r.name));
      if (method === 'POST') body.forEach((r) => set.add(r.name));
      direct.set(m[1], set);
      return null;
    }
    if ((m = p.match(/\/users\/(\w+)\/groups$/))) return [...(members.get(m[1]) ?? [])].map((id) => ({ id, path: `/${id}` }));
    if ((m = p.match(/\/users\/(\w+)\/groups\/(\w+)$/))) {
      const set = members.get(m[1]) ?? new Set();
      if (method === 'DELETE') set.delete(m[2]);
      else set.add(m[2]);
      members.set(m[1], set);
      return null;
    }
    if ((m = p.match(/\/groups\/(\w+)\/role-mappings\/clients\/uuid\/composite$/))) return (groupRoles.get(m[1]) ?? []).map(ref);
    if ((m = p.match(/^\/api\/ai-agents-coordinator\/projects\/(\w+)\/configuration$/))) {
      if (method === 'PUT') config.set(m[1], JSON.parse(JSON.stringify(body)));
      return JSON.parse(JSON.stringify(config.get(m[1]) ?? { weird: true }));
    }
    if ((m = p.match(/^\/api\/repos-manager\/repo\/(\w+)$/))) {
      const key = `${m[1]}|${query.projectId}`;
      if (method === 'PATCH') pr.set(key, body.remediationSeverities);
      if (!pr.has(key)) throw Object.assign(new Error('404'), { status: 404 });
      return { remediationSeverities: pr.get(key) };
    }
    throw Object.assign(new Error(`unexpected ${method} ${p}`), { status: 404 });
  };
  return { cx: { request }, direct, members, config, pr, calls, failNextWrites: (n) => (failWrites = n) };
}
const ops = (t) => new CxOps(t.cx, { iamUrl: 'https://iam.acme.io', tenant: 'acme' });
const want = (budgetId, kind, targetId, extra = {}) => [refKeyOf(budgetId, '2026-10', 1, kind, targetId), { budgetId, periodKey: '2026-10', seq: 1, kind, targetId, type: kind === 'user_roles' ? 'user' : 'project', label: targetId, ...extra }];

test('user roles: the direct AI roles removed and put back; view-scans untouched by default', async () => {
  const t = tenant();
  const store = new HoldStore({ dir: dir() });
  reconcileRefs(store, new Map([want('b1', 'user_roles', 'u1')]));
  const events = await enforce(store, ops(t), settings());
  assert.deepEqual(events.map((e) => e.event), ['applied']);
  assert.deepEqual([...t.direct.get('u1')], ['view-scans']);
  assert.deepEqual(store.targets.get('user_roles|u1').preState.directRemoved, [{ id: 'r-view-risk-management', name: 'view-risk-management' }]);
  reconcileRefs(store, new Map(), { reasons: new Map([['b1', 'credit_increased']]) });
  const back = await enforce(store, ops(t), settings());
  assert.deepEqual(back.map((e) => e.event), ['released']);
  assert.deepEqual([...t.direct.get('u1')].sort(), ['view-risk-management', 'view-scans']);
  assert.equal(store.targets.size, 0);
});

test('an AI role from a group: partial, naming the group; with the group marked AI-only, the user leaves it and rejoins on release', async () => {
  const t = tenant();
  const store = new HoldStore({ dir: dir() });
  reconcileRefs(store, new Map([want('b1', 'user_roles', 'u2')]));
  const [e] = await enforce(store, ops(t), settings());
  assert.equal(e.event, 'partial', 'never "restricted" while /composite still shows an AI role (B7)');
  assert.match(e.record.partial.join(' '), /Group \/g1 grants view-risk-management-tab/);
  const t2 = tenant();
  const s2 = new HoldStore({ dir: dir() });
  reconcileRefs(s2, new Map([want('b1', 'user_roles', 'u2')]));
  const [ok] = await enforce(s2, ops(t2), settings({ aiOnlyGroups: ['g1'] }));
  assert.equal(ok.event, 'applied');
  assert.equal(t2.members.get('u2').size, 0);
  reconcileRefs(s2, new Map());
  await enforce(s2, ops(t2), settings({ aiOnlyGroups: ['g1'] }));
  assert.deepEqual([...t2.members.get('u2')], ['g1'], 'membership restored');
});

test('reference counted: two budgets on one project — the first hold captures, the last release restores (B15)', async () => {
  const t = tenant();
  const store = new HoldStore({ dir: dir() });
  reconcileRefs(store, new Map([want('app', 'auto_triage', 'p1'), want('proj', 'auto_triage', 'p1')]));
  await enforce(store, ops(t), settings());
  const cfg = t.config.get('p1');
  assert.equal(cfg.configurations[0].enabled, false);
  assert.deepEqual(cfg.configurations[0].allowOverride, { x: true }, 'everything else written back as read (B19)');
  assert.equal(cfg.configurations[1].enabled, true);
  assert.equal(cfg.scope, 'project');
  // One budget releases: the project stays restricted.
  reconcileRefs(store, new Map([want('proj', 'auto_triage', 'p1')]));
  await enforce(store, ops(t), settings());
  assert.equal(t.config.get('p1').configurations[0].enabled, false);
  reconcileRefs(store, new Map());
  await enforce(store, ops(t), settings());
  assert.equal(t.config.get('p1').configurations[0].enabled, true, 'back on after the last release');
});

test('PR remediation: put back exactly; an unreadable setting is left on (no exact undo) unless allowed, then restoreMode default', async () => {
  const t = tenant();
  const store = new HoldStore({ dir: dir() });
  reconcileRefs(store, new Map([want('b', 'pr_remediation', 'p1', { repoId: '7' }), want('b', 'pr_remediation', 'p9', { repoId: '9' })]));
  const events = await enforce(store, ops(t), settings());
  assert.deepEqual(events.map((e) => e.event).sort(), ['applied', 'skipped']);
  assert.deepEqual(t.pr.get('7|p1'), []);
  const allowed = new HoldStore({ dir: dir() });
  reconcileRefs(allowed, new Map([want('b', 'pr_remediation', 'p9', { repoId: '9' })]));
  t.pr.set('9|p9', ['LOW']);
  const realRequest = t.cx.request;
  let readFails = 1;
  t.cx.request = async (p, o = {}) => {
    if (p.includes('/repos-manager/') && (o.method ?? 'GET') === 'GET' && readFails-- > 0) throw Object.assign(new Error('500'), { status: 500 });
    return realRequest(p, o);
  };
  await enforce(allowed, ops(t), settings({ prDisableUnreadable: true }));
  assert.equal(allowed.targets.get('pr_remediation|p9').preState.restoreMode, 'default');
  reconcileRefs(store, new Map());
  await enforce(store, ops(t), settings());
  assert.deepEqual(t.pr.get('7|p1'), ['HIGH'], 'exactly what was there');
});

test('an unknown Auto Triage shape is refused, never invented; failed writes are not retried blindly and alert as failed', async () => {
  const t = tenant();
  const store = new HoldStore({ dir: dir() });
  reconcileRefs(store, new Map([want('b', 'auto_triage', 'p404'), want('b', 'user_roles', 'u1')]));
  t.failNextWrites(1);
  const events = await enforce(store, ops(t), settings(), { concurrency: 1 });
  assert.equal(events.find((e) => e.record.targetId === 'p404').event, 'failed');
  assert.equal(events.find((e) => e.record.targetId === 'u1').event, 'failed');
  assert.equal(t.calls.filter((c) => c.startsWith('DELETE')).length, 1, 'the failed write was sent once (retries: 0)');
  assert.equal(t.calls.filter((c) => c.startsWith('PUT')).length, 0, 'nothing written for the unknown shape');
  // Next cycle: the user's hold is applied, with the snapshot taken the first time.
  const again = await enforce(store, ops(t), settings());
  assert.equal(again.find((e) => e.record.targetId === 'u1').event, 'applied');
});

test('write-ahead: a crash after "writing" leaves the undo record on disk; recovery keeps the first snapshot', async () => {
  const d = dir();
  const t = tenant();
  const store = new HoldStore({ dir: d });
  reconcileRefs(store, new Map([want('b1', 'user_roles', 'u1')]));
  // The write happens but the process dies before recording "applied": simulate by failing after the write.
  const real = t.cx.request;
  let crashed = false;
  t.cx.request = async (p, o = {}) => {
    const r = await real(p, o);
    if (o.method === 'DELETE' && !crashed) {
      crashed = true;
      throw new Error('process killed');
    }
    return r;
  };
  await enforce(store, ops(t), settings());
  const lines = fs.readFileSync(path.join(d, 'holds.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.state === 'writing' && l.preState.directRemoved.length === 1), 'the undo record was on disk before the write');
  // Restart: the new store reads the file; recovery re-reads Checkmarx One and keeps the original snapshot.
  const reopened = new HoldStore({ dir: d });
  t.cx.request = real;
  const events = await enforce(reopened, ops(t), settings());
  assert.equal(events[0].event, 'applied');
  assert.equal(reopened.targets.get('user_roles|u1').preState.directRemoved[0].name, 'view-risk-management');
  reconcileRefs(reopened, new Map());
  await enforce(reopened, ops(t), settings());
  assert.ok(t.direct.get('u1').has('view-risk-management'), 'the undo still works');
});

test('drift: an applied restriction undone in Checkmarx One is restricted again, reported once a day', async () => {
  const t = tenant();
  const store = new HoldStore({ dir: dir() });
  reconcileRefs(store, new Map([want('b1', 'user_roles', 'u1')]));
  await enforce(store, ops(t), settings());
  t.direct.get('u1').add('view-risk-management');
  const r = store.targets.get('user_roles|u1');
  store.put({ ...r, lastVerifiedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
  const events = await enforce(store, ops(t), settings({ driftEveryCycles: 1 }), { cycle: 4 });
  assert.equal(events[0].event, 'drift');
  assert.equal(events[0].firstToday, true);
  assert.ok(!t.direct.get('u1').has('view-risk-management'));
  assert.equal(targetKeyOf('user_roles', 'u1'), 'user_roles|u1');
  assert.equal(store.targets.get('user_roles|u1').preState.directRemoved[0].name, 'view-risk-management', 'the snapshot from before the first hold');
});

test('an admin release while a write is under way is put back as soon as the write ends', async () => {
  const t = tenant();
  const store = new HoldStore({ dir: dir() });
  reconcileRefs(store, new Map([want('b1', 'user_roles', 'u1')]));
  const real = t.cx.request;
  t.cx.request = async (p, o = {}) => {
    if (o.method === 'DELETE') store.releaseAll('user_roles|u1', 'admin', 'champ@acme.io');
    return real(p, o);
  };
  const events = await enforce(store, ops(t), settings());
  assert.deepEqual(events.map((e) => e.event), ['applied', 'released']);
  assert.ok(t.direct.get('u1').has('view-risk-management'));
});
