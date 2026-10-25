/**
 * Labs → Govern (Beta): who may use how many AI credits, and what happens at the limit (DESIGN A).
 *
 * One page with six tabs — Overview, Budgets, Requests, Restrictions & alerts, Attribution, Settings — each shown to
 * the permissions that read it; someone holding only govern.request sees their own usage, budget and requests.
 * Everything is read from /api/govern (served from memory, with ETags: a poll every 60 s while the page is in view
 * sends If-None-Match, and a 304 redraws nothing). A cycle runs in the background: Run now starts one and polls it,
 * never blocking the page. Tables share one pattern: search, heading sort and filters (table-tools.js), a Columns
 * menu (column-prefs.js), row click → the side panel, ticked rows → an action bar of the actions that fit, and
 * exports (CSV and HTML) of what the table shows.
 *
 * The pure helpers (formatting, statuses, the columns and their exports, the chart's rows, the pool guard, what a
 * person sees) are exported for test/govern-ui.test.js.
 */
import { sortAndFilter } from './table-tools.js';
import { columnMenu, shownColumns } from './column-prefs.js';
import { ago, csvText, esc, num, reportHtml, save, stamp } from './labs-common.js';

// ---------------------------------------------------------------------------------------------------------------
// Words and statuses
// ---------------------------------------------------------------------------------------------------------------

export const LEVELS = ['user', 'group', 'project', 'application'];
export const LEVEL_LABEL = { user: 'User', group: 'Group', project: 'Project', application: 'Application' };
export const LEVEL_PLURAL = { user: 'Users', group: 'Groups', project: 'Projects', application: 'Applications' };
export const PERIOD_LABEL = { monthly: 'Monthly', quarterly: 'Quarterly', lifetime: 'Lifetime', custom: 'Custom' };
export const MODE_LABEL = { monitor: 'Monitor', enforce: 'Enforce' };
export const ACTION_LABEL = { triage: 'AI Triage', remediation: 'AI Remediation', auto_triage: 'Auto Triage', fusion: 'Fusion', other: 'Other' };
const ACTION_CLASS = { triage: 'triage', remediation: 'remediation', auto_triage: 'auto', fusion: 'fusion' };
export const ACTION_ORDER = ['triage', 'remediation', 'auto_triage', 'fusion'];

/** A budget's status: its words and its badge (each one distinct). */
export const BUDGET_STATUS = {
  within: ['Within', ''],
  near: ['Near', 'warn'],
  over: ['Over', 'bad'],
  restricted: ['Restricted', 'gv-restricted'],
  partial: ['Partial', 'gv-partial'],
  restricting: ['Restricting', 'gv-info'],
  exempt: ['Exempt', 'muted'],
  not_reported: ['Not reported', 'gv-dashed'],
  inactive: ['Paused', 'gv-outline'],
  not_open: ['Not open yet', 'gv-outline'],
  needs_confirmation: ['Needs confirming', 'gv-ask'],
  not_evaluated: ['Not checked yet', 'gv-dashed'],
  none: ['No budget', 'gv-dashed'],
};
/** Worst first: what a sort by status brings to the top. */
export const STATUS_ORDER = ['restricted', 'partial', 'restricting', 'over', 'needs_confirmation', 'near', 'within', 'not_reported', 'not_evaluated', 'not_open', 'exempt', 'inactive', 'none'];
export const statusText = (s) => (BUDGET_STATUS[s] ?? [s || '—'])[0];
export function statusBadge(s) {
  const [label, cls] = BUDGET_STATUS[s] ?? [s || '—', 'muted'];
  return `<span class="badge${cls ? ` ${cls}` : ''}">${esc(label)}</span>`;
}

export const REQUEST_STATUS = { open: ['Waiting', 'gv-info'], approved: ['Approved', ''], denied: ['Denied', 'bad'], expired: ['Expired', 'muted'], cancelled: ['Withdrawn', 'gv-outline'] };
export const requestBadge = (s) => `<span class="badge${REQUEST_STATUS[s]?.[1] ? ` ${REQUEST_STATUS[s][1]}` : ''}">${esc(REQUEST_STATUS[s]?.[0] ?? s)}</span>`;

export const HOLD_STATE = { applied: ['Restricted', 'gv-restricted'], partial: ['Partial', 'gv-partial'], failed: ['Failed', 'bad'], skipped: ['Skipped', 'muted'], pending: ['Waiting', 'gv-info'], writing: ['Restricting', 'gv-info'], release_pending: ['Restoring', 'gv-info'], grace: ['In grace', 'gv-info'] };
export const holdBadge = (s) => `<span class="badge${HOLD_STATE[s]?.[1] ? ` ${HOLD_STATE[s][1]}` : ''}">${esc(HOLD_STATE[s]?.[0] ?? s)}</span>`;
export const KIND_LABEL = { user_roles: 'AI roles removed', auto_triage: 'Auto Triage off', pr_remediation: 'PR remediation off' };

export const SEVERITY_LABEL = { critical: 'Critical', error: 'Error', warning: 'Warning', info: 'Info' };
export const CATEGORY_LABEL = { warning: 'Warning', enforcement: 'Enforcement', restoration: 'Restoration', attribution: 'Attribution', sync_error: 'Sync error', request: 'Request' };
export const CATEGORY_CHIP = { warning: 'Warnings', enforcement: 'Enforcement', restoration: 'Restoration', attribution: 'Attribution', sync_error: 'Sync errors', request: 'Requests' };
const CHANNEL_LABEL = { email: 'Email', webhook: 'Webhook', direct: 'Email to the requester' };

export const MATCH_LABEL = { exact: 'matched exactly', pinned: 'mapped by hand', auto: 'matched by name', disputed: 'two or more could be meant', unmatched: 'matches nobody here', ignored: 'ignored: counts towards no one', automation: 'automation: counted tenant-wide', bot: 'a bot: counted tenant-wide' };
export const ATTRIBUTION_TABS = ['disputes', 'matched', 'unmatched', 'ignored'];
export const ATTRIBUTION_TAB_LABEL = { disputes: 'Disputes', matched: 'Matched', unmatched: 'Unmatched', ignored: 'Ignored' };
const ATTRIBUTION_TAB_HINT = {
  disputes: 'Disputes: matched, but another candidate comes close, or nobody is sure. Check them once; what you decide sticks.',
  matched: 'Matched: counted towards the budget shown. Reject a wrong match, or clear a decision.',
  unmatched: 'Unmatched: these credits count towards no budget until they are mapped or ignored.',
  ignored: 'Ignored: shared or service accounts, counted towards no one. Clear to match them again.',
};

export const WINDOW_LABEL = { last_month: 'Last month', last_30_days: 'Last 30 days', last_90_days: 'Last 90 days', last_180_days: 'Last 180 days', last_year: 'Last year' };
export const DEFAULT_AI_ROLES = ['view-risk-management', 'view-risk-management-dashboard', 'view-risk-management-tab'];
const CSV_FIELD_LABEL = { amount: 'Budget', period: 'Period', custom_start: 'From', custom_end: 'To', warn_pct: 'Warn at', mode: 'Mode', active: 'Active', include_members: 'Count members', include_subgroups: 'Count subgroups', count_existing: 'Count earlier usage', hold_until_released: 'Hold until released', max_targets: 'Most targets', exempt: 'Exempt', exempt_reason: 'Exemption reason', notes: 'Notes', entity_label: 'Label' };
export const csvFieldLabel = (f) => CSV_FIELD_LABEL[f] ?? f;

// ---------------------------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------------------------

/** Credits as people read them: whole numbers grouped, at most two decimals; '—' for nothing. */
export function credits(n) {
  if (n === null || n === undefined || n === '' || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** How long a request has waited: "waiting 25 min", "waiting 2 h", "waiting 1 d 3 h". */
export function waitingLabel(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(Number(minutes))) return '';
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `waiting ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `waiting ${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `waiting ${d} d ${h % 24} h` : `waiting ${d} d`;
}

/** A short date (Oct 21) in the reader's locale, or ''. */
export function shortDate(iso, { year = false } = {}) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' });
}

/** "in 11 min", "in 2 h": when the next cycle runs. */
export function inLabel(iso, now = Date.now()) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (t - now) / 1000);
  if (s < 60) return 'in under a minute';
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  return `in ${Math.round(s / 3600)} h`;
}

/** The period of a budget in words: Monthly, Quarterly, Lifetime, or Custom with its dates. */
export function periodText(b) {
  const p = PERIOD_LABEL[b.period] ?? b.period;
  if (b.period !== 'custom') return p;
  const from = shortDate(b.customStart ?? b.start);
  const to = shortDate(b.customEnd ?? b.end, { year: true });
  return from || to ? `${p} ${from} – ${to || '…'}` : p;
}

/** Used against the budget, as a bar from the left with the warn tick and the per cent. */
export function useBar(row) {
  const pct = row?.pct;
  if (pct === null || pct === undefined || !row.limit) return '<div class="gv-use na" translate="no"><span class="gv-track"></span><b>—</b></div>';
  const warn = Number.isFinite(Number(row.warnPct)) ? Number(row.warnPct) : 80;
  const cls = pct >= 100 ? 'over' : pct >= warn ? 'near' : '';
  return `<div class="gv-use" translate="no"><span class="gv-track"><span class="gv-fill${cls ? ` ${cls}` : ''}" style="width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%"></span><span class="gv-tick" style="inset-inline-start:calc(${Math.max(0, Math.min(100, warn))}% - 1px)"></span></span><b${cls ? ` class="${cls}"` : ''}>${Math.round(pct)}%</b></div>`;
}

export const levelTag = (type) => `<span class="gv-tag">${esc(LEVEL_LABEL[type] ?? type)}</span>`;
export const modeTag = (mode) => (mode ? `<span class="gv-tag${mode === 'enforce' ? ' enforce' : ''}">${esc(MODE_LABEL[mode] ?? mode)}</span>` : '<span class="hint">—</span>');
export const whoHtml = (label, type) => `<div class="gv-who"><span translate="no">${esc(label)}</span>${type ? levelTag(type) : ''}</div>`;

/** The line under a budget's name: why it is in that state. */
export function budgetWhy(r) {
  const line = (text, cls = '') => `<span class="gv-why${cls ? ` ${cls}` : ''}">${esc(text)}</span>`;
  if (r.status === 'partial' && r.restrictions?.reasons?.length) return `<span class="gv-why warn" translate="no">${esc(r.restrictions.reasons[0])}</span>`;
  if (r.status === 'restricted') return line(r.restrictions?.applied === 1 ? '1 restriction in force' : `${r.restrictions?.applied ?? 0} restrictions in force`);
  if (r.status === 'restricting') return line('Being restricted in Checkmarx One');
  if (r.status === 'over' && r.mode === 'monitor') return line('Monitor: warned, nothing removed');
  if (r.status === 'not_reported') return line(r.entityType === 'group' ? 'Checkmarx One does not report usage per group' : 'Checkmarx One does not report this usage');
  if (r.status === 'needs_confirmation') return line('Enforce would restrict many: confirm it in the budget', 'warn');
  if (r.exempt && r.exemptReason) return `<span class="gv-why" translate="no">${esc(r.exemptReason)}</span>`;
  if (r.grace) return line('In grace after a restore');
  if (r.stale) return line('Usage from an earlier poll: the last one failed', 'warn');
  if (r.estimated) return line('Estimated: less history than the lookback window');
  return '';
}

// ---------------------------------------------------------------------------------------------------------------
// What each person sees
// ---------------------------------------------------------------------------------------------------------------

/** The tabs and the permissions that show each (any one of them). */
export const GOVERN_TABS = [
  ['overview', ['govern.view', 'govern.request']],
  ['budgets', ['govern.view']],
  ['requests', ['govern.request', 'govern.approve', 'govern.view']],
  ['restrictions', ['govern.view']],
  ['attribution', ['govern.attribution', 'govern.view']],
  ['settings', ['govern.settings']],
];
export const tabsFor = (perms = []) => GOVERN_TABS.filter(([, need]) => need.some((p) => perms.includes(p))).map(([id]) => id);
/** Only govern.request (no govern.view): their own usage, budget and requests. */
export const isPersonal = (perms = []) => !perms.includes('govern.view');
export const mayRun = (perms = []) => ['govern.budgets', 'govern.settings', 'govern.enforce'].some((p) => perms.includes(p));

/** The actions the budgets action bar offers for the ticked rows: only those that change something. */
export function budgetActions(rows, perms = []) {
  if (!rows.length || !perms.includes('govern.budgets')) return [];
  const out = ['amount', 'warn'];
  if (rows.some((r) => r.mode === 'enforce')) out.push('monitor');
  if (perms.includes('govern.enforce') && rows.some((r) => r.mode !== 'enforce')) out.push('enforce');
  if (rows.some((r) => r.active)) out.push('pause');
  if (rows.some((r) => !r.active)) out.push('resume');
  if (rows.some((r) => !r.exempt)) out.push('exempt');
  if (rows.some((r) => r.exempt)) out.push('unexempt');
  return out;
}

/** The actions for ticked requests: approve or deny the open ones (approvers), withdraw one's own. */
export function requestActions(rows, perms = [], me = '') {
  const open = rows.filter((r) => r.status === 'open');
  const out = [];
  if (open.length && perms.includes('govern.approve')) out.push('approve', 'deny');
  if (open.some((r) => r.by === me) && perms.includes('govern.request')) out.push('cancel');
  return out;
}

/** The actions for ticked attribution rows. */
export function attributionActions(rows, perms = []) {
  if (!rows.length || !perms.includes('govern.attribution')) return [];
  const out = [];
  if (rows.some((r) => r.status !== 'ignored')) out.push('ignore');
  if (rows.some((r) => r.decision)) out.push('clear');
  return out;
}

/**
 * Assigning credits beyond the pool: { assignedAfter, over } when a budget of `amount` (replacing `oldLimit` when it
 * is edited) takes the active budgets past the pool, else null. Allowed in Monitor; warned either way.
 */
export function poolGuard({ assigned = 0, poolLimit = 0, oldLimit = 0, oldActive = true, amount = 0, active = true }) {
  if (!poolLimit || !Number.isFinite(Number(amount))) return null;
  const after = Math.round((Number(assigned) - (oldActive ? Number(oldLimit) || 0 : 0) + (active ? Number(amount) : 0)) * 100) / 100;
  const over = Math.round((after - poolLimit) * 100) / 100;
  return over > 0 ? { assignedAfter: after, over } : null;
}

/** The credit pool bar's parts from the overview figures: used, assigned not used, free (or over), as % of the scale. */
export function poolParts(f = {}) {
  const pool = Number(f.pool?.limit) || 0;
  const assigned = Number(f.assigned) || 0;
  const used = Number(f.usedThisPeriod) || 0;
  const scale = Math.max(pool, assigned, used, 1);
  const unusedAssigned = Math.max(0, assigned - used);
  const free = Math.max(0, pool - Math.max(assigned, used));
  const over = Math.max(0, Math.max(assigned, used) - pool);
  const pct = (n) => Math.round((n / scale) * 10000) / 100;
  return { pool, assigned, used, unusedAssigned, free, over: pool ? over : 0, scale, usedPct: pct(used), assignedPct: pct(unusedAssigned), freePct: pct(free) };
}

// ---------------------------------------------------------------------------------------------------------------
// Credits over time
// ---------------------------------------------------------------------------------------------------------------

/**
 * The chart's columns for a range: '7d', 'period' (this calendar month, UTC), '90d', or '12m' (by month, from the
 * 90 days Govern keeps). Returns { bucket, rows: [{ key, label, long, values: {action: n}, total }], actions, sums }.
 */
export function trendRows(trend, range = 'period', now = Date.now()) {
  const days = trend?.days ?? [];
  const series = trend?.series ?? {};
  const actions = [...ACTION_ORDER.filter((a) => series[a]), ...Object.keys(series).filter((a) => !ACTION_ORDER.includes(a)).sort()];
  let idx = days.map((_, i) => i);
  if (range === '7d') idx = idx.slice(-7);
  else if (range === 'period') {
    const month = new Date(now).toISOString().slice(0, 7);
    idx = idx.filter((i) => days[i].slice(0, 7) === month);
  }
  const dayLabel = (d, long = false) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(long ? { weekday: 'short', year: 'numeric' } : {}), timeZone: 'UTC' });
  let rows;
  if (range === '12m') {
    const byMonth = new Map();
    for (const i of idx) {
      const m = days[i].slice(0, 7);
      const row = byMonth.get(m) ?? { key: m, values: {} };
      for (const a of actions) row.values[a] = (row.values[a] ?? 0) + (series[a][i] ?? 0);
      byMonth.set(m, row);
    }
    rows = [...byMonth.values()].map((r) => {
      const d = new Date(`${r.key}-01T00:00:00Z`);
      return { ...r, label: d.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }), long: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
    });
  } else rows = idx.map((i) => ({ key: days[i], label: dayLabel(days[i]), long: dayLabel(days[i], true), values: Object.fromEntries(actions.map((a) => [a, series[a][i] ?? 0])) }));
  const round = (n) => Math.round(n * 100) / 100;
  for (const r of rows) {
    for (const a of actions) r.values[a] = round(r.values[a] ?? 0);
    r.total = round(actions.reduce((n, a) => n + r.values[a], 0));
  }
  const sums = Object.fromEntries(actions.map((a) => [a, round(rows.reduce((n, r) => n + r.values[a], 0))]));
  return { bucket: range === '12m' ? 'month' : 'day', rows, actions, sums };
}

/** A clean axis: top and step of 1, 2 or 5 × 10^n. */
export function niceScale(max, ticks = 4) {
  if (!(max > 0)) return { top: 4, step: 1 };
  const raw = max / ticks;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((v) => v >= raw);
  return { top: Math.ceil(max / step) * step, step };
}

/** Stacked columns, one axis: the inline SVG of `trendRows(...)`. Each column is focusable and carries its numbers. */
export function chartSvg({ rows, actions }, width = 900) {
  const W = Math.max(300, Math.round(width));
  const H = 250;
  const pad = { top: 22, right: 8, bottom: 28, left: 46 };
  const pw = W - pad.left - pad.right;
  const ph = H - pad.top - pad.bottom;
  const { top, step } = niceScale(Math.max(0, ...rows.map((r) => r.total)));
  const y = (v) => pad.top + ph - (v / top) * ph;
  const band = pw / Math.max(1, rows.length);
  const bw = Math.max(2, Math.min(26, band * 0.66));
  let grid = '';
  for (let v = 0; v <= top + 1e-9; v += step) grid += `<line x1="${pad.left}" x2="${W - pad.right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" /><text x="${pad.left - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(credits(v))}</text>`;
  const peak = rows.reduce((best, r, i) => (r.total > (rows[best]?.total ?? -1) ? i : best), 0);
  const every = Math.max(1, Math.ceil(rows.length / Math.max(1, Math.floor(pw / 64))));
  const cols = rows
    .map((r, i) => {
      const x = pad.left + i * band + (band - bw) / 2;
      let base = pad.top + ph;
      const segs = actions.filter((a) => r.values[a] > 0);
      let out = '';
      segs.forEach((a, j) => {
        const h = (r.values[a] / top) * ph;
        const yy = base - h;
        const last = j === segs.length - 1;
        const rr = last ? Math.min(4, bw / 2, h) : 0;
        out += `<path class="bar-${ACTION_CLASS[a] ?? 'other'}" d="M${x.toFixed(1)},${base.toFixed(1)}V${(yy + rr).toFixed(1)}${rr ? `Q${x.toFixed(1)},${yy.toFixed(1)} ${(x + rr).toFixed(1)},${yy.toFixed(1)}` : ''}H${(x + bw - rr).toFixed(1)}${rr ? `Q${(x + bw).toFixed(1)},${yy.toFixed(1)} ${(x + bw).toFixed(1)},${(yy + rr).toFixed(1)}` : ''}V${base.toFixed(1)}Z" />`;
        base = yy - (last ? 0 : 1.5);
      });
      const peakLabel = i === peak && r.total > 0 ? `<text class="peak" x="${(x + bw / 2).toFixed(1)}" y="${(base - 6).toFixed(1)}" text-anchor="middle">${esc(credits(r.total))}</text>` : '';
      const label = i % every === 0 ? `<g class="axis"><text x="${(x + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(r.label)}</text></g>` : '';
      const aria = `${r.long}: ${actions.map((a) => `${credits(r.values[a])} ${ACTION_LABEL[a] ?? a}`).join(', ')}`;
      return `<g class="col" data-i="${i}" tabindex="0" role="img" aria-label="${esc(aria)}"><rect class="hit" x="${(pad.left + i * band).toFixed(1)}" y="${pad.top}" width="${band.toFixed(1)}" height="${ph}" />${out}${peakLabel}</g>${label}`;
    })
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" translate="no"><g class="grid axis">${grid}</g>${cols}</svg>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Columns of each table (cell = HTML, csv = text, report = HTML for the standalone report)
// ---------------------------------------------------------------------------------------------------------------

const isoDay = (iso) => (iso ? String(iso).slice(0, 10) : '');
const td = (html, cls = '') => `<td${cls ? ` class="${cls}"` : ''}>${html}</td>`;
const tdNum = (v) => `<td class="num" translate="no">${esc(credits(v))}</td>`;
const timeHtml = (text) => (text ? `<time translate="no">${esc(text)}</time>` : '<span class="hint">—</span>');
/** "Monthly · Enforce": each word on its own, so each is translated on its own. */
const pair = (a, b) => `<span>${esc(a)}</span> · <span>${esc(b)}</span>`;
/** "until Dec 15, 2026": the words translated, the date as it is. */
const dated = (words, date) => `<span>${esc(words)}</span> <time translate="no">${esc(date)}</time>`;

export function budgetColumns({ when = isoDay } = {}) {
  return [
    { id: 'who', label: 'Applies to', fixed: true, sort: (r) => r.entityLabel, cell: (r) => td(`${whoHtml(r.entityLabel, r.entityType)}${budgetWhy(r)}`, 'wrap gv-who-cell'), csv: (r) => r.entityLabel, report: (r) => `${esc(r.entityLabel)}<small>${esc(LEVEL_LABEL[r.entityType])}</small>` },
    { id: 'level', label: 'Level', off: true, sort: (r) => LEVEL_LABEL[r.entityType], cell: (r) => td(levelTag(r.entityType)), csv: (r) => LEVEL_LABEL[r.entityType], report: (r) => esc(LEVEL_LABEL[r.entityType]) },
    { id: 'period', label: 'Period', sort: (r) => periodText(r), cell: (r) => td(r.period === 'custom' ? `<span>${esc(PERIOD_LABEL.custom)}</span><span class="gv-why" translate="no">${esc(`${shortDate(r.customStart ?? r.start)} – ${shortDate(r.customEnd ?? r.end, { year: true }) || '…'}`)}</span>` : esc(PERIOD_LABEL[r.period] ?? r.period), 'wrap'), csv: (r) => periodText(r), report: (r) => esc(periodText(r)) },
    { id: 'budget', label: 'Budget', num: true, sort: (r) => r.limit, cell: (r) => `<td class="num"><span translate="no">${esc(credits(r.limit))}</span>${r.topUps?.length ? `<span class="gv-why">${esc(`+${credits(r.topUps.reduce((n, t) => n + Number(t.amount), 0))} top-up`)}</span>` : ''}</td>`, csv: (r) => r.limit, report: (r) => esc(credits(r.limit)) },
    { id: 'used', label: 'Used', num: true, sort: (r) => r.used, cell: (r) => tdNum(r.used), csv: (r) => r.used ?? '', report: (r) => esc(credits(r.used)) },
    { id: 'pct', label: 'Of the budget', title: 'Used, as a share of the budget; the tick is where it warns', sort: (r) => r.pct, cell: (r) => td(useBar(r), 'gv-use-cell'), csv: (r) => (r.pct ?? ''), csvLabel: 'Of the budget (%)', report: (r) => (r.pct === null || r.pct === undefined ? '—' : `${Math.round(r.pct)}%`) },
    { id: 'status', label: 'Status', sort: { value: (r) => STATUS_ORDER.indexOf(r.status), text: (r) => statusText(r.status) }, cell: (r) => td(statusBadge(r.status)), csv: (r) => statusText(r.status), report: (r) => esc(statusText(r.status)) },
    { id: 'mode', label: 'Mode', sort: (r) => MODE_LABEL[r.mode], cell: (r) => td(modeTag(r.mode)), csv: (r) => MODE_LABEL[r.mode] ?? r.mode, report: (r) => esc(MODE_LABEL[r.mode] ?? r.mode) },
    { id: 'updated', label: 'Updated', sort: { value: (r) => Date.parse(r.updatedAt ?? '') || 0, text: (r) => when(r.updatedAt) }, cell: (r) => td(`<span class="gv-why gv-flat" translate="no">${esc([shortDate(r.updatedAt), String(r.updatedBy ?? '').split('@')[0]].filter(Boolean).join(' · '))}</span>`), csv: (r) => r.updatedAt ?? '', report: (r) => esc(`${shortDate(r.updatedAt)} ${r.updatedBy ?? ''}`) },
    { id: 'warn', label: 'Warn at', num: true, off: true, sort: (r) => r.warnPct, cell: (r) => `<td class="num" translate="no">${esc(`${r.warnPct}%`)}</td>`, csv: (r) => r.warnPct, csvLabel: 'Warn at (%)', report: (r) => esc(`${r.warnPct}%`) },
    { id: 'daysLeft', label: 'Days left', num: true, off: true, sort: (r) => r.daysLeft ?? null, cell: (r) => tdNum(r.daysLeft), csv: (r) => r.daysLeft ?? '', report: (r) => esc(credits(r.daysLeft)) },
    { id: 'restrictions', label: 'Restrictions', num: true, off: true, sort: (r) => r.restrictions?.total ?? 0, cell: (r) => tdNum(r.restrictions?.total ?? 0), csv: (r) => r.restrictions?.total ?? 0, report: (r) => esc(credits(r.restrictions?.total ?? 0)) },
    { id: 'notes', label: 'Notes', off: true, sort: (r) => r.notes ?? '', cell: (r) => `<td class="wrap gv-notes" translate="no">${esc(r.notes ?? '')}</td>`, csv: (r) => r.notes ?? '', report: (r) => esc(r.notes ?? '') },
    { id: 'entityId', label: 'Checkmarx One id', off: true, sort: (r) => r.entityId, cell: (r) => `<td><span class="gv-mono" translate="no">${esc(r.entityId)}</span></td>`, csv: (r) => r.entityId, report: (r) => esc(r.entityId) },
  ];
}

/** A request's "waiting / decided" cell: the words translated, names and dates as they are. */
function decidedHtml(r, decided) {
  if (r.status === 'open') return `<span>${esc(decided(r))}</span>`;
  if (r.status === 'expired') return `<span>${esc('ended')}</span> <time translate="no">${esc(shortDate(r.decidedAt))}</time>`;
  if (r.status === 'cancelled') return `<span>${esc('withdrawn')}</span> <time translate="no">${esc(shortDate(r.decidedAt))}</time>`;
  return `<span translate="no">${esc(decided(r))}</span>`;
}

export function requestColumns({ when = isoDay, me = '' } = {}) {
  const forText = (r) => (r.entityType === 'user' && r.by === me ? 'Me' : r.entityLabel || r.entityId);
  const decided = (r) => {
    if (r.status === 'open') return waitingLabel(r.waitingMinutes);
    if (r.status === 'approved') return [credits(r.approvedAmount), shortDate(r.decidedAt), String(r.decidedBy ?? '').split('@')[0]].filter(Boolean).join(' · ');
    if (r.status === 'expired') return `ended ${shortDate(r.decidedAt)}`;
    if (r.status === 'cancelled') return `withdrawn ${shortDate(r.decidedAt)}`;
    return [shortDate(r.decidedAt), String(r.decidedBy ?? '').split('@')[0]].filter(Boolean).join(' · ');
  };
  const untilText = (r) => (r.until === 'period' ? 'End of period' : shortDate(r.until, { year: true }));
  return [
    { id: 'by', label: 'Asked by', fixed: true, sort: (r) => r.by, cell: (r) => `<td class="name" translate="no">${esc(r.by)}</td>`, csv: (r) => r.by, report: (r) => esc(r.by) },
    { id: 'status', label: 'Status', sort: (r) => REQUEST_STATUS[r.status]?.[0] ?? r.status, cell: (r) => td(requestBadge(r.status)), csv: (r) => REQUEST_STATUS[r.status]?.[0] ?? r.status, report: (r) => esc(REQUEST_STATUS[r.status]?.[0] ?? r.status) },
    { id: 'waiting', label: 'Waiting / decided', sort: { value: (r) => (r.status === 'open' ? 1e9 + (r.waitingMinutes ?? 0) : Date.parse(r.decidedAt ?? '') / 60000 || 0), text: decided }, cell: (r) => `<td${r.status === 'open' && r.waitingMinutes >= 1440 ? ' class="flush-warn"' : ''}>${decidedHtml(r, decided)}</td>`, csv: decided, report: (r) => esc(decided(r)) },
    { id: 'for', label: 'For', sort: forText, cell: (r) => td(r.entityType === 'user' && r.by === me ? `<span>${esc('Me')}</span>` : whoHtml(r.entityLabel || r.entityId, r.entityType)), csv: forText, report: (r) => esc(forText(r)) },
    { id: 'amount', label: 'Credits', num: true, sort: (r) => r.amount, cell: (r) => tdNum(r.amount), csv: (r) => r.amount, report: (r) => esc(credits(r.amount)) },
    { id: 'until', label: 'Until', sort: { value: (r) => (r.until === 'period' ? 0 : Date.parse(r.until) || 0), text: untilText }, cell: (r) => td(r.until === 'period' ? esc(untilText(r)) : timeHtml(untilText(r))), csv: (r) => (r.until === 'period' ? 'period' : r.until), report: (r) => esc(untilText(r)) },
    { id: 'why', label: 'Why', sort: (r) => r.reason, cell: (r) => `<td class="wrap gv-reason" translate="no">${esc(r.reason)}</td>`, csv: (r) => r.reason, report: (r) => esc(r.reason) },
    { id: 'asked', label: 'Asked', off: true, sort: { value: (r) => Date.parse(r.createdAt) || 0, text: (r) => when(r.createdAt) }, cell: (r) => td(timeHtml(when(r.createdAt))), csv: (r) => r.createdAt, report: (r) => esc(when(r.createdAt)) },
    { id: 'approved', label: 'Approved', num: true, off: true, sort: (r) => r.approvedAmount ?? null, cell: (r) => tdNum(r.approvedAmount), csv: (r) => r.approvedAmount ?? '', report: (r) => esc(credits(r.approvedAmount)) },
  ];
}

export function restrictionColumns({ when = isoDay, canRestore = false } = {}) {
  const what = (r) => (r.kind === 'grace' ? 'Nothing removed now' : KIND_LABEL[r.kind] ?? r.what);
  const because = (r) => r.because.map((b) => b.label).join(', ');
  const cols = [
    { id: 'who', label: 'Applies to', fixed: true, sort: (r) => r.label, cell: (r) => td(whoHtml(r.label || r.targetId, r.targetType), 'wrap gv-who-cell'), csv: (r) => r.label || r.targetId, report: (r) => esc(r.label || r.targetId) },
    { id: 'what', label: 'What', sort: what, cell: (r) => td(`<span>${esc(what(r))}</span>${r.kind === 'user_roles' && r.partial?.length ? `<span class="gv-why" translate="no">${esc(r.partial.join('; '))}</span>` : ''}`, 'wrap'), csv: what, report: (r) => esc(what(r)) },
    { id: 'because', label: 'Because of', sort: because, cell: (r) => `<td class="wrap"><span translate="no">${esc(because(r))}</span>${r.usedLine ? `<span class="gv-why" translate="no">${esc(r.usedLine)}</span>` : ''}</td>`, csv: because, report: (r) => esc(because(r)) },
    { id: 'since', label: 'Since', sort: { value: (r) => Date.parse(r.since ?? '') || 0, text: (r) => when(r.since) }, cell: (r) => td(r.kind === 'grace' ? `<span>${esc('Restored')}</span> ${timeHtml(when(r.since))}` : timeHtml(when(r.since))), csv: (r) => r.since ?? '', report: (r) => esc(when(r.since)) },
    { id: 'restore', label: 'Restore', title: 'Exact: back to what it was before. Default: Checkmarx One\'s default.', sort: (r) => (r.restoreMode === 'default' ? 'Default' : r.kind === 'grace' ? '' : 'Exact'), cell: (r) => td(r.kind === 'grace' ? '<span class="hint">—</span>' : esc(r.restoreMode === 'default' ? 'Default' : 'Exact')), csv: (r) => r.restoreMode ?? '', report: (r) => esc(r.restoreMode ?? '') },
    {
      id: 'state',
      label: 'State',
      sort: (r) => HOLD_STATE[r.state]?.[0] ?? r.state,
      cell: (r) => {
        if (r.kind === 'grace') return td(`${holdBadge(r.state)}<span class="gv-why"><span>${esc(`Until usage grows past ${credits(r.graceUsage)}`)}</span>${r.graceUntil ? `<span>,</span> ${dated('or', shortDate(r.graceUntil, { year: true }))}` : ''}</span>`, 'wrap');
        const why = r.state === 'partial' ? r.partial?.[0] : r.state === 'failed' ? r.error : r.state === 'skipped' ? r.note : '';
        return td(`${holdBadge(r.state)}${why ? `<span class="gv-why${r.state === 'partial' ? ' warn' : ''}" translate="no">${esc(why)}</span>` : ''}`, 'wrap');
      },
      csv: (r) => HOLD_STATE[r.state]?.[0] ?? r.state,
      report: (r) => esc(HOLD_STATE[r.state]?.[0] ?? r.state),
    },
  ];
  if (canRestore) cols.push({ id: 'act', label: '', fixed: true, cell: (r) => td(r.kind === 'grace' || r.state === 'release_pending' ? '' : `<button type="button" class="sm" data-gv-restore="${esc(r.key)}">${esc('Restore')}</button>`, 'gv-act'), csv: null, report: null });
  return cols;
}

/** A delivery's words: "Email sent", "Webhook failed 2×", "Email waiting". */
export function deliveryText(channel, d) {
  const c = CHANNEL_LABEL[channel] ?? channel;
  if (!d) return '';
  if (d.status === 'sent') return `${c} sent`;
  if (d.status === 'failed') return d.attempts > 1 ? `${c} failed ${d.attempts}×, retrying` : `${c} failed, retrying`;
  if (d.status === 'given_up') return `${c} not delivered`;
  return `${c} waiting`;
}
const deliveryCls = (d) => (d.status === 'sent' ? '' : d.status === 'failed' || d.status === 'given_up' ? 'bad' : 'muted');

export function alertColumns({ when = isoDay } = {}) {
  const deliveries = (a) => Object.entries(a.delivery ?? {}).map(([ch, d]) => [ch, d]);
  return [
    { id: 'severity', label: 'Severity', sort: { value: (a) => ['info', 'warning', 'error', 'critical'].indexOf(a.severity), text: (a) => SEVERITY_LABEL[a.severity] ?? a.severity }, cell: (a) => td(`<span class="gv-sev ${esc(a.severity)}">${esc(SEVERITY_LABEL[a.severity] ?? a.severity)}</span>`), csv: (a) => SEVERITY_LABEL[a.severity] ?? a.severity, report: (a) => esc(SEVERITY_LABEL[a.severity] ?? a.severity) },
    { id: 'when', label: 'When', sort: { value: (a) => Date.parse(a.at) || 0, text: (a) => when(a.at) }, cell: (a) => td(timeHtml(when(a.at))), csv: (a) => a.at, report: (a) => esc(when(a.at)) },
    { id: 'alert', label: 'Alert', fixed: true, sort: (a) => a.title, cell: (a) => `<td class="wrap gv-alert"><strong translate="no">${esc(a.title)}</strong>${a.body ? `<span class="gv-why" translate="no">${esc(a.body)}</span>` : ''}</td>`, csv: (a) => `${a.title}${a.body ? ` — ${a.body}` : ''}`, report: (a) => `${esc(a.title)}<small>${esc(a.body ?? '')}</small>` },
    { id: 'category', label: 'Category', sort: (a) => CATEGORY_LABEL[a.category] ?? a.category, cell: (a) => td(esc(CATEGORY_LABEL[a.category] ?? a.category)), csv: (a) => CATEGORY_LABEL[a.category] ?? a.category, report: (a) => esc(CATEGORY_LABEL[a.category] ?? a.category) },
    { id: 'delivery', label: 'Delivery', sort: (a) => deliveries(a).map(([ch, d]) => deliveryText(ch, d)).join(' '), cell: (a) => td(`<div class="gv-deliv">${deliveries(a).map(([ch, d]) => `<span class="badge ${deliveryCls(d)}"${d.lastError ? ` title="${esc(d.lastError)}"` : ''}>${esc(deliveryText(ch, d))}</span>`).join('') || '<span class="hint">—</span>'}</div>`), csv: (a) => deliveries(a).map(([ch, d]) => deliveryText(ch, d)).join('; '), report: (a) => esc(deliveries(a).map(([ch, d]) => deliveryText(ch, d)).join(', ')) },
    { id: 'entity', label: 'About', off: true, sort: (a) => a.entity?.label ?? '', cell: (a) => td(a.entity ? whoHtml(a.entity.label || a.entity.id, a.entity.type) : '<span class="hint">—</span>'), csv: (a) => a.entity?.label ?? '', report: (a) => esc(a.entity?.label ?? '') },
  ];
}

export function attributionColumns({ canDecide = false } = {}) {
  const towards = (r) => (r.entityId ? r.entityLabel || r.entityId : 'Nobody');
  return [
    { id: 'reported', label: 'Reported as', fixed: true, sort: (r) => r.name || r.email, cell: (r) => td(`<div class="gv-who"><span class="gv-mono" translate="no">${esc(r.name || r.email || r.subjectKey)}</span>${levelTag(r.dimension)}</div>${r.email && r.name && r.email !== r.name ? `<span class="gv-why" translate="no">${esc(r.email)}</span>` : ''}`, 'wrap'), csv: (r) => r.name || r.email, report: (r) => esc(r.name || r.email) },
    { id: 'credits', label: 'Credits', num: true, sort: (r) => r.credits, cell: (r) => tdNum(r.credits), csv: (r) => r.credits, report: (r) => esc(credits(r.credits)) },
    {
      id: 'towards',
      label: 'Counts towards',
      sort: towards,
      cell: (r) => td(`${r.entityId ? `<b class="gv-towards" translate="no">${esc(r.entityLabel || r.entityId)}</b>` : `<span class="badge gv-dashed">${esc('Nobody')}</span>`}<span class="gv-why">${esc(MATCH_LABEL[r.status] ?? r.status)}</span>${r.ghost ? `<span class="gv-why warn">${esc('Mapped to someone no longer in Checkmarx One: map again or clear')}</span>` : ''}`, 'wrap'),
      csv: towards,
      report: (r) => esc(towards(r)),
    },
    { id: 'suggestions', label: 'Suggestions', sort: (r) => r.suggestions?.map((s) => s.label).join(' ') ?? '', cell: (r) => td(r.suggestions?.length ? r.suggestions.map((s, i) => `<span class="gv-sugg${i === 0 ? ' top' : ''}" translate="no">${esc(s.label)}<em>${Math.round(Number(s.score) * 100)}%</em></span>`).join('') : '<span class="hint">—</span>', 'wrap'), csv: (r) => (r.suggestions ?? []).map((s) => `${s.label} ${Math.round(s.score * 100)}%`).join('; '), report: (r) => esc((r.suggestions ?? []).map((s) => `${s.label} ${Math.round(s.score * 100)}%`).join(', ')) },
    ...(canDecide
      ? [{
          id: 'act',
          label: '',
          fixed: true,
          cell: (r) => td(`<div class="gv-row-acts"><button type="button" class="sm" data-gv-map="${esc(r.key)}">${esc('Map…')}</button>${r.entityId && r.status !== 'pinned' ? `<button type="button" class="sm" data-gv-decide="reject" data-key="${esc(r.key)}">${esc('Reject this match')}</button>` : ''}${r.status !== 'ignored' ? `<button type="button" class="sm" data-gv-decide="ignore" data-key="${esc(r.key)}">${esc('Ignore')}</button>` : ''}${r.decision ? `<button type="button" class="sm" data-gv-decide="clear" data-key="${esc(r.key)}">${esc('Clear')}</button>` : ''}</div>`, 'gv-act'),
          csv: null,
          report: null,
        }]
      : []),
  ];
}

export function topColumns(level) {
  return [
    { id: 'rank', label: '#', num: true, fixed: true, sort: (r) => r.rank, cell: (r) => `<td class="num" translate="no">${r.rank}</td>`, csv: (r) => r.rank, report: (r) => String(r.rank) },
    { id: 'name', label: LEVEL_LABEL[level] ?? 'Name', fixed: true, sort: (r) => r.label, cell: (r) => `<td class="name" translate="no">${esc(r.label || r.entityId)}</td>`, csv: (r) => r.label || r.entityId, report: (r) => esc(r.label || r.entityId) },
    { id: 'budget', label: 'Budget', num: true, sort: (r) => r.limit, cell: (r) => tdNum(r.limit), csv: (r) => r.limit ?? '', report: (r) => esc(credits(r.limit)) },
    { id: 'used', label: 'Used', num: true, title: 'This period\'s use when it has a budget, else what Checkmarx One reports over the lookback window', sort: (r) => r.used ?? r.credits, cell: (r) => tdNum(r.used ?? r.credits), csv: (r) => r.used ?? r.credits, report: (r) => esc(credits(r.used ?? r.credits)) },
    { id: 'pct', label: 'Of the budget', sort: (r) => r.pct, cell: (r) => td(useBar(r), 'gv-use-cell'), csv: (r) => r.pct ?? '', csvLabel: 'Of the budget (%)', report: (r) => (r.pct === null || r.pct === undefined ? '—' : `${Math.round(r.pct)}%`) },
    { id: 'status', label: 'Status', sort: { value: (r) => STATUS_ORDER.indexOf(r.status ?? 'none'), text: (r) => statusText(r.status ?? 'none') }, cell: (r) => td(statusBadge(r.status ?? 'none')), csv: (r) => statusText(r.status ?? 'none'), report: (r) => esc(statusText(r.status ?? 'none')) },
    { id: 'mode', label: 'Mode', sort: (r) => MODE_LABEL[r.mode] ?? '', cell: (r) => td(r.mode ? modeTag(r.mode) : '<span class="hint">—</span>'), csv: (r) => MODE_LABEL[r.mode] ?? '', report: (r) => esc(MODE_LABEL[r.mode] ?? '') },
    { id: 'window', label: 'Lookback window', num: true, off: true, title: 'What Checkmarx One reports over the lookback window', sort: (r) => r.credits, cell: (r) => tdNum(r.credits), csv: (r) => r.credits, report: (r) => esc(credits(r.credits)) },
  ];
}

/** The import check's rows: what each line of the file changes (old struck through → new). */
export function changeText(c) {
  const v = (x) => (x === null || x === undefined || x === '' ? '—' : typeof x === 'boolean' ? (x ? 'Yes' : 'No') : String(x));
  return `${csvFieldLabel(c.field)}: ${c.before === null || c.before === undefined ? '' : `${v(c.before)} → `}${v(c.after)}`;
}
export function importColumns({ labelOf = (r) => r.entityId } = {}) {
  const ACT = { create: ['Create', 'gv-info'], update: ['Update', 'warn'], unchanged: ['Unchanged', 'muted'], delete: ['Delete', 'bad'], error: ['Not valid', 'bad'] };
  const v = (x) => (x === null || x === undefined || x === '' ? '—' : typeof x === 'boolean' ? (x ? 'Yes' : 'No') : String(x));
  return [
    { id: 'line', label: 'Row', num: true, fixed: true, sort: (r) => r.line, cell: (r) => `<td class="num" translate="no">${r.line}</td>`, csv: (r) => r.line, report: (r) => String(r.line) },
    { id: 'action', label: 'Change', sort: (r) => ACT[r.action]?.[0] ?? r.action, cell: (r) => td(`<span class="badge ${ACT[r.action]?.[1] ?? ''}">${esc(ACT[r.action]?.[0] ?? r.action)}</span>`), csv: (r) => ACT[r.action]?.[0] ?? r.action, report: (r) => esc(ACT[r.action]?.[0] ?? r.action) },
    { id: 'who', label: 'Applies to', sort: (r) => labelOf(r), cell: (r) => td(r.entityType ? whoHtml(labelOf(r), r.entityType) : '<span class="hint">—</span>'), csv: (r) => labelOf(r), report: (r) => esc(labelOf(r)) },
    {
      id: 'changes',
      label: 'What changes',
      cell: (r) => {
        if (r.action === 'error') return `<td class="wrap"><span class="gv-chg bad-text" translate="no">${esc(r.error)}</span></td>`;
        if (r.action === 'delete') return `<td class="wrap"><span class="gv-chg">${esc('The budget is deleted; its restrictions are lifted')}</span></td>`;
        if (!r.changes?.length) return `<td class="wrap"><span class="gv-chg">${esc('Same as now')}</span></td>`;
        return `<td class="wrap">${r.changes.map((c) => `<span class="gv-chg"><i>${esc(csvFieldLabel(c.field))}</i><span translate="no">${c.before === null || c.before === undefined || r.action === 'create' ? '' : `<s>${esc(v(c.before))}</s> → `}<ins>${esc(v(c.after))}</ins></span></span>`).join('')}</td>`;
      },
      csv: (r) => (r.action === 'error' ? r.error : (r.changes ?? []).map(changeText).join('; ')),
      report: (r) => esc(r.action === 'error' ? r.error : (r.changes ?? []).map(changeText).join('; ')),
    },
  ];
}

/** What a table shows, as CSV: its columns in their order (those with a csv), every row the filters leave. */
export function tableRows(rows, cols) {
  const use = cols.filter((c) => c.csv);
  return [use.map((c) => c.csvLabel ?? c.label), ...rows.map((r) => use.map((c) => c.csv(r) ?? ''))];
}
export const tableCsv = (rows, cols) => csvText(tableRows(rows, cols));
/** The same as a standalone HTML report. */
export function tableReport({ title, sub = '', figures = [], rows, cols }) {
  const use = cols.filter((c) => c.report);
  return reportHtml({ title, sub, figures, tables: [{ head: use.map((c) => ({ label: c.csvLabel ?? c.label, num: c.num })), rows: rows.map((r) => ({ cells: use.map((c) => c.report(r)) })) }] });
}

// ---------------------------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------------------------

const POLL_MS = 60_000;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function initGovern({ api, $, toast, showError, setStatus, fmtDateTime, t = (s) => s, handleAuthLoss = () => false, active = () => true, me = () => null }) {
  const page = $('page-govern');
  if (!page) return { load() {}, tabShown() {}, close() {} };
  const when = (iso) => (iso ? fmtDateTime(iso) : '');
  const S = {
    me: null,
    overview: null,
    budgets: null,
    requests: null,
    requestCounts: null,
    restrictions: null,
    alerts: null,
    attribution: null,
    attributionCounts: null,
    settings: null,
    permissions: null,
    runs: null,
    tab: '',
    run: null,
    loading: false,
  };
  const perms = () => S.me?.permissions ?? [];
  const has = (p) => perms().includes(p);
  const selfEmail = () => String(S.me?.email ?? '').toLowerCase();

  // ---- Reading: one cache per address, sent back as If-None-Match; a 304 (or the same body) redraws nothing ----
  const cache = new Map();
  async function read(path) {
    const prev = cache.get(path);
    const response = await fetch(path, { credentials: 'same-origin', headers: prev?.etag ? { 'If-None-Match': prev.etag } : {} });
    if (response.status === 304 && prev) return { data: prev.data, changed: false };
    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {}
    if (!response.ok) {
      const error = new Error(body.error || `${response.status} ${response.statusText}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    const same = prev && prev.text === text;
    cache.set(path, { etag: response.headers.get('etag'), data: same ? prev.data : body, text });
    return { data: same ? prev.data : body, changed: !same };
  }
  const write = (path, method, body, extra = {}) => api(path, { method, body: body === undefined ? undefined : JSON.stringify(body), ...extra });

  // ---- The compact top: the last cycle, Run now, the figures line, the tab counts ----
  function renderTop() {
    const f = S.overview?.figures;
    const running = Boolean(S.run) || S.me?.running;
    const cycle = $('gv-cycle');
    if (S.me && !isPersonal(perms()) && f) {
      const last = f.lastCycle;
      const parts = [];
      if (running) parts.push(`<span class="gv-running">${esc('A cycle is running…')}</span>`);
      else if (last) parts.push(`<span>${esc('Last cycle')}</span> <b>${esc(ago(last.finishedAt ?? last.startedAt))}</b>${last.status && last.status !== 'success' ? ` <span class="badge ${last.status === 'failed' ? 'bad' : 'warn'}">${esc(last.status === 'failed' ? 'Failed' : last.status === 'partial' ? 'Partly read' : last.status)}</span>` : ''}`);
      else parts.push(`<span>${esc('No cycle has run yet')}</span>`);
      if (f.nextRunAt && !running) parts.push(`<span>· ${esc(`next ${inLabel(f.nextRunAt)}`)}</span>`);
      else if (!f.nextRunAt && !running) parts.push(`<span>· ${esc('cycles are off')}</span>`);
      cycle.innerHTML = parts.join(' ');
    } else cycle.innerHTML = '';
    const run = $('gv-run');
    run.hidden = !mayRun(perms());
    run.disabled = running;
    run.textContent = running ? 'Running…' : 'Run now';
    renderFigures();
    const count = (id, n) => {
      const el = $(id);
      if (el) el.textContent = n ? num(n) : '';
    };
    count('gv-n-budgets', S.budgets?.total ?? f?.budgets);
    count('gv-n-requests', S.requestCounts?.open);
    count('gv-n-restrictions', S.restrictions?.items?.length ?? 0);
    count('gv-n-attribution', S.attributionCounts ? S.attributionCounts.disputes + S.attributionCounts.unmatched : S.overview?.banners ? S.overview.banners.unattributed.subjects : 0);
  }

  function renderFigures() {
    const box = $('gv-figs');
    const item = (label, value, { cls = '', small = '', title = '' } = {}) => `<span${cls ? ` class="${cls}"` : ''}${title ? ` title="${esc(title)}"` : ''}><span>${esc(label)}</span> <b translate="no">${esc(value)}</b>${small ? ` <small>${small}</small>` : ''}</span>`;
    const o = S.overview;
    if (!o) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    if (o.personal) {
      const b = o.budget;
      box.innerHTML = [
        item('Your budget', b ? credits(b.limit) : '—', { small: b ? esc(PERIOD_LABEL[b.period] ?? b.period) : esc('none set') }),
        item('Used', credits(b?.used ?? o.usage?.reported ?? null), { small: b?.pct !== null && b?.pct !== undefined ? `<span translate="no">${Math.round(b.pct)}%</span>` : '' }),
        b && b.used !== null ? item('Left', credits(Math.max(0, b.limit - b.used)), { cls: b.used >= b.limit ? 'is-bad' : '' }) : '',
        item('Open requests', num((o.requests ?? []).filter((r) => r.status === 'open').length)),
      ].join('');
      return;
    }
    const f = o.figures;
    const tc = f.tenantCredits;
    const partly = S.budgets?.items ? S.budgets.items.filter((b) => b.status === 'partial').length : 0;
    box.innerHTML = [
      tc ? item('Tenant credits', credits(tc.total), { title: 'From Checkmarx One: the tenant\'s credits', small: `<span translate="no">${esc(credits(tc.used))}</span> <span>${esc('used')}</span> · <span translate="no">${esc(credits(tc.available))}</span> <span>${esc('available')}</span>` }) : item('Tenant credits', '—', { title: 'Not read from Checkmarx One yet' }),
      '<span class="gv-sep" aria-hidden="true"></span>',
      item('In the pool', f.pool?.limit ? credits(f.pool.limit) : '—', { title: 'The credits CxMissionZero may spend (Credit Control)' }),
      item('Assigned to budgets', credits(f.assigned), { cls: f.overPool ? 'is-warn' : '', small: f.overPool ? esc(`${credits(f.overPool)} over the pool`) : '' }),
      item('Used this period', credits(f.usedThisPeriod)),
      item('Near limit', num(f.near), { cls: f.near ? 'is-warn' : '' }),
      item('Restricted budgets', num(f.restricted), { cls: f.restricted ? 'is-bad' : '', small: partly ? esc(`${partly} partly`) : '' }),
    ].join('');
  }

  // ---- Generic table: columns, search, sort & filter, selection, row click, exports ----
  function makeTable(cfg) {
    const sel = new Set();
    const byId = new Map();
    let shown = [];
    let limit = cfg.limit ?? 200;
    const table = $(cfg.table);
    const colsOf = () => shownColumns(cfg.key, cfg.all());
    const ticks = () => (typeof cfg.select === 'function' ? cfg.select() : Boolean(cfg.select));
    const ctl = {
      sel,
      get shown() {
        return shown;
      },
      cols: colsOf,
      selected: () => [...sel].map((id) => byId.get(id)).filter(Boolean),
      clear() {
        sel.clear();
        ctl.render();
      },
      render() {
        if (cfg.menu) columnMenu($(cfg.menu), cfg.key, cfg.all(), () => ctl.render());
        const cols = colsOf();
        const tick = ticks();
        const sign = `${tick ? 'tick|' : ''}${cols.map((c) => `${c.id}:${c.label}`).join('|')}`;
        const ttKey = `${cfg.key}:${tick ? 'tick,' : ''}${cols.map((c) => c.id).join(',')}`;
        const tr = table.tHead.rows[0];
        if (tr.dataset.cols !== sign) {
          tr.dataset.cols = sign;
          table.dataset.tt = ttKey;
          tr.innerHTML = `${tick ? `<th class="checkbox flush-tick"><input type="checkbox" data-gv-all aria-label="${esc('Select every row shown')}" /></th>` : ''}${cols.map((c) => `<th${c.num ? ' class="num"' : ''}${c.title ? ` title="${esc(c.title)}"` : ''}>${esc(c.label)}</th>`).join('')}`;
        }
        const items = cfg.rows();
        const span = cols.length + (tick ? 1 : 0);
        if (items === null || items === undefined) {
          table.tBodies[0].innerHTML = `<tr class="empty"><td colspan="${span}" class="hint">${esc(cfg.loading ?? 'Loading…')}</td></tr>`;
          shown = [];
          cfg.changed?.();
          return;
        }
        byId.clear();
        for (const r of items) byId.set(String(cfg.id(r)), r);
        for (const id of [...sel]) if (!byId.has(id)) sel.delete(id);
        const words = cfg.search ? $(cfg.search).value.toLowerCase().split(',').map((w) => w.trim()).filter(Boolean) : [];
        const found = words.length ? items.filter((r) => words.some((w) => cfg.text(r).toLowerCase().includes(w))) : items;
        const sorted = sortAndFilter(ttKey, found, [...(tick ? [null] : []), ...cols.map((c) => c.sort ?? null)], () => ctl.render());
        shown = sorted;
        const row = (r) => {
          const id = String(cfg.id(r));
          const cls = ['gv-row', cfg.open ? 'flush-row' : '', sel.has(id) ? 'is-open' : '', cfg.rowCls?.(r) ?? ''].filter(Boolean).join(' ');
          return `<tr data-gv-id="${esc(id)}"${cfg.open ? ' tabindex="0"' : ''} class="${cls}">${tick ? `<td class="checkbox flush-tick"><input type="checkbox" data-gv-tick aria-label="${esc('Select')}"${sel.has(id) ? ' checked' : ''} /></td>` : ''}${cols.map((c) => c.cell(r)).join('')}</tr>`;
        };
        let html = sorted.slice(0, limit).map(row).join('');
        if (sorted.length > limit) html += `<tr class="gv-more"><td colspan="${span}"><button type="button" class="link" data-gv-more>${esc(`Show ${num(Math.min(200, sorted.length - limit))} more`)}</button> <span class="hint">${esc(`${num(limit)} of ${num(sorted.length)} shown`)}</span></td></tr>`;
        table.tBodies[0].innerHTML = html || `<tr class="empty"><td colspan="${span}" class="hint">${esc(items.length ? 'Nothing matches the search or filters.' : cfg.empty?.() ?? 'Nothing here yet.')}</td></tr>`;
        const all = table.querySelector('[data-gv-all]');
        if (all) {
          const n = sorted.filter((r) => sel.has(String(cfg.id(r)))).length;
          all.checked = n > 0 && n === sorted.length;
          all.indeterminate = n > 0 && n < sorted.length;
          all.disabled = !sorted.length;
        }
        cfg.changed?.();
      },
      csv(name) {
        save(`${name}-${stamp()}.csv`, tableCsv(shown, colsOf()), 'text/csv');
        toast('CSV saved: the rows and columns the table shows.', 'ok', 2500);
      },
      html(name, title, sub = '') {
        save(`${name}-${stamp()}.html`, tableReport({ title, sub, figures: figuresList(), rows: shown, cols: colsOf() }), 'text/html');
      },
    };
    table.addEventListener('change', (event) => {
      if (event.target.matches('[data-gv-all]')) {
        for (const r of shown) {
          const id = String(cfg.id(r));
          if (event.target.checked) sel.add(id);
          else sel.delete(id);
        }
        ctl.render();
      } else if (event.target.matches('[data-gv-tick]')) {
        const id = event.target.closest('tr').dataset.gvId;
        if (event.target.checked) sel.add(id);
        else sel.delete(id);
        event.target.closest('tr').classList.toggle('is-open', event.target.checked);
        ctl.render();
      }
    });
    table.addEventListener('click', (event) => {
      if (event.target.closest('[data-gv-more]')) {
        limit += 200;
        return ctl.render();
      }
      if (!cfg.open || event.target.closest('a, button, input, select, label, textarea, .tt-tools, td.checkbox')) return;
      const tr = event.target.closest('tr[data-gv-id]');
      const r = tr && byId.get(tr.dataset.gvId);
      if (r) cfg.open(r);
    });
    table.addEventListener('keydown', (event) => {
      if (!cfg.open || (event.key !== 'Enter' && event.key !== ' ') || !event.target.matches?.('tr[data-gv-id]')) return;
      event.preventDefault();
      const r = byId.get(event.target.dataset.gvId);
      if (r) cfg.open(r);
    });
    if (cfg.search) $(cfg.search).addEventListener('input', () => ((limit = cfg.limit ?? 200), ctl.render()));
    return ctl;
  }

  /** The figures for an HTML report's strip (what the figures line shows). */
  function figuresList() {
    const f = S.overview?.figures;
    if (!f) return [];
    return [['Tenant credits', credits(f.tenantCredits?.total)], ['In the pool', credits(f.pool?.limit || null)], ['Assigned to budgets', credits(f.assigned)], ['Used this period', credits(f.usedThisPeriod)], ['Near limit', num(f.near)], ['Restricted budgets', num(f.restricted)]];
  }

  // ---- The side panel: one at a time, focus kept inside, Esc closes, focus goes back where it was ----
  const drawer = $('gv-drawer');
  let returnFocus = null;
  let onClose = null;
  function openSide({ title, sub = '', head = '', body = '', foot = '', ready, closed, wide = false }) {
    if (drawer.hidden) returnFocus = document.activeElement;
    onClose = closed ?? null;
    $('gv-side-title').innerHTML = title;
    $('gv-side-sub').innerHTML = sub;
    $('gv-side-sub').hidden = !sub;
    $('gv-side-head').innerHTML = head;
    $('gv-side-body').innerHTML = body;
    $('gv-side-foot').innerHTML = foot;
    $('gv-side-foot').hidden = !foot;
    drawer.classList.toggle('gv-wide', wide);
    drawer.hidden = false;
    document.body.classList.add('sheet-open');
    $('gv-side-body').scrollTop = 0;
    ready?.(drawer);
    requestAnimationFrame(() => (drawer.querySelector('.gv-form [autofocus]') ?? drawer.querySelector('[data-gv-close].icon-btn'))?.focus());
  }
  function closeSide() {
    if (drawer.hidden) return;
    drawer.hidden = true;
    document.body.classList.remove('sheet-open');
    const done = onClose;
    onClose = null;
    done?.();
    if (returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
  }
  for (const el of drawer.querySelectorAll('[data-gv-close]')) el.addEventListener('click', closeSide);
  drawer.addEventListener('click', (event) => {
    if (event.target.closest('[data-gv-cancel]')) closeSide();
  });
  drawer.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeSide();
      return;
    }
    if (event.key !== 'Tab') return;
    const list = [...drawer.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !drawer.hidden && !document.querySelector('dialog[open]')) closeSide();
  });

  // ---- A small dialog: a question, maybe a field or two; resolves with the form's values, or null ----
  const dialog = $('gv-dialog');
  function ask({ title, body = '', confirm = 'OK', danger = false }) {
    return new Promise((resolve) => {
      $('gv-dialog-title').textContent = title;
      $('gv-dialog-body').innerHTML = body;
      const go = $('gv-dialog-go');
      go.textContent = confirm;
      go.className = danger ? 'danger-soft' : 'primary';
      dialog.returnValue = '';
      const done = () => {
        dialog.removeEventListener('close', done);
        if (dialog.returnValue !== 'go') return resolve(null);
        const out = {};
        for (const el of dialog.querySelectorAll('[name]')) out[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'radio' ? (el.checked ? el.value : out[el.name]) : el.value;
        resolve(out);
      };
      dialog.addEventListener('close', done);
      dialog.showModal();
      (dialog.querySelector('#gv-dialog-body [autofocus], #gv-dialog-body input, #gv-dialog-body textarea') ?? go).focus();
    });
  }

  // ---- The entity picker (budgets, requests, attribution): type to search; arrows and Enter choose ----
  function picker(root, { type, onPick, exclude = () => false }) {
    const input = root.querySelector('[data-gv-pick-q]');
    const list = root.querySelector('[data-gv-pick-list]');
    let items = [];
    let at = 0;
    let timer = null;
    let seq = 0;
    const draw = () => {
      list.hidden = !items.length && !input.value;
      list.innerHTML = items.length
        ? items.map((it, i) => `<div role="option" id="gv-opt-${i}" data-i="${i}" aria-selected="${i === at}" class="${i === at ? 'on' : ''}${exclude(it) ? ' is-taken' : ''}"><span translate="no">${esc(it.label)}</span><small>${esc(it.exempt ? 'exempt' : it.hasBudget ? 'has a budget' : 'no budget')}</small></div>`).join('')
        : `<div class="hint">${esc(input.value ? 'Nobody by that name in what Govern read.' : '')}</div>`;
      input.setAttribute('aria-activedescendant', items.length ? `gv-opt-${at}` : '');
    };
    const search = async () => {
      const mine = ++seq;
      try {
        const r = await read(`/api/govern/entities?type=${encodeURIComponent(type())}&q=${encodeURIComponent(input.value.trim())}`);
        if (mine !== seq) return;
        items = r.data.items ?? [];
        at = 0;
        draw();
      } catch (error) {
        list.hidden = false;
        list.innerHTML = `<div class="status error">${esc(error.message)}</div>`;
      }
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(search, 180);
    });
    input.addEventListener('focus', () => {
      if (!items.length) search();
      else list.hidden = false;
    });
    input.addEventListener('blur', () => setTimeout(() => (list.hidden = true), 150));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!items.length) return;
        at = (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        draw();
      } else if (event.key === 'Enter' && items[at]) {
        event.preventDefault();
        onPick(items[at]);
      }
    });
    list.addEventListener('mousedown', (event) => event.preventDefault());
    list.addEventListener('click', (event) => {
      const el = event.target.closest('[data-i]');
      if (el) onPick(items[Number(el.dataset.i)]);
    });
    return { refresh: () => ((items = []), (input.value = ''), draw(), search()), clear: () => ((items = []), draw()) };
  }
  const pickerHtml = (label, id) => `<label class="field gv-picker"><span>${esc(label)}</span><input type="search" data-gv-pick-q id="${id}" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="${id}-list" placeholder="${esc('Type to search')}" /><div class="gv-pick" role="listbox" id="${id}-list" data-gv-pick-list hidden></div></label>`;

  // =============================================================================================================
  // Overview
  // =============================================================================================================

  let range = 'period';
  let topLevel = 'user';
  const topTable = makeTable({
    table: 'gv-top-table',
    key: 'govern-top',
    all: () => topColumns(topLevel),
    rows: () => topRows(),
    id: (r) => r.entityId,
    open: (r) => {
      const b = r.budgetId && S.budgets?.items?.find((x) => x.id === r.budgetId);
      if (b) openBudget(b);
      else if (has('govern.budgets')) openBudget(null, { entityType: topLevel, entityId: r.entityId, entityLabel: r.label });
    },
    empty: () => 'No usage reported at this level yet.',
    menu: 'gv-top-cols',
  });
  function topRows() {
    const list = S.overview?.top?.[topLevel];
    if (!list) return S.overview ? [] : null;
    return list.map((r, i) => ({ ...r, rank: i + 1, mode: r.budgetId ? S.budgets?.items?.find((b) => b.id === r.budgetId)?.mode ?? '' : '', warnPct: r.budgetId ? S.budgets?.items?.find((b) => b.id === r.budgetId)?.warnPct ?? 80 : 80 }));
  }

  function renderOverview() {
    const o = S.overview;
    const personal = Boolean(o?.personal);
    $('gv-personal').hidden = !personal;
    for (const id of ['gv-pool', 'gv-trend', 'gv-topc']) $(id).hidden = personal || !o;
    if (!o) return;
    if (personal) return renderPersonal();
    renderBanners();
    renderPool();
    renderTrend();
    const notReported = o.banners?.notReported?.includes(topLevel) && !o.top?.[topLevel];
    $('gv-top-note').hidden = !notReported;
    $('gv-top-note').textContent = notReported ? `Checkmarx One does not report usage per ${topLevel} for this tenant: nothing is assumed zero.` : '';
    topTable.render();
    const more = $('gv-top-more');
    more.innerHTML = o.top?.[topLevel]?.length ? `<span>${esc(`Top ${o.top[topLevel].length} by credits used in the lookback window.`)}</span> ${has('govern.view') ? `<button type="button" class="link" data-gv-goto="budgets" data-level="${topLevel}">${esc('All budgets →')}</button>` : ''}` : '';
  }

  function renderBanners() {
    const o = S.overview;
    const b = o.banners ?? {};
    const out = [];
    const NOT_REPORTED = {
      user: 'User budgets show “Not reported”: nothing is assumed zero.',
      project: 'Project budgets show “Not reported”: nothing is assumed zero.',
      group: 'Group budgets add up their projects\' usage where they can, else show “Not reported”: nothing is assumed zero.',
      application: 'Application budgets add up their projects\' usage where they can, else show “Not reported”: nothing is assumed zero.',
      action: 'Credits over time cannot be shown by action.',
    };
    const DIM_LABEL = { user: 'Users', project: 'Projects', group: 'Groups', application: 'Applications', action: 'Actions' };
    for (const d of b.notReported ?? []) out.push(`<p class="gv-note"><strong>${esc(`Usage per ${d} is not reported by Checkmarx One for this tenant.`)}</strong> <span>${esc(NOT_REPORTED[d] ?? 'Nothing is assumed zero.')}</span></p>`);
    if (b.stale?.length) {
      const oldest = b.stale.map((d) => b.lastGoodAt?.[d]).filter(Boolean).sort()[0];
      out.push(`<p class="gv-note bad"><strong>${esc('The last poll of Checkmarx One did not finish.')}</strong> <span>${esc('Figures are from the last complete one; nothing is released or restricted on them.')}</span> <span class="gv-dims">${b.stale.map((d) => `<span>${esc(DIM_LABEL[d] ?? d)}</span>`).join(', ')}</span>${oldest ? ` · <span>${esc('last complete')}</span> <span>${esc(ago(oldest))}</span>` : ''}</p>`);
    }
    if (b.unattributed?.subjects) {
      out.push(`<p class="gv-note info"><strong>${esc(b.unattributed.subjects === 1 ? `${credits(b.unattributed.credits)} credits used by 1 name that matches nobody here.` : `${credits(b.unattributed.credits)} credits used by ${b.unattributed.subjects} names that match nobody here.`)}</strong> <span>${esc('They count towards no budget until they are mapped.')}</span>${has('govern.attribution') || has('govern.view') ? ` <button type="button" class="link gv-note-act" data-gv-goto="attribution">${esc('Open Attribution →')}</button>` : ''}</p>`);
    }
    if (o.trend?.estimated) out.push(`<p class="gv-note info"><strong>${esc('Some figures are estimated.')}</strong> <span>${esc('Govern has less history than the lookback window: earlier usage is spread evenly until it has more.')}</span></p>`);
    $('gv-banners').innerHTML = out.join('');
  }

  function renderPool() {
    const f = S.overview.figures;
    const p = poolParts(f);
    const now = new Date();
    const period = f.pool?.period === 'all'
      ? 'All time'
      : `${new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })} – ${new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`;
    $('gv-pool-period').innerHTML = `<span>${esc('This period:')}</span> <span translate="no">${esc(period)}</span>${f.pool?.period === 'all' ? '' : ` · <span>${esc('monthly')}</span>`}`;
    const seg = (cls, pct, label, value) => (pct > 0 ? `<span class="${cls}" style="width:${pct}%" title="${esc(`${t(label)} ${credits(value)}`)}">${pct >= 12 ? `<span>${esc(label)}</span>&nbsp;<b translate="no">${esc(credits(value))}</b>` : ''}</span>` : '');
    let bar;
    if (!p.pool && !p.assigned && !p.used) bar = `<p class="hint">${esc('No credit pool is set and no budget is assigned yet. The pool is set under Credit Control.')}</p>`;
    else {
      const poolAt = p.pool ? Math.round((p.pool / p.scale) * 10000) / 100 : 0;
      const end = p.over || !p.pool ? `<span translate="yes">${esc('Assigned')}</span> ${esc(credits(Math.max(p.assigned, p.used)))}` : `<span translate="yes">${esc('Pool')}</span> ${esc(credits(p.pool))}`;
      bar = `<div class="gv-scale" translate="no"><span>0</span>${p.over && poolAt ? `<span class="gv-scale-pool" style="inset-inline-start:${poolAt}%"><span translate="yes">${esc('Pool')}</span> ${esc(credits(p.pool))}</span>` : ''}<span>${end}</span></div>
      <div class="gv-bigbar${p.over ? ' is-over' : ''}" role="img" aria-label="${esc(t(`Pool ${credits(p.pool)}: ${credits(p.used)} used, ${credits(p.unusedAssigned)} assigned and not used, ${credits(p.free)} not assigned`))}">${seg('m-used', p.usedPct, 'Used', p.used)}${seg('m-assigned', p.assignedPct, 'Assigned, not used', p.unusedAssigned)}${seg('m-free', p.freePct, 'Free', p.free)}${p.over && poolAt ? `<i class="gv-pool-tick" style="inset-inline-start:${poolAt}%"></i>` : ''}</div>`;
    }
    const tc = f.tenantCredits;
    const pctOf = (n) => (p.pool ? ` <span translate="no">· ${Math.round((n / p.pool) * 100)}%</span>` : '');
    const legend = [
      `<span><i class="key key-triage"></i><span>${esc('Used')}</span> <b translate="no">${esc(credits(p.used))}</b>${pctOf(p.used)}</span>`,
      `<span><i class="key key-assigned"></i><span>${esc('Assigned to budgets')}</span> <b translate="no">${esc(credits(p.assigned))}</b>${pctOf(p.assigned)}</span>`,
      p.over ? `<span class="bad-text"><i class="key key-over"></i><span>${esc('Assigned over the pool')}</span> <b translate="no">${esc(credits(p.over))}</b></span>` : p.pool ? `<span><i class="key key-free"></i><span>${esc('Not assigned')}</span> <b translate="no">${esc(credits(p.free))}</b></span>` : '',
      tc && p.pool ? `<span><span>${esc('Tenant credits not in the pool')}</span> <b translate="no">${esc(credits(Math.max(0, tc.total - p.pool)))}</b></span>` : '',
    ].join('');
    $('gv-pool-body').innerHTML = `${bar}<div class="pool-legend">${legend}</div>`;
  }

  function renderTrend() {
    const o = S.overview;
    const data = trendRows(o.trend, range);
    const box = $('gv-chart');
    const legend = data.actions.map((a) => `<span><i class="key key-${ACTION_CLASS[a] ?? 'other'}"></i><span>${esc(ACTION_LABEL[a] ?? a)}</span> <b translate="no">${esc(credits(data.sums[a]))}</b></span>`).join('');
    $('gv-chart-legend').innerHTML = legend;
    $('gv-trend-sub').textContent = data.bucket === 'month' ? 'by action, per month' : 'by action, per day';
    if (!data.rows.some((r) => r.total > 0)) {
      box.innerHTML = `<div class="chart-empty">${esc(o.byAction ? 'No credits used in this range yet: Govern records usage from its first cycle on.' : 'Checkmarx One does not report usage by action for this tenant.')}</div>`;
      $('gv-chart-table').innerHTML = '';
      return;
    }
    box.innerHTML = `${chartSvg(data, box.clientWidth || 900)}<div class="tip" hidden></div>`;
    const tip = box.querySelector('.tip');
    const svg = box.querySelector('svg');
    const show = (g) => {
      const r = data.rows[Number(g.dataset.i)];
      tip.innerHTML = `<div class="tip-title" translate="no">${esc(r.long)}</div>${data.actions.map((a) => `<div class="tip-row"><span class="line-key key-${ACTION_CLASS[a] ?? 'other'}"></span><b translate="no">${esc(credits(r.values[a]))}</b><span>${esc(ACTION_LABEL[a] ?? a)}</span></div>`).join('')}<div class="tip-row"><span class="line-key"></span><b translate="no">${esc(credits(r.total))}</b><span>${esc('Total')}</span></div>`;
      tip.hidden = false;
      const hit = g.querySelector('.hit').getBBox();
      const scale = box.clientWidth / Number(svg.getAttribute('width'));
      const left = (hit.x + hit.width / 2) * scale;
      tip.style.left = `${Math.min(Math.max(0, left - tip.offsetWidth / 2), box.clientWidth - tip.offsetWidth)}px`;
      tip.style.top = '0px';
    };
    for (const g of box.querySelectorAll('.col')) {
      g.addEventListener('pointerenter', () => show(g));
      g.addEventListener('focus', () => show(g));
      g.addEventListener('pointerleave', () => (tip.hidden = true));
      g.addEventListener('blur', () => (tip.hidden = true));
    }
    $('gv-chart-table').innerHTML = `<div class="table-wrap"><table class="probe gv-chart-tbl" data-tt-off><thead><tr><th>${esc(data.bucket === 'month' ? 'Month' : 'Day')}</th>${data.actions.map((a) => `<th class="num">${esc(ACTION_LABEL[a] ?? a)}</th>`).join('')}<th class="num">${esc('Total')}</th></tr></thead><tbody>${data.rows.map((r) => `<tr><td translate="no">${esc(r.long)}</td>${data.actions.map((a) => `<td class="num" translate="no">${esc(credits(r.values[a]))}</td>`).join('')}<td class="num" translate="no"><b>${esc(credits(r.total))}</b></td></tr>`).join('')}</tbody></table></div>`;
  }

  function renderPersonal() {
    const o = S.overview;
    const b = o.budget;
    const fact = (label, value, small = '') => `<div><span>${esc(label)}</span><b translate="no">${esc(value)}</b>${small ? `<small>${small}</small>` : ''}</div>`;
    $('gv-me-facts').innerHTML = b
      ? [fact('Your budget', credits(b.limit), pair(PERIOD_LABEL[b.period] ?? b.period, MODE_LABEL[b.mode] ?? b.mode)), fact('Used', credits(b.used), b.pct !== null && b.pct !== undefined ? esc(`${Math.round(b.pct)}% · warns at ${b.warnPct}%`) : ''), fact('Left', b.used === null ? '—' : credits(Math.max(0, b.limit - b.used)), b.daysLeft !== null && b.daysLeft !== undefined ? esc(`${b.daysLeft} days left in the period`) : '')].join('')
      : [fact('Your budget', '—', esc('No budget limits your AI credits.')), fact('Used', credits(o.usage?.reported ?? null), o.usage ? esc(`reported over the ${String(WINDOW_LABEL[o.usage.window] ?? o.usage.window).toLowerCase()}`) : esc('Checkmarx One has not reported it yet'))].join('');
    $('gv-me-status').innerHTML = b ? `${statusBadge(b.status)} ${budgetWhy(b)}${useBar(b)}` : '';
    $('gv-me-who').innerHTML = o.self ? `<span>${esc('As')}</span> <b translate="no">${esc(o.self.label)}</b>` : `<span class="status warn">${esc('Your email address is not a Checkmarx One user here, so credits cannot be asked for you; you can still ask for a project, group or application.')}</span>`;
    $('gv-me-ask').hidden = !has('govern.request');
    myTable.render();
  }
  const myTable = makeTable({
    table: 'gv-me-table',
    key: 'govern-mine',
    all: () => requestColumns({ when, me: selfEmail() }).filter((c) => c.id !== 'by'),
    rows: () => S.overview?.requests?.map((r) => ({ ...r, waitingMinutes: r.status === 'open' ? Math.round((Date.now() - Date.parse(r.createdAt)) / 60000) : null })) ?? null,
    id: (r) => r.id,
    open: (r) => openRequest(r),
    empty: () => 'You have not asked for credits yet.',
  });

  // =============================================================================================================
  // Budgets
  // =============================================================================================================

  let level = '';
  const budgetTable = makeTable({
    table: 'gv-budgets',
    key: 'govern-budgets',
    all: () => budgetColumns({ when }),
    rows: () => (S.budgets ? S.budgets.items.filter((b) => !level || b.entityType === level) : null),
    id: (r) => r.id,
    text: (r) => `${r.entityLabel} ${r.entityId} ${r.notes ?? ''} ${statusText(r.status)}`,
    search: 'gv-budget-q',
    menu: 'gv-budget-cols',
    select: true,
    open: (r) => openBudget(r),
    empty: () => (has('govern.budgets') ? 'No budget yet. New budget sets the first one.' : 'No budget yet.'),
    changed: () => renderBudgetBar(),
  });

  function renderBudgets() {
    const counts = S.budgets?.counts ?? { all: 0, user: 0, group: 0, project: 0, application: 0 };
    $('gv-levels').innerHTML = [['', 'All', counts.all], ...LEVELS.map((l) => [l, LEVEL_PLURAL[l], counts[l]])].map(([id, label, n]) => `<button type="button" class="fusion-chip sm" data-gv-level="${id}" aria-pressed="${level === id}"><span>${esc(label)}</span> <small translate="no">${num(n ?? 0)}</small></button>`).join('');
    for (const id of ['gv-budget-new', 'gv-budget-import']) $(id).hidden = !has('govern.budgets');
    budgetTable.render();
    const total = S.budgets?.items?.length ?? 0;
    $('gv-budget-more').textContent = S.budgets ? `${num(budgetTable.shown.length)} of ${num(total)} shown.${has('govern.budgets') ? ' Click a row to edit it.' : ' Click a row for its details.'}` : '';
    renderExemptions();
  }

  function renderBudgetBar() {
    const rows = budgetTable.selected();
    const acts = budgetActions(rows, perms());
    const bar = $('gv-budget-bar');
    bar.hidden = !rows.length;
    if (!rows.length) return;
    $('gv-budget-count').textContent = rows.length === 1 ? '1 budget selected' : `${rows.length} budgets selected`;
    for (const b of bar.querySelectorAll('[data-gv-bulk]')) b.hidden = !acts.includes(b.dataset.gvBulk);
    const hint = $('gv-budget-bar-hint');
    hint.hidden = has('govern.budgets');
    hint.textContent = has('govern.budgets') ? '' : 'Changing budgets needs the “Manage budgets” permission.';
  }

  $('gv-budget-bar').addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.gvClear !== undefined) return budgetTable.clear();
    const what = button.dataset.gvBulk;
    if (!what) return;
    const rows = budgetTable.selected();
    let changes = null;
    if (what === 'amount') {
      const v = await ask({ title: `Set the budget of ${rows.length} budgets`, body: `<label class="field"><span>${esc('Credits')}</span><input type="text" inputmode="decimal" name="amount" required autofocus /></label><p class="hint">${esc('Each budget gets this amount. Top-ups from approved requests stay.')}</p>`, confirm: 'Set the amount' });
      if (!v) return;
      changes = { amount: v.amount };
    } else if (what === 'warn') {
      const v = await ask({ title: `Warn at a share of ${rows.length} budgets`, body: `<label class="field"><span>${esc('Warn at')}</span><div class="gv-field-row"><input type="number" min="1" max="100" step="1" name="warnPct" value="80" required autofocus /><span class="gv-suffix">${esc('% of the budget')}</span></div></label>`, confirm: 'Set it' });
      if (!v) return;
      changes = { warnPct: Number(v.warnPct) };
    } else if (what === 'monitor') changes = { mode: 'monitor' };
    else if (what === 'enforce') {
      if (!confirm(t(`Enforce ${rows.length} budgets? At the limit, Govern removes AI roles, or turns off Auto Triage and PR remediation, in Checkmarx One until usage is under the budget again. It is reversible.`))) return;
      changes = { mode: 'enforce' };
    } else if (what === 'pause') changes = { active: false };
    else if (what === 'resume') changes = { active: true };
    else if (what === 'exempt') {
      const v = await ask({ title: `Exempt ${rows.length} budgets`, body: `<p>${esc('Usage is still counted and shown, and warned about; nothing is restricted.')}</p><label class="field"><span>${esc('Reason')}</span><input type="text" name="reason" maxlength="500" placeholder="${esc('For example: a shared service account')}" autofocus /></label>`, confirm: 'Exempt them' });
      if (!v) return;
      changes = { exempt: true, exemptReason: v.reason };
    } else if (what === 'unexempt') changes = { exempt: false };
    try {
      const r = await write('/api/govern/budgets/bulk', 'POST', { ids: rows.map((b) => b.id), changes });
      toast(r.changed === 1 ? '1 budget changed.' : `${r.changed} budgets changed.`, 'ok', 3000);
      budgetTable.sel.clear();
      await refresh({ only: ['budgets', 'overview'] });
    } catch (error) {
      if (!handleAuthLoss(error)) toast(error.message, 'bad');
    }
  });

  $('gv-levels').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-gv-level]');
    if (!chip) return;
    level = chip.dataset.gvLevel;
    renderBudgets();
  });
  $('gv-budget-new').addEventListener('click', () => openBudget(null));
  $('gv-budget-csv').addEventListener('click', () => budgetTable.csv('govern-budgets'));
  $('gv-budget-html').addEventListener('click', () => budgetTable.html('govern-budgets', 'Govern: budgets', `${budgetTable.shown.length} budgets · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`));
  $('gv-budget-export-all').addEventListener('click', () => {
    location.href = '/api/govern/budgets.csv';
  });

  // ---- New / edit a budget in the side panel ----
  async function openBudget(row, preset = null) {
    const edit = Boolean(row);
    const may = has('govern.budgets');
    const canEnforce = has('govern.enforce');
    const b = row ?? { entityType: preset?.entityType ?? 'user', entityId: preset?.entityId ?? '', entityLabel: preset?.entityLabel ?? '', amount: '', period: 'monthly', warnPct: 80, mode: 'monitor', active: true, includeMembers: false, includeSubgroups: false, countExisting: false, holdUntilReleased: false, maxTargets: '', notes: '', exempt: false, exemptReason: '' };
    const seg = (name, list, on, { disabled = () => false } = {}) => `<span class="flush-seg" role="radiogroup">${list.map(([v, label]) => `<label${disabled(v) ? ' class="is-off" title="' + esc('Enforce needs the “Enforce budgets” permission.') + '"' : ''}><input type="radio" name="${name}" value="${v}"${v === on ? ' checked' : ''}${disabled(v) || !may ? ' disabled' : ''} /><span>${esc(label)}</span></label>`).join('')}</span>`;
    const sw = (name, label, small, on, extra = '') => `<label class="switch"><input type="checkbox" name="${name}"${on ? ' checked' : ''}${!may ? ' disabled' : ''}${extra} /> <span><strong>${esc(label)}</strong><small>${esc(small)}</small></span></label>`;
    const head = edit
      ? `<div class="fusion-facts"><div><span>${esc('Budget')}</span><b translate="no">${esc(credits(b.limit))}</b><small>${b.period === 'custom' ? `<span translate="no">${esc(periodText(b))}</span> · <span>${esc(MODE_LABEL[b.mode])}</span>` : pair(PERIOD_LABEL[b.period] ?? b.period, MODE_LABEL[b.mode])}</small></div><div><span>${esc('Used')}</span><b translate="no">${esc(credits(b.used))}</b><small>${b.pct !== null && b.pct !== undefined ? esc(`${Math.round(b.pct)}% · warns at ${b.warnPct}%`) : esc('not reported')}</small></div><div><span>${esc('Status')}</span><b>${statusBadge(b.status)}</b><small>${b.daysLeft !== null && b.daysLeft !== undefined ? esc(`${b.daysLeft} days left`) : ''}</small></div></div>
         <p class="gv-side-links"><button type="button" class="link" data-gv-diagnose>${esc('Diagnose this figure')}</button></p><div id="gv-diag" hidden></div><div id="gv-budget-holds"></div>`
      : '';
    const body = `<form id="gv-budget-form" novalidate>
      <h3>${esc('Applies to')}</h3>
      ${edit ? `<div class="field">${whoHtml(b.entityLabel, b.entityType)}<span class="gv-why" translate="no">${esc(b.entityId)}</span></div>` : `<div class="field">${seg('entityType', LEVELS.map((l) => [l, LEVEL_LABEL[l]]), b.entityType)}</div>${pickerHtml(LEVEL_LABEL[b.entityType], 'gv-bpick')}<p class="gv-chosen" id="gv-bchosen">${b.entityId ? `<span>${esc('Chosen:')}</span> <b translate="no">${esc(b.entityLabel || b.entityId)}</b>` : ''}</p>`}
      <h3>${esc('Amount and period')}</h3>
      <div class="grid2">
        <label class="field"><span>${esc('Credits')}</span><input type="text" inputmode="decimal" name="amount" value="${esc(b.amount ?? '')}" required${may ? '' : ' disabled'} /></label>
        <label class="field"><span>${esc('Warn at')}</span><div class="gv-field-row"><input type="number" name="warnPct" min="1" max="100" step="1" value="${esc(b.warnPct ?? 80)}"${may ? '' : ' disabled'} /><span class="gv-suffix">${esc('% of the budget')}</span></div></label>
      </div>
      <div class="field"><span>${esc('Period')}</span>${seg('period', [['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['lifetime', 'Lifetime'], ['custom', 'Custom']], b.period)}</div>
      <div class="grid2">
        <label class="field"><span>${esc('From')} <small>${esc('(Custom only)')}</small></span><input type="date" name="customStart" value="${esc(isoDay(b.customStart))}" /></label>
        <label class="field"><span>${esc('To')}</span><input type="date" name="customEnd" value="${esc(isoDay(b.customEnd))}" /></label>
      </div>
      <p class="status warn gv-pool-warn" id="gv-pool-warn" hidden></p>
      <h3>${esc('At the limit')}</h3>
      <div class="field">${seg('mode', [['monitor', 'Monitor'], ['enforce', 'Enforce']], b.mode, { disabled: (v) => v === 'enforce' && !canEnforce && b.mode !== 'enforce' })}<p class="hint gv-mode-hint" id="gv-mode-hint"></p></div>
      <div class="toggle-list">
        ${sw('active', 'Active', 'Off: paused, nothing is counted against it or restricted', b.active)}
        ${sw('includeMembers', 'Count group members\' usage', 'Groups only: each member\'s usage counts towards the group', b.includeMembers)}
        ${sw('includeSubgroups', 'Count subgroups', 'Groups only: the members of its subgroups count too', b.includeSubgroups)}
        ${sw('countExisting', 'Count usage from before the period', 'Off: the period starts at what was used when it began', b.countExisting)}
        ${sw('holdUntilReleased', 'Hold until released', 'Once restricted, it stays so after the period ends, until someone releases it', b.holdUntilReleased)}
        ${sw('exempt', 'Exempt', 'Usage is counted, shown and warned about; nothing is restricted', b.exempt)}
      </div>
      <label class="field"><span>${esc('Reason for the exemption')}</span><input type="text" name="exemptReason" maxlength="500" value="${esc(b.exemptReason ?? '')}" placeholder="${esc('For example: a shared service account')}" /></label>
      <details class="disclosure gv-more-opts"><summary>${esc('More options')}</summary>
        <label class="field"><span>${esc('Most targets restricted at once')}</span><input type="number" name="maxTargets" min="1" max="10000" step="1" value="${esc(b.maxTargets ?? '')}" placeholder="${esc('The default from Settings')}"${may ? '' : ' disabled'} /><small class="hint">${esc('A group or application can reach many people and projects: above this, Enforce waits for you to confirm.')}</small></label>
        ${sw('fanoutConfirmed', 'Confirm restricting more than that', 'Needed once when Enforce would reach more targets than the limit above', Boolean(b.fanoutConfirmedAt))}
      </details>
      <label class="field"><span>${esc('Notes')}</span><textarea name="notes" rows="2" maxlength="2000"${may ? '' : ' disabled'}>${esc(b.notes ?? '')}</textarea></label>
      <p class="status" id="gv-budget-status" role="status"></p>
    </form>`;
    const foot = may
      ? `<button type="submit" form="gv-budget-form" class="primary">${esc(edit ? 'Save budget' : 'Create budget')}</button><button type="button" class="ghost" data-gv-cancel>${esc('Cancel')}</button>${edit ? `<button type="button" class="danger-soft" id="gv-budget-delete">${esc('Delete')}</button>` : ''}<span class="hint gv-foot-hint">${esc(canEnforce ? 'Every change goes to the audit log.' : 'Enforce needs the “Enforce budgets” permission.')}</span>`
      : `<button type="button" data-gv-cancel>${esc('Close')}</button><span class="hint gv-foot-hint">${esc('Changing budgets needs the “Manage budgets” permission.')}</span>`;
    openSide({
      title: edit ? `${esc('Budget:')} <span translate="no">${esc(b.entityLabel)}</span>` : esc('New budget'),
      sub: edit ? `<span>${esc(LEVEL_LABEL[b.entityType])}</span> · ${dated('updated', shortDate(b.updatedAt))} <span>${esc('by')}</span> <span translate="no">${esc(b.updatedBy ?? '')}</span>` : esc('For one person, group, project or application. Every change goes to the audit log.'),
      head,
      body,
      foot,
      ready: (root) => wireBudgetForm(root, b, { edit, may }),
    });
    if (edit) {
      try {
        const r = await read(`/api/govern/budgets/${encodeURIComponent(b.id)}`);
        const box = $('gv-budget-holds');
        if (!box) return;
        const list = r.data.restrictions ?? [];
        box.innerHTML = list.length ? `<h3 class="sb-side-h">${esc('Restrictions')}</h3><ul class="gv-holds">${list.map((x) => `<li>${holdBadge(x.state)} <span>${esc(KIND_LABEL[x.kind] ?? x.what)}</span> <span class="hint" translate="no">${esc(x.label)}</span>${x.partial?.length ? `<span class="gv-why warn" translate="no">${esc(x.partial.join('; '))}</span>` : ''}</li>`).join('')}</ul>` : '';
        if (b.topUps?.length) box.insertAdjacentHTML('beforeend', `<h3 class="sb-side-h">${esc('Top-ups')}</h3><ul class="gv-holds">${b.topUps.map((u) => `<li><b translate="no">+${esc(credits(u.amount))}</b> ${u.until ? dated('until', shortDate(u.until, { year: true })) : `<span>${esc('for good')}</span>`} <span class="hint" translate="no">${esc(u.by ?? '')}</span></li>`).join('')}</ul>`);
      } catch {}
    }
  }

  function wireBudgetForm(root, b, { edit, may }) {
    const form = root.querySelector('#gv-budget-form');
    const chosen = { entityType: b.entityType, entityId: b.entityId, entityLabel: b.entityLabel };
    const val = (name) => form.elements[name];
    const update = () => {
      const period = form.querySelector('input[name="period"]:checked')?.value ?? 'monthly';
      val('customStart').disabled = !may || period !== 'custom';
      val('customEnd').disabled = !may || period !== 'custom';
      const type = edit ? b.entityType : form.querySelector('input[name="entityType"]:checked')?.value ?? 'user';
      for (const n of ['includeMembers', 'includeSubgroups']) val(n).disabled = !may || type !== 'group';
      val('exemptReason').disabled = !may || !val('exempt').checked;
      const mode = form.querySelector('input[name="mode"]:checked')?.value ?? 'monitor';
      const what = type === 'user' ? 'removes this person\'s AI roles' : type === 'project' ? 'turns off Auto Triage and PR remediation for this project' : type === 'application' ? 'turns off Auto Triage and PR remediation for its projects' : 'removes its members\' AI roles';
      $('gv-mode-hint').textContent = mode === 'enforce' ? `Enforce warns, then ${what} until it is under budget again. Reversible.` : `Monitor warns. Enforce also ${what} until it is under budget again.`;
      const f = S.overview?.figures;
      const g = f ? poolGuard({ assigned: f.assigned, poolLimit: f.pool?.limit, oldLimit: edit ? b.limit : 0, oldActive: edit ? b.active : false, amount: Number(String(val('amount').value).replace(/,/g, '')), active: val('active').checked }) : null;
      const warn = $('gv-pool-warn');
      warn.hidden = !g;
      if (g) warn.textContent = `${credits(g.over)} credits over the pool: with this budget ${credits(g.assignedAfter)} are assigned, and the pool has ${credits(f.pool.limit)}. ${mode === 'enforce' ? 'Allowed: check it is meant.' : 'Allowed in Monitor.'}`;
    };
    form.addEventListener('input', update);
    form.addEventListener('change', update);
    update();
    if (!edit) {
      const pick = picker(form, {
        type: () => form.querySelector('input[name="entityType"]:checked')?.value ?? 'user',
        onPick: (it) => {
          chosen.entityType = form.querySelector('input[name="entityType"]:checked').value;
          chosen.entityId = it.id;
          chosen.entityLabel = it.label;
          $('gv-bchosen').innerHTML = it.hasBudget
            ? `<span class="status warn">${esc('Already has a budget: change that one.')}</span> <button type="button" class="link" data-gv-open-budget="${esc(it.budgetId)}">${esc('Open it')}</button>`
            : `<span>${esc('Chosen:')}</span> <b translate="no">${esc(it.label)}</b>`;
          if (it.hasBudget) chosen.entityId = '';
          form.querySelector('[data-gv-pick-list]').hidden = true;
          val('amount').focus();
        },
      });
      for (const r of form.querySelectorAll('input[name="entityType"]')) r.addEventListener('change', () => {
        form.querySelector('.gv-picker > span').textContent = LEVEL_LABEL[r.value];
        chosen.entityId = '';
        $('gv-bchosen').innerHTML = '';
        pick.refresh();
      });
      form.addEventListener('click', (event) => {
        const open = event.target.closest('[data-gv-open-budget]');
        if (!open) return;
        const row = S.budgets?.items?.find((x) => x.id === open.dataset.gvOpenBudget);
        if (row) openBudget(row);
      });
    }
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!may) return;
      const status = $('gv-budget-status');
      const period = form.querySelector('input[name="period"]:checked')?.value;
      const input = {
        amount: String(val('amount').value).replace(/,/g, '').trim(),
        warnPct: Number(val('warnPct').value),
        period,
        customStart: period === 'custom' ? val('customStart').value || null : null,
        customEnd: period === 'custom' ? val('customEnd').value || null : null,
        mode: form.querySelector('input[name="mode"]:checked')?.value,
        active: val('active').checked,
        includeMembers: val('includeMembers').checked,
        includeSubgroups: val('includeSubgroups').checked,
        countExisting: val('countExisting').checked,
        holdUntilReleased: val('holdUntilReleased').checked,
        exempt: val('exempt').checked,
        exemptReason: val('exemptReason').value,
        notes: val('notes').value,
        ...(val('maxTargets').value ? { maxTargets: Number(val('maxTargets').value) } : {}),
        ...(val('fanoutConfirmed').checked && !b.fanoutConfirmedAt ? { fanoutConfirmed: true } : {}),
      };
      if (!edit && !chosen.entityId) return setStatus('gv-budget-status', 'Choose who the budget is for.', 'error');
      if (!input.amount) return setStatus('gv-budget-status', 'Give the budget an amount of credits.', 'error');
      if (input.mode === 'enforce' && b.mode !== 'enforce' && !confirm(t('Enforce this budget? At the limit, Govern restricts AI in Checkmarx One until usage is under the budget again. It is reversible.'))) return;
      status.textContent = '';
      try {
        if (edit) await write(`/api/govern/budgets/${encodeURIComponent(b.id)}`, 'PUT', { ...input, version: b.version });
        else await write('/api/govern/budgets', 'POST', { ...input, entityType: chosen.entityType, entityId: chosen.entityId, entityLabel: chosen.entityLabel });
        toast(edit ? 'Budget saved.' : 'Budget created.', 'ok', 2500);
        closeSide();
        await refresh({ only: ['budgets', 'overview'] });
      } catch (error) {
        if (handleAuthLoss(error)) return;
        if (error.status === 409 && edit) {
          setStatus('gv-budget-status', 'Someone changed this budget since you opened it: look again.', 'error');
          await refresh({ only: ['budgets'] });
        } else showError('gv-budget-status', error);
      }
    });
    root.querySelector('#gv-budget-delete')?.addEventListener('click', async () => {
      if (!confirm(t('Delete this budget? Its restrictions are lifted in Checkmarx One in the background. It is written to the audit log.'))) return;
      try {
        await write(`/api/govern/budgets/${encodeURIComponent(b.id)}?version=${b.version}`, 'DELETE');
        toast('Budget deleted.', 'ok', 2500);
        closeSide();
        await refresh({ only: ['budgets', 'overview'] });
      } catch (error) {
        if (!handleAuthLoss(error)) showError('gv-budget-status', error);
      }
    });
    root.querySelector('[data-gv-diagnose]')?.addEventListener('click', () => diagnose(b));
  }

  const VERDICT = { ok: 'The figure is what Checkmarx One reports, attributed and counted in the period.', not_in_org: 'Not in Checkmarx One as Govern last read it: check the id, or wait for the next read.', not_reported: 'Checkmarx One does not report usage at this level: nothing is assumed zero.', attribution: 'Usage is reported under a name Govern could not attribute here: decide it under Attribution.', estimated: 'An estimate: Govern has less history than the lookback window, so earlier usage is spread evenly.' };
  async function diagnose(b) {
    const box = $('gv-diag');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = `<p class="hint">${esc('Checking…')}</p>`;
    try {
      const r = await read(`/api/govern/diagnose?entityType=${encodeURIComponent(b.entityType)}&entityId=${encodeURIComponent(b.entityId)}`);
      const d = r.data;
      box.innerHTML = `<div class="gv-diag"><p class="gv-diag-verdict"><b>${esc(VERDICT[d.verdict] ?? d.verdict)}</b></p><ol class="gv-steps">${d.steps.map((s) => `<li class="${s.ok === true ? 'ok' : s.ok === false ? 'bad' : 'na'}"><span class="gv-step-mark" aria-hidden="true">${s.ok === true ? '✓' : s.ok === false ? '✕' : '–'}</span><span><b>${esc(s.step)}</b><span class="gv-why" translate="no">${esc(s.detail)}</span></span></li>`).join('')}</ol>${d.verdict === 'attribution' ? `<button type="button" class="link" data-gv-goto="attribution">${esc('Open Attribution →')}</button>` : ''}</div>`;
    } catch (error) {
      box.innerHTML = `<p class="status error">${esc(error.message)}</p>`;
    }
  }

  // ---- Exemptions (people and things never restricted, with or without a budget) ----
  function renderExemptions() {
    const box = $('gv-exempt-list');
    const list = S.exemptions;
    $('gv-exempt-add').hidden = !has('govern.budgets');
    if (!list) {
      box.innerHTML = `<p class="hint">${esc('Loading…')}</p>`;
      return;
    }
    $('gv-n-exempt').textContent = list.length ? num(list.length) : '';
    box.innerHTML = list.length
      ? `<div class="table-wrap"><table class="data-table" id="gv-exempt-table"><thead><tr><th>${esc('Applies to')}</th><th>${esc('Reason')}</th><th>${esc('Since')}</th>${has('govern.budgets') ? '<th></th>' : ''}</tr></thead><tbody>${list.map((e) => `<tr><td>${whoHtml(e.entityLabel || e.entityId, e.entityType)}</td><td class="wrap" translate="no">${esc(e.reason || '—')}</td><td>${timeHtml(shortDate(e.createdAt, { year: true }))} <span class="hint" translate="no">${esc(e.createdBy ?? '')}</span></td>${has('govern.budgets') ? `<td class="gv-act"><button type="button" class="sm" data-gv-unexempt="${esc(`${e.entityType}/${e.entityId}`)}">${esc('Remove exemption')}</button></td>` : ''}</tr>`).join('')}</tbody></table></div>`
      : `<p class="hint">${esc('Nobody is exempt. An exemption keeps counting and warning, and never restricts: for shared or service accounts.')}</p>`;
  }
  $('gv-exempt-list').addEventListener('click', async (event) => {
    const b = event.target.closest('[data-gv-unexempt]');
    if (!b) return;
    if (!confirm(t('Remove this exemption? From the next cycle its budget can warn and restrict again.'))) return;
    try {
      await write(`/api/govern/exemptions/${b.dataset.gvUnexempt.split('/').map(encodeURIComponent).join('/')}`, 'DELETE');
      toast('Exemption removed.', 'ok', 2500);
      await refresh({ only: ['exemptions', 'budgets'] });
    } catch (error) {
      if (!handleAuthLoss(error)) toast(error.message, 'bad');
    }
  });
  $('gv-exempt-add').addEventListener('click', () => {
    const chosen = { id: '', label: '' };
    openSide({
      title: esc('Exempt someone'),
      sub: esc('Usage is still counted and shown, and warned about; nothing is ever restricted. With or without a budget.'),
      body: `<form id="gv-ex-form" novalidate><div class="field"><span class="flush-seg" role="radiogroup">${LEVELS.map((l, i) => `<label><input type="radio" name="entityType" value="${l}"${i === 0 ? ' checked' : ''} /><span>${esc(LEVEL_LABEL[l])}</span></label>`).join('')}</span></div>${pickerHtml('Applies to', 'gv-expick')}<p class="gv-chosen" id="gv-exchosen"></p><label class="field"><span>${esc('Reason')}</span><input type="text" name="reason" maxlength="500" placeholder="${esc('For example: a shared service account')}" /></label><p class="status" id="gv-ex-status" role="status"></p></form>`,
      foot: `<button type="submit" form="gv-ex-form" class="primary">${esc('Add exemption')}</button><button type="button" class="ghost" data-gv-cancel>${esc('Cancel')}</button>`,
      ready: (root) => {
        const form = root.querySelector('#gv-ex-form');
        const pick = picker(form, {
          type: () => form.querySelector('input[name="entityType"]:checked').value,
          onPick: (it) => {
            chosen.id = it.id;
            chosen.label = it.label;
            $('gv-exchosen').innerHTML = `<span>${esc('Chosen:')}</span> <b translate="no">${esc(it.label)}</b>`;
            form.querySelector('[data-gv-pick-list]').hidden = true;
          },
        });
        for (const r of form.querySelectorAll('input[name="entityType"]')) r.addEventListener('change', () => ((chosen.id = ''), ($('gv-exchosen').innerHTML = ''), pick.refresh()));
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          if (!chosen.id) return setStatus('gv-ex-status', 'Choose who to exempt.', 'error');
          try {
            await write('/api/govern/exemptions', 'POST', { entityType: form.querySelector('input[name="entityType"]:checked').value, entityId: chosen.id, reason: form.elements.reason.value });
            toast('Exempt.', 'ok', 2500);
            closeSide();
            await refresh({ only: ['exemptions', 'budgets'] });
          } catch (error) {
            if (!handleAuthLoss(error)) showError('gv-ex-status', error);
          }
        });
      },
    });
  });

  // ---- Import CSV: Validate → per-row diff → Apply (all or nothing, refused if anything changed since) ----
  let importing = null;
  let importFilter = '';
  const importTable = makeTable({
    table: 'gv-import-table',
    key: 'govern-import',
    all: () => importColumns({ labelOf: (r) => S.budgets?.items?.find((b) => b.entityType === r.entityType && b.entityId === r.entityId)?.entityLabel ?? r.label ?? r.entityId }),
    rows: () => (importing ? importRows().filter((r) => !importFilter || r.action === importFilter) : null),
    id: (r) => `${r.line}`,
    rowCls: (r) => (r.action === 'unchanged' ? 'gv-same' : r.action === 'error' ? 'gv-err' : ''),
    empty: () => 'The file has no rows.',
  });
  const importRows = () => [...importing.result.rows, ...importing.result.errors.map((e) => ({ line: e.line, action: 'error', error: e.error }))].sort((a, b) => a.line - b.line);
  $('gv-budget-import').addEventListener('click', () => $('gv-import-file').click());
  $('gv-import-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 1024 * 1024) return toast('The file is larger than 1 MiB.', 'bad');
    importing = { name: file.name, csv: await file.text(), result: null, at: null };
    await validateImport();
  });
  async function validateImport() {
    $('gv-import').hidden = false;
    $('gv-budgets-panel').hidden = true;
    setStatus('gv-import-status', 'Checking the file… nothing is changed.');
    $('gv-import-apply').disabled = true;
    try {
      importing.result = await write('/api/govern/csv/validate', 'POST', { csv: importing.csv }, { quiet: true });
      importing.at = new Date().toISOString();
      setStatus('gv-import-status', '');
      renderImport();
    } catch (error) {
      if (handleAuthLoss(error)) return;
      importing.result = null;
      showError('gv-import-status', error);
      renderImport();
    }
  }
  function renderImport() {
    const r = importing?.result;
    const s = r?.summary ?? { create: 0, update: 0, unchanged: 0, delete: 0, errors: 0 };
    const changes = s.create + s.update + s.delete;
    const item = (label, value, cls = '') => `<span${cls ? ` class="${cls}"` : ''}><span>${esc(label)}</span> <b translate="no">${num(value)}</b></span>`;
    $('gv-import-figs').innerHTML = [
      `<span><span>${esc('File')}</span> <b class="gv-file" translate="no">${esc(importing?.name ?? '')}</b>${r ? ` <small>${esc(`${r.rows.length + r.errors.length} rows`)}</small>` : ''}</span>`,
      '<span class="gv-sep" aria-hidden="true"></span>',
      item('Create', s.create),
      item('Update', s.update, s.update ? 'is-warn' : ''),
      s.delete ? item('Delete', s.delete, 'is-bad') : '',
      item('Unchanged', s.unchanged),
      item('Not valid', s.errors, s.errors ? 'is-bad' : 'is-ok'),
      r?.planHash ? `<span class="gv-end"><span>${esc('Plan')}</span> <code class="gv-hash" translate="no" title="${esc(r.planHash)}">${esc(`${r.planHash.slice(0, 6)}…${r.planHash.slice(-6)}`)}</code></span>` : '',
    ].join('');
    const counts = { '': (r?.rows.length ?? 0) + (r?.errors.length ?? 0), create: s.create, update: s.update, unchanged: s.unchanged, delete: s.delete, error: s.errors };
    $('gv-import-chips').innerHTML = [['', 'All'], ['create', 'Create'], ['update', 'Update'], ['delete', 'Delete'], ['unchanged', 'Unchanged'], ['error', 'Not valid']].filter(([k]) => !k || counts[k]).map(([k, label]) => `<button type="button" class="fusion-chip sm" data-gv-imp="${k}" aria-pressed="${importFilter === k}"><span>${esc(label)}</span> <small translate="no">${num(counts[k])}</small></button>`).join('');
    const f = S.overview?.figures;
    const after = r && f ? Math.round((f.assigned + (r.rows ?? []).reduce((n, row) => n + (row.changes ?? []).filter((c) => c.field === 'amount').reduce((m, c) => m + (Number(c.after) || 0) - (Number(c.before) || 0), 0), 0)) * 100) / 100 : null;
    $('gv-import-after').textContent = after !== null && f.pool?.limit ? (after > f.pool.limit ? `After it: ${credits(after)} assigned, ${credits(after - f.pool.limit)} credits over the pool's ${credits(f.pool.limit)}. Allowed, with a warning.` : `After it: ${credits(after)} assigned of the pool's ${credits(f.pool.limit)}.`) : '';
    $('gv-import-errors').hidden = !r?.errors?.length;
    $('gv-import-errors').innerHTML = r?.errors?.length ? `<strong>${esc(r.errors.length === 1 ? '1 row is not valid: nothing can be applied until it is fixed.' : `${r.errors.length} rows are not valid: nothing can be applied until they are fixed.`)}</strong><ul>${r.errors.map((e) => `<li><span>${esc(`Row ${e.line}:`)}</span> <span translate="no">${esc(e.error)}</span></li>`).join('')}</ul>` : '';
    const apply = $('gv-import-apply');
    apply.disabled = !r || Boolean(r.errors.length) || !r.planHash || !changes;
    apply.textContent = changes === 1 ? 'Apply 1 change' : `Apply ${changes} changes`;
    $('gv-import-when').innerHTML = importing?.at ? `${dated('Checked', when(importing.at))} <span>${esc('by')}</span> <span translate="no">${esc(S.me?.email ?? '')}</span>` : '';
    importTable.render();
  }
  $('gv-import-chips').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-gv-imp]');
    if (!chip) return;
    importFilter = chip.dataset.gvImp;
    renderImport();
  });
  function closeImport() {
    importing = null;
    importFilter = '';
    $('gv-import').hidden = true;
    $('gv-budgets-panel').hidden = false;
  }
  $('gv-import-close').addEventListener('click', closeImport);
  $('gv-import-cancel').addEventListener('click', closeImport);
  $('gv-import-again').addEventListener('click', () => importing && validateImport());
  $('gv-import-plan').addEventListener('click', () => importing?.result && importTable.csv('govern-import-plan'));
  $('gv-import-apply').addEventListener('click', async () => {
    const r = importing?.result;
    if (!r?.planHash) return;
    try {
      const out = await write('/api/govern/csv/apply', 'POST', { csv: importing.csv, planHash: r.planHash });
      const a = out.applied;
      toast(`Imported: ${a.create} created, ${a.update} changed, ${a.delete} deleted.`, 'ok', 4000);
      closeImport();
      await refresh({ only: ['budgets', 'overview', 'exemptions'] });
    } catch (error) {
      if (handleAuthLoss(error)) return;
      if (error.status === 409) {
        setStatus('gv-import-status', 'Changed since you checked — check again.', 'error');
        $('gv-import-apply').disabled = true;
      } else showError('gv-import-status', error);
    }
  });

  // =============================================================================================================
  // Requests
  // =============================================================================================================

  let reqStatus = '';
  const requestTable = makeTable({
    table: 'gv-requests',
    key: 'govern-requests',
    all: () => requestColumns({ when, me: selfEmail() }),
    rows: () => (S.requests ? S.requests.items.filter((r) => !reqStatus || r.status === reqStatus) : null),
    id: (r) => r.id,
    text: (r) => `${r.by} ${r.byName ?? ''} ${r.entityLabel} ${r.reason}`,
    search: 'gv-req-q',
    menu: 'gv-req-cols',
    select: true,
    open: (r) => openRequest(r),
    empty: () => (has('govern.approve') || has('govern.view') ? 'No credit request yet.' : 'You have not asked for credits yet.'),
    changed: () => renderRequestBar(),
  });
  function renderRequests() {
    const c = S.requests?.counts ?? {};
    const all = Object.values(c).reduce((n, v) => n + v, 0);
    $('gv-req-chips').innerHTML = [['', 'All', all], ['open', 'Waiting', c.open], ['approved', 'Approved', c.approved], ['denied', 'Denied', c.denied], ['expired', 'Expired', c.expired], ['cancelled', 'Withdrawn', c.cancelled]].filter(([k, , n]) => !k || n || reqStatus === k).map(([k, label, n]) => `<button type="button" class="fusion-chip sm" data-gv-rs="${k}" aria-pressed="${reqStatus === k}"><span>${esc(label)}</span> <small translate="no">${num(n ?? 0)}</small></button>`).join('');
    $('gv-req-ask').hidden = !has('govern.request');
    $('gv-req-lede').textContent = has('govern.approve') ? 'Anyone may ask for more credits. Security Champions and Admins approve, deny or ask a question.' : has('govern.view') ? 'Anyone may ask for more credits. Those who may approve them answer here.' : 'Your requests for more credits, and their answers.';
    requestTable.render();
  }
  function renderRequestBar() {
    const rows = requestTable.selected();
    const acts = requestActions(rows, perms(), selfEmail());
    $('gv-req-bar').hidden = !rows.length;
    if (!rows.length) return;
    $('gv-req-count').textContent = rows.length === 1 ? '1 request selected' : `${rows.length} requests selected`;
    for (const b of $('gv-req-bar').querySelectorAll('[data-gv-rbulk]')) b.hidden = !acts.includes(b.dataset.gvRbulk);
    $('gv-req-bar-none').hidden = acts.length > 0;
  }
  $('gv-req-chips').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-gv-rs]');
    if (!chip) return;
    reqStatus = chip.dataset.gvRs;
    renderRequests();
  });
  $('gv-req-bar').addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.gvClear !== undefined) return requestTable.clear();
    const what = button.dataset.gvRbulk;
    if (!what) return;
    const rows = requestTable.selected().filter((r) => r.status === 'open' && (what !== 'cancel' || r.by === selfEmail()));
    let body;
    if (what === 'approve') {
      if (!confirm(t(`Approve ${rows.length} open requests as asked, until the end of each period? Each budget is raised and each requester emailed.`))) return;
      body = { decision: 'approve' };
    } else if (what === 'deny') {
      const v = await ask({ title: `Deny ${rows.length} requests`, body: `<label class="field"><span>${esc('Reason (sent to each requester)')}</span><textarea name="reason" rows="3" maxlength="2000" required autofocus placeholder="${esc('For example: finish the current backlog first')}"></textarea></label>`, confirm: 'Deny', danger: true });
      if (!v?.reason?.trim()) return;
      body = { decision: 'deny', reason: v.reason };
    } else if (what === 'cancel' && !confirm(t(`Withdraw ${rows.length} of your requests?`))) return;
    let done = 0;
    const failed = [];
    for (const r of rows) {
      try {
        if (what === 'cancel') await write(`/api/govern/requests/${encodeURIComponent(r.id)}/cancel`, 'POST', {});
        else await write(`/api/govern/requests/${encodeURIComponent(r.id)}/decide`, 'POST', body);
        done += 1;
      } catch (error) {
        if (handleAuthLoss(error)) return;
        failed.push(`${r.by}: ${error.message}`);
      }
    }
    toast(failed.length ? `${done} done; ${failed.length} not: ${failed[0]}` : done === 1 ? '1 request done.' : `${done} requests done.`, failed.length ? 'bad' : 'ok', 5000);
    requestTable.sel.clear();
    await refresh({ only: ['requests', 'budgets', 'overview'] });
  });
  $('gv-req-csv').addEventListener('click', () => requestTable.csv('govern-requests'));
  $('gv-req-html').addEventListener('click', () => requestTable.html('govern-requests', 'Govern: credit requests'));
  for (const id of ['gv-req-ask', 'gv-me-ask']) $(id).addEventListener('click', () => openAsk());

  function openAsk() {
    const chosen = { id: '', label: '' };
    const self = S.me?.self;
    const types = [...(self ? [['user', 'Me']] : []), ['project', 'A project'], ['group', 'A group'], ['application', 'An application']];
    openSide({
      title: esc('Ask for credits'),
      sub: esc('Security Champions and Admins answer. You are emailed when they do.'),
      body: `<form id="gv-ask-form" novalidate>
        <h3>${esc('For')}</h3>
        <div class="field"><span class="flush-seg" role="radiogroup">${types.map(([v, label], i) => `<label><input type="radio" name="entityType" value="${v}"${i === 0 ? ' checked' : ''} /><span>${esc(label)}</span></label>`).join('')}</span></div>
        <div id="gv-ask-pick" ${self ? 'hidden' : ''}>${pickerHtml('Which one', 'gv-apick')}<p class="gv-chosen" id="gv-achosen"></p></div>
        <h3>${esc('How many, until when')}</h3>
        <div class="grid2">
          <label class="field"><span>${esc('Credits')}</span><input type="text" inputmode="decimal" name="amount" required /></label>
          <label class="field"><span>${esc('Until')}</span><select name="until"><option value="period">${esc('End of the period')}</option><option value="date">${esc('A date…')}</option></select></label>
        </div>
        <label class="field" id="gv-ask-date" hidden><span>${esc('Date')}</span><input type="date" name="date" /></label>
        <label class="field"><span>${esc('Why')}</span><textarea name="reason" rows="3" maxlength="2000" required placeholder="${esc('For example: AI Remediation on the release\'s confirmed highs')}"></textarea></label>
        <p class="status" id="gv-ask-status" role="status"></p>
      </form>`,
      foot: `<button type="submit" form="gv-ask-form" class="primary">${esc('Send the request')}</button><button type="button" class="ghost" data-gv-cancel>${esc('Cancel')}</button>`,
      ready: (root) => {
        const form = root.querySelector('#gv-ask-form');
        const typeOf = () => form.querySelector('input[name="entityType"]:checked').value;
        const pick = picker(form, {
          type: typeOf,
          onPick: (it) => {
            chosen.id = it.id;
            chosen.label = it.label;
            $('gv-achosen').innerHTML = `<span>${esc('Chosen:')}</span> <b translate="no">${esc(it.label)}</b>`;
            form.querySelector('[data-gv-pick-list]').hidden = true;
          },
        });
        for (const r of form.querySelectorAll('input[name="entityType"]')) r.addEventListener('change', () => {
          $('gv-ask-pick').hidden = typeOf() === 'user';
          chosen.id = '';
          $('gv-achosen').innerHTML = '';
          if (typeOf() !== 'user') pick.refresh();
        });
        form.elements.until.addEventListener('change', () => ($('gv-ask-date').hidden = form.elements.until.value !== 'date'));
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const type = typeOf();
          if (type !== 'user' && !chosen.id) return setStatus('gv-ask-status', 'Choose what the credits are for.', 'error');
          const until = form.elements.until.value === 'date' ? form.elements.date.value : 'period';
          if (!until) return setStatus('gv-ask-status', 'Choose the date.', 'error');
          try {
            await write('/api/govern/requests', 'POST', { entityType: type, ...(type === 'user' ? {} : { entityId: chosen.id }), amount: String(form.elements.amount.value).replace(/,/g, '').trim(), until: until === 'period' ? 'period' : new Date(`${until}T23:59:59Z`).toISOString(), reason: form.elements.reason.value });
            toast('Request sent.', 'ok', 3000);
            closeSide();
            await refresh({ only: ['requests', 'overview'] });
          } catch (error) {
            if (!handleAuthLoss(error)) showError('gv-ask-status', error);
          }
        });
        setTimeout(() => form.elements.amount.focus(), 30);
      },
    });
  }

  async function openRequest(r) {
    const mine = r.by === selfEmail();
    const approve = has('govern.approve') && r.status === 'open';
    const b = S.budgets?.items?.find((x) => x.entityType === r.entityType && x.entityId === r.entityId) ?? (S.overview?.personal ? S.overview.budget : null);
    const f = S.overview?.figures;
    const freePool = f?.pool?.limit ? Math.max(0, f.pool.limit - f.assigned) : null;
    const fact = (label, value, small = '') => `<div><span>${esc(label)}</span><b translate="no">${esc(value)}</b>${small ? `<small>${small}</small>` : ''}</div>`;
    const head = `<div class="fusion-facts">${fact('Budget now', b ? credits(b.limit) : '—', b ? pair(PERIOD_LABEL[b.period] ?? b.period, MODE_LABEL[b.mode]) : esc('no budget: nothing limits it'))}${fact('Used', b ? credits(b.used) : '—', b?.pct !== null && b?.pct !== undefined ? esc(`${Math.round(b.pct)}% · warns at ${b.warnPct}%`) : '')}${freePool !== null ? fact('Free in the pool', credits(freePool), esc(freePool - r.amount >= 0 ? `${credits(freePool - r.amount)} after this` : `${credits(r.amount - freePool)} over the pool after this`)) : ''}</div><p class="gv-quote" translate="no">${esc(r.reason)}</p>`;
    // A period's end is exclusive (the first moment of the next): the last day shown is the one before.
    const end = b?.end ? shortDate(new Date(Date.parse(b.end) - 1).toISOString(), { year: true }) : '';
    const thread = [
      `<li><time translate="no">${esc(when(r.createdAt))}</time><span><span>${esc('Asked by')}</span> <b translate="no">${esc(r.by)}</b><span>: ${esc(`${credits(r.amount)} credits`)}</span> ${r.until === 'period' ? `<span>${esc('until the end of the period')}</span>` : dated('until', shortDate(r.until, { year: true }))}</span></li>`,
      ...(r.thread ?? []).map((m) => `<li><time translate="no">${esc(when(m.at))}</time><span><b translate="no">${esc(m.by)}</b><span>:</span> <span translate="no">${esc(m.text)}</span></span></li>`),
      r.decidedAt ? `<li><time translate="no">${esc(when(r.decidedAt))}</time><span>${requestBadge(r.status)} <b translate="no">${esc(r.decidedBy ?? '')}</b>${r.status === 'approved' ? ` <span>${esc(`${credits(r.approvedAmount)} credits,`)}</span> ${r.permanent ? `<span>${esc('for good')}</span>` : r.expiresAt ? dated('until', shortDate(r.expiresAt, { year: true })) : `<span>${esc('until the end of the period')}</span>`}` : ''}${r.denyReason ? ` <span translate="no">${esc(r.denyReason)}</span>` : ''}</span></li>` : '',
    ].join('');
    const body = `${approve ? `<div class="gv-decide"><h4>${esc('Approve')}</h4>${b ? '' : `<p class="status warn">${esc('There is no budget for this yet: nothing limits it, so there is nothing to raise. Set a budget first.')}</p>`}
        <div class="grid2"><label class="field"><span>${esc('Credits to add')}</span><input type="text" inputmode="decimal" id="gv-ap-amount" value="${esc(r.amount)}" /></label>
        <label class="field"><span>${esc('Until')}</span><select id="gv-ap-until"><option value="period">${esc(end ? `${t('End of period')} (${end})` : 'End of period')}</option>${r.until !== 'period' ? `<option value="asked" selected>${esc(`${t('As asked')} (${shortDate(r.until, { year: true })})`)}</option>` : ''}<option value="date">${esc('A date…')}</option><option value="permanent">${esc('For good (raise the budget)')}</option></select></label></div>
        <label class="field" id="gv-ap-date-f" hidden><span>${esc('Date')}</span><input type="date" id="gv-ap-date" /></label>
        <p class="hint" id="gv-ap-say"></p>
        <label class="field"><span>${esc('Note (optional)')}</span><input type="text" id="gv-ap-note" maxlength="2000" /></label>
        <div class="actions"><button type="button" class="primary" id="gv-ap-go"${b ? '' : ' disabled'}>${esc('Approve')}</button></div></div>
      <div class="gv-decide"><h4>${esc('Deny')}</h4><label class="field"><span>${esc('Reason (sent to the requester)')}</span><textarea id="gv-dn-reason" rows="2" maxlength="2000" placeholder="${esc('For example: finish the current backlog first')}"></textarea></label><div class="actions"><button type="button" class="danger-soft" id="gv-dn-go">${esc('Deny')}</button></div></div>` : ''}
      ${r.status === 'open' && (approve || mine) ? `<div class="gv-decide"><h4>${esc(approve ? 'Ask a question' : 'Add a message')}</h4><label class="field"><span>${esc(approve ? 'Question' : 'Message')}</span><textarea id="gv-cm-text" rows="2" maxlength="2000"></textarea></label><div class="actions"><button type="button" id="gv-cm-go">${esc(approve ? 'Send the question' : 'Send')}</button><span class="hint">${esc('The request stays open.')}</span></div></div>` : ''}
      ${mine && r.status === 'open' ? `<p><button type="button" class="danger-soft sm" id="gv-cancel-req">${esc('Withdraw my request')}</button></p>` : ''}
      <h3>${esc('History')}</h3><ol class="gv-thread">${thread}</ol>
      <p class="status" id="gv-req-status" role="status"></p>`;
    openSide({
      title: `<span translate="no">${esc(credits(r.amount))}</span> <span>${esc('credits for')}</span> ${r.entityType === 'user' && mine ? `<span>${esc('me')}</span>` : `<span translate="no">${esc(r.entityLabel || r.entityId)}</span>`} ${requestBadge(r.status)}`,
      sub: `<span>${esc('Asked by')}</span> <span translate="no">${esc(r.by)}</span> · <time translate="no">${esc(when(r.createdAt))}</time>${r.status === 'open' && r.waitingMinutes !== null && r.waitingMinutes !== undefined ? ` · <span>${esc(waitingLabel(r.waitingMinutes))}</span>` : ''}`,
      head,
      body,
      ready: (root) => {
        const say = () => {
          const amount = Number(String(root.querySelector('#gv-ap-amount')?.value ?? '').replace(/,/g, ''));
          const until = root.querySelector('#gv-ap-until')?.value;
          const dateF = root.querySelector('#gv-ap-date-f');
          if (dateF) dateF.hidden = until !== 'date';
          const go = root.querySelector('#gv-ap-go');
          if (go) go.textContent = Number.isFinite(amount) && amount > 0 ? `Approve ${credits(amount)} credits` : 'Approve';
          const sayEl = root.querySelector('#gv-ap-say');
          if (sayEl && b) sayEl.innerHTML = `<span>${esc(`Raises the budget to ${credits(b.limit + (Number.isFinite(amount) ? amount : 0))}`)}</span>${until === 'permanent' ? ` <span>${esc('for good')}</span>` : until === 'period' && end ? ` ${dated('until', end)}` : ''}<span>${esc(', lifts any restriction that is now under it, and emails')}</span> <span translate="no">${esc(r.by)}</span>.`;
        };
        root.querySelector('#gv-ap-amount')?.addEventListener('input', say);
        root.querySelector('#gv-ap-until')?.addEventListener('change', say);
        say();
        const act = async (path, body, okText) => {
          try {
            await write(path, 'POST', body);
            toast(okText, 'ok', 3000);
            closeSide();
            await refresh({ only: ['requests', 'budgets', 'overview'] });
          } catch (error) {
            if (!handleAuthLoss(error)) showError('gv-req-status', error);
          }
        };
        root.querySelector('#gv-ap-go')?.addEventListener('click', () => {
          const amount = String(root.querySelector('#gv-ap-amount').value).replace(/,/g, '').trim();
          const until = root.querySelector('#gv-ap-until').value;
          const date = root.querySelector('#gv-ap-date').value;
          if (until === 'date' && !date) return setStatus('gv-req-status', 'Choose the date.', 'error');
          act(`/api/govern/requests/${encodeURIComponent(r.id)}/decide`, { decision: 'approve', amount, permanent: until === 'permanent', ...(until === 'date' ? { expiresAt: new Date(`${date}T23:59:59Z`).toISOString() } : until === 'asked' ? { expiresAt: r.until } : {}), note: root.querySelector('#gv-ap-note').value }, 'Approved: the budget is raised and the requester emailed.');
        });
        root.querySelector('#gv-dn-go')?.addEventListener('click', () => {
          const reason = root.querySelector('#gv-dn-reason').value.trim();
          if (!reason) return setStatus('gv-req-status', 'Say why the request is denied.', 'error');
          act(`/api/govern/requests/${encodeURIComponent(r.id)}/decide`, { decision: 'deny', reason }, 'Denied: the requester is emailed.');
        });
        root.querySelector('#gv-cm-go')?.addEventListener('click', () => {
          const text = root.querySelector('#gv-cm-text').value.trim();
          if (!text) return setStatus('gv-req-status', 'Write something.', 'error');
          act(`/api/govern/requests/${encodeURIComponent(r.id)}/comment`, { text }, 'Sent.');
        });
        root.querySelector('#gv-cancel-req')?.addEventListener('click', () => {
          if (!confirm(t('Withdraw this request?'))) return;
          act(`/api/govern/requests/${encodeURIComponent(r.id)}/cancel`, {}, 'Request withdrawn.');
        });
      },
    });
  }

  // =============================================================================================================
  // Restrictions & alerts
  // =============================================================================================================

  const restrictionTable = makeTable({
    table: 'gv-restrictions',
    key: 'govern-restrictions',
    all: () => restrictionColumns({ when, canRestore: has('govern.restore') }),
    rows: () => (S.restrictions ? restrictionRows() : null),
    id: (r) => r.key,
    text: (r) => `${r.label} ${r.targetId} ${r.because.map((b) => b.label).join(' ')} ${KIND_LABEL[r.kind] ?? ''}`,
    search: 'gv-res-q',
    menu: 'gv-res-cols',
    select: () => has('govern.restore'),
    open: (r) => {
      const b = S.budgets?.items?.find((x) => x.id === r.because[0]?.budgetId);
      if (b) openBudget(b);
    },
    empty: () => 'Nothing is restricted. A budget in Enforce restricts at its limit.',
    changed: () => {
      const rows = restrictionTable.selected().filter((r) => r.kind !== 'grace' && r.state !== 'release_pending');
      $('gv-res-bar').hidden = !rows.length;
      $('gv-res-count').textContent = rows.length === 1 ? '1 restriction selected' : `${rows.length} restrictions selected`;
    },
  });
  function restrictionRows() {
    const used = (id) => {
      const b = S.budgets?.items?.find((x) => x.id === id);
      return b ? `${PERIOD_LABEL[b.period] ?? b.period} ${credits(b.limit)} · used ${credits(b.used)}` : '';
    };
    const rows = S.restrictions.items.map((r) => ({ ...r, usedLine: used(r.because[0]?.budgetId) }));
    for (const b of S.budgets?.items ?? []) {
      if (!b.grace) continue;
      rows.push({ key: `grace|${b.id}`, kind: 'grace', what: '', targetType: b.entityType, targetId: b.entityId, label: b.entityLabel, state: 'grace', since: b.grace.at ?? null, restoreMode: '', partial: [], because: [{ budgetId: b.id, label: b.entityLabel }], usedLine: used(b.id), graceUsage: Number(b.grace.usageAtRestore) + Number(b.grace.growBy ?? 1), graceUntil: b.grace.until ?? null });
    }
    return rows;
  }
  $('gv-restrictions').addEventListener('click', (event) => {
    const b = event.target.closest('[data-gv-restore]');
    if (b) restore([b.dataset.gvRestore]);
  });
  $('gv-res-bar').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.gvClear !== undefined) return restrictionTable.clear();
    if (button.dataset.gvRestoreSel !== undefined) restore(restrictionTable.selected().filter((r) => r.kind !== 'grace').map((r) => r.key));
  });
  async function restore(keys) {
    if (!keys.length) return;
    const rows = (S.restrictions?.items ?? []).filter((r) => keys.includes(r.key));
    const v = await ask({
      title: keys.length === 1 ? 'Restore this?' : `Restore ${keys.length} restrictions?`,
      body: `<ul class="gv-holds">${rows.map((r) => `<li><span>${esc(KIND_LABEL[r.kind] ?? r.what)}</span> · <b translate="no">${esc(r.label)}</b></li>`).join('')}</ul><p>${esc('Govern puts back what it took, in Checkmarx One, in the background. Then a grace: no new restriction until usage grows again, or until:')}</p><fieldset class="gv-radios"><label class="check"><input type="radio" name="grace" value="period" checked /> <span>${esc('the period ends')}</span></label><label class="check"><input type="radio" name="grace" value="date" /> <span>${esc('a date')}</span> <input type="date" name="graceDate" aria-label="${esc('Grace until')}" /></label></fieldset>`,
      confirm: 'Restore',
    });
    if (!v) return;
    if (v.grace === 'date' && !v.graceDate) return toast('Choose the date the grace ends.', 'bad');
    try {
      const r = await write('/api/govern/restrictions/restore', 'POST', { keys, ...(v.grace === 'date' ? { graceUntil: new Date(`${v.graceDate}T23:59:59Z`).toISOString() } : {}) });
      toast(r.unknown?.length ? `Restoring in Checkmarx One; ${r.unknown.length} were already lifted.` : 'Restoring in Checkmarx One: the list shows each one once it is done.', 'ok', 4000);
      restrictionTable.sel.clear();
      await refresh({ only: ['restrictions', 'budgets', 'overview'] });
    } catch (error) {
      if (!handleAuthLoss(error)) toast(error.message, 'bad');
    }
  }
  $('gv-res-csv').addEventListener('click', () => restrictionTable.csv('govern-restrictions'));
  $('gv-res-html').addEventListener('click', () => restrictionTable.html('govern-restrictions', 'Govern: active restrictions'));

  let alertSev = '';
  let alertCat = '';
  const alertTable = makeTable({
    table: 'gv-alerts',
    key: 'govern-alerts',
    all: () => alertColumns({ when }),
    rows: () => (S.alerts ? S.alerts.items.filter((a) => (!alertSev || ['info', 'warning', 'error', 'critical'].indexOf(a.severity) >= ['info', 'warning', 'error', 'critical'].indexOf(alertSev)) && (!alertCat || a.category === alertCat) && (!$('gv-alert-unread').checked || !a.read)) : null),
    id: (a) => a.id,
    text: (a) => `${a.title} ${a.body} ${a.entity?.label ?? ''}`,
    search: 'gv-alert-q',
    menu: 'gv-alert-cols',
    select: true,
    rowCls: (a) => (a.read ? '' : 'unread'),
    empty: () => 'No alert yet.',
    changed: () => {
      const rows = alertTable.selected();
      $('gv-alert-bar').hidden = !rows.length;
      $('gv-alert-count').textContent = rows.length === 1 ? '1 alert selected' : `${rows.length} alerts selected`;
      $('gv-alert-readsel').hidden = !rows.some((a) => !a.read);
    },
  });
  function renderAlerts() {
    const items = S.alerts?.items ?? [];
    const unread = S.alerts?.unread ?? 0;
    $('gv-alert-unread-n').textContent = unread ? `${num(unread)} unread` : '';
    $('gv-alert-unread-n').hidden = !unread;
    $('gv-alert-allread').disabled = !unread;
    const sevs = [['', 'All'], ['critical', 'Critical'], ['error', 'Error'], ['warning', 'Warning'], ['info', 'Info']];
    $('gv-alert-sev').innerHTML = sevs.map(([v, label]) => `<label><input type="radio" name="gv-sev" value="${v}"${alertSev === v ? ' checked' : ''} /><span>${esc(label)}</span></label>`).join('');
    const counts = {};
    for (const a of items) counts[a.category] = (counts[a.category] ?? 0) + 1;
    $('gv-alert-cats').innerHTML = [['', 'All', items.length], ...Object.keys(CATEGORY_CHIP).filter((c) => counts[c]).map((c) => [c, CATEGORY_CHIP[c], counts[c]])].map(([k, label, n]) => `<button type="button" class="fusion-chip sm" data-gv-cat="${k}" aria-pressed="${alertCat === k}"><span>${esc(label)}</span> <small translate="no">${num(n)}</small></button>`).join('');
    const backlog = S.alerts?.backlog;
    $('gv-alert-backlog').textContent = backlog && backlog.email + backlog.webhook + backlog.direct ? `Waiting to be delivered: ${backlog.email} by email, ${backlog.webhook} by webhook, ${backlog.direct} to requesters.` : '';
    alertTable.render();
  }
  $('gv-alert-sev').addEventListener('change', (event) => {
    alertSev = event.target.value;
    alertTable.render();
  });
  $('gv-alert-cats').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-gv-cat]');
    if (!chip) return;
    alertCat = chip.dataset.gvCat;
    renderAlerts();
  });
  $('gv-alert-unread').addEventListener('change', () => alertTable.render());
  async function markRead(body) {
    try {
      const r = await write('/api/govern/alerts/read', 'POST', body, { quiet: true });
      if (S.alerts) {
        S.alerts.unread = r.unread;
        for (const a of S.alerts.items) if (body.all || body.ids.includes(a.id)) a.read = true;
      }
      alertTable.sel.clear();
      renderAlerts();
    } catch (error) {
      if (!handleAuthLoss(error)) toast(error.message, 'bad');
    }
  }
  $('gv-alert-allread').addEventListener('click', () => markRead({ all: true }));
  $('gv-alert-bar').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.gvClear !== undefined) return alertTable.clear();
    if (button.id === 'gv-alert-readsel') markRead({ ids: alertTable.selected().map((a) => a.id) });
  });
  $('gv-alert-csv').addEventListener('click', () => alertTable.csv('govern-alerts'));
  $('gv-alert-html').addEventListener('click', () => alertTable.html('govern-alerts', 'Govern: alerts'));

  // =============================================================================================================
  // Attribution
  // =============================================================================================================

  let attrTab = 'disputes';
  let attrDim = '';
  const attributionTable = makeTable({
    table: 'gv-attribution',
    key: 'govern-attribution',
    all: () => attributionColumns({ canDecide: has('govern.attribution') }),
    rows: () => (S.attribution ? S.attribution.items.filter((r) => r.tab === attrTab && (!attrDim || r.dimension === attrDim)) : null),
    id: (r) => r.key,
    text: (r) => `${r.name} ${r.email} ${r.entityLabel}`,
    search: 'gv-attr-q',
    menu: 'gv-attr-cols',
    select: () => has('govern.attribution'),
    open: (r) => openAttribution(r),
    empty: () => ({ disputes: 'No disputes: every name Checkmarx One reports is matched, or decided.', matched: 'Nothing matched yet.', unmatched: 'Every name matches someone here.', ignored: 'Nothing ignored.' })[attrTab],
    changed: () => {
      const rows = attributionTable.selected();
      const acts = attributionActions(rows, perms());
      $('gv-attr-bar').hidden = !rows.length;
      $('gv-attr-count').textContent = rows.length === 1 ? '1 name selected' : `${rows.length} names selected`;
      for (const b of $('gv-attr-bar').querySelectorAll('[data-gv-abulk]')) b.hidden = !acts.includes(b.dataset.gvAbulk);
    },
  });
  function renderAttribution() {
    const all = S.attribution?.items ?? [];
    const counts = Object.fromEntries(ATTRIBUTION_TABS.map((k) => [k, all.filter((r) => r.tab === k && (!attrDim || r.dimension === attrDim)).length]));
    S.attributionCounts = Object.fromEntries(ATTRIBUTION_TABS.map((k) => [k, all.filter((r) => r.tab === k).length]));
    $('gv-attr-tabs').innerHTML = ATTRIBUTION_TABS.map((k) => `<label><input type="radio" name="gv-attr-tab" value="${k}"${attrTab === k ? ' checked' : ''} /><span>${esc(ATTRIBUTION_TAB_LABEL[k])} <small translate="no">${num(counts[k])}</small></span></label>`).join('');
    const dims = {};
    for (const r of all.filter((x) => x.tab === attrTab)) dims[r.dimension] = (dims[r.dimension] ?? 0) + 1;
    $('gv-attr-dims').innerHTML = [['', 'All', null], ...LEVELS.map((l) => [l, LEVEL_PLURAL[l], dims[l] ?? 0])].map(([k, label, n]) => `<button type="button" class="fusion-chip sm" data-gv-dim="${k}" aria-pressed="${attrDim === k}"><span>${esc(label)}</span>${n === null ? '' : ` <small translate="no">${num(n)}</small>`}</button>`).join('');
    $('gv-attr-hint').textContent = ATTRIBUTION_TAB_HINT[attrTab];
    const unmatched = all.filter((r) => r.tab === 'unmatched');
    $('gv-attr-sum').textContent = attrTab === 'unmatched' && unmatched.length ? `${credits(unmatched.reduce((n, r) => n + r.credits, 0))} credits count towards no budget until these are mapped or ignored.` : '';
    attributionTable.render();
    renderTop();
  }
  $('gv-attr-tabs').addEventListener('change', (event) => {
    attrTab = event.target.value;
    attributionTable.sel.clear();
    renderAttribution();
  });
  $('gv-attr-dims').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-gv-dim]');
    if (!chip) return;
    attrDim = chip.dataset.gvDim;
    renderAttribution();
  });
  async function decide(key, action, extra = {}) {
    try {
      await write('/api/govern/attribution/decide', 'POST', { key, action, ...extra });
      return true;
    } catch (error) {
      if (!handleAuthLoss(error)) toast(error.message, 'bad');
      return false;
    }
  }
  $('gv-attribution').addEventListener('click', async (event) => {
    const map = event.target.closest('[data-gv-map]');
    if (map) {
      const r = S.attribution?.items.find((x) => x.key === map.dataset.gvMap);
      if (r) openAttribution(r, { focusPick: true });
      return;
    }
    const b = event.target.closest('[data-gv-decide]');
    if (!b) return;
    const action = b.dataset.gvDecide;
    let why = '';
    if (action === 'ignore') {
      const v = await ask({ title: 'Ignore this name?', body: `<p>${esc('A shared or service account: its credits count towards no one. The decision is kept and written to the audit log.')}</p><label class="field"><span>${esc('Why (optional)')}</span><input type="text" name="why" maxlength="500" autofocus /></label>`, confirm: 'Ignore' });
      if (!v) return;
      why = v.why;
    }
    if (action === 'reject' && !confirm(t('Reject this match? Govern never matches these two again; the name goes back to the disputes.'))) return;
    if (await decide(b.dataset.key, action, why ? { why } : {})) {
      toast({ ignore: 'Ignored.', reject: 'Match rejected.', clear: 'Decision cleared.' }[action] ?? 'Done.', 'ok', 2500);
      await refresh({ only: ['attribution', 'overview'] });
    }
  });
  $('gv-attr-bar').addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.gvClear !== undefined) return attributionTable.clear();
    const action = button.dataset.gvAbulk;
    if (!action) return;
    const rows = attributionTable.selected().filter((r) => (action === 'ignore' ? r.status !== 'ignored' : r.decision));
    if (!confirm(t(action === 'ignore' ? `Ignore ${rows.length} names? Their credits count towards no one.` : `Clear the decisions on ${rows.length} names? Govern matches them again.`))) return;
    let n = 0;
    for (const r of rows) if (await decide(r.key, action)) n += 1;
    toast(`${n} done.`, 'ok', 2500);
    attributionTable.sel.clear();
    await refresh({ only: ['attribution', 'overview'] });
  });

  function openAttribution(r, { focusPick = false } = {}) {
    const may = has('govern.attribution');
    const d = r.decision;
    openSide({
      title: `<span class="gv-mono" translate="no">${esc(r.name || r.email || r.subjectKey)}</span> ${levelTag(r.dimension)}`,
      sub: `<span>${esc('As Checkmarx One reports it')}</span>${r.email && r.email !== r.name ? ` · <span translate="no">${esc(r.email)}</span>` : ''}`,
      head: `<div class="fusion-facts"><div><span>${esc('Credits')}</span><b translate="no">${esc(credits(r.credits))}</b><small>${esc('in the lookback window')}</small></div><div><span>${esc('Counts towards')}</span><b translate="no">${esc(r.entityId ? r.entityLabel || r.entityId : '—')}</b><small>${esc(MATCH_LABEL[r.status] ?? r.status)}</small></div></div>${r.ghost ? `<p class="status warn">${esc('Mapped to someone no longer in Checkmarx One: its credits count towards no one. Map it again, or clear the decision.')}</p>` : ''}`,
      body: `${r.suggestions?.length ? `<h3>${esc('Suggestions')}</h3><div class="gv-sugg-list">${r.suggestions.map((s, i) => `<button type="button" class="gv-sugg${i === 0 ? ' top' : ''}" data-gv-pin="${esc(s.id)}"${may ? '' : ' disabled'}><span translate="no">${esc(s.label)}</span><em translate="no">${Math.round(Number(s.score) * 100)}%</em></button>`).join('')}</div><p class="hint">${esc('Choose one to map this name to it.')}</p>` : ''}
        ${may ? `<h3>${esc('Map to someone else')}</h3>${pickerHtml(LEVEL_LABEL[r.dimension] ?? 'Applies to', 'gv-mpick')}
        <label class="field"><span>${esc('Why (optional)')}</span><input type="text" id="gv-map-why" maxlength="500" /></label>
        <h3>${esc('Or')}</h3><div class="actions">${r.entityId && r.status !== 'pinned' ? `<button type="button" data-gv-side-decide="reject">${esc('Reject this match')}</button>` : ''}${r.status !== 'ignored' ? `<button type="button" data-gv-side-decide="ignore">${esc('Ignore')}</button>` : ''}${d ? `<button type="button" data-gv-side-decide="clear">${esc('Clear the decision')}</button>` : ''}</div>
        <p class="hint">${esc('Map: choose who it counts towards. Reject this match: never match these two again. Ignore: a shared or service account, counted towards no one. Each decision is kept, written to the audit log, and applied to the same name\'s other spellings.')}</p>` : `<p class="hint">${esc('Deciding needs the “Decide attribution” permission.')}</p>`}
        ${d ? `<h3>${esc('Decision')}</h3><p class="hint"><span>${esc(d.pinned ? 'Mapped' : d.ignored ? 'Ignored' : 'Rejected matches only')}</span> · <span translate="no">${esc(`${d.by ?? ''} ${d.at ? when(d.at) : ''}`)}</span>${d.why ? ` · <span translate="no">${esc(d.why)}</span>` : ''}${d.alias ? ` · <span>${esc('carried from another spelling')}</span>` : ''}</p>` : ''}
        <p class="status" id="gv-attr-status" role="status"></p>`,
      ready: (root) => {
        const done = async (action, extra, okText) => {
          if (await decide(r.key, action, extra)) {
            toast(okText, 'ok', 2500);
            closeSide();
            await refresh({ only: ['attribution', 'overview'] });
          }
        };
        const why = () => root.querySelector('#gv-map-why')?.value ?? '';
        for (const b of root.querySelectorAll('[data-gv-pin]')) b.addEventListener('click', () => done('pin', { entityId: b.dataset.gvPin, why: why() }, 'Mapped.'));
        if (may) {
          picker(root.querySelector('.gv-form') ?? root, { type: () => r.dimension, onPick: (it) => done('pin', { entityId: it.id, why: why() }, 'Mapped.') });
          if (focusPick) setTimeout(() => root.querySelector('#gv-mpick')?.focus(), 30);
        }
        for (const b of root.querySelectorAll('[data-gv-side-decide]')) b.addEventListener('click', () => {
          const a = b.dataset.gvSideDecide;
          if (a === 'reject' && !confirm(t('Reject this match? Govern never matches these two again; the name goes back to the disputes.'))) return;
          done(a, why() ? { why: why() } : {}, { ignore: 'Ignored.', reject: 'Match rejected.', clear: 'Decision cleared.' }[a]);
        });
      },
    });
  }

  // =============================================================================================================
  // Settings
  // =============================================================================================================

  function renderSettings() {
    const s = S.settings?.settings;
    const form = $('gv-set-form');
    if (!s) {
      form.hidden = true;
      return;
    }
    form.hidden = false;
    const set = (name, value) => {
      const el = form.elements[name];
      if (!el) return;
      if (el instanceof RadioNodeList) {
        for (const r of el) r.checked = String(r.value) === String(value);
      } else if (el.type === 'checkbox') el.checked = Boolean(value);
      else el.value = value ?? '';
    };
    set('cycleMinutes', s.cycleMinutes);
    set('window', s.window);
    set('graceGrowBy', s.graceGrowBy);
    set('prDisableUnreadable', s.prDisableUnreadable);
    for (const k of ['pageSize', 'orgRefreshMinutes', 'driftEveryCycles', 'maxTargetsDefault', 'requestExpiryDays', 'staleAfterCycles']) set(k, s[k]);
    set('minSeverity', s.notify.minSeverity);
    set('emailOn', s.notify.email.on);
    set('emailRecipients', s.notify.email.recipients.join(', '));
    set('emailMinSeverity', s.notify.email.minSeverity);
    set('webhookOn', s.notify.webhook.on);
    set('webhookUrl', s.notify.webhook.url);
    set('webhookMinSeverity', s.notify.webhook.minSeverity);
    const secret = form.elements.webhookSecret;
    secret.value = '';
    secret.disabled = s.notify.webhook.secretSet;
    secret.placeholder = s.notify.webhook.secretSet ? '••••••••••••' : t('Not set');
    $('gv-secret-state').textContent = s.notify.webhook.secretSet ? 'Set · never shown again' : 'Not set: calls are not signed';
    $('gv-secret-change').hidden = !s.notify.webhook.secretSet;
    $('gv-secret-change').textContent = 'Change';
    // AI roles: the three defaults and view-scans, then any other this tenant named.
    const roles = [...new Set([...DEFAULT_AI_ROLES, 'view-scans', ...s.aiRoles])];
    $('gv-set-roles').innerHTML = roles.map((r) => `<label class="check"><input type="checkbox" name="aiRole" value="${esc(r)}"${s.aiRoles.includes(r) ? ' checked' : ''} /> <span class="gv-mono" translate="no">${esc(r)}</span></label>`).join('');
    aiGroups = [...s.aiOnlyGroups];
    renderGroupChips();
    viewScansWarn();
    const last = S.runs?.items?.[0];
    $('gv-set-last').innerHTML = last ? `<span>${esc('Last:')}</span> <time translate="no">${esc(when(last.startedAt))}</time>${last.finishedAt ? ` · <span translate="no">${esc(`${Math.max(0, Math.round((Date.parse(last.finishedAt) - Date.parse(last.startedAt)) / 1000))} s`)}</span>` : ''} · <span>${esc(last.status === 'success' ? 'complete' : last.status === 'partial' ? 'partly read' : last.status === 'running' ? 'running' : 'failed')}</span>${S.settings.nextRunAt ? ` · <span>${esc(`next ${inLabel(S.settings.nextRunAt)}`)}</span>` : ''}` : esc('No cycle has run yet.');
    renderPermissions();
  }
  let aiGroups = [];
  const groupLabels = new Map();
  function renderGroupChips() {
    $('gv-set-groups-chips').innerHTML = aiGroups.map((g) => `<span class="chip"><span translate="no">${esc(groupLabels.get(g) ?? g)}</span><button type="button" class="chip-x" data-gv-ungroup="${esc(g)}" aria-label="${esc('Remove this group')}">×</button></span>`).join('');
  }
  const viewScansWarn = () => {
    const box = $('gv-set-roles').querySelector('input[value="view-scans"]');
    $('gv-set-viewscans').hidden = !box?.checked;
  };
  $('gv-set-roles').addEventListener('change', viewScansWarn);
  $('gv-set-groups-chips').addEventListener('click', (event) => {
    const x = event.target.closest('[data-gv-ungroup]');
    if (!x) return;
    aiGroups = aiGroups.filter((g) => g !== x.dataset.gvUngroup);
    renderGroupChips();
  });
  const groupPick = picker($('gv-set-groups'), {
    type: () => 'group',
    onPick: (it) => {
      if (!aiGroups.includes(it.id)) aiGroups.push(it.id);
      groupLabels.set(it.id, it.label);
      $('gv-set-groups').querySelector('[data-gv-pick-q]').value = '';
      $('gv-set-groups').querySelector('[data-gv-pick-list]').hidden = true;
      renderGroupChips();
    },
  });
  void groupPick;
  $('gv-secret-change').addEventListener('click', () => {
    const secret = $('gv-set-form').elements.webhookSecret;
    secret.disabled = false;
    secret.placeholder = t('A new secret (empty: no signing)');
    secret.dataset.changing = '1';
    secret.focus();
  });
  $('gv-set-add-role').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const v = event.target.value.trim();
    if (!v) return;
    if (!$('gv-set-roles').querySelector(`input[value="${CSS.escape(v)}"]`)) $('gv-set-roles').insertAdjacentHTML('beforeend', `<label class="check"><input type="checkbox" name="aiRole" value="${esc(v)}" checked /> <span class="gv-mono" translate="no">${esc(v)}</span></label>`);
    event.target.value = '';
  });
  $('gv-set-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const before = S.settings?.settings;
    const roles = [...form.querySelectorAll('input[name="aiRole"]:checked')].map((x) => x.value);
    const confirmViewScans = roles.includes('view-scans') && !before?.aiRoles.includes('view-scans');
    if (confirmViewScans && !confirm(t('Remove view-scans too? A restricted person then cannot see scans at all, not only AI. Only do this if the teams agreed.'))) return;
    const secret = form.elements.webhookSecret;
    const body = {
      cycleMinutes: Number(form.querySelector('input[name="cycleMinutes"]:checked')?.value ?? 15),
      window: form.elements.window.value,
      graceGrowBy: form.elements.graceGrowBy.value,
      prDisableUnreadable: form.elements.prDisableUnreadable.checked,
      aiRoles: roles,
      aiOnlyGroups: aiGroups,
      ...(confirmViewScans ? { confirmViewScans: true } : {}),
      ...Object.fromEntries(['pageSize', 'orgRefreshMinutes', 'driftEveryCycles', 'maxTargetsDefault', 'requestExpiryDays', 'staleAfterCycles'].map((k) => [k, Number(form.elements[k].value)])),
      notify: {
        minSeverity: form.elements.minSeverity.value,
        email: { on: form.elements.emailOn.checked, recipients: form.elements.emailRecipients.value, minSeverity: form.elements.emailMinSeverity.value },
        webhook: { on: form.elements.webhookOn.checked, url: form.elements.webhookUrl.value.trim(), minSeverity: form.elements.webhookMinSeverity.value, ...(!secret.disabled && (secret.value || secret.dataset.changing) ? { secret: secret.value } : {}) },
      },
    };
    try {
      const r = await write('/api/govern/settings', 'PUT', body);
      S.settings = { ...S.settings, settings: r.settings };
      delete secret.dataset.changing;
      setStatus('gv-set-status', 'Saved.', 'ok');
      toast('Govern settings saved.', 'ok', 2500);
      renderSettings();
      refresh({ only: ['overview'] });
    } catch (error) {
      if (!handleAuthLoss(error)) showError('gv-set-status', error);
    }
  });
  for (const ch of ['email', 'webhook']) {
    $(`gv-test-${ch}`).addEventListener('click', async () => {
      setStatus('gv-test-result', ch === 'email' ? 'Sending a test email…' : 'Calling the webhook…');
      try {
        const r = await write('/api/govern/settings/test', 'POST', { channel: ch });
        setStatus('gv-test-result', ch === 'email' ? `Test email sent to ${r.to} recipient(s).` : `The webhook answered ${r.status}${r.signed ? ', signed' : ', not signed (no secret)'}.`, 'ok');
      } catch (error) {
        if (!handleAuthLoss(error)) {
          $('gv-test-result').className = 'status error gv-head-note';
          $('gv-test-result').innerHTML = `<span>${esc(ch === 'email' ? 'The test email failed:' : 'The webhook test failed:')}</span> <span translate="no">${esc(error.message)}</span>`;
        }
      }
    });
  }

  const USED_FOR = { 'Credit consumption': 'Every budget: what each one used', 'Tenant credits': 'The figures line', 'IAM users': 'Who a budget is for; users\' roles', 'IAM groups': 'Group budgets and their members', Projects: 'Project budgets', Applications: 'Application budgets', 'IAM administration (ast-app client)': 'Removing and restoring AI roles', 'Project AI agents configuration': 'Turning Auto Triage off and on' };
  const WRITE_OF = { 'IAM administration (ast-app client)': 'user_roles', 'Project AI agents configuration': 'auto_triage' };
  function renderPermissions() {
    const p = S.permissions;
    const box = $('gv-perm-body');
    if (!p) {
      box.innerHTML = `<p class="hint">${esc('Loading…')}</p>`;
      return;
    }
    const check = p.check;
    const writes = p.writes ?? {};
    const writeCell = (kind) => {
      const w = writes[kind];
      if (!kind) return '<span class="gv-wait">—</span>';
      if (w === 'ok') return `<span class="gv-ok"><span aria-hidden="true">✓</span> <span>${esc('Worked')}</span></span>`;
      if (w === 'denied') return `<span class="gv-bad"><span aria-hidden="true">✕</span> <span>${esc('Refused (403): monitor only')}</span></span>`;
      return `<span class="gv-wait">${esc('Shown after the first change')}</span>`;
    };
    const readCell = (x) => (x.ok === true ? `<span class="gv-ok"><span aria-hidden="true">✓</span> <span>${esc('Allowed')}</span></span>` : x.ok === false ? `<span class="gv-bad">✕ <span translate="no">${esc(x.note || `${x.status}`)}</span></span>` : `<span class="gv-wait" translate="no">${esc(x.note || '—')}</span>`);
    const rows = (check?.reads ?? []).map((x) => `<tr><td class="gv-mx-what">${esc(x.label)}</td><td class="hint-cell">${esc(USED_FOR[x.label] ?? '')}</td><td>${readCell(x)}</td><td>${writeCell(WRITE_OF[x.label])}</td></tr>`);
    if (check?.reads?.length) rows.push(`<tr><td class="gv-mx-what">${esc('PR remediation settings')}</td><td class="hint-cell">${esc('Turning PR remediation off and on')}</td><td><span class="gv-wait">—</span></td><td>${writeCell('pr_remediation')}</td></tr>`);
    $('gv-perm-at').innerHTML = check?.at ? dated('Checked', when(check.at)) : '';
    box.innerHTML = check?.error
      ? `<p class="status error" translate="no">${esc(check.error)}</p>`
      : rows.length
        ? `<div class="table-wrap"><table class="data-table gv-mx" data-tt-off><thead><tr><th>${esc('Checkmarx One')}</th><th>${esc('Used for')}</th><th>${esc('Read')}</th><th>${esc('Change')}</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>${check.note ? `<p class="hint">${esc('A change can only be known after the first real one: denied means Govern is monitor-only for it with this key.')}</p>` : ''}`
        : `<p class="hint">${esc('Not checked yet: Run check tries each read now.')}</p>`;
  }
  $('gv-perm-run').addEventListener('click', async () => {
    const button = $('gv-perm-run');
    button.disabled = true;
    const before = S.permissions?.check?.at ?? '';
    try {
      await write('/api/govern/permissions/check', 'POST', {});
      for (let i = 0; i < 30; i += 1) {
        await new Promise((r) => setTimeout(r, 1000));
        const r = await read('/api/govern/permissions');
        if ((r.data.check?.at ?? '') !== before) {
          S.permissions = r.data;
          break;
        }
      }
      renderPermissions();
    } catch (error) {
      if (!handleAuthLoss(error)) toast(error.message, 'bad');
    } finally {
      button.disabled = false;
    }
  });

  // =============================================================================================================
  // Run now (polled; the page stays usable)
  // =============================================================================================================

  $('gv-run').addEventListener('click', async () => {
    try {
      const r = await write('/api/govern/run', 'POST', {});
      S.run = r.runId;
      renderTop();
      toast(r.started ? 'A cycle started: the figures update when it ends.' : 'A cycle is already running: following it.', 'ok', 3000);
      pollRun(r.runId);
    } catch (error) {
      if (!handleAuthLoss(error)) toast(error.message, 'bad');
    }
  });
  async function pollRun(id) {
    for (let i = 0; i < 300 && S.run === id; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const r = await read(`/api/govern/runs/${encodeURIComponent(id)}`);
        if (r.data.run?.finishedAt) {
          S.run = null;
          const status = r.data.run.status;
          toast(status === 'success' ? 'Cycle finished.' : status === 'partial' ? 'Cycle finished, partly read: figures that were not read keep their last good value.' : `The cycle failed: ${r.data.run.error || 'see Logs'}`, status === 'failed' ? 'bad' : 'ok', 5000);
          await refresh({ quiet: true });
          return;
        }
      } catch {
        break;
      }
    }
    S.run = null;
    renderTop();
  }

  // =============================================================================================================
  // Loading and polling
  // =============================================================================================================

  const loaders = {
    overview: async () => {
      const r = await read('/api/govern/overview');
      S.overview = r.data;
      return r.changed;
    },
    budgets: async () => {
      if (!has('govern.view')) return false;
      const r = await read('/api/govern/budgets?limit=500');
      S.budgets = r.data;
      return r.changed;
    },
    exemptions: async () => {
      if (!has('govern.view')) return false;
      const r = await read('/api/govern/exemptions');
      S.exemptions = r.data.items;
      return r.changed;
    },
    requests: async () => {
      const r = await read('/api/govern/requests?limit=500');
      S.requests = r.data;
      S.requestCounts = r.data.counts;
      return r.changed;
    },
    restrictions: async () => {
      if (!has('govern.view')) return false;
      const r = await read('/api/govern/restrictions?limit=500');
      S.restrictions = r.data;
      return r.changed;
    },
    alerts: async () => {
      if (!has('govern.view')) return false;
      const r = await read('/api/govern/alerts?limit=500');
      S.alerts = r.data;
      return r.changed;
    },
    attribution: async () => {
      if (!has('govern.attribution') && !has('govern.view')) return false;
      const r = await read('/api/govern/attribution?limit=500');
      S.attribution = r.data;
      return r.changed;
    },
    settings: async () => {
      if (!has('govern.settings')) return false;
      const [s, p, runs] = await Promise.all([read('/api/govern/settings'), read('/api/govern/permissions'), has('govern.view') ? read('/api/govern/runs') : Promise.resolve({ data: null, changed: false })]);
      S.settings = s.data;
      S.permissions = p.data;
      S.runs = runs.data;
      if (s.data.settings?.aiOnlyGroups?.length && !groupLabels.size) {
        try {
          for (const g of (await read('/api/govern/entities?type=group')).data.items ?? []) groupLabels.set(g.id, g.label);
        } catch {}
      }
      return s.changed || p.changed || runs.changed;
    },
  };
  /** What each tab reads (beyond the overview and requests, which the top needs on every tab). */
  const NEEDS = { overview: ['budgets'], budgets: ['budgets', 'exemptions'], requests: ['budgets'], restrictions: ['restrictions', 'budgets', 'alerts'], attribution: ['attribution'], settings: ['settings'] };
  const RENDER = { overview: renderOverview, budgets: () => (importing ? renderImport() : renderBudgets()), requests: renderRequests, restrictions: () => (restrictionTable.render(), renderAlerts()), attribution: renderAttribution, settings: renderSettings };

  const currentTab = () => page.querySelector('[data-ptabs="govern"] [data-pt].active')?.dataset.pt ?? 'overview';
  function fixTabs() {
    const allowed = tabsFor(perms());
    for (const tab of page.querySelectorAll('[data-ptabs="govern"] [data-pt]')) tab.hidden = !allowed.includes(tab.dataset.pt);
    const active = page.querySelector('[data-ptabs="govern"] [data-pt].active');
    if (!active || active.hidden || !allowed.includes(active.dataset.pt)) page.querySelector(`[data-ptabs="govern"] [data-pt="${allowed[0] ?? 'overview'}"]`)?.click();
  }

  async function refresh({ quiet = false, only = null } = {}) {
    if (!S.me) return;
    const tab = currentTab();
    const want = only ?? ['overview', 'requests', 'restrictions', ...(NEEDS[tab] ?? [])];
    const list = [...new Set(want)].filter((k) => loaders[k]);
    const results = await Promise.allSettled(list.map((k) => loaders[k]()));
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) {
      const error = failed.reason;
      if (handleAuthLoss(error)) return;
      if (error.status === 403 && error.body?.locked) {
        setStatus('gv-status', 'Govern is not unlocked on this server: its activation code is needed.', 'error');
        return;
      }
      if (!quiet || !S.overview) showError('gv-status', error);
    } else setStatus('gv-status', '');
    const changed = results.some((r) => r.status === 'fulfilled' && r.value);
    if (!changed && quiet) return;
    renderTop();
    RENDER[currentTab()]?.();
  }

  async function load({ quiet = false } = {}) {
    if (S.loading) return;
    S.loading = true;
    if (!S.me && !quiet) setStatus('gv-status', 'Reading Govern…');
    try {
      const mine = await read('/api/govern/me');
      S.me = { ...mine.data, email: String(me()?.email ?? '').toLowerCase() };
      fixTabs();
      page.classList.toggle('gv-personal-view', isPersonal(perms()));
      setStatus('gv-status', '');
      renderTop();
      RENDER[currentTab()]?.();
      await refresh({ quiet });
    } catch (error) {
      if (handleAuthLoss(error)) return;
      if (error.status === 403 && error.body?.locked) setStatus('gv-status', 'Govern is not unlocked on this server: its activation code is needed.', 'error');
      else showError('gv-status', error);
    } finally {
      S.loading = false;
    }
  }

  setInterval(() => {
    if (!S.me || page.hidden || document.hidden || !active()) return;
    refresh({ quiet: true });
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.me && !page.hidden) refresh({ quiet: true });
  });

  // ---- The page's own clicks: links to other tabs; the overview's toggles; exports ----
  page.addEventListener('click', (event) => {
    const go = event.target.closest('[data-gv-goto]');
    if (!go) return;
    const tab = go.dataset.gvGoto;
    if (go.dataset.level !== undefined) level = go.dataset.level;
    closeSide();
    page.querySelector(`[data-ptabs="govern"] [data-pt="${tab}"]`)?.click();
  });
  $('gv-range').addEventListener('change', (event) => {
    range = event.target.value;
    renderTrend();
  });
  $('gv-top-level').addEventListener('change', (event) => {
    topLevel = event.target.value;
    renderOverview();
  });
  $('gv-top-csv').addEventListener('click', () => topTable.csv(`govern-top-${topLevel}`));
  $('gv-top-html').addEventListener('click', () => topTable.html(`govern-top-${topLevel}`, `Govern: top ${LEVEL_PLURAL[topLevel].toLowerCase()}`));
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!page.hidden && currentTab() === 'overview' && S.overview && !S.overview.personal) renderTrend();
    }, 150);
  });

  return {
    load,
    close: closeSide,
    /** A tab was shown (by a click, the address or the menu): read and draw it. */
    tabShown(name) {
      S.tab = name;
      if (!S.me) return;
      RENDER[name]?.();
      refresh({ quiet: true, only: NEEDS[name] });
    },
  };
}
