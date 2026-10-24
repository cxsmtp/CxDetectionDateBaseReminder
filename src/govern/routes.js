/**
 * Govern (beta): the REST API under /api/govern (DESIGN A).
 *
 * Every route needs the Govern feature (its activation code, then Beta access or a govern.* permission) and the
 * govern.* permission for what it does; someone holding only govern.request sees their own requests and their own
 * usage, nothing else. Input is validated and bounded; every change is written to MZ's audit chain with who,
 * before and after (the webhook secret never: only whether one is set). Reads come from memory (the service's
 * view): no Checkmarx One call and no file read on any GET; changes re-evaluate in memory and leave the
 * Checkmarx One side to the background (never inside a request).
 */
import { cleanBudget, cleanId, cleanSettings, cleanText, entityKey, ENTITY_TYPES, fail, hashOf, publicSettings } from './store.js';
import { COLUMNS, exportCsv, validateCsv } from './csv.js';
import { approveRequest, cancelRequest, commentRequest, createRequest, denyRequest, waitingMinutes } from './requests.js';
import { entityLabel } from './view.js';
import { labelOfUser, tabOf } from './attribution.js';
import { postWebhook } from './notify.js';
import { periodWindow } from './evaluate.js';

export const GOVERN_PERMISSIONS = ['govern.view', 'govern.request', 'govern.approve', 'govern.budgets', 'govern.enforce', 'govern.restore', 'govern.attribution', 'govern.settings'];
const MAX_LIMIT = 500;

const page = (q) => {
  const offset = Math.max(0, Math.min(1_000_000, Number.parseInt(q.offset, 10) || 0));
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.parseInt(q.limit, 10) || 100));
  return { offset, limit };
};
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * @param {import('express').Express} app
 * @param {object} deps
 * @param {(id: string) => Function} deps.requireFeature
 * @param {(...perms: string[]) => Function} deps.requirePermission
 * @param {(fn) => Function} deps.asyncRoute
 * @param {() => import('./cycle.js').GovernService} deps.governOf   the running tenant's Govern
 * @param {(req) => Promise<object>} deps.actorOf                     the audit actor of a request
 * @param {(message, to: string[]) => Promise} deps.sendMail
 * @param {() => object} deps.meta                                    { tenant, version, allowLoopback }
 * @param {(url: string) => string} deps.checkWebhookUrl             throws (status 400) on an address never called
 */
export function registerGovernRoutes(app, deps) {
  const { requireFeature, requirePermission, asyncRoute, governOf, actorOf } = deps;
  const feature = requireFeature('govern');
  const perm = (...p) => [feature, requirePermission(...p)];
  const has = (req, p) => Boolean(req.permissions?.has(p));
  const who = (req) => String(req.user?.email ?? '').toLowerCase();
  const send = (res, error) => res.status(error.status && error.status >= 400 && error.status < 600 ? error.status : 500).json({ error: error.status ? error.message : 'Govern could not do that.', ...(error.permission ? { permission: error.permission } : {}) });
  /** Answer 304 when the browser has this exact view (one ETag per view, query and person). */
  const fresh = (req, res, svc, salt = '') => {
    const tag = `W/"${hashOf([svc.view.etag, req.originalUrl, salt]).slice(0, 24)}"`;
    res.set({ ETag: tag, 'Cache-Control': 'private, no-cache' });
    return req.get('if-none-match') === tag;
  };
  /** The caller's own Checkmarx One user id (by email), or null. */
  const selfOf = (svc, req) => {
    const email = who(req);
    if (!email) return null;
    for (const u of svc.holder.current.org.users.values()) if (u.email === email) return u;
    return null;
  };
  const entityExists = (svc, type, id) => {
    const org = svc.holder.current.org;
    const map = type === 'user' ? org.users : type === 'group' ? org.groups : type === 'project' ? org.projects : org.applications;
    return map.size ? map.has(id) : null;
  };
  const rowOf = (svc, id) => svc.view.budgets.find((b) => b.id === id) ?? null;

  // ---- Who am I here ------------------------------------------------------------------------------------
  app.get('/api/govern/me', ...perm(...GOVERN_PERMISSIONS), (req, res) => {
    const svc = governOf();
    const self = selfOf(svc, req);
    res.json({
      permissions: GOVERN_PERMISSIONS.filter((p) => has(req, p)),
      personal: !has(req, 'govern.view'),
      self: self ? { userId: self.id, label: labelOfUser(self) } : null,
      unread: has(req, 'govern.view') ? svc.notifier.unreadCount(req.user.id) : 0,
      running: svc.running,
    });
  });

  // ---- Overview ------------------------------------------------------------------------------------------
  app.get('/api/govern/overview', ...perm('govern.view', 'govern.request'), (req, res) => {
    const svc = governOf();
    if (!has(req, 'govern.view')) {
      if (fresh(req, res, svc, req.user.id)) return res.status(304).end();
      const self = selfOf(svc, req);
      const index = svc.holder.current;
      const budget = self ? svc.view.budgetOf.get(entityKey('user', self.id)) ?? null : null;
      return res.json({
        personal: true,
        self: self ? { userId: self.id, label: labelOfUser(self) } : null,
        usage: self && index.available('user') ? { reported: index.usage('user', self.id).reported, window: index.dims.user.window, lastAt: index.dims.user.lastAt ? new Date(index.dims.user.lastAt).toISOString() : null } : null,
        budget,
        requests: [...svc.store.requests.values()].filter((r) => r.by === who(req)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20),
      });
    }
    if (fresh(req, res, svc)) return res.status(304).end();
    res.type('application/json').send(svc.view.overviewJson);
  });

  // ---- Budgets -------------------------------------------------------------------------------------------
  app.get('/api/govern/budgets', ...perm('govern.view', 'govern.request'), (req, res) => {
    const svc = governOf();
    const personal = !has(req, 'govern.view');
    if (fresh(req, res, svc, personal ? req.user.id : '')) return res.status(304).end();
    const q = req.query;
    let rows = svc.view.budgets;
    if (personal) {
      const self = selfOf(svc, req);
      rows = self ? rows.filter((r) => r.entityType === 'user' && r.entityId === self.id) : [];
    }
    const counts = { all: rows.length, user: 0, group: 0, project: 0, application: 0 };
    for (const r of rows) counts[r.entityType] += 1;
    const level = str(q.level, 20);
    const status = str(q.status, 30);
    const mode = str(q.mode, 20);
    const text = str(q.q).toLowerCase();
    rows = rows.filter((r) => (!level || r.entityType === level) && (!status || r.status === status) && (!mode || r.mode === mode) && (!text || `${r.entityLabel} ${r.entityId} ${r.notes}`.toLowerCase().includes(text)));
    const sort = str(q.sort, 30);
    if (sort) {
      const [field, dir] = sort.split(':');
      if (['entityLabel', 'used', 'limit', 'pct', 'status', 'updatedAt', 'mode', 'period'].includes(field)) {
        const sign = dir === 'desc' ? -1 : 1;
        rows = [...rows].sort((a, b) => sign * (typeof a[field] === 'number' || typeof b[field] === 'number' ? (a[field] ?? -1) - (b[field] ?? -1) : String(a[field] ?? '').localeCompare(String(b[field] ?? ''))));
      }
    }
    const { offset, limit } = page(q);
    res.json({ total: rows.length, offset, limit, counts, items: rows.slice(offset, offset + limit) });
  });

  app.get('/api/govern/budgets/:id', ...perm('govern.view', 'govern.request'), (req, res) => {
    const svc = governOf();
    const row = rowOf(svc, String(req.params.id));
    const self = has(req, 'govern.view') ? null : selfOf(svc, req);
    if (!row || (!has(req, 'govern.view') && !(self && row.entityType === 'user' && row.entityId === self.id))) return res.status(404).json({ error: 'No such budget.' });
    res.json({ budget: row, restrictions: svc.view.restrictions.filter((r) => r.because.some((b) => b.budgetId === row.id)) });
  });

  /** The exemption change a budget request carries ({ exempt, exemptReason }), applied to the store. */
  const applyExemption = (svc, b, input, label) => {
    if (input.exempt === undefined) return null;
    const key = entityKey(b.entityType, b.entityId);
    const before = svc.store.exemptions.get(key) ?? null;
    if (input.exempt === true) svc.store.exemptions.set(key, { entityType: b.entityType, entityId: b.entityId, entityLabel: label, reason: cleanText(input.exemptReason ?? before?.reason ?? '', 512), createdBy: before?.createdBy ?? '', createdAt: before?.createdAt ?? new Date().toISOString() });
    else svc.store.exemptions.delete(key);
    return { before, after: svc.store.exemptions.get(key) ?? null };
  };

  app.post('/api/govern/budgets', ...perm('govern.budgets'), asyncRoute(async (req, res) => {
    const svc = governOf();
    const input = req.body ?? {};
    try {
      if (!ENTITY_TYPES.includes(input.entityType)) throw fail(400, 'Choose who the budget is for: a user, group, project or application.');
      const id = cleanId(input.entityId, { label: 'entity id' });
      if (svc.store.budgetFor(input.entityType, id)) throw fail(409, `There is already a budget for this ${input.entityType}: change that one.`);
      if (entityExists(svc, input.entityType, id) === false) throw fail(400, `No ${input.entityType} ${id} in Checkmarx One.`);
      const label = entityLabel(svc.holder.current, input.entityType, id, cleanText(input.entityLabel, 512));
      const b = cleanBudget({ maxTargets: svc.store.settings.maxTargetsDefault, ...input, entityId: id, entityLabel: label }, null, { actor: who(req), canEnforce: has(req, 'govern.enforce') });
      b.version = 1;
      b.updatedAt = b.createdAt;
      b.updatedBy = who(req);
      svc.store.budgets.set(b.id, b);
      const ex = applyExemption(svc, b, { ...input, exempt: input.exempt === true ? true : undefined }, label);
      svc.store.saveBudgets();
      svc.audit({ event: 'budget.created', actor: await actorOf(req), reason: `Govern: ${who(req)} created a ${b.mode === 'enforce' ? 'Enforce' : 'Monitor'} budget of ${b.amount} credits (${b.period}) for ${b.entityType} ${label}.`, before: null, after: { budget: b, exemption: ex?.after ?? null } });
      svc.changed();
      res.status(201).json({ budget: rowOf(svc, b.id) });
    } catch (error) {
      send(res, error);
    }
  }));

  app.put('/api/govern/budgets/:id', ...perm('govern.budgets'), asyncRoute(async (req, res) => {
    const svc = governOf();
    const existing = svc.store.budgets.get(String(req.params.id));
    if (!existing) return res.status(404).json({ error: 'No such budget.' });
    const input = req.body ?? {};
    if (Number(input.version) !== existing.version) return res.status(409).json({ error: 'Someone changed this budget since you opened it: look again.', budget: rowOf(svc, existing.id) });
    try {
      const { entityType: _t, entityId: _i, ...changes } = input;
      const next = cleanBudget(changes, existing, { actor: who(req), canEnforce: has(req, 'govern.enforce') });
      next.version = existing.version + 1;
      next.updatedAt = new Date().toISOString();
      next.updatedBy = who(req);
      svc.store.budgets.set(next.id, next);
      const ex = applyExemption(svc, next, input, next.entityLabel);
      svc.store.saveBudgets();
      svc.audit({ event: 'budget.updated', actor: await actorOf(req), reason: `Govern: ${who(req)} changed the budget of ${next.entityType} ${next.entityLabel || next.entityId}.`, before: { budget: existing, ...(ex ? { exemption: ex.before } : {}) }, after: { budget: next, ...(ex ? { exemption: ex.after } : {}) } });
      svc.changed();
      res.json({ budget: rowOf(svc, next.id) });
    } catch (error) {
      send(res, error);
    }
  }));

  app.delete('/api/govern/budgets/:id', ...perm('govern.budgets'), asyncRoute(async (req, res) => {
    const svc = governOf();
    const existing = svc.store.budgets.get(String(req.params.id));
    if (!existing) return res.status(404).json({ error: 'No such budget.' });
    if (req.query.version !== undefined && Number(req.query.version) !== existing.version) return res.status(409).json({ error: 'Someone changed this budget since you opened it: look again.' });
    svc.store.budgets.delete(existing.id);
    svc.store.saveBudgets();
    svc.audit({ event: 'budget.deleted', actor: await actorOf(req), reason: `Govern: ${who(req)} deleted the budget of ${existing.entityType} ${existing.entityLabel || existing.entityId}; its restrictions are lifted.`, before: { budget: existing }, after: null });
    svc.changed();
    res.json({ deleted: existing.id });
  }));

  app.post('/api/govern/budgets/bulk', ...perm('govern.budgets'), asyncRoute(async (req, res) => {
    const svc = governOf();
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))].slice(0, 501) : [];
    if (!ids.length || ids.length > 500) return res.status(400).json({ error: 'Choose 1 to 500 budgets.' });
    const c = req.body?.changes ?? {};
    const changes = {};
    for (const k of ['amount', 'warnPct', 'mode', 'active']) if (c[k] !== undefined && c[k] !== null && c[k] !== '') changes[k] = c[k];
    if (!Object.keys(changes).length && c.exempt === undefined) return res.status(400).json({ error: 'Nothing to change.' });
    try {
      const planned = ids.map((id) => {
        const b = svc.store.budgets.get(id);
        if (!b) throw fail(404, `No budget ${id}.`);
        return [b, cleanBudget(changes, b, { actor: who(req), canEnforce: has(req, 'govern.enforce') })];
      });
      const at = new Date().toISOString();
      const before = [];
      const after = [];
      for (const [b, next] of planned) {
        next.version = b.version + 1;
        next.updatedAt = at;
        next.updatedBy = who(req);
        svc.store.budgets.set(next.id, next);
        applyExemption(svc, next, { exempt: typeof c.exempt === 'boolean' ? c.exempt : undefined, exemptReason: c.exemptReason }, next.entityLabel);
        before.push(b);
        after.push(next);
      }
      svc.store.saveBudgets();
      svc.audit({ event: 'budget.bulk', actor: await actorOf(req), reason: `Govern: ${who(req)} changed ${planned.length} budgets at once (${Object.keys(changes).concat(c.exempt !== undefined ? ['exempt'] : []).join(', ')}).`, before: { budgets: before }, after: { budgets: after } });
      svc.changed();
      res.json({ changed: planned.length, budgets: ids.map((id) => rowOf(svc, id)) });
    } catch (error) {
      send(res, error);
    }
  }));

  // ---- Exemptions ----------------------------------------------------------------------------------------
  app.get('/api/govern/exemptions', ...perm('govern.view'), (req, res) => {
    const svc = governOf();
    res.json({ items: [...svc.store.exemptions.values()].map((e) => ({ ...e, key: entityKey(e.entityType, e.entityId), entityLabel: entityLabel(svc.holder.current, e.entityType, e.entityId, e.entityLabel) })) });
  });

  app.post('/api/govern/exemptions', ...perm('govern.budgets'), asyncRoute(async (req, res) => {
    const svc = governOf();
    try {
      const type = req.body?.entityType;
      if (!ENTITY_TYPES.includes(type)) throw fail(400, 'Exempt a user, group, project or application.');
      const id = cleanId(req.body?.entityId, { label: 'entity id' });
      if (entityExists(svc, type, id) === false) throw fail(400, `No ${type} ${id} in Checkmarx One.`);
      const key = entityKey(type, id);
      const before = svc.store.exemptions.get(key) ?? null;
      const after = { entityType: type, entityId: id, entityLabel: entityLabel(svc.holder.current, type, id), reason: cleanText(req.body?.reason, 512), createdBy: who(req), createdAt: new Date().toISOString() };
      svc.store.exemptions.set(key, after);
      svc.store.saveBudgets();
      svc.audit({ event: 'exemption.set', actor: await actorOf(req), reason: `Govern: ${who(req)} exempted ${type} ${after.entityLabel}${after.reason ? ` (${after.reason})` : ''}: never restricted, still warned.`, before, after });
      svc.changed();
      res.status(201).json({ exemption: { ...after, key } });
    } catch (error) {
      send(res, error);
    }
  }));

  app.delete('/api/govern/exemptions/:type/:id', ...perm('govern.budgets'), asyncRoute(async (req, res) => {
    const svc = governOf();
    const key = entityKey(String(req.params.type), String(req.params.id));
    const before = svc.store.exemptions.get(key);
    if (!before) return res.status(404).json({ error: 'No such exemption.' });
    svc.store.exemptions.delete(key);
    svc.store.saveBudgets();
    svc.audit({ event: 'exemption.removed', actor: await actorOf(req), reason: `Govern: ${who(req)} removed the exemption of ${before.entityType} ${before.entityLabel || before.entityId}.`, before, after: null });
    svc.changed();
    res.json({ removed: key });
  }));

  // ---- Who a budget or request can be for (the picker) ----------------------------------------------------
  app.get('/api/govern/entities', ...perm('govern.budgets', 'govern.request', 'govern.attribution'), (req, res) => {
    const svc = governOf();
    const type = str(req.query.type, 20);
    if (!ENTITY_TYPES.includes(type)) return res.status(400).json({ error: 'type is user, group, project or application.' });
    if (type === 'user' && !has(req, 'govern.budgets') && !has(req, 'govern.attribution')) return res.status(403).json({ error: 'You can ask credits for yourself, or for a project, group or application.' });
    const org = svc.holder.current.org;
    const map = type === 'user' ? org.users : type === 'group' ? org.groups : type === 'project' ? org.projects : org.applications;
    const text = str(req.query.q).toLowerCase();
    const items = [];
    for (const e of map.values()) {
      const label = type === 'user' ? labelOfUser(e) : e.path ?? e.name;
      if (text && !`${label} ${e.id} ${e.username ?? ''}`.toLowerCase().includes(text)) continue;
      const b = svc.store.budgetFor(type, e.id);
      items.push({ id: e.id, label, hasBudget: Boolean(b), budgetId: b?.id ?? null, exempt: svc.store.isExempt(type, e.id) });
      if (items.length >= 50) break;
    }
    res.json({ type, readAt: org.readAt, items });
  });

  // ---- CSV -----------------------------------------------------------------------------------------------
  app.get('/api/govern/budgets.csv', ...perm('govern.view'), (req, res) => {
    const svc = governOf();
    const rows = svc.view.budgetOf;
    const csv = exportCsv([...svc.store.budgets.values()], svc.store.exemptions, (b) => {
      const r = rows.get(entityKey(b.entityType, b.entityId));
      return { used: r?.used ?? '', periodKey: r?.periodKey ?? '', status: r?.status ?? '' };
    });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="govern-budgets-${stamp}.csv"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.send(csv);
  });

  const validate = (svc, req) =>
    validateCsv(typeof req.body?.csv === 'string' ? req.body.csv : '', { budgets: svc.store.budgets, exemptions: svc.store.exemptions, entityExists: (t, id) => entityExists(svc, t, id), canEnforce: has(req, 'govern.enforce'), actor: who(req) });

  app.post('/api/govern/csv/validate', ...perm('govern.budgets'), (req, res) => {
    const svc = governOf();
    try {
      const { rows, summary, errors, planHash } = validate(svc, req);
      res.json({ columns: COLUMNS, rows: rows.slice(0, 5000), summary, errors, planHash: errors.length ? null : planHash });
    } catch (error) {
      send(res, error);
    }
  });

  app.post('/api/govern/csv/apply', ...perm('govern.budgets'), asyncRoute(async (req, res) => {
    const svc = governOf();
    try {
      const { plan, summary, errors, planHash } = validate(svc, req);
      if (errors.length) return res.status(400).json({ error: `${errors.length} row(s) have errors: nothing was applied.`, errors });
      if (String(req.body?.planHash ?? '') !== planHash) return res.status(409).json({ error: 'The budgets or the file changed since you validated it: validate again.' });
      const at = new Date().toISOString();
      const before = [];
      const after = [];
      for (const p of plan) {
        if (p.action === 'delete') {
          before.push(svc.store.budgets.get(p.budgetId));
          svc.store.budgets.delete(p.budgetId);
          continue;
        }
        const existing = p.budgetId ? svc.store.budgets.get(p.budgetId) : null;
        const next = cleanBudget(existing ? p.input : { maxTargets: svc.store.settings.maxTargetsDefault, ...p.input, entityLabel: p.input.entityLabel ?? entityLabel(svc.holder.current, p.entityType, p.entityId) }, existing, { actor: who(req), canEnforce: has(req, 'govern.enforce') });
        next.version = (existing?.version ?? 0) + 1;
        next.updatedAt = at;
        next.updatedBy = who(req);
        svc.store.budgets.set(next.id, next);
        if (p.exemptChanged) {
          const key = entityKey(next.entityType, next.entityId);
          if (p.exempt) svc.store.exemptions.set(key, { entityType: next.entityType, entityId: next.entityId, entityLabel: next.entityLabel, reason: p.exempt.reason, createdBy: who(req), createdAt: at });
          else svc.store.exemptions.delete(key);
        }
        if (existing) before.push(existing);
        after.push(next);
      }
      svc.store.saveBudgets();
      svc.audit({ event: 'budget.imported', actor: await actorOf(req), reason: `Govern: ${who(req)} imported budgets from CSV: ${summary.create} created, ${summary.update} changed, ${summary.delete} deleted, ${summary.unchanged} unchanged.`, before: { budgets: before }, after: { budgets: after, planHash } });
      svc.changed();
      res.json({ applied: summary });
    } catch (error) {
      send(res, error);
    }
  }));

  // ---- Credit requests -----------------------------------------------------------------------------------
  const seesAll = (req) => has(req, 'govern.approve') || has(req, 'govern.view');
  const requestView = (r) => ({ ...r, waitingMinutes: waitingMinutes(r) });
  const reqOf = (svc, req) => {
    const r = svc.store.requests.get(String(req.params.id));
    return r && (seesAll(req) || r.by === who(req)) ? r : null;
  };

  app.get('/api/govern/requests', ...perm('govern.request', 'govern.approve', 'govern.view'), (req, res) => {
    const svc = governOf();
    const status = str(req.query.status, 20);
    const mine = req.query.mine === 'true' || !seesAll(req);
    let rows = [...svc.store.requests.values()].filter((r) => (!mine || r.by === who(req)) && (!status || r.status === status));
    const counts = { open: 0, approved: 0, denied: 0, expired: 0, cancelled: 0 };
    for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
    rows.sort((a, b) => (b.status === 'open') - (a.status === 'open') || b.createdAt.localeCompare(a.createdAt));
    const { offset, limit } = page(req.query);
    res.json({ total: rows.length, offset, limit, counts, items: rows.slice(offset, offset + limit).map(requestView) });
  });

  app.get('/api/govern/requests/:id', ...perm('govern.request', 'govern.approve', 'govern.view'), (req, res) => {
    const r = reqOf(governOf(), req);
    if (!r) return res.status(404).json({ error: 'No such request.' });
    res.json({ request: requestView(r) });
  });

  app.post('/api/govern/requests', ...perm('govern.request'), asyncRoute(async (req, res) => {
    const svc = governOf();
    try {
      const input = req.body ?? {};
      const self = selfOf(svc, req);
      const type = String(input.entityType ?? 'user');
      if (type !== 'user' && ENTITY_TYPES.includes(type) && entityExists(svc, type, String(input.entityId ?? '')) === false) throw fail(400, `No ${type} ${String(input.entityId).slice(0, 80)} in Checkmarx One.`);
      const label = type === 'user' ? (self ? labelOfUser(self) : '') : entityLabel(svc.holder.current, type, String(input.entityId ?? ''));
      const open = [...svc.store.requests.values()].filter((r) => r.by === who(req) && r.status === 'open').length;
      if (open >= 20) throw fail(429, 'You have 20 open requests already: wait for an answer.');
      const r = createRequest(input, { by: { email: who(req), name: req.user?.name }, self: self?.id ?? null, label });
      svc.store.requests.set(r.id, r);
      svc.store.saveRequests();
      svc.audit({ event: 'request.created', actor: await actorOf(req), reason: `Govern: ${r.by} asked for ${r.amount} credits for ${r.entityType} ${r.entityLabel || r.entityId}.`, before: null, after: r });
      svc.notifier.raise({ severity: 'info', category: 'request', title: `Credit request: ${r.amount} credits for ${r.entityType} ${r.entityLabel || r.entityId}`, body: `${r.by} asks: ${r.reason}`, entity: { type: r.entityType, id: r.entityId, label: r.entityLabel }, dedupe: `request:${r.id}` });
      svc.changed();
      res.status(201).json({ request: requestView(r) });
    } catch (error) {
      send(res, error);
    }
  }));

  app.post('/api/govern/requests/:id/decide', ...perm('govern.approve'), asyncRoute(async (req, res) => {
    const svc = governOf();
    const r = svc.store.requests.get(String(req.params.id));
    if (!r) return res.status(404).json({ error: 'No such request.' });
    const decision = String(req.body?.decision ?? '');
    try {
      const actor = await actorOf(req);
      if (decision === 'approve') {
        const budget = svc.store.budgetFor(r.entityType, r.entityId);
        const win = budget ? periodWindow(budget, Date.now()) : null;
        const result = approveRequest(r, budget, { amount: req.body?.amount, permanent: req.body?.permanent === true, expiresAt: req.body?.expiresAt ?? null, periodEnd: win?.end ? new Date(win.end).toISOString() : null, by: who(req), note: req.body?.note });
        result.budget.version = budget.version + 1;
        result.budget.updatedAt = new Date().toISOString();
        result.budget.updatedBy = who(req);
        svc.store.budgets.set(budget.id, result.budget);
        svc.store.requests.set(r.id, result.request);
        svc.store.saveBudgets();
        svc.store.saveRequests();
        svc.audit({ event: 'request.approved', actor, reason: `Govern: ${who(req)} approved ${result.request.approvedAmount} of the ${r.amount} credits ${r.by} asked for ${r.entityType} ${r.entityLabel || r.entityId}${result.request.permanent ? ' (budget raised)' : result.request.expiresAt ? ` (until ${result.request.expiresAt.slice(0, 10)})` : ''}.`, before: { request: r, budget }, after: { request: result.request, budget: result.budget } });
        svc.notifier.raise({ severity: 'info', category: 'request', title: `Approved: ${result.request.approvedAmount} credits for ${r.entityType} ${r.entityLabel || r.entityId}`, body: `${who(req)} approved ${result.request.approvedAmount} of the ${r.amount} credits asked${result.request.expiresAt ? `, until ${result.request.expiresAt.slice(0, 10)}` : ''}. Restrictions are lifted if usage is now under the budget.`, entity: { type: r.entityType, id: r.entityId, label: r.entityLabel }, dedupe: `request:${r.id}:approved`, to: [r.by] });
        svc.changed();
        return res.json({ request: requestView(result.request), budget: rowOf(svc, budget.id) });
      }
      if (decision === 'deny') {
        const next = denyRequest(r, { reason: req.body?.reason, by: who(req) });
        svc.store.requests.set(r.id, next);
        svc.store.saveRequests();
        svc.audit({ event: 'request.denied', actor, reason: `Govern: ${who(req)} denied ${r.by}'s request for ${r.amount} credits: ${next.denyReason}`, before: r, after: next });
        svc.notifier.raise({ severity: 'info', category: 'request', title: `Denied: credits for ${r.entityType} ${r.entityLabel || r.entityId}`, body: `${who(req)} denied the request for ${r.amount} credits: ${next.denyReason}`, entity: { type: r.entityType, id: r.entityId, label: r.entityLabel }, dedupe: `request:${r.id}:denied`, to: [r.by] });
        svc.changed();
        return res.json({ request: requestView(next) });
      }
      res.status(400).json({ error: 'Approve or deny.' });
    } catch (error) {
      send(res, error);
    }
  }));

  app.post('/api/govern/requests/:id/comment', ...perm('govern.request', 'govern.approve'), asyncRoute(async (req, res) => {
    const svc = governOf();
    const r = svc.store.requests.get(String(req.params.id));
    const mayWrite = r && (has(req, 'govern.approve') || r.by === who(req));
    if (!mayWrite) return res.status(404).json({ error: 'No such request.' });
    try {
      const next = commentRequest(r, { text: req.body?.text, by: who(req) });
      svc.store.requests.set(r.id, next);
      svc.store.saveRequests();
      svc.audit({ event: 'request.comment', actor: await actorOf(req), reason: `Govern: ${who(req)} wrote on the request for ${r.amount} credits for ${r.entityType} ${r.entityLabel || r.entityId}.`, after: next.thread.at(-1) });
      if (r.by !== who(req)) svc.notifier.raise({ severity: 'info', category: 'request', title: `A question about your request for ${r.amount} credits`, body: `${who(req)}: ${next.thread.at(-1).text}`, entity: { type: r.entityType, id: r.entityId, label: r.entityLabel }, dedupe: `request:${r.id}:comment:${next.thread.length}`, to: [r.by] });
      res.json({ request: requestView(next) });
    } catch (error) {
      send(res, error);
    }
  }));

  app.post('/api/govern/requests/:id/cancel', ...perm('govern.request'), asyncRoute(async (req, res) => {
    const svc = governOf();
    const r = svc.store.requests.get(String(req.params.id));
    if (!r || r.by !== who(req)) return res.status(404).json({ error: 'No such request.' });
    try {
      const next = cancelRequest(r, { by: who(req) });
      svc.store.requests.set(r.id, next);
      svc.store.saveRequests();
      svc.audit({ event: 'request.cancelled', actor: await actorOf(req), reason: `Govern: ${who(req)} withdrew the request for ${r.amount} credits.`, before: r, after: next });
      res.json({ request: requestView(next) });
    } catch (error) {
      send(res, error);
    }
  }));

  // ---- Restrictions and alerts ---------------------------------------------------------------------------
  app.get('/api/govern/restrictions', ...perm('govern.view'), (req, res) => {
    const svc = governOf();
    if (fresh(req, res, svc)) return res.status(304).end();
    const kind = str(req.query.kind, 30);
    const text = str(req.query.q).toLowerCase();
    const rows = svc.view.restrictions.filter((r) => (!kind || r.kind === kind) && (!text || `${r.label} ${r.targetId} ${r.because.map((b) => b.label).join(' ')}`.toLowerCase().includes(text)));
    const { offset, limit } = page(req.query);
    res.json({ total: rows.length, offset, limit, items: rows.slice(offset, offset + limit) });
  });

  app.post('/api/govern/restrictions/restore', ...perm('govern.restore'), asyncRoute(async (req, res) => {
    const svc = governOf();
    const keys = Array.isArray(req.body?.keys) ? [...new Set(req.body.keys.map((k) => String(k).slice(0, 300)))].slice(0, 500) : [];
    if (!keys.length) return res.status(400).json({ error: 'Choose what to restore.' });
    let graceUntil = null;
    if (req.body?.graceUntil) {
      const t = Date.parse(String(req.body.graceUntil));
      if (!Number.isFinite(t) || t <= Date.now()) return res.status(400).json({ error: 'The grace must end in the future.' });
      graceUntil = new Date(t).toISOString();
    }
    const unknown = keys.filter((k) => !svc.holds.targets.has(k));
    if (unknown.length === keys.length) return res.status(404).json({ error: 'Nothing restricted by those names.' });
    const restored = svc.restore(keys, { by: who(req), actor: await actorOf(req), graceUntil });
    res.status(202).json({ restored, unknown, note: 'Put back in Checkmarx One in the background; the list shows each one once it is done.' });
  }));

  app.get('/api/govern/alerts', ...perm('govern.view'), (req, res) => {
    const svc = governOf();
    const { offset, limit } = page(req.query);
    res.set('Cache-Control', 'no-store');
    res.json({ offset, limit, ...svc.notifier.feed(req.user.id, { category: str(req.query.category, 30), severity: str(req.query.severity, 20), unread: req.query.unread === 'true', q: str(req.query.q), offset, limit }), backlog: svc.notifier.backlog() });
  });

  app.post('/api/govern/alerts/read', ...perm('govern.view'), (req, res) => {
    const svc = governOf();
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => String(x).slice(0, 80)).slice(0, 1000) : [];
    const unread = svc.notifier.markRead(req.user.id, { ids, all: req.body?.all === true });
    res.json({ unread });
  });

  // ---- Attribution ---------------------------------------------------------------------------------------
  app.get('/api/govern/attribution', ...perm('govern.attribution', 'govern.view'), (req, res) => {
    const svc = governOf();
    if (fresh(req, res, svc)) return res.status(304).end();
    const tab = str(req.query.tab, 20);
    const dim = str(req.query.dimension, 20);
    const text = str(req.query.q).toLowerCase();
    const all = svc.view.attribution;
    const counts = { disputes: 0, matched: 0, unmatched: 0, ignored: 0 };
    for (const r of all) if (!dim || r.dimension === dim) counts[r.tab] += 1;
    const rows = all.filter((r) => (!tab || r.tab === tab) && (!dim || r.dimension === dim) && (!text || `${r.name} ${r.email} ${r.entityLabel}`.toLowerCase().includes(text))).sort((a, b) => b.credits - a.credits);
    const { offset, limit } = page(req.query);
    res.json({ total: rows.length, offset, limit, counts, items: rows.slice(offset, offset + limit) });
  });

  app.post('/api/govern/attribution/decide', ...perm('govern.attribution'), asyncRoute(async (req, res) => {
    const svc = governOf();
    try {
      const key = String(req.body?.key ?? '').slice(0, 400);
      const action = String(req.body?.action ?? '');
      if (!svc.queue.some((r) => r.key === key) && !svc.store.decisions.has(key)) throw fail(404, 'That subject is not in the consumption Govern read.');
      if (action === 'pin') {
        const [dim] = key.split(':');
        if (entityExists(svc, dim, String(req.body?.entityId ?? '')) === false) throw fail(400, `No ${dim} ${String(req.body?.entityId).slice(0, 80)} in Checkmarx One.`);
      }
      const result = svc.decide({ key, action, entityId: req.body?.entityId ?? null, why: req.body?.why ?? '' }, { by: who(req), actor: await actorOf(req) });
      const row = svc.view.attribution.find((r) => r.key === key) ?? null;
      res.json({ decision: result.after, row: row ? { ...row, tab: tabOf(row) } : null });
    } catch (error) {
      send(res, error);
    }
  }));

  // ---- Settings ------------------------------------------------------------------------------------------
  app.get('/api/govern/settings', ...perm('govern.settings'), (req, res) => {
    const svc = governOf();
    res.set('Cache-Control', 'no-store');
    res.json({ settings: publicSettings(svc.store.settings), nextRunAt: svc.nextRunAt ? new Date(svc.nextRunAt).toISOString() : null });
  });

  app.put('/api/govern/settings', ...perm('govern.settings'), asyncRoute(async (req, res) => {
    const svc = governOf();
    try {
      const before = svc.store.settings;
      const next = cleanSettings(req.body ?? {}, before, { checkUrl: deps.checkWebhookUrl });
      if (next.aiRoles.includes('view-scans') && !before.aiRoles.includes('view-scans') && req.body?.confirmViewScans !== true) throw fail(400, 'Removing view-scans also stops ordinary scan viewing: confirm it (confirmViewScans) to add it.');
      svc.store.settings = next;
      svc.store.saveSettings();
      const secretChanged = before.notify.webhook.secret !== next.notify.webhook.secret;
      svc.audit({ event: 'settings.updated', actor: await actorOf(req), reason: `Govern: ${who(req)} changed the Govern settings${secretChanged ? ' (webhook signing secret changed)' : ''}.`, before: publicSettings(before), after: publicSettings(next) });
      svc.changed();
      res.json({ settings: publicSettings(next) });
    } catch (error) {
      send(res, error);
    }
  }));

  app.post('/api/govern/settings/test', ...perm('govern.settings'), asyncRoute(async (req, res) => {
    const svc = governOf();
    const channel = String(req.body?.channel ?? '');
    const s = svc.store.settings.notify;
    const actor = await actorOf(req);
    try {
      if (channel === 'email') {
        const to = s.email.recipients.length ? s.email.recipients : [who(req)];
        await deps.sendMail({ subject: '[CxMissionZero Govern] Test', text: 'A test of Govern notifications: email works.', html: '<p>A test of Govern notifications: email works.</p>' }, to);
        svc.audit({ event: 'settings.tested', actor, reason: `Govern: ${who(req)} sent a test email to ${to.length} recipient(s).` });
        return res.json({ ok: true, channel, to: to.length });
      }
      if (channel === 'webhook') {
        if (!s.webhook.url) throw fail(400, 'Set the webhook address first.');
        const id = `test-${Date.now()}`;
        const result = await postWebhook(s.webhook.url, JSON.stringify({ id, test: true, title: 'A test of Govern notifications', created_at: new Date().toISOString(), source: { name: 'CxMissionZero', version: deps.meta().version ?? '' } }), { secret: s.webhook.secret, deliveryId: id, userAgent: `CxMissionZero/${deps.meta().version ?? ''}`, allowLoopback: Boolean(deps.meta().allowLoopback) });
        svc.audit({ event: 'settings.tested', actor, reason: `Govern: ${who(req)} sent a test to the webhook (it answered ${result.status}).` });
        return res.json({ ok: true, channel, status: result.status, signed: Boolean(s.webhook.secret) });
      }
      res.status(400).json({ error: 'Test email or webhook.' });
    } catch (error) {
      res.status(error.status === 400 ? 400 : 502).json({ ok: false, error: String(error.message).slice(0, 300) });
    }
  }));

  app.get('/api/govern/permissions', ...perm('govern.settings'), (req, res) => {
    const svc = governOf();
    res.json({ check: svc.permissions, writes: svc.writes });
  });

  app.post('/api/govern/permissions/check', ...perm('govern.settings'), (req, res) => {
    const svc = governOf();
    svc.checkPermissions().catch(() => {});
    res.status(202).json({ checking: true });
  });

  // ---- Cycles --------------------------------------------------------------------------------------------
  app.post('/api/govern/run', ...perm('govern.budgets', 'govern.settings', 'govern.enforce'), asyncRoute(async (req, res) => {
    const svc = governOf();
    const { runId, started } = svc.runNow({ trigger: 'manual', by: who(req) });
    if (started) svc.audit({ event: 'cycle.started', actor: await actorOf(req), reason: `Govern: ${who(req)} started a cycle (Run now).` });
    res.status(202).json({ runId, started });
  }));

  app.get('/api/govern/runs', ...perm('govern.view'), (req, res) => {
    const svc = governOf();
    res.json({ running: svc.running, nextRunAt: svc.nextRunAt ? new Date(svc.nextRunAt).toISOString() : null, items: svc.runs() });
  });

  app.get('/api/govern/runs/:id', ...perm('govern.view', 'govern.budgets', 'govern.settings'), (req, res) => {
    const run = governOf().run(String(req.params.id).slice(0, 80));
    if (!run) return res.status(404).json({ error: 'No such run.' });
    res.json({ run });
  });

  // ---- Diagnose a figure ---------------------------------------------------------------------------------
  app.get('/api/govern/diagnose', ...perm('govern.view'), (req, res) => {
    const svc = governOf();
    const type = str(req.query.entityType, 20);
    if (!ENTITY_TYPES.includes(type)) return res.status(400).json({ error: 'entityType is user, group, project or application.' });
    try {
      res.json(svc.diagnose(type, cleanId(req.query.entityId, { label: 'entity id' })));
    } catch (error) {
      send(res, error);
    }
  });
}
