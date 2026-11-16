/**
 * The Audit page: the audit log (src/audit-log.js) as a list, as a CSV export, the check of its chain, and its
 * reconciliation with the credit ledger. The routes under /api/audit.
 */
import { monthOf } from '../credits.js';
import { SUPPORTING_NOTICE } from '../terms.js';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerAuditRoutes(app, d) {
  const { creditLedger, audit, asyncRoute, requirePermission, adminActor } = d;

  // ---------------------------------------------------------------------------
  // Audit log: browse, export, verify, reconcile
  // ---------------------------------------------------------------------------

  function auditFilters(query) {
    const list = (v) => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const date = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v ?? '')) ? String(v) : '');
    return {
      from: date(query.from),
      to: date(query.to),
      types: list(query.types),
      outcomes: list(query.outcomes),
      project: String(query.project ?? '').slice(0, 200),
      q: String(query.q ?? '').slice(0, 200),
      before: Number(query.before) || 0,
      limit: Math.min(1000, Math.max(1, Number(query.limit) || 100)),
    };
  }

  app.get('/api/audit', requirePermission('audit.view'), asyncRoute(async (req, res) => {
    await audit.settled();
    res.json({ ...audit.query(auditFilters(req.query)), writeError: audit.writeError });
  }));

  const CSV_COLUMNS = [
    ['seq', (e) => e.seq],
    ['time', (e) => e.at],
    ['type', (e) => e.type],
    ['outcome', (e) => e.outcome],
    ['reason', (e) => e.reason],
    ['actor', (e) => e.actor?.kind],
    ['user', (e) => e.actor?.user || e.actor?.recipient],
    ['report_id', (e) => e.actor?.reportId || e.details?.reportId],
    ['ip', (e) => e.actor?.ip],
    ['project_id', (e) => e.project?.id],
    ['project', (e) => e.project?.name],
    ['credit_kind', (e) => e.credits?.kind],
    ['credits_requested', (e) => e.credits?.requested],
    ['credits_charged', (e) => e.credits?.charged],
    ['allocated_before', (e) => e.balance?.before?.allocated],
    ['remaining_before', (e) => e.balance?.before?.remaining],
    ['allocated_after', (e) => e.balance?.after?.allocated],
    ['remaining_after', (e) => e.balance?.after?.remaining],
    ['month_remaining', (e) => e.month?.remaining],
    ['findings', (e) => (e.findings ?? []).map((f) => f.riskId).join(' ')],
    ['upstream_call', (e) => e.upstream?.call],
    ['upstream_status', (e) => e.upstream?.status],
    ['upstream_job', (e) => e.upstream?.jobId],
    ['upstream_error', (e) => e.upstream?.error],
    ['entry_id', (e) => e.id],
    ['mac', (e) => e.mac],
  ];
  const csvCell = (v) => {
    const text = v === undefined || v === null ? '' : String(v);
    // Neutralise spreadsheet formulas, then quote.
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };

  /** Everything matching the filters, as CSV (for spreadsheets) or JSON Lines (complete, verifiable). */
  app.get('/api/audit/export', requirePermission('audit.export'), asyncRoute(async (req, res) => {
    await audit.settled();
    const filters = { ...auditFilters(req.query), limit: 1_000_000, before: 0 };
    const format = req.query.format === 'jsonl' ? 'jsonl' : 'csv';
    const { entries } = audit.query(filters);
    entries.reverse();
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="audit-${stamp}.${format}"`);
    if (format === 'jsonl') {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      return res.send([JSON.stringify({ notice: SUPPORTING_NOTICE }), ...entries.map((e) => JSON.stringify(e))].join('\n') + '\n');
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send([csvCell(`Notice: ${SUPPORTING_NOTICE}`), CSV_COLUMNS.map(([name]) => name).join(','), ...entries.map((e) => CSV_COLUMNS.map(([, get]) => csvCell(get(e))).join(','))].join('\n') + '\n');
  }));

  /** Walk the hash chain: any edited, removed or reordered entry is found. */
  app.get('/api/audit/verify', requirePermission('audit.view'), asyncRoute(async (req, res) => {
    await audit.settled();
    const result = audit.verify();
    audit.record({
      type: 'audit',
      outcome: 'info',
      reason: result.ok ? `Audit log verified intact (${result.entries} entries).` : `Audit log verification found ${result.problems.length} problem(s).`,
      actor: await adminActor(req),
      details: { verify: { ok: result.ok, entries: result.entries, problems: result.problems.slice(0, 10) } },
    });
    res.json(result);
  }));

  /**
   * Do the credits the audit log says were charged match the ledger the
   * balances are computed from? Per month and per project, plus ledger entries
   * with no audit entry (spent before auditing began).
   */
  app.get('/api/audit/reconcile', requirePermission('audit.view'), asyncRoute(async (req, res) => {
    await audit.settled();
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month ?? '')) ? String(req.query.month) : monthOf();
    const audited = new Map();
    const auditIds = new Set();
    for (const e of audit.entries({ from: `${month}-01`, to: `${month}-31` })) {
      if (e.corrupt || !e.at?.startsWith(month) || !e.credits?.charged) continue;
      auditIds.add(e.id);
      const key = e.project?.id ?? '';
      const row = audited.get(key) ?? { projectId: key, projectName: e.project?.name ?? '', audited: 0 };
      row.audited += e.credits.charged;
      audited.set(key, row);
    }
    const ledger = creditLedger.summary(month);
    const rows = new Map();
    for (const p of ledger.projects) rows.set(p.projectId, { projectId: p.projectId, projectName: p.projectName, ledger: p.credits, audited: 0 });
    for (const [key, a] of audited) {
      const row = rows.get(key) ?? { projectId: key, projectName: a.projectName, ledger: 0, audited: 0 };
      row.audited = a.audited;
      rows.set(key, row);
    }
    const unlinked = creditLedger.entriesInMonth(month).filter((e) => !e.auditId);
    const missing = creditLedger.entriesInMonth(month).filter((e) => e.auditId && !auditIds.has(e.auditId));
    const projects = [...rows.values()].map((r) => ({ ...r, difference: r.ledger - r.audited })).sort((a, b) => b.ledger - a.ledger);
    res.json({
      month,
      ledgerTotal: ledger.total,
      auditedTotal: projects.reduce((n, r) => n + r.audited, 0),
      matched: projects.every((r) => r.difference === 0 || unlinked.some((u) => u.projectId === r.projectId)) && !missing.length,
      projects,
      unlinked: { entries: unlinked.length, credits: unlinked.reduce((n, e) => n + e.credits, 0), note: 'Spent before the audit log existed.' },
      missing: missing.map((e) => ({ at: e.at, projectId: e.projectId, credits: e.credits, auditId: e.auditId })),
    });
  }));
}
