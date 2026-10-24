/**
 * Labs → Consolidated view (Beta): every connected tenant in one place, read only (GET /api/consolidated reads each
 * tenant's own memory; each visit is written to that tenant's audit log). Tabs: Overview (a card per tenant and the
 * tenants side by side), Projects (every tenant's Workbench projects), Fusion, Credits, Status board. Every row and
 * card names its tenant in the tenant's colour; every table has a tenant filter; "Open" switches to that tenant the
 * normal way (POST /api/me/tenant).
 */
import { sortAndFilter } from './table-tools.js';
import { columnMenu, shownColumns } from './column-prefs.js';
import { PAGE_ROWS, boardColumns, boardCsv, boardReport, legendHtml, renderBoard } from './status-board.js';
import { SCAN_TYPE, ago, csvText, esc, num, reportHtml, reportScanTag, reportTenant, rowScanClass, save, scanTag, sevChips, stamp, tenantChip } from './labs-common.js';

const HEALTH = {
  healthy: ['Healthy', ''],
  failed: ['Last fetch failed', 'warn'],
  stale: ['Not fetched for a day', 'warn'],
  notLoaded: ['Not loaded — open it once', 'gv-dashed'],
};
export const healthBadge = (h) => `<span class="badge ${HEALTH[h]?.[1] ?? ''}">${esc(HEALTH[h]?.[0] ?? h)}</span>`;

export function initConsolidated({ api, $, toast, showError, setStatus, fmtDateTime }) {
  let data = null;
  let loading = false;
  // The tenant chosen in each table's filter ('' = every tenant), and how many rows are drawn.
  const pick = { side: '', projects: '', fusion: '', credits: '', status: '' };
  const limits = { projects: PAGE_ROWS, status: PAGE_ROWS };
  const boardCtx = { max: 0 };
  let shown = { side: [], projects: [], fusion: [], credits: [], status: [] };
  const date = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—');
  const tenants = () => data?.tenants ?? [];
  const byTenant = (key, rows) => (pick[key] ? rows.filter((r) => (r.tenantId ?? r.id) === pick[key]) : rows);
  const words = (id) => $(id).value.toLowerCase().split(',').map((w) => w.trim()).filter(Boolean);
  const matches = (id, ...fields) => {
    const w = words(id);
    return !w.length || w.some((x) => fields.join(' ').toLowerCase().includes(x));
  };

  async function load({ quiet = false } = {}) {
    if (loading) return;
    loading = true;
    if (!data) setStatus('cv-status', 'Reading every tenant…');
    try {
      data = await api('/api/consolidated', { quiet: true });
      setStatus('cv-status', '');
      render();
    } catch (error) {
      if (!quiet) showError('cv-status', error);
    } finally {
      loading = false;
    }
  }

  /** "All 241 · acme-eu 112 · …": a tenant filter above a table. */
  function chips(key, countOf) {
    const all = tenants().reduce((n, t) => n + countOf(t), 0);
    const chip = (id, label, n, extra = '') => `<button type="button" class="fusion-chip sm${pick[key] === id ? ' primary' : ''}" data-cv-pick="${esc(key)}" data-tenant="${esc(id)}" aria-pressed="${pick[key] === id}">${extra}${label} <small translate="no">${num(n)}</small></button>`;
    return chip('', '<span>All</span>', all) + tenants().map((t) => chip(t.id, `<span translate="no">${esc(t.name)}</span>`, countOf(t), `<i class="key tc-key tc-${t.colour}" aria-hidden="true"></i>`)).join('');
  }

  function figures() {
    const f = data.figures;
    const item = (label, value, cls = '', small = '') => `<span class="${cls}"><span>${esc(label)}</span> <b translate="no">${esc(value)}</b>${small ? ` <small>${small}</small>` : ''}</span>`;
    return [
      item('Tenants', num(f.tenants)),
      item('Projects', num(f.projects)),
      item('Open critical', num(f.critical), f.critical ? 'is-bad' : ''),
      item('Open high', num(f.high), f.high ? 'is-warn' : ''),
      item('Overdue', num(f.overdue)),
      item('AI credits used', f.creditsUsed === null ? '—' : num(f.creditsUsed), '', f.creditsTotal ? `<span>of</span> <span translate="no">${esc(num(f.creditsTotal))}</span>` : ''),
    ].join('');
  }

  function render() {
    if (!data) return;
    $('cv-figs').innerHTML = figures();
    $('cv-n-projects').textContent = num(data.projects.length);
    const none = !tenants().some((t) => t.loaded);
    $('cv-empty').hidden = !none;
    renderOverview();
    renderProjects();
    renderFusion();
    renderCredits();
    renderStatus();
  }

  // ---- Overview: a card per tenant, then the tenants side by side ----
  function card(t) {
    const credits = t.credits
      ? `<b translate="no">${num(t.credits.used)}</b> <span>used</span> · <b translate="no">${num(t.credits.available)}</b> <span>available</span>`
      : '<span class="hint">Not read yet: open Credit Control in this tenant</span>';
    const total = t.credits ? (t.credits.total ?? (t.credits.used ?? 0) + (t.credits.available ?? 0)) : 0;
    const pct = total ? Math.min(100, ((t.credits.used ?? 0) / total) * 100) : 0;
    const govern = !t.govern ? '<span>Govern off</span>' : t.govern.on === null ? '<span class="hint">Govern not started since the server started</span>' : `<span>Govern on</span>${t.govern.budgeted !== null ? ` · <span translate="no">${num(t.govern.budgeted)}</span> <span>in budgets</span>` : ''}${t.govern.restricted ? ` · <span translate="no">${num(t.govern.restricted)}</span> <span>restricted</span>` : ''}`;
    const fetch = t.health === 'notLoaded' ? '<span class="hint">Never, since the server started</span>' : `<span translate="no">${esc(ago(t.fetchedAt) || '—')}</span>${t.error && t.health === 'failed' ? ` · <span class="bad-text"><span translate="no">${esc(fmtDateTime(t.error.at))}</span> <span>failed:</span> <span translate="no">${esc(t.error.message)}</span></span>` : ''}`;
    const figuresHtml = t.loaded
      ? `<div class="fusion-big"><div><b translate="no">${num(t.projects)}</b><span>projects</span></div><div><b translate="no">${num(t.overdue)}</b><span>overdue</span></div><div><b translate="no">${num(t.total)}</b><span>open results</span></div></div>${sevChips(t.sev)}`
      : `<p class="cv-not-loaded"><strong>Not loaded — open it once.</strong> <span>Load findings on its Workbench: its projects show here from then on.</span></p>`;
    return `<section class="cv-card tc-${t.colour}" aria-label="${esc(t.name)}">
      <div class="cv-card-head">${tenantChip(t.id, t.name, t.colour)}${healthBadge(t.health)}</div>
      ${figuresHtml}
      <div class="gv-tenantbar" role="img" aria-label="${esc(t.credits ? `${num(t.credits.used)} of ${num(total)} credits used` : 'Credits not read yet')}"><span class="t-pool" style="width:${pct.toFixed(1)}%"></span></div>
      <dl class="fusion-kv">
        <dt>AI credits</dt><dd>${credits}</dd>
        <dt>Fusion</dt><dd>${t.loaded ? `<span translate="no">${num(t.fusion)}</span> <span>Fusion</span> · <span translate="no">${num(t.last)}</span> <span>LAST</span>` : '—'}</dd>
        <dt>Budgets</dt><dd>${govern}</dd>
        <dt>Last fetch</dt><dd>${fetch}</dd>
      </dl>
      <div class="actions"><button type="button" class="sm" data-cv-open="${esc(t.id)}"><span>Go to</span> <span translate="no">${esc(t.name)}</span> ↗</button></div>
    </section>`;
  }

  const SIDE_COLUMNS = [
    { id: 'tenant', label: 'Tenant', fixed: true, sort: (t) => t.name, cell: (t) => `<td>${tenantChip(t.id, t.name, t.colour)}</td>`, csv: (t) => t.name, report: (t) => reportTenant(t.id, t.name, t.colour) },
    { id: 'projects', label: 'Projects', num: true, sort: (t) => t.projects, cell: (t) => `<td class="num">${num(t.projects)}</td>`, csv: (t) => t.projects ?? '', report: (t) => num(t.projects) },
    { id: 'results', label: 'Open results', sort: { value: (t) => t.total, text: (t) => String(t.total) }, cell: (t) => `<td>${t.loaded ? sevChips(t.sev) : '—'}</td>`, csv: (t) => (t.loaded ? t.total : ''), report: (t) => (t.loaded ? `${num(t.sev.critical)} C · ${num(t.sev.high)} H · ${num(t.sev.medium)} M · ${num(t.sev.low)} L` : '—') },
    { id: 'overdue', label: 'Overdue', num: true, sort: (t) => t.overdue, cell: (t) => `<td class="num">${num(t.overdue)}</td>`, csv: (t) => t.overdue, report: (t) => num(t.overdue) },
    { id: 'used', label: 'Credits used', num: true, sort: (t) => t.credits?.used ?? null, cell: (t) => `<td class="num">${num(t.credits?.used)}</td>`, csv: (t) => t.credits?.used ?? '', report: (t) => num(t.credits?.used) },
    { id: 'available', label: 'Available', num: true, sort: (t) => t.credits?.available ?? null, cell: (t) => `<td class="num">${num(t.credits?.available)}</td>`, csv: (t) => t.credits?.available ?? '', report: (t) => num(t.credits?.available) },
    { id: 'fetch', label: 'Last fetch', sort: { value: (t) => (t.fetchedAt ? Date.parse(t.fetchedAt) : null), text: (t) => ago(t.fetchedAt) }, cell: (t) => `<td translate="no">${esc(ago(t.fetchedAt) || '—')}</td>`, csv: (t) => t.fetchedAt ?? '', report: (t) => esc(t.fetchedAt ? fmtDateTime(t.fetchedAt) : '—') },
    { id: 'health', label: 'Health', sort: (t) => HEALTH[t.health]?.[0] ?? t.health, cell: (t) => `<td>${healthBadge(t.health)}</td>`, csv: (t) => HEALTH[t.health]?.[0] ?? t.health, report: (t) => esc(HEALTH[t.health]?.[0] ?? t.health) },
  ];

  /** Draw a table's headings from its columns (only when they change), its rows sorted and filtered. */
  function table(id, key, cols, rows, rowHtml, rerender) {
    const tableEl = $(id);
    const sign = cols.map((c) => c.id).join(',');
    const tr = tableEl.tHead.rows[0];
    const ttKey = `${key}:${sign}`;
    if (tr.dataset.cols !== sign) {
      tr.dataset.cols = sign;
      tableEl.dataset.tt = ttKey;
      tr.innerHTML = cols.map((c) => `<th${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('') + (cols.extra ?? '');
    }
    const sorted = sortAndFilter(ttKey, rows, [...cols.map((c) => c.sort ?? null), ...(cols.extra ? [null] : [])], rerender);
    tableEl.tBodies[0].innerHTML = sorted.map(rowHtml).join('') || `<tr class="empty"><td colspan="${cols.length + (cols.extra ? 1 : 0)}" class="hint">${esc('Nothing to show.')}</td></tr>`;
    return sorted;
  }

  function renderOverview() {
    $('cv-cards').innerHTML = tenants().map(card).join('');
    $('cv-side-chips').innerHTML = chips('side', () => 1);
    shown.side = table('cv-side', 'cv-side', SIDE_COLUMNS, byTenant('side', tenants()), (t) => `<tr>${SIDE_COLUMNS.map((c) => c.cell(t)).join('')}</tr>`, renderOverview);
  }

  // ---- Projects: every tenant's Workbench projects in one table ----
  const PROJECT_COLUMNS = [
    { id: 'tenant', label: 'Tenant', fixed: true, sort: (r) => r.tenantName, cell: (r) => `<td>${tenantChip(r.tenantId, r.tenantName, r.colour)}</td>`, csv: (r) => r.tenantName, report: (r) => reportTenant(r.tenantId, r.tenantName, r.colour) },
    { id: 'project', label: 'Project', fixed: true, sort: (r) => r.name, cell: (r) => `<td class="name"><span translate="no">${esc(r.name)}</span>${r.languages?.length ? `<span class="proj-langs sb-meta" translate="no">${esc(r.languages.join(' · '))}</span>` : ''}</td>`, csv: (r) => r.name, report: (r) => esc(r.name) },
    { id: 'application', label: 'Application', sort: (r) => (r.applications ?? []).join(', '), cell: (r) => `<td translate="no">${esc((r.applications ?? []).join(', '))}</td>`, csv: (r) => (r.applications ?? []).join('; '), report: (r) => esc((r.applications ?? []).join(', ')) },
    { id: 'results', label: 'Open results', sort: { value: (r) => r.total, text: (r) => String(r.total) }, cell: (r) => `<td>${sevChips(r.sev)}</td>`, csv: (r) => r.total, report: (r) => `${num(r.sev.critical)} C · ${num(r.sev.high)} H · ${num(r.sev.medium)} M · ${num(r.sev.low)} L` },
    { id: 'ch', label: 'Critical + high', num: true, sort: (r) => r.ch, cell: (r) => `<td class="num">${num(r.ch)}</td>`, csv: (r) => r.ch, report: (r) => num(r.ch) },
    { id: 'overdue', label: 'Overdue', num: true, sort: (r) => r.overdue, cell: (r) => `<td class="num${r.overdue > 9 ? ' bad-text' : ''}">${num(r.overdue)}</td>`, csv: (r) => r.overdue, report: (r) => num(r.overdue) },
    { id: 'scan', label: 'Scan', sort: (r) => SCAN_TYPE[r.scanType] ?? 'Standard', cell: (r) => `<td>${scanTag(r.scanType)}</td>`, csv: (r) => SCAN_TYPE[r.scanType] ?? 'Standard', report: (r) => reportScanTag(r.scanType) },
    { id: 'latest', label: 'Latest scan', sort: { value: (r) => (r.scanAt ? Date.parse(r.scanAt) : null), text: (r) => date(r.scanAt) }, cell: (r) => `<td translate="no">${esc(date(r.scanAt))}</td>`, csv: (r) => r.scanAt ?? '', report: (r) => esc(date(r.scanAt)) },
    { id: 'branch', label: 'Branch', off: true, sort: (r) => r.branch, cell: (r) => `<td><span class="gv-mono" translate="no">${esc(r.branch)}</span></td>`, csv: (r) => r.branch, report: (r) => esc(r.branch) },
  ];
  const projectCols = () => Object.assign(shownColumns('cv-projects', PROJECT_COLUMNS), { extra: '<th><span class="sr-only">Go to tenant</span></th>' });
  function renderProjects() {
    columnMenu($('cv-proj-cols'), 'cv-projects', PROJECT_COLUMNS, renderProjects);
    $('cv-proj-chips').innerHTML = chips('projects', (t) => t.projects ?? 0);
    const cols = projectCols();
    const rows = byTenant('projects', data.projects).filter((r) => matches('cv-proj-q', r.name, r.tenantName, ...(r.applications ?? []), ...(r.languages ?? [])))
      // Until a heading is chosen: the most open results first, whatever the tenant.
      .sort((a, b) => b.total - a.total || b.ch - a.ch);
    const sorted = table('cv-proj', 'cv-projects', cols, rows, () => '', renderProjects);
    shown.projects = sorted;
    $('cv-proj').tBodies[0].innerHTML = sorted.slice(0, limits.projects).map((r) => `<tr class="${rowScanClass(r.scanType)}">${cols.map((c) => c.cell(r)).join('')}<td><button type="button" class="link" data-cv-open="${esc(r.tenantId)}"><span>Go to tenant</span> ↗</button></td></tr>`).join('') || `<tr class="empty"><td colspan="${cols.length + 1}" class="hint">${esc(tenants().some((t) => t.loaded) ? 'No project matches.' : 'No tenant has loaded findings yet.')}</td></tr>`;
    const left = sorted.length - limits.projects;
    $('cv-proj-more').innerHTML = `<span>${esc(`${num(Math.min(sorted.length, limits.projects))} of ${num(data.projects.length)} shown. Go to tenant switches to the project's own tenant.`)}</span>${left > 0 ? ` <button type="button" class="link" data-cv-more="projects">${esc(`Show ${num(Math.min(PAGE_ROWS, left))} more`)}</button>` : ''}`;
  }

  // ---- Fusion: per tenant, the projects whose latest scan was a Fusion or a LAST scan ----
  const FUSION_COLUMNS = [PROJECT_COLUMNS[0], PROJECT_COLUMNS[1], PROJECT_COLUMNS[6], PROJECT_COLUMNS[3], PROJECT_COLUMNS[4], PROJECT_COLUMNS[7]];
  function renderFusion() {
    const ai = data.projects.filter((r) => r.scanType === 'fusion' || r.scanType === 'last');
    $('cv-fusion-chips').innerHTML = chips('fusion', (t) => (t.fusion ?? 0) + (t.last ?? 0));
    $('cv-fusion-sum').innerHTML = tenants().map((t) => `<span>${tenantChip(t.id, t.name, t.colour)} <b translate="no">${num(t.fusion)}</b> <span>Fusion</span> · <b translate="no">${num(t.last)}</b> <span>LAST</span></span>`).join('');
    const rows = byTenant('fusion', ai).filter((r) => matches('cv-fusion-q', r.name, r.tenantName));
    shown.fusion = table('cv-fusion', 'cv-fusion', FUSION_COLUMNS, rows, (r) => `<tr class="${rowScanClass(r.scanType)}">${FUSION_COLUMNS.map((c) => c.cell(r)).join('')}</tr>`, renderFusion);
  }

  // ---- Credits: each tenant's Checkmarx One credits, its credit pool, Govern's budgets ----
  const CREDIT_COLUMNS = [
    SIDE_COLUMNS[0],
    { id: 'used', label: 'AI credits used', num: true, sort: (t) => t.credits?.used ?? null, cell: (t) => `<td class="num">${num(t.credits?.used)}</td>`, csv: (t) => t.credits?.used ?? '', report: (t) => num(t.credits?.used) },
    { id: 'available', label: 'Available', num: true, sort: (t) => t.credits?.available ?? null, cell: (t) => `<td class="num">${num(t.credits?.available)}</td>`, csv: (t) => t.credits?.available ?? '', report: (t) => num(t.credits?.available) },
    { id: 'read', label: 'Read', sort: { value: (t) => (t.credits?.readAt ? Date.parse(t.credits.readAt) : null), text: (t) => ago(t.credits?.readAt) }, cell: (t) => `<td translate="no">${esc(t.credits?.readAt ? ago(t.credits.readAt) : '—')}</td>`, csv: (t) => t.credits?.readAt ?? '', report: (t) => esc(t.credits?.readAt ?? '—') },
    { id: 'pool', label: 'Credit pool', num: true, sort: (t) => t.pool?.size ?? null, cell: (t) => `<td class="num">${t.pool?.size ? num(t.pool.size) : '<span class="hint">No limit</span>'}</td>`, csv: (t) => t.pool?.size ?? '', report: (t) => (t.pool?.size ? num(t.pool.size) : 'No limit') },
    { id: 'poolUsed', label: 'Used from the pool', num: true, sort: (t) => t.pool?.used ?? null, cell: (t) => `<td class="num">${num(t.pool?.used)}</td>`, csv: (t) => t.pool?.used ?? '', report: (t) => num(t.pool?.used) },
    { id: 'govern', label: 'Govern', sort: (t) => (!t.govern ? 'Off' : t.govern.on === null ? 'Not started' : 'On'), cell: (t) => `<td>${!t.govern ? '<span class="badge gv-dashed">Off</span>' : t.govern.on === null ? '<span class="badge gv-dashed">Not started</span>' : '<span class="badge gv-info">On</span>'}</td>`, csv: (t) => (!t.govern ? 'Off' : t.govern.on === null ? 'Not started' : 'On'), report: (t) => (!t.govern ? 'Off' : t.govern.on === null ? 'Not started' : 'On') },
    { id: 'budgeted', label: 'In budgets', num: true, sort: (t) => t.govern?.budgeted ?? null, cell: (t) => `<td class="num">${num(t.govern?.budgeted)}</td>`, csv: (t) => t.govern?.budgeted ?? '', report: (t) => num(t.govern?.budgeted) },
    { id: 'restricted', label: 'Restricted budgets', num: true, sort: (t) => t.govern?.restricted ?? null, cell: (t) => `<td class="num">${t.govern?.restricted ? `<span class="badge gv-restricted" translate="no">${num(t.govern.restricted)}</span>` : num(t.govern?.restricted)}</td>`, csv: (t) => t.govern?.restricted ?? '', report: (t) => num(t.govern?.restricted) },
  ];
  function renderCredits() {
    $('cv-credit-chips').innerHTML = chips('credits', () => 1);
    shown.credits = table('cv-credits', 'cv-credits', CREDIT_COLUMNS, byTenant('credits', tenants()), (t) => `<tr>${CREDIT_COLUMNS.map((c) => c.cell(t)).join('')}</tr>`, renderCredits);
  }

  // ---- Status board, across tenants ----
  const statusMode = () => document.querySelector('input[name="cv-bar"]:checked')?.value ?? 'results';
  const statusAll = () => boardColumns(statusMode(), { tenant: true, fmtDateTime, ctx: boardCtx });
  const statusCols = () => shownColumns(`cv-status-${statusMode()}`, statusAll());
  function renderStatus() {
    columnMenu($('cv-status-cols'), `cv-status-${statusMode()}`, statusAll(), renderStatus);
    $('cv-status-legend').innerHTML = legendHtml(statusMode());
    $('cv-status-chips').innerHTML = chips('status', (t) => t.projects ?? 0);
    const rows = byTenant('status', data.projects).filter((r) => matches('cv-status-q', r.name, r.tenantName, r.branch, ...(r.applications ?? [])));
    const out = renderBoard($('cv-board'), rows, { key: 'cv-status', mode: statusMode(), groupBy: $('cv-status-group').value, cols: statusCols(), ctx: boardCtx, limit: limits.status, rerender: renderStatus, empty: tenants().some((t) => t.loaded) ? 'No project matches.' : 'No tenant has loaded findings yet.' });
    shown.status = out.shown;
    const left = out.total - out.drawn;
    $('cv-status-more').innerHTML = `<span>${esc(`${num(out.drawn)} of ${num(data.projects.length)} shown`)}</span>${left > 0 ? ` <button type="button" class="link" data-cv-more="status">${esc(`Show ${num(Math.min(PAGE_ROWS, left))} more`)}</button>` : ''}`;
  }

  // ---- Opening a tenant: the normal switch, then its Workbench ----
  async function openTenant(id) {
    try {
      if (data?.current !== id) await api('/api/me/tenant', { method: 'POST', body: JSON.stringify({ id }) });
      location.hash = '#/dashboard';
      location.reload();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  // ---- Exports: what each table shows ----
  const figuresList = () => {
    const f = data?.figures ?? {};
    return [['Tenants', num(f.tenants)], ['Projects', num(f.projects)], ['Open critical', num(f.critical)], ['Open high', num(f.high)], ['Overdue', num(f.overdue)], ['AI credits used', f.creditsUsed === null ? '—' : num(f.creditsUsed)]];
  };
  const exportsOf = {
    side: () => ({ name: 'tenants', cols: SIDE_COLUMNS, rows: shown.side, title: 'Consolidated view — tenants side by side' }),
    projects: () => ({ name: 'projects', cols: projectCols(), rows: shown.projects, title: 'Consolidated view — projects' }),
    fusion: () => ({ name: 'fusion', cols: FUSION_COLUMNS, rows: shown.fusion, title: 'Consolidated view — Fusion and LAST' }),
    credits: () => ({ name: 'credits', cols: CREDIT_COLUMNS, rows: shown.credits, title: 'Consolidated view — credits' }),
  };
  function exportCsv(which) {
    if (which === 'status') return save(`consolidated-status-board-${stamp()}.csv`, boardCsv(shown.status, statusCols()), 'text/csv');
    const { name, cols, rows } = exportsOf[which]();
    save(`consolidated-${name}-${stamp()}.csv`, csvText([cols.map((c) => c.label), ...rows.map((r) => cols.map((c) => c.csv?.(r) ?? ''))]), 'text/csv');
  }
  function exportHtml(which) {
    const sub = `Every connected tenant, read only · read ${data?.readAt ? new Date(data.readAt).toISOString().slice(0, 16).replace('T', ' ') : ''} UTC`;
    if (which === 'status') return save(`consolidated-status-board-${stamp()}.html`, boardReport({ title: 'Consolidated view — status board', sub, figures: figuresList(), rows: shown.status, cols: statusCols(), ctx: { max: 0 } }), 'text/html');
    const { name, cols, rows, title } = exportsOf[which]();
    save(`consolidated-${name}-${stamp()}.html`, reportHtml({ title, sub, figures: figuresList(), tables: [{ head: cols.map((c) => ({ label: c.label, num: c.num })), rows: rows.map((r) => ({ cls: r.scanType ?? '', cells: cols.map((c) => c.report?.(r) ?? '') })) }] }), 'text/html');
  }

  // ---- Events ----
  $('page-consolidated').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-cv-pick]');
    if (chip) {
      pick[chip.dataset.cvPick] = chip.dataset.tenant;
      if (chip.dataset.cvPick in limits) limits[chip.dataset.cvPick] = PAGE_ROWS;
      return render();
    }
    const open = event.target.closest('[data-cv-open]');
    if (open) return openTenant(open.dataset.cvOpen);
    const more = event.target.closest('[data-cv-more]');
    if (more) {
      limits[more.dataset.cvMore] += PAGE_ROWS;
      return render();
    }
    const csv = event.target.closest('[data-cv-csv]');
    if (csv && data) return exportCsv(csv.dataset.cvCsv);
    const html = event.target.closest('[data-cv-html]');
    if (html && data) return exportHtml(html.dataset.cvHtml);
  });
  for (const [id, key] of [['cv-proj-q', 'projects'], ['cv-fusion-q', 'fusion'], ['cv-status-q', 'status']]) $(id).addEventListener('input', () => {
    if (key in limits) limits[key] = PAGE_ROWS;
    render();
  });
  $('cv-status-group').addEventListener('change', () => ((limits.status = PAGE_ROWS), renderStatus()));
  for (const radio of document.querySelectorAll('input[name="cv-bar"]')) radio.addEventListener('change', () => data && renderStatus());

  return { load, render };
}
