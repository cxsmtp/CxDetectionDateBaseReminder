// Cx Credits Calculator (#/calculator): customers, each with a triage & remediation projection
// (two Checkmarx One exports and a plan per severity) and a Fusion projection (how many Fusion
// scans each project needs, and what they cost), and the projection reports made from them.
// Saved on the server as you go (src/projections.js). The arithmetic is model.js; the charts
// charts.js; the downloaded report report.js.

import {
  CRITICALITIES,
  DEFAULT_TR,
  FREQUENCIES,
  LOOKBACKS,
  MAX_PROJECTS,
  SEVERITIES,
  aheadSettings,
  amount,
  analyse,
  byOrigins,
  cleanScope,
  creditSummary,
  fusionEstimate,
  fusionImpact,
  fusionSettings,
  fusionTotal,
  impactSettings,
  inScope,
  newCustomerEstimate,
  originCounts,
  overallImpact,
  parseCloc,
  sortProjects,
  planForecast,
  readLimit,
  scopeActive,
  seriesRows,
  settingChanges,
  severityPlan,
  suggestedScans,
  topSettings,
  totalsSettings,
  trImpact,
  trProjection,
  weeklyTrend,
  wholeNumber,
} from './model.js';
import { SEVERITY_COLOURS, debtFixChart, forecastChart, severityCharts } from './charts.js';
import { buildReport, reportFileName, wording } from './report.js';
import { slidesFileName, slidesPdf } from './slides.js';
import { allSections, fusionImpactSections, impactSections, sectionHtml } from './explain.js';
import { cleanFusionNew } from './profiles.js';
import { RTL, currentLanguage, t } from '../i18n.js';
import { DEFAULT_ENGINES, ENGINES, cleanEngines } from '../engines.js';

const OPEN_KEY = 'mz-calc-customer';
const FREQ_LABEL = Object.fromEntries(FREQUENCIES.map((f) => [f.id, f.label]));
const FROM_LABEL = { default: 'Default', frequency: 'Scan frequency', criticality: 'Criticality', project: 'Set here' };
const SOURCE_LABEL = {
  'sast-metadata': 'Counted by the last scan (SAST scan metadata)',
  scan: 'Counted by the last scan (the scan’s SAST details)',
  none: 'Its last scan did not count lines of code: type them in',
  manual: 'Added by hand',
};

/** The look the app is in, for the report: next-gen or classic, the theme chosen and the accent. */
function appLook() {
  const { ui, look, theme, accent } = document.documentElement.dataset;
  // html[data-look] is "studio", or "signal cabin" for the looks drawn on Signal's pages: the look is its last word.
  return { look: ui === 'nextgen' ? String(look ?? '').split(' ').pop() || 'nextgen' : 'classic', ui: ui === 'nextgen' ? 'nextgen' : 'classic', theme: theme ?? 'auto', accent: accent ?? 'indigo' };
}

/**
 * `standalone`: the calculator on its own, as one HTML file (src/standalone-calculator.js): it never reads
 * Checkmarx One (the two exports stand in), keeps everything in the browser, and asks for the names on the
 * reports itself. `sampleFile(name)` gives the sample exports there, as a Response. `canGit()`: the new
 * customer tab may count code from git (on the server, or in the launcher on its computer; never in the
 * HTML file on its own, which can reach nothing).
 */
export function initCalculator({ api, $, esc, toast, setStatus, showError, handleAuthLoss, fmtDateTime, me, can, standalone = false, sampleFile = null, canRead = () => !standalone, canGit = () => !standalone, impactOn = () => false }) {
  // On its own with no way to Checkmarx One (the HTML file opened from disk): the two exports are the way in.
  const offline = () => standalone && !canRead();
  const c = { customers: [], open: null, pending: null, timer: null, saving: null, draft: {}, dirty: {}, present: false, remainingCredits: null, reports: [] };
  const num = (n, digits = 0) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: digits }));
  const pct = (n) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`);
  // The report is written in the language the page is in.
  // The report generated last, for its PDF summary (only while its customer is open).
  let lastMade = null;
  const reportHtml = (data, generatedAt) => buildReport({ ...data, generatedAt }, { t, lang: currentLanguage(), dir: RTL.has(currentLanguage()) ? 'rtl' : 'ltr', look: appLook() });
  const savedAt = (iso) => `<time datetime="${esc(iso)}" translate="no">${esc(new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</time>`;

  // ---- Customers ----------------------------------------------------------------------------

  async function load({ reopen = true } = {}) {
    gateImpact();
    let body;
    try {
      body = await api('/api/projections');
    } catch (error) {
      if (handleAuthLoss(error)) return;
      setStatus('calc-saved', error.message, 'error');
      return;
    }
    c.customers = body.customers ?? [];
    c.impactDefaults = body.impactDefaults ?? {};
    renderCustomers();
    renderOrg();
    if (!reopen && c.open && c.customers.some((x) => x.id === c.open.id)) return loadReports();
    let last = '';
    try {
      last = localStorage.getItem(OPEN_KEY) || '';
    } catch {}
    const first = c.customers.find((x) => x.id === last) ?? c.customers[0];
    if (first) return open(first.id);
    show(null);
    // The first visit: a customer in the organisation's name, read from Checkmarx One straight away.
    if (me()?.organisationName) await create().catch((error) => handleAuthLoss(error));
  }

  function renderCustomers() {
    $('calc-empty').hidden = c.customers.length > 0;
    $('calc-customer').innerHTML = c.customers.map((x) => `<option value="${esc(x.id)}"${x.id === c.open?.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
    for (const id of ['calc-customer', 'calc-name', 'calc-delete', 'calc-generate', 'calc-extra', 'calc-bundle', 'calc-horizon', 'calc-email-open', 'calc-restart', 'calc-scope-toggle', 'calc-scope-clear', 'calc-app-input', 'calc-project-input', 'calc-leave-no-code', 'calc-leave-no-findings', 'calc-all-branches', 'calc-max-projects', 'calc-apply', 'calc-undo']) $(id).disabled = !c.open;
  }

  function renderOrg() {
    const org = me()?.organisationName;
    if (standalone) {
      $('calc-org-line').innerHTML = org ? `<span>Name on the reports:</span> <b translate="no">${esc(org)}</b>` : 'Give your organisation’s name at the top, for the reports.';
      return;
    }
    $('calc-org-line').innerHTML = org
      ? `<span>Name on the reports:</span> <b translate="no">${esc(org)}</b>`
      : can('settings.branding')
        ? 'Give your organisation’s name for the reports in <a href="#/settings/about">Settings → About &amp; terms</a>.'
        : 'Reports carry your organisation’s name once an Admin gives it (Settings → About &amp; terms).';
  }

  function show(customer) {
    c.open = customer;
    c.remainingCredits = null;
    renderCustomers();
    for (const panel of document.querySelectorAll('#page-calculator .calc-panel')) panel.classList.toggle('calc-none', !customer);
    if (!customer) {
      $('calc-tr').innerHTML = '';
      $('calc-read').disabled = true;
      c.next = null;
      renderPending();
      return;
    }
    try {
      localStorage.setItem(OPEN_KEY, customer.id);
    } catch {}
    $('calc-name').value = customer.name;
    c.trCredits = null;
    c.fusionCredits = null;
    // Nothing waits for Apply in a customer just opened: the settings at the top are its own.
    c.next = null;
    renderTop();
    $('calc-email-form').hidden = true;
    $('calc-email-open').setAttribute('aria-expanded', 'false');
    rowsShown = ROWS_PAGE;
    saved('Saved', customer.updatedAt, 'muted');
    syncDraft();
    setStatus('calc-upload-status', '');
    // On its own, the calculator works from the two exports: they are always in view.
    $('calc-alt').open = offline() || customer.tr?.totals?.meta?.source === 'upload';
    if (!reading.timer) setStatus('calc-read-note', '');
    $('calc-read').disabled = Boolean(reading.timer);
    fillImpact();
    renderTr();
    renderFusion();
    loadReports();
    autoRead();
    // Saved before engines were counted apart, with other engines, before SAST was kept apart (for Fusion's
    // extra findings), or with other scan origins: add them up again from the last read.
    const meta = customer.tr?.totals?.meta;
    const origins = (list) => [...(list ?? [])].sort().join('\n');
    if (meta?.source === 'cxone' && (cleanEngines(meta.engines).join() !== trEngines().join() || !customer.tr.totals.sast || origins(meta.origins) !== origins(scope().origins))) applyScope({ quiet: true });
  }

  async function open(id) {
    await flush();
    try {
      show((await api(`/api/projections/${encodeURIComponent(id)}`)).customer);
    } catch (error) {
      if (handleAuthLoss(error)) return;
      toast(error.message, 'bad');
      if (error.status === 404) load();
    }
  }

  function saved(label, at, kind = 'muted') {
    const el = $('calc-saved');
    el.className = `status ${kind}`;
    el.innerHTML = at ? `${esc(label)} ${savedAt(at)}` : esc(label);
  }

  /** What changed is saved a moment after the last change, quietly. */
  function save(patch) {
    if (!c.open) return;
    c.pending = { id: c.open.id, patch: { ...(c.pending?.id === c.open.id ? c.pending.patch : {}), ...patch } };
    saved('Saving…');
    clearTimeout(c.timer);
    c.timer = setTimeout(flush, 800);
  }

  async function flush() {
    clearTimeout(c.timer);
    while (c.saving) await c.saving;
    const job = c.pending;
    if (!job) return;
    c.pending = null;
    const run = (async () => {
      try {
        const { customer } = await api(`/api/projections/${encodeURIComponent(job.id)}`, { method: 'PUT', body: JSON.stringify(job.patch), quiet: true });
        c.customers = c.customers.map((x) => (x.id === customer.id ? customer : x));
        if (job.patch.name) renderCustomers();
        if (c.open?.id === job.id && !c.pending) saved('Saved', customer.updatedAt, 'ok');
      } catch (error) {
        if (handleAuthLoss(error)) return;
        if (c.open?.id === job.id) {
          saved('Not saved:', null, 'error');
          $('calc-saved').append(` ${error.message}`);
        }
        if (![404, 413].includes(error.status) && !c.pending) c.pending = job;
      }
    })();
    c.saving = run;
    try {
      await run;
    } finally {
      if (c.saving === run) c.saving = null;
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });

  $('calc-customer').addEventListener('change', () => open($('calc-customer').value));
  $('calc-name').addEventListener('input', () => {
    const name = $('calc-name').value.trim();
    if (!c.open || !name) return;
    c.open.name = name;
    c.customers = c.customers.map((x) => (x.id === c.open.id ? { ...x, name } : x));
    save({ name });
  });
  $('calc-name').addEventListener('change', renderCustomers);
  /** A new customer: named after the organisation given when the terms were first accepted, while no customer has that name. */
  async function create() {
    await flush();
    const org = String(me()?.organisationName ?? '').trim();
    const name = org && !c.customers.some((x) => x.name.trim().toLowerCase() === org.toLowerCase()) ? org : `Customer ${c.customers.length + 1}`;
    const { customer } = await api('/api/projections', { method: 'POST', body: JSON.stringify({ name }) });
    c.customers = [...c.customers, { id: customer.id, name: customer.name, updatedAt: customer.updatedAt }];
    show(customer);
    return customer;
  }
  $('calc-new').addEventListener('click', async () => {
    try {
      await create();
      $('calc-name').focus();
      $('calc-name').select();
    } catch (error) {
      if (!handleAuthLoss(error)) toast(error.message, 'bad');
    }
  });
  $('calc-delete').addEventListener('click', async () => {
    if (!c.open || !confirm(`Delete this customer?\n\n${c.open.name}\n\nTheir uploads, plan and Fusion projects go with them. Reports already made are kept.`)) return;
    const { id } = c.open;
    if (c.pending?.id === id) c.pending = null;
    try {
      await api(`/api/projections/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (error) {
      if (handleAuthLoss(error)) return;
      if (error.status !== 404) return toast(error.message, 'bad');
    }
    c.customers = c.customers.filter((x) => x.id !== id);
    c.open = null;
    if (c.customers[0]) open(c.customers[0].id);
    else show(null);
  });

  // ---- Triage & remediation -----------------------------------------------------------------

  const tr = () => c.open.tr;

  function syncDraft() {
    for (const s of SEVERITIES) {
      c.draft[s] = { selected: tr().selected[s] ?? null, triageCost: tr().triageCost[s], fpPercent: tr().fpPercent[s], remediationCost: tr().remediationCost[s] };
      c.dirty[s] = false;
    }
  }

  /** The projection period (months), shared by both parts. */
  const horizon = () => fusion()?.periodMonths ?? 12;
  /** Whether this customer opted out of Fusion: then it is left out of the credits, the findings and the report. */
  const fusionOff = () => fusion()?.optOut === true;
  /** Whether Fusion is part of this projection: not opted out, and some project counted. */
  const fusionCounts = (est = estimate()) => !fusionOff() && est.rows.some((r) => r.included && r.units);
  const fusionOn = () => fusionCounts();

  /** The figures behind the tab and the report: null until the backlog is read. */
  function trFigures() {
    if (!c.open?.tr?.totals || !c.open.tr.fixed) return null;
    const { totalRows, fixedRows } = seriesRows(tr().totals, tr().fixed);
    const analysis = analyse(totalRows, fixedRows, tr().lookbackMonths);
    if (!analysis) return null;
    // Fusion's extra findings are SAST's: its own part of the read, when the read told engines apart.
    const sastRows = tr().totals.sast && tr().fixed.sast ? seriesRows(tr().totals, tr().fixed, 'sast') : null;
    const sast = sastRows ? analyse(sastRows.totalRows, sastRows.fixedRows, tr().lookbackMonths) : null;
    const projection = trProjection(analysis, tr(), { months: horizon(), fusion: fusionOn(), sast });
    return {
      analysis,
      // The debt and fixing rates over the last 6 months, for the report, whatever the trend is averaged over.
      recent: analyse(totalRows, fixedRows, 6),
      projection,
      // Week by week over the months the trend is averaged over, at least 6 (as far back as the data goes).
      weekly: weeklyTrend(totalRows, fixedRows, Math.round(Math.max(6, tr().lookbackMonths) * 4.345)),
      forecast: planForecast(analysis, projection),
      bySeverity: severityPlan(analysis, projection),
    };
  }

  let vendor = null;
  /** The .xlsx reader and the export parser, loaded the first time a file is read. */
  function readers() {
    // In the standalone file they are already in the page.
    if (window.CxXlsx && window.CxParse) return Promise.resolve({ xlsx: window.CxXlsx, parse: window.CxParse });
    vendor ??= Promise.all(
      ['calculator/vendor/xlsx-lite.js', 'calculator/vendor/parse.js'].map(
        (src) =>
          new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.onload = resolve;
            script.onerror = () => reject(new Error('The file reader could not be loaded. Reload the page.'));
            document.head.append(script);
          }),
      ),
    ).then(() => ({ xlsx: window.CxXlsx, parse: window.CxParse }));
    return vendor;
  }

  /** Read one export into its slot (or the slot its name or filters say, when dropped together). */
  async function ingest(file, slot) {
    if (!c.open) return;
    setStatus('calc-upload-status', `Reading ${file.name}…`, 'muted');
    try {
      const { xlsx, parse } = await readers();
      const sheets = await xlsx.readFile(file);
      const kind = slot ?? (parse.guessKind(file.name, sheets) === 'fixed' ? 'fixed' : 'totals');
      const parsed = parse.parseWorkbook(sheets, file.name);
      c.open.tr = { ...tr(), [kind]: parsed };
      save({ tr: c.open.tr });
      setStatus('calc-upload-status', parsed.warnings?.length ? parsed.warnings.join(' ') : `${num(parsed.weeks.length)} weeks read.`, parsed.warnings?.length ? 'warn' : 'ok');
      syncDraft();
      renderTr();
    } catch (error) {
      setStatus('calc-upload-status', error.message, 'error');
    }
  }

  for (const slot of ['totals', 'fixed']) {
    const input = $(`calc-file-${slot}`);
    input.addEventListener('change', () => {
      for (const file of input.files) ingest(file, input.files.length > 1 ? null : slot);
      input.value = '';
    });
    const zone = $(`calc-slot-${slot}`);
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      zone.classList.add('over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.classList.remove('over');
      const files = [...(event.dataTransfer?.files ?? [])];
      for (const file of files) ingest(file, files.length > 1 ? null : slot);
    });
  }
  $('calc-sample').addEventListener('click', async () => {
    for (const [name, slot] of [
      ['Total_Vulnerabilities_by_Severity.xlsx', 'totals'],
      ['Fixed_Vulnerabilities_by_Severity.xlsx', 'fixed'],
    ]) {
      try {
        const response = sampleFile ? await sampleFile(name) : await fetch(`calculator/samples/${name}`);
        if (!response.ok) throw new Error(`${name}: ${response.status}`);
        await ingest(new File([await response.blob()], name), slot);
      } catch (error) {
        setStatus('calc-upload-status', error.message, 'error');
      }
    }
  });
  $('calc-present').addEventListener('click', () => {
    c.present = !c.present;
    $('calc-present').setAttribute('aria-pressed', String(c.present));
    $('calc-present').textContent = c.present ? 'Exit customer view' : 'Customer view';
    $('page-calculator').classList.toggle('calc-presenting', c.present);
  });

  function renderSlots() {
    const t = tr()?.totals;
    const range = t?.weeks?.length ? ` · <span translate="no">${esc(t.weeks[0])} → ${esc(t.weeks[t.weeks.length - 1])}</span>` : '';
    $('calc-tr-source').innerHTML = !t
      ? offline()
        ? '<span>Nothing yet: drop the two Checkmarx One exports below, or load the sample data.</span>'
        : '<span>Nothing read yet: <strong>Read from Checkmarx One</strong> at the top reads the backlog and fixes, week by week.</span>'
      : t.meta?.source === 'cxone'
        ? `<b>From Checkmarx One</b> · <span>Last read <time translate="no">${esc(fmtDateTime(t.meta.readAt))}</time></span> · <span>${num(t.meta.projects)} projects, ${num(t.meta.scans)} scans</span>${range}`
        : `<b>From the two exports</b>${range}`;
    for (const slot of ['totals', 'fixed']) {
      const s = tr()?.[slot];
      $(`calc-slot-${slot}`).classList.toggle('ok', Boolean(s));
      $(`calc-file-${slot}-name`).innerHTML = s ? `${s.meta?.fileName ? `<span translate="no">${esc(s.meta.fileName)}</span>` : '<span>Saved data</span>'} · <span>${num(s.weeks.length)} weeks</span> · <span translate="no">${esc(s.weeks[0])} → ${esc(s.weeks[s.weeks.length - 1])}</span>` : 'Choose or drop the .xlsx export';
    }
  }

  /** The engines whose findings are projected (SAST and SCA unless more are ticked). */
  const trEngines = () => (cleanEngines(tr()?.engines).length ? cleanEngines(tr().engines) : [...DEFAULT_ENGINES]);

  /** Which engines' findings the projection counts: read from Checkmarx One, each engine is counted apart. */
  function enginesRow() {
    const meta = tr()?.totals?.meta ?? {};
    const live = meta.source === 'cxone';
    const chosen = new Set(trEngines());
    const note = !live
      ? `<span class="hint">${offline() ? 'The two exports count every engine together.' : 'The two exports count every engine together: read from Checkmarx One to count only some.'}</span>`
      : meta.engineSplit === false
        ? '<span class="hint calc-warn">This read is from before engines were counted apart, so every engine is counted: read from Checkmarx One again to count only these.</span>'
        : '<span class="hint">AI Triage and AI Remediation credits are spent on SAST and SCA findings.</span>';
    // Only some scan origins chosen, but this backlog counts every scan: said, with what to do.
    const origins = !scope().origins
      ? ''
      : !live
        ? '<span class="hint calc-warn">The two exports count every scan: only Fusion follows Include scans from.</span>'
        : meta.originSplit === false
          ? '<span class="hint calc-warn">This read is from before scan origins were recorded, so every scan is counted: read from Checkmarx One again to count only the scans chosen.</span>'
          : '';
    return `<div class="calc-engines calc-edit" role="group" aria-label="Engines counted">
          <span class="hint"><b>Engines counted</b></span>
          ${ENGINES.map((e) => `<label class="pill-check"><input type="checkbox" data-engine="${e.key}"${chosen.has(e.key) ? ' checked' : ''}${live ? '' : ' disabled'} /> <span translate="no">${e.label}</span>${e.ai ? '' : ' <small>No AI</small>'}</label>`).join('')}
          ${note}${origins}
        </div>`;
  }

  function renderTr() {
    if (!c.open) return;
    renderSlots();
    const f = trFigures();
    c.trCredits = f ? f.projection.totals.credits : null;
    c.trSplit = f ? f.projection.totals : null;
    renderSummary();
    if (!f) {
      $('calc-tr').innerHTML = offline()
        ? '<p class="hint calc-wait">Drop the two Checkmarx One exports (or load the sample data) to see the backlog, its trend and the credits it takes.</p>'
        : '<p class="hint calc-wait">Read from Checkmarx One (or use the two exports) to see the backlog, its trend and the credits it takes.</p>';
      return;
    }
    const { analysis, projection } = f;
    c.trFusionOn = projection.fusion;
    const P = projection.totals;
    const A = projection.ahead;
    const months = projection.months;
    const sevHead = (s) => `<th><span class="calc-sev"><i translate="no" style="background:${SEVERITY_COLOURS[s]}"></i>${s}</span></th>`;
    const row = (label, cells, total, cls = '') => `<tr class="${cls}"><td>${label}</td>${cells.map((v) => `<td class="num">${v}</td>`).join('')}<td class="num calc-total">${total}</td></tr>`;
    const R = projection.rows;
    const step = (label, value, sub, cls = '', why = '') => `<div class="calc-step ${cls}"><span class="calc-step-label">${label}${why ? whyButton(why) : ''}</span><b>${value}</b><small>${sub}</small></div>`;
    $('calc-tr').innerHTML = `
      <p class="calc-snapshot">Backlog as of <time>${esc(analysis.latestDate)}</time>; the trend over the ${num(tr().lookbackMonths)} months before it.</p>
      <section class="panel calc-flow">
        <div class="calc-section-head"><h2>What the projection counts</h2>
          <div class="calc-lookback calc-edit" role="group" aria-label="Trend over">${LOOKBACKS.map((m) => `<button type="button" class="${tr().lookbackMonths === m ? 'on' : ''}" aria-pressed="${tr().lookbackMonths === m}" data-lookback="${m}">${m} months</button>`).join('')}</div></div>
        ${enginesRow()}
        <div class="calc-steps">
          ${step('Backlog today', num(P.selected), P.selected === P.backlog ? 'every open finding' : `of ${num(P.backlog)} open`, '', 'backlog')}
          <span class="calc-op" aria-hidden="true">+</span>
          ${step('Still to come', num(P.future), !A.includeFuture ? 'not counted' : `over ${num(months)} months`, '', 'future')}
          <span class="calc-op" aria-hidden="true">+</span>
          ${step('More found by Fusion', num(P.fusionExtra), projection.fusion ? (projection.sastOnly ? `${num(A.fusionUpliftPercent)}% more SAST findings` : tr().totals?.meta?.source === 'cxone' ? `${num(A.fusionUpliftPercent)}% more findings · read again for SAST only` : `${num(A.fusionUpliftPercent)}% more findings · the exports count every engine`) : fusionOff() ? '0% · Fusion left out' : 'Fusion not in the projection', '', 'fusion')}
          <span class="calc-op" aria-hidden="true">=</span>
          ${step('To triage', num(P.toTriage), `${num(P.truePositives)} to remediate`, 'calc-step-key', 'triage')}
          <span class="calc-op" aria-hidden="true">→</span>
          ${step('Credits', num(P.credits, 1), `${num(P.backlogCredits, 1)} backlog + ${num(P.aheadCredits, 1)} ahead`, 'calc-step-gold', 'credits')}
        </div>
        <div class="calc-assume calc-edit">
          <label class="check"><input type="checkbox" data-ahead="includeFuture"${A.includeFuture ? ' checked' : ''} /> Count findings still to come</label>
          <label class="calc-assume-num"><span>AI adoption: fewer new findings over a year (%)</span><input type="text" inputmode="decimal" class="calc-num" data-ahead="aiDeclinePercent" value="${A.aiDeclinePercent}" /></label>
          <label class="calc-assume-num"${fusionOff() ? ' title="Fusion for the existing customer is left out of this projection: tick Add Fusion: Existing customer at the top to count it."' : ''}><span>More found by Fusion (%)</span><input type="text" inputmode="decimal" class="calc-num" data-ahead="fusionUpliftPercent" value="${fusionOff() ? 0 : A.fusionUpliftPercent}"${fusionOff() ? ' disabled' : ''} /></label>
          <button type="button" class="link" data-ahead-reset>Defaults</button>
        </div>
      </section>
      <details class="panel calc-edit calc-custom" open>
        <summary><h2>Customize per severity</h2><span class="hint">How many of the backlog to triage, the false positives expected, and the credits each step takes. Everything starts from the defaults.</span></summary>
        <div class="calc-sev-grid">${SEVERITIES.map((s) => {
          const d = c.draft[s];
          const open = analysis.perSeverity[s].current;
          const chosen = d.selected === null || d.selected === undefined ? open : Math.min(d.selected, open);
          return `<div class="calc-sev-box" data-sev="${s}">
            <div class="calc-sev-top"><span class="calc-sev"><i translate="no" style="background:${SEVERITY_COLOURS[s]}"></i>${s}</span><span class="hint">${num(open)} open</span></div>
            <input type="range" min="0" max="${open}" value="${chosen}" data-f="selected" aria-label="${s}: to triage" style="--p:${fill(chosen, open)}%" />
            <div class="calc-row"><input type="number" min="0" max="${open}" value="${chosen}" data-f="selected" aria-label="${s}: to triage" />
              <span><button type="button" class="ghost small-btn" data-set="0">None</button><button type="button" class="ghost small-btn" data-set="all">All</button></span></div>
            <label class="calc-row"><span>Credits per triage</span><input type="number" min="0" step="0.5" value="${d.triageCost}" data-f="triageCost" /></label>
            <label class="calc-row"><span>False positives %</span><input type="number" min="0" max="100" step="1" value="${d.fpPercent}" data-f="fpPercent" /></label>
            <label class="calc-row"><span>Credits per remediation</span><input type="number" min="0" step="0.5" value="${d.remediationCost}" data-f="remediationCost" /></label>
            <p class="calc-sev-result"><span>To triage</span> <b>${num(R[s].toTriage)}</b> · <span>to remediate</span> <b>${num(R[s].truePositives)}</b> · <b class="calc-gold">${num(R[s].credits, 1)}</b> <span>credits</span></p>
            <button type="button" class="${c.dirty[s] ? 'primary' : 'secondary'} calc-apply" data-apply${c.dirty[s] ? '' : ' disabled'}>${c.dirty[s] ? 'Apply' : 'Applied'}</button>
          </div>`;
        }).join('')}</div>
        <p class="hint">Credits per triage and per remediation start at Checkmarx One's 1 and 3: set them to the customer's agreement. The false-positive rate is your estimate for this customer.</p>
      </details>
      ${debtFixSection(analysis, f.weekly)}
      <section class="panel">
        <h2>Backlog trend and forecast</h2>
        <p class="hint">${analysis.monthlyChange >= 0 ? `The backlog grew by ${num(analysis.monthlyChange)} a month on average recently.` : `The backlog shrank by ${num(-analysis.monthlyChange)} a month on average recently.`} Shaded: the next ${num(months)} months.</p>
        ${forecastChart(f.forecast)}
      </section>
      <section class="panel">
        <h2>By severity</h2>
        <p class="hint">The backlog so far, then with the plan over the next ${num(months)} months (dashed). Each severity on its own scale.</p>
        ${severityCharts(f.bySeverity)}
      </section>`;
  }

  /**
   * Debt added against fixes: one sentence, the timeline, and by severity what new findings add
   * and fixes take away a month (each also as a share of the backlog), and the difference.
   */
  function debtFixSection(analysis, weekly) {
    const T = analysis.total;
    const share = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '' : ` <small>${num(v, 1)}%</small>`);
    const net = (v) => (!Number.isFinite(v) ? '—' : Math.round(v) > 0 ? `<span class="calc-bad">▲ +${num(v)}</span>` : Math.round(v) < 0 ? `<span class="calc-good">▼ −${num(-v)}</span>` : '0');
    const line = (label, x, cls = '') => `<tr class="${cls}"><td>${label}</td><td class="num">${num(x.current)}</td><td class="num">${num(x.arrivals)}${share(x.addedPct)}</td><td class="num">${num(x.fixedMonthly)}${share(x.fixedPct)}</td><td class="num">${net(x.netMonthly)}</td></tr>`;
    const faster = T.fixedMonthly > 0 && T.arrivals > T.fixedMonthly ? T.arrivals / T.fixedMonthly : null;
    const verdict = !Number.isFinite(T.netMonthly)
      ? ''
      : T.netMonthly > 0
        ? faster ? `The backlog grows by ${num(T.netMonthly)} a month: fixing would have to be ${num(faster, 1)} times as fast to keep up.` : `The backlog grows by ${num(T.netMonthly)} a month.`
        : `The backlog shrinks by ${num(-T.netMonthly)} a month.`;
    return `<section class="panel calc-debtfix">
        <h2>Debt added against fixes</h2>
        <p class="calc-verdict"><span>Each month, new findings add ${num(T.addedPct, 1)}% to the backlog and fixes take away ${num(T.fixedPct, 1)}%.</span> <span>${verdict}</span></p>
        ${weekly?.length ? debtFixChart(weekly) : ''}
        <div class="table-wrap"><table class="data-table calc-debt-table">
          <thead><tr><th>Severity</th><th class="num">Open now</th><th class="num">Added a month</th><th class="num">Fixed a month</th><th class="num">Change a month</th></tr></thead>
          <tbody>
            ${SEVERITIES.map((s) => line(`<span class="calc-sev"><i translate="no" style="background:${SEVERITY_COLOURS[s]}"></i>${s}</span>`, analysis.perSeverity[s])).join('')}
            ${line('Total', T, 'strong')}
          </tbody></table></div>
        <p class="hint">Over the last ${num(tr().lookbackMonths)} months. Percentages: a share of today's backlog. The estimates (Fusion, false positives, credits) are set above, under What the projection counts and Customize per severity.</p>
      </section>`;
  }

  // ---- "?": how each number is worked out, with the figures in -------------------------------

  const whyButton = (key) => `<button type="button" class="calc-why" data-why="${key}" aria-haspopup="dialog" aria-label="How is this worked out?" title="How is this worked out?">?</button>`;
  const WHY = { backlog: ['backlog'], future: ['future'], fusion: ['fusion'], triage: ['triage', 'remediate'], credits: ['credits'], 'fusion-credits': ['fusion-credits'], total: ['total'] };
  const pop = document.createElement('div');
  pop.className = 'calc-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('translate', 'no');
  pop.hidden = true;
  document.body.append(pop);
  let popFor = null;
  const closePop = () => {
    pop.hidden = true;
    popFor?.setAttribute('aria-expanded', 'false');
    popFor = null;
  };
  function openPop(button) {
    if (popFor === button) return closePop();
    closePop();
    const data = reportData();
    const L = wording({ t, lang: currentLanguage() });
    const sections = allSections(data, L).filter((x) => WHY[button.dataset.why]?.includes(x.key));
    if (!sections.length) return;
    pop.innerHTML = `<button type="button" class="calc-pop-close" aria-label="${esc(t('Close'))}">×</button>${sections.map((x) => `<h4>${x.title}</h4>${sectionHtml(x)}`).join('')}`;
    pop.dir = RTL.has(currentLanguage()) ? 'rtl' : 'ltr';
    pop.hidden = false;
    const r = button.getBoundingClientRect();
    const width = Math.min(480, window.innerWidth - 24);
    pop.style.width = `${width}px`;
    pop.style.left = `${Math.max(12, Math.min(window.scrollX + r.left - 20, window.scrollX + window.innerWidth - width - 12))}px`;
    pop.style.top = `${window.scrollY + r.bottom + 8}px`;
    button.setAttribute('aria-expanded', 'true');
    popFor = button;
    pop.querySelector('.calc-pop-close').focus();
  }
  document.addEventListener('click', (event) => {
    const button = event.target.closest('.calc-why');
    if (button) return openPop(button);
    if (event.target.closest('.calc-pop-close') || (!pop.hidden && !event.target.closest('.calc-pop'))) closePop();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !pop.hidden) {
      const back = popFor;
      closePop();
      back?.focus();
    }
  });

  /** What the report keeps of the analysis for one severity (or the total). */
  const debtFigures = (x) => ({ current: x.current, prior: x.prior, fixed: x.fixed, arrivals: x.arrivals, debtRate: x.debtRate, fixRate: x.fixRate, fixedMonthly: x.fixedMonthly, netMonthly: x.netMonthly, addedPct: x.addedPct, fixedPct: x.fixedPct });

  /** The triage & remediation figures as the report keeps them: what explains every number too. */
  const trData = (t) => ({
    asOf: t.analysis.latestDate,
    previousDate: t.analysis.previousDate,
    lookbackMonths: t.analysis.lookbackMonths,
    months: t.projection.months,
    paced: t.projection.paced,
    fusion: t.projection.fusion,
    sastOnly: t.projection.sastOnly,
    ahead: t.projection.ahead,
    rows: t.projection.rows,
    totals: t.projection.totals,
    analysis: {
      ...Object.fromEntries(SEVERITIES.map((s) => [s, debtFigures(t.analysis.perSeverity[s])])),
      total: debtFigures(t.analysis.total),
      spanMonths: t.analysis.spanMonths,
    },
    recent: t.recent ? {
      months: 6,
      spanMonths: t.recent.spanMonths,
      ...Object.fromEntries([...SEVERITIES, 'total'].map((s) => {
        const x = s === 'total' ? t.recent.total : t.recent.perSeverity[s];
        return [s, { arrivals: x.arrivals, fixedMonthly: x.fixedMonthly, addedPct: x.addedPct, fixedPct: x.fixedPct }];
      })),
    } : null,
  });

  /** How far along its track a slider's thumb is, for the filled part (0 is at the very start). */
  const fill = (value, max) => (max > 0 ? Math.round((Math.min(value, max) / max) * 1000) / 10 : 0);

  function setDraft(box, field, value) {
    const s = box.dataset.sev;
    const max = Number(box.querySelector('input[type="range"]').max);
    if (field === 'selected' && value === 'all') value = max;
    let v = amount(value) ?? 0;
    if (field === 'selected') {
      v = Math.min(max, Math.round(v));
      for (const input of box.querySelectorAll('[data-f="selected"]')) if (Number(input.value) !== v) input.value = v;
      box.querySelector('input[type="range"]').style.setProperty('--p', `${fill(v, max)}%`);
    }
    if (field === 'fpPercent') v = Math.min(100, v);
    c.draft[s][field] = v;
    c.dirty[s] = true;
    const apply = box.querySelector('[data-apply]');
    apply.disabled = false;
    apply.className = 'primary calc-apply';
    apply.textContent = 'Apply';
  }

  $('calc-tr').addEventListener('input', (event) => {
    const box = event.target.closest('.calc-sev-box');
    if (box && event.target.dataset.f) setDraft(box, event.target.dataset.f, event.target.value);
  });
  $('calc-tr').addEventListener('click', (event) => {
    const box = event.target.closest('.calc-sev-box');
    if (box && event.target.closest('[data-set]')) return setDraft(box, 'selected', event.target.closest('[data-set]').dataset.set);
    if (box && event.target.closest('[data-apply]')) {
      const s = box.dataset.sev;
      const d = c.draft[s];
      const open = Number(box.querySelector('input[type="range"]').max);
      c.open.tr = {
        ...tr(),
        // Every open finding stays "every open finding" (null), so a later read keeps it whole.
        selected: { ...tr().selected, [s]: d.selected === null || d.selected >= open ? null : d.selected },
        triageCost: { ...tr().triageCost, [s]: d.triageCost },
        fpPercent: { ...tr().fpPercent, [s]: d.fpPercent },
        remediationCost: { ...tr().remediationCost, [s]: d.remediationCost },
      };
      c.dirty[s] = false;
      save({ tr: c.open.tr });
      return renderTr();
    }
    const lookback = event.target.closest('[data-lookback]');
    if (lookback) {
      c.open.tr = { ...tr(), lookbackMonths: Number(lookback.dataset.lookback) };
      save({ tr: c.open.tr });
      renderTr();
    }
    if (event.target.closest('[data-ahead-reset]')) {
      c.open.tr = { ...tr(), includeFuture: DEFAULT_TR.includeFuture, fusionUpliftPercent: DEFAULT_TR.fusionUpliftPercent, aiDeclinePercent: DEFAULT_TR.aiDeclinePercent };
      save({ tr: c.open.tr });
      renderTr();
    }
  });
  // What is still to come: changes count at once (the figures follow as it is typed).
  $('calc-tr').addEventListener('change', (event) => {
    const engine = event.target.dataset.engine;
    if (engine) {
      const chosen = [...$('calc-tr').querySelectorAll('[data-engine]:checked')].map((box) => box.dataset.engine);
      // At least one engine: none would count nothing.
      if (!chosen.length) {
        event.target.checked = true;
        return;
      }
      c.open.tr = { ...tr(), engines: chosen };
      save({ tr: c.open.tr });
      return applyScope();
    }
    const key = event.target.dataset.ahead;
    if (!key) return;
    const value = key === 'includeFuture' ? event.target.checked : amount(event.target.value);
    c.open.tr = { ...tr(), ...aheadSettings({ ...tr(), [key]: value }) };
    save({ tr: c.open.tr });
    renderTr();
  });

  // ---- Fusion -------------------------------------------------------------------------------

  const fusion = () => c.open?.fusion;
  const scope = () => cleanScope(c.open?.scope);
  /** Is this project in the scope, as the scans from the scan origins chosen see it (byOrigins)? */
  const counts = (p, sc = scope()) => {
    const seen = byOrigins(p, sc.origins);
    return Boolean(seen) && inScope(seen, sc, trEngines());
  };
  /** The projects that count, as the scans from the scan origins chosen see them (a project added by hand always counts). */
  const scoped = () => fusion().projects.map((p) => byOrigins(p, scope().origins)).filter((p) => p && (p.source === 'manual' || inScope(p, scope(), trEngines())));
  /** Projects read from Checkmarx One that the scope leaves out: none when it counts them all. */
  const leftOutBy = (sc = scope()) => (fusion()?.projects ?? []).filter((p) => p.source !== 'manual' && !counts(p, sc));
  const narrowed = () => leftOutBy().length > 0;
  /** How many projects each leave-out option takes out (of those the other choices keep), and those with no scan from the scan origins chosen. */
  function leftOutCounts(sc = scope()) {
    const read = (fusion()?.projects ?? []).filter((p) => p.source !== 'manual');
    const projects = read.map((p) => byOrigins(p, sc.origins)).filter(Boolean);
    const without = (change) => projects.filter((p) => !inScope(p, { ...sc, ...change }, trEngines())).length;
    const now = without({});
    return { noCode: sc.leaveOutNoCode ? now - without({ leaveOutNoCode: false }) : 0, noFindings: sc.leaveOutNoFindings ? now - without({ leaveOutNoFindings: false }) : 0, noOrigin: read.length - projects.length };
  }
  const estimate = () => fusionEstimate(scoped(), fusion());
  const ROWS_PAGE = 100;
  let rowsShown = ROWS_PAGE;
  const saveFusion = () => save({ fusion: fusion() });
  const modelOptions = (selected, blank) =>
    `<option value="">${esc(blank)}</option>` + fusion().models.map((m) => `<option value="${esc(m.id)}"${m.id === selected ? ' selected' : ''}>${esc(m.name || 'Unnamed model')}${m.creditsPer10k === null ? '' : ` · ${num(m.creditsPer10k, 2)}`}</option>`).join('');
  /** "Default model" says which one it is, so picking that same model is seen to change nothing. */
  const defaultLabel = () => {
    const m = fusion().models.find((x) => x.id === fusion().defaultModel);
    return m ? `Default: ${m.name || 'Unnamed model'}${m.creditsPer10k === null ? '' : ` · ${num(m.creditsPer10k, 2)}`}` : 'Default model';
  };
  const shown = () => {
    const words = $('calc-filter').value.trim().toLowerCase();
    return estimate().rows.filter((p) => !words || String(p.name).toLowerCase().includes(words));
  };

  function renderFusion() {
    if (!c.open) return;
    const f = fusion();
    $('calc-fusion-on').checked = next().fusionOn;
    $('calc-fusion-off-note').hidden = !fusionOff();
    $('page-calculator').classList.toggle('calc-fusion-off', fusionOff());
    $('calc-default-scans').value = f.defaultScans;
    $('calc-combine').value = f.combine;
    $('calc-default-model').innerHTML = modelOptions(f.defaultModel, f.models.length ? 'No model' : 'No model yet');
    renderReadNote();
    renderModels();
    renderRules();
    renderProjects();
    renderFusionNew();
  }

  function renderModels() {
    const f = fusion();
    $('calc-models-empty').hidden = f.models.length > 0;
    $('calc-models').innerHTML = f.models
      .map(
        (m) => `<tr data-model="${esc(m.id)}">
        <td>${m.source === 'tenant' || m.source === 'catalog'
          ? `<span class="calc-model-name" translate="no">${esc(m.name)}</span> <span class="calc-badge">${m.source === 'tenant' ? 'From Checkmarx One' : 'Checkmarx One model'}</span>${m.description ? `<small class="hint" translate="no">${esc(m.description)}</small>` : ''}`
          : `<input type="text" value="${esc(m.name)}" maxlength="80" data-m="name" aria-label="Model name" translate="no" placeholder="Type the model's name, as Checkmarx One shows it" />`}</td>
        <td><input type="text" inputmode="decimal" class="calc-num" value="${m.creditsPer10k ?? ''}" data-m="creditsPer10k" aria-label="Credits per 10K LOC" placeholder="Type the credits" /></td>
        <td><button type="button" class="ghost calc-remove" data-remove-model>Remove</button></td></tr>`,
      )
      .join('');
  }

  function renderRules() {
    const f = fusion();
    const rows = scoped();
    const ruleRow = (key, label, count, rule, attr) => `<tr ${attr}="${key}">
      <td>${label}</td><td class="num">${num(count)}</td>
      <td><input type="text" inputmode="numeric" class="calc-num" value="${rule.scans ?? ''}" data-r="scans" placeholder="${num(f.defaultScans)} (default)" aria-label="Fusion scans per project" /></td>
      <td><select data-r="model" aria-label="Model">${modelOptions(rule.model, defaultLabel())}</select></td></tr>`;
    $('calc-freq').innerHTML = FREQUENCIES.map((q) => ruleRow(q.id, q.label, rows.filter((p) => p.frequency === q.id).length, f.byFrequency[q.id], 'data-freq')).join('');
    // Folded unless a criticality has its own number or model, so a plan made with it is never hidden.
    if (CRITICALITIES.some((k) => f.byCriticality[k]?.scans != null || f.byCriticality[k]?.model)) $('calc-crit-fold').open = true;
    $('calc-crit').innerHTML = [...CRITICALITIES.map((k) => ruleRow(k, `${k}${k === 5 ? ' (most critical)' : k === 1 ? ' (least critical)' : ''}`, rows.filter((p) => p.criticality === k).length, f.byCriticality[k], 'data-crit'))].join('');
  }

  function renderKpis(est = estimate()) {
    const t = est.totals;
    const on = fusionCounts(est);
    c.fusionCredits = on ? t.credits : null;
    // Fusion coming in or going out changes what triage & remediation counts (the findings Fusion adds).
    if (c.trFusionOn !== undefined && c.trFusionOn !== on) renderTr();
    renderSummary();
    const kpi = (label, value, sub, cls = '') => `<div class="rp-kpi ${cls}"><span class="rp-tile-label">${esc(label)}</span><span class="rp-kpi-value">${value}</span><span class="rp-tile-sub">${sub}</span></div>`;
    $('calc-fkpis').innerHTML = [
      kpi('Projects', num(t.projects), t.unknownLines ? `<span class="calc-warn">Still without lines of code: ${num(t.unknownLines)}</span>` : 'Included, with lines of code'),
      kpi('10K LOC units', num(t.units), `${num(t.lines)} lines, each project rounded up`),
      kpi('Fusion scans', num(t.scans), `Over ${num(est.settings.periodMonths)} months`),
      kpi('Credits', num(t.credits, 1), t.unknownRate ? `<span class="calc-warn">Projects whose model has no credits per 10K LOC: ${num(t.unknownRate)}</span>` : `Over ${num(est.settings.periodMonths)} months`, 'calc-gold'),
      c.remainingCredits !== null ? kpi('Credits remaining in the tenant', num(c.remainingCredits), c.remainingCredits >= t.credits ? 'Enough for this projection' : `<span class="calc-warn">Short by ${num(t.credits - c.remainingCredits, 1)}</span>`) : '',
    ].join('');
  }

  function rowHtml(p) {
    const manual = p.source === 'manual';
    const scanned = wholeNumber(p.loc);
    const changed = !manual && wholeNumber(p.locOverride) !== null && wholeNumber(p.locOverride) !== scanned;
    return `<tr data-row="${esc(p.id)}" class="${p.included ? '' : 'calc-off'}">
      <td><input type="checkbox" data-p="included"${p.included ? ' checked' : ''} aria-label="Include ${esc(p.name)}" /></td>
      <td>${manual ? `<span class="calc-name-cell"><input type="text" data-p="name" value="${esc(p.name)}" maxlength="200" aria-label="Project name" translate="no" /><button type="button" class="ghost calc-remove" data-remove-project>Remove</button></span>` : `<span translate="no">${esc(p.name)}</span>`}</td>
      <td>${manual ? `<select data-p="criticality" aria-label="Criticality"><option value="">—</option>${CRITICALITIES.map((k) => `<option${p.criticality === k ? ' selected' : ''}>${k}</option>`).join('')}</select>` : p.criticality ?? '—'}</td>
      <td>${manual ? `<select data-p="frequency" aria-label="How often it is scanned">${FREQUENCIES.map((q) => `<option value="${q.id}"${p.frequency === q.id ? ' selected' : ''}>${esc(q.label)}</option>`).join('')}</select>` : `${esc(FREQ_LABEL[p.frequency] ?? '—')}${p.scanCount ? `<small class="hint">${num(p.scanCount)} scans in a year</small>` : ''}`}</td>
      <td><input type="text" inputmode="numeric" class="calc-num" data-p="loc" value="${p.lines ?? ''}" placeholder="${scanned === null ? 'Type them' : ''}" aria-label="Lines of code of ${esc(p.name)}" title="${esc(SOURCE_LABEL[p.source] ?? '')}" />${changed ? `<small class="hint">Scan counted ${num(scanned)} <button type="button" class="link" data-reset-loc>Use it</button></small>` : ''}</td>
      <td class="num" data-cell="units">${p.included && p.units ? num(p.units) : '—'}</td>
      <td><input type="text" inputmode="numeric" class="calc-num" data-p="scansOverride" value="${p.scansOverride ?? ''}" placeholder="${num(p.scans)}" aria-label="Fusion scans for ${esc(p.name)}" /><small class="hint" data-cell="from">${esc(FROM_LABEL[p.scansFrom] ?? '')}</small></td>
      <td><select data-p="modelOverride" aria-label="Model for ${esc(p.name)}">${modelOptions(p.modelOverride, 'Automatic')}</select></td>
      <td class="num" data-cell="credits">${p.included && p.units ? (p.credits === null ? '—' : num(p.credits, 1)) : '—'}</td>
    </tr>`;
  }

  // ---- Sorting the projects table: click a column's heading; again for the other way. Remembered in this browser.
  const SORT_STORE = 'mz-calc-sort';
  let projectSort = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SORT_STORE) || 'null');
      if (saved?.key) return { key: String(saved.key), dir: saved.dir === 'desc' ? 'desc' : 'asc' };
    } catch {}
    return { key: null, dir: 'asc' };
  })();
  /** The estimate's rows in the table's order (the CSV follows it too). */
  const sortedRows = (est) => sortProjects(est.rows, projectSort, { modelName: (id) => est.settings.models.find((m) => m.id === id)?.name ?? '' });
  function renderSortHeads() {
    for (const th of document.querySelectorAll('#calc-projects-head th[data-sort]')) {
      const on = th.dataset.sort === projectSort.key;
      th.setAttribute('aria-sort', on ? (projectSort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
      th.dataset.dir = on ? projectSort.dir : '';
    }
  }
  $('calc-projects-head').addEventListener('click', (event) => {
    const th = event.target.closest('th[data-sort]');
    if (!th || !c.open) return;
    const key = th.dataset.sort;
    // A new column starts the way people usually want it: names A to Z, numbers largest first.
    projectSort = projectSort.key === key ? { key, dir: projectSort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' || key === 'model' ? 'asc' : 'desc' };
    try {
      localStorage.setItem(SORT_STORE, JSON.stringify(projectSort));
    } catch {}
    renderProjects();
  });

  function renderProjects() {
    const est = estimate();
    const words = $('calc-filter').value.trim().toLowerCase();
    const rows = sortedRows(est).filter((p) => !words || String(p.name).toLowerCase().includes(words));
    renderSortHeads();
    // A long list a page at a time: the totals above always count every project in the scope.
    $('calc-rows').innerHTML = rows.slice(0, rowsShown).map(rowHtml).join('');
    $('calc-rows-more').hidden = rows.length <= rowsShown;
    $('calc-rows-more-btn').textContent = `Show ${num(Math.min(ROWS_PAGE, rows.length - rowsShown))} more of ${num(rows.length - rowsShown)}`;
    const all = fusion().projects.length;
    $('calc-rows-count').textContent = all ? (narrowed() ? `${num(est.rows.length)} of ${num(all)} projects in the scope` : `${num(all)} projects`) : '';
    $('calc-rows-empty').hidden = est.rows.length > 0 && rows.length > 0;
    if (est.rows.length && !rows.length) $('calc-rows-empty').textContent = 'No project matches that name.';
    else if (all && !est.rows.length) $('calc-rows-empty').textContent = 'No project is in the scope: narrow the projects differently at the top.';
    renderKpis(est);
  }
  // Opting out of Fusion: the customer is not taking it, so nothing of it is counted (its settings stay for later).
  // Ticked at the top, it waits for Apply; "Include it" on the tab counts at once.
  const setFusionOn = (on) => {
    if (!c.open) return;
    fusion().optOut = !on;
    if (c.next) c.next.fusionOn = on;
    saveFusion();
    renderFusion();
    // Triage & remediation's "More found by Fusion" follows: 0% while it is left out, its own % again once back.
    renderTr();
    renderPending();
  };
  $('calc-fusion-on').addEventListener('change', (event) => c.open && setNext({ fusionOn: event.target.checked }, { redraw: false }));
  $('calc-fusion-include').addEventListener('click', () => setFusionOn(true));

  // ---- Fusion — new customer: code not in Checkmarx One yet, its lines counted from git or with cloc

  /** The new customer tab's projects and choices (a customer saved before it has none yet). */
  const fnew = () => {
    if (c.open && !c.open.fusionNew) c.open.fusionNew = cleanFusionNew({});
    return c.open?.fusionNew;
  };
  const fnewOff = () => fnew()?.optOut === true;
  const fnewEstimate = () => newCustomerEstimate(fnew(), fusion());
  const fnewCounts = (est = fnewEstimate()) => !fnewOff() && est.rows.some((r) => r.included && r.units);
  const saveFnew = () => save({ fusionNew: fnew() });
  const LANG_COLOURS = ['#2856c9', '#b45309', '#0d9488', '#7c3aed', '#be185d', '#0891b2', '#65a30d', '#ea580c'];

  function fnewRowHtml(p, colourOf) {
    const counted = p.languages.filter((l) => l.counted && l.lines > 0);
    const left = p.languages.filter((l) => !l.counted).reduce((n, l) => n + l.lines, 0);
    const total = counted.reduce((n, l) => n + l.lines, 0) || 1;
    const typed = wholeNumber(p.locOverride) !== null;
    // Where its lines came from: "git · main · 3f2a1c9" (and Count again), "cloc · payments-api.json", or typed.
    const from = p.git
      ? `<span class="calc-git-tag" translate="no" title="${esc(`${p.git.host}/${p.git.path}${p.git.countedAt ? ` · ${fmtDateTime(p.git.countedAt)}` : ''}`)}">${esc(['git', p.git.branch, p.git.commit].filter(Boolean).join(' · '))}</span>${gitOn() ? ' <button type="button" class="link" data-fnew-recount>Count again</button>' : ''}`
      : p.file ? `<span class="calc-git-tag" translate="no">${esc(`cloc · ${p.file}`)}</span>` : '—';
    return `<tr data-row="${esc(p.id)}" class="${p.included ? '' : 'calc-off'}">
      <td><input type="checkbox" data-n="included"${p.included ? ' checked' : ''} aria-label="Include ${esc(p.name)}" /></td>
      <td><span class="calc-name-cell"><input type="text" data-n="name" value="${esc(p.name)}" maxlength="200" aria-label="Project name" translate="no" /><button type="button" class="ghost calc-remove" data-remove-fnew>Remove</button></span></td>
      <td class="calc-from">${from}</td>
      <td>${counted.length || left
        ? `<span class="calc-lang-line" translate="no">${counted.slice(0, 3).map((l) => `${esc(l.name)} ${Math.round((l.lines / total) * 100)}%`).join(' · ')}${counted.length > 3 ? ` · +${counted.length - 3}` : ''}</span>${left ? `<span class="calc-lang-line">${esc(`${num(left)} lines not counted`)}</span>` : ''}<span class="calc-lang-bar">${counted.map((l) => `<i style="width:${((l.lines / total) * 100).toFixed(2)}%;background:${colourOf(l.name)}" title="${esc(`${l.name}: ${num(l.lines)}`)}"></i>`).join('')}</span>`
        : '—'}</td>
      <td><input type="text" inputmode="numeric" class="calc-num" data-n="loc" value="${typed ? p.locOverride : p.lines ?? ''}" placeholder="Type them" aria-label="Lines of code of ${esc(p.name)}" />${typed && p.languages.length ? `<small class="hint">${p.git ? 'Counted from git' : 'cloc counted'} ${num(newCustomerEstimate({ ...fnew(), projects: [{ ...p, locOverride: null }] }, fusion()).rows[0]?.lines)} <button type="button" class="link" data-fnew-reset>Use it</button></small>` : ''}</td>
      <td class="num" data-cell="units">${p.included && p.units ? num(p.units) : '—'}</td>
      <td><input type="text" inputmode="numeric" class="calc-num" data-n="scansOverride" value="${p.scansOverride ?? ''}" placeholder="${num(p.scans)}" aria-label="Fusion scans for ${esc(p.name)}" /></td>
      <td><select data-n="modelOverride" aria-label="Model for ${esc(p.name)}">${modelOptions(p.modelOverride, 'Automatic')}</select></td>
      <td class="num" data-cell="credits">${p.included && p.units ? (p.credits === null ? '—' : num(p.credits, 1)) : '—'}</td>
    </tr>`;
  }

  function renderFusionNew() {
    if (!c.open) return;
    const f = fnew();
    const est = fnewEstimate();
    $('calc-fusion-new-on').checked = next().fusionNewOn;
    $('calc-fnew-off-note').hidden = !fnewOff();
    $('calc-fnew-scans').value = f.defaultScans;
    const fallback = fusion().models.find((m) => m.id === fusion().defaultModel);
    $('calc-fnew-model').innerHTML = modelOptions(f.defaultModel, fallback ? t('As the existing customer tab: {0}').replace('{0}', fallback.name || t('Unnamed model')) : 'No model yet');
    // Every language found, most lines first: each one counted or left out with a click.
    const langs = new Map();
    for (const p of f.projects) for (const [lang, n] of Object.entries(p.langs ?? {})) langs.set(lang, (langs.get(lang) ?? 0) + (wholeNumber(n) ?? 0));
    const order = [...langs].sort((a, b) => b[1] - a[1]).map(([lang]) => lang);
    const colourOf = (lang) => LANG_COLOURS[Math.max(0, order.indexOf(lang)) % LANG_COLOURS.length];
    const out = new Set(f.leftOut);
    $('calc-fnew-langs').innerHTML = order.map((lang) => `<button type="button" class="m-flat${out.has(lang) ? ' out' : ''}" data-lang="${esc(lang)}" aria-pressed="${out.has(lang) ? 'false' : 'true'}" title="${out.has(lang) ? 'Not counted: click to count it' : 'Counted: click to leave it out'}"><span translate="no">${esc(lang)}</span><em>${num(langs.get(lang))}</em></button>`).join('');
    // A project on both tabs is counted twice unless one of them is unticked.
    const existing = new Set((fusionOff() ? [] : scoped().filter((p) => p.included !== false)).map((p) => String(p.name).toLowerCase()));
    const twice = fnewOff() ? [] : est.rows.filter((r) => r.included && existing.has(String(r.name).toLowerCase())).map((r) => r.name);
    $('calc-fnew-dup').hidden = !twice.length;
    $('calc-fnew-dup').textContent = twice.length ? t('Also on the existing customer tab, so counted on both: {0}. Untick it on one of them unless it really is a second copy of the code.').replace('{0}', twice.join(', ')) : '';
    // (Named `tot`, not `t`: `t` is the translation used above in this function.)
    const tot = est.totals;
    const kpi = (label, value, sub, cls = '') => `<div class="rp-kpi ${cls}"><span class="rp-tile-label">${esc(label)}</span><span class="rp-kpi-value">${value}</span><span class="rp-tile-sub">${sub}</span></div>`;
    $('calc-fnew-kpis').innerHTML = f.projects.length
      ? [
          kpi('Projects', num(tot.projects), tot.unknownLines ? `<span class="calc-warn">Still without lines of code: ${num(tot.unknownLines)}</span>` : 'Included, with lines of code'),
          kpi('10K LOC units', num(tot.units), `${num(tot.lines)} code lines, each project rounded up`),
          kpi('Fusion scans', num(tot.scans), `Over ${num(est.settings.periodMonths)} months`),
          kpi('Credits', num(tot.credits, 1), tot.unknownRate ? `<span class="calc-warn">Projects whose model has no credits per 10K LOC: ${num(tot.unknownRate)}</span>` : `Over ${num(est.settings.periodMonths)} months`, 'calc-gold'),
        ].join('')
      : '';
    $('calc-fnew-rows').innerHTML = est.rows.map((p) => fnewRowHtml(p, colourOf)).join('');
    $('calc-fnew-empty').hidden = f.projects.length > 0;
    $('calc-fnew-again').hidden = !f.projects.some((p) => p.git);
    showWay(way);
    renderSummary();
  }

  /** Totals and each row's figures while something is typed (the field keeps its place). */
  function refreshFnewFigures() {
    const est = fnewEstimate();
    const byId = new Map(est.rows.map((r) => [r.id, r]));
    for (const line of $('calc-fnew-rows').querySelectorAll('tr[data-row]')) {
      const p = byId.get(line.dataset.row);
      if (!p) continue;
      line.querySelector('[data-cell="units"]').textContent = p.included && p.units ? num(p.units) : '—';
      line.querySelector('[data-cell="credits"]').textContent = p.included && p.units ? (p.credits === null ? '—' : num(p.credits, 1)) : '—';
      line.querySelector('[data-n="scansOverride"]').placeholder = num(p.scans);
    }
    renderSummary();
  }

  const setFnewOn = (on) => {
    if (!c.open) return;
    fnew().optOut = !on;
    if (c.next) c.next.fusionNewOn = on;
    saveFnew();
    renderFusionNew();
    renderPending();
  };
  $('calc-fusion-new-on').addEventListener('change', (event) => c.open && setNext({ fusionNewOn: event.target.checked }, { redraw: false }));
  $('calc-fnew-include').addEventListener('click', () => setFnewOn(true));
  $('calc-fnew-scans').addEventListener('input', (event) => {
    if (!c.open) return;
    const n = wholeNumber(event.target.value);
    fnew().defaultScans = n === null ? fnew().defaultScans : Math.min(n, 10000);
    refreshFnewFigures();
    saveFnew();
  });
  $('calc-fnew-model').addEventListener('change', (event) => {
    if (!c.open) return;
    fnew().defaultModel = event.target.value || null;
    saveFnew();
    renderFusionNew();
  });
  $('calc-fnew-langs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-lang]');
    if (!button || !c.open) return;
    const lang = button.dataset.lang;
    const out = new Set(fnew().leftOut);
    if (out.has(lang)) out.delete(lang);
    else out.add(lang);
    fnew().leftOut = [...out];
    saveFnew();
    renderFusionNew();
  });

  const fnewProject = (el) => fnew().projects.find((p) => p.id === el.closest('tr[data-row]')?.dataset.row);
  $('calc-fnew-rows').addEventListener('input', (event) => {
    const p = fnewProject(event.target);
    const field = event.target.dataset.n;
    if (!p || !field) return;
    if (field === 'loc') p.locOverride = wholeNumber(event.target.value);
    else if (field === 'scansOverride') p.scansOverride = wholeNumber(event.target.value);
    else if (field === 'name') p.name = event.target.value.trim() || 'Unnamed project';
    else return;
    refreshFnewFigures();
    saveFnew();
  });
  $('calc-fnew-rows').addEventListener('change', (event) => {
    const p = fnewProject(event.target);
    const field = event.target.dataset.n;
    if (!p || !field) return;
    if (field === 'included') p.included = event.target.checked;
    else if (field === 'modelOverride') p.modelOverride = event.target.value || null;
    else if (field === 'name') return renderFusionNew();
    else return;
    saveFnew();
    renderFusionNew();
  });
  $('calc-fnew-rows').addEventListener('click', (event) => {
    const p = fnewProject(event.target);
    if (!p) return;
    if (event.target.closest('[data-fnew-recount]') && p.git) return countAgain(p);
    if (event.target.closest('[data-fnew-reset]')) p.locOverride = null;
    else if (event.target.closest('[data-remove-fnew]')) fnew().projects = fnew().projects.filter((x) => x !== p);
    else return;
    saveFnew();
    renderFusionNew();
  });
  $('calc-fnew-add').addEventListener('click', () => {
    if (!c.open) return;
    fnew().projects.push({ id: `new-${Date.now().toString(36)}`, name: 'New project', file: '', langs: {}, locOverride: null, included: true, scansOverride: null, modelOverride: null });
    saveFnew();
    renderFusionNew();
    $('calc-fnew-rows').querySelector('tr:last-child [data-n="name"]')?.select();
  });

  // ---- Count from git: the customer's repositories counted where they are kept (src/fusion-git.js) ----
  // On the server, or in the launcher on its own computer; the HTML file on its own can reach no git host.

  const gitOn = () => !standalone || canGit();
  const WAY_STORE = 'mz-calc-fnew-way';
  const GIT_MAX = 50;
  const GIT_ADDRESS = { github: 'https://github.com', gitlab: 'https://gitlab.com', azure: 'https://dev.azure.com/your-organisation', bitbucket: 'https://bitbucket.org' };
  // The Admin's connections (id, host, provider: never a token), the repositories listed, and the count running.
  const git = { connections: null, repos: [], run: null, owner: '' };
  let way = (() => {
    try {
      return localStorage.getItem(WAY_STORE) === 'cloc' ? 'cloc' : 'git';
    } catch {
      return 'git';
    }
  })();
  const bytes = (b) => (b >= 1024 ** 3 ? `${num(b / 1024 ** 3, 1)} GB` : b >= 1024 ** 2 ? `${num(b / 1024 ** 2)} MB` : `${num(Math.max(1, b / 1024))} KB`);

  /** Count from git or Upload cloc results: one shown at a time (only cloc where git cannot be reached). */
  function showWay(pick) {
    const on = gitOn();
    const shown = on && pick === 'git' ? 'git' : 'cloc';
    $('calc-fnew-ways').hidden = !on;
    for (const input of document.querySelectorAll('input[name="calc-fnew-way"]')) input.checked = input.value === shown;
    $('calc-git').hidden = shown !== 'git';
    $('calc-cloc').hidden = shown !== 'cloc';
    if (shown === 'git') loadConnections();
  }
  $('calc-fnew-ways').addEventListener('change', (event) => {
    if (event.target.name !== 'calc-fnew-way') return;
    way = event.target.value === 'cloc' ? 'cloc' : 'git';
    try {
      localStorage.setItem(WAY_STORE, way);
    } catch {}
    showWay(way);
  });

  /** The Admin's git connections, once: each one a choice in step 1, then a token typed for one count. */
  async function loadConnections() {
    if (git.connections) return;
    git.connections = [];
    try {
      git.connections = (await api('/api/projections/git/connections', { quiet: true })).connections ?? [];
    } catch (error) {
      if (handleAuthLoss(error)) return;
    }
    renderHosts();
  }

  const chosenHost = () => $('calc-git-hosts').querySelector('input:checked')?.value ?? 'token';
  function renderHosts() {
    const list = git.connections ?? [];
    const was = $('calc-git-hosts').querySelector('input:checked')?.value;
    const chosen = list.some((x) => x.id === was) || was === 'token' ? was : list[0]?.id ?? 'token';
    $('calc-git-hosts').innerHTML = [
      ...list.map((x, i) => `<label class="calc-git-host"><input type="radio" name="calc-git-host" value="${esc(x.id)}"${x.id === chosen ? ' checked' : ''} /><span><b translate="no">${esc(`${x.label} · ${x.host}`)}</b><small>${i === 0 ? 'A git connection the Admin already set up (the same tokens as Code authors). Nothing to type.' : 'Another git connection the Admin set up.'}</small></span></label>`),
      `<label class="calc-git-host"><input type="radio" name="calc-git-host" value="token"${chosen === 'token' ? ' checked' : ''} /><span><b>A token for this count only</b><small>${standalone ? 'The customer’s own read-only token: git on this computer fetches the code and counts it here.' : 'The customer’s own read-only token, for a host connected or allowed by the Admin.'}</small></span></label>`,
    ].join('');
    hostChanged();
  }

  function hostChanged() {
    const id = chosenHost();
    const conn = git.connections?.find((x) => x.id === id);
    const provider = conn?.provider ?? $('calc-git-provider').value;
    $('calc-git-token').hidden = id !== 'token';
    $('calc-git-address').placeholder = GIT_ADDRESS[$('calc-git-provider').value];
    $('calc-git-owner-label').textContent = provider === 'azure' ? 'Project (empty: every project)' : provider === 'bitbucket' ? 'Workspace (or project key)' : 'Organisation or group';
    // The connection's own organisation or group, until something else is typed.
    const owner = $('calc-git-owner');
    if (!owner.value || owner.value === git.owner) owner.value = git.owner = conn?.owner ?? '';
  }
  const hostSwitched = () => {
    git.repos = [];
    renderRepos();
    hostChanged();
  };
  $('calc-git-hosts').addEventListener('change', hostSwitched);
  $('calc-git-provider').addEventListener('change', hostSwitched);

  /** Where the code is, as the server takes it: a connection's id, or the token typed (sent with this request only). */
  function access() {
    const id = chosenHost();
    if (id !== 'token') return { connection: id };
    const token = $('calc-git-secret').value.trim();
    if (!token) throw new Error('Paste the token first (1 · Where the code is).');
    return { token: { provider: $('calc-git-provider').value, address: $('calc-git-address').value.trim(), token } };
  }

  $('calc-git-list').addEventListener('click', async () => {
    let body;
    try {
      body = { ...access(), owner: $('calc-git-owner').value.trim() };
    } catch (error) {
      return setStatus('calc-git-status', error.message, 'error');
    }
    setStatus('calc-git-status', 'Listing the repositories…', 'muted');
    $('calc-git-list').disabled = true;
    try {
      const found = await api('/api/projections/git/repositories', { method: 'POST', body: JSON.stringify(body), quiet: true });
      // Ticked to start with: each one not archived, up to the 50 a count takes.
      let ticked = 0;
      git.repos = (found.repositories ?? []).map((r) => ({ ...r, ticked: !r.archived && (ticked += 1) <= GIT_MAX }));
      renderRepos();
      if (!git.repos.length) setStatus('calc-git-status', 'No repositories there that this access may read.', 'warn');
      else if (found.more) setStatus('calc-git-status', `The first ${num(git.repos.length)} repositories are listed: paste the addresses of any others.`, 'warn');
      else setStatus('calc-git-status', '');
    } catch (error) {
      if (!handleAuthLoss(error)) showError('calc-git-status', error);
    } finally {
      $('calc-git-list').disabled = false;
    }
  });

  function renderRepos() {
    const box = $('calc-git-repos');
    box.hidden = !git.repos.length;
    box.innerHTML = git.repos.length
      ? `<div class="calc-git-repos-head"><span></span><button type="button" class="link" data-git-all>Tick all</button><button type="button" class="link" data-git-none>Tick none</button></div>` +
        git.repos
          .map((r, i) => `<label><input type="checkbox" data-git-repo="${i}"${r.ticked ? ' checked' : ''} /><span><span translate="no">${esc(r.path)}</span>${r.branch ? ` <span class="calc-git-tag" translate="no">${esc(r.branch)}</span>` : ''}${r.archived ? ' <span class="calc-git-tag">archived</span>' : ''}</span><span class="calc-git-size">${r.sizeBytes === null ? '' : esc(bytes(r.sizeBytes))}</span></label>`)
          .join('')
      : '';
    countLabel();
  }
  $('calc-git-repos').addEventListener('change', (event) => {
    const i = event.target.dataset.gitRepo;
    if (i === undefined || !git.repos[Number(i)]) return;
    git.repos[Number(i)].ticked = event.target.checked;
    countLabel();
  });
  $('calc-git-repos').addEventListener('click', (event) => {
    const all = event.target.closest('[data-git-all]');
    if (!all && !event.target.closest('[data-git-none]')) return;
    for (const r of git.repos) r.ticked = Boolean(all);
    renderRepos();
  });

  /** The repositories ticked and pasted, each once. */
  function wanted() {
    const out = git.repos.filter((r) => r.ticked).map((r) => ({ url: r.url, branch: r.branch }));
    for (const line of $('calc-git-paste').value.split(/\r?\n/)) if (line.trim()) out.push({ url: line.trim() });
    return [...new Map(out.map((r) => [r.url.replace(/(\.git)?\/*$/i, '').toLowerCase(), r])).values()];
  }
  function countLabel() {
    const n = wanted().length;
    const button = $('calc-git-count');
    button.textContent = n === 1 ? 'Count code lines (1 repository)' : n ? `Count code lines (${num(n)} repositories)` : 'Count code lines';
    button.disabled = !n || Boolean(git.run) || !c.open;
    const head = $('calc-git-repos').querySelector('.calc-git-repos-head span');
    if (head) head.textContent = `${num(git.repos.filter((r) => r.ticked).length)} of ${num(git.repos.length)} ticked`;
  }
  $('calc-git-paste').addEventListener('input', countLabel);
  $('calc-git-count').addEventListener('click', () => {
    const items = wanted();
    if (items.length > GIT_MAX) return setStatus('calc-git-status', `At most ${GIT_MAX} repositories a count: tick fewer, and count the rest after.`, 'error');
    startCount(items);
  });

  /** Count again: the project's repository at its latest commit, with the connection it was counted with when it is still there. */
  function countAgain(p) {
    way = 'git';
    showWay(way);
    const known = git.connections?.some((x) => x.id === p.git.connection);
    startCount([{ url: p.git.url }], { projectId: p.id, connection: known ? p.git.connection : null });
  }

  /** Start a count, then follow it: each repository becomes a project of the customer open when it started. */
  async function startCount(items, { projectId = null, connection = null } = {}) {
    if (!c.open || git.run || !items.length) return;
    let how;
    try {
      how = connection ? { connection } : access();
    } catch (error) {
      return setStatus('calc-git-status', error.message, 'error');
    }
    setStatus('calc-git-status', 'Starting the count…', 'muted');
    git.run = { id: null, customer: c.open.id, connection: how.connection ?? '', projectId, applied: new Set() };
    countLabel();
    let job;
    try {
      job = await api('/api/projections/git/count', { method: 'POST', body: JSON.stringify({ ...how, repositories: items }), quiet: true });
    } catch (error) {
      git.run = null;
      countLabel();
      if (!handleAuthLoss(error)) showError('calc-git-status', error);
      return;
    }
    git.run.id = job.id;
    setStatus('calc-git-status', '');
    followCount(job);
  }

  function followCount(job) {
    renderProgress(job);
    applyCounted(job);
    if (job.state !== 'running') return finishCount(job);
    setTimeout(async () => {
      let next;
      try {
        next = await api(`/api/projections/git/count?id=${encodeURIComponent(git.run.id)}`, { quiet: true });
      } catch (error) {
        git.run = null;
        countLabel();
        if (!handleAuthLoss(error)) showError('calc-git-status', error);
        return;
      }
      followCount(next);
    }, 1000);
  }

  /** Each repository counted: a project (the one of the same name, or the one counted again, is replaced). */
  function applyCounted(job) {
    const run = git.run;
    if (!run || !c.open || c.open.id !== run.customer) return;
    let added = 0;
    for (const r of job.repositories) {
      if (r.state !== 'done' || run.applied.has(r.url)) continue;
      run.applied.add(r.url);
      const langs = Object.fromEntries(Object.entries(r.languages ?? {}).map(([lang, v]) => [lang, v.code]));
      const from = { host: r.host, path: r.path, url: r.url, branch: r.branch, commit: r.commit, countedAt: r.countedAt, connection: run.connection };
      const same = run.projectId ? fnew().projects.find((p) => p.id === run.projectId) : fnew().projects.find((p) => String(p.name).toLowerCase() === String(r.name).toLowerCase());
      if (same) Object.assign(same, { langs, file: '', git: from, locOverride: null });
      else fnew().projects.push({ id: `new-${Date.now().toString(36)}-${run.applied.size}`, name: r.name, file: '', git: from, langs, locOverride: null, included: true, scansOverride: null, modelOverride: null });
      added += 1;
    }
    if (added) {
      saveFnew();
      renderFusionNew();
    }
  }

  function finishCount(job) {
    const run = git.run;
    git.run = null;
    countLabel();
    const done = job.repositories.filter((r) => r.state === 'done').length;
    const failed = job.repositories.length - done;
    if (run && c.open?.id !== run.customer) return toast('The count ended while another customer was open: open that customer and count again.', 'warn', 9000);
    if (!failed) setStatus('calc-git-status', done === 1 ? 'Counted: it is a project below.' : `${num(done)} counted: each is a project below.`, 'ok');
    else setStatus('calc-git-status', `${num(done)} counted, ${num(failed)} not: each says why above.`, done ? 'warn' : 'error');
  }

  /** One line a repository: waiting, fetching, counting n of m files, its lines and languages, or why not. */
  function renderProgress(job) {
    const box = $('calc-git-progress');
    const rows = job?.repositories ?? [];
    box.hidden = !rows.length;
    const out = new Set(fnew()?.leftOut ?? []);
    box.innerHTML = rows
      .map((r) => {
        const where = r.path || r.url.replace(/^https?:\/\/[^/]+\//, '');
        const tag = r.branch || r.commit ? ` <span class="calc-git-tag" translate="no">${esc([r.branch, r.commit].filter(Boolean).join(' · '))}</span>` : '';
        let state;
        if (r.state === 'done') {
          const langs = Object.keys(r.languages ?? {}).filter((lang) => !out.has(lang));
          const lines = langs.reduce((n, lang) => n + r.languages[lang].code, 0);
          state = `<span class="calc-git-state done">✓ ${esc(`${num(lines)} lines`)}${langs.length ? ` · <span translate="no">${esc(langs.slice(0, 3).join(', '))}</span>` : ''}</span>`;
        } else if (r.state === 'failed') state = `<span class="calc-git-state bad">✗ ${esc(r.error)}</span>`;
        else if (r.state === 'counting') state = `<span class="calc-git-state">${esc(`Counting… ${num(r.done)} of ${num(r.total)} files`)}</span>`;
        else if (r.state === 'fetching') state = '<span class="calc-git-state">Fetching the latest commit…</span>';
        else state = '<span class="calc-git-state">Waiting</span>';
        return `<div class="calc-git-row"><span><span translate="no">${esc(where)}</span>${tag}</span>${state}</div>`;
      })
      .join('');
  }

  /** The customer's cloc results: each file read here (nothing is sent anywhere but this customer's save). */
  const MAX_CLOC_BYTES = 50 * 1024 * 1024;
  async function readCloc(files) {
    if (!c.open || !files.length) return;
    const done = [];
    let added = 0;
    for (const file of files) {
      try {
        if (file.size > MAX_CLOC_BYTES) throw new Error(t('{0} is over 50 MB: run cloc without --by-file.').replace('{0}', file.name));
        for (const found of parseCloc(await file.text(), file.name)) {
          const same = fnew().projects.find((p) => String(p.name).toLowerCase() === String(found.name).toLowerCase());
          if (same) {
            Object.assign(same, { langs: found.langs, file: file.name, locOverride: null });
            delete same.git;
          }
          else fnew().projects.push({ id: `new-${Date.now().toString(36)}-${added}`, name: found.name, file: file.name, langs: found.langs, locOverride: null, included: true, scansOverride: null, modelOverride: null });
          added += 1;
        }
        done.push(`<span translate="no">✓ ${esc(file.name)}</span>`);
      } catch (error) {
        const message = error.notCloc ? t('{0} is not a cloc report: run cloc with --json or --csv.').replace('{0}', file.name) : error.message;
        done.push(`<span class="bad" title="${esc(message)}" translate="no">✗ ${esc(file.name)}</span>`);
        toast(message, 'bad');
      }
    }
    $('calc-cloc-files').innerHTML = done.join('');
    setStatus('calc-cloc-status', added ? `${num(added)} project(s) read.` : '');
    if (added) saveFnew();
    renderFusionNew();
  }
  $('calc-cloc-pick').addEventListener('click', () => $('calc-cloc-file').click());
  $('calc-cloc-file').addEventListener('change', (event) => {
    readCloc([...event.target.files]);
    event.target.value = '';
  });
  const drop = $('calc-cloc-drop');
  drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    drop.classList.add('drag');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('drag');
    readCloc([...(event.dataTransfer?.files ?? [])]);
  });

  $('calc-rows-more-btn').addEventListener('click', () => {
    rowsShown += ROWS_PAGE;
    renderProjects();
  });

  /** Totals and each row's figures, while something is typed (so the field keeps its place). */
  function refreshFigures() {
    const est = estimate();
    renderKpis(est);
    const byId = new Map(est.rows.map((r) => [r.id, r]));
    for (const line of $('calc-rows').querySelectorAll('tr[data-row]')) {
      const p = byId.get(line.dataset.row);
      if (!p) continue;
      line.querySelector('[data-cell="units"]').textContent = p.included && p.units ? num(p.units) : '—';
      line.querySelector('[data-cell="credits"]').textContent = p.included && p.units ? (p.credits === null ? '—' : num(p.credits, 1)) : '—';
      line.querySelector('[data-cell="from"]').textContent = FROM_LABEL[p.scansFrom] ?? '';
      line.querySelector('[data-p="scansOverride"]').placeholder = num(p.scans);
    }
  }

  const project = (el) => fusion().projects.find((p) => p.id === el.closest('tr[data-row]')?.dataset.row);

  $('calc-rows').addEventListener('input', (event) => {
    const p = project(event.target);
    const field = event.target.dataset.p;
    if (!p || !field) return;
    if (field === 'loc') {
      const typed = wholeNumber(event.target.value);
      p.locOverride = p.source !== 'manual' && typed === wholeNumber(p.loc) ? null : typed;
    } else if (field === 'scansOverride') p.scansOverride = wholeNumber(event.target.value);
    else if (field === 'name') p.name = event.target.value.trim() || 'Unnamed project';
    else return;
    refreshFigures();
    saveFusion();
  });
  $('calc-rows').addEventListener('change', (event) => {
    const p = project(event.target);
    const field = event.target.dataset.p;
    if (!p || !field) return;
    if (field === 'included') p.included = event.target.checked;
    else if (field === 'criticality') p.criticality = wholeNumber(event.target.value);
    else if (field === 'frequency') p.frequency = event.target.value;
    else if (field === 'modelOverride') p.modelOverride = event.target.value || null;
    saveFusion();
    if (['criticality', 'frequency'].includes(field)) renderRules();
    renderProjects();
  });
  $('calc-rows').addEventListener('click', (event) => {
    const p = project(event.target);
    if (!p) return;
    if (event.target.closest('[data-reset-loc]')) p.locOverride = null;
    else if (event.target.closest('[data-remove-project]')) fusion().projects = fusion().projects.filter((x) => x !== p);
    else return;
    renderRules();
    renderProjects();
    saveFusion();
  });

  const settingsChanged = () => {
    Object.assign(c.open.fusion, fusionSettings(fusion()), { projects: fusion().projects, readAt: fusion().readAt });
    saveFusion();
  };
  /** The projection period, at the top: both parts use it (as chosen, until Apply). */
  function renderHorizon() {
    const months = next().periodMonths;
    const select = $('calc-horizon');
    if (![...select.options].some((o) => Number(o.value) === months)) select.append(Object.assign(document.createElement('option'), { value: String(months), textContent: `${months} months` }));
    select.value = String(months);
  }
  $('calc-horizon').addEventListener('change', () => {
    if (!c.open) return;
    setNext({ periodMonths: wholeNumber($('calc-horizon').value) ?? 12 });
  });
  $('calc-default-scans').addEventListener('input', () => {
    fusion().defaultScans = wholeNumber($('calc-default-scans').value) ?? 0;
    settingsChanged();
    renderRules();
    refreshFigures();
  });
  $('calc-default-model').addEventListener('change', () => {
    fusion().defaultModel = $('calc-default-model').value || null;
    settingsChanged();
    renderRules();
    renderProjects();
  });
  $('calc-combine').addEventListener('change', () => {
    fusion().combine = $('calc-combine').value;
    settingsChanged();
    renderProjects();
  });

  for (const [id, attr, key] of [
    ['calc-freq', 'freq', 'byFrequency'],
    ['calc-crit', 'crit', 'byCriticality'],
  ]) {
    const update = (event, rerender) => {
      const row = event.target.closest(`tr[data-${attr}]`);
      const field = event.target.dataset.r;
      if (!row || !field) return;
      const rule = fusion()[key][row.dataset[attr]];
      rule[field] = field === 'scans' ? wholeNumber(event.target.value) : event.target.value || null;
      saveFusion();
      if (rerender) renderProjects();
      else refreshFigures();
    };
    $(id).addEventListener('input', (event) => update(event, false));
    $(id).addEventListener('change', (event) => update(event, true));
  }
  $('calc-suggest').addEventListener('click', () => {
    for (const q of FREQUENCIES) fusion().byFrequency[q.id].scans = suggestedScans(q.id, fusion().periodMonths);
    saveFusion();
    renderRules();
    renderProjects();
  });

  $('calc-models').addEventListener('input', (event) => {
    const id = event.target.closest('tr[data-model]')?.dataset.model;
    const model = fusion().models.find((m) => m.id === id);
    if (!model) return;
    if (event.target.dataset.m === 'name') model.name = event.target.value;
    if (event.target.dataset.m === 'creditsPer10k') model.creditsPer10k = amount(event.target.value);
    saveFusion();
    refreshFigures();
  });
  // A model renamed or priced: the lists that offer it follow (the table itself stays, so the next field keeps its focus).
  $('calc-models').addEventListener('change', () => {
    $('calc-default-model').innerHTML = modelOptions(fusion().defaultModel, 'No model');
    renderRules();
    renderProjects();
  });
  $('calc-models').addEventListener('click', (event) => {
    if (!event.target.closest('[data-remove-model]')) return;
    const id = event.target.closest('tr[data-model]').dataset.model;
    const f = fusion();
    f.models = f.models.filter((m) => m.id !== id);
    if (f.defaultModel === id) f.defaultModel = f.models[0]?.id ?? null;
    for (const rule of [...Object.values(f.byFrequency), ...Object.values(f.byCriticality)]) if (rule.model === id) rule.model = null;
    for (const p of f.projects) if (p.modelOverride === id) p.modelOverride = null;
    saveFusion();
    renderFusion();
  });
  $('calc-add-model').addEventListener('click', () => {
    const f = fusion();
    if (f.models.length >= 20) return;
    const id = `model-${Date.now().toString(36)}`;
    f.models.push({ id, name: '', description: '', creditsPer10k: null, source: 'manual' });
    f.defaultModel ??= id;
    saveFusion();
    renderFusion();
    $('calc-models').querySelector(`tr[data-model="${CSS.escape(id)}"] input`)?.focus();
  });

  $('calc-filter').addEventListener('input', () => {
    rowsShown = ROWS_PAGE;
    renderProjects();
  });
  for (const [id, on] of [
    ['calc-all', true],
    ['calc-none', false],
  ]) {
    $(id).addEventListener('click', () => {
      const ids = new Set(shown().map((p) => p.id));
      for (const p of fusion().projects) if (ids.has(p.id)) p.included = on;
      renderProjects();
      saveFusion();
    });
  }
  $('calc-add').addEventListener('click', () => {
    const f = fusion();
    const id = `manual-${Date.now().toString(36)}`;
    f.projects.push({ id, name: `Project ${f.projects.length + 1}`, loc: null, locOverride: null, criticality: null, frequency: '1-5-week', scansPerWeek: 0, scanCount: 0, lastScanAt: null, scanId: '', source: 'manual', included: true, scansOverride: null, modelOverride: null });
    $('calc-filter').value = '';
    renderRules();
    renderProjects();
    saveFusion();
    $('calc-rows').querySelector(`tr[data-row="${CSS.escape(id)}"] [data-p="name"]`)?.select();
  });

  // ---- Scope: which projects count, for both parts (as narrowing the Dashboard) --------------

  const splitList = (text) => String(text ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const FREQ_BOXES = FREQUENCIES.map((q) => `<label class="pill-check"><input type="checkbox" value="${q.id}" /> ${esc(q.label)}</label>`).join('');
  $('calc-scope-frequencies').innerHTML = FREQ_BOXES;
  $('calc-scope-criticalities').innerHTML = CRITICALITIES.map((k) => `<label class="pill-check"><input type="checkbox" value="${k}" /> ${k}</label>`).join('');

  /** What the scope fields show (as chosen, until Apply), and the names offered as one types (from the last read). */
  function renderScope() {
    if (!c.open) return;
    const { scope: sc, allBranches } = next();
    const projects = fusion()?.projects ?? [];
    const offer = (id, values) => {
      $(id).replaceChildren(...[...new Set(values)].filter(Boolean).sort((a, b) => a.localeCompare(b)).slice(0, 500).map((v) => Object.assign(document.createElement('option'), { value: v })));
    };
    offer('calc-scope-applications-list', projects.flatMap((p) => p.applications ?? []));
    $('calc-scope-projects-list').replaceChildren(...projects.filter((p) => p.source !== 'manual').slice(0, 5000).map((p) => Object.assign(document.createElement('option'), { value: p.name })));
    offer('calc-scope-groups-list', projects.flatMap((p) => p.groups ?? []));
    offer('calc-scope-initiators-list', projects.map((p) => p.initiator));
    drawScopeChips();
    $('calc-scope-groups').value = sc.groups.join(', ');
    $('calc-scope-names').value = sc.names.join(', ');
    $('calc-scope-initiators').value = sc.initiators.join(', ');
    for (const box of $('calc-scope-frequencies').querySelectorAll('input')) box.checked = sc.frequencies.includes(box.value);
    for (const box of $('calc-scope-criticalities').querySelectorAll('input')) box.checked = sc.criticalities.includes(Number(box.value));
    $('calc-leave-no-code').checked = sc.leaveOutNoCode;
    $('calc-leave-no-findings').checked = sc.leaveOutNoFindings;
    // Ticked: every branch (the last read's, until another is applied).
    $('calc-all-branches').checked = allBranches;
    $('calc-max-projects').value = num(sc.maxProjects);
    renderOrigins();
    renderScopeSummary();
    renderPending();
  }

  /** The projects counted now (as applied): how many, and what narrows them. */
  function renderScopeSummary() {
    const sc = scope();
    const all = (fusion()?.projects ?? []).filter((p) => p.source !== 'manual');
    const inIt = all.filter((p) => counts(p, sc)).length;
    const out = leftOutCounts(sc);
    const nameOf = new Map(all.map((p) => [p.id, p.name]));
    const parts = [
      sc.applications.length && `${sc.applications.length === 1 ? 'Application' : 'Applications'}: ${sc.applications.join(', ')}`,
      sc.projects.length && (sc.projects.length <= 3 ? `${sc.projects.length === 1 ? 'Project' : 'Projects'}: ${sc.projects.map((id) => nameOf.get(id) ?? id).join(', ')}` : `${num(sc.projects.length)} projects picked`),
      sc.groups.length && `${sc.groups.length === 1 ? 'Group' : 'Groups'}: ${sc.groups.join(', ')}`,
      sc.names.length && `Names: ${sc.names.join(', ')}`,
      sc.initiators.length && `Last scanned by: ${sc.initiators.join(', ')}`,
      sc.frequencies.length && `Scanned: ${sc.frequencies.map((id) => FREQ_LABEL[id]).join(', ')}`,
      sc.criticalities.length && `Criticality: ${sc.criticalities.join(', ')}`,
      out.noCode && `${num(out.noCode)} with no lines of code left out`,
      out.noFindings && `${num(out.noFindings)} with no open findings left out`,
      out.noOrigin && `${num(out.noOrigin)} with no scan from the scan origins chosen left out`,
    ].filter(Boolean);
    const el = $('calc-scope-summary');
    // Each part its own piece, so each is translated on its own.
    const pieces = !parts.length ? [all.length ? `All ${num(all.length)} projects` : 'All projects'] : [`${num(inIt)} of ${num(all.length)} projects`, ...parts];
    el.replaceChildren(...pieces.flatMap((text, i) => [...(i ? [' · '] : []), Object.assign(document.createElement('span'), { textContent: text })]));
    el.classList.toggle('on', parts.length > 0);
  }

  $('calc-scope-toggle').addEventListener('click', () => {
    const form = $('calc-scope-form');
    form.hidden = !form.hidden;
    $('calc-scope-toggle').setAttribute('aria-expanded', String(!form.hidden));
    if (!form.hidden) $('calc-scope-groups').focus();
  });

  // Applications and projects: chips, as on the Dashboard. A change waits for Apply.
  const scopeProjects = () => (fusion()?.projects ?? []).filter((p) => p.source !== 'manual');
  function drawScopeChips() {
    const sc = next().scope;
    const nameOf = new Map(scopeProjects().map((p) => [p.id, p.name]));
    const draw = (box, entries, kind) => {
      for (const chip of box.querySelectorAll('.scope-chip')) chip.remove();
      const input = box.querySelector('input');
      for (const [key, label] of entries) {
        const chip = document.createElement('span');
        chip.className = 'scope-chip';
        const text = Object.assign(document.createElement('span'), { textContent: label, title: label });
        text.setAttribute('translate', 'no');
        const remove = Object.assign(document.createElement('button'), { type: 'button', textContent: '×' });
        remove.setAttribute('aria-label', `Remove ${label}`);
        remove.dataset.removeScope = kind;
        remove.dataset.key = key;
        chip.append(text, remove);
        box.insertBefore(chip, input);
      }
    };
    draw($('calc-apps'), sc.applications.map((a) => [a, a]), 'applications');
    draw($('calc-projects'), sc.projects.map((id) => [id, nameOf.get(id) ?? id]), 'projects');
  }

  /** A change to the scope chosen: it waits for Apply. */
  function changeScope(change) {
    setNext({ scope: { ...next().scope, ...change } });
    drawScopeChips();
  }

  /** The application or project with exactly this name, else every one whose name contains it. */
  function pickScope(kind, text) {
    const wanted = text.trim().toLowerCase();
    if (!wanted || !c.open) return;
    const sc = next().scope;
    if (kind === 'applications') {
      const all = [...new Set(scopeProjects().flatMap((p) => p.applications ?? []))];
      const exact = all.filter((a) => a.toLowerCase() === wanted);
      const found = exact.length ? exact : all.filter((a) => a.toLowerCase().includes(wanted));
      if (!found.length) return setStatus('calc-scope-status', all.length ? `No application name contains "${text.trim()}".` : 'Read Checkmarx One first: the applications come from it.', 'error');
      changeScope({ applications: [...sc.applications, ...found] });
    } else {
      const all = scopeProjects();
      const exact = all.filter((p) => p.name.toLowerCase() === wanted);
      const found = exact.length ? exact : all.filter((p) => p.name.toLowerCase().includes(wanted));
      if (!found.length) return setStatus('calc-scope-status', all.length ? `No project name contains "${text.trim()}".` : 'Read Checkmarx One first: the projects come from it.', 'error');
      changeScope({ projects: [...sc.projects, ...found.map((p) => p.id)] });
    }
  }

  for (const [inputId, kind] of [['calc-app-input', 'applications'], ['calc-project-input', 'projects']]) {
    const input = $(inputId);
    const commit = () => {
      const value = input.value;
      input.value = '';
      pickScope(kind, value);
    };
    input.addEventListener('keydown', (event) => {
      if (['Enter', ',', 'Tab'].includes(event.key)) {
        if (!input.value.trim()) return;
        event.preventDefault();
        commit();
      } else if (event.key === 'Backspace' && !input.value && next().scope[kind].length) {
        changeScope({ [kind]: next().scope[kind].slice(0, -1) });
      }
    });
    // A suggestion picked from the list: add it at once; anything else typed is added by Apply.
    input.addEventListener('input', () => {
      const value = input.value.trim().toLowerCase();
      const exact = value && (kind === 'applications' ? scopeProjects().some((p) => (p.applications ?? []).some((a) => a.toLowerCase() === value)) : scopeProjects().some((p) => p.name.toLowerCase() === value));
      if (exact) commit();
      else renderPending();
    });
  }
  $('calc-scope-box').addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-scope]');
    if (!button || !c.open) return;
    const kind = button.dataset.removeScope;
    changeScope({ [kind]: next().scope[kind].filter((k) => k !== button.dataset.key) });
  });

  /** Use the scope: Fusion counts its projects, and triage & remediation reads their backlog (from the last read). */
  async function applyScope({ quiet = false } = {}) {
    if (!c.open) return;
    renderScopeSummary();
    rowsShown = ROWS_PAGE;
    renderRules();
    renderProjects();
    const fromTenant = tr()?.totals?.meta?.source === 'cxone';
    if (!fromTenant) {
      if (!quiet && narrowed()) setStatus('calc-scope-status', 'Fusion follows the scope. Triage & remediation comes from the two exports, which cover every project.', 'warn');
      return renderTr();
    }
    const ids = fusion().projects.filter((p) => p.source !== 'manual' && counts(p)).map((p) => p.id);
    try {
      // Only the scans from the scan origins chosen count (null: every scan).
      const series = await api('/api/projections/series', { method: 'POST', body: JSON.stringify({ projectIds: ids, engines: trEngines(), origins: scope().origins }), quiet: true });
      c.open.tr = { ...tr(), totals: series.totals, fixed: series.fixed };
      save({ tr: c.open.tr });
      if (!quiet) setStatus('calc-scope-status', `${num(ids.length)} projects counted.`, 'ok');
    } catch (error) {
      if (handleAuthLoss(error)) return;
      if (!quiet) showError('calc-scope-status', error);
    }
    renderTr();
  }

  // More filters: each change waits for Apply; Enter in a field applies.
  const readFilters = () => {
    const checked = (id) => [...$(id).querySelectorAll('input:checked')].map((box) => box.value);
    return {
      groups: splitList($('calc-scope-groups').value),
      names: splitList($('calc-scope-names').value),
      initiators: splitList($('calc-scope-initiators').value),
      frequencies: checked('calc-scope-frequencies'),
      criticalities: checked('calc-scope-criticalities').map(Number),
    };
  };
  for (const kind of ['input', 'change']) {
    $('calc-scope-form').addEventListener(kind, () => {
      if (c.open) setNext({ scope: { ...next().scope, ...readFilters() } }, { redraw: false });
    });
  }
  $('calc-scope-form').addEventListener('submit', (event) => {
    event.preventDefault();
    applyAll();
  });
  // Leave out projects with nothing to analyse.
  for (const [id, key] of [['calc-leave-no-code', 'leaveOutNoCode'], ['calc-leave-no-findings', 'leaveOutNoFindings']]) {
    $(id).addEventListener('change', (event) => {
      if (c.open) changeScope({ [key]: event.target.checked });
    });
  }
  $('calc-scope-clear').addEventListener('click', () => {
    if (!c.open) return;
    // Every project: the picks go; the leave-out options, Projects to read and the scan origins stay as they are.
    const { leaveOutNoCode, leaveOutNoFindings, maxProjects, origins } = next().scope;
    setNext({ scope: { leaveOutNoCode, leaveOutNoFindings, maxProjects, origins } });
  });

  // Every branch, and how many of the tenant's projects a read takes (10,000 unless set): both wait for Apply.
  $('calc-all-branches').addEventListener('change', (event) => {
    if (c.open) setNext({ allBranches: event.target.checked }, { redraw: false });
  });
  $('calc-max-projects').addEventListener('change', (event) => {
    if (!c.open) return;
    const typed = wholeNumber(event.target.value);
    setNext({ scope: { ...next().scope, maxProjects: typed } }, { redraw: false });
    event.target.value = num(next().scope.maxProjects);
    if (typed > MAX_PROJECTS) setStatus('calc-read-note', `At most ${num(MAX_PROJECTS)} projects are read at once.`, 'warn');
  });

  // ---- Include scans from: the scan origins whose scans count ----------------------------------

  /** Every scan origin the last read found, with its scans and projects. */
  const knownOrigins = () => originCounts(fusion()?.projects ?? []);
  /** Did the last read record where scans came from? (No read, or none recorded: no.) */
  const originsRead = () => (fusion()?.projects ?? []).some((p) => p.source !== 'manual' && p.origins);

  /** The drop-down: each scan origin, ticked when its scans count (as chosen, until Apply). */
  function renderOrigins() {
    const known = knownOrigins();
    const chosen = next().scope.origins;
    const on = (o) => !chosen || chosen.includes(o);
    const ticked = known.filter((x) => on(x.origin)).length;
    $('calc-origin-summary').textContent = !known.length ? 'Every scan origin' : ticked === known.length ? `Every scan origin (${num(known.length)})` : ticked ? `${num(ticked)} of ${num(known.length)} scan origins` : 'No scan origin';
    $('calc-origin-pick').classList.toggle('on', Boolean(chosen) && ticked < known.length);
    const menu = $('calc-origin-menu');
    if (!known.length) {
      menu.innerHTML = `<p class="hint calc-origin-none">${originsRead() || !fusion()?.projects?.length ? 'Read from Checkmarx One to see where the scans come from.' : 'The last read did not record where the scans come from: read from Checkmarx One again to choose.'}</p>`;
      return;
    }
    menu.innerHTML = `<div class="calc-origin-tools"><button type="button" class="link" data-origins="all">Select all</button><button type="button" class="link" data-origins="none">Clear</button></div>${known
      .map((x, i) => `<label class="engine-opt"><input type="checkbox" value="${esc(x.origin)}"${on(x.origin) ? ' checked' : ''} /><b>${esc(x.origin)}</b><span></span><small>${i ? `${num(x.scans)} · ${num(x.projects)}` : `${num(x.scans)} scans · ${num(x.projects)} projects`}</small></label>`)
      .join('')}`;
  }
  /** Ticked: every origin is null, so one a later read finds counts too. */
  const setOrigins = (list) => {
    const known = knownOrigins().map((x) => x.origin);
    setNext({ scope: { ...next().scope, origins: list === null || known.every((o) => list.includes(o)) ? null : list } }, { redraw: false });
    renderOrigins();
  };
  $('calc-origin-menu').addEventListener('change', () => setOrigins([...$('calc-origin-menu').querySelectorAll('input:checked')].map((box) => box.value)));
  $('calc-origin-menu').addEventListener('click', (event) => {
    const button = event.target.closest('[data-origins]');
    if (button && c.open) setOrigins(button.dataset.origins === 'all' ? null : []);
  });
  document.addEventListener('click', (event) => {
    const pick = $('calc-origin-pick');
    if (pick.open && !pick.contains(event.target)) pick.open = false;
  });

  // ---- One Apply for every setting at the top: changes wait, listed, until Apply (or Undo) ------

  /** The settings at the top as they count now. During a read, its branches are the ones taken. */
  const appliedSettings = () =>
    topSettings({ allBranches: reading.branches ? reading.branches === 'all' : tr()?.totals?.meta?.branches === 'all', fusionOn: !fusionOff(), fusionNewOn: !fnewOff(), periodMonths: horizon(), ...totals(), scope: scope() });
  /** The settings at the top as chosen: the same as applied until something is changed. */
  const next = () => (c.next ??= appliedSettings());
  /** Change what is chosen (it waits for Apply); `redraw`: put every field at the top back as chosen. */
  function setNext(change, { redraw = true } = {}) {
    c.next = topSettings({ ...next(), ...change });
    if (redraw) renderTop();
    else renderPending();
  }
  /** Every field at the top as chosen. */
  function renderTop() {
    if (!c.open) return;
    const n = next();
    $('calc-fusion-on').checked = n.fusionOn;
    $('calc-fusion-new-on').checked = n.fusionNewOn;
    $('calc-extra').value = n.extraPercent || '';
    $('calc-bundle').value = n.bundleCredits;
    renderHorizon();
    renderScope();
  }
  /** What the last read can answer: when, which branches, where it stopped, and whether it recorded scan origins. */
  const lastRead = () => {
    const meta = tr()?.totals?.meta ?? {};
    return { at: (meta.source === 'cxone' ? meta.readAt : null) ?? fusion()?.readAt ?? null, branches: meta.branches, limit: fusion()?.readLimit ?? null, origins: originsRead() };
  };
  /** What is typed in Applications or Projects and not added yet: Apply adds it. */
  const typedScope = () => [['calc-app-input', 'applications', 'Applications'], ['calc-project-input', 'projects', 'Projects']].filter(([id]) => $(id).value.trim());
  const pending = () => {
    const changes = settingChanges(appliedSettings(), next(), lastRead()).filter((x) => !offline() || !x.reads);
    for (const [, key, label] of typedScope()) if (!changes.some((x) => x.key === key)) changes.push({ key, label, reads: false });
    return changes;
  };
  /** Where each change is made, marked while it waits. */
  const MARKED = {
    allBranches: () => $('calc-all-branches').closest('label'),
    maxProjects: () => $('calc-max-projects'),
    fusionOn: () => $('calc-fusion-on').closest('label'),
    fusionNewOn: () => $('calc-fusion-new-on').closest('label'),
    origins: () => $('calc-origin-pick').querySelector('summary'),
    applications: () => $('calc-apps'),
    projects: () => $('calc-projects'),
    leaveOutNoCode: () => $('calc-leave-no-code').closest('label'),
    leaveOutNoFindings: () => $('calc-leave-no-findings').closest('label'),
    groups: () => $('calc-scope-groups'),
    names: () => $('calc-scope-names'),
    initiators: () => $('calc-scope-initiators'),
    frequencies: () => $('calc-scope-frequencies'),
    criticalities: () => $('calc-scope-criticalities'),
    periodMonths: () => $('calc-horizon').closest('.calc-sum-item'),
    extraPercent: () => $('calc-extra').closest('.calc-sum-item'),
    bundleCredits: () => $('calc-bundle').closest('.calc-sum-item'),
  };
  /** The bar that lists what waits, with Undo and Apply. */
  function renderPending() {
    const changes = c.open ? pending() : [];
    $('calc-pending').hidden = !changes.length;
    $('calc-pending-count').textContent = changes.length === 1 ? '1 change not applied yet' : `${num(changes.length)} changes not applied yet`;
    $('calc-pending-list').replaceChildren(...changes.map((x) => Object.assign(document.createElement('li'), { textContent: x.reads ? `${x.label} (reads Checkmarx One again)` : x.label })));
    const waiting = new Set(changes.map((x) => x.key));
    for (const [key, el] of Object.entries(MARKED)) el()?.classList.toggle('calc-changed', waiting.has(key));
  }

  /** Why Apply reads Checkmarx One again, asked first. */
  function readQuestion(reads, wanted) {
    const why = {
      allBranches: wanted.allBranches ? 'Every branch: the scans of every branch are read, not only each project’s primary branch.' : 'Every branch, unticked: only each project’s primary branch is read.',
      maxProjects: `Projects to read: up to ${num(wanted.scope.maxProjects)} projects, more than the last read took.`,
      origins: 'Include scans from: the last read did not record where the scans come from.',
    };
    return `Apply reads Checkmarx One again for these changes:\n\n${reads.map((x) => `• ${why[x.key]}`).join('\n')}\n\nOn a large tenant this takes a while. Read it now?`;
  }

  /**
   * Apply every change waiting at once, and work the figures out again. A change the last read cannot
   * answer reads Checkmarx One again, asked first (`read`: read anyway, without asking: Read from Checkmarx One).
   */
  async function applyAll({ read = false } = {}) {
    if (!c.open) return;
    // What is typed in Applications and Projects is added first, as Enter adds it.
    for (const [id, kind] of typedScope()) {
      const value = $(id).value;
      $(id).value = '';
      pickScope(kind, value);
    }
    const wanted = next();
    const before = appliedSettings();
    const changes = settingChanges(before, wanted, lastRead());
    const reads = offline() ? [] : changes.filter((x) => x.reads);
    if (!changes.length && !read) return renderPending();
    if (reads.length && !read && !confirm(readQuestion(reads, wanted))) return;
    if (changes.length) {
      c.open.scope = cleanScope(wanted.scope);
      fusion().periodMonths = wanted.periodMonths;
      fusion().optOut = !wanted.fusionOn;
      fnew().optOut = !wanted.fusionNewOn;
      Object.assign(c.open.fusion, fusionSettings(fusion()));
      c.open.totals = totalsSettings(wanted);
      save({ scope: c.open.scope, fusion: fusion(), fusionNew: fnew(), totals: c.open.totals });
    }
    const fresh = read || reads.length > 0;
    if (fresh) readCxOne({ branches: wanted.allBranches ? 'all' : 'primary' });
    c.next = null;
    renderTop();
    renderFusion();
    renderTr();
    // Which projects or scans count changed: the figures from the last read again (a new read does it once more).
    if (changes.some((x) => x.key !== 'maxProjects' && Object.hasOwn(before.scope, x.key))) applyScope({ quiet: fresh });
  }
  $('calc-apply').addEventListener('click', () => applyAll());
  $('calc-undo').addEventListener('click', () => {
    if (!c.open) return;
    for (const [id] of typedScope()) $(id).value = '';
    c.next = null;
    renderTop();
  });

  // ---- Reading Checkmarx One: both tabs come from the tenant's projects and their scans ----------

  // `branches`: what the read running takes ('all' or 'primary'), so Every branch is not shown as waiting meanwhile.
  const reading = { customer: null, timer: null, auto: false, waiters: [], branches: null };
  /** Resolves when the read running now has finished (true when it gave data). */
  const readFinished = () => new Promise((resolve) => reading.waiters.push(resolve));
  const settle = (ok) => {
    reading.branches = null;
    for (const resolve of reading.waiters.splice(0)) resolve(ok);
    renderPending();
  };

  function readProgress(job) {
    const running = job?.state === 'running';
    const bar = $('calc-read-progress');
    bar.hidden = !running;
    $('calc-read').disabled = running || !c.open;
    if (!running) return;
    const part = job.total ? job.done / job.total : 0;
    bar.value = Math.round(job.step === 'summaries' ? 60 + part * 40 : part * 60);
    if (job.step === 'summaries') setStatus('calc-read-note', `Reading the findings of each scan: ${num(job.done)} of ${num(job.total)}…`, 'muted');
    else if (job.total) setStatus('calc-read-note', `Reading the projects and their scans: ${num(job.done)} of ${num(job.total)}…`, 'muted');
    else setStatus('calc-read-note', 'Reading the projects…', 'muted');
  }

  /** The last read, under the button, when nothing else is said there. */
  function renderReadNote() {
    const note = $('calc-read-note');
    if (!c.open || reading.timer || ['error', 'ok', 'warn'].some((k) => note.classList.contains(k))) return;
    const at = c.open.fusion?.readAt ?? c.open.tr?.totals?.meta?.readAt;
    note.className = 'status hint';
    note.innerHTML = at ? `Last read <time translate="no">${esc(fmtDateTime(at))}</time>` : 'Not read yet';
  }

  /** Start a read (or follow the one running in this tenant), then put what it found in the customer open. */
  async function readCxOne({ auto = false, branches = next().allBranches ? 'all' : 'primary' } = {}) {
    if (!c.open || reading.timer || offline()) return;
    reading.customer = c.open.id;
    reading.auto = auto;
    reading.branches = branches;
    setStatus('calc-read-note', 'Reading the projects…', 'muted');
    try {
      // One branch per project (its primary branch) unless "Every branch" is ticked.
      readProgress(await api('/api/projections/read', { method: 'POST', body: JSON.stringify({ branches, maxProjects: readLimit(scope().maxProjects) }), quiet: true }));
      poll();
    } catch (error) {
      readProgress(null);
      settle(false);
      if (handleAuthLoss(error)) return;
      if (auto && error.status === 409) return setStatus('calc-read-note', 'Not connected to Checkmarx One: connect it under Settings, or use the two exports.', 'muted');
      showError('calc-read-note', error);
    }
  }

  function poll() {
    reading.timer = setTimeout(async () => {
      let job;
      try {
        job = await api('/api/projections/read', { quiet: true });
      } catch (error) {
        reading.timer = null;
        readProgress(null);
        settle(false);
        if (!handleAuthLoss(error)) showError('calc-read-note', error);
        return;
      }
      if (job.state === 'running') {
        readProgress(job);
        return poll();
      }
      reading.timer = null;
      readProgress(null);
      if (job.state === 'failed') {
        settle(false);
        return setStatus('calc-read-note', job.error || 'Checkmarx One could not be read.', 'error');
      }
      const blank = c.open && !c.open.tr?.totals && !c.open.fusion?.projects?.length;
      if (job.state !== 'done' || !c.open || (c.open.id !== reading.customer && !blank)) {
        settle(false);
        return renderReadNote();
      }
      applyRead(job.result);
      settle(true);
    }, 1500);
  }

  function applyRead(body) {
    const f = fusion();
    const before = new Map(f.projects.map((p) => [p.id, p]));
    const keep = (p) => ({ locOverride: before.get(p.id)?.locOverride ?? null, included: before.get(p.id)?.included ?? true, scansOverride: before.get(p.id)?.scansOverride ?? null, modelOverride: before.get(p.id)?.modelOverride ?? null });
    const read = (body.projects ?? []).map((p) => ({ ...p, ...keep(p) }));
    const ids = new Set(read.map((p) => p.id));
    const gone = f.projects.filter((p) => p.source !== 'manual' && !ids.has(p.id)).length;
    const originsBefore = new Set(knownOrigins().map((x) => x.origin));
    f.projects = [...read, ...f.projects.filter((p) => p.source === 'manual')];
    f.readAt = body.readAt;
    // Where the read stopped (Projects to read), so raising it is known to need another read.
    f.readLimit = body.limited?.limit ?? null;
    // A scan origin this read found for the first time starts ticked, here and in what waits for Apply.
    const found = knownOrigins().map((x) => x.origin).filter((o) => !originsBefore.has(o));
    const patch = { fusion: f };
    if (found.length && scope().origins) {
      c.open.scope = cleanScope({ ...scope(), origins: [...scope().origins, ...found] });
      patch.scope = c.open.scope;
    }
    if (found.length && c.next?.scope.origins) c.next = topSettings({ ...c.next, scope: { ...c.next.scope, origins: [...c.next.scope.origins, ...found] } });
    // The tenant's models replace those read before; models typed here stay. A model already here by that name
    // keeps its place (and so the projects set to it) and the credits typed for it.
    if (body.models?.length) {
      const named = (n) => String(n ?? '').trim().toLowerCase();
      const fresh = body.models.map((t) => {
        const old = f.models.find((m) => m.id === t.id || named(m.name) === named(t.name));
        return old ? { ...t, id: old.id, creditsPer10k: t.creditsPer10k ?? old.creditsPer10k, description: t.description || old.description } : t;
      });
      const taken = new Set(fresh.map((m) => m.id));
      f.models = [...fresh, ...f.models.filter((m) => m.source !== 'tenant' && !taken.has(m.id))].slice(0, 20);
      if (!f.models.some((m) => m.id === f.defaultModel)) f.defaultModel = f.models[0]?.id ?? null;
    }
    // No number set for any frequency yet: start from the scans each group runs today.
    if (FREQUENCIES.every((q) => f.byFrequency[q.id].scans === null)) for (const q of FREQUENCIES) f.byFrequency[q.id].scans = suggestedScans(q.id, f.periodMonths);
    c.remainingCredits = body.remainingCredits ?? null;
    if (body.tr?.totals && body.tr?.fixed) {
      c.open.tr = { ...tr(), totals: body.tr.totals, fixed: body.tr.fixed };
      patch.tr = c.open.tr;
      syncDraft();
    }
    save(patch);
    renderScope();
    renderTr();
    renderFusion();
    // The read counts SAST and SCA, every scan, for the whole tenant: a scope, other engines, or only some scan origins are added up from it.
    if (narrowed() || trEngines().join() !== DEFAULT_ENGINES.join() || scope().origins) applyScope({ quiet: true });
    if (!body.tr) setStatus('calc-read-note', `Read ${num(read.length)} projects from Checkmarx One; none had a scan to read the findings of.`, 'warn');
    else if (read.length === 1) setStatus('calc-read-note', 'Read 1 project and its scans from Checkmarx One.', 'ok');
    else setStatus('calc-read-note', `Read ${num(read.length)} projects and their scans from Checkmarx One.`, 'ok');
    // More projects than Projects to read: said, with how to read them all.
    if (body.limited) setStatus('calc-read-note', body.limited.total ? `Read the first ${num(body.limited.read)} of ${num(body.limited.total)} projects in Checkmarx One: set Projects to read to ${num(body.limited.total)} or more and read again to count them all.` : `Read the first ${num(body.limited.read)} projects: Checkmarx One has more. Raise Projects to read and read again to count them all.`, 'warn');
    if (!body.models?.length && !f.models.length && !fusionOff()) toast('Checkmarx One did not say which Fusion models it offers: add them under Fusion models, with their credits per 10K LOC.', 'warn', 9000);
    if (gone === 1) toast('1 project read before is no longer in Checkmarx One: it was taken off.', 'warn');
    else if (gone) toast(`${num(gone)} projects read before are no longer in Checkmarx One: they were taken off.`, 'warn');
  }

  // Read from Checkmarx One: what waits is applied first (without asking: reading is what was asked for).
  $('calc-read').addEventListener('click', () => applyAll({ read: true }));

  /** A customer with nothing read yet reads Checkmarx One by itself; a read already running is followed. */
  async function autoRead() {
    if (!c.open || reading.timer || offline()) return;
    const empty = !c.open.tr?.totals && !c.open.fusion?.projects?.length;
    let job = null;
    try {
      job = await api('/api/projections/read', { quiet: true });
    } catch {}
    if (!c.open) return;
    if (job?.state === 'running') {
      reading.customer = c.open.id;
      readProgress(job);
      return poll();
    }
    if (!empty) return;
    // A read finished in the last few minutes (for another customer, say) serves this one too.
    if (job?.state === 'done' && Date.now() - Date.parse(job.finishedAt) < 15 * 60_000) return applyRead(job.result);
    readCxOne({ auto: true });
  }

  $('calc-csv').addEventListener('click', () => {
    if (!c.open) return;
    const est = estimate();
    const models = new Map(est.settings.models.map((m) => [m.id, m]));
    const cell = (v) => {
      let text = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const rows = [
      ['Project', 'Included', 'Criticality', 'Scanned today', 'Scans in the last year', 'Lines of code', '10K units', 'Fusion scans', 'Scans set by', 'Model', 'Credits per 10K LOC', 'Credits'],
      ...sortedRows(est).map((r) => [r.name, r.included ? 'yes' : 'no', r.criticality ?? '', FREQ_LABEL[r.frequency] ?? '', r.scanCount ?? '', r.lines ?? '', r.units, r.scans, FROM_LABEL[r.scansFrom] ?? '', models.get(r.model)?.name ?? '', r.rate ?? '', r.credits ?? '']),
      [],
      ['Total', est.totals.projects, '', '', '', est.totals.lines, est.totals.units, est.totals.scans, '', '', '', est.totals.credits],
      ['Projection period (months)', est.settings.periodMonths],
    ];
    download(new Blob([rows.map((r) => r.map(cell).join(',')).join('\n')], { type: 'text/csv' }), `${String(c.open.name).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'customer'}_fusion_${new Date().toISOString().slice(0, 10)}.csv`);
  });

  // ---- Projection reports -------------------------------------------------------------------

  function download(blob, name) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  // --- Credits required: both tabs together, an extra % on top, and the bundles that buys ----------

  const totals = () => totalsSettings(c.open?.totals);

  /** The Impact tab is held back until an activation code turns it on (feature:impact): hidden, and left out of the reports. */
  function gateImpact() {
    const tab = document.querySelector('[data-ptabs="calculator"] [data-pt="impact"]');
    if (!tab) return;
    tab.hidden = !impactOn();
    if (tab.hidden && tab.classList.contains('active')) document.querySelector('[data-ptabs="calculator"] [data-pt="tr"]')?.click();
  }

  function renderSummary() {
    gateImpact();
    $('calc-pdf').hidden = !(lastMade && lastMade.customerId === c.open?.id);
    if (!c.open) return;
    const fn = fnewEstimate();
    c.fusionNewCredits = fnewCounts(fn) ? fn.totals.credits : null;
    // Fusion for the customer's projects in Checkmarx One and for its new code, together.
    const sum = creditSummary(c.trCredits, fusionTotal({ totals: { credits: c.fusionCredits } }, { totals: { credits: c.fusionNewCredits } }), totals());
    $('calc-sum-tr').textContent = num(sum.tr, 1);
    $('calc-sum-tr-split').textContent = c.trSplit ? `${num(c.trSplit.backlogCredits, 1)} backlog + ${num(c.trSplit.aheadCredits, 1)} ahead` : '';
    $('calc-sum-fusion').textContent = fusionOff() ? 'Left out' : num(c.fusionCredits, 1);
    $('calc-sum-fusion-new').textContent = fnewOff() ? 'Left out' : num(c.fusionNewCredits, 1);
    $('calc-sum-total').textContent = sum.tr === null && sum.fusion === null ? '—' : num(sum.total, 1);
    $('calc-sum-extra').textContent = sum.extra ? `Includes ${num(sum.extra, 1)} extra` : '';
    $('calc-sum-bundles').textContent = sum.total ? num(sum.bundles) : '—';
    $('calc-sum-exact').textContent = sum.total && sum.bundles !== sum.exactBundles ? `${num(sum.exactBundles, 2)}, rounded up` : '';
    renderImpact();
  }

  // --- Impact: what the triage & remediation credits give back ---------------------------------

  /** This customer's assumptions; a customer saved before the Impact tab starts from Settings → Impact. */
  const impact = () => impactSettings(c.open?.impact ?? {}, impactSettings(c.impactDefaults ?? {}));
  const IMPACT_FIELDS = {
    'calc-imp-triage': 'triageMinutes', 'calc-imp-fix': 'fixMinutes', 'calc-imp-review': 'reviewMinutes', 'calc-imp-rate': 'hourlyRate', 'calc-imp-price': 'creditPrice', 'calc-imp-currency': 'currency',
    'calc-imp-lph': 'linesPerHour', 'calc-imp-reviewers': 'reviewers', 'calc-imp-later': 'laterFixMultiplier', 'calc-imp-chance': 'breachChancePercent', 'calc-imp-breach': 'breachCost',
  };

  function fillImpact() {
    const s = impact();
    for (const [id, key] of Object.entries(IMPACT_FIELDS)) {
      const v = s[key];
      if (key === 'currency' && ![...$(id).options].some((o) => o.value === v)) $(id).add(new Option(v, v));
      $(id).value = key === 'currency' ? v : key === 'hourlyRate' || key === 'creditPrice' ? (v || '') : v;
    }
    $('calc-imp-count').checked = s.countBreach;
  }

  const money = (n, currency) => {
    if (n === null || n === undefined || !Number.isFinite(n)) return '—';
    try {
      return n.toLocaleString(undefined, { style: 'currency', currency, maximumFractionDigits: 0 });
    } catch {
      return `${num(n)} ${currency}`;
    }
  };

  /** The impact of the projection on the Triage & remediation tab, with these assumptions. */
  function currentImpact() {
    const t = trFigures();
    return t ? trImpact(t.projection.rows, t.projection.months, impact()) : null;
  }

  /** Fusion's impact: the projects counted on the Fusion tab, and what Fusion adds to triage & remediation. */
  function currentFusionImpact() {
    const est = estimate();
    const fn = fnewEstimate();
    const parts = [fusionCounts(est) && est, fnewCounts(fn) && fn].filter(Boolean);
    if (!parts.length) return null;
    return fusionImpact(parts.flatMap((x) => x.rows), parts.reduce((n, x) => n + x.totals.credits, 0), est.settings.periodMonths, impact(), trFigures()?.projection.rows ?? null);
  }

  function renderImpact() {
    if (!c.open) return;
    const m = currentImpact();
    $('calc-impact-empty').hidden = Boolean(m);
    // In the reader's language here (the same words as the report), as the figures sit inside the sentences.
    const L = wording({ t, lang: currentLanguage() });
    const { w } = L;
    renderFusionImpact(L);
    renderOverallImpact(L, m);
    if (!m) {
      $('calc-impact-kpis').innerHTML = '';
      $('calc-impact-rows').innerHTML = '';
      $('calc-impact-how').innerHTML = `<h2>${w('How each number is calculated')}</h2>${fusionImpactSections(currentFusionImpact(), L).map((x) => `<h3>${x.title}</h3>${sectionHtml(x)}`).join('')}`;
      return;
    }
    const cur = m.settings.currency;
    const cash = (n) => esc(money(n, cur));
    const kpi = (label, value, sub, cls = '') => `<div class="rp-kpi ${cls}"><span class="rp-tile-label">${label}</span><span class="rp-kpi-value">${value}</span><span class="rp-tile-sub">${sub}</span></div>`;
    $('calc-impact-kpis').innerHTML = [
      kpi(w('Hours given back'), num(m.hours), w('About {0} developer-years over {1} months', num(m.developerYears, 1), num(m.months)), 'calc-gold'),
      kpi(w('Value of that time'), cash(m.value), m.value === null ? w('Enter what a developer\'s hour costs') : w('{0} hours × {1}', num(m.hours), cash(m.settings.hourlyRate))),
      kpi(w('What the credits cost'), cash(m.cost), m.cost === null ? w('Enter what a credit costs') : w('{0} credits', num(m.credits, 1))),
      kpi(w('Return'), m.roi === null ? '—' : `${num(m.roi * 100)}%`, m.net === null ? w('Once the hour and the credit have a price') : `${w('{0} net', cash(m.net))}${m.paybackMonths !== null ? ` · ${w('paid back in {0} months', num(m.paybackMonths, 1))}` : ''}`),
      kpi(w('False positives cleared'), num(m.cleared), w('Never reach a developer')),
    ].join('');
    const SEV = { Critical: 'Critical', High: 'High', Medium: 'Medium', Low: 'Low' };
    $('calc-impact-rows').innerHTML = m.bySeverity
      .filter((r) => r.triaged || r.fixes)
      .map((r) => `<tr><td>${w(SEV[r.severity])}</td><td class="num">${num(r.triaged)}</td><td class="num">${num(r.cleared)}</td><td class="num">${num(r.fixes)}</td><td class="num">${num(r.hours)}</td><td class="num">${num(r.credits, 1)}</td></tr>`)
      .join('') + `<tr class="calc-total"><td>${w('Total')}</td><td class="num">${num(m.triaged)}</td><td class="num">${num(m.cleared)}</td><td class="num">${num(m.fixes)}</td><td class="num">${num(m.hours)}</td><td class="num">${num(m.credits, 1)}</td></tr>`;
    $('calc-impact-how').innerHTML = `<h2>${w('How each number is calculated')}</h2>${[...impactSections(m, L), ...fusionImpactSections(currentFusionImpact(), L)].map((x) => `<h3>${x.title}</h3>${sectionHtml(x)}`).join('')}`;
  }

  const kpiTile = (label, value, sub, cls = '') => `<div class="rp-kpi ${cls}"><span class="rp-tile-label">${label}</span><span class="rp-kpi-value">${value}</span><span class="rp-tile-sub">${sub}</span></div>`;

  function renderFusionImpact(L) {
    const f = currentFusionImpact();
    const { w } = L;
    $('calc-impact-fusion-empty').hidden = Boolean(f);
    $('calc-impact-fusion-empty').textContent = fusionOff() ? 'Fusion for the existing customer is left out of this projection: tick Add Fusion: Existing customer at the top to count it.' : 'No Fusion projects yet: add them, with their lines of code, on the Fusion tabs.';
    if (!f) return ($('calc-impact-fusion').innerHTML = '');
    const cash = (n) => esc(money(n, f.settings.currency));
    $('calc-impact-fusion').innerHTML = [
      kpiTile(w('Expert review replaced'), `${num(f.expertHours)} ${w('hours')}`, f.expertValue === null ? w('{0} lines read at {1} an hour', num(f.linesRead), num(f.settings.linesPerHour)) : w('Worth {0}', cash(f.expertValue)), 'calc-gold'),
      kpiTile(w('Every line read'), w('{0} times', num(f.timesRead, 1)), w('{0} lines in {1} projects, over {2} months', num(f.linesOnce), num(f.projects), num(f.months))),
      kpiTile(w('Cost per 10K lines read'), f.costPer10k === null ? '—' : cash(f.costPer10k), f.expertPer10k === null ? w('Enter what a developer\'s hour costs') : w('An expert: {0}', cash(f.expertPer10k))),
      kpiTile(w('Reviewers to keep pace'), num(f.reviewersNeeded, 1), w('Full-time, reading what Fusion reads')),
      kpiTile(w('A team reading it once'), w('{0} weeks', num(f.teamWeeks, 1)), w('{0} reviewers, 40 hours a week', num(f.settings.reviewers))),
      f.extraTrue !== null ? kpiTile(w('Found earlier, fixed cheaper'), f.earlyValue === null ? `${num(f.earlyHours)} ${w('hours')}` : cash(f.earlyValue), w('{0} more true positives fixed while coding, not after release', num(f.extraTrue))) : '',
      f.breachAvoided !== null ? kpiTile(w('Breach cost avoided'), cash(f.breachAvoided), f.settings.countBreach ? w('{0} critical and high found earlier; counted in the return', num(f.extraCriticalHigh)) : w('{0} critical and high found earlier; an expected cost, not counted', num(f.extraCriticalHigh))) : '',
    ].join('');
  }

  function renderOverallImpact(L, tr) {
    const o = overallImpact(tr, currentFusionImpact());
    const { w } = L;
    if (!o) return ($('calc-impact-overall').innerHTML = '');
    const cash = (n) => esc(money(n, o.currency));
    $('calc-impact-overall').innerHTML = [
      kpiTile(w('All the credits give back'), o.value === null ? `${num(o.hours)} ${w('hours')}` : cash(o.value), w('Triage & remediation and Fusion, over {0} months', num(o.months)), 'calc-gold'),
      kpiTile(w('What the credits cost'), cash(o.cost), o.cost === null ? w('Enter what a credit costs') : w('Every credit in this projection')),
      kpiTile(w('Return'), o.roi === null ? '—' : `${num(o.roi * 100)}%`, o.net === null ? w('Once the hour and the credit have a price') : `${w('{0} net', cash(o.net))}${o.paybackMonths !== null ? ` · ${w('paid back in {0} months', num(o.paybackMonths, 1))}` : ''}`),
    ].join('');
  }

  $('calc-imp-count').addEventListener('change', (event) => {
    if (!c.open) return;
    c.open.impact = impactSettings({ ...impact(), countBreach: event.target.checked }, impact());
    renderImpact();
    save({ impact: c.open.impact });
  });
  for (const [id, key] of Object.entries(IMPACT_FIELDS)) {
    $(id).addEventListener('input', (event) => {
      if (!c.open) return;
      c.open.impact = impactSettings({ ...impact(), [key]: key === 'currency' ? event.target.value : event.target.value === '' && (key === 'hourlyRate' || key === 'creditPrice') ? 0 : event.target.value }, impact());
      renderImpact();
      save({ impact: c.open.impact });
    });
  }

  // The extra % and the credits per bundle wait for Apply too.
  $('calc-extra').addEventListener('input', (event) => c.open && setNext({ extraPercent: event.target.value }, { redraw: false }));
  $('calc-bundle').addEventListener('input', (event) => c.open && setNext({ bundleCredits: event.target.value }, { redraw: false }));
  $('calc-extra').addEventListener('change', (event) => (event.target.value = next().extraPercent || ''));
  $('calc-bundle').addEventListener('change', (event) => (event.target.value = next().bundleCredits));

  /** Everything a report shows, as figures: what the server keeps, and the file is built from. */
  function reportData() {
    const t = trFigures();
    const est = estimate();
    const fusionCounted = fusionCounts(est);
    const fn = fnewEstimate();
    const fnCounted = fnewCounts(fn);
    const who = me()?.user;
    const summary = creditSummary(t ? t.projection.totals.credits : null, fusionTotal(fusionCounted ? est : null, fnCounted ? fn : null), totals());
    const meta = tr()?.totals?.meta ?? {};
    const sc = scope();
    return {
      version: 2,
      summary,
      organisation: me()?.organisationName ?? '',
      customer: c.open.name,
      preparedBy: who?.name || who?.email || '',
      generatedAt: new Date().toISOString(),
      months: horizon(),
      source: {
        kind: meta.source === 'cxone' ? 'cxone' : t ? 'upload' : fusion().readAt ? 'cxone' : 'manual',
        readAt: meta.readAt ?? fusion().readAt ?? null,
        projects: est.rows.filter((r) => r.source !== 'manual').length,
        allProjects: fusion().projects.filter((p) => p.source !== 'manual').length,
        scans: meta.scans ?? null,
        // Read from Checkmarx One: the engines whose findings the projection counts ([] = every engine).
        ...(meta.source === 'cxone' ? { engines: meta.engineSplit === false ? [] : cleanEngines(meta.engines) } : {}),
        scoped: scopeActive(sc),
        scope: sc,
        // Read from Checkmarx One: one branch per project, or every branch; and the projects left out as having nothing to analyse.
        ...(meta.source === 'cxone' && meta.branches ? { branches: meta.branches } : {}),
        leftOut: leftOutCounts(sc),
        projectNames: sc.projects.map((id) => fusion().projects.find((p) => p.id === id)?.name ?? id),
        // Not every scan origin: those whose scans were counted (Fusion only, when the backlog came from the two exports).
        ...(() => {
          const known = knownOrigins().map((x) => x.origin);
          if (!sc.origins || !known.length) return {};
          return { origins: known.filter((o) => sc.origins.includes(o)), ...(t && meta.source !== 'cxone' ? { originsFusionOnly: true } : {}) };
        })(),
      },
      tr: t
        ? {
            ...trData(t),
            monthlyChange: t.analysis.monthlyChange,
            history: t.analysis.history.map((h) => ({ month: h.month })),
            weekly: t.weekly,
            forecast: t.forecast,
            bySeverity: t.bySeverity,
          }
        : null,
      // What the triage & remediation credits give back, with this customer's assumptions.
      impact: (() => {
        if (!impactOn()) return null;
        const trI = t ? trImpact(t.projection.rows, t.projection.months, impact()) : null;
        const fuI = currentFusionImpact();
        return trI || fuI ? { tr: trI, fusion: fuI, overall: overallImpact(trI, fuI) } : null;
      })(),
      fusion: fusionCounted
        ? {
            periodMonths: est.settings.periodMonths,
            defaultScans: est.settings.defaultScans,
            defaultModel: est.settings.defaultModel,
            models: est.settings.models,
            rules: est.settings.byFrequency,
            byFrequency: est.byFrequency,
            byModel: est.byModel,
            totals: est.totals,
            remainingCredits: c.remainingCredits,
            rows: est.rows.map((r) => ({ name: r.name, included: r.included, criticality: r.criticality, frequency: r.frequency, scansPerWeek: r.scansPerWeek, lines: r.lines, units: r.units, scans: r.scans, scansFrom: r.scansFrom, model: r.model, credits: r.credits })),
          }
        : null,
      // Fusion for the customer's new code (not in Checkmarx One yet), its lines counted with cloc.
      fusionNew: fnCounted
        ? {
            periodMonths: fn.settings.periodMonths,
            defaultScans: fn.settings.defaultScans,
            defaultModel: fn.settings.defaultModel,
            models: fn.settings.models,
            leftOut: fn.settings.leftOut,
            byModel: fn.byModel,
            totals: fn.totals,
            rows: fn.rows.map((r) => ({ name: r.name, file: r.file, included: r.included, lines: r.lines, units: r.units, scans: r.scans, scansFrom: r.scansFrom, model: r.model, credits: r.credits, languages: r.languages.filter((l) => l.counted && l.lines > 0).slice(0, 6) })),
          }
        : null,
    };
  }

  const hasData = () => Boolean(c.open?.tr?.totals || c.open?.fusion?.projects?.length || c.open?.fusionNew?.projects?.length);

  /**
   * One click: read Checkmarx One first when nothing is read yet (or follow the read running), then
   * make the report with every default in place. Returns the report and its file, or null.
   */
  async function generate({ download: save = true } = {}) {
    if (!c.open) return null;
    await flush();
    if (!offline() && (reading.timer || !hasData())) {
      const done = readFinished();
      if (!reading.timer) readCxOne();
      setStatus('calc-read-note', 'Reading Checkmarx One first, then the report is made…', 'muted');
      await done;
      await flush();
    }
    const data = reportData();
    if (!data.tr && !data.fusion) {
      toast(offline() ? 'Nothing to report yet: drop the two Checkmarx One exports below (or load the sample data), or add Fusion projects first.' : 'Nothing to report yet: read Checkmarx One (or use the two exports), or add Fusion projects first.', 'warn');
      return null;
    }
    try {
      const { report } = await api('/api/projections/reports', { method: 'POST', body: JSON.stringify({ customerId: c.open.id, data }) });
      const html = reportHtml(data, report.createdAt);
      if (save) download(new Blob([html], { type: 'text/html' }), reportFileName(report.customer, report.createdAt));
      // Once the report is made, its three-page PDF summary can be downloaded too.
      lastMade = { customerId: c.open.id, report, data };
      $('calc-pdf').hidden = false;
      loadReports();
      return { report, html, data };
    } catch (error) {
      if (!handleAuthLoss(error)) toast(error.message, 'bad');
      return null;
    }
  }
  $('calc-generate').addEventListener('click', () => generate());

  /** The three-page PDF summary of a generated report, drawn here in the page's language. */
  async function downloadPdf(report, data = report.data) {
    const button = $('calc-pdf');
    button.disabled = true;
    try {
      // The appendix of calculations only when asked for (unticked unless the reader ticks it).
      const pdf = await slidesPdf({ ...data, generatedAt: report.createdAt }, { t, lang: currentLanguage(), dir: RTL.has(currentLanguage()) ? 'rtl' : 'ltr', look: appLook(), calculations: $('calc-pdf-calculations').checked });
      download(pdf, slidesFileName(report.customer, report.createdAt));
      window.mzReportActivity?.('event', 'Downloaded the calculator PDF summary');
    } catch (error) {
      toast(`The PDF could not be made: ${error.message}`, 'bad');
    } finally {
      button.disabled = false;
    }
  }
  $('calc-pdf').addEventListener('click', () => lastMade && downloadPdf(lastMade.report, lastMade.data));

  // Email: the report is made (as with Generate) and sent as a file, in the page's language.
  $('calc-email-open').addEventListener('click', () => {
    const form = $('calc-email-form');
    form.hidden = !form.hidden;
    $('calc-email-open').setAttribute('aria-expanded', String(!form.hidden));
    setStatus('calc-email-status', '');
    if (!form.hidden) $('calc-email-to').focus();
  });
  $('calc-email-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const to = $('calc-email-to').value.split(/[\s,;]+/).map((a) => a.trim()).filter(Boolean);
    if (!to.length) return setStatus('calc-email-status', 'Type at least one email address.', 'error');
    setStatus('calc-email-status', 'Making the report…', 'muted');
    const made = await generate({ download: false });
    if (!made) return setStatus('calc-email-status', '');
    const sum = made.data.summary;
    const lines = [
      t('{0}: Checkmarx credits projection').replace('{0}', made.report.customer),
      t('Total credits required: {0} ({1} bundles of {2}), over {3} months.').replace('{0}', num(sum.total, 1)).replace('{1}', num(sum.bundles)).replace('{2}', num(sum.settings.bundleCredits)).replace('{3}', num(made.data.months)),
      t('The full projection is attached: open it in any browser.'),
    ];
    try {
      const body = await api(`/api/projections/reports/${encodeURIComponent(made.report.id)}/email`, { method: 'POST', body: JSON.stringify({ to, html: made.html, subject: lines[0], lines: lines.slice(1) }) });
      setStatus('calc-email-status', body.sent === 1 ? 'Sent to 1 address.' : `Sent to ${num(body.sent)} addresses.`, 'ok');
    } catch (error) {
      if (!handleAuthLoss(error)) showError('calc-email-status', error);
    }
  });

  // Start again: every choice made for this customer goes back to the defaults, and Checkmarx One is read again.
  $('calc-restart').addEventListener('click', async () => {
    if (!c.open) return;
    const again = offline() ? 'and the two exports are cleared' : 'and Checkmarx One is read again';
    if (!confirm(`Start again for ${c.open.name}?\n\nEvery choice made here goes back to the defaults (the projects narrowed, the plan, the Fusion numbers, the extra credits), ${again}. The Fusion models and their credits stay. Reports already made are kept.`)) return;
    const models = fusion().models;
    c.open.scope = cleanScope({});
    c.open.tr = { totals: null, fixed: null, selected: Object.fromEntries(SEVERITIES.map((s) => [s, null])), triageCost: { ...DEFAULT_TR.triageCost }, fpPercent: { ...DEFAULT_TR.fpPercent }, remediationCost: { ...DEFAULT_TR.remediationCost }, lookbackMonths: DEFAULT_TR.lookbackMonths, ...aheadSettings({}) };
    c.open.fusion = { ...fusionSettings({ models, defaultModel: models[0]?.id }), projects: [], readAt: null };
    c.open.totals = totalsSettings({});
    save({ scope: c.open.scope, tr: c.open.tr, fusion: c.open.fusion, totals: c.open.totals });
    show(c.open);
    readCxOne();
  });

  async function loadReports() {
    if (!c.open && $('calc-reports-mine').checked) {
      c.reports = [];
      return renderReports();
    }
    try {
      const mine = $('calc-reports-mine').checked;
      c.reports = (await api(`/api/projections/reports${mine && c.open ? `?customer=${encodeURIComponent(c.open.id)}` : ''}`, { quiet: true })).reports ?? [];
    } catch (error) {
      if (handleAuthLoss(error)) return;
      c.reports = [];
    }
    renderReports();
  }

  function renderReports() {
    $('calc-reports-empty').hidden = c.reports.length > 0;
    $('calc-reports').innerHTML = c.reports
      .map(
        (r) => `<tr data-report="${esc(r.id)}">
        <td translate="no">${esc(r.customer)}</td>
        <td><time translate="no">${esc(fmtDateTime(r.createdAt))}</time></td>
        <td translate="no">${esc(r.createdBy)}</td>
        <td class="num">${r.trCredits === null ? '—' : num(r.trCredits, 1)}</td>
        <td class="num">${r.fusionCredits === null ? '—' : num(r.fusionCredits, 1)}</td>
        <td class="num">${r.extraPercent ? `${num(r.extraPercent, 2)}%` : '—'}</td>
        <td class="num"><b>${num(r.totalCredits, 1)}</b></td>
        <td class="num">${r.bundles === undefined ? '—' : num(r.bundles)}</td>
        <td><button type="button" class="secondary" data-download>Download</button> <button type="button" class="ghost" data-pdf>PDF</button> ${can('reports.delete') ? '<button type="button" class="ghost calc-remove" data-delete-report>Delete</button>' : ''}</td></tr>`,
      )
      .join('');
  }

  $('calc-reports-mine').addEventListener('change', loadReports);
  $('calc-reports').addEventListener('click', async (event) => {
    const id = event.target.closest('tr[data-report]')?.dataset.report;
    if (!id) return;
    try {
      if (event.target.closest('[data-download]')) {
        const { report } = await api(`/api/projections/reports/${encodeURIComponent(id)}`, { quiet: true });
        download(new Blob([reportHtml(report.data, report.createdAt)], { type: 'text/html' }), reportFileName(report.customer, report.createdAt));
      } else if (event.target.closest('[data-pdf]')) {
        const { report } = await api(`/api/projections/reports/${encodeURIComponent(id)}`, { quiet: true });
        await downloadPdf(report);
      } else if (event.target.closest('[data-delete-report]')) {
        if (!confirm('Delete this projection report? It cannot be undone.')) return;
        await api(`/api/projections/reports/${encodeURIComponent(id)}`, { method: 'DELETE' });
        loadReports();
      }
    } catch (error) {
      if (!handleAuthLoss(error)) toast(error.message, 'bad');
    }
  });

  gateImpact();
  return { load, renderOrg, refresh: () => c.open && show(c.open), autoRead };
}

