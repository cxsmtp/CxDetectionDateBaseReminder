// The Labs pages kept here: Beta (code authors, matching identities, the Git hosts) and Fusion (what Fusion found
// against the last scan, by project and by result, its report and its troubleshooting).
import { creditTiers } from '../credit-tiers.js';
import { sortAndFilter } from '../table-tools.js';
import { columnMenu, shownColumns as columnsShownOf } from '../column-prefs.js';
import { ENGINE_LABEL, FUSION_STATES, FUSION_STATUSES, MODEL_FROM, PERIOD_LABEL, SCAN_TYPE_LABEL, STATE_LABEL, countsFor, engineLabel, fileOf, filtering, fusionReportHtml, fusionResultRows, fusionRows, fusionTiles, scannerLabel, shownEngines, wordsLabel } from '../fusion-view.js';
import { $, can, state } from './state.js';
import { escapeHtml, fmt, fmtDateTime } from './format.js';
import { api, handleAuthLoss, setStatus, showError, showHelp } from './core.js';
import { SEVERITY_LABEL } from './automation.js';
import { avatar, fusion, renderProjects } from './projects.js';
import { allocationScope } from './actions.js';
import { creditLane, spendText } from './reports.js';
import { creditsChanged, noteGone } from './credits.js';

// ---------------------------------------------------------------------------
// Beta: code authors and GitHub identities
// ---------------------------------------------------------------------------

const METHOD_NAMES_GITHUB = {
  localGit: 'Local git history',
  graphql: 'GraphQL batch',
  commits: 'Commit author',
  profile: 'Public profile',
};
const lines = (value) => String(value || '').split(/[\n,]+/).map((v) => v.trim()).filter(Boolean);

export function renderBeta() {
  const github = state.settings?.beta?.github ?? {};
  const authors = state.settings?.beta?.authors ?? {};
  $('gh-token-state').textContent = github.tokenSet ? '(stored)' : '(not set)';
  $('gh-api').value = github.apiUrl ?? '';
  $('gh-org').value = github.org ?? '';
  $('gh-repos').value = (github.repos ?? []).join('\n');
  $('gh-local').value = (github.localRepos ?? []).join('\n');
  $('gh-blame-github').checked = authors.useGithubBlame !== false;
  $('gh-blame-local').checked = authors.useLocalBlame !== false;
  const beta = state.settings?.beta ?? {};
  const gl = beta.gitlab ?? {};
  const az = beta.azure ?? {};
  const bb = beta.bitbucket ?? {};
  $('gl-url').value = gl.apiUrl ?? '';
  $('gl-group').value = gl.group ?? '';
  $('gl-projects').value = (gl.projects ?? []).join('\n');
  $('az-org').value = az.orgUrl ?? '';
  $('az-repos').value = (az.repos ?? []).join('\n');
  $('bb-kind').value = bb.kind || (bb.apiUrl && !/bitbucket\.org/.test(bb.apiUrl) ? 'server' : 'cloud');
  $('bb-url').value = $('bb-kind').value === 'server' ? bb.apiUrl ?? '' : '';
  $('bb-url').disabled = $('bb-kind').value !== 'server';
  $('bb-user').value = bb.username ?? '';
  $('bb-workspace').value = bb.workspace ?? '';
  $('bb-repos').value = (bb.repos ?? []).join('\n');
  for (const [id, host] of Object.entries({ gitlab: gl, azure: az, bitbucket: bb })) {
    document.querySelector(`[data-token-state="${id}"]`).textContent = host.tokenSet ? (host.tokenFromEnvironment ? '(from the .env)' : '(stored)') : '(not set)';
    const chip = document.querySelector(`[data-host-state="${id}"]`);
    chip.textContent = host.tokenSet ? 'token set' : 'not set up';
    chip.className = `chip ${host.tokenSet ? 'ok' : ''}`;
  }
  renderIdentityMethods();
  renderBetaScope();
  const connected = [github.tokenSet, gl.tokenSet, az.tokenSet, bb.tokenSet].filter(Boolean).length;
  $('hosts-count').textContent = connected ? String(connected) : '';
}

/** Which projects "Find code authors" covers: the Workbench's selection, or all it shows. */
// ---- Labs → Fusion results (Beta; src/fusion-ai.js) -------------------------------------------------
// The AI-generated SAST results of each project's latest scan, loaded on the page's own line and kept with
// the session. Fusion (the traditional engine supports the language too) and LAST (the AI engine alone) are
// ticked apart: the figures, the projects, the side panel, the exports and the credits all follow the ticks.
const FUSION_ENGINES_KEY = 'mz-fusion-engines';
const FUSION_SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

export function fusionEngines() {
  const ticked = [$('fusion-show-fusion')?.checked && 'FUSION', $('fusion-show-last')?.checked && 'LAST'].filter(Boolean);
  return ticked.length ? ticked : ['FUSION', 'LAST'];
}
function setFusionEngines(engines) {
  const list = shownEngines(engines);
  if ($('fusion-show-fusion')) $('fusion-show-fusion').checked = list.includes('FUSION');
  if ($('fusion-show-last')) $('fusion-show-last').checked = list.includes('LAST');
}

/** What the server holds for this session; read it now when there is a fetch but no Fusion read yet. */
export async function loadFusion() {
  if (!can('feature.fusionResults') || fusion.loading) return;
  loadFusionTrouble();
  try {
    const { fusion: data, scope, credits } = await api('/api/beta/fusion');
    fusion.data = data;
    fusion.scope = scope;
    fusion.credits = credits;
    // The line shows what it last loaded.
    if (scope?.own && !$('fusion-apps-in').value && !$('fusion-projects-in').value) {
      $('fusion-apps-in').value = scope.own.applications.join(', ');
      $('fusion-projects-in').value = scope.own.projects.join(', ');
    }
    renderFusion();
  } catch (error) {
    if (!handleAuthLoss(error)) showError('fusion-status', error);
  }
}

async function readFusion({ quiet = false } = {}) {
  if (!can('feature.fusionResults')) return;
  if (fusion.loading) return fusion.loading;
  if (!quiet) setStatus('fusion-status', 'Reading Fusion results…');
  fusion.loading = (async () => {
    try {
      const { fusion: data, scope, credits } = await api('/api/beta/fusion/read', { method: 'POST', body: '{}', quiet });
      fusion.data = data;
      fusion.scope = scope;
      fusion.credits = credits;
      fusionStatus(data);
    } catch (error) {
      if (!handleAuthLoss(error)) showError('fusion-status', error);
    } finally {
      fusion.loading = null;
      if (fusionTrouble.on) loadFusionTrouble();
      renderFusion();
      if (state.projects.length) renderProjects();
    }
  })();
  return fusion.loading;
}

/** The page's status and state chips, and "Only AI-triaged": what narrows the projects, the panel and the exports. */
const fusionFilter = { status: '', state: '', aiTriaged: false };
const fusionFilterNow = () => (filtering(fusionFilter) ? { ...fusionFilter } : null);
/** Fusion's and LAST's colours as this page shows them (the look's, or the person's own): for the HTML report. */
const fusionColours = () => {
  const css = getComputedStyle(document.documentElement);
  const hex = (v) => (/^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim() : '');
  return { fusion: hex(css.getPropertyValue('--scan-fusion')), last: hex(css.getPropertyValue('--scan-last')) };
};

/** Whether the three blocks under the figures line are open: kept for this browser only. */
const FUSION_DETAILS_KEY = 'mz.fusion.details';
function fusionDetailsOpen() {
  try {
    return localStorage.getItem(FUSION_DETAILS_KEY) === '1';
  } catch {
    return false;
  }
}

/** The Fusion page's projects table, a column each: its heading, its cell, and what it sorts and filters by. */
const fusionCell = {
  count: (n, cls = '') => `<td class="num c-count ${n ? cls : 'zero'}">${fmt(n)}</td>`,
  maybe: (n) => `<td class="num${n === null || n === undefined ? ' zero' : ''}">${n === null || n === undefined ? '—' : fmt(n)}</td>`,
};
/** The results column's heading, by what is ticked: Fusion alone, LAST alone, or both (each row by its own scan). */
const FUSION_RESULTS_HEADING = { FUSION: 'Fusion / total results', LAST: 'LAST results', 'FUSION,LAST': 'AI / total results' };
const FUSION_COLUMNS = [
  { id: 'project', label: 'Project', fixed: true, sort: (r) => r.name, cell: (r) => `<td class="fusion-proj-name"><button type="button" class="link" data-fusion-project="${escapeHtml(r.projectId)}" title="Show its vulnerabilities">${escapeHtml(r.name)}</button></td>` },
  { id: 'scan', label: 'Scan', title: 'Fusion: its latest scan ran the AI engine with Fusion on. LAST: with Fusion off (LLM-based scanning alone).', sort: (r) => SCAN_TYPE_LABEL[r.scanType] ?? r.scanType, cell: (r) => `<td><span class="scan-tag scan-tag-${escapeHtml(r.scanType)}">${escapeHtml(SCAN_TYPE_LABEL[r.scanType] ?? r.scanType)}</span></td>` },
  {
    id: 'languages',
    label: 'Languages',
    title: 'SAST: the languages its latest scan\'s SAST engine scanned. LAST: those of what the AI engine found in a language only it covers',
    sort: (r) => [...r.sastLanguages, ...r.lastLanguages].join(', '),
    cell: (r) => `<td class="fusion-langs">${r.sastLanguages.length ? `<span class="fusion-lang-line"><b>SAST</b> <span translate="no">${escapeHtml(r.sastLanguages.join(', '))}</span></span>` : ''}${r.lastLanguages.length ? `<span class="fusion-lang-line is-last"><b>LAST</b> <span translate="no">${escapeHtml(r.lastLanguages.join(', '))}</span></span>` : ''}${r.sastLanguages.length || r.lastLanguages.length ? '' : '<span class="zero">—</span>'}</td>`,
  },
  { id: 'model', label: 'Model', title: 'The model its latest scan ran with, and where that was set: the scan, the project, the tenant, or Checkmarx One itself', sort: (r) => r.model, cell: (r) => `<td class="fusion-model-cell">${r.model ? `<span class="fusion-model" translate="no" title="${escapeHtml(MODEL_FROM[r.modelFrom] ?? 'as Checkmarx One says')}">${escapeHtml(r.model)}</span>` : '<span class="zero" title="Checkmarx One did not say">—</span>'}</td>` },
  { id: 'loc', label: 'LOC', num: true, title: 'Lines of code its latest scan counted', sort: (r) => r.loc, cell: (r) => fusionCell.maybe(r.loc) },
  {
    id: 'results',
    label: 'AI results',
    title: 'What the AI engine reported, by severity (no traditional SAST results)',
    sort: { value: (r) => r.total, text: (r) => FUSION_SEVERITY_ORDER.filter((k) => r[k]).map((k) => `${r[k]} ${SEVERITY_LABEL[k]}`).join(' ') },
    cell: (r) => `<td class="fusion-sevs">${FUSION_SEVERITY_ORDER.filter((k) => r[k]).map((k) => `<span class="fusion-sev fusion-sev-${k.toLowerCase()}" title="${escapeHtml(`${fmt(r[k])} ${SEVERITY_LABEL[k].toLowerCase()}`)}">${fmt(r[k])} ${escapeHtml(SEVERITY_LABEL[k][0])}</span>`).join('') || '<span class="zero">none</span>'}</td>`,
  },
  {
    // The id is as before ("share"), so the columns people chose to show, hide or reorder stay as they left them.
    // Its heading follows the ticks; each row follows its own scan: a Fusion scan's AI results over all of its SAST
    // results (12 / 140), a LAST scan's AI results alone (there is no traditional SAST to compare them with).
    id: 'share',
    label: () => FUSION_RESULTS_HEADING[fusionEngines().join(',')] ?? 'AI / total results',
    num: true,
    title: 'What the AI engine reported; for a Fusion scan, all of its latest scan\'s SAST results after the slash (12 / 140). Hover a figure for the AI engine\'s share',
    sort: { value: (r) => r.total ?? 0, text: (r) => (r.scanType === 'last' || r.sastResults === null ? fmt(r.total ?? 0) : `${fmt(r.total ?? 0)} / ${fmt(r.sastResults)}`) },
    cell: (r) => {
      const ai = `<b>${fmt(r.total ?? 0)}</b>`;
      if (r.scanType === 'last') return `<td class="num fusion-of-cell${r.total ? '' : ' zero'}" title="${escapeHtml(`${fmt(r.total ?? 0)} found by the AI engine alone (a LAST scan)`)}">${ai}</td>`;
      if (r.sastResults === null) return `<td class="num fusion-of-cell" title="Checkmarx One did not say how many SAST results its latest scan has">${ai} <span class="fusion-of">/ —</span></td>`;
      return `<td class="num fusion-of-cell" title="${escapeHtml(`${fmt(r.total ?? 0)} of ${fmt(r.sastResults)} SAST results are the AI engine's: ${fmt(r.aiShare ?? 0)}%`)}">${ai} <span class="fusion-of">/ ${fmt(r.sastResults)}</span></td>`;
    },
  },
  { id: 'toVerify', label: 'To verify', num: true, title: 'Open risks still in Risk Hub\'s default state, To verify', sort: (r) => r.TO_VERIFY, cell: (r) => fusionCell.count(r.TO_VERIFY) },
  { id: 'confirmed', label: 'Confirmed', num: true, title: 'Open risks confirmed (by people or by AI Triage)', sort: (r) => r.CONFIRMED, cell: (r) => fusionCell.count(r.CONFIRMED) },
  {
    id: 'credits',
    label: 'Credits, latest scan',
    num: true,
    title: 'Credits its latest scan used: none for a LAST scan or with Fusion credits disabled; ≈ an estimate from the Fusion credits it used over the last year, per Fusion scan',
    sort: { value: (r) => r.scanCredits?.credits ?? null, text: (r) => scanCreditsText([r]) },
    cell: (r) => `<td class="num${r.scanCredits ? '' : ' zero'}" title="${escapeHtml(scanCreditsWhy(r))}">${escapeHtml(scanCreditsText([r]))}</td>`,
  },
  { id: 'latest', label: 'Latest scan', sort: { value: (r) => (r.scanAt ? Date.parse(r.scanAt) : null), text: (r) => (r.scanAt ? fmtDateTime(r.scanAt) : '') }, cell: (r) => `<td class="nowrap">${escapeHtml(r.scanAt ? fmtDateTime(r.scanAt) : '—')}</td>` },
];
const fusionColumnsShown = () => columnsShownOf('fusion-projects', FUSION_COLUMNS);
/** The sort and filters belong to one arrangement of the columns: another starts afresh. */
const fusionTableKey = () => `fusion-projects:${fusionColumnsShown().map((c) => c.id).join(',')}`;
/** The headings last drawn: drawn again only when they change (the ticks, the columns), so the sort and filter controls stay. */
let fusionHeadDrawn = '';
function renderFusionHead() {
  const shown = fusionColumnsShown();
  $('fusion-table').dataset.tt = fusionTableKey();
  const html = shown.map((c) => `<th${c.num ? ' class="num"' : ''}${c.title ? ` title="${escapeHtml(c.title)}"` : ''}>${escapeHtml(typeof c.label === 'function' ? c.label() : c.label)}</th>`).join('');
  if (html === fusionHeadDrawn && $('fusion-head').childElementCount) return;
  fusionHeadDrawn = html;
  $('fusion-head').innerHTML = html;
}

export function renderFusion() {
  const tiles = $('fusion-tiles');
  if (!tiles) return;
  // The results column's heading says what the ticks show.
  renderFusionHead();
  const { data, scope } = fusion;
  const engines = fusionEngines();
  const label = engineLabel(engines);
  const filter = fusionFilterNow();
  $('fusion-read').disabled = !scope?.projects;
  // Beside each tick: how many projects' latest scans were of that kind.
  $('fusion-n-fusion').textContent = data ? fmt(data.kinds?.fusion ?? data.scanned ?? 0) : '';
  $('fusion-n-last').textContent = data ? fmt(data.kinds?.last ?? 0) : '';
  if (!data) {
    tiles.innerHTML = '';
    $('fusion-over').hidden = true;
    $('fusion-filters').hidden = true;
    $('fusion-body').innerHTML = `<tr><td colspan="11" class="hint">${escapeHtml('Choose applications or projects above (or none, for every project), then Load results.')}</td></tr>`;
    $('fusion-proj-count').textContent = '';
    $('fusion-foot').textContent = '';
    $('fusion-act-scope').textContent = 'Load results to act on them.';
    renderFusionLanes();
    return;
  }
  const t = fusionTiles(data, scope, engines, filter);
  const tile = (value, name, cls = '') => `<div class="${cls}"><span class="value">${escapeHtml(value)}</span><span class="label">${escapeHtml(name)}</span></div>`;
  renderFusionOverview(t);
  // One thin line, as FAE Flush's: the three blocks open under Details.
  const kinds = data.kinds ?? { fusion: data.scanned ?? 0, last: 0 };
  const out = (Number(data.notFusion) || 0) + (Number(data.noAi) || 0);
  const sev = FUSION_SEVERITY_ORDER.filter((k) => t.found[k]).map((k) => `<span class="fusion-sev fusion-sev-${k.toLowerCase()}" title="${escapeHtml(`${fmt(t.found[k])} ${SEVERITY_LABEL[k].toLowerCase()}`)}">${fmt(t.found[k])} ${escapeHtml(SEVERITY_LABEL[k][0])}</span>`).join('');
  const left = data.tenant?.credits?.available;
  const open = fusionDetailsOpen();
  tiles.innerHTML = [
    tile(fmt(t.found.projects), 'projects'),
    `<div class="fusion-split"><span class="fusion-word">${fmt(kinds.fusion)} Fusion</span> · <span class="last-word">${fmt(kinds.last)} LAST</span>${out ? ` · <span title="${escapeHtml([data.notFusion ? `${fmt(data.notFusion)} project(s) left out: their latest scan did not run the AI engine.` : '', data.noAi ? `${fmt(data.noAi)} project(s) left out: their latest scan's AI engine reported nothing.` : ''].filter(Boolean).join(' '))}">${fmt(out)} left out</span>` : ''}</div>`,
    tile(fmt(t.found.results), 'AI results'),
    sev ? `<div class="fusion-sevs">${sev}</div>` : '',
    tile(scanCreditsText(fusionRows(data, scope, engines, filter)), 'credits, latest scans'),
    left === null || left === undefined ? '' : tile(fmt(left), 'credits left (tenant)'),
    `<button type="button" class="link fusion-details-toggle" id="fusion-details" aria-expanded="${open}" aria-controls="fusion-over">${escapeHtml(open ? 'Hide details' : 'Details')}</button>`,
  ].join('');
  $('fusion-over').hidden = !open;
  renderFusionChips();
  // The model picker: the models the projects' latest scans ran with.
  const models = [...new Set(fusionRows(data, scope, engines).map((r) => r.model).filter(Boolean))].sort();
  const picked = $('fusion-model').value;
  $('fusion-model').innerHTML = `<option value="">Any model</option>${models.map((m) => `<option value="${escapeHtml(m)}"${m === picked ? ' selected' : ''}>${escapeHtml(m)}</option>`).join('')}`;
  const rows = fusionProjectsFiltered();
  const all = fusionRows(data, scope, engines, filter).length;
  $('fusion-proj-count').textContent = all ? (rows.length === all ? fmt(all) : `${fmt(rows.length)} / ${fmt(all)}`) : '';
  $('fusion-act-scope').textContent = rows.length ? `All ${fmt(rows.length)} shown project(s) · ${label} results` : `No project shown · ${label} results`;
  $('fusion-foot').textContent = rows.length ? `${fmt(rows.length)} project(s) with results from the AI engine · gold: Fusion, pink: LAST · click a project to see its vulnerabilities` : '';
  const rowsShown = sortAndFilter(fusionTableKey(), rows, fusionColumnsShown().map((c) => c.sort ?? null), renderFusion);
  $('fusion-body').innerHTML = rowsShown.length
    ? rowsShown.map((r) => `<tr data-fusion-row="${escapeHtml(r.projectId)}" class="scan-row-${escapeHtml(r.scanType)}${r.projectId === fusion.open ? ' is-open' : ''}">${fusionColumnsShown().map((c) => c.cell(r)).join('')}</tr>`).join('')
    : `<tr><td colspan="${fusionColumnsShown().length}" class="hint">${escapeHtml(all ? 'No project matches.' : filter ? 'No project has risks that match.' : `No project's latest scan has results from the AI engine (${label}).`)}${!all && !filter && can('credits.limit') ? ' <button type="button" class="sm" data-fusion-reread>Read Fusion again</button>' : ''}</td></tr>`;
  if (fusion.open) renderFusionSide();
  fusionFocusChanged();
}

/** The credits the latest scans of `rows` used: "0", "≈ 12" (estimated) or "—" (not known). */
function scanCreditsText(rows) {
  const known = rows.filter((r) => r.scanCredits);
  if (!known.length) return '—';
  const total = Math.round(known.reduce((n, r) => n + r.scanCredits.credits, 0) * 10) / 10;
  return `${known.some((r) => r.scanCredits.estimate) ? '≈ ' : ''}${fmt(total)}`;
}
/** Why a project's latest scan shows the credits it does. */
function scanCreditsWhy(r) {
  if (!r.scanCredits) return 'Checkmarx One did not say what its latest scan used';
  if (!r.scanCredits.estimate) return r.scanType === 'last' ? 'A LAST scan: no Fusion credits' : 'Its latest scan said: Fusion credits are disabled';
  return 'Estimated: the Fusion credits it used over the last year, per Fusion scan (Checkmarx One does not say one scan’s own)';
}

/** The three blocks above the figures: the projects by scan type, what the AI engine added, the tenant's credits. */
function renderFusionOverview(t) {
  const box = $('fusion-over');
  const data = fusion.data;
  const known = (n) => (n === null || n === undefined ? '—' : fmt(n));
  const kinds = data.kinds ?? { fusion: data.scanned ?? 0, last: 0 };
  // Without AI results: no AI engine in the latest scan, or it reported nothing (left out).
  const none = (Number(data.notFusion) || 0) + (Number(data.noAi) || 0);
  const of = Math.max(1, kinds.fusion + kinds.last + none);
  const pct = (n) => `${((n / of) * 100).toFixed(2)}%`;
  const scope = data.usage?.scope;
  const period = (PERIOD_LABEL[data.usage?.period] ?? '').toLowerCase();
  const ai = data.tenant?.ai;
  const onOff = (v) => (v === true ? 'on' : v === false ? 'off' : 'not said');
  const kv = (rows) => `<dl class="fusion-kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const projects = `<section class="fusion-card"><h4>Projects</h4>
    <div class="fusion-big"><div class="is-fusion"><b>${fmt(kinds.fusion)}</b><span>latest scan Fusion</span></div><div class="is-last"><b>${fmt(kinds.last)}</b><span>latest scan LAST</span></div><div><b>${fmt(none)}</b><span>no AI results in latest scan</span></div></div>
    <div class="fusion-meter" role="img" aria-label="${escapeHtml(`${kinds.fusion} Fusion, ${kinds.last} LAST, ${none} without AI`)}"><i class="is-fusion" style="width:${pct(kinds.fusion)}"></i><i class="is-last" style="width:${pct(kinds.last)}"></i></div>
    ${kv([
      scope && ['Fusion scans', `<b>${fmt(scope.withFusion)}</b> of ${fmt(scope.projects)} projects had one ${escapeHtml(period ? `in the ${period}` : '')}`],
      scope && ['LAST scans', `<b>${fmt(scope.withLast)}</b> projects had one`],
      ai && ['Tenant', `<span>${escapeHtml(`Fusion ${onOff(ai.fusionEnabled)}`)}</span> · <span>${escapeHtml(`LLM-based scanning ${onOff(ai.llmBased)}`)}</span> · <span>${escapeHtml('model')}</span> ${ai.model ? `<span class="fusion-model" translate="no">${escapeHtml(ai.model)}</span>` : `<span>${escapeHtml('set by Checkmarx One')}</span>`}`],
    ])}</section>`;
  // Only what the AI engine itself found: no count of what the traditional engine also found.
  const added = `<section class="fusion-card"><h4>AI results <small>latest scans</small></h4>
    <div class="fusion-big"><div><b>${fmt(t.found.results)}</b><span>${escapeHtml('found by the AI engine alone')}</span></div></div>
    ${kv([
      t.models.length && ['Models', t.models.map(([m, n]) => `<span class="fusion-model" translate="no">${escapeHtml(m)}</span> ${fmt(n)}`).join(' · ')],
      ['Code', escapeHtml(`${known(t.code.loc)} lines${t.code.files !== null ? ` in ${fmt(t.code.files)} files` : ''}`)],
    ])}</section>`;
  const c = data.tenant?.credits;
  const held = fusion.credits?.held ?? null;
  const charged = { off: 'not charged on this tenant', reserved: 'credits reserved for each scan' }[data.tenant?.fusionCredits] ?? 'not said';
  const credits = `<section class="fusion-card"><h4>Credits</h4>
    ${c ? `<div class="fusion-big"><div><b>${fmt(c.available)}</b><span>${escapeHtml(`left of ${known(c.total)} (tenant)`)}</span></div></div>
    <div class="fusion-meter" role="img" aria-label="${escapeHtml(`${known(c.used)} of ${known(c.total)} used`)}"><i class="is-used" style="width:${c.total ? ((c.used / c.total) * 100).toFixed(2) : 0}%"></i>${held !== null && c.total ? `<i class="is-held" style="width:${((held / c.total) * 100).toFixed(2)}%"></i>` : ''}</div>` : `<p class="hint">${escapeHtml('Checkmarx One did not say what this tenant has left.')}</p>`}
    ${kv([
      c && ['Used', escapeHtml(`${known(c.used)} · ${known(c.actionsPerformed)} actions`)],
      held !== null && ['Given to projects', `${fmt(held)}${c ? ` of ${fmt(c.available)} · <span class="${held <= c.available ? 'ok-text' : 'bad-text'}">${held <= c.available ? 'within what is left' : 'more than is left'}</span>` : ''}`],
      ['Fusion scans', escapeHtml(charged)],
    ])}</section>`;
  box.innerHTML = projects + added + credits;
}

/** Status and state chips with how many open (or fixed) risks each has, for the engines shown. */
function renderFusionChips() {
  const box = $('fusion-filters');
  const data = fusion.data;
  box.hidden = !data;
  if (!data) return;
  const c = countsFor(data.totals, fusionEngines()) ?? {};
  const chip = (kind, value, text, n) => `<button type="button" class="sm fusion-chip" data-fusion-filter="${kind}" data-value="${escapeHtml(value)}" aria-pressed="${fusionFilter[kind] === value}">${escapeHtml(text)}${n === null ? '' : ` <small>${fmt(n)}</small>`}</button>`;
  $('fusion-status-chips').innerHTML = chip('status', '', 'All', null) + FUSION_STATUSES.map((k) => chip('status', k, wordsLabel(k), c[k] ?? 0)).join('');
  $('fusion-state-chips').innerHTML = chip('state', '', 'Any', null) + FUSION_STATES.map((k) => chip('state', k, STATE_LABEL[k], c[k] ?? 0)).join('');
  $('fusion-ai-triaged').checked = fusionFilter.aiTriaged;
  $('fusion-n-ai-triaged').textContent = `(${fmt(c.aiTriaged ?? 0)})`;
}

function fusionProjectsFiltered() {
  const q = $('fusion-q').value.trim().toLowerCase();
  const sev = $('fusion-sev').value;
  const model = $('fusion-model').value;
  return fusionRows(fusion.data, fusion.scope, fusionEngines(), fusionFilterNow()).filter((r) => (!q || r.name.toLowerCase().includes(q)) && (!sev || r[sev] > 0) && (!model || r.model === model));
}

/**
 * The credits the lanes show are for what the page shows: the server is told the ticks and the projects the
 * filters leave (once they settle), and acts on those only.
 */
let fusionFocusTimer = null;
let fusionFocusSent = '';
function fusionFocusBody() {
  return { engines: fusionEngines(), projectIds: fusion.data ? fusionProjectsFiltered().map((r) => r.projectId) : null };
}
function fusionFocusChanged() {
  if (!fusion.data || !can('credits.limit')) return renderFusionLanes();
  const body = JSON.stringify(fusionFocusBody());
  if (body === fusionFocusSent) return renderFusionLanes();
  clearTimeout(fusionFocusTimer);
  fusionFocusTimer = setTimeout(async () => {
    try {
      const { credits } = await api('/api/beta/fusion/credits', { method: 'POST', body, quiet: true });
      fusionFocusSent = body;
      fusion.credits = credits;
    } catch (error) {
      if (!handleAuthLoss(error)) showError('fusion-act-status', error);
    }
    renderFusionLanes();
  }, 250);
}

/** A CSV download, cells quoted as needed (and formulas defused). */
function downloadCsv(name, lines) {
  const cell = (v) => { const t = String(v ?? ''); return /[",\n\r]/.test(t) || /^[=+\-@]/.test(t) ? `"${(/^[=+\-@]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"` : t; };
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([lines.map((l) => l.map(cell).join(',')).join('\n')], { type: 'text/csv' }));
  link.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

const fusionFileName = (engines) => engineLabel(engines).toLowerCase().replace(/ and /, '-').replace(/\s+/g, '-');

/** The HTML report of what is shown (one project's, with `projectId`), downloaded. */
function downloadFusionReport(projectId = null) {
  if (!fusion.data) return setStatus('fusion-status', 'Load results first.', 'warn');
  const engines = fusionEngines();
  const html = fusionReportHtml(fusion.data, fusion.scope, { appName: $('app-name')?.textContent?.trim() || 'CxMissionZero', organisation: state.me?.organisationName ?? '', generatedAt: new Date().toISOString(), fmtDate: (iso) => fmtDateTime(iso), engines, projectId, filter: fusionFilterNow(), colours: fusionColours() });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  link.download = `${fusionFileName(engines)}-results${projectId ? '-project' : ''}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.html`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ---- A project's vulnerabilities, in the side panel: as the Checkmarx One results page shows them, each
// opening there; filtered by severity or status, 100 at a time.
const FUSION_SIDE_PAGE = 100;
let fusionSideShown = FUSION_SIDE_PAGE;
let fusionSideChip = '';
let fusionSideState = '';
let fusionSideFrom = null;
const FUSION_CHIPS = [['', 'All'], ['CRITICAL', 'Critical'], ['HIGH', 'High'], ['MEDIUM', 'Medium'], ['LOW', 'Low'], ['NEW', 'New'], ['RECURRENT', 'Recurrent'], ['FIXED', 'Fixed']];
const fusionChipMatch = (chip, r) => !chip || r.severity === chip || r.statusKey === chip;
const fusionStateMatch = (state, r) => !state || r.stateKey === state;

function openFusionSide(projectId) {
  fusionSideFrom = document.activeElement;
  fusion.open = projectId;
  fusionSideShown = FUSION_SIDE_PAGE;
  fusionSideChip = '';
  fusionSideState = '';
  $('fusion-drawer').hidden = false;
  $('fusion-side-status').textContent = '';
  renderFusionSide();
  loadFusionSideCredits();
  for (const tr of document.querySelectorAll('#fusion-body tr[data-fusion-row]')) tr.classList.toggle('is-open', tr.dataset.fusionRow === projectId);
  $('fusion-drawer').querySelector('[data-fusion-close].icon-btn')?.focus();
}
/**
 * AI Triage and AI Remediation for the project in the side panel (Admins): its own credits, allocated and run
 * for this project's results alone (the engines ticked), without changing what the page's bar acts on.
 */
const fusionSide = { credits: null, seq: 0 };
async function loadFusionSideCredits() {
  const box = $('fusion-side-lanes');
  if (!can('credits.limit') || !fusion.open) {
    box.hidden = true;
    return;
  }
  const seq = ++fusionSide.seq;
  try {
    const { credits } = await api('/api/beta/fusion/credits', { method: 'POST', body: JSON.stringify(fusionSideBody()), quiet: true });
    if (seq !== fusionSide.seq) return;
    fusionSide.credits = credits;
  } catch (error) {
    if (!handleAuthLoss(error)) showError('fusion-side-status', error);
  }
  renderFusionSideLanes();
}
const fusionSideBody = () => ({ once: true, engines: fusionEngines(), projectIds: [fusion.open] });
function renderFusionSideLanes() {
  const box = $('fusion-side-lanes');
  const c = fusionSide.credits;
  box.hidden = !can('credits.limit') || !c;
  if (box.hidden) return;
  if (!c.matched) {
    box.innerHTML = `<p class="hint">${escapeHtml(`No ${engineLabel(fusionEngines())} results here to run AI on.`)}</p>`;
    return;
  }
  const ways = { allocate: can('credits.allocate'), run: can('triage.run') };
  box.innerHTML = `<div class="credit-lanes">${creditLane('side', 'triage', creditTiers(c.triage, c.left.triage), ways, 'fusion')}${creditLane('side', 'remediation', creditTiers(c.remediation, c.left.remediation), ways, 'fusion')}</div>`;
}

function closeFusionSide() {
  if ($('fusion-drawer').hidden) return;
  $('fusion-drawer').hidden = true;
  fusion.open = null;
  for (const tr of document.querySelectorAll('#fusion-body tr.is-open')) tr.classList.remove('is-open');
  fusionSideFrom?.focus?.();
}
function fusionSideRows() {
  const all = fusionResultRows(fusion.data, fusion.scope, fusionEngines(), fusion.open, fusionFilterNow());
  return { all, rows: all.filter((r) => fusionChipMatch(fusionSideChip, r) && fusionStateMatch(fusionSideState, r)) };
}
function renderFusionSide() {
  const projectId = fusion.open;
  if (!projectId || !fusion.data) return closeFusionSide();
  const p = fusion.data.projects?.[projectId] ?? {};
  const name = fusion.scope?.names?.[projectId] ?? p.projectName ?? projectId;
  const engines = fusionEngines();
  const { all, rows } = fusionSideRows();
  const type = p.scanType ?? 'fusion';
  $('fusion-side-title').innerHTML = `${escapeHtml(name)} <span class="scan-tag scan-tag-${escapeHtml(type)}">${escapeHtml(SCAN_TYPE_LABEL[type] ?? type)}</span>`;
  $('fusion-drawer').dataset.scanType = type;
  $('fusion-side-meta').textContent = `Latest scan ${p.scanAt ? fmtDateTime(p.scanAt) : '—'}${p.scanId ? ` · scan ${p.scanId.slice(0, 8)}` : ''} · ${fmt(all.length)} ${engineLabel(engines)} result(s)`;
  // What its latest scan ran with and added, its size, and the credits it used.
  const row = fusionRows(fusion.data, fusion.scope, engines).find((r) => r.projectId === projectId) ?? {};
  const fact = (label, value, note = '', cls = '') => `<div${cls ? ` class="${cls}"` : ''}><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b>${note ? `<small>${escapeHtml(note)}</small>` : ''}</div>`;
  const charged = { off: 'Not charged', reserved: 'Reserved' }[p.fusionCredits ?? ''] ?? '—';
  $('fusion-side-facts').innerHTML = [
    fact('Model', row.model || '—', row.model ? MODEL_FROM[row.modelFrom] ?? 'as Checkmarx One says' : 'Checkmarx One did not say', 'fusion-model-fact'),
    fact('AI results', fmt(row.total ?? 0), 'found by the AI engine alone'),
    fact('Code', row.loc === null || row.loc === undefined ? '—' : `${fmt(row.loc)} LOC`, [row.files !== null && row.files !== undefined ? `${fmt(row.files)} files` : '', row.engineVersion ? `SAST ${row.engineVersion.split('-')[0]}` : ''].filter(Boolean).join(' · ')),
    fact('Credits, latest scan', scanCreditsText([row]), scanCreditsWhy(row)),
    fact('Fusion credits', charged, p.fusionCredits === 'off' ? 'its scan said: Fusion credits are disabled' : p.fusionCredits === 'reserved' ? 'reserved for its scan' : type === 'last' ? 'a LAST scan' : 'its scan did not say'),
  ].join('');
  const open = $('fusion-side-open');
  open.hidden = !p.url;
  if (p.url) open.href = p.url;
  // Only the chips that have something, so a chip never shows nothing by itself.
  $('fusion-side-chips').innerHTML = FUSION_CHIPS.map(([value, text]) => [value, text, all.filter((r) => fusionChipMatch(value, r)).length])
    .filter(([value, , n]) => !value || n)
    .map(([value, text, n]) => `<button type="button" class="sm fusion-chip" data-fusion-chip="${escapeHtml(value)}" aria-pressed="${value === fusionSideChip}">${escapeHtml(text)} ${fmt(n)}</button>`).join('');
  $('fusion-side-states').innerHTML = [['', 'Any state'], ...FUSION_STATES.map((k) => [k, STATE_LABEL[k]])].map(([value, text]) => [value, text, all.filter((r) => fusionStateMatch(value, r)).length])
    .filter(([value, , n]) => !value || n)
    .map(([value, text, n]) => `<button type="button" class="sm fusion-chip" data-fusion-side-state="${escapeHtml(value)}" aria-pressed="${value === fusionSideState}">${escapeHtml(text)}${value ? ` ${fmt(n)}` : ''}</button>`).join('');
  const date = (iso) => (iso ? fmtDateTime(iso) : '—');
  const item = (r, i) => `<details class="fusion-vuln"${i === 0 ? ' open' : ''}>
      <summary><span class="sev-dot sev-${escapeHtml(r.severity.toLowerCase())}" aria-hidden="true"></span><span class="fusion-vuln-name">${escapeHtml(r.name)}</span><span class="fusion-vuln-tags">${r.aiTriaged ? '<span class="fusion-tag fusion-AI" title="Its state was set by AI Triage">AI-triaged</span>' : ''}${r.engine ? `<span class="fusion-tag fusion-${escapeHtml(r.engine)}">${escapeHtml(ENGINE_LABEL[r.engine] ?? r.engine)}</span>` : ''}</span>
        <span class="fusion-vuln-sub"><b class="sev-word sev-word-${escapeHtml(r.severity.toLowerCase())}">${escapeHtml(SEVERITY_LABEL[r.severity] ?? r.severity)}</b>${escapeHtml(['', scannerLabel(r.scanner), r.status, r.state, r.language, r.source ? fileOf(r.source) : fileOf(r.location.split(' :: ')[0])].filter((part, i) => !i || part).join(' · '))}</span></summary>
      ${r.description ? `<p class="fusion-vuln-desc" translate="no">${escapeHtml(r.description)}</p>` : ''}
      <dl>
        <dt>Severity</dt><dd><span class="sev-word sev-word-pill sev-word-${escapeHtml(r.severity.toLowerCase())}">${escapeHtml(SEVERITY_LABEL[r.severity] ?? r.severity)}</span></dd>
        <dt>Status · state</dt><dd>${escapeHtml([r.status || '—', r.state || '—'].join(' · '))}${r.aiTriaged ? ` <span class="hint">${escapeHtml('(set by AI Triage)')}</span>` : ''}</dd>
        <dt>Language</dt><dd>${escapeHtml(r.language || '—')} <span class="hint">${escapeHtml(r.engine === 'LAST' ? '(only the AI engine covers it)' : r.coveredAs ? `(traditional SAST supports it as ${r.coveredAs})` : '')}</span></dd>
        <dt>CWE</dt><dd>${r.cwe ? `CWE-${escapeHtml(String(r.cwe))}` : '—'}</dd>
        <dt>Scanner</dt><dd>${escapeHtml(scannerLabel(r.scanner))}</dd>
        ${r.source ? `<dt>Source</dt><dd><code>${escapeHtml(r.source)}</code>${r.sourceNode ? ` · ${escapeHtml(r.sourceNode)}` : ''}</dd>
        <dt>Sink</dt><dd>${r.sink ? `<code>${escapeHtml(r.sink)}</code>` : '—'}${r.sinkNode ? ` · ${escapeHtml(r.sinkNode)}` : ''}</dd>` : `<dt>Where</dt><dd>${r.location ? `<code>${escapeHtml(r.location)}</code>` : '—'}</dd>`}
        <dt>First found</dt><dd>${escapeHtml(date(r.firstFoundAt))}</dd>
        <dt>Last found</dt><dd>${escapeHtml(date(r.foundAt))}</dd>
        <dt>Result id</dt><dd><code>${escapeHtml(r.id || '—')}</code></dd>
        ${r.url ? `<dt></dt><dd><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml('Open this result in Checkmarx One')} ↗</a></dd>` : ''}
      </dl></details>`;
  const more = rows.length - fusionSideShown;
  $('fusion-side-list').innerHTML = rows.length
    ? rows.slice(0, fusionSideShown).map(item).join('') + (more > 0 ? `<p class="table-more"><button type="button" class="ghost sm" data-fusion-side-more>${escapeHtml(`Show ${fmt(Math.min(FUSION_SIDE_PAGE, more))} more of ${fmt(more)}`)}</button></p>` : '')
    : `<p class="hint">${escapeHtml(`No ${engineLabel(engines)} results in this project.`)}</p>`;
}

/** What the read found, said once above the figures. */
function fusionStatus(data) {
  // One sentence each, so each is translated whole. The Fusion, LAST and left-out counts are in the figures line.
  const sentences = [
    data.noScan ? `${fmt(data.noScan)} project(s) have no completed scan.` : '',
    data.failures?.length ? `${fmt(data.failures.length)} project(s) could not be read.` : '',
  ].filter(Boolean);
  setStatus('fusion-status', '', data.failures?.length ? 'warn' : 'muted');
  $('fusion-status').innerHTML = sentences.map((line) => `<span>${escapeHtml(line)}</span>`).join(' ');
  $('fusion-tried').innerHTML = '';
}

/**
 * Admins act on what the page shows as on a tracked report's Triage tab: the bar's buttons open the lanes,
 * per kind of credit "Allocate for <next severities>" and "<Triage|Remediate> <what the credits cover>",
 * gold once the credits are there. Only the results of the engines ticked, in the projects shown, count.
 */
function renderFusionLanes() {
  const box = $('fusion-lanes');
  if (!box) return;
  const c = fusion.credits;
  const admin = can('credits.limit');
  $('fusion-act-bar').hidden = !admin;
  for (const b of document.querySelectorAll('[data-fusion-lane]')) b.setAttribute('aria-pressed', String(b.dataset.fusionLane === fusion.lane));
  if (!admin || !fusion.data || !fusion.lane) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  if (!c?.matched) {
    box.innerHTML = `<p class="hint">${escapeHtml(`No ${engineLabel(fusionEngines())} results in the projects shown to allocate for or run AI on.`)}</p>`;
    return;
  }
  const ways = { allocate: can('credits.allocate'), run: can('triage.run') };
  const tiers = { triage: creditTiers(c.triage, c.left.triage), remediation: creditTiers(c.remediation, c.left.remediation) };
  const lanes = fusion.lane === 'both' ? ['triage', 'remediation'] : [fusion.lane];
  box.innerHTML = `<div class="credit-lanes">${lanes.map((kind) => creditLane('fusion', kind, tiers[kind], ways, 'fusion')).join('')}</div>
    <p class="hint">${escapeHtml(`${fmt(c.matched)} ${engineLabel(fusionEngines())} results, in ${fmt(c.projects)} project(s). Credits go to those projects, for these results only: 1 to check a result with AI, 3 to fix it.`)}</p>`;
}

// ---- Labs → Fusion results → Troubleshoot (who manages the Checkmarx One integration) ------------------
const fusionTrouble = { defaults: [], pinned: { results: '', dispatcher: '' }, log: [], on: false };
const FUSION_PATHS_KEY = 'mz-fusion-paths';

async function loadFusionTrouble() {
  if (!can('integration.cxone') || !can('feature.fusionResults')) return;
  try {
    const d = await api('/api/beta/fusion/debug');
    Object.assign(fusionTrouble, { defaults: d.defaults, pinned: d.pinned, log: d.log, on: d.on });
    let saved = '';
    try {
      saved = localStorage.getItem(FUSION_PATHS_KEY) ?? '';
    } catch {}
    if (!$('fusion-paths').value) $('fusion-paths').value = saved || d.defaults.join('\n');
    renderFusionTrouble();
  } catch (error) {
    if (!handleAuthLoss(error)) showError('fusion-probe-status', error);
  }
}

function renderFusionTrouble() {
  const { pinned } = fusionTrouble;
  $('fusion-pinned').innerHTML = pinned.results || pinned.dispatcher
    ? `${escapeHtml('Pinned:')} ${pinned.results ? `<code>${escapeHtml(pinned.results)}</code> ${escapeHtml('for Fusion results')}` : ''}${pinned.results && pinned.dispatcher ? ' · ' : ''}${pinned.dispatcher ? `<code>${escapeHtml(pinned.dispatcher)}</code> ${escapeHtml('for Fusion scan status')}` : ''} <button type="button" class="link" data-fusion-unpin>${escapeHtml('Unpin')}</button>`
    : escapeHtml('Nothing pinned: the page tries /api/correlation/results and /api/correlation/dispatcher.');
  $('fusion-debug').checked = fusionTrouble.on;
  const log = fusionTrouble.log;
  $('fusion-log').hidden = !log.length;
  $('fusion-log').textContent = fusionLogText(log);
  $('fusion-log-count').textContent = log.length ? `${log.length} call(s) logged` : '';
}

/** The log as plain text to share: each call's request and answer, the access token never in it. */
function fusionLogText(log) {
  return log.map((e) => [
    `### ${e.at} ${e.method} ${e.url} (attempt ${e.attempt}) → ${e.status ? `${e.status} ${e.statusText ?? ''}` : `no answer: ${e.error}`} · ${e.ms} ms`,
    `Request headers: ${JSON.stringify(e.request?.headers ?? {})}`,
    ...(e.request?.body ? [`Request body: ${e.request.body}`] : []),
    ...(e.headers ? [`Response headers: ${JSON.stringify(e.headers)}`] : []),
    ...(e.status ? [`Response body${e.truncated ? ' (first 8 KB)' : ''}:`, e.body || '(empty)'] : []),
  ].join('\n')).join('\n\n');
}

/** Where a working path says the service lives: the base to pin, and for which service. */
function fusionPinOf(path) {
  const results = path.match(/^(\/api\/.+?)\/applications(?:\/.*)?$/);
  if (results && !/risk-management|\/api\/applications/.test(path)) return { kind: 'results', base: results[1] };
  const dispatcher = path.match(/^(\/api\/.+?)\/\{appId\}\/scan-status$/);
  if (dispatcher) return { kind: 'dispatcher', base: dispatcher[1] };
  return null;
}

export function renderBetaScope() {
  const scope = allocationScope();
  $('authors-scope').textContent = state.projects.length
    ? `${scope.length} project${scope.length === 1 ? '' : 's'} ${state.selected.size ? 'selected' : 'shown'} on the Workbench`
    : 'Load findings on the Workbench first';
  $('authors-find').disabled = !state.projects.length;
}

async function saveGithubSettings(extra = {}) {
  setStatus('gh-save-status', 'Saving…');
  try {
    const github = {
      apiUrl: $('gh-api').value.trim(),
      org: $('gh-org').value.trim(),
      repos: lines($('gh-repos').value),
      localRepos: lines($('gh-local').value),
      ...extra,
    };
    if ($('gh-token').value.trim()) github.token = $('gh-token').value.trim();
    state.settings = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ beta: { github, authors: { useGithubBlame: $('gh-blame-github').checked, useLocalBlame: $('gh-blame-local').checked } } }),
    });
    $('gh-token').value = '';
    renderBeta();
    setStatus('gh-save-status', 'Saved.', 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('gh-save-status', error);
  }
}

// ---- Usernames → addresses, per source-code host -------------------------------

const HOST_METHODS = {
  github: [
    ['localGit', 'Local git history', 'Noreply commits and author names in repositories you name. No API calls.'],
    ['graphql', 'GraphQL batch', "50 users per request; includes your organisation's verified-domain emails. Needs a token."],
    ['commits', 'Commit author', 'Email on their own commits: in the repositories listed below, or by commit search (30 a minute).'],
    ['profile', 'Public profile', 'The email on their GitHub profile, if public. One request each.'],
  ],
  gitlab: [
    ['localGit', 'Local git history', 'GitLab noreply commits (ID-username@users.noreply…) and author names in repositories you name. No API calls.'],
    ['graphql', 'GraphQL batch', '100 users per request: public email and commit email. Needs a token.'],
    ['users', 'User profile', 'The email on their GitLab profile (every email with an admin token). One request each.'],
    ['commits', 'Commits by their name', 'Their name from the profile, then the address on their commits in the projects you name.'],
  ],
  azure: [
    ['localGit', 'Local git history', 'Author names and addresses in repositories you name. No API calls.'],
    ['graph', 'Organisation directory', 'Everyone in the organisation in a few requests: sign-in name, mail and display name (Azure DevOps Services).'],
    ['identities', 'Identity search', 'One request per user; also on Azure DevOps Server.'],
    ['commits', 'Commit author', 'Commits by that author in the repositories you name.'],
  ],
  bitbucketCloud: [
    ['localGit', 'Local git history', 'Author names and addresses in repositories you name. No API calls.'],
    ['commits', 'Commit authors', 'Recent commits of the repositories you name: each ties the Bitbucket user to the address in its author line. Many people per request.'],
    ['members', 'Workspace members + local history', 'Members give each username a display name; local history gives that name an address.'],
  ],
  bitbucketServer: [
    ['localGit', 'Local git history', 'Author names and addresses in repositories you name. No API calls.'],
    ['commits', 'Commit authors', 'Recent commits of the repositories you name, with each author\'s Bitbucket user and address.'],
    ['directory', 'User directory', 'Up to 1000 people per request, with their email.'],
    ['users', 'User search', 'One request per user.'],
  ],
};
const HOST_NAMES = { github: 'GitHub', gitlab: 'GitLab', azure: 'Azure DevOps', bitbucket: 'Bitbucket' };
let identityHost = 'github';
const hostMethods = () => (identityHost === 'bitbucket' ? (($('bb-kind').value || 'cloud') === 'server' ? HOST_METHODS.bitbucketServer : HOST_METHODS.bitbucketCloud) : HOST_METHODS[identityHost]);

function renderIdentityMethods() {
  $('id-methods').innerHTML = hostMethods()
    .map(([id, title, detail]) => `<label class="method-card"><input type="checkbox" class="gh-method" value="${id}" checked />
      <span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></span></label>`)
    .join('');
  $('id-logins-label').textContent = `${HOST_NAMES[identityHost]} usernames`;
}

let identityReport = null;

function renderIdentityReport(report) {
  const METHOD_NAMES = { ...METHOD_NAMES_GITHUB, ...(report.labels ?? {}), address: 'Already an address' };
  $('gh-results').hidden = false;
  $('gh-recommendation').innerHTML = `<strong>Recommendation</strong><ul>${report.recommendation.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`;
  $('gh-methods').innerHTML = Object.entries(report.methods)
    .map(([name, m]) => {
      if (m.skipped) return `<tr><td>${escapeHtml(METHOD_NAMES[name])}</td><td colspan="6" class="zero">${escapeHtml(m.skipped)}</td></tr>`;
      const notes = [
        m.limited ? 'hit the rate limit' : '',
        m.extra ? `${m.extra.commits} commits read, ${m.extra.loginsSeen} GitHub logins in noreply addresses` : '',
        ...(m.errors ?? []),
      ].filter(Boolean);
      return `<tr>
        <td><strong>${escapeHtml(METHOD_NAMES[name])}</strong></td>
        <td class="num">${m.resolved}</td>
        <td><div class="use-bar wide" title="${m.coverage}%"><span style="width:${m.coverage}%"></span></div><span class="hint inline-hint">${m.coverage}%</span></td>
        <td class="num">${m.requests}</td>
        <td class="num">${m.requestsPerMatch ?? '—'}</td>
        <td class="num">${(m.ms / 1000).toFixed(1)} s</td>
        <td class="notes">${escapeHtml(notes.join(' · ')) || '<span class="zero">—</span>'}</td>
      </tr>`;
    })
    .join('');
  const rows = report.logins.map((login) => ({ login, found: report.combined[login] }));
  $('gh-matches').innerHTML = rows
    .map(({ login, found }) => `<tr class="${found ? '' : 'dim-row'}">
      <td class="checkbox"><input type="checkbox" data-gh-login="${escapeHtml(login)}" ${found && found.confidence === 'high' ? 'checked' : ''} ${found ? '' : 'disabled'} /></td>
      <td>${escapeHtml(login)}</td>
      <td class="mono">${found ? escapeHtml(found.email) : '<span class="zero">not found</span>'}</td>
      <td>${found ? `<span class="badge ${found.confidence === 'high' ? '' : 'warn'}">${escapeHtml(found.confidence)}</span>` : ''}</td>
      <td>${found ? escapeHtml([METHOD_NAMES[found.method], ...(found.agreedBy ?? []).map((m) => METHOD_NAMES[m])].join(', ')) : ''}</td>
      <td class="notes">${found ? escapeHtml(found.evidence) : ''}</td>
    </tr>`)
    .join('');
}

// ---- Code authors ----------------------------------------------------------

let authorItems = [];

/** The pull or merge request a commit came in through, who opened it and who approved it. */
function changeLine(change) {
  if (!change?.number) return '';
  const ref = `${change.kind === 'merge request' ? '!' : '#'}${change.number}`;
  const link = change.url ? `<a href="${escapeHtml(change.url)}" target="_blank" rel="noopener" title="${escapeHtml(change.title || '')}">${escapeHtml(ref)}</a>` : escapeHtml(ref);
  const by = change.author ? ` by ${escapeHtml(change.author)}` : '';
  const approved = change.approvers?.length ? `approved by ${escapeHtml(change.approvers.join(', '))}` : 'no approval recorded';
  return `<div class="hint change-hint">Came in through ${link}${by} · ${approved}</div>`;
}

function renderAuthors() {
  $('authors-wrap').hidden = !authorItems.length;
  $('authors-actions').hidden = !authorItems.some((i) => i.author?.email);
  $('authors-body').innerHTML = authorItems
    .map((i) => {
      const sev = String(i.severity || '').toLowerCase();
      const where = i.location ? `${i.location.path}:${i.location.line}` : '';
      const author = i.author
        ? `<div class="person-main">${avatar(i.author.name || i.author.login || i.author.email)}<span class="person-text"><span class="person-name">${escapeHtml(i.author.name || i.author.login)}</span><span class="person-mail">${escapeHtml(i.author.email || 'no address')}${i.author.emailVia && i.author.emailVia !== 'commit' ? ` · via ${escapeHtml(METHOD_NAMES_GITHUB[i.author.emailVia] || i.author.emailVia)}` : ''}</span></span></div>`
        : '';
      // Only answers git blame is sure of are ticked; an unsure one is there to look at, and to tick on purpose.
      const sure = i.confidence === 'high';
      const confidence = i.commit
        ? `<span class="badge ${sure ? '' : i.confidence === 'medium' ? 'warn' : 'bad'}" title="${escapeHtml(i.confidenceReason || '')}">${sure ? 'Sure' : i.confidence === 'medium' ? 'Check' : 'Unsure'}</span>${i.confidenceReason ? `<div class="hint">${escapeHtml(i.confidenceReason)}</div>` : ''}`
        : '';
      return `<tr class="${i.author?.email ? '' : 'dim-row'}">
        <td class="checkbox"><input type="checkbox" data-author-key="${escapeHtml(i.key)}" ${!i.author?.email ? 'disabled' : sure ? 'checked' : ''} /></td>
        <td class="finding-cell"><span class="sev-dot sev-${escapeHtml(sev)}"></span>${i.url ? `<a href="${escapeHtml(i.url)}" target="_blank" rel="noopener">${escapeHtml(i.title)}</a>` : escapeHtml(i.title)}
          <div class="hint">${escapeHtml(i.projectName)} · ${escapeHtml(i.scanner)}${i.ageDays != null ? ` · ${i.ageDays}d` : ''}</div></td>
        <td class="mono where">${escapeHtml(where)}${i.owners?.list?.length ? `<div class="hint owners-hint" title="From ${escapeHtml(i.owners.file)}">Code owners: ${escapeHtml(i.owners.list.join(', '))}</div>` : ''}${i.problem ? `<div class="hint error-hint">${escapeHtml(i.problem)}</div>` : ''}</td>
        <td>${author}${confidence}</td>
        <td class="mono">${i.commit ? `${i.commitUrl ? `<a href="${escapeHtml(i.commitUrl)}" target="_blank" rel="noopener">${escapeHtml(i.commit.slice(0, 8))}</a>` : escapeHtml(i.commit.slice(0, 8))}<div class="hint">${escapeHtml((i.committedAt || '').slice(0, 10))} · ${escapeHtml([i.host, i.via].filter(Boolean).join(' · '))}</div>${changeLine(i.change)}` : ''}</td>
      </tr>`;
    })
    .join('');
}

async function notifyAuthors(dryRun) {
  const keys = [...document.querySelectorAll('[data-author-key]:checked')].map((b) => b.dataset.authorKey);
  if (!keys.length) return setStatus('authors-send-status', 'Tick at least one finding with an author.', 'error');
  if (!dryRun && !confirm(`Email the authors of ${keys.length} finding(s)?`)) return;
  setStatus('authors-send-status', dryRun ? 'Preparing preview…' : 'Sending…');
  try {
    const result = await api('/api/beta/authors/notify', { method: 'POST', body: JSON.stringify({ keys, dryRun }) });
    if (dryRun) {
      $('authors-preview-wrap').hidden = false;
      $('authors-preview-meta').textContent = `${result.recipients.length} email(s): ${result.recipients.map((r) => `${r.to} (${r.findings})`).join(', ')}. First one: "${result.subject}"`;
      $('authors-preview-frame').srcdoc = result.html;
      setStatus('authors-send-status', '');
    } else {
      setStatus('authors-send-status', `Sent ${result.sent.length} email(s)${result.failed.length ? `, ${result.failed.length} failed: ${result.failed.map((f) => f.error).join('; ')}` : ''}.`, result.failed.length ? 'error' : 'ok');
    }
  } catch (error) {
    if (!handleAuthLoss(error)) showError('authors-send-status', error);
  }
}

export function wireFusionAndAuthors() {
  try {
    const kept = JSON.parse(localStorage.getItem(FUSION_ENGINES_KEY) ?? 'null');
    if (Array.isArray(kept)) setFusionEngines(kept);
  } catch {}
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#fusion-details')) return;
    try {
      localStorage.setItem(FUSION_DETAILS_KEY, fusionDetailsOpen() ? '0' : '1');
    } catch {}
    renderFusion();
  });
  columnMenu($('fusion-cols'), 'fusion-projects', FUSION_COLUMNS, () => {
    renderFusionHead();
    renderFusion();
  });
  renderFusionHead();

  document.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-fusion-filter]');
    if (!chip) return;
    fusionFilter[chip.dataset.fusionFilter] = chip.dataset.value;
    renderFusion();
  });
  $('fusion-ai-triaged')?.addEventListener('change', (event) => {
    fusionFilter.aiTriaged = event.target.checked;
    renderFusion();
  });


  for (const id of ['fusion-q', 'fusion-sev', 'fusion-model']) $(id)?.addEventListener('input', renderFusion);
  for (const id of ['fusion-show-fusion', 'fusion-show-last']) {
    $(id)?.addEventListener('change', (event) => {
      // At least one stays ticked: both off would show nothing.
      if (!$('fusion-show-fusion').checked && !$('fusion-show-last').checked) event.target.checked = true;
      try {
        localStorage.setItem(FUSION_ENGINES_KEY, JSON.stringify(fusionEngines()));
      } catch {}
      renderFusion();
      if (fusion.open) loadFusionSideCredits();
      if (state.projects.length) renderProjects();
    });
  }

  $('fusion-proj-csv')?.addEventListener('click', () => {
    if (!fusion.data) return setStatus('fusion-status', 'Load results first.', 'warn');
    const engines = fusionEngines();
    downloadCsv(`${fusionFileName(engines)}-projects`, [['Project', 'Scan', 'Model', 'Model set', 'LOC', 'Files', 'AI results', 'Credits, latest scan', 'Credits estimated', 'Critical', 'High', 'Medium', 'Low', 'Total', 'New', 'Recurrent', 'Fixed', ...FUSION_STATES.map((k) => STATE_LABEL[k]), 'AI-triaged', 'Latest scan', 'Scan id', 'Link'],
      ...fusionProjectsFiltered().map((r) => [r.name, SCAN_TYPE_LABEL[r.scanType] ?? r.scanType, r.model, MODEL_FROM[r.modelFrom] ?? r.modelFrom, r.loc ?? '', r.files ?? '', r.total ?? 0, r.scanCredits ? r.scanCredits.credits : '', r.scanCredits ? (r.scanCredits.estimate ? 'yes' : 'no') : '', r.CRITICAL, r.HIGH, r.MEDIUM, r.LOW, r.total, r.NEW, r.RECURRENT, r.fixedKnown ? r.FIXED : '', ...FUSION_STATES.map((k) => r[k]), r.aiTriaged, r.scanAt ?? '', r.scanId, r.url])]);
  });
  $('fusion-report')?.addEventListener('click', () => downloadFusionReport());

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-fusion-close]')) return closeFusionSide();
    const chip = event.target.closest('[data-fusion-chip]');
    if (chip) {
      fusionSideChip = chip.dataset.fusionChip;
      fusionSideShown = FUSION_SIDE_PAGE;
      return renderFusionSide();
    }
    const sideState = event.target.closest('[data-fusion-side-state]');
    if (sideState) {
      fusionSideState = sideState.dataset.fusionSideState;
      fusionSideShown = FUSION_SIDE_PAGE;
      return renderFusionSide();
    }
    if (event.target.closest('[data-fusion-side-more]')) {
      fusionSideShown += FUSION_SIDE_PAGE;
      return renderFusionSide();
    }
    const row = event.target.closest('[data-fusion-project], tr[data-fusion-row]');
    if (row) openFusionSide(row.dataset.fusionProject ?? row.dataset.fusionRow);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('fusion-drawer')?.hidden) closeFusionSide();
  });
  $('fusion-side-csv')?.addEventListener('click', () => {
    const { rows } = fusionSideRows();
    const name = fusion.scope?.names?.[fusion.open] ?? fusion.open ?? 'project';
    downloadCsv(`${fusionFileName(fusionEngines())}-${String(name).replace(/[^\w.-]+/g, '-').slice(0, 60)}`, [['Severity', 'Scanner', 'Engine', 'Vulnerability', 'Status', 'State', 'Found by AI', 'State set by AI Triage', 'Language', 'Supported by SAST as', 'CWE', 'Where', 'Source', 'Sink', 'Description', 'First found', 'Last found', 'Project', 'Result id', 'Link', 'Project link'],
      ...rows.map((r) => [SEVERITY_LABEL[r.severity] ?? r.severity, scannerLabel(r.scanner), ENGINE_LABEL[r.engine] ?? r.engine, r.name, r.status, r.state, r.ai ? 'Yes' : 'No', r.aiTriaged ? 'Yes' : 'No', r.language, r.coveredAs, r.cwe ? `CWE-${r.cwe}` : '', r.location, r.source, r.sink, r.description, r.firstFoundAt ?? '', r.foundAt ?? '', r.project, r.id, r.url, r.projectUrl])]);
  });
  $('fusion-side-report')?.addEventListener('click', () => downloadFusionReport(fusion.open));
  $('fusion-scope')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (fusion.loading) return;
    const button = $('fusion-fetch');
    button.disabled = true;
    setStatus('fusion-status', 'Loading results…');
    fusion.loading = (async () => {
      try {
        const { fusion: data, scope, credits } = await api('/api/beta/fusion/fetch', { method: 'POST', body: JSON.stringify({ applications: $('fusion-apps-in').value, projects: $('fusion-projects-in').value }) });
        Object.assign(fusion, { data, scope, credits });
        fusionFocusSent = '';
        fusionStatus(data);
      } catch (error) {
        if (!handleAuthLoss(error)) showError('fusion-status', error);
      } finally {
        fusion.loading = null;
        button.disabled = false;
        if (fusionTrouble.on) loadFusionTrouble();
        renderFusion();
        if (state.projects.length) renderProjects();
      }
    })();
  });
  $('fusion-read')?.addEventListener('click', () => {
    fusionFocusSent = '';
    readFusion();
  });

  document.addEventListener('click', async (event) => {
    const lane = event.target.closest('[data-fusion-lane]');
    if (lane) {
      fusion.lane = fusion.lane === lane.dataset.fusionLane ? null : lane.dataset.fusionLane;
      return renderFusionLanes();
    }
    const button = event.target.closest('[data-fusion-allocate], [data-fusion-triage], [data-fusion-remediate], [data-fusion-reread]');
    if (!button) return;
    if (button.hasAttribute('data-fusion-reread')) return readFusion();
    const severities = (button.dataset.severities || '').split(',').filter(Boolean);
    if (!severities.length) return;
    const allocate = button.hasAttribute('data-fusion-allocate');
    const kind = allocate ? button.dataset.kind : button.hasAttribute('data-fusion-triage') ? 'triage' : 'remediation';
    const label = engineLabel(fusionEngines());
    // From a project's side panel: that project alone; from the bar, the projects shown.
    const side = [button.dataset.fusionAllocate, button.dataset.fusionTriage, button.dataset.fusionRemediate].includes('side');
    const scopeText = side ? 'in this project' : 'in the projects shown';
    const question = allocate
      ? kind === 'triage'
        ? `Allocate AI Triage credits from the credit pool for the ${label} results at the severities on the button, ${scopeText} (1 per Checkmarx One result), confirmed with Checkmarx One as they are given?`
        : `Allocate AI Remediation credits from the credit pool for the confirmed ${label} results at the severities on the button, ${scopeText} (3 per confirmed result), confirmed with Checkmarx One as they are given?`
      : kind === 'triage'
        ? `Run AI Triage on the ${label} results at the severities on the button, ${scopeText}, that are still awaiting triage? It uses Checkmarx One credits.`
        : `Run AI Remediation on the confirmed ${label} results at the severities on the button, ${scopeText}? It uses 3 Checkmarx One credits each.`;
    const where = side ? 'fusion-side-status' : 'fusion-act-status';
    if (!confirm(question)) return;
    button.disabled = true;
    setStatus(where, allocate ? 'Allocating…' : kind === 'triage' ? 'Starting AI Triage…' : 'Starting AI Remediation…');
    try {
      const focus = side ? fusionSideBody() : fusionFocusBody();
      const result = await api(`/api/beta/fusion/${allocate ? 'allocate' : kind === 'triage' ? 'triage' : 'remediate'}`, {
        method: 'POST',
        body: JSON.stringify(allocate ? { severities, kind, ...focus } : { severities, ...focus }),
      });
      const left = result.credits ?? (side ? fusionSide.credits : fusion.credits);
      if (side) fusionSide.credits = left;
      else fusion.credits = left;
      setStatus(where, allocate
        ? `Allocated. ${side ? 'This project now has' : 'These projects now have'} ${left.left.triage} triage and ${left.left.remediation} remediation credit(s) left.${noteGone(result)}`
        : spendText(result, kind), result.failed ? 'error' : 'ok');
      creditsChanged();
      // The other place shows the same projects' credits: read again.
      fusionFocusSent = '';
      if (side) fusionFocusChanged();
      else if (fusion.open) loadFusionSideCredits();
    } catch (error) {
      if (!handleAuthLoss(error)) showError(where, error);
    } finally {
      button.disabled = false;
      if (side) renderFusionSideLanes();
      else renderFusionLanes();
    }
  });

  $('fusion-probe')?.addEventListener('click', async () => {
    const paths = $('fusion-paths').value.split('\n').map((p) => p.trim()).filter(Boolean);
    try {
      localStorage.setItem(FUSION_PATHS_KEY, $('fusion-paths').value);
    } catch {}
    setStatus('fusion-probe-status', `Testing ${paths.length} path(s)…`);
    try {
      const r = await api('/api/beta/fusion/probe', { method: 'POST', body: JSON.stringify({ paths }) });
      $('fusion-probe-body').innerHTML = r.results.map((x) => {
        const pin = x.ok ? fusionPinOf(x.path) : null;
        return `<tr><td class="path">${escapeHtml(x.path)}</td><td class="num"><span class="badge ${x.ok ? 'ok' : 'warn'}">${escapeHtml(String(x.status || '—'))}</span></td><td class="num">${fmt(x.ms)} ms</td><td class="answer">${escapeHtml(x.answer.length > 300 ? `${x.answer.slice(0, 300)}…` : x.answer)}</td><td>${pin ? `<button type="button" class="sm" data-fusion-pin="${escapeHtml(pin.base)}" data-kind="${pin.kind}">${escapeHtml(pin.kind === 'results' ? 'Use for Fusion results' : 'Use for Fusion scan status')}</button>` : ''}</td></tr>`;
      }).join('');
      const working = r.results.filter((x) => x.ok).length;
      setStatus('fusion-probe-status', `${working} of ${r.results.length} answered.`, working ? 'ok' : 'warn');
      if (fusionTrouble.on) loadFusionTrouble();
    } catch (error) {
      if (!handleAuthLoss(error)) showError('fusion-probe-status', error);
    }
  });
  $('fusion-paths-reset')?.addEventListener('click', () => {
    $('fusion-paths').value = fusionTrouble.defaults.join('\n');
    try {
      localStorage.removeItem(FUSION_PATHS_KEY);
    } catch {}
  });
  $('fusion-debug')?.addEventListener('change', async (event) => {
    try {
      const d = await api('/api/beta/fusion/debug', { method: 'PUT', body: JSON.stringify({ on: event.target.checked }) });
      Object.assign(fusionTrouble, { on: d.on, log: d.log });
      renderFusionTrouble();
    } catch (error) {
      if (!handleAuthLoss(error)) showError('fusion-probe-status', error);
    }
  });
  $('fusion-log-clear')?.addEventListener('click', async () => {
    const d = await api('/api/beta/fusion/debug', { method: 'PUT', body: JSON.stringify({ clear: true }) }).catch(() => null);
    if (d) Object.assign(fusionTrouble, { on: d.on, log: d.log });
    renderFusionTrouble();
  });
  $('fusion-log-copy')?.addEventListener('click', async () => {
    await loadFusionTrouble();
    try {
      await navigator.clipboard.writeText(fusionLogText(fusionTrouble.log));
      setStatus('fusion-probe-status', 'The log is copied.', 'ok');
    } catch {
      setStatus('fusion-probe-status', 'Could not copy: select the log and copy it.', 'warn');
    }
  });
  $('fusion-log-download')?.addEventListener('click', async () => {
    await loadFusionTrouble();
    const blob = new Blob([fusionLogText(fusionTrouble.log)], { type: 'text/plain' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `fusion-debug-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  document.addEventListener('click', async (event) => {
    const pin = event.target.closest('[data-fusion-pin], [data-fusion-unpin]');
    if (!pin) return;
    const endpoints = pin.hasAttribute('data-fusion-unpin')
      ? { fusionResultsPath: '', fusionDispatcherPath: '' }
      : { [pin.dataset.kind === 'results' ? 'fusionResultsPath' : 'fusionDispatcherPath']: pin.dataset.fusionPin };
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify({ endpoints }) });
      await loadFusionTrouble();
      setStatus('fusion-probe-status', pin.hasAttribute('data-fusion-unpin') ? 'Unpinned.' : 'Pinned: Fusion is read from there now.', 'ok');
      if (!pin.hasAttribute('data-fusion-unpin')) readFusion();
    } catch (error) {
      if (!handleAuthLoss(error)) showError('fusion-probe-status', error);
    }
  });

  $('gh-save').addEventListener('click', () => saveGithubSettings());
  $('gh-clear-token').addEventListener('click', () => {
    if (confirm('Remove the stored GitHub token?')) saveGithubSettings({ token: null });
  });

  for (const radio of document.querySelectorAll('input[name="idHost"]')) {
    radio.addEventListener('change', () => {
      identityHost = radio.value;
      identityReport = null;
      $('gh-results').hidden = true;
      setStatus('gh-status', '');
      renderIdentityMethods();
    });
  }

  $('gh-load-logins').addEventListener('click', async () => {
    try {
      const { logins } = await api(`/api/beta/scm/logins?provider=${identityHost}`);
      if (!logins.length) return setStatus('gh-status', 'No usernames among the developers: load findings on the Workbench, or type them in.', 'error');
      // Unresolved ones first: those are the ones worth matching.
      logins.sort((a, b) => Number(b.unresolved) - Number(a.unresolved));
      $('gh-logins').value = logins.map((l) => l.login).join('\n');
      setStatus('gh-status', `${logins.length} username(s) from the developers, ${logins.filter((l) => l.unresolved).length} without an email.`, 'ok');
    } catch (error) {
      if (!handleAuthLoss(error)) showError('gh-status', error);
    }
  });

  $('gh-evaluate').addEventListener('click', async () => {
    const methods = [...document.querySelectorAll('.gh-method:checked')].map((b) => b.value);
    if (!methods.length) return setStatus('gh-status', 'Pick at least one method.', 'error');
    const button = $('gh-evaluate');
    button.disabled = true;
    setStatus('gh-status', 'Comparing methods… (local clones can take a minute the first time)');
    try {
      identityReport = await api(identityHost === 'github' ? '/api/beta/github/evaluate' : '/api/beta/scm/evaluate', {
        method: 'POST',
        body: JSON.stringify({ provider: identityHost, logins: lines($('gh-logins').value), methods }),
      });
      renderIdentityReport(identityReport);
      setStatus('gh-status', `Matched ${identityReport.resolved} of ${identityReport.logins.length} username(s).`, 'ok');
    } catch (error) {
      if (!handleAuthLoss(error)) showError('gh-status', error);
    } finally {
      button.disabled = false;
    }
  });

  $('gh-all').addEventListener('change', () => {
    for (const box of document.querySelectorAll('[data-gh-login]:not(:disabled)')) box.checked = $('gh-all').checked;
  });

  $('gh-apply').addEventListener('click', async () => {
    const mappings = [...document.querySelectorAll('[data-gh-login]:checked')].map((box) => ({
      login: box.dataset.ghLogin,
      email: identityReport.combined[box.dataset.ghLogin]?.email,
    }));
    if (!mappings.length) return setStatus('gh-apply-status', 'Tick the matches to use.', 'error');
    try {
      const result = await api('/api/beta/scm/apply', { method: 'POST', body: JSON.stringify({ provider: identityHost, mappings }) });
      setStatus('gh-apply-status', `${result.applied} saved. Fetch again on the Workbench to use them.`, 'ok');
    } catch (error) {
      if (!handleAuthLoss(error)) showError('gh-apply-status', error);
    }
  });

  $('authors-find').addEventListener('click', async () => {
    const severities = [...document.querySelectorAll('.authors-sev:checked')].map((b) => b.value);
    const button = $('authors-find');
    button.disabled = true;
    setStatus('authors-status', 'Locating findings, reading git history and resolving authors… (the first run clones each repository)');
    try {
      const result = await api('/api/beta/authors/find', {
        method: 'POST',
        body: JSON.stringify({ projectIds: allocationScope().map((p) => p.projectId), severities, limit: Number($('authors-limit').value) || 50 }),
      });
      authorItems = result.items;
      const s = result.summary;
      $('authors-stats').innerHTML = `
      <span class="stat"><b>${s.findings}</b> findings</span>
      <span class="stat"><b>${s.blamed}</b> traced to a commit</span>
      <span class="stat ok"><b>${s.sure ?? 0}</b> sure</span>${s.unsure ? `<span class="stat"><b>${s.unsure}</b> to check (not ticked)</span>` : ''}
      <span class="stat ok"><b>${s.authors}</b> author${s.authors === 1 ? '' : 's'} with email</span>
      <span class="stat"><b>${s.githubRequests}</b> GitHub API call${s.githubRequests === 1 ? '' : 's'}</span>`;
      renderAuthors();
      setStatus('authors-status', s.withEmail ? `${s.withEmail} finding(s) can go to their author.` : 'No author could be reached for these findings.', s.withEmail ? 'ok' : 'error');
    } catch (error) {
      if (!handleAuthLoss(error)) showError('authors-status', error);
    } finally {
      button.disabled = false;
    }
  });

  $('authors-all').addEventListener('change', () => {
    for (const box of document.querySelectorAll('[data-author-key]:not(:disabled)')) box.checked = $('authors-all').checked;
  });
  $('authors-preview').addEventListener('click', () => notifyAuthors(true));
  $('authors-send').addEventListener('click', () => notifyAuthors(false));
}

// ---- GitLab, Azure DevOps and Bitbucket connections --------------------------

function hostSettings(id) {
  if (id === 'gitlab') return { apiUrl: $('gl-url').value.trim(), group: $('gl-group').value.trim(), projects: lines($('gl-projects').value), token: $('gl-token').value.trim() };
  if (id === 'azure') return { orgUrl: $('az-org').value.trim(), repos: lines($('az-repos').value), token: $('az-token').value.trim() };
  const kind = $('bb-kind').value;
  return { kind, apiUrl: kind === 'server' ? $('bb-url').value.trim() : '', username: $('bb-user').value.trim(), workspace: $('bb-workspace').value.trim(), repos: lines($('bb-repos').value), token: $('bb-token').value.trim() };
}
const TOKEN_FIELDS = { gitlab: 'gl-token', azure: 'az-token', bitbucket: 'bb-token' };

async function saveHost(id, extra = {}) {
  const status = document.querySelector(`[data-host-status="${id}"]`);
  const settings = { ...hostSettings(id), ...extra };
  if (!settings.token && extra.token !== null) delete settings.token;
  status.textContent = 'Saving…';
  status.className = 'status';
  try {
    state.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ beta: { [id]: settings } }) });
    $(TOKEN_FIELDS[id]).value = '';
    renderBeta();
    status.textContent = 'Saved.';
    status.className = 'status ok';
    return true;
  } catch (error) {
    if (!handleAuthLoss(error)) {
      status.textContent = error.message;
      status.className = 'status error';
    }
    return false;
  }
}

export function wireGitHosts() {
  document.addEventListener('click', async (event) => {
    const save = event.target.closest?.('[data-host-save]');
    const test = event.target.closest?.('[data-host-test]');
    const clear = event.target.closest?.('[data-host-clear]');
    if (save) saveHost(save.dataset.hostSave);
    if (clear && confirm(`Remove the stored ${HOST_NAMES[clear.dataset.hostClear]} token?`)) saveHost(clear.dataset.hostClear, { token: null });
    if (test) {
      const id = test.dataset.hostTest;
      const status = document.querySelector(`[data-host-status="${id}"]`);
      if ($(TOKEN_FIELDS[id]).value.trim() && !(await saveHost(id))) return;
      status.textContent = 'Testing…';
      status.className = 'status';
      try {
        const result = (await api('/api/beta/scm/check', { method: 'POST', body: JSON.stringify({ provider: id }) }))[id];
        status.textContent = result?.ok ? `Connected${result.who ? ` as ${result.who}` : ''}.` : result?.reason ?? 'Not connected.';
        status.className = `status ${result?.ok ? 'ok' : 'error'}`;
        showHelp(status, result?.ok ? null : result?.help);
      } catch (error) {
        if (!handleAuthLoss(error)) {
          status.textContent = error.message;
          status.className = 'status error';
        }
      }
    }
  });
  $('bb-kind').addEventListener('change', () => {
    $('bb-url').disabled = $('bb-kind').value !== 'server';
    if (identityHost === 'bitbucket') renderIdentityMethods();
  });
}
