// Cx Credits Calculator (#/calculator): customers, each with a triage & remediation projection
// (two Checkmarx One exports and a plan per severity) and a Fusion projection (how many Fusion
// scans each project needs, and what they cost), and the projection reports made from them.
// Saved on the server as you go (src/projections.js). The arithmetic is model.js; the charts
// charts.js; the downloaded report report.js.

import {
  BUNDLE_CREDITS,
  CRITICALITIES,
  DEFAULT_TR,
  FREQUENCIES,
  LOOKBACKS,
  MAX_PROJECTS,
  SEVERITIES,
  aheadMonths,
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
  parseClocFusionReport,
  MAX_CLOC_FUSION_BYTES,
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
import { PAGE_PALETTE, SEVERITY_COLOURS, barChart, debtFixChart, donutChart, forecastChart, lineChart, severityCharts } from './charts.js';
import { buildReport, reportFileName, wording } from './report.js';
import { leverData, leverInputs, recentRates } from './levers.js';
import { slidesFileName, slidesPdf } from './slides.js';
import { allSections, fusionImpactSections, impactSections, sectionHtml } from './explain.js';
import { cleanFusionNew } from './profiles.js';
import { RTL, currentLanguage, t } from '../i18n.js';
import { DEFAULT_ENGINES, ENGINES, cleanEngines } from '../engines.js';
import { nextSpeedster } from '../speedsters.js';

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
  // The script a report carries for its levers (report-live.js, bundled): in the standalone files, kept in
  // the page; on the server, asked for once. Without it (or for a report made before the levers) the report has none.
  let runtime = null;
  const runtimeReady = () => {
    runtime ??= (async () => {
      const kept = document.getElementById('cx-report-runtime');
      return kept ? JSON.parse(kept.textContent) : api('/api/projections/report-runtime', { quiet: true });
    })().catch(() => (runtime = null));
    return runtime;
  };
  /** The report's own phrases in the page's language: those translated, for its script to write them again. */
  const reportWords = (phrases = []) => (currentLanguage() === 'en' ? {} : Object.fromEntries(phrases.map((p) => [p, t(p)]).filter(([en, out]) => out && out !== en)));
  /** The report's file, in the page's language: with its levers when its data keeps them. */
  const reportHtml = async (data, generatedAt) => {
    const view = { t, lang: currentLanguage(), dir: RTL.has(currentLanguage()) ? 'rtl' : 'ltr', look: appLook() };
    const script = data.levers ? await runtimeReady() : null;
    if (!script) return buildReport({ ...data, generatedAt }, view);
    const { levers, summary, tr, fusion, ...rest } = data;
    const base = { ...rest, generatedAt, tr: null, fusion: null, impact: data.impact ? true : null };
    const now = leverData(base, levers);
    return buildReport(now, { ...view, live: { inputs: levers, sentInputs: levers, sentTotal: creditSummary(now.tr?.totals?.credits ?? null, fusionTotal(now.fusion, now.fusionNew), now.summary?.settings).total, base, words: reportWords(script.phrases), runtime: { text: script.text, hash: script.hash } } });
  };
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
    // No customer yet (the first visit, a fresh download, or the last one deleted): one is made straight away,
    // in the organisation's name when it is known, so the page is never left with everything switched off.
    await create().catch((error) => handleAuthLoss(error) || toast(error.message, 'bad'));
  }

  function renderCustomers() {
    $('calc-empty').hidden = c.customers.length > 0;
    $('calc-customer').innerHTML = c.customers.map((x) => `<option value="${esc(x.id)}"${x.id === c.open?.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
    // The Customer ▾ menu: the saved customers (the one open ticked, each with when it was saved), then New, Rename, Delete.
    $('calc-cust-current').textContent = c.open?.name ?? (c.customers.length ? 'Choose a customer' : 'None yet');
    $('calc-cust-list').innerHTML = c.customers
      .map((x) => `<button type="button" class="calc-cust-item${x.id === c.open?.id ? ' on' : ''}" role="menuitemradio" aria-checked="${x.id === c.open?.id}" data-customer="${esc(x.id)}"><span translate="no">${esc(x.name)}</span>${x.updatedAt ? `<small>saved ${savedAt(x.updatedAt)}</small>` : ''}</button>`)
      .join('');
    $('calc-cust-list').hidden = !c.customers.length;
    const named = c.open ? `“${c.open.name}”` : '';
    $('calc-rename').textContent = c.open ? `Rename ${named}…` : 'Rename…';
    $('calc-delete').textContent = c.open ? `Delete ${named}…` : 'Delete…';
    for (const id of ['calc-rename', 'calc-customer', 'calc-name', 'calc-delete', 'calc-generate', 'calc-extra', 'calc-bundle', 'calc-bundle-q', 'calc-horizon', 'calc-email-open', 'calc-restart', 'calc-scope-toggle', 'calc-scope-clear', 'calc-app-input', 'calc-project-input', 'calc-leave-no-code', 'calc-leave-no-findings', 'calc-all-branches', 'calc-max-projects']) $(id).disabled = !c.open;
  }

  function renderOrg() {
    const org = me()?.organisationName;
    // A customer still under its made-up name ("Customer 1") takes the organisation's name as it is typed;
    // a name someone chose is never replaced.
    const name = String(org ?? '').trim();
    if (name && c.open && /^Customer \d+$/.test(c.open.name) && !c.customers.some((x) => x.id !== c.open.id && x.name.toLowerCase() === name.toLowerCase())) {
      c.open.name = name;
      c.customers = c.customers.map((x) => (x.id === c.open.id ? { ...x, name } : x));
      save({ name });
      renderCustomers();
    }
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
    // Leaving a customer that was filling in as the projects came in: it keeps what it had, and gets the read when it ends only if still open.
    if (reading.stream && c.open?.id === reading.customer && customer?.id !== reading.customer) {
      leaveStream();
      reading.stream = false;
      if (c.pending?.id === reading.customer) flush();
    }
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
    // Folded to one line once the customer has figures (from Checkmarx One or the exports); open only for a customer with none and no tenant to read.
    $('calc-alt').open = offline() && !customer.tr?.totals;
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
    // A customer filling in as Checkmarx One is read is saved when the read ends, with every project (settle).
    if (reading.stream && job.id === reading.customer) return void saved('Saved when the read is done', null, 'muted');
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

  // ---- The Customer ▾ menu ----------------------------------------------------------------
  const custMenu = $('calc-cust-menu');
  const custBtn = $('calc-cust-btn');
  function custMenuOpen(on) {
    custMenu.hidden = !on;
    custBtn.setAttribute('aria-expanded', String(on));
    if (on) (custMenu.querySelector('.calc-cust-item.on') ?? custMenu.querySelector('button:not([disabled])'))?.focus();
  }
  custBtn.addEventListener('click', () => custMenuOpen(custMenu.hidden));
  custMenu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-customer]');
    if (!item) return;
    custMenuOpen(false);
    if (item.dataset.customer === c.open?.id) return;
    $('calc-customer').value = item.dataset.customer;
    $('calc-customer').dispatchEvent(new Event('change'));
  });
  // New, Rename and Delete close the menu first; their own handlers below do the work.
  for (const id of ['calc-new', 'calc-rename', 'calc-delete']) $(id).addEventListener('click', () => custMenuOpen(false), { capture: true });
  document.addEventListener('click', (event) => {
    if (!custMenu.hidden && !event.target.closest('.calc-cust-pick')) custMenuOpen(false);
  });
  custMenu.addEventListener('keydown', (event) => {
    const items = [...custMenu.querySelectorAll('button:not([disabled])')];
    const at = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { custMenuOpen(false); custBtn.focus(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    }
  });
  /** Rename: the name field shows beside the menu; Enter or leaving it puts it away. */
  function renameOpen(on) {
    $('calc-rename-field').hidden = !on;
    if (on) {
      $('calc-name').value = c.open?.name ?? '';
      $('calc-name').focus();
      $('calc-name').select();
    }
  }
  $('calc-rename').addEventListener('click', () => c.open && renameOpen(true));
  $('calc-name').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); renameOpen(false); custBtn.focus(); }
  });
  $('calc-name').addEventListener('blur', () => renameOpen(false));

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
      renameOpen(true);
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
    else await create().catch((error) => handleAuthLoss(error) || toast(error.message, 'bad'));
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
      sast,
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
    document.body.classList.toggle('calc-presenting-on', c.present);
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
          ${step('Still to come', num(P.future), !A.includeFuture ? 'not counted' : A.newPacePercent === 100 ? `${num(P.arrivals)} a month × ${num(projection.paced, 1)} months` : `${num(P.arrivals)} a month × ${num(aheadMonths(projection.months, A.aiDeclinePercent), 1)} months × ${num(A.newPacePercent)}%`, '', 'future')}
          <span class="calc-op" aria-hidden="true">+</span>
          ${step('More found by Fusion', num(P.fusionExtra), projection.fusion ? (projection.sastOnly ? `${num(A.fusionUpliftPercent)}% more SAST findings` : tr().totals?.meta?.source === 'cxone' ? `${num(A.fusionUpliftPercent)}% more findings · read again for SAST only` : `${num(A.fusionUpliftPercent)}% more findings · the exports count every engine`) : fusionOff() ? '0% · Fusion left out' : 'Fusion not in the projection', '', 'fusion')}
          <span class="calc-op" aria-hidden="true">=</span>
          ${step('To triage', num(P.toTriage), `${num(P.truePositives)} to remediate`, 'calc-step-key', 'triage')}
          <span class="calc-op" aria-hidden="true">→</span>
          ${step('Credits', num(P.credits, 1), `${num(P.backlogCredits, 1)} backlog + ${num(P.aheadCredits, 1)} ahead`, 'calc-step-gold', 'credits')}
        </div>
        <div class="calc-assume calc-edit">
          <label class="check"><input type="checkbox" data-ahead="includeFuture"${A.includeFuture ? ' checked' : ''} /> Count findings still to come</label>
          <label class="calc-assume-num"><span>New findings counted (%)</span><input type="text" inputmode="decimal" class="calc-num" data-ahead="newPacePercent" value="${esc(A.newPacePercent)}"${A.includeFuture ? '' : ' disabled'} /></label>
          <label class="calc-assume-num"><span>AI adoption: fewer new findings over a year (%)</span><input type="text" inputmode="decimal" class="calc-num" data-ahead="aiDeclinePercent" value="${esc(A.aiDeclinePercent)}" /></label>
          <label class="calc-assume-num"${fusionOff() ? ' title="Fusion for the existing customer is left out of this projection: tick Add Fusion: Existing customer at the top to count it."' : ''}><span>More found by Fusion (%)</span><input type="text" inputmode="decimal" class="calc-num" data-ahead="fusionUpliftPercent" value="${esc(fusionOff() ? 0 : A.fusionUpliftPercent)}"${fusionOff() ? ' disabled' : ''} /></label>
          <button type="button" class="link" data-ahead-reset>Defaults</button>
        </div>
        ${A.includeFuture ? `<p class="hint calc-pace-note"><b>New findings counted</b>: 100% counts as many new findings a month as the last ${num(tr().lookbackMonths)} months had (${num(P.arrivals)} a month), 50% half as many, 0% none. Lower it when the customer expects fewer new findings, raise it when more code or projects are coming.</p>` : ''}
      </section>
      <details class="panel calc-edit calc-custom" open>
        <summary><h2>Customize per severity</h2><span class="hint">How many of the backlog to triage, the false positives expected, and the credits each step takes. Everything starts from the defaults.</span></summary>
        <div class="calc-sev-grid">${SEVERITIES.map((s) => {
          const d = c.draft[s];
          const open = analysis.perSeverity[s].current;
          const chosen = d.selected === null || d.selected === undefined ? open : Math.min(d.selected, open);
          return `<div class="calc-sev-box" data-sev="${s}">
            <div class="calc-sev-top"><span class="calc-sev"><i translate="no" style="background:${SEVERITY_COLOURS[s]}"></i>${s}</span><span class="hint">${num(open)} open</span></div>
            <input type="range" min="0" max="${esc(open)}" value="${esc(chosen)}" data-f="selected" aria-label="${s}: to triage" style="--p:${fill(chosen, open)}%" />
            <div class="calc-row"><input type="number" min="0" max="${esc(open)}" value="${esc(chosen)}" data-f="selected" aria-label="${s}: to triage" />
              <span><button type="button" class="ghost small-btn" data-set="0">None</button><button type="button" class="ghost small-btn" data-set="all">All</button></span></div>
            <label class="calc-row"><span>Credits per triage</span><input type="number" min="0" step="0.5" value="${esc(d.triageCost)}" data-f="triageCost" /></label>
            <label class="calc-row"><span>False positives %</span><input type="number" min="0" max="100" step="1" value="${esc(d.fpPercent)}" data-f="fpPercent" /></label>
            <label class="calc-row"><span>Credits per remediation</span><input type="number" min="0" step="0.5" value="${esc(d.remediationCost)}" data-f="remediationCost" /></label>
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
      </section>
      ${byProjectSeverity()}`;
  }

  /** The consolidated backlog by project and severity (from Read from Checkmarx One); empty without per-project data. */
  function byProjectSeverity() {
    const rows = (fusion()?.projects ?? [])
      .filter((p) => p.source !== 'manual' && p.openBySeverity)
      .map((p) => ({ name: p.name, sev: p.openBySeverity, total: SEVERITIES.reduce((n, s) => n + (p.openBySeverity[s] ?? 0), 0) }))
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    if (!rows.length) return '';
    const tot = Object.fromEntries(SEVERITIES.map((s) => [s, rows.reduce((n, r) => n + (r.sev[s] ?? 0), 0)]));
    const grand = rows.reduce((n, r) => n + r.total, 0);
    const head = (s) => `<th class="num"><span class="calc-sev"><i translate="no" style="background:${SEVERITY_COLOURS[s]}"></i>${s}</span></th>`;
    return `
      <details class="panel calc-fold calc-byproject" open>
        <summary><h2>Open vulnerabilities by project</h2><span class="hint">Consolidated backlog</span></summary>
        <p class="hint">${num(rows.length)} projects, ${num(grand)} open findings now, by severity, from each project's latest scan read from Checkmarx One.</p>
        <div class="table-wrap"><table class="data-table calc-byproject-table">
          <thead><tr><th>Project</th>${SEVERITIES.map(head).join('')}<th class="num">Total</th></tr></thead>
          <tbody>${rows.map((r) => `<tr><td translate="no">${esc(r.name)}</td>${SEVERITIES.map((s) => `<td class="num">${num(r.sev[s] ?? 0)}</td>`).join('')}<td class="num calc-total">${num(r.total)}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td>All projects</td>${SEVERITIES.map((s) => `<td class="num">${num(tot[s])}</td>`).join('')}<td class="num calc-total">${num(grand)}</td></tr></tfoot>
        </table></div>
      </details>`;
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
  const WHY = { backlog: ['backlog'], future: ['future'], fusion: ['fusion'], triage: ['triage', 'remediate'], credits: ['credits'], 'fusion-credits': ['fusion-credits', 'fusion-new-credits'], total: ['total'] };
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
    // The summary's Fusion is both customers': with only the new customer's counted, the existing one's "not in this projection" is left out.
    const sections = allSections(data, L).filter((x) => WHY[button.dataset.why]?.includes(x.key) && !(x.key === 'fusion-credits' && !data.fusion && data.fusionNew));
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
    const button = event.target.closest('.calc-why[data-why]');
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
      c.open.tr = { ...tr(), includeFuture: DEFAULT_TR.includeFuture, fusionUpliftPercent: DEFAULT_TR.fusionUpliftPercent, aiDeclinePercent: DEFAULT_TR.aiDeclinePercent, newPacePercent: DEFAULT_TR.newPacePercent };
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
    // The default model is the one the projects use unless a rule says otherwise: marked, and named when it has no price.
    modelsWarn();
    $('calc-models').innerHTML = f.models
      .map(
        (m) => `<tr data-model="${esc(m.id)}"${m.id === f.defaultModel ? ' class="calc-model-default"' : ''}>
        <td>${m.source === 'tenant' || m.source === 'catalog'
          ? `<span class="calc-model-name" translate="no">${esc(m.name)}</span> <span class="calc-badge">${m.source === 'tenant' ? 'From Checkmarx One' : 'Checkmarx One model'}</span>${m.id === f.defaultModel ? ' <span class="calc-badge calc-badge-default">Default · used by the projects</span>' : ''}${m.description ? `<small class="hint" translate="no">${esc(m.description)}</small>` : ''}`
          : `<input type="text" value="${esc(m.name)}" maxlength="80" data-m="name" aria-label="Model name" translate="no" placeholder="Type the model's name, as Checkmarx One shows it" />`}</td>
        <td><input type="text" inputmode="decimal" class="calc-num" value="${esc(m.creditsPer10k ?? '')}" data-m="creditsPer10k" aria-label="Credits per 10K LOC" placeholder="${esc(m.id === f.defaultModel ? 'Price needed' : 'Credits')}" /></td>
        <td><button type="button" class="ghost calc-remove" data-remove-model>Remove</button></td></tr>`,
      )
      .join('');
  }

  /** Said when the default model, the one the projects use, has no price: the reason Fusion credits stay 0. */
  function modelsWarn() {
    const f = fusion();
    const def = f.models.find((m) => m.id === f.defaultModel);
    const unpriced = def && !(Number(def.creditsPer10k) > 0);
    $('calc-models-warn').hidden = !unpriced;
    if (unpriced) $('calc-models-warn').innerHTML = `<b translate="no">${esc(def.name)}</b> is the default model, used by the projects, and has no price yet: type its credits per 10K LOC, or Fusion credits stay 0.`;
  }

  function renderRules() {
    const f = fusion();
    const rows = scoped();
    const ruleRow = (key, label, count, rule, attr) => `<tr ${attr}="${key}">
      <td>${label}</td><td class="num">${num(count)}</td>
      <td><input type="text" inputmode="numeric" class="calc-num" value="${esc(rule.scans ?? '')}" data-r="scans" placeholder="${esc(num(f.defaultScans))} (default)" aria-label="Fusion scans per project" /></td>
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
      kpi('10K-LOC blocks', num(t.units), `${num(t.lines)} lines, each project rounded up`),
      kpi('Fusion scans', num(t.scans), `Over ${num(est.settings.periodMonths)} months`),
      kpi('Credits', num(t.credits, 1), t.unknownRate ? `<span class="calc-warn">Projects whose model has no credits per 10K LOC: ${num(t.unknownRate)}</span>` : `Over ${num(est.settings.periodMonths)} months`, 'calc-gold'),
      c.remainingCredits !== null ? kpi('Credits remaining in the tenant', num(c.remainingCredits), c.remainingCredits >= t.credits ? 'Enough for this projection' : `<span class="calc-warn">Short by ${num(t.credits - c.remainingCredits, 1)}</span>`) : '',
    ].join('');
  }

  function rowHtml(p) {
    const manual = p.source === 'manual';
    const scanned = wholeNumber(p.loc);
    const changed = !manual && wholeNumber(p.locOverride) !== null && wholeNumber(p.locOverride) !== scanned;
    return `<tr data-row="${esc(p.id)}" data-source="${esc(p.source ?? 'git')}" class="${p.included ? '' : 'calc-off'}">
      <td><input type="checkbox" data-p="included"${p.included ? ' checked' : ''} aria-label="Include ${esc(p.name)}" /></td>
      <td>${manual ? `<span class="calc-name-cell"><input type="text" data-p="name" value="${esc(p.name)}" maxlength="200" aria-label="Project name" translate="no" /><button type="button" class="ghost calc-remove" data-remove-project>Remove</button></span>` : `<span translate="no">${esc(p.name)}</span>`}</td>
      <td>${manual ? `<select data-p="criticality" aria-label="Criticality"><option value="">—</option>${CRITICALITIES.map((k) => `<option${p.criticality === k ? ' selected' : ''}>${k}</option>`).join('')}</select>` : p.criticality ?? '—'}</td>
      <td>${manual ? `<select data-p="frequency" aria-label="How often it is scanned">${FREQUENCIES.map((q) => `<option value="${q.id}"${p.frequency === q.id ? ' selected' : ''}>${esc(q.label)}</option>`).join('')}</select>` : `${esc(FREQ_LABEL[p.frequency] ?? '—')}${p.scanCount ? `<small class="hint">${num(p.scanCount)} scans in a year</small>` : ''}`}</td>
      <td><input type="text" inputmode="numeric" class="calc-num" data-p="loc" value="${esc(p.lines ?? '')}" placeholder="${scanned === null ? 'Type them' : ''}" aria-label="Lines of code of ${esc(p.name)}" title="${esc(SOURCE_LABEL[p.source] ?? '')}" />${changed ? `<small class="hint">Scan counted ${num(scanned)} <button type="button" class="link" data-reset-loc>Use it</button></small>` : ''}</td>
      <td class="num" data-cell="units">${p.included && p.units ? num(p.units) : '—'}</td>
      <td><input type="text" inputmode="numeric" class="calc-num" data-p="scansOverride" value="${esc(p.scansOverride ?? '')}" placeholder="${esc(num(p.scans))}" aria-label="Fusion scans for ${esc(p.name)}" /><small class="hint" data-cell="from">${esc(FROM_LABEL[p.scansFrom] ?? '')}</small></td>
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
  $('calc-fusion-on').addEventListener('change', (event) => { if (!c.open) return; setNext({ fusionOn: event.target.checked }, { redraw: false }); });
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

  // Where a project's Fusion scans came from, on this tab.
  const FROM_NEW = { default: 'Default', frequency: 'Change frequency', criticality: 'Criticality', project: 'Set here' };

  /** Where a project's lines came from: "git · main · 3f2a1c9" (and Count again), "cloc-fusion · report.json", "cloc · payments-api.json", or typed. */
  function fnewFromHtml(p) {
    const again = p.git && gitOn() ? ' <button type="button" class="link" data-fnew-recount>Count again</button>' : '';
    const where = p.git ? `${p.git.host}/${p.git.path}${p.git.countedAt ? ` · ${fmtDateTime(p.git.countedAt)}` : ''}` : '';
    if (p.activity?.engine === 'report') return `<span class="calc-git-tag" translate="no"${where ? ` title="${esc(where)}"` : ''}>${esc(`cloc-fusion · ${p.file || 'report'}`)}</span>${again}`;
    if (p.git) return `<span class="calc-git-tag" translate="no" title="${esc(where)}">${esc([p.activity?.engine === 'api' ? 'api' : 'git', p.git.branch, p.git.commit].filter(Boolean).join(' · '))}</span>${again}`;
    return p.file ? `<span class="calc-git-tag" translate="no">${esc(`cloc · ${p.file}`)}</span>` : '—';
  }

  /** How often it changes: the bucket, its commits in the window, and its last commit. */
  function fnewFrequencyHtml(p) {
    if (!p.frequency) return '—';
    const a = p.activity ?? {};
    const last = a.lastCommitAt ? `<small>Last commit <time datetime="${esc(a.lastCommitAt)}" translate="no">${esc(new Date(a.lastCommitAt).toLocaleDateString())}</time></small>` : '';
    const devs = p.devs90 === null || p.devs90 === undefined ? '' : `<small>${esc(`${num(p.devs90)} developers in the last 90 days`)}</small>`;
    return `<span class="calc-freq">${esc(FREQ_LABEL[p.frequency] ?? '—')}<small>${esc(`${num(a.commits)} commits in ${num(a.windowDays)} days`)}</small>${devs}${last}</span>`;
  }

  function fnewRowHtml(p, colourOf) {
    const counted = p.languages.filter((l) => l.counted && l.lines > 0);
    const left = p.languages.filter((l) => !l.counted).reduce((n, l) => n + l.lines, 0);
    const total = counted.reduce((n, l) => n + l.lines, 0) || 1;
    const typed = wholeNumber(p.locOverride) !== null;
    const countedBy = p.activity?.engine === 'report' ? 'cloc-fusion counted' : p.git ? 'Counted from git' : 'cloc counted';
    return `<tr data-row="${esc(p.id)}" class="${p.included ? '' : 'calc-off'}">
      <td><input type="checkbox" data-n="included"${p.included ? ' checked' : ''} aria-label="Include ${esc(p.name)}" /></td>
      <td><span class="calc-name-cell"><input type="text" data-n="name" value="${esc(p.name)}" maxlength="200" aria-label="Project name" translate="no" /><button type="button" class="ghost calc-remove" data-remove-fnew>Remove</button></span></td>
      <td class="calc-from">${fnewFromHtml(p)}</td>
      <td>${counted.length || left
        ? `<span class="calc-lang-line" translate="no">${counted.slice(0, 3).map((l) => `${esc(l.name)} ${Math.round((l.lines / total) * 100)}%`).join(' · ')}${counted.length > 3 ? ` · +${counted.length - 3}` : ''}</span>${left ? `<span class="calc-lang-line">${esc(`${num(left)} lines not counted`)}</span>` : ''}<span class="calc-lang-bar">${counted.map((l) => `<i style="width:${((l.lines / total) * 100).toFixed(2)}%;background:${colourOf(l.name)}" title="${esc(`${l.name}: ${num(l.lines)}`)}"></i>`).join('')}</span>`
        : '—'}</td>
      <td><input type="text" inputmode="numeric" class="calc-num" data-n="loc" value="${esc(typed ? p.locOverride : p.lines ?? '')}" placeholder="Type them" aria-label="Lines of code of ${esc(p.name)}" /><small class="hint calc-units">10K-LOC blocks <b data-cell="units">${p.included && p.units ? num(p.units) : '—'}</b></small>${typed && p.languages.length ? `<small class="hint">${countedBy} ${num(newCustomerEstimate({ ...fnew(), projects: [{ ...p, locOverride: null }] }, fusion()).rows[0]?.lines)} <button type="button" class="link" data-fnew-reset>Use it</button></small>` : ''}</td>
      <td>${fnewFrequencyHtml(p)}</td>
      <td><input type="text" inputmode="numeric" class="calc-num" data-n="scansOverride" value="${esc(p.scansOverride ?? '')}" placeholder="${esc(num(p.scans))}" aria-label="Fusion scans for ${esc(p.name)}" /><span class="calc-scans-from" data-cell="from">${esc(FROM_NEW[p.scansFrom] ?? '')}</span></td>
      <td><select data-n="modelOverride" aria-label="Model for ${esc(p.name)}">${modelOptions(p.modelOverride, 'Automatic')}</select></td>
      <td class="num" data-cell="credits">${p.included && p.units ? (p.credits === null ? '—' : num(p.credits, 1)) : '—'}</td>
    </tr>`;
  }

  const fnewKpi = (label, value, sub, cls = '') => `<div class="rp-kpi ${cls}"><span class="rp-tile-label">${esc(label)}</span><span class="rp-kpi-value">${value}</span><span class="rp-tile-sub">${sub}</span></div>`;

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
    $('calc-fnew-kpis').innerHTML = f.projects.length
      ? [
          fnewKpi('Projects', num(tot.projects), tot.unknownLines ? `<span class="calc-warn">Still without lines of code: ${num(tot.unknownLines)}</span>` : 'Included, with lines of code'),
          fnewKpi('10K-LOC blocks', num(tot.units), `${num(tot.lines)} code lines, each project rounded up`),
          fnewKpi('Fusion scans', num(tot.scans), tot.withActivity ? esc(`Over ${num(est.settings.periodMonths)} months · ${num(tot.byRule)} by change frequency`) : `Over ${num(est.settings.periodMonths)} months`),
          fnewKpi('Credits', num(tot.credits, 1), tot.unknownRate ? `<span class="calc-warn">Projects whose model has no credits per 10K LOC: ${num(tot.unknownRate)}</span>` : `Over ${num(est.settings.periodMonths)} months`, 'calc-gold'),
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
      line.querySelector('[data-cell="from"]').textContent = FROM_NEW[p.scansFrom] ?? '';
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

  /**
   * A repository measured (from git, or a cloc-fusion report) as a project: the one of the same repository is
   * replaced (or `projectId`'s, counted again); one with no repository, of the same name, too. Two repositories of
   * the same name in different places keep their paths as names. Returns the project.
   */
  function upsertMeasured(found, { projectId = null, key = '' } = {}) {
    const list = fnew().projects;
    const url = found.git?.url ? cleanUrl(found.git.url) : '';
    const sameName = (p) => String(p.name).toLowerCase() === String(found.name).toLowerCase();
    let same = projectId ? list.find((p) => p.id === projectId) : null;
    same ??= url ? list.find((p) => p.git?.url && cleanUrl(p.git.url) === url) : null;
    same ??= list.find((p) => (found.git ? !p.git : true) && sameName(p));
    const taken = list.some((p) => p !== same && sameName(p));
    const name = same?.name ?? (taken && found.path ? found.path : found.name);
    const patch = { name, langs: found.langs, file: found.file ?? '', locOverride: found.locOverride ?? null, ...(found.activity ? { activity: found.activity } : {}), ...(found.criticality ? { criticality: found.criticality } : {}) };
    if (found.git) patch.git = found.git;
    if (same) {
      if (!found.git) delete same.git;
      if (!found.activity) delete same.activity;
      Object.assign(same, patch, found.scansOverride !== null && found.scansOverride !== undefined ? { scansOverride: found.scansOverride } : {}, found.modelOverride ? { modelOverride: found.modelOverride } : {});
      return same;
    }
    const made = { id: `new-${Date.now().toString(36)}-${key || list.length}`, ...patch, included: true, scansOverride: found.scansOverride ?? null, modelOverride: found.modelOverride ?? null };
    list.push(made);
    return made;
  }
  const cleanUrl = (u) => String(u).replace(/(\.git)?\/*$/i, '').toLowerCase();

  // ---- Count from git, with cloc-fusion's engine (src/fusion-git.js): discover, pick, measure ----------
  // On the server, or in the launcher on its own computer; the HTML file on its own can reach no git host.

  const gitOn = () => !standalone || canGit();
  const WAY_STORE = 'mz-calc-fnew-way';
  const WAYS = ['git', 'report', 'cloc'];
  const GIT_ADDRESS = { github: 'https://github.com', gitlab: 'https://gitlab.com', azure: 'https://dev.azure.com/your-organisation', bitbucket: 'https://bitbucket.org' };
  // The Admin's connections (id, host, provider: never a token), the sources ticked, the organizations found,
  // the repositories listed, and the run going.
  const git = { connections: null, limit: 1000, chosen: null, orgs: {}, repos: [], run: null, filter: '' };
  let way = (() => {
    try {
      const saved = localStorage.getItem(WAY_STORE);
      return WAYS.includes(saved) ? saved : 'git';
    } catch {
      return 'git';
    }
  })();
  const bytes = (b) => (b >= 1024 ** 3 ? `${num(b / 1024 ** 3, 1)} GB` : b >= 1024 ** 2 ? `${num(b / 1024 ** 2)} MB` : `${num(Math.max(1, b / 1024))} KB`);

  /** Count from git, Import a cloc-fusion report or Upload cloc results: one shown at a time. */
  function showWay(pick) {
    const on = gitOn();
    const shown = WAYS.includes(pick) ? pick : 'git';
    for (const input of document.querySelectorAll('input[name="calc-fnew-way"]')) input.checked = input.value === shown;
    $('calc-git').hidden = shown !== 'git';
    $('calc-cf').hidden = shown !== 'report';
    $('calc-cloc').hidden = shown !== 'cloc';
    // The HTML file on its own: Count from git says it cannot, and points to cloc-fusion.
    $('calc-git-offline').hidden = on;
    $('calc-git-steps').hidden = !on || git.stepsFolded === true;
    // How the server measures: not said where nothing is measured.
    $('calc-git-how').hidden = !on;
    for (const id of ['calc-git-progress', 'calc-git-summary']) if (!on) $(id).hidden = true;
    if (shown === 'git' && on) loadConnections();
  }
  $('calc-fnew-ways').addEventListener('change', (event) => {
    if (event.target.name !== 'calc-fnew-way') return;
    way = WAYS.includes(event.target.value) ? event.target.value : 'git';
    try {
      localStorage.setItem(WAY_STORE, way);
    } catch {}
    showWay(way);
  });

  /** Fusion's parts, each in a tab of its own now: both always drawn, the tabs show one at a time. */
  const showFsub = () => {
    for (const box of document.querySelectorAll('#page-calculator .calc-fsub')) box.hidden = false;
  };
  showFsub();

  // ---- The three Fusion tabs: Checkmarx One, from Git, cloc-fusion; one estimate in the credits ---------
  const BASES = {
    cxone: { tab: 'fusion', kick: 'Fusion · existing customer', title: 'From Checkmarx One projects', short: 'Checkmarx One', what: 'projects' },
    git: { tab: 'fusion-git', kick: 'Fusion · from Git', title: 'From code counted in git', short: 'from Git', what: 'repositories' },
    cloc: { tab: 'fusion-cloc', kick: 'Fusion · cloc-fusion', title: 'From a cloc-fusion report or cloc results', short: 'cloc-fusion', what: 'repositories' },
  };
  /** The estimate in the credits: one of the three, or none. A customer saved with both parts on counts both until one is chosen. */
  function basis() {
    if (!c.open) return 'none';
    const cx = !fusionOff();
    const nw = !fnewOff();
    if (cx && nw) return 'both';
    if (cx) return 'cxone';
    if (nw) return fnew().basis ?? 'git';
    return 'none';
  }
  /** Every estimate, worked out whichever is chosen, so each tab can show its own and the others beside it. */
  function estimates() {
    const cx = fusionEstimate(scoped(), { ...fusion(), optOut: false }).totals;
    const one = (b) => newCustomerEstimate({ ...fnew(), basis: b, optOut: false }, fusion()).totals;
    return { cxone: cx, git: one('git'), cloc: one('cloc') };
  }
  /** Use one estimate (or none) in the credits: at once, as picking it is the whole change. */
  function useBasis(b, { byHand = true } = {}) {
    if (!c.open) return;
    fnew().basisByHand = byHand;
    if (b === 'git' || b === 'cloc') fnew().basis = b;
    fusion().optOut = b !== 'cxone';
    fnew().optOut = !(b === 'git' || b === 'cloc');
    if (c.next) Object.assign(c.next, { fusionOn: b === 'cxone', fusionNewOn: b === 'git' || b === 'cloc' });
    saveFusion();
    saveFnew();
    renderFusion();
    renderFusionNew();
    renderTr();
    renderPending();
    renderSummary();
    placeFusion();
  }
  const credits = (t) => (t && t.projects ? num(Math.round(t.credits)) : '—');
  /**
   * Until one is picked by hand, the estimate predicting the most credits is the one in them (the most 10K-LOC blocks
   * while no model has a price). True when it changed the one in use (and drew everything again).
   */
  let autoPicking = false;
  function autoBasis(all = estimates()) {
    if (!c.open || autoPicking || fnew().basisByHand) return false;
    const order = Object.keys(BASES).filter((k) => all[k].projects);
    if (!order.length) return false;
    const best = order.reduce((a, k) => (all[k].credits > all[a].credits || (all[k].credits === all[a].credits && all[k].units > all[a].units) ? k : a));
    if (best === basis()) return false;
    autoPicking = true;
    try {
      useBasis(best, { byHand: false });
    } finally {
      autoPicking = false;
    }
    return true;
  }
  function renderBasis() {
    if (!c.open) return;
    const all = estimates();
    if (autoBasis(all)) return;
    const view = document.querySelector('#page-calculator [data-ptpanel^="calculator:fusion-"]:not([hidden])')?.dataset.ptpanel.split(':')[1];
    const shownRows = fnewEstimate().rows.filter((r) => (view === 'fusion-cloc' ? r.source === 'cloc' : r.source === 'git'));
    $('calc-fnew-log-count').textContent = shownRows.length ? `(${num(shownRows.length)})` : '(none yet)';
    const used = basis();
    const months = horizon();
    // Repositories git (or cloc-fusion) counted that are not projects in Checkmarx One yet: by name.
    const inCx = new Set(scoped().map((p) => String(p.name ?? '').toLowerCase().split('/').pop()));
    const notInCx = (b) => fnewEstimate().rows.filter((r) => r.source === b && r.included && !inCx.has(String(r.name ?? '').toLowerCase().split('/').pop()));
    for (const [b, d] of Object.entries(BASES)) {
      const box = $(`calc-fh-${d.tab}`);
      if (!box) continue;
      const t = all[b];
      const on = used === b || (used === 'both' && b === 'cxone');
      const connection = b === 'cxone'
        ? (tr()?.totals?.meta?.source === 'cxone' || scoped().length ? `<span class="calc-fh-pill ok">Read from Checkmarx One · ${num(scoped().length)} projects</span>` : '<span class="calc-fh-pill">Not read yet: connect the key at the top and Read from Checkmarx One</span>')
        : b === 'git'
          ? (t.projects ? `<span class="calc-fh-pill ok">Counted from git · ${num(t.projects)} repositories</span>` : '<span class="calc-fh-pill">Nothing counted yet: give a token below and count the repositories</span>')
          : (t.projects ? `<span class="calc-fh-pill ok">Imported · ${num(t.projects)} repositories</span>` : '<span class="calc-fh-pill">Nothing imported yet: download cloc-fusion, send it to the customer, import the report they send back</span>');
      const facts = t.projects
        ? `<span><b>${num(t.projects)}</b> ${d.what}</span><span><b>${num(t.lines)}</b> lines of code</span><span><b>${num(t.units)}</b> 10K-LOC blocks</span><span><b>${num(t.scans)}</b> Fusion scans</span><span class="hint">${b === 'cxone' ? 'scans from how often each project was scanned in the last 12 months' : 'scans from the commits on each default branch'}</span>`
        : '';
      const others = Object.entries(BASES).filter(([k]) => k !== b && all[k].projects).map(([k, o]) => `<div class="calc-fh-alt">${esc(o.short)}: ${credits(all[k])}${used === k ? ' · <b>in use</b>' : ` · <button type="button" class="link" data-use-basis="${esc(k)}">use instead</button>`}</div>`).join('');
      const extra = b !== 'cxone' && scoped().length && notInCx(b).length ? `<div class="calc-fh-foot">${num(notInCx(b).length)} of these repositories are not projects in Checkmarx One yet (matched by name).</div>` : '';
      const both = used === 'both' && b !== 'git' && b !== 'cloc' ? '' : '';
      box.innerHTML = `
        <div class="calc-fh-main">
          <div class="calc-fh-kick calc-fh-${b}">${esc(d.kick)}</div>
          <h2>${esc(d.title)}</h2>
          <div class="calc-fh-conn">${connection}</div>
          ${facts ? `<div class="calc-fh-facts">${facts}</div>` : ''}
        </div>
        <div class="calc-fh-side">
          <div class="calc-fh-credits"><b>${credits(t)}</b><span>credits over ${num(months)} months</span></div>
          ${on ? `<span class="calc-fh-used">✓ Used in the credits</span>${fnew().basisByHand ? '' : '<span class="calc-fh-auto">the highest estimate, picked by itself</span>'}` : `<button type="button" class="primary" data-use-basis="${esc(b)}"${t.projects ? '' : ' disabled'}>${used === 'none' ? 'Use this' : 'Use this instead'}</button>`}
          ${others}
          ${used === 'none' ? '<div class="calc-fh-alt"><b>Fusion is left out</b></div>' : '<button type="button" class="link calc-fh-out" data-use-basis="none">Leave Fusion out</button>'}
        </div>
        ${used === 'both' ? `<div class="calc-fh-foot">Both Checkmarx One and the counted code are in the credits (saved that way before). Pick one with <b>Use this instead</b>, so no code is counted twice.</div>` : ''}${extra}${both}`;
    }
  }
  document.getElementById('page-calculator').addEventListener('click', (event) => {
    const pick = event.target.closest('[data-use-basis]');
    if (pick && !pick.disabled) useBasis(pick.dataset.useBasis);
  });

  /** The parts the three Fusion tabs share (visuals, pricing, the counted code) go to the tab in view. */
  function placeFusion() {
    const panel = [...document.querySelectorAll('#page-calculator [data-ptpanel^="calculator:fusion"]')].find((x) => !x.hidden);
    if (!panel) return;
    const view = panel.dataset.ptpanel.split(':')[1];
    const slot = panel.querySelector('.calc-fslot');
    // The visuals draw the estimate in the credits: shown on that estimate's tab only.
    const viz = $('calc-fusion-viz-panel');
    const mine = { fusion: 'cxone', 'fusion-git': 'git', 'fusion-cloc': 'cloc' }[view];
    const inUse = basis();
    viz?.classList.toggle('calc-viz-elsewhere', !(inUse === mine || (inUse === 'both' && mine === 'cxone')));
    const parts = [viz, $('calc-fusion-pricing')];
    const counted = document.querySelector('#page-calculator .calc-fsub[data-fsub="new"]');
    if (view === 'fusion') {
      slot.append(...parts.filter(Boolean));
      // The tiles go back to their place among the counted code's settings.
      const kpis = $('calc-fnew-kpis');
      const home = $('calc-fnew-log');
      if (kpis && home && kpis.nextElementSibling !== home) home.before(kpis);
    }
    else {
      slot.append(...parts.filter(Boolean), counted);
      // The tiles (repositories, lines, developers, scans) lead the tab, under its header.
      const kpis = $('calc-fnew-kpis');
      if (kpis) slot.prepend(kpis);
      // Git: count from git only. cloc-fusion: its report, or cloc results.
      for (const label of document.querySelectorAll('#calc-fnew-ways .mode')) {
        const v = label.querySelector('input')?.value;
        label.hidden = view === 'fusion-git' ? true : v === 'git';
      }
      $('calc-fnew-ways').hidden = view === 'fusion-git';
      if (view === 'fusion-git') showWay('git');
      else if (way === 'git' || !['report', 'cloc'].includes(document.querySelector('input[name="calc-fnew-way"]:checked')?.value)) showWay('report');
    }
    panel.classList.toggle('calc-fview-new', view !== 'fusion');
    panel.dataset.fview = view;
    renderBasis();
  }
  for (const panel of document.querySelectorAll('#page-calculator [data-ptpanel^="calculator:fusion"]')) new MutationObserver(placeFusion).observe(panel, { attributes: true, attributeFilter: ['hidden'] });

  /** The Admin's git connections, once: each one a choice in step 1, beside a token typed for one run. */
  async function loadConnections() {
    if (git.connections) return;
    git.connections = [];
    try {
      const found = await api('/api/projections/git/connections', { quiet: true });
      git.connections = found.connections ?? [];
      git.limit = wholeNumber(found.limits?.repositories) || git.limit;
      if (found.clocFusion?.version) $('calc-cf-sum').textContent = `cloc-fusion ${found.clocFusion.version} · SHA-256 ${found.clocFusion.sha256}`;
    } catch (error) {
      if (handleAuthLoss(error)) return;
    }
    renderHosts();
  }

  const chosenSources = () => [...$('calc-git-hosts').querySelectorAll('input:checked')].map((i) => i.value);
  function renderHosts() {
    const list = git.connections ?? [];
    git.chosen ??= new Set(list.length ? [list[0].id] : ['token']);
    $('calc-git-hosts').innerHTML = [
      ...list.map((x, i) => `<label class="calc-git-host"><input type="checkbox" name="calc-git-host" value="${esc(x.id)}"${git.chosen.has(x.id) ? ' checked' : ''} /><span><b translate="no">${esc(`${x.label} · ${x.host}${x.owner ? ` · ${x.owner}` : ''}`)}</b><small>${i === 0 ? 'A git connection the Admin already set up (the same tokens as Code authors). Nothing to type.' : 'Another git connection the Admin set up.'}</small></span></label>`),
      `<label class="calc-git-host"><input type="checkbox" name="calc-git-host" value="token"${git.chosen.has('token') ? ' checked' : ''} /><span><b>Git tokens for this run only (one or more)</b><small>${standalone ? 'The customer’s own read-only token: git on this computer fetches the code and counts it here.' : 'The customer’s own read-only token, for a host connected or allowed by the Admin.'}</small></span></label>`,
    ].join('');
    hostChanged();
  }

  function hostChanged() {
    git.chosen = new Set(chosenSources());
    $('calc-git-token').hidden = !git.chosen.has('token');
    $('calc-git-address').placeholder = GIT_ADDRESS[$('calc-git-provider').value];
    countLabel();
  }
  const hostSwitched = () => {
    git.repos = [];
    git.orgs = {};
    renderOrgs();
    renderRepos();
    hostChanged();
  };
  $('calc-git-hosts').addEventListener('change', hostSwitched);
  $('calc-git-provider').addEventListener('change', hostSwitched);

  // ---- Several git tokens, one per platform or organisation: kept in this page's memory only, never saved ----
  git.tokens = [];
  const PROVIDER_NAMES = { github: 'GitHub', gitlab: 'GitLab', azure: 'Azure DevOps', bitbucket: 'Bitbucket' };
  /** The platform a token is for, from how it starts (Azure DevOps tokens have no mark: picked by hand). */
  const detectProvider = (token) =>
    /^(ghp_|github_pat_|gho_|ghu_|ghs_)/.test(token) ? 'github' : /^(glpat-|gldt-|glptt-|glrt-)/.test(token) ? 'gitlab' : /^(ATBB|ATCTT|ATATT)/.test(token) ? 'bitbucket' : null;
  const masked = (token) => (token.length > 10 ? `${token.slice(0, 4)}••••${token.slice(-4)}` : '••••');
  const hostOf = (x) => { try { return new URL(x.address || GIT_ADDRESS[x.provider]).host; } catch { return x.address || x.provider; } };
  $('calc-git-secret').addEventListener('input', () => {
    const found = detectProvider($('calc-git-secret').value.trim());
    if (found && $('calc-git-provider').value !== found) {
      $('calc-git-provider').value = found;
      $('calc-git-address').placeholder = GIT_ADDRESS[found];
    }
    $('calc-git-detected').textContent = found ? `${PROVIDER_NAMES[found]} detected` : $('calc-git-secret').value.trim() ? 'Pick the git host above (Azure DevOps tokens do not say which platform they are for)' : '';
  });
  /** The token in the field, added to the list (the field is cleared for the next one). */
  function addTypedToken() {
    const token = $('calc-git-secret').value.trim();
    if (!token) return false;
    const entry = { provider: $('calc-git-provider').value, address: $('calc-git-address').value.trim(), token };
    if (!git.tokens.some((x) => x.token === token && x.provider === entry.provider && x.address === entry.address)) git.tokens.push(entry);
    $('calc-git-secret').value = '';
    $('calc-git-detected').textContent = '';
    renderTokens();
    return true;
  }
  function renderTokens() {
    const box = $('calc-git-tokens');
    box.hidden = !git.tokens.length;
    box.innerHTML = git.tokens.length
      ? `<div class="calc-git-tokens-head">${git.tokens.length === 1 ? '1 token' : `${num(git.tokens.length)} tokens`}: each one's organisations are found and counted; a repository two can see is counted once.</div>` +
        git.tokens.map((x, i) => `<div class="calc-git-token-row"><span class="calc-fh-pill ok">${esc(PROVIDER_NAMES[x.provider] ?? x.provider)}</span><code translate="no">${esc(masked(x.token))}</code><span translate="no">${esc(hostOf(x))}</span><button type="button" class="link" data-token-remove="${i}">Remove</button></div>`).join('')
      : '';
    git.onTokens?.();
  }
  /**
   * A token given beside the API key (the standalone calculator's head): added to the same list, ready on
   * Fusion · from Git. The platform from how the token starts, else the one picked. Returns the platform, or null.
   */
  function addGitToken({ provider = '', address = '', token = '' } = {}) {
    const value = String(token).trim();
    if (!value) return null;
    const kind = detectProvider(value) ?? (PROVIDER_NAMES[provider] ? provider : null);
    if (!kind) return null;
    const entry = { provider: kind, address: String(address).trim(), token: value };
    if (!git.tokens.some((x) => x.token === entry.token && x.provider === entry.provider && x.address === entry.address)) git.tokens.push(entry);
    git.chosen = new Set([...(git.chosen ?? []), 'token']);
    const box = $('calc-git-hosts').querySelector('input[value="token"]');
    renderTokens();
    if (box) {
      box.checked = true;
      hostSwitched();
    }
    return kind;
  }
  const gitTokens = () => git.tokens.map((x) => ({ provider: x.provider, platform: PROVIDER_NAMES[x.provider] ?? x.provider, masked: masked(x.token), host: hostOf(x) }));
  function removeGitToken(i) {
    git.tokens.splice(Number(i), 1);
    renderTokens();
    if ($('calc-git-hosts').querySelector('input[value="token"]')) hostSwitched();
  }
  $('calc-git-token-add').addEventListener('click', () => {
    if (!addTypedToken()) return setStatus('calc-git-status', 'Paste the token first (1 · Where the code is).', 'error');
    hostSwitched();
  });
  $('calc-git-tokens').addEventListener('click', (event) => {
    const i = event.target.closest('[data-token-remove]')?.dataset.tokenRemove;
    if (i === undefined) return;
    removeGitToken(i);
  });
  /** The tokens typed, as the server takes them (each sent only with the requests for its own host, never kept). */
  function typedTokens() {
    if (!git.chosen?.has('token')) return [];
    addTypedToken();
    if (!git.tokens.length) throw new Error('Paste a token first (1 · Where the code is).');
    return git.tokens.map((x) => ({ provider: x.provider, address: x.address, token: x.token }));
  }
  /** Where the code is: the connections ticked and the tokens typed; at least one. */
  function access() {
    const connections = [...(git.chosen ?? [])].filter((id) => id !== 'token' && git.connections?.some((x) => x.id === id));
    const tokens = typedTokens();
    if (!connections.length && !tokens.length) throw new Error('Tick where the code is first (1 · Where the code is).');
    return { connections, tokens };
  }
  /** One request per access: the Admin's connections together, then each token on its own. */
  const accessParts = (how) => [...(how.connections.length ? [{ key: null, body: { connections: how.connections } }] : []), ...how.tokens.map((token, i) => ({ key: `token:${i}`, index: i, token, body: { connections: [], token } }))];

  /** What to list of a source: the organizations ticked and typed, and Everything this token can see. */
  function askOf(key) {
    const found = git.orgs[key];
    const typed = $('calc-git-owner').value.split(',').map((s) => s.trim()).filter(Boolean);
    const orgs = [...new Set([...(found ? [...found.ticked] : []), ...typed])];
    return { ...(orgs.length ? { orgs } : {}), everything: Boolean(found?.everything) };
  }

  $('calc-git-orgs-find').addEventListener('click', () => findOrgs());
  /** Find each source's organizations (a token: Everything this token can see, ticked to start with). True when found. */
  async function findOrgs() {
    let how;
    try {
      how = access();
    } catch (error) {
      setStatus('calc-git-status', error.message, 'error');
      return false;
    }
    setStatus('calc-git-status', 'Finding the organizations…', 'muted');
    $('calc-git-orgs-find').disabled = true;
    try {
      git.orgs = {};
      for (const part of accessParts(how)) {
        const found = await api('/api/projections/git/organizations', { method: 'POST', body: JSON.stringify(part.body), quiet: true });
        for (const s of found.sources ?? []) {
          // Each token's organisations kept apart: its own key, and which token in the label.
          const key = s.source === 'token' && part.key ? part.key : s.source;
          const label = s.source === 'token' && part.key && how.tokens.length > 1 ? `${s.label} · token ${part.index + 1}` : s.label;
          const own = git.connections?.find((x) => x.id === s.source)?.owner ?? '';
          const ticked = new Set((s.organizations ?? []).filter((o) => own && o.id.toLowerCase() === own.toLowerCase()).map((o) => o.id));
          git.orgs[key] = { ...s, source: key, label, ticked, everything: s.source === 'token' };
        }
      }
      renderOrgs();
      setStatus('calc-git-status', '');
      return true;
    } catch (error) {
      if (!handleAuthLoss(error)) showError('calc-git-status', error);
      return false;
    } finally {
      $('calc-git-orgs-find').disabled = false;
    }
  }

  function renderOrgs() {
    const sets = Object.values(git.orgs);
    const box = $('calc-git-orgs');
    box.hidden = !sets.length;
    box.innerHTML = sets
      .map((s) => `<fieldset class="calc-git-org-set" data-source="${esc(s.source)}"><legend><span translate="no">${esc(`${s.label} · ${s.host}`)}</span>${s.who ? ` <small>${esc(t('signed in as {0}').replace('{0}', s.who))}</small>` : ''}</legend>
        <label class="calc-git-everything"><input type="checkbox" data-org-all${s.everything ? ' checked' : ''} /> <span>Everything this token can see</span></label>
        <div class="calc-git-org-list">${(s.organizations ?? []).map((o) => `<label><input type="checkbox" data-org="${esc(o.id)}"${s.ticked.has(o.id) || s.everything ? ' checked' : ''}${s.everything ? ' disabled' : ''} /> ${o.id === '@me' ? '<span>My own repositories</span>' : `<span translate="no">${esc(o.id)}</span>`}</label>`).join('') || '<span class="hint">No organizations listed: type one below, or tick Everything this token can see.</span>'}</div>
        ${s.problem ? `<small class="calc-warn">${esc(s.problem)}</small>` : ''}
      </fieldset>`)
      .join('');
  }
  $('calc-git-orgs').addEventListener('change', (event) => {
    const set = git.orgs[event.target.closest('[data-source]')?.dataset.source];
    if (!set) return;
    if (event.target.matches('[data-org-all]')) {
      set.everything = event.target.checked;
      renderOrgs();
    } else if (event.target.dataset.org !== undefined) {
      if (event.target.checked) set.ticked.add(event.target.dataset.org);
      else set.ticked.delete(event.target.dataset.org);
    }
  });

  $('calc-git-list').addEventListener('click', () => listRepos());
  /** List the repositories of what is ticked; those not archived and not forks ticked to start with. True when any. */
  async function listRepos() {
    let how;
    try {
      how = access();
    } catch (error) {
      setStatus('calc-git-status', error.message, 'error');
      return false;
    }
    setStatus('calc-git-status', 'Listing the repositories…', 'muted');
    $('calc-git-list').disabled = true;
    try {
      const found = { repositories: [], problems: [], more: false };
      for (const part of accessParts(how)) {
        const body = part.key
          ? { connections: [], token: { ...part.token, ...askOf(part.key) } }
          : { connections: how.connections.map((id) => ({ id, ...askOf(id) })) };
        const got = await api('/api/projections/git/repositories', { method: 'POST', body: JSON.stringify(body), quiet: true });
        found.repositories.push(...(got.repositories ?? []).map((r) => (part.key ? { ...r, tokenIndex: part.index } : r)));
        found.problems.push(...(got.problems ?? []));
        found.more ||= Boolean(got.more);
      }
      // A repository two tokens can see is listed (and counted) once.
      found.repositories = [...new Map(found.repositories.map((r) => [cleanUrl(r.url), r])).values()];
      // Ticked to start with: each one not archived and not a fork, up to the repositories a run takes.
      let ticked = 0;
      git.repos = (found.repositories ?? []).map((r) => ({ ...r, ticked: !r.archived && !r.fork && (ticked += 1) <= git.limit }));
      git.filter = '';
      renderRepos();
      const problems = (found.problems ?? []).map((p) => (p.org ? `${p.org}: ${p.error}` : p.error));
      if (!git.repos.length) setStatus('calc-git-status', problems.length ? problems.join(' · ') : 'No repositories there that this access may read.', 'warn');
      else if (found.more) setStatus('calc-git-status', `The first ${num(git.repos.length)} repositories are listed: paste the addresses of any others.`, 'warn');
      else if (problems.length) setStatus('calc-git-status', problems.join(' · '), 'warn');
      else setStatus('calc-git-status', '');
      return git.repos.some((r) => r.ticked);
    } catch (error) {
      if (!handleAuthLoss(error)) showError('calc-git-status', error);
      return false;
    } finally {
      $('calc-git-list').disabled = false;
    }
  }

  /** The steps (where the code is, which repositories, the engine), folded behind one link once counted on their own. */
  function foldGitSteps(folded) {
    const steps = $('calc-git-steps');
    let open = $('calc-git-steps-open');
    if (!open) {
      open = Object.assign(document.createElement('button'), { type: 'button', className: 'link calc-git-steps-open', id: 'calc-git-steps-open', textContent: 'Change what is counted' });
      open.addEventListener('click', () => foldGitSteps(false));
      steps.before(open);
    }
    git.stepsFolded = folded;
    steps.hidden = folded;
    open.hidden = !folded;
  }
  // On its own the calculator counts by itself once a token is given beside the API key: the steps start folded.
  if (standalone) foldGitSteps(true);

  /**
   * Count everything the tokens can see, in one go (a token given beside the API key): find the organizations, list the
   * repositories, count them. A count already running: this one follows when it ends.
   */
  async function autoCount() {
    if (!c.open || !git.tokens.length) return;
    if (git.run || git.autoBusy) return void (git.autoAgain = true);
    git.autoBusy = true;
    try {
      git.chosen = new Set([...(git.chosen ?? []), 'token']);
      setStatus('calc-git-status', 'Counting from git: finding each token\'s organizations…', 'muted');
      if (!(await findOrgs())) return;
      setStatus('calc-git-status', 'Counting from git: listing the repositories…', 'muted');
      if (!(await listRepos())) return;
      git.autoFold = true;
      $('calc-git-count').click();
    } finally {
      git.autoBusy = false;
    }
  }

  function renderRepos() {
    const box = $('calc-git-repos');
    box.hidden = !git.repos.length;
    const tags = (r) => [r.branch ? ` <span class="calc-git-tag" translate="no">${esc(r.branch)}</span>` : '', r.archived ? ' <span class="calc-git-tag">archived</span>' : '', r.fork ? ' <span class="calc-git-tag">fork</span>' : '', r.empty ? ' <span class="calc-git-tag">empty</span>' : ''].join('');
    box.innerHTML = git.repos.length
      ? `<div class="calc-git-repos-head"><span></span><input type="search" class="calc-git-filter" data-git-filter placeholder="Filter" aria-label="Filter the repositories" value="${esc(git.filter)}" /><button type="button" class="link" data-git-all>Tick all shown</button><button type="button" class="link" data-git-none>Tick none</button></div>` +
        git.repos
          .map((r, i) => `<label data-git-row="${i}"><input type="checkbox" data-git-repo="${i}"${r.ticked ? ' checked' : ''} /><span><span translate="no">${esc(r.path)}</span>${tags(r)}${git.tokens.length > 1 && Number.isInteger(r.tokenIndex) ? ` <span class="calc-git-tag">token ${r.tokenIndex + 1}</span>` : ''}</span><span class="calc-git-size">${r.sizeBytes === null || r.sizeBytes === undefined ? '' : esc(bytes(r.sizeBytes))}</span></label>`)
          .join('')
      : '';
    filterRepos();
    countLabel();
  }
  /** Only the repositories whose path has what is typed in the filter. */
  function filterRepos() {
    const words = git.filter.toLowerCase().split(/\s+/).filter(Boolean);
    for (const row of $('calc-git-repos').querySelectorAll('label[data-git-row]')) {
      const r = git.repos[Number(row.dataset.gitRow)];
      row.classList.toggle('calc-git-hidden', words.length > 0 && !words.every((w) => r.path.toLowerCase().includes(w)));
    }
  }
  $('calc-git-repos').addEventListener('input', (event) => {
    if (!event.target.matches('[data-git-filter]')) return;
    git.filter = event.target.value;
    filterRepos();
  });
  $('calc-git-repos').addEventListener('change', (event) => {
    const i = event.target.dataset.gitRepo;
    if (i === undefined || !git.repos[Number(i)]) return;
    git.repos[Number(i)].ticked = event.target.checked;
    countLabel();
  });
  $('calc-git-repos').addEventListener('click', (event) => {
    const all = event.target.closest('[data-git-all]');
    if (!all && !event.target.closest('[data-git-none]')) return;
    for (const row of $('calc-git-repos').querySelectorAll('label[data-git-row]')) {
      const r = git.repos[Number(row.dataset.gitRow)];
      if (!all) r.ticked = false;
      else if (!row.classList.contains('calc-git-hidden')) r.ticked = true;
    }
    renderRepos();
  });

  /** The repositories ticked (with what discovery said of them) and pasted, each once. */
  function wanted() {
    const out = git.repos.filter((r) => r.ticked).map(({ source, url, fullName, id, org, project, branch, createdAt, tokenIndex }) => ({ source, url, fullName, id, org, project, branch, createdAt, tokenIndex }));
    // A pasted address goes with the token for its host, when one is typed for it.
    const byHost = (url) => { try { const h = new URL(url).host; const i = git.tokens.findIndex((x) => hostOf(x) === h); return i >= 0 ? i : undefined; } catch { return undefined; } };
    for (const line of $('calc-git-paste').value.split(/\r?\n/)) if (line.trim()) out.push({ url: line.trim(), tokenIndex: byHost(line.trim()) });
    return [...new Map(out.map((r) => [cleanUrl(r.url), r])).values()];
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
    if (items.length > git.limit) return setStatus('calc-git-status', `At most ${num(git.limit)} repositories a run: tick fewer, and count the rest after.`, 'error');
    let how;
    try {
      how = access();
    } catch (error) {
      return setStatus('calc-git-status', error.message, 'error');
    }
    // One run for the Admin's connections, then one for each token's repositories, one after another.
    const strip = ({ tokenIndex, ...item }) => item;
    const runs = [];
    const viaConnections = items.filter((r) => !Number.isInteger(r.tokenIndex) && (how.connections.length || !how.tokens.length));
    const loose = items.filter((r) => !Number.isInteger(r.tokenIndex) && !how.connections.length && how.tokens.length);
    if (viaConnections.length) runs.push({ items: viaConnections.map(strip), how: { connections: how.connections, token: null } });
    how.tokens.forEach((token, i) => {
      const mine = items.filter((r) => r.tokenIndex === i).concat(i === 0 ? loose : []);
      if (mine.length) runs.push({ items: mine.map(strip), how: { connections: [], token } });
    });
    git.queue = runs.slice(1);
    git.queueDone = { done: 0, failed: 0, runs: runs.length };
    if (runs[0]) startCount(runs[0].items, { how: runs[0].how });
  });

  /** Count again: the project's repository at its latest commit, with the connection it was counted with when it is still there. */
  function countAgain(p) {
    way = 'git';
    showWay(way);
    const known = git.connections?.some((x) => x.id === p.git.connection);
    startCount([{ url: p.git.url, ...(known ? { source: p.git.connection } : {}) }], { projectId: p.id, connection: known ? p.git.connection : null });
  }

  /** Start a run, then follow it: each repository becomes a project of the customer open when it started. */
  async function startCount(items, { projectId = null, connection = null, how: given = null } = {}) {
    if (!c.open || git.run || !items.length) return;
    let how;
    try {
      if (given) how = given;
      else if (connection) how = { connections: [connection], token: null };
      else {
        const all = access();
        how = { connections: all.connections, token: all.tokens[0] ?? null };
      }
    } catch (error) {
      return setStatus('calc-git-status', error.message, 'error');
    }
    setStatus('calc-git-status', 'Starting the count…', 'muted');
    git.run = { id: null, customer: c.open.id, projectId, applied: new Map(), rows: [], seq: 0, summary: null };
    countLabel();
    let job;
    try {
      job = await api('/api/projections/git/count', { method: 'POST', body: JSON.stringify({ connections: how.connections, ...(how.token ? { token: how.token } : {}), engine: $('calc-git-engine').value, repositories: items }), quiet: true });
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

  /** A view of the run: only the repositories changed since the last one are in it, merged here. */
  function mergeRun(job) {
    const run = git.run;
    if (!run) return;
    for (const r of job.repositories ?? []) run.rows[r.i] = r;
    run.seq = Math.max(run.seq, job.seq ?? 0);
    run.summary = job.summary;
    run.engine = job.engine;
  }

  function followCount(job) {
    mergeRun(job);
    renderProgress();
    applyCounted();
    renderGitSummary();
    if (job.state !== 'running') return finishCount();
    setTimeout(async () => {
      if (!git.run) return;
      let next;
      try {
        next = await api(`/api/projections/git/count?id=${encodeURIComponent(git.run.id)}&after=${git.run.seq}`, { quiet: true });
      } catch (error) {
        git.run = null;
        countLabel();
        if (!handleAuthLoss(error)) showError('calc-git-status', error);
        return;
      }
      followCount(next);
    }, 1200);
  }

  /** Each repository measured: a project (the one of the same repository, or the one counted again, is replaced). */
  function applyCounted() {
    const run = git.run;
    if (!run || !c.open || c.open.id !== run.customer) return;
    let added = 0;
    for (const r of run.rows) {
      if (!r || r.state !== 'done' || run.applied.has(r.url)) continue;
      const made = upsertMeasured(
        {
          name: r.name,
          path: r.path,
          file: '',
          langs: Object.fromEntries(Object.entries(r.languages ?? {}).map(([lang, v]) => [lang, v.code])),
          locOverride: null,
          git: { host: r.host, path: r.path, url: r.url, branch: r.branch, commit: r.commit, countedAt: r.countedAt, connection: r.source && r.source !== 'token' ? r.source : '' },
          activity: { commits: r.commits, windowDays: r.windowDays, lastCommitAt: r.lastCommitAt, frequency: r.frequency, devs90: r.devs90, engine: r.engine },
        },
        { projectId: run.projectId, key: String(r.i) },
      );
      run.applied.set(r.url, made.id);
      added += 1;
    }
    if (added) {
      saveFnew();
      renderFusionNew();
    }
  }

  function finishCount() {
    const run = git.run;
    git.run = null;
    countLabel();
    const rows = (run?.rows ?? []).filter(Boolean);
    const done = rows.filter((r) => r.state === 'done').length;
    const failed = rows.length - done;
    if (run && c.open?.id !== run.customer) { git.queue = []; return toast('The count ended while another customer was open: open that customer and count again.', 'warn', 9000); }
    // Several tokens: the next token's run starts; the end says what all of them counted.
    if (git.queueDone) {
      git.queueDone.done += done;
      git.queueDone.failed += failed;
    }
    if (git.queue?.length) {
      const next = git.queue.shift();
      setStatus('calc-git-status', `${num(git.queueDone.done)} counted so far; the next token's repositories now…`, 'muted');
      return startCount(next.items, { how: next.how });
    }
    // Counted on its own: the steps fold away, the tiles and the projects stay; Change what is counted opens them.
    if (git.autoFold && !git.queue?.length) {
      git.autoFold = false;
      foldGitSteps(true);
    }
    // A token added while this count ran: its repositories are counted now.
    if (git.autoAgain) {
      git.autoAgain = false;
      setTimeout(autoCount, 0);
    }
    if (git.queueDone && git.queueDone.runs > 1) {
      const all = git.queueDone;
      git.queueDone = null;
      if (!all.failed) return setStatus('calc-git-status', `${num(all.done)} counted with ${num(all.runs)} tokens: each is a project below.`, 'ok');
      return setStatus('calc-git-status', `${num(all.done)} counted, ${num(all.failed)} not, with ${num(all.runs)} tokens: each says why above.`, all.done ? 'warn' : 'error');
    }
    git.queueDone = null;
    if (!failed) setStatus('calc-git-status', done === 1 ? 'Counted: it is a project below.' : `${num(done)} counted: each is a project below.`, 'ok');
    else setStatus('calc-git-status', `${num(done)} counted, ${num(failed)} not: each says why above.`, done ? 'warn' : 'error');
  }

  /** The run's figures: repositories measured, their code lines (the languages counted), developers (each once), Fusion scans. */
  function renderGitSummary() {
    const run = git.run;
    const box = $('calc-git-summary');
    if (!run?.summary || !c.open) return;
    const ids = new Set(run.applied.values());
    const rows = fnewEstimate().rows.filter((r) => ids.has(r.id));
    const s = run.summary;
    const fromRule = rows.filter((r) => r.scansFrom === 'frequency' || r.scansFrom === 'criticality').length;
    box.hidden = false;
    box.innerHTML = [
      fnewKpi('Repositories', num(s.measured), esc(`of ${num(s.repositories)}${s.failed ? ` · ${num(s.failed)} not counted` : ''}`)),
      fnewKpi('Lines of code', num(rows.reduce((n, r) => n + (r.lines ?? 0), 0)), esc(`${num(s.commits)} commits in the last ${num(365)} days`)),
      fnewKpi('Developers', num(s.developers), esc(`Committed in the last ${num(s.developerDays ?? 90)} days, each once, bots left out`)),
      fnewKpi('Fusion scans', num(rows.reduce((n, r) => n + (r.included && r.units ? r.scans : 0), 0)), esc(`Over ${num(fusion().periodMonths ?? 12)} months · ${num(fromRule)} by change frequency`), 'calc-gold'),
    ].join('');
  }

  /** One line a repository: waiting, fetching, its commits, counting n of m files, what it found, or why not. */
  function renderProgress() {
    const box = $('calc-git-progress');
    const rows = (git.run?.rows ?? []).filter(Boolean);
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
          const how = [`${num(r.commits)} commits`, FREQ_LABEL[r.frequency] ?? '', `${num(r.devs90)} developers`].filter(Boolean).join(' · ');
          state = `<span class="calc-git-state done">✓ ${esc(`${num(lines)} lines`)}${langs.length ? ` · <span translate="no">${esc(langs.slice(0, 3).join(', '))}</span>` : ''} · ${esc(how)}</span>`;
        } else if (r.state === 'failed') state = `<span class="calc-git-state bad">✗ ${esc(r.error)}</span>`;
        else if (r.state === 'counting') state = `<span class="calc-git-state">${esc(r.total ? `Counting… ${num(r.done)} of ${num(r.total)} files` : 'Counting…')}</span>`;
        else if (r.state === 'files') state = `<span class="calc-git-state">${esc(git.run?.engine === 'api' ? 'Reading its archive…' : 'Fetching the files to count…')}</span>`;
        else if (r.state === 'history') state = '<span class="calc-git-state">Reading its commits…</span>';
        else if (r.state === 'clone' || r.state === 'fetching') state = '<span class="calc-git-state">Fetching the default branch…</span>';
        else state = '<span class="calc-git-state">Waiting</span>';
        return `<div class="calc-git-row"><span><span translate="no">${esc(where)}</span>${tag}</span>${state}</div>`;
      })
      .join('');
  }

  // ---- cloc-fusion: its one-file page to download, and its report to import --------------------------

  $('calc-cf-download').addEventListener('click', async () => {
    const button = $('calc-cf-download');
    button.disabled = true;
    try {
      const page = await api('/api/projections/git/cloc-fusion', { quiet: true });
      download(new Blob([page.html], { type: 'text/html' }), page.file || 'cloc-fusion.html');
      $('calc-cf-sum').textContent = `cloc-fusion ${page.version} · SHA-256 ${page.sha256}`;
    } catch (error) {
      if (!handleAuthLoss(error)) toast(error.message, 'bad');
    } finally {
      button.disabled = false;
    }
  });

  /** A cloc-fusion report's repositories as projects (read here: nothing is sent anywhere but this customer's save). */
  function importClocFusion(textValue, fileName) {
    const found = parseClocFusionReport(textValue, fileName, { models: fusion().models });
    found.projects.forEach((p, i) => upsertMeasured({ ...p, path: p.fullName }, { key: `cf${i}` }));
    return found;
  }
  async function readClocFusion(files) {
    if (!c.open || !files.length) return;
    const done = [];
    const said = [];
    let added = 0;
    for (const file of files) {
      try {
        if (file.size > MAX_CLOC_FUSION_BYTES) throw new Error(t('{0} is over 64 MB.').replace('{0}', file.name));
        const found = importClocFusion(await file.text(), file.name);
        added += found.projects.length;
        said.push(t('{0}: {1} repositories read (cloc-fusion {2}), {3} not measured there; developers in the last 90 days across it: {4}.').replace('{0}', file.name).replace('{1}', num(found.projects.length)).replace('{2}', found.version || '—').replace('{3}', num(found.skipped)).replace('{4}', num(found.developers)));
        done.push(`<span translate="no">✓ ${esc(file.name)}</span>`);
      } catch (error) {
        const message = error.notReport ? t('{0} is not a cloc-fusion report: use cloc-fusion-report.json from cloc-fusion\'s output.').replace('{0}', file.name) : error.message;
        done.push(`<span class="bad" title="${esc(message)}" translate="no">✗ ${esc(file.name)}</span>`);
        toast(message, 'bad');
      }
    }
    $('calc-cf-files').innerHTML = done.join('');
    setStatus('calc-cf-status', said.join(' '), added ? 'ok' : '');
    if (added) saveFnew();
    renderFusionNew();
  }
  $('calc-cf-pick').addEventListener('click', () => $('calc-cf-file').click());
  $('calc-cf-file').addEventListener('change', (event) => {
    readClocFusion([...event.target.files]);
    event.target.value = '';
  });
  const cfDrop = $('calc-cf-drop');
  cfDrop.addEventListener('dragover', (event) => {
    event.preventDefault();
    cfDrop.classList.add('drag');
  });
  cfDrop.addEventListener('dragleave', () => cfDrop.classList.remove('drag'));
  cfDrop.addEventListener('drop', (event) => {
    event.preventDefault();
    cfDrop.classList.remove('drag');
    readClocFusion([...(event.dataTransfer?.files ?? [])]);
  });

  /** The customer's cloc results: each file read here (nothing is sent anywhere but this customer's save). A cloc-fusion report dropped here is read as one. */
  const MAX_CLOC_BYTES = 50 * 1024 * 1024;
  async function readCloc(files) {
    if (!c.open || !files.length) return;
    const done = [];
    let added = 0;
    for (const file of files) {
      try {
        if (file.size > MAX_CLOC_BYTES && !/\.json$/i.test(file.name)) throw new Error(t('{0} is over 50 MB: run cloc without --by-file.').replace('{0}', file.name));
        if (file.size > MAX_CLOC_FUSION_BYTES) throw new Error(t('{0} is over 64 MB.').replace('{0}', file.name));
        const content = await file.text();
        if (/^\s*\{/.test(content) && /"tool"\s*:\s*"cloc-fusion"/.test(content.slice(0, 4096))) {
          added += importClocFusion(content, file.name).projects.length;
        } else {
          if (file.size > MAX_CLOC_BYTES) throw new Error(t('{0} is over 50 MB: run cloc without --by-file.').replace('{0}', file.name));
          for (const found of parseCloc(content, file.name)) {
            upsertMeasured({ name: found.name, langs: found.langs, file: file.name, locOverride: null }, { key: String(added) });
            added += 1;
          }
        }
        done.push(`<span translate="no">✓ ${esc(file.name)}</span>`);
      } catch (error) {
        const message = error.notCloc ? t('{0} is not a cloc report: run cloc with --json or --csv.').replace('{0}', file.name) : error.notReport ? t('{0} is not a cloc-fusion report: use cloc-fusion-report.json from cloc-fusion\'s output.').replace('{0}', file.name) : error.message;
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
    modelsWarn();
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
    // Filling in as the projects come in: Fusion follows the scope now, the backlog's weeks when the read is done (applyRead).
    if (reading.stream && c.open.id === reading.customer) {
      if (!quiet && narrowed()) setStatus('calc-scope-status', 'Fusion follows the scope now; triage & remediation does when the read is done.', 'muted');
      return renderTr();
    }
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
    // The bundle size is 10,000 for nearly every customer: it waits behind the "?" on Bundles, marked when it is another.
    $('calc-bundle-size').textContent = `Bundles of ${num(n.bundleCredits)} credits, rounded up to whole bundles.`;
    $('calc-bundle-q').classList.toggle('calc-q-set', Number(n.bundleCredits) !== BUNDLE_CREDITS);
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
    periodMonths: () => $('calc-horizon'),
    extraPercent: () => $('calc-extra'),
    // Behind its "?": the "?" is marked, so a change waiting shows with the box closed.
    bundleCredits: () => $('calc-bundle-q'),
  };
  /** The bar that lists what waits, with Undo and Apply. */
  function renderPending() {
    const changes = c.open ? pending() : [];
    // Apply is always in view in the settings block: quiet while everything is applied, lit when something waits.
    const idle = !changes.length;
    $('calc-pending').hidden = !c.open;
    $('calc-pending').classList.toggle('idle', idle);
    $('calc-apply').disabled = !c.open || idle;
    $('calc-undo').hidden = idle;
    $('calc-pending-count').textContent = idle ? 'Every setting is applied' : changes.length === 1 ? '1 change not applied yet' : `${num(changes.length)} changes not applied yet`;
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
  // `stream`: a customer with nothing read yet gets the figures as the projects come in (`rows`: those in so far);
  // `before`: what it had (projects added by hand), put back if it is left before the read ends.
  const reading = { customer: null, timer: null, auto: false, waiters: [], branches: null, stream: false, rows: [], before: null };
  /** Resolves when the read running now has finished (true when it gave data). */
  const readFinished = () => new Promise((resolve) => reading.waiters.push(resolve));
  const settle = (ok) => {
    reading.branches = null;
    reading.startedAt = null;
    reading.lastPct = 0;
    const streamed = reading.stream;
    reading.stream = false;
    reading.rows = [];
    reading.before = null;
    for (const resolve of reading.waiters.splice(0)) resolve(ok);
    renderPending();
    // What was changed while it streamed waited for the read: saved now.
    if (streamed && c.pending) flush();
  };

  function readProgress(job) {
    const running = job?.state === 'running';
    const bar = $('calc-read-progress');
    bar.hidden = !running;
    $('calc-read').disabled = running || !c.open;
    if (!running) return;
    // Two things side by side: the projects read (their scans and lines of code), and those with their findings in.
    const total = job.total || 0;
    const read = job.read ?? (job.step === 'projects' ? job.done : total);
    const found = job.found ?? (job.step === 'summaries' ? job.done : 0);
    const pct = total ? Math.min(99, Math.round(((read * 0.6 + found * 0.4) / total) * 100)) : 0;
    bar.value = pct;
    // How long is left, from the pace so far (shown once there is a pace to go by).
    const now = Date.now();
    if (!reading.startedAt || pct < (reading.lastPct ?? 0)) reading.startedAt = now;
    reading.lastPct = pct;
    const spent = (now - reading.startedAt) / 1000;
    const left = pct >= 3 && spent > 5 ? (spent * (100 - pct)) / pct : null;
    const eta = left === null ? '' : left < 90 ? 'under 2 minutes left' : `about ${num(Math.round(left / 60))} minutes left`;
    const fill = reading.stream ? ' The figures fill in as the projects come in.' : ' The figures change when the read is done.';
    if (total) setStatus('calc-read-note', `Reading from Checkmarx One: ${pct}% — ${num(read)} of ${num(total)} projects read, ${num(found)} with their findings in${eta ? ` · ${eta}` : ''}.${fill}`, 'reading');
    else setStatus('calc-read-note', `Reading from Checkmarx One: the list of projects…${fill}`, 'reading');
    readFx({ job, pct, eta, read, found, total });
  }

  // ---- The read panel, on the right: each project as it is read, the totals climbing, the severities in so far ----
  const fx = { queue: [], drip: null, seen: 0, hidden: false, open: false, shown: {}, done: null, runner: null, feed: 0 };
  const FX_FEED = 8;
  const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  /** A figure in the panel that climbs to its new value. */
  function countTo(id, value, format = num) {
    const el = $(id);
    const from = fx.shown[id] ?? 0;
    fx.shown[id] = value;
    if (from === value || reduceMotion()) return void (el.textContent = format(value));
    const start = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - start) / 700);
      el.textContent = format(Math.round(from + (value - from) * (1 - (1 - k) ** 3)));
      if (k < 1 && fx.shown[id] === value) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    el.classList.remove('calc-readfx-bump');
    void el.offsetWidth;
    el.classList.add('calc-readfx-bump');
  }
  const short = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : num(n));
  function fxShow(open) {
    fx.open = open;
    $('calc-readfx').hidden = !open;
    $('calc-readfx-pill').hidden = open || !(reading.timer || fx.done);
    document.body.classList.toggle('calc-readfx-on', open);
    if (open) fxPlace();
  }
  /** Level with the top of the calculator (below the head and the keys), then held near the top of the window as the page scrolls. */
  function fxPlace() {
    const panel = $('calc-readfx');
    if (panel.hidden) return;
    if (window.matchMedia?.('(max-width: 760px)').matches) return void (panel.style.top = panel.style.maxHeight = '');
    const top = Math.max(16, Math.round($('page-calculator').getBoundingClientRect().top));
    panel.style.top = `${top}px`;
    panel.style.maxHeight = `calc(100vh - ${top + 20}px)`;
  }
  window.addEventListener('scroll', () => fx.open && fxPlace(), { passive: true });
  window.addEventListener('resize', () => fx.open && fxPlace());
  function fxStart() {
    clearTimeout(fx.closer);
    Object.assign(fx, { queue: [], seen: 0, shown: {}, done: null, feed: 0 });
    $('calc-readfx').classList.remove('done', 'failed');
    $('calc-readfx-title').textContent = 'Reading the projects';
    $('calc-readfx-feed').replaceChildren();
    $('calc-readfx-sev').replaceChildren();
    for (const id of ['calc-readfx-read', 'calc-readfx-loc', 'calc-readfx-scans', 'calc-readfx-open']) $(id).textContent = '0';
    $('calc-readfx-fill').style.width = '0%';
    // A different fast thing each read, as on CxMissionZero's progress flares.
    const s = nextSpeedster();
    const runner = $('calc-readfx-runner');
    runner.innerHTML = s.svg;
    runner.title = s.name;
    runner.classList.remove('settling');
    runner.style.insetInlineStart = '0%';
    $('calc-readfx-note').textContent = reading.stream ? 'The figures fill in as the projects come in: try the severities, the period or the scope meanwhile.' : 'The figures change when the read is done; until then they are the last read’s.';
    fxShow(!fx.hidden);
  }
  function readFx({ job, pct, eta, read, total }) {
    if (!fx.open && $('calc-readfx-pill').hidden && !fx.hidden) fxStart();
    $('calc-readfx-pill-text').textContent = total ? `Reading Checkmarx One · ${pct}%` : 'Reading Checkmarx One';
    $('calc-readfx-pct').textContent = `${pct}%`;
    $('calc-readfx-eta').textContent = total ? `${num(read)} of ${num(total)} projects${eta ? ` · ${eta}` : ''}` : 'Listing the projects…';
    $('calc-readfx-fill').style.width = `${pct}%`;
    $('calc-readfx-runner').style.insetInlineStart = `calc(${pct}% - ${(pct / 100) * 64}px)`;
    const live = job.live;
    if (!live) return;
    countTo('calc-readfx-read', read);
    countTo('calc-readfx-loc', live.loc ?? 0, short);
    countTo('calc-readfx-scans', live.scans ?? 0);
    const open = live.open ?? {};
    countTo('calc-readfx-open', SEVERITIES.reduce((n, s) => n + (open[s] ?? 0), 0));
    renderFxSeverities(open);
    // Each project read since the last look, dripped in one after another over the next second and a half.
    const fresh = (live.recent ?? []).filter((x) => x.n > fx.seen);
    if (fresh.length) fx.seen = fresh[fresh.length - 1].n;
    fx.queue.push(...fresh.slice(-FX_FEED * 3));
    if (fx.queue.length > FX_FEED * 3) fx.queue.splice(0, fx.queue.length - FX_FEED * 3);
    dripFeed();
  }
  function renderFxSeverities(open) {
    const box = $('calc-readfx-sev');
    const shown = SEVERITIES.filter((s) => s !== 'Info');
    const max = Math.max(1, ...shown.map((s) => open[s] ?? 0));
    if (box.children.length !== shown.length) {
      box.replaceChildren(
        ...shown.map((s) => {
          const row = document.createElement('div');
          row.className = 'calc-readfx-sevrow';
          row.innerHTML = `<span class="calc-readfx-sevname">${esc(s)}</span><span class="calc-readfx-bar"><i></i></span><b translate="no">0</b>`;
          row.querySelector('i').style.background = SEVERITY_COLOURS[s];
          return row;
        }),
      );
    }
    shown.forEach((s, i) => {
      const row = box.children[i];
      row.querySelector('i').style.width = `${Math.round(((open[s] ?? 0) / max) * 100)}%`;
      row.querySelector('b').textContent = num(open[s] ?? 0);
    });
  }
  function dripFeed() {
    if (fx.drip || !fx.queue.length) return;
    const gap = Math.max(60, Math.min(260, 1400 / fx.queue.length));
    const next = () => {
      const item = fx.queue.shift();
      if (!item) return void (fx.drip = null);
      const li = document.createElement('li');
      const facts = [item.loc ? `${short(item.loc)} lines` : 'no code counted', `${num(item.scans ?? 0)} scans in the year`, ...(item.criticality ? [`criticality ${item.criticality}`] : [])];
      li.innerHTML = `<span class="calc-readfx-tick" aria-hidden="true"></span><span class="calc-readfx-what"><b translate="no">${esc(item.name)}</b><small>${esc(facts.join(' · '))}</small></span><span class="calc-readfx-n" translate="no">#${num(item.n)}</span>`;
      const feed = $('calc-readfx-feed');
      feed.prepend(li);
      while (feed.children.length > FX_FEED) feed.lastElementChild.remove();
      fx.drip = setTimeout(next, gap);
    };
    next();
  }
  /** The read ended: the runner glides to a stop and the panel says what was read, then folds away. */
  function fxEnd(ok, text) {
    if (!fx.open && $('calc-readfx-pill').hidden) return;
    fx.done = ok ? 'done' : 'failed';
    clearTimeout(fx.drip);
    fx.drip = null;
    const panel = $('calc-readfx');
    panel.classList.add(ok ? 'done' : 'failed');
    $('calc-readfx-title').textContent = text;
    if (ok) {
      $('calc-readfx-pct').textContent = '100%';
      $('calc-readfx-fill').style.width = '100%';
      $('calc-readfx-runner').style.insetInlineStart = 'calc(100% - 64px)';
      const runner = $('calc-readfx-runner');
      runner.classList.add('settling');
      // It glides to a stop, then the tick pops in (as the progress flares do).
      setTimeout(() => {
        runner.classList.remove('settling');
        runner.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="tick-disc" cx="12" cy="12" r="11" fill="#16a34a" /><path class="tick-mark" pathLength="1" d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" /></svg>';
      }, reduceMotion() ? 0 : 520);
      $('calc-readfx-eta').textContent = 'Every figure is from the whole read now.';
      $('calc-readfx-pill-text').textContent = 'Read from Checkmarx One · done';
    } else $('calc-readfx-pill-text').textContent = 'Reading Checkmarx One stopped';
    if (ok) fx.closer = setTimeout(() => { fx.done = null; fxShow(false); }, 6000);
  }
  $('calc-readfx-hide').addEventListener('click', () => {
    fx.hidden = true;
    fxShow(false);
  });
  $('calc-readfx-pill').addEventListener('click', () => {
    fx.hidden = false;
    clearTimeout(fx.closer);
    fxShow(true);
  });

  /** What has come in so far, put in the customer open (a customer with nothing read yet only): shown, not saved until the read ends. */
  function applyLive(live) {
    if (!live) return;
    // The rows complete since the last look (from where this page had them; a gap is asked for again next time).
    if (live.rowsFrom === reading.rows.length && live.rows?.length) reading.rows.push(...live.rows);
    if (!reading.stream || !c.open || c.open.id !== reading.customer) return;
    const f = fusion();
    const manual = reading.before?.projects ?? [];
    f.projects = [...reading.rows.map((p) => ({ ...p, locOverride: null, included: true, scansOverride: null, modelOverride: null })), ...manual];
    if (live.offer?.models?.length && !reading.modelsIn) {
      reading.modelsIn = true;
      mergeModels(f, live.offer.models);
      c.remainingCredits = live.offer.remainingCredits ?? null;
    }
    if (FREQUENCIES.every((q) => f.byFrequency[q.id].scans === null)) for (const q of FREQUENCIES) f.byFrequency[q.id].scans = suggestedScans(q.id, f.periodMonths);
    // Nothing counted from git or cloc yet: Fusion · Checkmarx One is the estimate in the credits, from the first projects in.
    if (!reading.basisSet && reading.rows.length && !['cxone', 'both'].includes(basis()) && !(fnew().projects ?? []).length) {
      reading.basisSet = true;
      f.optOut = false;
      fnew().optOut = true;
      if (c.next) Object.assign(c.next, { fusionOn: true, fusionNewOn: false });
      saveFusion();
      saveFnew();
      renderPending();
      placeFusion();
    }
    if (live.tr?.totals && live.tr?.fixed) {
      const first = !tr().totals;
      c.open.tr = { ...tr(), totals: live.tr.totals, fixed: live.tr.fixed };
      if (first) syncDraft();
    }
    // Someone changing a figure meanwhile (a field in use, a slider held) is not redrawn under their hands: the next look shows it.
    const field = document.activeElement;
    if (fx.pointer || (field?.closest?.('#page-calculator') && field.matches('input, select, textarea'))) return void (reading.redraw = true);
    reading.redraw = false;
    renderTr();
    renderFusion();
  }
  $('page-calculator').addEventListener('pointerdown', () => (fx.pointer = true));
  document.addEventListener('pointerup', () => (fx.pointer = false));
  document.addEventListener('pointercancel', () => (fx.pointer = false));

  /** The last read, under the button, when nothing else is said there. */
  function renderReadNote() {
    const note = $('calc-read-note');
    if (!c.open || reading.timer || ['error', 'ok', 'warn'].some((k) => note.classList.contains(k))) return;
    const at = c.open.fusion?.readAt ?? c.open.tr?.totals?.meta?.readAt;
    note.className = 'status hint';
    note.innerHTML = at ? `Last read <time translate="no">${esc(fmtDateTime(at))}</time>` : 'Not read yet';
  }

  /** Follow a read for the customer open: a customer with nothing read yet gets the figures as they come in. */
  function follow() {
    reading.customer = c.open.id;
    reading.stream = !c.open.tr?.totals && !(c.open.fusion?.projects ?? []).some((p) => p.source !== 'manual');
    reading.rows = [];
    reading.modelsIn = false;
    reading.basisSet = false;
    reading.before = reading.stream ? { projects: (c.open.fusion?.projects ?? []).filter((p) => p.source === 'manual'), tr: c.open.tr } : null;
    fxStart();
  }

  /** Start a read (or follow the one running in this tenant), then put what it found in the customer open. */
  async function readCxOne({ auto = false, branches = next().allBranches ? 'all' : 'primary' } = {}) {
    if (!c.open || reading.timer || reading.starting || offline()) return;
    // One read followed at a time: a second start meanwhile (Connect and the page opening at once) is left out.
    reading.starting = true;
    reading.auto = auto;
    reading.branches = branches;
    follow();
    setStatus('calc-read-note', 'Reading the projects…', 'muted');
    try {
      // One branch per project (its primary branch) unless "Every branch" is ticked.
      readProgress(await api('/api/projections/read', { method: 'POST', body: JSON.stringify({ branches, maxProjects: readLimit(scope().maxProjects) }), quiet: true }));
      reading.starting = false;
      poll(400);
    } catch (error) {
      reading.starting = false;
      readProgress(null);
      leaveStream();
      settle(false);
      fxEnd(false, 'Checkmarx One could not be read');
      if (handleAuthLoss(error)) return;
      if (auto && error.status === 409) {
        fx.done = null;
        fxShow(false);
        return setStatus('calc-read-note', 'Not connected to Checkmarx One: connect it under Settings, or use the two exports.', 'muted');
      }
      showError('calc-read-note', error);
    }
  }

  /** A streamed customer left (or the read failed before anything came in): what it had before is put back. */
  function leaveStream() {
    if (!reading.stream || !reading.before) return;
    const customer = c.customers.find((x) => x.id === reading.customer) ?? (c.open?.id === reading.customer ? c.open : null);
    if (!customer) return;
    if (customer.fusion) customer.fusion.projects = reading.before.projects;
    customer.tr = reading.before.tr;
    // What waits to be saved for it keeps its own changes, not the projects shown meanwhile.
    if (c.pending?.id === customer.id && 'tr' in c.pending.patch) c.pending.patch.tr = reading.before.tr;
  }

  function poll(wait = 1500) {
    clearTimeout(reading.timer);
    reading.timer = setTimeout(async () => {
      let job;
      try {
        job = await api(`/api/projections/read?since=${reading.rows.length}`, { quiet: true });
      } catch (error) {
        reading.timer = null;
        readProgress(null);
        settle(false);
        fxEnd(false, 'Checkmarx One could not be read');
        if (!handleAuthLoss(error)) showError('calc-read-note', error);
        return;
      }
      if (job.state === 'running') {
        applyLive(job.live);
        readProgress(job);
        return poll();
      }
      reading.timer = null;
      readProgress(null);
      if (job.state === 'failed') {
        const some = reading.stream && reading.rows.length;
        settle(false);
        fxEnd(false, 'The read stopped');
        return setStatus('calc-read-note', `${job.error || 'Checkmarx One could not be read.'}${some ? ` The figures shown are from the ${num(some)} projects read before it stopped: read again for them all.` : ''}`, 'error');
      }
      const blank = c.open && ((!c.open.tr?.totals && !c.open.fusion?.projects?.length) || (reading.stream && c.open.id === reading.customer));
      if (job.state !== 'done' || !c.open || (c.open.id !== reading.customer && !blank)) {
        settle(false);
        fxEnd(false, 'Read for another customer');
        return renderReadNote();
      }
      const count = job.result?.projects?.length ?? 0;
      applyRead(job.result);
      settle(true);
      fxEnd(true, count === 1 ? '1 project read' : `${num(count)} projects read`);
    }, wait);
  }

  /** The tenant's models replace those read before; models typed here stay. A model already here by that name keeps its place (and so the projects set to it) and the credits typed for it. */
  function mergeModels(f, models) {
    const named = (n) => String(n ?? '').trim().toLowerCase();
    const fresh = models.map((t) => {
      const old = f.models.find((m) => m.id === t.id || named(m.name) === named(t.name));
      return old ? { ...t, id: old.id, creditsPer10k: t.creditsPer10k ?? old.creditsPer10k, description: t.description || old.description } : t;
    });
    const taken = new Set(fresh.map((m) => m.id));
    f.models = [...fresh, ...f.models.filter((m) => m.source !== 'tenant' && !taken.has(m.id))].slice(0, 20);
    if (!f.models.some((m) => m.id === f.defaultModel)) f.defaultModel = f.models[0]?.id ?? null;
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
    if (body.models?.length) mergeModels(f, body.models);
    // No number set for any frequency yet: start from the scans each group runs today.
    if (FREQUENCIES.every((q) => f.byFrequency[q.id].scans === null)) for (const q of FREQUENCIES) f.byFrequency[q.id].scans = suggestedScans(q.id, f.periodMonths);
    c.remainingCredits = body.remainingCredits ?? null;
    if (body.tr?.totals && body.tr?.fixed) {
      $('calc-alt').open = false;
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
    if (!c.open || reading.timer || reading.starting || offline()) return;
    const empty = !c.open.tr?.totals && !c.open.fusion?.projects?.length;
    let job = null;
    reading.starting = true;
    try {
      job = await api('/api/projections/read', { quiet: true });
    } catch {}
    reading.starting = false;
    if (!c.open || reading.timer) return;
    if (job?.state === 'running') {
      follow();
      readProgress(job);
      return poll(400);
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
      ['Project', 'Included', 'Criticality', 'Scanned today', 'Scans in the last year', 'Lines of code', '10K-LOC blocks', 'Fusion scans', 'Scans set by', 'Model', 'Credits per 10K LOC', 'Credits'],
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

  // --- Fusion visuals: four graphs over the counted Fusion, each one the user can mute (hide) ---
  const VIZ_COLOURS = ['#4f46e5', '#0d9488', '#d97706', '#db2777', '#2563eb', '#16a34a', '#9333ea', '#dc2626', '#0891b2', '#ca8a04', '#64748b'];
  const vizHidden = () => { try { return new Set(JSON.parse(localStorage.getItem('cx-fusion-viz-hidden') || '[]')); } catch { return new Set(); } };

  function renderFusionVisuals() {
    const panel = $('calc-fusion-viz-panel');
    const host = $('calc-fusion-viz');
    if (!panel || !host) return;
    const est = estimate();
    const fn = fnewEstimate();
    const parts = [fusionCounts(est) && est, fnewCounts(fn) && fn].filter(Boolean);
    const rows = parts.flatMap((p) => p.rows.filter((r) => r.included && r.units));
    if (!rows.length) { panel.hidden = true; host.innerHTML = ''; return; }
    panel.hidden = false;
    const totalCredits = rows.reduce((a, r) => a + (r.credits ?? 0), 0);
    // 1 · credit mix by model
    const byModel = new Map();
    for (const p of parts) for (const m of p.byModel ?? []) byModel.set(m.name || 'No model', (byModel.get(m.name || 'No model') ?? 0) + (m.credits ?? 0));
    const modelSeg = [...byModel.entries()].map(([label, value], i) => ({ label, value, colour: VIZ_COLOURS[i % VIZ_COLOURS.length] }));
    // 2 · 10K-LOC blocks by repository (top 12 by blocks)
    const repoBars = [...rows].sort((a, b) => (b.units ?? 0) - (a.units ?? 0)).slice(0, 12).map((r) => ({ label: r.name || '—', value: r.units ?? 0, sub: `${num(r.scans)} scans`, colour: PAGE_PALETTE.plan }));
    // 3 · credits over the projection period (accrue evenly)
    const months = Math.max(2, Math.min(horizon(), 36));
    const pts = Array.from({ length: months }, (_, i) => ({ label: `M${i + 1}`, credits: Math.round((totalCredits * (i + 1)) / months) }));
    // 4 · lines of code by language (from the new-code projects, which know their languages)
    const langs = new Map();
    for (const p of (fnewCounts(fn) ? (fnew()?.projects ?? []).filter((x) => x.included !== false) : [])) for (const [lang, n] of Object.entries(p.langs ?? {})) langs.set(lang, (langs.get(lang) ?? 0) + (wholeNumber(n) ?? 0));
    const langBars = [...langs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([label, value], i) => ({ label, value, colour: VIZ_COLOURS[i % VIZ_COLOURS.length] }));
    const cards = [
      ['mix', 'Credit mix by model', donutChart(modelSeg, { centre: num(Math.round(totalCredits)), title: 'Credit mix by model' })],
      ['repo', '10K-LOC blocks by repository', barChart(repoBars, { title: 'Blocks by repository' })],
      ['period', 'Credits over the period', lineChart(pts, [{ key: 'credits', colour: '#0d9488', label: 'Credits', area: true }], { width: 380, height: 190, title: 'Credits over the period' })],
      ['langs', 'Lines of code by language', barChart(langBars, { title: 'Lines by language' })],
    ].filter(([, , svg]) => svg);
    const hidden = vizHidden();
    host.innerHTML = cards.map(([id, title, svg]) => `
      <div class="calc-viz${hidden.has(id) ? ' muted' : ''}" data-viz="${id}">
        <div class="calc-viz-head"><h3>${esc(title)}</h3><label class="calc-viz-mute"><input type="checkbox" data-viz-mute="${id}" ${hidden.has(id) ? '' : 'checked'} /> Show</label></div>
        <div class="calc-viz-body">${svg}</div>
      </div>`).join('');
  }
  $('calc-fusion-viz')?.addEventListener('change', (event) => {
    const id = event.target?.dataset?.vizMute;
    if (!id) return;
    const hidden = vizHidden();
    if (event.target.checked) hidden.delete(id); else hidden.add(id);
    try { localStorage.setItem('cx-fusion-viz-hidden', JSON.stringify([...hidden])); } catch {}
    event.target.closest('.calc-viz')?.classList.toggle('muted', !event.target.checked);
  });

  function renderSummary() {
    gateImpact();
    queueMicrotask(renderBasis);
    $('calc-pdf').hidden = !(lastMade && lastMade.customerId === c.open?.id);
    if (!c.open) { $('calc-fusion-viz-panel') && ($('calc-fusion-viz-panel').hidden = true); return; }
    const fn = fnewEstimate();
    c.fusionNewCredits = fnewCounts(fn) ? fn.totals.credits : null;
    // Fusion for the customer's projects in Checkmarx One and for its new code, together.
    const sum = creditSummary(c.trCredits, fusionTotal({ totals: { credits: c.fusionCredits } }, { totals: { credits: c.fusionNewCredits } }), totals());
    $('calc-sum-tr').textContent = num(sum.trShown);
    $('calc-sum-tr-split').textContent = c.trSplit ? `${num(Math.round(c.trSplit.backlogCredits))} backlog + ${num(Math.round(c.trSplit.aheadCredits))} ahead` : '';
    // One Fusion figure, for the part that applies to this customer (ticked, with projects counted): both
    // added up when both do, with the split under it.
    const existing = c.fusionCredits !== null && c.fusionCredits !== undefined;
    const fresh = c.fusionNewCredits !== null && c.fusionNewCredits !== undefined;
    $('calc-sum-fusion-label').textContent = 'Fusion';
    $('calc-sum-fusion').textContent = existing || fresh ? num(Math.round((c.fusionCredits ?? 0) + (c.fusionNewCredits ?? 0))) : fusionOff() && fnewOff() ? 'Left out' : '—';
    const inUse = basis();
    $('calc-sum-fusion-split').textContent = existing && fresh ? `${num(Math.round(c.fusionCredits))} Checkmarx One + ${num(Math.round(c.fusionNewCredits))} counted code` : BASES[inUse] ? `Fusion · ${BASES[inUse].short}${existing || fresh ? '' : ' · nothing counted yet'}` : '';
    $('calc-sum-total').textContent = sum.tr === null && sum.fusion === null ? '—' : num(sum.totalShown);
    $('calc-sum-extra').textContent = num(sum.extraShown);
    $('calc-mix-extra').hidden = !(sum.extraShown > 0);
    $('calc-sum-bundles').textContent = sum.totalShown ? num(sum.bundlesShown) : '—';
    $('calc-sum-exact').textContent = sum.total && sum.bundles !== sum.exactBundles ? `${num(sum.exactBundles, 2)}, rounded up` : '';
    renderMix(sum, existing ? c.fusionCredits : 0, fresh ? c.fusionNewCredits : 0, existing || fresh);
    renderImpact();
    renderFusionVisuals();
  }

  /**
   * The strip's pictures: the bar of what the total is made of (each part's share is written by its
   * figure too, so the bar itself is only a picture), and the bundles as cells, the last filled to what is used.
   */
  function renderMix(sum, fusionExisting, fusionNew, fusionCounts) {
    const whole = sum.total > 0 ? sum.total : 0;
    const parts = [['tr', sum.tr ?? 0], ['fx', fusionExisting ?? 0], ['fn', fusionNew ?? 0], ['extra', sum.extra]].filter(([, v]) => v > 0);
    $('calc-mix-bar').replaceChildren(...(whole ? parts : []).map(([key, value]) => {
      const seg = document.createElement('i');
      seg.className = `calc-mix-seg calc-seg-${key}`;
      seg.style.flexGrow = String(value / whole);
      return seg;
    }));
    const share = (value) => {
      if (!whole || !(value > 0)) return '';
      const p = (value / whole) * 100;
      return p < 1 ? '<1%' : `${Math.round(p)}%`;
    };
    $('calc-mix-tr-pct').textContent = share(sum.tr);
    $('calc-mix-fusion-pct').textContent = share((fusionExisting ?? 0) + (fusionNew ?? 0));
    $('calc-mix-extra-pct').textContent = share(sum.extra);
    // Fusion's swatch: its part's colour, both colours when both count, grey when it does not count.
    const key = $('calc-mix-fusion');
    key.classList.toggle('calc-mix-both', fusionExisting > 0 && fusionNew > 0);
    key.classList.toggle('calc-mix-new-only', !(fusionExisting > 0) && fusionNew > 0);
    key.classList.toggle('calc-mix-off', !fusionCounts);
    $('calc-mix-tr').classList.toggle('calc-mix-off', sum.tr === null);
    // One cell a bundle while they fit; none past 60 (the figure says it).
    const n = whole ? sum.bundles : 0;
    const cells = $('calc-bundle-cells');
    cells.hidden = !n || n > 60;
    cells.classList.toggle('calc-cells-many', n > 12);
    cells.replaceChildren(...(cells.hidden ? [] : Array.from({ length: n }, (_, i) => {
      const cell = document.createElement('i');
      const used = sum.exactBundles - (n - 1);
      if (i === n - 1 && used < 0.995) {
        cell.className = 'calc-cell-part';
        cell.style.setProperty('--fill', `${Math.max(6, Math.round(used * 100))}%`);
      }
      return cell;
    })));
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
  // The credits per bundle, behind the "?" on Bundles: opens under it, closes with the "?", Escape or a click elsewhere.
  const bundlePop = (open) => {
    $('calc-bundle-item').hidden = !open;
    $('calc-bundle-q').setAttribute('aria-expanded', String(open));
    if (open) $('calc-bundle').focus();
  };
  $('calc-bundle-q').addEventListener('click', () => bundlePop($('calc-bundle-item').hidden));
  $('calc-bundle-item').addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' && event.key !== 'Enter') return;
    event.preventDefault();
    bundlePop(false);
    $('calc-bundle-q').focus();
  });
  document.addEventListener('click', (event) => {
    if (!$('calc-bundle-item').hidden && !event.target.closest('#calc-bundle-item, #calc-bundle-q')) bundlePop(false);
  });
  $('calc-bundle').addEventListener('input', (event) => c.open && setNext({ bundleCredits: event.target.value }, { redraw: false }));
  $('calc-extra').addEventListener('change', (event) => (event.target.value = next().extraPercent || ''));
  $('calc-bundle').addEventListener('change', (event) => (event.target.value = next().bundleCredits));

  /**
   * Everything a report shows, as figures: what the server keeps, and the file is built from. The figures
   * that move are worked out from its levers (levers.js), as the report's own script works them out again
   * when the customer changes one. Without project details nothing in it names a project.
   */
  function reportData() {
    const t = trFigures();
    const est = estimate();
    const fusionCounted = fusionCounts(est);
    const fn = fnewEstimate();
    const fnCounted = fnewCounts(fn);
    const who = me()?.user;
    const meta = tr()?.totals?.meta ?? {};
    const sc = scope();
    const details = $('calc-details')?.checked !== false;
    const levers = leverInputs({
      analysis: t?.analysis ?? null,
      sast: t?.sast ?? null,
      plan: tr() ?? {},
      months: horizon(),
      fusionOn: fusionOn(),
      recent: recentRates(t?.recent),
      weekly: t?.weekly ?? null,
      fusion: fusionCounted ? { settings: est.settings, projects: scoped(), remainingCredits: c.remainingCredits } : null,
      fusionNewRows: fnCounted ? fn.rows : null,
      totals: totals(),
      impact: impactOn() ? impact() : null,
      details,
    });
    const base = {
      version: 2,
      organisation: me()?.organisationName ?? '',
      customer: c.open.name,
      preparedBy: who?.name || who?.email || '',
      generatedAt: new Date().toISOString(),
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
        // The projects picked one by one, by name: only with the project details.
        details,
        ...(details ? { projectNames: sc.projects.map((id) => fusion().projects.find((p) => p.id === id)?.name ?? id) } : {}),
        // Not every scan origin: those whose scans were counted (Fusion only, when the backlog came from the two exports).
        ...(() => {
          const known = knownOrigins().map((x) => x.origin);
          if (!sc.origins || !known.length) return {};
          return { origins: known.filter((o) => sc.origins.includes(o)), ...(t && meta.source !== 'cxone' ? { originsFusionOnly: true } : {}) };
        })(),
      },
      tr: null,
      fusion: null,
      // What the triage & remediation credits give back, with this customer's assumptions (worked out with the rest).
      impact: impactOn() ? true : null,
      // Fusion for the customer's new code (not in Checkmarx One yet): its lines counted from git (cloc-fusion's
      // engine, with how often each repository changes), read from a cloc-fusion report, or counted with cloc.
      fusionNew: fnCounted
        ? {
            periodMonths: fn.settings.periodMonths,
            defaultScans: fn.settings.defaultScans,
            defaultModel: fn.settings.defaultModel,
            models: fn.settings.models,
            rules: fn.settings.byFrequency,
            leftOut: fn.settings.leftOut,
            byModel: fn.byModel,
            byFrequency: fn.byFrequency,
            totals: fn.totals,
            details,
            rows: details ? fn.rows.map((r) => ({ name: r.name, file: r.file, included: r.included, lines: r.lines, units: r.units, frequency: r.frequency, commits: r.commits, windowDays: r.activity?.windowDays ?? null, devs90: r.devs90, criticality: r.criticality, scans: r.scans, scansFrom: r.scansFrom, model: r.model, credits: r.credits, languages: r.languages.filter((l) => l.counted && l.lines > 0).slice(0, 6) })) : [],
          }
        : null,
    };
    // The Fusion estimates side by side (ticked, and when more than one has projects): the one in the credits marked.
    if ($('calc-compare')?.checked !== false) {
      const all = estimates();
      const inUse = basis();
      const rows = Object.entries(BASES)
        .filter(([b]) => all[b]?.projects)
        .map(([b, d]) => ({ key: b, label: d.title, what: d.what, projects: all[b].projects, lines: all[b].lines, units: all[b].units, scans: all[b].scans, credits: all[b].credits, used: inUse === b || (inUse === 'both' && b !== 'cloc') }));
      if (rows.length > 1) base.fusionCompare = { periodMonths: horizon(), rows };
    }
    // Open vulnerabilities by project and severity (ticked, with the project names): from the last read of Checkmarx One.
    if ($('calc-sev-report')?.checked && details) {
      const rows = (fusion()?.projects ?? [])
        .filter((p) => p.source !== 'manual' && p.openBySeverity)
        .map((p) => ({ name: p.name, sev: Object.fromEntries(SEVERITIES.map((s) => [s, p.openBySeverity[s] ?? 0])) }))
        .map((r) => ({ ...r, total: SEVERITIES.reduce((n, s) => n + r.sev[s], 0) }))
        .filter((r) => r.total > 0)
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
      if (rows.length) base.bySeverity = { severities: [...SEVERITIES], rows };
    }
    return { ...leverData(base, levers), levers };
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
      const html = await reportHtml(data, report.createdAt);
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
    const count = $('calc-saved-count');
    if (count) count.textContent = c.reports.length ? `(${num(c.reports.length)})` : '';
    $('calc-reports').innerHTML = c.reports
      .map(
        (r) => `<tr data-report="${esc(r.id)}">
        <td translate="no">${esc(r.customer)}</td>
        <td><time translate="no">${esc(fmtDateTime(r.createdAt))}</time></td>
        <td translate="no">${esc(r.createdBy)}</td>
        <td class="num">${r.trCredits === null ? '—' : num(Math.round(r.trCredits))}</td>
        <td class="num">${r.fusionCredits === null ? '—' : num(Math.round(r.fusionCredits))}</td>
        <td class="num">${r.extraPercent ? `${num(r.extraPercent, 2)}%` : '—'}</td>
        <td class="num"><b>${num(Math.round(r.totalCredits))}</b></td>
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
        download(new Blob([await reportHtml(report.data, report.createdAt)], { type: 'text/html' }), reportFileName(report.customer, report.createdAt));
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
  return {
    load,
    renderOrg,
    // Read Checkmarx One now (Connect): after a read this page is starting by itself, never a second one.
    read: async () => {
      for (let i = 0; i < 50 && reading.starting; i += 1) await new Promise((r) => setTimeout(r, 100));
      if (!reading.timer && c.open) applyAll({ read: true });
    },
    refresh: () => c.open && show(c.open),
    autoRead,
    git: { add: addGitToken, count: () => autoCount(), counting: () => Boolean(git.run || git.autoBusy), list: gitTokens, remove: removeGitToken, detect: detectProvider, onChange: (fn) => (git.onTokens = fn), open: () => document.querySelector('[data-ptabs] [data-pt="fusion-git"]')?.click() },
  };
}

