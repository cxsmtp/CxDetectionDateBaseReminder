// Govern (beta): budgets as CSV, losslessly — export then import is the identity; one edited cell is one change.
import test from 'node:test';
import assert from 'node:assert/strict';

import { exportCsv, parseCsv, validateCsv } from '../src/govern/csv.js';
import { cleanBudget, entityKey } from '../src/govern/store.js';

function fixture() {
  const now = new Date('2026-10-01T00:00:00Z');
  const list = [
    cleanBudget({ entityType: 'user', entityId: 'u1', entityLabel: '=Ada', amount: 12.5, notes: "'=leading apostrophe kept\nsecond line, with \"quotes\"  ", countExisting: true, active: false }, null, { now }),
    cleanBudget({ entityType: 'project', entityId: '-p2', amount: 0, period: 'custom', customStart: '2026-10-01', customEnd: '2026-12-01T12:30:00Z', holdUntilReleased: true, mode: 'enforce' }, null, { now, canEnforce: true, actor: 'c' }),
    cleanBudget({ entityType: 'group', entityId: 'g1', amount: 100, includeMembers: true, includeSubgroups: true, warnPct: 55, maxTargets: 3 }, null, { now }),
  ];
  list.forEach((b, i) => (b.version = i + 1));
  const budgets = new Map(list.map((b) => [b.id, b]));
  const exemptions = new Map([[entityKey('group', 'g1'), { entityType: 'group', entityId: 'g1', reason: '+break-glass' }]]);
  return { budgets, exemptions, list };
}

test('export then validate is the identity: every field, formula guard and apostrophes, line breaks, decimals, exemptions', () => {
  const { budgets, exemptions } = fixture();
  const csv = exportCsv(budgets.values(), exemptions);
  assert.match(csv, /'=Ada/, 'formula guard on strings');
  assert.match(csv, /'-p2/);
  const v = validateCsv(csv, { budgets, exemptions, canEnforce: false });
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.summary, { create: 0, update: 0, unchanged: 3, delete: 0, errors: 0 });
  assert.equal(v.plan.length, 0);
});

test('one edited cell is exactly one change, with before and after; the plan hash is stable', () => {
  const { budgets, exemptions } = fixture();
  const rows = parseCsv(exportCsv(budgets.values(), exemptions));
  const header = rows[0];
  const g = rows.findIndex((r) => r[3] === 'g1');
  rows[g][header.indexOf('warn_pct')] = '60';
  const text = rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
  const v = validateCsv(text, { budgets, exemptions });
  assert.equal(v.summary.update, 1);
  assert.deepEqual(v.rows.find((r) => r.action === 'update').changes, [{ field: 'warn_pct', before: 55, after: 60 }]);
  assert.equal(validateCsv(text, { budgets, exemptions }).planHash, v.planHash);
});

test('absent columns leave fields unchanged; unknown headers are refused; versions and permissions are checked', () => {
  const { budgets, exemptions, list } = fixture();
  // Only the columns needed: nothing else changes (no silent reset of enforce, hold, notes…).
  const partial = validateCsv(`entity_type,entity_id,amount\nproject,'-p2,5\n`, { budgets, exemptions });
  assert.deepEqual(partial.rows[0].changes, [{ field: 'amount', before: 0, after: 5 }]);
  assert.throws(() => validateCsv('entity_type,entity_id,enforced\nuser,u1,true\n', { budgets, exemptions }), /Unknown column/);
  const stale = validateCsv(`budget_id,version,entity_type,entity_id,amount\n${list[0].id},99,user,u1,1\n`, { budgets, exemptions });
  assert.match(stale.errors[0].error, /changed since this file was exported/);
  const enforce = validateCsv('entity_type,entity_id,mode\nuser,u1,enforce\n', { budgets, exemptions, canEnforce: false });
  assert.match(enforce.errors[0].error, /Enforce/);
  // An Enforce budget made to restrict more needs govern.enforce too; narrowing it does not.
  const wider = validateCsv(`entity_type,entity_id,max_targets,hold_until_released\nproject,'-p2,10000,true\n`, { budgets, exemptions, canEnforce: false });
  assert.equal(wider.errors[0].error, 'Only someone allowed to enforce budgets can change what an Enforce budget restricts.');
  assert.equal(wider.plan.length, 0);
  assert.equal(validateCsv(`entity_type,entity_id,max_targets\nproject,'-p2,10000\n`, { budgets, exemptions, canEnforce: true }).errors.length, 0);
  assert.deepEqual(validateCsv(`entity_type,entity_id,max_targets,hold_until_released\nproject,'-p2,3,false\n`, { budgets, exemptions, canEnforce: false }).errors, []);
  const create = validateCsv('entity_type,entity_id,amount,exempt,exempt_reason\nproject,p7,3,true,shared\n', { budgets, exemptions, entityExists: (t, id) => id === 'p7' });
  assert.equal(create.summary.create, 1);
  assert.equal(create.plan[0].exempt.reason, 'shared');
  const unknown = validateCsv('entity_type,entity_id,amount\nproject,nope,3\n', { budgets, exemptions, entityExists: () => false });
  assert.match(unknown.errors[0].error, /no project nope/);
  const dup = validateCsv('entity_type,entity_id,amount\nproject,p7,3\nproject,p7,4\n', { budgets, exemptions });
  assert.match(dup.errors[0].error, /more than one row/);
  const del = validateCsv(`entity_type,entity_id,delete\ngroup,g1,true\n`, { budgets, exemptions });
  assert.equal(del.summary.delete, 1);
  assert.throws(() => validateCsv('x'.repeat(1024 * 1024 + 1), { budgets, exemptions }), { status: 413 });
  assert.throws(() => validateCsv('entity_type,entity_id\n"open', { budgets, exemptions }), /quoted/);
});
