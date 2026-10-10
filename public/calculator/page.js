// Cx Credits Calculator (#/calculator): customers, each with a triage & remediation projection
// (two Checkmarx One exports and a plan per severity) and a Fusion projection (how many Fusion
// scans each project needs, and what they cost), and the projection reports made from them.
// Saved on the server as you go (src/projections.js). The arithmetic is model.js; the charts
// charts.js; the downloaded report report.js.

import {
  CRITICALITIES,
  FREQUENCIES,
  LOOKBACKS,
  SEVERITIES,
  amount,
  analyse,
  backlogForecast,
  creditSummary,
  fusionEstimate,
  fusionSettings,
  seriesRows,
  severityForecast,
  suggestedScans,
  totalsSettings,
  trCost,
  weeklyTrend,
  wholeNumber,
} from './model.js';
import { SEVERITY_COLOURS, backlogTrendChart, forecastChart, ratesChart, severityChart } from './charts.js';
import { buildReport, reportFileName } from './report.js';

const OPEN_KEY = 'mz-calc-customer';
const FREQ_LABEL = Object.fromEntries(FREQUENCIES.map((f) => [f.id, f.label]));
const FROM_LABEL = { default: 'Default', frequency: 'Scan frequency', criticality: 'Criticality', project: 'Set here' };
const SOURCE_LABEL = {
  'sast-metadata': 'Counted by the last scan (SAST scan metadata)',
  scan: 'Counted by the last scan (the scan’s SAST details)',
  none: 'Its last scan did not count lines of code: type them in',
  manual: 'Added by hand',
};

export function initCalculator({ api, $, esc, toast, setStatus, showError, handleAuthLoss, fmtDateTime, me, can }) {
  const c = { customers: [], open: null, pending: null, timer: null, saving: null, draft: {}, dirty: {}, present: false, remainingCredits: null, reports: [] };
  const num = (n, digits = 0) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: digits }));
  const pct = (n) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`);
  const savedAt = (iso) => `<time datetime="${esc(iso)}" translate="no">${esc(new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</time>`;

  // ---- Customers ----------------------------------------------------------------------------

  async function load({ reopen = true } = {}) {
    let body;
    try {
      body = await api('/api/projections');
    } catch (error) {
      if (handleAuthLoss(error)) return;
      setStatus('calc-saved', error.message, 'error');
      return;
    }
    c.customers = body.customers ?? [];
    renderCustomers();
    renderOrg();
    if (!reopen && c.open && c.customers.some((x) => x.id === c.open.id)) return loadReports();
    let last = '';
    try {
      last = localStorage.getItem(OPEN_KEY) || '';
    } catch {}
    const first = c.customers.find((x) => x.id === last) ?? c.customers[0];
    if (first) await open(first.id);
    else show(null);
  }

  function renderCustomers() {
    $('calc-empty').hidden = c.customers.length > 0;
    $('calc-customer').innerHTML = c.customers.map((x) => `<option value="${esc(x.id)}"${x.id === c.open?.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
    for (const id of ['calc-customer', 'calc-name', 'calc-delete', 'calc-generate', 'calc-extra', 'calc-bundle']) $(id).disabled = !c.open;
  }

  function renderOrg() {
    const org = me()?.organisationName;
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
      return;
    }
    try {
      localStorage.setItem(OPEN_KEY, customer.id);
    } catch {}
    $('calc-name').value = customer.name;
    c.trCredits = null;
    c.fusionCredits = null;
    $('calc-extra').value = totals().extraPercent || '';
    $('calc-bundle').value = totals().bundleCredits;
    saved('Saved', customer.updatedAt, 'muted');
    syncDraft();
    setStatus('calc-upload-status', '');
    setStatus('calc-read-note', '');
    renderTr();
    renderFusion();
    loadReports();
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
  $('calc-new').addEventListener('click', async () => {
    await flush();
    try {
      const { customer } = await api('/api/projections', { method: 'POST', body: JSON.stringify({ name: `Customer ${c.customers.length + 1}` }) });
      c.customers = [...c.customers, { id: customer.id, name: customer.name, updatedAt: customer.updatedAt }];
      show(customer);
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
      c.draft[s] = { selected: tr().selected[s] ?? 0, triageCost: tr().triageCost[s], fpPercent: tr().fpPercent[s], remediationCost: tr().remediationCost[s] };
      c.dirty[s] = false;
    }
  }

  /** The figures behind the tab and the report: null until both exports are in. */
  function trFigures() {
    if (!c.open?.tr?.totals || !c.open.tr.fixed) return null;
    const { totalRows, fixedRows } = seriesRows(tr().totals, tr().fixed);
    const analysis = analyse(totalRows, fixedRows, tr().lookbackMonths);
    if (!analysis) return null;
    const cost = trCost(analysis, tr());
    return {
      analysis,
      cost,
      weekly: weeklyTrend(totalRows, fixedRows, 52),
      forecast: backlogForecast(analysis, cost.totals.selected, 6),
      severityForecast: severityForecast(analysis, cost, 3),
    };
  }

  let vendor = null;
  /** The .xlsx reader and the export parser, loaded the first time a file is read. */
  function readers() {
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
        const response = await fetch(`calculator/samples/${name}`);
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
    for (const slot of ['totals', 'fixed']) {
      const s = tr()?.[slot];
      $(`calc-slot-${slot}`).classList.toggle('ok', Boolean(s));
      $(`calc-file-${slot}-name`).innerHTML = s ? `${s.meta?.fileName ? `<span translate="no">${esc(s.meta.fileName)}</span>` : '<span>Saved data</span>'} · <span>${num(s.weeks.length)} weeks</span> · <span translate="no">${esc(s.weeks[0])} → ${esc(s.weeks[s.weeks.length - 1])}</span>` : 'Choose or drop the .xlsx export';
    }
  }

  function renderTr() {
    if (!c.open) return;
    renderSlots();
    const f = trFigures();
    c.trCredits = f ? f.cost.totals.credits : null;
    renderSummary();
    if (!f) {
      $('calc-tr').innerHTML = `<p class="hint calc-wait">Upload both exports from the customer's Checkmarx One (or load the sample data) to see their backlog, its trend and the credits a plan takes.</p>`;
      return;
    }
    const { analysis, cost } = f;
    const lookback = (m) => (m ? `${m}-month` : 'latest');
    const sevHead = (s) => `<th><span class="calc-sev"><i translate="no" style="background:${SEVERITY_COLOURS[s]}"></i>${s}</span></th>`;
    const row = (label, cells, total, cls = '') => `<tr class="${cls}"><td>${label}</td>${cells.map((v) => `<td class="num">${v}</td>`).join('')}<td class="num calc-total">${total}</td></tr>`;
    const R = cost.rows;
    $('calc-tr').innerHTML = `
      <p class="calc-snapshot">Backlog as of <time>${esc(analysis.latestDate)}</time>, compared with <time>${esc(analysis.previousDate)}</time>.</p>
      <section class="panel calc-edit">
        <h2>Choose what to fix</h2>
        <p class="hint">Per severity: how many open findings to triage, the false positives expected, and the credits triage and remediation take. Changes count once you select <strong>Apply</strong>.</p>
        <div class="calc-sev-grid">${SEVERITIES.map((s) => {
          const d = c.draft[s];
          const open = analysis.perSeverity[s].current;
          return `<div class="calc-sev-box" data-sev="${s}">
            <div class="calc-sev-top"><span class="calc-sev"><i translate="no" style="background:${SEVERITY_COLOURS[s]}"></i>${s}</span><span class="hint">${num(open)} open</span></div>
            <input type="range" min="0" max="${open}" value="${Math.min(d.selected, open)}" data-f="selected" aria-label="${s}: to triage" />
            <div class="calc-row"><input type="number" min="0" max="${open}" value="${Math.min(d.selected, open)}" data-f="selected" aria-label="${s}: to triage" />
              <span><button type="button" class="ghost small-btn" data-set="0">None</button><button type="button" class="ghost small-btn" data-set="${open}">All</button></span></div>
            <label class="calc-row"><span>Credits per triage</span><input type="number" min="0" step="0.5" value="${d.triageCost}" data-f="triageCost" /></label>
            <label class="calc-row"><span>False positives %</span><input type="number" min="0" max="100" step="1" value="${d.fpPercent}" data-f="fpPercent" /></label>
            <label class="calc-row"><span>Credits per remediation</span><input type="number" min="0" step="0.5" value="${d.remediationCost}" data-f="remediationCost" /></label>
            <button type="button" class="${c.dirty[s] ? 'primary' : 'secondary'} calc-apply" data-apply${c.dirty[s] ? '' : ' disabled'}>${c.dirty[s] ? 'Apply' : 'Applied'}</button>
          </div>`;
        }).join('')}</div>
        <p class="hint">Credits per triage and per remediation start at Checkmarx One's 1 and 3: set them to the customer's agreement. The false-positive rate is your estimate for this customer.</p>
      </section>
      <section class="panel">
        <h2>The last ${num(Math.round(f.weekly.length / 4.345))} months, week by week</h2>
        <p class="hint">How the backlog, the fix rate and the rate the debt grows moved each week: where the current backlog comes from.</p>
        <div class="calc-pair"><div><h3>Backlog (open vulnerabilities)</h3>${backlogTrendChart(f.weekly)}</div><div><h3>Fix rate and debt increase rate (%)</h3>${ratesChart(f.weekly)}</div></div>
      </section>
      <section class="panel">
        <div class="calc-section-head"><h2>Final matrix</h2>
          <div class="calc-lookback calc-edit" role="group" aria-label="Period for debt increase and fix rate">${LOOKBACKS.map((m) => `<button type="button" class="${tr().lookbackMonths === m ? 'on' : ''}" data-lookback="${m}">${m ? `${m} months` : 'Latest'}</button>`).join('')}</div></div>
        <p class="hint">Every figure that matters, by severity. Debt increase and fix rate: ${lookback(tr().lookbackMonths) === 'latest' ? 'the latest week' : `over the last ${tr().lookbackMonths} months`}.</p>
        <div class="table-wrap"><table class="data-table calc-matrix">
          <thead><tr><th>Figure</th>${SEVERITIES.map(sevHead).join('')}<th class="num">Total</th></tr></thead>
          <tbody>
            ${row('Current backlog', SEVERITIES.map((s) => num(analysis.perSeverity[s].current)), num(analysis.total.current))}
            ${row('Debt increase', SEVERITIES.map((s) => pct(analysis.perSeverity[s].debtRate)), pct(analysis.total.debtRate), 'muted')}
            ${row('Fix rate', SEVERITIES.map((s) => pct(analysis.perSeverity[s].fixRate)), pct(analysis.total.fixRate), 'muted')}
            ${row('To triage', SEVERITIES.map((s) => num(R[s].selected)), num(cost.totals.selected), 'strong')}
            ${row('Credits per triage', SEVERITIES.map((s) => num(R[s].triageCost, 2)), '—', 'muted')}
            ${row('False positives (estimated)', SEVERITIES.map((s) => `${num(R[s].fp)}%`), '—', 'muted')}
            ${row('True positives (estimated)', SEVERITIES.map((s) => num(R[s].truePositives)), num(cost.totals.truePositives))}
            ${row('Credits per remediation', SEVERITIES.map((s) => num(R[s].remediationCost, 2)), '—', 'muted')}
            ${row('Triage credits', SEVERITIES.map((s) => num(R[s].triageCredits, 1)), num(cost.totals.triageCredits, 1))}
            ${row('Remediation credits', SEVERITIES.map((s) => num(R[s].remediationCredits, 1)), num(cost.totals.remediationCredits, 1))}
            ${row('Credits', SEVERITIES.map((s) => num(R[s].credits, 1)), num(cost.totals.credits, 1), 'gold')}
            ${row('Backlog after', SEVERITIES.map((s) => num(R[s].backlogAfter)), num(cost.totals.backlogAfter))}
          </tbody></table></div>
      </section>
      <div class="calc-kpis">
        <div class="rp-kpi"><span class="rp-tile-label">Findings to triage</span><span class="rp-kpi-value">${num(cost.totals.selected)}</span><span class="rp-tile-sub">of ${num(analysis.total.current)} open</span></div>
        <div class="rp-kpi"><span class="rp-tile-label">Estimated true positives</span><span class="rp-kpi-value">${num(cost.totals.truePositives)}</span><span class="rp-tile-sub">to remediate</span></div>
        <div class="rp-kpi calc-gold"><span class="rp-tile-label">Credits</span><span class="rp-kpi-value">${num(cost.totals.credits, 1)}</span><span class="rp-tile-sub">${num(cost.totals.triageCredits, 1)} triage + ${num(cost.totals.remediationCredits, 1)} remediation</span></div>
        <div class="rp-kpi"><span class="rp-tile-label">Backlog cleared</span><span class="rp-kpi-value">${analysis.total.current ? `${((cost.totals.selected / analysis.total.current) * 100).toFixed(1)}%` : '—'}</span><span class="rp-tile-sub">of the current backlog</span></div>
      </div>
      <section class="panel">
        <h2>Backlog trend and forecast</h2>
        <p class="hint">${analysis.monthlyChange >= 0 ? `The backlog grew by ${num(analysis.monthlyChange)} a month on average recently: fixes are not keeping pace with new findings.` : `The backlog shrank by ${num(-analysis.monthlyChange)} a month on average recently.`}</p>
        ${forecastChart(f.forecast)}
      </section>
      <section class="panel">
        <h2>3-month plan by severity</h2>
        <p class="hint">Solid: the backlog so far. Dashed: the next 3 months with the findings above fixed evenly, against the pace new ones arrive. Log scale, as severities differ by orders of magnitude.</p>
        ${severityChart(f.severityForecast)}
      </section>`;
  }

  function setDraft(box, field, value) {
    const s = box.dataset.sev;
    const max = Number(box.querySelector('input[type="range"]').max);
    let v = amount(value) ?? 0;
    if (field === 'selected') {
      v = Math.min(max, Math.round(v));
      for (const input of box.querySelectorAll('[data-f="selected"]')) if (Number(input.value) !== v) input.value = v;
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
      c.open.tr = {
        ...tr(),
        selected: { ...tr().selected, [s]: d.selected },
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
  });

  // ---- Fusion -------------------------------------------------------------------------------

  const fusion = () => c.open.fusion;
  const estimate = () => fusionEstimate(fusion().projects, fusion());
  const saveFusion = () => save({ fusion: fusion() });
  const modelOptions = (selected, blank) =>
    `<option value="">${esc(blank)}</option>` + fusion().models.map((m) => `<option value="${esc(m.id)}"${m.id === selected ? ' selected' : ''}>${esc(m.name || 'Unnamed model')}${m.creditsPer10k === null ? '' : ` · ${num(m.creditsPer10k, 2)}`}</option>`).join('');
  const shown = () => {
    const words = $('calc-filter').value.trim().toLowerCase();
    return estimate().rows.filter((p) => !words || String(p.name).toLowerCase().includes(words));
  };

  function renderFusion() {
    if (!c.open) return;
    const f = fusion();
    $('calc-period').value = f.periodMonths;
    $('calc-default-scans').value = f.defaultScans;
    $('calc-combine').value = f.combine;
    $('calc-default-model').innerHTML = modelOptions(f.defaultModel, f.models.length ? 'No model' : 'No model yet');
    const note = $('calc-read-note');
    if (!note.classList.contains('error') && !note.classList.contains('ok') && !note.classList.contains('warn')) {
      note.className = 'hint';
      note.innerHTML = f.readAt ? `Last read <time translate="no">${esc(fmtDateTime(f.readAt))}</time>` : '';
    }
    renderModels();
    renderRules();
    renderProjects();
  }

  function renderModels() {
    const f = fusion();
    $('calc-models-empty').hidden = f.models.length > 0;
    $('calc-models').innerHTML = f.models
      .map(
        (m) => `<tr data-model="${esc(m.id)}">
        <td><input type="text" value="${esc(m.name)}" maxlength="80" data-m="name" aria-label="Model name" translate="no" placeholder="Model name" />${m.description ? `<small class="hint" translate="no">${esc(m.description)}</small>` : ''}</td>
        <td><input type="text" inputmode="decimal" class="calc-num" value="${m.creditsPer10k ?? ''}" data-m="creditsPer10k" aria-label="Credits per 10K LOC" placeholder="Not known" /></td>
        <td>${m.source === 'tenant' ? 'Checkmarx One' : 'Typed here'}</td>
        <td><button type="button" class="ghost calc-remove" data-remove-model>Remove</button></td></tr>`,
      )
      .join('');
  }

  function renderRules() {
    const f = fusion();
    const rows = f.projects;
    const ruleRow = (key, label, count, rule, attr) => `<tr ${attr}="${key}">
      <td>${label}</td><td class="num">${num(count)}</td>
      <td><input type="text" inputmode="numeric" class="calc-num" value="${rule.scans ?? ''}" data-r="scans" placeholder="${num(f.defaultScans)} (default)" aria-label="Fusion scans per project" /></td>
      <td><select data-r="model" aria-label="Model">${modelOptions(rule.model, 'Default model')}</select></td></tr>`;
    $('calc-freq').innerHTML = FREQUENCIES.map((q) => ruleRow(q.id, q.label, rows.filter((p) => p.frequency === q.id).length, f.byFrequency[q.id], 'data-freq')).join('');
    $('calc-crit').innerHTML = [...CRITICALITIES.map((k) => ruleRow(k, `${k}${k === 5 ? ' (most critical)' : k === 1 ? ' (least critical)' : ''}`, rows.filter((p) => p.criticality === k).length, f.byCriticality[k], 'data-crit'))].join('');
  }

  function renderKpis(est = estimate()) {
    const t = est.totals;
    c.fusionCredits = est.rows.some((r) => r.included && r.units) ? t.credits : null;
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

  function renderProjects() {
    const est = estimate();
    const words = $('calc-filter').value.trim().toLowerCase();
    const rows = est.rows.filter((p) => !words || String(p.name).toLowerCase().includes(words));
    $('calc-rows').innerHTML = rows.map(rowHtml).join('');
    $('calc-rows-empty').hidden = est.rows.length > 0 && rows.length > 0;
    if (est.rows.length && !rows.length) $('calc-rows-empty').textContent = 'No project matches that name.';
    renderKpis(est);
  }

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
  $('calc-period').addEventListener('change', () => {
    fusion().periodMonths = wholeNumber($('calc-period').value) ?? 12;
    settingsChanged();
    renderFusion();
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

  $('calc-filter').addEventListener('input', renderProjects);
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

  $('calc-read').addEventListener('click', async () => {
    if (!c.open) return;
    const id = c.open.id;
    setStatus('calc-read-note', '');
    try {
      const body = await api('/api/projections/fusion/read', { method: 'POST' });
      if (c.open?.id !== id) return;
      const f = fusion();
      const before = new Map(f.projects.map((p) => [p.id, p]));
      const keep = (p) => ({ locOverride: before.get(p.id)?.locOverride ?? null, included: before.get(p.id)?.included ?? true, scansOverride: before.get(p.id)?.scansOverride ?? null, modelOverride: before.get(p.id)?.modelOverride ?? null });
      const read = body.projects.map((p) => ({ ...p, ...keep(p) }));
      const ids = new Set(read.map((p) => p.id));
      const gone = f.projects.filter((p) => p.source !== 'manual' && !ids.has(p.id)).length;
      f.projects = [...read, ...f.projects.filter((p) => p.source === 'manual')];
      f.readAt = body.readAt;
      // The tenant's models replace those read before; models typed here stay.
      if (body.models?.length) {
        f.models = [...body.models, ...f.models.filter((m) => m.source !== 'tenant' && !body.models.some((t) => t.id === m.id))].slice(0, 20);
        if (!f.models.some((m) => m.id === f.defaultModel)) f.defaultModel = f.models[0]?.id ?? null;
      }
      c.remainingCredits = body.remainingCredits ?? null;
      renderFusion();
      saveFusion();
      if (read.length === 1) setStatus('calc-read-note', 'Read 1 project from Checkmarx One.', 'ok');
      else setStatus('calc-read-note', `Read ${num(read.length)} projects from Checkmarx One.`, 'ok');
      if (!body.models?.length) toast('Checkmarx One did not say which Fusion models it offers: add them under Fusion models, with their credits per 10K LOC.', 'warn', 9000);
      if (gone === 1) toast('1 project read before is no longer in Checkmarx One: it was taken off.', 'warn');
      else if (gone) toast(`${num(gone)} projects read before are no longer in Checkmarx One: they were taken off.`, 'warn');
    } catch (error) {
      if (!handleAuthLoss(error)) showError('calc-read-note', error);
    }
  });

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
      ...est.rows.map((r) => [r.name, r.included ? 'yes' : 'no', r.criticality ?? '', FREQ_LABEL[r.frequency] ?? '', r.scanCount ?? '', r.lines ?? '', r.units, r.scans, FROM_LABEL[r.scansFrom] ?? '', models.get(r.model)?.name ?? '', r.rate ?? '', r.credits ?? '']),
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

  function renderSummary() {
    if (!c.open) return;
    const sum = creditSummary(c.trCredits, c.fusionCredits, totals());
    $('calc-sum-tr').textContent = num(sum.tr, 1);
    $('calc-sum-fusion').textContent = num(sum.fusion, 1);
    $('calc-sum-total').textContent = sum.tr === null && sum.fusion === null ? '—' : num(sum.total, 1);
    $('calc-sum-extra').textContent = sum.extra ? `Includes ${num(sum.extra, 1)} extra` : '';
    $('calc-sum-bundles').textContent = sum.total ? num(sum.bundles) : '—';
    $('calc-sum-exact').textContent = sum.total && sum.bundles !== sum.exactBundles ? `${num(sum.exactBundles, 2)}, rounded up` : '';
  }

  function setTotals(field, input) {
    if (!c.open) return;
    c.open.totals = totalsSettings({ ...totals(), [field]: input.value });
    renderSummary();
    save({ totals: c.open.totals });
  }
  $('calc-extra').addEventListener('input', (event) => setTotals('extraPercent', event.target));
  $('calc-bundle').addEventListener('input', (event) => setTotals('bundleCredits', event.target));
  $('calc-extra').addEventListener('change', (event) => (event.target.value = totals().extraPercent || ''));
  $('calc-bundle').addEventListener('change', (event) => (event.target.value = totals().bundleCredits));

  /** Everything a report shows, as figures: what the server keeps, and the file is built from. */
  function reportData() {
    const t = trFigures();
    const est = estimate();
    const fusionCounted = est.rows.some((r) => r.included && r.units);
    const who = me()?.user;
    const summary = creditSummary(t ? t.cost.totals.credits : null, fusionCounted ? est.totals.credits : null, totals());
    return {
      summary,
      organisation: me()?.organisationName ?? '',
      customer: c.open.name,
      preparedBy: who?.name || who?.email || '',
      generatedAt: new Date().toISOString(),
      tr: t
        ? {
            asOf: t.analysis.latestDate,
            previousDate: t.analysis.previousDate,
            lookbackMonths: t.analysis.lookbackMonths,
            rows: t.cost.rows,
            totals: t.cost.totals,
            analysis: { ...Object.fromEntries(SEVERITIES.map((s) => [s, { debtRate: t.analysis.perSeverity[s].debtRate, fixRate: t.analysis.perSeverity[s].fixRate }])), total: { debtRate: t.analysis.total.debtRate, fixRate: t.analysis.total.fixRate } },
            monthlyChange: t.analysis.monthlyChange,
            history: t.analysis.history.map((h) => ({ month: h.month })),
            weekly: t.weekly,
            forecast: t.forecast,
            severityForecast: t.severityForecast,
          }
        : null,
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
    };
  }

  $('calc-generate').addEventListener('click', async () => {
    if (!c.open) return;
    await flush();
    const data = reportData();
    if (!data.tr && !data.fusion) return toast('Nothing to report yet: upload the two exports, or read the Fusion projects first.', 'warn');
    try {
      const { report } = await api('/api/projections/reports', { method: 'POST', body: JSON.stringify({ customerId: c.open.id, data }) });
      download(new Blob([buildReport({ ...data, generatedAt: report.createdAt })], { type: 'text/html' }), reportFileName(report.customer, report.createdAt));
      loadReports();
    } catch (error) {
      if (!handleAuthLoss(error)) toast(error.message, 'bad');
    }
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
        <td><button type="button" class="secondary" data-download>Download</button> ${can('reports.delete') ? '<button type="button" class="ghost calc-remove" data-delete-report>Delete</button>' : ''}</td></tr>`,
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
        download(new Blob([buildReport({ ...report.data, generatedAt: report.createdAt })], { type: 'text/html' }), reportFileName(report.customer, report.createdAt));
      } else if (event.target.closest('[data-delete-report]')) {
        if (!confirm('Delete this projection report? It cannot be undone.')) return;
        await api(`/api/projections/reports/${encodeURIComponent(id)}`, { method: 'DELETE' });
        loadReports();
      }
    } catch (error) {
      if (!handleAuthLoss(error)) toast(error.message, 'bad');
    }
  });

  return { load, renderOrg };
}

