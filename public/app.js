const $ = (id) => document.getElementById(id);

const state = {
  connection: null,
  settings: null,
  health: null,
  projects: [],
  selected: new Set(),
  sort: { key: '60+', dir: 'desc' },
  lastScan: null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const formatDate = (iso) => (iso ? String(iso).slice(0, 10) : '—');

function setStatus(id, message, kind = '') {
  const el = $(id);
  el.textContent = message;
  el.className = `status ${kind}`;
}

/** Errors from Checkmarx and SMTP carry a detail body; it is usually the answer. */
function showError(id, error) {
  setStatus(id, error.detail ? `${error.message} — ${error.detail}` : error.message, 'error');
}

function handleAuthLoss(error) {
  if (error.status === 401) {
    showDisconnected('Session expired. Enter your API key again.');
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function route() {
  const name = (location.hash.replace('#/', '') || 'dashboard').split('?')[0];
  const target = ['dashboard', 'settings'].includes(name) ? name : 'dashboard';
  if (!state.connection) return;

  for (const page of ['dashboard', 'settings']) {
    $(`page-${page}`).hidden = page !== target;
  }
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.route === target);
  }
  if (target === 'settings') renderSettings();
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

const REGION_LABELS = {
  us: 'US', us2: 'US 2', eu: 'EU', eu2: 'EU 2', deu: 'Germany',
  anz: 'Australia / NZ', ind: 'India', sng: 'Singapore', uae: 'UAE', mea: 'Middle East',
};

/** Decode the pasted key locally just to show what was detected. */
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
    const region =
      host.match(/^([a-z0-9-]+)\.(?:iam|ast)\./i)?.[1]?.toLowerCase() ??
      (/^(iam|ast)\./i.test(host) ? 'us' : '');

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
    box.textContent =
      "Couldn't read a tenant from that key. It should be a JWT with three dot-separated parts — or set the values under Advanced.";
    return;
  }

  const expired = info.expiresAt && info.expiresAt.getTime() < Date.now();
  box.hidden = false;
  box.className = `detected ${expired ? 'warn' : 'ok'}`;
  box.innerHTML = `
    <div><span class="k">Tenant</span><span class="v">${escapeHtml(info.tenant)}</span></div>
    <div><span class="k">Region</span><span class="v">${escapeHtml(info.regionLabel)}</span></div>
    <div><span class="k">API URL</span><span class="v">${escapeHtml(info.baseUrl)}</span></div>
    ${info.expiresAt ? `<div><span class="k">Key expires</span><span class="v">${info.expiresAt.toISOString().slice(0, 10)}${expired ? ' — expired' : ''}</span></div>` : ''}`;
}

async function showConnected(session) {
  state.connection = session.connection;
  const { tenant, regionLabel, baseUrl } = session.connection;

  $('connection').textContent = `${tenant} · ${regionLabel} · ${baseUrl}`;
  $('connection').className = 'sub ok';
  $('connect-panel').hidden = true;
  $('nav').hidden = false;
  $('disconnect').hidden = false;
  $('api-key').value = '';
  $('detected').hidden = true;

  if (!location.hash) location.hash = '#/dashboard';
  await loadSettings();
  route();
}

function showDisconnected(message = 'Not connected.') {
  state.connection = null;
  state.projects = [];
  state.selected.clear();

  $('connection').textContent = message;
  $('connection').className = 'sub';
  $('connect-panel').hidden = false;
  $('nav').hidden = true;
  $('disconnect').hidden = true;
  for (const page of ['dashboard', 'settings']) $(`page-${page}`).hidden = true;
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
    await showConnected(session);
  } catch (error) {
    showError('connect-status', error);
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
// Settings page
// ---------------------------------------------------------------------------

async function loadSettings() {
  try {
    state.settings = await api('/api/settings');
    renderRecipientHint();
  } catch (error) {
    if (!handleAuthLoss(error)) console.warn(error.message);
  }
}

function renderSettings() {
  const s = state.settings;
  if (!s) return;

  const c = state.connection ?? {};
  $('connection-details').innerHTML = [
    ['Tenant', c.tenant],
    ['Region', c.regionLabel],
    ['API URL', c.baseUrl],
    ['IAM URL', c.iamUrl],
    ['Key expires', formatDate(c.expiresAt)],
  ]
    .map(([k, v]) => `<div><span class="k">${k}</span><span class="v">${escapeHtml(v ?? '—')}</span></div>`)
    .join('');

  $('smtp-host').value = s.smtp.host;
  $('smtp-port').value = s.smtp.port;
  $('smtp-secure').checked = s.smtp.secure;
  $('smtp-auth').checked = s.smtp.requireAuth;
  $('smtp-reject').checked = s.smtp.rejectUnauthorized;
  $('smtp-user').value = s.smtp.user;
  $('smtp-from-name').value = s.smtp.fromName;
  $('smtp-from-address').value = s.smtp.fromAddress;
  $('password-state').textContent = s.smtp.passwordSet ? '(stored)' : '(not set)';
  $('smtp-credentials').hidden = !s.smtp.requireAuth;

  $('rcpt-to').value = s.recipients.to.join('\n');
  $('rcpt-cc').value = s.recipients.cc.join('\n');
  $('rcpt-bcc').value = s.recipients.bcc.join('\n');

  $('tpl-subject').value = s.template.subject;
  $('tpl-html').value = s.template.html;
  $('risks-path').value = s.endpoints.risksPath;

  $('verified-state').textContent = s.verified
    ? `Connection test passed ${formatDate(s.verifiedAt)}. Sending is enabled.`
    : 'No successful connection test for the current settings — sending is disabled.';
  $('verified-state').className = `hint ${s.verified ? 'ok-hint' : 'error-hint'}`;

  $('variable-list').innerHTML = (state.health?.templateVariables ?? [])
    .map(
      (v) =>
        `<div><span class="k"><code>{{${escapeHtml(v.name)}}}</code></span><span class="v">${escapeHtml(v.description)}</span></div>`,
    )
    .join('');
}

/** Everything on the settings form, as the API expects it. */
function settingsPayload() {
  const payload = {
    smtp: {
      host: $('smtp-host').value,
      port: Number($('smtp-port').value),
      secure: $('smtp-secure').checked,
      requireAuth: $('smtp-auth').checked,
      rejectUnauthorized: $('smtp-reject').checked,
      user: $('smtp-user').value,
      fromName: $('smtp-from-name').value,
      fromAddress: $('smtp-from-address').value,
    },
    recipients: { to: $('rcpt-to').value, cc: $('rcpt-cc').value, bcc: $('rcpt-bcc').value },
    template: { subject: $('tpl-subject').value, html: $('tpl-html').value },
    endpoints: { risksPath: $('risks-path').value },
  };
  // Only send a password when one was typed, so saving an unrelated field
  // never has to round-trip the stored secret through the browser.
  if ($('smtp-password').value) payload.smtp.password = $('smtp-password').value;
  return payload;
}

async function saveSettings() {
  setStatus('save-status', 'Saving…');
  try {
    state.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(settingsPayload()) });
    $('smtp-password').value = '';
    renderSettings();
    renderRecipientHint();
    setStatus('save-status', 'Saved.', 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('save-status', error);
  }
}

async function testSmtp() {
  const button = $('test-smtp');
  button.disabled = true;
  setStatus('smtp-status', 'Connecting…');
  try {
    // Send the whole form: the server saves it before testing, so a test
    // never silently discards recipients or template edits made alongside.
    const result = await api('/api/settings/smtp/test', {
      method: 'POST',
      body: JSON.stringify(settingsPayload()),
    });
    state.settings = result.settings;
    $('smtp-password').value = '';
    renderSettings();
    setStatus('smtp-status', result.message, 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('smtp-status', error);
    await loadSettings();
    renderSettings();
  } finally {
    button.disabled = false;
  }
}

async function sendTestEmail() {
  const button = $('send-test');
  button.disabled = true;
  setStatus('smtp-status', 'Sending test message…');
  try {
    const result = await api('/api/settings/smtp/send-test', {
      method: 'POST',
      body: JSON.stringify({ to: $('test-to').value }),
    });
    setStatus('smtp-status', `Test message accepted for ${result.accepted.join(', ') || 'delivery'}.`, 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('smtp-status', error);
  } finally {
    button.disabled = false;
  }
}

async function previewTemplate() {
  setStatus('template-status', 'Rendering…');
  try {
    const result = await api('/api/settings/template/preview', {
      method: 'POST',
      body: JSON.stringify({ subject: $('tpl-subject').value, html: $('tpl-html').value }),
    });
    $('template-preview-wrap').hidden = false;
    $('template-subject-preview').textContent = `Subject: ${result.subject}`;
    $('template-preview').srcdoc = result.html;
    setStatus('template-status', 'Rendered.', 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('template-status', error);
  }
}

async function detectRisksPath() {
  const button = $('detect-risks');
  button.disabled = true;
  setStatus('save-status', 'Probing candidate paths…');
  try {
    const report = await api('/api/discover', { method: 'POST', body: JSON.stringify({}) });
    $('probe-results').hidden = false;
    $('probe-results').innerHTML = `
      <table class="probe">
        <thead><tr><th>Path</th><th class="num">Status</th><th>Response</th></tr></thead>
        <tbody>${report.results
          .map(
            (row) => `<tr class="${row.ok ? 'hit' : 'miss'}">
              <td><code>${escapeHtml(row.template)}</code></td>
              <td class="num">${row.ok ? '200 ✓' : row.status || 'error'}</td>
              <td class="snippet">${escapeHtml(row.ok ? `${row.itemCount} item(s)` : row.snippet || row.error || '')}</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>`;
    if (report.match) {
      $('risks-path').value = report.match;
      setStatus('save-status', 'Found a working path — click Save settings.', 'ok');
    } else {
      setStatus('save-status', 'No candidate answered; see the table.', 'error');
    }
  } catch (error) {
    if (!handleAuthLoss(error)) showError('save-status', error);
  } finally {
    button.disabled = false;
  }
}

function renderRecipientHint() {
  const s = state.settings;
  const el = $('recipients-hint');
  if (!s) return;

  const { to, cc, bcc } = s.recipients;
  const total = to.length + cc.length + bcc.length;

  if (!s.verified) {
    el.textContent = 'SMTP has not passed a connection test — sending is disabled.';
    el.className = 'hint error-hint';
  } else if (total === 0) {
    el.textContent = 'No recipients configured.';
    el.className = 'hint error-hint';
  } else {
    el.textContent =
      `${to.length} to${cc.length ? `, ${cc.length} cc` : ''}${bcc.length ? `, ${bcc.length} bcc` : ''}` +
      ` — ${to.slice(0, 3).join(', ')}${to.length > 3 ? ', …' : ''}`;
    el.className = 'hint';
  }
  $('send').disabled = !s.verified || total === 0;
}

// ---------------------------------------------------------------------------
// Dashboard: scope
// ---------------------------------------------------------------------------

function fillPresets(selectId, defaultId) {
  $(selectId).innerHTML = (state.health?.windowPresets ?? [])
    .map((p) => `<option value="${p.id}"${p.id === defaultId ? ' selected' : ''}>${escapeHtml(p.label)}</option>`)
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

const presetLabel = (id) => state.health?.windowPresets.find((p) => p.id === id)?.label ?? id;

function updateScopeSummary() {
  const detection = $('detection-preset').value;
  $('scope-summary').textContent =
    `Projects: ${presetLabel($('activity-preset').value)} · Findings: ${presetLabel(detection)}`;

  $('detection-hint').textContent = ['7d', '30d'].includes(detection)
    ? `Only findings first seen in the ${presetLabel(detection).toLowerCase()} are counted, so the older age buckets will be empty.`
    : 'Sent to the API as fromDate/toDate, so it is filtered server-side.';
}

// ---------------------------------------------------------------------------
// Dashboard: table
// ---------------------------------------------------------------------------

function visibleProjects() {
  const text = $('filter').value.trim().toLowerCase();
  const severity = $('severity-filter').value;
  const bucket = $('bucket-filter').value;
  const hideEmpty = $('hide-empty').checked;

  const rows = state.projects.filter((p) => {
    if (text && !p.projectName.toLowerCase().includes(text)) return false;
    if (severity && !(p.bySeverity?.[severity] > 0)) return false;
    if (bucket && !(p.counts?.[bucket] > 0)) return false;
    if (hideEmpty && p.totalRisks === 0) return false;
    return true;
  });

  const { key, dir } = state.sort;
  const value = (p) =>
    key === 'projectName' ? p.projectName.toLowerCase() : key in p ? p[key] ?? 0 : p.counts?.[key] ?? 0;

  return rows.sort((a, b) => {
    const [x, y] = [value(a), value(b)];
    if (x === y) return a.projectName.localeCompare(b.projectName);
    return (x > y ? 1 : -1) * (dir === 'asc' ? 1 : -1);
  });
}

const cell = (count) => (count > 0 ? `<td class="num">${count}</td>` : '<td class="num zero">0</td>');

function renderProjects() {
  const rows = visibleProjects();
  const body = $('projects-body');

  if (rows.length === 0) {
    body.innerHTML = `<tr class="empty"><td colspan="7">${
      state.projects.length ? 'No projects match these filters.' : 'No data yet.'
    }</td></tr>`;
  } else {
    body.innerHTML = rows
      .map((p) => {
        const aged = p.counts['60+'] ?? 0;
        return `
        <tr data-id="${escapeHtml(p.projectId)}">
          <td class="checkbox"><input type="checkbox" data-select="${escapeHtml(p.projectId)}" ${
            state.selected.has(p.projectId) ? 'checked' : ''
          } /></td>
          <td class="name">${escapeHtml(p.projectName)}${
            p.error ? `<span class="err">${escapeHtml(p.error)}</span>` : ''
          }</td>
          <td class="num">${p.totalRisks}</td>
          ${cell(p.counts['0-30'] ?? 0)}
          ${cell(p.counts['31-60'] ?? 0)}
          <td class="num ${aged > 0 ? 'aged' : 'zero'}">${aged}</td>
          <td>${formatDate(p.oldestFirstDetectedAt)}${
            p.maxAgeDays === null ? '' : ` <span class="zero">(${p.maxAgeDays}d)</span>`
          }</td>
        </tr>`;
      })
      .join('');
  }

  const selectedCount = state.selected.size;
  $('table-meta').textContent =
    `${rows.length} of ${state.projects.length} project(s) shown` +
    (selectedCount ? ` · ${selectedCount} selected (reminder covers only these)` : ' · none selected (reminder covers all)');

  for (const th of document.querySelectorAll('#projects th[data-sort]')) {
    th.classList.toggle('sorted', th.dataset.sort === state.sort.key);
    th.dataset.dir = th.dataset.sort === state.sort.key ? state.sort.dir : '';
  }
}

function renderTotals(totals) {
  $('totals-panel').hidden = false;
  const counts = totals.counts ?? {};
  const sev = totals.severities ?? {};
  $('totals').innerHTML = [
    ['Projects', totals.projects],
    ['Open findings', totals.risks],
    ['≤ 30 days', counts['0-30'] ?? 0],
    ['31–60 days', counts['31-60'] ?? 0],
    ['> 60 days', counts['60+'] ?? 0],
    ['Critical', sev.CRITICAL ?? 0],
    ['High', sev.HIGH ?? 0],
    ['Unknown date', counts.unknown ?? 0],
  ]
    .map(([label, v]) => `<div><span class="value">${v}</span><span class="label">${label}</span></div>`)
    .join('');
}

async function fetchProjects() {
  const button = $('fetch');
  button.disabled = true;
  button.textContent = 'Fetching…';
  setStatus('status', '');

  try {
    const result = await api(`/api/scan?${windowParams()}`);
    state.lastScan = result;
    state.projects = result.projects;
    state.selected.clear();
    $('select-all').checked = false;
    renderTotals(result.totals);
    renderProjects();

    const failed = result.projects.filter((p) => p.error).length;
    const skipped = result.projectsSkipped
      ? `, ${result.projectsSkipped} of ${result.projectsTotal} skipped (not scanned in ${result.windows.activity.label.toLowerCase()})`
      : '';
    $('fetch-meta').textContent =
      `${result.totals.risks} finding(s) in ${(result.elapsedMs / 1000).toFixed(1)}s via ${result.resolvedPath}` +
      (result.stats?.requests ? ` · ${result.stats.requests} API request(s)` : '');
    setStatus(
      'status',
      `Loaded ${result.totals.projects} project(s)${skipped}.` +
        (failed ? ` ${failed} could not be read — check the risks endpoint in Settings.` : ''),
      failed ? 'error' : 'ok',
    );
    if (result.warning) console.warn(result.warning);
  } catch (error) {
    if (!handleAuthLoss(error)) showError('status', error);
  } finally {
    button.disabled = false;
    button.textContent = 'Fetch vulnerability data';
  }
}

async function submitReminder({ dryRun }) {
  const buckets = [...document.querySelectorAll('input[name="bucket"]:checked')].map((i) => i.value);
  if (buckets.length === 0) return setStatus('status', 'Pick at least one age range.', 'error');

  const button = dryRun ? $('preview') : $('send');
  button.disabled = true;
  setStatus('status', dryRun ? 'Building preview…' : 'Sending…');

  try {
    const severity = $('severity-filter').value;
    const result = await api('/api/reminders', {
      method: 'POST',
      body: JSON.stringify({
        projectIds: state.selected.size > 0 ? [...state.selected] : null,
        severities: severity ? [severity] : null,
        buckets,
        dryRun,
      }),
    });

    if (dryRun) {
      $('preview-panel').hidden = false;
      const r = result.recipients;
      $('preview-meta').textContent =
        `${result.totalRisks} findings across ${result.projects} project(s) → ` +
        `${r.to.length} to, ${r.cc.length} cc, ${r.bcc.length} bcc` +
        (result.canSend ? '' : ' — SMTP not verified, sending is disabled');
      $('preview-frame').srcdoc = result.html;
      setStatus('status', 'Preview ready.', 'ok');
      $('preview-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      setStatus(
        'status',
        `Sent to ${result.accepted.length} recipient(s) — ${result.totalRisks} findings across ${result.projects} project(s).` +
          (result.rejected.length ? ` ${result.rejected.length} rejected.` : ''),
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

window.addEventListener('hashchange', route);

$('connect-form').addEventListener('submit', connect);
$('disconnect').addEventListener('click', disconnect);
$('api-key').addEventListener('input', renderDetected);
$('reconnect').addEventListener('click', disconnect);

$('activity-preset').addEventListener('change', () => toggleRange('activity'));
$('detection-preset').addEventListener('change', () => toggleRange('detection'));
$('fetch').addEventListener('click', fetchProjects);

for (const id of ['filter', 'severity-filter', 'bucket-filter', 'hide-empty']) {
  $(id).addEventListener('input', renderProjects);
}

$('preview').addEventListener('click', () => submitReminder({ dryRun: true }));
$('send').addEventListener('click', () => submitReminder({ dryRun: false }));
$('close-preview').addEventListener('click', () => {
  $('preview-panel').hidden = true;
});

$('save-settings').addEventListener('click', saveSettings);
$('test-smtp').addEventListener('click', testSmtp);
$('send-test').addEventListener('click', sendTestEmail);
$('preview-template').addEventListener('click', previewTemplate);
$('detect-risks').addEventListener('click', detectRisksPath);
$('smtp-auth').addEventListener('change', () => {
  $('smtp-credentials').hidden = !$('smtp-auth').checked;
});
$('reset-template').addEventListener('click', async () => {
  const health = state.health ?? {};
  $('tpl-subject').value = health.defaultTemplate?.subject ?? $('tpl-subject').value;
  $('tpl-html').value = health.defaultTemplate?.html ?? $('tpl-html').value;
  setStatus('template-status', 'Default restored — click Save settings to keep it.', 'ok');
});

for (const th of document.querySelectorAll('#projects th[data-sort]')) {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    state.sort =
      state.sort.key === key
        ? { key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'projectName' ? 'asc' : 'desc' };
    renderProjects();
  });
}

$('select-all').addEventListener('change', (event) => {
  for (const project of visibleProjects()) {
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
  renderProjects();
});

(async function init() {
  try {
    state.health = await api('/api/health');
    for (const problem of state.health.problems) console.warn(problem);
    fillPresets('activity-preset', 'any');
    fillPresets('detection-preset', 'any');
    updateScopeSummary();
  } catch {
    /* health is advisory only */
  }

  try {
    const session = await api('/api/session');
    if (session.connected) await showConnected(session);
    else showDisconnected('Not connected — enter your Checkmarx One API key below.');
  } catch (error) {
    showDisconnected(error.message);
  }
})();
