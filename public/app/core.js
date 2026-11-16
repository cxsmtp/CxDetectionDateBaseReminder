// What every page uses: calls to the server with their flares, the browser's own log and the Logs page that shows
// it, script errors sent to the troubleshooting log, status lines and their help, the certificate prompt and toasts.
import { nextSpeedster } from '../speedsters.js';
import { $, can, state } from './state.js';
import { escapeHtml, formatDate } from './format.js';
import { refreshConnectionsSoon, showSignIn } from './session.js';
import { loadTrust } from './system.js';
import { loadUserActivity, userActivity } from './audit.js';

// Script errors go to the server's troubleshooting log (scrubbed there; at most 20 per page load).
let reportedErrors = 0;
function reportClientError(message, source = '', line = 0, column = 0, stack = '') {
  if (reportedErrors++ >= 20) return;
  fetch('/api/diagnostics/client-error', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: String(message).slice(0, 300), source, line, column, stack: String(stack).slice(0, 300), page: location.hash }),
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export const logger = {
  logs: [],
  maxLogs: 500,

  add(message, type = 'info', details = {}) {
    const timestamp = new Date().toISOString();
    const log = { timestamp, type, message, details };
    this.logs.push(log);
    if (this.logs.length > this.maxLogs) this.logs.shift();
    // Drawn only while the Logs page is open (every request adds a line).
    if (state.page === 'logs') queueMicrotask(renderLogs);
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

/** Actions that work on the fetched data, so they wait until a fetch is complete. */
const NEEDS_FETCHED_DATA = /^\/api\/(credits\/allocate|triage\/run|remediation\/run|tracked-reports\/[^/]+\/(allocate|triage))(\?|$)/;
const FETCHING_MESSAGE = 'Data is still being fetched. Triage, remediation and credit allocation unlock when the fetch is complete.';

// ---------------------------------------------------------------------------
// Flares, bottom right: amber with a flying hero while an action is in
// progress (and the part of the page it came from is paused), green when it
// is done, red when it failed. One per action, so several can run at once.
// ---------------------------------------------------------------------------

// Done: a green disc pops in and the tick draws itself (pathLength 1 lets CSS draw it).
const DONE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="tick-disc" cx="12" cy="12" r="11" fill="#16a34a" /><path class="tick-mark" pathLength="1" d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" /></svg>';
const FAILED_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#dc2626" /><path d="M8 8l8 8M16 8l-8 8" stroke="#fff" stroke-width="2.4" stroke-linecap="round" /></svg>';

const flares = new Map();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let flareSeq = 0;
/**
 * Show or update the flare `key`: kind busy | done | failed. `details` are the
 * short facts under the main line (each translated on its own). `spoken` is
 * what a screen reader announces instead of the lines on screen, for a busy
 * card whose lines change every second.
 */
export function flare(key, kind, text, details = '', spoken = '') {
  let el = flares.get(key);
  if (!el) {
    el = document.createElement('div');
    el.setAttribute('role', 'status');
    if (key === 'fetch') el.id = 'fetch-flare';
    el.innerHTML = '<span class="flare-icon"></span><span class="flare-text"><span class="flare-main"></span><small></small><span class="sr-only flare-sr"></span></span>';
    $('flares').append(el);
    flares.set(key, el);
  }
  clearTimeout(el.hideTimer);
  clearTimeout(el.settleTimer);
  const icon = el.querySelector('.flare-icon');
  if (el.dataset.kind !== kind) {
    icon.classList.remove('settling');
    if (kind === 'busy') {
      // A different fast thing for every action.
      const speedster = nextSpeedster();
      icon.innerHTML = speedster.svg;
      icon.title = speedster.name;
    } else if (kind === 'done' && el.dataset.kind === 'busy' && !reducedMotion.matches) {
      // It glides to a stop, then the tick pops in.
      icon.classList.add('settling');
      el.settleTimer = setTimeout(() => {
        icon.classList.remove('settling');
        icon.innerHTML = DONE_SVG;
        icon.title = '';
      }, 520);
    } else {
      icon.innerHTML = kind === 'done' ? DONE_SVG : FAILED_SVG;
      icon.title = '';
    }
  }
  el.dataset.kind = kind;
  el.className = `flare ${kind}`;
  el.querySelector('.flare-main').textContent = text;
  const small = el.querySelector('small');
  const parts = (Array.isArray(details) ? details : [details]).filter(Boolean).map(String);
  // Only the parts that changed are rewritten (the clock, every second), so the rest keeps its translation.
  if (small.children.length !== parts.length) small.replaceChildren(...parts.map(() => document.createElement('span')));
  parts.forEach((part, i) => {
    if (small.children[i].dataset.src !== part) {
      small.children[i].dataset.src = part;
      small.children[i].textContent = part;
    }
  });
  small.hidden = !parts.length;
  for (const line of el.querySelectorAll('.flare-main, small')) line.toggleAttribute('aria-hidden', Boolean(spoken));
  const sr = el.querySelector('.flare-sr');
  if (sr.textContent !== spoken) sr.textContent = spoken;
  if (kind !== 'busy') {
    el.hideTimer = setTimeout(() => {
      el.remove();
      flares.delete(key);
    }, kind === 'done' ? 5000 : 10000);
  }
}

/**
 * What each action is called while it runs and when it is done. Anything not
 * listed that changes something is "Working…" / "Done".
 */
const ACTIVITIES = [
  ['PUT', /^\/api\/settings$/, 'Saving settings…', 'Settings saved', { lock: false, key: 'settings' }],
  ['POST', /^\/api\/settings\/import-env$/, 'Applying the .env file and checking each connection…', '.env file applied'],
  ['POST', /^\/api\/settings\/connections\/check$/, 'Checking the connections…', 'Connections checked'],
  ['POST', /^\/api\/settings\/smtp\/test$/, 'Testing the mail server…', 'Mail server test finished'],
  ['POST', /^\/api\/settings\/smtp\/send-test$/, 'Sending a test email…', 'Test email sent'],
  ['POST', /^\/api\/settings\/template\/preview$/, 'Rendering the preview…', 'Preview ready', { quiet: true }],
  ['POST', /^\/api\/integration\/cxone$/, 'Connecting to Checkmarx One…', 'Connected to Checkmarx One'],
  ['POST', /^\/api\/https\/inspect$/, 'Checking the certificate the way a browser would…', 'Certificate checked'],
  ['POST', /^\/api\/https\/certificate$/, 'Putting the certificate to use…', 'Certificate in use'],
  ['POST', /^\/api\/https\/certificate\/previous$/, 'Putting the previous certificate back…', 'Previous certificate in use'],
  ['DELETE', /^\/api\/https\/certificate/, 'Removing the uploaded certificate…', 'Uploaded certificate removed'],
  ['POST', /^\/api\/https\/self-signed$/, 'Making a self-signed certificate…', 'Self-signed certificate made'],
  ['POST', /^\/api\/https\/request$/, 'Creating the certificate request…', 'Request ready to send to IT'],
  ['POST', /^\/api\/https\/mode$/, 'Switching…', 'Switched'],
  ['POST', /^\/api\/https\/hardening$/, 'Applying the security settings…', 'Security settings applied'],
  ['DELETE', /^\/api\/integration\/cxone$/, 'Removing the stored Checkmarx One key…', 'Key removed'],
  ['POST', /^\/api\/credits\/verify$/, 'Checking with Checkmarx One (two independent reads)…', 'Confirmed with Checkmarx One'],
  ['POST', /^\/api\/credits\/refresh$/, 'Refreshing credits…', 'Credits refreshed', { quiet: true }],
  ['POST', /^\/api\/credits\/allocate$/, 'Allocating credits…', 'Credits updated'],
  ['POST', /^\/api\/triage\/run$/, 'Starting AI Triage…', 'AI Triage started'],
  ['POST', /^\/api\/remediation\/run$/, 'Starting AI Remediation…', 'AI Remediation started'],
  ['POST', /^\/api\/reminders$/, 'Sending reminders…', 'Reminders sent'],
  ['POST', /^\/api\/reminders\/send-html-by-initiator$/, 'Sending the HTML reports…', 'HTML reports sent'],
  ['POST', /^\/api\/initiators\/tag$/, 'Saving the address…', 'Address saved'],
  ['POST', /^\/api\/tracked-reports$/, 'Saving the tracked report…', 'Tracked report saved'],
  ['POST', /^\/api\/tracked-reports\/[^/]+\/refresh$/, 'Refreshing the tracked report…', 'Tracked report refreshed'],
  ['POST', /^\/api\/tracked-reports\/[^/]+\/remind$/, 'Sending the follow-up…', 'Follow-up sent'],
  ['POST', /^\/api\/tracked-reports\/[^/]+\/triage$/, 'Starting AI Triage for the tracked report…', 'AI Triage started'],
  ['POST', /^\/api\/tracked-reports\/[^/]+\/allocate$/, 'Allocating credits for the tracked report…', 'Credits allocated'],
  ['PUT', /^\/api\/tracked-reports\/[^/]+\/automation$/, 'Saving the follow-up schedule…', 'Schedule saved'],
  ['POST', /^\/api\/tracked-reports\/[^/]+\/verify$/, 'Asking Checkmarx One to rescan…', 'Verification rescan started'],
  ['PUT', /^\/api\/tracked-reports\/[^/]+\/verify-settings$/, 'Saving automatic verification…', 'Saved'],
  ['POST', /^\/api\/tracked-reports\/[^/]+\/next-round$/, 'Starting the next round…', 'Next round started'],
  ['DELETE', /^\/api\/tracked-reports\/[^/]+$/, 'Deleting the tracked report…', 'Tracked report deleted'],
  ['POST', /^\/api\/automation\/run$/, 'Running automation…', 'Automation run finished'],
  ['POST', /^\/api\/automation\/reset$/, 'Resetting automation history…', 'History reset'],
  ['POST', /^\/api\/backup\/now$/, 'Backing up…', 'Backup written'],
  ['POST', /^\/api\/backup\/restore$/, 'Checking the backup…', 'Backup checked'],
  // Sign-in settings and one's own two-step sign-in say how they went beside their own buttons.
  ['PUT', /^\/api\/iam\/sign-in$/, '', '', { quiet: true }],
  ['POST', /^\/api\/iam\/sign-in\/sso\/check$/, '', '', { quiet: true }],
  ['POST', /^\/api\/me\/two-step\//, '', '', { quiet: true }],
  ['DELETE', /^\/api\/iam\/users\/[^/]+\/two-step$/, 'Resetting two-step sign-in…', 'Two-step sign-in reset'],
  ['DELETE', /^\/api\/iam\/users\/[^/]+\/sso-link$/, 'Resetting the single sign-on link…', 'Single sign-on link reset'],
  ['POST', /^\/api\/iam\//, 'Saving people and roles…', 'Saved'],
  ['PATCH', /^\/api\/iam\//, 'Saving people and roles…', 'Saved'],
  ['PUT', /^\/api\/iam\//, 'Saving people and roles…', 'Saved'],
  ['DELETE', /^\/api\/iam\//, 'Removing…', 'Removed'],
  ['POST', /^\/api\/me\/password$/, 'Changing your password…', 'Password changed'],
  ['PUT', /^\/api\/me\/profile$/, 'Saving your profile…', 'Profile saved', { lock: false, key: 'profile' }],
  ['POST', /^\/api\/beta\/github\/evaluate$/, 'Matching GitHub usernames…', 'Matching finished'],
  ['POST', /^\/api\/beta\/authors\/find$/, 'Finding who wrote the vulnerable code…', 'Authors found'],
  ['POST', /^\/api\/beta\/fusion\/read$/, 'Reading Fusion results…', 'Fusion results read'],
  ['POST', /^\/api\/fae-flush\/preview$/, 'Checking the projects…', 'Checking the projects', { quiet: true }],
  ['POST', /^\/api\/fae-flush\/start$/, 'Starting FAE Flush…', 'FAE Flush started'],
  ['POST', /^\/api\/fae-flush\/undo$/, 'Putting the marked results back to To verify…', 'FAE Flush undone'],
  ['POST', /^\/api\/fae-flush\/delete-fae$/, 'Deleting the _FAE projects…', '_FAE projects deleted'],
  ['POST', /^\/api\/beta\/authors\/notify$/, 'Emailing the code authors…', 'Code authors emailed'],
  ['GET', /^\/api\/audit\/verify/, 'Verifying the audit log…', 'Audit log verified'],
  ['GET', /^\/api\/audit\/reconcile/, 'Reconciling with the credit ledger…', 'Reconciled'],
  ['POST', /^\/api\/projections\/fusion\/read$/, 'Reading projects from Checkmarx One…', 'Projects read'],
  ['POST', /^\/api\/projections\/reports$/, 'Generating the projection report…', 'Projection report generated'],
  ['DELETE', /^\/api\/projections\/reports\/[^/]+$/, 'Deleting the report…', 'Report deleted'],
  ['POST', /^\/api\/projections$/, 'Adding the customer…', 'Customer added'],
  ['DELETE', /^\/api\/projections\/[^/]+$/, 'Deleting the customer…', 'Customer deleted'],
  ['PUT', /^\/api\/organisation-name$/, 'Saving the organisation name…', 'Organisation name saved'],
];
/**
 * While an action runs, its card names the step it is on (a new one every few
 * seconds, in plain words), for how many projects, and for how long.
 */
const STEPS = [
  [/^\/api\/(credits\/verify|tracked-reports\/[^/]+\/refresh)/, ['Verifying with Checkmarx One…', 'Comparing the two reads…', 'Matching each finding to its result…']],
  [/^\/api\/(triage|tracked-reports\/[^/]+\/triage)/, ['Running AI Triage…', 'Analysing the findings…', 'Counting one credit per result…']],
  [/^\/api\/remediation/, ['Running AI Remediation…', 'Preparing the fix…', 'Counting one credit per result…']],
  [/^\/api\/(credits|tracked-reports\/[^/]+\/allocate)/, ['Updating the credit allocation…', 'Checking the credit pool…', 'Recording it in the audit log…']],
  [/^\/api\/(reminders|tracked-reports\/[^/]+\/remind|beta\/authors\/notify|settings\/smtp\/send-test)/, ['Preparing the emails…', 'Sending the emails…', 'Each person receives only their own projects…']],
  [/^\/api\/(integration|settings)/, ['Testing the connection…', 'Applying the settings…']],
  [/^\/api\/(backup|audit)/, ['Verifying the audit log…', 'Checking every entry…']],
  [/^\/api\/beta\/fusion/, ['Reading Fusion results from Checkmarx One…', 'Counting them by severity…']],
  [/^\/api\/beta/, ['Reading the repository history…', 'Matching people to email addresses…']],
  [/./, ['Working…', 'Processing…']],
];
const SLOW_STEP = 'Still working: this takes longer than usual…';

/** 0:07, 1:43, 12:05 */
const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/** "12 projects" when the request names projects. */
function scopeOf(body) {
  try {
    const ids = JSON.parse(body ?? '{}')?.projectIds;
    return Array.isArray(ids) && ids.length ? `${ids.length} project${ids.length === 1 ? '' : 's'}` : '';
  } catch {
    return '';
  }
}

/** Keep the busy card `key` alive: the next step every 4 s, the clock every second. Returns stop(). */
function startBusyFlare(key, path, activity, body) {
  const route = path.split('?')[0];
  const steps = STEPS.find(([pattern]) => pattern.test(route))[1];
  const scope = scopeOf(body);
  const started = Date.now();
  const draw = () => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    const step = seconds >= 20 && Math.floor(seconds / 4) % 3 === 2 ? SLOW_STEP : steps[Math.floor(seconds / 4) % steps.length];
    flare(key, 'busy', activity.busy, [step, scope, clock(seconds)], activity.busy);
  };
  draw();
  const timer = setInterval(draw, 1000);
  return () => clearInterval(timer);
}

const NO_FLARE = /^\/api\/(session|diagnostics\/client-error|settings\/notices\/ack)/;

function activityFor(method, path) {
  const route = path.split('?')[0];
  if (NO_FLARE.test(route)) return null;
  const hit = ACTIVITIES.find(([m, pattern]) => m === method && pattern.test(route));
  if (hit) return { busy: hit[2], done: hit[3], ...(hit[4] ?? {}) };
  return method === 'GET' ? null : { busy: 'Working…', done: 'Done' };
}

// What was clicked last: the origin of an action even when its button disabled itself (and lost focus) first.
let lastClick = { el: null, at: 0 };

/** Pause the button that started an action, and the part of the page around it, until it finishes. */
function pauseOrigin() {
  const focused = document.activeElement;
  const origin = focused && focused !== document.body ? focused : Date.now() - lastClick.at < 3000 ? lastClick.el?.closest?.('button, input, select, label') ?? lastClick.el : null;
  if (!origin || !origin.closest) return () => {};
  const button = origin.matches('button, input[type="checkbox"], input[type="radio"], select') ? origin : null;
  const area = origin.closest('.alloc-step, .panel, form, details.disclosure, .report-card, [data-report]');
  const wasDisabled = button?.disabled;
  if (button) button.disabled = true;
  if (area) area.setAttribute('aria-busy', 'true');
  return () => {
    if (button && !wasDisabled) button.disabled = false;
    if (area) area.removeAttribute('aria-busy');
  };
}

export async function api(path, options = {}) {
  const method = options.method || 'GET';
  const activity = options.quiet ? null : activityFor(method, path);
  if (!activity || activity.quiet) return apiCall(path, options);
  const key = activity.key ?? `act-${++flareSeq}`;
  const resume = activity.lock === false ? () => {} : pauseOrigin();
  const stop = startBusyFlare(key, path, activity, options.body);
  try {
    const result = await apiCall(path, options);
    stop();
    flare(key, 'done', activity.done);
    if (method !== 'GET' && /^\/api\/(settings|integration|beta)/.test(path)) refreshConnectionsSoon();
    return result;
  } catch (error) {
    stop();
    flare(key, 'failed', `${activity.busy.replace(/…$/, '')} did not finish`, error.message);
    if (/^\/api\/(settings|integration)/.test(path)) refreshConnectionsSoon();
    throw error;
  } finally {
    resume();
  }
}

/**
 * The product licence ends within 30 days (src/activation.js): Admins are told, with the date, until a product
 * activation code moves it (Settings → Activation codes).
 */
export function renderLicenceBanner(licence) {
  const banner = $('licence-banner');
  if (!banner) return;
  banner.hidden = !licence?.warn;
  if (!licence?.warn) return;
  const day = new Date(Date.parse(licence.until) - 1).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  banner.textContent = `CxMissionZero stops working at the end of ${day} (UTC) unless it is activated: ${licence.daysLeft === 1 ? '1 day' : `${licence.daysLeft} days`} left. Please reach out to Bhawani Singh for an activation code, then enter it under Settings → Activation codes.`;
}

async function apiCall(path, options = {}) {
  const method = options.method || 'GET';
  if (method !== 'GET' && state.fetching && NEEDS_FETCHED_DATA.test(path)) {
    const error = new Error(FETCHING_MESSAGE);
    error.status = 409;
    toast(FETCHING_MESSAGE, 'bad');
    throw error;
  }
  logger.apiCall(method, path);

  // While the server restarts for an update (a few seconds), wait and ask again instead of failing:
  // a "restarting" answer means it did nothing, and a read can always be repeated.
  const until = Date.now() + 45_000;
  try {
    let response;
    let payload;
    for (;;) {
      try {
        response = await fetch(path, {
          credentials: 'same-origin',
          headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
          ...options,
        });
      } catch (error) {
        if (method === 'GET' && Date.now() < until) {
          restartingNotice();
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }
        if (method !== 'GET') error.message = 'CxMissionZero could not be reached (it may be restarting for an update). Check whether it went through, then try again.';
        throw error;
      }
      payload = await response.json().catch(() => ({}));
      if (response.status === 503 && payload.restarting && Date.now() < until) {
        restartingNotice();
        await new Promise((resolve) => setTimeout(resolve, (payload.retryAfter || 3) * 1000));
        continue;
      }
      break;
    }
    // The server went HTTPS only while this page was open over http: continue there.
    if (response.status === 426 && /^https:\/\//.test(payload.movedTo || '')) {
      location.href = `${payload.movedTo}${location.pathname}${location.search}${location.hash}`;
    }
    // The product licence ended while this page was open: the deactivation page, with its activation field.
    if (response.status === 503 && payload.deactivated) location.reload();
    if (!response.ok) {
      const error = new Error(payload.error || `${response.status} ${response.statusText}`);
      error.status = response.status;
      error.detail = payload.detail || '';
      error.body = payload;
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

let restartingShownAt = 0;
/** Said once per restart, not once per request. */
function restartingNotice() {
  if (Date.now() - restartingShownAt < 30_000) return;
  restartingShownAt = Date.now();
  toast('CxMissionZero is restarting for an update — reconnecting…', 'warn');
}

let helpSerial = 0;
/** A small ? beside a label, and the definition it opens (put where it should appear): kept out of the way until asked for. */
export function helpTip(text) {
  const id = `hq-${++helpSerial}`;
  return {
    button: `<button type="button" class="help-q" aria-expanded="false" aria-controls="${id}" aria-label="What is this?" title="What is this?">?</button>`,
    text: `<span class="help-text help-note" id="${id}">${escapeHtml(text)}</span>`,
  };
}

export function setStatus(id, message, kind = '') {
  const el = $(id);
  el.textContent = message;
  el.className = `status ${kind}`;
  showHelp(el, null);
}

/** Errors from Checkmarx and SMTP carry a detail body; it is usually the answer. A connection error also says how to fix it. */
export function showError(id, error) {
  const help = error.body?.help;
  // With an explanation, the raw detail goes under "What was tried" instead of the status line.
  setStatus(id, error.detail && !help ? `${error.message} — ${error.detail}` : error.message, 'error');
  showHelp($(id), help);
}

/**
 * What went wrong and how to fix it (the server's src/troubleshoot.js): one sentence, numbered
 * steps, and, folded away, what was tried and the other side's own answer.
 */
export function helpHtml(help, { open = true } = {}) {
  if (!help?.problem) return '';
  const facts = (help.facts ?? []).map(([label, value]) => `<div><span class="k">${escapeHtml(label)}</span><span class="v" translate="no">${escapeHtml(value)}</span></div>`).join('');
  return `<div class="fix-help" role="note">
    <p class="fix-problem">${escapeHtml(help.problem)}</p>
    <details class="fix-how"${open ? ' open' : ''}><summary>How to fix it</summary>
      <ol class="fix-steps">${(help.steps ?? []).map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
    </details>
    ${certificateCard(help.certificate)}
    ${facts ? `<details class="fix-facts"><summary>What was tried</summary><div class="kv">${facts}</div></details>` : ''}
  </div>`;
}

// Every certificate a Windows computer trusts, in one file on its desktop: what an upload needs
// when nobody knows which certificate the company proxy uses (the server keeps only those needed).
const WINDOWS_EXPORT = "powershell -NoProfile -Command \"Get-ChildItem Cert:\\LocalMachine\\Root, Cert:\\LocalMachine\\CA, Cert:\\CurrentUser\\Root | ForEach-Object { '-----BEGIN CERTIFICATE-----'; [Convert]::ToBase64String($_.RawData, 'InsertLineBreaks'); '-----END CERTIFICATE-----' } | Set-Content -Encoding ascii $env:USERPROFILE\\Desktop\\company-certificates.pem\"";

/**
 * A certificate a server presented that is not trusted here (src/trust.js): the root a company
 * proxy presents, to trust with one click, and in every case an upload, which keeps only what
 * this connection needs.
 */
function certificateCard(cert) {
  if (!cert || !(can('integration.cxone') || can('integration.smtp'))) return '';
  const c = cert.candidate;
  const target = `data-host="${escapeHtml(cert.host ?? '')}" data-port="${Number(cert.port) || 443}"`;
  return `<div class="cert-card" ${target}>
    ${c ? `<div class="kv cert-facts">
        <div><span class="k">Certificate</span><span class="v" translate="no">${escapeHtml(c.subject)}${c.organization && c.organization !== c.subject ? ` · ${escapeHtml(c.organization)}` : ''}</span></div>
        ${c.vendor ? `<div><span class="k">Product</span><span class="v" translate="no">${escapeHtml(c.vendor)}</span></div>` : ''}
        <div><span class="k">Valid until</span><span class="v">${escapeHtml(formatDate(c.validTo))}</span></div>
        <div><span class="k">SHA-256 fingerprint</span><span class="v code cert-fp" translate="no">${escapeHtml(c.fingerprint256)}</span></div>
      </div>` : ''}
    <div class="actions compact">
      ${c ? `<button type="button" class="primary" data-cert-trust="${escapeHtml(c.fingerprint256)}">Trust and connect</button>` : ''}
      <button type="button" class="${c ? 'link' : 'primary'}" data-cert-pick>Upload a certificate…</button>
      <input type="file" data-cert-upload accept=".pem,.crt,.cer,.der,.txt" hidden />
    </div>
    <details class="cert-windows"><summary>Export the certificates from Windows</summary>
      <p class="hint">On a Windows computer on your company network, paste this into the command prompt (cmd). It saves company-certificates.pem on the desktop: upload that file here.</p>
      <pre class="code" translate="no">${escapeHtml(WINDOWS_EXPORT)}</pre>
      <button type="button" class="link" data-copy-command>Copy the command</button>
    </details>
    <p class="status cert-status" role="status"></p>
  </div>`;
}

/** A certificate file as the server reads it: PEM text as it is, anything else (DER) in base64. */
export async function certificateFileData(file) {
  if (file.size > 3_000_000) throw new Error('That file is too large for certificates (3 MB at most).');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const text = new TextDecoder('latin1').decode(bytes);
  if (text.includes('-----BEGIN')) return text;
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** After a certificate is trusted: try the connection the card was shown for again. */
function retryAfterTrust(card) {
  if (card.closest('#set-connection')) $('integration-form').requestSubmit();
  loadTrust();
}

export function wireCore() {
  window.addEventListener('error', (e) => reportClientError(e.message, e.filename, e.lineno, e.colno, e.error?.stack));
  window.addEventListener('unhandledrejection', (e) => reportClientError(e.reason?.message ?? e.reason, '', 0, 0, e.reason?.stack));
  $('download-diagnostics')?.addEventListener('click', () => {
    // A plain download: the server sends it as an attachment.
    location.href = '/api/diagnostics/download';
  });
  document.addEventListener('click', (event) => (lastClick = { el: event.target, at: Date.now() }), true);

  document.addEventListener('click', async (event) => {
    const pick = event.target.closest('[data-cert-pick]');
    if (pick) return pick.closest('.cert-card').querySelector('[data-cert-upload]').click();
    const copy = event.target.closest('[data-copy-command]');
    if (copy) {
      try {
        await navigator.clipboard.writeText(WINDOWS_EXPORT);
        copy.textContent = 'Copied';
      } catch {
        copy.textContent = 'Select the command and copy it';
      }
      return;
    }
    const button = event.target.closest('[data-cert-trust]');
    if (!button) return;
    const card = button.closest('.cert-card');
    const status = card.querySelector('.cert-status');
    button.disabled = true;
    status.textContent = 'Checking the certificate again and trusting it…';
    status.className = 'status cert-status';
    try {
      await api('/api/trust/presented', { method: 'POST', body: JSON.stringify({ host: card.dataset.host, port: Number(card.dataset.port), fingerprint256: button.dataset.certTrust }) });
      status.textContent = 'Trusted. Connecting again…';
      status.className = 'status cert-status ok';
      retryAfterTrust(card);
    } catch (error) {
      button.disabled = false;
      if (!handleAuthLoss(error)) {
        status.textContent = error.message;
        status.className = 'status cert-status error';
      }
    }
  });

  document.addEventListener('change', async (event) => {
    const input = event.target.closest('[data-cert-upload]');
    if (!input?.files?.[0]) return;
    const card = input.closest('.cert-card');
    const status = card.querySelector('.cert-status');
    status.textContent = 'Reading the certificate…';
    status.className = 'status cert-status';
    try {
      const data = await certificateFileData(input.files[0]);
      const done = await api('/api/trust/upload', { method: 'POST', body: JSON.stringify({ data, host: card.dataset.host || undefined, port: Number(card.dataset.port) || 443 }) });
      const names = done.added.map((a) => a.subject).join(', ');
      if (done.trusted === false) {
        status.textContent = `${names ? `Added ${names}, but ` : ''}${card.dataset.host} is still not trusted. Upload the certificate your network team gives you.`;
        status.className = 'status cert-status error';
        loadTrust();
        return;
      }
      status.textContent = names ? `Trusted ${names}. Connecting again…` : 'Already trusted. Connecting again…';
      status.className = 'status cert-status ok';
      retryAfterTrust(card);
    } catch (error) {
      if (!handleAuthLoss(error)) {
        status.textContent = error.message;
        status.className = 'status cert-status error';
      }
    } finally {
      input.value = '';
    }
  });
}

/** Put the explanation right under a status line (or take it away). */
export function showHelp(el, help) {
  if (!el) return;
  let box = el.nextElementSibling?.classList.contains('fix-help-slot') ? el.nextElementSibling : null;
  if (!help?.problem) return box?.remove();
  if (!box) {
    box = document.createElement('div');
    box.className = 'fix-help-slot';
    el.after(box);
  }
  box.innerHTML = helpHtml(help);
}

export function handleAuthLoss(error) {
  if (error.status === 401) {
    showSignIn({ message: 'Your session ended. Sign in again.' });
    return true;
  }
  return false;
}

let toastTimer = null;
export function toast(message, kind = '', ms = 6000) {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}
export function hideToast() {
  clearTimeout(toastTimer);
  $('toast').hidden = true;
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

const LOG_PAGE = 100;
let logPage = 0;

function renderLogs() {
  const filter = {
    api: $('log-filter-api')?.checked ?? true,
    error: $('log-filter-errors')?.checked ?? true,
    success: $('log-filter-success')?.checked ?? true,
  };
  const search = ($('log-search')?.value ?? '').toLowerCase();
  const counts = { api: 0, error: 0, success: 0 };
  for (const log of logger.logs) if (log.type in counts) counts[log.type] += 1;
  for (const el of document.querySelectorAll('[data-log-count]')) el.textContent = counts[el.dataset.logCount] ? String(counts[el.dataset.logCount]) : '';

  const filtered = logger.logs
    .filter((log) => (filter[log.type] ?? true) && (!search || log.message.toLowerCase().includes(search)))
    .reverse();
  const pages = Math.max(1, Math.ceil(filtered.length / LOG_PAGE));
  logPage = Math.min(logPage, pages - 1);
  const first = logPage * LOG_PAGE;

  const logsContainer = $('logs-list');
  const emptyEl = $('logs-empty');
  if (filtered.length === 0) {
    logsContainer.innerHTML = '';
    emptyEl.hidden = false;
    emptyEl.textContent = logger.logs.length ? 'Nothing matches these filters.' : 'No activity yet. What this browser asks the server shows here as you work.';
  } else {
    emptyEl.hidden = true;
    logsContainer.innerHTML = filtered
      .slice(first, first + LOG_PAGE)
      .map((log) => {
        const time = log.timestamp.slice(11, 19);
        const icon = log.type === 'error' ? '✗' : log.type === 'success' ? '✓' : log.type === 'api' ? '→' : '•';
        return `<div class="log-line log-${escapeHtml(log.type)}"><time>${time}</time><span class="log-icon" aria-hidden="true">${icon}</span><span class="log-msg">${escapeHtml(log.message.replace(/^[✓✗→•]\s*/, ''))}</span></div>`;
      })
      .join('');
  }
  $('logs-pager').hidden = pages < 2;
  $('logs-page-info').textContent = `${first + 1}–${Math.min(first + LOG_PAGE, filtered.length)} of ${filtered.length}, newest first`;
  $('logs-prev').disabled = logPage === 0;
  $('logs-next').disabled = logPage >= pages - 1;
  if ($('logs-summary')) $('logs-summary').textContent = `${logger.logs.length} entries`;
}

export function renderLogsPage() {
  renderLogs();
  if (!document.querySelector('[data-ptpanel="logs:people"]').hidden) loadUserActivity({ offset: userActivity.offset });
}

export function wireLogs() {
  $('logs-prev').addEventListener('click', () => {
    logPage = Math.max(0, logPage - 1);
    renderLogs();
  });
  $('logs-next').addEventListener('click', () => {
    logPage += 1;
    renderLogs();
  });

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
    $('log-search').addEventListener('input', () => {
      logPage = 0;
      renderLogs();
    });
  }
}
