// Navigation: which pages a person may open, each feature's stage, the routes (#/page/view) and what each page
// loads, tabs inside a page, the Settings sections, the menu (groups, pins, Focus, the slim bar), the page title,
// the pages that live in files of their own, and the command palette.
import { initCalculator } from '../calculator/page.js';
import { initFaeFlush } from '../fae-flush.js';
import { initStatusBoard } from '../status-board.js';
import { initConsolidated } from '../consolidated.js';
import { initGovern } from '../govern.js';
import { initMobile } from '../mobile.js';
import { SETTINGS_PARTS, navFoldsFrom, navIsFlat, settingsSectionFor } from '../nav-map.js';
import { t } from '../i18n.js';
import { loadImpact, loadPool, loadUsage, usageTimer } from '../app.js';
import { $, can, canAny, state } from './state.js';
import { escapeHtml, fmtDateTime } from './format.js';
import { api, handleAuthLoss, renderLogsPage, setStatus, showError, toast } from './core.js';
import { applyMyAppBranding, closeProfileOf, loadMyBranding, renderProfile } from './profile.js';
import { showTermsOverlay } from './session.js';
import { leaveSettings, renderSettings } from './settings.js';
import { loadActivation, loadHttps, loadTenants, loadUpdates, renderAbout } from './system.js';
import { checkFocus, loadAutomation, loadHandsOff, renderEmailPreview } from './automation.js';
import { openRail, renderRailScope } from './workbench.js';
import { renderColumnMenu, renderProjectsHead } from './projects.js';
import { loadTrackedReports, rpState } from './reports.js';
import { helpRoute, loadHelp } from './help.js';
import { loadFusion, renderBeta, renderBetaScope } from './labs.js';
import { loadUserActivity, renderAudit, reportVisit, userActivity } from './audit.js';
import { loadAccess } from './access.js';

/** Which permissions open each page (any one of them). */
export const PAGE_PERMS = {
  dashboard: '',
  automation: 'settings.view settings.automation',
  reports: 'reports.view',
  credits: 'credits.view',
  impact: 'reports.view',
  audit: 'audit.view backup.view',
  settings: '', // everyone has what is under You, and About & terms of use; the rest needs settings.view
  access: 'iam.view',
  // Labs: each item for the roles holding Labs and its own permission (the server gives feature.<id> to them).
  beta: 'feature.codeAuthors feature.identityMatching',
  fusion: 'feature.fusionResults',
  // Only once its activation code has unlocked it: the server then gives feature.faeFlush to whoever may use it.
  flush: 'feature.faeFlush',
  // Labs, once their activation codes are applied, for the roles holding Labs and the item's permission; the consolidated view
  // only for the people an Admin ticked (People & roles).
  status: 'feature.statusBoard',
  consolidated: 'feature.consolidated',
  // Govern (Labs): once its activation code is applied, for holders of a govern.* permission.
  govern: 'feature.govern',
  logs: '',
  help: '', // everyone may ask for help
  calculator: 'projections.use',
};

/**
 * Show only what this person may use: [data-perm] elements need any one of
 * the listed permissions; [data-edit-perm] panels turn read-only without it.
 */
// ---- Simple by default: fine-tuning most people never need is shown on request ----
const ADVANCED_KEY = 'mz-advanced';
function advancedOn() {
  try {
    return localStorage.getItem(ADVANCED_KEY) === '1';
  } catch {
    return false;
  }
}
function applyAdvanced(on = advancedOn()) {
  document.body.classList.toggle('simple', !on);
  const box = document.getElementById('me-advanced');
  if (box) box.checked = on;
}

/** The version at the bottom left opens Update & recovery for whoever may use it, else About & terms of use. */
function applyVersionLink() {
  const link = $('app-version');
  const update = can('settings.view') && can('system.update');
  link.href = update ? '#/settings/update' : '#/settings/about';
  link.title = update ? 'CxMissionZero version — update & recovery' : 'CxMissionZero version — about and terms of use';
}

export function applyPermissions() {
  for (const el of document.querySelectorAll('[data-perm]')) el.classList.toggle('perm-hidden', !canAny(el.dataset.perm));
  applyVersionLink();
  // Settings: what is under You, and About & terms of use (where the version at the bottom of the menu leads), are
  // everyone's; every other section needs settings.view.
  const settingsToo = can('settings.view');
  for (const el of document.querySelectorAll('#set-nav .set-group:not(.set-you):not(.set-open), #set-nav [data-set]:not([data-set="profile"]):not([data-set="appearance"]):not([data-set="mybrand"]):not([data-set="about"]), #autosave-note')) el.classList.toggle('no-settings', !settingsToo);
  applyMyAppBranding();
  // Settings → Tenants only once a tenants activation code has been applied.
  for (const el of document.querySelectorAll('[data-set="tenants"], #set-tenants')) el.classList.toggle('addon-hidden', !state.me?.unlocked?.tenants);
  // The Cx Credits Calculator: only once its activation code is applied.
  renderFeatureStages();
  // Optional columns can depend on permissions (SLAs).
  try {
    renderColumnMenu();
    renderProjectsHead();
  } catch {
    /* before the table's code has loaded: it renders them itself */
  }
  for (const panel of document.querySelectorAll('[data-edit-perm]')) {
    const editable = canAny(panel.dataset.editPerm);
    panel.classList.toggle('read-only', !editable);
    for (const control of panel.querySelectorAll('input, select, textarea, button')) {
      if (control.dataset.viewOk !== undefined) continue;
      if (!editable) {
        control.dataset.permLocked = '1';
        control.disabled = true;
      } else if (control.dataset.permLocked) {
        delete control.dataset.permLocked;
        control.disabled = false;
      }
    }
    const heading = panel.querySelector('h2');
    heading?.querySelector('.view-only')?.remove();
    if (!editable && heading) {
      const special = /integration\.|credits\.limit/.test(panel.dataset.editPerm);
      heading.insertAdjacentHTML('beforeend', ` <span class="badge ${special ? 'warn' : 'muted'} view-only">${special ? 'Admin only' : 'View only'}</span>`);
    }
  }
}

// ---------------------------------------------------------------------------
// Routing: #/page, or #/page/view for a tab or a Settings section.
// A page keeps what is on it when you go elsewhere and come back — filters,
// tabs, open rows, unsaved role changes, the scroll position. The ↻ button in
// the header reloads one page's data; Refresh in the sidebar starts over.
// ---------------------------------------------------------------------------

const ROUTE_ALIASES = { iam: 'access', 'credit-control': 'credits' };
/**
 * Act → Follow up → Prove, plus Set up: what each page is for, shown as the coloured label beside its title.
 * The menu groups the pages more coarsely (Act, Credits, Set up, Labs: data-group in index.html).
 */
const STAGES = { govern: 'labs', status: 'labs', consolidated: 'labs', flush: 'labs', dashboard: 'act', automation: 'act', beta: 'labs', fusion: 'labs', reports: 'followup', credits: 'prove', impact: 'prove', audit: 'prove', calculator: 'plan', access: 'setup', settings: 'setup', logs: 'setup' };
export const STAGE_LABELS = { act: 'Act', followup: 'Follow up', prove: 'Prove', govern: 'Govern', plan: 'Plan', setup: 'Set up', labs: 'Labs' };
/** The tab group on each page (data-ptabs). */
const PAGE_TABS = { govern: 'govern', consolidated: 'consolidated', flush: 'flush', dashboard: 'dash', automation: 'automation', credits: 'credits', impact: 'impact', audit: 'audit', access: 'access', beta: 'beta', logs: 'logs', calculator: 'calculator' };
export const visitedPages = new Set();
export const scrollMemory = new Map();

export function parseRoute() {
  const [path] = location.hash.replace(/^#\/?/, '').split('?');
  const [raw = '', view = ''] = path.split('/');
  return { name: ROUTE_ALIASES[raw] ?? (raw || 'dashboard'), view: decodeURIComponent(view) };
}

// ---- Beta features, and making them final -----------------------------------

const FEATURE_TABS = { codeAuthors: 'Code authors', identityMatching: 'Match usernames' };

/** Beta labels only on what is still Beta; the sidebar names the page after what it holds. */
export function renderFeatureStages() {
  const stages = state.me?.features ?? {};
  for (const badge of document.querySelectorAll('[data-beta-badge]')) badge.hidden = stages[badge.dataset.betaBadge] === 'final';
  const beta = Object.keys(FEATURE_TABS).filter((id) => stages[id] !== 'final');
  const banner = document.getElementById('beta-banner');
  if (banner) banner.hidden = beta.length === 0;
  if (banner) {
    const names = beta.map((id) => FEATURE_TABS[id]);
    banner.lastChild.textContent = ` ${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} still in Beta: ${names.length === 1 ? 'it reads' : 'they read'} git history and, if connected, the GitHub, GitLab, Azure DevOps and Bitbucket APIs. Check results before relying on them.`;
  }
  // Under Labs in the menu, named after what it holds.
  const name = 'Code authors';
  const label = document.getElementById('nav-beta-label');
  if (label) label.textContent = name;
  PAGE_TITLES.beta[0] = name;
  if (state.page === 'beta') setPageTitle('beta');
  const authorsRow = document.getElementById('auto-authors-row');
  if (authorsRow) authorsRow.hidden = stages.codeAuthors !== 'final';
  // FAE Flush: in Labs while Beta; once final, the first page under Act (FAE Flush, Workbench, Automation, Dashboard).
  const flush = document.getElementById('nav-flush');
  const final = stages.faeFlush === 'final';
  if (flush) {
    placeNavTab(flush, final ? document.querySelector('#nav .nav-group[data-group="act"]') : document.querySelector('#nav > a.tab[data-route="fusion"]'));
    flush.dataset.group = flush.dataset.stage = final ? 'act' : 'labs';
  }
  STAGES.flush = final ? 'act' : 'labs';
  PAGE_TITLES.flush[1] = final ? 'Findings Analysis on the backlog, for every project at once' : 'Labs: Findings Analysis on the backlog, for every project at once';
  if (state.page === 'flush') setPageTitle('flush');
  // Govern: in Labs while Beta; once final, under Credits, after Audit (the label beside its title then says Govern).
  const governTab = document.getElementById('nav-govern');
  const governFinal = stages.govern === 'final';
  if (governTab) {
    placeNavTab(governTab, governFinal ? document.querySelector('#nav > a.tab[data-route="audit"]') : document.getElementById('nav-consolidated'));
    governTab.dataset.group = governFinal ? 'credits' : 'labs';
    governTab.dataset.stage = governFinal ? 'govern' : 'labs';
  }
  STAGES.govern = governFinal ? 'govern' : 'labs';
  PAGE_TITLES.govern[1] = governFinal ? 'Who may use how many AI credits, and what happens at the limit' : 'Labs: who may use how many AI credits, and what happens at the limit';
  if (state.page === 'govern') setPageTitle('govern');
  applyNavGroups();
  applyCalculatorAddress();
}

/** Put a menu item right after another item, or after a group's heading, with its pin (which sits after it). */
function placeNavTab(tab, anchor) {
  if (!anchor) return;
  const pinOf = (el) => (el.matches('a.tab') ? document.querySelector(`#nav > .nav-pin[data-route="${el.dataset.route}"]`) : null);
  const pin = pinOf(tab);
  (pinOf(anchor) ?? anchor).after(tab);
  if (pin) tab.after(pin);
}

/** The calculator's own address, when an Admin turned it on (it then opens there, not in CxMissionZero). */
const calculatorMoved = () => state.me?.calculator?.url ?? '';

/** The menu's Cx Credits Calculator: the built-in page, or its own address in a new tab. */
function applyCalculatorAddress() {
  const url = calculatorMoved();
  const link = document.querySelector('#nav > a.tab[data-route="calculator"]');
  link.href = url || '#/calculator';
  if (url) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = 'Opens at its own address, in a new tab';
  } else {
    link.removeAttribute('target');
    link.removeAttribute('rel');
    link.removeAttribute('title');
  }
  // A pinned copy of the menu item follows it.
  renderNavPins();
  $('calc-moved-open').href = url || '#/calculator';
  $('calc-moved-url').textContent = url;
  if (state.page === 'calculator') {
    $('calc-moved').hidden = !url;
    $('page-calculator').hidden = Boolean(url);
    if (!url) calculator.load({ reopen: false });
  }
}

/** Settings → Beta features: where the calculator opens. The address typed is suggested from this server's own, port 8333. */
function renderCalculatorAddress({ external, url }) {
  $('calc-address-url').value = url;
  $('calc-address-url').placeholder = `http://${location.hostname}:8333/`;
  $('calc-address-on').checked = external;
  const badge = $('calc-address-badge');
  badge.textContent = external ? 'On' : 'Off';
  badge.className = `badge ${external ? 'ok' : 'muted'}`;
}

async function loadFeatures() {
  if (!can('features.manage')) return;
  try {
    renderFeatures(await api('/api/features'));
    renderCalculatorAddress((await api('/api/calculator/address')).calculator);
  } catch (error) {
    if (!handleAuthLoss(error)) showError('feat-status', error);
  }
}

function renderFeatures({ features }) {
  $('feat-list').innerHTML = features
    .map((f) => {
      const final = f.stage === 'final';
      const since = f.changedAt ? ` · since ${new Date(f.changedAt).toLocaleDateString()}${f.changedBy ? ` by ${f.changedBy}` : ''}` : '';
      return `<article class="feat-card ${final ? 'is-final' : ''}">
        <div class="feat-head">
          <h3>${escapeHtml(f.name)} <span class="badge ${final ? 'ok' : 'warn'}">${final ? 'Final' : 'Beta'}</span></h3>
          <button type="button" class="${final ? '' : 'primary'}" data-feature-stage="${escapeHtml(f.id)}" data-to="${final ? 'beta' : 'final'}">${final ? 'Back to Beta' : 'Make final'}</button>
        </div>
        <p>${escapeHtml(f.summary)}</p>
        <p class="hint">${final ? 'Now' : 'Once final'}:</p>
        <ul class="feat-effects">${f.whenFinal.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
        ${!final && f.beforeFinal ? `<p class="feat-caution"><span class="badge warn">Before making it final</span> ${escapeHtml(f.beforeFinal)}</p>` : ''}
        <p class="hint">${final ? 'Final' : 'In Beta'}${escapeHtml(since)}</p>
      </article>`;
    })
    .join('');
}

export function wireAdvancedAndFeatures() {
  applyAdvanced();
  document.getElementById('me-advanced')?.addEventListener('change', (event) => {
    try {
      localStorage.setItem(ADVANCED_KEY, event.target.checked ? '1' : '0');
    } catch {}
    applyAdvanced(event.target.checked);
    if (state.page === 'settings') showSettingsSection(location.hash.split('/')[2] || '');
    toast(event.target.checked ? 'Advanced options shown.' : 'Advanced options hidden: the essentials only.', 'ok', 2500);
  });

  $('calc-address-save').addEventListener('click', async () => {
    setStatus('calc-address-status', 'Saving…');
    try {
      const { calculator: saved } = await api('/api/calculator/address', { method: 'PUT', body: JSON.stringify({ url: $('calc-address-url').value, external: $('calc-address-on').checked }) });
      renderCalculatorAddress(saved);
      state.me = { ...state.me, calculator: saved.external && saved.url && can('projections.use') ? { url: saved.url } : null };
      applyCalculatorAddress();
      setStatus('calc-address-status', saved.external ? 'Saved. Cx Credits Calculator in the menu now opens this address.' : 'Saved. The calculator opens in CxMissionZero.', 'ok');
    } catch (error) {
      if (!handleAuthLoss(error)) showError('calc-address-status', error);
    }
  });

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-feature-stage]');
    if (!button) return;
    const to = button.dataset.to;
    const name = button.closest('.feat-card')?.querySelector('h3')?.firstChild?.textContent?.trim() ?? 'this feature';
    if (!confirm(to === 'final' ? `Make “${name}” final for everyone in your organisation?` : `Put “${name}” back in Beta? Only the roles holding its Beta or Labs permission keep access to it.`)) return;
    button.disabled = true;
    setStatus('feat-status', 'Saving…');
    try {
      renderFeatures(await api(`/api/features/${encodeURIComponent(button.dataset.featureStage)}`, { method: 'PUT', body: JSON.stringify({ stage: to }) }));
      state.me = await api('/api/me');
      applyPermissions();
      setStatus('feat-status', to === 'final' ? `“${name}” is final.` : `“${name}” is back in Beta.`, 'ok');
    } catch (error) {
      button.disabled = false;
      if (!handleAuthLoss(error)) showError('feat-status', error);
    }
  });
}

const reloadSettingsPage = () => {
  renderProfile();
  loadMyBranding();
  loadHandsOff();
  renderAbout();
  if (!can('settings.view')) return;
  loadFeatures();
  loadActivation();
  loadTenants();
  renderSettings();
  loadAutomation();
  loadPool();
  loadHttps();
  loadUpdates();
};

/**
 * A page's data, loaded the first time it opens (and by ↻). The Workbench
 * loads nothing by itself: what was fetched is restored from the server, and
 * reading Checkmarx One again only ever starts from a click (Load findings, or ↻).
 */
const PAGE_LOADERS = {
  dashboard: () => {},
  automation: () => loadAutomation(),
  settings: reloadSettingsPage,
  credits: () => loadUsage(),
  impact: () => loadImpact(),
  logs: () => renderLogsPage(),
  reports: () => loadTrackedReports(),
  beta: () => renderBeta(),
  fusion: () => loadFusion(),
  flush: () => faeFlush.load(),
  status: () => statusBoard.load(),
  consolidated: () => consolidatedView.load(),
  govern: () => governPage.load(),
  audit: () => renderAudit(),
  access: () => loadAccess(),
  help: () => loadHelp(),
  calculator: () => calculatorMoved() || calculator.load(),
};

/**
 * Coming back to a page: only refreshes that cannot lose anything in progress.
 * Settings shows what is saved (every edit there saves as it is typed); the
 * The Dashboard (tracked reports) keeps the open report, its tab and its form; charts redraw.
 */
/** ↻ where it does more than the first visit: on the Workbench, read the findings again with the scope shown. */
const PAGE_RELOAD = {
  dashboard: () => {
    if (state.projects.length && !$('fetch').disabled && can('findings.fetch')) $('fetch').click();
  },
};
const reloaderOf = (page) => PAGE_RELOAD[page] ?? PAGE_LOADERS[page];

const PAGE_RETURN = {
  flush: () => faeFlush.load({ quiet: true }),
  status: () => statusBoard.load({ quiet: true }),
  consolidated: () => consolidatedView.load({ quiet: true }),
  govern: () => governPage.load({ quiet: true }),
  automation: () => loadAutomation(),
  settings: reloadSettingsPage,
  credits: () => loadUsage(),
  impact: () => loadImpact(),
  logs: () => renderLogsPage(),
  reports: () => loadTrackedReports(),
  beta: () => renderBetaScope(),
  fusion: () => loadFusion(),
  help: () => loadHelp(),
  calculator: () => calculatorMoved() || calculator.load({ reopen: false }),
};

export function route() {
  if (!state.me) return;
  // Automation moved from Settings to Act: an old link or bookmark still gets there.
  if (location.hash === '#/settings/automation') history.replaceState(null, '', '#/automation');
  const { name, view } = parseRoute();
  const allowed = (page) => page in PAGE_PERMS && (!PAGE_PERMS[page] || canAny(PAGE_PERMS[page]));
  const target = allowed(name) ? name : 'dashboard';
  if (target !== name && location.hash) history.replaceState(null, '', '#/dashboard');

  const previous = state.page;
  if (previous && previous !== target) scrollMemory.set(previous, window.scrollY);
  for (const page of Object.keys(PAGE_PERMS)) $(`page-${page}`).hidden = page !== target;
  // The calculator at an address of its own: its page says where it went, the built-in one stays put away.
  $('calc-moved').hidden = !(target === 'calculator' && calculatorMoved());
  if (target === 'calculator' && calculatorMoved()) $('page-calculator').hidden = true;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.route === target);
    if (tab.dataset.route === target) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  applyNavFolds();
  setPageTitle(target);
  state.page = target;
  // A panel that stops the page scrolling belongs to its own page: the lock never follows you to another
  // (e.g. "Give credits on the Workbench" from an open report). Coming back, its page's panel locks again.
  document.body.classList.toggle('rp-locked', target === 'reports' && Boolean(rpState.open));
  const dashboardSheet = target === 'dashboard' && (!$('preview-panel').hidden || Boolean(document.querySelector('.wb.rail-open')));
  document.body.classList.toggle('sheet-open', dashboardSheet);
  document.body.dataset.stage = STAGES[target] ?? '';
  $('page-reload').hidden = !reloaderOf(target);
  if (target !== 'settings' || (view && view !== 'profile')) closeProfileOf();
  if (target === 'settings') showSettingsSection(view);
  if (target === 'help') helpRoute(view);
  else if (view && PAGE_TABS[target]) activateTab(PAGE_TABS[target], view, { remember: true });
  if (previous === target) return;
  reportVisit(PAGE_TITLES[target]?.[0] ?? target);

  // Leaving Settings: what was typed is saved; connections that do not work go back to the last known good ones.
  if (previous === 'settings') leaveSettings();
  if (target !== 'credits') clearTimeout(usageTimer);
  const first = !visitedPages.has(target);
  visitedPages.add(target);
  if (first) PAGE_LOADERS[target]?.();
  else PAGE_RETURN[target]?.();
  const top = first || !scrollMemory.has(target) ? 0 : scrollMemory.get(target);
  requestAnimationFrame(() => window.scrollTo({ top, behavior: 'instant' }));
}

// ---- Tabs inside a page (data-ptabs / data-pt / data-ptpanel) ---------------

const TAB_KEY = 'mz-tabs';
/** Refresh (sidebar) reloads with this flag: everything opens as new, nothing is restored. */
export const freshStart = (() => {
  try {
    const fresh = sessionStorage.getItem('mz-fresh') === '1';
    sessionStorage.removeItem('mz-fresh');
    if (fresh) for (const key of [TAB_KEY, 'mz-settings-section']) localStorage.removeItem(key);
    return fresh;
  } catch {
    return false;
  }
})();
export const tabMemory = (() => {
  try {
    return JSON.parse(localStorage.getItem(TAB_KEY) || '{}') ?? {};
  } catch {
    return {};
  }
})();

const tabsOf = (group) => [...document.querySelectorAll(`[data-ptabs="${group}"] [data-pt]`)];
const usableTab = (tab) => !tab.classList.contains('perm-hidden') && !tab.hidden;

/** Show one tab of a group; `remember` keeps it for the next visit (this browser). */
export function activateTab(group, name, { remember = true, focus = false } = {}) {
  const tabs = tabsOf(group);
  const usable = tabs.filter(usableTab);
  const tab = usable.find((t) => t.dataset.pt === name) ?? usable.find((t) => t.dataset.pt === tabMemory[group]) ?? usable[0];
  if (!tab) return;
  for (const t of tabs) {
    const on = t === tab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  }
  for (const panel of document.querySelectorAll(`[data-ptpanel^="${group}:"]`)) panel.hidden = panel.dataset.ptpanel !== `${group}:${tab.dataset.pt}`;
  if (focus) tab.focus();
  if (remember && tabMemory[group] !== tab.dataset.pt) {
    tabMemory[group] = tab.dataset.pt;
    try {
      localStorage.setItem(TAB_KEY, JSON.stringify(tabMemory));
    } catch {}
  }
  onTabShown(group, tab.dataset.pt);
}

/** Tabs whose content draws on demand. */
function onTabShown(group, name) {
  if (group === 'dash') renderRailScope();
  if (group === 'govern' && state.page === 'govern') governPage.tabShown(name);
  if (group === 'logs' && name === 'people' && state.page === 'logs') loadUserActivity({ offset: userActivity.offset });
  if (group === 'automation' && state.automation) {
    if (name === 'email' && can('settings.automation')) renderEmailPreview();
    if (name === 'focus' && can('settings.automation') && !$('auto-focus-match').textContent) checkFocus();
  }
}

export function initTabs() {
  for (const bar of document.querySelectorAll('[data-ptabs]')) activateTab(bar.dataset.ptabs, tabMemory[bar.dataset.ptabs], { remember: false });
}

// ---- Settings: one section at a time, chosen on the left --------------------

const SETTINGS_KEY = 'mz-settings-section';

function showSettingsSection(id) {
  const links = [...document.querySelectorAll('#set-nav [data-set]')];
  const usable = links.filter((a) => !a.classList.contains('perm-hidden') && !a.classList.contains('no-settings') && !a.classList.contains('addon-hidden') && !(a.hasAttribute('data-advanced') && document.body.classList.contains('simple')));
  let saved = '';
  try {
    saved = localStorage.getItem(SETTINGS_KEY) || '';
  } catch {}
  // A section that became a part of another one (Risks endpoint, Links into Checkmarx One): its old address and
  // the name a browser kept open the section that holds it now.
  const wanted = settingsSectionFor(id);
  const link = usable.find((a) => a.dataset.set === wanted) ?? usable.find((a) => a.dataset.set === settingsSectionFor(saved)) ?? usable.find((a) => a.dataset.set === 'connection') ?? usable[0];
  if (!link) return;
  for (const a of links) {
    const on = a === link;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'true');
    else a.removeAttribute('aria-current');
  }
  for (const section of document.querySelectorAll('#set-content > section.panel[id^="set-"]')) section.classList.toggle('set-off', section.id !== `set-${link.dataset.set}`);
  try {
    localStorage.setItem(SETTINGS_KEY, link.dataset.set);
  } catch {}
  if (id && id !== link.dataset.set) history.replaceState(null, '', `#/settings/${link.dataset.set}`);
  if (state.page === 'settings' && id) window.scrollTo({ top: 0, behavior: 'instant' });
  // Asked for by its old address: the part is opened and, once the page has settled, brought into view
  // (it shows with "Show advanced options" on, as its section did).
  const part = id in SETTINGS_PARTS && link.dataset.set === wanted ? $(`set-part-${id}`) : null;
  if (part) {
    part.open = true;
    requestAnimationFrame(() => requestAnimationFrame(() => part.offsetParent && part.scrollIntoView({ block: 'start' })));
  }
}

// ---------------------------------------------------------------------------
// The menu's groups (Act, Credits, Set up, Labs: data-group) fold and unfold with a click on their name;
// the choice is kept in this browser, and the page open is always shown. Somebody with only a few pages
// has one flat list with no headings, where nothing folds (applyNavGroups).
// ---------------------------------------------------------------------------

const NAV_FOLDS_KEY = 'mz-nav-folded';
/** The folded groups; names kept from before the groups were merged are read as today's (public/nav-map.js). */
function navFolds() {
  try {
    return navFoldsFrom(JSON.parse(localStorage.getItem(NAV_FOLDS_KEY) || '[]'));
  } catch {
    return new Set();
  }
}
function applyNavFolds() {
  const folded = navFolds();
  const flat = $('nav').classList.contains('nav-flat');
  for (const group of document.querySelectorAll('#nav .nav-group')) {
    // In a flat list only the pinned pages still have a heading to fold.
    const open = !folded.has(group.dataset.group) || (flat && group.dataset.group !== 'pinned');
    group.setAttribute('aria-expanded', String(open));
    for (const tab of document.querySelectorAll(`#nav .tab[data-group="${group.dataset.group}"]`)) {
      tab.classList.toggle('nav-folded', !open && !tab.classList.contains('active'));
    }
  }
}
/**
 * The headings follow what is under them: a group with no page this person may open has no heading, and
 * somebody with seven pages or fewer in their menu gets one flat list with no headings at all.
 */
function applyNavGroups() {
  const nav = $('nav');
  const shown = navTabs().filter((tab) => !tab.classList.contains('perm-hidden'));
  const flat = navIsFlat(shown.length);
  nav.classList.toggle('nav-flat', flat);
  for (const group of nav.querySelectorAll(':scope > .nav-group:not(.nav-pinned-head)')) {
    group.hidden = flat || !shown.some((tab) => tab.dataset.group === group.dataset.group);
  }
  $('nav-fold-all').hidden = flat;
  applyNavFolds();
}
function toggleNavGroup(group) {
  const folded = navFolds();
  if (folded.has(group.dataset.group)) folded.delete(group.dataset.group);
  else folded.add(group.dataset.group);
  try {
    localStorage.setItem(NAV_FOLDS_KEY, JSON.stringify([...folded]));
  } catch {}
  applyNavFolds();
}

// ---------------------------------------------------------------------------
// Pinned pages sit at the top of the menu, and Focus shows only them (with the page open). Both are kept
// in this browser, like the folds. Every group can be folded or unfolded at once.
// ---------------------------------------------------------------------------

const NAV_PINS_KEY = 'mz-nav-pins';
const NAV_FOCUS_KEY = 'mz-nav-focus';
const PIN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l-1 6 4 4H6l4-4z" /><path d="M12 13v8" /></svg>';
const navTabs = () => [...document.querySelectorAll('#nav > a.tab[data-route]')];
function navPins() {
  try {
    const list = JSON.parse(localStorage.getItem(NAV_PINS_KEY) || '[]');
    const routes = new Set(navTabs().map((t) => t.dataset.route));
    return Array.isArray(list) ? list.filter((r) => typeof r === 'string' && routes.has(r)) : [];
  } catch {
    return [];
  }
}
function navFocus() {
  try {
    return localStorage.getItem(NAV_FOCUS_KEY) === '1';
  } catch {
    return false;
  }
}
function renderNavPins() {
  const pins = navPins();
  const shelf = $('nav-pinned');
  shelf.replaceChildren(
    ...pins.map((route) => {
      const copy = document.querySelector(`#nav > a.tab[data-route="${route}"]`).cloneNode(true);
      copy.dataset.group = copy.dataset.stage = 'pinned';
      copy.classList.add('tab-pinned');
      copy.classList.remove('nav-folded');
      copy.removeAttribute('id');
      for (const el of copy.querySelectorAll('[id]')) el.removeAttribute('id');
      return copy;
    }),
  );
  document.querySelector('#nav .nav-pinned-head').hidden = !pins.length;
  for (const tab of navTabs()) tab.classList.toggle('is-pinned', pins.includes(tab.dataset.route));
  for (const button of document.querySelectorAll('#nav .nav-pin')) {
    const on = pins.includes(button.dataset.route);
    button.setAttribute('aria-pressed', String(on));
    button.title = on ? 'Unpin from the top of the menu' : 'Pin to the top of the menu';
    button.setAttribute('aria-label', button.title);
  }
  const focus = navFocus();
  if (focus) document.documentElement.dataset.navFocus = '';
  else delete document.documentElement.dataset.navFocus;
  $('nav-focus').setAttribute('aria-pressed', String(focus));
  $('nav-focus').title = focus ? 'Show every page' : 'Show only your pinned pages';
  $('nav-pinned-empty').hidden = !(focus && !pins.length);
  const folded = navFolds();
  const allFolded = [...document.querySelectorAll('#nav .nav-group:not([hidden])')].every((g) => folded.has(g.dataset.group));
  $('nav-fold-all').title = allFolded ? 'Unfold every group' : 'Fold every group';
  $('nav-fold-all').setAttribute('aria-label', $('nav-fold-all').title);
  $('nav-fold-all').classList.toggle('is-folded', allFolded);
  if (state.page) for (const tab of shelf.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.route === state.page);
}

export function wireMenuAndTabs() {
  $('page-reload').addEventListener('click', () => {
    const load = reloaderOf(state.page);
    if (!load) return;
    const icon = $('page-reload');
    icon.classList.remove('spin');
    void icon.offsetWidth;
    icon.classList.add('spin');
    load();
    if (state.page !== 'dashboard') toast(`${PAGE_TITLES[state.page]?.[0] ?? 'Page'}: data reloaded. Your filters and tabs are kept.`, 'ok', 2500);
  });

  $('me-refresh').addEventListener('click', () => $('app-refresh').click());
  $('app-refresh').addEventListener('click', () => {
    if (!confirm('Start over?\n\nCxMissionZero reloads and every page goes back to how it opens: fetched data, filters, selections and anything not yet saved are cleared. Saved settings, reports and credits are not affected.')) return;
    try {
      sessionStorage.setItem('mz-fresh', '1');
    } catch {}
    history.replaceState(null, '', `#/${state.page || 'dashboard'}`);
    location.reload();
  });

  document.addEventListener('click', (event) => {
    const tab = event.target.closest?.('[data-ptabs] [data-pt]');
    if (!tab) return;
    const group = tab.closest('[data-ptabs]').dataset.ptabs;
    activateTab(group, tab.dataset.pt);
    const owner = Object.keys(PAGE_TABS).find((p) => PAGE_TABS[p] === group);
    reportVisit(`${PAGE_TITLES[owner]?.[0] ?? owner ?? group} › ${tab.dataset.pt}`);
    // The address follows the tab, so a reload or a shared link opens it.
    const page = Object.keys(PAGE_TABS).find((p) => PAGE_TABS[p] === group);
    if (page && page === state.page && page !== 'dashboard') history.replaceState(null, '', `#/${page}/${tab.dataset.pt}`);
  });
  document.addEventListener('keydown', (event) => {
    const tab = event.target.closest?.('[data-ptabs] [data-pt]');
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const group = tab.closest('[data-ptabs]').dataset.ptabs;
    const usable = tabsOf(group).filter(usableTab);
    const i = usable.indexOf(tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? usable.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + usable.length) % usable.length;
    event.preventDefault();
    usable[next].click();
    usable[next].focus();
  });

  // A drop-down menu that would run past the window's edge opens the other way, so it is never cut
  // off and the page never scrolls sideways (the engines menu at a narrow width).
  document.addEventListener('toggle', (event) => {
    const menu = event.target.matches?.('details.col-picker') && event.target.open && event.target.querySelector(':scope > .col-menu');
    if (!menu || getComputedStyle(menu).position === 'fixed') return;
    menu.classList.remove('to-start', 'to-end');
    const r = menu.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    if (r.right > width - 8) menu.classList.add('to-end'); // right edge to the button's right edge
    else if (r.left < 8) menu.classList.add('to-start'); // left edge to the button's left edge
  }, true);
  for (const group of document.querySelectorAll('#nav .nav-group')) {
    group.setAttribute('role', 'button');
    group.tabIndex = 0;
    group.addEventListener('click', () => toggleNavGroup(group));
    group.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggleNavGroup(group);
    });
  }
  applyNavFolds();
  for (const tab of navTabs()) {
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'nav-pin';
    pin.dataset.route = tab.dataset.route;
    if (tab.dataset.perm) pin.dataset.perm = tab.dataset.perm;
    pin.innerHTML = PIN_ICON;
    tab.after(pin);
    pin.addEventListener('click', () => {
      const pins = navPins();
      const next = pins.includes(tab.dataset.route) ? pins.filter((r) => r !== tab.dataset.route) : [...pins, tab.dataset.route];
      try {
        localStorage.setItem(NAV_PINS_KEY, JSON.stringify(next));
      } catch {}
      renderNavPins();
      applyNavFolds();
    });
  }
  $('nav-focus').addEventListener('click', () => {
    try {
      localStorage.setItem(NAV_FOCUS_KEY, navFocus() ? '0' : '1');
    } catch {}
    renderNavPins();
  });
  $('nav-fold-all').addEventListener('click', () => {
    const groups = [...document.querySelectorAll('#nav .nav-group:not([hidden])')].map((g) => g.dataset.group);
    const folded = navFolds();
    const fold = !groups.every((s) => folded.has(s));
    try {
      localStorage.setItem(NAV_FOLDS_KEY, JSON.stringify(fold ? groups : []));
    } catch {}
    applyNavFolds();
    renderNavPins();
  });
  for (const group of document.querySelectorAll('#nav .nav-group')) group.addEventListener('click', () => renderNavPins());
  renderNavPins();
  // Phones: four pages in the bar, the rest (and the top bar's controls) in the More sheet.
  initMobile();
}

const PAGE_TITLES = {
  connect: ['Sign in', 'Act on findings, follow them up, prove every credit'],
  dashboard: ['Workbench', 'Find ageing findings and fix them'],
  automation: ['Automation', 'Reminders and everything else that runs by itself'],
  reports: ['Dashboard', 'Follow every tracked scope to zero'],
  credits: ['Credit Control', 'Credits given, used and left'],
  impact: ['Impact', 'What AI saved and cleared'],
  settings: ['Settings', 'Saved as you type'],
  logs: ['Logs', 'Activity and troubleshooting'],
  access: ['People & roles', 'Who can sign in, and what they may do'],
  audit: ['Audit', 'Every credit spent, refused or failed'],
  beta: ['Code authors', 'Labs: who wrote the code, and their email'],
  fusion: ['Fusion results', 'Labs: only what the AI engine reported, Fusion and LAST'],
  flush: ['FAE Flush', 'Labs: Findings Analysis on the backlog, for every project at once'],
  status: ['Status board', 'Labs: every project\'s last scan and results at a glance'],
  consolidated: ['Consolidated view', 'Labs: every connected tenant in one place, read only'],
  govern: ['Govern', 'Labs: who may use how many AI credits, and what happens at the limit'],
  help: ['Get help', 'Support cases and enhancements'],
  calculator: ['Cx Credits Calculator', 'The credits a customer needs'],
};

export function setPageTitle(page) {
  const [title, sub] = PAGE_TITLES[page] ?? PAGE_TITLES.dashboard;
  $('page-title').textContent = title;
  $('page-sub').textContent = sub;
  const stage = STAGES[page];
  $('page-stage').hidden = !stage;
  if (stage) {
    $('page-stage').textContent = STAGE_LABELS[stage];
    $('page-stage').dataset.stage = stage;
  }
}

// ---- Cx Credits Calculator (public/calculator/page.js) ----
let faeFlush; // set by wirePagesAndPalette(), when the page loads
let statusBoard; // set by wirePagesAndPalette(), when the page loads
let consolidatedView; // set by wirePagesAndPalette(), when the page loads
let governPage; // set by wirePagesAndPalette(), when the page loads
export let calculator; // set by wirePagesAndPalette(), when the page loads

/** A page outside the four stages: Get help, or a tool. */
const paletteGroup = (page) => STAGE_LABELS[STAGES[page]] ?? (page === 'help' ? 'Help' : 'Tools');

function paletteEntries() {
  const entries = [];
  const pageOk = (page) => !PAGE_PERMS[page] || canAny(PAGE_PERMS[page]);
  for (const [page, [title, sub]] of Object.entries(PAGE_TITLES)) {
    if (page === 'connect' || !pageOk(page)) continue;
    entries.push({ label: title, hint: sub, group: paletteGroup(page), stage: STAGES[page], href: `#/${page}` });
  }
  for (const bar of document.querySelectorAll('[data-ptabs]')) {
    const page = Object.keys(PAGE_TABS).find((p) => PAGE_TABS[p] === bar.dataset.ptabs);
    if (!page || !pageOk(page)) continue;
    for (const tab of tabsOf(bar.dataset.ptabs).filter(usableTab)) {
      const label = tab.childNodes[0]?.textContent.trim() || tab.textContent.trim();
      entries.push({ label: `${PAGE_TITLES[page][0]} → ${label}`, group: paletteGroup(page), stage: STAGES[page], href: page === 'dashboard' ? null : `#/${page}/${tab.dataset.pt}`, tab: page === 'dashboard' ? tab.dataset.pt : null });
    }
  }
  if (pageOk('settings')) {
    for (const a of document.querySelectorAll('#set-nav [data-set]')) {
      if (a.classList.contains('perm-hidden') || a.classList.contains('no-settings') || a.classList.contains('addon-hidden')) continue;
      entries.push({ label: `Settings → ${a.textContent.trim()}`, group: STAGE_LABELS.setup, stage: 'setup', href: a.getAttribute('href') });
      // The parts that were sections of their own are still found by name.
      for (const [part, host] of Object.entries(SETTINGS_PARTS)) {
        if (host === a.dataset.set) entries.push({ label: `Settings → ${$(`set-part-${part}`).querySelector('summary').textContent.trim()}`, group: STAGE_LABELS.setup, stage: 'setup', href: `#/settings/${part}` });
      }
    }
  }
  if (can('findings.fetch')) entries.push({ label: 'Load findings', group: 'Action', run: () => $('fetch').click() });
  entries.push({ label: 'Submit a support case', group: 'Help', href: '#/help/case' });
  entries.push({ label: 'Request an enhancement', group: 'Help', href: '#/help/enhancement' });
  entries.push({ label: 'Switch theme', group: 'Action', run: () => $('theme-toggle').click() });
  entries.push({ label: 'Read the terms of use', group: 'Action', run: () => showTermsOverlay({ mode: 'view' }) });
  entries.push({ label: 'Refresh — start over', group: 'Action', run: () => $('app-refresh').click() });
  return entries;
}

const palette = { entries: [], shown: [], index: 0 };

function openPalette() {
  if (!state.me) return;
  palette.entries = paletteEntries();
  $('palette-q').value = '';
  renderPalette();
  $('palette').showModal();
  $('palette-q').focus();
}

function renderPalette() {
  const q = $('palette-q').value.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  palette.shown = palette.entries.filter((e) => words.every((w) => `${e.label} ${e.hint ?? ''} ${e.group}`.toLowerCase().includes(w))).slice(0, 40);
  palette.index = Math.min(palette.index, Math.max(0, palette.shown.length - 1));
  if (!q) palette.index = 0;
  $('palette-list').innerHTML = palette.shown.length
    ? palette.shown
        .map((e, i) => `<li role="option" id="pal-${i}" aria-selected="${i === palette.index}" data-pal="${i}" class="${i === palette.index ? 'on' : ''}"><span class="pal-label">${escapeHtml(e.label)}</span><span class="pal-group" data-stage="${escapeHtml(e.stage || '')}" data-i18n-ctx="stage">${escapeHtml(e.group || '')}</span></li>`)
        .join('')
    : '<li class="pal-none">Nothing matches.</li>';
  $('palette-q').setAttribute('aria-activedescendant', palette.shown.length ? `pal-${palette.index}` : '');
  $(`pal-${palette.index}`)?.scrollIntoView({ block: 'nearest' });
}

function runPalette(i) {
  const entry = palette.shown[i];
  if (!entry) return;
  $('palette').close();
  if (entry.run) return entry.run();
  if (entry.tab) {
    if (state.page !== 'dashboard') location.hash = '#/dashboard';
    openRail(entry.tab);
    return;
  }
  if (location.hash === entry.href) route();
  else location.hash = entry.href;
}

export function wirePagesAndPalette() {
  faeFlush = initFaeFlush({ api, $, esc: escapeHtml, toast, showError, setStatus, can, fmtDateTime, t });
  statusBoard = initStatusBoard({ api, $, toast, showError, setStatus, fmtDateTime });
  consolidatedView = initConsolidated({ api, $, toast, showError, setStatus, fmtDateTime });
  governPage = initGovern({ api, $, toast, showError, setStatus, fmtDateTime, t, handleAuthLoss, me: () => state.me?.user, active: () => state.page === 'govern' });
  calculator = initCalculator({ api, $, esc: escapeHtml, toast, setStatus, showError, handleAuthLoss, fmtDateTime, me: () => state.me, can, impactOn: () => Boolean(state.me?.unlocked?.impact) });

  $('palette-open').addEventListener('click', openPalette);
  $('palette-q').addEventListener('input', () => {
    palette.index = 0;
    renderPalette();
  });
  $('palette-q').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const n = palette.shown.length;
      if (n) palette.index = (palette.index + (event.key === 'ArrowDown' ? 1 : -1) + n) % n;
      renderPalette();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runPalette(palette.index);
    }
  });
  $('palette-list').addEventListener('click', (event) => {
    const item = event.target.closest('[data-pal]');
    if (item) runPalette(Number(item.dataset.pal));
  });
  $('palette').addEventListener('click', (event) => {
    if (event.target === $('palette')) $('palette').close();
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && state.me) {
      event.preventDefault();
      if ($('palette').open) $('palette').close();
      else openPalette();
    }
  });
}

// ---------------------------------------------------------------------------
// Layout: the menu (kept open, or a slim bar of icons that opens when pointed at) and the
// Workbench's top block, which stays in view while the projects scroll with the page.
// ---------------------------------------------------------------------------

const sidebarMode = () => (document.documentElement.dataset.sidebar === 'auto' ? 'auto' : 'pinned');
function applySidebarMode(mode) {
  const auto = mode === 'auto';
  if (auto) document.documentElement.dataset.sidebar = 'auto';
  else delete document.documentElement.dataset.sidebar;
  document.querySelector('.sidebar')?.classList.remove('open');
  const pin = $('sidebar-pin');
  pin.setAttribute('aria-pressed', String(!auto));
  pin.title = auto ? 'Keep the menu open beside the page' : 'Hide the menu: it becomes a slim bar of icons and opens when you point at it';
  pin.setAttribute('aria-label', pin.title);
  $('sidebar-pin-label').textContent = auto ? 'Keep menu open' : 'Hide menu';
  try {
    localStorage.setItem('mz-sidebar', mode);
  } catch {}
}

export function wireLayout() {
  applySidebarMode(sidebarMode());
  $('sidebar-pin').addEventListener('click', () => applySidebarMode(sidebarMode() === 'auto' ? 'pinned' : 'auto'));

  // Pointing at the slim bar opens the menu over the page (nothing beside it moves); a short
  // pause on the way in and out keeps it from flickering when the pointer only passes by.
  {
    const bar = document.querySelector('.sidebar');
    let timer = null;
    const set = (open, delay) => {
      clearTimeout(timer);
      timer = setTimeout(() => bar.classList.toggle('open', open && sidebarMode() === 'auto'), delay);
    };
    bar.addEventListener('mouseenter', () => set(true, 120));
    bar.addEventListener('mouseleave', () => set(false, 260));
    bar.addEventListener('focusin', () => set(true, 0));
    bar.addEventListener('focusout', (event) => {
      if (!bar.contains(event.relatedTarget)) set(false, 0);
    });
    // Choosing a page closes it again.
    bar.addEventListener('click', (event) => {
      if (event.target.closest('a.tab')) set(false, 0);
    });
  }

  // The top block's height, for what sits below it (the action rail, the table's header row).
  if (window.ResizeObserver) {
    const top = $('dash-top');
    let last = '';
    // Written only when it changes: a style change on the root restyles the whole page.
    const measure = () => {
      const value = `${Math.round(top.getBoundingClientRect().height)}px`;
      if (value === last || !top.offsetParent) return;
      last = value;
      document.documentElement.style.setProperty('--dash-top-h', value);
    };
    new ResizeObserver(measure).observe(top);
    measure();
  }

  // While the page scrolls, rows passing under the pointer do not repaint their hover highlight.
  {
    let scrollIdle = null;
    window.addEventListener('scroll', () => {
      if (!document.body.classList.contains('scrolling')) document.body.classList.add('scrolling');
      clearTimeout(scrollIdle);
      scrollIdle = setTimeout(() => document.body.classList.remove('scrolling'), 150);
    }, { passive: true });
  }
}
