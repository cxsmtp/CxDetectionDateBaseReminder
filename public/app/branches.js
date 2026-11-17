// Branches on the Workbench (from MZ-01.01.20): the Branch column (each project's branch, why it was used, and a
// menu to load it on another), the branch chosen for single projects (kept in this browser), and the protected
// branches found across the tenant (Settings → Primary branches' last read) offered as "one branch for every project".

import { $, state } from './state.js';
import { escapeHtml, fmtDateTime } from './format.js';
import { api, showError } from './core.js';

const CHOSEN_KEY = 'mz-branch-for';
/** Branches chosen for single projects: {projectId: branch}. */
export const chosenBranches = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(CHOSEN_KEY) || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      return new Map(Object.entries(saved).filter(([id, b]) => id && typeof b === 'string' && /^[\w./+@-]{1,200}$/.test(b)).slice(0, 500));
    }
  } catch {}
  return new Map();
})();
function saveChosen() {
  try {
    localStorage.setItem(CHOSEN_KEY, JSON.stringify(Object.fromEntries(chosenBranches)));
  } catch {}
}

/** The branches chosen for single projects, as the load sends them (nothing when none). */
export const chosenParam = () => (chosenBranches.size ? JSON.stringify(Object.fromEntries(chosenBranches)) : '');

// What the last read under Settings → Primary branches found: what each project's git host protects.
export const branchInfo = { protectedOf: new Map(), counts: [], loaded: false, loading: null };
export function loadBranchInfo(force = false) {
  if (branchInfo.loading && !force) return branchInfo.loading;
  branchInfo.loading = api('/api/branches')
    .then((view) => {
      branchInfo.protectedOf = new Map((view.projects ?? []).map((p) => [p.id, p.protectedNames ?? []]));
      branchInfo.counts = view.protectedCounts ?? [];
      branchInfo.loaded = true;
      return view;
    })
    .catch(() => null);
  return branchInfo.loading;
}

const globRe = (glob) => new RegExp(`^${String(glob).split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
const isProtected = (name, names = []) => Boolean(name) && names.some((p) => globRe(p).test(name));

const LOCK = '<svg class="br-lock" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>';
/** A small lock after a protected branch's name, with words for a screen reader. */
const lockOf = (on) => (on ? `${LOCK}<span class="sr-only"> (protected)</span>` : '');

/** Why a project's findings are from its branch, in a few words. */
export function branchWhy(p) {
  const wanted = p.branchWanted ? `no ${p.branchWanted} scan: ` : '';
  if (p.branchHow === 'chosen') return chosenBranches.has(p.projectId) ? `chosen here${p.mainBranch && p.mainBranch !== p.branch ? ` · primary is ${p.mainBranch}` : ''}` : 'one branch for every project';
  if (p.branchHow === 'primary') return `${wanted}primary in Checkmarx One`;
  if (p.branchHow === 'protected') return `${wanted}no primary set: protected branch`;
  if (p.branchHow === 'guessed') return `${wanted}no primary set: main or master`;
  if (p.branchHow === 'latest') return `${wanted}no primary set: latest scan`;
  if (p.branchHow === 'any') return 'every branch';
  if (p.branchHow === 'unknown') return 'branch not reported';
  return '';
}

/** The Branch cell of a project's row. */
export function branchCell(p) {
  const name = p.branch || '';
  const chosen = chosenBranches.has(p.projectId);
  const may = p.branchHow !== 'any';
  const label = name ? `${escapeHtml(name)}${lockOf(isProtected(name, branchInfo.protectedOf.get(p.projectId)))}` : '<span class="zero">—</span>';
  const button = may
    ? `<button type="button" class="br-pick${chosen ? ' chosen' : ''}" data-branch-pick="${escapeHtml(p.projectId)}" aria-haspopup="true" title="Load this project on another branch">${label}<span class="br-caret" aria-hidden="true">▾</span></button>`
    : `<span class="br-name">${label}</span>`;
  const why = branchWhy(p);
  return `<td class="c-branch" data-label="Branch" translate="no">${button}${why ? `<span class="br-why">${escapeHtml(why)}</span>` : ''}</td>`;
}

// ---- The menu of one project's branches ---------------------------------------------------------------------------
let menuFor = '';
function closeMenu() {
  $('branch-pop')?.remove();
  document.querySelector('[data-branch-pick][aria-expanded="true"]')?.setAttribute('aria-expanded', 'false');
  menuFor = '';
}

async function openMenu(button, onChange) {
  const id = button.dataset.branchPick;
  if (menuFor === id) return closeMenu();
  closeMenu();
  menuFor = id;
  button.setAttribute('aria-expanded', 'true');
  const pop = document.createElement('div');
  pop.id = 'branch-pop';
  pop.className = 'br-pop';
  pop.setAttribute('role', 'menu');
  pop.innerHTML = '<p class="hint">Reading its branches…</p>';
  document.body.append(pop);
  const place = () => {
    const r = button.getBoundingClientRect();
    pop.style.top = `${r.bottom + window.scrollY + 6}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - pop.offsetWidth - 8))}px`;
  };
  place();
  let got;
  try {
    got = await api(`/api/branches/project?id=${encodeURIComponent(id)}`);
  } catch (error) {
    if (menuFor !== id) return;
    pop.innerHTML = `<p class="hint err">${escapeHtml(error.message)}</p>`;
    return;
  }
  if (menuFor !== id) return;
  const row = state.projects.find((p) => p.projectId === id);
  const current = row?.branch ?? '';
  const item = (b) => `<button type="button" role="menuitem" class="br-opt${b.name === current ? ' on' : ''}" data-branch-choose="${escapeHtml(b.name)}"${b.scanned ? '' : ' disabled title="No completed scan on this branch yet"'}>
      <b translate="no">${escapeHtml(b.name)}${lockOf(b.protected)}</b>
      <small>${escapeHtml([b.primary ? 'primary in Checkmarx One' : '', b.lastScanAt ? `scanned ${fmtDateTime(b.lastScanAt)}` : 'never scanned'].filter(Boolean).join(' · '))}</small></button>`;
  const heading = got.host ? `Protected · ${got.host.label} ${got.host.repo}` : 'Protected';
  pop.innerHTML = `${got.protected.length ? `<h6 translate="no">${escapeHtml(heading)}</h6>${got.protected.map(item).join('')}` : `<p class="hint">${escapeHtml(got.error || (got.host ? 'Its git host protects no branch.' : 'No git host connected for it: its branches come from Checkmarx One only.'))}</p>`}
    ${got.others.length ? `<h6>Other branches scanned in Checkmarx One</h6>${got.others.map(item).join('')}` : ''}
    ${chosenBranches.has(id) ? `<hr /><button type="button" role="menuitem" class="br-opt" data-branch-choose=""><span>↺ ${escapeHtml(`Back to its primary branch${got.primary ? ` (${got.primary})` : ''}`)}</span></button>` : ''}`;
  place();
  pop.addEventListener('click', (event) => {
    const choose = event.target.closest('[data-branch-choose]');
    if (!choose || choose.disabled) return;
    const name = choose.dataset.branchChoose;
    if (name && name !== got.primary) chosenBranches.set(id, name);
    else chosenBranches.delete(id);
    saveChosen();
    closeMenu();
    onChange?.(id, name);
  });
}

/** The Branch column's menus. `onChange`: a project's branch changed (the Workbench loads again). */
export function wireBranchPicks(onChange) {
  $('projects-body').addEventListener('click', (event) => {
    const button = event.target.closest('[data-branch-pick]');
    if (!button) return;
    event.stopPropagation();
    openMenu(button, onChange).catch(showError);
  });
  document.addEventListener('click', (event) => {
    if (menuFor && !event.target.closest('#branch-pop') && !event.target.closest('[data-branch-pick]')) closeMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menuFor) closeMenu();
  });
}

/** The chips of "one branch for every project": the protected branches found across the tenant, with how many have each. */
export function branchChips(selected) {
  const chips = branchInfo.counts.slice(0, 8);
  if (!chips.length) return '<span class="hint">Read the projects under Settings → Primary branches to list the protected branches here.</span>';
  return chips
    .map((c) => `<button type="button" class="br-chip${c.name === selected ? ' on' : ''}" data-branch-chip="${escapeHtml(c.name)}" aria-pressed="${c.name === selected}" translate="no">${escapeHtml(c.name)}${lockOf(true)} <small>${c.count}</small></button>`)
    .join('');
}
