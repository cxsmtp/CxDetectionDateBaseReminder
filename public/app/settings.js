// The Settings page: reading and showing the settings, saving them as they are typed, the connection guard,
// rollback notices, quick setup from a .env file, and the email and template checks.
import { checkPoolLimit, creditTimer, loadPool, poolTenant, renderAudience, renderRecipientHint } from '../app.js';
import { $, can, canAny, state } from './state.js';
import { escapeHtml, formatDate } from './format.js';
import { api, handleAuthLoss, helpHtml, hideToast, setStatus, showError, showHelp, toast } from './core.js';
import { LOOKS, applyAppIcon, applyOrgLook, fillCurrencies, iconKey, refreshMyAppBranding, renderIconPreview } from './profile.js';
import { loadIntegration, loadNetwork, loadReportServer } from './system.js';
import { loadAutomation } from './automation.js';
import { applySupportChannel } from './help.js';

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
    setStatus('status', 'The fixed list is saved.', 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('status', error);
  }
}

export async function loadSettings() {
  try {
    state.settings = await api('/api/settings');
    fillInlineRecipients();
    renderAudience();
    renderRecipientHint();
  } catch (error) {
    if (!handleAuthLoss(error)) console.warn(error.message);
  }
}

export function renderSettings() {
  const s = state.settings;
  if (!s) return;

  loadIntegration();
  loadNetwork();

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

  const sla = s.sla ?? { days: {}, escalate: false, escalateTo: [] };
  for (const severity of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) $(`sla-${severity}`).value = sla.days?.[severity] ?? 0;
  $('sla-escalate').checked = Boolean(sla.escalate);
  $('sla-escalate-to').value = (sla.escalateTo ?? []).join('\n');
  $('sla-issues').checked = Boolean(sla.openIssues);
  $('sla-status').textContent = sla.escalate && !(sla.escalateTo ?? []).length ? 'Add at least one address to escalate to.' : '';

  // The Branding page only for those who may see it (the server leaves it out otherwise).
  if (s.branding) {
    $('brand-app').value = s.branding.appName || 'CxMissionZero';
    $('brand-name').value = s.branding.companyName;
    $('brand-logo').value = s.branding.logoUrl;
    $('brand-icon').value = s.branding.iconUrl ?? '';
    renderIconPreview();
    $('brand-height').value = s.branding.logoHeight;
    $('brand-accent').value = /^#[0-9a-f]{6}$/i.test(s.branding.accentColor) ? s.branding.accentColor : '#1d4ed8';
    $('brand-cta').value = s.branding.callToAction;
    const orgLook = LOOKS.includes(s.branding.look) ? s.branding.look : s.branding.nextGen === false ? 'classic' : 'nextgen';
    for (const box of document.querySelectorAll('input[name="brand-look"]')) box.checked = box.value === orgLook;
    $('brand-look-choice').checked = s.branding.lookChoice !== false;
    $('brand-nav').value = s.branding.navPosition === 'top' ? 'top' : 'left';
    renderBrandPreview();
  }

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
  $('ai-pool-period').value = s.aiTriage?.poolPeriod === 'all' ? 'all' : 'month';
  checkPoolLimit();
  const support = s.support ?? {};
  const channel = state.me?.support ?? { mode: 'portal', email: '' };
  for (const box of document.querySelectorAll('input[name="support-mode"]')) box.checked = box.value === (support.mode || channel.mode);
  $('support-email').value = support.email || channel.email || '';
  renderSupportNote();
  const impact = s.impact ?? {};
  $('impact-triage-min').value = String(impact.triageMinutes ?? 20);
  $('impact-fix-min').value = String(impact.fixMinutes ?? 120);
  $('impact-rate').value = String(impact.hourlyRate ?? 0);
  $('impact-price').value = String(impact.creditPrice ?? 0);
  fillCurrencies($('impact-currency'), impact.currency || 'USD');
  $('impact-monthly-to').value = (impact.monthlyTo ?? []).join(', ');
  $('smtp-password').value = '';

  renderVerified();
  loadConnectionGuard();

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
    ...(can('feature.sla') && can('settings.automation')
      ? {
          sla: {
            days: Object.fromEntries(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((s) => [s, $(`sla-${s}`).value])),
            escalate: $('sla-escalate').checked,
            escalateTo: $('sla-escalate-to').value,
            openIssues: $('sla-issues').checked,
          },
        }
      : {}),
    branding: {
      appName: $('brand-app').value,
      companyName: $('brand-name').value,
      logoUrl: $('brand-logo').value,
      iconUrl: $('brand-icon').value,
      logoHeight: $('brand-height').value,
      accentColor: $('brand-accent').value,
      callToAction: $('brand-cta').value,
      look: brandLook(),
      lookChoice: $('brand-look-choice').checked,
      navPosition: $('brand-nav').value,
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
      poolPeriod: $('ai-pool-period').value,
    },
    // Numbers half-typed (or blank) are left out until they make sense, so typing never saves an error.
    impact: Object.fromEntries(
      [
        ['triageMinutes', $('impact-triage-min').value],
        ['fixMinutes', $('impact-fix-min').value],
        ['hourlyRate', $('impact-rate').value],
        ['creditPrice', $('impact-price').value],
      ]
        .filter(([, value]) => String(value).trim() !== '' && Number.isFinite(Number(value)))
        .map(([key, value]) => [key, Number(value)])
        .concat($('impact-currency').value ? [['currency', $('impact-currency').value]] : [])
        .concat([['monthlyTo', $('impact-monthly-to').value]]),
    ),
    support: supportSettings(),
  };
  // Only send a password when one was typed, so saving an unrelated field
  // never has to round-trip the stored secret through the browser.
  if ($('smtp-password').value) payload.smtp.password = $('smtp-password').value;
  // Send only the sections this person may change (the server enforces the same).
  const SECTION = { smtp: 'integration.smtp', recipients: 'settings.recipients', initiators: 'settings.initiators', template: 'settings.template', branding: 'settings.branding', links: 'settings.links', endpoints: 'integration.cxone' };
  for (const [key, permission] of Object.entries(SECTION)) if (!can(permission)) delete payload[key];
  if (!can('credits.limit')) {
    delete payload.aiTriage.monthlyCreditLimit;
    delete payload.aiTriage.poolPeriod;
  }
  // A pool above what the tenant has left is not sent: the rest saves, and the field says why it cannot.
  if (poolTenant && payload.aiTriage.monthlyCreditLimit > poolTenant.available) delete payload.aiTriage.monthlyCreditLimit;
  if (!can('settings.ai')) {
    const { monthlyCreditLimit, poolPeriod } = payload.aiTriage;
    payload.aiTriage = monthlyCreditLimit === undefined ? undefined : { monthlyCreditLimit, poolPeriod };
  }
  if (!payload.aiTriage) delete payload.aiTriage;
  if (!can('settings.ai')) delete payload.impact;
  if (!can('support.manage') || !payload.support) delete payload.support;
  return payload;
}

/** Settings → Get help: what is sent (email mode only once the address looks right, so typing never errors). */
function supportSettings() {
  const mode = document.querySelector('input[name="support-mode"]:checked')?.value;
  if (!mode) return undefined;
  const email = $('support-email').value.trim();
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (mode === 'email' && !valid) return undefined;
  const out = { mode, email: valid ? email : '' };
  // Applied here at once: the Get help menu follows without a reload.
  if (state.me) state.me.support = { mode, email: out.email || state.me.support?.email || '' };
  applySupportChannel();
  return out;
}

function renderSupportNote() {
  const mode = document.querySelector('input[name="support-mode"]:checked')?.value;
  const email = $('support-email').value.trim();
  $('support-email').closest('.field').hidden = mode !== 'email';
  const note = $('support-note');
  note.className = 'hint';
  if (mode === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    note.textContent = 'Enter the address requests go to. Until then, Get help keeps the support portal.';
    note.className = 'status warn';
  } else {
    note.textContent = mode === 'email' ? 'Nothing is stored in CxMissionZero: the conversation happens by email.' : 'Requests are kept here, numbered, and answered by the support team.';
  }
}

export function wireSupportNote() {
  for (const el of [...document.querySelectorAll('input[name="support-mode"]'), $('support-email')]) el.addEventListener('input', renderSupportNote);
}

// ---------------------------------------------------------------------------
// Settings save as they are typed
// ---------------------------------------------------------------------------

const AUTOSAVE_MS = 700;
const DRAFT_MS = 1200;
const CHECK_MS = 2500;
export const autosave = { settings: null, draft: null, check: null, running: new Set(), lastCheck: null, connectionEdited: false };
const INTEGRATION_FIELDS = new Set(['integration-key', 'integration-base', 'integration-iam', 'integration-tenant']);
const NOT_SAVED = new Set(['test-to', 'env-file', 'brand-logo-file', 'brand-icon-file']);

/** Which save an edit belongs to: the settings form, the integration draft, or none. */
function autosaveKind(el) {
  if (!el?.id || NOT_SAVED.has(el.id) || el.disabled || el.closest('[hidden]')?.id === 'probe-results' || el.closest('#set-https') || el.closest('#set-mybrand') || el.closest('#set-handsoff') || el.closest('#set-profile')) return '';
  if (INTEGRATION_FIELDS.has(el.id)) return 'draft';
  if (el.matches('input, select, textarea')) return 'settings';
  return '';
}

function onSettingsEdit(event) {
  const kind = autosaveKind(event.target);
  if (!kind) return;
  setStatus('save-status', 'Saving…');
  if (kind === 'settings') scheduleSave();
  if (kind === 'draft') {
    clearTimeout(autosave.draft);
    autosave.draft = setTimeout(() => track(saveIntegrationDraft()), DRAFT_MS);
  }
}

function scheduleSave() {
  clearTimeout(autosave.settings);
  autosave.settings = setTimeout(() => track(saveSettings()), AUTOSAVE_MS);
}

/** Keep count of saves in flight, so leaving the page can wait for them. */
function track(promise) {
  autosave.running.add(promise);
  promise.finally(() => {
    autosave.running.delete(promise);
    if (!autosave.running.size && !autosave.settings && !autosave.draft) {
      setStatus('save-status', `All changes are saved · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, 'ok');
    }
  });
  return promise;
}

/** Save everything pending now (leaving the page). */
async function flushSaves() {
  const pending = [];
  if (autosave.settings) pending.push(saveSettings());
  if (autosave.draft) pending.push(saveIntegrationDraft());
  for (const key of ['settings', 'draft']) clearTimeout(autosave[key]);
  autosave.settings = autosave.draft = null;
  await Promise.allSettled([...pending, ...autosave.running]);
}

async function saveSettings() {
  autosave.settings = null;
  const payload = settingsPayload();
  const before = state.settings;
  try {
    const saved = await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
    state.settings = saved;
    // Not re-rendering the form: that would fight the person typing in it.
    renderVerified();
    renderLinkExamples(saved.linkExamples);
    renderRecipientHint();
    $('password-state').textContent = saved.smtp.passwordSet ? '(stored)' : '(not set)';
    if (payload.branding && saved.branding) {
      applyAppIcon(iconKey(saved.branding.iconUrl));
      // The header shows this person's branding: the organisation's, with their own over it.
      if (JSON.stringify(before?.branding) !== JSON.stringify(saved.branding)) refreshMyAppBranding();
    }
    if (JSON.stringify(before?.links) !== JSON.stringify(saved.links)) loadReportServer();
    if (JSON.stringify(before?.aiTriage) !== JSON.stringify(saved.aiTriage)) loadPool();
    if (payload.smtp && !saved.verified && saved.smtp.host) {
      autosave.connectionEdited = true;
      renderGuardLine('smtp-guard', 'warn', 'Saved — not tested yet. Checking the mail server in a moment…');
      scheduleCheck();
    }
  } catch (error) {
    if (!handleAuthLoss(error)) showError('save-status', error);
    throw error;
  }
}

function renderVerified() {
  const s = state.settings;
  $('verified-state').textContent = s.verified
    ? `Connection test passed ${formatDate(s.verifiedAt)}. Sending is enabled.`
    : 'No successful connection test for the current settings yet.';
  $('verified-state').className = `hint ${s.verified ? 'ok-hint' : 'error-hint'}`;
}

/** The integration key and endpoints, saved as typed but not used until a check connects with them. */
async function saveIntegrationDraft() {
  autosave.draft = null;
  const key = $('integration-key').value.trim();
  try {
    const info = await api('/api/integration/cxone/draft', {
      method: 'PUT',
      body: JSON.stringify({
        ...(key ? { apiKey: key } : {}),
        baseUrl: $('integration-base').value.trim(),
        iamUrl: $('integration-iam').value.trim(),
        tenant: $('integration-tenant').value.trim(),
      }),
    });
    // The key is stored on the server now; it is never shown again.
    if (key && $('integration-key').value.trim() === key) $('integration-key').value = '';
    if (info.pending) {
      autosave.connectionEdited = true;
      renderGuardLine('integration-guard', 'warn', 'Saved — not in use yet. Checking the connection in a moment…');
      scheduleCheck();
    }
  } catch (error) {
    if (!handleAuthLoss(error)) showError('integration-status', error);
    throw error;
  }
}

function scheduleCheck() {
  clearTimeout(autosave.check);
  autosave.check = setTimeout(() => checkConnections({ rollback: false }), CHECK_MS);
}

function renderGuardLine(id, kind, text, extra = '', help = null) {
  const el = $(id);
  el.hidden = !text;
  el.className = `guard-line ${kind}`;
  el.innerHTML = `<span>${escapeHtml(text)}</span>${extra ? `<span class="muted">${escapeHtml(extra)}</span>` : ''}`;
  showHelp(el, text ? help : null);
}

const goodSince = (good) => (good?.at ? ` (working since ${new Date(good.at).toLocaleString()})` : '');

/** Show, under each connection, whether a change is waiting and what the last known good one is. */
function renderConnectionGuard(status, result = autosave.lastCheck) {
  if (!status) return;
  const { pending, lastGood } = status;
  const cx = lastGood.cxone;
  const cxGood = cx ? `Previous working setup: tenant ${cx.tenant || '—'}${cx.source === 'environment' ? ' (CX_API_KEY on the server)' : ''}${goodSince(cx)}.` : '';
  if (pending.cxone) {
    const failed = result?.cxone && result.cxone.ok === false && !result.cxone.superseded;
    renderGuardLine('integration-guard', failed ? 'bad' : 'warn',
      failed ? `Not working: ${result.cxone.error}` : 'Saved — not checked yet.',
      cx ? `${cxGood} It comes back when you leave Settings if this still fails.` : 'There is no earlier working connection to go back to.',
      failed ? result.cxone.help : null);
  } else if (result?.cxone?.ok) {
    renderGuardLine('integration-guard', 'ok', `Checked and in use: tenant ${result.cxone.tenant}.`, 'This is now the working connection.');
  } else {
    renderGuardLine('integration-guard', '', cxGood);
  }
  const mail = lastGood.smtp;
  const mailGood = mail ? `Previous working setup: ${mail.host}:${mail.port}${mail.fromAddress ? `, from ${mail.fromAddress}` : ''}${goodSince(mail)}.` : '';
  if (pending.smtp) {
    const failed = result?.smtp && result.smtp.ok === false && !result.smtp.superseded;
    renderGuardLine('smtp-guard', failed ? 'bad' : 'warn',
      failed ? `Not working: ${result.smtp.error}` : 'Saved — not tested yet.',
      mail ? `${mailGood} It comes back when you leave Settings if this still fails.` : 'There is no earlier working mail server to go back to.',
      failed ? result.smtp.help : null);
  } else if (result?.smtp?.ok) {
    renderGuardLine('smtp-guard', 'ok', `Connection test passed: ${result.smtp.host}.`, 'This is now the working mail server.');
  } else {
    renderGuardLine('smtp-guard', '', mailGood);
  }
}

export async function loadConnectionGuard() {
  if (!canAny('settings.view integration.cxone integration.smtp')) return;
  try {
    state.connections = await api('/api/settings/connections');
    renderConnectionGuard(state.connections);
  } catch {}
}

/** Check changed connections; `rollback` puts back the last known good ones that fail. */
async function checkConnections({ rollback }) {
  clearTimeout(autosave.check);
  autosave.check = null;
  if (!canAny('integration.cxone integration.smtp')) return null;
  const result = await api('/api/settings/connections/check', { method: 'POST', body: JSON.stringify({ rollback }) });
  autosave.lastCheck = result;
  state.connections = result.status;
  if (!$('page-settings').hidden) {
    renderConnectionGuard(result.status, result);
    if (result.cxone || result.smtp) {
      await loadSettings();
      renderVerified();
      loadIntegration();
      loadAutomation();
    }
  }
  return result;
}

/** Leaving Settings: save what is pending, then check the connections and roll back what fails. */
export async function leaveSettings() {
  clearTimeout(creditTimer);
  if (!canAny('integration.cxone integration.smtp')) return flushSaves().catch(() => {});
  try {
    await flushSaves();
    const pending = state.connections?.pending;
    if (!autosave.connectionEdited && !pending?.cxone && !pending?.smtp) return;
    toast('Checking the connection settings you changed…');
    const result = await checkConnections({ rollback: true });
    autosave.connectionEdited = false;
    autosave.lastCheck = null;
    if (result?.notice) {
      hideToast();
      showNotices([result.notice]);
    } else if ((result?.cxone && !result.cxone.ok && !result.cxone.superseded) || (result?.smtp && !result.smtp.ok && !result.smtp.superseded)) {
      toast(`Connection settings saved but not working: ${result.cxone?.error ?? result.smtp?.error}. There was no earlier working configuration to go back to.`, 'bad', 12000);
    } else if (result?.cxone?.ok || result?.smtp?.ok) {
      toast('Connection settings checked and in use.', 'ok');
    } else {
      hideToast();
    }
  } catch (error) {
    if (!handleAuthLoss(error)) toast(`Could not check the connection settings: ${error.message}. The server checks them again shortly and rolls back what does not work.`, 'bad', 12000);
  }
}

// ---------------------------------------------------------------------------
// Rollback notices: shown once to each administrator
// ---------------------------------------------------------------------------

const TRIGGERS = {
  'left the Settings page': 'when the Settings page was left',
  'no change for a while': 'after the changes were left unchecked for a while',
  'server start': 'when the server started',
};

function noticeHtml(notice) {
  const when = new Date(notice.at).toLocaleString();
  const how = TRIGGERS[notice.trigger] ?? notice.trigger;
  return notice.parts
    .map((part) => {
      const isCx = part.part === 'cxone';
      const rows = isCx
        ? [['Tenant', part.restored.tenant], ['API URL', part.restored.baseUrl], ['IAM URL', part.restored.iamUrl]]
        : [['Server', `${part.restored.host}:${part.restored.port}${part.restored.secure ? ' (TLS)' : ''}`], ['Username', part.restored.user], ['From', [part.restored.fromName, part.restored.fromAddress && `<${part.restored.fromAddress}>`].filter(Boolean).join(' ')]];
      const tried = isCx
        ? [part.attempted.tenant && `tenant ${part.attempted.tenant}`, part.attempted.baseUrl].filter(Boolean).join(', ') || 'a new API key'
        : `${part.attempted.host || '(no host)'}:${part.attempted.port}`;
      return `<div class="notice-item">
        <h3>${isCx ? 'Checkmarx One connection' : 'Email server (SMTP)'}</h3>
        <p class="why">${part.timedOut ? 'The connection timed out' : 'It did not work'} with the new settings (${escapeHtml(tried)}): ${escapeHtml(part.error)}</p>
        ${helpHtml(part.help, { open: false })}
        <p>Back in use: the previous working setup${part.restoredAt ? `, working since ${escapeHtml(new Date(part.restoredAt).toLocaleString())}` : ''}:</p>
        <div class="kv">${rows.map(([k, v]) => `<div><span class="k">${k}</span><span class="v">${escapeHtml(v || '—')}</span></div>`).join('')}</div>
      </div>`;
    })
    .join('') + `<p class="hint">Rolled back ${escapeHtml(how)}, ${escapeHtml(when)}${notice.actor ? ` · changes by ${escapeHtml(notice.actor)}` : ''}. Recorded in the audit log.</p>`;
}

/** Show rollback notices in a dialog; `acknowledge` marks them seen when it is closed. */
export function showNotices(notices, { acknowledge = false } = {}) {
  if (!notices.length) return;
  const dialog = $('notice-dialog');
  $('notice-title').textContent = notices.length > 1
    ? `New settings did not work: rolled back ${notices.length} times to the last known good configuration`
    : 'New settings did not work: rolled back to the last known good configuration';
  $('notice-body').innerHTML = notices.map(noticeHtml).join('');
  $('notice-settings').hidden = state.page === 'settings';
  dialog.onclose = () => {
    if (acknowledge) api('/api/settings/notices/ack', { method: 'POST', body: JSON.stringify({ ids: notices.map((n) => n.id) }) }).catch(() => {});
    if (state.page === 'settings') renderSettings();
  };
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

// ---------------------------------------------------------------------------
// Quick setup from a .env file
// ---------------------------------------------------------------------------

/** What the .env check found, line by line: what is wrong, how to fix it, and whether it was applied. */
function envFindingsHtml(findings = []) {
  if (!findings.length) return '';
  const item = (f) => `<li class="env-finding ${f.level}">
      <div class="env-finding-head"><code translate="no">${escapeHtml(f.name)}</code>${f.line ? ` <span class="muted">line ${f.line}</span>` : ''}
        <span class="conn-state ${f.level === 'error' ? 'bad' : 'warn'}">${f.level === 'error' ? 'Not applied' : 'Check this'}</span></div>
      <div>${escapeHtml(f.problem)}</div>
      ${f.suggestion ? `<div class="env-suggest"><span>Did you mean:</span> <code translate="no">${escapeHtml(f.suggestion)}</code></div>` : ''}
      <ol class="fix-steps">${f.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
    </li>`;
  const errors = findings.filter((f) => f.level === 'error').length;
  return `<div class="env-findings"><div class="env-findings-title">${errors ? `Mistakes in the file: ${errors}. Those settings were not applied, so the working ones stay.` : 'Worth checking in the file:'}</div><ul>${findings.map(item).join('')}</ul></div>`;
}

async function importEnvFile(file) {
  if (!file) return;
  if (file.size > 64 * 1024) {
    setStatus('env-status', 'That file is larger than 64 KB — not a .env file?', 'error');
    return;
  }
  setStatus('env-status', `Reading ${file.name} and checking the connections in it…`);
  $('env-result').innerHTML = '';
  try {
    await flushSaves();
    const text = await file.text();
    const result = await api('/api/settings/import-env', { method: 'POST', body: JSON.stringify({ text }) });
    state.settings = result.settings;
    renderSettings();
    loadAutomation();
    loadReportServer();
    autosave.lastCheck = result.check;
    state.connections = result.check.status;
    renderConnectionGuard(result.check.status, result.check);
    autosave.connectionEdited = Boolean(result.check.status.pending.cxone || result.check.status.pending.smtp);
    const line = (ok, label, r) => (r ? `<li>${ok ? '✓' : '✗'} ${escapeHtml(label)}: ${escapeHtml(r.ok ? (r.tenant ? `connected to tenant ${r.tenant}` : 'connection test passed') : r.error ?? 'not checked')}${r.ok ? '' : helpHtml(r.help)}</li>` : '');
    const checks = line(result.check.cxone?.ok, 'Checkmarx One', result.check.cxone) + line(result.check.smtp?.ok, 'Mail server', result.check.smtp);
    const failed = (result.check.cxone && !result.check.cxone.ok) || (result.check.smtp && !result.check.smtp.ok);
    $('env-result').innerHTML = `<div class="env-result">
      <div>Applied: ${result.applied.map((n) => `<code>${escapeHtml(n)}</code>`).join(' ')}</div>
      ${checks ? `<ul>${checks}</ul>` : ''}
      ${failed ? '<div class="error-hint">Correct it here, or leave Settings and the last known good settings come back.</div>' : ''}
      ${envFindingsHtml(result.findings)}
      ${result.refused.length ? `<div class="error-hint">Your role cannot set: ${result.refused.map((n) => `<code>${escapeHtml(n)}</code>`).join(' ')}</div>` : ''}
      ${result.ignored.length ? `<div class="muted">Not settings here (only read when the server starts): ${result.ignored.map((n) => `<code>${escapeHtml(n)}</code>`).join(' ')}</div>` : ''}
    </div>`;
    setStatus('env-status', failed ? `Imported ${file.name}, but a connection does not work yet.` : `Imported ${file.name}.`, failed ? 'error' : 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) {
      showError('env-status', error);
      $('env-result').innerHTML = envFindingsHtml(error.body?.findings);
    }
  } finally {
    $('env-file').value = '';
  }
}

export function wireSettings() {
  $('page-settings').addEventListener('input', onSettingsEdit);
  $('page-settings').addEventListener('change', (event) => {
    // Text fields already saved on input; checkboxes, selects and colour pickers save on change.
    if (event.target.matches('input[type="checkbox"], input[type="radio"], select, input[type="color"], input[type="number"]')) onSettingsEdit(event);
  });

  // Closing the tab on Settings: the server still checks (the result shows at the next sign-in).
  window.addEventListener('pagehide', () => {
    if (state.page !== 'settings' || !canAny('integration.cxone integration.smtp')) return;
    if (!autosave.connectionEdited && !state.connections?.pending?.cxone && !state.connections?.pending?.smtp) return;
    navigator.sendBeacon?.('/api/settings/connections/check', new Blob([JSON.stringify({ rollback: true, present: false })], { type: 'application/json' }));
  });
  $('notice-settings').addEventListener('click', () => $('notice-dialog').close());

  $('env-file').addEventListener('change', () => importEnvFile($('env-file').files[0]));
  for (const type of ['dragenter', 'dragover']) {
    $('env-drop').addEventListener(type, (event) => {
      event.preventDefault();
      $('env-drop').classList.add('over');
    });
  }
  for (const type of ['dragleave', 'drop']) $('env-drop').addEventListener(type, () => $('env-drop').classList.remove('over'));
  $('env-drop').addEventListener('drop', (event) => {
    event.preventDefault();
    importEnvFile(event.dataTransfer?.files?.[0]);
  });
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
    // The Automation panel says whether runs can send: it follows the test.
    loadAutomation();
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
      scheduleSave();
      setStatus('save-status', 'Found a working path and saved it.', 'ok');
    } else {
      setStatus('save-status', 'No candidate answered; see the table.', 'error');
    }
  } catch (error) {
    if (!handleAuthLoss(error)) showError('save-status', error);
  } finally {
    button.disabled = false;
  }
}
// The look of the app for everyone: shown here at once (it is saved with the rest of Settings).
const brandLook = () => document.querySelector('input[name="brand-look"]:checked')?.value ?? 'nextgen';

export function wireSettingsChecks() {
  $('save-recipients').addEventListener('click', saveInlineRecipients);
  for (const id of ['brand-name', 'brand-logo', 'brand-height', 'brand-accent']) {
    $(id).addEventListener('input', renderBrandPreview);
  }
  for (const el of [$('brand-looks'), $('brand-look-choice'), $('brand-nav')]) {
    el.addEventListener('change', () => applyOrgLook({ look: brandLook(), lookChoice: $('brand-look-choice').checked, navPosition: $('brand-nav').value }));
  }
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
    scheduleSave();
    setStatus('template-status', 'Default restored and saved.', 'ok');
  });
}
