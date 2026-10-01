const $ = (id) => document.getElementById(id);

const state = {
  connection: null,
  settings: null,
  health: null,
  projects: [],
  selected: new Set(),
  sort: { key: '60+', dir: 'desc' },
  // Set once the operator opens a fully-resolved list on purpose.
  showAllInitiators: false,
  automation: null,
  initiators: [],
  pickedInitiators: new Set(),
  lastScan: null,
  logs: [],
};

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const logger = {
  logs: [],
  maxLogs: 500,

  add(message, type = 'info', details = {}) {
    const timestamp = new Date().toISOString();
    const log = { timestamp, type, message, details };
    this.logs.push(log);
    if (this.logs.length > this.maxLogs) this.logs.shift();
    renderLogs();
  },

  apiCall(method, path) {
    this.add(`API ${method} ${path}`, 'api', { method, path });
  },

  apiSuccess(method, path, status) {
    this.add(`✓ ${method} ${path} (${status})`, 'success', { method, path, status });
  },

  apiError(method, path, error) {
    this.add(
      `✗ ${method} ${path} — ${error.message || error}`,
      'error',
      { method, path, error: error.message || String(error), status: error.status },
    );
  },

  clear() {
    this.logs = [];
    renderLogs();
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function api(path, options = {}) {
  const method = options.method || 'GET';
  logger.apiCall(method, path);

  try {
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
      logger.apiError(method, path, error);
      throw error;
    }
    logger.apiSuccess(method, path, response.status);
    return payload;
  } catch (error) {
    if (error.status === undefined) {
      logger.apiError(method, path, new Error('fetch failed - network error'));
    }
    throw error;
  }
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
    showSignIn({ message: 'Your session ended. Sign in again.' });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Who is signed in, and what they may do
// ---------------------------------------------------------------------------

const can = (permission) => Boolean(state.me?.permissions?.includes(permission));
const canAny = (list) => String(list).split(/\s+/).filter(Boolean).some(can);

/** Which permissions open each page (any one of them). */
const PAGE_PERMS = {
  dashboard: '',
  reports: 'reports.view',
  audit: 'audit.view backup.view',
  settings: 'settings.view',
  access: 'iam.view',
  beta: 'beta.use',
  logs: '',
};

/**
 * Show only what this person may use: [data-perm] elements need any one of
 * the listed permissions; [data-edit-perm] panels turn read-only without it.
 */
function applyPermissions() {
  for (const el of document.querySelectorAll('[data-perm]')) el.classList.toggle('perm-hidden', !canAny(el.dataset.perm));
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
// Routing
// ---------------------------------------------------------------------------

function route() {
  const name = (location.hash.replace('#/', '') || 'dashboard').split('?')[0];
  if (!state.me) return;
  const allowed = (page) => page in PAGE_PERMS && (!PAGE_PERMS[page] || canAny(PAGE_PERMS[page]));
  const target = allowed(name) ? name : 'dashboard';
  if (target !== name && location.hash) history.replaceState(null, '', '#/dashboard');

  for (const page of Object.keys(PAGE_PERMS)) {
    $(`page-${page}`).hidden = page !== target;
  }
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.route === target);
    if (tab.dataset.route === target) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  setPageTitle(target);
  if (target === 'settings') {
    renderSettings();
    loadAutomation();
    loadCredits();
  } else if (target === 'logs') {
    renderLogsPage();
  } else if (target === 'reports') {
    loadTrackedReports();
  } else if (target === 'beta') {
    renderBeta();
  } else if (target === 'audit') {
    renderAudit();
  } else if (target === 'access') {
    loadAccess();
  }
}

const PAGE_TITLES = {
  connect: ['Sign in', 'Checkmarx One reminders, triage & credits for your security team'],
  dashboard: ['Dashboard', 'Find ageing findings, allocate credits and remind their owners'],
  reports: ['Tracked reports', 'Follow progress on saved scopes and send follow-ups'],
  settings: ['Settings', 'Email, templates, automation, AI credits and branding'],
  logs: ['Logs', 'API calls and results from this browser session'],
  access: ['Access', 'Who can sign in, their roles, and what each role may do'],
  audit: ['Audit', 'Every credit spent, refused or failed — who, when, where, and the balance after'],
  beta: ['Beta features', 'Experimental: code authors and GitHub identities'],
};

function setPageTitle(page) {
  const [title, sub] = PAGE_TITLES[page] ?? PAGE_TITLES.dashboard;
  $('page-title').textContent = title;
  $('page-sub').textContent = sub;
}

// ---------------------------------------------------------------------------
// Theme: follow the device, or light / dark as chosen (kept in this browser)
// ---------------------------------------------------------------------------

const THEMES = ['auto', 'light', 'dark'];
const THEME_LABELS = { auto: 'Theme: follow the device', light: 'Theme: light', dark: 'Theme: dark' };

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  $('theme-toggle').title = THEME_LABELS[theme] ?? THEME_LABELS.auto;
  try {
    if (theme === 'auto') localStorage.removeItem('mz-theme');
    else localStorage.setItem('mz-theme', theme);
  } catch {}
}

$('theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme || 'auto';
  applyTheme(THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]);
});
$('theme-toggle').title = THEME_LABELS[document.documentElement.dataset.theme || 'auto'];

// Settings: jump links scroll to their section (the address bar keeps the page route).
document.querySelector('.section-nav')?.addEventListener('click', (event) => {
  const link = event.target.closest('a[href^="#set-"]');
  if (!link) return;
  event.preventDefault();
  document.getElementById(link.getAttribute('href').slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
if ('IntersectionObserver' in window) {
  const links = new Map([...document.querySelectorAll('.section-nav a')].map((a) => [a.getAttribute('href').slice(1), a]));
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const a of links.values()) a.classList.remove('active');
        const link = links.get(entry.target.id);
        if (!link) continue;
        link.classList.add('active');
        // Scroll only the chip strip, never the page (that would cut a jump short).
        const strip = link.parentElement;
        const left = link.offsetLeft - (strip.clientWidth - link.offsetWidth) / 2;
        strip.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
      }
    },
    { rootMargin: '-35% 0px -60% 0px' },
  );
  for (const id of links.keys()) {
    const section = document.getElementById(id);
    if (section) observer.observe(section);
  }
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

/** Signed in: show the workspace this person may use. */
async function showConnected(me) {
  state.me = me;
  state.connection = me.connection;
  for (const box of ['setup-box', 'signin-box', 'change-box']) $(box).hidden = true;

  if (me.connection) {
    const { tenant, regionLabel, baseUrl } = me.connection;
    $('connection').textContent = `${tenant} · ${regionLabel} · ${baseUrl}`;
    $('connection').className = 'sub conn-pill ok';
  } else {
    $('connection').textContent = 'Checkmarx One not connected';
    $('connection').className = 'sub conn-pill error';
  }
  const user = me.user;
  $('me-name').textContent = user.name || user.email;
  $('me-role').textContent = me.role.name;
  $('me-avatar').textContent = (user.name || user.email).trim()[0]?.toUpperCase() ?? '?';
  $('me-detail').textContent = `${user.email} · ${me.role.name} · signed in with ${me.via === 'cxone' ? 'a Checkmarx One key' : 'a password'}`;
  $('user-menu').hidden = false;
  $('connect-panel').hidden = true;
  $('nav').hidden = false;
  $('api-key').value = '';
  $('signin-password').value = '';
  $('detected').hidden = true;
  applyPermissions();

  if (!location.hash) location.hash = '#/dashboard';
  await loadSettings();
  applyPermissions();
  route();
  loadReportServer();
  if (!me.connection) {
    setStatus('status', can('integration.cxone')
      ? 'Connect this server to Checkmarx One under Settings → Checkmarx One before fetching.'
      : 'Checkmarx One is not connected on this server yet. Ask an Admin to connect it.', 'error');
  }
}

/** Not signed in: setup (first start), sign-in, or a required password change. */
function showSignIn({ setup = false, change = false, message = '' } = {}) {
  state.me = null;
  state.connection = null;
  state.projects = [];
  state.selected.clear();
  $('connection').textContent = setup ? 'First start' : 'Signed out';
  $('connection').className = 'sub conn-pill';
  setPageTitle('connect');
  $('page-title').textContent = setup ? 'Welcome' : change ? 'New password' : 'Sign in';
  $('connect-panel').hidden = false;
  $('setup-box').hidden = !setup;
  $('signin-box').hidden = setup || change;
  $('change-box').hidden = !change;
  $('change-cancel').hidden = change;
  $('change-current-field').hidden = false;
  $('nav').hidden = true;
  $('user-menu').hidden = true;
  $('user-menu').open = false;
  for (const page of Object.keys(PAGE_PERMS)) $(`page-${page}`).hidden = true;
  if (message) setStatus(setup ? 'setup-status' : change ? 'change-status' : 'signin-status', message, 'error');
}
const showDisconnected = (message) => showSignIn({ message });

function afterSignIn(me) {
  if (me.user?.mustChangePassword && me.via === 'password') {
    state.pendingMe = me;
    showSignIn({ change: true });
    return;
  }
  return showConnected(me);
}

async function connect(event) {
  event.preventDefault();
  const button = $('connect');
  button.disabled = true;
  setStatus('connect-status', 'Verifying key against Checkmarx One…');
  try {
    const me = await api('/api/session', {
      method: 'POST',
      body: JSON.stringify({
        apiKey: $('api-key').value.trim(),
        iamUrl: $('iam-url').value.trim() || undefined,
        baseUrl: $('base-url').value.trim() || undefined,
        tenant: $('tenant').value.trim() || undefined,
      }),
    });
    setStatus('connect-status', '');
    await afterSignIn(me);
  } catch (error) {
    showError('connect-status', error);
  } finally {
    button.disabled = false;
  }
}

async function signInWithPassword(event) {
  event.preventDefault();
  const button = $('signin-submit');
  button.disabled = true;
  setStatus('signin-status', 'Signing in…');
  try {
    const me = await api('/api/session/password', {
      method: 'POST',
      body: JSON.stringify({ email: $('signin-email').value.trim(), password: $('signin-password').value }),
    });
    setStatus('signin-status', '');
    $('signin-password').value = '';
    await afterSignIn(me);
  } catch (error) {
    showError('signin-status', error);
  } finally {
    button.disabled = false;
  }
}

async function createFirstAdmin(event) {
  event.preventDefault();
  if ($('setup-password').value !== $('setup-password2').value) return setStatus('setup-status', 'The passwords do not match.', 'error');
  setStatus('setup-status', 'Creating…');
  try {
    const me = await api('/api/setup', {
      method: 'POST',
      body: JSON.stringify({
        code: $('setup-code').value.trim(),
        name: $('setup-name').value.trim(),
        email: $('setup-email').value.trim(),
        password: $('setup-password').value,
      }),
    });
    for (const id of ['setup-password', 'setup-password2', 'setup-code']) $(id).value = '';
    setStatus('setup-status', '');
    location.hash = '#/access';
    await showConnected(me);
  } catch (error) {
    showError('setup-status', error);
  }
}

async function changePassword(event) {
  event.preventDefault();
  if ($('change-next').value !== $('change-next2').value) return setStatus('change-status', 'The new passwords do not match.', 'error');
  try {
    const me = await api('/api/me/password', {
      method: 'POST',
      body: JSON.stringify({ current: $('change-current').value, next: $('change-next').value }),
    });
    for (const id of ['change-current', 'change-next', 'change-next2']) $(id).value = '';
    setStatus('change-status', '');
    state.pendingMe = null;
    await showConnected(me);
    setStatus('status', 'Password changed.', 'ok');
  } catch (error) {
    showError('change-status', error);
  }
}

/** From the user menu: change password without signing out. */
function openPasswordChange() {
  const me = state.me;
  $('user-menu').open = false;
  showSignIn({ change: true });
  state.pendingMe = me;
  $('change-hint').textContent = me.user.hasPassword ? 'Enter your current password and choose a new one.' : 'You signed in with a Checkmarx One key: set a password to also sign in with your email.';
  $('change-current-field').hidden = !me.user.hasPassword;
  $('change-cancel').hidden = false;
}

async function disconnect() {
  await api('/api/session', { method: 'DELETE' }).catch(() => {});
  location.hash = '';
  showSignIn({ message: '' });
  setStatus('signin-status', 'Signed out.', 'ok');
}

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

function fillInlineRecipients() {
  const s = state.settings;
  if (!s) return;
  $('send-to').value = s.recipients.to.join('\n');
  $('send-cc').value = s.recipients.cc.join('\n');
  $('send-bcc').value = s.recipients.bcc.join('\n');
}

async function saveInlineRecipients() {
  setStatus('status', 'Saving recipients…');
  try {
    state.settings = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        recipients: { to: $('send-to').value, cc: $('send-cc').value, bcc: $('send-bcc').value },
      }),
    });
    fillInlineRecipients();
    renderRecipientHint();
    setStatus('status', 'Recipient list saved.', 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('status', error);
  }
}

async function loadSettings() {
  try {
    state.settings = await api('/api/settings');
    fillInlineRecipients();
    renderRecipientHint();
  } catch (error) {
    if (!handleAuthLoss(error)) console.warn(error.message);
  }
}

function renderSettings() {
  const s = state.settings;
  if (!s) return;

  loadIntegration();

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
  renderTlsWarning();
  renderPasswordHint();

  $('init-directory').checked = s.initiators.useDirectory;
  $('init-copy').checked = s.initiators.copyConfiguredRecipients;
  $('init-domain').value = s.initiators.defaultDomain;
  $('init-overrides').value = Object.entries(s.initiators.overrides)
    .map(([name, email]) => `${name} = ${email}`)
    .join('\n');

  $('rcpt-to').value = s.recipients.to.join('\n');
  $('rcpt-cc').value = s.recipients.cc.join('\n');
  $('rcpt-bcc').value = s.recipients.bcc.join('\n');

  $('brand-app').value = s.branding.appName || 'Mission Zero';
  $('brand-name').value = s.branding.companyName;
  $('brand-logo').value = s.branding.logoUrl;
  $('brand-height').value = s.branding.logoHeight;
  $('brand-accent').value = /^#[0-9a-f]{6}$/i.test(s.branding.accentColor) ? s.branding.accentColor : '#1d4ed8';
  $('brand-cta').value = s.branding.callToAction;
  renderBrandPreview();

  $('link-base').value = s.links.baseUrl;
  $('link-project').value = s.links.project;
  $('link-risk').value = s.links.risk;
  $('link-report-server').value = s.links.reportServerUrl ?? '';
  renderLinkExamples(s.linkExamples);

  $('tpl-subject').value = s.template.subject;
  $('tpl-html').value = s.template.html;
  $('risks-path').value = s.endpoints.risksPath;
  $('ai-enabled').checked = Boolean(s.aiTriage?.enabled);
  $('ai-remediation').checked = Boolean(s.aiTriage?.remediationEnabled);
  $('ai-skip-ne').checked = s.aiTriage?.skipNotExploitable !== false;
  $('ai-retriage').checked = Boolean(s.aiTriage?.allowRetriage);
  $('ai-reremediation').checked = Boolean(s.aiTriage?.allowReremediation);
  $('ai-admin-contact').value = s.aiTriage?.adminContact ?? '';
  $('ai-limit').value = String(s.aiTriage?.monthlyCreditLimit ?? 0);

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

const STARTTLS_PORTS = [25, 587, 2525];

/**
 * Port and TLS mode are two halves of one decision: 465 speaks TLS from the
 * first byte, 25/587/2525 start in plaintext and upgrade with STARTTLS. Wiring
 * them together stops the most common misconfiguration, which otherwise only
 * shows up as a connection timeout fifteen seconds later.
 */
function syncTlsMode(changed) {
  const port = Number($('smtp-port').value);
  const secure = $('smtp-secure').checked;

  if (changed === 'port') {
    if (port === 465) $('smtp-secure').checked = true;
    else if (STARTTLS_PORTS.includes(port)) $('smtp-secure').checked = false;
  } else if (changed === 'secure') {
    // Only move a port that is still at one of the standard values, so a
    // deliberate non-standard port is left alone.
    if (secure && STARTTLS_PORTS.includes(port)) $('smtp-port').value = 465;
    else if (!secure && port === 465) $('smtp-port').value = 587;
  }
  renderTlsWarning();
}

// ---------------------------------------------------------------------------
// Automation
// ---------------------------------------------------------------------------

const timeAgo = (iso) => {
  if (!iso) return 'never';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (Math.abs(seconds) < 90) return `${Math.abs(seconds)}s ${seconds < 0 ? 'from now' : 'ago'}`;
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 90) return `${Math.abs(minutes)}m ${minutes < 0 ? 'from now' : 'ago'}`;
  const hours = Math.round(minutes / 60);
  return `${Math.abs(hours)}h ${hours < 0 ? 'from now' : 'ago'}`;
};

async function loadAutomation() {
  try {
    state.automation = await api('/api/automation');
    renderAutomation();
  } catch (error) {
    if (!handleAuthLoss(error)) console.warn(error.message);
  }
}

function renderAutomation() {
  const a = state.automation;
  if (!a) return;

  $('auto-enabled').checked = a.config.enabled;
  $('auto-dry').checked = a.config.dryRun;
  $('auto-thresholds').value = a.config.thresholds.join(', ');
  $('auto-interval').value = a.config.intervalMinutes;
  $('auto-groupby').value = a.config.groupBy;
  $('auto-mode').value = a.config.mode;
  $('auto-severities').value = a.config.severities.join(', ');

  $('auto-status').textContent = a.config.enabled
    ? `On · next run ${timeAgo(a.nextRunAt)} · ${a.trackedFindings} finding(s) already reported`
    : 'Off';
  $('auto-status').className = `hint ${a.config.enabled ? 'ok-hint' : ''}`;

  // Automation has no browser to paste a key into, so say plainly what it
  // will and will not be able to do on its own.
  const credential = $('auto-credential');
  if (a.bootstrapKey) {
    credential.className = 'detected ok';
    credential.textContent = 'Using the CX_API_KEY from the environment. Automation can run unattended.';
  } else if (a.keyStored) {
    credential.className = 'detected ok';
    credential.textContent =
      'Armed: your API key is stored in the settings file (owner-readable only) so runs can authenticate without you. Use "Forget stored key" to revoke it.';
  } else {
    credential.className = 'detected warn';
    credential.textContent =
      'No stored credential. Unattended runs need one — either set CX_API_KEY in the environment, or click "Arm with current key" to save this session\'s key to the settings file. Until then, only "Run once now" works.';
  }

  if (!a.smtpVerified) {
    setStatus('auto-message', 'SMTP has not passed a connection test — automation cannot send yet.', 'error');
  }

  $('auto-runs').innerHTML = a.runs.length
    ? `<table class="probe">
        <thead><tr><th>When</th><th class="num">Scanned</th><th class="num">Crossed</th><th class="num">Sent</th><th>Outcome</th></tr></thead>
        <tbody>${a.runs
          .map(
            (run) => `<tr class="${run.ok ? 'hit' : 'miss'}">
              <td>${escapeHtml(timeAgo(run.at))}</td>
              <td class="num">${run.scanned ?? '—'}</td>
              <td class="num">${run.crossed ?? '—'}</td>
              <td class="num">${run.sent ?? 0}${run.dryRun ? ' (dry)' : ''}</td>
              <td class="snippet">${escapeHtml(
                run.error || run.reason || (run.failures?.length ? `${run.failures.length} failed` : 'ok'),
              )}</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>`
    : '<p class="hint">No runs yet.</p>';
}

function automationPayload() {
  return {
    enabled: $('auto-enabled').checked,
    dryRun: $('auto-dry').checked,
    thresholds: $('auto-thresholds').value,
    intervalMinutes: $('auto-interval').value,
    groupBy: $('auto-groupby').value,
    mode: $('auto-mode').value,
    severities: $('auto-severities').value,
  };
}

async function saveAutomation() {
  setStatus('auto-message', 'Saving…');
  try {
    const status = await api('/api/automation', { method: 'PUT', body: JSON.stringify(automationPayload()) });
    state.automation = { ...state.automation, ...status };
    renderAutomation();
    setStatus(
      'auto-message',
      status.config.enabled ? `Saved. Next run in ${status.config.intervalMinutes} minutes.` : 'Saved. Automation is off.',
      'ok',
    );
  } catch (error) {
    if (!handleAuthLoss(error)) showError('auto-message', error);
  }
}

async function runAutomationNow() {
  const button = $('auto-run');
  button.disabled = true;
  setStatus('auto-message', 'Running a pass…');
  try {
    const { run } = await api('/api/automation/run', { method: 'POST', body: JSON.stringify({}) });
    await loadAutomation();
    setStatus(
      'auto-message',
      run.error || run.reason ||
        `Scanned ${run.scanned} finding(s), ${run.crossed} newly crossed, ${run.sent} message(s) ${
          run.dryRun ? 'would have been sent' : 'sent'
        }.`,
      run.ok ? 'ok' : 'error',
    );
  } catch (error) {
    if (!handleAuthLoss(error)) showError('auto-message', error);
  } finally {
    button.disabled = false;
  }
}

/** Show the header exactly as recipients will see it. */
function renderBrandPreview() {
  const url = $('brand-logo').value.trim();
  const name = $('brand-name').value.trim();
  const accent = $('brand-accent').value;
  const height = Number($('brand-height').value) || 40;
  const box = $('brand-preview');

  if (!url && !name) {
    box.innerHTML = '<p class="hint">No logo or company name — reminders will have a plain header.</p>';
    return;
  }
  if (url && !/^https:\/\//i.test(url) && !/^data:image\//i.test(url)) {
    box.innerHTML =
      '<p class="hint error-hint">A logo must be an https URL (or a data: image). Other schemes are blocked by mail clients and will not be saved.</p>';
    return;
  }

  box.innerHTML = `<div style="border-bottom:2px solid ${escapeHtml(accent)};padding-bottom:10px">${
    url
      ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(name)}" style="height:${height}px;max-width:260px;display:block" />`
      : `<strong style="font-size:17px">${escapeHtml(name)}</strong>`
  }</div>`;
}

/** Worked examples, so a wrong UI route is obvious before a mail goes out. */
function renderLinkExamples(examples) {
  $('link-examples').innerHTML = [
    ['Project', examples?.project],
    ['Finding', examples?.risk],
  ]
    .map(
      ([label, url]) =>
        `<div><span class="k">${label}</span><span class="v">${
          url
            ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`
            : '<span class="error-hint">no link — check the base URL</span>'
        }</span></div>`,
    )
    .join('');
}

/** Gmail will not accept an account password over SMTP; say so up front. */
function renderPasswordHint() {
  const host = $('smtp-host').value.trim();
  const el = $('password-hint');
  const isGoogle = /(^|\.)(gmail|googlemail)\.com$/i.test(host);

  el.hidden = !isGoogle;
  if (isGoogle) {
    el.innerHTML =
      'Gmail requires a 16-character <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">App Password</a>, ' +
      'not your account password. Spaces in the pasted value are ignored.';
  }
}

function renderTlsWarning() {
  const port = Number($('smtp-port').value);
  const secure = $('smtp-secure').checked;
  const el = $('tls-warning');

  let message = '';
  if (secure && STARTTLS_PORTS.includes(port)) {
    message = `Port ${port} expects STARTTLS, not implicit TLS. The connection will stall and time out. Use port 465, or turn Implicit TLS off.`;
  } else if (!secure && port === 465) {
    message = 'Port 465 expects TLS from the first byte. Turn Implicit TLS on, or use port 587.';
  }

  el.hidden = !message;
  el.textContent = message;
  el.className = 'hint error-hint';
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
    initiators: {
      useDirectory: $('init-directory').checked,
      copyConfiguredRecipients: $('init-copy').checked,
      defaultDomain: $('init-domain').value,
      overrides: $('init-overrides').value,
    },
    template: { subject: $('tpl-subject').value, html: $('tpl-html').value },
    branding: {
      appName: $('brand-app').value,
      companyName: $('brand-name').value,
      logoUrl: $('brand-logo').value,
      logoHeight: $('brand-height').value,
      accentColor: $('brand-accent').value,
      callToAction: $('brand-cta').value,
    },
    links: {
      baseUrl: $('link-base').value,
      project: $('link-project').value,
      risk: $('link-risk').value,
      reportServerUrl: $('link-report-server').value,
    },
    endpoints: { risksPath: $('risks-path').value },
    aiTriage: {
      enabled: $('ai-enabled').checked,
      remediationEnabled: $('ai-remediation').checked,
      skipNotExploitable: $('ai-skip-ne').checked,
      allowRetriage: $('ai-retriage').checked,
      allowReremediation: $('ai-reremediation').checked,
      adminContact: $('ai-admin-contact').value.trim(),
      monthlyCreditLimit: Number($('ai-limit').value) || 0,
    },
  };
  // Only send a password when one was typed, so saving an unrelated field
  // never has to round-trip the stored secret through the browser.
  if ($('smtp-password').value) payload.smtp.password = $('smtp-password').value;
  // Send only the sections this person may change (the server enforces the same).
  const SECTION = { smtp: 'integration.smtp', recipients: 'settings.recipients', initiators: 'settings.initiators', template: 'settings.template', branding: 'settings.branding', links: 'settings.links', endpoints: 'integration.cxone' };
  for (const [key, permission] of Object.entries(SECTION)) if (!can(permission)) delete payload[key];
  if (!can('credits.limit')) delete payload.aiTriage.monthlyCreditLimit;
  if (!can('settings.ai')) {
    const { monthlyCreditLimit } = payload.aiTriage;
    payload.aiTriage = monthlyCreditLimit === undefined ? undefined : { monthlyCreditLimit };
  }
  if (!payload.aiTriage) delete payload.aiTriage;
  return payload;
}

// ---------------------------------------------------------------------------
// AI Triage credits (live while the Settings page is open)
// ---------------------------------------------------------------------------

const CREDIT_REFRESH_MS = 15_000;
let creditTimer = null;

function formatMonth(month) {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

async function loadCredits() {
  clearTimeout(creditTimer);
  if ($('page-settings').hidden) return;
  try {
    const selected = $('credit-month').value;
    const data = await api(`/api/credits${selected ? `?month=${encodeURIComponent(selected)}` : ''}`);
    renderCredits(data);
  } catch (error) {
    if (handleAuthLoss(error)) return;
    $('credit-usage').innerHTML = `<p class="status error">${escapeHtml(error.message)}</p>`;
  }
  creditTimer = setTimeout(loadCredits, CREDIT_REFRESH_MS);
}

function renderCredits(data) {
  const select = $('credit-month');
  const current = select.value || data.month;
  select.innerHTML = data.months
    .map((m) => `<option value="${escapeHtml(m)}"${m === current ? ' selected' : ''}>${escapeHtml(formatMonth(m))}</option>`)
    .join('');

  const limitText = data.monthlyCreditLimit ? `${data.monthlyCreditLimit} per month` : 'no monthly limit';
  const allowed = [data.enabled && 'triage', data.remediationEnabled && 'remediation'].filter(Boolean);
  $('credit-state').textContent = allowed.length
    ? `Allowed: ${allowed.join(' and ')} · ${limitText}${data.remaining !== null && data.remaining !== undefined ? ` · ${data.remaining} left this month` : ''}`
    : 'Switched off';
  $('credit-state').className = `hint ${allowed.length ? 'ok-hint' : ''}`;

  renderAllocations(data.allocations ?? []);

  const warning = allowed.length && !data.relayConnected
    ? '<p class="status error">This server has no stored Checkmarx One connection, so reports cannot triage. Set CX_API_KEY or arm automation below.</p>'
    : '';
  if (!data.projects.length) {
    $('credit-usage').innerHTML = `${warning}<p class="hint">No credits used from reports in ${escapeHtml(formatMonth(data.month))}.</p>`;
    return;
  }
  const rows = data.projects
    .map(
      (p) => `<tr>
        <td>${escapeHtml(p.projectName || p.projectId)}</td>
        <td class="num">${p.triageCredits ?? p.credits}</td>
        <td class="num">${p.remediationCredits ?? 0}</td>
        <td class="num"><b>${p.credits}</b></td>
        <td class="num">${p.requests}</td>
        <td>${escapeHtml(new Date(p.lastUsedAt).toLocaleString())}</td>
      </tr>`,
    )
    .join('');
  $('credit-usage').innerHTML = `${warning}
    <div class="table-wrap"><table class="probe">
      <thead><tr><th>Project</th><th class="num">Triage</th><th class="num">Remediation</th><th class="num">Total credits</th><th class="num">Requests</th><th>Last used</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><th>Total</th><th class="num">${data.triageTotal ?? data.total}</th><th class="num">${data.remediationTotal ?? 0}</th><th class="num">${data.total}</th><th></th><th></th></tr></tfoot>
    </table></div>`;
}

/** Per project: first allocated, allocated now, used through this utility, left. */
function renderAllocations(list) {
  if (!list.length) {
    $('credit-allocations').innerHTML = '<p class="hint">No project has an allocation yet — fetch projects on the Dashboard.</p>';
    return;
  }
  const bar = (k) => {
    const pct = k.allocated ? Math.min(100, Math.round((k.used / k.allocated) * 100)) : 0;
    return `<div class="use-bar" title="${k.used} of ${k.allocated} used"><span style="width:${pct}%"></span></div>`;
  };
  const cells = (k) => `<td class="num">${k.initial}</td><td class="num">${k.allocated}</td><td class="num"><b>${k.used}</b>${bar(k)}</td><td class="num">${k.remaining}</td>`;
  const sum = (kind, key) => list.reduce((n, p) => n + (p[kind][key] ?? 0), 0);
  const totals = (kind) => ['initial', 'allocated', 'used', 'remaining'].map((key) => `<th class="num">${sum(kind, key)}</th>`).join('');
  $('credit-allocations').innerHTML = `<div class="table-wrap"><table class="probe alloc-table">
    <thead>
      <tr><th rowspan="2">Project</th><th colspan="4" class="group">AI Triage</th><th colspan="4" class="group">AI Remediation</th></tr>
      <tr><th class="num">At start</th><th class="num">Allocated</th><th class="num">Used</th><th class="num">Left</th><th class="num">At start</th><th class="num">Allocated</th><th class="num">Used</th><th class="num">Left</th></tr>
    </thead>
    <tbody>${list
      .map((p) => `<tr><td>${escapeHtml(p.projectName || p.projectId)}<div class="hint">${escapeHtml(p.severities.map((s) => s.toLowerCase()).join(', ') || 'no severities')}${p.initialAt ? ` · since ${escapeHtml(new Date(p.initialAt).toLocaleDateString())}` : ''}</div></td>${cells(p.triage)}${cells(p.remediation)}</tr>`)
      .join('')}</tbody>
    <tfoot><tr><th>Total</th>${totals('triage')}${totals('remediation')}</tr></tfoot>
  </table></div>`;
}

async function saveSettings() {
  setStatus('save-status', 'Saving…');
  try {
    state.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(settingsPayload()) });
    $('smtp-password').value = '';
    renderSettings();
    renderRecipientHint();
    loadCredits();
    loadReportServer();
    applyAppBranding({ name: state.settings.branding.appName, logoUrl: state.settings.branding.logoUrl });
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

  // Get the new send options
  const sendTo = document.querySelector('input[name="sendTo"]:checked')?.value ?? 'list';
  const emailContent = document.querySelector('input[name="emailContent"]:checked')?.value ?? 'summary';
  const attachHtml = $('attach-html-report')?.checked ?? false;

  // Build hint text
  let hint = '';
  if (sendTo === 'list') {
    hint = 'The recipient list gets ';
  } else if (sendTo === 'initiator') {
    hint = 'Each scan initiator gets ';
  } else {
    hint = 'Each scan initiator and the recipient list get ';
  }
  hint += emailContent === 'summary' ? 'one email covering all their projects' : 'one email per project';
  hint += attachHtml ? ', with the interactive report attached.' : '.';

  if ($('groupby-hint')) {
    $('groupby-hint').textContent = hint;
  }

  // Recipient list is used when sending to list or when sending to both
  const listUsed = sendTo === 'list' || sendTo === 'both';
  if ($('inline-recipients')) {
    $('inline-recipients').style.opacity = listUsed ? '1' : '0.5';
  }
  // Open the list when it is used but still empty, so the gap is obvious.
  if (listUsed && total === 0 && $('recipients-box')) $('recipients-box').open = true;

  // Who this reminder reaches, at a glance.
  const reachable = (state.initiators ?? []).filter((e) => e.email);
  const people = state.pickedInitiators.size || reachable.length;
  const parts = [];
  if (sendTo !== 'list' && state.initiators?.length) parts.push(`${people} ${people === 1 ? 'person' : 'people'}`);
  if (listUsed) parts.push(`${total} list address${total === 1 ? '' : 'es'}`);
  $('audience-chip').textContent = parts.join(' + ');

  if (!s.verified) {
    el.textContent = 'SMTP has not passed a connection test — sending is disabled.';
    el.className = 'hint error-hint';
  } else if (sendTo === 'initiator' && total === 0) {
    el.textContent = 'Not used in this mode — each message is addressed to its own recipient.';
    el.className = 'hint';
  } else if (sendTo !== 'initiator' && total === 0) {
    el.textContent = 'No recipients configured.';
    el.className = 'hint error-hint';
  } else {
    el.textContent =
      `${to.length} to${cc.length ? `, ${cc.length} cc` : ''}${bcc.length ? `, ${bcc.length} bcc` : ''}` +
      ` — ${to.slice(0, 3).join(', ')}${to.length > 3 ? ', …' : ''}`;
    el.className = 'hint';
  }
  const addressedIndividually = sendTo === 'initiator';
  $('send').disabled = !s.verified || (total === 0 && !addressedIndividually);
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

  const picked = state.pickedInitiators;

  const rows = state.projects.filter((p) => {
    if (text && !p.projectName.toLowerCase().includes(text)) return false;
    if (severity && !(p.bySeverity?.[severity] > 0)) return false;
    if (bucket && !(p.counts?.[bucket] > 0)) return false;
    if (picked.size > 0 && !picked.has(p.initiator || p.initiatorEmail || '')) return false;
    if (hideEmpty && p.totalRisks === 0) return false;
    return true;
  });

  const { key, dir } = state.sort;
  const value = (p) => {
    if (key === 'projectName') return p.projectName.toLowerCase();
    if (key === 'initiator') return (p.initiator || '').toLowerCase();
    return key in p ? p[key] ?? 0 : p.counts?.[key] ?? 0;
  };

  return rows.sort((a, b) => {
    const [x, y] = [value(a), value(b)];
    if (x === y) return a.projectName.localeCompare(b.projectName);
    return (x > y ? 1 : -1) * (dir === 'asc' ? 1 : -1);
  });
}

const cell = (count) => (count > 0 ? `<td class="num">${count}</td>` : '<td class="num zero">0</td>');

/** Who ran the latest scan, and whether we could reach them. */
function renderInitiator(project) {
  if (!project.initiator && !project.initiatorEmail) {
    return '<span class="zero">no initiator recorded</span>';
  }
  const name = escapeHtml(project.initiator || project.initiatorEmail);
  if (!project.initiatorEmail) {
    return `${name}<span class="err">no email resolved</span>`;
  }
  const same = project.initiatorEmail === project.initiator;
  return same
    ? escapeHtml(project.initiatorEmail)
    : `${name}<span class="zero">${escapeHtml(project.initiatorEmail)}</span>`;
}

/**
 * Distinct scan initiators in the current results.
 *
 * Keyed by the initiator identity rather than the email, so someone whose
 * address has not been resolved is still a selectable row that can be tagged.
 */
function collectInitiators() {
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
function avatar(name) {
  const clean = String(name || '?').replace(/@.*$/, '').replace(/^cx-/i, '');
  const parts = clean.split(/[\s._-]+/).filter(Boolean);
  const letters = ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '')).toUpperCase();
  let hash = 0;
  for (const ch of clean) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `<span class="avatar" style="--hue:${hash % 360}" aria-hidden="true">${escapeHtml(letters)}</span>`;
}

function renderInitiatorList() {
  queueMicrotask(renderRecipientHint);
  const list = $('initiator-list');
  const note = $('initiator-resolved');
  const actions = $('initiator-actions');
  const stats = $('people-stats');

  if (state.initiators.length === 0) {
    list.innerHTML = '<p class="hint">No scan initiator was recorded for any project in these results.</p>';
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

function renderProjects() {
  const rows = visibleProjects();
  const body = $('projects-body');

  if (rows.length === 0) {
    body.innerHTML = `<tr class="empty"><td colspan="10">${
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
          <td class="name">${
            p.url
              ? `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.projectName)}</a>`
              : escapeHtml(p.projectName)
          }${p.error ? `<span class="err">${escapeHtml(p.error)}</span>` : ''}</td>
          <td class="num">${p.totalRisks}</td>
          ${cell(p.counts['0-30'] ?? 0)}
          ${cell(p.counts['31-60'] ?? 0)}
          <td class="num ${aged > 0 ? 'aged' : 'zero'}">${aged}</td>
          <td>${formatDate(p.oldestFirstDetectedAt)}${
            p.maxAgeDays === null ? '' : ` <span class="zero">(${p.maxAgeDays}d)</span>`
          }</td>
          <td class="initiator">${renderInitiator(p)}</td>
          ${creditCell(p, 'triage')}
          ${creditCell(p, 'remediation')}
        </tr>${state.creditEditor === p.projectId ? creditEditorRow(p) : ''}`;
      })
      .join('');
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

/** One project's credits, editable: what its severities need, plus extras the administrator sets. */
function creditEditorRow(p) {
  const c = p.credits ?? {};
  const t = c.triage ?? { allocated: 0, used: 0, remaining: 0 };
  const r = c.remediation ?? { allocated: 0, used: 0, remaining: 0 };
  const sev = c.severities ?? [];
  const toTriage = sev.reduce((n, s) => n + (c.toTriage?.[s] ?? 0), 0);
  const id = escapeHtml(p.projectId);
  return `<tr class="credit-editor" data-editor="${id}"><td colspan="10">
    <div class="credit-editor-grid">
      <div class="credit-editor-head"><strong>${escapeHtml(p.projectName)}</strong>
        <span class="hint">covers ${escapeHtml(sev.map((s) => s.toLowerCase()).join(', ') || 'no severities')} · extra credits stay until you change them</span></div>
      <div class="credit-kind">
        <span class="label">AI Triage</span>
        <span class="need">${toTriage} needed +</span>
        <label class="inline"><input type="number" min="0" step="1" class="small-num" data-extra="triage" value="${c.extraTriage ?? 0}" /> extra</label>
        <span class="hint">${t.remaining} left of ${t.allocated} · ${t.used} used</span>
      </div>
      <div class="credit-kind">
        <span class="label">AI Remediation</span>
        <span class="need">${(c.toRemediate ?? 0) * 3} needed +</span>
        <label class="inline"><input type="number" min="0" step="3" class="small-num" data-extra="remediation" value="${c.extraRemediation ?? 0}" /> extra</label>
        <span class="hint">${r.remaining} left of ${r.allocated} · ${r.used} used · ${c.toRemediate ?? 0} confirmed × 3</span>
      </div>
      <div class="actions compact">
        <button type="button" class="primary" data-credit-save="${id}">Save</button>
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

// ---------------------------------------------------------------------------
// Tracked reports
// ---------------------------------------------------------------------------

function trackScope() {
  const severity = $('severity-filter').value;
  const bucket = $('bucket-filter').value;
  const projects = allocationScope();
  const parts = [
    $('scope-summary').textContent,
    severity ? `${severity.toLowerCase()} only` : 'all severities',
    bucket ? `age ${$('bucket-filter').selectedOptions[0].textContent.toLowerCase()}` : '',
    `${projects.length} project${projects.length === 1 ? '' : 's'}`,
  ].filter(Boolean);
  return { severity, bucket, projects, label: parts.join(' · ') };
}

function renderTrackRow() {
  $('track-row').hidden = !state.projects.length;
  if (!state.projects.length) return;
  $('track-scope').textContent = `Saves: ${trackScope().label}`;
}

async function saveTrackedReport() {
  const name = $('track-name').value.trim();
  if (!name) return setStatus('track-status', 'Give the report a name.', 'error');
  const scope = trackScope();
  const params = windowParams();
  const windows = Object.fromEntries(
    ['activity', 'detection'].map((prefix) => [
      prefix,
      { preset: params.get(`${prefix}Preset`), from: params.get(`${prefix}From`) ?? undefined, to: params.get(`${prefix}To`) ?? undefined },
    ]),
  );
  try {
    const report = await api('/api/tracked-reports', {
      method: 'POST',
      body: JSON.stringify({
        name,
        projectIds: scope.projects.map((p) => p.projectId),
        severities: scope.severity ? [scope.severity] : [],
        buckets: scope.bucket ? [scope.bucket] : [],
        windows,
        scopeLabel: scope.label,
      }),
    });
    $('track-name').value = '';
    setStatus('track-status', `Saved "${report.name}" with ${report.baselineCount} finding(s). See Tracked reports.`, 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('track-status', error);
  }
}

const TRACK_POLL_MS = 30_000;
let trackTimer = null;
// The reminder server's time zone, which automatic reminders run in.
let serverZone = { name: '', offset: 'UTC' };
const zoneLabel = () => (serverZone.name ? `${serverZone.name} (${serverZone.offset})` : serverZone.offset);

async function loadTrackedReports() {
  clearTimeout(trackTimer);
  if ($('page-reports').hidden) return;
  try {
    const data = await api('/api/tracked-reports');
    if (data.timeZone) serverZone = data.timeZone;
    const kept = captureReportsState();
    renderTrackedReports(data);
    restoreReportsState(kept);
    for (const card of document.querySelectorAll('#reports-list [data-report]')) {
      syncSendTo(card);
      updateNeed(card);
    }
  } catch (error) {
    if (handleAuthLoss(error)) return;
    $('reports-list').innerHTML = `<p class="status error">${escapeHtml(error.message)}</p>`;
  }
  trackTimer = setTimeout(loadTrackedReports, TRACK_POLL_MS);
}

const OUTCOME_LABELS = {
  resolved: 'No longer detected',
  notExploitable: 'Not exploitable (proposed or confirmed)',
  confirmed: 'Confirmed',
  awaiting: 'Awaiting triage',
};

function progressBar(outcomes, total) {
  if (!total) return '<div class="progress-bar"></div>';
  return `<div class="progress-bar">${Object.keys(OUTCOME_LABELS)
    .map((key) => (outcomes[key] ? `<span class="seg-${key}" style="width:${(outcomes[key] / total) * 100}%" title="${escapeHtml(OUTCOME_LABELS[key])}: ${outcomes[key]}"></span>` : ''))
    .join('')}</div>
    <div class="legend">${Object.entries(OUTCOME_LABELS)
      .map(([key, label]) => `<span><i class="seg-${key}"></i>${escapeHtml(label)}: <b>${outcomes[key] ?? 0}</b></span>`)
      .join('')}</div>`;
}

const trackedById = new Map();

function renderTrackedReports({ reports, autoRefresh }) {
  trackedById.clear();
  for (const r of reports) trackedById.set(r.id, r);
  $('reports-meta').textContent = autoRefresh
    ? 'Updates automatically: hourly, and every few minutes after anyone triages or remediates'
    : 'Automatic updates need a stored Checkmarx One connection (CX_API_KEY, or arm automation in Settings); use Refresh meanwhile';
  if (!reports.length) {
    $('reports-list').innerHTML = '<p class="hint">No tracked reports yet.</p>';
    return;
  }
  $('reports-list').innerHTML = reports
    .map((r) => {
      const l = r.latest;
      const stats = l
        ? `<div class="report-stats">
            <div><span class="value">${l.baseline}</span><span class="label">findings when saved</span></div>
            <div><span class="value">${l.percentActioned}%</span><span class="label">triaged or resolved (${l.actioned})</span></div>
            <div><span class="value">${l.changed ?? 0}</span><span class="label">changed since saved</span></div>
            <div><span class="value">${l.outcomes.awaiting}</span><span class="label">still awaiting triage</span></div>
            <div><span class="value">${l.newFindings}</span><span class="label">new, matching the filters</span></div>
            <div><span class="value">${l.currentMatching}</span><span class="label">matching the filters now</span></div>
            <div><span class="value">${l.aiActions.triage} / ${l.aiActions.remediation}</span><span class="label">AI triage / remediation credits used</span></div>
          </div>${progressBar(l.outcomes, l.baseline)}`
        : '<p class="hint">Not measured yet.</p>';
      const projects = l?.byProject?.length
        ? `<details><summary>By project (${l.byProject.length})</summary>
            <div class="table-wrap"><table class="probe">
              <thead><tr><th>Project</th><th class="num">When saved</th><th class="num">Awaiting</th><th class="num">Confirmed</th><th class="num">Not exploitable</th><th class="num">No longer detected</th><th class="num">New</th><th class="num">Matching now</th></tr></thead>
              <tbody>${l.byProject
                .map((p) => `<tr><td>${escapeHtml(p.projectName || p.projectId)}</td><td class="num">${p.baseline}</td><td class="num">${p.awaiting}</td><td class="num">${p.confirmed}</td><td class="num">${p.notExploitable}</td><td class="num">${p.resolved}</td><td class="num">${p.newFindings}</td><td class="num">${p.currentMatching}</td></tr>`)
                .join('')}</tbody>
            </table></div></details>`
        : '';
      const history = r.history?.length > 1
        ? `<details><summary>History (${r.history.length} readings)</summary>
            <div class="table-wrap"><table class="probe">
              <thead><tr><th>When</th><th class="num">Awaiting</th><th class="num">Confirmed</th><th class="num">Not exploitable</th><th class="num">No longer detected</th><th class="num">New</th><th class="num">Matching now</th></tr></thead>
              <tbody>${r.history
                .slice()
                .reverse()
                .map((h) => `<tr><td>${escapeHtml(new Date(h.at).toLocaleString())}</td><td class="num">${h.awaiting}</td><td class="num">${h.confirmed}</td><td class="num">${h.notExploitable}</td><td class="num">${h.resolved}</td><td class="num">${h.newFindings}</td><td class="num">${h.currentMatching}</td></tr>`)
                .join('')}</tbody>
            </table></div></details>`
        : '';
      return `<article class="report-card" data-report="${escapeHtml(r.id)}">
        <div class="report-head">
          <div>
            <h3>${escapeHtml(r.name)}</h3>
            <div class="report-meta">${escapeHtml(r.scopeLabel || '')}</div>
            <div class="report-meta">Saved ${escapeHtml(new Date(r.createdAt).toLocaleString())} · ${
              l ? `updated ${escapeHtml(new Date(l.at).toLocaleString())}` : 'not updated yet'
            }${r.lastError ? ` · <span class="status error">last update failed: ${escapeHtml(r.lastError)}</span>` : ''}</div>
          </div>
          <div class="actions compact">
            <button type="button" data-report-refresh="${escapeHtml(r.id)}">Refresh</button>
            ${can('reports.manage') ? `<button type="button" data-report-delete="${escapeHtml(r.id)}" class="link">Delete</button>` : ''}
          </div>
        </div>
        ${stats}${followUp(r)}${projects}${history}
      </article>`;
    })
    .join('');
}

/** Reminder, schedule and triage controls for one tracked report. */
function followUp(r) {
  const id = escapeHtml(r.id);
  const auto = r.automation ?? {};
  const open = r.latest?.open ?? 0;
  const radio = (name, value, label, current) =>
    `<label class="check"><input type="radio" name="${name}-${id}" value="${value}" data-keep ${current === value ? 'checked' : ''} /> ${label}</label>`;
  const reminders = (r.reminders ?? []).slice(0, 10);
  const onlyTo = auto.onlyTo?.length ? auto.onlyTo.join(', ') : '';
  const sendTo = onlyTo ? 'only' : auto.sendTo ?? 'initiator';
  return `<details class="follow-up" data-keep-open="${id}">
    <summary><strong>Follow up</strong> — ${open} open finding${open === 1 ? '' : 's'} (awaiting triage, confirmed or new)</summary>
    <div class="follow-grid">
      <fieldset>
        <legend>Send a reminder about the open findings</legend>
        <div class="alloc-row">
          <span>To</span>
          ${radio('sendTo', 'initiator', 'Scan initiators', sendTo)}
          ${radio('sendTo', 'list', 'Recipient list', sendTo)}
          ${radio('sendTo', 'both', 'Both', sendTo)}
          ${radio('sendTo', 'only', 'Only to', sendTo)}
          <input type="text" class="only-to" data-field="onlyTo" data-keep value="${escapeHtml(onlyTo)}" placeholder="name@company.com, …" aria-label="Send only to these addresses" />
        </div>
        <div class="alloc-row" data-content-row>
          <span>Content</span>
          ${radio('content', 'summary', 'One summary per person', auto.emailContent ?? 'summary')}
          ${radio('content', 'per-project', 'One email per project', auto.emailContent)}
        </div>
        <label class="check"><input type="checkbox" data-field="attachHtml" data-keep ${auto.attachHtml ? 'checked' : ''} /> Attach the interactive HTML report</label>
        <div class="actions compact">
          ${can('reports.remind') ? `<button type="button" data-remind="${id}" data-dry="1">Preview</button>` : ''}
          <button type="button" data-report-html="${id}">Download HTML report</button>
          ${can('reports.remind') ? `<button type="button" data-remind="${id}" class="primary">Send reminder now</button>` : ''}
        </div>
      </fieldset>
      <fieldset${can('reports.manage') ? '' : ' hidden'}>
        <legend>Automatic reminders</legend>
        <div class="alloc-row">
          <label class="check"><input type="checkbox" data-field="autoEnabled" data-keep ${auto.enabled ? 'checked' : ''} /> Send automatically every</label>
          <input type="number" min="1" max="90" data-field="everyDays" data-keep value="${auto.everyDays ?? 7}" class="small-num" /> days at
          <input type="number" min="0" max="23" data-field="hour" data-keep value="${auto.hour ?? 9}" class="small-num" />:00
          <span class="hint" title="Time zone of the machine running ${escapeHtml(state.health?.app?.name || 'Mission Zero')}">${escapeHtml(zoneLabel())}</span>
        </div>
        <p class="hint">Uses the send options above, and only while something is still open.
          ${auto.enabled && auto.nextRunAt ? `Next: ${escapeHtml(serverTime(auto.nextRunAt))}.` : ''}
          ${auto.lastRunAt ? `Last: ${escapeHtml(serverTime(auto.lastRunAt))}.` : ''}
          ${auto.lastError ? `<span class="status error">${escapeHtml(auto.lastError)}</span>` : ''}</p>
        <div class="actions compact"><button type="button" data-schedule="${id}">Save schedule</button></div>
      </fieldset>
      <fieldset${can('triage.run') || can('credits.allocate') ? '' : ' hidden'}>
        <legend>Triage the open findings now</legend>
        <div class="alloc-row">
          ${['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
            .map((sev) => {
              const n = r.latest?.toTriage?.[sev];
              return `<label class="check"><input type="checkbox" data-sev="${sev}" data-keep ${['CRITICAL', 'HIGH'].includes(sev) ? 'checked' : ''} /> ${sev[0] + sev.slice(1).toLowerCase()}${n === undefined ? '' : ` <span class="hint">(${n})</span>`}</label>`;
            })
            .join('')}
        </div>
        <p class="hint" data-need="${id}">${triageNeedText(r)}</p>
        <div class="actions compact">
          ${can('triage.run') ? `<button type="button" data-report-triage="${id}" class="primary">Triage now</button>` : ''}
          ${can('credits.allocate') ? `<button type="button" data-report-allocate="${id}">Allocate credits</button>` : ''}
          <span class="alloc-extra${can('credits.allocate') ? '' : ' perm-hidden'}">+ <input type="number" min="0" max="100000" data-field="triageAdd" data-keep class="small-num" placeholder="0" /> triage
            + <input type="number" min="0" max="100000" data-field="remediationAdd" data-keep class="small-num" placeholder="0" /> remediation</span>
        </div>
        <p class="hint">Triage now runs AI Triage from here. Allocate credits lets the projects' developers triage these severities from their own reports, plus any extra credits you enter.</p>
      </fieldset>
    </div>
    <p class="status" data-follow-status="${id}"></p>
    ${reminders.length ? `<div class="table-wrap"><table class="probe">
      <thead><tr><th>Reminder sent</th><th>How</th><th class="num">Open findings</th><th class="num">Emails</th><th>Result</th></tr></thead>
      <tbody>${reminders
        .map((m) => `<tr><td>${escapeHtml(new Date(m.at).toLocaleString())}${m.automatic ? ' <span class="hint">(automatic)</span>' : ''}</td>
          <td>${m.sendTo === 'only' ? `Only to ${escapeHtml((m.onlyTo ?? []).join(', '))}` : escapeHtml({ initiator: 'Scan initiators', list: 'Recipient list', both: 'Initiators + list' }[m.sendTo] ?? m.sendTo)}${m.attachHtml ? ' · HTML report' : ''}</td>
          <td class="num">${m.openFindings}</td><td class="num">${m.sent}</td>
          <td>${m.error ? `<span class="status error">${escapeHtml(m.error)}</span>` : 'Sent'}</td></tr>`)
        .join('')}</tbody></table></div>` : ''}
  </details>`;
}

/** A time as the reminder server's clock shows it. */
function serverTime(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, serverZone.name ? { timeZone: serverZone.name, dateStyle: 'medium', timeStyle: 'short' } : undefined);
  } catch {
    return new Date(iso).toLocaleString();
  }
}

/** "Needs N credits · M of A left" for a tracked report's chosen severities. */
function triageNeedText(r, severities = ['CRITICAL', 'HIGH']) {
  const counts = r.latest?.toTriage;
  const c = r.credits?.triage;
  const needed = counts ? severities.reduce((n, sev) => n + (counts[sev] ?? 0), 0) : null;
  const parts = [];
  if (needed !== null) parts.push(`${needed} finding${needed === 1 ? '' : 's'} awaiting triage at these severities (${needed} credit${needed === 1 ? '' : 's'})`);
  if (c) parts.push(`projects have ${c.remaining} of ${c.allocated} triage credits left (${c.used} used)`);
  if (r.credits?.remediation?.allocated) {
    const m = r.credits.remediation;
    parts.push(`remediation ${m.remaining} of ${m.allocated} left`);
  }
  return parts.length ? `${parts.join(' · ')}.` : '';
}

function updateNeed(card) {
  const report = trackedById.get(card.dataset.report);
  const el = card.querySelector('[data-need]');
  if (!report || !el) return;
  el.textContent = triageNeedText(report, [...card.querySelectorAll('[data-sev]:checked')].map((box) => box.dataset.sev));
}

/** "Only to" is picked by typing an address; the per-person options don't apply to it. */
function syncSendTo(card) {
  const only = card.querySelector('input[value="only"]')?.checked;
  for (const box of card.querySelectorAll('[data-content-row] input')) box.disabled = Boolean(only);
  card.querySelector('[data-content-row]')?.classList.toggle('muted-row', Boolean(only));
}

function followUpOptions(card) {
  const id = card.dataset.report;
  const value = (name) => card.querySelector(`input[name="${name}-${CSS.escape(id)}"]:checked`)?.value;
  const field = (name) => card.querySelector(`[data-field="${name}"]`);
  const sendTo = value('sendTo') ?? 'initiator';
  return {
    sendTo: sendTo === 'only' ? 'list' : sendTo,
    onlyTo: sendTo === 'only' ? field('onlyTo').value : '',
    emailContent: value('content') ?? 'summary',
    attachHtml: field('attachHtml').checked,
    triageAdd: Number(field('triageAdd').value) || 0,
    remediationAdd: Number(field('remediationAdd').value) || 0,
    enabled: field('autoEnabled').checked,
    everyDays: Number(field('everyDays').value) || 7,
    hour: Number(field('hour').value) || 0,
    severities: [...card.querySelectorAll('[data-sev]:checked')].map((box) => box.dataset.sev),
  };
}

/** The button last clicked in a report card: its message is shown right under it, where the eye is. */
let followButton = null;

function followStatus(id, text, kind = '') {
  const el = document.querySelector(`[data-follow-status="${CSS.escape(id)}"]`);
  if (el) {
    el.textContent = text;
    el.className = `status ${kind}`;
  }
  const near = followButton?.isConnected && followButton.closest(`[data-report="${CSS.escape(id)}"]`) ? followButton.closest('.actions') : null;
  if (near) {
    let inline = near.nextElementSibling?.matches?.('.inline-status') ? near.nextElementSibling : null;
    if (!inline) {
      inline = document.createElement('p');
      near.after(inline);
    }
    inline.textContent = text;
    inline.className = `status inline-status ${kind}`;
  }
}

function describeSend(result) {
  if (result.dryRun) {
    if (Array.isArray(result.messages)) {
      const people = result.messages.map((m) => m.email).join(', ');
      return `Would send ${result.messages.length} email(s)${people ? ` to ${people}` : ''}${result.consolidated ? ', plus a copy to the recipient list' : ''}${result.skipped?.length ? `; ${result.skipped.length} initiator(s) have no email address` : ''}.`;
    }
    return `Would send "${result.subject}" covering ${result.totalRisks} finding(s) to ${(result.recipients?.to ?? []).join(', ') || 'the recipient list'}.`;
  }
  const sent = Array.isArray(result.sent) ? result.sent.length : result.messageId ? 1 : 0;
  const failed = (result.failed?.length ?? 0) + (result.errors?.length ?? 0);
  return `Sent ${sent} email(s)${failed ? `, ${failed} failed` : ''}${result.skipped?.length ? `; ${result.skipped.length} initiator(s) skipped (no email address)` : ''}.`;
}

async function followUpAction(event) {
  const button = event.target.closest('[data-remind], [data-schedule], [data-report-triage], [data-report-html], [data-report-allocate]');
  if (!button) return false;
  const card = button.closest('[data-report]');
  const id = card.dataset.report;
  const options = followUpOptions(card);
  button.disabled = true;
  followButton = button;
  const label = button.textContent;
  try {
    if (button.dataset.reportHtml) {
      button.textContent = 'Preparing…';
      followStatus(id, 'Building the HTML report from the current open findings in Checkmarx One — this can take a minute for large reports…');
      await downloadTrackedHtml(id);
      followStatus(id, 'HTML report downloaded — this is what an attached report contains.', 'ok');
    } else if (button.dataset.reportAllocate) {
      if (!options.severities.length && !options.triageAdd && !options.remediationAdd) {
        return followStatus(id, 'Pick severities, or enter credits to add.', 'error'), true;
      }
      followStatus(id, 'Allocating…');
      const { report } = await api(`/api/tracked-reports/${encodeURIComponent(id)}/allocate`, {
        method: 'POST',
        body: JSON.stringify({ severities: options.severities, triageAdd: options.triageAdd, remediationAdd: options.remediationAdd }),
      });
      trackedById.set(id, report);
      for (const name of ['triageAdd', 'remediationAdd']) card.querySelector(`[data-field="${name}"]`).value = '';
      updateNeed(card);
      const c = report.credits;
      followStatus(id, `Allocated. Projects now have ${c.triage.remaining} triage and ${c.remediation.remaining} remediation credit(s) left.`, 'ok');
    } else if (button.dataset.remind) {
      const dryRun = Boolean(button.dataset.dry);
      const onlyTo = options.onlyTo.split(/[;,\s]+/).filter(Boolean);
      if (card.querySelector('input[value="only"]')?.checked && !onlyTo.length) {
        return followStatus(id, 'Enter at least one address to send to.', 'error'), true;
      }
      if (!dryRun && !confirm(onlyTo.length ? `Send this report's open findings only to ${onlyTo.join(', ')}?` : 'Send a reminder about this report\'s open findings now?')) return true;
      followStatus(id, dryRun ? 'Preparing preview…' : 'Sending…');
      const result = await api(`/api/tracked-reports/${encodeURIComponent(id)}/remind`, {
        method: 'POST',
        body: JSON.stringify({ ...options, dryRun }),
      });
      followStatus(id, describeSend(result), 'ok');
      if (!dryRun) loadTrackedReports();
    } else if (button.dataset.schedule) {
      if (card.querySelector('input[value="only"]')?.checked && !options.onlyTo.trim()) {
        return followStatus(id, 'Enter at least one address to send to.', 'error'), true;
      }
      await api(`/api/tracked-reports/${encodeURIComponent(id)}/automation`, { method: 'PUT', body: JSON.stringify(options) });
      followStatus(id, options.enabled ? `Automatic reminders every ${options.everyDays} day(s) at ${options.hour}:00 ${zoneLabel()}.` : 'Automatic reminders are off.', 'ok');
      loadTrackedReports();
    } else {
      if (!options.severities.length) return followStatus(id, 'Pick at least one severity.', 'error'), true;
      if (!confirm(`Run AI Triage on this report's ${options.severities.map((s) => s.toLowerCase()).join(', ')} findings still awaiting triage? It uses Checkmarx One credits.`)) return true;
      followStatus(id, 'Starting AI Triage…');
      const result = await api(`/api/tracked-reports/${encodeURIComponent(id)}/triage`, {
        method: 'POST',
        body: JSON.stringify({ severities: options.severities }),
      });
      const parts = result.requested
        ? [`AI Triage started for ${result.started} finding(s)`, result.skipped ? `${result.skipped} not eligible (SAST and SCA only)` : '', result.failed ? `${result.failed} failed: ${result.errors.join('; ')}` : '']
        : ['Nothing awaiting triage at those severities'];
      followStatus(id, `${parts.filter(Boolean).join(' · ')}.`, result.failed ? 'error' : 'ok');
      if (result.report) {
        trackedById.set(id, result.report);
        updateNeed(card);
      }
    }
  } catch (error) {
    if (!handleAuthLoss(error)) followStatus(id, button.dataset.reportHtml ? `Could not build the HTML report: ${error.message}` : error.message, 'error');
  } finally {
    button.textContent = label;
    button.disabled = false;
  }
  return true;
}

async function downloadTrackedHtml(id) {
  const response = await fetch(`/api/tracked-reports/${encodeURIComponent(id)}/html`, { credentials: 'same-origin' });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.error || `${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  const name = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') || '')?.[1] || 'report.html';
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Radios and checkboxes are told apart by value; text and number fields are one key each. */
function keepKey(el) {
  const card = el.closest('[data-report]');
  const choice = el.type === 'checkbox' || el.type === 'radio';
  return `${card?.dataset.report}|${el.name || el.dataset.field || el.dataset.sev}${choice ? `|${el.value}` : ''}`;
}

/** Remember form state and opened sections across the periodic re-render. */
function captureReportsState() {
  const values = new Map();
  for (const el of document.querySelectorAll('#reports-list [data-keep]')) {
    const key = keepKey(el);
    values.set(key, el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value);
  }
  const open = new Set([...document.querySelectorAll('#reports-list details[open]')].map((d) => d.dataset.keepOpen || d.querySelector('summary')?.textContent));
  const statuses = new Map([...document.querySelectorAll('[data-follow-status]')].map((el) => [el.dataset.followStatus, [el.textContent, el.className]]));
  return { values, open, statuses };
}

function restoreReportsState({ values, open, statuses }) {
  for (const el of document.querySelectorAll('#reports-list [data-keep]')) {
    const key = keepKey(el);
    if (!values.has(key)) continue;
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = values.get(key);
    else el.value = values.get(key);
  }
  for (const d of document.querySelectorAll('#reports-list details')) {
    if (open.has(d.dataset.keepOpen || d.querySelector('summary')?.textContent)) d.open = true;
  }
  for (const [id, [text, className]] of statuses) {
    const el = document.querySelector(`[data-follow-status="${CSS.escape(id)}"]`);
    if (el) {
      el.textContent = text;
      el.className = className;
    }
  }
}

async function trackedReportAction(event) {
  if (await followUpAction(event)) return;
  const refresh = event.target.closest('[data-report-refresh]');
  const remove = event.target.closest('[data-report-delete]');
  if (refresh) {
    refresh.disabled = true;
    refresh.textContent = 'Refreshing…';
    try {
      await api(`/api/tracked-reports/${encodeURIComponent(refresh.dataset.reportRefresh)}/refresh`, { method: 'POST', body: '{}' });
    } catch (error) {
      if (!handleAuthLoss(error)) alert(error.message);
    }
    loadTrackedReports();
  } else if (remove && confirm('Delete this tracked report? Its history is lost.')) {
    try {
      await api(`/api/tracked-reports/${encodeURIComponent(remove.dataset.reportDelete)}`, { method: 'DELETE' });
    } catch (error) {
      if (!handleAuthLoss(error)) alert(error.message);
    }
    loadTrackedReports();
  }
}

// ---------------------------------------------------------------------------
// AI credits per project
// ---------------------------------------------------------------------------

function creditCell(project, kind) {
  const c = project.credits?.[kind];
  if (!c) return '<td class="num credits zero">—</td>';
  const credits = project.credits;
  const extra = kind === 'triage' ? credits.extraTriage : credits.extraRemediation;
  const need =
    kind === 'triage'
      ? (credits.severities ?? []).reduce((n, s) => n + (credits.toTriage?.[s] ?? 0), 0)
      : (credits.toRemediate ?? 0);
  const title = [
    `${c.remaining} left of ${c.allocated} allocated, ${c.used} used`,
    kind === 'triage'
      ? `${need} finding(s) still to triage at ${(credits.severities ?? []).map((s) => s.toLowerCase()).join(', ') || 'no severities'}`
      : `${need} confirmed finding(s) to remediate (3 credits each)`,
    extra ? `includes ${extra} extra credit(s) you added` : '',
  ].filter(Boolean).join(' · ');
  const figures = `<span class="${c.remaining === 0 && c.allocated > 0 ? 'low' : ''}">${c.remaining}</span><span class="zero"> / ${c.allocated}</span>${extra ? '<span class="extra-dot" title="Includes extra credits">+</span>' : ''}`;
  if (!can('credits.allocate')) return `<td class="num credits" title="${escapeHtml(title)}">${figures}</td>`;
  return `<td class="num credits" title="${escapeHtml(title)}"><button type="button" class="credit-edit" data-credit-edit="${escapeHtml(project.projectId)}" aria-label="Edit ${escapeHtml(project.projectName)} credits">${figures}</button></td>`;
}

/** Selected projects, or every shown one when none is selected. */
function allocationScope() {
  const shown = visibleProjects().filter((p) => !p.error);
  return state.selected.size ? shown.filter((p) => state.selected.has(p.projectId)) : shown;
}

const allocSeverities = () => [...document.querySelectorAll('.alloc-sev:checked')].map((box) => box.value);
let allocPending = null;
const allocChanges = new Map();

/** Show the scope's triage rule: ticked if every project covers it, partly if only some. */
function syncAllocationBoxes(scope) {
  if (allocPending) return;
  for (const box of document.querySelectorAll('.alloc-sev')) {
    const covering = scope.filter((p) => (p.credits?.severities ?? ['CRITICAL', 'HIGH']).includes(box.value)).length;
    box.checked = scope.length > 0 && covering === scope.length;
    box.indeterminate = covering > 0 && covering < scope.length;
  }
}

function renderAllocation() {
  $('credits-panel').hidden = !state.projects.length;
  if (!state.projects.length) return;
  const scope = allocationScope();
  syncAllocationBoxes(scope);
  const severities = allocSeverities();
  const needed = scope.reduce(
    (sum, p) => sum + severities.reduce((n, s) => n + (p.credits?.toTriage?.[s] ?? 0), 0),
    0,
  );
  $('alloc-scope').textContent = `${scope.length} project${scope.length === 1 ? '' : 's'} ${state.selected.size ? 'selected' : 'shown'}`;
  const remediate = scope.reduce((sum, p) => sum + (p.credits?.toRemediate ?? 0), 0);
  $('alloc-needed').textContent = severities.length
    ? `${needed} finding${needed === 1 ? '' : 's'} to triage (${needed} credit${needed === 1 ? '' : 's'}) · ${remediate} confirmed to remediate (${remediate * 3} credits)`
    : 'No severities: only extra credits are allocated';
  $('run-triage').disabled = !severities.length || !scope.length || needed === 0;
}

function applyCredits(byProject) {
  for (const project of state.projects) {
    if (byProject[project.projectId]) project.credits = byProject[project.projectId];
  }
  renderProjects();
}

async function allocateCredits(body, message) {
  setStatus('alloc-status', 'Saving…');
  try {
    const result = await api('/api/credits/allocate', {
      method: 'POST',
      body: JSON.stringify({ projectIds: allocationScope().map((p) => p.projectId), ...body }),
    });
    applyCredits(result.projects);
    setStatus('alloc-status', message(Object.keys(result.projects).length), 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('alloc-status', error);
  }
}

// After a triage run, re-read the projects' findings for a while: as verdicts
// arrive, triage credits drop and confirmed findings add remediation credits.
const CREDIT_FOLLOW_MS = 45_000;
const CREDIT_FOLLOW_FOR_MS = 20 * 60 * 1000;
let creditFollow = null;

function followCredits(projectIds) {
  clearTimeout(creditFollow?.timer);
  const until = Date.now() + CREDIT_FOLLOW_FOR_MS;
  const ids = new Set([...(creditFollow?.ids ?? []), ...projectIds]);
  const tick = async () => {
    try {
      const result = await api('/api/credits/refresh', { method: 'POST', body: JSON.stringify({ projectIds: [...ids] }) });
      applyCredits(result.projects);
      renderAllocation();
    } catch (error) {
      if (handleAuthLoss(error)) return;
    }
    if (Date.now() < until) creditFollow.timer = setTimeout(tick, CREDIT_FOLLOW_MS);
    else creditFollow = null;
  };
  creditFollow = { ids, timer: setTimeout(tick, CREDIT_FOLLOW_MS) };
}

async function runTriageNow() {
  const scope = allocationScope();
  const severities = allocSeverities();
  const needed = scope.reduce((sum, p) => sum + severities.reduce((n, s) => n + (p.credits?.toTriage?.[s] ?? 0), 0), 0);
  const names = severities.map((s) => s.toLowerCase()).join(', ');
  if (!confirm(`Run Checkmarx One AI Triage now on up to ${needed} ${names} finding(s) across ${scope.length} project(s)? This uses up to ${needed} Checkmarx One credit(s).`)) return;
  const button = $('run-triage');
  button.disabled = true;
  setStatus('alloc-status', 'Starting AI Triage… (reading scan results for the selected projects)');
  try {
    const result = await api('/api/triage/run', {
      method: 'POST',
      body: JSON.stringify({ projectIds: scope.map((p) => p.projectId), severities }),
    });
    applyCredits(result.projects);
    if (!result.requested) {
      setStatus('alloc-status', 'Nothing to triage: these findings are already triaged, or were sent for triage in the last 30 minutes.', 'ok');
      return;
    }
    const parts = [`AI Triage started for ${result.started} finding(s)`];
    if (result.skipped) parts.push(`${result.skipped} not eligible (AI Triage supports SAST and SCA)`);
    if (result.failed) parts.push(`${result.failed} failed: ${result.errors.join('; ')}`);
    setStatus(
      'alloc-status',
      `${parts.join(' · ')}. Verdicts appear in Checkmarx One within minutes, and in reports sent afterwards.`,
      result.failed ? 'error' : 'ok',
    );
    logger.add(`Admin AI Triage: ${parts.join(' · ')}`, result.failed ? 'error' : 'success');
    if (result.started) followCredits(scope.map((p) => p.projectId));
  } catch (error) {
    if (!handleAuthLoss(error)) showError('alloc-status', error);
  } finally {
    renderAllocation();
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
    state.showAllInitiators = false;
    $('select-all').checked = false;
    renderTotals(result.totals);
    collectInitiators();
    renderInitiatorList();
    renderProjects();

    for (const note of result.initiatorNotes ?? []) console.warn(note);

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

async function downloadHtmlReport() {
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

async function sendReminderWithHtmlAttachment() {
  const button = $('send');
  button.disabled = true;
  setStatus('status', 'Generating reports and sending to each developer…');

  try {
    const severity = $('severity-filter').value;

    // Send HTML reports grouped by initiator (each developer gets their own email)
    const sendResponse = await api('/api/reminders/send-html-by-initiator', {
      method: 'POST',
      body: JSON.stringify({
        projectIds: state.selected.size > 0 ? [...state.selected] : null,
        severities: severity ? [severity] : null,
        buckets: [],
      }),
    });

    renderSendResult(sendResponse);
  } catch (error) {
    if (!handleAuthLoss(error)) showError('status', error);
  } finally {
    button.disabled = false;
  }
}

async function submitReminder({ dryRun }) {
  // Age is already decided by the Scope panel at the top of the page, so this
  // request carries no bucket filter of its own.
  const buckets = [];

  // WHO to send to
  const sendTo = document.querySelector('input[name="sendTo"]:checked').value;
  // WHAT content to send
  const emailContent = document.querySelector('input[name="emailContent"]:checked').value;
  const attachHtmlReport = $('attach-html-report').checked;

  // Convert sendTo and emailContent to groupBy and alsoConsolidated for backend
  let groupBy = 'none';
  let alsoConsolidated = false;

  if (sendTo === 'initiator') {
    groupBy = emailContent === 'per-project' ? 'project' : 'initiator';
    alsoConsolidated = false;
  } else if (sendTo === 'both') {
    groupBy = emailContent === 'per-project' ? 'project' : 'initiator';
    alsoConsolidated = true;
  } else {
    // sendTo === 'list'
    groupBy = 'none';
  }

  // If user wants HTML report attachment, use that flow
  if (attachHtmlReport && !dryRun) {
    return sendReminderWithHtmlAttachment();
  }

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
        initiators: state.pickedInitiators.size > 0 ? [...state.pickedInitiators] : null,
        buckets,
        groupBy,
        alsoConsolidated,
        dryRun,
      }),
    });

    if (dryRun) renderPreview(result);
    else renderSendResult(result);
  } catch (error) {
    if (!handleAuthLoss(error)) showError('status', error);
  } finally {
    button.disabled = false;
  }
}

function renderPreview(result) {
  $('preview-panel').hidden = false;

  if (result.messages) {
    const total = result.messages.reduce((sum, m) => sum + m.riskCount, 0);
    $('preview-meta').textContent =
      `${result.messages.length} message(s) covering ${total} finding(s)` +
      (result.consolidated ? ' · plus a consolidated copy to the list' : '') +
      (result.skipped.length ? ` · ${result.skipped.length} initiator(s) skipped` : '') +
      (result.canSend ? '' : ' — SMTP not verified, sending is disabled');

    // Stack each person's message so the whole batch can be reviewed at once.
    const bodies = result.consolidated
      ? [...result.messages, { ...result.consolidated, email: result.consolidated.to.join(', '), riskCount: total, projectName: 'consolidated copy' }]
      : result.messages;

    $('preview-frame').srcdoc = bodies
      .map(
        (m) =>
          `<div style="font:13px system-ui;padding:8px 12px;background:#eef2ff;border-bottom:1px solid #c7d2fe">
             <strong>To:</strong> ${escapeHtml(m.email)} &nbsp;
             <strong>Subject:</strong> ${escapeHtml(m.subject)} &nbsp;
             <span style="color:#4f46e5">${m.riskCount} finding(s)${
               m.projectName ? ` in ${escapeHtml(m.projectName)}` : ` across ${m.projectCount} project(s)`
             }</span>
           </div>${m.html}`,
      )
      .join('<hr style="margin:24px 0;border:none;border-top:2px dashed #cbd5e1">');

    if (result.skipped.length) {
      console.warn('Skipped initiators:', result.skipped);
      setStatus(
        'status',
        `Preview ready. ${result.skipped.length} initiator(s) have no resolvable email — ` +
          'add an override or a default domain in Settings.',
        'error',
      );
    } else {
      setStatus('status', 'Preview ready.', 'ok');
    }
  } else {
    const r = result.recipients;
    $('preview-meta').textContent =
      `${result.totalRisks} findings across ${result.projects} project(s) → ` +
      `${r.to.length} to, ${r.cc.length} cc, ${r.bcc.length} bcc` +
      (result.canSend ? '' : ' — SMTP not verified, sending is disabled');
    $('preview-frame').srcdoc = result.html;
    setStatus('status', 'Preview ready.', 'ok');
  }

  $('preview-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderSendResult(result) {
  // Handle HTML report per-initiator response (from /api/reminders/send-html-by-initiator)
  if (result.summary && (result.sent || result.skipped)) {
    const parts = [result.summary];

    if (result.sent?.length > 0) {
      const totalRisks = result.sent.reduce((sum, entry) => sum + entry.riskCount, 0);
      parts.push(`${totalRisks} total findings`);
    }

    if (result.errors?.length) {
      parts.push(`${result.errors.length} error(s).`);
      console.error('Send errors:', result.errors);
    }

    setStatus('status', parts.join(' '), result.errors?.length ? 'error' : 'ok');
    return;
  }

  // Handle HTML attachment response (from /api/reminders/with-attachment)
  if (result.delivered) {
    const recipientCount = (result.recipients?.to?.length || 0) +
                          (result.recipients?.cc?.length || 0) +
                          (result.recipients?.bcc?.length || 0);
    setStatus(
      'status',
      `Email sent to ${recipientCount} recipient(s) with interactive HTML report attached.`,
      'ok',
    );
    return;
  }

  if (result.sent) {
    // The consolidated copy repeats findings already counted in the individual
    // messages, so it must not be added to the total.
    const individual = result.sent.filter((entry) => entry.initiator !== 'consolidated');
    const total = individual.reduce((sum, entry) => sum + entry.riskCount, 0);

    const parts = [
      `Sent ${individual.length} email(s) covering ${total} finding(s)` +
        (result.consolidated ? ', plus a consolidated copy to the list.' : '.'),
    ];
    if (result.failed?.length) parts.push(`${result.failed.length} failed.`);
    if (result.skipped?.length) parts.push(`${result.skipped.length} initiator(s) had no email.`);

    if (result.failed?.length) console.error('Failed sends:', result.failed);
    if (result.skipped?.length) console.warn('Skipped initiators:', result.skipped);

    setStatus('status', parts.join(' '), result.failed?.length ? 'error' : 'ok');
    return;
  }

  setStatus(
    'status',
    `Sent to ${result.accepted?.length || 0} recipient(s) — ${result.totalRisks} findings across ${result.projects} project(s).` +
      (result.rejected?.length ? ` ${result.rejected.length} rejected.` : ''),
    'ok',
  );
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

window.addEventListener('hashchange', route);

$('connect-form').addEventListener('submit', connect);
$('password-form').addEventListener('submit', signInWithPassword);
$('setup-form').addEventListener('submit', createFirstAdmin);
$('change-form').addEventListener('submit', changePassword);
$('change-cancel').addEventListener('click', () => {
  if (state.pendingMe) showConnected(state.pendingMe);
});
$('me-password').addEventListener('click', openPasswordChange);
$('disconnect').addEventListener('click', disconnect);
$('api-key').addEventListener('input', renderDetected);
for (const radio of document.querySelectorAll('input[name="signinMode"]')) {
  radio.addEventListener('change', () => {
    const cx = document.querySelector('input[name="signinMode"]:checked').value === 'cxone';
    $('password-form').hidden = cx;
    $('connect-form').hidden = !cx;
  });
}
document.addEventListener('click', (event) => {
  if ($('user-menu').open && !$('user-menu').contains(event.target)) $('user-menu').open = false;
});

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

// Update hints when send options change
for (const radio of document.querySelectorAll('input[name="sendTo"], input[name="emailContent"]')) {
  radio.addEventListener('change', renderRecipientHint);
}
if ($('attach-html-report')) {
  const updateHtmlReportButtonsVisibility = () => {
    renderRecipientHint();
    const checked = $('attach-html-report').checked;
    if ($('preview-html')) $('preview-html').hidden = !checked;
    if ($('download-html')) $('download-html').hidden = !checked;
  };

  $('attach-html-report').addEventListener('change', updateHtmlReportButtonsVisibility);
  // Initialize visibility on page load
  updateHtmlReportButtonsVisibility();
}

if ($('download-html')) {
  $('download-html').addEventListener('click', downloadHtmlReport);
}
if ($('preview-html')) {
  $('preview-html').addEventListener('click', () => submitReminder({ dryRun: true, preview: 'html' }));
}
$('auto-save').addEventListener('click', saveAutomation);
$('auto-run').addEventListener('click', runAutomationNow);
$('auto-arm').addEventListener('click', async () => {
  try {
    await api('/api/automation/arm', { method: 'POST', body: JSON.stringify({}) });
    await loadAutomation();
    setStatus('auto-message', 'Armed — unattended runs can now authenticate.', 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('auto-message', error);
  }
});
$('auto-disarm').addEventListener('click', async () => {
  try {
    await api('/api/automation/arm', { method: 'DELETE' });
    await loadAutomation();
    setStatus('auto-message', 'Stored key forgotten.', 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('auto-message', error);
  }
});
$('auto-reset').addEventListener('click', async () => {
  try {
    await api('/api/automation/reset', { method: 'POST', body: JSON.stringify({}) });
    await loadAutomation();
    setStatus('auto-message', 'History cleared — the next run reports from scratch.', 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('auto-message', error);
  }
});
$('save-recipients').addEventListener('click', saveInlineRecipients);
$('credit-month').addEventListener('change', loadCredits);
for (const id of ['brand-name', 'brand-logo', 'brand-height', 'brand-accent']) {
  $(id).addEventListener('input', renderBrandPreview);
}
$('save-settings').addEventListener('click', saveSettings);
$('test-smtp').addEventListener('click', testSmtp);
$('send-test').addEventListener('click', sendTestEmail);
$('preview-template').addEventListener('click', previewTemplate);
$('detect-risks').addEventListener('click', detectRisksPath);
$('smtp-auth').addEventListener('change', () => {
  $('smtp-credentials').hidden = !$('smtp-auth').checked;
});
$('smtp-host').addEventListener('input', renderPasswordHint);
$('smtp-port').addEventListener('input', () => syncTlsMode('port'));
$('smtp-secure').addEventListener('change', () => syncTlsMode('secure'));
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

// Ticking a severity re-allocates straight away (debounced, so quick clicks send one request).
for (const box of document.querySelectorAll('.alloc-sev')) {
  box.addEventListener('change', () => {
    box.indeterminate = false;
    allocChanges.set(box.value, box.checked);
    clearTimeout(allocPending);
    // Set before re-rendering, so the boxes are not re-synced from the old rule.
    allocPending = setTimeout(async () => {
      const ruleChanges = [...allocChanges].map(([severity, include]) => ({ severity, include }));
      allocChanges.clear();
      const describe = ruleChanges
        .map((c) => `${c.include ? 'now include' : 'no longer include'} ${c.severity.toLowerCase()}`)
        .join(' and ');
      await allocateCredits({ ruleChanges }, (n) => `Triage credits ${describe} findings for ${n} project(s).`);
      allocPending = null;
      renderAllocation();
    }, 500);
    renderAllocation();
  });
}
$('alloc-add').addEventListener('click', () => {
  const triageAdd = Number($('alloc-extra-triage').value) || 0;
  const remediationAdd = Number($('alloc-extra-remediation').value) || 0;
  if (!triageAdd && !remediationAdd) return setStatus('alloc-status', 'Enter how many credits to add.', 'error');
  const scope = allocationScope();
  // Extras stay until removed, so giving them to every project must be deliberate.
  if (!state.selected.size && !confirm(`No project is selected: give all ${scope.length} shown projects ${triageAdd} extra triage and ${remediationAdd} extra remediation credit(s) each?`)) return;
  allocateCredits({ triageAdd, remediationAdd }, (n) => `Added ${triageAdd} triage and ${remediationAdd} remediation credit(s) to each of ${n} project(s).`);
});
$('alloc-clear').addEventListener('click', () => {
  const scope = allocationScope();
  if (!confirm(`Remove the extra credits you added to ${state.selected.size ? 'the' : 'all'} ${scope.length} ${state.selected.size ? 'selected' : 'shown'} project(s)? They keep what their ticked severities need.`)) return;
  allocateCredits({ clearExtras: true }, (n) => `Extra credits removed from ${n} project(s).`);
});
$('run-triage').addEventListener('click', runTriageNow);
$('track-save').addEventListener('click', saveTrackedReport);
$('reports-list').addEventListener('click', trackedReportAction);
$('reports-list').addEventListener('change', (event) => {
  const card = event.target.closest('[data-report]');
  if (!card) return;
  if (event.target.matches('[data-sev]')) updateNeed(card);
  if (event.target.name?.startsWith('sendTo-')) syncSendTo(card);
});
// Typing an address picks "Only to".
$('reports-list').addEventListener('input', (event) => {
  if (!event.target.matches('[data-field="onlyTo"]')) return;
  const card = event.target.closest('[data-report]');
  const only = card.querySelector('input[value="only"]');
  if (event.target.value.trim() && !only.checked) {
    only.checked = true;
    syncSendTo(card);
  }
});

$('select-all').addEventListener('change', (event) => {
  for (const project of visibleProjects()) {
    if (event.target.checked) state.selected.add(project.projectId);
    else state.selected.delete(project.projectId);
  }
  renderProjects();
  renderInitiatorList();
});

$('projects-body').addEventListener('click', (event) => {
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

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

function renderLogs() {
  const filter = {
    api: $('log-filter-api')?.checked ?? true,
    errors: $('log-filter-errors')?.checked ?? true,
    success: $('log-filter-success')?.checked ?? true,
  };
  const search = ($('log-search')?.value ?? '').toLowerCase();

  const filtered = logger.logs.filter((log) => {
    if (!filter[log.type]) return false;
    if (search && !log.message.toLowerCase().includes(search)) return false;
    return true;
  });

  const logsContainer = $('logs-list');
  const emptyEl = $('logs-empty');

  if (filtered.length === 0) {
    logsContainer.innerHTML = '';
    emptyEl.hidden = false;
  } else {
    emptyEl.hidden = true;
    logsContainer.innerHTML = filtered
      .map((log) => {
        const time = log.timestamp.slice(11, 19);
        const icon =
          log.type === 'error' ? '✗' : log.type === 'success' ? '✓' : log.type === 'api' ? '→' : '•';
        return `<div class="log-line log-${escapeHtml(log.type)}"><time>${time}</time><span>${icon} ${escapeHtml(log.message)}</span></div>`;
      })
      .join('');
  }

  if ($('logs-summary')) {
    $('logs-summary').textContent = `${logger.logs.length} log entries`;
  }
}

function renderLogsPage() {
  renderLogs();
}

// Logs tab event listeners
if ($('clear-logs')) {
  $('clear-logs').addEventListener('click', () => {
    logger.clear();
  });
}

if ($('export-logs')) {
  $('export-logs').addEventListener('click', () => {
    const logsJson = JSON.stringify(logger.logs, null, 2);
    const blob = new Blob([logsJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `logs-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    logger.add('Logs exported', 'success');
  });
}

if ($('log-filter-api')) {
  $('log-filter-api').addEventListener('change', renderLogs);
}

if ($('log-filter-errors')) {
  $('log-filter-errors').addEventListener('change', renderLogs);
}

if ($('log-filter-success')) {
  $('log-filter-success').addEventListener('change', renderLogs);
}

if ($('log-search')) {
  $('log-search').addEventListener('input', renderLogs);
}

/** The app's own name and logo, in the header and the browser tab. */
function applyAppBranding({ name, logoUrl } = {}) {
  const appName = name || 'Mission Zero';
  $('app-name').textContent = appName;
  document.title = appName;
  const logo = $('app-logo');
  logo.hidden = !logoUrl;
  if (logoUrl) {
    logo.src = logoUrl;
    logo.alt = `${appName} logo`;
  }
}

$('brand-logo-file').addEventListener('change', () => {
  const file = $('brand-logo-file').files[0];
  if (!file) return;
  if (file.size > 200 * 1024) {
    alert('That image is larger than 200 KB. Please use a smaller logo.');
    $('brand-logo-file').value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    $('brand-logo').value = reader.result;
    $('brand-logo').dispatchEvent(new Event('input'));
  };
  reader.readAsDataURL(file);
});

(async function init() {
  try {
    state.health = await api('/api/health');
    applyAppBranding(state.health.app);
    for (const problem of state.health.problems) console.warn(problem);
    fillPresets('activity-preset', 'any');
    fillPresets('detection-preset', 'any');
    updateScopeSummary();
  } catch {
    /* health is advisory only */
  }

  try {
    const session = await api('/api/session');
    if (session.signedIn) await afterSignIn(session);
    else showSignIn({ setup: session.setup });
  } catch (error) {
    showSignIn({ message: error.message });
  }
})();


// ---------------------------------------------------------------------------
// Beta: code authors and GitHub identities
// ---------------------------------------------------------------------------

const METHOD_NAMES = {
  localGit: 'Local git history',
  graphql: 'GraphQL batch',
  commits: 'Commit author',
  profile: 'Public profile',
};
const lines = (value) => String(value || '').split(/[\n,]+/).map((v) => v.trim()).filter(Boolean);

function renderBeta() {
  const github = state.settings?.beta?.github ?? {};
  const authors = state.settings?.beta?.authors ?? {};
  $('gh-token-state').textContent = github.tokenSet ? '(stored)' : '(not set)';
  $('gh-api').value = github.apiUrl ?? '';
  $('gh-org').value = github.org ?? '';
  $('gh-repos').value = (github.repos ?? []).join('\n');
  $('gh-local').value = (github.localRepos ?? []).join('\n');
  $('gh-blame-github').checked = authors.useGithubBlame !== false;
  $('gh-blame-local').checked = authors.useLocalBlame !== false;
  const scope = allocationScope();
  $('authors-scope').textContent = state.projects.length
    ? `${scope.length} project${scope.length === 1 ? '' : 's'} ${state.selected.size ? 'selected' : 'shown'} on the Dashboard`
    : 'Fetch projects on the Dashboard first';
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

$('gh-load-logins').addEventListener('click', async () => {
  try {
    const { logins } = await api('/api/beta/github/logins');
    if (!logins.length) return setStatus('gh-status', 'No usernames among the scan initiators — fetch projects on the Dashboard, or type them in.', 'error');
    // Unresolved ones first: those are the ones worth matching.
    logins.sort((a, b) => Number(b.unresolved) - Number(a.unresolved));
    $('gh-logins').value = logins.map((l) => l.login).join('\n');
    setStatus('gh-status', `${logins.length} username(s) from the scan initiators, ${logins.filter((l) => l.unresolved).length} without an email.`, 'ok');
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
    identityReport = await api('/api/beta/github/evaluate', {
      method: 'POST',
      body: JSON.stringify({ logins: lines($('gh-logins').value), methods }),
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
    const result = await api('/api/beta/github/apply', { method: 'POST', body: JSON.stringify({ mappings }) });
    setStatus('gh-apply-status', `${result.applied} saved. Fetch again on the Dashboard to use them.`, 'ok');
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

function renderAuthors() {
  $('authors-wrap').hidden = !authorItems.length;
  $('authors-actions').hidden = !authorItems.some((i) => i.author?.email);
  $('authors-body').innerHTML = authorItems
    .map((i) => {
      const sev = String(i.severity || '').toLowerCase();
      const where = i.location ? `${i.location.path}:${i.location.line}` : '';
      const author = i.author
        ? `<div class="person-main">${avatar(i.author.name || i.author.login || i.author.email)}<span class="person-text"><span class="person-name">${escapeHtml(i.author.name || i.author.login)}</span><span class="person-mail">${escapeHtml(i.author.email || 'no address')}${i.author.emailVia && i.author.emailVia !== 'commit' ? ` · via ${escapeHtml(METHOD_NAMES[i.author.emailVia] || i.author.emailVia)}` : ''}</span></span></div>`
        : '';
      return `<tr class="${i.author?.email ? '' : 'dim-row'}">
        <td class="checkbox"><input type="checkbox" data-author-key="${escapeHtml(i.key)}" ${i.author?.email ? 'checked' : 'disabled'} /></td>
        <td class="finding-cell"><span class="sev-dot sev-${escapeHtml(sev)}"></span>${i.url ? `<a href="${escapeHtml(i.url)}" target="_blank" rel="noopener">${escapeHtml(i.title)}</a>` : escapeHtml(i.title)}
          <div class="hint">${escapeHtml(i.projectName)} · ${escapeHtml(i.scanner)}${i.ageDays != null ? ` · ${i.ageDays}d` : ''}</div></td>
        <td class="mono where">${escapeHtml(where)}${i.problem ? `<div class="hint error-hint">${escapeHtml(i.problem)}</div>` : ''}</td>
        <td>${author}</td>
        <td class="mono">${i.commit ? `${i.commitUrl ? `<a href="${escapeHtml(i.commitUrl)}" target="_blank" rel="noopener">${escapeHtml(i.commit.slice(0, 8))}</a>` : escapeHtml(i.commit.slice(0, 8))}<div class="hint">${escapeHtml((i.committedAt || '').slice(0, 10))} · ${escapeHtml(i.via || '')}</div>` : ''}</td>
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

const audit = { entries: [], next: 0, more: false, loaded: false };
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
const formatTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }) : '—');
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
    e.actor?.ip && ['From', `${e.actor.ip}${e.actor.userAgent ? ` · ${e.actor.userAgent}` : ''}`],
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
  return `<div class="facts">${facts.map(([k, v]) => `<div><b>${escapeHtml(k)}</b>${escapeHtml(v)}</div>`).join('')}</div>
    <details><summary class="hint">Full entry (JSON)</summary><pre>${escapeHtml(JSON.stringify(e, null, 2))}</pre></details>`;
}

function renderAuditRows() {
  if (!audit.entries.length) {
    $('audit-body').innerHTML = '<tr><td colspan="9" class="hint">No audit entries match these filters.</td></tr>';
  } else {
    $('audit-body').innerHTML = audit.entries
      .map((e, i) => {
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
  $('audit-more').hidden = !audit.more;
  $('audit-count').textContent = audit.entries.length ? `Showing ${audit.entries.length.toLocaleString()} newest first` : '';
}

async function loadAudit({ append = false } = {}) {
  setStatus('audit-status', append ? '' : 'Loading…');
  try {
    const result = await api(`/api/audit?${auditQuery({ limit: 100, ...(append ? { before: audit.next } : {}) })}`);
    audit.entries = append ? audit.entries.concat(result.entries) : result.entries;
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
      ['Schedule', b.intervalHours ? `every ${b.intervalHours} h, keeping ${b.keep}${b.encrypted ? ', encrypted' : ', not encrypted (set BACKUP_PASSPHRASE)'}` : 'off (BACKUP_INTERVAL_HOURS=0)', !b.encrypted],
      ['Last backup', last, b.last && !b.last.ok],
      b.pendingRestore && ['Restore staged', 'applied when the server restarts', true],
      b.restoredAtStart && ['Restored at start', `backup of ${formatTime(b.restoredAtStart.createdAt)} (${b.restoredAtStart.files} files)`],
    ].filter(Boolean);
    $('backup-facts').innerHTML = facts.map(([k, v, warn]) => `<div><dt>${escapeHtml(k)}</dt><dd class="${warn ? 'warn' : ''}">${escapeHtml(v)}</dd></div>`).join('');
    $('backup-list-wrap').hidden = !b.backups.length;
    $('backup-list').innerHTML = b.backups.map((f) => `<tr><td class="code">${escapeHtml(f.name)}</td><td class="num">${formatBytes(f.size)}</td><td>${escapeHtml(formatTime(f.at))}</td></tr>`).join('');
    if (b.pendingRestore && $('restore-panel').hidden) {
      $('restore-panel').hidden = false;
      $('restore-panel').className = 'audit-result';
      $('restore-panel').innerHTML = '<span>A restore is staged and will be applied when the server restarts.</span><div><button type="button" id="restore-cancel" class="sm">Cancel the restore</button></div>';
    }
  } catch (error) {
    if (!handleAuthLoss(error)) showError('backup-status', error);
  }
}

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
        const passphrase = prompt(`${error.message}\n\nPassphrase:`);
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

function renderAudit() {
  if (!$('audit-month').value) $('audit-month').value = new Date().toISOString().slice(0, 7);
  loadAudit();
  loadBackupStatus();
}

// ---------------------------------------------------------------------------
// Reminder server address put into every report
// ---------------------------------------------------------------------------

const SERVER_SOURCES = {
  settings: 'set here',
  environment: 'from REPORT_SERVER_URL',
  'this page': 'the address this page is open on',
  'last dashboard address': 'the last address the dashboard was opened on',
  none: 'none',
};

async function loadReportServer() {
  let info;
  try {
    info = await api('/api/report-server');
  } catch {
    return;
  }
  state.reportServer = info;
  const warnings = info.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
  const automatic = info.automatic.url !== info.url
    ? `<p class="hint">Automatic reminders (nobody at this page) use ${info.automatic.url ? `<code>${escapeHtml(info.automatic.url)}</code>` : '<strong>no address</strong>'} — set the address here to make them match.</p>`
    : '';
  $('server-effective').innerHTML = `
    <p>Reports use <code>${escapeHtml(info.url || 'no address')}</code> <span class="muted">(${escapeHtml(SERVER_SOURCES[info.source] ?? info.source)})</span></p>
    ${warnings ? `<ul class="server-warnings">${warnings}</ul>` : ''}
    ${automatic}`;
  const note = $('server-note');
  note.hidden = !info.warnings.length;
  note.innerHTML = info.warnings.length
    ? `Reports will point readers to <code>${escapeHtml(info.url || 'no address')}</code>: ${escapeHtml(info.warnings[0])} <a href="#/settings" data-jump="set-server">Set the address</a>`
    : '';
}

$('server-note').addEventListener('click', (event) => {
  if (!event.target.matches('[data-jump]')) return;
  setTimeout(() => $('set-server')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
});

$('test-report-server').addEventListener('click', async () => {
  const typed = $('link-report-server').value.trim().replace(/\/+$/, '');
  const url = typed || state.reportServer?.url || '';
  const box = $('server-effective');
  if (!url) {
    box.innerHTML = '<p class="status error">Enter an address first.</p>';
    return;
  }
  const result = document.createElement('p');
  result.className = 'status';
  result.textContent = `Checking ${url}…`;
  box.prepend(result);
  try {
    const response = await fetch(`${url}/api/relay/ping`, { cache: 'no-store' });
    const body = await response.json().catch(() => null);
    if (body?.service !== 'mission-zero-relay') throw new Error(`${url} answered, but not as this reminder server.`);
    result.className = 'status ok';
    result.textContent = `Reachable from this browser. Readers on other networks need the same access (company network or VPN).${typed && typed !== state.settings?.links?.reportServerUrl ? ' Save to use it.' : ''}`;
  } catch (error) {
    result.className = 'status error';
    result.textContent = error.message.includes('answered') ? error.message : `Could not reach ${url} from this browser: check the address, DNS and firewall.`;
  }
});

// ---------------------------------------------------------------------------
// Checkmarx One integration (Settings): the server's own connection
// ---------------------------------------------------------------------------

async function loadIntegration() {
  let info;
  try {
    info = await api('/api/integration');
  } catch {
    return;
  }
  const c = info.connection ?? {};
  const source = { stored: 'key stored by an Admin', environment: 'CX_API_KEY on the server', none: 'not connected', 'stored (not reachable)': 'stored key — Checkmarx One not reachable' }[info.source] ?? info.source;
  $('connection-details').innerHTML = [
    ['Status', info.connected ? 'Connected' : 'Not connected'],
    ['Using', source],
    ['Tenant', c.tenant],
    ['API URL', c.baseUrl],
    ['IAM URL', c.iamUrl],
    ['Key expires', formatDate(c.expiresAt)],
  ]
    .map(([k, v]) => `<div><span class="k">${k}</span><span class="v">${escapeHtml(v ?? '—')}</span></div>`)
    .join('');
  $('integration-base').value = info.overrides?.baseUrl ?? '';
  $('integration-iam').value = info.overrides?.iamUrl ?? '';
  $('integration-tenant').value = info.overrides?.tenant ?? '';
  $('integration-remove').hidden = !info.keyStored;
  $('integration-key').placeholder = state.me?.via === 'cxone' ? 'Blank: use the key you signed in with' : 'Paste the API key for this server';
}

$('integration-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus('integration-status', 'Verifying the key against Checkmarx One…');
  try {
    await api('/api/integration/cxone', {
      method: 'POST',
      body: JSON.stringify({
        apiKey: $('integration-key').value.trim(),
        baseUrl: $('integration-base').value.trim(),
        iamUrl: $('integration-iam').value.trim(),
        tenant: $('integration-tenant').value.trim(),
      }),
    });
    $('integration-key').value = '';
    setStatus('integration-status', 'Connected and stored. Everyone signed in with a password now uses it.', 'ok');
    await loadIntegration();
    const me = await api('/api/me');
    state.me = me;
    if (me.connection) {
      state.connection = me.connection;
      $('connection').textContent = `${me.connection.tenant} · ${me.connection.regionLabel} · ${me.connection.baseUrl}`;
      $('connection').className = 'sub conn-pill ok';
    }
  } catch (error) {
    if (!handleAuthLoss(error)) showError('integration-status', error);
  }
});

$('integration-remove').addEventListener('click', async () => {
  if (!confirm('Remove the stored Checkmarx One key? Password sign-ins, report triage and automation stop working until a key is stored again (unless CX_API_KEY is set on the server).')) return;
  try {
    await api('/api/integration/cxone', { method: 'DELETE' });
    setStatus('integration-status', 'Stored key removed.', 'ok');
    loadIntegration();
  } catch (error) {
    if (!handleAuthLoss(error)) showError('integration-status', error);
  }
});

// ---------------------------------------------------------------------------
// Access: people, roles and the permission matrix
// ---------------------------------------------------------------------------

const access = { data: null, edits: new Map() };

async function loadAccess() {
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

function renderAccess() {
  const { users, roles } = access.data;
  const assignable = roles.filter((r) => r.canAssign);
  $('iam-add-role').innerHTML = assignable.map((r) => `<option value="${escapeHtml(r.id)}" ${r.id === 'user' ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('');

  $('iam-users').innerHTML = users
    .map((u) => {
      const me = u.id === state.me.user.id;
      const status = u.disabled ? '<span class="badge bad">Disabled</span>' : u.locked ? '<span class="badge warn">Locked</span>' : u.mustChangePassword ? '<span class="badge muted">Must set password</span>' : '<span class="badge">Active</span>';
      const methods = [u.hasPassword ? 'Password' : '', `Checkmarx One: ${[u.email, ...u.cxoneIdentities].map(escapeHtml).join(', ')}`].filter(Boolean).join('<br>');
      const roleCell = u.canManage
        ? `<select data-iam-role="${u.id}" aria-label="Role of ${escapeHtml(u.email)}">${roles
            .filter((r) => r.canAssign || r.id === u.role)
            .map((r) => `<option value="${escapeHtml(r.id)}" ${r.id === u.role ? 'selected' : ''} ${r.canAssign ? '' : 'disabled'}>${escapeHtml(r.name)}</option>`)
            .join('')}</select>`
        : `<span class="role-pill role-${escapeHtml(u.role)}">${escapeHtml(roleName(u.role))}</span>`;
      const actions = u.canManage
        ? `<button type="button" class="link" data-iam-reset="${u.id}">Set password</button>
           <button type="button" class="link" data-iam-ids="${u.id}">Identities</button>
           <button type="button" class="link" data-iam-toggle="${u.id}">${u.disabled ? 'Enable' : 'Disable'}</button>
           <button type="button" class="link danger" data-iam-delete="${u.id}">Remove</button>`
        : me ? '<span class="hint">You</span>' : '';
      return `<tr>
        <td><strong>${escapeHtml(u.name || u.email)}</strong>${u.name ? `<small class="muted block">${escapeHtml(u.email)}</small>` : ''}</td>
        <td>${roleCell}</td>
        <td class="small-text">${methods}</td>
        <td>${status}</td>
        <td class="when">${u.lastLoginAt ? escapeHtml(formatTime(u.lastLoginAt)) : '<span class="hint">never</span>'}</td>
        <td><div class="row-actions">${actions}</div></td>
      </tr>`;
    })
    .join('');
  renderMatrix();
}

/** Permissions down the side, roles across the top; tick to change what a role may do. */
function renderMatrix() {
  const { roles, permissions, me } = access.data;
  const mine = new Set(me.permissions);
  const groups = [...new Set(permissions.map((p) => p.group))];
  const valueOf = (role, pid) => (access.edits.get(role.id) ?? new Set(role.permissions)).has(pid);
  const head = `<thead><tr><th>Permission</th>${roles
    .map((r) => `<th class="role-col" title="${escapeHtml(r.description || '')}"><span class="role-pill role-${escapeHtml(r.id)}">${escapeHtml(r.name)}</span><small>${r.users} ${r.users === 1 ? 'person' : 'people'}${r.locked ? ' · fixed' : ''}</small>${
      r.canManage && !r.builtin ? `<button type="button" class="link danger" data-iam-role-delete="${escapeHtml(r.id)}">Remove</button>` : ''
    }</th>`)
    .join('')}</tr></thead>`;
  const body = groups
    .map((group) => {
      const rows = permissions
        .filter((p) => p.group === group)
        .map((p) => `<tr><td><span class="perm-label">${escapeHtml(p.label)}${p.special ? ' <span class="badge warn">Admin</span>' : ''}</span><small class="perm-desc">${escapeHtml(p.description)}</small></td>${roles
          .map((r) => {
            const editable = r.canManage && mine.has(p.id);
            const checked = valueOf(r, p.id);
            return `<td class="cell"><input type="checkbox" data-matrix-role="${escapeHtml(r.id)}" data-matrix-perm="${escapeHtml(p.id)}" ${checked ? 'checked' : ''} ${editable ? '' : 'disabled'} aria-label="${escapeHtml(r.name)}: ${escapeHtml(p.label)}" /></td>`;
          })
          .join('')}</tr>`)
        .join('');
      return `<tbody><tr class="group-row"><th colspan="${roles.length + 1}">${escapeHtml(group)}</th></tr>${rows}</tbody>`;
    })
    .join('');
  $('iam-matrix').innerHTML = head + body;
  $('iam-matrix-actions').hidden = access.edits.size === 0;
}

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

$('iam-role-new').addEventListener('click', () => {
  $('iam-role-form').hidden = !$('iam-role-form').hidden;
  if (!$('iam-role-form').hidden) $('iam-role-name').focus();
});
$('iam-role-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    access.data = await api('/api/iam/roles', { method: 'POST', body: JSON.stringify({ name: $('iam-role-name').value.trim(), description: $('iam-role-desc').value.trim(), permissions: [] }) });
    $('iam-role-name').value = '';
    $('iam-role-desc').value = '';
    $('iam-role-form').hidden = true;
    renderAccess();
    setStatus('iam-matrix-status', 'Role created — tick its permissions in its column, then save.', 'ok');
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
  const id = button.dataset.iamReset || button.dataset.iamIds || button.dataset.iamToggle || button.dataset.iamDelete;
  const user = access.data.users.find((u) => u.id === id);
  if (!user) return;
  if (button.dataset.iamReset) {
    const password = generatePassword();
    if (!confirm(`Set a temporary password for ${user.email}? They are signed out and choose their own at next sign-in.`)) return;
    iamCall(`/api/iam/users/${id}/password`, { method: 'POST', body: JSON.stringify({ password }) }, `Temporary password for ${user.email}: ${password}`);
  } else if (button.dataset.iamIds) {
    const value = prompt(`Checkmarx One identities that sign in as ${user.email} — usernames or client ids, comma separated (their email always counts):`, user.cxoneIdentities.join(', '));
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
  const button = event.target.closest('[data-iam-role-delete]');
  if (!button) return;
  const id = button.dataset.iamRoleDelete;
  if (!confirm(`Remove the role "${roleName(id)}"?`)) return;
  iamCall(`/api/iam/roles/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Role removed.');
});
