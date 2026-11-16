// The page's entry point. Each page or concern is a module under app/. This file loads them and runs what each does
// when the page loads (its wire…() functions: listeners, the first drawing of the menu and the columns), in the order
// that code has always run in, and starts the page: the server's health, the session, the first route.

// The files that were here before app/, first and in the order they have always been imported in: they load in that order.
import './speedsters.js';
import './calculator/page.js';
import './fae-flush.js';
// Labs → Status board and Consolidated view (beta), and the tenant switcher they share.
import './status-board.js';
import './consolidated.js';
import './govern.js';
import './tenant-menu.js';
import './mobile.js';
import './nav-map.js';
import './qr.js';
import { SEVERITIES_ALL, creditTiers, tierName } from './credit-tiers.js';
import { ENGINES, cleanEngines, DEFAULT_ENGINES, describeEngines } from './engines.js';
import { t } from './i18n.js';
import { helpMode, setHelpMode, startHelpTips } from './help-tips.js';
import { sortAndFilter, startTableTools, tableFiltered } from './table-tools.js';
import { shownColumns as columnsShownOf, columnMenu } from './column-prefs.js';
import { fusionTotalOf, SCAN_TYPE_LABEL, shownEngines, filtering, MODEL_FROM, engineLabel, fusionRows, fusionTiles, PERIOD_LABEL, FUSION_STATES, FUSION_STATUSES, STATE_LABEL, countsFor, wordsLabel, fusionReportHtml, fusionResultRows, ENGINE_LABEL, fileOf, scannerLabel } from './fusion-view.js';

// The page's own modules.
import { $, can, canAny, state } from './app/state.js';
import { escapeHtml, fmt, fmtDateTime, formatDate, formatTime } from './app/format.js';
import { api, flare, handleAuthLoss, helpTip, logger, setStatus, showError, showHelp, toast, wireCore, wireLogs } from './app/core.js';
import { STAGE_LABELS, activateTab, applyPermissions, renderFeatureStages, tabMemory, wireAdvancedAndFeatures, wireLayout, wireMenuAndTabs, wirePagesAndPalette } from './app/nav.js';
import { applyAppBranding, languagesChanged, moneyOf, openProfileOf, wireAppBranding, wireLanguageAndProfile, wireMyBranding, wireThemeAndLook } from './app/profile.js';
import { afterSignIn, copyButton, resetLinkToken, showReset, showSignIn, showSsoRefusal, ssoRefusalCode, wireConnections, wireSignIn, wireTerms } from './app/session.js';
import { wireSettings, wireSettingsChecks, wireSupportNote } from './app/settings.js';
import { wireAboutAndUpdates, wireActivationAndTenants, wireHttps, wireServerConnections } from './app/system.js';

wireCore();

/** "10 Checkmarx One results (12 findings — rows sharing a result count once)": why the rows and the credits differ. */
function resultsText(results, rows) {
  const r = `${results} Checkmarx One result${results === 1 ? '' : 's'}`;
  return rows > results ? `${r} (${rows} findings — rows that share one result are triaged, and charged, once)` : r;
}
/** How long a "confirmed twice with Checkmarx One" count stays good for. */
const VERIFY_TTL_MS = 10 * 60 * 1000;
const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

wireAdvancedAndFeatures();

// ---- Settings → Hands-off: set it up once (four questions), then steer it by email ----

const handsOff = { data: null };

export async function loadHandsOff() {
  if (!canAny('settings.automation settings.view')) return;
  try {
    renderHandsOff(await api('/api/hands-off', { quiet: true }));
  } catch (error) {
    if (!handleAuthLoss(error)) showError('ho-status-line', error);
  }
}

function renderHandsOff(d) {
  handsOff.data = d;
  const h = d.handsOff;
  const a = d.automation;
  if (!$('ho-hour').options.length) $('ho-hour').innerHTML = Array.from({ length: 24 }, (_, i) => `<option value="${i}">${String(i).padStart(2, '0')}:00</option>`).join('');
  $('ho-ready').innerHTML = [
    [d.ready.cxone, 'Checkmarx One connected', 'Connect Checkmarx One first (Settings → Checkmarx One).'],
    [d.ready.smtp, 'Email server tested', 'Set up and test the email server first (Settings → Email server).'],
    [d.ready.serverUrl, 'Server address set: the email buttons work', 'Set the server address (Settings → Server address) so the email buttons work.'],
  ].map(([ok, yes, no]) => `<span class="ho-check ${ok ? 'ok' : 'warn'}">${ok ? '✓' : '!'} <span>${escapeHtml(ok ? yes : no)}</span></span>`).join('') + (d.paused ? `<span class="ho-check warn">⏸ <span>Paused until</span> <b>${escapeHtml(fmtDateTime(h.pausedUntil))}</b></span>` : '');
  // The form shows what is saved, unless it is being edited.
  if (!handsOff.editing) {
    $('ho-remind').checked = a.enabled;
    $('ho-status').checked = h.statusTo.length > 0;
    $('ho-monthly').checked = (d.monthlyTo ?? []).length > 0;
    for (const box of $('ho-sev').querySelectorAll('input')) box.checked = !a.severities.length || a.severities.includes(box.value);
    $('ho-thresholds').value = a.thresholds.join(', ');
    $('ho-audience').value = d.audience;
    $('ho-status-to').value = h.statusTo.join('\n');
    $('ho-monthly-to').value = (d.monthlyTo ?? []).join('\n');
    $('ho-every').value = ['360', '1440', '10080'].includes(String(a.intervalMinutes)) ? String(a.intervalMinutes) : '1440';
    $('ho-day').value = String(h.statusDay);
    $('ho-hour').value = String(h.statusHour);
    $('ho-replies').checked = h.replies;
    $('ho-imap-host').value = h.imapHost;
    $('ho-imap-port').value = String(h.imapPort);
  }
  $('ho-imap-host').placeholder = state.settings?.smtp?.host || 'imap.company.com';
  renderHandsOffToggles();
  $('ho-save').textContent = h.on ? 'Save' : 'Turn on hands-off';
  $('ho-off').hidden = !h.on;
  renderHealth(d.health);
}

function renderHandsOffToggles() {
  $('ho-imap').hidden = !$('ho-replies').checked;
  $('ho-imap-hint').hidden = !$('ho-replies').checked;
  $('ho-status-to').closest('.field').classList.toggle('muted-field', !$('ho-status').checked);
  $('ho-monthly-to').closest('.field').classList.toggle('muted-field', !$('ho-monthly').checked);
}

function renderHealth(health) {
  if (!health) return;
  const open = health.problems ?? [];
  $('ho-health-sum').innerHTML = open.length
    ? open.map((p) => `<span class="ho-check warn">! <span translate="no">${escapeHtml(p.title)}</span>: <span translate="no">${escapeHtml(p.detail)}</span></span>`).join('')
    : `<span class="ho-check ok">✓ <span>All checks pass.</span></span> ${health.lastCheckAt ? `<span>Last check:</span> <b>${escapeHtml(fmtDateTime(health.lastCheckAt))}</b>` : ''}`;
  $('ho-events').innerHTML = (health.events ?? []).slice(0, 8).map((e) => `<li><time>${escapeHtml(fmtDateTime(e.at))}</time> <span translate="no">${escapeHtml(e.message)}</span></li>`).join('');
}

function handsOffPayload(on = true) {
  const severities = [...$('ho-sev').querySelectorAll('input:checked')].map((b) => b.value);
  return {
    handsOff: {
      on,
      statusTo: $('ho-status').checked ? $('ho-status-to').value : '',
      statusDay: Number($('ho-day').value),
      statusHour: Number($('ho-hour').value),
      replies: $('ho-replies').checked,
      imapHost: $('ho-imap-host').value.trim(),
      imapPort: Number($('ho-imap-port').value) || 993,
    },
    automation: { enabled: on && $('ho-remind').checked, thresholds: $('ho-thresholds').value, severities: severities.length === 4 ? [] : severities, intervalMinutes: Number($('ho-every').value) },
    audience: $('ho-audience').value,
    ...(can('settings.ai') ? { monthlyTo: $('ho-monthly').checked ? $('ho-monthly-to').value : '' } : {}),
  };
}

async function saveHandsOff(on = true) {
  if (on && $('ho-status').checked && !$('ho-status-to').value.trim()) return setStatus('ho-status-line', 'Add who gets the weekly status, or untick it.', 'error');
  if (on && !$('ho-sev').querySelector('input:checked')) return setStatus('ho-status-line', 'Tick at least one severity.', 'error');
  setStatus('ho-status-line', 'Saving…');
  try {
    await api('/api/hands-off', { method: 'PUT', body: JSON.stringify(handsOffPayload(on)), quiet: true });
    handsOff.editing = false;
    await loadHandsOff();
    loadAutomation();
    setStatus('ho-status-line', on ? 'Hands-off is on. MissionZero now runs on its own.' : 'Hands-off is off.', 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('ho-status-line', error);
  }
}

$('set-handsoff').addEventListener('input', () => {
  handsOff.editing = true;
  renderHandsOffToggles();
});
$('set-handsoff').addEventListener('change', () => {
  handsOff.editing = true;
  renderHandsOffToggles();
});
$('ho-save').addEventListener('click', () => saveHandsOff(true));
$('ho-off').addEventListener('click', () => {
  if (confirm('Turn off hands-off? Automatic reminders and the weekly status stop. The self-check keeps running.')) saveHandsOff(false);
});
$('ho-send').addEventListener('click', async () => {
  setStatus('ho-status-line', 'Sending…');
  try {
    const r = await api('/api/hands-off/status', { method: 'POST', quiet: true });
    setStatus('ho-status-line', r.sent === 1 ? 'The status went to 1 person.' : `The status went to ${r.sent} people.`, 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('ho-status-line', error);
  }
});
$('ho-check').addEventListener('click', async () => {
  $('ho-check').disabled = true;
  try {
    renderHealth((await api('/api/hands-off/check', { method: 'POST', quiet: true })).health);
  } catch (error) {
    if (!handleAuthLoss(error)) showError('ho-status-line', error);
  } finally {
    $('ho-check').disabled = false;
  }
});

wireMyBranding();
wireActivationAndTenants();
wireMenuAndTabs();
wireThemeAndLook();
wireConnections();

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

export async function loadAutomation() {
  try {
    state.automation = await api('/api/automation');
    renderAutomation();
    renderAutomationElsewhere();
    if (state.page === 'automation' && tabMemory.automation === 'email' && can('settings.automation')) renderEmailPreview();
  } catch (error) {
    if (!handleAuthLoss(error)) console.warn(error.message);
  }
}

/** A run's SLA issues, in a few words: opened, would be opened, skipped and why. */
function slaIssuesText(issues) {
  if (!issues) return '';
  if (issues.error) return ` · repository issues failed: ${issues.error}`;
  const skipped = issues.skipped?.length ? `, ${issues.skipped.length} project${issues.skipped.length === 1 ? '' : 's'} skipped (${[...new Set(issues.skipped.map((s) => s.reason))].slice(0, 2).join('; ')})` : '';
  if (!issues.opened && !skipped) return '';
  return ` · ${issues.opened} repository issue${issues.opened === 1 ? '' : 's'} ${issues.dryRun ? 'would be opened' : 'opened'} (${issues.findings} finding${issues.findings === 1 ? '' : 's'})${skipped}`;
}

/** A moment as people read it: "Mon 20 Oct, 09:00". */
const whenText = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
/** The same, kept out of translation: the words around it are translated on their own. */
const whenHtml = (iso) => `<span translate="no">${escapeHtml(whenText(iso))}</span>`;

/**
 * Act → Automation → Follow-ups & escalation lists everything automatic, wherever it is set: each
 * tracked report's follow-up and rescan, and SLA escalation.
 */
async function renderAutomationElsewhere() {
  const box = $('auto-elsewhere');
  const rows = [];
  const row = (what, where, when, last, open) => `<tr><td>${what}</td><td>${where}</td><td>${when}</td><td>${last || '—'}</td><td class="num">${open}</td></tr>`;
  if (can('feature.sla')) {
    const sla = state.settings?.sla;
    const slaWays = [sla?.escalate && sla.escalateTo?.length ? `email to ${escapeHtml(sla.escalateTo.join(', '))}` : '', sla?.openIssues ? 'an issue in each repository' : ''].filter(Boolean);
    if (slaWays.length) {
      const run = state.automation?.runs?.find((r) => r.escalation?.escalated);
      const last = run ? `${whenHtml(run.at)} <span>· ${run.escalation.escalated} escalated</span>` : '';
      rows.push(row(`SLA escalation: ${slaWays.join(', ')} <span class="badge warn" data-beta-badge="sla">Beta</span>`, 'Settings → SLAs', 'With each reminder run', last, '<a href="#/settings/sla">Open</a>'));
    }
  }
  if (can('reports.view')) {
    try {
      const { reports } = await api('/api/tracked-reports', { quiet: true });
      for (const r of reports) {
        const a = r.automation ?? {};
        const open = `<a href="#/reports" data-open-report="${escapeHtml(r.id)}" data-tab="remind">Open</a>`;
        if (a.enabled) {
          const sent = (r.reminders ?? []).find((m) => m.automatic);
          rows.push(row(`Follow-up: “${escapeHtml(r.name)}” tracked report`, 'Dashboard', escapeHtml(scheduleText(a)), sent ? `${whenHtml(sent.at)} <span>· ${sent.sent} email${sent.sent === 1 ? '' : 's'}</span>` : '', open));
        }
        if (r.verify?.auto) {
          const asked = r.verification?.requestedAt;
          rows.push(row(`Verification rescan: “${escapeHtml(r.name)}”`, 'Dashboard', 'After the developers’ turn', asked ? whenHtml(asked) : '', open));
        }
      }
    } catch {
      /* the list still shows what it can */
    }
  }
  $('auto-followup-count').textContent = rows.length ? String(rows.length) : '';
  box.innerHTML = rows.length
    ? `<div class="table-wrap"><table class="data-table auto-follow-table" data-tt-off><thead><tr><th>What</th><th>Set on</th><th>When</th><th>Last run</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : '<p class="hint">Nothing else. Tracked reports can follow up by themselves (Dashboard → a report → Remind), and SLAs can escalate (Settings → SLAs).</p>';
  renderFeatureStages();
}

const LIMIT_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const SEVERITY_LABEL = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };
const WEEK = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];

/** The badge on Reminders: on and when next, test mode, or off. */
function automationState(a) {
  if (!a.config.enabled) return { html: '<span>Off</span>', tone: '' };
  const next = a.nextRunAt ? ` <span>· next run</span> ${whenHtml(a.nextRunAt)}` : '';
  return { html: `<span>${a.config.dryRun ? 'On in test mode' : 'On'}</span>${next}`, tone: 'on' };
}

function renderAutomation() {
  const a = state.automation;
  if (!a) return;
  const c = a.config;

  // Reminders
  $('auto-enabled').checked = c.enabled;
  $('auto-dry').checked = c.dryRun;
  $('auto-authors').checked = c.notifyCodeAuthors === true;
  $('auto-turnon').hidden = true;
  for (const radio of document.querySelectorAll('input[name="autoPer"]')) radio.checked = radio.value === (c.perSeverity ? 'each' : 'same');
  $('auto-thresholds').value = (c.thresholds ?? []).join(', ');
  const on = new Set(c.severities?.length ? c.severities : LIMIT_SEVERITIES);
  const past = a.lastPreview?.bySeverity ?? null;
  $('auto-limits').innerHTML = LIMIT_SEVERITIES.map((sev) => {
    const days = (c.severityLimits?.[sev] ?? []).join(', ');
    const count = past ? (past[sev] ? String(past[sev]) : '—') : '—';
    return `<tr><td><span class="sev-dot sev-${sev.toLowerCase()}" aria-hidden="true"></span> ${SEVERITY_LABEL[sev]}</td>
      <td class="auto-days-col"><input data-limit="${sev}" value="${escapeHtml(days)}" placeholder="none" spellcheck="false" aria-label="${SEVERITY_LABEL[sev]}: remind after (days)" /></td>
      <td><label class="check"><input type="checkbox" data-sev-on="${sev}" ${on.has(sev) ? 'checked' : ''} /> On</label></td>
      <td class="num">${count}</td></tr>`;
  }).join('');
  renderLimitMode();
  $('auto-limits-note').innerHTML = past ? `<span>Counts from the last preview:</span> ${whenHtml(a.lastPreview.at)}` : 'Preview to see how many findings are past a limit now.';
  $('auto-mode').value = c.mode;
  renderAudience();
  const badge = automationState(a);
  $('auto-status').innerHTML = badge.html;
  $('auto-status').className = `auto-state ${badge.tone}`;

  // Runs use the server's Checkmarx One integration and its mail server: say,
  // from their current state, what an unattended run can do.
  const credential = $('auto-credential');
  const integration = a.integration ?? {};
  const tenant = integration.connection?.tenant;
  const lines = [];
  let ready = true;
  if (integration.connected) {
    const source = integration.source === 'environment' ? 'CX_API_KEY on the server' : 'the key stored under Settings → Checkmarx One';
    lines.push(`✓ Checkmarx One: connected${tenant ? ` to tenant ${tenant}` : ''}, using ${source}.`);
  } else {
    ready = false;
    lines.push('✗ Checkmarx One: not connected. Connect the server under Settings → Checkmarx One: unattended runs use that connection.');
  }
  if (integration.pending) lines.push('… A changed integration key is saved but not in use yet: runs keep using the previous working connection until it works.');
  if (a.smtpVerified) {
    lines.push('✓ Mail server: connection test passed. Automation can send.');
  } else if (a.connections?.lastGood?.smtp) {
    lines.push('… Mail server: changed settings are not tested yet. They are checked when you leave Settings; the previous working ones come back if they fail.');
  } else {
    ready = false;
    lines.push(a.smtpConfigured
      ? '✗ Mail server: no successful connection test yet, so automation cannot send. Use "Test connection" under Settings → Email server.'
      : '✗ Mail server: not set up yet, so automation cannot send. Fill in Settings → Email server.');
  }
  credential.className = `detected ${ready ? 'ok' : 'warn'}`;
  credential.innerHTML = lines.map((line) => `<div>${escapeHtml(line)}</div>`).join('');

  // Focus
  const focus = c.focus ?? {};
  $('auto-apps').value = (focus.applications ?? []).join(', ');
  $('auto-tags').value = (focus.tags ?? []).join(', ');
  $('auto-projects').value = (focus.projects ?? []).join(', ');
  $('auto-exclude').value = (focus.exclude ?? []).join(', ');
  // A schedule saved before branches could be chosen reads every branch and leaves nothing out.
  $('auto-all-branches').checked = c.branches === 'all';
  $('auto-no-code').checked = c.leaveOutNoCode !== false;
  // Every engine when none is saved (a schedule from before engines could be chosen).
  const engines = new Set(cleanEngines(c.engines).length ? cleanEngines(c.engines) : ENGINES.map((e) => e.key));
  $('auto-engines').replaceChildren(
    ...ENGINES.map((engine) => {
      const label = document.createElement('label');
      label.className = 'check';
      const input = Object.assign(document.createElement('input'), { type: 'checkbox', id: `auto-engine-${engine.key}`, value: engine.key, checked: engines.has(engine.key) });
      input.dataset.autoEngine = engine.key;
      // At least one engine: a schedule with none would remind nobody of anything.
      input.addEventListener('change', () => {
        if (!$('auto-engines').querySelector('input:checked')) input.checked = true;
      });
      const name = document.createElement('span');
      name.setAttribute('translate', 'no');
      name.textContent = engine.label;
      label.append(input, ' ', name);
      if (!engine.ai) {
        const tag = document.createElement('small');
        tag.className = 'muted';
        tag.textContent = 'No AI';
        label.append(' ', tag);
      }
      return label;
    }),
  );
  const preview = a.lastPreview;
  $('auto-focus-state').textContent = preview ? `${preview.inFocus} of ${preview.total} projects · ${preview.open} open findings` : '';
  $('auto-focus-state').className = `auto-state ${preview ? 'on' : ''}`;

  // Schedule
  for (const radio of document.querySelectorAll('input[name="autoWhen"]')) radio.checked = radio.value === (c.when ?? 'interval');
  const days = new Set(c.days ?? []);
  $('auto-days').innerHTML = WEEK.map(([d, name]) => `<label class="day-chip"><input type="checkbox" data-day="${d}" ${days.has(d) ? 'checked' : ''} /> <span>${name}</span></label>`).join('');
  $('auto-at').value = c.at ?? '09:00';
  $('auto-tz').value = c.timeZone ?? '';
  // Blank is the server's own zone, shown as the hint.
  $('auto-tz').placeholder = a.serverTimeZone;
  if (!$('auto-tz-list').childElementCount && typeof Intl.supportedValuesOf === 'function') {
    $('auto-tz-list').innerHTML = Intl.supportedValuesOf('timeZone').map((z) => `<option value="${escapeHtml(z)}"></option>`).join('');
  }
  $('auto-interval').value = c.intervalMinutes;
  renderWhenMode();
  renderNextRun();

  renderReminderEmail();
  renderRuns();
  // The last preview stays in view after a reload (the server keeps it until it restarts).
  if (preview && !$('ap-body').querySelector('[data-see-mail], .auto-missing')) renderAutoPreview(preview);
}

/** Same for every severity: one list of days; each its own: a column of days per severity. */
function renderLimitMode() {
  const each = document.querySelector('input[name="autoPer"]:checked')?.value === 'each';
  $('auto-same-row').hidden = each;
  document.querySelector('.auto-limits').classList.toggle('same', !each);
}

function renderWhenMode() {
  const schedule = document.querySelector('input[name="autoWhen"]:checked')?.value === 'schedule';
  for (const el of document.querySelectorAll('#auto-days input, #auto-at, #auto-tz')) el.disabled = !schedule;
  $('auto-interval').disabled = schedule;
  $('auto-schedule').classList.toggle('by-interval', !schedule);
}

function renderNextRun() {
  const a = state.automation;
  const zone = a.config.timeZone || a.serverTimeZone;
  const at = a.config.enabled ? a.nextRunAt : a.wouldRunAt;
  // A schedule's time as it is set, in its own zone; an interval's in this browser's.
  const shown = at && new Date(at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(a.config.when === 'schedule' ? { timeZone: zone } : {}) });
  $('auto-next').innerHTML = at
    ? `<span>${a.config.enabled ? 'Next:' : 'Off · would go out:'}</span> <span translate="no">${escapeHtml(`${shown}${a.config.when === 'schedule' ? ` ${zone}` : ''}`)}</span>`
    : '<span>No day chosen</span>';
  $('auto-next').className = `auto-state ${a.config.enabled ? 'on' : ''}`;
}

/** History: each run, how it started, what it found and sent. */
function renderRuns() {
  const runs = state.automation?.runs ?? [];
  const outcome = (run) => {
    if (run.error) return ['Failed', 'bad'];
    if (run.skipped) return ['Skipped', 'warn'];
    if (!run.crossed) return ['Nothing new', ''];
    if (run.dryRun) return ['Logged only', ''];
    return run.ok ? ['Sent', 'ok'] : ['Partly sent', 'warn'];
  };
  $('auto-runs').innerHTML = runs.length
    ? `<div class="table-wrap"><table class="data-table auto-runs-table">
        <thead><tr><th>When</th><th>How</th><th class="num">Findings</th><th class="num">Emails</th><th>Outcome</th></tr></thead>
        <tbody>${runs
          .map((run) => {
            const [label, tone] = outcome(run);
            const how = `${run.how === 'now' ? 'Run once now' : run.how === 'scheduled' ? 'Scheduled' : 'Run'}${run.dryRun ? ' · test mode' : ''}`;
            const detail =
              (run.error || run.reason || (run.failures?.length ? `${run.failures.length} failed: ${run.failures.slice(0, 2).map((f) => `${f.to} (${f.error})`).join('; ')}` : '')) +
              (run.codeAuthors?.emailed ? ` · ${run.codeAuthors.emailed} code author${run.codeAuthors.emailed === 1 ? '' : 's'} ${run.dryRun ? 'would be ' : ''}emailed` : run.codeAuthors?.error ? ` · code authors: ${run.codeAuthors.error}` : '') +
              (run.escalation?.escalated ? ` · ${run.escalation.escalated} past SLA ${run.escalation.sent ? 'escalated' : run.escalation.dryRun ? 'would be escalated' : `not escalated: ${run.escalation.error ?? ''}`}` : '') +
              slaIssuesText(run.escalation?.issues);
            return `<tr><td>${whenHtml(run.at)}</td><td>${escapeHtml(how)}</td><td class="num">${run.crossed ?? '—'}</td><td class="num">${run.dryRun ? 0 : run.sent ?? 0}</td>
              <td><span class="auto-pill ${tone}">${escapeHtml(label)}</span>${detail ? `<small class="auto-detail">${escapeHtml(detail.replace(/^ · /, ''))}</small>` : ''}</td></tr>`;
          })
          .join('')}</tbody></table></div>`
    : '<p class="hint">No runs yet.</p>';
}

const listOf = (value) => String(value ?? '').split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);

function remindersPayload() {
  const on = [...document.querySelectorAll('[data-sev-on]:checked')].map((box) => box.dataset.sevOn);
  return {
    dryRun: $('auto-dry').checked,
    // Only offered once "Code authors" is final; otherwise left as it is.
    ...(state.me?.features?.codeAuthors === 'final' ? { notifyCodeAuthors: $('auto-authors').checked } : {}),
    perSeverity: document.querySelector('input[name="autoPer"]:checked')?.value === 'each',
    thresholds: $('auto-thresholds').value,
    severityLimits: Object.fromEntries([...document.querySelectorAll('[data-limit]')].map((input) => [input.dataset.limit, input.value])),
    // Every severity ticked: every severity (as before there was a choice).
    severities: on.length === LIMIT_SEVERITIES.length ? [] : on,
    mode: $('auto-mode').value,
  };
}

const focusPayload = () => ({
  focus: { applications: listOf($('auto-apps').value), tags: listOf($('auto-tags').value), projects: listOf($('auto-projects').value), exclude: listOf($('auto-exclude').value) },
  engines: [...document.querySelectorAll('[data-auto-engine]:checked')].map((box) => box.dataset.autoEngine),
  branches: $('auto-all-branches').checked ? 'all' : 'primary',
  leaveOutNoCode: $('auto-no-code').checked,
});

const schedulePayload = () => ({
  when: document.querySelector('input[name="autoWhen"]:checked')?.value ?? 'schedule',
  days: [...document.querySelectorAll('#auto-days [data-day]:checked')].map((box) => Number(box.dataset.day)),
  at: $('auto-at').value || '09:00',
  timeZone: $('auto-tz').value.trim(),
  intervalMinutes: $('auto-interval').value,
});

/** Save part of the automation; the badge and next run follow, the forms stay as typed. */
async function saveAutomation(payload, statusId) {
  setStatus(statusId, 'Saving…');
  try {
    const status = await api('/api/automation', { method: 'PUT', body: JSON.stringify(payload) });
    state.automation = { ...state.automation, ...status };
    const badge = automationState(state.automation);
    $('auto-status').innerHTML = badge.html;
    $('auto-status').className = `auto-state ${badge.tone}`;
    renderNextRun();
    setStatus(statusId, 'Saved.', 'ok');
    return status;
  } catch (error) {
    if (!handleAuthLoss(error)) showError(statusId, error);
    throw error;
  }
}

/**
 * Reminders → Save. Turning "Run automatically" on shows the preview first: who would get what now,
 * and a button to turn it on with that in view.
 */
async function saveReminders() {
  const wantOn = $('auto-enabled').checked;
  const wasOn = state.automation.config.enabled;
  try {
    await saveAutomation({ ...remindersPayload(), ...(wantOn && !wasOn ? {} : { enabled: wantOn }) }, 'auto-message');
  } catch {
    return;
  }
  if (wantOn && !wasOn) {
    setStatus('auto-message', 'Saved. Before it runs by itself, see who would get what: Preview.', 'ok');
    activateTab('automation', 'preview');
    runAutomationPreview({ turnOn: true });
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
        `${run.scanned} open finding(s) looked at, ${run.crossed} newly past a limit, ${run.sent} email(s) ${run.dryRun ? 'would have been sent (test mode)' : 'sent'}.`,
      run.ok ? 'ok' : 'error',
    );
  } catch (error) {
    if (!handleAuthLoss(error)) showError('auto-message', error);
  } finally {
    button.disabled = false;
  }
}

/** Focus: how many projects the names typed cover, asked of the server a moment after typing stops. */
let focusTimer = null;
export function checkFocus() {
  clearTimeout(focusTimer);
  focusTimer = setTimeout(async () => {
    try {
      const r = await api('/api/automation/focus/match', { method: 'POST', body: JSON.stringify(focusPayload().focus), quiet: true });
      const names = r.matched && r.matched < r.total ? ` <span translate="no">${escapeHtml(r.names.join(', '))}${r.matched > r.names.length ? ', …' : ''}</span>` : '';
      const unknown = r.unknownApplications?.length ? ` <span>No application has this name:</span> <span translate="no">${escapeHtml(r.unknownApplications.join(', '))}</span>` : '';
      $('auto-focus-match').innerHTML = `<span>Matches ${r.matched} of ${r.total} projects.</span>${names}${unknown}`;
      if (!$('auto-app-list').childElementCount) $('auto-app-list').innerHTML = r.applications.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('');
    } catch (error) {
      $('auto-focus-match').textContent = error.message;
    }
  }, 500);
}

// ---- Email -----------------------------------------------------------------

/** The email's fields as typed; a field ticked "Same as the portal" is sent empty. */
function reminderEmailPayload() {
  const portal = (box, input) => ($(box).checked ? '' : $(input).value.trim());
  return {
    style: $('ae-html').checked ? 'html' : 'simple',
    senderName: portal('ae-sender-portal', 'ae-sender'),
    replyTo: portal('ae-replyto-portal', 'ae-replyto'),
    logo: document.querySelector('input[name="aeLogo"]:checked')?.value ?? 'portal',
    logoUrl: $('ae-logo-url').value.trim(),
    color: $('ae-color-portal').checked ? '' : $('ae-color').value,
    headerText: $('ae-header').value,
    footer: portal('ae-footer-portal', 'ae-footer'),
    subject: $('ae-subject').value,
    greeting: $('ae-greeting').value,
    opening: $('ae-opening').value,
    button: $('ae-button').value,
    signOff: $('ae-signoff').value,
    listProjects: $('ae-list').checked,
    attachReport: $('ae-attach').checked,
  };
}

function renderReminderEmail() {
  const a = state.automation;
  const e = a.reminderEmail ?? {};
  const p = a.portal ?? {};
  const pair = (box, input, own, portalValue) => {
    $(box).checked = !own;
    $(input).value = own || portalValue || '';
    $(input).disabled = !own;
  };
  pair('ae-sender-portal', 'ae-sender', e.senderName, p.senderName);
  pair('ae-replyto-portal', 'ae-replyto', e.replyTo, p.fromAddress);
  pair('ae-footer-portal', 'ae-footer', e.footer, p.footer);
  for (const radio of document.querySelectorAll('input[name="aeLogo"]')) radio.checked = radio.value === (e.logo ?? 'portal');
  $('ae-logo-url').value = e.logoUrl ?? '';
  $('ae-logo-url').hidden = e.logo !== 'custom';
  $('ae-color-portal').checked = !e.color;
  $('ae-color-portal-name').textContent = p.colours?.name ? `· ${p.colours.name === 'brand colour' ? p.colours.head : p.colours.name}` : '';
  $('ae-color').value = e.color || p.colours?.head || '#1d4ed8';
  $('ae-color').hidden = !e.color;
  $('ae-header').value = e.headerText ?? '';
  $('ae-subject').value = e.subject ?? '';
  $('ae-greeting').value = e.greeting ?? '';
  $('ae-opening').value = e.opening ?? '';
  $('ae-button').value = e.button ?? '';
  $('ae-signoff').value = e.signOff ?? '';
  $('ae-list').checked = e.listProjects !== false;
  $('ae-attach').checked = e.attachReport === true;
  $('ae-html').checked = e.style === 'html';
  $('ae-advanced').open = e.style === 'html';
  $('ae-chips').innerHTML = (a.placeholders ?? []).map((name) => `<button type="button" class="ae-chip" data-insert="{{${name}}}" translate="no">{{${name}}}</button>`).join('');
  renderEmailStyle();
}

/** With the HTML template chosen, this email's fields do not apply: they are dimmed. */
function renderEmailStyle() {
  $('auto-email').classList.toggle('html-style', $('ae-html').checked);
}

let emailPreviewTimer = null;
export function renderEmailPreview() {
  clearTimeout(emailPreviewTimer);
  emailPreviewTimer = setTimeout(async () => {
    try {
      const r = await api('/api/automation/email/preview', { method: 'POST', body: JSON.stringify(reminderEmailPayload()), quiet: true });
      $('ae-frame').srcdoc = r.html;
      $('ae-preview-as').innerHTML = `<span>${r.sample ? '· a sample for' : '· as sent to'}</span> <span translate="no">${escapeHtml(r.as)}</span>`;
    } catch (error) {
      $('ae-preview-as').textContent = `· ${error.message}`;
    }
  }, 350);
}

let emailField = 'ae-subject';
$('auto-email').addEventListener('focusin', (event) => {
  if (event.target.matches('[data-ae-text]')) emailField = event.target.id;
});
$('auto-email').addEventListener('input', (event) => {
  if (event.target.id === 'ae-color') return renderEmailPreview();
  renderEmailPreview();
});
$('auto-email').addEventListener('change', (event) => {
  const box = event.target.closest('[data-ae-portal]');
  if (box) {
    const input = $(box.dataset.aePortal);
    const p = state.automation.portal ?? {};
    input.disabled = box.checked;
    if (box.checked) input.value = { 'ae-sender': p.senderName, 'ae-replyto': p.fromAddress, 'ae-footer': p.footer }[input.id] ?? '';
    else input.focus();
  }
  if (event.target.name === 'aeLogo') $('ae-logo-url').hidden = event.target.value !== 'custom';
  if (event.target.id === 'ae-color-portal') $('ae-color').hidden = event.target.checked;
  if (event.target.id === 'ae-html') renderEmailStyle();
  renderEmailPreview();
});
$('auto-email').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-insert]');
  if (!chip) return;
  const field = $(emailField);
  const at = field.selectionStart ?? field.value.length;
  field.value = `${field.value.slice(0, at)}${chip.dataset.insert}${field.value.slice(field.selectionEnd ?? at)}`;
  field.focus();
  field.selectionStart = field.selectionEnd = at + chip.dataset.insert.length;
  renderEmailPreview();
});
$('auto-save-email').addEventListener('click', async () => {
  setStatus('ae-message', 'Saving…');
  try {
    const { reminderEmail } = await api('/api/automation/email', { method: 'PUT', body: JSON.stringify(reminderEmailPayload()) });
    state.automation.reminderEmail = reminderEmail;
    setStatus('ae-message', 'Saved.', 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('ae-message', error);
  }
});
$('ae-restore').addEventListener('click', async () => {
  if (!confirm('Put the reminder email back as it was first: the portal’s branding and the default words?')) return;
  try {
    const { reminderEmail } = await api('/api/automation/email', { method: 'PUT', body: JSON.stringify({ restore: true }) });
    state.automation.reminderEmail = reminderEmail;
    renderReminderEmail();
    renderEmailPreview();
    setStatus('ae-message', 'Restored and saved.', 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('ae-message', error);
  }
});
$('ae-test').addEventListener('click', async () => {
  setStatus('ae-message', 'Sending…');
  try {
    const r = await api('/api/automation/email/test', { method: 'POST', body: JSON.stringify(reminderEmailPayload()) });
    setStatus('ae-message', `Sent to ${r.to}, as typed (not saved yet unless you save).`, 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('ae-message', error);
  }
});

// ---- Preview ---------------------------------------------------------------

/** Who a run would email now. `turnOn`: shown on the way to turning "Run automatically" on. */
async function runAutomationPreview({ turnOn = false } = {}) {
  const button = $('ap-run');
  button.disabled = true;
  $('ap-confirm').hidden = true;
  setStatus('ap-status', 'Reading Checkmarx One as a run would… nothing is sent.');
  try {
    const s = await api('/api/automation/preview', { method: 'POST', body: JSON.stringify({}) });
    state.automation.lastPreview = s;
    renderAutoPreview(s);
    setStatus('ap-status', `${s.inFocus} of ${s.total} projects in focus, ${s.open} open findings looked at. Nothing was sent.`, 'ok');
    renderAutomation();
    if (turnOn) {
      const next = state.automation.wouldRunAt;
      $('ap-confirm').innerHTML = `<p><strong>Turn on reminders?</strong> ${s.people ? `${s.people} ${s.people === 1 ? 'person gets' : 'people get'} reminders about ${s.findings} findings past a limit.` : 'Nobody would be reminded today.'}</p>
        ${next ? `<p class="hint"><span>First run:</span> ${whenHtml(next)}</p>` : ''}
        ${state.automation.config.dryRun ? '<p class="hint">Test mode is on: nothing is sent.</p>' : ''}
        <div class="actions"><button type="button" id="ap-turn-on" class="primary">Turn on</button><button type="button" class="ghost" id="ap-not-yet">Not yet</button></div>`;
      $('ap-confirm').hidden = false;
    }
  } catch (error) {
    if (!handleAuthLoss(error)) showError('ap-status', error);
  } finally {
    button.disabled = false;
  }
}

/** A few project names, and how many more (all of them on hover). */
const someProjects = (names) => `<span title="${escapeHtml(names.join(', '))}">${escapeHtml(names.slice(0, 3).join(', '))}${names.length > 3 ? ` <span class="hint">+${names.length - 3} more</span>` : ''}</span>`;

function renderAutoPreview(s) {
  $('ap-tiles').innerHTML = [
    [s.people, 'people'],
    [s.projects, 'projects'],
    [s.findings, 'findings past a limit'],
    [s.critical, 'critical'],
  ].map(([n, label]) => `<div><span class="value">${n}</span><span class="label">${label}</span></div>`).join('');
  const rows = s.rows.map((r) => `<tr><td>${escapeHtml(r.to)}</td><td>${someProjects(r.projects)}</td><td class="num">${r.critical}</td><td class="num">${r.high}</td><td class="num">${r.medium}</td><td>${escapeHtml(r.limits)}</td><td><button type="button" class="link" data-see-mail="${r.index}">See the email</button></td></tr>`);
  if (s.noAddress) {
    const n = s.noAddress;
    rows.push(`<tr class="auto-missing"><td><span>No address yet</span> <span translate="no">(${escapeHtml(n.people.slice(0, 3).join(', '))}${n.people.length > 3 ? `, +${n.people.length - 3}` : ''})</span></td><td>${someProjects(n.projects)}</td><td class="num">${n.critical}</td><td class="num">${n.high}</td><td class="num">${n.medium}</td><td>${escapeHtml(n.limits)}</td><td><a href="#/settings/initiators">Set addresses</a></td></tr>`);
  }
  for (const p of s.problems ?? []) rows.push(`<tr class="auto-missing"><td>${escapeHtml(p.to)}</td><td colspan="6">${escapeHtml(p.error)}</td></tr>`);
  $('ap-body').innerHTML = rows.length ? rows.join('') : '<tr><td colspan="7" class="hint">Nobody would be emailed now: nothing in focus has newly passed a limit.</td></tr>';
}

$('ap-run').addEventListener('click', () => runAutomationPreview());
$('ap-email-me').addEventListener('click', async () => {
  try {
    const r = await api('/api/automation/preview/email-me', { method: 'POST', body: JSON.stringify({}) });
    setStatus('ap-status', `The preview was emailed to ${r.to}.`, 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('ap-status', error);
  }
});
$('auto-preview').addEventListener('click', async (event) => {
  if (event.target.id === 'ap-not-yet') {
    $('ap-confirm').hidden = true;
    $('auto-enabled').checked = false;
    setStatus('ap-status', 'Left off. Turn it on from Reminders when ready.', '');
    return;
  }
  if (event.target.id === 'ap-turn-on') {
    try {
      await saveAutomation({ enabled: true }, 'ap-status');
      $('ap-confirm').hidden = true;
      setStatus('ap-status', 'Turned on. The next run is shown on Reminders and Schedule.', 'ok');
      $('auto-enabled').checked = true;
    } catch {
      /* said in the status line */
    }
    return;
  }
  const see = event.target.closest('[data-see-mail]');
  if (!see) return;
  try {
    const m = await api(`/api/automation/preview/${see.dataset.seeMail}`);
    $('ap-dialog-meta').textContent = `To ${m.to} · ${m.subject}`;
    $('ap-dialog-frame').srcdoc = m.html;
    $('ap-dialog').showModal();
  } catch (error) {
    if (!handleAuthLoss(error)) showError('ap-status', error);
  }
});
$('ap-dialog-close').addEventListener('click', () => $('ap-dialog').close());

$('auto-save-reminders').addEventListener('click', saveReminders);
$('auto-save-focus').addEventListener('click', () => saveAutomation(focusPayload(), 'auto-focus-message').catch(() => {}));
$('auto-save-schedule').addEventListener('click', () => saveAutomation(schedulePayload(), 'auto-schedule-message').catch(() => {}));
$('auto-focus').addEventListener('input', (event) => {
  if (event.target.matches('#auto-apps, #auto-tags, #auto-projects, #auto-exclude')) checkFocus();
});
for (const radio of document.querySelectorAll('input[name="autoPer"]')) radio.addEventListener('change', renderLimitMode);
for (const radio of document.querySelectorAll('input[name="autoWhen"]')) radio.addEventListener('change', renderWhenMode);
$('auto-enabled').addEventListener('change', () => {
  const turningOn = $('auto-enabled').checked && !state.automation?.config.enabled;
  $('auto-turnon').hidden = !turningOn;
  $('auto-turnon').textContent = turningOn ? 'Save to see who would get what first: it turns on from the preview.' : '';
});

wireSupportNote();

// ---------------------------------------------------------------------------
// The credit pool (Settings → AI & credit pool; live while the page is open)
// ---------------------------------------------------------------------------

const CREDIT_REFRESH_MS = 15_000;
export let creditTimer = null;
const periodText = (pool) => (pool.period === 'all' ? 'one pool, does not refill' : 'refills on the 1st of each month (UTC)');

export async function loadPool({ fresh = false } = {}) {
  clearTimeout(creditTimer);
  if ($('page-settings').hidden) return;
  try {
    const data = await api(fresh ? '/api/credits?fresh=1' : '/api/credits');
    renderPool(data);
  } catch (error) {
    if (handleAuthLoss(error)) return;
    $('pool-view').innerHTML = `<p class="status error">${escapeHtml(error.message)}</p>`;
  }
  creditTimer = setTimeout(loadPool, CREDIT_REFRESH_MS);
}

/** Pool meter + tiles: used (triage / remediation), left, given to projects, free to give. */
function poolHtml(pool, { compact = false } = {}) {
  const used = pool.used;
  const tiles = [
    { label: 'Pool', value: pool.limited ? fmt(pool.size) : 'No limit', detail: pool.limited ? (pool.period === 'all' ? 'One pool' : 'This month') : 'Set a pool size to cap spending' },
    { label: 'Used', value: fmt(used.total), detail: `Triage ${fmt(used.triage)} · Remediation ${fmt(used.remediation)}`, hero: true },
    { label: 'Remaining', value: pool.limited ? fmt(pool.remaining) : '—', detail: pool.limited ? `${Math.round(((pool.remaining ?? 0) / Math.max(1, pool.size)) * 100)}% of the pool` : 'No limit set', bad: pool.limited && pool.remaining === 0 },
    { label: 'Given to projects, not used', value: fmt(pool.outstanding.total), detail: `Triage ${fmt(pool.outstanding.triage)} · Remediation ${fmt(pool.outstanding.remediation)}` },
    { label: 'Free to give', value: pool.limited ? fmt(pool.unallocated) : '—', detail: pool.overAllocated ? `Projects hold ${fmt(pool.overAllocated)} more than the pool has left` : 'Can still be allocated to projects', bad: pool.overAllocated > 0 },
  ];
  // Checkmarx One has fewer credits left for the tenant than the pool: spending stops at what the tenant has left.
  if (pool.overTenant) Object.assign(tiles[2], { detail: `Checkmarx One: ${fmt(pool.tenantLeft)} left for the tenant`, bad: true });
  const over = pool.overTenant
    ? `<p class="status error">${escapeHtml(`The pool has ${fmt(pool.remaining)} credits left, but Checkmarx One has only ${fmt(pool.tenantLeft)} left for this tenant: spending stops at ${fmt(pool.tenantLeft)}.`)} <a href="#/settings/ai">${escapeHtml('Lower the pool')}</a></p>`
    : '';
  const tileHtml = `${over}<div class="stat-tiles">${tiles
    .map((t) => `<div class="${t.hero ? 'hero' : ''} ${t.bad ? 'bad' : ''}"><span class="label">${escapeHtml(t.label)}</span><span class="value">${escapeHtml(t.value)}</span><span class="detail">${escapeHtml(t.detail)}</span></div>`)
    .join('')}</div>`;
  if (!pool.limited) return compact ? tileHtml : tileHtml;
  const pct = (n) => `${Math.max(0, (n / Math.max(1, pool.size)) * 100).toFixed(2)}%`;
  const given = Math.min(pool.outstanding.total, pool.remaining ?? 0);
  const meter = `<div class="pool-meter" role="img" aria-label="${escapeHtml(`Of ${fmt(pool.size)} credits: ${fmt(used.triage)} used for triage, ${fmt(used.remediation)} for remediation, ${fmt(given)} given to projects and not used, ${fmt(pool.unallocated)} free`)}">
      <span class="m-triage" style="width:${pct(used.triage)}" title="Triage: ${fmt(used.triage)}"></span>
      <span class="m-remediation" style="width:${pct(used.remediation)}" title="Remediation: ${fmt(used.remediation)}"></span>
      <span class="m-given" style="width:${pct(given)}" title="Given to projects, not used: ${fmt(given)}"></span>
    </div>
    <div class="pool-legend">
      <span><i class="key key-triage"></i>Used for triage <b>${fmt(used.triage)}</b></span>
      <span><i class="key key-remediation"></i>Used for remediation <b>${fmt(used.remediation)}</b></span>
      <span><i class="key key-given"></i>Given to projects, not used <b>${fmt(given)}</b></span>
      <span><i class="key key-free"></i>Free to give <b>${fmt(pool.unallocated)}</b></span>
    </div>`;
  return tileHtml + meter;
}

function renderPool(data) {
  const pool = data.pool;
  const allowed = [data.enabled && 'triage', data.remediationEnabled && 'remediation'].filter(Boolean);
  $('credit-state').textContent = allowed.length
    ? `Allowed: ${allowed.join(' and ')}${pool.limited ? ` · ${fmt(pool.remaining)} of ${fmt(pool.size)} credits left` : ' · no credit limit'}`
    : 'Switched off';
  $('credit-state').className = `hint ${allowed.length ? 'ok-hint' : ''}`;
  const warning = allowed.length && !data.relayConnected
    ? '<p class="status error">This server is not connected to Checkmarx One, so reports cannot triage or remediate. Connect it under "Checkmarx One integration" above.</p>'
    : '';
  // What the tenant has left in Checkmarx One: the pool, and what projects are given, stay within it.
  poolTenant = data.tenant ?? null;
  renderPoolTenant(data);
  checkPoolLimit();
  $('pool-view').innerHTML = `${warning}${poolHtml(pool)}<p class="hint wide">${escapeHtml(pool.limited ? `The pool ${periodText(pool)}.` : 'No pool size set: spending is limited by what each project is allocated, and by what the tenant has left.')} Per project and over time: <a href="#/credits">Credits</a>.</p>`;
}

/** The tenant's credits as Checkmarx One last said (Settings → AI & credit pool), or null when it did not answer. */
export let poolTenant = null;

/** The Checkmarx One tenant card beside the pool size: what is left, used, given to projects. */
function renderPoolTenant(data) {
  const t = data.tenant;
  const held = data.pool?.outstanding?.total ?? 0;
  const read = `<small>${t?.readAt ? `<span>${escapeHtml('read')}</span> <time translate="no">${escapeHtml(fmtDateTime(t.readAt))}</time> · ` : ''}<a href="#" id="pool-tenant-read">${escapeHtml('read again')}</a></small>`;
  if (!t) {
    $('pool-tenant-card').innerHTML = `<h4>${escapeHtml('Checkmarx One tenant')} ${read}</h4><p class="hint">${escapeHtml('Checkmarx One did not say what this tenant has left. The pool is checked against it when it answers.')}</p>`;
    return;
  }
  const pct = (n) => (t.total ? `${Math.min(100, (n / t.total) * 100).toFixed(2)}%` : '0%');
  const within = (n) => `<span class="${n <= t.available ? 'ok-text' : 'bad-text'}">${escapeHtml(n <= t.available ? 'within what is left' : 'more than is left')}</span>`;
  const size = data.pool?.limited ? data.pool.size : 0;
  const charged = { off: 'not charged on this tenant', reserved: 'credits reserved for each scan' }[data.fusionCharged];
  const rows = [
    t.used !== null && ['Used', escapeHtml(`${fmt(t.used)}${t.actionsPerformed !== null ? ` · ${fmt(t.actionsPerformed)} actions` : ''}`)],
    ['Given to projects', `${escapeHtml(`${fmt(held)} of ${fmt(t.available)}`)} · ${within(held)}`],
    ["This app's pool", size ? `${escapeHtml(fmt(size))} · ${within(size)}` : escapeHtml('no size: up to what is left')],
    charged && ['Fusion scans', escapeHtml(charged)],
  ];
  $('pool-tenant-card').innerHTML = `<h4>${escapeHtml('Checkmarx One tenant')} ${read}</h4>
    <div class="fusion-big"><div><b>${escapeHtml(fmt(t.available))}</b><span>${escapeHtml(t.total !== null ? `credits left of ${fmt(t.total)}` : 'credits left')}</span></div></div>
    ${t.total ? `<div class="fusion-meter" role="img" aria-label="${escapeHtml(`${fmt(t.used ?? 0)} of ${fmt(t.total)} used`)}"><i class="is-used" style="width:${pct(t.used ?? 0)}"></i><i class="is-held" style="width:${pct(held)}"></i></div>` : ''}
    <dl class="fusion-kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

/** The pool size against what the tenant has left, as it is typed: within it, or why it cannot be saved. */
export function checkPoolLimit() {
  const t = poolTenant;
  const box = $('ai-limit-check');
  $('ai-limit-max').textContent = t ? `at most ${fmt(t.available)}` : '';
  const size = Math.floor(Number($('ai-limit').value) || 0);
  $('ai-limit').classList.toggle('is-invalid', Boolean(t && size > t.available));
  if (!t) {
    box.innerHTML = '';
    return;
  }
  if (size <= 0) {
    box.innerHTML = `<p class="hint">${escapeHtml(`No size: up to the ${fmt(t.available)} credits the tenant has left.`)}</p>`;
  } else if (size <= t.available) {
    box.innerHTML = `<p class="hint"><span class="ok-text">✓ <span>${escapeHtml('Within what the tenant has left')}</span></span> · <span>${escapeHtml(`${fmt(t.available - size)} credits stay outside the pool.`)}</span></p>`;
  } else {
    box.innerHTML = `<p class="status error"><span>${escapeHtml(`${fmt(size)} is more than the ${fmt(t.available)} credits this tenant has left in Checkmarx One. Set ${fmt(t.available)} or less to save.`)}</span> <button type="button" class="sm" id="ai-limit-fit">${escapeHtml(`Use ${fmt(t.available)}`)}</button></p>`;
  }
}
$('ai-limit').addEventListener('input', checkPoolLimit);
$('ai-limit-check').addEventListener('click', (event) => {
  if (!event.target.closest('#ai-limit-fit') || !poolTenant) return;
  $('ai-limit').value = String(poolTenant.available);
  $('ai-limit').dispatchEvent(new Event('input', { bubbles: true }));
});
$('pool-tenant-card').addEventListener('click', (event) => {
  if (!event.target.closest('#pool-tenant-read')) return;
  event.preventDefault();
  loadPool({ fresh: true });
});

wireSettings();

export function renderRecipientHint() {
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
  // A scan initiator is only ever sent the projects whose latest scan they ran.
  const theirs = emailContent === 'summary' ? 'one email covering only the selected projects they scanned' : 'one email for each selected project they scanned';
  const attached = attachHtml ? ', with its own interactive report attached' : '';
  let hint = '';
  if (sendTo === 'list') {
    hint = `The recipient list gets one email covering every selected project${attached}.`;
  } else if (sendTo === 'initiator') {
    hint = `Each developer gets ${theirs}${attached}, never anyone else's projects.`;
  } else {
    hint = `Each developer gets ${theirs}${attached}; the fixed list gets one covering everything selected.`;
  }

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
    el.textContent = 'Email is not set up yet: test it under Settings → Email server.';
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
// Workbench: scope
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
  // Named projects (by id) and people: only these are fetched.
  for (const id of scopePick.applications.keys()) params.append('application', id);
  for (const id of scopePick.projects.keys()) params.append('project', id);
  for (const who of scopePick.initiators) params.append('initiator', who);
  if (state.vulnerability) params.set('vulnerability', state.vulnerability);
  params.set('engines', [...enginePick].join(','));
  // Each project's primary branch unless every branch is ticked; projects with nothing to analyse left out as chosen.
  if (focusPick.allBranches) params.set('branches', 'all');
  if (!focusPick.leaveOutNoCode) params.set('zeroLoc', 'keep');
  if (focusPick.leaveOutNoFindings) params.set('noFindings', 'leave-out');
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

/**
 * "Findings open for": the one question about time on the Workbench. Any age; open for more than so many days
 * (the server's age presets); or new in the last week or month. The ids are the server's window presets.
 */
function fillAgePresets(defaultId = 'any') {
  const options = [
    { id: 'any', label: 'Any age' },
    ...(state.health?.agePresets ?? []),
    { id: '7d', label: 'New this week' },
    { id: '30d', label: 'New this month' },
    { id: 'custom', label: 'Custom dates…' },
  ];
  $('detection-preset').innerHTML = options.map((p) => `<option value="${escapeHtml(p.id)}"${p.id === defaultId ? ' selected' : ''}>${escapeHtml(p.label)}</option>`).join('');
}
const ageLabel = () => $('detection-preset').selectedOptions[0]?.textContent ?? '';
/** What the choice loads, in a sentence (the control's tooltip). */
function ageHint(id) {
  if (id === 'any') return 'Every open finding, whatever its age.';
  if (id === '7d' || id === '30d') return `Only findings first found in the last ${id === '7d' ? '7' : '30'} days: older ones are not loaded.`;
  if (id === 'custom') return 'Only findings first found between these dates.';
  if (/^gt\d+$/.test(id)) return `Only findings first found more than ${id.slice(2)} days ago and still open.`;
  return 'Only findings first found in this time are loaded.';
}

function updateScopeSummary() {
  const detection = $('detection-preset').value;
  const named = scopeNamed();
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const projectsPart = named
    ? [
        scopePick.applications.size && plural(scopePick.applications.size, 'application'),
        scopePick.projects.size && plural(scopePick.projects.size, 'named project'),
        scopePick.initiators.size && `${scopePick.initiators.size === 1 ? '1 person' : `${scopePick.initiators.size} people`}'s projects`,
      ].filter(Boolean).join(' + ')
    : presetLabel($('activity-preset').value);
  $('scope-summary').textContent = `Projects: ${projectsPart} · Findings: ${ageLabel()}`;
  // Naming projects or people replaces the "last scanned in" window.
  $('activity-preset').disabled = Boolean(named);
  $('activity-preset').title = named ? 'Named applications, projects and people are fetched whatever their last scan date.' : '';
  $('activity-hint').textContent = named
    ? 'Not used while applications, projects or people are named below: those are fetched whatever their last scan date.'
    : 'Skips projects with no scan in this window.';

  $('detection-hint').textContent = ageHint(detection);
  // The compact scope row shows these as the choices' tooltips.
  if (!named) $('activity-preset').title = $('activity-hint').textContent;
  $('detection-preset').title = $('detection-hint').textContent;
}

// ---------------------------------------------------------------------------
// Engines: which Checkmarx One engines' findings are loaded (SAST and SCA, the engines AI Triage
// and AI Remediation work on, unless more are ticked). Remembered in this browser.
// ---------------------------------------------------------------------------

const ENGINE_KEY = 'mz-engines';
function savedEngines() {
  try {
    const saved = cleanEngines(JSON.parse(localStorage.getItem(ENGINE_KEY) || 'null'));
    if (saved.length) return saved;
  } catch {}
  return [...DEFAULT_ENGINES];
}
const enginePick = new Set(savedEngines());

/** The engines' tick boxes (AI engines first), for any picker: `chosen` is a Set, `onChange` hears the new choice. */
function engineOptions(box, chosen, onChange) {
  box.replaceChildren(
    ...ENGINES.map((engine) => {
      const label = document.createElement('label');
      label.className = 'engine-opt';
      const input = Object.assign(document.createElement('input'), { type: 'checkbox', value: engine.key, checked: chosen.has(engine.key) });
      const name = document.createElement('b');
      name.setAttribute('translate', 'no');
      name.textContent = engine.label;
      const what = document.createElement('span');
      what.className = 'muted';
      what.textContent = engine.name;
      const tag = document.createElement('small');
      tag.className = engine.ai ? 'engine-ai' : '';
      tag.textContent = engine.ai ? 'AI Triage & Remediation' : 'No AI';
      input.addEventListener('change', () => {
        if (input.checked) chosen.add(engine.key);
        else if (chosen.size > 1) chosen.delete(engine.key);
        else {
          // At least one engine: nothing would be loaded otherwise.
          input.checked = true;
          return onChange(chosen, 'Keep at least one engine.');
        }
        onChange(chosen);
      });
      label.append(input, name, what, tag);
      return label;
    }),
  );
}

/** The engines the loaded data covers ([] = every engine), or null before anything is loaded. */
const loadedEngines = () => (state.lastScan ? (state.lastScan.engines ?? state.lastScan.request?.engines ?? []) : null);
const sameEngines = (a, b) => cleanEngines(a.length ? a : ENGINES.map((e) => e.key)).join() === cleanEngines(b.length ? b : ENGINES.map((e) => e.key)).join();

function renderEnginePick(note = '') {
  $('engine-summary').textContent = describeEngines([...enginePick]);
  if (!$('engine-menu').childElementCount) {
    engineOptions($('engine-menu'), enginePick, (chosen, warning) => {
      try {
        localStorage.setItem(ENGINE_KEY, JSON.stringify([...chosen]));
      } catch {}
      renderEnginePick(warning);
      updateScopeSummary();
    });
  } else {
    for (const box of $('engine-menu').querySelectorAll('input')) box.checked = enginePick.has(box.value);
  }
  // Changed since the data was loaded: say that loading again applies it.
  const loaded = loadedEngines();
  const changed = loaded !== null && !sameEngines(loaded, [...enginePick]);
  const hint = $('engine-hint');
  hint.textContent = note || (changed ? 'Changed: load findings again to apply it.' : '');
  hint.hidden = !hint.textContent;
}

/** Tick the engines a load was made with ([] = every engine). */
function setEnginePick(engines) {
  const list = cleanEngines(engines);
  enginePick.clear();
  for (const key of list.length ? list : ENGINES.map((e) => e.key)) enginePick.add(key);
  renderEnginePick();
}

// ---------------------------------------------------------------------------
// Branch and projects: each project's primary branch (unless every branch is ticked), and whether
// projects with no lines of code, or no open findings, are left out. Remembered in this browser.
// ---------------------------------------------------------------------------

const FOCUS_KEY = 'mz-focus';
const DEFAULT_FOCUS = { allBranches: false, leaveOutNoCode: true, leaveOutNoFindings: false };
function savedFocus() {
  try {
    const saved = JSON.parse(localStorage.getItem(FOCUS_KEY) || 'null');
    if (saved && typeof saved === 'object') return { allBranches: saved.allBranches === true, leaveOutNoCode: saved.leaveOutNoCode !== false, leaveOutNoFindings: saved.leaveOutNoFindings === true };
  } catch {}
  return { ...DEFAULT_FOCUS };
}
const focusPick = savedFocus();
const FOCUS_BOXES = { allBranches: 'focus-all-branches', leaveOutNoCode: 'focus-no-code', leaveOutNoFindings: 'focus-no-findings' };

/** What a load was made with (a load made before these choices: every branch, nothing left out). */
function focusOf(request) {
  if (!request) return null;
  return { allBranches: request.branches !== 'primary', leaveOutNoCode: request.branches ? request.zeroLoc !== 'keep' : false, leaveOutNoFindings: request.noFindings === 'leave-out' };
}

function renderFocusPick() {
  for (const [key, id] of Object.entries(FOCUS_BOXES)) $(id).checked = focusPick[key];
  $('focus-summary').textContent = focusPick.allBranches ? 'Every branch' : 'Primary branch';
  const loaded = focusOf(state.lastScan?.request ?? (state.lastScan ? { branches: state.lastScan.branchScope, zeroLoc: state.lastScan.leaveOut?.noCode === false ? 'keep' : '', noFindings: state.lastScan.leaveOut?.noFindings ? 'leave-out' : '' } : null));
  const changed = loaded && Object.keys(FOCUS_BOXES).some((key) => loaded[key] !== focusPick[key]);
  const hint = $('focus-hint');
  hint.textContent = changed ? 'Changed: load findings again to apply it.' : '';
  hint.hidden = !hint.textContent;
}

/** The projects a load left out, one note each: a primary branch never scanned, no lines of code, no open findings. */
function showLeftOut(result) {
  const out = result?.leftOut ?? {};
  const notes = [
    out.noPrimaryScan && `${out.noPrimaryScan} project(s) left out: their primary branch has no completed scan.`,
    out.noCode && `${out.noCode} project(s) left out: their scan counted no lines of code.`,
    out.noFindings && `${out.noFindings} project(s) left out: no open findings.`,
  ].filter(Boolean);
  $('left-out').replaceChildren(...notes.map((text) => Object.assign(document.createElement('span'), { textContent: text })));
  $('left-out').hidden = !notes.length;
}

/** Tick what a load was made with. */
function setFocusPick(request) {
  const loaded = focusOf(request);
  if (loaded) Object.assign(focusPick, loaded);
  renderFocusPick();
}

for (const [key, id] of Object.entries(FOCUS_BOXES)) {
  $(id).addEventListener('change', (event) => {
    focusPick[key] = event.target.checked;
    try {
      localStorage.setItem(FOCUS_KEY, JSON.stringify(focusPick));
    } catch {}
    renderFocusPick();
  });
}

// ---------------------------------------------------------------------------
// Scope: fetch only named projects, or the projects named people last scanned
// ---------------------------------------------------------------------------

const scopePick = { applications: new Map(), projects: new Map(), initiators: new Set(), options: null, loading: null };
/** Applications, projects and people named. */
const scopeNamed = () => scopePick.applications.size + scopePick.projects.size + scopePick.initiators.size;

/** Project names and latest-scan initiators, for the suggestions (loaded on first use). */
function loadScopeOptions() {
  if (scopePick.options) return Promise.resolve(scopePick.options);
  if (scopePick.loading) return scopePick.loading;
  setScopeHint('Loading project names and who scanned them…');
  scopePick.loading = api('/api/scope/options')
    .then((data) => {
      scopePick.options = data;
      $('scope-application-options').replaceChildren(
        ...(data.applications ?? []).map((a) => Object.assign(document.createElement('option'), { value: a.name, label: `${a.projects} project${a.projects === 1 ? '' : 's'}` })),
      );
      const projectList = $('scope-project-options');
      const peopleList = $('scope-initiator-options');
      projectList.replaceChildren(...data.projects.map((p) => Object.assign(document.createElement('option'), { value: p.name })));
      peopleList.replaceChildren(
        ...data.initiators.map((i) => Object.assign(document.createElement('option'), { value: i.initiator, label: `${i.email ? `${i.email} · ` : ''}${i.projects} project${i.projects === 1 ? '' : 's'}` })),
      );
      setScopeHint(data.warning || `${(data.applications ?? []).length} applications, ${data.projects.length} projects, ${data.initiators.length} people. Pick as you type; Enter adds every name that contains the text.`, data.warning ? 'error' : '');
      return data;
    })
    .catch((error) => {
      if (!handleAuthLoss(error)) setScopeHint(`Could not load project names: ${error.message}`, 'error');
      return null;
    })
    .finally(() => {
      scopePick.loading = null;
    });
  return scopePick.loading;
}

function setScopeHint(text, kind = '') {
  $('scope-pick-hint').textContent = text;
  $('scope-pick-hint').className = `hint wide ${kind === 'error' ? 'error-hint' : ''}`;
}

/** Add the project with this exact name, else every project whose name contains the text. Returns how many. */
async function addScopeProjects(text) {
  const wanted = text.trim().toLowerCase();
  if (!wanted) return 0;
  const options = await loadScopeOptions();
  if (!options) return 0;
  const exact = options.projects.filter((p) => p.name.toLowerCase() === wanted);
  const matches = exact.length ? exact : options.projects.filter((p) => p.name.toLowerCase().includes(wanted));
  for (const p of matches) scopePick.projects.set(p.id, p.name);
  if (!matches.length) setScopeHint(`No project name contains "${text.trim()}".`, 'error');
  else if (!exact.length) setScopeHint(`Added ${matches.length} project${matches.length === 1 ? '' : 's'} whose name contains "${text.trim()}".`);
  return matches.length;
}

/** Add the application with this exact name, else every application whose name contains the text. Returns how many. */
async function addScopeApplications(text) {
  const wanted = text.trim().toLowerCase();
  if (!wanted) return 0;
  const options = await loadScopeOptions();
  if (!options) return 0;
  const all = options.applications ?? [];
  const exact = all.filter((a) => a.name.toLowerCase() === wanted);
  const matches = exact.length ? exact : all.filter((a) => a.name.toLowerCase().includes(wanted));
  for (const a of matches) scopePick.applications.set(a.id, a.name);
  if (!all.length) setScopeHint('Checkmarx One lists no applications for this key.', 'error');
  else if (!matches.length) setScopeHint(`No application name contains "${text.trim()}".`, 'error');
  return matches.length;
}

function addScopeInitiator(text) {
  const who = text.trim();
  if (who) scopePick.initiators.add(who);
}

/** Chips, built from text nodes (names come from Checkmarx One). */
function renderScopeChips() {
  const draw = (box, entries, kind) => {
    for (const chip of box.querySelectorAll('.scope-chip')) chip.remove();
    const input = box.querySelector('input');
    for (const [key, label] of entries) {
      const chip = document.createElement('span');
      chip.className = 'scope-chip';
      const text = document.createElement('span');
      text.textContent = label;
      text.title = label;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${label}`);
      remove.dataset.removeScope = kind;
      remove.dataset.key = key;
      chip.append(text, remove);
      box.insertBefore(chip, input);
    }
  };
  draw($('scope-applications'), [...scopePick.applications], 'application');
  draw($('scope-projects'), [...scopePick.projects], 'project');
  draw($('scope-initiators'), [...scopePick.initiators].map((who) => [who, who]), 'initiator');
  updateScopeSummary();
  syncNarrow();
}

const scopeStore = (kind) => (kind === 'application' ? scopePick.applications : kind === 'project' ? scopePick.projects : scopePick.initiators);
for (const [inputId, kind] of [['scope-application-input', 'application'], ['scope-project-input', 'project'], ['scope-initiator-input', 'initiator']]) {
  const input = $(inputId);
  input.addEventListener('focus', () => loadScopeOptions());
  const commit = async () => {
    const value = input.value;
    input.value = '';
    if (kind === 'application') await addScopeApplications(value);
    else if (kind === 'project') await addScopeProjects(value);
    else addScopeInitiator(value);
    renderScopeChips();
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',' || event.key === 'Tab') {
      if (!input.value.trim()) return;
      event.preventDefault();
      commit();
    } else if (event.key === 'Backspace' && !input.value) {
      const store = scopeStore(kind);
      const last = [...store.keys()].pop();
      if (last !== undefined) {
        store.delete(last);
        renderScopeChips();
      }
    }
  });
  // Picking a suggestion fills the input with an exact value: add it straight away.
  input.addEventListener('input', () => {
    const value = input.value.trim().toLowerCase();
    if (!value || !scopePick.options) return;
    const exact = kind === 'application'
      ? (scopePick.options.applications ?? []).some((a) => a.name.toLowerCase() === value)
      : kind === 'project'
        ? scopePick.options.projects.some((p) => p.name.toLowerCase() === value)
        : scopePick.options.initiators.some((i) => i.initiator.toLowerCase() === value);
    if (exact) commit();
  });
}

$('scope-pick').addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-scope]');
  if (!button) return;
  scopeStore(button.dataset.removeScope).delete(button.dataset.key);
  renderScopeChips();
});

// ---------------------------------------------------------------------------
// Workbench: table
// ---------------------------------------------------------------------------

/** What a project's latest scan was: 'fusion', 'last', 'none', or '' when not known (the fetch's, else the Fusion page's). */
const scanTypeOf = (p) => p.scanType || fusion.data?.projects?.[p.projectId]?.scanType || '';

function visibleProjects() {
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
const fusion = { data: null, scope: null, credits: null, loading: null, open: null, lane: null };
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
$('export-projects').addEventListener('click', exportProjectsCsv);
renderColumnMenu();
renderProjectsHead();

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

function renderProjects() {
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
function sharedResultsHtml(groups, severities, { open = false, folded = false } = {}) {
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

// ---------------------------------------------------------------------------
// Tracked reports
// ---------------------------------------------------------------------------

function trackScope() {
  const severity = $('severity-filter').value;
  // (How old the findings are is part of what was loaded, "Findings open for": the table no longer narrows by age.)
  const bucket = '';
  const projects = allocationScope();
  const parts = [
    $('scope-summary').textContent,
    severity ? `${severity.toLowerCase()} only` : 'all severities',
    describeEngines(state.lastScan?.engines ?? []),
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

export async function loadTrackedReports() {
  clearTimeout(trackTimer);
  if ($('page-reports').hidden) return;
  try {
    const data = await api('/api/tracked-reports');
    if (data.timeZone) serverZone = data.timeZone;
    renderTrackedReports(data);
  } catch (error) {
    if (handleAuthLoss(error)) return;
    $('reports-list').innerHTML = `<p class="status error">${escapeHtml(error.message)}</p>`;
  }
  trackTimer = setTimeout(loadTrackedReports, TRACK_POLL_MS);
}

const OUTCOME_LABELS = {
  resolved: 'No longer detected',
  notExploitable: 'Not exploitable',
  confirmed: 'Confirmed',
  awaiting: 'Awaiting triage',
};

/** Outcomes as one bar: what was dealt with, in colour, on a neutral track that is what is left. */
function progressBar(outcomes, total, { legend = true } = {}) {
  if (!total) return '<div class="rp-bar" role="img" aria-label="Nothing to track"></div>';
  const done = ['resolved', 'notExploitable', 'confirmed'];
  const label = done.map((k) => `${OUTCOME_LABELS[k]} ${outcomes[k] ?? 0}`).join(', ');
  const rest = Math.max(0, total - done.reduce((n, k) => n + (outcomes[k] ?? 0), 0));
  return `<div class="rp-bar" role="img" aria-label="${escapeHtml(`${label}, awaiting triage ${outcomes.awaiting ?? 0}, of ${total}`)}">${done
    .map((key) => (outcomes[key] ? `<span class="out-${key}" style="flex:${outcomes[key]} 1 0" title="${escapeHtml(OUTCOME_LABELS[key])}: ${outcomes[key]}"></span>` : ''))
    .join('')}${rest ? `<span class="out-track" style="flex:${rest} 1 0" title="Awaiting triage: ${rest}"></span>` : ''}</div>${legend ? `<div class="rp-legend">${Object.entries(OUTCOME_LABELS)
    .map(([key, text]) => `<span><i class="out-${key}"></i>${escapeHtml(text)} <b>${outcomes[key] ?? 0}</b></span>`)
    .join('')}</div>` : ''}`;
}

const trackedById = new Map();
export const rpState = { filter: 'all', search: '', sort: 'open', open: '', tab: 'overview', data: null };

/** Open findings at each reading: awaiting triage, confirmed or new (and not triaged as not exploitable). */
const openSeries = (r) => {
  const points = (r.history ?? []).map((h) => ({ at: h.at, open: (h.awaiting ?? 0) + (h.confirmed ?? 0) + (h.newOpen ?? h.newFindings ?? 0) }));
  if (r.latest && (!points.length || points.at(-1).at !== r.latest.at)) points.push({ at: r.latest.at, open: r.latest.open ?? 0 });
  return points;
};

/** Where a report stands, in one word: tells the team where to look first. */
function reportStatus(r) {
  const l = r.latest;
  if (r.lastError) return { key: 'attention', tone: 'critical', label: 'Update failed', icon: '!' };
  if (r.automation?.lastError) return { key: 'attention', tone: 'critical', label: 'Reminder failed', icon: '!' };
  if (!l) return { key: 'pending', tone: 'neutral', label: 'Not measured yet', icon: '…' };
  // Verified at zero, and kept there: new findings in scope after that are called out at once.
  if (r.verification?.result?.zero && l.open) return { key: 'attention', tone: 'critical', label: `Left zero: ${l.open} open again`, icon: '!' };
  if (r.verification?.result?.zero) return { key: 'complete', tone: 'good', label: `Verified at zero · round ${r.verification.round}`, icon: '✓' };
  if (r.verification && !r.verification.finishedAt && !r.verification.result) return { key: 'scheduled', tone: 'info', label: 'Verifying…', icon: '⟳' };
  if (l.baseline && !l.open) return { key: 'complete', tone: 'good', label: 'Complete', icon: '✓' };
  if (r.automation?.enabled) return { key: 'scheduled', tone: 'info', label: 'On schedule', icon: '⟳' };
  return { key: 'attention', tone: 'warning', label: 'Needs follow-up', icon: '!' };
}

function relativeTime(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  const abs = Math.abs(ms);
  const units = [['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000]];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of units) if (abs >= size || unit === 'minute') return rtf.format(Math.round(ms / size), unit);
  return '';
}

/** A tiny line of open findings over the readings (no axes: the row says the numbers). */
function sparkline(points) {
  if (points.length < 2) return '<span class="rp-spark empty" aria-hidden="true"></span>';
  const w = 96;
  const h = 28;
  const max = Math.max(1, ...points.map((p) => p.open));
  const xy = points.map((p, i) => [(i / (points.length - 1)) * (w - 4) + 2, h - 3 - (p.open / max) * (h - 6)]);
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = xy.at(-1);
  const first = points[0].open;
  const last = points.at(-1).open;
  return `<svg class="rp-spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="Open findings: ${first} to ${last} over ${points.length} readings"><title>Open findings: ${first} → ${last} over ${points.length} readings</title>
    <path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${lx}" cy="${ly}" r="3" fill="currentColor" stroke="var(--surface)" stroke-width="2"/></svg>`;
}

function statusChip(status) {
  return `<span class="rp-chip tone-${status.tone}"><span aria-hidden="true">${status.icon}</span>${escapeHtml(status.label)}</span>`;
}

function scheduleText(auto, { short = false } = {}) {
  if (!auto?.enabled) return short ? 'Not scheduled' : 'No automatic reminders';
  const every = auto.everyDays === 1 ? 'daily' : `every ${auto.everyDays} days`;
  return short ? `${every[0].toUpperCase()}${every.slice(1)}` : `Every ${auto.everyDays === 1 ? 'day' : `${auto.everyDays} days`} at ${String(auto.hour ?? 9).padStart(2, '0')}:00`;
}

function renderTrackedReports(data) {
  rpState.data = data;
  const { reports, autoRefresh } = data;
  trackedById.clear();
  for (const r of reports) trackedById.set(r.id, r);
  $('reports-meta').textContent = autoRefresh
    ? 'Updates automatically: hourly, and every few minutes after anyone triages or remediates.'
    : 'Automatic updates need a stored Checkmarx One connection (CX_API_KEY, or arm automation in Settings); use Refresh meanwhile.';
  renderPortfolio(reports, data.portfolio);
  renderUpcoming(reports);
  renderReportList();
  if (rpState.open) {
    if (trackedById.has(rpState.open)) renderReportDetail(rpState.open);
    else closeReportDetail();
  }
}

/** What the Dashboard's numbers mean: one definition each, behind a ?. */
const RP_DEFINE = {
  tracked: 'The findings each report held when it was saved (or when its round began), added up over the reports; a finding in two reports counts in both. They are awaiting triage, confirmed or closed: the next three tiles add up to this one. Actioned: confirmed or closed.',
  awaiting: 'Still To verify in Checkmarx One: nobody has triaged them yet.',
  confirmed: 'Triaged as Confirmed or Urgent: real, and still to be fixed.',
  closed: 'Triaged as not exploitable, or no longer reported by Checkmarx One. No longer detected is not proof of a fix: the code may have changed or the project may not have been scanned since. Only a verification rescan proves a fix.',
  fresh: 'First found by Checkmarx One after the report was saved, and matching its filters. Older findings that only now match (for example, ones that aged past 60 days) are not new.',
  followups: 'Reminders a report sends by itself, every few days at a set hour. Open a report, then Remind → Automatic follow-up.',
  credits: 'AI Triage / AI Remediation credits spent on these reports\' projects since each report was saved. A project in two reports is counted once.',
  open: 'Awaiting triage, confirmed, or new since saved: what is still to deal with before the report reaches zero.',
  hero: 'Actioned: confirmed, not exploitable or no longer detected. No longer detected means Checkmarx One no longer reports it, which is not proof of a fix: the code may have changed, or the project may not have been scanned since. Only a verification rescan proves a fix.',
};

/** A watch dial's minute marks: `n` ticks around (cx, cy) at radius r, every fifth one longer. */
function dialTicks(cx, cy, r, n) {
  let out = '';
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * 2 * Math.PI;
    const long = i % 5 === 0;
    const r1 = r - (long ? 7 : 3.5);
    const c = Math.cos(a);
    const s = Math.sin(a);
    out += `<line class="${long ? 'tick-long' : 'tick'}" x1="${(cx + c * r1).toFixed(2)}" y1="${(cy + s * r1).toFixed(2)}" x2="${(cx + c * r).toFixed(2)}" y2="${(cy + s * r).toFixed(2)}" />`;
  }
  return out;
}

/**
 * The tracked findings as a sunflower (the command-center and Studio looks), after Giorgia Lupi's data
 * humanism: every finding is one seed, laid out on the golden angle the way a sunflower grows. Closed ones
 * sit at the calm grey heart, confirmed ones are solid ink, and those awaiting triage are open rings in the
 * signal colour around the rim; bigger seeds are more severe. As the work is done the heart grows outward.
 */
const SEED_SIZE = { CRITICAL: 1.3, HIGH: 1.05, MEDIUM: 0.82, LOW: 0.64 };
const SEED_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'UNKNOWN', 'INFO'];
const MAX_SEEDS = 1400;

function sunflower(parts) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  const per = Math.max(1, Math.ceil(total / MAX_SEEDS));
  // Seeds from the heart outward: closed, then confirmed, then awaiting triage; within each, mildest first.
  const seeds = [];
  for (const p of ['closed', 'confirmed', 'awaiting'].map((k) => parts.find((x) => x.key === k))) {
    const sev = p.bySeverity ?? {};
    const known = Object.values(sev).reduce((n, v) => n + v, 0);
    const counts = known ? SEED_ORDER.map((s) => [s, sev[s] ?? 0]) : [['MEDIUM', p.value]];
    for (const [severity, count] of counts) for (let i = 0; i < Math.ceil(count / per); i += 1) seeds.push({ key: p.key, severity });
  }
  const n = seeds.length;
  if (!n) return '';
  const R0 = 68;
  const R1 = 146;
  const c = Math.sqrt((R1 * R1 - R0 * R0) / n);
  const i0 = (R0 / c) ** 2;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const base = Math.min(5.2, Math.max(0.9, c * 0.36));
  const out = { closed: [], confirmed: [], awaiting: [] };
  seeds.forEach((seed, i) => {
    const r = c * Math.sqrt(i + i0);
    const a = (i + i0) * golden;
    const x = 150 + r * Math.cos(a);
    const y = 150 + r * Math.sin(a);
    const size = (base * (SEED_SIZE[seed.severity] ?? 0.8)).toFixed(2);
    out[seed.key].push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${size}" />`);
  });
  return `<svg class="seedfield" viewBox="0 0 300 300" role="img" aria-label="${escapeHtml(parts.map((p) => `${p.label}: ${p.value}`).join(', '))}">
    <g class="seeds seeds-closed">${out.closed.join('')}</g>
    <g class="seeds seeds-confirmed">${out.confirmed.join('')}</g>
    <g class="seeds seeds-awaiting">${out.awaiting.join('')}</g>
  </svg>${per > 1 ? `<span class="seed-note">One seed for every ${per} findings</span>` : ''}`;
}

function renderFlow(reports) {
  const box = $('rp-flow');
  const measured = reports.filter((r) => r.latest);
  if (!measured.length) {
    box.hidden = true;
    return;
  }
  const n = (key) => measured.reduce((sum, r) => sum + (r.latest.outcomes?.[key] ?? 0), 0);
  const sev = (...keys) => {
    const out = {};
    for (const r of measured) for (const key of keys) for (const [s, v] of Object.entries(r.latest.bySeverity?.[key] ?? {})) out[s] = (out[s] ?? 0) + v;
    return out;
  };
  const baseline = measured.reduce((sum, r) => sum + (r.latest.baseline ?? 0), 0);
  const actioned = measured.reduce((sum, r) => sum + (r.latest.actioned ?? 0), 0);
  const pct = baseline ? Math.round((actioned / baseline) * 100) : 0;
  const parts = [
    { key: 'awaiting', label: 'Awaiting triage', value: n('awaiting'), sub: 'not triaged yet', bySeverity: sev('awaiting') },
    { key: 'confirmed', label: 'Confirmed', value: n('confirmed'), sub: 'real, fix pending', bySeverity: sev('confirmed') },
    { key: 'closed', label: 'Closed', value: n('notExploitable') + n('resolved'), sub: `${n('notExploitable').toLocaleString()} not exploitable · ${n('resolved').toLocaleString()} no longer detected`, bySeverity: sev('notExploitable', 'resolved') },
  ];
  const ringHelp = helpTip(RP_DEFINE.tracked);
  box.hidden = false;
  box.innerHTML = `<div class="flow-source" style="--pct: ${pct}">
      ${sunflower(parts)}
      <div class="flow-source-text">
        <span class="flow-big">${baseline.toLocaleString()}</span>
        <span class="flow-label">Findings tracked${ringHelp.button}</span>
        <span class="flow-sub">${pct}% actioned</span>
      </div>
    </div>
    <ol class="flow-outcomes">${parts
      .map((p) => {
        const help = helpTip(RP_DEFINE[p.key]);
        return `<li class="flow-outcome flow-${p.key}">
          <svg class="seed-key" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6" /></svg>
          <span class="flow-num">${p.value.toLocaleString()}</span>
          <span class="flow-what"><span class="flow-label">${escapeHtml(p.label)}${help.button}</span><span class="flow-sub">${p.sub}</span>${help.text}</span>
        </li>`;
      })
      .join('')}
      <li class="seed-legend">Each seed is one finding; the bigger it is, the more severe.</li></ol>
    ${ringHelp.text}`;
}

function renderPortfolio(reports, portfolio = {}) {
  renderFlow(reports);
  const measured = reports.filter((r) => r.latest);
  const sum = (fn) => measured.reduce((n, r) => n + (fn(r) || 0), 0);
  const baseline = sum((r) => r.latest.baseline);
  const actioned = sum((r) => r.latest.actioned);
  const pct = baseline ? Math.round((actioned / baseline) * 100) : 0;
  const scheduled = reports.filter((r) => r.automation?.enabled);
  const next = scheduled.map((r) => r.automation.nextRunAt).filter(Boolean).sort()[0];
  const tile = (key, label, value, sub, extra = '') => {
    const help = helpTip(RP_DEFINE[key]);
    return `<div class="rp-tile rp-${key}"><span class="rp-tile-label">${escapeHtml(label)}${help.button}</span><span class="rp-tile-value">${value}</span>${extra}<span class="rp-tile-sub">${sub}</span>${help.text}</div>`;
  };
  const n = (key) => sum((r) => r.latest.outcomes?.[key]);
  // Credits counted once per project (from the server); an older server: each report's own figure.
  const credits = portfolio.aiActions ?? { triage: sum((r) => r.latest.aiActions?.triage), remediation: sum((r) => r.latest.aiActions?.remediation) };
  const pending = reports.length - measured.length;
  $('rp-portfolio').innerHTML = !reports.length
    ? ''
    : [
        // The first four add up: tracked = awaiting triage + confirmed + closed.
        tile('tracked', 'Findings tracked', baseline.toLocaleString(), `${pct}% actioned · in ${measured.length} report${measured.length === 1 ? '' : 's'}${pending ? ` (${pending} not measured yet)` : ''}`, `<span class="rp-meter" role="img" aria-label="${pct}% actioned"><span style="width:${pct}%"></span></span>`),
        tile('awaiting', 'Awaiting triage', n('awaiting').toLocaleString(), 'not triaged yet'),
        tile('confirmed', 'Confirmed', n('confirmed').toLocaleString(), 'real, fix pending'),
        tile('closed', 'Closed', (n('notExploitable') + n('resolved')).toLocaleString(), `${n('notExploitable').toLocaleString()} not exploitable · ${n('resolved').toLocaleString()} no longer detected`),
        tile('fresh', 'New since saved', sum((r) => r.latest.newFindings).toLocaleString(), 'first found after saving'),
        tile('followups', 'Follow-ups scheduled', `${scheduled.length}<small> of ${reports.length}</small>`, next ? `next ${escapeHtml(serverTime(next))}` : 'none due'),
        tile('credits', 'AI credits used', `${(credits.triage ?? 0).toLocaleString()}<small> / ${(credits.remediation ?? 0).toLocaleString()}</small>`, 'triage / remediation'),
      ].join('');
}

function renderUpcoming(reports) {
  const due = reports
    .filter((r) => r.automation?.enabled && r.automation.nextRunAt)
    .sort((a, b) => Date.parse(a.automation.nextRunAt) - Date.parse(b.automation.nextRunAt));
  const to = (a) => (a.onlyTo?.length ? `only ${a.onlyTo.join(', ')}` : { developers: 'each developer', list: 'the fixed list', both: 'developers and list' }[a.sendTo] ?? AUDIENCE_TEXT[audience()].toLowerCase());
  $('rp-upcoming').innerHTML = due.length
    ? due
        .map((r) => {
          const at = new Date(r.automation.nextRunAt);
          const day = at.toLocaleDateString(undefined, { day: 'numeric', ...(serverZone.name ? { timeZone: serverZone.name } : {}) });
          const month = at.toLocaleDateString(undefined, { month: 'short', ...(serverZone.name ? { timeZone: serverZone.name } : {}) });
          return `<li><button type="button" class="rp-agenda-item" data-open-report="${escapeHtml(r.id)}" data-tab="remind">
            <span class="rp-date"><b>${escapeHtml(day)}</b>${escapeHtml(month)}</span>
            <span class="rp-agenda-text"><span class="rp-name">${escapeHtml(r.name)}</span>
              <span class="rp-sub">${escapeHtml(relativeTime(r.automation.nextRunAt))} · ${escapeHtml(scheduleText(r.automation, { short: true }).toLowerCase())} · to ${escapeHtml(to(r.automation))}${r.automation.attachHtml ? ' · HTML report' : ''}</span></span>
          </button></li>`;
        })
        .join('')
    : `<li class="rp-empty-small">Nothing scheduled. Open a report, then <strong>Remind → Automatic follow-up</strong>, to send its follow-ups by themselves.</li>`;
}

function renderReportList() {
  const reports = rpState.data?.reports ?? [];
  const counts = { all: reports.length, attention: 0, scheduled: 0, complete: 0 };
  for (const r of reports) {
    const key = reportStatus(r).key;
    if (key in counts && key !== 'all') counts[key] += 1;
  }
  for (const [key, n] of Object.entries(counts)) {
    const el = document.querySelector(`[data-count="${key}"]`);
    if (el) el.textContent = n;
  }
  if (!reports.length) {
    $('reports-list').innerHTML = `<div class="rp-empty">
      <h3>No tracked reports yet</h3>
      <p>Choose a scope on the Workbench (projects, people, time windows), fetch, then <strong>Save as tracked report</strong>.
        Each report keeps the findings it covered and follows what happens to them: triaged, confirmed, not exploitable or no longer detected.</p>
      <a class="button primary" href="#/dashboard">Go to the Workbench</a></div>`;
    return;
  }
  const term = rpState.search.trim().toLowerCase();
  const shown = reports
    .filter((r) => rpState.filter === 'all' || reportStatus(r).key === rpState.filter)
    .filter((r) => !term || `${r.name} ${r.scopeLabel ?? ''}`.toLowerCase().includes(term))
    .sort((a, b) => {
      if (rpState.sort === 'name') return a.name.localeCompare(b.name);
      if (rpState.sort === 'updated') return Date.parse(b.latest?.at ?? 0) - Date.parse(a.latest?.at ?? 0);
      if (rpState.sort === 'progress') return (a.latest?.percentActioned ?? 0) - (b.latest?.percentActioned ?? 0);
      return (b.latest?.open ?? 0) - (a.latest?.open ?? 0);
    });
  $('reports-list').innerHTML = shown.length
    ? `<div class="rp-head" aria-hidden="true"><span>Report</span><span>Progress</span><span class="num" title="${escapeHtml(RP_DEFINE.open)}">Open</span><span class="num" title="${escapeHtml(RP_DEFINE.fresh)}">New</span><span>Trend</span><span>Status</span></div>${shown
        .map((r) => {
          const l = r.latest;
          const status = reportStatus(r);
          const projects = r.projects?.length ?? l?.byProject?.length ?? 0;
          return `<button type="button" class="rp-row${rpState.open === r.id ? ' active' : ''}" data-open-report="${escapeHtml(r.id)}">
            <span class="rp-cell rp-title"><span class="rp-name">${escapeHtml(r.name)}</span>
              <span class="rp-sub">${projects ? `${projects} project${projects === 1 ? '' : 's'} · ` : ''}${l ? `updated ${escapeHtml(relativeTime(l.at))}` : 'not measured yet'}</span></span>
            <span class="rp-cell rp-progress">${l ? progressBar(l.outcomes, l.baseline, { legend: false }) : ''}<span class="rp-pct">${l ? `${l.percentActioned}% actioned` : '—'}</span></span>
            <span class="rp-cell num" data-label="Open"><b>${l?.open ?? '—'}</b></span>
            <span class="rp-cell num" data-label="New"><b class="${l?.newFindings ? 'up' : ''}">${l ? (l.newFindings ? `+${l.newFindings}` : '0') : '—'}</b></span>
            <span class="rp-cell rp-trend">${sparkline(openSeries(r))}</span>
            <span class="rp-cell rp-status">${statusChip(status)}<span class="rp-sched${r.automation?.enabled ? ' on' : ''}">${escapeHtml(scheduleText(r.automation, { short: true }))}</span></span>
          </button>`;
        })
        .join('')}`
    : '<p class="rp-empty-small">No report matches. Clear the search or pick another filter.</p>';
}

/** Open findings over the readings, with a crosshair and the values on hover. */
function trendChart(points) {
  if (points.length < 2) return '<p class="hint">The trend appears after the second reading (hourly, or Refresh).</p>';
  const w = 640;
  const h = 170;
  const pad = { l: 8, r: 8, t: 12, b: 8 };
  const max = Math.max(1, ...points.map((p) => p.open));
  const x = (i) => pad.l + (i / (points.length - 1)) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / max) * (h - pad.t - pad.b);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.open).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${h - pad.b} L${x(0).toFixed(1)},${h - pad.b} Z`;
  const fmt = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `<figure class="rp-trend-chart" data-points='${escapeHtml(JSON.stringify(points.map((p, i) => ({ x: x(i) / w, y: y(p.open) / h, open: p.open, at: fmt(p.at) }))))}'>
    <figcaption><span>Open findings</span><span class="rp-sub">${points[0].open} → ${points.at(-1).open} over ${points.length} readings</span></figcaption>
    <div class="rp-plot">
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Open findings from ${points[0].open} to ${points.at(-1).open}">
        <line x1="${pad.l}" x2="${w - pad.r}" y1="${y(max)}" y2="${y(max)}" class="grid"/>
        <line x1="${pad.l}" x2="${w - pad.r}" y1="${y(max / 2)}" y2="${y(max / 2)}" class="grid"/>
        <line x1="${pad.l}" x2="${w - pad.r}" y1="${h - pad.b}" y2="${h - pad.b}" class="axis"/>
        <path d="${area}" class="area"/>
        <path d="${line}" class="line" vector-effect="non-scaling-stroke"/>
      </svg>
      <span class="rp-y rp-y-max">${max}</span><span class="rp-y rp-y-mid">${Math.round(max / 2)}</span>
      <span class="rp-cross" hidden></span><span class="rp-dot" hidden></span><span class="rp-tip" hidden></span>
    </div>
    <div class="rp-x"><span>${escapeHtml(fmt(points[0].at))}</span><span>${escapeHtml(fmt(points.at(-1).at))}</span></div>
  </figure>`;
}

function bindTrendChart(root) {
  const fig = root.querySelector('.rp-trend-chart');
  if (!fig) return;
  const points = JSON.parse(fig.dataset.points);
  const plot = fig.querySelector('.rp-plot');
  const [cross, dot, tip] = ['.rp-cross', '.rp-dot', '.rp-tip'].map((sel) => plot.querySelector(sel));
  const show = (clientX) => {
    const box = plot.getBoundingClientRect();
    const rel = (clientX - box.left) / box.width;
    const p = points.reduce((best, q) => (Math.abs(q.x - rel) < Math.abs(best.x - rel) ? q : best), points[0]);
    for (const el of [cross, dot, tip]) el.hidden = false;
    cross.style.left = `${p.x * 100}%`;
    dot.style.left = `${p.x * 100}%`;
    dot.style.top = `${p.y * 100}%`;
    tip.innerHTML = `<b>${p.open}</b> open<br><span>${escapeHtml(p.at)}</span>`;
    tip.style.left = `${Math.min(Math.max(p.x * 100, 12), 88)}%`;
  };
  plot.addEventListener('pointermove', (event) => show(event.clientX));
  plot.addEventListener('pointerleave', () => {
    for (const el of [cross, dot, tip]) el.hidden = true;
  });
}

const RP_TABS = [
  ['overview', 'Overview'],
  ['remind', 'Remind'],
  ['triage', 'Triage'],
  ['verify', 'Verify'],
  ['history', 'History'],
];

function openReportDetail(id, tab = 'overview') {
  rpState.open = id;
  // Schedule is part of Remind now (one place for who, what and when).
  rpState.tab = tab === 'schedule' ? 'remind' : tab;
  $('rp-sheet').innerHTML = '';
  renderReportDetail(id);
  $('rp-drawer').hidden = false;
  document.body.classList.add('rp-locked');
  renderReportList();
  $('rp-sheet').querySelector('.rp-tabs [aria-selected="true"]')?.focus();
}

function closeReportDetail() {
  const id = rpState.open;
  rpState.open = '';
  $('rp-drawer').hidden = true;
  document.body.classList.remove('rp-locked');
  renderReportList();
  document.querySelector(`.rp-row[data-open-report="${CSS.escape(id)}"]`)?.focus();
}

function renderReportDetail(id) {
  const r = trackedById.get(id);
  if (!r) return;
  const kept = captureReportsState();
  const sheet = $('rp-sheet');
  const scroll = sheet.querySelector('.rp-body')?.scrollTop ?? 0;
  const l = r.latest;
  const status = reportStatus(r);
  const rid = escapeHtml(r.id);
  const tabs = RP_TABS.map(([key, label]) => `<button type="button" role="tab" id="rp-tab-${key}" aria-controls="rp-panel-${key}" aria-selected="${rpState.tab === key}" tabindex="${rpState.tab === key ? 0 : -1}" data-rp-tab="${key}">${label}${(key === 'remind' && r.automation?.enabled) || (key === 'verify' && r.verify?.auto) ? ' <i class="rp-on" aria-label="on"></i>' : ''}${key === 'verify' && r.verification?.result?.zero ? ' ✓' : ''}</button>`).join('');
  const panel = (key, html) => `<div class="rp-panel" role="tabpanel" id="rp-panel-${key}" aria-labelledby="rp-tab-${key}" ${rpState.tab === key ? '' : 'hidden'}>${html}</div>`;
  const kpi = (label, value, sub = '', define = '') => {
    const help = define ? helpTip(define) : { button: '', text: '' };
    return `<div class="rp-kpi"><span class="rp-tile-label">${escapeHtml(label)}${help.button}</span><span class="rp-kpi-value">${value}</span>${sub ? `<span class="rp-tile-sub">${sub}</span>` : ''}${help.text}</div>`;
  };
  const heroHelp = helpTip(RP_DEFINE.hero);
  const overview = l
    ? `<div class="rp-hero">
        <div class="rp-hero-number"><span class="rp-big">${l.percentActioned}%</span><span class="rp-sub">actioned · ${l.actioned} of ${l.baseline} findings confirmed, not exploitable or no longer detected ${heroHelp.button}</span></div>
        ${heroHelp.text}
        ${progressBar(l.outcomes, l.baseline)}
      </div>
      <div class="rp-kpis">
        ${kpi('Open now', l.open ?? 0, 'awaiting, confirmed or new', RP_DEFINE.open)}
        ${kpi('New since saved', l.newFindings, 'first found after saving', RP_DEFINE.fresh)}
        ${kpi('Matching now', l.currentMatching, `was ${l.baseline} when saved`, 'Every finding the report\'s filters match today, old or new, whatever its state.')}
        ${kpi('AI credits used', `${l.aiActions.triage} <small>/ ${l.aiActions.remediation}</small>`, 'triage / remediation', 'AI Triage / AI Remediation credits spent on this report\'s projects since it was saved.')}
      </div>
      ${trendChart(openSeries(r))}
      ${l.byProject?.length ? `<h3 class="rp-h3">By project</h3><div class="table-wrap"><table class="data-table rp-table">
        <thead><tr><th>Project</th><th>Progress</th><th class="num">Open</th><th class="num">Confirmed</th><th class="num">New</th><th class="num">Now</th></tr></thead>
        <tbody>${l.byProject
          .slice()
          .sort((a, b) => b.awaiting + b.confirmed + (b.newOpen ?? b.newFindings) - (a.awaiting + a.confirmed + (a.newOpen ?? a.newFindings)))
          .map((p) => `<tr><td>${escapeHtml(p.projectName || p.projectId)}</td>
            <td class="rp-mini">${progressBar({ resolved: p.resolved, notExploitable: p.notExploitable, confirmed: p.confirmed, awaiting: p.awaiting }, p.baseline, { legend: false })}</td>
            <td class="num">${p.awaiting + p.confirmed + (p.newOpen ?? p.newFindings)}</td><td class="num">${p.confirmed}</td><td class="num">${p.newFindings}</td><td class="num">${p.currentMatching}</td></tr>`)
          .join('')}</tbody></table></div>` : ''}`
    : '<p class="hint">Not measured yet: Refresh reads Checkmarx One now.</p>';
  const history = r.history?.length
    ? `<div class="table-wrap"><table class="data-table rp-table">
        <thead><tr><th>Reading</th><th class="num">Awaiting</th><th class="num">Confirmed</th><th class="num">Not exploitable</th><th class="num">No longer detected</th><th class="num">New</th><th class="num">Matching now</th></tr></thead>
        <tbody>${r.history
          .slice()
          .reverse()
          .map((h) => `<tr><td>${escapeHtml(new Date(h.at).toLocaleString())}</td><td class="num">${h.awaiting}</td><td class="num">${h.confirmed}</td><td class="num">${h.notExploitable}</td><td class="num">${h.resolved}</td><td class="num">${h.newFindings}</td><td class="num">${h.currentMatching}</td></tr>`)
          .join('')}</tbody></table></div>`
    : '<p class="hint">No readings yet.</p>';
  sheet.innerHTML = `<article class="rp-detail" data-report="${rid}">
    <header class="rp-d-head">
      <div class="rp-d-title">
        <span class="rp-eyebrow">Tracked report ${statusChip(status)}</span>
        <h2 id="rp-d-title">${escapeHtml(r.name)}</h2>
        <p class="rp-sub">${escapeHtml(r.scopeLabel || '')}</p>
        <p class="rp-sub">Saved ${escapeHtml(new Date(r.createdAt).toLocaleDateString())} · ${l ? `updated ${escapeHtml(relativeTime(l.at))}` : 'not updated yet'}${r.lastError ? ` · <span class="status error">last update failed: ${escapeHtml(r.lastError)}</span>` : ''}</p>
      </div>
      <div class="rp-d-actions">
        <button type="button" data-report-refresh="${rid}">Refresh</button>
        <button type="button" data-report-html="${rid}">Download HTML</button>
        ${can('reports.delete') ? `<button type="button" class="link danger" data-report-delete="${rid}">Delete</button>` : ''}
        <button type="button" class="ghost rp-close" data-rp-close aria-label="Close">✕</button>
      </div>
    </header>
    <nav class="rp-tabs" role="tablist" aria-label="Report sections">${tabs}</nav>
    <div class="rp-body">
      ${panel('overview', overview)}
      ${panel('remind', `${remindSection(r)}<h3 class="rp-h3">Automatic follow-up</h3>${scheduleSection(r)}`)}
      ${panel('triage', triageSection(r))}
      ${panel('verify', verifySection(r))}
      ${panel('history', history)}
      <p class="status" data-follow-status="${rid}"></p>
    </div>
  </article>`;
  restoreReportsState(kept);
  const card = sheet.querySelector('[data-report]');
  syncSendTo(card);
  updateNeed(card);
  bindTrendChart(sheet);
  sheet.querySelector('.rp-body').scrollTop = scroll;
}

const radioFor = (id) => (name, value, label, current) =>
  `<label class="check"><input type="radio" name="${name}-${id}" value="${value}" data-keep ${current === value ? 'checked' : ''} /> ${label}</label>`;

/** Who gets a reminder, and what: used by "Send now" and by the schedule. */
function remindSection(r) {
  const id = escapeHtml(r.id);
  const auto = r.automation ?? {};
  const radio = radioFor(id);
  const onlyTo = auto.onlyTo?.length ? auto.onlyTo.join(', ') : '';
  // 'initiator' was the default every report was saved with: it follows the shared choice too.
  const sendTo = onlyTo ? 'only' : ({ initiator: 'settings', settings: 'settings' }[auto.sendTo] ?? auto.sendTo ?? 'settings');
  const own = sendTo !== 'settings';
  const open = r.latest?.open ?? 0;
  const reminders = (r.reminders ?? []).slice(0, 10);
  return `<p class="rp-lead">${open} open finding${open === 1 ? '' : 's'} (awaiting triage, confirmed or new). Remind the people who can act on them.</p>
    <div class="rp-form">
      <div class="rp-field"><span class="rp-label">Send to</span><div class="rp-options">
        ${radio('sendTo', 'settings', `Who gets reminders everywhere: ${escapeHtml(AUDIENCE_TEXT[audience()].toLowerCase())}`, sendTo)}
        <details class="rp-own"${own ? ' open' : ''}><summary>Only for this report…</summary>
          ${radio('sendTo', 'developers', 'Each developer', sendTo)}
          ${radio('sendTo', 'list', 'The fixed list', sendTo)}
          ${radio('sendTo', 'both', 'Both', sendTo)}
          ${radio('sendTo', 'only', 'Only to', sendTo)}
          <input type="text" class="only-to" data-field="onlyTo" data-keep value="${escapeHtml(onlyTo)}" placeholder="name@company.com, …" aria-label="Send only to these addresses" />
        </details>
      </div></div>
      <div class="rp-field" data-content-row><span class="rp-label">Content</span><div class="rp-options">
        ${radio('content', 'summary', 'One summary per person', auto.emailContent ?? 'summary')}
        ${radio('content', 'per-project', 'One email per project', auto.emailContent)}
      </div></div>
      <div class="rp-field"><span class="rp-label">Attachment</span><div class="rp-options">
        <label class="check"><input type="checkbox" data-field="attachHtml" data-keep ${auto.attachHtml ? 'checked' : ''} /> Interactive HTML report (triage and remediate from it)</label>
      </div></div>
    </div>
    <div class="actions compact">
      ${can('reports.remind') ? `<button type="button" data-remind="${id}" data-dry="1">Preview</button><button type="button" data-remind="${id}" class="primary">Send reminder now</button>` : '<span class="hint">Your role cannot send reminders.</span>'}
    </div>
    <p class="hint">The automatic follow-up below uses the same choices.</p>
    ${reminders.length ? `<h3 class="rp-h3">Sent</h3>${remindersTable(reminders)}` : ''}`;
}

function remindersTable(reminders) {
  return `<div class="table-wrap"><table class="data-table rp-table">
    <thead><tr><th>Sent</th><th>To</th><th class="num">Open</th><th class="num">Emails</th><th>Result</th></tr></thead>
    <tbody>${reminders
      .map((m) => `<tr><td>${escapeHtml(new Date(m.at).toLocaleString())}${m.automatic ? ' <span class="rp-tag">automatic</span>' : ''}</td>
        <td>${m.sendTo === 'only' ? `Only ${escapeHtml((m.onlyTo ?? []).join(', '))}` : escapeHtml({ initiator: 'Each developer', list: 'Fixed list', both: 'Developers + list' }[m.sendTo] ?? m.sendTo)}${m.attachHtml ? ' · HTML' : ''}</td>
        <td class="num">${m.openFindings}</td><td class="num">${m.sent}</td>
        <td>${m.error ? `<span class="status error">${escapeHtml(m.error)}</span>` : 'Sent'}</td></tr>`)
      .join('')}</tbody></table></div>`;
}

function scheduleSection(r) {
  const id = escapeHtml(r.id);
  const auto = r.automation ?? {};
  const manage = can('reports.manage');
  const reminders = (r.reminders ?? []).filter((m) => m.automatic).slice(0, 10);
  return `<div class="rp-schedule-state ${auto.enabled ? 'on' : ''}">
      <span class="rp-big-icon" aria-hidden="true">${auto.enabled ? '⟳' : '○'}</span>
      <div><strong>${escapeHtml(scheduleText(auto))}${auto.enabled ? ` ${escapeHtml(zoneLabel())}` : ''}</strong>
        <span class="rp-sub">${auto.enabled && auto.nextRunAt ? `Next ${escapeHtml(serverTime(auto.nextRunAt))} (${escapeHtml(relativeTime(auto.nextRunAt))})` : 'Turn it on to follow up without anyone remembering to.'}${auto.lastRunAt ? ` · last ${escapeHtml(serverTime(auto.lastRunAt))}` : ''}</span>
        ${auto.lastError ? `<span class="status error">${escapeHtml(auto.lastError)}</span>` : ''}</div>
    </div>
    <div class="rp-form"${manage ? '' : ' hidden'}>
      <div class="rp-field"><span class="rp-label">Automatic reminders</span><div class="rp-options">
        <label class="switch"><input type="checkbox" data-field="autoEnabled" data-keep ${auto.enabled ? 'checked' : ''} /> <span><strong>On</strong><small>Only while something is still open</small></span></label>
      </div></div>
      <div class="rp-field"><span class="rp-label">Every</span><div class="rp-options">
        <input type="number" min="1" max="90" data-field="everyDays" data-keep value="${auto.everyDays ?? 7}" class="small-num" aria-label="Every how many days" /> days at
        <input type="number" min="0" max="23" data-field="hour" data-keep value="${auto.hour ?? 9}" class="small-num" aria-label="Hour" />:00
        <span class="hint" title="Time zone of the machine running ${escapeHtml(state.health?.app?.name || 'CxMissionZero')}">${escapeHtml(zoneLabel())}</span>
      </div></div>
    </div>
    <p class="hint">Sends to the people, and with the content, chosen above. Every automatic reminder and follow-up is also listed under <a href="#/automation">Act → Automation</a>.</p>
    ${manage ? `<div class="actions compact"><button type="button" class="primary" data-schedule="${id}">Save schedule</button></div>` : '<p class="hint">Your role cannot change schedules.</p>'}
    ${reminders.length ? `<h3 class="rp-h3">Sent automatically</h3>${remindersTable(reminders)}` : ''}`;
}

/** Each tracked report's credit tiers, for triage and remediation (credits by severity). */
function reportTiers(r) {
  const triageBy = Object.fromEntries(SEVERITIES_ALL.map((s) => [s, r.latest?.toTriageResults?.[s] ?? r.latest?.toTriage?.[s] ?? 0]));
  const remediationBy = Object.fromEntries(SEVERITIES_ALL.map((s) => [s, 3 * (r.latest?.toRemediate?.[s] ?? 0)]));
  return {
    triage: creditTiers(triageBy, r.credits?.triage?.remaining ?? 0),
    remediation: creditTiers(remediationBy, r.credits?.remediation?.remaining ?? 0),
  };
}

/**
 * One row per kind of credit: what is needed and left, then "Allocate for <next tier>" and
 * "<Triage|Remediate> <widest tier the credits cover>", gold. One button each, chosen from
 * the findings' severities and the credits given, so the next step is always plain.
 */
function creditLane(id, kind, t, { allocate, run }, prefix = 'report') {
  const verb = kind === 'triage' ? 'Triage' : 'Remediate';
  const title = kind === 'triage' ? 'AI Triage' : 'AI Remediation';
  const unit = kind === 'triage' ? 'to triage' : 'to remediate';
  const figures = t.total
    ? `<span><b>${fmt(t.total)}</b> credits needed ${unit}</span> · <span><b>${fmt(t.left)}</b> left</span>`
    : `<span>${kind === 'triage' ? 'Nothing awaiting triage.' : 'Nothing confirmed to remediate yet: AI Triage confirms findings first.'}</span>`;
  const sev = (tier) => escapeHtml(tier.severities.join(','));
  const give = allocate && t.next
    ? `<button type="button" data-${prefix}-allocate="${id}" data-kind="${kind}" data-severities="${sev(t.next)}" data-needs-data title="${escapeHtml(`About ${fmt(t.next.need - t.left)} more credits, confirmed with Checkmarx One as they are given`)}">Allocate for ${t.next.name}</button>`
    : '<span class="lane-slot"></span>';
  const act = !run || !t.total
    ? '<span class="lane-slot"></span>'
    : t.covered
      ? `<button type="button" data-${prefix}-${kind === 'triage' ? 'triage' : 'remediate'}="${id}" data-severities="${sev(t.covered)}" class="primary is-golden" data-needs-data>${verb} ${t.covered.name}</button>`
      : `<button type="button" class="primary" disabled title="Allocate credits first">${verb} ${t.next.name}</button>`;
  return `<div class="credit-lane" data-lane="${kind}">
      <div class="lane-head"><strong>${title}</strong><span class="lane-figures">${figures}</span></div>
      <div class="lane-actions">${give}${act}</div>
    </div>`;
}

/** Per severity: what awaits triage and what is confirmed to remediate, behind the rows' tiers. */
function severityBreakdown(r) {
  const line = (label, by) => {
    // Each piece in its own span, so each is translated on its own.
    const parts = SEVERITIES_ALL.filter((s) => by?.[s]).map((s) => `<span>${SEV_NAMES[s]} ${fmt(by[s])}</span>`);
    return parts.length ? `<span>${label}:</span> ${parts.join(' · ')}` : '';
  };
  const triage = Object.fromEntries(SEVERITIES_ALL.map((s) => [s, r.latest?.toTriageResults?.[s] ?? r.latest?.toTriage?.[s] ?? 0]));
  return [line('Results awaiting triage', triage), line('Confirmed to remediate', r.latest?.toRemediate)].filter(Boolean).join('<br />');
}

function triageSection(r) {
  const id = escapeHtml(r.id);
  const allowed = can('triage.run') || can('credits.allocate');
  if (!allowed) return '<p class="hint">Your role cannot run AI Triage or allocate credits.</p>';
  const tiers = reportTiers(r);
  const ways = { allocate: can('credits.allocate'), run: can('triage.run') };
  return `<p class="rp-lead">Each row offers one step: allocate the credits for the next severities, then run AI on everything the credits cover, critical first. The button turns gold when the credits are there.</p>
    <div class="credit-lanes" data-lanes="${id}">${creditLane(id, 'triage', tiers.triage, ways)}${creditLane(id, 'remediation', tiers.remediation, ways)}</div>
    <p class="rp-need" data-need="${id}">${severityBreakdown(r)}</p>
    ${ways.allocate ? `<details class="disclosure alloc-more"><summary>Extra credits</summary>
      <div class="rp-options alloc-extra">
        <label class="inline">Triage <input type="number" min="0" max="100000" data-field="triageAdd" data-keep class="small-num" placeholder="0" aria-label="Extra triage credits" /></label>
        <label class="inline">Remediation <input type="number" min="0" max="100000" step="3" data-field="remediationAdd" data-keep class="small-num" placeholder="0" aria-label="Extra remediation credits" /></label>
        <button type="button" data-report-allocate="${id}" data-kind="extra" data-needs-data>Add extra credits</button>
      </div></details>` : ''}
    <p class="hint">1 credit to check a finding with AI, 3 to fix it. Nothing is given until you click.</p>`;
}

const SEV_NAMES = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };
const sevList = (list) => (list?.length ? list.map((s) => SEV_NAMES[s] ?? s).join(', ') : 'every severity');
const VERIFY_STATUS = {
  Queued: ['Queued in Checkmarx One', 'info'],
  Running: ['Scanning…', 'info'],
  Completed: ['Scanned', 'good'],
  Partial: ['Scanned (partly)', 'warning'],
  Failed: ['Scan failed', 'critical'],
  Canceled: ['Scan cancelled', 'critical'],
  waiting: ['Waiting for its next scan', 'neutral'],
};

/** Verify: prove the round's fixes with a Checkmarx One rescan, then start the next round. */
function verifySection(r) {
  const id = escapeHtml(r.id);
  const round = r.round ?? 1;
  const c = r.latest?.closure;
  const v = r.verification;
  const manage = can('reports.manage');
  const scanning = v && !v.finishedAt && v.projects.some((p) => p.status !== 'waiting' && !['Completed', 'Partial', 'Failed', 'Canceled'].includes(p.status));
  const closure = c
    ? `<div class="vf-closure ${c.closed ? 'is-closed' : ''}">
        <span class="vf-badge">${c.closed ? '✓ Ready to verify' : `${c.open} still open`}</span>
        <span title="${escapeHtml(`${c.gone} no longer found, ${c.notExploitable} not exploitable, ${c.remediated} sent for an AI fix${c.open ? `; still open: ${c.awaiting} not checked yet, ${c.confirmedNotRemediated} confirmed but not fixed` : ''}`)}">${c.inScope - c.open} of ${c.inScope} dealt with${c.open ? `: ${c.awaiting ? `${c.awaiting} to check` : ''}${c.awaiting && c.confirmedNotRemediated ? ', ' : ''}${c.confirmedNotRemediated ? `${c.confirmedNotRemediated} to fix` : ''}` : ''}.</span>
      </div>`
    : '<p class="hint">Refresh to see where this round stands.</p>';
  // The developers' turn to rescan (the round's scope is closed, nobody rescanned yet).
  const w = r.verifyWindow && r.verifyWindow.round === round ? r.verifyWindow : null;
  const windowHtml = w && !(v && v.round === round)
    ? `<div class="vf-window">
        <span class="vf-badge">⟳ Developers' turn</span>
        <span>${w.developers?.length ? `${escapeHtml(w.developers.map((d) => d.name || d.email).join(', '))} ${w.developers.length === 1 ? 'has' : 'have'}` : 'The developers have'} until <b>${escapeHtml(new Date(w.dueAt).toLocaleString())}</b> to rescan from their report or the emailed link${r.verify?.auto ? '. After that it is rescanned on their behalf, and they are told.' : '. Automatic rescan is off: after that, rescan here.'}${w.notified?.ready ? '' : ' Email is not set up, so they were not told: send them their links.'}</span>
        ${can('reports.manage') ? `<button type="button" class="link" data-rescan-links="${id}">Their rescan links</button>` : ''}
        <div class="vf-links" data-rescan-links-out="${id}" hidden></div>
      </div>`
    : '';
  const result = v?.result;
  const tile = (label, value, sub, tone = '') => `<div class="rp-kpi ${tone}"><span class="rp-tile-label">${escapeHtml(label)}</span><span class="rp-kpi-value">${value}</span><span class="rp-tile-sub">${escapeHtml(sub)}</span></div>`;
  const resultHtml = result
    ? `${result.zero ? `<p class="vf-zero">✓ Mission Zero for this scope: everything in round ${v.round} is verified fixed by a rescan.</p>` : ''}
      <div class="rp-kpis">
        ${tile('Verified fixed', result.fixed, 'gone after the rescan', 'tone-good')}
        ${tile('Still found', result.stillFound.length, result.ineffective ? `${result.ineffective} after AI Remediation: the fix did not work` : 'still reported by Checkmarx One', result.stillFound.length ? 'tone-critical' : '')}
        ${tile('Accepted', result.accepted, 'triaged not exploitable')}
        ${tile('New in scope', result.newInScope, 'found since the round started', result.newInScope ? 'tone-warning' : '')}
      </div>
      ${result.notChecked ? `<p class="hint">${result.notChecked} finding(s) in projects still waiting for a scan are not checked yet.</p>` : ''}
      ${result.stillFound.length ? `<details class="vf-still"><summary>Still found (${result.stillFound.length})</summary><ul>${result.stillFound
        .slice(0, 50)
        .map((f) => `<li><b>${escapeHtml(SEV_NAMES[f.severity] ?? f.severity)}</b> ${escapeHtml(f.title)} <span class="hint">· ${escapeHtml(f.projectName)}${f.remediated ? ' · remediated, still found' : ''}</span></li>`)
        .join('')}</ul></details>` : ''}`
    : '';
  const scans = v
    ? `<h3 class="rp-h3">Verification ${v.automatic ? '(started automatically)' : ''} · ${escapeHtml(new Date(v.requestedAt).toLocaleString())}</h3>
      <div class="table-wrap"><table class="data-table rp-table"><thead><tr><th>Project</th><th>Rescan</th><th>Branch</th></tr></thead><tbody>${v.projects
        .map((p) => {
          const [label, tone] = VERIFY_STATUS[p.status] ?? [p.status, 'neutral'];
          return `<tr><td>${escapeHtml(p.projectName || p.projectId)}</td><td><span class="rp-chip tone-${tone}">${escapeHtml(label)}</span>${p.fromElsewhere ? ' <span class="hint">(a scan from elsewhere)</span>' : ''}${p.error ? `<div class="hint vf-why">${escapeHtml(p.error)}</div>` : ''}</td><td>${escapeHtml(p.branch ?? '')}</td></tr>`;
        })
        .join('')}</tbody></table></div>
      ${resultHtml}`
    : '';
  const nextSevs = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].filter((s) => !(r.filters?.severities ?? []).includes(s));
  const controls = manage
    ? `<div class="actions compact">
        <button type="button" class="${c?.closed && !scanning ? 'primary' : ''}" data-report-verify="${id}" ${scanning ? 'disabled' : ''}>${scanning ? 'Rescanning…' : 'Rescan now to verify'}</button>
        <label class="check"><input type="checkbox" data-verify-auto="${id}" ${r.verify?.auto ? 'checked' : ''} /> If the developers have not rescanned within</label>
        <label class="inline"><input type="number" class="small-num" min="24" max="336" step="12" data-verify-grace="${id}" value="${escapeHtml(String(r.verify?.graceHours ?? 48))}" /> hours, rescan on their behalf</label>
      </div>
      <p class="hint">When everything is dealt with, the developers get the Rescan button first. If they don't use it in time, it is rescanned for them.</p>
      <details class="disclosure" data-advanced><summary>How the rescan works</summary><p class="hint">Each project is scanned again like its last scan: same repository, branch and engines. Code uploaded from a pipeline is checked by its next scan instead. A fix made outside CxMissionZero counts once the rescan no longer finds it.</p></details>`
    : '<p class="hint">Your role can follow verification; rescans and new rounds need “Manage tracked reports”.</p>';
  const nextRound = manage
    ? `<h3 class="rp-h3">Next round</h3>
      <p class="hint">Next target, for example medium and low once critical and high are at zero. This round is kept below.</p>
      <div class="rp-options">${['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
        .map((s) => `<label class="check"><input type="checkbox" data-next-sev="${s}" data-field="next-${s}" data-keep ${nextSevs.includes(s) ? 'checked' : ''} /> ${SEV_NAMES[s]}</label>`)
        .join('')}</div>
      <div class="actions compact"><button type="button" data-next-round="${id}" ${scanning ? 'disabled' : ''}>Start round ${round + 1}</button></div>`
    : '';
  const rounds = r.rounds?.length
    ? `<h3 class="rp-h3">Earlier rounds</h3><div class="table-wrap"><table class="data-table rp-table"><thead><tr><th>Round</th><th>Scope</th><th class="num">In scope</th><th class="num">Verified fixed</th><th class="num">Still found</th><th>Result</th></tr></thead><tbody>${r.rounds
        .slice()
        .reverse()
        .map((x) => {
          const res = x.verification?.result;
          return `<tr><td>${x.round}</td><td>${escapeHtml(sevList(x.severities))}</td><td class="num">${x.baseline}</td><td class="num">${res ? res.fixed : '—'}</td><td class="num">${res ? res.stillFound.length : '—'}</td><td>${res?.zero ? '<span class="rp-chip tone-good">✓ At zero</span>' : res ? 'Verified' : 'Not verified'}</td></tr>`;
        })
        .join('')}</tbody></table></div>`
    : '';
  return `<p class="rp-lead">Round ${round} · ${escapeHtml(sevList(r.filters?.severities))} · ${r.baselineCount} finding${r.baselineCount === 1 ? '' : 's'} in scope. Prove the fixes: once everything is dealt with, a rescan in Checkmarx One shows what is really fixed.</p>
    ${closure}${windowHtml}
    ${controls}
    ${scans}
    ${nextRound}
    ${rounds}`;
}

/** Rescan, automatic verification and next round, from the Verify tab. */
async function verifyAction(event) {
  const verify = event.target.closest('[data-report-verify]');
  const next = event.target.closest('[data-next-round]');
  if (!verify && !next) return false;
  const button = verify || next;
  const id = verify ? verify.dataset.reportVerify : next.dataset.nextRound;
  const card = button.closest('[data-report]');
  button.disabled = true;
  try {
    if (verify) {
      const c = trackedById.get(id)?.latest?.closure;
      if (c && !c.closed && !confirm(`${c.open} finding(s) in this round are still open. Rescan anyway? Checkmarx One scans each project again (this uses scans, not AI credits).`)) return true;
      followStatus(id, 'Asking Checkmarx One to rescan…');
      const report = await api(`/api/tracked-reports/${encodeURIComponent(id)}/verify`, { method: 'POST', body: '{}' });
      trackedById.set(id, report);
      const started = report.verification.projects.filter((p) => p.scanId).length;
      followStatus(id, `${started} rescan(s) started${report.verification.projects.length > started ? `; ${report.verification.projects.length - started} project(s) wait for their next scan` : ''}. Results appear here when the scans finish.`, 'ok');
    } else {
      const severities = [...card.querySelectorAll('[data-next-sev]:checked')].map((x) => x.dataset.nextSev);
      if (!severities.length) return followStatus(id, 'Choose the severities for the next round.', 'error'), true;
      if (!confirm(`Start the next round with ${sevList(severities).toLowerCase()} findings, on what Checkmarx One reports now? This round is kept in the report.`)) return true;
      followStatus(id, 'Reading Checkmarx One for the new round…');
      const report = await api(`/api/tracked-reports/${encodeURIComponent(id)}/next-round`, { method: 'POST', body: JSON.stringify({ severities }) });
      trackedById.set(id, report);
      followStatus(id, `Round ${report.round} started: ${report.baselineCount} finding(s) in scope.`, 'ok');
    }
    renderReportDetail(id);
  } catch (error) {
    if (!handleAuthLoss(error)) followStatus(id, error.message, 'error');
  } finally {
    button.disabled = false;
  }
  return true;
}

/** The automatic-verification switch. */
async function verifyAutoChange(event) {
  const box = event.target.closest('[data-verify-auto]');
  if (!box) return;
  const id = box.dataset.verifyAuto;
  try {
    const report = await api(`/api/tracked-reports/${encodeURIComponent(id)}/verify-settings`, { method: 'PUT', body: JSON.stringify({ auto: box.checked }) });
    trackedById.set(id, report);
    followStatus(id, box.checked ? `On: if the developers have not rescanned within ${report.verify?.graceHours ?? 48} hours, it is rescanned on their behalf.` : 'Off: after the developers\' turn, rescan by hand.', 'ok');
  } catch (error) {
    box.checked = !box.checked;
    if (!handleAuthLoss(error)) followStatus(id, error.message, 'error');
  }
}

/** Each developer's own rescan link, to send by hand. */
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-rescan-links]');
  if (!button) return;
  const id = button.dataset.rescanLinks;
  const out = document.querySelector(`[data-rescan-links-out="${CSS.escape(id)}"]`);
  try {
    const { links } = await api(`/api/tracked-reports/${encodeURIComponent(id)}/rescan-links`);
    out.innerHTML = links
      .map((l) => `<div class="vf-link"><span><b>${escapeHtml(l.name || l.email)}</b> <span class="hint">${escapeHtml(l.email)} · ${escapeHtml(l.projects.join(', '))}</span></span><button type="button" class="sm" data-copy-link="${escapeHtml(l.link)}">Copy link</button></div>`)
      .join('') || '<p class="hint">No developer with an address: tag their addresses on the Workbench (People).</p>';
    out.hidden = false;
  } catch (error) {
    if (!handleAuthLoss(error)) followStatus(id, error.message, 'error');
  }
});
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy-link]');
  if (!button) return;
  try {
    await navigator.clipboard.writeText(button.dataset.copyLink);
    button.textContent = 'Copied';
  } catch {
    prompt('Copy this link', button.dataset.copyLink);
  }
});

/** How long the developers have to rescan themselves (24 hours to 14 days). */
async function verifyGraceChange(event) {
  const input = event.target.closest('[data-verify-grace]');
  if (!input) return;
  const id = input.dataset.verifyGrace;
  try {
    const report = await api(`/api/tracked-reports/${encodeURIComponent(id)}/verify-settings`, { method: 'PUT', body: JSON.stringify({ graceHours: Number(input.value) }) });
    trackedById.set(id, report);
    input.value = report.verify?.graceHours ?? 48;
    followStatus(id, `Developers have ${report.verify?.graceHours ?? 48} hours to rescan themselves.`, 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) followStatus(id, error.message, 'error');
  }
}

/** A time as the reminder server's clock shows it. */
function serverTime(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, serverZone.name ? { timeZone: serverZone.name, dateStyle: 'medium', timeStyle: 'short' } : undefined);
  } catch {
    return new Date(iso).toLocaleString();
  }
}

/** "Needs N credits · M of A left" for a tracked report's chosen severities, as HTML (numbers and fixed wording only). */
/** The report's rows again, after its numbers or credits changed. */
function updateNeed(card) {
  const report = trackedById.get(card.dataset.report);
  const lanes = card.querySelector('[data-lanes]');
  if (!report || !lanes) return;
  const id = escapeHtml(report.id);
  const tiers = reportTiers(report);
  const ways = { allocate: can('credits.allocate'), run: can('triage.run') };
  lanes.innerHTML = creditLane(id, 'triage', tiers.triage, ways) + creditLane(id, 'remediation', tiers.remediation, ways);
  const breakdown = card.querySelector('[data-need]');
  if (breakdown) breakdown.innerHTML = severityBreakdown(report);
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
  const sendTo = value('sendTo') ?? 'settings';
  return {
    sendTo: sendTo === 'only' ? 'list' : sendTo,
    onlyTo: sendTo === 'only' ? field('onlyTo').value : '',
    emailContent: value('content') ?? 'summary',
    attachHtml: field('attachHtml').checked,
    triageAdd: Number(field('triageAdd')?.value) || 0,
    remediationAdd: Number(field('remediationAdd')?.value) || 0,
    enabled: field('autoEnabled').checked,
    everyDays: Number(field('everyDays').value) || 7,
    hour: Number(field('hour').value) || 0,
  };
}

/** The button last clicked in a report card: its message is shown right under it, where the eye is. */
let followButton = null;

function followStatus(id, text, kind = '') {
  const near = followButton?.isConnected && followButton.closest(`[data-report="${CSS.escape(id)}"]`) ? followButton.closest('.actions') : null;
  // Said once: under the button clicked when it is on screen, else at the foot of the report.
  const el = document.querySelector(`[data-follow-status="${CSS.escape(id)}"]`);
  if (el) {
    el.textContent = near ? '' : text;
    el.className = `status ${kind}`;
  }
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
  const button = event.target.closest('[data-remind], [data-schedule], [data-report-triage], [data-report-remediate], [data-report-html], [data-report-allocate]');
  if (!button) return false;
  const card = button.closest('[data-report]');
  const id = card.dataset.report;
  const options = followUpOptions(card);
  // The smart buttons carry their own severities: the tier the credits cover, or the next to allocate for.
  const severities = (button.dataset.severities || '').split(',').filter(Boolean);
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
      const kind = button.dataset.kind;
      const extra = kind === 'extra';
      if (extra && !options.triageAdd && !options.remediationAdd) return followStatus(id, 'Enter the credits to add.', 'error'), true;
      const question = extra
        ? `Add ${options.triageAdd} triage and ${options.remediationAdd} remediation credit(s) to each of this report's projects, from the credit pool?`
        : kind === 'triage'
          ? "Allocate AI Triage credits from the credit pool to this report's projects: what their findings at the severities on the button need (1 per Checkmarx One result), confirmed with Checkmarx One as they are given?"
          : "Allocate AI Remediation credits from the credit pool to this report's projects: what their confirmed findings at the severities on the button need (3 per confirmed result), confirmed with Checkmarx One as they are given?";
      if (!confirm(question)) return true;
      followStatus(id, 'Allocating…');
      const result = await api(`/api/tracked-reports/${encodeURIComponent(id)}/allocate`, {
        method: 'POST',
        body: JSON.stringify(extra
          ? { severities: [], triageAdd: options.triageAdd, remediationAdd: options.remediationAdd }
          : { severities, kind, triageAdd: 0, remediationAdd: 0 }),
      });
      const { report } = result;
      trackedById.set(id, report);
      for (const name of ['triageAdd', 'remediationAdd']) card.querySelector(`[data-field="${name}"]`).value = '';
      updateNeed(card);
      const c = report.credits;
      followStatus(id, `Allocated. Projects now have ${c.triage.remaining} triage and ${c.remediation.remaining} remediation credit(s) left.${noteGone(result)}`, 'ok');
      creditsChanged();
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
    } else if (button.dataset.reportRemediate) {
      if (!severities.length) return true;
      if (!confirm("Run AI Remediation on this report's confirmed findings at the severities on the button? It uses 3 Checkmarx One credits each.")) return true;
      followStatus(id, 'Starting AI Remediation…');
      const result = await api(`/api/tracked-reports/${encodeURIComponent(id)}/remediate`, {
        method: 'POST',
        body: JSON.stringify({ severities }),
      });
      followStatus(id, spendText(result, 'remediation'), result.failed ? 'error' : 'ok');
      if (result.report) {
        trackedById.set(id, result.report);
        updateNeed(card);
      }
      creditsChanged();
    } else {
      if (!severities.length) return true;
      if (!confirm("Run AI Triage on this report's findings at the severities on the button that are still awaiting triage? It uses Checkmarx One credits.")) return true;
      followStatus(id, 'Starting AI Triage…');
      const result = await api(`/api/tracked-reports/${encodeURIComponent(id)}/triage`, {
        method: 'POST',
        body: JSON.stringify({ severities }),
      });
      followStatus(id, spendText(result, 'triage'), result.failed ? 'error' : 'ok');
      if (result.report) {
        trackedById.set(id, result.report);
        updateNeed(card);
      }
      creditsChanged();
    }
  } catch (error) {
    if (!handleAuthLoss(error)) followStatus(id, button.dataset.reportHtml ? `Could not build the HTML report: ${error.message}` : error.message, 'error');
  } finally {
    button.textContent = label;
    button.disabled = false;
  }
  return true;
}

/** What a Triage now / Remediate now click did, in one line. */
function spendText(result, kind) {
  if (!result.requested) return kind === 'triage' ? 'Nothing awaiting triage at those severities.' : 'Nothing confirmed to remediate at those severities.';
  const parts = [
    kind === 'triage' ? `AI Triage started for ${result.started} finding(s)` : `AI Remediation started for ${result.started} finding(s)`,
    result.skipped ? `${result.skipped} not eligible (SAST and SCA only)` : '',
    result.failed ? `${result.failed} failed: ${result.errors.join('; ')}` : '',
  ];
  return `${parts.filter(Boolean).join(' · ')}.`;
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
  for (const el of document.querySelectorAll('#rp-sheet [data-keep]')) {
    const key = keepKey(el);
    values.set(key, el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value);
  }
  const open = new Set([...document.querySelectorAll('#rp-sheet details[open]')].map((d) => d.dataset.keepOpen || d.querySelector('summary')?.textContent));
  const statuses = new Map([...document.querySelectorAll('[data-follow-status]')].map((el) => [el.dataset.followStatus, [el.textContent, el.className]]));
  return { values, open, statuses };
}

function restoreReportsState({ values, open, statuses }) {
  for (const el of document.querySelectorAll('#rp-sheet [data-keep]')) {
    const key = keepKey(el);
    if (!values.has(key)) continue;
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = values.get(key);
    else el.value = values.get(key);
  }
  for (const d of document.querySelectorAll('#rp-sheet details')) {
    const key = d.dataset.keepOpen || d.querySelector('summary')?.textContent;
    if (open.has(key) || open.has(t(key))) d.open = true;
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
  if (await verifyAction(event)) return;
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
    closeReportDetail();
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
  const need = credits.need?.[kind] ?? 0;
  const short = credits.shortfall?.[kind] ?? 0;
  const title = [
    `${c.remaining} left of ${c.allocated} allocated, ${c.used} used`,
    kind === 'triage'
      ? `needs ${need} for ${resultsText(
          Object.entries(credits.toTriage ?? {}).filter(([s]) => (credits.severities ?? []).includes(s)).reduce((n, [, v]) => n + v, 0),
          Object.entries(credits.toTriageRows ?? credits.toTriage ?? {}).filter(([s]) => (credits.severities ?? []).includes(s)).reduce((n, [, v]) => n + v, 0),
        )} still to triage (${(credits.severities ?? []).map((s) => s.toLowerCase()).join(', ') || 'no severities'})`
      : `needs ${need} for ${credits.toRemediate ?? 0} confirmed finding(s) to remediate (3 credits each)`,
    short ? `${short} more needed than allocated — allocate it on purpose` : '',
    extra ? `includes ${extra} extra credit(s) you added` : '',
  ].filter(Boolean).join(' · ');
  const figures = `<span class="${c.remaining === 0 && c.allocated > 0 ? 'low' : ''}">${c.remaining}</span><span class="zero"> / ${c.allocated}</span>${extra ? '<span class="extra-dot" title="Includes extra credits">+</span>' : ''}${short ? `<span class="need-tag">${short} more needed</span>` : ''}`;
  if (!can('credits.allocate')) return `<td class="num credits" title="${escapeHtml(title)}">${figures}</td>`;
  return `<td class="num credits" title="${escapeHtml(title)}"><button type="button" class="credit-edit" data-credit-edit="${escapeHtml(project.projectId)}" aria-label="Edit ${escapeHtml(project.projectName)} credits">${figures}</button></td>`;
}

/** Selected projects, or every shown one when none is selected (while a credit action runs: the projects it acts on). */
let actionScope = null;
/**
 * Projects picked (or the AI credits tab open, or a fetch of ten or fewer): the server starts reading their scans'
 * result ids now, so the check before allocating or running does not wait for that slow part.
 * Once per set of projects, a moment after the picking stops; never for more than 25.
 */
function prepareCredits(scope) {
  const creditsOpen = document.querySelector('[data-ptpanel="dash:credits"]')?.hidden === false;
  if (!can('credits.view') || !scope.length || scope.length > 25 || (!state.selected.size && !creditsOpen && scope.length > 10)) return;
  const ids = scope.map((p) => p.projectId).sort();
  const key = ids.join('|');
  if (key === prepareCredits.key) return;
  clearTimeout(prepareCredits.timer);
  prepareCredits.timer = setTimeout(() => {
    prepareCredits.key = key;
    fetch('/api/credits/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ projectIds: ids }) }).catch(() => {});
  }, 600);
}

function allocationScope() {
  if (actionScope) return actionScope;
  const shown = visibleProjects().filter((p) => !p.error);
  return state.selected.size ? shown.filter((p) => state.selected.has(p.projectId)) : shown;
}

/**
 * The projects an action has work in: something to triage, or confirmed findings to remediate,
 * for the ticked severities or the project's own. Only these are read from Checkmarx One again,
 * so a credit action on a few projects' findings does not re-read every project shown.
 */
function workScope(kind) {
  const scope = allocationScope();
  if (kind !== 'triage' && kind !== 'remediation') return scope;
  const ticked = allocSeverities();
  return scope.filter((p) => {
    const c = p.credits ?? {};
    const severities = new Set([...ticked, ...(c.severities ?? [])]);
    const by = kind === 'triage' ? c.toTriage : c.toRemediateBySeverity;
    return [...severities].some((s) => (by?.[s] ?? 0) > 0);
  });
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

/** What the scan initiators were told after an action on their behalf. */
function onBehalfText(notified) {
  if (!notified) return [];
  const out = [];
  if (notified.emailed) out.push(`told ${notified.emailed} developer(s) by email`);
  if (notified.noAddress?.length) out.push(`no address to tell for ${notified.noAddress.length} project(s)`);
  if (notified.failed) out.push(`${notified.failed} email(s) failed — check the mail server`);
  return out;
}

/** Take back what the projects in scope were given and did not use. */
async function reclaimUnused() {
  const scope = allocationScope();
  const triage = scope.reduce((n, p) => n + (p.credits?.triage?.remaining ?? 0), 0);
  const remediation = scope.reduce((n, p) => n + (p.credits?.remediation?.remaining ?? 0), 0);
  if (!triage && !remediation) return setStatus('alloc-status', 'Nothing to take back: these projects have no unused credits.', 'ok');
  if (!confirm(`Take back ${triage + remediation} unused credit(s) — ${triage} triage, ${remediation} remediation — from ${scope.length} project(s) to the credit pool?\n\nDevelopers can no longer triage or remediate from their reports until credits are allocated again. You can still act on their behalf from here.`)) return;
  try {
    const result = await api('/api/credits/allocate', { method: 'POST', body: JSON.stringify({ projectIds: scope.map((p) => p.projectId), reclaimUnused: ['triage', 'remediation'] }) });
    for (const [projectId, credits] of Object.entries(result.projects ?? {})) {
      const p = state.projects.find((x) => x.projectId === projectId);
      if (p) p.credits = credits;
    }
    setStatus('alloc-status', `Took back ${result.reclaimed} unused credit(s) to the credit pool.`, 'ok');
    logger.add(`Took back ${result.reclaimed} unused credit(s)`, 'success');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('alloc-status', error);
  } finally {
    renderProjects();
    renderAllocation();
  }
}

/** For the scope and ticked severities: findings to triage, confirmed to remediate, and what is allocated / short. */
function allocationTotals(scope = allocationScope(), severities = allocSeverities()) {
  const sum = (fn) => scope.reduce((n, p) => n + (fn(p) || 0), 0);
  return {
    toTriage: sum((p) => severities.reduce((n, s) => n + (p.credits?.toTriage?.[s] ?? 0), 0)),
    toTriageRows: sum((p) => severities.reduce((n, s) => n + (p.credits?.toTriageRows?.[s] ?? p.credits?.toTriage?.[s] ?? 0), 0)),
    toRemediate: sum((p) => severities.reduce((n, s) => n + (p.credits?.toRemediateBySeverity?.[s] ?? 0), 0)),
    triageLeft: sum((p) => p.credits?.triage?.remaining),
    remediationLeft: sum((p) => p.credits?.remediation?.remaining),
    triageShort: sum((p) => p.credits?.shortfall?.triage),
    remediationShort: sum((p) => p.credits?.shortfall?.remediation),
  };
}

function renderAllocation() {
  $('credits-panel').hidden = !state.projects.length;
  renderRailScope();
  if (!state.projects.length) return;
  const scope = allocationScope();
  syncAllocationBoxes(scope);
  const severities = allocSeverities();
  if (state.fetching) {
    // Credit needs are only ever shown for complete data, never for a half-loaded list.
    $('alloc-scope').textContent = `${scope.length} project${scope.length === 1 ? '' : 's'} so far`;
    $('alloc-needed').textContent = 'Credits needed are worked out when the data fetch is complete.';
    $('remediate-needed').textContent = 'Credits needed are worked out when the data fetch is complete.';
    return;
  }
  prepareCredits(scope);
  const t = allocationTotals(scope, severities);
  // Take back: what the projects in scope were given and have not used, whatever the severities.
  const unused = scope.reduce((n, p) => n + (p.credits?.triage?.remaining ?? 0) + (p.credits?.remediation?.remaining ?? 0), 0);
  $('alloc-reclaim').textContent = unused ? `Take back ${unused} unused credit${unused === 1 ? '' : 's'}` : 'No unused credits to take back';
  $('alloc-reclaim').classList.toggle('is-empty', !unused);
  const verifiedAll = scope.length && scope.every((p) => isVerified(p, severities));
  const rows = scope.reduce((n, p) => n + (isVerified(p, severities) ? p.verified.triage.rows : 0), 0);
  $('alloc-verified').innerHTML = verifiedAll
    ? `<span class="verified-ok">✓ Confirmed twice with Checkmarx One</span> — ${rows} finding row(s) are ${t.toTriage} Checkmarx One result(s): rows that share a result are triaged, and charged, once.`
    : 'Not checked against Checkmarx One yet. Every button below checks first, by itself.';
  $('alloc-scope').textContent = `${scope.length} project${scope.length === 1 ? '' : 's'} ${state.selected.size ? 'selected' : 'shown'}`;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  $('alloc-needed').innerHTML = severities.length
    ? `<b>${plural(t.toTriage, 'Checkmarx One result')}</b> to triage (${plural(t.toTriage, 'credit')})${t.toTriageRows > t.toTriage ? ` <span class="hint">— from ${t.toTriageRows} findings: rows that share one result are triaged, and charged, once</span>` : ''} · <b>${t.triageLeft}</b> allocated and not used${t.triageShort ? ` · <span class="short">${t.triageShort} more needed</span>` : ''}` +
      (t.toTriageRows > t.toTriage ? sharedResultsHtml(scope.flatMap((p) => (p.credits?.sharedResults ?? []).map((g) => ({ ...g, projectName: scope.length > 1 ? p.projectName : '' }))), severities) : '')
    : 'Tick at least one severity.';
  $('remediate-needed').innerHTML = severities.length
    ? `<b>${plural(t.toRemediate, 'confirmed result')}</b> to remediate (${plural(t.toRemediate * 3, 'credit')}, 3 each) · <b>${t.remediationLeft}</b> allocated and not used${t.remediationShort ? ` · <span class="short">${t.remediationShort} more needed</span>` : ''}${t.toRemediate ? '' : ' — triage first: remediation needs findings it confirmed'}`
    : '';
  const tier = tierName(severities);
  $('run-triage').textContent = `Triage ${tier}`;
  $('run-remediation').textContent = `Remediate ${tier}`;
  $('run-triage').disabled = !severities.length || !scope.length || t.toTriage === 0;
  $('alloc-triage').disabled = !scope.length || t.triageShort === 0;
  $('alloc-triage').textContent = t.triageShort ? `Allocate ${t.triageShort} for triage` : 'Triage is allocated';
  $('alloc-remediation').disabled = !scope.length || t.remediationShort === 0;
  $('alloc-remediation').textContent = t.remediationShort ? `Allocate ${t.remediationShort} for remediation` : t.toRemediate ? 'Remediation is allocated' : 'Allocate for remediation';
  $('run-remediation').disabled = !severities.length || !scope.length || t.toRemediate === 0;
  // Gold once the credits given cover it: one click checks, or fixes, everything selected across projects.
  $('run-triage').classList.toggle('is-golden', !$('run-triage').disabled && t.triageShort === 0 && t.triageLeft > 0);
  $('run-remediation').classList.toggle('is-golden', !$('run-remediation').disabled && t.remediationShort === 0 && t.remediationLeft > 0);
}

/**
 * What the credits panel shows for these projects now: what each needs and has
 * for the ticked severities. Compared before and after Refresh & verify.
 */
function creditPicture(scope = allocationScope(), severities = allocSeverities()) {
  const out = {};
  for (const p of scope) {
    const c = p.credits ?? {};
    out[p.projectId] = {
      name: p.projectName,
      toTriage: severities.reduce((n, s) => n + (c.toTriage?.[s] ?? 0), 0),
      toRemediate: severities.reduce((n, s) => n + (c.toRemediateBySeverity?.[s] ?? 0), 0),
      triageLeft: c.triage?.remaining ?? 0,
      remediationLeft: c.remediation?.remaining ?? 0,
    };
  }
  return out;
}

const PICTURE_LABELS = {
  toTriage: 'results to triage',
  toRemediate: 'confirmed results to remediate',
  triageLeft: 'triage credits left',
  remediationLeft: 'remediation credits left',
};

/** What changed between two pictures, in words: "Payments: results to triage 10 → 8". */
function pictureChanges(before, after) {
  const changes = [];
  for (const [id, now] of Object.entries(after)) {
    const was = before[id];
    if (!was) continue;
    for (const key of Object.keys(PICTURE_LABELS)) {
      if (was[key] !== now[key]) changes.push(`${now.name}: ${PICTURE_LABELS[key]} ${was[key]} → ${now[key]}`);
    }
  }
  return changes;
}

/**
 * Every credit and AI action goes through here: Refresh & verify runs first
 * (Checkmarx One read twice, independently). If the reads disagree, or what is
 * needed or left changed since the panel last showed it (someone triaged or
 * remediated in Checkmarx One, or from a report), the action is cancelled and
 * the panel now shows the real numbers; clicking again goes ahead with them.
 */
async function guardedAction(label, run, kind = null) {
  if (state.fetching) return setStatus('alloc-status', 'Wait for the data fetch to complete.', 'error');
  if (!allocationScope().length) return setStatus('alloc-status', 'Fetch the projects first.', 'error');
  const scope = workScope(kind);
  if (!scope.length) return setStatus('alloc-status', kind === 'remediation' ? 'Nothing to remediate here: no project shown has confirmed findings of these severities.' : 'Nothing to triage here: no project shown has findings of these severities left to triage.', 'ok');
  actionScope = scope;
  try {
    return await checkThenRun(label, run, scope);
  } finally {
    actionScope = null;
    renderAllocation();
  }
}

async function checkThenRun(label, run, scope) {
  const before = creditPicture(scope);
  const check = await verifyWithCheckmarx({ before: label });
  if (!check?.ok) {
    // The status line says why: the two reads disagreed (findings changing right now), or Checkmarx One could not be read.
    if (check) setStatus('alloc-status', `${label} cancelled — ${$('alloc-status').textContent} Wait a moment and click again.`, 'warn');
    return;
  }
  const changes = pictureChanges(before, creditPicture(allocationScope()));
  if (changes.length) {
    const shown = changes.slice(0, 4).join('; ') + (changes.length > 4 ? `; and ${changes.length - 4} more` : '');
    setStatus('alloc-status', `${label} cancelled: Checkmarx One changed since this page last showed it — ${shown}. Someone may have triaged or remediated in Checkmarx One or from a report. The numbers above are now current; click again to go ahead with them.`, 'warn');
    logger.add(`${label} cancelled: ${changes.length} change(s) found when checking the numbers again`, 'error');
    $('alloc-verify').scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    return;
  }
  return run();
}

/** "Allocate for triage / remediation": give the scope what it needs, after confirming. */
async function allocateNeeded(kind) {
  // Checked twice with Checkmarx One first: the confirmation only ever shows confirmed numbers.
  const scope = allocationScope();
  const t = allocationTotals(scope);
  const credits = kind === 'triage' ? t.triageShort : t.remediationShort;
  if (!credits) return setStatus('alloc-status', `Confirmed twice with Checkmarx One: nothing more to allocate for ${kind === 'triage' ? 'triage' : 'remediation'} — the projects already have what they need.`, 'ok');
  const what = kind === 'triage'
    ? `${resultsText(t.toTriage, t.toTriageRows)} still to triage`
    : `${t.toRemediate} confirmed result(s) to remediate (3 credits each)`;
  if (!confirm(`Confirmed twice with Checkmarx One just now: ${what}.\n\nAllocate ${credits} ${kind === 'triage' ? 'AI Triage' : 'AI Remediation'} credit(s) from the credit pool to ${scope.length} project(s)?\n\n(The server reads Checkmarx One twice again as it allocates, and refuses if anything changed.)`)) return;
  await allocateCredits({ allocate: [kind] }, (n) => `Allocated ${credits} ${kind} credit(s) to ${n} project(s).`);
  renderAllocation();
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
  const left = scope.reduce((n, p) => n + (p.credits?.triage?.remaining ?? 0), 0);
  const fromPool = Math.max(0, needed - left);
  if (!confirm(`Run Checkmarx One AI Triage now on up to ${needed} ${names} finding(s) across ${scope.length} project(s)? This uses up to ${needed} Checkmarx One credit(s)${fromPool ? ` — ${left} already allocated, and you allocate the other ${fromPool} from the credit pool by confirming` : ''}.`)) return;
  const button = $('run-triage');
  button.disabled = true;
  setStatus('alloc-status', 'Starting AI Triage… (reading scan results for the selected projects)');
  try {
    const result = await api('/api/triage/run', {
      method: 'POST',
      body: JSON.stringify({ projectIds: scope.map((p) => p.projectId), severities, notifyInitiators: $('notify-on-behalf').checked }),
    });
    applyCredits(result.projects);
    if (!result.requested) {
      setStatus('alloc-status', 'Nothing to triage: these findings are already triaged, or were sent for triage in the last 30 minutes.', 'ok');
      return;
    }
    const parts = [`AI Triage started for ${result.started} finding(s)`];
    if (result.skipped) parts.push(`${result.skipped} not eligible (AI Triage supports SAST and SCA)`);
    if (result.failed) parts.push(`${result.failed} failed: ${result.errors.join('; ')}`);
    parts.push(...onBehalfText(result.notified));
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

/** "Remediate selected": confirmed findings only, 3 credits each, after a clear confirmation. */
async function runRemediationNow() {
  const scope = allocationScope();
  const severities = allocSeverities();
  const t = allocationTotals(scope, severities);
  if (!t.toRemediate) return;
  const projects = scope.filter((p) => severities.some((s) => p.credits?.toRemediateBySeverity?.[s]));
  const cost = t.toRemediate * 3;
  $('remediate-title').textContent = `Remediate ${t.toRemediate} confirmed finding${t.toRemediate === 1 ? '' : 's'}?`;
  $('remediate-body').innerHTML = `
    <p>Checkmarx One AI Remediation runs on the <strong>${escapeHtml(severities.map((s) => s.toLowerCase()).join(', '))}</strong> findings that triage <strong>confirmed</strong> — and only those: anything proposed not exploitable or still to verify is never remediated.</p>
    <ul class="remediate-list">${projects
      .map((p) => {
        const n = severities.reduce((sum, s) => sum + (p.credits?.toRemediateBySeverity?.[s] ?? 0), 0);
        return `<li>${escapeHtml(p.projectName)} — ${n} confirmed · ${n * 3} credits · ${p.credits?.remediation?.remaining ?? 0} allocated</li>`;
      })
      .join('')}</ul>
    <p class="cost-line">This consumes <strong>3 credits for each confirmed finding: ${cost} credit${cost === 1 ? '' : 's'}</strong>, from the remediation credits allocated to these projects${t.remediationShort ? ` — <strong>${t.remediationShort} are not allocated yet</strong>: allocate them first, or those projects are skipped` : ''}.</p>
    <p class="hint">Developers get the results as when they click Remediate in their report: a pull request where the project is connected to a repository, otherwise the remediation details.</p>`;
  $('remediate-go').disabled = t.remediationLeft === 0;
  const dialog = $('remediate-dialog');
  dialog.returnValue = '';
  dialog.showModal();
  await new Promise((resolve) => dialog.addEventListener('close', resolve, { once: true }));
  if (dialog.returnValue !== 'go') return;

  const button = $('run-remediation');
  button.disabled = true;
  setStatus('alloc-status', 'Starting AI Remediation… (checking each finding is confirmed in Checkmarx One)');
  try {
    const result = await api('/api/remediation/run', { method: 'POST', body: JSON.stringify({ projectIds: scope.map((p) => p.projectId), severities, notifyInitiators: $('notify-on-behalf').checked }) });
    applyCredits(result.projects);
    if (!result.requested) {
      setStatus('alloc-status', 'Nothing to remediate: no finding of these severities is confirmed and not yet remediated.', 'ok');
      return;
    }
    const parts = [`AI Remediation started for ${result.started} confirmed finding(s)`];
    if (result.notConfirmed) parts.push(`${result.notConfirmed} not confirmed — left alone`);
    if (result.skipped) parts.push(`${result.skipped} not eligible`);
    if (result.failed) parts.push(`${result.failed} not started: ${result.errors.map((e) => e.replace(/\.?\s*Ask your administrator to allocate more\.?$/, '').replace(/\.$/, '')).join('; ')} — allocate for remediation first`);
    parts.push(...onBehalfText(result.notified));
    setStatus('alloc-status', `${parts.join(' · ')}. Pull requests or remediation details follow in Checkmarx One and in the developers' reports.`, result.failed ? 'error' : 'ok');
    logger.add(`Admin AI Remediation: ${parts.join(' · ')}`, result.failed ? 'error' : 'success');
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
    // SLAs (Beta): past the days their severity has to be fixed, and due within 7 days.
    ...(can('feature.sla') && totals.sla
      ? [[
          'Past SLA',
          totals.sla.overdue,
          totals.sla.overdue ? 'sla-over' : totals.sla.dueSoon ? 'sla-soon' : '',
          `Open findings past the days their severity has to be fixed (Settings → SLAs). ${totals.sla.dueSoon} more reach it within 7 days.`,
          totals.sla.dueSoon ? `${totals.sla.dueSoon} due ≤ 7 days` : '',
        ]]
      : []),
  ]
    .map(([label, v, tone = '', title = '', sub = '']) => `<div${tone ? ` class="${tone}"` : ''}${title ? ` title="${escapeHtml(title)}"` : ''}><span class="value">${v}</span><span class="label">${label}</span>${sub ? `<span class="sub">${escapeHtml(sub)}</span>` : ''}</div>`)
    .join('');
  if (!$('getting-started').hidden) renderGettingStarted();
  renderJourney();
}

// ---- The way to Mission Zero: Detect → Triage → Remediate → Fix & rescan → Verify → Zero ----

/** Tracked reports' verification rounds, read at most once a minute for the strip. */
const journeyReports = { at: 0, verified: 0, verifying: 0, leftZero: 0, total: 0, loading: false };

async function loadJourneyReports() {
  if (!can('reports.view') || journeyReports.loading || Date.now() - journeyReports.at < 60_000) return;
  journeyReports.loading = true;
  try {
    const data = await api('/api/tracked-reports');
    const reports = data.reports ?? data.items ?? [];
    Object.assign(journeyReports, {
      at: Date.now(),
      total: reports.length,
      verified: reports.filter((r) => r.verification?.result?.zero && !r.latest?.open).length,
      leftZero: reports.filter((r) => r.verification?.result?.zero && r.latest?.open).length,
      verifying: reports.filter((r) => r.verification && !r.verification.finishedAt && !r.verification.result).length,
    });
    renderJourney();
  } catch {
    /* the strip still shows the findings; the reports part waits for the next fetch */
  } finally {
    journeyReports.loading = false;
  }
}

function renderJourney() {
  const panel = $('journey-panel');
  const projects = state.projects ?? [];
  const journeys = projects.map((p) => p.credits?.journey).filter(Boolean);
  panel.hidden = !journeys.length;
  if (!journeys.length) return;
  const t = { projects: 0, atZero: 0, open: 0, toTriage: 0, toRemediate: 0, fixing: 0, notExploitable: 0 };
  for (const j of journeys) {
    t.projects += 1;
    if (!j.open) t.atZero += 1;
    for (const key of ['open', 'toTriage', 'toRemediate', 'fixing', 'notExploitable']) t[key] += j[key] ?? 0;
  }
  const r = journeyReports;
  const reportsKnown = can('reports.view') && r.at;
  const steps = [
    // Detected: done by the fetch itself. Its number is what is open; the work starts at Triage.
    { id: 'detect', label: 'Detect', value: t.open, hint: `${t.open} open finding${t.open === 1 ? '' : 's'} in ${t.projects} project${t.projects === 1 ? '' : 's'}${t.notExploitable ? `; ${t.notExploitable} not exploitable` : ''}`, clear: true, count: true },
    { id: 'triage', label: 'Triage', value: t.toTriage, hint: `${t.toTriage} to verify: AI Triage or a person decides whether each is real`, clear: !t.toTriage, rail: 'credits' },
    { id: 'remediate', label: 'Remediate', value: t.toRemediate, hint: `${t.toRemediate} confirmed, waiting for a fix`, clear: !t.toRemediate, rail: 'credits' },
    { id: 'fix', label: 'Fix', value: t.fixing, hint: `${t.fixing} with a fix asked for: merge it, then rescan`, clear: !t.fixing, href: '#/reports' },
    {
      id: 'verify', label: 'Verify', value: reportsKnown ? r.verified : '–',
      hint: reportsKnown ? `${r.verified} of ${r.total} tracked report${r.total === 1 ? '' : 's'} verified at zero by a rescan${r.verifying ? `; ${r.verifying} verifying` : ''}${r.leftZero ? `; ${r.leftZero} left zero` : ''}` : 'A rescan proves the fixes (Reports → Verify)',
      clear: reportsKnown && r.total > 0 && !r.leftZero && r.verified === r.total, alert: reportsKnown && r.leftZero > 0, href: '#/reports',
    },
  ];
  // A stage is clear only when it and every stage before it are; the first one that is not is where to act.
  let upstream = true;
  for (const step of steps) {
    step.done = upstream && step.clear;
    if (step.id !== 'verify') upstream = step.done;
  }
  const next = steps.find((s) => !s.done);
  const reached = steps.filter((s) => s.done).length;
  // The green line runs up to the stage to act on next (nodes are evenly spaced along the track).
  panel.style.setProperty('--jfill', String(Math.min(reached, steps.length - 1) / (steps.length - 1)));

  const pct = t.projects ? Math.round((t.atZero / t.projects) * 100) : 0;
  const C = 2 * Math.PI * 21;
  $('journey-zero').innerHTML = `
    <svg viewBox="0 0 52 52" class="jz-ring" aria-hidden="true">
      <circle cx="26" cy="26" r="21" class="jz-bg" />
      <g class="jz-ticks">${dialTicks(26, 26, 25.5, 24)}</g>
      <circle cx="26" cy="26" r="21" class="jz-fg" stroke-dasharray="${((pct / 100) * C).toFixed(1)} ${C.toFixed(1)}" />
    </svg>
    <span class="jz-pct">${pct}%</span>
    <span class="jz-text"><b>Mission Zero</b><small>${t.atZero} of ${t.projects} project${t.projects === 1 ? '' : 's'} at zero</small></span>`;
  $('journey-zero').classList.toggle('all', t.atZero === t.projects);
  $('journey-zero').title = t.atZero === t.projects ? 'Every project here is at zero. Keep it there.' : 'Projects with nothing open, of those fetched';

  $('journey-steps').innerHTML = steps
    .map((s) => {
      const state = s.alert ? 'alert' : s.done ? 'done' : s === next ? 'now' : 'todo';
      const tag = s.href ? `a href="${s.href}"` : s.rail ? `button type="button" data-rail-open="${s.rail}"` : 'span';
      const end = s.href ? 'a' : s.rail ? 'button' : 'span';
      return `<li class="jstep is-${state}" data-step="${s.id}">
        <${tag} class="jnode" title="${escapeHtml(s.hint)}" aria-label="${escapeHtml(`${s.label}: ${s.hint}`)}">
          <span class="jdot">${state === 'done' && !s.count ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>' : escapeHtml(String(s.value))}</span>
          <span class="jlabel">${escapeHtml(s.label)}</span>
        </${end}>
      </li>`;
    })
    .join('');
  loadJourneyReports();
}

/**
 * Read the NDJSON stream from /api/scan?stream=1: calls on.start / on.project
 * as events arrive and resolves with the final ("done") result.
 */
async function streamScan(path, on = {}) {
  logger.apiCall('GET', path);
  const response = await fetch(path, { credentials: 'same-origin', signal: on.signal });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.error || `${response.status} ${response.statusText}`);
    error.status = response.status;
    logger.apiError('GET', path, error);
    throw error;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = null;
  const handle = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'start') on.start?.(event);
    else if (event.type === 'project') on.project?.(event.project);
    else if (event.type === 'done') done = event;
    else if (event.type === 'error') {
      const error = new Error(event.error || 'The fetch failed.');
      error.status = event.status;
      throw error;
    }
  };
  for (;;) {
    const { value, done: ended } = await reader.read();
    if (ended) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      handle(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  }
  handle(buffer + decoder.decode());
  if (!done) throw new Error('The connection closed before the fetch finished. Fetch again.');
  logger.apiSuccess('GET', path, 200);
  return done;
}

/** The data fetch's flare (the same flares every action uses). */
function fetchFlare(kind, text) {
  flare('fetch', kind, text, kind === 'busy' ? 'Triage, remediation and credits wait until it is complete.' : '');
}

/** Totals from the rows that have arrived so far. */
function totalsOf(projects) {
  const totals = { projects: 0, risks: 0, counts: {}, severities: {} };
  for (const p of projects) {
    totals.projects += 1;
    totals.risks += p.totalRisks ?? 0;
    for (const [bucket, count] of Object.entries(p.counts ?? {})) totals.counts[bucket] = (totals.counts[bucket] ?? 0) + count;
    for (const [severity, count] of Object.entries(p.bySeverity ?? {})) totals.severities[severity] = (totals.severities[severity] ?? 0) + count;
    if (p.sla) {
      totals.sla ??= { overdue: 0, dueSoon: 0 };
      totals.sla.overdue += p.sla.overdue;
      totals.sla.dueSoon += p.sla.dueSoon;
    }
  }
  return totals;
}

function setFetching(on) {
  state.fetching = on;
  document.body.classList.toggle('fetching', on);
  for (const el of document.querySelectorAll('[data-needs-data]')) el.setAttribute('aria-disabled', on ? 'true' : 'false');
}

/**
 * After a page reload or a server restart: show the data this person fetched,
 * and the scope that produced it, from the server's copy (Checkmarx One is not
 * read again; Fetch gets the latest).
 */
export async function restoreLastScan({ force = false } = {}) {
  if ((state.projects.length && !force) || state.fetching || !can('findings.fetch')) return;
  let result;
  try {
    result = await api('/api/scan/last');
  } catch {
    return;
  }
  if (!result?.projects || (state.projects.length && !force) || state.fetching) return;
  restoreScope(result.request, result.projects);
  showLeftOut(result);
  showVulnerabilitySearch(result);
  state.lastScan = result;
  state.projects = result.projects;
  renderTotals(totalsOf(state.projects));
  collectInitiators();
  renderInitiatorList();
  renderProjects();
  renderAllocation();
  loadFusion();
  const at = new Date(result.fetchedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  $('fetch-meta').textContent = `Showing the data fetched ${at}. Load findings again for the latest.`;
  setStatus('status', `Loaded ${state.projects.length} project(s) as fetched ${at}.`, 'ok');
}

/** Put the scope controls back the way they were for that fetch. */
function restoreScope(request, projects) {
  if (!request) return;
  // Made before engines could be chosen: every engine was loaded.
  setEnginePick(Array.isArray(request.engines) ? request.engines : []);
  // Made before branches could be chosen: every branch, nothing left out.
  setFocusPick(request);
  for (const prefix of ['activity', 'detection']) {
    const select = $(`${prefix}-preset`);
    const preset = request[`${prefix}Preset`];
    // A load made before "Findings open for" (first found in the last 90 days, or year): shown as what it was.
    if (preset && prefix === 'detection' && ![...select.options].some((o) => o.value === preset) && state.health?.windowPresets.some((p) => p.id === preset)) {
      select.add(new Option(`First found: ${presetLabel(preset).toLowerCase()}`, preset));
    }
    if (preset && [...select.options].some((o) => o.value === preset)) select.value = preset;
    $(`${prefix}-from`).value = request[`${prefix}From`] || '';
    $(`${prefix}-to`).value = request[`${prefix}To`] || '';
    toggleRange(prefix);
  }
  const names = new Map(projects.map((p) => [p.projectId, p.projectName]));
  scopePick.applications.clear();
  scopePick.projects.clear();
  scopePick.initiators.clear();
  (request.applications ?? []).forEach((id, i) => scopePick.applications.set(id, request.applicationNames?.[i] ?? id));
  for (const id of request.projects ?? []) scopePick.projects.set(id, names.get(id) ?? id);
  for (const who of request.initiators ?? []) scopePick.initiators.add(who);
  renderScopeChips();
}

/**
 * Stop the fetch: the server reads no more projects, finishes the ones it is
 * reading, and ends the fetch with what it has. Those projects are kept and
 * every action works on them, as after a complete fetch.
 */
async function stopFetch() {
  const stop = $('fetch-stop');
  if (!state.fetching || stop.disabled) return;
  stop.disabled = true;
  stop.querySelector('span').textContent = 'Stopping…';
  fetchFlare('busy', `Stopping — keeping the ${state.projects.length} project(s) loaded so far…`);
  try {
    await api('/api/scan/stop', { method: 'POST', quiet: true });
  } catch (error) {
    if (handleAuthLoss(error)) return;
    // The server could not be told: end the stream from here; it stops when the page goes away.
    fetchAbort?.abort();
  }
}
let fetchAbort = null;
$('fetch-stop').addEventListener('click', stopFetch);

/** The vulnerability search the data was loaded with: its box, the line saying so, and names to suggest. */
function showVulnerabilitySearch(result) {
  state.vulnerability = result?.vulnerability ?? result?.request?.vulnerability ?? '';
  $('vuln-q').value = state.vulnerability;
  syncNarrow();
  const names = result?.vulnerabilityNames ?? [];
  if (names.length) {
    $('vuln-names').innerHTML = names.map((n) => `<option value="${escapeHtml(String(n.name).replace(/_/g, ' '))}">${escapeHtml(`${n.count} finding${n.count === 1 ? '' : 's'}`)}</option>`).join('');
  }
  const line = $('vuln-active');
  line.hidden = !state.vulnerability;
  if (!state.vulnerability) return;
  const findings = result?.totals?.risks ?? 0;
  const projects = result?.totals?.projects ?? 0;
  line.innerHTML = `<b translate="no">${escapeHtml(state.vulnerability)}</b> · <span>Findings: ${findings} in ${projects} projects. Every action here works on these only.</span> <button type="button" class="link" id="vuln-clear">Show every finding</button>`;
}

async function fetchProjects() {
  // What is in the search box is what is loaded: empty, every finding.
  state.vulnerability = $('vuln-q').value.trim().slice(0, 200);
  const button = $('fetch');
  const stop = $('fetch-stop');
  button.disabled = true;
  button.textContent = 'Loading…';
  stop.hidden = false;
  stop.disabled = false;
  stop.querySelector('span').textContent = 'Stop';
  setStatus('status', '');

  // Rows appear as each project is read; actions on the data wait for the end.
  setFetching(true);
  state.lastScan = null;
  state.projects = [];
  state.selected.clear();
  state.showAllInitiators = false;
  $('select-all').checked = false;
  let total = 0;
  let pending = null;
  const paint = () => {
    pending = null;
    if (!state.fetching) return; // the final result already painted
    renderTotals(totalsOf(state.projects));
    renderProjects();
    fetchFlare('busy', `Data fetching is still in progress — ${state.projects.length}${total ? ` of ${total}` : ''} project(s) loaded`);
  };
  const schedule = () => {
    pending ??= setTimeout(paint, 400);
  };
  fetchFlare('busy', 'Data fetching is still in progress — finding projects…');
  renderProjects();

  try {
    fetchAbort = new AbortController();
    const result = await streamScan(`/api/scan?stream=1&${windowParams()}${$('fetch-fresh')?.checked ? '&fresh=1' : ''}`, {
      signal: fetchAbort.signal,
      start: (event) => {
        total = event.total;
        schedule();
      },
      project: (row) => {
        state.projects.push(row);
        schedule();
      },
    });
    clearTimeout(pending);
    setFetching(false);
    state.lastScan = result;
    state.projects = result.projects;
    showVulnerabilitySearch(result);
    renderEnginePick();
    renderFocusPick();
    renderTotals(result.totals);
    collectInitiators();
    renderInitiatorList();
    renderProjects();
    // Labs → Fusion results has its own line and fetch: only the Fusion column here, and what Fusion can act on, change.
    if (fusion.data) renderFusion();

    for (const note of result.initiatorNotes ?? []) console.warn(note);

    const failed = result.projects.filter((p) => p.error).length;
    const named = result.scope?.projects || result.scope?.initiators?.length;
    const skipped = result.stopped
      ? ` of ${result.projectsPlanned}: stopped before the other ${result.projectsNotRead} were read. Everything here works on these projects; Load findings again for the rest`
      : named
        ? ` of ${result.projectsTotal}: only the projects and people named in the scope`
        : result.projectsSkipped
          ? `, ${result.projectsSkipped} of ${result.projectsTotal} skipped (not scanned in ${result.windows.activity.label.toLowerCase()})`
          : '';
    $('fetch-meta').textContent =
      `${result.totals.risks} finding(s) in ${(result.elapsedMs / 1000).toFixed(1)}s via ${result.resolvedPath}` +
      (result.stats?.requests ? ` · ${result.stats.requests} API request(s)` : '') +
      (result.reused ? ` · ${result.reused} project(s) reused from a read made moments ago` : '') +
      (result.stopped ? ` · stopped at ${result.totals.projects} of ${result.projectsPlanned} project(s)` : '');
    showLeftOut(result);
    setStatus(
      'status',
      `Loaded ${result.totals.projects} project(s)${skipped}.` +
        (failed ? ` ${failed} could not be read — check the risks endpoint in Settings.` : ''),
      failed ? 'error' : result.stopped ? 'warn' : 'ok',
    );
    if (result.warning) console.warn(result.warning);
    fetchFlare('done', result.stopped
      ? `Stopped — kept ${result.totals.projects} of ${result.projectsPlanned} project(s), ${result.totals.risks} finding(s)`
      : `Data fetch complete — ${result.totals.projects} project(s), ${result.totals.risks} finding(s)`);
  } catch (error) {
    clearTimeout(pending);
    if (error.name === 'AbortError') {
      // Ended from this page: the server keeps what it read; show it once it has finished.
      fetchFlare('done', `Stopped — ${state.projects.length} project(s) loaded`);
      setStatus('status', `Stopped after ${state.projects.length} project(s). Getting what was loaded…`, 'warn');
      setFetching(false);
      setTimeout(() => restoreLastScan({ force: true }), 1500);
    } else {
      fetchFlare('failed', `Data fetch stopped: ${error.message}`);
      if (!handleAuthLoss(error)) showError('status', error);
    }
  } finally {
    setFetching(false);
    fetchAbort = null;
    stop.hidden = true;
    button.disabled = false;
    button.textContent = 'Load findings';
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

async function sendReminderWithHtmlAttachment({ groupBy, alsoConsolidated }) {
  const button = $('send');
  button.disabled = true;
  setStatus('status', groupBy === 'none' ? 'Generating the report and sending it to the recipient list…' : 'Generating reports and sending each person their own projects…');

  try {
    const severity = $('severity-filter').value;

    // Each scan initiator gets a report of only the projects they scanned
    // (one per project, or one covering all of theirs), as chosen above.
    const sendResponse = await api('/api/reminders/send-html-by-initiator', {
      method: 'POST',
      body: JSON.stringify({
        projectIds: state.selected.size > 0 ? [...state.selected] : null,
        severities: severity ? [severity] : null,
        initiators: state.pickedInitiators.size > 0 ? [...state.pickedInitiators] : null,
        buckets: [],
        groupBy,
        alsoConsolidated,
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
    return sendReminderWithHtmlAttachment({ groupBy, alsoConsolidated });
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
             <span style="color:var(--accent)">${m.riskCount} finding(s)${
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

/** Who got which projects: the proof that each person was sent only their own. */
function renderDeliveries(entries = []) {
  const list = entries.filter((e) => e.projects?.length);
  $('send-deliveries').hidden = !list.length;
  $('send-deliveries').innerHTML = list.length
    ? `<summary>${list.length} email${list.length === 1 ? '' : 's'} — who got which projects</summary><ul>${list
        .map((e) => `<li><strong>${escapeHtml(e.consolidated || e.initiator === 'consolidated' ? `Fixed list (${e.email})` : e.email)}</strong> — ${escapeHtml(e.projects.join(', '))} · ${e.riskCount} finding${e.riskCount === 1 ? '' : 's'}</li>`)
        .join('')}</ul>`
    : '';
}

function renderSendResult(result) {
  renderDeliveries(result.sent);
  // Interactive HTML reports (from /api/reminders/send-html-by-initiator)
  if (result.summary && (result.sent || result.skipped)) {
    const parts = [result.summary];

    if (result.sent?.length > 0) {
      const totalRisks = result.sent.filter((e) => !e.consolidated).reduce((sum, entry) => sum + entry.riskCount, 0);
      if (totalRisks) parts.push(`${totalRisks} findings in all.`);
    }

    if (result.errors?.length) {
      parts.push(`${result.errors.length} error(s): ${result.errors.map((e) => e.error).join('; ')}`);
      console.error('Send errors:', result.errors);
    }

    setStatus('status', parts.join(' '), result.errors?.length ? 'error' : 'ok');
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

wireSignIn();

$('activity-preset').addEventListener('change', () => toggleRange('activity'));
$('detection-preset').addEventListener('change', () => toggleRange('detection'));
$('fetch').addEventListener('click', fetchProjects);
// Search a vulnerability: load only its findings (or every finding again when the box is emptied).
$('vuln-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (state.fetching || !can('findings.fetch')) return;
  fetchProjects();
});
$('vuln-active').addEventListener('click', (event) => {
  if (!event.target.closest('#vuln-clear') || state.fetching) return;
  $('vuln-q').value = '';
  syncNarrow();
  fetchProjects();
});

// Search waits for a pause in typing; the drop-downs and the box apply at once.
let filterTimer = null;
$('filter').addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(renderProjects, 150);
});
for (const id of ['severity-filter', 'scan-type-filter', 'hide-empty']) {
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

/** Who gets reminders: one choice (Settings: reminders.audience), set here on the Workbench and used everywhere. */
const AUDIENCE_TEXT = { initiator: 'Each developer (their own projects)', list: 'The fixed list', both: 'Each developer, and the fixed list' };
const audience = () => state.settings?.reminders?.audience ?? 'initiator';
export function renderAudience() {
  const value = audience();
  const radio = document.querySelector(`input[name="sendTo"][value="${value}"]`);
  if (radio && !radio.checked && !document.querySelector('input[name="sendTo"]:focus')) {
    radio.checked = true;
    renderRecipientHint();
  }
  if ($('auto-audience')) $('auto-audience').textContent = AUDIENCE_TEXT[value];
  $('audience-note').textContent = can('settings.recipients')
    ? 'This is who gets reminders everywhere: here, scheduled runs and tracked reports’ follow-ups.'
    : `Saved for everyone as “${AUDIENCE_TEXT[value]}” by an administrator; your choice here applies to this send only.`;
}
for (const radio of document.querySelectorAll('input[name="sendTo"]')) {
  radio.addEventListener('change', async () => {
    if (!radio.checked || !can('settings.recipients') || radio.value === audience()) return;
    try {
      state.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ reminders: { audience: radio.value } }) });
      toast(`Reminders now go to: ${AUDIENCE_TEXT[radio.value].toLowerCase()}, everywhere.`, 'ok', 2500);
      renderAudience();
    } catch (error) {
      if (!handleAuthLoss(error)) showError('status', error);
    }
  });
}
if ($('attach-html-report')) {
  const updateHtmlReportButtonsVisibility = () => {
    renderRecipientHint();
    const checked = $('attach-html-report').checked;
    if ($('preview-html')) $('preview-html').hidden = !checked;
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
$('auto-run').addEventListener('click', runAutomationNow);
$('auto-reset').addEventListener('click', async () => {
  try {
    if (!confirm('Reset history? The runs listed here stay, but what was already reported is forgotten: the next run reports every finding past a limit again.')) return;
    await api('/api/automation/reset', { method: 'POST', body: JSON.stringify({}) });
    await loadAutomation();
    toast('History reset: the next run reports from scratch.', 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) toast(error.message, 'bad');
  }
});

wireSettingsChecks();

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
      await allocateCredits({ ruleChanges }, (n) => `What ${n} project(s) need will ${describe} findings. Nothing was allocated.`);
      allocPending = null;
      renderAllocation();
    }, 500);
    renderAllocation();
  });
}
$('alloc-add').addEventListener('click', () => guardedAction('Adding extra credits', () => {
  const triageAdd = Number($('alloc-extra-triage').value) || 0;
  const remediationAdd = Number($('alloc-extra-remediation').value) || 0;
  if (!triageAdd && !remediationAdd) return setStatus('alloc-status', 'Enter how many credits to add.', 'error');
  const scope = allocationScope();
  // Extras stay until removed, so giving them to every project must be deliberate.
  if (!state.selected.size && !confirm(`No project is selected: give all ${scope.length} shown projects ${triageAdd} extra triage and ${remediationAdd} extra remediation credit(s) each?`)) return;
  return allocateCredits({ triageAdd, remediationAdd }, (n) => `Added ${triageAdd} triage and ${remediationAdd} remediation credit(s) to each of ${n} project(s).`);
}));
$('alloc-clear').addEventListener('click', () => guardedAction('Taking back extra credits', () => {
  const scope = allocationScope();
  if (!confirm(`Take back the extra credits added to ${state.selected.size ? 'the' : 'all'} ${scope.length} ${state.selected.size ? 'selected' : 'shown'} project(s)? Credits already used stay counted.`)) return;
  return allocateCredits({ clearExtras: true }, (n) => `Extra credits removed from ${n} project(s).`);
}));
$('run-triage').addEventListener('click', () => guardedAction('Triage', runTriageNow, 'triage'));
$('run-remediation').addEventListener('click', () => guardedAction('Remediation', runRemediationNow, 'remediation'));
$('alloc-triage').addEventListener('click', () => guardedAction('Allocating for triage', () => allocateNeeded('triage'), 'triage'));
$('alloc-verify').addEventListener('click', () => verifyWithCheckmarx());
$('alloc-reclaim').addEventListener('click', () => guardedAction('Taking back unused credits', reclaimUnused));

/** Freshly confirmed twice with Checkmarx One, for the severities ticked now. */
function isVerified(p, severities = allocSeverities()) {
  const v = p.verified;
  return Boolean(v?.agreed && Date.now() - v.at < VERIFY_TTL_MS && v.severities?.join() === SEVERITY_ORDER.filter((s) => severities.includes(s)).join());
}

/**
 * Refresh & verify: the server re-reads the chosen projects from Checkmarx One
 * twice; their rows and credit needs are replaced by what it holds now, and a
 * count is only shown as verified when both reads agree, result id for result id.
 */
async function verifyWithCheckmarx({ before = '' } = {}) {
  const scope = allocationScope();
  if (!scope.length) return setStatus('alloc-status', 'Fetch the projects first.', 'error');
  const button = $('alloc-verify');
  button.disabled = true;
  setStatus('alloc-status', `${before ? `${before}: checking first — ` : ''}reading ${scope.length} project(s) from Checkmarx One twice…`);
  try {
    const result = await api('/api/credits/verify', {
      method: 'POST',
      body: JSON.stringify({ projectIds: scope.map((p) => p.projectId), severities: allocSeverities() }),
    });
    for (const [projectId, row] of Object.entries(result.projects)) {
      const i = state.projects.findIndex((p) => p.projectId === projectId);
      if (i >= 0) state.projects[i] = { ...state.projects[i], ...row };
    }
    renderTotals(totalsOf(state.projects));
    renderProjects();
    const failed = result.verified.filter((v) => !v.agreed);
    const ok = result.verified.filter((v) => v.agreed);
    const sum = (key, sub) => ok.reduce((n, v) => n + (v[key]?.[sub] ?? 0), 0);
    const at = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const summary =
      `Verified twice with Checkmarx One at ${at}: ${sum('triage', 'rows')} finding row(s) to triage = ${sum('triage', 'results')} Checkmarx One result(s) = ${sum('triage', 'results')} triage credit(s)` +
      ` · ${sum('remediation', 'results')} confirmed result(s) to remediate = ${sum('remediation', 'credits')} remediation credit(s).`;
    if (failed.length) {
      setStatus('alloc-status', `${failed.length} project(s) not verified — ${failed[0].reason ?? 'the two reads disagreed'}${ok.length ? ` ${summary}` : ''}`, 'error');
    } else {
      setStatus('alloc-status', summary, 'ok');
    }
    logger.add(`Check the numbers again: ${ok.length} confirmed, ${failed.length} not`, failed.length ? 'error' : 'success');
    return { ok: failed.length === 0, summary };
  } catch (error) {
    if (!handleAuthLoss(error)) showError('alloc-status', error);
    return { ok: false };
  } finally {
    button.disabled = false;
    renderAllocation();
  }
}
$('alloc-remediation').addEventListener('click', () => guardedAction('Allocating for remediation', () => allocateNeeded('remediation'), 'remediation'));
$('track-save').addEventListener('click', saveTrackedReport);
// Reports page: rows and agenda open a report; the detail panel holds every action.
for (const id of ['reports-list', 'rp-upcoming']) {
  $(id).addEventListener('click', (event) => {
    const row = event.target.closest('[data-open-report]');
    if (row) openReportDetail(row.dataset.openReport, row.dataset.tab || 'overview');
  });
}
// Act → Automation: "Open →" goes to that report, on its Remind tab.
$('auto-elsewhere').addEventListener('click', (event) => {
  const link = event.target.closest('[data-open-report]');
  if (!link) return;
  event.preventDefault();
  location.hash = '#/reports';
  const started = Date.now();
  const open = () => {
    if (trackedById.has(link.dataset.openReport)) openReportDetail(link.dataset.openReport, link.dataset.tab || 'overview');
    else if (Date.now() - started < 8000) setTimeout(open, 150);
  };
  open();
});

function selectReportTab(tab) {
  rpState.tab = tab;
  for (const button of document.querySelectorAll('#rp-sheet [role="tab"]')) {
    const on = button.dataset.rpTab === tab;
    button.setAttribute('aria-selected', String(on));
    button.tabIndex = on ? 0 : -1;
    if (on) button.focus();
  }
  for (const panel of document.querySelectorAll('#rp-sheet [role="tabpanel"]')) panel.hidden = panel.id !== `rp-panel-${tab}`;
}
$('rp-drawer').addEventListener('click', (event) => {
  if (event.target.closest('[data-rp-close]')) return closeReportDetail();
  const tab = event.target.closest('[data-rp-tab]');
  if (tab) return selectReportTab(tab.dataset.rpTab);
  trackedReportAction(event);
});
$('rp-sheet').addEventListener('keydown', (event) => {
  if (!event.target.matches('[role="tab"]') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const keys = RP_TABS.map(([key]) => key);
  const at = keys.indexOf(rpState.tab);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length;
  event.preventDefault();
  selectReportTab(keys[next]);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('rp-drawer').hidden && $('terms-overlay').hidden) closeReportDetail();
});
$('rp-sheet').addEventListener('change', (event) => {
  const card = event.target.closest('[data-report]');
  if (!card) return;
  if (event.target.name?.startsWith('sendTo-')) syncSendTo(card);
  if (event.target.matches('[data-verify-auto]')) verifyAutoChange(event);
  if (event.target.matches('[data-verify-grace]')) verifyGraceChange(event);
});
// Typing an address picks "Only to".
$('rp-sheet').addEventListener('input', (event) => {
  if (!event.target.matches('[data-field="onlyTo"]')) return;
  const card = event.target.closest('[data-report]');
  const only = card.querySelector('input[value="only"]');
  if (event.target.value.trim() && !only.checked) {
    only.checked = true;
    syncSendTo(card);
  }
});
for (const radio of document.querySelectorAll('input[name="rpFilter"]')) {
  radio.addEventListener('change', () => {
    rpState.filter = radio.value;
    renderReportList();
  });
}
$('rp-search').addEventListener('input', () => {
  rpState.search = $('rp-search').value;
  renderReportList();
});
$('rp-sort').addEventListener('change', () => {
  rpState.sort = $('rp-sort').value;
  renderReportList();
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

wireLogs();
wireAppBranding();

// ---------------------------------------------------------------------------
// Workspace: getting started, the action rail's scope line, narrowing the
// scope, the preview sheet, Settings → About, and Jump to (Ctrl K).
// ---------------------------------------------------------------------------

/** What the rail's actions apply to: the selected projects, or every one shown. */
export function renderRailScope() {
  const el = $('rail-scope');
  if (!state.projects.length) {
    el.textContent = 'Load findings to act on them.';
    el.className = 'rail-scope empty';
  } else {
    const shown = visibleProjects().filter((p) => !p.error).length;
    el.textContent = state.selected.size
      ? `${state.selected.size} of ${shown} project${shown === 1 ? '' : 's'} selected`
      : `All ${shown} shown project${shown === 1 ? '' : 's'} — tick some to narrow`;
    el.className = `rail-scope ${state.selected.size ? 'picked' : ''}`;
  }
  $('people-count').textContent = state.initiators.length ? String(state.initiators.length) : '';
  $('act-scope').textContent = el.textContent;
  $('act-scope').className = `act-scope ${state.selected.size ? 'picked' : ''}`;
}

// The rail docks beside the projects on wide screens; elsewhere it slides over
// from the right, opened from the action bar, and keeps everything in it.
const railDocked = matchMedia('(min-width: 1600px)');
export function openRail(tab) {
  if (tab) activateTab('dash', tab);
  if (railDocked.matches) return;
  document.querySelector('.wb').classList.add('rail-open');
  $('rail-scrim').hidden = false;
  document.body.classList.add('sheet-open');
  $('wb-rail').querySelector('.ptab.active')?.focus();
}
function closeRail() {
  if (!document.querySelector('.wb').classList.contains('rail-open')) return;
  document.querySelector('.wb').classList.remove('rail-open');
  $('rail-scrim').hidden = true;
  document.body.classList.remove('sheet-open');
}
$('act-bar').addEventListener('click', (event) => {
  const button = event.target.closest('[data-rail-open]');
  if (button) openRail(button.dataset.railOpen);
});
$('journey-steps').addEventListener('click', (event) => {
  const button = event.target.closest('[data-rail-open]');
  if (button) openRail(button.dataset.railOpen);
});
$('rail-close').addEventListener('click', closeRail);
$('rail-scrim').addEventListener('click', closeRail);
railDocked.addEventListener('change', () => railDocked.matches && closeRail());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.querySelector('.wb.rail-open') && $('preview-panel').hidden && !$('palette').open) closeRail();
});

// Scope: narrowing to named projects or people folds away until it is wanted.
// It holds the vulnerability search too: the row above stays one calm line.
function syncNarrow(open) {
  const chips = scopeNamed() + ($('vuln-q').value.trim() ? 1 : 0);
  const show = open ?? (chips > 0 || $('narrow-toggle').getAttribute('aria-expanded') === 'true');
  $('scope-pick').classList.toggle('folded', !show);
  $('narrow-toggle').setAttribute('aria-expanded', String(show));
  $('narrow-toggle').textContent = chips ? `Narrowed (${chips})` : show ? 'Hide narrowing' : 'Narrow down';
  $('narrow-toggle').title = 'Load only some applications, projects or people, or only the findings of one vulnerability';
}
$('narrow-toggle').addEventListener('click', () => {
  const open = $('narrow-toggle').getAttribute('aria-expanded') !== 'true';
  syncNarrow(open);
  if (open) $('scope-application-input').focus();
});

// The email / report preview opens as a sheet over the page.
function syncPreviewSheet() {
  const open = !$('preview-panel').hidden;
  $('preview-scrim').hidden = !open;
  document.body.classList.toggle('sheet-open', open);
}
new MutationObserver(syncPreviewSheet).observe($('preview-panel'), { attributes: true, attributeFilter: ['hidden'] });
$('preview-scrim').addEventListener('click', () => $('close-preview').click());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('preview-panel').hidden) $('close-preview').click();
});

wireAboutAndUpdates();

// ---- Getting started: the few things that make CxMissionZero useful -------

const GS_KEY = 'mz-gs-hidden';

let gsRun = 0;
export async function renderGettingStarted() {
  // Drawn again while an earlier drawing waits for the people list: the later one wins.
  const run = ++gsRun;
  const box = $('getting-started');
  let hidden = false;
  try {
    hidden = localStorage.getItem(GS_KEY) === state.me?.user?.id;
  } catch {}
  const steps = [];
  const cx = Boolean(state.connection);
  const smtp = Boolean(state.settings?.verified);
  const server = state.reportServer ? !state.reportServer.warnings?.length : true;
  if (can('integration.cxone') || !cx) steps.push({ stage: 'setup', label: 'Connect', done: cx, title: 'Connect Checkmarx One', text: 'The server reads projects and findings with its own key.', href: '#/settings/connection', action: can('integration.cxone') ? 'Connect' : 'Ask an Admin' });
  steps.push({ stage: 'act', done: state.projects.length > 0, title: 'Load findings', text: 'Choose a scope and load: ageing findings and who ran each scan.', href: '#/dashboard', action: 'Load', fetch: true });
  if (can('integration.smtp')) steps.push({ stage: 'setup', done: smtp, title: 'Set up email', text: 'Test your mail server so reminders and follow-ups can go out.', href: '#/settings/smtp', action: 'Set up' });
  if (can('settings.links')) steps.push({ stage: 'setup', done: server, title: 'Give reports a reachable address', text: 'So readers can triage and remediate straight from the emailed report.', href: '#/settings/server', action: 'Set address' });
  if (can('credits.limit')) steps.push({ stage: 'prove', done: Boolean(state.settings?.aiTriage?.monthlyCreditLimit), title: 'Cap AI credits', text: 'A credit pool limits what AI Triage and Remediation may spend.', href: '#/settings/ai', action: 'Set pool' });
  if (can('iam.manage')) {
    let people = 2;
    try {
      people = (access.data ?? (await api('/api/iam', { quiet: true }))).users.length;
    } catch {}
    if (run !== gsRun) return;
    steps.push({ stage: 'setup', done: people > 1, title: 'Invite your team', text: 'Add people and give each the role they need.', href: '#/access/people', action: 'Invite' });
  }
  const left = steps.filter((s) => !s.done).length;
  // A checklist of one is not a checklist: people who only fetch never see it.
  if (hidden || !left || steps.length < 2 || state.page === null) {
    box.hidden = true;
    return;
  }
  const done = steps.length - left;
  box.hidden = false;
  box.innerHTML = `<div class="gs-head">
      <div><h2 id="gs-title">Get started <span class="muted">· ${done} of ${steps.length} done</span></h2></div>
      <div class="gs-meter" role="img" aria-label="${done} of ${steps.length} done"><span style="width:${Math.round((done / steps.length) * 100)}%"></span></div>
      <button type="button" class="ghost sm" id="gs-hide">Hide</button>
    </div>
    <ol class="gs-steps">${steps
      .map((step) => `<li class="gs-step ${step.done ? 'done' : ''}" data-stage="${step.stage}" title="${escapeHtml(step.text)}">
        <span class="gs-mark" aria-hidden="true">${step.done ? '✓' : ''}</span>
        <span class="gs-text"><span class="gs-stage" data-i18n-ctx="stage">${step.label ?? STAGE_LABELS[step.stage]}</span><strong>${escapeHtml(step.title)}</strong></span>
        ${step.done ? '<span class="sr-only">Done</span>' : step.fetch ? `<button type="button" class="sm primary" data-gs-fetch ${can('findings.fetch') && cx ? '' : 'disabled'}>${escapeHtml(step.action)}</button>` : `<a class="button-like sm" href="${step.href}">${escapeHtml(step.action)}</a>`}
      </li>`)
      .join('')}</ol>`;
}
$('getting-started').addEventListener('click', (event) => {
  if (event.target.closest('#gs-hide')) {
    try {
      localStorage.setItem(GS_KEY, state.me?.user?.id ?? '1');
    } catch {}
    $('getting-started').hidden = true;
  }
  if (event.target.closest('[data-gs-fetch]')) $('fetch').click();
});

// ---- Get help: support cases and enhancements ------------------------------
// The sidebar's Get help opens a small menu when pointed at (or clicked, or
// focused): raise a support case, request an enhancement, or track requests.
// Everyone sees their own requests; the support team (support.manage) sees the
// queue of the tenants they work in, answers, and moves each one on.

const help = { data: null, open: '', team: false, justRaised: '' };
const HELP_STATUS = { new: ['New', 'info'], 'in-progress': ['In progress', 'info'], waiting: ['Waiting for reply', 'warning'], completed: ['Completed', 'good'], declined: ['Declined', ''] };
const HELP_KIND = { case: 'Support case', enhancement: 'Enhancement' };
const HELP_PRIORITY = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
const helpChip = (status) => {
  const [label, tone] = HELP_STATUS[status] ?? [status, ''];
  return `<span class="rp-chip${tone ? ` tone-${tone}` : ''}" data-i18n-ctx="request">${label}</span>`;
};
const helpWhen = (iso) => `<time datetime="${escapeHtml(iso)}" translate="no">${escapeHtml(new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</time>`;

// The menu: shown beside the sidebar (it scrolls, so the menu lives outside it).
let helpTimer = null;
function placeHelpMenu() {
  const side = document.querySelector('.sidebar').getBoundingClientRect();
  const button = $('help-open').getBoundingClientRect();
  const pop = $('help-pop');
  const rtl = document.documentElement.dir === 'rtl';
  pop.style.left = rtl ? 'auto' : `${Math.round(side.right + 8)}px`;
  pop.style.right = rtl ? `${Math.round(window.innerWidth - side.left + 8)}px` : 'auto';
  pop.style.bottom = `${Math.max(8, Math.round(window.innerHeight - button.bottom))}px`;
}
function showHelpMenu() {
  clearTimeout(helpTimer);
  placeHelpMenu();
  $('help-pop').hidden = false;
  $('help-open').setAttribute('aria-expanded', 'true');
}
function hideHelpMenu(delay = 200) {
  clearTimeout(helpTimer);
  helpTimer = setTimeout(() => {
    $('help-pop').hidden = true;
    $('help-open').setAttribute('aria-expanded', 'false');
  }, delay);
}
for (const el of [$('help-open'), $('help-pop')]) {
  el.addEventListener('mouseenter', showHelpMenu);
  el.addEventListener('mouseleave', () => hideHelpMenu());
}
$('help-open').addEventListener('click', () => ($('help-pop').hidden ? showHelpMenu() : hideHelpMenu(0)));
$('help-open').addEventListener('focus', showHelpMenu);
$('help-open').addEventListener('blur', (event) => {
  if (!$('help-pop').contains(event.relatedTarget)) hideHelpMenu();
});
$('help-pop').addEventListener('focusout', (event) => {
  if (!$('help-pop').contains(event.relatedTarget) && event.relatedTarget !== $('help-open')) hideHelpMenu(0);
});
$('help-pop').addEventListener('click', (event) => {
  if (event.target.closest('a')) hideHelpMenu(0);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('help-pop').hidden) {
    hideHelpMenu(0);
    $('help-open').focus();
  }
});

/** Email mode: a mailto: link to the support address, with a short template and the context the team needs. */
function supportMailto(kind) {
  const isCase = kind === 'case';
  const me = state.me?.user ?? {};
  const tenant = state.me?.tenancy?.current?.name ?? '';
  const body = [
    isCase ? 'What happened:' : 'What I would like:', '', '',
    isCase ? 'What I expected:' : 'Who it helps, and how I would use it:', '', '',
    ...(isCase ? ['Steps to see it:', '', '', 'Priority (low, normal, high, urgent): normal', ''] : []),
    '---',
    `From: ${me.name ? `${me.name} ` : ''}<${me.email ?? ''}>`,
    `Version: ${$('app-version').textContent.trim()}`,
    ...(tenant ? [`Tenant: ${tenant}`] : []),
    `Server: ${location.origin}`,
  ].join('\n');
  const subject = isCase ? 'Support case: ' : 'Enhancement request: ';
  return `mailto:${state.me.support.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** Get help follows the installation's choice (Settings → Get help): the portal here, or each person's email app. */
export function applySupportChannel() {
  const email = state.me?.support?.mode === 'email' && state.me.support.email ? state.me.support.email : '';
  const [caseItem, enhItem] = $('help-pop').querySelectorAll('.help-item');
  caseItem.href = email ? supportMailto('case') : '#/help/case';
  enhItem.href = email ? supportMailto('enhancement') : '#/help/enhancement';
  caseItem.querySelector('small').textContent = email
    ? 'Opens your email app, addressed to the support team, with a short template to fill in.'
    : 'Something does not work, or you are stuck. The support team answers you here.';
  enhItem.querySelector('small').textContent = email
    ? 'Opens your email app: say what you would like, and who it helps.'
    : 'A new feature or an improvement. Follow it until it is done.';
  $('help-pop').querySelector('.help-track').hidden = Boolean(email);
  $('help-bar-case').href = caseItem.href;
  $('help-bar-enh').href = enhItem.href;
  $('help-mail-case').href = caseItem.href;
  $('help-mail-enh').href = enhItem.href;
  $('help-mail-to').textContent = email;
}

export async function loadHelp() {
  try {
    help.data = await api('/api/support');
  } catch (error) {
    if (handleAuthLoss(error)) return;
    $('help-list').innerHTML = `<p class="status error">${escapeHtml(error.message)}</p>`;
    return;
  }
  help.team = Boolean(help.data.team);
  $('help-whose-box').hidden = !help.team;
  renderHelpList();
}

function renderHelpList() {
  if (!help.data) return;
  const kind = $('help-kind').value;
  const status = $('help-status').value;
  const everyone = help.team && $('help-whose').value === 'all';
  const all = help.data.requests ?? [];
  const rows = all.filter((r) => (!kind || r.kind === kind) && (!status || (status === 'open' ? !['completed', 'declined'].includes(r.status) : r.status === status)) && (everyone || r.mine));
  $('help-queue-title').textContent = everyone ? 'Support queue' : 'My requests';
  $('help-count').textContent = `${rows.length} shown`;
  $('help-list').innerHTML = rows.length
    ? `<ul class="help-rows">${rows
        .map((r) => `<li><a class="help-row${r.id === help.open ? ' on' : ''}" href="#/help/${escapeHtml(r.id)}"${r.id === help.open ? ' aria-current="true"' : ''}>
          <span class="help-row-top"><span class="help-num" translate="no">${escapeHtml(r.id)}</span>${helpChip(r.status)}${r.priority === 'urgent' || r.priority === 'high' ? `<span class="rp-chip tone-critical">${HELP_PRIORITY[r.priority]}</span>` : ''}</span>
          <span class="help-row-title" translate="no">${escapeHtml(r.subject)}</span>
          <span class="hint">${r.mine ? '' : `<span translate="no">${escapeHtml(r.requester.name || r.requester.email)}</span>${r.tenant ? ` · <span translate="no">${escapeHtml(r.tenant)}</span>` : ''} · `}${helpWhen(r.updatedAt)}</span>
        </a></li>`)
        .join('')}</ul>`
    : `<p class="hint">${all.length ? 'Nothing matches these filters.' : state.me?.support?.mode === 'email' ? 'Requests go by email here, so none are listed.' : 'No requests yet. Raise one with the buttons above.'}</p>`;
}
for (const id of ['help-kind', 'help-status', 'help-whose']) $(id).addEventListener('change', renderHelpList);

/** #/help, #/help/case, #/help/enhancement or #/help/SUP-0001. */
export function helpRoute(view) {
  const v = String(view ?? '');
  $('help-form').hidden = true;
  $('help-view').hidden = true;
  $('help-empty').hidden = true;
  $('help-mail').hidden = true;
  applySupportChannel();
  const byEmail = state.me?.support?.mode === 'email' && Boolean(state.me.support.email);
  if (byEmail && !/^(SUP|ENH)-\d+$/i.test(v)) {
    help.open = '';
    $('help-mail').hidden = false;
  } else if (v === 'case' || v === 'enhancement') {
    help.open = '';
    openHelpForm(v);
  } else if (/^(SUP|ENH)-\d+$/i.test(v)) {
    help.open = v.toUpperCase();
    openHelpRequest(help.open);
  } else {
    help.open = '';
    $('help-empty').hidden = false;
  }
  renderHelpList();
}

function openHelpForm(kind) {
  const isCase = kind === 'case';
  $('help-form').hidden = false;
  $('help-form').dataset.kind = kind;
  $('help-form-title').textContent = isCase ? 'Submit a support case' : 'Request an enhancement';
  $('help-form-hint').textContent = isCase
    ? 'Tell the support team what is not working, or where you are stuck. You get an email with the case number, and every answer.'
    : 'Describe the feature or improvement you would like, and why it helps. You get an email with its number, and can follow it until it is done.';
  $('help-text').placeholder = isCase ? 'What happened, what you expected, and the steps to see it' : 'What you would like, who it helps, and how you would use it';
  $('help-priority-box').hidden = !isCase;
  setStatus('help-form-status', '');
  $('help-subject').focus();
}

/** What happened to the emails, in words (the error itself is the mail server's, untranslated). */
function helpEmailNote(emailed) {
  if (emailed?.error) return `<span>Saved, but an email could not be sent:</span> <span translate="no">${escapeHtml(emailed.error)}</span>`;
  return emailed?.sent ? '<span>Saved, and emailed.</span>' : '<span>Saved.</span>';
}

$('help-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const kind = $('help-form').dataset.kind;
  $('help-submit').disabled = true;
  setStatus('help-form-status', 'Submitting…');
  try {
    const result = await api('/api/support', {
      method: 'POST',
      body: JSON.stringify({ kind, subject: $('help-subject').value, text: $('help-text').value, priority: $('help-priority').value }),
    });
    $('help-subject').value = '';
    $('help-text').value = '';
    $('help-priority').value = 'normal';
    setStatus('help-form-status', '');
    help.justRaised = result.request.id;
    help.emailed = result.emailed;
    await loadHelp();
    location.hash = `#/help/${result.request.id}`;
  } catch (error) {
    if (handleAuthLoss(error)) return;
    setStatus('help-form-status', error.message, 'error');
  } finally {
    $('help-submit').disabled = false;
  }
});

async function openHelpRequest(id) {
  const box = $('help-view');
  box.hidden = false;
  box.innerHTML = '<p class="hint">Loading…</p>';
  try {
    const { request, team } = await api(`/api/support/${encodeURIComponent(id)}`);
    if (help.open !== id) return;
    renderHelpRequest(request, team);
  } catch (error) {
    if (handleAuthLoss(error)) return;
    box.innerHTML = `<p class="status error">${escapeHtml(error.message)}</p>`;
  }
}

function renderHelpRequest(r, team) {
  const raised = help.justRaised === r.id;
  help.justRaised = '';
  const emailNote = raised && help.emailed?.error
    ? `<p class="status warn"><span>The email with your number could not be sent:</span> <span translate="no">${escapeHtml(help.emailed.error)}</span></p>`
    : '';
  const thanks = raised
    ? `<div class="help-thanks"><strong><span>Thank you. Your number is</span> <span translate="no">${escapeHtml(r.id)}</span></strong><p>${r.kind === 'case' ? 'The support team has been told. You get an email with every answer.' : 'It is now in the list of enhancements. You get an email whenever its status changes.'}</p>${emailNote}</div>`
    : '';
  const statusOptions = Object.entries(HELP_STATUS).map(([id, [label]]) => `<option value="${id}"${id === r.status ? ' selected' : ''}>${label}</option>`).join('');
  $('help-view').innerHTML = `${thanks}
    <div class="help-head">
      <span class="help-num" translate="no">${escapeHtml(r.id)}</span>
      <span class="rp-chip">${HELP_KIND[r.kind]}</span>
      ${helpChip(r.status)}
      ${r.priority ? `<span class="hint"><span>Priority</span>: <span>${HELP_PRIORITY[r.priority] ?? r.priority}</span></span>` : ''}
    </div>
    <h2 class="help-subject" translate="no">${escapeHtml(r.subject)}</h2>
    <p class="hint"><span>Raised by</span> <span translate="no">${escapeHtml(r.requester.name || r.requester.email)}</span> · ${helpWhen(r.createdAt)}${r.tenant ? ` · <span translate="no">${escapeHtml(r.tenant)}</span>` : ''}</p>
    <ol class="help-thread">${r.conversation
      .map((m) => `<li class="help-msg${m.team ? ' team' : ''}${m.mine ? ' mine' : ''}">
        <div class="help-msg-head"><strong translate="no">${escapeHtml(m.name)}</strong>${m.team ? '<span class="rp-chip tone-info">Support team</span>' : ''}${helpWhen(m.at)}</div>
        <div class="help-msg-text" translate="no">${escapeHtml(m.text)}</div>
      </li>`)
      .join('')}</ol>
    <form class="help-reply" data-help-reply="${escapeHtml(r.id)}">
      <label class="field"><span>${r.mine ? 'Add to your request' : 'Answer'}</span><textarea name="text" rows="4" maxlength="10000" required placeholder="${r.mine ? 'More detail, or an answer to the support team' : 'Your answer: it is emailed to the person who raised it'}"></textarea></label>
      <div class="actions compact"><button type="submit" class="primary">Send</button></div>
    </form>
    ${team ? `<div class="help-set">
      <label class="field"><span>Status</span><select data-help-status data-i18n-ctx="request">${statusOptions}</select></label>
      <button type="button" data-help-set="${escapeHtml(r.id)}">Update status</button>
      <p class="hint">The person who raised it gets an email with the new status.</p>
    </div>` : ''}
    <p class="status" id="help-view-status"></p>
    <details class="disclosure help-history"><summary>Status history</summary><ul>${r.history
      .map((h) => `<li>${helpChip(h.status)} <span translate="no">${escapeHtml(h.name)}</span> · ${helpWhen(h.at)}</li>`)
      .join('')}</ul></details>`;
}

$('help-view').addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-help-reply]');
  if (!form) return;
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await api(`/api/support/${encodeURIComponent(form.dataset.helpReply)}/messages`, { method: 'POST', body: JSON.stringify({ text: form.elements.text.value }) });
    renderHelpRequest(result.request, help.team);
    $('help-view-status').innerHTML = helpEmailNote(result.emailed);
    $('help-view-status').className = `status ${result.emailed?.error ? 'warn' : 'ok'}`;
    loadHelp();
  } catch (error) {
    if (handleAuthLoss(error)) return;
    setStatus('help-view-status', error.message, 'error');
    button.disabled = false;
  }
});

$('help-view').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-help-set]');
  if (!button) return;
  const status = $('help-view').querySelector('[data-help-status]').value;
  button.disabled = true;
  try {
    const result = await api(`/api/support/${encodeURIComponent(button.dataset.helpSet)}/status`, { method: 'POST', body: JSON.stringify({ status }) });
    renderHelpRequest(result.request, help.team);
    $('help-view-status').innerHTML = helpEmailNote(result.emailed);
    $('help-view-status').className = `status ${result.emailed?.error ? 'warn' : 'ok'}`;
    loadHelp();
  } catch (error) {
    if (handleAuthLoss(error)) return;
    setStatus('help-view-status', error.message, 'error');
    button.disabled = false;
  }
});

wirePagesAndPalette();

(async function init() {
  // Sort and filter from the column headings, on every data table (public/table-tools.js).
  startTableTools({ translate: t });
  // Explanations behind a "?" (or shown, as chosen under Settings → Your appearance; kept in this browser).
  setHelpMode(helpMode());
  for (const radio of document.querySelectorAll('input[name="look-help"]')) {
    radio.checked = radio.value === helpMode();
    radio.addEventListener('change', () => radio.checked && setHelpMode(radio.value));
  }
  startHelpTips({ translate: t });
  try {
    state.health = await api('/api/health');
    if (Array.isArray(state.health.languages)) languagesChanged(state.health.languages);
    if (state.health.version) {
      $('app-version').textContent = state.health.version;
      $('app-version').hidden = false;
    }
    applyAppBranding(state.health.app);
    for (const problem of state.health.problems) console.warn(problem);
    syncNarrow();
    // Every open finding, whatever its age, in the projects scanned in the last 90 days: the old findings are
    // what this is for, and a project nobody scans any more is skipped (Narrow down changes that).
    fillPresets('activity-preset', '90d');
    fillAgePresets('any');
    renderEnginePick();
    renderFocusPick();
    updateScopeSummary();
  } catch {
    /* health is advisory only */
  }

  // Opened from an emailed reset link: that comes first, signed in or not (using it signs everyone out).
  const token = resetLinkToken();
  if (token) return showReset(token);
  // Back from the identity provider without a sign-in: the reason, by its code, once the page knows nobody is signed in.
  const ssoRefused = ssoRefusalCode();
  if (ssoRefused) history.replaceState(null, '', location.pathname + location.search);
  try {
    const session = await api('/api/session');
    if (session.signedIn) await afterSignIn(session);
    else {
      showSignIn({ setup: session.setup });
      if (ssoRefused) showSsoRefusal(ssoRefused);
      if (session.firstStart) {
        setStatus('signin-status', 'First start: sign in with the administrator email and password printed in the server (container) log.', 'ok');
      }
    }
  } catch (error) {
    showSignIn({ message: error.message });
  }
})();


// ---------------------------------------------------------------------------
// Beta: code authors and GitHub identities
// ---------------------------------------------------------------------------

const METHOD_NAMES_GITHUB = {
  localGit: 'Local git history',
  graphql: 'GraphQL batch',
  commits: 'Commit author',
  profile: 'Public profile',
};
const lines = (value) => String(value || '').split(/[\n,]+/).map((v) => v.trim()).filter(Boolean);

export function renderBeta() {
  const github = state.settings?.beta?.github ?? {};
  const authors = state.settings?.beta?.authors ?? {};
  $('gh-token-state').textContent = github.tokenSet ? '(stored)' : '(not set)';
  $('gh-api').value = github.apiUrl ?? '';
  $('gh-org').value = github.org ?? '';
  $('gh-repos').value = (github.repos ?? []).join('\n');
  $('gh-local').value = (github.localRepos ?? []).join('\n');
  $('gh-blame-github').checked = authors.useGithubBlame !== false;
  $('gh-blame-local').checked = authors.useLocalBlame !== false;
  const beta = state.settings?.beta ?? {};
  const gl = beta.gitlab ?? {};
  const az = beta.azure ?? {};
  const bb = beta.bitbucket ?? {};
  $('gl-url').value = gl.apiUrl ?? '';
  $('gl-group').value = gl.group ?? '';
  $('gl-projects').value = (gl.projects ?? []).join('\n');
  $('az-org').value = az.orgUrl ?? '';
  $('az-repos').value = (az.repos ?? []).join('\n');
  $('bb-kind').value = bb.kind || (bb.apiUrl && !/bitbucket\.org/.test(bb.apiUrl) ? 'server' : 'cloud');
  $('bb-url').value = $('bb-kind').value === 'server' ? bb.apiUrl ?? '' : '';
  $('bb-url').disabled = $('bb-kind').value !== 'server';
  $('bb-user').value = bb.username ?? '';
  $('bb-workspace').value = bb.workspace ?? '';
  $('bb-repos').value = (bb.repos ?? []).join('\n');
  for (const [id, host] of Object.entries({ gitlab: gl, azure: az, bitbucket: bb })) {
    document.querySelector(`[data-token-state="${id}"]`).textContent = host.tokenSet ? (host.tokenFromEnvironment ? '(from the .env)' : '(stored)') : '(not set)';
    const chip = document.querySelector(`[data-host-state="${id}"]`);
    chip.textContent = host.tokenSet ? 'token set' : 'not set up';
    chip.className = `chip ${host.tokenSet ? 'ok' : ''}`;
  }
  renderIdentityMethods();
  renderBetaScope();
  const connected = [github.tokenSet, gl.tokenSet, az.tokenSet, bb.tokenSet].filter(Boolean).length;
  $('hosts-count').textContent = connected ? String(connected) : '';
}

/** Which projects "Find code authors" covers: the Workbench's selection, or all it shows. */
// ---- Labs → Fusion results (Beta; src/fusion-ai.js) -------------------------------------------------
// The AI-generated SAST results of each project's latest scan, loaded on the page's own line and kept with
// the session. Fusion (the traditional engine supports the language too) and LAST (the AI engine alone) are
// ticked apart: the figures, the projects, the side panel, the exports and the credits all follow the ticks.
const FUSION_ENGINES_KEY = 'mz-fusion-engines';
const FUSION_SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

function fusionEngines() {
  const ticked = [$('fusion-show-fusion')?.checked && 'FUSION', $('fusion-show-last')?.checked && 'LAST'].filter(Boolean);
  return ticked.length ? ticked : ['FUSION', 'LAST'];
}
function setFusionEngines(engines) {
  const list = shownEngines(engines);
  if ($('fusion-show-fusion')) $('fusion-show-fusion').checked = list.includes('FUSION');
  if ($('fusion-show-last')) $('fusion-show-last').checked = list.includes('LAST');
}
try {
  const kept = JSON.parse(localStorage.getItem(FUSION_ENGINES_KEY) ?? 'null');
  if (Array.isArray(kept)) setFusionEngines(kept);
} catch {}

/** What the server holds for this session; read it now when there is a fetch but no Fusion read yet. */
export async function loadFusion() {
  if (!can('feature.fusionResults') || fusion.loading) return;
  loadFusionTrouble();
  try {
    const { fusion: data, scope, credits } = await api('/api/beta/fusion');
    fusion.data = data;
    fusion.scope = scope;
    fusion.credits = credits;
    // The line shows what it last loaded.
    if (scope?.own && !$('fusion-apps-in').value && !$('fusion-projects-in').value) {
      $('fusion-apps-in').value = scope.own.applications.join(', ');
      $('fusion-projects-in').value = scope.own.projects.join(', ');
    }
    renderFusion();
  } catch (error) {
    if (!handleAuthLoss(error)) showError('fusion-status', error);
  }
}

async function readFusion({ quiet = false } = {}) {
  if (!can('feature.fusionResults')) return;
  if (fusion.loading) return fusion.loading;
  if (!quiet) setStatus('fusion-status', 'Reading Fusion results…');
  fusion.loading = (async () => {
    try {
      const { fusion: data, scope, credits } = await api('/api/beta/fusion/read', { method: 'POST', body: '{}', quiet });
      fusion.data = data;
      fusion.scope = scope;
      fusion.credits = credits;
      fusionStatus(data);
    } catch (error) {
      if (!handleAuthLoss(error)) showError('fusion-status', error);
    } finally {
      fusion.loading = null;
      if (fusionTrouble.on) loadFusionTrouble();
      renderFusion();
      if (state.projects.length) renderProjects();
    }
  })();
  return fusion.loading;
}

/** The page's status and state chips, and "Only AI-triaged": what narrows the projects, the panel and the exports. */
const fusionFilter = { status: '', state: '', aiTriaged: false };
const fusionFilterNow = () => (filtering(fusionFilter) ? { ...fusionFilter } : null);
/** Fusion's and LAST's colours as this page shows them (the look's, or the person's own): for the HTML report. */
const fusionColours = () => {
  const css = getComputedStyle(document.documentElement);
  const hex = (v) => (/^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim() : '');
  return { fusion: hex(css.getPropertyValue('--scan-fusion')), last: hex(css.getPropertyValue('--scan-last')) };
};

/** Whether the three blocks under the figures line are open: kept for this browser only. */
const FUSION_DETAILS_KEY = 'mz.fusion.details';
function fusionDetailsOpen() {
  try {
    return localStorage.getItem(FUSION_DETAILS_KEY) === '1';
  } catch {
    return false;
  }
}
document.addEventListener('click', (event) => {
  if (!event.target.closest('#fusion-details')) return;
  try {
    localStorage.setItem(FUSION_DETAILS_KEY, fusionDetailsOpen() ? '0' : '1');
  } catch {}
  renderFusion();
});

/** The Fusion page's projects table, a column each: its heading, its cell, and what it sorts and filters by. */
const fusionCell = {
  count: (n, cls = '') => `<td class="num c-count ${n ? cls : 'zero'}">${fmt(n)}</td>`,
  maybe: (n) => `<td class="num${n === null || n === undefined ? ' zero' : ''}">${n === null || n === undefined ? '—' : fmt(n)}</td>`,
};
const FUSION_COLUMNS = [
  { id: 'project', label: 'Project', fixed: true, sort: (r) => r.name, cell: (r) => `<td class="fusion-proj-name"><button type="button" class="link" data-fusion-project="${escapeHtml(r.projectId)}" title="Show its vulnerabilities">${escapeHtml(r.name)}</button></td>` },
  { id: 'scan', label: 'Scan', title: 'Fusion: its latest scan ran the AI engine with Fusion on. LAST: with Fusion off (LLM-based scanning alone).', sort: (r) => SCAN_TYPE_LABEL[r.scanType] ?? r.scanType, cell: (r) => `<td><span class="scan-tag scan-tag-${escapeHtml(r.scanType)}">${escapeHtml(SCAN_TYPE_LABEL[r.scanType] ?? r.scanType)}</span></td>` },
  {
    id: 'languages',
    label: 'Languages',
    title: 'SAST: the languages its latest scan\'s SAST engine scanned. LAST: those of what the AI engine found in a language only it covers',
    sort: (r) => [...r.sastLanguages, ...r.lastLanguages].join(', '),
    cell: (r) => `<td class="fusion-langs">${r.sastLanguages.length ? `<span class="fusion-lang-line"><b>SAST</b> <span translate="no">${escapeHtml(r.sastLanguages.join(', '))}</span></span>` : ''}${r.lastLanguages.length ? `<span class="fusion-lang-line is-last"><b>LAST</b> <span translate="no">${escapeHtml(r.lastLanguages.join(', '))}</span></span>` : ''}${r.sastLanguages.length || r.lastLanguages.length ? '' : '<span class="zero">—</span>'}</td>`,
  },
  { id: 'model', label: 'Model', title: 'The model its latest scan ran with, and where that was set: the scan, the project, the tenant, or Checkmarx One itself', sort: (r) => r.model, cell: (r) => `<td class="fusion-model-cell">${r.model ? `<span class="fusion-model" translate="no" title="${escapeHtml(MODEL_FROM[r.modelFrom] ?? 'as Checkmarx One says')}">${escapeHtml(r.model)}</span>` : '<span class="zero" title="Checkmarx One did not say">—</span>'}</td>` },
  { id: 'loc', label: 'LOC', num: true, title: 'Lines of code its latest scan counted', sort: (r) => r.loc, cell: (r) => fusionCell.maybe(r.loc) },
  {
    id: 'results',
    label: 'AI results',
    title: 'What the AI engine reported, by severity (no traditional SAST results)',
    sort: { value: (r) => r.total, text: (r) => FUSION_SEVERITY_ORDER.filter((k) => r[k]).map((k) => `${r[k]} ${SEVERITY_LABEL[k]}`).join(' ') },
    cell: (r) => `<td class="fusion-sevs">${FUSION_SEVERITY_ORDER.filter((k) => r[k]).map((k) => `<span class="fusion-sev fusion-sev-${k.toLowerCase()}" title="${escapeHtml(`${fmt(r[k])} ${SEVERITY_LABEL[k].toLowerCase()}`)}">${fmt(r[k])} ${escapeHtml(SEVERITY_LABEL[k][0])}</span>`).join('') || '<span class="zero">none</span>'}</td>`,
  },
  {
    id: 'share',
    label: 'AI share of SAST',
    num: true,
    title: 'The AI engine\'s results as a share of all its latest scan\'s SAST results: 20 of 100 is 20%',
    sort: { value: (r) => r.aiShare, text: (r) => (r.aiShare === null ? '' : `${r.aiShare}%`) },
    cell: (r) => (r.aiShare === null ? '<td class="num zero" title="Checkmarx One did not say how many SAST results its latest scan has">—</td>' : `<td class="num" title="${escapeHtml(`${fmt(r.total)} of ${fmt(r.sastResults)} SAST results`)}">${fmt(r.aiShare)}%</td>`),
  },
  { id: 'toVerify', label: 'To verify', num: true, title: 'Open risks still in Risk Hub\'s default state, To verify', sort: (r) => r.TO_VERIFY, cell: (r) => fusionCell.count(r.TO_VERIFY) },
  { id: 'confirmed', label: 'Confirmed', num: true, title: 'Open risks confirmed (by people or by AI Triage)', sort: (r) => r.CONFIRMED, cell: (r) => fusionCell.count(r.CONFIRMED) },
  {
    id: 'credits',
    label: 'Credits, latest scan',
    num: true,
    title: 'Credits its latest scan used: none for a LAST scan or with Fusion credits disabled; ≈ an estimate from the Fusion credits it used over the last year, per Fusion scan',
    sort: { value: (r) => r.scanCredits?.credits ?? null, text: (r) => scanCreditsText([r]) },
    cell: (r) => `<td class="num${r.scanCredits ? '' : ' zero'}" title="${escapeHtml(scanCreditsWhy(r))}">${escapeHtml(scanCreditsText([r]))}</td>`,
  },
  { id: 'latest', label: 'Latest scan', sort: { value: (r) => (r.scanAt ? Date.parse(r.scanAt) : null), text: (r) => (r.scanAt ? fmtDateTime(r.scanAt) : '') }, cell: (r) => `<td class="nowrap">${escapeHtml(r.scanAt ? fmtDateTime(r.scanAt) : '—')}</td>` },
];
const fusionColumnsShown = () => columnsShownOf('fusion-projects', FUSION_COLUMNS);
/** The sort and filters belong to one arrangement of the columns: another starts afresh. */
const fusionTableKey = () => `fusion-projects:${fusionColumnsShown().map((c) => c.id).join(',')}`;
function renderFusionHead() {
  const shown = fusionColumnsShown();
  $('fusion-table').dataset.tt = fusionTableKey();
  $('fusion-head').innerHTML = shown.map((c) => `<th${c.num ? ' class="num"' : ''}${c.title ? ` title="${escapeHtml(c.title)}"` : ''}>${escapeHtml(c.label)}</th>`).join('');
}
columnMenu($('fusion-cols'), 'fusion-projects', FUSION_COLUMNS, () => {
  renderFusionHead();
  renderFusion();
});
renderFusionHead();

function renderFusion() {
  const tiles = $('fusion-tiles');
  if (!tiles) return;
  const { data, scope } = fusion;
  const engines = fusionEngines();
  const label = engineLabel(engines);
  const filter = fusionFilterNow();
  $('fusion-read').disabled = !scope?.projects;
  // Beside each tick: how many projects' latest scans were of that kind.
  $('fusion-n-fusion').textContent = data ? fmt(data.kinds?.fusion ?? data.scanned ?? 0) : '';
  $('fusion-n-last').textContent = data ? fmt(data.kinds?.last ?? 0) : '';
  if (!data) {
    tiles.innerHTML = '';
    $('fusion-over').hidden = true;
    $('fusion-filters').hidden = true;
    $('fusion-body').innerHTML = `<tr><td colspan="11" class="hint">${escapeHtml('Choose applications or projects above (or none, for every project), then Load results.')}</td></tr>`;
    $('fusion-proj-count').textContent = '';
    $('fusion-foot').textContent = '';
    $('fusion-act-scope').textContent = 'Load results to act on them.';
    renderFusionLanes();
    return;
  }
  const t = fusionTiles(data, scope, engines, filter);
  const tile = (value, name, cls = '') => `<div class="${cls}"><span class="value">${escapeHtml(value)}</span><span class="label">${escapeHtml(name)}</span></div>`;
  renderFusionOverview(t);
  // One thin line, as FAE Flush's: the three blocks open under Details.
  const kinds = data.kinds ?? { fusion: data.scanned ?? 0, last: 0 };
  const out = (Number(data.notFusion) || 0) + (Number(data.noAi) || 0);
  const sev = FUSION_SEVERITY_ORDER.filter((k) => t.found[k]).map((k) => `<span class="fusion-sev fusion-sev-${k.toLowerCase()}" title="${escapeHtml(`${fmt(t.found[k])} ${SEVERITY_LABEL[k].toLowerCase()}`)}">${fmt(t.found[k])} ${escapeHtml(SEVERITY_LABEL[k][0])}</span>`).join('');
  const left = data.tenant?.credits?.available;
  const open = fusionDetailsOpen();
  tiles.innerHTML = [
    tile(fmt(t.found.projects), 'projects'),
    `<div class="fusion-split"><span class="fusion-word">${fmt(kinds.fusion)} Fusion</span> · <span class="last-word">${fmt(kinds.last)} LAST</span>${out ? ` · <span title="${escapeHtml([data.notFusion ? `${fmt(data.notFusion)} project(s) left out: their latest scan did not run the AI engine.` : '', data.noAi ? `${fmt(data.noAi)} project(s) left out: their latest scan's AI engine reported nothing.` : ''].filter(Boolean).join(' '))}">${fmt(out)} left out</span>` : ''}</div>`,
    tile(fmt(t.found.results), 'AI results'),
    sev ? `<div class="fusion-sevs">${sev}</div>` : '',
    tile(scanCreditsText(fusionRows(data, scope, engines, filter)), 'credits, latest scans'),
    left === null || left === undefined ? '' : tile(fmt(left), 'credits left (tenant)'),
    `<button type="button" class="link fusion-details-toggle" id="fusion-details" aria-expanded="${open}" aria-controls="fusion-over">${escapeHtml(open ? 'Hide details' : 'Details')}</button>`,
  ].join('');
  $('fusion-over').hidden = !open;
  renderFusionChips();
  // The model picker: the models the projects' latest scans ran with.
  const models = [...new Set(fusionRows(data, scope, engines).map((r) => r.model).filter(Boolean))].sort();
  const picked = $('fusion-model').value;
  $('fusion-model').innerHTML = `<option value="">Any model</option>${models.map((m) => `<option value="${escapeHtml(m)}"${m === picked ? ' selected' : ''}>${escapeHtml(m)}</option>`).join('')}`;
  const rows = fusionProjectsFiltered();
  const all = fusionRows(data, scope, engines, filter).length;
  $('fusion-proj-count').textContent = all ? (rows.length === all ? fmt(all) : `${fmt(rows.length)} / ${fmt(all)}`) : '';
  $('fusion-act-scope').textContent = rows.length ? `All ${fmt(rows.length)} shown project(s) · ${label} results` : `No project shown · ${label} results`;
  $('fusion-foot').textContent = rows.length ? `${fmt(rows.length)} project(s) with results from the AI engine · gold: Fusion, pink: LAST · click a project to see its vulnerabilities` : '';
  const rowsShown = sortAndFilter(fusionTableKey(), rows, fusionColumnsShown().map((c) => c.sort ?? null), renderFusion);
  $('fusion-body').innerHTML = rowsShown.length
    ? rowsShown.map((r) => `<tr data-fusion-row="${escapeHtml(r.projectId)}" class="scan-row-${escapeHtml(r.scanType)}${r.projectId === fusion.open ? ' is-open' : ''}">${fusionColumnsShown().map((c) => c.cell(r)).join('')}</tr>`).join('')
    : `<tr><td colspan="${fusionColumnsShown().length}" class="hint">${escapeHtml(all ? 'No project matches.' : filter ? 'No project has risks that match.' : `No project's latest scan has results from the AI engine (${label}).`)}${!all && !filter && can('credits.limit') ? ' <button type="button" class="sm" data-fusion-reread>Read Fusion again</button>' : ''}</td></tr>`;
  if (fusion.open) renderFusionSide();
  fusionFocusChanged();
}

/** The credits the latest scans of `rows` used: "0", "≈ 12" (estimated) or "—" (not known). */
function scanCreditsText(rows) {
  const known = rows.filter((r) => r.scanCredits);
  if (!known.length) return '—';
  const total = Math.round(known.reduce((n, r) => n + r.scanCredits.credits, 0) * 10) / 10;
  return `${known.some((r) => r.scanCredits.estimate) ? '≈ ' : ''}${fmt(total)}`;
}
/** Why a project's latest scan shows the credits it does. */
function scanCreditsWhy(r) {
  if (!r.scanCredits) return 'Checkmarx One did not say what its latest scan used';
  if (!r.scanCredits.estimate) return r.scanType === 'last' ? 'A LAST scan: no Fusion credits' : 'Its latest scan said: Fusion credits are disabled';
  return 'Estimated: the Fusion credits it used over the last year, per Fusion scan (Checkmarx One does not say one scan’s own)';
}

/** The three blocks above the figures: the projects by scan type, what the AI engine added, the tenant's credits. */
function renderFusionOverview(t) {
  const box = $('fusion-over');
  const data = fusion.data;
  const known = (n) => (n === null || n === undefined ? '—' : fmt(n));
  const kinds = data.kinds ?? { fusion: data.scanned ?? 0, last: 0 };
  // Without AI results: no AI engine in the latest scan, or it reported nothing (left out).
  const none = (Number(data.notFusion) || 0) + (Number(data.noAi) || 0);
  const of = Math.max(1, kinds.fusion + kinds.last + none);
  const pct = (n) => `${((n / of) * 100).toFixed(2)}%`;
  const scope = data.usage?.scope;
  const period = (PERIOD_LABEL[data.usage?.period] ?? '').toLowerCase();
  const ai = data.tenant?.ai;
  const onOff = (v) => (v === true ? 'on' : v === false ? 'off' : 'not said');
  const kv = (rows) => `<dl class="fusion-kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const projects = `<section class="fusion-card"><h4>Projects</h4>
    <div class="fusion-big"><div class="is-fusion"><b>${fmt(kinds.fusion)}</b><span>latest scan Fusion</span></div><div class="is-last"><b>${fmt(kinds.last)}</b><span>latest scan LAST</span></div><div><b>${fmt(none)}</b><span>no AI results in latest scan</span></div></div>
    <div class="fusion-meter" role="img" aria-label="${escapeHtml(`${kinds.fusion} Fusion, ${kinds.last} LAST, ${none} without AI`)}"><i class="is-fusion" style="width:${pct(kinds.fusion)}"></i><i class="is-last" style="width:${pct(kinds.last)}"></i></div>
    ${kv([
      scope && ['Fusion scans', `<b>${fmt(scope.withFusion)}</b> of ${fmt(scope.projects)} projects had one ${escapeHtml(period ? `in the ${period}` : '')}`],
      scope && ['LAST scans', `<b>${fmt(scope.withLast)}</b> projects had one`],
      ai && ['Tenant', `<span>${escapeHtml(`Fusion ${onOff(ai.fusionEnabled)}`)}</span> · <span>${escapeHtml(`LLM-based scanning ${onOff(ai.llmBased)}`)}</span> · <span>${escapeHtml('model')}</span> ${ai.model ? `<span class="fusion-model" translate="no">${escapeHtml(ai.model)}</span>` : `<span>${escapeHtml('set by Checkmarx One')}</span>`}`],
    ])}</section>`;
  // Only what the AI engine itself found: no count of what the traditional engine also found.
  const added = `<section class="fusion-card"><h4>AI results <small>latest scans</small></h4>
    <div class="fusion-big"><div><b>${fmt(t.found.results)}</b><span>${escapeHtml('found by the AI engine alone')}</span></div></div>
    ${kv([
      t.models.length && ['Models', t.models.map(([m, n]) => `<span class="fusion-model" translate="no">${escapeHtml(m)}</span> ${fmt(n)}`).join(' · ')],
      ['Code', escapeHtml(`${known(t.code.loc)} lines${t.code.files !== null ? ` in ${fmt(t.code.files)} files` : ''}`)],
    ])}</section>`;
  const c = data.tenant?.credits;
  const held = fusion.credits?.held ?? null;
  const charged = { off: 'not charged on this tenant', reserved: 'credits reserved for each scan' }[data.tenant?.fusionCredits] ?? 'not said';
  const credits = `<section class="fusion-card"><h4>Credits</h4>
    ${c ? `<div class="fusion-big"><div><b>${fmt(c.available)}</b><span>${escapeHtml(`left of ${known(c.total)} (tenant)`)}</span></div></div>
    <div class="fusion-meter" role="img" aria-label="${escapeHtml(`${known(c.used)} of ${known(c.total)} used`)}"><i class="is-used" style="width:${c.total ? ((c.used / c.total) * 100).toFixed(2) : 0}%"></i>${held !== null && c.total ? `<i class="is-held" style="width:${((held / c.total) * 100).toFixed(2)}%"></i>` : ''}</div>` : `<p class="hint">${escapeHtml('Checkmarx One did not say what this tenant has left.')}</p>`}
    ${kv([
      c && ['Used', escapeHtml(`${known(c.used)} · ${known(c.actionsPerformed)} actions`)],
      held !== null && ['Given to projects', `${fmt(held)}${c ? ` of ${fmt(c.available)} · <span class="${held <= c.available ? 'ok-text' : 'bad-text'}">${held <= c.available ? 'within what is left' : 'more than is left'}</span>` : ''}`],
      ['Fusion scans', escapeHtml(charged)],
    ])}</section>`;
  box.innerHTML = projects + added + credits;
}

/** Status and state chips with how many open (or fixed) risks each has, for the engines shown. */
function renderFusionChips() {
  const box = $('fusion-filters');
  const data = fusion.data;
  box.hidden = !data;
  if (!data) return;
  const c = countsFor(data.totals, fusionEngines()) ?? {};
  const chip = (kind, value, text, n) => `<button type="button" class="sm fusion-chip" data-fusion-filter="${kind}" data-value="${escapeHtml(value)}" aria-pressed="${fusionFilter[kind] === value}">${escapeHtml(text)}${n === null ? '' : ` <small>${fmt(n)}</small>`}</button>`;
  $('fusion-status-chips').innerHTML = chip('status', '', 'All', null) + FUSION_STATUSES.map((k) => chip('status', k, wordsLabel(k), c[k] ?? 0)).join('');
  $('fusion-state-chips').innerHTML = chip('state', '', 'Any', null) + FUSION_STATES.map((k) => chip('state', k, STATE_LABEL[k], c[k] ?? 0)).join('');
  $('fusion-ai-triaged').checked = fusionFilter.aiTriaged;
  $('fusion-n-ai-triaged').textContent = `(${fmt(c.aiTriaged ?? 0)})`;
}

function fusionProjectsFiltered() {
  const q = $('fusion-q').value.trim().toLowerCase();
  const sev = $('fusion-sev').value;
  const model = $('fusion-model').value;
  return fusionRows(fusion.data, fusion.scope, fusionEngines(), fusionFilterNow()).filter((r) => (!q || r.name.toLowerCase().includes(q)) && (!sev || r[sev] > 0) && (!model || r.model === model));
}

document.addEventListener('click', (event) => {
  const chip = event.target.closest('[data-fusion-filter]');
  if (!chip) return;
  fusionFilter[chip.dataset.fusionFilter] = chip.dataset.value;
  renderFusion();
});
$('fusion-ai-triaged')?.addEventListener('change', (event) => {
  fusionFilter.aiTriaged = event.target.checked;
  renderFusion();
});


for (const id of ['fusion-q', 'fusion-sev', 'fusion-model']) $(id)?.addEventListener('input', renderFusion);
for (const id of ['fusion-show-fusion', 'fusion-show-last']) {
  $(id)?.addEventListener('change', (event) => {
    // At least one stays ticked: both off would show nothing.
    if (!$('fusion-show-fusion').checked && !$('fusion-show-last').checked) event.target.checked = true;
    try {
      localStorage.setItem(FUSION_ENGINES_KEY, JSON.stringify(fusionEngines()));
    } catch {}
    renderFusion();
    if (fusion.open) loadFusionSideCredits();
    if (state.projects.length) renderProjects();
  });
}

/**
 * The credits the lanes show are for what the page shows: the server is told the ticks and the projects the
 * filters leave (once they settle), and acts on those only.
 */
let fusionFocusTimer = null;
let fusionFocusSent = '';
function fusionFocusBody() {
  return { engines: fusionEngines(), projectIds: fusion.data ? fusionProjectsFiltered().map((r) => r.projectId) : null };
}
function fusionFocusChanged() {
  if (!fusion.data || !can('credits.limit')) return renderFusionLanes();
  const body = JSON.stringify(fusionFocusBody());
  if (body === fusionFocusSent) return renderFusionLanes();
  clearTimeout(fusionFocusTimer);
  fusionFocusTimer = setTimeout(async () => {
    try {
      const { credits } = await api('/api/beta/fusion/credits', { method: 'POST', body, quiet: true });
      fusionFocusSent = body;
      fusion.credits = credits;
    } catch (error) {
      if (!handleAuthLoss(error)) showError('fusion-act-status', error);
    }
    renderFusionLanes();
  }, 250);
}

/** A CSV download, cells quoted as needed (and formulas defused). */
function downloadCsv(name, lines) {
  const cell = (v) => { const t = String(v ?? ''); return /[",\n\r]/.test(t) || /^[=+\-@]/.test(t) ? `"${(/^[=+\-@]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"` : t; };
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([lines.map((l) => l.map(cell).join(',')).join('\n')], { type: 'text/csv' }));
  link.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

const fusionFileName = (engines) => engineLabel(engines).toLowerCase().replace(/ and /, '-').replace(/\s+/g, '-');

$('fusion-proj-csv')?.addEventListener('click', () => {
  if (!fusion.data) return setStatus('fusion-status', 'Load results first.', 'warn');
  const engines = fusionEngines();
  downloadCsv(`${fusionFileName(engines)}-projects`, [['Project', 'Scan', 'Model', 'Model set', 'LOC', 'Files', 'AI results', 'Credits, latest scan', 'Credits estimated', 'Critical', 'High', 'Medium', 'Low', 'Total', 'New', 'Recurrent', 'Fixed', ...FUSION_STATES.map((k) => STATE_LABEL[k]), 'AI-triaged', 'Latest scan', 'Scan id', 'Link'],
    ...fusionProjectsFiltered().map((r) => [r.name, SCAN_TYPE_LABEL[r.scanType] ?? r.scanType, r.model, MODEL_FROM[r.modelFrom] ?? r.modelFrom, r.loc ?? '', r.files ?? '', r.total ?? 0, r.scanCredits ? r.scanCredits.credits : '', r.scanCredits ? (r.scanCredits.estimate ? 'yes' : 'no') : '', r.CRITICAL, r.HIGH, r.MEDIUM, r.LOW, r.total, r.NEW, r.RECURRENT, r.fixedKnown ? r.FIXED : '', ...FUSION_STATES.map((k) => r[k]), r.aiTriaged, r.scanAt ?? '', r.scanId, r.url])]);
});

/** The HTML report of what is shown (one project's, with `projectId`), downloaded. */
function downloadFusionReport(projectId = null) {
  if (!fusion.data) return setStatus('fusion-status', 'Load results first.', 'warn');
  const engines = fusionEngines();
  const html = fusionReportHtml(fusion.data, fusion.scope, { appName: $('app-name')?.textContent?.trim() || 'CxMissionZero', organisation: state.me?.organisationName ?? '', generatedAt: new Date().toISOString(), fmtDate: (iso) => fmtDateTime(iso), engines, projectId, filter: fusionFilterNow(), colours: fusionColours() });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  link.download = `${fusionFileName(engines)}-results${projectId ? '-project' : ''}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.html`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
$('fusion-report')?.addEventListener('click', () => downloadFusionReport());

// ---- A project's vulnerabilities, in the side panel: as the Checkmarx One results page shows them, each
// opening there; filtered by severity or status, 100 at a time.
const FUSION_SIDE_PAGE = 100;
let fusionSideShown = FUSION_SIDE_PAGE;
let fusionSideChip = '';
let fusionSideState = '';
let fusionSideFrom = null;
const FUSION_CHIPS = [['', 'All'], ['CRITICAL', 'Critical'], ['HIGH', 'High'], ['MEDIUM', 'Medium'], ['LOW', 'Low'], ['NEW', 'New'], ['RECURRENT', 'Recurrent'], ['FIXED', 'Fixed']];
const fusionChipMatch = (chip, r) => !chip || r.severity === chip || r.statusKey === chip;
const fusionStateMatch = (state, r) => !state || r.stateKey === state;

function openFusionSide(projectId) {
  fusionSideFrom = document.activeElement;
  fusion.open = projectId;
  fusionSideShown = FUSION_SIDE_PAGE;
  fusionSideChip = '';
  fusionSideState = '';
  $('fusion-drawer').hidden = false;
  $('fusion-side-status').textContent = '';
  renderFusionSide();
  loadFusionSideCredits();
  for (const tr of document.querySelectorAll('#fusion-body tr[data-fusion-row]')) tr.classList.toggle('is-open', tr.dataset.fusionRow === projectId);
  $('fusion-drawer').querySelector('[data-fusion-close].icon-btn')?.focus();
}
/**
 * AI Triage and AI Remediation for the project in the side panel (Admins): its own credits, allocated and run
 * for this project's results alone (the engines ticked), without changing what the page's bar acts on.
 */
const fusionSide = { credits: null, seq: 0 };
async function loadFusionSideCredits() {
  const box = $('fusion-side-lanes');
  if (!can('credits.limit') || !fusion.open) {
    box.hidden = true;
    return;
  }
  const seq = ++fusionSide.seq;
  try {
    const { credits } = await api('/api/beta/fusion/credits', { method: 'POST', body: JSON.stringify(fusionSideBody()), quiet: true });
    if (seq !== fusionSide.seq) return;
    fusionSide.credits = credits;
  } catch (error) {
    if (!handleAuthLoss(error)) showError('fusion-side-status', error);
  }
  renderFusionSideLanes();
}
const fusionSideBody = () => ({ once: true, engines: fusionEngines(), projectIds: [fusion.open] });
function renderFusionSideLanes() {
  const box = $('fusion-side-lanes');
  const c = fusionSide.credits;
  box.hidden = !can('credits.limit') || !c;
  if (box.hidden) return;
  if (!c.matched) {
    box.innerHTML = `<p class="hint">${escapeHtml(`No ${engineLabel(fusionEngines())} results here to run AI on.`)}</p>`;
    return;
  }
  const ways = { allocate: can('credits.allocate'), run: can('triage.run') };
  box.innerHTML = `<div class="credit-lanes">${creditLane('side', 'triage', creditTiers(c.triage, c.left.triage), ways, 'fusion')}${creditLane('side', 'remediation', creditTiers(c.remediation, c.left.remediation), ways, 'fusion')}</div>`;
}

function closeFusionSide() {
  if ($('fusion-drawer').hidden) return;
  $('fusion-drawer').hidden = true;
  fusion.open = null;
  for (const tr of document.querySelectorAll('#fusion-body tr.is-open')) tr.classList.remove('is-open');
  fusionSideFrom?.focus?.();
}
function fusionSideRows() {
  const all = fusionResultRows(fusion.data, fusion.scope, fusionEngines(), fusion.open, fusionFilterNow());
  return { all, rows: all.filter((r) => fusionChipMatch(fusionSideChip, r) && fusionStateMatch(fusionSideState, r)) };
}
function renderFusionSide() {
  const projectId = fusion.open;
  if (!projectId || !fusion.data) return closeFusionSide();
  const p = fusion.data.projects?.[projectId] ?? {};
  const name = fusion.scope?.names?.[projectId] ?? p.projectName ?? projectId;
  const engines = fusionEngines();
  const { all, rows } = fusionSideRows();
  const type = p.scanType ?? 'fusion';
  $('fusion-side-title').innerHTML = `${escapeHtml(name)} <span class="scan-tag scan-tag-${escapeHtml(type)}">${escapeHtml(SCAN_TYPE_LABEL[type] ?? type)}</span>`;
  $('fusion-drawer').dataset.scanType = type;
  $('fusion-side-meta').textContent = `Latest scan ${p.scanAt ? fmtDateTime(p.scanAt) : '—'}${p.scanId ? ` · scan ${p.scanId.slice(0, 8)}` : ''} · ${fmt(all.length)} ${engineLabel(engines)} result(s)`;
  // What its latest scan ran with and added, its size, and the credits it used.
  const row = fusionRows(fusion.data, fusion.scope, engines).find((r) => r.projectId === projectId) ?? {};
  const fact = (label, value, note = '', cls = '') => `<div${cls ? ` class="${cls}"` : ''}><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b>${note ? `<small>${escapeHtml(note)}</small>` : ''}</div>`;
  const charged = { off: 'Not charged', reserved: 'Reserved' }[p.fusionCredits ?? ''] ?? '—';
  $('fusion-side-facts').innerHTML = [
    fact('Model', row.model || '—', row.model ? MODEL_FROM[row.modelFrom] ?? 'as Checkmarx One says' : 'Checkmarx One did not say', 'fusion-model-fact'),
    fact('AI results', fmt(row.total ?? 0), 'found by the AI engine alone'),
    fact('Code', row.loc === null || row.loc === undefined ? '—' : `${fmt(row.loc)} LOC`, [row.files !== null && row.files !== undefined ? `${fmt(row.files)} files` : '', row.engineVersion ? `SAST ${row.engineVersion.split('-')[0]}` : ''].filter(Boolean).join(' · ')),
    fact('Credits, latest scan', scanCreditsText([row]), scanCreditsWhy(row)),
    fact('Fusion credits', charged, p.fusionCredits === 'off' ? 'its scan said: Fusion credits are disabled' : p.fusionCredits === 'reserved' ? 'reserved for its scan' : type === 'last' ? 'a LAST scan' : 'its scan did not say'),
  ].join('');
  const open = $('fusion-side-open');
  open.hidden = !p.url;
  if (p.url) open.href = p.url;
  // Only the chips that have something, so a chip never shows nothing by itself.
  $('fusion-side-chips').innerHTML = FUSION_CHIPS.map(([value, text]) => [value, text, all.filter((r) => fusionChipMatch(value, r)).length])
    .filter(([value, , n]) => !value || n)
    .map(([value, text, n]) => `<button type="button" class="sm fusion-chip" data-fusion-chip="${escapeHtml(value)}" aria-pressed="${value === fusionSideChip}">${escapeHtml(text)} ${fmt(n)}</button>`).join('');
  $('fusion-side-states').innerHTML = [['', 'Any state'], ...FUSION_STATES.map((k) => [k, STATE_LABEL[k]])].map(([value, text]) => [value, text, all.filter((r) => fusionStateMatch(value, r)).length])
    .filter(([value, , n]) => !value || n)
    .map(([value, text, n]) => `<button type="button" class="sm fusion-chip" data-fusion-side-state="${escapeHtml(value)}" aria-pressed="${value === fusionSideState}">${escapeHtml(text)}${value ? ` ${fmt(n)}` : ''}</button>`).join('');
  const date = (iso) => (iso ? fmtDateTime(iso) : '—');
  const item = (r, i) => `<details class="fusion-vuln"${i === 0 ? ' open' : ''}>
      <summary><span class="sev-dot sev-${escapeHtml(r.severity.toLowerCase())}" aria-hidden="true"></span><span class="fusion-vuln-name">${escapeHtml(r.name)}</span><span class="fusion-vuln-tags">${r.aiTriaged ? '<span class="fusion-tag fusion-AI" title="Its state was set by AI Triage">AI-triaged</span>' : ''}${r.engine ? `<span class="fusion-tag fusion-${escapeHtml(r.engine)}">${escapeHtml(ENGINE_LABEL[r.engine] ?? r.engine)}</span>` : ''}</span>
        <span class="fusion-vuln-sub">${escapeHtml([SEVERITY_LABEL[r.severity] ?? r.severity, scannerLabel(r.scanner), r.status, r.state, r.language, r.source ? fileOf(r.source) : fileOf(r.location.split(' :: ')[0])].filter(Boolean).join(' · '))}</span></summary>
      ${r.description ? `<p class="fusion-vuln-desc" translate="no">${escapeHtml(r.description)}</p>` : ''}
      <dl>
        <dt>Severity</dt><dd>${escapeHtml(SEVERITY_LABEL[r.severity] ?? r.severity)}</dd>
        <dt>Status · state</dt><dd>${escapeHtml([r.status || '—', r.state || '—'].join(' · '))}${r.aiTriaged ? ` <span class="hint">${escapeHtml('(set by AI Triage)')}</span>` : ''}</dd>
        <dt>Language</dt><dd>${escapeHtml(r.language || '—')} <span class="hint">${escapeHtml(r.engine === 'LAST' ? '(only the AI engine covers it)' : r.coveredAs ? `(traditional SAST supports it as ${r.coveredAs})` : '')}</span></dd>
        <dt>CWE</dt><dd>${r.cwe ? `CWE-${escapeHtml(String(r.cwe))}` : '—'}</dd>
        <dt>Scanner</dt><dd>${escapeHtml(scannerLabel(r.scanner))}</dd>
        ${r.source ? `<dt>Source</dt><dd><code>${escapeHtml(r.source)}</code>${r.sourceNode ? ` · ${escapeHtml(r.sourceNode)}` : ''}</dd>
        <dt>Sink</dt><dd>${r.sink ? `<code>${escapeHtml(r.sink)}</code>` : '—'}${r.sinkNode ? ` · ${escapeHtml(r.sinkNode)}` : ''}</dd>` : `<dt>Where</dt><dd>${r.location ? `<code>${escapeHtml(r.location)}</code>` : '—'}</dd>`}
        <dt>First found</dt><dd>${escapeHtml(date(r.firstFoundAt))}</dd>
        <dt>Last found</dt><dd>${escapeHtml(date(r.foundAt))}</dd>
        <dt>Result id</dt><dd><code>${escapeHtml(r.id || '—')}</code></dd>
        ${r.url ? `<dt></dt><dd><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml('Open this result in Checkmarx One')} ↗</a></dd>` : ''}
      </dl></details>`;
  const more = rows.length - fusionSideShown;
  $('fusion-side-list').innerHTML = rows.length
    ? rows.slice(0, fusionSideShown).map(item).join('') + (more > 0 ? `<p class="table-more"><button type="button" class="ghost sm" data-fusion-side-more>${escapeHtml(`Show ${fmt(Math.min(FUSION_SIDE_PAGE, more))} more of ${fmt(more)}`)}</button></p>` : '')
    : `<p class="hint">${escapeHtml(`No ${engineLabel(engines)} results in this project.`)}</p>`;
}

document.addEventListener('click', (event) => {
  if (event.target.closest('[data-fusion-close]')) return closeFusionSide();
  const chip = event.target.closest('[data-fusion-chip]');
  if (chip) {
    fusionSideChip = chip.dataset.fusionChip;
    fusionSideShown = FUSION_SIDE_PAGE;
    return renderFusionSide();
  }
  const sideState = event.target.closest('[data-fusion-side-state]');
  if (sideState) {
    fusionSideState = sideState.dataset.fusionSideState;
    fusionSideShown = FUSION_SIDE_PAGE;
    return renderFusionSide();
  }
  if (event.target.closest('[data-fusion-side-more]')) {
    fusionSideShown += FUSION_SIDE_PAGE;
    return renderFusionSide();
  }
  const row = event.target.closest('[data-fusion-project], tr[data-fusion-row]');
  if (row) openFusionSide(row.dataset.fusionProject ?? row.dataset.fusionRow);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('fusion-drawer')?.hidden) closeFusionSide();
});
$('fusion-side-csv')?.addEventListener('click', () => {
  const { rows } = fusionSideRows();
  const name = fusion.scope?.names?.[fusion.open] ?? fusion.open ?? 'project';
  downloadCsv(`${fusionFileName(fusionEngines())}-${String(name).replace(/[^\w.-]+/g, '-').slice(0, 60)}`, [['Severity', 'Scanner', 'Engine', 'Vulnerability', 'Status', 'State', 'Found by AI', 'State set by AI Triage', 'Language', 'Supported by SAST as', 'CWE', 'Where', 'Source', 'Sink', 'Description', 'First found', 'Last found', 'Project', 'Result id', 'Link', 'Project link'],
    ...rows.map((r) => [SEVERITY_LABEL[r.severity] ?? r.severity, scannerLabel(r.scanner), ENGINE_LABEL[r.engine] ?? r.engine, r.name, r.status, r.state, r.ai ? 'Yes' : 'No', r.aiTriaged ? 'Yes' : 'No', r.language, r.coveredAs, r.cwe ? `CWE-${r.cwe}` : '', r.location, r.source, r.sink, r.description, r.firstFoundAt ?? '', r.foundAt ?? '', r.project, r.id, r.url, r.projectUrl])]);
});
$('fusion-side-report')?.addEventListener('click', () => downloadFusionReport(fusion.open));

/** What the read found, said once above the figures. */
function fusionStatus(data) {
  // One sentence each, so each is translated whole. The Fusion, LAST and left-out counts are in the figures line.
  const sentences = [
    data.noScan ? `${fmt(data.noScan)} project(s) have no completed scan.` : '',
    data.failures?.length ? `${fmt(data.failures.length)} project(s) could not be read.` : '',
  ].filter(Boolean);
  setStatus('fusion-status', '', data.failures?.length ? 'warn' : 'muted');
  $('fusion-status').innerHTML = sentences.map((line) => `<span>${escapeHtml(line)}</span>`).join(' ');
  $('fusion-tried').innerHTML = '';
}
$('fusion-scope')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (fusion.loading) return;
  const button = $('fusion-fetch');
  button.disabled = true;
  setStatus('fusion-status', 'Loading results…');
  fusion.loading = (async () => {
    try {
      const { fusion: data, scope, credits } = await api('/api/beta/fusion/fetch', { method: 'POST', body: JSON.stringify({ applications: $('fusion-apps-in').value, projects: $('fusion-projects-in').value }) });
      Object.assign(fusion, { data, scope, credits });
      fusionFocusSent = '';
      fusionStatus(data);
    } catch (error) {
      if (!handleAuthLoss(error)) showError('fusion-status', error);
    } finally {
      fusion.loading = null;
      button.disabled = false;
      if (fusionTrouble.on) loadFusionTrouble();
      renderFusion();
      if (state.projects.length) renderProjects();
    }
  })();
});
$('fusion-read')?.addEventListener('click', () => {
  fusionFocusSent = '';
  readFusion();
});

/**
 * Admins act on what the page shows as on a tracked report's Triage tab: the bar's buttons open the lanes,
 * per kind of credit "Allocate for <next severities>" and "<Triage|Remediate> <what the credits cover>",
 * gold once the credits are there. Only the results of the engines ticked, in the projects shown, count.
 */
function renderFusionLanes() {
  const box = $('fusion-lanes');
  if (!box) return;
  const c = fusion.credits;
  const admin = can('credits.limit');
  $('fusion-act-bar').hidden = !admin;
  for (const b of document.querySelectorAll('[data-fusion-lane]')) b.setAttribute('aria-pressed', String(b.dataset.fusionLane === fusion.lane));
  if (!admin || !fusion.data || !fusion.lane) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  if (!c?.matched) {
    box.innerHTML = `<p class="hint">${escapeHtml(`No ${engineLabel(fusionEngines())} results in the projects shown to allocate for or run AI on.`)}</p>`;
    return;
  }
  const ways = { allocate: can('credits.allocate'), run: can('triage.run') };
  const tiers = { triage: creditTiers(c.triage, c.left.triage), remediation: creditTiers(c.remediation, c.left.remediation) };
  const lanes = fusion.lane === 'both' ? ['triage', 'remediation'] : [fusion.lane];
  box.innerHTML = `<div class="credit-lanes">${lanes.map((kind) => creditLane('fusion', kind, tiers[kind], ways, 'fusion')).join('')}</div>
    <p class="hint">${escapeHtml(`${fmt(c.matched)} ${engineLabel(fusionEngines())} results, in ${fmt(c.projects)} project(s). Credits go to those projects, for these results only: 1 to check a result with AI, 3 to fix it.`)}</p>`;
}

document.addEventListener('click', async (event) => {
  const lane = event.target.closest('[data-fusion-lane]');
  if (lane) {
    fusion.lane = fusion.lane === lane.dataset.fusionLane ? null : lane.dataset.fusionLane;
    return renderFusionLanes();
  }
  const button = event.target.closest('[data-fusion-allocate], [data-fusion-triage], [data-fusion-remediate], [data-fusion-reread]');
  if (!button) return;
  if (button.hasAttribute('data-fusion-reread')) return readFusion();
  const severities = (button.dataset.severities || '').split(',').filter(Boolean);
  if (!severities.length) return;
  const allocate = button.hasAttribute('data-fusion-allocate');
  const kind = allocate ? button.dataset.kind : button.hasAttribute('data-fusion-triage') ? 'triage' : 'remediation';
  const label = engineLabel(fusionEngines());
  // From a project's side panel: that project alone; from the bar, the projects shown.
  const side = [button.dataset.fusionAllocate, button.dataset.fusionTriage, button.dataset.fusionRemediate].includes('side');
  const scopeText = side ? 'in this project' : 'in the projects shown';
  const question = allocate
    ? kind === 'triage'
      ? `Allocate AI Triage credits from the credit pool for the ${label} results at the severities on the button, ${scopeText} (1 per Checkmarx One result), confirmed with Checkmarx One as they are given?`
      : `Allocate AI Remediation credits from the credit pool for the confirmed ${label} results at the severities on the button, ${scopeText} (3 per confirmed result), confirmed with Checkmarx One as they are given?`
    : kind === 'triage'
      ? `Run AI Triage on the ${label} results at the severities on the button, ${scopeText}, that are still awaiting triage? It uses Checkmarx One credits.`
      : `Run AI Remediation on the confirmed ${label} results at the severities on the button, ${scopeText}? It uses 3 Checkmarx One credits each.`;
  const where = side ? 'fusion-side-status' : 'fusion-act-status';
  if (!confirm(question)) return;
  button.disabled = true;
  setStatus(where, allocate ? 'Allocating…' : kind === 'triage' ? 'Starting AI Triage…' : 'Starting AI Remediation…');
  try {
    const focus = side ? fusionSideBody() : fusionFocusBody();
    const result = await api(`/api/beta/fusion/${allocate ? 'allocate' : kind === 'triage' ? 'triage' : 'remediate'}`, {
      method: 'POST',
      body: JSON.stringify(allocate ? { severities, kind, ...focus } : { severities, ...focus }),
    });
    const left = result.credits ?? (side ? fusionSide.credits : fusion.credits);
    if (side) fusionSide.credits = left;
    else fusion.credits = left;
    setStatus(where, allocate
      ? `Allocated. ${side ? 'This project now has' : 'These projects now have'} ${left.left.triage} triage and ${left.left.remediation} remediation credit(s) left.${noteGone(result)}`
      : spendText(result, kind), result.failed ? 'error' : 'ok');
    creditsChanged();
    // The other place shows the same projects' credits: read again.
    fusionFocusSent = '';
    if (side) fusionFocusChanged();
    else if (fusion.open) loadFusionSideCredits();
  } catch (error) {
    if (!handleAuthLoss(error)) showError(where, error);
  } finally {
    button.disabled = false;
    if (side) renderFusionSideLanes();
    else renderFusionLanes();
  }
});

// ---- Labs → Fusion results → Troubleshoot (who manages the Checkmarx One integration) ------------------
const fusionTrouble = { defaults: [], pinned: { results: '', dispatcher: '' }, log: [], on: false };
const FUSION_PATHS_KEY = 'mz-fusion-paths';

async function loadFusionTrouble() {
  if (!can('integration.cxone') || !can('feature.fusionResults')) return;
  try {
    const d = await api('/api/beta/fusion/debug');
    Object.assign(fusionTrouble, { defaults: d.defaults, pinned: d.pinned, log: d.log, on: d.on });
    let saved = '';
    try {
      saved = localStorage.getItem(FUSION_PATHS_KEY) ?? '';
    } catch {}
    if (!$('fusion-paths').value) $('fusion-paths').value = saved || d.defaults.join('\n');
    renderFusionTrouble();
  } catch (error) {
    if (!handleAuthLoss(error)) showError('fusion-probe-status', error);
  }
}

function renderFusionTrouble() {
  const { pinned } = fusionTrouble;
  $('fusion-pinned').innerHTML = pinned.results || pinned.dispatcher
    ? `${escapeHtml('Pinned:')} ${pinned.results ? `<code>${escapeHtml(pinned.results)}</code> ${escapeHtml('for Fusion results')}` : ''}${pinned.results && pinned.dispatcher ? ' · ' : ''}${pinned.dispatcher ? `<code>${escapeHtml(pinned.dispatcher)}</code> ${escapeHtml('for Fusion scan status')}` : ''} <button type="button" class="link" data-fusion-unpin>${escapeHtml('Unpin')}</button>`
    : escapeHtml('Nothing pinned: the page tries /api/correlation/results and /api/correlation/dispatcher.');
  $('fusion-debug').checked = fusionTrouble.on;
  const log = fusionTrouble.log;
  $('fusion-log').hidden = !log.length;
  $('fusion-log').textContent = fusionLogText(log);
  $('fusion-log-count').textContent = log.length ? `${log.length} call(s) logged` : '';
}

/** The log as plain text to share: each call's request and answer, the access token never in it. */
function fusionLogText(log) {
  return log.map((e) => [
    `### ${e.at} ${e.method} ${e.url} (attempt ${e.attempt}) → ${e.status ? `${e.status} ${e.statusText ?? ''}` : `no answer: ${e.error}`} · ${e.ms} ms`,
    `Request headers: ${JSON.stringify(e.request?.headers ?? {})}`,
    ...(e.request?.body ? [`Request body: ${e.request.body}`] : []),
    ...(e.headers ? [`Response headers: ${JSON.stringify(e.headers)}`] : []),
    ...(e.status ? [`Response body${e.truncated ? ' (first 8 KB)' : ''}:`, e.body || '(empty)'] : []),
  ].join('\n')).join('\n\n');
}

/** Where a working path says the service lives: the base to pin, and for which service. */
function fusionPinOf(path) {
  const results = path.match(/^(\/api\/.+?)\/applications(?:\/.*)?$/);
  if (results && !/risk-management|\/api\/applications/.test(path)) return { kind: 'results', base: results[1] };
  const dispatcher = path.match(/^(\/api\/.+?)\/\{appId\}\/scan-status$/);
  if (dispatcher) return { kind: 'dispatcher', base: dispatcher[1] };
  return null;
}

$('fusion-probe')?.addEventListener('click', async () => {
  const paths = $('fusion-paths').value.split('\n').map((p) => p.trim()).filter(Boolean);
  try {
    localStorage.setItem(FUSION_PATHS_KEY, $('fusion-paths').value);
  } catch {}
  setStatus('fusion-probe-status', `Testing ${paths.length} path(s)…`);
  try {
    const r = await api('/api/beta/fusion/probe', { method: 'POST', body: JSON.stringify({ paths }) });
    $('fusion-probe-body').innerHTML = r.results.map((x) => {
      const pin = x.ok ? fusionPinOf(x.path) : null;
      return `<tr><td class="path">${escapeHtml(x.path)}</td><td class="num"><span class="badge ${x.ok ? 'ok' : 'warn'}">${escapeHtml(String(x.status || '—'))}</span></td><td class="num">${fmt(x.ms)} ms</td><td class="answer">${escapeHtml(x.answer.length > 300 ? `${x.answer.slice(0, 300)}…` : x.answer)}</td><td>${pin ? `<button type="button" class="sm" data-fusion-pin="${escapeHtml(pin.base)}" data-kind="${pin.kind}">${escapeHtml(pin.kind === 'results' ? 'Use for Fusion results' : 'Use for Fusion scan status')}</button>` : ''}</td></tr>`;
    }).join('');
    const working = r.results.filter((x) => x.ok).length;
    setStatus('fusion-probe-status', `${working} of ${r.results.length} answered.`, working ? 'ok' : 'warn');
    if (fusionTrouble.on) loadFusionTrouble();
  } catch (error) {
    if (!handleAuthLoss(error)) showError('fusion-probe-status', error);
  }
});
$('fusion-paths-reset')?.addEventListener('click', () => {
  $('fusion-paths').value = fusionTrouble.defaults.join('\n');
  try {
    localStorage.removeItem(FUSION_PATHS_KEY);
  } catch {}
});
$('fusion-debug')?.addEventListener('change', async (event) => {
  try {
    const d = await api('/api/beta/fusion/debug', { method: 'PUT', body: JSON.stringify({ on: event.target.checked }) });
    Object.assign(fusionTrouble, { on: d.on, log: d.log });
    renderFusionTrouble();
  } catch (error) {
    if (!handleAuthLoss(error)) showError('fusion-probe-status', error);
  }
});
$('fusion-log-clear')?.addEventListener('click', async () => {
  const d = await api('/api/beta/fusion/debug', { method: 'PUT', body: JSON.stringify({ clear: true }) }).catch(() => null);
  if (d) Object.assign(fusionTrouble, { on: d.on, log: d.log });
  renderFusionTrouble();
});
$('fusion-log-copy')?.addEventListener('click', async () => {
  await loadFusionTrouble();
  try {
    await navigator.clipboard.writeText(fusionLogText(fusionTrouble.log));
    setStatus('fusion-probe-status', 'The log is copied.', 'ok');
  } catch {
    setStatus('fusion-probe-status', 'Could not copy: select the log and copy it.', 'warn');
  }
});
$('fusion-log-download')?.addEventListener('click', async () => {
  await loadFusionTrouble();
  const blob = new Blob([fusionLogText(fusionTrouble.log)], { type: 'text/plain' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `fusion-debug-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
document.addEventListener('click', async (event) => {
  const pin = event.target.closest('[data-fusion-pin], [data-fusion-unpin]');
  if (!pin) return;
  const endpoints = pin.hasAttribute('data-fusion-unpin')
    ? { fusionResultsPath: '', fusionDispatcherPath: '' }
    : { [pin.dataset.kind === 'results' ? 'fusionResultsPath' : 'fusionDispatcherPath']: pin.dataset.fusionPin };
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ endpoints }) });
    await loadFusionTrouble();
    setStatus('fusion-probe-status', pin.hasAttribute('data-fusion-unpin') ? 'Unpinned.' : 'Pinned: Fusion is read from there now.', 'ok');
    if (!pin.hasAttribute('data-fusion-unpin')) readFusion();
  } catch (error) {
    if (!handleAuthLoss(error)) showError('fusion-probe-status', error);
  }
});

export function renderBetaScope() {
  const scope = allocationScope();
  $('authors-scope').textContent = state.projects.length
    ? `${scope.length} project${scope.length === 1 ? '' : 's'} ${state.selected.size ? 'selected' : 'shown'} on the Workbench`
    : 'Load findings on the Workbench first';
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

// ---- Usernames → addresses, per source-code host -------------------------------

const HOST_METHODS = {
  github: [
    ['localGit', 'Local git history', 'Noreply commits and author names in repositories you name. No API calls.'],
    ['graphql', 'GraphQL batch', "50 users per request; includes your organisation's verified-domain emails. Needs a token."],
    ['commits', 'Commit author', 'Email on their own commits: in the repositories listed below, or by commit search (30 a minute).'],
    ['profile', 'Public profile', 'The email on their GitHub profile, if public. One request each.'],
  ],
  gitlab: [
    ['localGit', 'Local git history', 'GitLab noreply commits (ID-username@users.noreply…) and author names in repositories you name. No API calls.'],
    ['graphql', 'GraphQL batch', '100 users per request: public email and commit email. Needs a token.'],
    ['users', 'User profile', 'The email on their GitLab profile (every email with an admin token). One request each.'],
    ['commits', 'Commits by their name', 'Their name from the profile, then the address on their commits in the projects you name.'],
  ],
  azure: [
    ['localGit', 'Local git history', 'Author names and addresses in repositories you name. No API calls.'],
    ['graph', 'Organisation directory', 'Everyone in the organisation in a few requests: sign-in name, mail and display name (Azure DevOps Services).'],
    ['identities', 'Identity search', 'One request per user; also on Azure DevOps Server.'],
    ['commits', 'Commit author', 'Commits by that author in the repositories you name.'],
  ],
  bitbucketCloud: [
    ['localGit', 'Local git history', 'Author names and addresses in repositories you name. No API calls.'],
    ['commits', 'Commit authors', 'Recent commits of the repositories you name: each ties the Bitbucket user to the address in its author line. Many people per request.'],
    ['members', 'Workspace members + local history', 'Members give each username a display name; local history gives that name an address.'],
  ],
  bitbucketServer: [
    ['localGit', 'Local git history', 'Author names and addresses in repositories you name. No API calls.'],
    ['commits', 'Commit authors', 'Recent commits of the repositories you name, with each author\'s Bitbucket user and address.'],
    ['directory', 'User directory', 'Up to 1000 people per request, with their email.'],
    ['users', 'User search', 'One request per user.'],
  ],
};
const HOST_NAMES = { github: 'GitHub', gitlab: 'GitLab', azure: 'Azure DevOps', bitbucket: 'Bitbucket' };
let identityHost = 'github';
const hostMethods = () => (identityHost === 'bitbucket' ? (($('bb-kind').value || 'cloud') === 'server' ? HOST_METHODS.bitbucketServer : HOST_METHODS.bitbucketCloud) : HOST_METHODS[identityHost]);

function renderIdentityMethods() {
  $('id-methods').innerHTML = hostMethods()
    .map(([id, title, detail]) => `<label class="method-card"><input type="checkbox" class="gh-method" value="${id}" checked />
      <span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></span></label>`)
    .join('');
  $('id-logins-label').textContent = `${HOST_NAMES[identityHost]} usernames`;
}

for (const radio of document.querySelectorAll('input[name="idHost"]')) {
  radio.addEventListener('change', () => {
    identityHost = radio.value;
    identityReport = null;
    $('gh-results').hidden = true;
    setStatus('gh-status', '');
    renderIdentityMethods();
  });
}

$('gh-load-logins').addEventListener('click', async () => {
  try {
    const { logins } = await api(`/api/beta/scm/logins?provider=${identityHost}`);
    if (!logins.length) return setStatus('gh-status', 'No usernames among the developers: load findings on the Workbench, or type them in.', 'error');
    // Unresolved ones first: those are the ones worth matching.
    logins.sort((a, b) => Number(b.unresolved) - Number(a.unresolved));
    $('gh-logins').value = logins.map((l) => l.login).join('\n');
    setStatus('gh-status', `${logins.length} username(s) from the developers, ${logins.filter((l) => l.unresolved).length} without an email.`, 'ok');
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
    identityReport = await api(identityHost === 'github' ? '/api/beta/github/evaluate' : '/api/beta/scm/evaluate', {
      method: 'POST',
      body: JSON.stringify({ provider: identityHost, logins: lines($('gh-logins').value), methods }),
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
  const METHOD_NAMES = { ...METHOD_NAMES_GITHUB, ...(report.labels ?? {}), address: 'Already an address' };
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
    const result = await api('/api/beta/scm/apply', { method: 'POST', body: JSON.stringify({ provider: identityHost, mappings }) });
    setStatus('gh-apply-status', `${result.applied} saved. Fetch again on the Workbench to use them.`, 'ok');
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
      <span class="stat ok"><b>${s.sure ?? 0}</b> sure</span>${s.unsure ? `<span class="stat"><b>${s.unsure}</b> to check (not ticked)</span>` : ''}
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

/** The pull or merge request a commit came in through, who opened it and who approved it. */
function changeLine(change) {
  if (!change?.number) return '';
  const ref = `${change.kind === 'merge request' ? '!' : '#'}${change.number}`;
  const link = change.url ? `<a href="${escapeHtml(change.url)}" target="_blank" rel="noopener" title="${escapeHtml(change.title || '')}">${escapeHtml(ref)}</a>` : escapeHtml(ref);
  const by = change.author ? ` by ${escapeHtml(change.author)}` : '';
  const approved = change.approvers?.length ? `approved by ${escapeHtml(change.approvers.join(', '))}` : 'no approval recorded';
  return `<div class="hint change-hint">Came in through ${link}${by} · ${approved}</div>`;
}

function renderAuthors() {
  $('authors-wrap').hidden = !authorItems.length;
  $('authors-actions').hidden = !authorItems.some((i) => i.author?.email);
  $('authors-body').innerHTML = authorItems
    .map((i) => {
      const sev = String(i.severity || '').toLowerCase();
      const where = i.location ? `${i.location.path}:${i.location.line}` : '';
      const author = i.author
        ? `<div class="person-main">${avatar(i.author.name || i.author.login || i.author.email)}<span class="person-text"><span class="person-name">${escapeHtml(i.author.name || i.author.login)}</span><span class="person-mail">${escapeHtml(i.author.email || 'no address')}${i.author.emailVia && i.author.emailVia !== 'commit' ? ` · via ${escapeHtml(METHOD_NAMES_GITHUB[i.author.emailVia] || i.author.emailVia)}` : ''}</span></span></div>`
        : '';
      // Only answers git blame is sure of are ticked; an unsure one is there to look at, and to tick on purpose.
      const sure = i.confidence === 'high';
      const confidence = i.commit
        ? `<span class="badge ${sure ? '' : i.confidence === 'medium' ? 'warn' : 'bad'}" title="${escapeHtml(i.confidenceReason || '')}">${sure ? 'Sure' : i.confidence === 'medium' ? 'Check' : 'Unsure'}</span>${i.confidenceReason ? `<div class="hint">${escapeHtml(i.confidenceReason)}</div>` : ''}`
        : '';
      return `<tr class="${i.author?.email ? '' : 'dim-row'}">
        <td class="checkbox"><input type="checkbox" data-author-key="${escapeHtml(i.key)}" ${!i.author?.email ? 'disabled' : sure ? 'checked' : ''} /></td>
        <td class="finding-cell"><span class="sev-dot sev-${escapeHtml(sev)}"></span>${i.url ? `<a href="${escapeHtml(i.url)}" target="_blank" rel="noopener">${escapeHtml(i.title)}</a>` : escapeHtml(i.title)}
          <div class="hint">${escapeHtml(i.projectName)} · ${escapeHtml(i.scanner)}${i.ageDays != null ? ` · ${i.ageDays}d` : ''}</div></td>
        <td class="mono where">${escapeHtml(where)}${i.owners?.list?.length ? `<div class="hint owners-hint" title="From ${escapeHtml(i.owners.file)}">Code owners: ${escapeHtml(i.owners.list.join(', '))}</div>` : ''}${i.problem ? `<div class="hint error-hint">${escapeHtml(i.problem)}</div>` : ''}</td>
        <td>${author}${confidence}</td>
        <td class="mono">${i.commit ? `${i.commitUrl ? `<a href="${escapeHtml(i.commitUrl)}" target="_blank" rel="noopener">${escapeHtml(i.commit.slice(0, 8))}</a>` : escapeHtml(i.commit.slice(0, 8))}<div class="hint">${escapeHtml((i.committedAt || '').slice(0, 10))} · ${escapeHtml([i.host, i.via].filter(Boolean).join(' · '))}</div>${changeLine(i.change)}` : ''}</td>
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

const audit = { entries: [], next: 0, more: false, loaded: false, page: 0 };
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
    e.actor?.ip && ['From', `${e.actor.ip}${e.actor.userAgent ? ` · ${e.actor.userAgent}` : ''}`, 'origin'],
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
  return `<div class="facts">${facts.map(([k, v, ctx]) => `<div><b${ctx ? ` data-i18n-ctx="${ctx}"` : ''}>${escapeHtml(k)}</b>${escapeHtml(v)}</div>`).join('')}</div>
    <details><summary class="hint">Full entry (JSON)</summary><pre>${escapeHtml(JSON.stringify(e, null, 2))}</pre></details>`;
}

const AUDIT_PAGE = 25;

/** What each heading of the audit log reads (sorting and the heading filters cover every entry loaded). */
const AUDIT_COLUMNS = [
  (e) => e.seq,
  { value: (e) => Date.parse(e.at) || null, text: (e) => formatTime(e.at) },
  (e) => `${TYPE_LABELS[e.type] ?? e.type} ${e.reason || ''}`,
  (e) => (OUTCOME_BADGES[e.outcome] ?? [e.outcome])[0],
  (e) => actorText(e.actor).join(' '),
  (e) => e.project?.name || e.project?.id || '',
  { value: (e) => e.credits?.charged ?? null, text: (e) => String(e.credits?.charged ?? '') },
  { value: (e) => (e.balance?.after?.remaining === undefined ? null : Number(e.balance.after.remaining)), text: (e) => String(e.balance?.after?.remaining ?? '') },
  null,
];
let auditShown = [];

function renderAuditRows() {
  auditShown = sortAndFilter('audit', audit.entries, AUDIT_COLUMNS, () => {
    audit.page = 0;
    renderAuditRows();
  });
  if (!auditShown.length) {
    $('audit-body').innerHTML = '<tr><td colspan="9" class="hint">No audit entries match these filters.</td></tr>';
  } else {
    const pages = Math.max(1, Math.ceil(auditShown.length / AUDIT_PAGE));
    audit.page = Math.min(audit.page ?? 0, pages - 1);
    const first = audit.page * AUDIT_PAGE;
    const indexOf = new Map(audit.entries.map((e, i) => [e, i]));
    $('audit-body').innerHTML = auditShown
      .slice(first, first + AUDIT_PAGE)
      .map((e) => {
        const i = indexOf.get(e);
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
  const pages = Math.max(1, Math.ceil(auditShown.length / AUDIT_PAGE));
  const first = (audit.page ?? 0) * AUDIT_PAGE;
  $('audit-more').hidden = true;
  $('audit-prev').disabled = !audit.page;
  $('audit-next').disabled = audit.page >= pages - 1 && !audit.more;
  $('audit-page').textContent = auditShown.length ? `Page ${audit.page + 1}${audit.more ? '' : ` of ${pages}`}` : '';
  $('audit-count').textContent = !auditShown.length
    ? ''
    : tableFiltered('audit')
      ? `${auditShown.length.toLocaleString()} of the ${audit.entries.length.toLocaleString()} entries loaded match the column filters`
      : `Entries ${(first + 1).toLocaleString()}–${Math.min(first + AUDIT_PAGE, auditShown.length).toLocaleString()}${audit.more ? ', newest first' : ` of ${auditShown.length.toLocaleString()}, newest first`}`;
}

$('audit-prev').addEventListener('click', () => {
  audit.page = Math.max(0, (audit.page ?? 0) - 1);
  renderAuditRows();
  $('audit-body').closest('.panel').scrollIntoView({ block: 'nearest' });
});
$('audit-next').addEventListener('click', async () => {
  const next = (audit.page ?? 0) + 1;
  if (next * AUDIT_PAGE >= auditShown.length && audit.more) await loadAudit({ append: true });
  audit.page = next;
  renderAuditRows();
  $('audit-body').closest('.panel').scrollIntoView({ block: 'nearest' });
});



async function loadAudit({ append = false } = {}) {
  setStatus('audit-status', append ? '' : 'Loading…');
  try {
    const result = await api(`/api/audit?${auditQuery({ limit: 100, ...(append ? { before: audit.next } : {}) })}`);
    audit.entries = append ? audit.entries.concat(result.entries) : result.entries;
    if (!append) audit.page = 0;
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

// ---- Logs → User activity: what each person did (GET /api/activity) ---------------------------

const UA_PAGE = 50;
export const userActivity = { offset: 0, total: 0, loaded: false };
const UA_KINDS = { action: 'Action', page: 'Page', 'sign-in': 'Sign-in', event: 'Event' };

/** The filters as query parameters; a date's day runs from midnight to midnight in this browser's time. */
function userActivityQuery() {
  const params = new URLSearchParams();
  const set = (key, value) => value && params.set(key, value);
  set('user', $('ua-user').value);
  set('kind', $('ua-kind').value);
  set('q', $('ua-q').value.trim());
  if ($('ua-from').value) set('from', new Date(`${$('ua-from').value}T00:00:00`).toISOString());
  if ($('ua-to').value) set('to', new Date(`${$('ua-to').value}T23:59:59.999`).toISOString());
  return params;
}

function userActivityResult(e) {
  if (e.status == null) return '';
  if (e.status >= 400) return `<span class="badge bad">${escapeHtml(e.kind === 'sign-in' ? 'Refused' : 'Failed')}</span> <small class="muted" translate="no">HTTP ${e.status}</small>`;
  return `<span class="badge ok">Done</span>${e.ms != null ? ` <small class="muted" translate="no">${e.ms} ms</small>` : ''}`;
}

function renderUserActivity(result) {
  const select = $('ua-user');
  const chosen = select.value;
  select.innerHTML = `<option value="">Everyone</option>${result.people.map((p) => `<option value="${escapeHtml(p.email)}">${escapeHtml(p.name ? `${p.name} (${p.email})` : p.email)}</option>`).join('')}`;
  select.value = result.people.some((p) => p.email === chosen) ? chosen : '';
  userActivity.total = result.total;
  $('ua-body').innerHTML = result.entries.length
    ? result.entries
        .map((e) => {
          // The actions and items are kept as recorded (in English, as in the audit log); the labels around them are translated.
          const details = [e.target && `<span translate="no">${escapeHtml(e.target)}</span>`, e.fields?.length && `<span class="muted">Fields:</span> <span translate="no">${escapeHtml(e.fields.join(', '))}</span>`].filter(Boolean).join('<br />');
          return `<tr>
          <td class="when">${escapeHtml(formatTime(e.at))}</td>
          <td class="who"><span translate="no">${escapeHtml(e.name || e.user || '—')}</span><small><span translate="no">${escapeHtml(e.name ? e.user : '')}</span>${e.role ? `${e.name ? ' · ' : ''}${escapeHtml(e.role)}` : ''}</small></td>
          <td class="ua-action"><span class="badge muted">${escapeHtml(UA_KINDS[e.kind] ?? e.kind)}</span> <span translate="no">${escapeHtml(e.action)}</span></td>
          <td class="ua-details">${details}</td>
          <td>${userActivityResult(e)}</td>
          <td class="muted" translate="no">${escapeHtml(e.ip || '')}</td>
        </tr>`;
        })
        .join('')
    : '<tr><td colspan="6" class="hint">Nothing recorded matches these filters.</td></tr>';
  const first = userActivity.offset;
  $('ua-prev').disabled = first === 0;
  $('ua-next').disabled = first + UA_PAGE >= result.total;
  $('ua-count').textContent = result.total ? `Entries ${(first + 1).toLocaleString()}–${Math.min(first + UA_PAGE, result.total).toLocaleString()} of ${result.total.toLocaleString()}, newest first` : '';
}

export async function loadUserActivity({ offset = 0 } = {}) {
  if (!can('audit.view')) return;
  userActivity.offset = Math.max(0, offset);
  setStatus('ua-status', 'Loading…');
  try {
    const params = userActivityQuery();
    params.set('limit', UA_PAGE);
    params.set('offset', userActivity.offset);
    renderUserActivity(await api(`/api/activity?${params}`));
    userActivity.loaded = true;
    setStatus('ua-status', '');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('ua-status', error);
  }
}

$('ua-filters').addEventListener('submit', (event) => {
  event.preventDefault();
  loadUserActivity();
});
for (const id of ['ua-user', 'ua-kind', 'ua-from', 'ua-to']) $(id).addEventListener('change', () => loadUserActivity());
$('ua-reset').addEventListener('click', () => {
  $('ua-filters').reset();
  loadUserActivity();
});
$('ua-prev').addEventListener('click', () => loadUserActivity({ offset: userActivity.offset - UA_PAGE }));
$('ua-next').addEventListener('click', () => loadUserActivity({ offset: userActivity.offset + UA_PAGE }));
$('ua-export').addEventListener('click', () => {
  const link = document.createElement('a');
  link.href = '/api/activity/export';
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
});

/**
 * Which page and tab each person opens goes into the user activity log (the server adds who and when).
 * Fire and forget: a page never waits on it, and the same page twice in a row is sent once.
 */
export function reportVisit(name) {
  // A property, not a variable: route() may run before this part of the file has.
  if (!state.me || !name || name === reportVisit.last) return;
  reportVisit.last = name;
  reportActivity('page', name);
}
function reportActivity(kind, name) {
  const clean = String(name).replace(/[^\w .,:/#&()'’›→-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!clean) return;
  fetch('/api/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', keepalive: true, body: JSON.stringify({ kind, name: clean }) }).catch(() => {});
}
window.mzReportActivity = reportActivity;

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
      ['Schedule', b.intervalHours ? `every ${b.intervalHours} h, keeping ${b.keep}${b.encrypted ? ', encrypted' : ', not encrypted'}` : 'off (BACKUP_INTERVAL_HOURS=0)', !b.encrypted],
      ['Encryption', backupEncryptionText(b.encryption), !b.encryption.encrypted || b.encryption.notice === 'save-key'],
      ['Last backup', last, b.last && !b.last.ok],
      b.pendingRestore && ['Restore staged', 'applied when the server restarts', true],
      b.restoredAtStart && ['Restored at start', `backup of ${formatTime(b.restoredAtStart.createdAt)} (${b.restoredAtStart.files} files)`],
    ].filter(Boolean);
    $('backup-facts').innerHTML = facts.map(([k, v, warn]) => `<div><dt>${escapeHtml(k)}</dt><dd class="${warn ? 'warn' : ''}">${escapeHtml(v)}</dd></div>`).join('');
    $('backup-list-wrap').hidden = !b.backups.length;
    $('backup-list').innerHTML = b.backups.map((f) => `<tr><td class="code">${escapeHtml(f.name)}</td><td class="num">${formatBytes(f.size)}</td><td>${escapeHtml(formatTime(f.at))}</td></tr>`).join('');
    renderBackupKeyPanel(b.encryption);
    if (b.pendingRestore && $('restore-panel').hidden) {
      $('restore-panel').hidden = false;
      $('restore-panel').className = 'audit-result';
      $('restore-panel').innerHTML = '<span>A restore is staged and will be applied when the server restarts.</span><div><button type="button" id="restore-cancel" class="sm">Cancel the restore</button></div>';
    }
  } catch (error) {
    if (!handleAuthLoss(error)) showError('backup-status', error);
  }
}

// ---- Backup encryption and the server's backup key (Admins: backup.manage) ----

/** The "Encryption" line of the facts: what encrypts a backup made now. */
function backupEncryptionText(e) {
  if (e.source === 'passphrase') return 'on, with BACKUP_PASSPHRASE';
  if (e.source === 'key') {
    return e.keySaved
      ? `on, with this server's backup key (saved somewhere else: confirmed ${formatTime(e.keySavedAt)}${e.keySavedBy ? ` by ${e.keySavedBy}` : ''})`
      : 'on, with this server\'s backup key — nobody has confirmed saving the key somewhere else yet';
  }
  return e.optedOut ? 'off (BACKUP_ENCRYPTION=off is set on the server)' : 'off — each backup holds the keys and passwords in the clear';
}

/** The key while it is on screen (never kept anywhere else in the page). */
let backupKeyShown = null;

/** The Admins' block under the backup buttons: turn encryption on, see the key, copy or download it, confirm it is saved. */
function renderBackupKeyPanel(encryption) {
  const panel = $('backup-key-panel');
  panel.dataset.source = encryption.source;
  if (encryption.source !== 'key') backupKeyShown = null;
  // With BACKUP_PASSPHRASE the server's key is not used: there is nothing to do here.
  panel.hidden = encryption.source === 'passphrase';
  // (classList, not className: the permission class on the panel stays.)
  panel.classList.toggle('bad', Boolean(encryption.notice));
  if (encryption.source === 'none') {
    panel.innerHTML = encryption.optedOut
      ? '<strong>Backups are not encrypted.</strong><span>BACKUP_ENCRYPTION=off is set on the server. Each backup holds the Checkmarx One key, the mail password and the signing keys in the clear. To encrypt them, remove that setting and restart the server.</span>'
      : `<strong>Backups are not encrypted.</strong>
        <span>Each backup holds the Checkmarx One key, the mail password and the signing keys in the clear. Turn encryption on and the server makes a backup key, shows it to you, and encrypts every backup from then on. Backups made before stay as they are.</span>
        <div><button type="button" id="backup-encrypt-on" class="sm">Turn on backup encryption</button></div>`;
    return;
  }
  const saved = encryption.keySaved
    ? `<span class="hint">Saved somewhere else: confirmed ${escapeHtml(formatTime(encryption.keySavedAt))}${encryption.keySavedBy ? ` by ${escapeHtml(encryption.keySavedBy)}` : ''}.</span>`
    : '<span><b>Nobody has confirmed saving this key yet.</b> Show it, keep a copy somewhere other than this server (a password manager, a safe), then confirm.</span>';
  const shown = backupKeyShown
    ? `<code class="code" id="backup-key-value">${escapeHtml(backupKeyShown.key)}</code>
       <div><button type="button" id="backup-key-copy" class="sm">Copy</button> <button type="button" id="backup-key-download" class="sm">Download as a text file</button> <button type="button" id="backup-key-hide" class="sm ghost">Hide</button></div>`
    : '<div><button type="button" id="backup-key-show" class="sm">Show backup key</button></div>';
  panel.innerHTML = `<strong>Backup key</strong>
    <span>Every backup is encrypted with this server's backup key. Keep the key somewhere other than this server: if the server is lost, a backup opens only with it. To restore on another server, give the key when the restore asks, or set BACKUP_PASSPHRASE to it. The key is never emailed and is not inside a backup.</span>
    ${shown}
    ${saved}
    ${backupKeyShown && !encryption.keySaved ? '<div><button type="button" id="backup-key-confirm" class="sm">I have saved it</button></div>' : ''}`;
}

/** The Admins' notice at the top of every page, until they act. */
export function renderBackupBanner(notice) {
  const banner = $('backup-banner');
  if (!banner) return;
  banner.hidden = !notice;
  if (!notice) return;
  banner.innerHTML = notice === 'save-key'
    ? 'Backups are encrypted with this server\'s backup key, and nobody has confirmed saving the key somewhere else yet. If this server is lost, its backups open only with that key. <a href="#/audit/backups">Save the backup key</a>'
    : 'Backups of this server are not encrypted: each one holds the Checkmarx One key, the mail password and the signing keys in the clear. <a href="#/audit/backups">Turn on backup encryption</a>';
}

// Signed out (the sign-in panel shows): the notice goes away with the workspace it is about.
new MutationObserver(() => {
  if (!$('connect-panel').hidden) renderBackupBanner(null);
}).observe($('connect-panel'), { attributes: true, attributeFilter: ['hidden'] });

/** After a change to backup encryption: the panel, the facts and the notice follow. */
function backupEncryptionChanged(encryption) {
  if (state.me) state.me = { ...state.me, backupNotice: encryption.notice };
  renderBackupBanner(encryption.notice);
  loadBackupStatus();
}

async function showBackupKey() {
  backupKeyShown = await api('/api/backup/key/show', { method: 'POST' });
}

$('backup-key-panel').addEventListener('click', async (event) => {
  const id = event.target.id;
  if (!id) return;
  try {
    if (id === 'backup-encrypt-on') {
      if (!confirm('Turn on backup encryption? The server makes a backup key and encrypts every backup from now on. You will be shown the key: keep it somewhere other than this server, because a backup opens only with it.')) return;
      const { encryption } = await api('/api/backup/encryption', { method: 'POST', body: JSON.stringify({ on: true }) });
      await showBackupKey();
      backupEncryptionChanged(encryption);
    } else if (id === 'backup-key-show') {
      await showBackupKey();
      loadBackupStatus();
    } else if (id === 'backup-key-hide') {
      backupKeyShown = null;
      loadBackupStatus();
    } else if (id === 'backup-key-copy') {
      try {
        await navigator.clipboard.writeText(backupKeyShown.key);
        toast('Backup key copied.');
      } catch {
        toast('Select the key and copy it.');
      }
    } else if (id === 'backup-key-download') {
      const text = [
        'CxMissionZero backup key',
        '',
        backupKeyShown.key,
        '',
        `Server: ${backupKeyShown.host}`,
        `Saved from the Audit page: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
        '',
        'Keep this file somewhere other than the server. Anyone who has it and a backup can read everything in the backup.',
        'To restore a backup on another server: give this key when the restore asks for it, or set BACKUP_PASSPHRASE to it.',
        '',
      ].join('\r\n');
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      link.download = 'cxmissionzero-backup-key.txt';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } else if (id === 'backup-key-confirm') {
      if (!confirm('Have you saved the backup key somewhere other than this server? Without it, a backup cannot be opened if this server is lost.')) return;
      const { encryption } = await api('/api/backup/key/confirm', { method: 'POST' });
      backupKeyShown = null;
      backupEncryptionChanged(encryption);
    }
  } catch (error) {
    if (!handleAuthLoss(error)) showError('backup-status', error);
  }
});

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
        const passphrase = prompt(`${error.message}\n\nBackup key or passphrase:`);
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

export function renderAudit() {
  if (!$('audit-month').value) $('audit-month').value = new Date().toISOString().slice(0, 7);
  loadAudit();
  loadBackupStatus();
}

wireServerConnections();

// ---------------------------------------------------------------------------
// Access: people, roles and the permission matrix
// ---------------------------------------------------------------------------

const access = { data: null, edits: new Map() };

export async function loadAccess() {
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

/** What each heading of the people table reads (sorting and the heading filters cover everyone, not one page). */
const IAM_COLUMNS = [
  (u) => `${u.name || ''} ${u.email}`.trim(),
  (u) => roleName(u.role),
  (u) => [u.hasPassword ? (u.twoStep ? 'Password and two-step code' : 'Password') : '', 'Checkmarx One', ...(u.cxoneIdentities ?? [])].filter(Boolean).join(' '),
  (u) => (u.disabled ? 'Disabled' : u.locked ? 'Locked' : u.mustChangePassword ? 'Must set password' : 'Active'),
  { value: (u) => Date.parse(u.lastLoginAt) || null, text: (u) => (u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '') },
  null,
];

/** People & roles → Sign-in: who may reset a forgotten password by email, and what is missing for it to work. */
function renderSignInPolicy() {
  const policy = access.data?.signIn;
  if (!policy) return;
  $('iam-reset-policy').value = policy.policy;
  $('iam-reset-policy').disabled = !policy.canChange;
  if (!policy.canChange) setStatus('iam-reset-status', 'Sign-in rules are for the whole server: a Super Admin changes them.');
  const missing = (policy.missing ?? []).filter((m) => m !== 'Turned off.');
  $('iam-reset-missing').hidden = !missing.length || policy.policy === 'off';
  $('iam-reset-missing').innerHTML = missing.length
    ? `<li class="hint">"Forgot your password?" is not shown yet:</li>${missing.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}`
    : '';
  renderSignInSecurity();
}

/** People & roles → Sign-in, for Admins: two-step sign-in for everyone. */
function renderSignInSecurity() {
  const security = access.data?.signIn?.security;
  $('iam-twostep-panel').hidden = !security;
  $('iam-sso-panel').hidden = !security;
  if (!security) return;
  $('iam-twostep-required').checked = security.twoStepRequired;
  renderSsoSettings(security);
}

// ---- People & roles → Sign-in → Single sign-on (Admins) ----

/** What the form was last filled from, so that typing is not overwritten each time the page is drawn again. */
let ssoFilledFrom = '';

function renderSsoSettings(security) {
  const { sso } = security;
  $('sso-redirect').value = security.redirectUri || '';
  $('sso-redirect').placeholder = 'Set this server\'s address first (Settings → Server address)';
  $('sso-secret-state').textContent = sso.clientSecretSet ? '(stored)' : '(not set)';
  $('sso-secret-remove').hidden = !sso.clientSecretSet;
  const missing = sso.enabled ? security.missing ?? [] : [];
  $('sso-missing').hidden = !missing.length;
  $('sso-missing').innerHTML = missing.length ? `<li class="hint">The button is not shown on the sign-in page yet:</li>${missing.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}` : '';
  const from = JSON.stringify([sso, security.roles]);
  if (from === ssoFilledFrom) return;
  ssoFilledFrom = from;
  $('sso-enabled').checked = sso.enabled;
  $('sso-issuer').value = sso.issuer;
  $('sso-label').value = sso.label;
  $('sso-client-id').value = sso.clientId;
  $('sso-client-secret').value = '';
  $('sso-domains').value = (sso.domains ?? []).join(', ');
  $('sso-provision').value = sso.provision;
  $('sso-role').innerHTML = (security.roles ?? []).map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}</option>`).join('');
  $('sso-role').value = (security.roles ?? []).some((r) => r.id === sso.role) ? sso.role : 'user';
  $('sso-verified').checked = sso.requireVerifiedEmail;
  $('sso-password-admins').checked = sso.passwordAdminsOnly;
  syncSsoForm();
}

/** The role is chosen only when people are added; passwords can be kept for Admins only while single sign-on is on. */
function syncSsoForm() {
  $('sso-role-field').hidden = $('sso-provision').value !== 'create';
  $('sso-password-admins').disabled = !$('sso-enabled').checked;
  if (!$('sso-enabled').checked) $('sso-password-admins').checked = false;
}

async function saveSso(sso, done) {
  setStatus('sso-admin-status', 'Saving…');
  try {
    access.data = await api('/api/iam/sign-in', { method: 'PUT', body: JSON.stringify({ sso }) });
    ssoFilledFrom = '';
    renderAccess();
    setStatus('sso-admin-status', done, 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('sso-admin-status', error);
  }
}

{
  $('sso-provision').addEventListener('change', syncSsoForm);
  $('sso-enabled').addEventListener('change', syncSsoForm);
  $('iam-sso-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const secret = $('sso-client-secret').value;
    saveSso(
      {
        enabled: $('sso-enabled').checked,
        issuer: $('sso-issuer').value.trim(),
        label: $('sso-label').value.trim(),
        clientId: $('sso-client-id').value.trim(),
        // Left empty, the stored secret is kept.
        ...(secret ? { clientSecret: secret } : {}),
        domains: $('sso-domains').value,
        provision: $('sso-provision').value,
        role: $('sso-role').value,
        requireVerifiedEmail: $('sso-verified').checked,
        passwordAdminsOnly: $('sso-password-admins').checked,
      },
      'Saved.',
    );
  });
  $('sso-secret-remove').addEventListener('click', () => {
    if (!confirm('Remove the stored client secret? Single sign-on stops working until a new one is saved, unless the identity provider needs none.')) return;
    saveSso({ clientSecret: null }, 'The client secret was removed.');
  });
  $('sso-check').addEventListener('click', async () => {
    setStatus('sso-admin-status', 'Checking the identity provider as saved…');
    try {
      const result = await api('/api/iam/sign-in/sso/check', { method: 'POST' });
      setStatus('sso-admin-status', result.message, result.ok ? 'ok' : 'error');
    } catch (error) {
      if (!handleAuthLoss(error)) showError('sso-admin-status', error);
    }
  });
  copyButton($('sso-redirect-copy'), $('sso-admin-status'), () => $('sso-redirect').value);
}

$('iam-twostep-required').addEventListener('change', async () => {
  const on = $('iam-twostep-required').checked;
  if (on && !confirm('Require two-step sign-in for everyone who signs in with a password? Each person without it sets it up at their next sign-in, you included.')) {
    $('iam-twostep-required').checked = false;
    return;
  }
  setStatus('iam-twostep-status', 'Saving…');
  try {
    access.data = await api('/api/iam/sign-in', { method: 'PUT', body: JSON.stringify({ twoStepRequired: on }) });
    renderAccess();
    setStatus('iam-twostep-status', 'Saved.', 'ok');
    if (state.me?.twoStep) state.me = { ...state.me, twoStep: { ...state.me.twoStep, required: on } };
  } catch (error) {
    if (!handleAuthLoss(error)) showError('iam-twostep-status', error);
    renderSignInSecurity();
  }
});

$('iam-reset-policy').addEventListener('change', async () => {
  setStatus('iam-reset-status', 'Saving…');
  try {
    const ready = await api('/api/iam/policy', { method: 'PUT', body: JSON.stringify({ passwordReset: $('iam-reset-policy').value }) });
    access.data.signIn = { ...access.data.signIn, ...ready };
    renderSignInPolicy();
    setStatus('iam-reset-status', 'Saved.', 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('iam-reset-status', error);
    if (access.data?.signIn) $('iam-reset-policy').value = access.data.signIn.policy;
  }
});

function renderAccess() {
  renderSignInPolicy();
  const { users, roles } = access.data;
  const assignable = roles.filter((r) => r.canAssign);
  $('iam-add-role').innerHTML = assignable.map((r) => `<option value="${escapeHtml(r.id)}" ${r.id === 'user' ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('');

  const roleFilter = $('iam-role-filter');
  const chosenRole = roleFilter.value;
  roleFilter.innerHTML = `<option value="">All roles</option>${roles.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}</option>`).join('')}`;
  roleFilter.value = roles.some((r) => r.id === chosenRole) ? chosenRole : '';
  $('iam-people-count').textContent = String(users.length);
  $('iam-roles-count').textContent = String(roles.length);
  const shown = sortAndFilter('iam-people', users.filter(iamUserMatches), IAM_COLUMNS, () => {
    access.page = 0;
    renderAccess();
  });
  const pages = Math.max(1, Math.ceil(shown.length / IAM_PAGE));
  access.page = Math.min(access.page ?? 0, pages - 1);
  const first = access.page * IAM_PAGE;
  $('iam-count').textContent = shown.length === users.length ? `${users.length} ${users.length === 1 ? 'person' : 'people'}` : `${shown.length} of ${users.length} people`;
  $('iam-pager').hidden = pages < 2;
  $('iam-page-info').textContent = `${first + 1}–${Math.min(first + IAM_PAGE, shown.length)} of ${shown.length}`;
  $('iam-prev').disabled = access.page === 0;
  $('iam-next').disabled = access.page >= pages - 1;
  if (!shown.length) {
    $('iam-users').innerHTML = '<tr><td colspan="6" class="hint">Nobody matches these filters.</td></tr>';
    renderMatrix();
    return;
  }
  $('iam-users').innerHTML = shown
    .slice(first, first + IAM_PAGE)
    .map((u) => {
      const me = u.id === state.me.user.id;
      const status = u.disabled ? '<span class="badge bad">Disabled</span>' : u.locked ? '<span class="badge warn">Locked</span>' : u.mustChangePassword ? '<span class="badge muted">Must set password</span>' : '<span class="badge">Active</span>';
      const methods = [u.hasPassword ? (u.twoStep ? 'Password and two-step code' : 'Password') : '', `Checkmarx One: ${[u.email, ...u.cxoneIdentities].map(escapeHtml).join(', ')}`].filter(Boolean).join('<br>');
      const roleCell = u.canManage
        ? `<select data-iam-role="${u.id}" aria-label="Role of ${escapeHtml(u.email)}">${roles
            .filter((r) => r.canAssign || r.id === u.role)
            .map((r) => `<option value="${escapeHtml(r.id)}" ${r.id === u.role ? 'selected' : ''} ${r.canAssign ? '' : 'disabled'}>${escapeHtml(r.name)}</option>`)
            .join('')}</select>`
        : `<span class="role-pill role-${escapeHtml(u.role)}">${escapeHtml(roleName(u.role))}</span>`;
      const actions = u.canManage
        ? `<button type="button" class="link" data-iam-profile="${u.id}">Edit profile</button>
           <button type="button" class="link" data-iam-reset="${u.id}">Set password</button>
           ${u.twoStep ? `<button type="button" class="link" data-iam-twostep="${u.id}">Reset two-step</button>` : ''}
           ${u.ssoLinked ? ssoLinkButton(u) : ''}
           <button type="button" class="link" data-iam-ids="${u.id}">Identities</button>
           <button type="button" class="link" data-iam-toggle="${u.id}">${u.disabled ? 'Enable' : 'Disable'}</button>
           <button type="button" class="link danger" data-iam-delete="${u.id}">Remove</button>`
        : me ? `<span class="hint">You</span>${u.ssoLinked && can('iam.manage') ? ` ${ssoLinkButton(u)}` : ''}` : '';
      // Several tenants: where each person works, chosen by a Super Admin.
      const tenants = access.data.tenants;
      const theirs = u.tenants?.length ? u.tenants : ['default'];
      const tenantLine = tenants ? `<small class="muted block" translate="no">${escapeHtml(tenants.filter((t) => theirs.includes(t.id)).map((t) => t.name).join(', '))}</small>` : '';
      const tenantPick = tenants && u.canManage
        ? `<details class="tn-pick"><summary class="link">Tenants</summary><div class="tn-pop">${tenants
            .map((t) => `<label class="check"><input type="checkbox" value="${escapeHtml(t.id)}" ${theirs.includes(t.id) ? 'checked' : ''} /> <span translate="no">${escapeHtml(t.name)}</span></label>`)
            .join('')}<button type="button" class="sm primary" data-iam-tenants="${u.id}">Save</button></div></details>`
        : '';
      return `<tr>
        <td><strong>${escapeHtml(u.name || u.email)}</strong>${u.name ? `<small class="muted block">${escapeHtml(u.email)}</small>` : ''}${tenantLine}</td>
        <td>${roleCell}</td>
        <td class="small-text">${methods}</td>
        <td>${status}</td>
        <td class="when">${u.lastLoginAt ? escapeHtml(formatTime(u.lastLoginAt)) : '<span class="hint">never</span>'}</td>
        <td><div class="row-actions">${actions}${tenantPick}${consolidatedTick(u, me)}</div></td>
      </tr>`;
    })
    .join('');
  renderMatrix();
}

const IAM_PAGE = 20;

/** For a person linked to their account at the identity provider by a single sign-on: take the link off (the account there was made anew). */
const ssoLinkButton = (u) => `<button type="button" class="link" data-iam-ssolink="${u.id}">Reset single sign-on link</button>`;

/**
 * Labs → Consolidated view: the Admin's tick, one person at a time (never through a role). Shown once its activation
 * code is applied; others see who has it.
 */
function consolidatedTick(u, me) {
  if (access.data.consolidatedGrant && (u.canManage || me)) {
    return `<label class="check cv-grant" title="Labs → Consolidated view: every tenant they work in, read only. Each visit is written to each tenant's audit log. Their role also needs See Labs and Labs: Consolidated view."><input type="checkbox" data-iam-consolidated="${escapeHtml(u.id)}" ${u.consolidated ? 'checked' : ''} /> <span>May see the consolidated view (all connected tenants)</span></label>`;
  }
  return u.consolidated ? '<span class="badge gv-info" title="May see the consolidated view (all connected tenants)">Consolidated view</span>' : '';
}

$('iam-users').addEventListener('change', (event) => {
  const box = event.target.closest('[data-iam-consolidated]');
  if (!box) return;
  const user = access.data.users.find((u) => u.id === box.dataset.iamConsolidated);
  if (!user) return;
  iamCall(`/api/iam/users/${encodeURIComponent(user.id)}/consolidated`, { method: 'PUT', body: JSON.stringify({ on: box.checked }) }, box.checked ? `${user.email} may now see the consolidated view.` : `${user.email} may no longer see the consolidated view.`);
});

function iamUserMatches(u) {
  const q = $('iam-search').value.trim().toLowerCase();
  const role = $('iam-role-filter').value;
  const status = $('iam-status-filter').value;
  if (role && u.role !== role) return false;
  if (status) {
    const current = u.disabled ? 'disabled' : u.locked ? 'locked' : u.mustChangePassword ? 'pending' : 'active';
    if (current !== status) return false;
  }
  if (!q) return true;
  return [u.name, u.email, ...(u.cxoneIdentities ?? [])].some((v) => String(v ?? '').toLowerCase().includes(q));
}

for (const id of ['iam-search', 'iam-role-filter', 'iam-status-filter']) {
  $(id).addEventListener(id === 'iam-search' ? 'input' : 'change', () => {
    access.page = 0;
    if (access.data) renderAccess();
  });
}
$('iam-prev').addEventListener('click', () => {
  access.page = Math.max(0, (access.page ?? 0) - 1);
  renderAccess();
});
$('iam-next').addEventListener('click', () => {
  access.page = (access.page ?? 0) + 1;
  renderAccess();
});

/** Permission groups folded away in the matrix (this browser session). */
const collapsedGroups = new Set();

/** "Show only the differences": the roles being compared (two or more; none chosen = every role). */
const roleCompare = { on: false, roles: new Set() };

function comparedRoles(roles) {
  const chosen = roles.filter((r) => roleCompare.roles.has(r.id));
  return chosen.length >= 2 ? chosen : roles;
}

/** Permissions down the side, roles across the top; tick to change what a role may do. */
function renderMatrix() {
  const { permissions, me } = access.data;
  const mine = new Set(me.permissions);
  const roles = roleCompare.on ? comparedRoles(access.data.roles) : access.data.roles;
  const groups = [...new Set(permissions.map((p) => p.group))];
  const valueOf = (role, pid) => (access.edits.get(role.id) ?? new Set(role.permissions)).has(pid);
  const differs = (p) => new Set(roles.map((r) => valueOf(r, p.id))).size > 1;
  const roleActions = (r) =>
    [
      r.canManage ? `<button type="button" class="link" data-iam-role-rename="${escapeHtml(r.id)}">Rename</button>` : '',
      access.data.rolesChangeable ? `<button type="button" class="link" data-iam-role-copy="${escapeHtml(r.id)}">Duplicate</button>` : '',
      r.canManage && !r.builtin ? `<button type="button" class="link danger" data-iam-role-delete="${escapeHtml(r.id)}">Remove</button>` : '',
    ].filter(Boolean);
  const head = `<thead><tr><th>Permission</th>${roles
    .map((r) => {
      const actions = roleActions(r);
      return `<th class="role-col" title="${escapeHtml(r.description || '')}"><span class="role-pill role-${escapeHtml(r.id)}">${escapeHtml(r.name)}</span><small>${r.users} ${r.users === 1 ? 'person' : 'people'}${r.locked ? ' · fixed' : ''}</small>${
        actions.length ? `<span class="role-actions">${actions.join('')}</span>` : ''
      }</th>`;
    })
    .join('')}</tr></thead>`;
  let differing = 0;
  const body = groups
    .map((group) => {
      const q = $('iam-perm-search').value.trim().toLowerCase();
      const inGroup = permissions.filter((p) => p.group === group && (!q || `${p.label} ${p.description} ${p.id}`.toLowerCase().includes(q)) && (!roleCompare.on || differs(p)));
      if (!inGroup.length) return '';
      differing += inGroup.length;
      const folded = collapsedGroups.has(group) && !q && !roleCompare.on;
      const granted = roles.map((r) => inGroup.filter((p) => valueOf(r, p.id)).length);
      const rows = folded ? '' : inGroup
        .map((p) => `<tr${roleCompare.on ? ' class="differs"' : ''}><td><span class="perm-label">${escapeHtml(p.label)}${p.adminOnly ? ' <span class="badge warn">Admin role only</span>' : p.special ? ' <span class="badge warn">Admin</span>' : ''}</span><small class="perm-desc">${escapeHtml(p.description)}</small></td>${roles
          .map((r) => {
            // An Admin-role-only permission (deleting reports) is never given to another role.
            const editable = r.canManage && mine.has(p.id) && !p.adminOnly;
            const checked = valueOf(r, p.id);
            return `<td class="cell${roleCompare.on ? (checked ? ' has' : ' lacks') : ''}"><input type="checkbox" data-matrix-role="${escapeHtml(r.id)}" data-matrix-perm="${escapeHtml(p.id)}" ${checked ? 'checked' : ''} ${editable ? '' : 'disabled'} aria-label="${escapeHtml(r.name)}: ${escapeHtml(p.label)}" /></td>`;
          })
          .join('')}</tr>`)
        .join('');
      return `<tbody><tr class="group-row${folded ? ' folded' : ''}"><th><button type="button" class="group-toggle" data-iam-group="${escapeHtml(group)}" aria-expanded="${!folded}">${escapeHtml(group)} <span class="muted">${inGroup.length}</span></button></th>${granted
        .map((n) => `<td class="cell group-sum"><span class="muted">${n}/${inGroup.length}</span></td>`)
        .join('')}</tr>${rows}</tbody>`;
    })
    .join('');
  const empty = roleCompare.on && !$('iam-perm-search').value.trim() ? 'These roles hold the same permissions.' : 'No permission matches.';
  $('iam-matrix').innerHTML = head + (body || `<tbody><tr><td colspan="${roles.length + 1}" class="hint">${empty}</td></tr></tbody>`);
  $('iam-groups-toggle').textContent = collapsedGroups.size >= groups.length ? 'Expand all' : 'Collapse all';
  $('iam-groups-toggle').disabled = roleCompare.on;
  $('iam-matrix-actions').hidden = access.edits.size === 0;
  renderRoleCompare(roles, differing);
}

/** The roles to compare, as tick boxes, and how many permissions differ between them. */
function renderRoleCompare(shown, differing) {
  $('iam-diff').checked = roleCompare.on;
  $('iam-compare').hidden = !roleCompare.on;
  if (!roleCompare.on) return;
  const ids = new Set(shown.map((r) => r.id));
  $('iam-compare-roles').innerHTML = access.data.roles
    .map((r) => `<label class="check"><input type="checkbox" data-iam-compare="${escapeHtml(r.id)}" ${roleCompare.roles.has(r.id) || (ids.has(r.id) && roleCompare.roles.size < 2) ? 'checked' : ''} /> <span class="role-pill role-${escapeHtml(r.id)}">${escapeHtml(r.name)}</span></label>`)
    .join('');
  $('iam-compare-note').textContent = differing === 1 ? '1 permission differs.' : `${differing} permissions differ.`;
}

$('iam-diff').addEventListener('change', () => {
  roleCompare.on = $('iam-diff').checked;
  if (access.data) renderMatrix();
});
$('iam-compare-roles').addEventListener('change', (event) => {
  const box = event.target.closest('[data-iam-compare]');
  if (!box) return;
  // Starting from "every role": the first untick keeps the others.
  if (roleCompare.roles.size < 2) roleCompare.roles = new Set(comparedRoles(access.data.roles).map((r) => r.id));
  if (box.checked) roleCompare.roles.add(box.dataset.iamCompare);
  else roleCompare.roles.delete(box.dataset.iamCompare);
  if (roleCompare.roles.size < 2) {
    box.checked = true;
    roleCompare.roles.add(box.dataset.iamCompare);
    return setStatus('iam-matrix-status', 'Compare at least two roles.', 'error');
  }
  setStatus('iam-matrix-status', '');
  renderMatrix();
});

$('iam-matrix').addEventListener('click', (event) => {
  const toggle = event.target.closest('[data-iam-group]');
  if (!toggle) return;
  const group = toggle.dataset.iamGroup;
  if (collapsedGroups.has(group)) collapsedGroups.delete(group);
  else collapsedGroups.add(group);
  renderMatrix();
});
$('iam-perm-search').addEventListener('input', () => access.data && renderMatrix());
$('iam-groups-toggle').addEventListener('click', () => {
  const groups = [...new Set(access.data?.permissions.map((p) => p.group) ?? [])];
  if (collapsedGroups.size >= groups.length) collapsedGroups.clear();
  else for (const g of groups) collapsedGroups.add(g);
  renderMatrix();
});

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

/** The role form: a new role, a copy of one (same permissions, nobody has it yet), or renaming one. */
const roleForm = { mode: 'new', id: null };

/** "Security Analyst (copy)", or "(copy 2)" and on when that name is taken. */
function copyName(name) {
  const taken = new Set(access.data.roles.map((r) => r.name.trim().toLowerCase()));
  for (let n = 1; ; n++) {
    const candidate = `${name} (copy${n > 1 ? ` ${n}` : ''})`.slice(0, 60);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function openRoleForm(mode, role = null) {
  roleForm.mode = mode;
  roleForm.id = role?.id ?? null;
  $('iam-role-form-title').textContent = { new: 'New role', copy: 'Duplicate role', rename: 'Rename role' }[mode];
  $('iam-role-form-of').hidden = !role;
  $('iam-role-form-of').textContent = role?.name ?? '';
  $('iam-role-submit').textContent = { new: 'Create role', copy: 'Create copy', rename: 'Save' }[mode];
  $('iam-role-hint').textContent = {
    new: 'Then tick its permissions in the matrix.',
    copy: 'The copy starts with the same permissions. Nobody has it until you give it to someone.',
    rename: 'The people with this role keep it, and its permissions stay as they are.',
  }[mode];
  $('iam-role-name').value = mode === 'rename' ? role.name : mode === 'copy' ? copyName(role.name) : '';
  $('iam-role-desc').value = role?.description ?? '';
  setStatus('iam-role-status', '');
  $('iam-role-form').hidden = false;
  $('iam-role-name').focus();
  $('iam-role-name').select();
}
function closeRoleForm() {
  $('iam-role-form').hidden = true;
  roleForm.mode = 'new';
  roleForm.id = null;
}

$('iam-role-new').addEventListener('click', () => {
  if (!$('iam-role-form').hidden && roleForm.mode === 'new') closeRoleForm();
  else openRoleForm('new');
});
$('iam-role-cancel').addEventListener('click', closeRoleForm);
$('iam-role-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('iam-role-name').value.trim();
  const description = $('iam-role-desc').value.trim();
  const role = access.data.roles.find((r) => r.id === roleForm.id);
  const mine = new Set(access.data.me.permissions);
  const adminOnly = new Set(access.data.permissions.filter((p) => p.adminOnly).map((p) => p.id));
  try {
    if (roleForm.mode === 'rename' && role) {
      // The saved permissions go back unchanged; ticks not saved yet stay in the matrix.
      access.data = await api(`/api/iam/roles/${encodeURIComponent(role.id)}`, { method: 'PUT', body: JSON.stringify({ name, description, permissions: role.permissions }) });
    } else {
      // A copy holds what the original holds, less anything only the Admin role may hold or that you do not hold yourself.
      const permissions = roleForm.mode === 'copy' && role ? role.permissions.filter((p) => mine.has(p) && !adminOnly.has(p)) : [];
      access.data = await api('/api/iam/roles', { method: 'POST', body: JSON.stringify({ name, description, permissions }) });
    }
    const done = { new: 'Role created — tick its permissions in its column, then save.', copy: 'Copy created — change its permissions in its column, then save.', rename: 'Renamed.' }[roleForm.mode];
    closeRoleForm();
    renderAccess();
    setStatus('iam-matrix-status', done, 'ok');
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
  const id = button.dataset.iamProfile || button.dataset.iamReset || button.dataset.iamTwostep || button.dataset.iamSsolink || button.dataset.iamIds || button.dataset.iamToggle || button.dataset.iamDelete || button.dataset.iamTenants;
  const user = access.data.users.find((u) => u.id === id);
  if (!user) return;
  if (button.dataset.iamProfile) {
    openProfileOf(id);
  } else if (button.dataset.iamTenants) {
    const tenants = [...button.closest('.tn-pop').querySelectorAll('input:checked')].map((input) => input.value);
    if (!tenants.length) return setStatus('iam-status', 'Choose at least one tenant.', 'error');
    iamCall(`/api/iam/users/${id}/tenants`, { method: 'PUT', body: JSON.stringify({ tenants }) }, 'Saved.');
  } else if (button.dataset.iamReset) {
    const password = generatePassword();
    if (!confirm(`Set a temporary password for ${user.email}? They are signed out and choose their own at next sign-in.`)) return;
    iamCall(`/api/iam/users/${id}/password`, { method: 'POST', body: JSON.stringify({ password }) }, `Temporary password for ${user.email}: ${password}`);
  } else if (button.dataset.iamTwostep) {
    if (!confirm(`Reset two-step sign-in for ${user.email}? Their authenticator app and recovery codes stop working here, and they set it up again.`)) return;
    iamCall(`/api/iam/users/${id}/two-step`, { method: 'DELETE' }, `Two-step sign-in was reset for ${user.email}.`);
  } else if (button.dataset.iamSsolink) {
    if (!confirm(`Reset the single sign-on link of ${user.email}? Do this when their account at the identity provider was made anew. Their next single sign-on links them again, by their email address.`)) return;
    iamCall(`/api/iam/users/${id}/sso-link`, { method: 'DELETE' }, `The single sign-on link of ${user.email} was reset.`);
  } else if (button.dataset.iamIds) {
    const value = prompt(`Checkmarx One identities that sign in as ${user.email} — Checkmarx One usernames, comma separated (their email always counts):`, user.cxoneIdentities.join(', '));
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
  const action = event.target.closest('[data-iam-role-rename], [data-iam-role-copy]');
  if (action) {
    const role = access.data.roles.find((r) => r.id === (action.dataset.iamRoleRename || action.dataset.iamRoleCopy));
    if (role) openRoleForm(action.dataset.iamRoleRename ? 'rename' : 'copy', role);
    return;
  }
  const button = event.target.closest('[data-iam-role-delete]');
  if (!button) return;
  const id = button.dataset.iamRoleDelete;
  if (!confirm(`Remove the role "${roleName(id)}"?`)) return;
  iamCall(`/api/iam/roles/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Role removed.');
});

// ---------------------------------------------------------------------------
// Credits page: the pool, usage over time, by project, allocated vs used
// ---------------------------------------------------------------------------

const USAGE_REFRESH_MS = 30_000;
export let usageTimer = null;
const usage = { data: null, loading: false };
const isoDay = (date) => date.toISOString().slice(0, 10);

/** The period the filters describe, as from/to dates (UTC). */
function usageRange() {
  const preset = $('usage-preset').value;
  const today = new Date();
  const day = (offset) => isoDay(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset)));
  if (preset === 'custom') return { from: $('usage-from').value, to: $('usage-to').value };
  if (preset === 'this-month') return { from: isoDay(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))), to: day(0) };
  if (preset === 'last-month') {
    return {
      from: isoDay(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1))),
      to: isoDay(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0))),
    };
  }
  return { from: day(1 - Number(preset)), to: day(0) };
}

export async function loadUsage() {
  clearTimeout(usageTimer);
  if ($('page-credits').hidden) return;
  const range = usageRange();
  const query = new URLSearchParams({ ...range, bucket: $('usage-bucket').value, projectId: $('usage-project').value });
  $('page-credits').classList.add('loading');
  try {
    usage.data = await api(`/api/credits/usage?${query}`);
    renderUsage(usage.data);
  } catch (error) {
    if (handleAuthLoss(error)) return;
    $('usage-chart').innerHTML = `<p class="status error">${escapeHtml(error.message)}</p>`;
  } finally {
    $('page-credits').classList.remove('loading');
  }
  usageTimer = setTimeout(loadUsage, USAGE_REFRESH_MS);
}

const BUCKET_NAMES = { day: 'day', week: 'week', month: 'month' };
function bucketLabel(start, bucket, { long = false } = {}) {
  const d = new Date(`${start}T00:00:00Z`);
  if (bucket === 'month') return d.toLocaleDateString(undefined, { month: long ? 'long' : 'short', year: 'numeric', timeZone: 'UTC' });
  const text = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return bucket === 'week' && long ? `Week of ${text}` : text;
}

function renderUsage(data) {
  // Projects to filter by: every one with an allocation or usage, keeping the choice.
  const select = $('usage-project');
  const chosen = select.value;
  const names = new Map(data.projects.map((p) => [p.projectId, p.projectName || p.projectId]));
  for (const p of data.byProject) if (!names.has(p.projectId)) names.set(p.projectId, p.projectName || p.projectId);
  select.innerHTML = `<option value="">All projects</option>${[...names]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, name]) => `<option value="${escapeHtml(id)}"${id === chosen ? ' selected' : ''}>${escapeHtml(name)}</option>`)
    .join('')}`;

  const pool = data.pool;
  $('pool-period-note').textContent = pool.limited ? `${fmt(pool.size)} credits · ${periodText(pool)}` : 'No pool size set';
  $('credits-pool').innerHTML = poolHtml(pool);

  const t = data.totals;
  const span = `${new Date(`${data.from}T00:00:00Z`).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' })} – ${new Date(`${data.to}T00:00:00Z`).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' })}`;
  $('usage-range-note').textContent = `${span} · by ${BUCKET_NAMES[data.bucket]}${data.projectId ? ` · ${names.get(data.projectId) ?? data.projectId}` : ''}`;
  const share = (n) => (t.credits ? `${Math.round((n / t.credits) * 100)}% of credits used` : '—');
  $('usage-tiles').innerHTML = [
    { label: 'Credits used', value: fmt(t.credits), detail: `${fmt(t.requests)} request${t.requests === 1 ? '' : 's'} · ${fmt(t.projects)} project${t.projects === 1 ? '' : 's'}`, hero: true },
    { label: 'AI Triage', value: fmt(t.triage), detail: share(t.triage), key: 'triage' },
    { label: 'AI Remediation', value: fmt(t.remediation), detail: share(t.remediation), key: 'remediation' },
    { label: `Average per ${BUCKET_NAMES[data.bucket]}`, value: fmt(Math.round((t.credits / Math.max(1, data.series.length)) * 10) / 10), detail: `Busiest: ${busiest(data)}` },
  ]
    .map((x) => `<div class="${x.hero ? 'hero' : ''}"><span class="label">${x.key ? `<i class="key key-${x.key}"></i>` : ''}${escapeHtml(x.label)}</span><span class="value">${escapeHtml(x.value)}</span><span class="detail">${escapeHtml(x.detail)}</span></div>`)
    .join('');

  drawUsageChart(data);
  renderUsageTable(data);
  renderUsageProjects(data);
  renderAllocations(data.allocations ?? []);
}

function busiest(data) {
  const top = data.series.reduce((best, row) => (row.credits > (best?.credits ?? 0) ? row : best), null);
  return top ? `${bucketLabel(top.start, data.bucket, { long: true })} (${fmt(top.credits)})` : 'none yet';
}

/** A clean axis maximum and step: 1, 2 or 5 × 10^n. */
function niceScale(max, ticks = 4) {
  if (max <= 0) return { top: 4, step: 1 };
  const raw = max / ticks;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((v) => v >= raw);
  return { top: Math.ceil(max / step) * step, step: Math.max(1, step) };
}

/** Stacked columns per day/week/month: triage at the base, remediation on top. */
function drawUsageChart(data) {
  const box = $('usage-chart');
  const series = data.series;
  if (!data.totals.credits) {
    box.innerHTML = '<div class="chart-empty">No credits used in this period.</div>';
    return;
  }
  const width = Math.max(320, box.clientWidth || 800);
  const height = 260;
  const pad = { top: 18, right: 8, bottom: 28, left: 40 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const { top, step } = niceScale(Math.max(...series.map((r) => r.credits)));
  const y = (v) => pad.top + plotH - (v / top) * plotH;
  const band = plotW / series.length;
  const barW = Math.max(2, Math.min(24, band * 0.7));
  const GAP = 2;
  // A rectangle with a 4px rounded top (square at the baseline, or square top when another segment sits on it).
  const rect = (x, yTop, h, roundTop) => {
    if (h <= 0) return '';
    const r = roundTop ? Math.min(4, barW / 2, h) : 0;
    return `M${x},${yTop + h}V${yTop + r}${r ? `Q${x},${yTop} ${x + r},${yTop}` : ''}H${x + barW - r}${r ? `Q${x + barW},${yTop} ${x + barW},${yTop + r}` : ''}V${yTop + h}Z`;
  };
  const grid = [];
  for (let v = 0; v <= top; v += step) {
    grid.push(`<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(v)}" y2="${y(v)}" /><text x="${pad.left - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`);
  }
  const labelEvery = Math.ceil(series.length / Math.max(1, Math.floor(plotW / 64)));
  const peak = series.reduce((best, row, i) => (row.credits > series[best].credits ? i : best), 0);
  const cols = series
    .map((row, i) => {
      const x = pad.left + i * band + (band - barW) / 2;
      const hT = (row.triage / top) * plotH;
      const hR = (row.remediation / top) * plotH;
      const baseY = pad.top + plotH;
      const triageTop = baseY - hT;
      const remTop = triageTop - hR - (hT > 0 && hR > 0 ? GAP : 0);
      const paths = `<path class="bar-triage" d="${rect(x, triageTop, hT, hR <= 0)}" /><path class="bar-remediation" d="${rect(x, remTop, hR, true)}" />`;
      const label = i % labelEvery === 0 ? `<text class="axis-x" x="${x + barW / 2}" y="${height - 8}" text-anchor="middle">${escapeHtml(bucketLabel(row.start, data.bucket))}</text>` : '';
      const peakLabel = i === peak && row.credits ? `<text class="peak" x="${x + barW / 2}" y="${Math.min(remTop, triageTop) - 5}" text-anchor="middle">${fmt(row.credits)}</text>` : '';
      return `<g class="col" data-i="${i}" tabindex="0" role="img" aria-label="${escapeHtml(`${bucketLabel(row.start, data.bucket, { long: true })}: ${row.triage} triage, ${row.remediation} remediation`)}">
        <rect class="hit" x="${pad.left + i * band}" y="${pad.top}" width="${band}" height="${plotH}" />${paths}${peakLabel}</g>${label ? `<g class="axis">${label}</g>` : ''}`;
    })
    .join('');
  box.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-label="Credits used per ${data.bucket}">
    <g class="grid axis">${grid.join('')}</g>${cols}</svg><div class="tip" hidden></div>`;

  const tip = box.querySelector('.tip');
  const show = (g) => {
    const row = series[Number(g.dataset.i)];
    tip.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'tip-title';
    title.textContent = bucketLabel(row.start, data.bucket, { long: true });
    tip.append(title);
    for (const [name, value, color] of [['AI Triage', row.triage, 'var(--series-1)'], ['AI Remediation', row.remediation, 'var(--series-2)'], ['Total', row.credits, '']]) {
      const line = document.createElement('div');
      line.className = 'tip-row';
      line.innerHTML = `<span class="line-key" style="background:${color || 'transparent'}"></span><b></b><span></span>`;
      line.querySelector('b').textContent = fmt(value);
      line.querySelector('span:last-child').textContent = name;
      tip.append(line);
    }
    tip.hidden = false;
    const hit = g.querySelector('.hit').getBBox();
    const scale = box.clientWidth / width;
    const left = (hit.x + hit.width / 2) * scale;
    tip.style.left = `${Math.min(Math.max(0, left - tip.offsetWidth / 2), box.clientWidth - tip.offsetWidth)}px`;
    tip.style.top = `${Math.max(0, pad.top * scale - 4)}px`;
  };
  for (const g of box.querySelectorAll('.col')) {
    g.addEventListener('pointerenter', () => show(g));
    g.addEventListener('focus', () => show(g));
    g.addEventListener('pointerleave', () => (tip.hidden = true));
    g.addEventListener('blur', () => (tip.hidden = true));
  }
}

function renderUsageTable(data) {
  $('usage-table').innerHTML = `<div class="table-wrap"><table class="probe">
    <thead><tr><th>${data.bucket === 'day' ? 'Day' : data.bucket === 'week' ? 'Week of' : 'Month'}</th><th class="num">AI Triage</th><th class="num">AI Remediation</th><th class="num">Total</th><th class="num">Requests</th><th class="num">Running total</th></tr></thead>
    <tbody>${data.series
      .map((r) => `<tr><td>${escapeHtml(bucketLabel(r.start, data.bucket, { long: true }))}</td><td class="num">${fmt(r.triage)}</td><td class="num">${fmt(r.remediation)}</td><td class="num"><b>${fmt(r.credits)}</b></td><td class="num">${fmt(r.requests)}</td><td class="num">${fmt(r.cumulative)}</td></tr>`)
      .join('')}</tbody>
    <tfoot><tr><th>Total</th><th class="num">${fmt(data.totals.triage)}</th><th class="num">${fmt(data.totals.remediation)}</th><th class="num">${fmt(data.totals.credits)}</th><th class="num">${fmt(data.totals.requests)}</th><th></th></tr></tfoot>
  </table></div>`;
}

function renderUsageProjects(data) {
  if (!data.byProject.length) {
    $('usage-projects').innerHTML = '<p class="hint">No project used credits in this period.</p>';
    return;
  }
  const max = Math.max(...data.byProject.map((p) => p.credits));
  const pct = (n) => `${((n / max) * 100).toFixed(2)}%`;
  $('usage-projects').innerHTML = `<div class="table-wrap"><table class="probe">
    <thead><tr><th>Project</th><th class="share-cell">Share</th><th class="num">AI Triage</th><th class="num">AI Remediation</th><th class="num">Total</th><th class="num">Requests</th><th>Last used</th></tr></thead>
    <tbody>${data.byProject
      .map((p) => `<tr>
        <td>${escapeHtml(p.projectName || p.projectId)}</td>
        <td class="share-cell"><div class="hbar" title="${p.triage} triage, ${p.remediation} remediation"><span class="m-triage" style="width:${pct(p.triage)}"></span><span class="m-remediation" style="width:${pct(p.remediation)}"></span></div></td>
        <td class="num">${fmt(p.triage)}</td><td class="num">${fmt(p.remediation)}</td><td class="num"><b>${fmt(p.credits)}</b></td><td class="num">${fmt(p.requests)}</td>
        <td>${escapeHtml(new Date(p.lastUsedAt).toLocaleString())}</td></tr>`)
      .join('')}</tbody>
    <tfoot><tr><th>Total</th><th></th><th class="num">${fmt(data.totals.triage)}</th><th class="num">${fmt(data.totals.remediation)}</th><th class="num">${fmt(data.totals.credits)}</th><th class="num">${fmt(data.totals.requests)}</th><th></th></tr></tfoot>
  </table></div>`;
}

/** Per project: first allocated, allocated now, used through this utility, left. */
function renderAllocations(all) {
  const filter = $('alloc-search').value.trim().toLowerCase();
  const list = filter ? all.filter((p) => (p.projectName || p.projectId).toLowerCase().includes(filter)) : all;
  renderTakeBack(all);
  renderGive();
  renderSpend(all);
  const mayTakeBack = can('credits.allocate');
  const mayPick = canAny('triage.run credits.allocate');
  if (!list.length) {
    $('credit-allocations').innerHTML = `<p class="hint">${all.length ? 'No project matches.' : mayTakeBack ? 'No project has an allocation yet — give credits above, or on the Workbench.' : 'No project has an allocation yet.'}</p>`;
    return;
  }
  const bar = (k) => {
    const pct = k.allocated ? Math.min(100, Math.round((k.used / k.allocated) * 100)) : 0;
    return `<div class="use-bar" title="${k.used} of ${k.allocated} used"><span style="width:${pct}%"></span></div>`;
  };
  const cells = (k) => `<td class="num">${fmt(k.initial)}</td><td class="num">${fmt(k.allocated)}</td><td class="num"><b>${fmt(k.used)}</b>${bar(k)}</td><td class="num">${fmt(k.remaining)}</td>`;
  const sum = (kind, key) => list.reduce((n, p) => n + (p[kind][key] ?? 0), 0);
  const totals = (kind) => ['initial', 'allocated', 'used', 'remaining'].map((key) => `<th class="num">${fmt(sum(kind, key))}</th>`).join('');
  $('credit-allocations').innerHTML = `<div class="table-wrap"><table class="probe alloc-table">
    <thead>
      <tr>${mayPick ? '<th rowspan="2" class="alloc-pick"><span class="sr-only">Pick</span></th>' : ''}<th rowspan="2">Project</th><th colspan="4" class="group">AI Triage</th><th colspan="4" class="group">AI Remediation</th>${mayTakeBack ? '<th rowspan="2"><span class="sr-only">Give or take back</span></th>' : ''}</tr>
      <tr>${'<th class="num">At start</th><th class="num">Allocated</th><th class="num">Used</th><th class="num" data-i18n-ctx="credits">Left</th>'.repeat(2)}</tr>
    </thead>
    <tbody>${list
      .map((p) => `<tr>${mayPick ? `<td class="alloc-pick"><input type="checkbox" data-spend-pick="${escapeHtml(p.projectId)}" aria-label="Pick" ${spend.picked.has(p.projectId) ? 'checked' : ''} /></td>` : ''}<td><span translate="no">${escapeHtml(p.projectName || p.projectId)}</span><div class="hint">${allocationRule(p)}</div>${spend.gone.has(p.projectId) ? '<div class="hint is-warn">No longer in Checkmarx One: take its credits back.</div>' : ''}</td>${cells(p.triage)}${cells(p.remediation)}${mayTakeBack ? `<td class="alloc-actions"><button type="button" class="sm" data-give="${escapeHtml(p.projectId)}" title="Give this project more credits">Give</button>${unusedOf(p) ? `<button type="button" class="sm danger-soft" data-reclaim="${escapeHtml(p.projectId)}" title="Take back the ${unusedOf(p)} credit(s) this project has not used">Take back ${fmt(unusedOf(p))}</button>` : ''}</td>` : ''}</tr>`)
      .join('')}</tbody>
    <tfoot><tr>${mayPick ? '<th></th>' : ''}<th>Total</th>${totals('triage')}${totals('remediation')}${mayTakeBack ? '<th></th>' : ''}</tr></tfoot>
  </table></div>`;
}

/** Under a project's name: the severities its needs cover, and when it was first given credits (each piece translatable). */
function allocationRule(p) {
  const severities = p.severities.length ? p.severities.map((s) => `<span>${escapeHtml(s.charAt(0) + s.slice(1).toLowerCase())}</span>`).join(', ') : '<span>No severities</span>';
  return `${severities}${p.initialAt ? ` · <span>First given:</span> <span translate="no">${escapeHtml(new Date(p.initialAt).toLocaleDateString())}</span>` : ''}`;
}

/** Credits a project was given and has not used (nor has in flight): what taking back returns. */
const unusedOf = (p) => (p.triage.remaining ?? 0) + (p.remediation.remaining ?? 0);

/** The clean-slate bar above the allocations: how much every project holds unused. */
function renderTakeBack(all) {
  const bar = $('cc-takeback');
  if (!can('credits.allocate')) return (bar.hidden = true);
  const unused = all.reduce((n, p) => n + unusedOf(p), 0);
  const holding = all.filter((p) => unusedOf(p) > 0).length;
  bar.hidden = all.length === 0;
  $('cc-reclaim-all').disabled = unused === 0;
  $('cc-reclaim-all').textContent = unused ? `Take back all ${fmt(unused)} unused credits` : 'Nothing to take back';
  // Plain numbers (no thousands separator), so each wording is one entry to translate.
  $('cc-takeback-note').textContent = unused
    ? `${holding} project${holding === 1 ? ' holds' : 's hold'} ${unused} credit${unused === 1 ? '' : 's'} they have not used. Taking them back returns them to the credit pool; used credits stay counted.`
    : 'Every project has used what it was given. Nothing is waiting to be taken back.';
}

/** Take back unused credits: from every project (clean slate), or one. */
async function takeBackCredits(projectIds = null) {
  const all = usage.data?.allocations ?? [];
  const chosen = projectIds ? all.filter((p) => projectIds.includes(p.projectId)) : all;
  const triage = chosen.reduce((n, p) => n + (p.triage.remaining ?? 0), 0);
  const remediation = chosen.reduce((n, p) => n + (p.remediation.remaining ?? 0), 0);
  if (!triage && !remediation) return setStatus('cc-takeback-status', 'Nothing to take back.', 'ok');
  const who = projectIds ? `"${chosen[0]?.projectName || chosen[0]?.projectId}"` : `every project (${chosen.filter((p) => unusedOf(p)).length})`;
  if (!confirm(`Take back ${triage + remediation} unused credit(s) — ${triage} triage, ${remediation} remediation — from ${who} to the credit pool?\n\nDevelopers cannot triage or remediate from their reports until credits are given again. Used credits stay counted.`)) return;
  try {
    const result = await api('/api/credits/reclaim', { method: 'POST', body: JSON.stringify(projectIds ? { projectIds } : { all: true }) });
    setStatus('cc-takeback-status', `Took back ${fmt(result.reclaimed)} credit(s) from ${result.projects} project(s) to the credit pool.`, 'ok');
    logger.add(`Took back ${result.reclaimed} unused credit(s) from ${result.projects} project(s)`, 'success');
    if (usage.data) {
      usage.data.allocations = result.allocations;
      usage.data.pool = result.pool;
      $('credits-pool').innerHTML = poolHtml(result.pool);
    }
    renderAllocations(result.allocations);
    creditsChanged();
  } catch (error) {
    if (handleAuthLoss(error)) return;
    setStatus('cc-takeback-status', error.message, 'error');
  }
}

// Taking back spends nothing, so it needs no findings loaded and no check with Checkmarx One first.
$('cc-reclaim-all').addEventListener('click', () => takeBackCredits());
$('credit-allocations').addEventListener('change', (event) => {
  const box = event.target.closest('[data-spend-pick]');
  if (!box) return;
  if (box.checked) spend.picked.add(box.dataset.spendPick);
  else spend.picked.delete(box.dataset.spendPick);
  renderSpend(usage.data?.allocations ?? []);
});
$('credit-allocations').addEventListener('click', (event) => {
  const button = event.target.closest('[data-reclaim]');
  if (button) takeBackCredits([button.dataset.reclaim]);
  const give = event.target.closest('[data-give]');
  if (give) chooseGiveProject(give.dataset.give);
});

// ---------------------------------------------------------------------------
// Impact: hours AI saved, findings it cleared, time to fix, the debt week by week
// ---------------------------------------------------------------------------

const impact = { data: null, asTable: false };
const SEV_LABEL = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };
const num1 = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 }));
const priceOf = (n, currency) => moneyOf(n, currency, 2);
const cashOf = (n, currency) => moneyOf(n, currency, 0);

export async function loadImpact() {
  const days = $('impact-days').value;
  $('impact-download').href = `/api/impact/summary.html?days=${encodeURIComponent(days)}`;
  try {
    impact.data = await api(`/api/impact?days=${encodeURIComponent(days)}`);
    renderImpact();
  } catch (error) {
    if (handleAuthLoss(error)) return;
    $('impact-tiles').innerHTML = `<p class="status error">${escapeHtml(error.message)}</p>`;
  }
}

function renderImpact() {
  const d = impact.data;
  if (!d) return;
  const m = d.money;
  const note = $('impact-note');
  note.hidden = !d.partial && Boolean(d.since);
  note.textContent = !d.since
    ? 'No readings yet. Figures start with the next Workbench fetch (with no date window) or tracked report refresh.'
    : `Readings start on ${d.since.slice(0, 10)}: the period before that is not included.`;
  // Figures from this person's own profile: said once, with where to change them.
  const mine = $('impact-currency-note');
  mine.hidden = !d.personal;
  mine.innerHTML = d.personal
    ? `<span>Worked out with your own figures from your profile.</span> <a href="#/settings/profile">Change them →</a>`
    : '';
  const tile = (label, value, sub, hero = false, tone = '') => `<div class="impact-tile${hero ? ' hero' : ''}"><span class="label">${label}</span><span class="value${tone ? ` ${tone}` : ''}">${value}</span><span class="sub">${sub}</span></div>`;
  const debt = d.debt;
  $('impact-tiles').innerHTML = [
    tile('Hours saved', `${num1(d.hours.total)} h`, `<span>${num1(d.hours.triage)} h triage</span> · <span>${num1(d.hours.fix)} h fixing</span>`, true),
    m.value === null
      ? tile('Value of that time', '—', `<a href="#/settings/profile">Set an hourly cost</a>`)
      // Amounts carry their currency, so they stay as they are; the words around them are translated on their own.
      : tile(m.cost === null ? 'Value of that time' : 'Saved, after credits', `<span translate="no">${escapeHtml(cashOf(m.net ?? m.value, m.currency))}</span>`, m.cost === null ? '<span>before the cost of credits</span>' : `<span><span translate="no">${escapeHtml(cashOf(m.value, m.currency))}</span> <span>saved</span></span> · <span><span translate="no">${escapeHtml(cashOf(m.cost, m.currency))}</span> <span>in credits</span></span>`),
    tile('Noise removed', num1(d.noiseRemoved), '<span>findings AI Triage showed not exploitable</span>'),
    tile('Fixed with AI', num1(d.aiFixed), `<span>${num1(d.manualFixed)} fixed by hand</span>`),
    // Down is good: the change wears the good colour (with its arrow), never only colour.
    tile('Security debt', debt.change === null ? '—' : `${debt.change < 0 ? '▼' : debt.change > 0 ? '▲' : ''} ${Math.abs(debt.change)}%`, debt.zeroBy ? `<span>zero by ${escapeHtml(debt.zeroBy)} at this pace</span>` : '<span>open findings, weighted by severity</span>', false, debt.change < 0 ? 'good' : debt.change > 0 ? 'bad' : ''),
    tile('Credits per finding closed', num1(d.creditsPerClosed), d.costPerClosed === null ? '<span>fixed or cleared by AI</span>' : `<span><span translate="no">${escapeHtml(priceOf(d.costPerClosed, m.currency))}</span> <span>each</span></span>`),
  ].join('');
  $('impact-debt-line').textContent = debt.change === null
    ? 'No open findings at the start of the period.'
    : `${debt.change <= 0 ? 'Down' : 'Up'} ${Math.abs(debt.change)}% in this period: from ${num1(debt.start)} to ${num1(debt.now)}.`;
  renderImpactChart();
  renderImpactTimeToFix();
  const s = d.settings;
  $('impact-how').innerHTML = [
    `Hours saved: Checkmarx One results triaged by AI (${num1(d.credits.triage)}) × ${s.triageMinutes} min, plus fixes with AI (${num1(d.aiFixed)}) × ${s.fixMinutes} min.`,
    'A fix counts only once Checkmarx One no longer reports the finding. Rows that share one result count once.',
    m.value === null ? 'Money: set an hourly cost and the price of one credit under Settings → AI & credit pool.' : 'Money: hours saved × the hourly cost, less the credits used × the price of one credit (both under Settings → AI & credit pool).',
    'Security debt: open Checkmarx One results weighted by severity (critical 10, high 5, medium 2, low 1). The date it reaches zero follows the last four weeks.',
    'Time to fix: days from first detection until Checkmarx One no longer reports it. AI-fixed and fixed by hand are compared over the same period.',
  ].map((line) => `<li>${line}</li>`).join('');
  renderImpactProjects();
  const monthly = $('impact-monthly-state');
  if (monthly) {
    // Each sentence its own piece, so each is translated whole.
    monthly.innerHTML = d.monthlyOn
      ? `<span>On: emailed on the first day of each month, for the month before.</span> <span>Recipients: ${(d.monthlyTo ?? []).length}.</span>${d.lastSent ? ` <span>Last sent: ${escapeHtml(d.lastSent)}.</span>` : ''}`
      : '<span>Off: add who gets it under Settings → AI & credit pool.</span>';
    $('impact-send').disabled = !d.monthlyOn;
  }
}

/** The debt as one line with a light wash, a crosshair and a tooltip; or the same as a table. */
function renderImpactChart() {
  const series = impact.data.series ?? [];
  const box = $('impact-chart');
  $('impact-as-table').textContent = impact.asTable ? 'Show as a chart' : 'Show as a table';
  $('impact-as-table').setAttribute('aria-pressed', String(impact.asTable));
  if (series.length < 2 && !impact.asTable) {
    box.innerHTML = '<p class="hint">The chart appears after two weeks of readings.</p>';
    return;
  }
  if (impact.asTable) {
    box.innerHTML = `<div class="table-wrap"><table class="probe"><thead><tr><th>Week</th><th class="num">Debt</th>${Object.keys(SEV_LABEL).map((k) => `<th class="num">${SEV_LABEL[k]}</th>`).join('')}</tr></thead><tbody>${series
      .map((p) => `<tr><td>${escapeHtml(p.at.slice(0, 10))}</td><td class="num">${num1(p.score)}</td>${Object.keys(SEV_LABEL).map((k) => `<td class="num">${num1(p.bySeverity[k])}</td>`).join('')}</tr>`)
      .join('')}</tbody></table></div>`;
    return;
  }
  const width = Math.max(320, box.clientWidth || 720);
  const height = 220;
  const pad = { l: 44, r: 52, t: 14, b: 26 };
  const max = Math.max(1, ...series.map((p) => p.score));
  const step = 10 ** Math.floor(Math.log10(max));
  const top = Math.ceil(max / step) * step;
  const x = (i) => pad.l + (i / (series.length - 1)) * (width - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / top) * (height - pad.t - pad.b);
  const line = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join('');
  const last = series.at(-1);
  box.innerHTML = `<svg class="impact-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Security debt from ${escapeHtml(series[0].at.slice(0, 10))} to ${escapeHtml(last.at.slice(0, 10))}: ${num1(series[0].score)} to ${num1(last.score)}">
      ${[0, top / 2, top].map((v) => `<line class="grid" x1="${pad.l}" x2="${width - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${num1(v)}</text>`).join('')}
      <path class="area" d="${line}L${x(series.length - 1)},${y(0)}L${x(0)},${y(0)}Z"/>
      <path class="line" d="${line}"/>
      <circle class="end" cx="${x(series.length - 1)}" cy="${y(last.score)}" r="4"/>
      <text class="end-label" x="${x(series.length - 1) + 8}" y="${y(last.score) + 4}">${num1(last.score)}</text>
      <text class="tick" x="${pad.l}" y="${height - 6}">${escapeHtml(series[0].at.slice(0, 10))}</text>
      <text class="tick" x="${width - pad.r}" y="${height - 6}" text-anchor="end">${escapeHtml(last.at.slice(0, 10))}</text>
      <line class="cross" x1="0" x2="0" y1="${pad.t}" y2="${height - pad.b}" visibility="hidden"/>
      <circle class="dot" r="4" visibility="hidden"/>
      <rect class="hit" x="${pad.l}" y="0" width="${width - pad.l - pad.r}" height="${height}" fill="transparent"/>
    </svg><div class="impact-tip" hidden></div>`;
  const svg = box.querySelector('svg');
  const tip = box.querySelector('.impact-tip');
  const cross = svg.querySelector('.cross');
  const dot = svg.querySelector('.dot');
  const show = (event) => {
    const rect = svg.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    const i = Math.max(0, Math.min(series.length - 1, Math.round(((px - pad.l) / (width - pad.l - pad.r)) * (series.length - 1))));
    const p = series[i];
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    dot.setAttribute('cx', x(i));
    dot.setAttribute('cy', y(p.score));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('visibility', 'visible');
    tip.innerHTML = `<b>${escapeHtml(p.at.slice(0, 10))}</b><span><span>Debt</span> ${num1(p.score)}</span>${Object.keys(SEV_LABEL).map((k) => `<span><span>${SEV_LABEL[k]}</span> ${num1(p.bySeverity[k])}</span>`).join('')}`;
    tip.hidden = false;
    const left = (x(i) / width) * rect.width;
    tip.style.insetInlineStart = `${Math.min(rect.width - 150, Math.max(0, left + 12))}px`;
  };
  const hide = () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
  };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerleave', hide);
}

function renderImpactTimeToFix() {
  const rows = impact.data.timeToFix.filter((r) => r.aiCount || r.manualCount);
  const days = (value, count) => (value === null ? '—' : `<span>${num1(value)} days</span> <span class="hint">(${count})</span>`);
  $('impact-ttf').innerHTML = rows.length
    ? `<div class="table-wrap"><table class="probe"><thead><tr><th>Severity</th><th class="num">With AI</th><th class="num">By hand</th><th class="num">Difference</th></tr></thead><tbody>${rows
        .map((r) => `<tr><td>${SEV_LABEL[r.severity]}</td><td class="num">${days(r.ai, r.aiCount)}</td><td class="num">${days(r.manual, r.manualCount)}</td><td class="num">${r.ai !== null && r.manual !== null ? `<span>${num1(Math.abs(r.manual - r.ai))} days ${r.ai <= r.manual ? 'sooner' : 'later'}</span>` : '—'}</td></tr>`)
        .join('')}</tbody></table></div>`
    : '<p class="hint">No fixes in this period yet.</p>';
}

function renderImpactProjects() {
  const list = impact.data.byProject;
  const days = (v) => (v === null ? '—' : num1(v));
  $('impact-projects').innerHTML = list.length
    ? `<div class="table-wrap"><table class="probe"><thead><tr><th>Project</th><th class="num">Checked by AI</th><th class="num">Not exploitable</th><th class="num">Fixed with AI</th><th class="num">Fixed by hand</th><th class="num">Days to fix, AI</th><th class="num">Days to fix, by hand</th><th class="num">Credits</th><th class="num">Credits per finding closed</th><th class="num">Open</th></tr></thead><tbody>${list
        .map((p) => `<tr><td translate="no">${escapeHtml(p.projectName || p.projectId)}</td><td class="num">${p.aiTriaged}</td><td class="num">${p.notExploitable}</td><td class="num">${p.aiFixed}</td><td class="num">${p.manualFixed}</td><td class="num">${days(p.aiMedianDays)}</td><td class="num">${days(p.manualMedianDays)}</td><td class="num">${p.credits}</td><td class="num">${days(p.creditsPerClosed)}</td><td class="num">${p.open}</td></tr>`)
        .join('')}</tbody></table></div>`
    : '<p class="hint">No readings yet.</p>';
}

function exportImpactCsv() {
  const d = impact.data;
  if (!d) return;
  const cell = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  const rows = [
    ['Project', 'Checked by AI', 'Not exploitable', 'Fixed with AI', 'Fixed by hand', 'Median days to fix, AI', 'Median days to fix, by hand', 'Credits', 'Credits per finding closed', 'Open now'],
    ...d.byProject.map((p) => [p.projectName || p.projectId, p.aiTriaged, p.notExploitable, p.aiFixed, p.manualFixed, p.aiMedianDays, p.manualMedianDays, p.credits, p.creditsPerClosed, p.open]),
  ];
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([rows.map((r) => r.map(cell).join(',')).join('\n')], { type: 'text/csv' }));
  link.download = `impact-${d.from.slice(0, 10)}-to-${d.to.slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

$('impact-days').addEventListener('change', () => loadImpact());
$('impact-as-table').addEventListener('click', () => {
  impact.asTable = !impact.asTable;
  if (impact.data) renderImpactChart();
});
$('impact-csv').addEventListener('click', exportImpactCsv);
$('impact-send').addEventListener('click', async () => {
  if (!confirm("Email last month's impact summary now to the people on the list?")) return;
  setStatus('impact-send-status', 'Sending…');
  try {
    const result = await api('/api/impact/email', { method: 'POST', body: '{}' });
    setStatus('impact-send-status', `Sent the summary for ${result.month}. Recipients: ${result.to.length}.`, 'ok');
    loadImpact();
  } catch (error) {
    if (!handleAuthLoss(error)) setStatus('impact-send-status', error.message, 'error');
  }
});
window.addEventListener('resize', () => {
  if (state.page === 'impact' && impact.data && !impact.asTable) renderImpactChart();
});

// ---------------------------------------------------------------------------
// Using the credits on the Credit Control page: Triage now / Remediate now
// ---------------------------------------------------------------------------

/** Projects ticked in Allocated vs used; none ticked means every project. */
const spend = { picked: new Set(), gone: new Set() };

/** Projects the last spend or allocation found deleted from Checkmarx One: marked in the table, named in the status. */
function noteGone(result) {
  for (const p of result?.gone ?? []) spend.gone.add(p.projectId);
  return result?.goneNote ? ` ${result.goneNote}` : '';
}

const spendSeverities = () => [...document.querySelectorAll('[data-spend-sev]:checked')].map((box) => box.dataset.spendSev);
/** The AI engines ticked (SAST and SCA by default; none ticked is never sent). */
const spendEngines = () => [...document.querySelectorAll('[data-spend-engine]:checked')].map((box) => box.dataset.spendEngine);

/**
 * What the ticked projects' chosen severities need, for those loaded on the Workbench
 * (Credit Control reads Checkmarx One only when a button is pressed); null when unknown.
 */
function spendNeed(chosen, severities) {
  const loaded = new Map(state.projects.filter((p) => p.credits).map((p) => [p.projectId, p.credits]));
  if (!chosen.length || !chosen.every((p) => loaded.has(p.projectId))) return null;
  const sum = (key) => chosen.reduce((n, p) => n + severities.reduce((m, s) => m + (loaded.get(p.projectId)[key]?.[s] ?? 0), 0), 0);
  return { triage: sum('toTriage'), remediation: 3 * sum('toRemediateBySeverity') };
}

/**
 * The bar's buttons work once the chosen projects hold credits to use (1 to triage, 3 to remediate),
 * and turn gold only when projects are ticked and their credits cover what the ticked severities need.
 */
function renderSpend(all) {
  const bar = $('cc-spend');
  bar.hidden = !canAny('triage.run credits.allocate') || !all.length;
  if (bar.hidden) return;
  for (const id of spend.picked) if (!all.some((p) => p.projectId === id)) spend.picked.delete(id);
  const chosen = spend.picked.size ? all.filter((p) => spend.picked.has(p.projectId)) : all;
  const triage = chosen.reduce((n, p) => n + (p.triage.remaining ?? 0), 0);
  const remediation = chosen.reduce((n, p) => n + (p.remediation.remaining ?? 0), 0);
  const severities = spendSeverities().length > 0 && spendEngines().length > 0;
  const need = spend.picked.size ? spendNeed(chosen, spendSeverities()) : null;
  const covers = (kind, left) => need !== null && need[kind] > 0 && left >= need[kind];
  $('cc-run-triage').disabled = !severities || triage < 1;
  $('cc-run-remediation').disabled = !severities || remediation < 3;
  $('cc-run-triage').classList.toggle('is-golden', !$('cc-run-triage').disabled && covers('triage', triage));
  $('cc-run-remediation').classList.toggle('is-golden', !$('cc-run-remediation').disabled && covers('remediation', remediation));
  const figures = (left, needed) => `${fmt(left)} credits left${needed === null ? '' : ` · ${fmt(needed)} needed`}`;
  $('cc-lane-triage').textContent = figures(triage, need?.triage ?? null);
  $('cc-lane-remediation').textContent = figures(remediation, need?.remediation ?? null);
  $('cc-spend-left').textContent = spend.picked.size
    ? `${chosen.length} project${chosen.length === 1 ? '' : 's'} ticked.${need ? '' : ' Load them on the Workbench to see what they need; the buttons turn gold once their credits cover it.'}`
    : 'Every project. Tick projects to see what they need: the buttons turn gold once their credits cover it.';
}

async function runCredits(kind) {
  const severities = spendSeverities();
  if (!severities.length) return setStatus('cc-spend-status', 'Pick at least one severity.', 'error');
  const engines = spendEngines();
  if (!engines.length) return setStatus('cc-spend-status', 'Pick at least one engine.', 'error');
  const all = usage.data?.allocations ?? [];
  const chosen = spend.picked.size ? all.filter((p) => spend.picked.has(p.projectId)) : all;
  const sev = `${severities.map((s) => s.toLowerCase()).join(', ')} ${describeEngines(engines)}`;
  const who = spend.picked.size ? `the ${chosen.length} ticked project(s)` : `every project holding credits (${chosen.length})`;
  const question = kind === 'triage'
    ? `Run AI Triage on the ${sev} findings still awaiting triage in ${who}? It uses Checkmarx One credits.`
    : `Run AI Remediation on the confirmed ${sev} findings in ${who}? It uses 3 Checkmarx One credits each.`;
  if (!confirm(question)) return;
  const button = $(kind === 'triage' ? 'cc-run-triage' : 'cc-run-remediation');
  button.disabled = true;
  setStatus('cc-spend-status', kind === 'triage' ? 'Starting AI Triage…' : 'Starting AI Remediation…');
  try {
    const result = await api('/api/credits/run', { method: 'POST', body: JSON.stringify({ kind, severities, engines, branches: focusPick.allBranches ? 'all' : 'primary', projectIds: [...spend.picked] }) });
    setStatus('cc-spend-status', spendText(result, kind) + noteGone(result), result.failed ? 'error' : 'ok');
    logger.add(spendText(result, kind), result.failed ? 'error' : 'success');
    if (usage.data) {
      usage.data.allocations = result.allocations;
      usage.data.pool = result.pool;
      $('credits-pool').innerHTML = poolHtml(result.pool);
    }
    renderAllocations(result.allocations);
    creditsChanged();
  } catch (error) {
    if (handleAuthLoss(error)) return;
    setStatus('cc-spend-status', error.message, 'error');
    if (error.body?.gone?.length) {
      noteGone(error.body);
      renderAllocations(usage.data?.allocations ?? []);
    }
  } finally {
    renderSpend(usage.data?.allocations ?? []);
  }
}

/** Give the ticked projects what the chosen severities need for one kind of credit (confirmed twice with Checkmarx One), plus its extra. */
async function allocateNeededCredits(kind) {
  const severities = spendSeverities();
  const extraField = kind === 'triage' ? 'cc-spend-extra-triage' : 'cc-spend-extra-remediation';
  const extra = Math.max(0, Math.floor(Number($(extraField).value) || 0));
  if (!severities.length && !extra) return setStatus('cc-spend-status', 'Pick severities, or enter credits to add.', 'error');
  const engines = spendEngines();
  if (severities.length && !engines.length) return setStatus('cc-spend-status', 'Pick at least one engine.', 'error');
  const question = kind === 'triage'
    ? 'Allocate AI Triage credits (1 per Checkmarx One result) from the credit pool to the ticked projects (none ticked: every project holding credits): what the ticked severities need, plus any extra entered?'
    : 'Allocate AI Remediation credits (3 per confirmed result) from the credit pool to the ticked projects (none ticked: every project holding credits): what the ticked severities need, plus any extra entered?';
  if (!confirm(question)) return;
  const button = $(kind === 'triage' ? 'cc-allocate-triage' : 'cc-allocate-remediation');
  button.disabled = true;
  setStatus('cc-spend-status', 'Allocating…');
  try {
    const body = { severities, engines, kind, branches: focusPick.allBranches ? 'all' : 'primary', triageAdd: kind === 'triage' ? extra : 0, remediationAdd: kind === 'triage' ? 0 : extra, projectIds: [...spend.picked] };
    const result = await api('/api/credits/allocate-needed', { method: 'POST', body: JSON.stringify(body) });
    $(extraField).value = 0;
    if (usage.data) {
      usage.data.allocations = result.allocations;
      usage.data.pool = result.pool;
      $('credits-pool').innerHTML = poolHtml(result.pool);
    }
    renderAllocations(result.allocations);
    setStatus('cc-spend-status', `Allocated. The table shows what each project now has.${noteGone(result)}`, 'ok');
    creditsChanged();
  } catch (error) {
    if (handleAuthLoss(error)) return;
    setStatus('cc-spend-status', error.message, 'error');
    if (error.body?.gone?.length) {
      noteGone(error.body);
      renderAllocations(usage.data?.allocations ?? []);
    }
  } finally {
    button.disabled = false;
    renderSpend(usage.data?.allocations ?? []);
  }
}

$('cc-allocate-triage').addEventListener('click', () => allocateNeededCredits('triage'));
$('cc-allocate-remediation').addEventListener('click', () => allocateNeededCredits('remediation'));
$('cc-run-triage').addEventListener('click', () => runCredits('triage'));
$('cc-run-remediation').addEventListener('click', () => runCredits('remediation'));
for (const box of document.querySelectorAll('[data-spend-sev], [data-spend-engine]')) box.addEventListener('change', () => renderSpend(usage.data?.allocations ?? []));

/**
 * Credits were given, taken back or used on one page: the Workbench's balances
 * (and its gold buttons) follow at once. Reports and Credit Control read theirs
 * again whenever they are opened.
 */
async function creditsChanged() {
  if (!state.projects?.length || state.fetching || !can('credits.view')) return;
  try {
    const { projects } = await api('/api/credits/views');
    let changed = false;
    for (const p of state.projects) {
      if (!projects[p.projectId]) continue;
      p.credits = projects[p.projectId];
      changed = true;
    }
    if (changed) {
      renderProjects();
      renderAllocation();
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Giving credits on the Credit Control page (the Workbench gives them too)
// ---------------------------------------------------------------------------

const give = { projects: null, loading: null, warning: null };

/** Projects credits can be given to: every Checkmarx One project, read once when the bar is first used. */
async function loadGiveProjects({ refresh = false } = {}) {
  if (give.projects && !refresh) return give.projects;
  give.loading ??= api(`/api/credits/projects${refresh ? '?refresh=1' : ''}`)
    .then((result) => {
      give.projects = result.projects;
      give.warning = result.warning;
      renderGiveOptions();
      return give.projects;
    })
    .finally(() => (give.loading = null));
  return give.loading;
}

function renderGiveOptions() {
  const known = new Map((usage.data?.allocations ?? []).map((p) => [p.projectId, p.projectName || p.projectId]));
  for (const p of give.projects ?? []) known.set(p.projectId, p.projectName);
  $('cc-give-options').innerHTML = [...known.values()]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => `<option value="${escapeHtml(name)}"></option>`)
    .join('');
  if (give.warning) setStatus('cc-give-status', give.warning, 'warn');
}

/** The give bar: shown to people who may allocate, with what the pool has free. */
function renderGive() {
  const form = $('cc-give');
  form.hidden = !can('credits.allocate');
  if (form.hidden) return;
  if (!give.projects) renderGiveOptions();
  const pool = usage.data?.pool;
  $('cc-give-free').hidden = !pool?.limited;
  $('cc-give-free-n').textContent = pool?.limited ? fmt(pool.unallocated) : '';
}

/** Which project the typed name means: an exact name (any case), else the only one that contains it. */
function giveProjectOf(text) {
  const wanted = text.trim().toLowerCase();
  if (!wanted) return null;
  const all = new Map((usage.data?.allocations ?? []).map((p) => [p.projectId, { projectId: p.projectId, projectName: p.projectName || p.projectId }]));
  for (const p of give.projects ?? []) all.set(p.projectId, p);
  const list = [...all.values()];
  const exact = list.filter((p) => p.projectName.toLowerCase() === wanted || p.projectId.toLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  const partial = list.filter((p) => p.projectName.toLowerCase().includes(wanted));
  return partial.length === 1 ? partial[0] : null;
}

function chooseGiveProject(projectId) {
  const p = (usage.data?.allocations ?? []).find((x) => x.projectId === projectId) ?? (give.projects ?? []).find((x) => x.projectId === projectId);
  $('cc-give-project').value = p?.projectName || projectId;
  $('cc-give').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('cc-give-triage').focus();
  $('cc-give-triage').select();
}

async function giveCredits() {
  const count = (id) => Math.floor(Number($(id).value) || 0);
  const triage = count('cc-give-triage');
  const remediation = count('cc-give-remediation');
  if (triage < 0 || remediation < 0) return setStatus('cc-give-status', 'Credits cannot be negative. To take credits back, use Take back.', 'error');
  if (!triage && !remediation) return setStatus('cc-give-status', 'Enter how many AI Triage or AI Remediation credits to give.', 'error');
  await loadGiveProjects().catch(() => null);
  const project = giveProjectOf($('cc-give-project').value);
  if (!project) return setStatus('cc-give-status', 'Choose a project from the list.', 'error');
  // One line per sentence, the project's name on its own: each line is translated as it is.
  if (!confirm(`Give ${triage} AI Triage and ${remediation} AI Remediation credits out of the credit pool to this project?\n${project.projectName}\n\nThey stay with the project until they are used or taken back.`)) return;
  $('cc-give-submit').disabled = true;
  setStatus('cc-give-status', 'Giving…');
  try {
    const result = await api('/api/credits/give', { method: 'POST', body: JSON.stringify({ projectId: project.projectId, triage, remediation }) });
    setStatus('cc-give-status', `Gave ${result.triage} AI Triage and ${result.remediation} AI Remediation credits.`, 'ok');
    logger.add(`Gave ${result.given} credit(s) to ${result.projectName}`, 'success');
    $('cc-give-triage').value = 0;
    $('cc-give-remediation').value = 0;
    if (usage.data) {
      usage.data.allocations = result.allocations;
      usage.data.pool = result.pool;
      $('credits-pool').innerHTML = poolHtml(result.pool);
    }
    renderAllocations(result.allocations);
    creditsChanged();
  } catch (error) {
    if (handleAuthLoss(error)) return;
    setStatus('cc-give-status', error.message, 'error');
  } finally {
    $('cc-give-submit').disabled = false;
  }
}

$('cc-give').addEventListener('submit', (event) => {
  event.preventDefault();
  giveCredits();
});
$('cc-give-project').addEventListener('focus', () => loadGiveProjects().catch((error) => !handleAuthLoss(error) && setStatus('cc-give-status', error.message, 'error')), { once: true });

function exportUsageCsv() {
  const data = usage.data;
  if (!data) return;
  const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = [
    ['Section', 'Period start', 'Project', 'AI Triage', 'AI Remediation', 'Total', 'Requests'],
    ...data.series.map((r) => ['over time', r.start, data.projectId || 'all projects', r.triage, r.remediation, r.credits, r.requests]),
    ...data.byProject.map((p) => ['by project', `${data.from}..${data.to}`, p.projectName || p.projectId, p.triage, p.remediation, p.credits, p.requests]),
    [],
    ['Allocations (all time)', '', 'Project', 'Triage allocated', 'Triage used', 'Remediation allocated', 'Remediation used'],
    ...data.allocations.map((p) => ['allocation', '', p.projectName || p.projectId, p.triage.allocated, p.triage.used, p.remediation.allocated, p.remediation.used]),
  ];
  const blob = new Blob([rows.map((r) => r.map(cell).join(',')).join('\n')], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `credits-${data.from}-to-${data.to}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

$('usage-preset').addEventListener('change', () => {
  const custom = $('usage-preset').value === 'custom';
  $('usage-from-field').hidden = !custom;
  $('usage-to-field').hidden = !custom;
  if (custom && !$('usage-from').value) {
    const { from, to } = usage.data ?? usageRange();
    $('usage-from').value = from;
    $('usage-to').value = to;
  }
  loadUsage();
});
for (const id of ['usage-from', 'usage-to', 'usage-bucket', 'usage-project']) $(id).addEventListener('change', loadUsage);
$('usage-filters').addEventListener('submit', (event) => event.preventDefault());
$('usage-export').addEventListener('click', exportUsageCsv);
$('alloc-search').addEventListener('input', () => renderAllocations(usage.data?.allocations ?? []));
let usageResize = null;
window.addEventListener('resize', () => {
  clearTimeout(usageResize);
  usageResize = setTimeout(() => usage.data && !$('page-credits').hidden && drawUsageChart(usage.data), 150);
});

wireHttps();
wireTerms();

// ---- GitLab, Azure DevOps and Bitbucket connections --------------------------

function hostSettings(id) {
  if (id === 'gitlab') return { apiUrl: $('gl-url').value.trim(), group: $('gl-group').value.trim(), projects: lines($('gl-projects').value), token: $('gl-token').value.trim() };
  if (id === 'azure') return { orgUrl: $('az-org').value.trim(), repos: lines($('az-repos').value), token: $('az-token').value.trim() };
  const kind = $('bb-kind').value;
  return { kind, apiUrl: kind === 'server' ? $('bb-url').value.trim() : '', username: $('bb-user').value.trim(), workspace: $('bb-workspace').value.trim(), repos: lines($('bb-repos').value), token: $('bb-token').value.trim() };
}
const TOKEN_FIELDS = { gitlab: 'gl-token', azure: 'az-token', bitbucket: 'bb-token' };

async function saveHost(id, extra = {}) {
  const status = document.querySelector(`[data-host-status="${id}"]`);
  const settings = { ...hostSettings(id), ...extra };
  if (!settings.token && extra.token !== null) delete settings.token;
  status.textContent = 'Saving…';
  status.className = 'status';
  try {
    state.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ beta: { [id]: settings } }) });
    $(TOKEN_FIELDS[id]).value = '';
    renderBeta();
    status.textContent = 'Saved.';
    status.className = 'status ok';
    return true;
  } catch (error) {
    if (!handleAuthLoss(error)) {
      status.textContent = error.message;
      status.className = 'status error';
    }
    return false;
  }
}

document.addEventListener('click', async (event) => {
  const save = event.target.closest?.('[data-host-save]');
  const test = event.target.closest?.('[data-host-test]');
  const clear = event.target.closest?.('[data-host-clear]');
  if (save) saveHost(save.dataset.hostSave);
  if (clear && confirm(`Remove the stored ${HOST_NAMES[clear.dataset.hostClear]} token?`)) saveHost(clear.dataset.hostClear, { token: null });
  if (test) {
    const id = test.dataset.hostTest;
    const status = document.querySelector(`[data-host-status="${id}"]`);
    if ($(TOKEN_FIELDS[id]).value.trim() && !(await saveHost(id))) return;
    status.textContent = 'Testing…';
    status.className = 'status';
    try {
      const result = (await api('/api/beta/scm/check', { method: 'POST', body: JSON.stringify({ provider: id }) }))[id];
      status.textContent = result?.ok ? `Connected${result.who ? ` as ${result.who}` : ''}.` : result?.reason ?? 'Not connected.';
      status.className = `status ${result?.ok ? 'ok' : 'error'}`;
      showHelp(status, result?.ok ? null : result?.help);
    } catch (error) {
      if (!handleAuthLoss(error)) {
        status.textContent = error.message;
        status.className = 'status error';
      }
    }
  }
});
$('bb-kind').addEventListener('change', () => {
  $('bb-url').disabled = $('bb-kind').value !== 'server';
  if (identityHost === 'bitbucket') renderIdentityMethods();
});

wireLayout();
wireLanguageAndProfile();
