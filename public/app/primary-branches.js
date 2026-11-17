// Settings → Primary branches (from MZ-01.01.20): the order protected branches are suggested in, every project's
// primary branch in Checkmarx One beside what its git host protects, and, for Admins, the primary branch written
// to Checkmarx One project by project or for every suggestion at once.

import { $ } from './state.js';
import { escapeHtml, fmtDateTime } from './format.js';
import { api, setStatus, showError, toast } from './core.js';
import { loadBranchInfo } from './branches.js';

const SHOWN = 200;
let view = null;
let polling = null;

const LOCK = '<svg class="br-lock" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg><span class="sr-only"> (protected)</span>';

export async function loadPrimaryBranches({ quiet = false } = {}) {
  try {
    view = await api('/api/branches');
  } catch (error) {
    if (!quiet) showError(error);
    return;
  }
  render();
  clearTimeout(polling);
  if (view.job?.state === 'running') polling = setTimeout(() => loadPrimaryBranches({ quiet: true }), 1500);
}

function render() {
  const job = view.job ?? {};
  if (job.state === 'running') setStatus('pb-status', `Reading the projects… ${job.done ?? 0} of ${job.total || '…'}`, 'muted');
  else if (job.state === 'failed') setStatus('pb-status', `The read stopped: ${job.error}`, 'error');
  else if (view.read) setStatus('pb-status', `Read ${fmtDateTime(view.read.at)}${view.read.by ? ` by ${view.read.by}` : ''}.`, 'muted');
  else setStatus('pb-status', 'Not read yet: Read the projects to see what each git host protects.', 'muted');
  $('pb-read').disabled = job.state === 'running';

  $('pb-order').innerHTML = `${view.order.map((entry) => `<span class="br-chip on" translate="no">${escapeHtml(entry.split('|').join(' · '))}</span>`).join('<span class="pb-gt" aria-hidden="true">›</span>')}${view.admin ? ' <button type="button" class="sm secondary" id="pb-order-open">Edit the order</button>' : ''}${view.custom ? ` <span class="hint">${escapeHtml(`Changed ${fmtDateTime(view.at)}${view.by ? ` by ${view.by}` : ''}`)}</span>` : ''}`;

  const counts = view.protectedCounts ?? [];
  const repos = view.projects.filter((p) => p.provider).length;
  $('pb-found').innerHTML = view.read
    ? counts.length
      ? `${escapeHtml(`Protected across ${repos} repositories:`)} ${counts.slice(0, 12).map((c) => `<span translate="no">${escapeHtml(c.name)}</span>${LOCK} ${c.count}`).join(' · ')}`
      : escapeHtml(repos ? 'No protected branch found in the repositories read.' : 'No project is on a connected git host: suggestions come from the branch names Checkmarx One has scanned.')
    : '';

  $('pb-tools').hidden = !view.projects.length;
  $('pb-wrap').hidden = !view.projects.length;
  const suggested = view.projects.filter((p) => p.state === 'suggested');
  $('pb-set-all').hidden = !view.admin || !suggested.length;
  $('pb-set-all').textContent = `Set all ${suggested.length} suggested in Checkmarx One`;
  renderRows();
}

function stateCell(p) {
  if (p.state === 'set') return '<span class="muted">Set in Checkmarx One</span>';
  if (p.state === 'differs') return `<span class="fc-chip warn">${escapeHtml(`Checkmarx One says ${p.mainBranch}; ${p.better} is protected and comes first`)}</span>`;
  if (p.state === 'none') return `<span class="muted">${escapeHtml(p.error || (p.provider ? 'Nothing protected or usual to suggest' : 'No git host: from Checkmarx One only'))}</span>`;
  return `<span class="muted">${escapeHtml(p.suggestion.why === 'protected' ? 'Suggested: protected' : 'Suggested: a usual name')}</span>`;
}

function renderRows() {
  const filter = $('pb-filter').value;
  const term = $('pb-search').value.trim().toLowerCase();
  const rows = view.projects.filter((p) => (filter === 'all' || p.state === filter) && (!term || p.name.toLowerCase().includes(term) || p.repo.toLowerCase().includes(term)));
  const shown = rows.slice(0, SHOWN);
  $('pb-body').innerHTML = shown.length
    ? shown.map((p) => {
      const pick = p.mainBranch && !p.better ? p.mainBranch : p.better || p.suggestion.branch || p.mainBranch;
      const options = p.options.length ? p.options : [];
      const select = options.length
        ? `<select data-pb-branch="${escapeHtml(p.id)}" aria-label="${escapeHtml(`Primary branch of ${p.name}`)}"${view.admin ? '' : ' disabled'}>${options.map((o) => `<option value="${escapeHtml(o.name)}"${o.name === pick ? ' selected' : ''}>${escapeHtml(`${o.name}${o.protected ? ' 🔒' : ''}${o.name === p.mainBranch ? ' (as in Checkmarx One)' : o.name === p.suggestion.branch ? ' (suggested)' : ''}${o.scanned ? '' : ' · not scanned'}`)}</option>`).join('')}</select>`
        : '<span class="muted">No branch known</span>';
      const action = view.admin && options.length ? `<button type="button" class="sm" data-pb-set="${escapeHtml(p.id)}"${p.state === 'set' ? ' hidden' : ''}>Set in Checkmarx One</button>` : '';
      return `<tr data-pb-row="${escapeHtml(p.id)}">
        <td translate="no">${escapeHtml(p.name)}</td>
        <td class="muted" translate="no">${escapeHtml(p.repo ? `${p.label} ${p.repo}` : p.repoUrl ? p.repoUrl : 'no repository')}</td>
        <td translate="no">${p.mainBranch ? `${escapeHtml(p.mainBranch)}${p.primaryProtected ? LOCK : ''}` : '<span class="muted">not set</span>'}</td>
        <td>${select}</td>
        <td class="pb-act">${stateCell(p)} ${action}</td>
      </tr>`;
    }).join('')
    : '<tr class="empty"><td colspan="5">No project matches.</td></tr>';
  $('pb-more').textContent = rows.length > SHOWN ? `Showing ${SHOWN} of ${rows.length}: find a project to narrow the list.` : '';
}

async function writePrimary(projects) {
  const out = await api('/api/branches/primary', { method: 'POST', body: JSON.stringify({ projects }) });
  view = out;
  render();
  loadBranchInfo(true);
  const failed = (out.results ?? []).filter((r) => !r.ok);
  if (failed.length) toast(`${failed.length} could not be set: ${failed[0].error}`, 'error', 9000);
  else toast(`Primary branch set in Checkmarx One for ${projects.length} project(s).`, 'ok');
}

export function wirePrimaryBranches() {
  document.addEventListener('mz:settings-section', (event) => {
    if (event.detail === 'branches') loadPrimaryBranches({ quiet: true });
  });
  $('pb-read').addEventListener('click', async () => {
    try {
      await api('/api/branches/read', { method: 'POST' });
      setTimeout(() => loadPrimaryBranches(), 300);
    } catch (error) {
      showError(error);
    }
  });
  $('pb-filter').addEventListener('change', renderRows);
  $('pb-search').addEventListener('input', renderRows);
  $('pb-order').addEventListener('click', (event) => {
    if (!event.target.closest('#pb-order-open')) return;
    $('pb-order-text').value = view.order.join('\n');
    $('pb-order-edit').hidden = false;
    $('pb-order-text').focus();
  });
  $('pb-order-cancel').addEventListener('click', () => ($('pb-order-edit').hidden = true));
  const saveOrder = async (body) => {
    try {
      view = await api('/api/branches/order', { method: 'PUT', body: JSON.stringify(body) });
      $('pb-order-edit').hidden = true;
      render();
      toast('Order saved: the Workbench uses it on its next load.', 'ok');
    } catch (error) {
      showError(error);
    }
  };
  $('pb-order-save').addEventListener('click', () => saveOrder({ order: $('pb-order-text').value.split('\n').map((l) => l.trim()).filter(Boolean) }));
  $('pb-order-reset').addEventListener('click', () => saveOrder({ reset: true }));
  $('pb-body').addEventListener('change', (event) => {
    const select = event.target.closest('[data-pb-branch]');
    if (!select) return;
    const p = view.projects.find((x) => x.id === select.dataset.pbBranch);
    const button = document.querySelector(`[data-pb-set="${CSS.escape(select.dataset.pbBranch)}"]`);
    if (button) button.hidden = Boolean(p && select.value === p.mainBranch);
  });
  $('pb-body').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-pb-set]');
    if (!button) return;
    const id = button.dataset.pbSet;
    const branch = document.querySelector(`[data-pb-branch="${CSS.escape(id)}"]`)?.value;
    const p = view.projects.find((x) => x.id === id);
    if (!branch || !confirm(`Set ${branch} as the primary branch of ${p?.name ?? id} in Checkmarx One? Every tool that uses Checkmarx One's primary branch follows it.`)) return;
    button.disabled = true;
    try {
      await writePrimary([{ id, branch }]);
    } catch (error) {
      button.disabled = false;
      showError(error);
    }
  });
  $('pb-set-all').addEventListener('click', async () => {
    const list = view.projects.filter((p) => p.state === 'suggested').map((p) => ({ id: p.id, branch: p.suggestion.branch }));
    if (!list.length || !confirm(`Set the suggested primary branch in Checkmarx One for ${list.length} project(s) that have none? Each is in the audit log.`)) return;
    $('pb-set-all').disabled = true;
    try {
      for (let i = 0; i < list.length; i += 500) await writePrimary(list.slice(i, i + 500));
    } catch (error) {
      showError(error);
    } finally {
      $('pb-set-all').disabled = false;
    }
  });
}
