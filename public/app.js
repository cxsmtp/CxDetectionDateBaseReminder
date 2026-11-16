// The page's entry point. Each page or concern is a module under app/. This file loads them and runs what each does
// when the page loads (its wire…() functions: listeners, the first drawing of the menu and the columns), in the order
// that code has always run in, and starts the page: the server's health, the session, the first route.

// The files that were here before app/, first and in the order they have always been imported in: they load in that order.
import './speedsters.js';
import './calculator/page.js';
import './fae-flush.js';
// Labs → Status board and Consolidated view (beta), and the tenant switcher they share.
import './status-board.js';
import './consolidated.js';
import './govern.js';
import './tenant-menu.js';
import './mobile.js';
import './nav-map.js';
import './qr.js';
import { creditTiers } from './credit-tiers.js';
import { describeEngines } from './engines.js';
import { t } from './i18n.js';
import { helpMode, setHelpMode, startHelpTips } from './help-tips.js';
import { startTableTools, sortAndFilter, tableFiltered } from './table-tools.js';
import { shownColumns as columnsShownOf, columnMenu } from './column-prefs.js';
import { shownEngines, filtering, MODEL_FROM, SCAN_TYPE_LABEL, engineLabel, fusionRows, fusionTiles, PERIOD_LABEL, FUSION_STATES, FUSION_STATUSES, STATE_LABEL, countsFor, wordsLabel, fusionReportHtml, fusionResultRows, ENGINE_LABEL, fileOf, scannerLabel } from './fusion-view.js';

// The page's own modules.
import { $, can, canAny, state } from './app/state.js';
import { escapeHtml, fmt, fmtDateTime, formatTime } from './app/format.js';
import { api, handleAuthLoss, logger, setStatus, showError, showHelp, toast, wireCore, wireLogs } from './app/core.js';
import { applyPermissions, wireAdvancedAndFeatures, wireLayout, wireMenuAndTabs, wirePagesAndPalette } from './app/nav.js';
import { applyAppBranding, languagesChanged, moneyOf, openProfileOf, wireAppBranding, wireLanguageAndProfile, wireMyBranding, wireThemeAndLook } from './app/profile.js';
import { afterSignIn, copyButton, resetLinkToken, showReset, showSignIn, showSsoRefusal, ssoRefusalCode, wireConnections, wireSignIn, wireTerms } from './app/session.js';
import { wireSettings, wireSettingsChecks, wireSupportNote } from './app/settings.js';
import { wireAboutAndUpdates, wireActivationAndTenants, wireHttps, wireServerConnections } from './app/system.js';
import { SEVERITY_LABEL, wireAutomation, wireAutomationRun, wireHandsOff } from './app/automation.js';
import { fillAgePresets, fillPresets, focusPick, renderEnginePick, renderFocusPick, syncNarrow, updateScopeSummary, wireActionRail, wireFetch, wireFetchStop, wireGettingStarted, wireScope } from './app/workbench.js';
import { avatar, fusion, renderProjects, wireColumns, wireProjectFilters, wireProjectRows, wireSortAndInitiators } from './app/projects.js';
import { allocationScope, renderAllocation, wireAllocation, wireReminders } from './app/actions.js';
import { creditLane, spendText, wireReports, wireRescanLinks } from './app/reports.js';
import { wireHelp } from './app/help.js';

wireCore();
wireAdvancedAndFeatures();
wireHandsOff();
wireMyBranding();
wireActivationAndTenants();
wireMenuAndTabs();
wireThemeAndLook();
wireConnections();
wireAutomation();
wireSupportNote();

// ---------------------------------------------------------------------------
// The credit pool (Settings → AI & credit pool; live while the page is open)
// ---------------------------------------------------------------------------

const CREDIT_REFRESH_MS = 15_000;
export let creditTimer = null;
const periodText = (pool) => (pool.period === 'all' ? 'one pool, does not refill' : 'refills on the 1st of each month (UTC)');

export async function loadPool({ fresh = false } = {}) {
  clearTimeout(creditTimer);
  if ($('page-settings').hidden) return;
  try {
    const data = await api(fresh ? '/api/credits?fresh=1' : '/api/credits');
    renderPool(data);
  } catch (error) {
    if (handleAuthLoss(error)) return;
    $('pool-view').innerHTML = `<p class="status error">${escapeHtml(error.message)}</p>`;
  }
  creditTimer = setTimeout(loadPool, CREDIT_REFRESH_MS);
}

/** Pool meter + tiles: used (triage / remediation), left, given to projects, free to give. */
function poolHtml(pool, { compact = false } = {}) {
  const used = pool.used;
  const tiles = [
    { label: 'Pool', value: pool.limited ? fmt(pool.size) : 'No limit', detail: pool.limited ? (pool.period === 'all' ? 'One pool' : 'This month') : 'Set a pool size to cap spending' },
    { label: 'Used', value: fmt(used.total), detail: `Triage ${fmt(used.triage)} · Remediation ${fmt(used.remediation)}`, hero: true },
    { label: 'Remaining', value: pool.limited ? fmt(pool.remaining) : '—', detail: pool.limited ? `${Math.round(((pool.remaining ?? 0) / Math.max(1, pool.size)) * 100)}% of the pool` : 'No limit set', bad: pool.limited && pool.remaining === 0 },
    { label: 'Given to projects, not used', value: fmt(pool.outstanding.total), detail: `Triage ${fmt(pool.outstanding.triage)} · Remediation ${fmt(pool.outstanding.remediation)}` },
    { label: 'Free to give', value: pool.limited ? fmt(pool.unallocated) : '—', detail: pool.overAllocated ? `Projects hold ${fmt(pool.overAllocated)} more than the pool has left` : 'Can still be allocated to projects', bad: pool.overAllocated > 0 },
  ];
  // Checkmarx One has fewer credits left for the tenant than the pool: spending stops at what the tenant has left.
  if (pool.overTenant) Object.assign(tiles[2], { detail: `Checkmarx One: ${fmt(pool.tenantLeft)} left for the tenant`, bad: true });
  const over = pool.overTenant
    ? `<p class="status error">${escapeHtml(`The pool has ${fmt(pool.remaining)} credits left, but Checkmarx One has only ${fmt(pool.tenantLeft)} left for this tenant: spending stops at ${fmt(pool.tenantLeft)}.`)} <a href="#/settings/ai">${escapeHtml('Lower the pool')}</a></p>`
    : '';
  const tileHtml = `${over}<div class="stat-tiles">${tiles
    .map((t) => `<div class="${t.hero ? 'hero' : ''} ${t.bad ? 'bad' : ''}"><span class="label">${escapeHtml(t.label)}</span><span class="value">${escapeHtml(t.value)}</span><span class="detail">${escapeHtml(t.detail)}</span></div>`)
    .join('')}</div>`;
  if (!pool.limited) return compact ? tileHtml : tileHtml;
  const pct = (n) => `${Math.max(0, (n / Math.max(1, pool.size)) * 100).toFixed(2)}%`;
  const given = Math.min(pool.outstanding.total, pool.remaining ?? 0);
  const meter = `<div class="pool-meter" role="img" aria-label="${escapeHtml(`Of ${fmt(pool.size)} credits: ${fmt(used.triage)} used for triage, ${fmt(used.remediation)} for remediation, ${fmt(given)} given to projects and not used, ${fmt(pool.unallocated)} free`)}">
      <span class="m-triage" style="width:${pct(used.triage)}" title="Triage: ${fmt(used.triage)}"></span>
      <span class="m-remediation" style="width:${pct(used.remediation)}" title="Remediation: ${fmt(used.remediation)}"></span>
      <span class="m-given" style="width:${pct(given)}" title="Given to projects, not used: ${fmt(given)}"></span>
    </div>
    <div class="pool-legend">
      <span><i class="key key-triage"></i>Used for triage <b>${fmt(used.triage)}</b></span>
      <span><i class="key key-remediation"></i>Used for remediation <b>${fmt(used.remediation)}</b></span>
      <span><i class="key key-given"></i>Given to projects, not used <b>${fmt(given)}</b></span>
      <span><i class="key key-free"></i>Free to give <b>${fmt(pool.unallocated)}</b></span>
    </div>`;
  return tileHtml + meter;
}

function renderPool(data) {
  const pool = data.pool;
  const allowed = [data.enabled && 'triage', data.remediationEnabled && 'remediation'].filter(Boolean);
  $('credit-state').textContent = allowed.length
    ? `Allowed: ${allowed.join(' and ')}${pool.limited ? ` · ${fmt(pool.remaining)} of ${fmt(pool.size)} credits left` : ' · no credit limit'}`
    : 'Switched off';
  $('credit-state').className = `hint ${allowed.length ? 'ok-hint' : ''}`;
  const warning = allowed.length && !data.relayConnected
    ? '<p class="status error">This server is not connected to Checkmarx One, so reports cannot triage or remediate. Connect it under "Checkmarx One integration" above.</p>'
    : '';
  // What the tenant has left in Checkmarx One: the pool, and what projects are given, stay within it.
  poolTenant = data.tenant ?? null;
  renderPoolTenant(data);
  checkPoolLimit();
  $('pool-view').innerHTML = `${warning}${poolHtml(pool)}<p class="hint wide">${escapeHtml(pool.limited ? `The pool ${periodText(pool)}.` : 'No pool size set: spending is limited by what each project is allocated, and by what the tenant has left.')} Per project and over time: <a href="#/credits">Credits</a>.</p>`;
}

/** The tenant's credits as Checkmarx One last said (Settings → AI & credit pool), or null when it did not answer. */
export let poolTenant = null;

/** The Checkmarx One tenant card beside the pool size: what is left, used, given to projects. */
function renderPoolTenant(data) {
  const t = data.tenant;
  const held = data.pool?.outstanding?.total ?? 0;
  const read = `<small>${t?.readAt ? `<span>${escapeHtml('read')}</span> <time translate="no">${escapeHtml(fmtDateTime(t.readAt))}</time> · ` : ''}<a href="#" id="pool-tenant-read">${escapeHtml('read again')}</a></small>`;
  if (!t) {
    $('pool-tenant-card').innerHTML = `<h4>${escapeHtml('Checkmarx One tenant')} ${read}</h4><p class="hint">${escapeHtml('Checkmarx One did not say what this tenant has left. The pool is checked against it when it answers.')}</p>`;
    return;
  }
  const pct = (n) => (t.total ? `${Math.min(100, (n / t.total) * 100).toFixed(2)}%` : '0%');
  const within = (n) => `<span class="${n <= t.available ? 'ok-text' : 'bad-text'}">${escapeHtml(n <= t.available ? 'within what is left' : 'more than is left')}</span>`;
  const size = data.pool?.limited ? data.pool.size : 0;
  const charged = { off: 'not charged on this tenant', reserved: 'credits reserved for each scan' }[data.fusionCharged];
  const rows = [
    t.used !== null && ['Used', escapeHtml(`${fmt(t.used)}${t.actionsPerformed !== null ? ` · ${fmt(t.actionsPerformed)} actions` : ''}`)],
    ['Given to projects', `${escapeHtml(`${fmt(held)} of ${fmt(t.available)}`)} · ${within(held)}`],
    ["This app's pool", size ? `${escapeHtml(fmt(size))} · ${within(size)}` : escapeHtml('no size: up to what is left')],
    charged && ['Fusion scans', escapeHtml(charged)],
  ];
  $('pool-tenant-card').innerHTML = `<h4>${escapeHtml('Checkmarx One tenant')} ${read}</h4>
    <div class="fusion-big"><div><b>${escapeHtml(fmt(t.available))}</b><span>${escapeHtml(t.total !== null ? `credits left of ${fmt(t.total)}` : 'credits left')}</span></div></div>
    ${t.total ? `<div class="fusion-meter" role="img" aria-label="${escapeHtml(`${fmt(t.used ?? 0)} of ${fmt(t.total)} used`)}"><i class="is-used" style="width:${pct(t.used ?? 0)}"></i><i class="is-held" style="width:${pct(held)}"></i></div>` : ''}
    <dl class="fusion-kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

/** The pool size against what the tenant has left, as it is typed: within it, or why it cannot be saved. */
export function checkPoolLimit() {
  const t = poolTenant;
  const box = $('ai-limit-check');
  $('ai-limit-max').textContent = t ? `at most ${fmt(t.available)}` : '';
  const size = Math.floor(Number($('ai-limit').value) || 0);
  $('ai-limit').classList.toggle('is-invalid', Boolean(t && size > t.available));
  if (!t) {
    box.innerHTML = '';
    return;
  }
  if (size <= 0) {
    box.innerHTML = `<p class="hint">${escapeHtml(`No size: up to the ${fmt(t.available)} credits the tenant has left.`)}</p>`;
  } else if (size <= t.available) {
    box.innerHTML = `<p class="hint"><span class="ok-text">✓ <span>${escapeHtml('Within what the tenant has left')}</span></span> · <span>${escapeHtml(`${fmt(t.available - size)} credits stay outside the pool.`)}</span></p>`;
  } else {
    box.innerHTML = `<p class="status error"><span>${escapeHtml(`${fmt(size)} is more than the ${fmt(t.available)} credits this tenant has left in Checkmarx One. Set ${fmt(t.available)} or less to save.`)}</span> <button type="button" class="sm" id="ai-limit-fit">${escapeHtml(`Use ${fmt(t.available)}`)}</button></p>`;
  }
}
$('ai-limit').addEventListener('input', checkPoolLimit);
$('ai-limit-check').addEventListener('click', (event) => {
  if (!event.target.closest('#ai-limit-fit') || !poolTenant) return;
  $('ai-limit').value = String(poolTenant.available);
  $('ai-limit').dispatchEvent(new Event('input', { bubbles: true }));
});
$('pool-tenant-card').addEventListener('click', (event) => {
  if (!event.target.closest('#pool-tenant-read')) return;
  event.preventDefault();
  loadPool({ fresh: true });
});

wireSettings();
wireScope();
wireColumns();
wireRescanLinks();
wireFetchStop();
wireSignIn();
wireFetch();
wireProjectFilters();
wireReminders();
wireAutomationRun();
wireSettingsChecks();
wireSortAndInitiators();
wireAllocation();
wireReports();
wireProjectRows();
wireLogs();
wireAppBranding();
wireActionRail();
wireAboutAndUpdates();
wireGettingStarted();
wireHelp();
wirePagesAndPalette();

(async function init() {
  // Sort and filter from the column headings, on every data table (public/table-tools.js).
  startTableTools({ translate: t });
  // Explanations behind a "?" (or shown, as chosen under Settings → Your appearance; kept in this browser).
  setHelpMode(helpMode());
  for (const radio of document.querySelectorAll('input[name="look-help"]')) {
    radio.checked = radio.value === helpMode();
    radio.addEventListener('change', () => radio.checked && setHelpMode(radio.value));
  }
  startHelpTips({ translate: t });
  try {
    state.health = await api('/api/health');
    if (Array.isArray(state.health.languages)) languagesChanged(state.health.languages);
    if (state.health.version) {
      $('app-version').textContent = state.health.version;
      $('app-version').hidden = false;
    }
    applyAppBranding(state.health.app);
    for (const problem of state.health.problems) console.warn(problem);
    syncNarrow();
    // Every open finding, whatever its age, in the projects scanned in the last 90 days: the old findings are
    // what this is for, and a project nobody scans any more is skipped (Narrow down changes that).
    fillPresets('activity-preset', '90d');
    fillAgePresets('any');
    renderEnginePick();
    renderFocusPick();
    updateScopeSummary();
  } catch {
    /* health is advisory only */
  }

  // Opened from an emailed reset link: that comes first, signed in or not (using it signs everyone out).
  const token = resetLinkToken();
  if (token) return showReset(token);
  // Back from the identity provider without a sign-in: the reason, by its code, once the page knows nobody is signed in.
  const ssoRefused = ssoRefusalCode();
  if (ssoRefused) history.replaceState(null, '', location.pathname + location.search);
  try {
    const session = await api('/api/session');
    if (session.signedIn) await afterSignIn(session);
    else {
      showSignIn({ setup: session.setup });
      if (ssoRefused) showSsoRefusal(ssoRefused);
      if (session.firstStart) {
        setStatus('signin-status', 'First start: sign in with the administrator email and password printed in the server (container) log.', 'ok');
      }
    }
  } catch (error) {
    showSignIn({ message: error.message });
  }
})();


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
try {
  const kept = JSON.parse(localStorage.getItem(FUSION_ENGINES_KEY) ?? 'null');
  if (Array.isArray(kept)) setFusionEngines(kept);
} catch {}

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
document.addEventListener('click', (event) => {
  if (!event.target.closest('#fusion-details')) return;
  try {
    localStorage.setItem(FUSION_DETAILS_KEY, fusionDetailsOpen() ? '0' : '1');
  } catch {}
  renderFusion();
});

/** The Fusion page's projects table, a column each: its heading, its cell, and what it sorts and filters by. */
const fusionCell = {
  count: (n, cls = '') => `<td class="num c-count ${n ? cls : 'zero'}">${fmt(n)}</td>`,
  maybe: (n) => `<td class="num${n === null || n === undefined ? ' zero' : ''}">${n === null || n === undefined ? '—' : fmt(n)}</td>`,
};
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
    id: 'share',
    label: 'AI share of SAST',
    num: true,
    title: 'The AI engine\'s results as a share of all its latest scan\'s SAST results: 20 of 100 is 20%',
    sort: { value: (r) => r.aiShare, text: (r) => (r.aiShare === null ? '' : `${r.aiShare}%`) },
    cell: (r) => (r.aiShare === null ? '<td class="num zero" title="Checkmarx One did not say how many SAST results its latest scan has">—</td>' : `<td class="num" title="${escapeHtml(`${fmt(r.total)} of ${fmt(r.sastResults)} SAST results`)}">${fmt(r.aiShare)}%</td>`),
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
function renderFusionHead() {
  const shown = fusionColumnsShown();
  $('fusion-table').dataset.tt = fusionTableKey();
  $('fusion-head').innerHTML = shown.map((c) => `<th${c.num ? ' class="num"' : ''}${c.title ? ` title="${escapeHtml(c.title)}"` : ''}>${escapeHtml(c.label)}</th>`).join('');
}
columnMenu($('fusion-cols'), 'fusion-projects', FUSION_COLUMNS, () => {
  renderFusionHead();
  renderFusion();
});
renderFusionHead();

export function renderFusion() {
  const tiles = $('fusion-tiles');
  if (!tiles) return;
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

$('fusion-proj-csv')?.addEventListener('click', () => {
  if (!fusion.data) return setStatus('fusion-status', 'Load results first.', 'warn');
  const engines = fusionEngines();
  downloadCsv(`${fusionFileName(engines)}-projects`, [['Project', 'Scan', 'Model', 'Model set', 'LOC', 'Files', 'AI results', 'Credits, latest scan', 'Credits estimated', 'Critical', 'High', 'Medium', 'Low', 'Total', 'New', 'Recurrent', 'Fixed', ...FUSION_STATES.map((k) => STATE_LABEL[k]), 'AI-triaged', 'Latest scan', 'Scan id', 'Link'],
    ...fusionProjectsFiltered().map((r) => [r.name, SCAN_TYPE_LABEL[r.scanType] ?? r.scanType, r.model, MODEL_FROM[r.modelFrom] ?? r.modelFrom, r.loc ?? '', r.files ?? '', r.total ?? 0, r.scanCredits ? r.scanCredits.credits : '', r.scanCredits ? (r.scanCredits.estimate ? 'yes' : 'no') : '', r.CRITICAL, r.HIGH, r.MEDIUM, r.LOW, r.total, r.NEW, r.RECURRENT, r.fixedKnown ? r.FIXED : '', ...FUSION_STATES.map((k) => r[k]), r.aiTriaged, r.scanAt ?? '', r.scanId, r.url])]);
});

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
$('fusion-report')?.addEventListener('click', () => downloadFusionReport());

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
        <span class="fusion-vuln-sub">${escapeHtml([SEVERITY_LABEL[r.severity] ?? r.severity, scannerLabel(r.scanner), r.status, r.state, r.language, r.source ? fileOf(r.source) : fileOf(r.location.split(' :: ')[0])].filter(Boolean).join(' · '))}</span></summary>
      ${r.description ? `<p class="fusion-vuln-desc" translate="no">${escapeHtml(r.description)}</p>` : ''}
      <dl>
        <dt>Severity</dt><dd>${escapeHtml(SEVERITY_LABEL[r.severity] ?? r.severity)}</dd>
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

$('gh-save').addEventListener('click', () => saveGithubSettings());
$('gh-clear-token').addEventListener('click', () => {
  if (confirm('Remove the stored GitHub token?')) saveGithubSettings({ token: null });
});

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

let identityReport = null;

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

// ---- Code authors ----------------------------------------------------------

let authorItems = [];

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

$('authors-all').addEventListener('change', () => {
  for (const box of document.querySelectorAll('[data-author-key]:not(:disabled)')) box.checked = $('authors-all').checked;
});

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
$('authors-preview').addEventListener('click', () => notifyAuthors(true));
$('authors-send').addEventListener('click', () => notifyAuthors(false));

// ---------------------------------------------------------------------------
// Audit: credit events, integrity, reconciliation, backups
// ---------------------------------------------------------------------------

const audit = { entries: [], next: 0, more: false, loaded: false, page: 0 };
const OUTCOME_BADGES = {
  charged: ['Charged', ''],
  'not-charged': ['Not charged', 'muted'],
  refused: ['Refused', 'warn'],
  failed: ['Failed', 'bad'],
  changed: ['Changed', 'muted'],
  info: ['Info', 'muted'],
};
const TYPE_LABELS = {
  triage: 'Triage',
  remediation: 'Remediation',
  allocation: 'Allocation',
  settings: 'Credit settings',
  report: 'Report issued',
  backup: 'Backup',
  audit: 'Audit check',
  access: 'Sign-in',
  iam: 'Access change',
};
const formatBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

function auditQuery(extra = {}) {
  const params = new URLSearchParams();
  const set = (key, value) => value && params.set(key, value);
  set('from', $('audit-from').value);
  set('to', $('audit-to').value);
  set('types', $('audit-type').value);
  set('outcomes', $('audit-outcome').value);
  set('project', $('audit-project').value.trim());
  set('q', $('audit-q').value.trim());
  for (const [key, value] of Object.entries(extra)) set(key, String(value));
  return params.toString();
}

function actorText(actor = {}) {
  if (actor.kind === 'report') {
    return [actor.recipient || 'report recipient', `emailed report${actor.reportVerified === false ? ' (unsigned)' : ''}`];
  }
  if (actor.kind === 'admin') return [actor.email || actor.user || actor.name || 'administrator', `admin${actor.tenant ? ` · ${actor.tenant}` : ''}`];
  if (actor.kind === 'user') return [actor.email || actor.user || 'unknown', [actor.role, actor.via].filter(Boolean).join(' · ') || 'signed-in user'];
  return [actor.user || actor.kind || 'system', actor.kind || ''];
}

function renderAuditTotals(totals) {
  const outcome = totals.byOutcome ?? {};
  const tiles = [
    ['Credits charged', totals.charged, 'accent'],
    ['Triage credits', totals.triageCharged, ''],
    ['Remediation credits', totals.remediationCharged, ''],
    ['Refused', outcome.refused ?? 0, outcome.refused ? 'warn' : ''],
    ['Failed', outcome.failed ?? 0, outcome.failed ? 'bad' : ''],
    ['Entries', totals.entries, ''],
  ];
  $('audit-totals').innerHTML = tiles
    .map(([label, value, cls]) => `<div><span class="value ${cls}">${Number(value ?? 0).toLocaleString()}</span><span class="label">${label}</span></div>`)
    .join('');
}

function auditDetail(e) {
  const [who, role] = actorText(e.actor);
  const facts = [
    ['Entry', `#${e.seq} · ${e.id}`],
    ['Time', `${formatTime(e.at)} (${e.at})`],
    ['Who', `${who} — ${role}`],
    e.actor?.ip && ['From', `${e.actor.ip}${e.actor.userAgent ? ` · ${e.actor.userAgent}` : ''}`, 'origin'],
    e.actor?.reportId && ['Report', e.actor.reportId],
    e.project && ['Project', `${e.project.name || ''} (${e.project.id})`],
    e.credits && ['Credits', `${e.credits.kind}: requested ${e.credits.requested ?? 0}, charged ${e.credits.charged ?? 0}`],
    e.balance?.before && ['Before', `allocated ${e.balance.before.allocated} · used ${e.balance.before.used} · remaining ${e.balance.before.remaining}`],
    e.balance?.after && ['After', `allocated ${e.balance.after.allocated} · used ${e.balance.after.used} · remaining ${e.balance.after.remaining}`],
    e.month && ['Month', `limit ${e.month.limit || 'none'} · remaining ${e.month.remaining ?? '—'}`],
    e.upstream && ['Checkmarx One', [e.upstream.call, e.upstream.status && `HTTP ${e.upstream.status}`, e.upstream.jobId && `job ${e.upstream.jobId}`, e.upstream.ms != null && `${e.upstream.ms} ms`, e.upstream.error].filter(Boolean).join(' · ')],
    e.findings?.length && ['Findings', `${e.findings.length}: ${e.findings.slice(0, 8).map((f) => f.riskId).join(', ')}${e.findings.length > 8 ? '…' : ''}`],
    ['Chain', `mac ${e.mac?.slice(0, 16)}… ← ${e.prev?.slice(0, 16)}…`],
  ].filter(Boolean);
  return `<div class="facts">${facts.map(([k, v, ctx]) => `<div><b${ctx ? ` data-i18n-ctx="${ctx}"` : ''}>${escapeHtml(k)}</b>${escapeHtml(v)}</div>`).join('')}</div>
    <details><summary class="hint">Full entry (JSON)</summary><pre>${escapeHtml(JSON.stringify(e, null, 2))}</pre></details>`;
}

const AUDIT_PAGE = 25;

/** What each heading of the audit log reads (sorting and the heading filters cover every entry loaded). */
const AUDIT_COLUMNS = [
  (e) => e.seq,
  { value: (e) => Date.parse(e.at) || null, text: (e) => formatTime(e.at) },
  (e) => `${TYPE_LABELS[e.type] ?? e.type} ${e.reason || ''}`,
  (e) => (OUTCOME_BADGES[e.outcome] ?? [e.outcome])[0],
  (e) => actorText(e.actor).join(' '),
  (e) => e.project?.name || e.project?.id || '',
  { value: (e) => e.credits?.charged ?? null, text: (e) => String(e.credits?.charged ?? '') },
  { value: (e) => (e.balance?.after?.remaining === undefined ? null : Number(e.balance.after.remaining)), text: (e) => String(e.balance?.after?.remaining ?? '') },
  null,
];
let auditShown = [];

function renderAuditRows() {
  auditShown = sortAndFilter('audit', audit.entries, AUDIT_COLUMNS, () => {
    audit.page = 0;
    renderAuditRows();
  });
  if (!auditShown.length) {
    $('audit-body').innerHTML = '<tr><td colspan="9" class="hint">No audit entries match these filters.</td></tr>';
  } else {
    const pages = Math.max(1, Math.ceil(auditShown.length / AUDIT_PAGE));
    audit.page = Math.min(audit.page ?? 0, pages - 1);
    const first = audit.page * AUDIT_PAGE;
    const indexOf = new Map(audit.entries.map((e, i) => [e, i]));
    $('audit-body').innerHTML = auditShown
      .slice(first, first + AUDIT_PAGE)
      .map((e) => {
        const i = indexOf.get(e);
        const [label, cls] = OUTCOME_BADGES[e.outcome] ?? [e.outcome, 'muted'];
        const [who, role] = actorText(e.actor);
        const charged = e.credits?.charged ? `<b>${e.credits.charged}</b>` : e.credits?.requested ? `<span class="muted">0 / ${e.credits.requested}</span>` : '';
        const remaining = e.balance?.after?.remaining ?? '';
        return `<tr data-audit="${i}">
          <td class="num muted c-seq">${e.seq}</td>
          <td class="when c-when">${escapeHtml(formatTime(e.at))}</td>
          <td class="c-event"><strong>${escapeHtml(TYPE_LABELS[e.type] ?? e.type)}</strong><span class="reason">${escapeHtml(e.reason || '')}</span></td>
          <td class="c-outcome"><span class="badge ${cls}">${escapeHtml(label)}</span></td>
          <td class="who c-who">${escapeHtml(who)}<small>${escapeHtml(role)}${e.actor?.ip ? ` · ${escapeHtml(e.actor.ip)}` : ''}</small></td>
          <td class="c-project">${escapeHtml(e.project?.name || e.project?.id || '')}</td>
          <td class="num c-credits">${charged}</td>
          <td class="num c-remaining">${remaining === '' ? '' : `<span class="m-label">left </span>${escapeHtml(remaining)}`}</td>
          <td class="c-open"><button type="button" class="link" data-audit-open="${i}" aria-expanded="false">Details</button></td>
        </tr>`;
      })
      .join('');
  }
  const pages = Math.max(1, Math.ceil(auditShown.length / AUDIT_PAGE));
  const first = (audit.page ?? 0) * AUDIT_PAGE;
  $('audit-more').hidden = true;
  $('audit-prev').disabled = !audit.page;
  $('audit-next').disabled = audit.page >= pages - 1 && !audit.more;
  $('audit-page').textContent = auditShown.length ? `Page ${audit.page + 1}${audit.more ? '' : ` of ${pages}`}` : '';
  $('audit-count').textContent = !auditShown.length
    ? ''
    : tableFiltered('audit')
      ? `${auditShown.length.toLocaleString()} of the ${audit.entries.length.toLocaleString()} entries loaded match the column filters`
      : `Entries ${(first + 1).toLocaleString()}–${Math.min(first + AUDIT_PAGE, auditShown.length).toLocaleString()}${audit.more ? ', newest first' : ` of ${auditShown.length.toLocaleString()}, newest first`}`;
}

$('audit-prev').addEventListener('click', () => {
  audit.page = Math.max(0, (audit.page ?? 0) - 1);
  renderAuditRows();
  $('audit-body').closest('.panel').scrollIntoView({ block: 'nearest' });
});
$('audit-next').addEventListener('click', async () => {
  const next = (audit.page ?? 0) + 1;
  if (next * AUDIT_PAGE >= auditShown.length && audit.more) await loadAudit({ append: true });
  audit.page = next;
  renderAuditRows();
  $('audit-body').closest('.panel').scrollIntoView({ block: 'nearest' });
});



async function loadAudit({ append = false } = {}) {
  setStatus('audit-status', append ? '' : 'Loading…');
  try {
    const result = await api(`/api/audit?${auditQuery({ limit: 100, ...(append ? { before: audit.next } : {}) })}`);
    audit.entries = append ? audit.entries.concat(result.entries) : result.entries;
    if (!append) audit.page = 0;
    audit.next = result.next;
    audit.more = result.more;
    renderAuditTotals(result.totals);
    renderAuditRows();
    if (result.writeError) setStatus('audit-status', `${result.writeError.entries} audit entr${result.writeError.entries === 1 ? 'y is' : 'ies are'} held in memory — the log folder cannot be written: ${result.writeError.error}`, 'error');
    else setStatus('audit-status', '');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('audit-status', error);
  }
}

$('audit-filters').addEventListener('submit', (event) => {
  event.preventDefault();
  loadAudit();
});
for (const id of ['audit-type', 'audit-outcome', 'audit-from', 'audit-to']) $(id).addEventListener('change', () => loadAudit());
$('audit-reset').addEventListener('click', () => {
  $('audit-filters').reset();
  loadAudit();
});
$('audit-more').addEventListener('click', () => loadAudit({ append: true }));
$('audit-body').addEventListener('click', (event) => {
  const button = event.target.closest('[data-audit-open]');
  if (!button) return;
  const row = button.closest('tr');
  const open = row.nextElementSibling?.classList.contains('detail');
  if (open) {
    row.nextElementSibling.remove();
    button.setAttribute('aria-expanded', 'false');
    return;
  }
  row.insertAdjacentHTML('afterend', `<tr class="detail"><td colspan="9">${auditDetail(audit.entries[Number(button.dataset.auditOpen)])}</td></tr>`);
  button.setAttribute('aria-expanded', 'true');
});

function downloadAudit(format) {
  const link = document.createElement('a');
  link.href = `/api/audit/export?${auditQuery({ format })}`;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}
$('audit-export-csv').addEventListener('click', () => downloadAudit('csv'));
$('audit-export-jsonl').addEventListener('click', () => downloadAudit('jsonl'));

// ---- Logs → User activity: what each person did (GET /api/activity) ---------------------------

const UA_PAGE = 50;
export const userActivity = { offset: 0, total: 0, loaded: false };
const UA_KINDS = { action: 'Action', page: 'Page', 'sign-in': 'Sign-in', event: 'Event' };

/** The filters as query parameters; a date's day runs from midnight to midnight in this browser's time. */
function userActivityQuery() {
  const params = new URLSearchParams();
  const set = (key, value) => value && params.set(key, value);
  set('user', $('ua-user').value);
  set('kind', $('ua-kind').value);
  set('q', $('ua-q').value.trim());
  if ($('ua-from').value) set('from', new Date(`${$('ua-from').value}T00:00:00`).toISOString());
  if ($('ua-to').value) set('to', new Date(`${$('ua-to').value}T23:59:59.999`).toISOString());
  return params;
}

function userActivityResult(e) {
  if (e.status == null) return '';
  if (e.status >= 400) return `<span class="badge bad">${escapeHtml(e.kind === 'sign-in' ? 'Refused' : 'Failed')}</span> <small class="muted" translate="no">HTTP ${e.status}</small>`;
  return `<span class="badge ok">Done</span>${e.ms != null ? ` <small class="muted" translate="no">${e.ms} ms</small>` : ''}`;
}

function renderUserActivity(result) {
  const select = $('ua-user');
  const chosen = select.value;
  select.innerHTML = `<option value="">Everyone</option>${result.people.map((p) => `<option value="${escapeHtml(p.email)}">${escapeHtml(p.name ? `${p.name} (${p.email})` : p.email)}</option>`).join('')}`;
  select.value = result.people.some((p) => p.email === chosen) ? chosen : '';
  userActivity.total = result.total;
  $('ua-body').innerHTML = result.entries.length
    ? result.entries
        .map((e) => {
          // The actions and items are kept as recorded (in English, as in the audit log); the labels around them are translated.
          const details = [e.target && `<span translate="no">${escapeHtml(e.target)}</span>`, e.fields?.length && `<span class="muted">Fields:</span> <span translate="no">${escapeHtml(e.fields.join(', '))}</span>`].filter(Boolean).join('<br />');
          return `<tr>
          <td class="when">${escapeHtml(formatTime(e.at))}</td>
          <td class="who"><span translate="no">${escapeHtml(e.name || e.user || '—')}</span><small><span translate="no">${escapeHtml(e.name ? e.user : '')}</span>${e.role ? `${e.name ? ' · ' : ''}${escapeHtml(e.role)}` : ''}</small></td>
          <td class="ua-action"><span class="badge muted">${escapeHtml(UA_KINDS[e.kind] ?? e.kind)}</span> <span translate="no">${escapeHtml(e.action)}</span></td>
          <td class="ua-details">${details}</td>
          <td>${userActivityResult(e)}</td>
          <td class="muted" translate="no">${escapeHtml(e.ip || '')}</td>
        </tr>`;
        })
        .join('')
    : '<tr><td colspan="6" class="hint">Nothing recorded matches these filters.</td></tr>';
  const first = userActivity.offset;
  $('ua-prev').disabled = first === 0;
  $('ua-next').disabled = first + UA_PAGE >= result.total;
  $('ua-count').textContent = result.total ? `Entries ${(first + 1).toLocaleString()}–${Math.min(first + UA_PAGE, result.total).toLocaleString()} of ${result.total.toLocaleString()}, newest first` : '';
}

export async function loadUserActivity({ offset = 0 } = {}) {
  if (!can('audit.view')) return;
  userActivity.offset = Math.max(0, offset);
  setStatus('ua-status', 'Loading…');
  try {
    const params = userActivityQuery();
    params.set('limit', UA_PAGE);
    params.set('offset', userActivity.offset);
    renderUserActivity(await api(`/api/activity?${params}`));
    userActivity.loaded = true;
    setStatus('ua-status', '');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('ua-status', error);
  }
}

$('ua-filters').addEventListener('submit', (event) => {
  event.preventDefault();
  loadUserActivity();
});
for (const id of ['ua-user', 'ua-kind', 'ua-from', 'ua-to']) $(id).addEventListener('change', () => loadUserActivity());
$('ua-reset').addEventListener('click', () => {
  $('ua-filters').reset();
  loadUserActivity();
});
$('ua-prev').addEventListener('click', () => loadUserActivity({ offset: userActivity.offset - UA_PAGE }));
$('ua-next').addEventListener('click', () => loadUserActivity({ offset: userActivity.offset + UA_PAGE }));
$('ua-export').addEventListener('click', () => {
  const link = document.createElement('a');
  link.href = '/api/activity/export';
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
});

/**
 * Which page and tab each person opens goes into the user activity log (the server adds who and when).
 * Fire and forget: a page never waits on it, and the same page twice in a row is sent once.
 */
export function reportVisit(name) {
  // A property, not a variable: route() may run before this part of the file has.
  if (!state.me || !name || name === reportVisit.last) return;
  reportVisit.last = name;
  reportActivity('page', name);
}
function reportActivity(kind, name) {
  const clean = String(name).replace(/[^\w .,:/#&()'’›→-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!clean) return;
  fetch('/api/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', keepalive: true, body: JSON.stringify({ kind, name: clean }) }).catch(() => {});
}
window.mzReportActivity = reportActivity;

$('audit-verify').addEventListener('click', async () => {
  const box = $('audit-verify-result');
  box.hidden = false;
  box.className = 'audit-result';
  box.textContent = 'Checking every entry…';
  try {
    const r = await api('/api/audit/verify');
    box.className = `audit-result ${r.ok ? 'ok' : 'bad'}`;
    box.innerHTML = r.ok
      ? `<strong>Intact.</strong> <span>${r.entries.toLocaleString()} entries${r.first ? `, ${escapeHtml(formatTime(r.first))} → ${escapeHtml(formatTime(r.last))}` : ''}: none edited, removed or reordered.</span>`
      : `<strong>${r.problems.length} problem(s) found in ${r.entries.toLocaleString()} entries.</strong>
         <ul>${r.problems.map((p) => `<li>${p.seq ? `Entry #${p.seq}: ` : `${escapeHtml(p.file ?? '')}: `}${escapeHtml(p.problem)}</li>`).join('')}</ul>
         <span class="hint">Restore the audit folder from a backup, or keep this result as evidence.</span>`;
    loadAudit();
  } catch (error) {
    box.className = 'audit-result bad';
    box.textContent = error.message;
  }
});

$('audit-reconcile').addEventListener('click', async () => {
  const box = $('audit-reconcile-result');
  box.hidden = false;
  box.className = 'audit-result';
  box.textContent = 'Comparing…';
  try {
    const r = await api(`/api/audit/reconcile?month=${encodeURIComponent($('audit-month').value)}`);
    box.className = `audit-result ${r.matched ? 'ok' : 'bad'}`;
    const rows = r.projects
      .map((p) => `<tr><td>${escapeHtml(p.projectName || p.projectId)}</td><td class="num">${p.ledger}</td><td class="num">${p.audited}</td><td class="num ${p.difference ? 'aged' : ''}">${p.difference}</td></tr>`)
      .join('');
    box.innerHTML = `<strong>${escapeHtml(r.month)}: ledger ${r.ledgerTotal} credits, audit log ${r.auditedTotal}. ${r.matched ? 'Everything is accounted for.' : 'Differences found.'}</strong>
      ${r.unlinked.entries ? `<span>${r.unlinked.entries} ledger entr${r.unlinked.entries === 1 ? 'y' : 'ies'} (${r.unlinked.credits} credits) have no audit link — ${escapeHtml(r.unlinked.note)}</span>` : ''}
      ${r.missing.length ? `<span>${r.missing.length} ledger entr${r.missing.length === 1 ? 'y points' : 'ies point'} to audit entries that are missing.</span>` : ''}
      ${rows ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Project</th><th class="num">Ledger</th><th class="num">Audit log</th><th class="num">Difference</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<span class="hint">No credits used this month.</span>'}`;
  } catch (error) {
    box.className = 'audit-result bad';
    box.textContent = error.message;
  }
});

async function loadBackupStatus() {
  try {
    const b = await api('/api/backup');
    const last = b.last
      ? b.last.ok
        ? `${formatTime(b.last.at)} — ${b.last.trigger}, ${b.last.files} files`
        : `${formatTime(b.last.at)} — failed: ${b.last.error}`
      : b.backups[0]
        ? formatTime(b.backups[0].at)
        : 'none yet';
    const facts = [
      ['State folder', `${b.dataDir}${b.insideProject ? ' — inside the project folder: set DATA_DIR' : ''}`, b.insideProject],
      ['Holds', `${b.files} files, ${formatBytes(b.bytes)}`],
      ['Backup folder', `${b.backupDir}${b.sameDisk ? ' — same disk as the state: set BACKUP_DIR to another disk or share' : ''}`, b.sameDisk],
      ['Schedule', b.intervalHours ? `every ${b.intervalHours} h, keeping ${b.keep}${b.encrypted ? ', encrypted' : ', not encrypted'}` : 'off (BACKUP_INTERVAL_HOURS=0)', !b.encrypted],
      ['Encryption', backupEncryptionText(b.encryption), !b.encryption.encrypted || b.encryption.notice === 'save-key'],
      ['Last backup', last, b.last && !b.last.ok],
      b.pendingRestore && ['Restore staged', 'applied when the server restarts', true],
      b.restoredAtStart && ['Restored at start', `backup of ${formatTime(b.restoredAtStart.createdAt)} (${b.restoredAtStart.files} files)`],
    ].filter(Boolean);
    $('backup-facts').innerHTML = facts.map(([k, v, warn]) => `<div><dt>${escapeHtml(k)}</dt><dd class="${warn ? 'warn' : ''}">${escapeHtml(v)}</dd></div>`).join('');
    $('backup-list-wrap').hidden = !b.backups.length;
    $('backup-list').innerHTML = b.backups.map((f) => `<tr><td class="code">${escapeHtml(f.name)}</td><td class="num">${formatBytes(f.size)}</td><td>${escapeHtml(formatTime(f.at))}</td></tr>`).join('');
    renderBackupKeyPanel(b.encryption);
    if (b.pendingRestore && $('restore-panel').hidden) {
      $('restore-panel').hidden = false;
      $('restore-panel').className = 'audit-result';
      $('restore-panel').innerHTML = '<span>A restore is staged and will be applied when the server restarts.</span><div><button type="button" id="restore-cancel" class="sm">Cancel the restore</button></div>';
    }
  } catch (error) {
    if (!handleAuthLoss(error)) showError('backup-status', error);
  }
}

// ---- Backup encryption and the server's backup key (Admins: backup.manage) ----

/** The "Encryption" line of the facts: what encrypts a backup made now. */
function backupEncryptionText(e) {
  if (e.source === 'passphrase') return 'on, with BACKUP_PASSPHRASE';
  if (e.source === 'key') {
    return e.keySaved
      ? `on, with this server's backup key (saved somewhere else: confirmed ${formatTime(e.keySavedAt)}${e.keySavedBy ? ` by ${e.keySavedBy}` : ''})`
      : 'on, with this server\'s backup key — nobody has confirmed saving the key somewhere else yet';
  }
  return e.optedOut ? 'off (BACKUP_ENCRYPTION=off is set on the server)' : 'off — each backup holds the keys and passwords in the clear';
}

/** The key while it is on screen (never kept anywhere else in the page). */
let backupKeyShown = null;

/** The Admins' block under the backup buttons: turn encryption on, see the key, copy or download it, confirm it is saved. */
function renderBackupKeyPanel(encryption) {
  const panel = $('backup-key-panel');
  panel.dataset.source = encryption.source;
  if (encryption.source !== 'key') backupKeyShown = null;
  // With BACKUP_PASSPHRASE the server's key is not used: there is nothing to do here.
  panel.hidden = encryption.source === 'passphrase';
  // (classList, not className: the permission class on the panel stays.)
  panel.classList.toggle('bad', Boolean(encryption.notice));
  if (encryption.source === 'none') {
    panel.innerHTML = encryption.optedOut
      ? '<strong>Backups are not encrypted.</strong><span>BACKUP_ENCRYPTION=off is set on the server. Each backup holds the Checkmarx One key, the mail password and the signing keys in the clear. To encrypt them, remove that setting and restart the server.</span>'
      : `<strong>Backups are not encrypted.</strong>
        <span>Each backup holds the Checkmarx One key, the mail password and the signing keys in the clear. Turn encryption on and the server makes a backup key, shows it to you, and encrypts every backup from then on. Backups made before stay as they are.</span>
        <div><button type="button" id="backup-encrypt-on" class="sm">Turn on backup encryption</button></div>`;
    return;
  }
  const saved = encryption.keySaved
    ? `<span class="hint">Saved somewhere else: confirmed ${escapeHtml(formatTime(encryption.keySavedAt))}${encryption.keySavedBy ? ` by ${escapeHtml(encryption.keySavedBy)}` : ''}.</span>`
    : '<span><b>Nobody has confirmed saving this key yet.</b> Show it, keep a copy somewhere other than this server (a password manager, a safe), then confirm.</span>';
  const shown = backupKeyShown
    ? `<code class="code" id="backup-key-value">${escapeHtml(backupKeyShown.key)}</code>
       <div><button type="button" id="backup-key-copy" class="sm">Copy</button> <button type="button" id="backup-key-download" class="sm">Download as a text file</button> <button type="button" id="backup-key-hide" class="sm ghost">Hide</button></div>`
    : '<div><button type="button" id="backup-key-show" class="sm">Show backup key</button></div>';
  panel.innerHTML = `<strong>Backup key</strong>
    <span>Every backup is encrypted with this server's backup key. Keep the key somewhere other than this server: if the server is lost, a backup opens only with it. To restore on another server, give the key when the restore asks, or set BACKUP_PASSPHRASE to it. The key is never emailed and is not inside a backup.</span>
    ${shown}
    ${saved}
    ${backupKeyShown && !encryption.keySaved ? '<div><button type="button" id="backup-key-confirm" class="sm">I have saved it</button></div>' : ''}`;
}

/** The Admins' notice at the top of every page, until they act. */
export function renderBackupBanner(notice) {
  const banner = $('backup-banner');
  if (!banner) return;
  banner.hidden = !notice;
  if (!notice) return;
  banner.innerHTML = notice === 'save-key'
    ? 'Backups are encrypted with this server\'s backup key, and nobody has confirmed saving the key somewhere else yet. If this server is lost, its backups open only with that key. <a href="#/audit/backups">Save the backup key</a>'
    : 'Backups of this server are not encrypted: each one holds the Checkmarx One key, the mail password and the signing keys in the clear. <a href="#/audit/backups">Turn on backup encryption</a>';
}

// Signed out (the sign-in panel shows): the notice goes away with the workspace it is about.
new MutationObserver(() => {
  if (!$('connect-panel').hidden) renderBackupBanner(null);
}).observe($('connect-panel'), { attributes: true, attributeFilter: ['hidden'] });

/** After a change to backup encryption: the panel, the facts and the notice follow. */
function backupEncryptionChanged(encryption) {
  if (state.me) state.me = { ...state.me, backupNotice: encryption.notice };
  renderBackupBanner(encryption.notice);
  loadBackupStatus();
}

async function showBackupKey() {
  backupKeyShown = await api('/api/backup/key/show', { method: 'POST' });
}

$('backup-key-panel').addEventListener('click', async (event) => {
  const id = event.target.id;
  if (!id) return;
  try {
    if (id === 'backup-encrypt-on') {
      if (!confirm('Turn on backup encryption? The server makes a backup key and encrypts every backup from now on. You will be shown the key: keep it somewhere other than this server, because a backup opens only with it.')) return;
      const { encryption } = await api('/api/backup/encryption', { method: 'POST', body: JSON.stringify({ on: true }) });
      await showBackupKey();
      backupEncryptionChanged(encryption);
    } else if (id === 'backup-key-show') {
      await showBackupKey();
      loadBackupStatus();
    } else if (id === 'backup-key-hide') {
      backupKeyShown = null;
      loadBackupStatus();
    } else if (id === 'backup-key-copy') {
      try {
        await navigator.clipboard.writeText(backupKeyShown.key);
        toast('Backup key copied.');
      } catch {
        toast('Select the key and copy it.');
      }
    } else if (id === 'backup-key-download') {
      const text = [
        'CxMissionZero backup key',
        '',
        backupKeyShown.key,
        '',
        `Server: ${backupKeyShown.host}`,
        `Saved from the Audit page: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
        '',
        'Keep this file somewhere other than the server. Anyone who has it and a backup can read everything in the backup.',
        'To restore a backup on another server: give this key when the restore asks for it, or set BACKUP_PASSPHRASE to it.',
        '',
      ].join('\r\n');
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      link.download = 'cxmissionzero-backup-key.txt';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } else if (id === 'backup-key-confirm') {
      if (!confirm('Have you saved the backup key somewhere other than this server? Without it, a backup cannot be opened if this server is lost.')) return;
      const { encryption } = await api('/api/backup/key/confirm', { method: 'POST' });
      backupKeyShown = null;
      backupEncryptionChanged(encryption);
    }
  } catch (error) {
    if (!handleAuthLoss(error)) showError('backup-status', error);
  }
});

$('backup-download').addEventListener('click', () => {
  const link = document.createElement('a');
  link.href = '/api/backup/download';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(loadBackupStatus, 1500);
});

$('backup-now').addEventListener('click', async () => {
  setStatus('backup-status', 'Backing up…');
  try {
    const r = await api('/api/backup/now', { method: 'POST' });
    setStatus('backup-status', `Written: ${r.file}`, 'ok');
    loadBackupStatus();
  } catch (error) {
    showError('backup-status', error);
  }
});

let restoreUpload = null;
async function sendRestore(check) {
  const headers = { 'Content-Type': 'application/octet-stream' };
  if (restoreUpload.passphrase) headers['X-Backup-Passphrase'] = restoreUpload.passphrase;
  const response = await fetch(`/api/backup/restore${check ? '?check=1' : ''}`, { method: 'POST', credentials: 'same-origin', headers, body: restoreUpload.file });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
  return payload;
}

$('restore-file').addEventListener('change', async () => {
  const file = $('restore-file').files[0];
  $('restore-file').value = '';
  if (!file) return;
  restoreUpload = { file, passphrase: '' };
  const panel = $('restore-panel');
  panel.hidden = false;
  panel.className = 'audit-result';
  panel.textContent = `Checking ${file.name}…`;
  let result;
  for (;;) {
    try {
      result = await sendRestore(true);
      break;
    } catch (error) {
      if (/encrypted|passphrase/i.test(error.message)) {
        const passphrase = prompt(`${error.message}\n\nBackup key or passphrase:`);
        if (passphrase) {
          restoreUpload.passphrase = passphrase;
          continue;
        }
      }
      panel.className = 'audit-result bad';
      panel.textContent = error.message;
      return;
    }
  }
  const b = result.backup;
  panel.innerHTML = `<strong>${escapeHtml(file.name)}: checksum OK.</strong>
    <span>Made ${escapeHtml(formatTime(b.createdAt))} on ${escapeHtml(b.host)} — ${b.files} files, ${formatBytes(b.bytes)}. Settings ${b.hasSettings ? '✓' : '✗'} · credit ledger ${b.hasLedger ? '✓' : '✗'} · allocations ${b.hasAllocations ? '✓' : '✗'} · audit months: ${escapeHtml(b.auditMonths.join(', ') || 'none')}.</span>
    <span class="hint">Restoring replaces everything in the state folder when the server next restarts; the current files are kept in a replaced-… folder beside it.</span>
    <div><button type="button" id="restore-confirm" class="primary sm">Restore at next restart</button> <button type="button" id="restore-dismiss" class="sm ghost">Cancel</button></div>`;
});

$('restore-panel').addEventListener('click', async (event) => {
  const panel = $('restore-panel');
  if (event.target.id === 'restore-dismiss') {
    panel.hidden = true;
    restoreUpload = null;
  } else if (event.target.id === 'restore-confirm') {
    if (!confirm('Replace all settings, credit balances, tracked reports and the audit log with this backup at the next restart?')) return;
    try {
      await sendRestore(false);
      panel.className = 'audit-result ok';
      panel.innerHTML = '<strong>Restore staged.</strong><span>Restart the server to apply it. Until then nothing changes.</span><div><button type="button" id="restore-cancel" class="sm">Cancel the restore</button></div>';
      restoreUpload = null;
      loadBackupStatus();
    } catch (error) {
      panel.className = 'audit-result bad';
      panel.textContent = error.message;
    }
  } else if (event.target.id === 'restore-cancel') {
    await api('/api/backup/restore', { method: 'DELETE' });
    panel.hidden = true;
    loadBackupStatus();
  }
});

export function renderAudit() {
  if (!$('audit-month').value) $('audit-month').value = new Date().toISOString().slice(0, 7);
  loadAudit();
  loadBackupStatus();
}

wireServerConnections();

// ---------------------------------------------------------------------------
// Access: people, roles and the permission matrix
// ---------------------------------------------------------------------------

export const access = { data: null, edits: new Map() };

export async function loadAccess() {
  setStatus('iam-status', '');
  try {
    access.data = await api('/api/iam');
    access.edits.clear();
    renderAccess();
  } catch (error) {
    if (!handleAuthLoss(error)) showError('iam-status', error);
  }
}

function roleName(id) {
  return access.data?.roles.find((r) => r.id === id)?.name ?? id;
}

/** What each heading of the people table reads (sorting and the heading filters cover everyone, not one page). */
const IAM_COLUMNS = [
  (u) => `${u.name || ''} ${u.email}`.trim(),
  (u) => roleName(u.role),
  (u) => [u.hasPassword ? (u.twoStep ? 'Password and two-step code' : 'Password') : '', 'Checkmarx One', ...(u.cxoneIdentities ?? [])].filter(Boolean).join(' '),
  (u) => (u.disabled ? 'Disabled' : u.locked ? 'Locked' : u.mustChangePassword ? 'Must set password' : 'Active'),
  { value: (u) => Date.parse(u.lastLoginAt) || null, text: (u) => (u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '') },
  null,
];

/** People & roles → Sign-in: who may reset a forgotten password by email, and what is missing for it to work. */
function renderSignInPolicy() {
  const policy = access.data?.signIn;
  if (!policy) return;
  $('iam-reset-policy').value = policy.policy;
  $('iam-reset-policy').disabled = !policy.canChange;
  if (!policy.canChange) setStatus('iam-reset-status', 'Sign-in rules are for the whole server: a Super Admin changes them.');
  const missing = (policy.missing ?? []).filter((m) => m !== 'Turned off.');
  $('iam-reset-missing').hidden = !missing.length || policy.policy === 'off';
  $('iam-reset-missing').innerHTML = missing.length
    ? `<li class="hint">"Forgot your password?" is not shown yet:</li>${missing.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}`
    : '';
  renderSignInSecurity();
}

/** People & roles → Sign-in, for Admins: two-step sign-in for everyone. */
function renderSignInSecurity() {
  const security = access.data?.signIn?.security;
  $('iam-twostep-panel').hidden = !security;
  $('iam-sso-panel').hidden = !security;
  if (!security) return;
  $('iam-twostep-required').checked = security.twoStepRequired;
  renderSsoSettings(security);
}

// ---- People & roles → Sign-in → Single sign-on (Admins) ----

/** What the form was last filled from, so that typing is not overwritten each time the page is drawn again. */
let ssoFilledFrom = '';

function renderSsoSettings(security) {
  const { sso } = security;
  $('sso-redirect').value = security.redirectUri || '';
  $('sso-redirect').placeholder = 'Set this server\'s address first (Settings → Server address)';
  $('sso-secret-state').textContent = sso.clientSecretSet ? '(stored)' : '(not set)';
  $('sso-secret-remove').hidden = !sso.clientSecretSet;
  const missing = sso.enabled ? security.missing ?? [] : [];
  $('sso-missing').hidden = !missing.length;
  $('sso-missing').innerHTML = missing.length ? `<li class="hint">The button is not shown on the sign-in page yet:</li>${missing.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}` : '';
  const from = JSON.stringify([sso, security.roles]);
  if (from === ssoFilledFrom) return;
  ssoFilledFrom = from;
  $('sso-enabled').checked = sso.enabled;
  $('sso-issuer').value = sso.issuer;
  $('sso-label').value = sso.label;
  $('sso-client-id').value = sso.clientId;
  $('sso-client-secret').value = '';
  $('sso-domains').value = (sso.domains ?? []).join(', ');
  $('sso-provision').value = sso.provision;
  $('sso-role').innerHTML = (security.roles ?? []).map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}</option>`).join('');
  $('sso-role').value = (security.roles ?? []).some((r) => r.id === sso.role) ? sso.role : 'user';
  $('sso-verified').checked = sso.requireVerifiedEmail;
  $('sso-password-admins').checked = sso.passwordAdminsOnly;
  syncSsoForm();
}

/** The role is chosen only when people are added; passwords can be kept for Admins only while single sign-on is on. */
function syncSsoForm() {
  $('sso-role-field').hidden = $('sso-provision').value !== 'create';
  $('sso-password-admins').disabled = !$('sso-enabled').checked;
  if (!$('sso-enabled').checked) $('sso-password-admins').checked = false;
}

async function saveSso(sso, done) {
  setStatus('sso-admin-status', 'Saving…');
  try {
    access.data = await api('/api/iam/sign-in', { method: 'PUT', body: JSON.stringify({ sso }) });
    ssoFilledFrom = '';
    renderAccess();
    setStatus('sso-admin-status', done, 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('sso-admin-status', error);
  }
}

{
  $('sso-provision').addEventListener('change', syncSsoForm);
  $('sso-enabled').addEventListener('change', syncSsoForm);
  $('iam-sso-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const secret = $('sso-client-secret').value;
    saveSso(
      {
        enabled: $('sso-enabled').checked,
        issuer: $('sso-issuer').value.trim(),
        label: $('sso-label').value.trim(),
        clientId: $('sso-client-id').value.trim(),
        // Left empty, the stored secret is kept.
        ...(secret ? { clientSecret: secret } : {}),
        domains: $('sso-domains').value,
        provision: $('sso-provision').value,
        role: $('sso-role').value,
        requireVerifiedEmail: $('sso-verified').checked,
        passwordAdminsOnly: $('sso-password-admins').checked,
      },
      'Saved.',
    );
  });
  $('sso-secret-remove').addEventListener('click', () => {
    if (!confirm('Remove the stored client secret? Single sign-on stops working until a new one is saved, unless the identity provider needs none.')) return;
    saveSso({ clientSecret: null }, 'The client secret was removed.');
  });
  $('sso-check').addEventListener('click', async () => {
    setStatus('sso-admin-status', 'Checking the identity provider as saved…');
    try {
      const result = await api('/api/iam/sign-in/sso/check', { method: 'POST' });
      setStatus('sso-admin-status', result.message, result.ok ? 'ok' : 'error');
    } catch (error) {
      if (!handleAuthLoss(error)) showError('sso-admin-status', error);
    }
  });
  copyButton($('sso-redirect-copy'), $('sso-admin-status'), () => $('sso-redirect').value);
}

$('iam-twostep-required').addEventListener('change', async () => {
  const on = $('iam-twostep-required').checked;
  if (on && !confirm('Require two-step sign-in for everyone who signs in with a password? Each person without it sets it up at their next sign-in, you included.')) {
    $('iam-twostep-required').checked = false;
    return;
  }
  setStatus('iam-twostep-status', 'Saving…');
  try {
    access.data = await api('/api/iam/sign-in', { method: 'PUT', body: JSON.stringify({ twoStepRequired: on }) });
    renderAccess();
    setStatus('iam-twostep-status', 'Saved.', 'ok');
    if (state.me?.twoStep) state.me = { ...state.me, twoStep: { ...state.me.twoStep, required: on } };
  } catch (error) {
    if (!handleAuthLoss(error)) showError('iam-twostep-status', error);
    renderSignInSecurity();
  }
});

$('iam-reset-policy').addEventListener('change', async () => {
  setStatus('iam-reset-status', 'Saving…');
  try {
    const ready = await api('/api/iam/policy', { method: 'PUT', body: JSON.stringify({ passwordReset: $('iam-reset-policy').value }) });
    access.data.signIn = { ...access.data.signIn, ...ready };
    renderSignInPolicy();
    setStatus('iam-reset-status', 'Saved.', 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('iam-reset-status', error);
    if (access.data?.signIn) $('iam-reset-policy').value = access.data.signIn.policy;
  }
});

function renderAccess() {
  renderSignInPolicy();
  const { users, roles } = access.data;
  const assignable = roles.filter((r) => r.canAssign);
  $('iam-add-role').innerHTML = assignable.map((r) => `<option value="${escapeHtml(r.id)}" ${r.id === 'user' ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('');

  const roleFilter = $('iam-role-filter');
  const chosenRole = roleFilter.value;
  roleFilter.innerHTML = `<option value="">All roles</option>${roles.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}</option>`).join('')}`;
  roleFilter.value = roles.some((r) => r.id === chosenRole) ? chosenRole : '';
  $('iam-people-count').textContent = String(users.length);
  $('iam-roles-count').textContent = String(roles.length);
  const shown = sortAndFilter('iam-people', users.filter(iamUserMatches), IAM_COLUMNS, () => {
    access.page = 0;
    renderAccess();
  });
  const pages = Math.max(1, Math.ceil(shown.length / IAM_PAGE));
  access.page = Math.min(access.page ?? 0, pages - 1);
  const first = access.page * IAM_PAGE;
  $('iam-count').textContent = shown.length === users.length ? `${users.length} ${users.length === 1 ? 'person' : 'people'}` : `${shown.length} of ${users.length} people`;
  $('iam-pager').hidden = pages < 2;
  $('iam-page-info').textContent = `${first + 1}–${Math.min(first + IAM_PAGE, shown.length)} of ${shown.length}`;
  $('iam-prev').disabled = access.page === 0;
  $('iam-next').disabled = access.page >= pages - 1;
  if (!shown.length) {
    $('iam-users').innerHTML = '<tr><td colspan="6" class="hint">Nobody matches these filters.</td></tr>';
    renderMatrix();
    return;
  }
  $('iam-users').innerHTML = shown
    .slice(first, first + IAM_PAGE)
    .map((u) => {
      const me = u.id === state.me.user.id;
      const status = u.disabled ? '<span class="badge bad">Disabled</span>' : u.locked ? '<span class="badge warn">Locked</span>' : u.mustChangePassword ? '<span class="badge muted">Must set password</span>' : '<span class="badge">Active</span>';
      const methods = [u.hasPassword ? (u.twoStep ? 'Password and two-step code' : 'Password') : '', `Checkmarx One: ${[u.email, ...u.cxoneIdentities].map(escapeHtml).join(', ')}`].filter(Boolean).join('<br>');
      const roleCell = u.canManage
        ? `<select data-iam-role="${u.id}" aria-label="Role of ${escapeHtml(u.email)}">${roles
            .filter((r) => r.canAssign || r.id === u.role)
            .map((r) => `<option value="${escapeHtml(r.id)}" ${r.id === u.role ? 'selected' : ''} ${r.canAssign ? '' : 'disabled'}>${escapeHtml(r.name)}</option>`)
            .join('')}</select>`
        : `<span class="role-pill role-${escapeHtml(u.role)}">${escapeHtml(roleName(u.role))}</span>`;
      const actions = u.canManage
        ? `<button type="button" class="link" data-iam-profile="${u.id}">Edit profile</button>
           <button type="button" class="link" data-iam-reset="${u.id}">Set password</button>
           ${u.twoStep ? `<button type="button" class="link" data-iam-twostep="${u.id}">Reset two-step</button>` : ''}
           ${u.ssoLinked ? ssoLinkButton(u) : ''}
           <button type="button" class="link" data-iam-ids="${u.id}">Identities</button>
           <button type="button" class="link" data-iam-toggle="${u.id}">${u.disabled ? 'Enable' : 'Disable'}</button>
           <button type="button" class="link danger" data-iam-delete="${u.id}">Remove</button>`
        : me ? `<span class="hint">You</span>${u.ssoLinked && can('iam.manage') ? ` ${ssoLinkButton(u)}` : ''}` : '';
      // Several tenants: where each person works, chosen by a Super Admin.
      const tenants = access.data.tenants;
      const theirs = u.tenants?.length ? u.tenants : ['default'];
      const tenantLine = tenants ? `<small class="muted block" translate="no">${escapeHtml(tenants.filter((t) => theirs.includes(t.id)).map((t) => t.name).join(', '))}</small>` : '';
      const tenantPick = tenants && u.canManage
        ? `<details class="tn-pick"><summary class="link">Tenants</summary><div class="tn-pop">${tenants
            .map((t) => `<label class="check"><input type="checkbox" value="${escapeHtml(t.id)}" ${theirs.includes(t.id) ? 'checked' : ''} /> <span translate="no">${escapeHtml(t.name)}</span></label>`)
            .join('')}<button type="button" class="sm primary" data-iam-tenants="${u.id}">Save</button></div></details>`
        : '';
      return `<tr>
        <td><strong>${escapeHtml(u.name || u.email)}</strong>${u.name ? `<small class="muted block">${escapeHtml(u.email)}</small>` : ''}${tenantLine}</td>
        <td>${roleCell}</td>
        <td class="small-text">${methods}</td>
        <td>${status}</td>
        <td class="when">${u.lastLoginAt ? escapeHtml(formatTime(u.lastLoginAt)) : '<span class="hint">never</span>'}</td>
        <td><div class="row-actions">${actions}${tenantPick}${consolidatedTick(u, me)}</div></td>
      </tr>`;
    })
    .join('');
  renderMatrix();
}

const IAM_PAGE = 20;

/** For a person linked to their account at the identity provider by a single sign-on: take the link off (the account there was made anew). */
const ssoLinkButton = (u) => `<button type="button" class="link" data-iam-ssolink="${u.id}">Reset single sign-on link</button>`;

/**
 * Labs → Consolidated view: the Admin's tick, one person at a time (never through a role). Shown once its activation
 * code is applied; others see who has it.
 */
function consolidatedTick(u, me) {
  if (access.data.consolidatedGrant && (u.canManage || me)) {
    return `<label class="check cv-grant" title="Labs → Consolidated view: every tenant they work in, read only. Each visit is written to each tenant's audit log. Their role also needs See Labs and Labs: Consolidated view."><input type="checkbox" data-iam-consolidated="${escapeHtml(u.id)}" ${u.consolidated ? 'checked' : ''} /> <span>May see the consolidated view (all connected tenants)</span></label>`;
  }
  return u.consolidated ? '<span class="badge gv-info" title="May see the consolidated view (all connected tenants)">Consolidated view</span>' : '';
}

$('iam-users').addEventListener('change', (event) => {
  const box = event.target.closest('[data-iam-consolidated]');
  if (!box) return;
  const user = access.data.users.find((u) => u.id === box.dataset.iamConsolidated);
  if (!user) return;
  iamCall(`/api/iam/users/${encodeURIComponent(user.id)}/consolidated`, { method: 'PUT', body: JSON.stringify({ on: box.checked }) }, box.checked ? `${user.email} may now see the consolidated view.` : `${user.email} may no longer see the consolidated view.`);
});

function iamUserMatches(u) {
  const q = $('iam-search').value.trim().toLowerCase();
  const role = $('iam-role-filter').value;
  const status = $('iam-status-filter').value;
  if (role && u.role !== role) return false;
  if (status) {
    const current = u.disabled ? 'disabled' : u.locked ? 'locked' : u.mustChangePassword ? 'pending' : 'active';
    if (current !== status) return false;
  }
  if (!q) return true;
  return [u.name, u.email, ...(u.cxoneIdentities ?? [])].some((v) => String(v ?? '').toLowerCase().includes(q));
}

for (const id of ['iam-search', 'iam-role-filter', 'iam-status-filter']) {
  $(id).addEventListener(id === 'iam-search' ? 'input' : 'change', () => {
    access.page = 0;
    if (access.data) renderAccess();
  });
}
$('iam-prev').addEventListener('click', () => {
  access.page = Math.max(0, (access.page ?? 0) - 1);
  renderAccess();
});
$('iam-next').addEventListener('click', () => {
  access.page = (access.page ?? 0) + 1;
  renderAccess();
});

/** Permission groups folded away in the matrix (this browser session). */
const collapsedGroups = new Set();

/** "Show only the differences": the roles being compared (two or more; none chosen = every role). */
const roleCompare = { on: false, roles: new Set() };

function comparedRoles(roles) {
  const chosen = roles.filter((r) => roleCompare.roles.has(r.id));
  return chosen.length >= 2 ? chosen : roles;
}

/** Permissions down the side, roles across the top; tick to change what a role may do. */
function renderMatrix() {
  const { permissions, me } = access.data;
  const mine = new Set(me.permissions);
  const roles = roleCompare.on ? comparedRoles(access.data.roles) : access.data.roles;
  const groups = [...new Set(permissions.map((p) => p.group))];
  const valueOf = (role, pid) => (access.edits.get(role.id) ?? new Set(role.permissions)).has(pid);
  const differs = (p) => new Set(roles.map((r) => valueOf(r, p.id))).size > 1;
  const roleActions = (r) =>
    [
      r.canManage ? `<button type="button" class="link" data-iam-role-rename="${escapeHtml(r.id)}">Rename</button>` : '',
      access.data.rolesChangeable ? `<button type="button" class="link" data-iam-role-copy="${escapeHtml(r.id)}">Duplicate</button>` : '',
      r.canManage && !r.builtin ? `<button type="button" class="link danger" data-iam-role-delete="${escapeHtml(r.id)}">Remove</button>` : '',
    ].filter(Boolean);
  const head = `<thead><tr><th>Permission</th>${roles
    .map((r) => {
      const actions = roleActions(r);
      return `<th class="role-col" title="${escapeHtml(r.description || '')}"><span class="role-pill role-${escapeHtml(r.id)}">${escapeHtml(r.name)}</span><small>${r.users} ${r.users === 1 ? 'person' : 'people'}${r.locked ? ' · fixed' : ''}</small>${
        actions.length ? `<span class="role-actions">${actions.join('')}</span>` : ''
      }</th>`;
    })
    .join('')}</tr></thead>`;
  let differing = 0;
  const body = groups
    .map((group) => {
      const q = $('iam-perm-search').value.trim().toLowerCase();
      const inGroup = permissions.filter((p) => p.group === group && (!q || `${p.label} ${p.description} ${p.id}`.toLowerCase().includes(q)) && (!roleCompare.on || differs(p)));
      if (!inGroup.length) return '';
      differing += inGroup.length;
      const folded = collapsedGroups.has(group) && !q && !roleCompare.on;
      const granted = roles.map((r) => inGroup.filter((p) => valueOf(r, p.id)).length);
      const rows = folded ? '' : inGroup
        .map((p) => `<tr${roleCompare.on ? ' class="differs"' : ''}><td><span class="perm-label">${escapeHtml(p.label)}${p.adminOnly ? ' <span class="badge warn">Admin role only</span>' : p.special ? ' <span class="badge warn">Admin</span>' : ''}</span><small class="perm-desc">${escapeHtml(p.description)}</small></td>${roles
          .map((r) => {
            // An Admin-role-only permission (deleting reports) is never given to another role.
            const editable = r.canManage && mine.has(p.id) && !p.adminOnly;
            const checked = valueOf(r, p.id);
            return `<td class="cell${roleCompare.on ? (checked ? ' has' : ' lacks') : ''}"><input type="checkbox" data-matrix-role="${escapeHtml(r.id)}" data-matrix-perm="${escapeHtml(p.id)}" ${checked ? 'checked' : ''} ${editable ? '' : 'disabled'} aria-label="${escapeHtml(r.name)}: ${escapeHtml(p.label)}" /></td>`;
          })
          .join('')}</tr>`)
        .join('');
      return `<tbody><tr class="group-row${folded ? ' folded' : ''}"><th><button type="button" class="group-toggle" data-iam-group="${escapeHtml(group)}" aria-expanded="${!folded}">${escapeHtml(group)} <span class="muted">${inGroup.length}</span></button></th>${granted
        .map((n) => `<td class="cell group-sum"><span class="muted">${n}/${inGroup.length}</span></td>`)
        .join('')}</tr>${rows}</tbody>`;
    })
    .join('');
  const empty = roleCompare.on && !$('iam-perm-search').value.trim() ? 'These roles hold the same permissions.' : 'No permission matches.';
  $('iam-matrix').innerHTML = head + (body || `<tbody><tr><td colspan="${roles.length + 1}" class="hint">${empty}</td></tr></tbody>`);
  $('iam-groups-toggle').textContent = collapsedGroups.size >= groups.length ? 'Expand all' : 'Collapse all';
  $('iam-groups-toggle').disabled = roleCompare.on;
  $('iam-matrix-actions').hidden = access.edits.size === 0;
  renderRoleCompare(roles, differing);
}

/** The roles to compare, as tick boxes, and how many permissions differ between them. */
function renderRoleCompare(shown, differing) {
  $('iam-diff').checked = roleCompare.on;
  $('iam-compare').hidden = !roleCompare.on;
  if (!roleCompare.on) return;
  const ids = new Set(shown.map((r) => r.id));
  $('iam-compare-roles').innerHTML = access.data.roles
    .map((r) => `<label class="check"><input type="checkbox" data-iam-compare="${escapeHtml(r.id)}" ${roleCompare.roles.has(r.id) || (ids.has(r.id) && roleCompare.roles.size < 2) ? 'checked' : ''} /> <span class="role-pill role-${escapeHtml(r.id)}">${escapeHtml(r.name)}</span></label>`)
    .join('');
  $('iam-compare-note').textContent = differing === 1 ? '1 permission differs.' : `${differing} permissions differ.`;
}

$('iam-diff').addEventListener('change', () => {
  roleCompare.on = $('iam-diff').checked;
  if (access.data) renderMatrix();
});
$('iam-compare-roles').addEventListener('change', (event) => {
  const box = event.target.closest('[data-iam-compare]');
  if (!box) return;
  // Starting from "every role": the first untick keeps the others.
  if (roleCompare.roles.size < 2) roleCompare.roles = new Set(comparedRoles(access.data.roles).map((r) => r.id));
  if (box.checked) roleCompare.roles.add(box.dataset.iamCompare);
  else roleCompare.roles.delete(box.dataset.iamCompare);
  if (roleCompare.roles.size < 2) {
    box.checked = true;
    roleCompare.roles.add(box.dataset.iamCompare);
    return setStatus('iam-matrix-status', 'Compare at least two roles.', 'error');
  }
  setStatus('iam-matrix-status', '');
  renderMatrix();
});

$('iam-matrix').addEventListener('click', (event) => {
  const toggle = event.target.closest('[data-iam-group]');
  if (!toggle) return;
  const group = toggle.dataset.iamGroup;
  if (collapsedGroups.has(group)) collapsedGroups.delete(group);
  else collapsedGroups.add(group);
  renderMatrix();
});
$('iam-perm-search').addEventListener('input', () => access.data && renderMatrix());
$('iam-groups-toggle').addEventListener('click', () => {
  const groups = [...new Set(access.data?.permissions.map((p) => p.group) ?? [])];
  if (collapsedGroups.size >= groups.length) collapsedGroups.clear();
  else for (const g of groups) collapsedGroups.add(g);
  renderMatrix();
});

$('iam-matrix').addEventListener('change', (event) => {
  const box = event.target.closest('[data-matrix-role]');
  if (!box) return;
  const role = access.data.roles.find((r) => r.id === box.dataset.matrixRole);
  const set = access.edits.get(role.id) ?? new Set(role.permissions);
  if (box.checked) set.add(box.dataset.matrixPerm);
  else set.delete(box.dataset.matrixPerm);
  const unchanged = set.size === role.permissions.length && role.permissions.every((p) => set.has(p));
  if (unchanged) access.edits.delete(role.id);
  else access.edits.set(role.id, set);
  $('iam-matrix-actions').hidden = access.edits.size === 0;
  setStatus('iam-matrix-status', access.edits.size ? `Unsaved changes to ${[...access.edits.keys()].map(roleName).join(', ')}.` : '');
});

$('iam-matrix-cancel').addEventListener('click', () => {
  access.edits.clear();
  renderMatrix();
  setStatus('iam-matrix-status', '');
});

$('iam-matrix-save').addEventListener('click', async () => {
  try {
    for (const [id, set] of access.edits) {
      const role = access.data.roles.find((r) => r.id === id);
      access.data = await api(`/api/iam/roles/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ name: role.name, description: role.description, permissions: [...set] }) });
    }
    access.edits.clear();
    renderAccess();
    setStatus('iam-matrix-status', 'Saved — it applies at once to everyone with these roles.', 'ok');
    refreshMe();
  } catch (error) {
    if (!handleAuthLoss(error)) showError('iam-matrix-status', error);
  }
});

/** My own permissions may have changed (e.g. I edited my role). */
async function refreshMe() {
  try {
    state.me = await api('/api/me');
    applyPermissions();
  } catch {}
}

$('iam-add-toggle').addEventListener('click', () => {
  $('iam-add-form').hidden = !$('iam-add-form').hidden;
  if (!$('iam-add-form').hidden) $('iam-add-email').focus();
});

function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('').replace(/(.{4})(?!$)/g, '$1-');
}
$('iam-generate').addEventListener('click', () => {
  $('iam-add-password').value = generatePassword();
});

$('iam-add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    access.data = await api('/api/iam/users', {
      method: 'POST',
      body: JSON.stringify({
        email: $('iam-add-email').value.trim(),
        name: $('iam-add-name').value.trim(),
        role: $('iam-add-role').value,
        password: $('iam-add-password').value,
        cxoneIdentities: $('iam-add-cx').value,
      }),
    });
    const password = $('iam-add-password').value;
    setStatus('iam-add-status', password ? `Added. Give them their temporary password: ${password}` : 'Added. They sign in with a Checkmarx One key.', 'ok');
    for (const id of ['iam-add-email', 'iam-add-name', 'iam-add-password', 'iam-add-cx']) $(id).value = '';
    renderAccess();
  } catch (error) {
    if (!handleAuthLoss(error)) showError('iam-add-status', error);
  }
});

/** The role form: a new role, a copy of one (same permissions, nobody has it yet), or renaming one. */
const roleForm = { mode: 'new', id: null };

/** "Security Analyst (copy)", or "(copy 2)" and on when that name is taken. */
function copyName(name) {
  const taken = new Set(access.data.roles.map((r) => r.name.trim().toLowerCase()));
  for (let n = 1; ; n++) {
    const candidate = `${name} (copy${n > 1 ? ` ${n}` : ''})`.slice(0, 60);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function openRoleForm(mode, role = null) {
  roleForm.mode = mode;
  roleForm.id = role?.id ?? null;
  $('iam-role-form-title').textContent = { new: 'New role', copy: 'Duplicate role', rename: 'Rename role' }[mode];
  $('iam-role-form-of').hidden = !role;
  $('iam-role-form-of').textContent = role?.name ?? '';
  $('iam-role-submit').textContent = { new: 'Create role', copy: 'Create copy', rename: 'Save' }[mode];
  $('iam-role-hint').textContent = {
    new: 'Then tick its permissions in the matrix.',
    copy: 'The copy starts with the same permissions. Nobody has it until you give it to someone.',
    rename: 'The people with this role keep it, and its permissions stay as they are.',
  }[mode];
  $('iam-role-name').value = mode === 'rename' ? role.name : mode === 'copy' ? copyName(role.name) : '';
  $('iam-role-desc').value = role?.description ?? '';
  setStatus('iam-role-status', '');
  $('iam-role-form').hidden = false;
  $('iam-role-name').focus();
  $('iam-role-name').select();
}
function closeRoleForm() {
  $('iam-role-form').hidden = true;
  roleForm.mode = 'new';
  roleForm.id = null;
}

$('iam-role-new').addEventListener('click', () => {
  if (!$('iam-role-form').hidden && roleForm.mode === 'new') closeRoleForm();
  else openRoleForm('new');
});
$('iam-role-cancel').addEventListener('click', closeRoleForm);
$('iam-role-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('iam-role-name').value.trim();
  const description = $('iam-role-desc').value.trim();
  const role = access.data.roles.find((r) => r.id === roleForm.id);
  const mine = new Set(access.data.me.permissions);
  const adminOnly = new Set(access.data.permissions.filter((p) => p.adminOnly).map((p) => p.id));
  try {
    if (roleForm.mode === 'rename' && role) {
      // The saved permissions go back unchanged; ticks not saved yet stay in the matrix.
      access.data = await api(`/api/iam/roles/${encodeURIComponent(role.id)}`, { method: 'PUT', body: JSON.stringify({ name, description, permissions: role.permissions }) });
    } else {
      // A copy holds what the original holds, less anything only the Admin role may hold or that you do not hold yourself.
      const permissions = roleForm.mode === 'copy' && role ? role.permissions.filter((p) => mine.has(p) && !adminOnly.has(p)) : [];
      access.data = await api('/api/iam/roles', { method: 'POST', body: JSON.stringify({ name, description, permissions }) });
    }
    const done = { new: 'Role created — tick its permissions in its column, then save.', copy: 'Copy created — change its permissions in its column, then save.', rename: 'Renamed.' }[roleForm.mode];
    closeRoleForm();
    renderAccess();
    setStatus('iam-matrix-status', done, 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('iam-role-status', error);
  }
});

async function iamCall(path, options, done = '') {
  try {
    access.data = await api(path, options);
    renderAccess();
    setStatus('iam-status', done, 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('iam-status', error);
    renderAccess();
  }
}

$('iam-users').addEventListener('change', (event) => {
  const select = event.target.closest('[data-iam-role]');
  if (!select) return;
  const user = access.data.users.find((u) => u.id === select.dataset.iamRole);
  iamCall(`/api/iam/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ role: select.value }) }, `${user.email} is now ${roleName(select.value)}.`);
});

$('iam-users').addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const id = button.dataset.iamProfile || button.dataset.iamReset || button.dataset.iamTwostep || button.dataset.iamSsolink || button.dataset.iamIds || button.dataset.iamToggle || button.dataset.iamDelete || button.dataset.iamTenants;
  const user = access.data.users.find((u) => u.id === id);
  if (!user) return;
  if (button.dataset.iamProfile) {
    openProfileOf(id);
  } else if (button.dataset.iamTenants) {
    const tenants = [...button.closest('.tn-pop').querySelectorAll('input:checked')].map((input) => input.value);
    if (!tenants.length) return setStatus('iam-status', 'Choose at least one tenant.', 'error');
    iamCall(`/api/iam/users/${id}/tenants`, { method: 'PUT', body: JSON.stringify({ tenants }) }, 'Saved.');
  } else if (button.dataset.iamReset) {
    const password = generatePassword();
    if (!confirm(`Set a temporary password for ${user.email}? They are signed out and choose their own at next sign-in.`)) return;
    iamCall(`/api/iam/users/${id}/password`, { method: 'POST', body: JSON.stringify({ password }) }, `Temporary password for ${user.email}: ${password}`);
  } else if (button.dataset.iamTwostep) {
    if (!confirm(`Reset two-step sign-in for ${user.email}? Their authenticator app and recovery codes stop working here, and they set it up again.`)) return;
    iamCall(`/api/iam/users/${id}/two-step`, { method: 'DELETE' }, `Two-step sign-in was reset for ${user.email}.`);
  } else if (button.dataset.iamSsolink) {
    if (!confirm(`Reset the single sign-on link of ${user.email}? Do this when their account at the identity provider was made anew. Their next single sign-on links them again, by their email address.`)) return;
    iamCall(`/api/iam/users/${id}/sso-link`, { method: 'DELETE' }, `The single sign-on link of ${user.email} was reset.`);
  } else if (button.dataset.iamIds) {
    const value = prompt(`Checkmarx One identities that sign in as ${user.email} — Checkmarx One usernames, comma separated (their email always counts):`, user.cxoneIdentities.join(', '));
    if (value === null) return;
    iamCall(`/api/iam/users/${id}`, { method: 'PATCH', body: JSON.stringify({ cxoneIdentities: value }) }, 'Saved.');
  } else if (button.dataset.iamToggle) {
    if (!user.disabled && !confirm(`Disable ${user.email}? They are signed out at once.`)) return;
    iamCall(`/api/iam/users/${id}`, { method: 'PATCH', body: JSON.stringify({ disabled: !user.disabled }) }, `${user.email} ${user.disabled ? 'enabled' : 'disabled'}.`);
  } else if (button.dataset.iamDelete) {
    if (!confirm(`Remove ${user.email}? They lose access at once.`)) return;
    iamCall(`/api/iam/users/${id}`, { method: 'DELETE' }, `${user.email} removed.`);
  }
});

$('iam-matrix').addEventListener('click', (event) => {
  const action = event.target.closest('[data-iam-role-rename], [data-iam-role-copy]');
  if (action) {
    const role = access.data.roles.find((r) => r.id === (action.dataset.iamRoleRename || action.dataset.iamRoleCopy));
    if (role) openRoleForm(action.dataset.iamRoleRename ? 'rename' : 'copy', role);
    return;
  }
  const button = event.target.closest('[data-iam-role-delete]');
  if (!button) return;
  const id = button.dataset.iamRoleDelete;
  if (!confirm(`Remove the role "${roleName(id)}"?`)) return;
  iamCall(`/api/iam/roles/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Role removed.');
});

// ---------------------------------------------------------------------------
// Credits page: the pool, usage over time, by project, allocated vs used
// ---------------------------------------------------------------------------

const USAGE_REFRESH_MS = 30_000;
export let usageTimer = null;
const usage = { data: null, loading: false };
const isoDay = (date) => date.toISOString().slice(0, 10);

/** The period the filters describe, as from/to dates (UTC). */
function usageRange() {
  const preset = $('usage-preset').value;
  const today = new Date();
  const day = (offset) => isoDay(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset)));
  if (preset === 'custom') return { from: $('usage-from').value, to: $('usage-to').value };
  if (preset === 'this-month') return { from: isoDay(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))), to: day(0) };
  if (preset === 'last-month') {
    return {
      from: isoDay(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1))),
      to: isoDay(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0))),
    };
  }
  return { from: day(1 - Number(preset)), to: day(0) };
}

export async function loadUsage() {
  clearTimeout(usageTimer);
  if ($('page-credits').hidden) return;
  const range = usageRange();
  const query = new URLSearchParams({ ...range, bucket: $('usage-bucket').value, projectId: $('usage-project').value });
  $('page-credits').classList.add('loading');
  try {
    usage.data = await api(`/api/credits/usage?${query}`);
    renderUsage(usage.data);
  } catch (error) {
    if (handleAuthLoss(error)) return;
    $('usage-chart').innerHTML = `<p class="status error">${escapeHtml(error.message)}</p>`;
  } finally {
    $('page-credits').classList.remove('loading');
  }
  usageTimer = setTimeout(loadUsage, USAGE_REFRESH_MS);
}

const BUCKET_NAMES = { day: 'day', week: 'week', month: 'month' };
function bucketLabel(start, bucket, { long = false } = {}) {
  const d = new Date(`${start}T00:00:00Z`);
  if (bucket === 'month') return d.toLocaleDateString(undefined, { month: long ? 'long' : 'short', year: 'numeric', timeZone: 'UTC' });
  const text = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return bucket === 'week' && long ? `Week of ${text}` : text;
}

function renderUsage(data) {
  // Projects to filter by: every one with an allocation or usage, keeping the choice.
  const select = $('usage-project');
  const chosen = select.value;
  const names = new Map(data.projects.map((p) => [p.projectId, p.projectName || p.projectId]));
  for (const p of data.byProject) if (!names.has(p.projectId)) names.set(p.projectId, p.projectName || p.projectId);
  select.innerHTML = `<option value="">All projects</option>${[...names]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, name]) => `<option value="${escapeHtml(id)}"${id === chosen ? ' selected' : ''}>${escapeHtml(name)}</option>`)
    .join('')}`;

  const pool = data.pool;
  $('pool-period-note').textContent = pool.limited ? `${fmt(pool.size)} credits · ${periodText(pool)}` : 'No pool size set';
  $('credits-pool').innerHTML = poolHtml(pool);

  const t = data.totals;
  const span = `${new Date(`${data.from}T00:00:00Z`).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' })} – ${new Date(`${data.to}T00:00:00Z`).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' })}`;
  $('usage-range-note').textContent = `${span} · by ${BUCKET_NAMES[data.bucket]}${data.projectId ? ` · ${names.get(data.projectId) ?? data.projectId}` : ''}`;
  const share = (n) => (t.credits ? `${Math.round((n / t.credits) * 100)}% of credits used` : '—');
  $('usage-tiles').innerHTML = [
    { label: 'Credits used', value: fmt(t.credits), detail: `${fmt(t.requests)} request${t.requests === 1 ? '' : 's'} · ${fmt(t.projects)} project${t.projects === 1 ? '' : 's'}`, hero: true },
    { label: 'AI Triage', value: fmt(t.triage), detail: share(t.triage), key: 'triage' },
    { label: 'AI Remediation', value: fmt(t.remediation), detail: share(t.remediation), key: 'remediation' },
    { label: `Average per ${BUCKET_NAMES[data.bucket]}`, value: fmt(Math.round((t.credits / Math.max(1, data.series.length)) * 10) / 10), detail: `Busiest: ${busiest(data)}` },
  ]
    .map((x) => `<div class="${x.hero ? 'hero' : ''}"><span class="label">${x.key ? `<i class="key key-${x.key}"></i>` : ''}${escapeHtml(x.label)}</span><span class="value">${escapeHtml(x.value)}</span><span class="detail">${escapeHtml(x.detail)}</span></div>`)
    .join('');

  drawUsageChart(data);
  renderUsageTable(data);
  renderUsageProjects(data);
  renderAllocations(data.allocations ?? []);
}

function busiest(data) {
  const top = data.series.reduce((best, row) => (row.credits > (best?.credits ?? 0) ? row : best), null);
  return top ? `${bucketLabel(top.start, data.bucket, { long: true })} (${fmt(top.credits)})` : 'none yet';
}

/** A clean axis maximum and step: 1, 2 or 5 × 10^n. */
function niceScale(max, ticks = 4) {
  if (max <= 0) return { top: 4, step: 1 };
  const raw = max / ticks;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((v) => v >= raw);
  return { top: Math.ceil(max / step) * step, step: Math.max(1, step) };
}

/** Stacked columns per day/week/month: triage at the base, remediation on top. */
function drawUsageChart(data) {
  const box = $('usage-chart');
  const series = data.series;
  if (!data.totals.credits) {
    box.innerHTML = '<div class="chart-empty">No credits used in this period.</div>';
    return;
  }
  const width = Math.max(320, box.clientWidth || 800);
  const height = 260;
  const pad = { top: 18, right: 8, bottom: 28, left: 40 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const { top, step } = niceScale(Math.max(...series.map((r) => r.credits)));
  const y = (v) => pad.top + plotH - (v / top) * plotH;
  const band = plotW / series.length;
  const barW = Math.max(2, Math.min(24, band * 0.7));
  const GAP = 2;
  // A rectangle with a 4px rounded top (square at the baseline, or square top when another segment sits on it).
  const rect = (x, yTop, h, roundTop) => {
    if (h <= 0) return '';
    const r = roundTop ? Math.min(4, barW / 2, h) : 0;
    return `M${x},${yTop + h}V${yTop + r}${r ? `Q${x},${yTop} ${x + r},${yTop}` : ''}H${x + barW - r}${r ? `Q${x + barW},${yTop} ${x + barW},${yTop + r}` : ''}V${yTop + h}Z`;
  };
  const grid = [];
  for (let v = 0; v <= top; v += step) {
    grid.push(`<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(v)}" y2="${y(v)}" /><text x="${pad.left - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`);
  }
  const labelEvery = Math.ceil(series.length / Math.max(1, Math.floor(plotW / 64)));
  const peak = series.reduce((best, row, i) => (row.credits > series[best].credits ? i : best), 0);
  const cols = series
    .map((row, i) => {
      const x = pad.left + i * band + (band - barW) / 2;
      const hT = (row.triage / top) * plotH;
      const hR = (row.remediation / top) * plotH;
      const baseY = pad.top + plotH;
      const triageTop = baseY - hT;
      const remTop = triageTop - hR - (hT > 0 && hR > 0 ? GAP : 0);
      const paths = `<path class="bar-triage" d="${rect(x, triageTop, hT, hR <= 0)}" /><path class="bar-remediation" d="${rect(x, remTop, hR, true)}" />`;
      const label = i % labelEvery === 0 ? `<text class="axis-x" x="${x + barW / 2}" y="${height - 8}" text-anchor="middle">${escapeHtml(bucketLabel(row.start, data.bucket))}</text>` : '';
      const peakLabel = i === peak && row.credits ? `<text class="peak" x="${x + barW / 2}" y="${Math.min(remTop, triageTop) - 5}" text-anchor="middle">${fmt(row.credits)}</text>` : '';
      return `<g class="col" data-i="${i}" tabindex="0" role="img" aria-label="${escapeHtml(`${bucketLabel(row.start, data.bucket, { long: true })}: ${row.triage} triage, ${row.remediation} remediation`)}">
        <rect class="hit" x="${pad.left + i * band}" y="${pad.top}" width="${band}" height="${plotH}" />${paths}${peakLabel}</g>${label ? `<g class="axis">${label}</g>` : ''}`;
    })
    .join('');
  box.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-label="Credits used per ${data.bucket}">
    <g class="grid axis">${grid.join('')}</g>${cols}</svg><div class="tip" hidden></div>`;

  const tip = box.querySelector('.tip');
  const show = (g) => {
    const row = series[Number(g.dataset.i)];
    tip.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'tip-title';
    title.textContent = bucketLabel(row.start, data.bucket, { long: true });
    tip.append(title);
    for (const [name, value, color] of [['AI Triage', row.triage, 'var(--series-1)'], ['AI Remediation', row.remediation, 'var(--series-2)'], ['Total', row.credits, '']]) {
      const line = document.createElement('div');
      line.className = 'tip-row';
      line.innerHTML = `<span class="line-key" style="background:${color || 'transparent'}"></span><b></b><span></span>`;
      line.querySelector('b').textContent = fmt(value);
      line.querySelector('span:last-child').textContent = name;
      tip.append(line);
    }
    tip.hidden = false;
    const hit = g.querySelector('.hit').getBBox();
    const scale = box.clientWidth / width;
    const left = (hit.x + hit.width / 2) * scale;
    tip.style.left = `${Math.min(Math.max(0, left - tip.offsetWidth / 2), box.clientWidth - tip.offsetWidth)}px`;
    tip.style.top = `${Math.max(0, pad.top * scale - 4)}px`;
  };
  for (const g of box.querySelectorAll('.col')) {
    g.addEventListener('pointerenter', () => show(g));
    g.addEventListener('focus', () => show(g));
    g.addEventListener('pointerleave', () => (tip.hidden = true));
    g.addEventListener('blur', () => (tip.hidden = true));
  }
}

function renderUsageTable(data) {
  $('usage-table').innerHTML = `<div class="table-wrap"><table class="probe">
    <thead><tr><th>${data.bucket === 'day' ? 'Day' : data.bucket === 'week' ? 'Week of' : 'Month'}</th><th class="num">AI Triage</th><th class="num">AI Remediation</th><th class="num">Total</th><th class="num">Requests</th><th class="num">Running total</th></tr></thead>
    <tbody>${data.series
      .map((r) => `<tr><td>${escapeHtml(bucketLabel(r.start, data.bucket, { long: true }))}</td><td class="num">${fmt(r.triage)}</td><td class="num">${fmt(r.remediation)}</td><td class="num"><b>${fmt(r.credits)}</b></td><td class="num">${fmt(r.requests)}</td><td class="num">${fmt(r.cumulative)}</td></tr>`)
      .join('')}</tbody>
    <tfoot><tr><th>Total</th><th class="num">${fmt(data.totals.triage)}</th><th class="num">${fmt(data.totals.remediation)}</th><th class="num">${fmt(data.totals.credits)}</th><th class="num">${fmt(data.totals.requests)}</th><th></th></tr></tfoot>
  </table></div>`;
}

function renderUsageProjects(data) {
  if (!data.byProject.length) {
    $('usage-projects').innerHTML = '<p class="hint">No project used credits in this period.</p>';
    return;
  }
  const max = Math.max(...data.byProject.map((p) => p.credits));
  const pct = (n) => `${((n / max) * 100).toFixed(2)}%`;
  $('usage-projects').innerHTML = `<div class="table-wrap"><table class="probe">
    <thead><tr><th>Project</th><th class="share-cell">Share</th><th class="num">AI Triage</th><th class="num">AI Remediation</th><th class="num">Total</th><th class="num">Requests</th><th>Last used</th></tr></thead>
    <tbody>${data.byProject
      .map((p) => `<tr>
        <td>${escapeHtml(p.projectName || p.projectId)}</td>
        <td class="share-cell"><div class="hbar" title="${p.triage} triage, ${p.remediation} remediation"><span class="m-triage" style="width:${pct(p.triage)}"></span><span class="m-remediation" style="width:${pct(p.remediation)}"></span></div></td>
        <td class="num">${fmt(p.triage)}</td><td class="num">${fmt(p.remediation)}</td><td class="num"><b>${fmt(p.credits)}</b></td><td class="num">${fmt(p.requests)}</td>
        <td>${escapeHtml(new Date(p.lastUsedAt).toLocaleString())}</td></tr>`)
      .join('')}</tbody>
    <tfoot><tr><th>Total</th><th></th><th class="num">${fmt(data.totals.triage)}</th><th class="num">${fmt(data.totals.remediation)}</th><th class="num">${fmt(data.totals.credits)}</th><th class="num">${fmt(data.totals.requests)}</th><th></th></tr></tfoot>
  </table></div>`;
}

/** Per project: first allocated, allocated now, used through this utility, left. */
function renderAllocations(all) {
  const filter = $('alloc-search').value.trim().toLowerCase();
  const list = filter ? all.filter((p) => (p.projectName || p.projectId).toLowerCase().includes(filter)) : all;
  renderTakeBack(all);
  renderGive();
  renderSpend(all);
  const mayTakeBack = can('credits.allocate');
  const mayPick = canAny('triage.run credits.allocate');
  if (!list.length) {
    $('credit-allocations').innerHTML = `<p class="hint">${all.length ? 'No project matches.' : mayTakeBack ? 'No project has an allocation yet — give credits above, or on the Workbench.' : 'No project has an allocation yet.'}</p>`;
    return;
  }
  const bar = (k) => {
    const pct = k.allocated ? Math.min(100, Math.round((k.used / k.allocated) * 100)) : 0;
    return `<div class="use-bar" title="${k.used} of ${k.allocated} used"><span style="width:${pct}%"></span></div>`;
  };
  const cells = (k) => `<td class="num">${fmt(k.initial)}</td><td class="num">${fmt(k.allocated)}</td><td class="num"><b>${fmt(k.used)}</b>${bar(k)}</td><td class="num">${fmt(k.remaining)}</td>`;
  const sum = (kind, key) => list.reduce((n, p) => n + (p[kind][key] ?? 0), 0);
  const totals = (kind) => ['initial', 'allocated', 'used', 'remaining'].map((key) => `<th class="num">${fmt(sum(kind, key))}</th>`).join('');
  $('credit-allocations').innerHTML = `<div class="table-wrap"><table class="probe alloc-table">
    <thead>
      <tr>${mayPick ? '<th rowspan="2" class="alloc-pick"><span class="sr-only">Pick</span></th>' : ''}<th rowspan="2">Project</th><th colspan="4" class="group">AI Triage</th><th colspan="4" class="group">AI Remediation</th>${mayTakeBack ? '<th rowspan="2"><span class="sr-only">Give or take back</span></th>' : ''}</tr>
      <tr>${'<th class="num">At start</th><th class="num">Allocated</th><th class="num">Used</th><th class="num" data-i18n-ctx="credits">Left</th>'.repeat(2)}</tr>
    </thead>
    <tbody>${list
      .map((p) => `<tr>${mayPick ? `<td class="alloc-pick"><input type="checkbox" data-spend-pick="${escapeHtml(p.projectId)}" aria-label="Pick" ${spend.picked.has(p.projectId) ? 'checked' : ''} /></td>` : ''}<td><span translate="no">${escapeHtml(p.projectName || p.projectId)}</span><div class="hint">${allocationRule(p)}</div>${spend.gone.has(p.projectId) ? '<div class="hint is-warn">No longer in Checkmarx One: take its credits back.</div>' : ''}</td>${cells(p.triage)}${cells(p.remediation)}${mayTakeBack ? `<td class="alloc-actions"><button type="button" class="sm" data-give="${escapeHtml(p.projectId)}" title="Give this project more credits">Give</button>${unusedOf(p) ? `<button type="button" class="sm danger-soft" data-reclaim="${escapeHtml(p.projectId)}" title="Take back the ${unusedOf(p)} credit(s) this project has not used">Take back ${fmt(unusedOf(p))}</button>` : ''}</td>` : ''}</tr>`)
      .join('')}</tbody>
    <tfoot><tr>${mayPick ? '<th></th>' : ''}<th>Total</th>${totals('triage')}${totals('remediation')}${mayTakeBack ? '<th></th>' : ''}</tr></tfoot>
  </table></div>`;
}

/** Under a project's name: the severities its needs cover, and when it was first given credits (each piece translatable). */
function allocationRule(p) {
  const severities = p.severities.length ? p.severities.map((s) => `<span>${escapeHtml(s.charAt(0) + s.slice(1).toLowerCase())}</span>`).join(', ') : '<span>No severities</span>';
  return `${severities}${p.initialAt ? ` · <span>First given:</span> <span translate="no">${escapeHtml(new Date(p.initialAt).toLocaleDateString())}</span>` : ''}`;
}

/** Credits a project was given and has not used (nor has in flight): what taking back returns. */
const unusedOf = (p) => (p.triage.remaining ?? 0) + (p.remediation.remaining ?? 0);

/** The clean-slate bar above the allocations: how much every project holds unused. */
function renderTakeBack(all) {
  const bar = $('cc-takeback');
  if (!can('credits.allocate')) return (bar.hidden = true);
  const unused = all.reduce((n, p) => n + unusedOf(p), 0);
  const holding = all.filter((p) => unusedOf(p) > 0).length;
  bar.hidden = all.length === 0;
  $('cc-reclaim-all').disabled = unused === 0;
  $('cc-reclaim-all').textContent = unused ? `Take back all ${fmt(unused)} unused credits` : 'Nothing to take back';
  // Plain numbers (no thousands separator), so each wording is one entry to translate.
  $('cc-takeback-note').textContent = unused
    ? `${holding} project${holding === 1 ? ' holds' : 's hold'} ${unused} credit${unused === 1 ? '' : 's'} they have not used. Taking them back returns them to the credit pool; used credits stay counted.`
    : 'Every project has used what it was given. Nothing is waiting to be taken back.';
}

/** Take back unused credits: from every project (clean slate), or one. */
async function takeBackCredits(projectIds = null) {
  const all = usage.data?.allocations ?? [];
  const chosen = projectIds ? all.filter((p) => projectIds.includes(p.projectId)) : all;
  const triage = chosen.reduce((n, p) => n + (p.triage.remaining ?? 0), 0);
  const remediation = chosen.reduce((n, p) => n + (p.remediation.remaining ?? 0), 0);
  if (!triage && !remediation) return setStatus('cc-takeback-status', 'Nothing to take back.', 'ok');
  const who = projectIds ? `"${chosen[0]?.projectName || chosen[0]?.projectId}"` : `every project (${chosen.filter((p) => unusedOf(p)).length})`;
  if (!confirm(`Take back ${triage + remediation} unused credit(s) — ${triage} triage, ${remediation} remediation — from ${who} to the credit pool?\n\nDevelopers cannot triage or remediate from their reports until credits are given again. Used credits stay counted.`)) return;
  try {
    const result = await api('/api/credits/reclaim', { method: 'POST', body: JSON.stringify(projectIds ? { projectIds } : { all: true }) });
    setStatus('cc-takeback-status', `Took back ${fmt(result.reclaimed)} credit(s) from ${result.projects} project(s) to the credit pool.`, 'ok');
    logger.add(`Took back ${result.reclaimed} unused credit(s) from ${result.projects} project(s)`, 'success');
    if (usage.data) {
      usage.data.allocations = result.allocations;
      usage.data.pool = result.pool;
      $('credits-pool').innerHTML = poolHtml(result.pool);
    }
    renderAllocations(result.allocations);
    creditsChanged();
  } catch (error) {
    if (handleAuthLoss(error)) return;
    setStatus('cc-takeback-status', error.message, 'error');
  }
}

// Taking back spends nothing, so it needs no findings loaded and no check with Checkmarx One first.
$('cc-reclaim-all').addEventListener('click', () => takeBackCredits());
$('credit-allocations').addEventListener('change', (event) => {
  const box = event.target.closest('[data-spend-pick]');
  if (!box) return;
  if (box.checked) spend.picked.add(box.dataset.spendPick);
  else spend.picked.delete(box.dataset.spendPick);
  renderSpend(usage.data?.allocations ?? []);
});
$('credit-allocations').addEventListener('click', (event) => {
  const button = event.target.closest('[data-reclaim]');
  if (button) takeBackCredits([button.dataset.reclaim]);
  const give = event.target.closest('[data-give]');
  if (give) chooseGiveProject(give.dataset.give);
});

// ---------------------------------------------------------------------------
// Impact: hours AI saved, findings it cleared, time to fix, the debt week by week
// ---------------------------------------------------------------------------

const impact = { data: null, asTable: false };
const SEV_LABEL = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };
const num1 = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 }));
const priceOf = (n, currency) => moneyOf(n, currency, 2);
const cashOf = (n, currency) => moneyOf(n, currency, 0);

export async function loadImpact() {
  const days = $('impact-days').value;
  $('impact-download').href = `/api/impact/summary.html?days=${encodeURIComponent(days)}`;
  try {
    impact.data = await api(`/api/impact?days=${encodeURIComponent(days)}`);
    renderImpact();
  } catch (error) {
    if (handleAuthLoss(error)) return;
    $('impact-tiles').innerHTML = `<p class="status error">${escapeHtml(error.message)}</p>`;
  }
}

function renderImpact() {
  const d = impact.data;
  if (!d) return;
  const m = d.money;
  const note = $('impact-note');
  note.hidden = !d.partial && Boolean(d.since);
  note.textContent = !d.since
    ? 'No readings yet. Figures start with the next Workbench fetch (with no date window) or tracked report refresh.'
    : `Readings start on ${d.since.slice(0, 10)}: the period before that is not included.`;
  // Figures from this person's own profile: said once, with where to change them.
  const mine = $('impact-currency-note');
  mine.hidden = !d.personal;
  mine.innerHTML = d.personal
    ? `<span>Worked out with your own figures from your profile.</span> <a href="#/settings/profile">Change them →</a>`
    : '';
  const tile = (label, value, sub, hero = false, tone = '') => `<div class="impact-tile${hero ? ' hero' : ''}"><span class="label">${label}</span><span class="value${tone ? ` ${tone}` : ''}">${value}</span><span class="sub">${sub}</span></div>`;
  const debt = d.debt;
  $('impact-tiles').innerHTML = [
    tile('Hours saved', `${num1(d.hours.total)} h`, `<span>${num1(d.hours.triage)} h triage</span> · <span>${num1(d.hours.fix)} h fixing</span>`, true),
    m.value === null
      ? tile('Value of that time', '—', `<a href="#/settings/profile">Set an hourly cost</a>`)
      // Amounts carry their currency, so they stay as they are; the words around them are translated on their own.
      : tile(m.cost === null ? 'Value of that time' : 'Saved, after credits', `<span translate="no">${escapeHtml(cashOf(m.net ?? m.value, m.currency))}</span>`, m.cost === null ? '<span>before the cost of credits</span>' : `<span><span translate="no">${escapeHtml(cashOf(m.value, m.currency))}</span> <span>saved</span></span> · <span><span translate="no">${escapeHtml(cashOf(m.cost, m.currency))}</span> <span>in credits</span></span>`),
    tile('Noise removed', num1(d.noiseRemoved), '<span>findings AI Triage showed not exploitable</span>'),
    tile('Fixed with AI', num1(d.aiFixed), `<span>${num1(d.manualFixed)} fixed by hand</span>`),
    // Down is good: the change wears the good colour (with its arrow), never only colour.
    tile('Security debt', debt.change === null ? '—' : `${debt.change < 0 ? '▼' : debt.change > 0 ? '▲' : ''} ${Math.abs(debt.change)}%`, debt.zeroBy ? `<span>zero by ${escapeHtml(debt.zeroBy)} at this pace</span>` : '<span>open findings, weighted by severity</span>', false, debt.change < 0 ? 'good' : debt.change > 0 ? 'bad' : ''),
    tile('Credits per finding closed', num1(d.creditsPerClosed), d.costPerClosed === null ? '<span>fixed or cleared by AI</span>' : `<span><span translate="no">${escapeHtml(priceOf(d.costPerClosed, m.currency))}</span> <span>each</span></span>`),
  ].join('');
  $('impact-debt-line').textContent = debt.change === null
    ? 'No open findings at the start of the period.'
    : `${debt.change <= 0 ? 'Down' : 'Up'} ${Math.abs(debt.change)}% in this period: from ${num1(debt.start)} to ${num1(debt.now)}.`;
  renderImpactChart();
  renderImpactTimeToFix();
  const s = d.settings;
  $('impact-how').innerHTML = [
    `Hours saved: Checkmarx One results triaged by AI (${num1(d.credits.triage)}) × ${s.triageMinutes} min, plus fixes with AI (${num1(d.aiFixed)}) × ${s.fixMinutes} min.`,
    'A fix counts only once Checkmarx One no longer reports the finding. Rows that share one result count once.',
    m.value === null ? 'Money: set an hourly cost and the price of one credit under Settings → AI & credit pool.' : 'Money: hours saved × the hourly cost, less the credits used × the price of one credit (both under Settings → AI & credit pool).',
    'Security debt: open Checkmarx One results weighted by severity (critical 10, high 5, medium 2, low 1). The date it reaches zero follows the last four weeks.',
    'Time to fix: days from first detection until Checkmarx One no longer reports it. AI-fixed and fixed by hand are compared over the same period.',
  ].map((line) => `<li>${line}</li>`).join('');
  renderImpactProjects();
  const monthly = $('impact-monthly-state');
  if (monthly) {
    // Each sentence its own piece, so each is translated whole.
    monthly.innerHTML = d.monthlyOn
      ? `<span>On: emailed on the first day of each month, for the month before.</span> <span>Recipients: ${(d.monthlyTo ?? []).length}.</span>${d.lastSent ? ` <span>Last sent: ${escapeHtml(d.lastSent)}.</span>` : ''}`
      : '<span>Off: add who gets it under Settings → AI & credit pool.</span>';
    $('impact-send').disabled = !d.monthlyOn;
  }
}

/** The debt as one line with a light wash, a crosshair and a tooltip; or the same as a table. */
function renderImpactChart() {
  const series = impact.data.series ?? [];
  const box = $('impact-chart');
  $('impact-as-table').textContent = impact.asTable ? 'Show as a chart' : 'Show as a table';
  $('impact-as-table').setAttribute('aria-pressed', String(impact.asTable));
  if (series.length < 2 && !impact.asTable) {
    box.innerHTML = '<p class="hint">The chart appears after two weeks of readings.</p>';
    return;
  }
  if (impact.asTable) {
    box.innerHTML = `<div class="table-wrap"><table class="probe"><thead><tr><th>Week</th><th class="num">Debt</th>${Object.keys(SEV_LABEL).map((k) => `<th class="num">${SEV_LABEL[k]}</th>`).join('')}</tr></thead><tbody>${series
      .map((p) => `<tr><td>${escapeHtml(p.at.slice(0, 10))}</td><td class="num">${num1(p.score)}</td>${Object.keys(SEV_LABEL).map((k) => `<td class="num">${num1(p.bySeverity[k])}</td>`).join('')}</tr>`)
      .join('')}</tbody></table></div>`;
    return;
  }
  const width = Math.max(320, box.clientWidth || 720);
  const height = 220;
  const pad = { l: 44, r: 52, t: 14, b: 26 };
  const max = Math.max(1, ...series.map((p) => p.score));
  const step = 10 ** Math.floor(Math.log10(max));
  const top = Math.ceil(max / step) * step;
  const x = (i) => pad.l + (i / (series.length - 1)) * (width - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / top) * (height - pad.t - pad.b);
  const line = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join('');
  const last = series.at(-1);
  box.innerHTML = `<svg class="impact-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Security debt from ${escapeHtml(series[0].at.slice(0, 10))} to ${escapeHtml(last.at.slice(0, 10))}: ${num1(series[0].score)} to ${num1(last.score)}">
      ${[0, top / 2, top].map((v) => `<line class="grid" x1="${pad.l}" x2="${width - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${num1(v)}</text>`).join('')}
      <path class="area" d="${line}L${x(series.length - 1)},${y(0)}L${x(0)},${y(0)}Z"/>
      <path class="line" d="${line}"/>
      <circle class="end" cx="${x(series.length - 1)}" cy="${y(last.score)}" r="4"/>
      <text class="end-label" x="${x(series.length - 1) + 8}" y="${y(last.score) + 4}">${num1(last.score)}</text>
      <text class="tick" x="${pad.l}" y="${height - 6}">${escapeHtml(series[0].at.slice(0, 10))}</text>
      <text class="tick" x="${width - pad.r}" y="${height - 6}" text-anchor="end">${escapeHtml(last.at.slice(0, 10))}</text>
      <line class="cross" x1="0" x2="0" y1="${pad.t}" y2="${height - pad.b}" visibility="hidden"/>
      <circle class="dot" r="4" visibility="hidden"/>
      <rect class="hit" x="${pad.l}" y="0" width="${width - pad.l - pad.r}" height="${height}" fill="transparent"/>
    </svg><div class="impact-tip" hidden></div>`;
  const svg = box.querySelector('svg');
  const tip = box.querySelector('.impact-tip');
  const cross = svg.querySelector('.cross');
  const dot = svg.querySelector('.dot');
  const show = (event) => {
    const rect = svg.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    const i = Math.max(0, Math.min(series.length - 1, Math.round(((px - pad.l) / (width - pad.l - pad.r)) * (series.length - 1))));
    const p = series[i];
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    dot.setAttribute('cx', x(i));
    dot.setAttribute('cy', y(p.score));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('visibility', 'visible');
    tip.innerHTML = `<b>${escapeHtml(p.at.slice(0, 10))}</b><span><span>Debt</span> ${num1(p.score)}</span>${Object.keys(SEV_LABEL).map((k) => `<span><span>${SEV_LABEL[k]}</span> ${num1(p.bySeverity[k])}</span>`).join('')}`;
    tip.hidden = false;
    const left = (x(i) / width) * rect.width;
    tip.style.insetInlineStart = `${Math.min(rect.width - 150, Math.max(0, left + 12))}px`;
  };
  const hide = () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
  };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerleave', hide);
}

function renderImpactTimeToFix() {
  const rows = impact.data.timeToFix.filter((r) => r.aiCount || r.manualCount);
  const days = (value, count) => (value === null ? '—' : `<span>${num1(value)} days</span> <span class="hint">(${count})</span>`);
  $('impact-ttf').innerHTML = rows.length
    ? `<div class="table-wrap"><table class="probe"><thead><tr><th>Severity</th><th class="num">With AI</th><th class="num">By hand</th><th class="num">Difference</th></tr></thead><tbody>${rows
        .map((r) => `<tr><td>${SEV_LABEL[r.severity]}</td><td class="num">${days(r.ai, r.aiCount)}</td><td class="num">${days(r.manual, r.manualCount)}</td><td class="num">${r.ai !== null && r.manual !== null ? `<span>${num1(Math.abs(r.manual - r.ai))} days ${r.ai <= r.manual ? 'sooner' : 'later'}</span>` : '—'}</td></tr>`)
        .join('')}</tbody></table></div>`
    : '<p class="hint">No fixes in this period yet.</p>';
}

function renderImpactProjects() {
  const list = impact.data.byProject;
  const days = (v) => (v === null ? '—' : num1(v));
  $('impact-projects').innerHTML = list.length
    ? `<div class="table-wrap"><table class="probe"><thead><tr><th>Project</th><th class="num">Checked by AI</th><th class="num">Not exploitable</th><th class="num">Fixed with AI</th><th class="num">Fixed by hand</th><th class="num">Days to fix, AI</th><th class="num">Days to fix, by hand</th><th class="num">Credits</th><th class="num">Credits per finding closed</th><th class="num">Open</th></tr></thead><tbody>${list
        .map((p) => `<tr><td translate="no">${escapeHtml(p.projectName || p.projectId)}</td><td class="num">${p.aiTriaged}</td><td class="num">${p.notExploitable}</td><td class="num">${p.aiFixed}</td><td class="num">${p.manualFixed}</td><td class="num">${days(p.aiMedianDays)}</td><td class="num">${days(p.manualMedianDays)}</td><td class="num">${p.credits}</td><td class="num">${days(p.creditsPerClosed)}</td><td class="num">${p.open}</td></tr>`)
        .join('')}</tbody></table></div>`
    : '<p class="hint">No readings yet.</p>';
}

function exportImpactCsv() {
  const d = impact.data;
  if (!d) return;
  const cell = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  const rows = [
    ['Project', 'Checked by AI', 'Not exploitable', 'Fixed with AI', 'Fixed by hand', 'Median days to fix, AI', 'Median days to fix, by hand', 'Credits', 'Credits per finding closed', 'Open now'],
    ...d.byProject.map((p) => [p.projectName || p.projectId, p.aiTriaged, p.notExploitable, p.aiFixed, p.manualFixed, p.aiMedianDays, p.manualMedianDays, p.credits, p.creditsPerClosed, p.open]),
  ];
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([rows.map((r) => r.map(cell).join(',')).join('\n')], { type: 'text/csv' }));
  link.download = `impact-${d.from.slice(0, 10)}-to-${d.to.slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

$('impact-days').addEventListener('change', () => loadImpact());
$('impact-as-table').addEventListener('click', () => {
  impact.asTable = !impact.asTable;
  if (impact.data) renderImpactChart();
});
$('impact-csv').addEventListener('click', exportImpactCsv);
$('impact-send').addEventListener('click', async () => {
  if (!confirm("Email last month's impact summary now to the people on the list?")) return;
  setStatus('impact-send-status', 'Sending…');
  try {
    const result = await api('/api/impact/email', { method: 'POST', body: '{}' });
    setStatus('impact-send-status', `Sent the summary for ${result.month}. Recipients: ${result.to.length}.`, 'ok');
    loadImpact();
  } catch (error) {
    if (!handleAuthLoss(error)) setStatus('impact-send-status', error.message, 'error');
  }
});
window.addEventListener('resize', () => {
  if (state.page === 'impact' && impact.data && !impact.asTable) renderImpactChart();
});

// ---------------------------------------------------------------------------
// Using the credits on the Credit Control page: Triage now / Remediate now
// ---------------------------------------------------------------------------

/** Projects ticked in Allocated vs used; none ticked means every project. */
const spend = { picked: new Set(), gone: new Set() };

/** Projects the last spend or allocation found deleted from Checkmarx One: marked in the table, named in the status. */
export function noteGone(result) {
  for (const p of result?.gone ?? []) spend.gone.add(p.projectId);
  return result?.goneNote ? ` ${result.goneNote}` : '';
}

const spendSeverities = () => [...document.querySelectorAll('[data-spend-sev]:checked')].map((box) => box.dataset.spendSev);
/** The AI engines ticked (SAST and SCA by default; none ticked is never sent). */
const spendEngines = () => [...document.querySelectorAll('[data-spend-engine]:checked')].map((box) => box.dataset.spendEngine);

/**
 * What the ticked projects' chosen severities need, for those loaded on the Workbench
 * (Credit Control reads Checkmarx One only when a button is pressed); null when unknown.
 */
function spendNeed(chosen, severities) {
  const loaded = new Map(state.projects.filter((p) => p.credits).map((p) => [p.projectId, p.credits]));
  if (!chosen.length || !chosen.every((p) => loaded.has(p.projectId))) return null;
  const sum = (key) => chosen.reduce((n, p) => n + severities.reduce((m, s) => m + (loaded.get(p.projectId)[key]?.[s] ?? 0), 0), 0);
  return { triage: sum('toTriage'), remediation: 3 * sum('toRemediateBySeverity') };
}

/**
 * The bar's buttons work once the chosen projects hold credits to use (1 to triage, 3 to remediate),
 * and turn gold only when projects are ticked and their credits cover what the ticked severities need.
 */
function renderSpend(all) {
  const bar = $('cc-spend');
  bar.hidden = !canAny('triage.run credits.allocate') || !all.length;
  if (bar.hidden) return;
  for (const id of spend.picked) if (!all.some((p) => p.projectId === id)) spend.picked.delete(id);
  const chosen = spend.picked.size ? all.filter((p) => spend.picked.has(p.projectId)) : all;
  const triage = chosen.reduce((n, p) => n + (p.triage.remaining ?? 0), 0);
  const remediation = chosen.reduce((n, p) => n + (p.remediation.remaining ?? 0), 0);
  const severities = spendSeverities().length > 0 && spendEngines().length > 0;
  const need = spend.picked.size ? spendNeed(chosen, spendSeverities()) : null;
  const covers = (kind, left) => need !== null && need[kind] > 0 && left >= need[kind];
  $('cc-run-triage').disabled = !severities || triage < 1;
  $('cc-run-remediation').disabled = !severities || remediation < 3;
  $('cc-run-triage').classList.toggle('is-golden', !$('cc-run-triage').disabled && covers('triage', triage));
  $('cc-run-remediation').classList.toggle('is-golden', !$('cc-run-remediation').disabled && covers('remediation', remediation));
  const figures = (left, needed) => `${fmt(left)} credits left${needed === null ? '' : ` · ${fmt(needed)} needed`}`;
  $('cc-lane-triage').textContent = figures(triage, need?.triage ?? null);
  $('cc-lane-remediation').textContent = figures(remediation, need?.remediation ?? null);
  $('cc-spend-left').textContent = spend.picked.size
    ? `${chosen.length} project${chosen.length === 1 ? '' : 's'} ticked.${need ? '' : ' Load them on the Workbench to see what they need; the buttons turn gold once their credits cover it.'}`
    : 'Every project. Tick projects to see what they need: the buttons turn gold once their credits cover it.';
}

async function runCredits(kind) {
  const severities = spendSeverities();
  if (!severities.length) return setStatus('cc-spend-status', 'Pick at least one severity.', 'error');
  const engines = spendEngines();
  if (!engines.length) return setStatus('cc-spend-status', 'Pick at least one engine.', 'error');
  const all = usage.data?.allocations ?? [];
  const chosen = spend.picked.size ? all.filter((p) => spend.picked.has(p.projectId)) : all;
  const sev = `${severities.map((s) => s.toLowerCase()).join(', ')} ${describeEngines(engines)}`;
  const who = spend.picked.size ? `the ${chosen.length} ticked project(s)` : `every project holding credits (${chosen.length})`;
  const question = kind === 'triage'
    ? `Run AI Triage on the ${sev} findings still awaiting triage in ${who}? It uses Checkmarx One credits.`
    : `Run AI Remediation on the confirmed ${sev} findings in ${who}? It uses 3 Checkmarx One credits each.`;
  if (!confirm(question)) return;
  const button = $(kind === 'triage' ? 'cc-run-triage' : 'cc-run-remediation');
  button.disabled = true;
  setStatus('cc-spend-status', kind === 'triage' ? 'Starting AI Triage…' : 'Starting AI Remediation…');
  try {
    const result = await api('/api/credits/run', { method: 'POST', body: JSON.stringify({ kind, severities, engines, branches: focusPick.allBranches ? 'all' : 'primary', projectIds: [...spend.picked] }) });
    setStatus('cc-spend-status', spendText(result, kind) + noteGone(result), result.failed ? 'error' : 'ok');
    logger.add(spendText(result, kind), result.failed ? 'error' : 'success');
    if (usage.data) {
      usage.data.allocations = result.allocations;
      usage.data.pool = result.pool;
      $('credits-pool').innerHTML = poolHtml(result.pool);
    }
    renderAllocations(result.allocations);
    creditsChanged();
  } catch (error) {
    if (handleAuthLoss(error)) return;
    setStatus('cc-spend-status', error.message, 'error');
    if (error.body?.gone?.length) {
      noteGone(error.body);
      renderAllocations(usage.data?.allocations ?? []);
    }
  } finally {
    renderSpend(usage.data?.allocations ?? []);
  }
}

/** Give the ticked projects what the chosen severities need for one kind of credit (confirmed twice with Checkmarx One), plus its extra. */
async function allocateNeededCredits(kind) {
  const severities = spendSeverities();
  const extraField = kind === 'triage' ? 'cc-spend-extra-triage' : 'cc-spend-extra-remediation';
  const extra = Math.max(0, Math.floor(Number($(extraField).value) || 0));
  if (!severities.length && !extra) return setStatus('cc-spend-status', 'Pick severities, or enter credits to add.', 'error');
  const engines = spendEngines();
  if (severities.length && !engines.length) return setStatus('cc-spend-status', 'Pick at least one engine.', 'error');
  const question = kind === 'triage'
    ? 'Allocate AI Triage credits (1 per Checkmarx One result) from the credit pool to the ticked projects (none ticked: every project holding credits): what the ticked severities need, plus any extra entered?'
    : 'Allocate AI Remediation credits (3 per confirmed result) from the credit pool to the ticked projects (none ticked: every project holding credits): what the ticked severities need, plus any extra entered?';
  if (!confirm(question)) return;
  const button = $(kind === 'triage' ? 'cc-allocate-triage' : 'cc-allocate-remediation');
  button.disabled = true;
  setStatus('cc-spend-status', 'Allocating…');
  try {
    const body = { severities, engines, kind, branches: focusPick.allBranches ? 'all' : 'primary', triageAdd: kind === 'triage' ? extra : 0, remediationAdd: kind === 'triage' ? 0 : extra, projectIds: [...spend.picked] };
    const result = await api('/api/credits/allocate-needed', { method: 'POST', body: JSON.stringify(body) });
    $(extraField).value = 0;
    if (usage.data) {
      usage.data.allocations = result.allocations;
      usage.data.pool = result.pool;
      $('credits-pool').innerHTML = poolHtml(result.pool);
    }
    renderAllocations(result.allocations);
    setStatus('cc-spend-status', `Allocated. The table shows what each project now has.${noteGone(result)}`, 'ok');
    creditsChanged();
  } catch (error) {
    if (handleAuthLoss(error)) return;
    setStatus('cc-spend-status', error.message, 'error');
    if (error.body?.gone?.length) {
      noteGone(error.body);
      renderAllocations(usage.data?.allocations ?? []);
    }
  } finally {
    button.disabled = false;
    renderSpend(usage.data?.allocations ?? []);
  }
}

$('cc-allocate-triage').addEventListener('click', () => allocateNeededCredits('triage'));
$('cc-allocate-remediation').addEventListener('click', () => allocateNeededCredits('remediation'));
$('cc-run-triage').addEventListener('click', () => runCredits('triage'));
$('cc-run-remediation').addEventListener('click', () => runCredits('remediation'));
for (const box of document.querySelectorAll('[data-spend-sev], [data-spend-engine]')) box.addEventListener('change', () => renderSpend(usage.data?.allocations ?? []));

/**
 * Credits were given, taken back or used on one page: the Workbench's balances
 * (and its gold buttons) follow at once. Reports and Credit Control read theirs
 * again whenever they are opened.
 */
export async function creditsChanged() {
  if (!state.projects?.length || state.fetching || !can('credits.view')) return;
  try {
    const { projects } = await api('/api/credits/views');
    let changed = false;
    for (const p of state.projects) {
      if (!projects[p.projectId]) continue;
      p.credits = projects[p.projectId];
      changed = true;
    }
    if (changed) {
      renderProjects();
      renderAllocation();
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Giving credits on the Credit Control page (the Workbench gives them too)
// ---------------------------------------------------------------------------

const give = { projects: null, loading: null, warning: null };

/** Projects credits can be given to: every Checkmarx One project, read once when the bar is first used. */
async function loadGiveProjects({ refresh = false } = {}) {
  if (give.projects && !refresh) return give.projects;
  give.loading ??= api(`/api/credits/projects${refresh ? '?refresh=1' : ''}`)
    .then((result) => {
      give.projects = result.projects;
      give.warning = result.warning;
      renderGiveOptions();
      return give.projects;
    })
    .finally(() => (give.loading = null));
  return give.loading;
}

function renderGiveOptions() {
  const known = new Map((usage.data?.allocations ?? []).map((p) => [p.projectId, p.projectName || p.projectId]));
  for (const p of give.projects ?? []) known.set(p.projectId, p.projectName);
  $('cc-give-options').innerHTML = [...known.values()]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => `<option value="${escapeHtml(name)}"></option>`)
    .join('');
  if (give.warning) setStatus('cc-give-status', give.warning, 'warn');
}

/** The give bar: shown to people who may allocate, with what the pool has free. */
function renderGive() {
  const form = $('cc-give');
  form.hidden = !can('credits.allocate');
  if (form.hidden) return;
  if (!give.projects) renderGiveOptions();
  const pool = usage.data?.pool;
  $('cc-give-free').hidden = !pool?.limited;
  $('cc-give-free-n').textContent = pool?.limited ? fmt(pool.unallocated) : '';
}

/** Which project the typed name means: an exact name (any case), else the only one that contains it. */
function giveProjectOf(text) {
  const wanted = text.trim().toLowerCase();
  if (!wanted) return null;
  const all = new Map((usage.data?.allocations ?? []).map((p) => [p.projectId, { projectId: p.projectId, projectName: p.projectName || p.projectId }]));
  for (const p of give.projects ?? []) all.set(p.projectId, p);
  const list = [...all.values()];
  const exact = list.filter((p) => p.projectName.toLowerCase() === wanted || p.projectId.toLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  const partial = list.filter((p) => p.projectName.toLowerCase().includes(wanted));
  return partial.length === 1 ? partial[0] : null;
}

function chooseGiveProject(projectId) {
  const p = (usage.data?.allocations ?? []).find((x) => x.projectId === projectId) ?? (give.projects ?? []).find((x) => x.projectId === projectId);
  $('cc-give-project').value = p?.projectName || projectId;
  $('cc-give').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('cc-give-triage').focus();
  $('cc-give-triage').select();
}

async function giveCredits() {
  const count = (id) => Math.floor(Number($(id).value) || 0);
  const triage = count('cc-give-triage');
  const remediation = count('cc-give-remediation');
  if (triage < 0 || remediation < 0) return setStatus('cc-give-status', 'Credits cannot be negative. To take credits back, use Take back.', 'error');
  if (!triage && !remediation) return setStatus('cc-give-status', 'Enter how many AI Triage or AI Remediation credits to give.', 'error');
  await loadGiveProjects().catch(() => null);
  const project = giveProjectOf($('cc-give-project').value);
  if (!project) return setStatus('cc-give-status', 'Choose a project from the list.', 'error');
  // One line per sentence, the project's name on its own: each line is translated as it is.
  if (!confirm(`Give ${triage} AI Triage and ${remediation} AI Remediation credits out of the credit pool to this project?\n${project.projectName}\n\nThey stay with the project until they are used or taken back.`)) return;
  $('cc-give-submit').disabled = true;
  setStatus('cc-give-status', 'Giving…');
  try {
    const result = await api('/api/credits/give', { method: 'POST', body: JSON.stringify({ projectId: project.projectId, triage, remediation }) });
    setStatus('cc-give-status', `Gave ${result.triage} AI Triage and ${result.remediation} AI Remediation credits.`, 'ok');
    logger.add(`Gave ${result.given} credit(s) to ${result.projectName}`, 'success');
    $('cc-give-triage').value = 0;
    $('cc-give-remediation').value = 0;
    if (usage.data) {
      usage.data.allocations = result.allocations;
      usage.data.pool = result.pool;
      $('credits-pool').innerHTML = poolHtml(result.pool);
    }
    renderAllocations(result.allocations);
    creditsChanged();
  } catch (error) {
    if (handleAuthLoss(error)) return;
    setStatus('cc-give-status', error.message, 'error');
  } finally {
    $('cc-give-submit').disabled = false;
  }
}

$('cc-give').addEventListener('submit', (event) => {
  event.preventDefault();
  giveCredits();
});
$('cc-give-project').addEventListener('focus', () => loadGiveProjects().catch((error) => !handleAuthLoss(error) && setStatus('cc-give-status', error.message, 'error')), { once: true });

function exportUsageCsv() {
  const data = usage.data;
  if (!data) return;
  const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = [
    ['Section', 'Period start', 'Project', 'AI Triage', 'AI Remediation', 'Total', 'Requests'],
    ...data.series.map((r) => ['over time', r.start, data.projectId || 'all projects', r.triage, r.remediation, r.credits, r.requests]),
    ...data.byProject.map((p) => ['by project', `${data.from}..${data.to}`, p.projectName || p.projectId, p.triage, p.remediation, p.credits, p.requests]),
    [],
    ['Allocations (all time)', '', 'Project', 'Triage allocated', 'Triage used', 'Remediation allocated', 'Remediation used'],
    ...data.allocations.map((p) => ['allocation', '', p.projectName || p.projectId, p.triage.allocated, p.triage.used, p.remediation.allocated, p.remediation.used]),
  ];
  const blob = new Blob([rows.map((r) => r.map(cell).join(',')).join('\n')], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `credits-${data.from}-to-${data.to}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

$('usage-preset').addEventListener('change', () => {
  const custom = $('usage-preset').value === 'custom';
  $('usage-from-field').hidden = !custom;
  $('usage-to-field').hidden = !custom;
  if (custom && !$('usage-from').value) {
    const { from, to } = usage.data ?? usageRange();
    $('usage-from').value = from;
    $('usage-to').value = to;
  }
  loadUsage();
});
for (const id of ['usage-from', 'usage-to', 'usage-bucket', 'usage-project']) $(id).addEventListener('change', loadUsage);
$('usage-filters').addEventListener('submit', (event) => event.preventDefault());
$('usage-export').addEventListener('click', exportUsageCsv);
$('alloc-search').addEventListener('input', () => renderAllocations(usage.data?.allocations ?? []));
let usageResize = null;
window.addEventListener('resize', () => {
  clearTimeout(usageResize);
  usageResize = setTimeout(() => usage.data && !$('page-credits').hidden && drawUsageChart(usage.data), 150);
});

wireHttps();
wireTerms();

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

wireLayout();
wireLanguageAndProfile();
