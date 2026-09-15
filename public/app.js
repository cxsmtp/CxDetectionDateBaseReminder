const $ = (id) => document.getElementById(id);

const state = {
  projects: [],
  selected: new Set(),
  apps: [],
};

async function api(path, options) {
  const response = await fetch(path, {
    headers: options?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
  return payload;
}

function setStatus(message, kind = '') {
  const el = $('status');
  el.textContent = message;
  el.className = `status ${kind}`;
}

const formatDate = (iso) => (iso ? iso.slice(0, 10) : '—');

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTotals(totals) {
  $('totals-panel').hidden = false;
  const counts = totals.counts ?? {};
  $('totals').innerHTML = [
    ['Projects', totals.projects],
    ['Open findings', totals.risks],
    ['≤ 30 days', counts['0-30'] ?? 0],
    ['31–60 days', counts['31-60'] ?? 0],
    ['> 60 days', counts['60+'] ?? 0],
    ['Unknown date', counts.unknown ?? 0],
  ]
    .map(
      ([label, value]) =>
        `<div><span class="value">${value}</span><span class="label">${label}</span></div>`,
    )
    .join('');
}

function cell(count) {
  return count > 0 ? `<td class="num">${count}</td>` : '<td class="num zero">0</td>';
}

function renderProjects() {
  const filter = $('filter').value.trim().toLowerCase();
  const rows = state.projects.filter((p) => !filter || p.projectName.toLowerCase().includes(filter));
  const body = $('projects-body');

  if (rows.length === 0) {
    body.innerHTML = '<tr class="empty"><td colspan="7">No projects match that filter.</td></tr>';
    return;
  }

  body.innerHTML = rows
    .map((project) => {
      const aged = project.counts['60+'] ?? 0;
      return `
      <tr data-id="${project.projectId}">
        <td class="checkbox">
          <input type="checkbox" data-select="${project.projectId}" ${
            state.selected.has(project.projectId) ? 'checked' : ''
          } />
        </td>
        <td class="name">
          ${escapeHtml(project.projectName)}
          ${project.error ? `<span class="err">${escapeHtml(project.error)}</span>` : ''}
        </td>
        <td class="num">${project.totalRisks}</td>
        ${cell(project.counts['0-30'] ?? 0)}
        ${cell(project.counts['31-60'] ?? 0)}
        <td class="num ${aged > 0 ? 'aged' : 'zero'}">${aged}</td>
        <td>${formatDate(project.oldestFirstDetectedAt)}${
          project.maxAgeDays === null ? '' : ` <span class="zero">(${project.maxAgeDays}d)</span>`
        }</td>
      </tr>`;
    })
    .join('');
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function selectedBuckets() {
  return [...document.querySelectorAll('input[name="bucket"]:checked')].map((input) => input.value);
}

function selectedProjectIds() {
  return state.selected.size > 0 ? [...state.selected] : null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function loadHealth() {
  try {
    const health = await api('/api/health');
    const el = $('connection');
    if (health.ok) {
      el.textContent = `Connected to ${health.tenant || 'Checkmarx One'} · risks via ${health.riskSource} · delivery ${health.deliveryMode}`;
      el.className = 'sub ok';
    } else {
      el.textContent = health.problems.join(' ');
      el.className = 'sub error';
    }
  } catch (error) {
    $('connection').textContent = error.message;
    $('connection').className = 'sub error';
  }
}

async function loadFeedbackApps() {
  const select = $('feedback-app');
  try {
    const { apps } = await api('/api/feedback-apps');
    state.apps = apps;
    const usable = apps.filter((app) => app.type === 'EMAIL' || app.recipients.length > 0);
    const listed = usable.length > 0 ? usable : apps;

    select.innerHTML = listed.length
      ? listed
          .map(
            (app) =>
              `<option value="${escapeHtml(app.id)}">${escapeHtml(app.name)} (${escapeHtml(app.type)}${
                app.recipients.length ? `, ${app.recipients.length} recipients` : ''
              })</option>`,
          )
          .join('')
      : '<option value="">No feedback apps configured</option>';
    updateRecipientHint();
  } catch (error) {
    select.innerHTML = '<option value="">Could not load feedback apps</option>';
    $('recipients-hint').textContent = error.message;
  }
}

function updateRecipientHint() {
  const app = state.apps.find((entry) => entry.id === $('feedback-app').value);
  $('recipients-hint').textContent = app?.recipients.length
    ? `Will notify ${app.recipients.length} recipient(s): ${app.recipients.slice(0, 4).join(', ')}${
        app.recipients.length > 4 ? ', …' : ''
      }`
    : "Recipients come from the app's configuration in CxONE.";
}

async function fetchProjects() {
  const button = $('fetch');
  button.disabled = true;
  button.textContent = 'Fetching…';
  setStatus('');

  try {
    const result = await api('/api/scan');
    state.projects = result.projects.sort((a, b) => (b.counts['60+'] ?? 0) - (a.counts['60+'] ?? 0));
    state.selected.clear();
    $('select-all').checked = false;
    renderTotals(result.totals);
    renderProjects();
    setStatus(`Loaded ${result.totals.projects} projects from ${result.resolvedPath}.`, 'ok');
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Fetch projects';
  }
}

async function submitReminder({ dryRun }) {
  const buckets = selectedBuckets();
  if (buckets.length === 0) return setStatus('Pick at least one age range.', 'error');

  const button = dryRun ? $('preview') : $('send');
  button.disabled = true;
  setStatus(dryRun ? 'Building preview…' : 'Sending…');

  try {
    const result = await api('/api/reminders', {
      method: 'POST',
      body: JSON.stringify({
        feedbackAppId: $('feedback-app').value,
        projectIds: selectedProjectIds(),
        buckets,
        dryRun,
      }),
    });

    if (dryRun) {
      $('preview-panel').hidden = false;
      $('preview-meta').textContent =
        `${result.totalRisks} findings across ${result.projects} project(s)` +
        (result.recipients.length ? ` → ${result.recipients.length} recipient(s)` : '');
      $('preview-frame').srcdoc = result.html;
      setStatus('Preview ready.', 'ok');
      $('preview-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      setStatus(
        `Reminder sent via ${result.via} to ${result.recipients.length} recipient(s) — ` +
          `${result.totalRisks} findings across ${result.projects} project(s).`,
        'ok',
      );
    }
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

$('fetch').addEventListener('click', fetchProjects);
$('filter').addEventListener('input', renderProjects);
$('preview').addEventListener('click', () => submitReminder({ dryRun: true }));
$('send').addEventListener('click', () => submitReminder({ dryRun: false }));
$('feedback-app').addEventListener('change', updateRecipientHint);
$('close-preview').addEventListener('click', () => {
  $('preview-panel').hidden = true;
});

$('select-all').addEventListener('change', (event) => {
  const filter = $('filter').value.trim().toLowerCase();
  const visible = state.projects.filter((p) => !filter || p.projectName.toLowerCase().includes(filter));
  for (const project of visible) {
    if (event.target.checked) state.selected.add(project.projectId);
    else state.selected.delete(project.projectId);
  }
  renderProjects();
});

$('projects-body').addEventListener('change', (event) => {
  const id = event.target.dataset.select;
  if (!id) return;
  if (event.target.checked) state.selected.add(id);
  else state.selected.delete(id);
});

loadHealth();
loadFeedbackApps();
