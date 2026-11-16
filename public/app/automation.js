// Automation: automatic reminders (who, what, when), the reminder email, the preview of the next run, and hands-off.
import { ENGINES, cleanEngines } from '../engines.js';
import { scheduleText } from '../app.js';
import { $, can, canAny, state } from './state.js';
import { escapeHtml, fmtDateTime } from './format.js';
import { api, handleAuthLoss, setStatus, showError, toast } from './core.js';
import { activateTab, renderFeatureStages, tabMemory } from './nav.js';
import { renderAudience } from './actions.js';

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

export function wireHandsOff() {
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
export const SEVERITY_LABEL = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };
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

export function wireAutomation() {
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
}

export function wireAutomationRun() {
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
}
