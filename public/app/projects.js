// The Workbench's table of projects: rows, filters, optional columns, export, and the people who started the scans.
import { sortAndFilter } from '../table-tools.js';
import { SCAN_TYPE_LABEL, fusionTotalOf } from '../fusion-view.js';
import { fusionEngines, renderTrackRow } from '../app.js';
import { $, can, state } from './state.js';
import { escapeHtml, fmt, formatDate } from './format.js';
import { api, handleAuthLoss, helpTip, setStatus, showError } from './core.js';
import { applyCredits, creditCell, renderAllocation, renderRecipientHint, resultsText } from './actions.js';

// ---------------------------------------------------------------------------
// Workbench: table
// ---------------------------------------------------------------------------

/** What a project's latest scan was: 'fusion', 'last', 'none', or '' when not known (the fetch's, else the Fusion page's). */
const scanTypeOf = (p) => p.scanType || fusion.data?.projects?.[p.projectId]?.scanType || '';

export function visibleProjects() {
  const text = $('filter').value.trim().toLowerCase();
  const severity = $('severity-filter').value;
  const scanType = $('scan-type-filter')?.value ?? '';
  const hideEmpty = $('hide-empty').checked;

  const picked = state.pickedInitiators;

  const rows = state.projects.filter((p) => {
    if (text && !p.projectName.toLowerCase().includes(text)) return false;
    if (severity && !(p.bySeverity?.[severity] > 0)) return false;
    if (scanType && (scanTypeOf(p) || 'none') !== scanType) return false;
    if (picked.size > 0 && !picked.has(p.initiator || p.initiatorEmail || '')) return false;
    if (hideEmpty && p.totalRisks === 0) return false;
    // Searching a vulnerability: projects without it are not shown, even while loading.
    if (state.vulnerability && p.totalRisks === 0 && !p.error) return false;
    return true;
  });

  const { key, dir } = state.sort;
  const value = (p) => {
    if (key === 'projectName') return p.projectName.toLowerCase();
    if (key === 'initiator') return (p.initiator || '').toLowerCase();
    const optional = OPTIONAL_COLUMNS.find((c) => c.id === key);
    if (optional) return optional.value(p);
    return key in p ? p[key] ?? 0 : p.counts?.[key] ?? 0;
  };

  return rows.sort((a, b) => {
    const [x, y] = [value(a), value(b)];
    if (x === y) return a.projectName.localeCompare(b.projectName);
    return (x > y ? 1 : -1) * (dir === 'asc' ? 1 : -1);
  });
}


/** Who ran the latest scan, and whether we could reach them. */
function renderInitiator(project) {
  // Rows streamed in during a fetch get their initiator with the final result.
  if (state.fetching && !project.initiatorEmail) {
    return project.initiator ? `${escapeHtml(project.initiator)}<span class="zero" translate="yes">resolving…</span>` : '<span class="zero" translate="yes">resolving…</span>';
  }
  if (!project.initiator && !project.initiatorEmail) {
    return '<span class="zero" translate="yes">no initiator recorded</span>';
  }
  // A long address may go onto two lines after its @, so the column stays inside the table.
  const breakable = (text) => escapeHtml(text).replace('@', '@<wbr>');
  const name = breakable(project.initiator || project.initiatorEmail);
  if (!project.initiatorEmail) {
    return `${name}<span class="err" translate="yes">no email resolved</span>`;
  }
  const same = project.initiatorEmail === project.initiator;
  return same
    ? breakable(project.initiatorEmail)
    : `${name}<span class="zero">${breakable(project.initiatorEmail)}</span>`;
}

/**
 * Distinct scan initiators in the current results.
 *
 * Keyed by the initiator identity rather than the email, so someone whose
 * address has not been resolved is still a selectable row that can be tagged.
 */
export function collectInitiators() {
  const seen = new Map();

  for (const project of state.projects) {
    const key = project.initiator || project.initiatorEmail;
    if (!key) continue;
    if (!seen.has(key)) {
      seen.set(key, {
        key,
        initiator: project.initiator || '',
        email: project.initiatorEmail || '',
        via: project.initiatorVia || 'none',
        suggestion: project.initiatorSuggestion || '',
        confidence: project.initiatorConfidence || 'none',
        projects: 0,
        risks: 0,
        projectIds: [],
      });
    }
    const entry = seen.get(key);
    entry.projects += 1;
    entry.risks += project.totalRisks;
    entry.projectIds.push(project.projectId);
    if (!entry.email && project.initiatorEmail) entry.email = project.initiatorEmail;
    if (!entry.suggestion && project.initiatorSuggestion) entry.suggestion = project.initiatorSuggestion;
  }

  state.initiators = [...seen.values()].sort((a, b) => b.risks - a.risks);
  // Drop selections for people who are no longer in the results.
  for (const key of [...state.pickedInitiators]) {
    if (!seen.has(key)) state.pickedInitiators.delete(key);
  }
}

const VIA_LABELS = {
  scan: 'From scan',
  username: 'Username',
  override: 'Saved',
  directory: 'Directory',
  'default-domain': 'Domain rule',
  remembered: 'Remembered',
  github: 'GitHub',
};

/** Two letters and a stable colour per person. */
export function avatar(name) {
  const clean = String(name || '?').replace(/@.*$/, '').replace(/^cx-/i, '');
  const parts = clean.split(/[\s._-]+/).filter(Boolean);
  const letters = ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '')).toUpperCase();
  let hash = 0;
  for (const ch of clean) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `<span class="avatar" style="--hue:${hash % 360}" aria-hidden="true">${escapeHtml(letters)}</span>`;
}

export function renderInitiatorList() {
  queueMicrotask(renderRecipientHint);
  const list = $('initiator-list');
  const note = $('initiator-resolved');
  const actions = $('initiator-actions');
  const stats = $('people-stats');

  if (state.initiators.length === 0) {
    list.innerHTML = '<p class="hint">Checkmarx One did not record who ran the scans of these projects.</p>';
    $('initiator-summary').textContent = 'None found.';
    stats.innerHTML = '';
    note.hidden = true;
    actions.hidden = true;
    return;
  }

  // An address is only *needed* for projects actually going out. With projects
  // selected, only those initiators are asked about; otherwise everyone is in
  // scope and everyone missing an address is asked.
  const selected = state.selected;
  const inScope = (entry) => selected.size === 0 || entry.projectIds.some((id) => selected.has(id));

  const needsAttention = state.initiators.filter((entry) => !entry.email && inScope(entry));
  const picked = state.pickedInitiators.size;
  const withEmail = state.initiators.filter((e) => e.email).length;
  const allResolved = needsAttention.length === 0;

  stats.innerHTML = `
    <span class="stat"><b>${state.initiators.length}</b> people</span>
    <span class="stat ok"><b>${withEmail}</b> reachable</span>
    ${needsAttention.length ? `<span class="stat bad"><b>${needsAttention.length}</b> missing</span>` : ''}`;

  // Nothing to do and nothing chosen: collapse to one line. It still opens on
  // demand, because the rows double as the filter for who a reminder goes to.
  const collapsed = allResolved && picked === 0 && !state.showAllInitiators;

  note.hidden = !collapsed;
  actions.hidden = collapsed;
  list.hidden = collapsed;
  $('initiator-summary').textContent = picked
    ? `Reminders go only to the ${picked} selected ${picked === 1 ? 'person' : 'people'}.`
    : 'Nobody selected: reminders go to everyone in the results.';

  if (collapsed) {
    note.innerHTML =
      '<span class="ok-dot"></span> Everyone has an email address — nothing needs your attention. ' +
      '<button type="button" class="link" id="show-initiators">Choose people</button>';
    $('show-initiators').addEventListener('click', () => {
      state.showAllInitiators = true;
      renderInitiatorList();
    });
    return;
  }

  // Unresolved rows come first: those are the ones blocking a send.
  const query = (state.initiatorQuery || '').trim().toLowerCase();
  const view = state.initiatorView || 'all';
  const rows = [...needsAttention, ...state.initiators.filter((entry) => !needsAttention.includes(entry))].filter((entry) => {
    if (view === 'selected' && !state.pickedInitiators.has(entry.key)) return false;
    if (view === 'missing' && entry.email) return false;
    if (query && !`${entry.initiator} ${entry.email} ${entry.suggestion}`.toLowerCase().includes(query)) return false;
    return true;
  });

  if (!rows.length) {
    list.innerHTML = `<p class="hint people-empty">${query ? 'Nobody matches that search.' : view === 'selected' ? 'Nobody is selected.' : 'Nobody is missing an email.'}</p>`;
    return;
  }

  list.innerHTML = rows
    .map((entry) => {
      const isPicked = state.pickedInitiators.has(entry.key);
      const id = `init-${encodeURIComponent(entry.key)}`;
      const needed = !entry.email && inScope(entry);
      const name = entry.initiator || entry.email;
      const status = entry.email
        ? `<span class="badge">${escapeHtml(VIA_LABELS[entry.via] || 'Resolved')}</span>`
        : entry.suggestion
          ? '<span class="badge warn">Suggested</span>'
          : needed
            ? '<span class="badge bad">No email</span>'
            : '<span class="badge muted">Not needed</span>';
      const mail = entry.email ? (entry.email !== name ? escapeHtml(entry.email) : '') : 'No address yet';
      return `
      <div class="person ${isPicked ? 'picked' : ''} ${entry.email ? '' : needed ? 'missing' : 'dimmed'}" role="listitem">
        <input type="checkbox" id="${escapeHtml(id)}" data-pick="${escapeHtml(entry.key)}" ${isPicked ? 'checked' : ''} aria-label="Select ${escapeHtml(name)}" />
        <label class="person-main" for="${escapeHtml(id)}">
          ${avatar(name)}
          <span class="person-text">
            <span class="person-name">${escapeHtml(name)}</span>
            ${mail ? `<span class="person-mail">${mail}</span>` : ''}
          </span>
        </label>
        ${status}
        <span class="person-count" title="${entry.projects} project(s)"><b>${entry.risks.toLocaleString()}</b><small>${entry.projects === 1 ? '1 project' : `${entry.projects} projects`}</small></span>
        ${entry.email ? '' : `<div class="person-fix">${renderInitiatorAddress(entry, needed)}</div>`}
      </div>`;
    })
    .join('');
}

/** How to fix a missing address: confirm a suggestion or type one. */
function renderInitiatorAddress(entry, needed) {
  if (entry.email) return '';
  if (entry.suggestion) {
    const label = entry.confidence === 'likely' ? "Matches your tenant's naming pattern" : 'Best guess';
    return `
      <div class="tag-row">
        <input type="email" value="${escapeHtml(entry.suggestion)}" data-tag-for="${escapeHtml(entry.key)}" aria-label="Email for ${escapeHtml(entry.initiator)}" />
        ${can('initiators.tag') ? `<button type="button" class="primary" data-tag-save="${escapeHtml(entry.key)}">Confirm</button>` : ''}
      </div>
      <span class="initiator-meta suggested">${escapeHtml(label)} — confirm to use it</span>`;
  }
  if (!needed || !can('initiators.tag')) return '';
  return `
    <div class="tag-row">
      <input type="email" placeholder="name@company.com" data-tag-for="${escapeHtml(entry.key)}" aria-label="Email for ${escapeHtml(entry.initiator)}" />
      <button type="button" data-tag-save="${escapeHtml(entry.key)}">Save</button>
    </div>`;
}

/** Save a typed address as an override, and use it immediately. */
async function tagInitiator(key) {
  const input = document.querySelector(`input[data-tag-for="${CSS.escape(key)}"]`);
  const entry = state.initiators.find((e) => e.key === key);
  if (!input || !entry) return;

  setStatus('status', `Saving address for ${entry.initiator || key}…`);
  try {
    const result = await api('/api/initiators/tag', {
      method: 'POST',
      body: JSON.stringify({ initiator: entry.initiator || key, email: input.value }),
    });

    // Reflect it locally so the row updates without another fetch.
    entry.email = result.email;
    entry.via = 'override';
    entry.suggestion = '';
    for (const project of state.projects) {
      if ((project.initiator || project.initiatorEmail) === key) {
        project.initiatorEmail = result.email;
        project.initiatorVia = 'override';
      }
    }
    state.settings = result.settings;

    state.showAllInitiators = false;
    renderInitiatorList();
    renderProjects();
    setStatus(
      'status',
      `${result.email} saved for ${result.initiator} and applied to ${result.projectsUpdated} project(s).`,
      'ok',
    );
  } catch (error) {
    if (!handleAuthLoss(error)) showError('status', error);
  }
}

// ---------------------------------------------------------------------------
// Projects table: optional columns (chosen once, kept in this browser) and export
// ---------------------------------------------------------------------------

/**
 * Columns a person can add to the projects table. Add one here and it appears
 * under "Columns", sorts, and goes into the export.
 */
// Labs → Fusion's last read (see readFusion), here because the Workbench's Fusion column reads it.
export const fusion = { data: null, scope: null, credits: null, loading: null, open: null, lane: null };
const OPTIONAL_COLUMNS = [
  { id: '0-30', group: 'Age', label: '≤ 30d', title: 'Findings first detected 30 days ago or less', value: (p) => p.counts?.['0-30'] ?? 0 },
  { id: '31-60', group: 'Age', label: '31–60d', title: 'Findings first detected 31 to 60 days ago', value: (p) => p.counts?.['31-60'] ?? 0 },
  { id: '60+', group: 'Age', label: '> 60d', title: 'Findings first detected more than 60 days ago', value: (p) => p.counts?.['60+'] ?? 0, alert: true },
  { id: 'unknown', group: 'Age', label: 'No date', title: 'Findings with no first-detection date', value: (p) => p.counts?.unknown ?? 0 },
  { id: 'sev:CRITICAL', group: 'Severity', label: 'Critical', value: (p) => p.bySeverity?.CRITICAL ?? 0, alert: true },
  { id: 'sev:HIGH', group: 'Severity', label: 'High', value: (p) => p.bySeverity?.HIGH ?? 0 },
  { id: 'sev:MEDIUM', group: 'Severity', label: 'Medium', value: (p) => p.bySeverity?.MEDIUM ?? 0 },
  { id: 'sev:LOW', group: 'Severity', label: 'Low', value: (p) => p.bySeverity?.LOW ?? 0 },
  // SLAs (Beta): columns to add under "Columns", for those who may use them.
  { id: 'sla:overdue', group: 'SLA', label: 'Past SLA', title: 'Open findings past the days their severity has to be fixed (Settings → SLAs)', value: (p) => p.sla?.overdue ?? 0, alert: true, perm: 'feature.sla' },
  { id: 'sla:soon', group: 'SLA', label: 'Due ≤ 7d', title: 'Open findings due within 7 days', value: (p) => p.sla?.dueSoon ?? 0, perm: 'feature.sla' },
  // Fusion (Beta): the project's results Fusion re-scored (Labs → Fusion), shown by default to those who may use it.
  { id: 'fusion:total', group: 'Fusion', label: 'Fusion', title: 'What this project’s latest Fusion scan reported in Risk Hub: Fusion, LAST or both, as ticked on Labs → Fusion results', value: (p) => fusionTotalOf(fusion.data, p.projectId, fusionEngines()) ?? 0, perm: 'feature.fusionResults', byDefault: true },
];
const COLUMNS_KEY = 'mz-project-columns';
let columnsChosen = false;
const shownColumns = (() => {
  try {
    let saved = JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? 'null');
    // MZ-01.00.65: "Past SLA" is no longer shown unless chosen; a choice saved before it was optional drops it once.
    if (Array.isArray(saved) && !localStorage.getItem(`${COLUMNS_KEY}-65`)) {
      saved = saved.filter((id) => id !== 'sla:overdue');
      localStorage.setItem(COLUMNS_KEY, JSON.stringify(saved));
    }
    localStorage.setItem(`${COLUMNS_KEY}-65`, '1');
    // MZ-01.00.85: the Fusion column joins a choice saved before it existed, once (it shows only to those who may use Fusion).
    if (Array.isArray(saved) && !localStorage.getItem(`${COLUMNS_KEY}-85`)) {
      if (!saved.includes('fusion:total')) saved.push('fusion:total');
      localStorage.setItem(COLUMNS_KEY, JSON.stringify(saved));
    }
    localStorage.setItem(`${COLUMNS_KEY}-85`, '1');
    if (Array.isArray(saved)) {
      columnsChosen = true;
      return new Set(saved.filter((id) => OPTIONAL_COLUMNS.some((c) => c.id === id)));
    }
  } catch {}
  return new Set();
})();
/** Columns this person may add (SLA columns need SLAs: Beta, or final). */
const availableColumns = () => OPTIONAL_COLUMNS.filter((c) => !c.perm || can(c.perm));
const activeColumns = () => availableColumns().filter((c) => shownColumns.has(c.id) || (!columnsChosen && c.byDefault));
const projectColspan = () => 7 + activeColumns().length;

export function renderColumnMenu() {
  const active = new Set(activeColumns().map((c) => c.id));
  const groups = [...new Set(availableColumns().map((c) => c.group))];
  $('col-menu').innerHTML = groups
    .map((group) => `<fieldset><legend>${escapeHtml(group)}</legend>${availableColumns().filter((c) => c.group === group)
      .map((c) => `<label class="check"${c.title ? ` title="${escapeHtml(c.title)}"` : ''}><input type="checkbox" data-col="${escapeHtml(c.id)}"${active.has(c.id) ? ' checked' : ''} /> ${escapeHtml(c.label)}</label>`)
      .join('')}</fieldset>`)
    .join('') + '<p class="hint">Kept in this browser.</p>';
}

export function renderProjectsHead() {
  const head = $('projects-head');
  for (const th of head.querySelectorAll('[data-optional]')) th.remove();
  const anchor = head.querySelector('th[data-sort="maxAgeDays"]');
  for (const c of activeColumns()) {
    const th = document.createElement('th');
    th.className = 'num';
    th.dataset.sort = c.id;
    th.dataset.optional = '';
    th.textContent = c.label;
    if (c.title) th.title = c.title;
    head.insertBefore(th, anchor);
  }
}

/** Every shown project, with every column (chosen or not), as CSV. */
function exportProjectsCsv() {
  const rows = visibleProjects();
  if (!rows.length) return;
  const cellText = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  const credit = (p, kind, key) => p.credits?.[kind]?.[key] ?? '';
  const header = ['Project', 'Project id', 'Open findings', ...availableColumns().map((c) => `${c.group}: ${c.label}`), 'Oldest open since', 'Oldest (days)', 'Last scanned by', 'Initiator email',
    'Triage allocated', 'Triage used', 'Triage left', 'Triage needed', 'Remediation allocated', 'Remediation used', 'Remediation left', 'Remediation needed'];
  const lines = rows.map((p) => [
    p.projectName, p.projectId, p.totalRisks, ...availableColumns().map((c) => c.value(p)), formatDate(p.oldestFirstDetectedAt), p.maxAgeDays ?? '', p.initiator ?? '', p.initiatorEmail ?? '',
    credit(p, 'triage', 'allocated'), credit(p, 'triage', 'used'), credit(p, 'triage', 'remaining'), p.credits?.need?.triage ?? '',
    credit(p, 'remediation', 'allocated'), credit(p, 'remediation', 'used'), credit(p, 'remediation', 'remaining'), p.credits?.need?.remediation ?? '',
  ]);
  const csv = [header, ...lines].map((line) => line.map(cellText).join(',')).join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  link.download = `projects-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

export function wireColumns() {
  $('col-menu').addEventListener('change', (event) => {
    const id = event.target.dataset.col;
    if (!id) return;
    // The first choice keeps what was shown by default, then follows the ticks.
    if (!columnsChosen) for (const c of activeColumns()) shownColumns.add(c.id);
    columnsChosen = true;
    if (event.target.checked) shownColumns.add(id);
    else shownColumns.delete(id);
    try {
      localStorage.setItem(COLUMNS_KEY, JSON.stringify([...shownColumns]));
    } catch {}
    renderProjectsHead();
    renderProjects();
  });
  document.addEventListener('click', (event) => {
    const picker = $('col-picker');
    if (picker.open && !picker.contains(event.target)) picker.open = false;
  });
  $('export-projects').addEventListener('click', exportProjectsCsv);
  renderColumnMenu();
  renderProjectsHead();
}

/** Rows drawn at a time: the table costs the same whatever the size of the tenant (see renderProjects). */
const ROW_PAGE = 100;

/** What each heading of the projects table reads, for sorting and the heading filters (src: table-tools.js). */
const projectColumns = () => [
  null,
  (p) => p.projectName,
  (p) => p.totalRisks,
  ...activeColumns().map((c) => (p) => c.value(p)),
  { value: (p) => p.maxAgeDays ?? null, text: (p) => formatDate(p.oldestFirstDetectedAt) },
  (p) => p.initiatorEmail || p.initiator || '',
  null,
  null,
];

// Open findings by severity as one strip: a thin bar in a phone's project list, four figures on a project's own screen.
function sevStrip(bySeverity = {}) {
  const parts = [['CRITICAL', 'Critical', 'c'], ['HIGH', 'High', 'h'], ['MEDIUM', 'Medium', 'm'], ['LOW', 'Low', 'l']];
  return `<span class="m-sev">${parts
    .map(([key, label, cls]) => {
      const n = Number(bySeverity?.[key] ?? 0);
      return `<i class="m-sev-${cls}" style="--n:${n}"><b>${fmt(n)}</b><small>${label}</small></i>`;
    })
    .join('')}</span>`;
}

export function renderProjects() {
  const rows = sortAndFilter('projects', visibleProjects(), projectColumns(), renderProjects);
  const body = $('projects-body');
  $('export-projects').disabled = !rows.length;
  // A new search, filter or sort starts again at the first page; a fetch filling in keeps it.
  const view = JSON.stringify([$('filter').value.trim().toLowerCase(), $('severity-filter').value, $('scan-type-filter')?.value ?? '', $('hide-empty').checked, [...state.pickedInitiators], state.sort, rows.length]);
  if (view !== state.rowView) {
    state.rowView = view;
    state.rowLimit = ROW_PAGE;
  }
  const shown = rows.length > (state.rowLimit ?? ROW_PAGE) ? rows.slice(0, state.rowLimit ?? ROW_PAGE) : rows;

  if (rows.length === 0) {
    body.innerHTML = `<tr class="empty"><td colspan="${projectColspan()}">${
      state.projects.length ? 'No projects match these filters.' : 'No data yet.'
    }</td></tr>`;
  } else {
    body.innerHTML = shown
      .map((p) => {
        // Gold: its latest scan was a Fusion scan; pink: a LAST scan.
        const type = scanTypeOf(p);
        return `
        <tr data-id="${escapeHtml(p.projectId)}"${type === 'fusion' || type === 'last' ? ` class="scan-row-${type}" title="${escapeHtml(`Latest scan: ${SCAN_TYPE_LABEL[type]}`)}"` : ''}>
          <td class="checkbox"><input type="checkbox" data-select="${escapeHtml(p.projectId)}" ${
            state.selected.has(p.projectId) ? 'checked' : ''
          } /></td>
          <td class="name" translate="no">${
            p.url
              ? `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.projectName)}</a>`
              : escapeHtml(p.projectName)
          }${Array.isArray(p.languages) && p.languages.length ? `<span class="proj-langs" title="Languages its latest scan has results in">${escapeHtml(p.languages.join(' · '))}</span>` : ''}${p.error ? `<span class="err">${escapeHtml(p.error)}</span>` : ''}${sevStrip(p.bySeverity)}</td>
          <td class="num c-count" data-label="Open findings">${p.totalRisks}</td>
          ${activeColumns().map((c) => {
            const v = c.value(p);
            return `<td class="num c-count ${v > 0 ? (c.alert ? 'aged' : '') : 'zero'}" data-label="${escapeHtml(c.label)}">${v}</td>`;
          }).join('')}
          <td class="c-oldest" data-label="Oldest open since"><span class="nowrap">${formatDate(p.oldestFirstDetectedAt)}</span>${
            p.maxAgeDays === null ? '' : ` <span class="zero">(${p.maxAgeDays}d)</span>`
          }</td>
          <td class="initiator c-wide" data-label="Last scanned by" translate="no">${renderInitiator(p)}</td>
          ${creditCell(p, 'triage').replace('<td class="', '<td data-label="AI Triage credits" class="c-half ')}
          ${creditCell(p, 'remediation').replace('<td class="', '<td data-label="AI Remediation credits" class="c-half ')}
        </tr>${state.creditEditor === p.projectId ? creditEditorRow(p) : ''}`;
      })
      .join('') +
      (shown.length < rows.length
        ? `<tr class="more-rows"><td colspan="${projectColspan()}"><span>Showing ${shown.length} of ${rows.length} projects</span>
            <button type="button" class="sm" data-more-rows="page">Show ${Math.min(ROW_PAGE, rows.length - shown.length)} more</button>
            <button type="button" class="sm link" data-more-rows="all">Show all ${rows.length}</button></td></tr>`
        : '');
  }

  // The legend, with how many of the projects loaded were of each kind.
  const kinds = { fusion: 0, last: 0, none: 0 };
  for (const p of state.projects) kinds[scanTypeOf(p) || 'none'] += 1;
  const legend = $('scan-legend');
  if (legend) {
    legend.hidden = !state.projects.length || !(kinds.fusion || kinds.last);
    legend.innerHTML = `<span class="scan-legend-key">Latest scan</span><span><i class="scan-swatch scan-swatch-fusion" aria-hidden="true"></i>Fusion <b>${fmt(kinds.fusion)}</b></span><span><i class="scan-swatch scan-swatch-last" aria-hidden="true"></i>LAST <b>${fmt(kinds.last)}</b></span><span><i class="scan-swatch" aria-hidden="true"></i>No AI <b>${fmt(kinds.none)}</b></span>`;
  }
  const selectedCount = state.selected.size;
  const pickedCount = state.pickedInitiators.size;
  $('table-meta').textContent =
    `${rows.length} of ${state.projects.length} project(s) shown` +
    (pickedCount ? ` · filtered to ${pickedCount} initiator(s)` : '') +
    (selectedCount
      ? ` · ${selectedCount} selected (reminder covers only these)`
      : ' · no project selected (reminder covers every shown project)');

  for (const th of document.querySelectorAll('#projects th[data-sort]')) {
    th.classList.toggle('sorted', th.dataset.sort === state.sort.key);
    th.dataset.dir = th.dataset.sort === state.sort.key ? state.sort.dir : '';
  }
  renderAllocation();
  renderTrackRow();
}

/**
 * Which findings are one Checkmarx One result, and why: Checkmarx One lists a
 * result once for every code path (data flow) into the same vulnerable code,
 * so those findings are triaged once, charged once, and fixed in one go.
 * groups: credits.sharedResults (with projectName when several projects).
 */
export function sharedResultsHtml(groups, severities, { open = false, folded = false } = {}) {
  const shown = (groups ?? []).filter((g) => severities.includes(g.severity));
  if (!shown.length) return '';
  const findings = shown.reduce((n, g) => n + g.findings, 0);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  return `<details class="shared-results"${open || (shown.length <= 3 && !folded) ? ' open' : ''}>
    <summary>Why fewer results than findings: ${plural(findings, 'finding', 'findings')} here ${findings === 1 ? 'is' : 'are'} ${plural(shown.length, 'Checkmarx One result', 'Checkmarx One results')}</summary>
    <p class="hint">Checkmarx One lists one result once for every code path (data flow) that reaches the same vulnerable code. Each line below is one result: AI Triage judges it once (1 credit), and one fix in that code closes all of its findings.</p>
    <ul>${shown
      .map(
        (g) => `<li><span class="sev-dot sev-${escapeHtml(g.severity.toLowerCase())}"></span><b>${escapeHtml(g.title)}</b>${g.projectName ? ` <span class="hint">in ${escapeHtml(g.projectName)}</span>` : ''} — ${g.findings} findings, <b>1 result</b>${g.places.length ? ` · ${escapeHtml(g.places.join(', '))}` : ''}
          <span class="hint">(${g.tie === 'result' ? 'same result ID' : 'same similarity group'} <code>${escapeHtml(g.id)}…</code>)</span></li>`,
      )
      .join('')}</ul>
  </details>`;
}

/** One project's credits, editable: what it needs and has at a glance, and the one thing to do here (give it extra credits). */
function creditEditorRow(p) {
  const c = p.credits ?? {};
  const t = c.triage ?? { allocated: 0, used: 0, remaining: 0 };
  const r = c.remediation ?? { allocated: 0, used: 0, remaining: 0 };
  const sev = c.severities ?? [];
  const toTriage = sev.reduce((n, s) => n + (c.toTriage?.[s] ?? 0), 0);
  const toTriageRows = sev.reduce((n, s) => n + (c.toTriageRows?.[s] ?? c.toTriage?.[s] ?? 0), 0);
  const toRemediate = c.toRemediate ?? 0;
  const id = escapeHtml(p.projectId);
  const help = helpTip(
    'Needs: what its open findings of the chosen severities call for: 1 credit for each Checkmarx One result to triage, 3 for each confirmed finding to remediate. Left: what it holds and has not spent yet. Extra credits come out of the credit pool and stay with this project until you change them.',
  );
  const kind = (label, need, needTitle, balance, extraKind, extra, step) => `<div class="credit-kind">
        <span class="label">${label}</span>
        <span class="need" title="${escapeHtml(needTitle)}">needs <b>${need}</b></span>
        <span class="has" title="${escapeHtml(`${balance.remaining} left of ${balance.allocated} allocated, ${balance.used} used`)}">left <b>${balance.remaining}</b></span>
        <label class="inline extra">+ <input type="number" min="0" step="${step}" class="small-num" data-extra="${extraKind}" value="${extra}" aria-label="${escapeHtml(`Extra ${label} credits`)}" /> extra</label>
      </div>`;
  return `<tr class="credit-editor" data-editor="${id}"><td colspan="${projectColspan()}">
    <div class="credit-editor-grid">
      <div class="credit-editor-head"><strong>${escapeHtml(p.projectName)}</strong><span class="credit-editor-ask">Give it extra AI credits</span>${help.button}</div>
      ${help.text}
      ${kind('AI Triage', toTriage, `For ${resultsText(toTriage, toTriageRows)}.`, t, 'triage', c.extraTriage ?? 0, 1)}
      ${kind('AI Remediation', toRemediate * 3, `${toRemediate} confirmed finding${toRemediate === 1 ? '' : 's'} × 3 credits`, r, 'remediation', c.extraRemediation ?? 0, 3)}
      ${sharedResultsHtml(c.sharedResults, sev, { folded: true })}
      <div class="actions compact">
        <button type="button" class="primary" data-credit-save="${id}">Save extra credits</button>
        <button type="button" data-credit-cancel="${id}">Close</button>
        <span class="status" data-credit-status="${id}"></span>
      </div>
    </div>
  </td></tr>`;
}

async function saveProjectCredits(projectId) {
  const row = document.querySelector(`[data-editor="${CSS.escape(projectId)}"]`);
  const value = (kind) => Math.max(0, Math.floor(Number(row.querySelector(`[data-extra="${kind}"]`).value) || 0));
  const status = row.querySelector('[data-credit-status]');
  status.textContent = 'Saving…';
  status.className = 'status';
  try {
    const result = await api('/api/credits/allocate', {
      method: 'POST',
      body: JSON.stringify({ projectIds: [projectId], setExtra: { triage: value('triage'), remediation: value('remediation') } }),
    });
    applyCredits(result.projects);
    const saved = document.querySelector(`[data-credit-status="${CSS.escape(projectId)}"]`);
    if (saved) {
      saved.textContent = 'Saved.';
      saved.className = 'status ok';
    }
  } catch (error) {
    if (handleAuthLoss(error)) return;
    status.textContent = error.message;
    status.className = 'status error';
  }
}

// Search waits for a pause in typing; the drop-downs and the box apply at once.
let filterTimer = null;

export function wireProjectFilters() {
  $('filter').addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(renderProjects, 150);
  });
  for (const id of ['severity-filter', 'scan-type-filter', 'hide-empty']) {
    $(id).addEventListener('input', renderProjects);
  }
}

export function wireSortAndInitiators() {
  // Delegated: optional columns come and go.
  $('projects-head').addEventListener('click', (event) => {
    const th = event.target.closest('th[data-sort]');
    if (!th) return;
    const key = th.dataset.sort;
    state.sort =
      state.sort.key === key
        ? { key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'projectName' ? 'asc' : 'desc' };
    renderProjects();
  });

  $('initiator-list').addEventListener('change', (event) => {
    const key = event.target.dataset.pick;
    if (!key) return;
    if (event.target.checked) state.pickedInitiators.add(key);
    else state.pickedInitiators.delete(key);
    renderInitiatorList();
    renderProjects();
  });

  $('initiator-list').addEventListener('click', (event) => {
    const key = event.target.dataset.tagSave;
    if (key) tagInitiator(key);
  });

  // Enter in a tag field saves it, rather than doing nothing.
  $('initiator-list').addEventListener('keydown', (event) => {
    const key = event.target.dataset.tagFor;
    if (key && event.key === 'Enter') {
      event.preventDefault();
      tagInitiator(key);
    }
  });

  $('initiator-search').addEventListener('input', () => {
    state.initiatorQuery = $('initiator-search').value;
    renderInitiatorList();
  });
  for (const radio of document.querySelectorAll('input[name="initiatorView"]')) {
    radio.addEventListener('change', () => {
      state.initiatorView = radio.value;
      renderInitiatorList();
    });
  }

  $('init-all').addEventListener('click', () => {
    for (const entry of state.initiators) state.pickedInitiators.add(entry.key);
    renderInitiatorList();
    renderProjects();
  });

  $('init-none').addEventListener('click', () => {
    state.pickedInitiators.clear();
    renderInitiatorList();
    renderProjects();
  });

  $('init-unresolved').addEventListener('click', () => {
    state.pickedInitiators.clear();
    for (const entry of state.initiators) if (!entry.email) state.pickedInitiators.add(entry.key);
    renderInitiatorList();
    renderProjects();
  });
}

export function wireProjectRows() {
  $('select-all').addEventListener('change', (event) => {
    for (const project of visibleProjects()) {
      if (event.target.checked) state.selected.add(project.projectId);
      else state.selected.delete(project.projectId);
    }
    renderProjects();
    renderInitiatorList();
  });

  $('projects-body').addEventListener('click', (event) => {
    const more = event.target.closest('[data-more-rows]');
    if (more) {
      state.rowLimit = more.dataset.moreRows === 'all' ? Infinity : (state.rowLimit ?? ROW_PAGE) + ROW_PAGE;
      renderProjects();
      return;
    }
    const edit = event.target.closest('[data-credit-edit]');
    const save = event.target.closest('[data-credit-save]');
    const close = event.target.closest('[data-credit-cancel]');
    if (edit) {
      state.creditEditor = state.creditEditor === edit.dataset.creditEdit ? null : edit.dataset.creditEdit;
      renderProjects();
      document.querySelector(`[data-editor="${CSS.escape(edit.dataset.creditEdit)}"] input`)?.focus();
    } else if (save) {
      saveProjectCredits(save.dataset.creditSave);
    } else if (close) {
      state.creditEditor = null;
      renderProjects();
    }
  });
  $('projects-body').addEventListener('keydown', (event) => {
    const row = event.target.closest('[data-editor]');
    if (!row) return;
    if (event.key === 'Enter') saveProjectCredits(row.dataset.editor);
    if (event.key === 'Escape') {
      state.creditEditor = null;
      renderProjects();
    }
  });
  $('projects-body').addEventListener('change', (event) => {
    const id = event.target.dataset.select;
    if (!id) return;
    if (event.target.checked) state.selected.add(id);
    else state.selected.delete(id);
    renderProjects();
    renderInitiatorList();
  });
}
