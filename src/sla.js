/**
 * SLAs (Beta): how many days each severity has to be fixed, counted from when
 * the finding was first detected; which open findings are past that (overdue)
 * or close to it (due within 7 days); and, once per finding, an escalation.
 *
 * Findings triaged as not exploitable (proposed or confirmed) have no SLA.
 */

export const SLA_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
export const DEFAULT_SLA = {
  days: { CRITICAL: 7, HIGH: 30, MEDIUM: 90, LOW: 180 },
  // Email the escalation list once when a finding goes past its SLA (scheduled runs).
  escalate: false,
  escalateTo: [],
  // Also open an issue in the project's repository (GitHub or GitLab, private repositories only).
  openIssues: false,
};
/** "Due soon": this many days or fewer left. */
export const DUE_SOON_DAYS = 7;

const DAY_MS = 86_400_000;
const NO_SLA_STATES = new Set(['NOT_EXPLOITABLE', 'PROPOSED_NOT_EXPLOITABLE']);
const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** Stored SLA settings, cleaned: whole days 1–3650 per severity (0 or empty: no SLA), valid addresses. */
export function mergeSla(current = DEFAULT_SLA, incoming = null) {
  const base = { ...DEFAULT_SLA, ...(current ?? {}), days: { ...DEFAULT_SLA.days, ...(current?.days ?? {}) } };
  if (!incoming) return { ...base, escalateTo: [...(base.escalateTo ?? [])] };
  const next = { ...base, days: { ...base.days } };
  for (const severity of SLA_SEVERITIES) {
    if (!(severity in (incoming.days ?? {}))) continue;
    const value = incoming.days[severity];
    const days = Math.floor(Number(value));
    next.days[severity] = value === '' || value === null || !Number.isFinite(days) || days <= 0 ? 0 : Math.min(3650, days);
  }
  if ('escalate' in incoming) next.escalate = incoming.escalate === true;
  if ('openIssues' in incoming) next.openIssues = incoming.openIssues === true;
  if ('escalateTo' in incoming) {
    const list = Array.isArray(incoming.escalateTo) ? incoming.escalateTo : String(incoming.escalateTo ?? '').split(/[\s,;]+/);
    next.escalateTo = [...new Set(list.map((a) => String(a).trim().toLowerCase()).filter((a) => EMAIL.test(a)))].slice(0, 50);
  }
  return next;
}

/** A finding's SLA: {days, dueAt, daysLeft, overdue, dueSoon}, or null (no SLA for it). */
export function slaOf(risk, sla = DEFAULT_SLA, now = Date.now()) {
  const days = Number(sla?.days?.[risk?.severity]) || 0;
  if (!days || NO_SLA_STATES.has(risk.state)) return null;
  const first = Date.parse(risk.firstDetectedAt ?? '');
  if (!Number.isFinite(first)) return null;
  const due = first + days * DAY_MS;
  const daysLeft = Math.floor((due - now) / DAY_MS);
  return { days, dueAt: new Date(due).toISOString(), daysLeft, overdue: now > due, dueSoon: now <= due && daysLeft <= DUE_SOON_DAYS };
}

/** For a project (or all of them): how many findings are overdue and due soon, by severity, and the most overdue. */
export function slaSummary(risks, sla = DEFAULT_SLA, now = Date.now()) {
  const out = { overdue: 0, dueSoon: 0, bySeverity: {}, mostOverdueDays: 0 };
  for (const risk of risks ?? []) {
    const s = slaOf(risk, sla, now);
    if (!s) continue;
    if (s.overdue) {
      out.overdue += 1;
      out.bySeverity[risk.severity] = (out.bySeverity[risk.severity] ?? 0) + 1;
      out.mostOverdueDays = Math.max(out.mostOverdueDays, -s.daysLeft);
    } else if (s.dueSoon) out.dueSoon += 1;
  }
  return out;
}

/** Add project summaries' SLA figures together. */
export function addSla(summaries) {
  const total = { overdue: 0, dueSoon: 0, bySeverity: {}, mostOverdueDays: 0 };
  for (const s of summaries) {
    if (!s) continue;
    total.overdue += s.overdue;
    total.dueSoon += s.dueSoon;
    total.mostOverdueDays = Math.max(total.mostOverdueDays, s.mostOverdueDays);
    for (const [severity, n] of Object.entries(s.bySeverity)) total.bySeverity[severity] = (total.bySeverity[severity] ?? 0) + n;
  }
  return total;
}

export const riskKey = (risk) => `${risk.projectId}|${risk.riskId}`;

/**
 * Findings past their SLA that were never escalated: each is escalated once.
 * `escalated` maps a finding's key to when it was. Returns them, most overdue first.
 */
export function newlyOverdue(risks, sla, escalated = {}, now = Date.now()) {
  return (risks ?? [])
    .map((risk) => ({ risk, sla: slaOf(risk, sla, now) }))
    .filter(({ risk, sla: s }) => s?.overdue && !Object.hasOwn(escalated, riskKey(risk)))
    .sort((a, b) => a.sla.daysLeft - b.sla.daysLeft);
}

/** Forget escalations of findings no longer open (fixed, or not exploitable), so a regression is escalated again. */
export function pruneEscalated(escalated, openRisks) {
  const open = new Set((openRisks ?? []).map(riskKey));
  let pruned = 0;
  for (const key of Object.keys(escalated)) {
    if (!open.has(key)) {
      delete escalated[key];
      pruned += 1;
    }
  }
  return pruned;
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const SEVERITY_COLOURS = { CRITICAL: '#dc2626', HIGH: '#ea580c', MEDIUM: '#d97706', LOW: '#2563eb' };

/**
 * The escalation email: the findings that went past their SLA since the last
 * run, most overdue first, with who ran each project's latest scan.
 * `items`: newlyOverdue() entries. `initiators`: projectId → {initiator, email}.
 */
export function escalationMail(items, { appName = 'CxMissionZero', companyName = '', initiators = {}, max = 200 } = {}) {
  const shown = items.slice(0, max);
  const n = items.length;
  const projects = new Set(items.map(({ risk }) => risk.projectId)).size;
  const subject = `${n} finding${n === 1 ? '' : 's'} past ${n === 1 ? 'its' : 'their'} SLA in ${projects} project${projects === 1 ? '' : 's'}${companyName ? ` · ${companyName}` : ''}`;
  const owner = (risk) => {
    const who = initiators[risk.projectId] ?? {};
    return who.email || who.initiator || '';
  };
  const rows = shown.map(({ risk, sla }) => ({
    project: risk.projectName || risk.projectId,
    severity: risk.severity,
    title: risk.title || risk.queryName || risk.riskId,
    found: String(risk.firstDetectedAt ?? '').slice(0, 10),
    sla: sla.days,
    over: -sla.daysLeft,
    owner: owner(risk),
  }));
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7fb;font:14px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#101828">
<div style="max-width:760px;margin:0 auto;background:#fff;border:1px solid #e6e8ef;border-radius:14px;padding:24px">
<p style="margin:0 0 4px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#dc2626">Escalation · past SLA</p>
<h1 style="margin:0 0 8px;font-size:20px">${escapeHtml(subject)}</h1>
<p style="margin:0 0 16px;color:#475467">These findings went past the days their severity has to be fixed since the last check. Each is escalated once. Who ran each project's latest scan is listed, to follow up with.</p>
<table style="width:100%;border-collapse:collapse;font-size:13px">
<thead><tr style="text-align:left;color:#475467"><th style="padding:6px 8px;border-bottom:1px solid #e6e8ef">Project</th><th style="padding:6px 8px;border-bottom:1px solid #e6e8ef">Finding</th><th style="padding:6px 8px;border-bottom:1px solid #e6e8ef">First found</th><th style="padding:6px 8px;border-bottom:1px solid #e6e8ef;text-align:right">Past SLA</th><th style="padding:6px 8px;border-bottom:1px solid #e6e8ef">Latest scan by</th></tr></thead>
<tbody>${rows
    .map(
      (r) => `<tr><td style="padding:6px 8px;border-bottom:1px solid #f0f1f5">${escapeHtml(r.project)}</td><td style="padding:6px 8px;border-bottom:1px solid #f0f1f5"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${SEVERITY_COLOURS[r.severity] ?? '#98a2b3'};margin-right:6px"></span>${escapeHtml(r.severity.toLowerCase())} · ${escapeHtml(r.title)}</td><td style="padding:6px 8px;border-bottom:1px solid #f0f1f5;white-space:nowrap">${escapeHtml(r.found)}</td><td style="padding:6px 8px;border-bottom:1px solid #f0f1f5;text-align:right;white-space:nowrap"><b style="color:#dc2626">${r.over} day${r.over === 1 ? '' : 's'}</b> <span style="color:#98a2b3">(SLA ${r.sla})</span></td><td style="padding:6px 8px;border-bottom:1px solid #f0f1f5">${escapeHtml(r.owner)}</td></tr>`,
    )
    .join('')}</tbody></table>
${n > shown.length ? `<p style="margin:12px 0 0;color:#475467">And ${n - shown.length} more: see the Dashboard.</p>` : ''}
<p style="margin:16px 0 0;font-size:12px;color:#98a2b3">Sent by ${escapeHtml(appName)} · SLAs are set under Settings → SLAs.</p>
</div></body></html>`;
  const text = [`${subject}`, '', ...rows.map((r) => `- ${r.project} · ${r.severity.toLowerCase()} · ${r.title} · first found ${r.found} · ${r.over} days past SLA (${r.sla})${r.owner ? ` · latest scan by ${r.owner}` : ''}`), n > shown.length ? `And ${n - shown.length} more.` : ''].join('\n');
  return { subject, html, text };
}
