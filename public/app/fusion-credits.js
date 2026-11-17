// Credits → Fusion credits: credits for Fusion scans only (src/routes/fusion-credits.js). The plan (from the Cx Credits
// Calculator, or changed here), each project's recommendation on its branch, allocating, scheduling the planned
// scans, what was used, and the rates (Admins only).
import { $, state } from './state.js';
import { escapeHtml, fmtDateTime } from './format.js';
import { api, handleAuthLoss, setStatus, showError, toast } from './core.js';

const fc = { data: null, plans: null, polling: null, ratesDraft: null, open: null };
const num = (n, digits = 2) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: digits }));
const FREQ_SHORT = {
  'more-5-week': 'more than 5 a week',
  '1-5-week': '1–5 a week',
  '2-weeks': 'once in 2 weeks',
  month: 'once a month',
  '2-months': 'once in 2 months',
  '3-months': 'once in 3 months',
  '6-months': 'once in 6 months',
  year: 'once a year',
  rare: 'not in the last year',
};
const HOW = { primary: 'its primary branch', guessed: 'no primary branch set: main or master', latest: 'its latest scan\'s branch', none: 'its primary branch was never scanned', unknown: 'the scans do not say their branch' };

export async function loadFusionCredits({ quiet = false } = {}) {
  try {
    fc.data = await api('/api/fusion-credits');
    if (!quiet) fc.ratesDraft = null;
    render();
    if (fc.data.may.allocate && fc.plans === null) loadPlans();
    follow();
  } catch (error) {
    if (handleAuthLoss(error)) return;
    showError('fc-status', error);
  }
}

async function loadPlans() {
  try {
    fc.plans = (await api('/api/fusion-credits/plans')).plans;
  } catch {
    fc.plans = [];
  }
  renderPlanPick();
}

/** While a read runs: the page follows it, then shows what it found. */
function follow() {
  clearTimeout(fc.polling);
  if (fc.data?.job?.state !== 'running') return;
  fc.polling = setTimeout(async () => {
    if (state.page !== 'fusioncredits') return;
    await loadFusionCredits({ quiet: true });
  }, 1500);
}

function render() {
  const d = fc.data;
  if (!d) return;
  renderStatus();
  renderTiles();
  renderPlan();
  renderProjects();
  renderUsed();
  renderRates();
}

function renderStatus() {
  const { job, read } = fc.data;
  if (job.state === 'running') {
    const step = { projects: 'Reading the projects…', facts: 'Reading the Fusion projects\' models and lines of code…', scans: `Reading their scans: ${job.done} of ${job.total}…` }[job.step] ?? 'Reading…';
    setStatus('fc-status', step);
  } else if (job.state === 'failed') setStatus('fc-status', `The read stopped: ${job.error}`, 'error');
  else if (!read) setStatus('fc-status', fc.data.may.allocate ? 'Read projects to see the tenant\'s Fusion projects and what each needs.' : 'Nobody has read the tenant\'s Fusion projects yet.', 'muted');
  else setStatus('fc-status', `Read ${fmtDateTime(read.at)}${read.checkedAt && read.checkedAt !== read.at ? ` · projects given credits checked ${fmtDateTime(read.checkedAt)}` : ''}.`, 'muted');
  $('fc-read').disabled = job.state === 'running';
}

function renderTiles() {
  const { tenant, recommended, settings, projects } = fc.data;
  const tile = (label, value, sub) => `<div><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(value)}</span><span class="hint">${escapeHtml(sub)}</span></div>`;
  const fusionProjects = projects.filter((p) => p.scanType === 'fusion').length;
  $('fc-tiles').innerHTML = [
    tile('Tenant credits left (Checkmarx One)', num(tenant.available), tenant.readAt ? `read ${fmtDateTime(tenant.readAt)}` : 'not read yet'),
    tile('Held for Triage & Remediation', num(tenant.triageRemediationHeld), 'allocated, not used yet'),
    tile('Held for Fusion', num(tenant.fusionHeld), 'allocated, not used yet'),
    tile('Free to allocate', num(tenant.free), 'for either, never both'),
    tile(`Fusion recommended, ${settings.plan.periodMonths} months`, num(recommended), `${fusionProjects} project(s) with Fusion scans`),
  ].join('');
}

function renderPlan() {
  const { settings, frequencies } = fc.data;
  const plan = settings.plan;
  const src = plan.source ?? {};
  $('fc-plan-source').textContent = src.kind === 'calculator' || src.kind === 'file'
    ? `The plan is the Cx Credits Calculator's "${src.name}"${src.kind === 'file' ? ' (opened from a file)' : ''}, taken ${src.at ? fmtDateTime(src.at) : ''}${src.by ? ` by ${src.by}` : ''}: ${plan.periodMonths} months, ${plan.projectCount} project(s) with choices of their own${src.changedAt ? `; changed here ${fmtDateTime(src.changedAt)}` : ''}.`
    : `The plan is this page's own: ${plan.periodMonths} months, the Fusion scans for each change frequency below.`;
  const period = $('fc-period');
  if (![...period.options].some((o) => o.value === String(plan.periodMonths))) period.add(new Option(`${plan.periodMonths} months`, String(plan.periodMonths)));
  period.value = String(plan.periodMonths);
  const may = fc.data.may.allocate;
  $('fc-freq').innerHTML = frequencies.map((f) => `<label class="fc-freq-item" title="${escapeHtml(f.label)}"><input type="number" min="0" max="10000" step="1" data-fc-freq="${escapeHtml(f.id)}" value="${escapeHtml(String(plan.byFrequency[f.id]?.scans ?? ''))}"${may ? '' : ' disabled'} /> <span>${escapeHtml(FREQ_SHORT[f.id] ?? f.label)}</span></label>`).join('');
  period.disabled = !may;
  const rates = settings.rates;
  const calc = plan.calculatorRates ?? {};
  $('fc-rates-line').innerHTML = `${escapeHtml('Rates, credits per 10K lines (Rates tab):')} ${Object.keys(rates).sort().map((m) => `<span class="fusion-model" translate="no">${escapeHtml(m)}</span> ${rates[m] === null ? `<span class="fc-warn">${escapeHtml('no rate yet')}</span>` : escapeHtml(num(rates[m]))}${calc[m] !== undefined && calc[m] !== null && calc[m] !== rates[m] ? ` <span class="hint">${escapeHtml(`(the calculator's plan says ${num(calc[m])})`)}</span>` : ''}`).join(' · ')}`;
}

function renderPlanPick() {
  const pick = $('fc-plan-pick');
  const plans = fc.plans ?? [];
  pick.innerHTML = `<option value="">${escapeHtml(plans.length ? 'Choose a plan saved in the calculator…' : 'No plan saved in the calculator here: open a plan file')}</option>${plans.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(`${p.name} · ${p.projects} project(s)`)}</option>`).join('')}`;
  pick.disabled = !plans.length;
  $('fc-plan-use').disabled = !plans.length;
}

/** The projects the page lists: those whose latest scan on their branch ran Fusion, and those given credits. */
const listed = () => fc.data.projects.filter((p) => p.scanType === 'fusion' || p.allocated !== null);

function stateCell(p, may) {
  const chip = (kind, label) => `<span class="fc-chip ${kind}">${escapeHtml(label)}</span>`;
  const parts = [];
  if (p.standing === 'none') {
    if (may && p.recommended) parts.push(`<button type="button" class="sm" data-fc-give="${escapeHtml(p.id)}" data-credits="${p.recommended}">${escapeHtml(`Allocate ${num(p.recommended)}`)}</button>`);
    else if (p.rate === null && p.model) parts.push(`<span class="hint">${escapeHtml(`Set a rate for ${p.model}`)}</span>`);
    else if (p.inPlan === false) parts.push(`<span class="hint">${escapeHtml('Left out of the plan')}</span>`);
  } else if (p.standing === 'spent') {
    parts.push(chip('bad', p.paused ? 'Spent · Fusion paused' : 'Spent'));
    if (may && p.next) parts.push(`<button type="button" class="sm" data-fc-add="${escapeHtml(p.id)}" data-credits="${Math.max(p.next, -(p.left ?? 0) + p.next)}">${escapeHtml(`Add ${num(Math.max(p.next, -(p.left ?? 0) + p.next))}`)}</button>`);
  } else if (p.standing === 'low') parts.push(chip('warn', 'Less than one scan left'));
  else if (p.standing === 'ok') parts.push(chip('good', 'On plan'));
  else parts.push(chip('', 'Not known yet'));
  if (p.shortfall?.extra > 0) parts.push(chip('warn', `Needs ${num(p.shortfall.extra)} more`));
  if (p.schedule && !p.schedule.stopped && p.schedule.left > 0) parts.push(`<span class="hint">${escapeHtml(`${p.schedule.left} planned scan(s), next ${fmtDateTime(p.schedule.next)}`)}</span>`);
  return parts.join(' ');
}

function branchCell(p, may) {
  const label = p.branch || 'not said';
  const title = p.branchChosen ? 'Chosen for this project' : HOW[p.branchHow] ?? '';
  const badge = p.branchProtected ? ` <span class="fc-branch-kind" title="${escapeHtml('A usual protected branch')}">${escapeHtml(p.branchProtected)}</span>` : '';
  if (fc.open === p.id) return `<span class="fc-branch-pick"><select data-fc-branch-select="${escapeHtml(p.id)}" aria-label="${escapeHtml('Branch')}"><option>${escapeHtml('Loading…')}</option></select></span>`;
  return may
    ? `<button type="button" class="link fc-branch" data-fc-branch="${escapeHtml(p.id)}" title="${escapeHtml(`${title}. Click to read it on another branch.`)}" translate="no">${escapeHtml(label)}</button>${p.branchChosen ? ` <span class="hint">${escapeHtml('(chosen)')}</span>` : ''}${badge}`
    : `<span title="${escapeHtml(title)}" translate="no">${escapeHtml(label)}</span>${badge}`;
}

function renderProjects() {
  const may = fc.data.may.allocate;
  const rows = listed();
  const body = $('fc-body');
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="11" class="hint">${escapeHtml(fc.data.read ? 'No project\'s latest scan ran Fusion.' : 'Read projects to list them.')}</td></tr>`;
    return;
  }
  const checked = new Set([...document.querySelectorAll('#fc-body [data-fc-pick]:checked')].map((c) => c.dataset.fcPick));
  const fresh = !checked.size;
  body.innerHTML = rows.map((p) => {
    const pick = fresh ? p.standing === 'none' && p.recommended > 0 : checked.has(p.id);
    const cls = p.standing === 'spent' ? 'fc-spent' : p.standing === 'low' || p.shortfall?.extra > 0 ? 'fc-low' : '';
    return `<tr class="${cls}">
      <td class="checkbox"><input type="checkbox" data-fc-pick="${escapeHtml(p.id)}"${pick ? ' checked' : ''}${may ? '' : ' disabled'} aria-label="${escapeHtml(p.name)}" /></td>
      <td><b>${escapeHtml(p.name)}</b>${p.notRead ? ` <span class="hint">${escapeHtml('(not in the last read)')}</span>` : ''}</td>
      <td>${branchCell(p, may)}</td>
      <td>${p.model ? `<span class="fusion-model" translate="no">${escapeHtml(p.model)}</span>` : '—'}${p.plannedModel && p.plannedModel !== p.model ? ` <span class="hint" title="${escapeHtml('The model the plan names for it')}">→ <span translate="no">${escapeHtml(p.plannedModel)}</span></span>` : ''}</td>
      <td class="num">${escapeHtml(num(p.loc, 0))} <span class="hint">(${escapeHtml(num(p.units, 0))})</span></td>
      <td>${escapeHtml(FREQ_SHORT[p.frequency] ?? '—')} <span class="hint">→</span> <b>${escapeHtml(num(p.planned, 0))}</b>${p.plannedFrom === 'project' ? ` <span class="hint">${escapeHtml('(its own)')}</span>` : ''}</td>
      <td class="num">${p.recommended === null ? `<span class="fc-warn" title="${escapeHtml('No rate for its model yet')}">?</span>` : escapeHtml(num(p.recommended))}</td>
      <td class="num${p.allocated === null ? ' zero' : ''}">${escapeHtml(num(p.allocated))}</td>
      <td class="num${p.used === null ? ' zero' : ''}">${escapeHtml(num(p.used))}</td>
      <td class="num${p.left === null ? ' zero' : ''}">${p.left !== null && p.left <= 0 ? `<span class="fc-bad">${escapeHtml(num(p.left))}</span>` : escapeHtml(num(p.left))}</td>
      <td class="fc-state">${stateCell(p, may)}</td>
    </tr>`;
  }).join('');
  if (fc.open) loadBranches(fc.open);
  updateBulk();
}

function updateBulk() {
  if (!fc.data) return;
  const picked = picks();
  const byId = new Map(fc.data.projects.map((p) => [p.id, p]));
  const give = picked.map((id) => byId.get(id)).filter((p) => p && p.recommended > 0 && p.allocated === null);
  const total = give.reduce((n, p) => n + p.recommended, 0);
  const allocate = $('fc-allocate');
  allocate.textContent = give.length ? `Allocate recommended to ${give.length} project(s) · ${num(total)} credits` : 'Allocate recommended';
  allocate.disabled = !give.length;
  const schedulable = picked.map((id) => byId.get(id)).filter((p) => p && p.allocated !== null && p.plan && p.canSchedule);
  $('fc-schedule').disabled = !schedulable.length;
  $('fc-schedule').textContent = schedulable.length ? `Schedule planned scans for ${schedulable.length}` : 'Schedule planned scans';
}

const picks = () => [...document.querySelectorAll('#fc-body [data-fc-pick]:checked')].map((c) => c.dataset.fcPick);
const usedPicks = () => [...document.querySelectorAll('#fc-used-body [data-fc-used-pick]:checked')].map((c) => c.dataset.fcUsedPick);

function renderUsed() {
  const may = fc.data.may.allocate;
  const rows = fc.data.projects.filter((p) => p.allocated !== null);
  $('fc-used-body').innerHTML = rows.length
    ? rows.map((p) => {
      const s = p.schedule;
      const planned = !s ? (p.plan ? `${p.plan.scans} planned, not scheduled` : '—') : s.stopped ? `stopped · ${s.started.length} started` : s.left > 0 ? `${s.left} to go, next ${fmtDateTime(s.next)}${s.blocked === 'credits' ? ' · waiting for credits' : s.blocked === 'error' ? ' · last start failed' : ''}` : `all ${s.started.length} started`;
      const needs = p.shortfall?.extra > 0 ? `${num(p.shortfall.extra)} more: lines of code ${num(p.plan?.loc, 0)} → ${num(p.loc, 0)}` : '—';
      return `<tr class="${p.standing === 'spent' ? 'fc-spent' : p.shortfall?.extra > 0 ? 'fc-low' : ''}">
        <td class="checkbox"><input type="checkbox" data-fc-used-pick="${escapeHtml(p.id)}"${may ? '' : ' disabled'} aria-label="${escapeHtml(p.name)}" /></td>
        <td><b>${escapeHtml(p.name)}</b><br /><span class="hint">${escapeHtml(p.allocatedAt ? `since ${fmtDateTime(p.allocatedAt)}` : '')}</span></td>
        <td translate="no">${escapeHtml(p.branch || '—')}</td>
        <td class="num">${escapeHtml(num(p.allocated))}</td>
        <td class="num">${escapeHtml(num(p.usedScans, 0))}</td>
        <td class="num">${escapeHtml(num(p.used))}</td>
        <td class="num">${escapeHtml(num(p.left))}</td>
        <td>${escapeHtml(planned)}</td>
        <td>${escapeHtml(needs)}</td>
        <td>${escapeHtml(p.paused ? `Paused since ${fmtDateTime(p.paused.at)}` : 'On')}</td>
      </tr>`;
    }).join('')
    : `<tr><td colspan="10" class="hint">${escapeHtml('No project has been given Fusion credits yet.')}</td></tr>`;
  $('fc-stop').disabled = !may;
  $('fc-take-back').disabled = !may;
}

function renderRates() {
  const { settings, read, may } = fc.data;
  const draft = fc.ratesDraft ?? { ...settings.rates };
  for (const m of read?.models ?? []) if (!(m in draft)) draft[m] = null;
  fc.ratesDraft = draft;
  const calc = settings.plan.calculatorRates ?? {};
  $('fc-rates-body').innerHTML = Object.keys(draft).sort().map((m) => `<tr>
    <td translate="no"><span class="fusion-model">${escapeHtml(m)}</span></td>
    <td class="num"><input type="number" min="0" max="1000" step="0.01" data-fc-rate="${escapeHtml(m)}" value="${draft[m] === null ? '' : escapeHtml(String(draft[m]))}" placeholder="${escapeHtml('not set')}"${may.rates ? '' : ' disabled'} aria-label="${escapeHtml(`Credits per 10K lines for ${m}`)}" /></td>
    <td>${calc[m] === undefined || calc[m] === null ? '—' : escapeHtml(num(calc[m]))}</td>
    <td>${may.rates ? `<button type="button" class="link" data-fc-rate-remove="${escapeHtml(m)}">${escapeHtml('Remove')}</button>` : ''}</td>
  </tr>`).join('');
  for (const el of document.querySelectorAll('.fc-admin-only')) el.hidden = !may.rates;
  for (const radio of document.querySelectorAll('input[name="fc-spent"]')) {
    radio.checked = radio.value === (settings.pauseWhenSpent ? 'pause' : 'warn');
    radio.disabled = !may.rates;
  }
  setStatus('fc-rates-status', may.rates ? (settings.ratesAt ? `Last changed ${fmtDateTime(settings.ratesAt)}${settings.ratesBy ? ` by ${settings.ratesBy}` : ''}.` : '') : 'Only an Admin changes the rates.', 'muted');
}

async function loadBranches(projectId) {
  const select = document.querySelector(`[data-fc-branch-select="${CSS.escape(projectId)}"]`);
  if (!select) return;
  try {
    const got = await api(`/api/fusion-credits/branches?project=${encodeURIComponent(projectId)}`);
    const row = fc.data.projects.find((p) => p.id === projectId);
    select.innerHTML = `<option value="">${escapeHtml(`Its primary branch${row && !row.branchChosen && row.branch ? ` (${row.branch})` : ''}`)}</option>${got.branches.map((b) => `<option value="${escapeHtml(b.name)}"${got.chosen === b.name ? ' selected' : ''}>${escapeHtml(b.name)}${b.protected ? ` · ${escapeHtml(b.protected)}` : ''}</option>`).join('')}<option value="__cancel">${escapeHtml('Cancel')}</option>`;
    select.focus();
  } catch (error) {
    if (!handleAuthLoss(error)) toast(error.message, 'error');
    fc.open = null;
    renderProjects();
  }
}

async function post(path, body, method = 'POST') {
  try {
    const got = await api(path, { method, body: JSON.stringify(body) });
    fc.data = { ...fc.data, ...got };
    render();
    return got;
  } catch (error) {
    if (!handleAuthLoss(error)) toast(error.message, 'error');
    return null;
  }
}

export function wireFusionCredits() {
  $('fc-read')?.addEventListener('click', async () => {
    try {
      await api('/api/fusion-credits/read', { method: 'POST', body: '{}' });
      await loadFusionCredits({ quiet: true });
    } catch (error) {
      if (!handleAuthLoss(error)) showError('fc-status', error);
    }
  });
  $('fc-all')?.addEventListener('change', (event) => {
    for (const c of document.querySelectorAll('#fc-body [data-fc-pick]:not(:disabled)')) c.checked = event.target.checked;
    updateBulk();
  });
  $('fc-used-all')?.addEventListener('change', (event) => {
    for (const c of document.querySelectorAll('#fc-used-body [data-fc-used-pick]:not(:disabled)')) c.checked = event.target.checked;
  });
  $('fc-body')?.addEventListener('change', async (event) => {
    if (event.target.matches('[data-fc-pick]')) return updateBulk();
    const select = event.target.closest('[data-fc-branch-select]');
    if (!select) return;
    const id = select.dataset.fcBranchSelect;
    fc.open = null;
    if (select.value === '__cancel') return renderProjects();
    select.disabled = true;
    setStatus('fc-status', 'Reading the project on that branch…');
    await post('/api/fusion-credits/branch', { projectId: id, branch: select.value }, 'PUT');
  });
  $('fc-body')?.addEventListener('click', async (event) => {
    const branch = event.target.closest('[data-fc-branch]');
    if (branch) {
      fc.open = branch.dataset.fcBranch;
      return renderProjects();
    }
    const give = event.target.closest('[data-fc-give], [data-fc-add]');
    if (give) {
      give.disabled = true;
      const id = give.dataset.fcGive ?? give.dataset.fcAdd;
      await post('/api/fusion-credits/allocate', { projects: [{ id, credits: Number(give.dataset.credits), mode: give.dataset.fcAdd ? 'add' : 'set' }] });
    }
  });
  $('fc-allocate')?.addEventListener('click', async () => {
    const byId = new Map(fc.data.projects.map((p) => [p.id, p]));
    const give = picks().map((id) => byId.get(id)).filter((p) => p && p.recommended > 0 && p.allocated === null);
    if (!give.length) return;
    const total = give.reduce((n, p) => n + p.recommended, 0);
    if (!confirm(`Give ${give.length} project(s) ${num(total)} Fusion credits, as the plan recommends? They can only be spent on Fusion scans.`)) return;
    $('fc-allocate').disabled = true;
    const got = await post('/api/fusion-credits/allocate', { projects: give.map((p) => ({ id: p.id, credits: p.recommended, mode: 'set' })) });
    if (got) toast(`${give.length} project(s) given ${num(total)} Fusion credits.`);
  });
  $('fc-schedule')?.addEventListener('click', async () => {
    const byId = new Map(fc.data.projects.map((p) => [p.id, p]));
    const ids = picks().filter((id) => byId.get(id)?.allocated !== null);
    if (!ids.length) return;
    const scans = ids.reduce((n, id) => n + Math.max(0, (byId.get(id).plan?.scans ?? 0) - (byId.get(id).usedScans ?? 0)), 0);
    if (!confirm(`Schedule ${scans} planned Fusion scan(s) for ${ids.length} project(s), spread over the plan's period, the first of each now? Each starts only while its project has Fusion credits for it.`)) return;
    $('fc-schedule').disabled = true;
    const got = await post('/api/fusion-credits/schedule', { projectIds: ids });
    if (got) toast(got.skipped?.length ? `Scheduled; ${got.skipped.length} not: ${got.skipped.map((s) => s.why).join(' ')}` : 'Planned Fusion scans scheduled: the first of each has started.', got.skipped?.length ? 'warn' : '');
  });
  $('fc-stop')?.addEventListener('click', () => {
    const ids = usedPicks();
    if (ids.length) post('/api/fusion-credits/schedule/stop', { projectIds: ids });
  });
  $('fc-take-back')?.addEventListener('click', async () => {
    const ids = usedPicks();
    if (!ids.length) return;
    if (!confirm(`Take back what ${ids.length} project(s) have not used? A project with nothing left has Fusion paused, if that is the choice on the Rates tab.`)) return;
    const got = await post('/api/fusion-credits/take-back', { projectIds: ids });
    if (got) toast(`${num(got.takenBack)} Fusion credits taken back.`);
  });
  $('fc-plan-save')?.addEventListener('click', async () => {
    const byFrequency = Object.fromEntries([...document.querySelectorAll('[data-fc-freq]')].map((i) => [i.dataset.fcFreq, i.value === '' ? null : Number(i.value)]));
    const got = await post('/api/fusion-credits/plan', { periodMonths: Number($('fc-period').value), byFrequency }, 'PUT');
    if (got) toast('Plan saved: the recommendations follow it.');
  });
  $('fc-plan-use')?.addEventListener('click', async () => {
    const id = $('fc-plan-pick').value;
    if (!id) return;
    const got = await post('/api/fusion-credits/plan/import', { calculatorId: id });
    if (got) toast('The calculator\'s plan is the plan now.');
  });
  $('fc-plan-file')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      return toast('That file is not a Fusion plan from the Cx Credits Calculator.', 'error');
    }
    const got = await post('/api/fusion-credits/plan/import', { file: parsed });
    if (got) toast(`The plan from "${file.name}" is the plan now.`);
  });
  $('fc-rates-body')?.addEventListener('input', (event) => {
    const input = event.target.closest('[data-fc-rate]');
    if (input) fc.ratesDraft[input.dataset.fcRate] = input.value === '' ? null : Number(input.value);
  });
  $('fc-rates-body')?.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-fc-rate-remove]');
    if (!remove) return;
    delete fc.ratesDraft[remove.dataset.fcRateRemove];
    renderRates();
  });
  $('fc-rate-add')?.addEventListener('click', () => {
    const name = prompt('The model\'s name, as Checkmarx One gives it (for example opus-5.5):');
    if (!name || !name.trim()) return;
    fc.ratesDraft[name.trim().toLowerCase()] = null;
    renderRates();
  });
  $('fc-rates-save')?.addEventListener('click', async () => {
    const pause = document.querySelector('input[name="fc-spent"]:checked')?.value !== 'warn';
    const rates = Object.entries(fc.ratesDraft ?? {}).map(([model, creditsPer10k]) => ({ model, creditsPer10k }));
    try {
      fc.data = await api('/api/fusion-credits/rates', { method: 'PUT', body: JSON.stringify({ rates, pauseWhenSpent: pause }) });
      fc.ratesDraft = null;
      render();
      setStatus('fc-rates-status', 'Rates saved.', 'ok');
    } catch (error) {
      if (!handleAuthLoss(error)) showError('fc-rates-status', error);
    }
  });
}
