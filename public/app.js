const $ = (id) => document.getElementById(id);

const state = {
  connection: null,
  projects: [],
  selected: new Set(),
  apps: [],
  windowPresets: [],
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `${response.status} ${response.statusText}`);
    error.status = response.status;
    error.detail = payload.detail || '';
    throw error;
  }
  return payload;
}

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const formatDate = (iso) => (iso ? iso.slice(0, 10) : '—');

function setStatus(id, message, kind = '') {
  const el = $(id);
  el.textContent = message;
  el.className = `status ${kind}`;
}

/** Errors from Checkmarx carry a response body; it is usually the real answer. */
function showError(id, error) {
  setStatus(id, error.detail ? `${error.message} — ${error.detail}` : error.message, 'error');
}

// ---------------------------------------------------------------------------
// Connect screen
// ---------------------------------------------------------------------------

const REGION_LABELS = {
  us: 'US',
  us2: 'US 2',
  eu: 'EU',
  eu2: 'EU 2',
  deu: 'Germany',
  anz: 'Australia / NZ',
  ind: 'India',
  sng: 'Singapore',
  uae: 'UAE',
  mea: 'Middle East',
};

/**
 * Decode the pasted key in the browser purely to show what we detected before
 * the user commits. The server derives it again and is the actual authority.
 */
function previewKey(apiKey) {
  const payload = String(apiKey).trim().split('.')[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(
      decodeURIComponent(
        atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
          .split('')
          .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
          .join(''),
      ),
    );
    const match = String(json.iss ?? '').match(/^(https?:\/\/[^/]+)\/auth\/realms\/([^/?#]+)/);
    if (!match) return null;

    const [, iamUrl, tenant] = match;
    const host = new URL(iamUrl).host;
    const region = host.match(/^([a-z0-9-]+)\.(?:iam|ast)\./i)?.[1]?.toLowerCase() ?? (/^(iam|ast)\./i.test(host) ? 'us' : '');

    return {
      tenant: decodeURIComponent(tenant),
      iamUrl,
      baseUrl: `${new URL(iamUrl).protocol}//${host.replace(/^iam\./i, 'ast.').replace(/\.iam\./i, '.ast.')}`,
      regionLabel: REGION_LABELS[region] ?? (region ? region.toUpperCase() : 'Custom / single-tenant'),
      expiresAt: typeof json.exp === 'number' ? new Date(json.exp * 1000) : null,
    };
  } catch {
    return null;
  }
}

function renderDetected() {
  const box = $('detected');
  const value = $('api-key').value.trim();
  if (!value) {
    box.hidden = true;
    return;
  }

  const info = previewKey(value);
  if (!info) {
    box.hidden = false;
    box.className = 'detected warn';
    box.textContent = "Couldn't read a tenant from that key. It should be a JWT with three dot-separated parts — or set the values under Advanced.";
    return;
  }

  const expired = info.expiresAt && info.expiresAt.getTime() < Date.now();
  box.hidden = false;
  box.className = `detected ${expired ? 'warn' : 'ok'}`;
  box.innerHTML = `
    <div><span class="k">Tenant</span><span class="v">${escapeHtml(info.tenant)}</span></div>
    <div><span class="k">Region</span><span class="v">${escapeHtml(info.regionLabel)}</span></div>
    <div><span class="k">API URL</span><span class="v">${escapeHtml(info.baseUrl)}</span></div>
    <div><span class="k">IAM URL</span><span class="v">${escapeHtml(info.iamUrl)}</span></div>
    ${
      info.expiresAt
        ? `<div><span class="k">Key expires</span><span class="v">${info.expiresAt.toISOString().slice(0, 10)}${
            expired ? ' — expired' : ''
          }</span></div>`
        : ''
    }`;
}

function showConnected(session) {
  state.connection = session.connection;
  const { tenant, regionLabel, baseUrl } = session.connection;

  $('connection').textContent = `Connected to ${tenant} · ${regionLabel} · ${baseUrl}`;
  $('connection').className = 'sub ok';
  $('connect-panel').hidden = true;
  $('workspace').hidden = false;
  $('fetch').hidden = false;
  $('disconnect').hidden = false;
  $('api-key').value = '';
  $('detected').hidden = true;

  fillEndpointFields(session.paths);
  loadFeedbackApps();
}

function showDisconnected(message = 'Not connected.') {
  state.connection = null;
  state.projects = [];
  state.selected.clear();
  state.apps = [];

  $('connection').textContent = message;
  $('connection').className = 'sub';
  $('connect-panel').hidden = false;
  $('workspace').hidden = true;
  $('fetch').hidden = true;
  $('disconnect').hidden = true;
  $('totals-panel').hidden = true;
  $('preview-panel').hidden = true;
}

async function connect(event) {
  event.preventDefault();
  const button = $('connect');
  button.disabled = true;
  setStatus('connect-status', 'Verifying key against Checkmarx One…');

  try {
    const session = await api('/api/session', {
      method: 'POST',
      body: JSON.stringify({
        apiKey: $('api-key').value.trim(),
        iamUrl: $('iam-url').value.trim() || undefined,
        baseUrl: $('base-url').value.trim() || undefined,
        tenant: $('tenant').value.trim() || undefined,
      }),
    });
    setStatus('connect-status', '');
    showConnected(session);
  } catch (error) {
    setStatus('connect-status', error.message, 'error');
    // A bad host is the most likely cause of a non-credential failure.
    if (/reach|API URL|404/i.test(error.message)) $('advanced').open = true;
  } finally {
    button.disabled = false;
  }
}

async function disconnect() {
  await api('/api/session', { method: 'DELETE' }).catch(() => {});
  showDisconnected('Disconnected. Enter an API key to reconnect.');
}

// ---------------------------------------------------------------------------
// Scope (time windows)
// ---------------------------------------------------------------------------

function fillPresets(selectId, defaultId) {
  const select = $(selectId);
  select.innerHTML = state.windowPresets
    .map((preset) => `<option value="${preset.id}"${preset.id === defaultId ? ' selected' : ''}>${escapeHtml(preset.label)}</option>`)
    .join('');
}

function toggleRange(prefix) {
  $(`${prefix}-range`).hidden = $(`${prefix}-preset`).value !== 'custom';
  updateScopeSummary();
}

function windowParams() {
  const params = new URLSearchParams();
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

const presetLabel = (id) => state.windowPresets.find((p) => p.id === id)?.label ?? id;

function updateScopeSummary() {
  const activity = $('activity-preset').value;
  const detection = $('detection-preset').value;
  $('scope-summary').textContent = `Projects: ${presetLabel(activity)} · Findings: ${presetLabel(detection)}`;

  // A short detection window empties the older buckets; say so rather than
  // letting an empty "> 60 days" column look like a bug.
  const narrow = ['7d', '30d'].includes(detection);
  $('detection-hint').textContent = narrow
    ? `Only findings first seen in the ${presetLabel(detection).toLowerCase()} are counted, so the older age buckets will be empty.`
    : 'Counts only findings first seen in this window.';
}

// ---------------------------------------------------------------------------
// Endpoints & diagnostics
// ---------------------------------------------------------------------------

function fillEndpointFields(paths) {
  if (!paths) return;
  $('risks-path').value = paths.risksPath ?? '';
  $('feedback-list-path').value = paths.feedbackListPath ?? '';
  $('feedback-trigger-path').value = paths.feedbackTriggerPath ?? '';
}

async function saveEndpoints() {
  setStatus('endpoints-status', 'Saving…');
  try {
    const paths = await api('/api/endpoints', {
      method: 'PUT',
      body: JSON.stringify({
        risksPath: $('risks-path').value,
        feedbackListPath: $('feedback-list-path').value,
        feedbackTriggerPath: $('feedback-trigger-path').value,
      }),
    });
    fillEndpointFields(paths);
    setStatus('endpoints-status', 'Saved for this session.', 'ok');
    loadFeedbackApps();
  } catch (error) {
    if (!handleAuthLoss(error)) showError('endpoints-status', error);
  }
}

function renderProbe(report) {
  const box = $('probe-results');
  box.hidden = false;
  box.innerHTML = `
    <table class="probe">
      <thead><tr><th>Path</th><th class="num">Status</th><th>Response</th></tr></thead>
      <tbody>
        ${report.results
          .map(
            (row) => `
          <tr class="${row.ok ? 'hit' : 'miss'}">
            <td><code>${escapeHtml(row.template)}</code></td>
            <td class="num">${row.ok ? '200 ✓' : row.status || 'error'}</td>
            <td class="snippet">${escapeHtml(
              row.ok ? `${row.itemCount} item(s) returned` : row.snippet || row.error || '',
            )}</td>
          </tr>`,
          )
          .join('')}
      </tbody>
    </table>
    <p class="hint">${
      report.match
        ? `Found: <code>${escapeHtml(report.match)}</code> — it has been filled in above, click Save paths to keep it.`
        : 'None of the known candidates answered. Paste the correct path from your tenant\'s API reference above and save it.'
    }</p>`;
}

async function detect(target, button) {
  button.disabled = true;
  setStatus('endpoints-status', 'Probing candidate paths…');
  try {
    const report = await api('/api/discover', { method: 'POST', body: JSON.stringify({ target }) });
    renderProbe(report);
    if (report.match) {
      if (target === 'risks') {
        $('risks-path').value = report.match;
      } else {
        $('feedback-list-path').value = report.match;
        // The trigger path shares the list path's prefix; keep them in step so
        // a corrected list path does not leave sending pointed at the old one.
        if (report.suggestedTriggerPath) $('feedback-trigger-path').value = report.suggestedTriggerPath;
      }
      setStatus('endpoints-status', 'Found a working path — click Save paths.', 'ok');
    } else {
      setStatus('endpoints-status', 'No candidate answered. See the table below.', 'error');
    }
  } catch (error) {
    if (!handleAuthLoss(error)) showError('endpoints-status', error);
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Workspace
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
    .map(([label, value]) => `<div><span class="value">${value}</span><span class="label">${label}</span></div>`)
    .join('');
}

const cell = (count) => (count > 0 ? `<td class="num">${count}</td>` : '<td class="num zero">0</td>');

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
      <tr data-id="${escapeHtml(project.projectId)}">
        <td class="checkbox">
          <input type="checkbox" data-select="${escapeHtml(project.projectId)}" ${
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

function handleAuthLoss(error) {
  if (error.status === 401) {
    showDisconnected('Session expired. Enter your API key again.');
    return true;
  }
  return false;
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
    if (handleAuthLoss(error)) return;
    select.innerHTML = '<option value="">Could not load feedback apps</option>';
    $('recipients-hint').textContent = error.detail ? `${error.message} — ${error.detail}` : error.message;
    $('recipients-hint').className = 'hint error-hint';
    $('endpoints').open = true;
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
  setStatus('status', '');

  try {
    const result = await api(`/api/scan?${windowParams()}`);
    state.projects = result.projects.sort((a, b) => (b.counts['60+'] ?? 0) - (a.counts['60+'] ?? 0));
    state.selected.clear();
    $('select-all').checked = false;
    renderTotals(result.totals);
    renderProjects();

    const scoped =
      result.projectsSkipped > 0
        ? ` (${result.projectsSkipped} of ${result.projectsTotal} skipped — not scanned in ${result.windows.activity.label.toLowerCase()})`
        : '';
    const failed = result.projects.filter((p) => p.error).length;
    setStatus(
      'status',
      `Loaded ${result.totals.projects} projects${scoped}.` +
        (failed ? ` ${failed} could not be read — open Endpoints & diagnostics.` : ''),
      failed ? 'error' : 'ok',
    );
    if (result.warning) console.warn(result.warning);
  } catch (error) {
    if (!handleAuthLoss(error)) showError('status', error);
  } finally {
    button.disabled = false;
    button.textContent = 'Fetch projects';
  }
}

async function submitReminder({ dryRun }) {
  const buckets = [...document.querySelectorAll('input[name="bucket"]:checked')].map((i) => i.value);
  if (buckets.length === 0) return setStatus('status', 'Pick at least one age range.', 'error');

  const button = dryRun ? $('preview') : $('send');
  button.disabled = true;
  setStatus('status', dryRun ? 'Building preview…' : 'Sending…');

  try {
    const result = await api('/api/reminders', {
      method: 'POST',
      body: JSON.stringify({
        feedbackAppId: $('feedback-app').value,
        projectIds: state.selected.size > 0 ? [...state.selected] : null,
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
      setStatus('status', 'Preview ready.', 'ok');
      $('preview-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      setStatus(
        'status',
        `Reminder sent via ${result.via} to ${result.recipients.length} recipient(s) — ` +
          `${result.totalRisks} findings across ${result.projects} project(s).`,
        'ok',
      );
    }
  } catch (error) {
    if (!handleAuthLoss(error)) showError('status', error);
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

$('activity-preset').addEventListener('change', () => toggleRange('activity'));
$('detection-preset').addEventListener('change', () => toggleRange('detection'));
$('save-endpoints').addEventListener('click', saveEndpoints);
$('detect-risks').addEventListener('click', (e) => detect('risks', e.target));
$('detect-feedback').addEventListener('click', (e) => detect('feedbackApps', e.target));
$('connect-form').addEventListener('submit', connect);
$('disconnect').addEventListener('click', disconnect);
$('api-key').addEventListener('input', renderDetected);
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
  for (const project of state.projects.filter((p) => !filter || p.projectName.toLowerCase().includes(filter))) {
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

(async function init() {
  try {
    const health = await api('/api/health');
    for (const problem of health.problems) console.warn(problem);
    state.windowPresets = health.windowPresets ?? [];
    fillPresets('activity-preset', 'any');
    fillPresets('detection-preset', 'any');
    updateScopeSummary();
  } catch {
    /* health is advisory only */
  }

  try {
    const session = await api('/api/session');
    if (session.connected) showConnected(session);
    else showDisconnected('Not connected — enter your Checkmarx One API key below.');
  } catch (error) {
    showDisconnected(error.message);
  }
})();
