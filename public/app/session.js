// Signing in and out: the sign-in, first-administrator, two-step, password and reset screens, what is shown once
// signed in, the connections in the header, and the terms of use.
import { qrSvgPath } from '../qr.js';
import { $, can, state } from './state.js';
import { escapeHtml } from './format.js';
import { api, helpHtml, renderLicenceBanner, setStatus, showError, toast } from './core.js';
import { PAGE_PERMS, applyPermissions, freshStart, initTabs, route, scrollMemory, setPageTitle, visitedPages } from './nav.js';
import { applyProfile, applyProfileLook, languagesChanged, showAvatar } from './profile.js';
import { loadSettings, showNotices } from './settings.js';
import { loadReportServer, renderTenantPicker } from './system.js';
import { renderGettingStarted, restoreLastScan } from './workbench.js';
import { applySupportChannel } from './help.js';
import { renderBackupBanner } from './audit.js';

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
  // The terms of use come first: an Admin accepts them for the organisation, then each person.
  if (me.terms && !me.terms.accepted) {
    me = await termsGate(me);
    if (!me) return;
  }
  state.me = me;
  state.connection = me.connection;
  for (const box of ['setup-box', 'signin-box', 'change-box', 'forgot-box', 'reset-box', 'twostep-box', 'recovery-box']) $(box).hidden = true;

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
  showAvatar($('me-avatar'), user);
  if (Array.isArray(me.languages)) languagesChanged(me.languages, true);
  applyProfile(me);
  applyProfileLook(me.user.profile);
  renderTenantPicker(me);
  $('me-detail').textContent = `${user.email} · ${me.role.name} · signed in with ${me.via === 'cxone' ? 'a Checkmarx One key' : me.via === 'sso' ? 'single sign-on' : 'a password'}`;
  $('user-menu').hidden = false;
  $('connect-panel').hidden = true;
  $('nav').hidden = false;
  $('nav-tools').hidden = false;
  $('sidebar-tools').hidden = false;
  $('palette-open').hidden = false;
  $('api-key').value = '';
  $('signin-password').value = '';
  $('detected').hidden = true;
  applyPermissions();

  if (!location.hash) location.hash = '#/dashboard';
  await loadSettings();
  applyPermissions();
  initTabs();
  applySupportChannel();
  route();
  renderGettingStarted();
  loadReportServer();
  if (me.configNotices?.length) showNotices(me.configNotices, { acknowledge: true });
  // The code running is not what the release workflow built: said to those who look after updates, at once.
  renderLicenceBanner(me.licence);
  renderBackupBanner(me.backupNotice);
  if (['tampered', 'not-genuine'].includes(me.integrity?.state)) toast(me.integrity.state === 'tampered' ? 'Software integrity: files changed. Settings → Update & recovery has the details.' : 'Software integrity: not signed by the release workflow. Settings → Update & recovery has the details.', 'bad', 15000);
  if (me.hasScan && !freshStart) restoreLastScan();
  startConnections();
  if (!me.connection) {
    setStatus('status', can('integration.cxone')
      ? 'Connect this server to Checkmarx One under Settings → Checkmarx One before fetching.'
      : 'Checkmarx One is not connected on this server yet. Ask an Admin to connect it.', 'error');
  }
}

// ---------------------------------------------------------------------------
// Connections in the header: Checkmarx One, email, GitHub — green when
// working, red when not; click one for its details.
// ---------------------------------------------------------------------------

const CONNECTIONS = {
  cxone: { title: 'Checkmarx One', settings: '#/settings/connection', fields: (c) => [['Tenant', c.tenant], ['API', c.apiUrl], ['IAM', c.iamUrl], ['Key', c.source === 'environment' ? 'CX_API_KEY (environment)' : c.source === 'stored' ? 'stored in Settings' : c.source]] },
  smtp: { title: 'Email server', settings: '#/settings/smtp', fields: (c) => [['Server', c.host ? `${c.host}:${c.port ?? ''}` : ''], ['Security', c.host ? c.tls : ''], ['From', c.from], ['Tested', c.verifiedAt ? new Date(c.verifiedAt).toLocaleString() : '']] },
  git: { title: 'Git hosts', settings: '#/beta/hosts' },
};

/** Each git host's mark, drawn small in the header: one per connection. */
const GIT_LOGOS = {
  github: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>',
  gitlab: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.6 2.4 14.6a.75.75 0 0 1-.27-.84L3.3 10.2l2.2-6.7a.4.4 0 0 1 .76 0L8.5 10.3h7l2.24-6.8a.4.4 0 0 1 .76 0l2.2 6.7 1.17 3.56a.75.75 0 0 1-.27.84z"/></svg>',
  azure: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 5.6v12.6l-5.2 4.3-8.1-3v3l-4.5-5.9 13.2 1V6.3zM17.6 6.1 10.2 1.5v3L3.4 6.5 2 8.3v4.2l2.9 1.2V8.3z"/></svg>',
  bitbucket: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M2.65 3a.65.65 0 0 0-.65.75l2.73 16.6c.07.42.43.73.86.73h13.1c.32 0 .59-.23.64-.55L22 3.75A.65.65 0 0 0 21.35 3zM14.1 15h-4.2l-1.13-5.9h6.4z"/></svg>',
};
const GIT_GENERIC = '<svg class="git-generic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="9" r="2" /><path d="M6 7v10M18 11c0 4-6 3-12 6" /></svg>';
const gitName = (i) => `${i.label}${i.n > 1 ? ` #${i.n}` : ''}`;

let connectionStatus = null;
let connectionTimer = null;
let connectionPoll = null;

async function loadConnections() {
  try {
    connectionStatus = await api('/api/connections', { quiet: true });
  } catch {
    return;
  }
  renderConnections();
}

export function refreshConnectionsSoon() {
  clearTimeout(connectionTimer);
  connectionTimer = setTimeout(loadConnections, 400);
}

function renderConnections() {
  if (!connectionStatus) return;
  for (const chip of document.querySelectorAll('.conn-chip')) {
    const key = chip.dataset.conn;
    const c = connectionStatus[key];
    if (!c) continue;
    // Git: green when every connection answers, amber when some do, red when none (or none set up).
    const partial = key === 'git' && !c.ok && c.connected > 0;
    chip.classList.toggle('ok', c.ok);
    chip.classList.toggle('warn', partial);
    chip.classList.toggle('bad', !c.ok && !partial);
    chip.title = key === 'git'
      ? `Git: ${c.total ? `${c.connected} of ${c.total} connected — ${c.instances.map((i) => `${gitName(i)} ${i.ok ? '✓' : '✗'}`).join(', ')}` : 'not connected'}`
      : `${CONNECTIONS[key].title}: ${c.ok ? 'connected' : 'not connected'}${c.reason ? ` — ${c.reason}` : ''}`;
  }
  renderGitLogos(connectionStatus.git);
  renderMoreHosts(connectionStatus.git);
  const pop = $('conn-pop');
  if (!pop.hidden && pop.dataset.conn) showConnection(pop.dataset.conn);
}

/** One small logo per git connection, ringed green (answers) or red. */
function renderGitLogos(git) {
  const box = $('git-logos');
  if (!git) return;
  box.innerHTML = git.instances.length
    ? git.instances.map((i) => `<span class="git-logo ${i.ok ? 'ok' : 'bad'}" data-provider="${i.provider}">${GIT_LOGOS[i.provider]}${i.n > 1 ? `<b>${i.n}</b>` : ''}</span>`).join('')
    : GIT_GENERIC;
  $('conn-group').querySelector('[data-conn="git"]').setAttribute('aria-label', `Git connections: ${git.connected} of ${git.total} connected`);
}

/** Beta → Source-code hosts: the numbered connections, read from the .env file. */
function renderMoreHosts(git) {
  const box = $('more-hosts-list');
  const extra = (git?.instances ?? []).filter((i) => i.n > 1);
  if (!box || !extra.length) return;
  box.innerHTML = `<ul class="git-rows">${extra
    .map((i) => `<li class="git-row ${i.ok ? 'ok' : 'bad'}"><span class="git-logo ${i.ok ? 'ok' : 'bad'}" data-provider="${i.provider}">${GIT_LOGOS[i.provider]}<b>${i.n}</b></span>
      <span class="git-row-text"><strong>${escapeHtml(gitName(i))}</strong><small>${escapeHtml([i.host, i.owner, i.ok && i.who ? `as ${i.who}` : ''].filter(Boolean).join(' · '))}</small>${i.ok ? '' : `<small class="git-why">${escapeHtml(i.reason)}</small>${helpHtml(i.help, { open: false })}`}</span>
      <span class="conn-state ${i.ok ? 'ok' : 'bad'}">${i.ok ? 'Connected' : 'Not working'}</span></li>`)
    .join('')}</ul>`;
}

function showConnection(key) {
  const c = connectionStatus?.[key];
  const meta = CONNECTIONS[key];
  const pop = $('conn-pop');
  if (!c || !meta) return;
  pop.dataset.conn = key;
  if (key === 'git') return showGitConnections(c, pop);
  pop.classList.remove('wide');
  const rows = meta.fields(c).filter(([, value]) => value);
  pop.innerHTML = `<h3>${escapeHtml(meta.title)} <span class="conn-state ${c.ok ? 'ok' : 'bad'}">${c.ok ? 'Connected' : 'Not connected'}</span></h3>
    ${rows.length ? `<dl>${rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd>`).join('')}</dl>` : ''}
    ${c.reason ? `<p class="conn-reason">${escapeHtml(c.reason)}</p>` : ''}
    ${helpHtml(c.help)}
    <p class="conn-reason"><a href="${meta.settings}">Settings →</a></p>`;
  pop.hidden = false;
}

/** Every git host at a glance: each connection with its logo, who the token is, and where it points. */
function showGitConnections(git, pop) {
  pop.classList.add('wide');
  const source = (i) => (i.source === 'settings' ? 'stored on the Beta page' : `${i.variables} (.env)`);
  const row = (i) => `<li class="git-row ${i.ok ? 'ok' : 'bad'}">
      <span class="git-logo ${i.ok ? 'ok' : 'bad'}" data-provider="${i.provider}">${GIT_LOGOS[i.provider]}</span>
      <span class="git-row-text"><strong>${escapeHtml(gitName(i))}</strong>
        <small>${escapeHtml([i.host, i.owner, i.ok && i.who ? `as ${i.who}` : ''].filter(Boolean).join(' · '))}</small>
        <small class="muted">${escapeHtml(source(i))}${i.checkedAt ? ` · checked ${escapeHtml(new Date(i.checkedAt).toLocaleTimeString())}` : ''}</small>
        ${i.ok ? '' : `<small class="git-why">${escapeHtml(i.reason)}</small>${helpHtml(i.help, { open: false })}`}</span>
      <span class="conn-state ${i.ok ? 'ok' : 'bad'}">${i.ok ? 'Connected' : 'Not working'}</span>
    </li>`;
  pop.innerHTML = `<h3>Git hosts <span class="conn-state ${git.ok ? 'ok' : git.connected ? 'warn' : 'bad'}">${git.total ? `${git.connected} of ${git.total} connected` : 'None connected'}</span></h3>
    ${git.instances.length ? `<ul class="git-rows">${git.instances.map(row).join('')}</ul>` : ''}
    ${git.missing.length ? `<p class="conn-reason">Not connected: ${git.missing.map((m) => `<span class="git-missing"><span class="git-logo off" data-provider="${m.provider}">${GIT_LOGOS[m.provider]}</span>${escapeHtml(m.label)} <code>${escapeHtml(m.variables)}</code></span>`).join(' ')}</p>` : ''}
    <p class="conn-reason">A second connection to the same host: the same variables numbered, e.g. <code>GITHUB_TOKEN_2</code> with <code>GITHUB_API_URL_2</code>, up to <code>_9</code>. <a href="${CONNECTIONS.git.settings}">Git hosts →</a></p>`;
  pop.hidden = false;
}

export function wireConnections() {
  $('conn-group').addEventListener('click', (event) => {
    const chip = event.target.closest('.conn-chip');
    if (!chip) return;
    const pop = $('conn-pop');
    if (!pop.hidden && pop.dataset.conn === chip.dataset.conn) {
      pop.hidden = true;
      return;
    }
    showConnection(chip.dataset.conn);
    loadConnections();
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#conn-group')) $('conn-pop').hidden = true;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') $('conn-pop').hidden = true;
  });
}

function startConnections() {
  $('connection').hidden = true;
  $('conn-group').hidden = false;
  loadConnections();
  clearInterval(connectionPoll);
  connectionPoll = setInterval(loadConnections, 60_000);
}

function stopConnections() {
  clearInterval(connectionPoll);
  $('conn-group').hidden = true;
  $('conn-pop').hidden = true;
  $('connection').hidden = false;
}

/** Not signed in: setup (first start), sign-in, or a required password change. */
export function showSignIn({ setup = false, change = false, message = '' } = {}) {
  state.me = null;
  state.page = null;
  state.connection = null;
  state.projects = [];
  state.selected.clear();
  stopConnections();
  $('connection').textContent = setup ? 'First start' : 'Signed out';
  $('connection').className = 'sub conn-pill';
  setPageTitle('connect');
  $('page-title').textContent = setup ? 'Welcome' : change ? 'New password' : 'Sign in';
  $('connect-panel').hidden = false;
  $('setup-box').hidden = !setup;
  $('signin-box').hidden = setup || change;
  $('change-box').hidden = !change;
  $('forgot-box').hidden = true;
  $('reset-box').hidden = true;
  $('twostep-box').hidden = true;
  $('recovery-box').hidden = true;
  $('change-form').hidden = false;
  $('change-none').hidden = true;
  setStatus('sso-status', '');
  if (!setup && !change) refreshForgotLink();
  $('change-cancel').hidden = change;
  $('change-current-field').hidden = false;
  $('nav').hidden = true;
  $('nav-tools').hidden = true;
  $('sidebar-tools').hidden = true;
  $('palette-open').hidden = true;
  $('page-reload').hidden = true;
  $('page-stage').hidden = true;
  visitedPages.clear();
  scrollMemory.clear();
  $('user-menu').hidden = true;
  $('user-menu').open = false;
  for (const page of Object.keys(PAGE_PERMS)) $(`page-${page}`).hidden = true;
  if (message) setStatus(setup ? 'setup-status' : change ? 'change-status' : 'signin-status', message, 'error');
}
const showDisconnected = (message) => showSignIn({ message });

export function afterSignIn(me) {
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

// ---- Forgotten password: a one-time link to the account's own email --------------------------

/**
 * "Forgot your password?" shows only when the server can send the link (policy, email, address); the single
 * sign-on button only when an Admin turned it on, with the label they gave it.
 */
async function refreshForgotLink() {
  try {
    const session = await api('/api/session');
    $('forgot-open').hidden = !session.passwordReset;
    // (A reason for coming back from the identity provider without a sign-in stays readable, even with the button gone.)
    $('sso-signin').hidden = !session.sso && !$('sso-status').textContent;
    $('sso-button').hidden = !session.sso;
    $('sso-password-note').hidden = !session.sso?.passwordAdminsOnly;
    if (session.sso) $('sso-button').textContent = session.sso.label;
  } catch {
    $('forgot-open').hidden = true;
    $('sso-signin').hidden = !$('sso-status').textContent;
    $('sso-button').hidden = true;
  }
}

// ---- Single sign-on: off to the identity provider, and what to say when it sends someone back without signing them in ----

/** The server sends people back with a short code (#sso=…), never with the provider's own words: these are the sentences. */
const SSO_REFUSALS = {
  off: 'Single sign-on is not turned on here. Sign in with your email and password.',
  setup: 'Single sign-on is not set up completely. Ask an administrator.',
  provider: 'The identity provider could not be reached, or did not answer as expected. Try again in a moment, or ask an administrator.',
  cancelled: 'The identity provider did not sign you in. Try again.',
  expired: 'That sign-in took too long, or was started in another browser. Try again.',
  token: "The identity provider's answer could not be verified, so nobody was signed in. Ask an administrator.",
  email: 'The identity provider did not give a verified email address for you. Ask an administrator.',
  domain: 'Your email address is not one that may sign in here this way.',
  unknown: 'The identity provider signed you in, but you have no access here yet. Ask an administrator to add you.',
  link: 'Your account here is linked to another account at the identity provider. Ask an administrator.',
  disabled: 'This account is disabled. Ask an administrator.',
  busy: 'Too many sign-in attempts from this address. Wait a few minutes.',
};
export const ssoRefusalCode = () => /^#sso=([a-z]{1,20})$/.exec(location.hash)?.[1] ?? '';

/** Back from the identity provider without a sign-in: say why on the sign-in page, and take the code out of the address. */
export function showSsoRefusal(code) {
  history.replaceState(null, '', location.pathname + location.search);
  if (state.me) return;
  showSignIn();
  setStatus('sso-status', Object.hasOwn(SSO_REFUSALS, code) ? SSO_REFUSALS[code] : 'Single sign-on did not work. Try again, or ask an administrator.', 'error');
  $('sso-signin').hidden = false;
}

function showForgot() {
  showSignIn();
  $('signin-box').hidden = true;
  $('forgot-box').hidden = false;
  $('page-title').textContent = 'Forgot your password?';
  $('forgot-email').value = $('signin-email').value.trim();
  setStatus('forgot-status', '');
  $('forgot-submit').disabled = false;
  $('forgot-email').focus();
}

async function askForReset(event) {
  event.preventDefault();
  const button = $('forgot-submit');
  button.disabled = true;
  setStatus('forgot-status', 'Sending…');
  try {
    const answer = await api('/api/session/password-reset', { method: 'POST', body: JSON.stringify({ email: $('forgot-email').value.trim() }) });
    setStatus('forgot-status', answer.message, 'ok');
    // One link a minute is all the server sends anyway.
    setTimeout(() => (button.disabled = false), 60_000);
  } catch (error) {
    showError('forgot-status', error);
    button.disabled = false;
  }
}

let resetToken = '';
/** Opened from the emailed link: the secret is taken out of the address bar at once. */
export async function showReset(token) {
  resetToken = token;
  history.replaceState(null, '', location.pathname + location.search);
  showSignIn();
  $('signin-box').hidden = true;
  $('reset-box').hidden = false;
  $('reset-form').hidden = true;
  $('reset-dead').hidden = true;
  $('page-title').textContent = 'New password';
  $('reset-for').textContent = 'Checking the link…';
  $('reset-email').hidden = true;
  try {
    const link = await api('/api/session/password-reset/check', { method: 'POST', body: JSON.stringify({ token }) });
    $('reset-for').textContent = 'For this account. The link works once, for 30 minutes from when it was sent.';
    $('reset-email').textContent = link.email;
    $('reset-email').hidden = false;
    $('reset-form').hidden = false;
    $('reset-next').focus();
  } catch (error) {
    resetToken = '';
    $('reset-for').textContent = error.message;
    $('reset-dead').hidden = false;
  }
}

async function confirmReset(event) {
  event.preventDefault();
  if ($('reset-next').value !== $('reset-next2').value) return setStatus('reset-status', 'The passwords do not match.', 'error');
  const button = $('reset-submit');
  button.disabled = true;
  setStatus('reset-status', 'Saving…');
  try {
    const done = await api('/api/session/password-reset/confirm', { method: 'POST', body: JSON.stringify({ token: resetToken, password: $('reset-next').value }) });
    resetToken = '';
    $('reset-next').value = '';
    $('reset-next2').value = '';
    showSignIn();
    $('signin-email').value = done.email ?? '';
    setStatus('signin-status', 'Your password was changed. Sign in with the new one.', 'ok');
    $('signin-password').focus();
  } catch (error) {
    showError('reset-status', error);
  } finally {
    button.disabled = false;
  }
}

/** The emailed link: #reset=<token>. */
export const resetLinkToken = () => /^#reset=([A-Za-z0-9_-]{43})$/.exec(location.hash)?.[1] ?? '';

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
    // Two-step sign-in: the password was right, and the code (or setting it up) comes before anyone is signed in.
    if (me.ticket) showTwoStep(me);
    else await afterSignIn(me);
  } catch (error) {
    showError('signin-status', error);
  } finally {
    button.disabled = false;
  }
}

// ---- Two-step sign-in: a code from an authenticator app after the password ----------------------

/**
 * The key for an authenticator app: as a QR code made here in the page (public/qr.js: nothing is fetched),
 * and as text with a Copy button for a phone that cannot scan it.
 */
export function showTwoStepKey(container, setup) {
  container.textContent = '';
  try {
    const { viewBox, d } = qrSvgPath(setup.otpauth);
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'QR code for your authenticator app');
    svg.setAttribute('shape-rendering', 'crispEdges');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', '#000');
    svg.append(path);
    const frame = document.createElement('div');
    frame.className = 'twostep-qr';
    frame.append(svg);
    container.append(frame);
  } catch {
    // Too long for a QR code made here (a very long email address): the key below does the same.
  }
  const text = document.createElement('div');
  text.className = 'twostep-key-text';
  text.innerHTML = '<span class="hint">The key, if you cannot scan the code:</span><code translate="no"></code><span class="actions compact"><button type="button" class="sm">Copy the key</button><span class="status" aria-live="polite"></span></span>';
  text.querySelector('code').textContent = setup.key;
  copyButton(text.querySelector('button'), text.querySelector('.status'), setup.secret);
  container.append(text);
}

/** A button that copies `value` (a text, or a function that gives it when the button is pressed), and says so beside it. */
export function copyButton(button, status, value) {
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(typeof value === 'function' ? value() : value);
      status.textContent = 'Copied.';
      status.className = 'status ok';
    } catch {
      status.textContent = 'Could not copy: select the text and copy it.';
      status.className = 'status error';
    }
  });
}

/** Recovery codes, shown once: a list, and a Copy button. */
export function showRecoveryCodes(container, codes) {
  container.innerHTML = `<ul class="recovery-codes" translate="no">${codes.map((code) => `<li>${escapeHtml(code)}</li>`).join('')}</ul><div class="actions compact"><button type="button" class="sm">Copy the codes</button><span class="status" aria-live="polite"></span></div>`;
  copyButton(container.querySelector('button'), container.querySelector('.status'), codes.join('\n'));
}

/** Between the password and the code: the ticket the server gave, the key to set up (when it must be), and which kind of code is typed. */
let twoStep = null;

function showTwoStep(answer) {
  twoStep = { ticket: answer.ticket, setup: answer.setup ?? null, recovery: false };
  showSignIn();
  $('signin-box').hidden = true;
  $('twostep-box').hidden = false;
  $('page-title').textContent = 'Two-step sign-in';
  $('twostep-setup').hidden = !twoStep.setup;
  if (twoStep.setup) showTwoStepKey($('twostep-key'), twoStep.setup);
  $('twostep-code').value = '';
  setStatus('twostep-status', '');
  renderTwoStepKind();
  $('twostep-code').focus();
}

function renderTwoStepKind() {
  const { setup, recovery } = twoStep;
  $('twostep-hint').textContent = setup
    ? 'Then enter the six-digit code the app shows, to turn two-step sign-in on.'
    : recovery
      ? 'Enter one of the recovery codes you saved when you turned two-step sign-in on. Each works once.'
      : 'Enter the six-digit code your authenticator app shows for CxMissionZero.';
  $('twostep-label').textContent = recovery ? 'Recovery code' : 'Code';
  $('twostep-code').inputMode = recovery ? 'text' : 'numeric';
  $('twostep-recovery').hidden = Boolean(setup);
  $('twostep-recovery').textContent = recovery ? 'Use a code from the app' : 'Use a recovery code';
  $('twostep-submit').textContent = setup ? 'Turn on and sign in' : 'Sign in';
}

async function submitTwoStep(event) {
  event.preventDefault();
  if (!twoStep) return showSignIn();
  const button = $('twostep-submit');
  button.disabled = true;
  setStatus('twostep-status', 'Signing in…');
  try {
    const { recoveryCodes, ...me } = await api('/api/session/two-step', { method: 'POST', body: JSON.stringify({ ticket: twoStep.ticket, code: $('twostep-code').value.trim() }) });
    twoStep = null;
    $('twostep-code').value = '';
    setStatus('twostep-status', '');
    if (!recoveryCodes) return await afterSignIn(me);
    // Set up on the way in: the recovery codes are shown now, once, before the app opens.
    state.pendingMe = me;
    $('twostep-box').hidden = true;
    $('recovery-box').hidden = false;
    $('page-title').textContent = 'Recovery codes';
    showRecoveryCodes($('recovery-codes'), recoveryCodes);
  } catch (error) {
    $('twostep-code').value = '';
    if (error.body?.restart || error.status === 429) {
      // The five minutes or the tries are over: back to the password.
      twoStep = null;
      showSignIn();
      return showError('signin-status', error);
    }
    showError('twostep-status', error);
    $('twostep-code').focus();
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
  $('change-hint').textContent = me.user.hasPassword
    ? 'Enter your current password and choose a new one.'
    : me.via === 'sso'
      ? 'You signed in with single sign-on and have no password here. An administrator can give you one under People & roles.'
      : 'You signed in with a Checkmarx One key: set a password to also sign in with your email.';
  // Signed in with single sign-on, without a password: they cannot set one themselves, so there is no form.
  const none = !me.user.hasPassword && me.via === 'sso';
  $('change-form').hidden = none;
  $('change-none').hidden = !none;
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
// Wiring
// ---------------------------------------------------------------------------

export function wireSignIn() {
  window.addEventListener('hashchange', () => {
    const token = resetLinkToken();
    if (token) showReset(token);
    else if (ssoRefusalCode()) showSsoRefusal(ssoRefusalCode());
    else route();
  });
  $('sso-button').addEventListener('click', () => {
    setStatus('sso-status', 'Going to the identity provider…');
    location.href = '/api/session/oidc/start';
  });

  $('connect-form').addEventListener('submit', connect);
  $('password-form').addEventListener('submit', signInWithPassword);
  $('setup-form').addEventListener('submit', createFirstAdmin);
  $('forgot-open').addEventListener('click', showForgot);
  $('forgot-form').addEventListener('submit', askForReset);
  $('reset-form').addEventListener('submit', confirmReset);
  $('reset-again').addEventListener('click', showForgot);
  for (const id of ['forgot-back', 'reset-back']) {
    $(id).addEventListener('click', () => {
      resetToken = '';
      showSignIn();
    });
  }
  $('twostep-form').addEventListener('submit', submitTwoStep);
  $('twostep-recovery').addEventListener('click', () => {
    if (!twoStep) return;
    twoStep.recovery = !twoStep.recovery;
    $('twostep-code').value = '';
    setStatus('twostep-status', '');
    renderTwoStepKind();
    $('twostep-code').focus();
  });
  $('twostep-back').addEventListener('click', () => {
    twoStep = null;
    showSignIn();
  });
  $('recovery-done').addEventListener('click', () => {
    const me = state.pendingMe;
    state.pendingMe = null;
    $('recovery-codes').textContent = '';
    if (me) afterSignIn(me);
    else showSignIn();
  });
  $('change-form').addEventListener('submit', changePassword);
  $('change-cancel').addEventListener('click', () => {
    if (state.pendingMe) showConnected(state.pendingMe);
  });
  $('change-none-back').addEventListener('click', () => {
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
}

// ---------------------------------------------------------------------------
// Terms of use (TERMS.md): accepted by an Admin for the organisation, then by each person
// ---------------------------------------------------------------------------

/** The terms' Markdown, as safe HTML: headings, paragraphs, two levels of lists, bold and code. */
function termsHtml(markdown) {
  const inline = (text) => escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = [];
  const lists = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeLists = (depth = 0) => {
    while (lists.length > depth) {
      out.push('</li></ul>');
      lists.pop();
    }
  };
  for (const line of markdown.split('\n')) {
    const item = line.match(/^(\s*)- (.*)$/);
    if (item) {
      flush();
      const depth = Math.floor(item[1].length / 2) + 1;
      if (lists.length < depth) {
        out.push('<ul><li>');
        lists.push(depth);
      } else {
        closeLists(depth);
        out.push('</li><li>');
      }
      out.push(inline(item[2]));
      continue;
    }
    if (!line.trim()) {
      flush();
      closeLists();
      continue;
    }
    const heading = line.match(/^(#{1,3}) (.*)$/);
    if (heading) {
      flush();
      closeLists();
      if (heading[1].length > 1) out.push(`<h${heading[1].length + 1}>${inline(heading[2])}</h${heading[1].length + 1}>`);
      continue;
    }
    if (lists.length && /^\s+\S/.test(line)) out.push(` ${inline(line.trim())}`);
    else paragraph.push(line.trim());
  }
  flush();
  closeLists();
  return out.join('').replace(/<ul><li><\/li><li>/g, '<ul><li>');
}

/**
 * Show the terms. 'gate': before using the app; resolves with the updated "me" once accepted,
 * or null when declined (signed out). 'view': read only.
 */
export function showTermsOverlay({ mode = 'view', me = null } = {}) {
  return new Promise((resolve) => {
    const overlay = $('terms-overlay');
    const text = $('terms-text');
    const check = $('terms-check');
    const accept = $('terms-accept');
    const t = me?.terms;
    const waiting = mode === 'gate' && !t.organisationAccepted && !t.canAcceptForOrganisation;
    const forOrganisation = mode === 'gate' && !t.organisationAccepted && t.canAcceptForOrganisation;
    let version = '';
    $('terms-wait').hidden = !waiting;
    $('terms-retry').hidden = !waiting;
    $('terms-check-label').hidden = mode !== 'gate' || waiting;
    // The Admin accepting for the organisation names it (for the documents CxMissionZero makes).
    $('terms-org-label').hidden = !forOrganisation || Boolean(me?.organisationName);
    $('terms-org').value = me?.organisationName ?? '';
    $('terms-scroll-hint').hidden = mode !== 'gate' || waiting;
    accept.hidden = mode !== 'gate' || waiting;
    $('terms-decline').hidden = mode !== 'gate';
    $('terms-close').hidden = mode === 'gate';
    $('terms-check-text').textContent = forOrganisation
      ? 'I have read these terms and accept them for myself and on behalf of my organisation. Until they are accepted, nobody can use CxMissionZero.'
      : 'I have read these terms and accept them.';
    check.checked = false;
    check.disabled = true;
    accept.disabled = true;
    setStatus('terms-status', '');
    text.innerHTML = '<p class="hint">Loading…</p>';
    overlay.hidden = false;

    const reachedEnd = () => text.scrollTop + text.clientHeight >= text.scrollHeight - 24;
    const onScroll = () => {
      if (!reachedEnd()) return;
      check.disabled = false;
      $('terms-scroll-hint').hidden = true;
    };
    const needsName = () => !$('terms-org-label').hidden && !$('terms-org').value.trim();
    const onCheck = () => (accept.disabled = !check.checked || needsName());
    $('terms-org').oninput = onCheck;
    const finish = (value) => {
      overlay.hidden = true;
      text.removeEventListener('scroll', onScroll);
      check.removeEventListener('change', onCheck);
      accept.onclick = $('terms-decline').onclick = $('terms-close').onclick = $('terms-retry').onclick = $('terms-org').oninput = null;
      resolve(value);
    };
    text.addEventListener('scroll', onScroll);
    check.addEventListener('change', onCheck);

    fetch('/api/terms', { credentials: 'same-origin', cache: 'no-store' })
      .then((r) => r.json())
      .then((terms) => {
        version = terms.version;
        $('terms-title').textContent = `Terms of use · version ${terms.version}`;
        const org = terms.organisation;
        $('terms-sub').textContent = `CxMissionZero is an independent project, not a Checkmarx product.${org ? ` Accepted for the organisation by ${org.by} on ${new Date(org.at).toLocaleDateString()}.` : ''}`;
        text.innerHTML = termsHtml(terms.text);
        text.scrollTop = 0;
        requestAnimationFrame(onScroll); // short enough to need no scrolling
        text.focus();
      })
      .catch(() => (text.innerHTML = '<p class="status error">The terms could not be loaded. Reload the page.</p>'));

    accept.onclick = async () => {
      accept.disabled = true;
      try {
        const updated = await api('/api/terms/accept', { method: 'POST', quiet: true, body: JSON.stringify({ version, forOrganisation, organisationName: $('terms-org').value.trim() }) });
        finish(updated);
      } catch (error) {
        setStatus('terms-status', error.message, 'error');
        accept.disabled = false;
      }
    };
    $('terms-decline').onclick = async () => {
      finish(null);
      await disconnect();
      setStatus('signin-status', 'You declined the terms of use, so you were signed out.', 'error');
    };
    $('terms-retry').onclick = async () => {
      try {
        const fresh = await api('/api/me', { quiet: true });
        if (fresh.terms?.organisationAccepted) {
          finish(null);
          showConnected(fresh);
        } else setStatus('terms-status', 'Not accepted yet.', 'error');
      } catch (error) {
        setStatus('terms-status', error.message, 'error');
      }
    };
    $('terms-close').onclick = () => finish(null);
  });
}

const termsGate = (me) => showTermsOverlay({ mode: 'gate', me });

export function wireTerms() {
  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('[data-terms-open]');
    if (!link) return;
    event.preventDefault();
    if ($('terms-overlay').hidden) showTermsOverlay({ mode: 'view' });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('terms-overlay').hidden && !$('terms-close').hidden) $('terms-close').click();
  });
}
