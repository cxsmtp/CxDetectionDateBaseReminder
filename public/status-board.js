/**
 * Labs → Status board (Beta): every project's last scan and its results at a glance, from what the Workbench loaded
 * (GET /api/status-board reads the session's fetch: no Checkmarx One call). One row per project with a big bar from the
 * left — its open results by severity, or how long ago it was scanned — grouped, searched, sorted and filtered, with the
 * Columns menu, a side panel of its last five scans, and exports of what the table shows.
 *
 * `renderBoard` draws the table and is shared with Labs → Consolidated view's Status board tab (with a Tenant column).
 */
import { sortAndFilter } from './table-tools.js';
import { columnMenu, shownColumns } from './column-prefs.js';
import { SCAN_TYPE, ago, csvText, engineChips, engineLabel, esc, healthBar, num, reportBar, reportHtml, reportScanTag, reportTenant, resultsBar, rowScanClass, save, scanTag, sevChips, stamp, tenantChip } from './labs-common.js';

export const HEALTH_LABEL = { failed: 'Latest scan failed', stale: '30 days or more', aging: '7 to 30 days', fresh: 'Under 7 days', never: 'Never scanned' };
const HEALTH_ORDER = ['failed', 'stale', 'aging', 'fresh', 'never'];
export const PAGE_ROWS = 100;

/** The board's columns for a bar mode ('results' | 'health'); with `tenant`, a Tenant column first. */
export function boardColumns(mode, { tenant = false, fmtDateTime = (iso) => iso ?? '', ctx = { max: 0 } } = {}) {
  const when = (iso) => (iso ? fmtDateTime(iso) : '');
  const nameCell = (r) => {
    const apps = [r.applications?.join(', '), r.languages?.join(' · ')].filter(Boolean);
    const scanned = r.scanAt ? `<span class="sb-meta"><time translate="no">${esc(when(r.scanAt))}</time>${r.branch ? ` · <span class="gv-mono" translate="no">${esc(r.branch)}</span>` : ''}</span>` : '<span class="sb-meta">Never scanned</span>';
    const failed = r.failed
      ? `<span class="sb-fail"><span>Latest scan failed:</span> <time translate="no">${esc(when(r.failed.at))}</time>${r.failed.branch ? ` · <span class="gv-mono" translate="no">${esc(r.failed.branch)}</span>` : ''}${r.failed.reason ? ` · <span translate="no">${esc(r.failed.reason)}</span>` : ''}. <span>The results shown are from the scan before.</span></span>`
      : '';
    const error = r.error ? `<span class="sb-fail" translate="no">${esc(r.error)}</span>` : '';
    return `<td class="sb-name"><b translate="no">${esc(r.name)}</b>${apps.length ? `<span class="sb-meta" translate="no">${esc(apps.join(' · '))}</span>` : ''}${scanned}${failed}${error}</td>`;
  };
  const cols = [];
  if (tenant) cols.push({ id: 'tenant', label: 'Tenant', fixed: true, sort: (r) => r.tenantName, cell: (r) => `<td>${tenantChip(r.tenantId, r.tenantName, r.colour)}</td>`, csv: (r) => r.tenantName, report: (r) => reportTenant(r.tenantId, r.tenantName, r.colour) });
  cols.push({ id: 'project', label: 'Project', fixed: true, sort: (r) => r.name, cell: nameCell, csv: (r) => r.name, report: (r) => `${esc(r.name)}<small>${esc([r.applications?.join(', '), r.languages?.join(' · ')].filter(Boolean).join(' · '))}</small>` });
  if (mode === 'health') {
    cols.push({ id: 'age', label: 'Last scan', fixed: true, title: 'How long ago the latest scan ran (striped: a newer scan failed), up to 60 days', sort: { value: (r) => (r.failed ? -1 : r.ageDays ?? 1e9), text: (r) => HEALTH_LABEL[r.health] }, cell: (r) => `<td class="sb-barcell">${healthBar(r)}</td>`, csv: (r) => (r.ageDays === null ? '' : r.ageDays.toFixed(1)), csvLabel: 'Days since the last scan', report: (r) => esc(r.failed ? `Failed · ${r.failed.reason || ''}` : r.ageDays === null ? 'Never' : `${r.ageDays.toFixed(1)} d`) });
    cols.push({ id: 'engines', label: 'Engines', sort: (r) => (r.engines ?? []).map(engineLabel).join(' '), cell: (r) => `<td>${engineChips(r)}</td>`, csv: (r) => (r.engines ?? []).map(engineLabel).join(' '), report: (r) => esc((r.engines ?? []).map(engineLabel).join(' · ')) });
    cols.push({ id: 'ch', label: 'Critical + high', num: true, off: true, sort: (r) => r.ch, cell: (r) => `<td class="num">${num(r.ch)}</td>`, csv: (r) => r.ch, report: (r) => num(r.ch) });
    cols.push({ id: 'failed7', label: 'Failed scans, 7 days', num: true, off: true, sort: (r) => r.failedScans ?? null, cell: (r) => `<td class="num">${num(r.failedScans)}</td>`, csv: (r) => r.failedScans ?? '', report: (r) => num(r.failedScans) });
  } else {
    cols.push({ id: 'results', label: 'Open results', fixed: true, title: 'Open results of the latest scan, by severity; the total at the end', sort: { value: (r) => r.total, text: (r) => String(r.total) }, cell: (r) => `<td class="sb-barcell">${resultsBar(r, ctx.max)}</td>`, csv: (r) => r.total, csvLabel: 'Open results', report: (r) => `${reportBar(r, ctx.max)}<small>${num(r.total)}</small>` });
    cols.push({ id: 'ch', label: 'Critical + high', num: true, sort: (r) => r.ch, cell: (r) => `<td class="num sb-ch">${num(r.ch)}</td>`, csv: (r) => r.ch, report: (r) => num(r.ch) });
    for (const [k, label] of [['critical', 'Critical'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]) cols.push({ id: k, label, num: true, off: true, sort: (r) => r.sev[k], cell: (r) => `<td class="num">${num(r.sev[k])}</td>`, csv: (r) => r.sev[k], report: (r) => num(r.sev[k]) });
    cols.push({ id: 'overdue', label: 'Past SLA', num: true, off: true, title: 'Open findings past the days their severity has to be fixed', sort: (r) => r.overdue, cell: (r) => `<td class="num">${num(r.overdue)}</td>`, csv: (r) => r.overdue, report: (r) => num(r.overdue) });
    cols.push({ id: 'engines', label: 'Engines', off: true, sort: (r) => (r.engines ?? []).map(engineLabel).join(' '), cell: (r) => `<td>${engineChips(r)}</td>`, csv: (r) => (r.engines ?? []).map(engineLabel).join(' '), report: (r) => esc((r.engines ?? []).map(engineLabel).join(' · ')) });
  }
  cols.push({ id: 'lastScan', label: 'Latest scan', off: true, sort: { value: (r) => (r.scanAt ? Date.parse(r.scanAt) : null), text: (r) => when(r.scanAt) }, cell: (r) => `<td><time translate="no">${esc(when(r.scanAt))}</time></td>`, csv: (r) => r.scanAt ?? '', report: (r) => esc(when(r.scanAt)) });
  cols.push({ id: 'application', label: 'Application', off: true, sort: (r) => (r.applications ?? []).join(', '), cell: (r) => `<td translate="no">${esc((r.applications ?? []).join(', '))}</td>`, csv: (r) => (r.applications ?? []).join('; '), report: (r) => esc((r.applications ?? []).join(', ')) });
  cols.push({ id: 'branch', label: 'Branch', off: true, sort: (r) => r.branch, cell: (r) => `<td><span class="gv-mono" translate="no">${esc(r.branch)}</span></td>`, csv: (r) => r.branch, report: (r) => esc(r.branch) });
  cols.push({ id: 'scan', label: 'Scan', sort: (r) => SCAN_TYPE[r.scanType] ?? 'Standard', cell: (r) => `<td>${scanTag(r.scanType)}</td>`, csv: (r) => SCAN_TYPE[r.scanType] ?? 'Standard', report: (r) => reportScanTag(r.scanType) });
  return cols;
}

/** The groups a row is in, for Group by: its applications or groups (each one), or its scan health. */
function groupsOf(row, by) {
  if (by === 'application') return row.applications?.length ? row.applications : ['No application'];
  if (by === 'group') return row.groups?.length ? row.groups : ['No group'];
  if (by === 'health') return [row.health];
  return [''];
}

/** Draw the headings when the columns change (the heading sort and filters keep their place). */
function drawHead(table, key, cols) {
  const sign = cols.map((c) => `${c.id}:${c.label}`).join('|');
  const tr = table.tHead.rows[0];
  if (tr.dataset.cols === sign) return;
  tr.dataset.cols = sign;
  table.dataset.tt = key;
  tr.innerHTML = cols.map((c) => `<th${c.num ? ' class="num"' : ''}${c.title ? ` title="${esc(c.title)}"` : ''}>${esc(c.label)}</th>`).join('');
}

/**
 * Draw a board table: `rows` (already searched), sorted and filtered from the headings, grouped, a page at a time.
 * Returns { shown (rows after filters, in order), drawn (count), cols }.
 */
export function renderBoard(table, rows, { key, mode, groupBy = '', cols, ctx, limit = PAGE_ROWS, rerender, empty = 'No project matches.' }) {
  drawHead(table, `${key}:${cols.map((c) => c.id).join(',')}`, cols);
  // Until a heading is chosen: the most open results first; for scan health, the latest scanned first (as the mockups).
  rows = [...rows].sort(mode === 'health' ? (a, b) => (a.ageDays ?? 1e9) - (b.ageDays ?? 1e9) : (a, b) => b.total - a.total || b.ch - a.ch);
  const sorted = sortAndFilter(`${key}:${cols.map((c) => c.id).join(',')}`, rows, cols.map((c) => c.sort ?? null), rerender);
  ctx.max = Math.max(0, ...sorted.map((r) => r.total));
  const rowHtml = (r) => {
    const cls = [mode === 'health' && r.failed ? 'sb-failed' : rowScanClass(r.scanType)].filter(Boolean).join(' ');
    return `<tr data-sb-row="${esc(r.tenantId ? `${r.tenantId}|${r.projectId}` : r.projectId)}" tabindex="0"${cls ? ` class="${cls}"` : ''}>${cols.map((c) => c.cell(r)).join('')}</tr>`;
  };
  let html = '';
  let drawn = 0;
  if (!groupBy) {
    html = sorted.slice(0, limit).map(rowHtml).join('');
    drawn = Math.min(limit, sorted.length);
  } else {
    const groups = new Map();
    for (const r of sorted) for (const g of groupsOf(r, groupBy)) (groups.get(g) ?? groups.set(g, []).get(g)).push(r);
    const names = [...groups.keys()].sort((a, b) => (groupBy === 'health' ? HEALTH_ORDER.indexOf(a) - HEALTH_ORDER.indexOf(b) : a.localeCompare(b)));
    for (const g of names) {
      if (drawn >= limit) break;
      const list = groups.get(g);
      const failed = list.filter((r) => r.failed).length;
      const stale = list.filter((r) => r.health === 'stale' || r.health === 'never').length;
      const label = groupBy === 'health' ? `<span>${esc(HEALTH_LABEL[g])}</span>` : `<span translate="no">${esc(g)}</span>`;
      const notes = [`<span>${esc(list.length === 1 ? '1 project' : `${list.length} projects`)}</span>`, groupBy !== 'health' && failed ? `<span class="bad-text">${esc(`${failed} failed`)}</span>` : '', groupBy !== 'health' && stale ? `<span class="bad-text">${esc(`${stale} not scanned for 30+ days`)}</span>` : ''].filter(Boolean).join(' · ');
      html += `<tr class="sb-group"><td colspan="${cols.length}">${label}<small>${notes}</small></td></tr>`;
      const take = list.slice(0, limit - drawn);
      html += take.map(rowHtml).join('');
      drawn += take.length;
    }
  }
  table.tBodies[0].innerHTML = html || `<tr class="empty"><td colspan="${cols.length}" class="hint">${esc(empty)}</td></tr>`;
  return { shown: sorted, drawn, total: groupBy ? sorted.reduce((n, r) => n + groupsOf(r, groupBy).length, 0) : sorted.length };
}

/** The legend under the tools, for the bar mode. */
export function legendHtml(mode) {
  if (mode === 'health') {
    return '<span><i class="sb-key fresh"></i>Scanned under 7 days ago</span><span><i class="sb-key aging"></i>7 to 30 days</span><span><i class="sb-key stale"></i>30 days or more</span><span><i class="sb-key failed"></i>Latest scan failed</span><span class="sb-legend-note">Bar: days since the last scan, up to 60</span>';
  }
  return '<span><i class="sb-key c"></i>Critical</span><span><i class="sb-key h"></i>High</span><span><i class="sb-key m"></i>Medium</span><span><i class="sb-key l"></i>Low</span><span class="scan-legend"><span><span class="scan-swatch scan-swatch-fusion"></span>Latest scan Fusion</span><span><span class="scan-swatch scan-swatch-last"></span>Latest scan LAST</span></span>';
}

/** CSV of what the table shows: its columns in their order, every row the filters leave (not only the page drawn). */
export function boardCsv(rows, cols) {
  const head = cols.map((c) => c.csvLabel ?? c.label);
  return csvText([head, ...rows.map((r) => cols.map((c) => c.csv?.(r) ?? ''))]);
}

/** The table as a standalone HTML report. */
export function boardReport({ title, sub, figures, rows, cols, ctx }) {
  ctx.max = Math.max(0, ...rows.map((r) => r.total));
  return reportHtml({
    title,
    sub,
    figures,
    tables: [{ head: cols.map((c) => ({ label: c.csvLabel ?? c.label, num: c.num })), rows: rows.map((r) => ({ cls: r.failed ? 'failed' : r.scanType, cells: cols.map((c) => c.report?.(r) ?? '') })) }],
  });
}

export function initStatusBoard({ api, $, toast, showError, setStatus, fmtDateTime }) {
  let data = null;
  let loading = false;
  let limit = PAGE_ROWS;
  const ctx = { max: 0 };
  let shownRows = [];
  const mode = () => document.querySelector('input[name="sb-bar"]:checked')?.value ?? 'results';
  const all = () => boardColumns(mode(), { fmtDateTime, ctx });
  const colKey = () => `sb-${mode()}`;
  const cols = () => shownColumns(colKey(), all());
  const words = () => $('sb-q').value.toLowerCase().split(',').map((w) => w.trim()).filter(Boolean);
  const matches = (r) => {
    const w = words();
    if (!w.length) return true;
    const hay = [r.name, r.branch, ...(r.applications ?? []), ...(r.groups ?? []), ...(r.languages ?? [])].join(' ').toLowerCase();
    return w.some((x) => hay.includes(x));
  };

  async function load({ quiet = false } = {}) {
    if (loading) return;
    loading = true;
    if (!data) setStatus('sb-status', 'Reading what the Workbench loaded…');
    try {
      data = await api('/api/status-board', { quiet: true });
      setStatus('sb-status', '');
      render();
    } catch (error) {
      if (!quiet) showError('sb-status', error);
    } finally {
      loading = false;
    }
  }

  function figures(f) {
    if (!f) return '';
    const item = (label, value, cls = '', small = '') => `<span class="${cls}"><span>${esc(label)}</span> <b translate="no">${esc(value)}</b>${small ? ` <small>${small}</small>` : ''}</span>`;
    return [
      item('Projects', num(f.projects)),
      item('Scanned in the last 30 days', num(f.scanned30), 'is-ok'),
      item('Failed scans, 7 days', f.failed7 === null ? '—' : num(f.failed7), f.failed7 ? 'is-bad' : ''),
      item('Not scanned for 30+ days', num(f.stale30), f.stale30 ? 'is-warn' : ''),
      item('Open critical + high', num(f.ch), '', `<span translate="no">${esc(num(f.critical))}</span> <span>critical</span>`),
    ].join('');
  }

  function render() {
    const board = data?.board;
    const m = mode();
    $('sb-legend').innerHTML = legendHtml(m);
    $('sb-figs').innerHTML = figures(board?.figures);
    $('sb-figs').hidden = !board;
    $('sb-read').innerHTML = board?.fetchedAt ? `<span>Read</span> <b translate="no">${esc(ago(board.fetchedAt))}</b>` : '';
    // Nothing loaded yet; or loaded before the board could add its facts.
    const note = $('sb-note');
    if (!board) {
      note.hidden = false;
      note.className = 'gv-note info';
      note.innerHTML = data?.fetching
        ? '<strong>Loading on the Workbench…</strong> <span>Every project it reads shows here once it has finished.</span>'
        : '<strong>Nothing loaded yet.</strong> <span>Load findings on the Workbench: every project it reads shows here, with its last scan and results.</span> <a class="button-like sm gv-note-act" href="#/dashboard">Go to the Workbench</a>';
    } else if (!board.failedKnown) {
      note.hidden = false;
      note.className = 'gv-note';
      note.innerHTML = '<strong>Failed scans are not known for this data.</strong> <span>Load findings again on the Workbench to see them (and each project\'s application).</span>';
    } else note.hidden = true;
    $('sb-panel').hidden = !board;
    columnMenu($('sb-cols'), colKey(), all(), () => render());
    if (!board) return;
    const rows = board.rows.filter(matches);
    const out = renderBoard($('sb-table'), rows, { key: 'status-board', mode: m, groupBy: $('sb-group').value, cols: cols(), ctx, limit, rerender: render });
    shownRows = out.shown;
    const left = out.total - out.drawn;
    $('sb-more').innerHTML = `<span>${esc(`${num(out.drawn)} of ${num(board.rows.length)} shown`)}</span>${left > 0 ? ` <button type="button" class="link" id="sb-more-btn">${esc(`Show ${num(Math.min(PAGE_ROWS, left))} more`)}</button>` : ''}`;
    $('sb-csv').disabled = !shownRows.length;
    $('sb-report').disabled = !shownRows.length;
  }

  // ---- The side panel: the project's facts and its last five scans ----
  let opened = null;
  let lastFocus = null;
  async function openSide(row) {
    opened = row;
    lastFocus = document.activeElement;
    $('sb-side-title').textContent = row.name;
    $('sb-side-meta').innerHTML = [row.applications?.length ? `<span translate="no">${esc(row.applications.join(', '))}</span>` : '', row.groups?.length ? `<span translate="no">${esc(row.groups.join(', '))}</span>` : '', row.languages?.length ? `<span translate="no">${esc(row.languages.join(' · '))}</span>` : ''].filter(Boolean).join(' · ');
    // A value in its own words (a scan tag, engine chips) is translated; names, dates and numbers are not.
    const fact = (label, value, keep = true) => `<div class="fusion-fact"><span>${esc(label)}</span><b${keep ? ' translate="no"' : ''}>${value}</b></div>`;
    $('sb-side-facts').innerHTML = [
      fact('Latest scan', row.scanAt ? esc(fmtDateTime(row.scanAt)) : '—'),
      fact('Branch', esc(row.branch || '—')),
      fact('Scan', scanTag(row.scanType), false),
      fact('Open results', num(row.total)),
      fact('Critical + high', num(row.ch)),
      fact('Engines', engineChips(row), false),
    ].join('');
    $('sb-side-open').hidden = !row.url;
    if (row.url) $('sb-side-open').href = row.url;
    $('sb-drawer').dataset.scanType = row.scanType || 'none';
    $('sb-drawer').hidden = false;
    document.body.classList.add('sheet-open');
    $('sb-drawer').querySelector('.icon-btn[data-sb-close]').focus();
    $('sb-side-list').innerHTML = `<p class="hint sb-side-pad">${esc('Reading its last scans from Checkmarx One…')}</p>`;
    try {
      const r = await api(`/api/status-board/projects/${encodeURIComponent(row.projectId)}/scans`, { quiet: true });
      if (opened !== row) return;
      $('sb-side-list').innerHTML = scansTable(r.scans);
    } catch (error) {
      if (opened === row) $('sb-side-list').innerHTML = `<p class="status error sb-side-pad">${esc(error.message)}</p>`;
    }
  }
  function scansTable(list) {
    if (!list?.length) return `<p class="hint sb-side-pad">${esc('No scans listed for this project.')}</p>`;
    const dur = (s) => (s === null || s === undefined ? '—' : s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
    const delta = (d) => (d === null || d === undefined ? '' : d === 0 ? ' <small class="hint">±0</small>' : ` <small class="${d > 0 ? 'bad-text' : 'ok-text'}">${d > 0 ? '+' : '−'}${num(Math.abs(d))}</small>`);
    const status = (s) => `<span class="badge ${/fail/i.test(s.status) ? 'bad' : /complet/i.test(s.status) ? 'ok' : 'muted'}">${esc(s.status)}</span>`;
    return `<h3 class="sb-side-h">${esc('Last scans')}</h3><div class="table-wrap" data-tt-off><table class="data-table sb-scans"><thead><tr><th>${esc('When')}</th><th>${esc('Status')}</th><th>${esc('Engines')}</th><th class="num">${esc('Duration')}</th><th class="num">${esc('Lines of code')}</th><th class="num">${esc('Results')}</th><th></th></tr></thead><tbody>${list
      .map((s) => `<tr><td><time translate="no">${esc(fmtDateTime(s.at))}</time>${s.branch ? `<span class="sb-meta gv-mono" translate="no">${esc(s.branch)}</span>` : ''}${s.reason ? `<span class="sb-fail" translate="no">${esc(s.reason)}</span>` : ''}</td><td>${status(s)}</td><td translate="no">${esc((s.engines ?? []).map(engineLabel).join(' · ') || '—')}</td><td class="num" translate="no">${esc(dur(s.seconds))}</td><td class="num" translate="no">${num(s.loc)}</td><td class="num" translate="no">${num(s.results)}${delta(s.delta)}</td><td>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener" aria-label="${esc('Open in Checkmarx One')}">↗</a>` : ''}</td></tr>`)
      .join('')}</tbody></table></div>`;
  }
  function closeSide() {
    if ($('sb-drawer').hidden) return;
    $('sb-drawer').hidden = true;
    opened = null;
    document.body.classList.remove('sheet-open');
    lastFocus?.focus?.();
  }

  // ---- Events ----
  for (const radio of document.querySelectorAll('input[name="sb-bar"]')) radio.addEventListener('change', () => {
    // Scan health reads best grouped by health, unless a grouping was chosen.
    limit = PAGE_ROWS;
    render();
  });
  $('sb-group').addEventListener('change', () => ((limit = PAGE_ROWS), render()));
  $('sb-q').addEventListener('input', () => ((limit = PAGE_ROWS), render()));
  $('sb-more').addEventListener('click', (event) => {
    if (!event.target.closest('#sb-more-btn')) return;
    limit += PAGE_ROWS;
    render();
  });
  const rowOf = (el) => {
    const id = el?.closest('tr[data-sb-row]')?.dataset.sbRow;
    return id ? data?.board?.rows.find((r) => r.projectId === id) : null;
  };
  $('sb-table').addEventListener('click', (event) => {
    if (event.target.closest('a, button, input, .tt-tools')) return;
    const row = rowOf(event.target);
    if (row) openSide(row);
  });
  $('sb-table').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.matches?.('tr[data-sb-row]') ? rowOf(event.target) : null;
    if (!row) return;
    event.preventDefault();
    openSide(row);
  });
  for (const el of document.querySelectorAll('[data-sb-close]')) el.addEventListener('click', closeSide);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('sb-drawer').hidden) closeSide();
  });
  const figuresList = () => {
    const f = data?.board?.figures ?? {};
    return [['Projects', num(f.projects)], ['Scanned in the last 30 days', num(f.scanned30)], ['Failed scans, 7 days', f.failed7 === null ? '—' : num(f.failed7)], ['Not scanned for 30+ days', num(f.stale30)], ['Open critical + high', num(f.ch)]];
  };
  $('sb-csv').addEventListener('click', () => {
    save(`status-board-${stamp()}.csv`, boardCsv(shownRows, cols()), 'text/csv');
    toast('CSV saved: the rows and columns the table shows.', 'ok', 2500);
  });
  $('sb-report').addEventListener('click', () => {
    const html = boardReport({ title: 'Status board', sub: `Every project's last scan and its results · ${shownRows.length} projects · read ${data?.board?.fetchedAt ? new Date(data.board.fetchedAt).toISOString().slice(0, 16).replace('T', ' ') : ''} UTC`, figures: figuresList(), rows: shownRows, cols: cols(), ctx: { max: 0 } });
    save(`status-board-${stamp()}.html`, html, 'text/html');
  });

  return { load, render, close: closeSide };
}
