// The Workbench: what to load (ages, engines, branches, named projects and people), loading it, the journey,
// the action rail and getting started.
import { DEFAULT_ENGINES, ENGINES, cleanEngines, describeEngines } from '../engines.js';
import { access } from '../app.js';
import { $, can, state } from './state.js';
import { escapeHtml } from './format.js';
import { api, flare, handleAuthLoss, logger, setStatus, showError } from './core.js';
import { STAGE_LABELS, activateTab } from './nav.js';
import { collectInitiators, fusion, renderInitiatorList, renderProjects, visibleProjects } from './projects.js';
import { renderAllocation, renderTotals } from './actions.js';
import { dialTicks } from './reports.js';
import { loadFusion, renderFusion } from './labs.js';

// ---------------------------------------------------------------------------
// Workbench: scope
// ---------------------------------------------------------------------------

export function fillPresets(selectId, defaultId) {
  $(selectId).innerHTML = (state.health?.windowPresets ?? [])
    .map((p) => `<option value="${p.id}"${p.id === defaultId ? ' selected' : ''}>${escapeHtml(p.label)}</option>`)
    .join('');
}

function toggleRange(prefix) {
  $(`${prefix}-range`).hidden = $(`${prefix}-preset`).value !== 'custom';
  updateScopeSummary();
}

export function windowParams() {
  const params = new URLSearchParams();
  // Named projects (by id) and people: only these are fetched.
  for (const id of scopePick.applications.keys()) params.append('application', id);
  for (const id of scopePick.projects.keys()) params.append('project', id);
  for (const who of scopePick.initiators) params.append('initiator', who);
  if (state.vulnerability) params.set('vulnerability', state.vulnerability);
  params.set('engines', [...enginePick].join(','));
  // Each project's primary branch unless every branch is ticked; projects with nothing to analyse left out as chosen.
  if (focusPick.allBranches) params.set('branches', 'all');
  if (!focusPick.leaveOutNoCode) params.set('zeroLoc', 'keep');
  if (focusPick.leaveOutNoFindings) params.set('noFindings', 'leave-out');
  for (const prefix of ['activity', 'detection']) {
    const preset = $(`${prefix}-preset`).value;
    params.set(`${prefix}Preset`, preset);
    if (preset === 'custom') {
      if ($(`${prefix}-from`).value) params.set(`${prefix}From`, $(`${prefix}-from`).value);
      if ($(`${prefix}-to`).value) params.set(`${prefix}To`, $(`${prefix}-to`).value);
    }
  }
  return params;
}

const presetLabel = (id) => state.health?.windowPresets.find((p) => p.id === id)?.label ?? id;

/**
 * "Findings open for": the one question about time on the Workbench. Any age; open for more than so many days
 * (the server's age presets); or new in the last week or month. The ids are the server's window presets.
 */
export function fillAgePresets(defaultId = 'any') {
  const options = [
    { id: 'any', label: 'Any age' },
    ...(state.health?.agePresets ?? []),
    { id: '7d', label: 'New this week' },
    { id: '30d', label: 'New this month' },
    { id: 'custom', label: 'Custom dates…' },
  ];
  $('detection-preset').innerHTML = options.map((p) => `<option value="${escapeHtml(p.id)}"${p.id === defaultId ? ' selected' : ''}>${escapeHtml(p.label)}</option>`).join('');
}
const ageLabel = () => $('detection-preset').selectedOptions[0]?.textContent ?? '';
/** What the choice loads, in a sentence (the control's tooltip). */
function ageHint(id) {
  if (id === 'any') return 'Every open finding, whatever its age.';
  if (id === '7d' || id === '30d') return `Only findings first found in the last ${id === '7d' ? '7' : '30'} days: older ones are not loaded.`;
  if (id === 'custom') return 'Only findings first found between these dates.';
  if (/^gt\d+$/.test(id)) return `Only findings first found more than ${id.slice(2)} days ago and still open.`;
  return 'Only findings first found in this time are loaded.';
}

export function updateScopeSummary() {
  const detection = $('detection-preset').value;
  const named = scopeNamed();
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const projectsPart = named
    ? [
        scopePick.applications.size && plural(scopePick.applications.size, 'application'),
        scopePick.projects.size && plural(scopePick.projects.size, 'named project'),
        scopePick.initiators.size && `${scopePick.initiators.size === 1 ? '1 person' : `${scopePick.initiators.size} people`}'s projects`,
      ].filter(Boolean).join(' + ')
    : presetLabel($('activity-preset').value);
  $('scope-summary').textContent = `Projects: ${projectsPart} · Findings: ${ageLabel()}`;
  // Naming projects or people replaces the "last scanned in" window.
  $('activity-preset').disabled = Boolean(named);
  $('activity-preset').title = named ? 'Named applications, projects and people are fetched whatever their last scan date.' : '';
  $('activity-hint').textContent = named
    ? 'Not used while applications, projects or people are named below: those are fetched whatever their last scan date.'
    : 'Skips projects with no scan in this window.';

  $('detection-hint').textContent = ageHint(detection);
  // The compact scope row shows these as the choices' tooltips.
  if (!named) $('activity-preset').title = $('activity-hint').textContent;
  $('detection-preset').title = $('detection-hint').textContent;
}

// ---------------------------------------------------------------------------
// Engines: which Checkmarx One engines' findings are loaded (SAST and SCA, the engines AI Triage
// and AI Remediation work on, unless more are ticked). Remembered in this browser.
// ---------------------------------------------------------------------------

const ENGINE_KEY = 'mz-engines';
function savedEngines() {
  try {
    const saved = cleanEngines(JSON.parse(localStorage.getItem(ENGINE_KEY) || 'null'));
    if (saved.length) return saved;
  } catch {}
  return [...DEFAULT_ENGINES];
}
const enginePick = new Set(savedEngines());

/** The engines' tick boxes (AI engines first), for any picker: `chosen` is a Set, `onChange` hears the new choice. */
function engineOptions(box, chosen, onChange) {
  box.replaceChildren(
    ...ENGINES.map((engine) => {
      const label = document.createElement('label');
      label.className = 'engine-opt';
      const input = Object.assign(document.createElement('input'), { type: 'checkbox', value: engine.key, checked: chosen.has(engine.key) });
      const name = document.createElement('b');
      name.setAttribute('translate', 'no');
      name.textContent = engine.label;
      const what = document.createElement('span');
      what.className = 'muted';
      what.textContent = engine.name;
      const tag = document.createElement('small');
      tag.className = engine.ai ? 'engine-ai' : '';
      tag.textContent = engine.ai ? 'AI Triage & Remediation' : 'No AI';
      input.addEventListener('change', () => {
        if (input.checked) chosen.add(engine.key);
        else if (chosen.size > 1) chosen.delete(engine.key);
        else {
          // At least one engine: nothing would be loaded otherwise.
          input.checked = true;
          return onChange(chosen, 'Keep at least one engine.');
        }
        onChange(chosen);
      });
      label.append(input, name, what, tag);
      return label;
    }),
  );
}

/** The engines the loaded data covers ([] = every engine), or null before anything is loaded. */
const loadedEngines = () => (state.lastScan ? (state.lastScan.engines ?? state.lastScan.request?.engines ?? []) : null);
const sameEngines = (a, b) => cleanEngines(a.length ? a : ENGINES.map((e) => e.key)).join() === cleanEngines(b.length ? b : ENGINES.map((e) => e.key)).join();

export function renderEnginePick(note = '') {
  $('engine-summary').textContent = describeEngines([...enginePick]);
  if (!$('engine-menu').childElementCount) {
    engineOptions($('engine-menu'), enginePick, (chosen, warning) => {
      try {
        localStorage.setItem(ENGINE_KEY, JSON.stringify([...chosen]));
      } catch {}
      renderEnginePick(warning);
      updateScopeSummary();
    });
  } else {
    for (const box of $('engine-menu').querySelectorAll('input')) box.checked = enginePick.has(box.value);
  }
  // Changed since the data was loaded: say that loading again applies it.
  const loaded = loadedEngines();
  const changed = loaded !== null && !sameEngines(loaded, [...enginePick]);
  const hint = $('engine-hint');
  hint.textContent = note || (changed ? 'Changed: load findings again to apply it.' : '');
  hint.hidden = !hint.textContent;
}

/** Tick the engines a load was made with ([] = every engine). */
function setEnginePick(engines) {
  const list = cleanEngines(engines);
  enginePick.clear();
  for (const key of list.length ? list : ENGINES.map((e) => e.key)) enginePick.add(key);
  renderEnginePick();
}

// ---------------------------------------------------------------------------
// Branch and projects: each project's primary branch (unless every branch is ticked), and whether
// projects with no lines of code, or no open findings, are left out. Remembered in this browser.
// ---------------------------------------------------------------------------

const FOCUS_KEY = 'mz-focus';
const DEFAULT_FOCUS = { allBranches: false, leaveOutNoCode: true, leaveOutNoFindings: false };
function savedFocus() {
  try {
    const saved = JSON.parse(localStorage.getItem(FOCUS_KEY) || 'null');
    if (saved && typeof saved === 'object') return { allBranches: saved.allBranches === true, leaveOutNoCode: saved.leaveOutNoCode !== false, leaveOutNoFindings: saved.leaveOutNoFindings === true };
  } catch {}
  return { ...DEFAULT_FOCUS };
}
export const focusPick = savedFocus();
const FOCUS_BOXES = { allBranches: 'focus-all-branches', leaveOutNoCode: 'focus-no-code', leaveOutNoFindings: 'focus-no-findings' };

/** What a load was made with (a load made before these choices: every branch, nothing left out). */
function focusOf(request) {
  if (!request) return null;
  return { allBranches: request.branches !== 'primary', leaveOutNoCode: request.branches ? request.zeroLoc !== 'keep' : false, leaveOutNoFindings: request.noFindings === 'leave-out' };
}

export function renderFocusPick() {
  for (const [key, id] of Object.entries(FOCUS_BOXES)) $(id).checked = focusPick[key];
  $('focus-summary').textContent = focusPick.allBranches ? 'Every branch' : 'Primary branch';
  const loaded = focusOf(state.lastScan?.request ?? (state.lastScan ? { branches: state.lastScan.branchScope, zeroLoc: state.lastScan.leaveOut?.noCode === false ? 'keep' : '', noFindings: state.lastScan.leaveOut?.noFindings ? 'leave-out' : '' } : null));
  const changed = loaded && Object.keys(FOCUS_BOXES).some((key) => loaded[key] !== focusPick[key]);
  const hint = $('focus-hint');
  hint.textContent = changed ? 'Changed: load findings again to apply it.' : '';
  hint.hidden = !hint.textContent;
}

/** The projects a load left out, one note each: a primary branch never scanned, no lines of code, no open findings. */
function showLeftOut(result) {
  const out = result?.leftOut ?? {};
  const notes = [
    out.noPrimaryScan && `${out.noPrimaryScan} project(s) left out: their primary branch has no completed scan.`,
    out.noCode && `${out.noCode} project(s) left out: their scan counted no lines of code.`,
    out.noFindings && `${out.noFindings} project(s) left out: no open findings.`,
  ].filter(Boolean);
  $('left-out').replaceChildren(...notes.map((text) => Object.assign(document.createElement('span'), { textContent: text })));
  $('left-out').hidden = !notes.length;
}

/** Tick what a load was made with. */
function setFocusPick(request) {
  const loaded = focusOf(request);
  if (loaded) Object.assign(focusPick, loaded);
  renderFocusPick();
}

// ---------------------------------------------------------------------------
// Scope: fetch only named projects, or the projects named people last scanned
// ---------------------------------------------------------------------------

const scopePick = { applications: new Map(), projects: new Map(), initiators: new Set(), options: null, loading: null };
/** Applications, projects and people named. */
const scopeNamed = () => scopePick.applications.size + scopePick.projects.size + scopePick.initiators.size;

/** Project names and latest-scan initiators, for the suggestions (loaded on first use). */
function loadScopeOptions() {
  if (scopePick.options) return Promise.resolve(scopePick.options);
  if (scopePick.loading) return scopePick.loading;
  setScopeHint('Loading project names and who scanned them…');
  scopePick.loading = api('/api/scope/options')
    .then((data) => {
      scopePick.options = data;
      $('scope-application-options').replaceChildren(
        ...(data.applications ?? []).map((a) => Object.assign(document.createElement('option'), { value: a.name, label: `${a.projects} project${a.projects === 1 ? '' : 's'}` })),
      );
      const projectList = $('scope-project-options');
      const peopleList = $('scope-initiator-options');
      projectList.replaceChildren(...data.projects.map((p) => Object.assign(document.createElement('option'), { value: p.name })));
      peopleList.replaceChildren(
        ...data.initiators.map((i) => Object.assign(document.createElement('option'), { value: i.initiator, label: `${i.email ? `${i.email} · ` : ''}${i.projects} project${i.projects === 1 ? '' : 's'}` })),
      );
      setScopeHint(data.warning || `${(data.applications ?? []).length} applications, ${data.projects.length} projects, ${data.initiators.length} people. Pick as you type; Enter adds every name that contains the text.`, data.warning ? 'error' : '');
      return data;
    })
    .catch((error) => {
      if (!handleAuthLoss(error)) setScopeHint(`Could not load project names: ${error.message}`, 'error');
      return null;
    })
    .finally(() => {
      scopePick.loading = null;
    });
  return scopePick.loading;
}

function setScopeHint(text, kind = '') {
  $('scope-pick-hint').textContent = text;
  $('scope-pick-hint').className = `hint wide ${kind === 'error' ? 'error-hint' : ''}`;
}

/** Add the project with this exact name, else every project whose name contains the text. Returns how many. */
async function addScopeProjects(text) {
  const wanted = text.trim().toLowerCase();
  if (!wanted) return 0;
  const options = await loadScopeOptions();
  if (!options) return 0;
  const exact = options.projects.filter((p) => p.name.toLowerCase() === wanted);
  const matches = exact.length ? exact : options.projects.filter((p) => p.name.toLowerCase().includes(wanted));
  for (const p of matches) scopePick.projects.set(p.id, p.name);
  if (!matches.length) setScopeHint(`No project name contains "${text.trim()}".`, 'error');
  else if (!exact.length) setScopeHint(`Added ${matches.length} project${matches.length === 1 ? '' : 's'} whose name contains "${text.trim()}".`);
  return matches.length;
}

/** Add the application with this exact name, else every application whose name contains the text. Returns how many. */
async function addScopeApplications(text) {
  const wanted = text.trim().toLowerCase();
  if (!wanted) return 0;
  const options = await loadScopeOptions();
  if (!options) return 0;
  const all = options.applications ?? [];
  const exact = all.filter((a) => a.name.toLowerCase() === wanted);
  const matches = exact.length ? exact : all.filter((a) => a.name.toLowerCase().includes(wanted));
  for (const a of matches) scopePick.applications.set(a.id, a.name);
  if (!all.length) setScopeHint('Checkmarx One lists no applications for this key.', 'error');
  else if (!matches.length) setScopeHint(`No application name contains "${text.trim()}".`, 'error');
  return matches.length;
}

function addScopeInitiator(text) {
  const who = text.trim();
  if (who) scopePick.initiators.add(who);
}

/** Chips, built from text nodes (names come from Checkmarx One). */
function renderScopeChips() {
  const draw = (box, entries, kind) => {
    for (const chip of box.querySelectorAll('.scope-chip')) chip.remove();
    const input = box.querySelector('input');
    for (const [key, label] of entries) {
      const chip = document.createElement('span');
      chip.className = 'scope-chip';
      const text = document.createElement('span');
      text.textContent = label;
      text.title = label;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${label}`);
      remove.dataset.removeScope = kind;
      remove.dataset.key = key;
      chip.append(text, remove);
      box.insertBefore(chip, input);
    }
  };
  draw($('scope-applications'), [...scopePick.applications], 'application');
  draw($('scope-projects'), [...scopePick.projects], 'project');
  draw($('scope-initiators'), [...scopePick.initiators].map((who) => [who, who]), 'initiator');
  updateScopeSummary();
  syncNarrow();
}

const scopeStore = (kind) => (kind === 'application' ? scopePick.applications : kind === 'project' ? scopePick.projects : scopePick.initiators);

export function wireScope() {
  for (const [key, id] of Object.entries(FOCUS_BOXES)) {
    $(id).addEventListener('change', (event) => {
      focusPick[key] = event.target.checked;
      try {
        localStorage.setItem(FOCUS_KEY, JSON.stringify(focusPick));
      } catch {}
      renderFocusPick();
    });
  }
  for (const [inputId, kind] of [['scope-application-input', 'application'], ['scope-project-input', 'project'], ['scope-initiator-input', 'initiator']]) {
    const input = $(inputId);
    input.addEventListener('focus', () => loadScopeOptions());
    const commit = async () => {
      const value = input.value;
      input.value = '';
      if (kind === 'application') await addScopeApplications(value);
      else if (kind === 'project') await addScopeProjects(value);
      else addScopeInitiator(value);
      renderScopeChips();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ',' || event.key === 'Tab') {
        if (!input.value.trim()) return;
        event.preventDefault();
        commit();
      } else if (event.key === 'Backspace' && !input.value) {
        const store = scopeStore(kind);
        const last = [...store.keys()].pop();
        if (last !== undefined) {
          store.delete(last);
          renderScopeChips();
        }
      }
    });
    // Picking a suggestion fills the input with an exact value: add it straight away.
    input.addEventListener('input', () => {
      const value = input.value.trim().toLowerCase();
      if (!value || !scopePick.options) return;
      const exact = kind === 'application'
        ? (scopePick.options.applications ?? []).some((a) => a.name.toLowerCase() === value)
        : kind === 'project'
          ? scopePick.options.projects.some((p) => p.name.toLowerCase() === value)
          : scopePick.options.initiators.some((i) => i.initiator.toLowerCase() === value);
      if (exact) commit();
    });
  }

  $('scope-pick').addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-scope]');
    if (!button) return;
    scopeStore(button.dataset.removeScope).delete(button.dataset.key);
    renderScopeChips();
  });
}

// ---- The way to Mission Zero: Detect → Triage → Remediate → Fix & rescan → Verify → Zero ----

/** Tracked reports' verification rounds, read at most once a minute for the strip. */
const journeyReports = { at: 0, verified: 0, verifying: 0, leftZero: 0, total: 0, loading: false };

async function loadJourneyReports() {
  if (!can('reports.view') || journeyReports.loading || Date.now() - journeyReports.at < 60_000) return;
  journeyReports.loading = true;
  try {
    const data = await api('/api/tracked-reports');
    const reports = data.reports ?? data.items ?? [];
    Object.assign(journeyReports, {
      at: Date.now(),
      total: reports.length,
      verified: reports.filter((r) => r.verification?.result?.zero && !r.latest?.open).length,
      leftZero: reports.filter((r) => r.verification?.result?.zero && r.latest?.open).length,
      verifying: reports.filter((r) => r.verification && !r.verification.finishedAt && !r.verification.result).length,
    });
    renderJourney();
  } catch {
    /* the strip still shows the findings; the reports part waits for the next fetch */
  } finally {
    journeyReports.loading = false;
  }
}

export function renderJourney() {
  const panel = $('journey-panel');
  const projects = state.projects ?? [];
  const journeys = projects.map((p) => p.credits?.journey).filter(Boolean);
  panel.hidden = !journeys.length;
  if (!journeys.length) return;
  const t = { projects: 0, atZero: 0, open: 0, toTriage: 0, toRemediate: 0, fixing: 0, notExploitable: 0 };
  for (const j of journeys) {
    t.projects += 1;
    if (!j.open) t.atZero += 1;
    for (const key of ['open', 'toTriage', 'toRemediate', 'fixing', 'notExploitable']) t[key] += j[key] ?? 0;
  }
  const r = journeyReports;
  const reportsKnown = can('reports.view') && r.at;
  const steps = [
    // Detected: done by the fetch itself. Its number is what is open; the work starts at Triage.
    { id: 'detect', label: 'Detect', value: t.open, hint: `${t.open} open finding${t.open === 1 ? '' : 's'} in ${t.projects} project${t.projects === 1 ? '' : 's'}${t.notExploitable ? `; ${t.notExploitable} not exploitable` : ''}`, clear: true, count: true },
    { id: 'triage', label: 'Triage', value: t.toTriage, hint: `${t.toTriage} to verify: AI Triage or a person decides whether each is real`, clear: !t.toTriage, rail: 'credits' },
    { id: 'remediate', label: 'Remediate', value: t.toRemediate, hint: `${t.toRemediate} confirmed, waiting for a fix`, clear: !t.toRemediate, rail: 'credits' },
    { id: 'fix', label: 'Fix', value: t.fixing, hint: `${t.fixing} with a fix asked for: merge it, then rescan`, clear: !t.fixing, href: '#/reports' },
    {
      id: 'verify', label: 'Verify', value: reportsKnown ? r.verified : '–',
      hint: reportsKnown ? `${r.verified} of ${r.total} tracked report${r.total === 1 ? '' : 's'} verified at zero by a rescan${r.verifying ? `; ${r.verifying} verifying` : ''}${r.leftZero ? `; ${r.leftZero} left zero` : ''}` : 'A rescan proves the fixes (Reports → Verify)',
      clear: reportsKnown && r.total > 0 && !r.leftZero && r.verified === r.total, alert: reportsKnown && r.leftZero > 0, href: '#/reports',
    },
  ];
  // A stage is clear only when it and every stage before it are; the first one that is not is where to act.
  let upstream = true;
  for (const step of steps) {
    step.done = upstream && step.clear;
    if (step.id !== 'verify') upstream = step.done;
  }
  const next = steps.find((s) => !s.done);
  const reached = steps.filter((s) => s.done).length;
  // The green line runs up to the stage to act on next (nodes are evenly spaced along the track).
  panel.style.setProperty('--jfill', String(Math.min(reached, steps.length - 1) / (steps.length - 1)));

  const pct = t.projects ? Math.round((t.atZero / t.projects) * 100) : 0;
  const C = 2 * Math.PI * 21;
  $('journey-zero').innerHTML = `
    <svg viewBox="0 0 52 52" class="jz-ring" aria-hidden="true">
      <circle cx="26" cy="26" r="21" class="jz-bg" />
      <g class="jz-ticks">${dialTicks(26, 26, 25.5, 24)}</g>
      <circle cx="26" cy="26" r="21" class="jz-fg" stroke-dasharray="${((pct / 100) * C).toFixed(1)} ${C.toFixed(1)}" />
    </svg>
    <span class="jz-pct">${pct}%</span>
    <span class="jz-text"><b>Mission Zero</b><small>${t.atZero} of ${t.projects} project${t.projects === 1 ? '' : 's'} at zero</small></span>`;
  $('journey-zero').classList.toggle('all', t.atZero === t.projects);
  $('journey-zero').title = t.atZero === t.projects ? 'Every project here is at zero. Keep it there.' : 'Projects with nothing open, of those fetched';

  $('journey-steps').innerHTML = steps
    .map((s) => {
      const state = s.alert ? 'alert' : s.done ? 'done' : s === next ? 'now' : 'todo';
      const tag = s.href ? `a href="${s.href}"` : s.rail ? `button type="button" data-rail-open="${s.rail}"` : 'span';
      const end = s.href ? 'a' : s.rail ? 'button' : 'span';
      return `<li class="jstep is-${state}" data-step="${s.id}">
        <${tag} class="jnode" title="${escapeHtml(s.hint)}" aria-label="${escapeHtml(`${s.label}: ${s.hint}`)}">
          <span class="jdot">${state === 'done' && !s.count ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>' : escapeHtml(String(s.value))}</span>
          <span class="jlabel">${escapeHtml(s.label)}</span>
        </${end}>
      </li>`;
    })
    .join('');
  loadJourneyReports();
}

/**
 * Read the NDJSON stream from /api/scan?stream=1: calls on.start / on.project
 * as events arrive and resolves with the final ("done") result.
 */
async function streamScan(path, on = {}) {
  logger.apiCall('GET', path);
  const response = await fetch(path, { credentials: 'same-origin', signal: on.signal });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.error || `${response.status} ${response.statusText}`);
    error.status = response.status;
    logger.apiError('GET', path, error);
    throw error;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = null;
  const handle = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'start') on.start?.(event);
    else if (event.type === 'project') on.project?.(event.project);
    else if (event.type === 'done') done = event;
    else if (event.type === 'error') {
      const error = new Error(event.error || 'The fetch failed.');
      error.status = event.status;
      throw error;
    }
  };
  for (;;) {
    const { value, done: ended } = await reader.read();
    if (ended) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      handle(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  }
  handle(buffer + decoder.decode());
  if (!done) throw new Error('The connection closed before the fetch finished. Fetch again.');
  logger.apiSuccess('GET', path, 200);
  return done;
}

/** The data fetch's flare (the same flares every action uses). */
function fetchFlare(kind, text) {
  flare('fetch', kind, text, kind === 'busy' ? 'Triage, remediation and credits wait until it is complete.' : '');
}

/** Totals from the rows that have arrived so far. */
export function totalsOf(projects) {
  const totals = { projects: 0, risks: 0, counts: {}, severities: {} };
  for (const p of projects) {
    totals.projects += 1;
    totals.risks += p.totalRisks ?? 0;
    for (const [bucket, count] of Object.entries(p.counts ?? {})) totals.counts[bucket] = (totals.counts[bucket] ?? 0) + count;
    for (const [severity, count] of Object.entries(p.bySeverity ?? {})) totals.severities[severity] = (totals.severities[severity] ?? 0) + count;
    if (p.sla) {
      totals.sla ??= { overdue: 0, dueSoon: 0 };
      totals.sla.overdue += p.sla.overdue;
      totals.sla.dueSoon += p.sla.dueSoon;
    }
  }
  return totals;
}

function setFetching(on) {
  state.fetching = on;
  document.body.classList.toggle('fetching', on);
  for (const el of document.querySelectorAll('[data-needs-data]')) el.setAttribute('aria-disabled', on ? 'true' : 'false');
}

/**
 * After a page reload or a server restart: show the data this person fetched,
 * and the scope that produced it, from the server's copy (Checkmarx One is not
 * read again; Fetch gets the latest).
 */
export async function restoreLastScan({ force = false } = {}) {
  if ((state.projects.length && !force) || state.fetching || !can('findings.fetch')) return;
  let result;
  try {
    result = await api('/api/scan/last');
  } catch {
    return;
  }
  if (!result?.projects || (state.projects.length && !force) || state.fetching) return;
  restoreScope(result.request, result.projects);
  showLeftOut(result);
  showVulnerabilitySearch(result);
  state.lastScan = result;
  state.projects = result.projects;
  renderTotals(totalsOf(state.projects));
  collectInitiators();
  renderInitiatorList();
  renderProjects();
  renderAllocation();
  loadFusion();
  const at = new Date(result.fetchedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  $('fetch-meta').textContent = `Showing the data fetched ${at}. Load findings again for the latest.`;
  setStatus('status', `Loaded ${state.projects.length} project(s) as fetched ${at}.`, 'ok');
}

/** Put the scope controls back the way they were for that fetch. */
function restoreScope(request, projects) {
  if (!request) return;
  // Made before engines could be chosen: every engine was loaded.
  setEnginePick(Array.isArray(request.engines) ? request.engines : []);
  // Made before branches could be chosen: every branch, nothing left out.
  setFocusPick(request);
  for (const prefix of ['activity', 'detection']) {
    const select = $(`${prefix}-preset`);
    const preset = request[`${prefix}Preset`];
    // A load made before "Findings open for" (first found in the last 90 days, or year): shown as what it was.
    if (preset && prefix === 'detection' && ![...select.options].some((o) => o.value === preset) && state.health?.windowPresets.some((p) => p.id === preset)) {
      select.add(new Option(`First found: ${presetLabel(preset).toLowerCase()}`, preset));
    }
    if (preset && [...select.options].some((o) => o.value === preset)) select.value = preset;
    $(`${prefix}-from`).value = request[`${prefix}From`] || '';
    $(`${prefix}-to`).value = request[`${prefix}To`] || '';
    toggleRange(prefix);
  }
  const names = new Map(projects.map((p) => [p.projectId, p.projectName]));
  scopePick.applications.clear();
  scopePick.projects.clear();
  scopePick.initiators.clear();
  (request.applications ?? []).forEach((id, i) => scopePick.applications.set(id, request.applicationNames?.[i] ?? id));
  for (const id of request.projects ?? []) scopePick.projects.set(id, names.get(id) ?? id);
  for (const who of request.initiators ?? []) scopePick.initiators.add(who);
  renderScopeChips();
}

/**
 * Stop the fetch: the server reads no more projects, finishes the ones it is
 * reading, and ends the fetch with what it has. Those projects are kept and
 * every action works on them, as after a complete fetch.
 */
async function stopFetch() {
  const stop = $('fetch-stop');
  if (!state.fetching || stop.disabled) return;
  stop.disabled = true;
  stop.querySelector('span').textContent = 'Stopping…';
  fetchFlare('busy', `Stopping — keeping the ${state.projects.length} project(s) loaded so far…`);
  try {
    await api('/api/scan/stop', { method: 'POST', quiet: true });
  } catch (error) {
    if (handleAuthLoss(error)) return;
    // The server could not be told: end the stream from here; it stops when the page goes away.
    fetchAbort?.abort();
  }
}
let fetchAbort = null;

export function wireFetchStop() {
  $('fetch-stop').addEventListener('click', stopFetch);
}

/** The vulnerability search the data was loaded with: its box, the line saying so, and names to suggest. */
function showVulnerabilitySearch(result) {
  state.vulnerability = result?.vulnerability ?? result?.request?.vulnerability ?? '';
  $('vuln-q').value = state.vulnerability;
  syncNarrow();
  const names = result?.vulnerabilityNames ?? [];
  if (names.length) {
    $('vuln-names').innerHTML = names.map((n) => `<option value="${escapeHtml(String(n.name).replace(/_/g, ' '))}">${escapeHtml(`${n.count} finding${n.count === 1 ? '' : 's'}`)}</option>`).join('');
  }
  const line = $('vuln-active');
  line.hidden = !state.vulnerability;
  if (!state.vulnerability) return;
  const findings = result?.totals?.risks ?? 0;
  const projects = result?.totals?.projects ?? 0;
  line.innerHTML = `<b translate="no">${escapeHtml(state.vulnerability)}</b> · <span>Findings: ${findings} in ${projects} projects. Every action here works on these only.</span> <button type="button" class="link" id="vuln-clear">Show every finding</button>`;
}

async function fetchProjects() {
  // What is in the search box is what is loaded: empty, every finding.
  state.vulnerability = $('vuln-q').value.trim().slice(0, 200);
  const button = $('fetch');
  const stop = $('fetch-stop');
  button.disabled = true;
  button.textContent = 'Loading…';
  stop.hidden = false;
  stop.disabled = false;
  stop.querySelector('span').textContent = 'Stop';
  setStatus('status', '');

  // Rows appear as each project is read; actions on the data wait for the end.
  setFetching(true);
  state.lastScan = null;
  state.projects = [];
  state.selected.clear();
  state.showAllInitiators = false;
  $('select-all').checked = false;
  let total = 0;
  let pending = null;
  const paint = () => {
    pending = null;
    if (!state.fetching) return; // the final result already painted
    renderTotals(totalsOf(state.projects));
    renderProjects();
    fetchFlare('busy', `Data fetching is still in progress — ${state.projects.length}${total ? ` of ${total}` : ''} project(s) loaded`);
  };
  const schedule = () => {
    pending ??= setTimeout(paint, 400);
  };
  fetchFlare('busy', 'Data fetching is still in progress — finding projects…');
  renderProjects();

  try {
    fetchAbort = new AbortController();
    const result = await streamScan(`/api/scan?stream=1&${windowParams()}${$('fetch-fresh')?.checked ? '&fresh=1' : ''}`, {
      signal: fetchAbort.signal,
      start: (event) => {
        total = event.total;
        schedule();
      },
      project: (row) => {
        state.projects.push(row);
        schedule();
      },
    });
    clearTimeout(pending);
    setFetching(false);
    state.lastScan = result;
    state.projects = result.projects;
    showVulnerabilitySearch(result);
    renderEnginePick();
    renderFocusPick();
    renderTotals(result.totals);
    collectInitiators();
    renderInitiatorList();
    renderProjects();
    // Labs → Fusion results has its own line and fetch: only the Fusion column here, and what Fusion can act on, change.
    if (fusion.data) renderFusion();

    for (const note of result.initiatorNotes ?? []) console.warn(note);

    const failed = result.projects.filter((p) => p.error).length;
    const named = result.scope?.projects || result.scope?.initiators?.length;
    const skipped = result.stopped
      ? ` of ${result.projectsPlanned}: stopped before the other ${result.projectsNotRead} were read. Everything here works on these projects; Load findings again for the rest`
      : named
        ? ` of ${result.projectsTotal}: only the projects and people named in the scope`
        : result.projectsSkipped
          ? `, ${result.projectsSkipped} of ${result.projectsTotal} skipped (not scanned in ${result.windows.activity.label.toLowerCase()})`
          : '';
    $('fetch-meta').textContent =
      `${result.totals.risks} finding(s) in ${(result.elapsedMs / 1000).toFixed(1)}s via ${result.resolvedPath}` +
      (result.stats?.requests ? ` · ${result.stats.requests} API request(s)` : '') +
      (result.reused ? ` · ${result.reused} project(s) reused from a read made moments ago` : '') +
      (result.stopped ? ` · stopped at ${result.totals.projects} of ${result.projectsPlanned} project(s)` : '');
    showLeftOut(result);
    setStatus(
      'status',
      `Loaded ${result.totals.projects} project(s)${skipped}.` +
        (failed ? ` ${failed} could not be read — check the risks endpoint in Settings.` : ''),
      failed ? 'error' : result.stopped ? 'warn' : 'ok',
    );
    if (result.warning) console.warn(result.warning);
    fetchFlare('done', result.stopped
      ? `Stopped — kept ${result.totals.projects} of ${result.projectsPlanned} project(s), ${result.totals.risks} finding(s)`
      : `Data fetch complete — ${result.totals.projects} project(s), ${result.totals.risks} finding(s)`);
  } catch (error) {
    clearTimeout(pending);
    if (error.name === 'AbortError') {
      // Ended from this page: the server keeps what it read; show it once it has finished.
      fetchFlare('done', `Stopped — ${state.projects.length} project(s) loaded`);
      setStatus('status', `Stopped after ${state.projects.length} project(s). Getting what was loaded…`, 'warn');
      setFetching(false);
      setTimeout(() => restoreLastScan({ force: true }), 1500);
    } else {
      fetchFlare('failed', `Data fetch stopped: ${error.message}`);
      if (!handleAuthLoss(error)) showError('status', error);
    }
  } finally {
    setFetching(false);
    fetchAbort = null;
    stop.hidden = true;
    button.disabled = false;
    button.textContent = 'Load findings';
  }
}

export async function downloadHtmlReport() {
  const button = $('download-html');
  button.disabled = true;
  setStatus('status', 'Generating HTML report…');

  try {
    const severity = $('severity-filter').value;
    const response = await fetch('/api/reports/html', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectIds: state.selected.size > 0 ? [...state.selected] : null,
        severities: severity ? [severity] : null,
        buckets: [],
      }),
    });

    if (!response.ok) {
      const error = new Error(`${response.status} ${response.statusText}`);
      throw error;
    }

    const html = await response.text();
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vulnerability-report-${new Date().toISOString().split('T')[0]}.html`;
    a.click();
    URL.revokeObjectURL(url);

    logger.add('HTML report downloaded', 'success');
    setStatus('status', 'HTML report downloaded successfully.', 'ok');
  } catch (error) {
    logger.add(`Failed to download HTML report: ${error.message}`, 'error');
    if (!handleAuthLoss(error)) showError('status', error);
  } finally {
    button.disabled = false;
  }
}

export function wireFetch() {
  $('activity-preset').addEventListener('change', () => toggleRange('activity'));
  $('detection-preset').addEventListener('change', () => toggleRange('detection'));
  $('fetch').addEventListener('click', fetchProjects);
  // Search a vulnerability: load only its findings (or every finding again when the box is emptied).
  $('vuln-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.fetching || !can('findings.fetch')) return;
    fetchProjects();
  });
  $('vuln-active').addEventListener('click', (event) => {
    if (!event.target.closest('#vuln-clear') || state.fetching) return;
    $('vuln-q').value = '';
    syncNarrow();
    fetchProjects();
  });
}

// ---------------------------------------------------------------------------
// Workspace: getting started, the action rail's scope line, narrowing the
// scope, the preview sheet, Settings → About, and Jump to (Ctrl K).
// ---------------------------------------------------------------------------

/** What the rail's actions apply to: the selected projects, or every one shown. */
export function renderRailScope() {
  const el = $('rail-scope');
  if (!state.projects.length) {
    el.textContent = 'Load findings to act on them.';
    el.className = 'rail-scope empty';
  } else {
    const shown = visibleProjects().filter((p) => !p.error).length;
    el.textContent = state.selected.size
      ? `${state.selected.size} of ${shown} project${shown === 1 ? '' : 's'} selected`
      : `All ${shown} shown project${shown === 1 ? '' : 's'} — tick some to narrow`;
    el.className = `rail-scope ${state.selected.size ? 'picked' : ''}`;
  }
  $('people-count').textContent = state.initiators.length ? String(state.initiators.length) : '';
  $('act-scope').textContent = el.textContent;
  $('act-scope').className = `act-scope ${state.selected.size ? 'picked' : ''}`;
}

// The rail docks beside the projects on wide screens; elsewhere it slides over
// from the right, opened from the action bar, and keeps everything in it.
const railDocked = matchMedia('(min-width: 1600px)');
export function openRail(tab) {
  if (tab) activateTab('dash', tab);
  if (railDocked.matches) return;
  document.querySelector('.wb').classList.add('rail-open');
  $('rail-scrim').hidden = false;
  document.body.classList.add('sheet-open');
  $('wb-rail').querySelector('.ptab.active')?.focus();
}
function closeRail() {
  if (!document.querySelector('.wb').classList.contains('rail-open')) return;
  document.querySelector('.wb').classList.remove('rail-open');
  $('rail-scrim').hidden = true;
  document.body.classList.remove('sheet-open');
}

// Scope: narrowing to named projects or people folds away until it is wanted.
// It holds the vulnerability search too: the row above stays one calm line.
export function syncNarrow(open) {
  const chips = scopeNamed() + ($('vuln-q').value.trim() ? 1 : 0);
  const show = open ?? (chips > 0 || $('narrow-toggle').getAttribute('aria-expanded') === 'true');
  $('scope-pick').classList.toggle('folded', !show);
  $('narrow-toggle').setAttribute('aria-expanded', String(show));
  $('narrow-toggle').textContent = chips ? `Narrowed (${chips})` : show ? 'Hide narrowing' : 'Narrow down';
  $('narrow-toggle').title = 'Load only some applications, projects or people, or only the findings of one vulnerability';
}

// The email / report preview opens as a sheet over the page.
function syncPreviewSheet() {
  const open = !$('preview-panel').hidden;
  $('preview-scrim').hidden = !open;
  document.body.classList.toggle('sheet-open', open);
}

export function wireActionRail() {
  $('act-bar').addEventListener('click', (event) => {
    const button = event.target.closest('[data-rail-open]');
    if (button) openRail(button.dataset.railOpen);
  });
  $('journey-steps').addEventListener('click', (event) => {
    const button = event.target.closest('[data-rail-open]');
    if (button) openRail(button.dataset.railOpen);
  });
  $('rail-close').addEventListener('click', closeRail);
  $('rail-scrim').addEventListener('click', closeRail);
  railDocked.addEventListener('change', () => railDocked.matches && closeRail());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.querySelector('.wb.rail-open') && $('preview-panel').hidden && !$('palette').open) closeRail();
  });
  $('narrow-toggle').addEventListener('click', () => {
    const open = $('narrow-toggle').getAttribute('aria-expanded') !== 'true';
    syncNarrow(open);
    if (open) $('scope-application-input').focus();
  });
  new MutationObserver(syncPreviewSheet).observe($('preview-panel'), { attributes: true, attributeFilter: ['hidden'] });
  $('preview-scrim').addEventListener('click', () => $('close-preview').click());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('preview-panel').hidden) $('close-preview').click();
  });
}

// ---- Getting started: the few things that make CxMissionZero useful -------

const GS_KEY = 'mz-gs-hidden';

let gsRun = 0;
export async function renderGettingStarted() {
  // Drawn again while an earlier drawing waits for the people list: the later one wins.
  const run = ++gsRun;
  const box = $('getting-started');
  let hidden = false;
  try {
    hidden = localStorage.getItem(GS_KEY) === state.me?.user?.id;
  } catch {}
  const steps = [];
  const cx = Boolean(state.connection);
  const smtp = Boolean(state.settings?.verified);
  const server = state.reportServer ? !state.reportServer.warnings?.length : true;
  if (can('integration.cxone') || !cx) steps.push({ stage: 'setup', label: 'Connect', done: cx, title: 'Connect Checkmarx One', text: 'The server reads projects and findings with its own key.', href: '#/settings/connection', action: can('integration.cxone') ? 'Connect' : 'Ask an Admin' });
  steps.push({ stage: 'act', done: state.projects.length > 0, title: 'Load findings', text: 'Choose a scope and load: ageing findings and who ran each scan.', href: '#/dashboard', action: 'Load', fetch: true });
  if (can('integration.smtp')) steps.push({ stage: 'setup', done: smtp, title: 'Set up email', text: 'Test your mail server so reminders and follow-ups can go out.', href: '#/settings/smtp', action: 'Set up' });
  if (can('settings.links')) steps.push({ stage: 'setup', done: server, title: 'Give reports a reachable address', text: 'So readers can triage and remediate straight from the emailed report.', href: '#/settings/server', action: 'Set address' });
  if (can('credits.limit')) steps.push({ stage: 'prove', done: Boolean(state.settings?.aiTriage?.monthlyCreditLimit), title: 'Cap AI credits', text: 'A credit pool limits what AI Triage and Remediation may spend.', href: '#/settings/ai', action: 'Set pool' });
  if (can('iam.manage')) {
    let people = 2;
    try {
      people = (access.data ?? (await api('/api/iam', { quiet: true }))).users.length;
    } catch {}
    if (run !== gsRun) return;
    steps.push({ stage: 'setup', done: people > 1, title: 'Invite your team', text: 'Add people and give each the role they need.', href: '#/access/people', action: 'Invite' });
  }
  const left = steps.filter((s) => !s.done).length;
  // A checklist of one is not a checklist: people who only fetch never see it.
  if (hidden || !left || steps.length < 2 || state.page === null) {
    box.hidden = true;
    return;
  }
  const done = steps.length - left;
  box.hidden = false;
  box.innerHTML = `<div class="gs-head">
      <div><h2 id="gs-title">Get started <span class="muted">· ${done} of ${steps.length} done</span></h2></div>
      <div class="gs-meter" role="img" aria-label="${done} of ${steps.length} done"><span style="width:${Math.round((done / steps.length) * 100)}%"></span></div>
      <button type="button" class="ghost sm" id="gs-hide">Hide</button>
    </div>
    <ol class="gs-steps">${steps
      .map((step) => `<li class="gs-step ${step.done ? 'done' : ''}" data-stage="${step.stage}" title="${escapeHtml(step.text)}">
        <span class="gs-mark" aria-hidden="true">${step.done ? '✓' : ''}</span>
        <span class="gs-text"><span class="gs-stage" data-i18n-ctx="stage">${step.label ?? STAGE_LABELS[step.stage]}</span><strong>${escapeHtml(step.title)}</strong></span>
        ${step.done ? '<span class="sr-only">Done</span>' : step.fetch ? `<button type="button" class="sm primary" data-gs-fetch ${can('findings.fetch') && cx ? '' : 'disabled'}>${escapeHtml(step.action)}</button>` : `<a class="button-like sm" href="${step.href}">${escapeHtml(step.action)}</a>`}
      </li>`)
      .join('')}</ol>`;
}

export function wireGettingStarted() {
  $('getting-started').addEventListener('click', (event) => {
    if (event.target.closest('#gs-hide')) {
      try {
        localStorage.setItem(GS_KEY, state.me?.user?.id ?? '1');
      } catch {}
      $('getting-started').hidden = true;
    }
    if (event.target.closest('[data-gs-fetch]')) $('fetch').click();
  });
}
