const $ = (id) => document.getElementById(id);

const state = {
  connection: null,
  projects: [],
  selected: new Set(),
  apps: [],
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
  setStatus('status', '');

  try {
    const result = await api('/api/scan');
    state.projects = result.projects.sort((a, b) => (b.counts['60+'] ?? 0) - (a.counts['60+'] ?? 0));
    state.selected.clear();
    $('select-all').checked = false;
    renderTotals(result.totals);
    renderProjects();
    setStatus('status', `Loaded ${result.totals.projects} projects from ${result.resolvedPath}.`, 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) setStatus('status', error.message, 'error');
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
    if (!handleAuthLoss(error)) setStatus('status', error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

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
