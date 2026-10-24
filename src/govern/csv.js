/**
 * Govern (beta): budgets as CSV, losslessly (SPEC §6.4, B9).
 *
 * Export writes every field of every budget, its version, and its entity's exemption; export-only context
 * (used, period_key, status) is ignored on import. Import is two steps: validate gives a per-row diff
 * (field: before → after; create / update / unchanged / delete) and a planHash; apply must present the same
 * planHash and is refused when anything it touches changed since (the versions are part of the hash). Applying
 * only writes budgets: restrictions follow in the next evaluation, never inside the request (B32).
 *
 * Rules: header names are trimmed and case-insensitive, an unknown header is an error (a typo such as "enforced"
 * must not silently turn enforcement off). On update an absent column leaves the field unchanged; an empty cell
 * leaves it unchanged too, except for the free-text fields (notes, custom_end, exempt_reason), which it clears.
 * String cells starting with = + - @ tab or CR, or with an apostrophe, are written with one apostrophe in front,
 * and import removes exactly one: export then import is the identity. Free text is never trimmed.
 */
import { ENTITY_TYPES, MODES, PERIODS, cleanBudget, cleanId, cleanText, entityKey, fail, hashOf } from './store.js';

export const COLUMNS = ['budget_id', 'version', 'entity_type', 'entity_id', 'entity_label', 'amount', 'period', 'custom_start', 'custom_end', 'warn_pct', 'mode', 'active', 'include_members', 'include_subgroups', 'count_existing', 'hold_until_released', 'max_targets', 'exempt', 'exempt_reason', 'notes', 'delete'];
export const CONTEXT = ['used', 'period_key', 'status'];
const KNOWN = new Set([...COLUMNS, ...CONTEXT]);
export const MAX_BYTES = 1024 * 1024;
export const MAX_ROWS = 5000;
const FORMULA = /^[=+\-@\t\r']/;

/** A cell, guarded against spreadsheet formulas, quoted when needed. */
export function cell(value, { string = true } = {}) {
  let s = value === null || value === undefined ? '' : String(value);
  if (string && FORMULA.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Undo the formula guard: one leading apostrophe removed, nothing else. */
const unguard = (s) => (s.startsWith("'") ? s.slice(1) : s);

const bool = (b) => (b ? 'true' : 'false');
const day = (iso) => {
  if (!iso) return '';
  return /T00:00:00\.000Z$/.test(iso) ? iso.slice(0, 10) : iso;
};

/** Every budget, ordered by level then label. `context(budget)`: { used, periodKey, status } of its current period. */
export function exportCsv(budgets, exemptions, context = () => ({})) {
  const lines = [[...COLUMNS, ...CONTEXT].join(',')];
  const sorted = [...budgets].sort((a, b) => a.entityType.localeCompare(b.entityType) || (a.entityLabel || a.entityId).localeCompare(b.entityLabel || b.entityId));
  for (const b of sorted) {
    const ex = exemptions.get(entityKey(b.entityType, b.entityId));
    const c = context(b) ?? {};
    const row = [
      cell(b.id), cell(b.version, { string: false }), cell(b.entityType), cell(b.entityId), cell(b.entityLabel), cell(b.amount, { string: false }), cell(b.period), cell(day(b.customStart)), cell(day(b.customEnd)),
      cell(b.warnPct, { string: false }), cell(b.mode), bool(b.active), bool(b.includeMembers), bool(b.includeSubgroups), bool(b.countExisting), bool(b.holdUntilReleased), cell(b.maxTargets, { string: false }),
      bool(Boolean(ex)), cell(ex?.reason ?? ''), cell(b.notes), 'false',
      cell(c.used ?? '', { string: false }), cell(c.periodKey ?? ''), cell(c.status ?? ''),
    ];
    lines.push(row.join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** RFC 4180 parsing (quotes, doubled quotes, CRLF or LF); a BOM is dropped. Returns rows of raw strings. */
export function parseCsv(textIn) {
  const textAll = String(textIn ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < textAll.length) {
    const c = textAll[i];
    if (quoted) {
      if (c === '"') {
        if (textAll[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      i += 1;
    } else if (c === ',') {
      row.push(field);
      field = '';
      i += 1;
    } else if (c === '\r' && textAll[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 2;
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else {
      field += c;
      i += 1;
    }
  }
  if (quoted) throw fail(400, 'The file ends inside a quoted cell.');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const BOOL_T = new Set(['true', '1', 'yes', 'y', 'on']);
const BOOL_F = new Set(['false', '0', 'no', 'n', 'off']);
function parseBool(v, column) {
  const s = v.trim().toLowerCase();
  if (BOOL_T.has(s)) return true;
  if (BOOL_F.has(s)) return false;
  throw new Error(`${column} must be true or false`);
}

/** Fields a budget is compared on in a diff. */
const FIELDS = ['amount', 'period', 'customStart', 'customEnd', 'warnPct', 'mode', 'active', 'includeMembers', 'includeSubgroups', 'countExisting', 'holdUntilReleased', 'maxTargets', 'notes'];
const COLUMN_OF = { amount: 'amount', period: 'period', customStart: 'custom_start', customEnd: 'custom_end', warnPct: 'warn_pct', mode: 'mode', active: 'active', includeMembers: 'include_members', includeSubgroups: 'include_subgroups', countExisting: 'count_existing', holdUntilReleased: 'hold_until_released', maxTargets: 'max_targets', notes: 'notes' };
const CLEARABLE = new Set(['notes', 'custom_end', 'exempt_reason']);

/**
 * Validate a CSV against the current budgets. `entityExists(type, id)`: true / false (unknown entity) / null (the org
 * is not read yet). `canEnforce`: whether the actor may switch budgets to Enforce. Returns { rows, summary, errors,
 * planHash, plan } — `plan` is what apply() writes.
 */
export function validateCsv(csvText, { budgets, exemptions, entityExists = () => null, canEnforce = false, actor = '', now = new Date() }) {
  if (Buffer.byteLength(String(csvText ?? ''), 'utf8') > MAX_BYTES) throw fail(413, 'The file is larger than 1 MiB.');
  const raw = parseCsv(csvText);
  if (!raw.length) throw fail(400, 'The file is empty.');
  const header = raw[0].map((h) => h.trim().toLowerCase());
  const unknown = header.filter((h) => !KNOWN.has(h));
  if (unknown.length) throw fail(400, `Unknown column${unknown.length > 1 ? 's' : ''}: ${unknown.slice(0, 5).join(', ')}. Columns are ${COLUMNS.join(', ')}.`);
  if (new Set(header).size !== header.length) throw fail(400, 'A column appears twice.');
  for (const need of ['entity_type', 'entity_id']) if (!header.includes(need)) throw fail(400, `The ${need} column is required.`);
  const dataRows = raw.slice(1).filter((r) => r.some((c) => c.trim() !== ''));
  if (dataRows.length > MAX_ROWS) throw fail(400, `At most ${MAX_ROWS} rows.`);
  const errors = [];
  const rows = [];
  const plan = [];
  const seen = new Set();
  const byEntity = new Map([...budgets.values()].map((b) => [entityKey(b.entityType, b.entityId), b]));
  dataRows.forEach((cells, i) => {
    const line = i + 2;
    const get = (col) => {
      const at = header.indexOf(col);
      return at === -1 ? undefined : (cells[at] ?? '');
    };
    const str = (col) => {
      const v = get(col);
      return v === undefined ? undefined : unguard(v);
    };
    try {
      const type = str('entity_type').trim().toLowerCase();
      if (!ENTITY_TYPES.includes(type)) throw new Error('entity_type is user, group, project or application');
      const id = cleanId(str('entity_id'), { label: 'entity_id' });
      const key = entityKey(type, id);
      if (seen.has(key)) throw new Error(`${type} ${id} appears in more than one row`);
      seen.add(key);
      const budgetId = (str('budget_id') ?? '').trim();
      let existing = budgetId ? budgets.get(budgetId) : byEntity.get(key);
      if (budgetId && !existing) throw new Error(`budget ${budgetId} does not exist (leave budget_id empty to create one)`);
      if (existing && (existing.entityType !== type || existing.entityId !== id)) throw new Error(`budget ${budgetId} is for ${existing.entityType} ${existing.entityId}, not ${type} ${id}`);
      const version = (str('version') ?? '').trim();
      if (existing && version && Number(version) !== existing.version) throw new Error(`budget for ${type} ${id} changed since this file was exported (version ${existing.version}, the file has ${version})`);
      const exists = entityExists(type, id);
      if (exists === false) throw new Error(`no ${type} ${id} in Checkmarx One`);
      const del = get('delete') !== undefined && get('delete').trim() !== '' && parseBool(get('delete'), 'delete');
      if (del) {
        if (!existing) throw new Error(`there is no budget for ${type} ${id} to delete`);
        rows.push({ line, action: 'delete', entityType: type, entityId: id, budgetId: existing.id, changes: [] });
        plan.push({ action: 'delete', budgetId: existing.id, version: existing.version });
        return;
      }
      const input = {};
      for (const f of FIELDS) {
        const col = COLUMN_OF[f];
        const v = f === 'notes' ? str(col) : get(col);
        if (v === undefined) continue;
        if (v === '' || (f !== 'notes' && v.trim() === '')) {
          if (existing && !CLEARABLE.has(col)) continue;
          if (f === 'notes') input.notes = '';
          else if (f === 'customEnd') input.customEnd = null;
          continue;
        }
        if (['active', 'includeMembers', 'includeSubgroups', 'countExisting', 'holdUntilReleased'].includes(f)) input[f] = parseBool(v, col);
        else if (f === 'period') {
          if (!PERIODS.includes(v.trim().toLowerCase())) throw new Error('period is monthly, quarterly, custom or lifetime');
          input.period = v.trim().toLowerCase();
        } else if (f === 'mode') {
          if (!MODES.includes(v.trim().toLowerCase())) throw new Error('mode is monitor or enforce');
          input.mode = v.trim().toLowerCase();
        } else if (f === 'notes') input.notes = v;
        else input[f] = unguard(v).trim();
      }
      const label = str('entity_label');
      if (label !== undefined && label !== '') input.entityLabel = label;
      if (!existing && input.amount === undefined) throw new Error('amount is required for a new budget');
      const next = cleanBudget(existing ? input : { ...input, entityType: type, entityId: id }, existing, { actor, canEnforce, now });
      if (!existing && input.maxTargets === undefined) delete input.maxTargets;
      // Exemption.
      const exemptCell = get('exempt');
      const reasonCell = str('exempt_reason');
      const exBefore = exemptions.get(key) ?? null;
      let exAfter = exBefore;
      if (exemptCell !== undefined && exemptCell.trim() !== '') {
        const on = parseBool(exemptCell, 'exempt');
        exAfter = on ? { entityType: type, entityId: id, entityLabel: next.entityLabel, reason: reasonCell !== undefined ? cleanText(reasonCell, 512, { keep: true }) : exBefore?.reason ?? '' } : null;
      } else if (exBefore && reasonCell !== undefined) exAfter = { ...exBefore, reason: cleanText(reasonCell, 512, { keep: true }) };
      const changes = [];
      for (const f of FIELDS) {
        const before = existing ? existing[f] : undefined;
        if (JSON.stringify(before ?? null) !== JSON.stringify(next[f] ?? null) && (existing || input[f] !== undefined)) changes.push({ field: COLUMN_OF[f], before: existing ? before ?? null : null, after: next[f] ?? null });
      }
      if (Boolean(exBefore) !== Boolean(exAfter) || (exBefore && exAfter && exBefore.reason !== exAfter.reason)) changes.push({ field: 'exempt', before: exBefore ? `true${exBefore.reason ? ` (${exBefore.reason})` : ''}` : 'false', after: exAfter ? `true${exAfter.reason ? ` (${exAfter.reason})` : ''}` : 'false' });
      const action = !existing ? 'create' : changes.length ? 'update' : 'unchanged';
      rows.push({ line, action, entityType: type, entityId: id, budgetId: existing?.id ?? null, changes });
      if (action !== 'unchanged') plan.push({ action, budgetId: existing?.id ?? null, version: existing?.version ?? null, entityType: type, entityId: id, input: existing ? input : { ...input, entityType: type, entityId: id }, exempt: exAfter ? { reason: exAfter.reason } : null, exemptChanged: Boolean(exBefore) !== Boolean(exAfter) || (exBefore && exAfter && exBefore.reason !== exAfter.reason) });
    } catch (error) {
      errors.push({ line, error: String(error.message).slice(0, 300) });
    }
  });
  const summary = { create: rows.filter((r) => r.action === 'create').length, update: rows.filter((r) => r.action === 'update').length, unchanged: rows.filter((r) => r.action === 'unchanged').length, delete: rows.filter((r) => r.action === 'delete').length, errors: errors.length };
  const planHash = hashOf({ plan: plan.map(({ input, ...p }) => ({ ...p, input })), versions: plan.filter((p) => p.budgetId).map((p) => [p.budgetId, budgets.get(p.budgetId)?.version]) });
  return { rows, summary, errors: errors.slice(0, 200), planHash, plan };
}
