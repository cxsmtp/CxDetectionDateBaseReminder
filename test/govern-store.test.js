// Govern (beta): budgets, settings and the files they live in.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_AI_ROLES, GovernStore, cleanBudget, cleanId, cleanSettings, publicSettings, readJsonl, appendDurable, writeAtomic } from '../src/govern/store.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'govern-store-'));

test('a budget is Monitor by default; Enforce needs govern.enforce and records who switched it', () => {
  const b = cleanBudget({ entityType: 'user', entityId: 'u1', amount: '12.5' }, null, { actor: 'a@acme.io' });
  assert.equal(b.mode, 'monitor');
  assert.equal(b.amount, 12.5, 'decimals allowed');
  assert.equal(b.warnPct, 80);
  assert.throws(() => cleanBudget({ mode: 'enforce' }, b, { actor: 'x@acme.io', canEnforce: false }), { status: 403 });
  const e = cleanBudget({ mode: 'enforce' }, b, { actor: 'c@acme.io', canEnforce: true });
  assert.equal(e.enforcedBy.by, 'c@acme.io');
  // Someone without govern.enforce may still change the amount of an enforcing budget, and may switch it off.
  assert.equal(cleanBudget({ amount: 20 }, e, { canEnforce: false }).mode, 'enforce');
  assert.equal(cleanBudget({ mode: 'monitor' }, e, { canEnforce: false }).enforcedBy, null);
});

test('budgets are checked and bounded', () => {
  assert.throws(() => cleanBudget({ entityType: 'tenant', entityId: 'x', amount: 1 }), { status: 400 });
  assert.throws(() => cleanBudget({ entityType: 'user', entityId: '__proto__', amount: 1 }), { status: 400 });
  assert.throws(() => cleanBudget({ entityType: 'user', entityId: 'u', amount: -1 }), { status: 400 });
  assert.throws(() => cleanBudget({ entityType: 'user', entityId: 'u', amount: 1e9 }), { status: 400 });
  assert.throws(() => cleanBudget({ entityType: 'user', entityId: 'u' }), /amount/);
  assert.throws(() => cleanBudget({ entityType: 'user', entityId: 'u', amount: 1, period: 'custom' }), /start/);
  assert.throws(() => cleanBudget({ entityType: 'user', entityId: 'u', amount: 1, period: 'custom', customStart: '2026-02-01', customEnd: '2026-01-01' }), /after/);
  assert.throws(() => cleanBudget({ entityType: 'user', entityId: 'u', amount: 1, warnPct: 0 }), { status: 400 });
  const g = cleanBudget({ entityType: 'project', entityId: 'p', amount: 1, includeMembers: true });
  assert.equal(g.includeMembers, false, 'members count only for groups');
  assert.equal(cleanBudget({ entityType: 'user', entityId: 'u', amount: 1, notes: '  keep  ' }).notes, '  keep  ', 'free text never trimmed');
  assert.equal(cleanId('a'.repeat(200)), 'a'.repeat(200));
  assert.throws(() => cleanId('a'.repeat(201)));
});

test('settings: bounded choices, https webhooks through the check, the secret write-only', () => {
  const s = cleanSettings({ cycleMinutes: 5, window: 'last_90_days', notify: { webhook: { url: 'https://hooks.acme.io/x', secret: 's3cret', on: true } } }, undefined, { checkUrl: (u) => u });
  assert.equal(s.cycleMinutes, 5);
  assert.deepEqual(s.aiRoles, DEFAULT_AI_ROLES);
  assert.throws(() => cleanSettings({ cycleMinutes: 7 }), { status: 400 });
  assert.throws(() => cleanSettings({ window: 'last_week' }), { status: 400 });
  assert.throws(() => cleanSettings({ aiRoles: ['bad role!'] }), { status: 400 });
  assert.throws(() => cleanSettings({ notify: { webhook: { on: true } } }), /address/);
  assert.throws(() => cleanSettings({ notify: { webhook: { url: 'https://x' } } }, undefined, { checkUrl: () => { throw Object.assign(new Error('no'), { status: 400 }); } }), { status: 400 });
  // Absent or null keeps the secret, '' clears it.
  assert.equal(cleanSettings({ notify: { webhook: { secret: null } } }, s).notify.webhook.secret, 's3cret');
  assert.equal(cleanSettings({ notify: { webhook: {} } }, s).notify.webhook.secret, 's3cret');
  assert.equal(cleanSettings({ notify: { webhook: { secret: '' } } }, s).notify.webhook.secret, '');
  const shown = publicSettings(s);
  assert.equal(shown.notify.webhook.secretSet, true);
  assert.ok(!JSON.stringify(shown).includes('s3cret'));
  assert.throws(() => cleanSettings({ notify: { email: { recipients: ['not an address'] } } }), { status: 400 });
});

test('files are written atomically with mode 0600, and a torn JSON Lines tail is skipped', () => {
  const d = dir();
  const file = path.join(d, 'a', 'x.json');
  writeAtomic(file, '{"a":1}');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['x.json'], 'no temporary file left');
  const log = path.join(d, 'l.jsonl');
  appendDurable(log, JSON.stringify({ a: 1 }));
  fs.appendFileSync(log, '{"a":');
  assert.deepEqual(readJsonl(log), [{ a: 1 }]);
});

test('the store keeps budgets, exemptions, periods, decisions, requests and settings across a restart', () => {
  const d = dir();
  const s = new GovernStore({ dir: d });
  const b = cleanBudget({ entityType: 'project', entityId: 'p1', amount: 3 });
  s.budgets.set(b.id, b);
  s.exemptions.set('user:u1', { entityType: 'user', entityId: 'u1', reason: 'break-glass' });
  s.saveBudgets();
  s.periods.set(`${b.id}|2026-10`, { budgetId: b.id, periodKey: '2026-10', used: 1 });
  s.savePeriods();
  s.settings = cleanSettings({ notify: { webhook: { url: 'https://h.acme.io', secret: 'k' } } }, s.settings);
  s.saveSettings();
  const again = new GovernStore({ dir: d });
  assert.equal(again.budgets.get(b.id).amount, 3);
  assert.ok(again.isExempt('user', 'u1'));
  assert.equal(again.budgetFor('project', 'p1').id, b.id);
  assert.equal(again.periods.get(`${b.id}|2026-10`).used, 1);
  assert.equal(again.settings.notify.webhook.secret, 'k', 'the secret is kept on disk (0600), only never shown');
  assert.ok(again.dataVersion >= 1);
});
