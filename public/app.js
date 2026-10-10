import { nextSpeedster } from './speedsters.js';
import { initCalculator } from './calculator/page.js';
import { availableLanguages, currentLanguage, deviceTimeZone, onLanguageChange, setAvailable, setLanguage, setTimeZone, startI18n, t } from './i18n.js';

const $ = (id) => document.getElementById(id);

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
window.addEventListener('error', (e) => reportClientError(e.message, e.filename, e.lineno, e.colno, e.error?.stack));
window.addEventListener('unhandledrejection', (e) => reportClientError(e.reason?.message ?? e.reason, '', 0, 0, e.reason?.stack));
$('download-diagnostics')?.addEventListener('click', () => {
  // A plain download: the server sends it as an attachment.
  location.href = '/api/diagnostics/download';
});
/** "10 Checkmarx One results (12 findings — rows sharing a result count once)": why the rows and the credits differ. */
function resultsText(results, rows) {
  const r = `${results} Checkmarx One result${results === 1 ? '' : 's'}`;
  return rows > results ? `${r} (${rows} findings — rows that share one result are triaged, and charged, once)` : r;
}
/** How long a "confirmed twice with Checkmarx One" count stays good for. */
const VERIFY_TTL_MS = 10 * 60 * 1000;
const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

const state = {
  connection: null,
  settings: null,
  health: null,
  projects: [],
  // True while a fetch is streaming in: triage, remediation and allocation wait.
  fetching: false,
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
 * Show or update the flare `key`: kind busy | done | failed. `spoken` is what a
 * screen reader announces instead of the lines on screen, for a busy flare whose
 * lines change every second.
 */
function flare(key, kind, text, hint = '', spoken = '') {
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
  el.querySelector('small').textContent = hint;
  el.querySelector('small').hidden = !hint;
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
  ['POST', /^\/api\/iam\//, 'Saving people and roles…', 'Saved'],
  ['PATCH', /^\/api\/iam\//, 'Saving people and roles…', 'Saved'],
  ['PUT', /^\/api\/iam\//, 'Saving people and roles…', 'Saved'],
  ['DELETE', /^\/api\/iam\//, 'Removing…', 'Removed'],
  ['POST', /^\/api\/me\/password$/, 'Changing your password…', 'Password changed'],
  ['POST', /^\/api\/beta\/github\/evaluate$/, 'Matching GitHub usernames…', 'Matching finished'],
  ['POST', /^\/api\/beta\/authors\/find$/, 'Finding who wrote the vulnerable code…', 'Authors found'],
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
 * While an action runs, its flare says something light-hearted (a new line every
 * few seconds, themed to the action) over a live line: what it is doing, for how
 * many projects, and for how long. Like a spinner, but you can read it.
 */
const QUIPS = [
  [/^\/api\/(credits\/verify|tracked-reports\/[^/]+\/refresh)/, ['Reading it twice, trusting it once…', 'Comparing notes with Checkmarx One…', 'Counting results, then counting them again…', 'Making sure nobody moved the goalposts…', 'Spotting what changed since you looked…', 'Matching every finding to its result…']],
  [/^\/api\/(triage|tracked-reports\/[^/]+\/triage)/, ['Waking up the AI…', 'Weighing true against false positives…', 'Reading the code so you do not have to…', 'Booking one credit per result, not per row…', 'Asking the hard questions…', 'Following the data flow…']],
  [/^\/api\/remediation/, ['Waking up the AI…', 'Sharpening the fix…', 'Teaching the bug some manners…', 'Drafting the pull request…', 'Booking one credit per result, not per row…', 'Following the data flow…']],
  [/^\/api\/(credits|tracked-reports\/[^/]+\/allocate)/, ['Balancing the books…', 'Counting credits twice…', 'Nothing spent that is not needed…', 'Checking the pool is big enough…', 'Writing it into the audit log…']],
  [/^\/api\/(reminders|tracked-reports\/[^/]+\/remind|beta\/authors\/notify|settings\/smtp\/send-test)/, ['Licking the stamps…', 'Addressing the envelopes…', 'Only their own projects, nobody else\'s…', 'Finding the right inboxes…', 'Sending at the speed of SMTP…', 'Folding the reports neatly…']],
  [/^\/api\/(integration|settings)/, ['Testing the wires…', 'Shaking hands with the server…', 'Turning the dials…', 'Checking every connection…', 'Keeping the last good settings handy…']],
  [/^\/api\/(backup|audit)/, ['Following the hash chain…', 'Checking every link…', 'Packing everything neatly…', 'Nothing missing, nothing changed…']],
  [/^\/api\/beta/, ['Digging through the history…', 'Asking git who wrote this…', 'Matching names to faces…']],
  [/./, ['Revving up…', 'On it…', 'Moving fast, breaking nothing…', 'Putting things in order…', 'Almost there…']],
];
const SLOW_QUIPS = ['Still on it — a big one…', 'Taking the scenic route…', 'Worth the wait…'];
// In every other language the busy line is plain and factual: word play does not translate.
const PLAIN_QUIPS = [
  [QUIPS[0][0], ['Verifying with Checkmarx One…', 'Comparing the two reads…', 'Matching each finding to its result…']],
  [QUIPS[1][0], ['Running AI Triage…', 'Analysing the findings…', 'Counting one credit per result…']],
  [QUIPS[2][0], ['Running AI Remediation…', 'Preparing the fix…', 'Counting one credit per result…']],
  [QUIPS[3][0], ['Updating the credit allocation…', 'Checking the credit pool…', 'Recording it in the audit log…']],
  [QUIPS[4][0], ['Preparing the emails…', 'Sending the emails…', 'Each person receives only their own projects…']],
  [QUIPS[5][0], ['Testing the connection…', 'Applying the settings…']],
  [QUIPS[6][0], ['Verifying the audit log…', 'Checking every entry…']],
  [QUIPS[7][0], ['Reading the repository history…', 'Matching people to email addresses…']],
  [QUIPS[8][0], ['Working…', 'Processing…']],
];
const PLAIN_SLOW = ['Still working: this takes longer than usual…'];

/** "12 projects" when the request names projects. */
function scopeOf(body) {
  try {
    const ids = JSON.parse(body ?? '{}')?.projectIds;
    return Array.isArray(ids) && ids.length ? `${ids.length} project${ids.length === 1 ? '' : 's'}` : '';
  } catch {
    return '';
  }
}

/** Keep the busy flare `key` alive: a new quip every 3 s, the clock every second. Returns stop(). */
function startBusyFlare(key, path, activity, body) {
  const route = path.split('?')[0];
  const plain = currentLanguage() !== 'en';
  const quips = (plain ? PLAIN_QUIPS : QUIPS).find(([pattern]) => pattern.test(route))[1];
  const slow = plain ? PLAIN_SLOW : SLOW_QUIPS;
  const label = activity.busy.replace(/…$/, '');
  const scope = scopeOf(body);
  const started = Date.now();
  let turn = Math.floor(Math.random() * quips.length);
  let shown = '';
  const draw = () => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    const quip = seconds >= 15 && Math.floor(seconds / 3) % 2 ? slow[Math.floor(seconds / 6) % slow.length] : quips[(turn + Math.floor(seconds / 3)) % quips.length];
    flare(key, 'busy', quip, [label, scope, `${seconds}s`].filter(Boolean).join(' · '), activity.busy);
    if (quip !== shown && shown && !reducedMotion.matches) {
      flares.get(key)?.querySelector('.flare-main').animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out' });
    }
    shown = quip;
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
document.addEventListener('click', (event) => (lastClick = { el: event.target, at: Date.now() }), true);

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

async function api(path, options = {}) {
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
  showHelp(el, null);
}

/** Errors from Checkmarx and SMTP carry a detail body; it is usually the answer. A connection error also says how to fix it. */
function showError(id, error) {
  const help = error.body?.help;
  // With an explanation, the raw detail goes under "What was tried" instead of the status line.
  setStatus(id, error.detail && !help ? `${error.message} — ${error.detail}` : error.message, 'error');
  showHelp($(id), help);
}

/**
 * What went wrong and how to fix it (the server's src/troubleshoot.js): one sentence, numbered
 * steps, and, folded away, what was tried and the other side's own answer.
 */
function helpHtml(help, { open = true } = {}) {
  if (!help?.problem) return '';
  const facts = (help.facts ?? []).map(([label, value]) => `<div><span class="k">${escapeHtml(label)}</span><span class="v" translate="no">${escapeHtml(value)}</span></div>`).join('');
  return `<div class="fix-help" role="note">
    <p class="fix-problem">${escapeHtml(help.problem)}</p>
    <details class="fix-how"${open ? ' open' : ''}><summary>How to fix it</summary>
      <ol class="fix-steps">${(help.steps ?? []).map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
    </details>
    ${facts ? `<details class="fix-facts"><summary>What was tried</summary><div class="kv">${facts}</div></details>` : ''}
  </div>`;
}

/** Put the explanation right under a status line (or take it away). */
function showHelp(el, help) {
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
  credits: 'credits.view',
  impact: 'reports.view',
  audit: 'audit.view backup.view',
  settings: '', // everyone has Your profile; the rest needs settings.view
  access: 'iam.view',
  beta: 'beta.use feature.codeAuthors feature.identityMatching',
  logs: '',
  help: '', // everyone may ask for help
  calculator: 'projections.use',
};

/**
 * Show only what this person may use: [data-perm] elements need any one of
 * the listed permissions; [data-edit-perm] panels turn read-only without it.
 */
// ---- Simple by default: fine-tuning most people never need is shown on request ----
const ADVANCED_KEY = 'mz-advanced';
function advancedOn() {
  try {
    return localStorage.getItem(ADVANCED_KEY) === '1';
  } catch {
    return false;
  }
}
function applyAdvanced(on = advancedOn()) {
  document.body.classList.toggle('simple', !on);
  const box = document.getElementById('me-advanced');
  if (box) box.checked = on;
}
applyAdvanced();
document.getElementById('me-advanced')?.addEventListener('change', (event) => {
  try {
    localStorage.setItem(ADVANCED_KEY, event.target.checked ? '1' : '0');
  } catch {}
  applyAdvanced(event.target.checked);
  if (state.page === 'settings') showSettingsSection(location.hash.split('/')[2] || '');
  toast(event.target.checked ? 'Advanced options shown.' : 'Advanced options hidden: the essentials only.', 'ok', 2500);
});

function applyPermissions() {
  for (const el of document.querySelectorAll('[data-perm]')) el.classList.toggle('perm-hidden', !canAny(el.dataset.perm));
  // Settings: Your profile is everyone's; every other section needs settings.view.
  const settingsToo = can('settings.view');
  for (const el of document.querySelectorAll('#set-nav .set-group:not(.set-you), #set-nav [data-set]:not([data-set="profile"]):not([data-set="mybrand"]), #autosave-note')) el.classList.toggle('no-settings', !settingsToo);
  applyMyAppBranding();
  // Settings → Tenants only once a tenants activation code has been applied.
  for (const el of document.querySelectorAll('[data-set="tenants"], #set-tenants')) el.classList.toggle('addon-hidden', !state.me?.unlocked?.tenants);
  // The Cx Credits Calculator: only once its activation code is applied.
  for (const el of document.querySelectorAll('[data-addon="calculator"]')) el.classList.toggle('addon-hidden', !state.me?.unlocked?.calculator);
  renderFeatureStages();
  // Optional columns can depend on permissions (SLAs).
  try {
    renderColumnMenu();
    renderProjectsHead();
  } catch {
    /* before the table's code has loaded: it renders them itself */
  }
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
// Routing: #/page, or #/page/view for a tab or a Settings section.
// A page keeps what is on it when you go elsewhere and come back — filters,
// tabs, open rows, unsaved role changes, the scroll position. The ↻ button in
// the header reloads one page's data; Refresh in the sidebar starts over.
// ---------------------------------------------------------------------------

const ROUTE_ALIASES = { iam: 'access', 'credit-control': 'credits' };
/** Act → Follow up → Prove, plus Set up: what each page is for. */
const STAGES = { dashboard: 'act', beta: 'act', reports: 'followup', credits: 'prove', impact: 'prove', audit: 'prove', calculator: 'plan', access: 'setup', settings: 'setup', logs: 'setup' };
const STAGE_LABELS = { act: 'Act', followup: 'Follow up', prove: 'Prove', plan: 'Plan', setup: 'Set up' };
/** The tab group on each page (data-ptabs). */
const PAGE_TABS = { dashboard: 'dash', credits: 'credits', impact: 'impact', audit: 'audit', access: 'access', beta: 'beta', logs: 'logs', calculator: 'calculator' };
const visitedPages = new Set();
const scrollMemory = new Map();

function parseRoute() {
  const [path] = location.hash.replace(/^#\/?/, '').split('?');
  const [raw = '', view = ''] = path.split('/');
  return { name: ROUTE_ALIASES[raw] ?? (raw || 'dashboard'), view: decodeURIComponent(view) };
}

// ---- Beta features, and making them final -----------------------------------

const FEATURE_TABS = { codeAuthors: 'Code authors', identityMatching: 'Match usernames' };

/** Beta labels only on what is still Beta; the sidebar names the page after what it holds. */
function renderFeatureStages() {
  const stages = state.me?.features ?? {};
  for (const badge of document.querySelectorAll('[data-beta-badge]')) badge.hidden = stages[badge.dataset.betaBadge] === 'final';
  const beta = Object.keys(FEATURE_TABS).filter((id) => stages[id] !== 'final');
  const banner = document.getElementById('beta-banner');
  if (banner) banner.hidden = beta.length === 0;
  if (banner) {
    const names = beta.map((id) => FEATURE_TABS[id]);
    banner.lastChild.textContent = ` ${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} still in Beta: ${names.length === 1 ? 'it reads' : 'they read'} git history and, if connected, the GitHub, GitLab, Azure DevOps and Bitbucket APIs. Check results before relying on them.`;
  }
  const name = stages.codeAuthors === 'final' ? 'Code authors' : 'Beta';
  const label = document.getElementById('nav-beta-label');
  if (label) label.textContent = name;
  PAGE_TITLES.beta[0] = name;
  if (state.page === 'beta') setPageTitle('beta');
  const authorsRow = document.getElementById('auto-authors-row');
  if (authorsRow) authorsRow.hidden = stages.codeAuthors !== 'final';
}

async function loadFeatures() {
  if (!can('features.manage')) return;
  try {
    renderFeatures(await api('/api/features'));
  } catch (error) {
    if (!handleAuthLoss(error)) showError('feat-status', error);
  }
}

function renderFeatures({ features }) {
  $('feat-list').innerHTML = features
    .map((f) => {
      const final = f.stage === 'final';
      const since = f.changedAt ? ` · since ${new Date(f.changedAt).toLocaleDateString()}${f.changedBy ? ` by ${f.changedBy}` : ''}` : '';
      return `<article class="feat-card ${final ? 'is-final' : ''}">
        <div class="feat-head">
          <h3>${escapeHtml(f.name)} <span class="badge ${final ? 'ok' : 'warn'}">${final ? 'Final' : 'Beta'}</span></h3>
          <button type="button" class="${final ? '' : 'primary'}" data-feature-stage="${escapeHtml(f.id)}" data-to="${final ? 'beta' : 'final'}">${final ? 'Back to Beta' : 'Make final'}</button>
        </div>
        <p>${escapeHtml(f.summary)}</p>
        <p class="hint">${final ? 'Now' : 'Once final'}:</p>
        <ul class="feat-effects">${f.whenFinal.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
        ${!final && f.beforeFinal ? `<p class="feat-caution"><span class="badge warn">Before making it final</span> ${escapeHtml(f.beforeFinal)}</p>` : ''}
        <p class="hint">${final ? 'Final' : 'In Beta'}${escapeHtml(since)}</p>
      </article>`;
    })
    .join('');
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-feature-stage]');
  if (!button) return;
  const to = button.dataset.to;
  const name = button.closest('.feat-card')?.querySelector('h3')?.firstChild?.textContent?.trim() ?? 'this feature';
  if (!confirm(to === 'final' ? `Make “${name}” final for everyone in your organisation?` : `Put “${name}” back in Beta? People without “Beta features” lose access to it.`)) return;
  button.disabled = true;
  setStatus('feat-status', 'Saving…');
  try {
    renderFeatures(await api(`/api/features/${encodeURIComponent(button.dataset.featureStage)}`, { method: 'PUT', body: JSON.stringify({ stage: to }) }));
    state.me = await api('/api/me');
    applyPermissions();
    setStatus('feat-status', to === 'final' ? `“${name}” is final.` : `“${name}” is back in Beta.`, 'ok');
  } catch (error) {
    button.disabled = false;
    if (!handleAuthLoss(error)) showError('feat-status', error);
  }
});

// ---- Settings → Hands-off: set it up once (four questions), then steer it by email ----

const handsOff = { data: null };
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

async function loadHandsOff() {
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

// ---- Settings → Your branding: one's own names, logo and colours, for demonstrations ----

const MB_FIELDS = [['mb-app', 'appName'], ['mb-name', 'companyName'], ['mb-logo', 'logoUrl'], ['mb-height', 'logoHeight'], ['mb-cta', 'callToAction']];
const myBrand = { org: null, timer: null };

/** The header's name and logo: the organisation's, with this person's own over it while they use it. */
function applyMyAppBranding() {
  const b = state.me?.branding;
  if (b) applyAppBranding({ name: b.appName, logoUrl: b.logoUrl });
}

async function refreshMyAppBranding() {
  try {
    state.me = await api('/api/me', { quiet: true });
    applyMyAppBranding();
  } catch {}
}

async function loadMyBranding() {
  if (!can('branding.personal')) return;
  try {
    renderMyBranding(await api('/api/me/branding', { quiet: true }));
  } catch (error) {
    if (!handleAuthLoss(error)) showError('mb-status', error);
  }
}

function renderMyBranding({ branding: b, organisation: o }) {
  myBrand.org = o;
  $('mb-on').checked = b.on;
  for (const [id, key] of MB_FIELDS) {
    if (document.activeElement !== $(id)) $(id).value = b[key] || '';
    const org = o[key];
    $(id).placeholder = key === 'logoUrl' && String(org).startsWith('data:') ? 'The organisation’s uploaded logo' : String(org || '');
  }
  const hex = (c) => (/^#[0-9a-f]{6}$/i.test(c ?? '') ? c : '#1d4ed8');
  $('mb-accent').value = hex(b.accentColor || o.accentColor);
  $('mb-accent').dataset.org = b.accentColor ? '' : '1';
  $('mb-accent-org').hidden = !b.accentColor;
  renderMyBrandPreview();
}

function myBrandingPayload() {
  return {
    on: $('mb-on').checked,
    ...Object.fromEntries(MB_FIELDS.map(([id, key]) => [key, key === 'logoHeight' ? Number($(id).value) || 0 : $(id).value])),
    accentColor: $('mb-accent').dataset.org === '1' ? '' : $('mb-accent').value,
  };
}

/** The head of a reminder or report as it will look: the organisation's, with yours over it. */
function renderMyBrandPreview() {
  const o = myBrand.org ?? {};
  const p = myBrandingPayload();
  const pick = (key) => p[key] || o[key];
  const url = pick('logoUrl');
  const name = pick('companyName');
  const box = $('mb-preview');
  const head = url && /^(https:\/\/|data:image\/)/i.test(url)
    ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(name || '')}" style="height:${Number(pick('logoHeight')) || 40}px;max-width:260px;display:block" />`
    : name
      ? `<strong style="font-size:17px" translate="no">${escapeHtml(name)}</strong>`
      : '<span class="hint">No logo or company name: a plain header.</span>';
  box.innerHTML = `<p class="hint">${p.on ? 'What you send now:' : 'What you would send with it on:'} <b translate="no">${escapeHtml(pick('appName') || 'CxMissionZero')}</b></p>
    <div style="border-bottom:2px solid ${escapeHtml(p.accentColor || o.accentColor || '#1d4ed8')};padding-bottom:10px">${head}</div>
    ${pick('callToAction') ? `<p style="margin:10px 0 0" translate="no">${escapeHtml(pick('callToAction'))}</p>` : ''}`;
}

async function saveMyBranding() {
  clearTimeout(myBrand.timer);
  setStatus('mb-status', 'Saving…');
  try {
    const result = await api('/api/me/branding', { method: 'PUT', body: JSON.stringify(myBrandingPayload()), quiet: true });
    state.me = result.me;
    applyMyAppBranding();
    renderMyBranding(result);
    setStatus('mb-status', result.branding.on ? 'Saved. What you send now carries your branding.' : 'Saved. You use the organisation’s branding.', 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('mb-status', error);
  }
}

$('set-mybrand').addEventListener('input', (event) => {
  if (event.target.id === 'mb-logo-file') return;
  if (event.target.id === 'mb-accent') {
    $('mb-accent').dataset.org = '';
    $('mb-accent-org').hidden = false;
  }
  renderMyBrandPreview();
  clearTimeout(myBrand.timer);
  myBrand.timer = setTimeout(saveMyBranding, 700);
});
$('mb-on').addEventListener('change', saveMyBranding);
$('mb-accent-org').addEventListener('click', () => {
  $('mb-accent').dataset.org = '1';
  saveMyBranding();
});
$('mb-clear').addEventListener('click', () => {
  if (!confirm('Clear your branding? You go back to the organisation’s.')) return;
  for (const [id] of MB_FIELDS) $(id).value = '';
  $('mb-accent').dataset.org = '1';
  $('mb-on').checked = false;
  saveMyBranding();
});
$('mb-logo-file').addEventListener('change', () => {
  const file = $('mb-logo-file').files[0];
  $('mb-logo-file').value = '';
  if (!file) return;
  if (file.size > 200 * 1024) return alert('That image is larger than 200 KB. Please use a smaller logo.');
  const reader = new FileReader();
  reader.onload = () => {
    $('mb-logo').value = reader.result;
    $('mb-logo').dispatchEvent(new Event('input', { bubbles: true }));
  };
  reader.readAsDataURL(file);
});

// ---- Activation codes: add-ons unlocked by the maintainer (Hebrew, several tenants) ----

async function loadActivation() {
  if (!canAny('activation.manage activation.view')) return;
  try {
    renderActivation(await api('/api/activation', { quiet: true }));
  } catch (error) {
    if (!handleAuthLoss(error)) showError('act-status', error);
  }
}

/** The languages this person may use now (after Hebrew was turned on or off, or opened to other people). */
async function refreshMyLanguages() {
  try {
    const me = await api('/api/me', { quiet: true });
    if (Array.isArray(me.languages)) languagesChanged(me.languages, true);
    // A tenants code just applied brings Settings → Tenants.
    if (state.me) {
      state.me = me;
      applyPermissions();
    }
  } catch {}
}

function renderActivation(a) {
  const date = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
  const he = a.languages?.he ?? { on: false };
  const t = a.tenants;
  // Only what a code has unlocked (or whose code ran out): an add-on appears, switched on, when its code is applied.
  const rows = [
    // Each English piece is its own element, so the page translator can reach it.
    ...(he.on || he.expired ? [`<div class="act-row"><strong>Hebrew</strong><span>${he.on ? `<span class="badge ok">On</span> <span>Until</span> <b>${escapeHtml(date(he.expires))}</b>${he.org ? ` · ${escapeHtml(he.org)}` : ''}` : `<span class="badge warn">Expired</span> <b>${escapeHtml(date(he.expires))}</b>`}</span></div>`] : []),
    ...(a.calculator ? [`<div class="act-row"><strong>Cx Credits Calculator</strong><span><span class="badge ok">On</span> <span>Until</span> <b>${escapeHtml(date(a.calculator.expires))}</b> · ${escapeHtml(a.calculator.org)}${a.calculator.warn ? ` <strong class="https-note warn">${a.calculator.daysLeft} days left</strong>` : ''}</span></div>`] : []),
    ...(t ? [`<div class="act-row"><strong>Several tenants</strong><span>${t.valid ? '<span class="badge ok">Unlocked</span>' : '<span class="badge warn">Expired</span>'} ${escapeHtml(t.org)} · <span>Up to ${t.maxTenants} tenants</span> · <span>Until</span> <b>${escapeHtml(date(t.expires))}</b>${t.warn ? ` <strong class="https-note warn">${t.daysLeft} days left</strong>` : ''}</span></div>`] : []),
  ];
  if (!rows.length) rows.push('<p class="hint">No add-ons are unlocked yet.</p>');
  if (!a.keyConfigured) rows.push('<p class="hint">This build has no maintainer key, so no code can be checked.</p>');
  // Hebrew is open only to the people chosen here.
  if (he.on) {
    const everyone = !Array.isArray(he.users);
    const chosen = new Set(he.users ?? []);
    rows.push(`<div class="act-people">
      <strong>Who may use Hebrew</strong>
      <p class="hint">${everyone ? 'Everyone, because Hebrew was turned on before people could be chosen. Choose people to keep it for them only.' : 'Only the people ticked here are offered Hebrew. Everyone else never sees it.'}</p>
      ${!everyone && !chosen.size ? '<p class="https-note warn">Nobody is offered Hebrew yet, so nobody sees it in the language list. Tick the people who should have it, yourself included, then save.</p>' : ''}
      <input type="search" id="act-people-filter" placeholder="Search people" aria-label="Search people" />
      <div class="act-people-list" id="act-people-list">${(a.people ?? [])
        .map((p) => `<label class="check" data-person="${escapeHtml(`${p.name} ${p.email}`.toLowerCase())}"><input type="checkbox" value="${escapeHtml(p.id)}" ${chosen.has(p.id) ? 'checked' : ''} /> <span translate="no">${escapeHtml(p.name || p.email)}</span>${p.name ? ` <small class="muted" translate="no">${escapeHtml(p.email)}</small>` : ''}</label>`)
        .join('')}</div>
      <div class="actions compact"><button type="button" class="primary" id="act-people-save">Save who may use Hebrew</button></div>
    </div>`);
  }
  $('act-list').innerHTML = rows.join('');
  // Seeing the page is not changing it: an Admin enters codes and chooses who may use Hebrew.
  $('act-view-only').hidden = Boolean(a.canManage);
  if (!a.canManage) {
    for (const box of $('act-list').querySelectorAll('#act-people-list input')) box.disabled = true;
    $('act-people-save')?.remove();
  }
}

$('act-list').addEventListener('input', (event) => {
  if (event.target.id !== 'act-people-filter') return;
  const term = event.target.value.trim().toLowerCase();
  for (const row of $('act-list').querySelectorAll('[data-person]')) row.hidden = Boolean(term) && !row.dataset.person.includes(term);
});

$('act-list').addEventListener('click', async (event) => {
  if (event.target.id !== 'act-people-save') return;
  const users = [...$('act-list').querySelectorAll('#act-people-list input:checked')].map((input) => input.value);
  try {
    renderActivation(await api('/api/activation/languages/he/users', { method: 'PUT', body: JSON.stringify({ users }) }));
    setStatus('act-status', users.length ? (users.length === 1 ? 'Hebrew is open to 1 person.' : `Hebrew is open to ${users.length} people.`) : 'Hebrew is open to nobody until people are chosen.', 'ok');
    refreshMyLanguages();
  } catch (error) {
    if (!handleAuthLoss(error)) showError('act-status', error);
  }
});

$('act-apply').addEventListener('click', async () => {
  const code = $('act-code').value.trim();
  if (!code) return setStatus('act-status', 'Paste the activation code first.', 'error');
  $('act-apply').disabled = true;
  try {
    const result = await api('/api/activation', { method: 'POST', body: JSON.stringify({ code }) });
    renderActivation(result);
    $('act-code').value = '';
    setStatus('act-status', `Applied: ${result.applied}.`, 'ok');
    // A language turned on or off is offered (or not) at once.
    refreshMyLanguages();
  } catch (error) {
    if (!handleAuthLoss(error)) setStatus('act-status', error.message, 'error');
  } finally {
    $('act-apply').disabled = false;
  }
});

// ---- Several Checkmarx One tenants: the switcher at the top, and Settings → Tenants -----------

/** The tenant switcher: shown to people who work in more than one tenant. */
function renderTenantPicker(me) {
  const t = me?.tenancy;
  const show = Boolean(t && t.tenants.length > 1);
  $('tenant-pick').hidden = !show;
  if (!show) return;
  $('tenant-name').textContent = t.current.name;
  $('tenant-select').innerHTML = t.tenants.map((x) => `<option value="${escapeHtml(x.id)}" ${x.id === t.current.id ? 'selected' : ''}>${escapeHtml(x.name)}</option>`).join('');
}

$('tenant-select').addEventListener('change', async (event) => {
  try {
    await api('/api/me/tenant', { method: 'POST', body: JSON.stringify({ id: event.target.value }) });
    // Every page shows the other tenant's data: start the page afresh in it.
    location.reload();
  } catch (error) {
    if (!handleAuthLoss(error)) toast(error.message, 'error');
    renderTenantPicker(state.me);
  }
});

async function loadTenants() {
  if (!can('tenants.manage')) return;
  try {
    renderTenants(await api('/api/tenants', { quiet: true }));
  } catch (error) {
    if (!handleAuthLoss(error)) showError('tn-status', error);
  }
}

function renderTenants(v) {
  const date = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
  const a = v.activation;
  // Each English piece is its own element, so the page translator can reach it.
  $('tn-state').innerHTML = a?.valid
    ? `<div class="act-row"><strong>Several tenants</strong><span><span class="badge ok">Unlocked</span> ${escapeHtml(a.org)} · <span>Up to ${a.maxTenants} tenants</span> · <span>Until</span> <b>${escapeHtml(date(a.expires))}</b>${a.warn ? ` <strong class="https-note warn">${a.daysLeft} days left</strong>` : ''}</span></div>`
    : `<div class="act-row"><strong>Several tenants</strong><span>${a ? '<span class="badge warn">Expired</span>' : '<span class="badge muted">Not unlocked</span>'} <span>Apply a tenants activation code in Settings → Activation codes.</span></span></div>`;
  $('tn-enabled').checked = v.enabled;
  $('tn-enabled').disabled = !v.unlocked;
  $('tn-body').hidden = !v.enabled;
  $('tn-add').disabled = !v.unlocked;
  $('tn-list').innerHTML = v.tenants
    .map((t) => `<li><strong>${escapeHtml(t.name)}</strong>${t.first ? ' <span class="badge muted">First tenant</span>' : ''}${t.id === v.current ? ' <span class="badge">You are here</span>' : ''}
      <span class="hint">${t.people === 1 ? '1 person' : `${t.people} people`}</span>
      ${v.unlocked && !t.first ? `<button type="button" class="link" data-tn-rename="${escapeHtml(t.id)}">Rename</button><button type="button" class="link danger" data-tn-remove="${escapeHtml(t.id)}">Remove</button>` : ''}
      ${v.unlocked && t.first ? `<button type="button" class="link" data-tn-rename="${escapeHtml(t.id)}">Rename</button>` : ''}</li>`)
    .join('');
  tenantsView = v;
}
let tenantsView = null;

/** A change to the tenants: show it, and refresh the switcher at the top. */
async function tenantsChanged(view, message) {
  renderTenants(view);
  if (message) setStatus('tn-status', message, 'ok');
  try {
    state.me = { ...state.me, ...(await api('/api/me', { quiet: true })) };
    renderTenantPicker(state.me);
  } catch {}
}

$('tn-enabled').addEventListener('change', async (event) => {
  const on = event.target.checked;
  try {
    await tenantsChanged(await api('/api/tenants/enabled', { method: 'POST', body: JSON.stringify({ on }) }), on ? 'Several tenants are on.' : 'Several tenants are off.');
  } catch (error) {
    event.target.checked = !on;
    if (!handleAuthLoss(error)) showError('tn-status', error);
  }
});

$('tn-add').addEventListener('click', async () => {
  const name = $('tn-name').value.trim();
  if (!name) return setStatus('tn-status', 'Give the tenant a name.', 'error');
  try {
    const result = await api('/api/tenants', { method: 'POST', body: JSON.stringify({ name }) });
    $('tn-name').value = '';
    await tenantsChanged(result, 'Added. Choose it at the top of the page to set it up.');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('tn-status', error);
  }
});

$('tn-list').addEventListener('click', async (event) => {
  const rename = event.target.closest('[data-tn-rename]');
  const remove = event.target.closest('[data-tn-remove]');
  const id = rename?.dataset.tnRename ?? remove?.dataset.tnRemove;
  const tenant = tenantsView?.tenants.find((t) => t.id === id);
  if (!tenant) return;
  try {
    if (rename) {
      const name = prompt('New name for this tenant:', tenant.name);
      if (!name || name.trim() === tenant.name) return;
      await tenantsChanged(await api(`/api/tenants/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) }), 'Renamed.');
    } else {
      const typed = prompt(`Remove the tenant "${tenant.name}"? Its people lose access to it at once. Its files are kept in the state folder. Type its name to confirm:`);
      if (typed === null) return;
      await tenantsChanged(await api(`/api/tenants/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ confirm: typed.trim() }) }), 'Removed.');
    }
  } catch (error) {
    if (!handleAuthLoss(error)) showError('tn-status', error);
  }
});

const reloadSettingsPage = () => {
  renderProfile();
  loadMyBranding();
  loadHandsOff();
  if (!can('settings.view')) return;
  loadFeatures();
  loadActivation();
  loadTenants();
  renderSettings();
  loadAutomation();
  loadPool();
  loadHttps();
  renderAbout();
  loadUpdates();
};

/**
 * A page's data, loaded the first time it opens (and by ↻). The Dashboard
 * loads nothing by itself: what was fetched is restored from the server, and
 * reading Checkmarx One again only ever starts from a click (Load findings, or ↻).
 */
const PAGE_LOADERS = {
  dashboard: () => {},
  settings: reloadSettingsPage,
  credits: () => loadUsage(),
  impact: () => loadImpact(),
  logs: () => renderLogsPage(),
  reports: () => loadTrackedReports(),
  beta: () => renderBeta(),
  audit: () => renderAudit(),
  access: () => loadAccess(),
  help: () => loadHelp(),
  calculator: () => calculator.load(),
};

/**
 * Coming back to a page: only refreshes that cannot lose anything in progress.
 * Settings shows what is saved (every edit there saves as it is typed); the
 * Reports page keeps the open report, its tab and its form; charts redraw.
 */
/** ↻ where it does more than the first visit: on the Dashboard, read the findings again with the scope shown. */
const PAGE_RELOAD = {
  dashboard: () => {
    if (state.projects.length && !$('fetch').disabled && can('findings.fetch')) $('fetch').click();
  },
};
const reloaderOf = (page) => PAGE_RELOAD[page] ?? PAGE_LOADERS[page];

const PAGE_RETURN = {
  settings: reloadSettingsPage,
  credits: () => loadUsage(),
  impact: () => loadImpact(),
  logs: () => renderLogs(),
  reports: () => loadTrackedReports(),
  beta: () => renderBetaScope(),
  help: () => loadHelp(),
  calculator: () => calculator.load({ reopen: false }),
};

function route() {
  if (!state.me) return;
  const { name, view } = parseRoute();
  const allowed = (page) => page in PAGE_PERMS && (!PAGE_PERMS[page] || canAny(PAGE_PERMS[page])) && (page !== 'calculator' || Boolean(state.me?.unlocked?.calculator));
  const target = allowed(name) ? name : 'dashboard';
  if (target !== name && location.hash) history.replaceState(null, '', '#/dashboard');

  const previous = state.page;
  if (previous && previous !== target) scrollMemory.set(previous, window.scrollY);
  for (const page of Object.keys(PAGE_PERMS)) $(`page-${page}`).hidden = page !== target;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.route === target);
    if (tab.dataset.route === target) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  setPageTitle(target);
  state.page = target;
  // A panel that stops the page scrolling belongs to its own page: the lock never follows you to another
  // (e.g. "Give credits on the Dashboard" from an open report). Coming back, its page's panel locks again.
  document.body.classList.toggle('rp-locked', target === 'reports' && Boolean(rpState.open));
  const dashboardSheet = target === 'dashboard' && (!$('preview-panel').hidden || Boolean(document.querySelector('.wb.rail-open')));
  document.body.classList.toggle('sheet-open', dashboardSheet);
  document.body.dataset.stage = STAGES[target] ?? '';
  $('page-reload').hidden = !reloaderOf(target);
  if (target === 'settings') showSettingsSection(view);
  if (target === 'help') helpRoute(view);
  else if (view && PAGE_TABS[target]) activateTab(PAGE_TABS[target], view, { remember: true });
  if (previous === target) return;

  // Leaving Settings: what was typed is saved; connections that do not work go back to the last known good ones.
  if (previous === 'settings') leaveSettings();
  if (target !== 'credits') clearTimeout(usageTimer);
  const first = !visitedPages.has(target);
  visitedPages.add(target);
  if (first) PAGE_LOADERS[target]?.();
  else PAGE_RETURN[target]?.();
  const top = first || !scrollMemory.has(target) ? 0 : scrollMemory.get(target);
  requestAnimationFrame(() => window.scrollTo({ top, behavior: 'instant' }));
}

$('page-reload').addEventListener('click', () => {
  const load = reloaderOf(state.page);
  if (!load) return;
  const icon = $('page-reload');
  icon.classList.remove('spin');
  void icon.offsetWidth;
  icon.classList.add('spin');
  load();
  if (state.page !== 'dashboard') toast(`${PAGE_TITLES[state.page]?.[0] ?? 'Page'}: data reloaded. Your filters and tabs are kept.`, 'ok', 2500);
});

$('me-refresh').addEventListener('click', () => $('app-refresh').click());
$('app-refresh').addEventListener('click', () => {
  if (!confirm('Start over?\n\nCxMissionZero reloads and every page goes back to how it opens: fetched data, filters, selections and anything not yet saved are cleared. Saved settings, reports and credits are not affected.')) return;
  try {
    sessionStorage.setItem('mz-fresh', '1');
  } catch {}
  history.replaceState(null, '', `#/${state.page || 'dashboard'}`);
  location.reload();
});

// ---- Tabs inside a page (data-ptabs / data-pt / data-ptpanel) ---------------

const TAB_KEY = 'mz-tabs';
/** Refresh (sidebar) reloads with this flag: everything opens as new, nothing is restored. */
const freshStart = (() => {
  try {
    const fresh = sessionStorage.getItem('mz-fresh') === '1';
    sessionStorage.removeItem('mz-fresh');
    if (fresh) for (const key of [TAB_KEY, 'mz-settings-section']) localStorage.removeItem(key);
    return fresh;
  } catch {
    return false;
  }
})();
const tabMemory = (() => {
  try {
    return JSON.parse(localStorage.getItem(TAB_KEY) || '{}') ?? {};
  } catch {
    return {};
  }
})();

const tabsOf = (group) => [...document.querySelectorAll(`[data-ptabs="${group}"] [data-pt]`)];
const usableTab = (tab) => !tab.classList.contains('perm-hidden') && !tab.hidden;

/** Show one tab of a group; `remember` keeps it for the next visit (this browser). */
function activateTab(group, name, { remember = true, focus = false } = {}) {
  const tabs = tabsOf(group);
  const usable = tabs.filter(usableTab);
  const tab = usable.find((t) => t.dataset.pt === name) ?? usable.find((t) => t.dataset.pt === tabMemory[group]) ?? usable[0];
  if (!tab) return;
  for (const t of tabs) {
    const on = t === tab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  }
  for (const panel of document.querySelectorAll(`[data-ptpanel^="${group}:"]`)) panel.hidden = panel.dataset.ptpanel !== `${group}:${tab.dataset.pt}`;
  if (focus) tab.focus();
  if (remember && tabMemory[group] !== tab.dataset.pt) {
    tabMemory[group] = tab.dataset.pt;
    try {
      localStorage.setItem(TAB_KEY, JSON.stringify(tabMemory));
    } catch {}
  }
  onTabShown(group, tab.dataset.pt);
}

/** Tabs whose content draws on demand. */
function onTabShown(group, name) {
  if (group === 'dash') renderRailScope();
}

function initTabs() {
  for (const bar of document.querySelectorAll('[data-ptabs]')) activateTab(bar.dataset.ptabs, tabMemory[bar.dataset.ptabs], { remember: false });
}

document.addEventListener('click', (event) => {
  const tab = event.target.closest?.('[data-ptabs] [data-pt]');
  if (!tab) return;
  const group = tab.closest('[data-ptabs]').dataset.ptabs;
  activateTab(group, tab.dataset.pt);
  // The address follows the tab, so a reload or a shared link opens it.
  const page = Object.keys(PAGE_TABS).find((p) => PAGE_TABS[p] === group);
  if (page && page === state.page && page !== 'dashboard') history.replaceState(null, '', `#/${page}/${tab.dataset.pt}`);
});
document.addEventListener('keydown', (event) => {
  const tab = event.target.closest?.('[data-ptabs] [data-pt]');
  if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const group = tab.closest('[data-ptabs]').dataset.ptabs;
  const usable = tabsOf(group).filter(usableTab);
  const i = usable.indexOf(tab);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? usable.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + usable.length) % usable.length;
  event.preventDefault();
  usable[next].click();
  usable[next].focus();
});

// ---- Settings: one section at a time, chosen on the left --------------------

const SETTINGS_KEY = 'mz-settings-section';

function showSettingsSection(id) {
  const links = [...document.querySelectorAll('#set-nav [data-set]')];
  const usable = links.filter((a) => !a.classList.contains('perm-hidden') && !a.classList.contains('no-settings') && !a.classList.contains('addon-hidden') && !(a.hasAttribute('data-advanced') && document.body.classList.contains('simple')));
  let saved = '';
  try {
    saved = localStorage.getItem(SETTINGS_KEY) || '';
  } catch {}
  const link = usable.find((a) => a.dataset.set === id) ?? usable.find((a) => a.dataset.set === saved) ?? usable.find((a) => a.dataset.set === 'connection') ?? usable[0];
  if (!link) return;
  for (const a of links) {
    const on = a === link;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'true');
    else a.removeAttribute('aria-current');
  }
  for (const section of document.querySelectorAll('#set-content > section.panel[id^="set-"]')) section.classList.toggle('set-off', section.id !== `set-${link.dataset.set}`);
  try {
    localStorage.setItem(SETTINGS_KEY, link.dataset.set);
  } catch {}
  if (id && id !== link.dataset.set) history.replaceState(null, '', `#/settings/${link.dataset.set}`);
  if (state.page === 'settings' && id) window.scrollTo({ top: 0, behavior: 'instant' });
}

const PAGE_TITLES = {
  connect: ['Sign in', 'Act on Checkmarx One findings, follow them up to zero, and prove every credit'],
  dashboard: ['Dashboard', 'See ageing vulnerabilities, then remind owners, triage and remediate them'],
  reports: ['Reports', 'Follow every tracked scope down to zero: progress, follow-ups and schedules'],
  credits: ['Credit Control', 'The credit pool, what each project was given and used, and spending over time'],
  impact: ['Impact', 'Hours AI saved, findings it cleared, and how fast the security debt is shrinking'],
  settings: ['Settings', 'Connections, reminders, AI and credits, reports, security — saved as you type'],
  logs: ['Logs', 'What this browser asked the server, and the troubleshooting log'],
  access: ['People & roles', 'Who can sign in, and what each role may do'],
  audit: ['Audit', 'Every credit spent, refused or failed — who, when, where, and the balance after'],
  beta: ['Beta', 'Find who wrote the vulnerable code, and match usernames to email addresses'],
  help: ['Get help', 'Support cases and enhancement requests: raise one, follow it, and talk to the support team'],
  calculator: ['Cx Credits Calculator', 'The Checkmarx One credits a customer needs: triage and remediation of their backlog, and Fusion scans of their projects'],
};

function setPageTitle(page) {
  const [title, sub] = PAGE_TITLES[page] ?? PAGE_TITLES.dashboard;
  $('page-title').textContent = title;
  $('page-sub').textContent = sub;
  const stage = STAGES[page];
  $('page-stage').hidden = !stage;
  if (stage) {
    $('page-stage').textContent = STAGE_LABELS[stage];
    $('page-stage').dataset.stage = stage;
  }
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
  showAvatar($('me-avatar'), user);
  if (Array.isArray(me.languages)) languagesChanged(me.languages, true);
  applyProfile(me);
  renderTenantPicker(me);
  $('me-detail').textContent = `${user.email} · ${me.role.name} · signed in with ${me.via === 'cxone' ? 'a Checkmarx One key' : 'a password'}`;
  $('user-menu').hidden = false;
  $('connect-panel').hidden = true;
  $('nav').hidden = false;
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

function refreshConnectionsSoon() {
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
function showSignIn({ setup = false, change = false, message = '' } = {}) {
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
  $('change-cancel').hidden = change;
  $('change-current-field').hidden = false;
  $('nav').hidden = true;
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
    setStatus('status', 'The fixed list is saved.', 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('status', error);
  }
}

async function loadSettings() {
  try {
    state.settings = await api('/api/settings');
    fillInlineRecipients();
    renderAudience();
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
  $('impact-currency').value = impact.currency ?? 'USD';
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
    renderAutomationElsewhere();
  } catch (error) {
    if (!handleAuthLoss(error)) console.warn(error.message);
  }
}

/**
 * Settings → Automation lists everything automatic, wherever it is set: each
 * tracked report's follow-up and rescan, and SLA escalation.
 */
/** A run's SLA issues, in a few words: opened, would be opened, skipped and why. */
function slaIssuesText(issues) {
  if (!issues) return '';
  if (issues.error) return ` · repository issues failed: ${issues.error}`;
  const skipped = issues.skipped?.length ? `, ${issues.skipped.length} project${issues.skipped.length === 1 ? '' : 's'} skipped (${[...new Set(issues.skipped.map((s) => s.reason))].slice(0, 2).join('; ')})` : '';
  if (!issues.opened && !skipped) return '';
  return ` · ${issues.opened} repository issue${issues.opened === 1 ? '' : 's'} ${issues.dryRun ? 'would be opened' : 'opened'} (${issues.findings} finding${issues.findings === 1 ? '' : 's'})${skipped}`;
}

async function renderAutomationElsewhere() {
  const box = $('auto-elsewhere');
  const rows = [];
  if (can('feature.sla')) {
    const sla = state.settings?.sla;
    const slaWays = [sla?.escalate && sla.escalateTo?.length ? `email to ${escapeHtml(sla.escalateTo.join(', '))}` : '', sla?.openIssues ? 'an issue in each repository' : ''].filter(Boolean);
    rows.push(`<li><span class="ae-what">SLA escalation <span class="badge warn" data-beta-badge="sla">Beta</span></span><span class="ae-when">${slaWays.length ? `On · with each run above: ${slaWays.join(', ')}` : 'Off'}</span><a href="#/settings/sla">Change →</a></li>`);
  }
  if (can('reports.view')) {
    try {
      const { reports } = await api('/api/tracked-reports', { quiet: true });
      for (const r of reports) {
        const a = r.automation ?? {};
        const follow = a.enabled ? `Follow-up ${escapeHtml(scheduleText(a).toLowerCase())}${a.nextRunAt ? `, next ${escapeHtml(relativeTime(a.nextRunAt))}` : ''}` : '';
        const rescan = r.verify?.auto ? 'rescan on the developers’ behalf when their window ends' : '';
        if (!follow && !rescan) continue;
        rows.push(`<li><span class="ae-what">${escapeHtml(r.name)} <span class="hint">tracked report</span></span><span class="ae-when">${[follow, rescan].filter(Boolean).join(' · ')}</span><a href="#/reports" data-open-report="${escapeHtml(r.id)}" data-tab="remind">Open →</a></li>`);
      }
    } catch {
      /* the list below still shows what it can */
    }
  }
  box.innerHTML = rows.length ? `<ul class="ae-list">${rows.join('')}</ul>` : '<p class="hint">Nothing else. Tracked reports can follow up by themselves (Reports → a report → Remind).</p>';
  renderFeatureStages();
}

function renderAutomation() {
  const a = state.automation;
  if (!a) return;

  $('auto-enabled').checked = a.config.enabled;
  $('auto-dry').checked = a.config.dryRun;
  $('auto-authors').checked = a.config.notifyCodeAuthors === true;
  $('auto-thresholds').value = a.config.thresholds.join(', ');
  $('auto-interval').value = a.config.intervalMinutes;
  renderAudience();
  $('auto-mode').value = a.config.mode;
  $('auto-severities').value = a.config.severities.join(', ');

  $('auto-status').textContent = a.config.enabled
    ? `On · next run ${timeAgo(a.nextRunAt)} · ${a.trackedFindings} finding(s) already reported`
    : 'Off';
  $('auto-status').className = `hint ${a.config.enabled ? 'ok-hint' : ''}`;

  // Runs use the server's Checkmarx One integration and its mail server: say,
  // from their current state, what an unattended run can do.
  const credential = $('auto-credential');
  const integration = a.integration ?? {};
  const tenant = integration.connection?.tenant;
  const lines = [];
  let ready = true;
  if (integration.connected) {
    const source = integration.source === 'environment' ? 'CX_API_KEY on the server' : 'the key stored under Checkmarx One integration';
    lines.push(`✓ Checkmarx One: connected${tenant ? ` to tenant ${tenant}` : ''}, using ${source}.`);
  } else {
    ready = false;
    lines.push('✗ Checkmarx One: not connected. Connect the server under "Checkmarx One integration" above — unattended runs use that connection.');
  }
  if (integration.pending) lines.push('… A changed integration key is saved but not in use yet: runs keep using the previous working connection until it works.');
  if (a.smtpVerified) {
    lines.push('✓ Mail server: connection test passed. Automation can send.');
  } else if (a.connections?.lastGood?.smtp) {
    lines.push('… Mail server: changed settings are not tested yet. They are checked when you leave Settings; the previous working ones come back if they fail.');
  } else {
    ready = false;
    lines.push(a.smtpConfigured
      ? '✗ Mail server: no successful connection test yet — automation cannot send. Use "Test connection" under Email server.'
      : '✗ Mail server: not set up yet — automation cannot send. Fill in Email server above.');
  }
  credential.className = `detected ${ready ? 'ok' : 'warn'}`;
  credential.innerHTML = lines.map((line) => `<div>${escapeHtml(line)}</div>`).join('');

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
                (run.error || run.reason || (run.failures?.length ? `${run.failures.length} failed` : 'ok')) +
                  (run.codeAuthors?.emailed ? ` · ${run.codeAuthors.emailed} code author${run.codeAuthors.emailed === 1 ? '' : 's'} ${run.dryRun ? 'would be ' : ''}emailed` : run.codeAuthors?.error ? ` · code authors: ${run.codeAuthors.error}` : '') +
                  (run.escalation?.escalated ? ` · ${run.escalation.escalated} past SLA ${run.escalation.sent ? 'escalated' : run.escalation.dryRun ? 'would be escalated' : `not escalated: ${run.escalation.error ?? ''}`}` : '') +
                  slaIssuesText(run.escalation?.issues),
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
    // Only offered once "Code authors" is final; otherwise left as it is.
    ...(state.me?.features?.codeAuthors === 'final' ? { notifyCodeAuthors: $('auto-authors').checked } : {}),
    thresholds: $('auto-thresholds').value,
    intervalMinutes: $('auto-interval').value,
    mode: $('auto-mode').value,
    severities: $('auto-severities').value,
  };
}

async function saveAutomation({ quiet = false } = {}) {
  autosave.automation = null;
  if (!quiet) setStatus('auto-message', 'Saving…');
  try {
    const status = await api('/api/automation', { method: 'PUT', body: JSON.stringify(automationPayload()) });
    state.automation = { ...state.automation, ...status };
    // Only the status line: the form stays as typed.
    const a = state.automation;
    $('auto-status').textContent = a.config.enabled
      ? `On · next run ${timeAgo(a.nextRunAt)} · ${a.trackedFindings ?? 0} finding(s) already reported`
      : 'Off';
    $('auto-status').className = `hint ${a.config.enabled ? 'ok-hint' : ''}`;
    setStatus('auto-message', status.config.enabled ? `Saved. Runs every ${status.config.intervalMinutes} minutes.` : 'Saved. Automation is off.', 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('auto-message', error);
    throw error;
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
        .concat(/^[A-Za-z]{3}$/.test($('impact-currency').value.trim()) ? [['currency', $('impact-currency').value.trim()]] : [])
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
for (const el of [...document.querySelectorAll('input[name="support-mode"]'), $('support-email')]) el.addEventListener('input', renderSupportNote);

// ---------------------------------------------------------------------------
// The credit pool (Settings → AI & credits; live while the page is open)
// ---------------------------------------------------------------------------

const CREDIT_REFRESH_MS = 15_000;
let creditTimer = null;
const fmt = (n) => Number(n ?? 0).toLocaleString();
const periodText = (pool) => (pool.period === 'all' ? 'one pool, does not refill' : 'refills on the 1st of each month (UTC)');

async function loadPool() {
  clearTimeout(creditTimer);
  if ($('page-settings').hidden) return;
  try {
    const data = await api('/api/credits');
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
  const tileHtml = `<div class="stat-tiles">${tiles
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
  $('pool-view').innerHTML = `${warning}${poolHtml(pool)}<p class="hint wide">${escapeHtml(pool.limited ? `The pool ${periodText(pool)}.` : 'No pool size set: spending is limited only by what each project is allocated.')} Per project and over time: <a href="#/credits">Credits</a>.</p>`;
}

// ---------------------------------------------------------------------------
// Settings save as they are typed
// ---------------------------------------------------------------------------

const AUTOSAVE_MS = 700;
const DRAFT_MS = 1200;
const CHECK_MS = 2500;
const autosave = { settings: null, automation: null, draft: null, check: null, running: new Set(), lastCheck: null, connectionEdited: false };
const INTEGRATION_FIELDS = new Set(['integration-key', 'integration-base', 'integration-iam', 'integration-tenant']);
const NOT_SAVED = new Set(['test-to', 'env-file', 'brand-logo-file', 'brand-icon-file']);

/** Which save an edit belongs to: the settings form, automation, the integration draft, or none. */
function autosaveKind(el) {
  if (!el?.id || NOT_SAVED.has(el.id) || el.disabled || el.closest('[hidden]')?.id === 'probe-results' || el.closest('#set-https') || el.closest('#set-mybrand') || el.closest('#set-handsoff')) return '';
  if (INTEGRATION_FIELDS.has(el.id)) return 'draft';
  if (el.closest('#set-automation')) return 'automation';
  if (el.matches('input, select, textarea')) return 'settings';
  return '';
}

function onSettingsEdit(event) {
  const kind = autosaveKind(event.target);
  if (!kind) return;
  setStatus('save-status', 'Saving…');
  if (kind === 'settings') scheduleSave();
  if (kind === 'automation') {
    clearTimeout(autosave.automation);
    autosave.automation = setTimeout(() => track(saveAutomation({ quiet: true })), AUTOSAVE_MS);
  }
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
    if (!autosave.running.size && !autosave.settings && !autosave.automation && !autosave.draft) {
      setStatus('save-status', `All changes are saved · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, 'ok');
    }
  });
  return promise;
}

/** Save everything pending now (leaving the page). */
async function flushSaves() {
  const pending = [];
  if (autosave.settings) pending.push(saveSettings());
  if (autosave.automation) pending.push(saveAutomation({ quiet: true }));
  if (autosave.draft) pending.push(saveIntegrationDraft());
  for (const key of ['settings', 'automation', 'draft']) clearTimeout(autosave[key]);
  autosave.settings = autosave.automation = autosave.draft = null;
  await Promise.allSettled([...pending, ...autosave.running]);
}

$('page-settings').addEventListener('input', onSettingsEdit);
$('page-settings').addEventListener('change', (event) => {
  // Text fields already saved on input; checkboxes, selects and colour pickers save on change.
  if (event.target.matches('input[type="checkbox"], input[type="radio"], select, input[type="color"], input[type="number"]')) onSettingsEdit(event);
});

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

async function loadConnectionGuard() {
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
async function leaveSettings() {
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

// Closing the tab on Settings: the server still checks (the result shows at the next sign-in).
window.addEventListener('pagehide', () => {
  if (state.page !== 'settings' || !canAny('integration.cxone integration.smtp')) return;
  if (!autosave.connectionEdited && !state.connections?.pending?.cxone && !state.connections?.pending?.smtp) return;
  navigator.sendBeacon?.('/api/settings/connections/check', new Blob([JSON.stringify({ rollback: true, present: false })], { type: 'application/json' }));
});

let toastTimer = null;
function toast(message, kind = '', ms = 6000) {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() {
  clearTimeout(toastTimer);
  $('toast').hidden = true;
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
function showNotices(notices, { acknowledge = false } = {}) {
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
$('notice-settings').addEventListener('click', () => $('notice-dialog').close());

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
  // Named projects (by id) and people: only these are fetched.
  for (const id of scopePick.projects.keys()) params.append('project', id);
  for (const who of scopePick.initiators) params.append('initiator', who);
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
  const named = scopePick.projects.size + scopePick.initiators.size;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const projectsPart = named
    ? [
        scopePick.projects.size && plural(scopePick.projects.size, 'named project'),
        scopePick.initiators.size && `${scopePick.initiators.size === 1 ? '1 person' : `${scopePick.initiators.size} people`}'s projects`,
      ].filter(Boolean).join(' + ')
    : presetLabel($('activity-preset').value);
  $('scope-summary').textContent = `Projects: ${projectsPart} · Findings: ${presetLabel(detection)}`;
  // Naming projects or people replaces the "last scanned in" window.
  $('activity-preset').disabled = Boolean(named);
  $('activity-preset').title = named ? 'Named projects and people are fetched whatever their last scan date.' : '';
  $('activity-hint').textContent = named
    ? 'Not used while projects or people are named below: those are fetched whatever their last scan date.'
    : 'Skips projects with no scan in this window.';

  $('detection-hint').textContent = ['7d', '30d'].includes(detection)
    ? `Only findings first seen in the ${presetLabel(detection).toLowerCase()} are counted, so the older age buckets will be empty.`
    : 'Sent to the API as fromDate/toDate, so it is filtered server-side.';
  // The compact scope row shows these as the choices' tooltips.
  if (!named) $('activity-preset').title = $('activity-hint').textContent;
  $('detection-preset').title = $('detection-hint').textContent;
}

// ---------------------------------------------------------------------------
// Scope: fetch only named projects, or the projects named people last scanned
// ---------------------------------------------------------------------------

const scopePick = { projects: new Map(), initiators: new Set(), options: null, loading: null };

/** Project names and latest-scan initiators, for the suggestions (loaded on first use). */
function loadScopeOptions() {
  if (scopePick.options) return Promise.resolve(scopePick.options);
  if (scopePick.loading) return scopePick.loading;
  setScopeHint('Loading project names and who scanned them…');
  scopePick.loading = api('/api/scope/options')
    .then((data) => {
      scopePick.options = data;
      const projectList = $('scope-project-options');
      const peopleList = $('scope-initiator-options');
      projectList.replaceChildren(...data.projects.map((p) => Object.assign(document.createElement('option'), { value: p.name })));
      peopleList.replaceChildren(
        ...data.initiators.map((i) => Object.assign(document.createElement('option'), { value: i.initiator, label: `${i.email ? `${i.email} · ` : ''}${i.projects} project${i.projects === 1 ? '' : 's'}` })),
      );
      setScopeHint(data.warning || `${data.projects.length} projects, ${data.initiators.length} people. Pick as you type; Enter adds every project whose name contains the text.`, data.warning ? 'error' : '');
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
  draw($('scope-projects'), [...scopePick.projects], 'project');
  draw($('scope-initiators'), [...scopePick.initiators].map((who) => [who, who]), 'initiator');
  updateScopeSummary();
  syncNarrow();
}

for (const [inputId, kind] of [['scope-project-input', 'project'], ['scope-initiator-input', 'initiator']]) {
  const input = $(inputId);
  input.addEventListener('focus', () => loadScopeOptions());
  const commit = async () => {
    const value = input.value;
    input.value = '';
    if (kind === 'project') await addScopeProjects(value);
    else addScopeInitiator(value);
    renderScopeChips();
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',' || event.key === 'Tab') {
      if (!input.value.trim()) return;
      event.preventDefault();
      commit();
    } else if (event.key === 'Backspace' && !input.value) {
      const store = kind === 'project' ? scopePick.projects : scopePick.initiators;
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
    const exact = kind === 'project'
      ? scopePick.options.projects.some((p) => p.name.toLowerCase() === value)
      : scopePick.options.initiators.some((i) => i.initiator.toLowerCase() === value);
    if (exact) commit();
  });
}

$('scope-pick').addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-scope]');
  if (!button) return;
  if (button.dataset.removeScope === 'project') scopePick.projects.delete(button.dataset.key);
  else scopePick.initiators.delete(button.dataset.key);
  renderScopeChips();
});

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
  const name = escapeHtml(project.initiator || project.initiatorEmail);
  if (!project.initiatorEmail) {
    return `${name}<span class="err" translate="yes">no email resolved</span>`;
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
const OPTIONAL_COLUMNS = [
  { id: '0-30', group: 'Age', label: '≤ 30d', title: 'Findings first detected 30 days ago or less', value: (p) => p.counts?.['0-30'] ?? 0 },
  { id: '31-60', group: 'Age', label: '31–60d', title: 'Findings first detected 31 to 60 days ago', value: (p) => p.counts?.['31-60'] ?? 0 },
  { id: '60+', group: 'Age', label: '> 60d', title: 'Findings first detected more than 60 days ago', value: (p) => p.counts?.['60+'] ?? 0, alert: true },
  { id: 'unknown', group: 'Age', label: 'No date', title: 'Findings with no first-detection date', value: (p) => p.counts?.unknown ?? 0 },
  { id: 'sev:CRITICAL', group: 'Severity', label: 'Critical', value: (p) => p.bySeverity?.CRITICAL ?? 0, alert: true },
  { id: 'sev:HIGH', group: 'Severity', label: 'High', value: (p) => p.bySeverity?.HIGH ?? 0 },
  { id: 'sev:MEDIUM', group: 'Severity', label: 'Medium', value: (p) => p.bySeverity?.MEDIUM ?? 0 },
  { id: 'sev:LOW', group: 'Severity', label: 'Low', value: (p) => p.bySeverity?.LOW ?? 0 },
  // SLAs (Beta): shown by default to those who may use them, until someone picks their own columns.
  { id: 'sla:overdue', group: 'SLA', label: 'Past SLA', title: 'Open findings past the days their severity has to be fixed (Settings → SLAs)', value: (p) => p.sla?.overdue ?? 0, alert: true, perm: 'feature.sla', byDefault: true },
  { id: 'sla:soon', group: 'SLA', label: 'Due ≤ 7d', title: 'Open findings due within 7 days', value: (p) => p.sla?.dueSoon ?? 0, perm: 'feature.sla' },
];
const COLUMNS_KEY = 'mz-project-columns';
let columnsChosen = false;
const shownColumns = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? 'null');
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

function renderColumnMenu() {
  const active = new Set(activeColumns().map((c) => c.id));
  const groups = [...new Set(availableColumns().map((c) => c.group))];
  $('col-menu').innerHTML = groups
    .map((group) => `<fieldset><legend>${escapeHtml(group)}</legend>${availableColumns().filter((c) => c.group === group)
      .map((c) => `<label class="check"${c.title ? ` title="${escapeHtml(c.title)}"` : ''}><input type="checkbox" data-col="${escapeHtml(c.id)}"${active.has(c.id) ? ' checked' : ''} /> ${escapeHtml(c.label)}</label>`)
      .join('')}</fieldset>`)
    .join('') + '<p class="hint">Kept in this browser.</p>';
}

function renderProjectsHead() {
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
  const header = ['Project', 'Project id', 'Total', ...availableColumns().map((c) => `${c.group}: ${c.label}`), 'Oldest first detection', 'Oldest (days)', 'Latest scan by', 'Initiator email',
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

function renderProjects() {
  const rows = visibleProjects();
  const body = $('projects-body');
  $('export-projects').disabled = !rows.length;
  // A new search, filter or sort starts again at the first page; a fetch filling in keeps it.
  const view = JSON.stringify([$('filter').value.trim().toLowerCase(), $('severity-filter').value, $('bucket-filter').value, $('hide-empty').checked, [...state.pickedInitiators], state.sort]);
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
        return `
        <tr data-id="${escapeHtml(p.projectId)}">
          <td class="checkbox"><input type="checkbox" data-select="${escapeHtml(p.projectId)}" ${
            state.selected.has(p.projectId) ? 'checked' : ''
          } /></td>
          <td class="name" translate="no">${
            p.url
              ? `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.projectName)}</a>`
              : escapeHtml(p.projectName)
          }${p.error ? `<span class="err">${escapeHtml(p.error)}</span>` : ''}</td>
          <td class="num c-count" data-label="Total">${p.totalRisks}</td>
          ${activeColumns().map((c) => {
            const v = c.value(p);
            return `<td class="num c-count ${v > 0 ? (c.alert ? 'aged' : '') : 'zero'}" data-label="${escapeHtml(c.label)}">${v}</td>`;
          }).join('')}
          <td class="c-oldest" data-label="Oldest">${formatDate(p.oldestFirstDetectedAt)}${
            p.maxAgeDays === null ? '' : ` <span class="zero">(${p.maxAgeDays}d)</span>`
          }</td>
          <td class="initiator c-wide" data-label="Latest scan by" translate="no">${renderInitiator(p)}</td>
          ${creditCell(p, 'triage').replace('<td class="', '<td data-label="Triage credits" class="c-half ')}
          ${creditCell(p, 'remediation').replace('<td class="', '<td data-label="Remediation credits" class="c-half ')}
        </tr>${state.creditEditor === p.projectId ? creditEditorRow(p) : ''}`;
      })
      .join('') +
      (shown.length < rows.length
        ? `<tr class="more-rows"><td colspan="${projectColspan()}"><span>Showing ${shown.length} of ${rows.length} projects</span>
            <button type="button" class="sm" data-more-rows="page">Show ${Math.min(ROW_PAGE, rows.length - shown.length)} more</button>
            <button type="button" class="sm link" data-more-rows="all">Show all ${rows.length}</button></td></tr>`
        : '');
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
function sharedResultsHtml(groups, severities, { open = false } = {}) {
  const shown = (groups ?? []).filter((g) => severities.includes(g.severity));
  if (!shown.length) return '';
  const findings = shown.reduce((n, g) => n + g.findings, 0);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  return `<details class="shared-results"${open || shown.length <= 3 ? ' open' : ''}>
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

/** One project's credits, editable: what its severities need, plus extras the administrator sets. */
function creditEditorRow(p) {
  const c = p.credits ?? {};
  const t = c.triage ?? { allocated: 0, used: 0, remaining: 0 };
  const r = c.remediation ?? { allocated: 0, used: 0, remaining: 0 };
  const sev = c.severities ?? [];
  const toTriage = sev.reduce((n, s) => n + (c.toTriage?.[s] ?? 0), 0);
  const toTriageRows = sev.reduce((n, s) => n + (c.toTriageRows?.[s] ?? c.toTriage?.[s] ?? 0), 0);
  const id = escapeHtml(p.projectId);
  return `<tr class="credit-editor" data-editor="${id}"><td colspan="${projectColspan()}">
    <div class="credit-editor-grid">
      <div class="credit-editor-head"><strong>${escapeHtml(p.projectName)}</strong>
        <span class="hint">needs are for ${escapeHtml(sev.map((s) => s.toLowerCase()).join(', ') || 'no severities')} · extra credits come out of the credit pool and stay until you change them</span></div>
      <div class="credit-kind">
        <span class="label">AI Triage</span>
        <span class="need" title="${escapeHtml(`For ${resultsText(toTriage, toTriageRows)}.`)}">${toTriage} needed${toTriageRows > toTriage ? ` <span class="hint">(${toTriageRows} findings = ${toTriage} results)</span>` : ''} ·</span>
        <label class="inline"><input type="number" min="0" step="1" class="small-num" data-extra="triage" value="${c.extraTriage ?? 0}" /> extra</label>
        <span class="hint">${t.remaining} left of ${t.allocated} · ${t.used} used</span>
        ${sharedResultsHtml(c.sharedResults, sev, { open: true })}
      </div>
      <div class="credit-kind">
        <span class="label">AI Remediation</span>
        <span class="need">${(c.toRemediate ?? 0) * 3} needed ·</span>
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
    .join('')}${rest ? `<span class="out-track" style="flex:${rest} 1 0" title="Still open: ${rest}"></span>` : ''}</div>${legend ? `<div class="rp-legend">${Object.entries(OUTCOME_LABELS)
    .map(([key, text]) => `<span><i class="out-${key}"></i>${escapeHtml(text)} <b>${outcomes[key] ?? 0}</b></span>`)
    .join('')}</div>` : ''}`;
}

const trackedById = new Map();
const rpState = { filter: 'all', search: '', sort: 'open', open: '', tab: 'overview', data: null };

/** Open findings at each reading: awaiting triage, confirmed or new. */
const openSeries = (r) => {
  const points = (r.history ?? []).map((h) => ({ at: h.at, open: (h.awaiting ?? 0) + (h.confirmed ?? 0) + (h.newFindings ?? 0) }));
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
  renderPortfolio(reports);
  renderUpcoming(reports);
  renderReportList();
  if (rpState.open) {
    if (trackedById.has(rpState.open)) renderReportDetail(rpState.open);
    else closeReportDetail();
  }
}

function renderPortfolio(reports) {
  const measured = reports.filter((r) => r.latest);
  const sum = (fn) => measured.reduce((n, r) => n + (fn(r) || 0), 0);
  const baseline = sum((r) => r.latest.baseline);
  const actioned = sum((r) => r.latest.actioned);
  const pct = baseline ? Math.round((actioned / baseline) * 100) : 0;
  const scheduled = reports.filter((r) => r.automation?.enabled);
  const next = scheduled.map((r) => r.automation.nextRunAt).filter(Boolean).sort()[0];
  const tile = (label, value, sub, extra = '') => `<div class="rp-tile"><span class="rp-tile-label">${escapeHtml(label)}</span><span class="rp-tile-value">${value}</span>${extra}<span class="rp-tile-sub">${sub}</span></div>`;
  $('rp-portfolio').innerHTML = !reports.length
    ? ''
    : [
        tile('Findings tracked', baseline.toLocaleString(), `across ${reports.length} report${reports.length === 1 ? '' : 's'}`),
        tile('Actioned', `${pct}%`, `${actioned.toLocaleString()} triaged or no longer detected`, `<span class="rp-meter" role="img" aria-label="${pct}% actioned"><span style="width:${pct}%"></span></span>`),
        tile('Open now', sum((r) => r.latest.open).toLocaleString(), 'awaiting triage, confirmed or new'),
        tile('New since saved', sum((r) => r.latest.newFindings).toLocaleString(), 'matching the same filters'),
        tile('Follow-ups scheduled', `${scheduled.length}<small> of ${reports.length}</small>`, next ? `next ${escapeHtml(serverTime(next))}` : 'none due'),
        tile('AI credits used', `${sum((r) => r.latest.aiActions?.triage).toLocaleString()}<small> / ${sum((r) => r.latest.aiActions?.remediation).toLocaleString()}</small>`, 'triage / remediation'),
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
    : `<li class="rp-empty-small">Nothing scheduled. Open a report, then <strong>Schedule</strong>, to send its follow-ups automatically.</li>`;
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
      <p>Choose a scope on the Dashboard (projects, people, time windows), fetch, then <strong>Save as tracked report</strong>.
        Each report keeps the findings it covered and follows what happens to them: triaged, confirmed, not exploitable or no longer detected.</p>
      <a class="button primary" href="#/dashboard">Go to the Dashboard</a></div>`;
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
    ? `<div class="rp-head" aria-hidden="true"><span>Report</span><span>Progress</span><span class="num">Open</span><span class="num">New</span><span>Trend</span><span>Status</span></div>${shown
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
  const kpi = (label, value, sub = '') => `<div class="rp-kpi"><span class="rp-tile-label">${escapeHtml(label)}</span><span class="rp-kpi-value">${value}</span>${sub ? `<span class="rp-tile-sub">${sub}</span>` : ''}</div>`;
  const overview = l
    ? `<div class="rp-hero">
        <div class="rp-hero-number"><span class="rp-big">${l.percentActioned}%</span><span class="rp-sub">actioned · ${l.actioned} of ${l.baseline} findings triaged or no longer detected</span></div>
        ${progressBar(l.outcomes, l.baseline)}
      </div>
      <div class="rp-kpis">
        ${kpi('Open now', l.open ?? 0, 'awaiting, confirmed or new')}
        ${kpi('New since saved', l.newFindings, 'matching the filters')}
        ${kpi('Matching now', l.currentMatching, `was ${l.baseline} when saved`)}
        ${kpi('AI credits used', `${l.aiActions.triage} <small>/ ${l.aiActions.remediation}</small>`, 'triage / remediation')}
      </div>
      ${trendChart(openSeries(r))}
      ${l.byProject?.length ? `<h3 class="rp-h3">By project</h3><div class="table-wrap"><table class="data-table rp-table">
        <thead><tr><th>Project</th><th>Progress</th><th class="num">Open</th><th class="num">Confirmed</th><th class="num">New</th><th class="num">Now</th></tr></thead>
        <tbody>${l.byProject
          .slice()
          .sort((a, b) => b.awaiting + b.confirmed + b.newFindings - (a.awaiting + a.confirmed + a.newFindings))
          .map((p) => `<tr><td>${escapeHtml(p.projectName || p.projectId)}</td>
            <td class="rp-mini">${progressBar({ resolved: p.resolved, notExploitable: p.notExploitable, confirmed: p.confirmed, awaiting: p.awaiting }, p.baseline, { legend: false })}</td>
            <td class="num">${p.awaiting + p.confirmed + p.newFindings}</td><td class="num">${p.confirmed}</td><td class="num">${p.newFindings}</td><td class="num">${p.currentMatching}</td></tr>`)
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
        ${can('reports.manage') ? `<button type="button" class="link danger" data-report-delete="${rid}">Delete</button>` : ''}
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
    <p class="hint">Sends to the people, and with the content, chosen above. Every automatic reminder and follow-up is also listed under <a href="#/settings/automation">Settings → Automation</a>.</p>
    ${manage ? `<div class="actions compact"><button type="button" class="primary" data-schedule="${id}">Save schedule</button></div>` : '<p class="hint">Your role cannot change schedules.</p>'}
    ${reminders.length ? `<h3 class="rp-h3">Sent automatically</h3>${remindersTable(reminders)}` : ''}`;
}

function triageSection(r) {
  const id = escapeHtml(r.id);
  const allowed = can('triage.run') || can('credits.allocate');
  if (!allowed) return '<p class="hint">Your role cannot run AI Triage or allocate credits.</p>';
  return `<p class="rp-lead">Run AI Triage on what is still awaiting triage, and AI Remediation on what it confirmed. The buttons turn gold once the projects have the credits. Allocate credits here: what the ticked severities need, plus any extra.</p>
    <div class="rp-form">
      <div class="rp-field"><span class="rp-label">Severities</span><div class="rp-options">
      ${['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
        .map((sev) => {
          const n = r.latest?.toTriage?.[sev];
          const results = r.latest?.toTriageResults?.[sev] ?? n;
          const count = n === undefined ? '' : results < n ? ` <span class="hint" title="${n} findings are ${results} Checkmarx One results: rows that share one are triaged, and charged, once">(${n} = ${results} results)</span>` : ` <span class="hint">(${n})</span>`;
          return `<label class="check"><input type="checkbox" data-sev="${sev}" data-keep ${['CRITICAL', 'HIGH'].includes(sev) ? 'checked' : ''} /> ${sev[0] + sev.slice(1).toLowerCase()}${count}</label>`;
        })
        .join('')}
      </div></div>
      <div class="rp-field${can('credits.allocate') ? '' : ' perm-hidden'}"><span class="rp-label">Extra credits</span><div class="rp-options alloc-extra">
        <label class="inline">Triage <input type="number" min="0" max="100000" data-field="triageAdd" data-keep class="small-num" placeholder="0" aria-label="Extra triage credits" /></label>
        <label class="inline">Remediation <input type="number" min="0" max="100000" step="3" data-field="remediationAdd" data-keep class="small-num" placeholder="0" aria-label="Extra remediation credits" /></label>
      </div></div>
    </div>
    <p class="rp-need" data-need="${id}">${triageNeedText(r)}</p>
    <div class="actions compact">
      ${can('triage.run') ? `<button type="button" data-report-triage="${id}" class="primary${triageCovered(r) ? ' is-golden' : ''}" data-needs-data>Triage with AI Assist now</button>` : ''}
      ${can('triage.run') ? `<button type="button" data-report-remediate="${id}" class="primary${remediationCovered(r) ? ' is-golden' : ''}" data-needs-data>Remediate with AI Assist now</button>` : ''}
      ${can('credits.allocate') ? `<button type="button" data-report-allocate="${id}" data-needs-data>Allocate credits for triage and remediation</button>` : ''}
    </div>
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
      .join('') || '<p class="hint">No developer with an address: tag their addresses on the Dashboard (People).</p>';
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
function triageNeedText(r, severities = ['CRITICAL', 'HIGH']) {
  const counts = r.latest?.toTriage;
  const c = r.credits?.triage;
  const rows = counts ? severities.reduce((n, sev) => n + (counts[sev] ?? 0), 0) : null;
  const results = counts ? severities.reduce((n, sev) => n + (r.latest?.toTriageResults?.[sev] ?? counts[sev] ?? 0), 0) : null;
  const parts = [];
  if (rows !== null) parts.push(`${resultsText(results, rows)} awaiting triage at these severities (${results} credit${results === 1 ? '' : 's'})`);
  if (c) parts.push(`projects have ${c.remaining} of ${c.allocated} triage credits left (${c.used} used)`);
  const confirmed = toRemediateOf(r, severities);
  if (confirmed) parts.push(`${confirmed} confirmed to remediate (${confirmed * 3} credits)`);
  if (r.credits?.remediation?.allocated) {
    const m = r.credits.remediation;
    parts.push(`remediation ${m.remaining} of ${m.allocated} left`);
  }
  // Each piece in its own span, so each is translated on its own whatever the others say.
  return parts.length ? `${parts.map((part) => `<span>${part}</span>`).join(' · ')}.` : '';
}

/** Confirmed Checkmarx One results still to remediate at these severities. */
const toRemediateOf = (r, severities) => severities.reduce((n, sev) => n + (r.latest?.toRemediate?.[sev] ?? 0), 0);

/** The tracked report's projects have the credits to remediate every confirmed finding at these severities (3 each). */
function remediationCovered(r, severities = ['CRITICAL', 'HIGH']) {
  const n = toRemediateOf(r, severities);
  return n > 0 && (r.credits?.remediation?.remaining ?? 0) >= n * 3;
}

/** The tracked report's projects have the credits to triage everything at these severities. */
function triageCovered(r, severities = ['CRITICAL', 'HIGH']) {
  const counts = r.latest?.toTriage;
  if (!counts) return false;
  const results = severities.reduce((n, sev) => n + (r.latest?.toTriageResults?.[sev] ?? counts[sev] ?? 0), 0);
  return results > 0 && (r.credits?.triage?.remaining ?? 0) >= results;
}

function updateNeed(card) {
  const report = trackedById.get(card.dataset.report);
  const el = card.querySelector('[data-need]');
  if (!report || !el) return;
  const severities = [...card.querySelectorAll('[data-sev]:checked')].map((box) => box.dataset.sev);
  el.innerHTML = triageNeedText(report, severities);
  card.querySelector('[data-report-triage]')?.classList.toggle('is-golden', triageCovered(report, severities));
  card.querySelector('[data-report-remediate]')?.classList.toggle('is-golden', remediationCovered(report, severities));
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
    severities: [...card.querySelectorAll('[data-sev]:checked')].map((box) => box.dataset.sev),
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
      if (!confirm("Allocate credits from the credit pool to this report's projects: what the ticked severities need (1 per Checkmarx One result to triage, 3 per confirmed result to remediate), plus any extra entered?")) return true;
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
      if (!options.severities.length) return followStatus(id, 'Pick at least one severity.', 'error'), true;
      if (!confirm(`Run AI Remediation on this report's confirmed ${options.severities.map((s) => s.toLowerCase()).join(', ')} findings? It uses 3 Checkmarx One credits each.`)) return true;
      followStatus(id, 'Starting AI Remediation…');
      const result = await api(`/api/tracked-reports/${encodeURIComponent(id)}/remediate`, {
        method: 'POST',
        body: JSON.stringify({ severities: options.severities }),
      });
      followStatus(id, spendText(result, 'remediation'), result.failed ? 'error' : 'ok');
      if (result.report) {
        trackedById.set(id, result.report);
        updateNeed(card);
      }
      creditsChanged();
    } else {
      if (!options.severities.length) return followStatus(id, 'Pick at least one severity.', 'error'), true;
      if (!confirm(`Run AI Triage on this report's ${options.severities.map((s) => s.toLowerCase()).join(', ')} findings still awaiting triage? It uses Checkmarx One credits.`)) return true;
      followStatus(id, 'Starting AI Triage…');
      const result = await api(`/api/tracked-reports/${encodeURIComponent(id)}/triage`, {
        method: 'POST',
        body: JSON.stringify({ severities: options.severities }),
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
  const t = allocationTotals(scope, severities);
  // Take back: what the projects in scope were given and have not used, whatever the severities.
  const unused = scope.reduce((n, p) => n + (p.credits?.triage?.remaining ?? 0) + (p.credits?.remediation?.remaining ?? 0), 0);
  $('alloc-reclaim').textContent = unused ? `Take back ${unused} unused credit${unused === 1 ? '' : 's'}` : 'No unused credits to take back';
  $('alloc-reclaim').classList.toggle('is-empty', !unused);
  const verifiedAll = scope.length && scope.every((p) => isVerified(p, severities));
  const rows = scope.reduce((n, p) => n + (isVerified(p, severities) ? p.verified.triage.rows : 0), 0);
  $('alloc-verified').innerHTML = verifiedAll
    ? `<span class="verified-ok">✓ Confirmed twice with Checkmarx One</span> — ${rows} finding row(s) are ${t.toTriage} Checkmarx One result(s): rows that share a result are triaged, and charged, once.`
    : 'Not confirmed with Checkmarx One yet. <b>Refresh &amp; verify</b> re-reads the findings (someone may be working on them) and confirms the credits needed twice; allocating does it too, and refuses if the two reads disagree.';
  $('alloc-scope').textContent = `${scope.length} project${scope.length === 1 ? '' : 's'} ${state.selected.size ? 'selected' : 'shown'}`;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  $('alloc-needed').innerHTML = severities.length
    ? `<b>${plural(t.toTriage, 'Checkmarx One result')}</b> to triage (${plural(t.toTriage, 'credit')})${t.toTriageRows > t.toTriage ? ` <span class="hint">— from ${t.toTriageRows} findings: rows that share one result are triaged, and charged, once</span>` : ''} · <b>${t.triageLeft}</b> allocated and not used${t.triageShort ? ` · <span class="short">${t.triageShort} more needed</span>` : ''}` +
      (t.toTriageRows > t.toTriage ? sharedResultsHtml(scope.flatMap((p) => (p.credits?.sharedResults ?? []).map((g) => ({ ...g, projectName: scope.length > 1 ? p.projectName : '' }))), severities) : '')
    : 'Tick at least one severity.';
  $('remediate-needed').innerHTML = severities.length
    ? `<b>${plural(t.toRemediate, 'confirmed result')}</b> to remediate (${plural(t.toRemediate * 3, 'credit')}, 3 each) · <b>${t.remediationLeft}</b> allocated and not used${t.remediationShort ? ` · <span class="short">${t.remediationShort} more needed</span>` : ''}${t.toRemediate ? '' : ' — triage first: remediation needs findings it confirmed'}`
    : '';
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
async function guardedAction(label, run) {
  if (state.fetching) return setStatus('alloc-status', 'Wait for the data fetch to complete.', 'error');
  const scope = allocationScope();
  if (!scope.length) return setStatus('alloc-status', 'Fetch the projects first.', 'error');
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
    logger.add(`${label} cancelled: ${changes.length} change(s) found by Refresh & verify`, 'error');
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
    <p class="cost-line">This consumes <strong>3 credits for each confirmed vulnerability: ${cost} credit${cost === 1 ? '' : 's'}</strong>, from the remediation credits allocated to these projects${t.remediationShort ? ` — <strong>${t.remediationShort} are not allocated yet</strong>: allocate them first, or those projects are skipped` : ''}.</p>
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
async function restoreLastScan({ force = false } = {}) {
  if ((state.projects.length && !force) || state.fetching || !can('findings.fetch')) return;
  let result;
  try {
    result = await api('/api/scan/last');
  } catch {
    return;
  }
  if (!result?.projects || (state.projects.length && !force) || state.fetching) return;
  restoreScope(result.request, result.projects);
  state.lastScan = result;
  state.projects = result.projects;
  renderTotals(totalsOf(state.projects));
  collectInitiators();
  renderInitiatorList();
  renderProjects();
  renderAllocation();
  const at = new Date(result.fetchedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  $('fetch-meta').textContent = `Showing the data fetched ${at}. Load findings again for the latest.`;
  setStatus('status', `Loaded ${state.projects.length} project(s) as fetched ${at}.`, 'ok');
}

/** Put the scope controls back the way they were for that fetch. */
function restoreScope(request, projects) {
  if (!request) return;
  for (const prefix of ['activity', 'detection']) {
    const select = $(`${prefix}-preset`);
    const preset = request[`${prefix}Preset`];
    if (preset && [...select.options].some((o) => o.value === preset)) select.value = preset;
    $(`${prefix}-from`).value = request[`${prefix}From`] || '';
    $(`${prefix}-to`).value = request[`${prefix}To`] || '';
    toggleRange(prefix);
  }
  const names = new Map(projects.map((p) => [p.projectId, p.projectName]));
  scopePick.projects.clear();
  scopePick.initiators.clear();
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

async function fetchProjects() {
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
    renderTotals(result.totals);
    collectInitiators();
    renderInitiatorList();
    renderProjects();

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

// Search waits for a pause in typing; the drop-downs and the box apply at once.
let filterTimer = null;
$('filter').addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(renderProjects, 150);
});
for (const id of ['severity-filter', 'bucket-filter', 'hide-empty']) {
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

/** Who gets reminders: one choice (Settings: reminders.audience), set here on the Dashboard and used everywhere. */
const AUDIENCE_TEXT = { initiator: 'Each developer (their own projects)', list: 'The fixed list', both: 'Each developer, and the fixed list' };
const audience = () => state.settings?.reminders?.audience ?? 'initiator';
function renderAudience() {
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
    await api('/api/automation/reset', { method: 'POST', body: JSON.stringify({}) });
    await loadAutomation();
    setStatus('auto-message', 'History cleared — the next run reports from scratch.', 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('auto-message', error);
  }
});
$('save-recipients').addEventListener('click', saveInlineRecipients);
for (const id of ['brand-name', 'brand-logo', 'brand-height', 'brand-accent']) {
  $(id).addEventListener('input', renderBrandPreview);
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
$('run-triage').addEventListener('click', () => guardedAction('Triage', runTriageNow));
$('run-remediation').addEventListener('click', () => guardedAction('Remediation', runRemediationNow));
$('alloc-triage').addEventListener('click', () => guardedAction('Allocating for triage', () => allocateNeeded('triage')));
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
    logger.add(`Refresh & verify: ${ok.length} verified, ${failed.length} not`, failed.length ? 'error' : 'success');
    return { ok: failed.length === 0, summary };
  } catch (error) {
    if (!handleAuthLoss(error)) showError('alloc-status', error);
    return { ok: false };
  } finally {
    button.disabled = false;
    renderAllocation();
  }
}
$('alloc-remediation').addEventListener('click', () => guardedAction('Allocating for remediation', () => allocateNeeded('remediation')));
$('track-save').addEventListener('click', saveTrackedReport);
// Reports page: rows and agenda open a report; the detail panel holds every action.
for (const id of ['reports-list', 'rp-upcoming']) {
  $(id).addEventListener('click', (event) => {
    const row = event.target.closest('[data-open-report]');
    if (row) openReportDetail(row.dataset.openReport, row.dataset.tab || 'overview');
  });
}
// Settings → Automation: "Open →" goes to that report, on its Remind tab.
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
  if (event.target.matches('[data-sev]')) updateNeed(card);
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

$('logs-prev').addEventListener('click', () => {
  logPage = Math.max(0, logPage - 1);
  renderLogs();
});
$('logs-next').addEventListener('click', () => {
  logPage += 1;
  renderLogs();
});

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
  $('log-search').addEventListener('input', () => {
    logPage = 0;
    renderLogs();
  });
}

/** The app's own name and logo, in the header and the browser tab. */
/** Changes whenever the icon setting does (no need to match the server's fingerprint: it only busts the cache). */
const iconKey = (url = '') => (url ? `${url.length}${url.slice(-16).replace(/[^\w]/g, '')}` : '');

/** The tab's icon: reloaded when it changes (the server serves the one set in Branding, else MZ0). */
function applyAppIcon(version = '') {
  const link = document.getElementById('app-icon');
  if (link && link.dataset.version !== String(version)) {
    link.dataset.version = String(version);
    link.href = `/app-icon${version ? `?v=${encodeURIComponent(version)}` : ''}`;
  }
}

/** Settings → Branding: what the icon will look like, as typed or uploaded (empty: MZ0). */
function renderIconPreview() {
  const value = $('brand-icon').value.trim();
  $('brand-icon-preview').src = value && (/^data:image\//i.test(value) || /^https:\/\//i.test(value)) ? value : '/favicon.svg';
}

$('brand-icon').addEventListener('input', renderIconPreview);
$('brand-icon-default').addEventListener('click', () => {
  $('brand-icon').value = '';
  $('brand-icon').dispatchEvent(new Event('input', { bubbles: true }));
});
$('brand-icon-file').addEventListener('change', () => {
  const file = $('brand-icon-file').files[0];
  $('brand-icon-file').value = '';
  if (!file) return;
  if (file.size > 100 * 1024) return alert('That image is larger than 100 KB. Please use a smaller icon.');
  const reader = new FileReader();
  reader.onload = () => {
    $('brand-icon').value = reader.result;
    $('brand-icon').dispatchEvent(new Event('input', { bubbles: true }));
  };
  reader.readAsDataURL(file);
});

function applyAppBranding({ name, logoUrl, iconVersion } = {}) {
  if (iconVersion !== undefined) applyAppIcon(iconVersion);
  const appName = name || 'CxMissionZero';
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
    $('brand-logo').dispatchEvent(new Event('input', { bubbles: true }));
  };
  reader.readAsDataURL(file);
});

// ---------------------------------------------------------------------------
// Workspace: getting started, the action rail's scope line, narrowing the
// scope, the preview sheet, Settings → About, and Jump to (Ctrl K).
// ---------------------------------------------------------------------------

/** What the rail's actions apply to: the selected projects, or every one shown. */
function renderRailScope() {
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
function openRail(tab) {
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
function syncNarrow(open) {
  const chips = scopePick.projects.size + scopePick.initiators.size;
  const show = open ?? (chips > 0 || $('narrow-toggle').getAttribute('aria-expanded') === 'true');
  $('scope-pick').classList.toggle('folded', !show);
  $('narrow-toggle').setAttribute('aria-expanded', String(show));
  $('narrow-toggle').textContent = show ? (chips ? `Narrowed to ${chips} name${chips === 1 ? '' : 's'}` : 'Hide narrowing') : 'Narrow to projects or people';
}
$('narrow-toggle').addEventListener('click', () => {
  const open = $('narrow-toggle').getAttribute('aria-expanded') !== 'true';
  syncNarrow(open);
  if (open) $('scope-project-input').focus();
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

function renderAbout() {
  $('about-version').textContent = state.health?.version || '—';
  const t = state.me?.terms;
  $('about-terms-state').textContent = t ? `Version ${t.version}${t.accepted ? ' — accepted by you' : ''}${t.organisationAccepted ? ', and for the organisation' : ''}` : '—';
  $('about-org').textContent = state.me?.organisationName || 'Not given yet';
  if (document.activeElement !== $('about-org-input')) $('about-org-input').value = state.me?.organisationName ?? '';
}
$('about-org-save').addEventListener('click', async () => {
  try {
    const { organisationName } = await api('/api/organisation-name', { method: 'PUT', body: JSON.stringify({ name: $('about-org-input').value }) });
    state.me = { ...state.me, organisationName };
    renderAbout();
    calculator.renderOrg();
    setStatus('about-org-status', 'Saved.', 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('about-org-status', error);
  }
});

// ---- Settings → Update & recovery (Admin) -----------------------------------

const mzVersion = (v) => (v === 'built-in' ? 'the image’s own' : `MZ-${String(v).split('.').map((n) => n.padStart(2, '0')).join('.')}`);
let updState = null;
let updPoll = null;
/** Every version: the newest 3 at first, then 10 more per click. */
const UPD_PAGE = 10;
let updShown = 3;

async function loadUpdates() {
  if (!can('system.update')) return;
  try {
    updState = await api('/api/system/update');
    renderUpdates();
    // What the page shows is never an old answer: a check older than 10 minutes is made again.
    const age = updState.lastCheck ? Date.now() - Date.parse(updState.lastCheck.at) : Infinity;
    if (age > 10 * 60_000 && !['running', 'switching'].includes(updState.job?.state)) {
      $('upd-latest-sub').textContent = 'Checking the registry…';
      updState = await api('/api/system/update/check', { method: 'POST', body: '{}', quiet: true });
      renderUpdates();
    }
  } catch (error) {
    if (!handleAuthLoss(error)) $('upd-status').textContent = error.message;
  }
}

function renderUpdates() {
  const s = updState;
  if (!s) return;
  $('upd-running').textContent = mzVersion(s.running.version);
  $('upd-running-sub').textContent = s.running.source === 'update' ? 'Installed from this page' : `The image’s own version${s.builtIn !== s.running.version ? '' : ''}`;
  const latest = s.latest;
  $('upd-latest').textContent = latest ? mzVersion(latest.version) : '—';
  $('upd-latest-sub').textContent = s.lastCheck
    ? s.lastCheck.error
      ? `Check failed: ${s.lastCheck.error}`
      : `${s.updateAvailable ? 'Newer than what runs. ' : 'Up to date. '}Checked ${new Date(s.lastCheck.at).toLocaleString()}${s.lastCheck.warning ? ' · see the note below' : ''}`
    : 'Not checked yet';
  $('upd-latest-card').classList.toggle('upd-new', Boolean(s.updateAvailable));
  const install = $('upd-install-latest');
  install.hidden = !s.updateAvailable || !s.supervised;
  install.textContent = latest ? `Update now to ${mzVersion(latest.version)}` : 'Update now';
  const hour = $('upd-hour');
  if (hour.options.length === 1) for (let h = 0; h < 24; h += 1) hour.append(new Option(`${String(h).padStart(2, '0')}:00`, String(h)));
  $('upd-auto').checked = s.settings.auto;
  if (s.serverTime) {
    const clock = `${String(s.serverTime.hour).padStart(2, '0')}:${String(s.serverTime.minute).padStart(2, '0')}`;
    $('upd-zone').textContent = `(server time${s.serverTime.zone ? `, ${s.serverTime.zone}` : ''}: now ${clock})`;
  }
  hour.value = s.settings.windowHour === null ? '' : String(s.settings.windowHour);
  $('upd-auto-sub').textContent = s.settings.auto
    ? `Checked every 15 minutes${s.settings.windowHour === null ? '' : `, installed only at ${String(s.settings.windowHour).padStart(2, '0')}:00`}. A version that failed to start is never installed again by itself.${s.settings.lastAutoResult ? ` Last: ${s.settings.lastAutoResult}.` : ''}`
    : 'Off: you install updates here.';
  // What the check could not do (a blocked download host, older builds not named), in full, under the cards.
  const note = $('upd-check-note');
  note.hidden = !s.lastCheck?.warning;
  note.textContent = s.lastCheck?.warning ?? '';
  const warn = $('upd-warn');
  warn.hidden = s.supervised;
  warn.className = 'status warn';
  warn.textContent = s.supervised ? '' : 'This server was started with a custom command, so it cannot switch versions itself. Start the image with its own start command (no command after the image name) to update from here; until then, update with podman pull.';
  for (const id of ['upd-install-latest', 'upd-restart']) $(id).disabled = !s.supervised || ['running', 'switching'].includes(s.job?.state);

  const job = $('upd-job');
  job.hidden = !s.job;
  if (s.job) {
    const j = s.job;
    job.className = `upd-job ${j.state}`;
    job.textContent = j.state === 'failed' ? `Update to ${j.ref} failed: ${j.error}` : j.state === 'done' ? `MZ-${j.version} installed.` : `${j.step}${j.downloaded ? ` · ${Math.round(j.downloaded / 1024)} KB checked` : ''}…`;
  }
  const news = $('upd-news');
  news.innerHTML = s.job?.whatsNew?.length
    ? `<h3>What's new</h3>${s.job.whatsNew.map((n) => `<p><b>${escapeHtml(mzVersion(n.version))}</b> ${n.highlights.map(escapeHtml).join(' · ')}</p>`).join('')}`
    : '';

  const installed = new Map(s.installed.map((v) => [v.version, v]));
  const failed = new Set(s.failed);
  const rows = new Map((s.lastCheck?.versions ?? []).map((v) => [v.version, v]));
  for (const v of s.installed) if (!rows.has(v.version)) rows.set(v.version, { version: v.version, created: v.created, tags: [v.tag], local: true });
  const sorted = [...rows.values()].sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  // The newest 3, then 10 more at a time; what runs here is always shown.
  const runningHere = (v) => s.running.source === 'update' && v.version === s.running.version;
  const visible = sorted.filter((v, i) => i < updShown || runningHere(v));
  const busy = ['running', 'switching'].includes(s.job?.state);
  const button = (label, attrs, primary = false) => `<button type="button" class="${primary ? 'primary ' : ''}small" ${attrs} ${busy || !s.supervised ? 'disabled' : ''}>${label}</button>`;
  const body = visible.map((v) => {
    // The image's own version has its own row below: a published row of the same version points there.
    const inImage = v.version === s.builtIn && !installed.has(v.version);
    const running = s.running.source === 'update' && v.version === s.running.version && installed.has(v.version);
    const here = running ? '<span class="rp-chip tone-good">Running</span>' : installed.has(v.version) ? 'Installed' : inImage ? 'In the image (below)' : '';
    const flag = failed.has(v.version) ? ' <span class="rp-chip tone-critical" title="It did not start, and was rolled back by itself">Failed to start</span>' : '';
    const ref = (v.tags ?? []).find((t) => /^\d+\.\d+\.\d+$/.test(t)) ?? v.tags?.[0] ?? v.digest;
    const action = running || inImage ? '' : installed.has(v.version) ? button('Switch to', `data-upd-switch="${escapeHtml(v.version)}"`) : ref ? button('Install and switch', `data-upd-install="${escapeHtml(ref)}"`, v === sorted[0] && s.updateAvailable) : '';
    return `<tr><td>${escapeHtml(mzVersion(v.version))}${flag}</td><td>${v.created ? escapeHtml(new Date(v.created).toLocaleDateString()) : ''}</td><td>${here}</td><td>${action}</td></tr>`;
  });
  const imageRunning = s.running.source === 'image';
  body.push(`<tr><td>${escapeHtml(mzVersion(s.builtIn))} <span class="hint">(the image’s own)</span></td><td></td><td>${imageRunning ? '<span class="rp-chip tone-good">Running</span>' : 'In the image'}</td><td>${imageRunning ? '' : button('Switch to', 'data-upd-switch="built-in"')}</td></tr>`);
  $('upd-versions').querySelector('tbody').innerHTML = body.join('');
  const hidden = sorted.length - visible.length;
  const more = $('upd-more');
  more.hidden = hidden <= 0;
  more.textContent = `Load ${Math.min(UPD_PAGE, hidden)} more`;
  $('upd-count').textContent = sorted.length ? `${visible.length} of ${sorted.length} published version${sorted.length === 1 ? '' : 's'}` : '';

  const label = { started: 'Started', switch: 'Switch', restart: 'Restart', rollback: 'Rolled back', crash: 'Stopped unexpectedly' };
  $('upd-events').innerHTML = s.events.length
    ? s.events
        .slice(0, 12)
        .map((e) => `<li><span class="hint">${escapeHtml(new Date(e.at).toLocaleString())}</span> <b>${escapeHtml(label[e.type] ?? e.type)}</b> ${escapeHtml(
          e.type === 'rollback' ? `${mzVersion(e.from)} → ${mzVersion(e.to)}: ${e.reason ?? ''}` : e.type === 'started' ? `${mzVersion(e.version)} came up in ${Math.round((e.ms ?? 0) / 1000)} s` : e.type === 'crash' ? `${mzVersion(e.version)} (code ${e.code ?? e.signal})` : `${e.from ? mzVersion(e.from) : ''}${e.to ? ` → ${mzVersion(e.to)}` : ''}${e.by ? ` by ${e.by}` : ''}`,
        )}</li>`)
        .join('')
    : '<li class="hint">Nothing yet.</li>';

  renderFullUpdate(s, sorted);

  clearTimeout(updPoll);
  if (busy || s.companion?.busy) updPoll = setTimeout(followUpdate, 2000);
}

const FULL_STATES = { running: 'Under way', done: 'Done', unchanged: 'Nothing to change', 'rolled-back': 'Went back to the previous container', failed: 'Failed', refused: 'Refused' };

/** The update companion (Beta): is it running, the image to replace with, and the last full update. */
function renderFullUpdate(s, versions) {
  const c = s.companion ?? {};
  const chip = $('upd-full-chip');
  const engineProblem = c.connected && c.heartbeat?.engineError;
  chip.textContent = !c.connected ? 'Companion not running' : engineProblem ? 'Companion: needs attention' : c.busy ? 'Replacing the image…' : 'Companion ready';
  chip.className = `rp-chip ${!c.connected ? '' : engineProblem ? 'tone-critical' : 'tone-good'}`;
  $('upd-full-on').hidden = !c.connected;
  $('upd-full-off').hidden = Boolean(c.connected);
  if (c.busy) $('upd-full').open = true;
  const select = $('upd-full-tag');
  const wanted = versions.map((v) => (v.tags ?? []).find((t) => /^\d+\.\d+\.\d+$/.test(t))).filter(Boolean);
  const current = select.value;
  select.innerHTML = ['latest', ...wanted].map((t) => `<option value="${escapeHtml(t)}">${t === 'latest' ? 'latest' : escapeHtml(mzVersion(t))}</option>`).join('');
  if (current && [...select.options].some((o) => o.value === current)) select.value = current;
  $('upd-full-go').disabled = !c.connected || c.busy || Boolean(engineProblem);
  const st = c.status;
  const lines = [];
  if (engineProblem) lines.push(`The companion cannot work: ${c.heartbeat.engineError}`);
  if (c.pending) lines.push(`Asked for ${c.pending.tag}: the companion picks it up within a few seconds.`);
  // While a new request waits, the last update's outcome is not news.
  if (st && !c.pending) {
    const when = st.finishedAt || st.at;
    lines.push(`${FULL_STATES[st.state] ?? st.state}: ${st.tag}${st.step ? ` · ${st.step}` : ''}${st.error ? ` · ${st.error}` : ''}${st.reason ? ` · ${st.reason}` : ''}${when ? ` (${new Date(when).toLocaleString()})` : ''}`);
  }
  $('upd-full-status').textContent = lines.join(' ');
}

$('upd-full-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('upd-full-cmd').textContent.trim());
    toast('Copied: run it on the server.');
  } catch {
    toast('Select the command and copy it.');
  }
});
$('upd-full-go').addEventListener('click', () => {
  const tag = $('upd-full-tag').value;
  if (!tag || !confirm(`Replace the whole image with ${tag === 'latest' ? 'the latest one' : mzVersion(tag)}? A backup is taken first. The server stops for the switch (people see "reconnecting…" for up to a minute), and if the new container does not start, the companion goes back to this one.`)) return;
  $('upd-full-status').textContent = 'Asking the companion…';
  api('/api/system/update/full', { method: 'POST', body: JSON.stringify({ tag }) })
    .then((status) => {
      updState = status;
      renderUpdates();
      updPoll = setTimeout(followUpdate, 3000);
    })
    .catch((error) => !handleAuthLoss(error) && ($('upd-full-status').textContent = error.message));
});

/** While an update or switch runs: follow it, through the restart, to the new version. */
async function followUpdate() {
  const before = updState?.running.version;
  try {
    updState = await api('/api/system/update');
    renderUpdates();
    if (updState.running.version !== before) {
      $('upd-status').textContent = `Now running ${mzVersion(updState.running.version)}: reloading the page for its new screens…`;
      // The new version's own pages and scripts.
      setTimeout(() => location.reload(), 1500);
    }
  } catch {
    $('upd-status').textContent = 'Restarting: reconnecting in a few seconds…';
    updPoll = setTimeout(followUpdate, 2000);
  }
}

async function updateAction(path, body, message) {
  $('upd-status').textContent = message;
  try {
    updState = await api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
    renderUpdates();
    if (!updState?.job || updState.job.state === 'failed') loadUpdates();
    else updPoll = setTimeout(followUpdate, 1500);
  } catch (error) {
    if (!handleAuthLoss(error)) $('upd-status').textContent = error.message;
  }
}

$('upd-more').addEventListener('click', () => {
  updShown += UPD_PAGE;
  renderUpdates();
});
$('upd-check').addEventListener('click', () => updateAction('/api/system/update/check', {}, 'Checking the registry for published versions…').then(() => ($('upd-status').textContent = updState?.lastCheck?.error ? `Check failed: ${updState.lastCheck.error}` : `Checked: ${updState?.lastCheck?.versions?.length ?? 0} versions published${updState?.updateAvailable ? `, the newest is ${mzVersion(updState.latest.version)}` : ', nothing newer than what runs'}.`)));
$('upd-install-latest').addEventListener('click', () => {
  const latest = updState?.latest;
  if (!latest || !confirm(`Update to ${mzVersion(latest.version)}? A backup is taken first. People see "reconnecting…" for a few seconds, and if it does not start, the current version comes back by itself.`)) return;
  updateAction('/api/system/update/install', { ref: latest.tags.find((t) => /^\d+\.\d+\.\d+$/.test(t)) ?? latest.tags[0] }, 'Downloading the update…');
});
$('upd-restart').addEventListener('click', () => {
  if (!confirm('Restart the server? Work in progress finishes first; people see "reconnecting…" for a few seconds.')) return;
  api('/api/system/update/restart', { method: 'POST', body: '{}' })
    .then(() => {
      $('upd-status').textContent = 'Restarting…';
      updPoll = setTimeout(followUpdate, 2500);
    })
    .catch((error) => !handleAuthLoss(error) && ($('upd-status').textContent = error.message));
});
$('upd-versions').addEventListener('click', (event) => {
  const install = event.target.closest('[data-upd-install]');
  const sw = event.target.closest('[data-upd-switch]');
  if (install) {
    if (!confirm(`Install ${install.closest('tr').cells[0].textContent.trim()} and switch to it? A backup is taken first; if it does not start, the current version comes back by itself.`)) return;
    updateAction('/api/system/update/install', { ref: install.dataset.updInstall }, 'Downloading…');
  } else if (sw) {
    const target = mzVersion(sw.dataset.updSwitch);
    if (!confirm(`Switch to ${target}? A backup is taken first. Going back to an older version can leave newer data it does not know about.`)) return;
    updateAction('/api/system/update/switch', { version: sw.dataset.updSwitch }, `Switching to ${target}…`);
  }
});
const saveAutoUpdate = () =>
  api('/api/system/update/settings', { method: 'PUT', body: JSON.stringify({ auto: $('upd-auto').checked, windowHour: $('upd-hour').value === '' ? null : Number($('upd-hour').value) }) })
    .then((status) => {
      updState = status;
      renderUpdates();
      $('upd-status').textContent = status.settings.auto ? 'Auto-update on.' : 'Auto-update off.';
    })
    .catch((error) => !handleAuthLoss(error) && ($('upd-status').textContent = error.message));
$('upd-auto').addEventListener('change', saveAutoUpdate);
$('upd-hour').addEventListener('change', saveAutoUpdate);

// ---- Getting started: the few things that make CxMissionZero useful -------

const GS_KEY = 'mz-gs-hidden';

async function renderGettingStarted() {
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
  steps.push({ stage: 'act', done: state.projects.length > 0, title: 'Fetch vulnerabilities', text: 'Choose a scope and fetch: ageing findings and who ran each scan.', href: '#/dashboard', action: 'Fetch', fetch: true });
  if (can('integration.smtp')) steps.push({ stage: 'setup', done: smtp, title: 'Set up email', text: 'Test your mail server so reminders and follow-ups can go out.', href: '#/settings/smtp', action: 'Set up' });
  if (can('settings.links')) steps.push({ stage: 'setup', done: server, title: 'Give reports a reachable address', text: 'So readers can triage and remediate straight from the emailed report.', href: '#/settings/server', action: 'Set address' });
  if (can('credits.limit')) steps.push({ stage: 'prove', done: Boolean(state.settings?.aiTriage?.monthlyCreditLimit), title: 'Cap AI credits', text: 'A credit pool limits what AI Triage and Remediation may spend.', href: '#/settings/ai', action: 'Set pool' });
  if (can('iam.manage')) {
    let people = 2;
    try {
      people = (access.data ?? (await api('/api/iam', { quiet: true }))).users.length;
    } catch {}
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
function applySupportChannel() {
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

async function loadHelp() {
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
function helpRoute(view) {
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

// ---- Cx Credits Calculator (public/calculator/page.js) ----
const calculator = initCalculator({ api, $, esc: escapeHtml, toast, setStatus, showError, handleAuthLoss, fmtDateTime, me: () => state.me, can });

/** A page outside the four stages: Get help, or a tool. */
const paletteGroup = (page) => STAGE_LABELS[STAGES[page]] ?? (page === 'help' ? 'Help' : 'Tools');

function paletteEntries() {
  const entries = [];
  const pageOk = (page) => (!PAGE_PERMS[page] || canAny(PAGE_PERMS[page])) && (page !== 'calculator' || Boolean(state.me?.unlocked?.calculator));
  for (const [page, [title, sub]] of Object.entries(PAGE_TITLES)) {
    if (page === 'connect' || !pageOk(page)) continue;
    entries.push({ label: title, hint: sub, group: paletteGroup(page), stage: STAGES[page], href: `#/${page}` });
  }
  for (const bar of document.querySelectorAll('[data-ptabs]')) {
    const page = Object.keys(PAGE_TABS).find((p) => PAGE_TABS[p] === bar.dataset.ptabs);
    if (!page || !pageOk(page)) continue;
    for (const tab of tabsOf(bar.dataset.ptabs).filter(usableTab)) {
      const label = tab.childNodes[0]?.textContent.trim() || tab.textContent.trim();
      entries.push({ label: `${PAGE_TITLES[page][0]} → ${label}`, group: paletteGroup(page), stage: STAGES[page], href: page === 'dashboard' ? null : `#/${page}/${tab.dataset.pt}`, tab: page === 'dashboard' ? tab.dataset.pt : null });
    }
  }
  if (pageOk('settings')) {
    for (const a of document.querySelectorAll('#set-nav [data-set]')) {
      if (a.classList.contains('perm-hidden') || a.classList.contains('no-settings') || a.classList.contains('addon-hidden')) continue;
      entries.push({ label: `Settings → ${a.textContent.trim()}`, group: STAGE_LABELS.setup, stage: 'setup', href: a.getAttribute('href') });
    }
  }
  if (can('findings.fetch')) entries.push({ label: 'Load findings', group: 'Action', run: () => $('fetch').click() });
  entries.push({ label: 'Submit a support case', group: 'Help', href: '#/help/case' });
  entries.push({ label: 'Request an enhancement', group: 'Help', href: '#/help/enhancement' });
  entries.push({ label: 'Switch theme', group: 'Action', run: () => $('theme-toggle').click() });
  entries.push({ label: 'Read the terms of use', group: 'Action', run: () => showTermsOverlay({ mode: 'view' }) });
  entries.push({ label: 'Refresh — start over', group: 'Action', run: () => $('app-refresh').click() });
  return entries;
}

const palette = { entries: [], shown: [], index: 0 };

function openPalette() {
  if (!state.me) return;
  palette.entries = paletteEntries();
  $('palette-q').value = '';
  renderPalette();
  $('palette').showModal();
  $('palette-q').focus();
}

function renderPalette() {
  const q = $('palette-q').value.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  palette.shown = palette.entries.filter((e) => words.every((w) => `${e.label} ${e.hint ?? ''} ${e.group}`.toLowerCase().includes(w))).slice(0, 40);
  palette.index = Math.min(palette.index, Math.max(0, palette.shown.length - 1));
  if (!q) palette.index = 0;
  $('palette-list').innerHTML = palette.shown.length
    ? palette.shown
        .map((e, i) => `<li role="option" id="pal-${i}" aria-selected="${i === palette.index}" data-pal="${i}" class="${i === palette.index ? 'on' : ''}"><span class="pal-label">${escapeHtml(e.label)}</span><span class="pal-group" data-stage="${escapeHtml(e.stage || '')}" data-i18n-ctx="stage">${escapeHtml(e.group || '')}</span></li>`)
        .join('')
    : '<li class="pal-none">Nothing matches.</li>';
  $('palette-q').setAttribute('aria-activedescendant', palette.shown.length ? `pal-${palette.index}` : '');
  $(`pal-${palette.index}`)?.scrollIntoView({ block: 'nearest' });
}

function runPalette(i) {
  const entry = palette.shown[i];
  if (!entry) return;
  $('palette').close();
  if (entry.run) return entry.run();
  if (entry.tab) {
    if (state.page !== 'dashboard') location.hash = '#/dashboard';
    openRail(entry.tab);
    return;
  }
  if (location.hash === entry.href) route();
  else location.hash = entry.href;
}

$('palette-open').addEventListener('click', openPalette);
$('palette-q').addEventListener('input', () => {
  palette.index = 0;
  renderPalette();
});
$('palette-q').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const n = palette.shown.length;
    if (n) palette.index = (palette.index + (event.key === 'ArrowDown' ? 1 : -1) + n) % n;
    renderPalette();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    runPalette(palette.index);
  }
});
$('palette-list').addEventListener('click', (event) => {
  const item = event.target.closest('[data-pal]');
  if (item) runPalette(Number(item.dataset.pal));
});
$('palette').addEventListener('click', (event) => {
  if (event.target === $('palette')) $('palette').close();
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && state.me) {
    event.preventDefault();
    if ($('palette').open) $('palette').close();
    else openPalette();
  }
});

(async function init() {
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
    // Last week by default: quick on a large tenant; widen it when you need more.
    fillPresets('activity-preset', '7d');
    fillPresets('detection-preset', '7d');
    updateScopeSummary();
  } catch {
    /* health is advisory only */
  }

  try {
    const session = await api('/api/session');
    if (session.signedIn) await afterSignIn(session);
    else {
      showSignIn({ setup: session.setup });
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

/** Which projects "Find code authors" covers: the Dashboard's selection, or all it shows. */
function renderBetaScope() {
  const scope = allocationScope();
  $('authors-scope').textContent = state.projects.length
    ? `${scope.length} project${scope.length === 1 ? '' : 's'} ${state.selected.size ? 'selected' : 'shown'} on the Dashboard`
    : 'Load findings on the Dashboard first';
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
    if (!logins.length) return setStatus('gh-status', 'No usernames among the developers: load findings on the Dashboard, or type them in.', 'error');
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

function renderAuditRows() {
  if (!audit.entries.length) {
    $('audit-body').innerHTML = '<tr><td colspan="9" class="hint">No audit entries match these filters.</td></tr>';
  } else {
    const pages = Math.max(1, Math.ceil(audit.entries.length / AUDIT_PAGE));
    audit.page = Math.min(audit.page ?? 0, pages - 1);
    const first = audit.page * AUDIT_PAGE;
    $('audit-body').innerHTML = audit.entries
      .slice(first, first + AUDIT_PAGE)
      .map((e, n) => {
        const i = first + n;
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
  const pages = Math.max(1, Math.ceil(audit.entries.length / AUDIT_PAGE));
  const first = (audit.page ?? 0) * AUDIT_PAGE;
  $('audit-more').hidden = true;
  $('audit-prev').disabled = !audit.page;
  $('audit-next').disabled = audit.page >= pages - 1 && !audit.more;
  $('audit-page').textContent = audit.entries.length ? `Page ${audit.page + 1}${audit.more ? '' : ` of ${pages}`}` : '';
  $('audit-count').textContent = audit.entries.length
    ? `Entries ${(first + 1).toLocaleString()}–${Math.min(first + AUDIT_PAGE, audit.entries.length).toLocaleString()}${audit.more ? ', newest first' : ` of ${audit.entries.length.toLocaleString()}, newest first`}`
    : '';
}

$('audit-prev').addEventListener('click', () => {
  audit.page = Math.max(0, (audit.page ?? 0) - 1);
  renderAuditRows();
  $('audit-body').closest('.panel').scrollIntoView({ block: 'nearest' });
});
$('audit-next').addEventListener('click', async () => {
  const next = (audit.page ?? 0) + 1;
  if (next * AUDIT_PAGE >= audit.entries.length && audit.more) await loadAudit({ append: true });
  audit.page = Math.min(next, Math.max(0, Math.ceil(audit.entries.length / AUDIT_PAGE) - 1));
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
  if (state.page === 'dashboard') renderGettingStarted();
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
    ? `Reports will point readers to <code>${escapeHtml(info.url || 'no address')}</code>: ${escapeHtml(info.warnings[0])} <a href="#/settings/server">Set the address</a>`
    : '';
}

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
  // Connect & store verifies right away: the typed key need not also be saved as a draft.
  clearTimeout(autosave.draft);
  autosave.draft = null;
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
    loadAutomation();
    loadConnectionGuard();
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
    loadAutomation();
    loadConnectionGuard();
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

  const roleFilter = $('iam-role-filter');
  const chosenRole = roleFilter.value;
  roleFilter.innerHTML = `<option value="">All roles</option>${roles.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}</option>`).join('')}`;
  roleFilter.value = roles.some((r) => r.id === chosenRole) ? chosenRole : '';
  $('iam-people-count').textContent = String(users.length);
  $('iam-roles-count').textContent = String(roles.length);
  const shown = users.filter(iamUserMatches);
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
        <td><div class="row-actions">${actions}${tenantPick}</div></td>
      </tr>`;
    })
    .join('');
  renderMatrix();
}

const IAM_PAGE = 20;

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
      const q = $('iam-perm-search').value.trim().toLowerCase();
      const inGroup = permissions.filter((p) => p.group === group && (!q || `${p.label} ${p.description} ${p.id}`.toLowerCase().includes(q)));
      if (!inGroup.length) return '';
      const folded = collapsedGroups.has(group) && !q;
      const granted = roles.map((r) => inGroup.filter((p) => valueOf(r, p.id)).length);
      const rows = folded ? '' : inGroup
        .map((p) => `<tr><td><span class="perm-label">${escapeHtml(p.label)}${p.special ? ' <span class="badge warn">Admin</span>' : ''}</span><small class="perm-desc">${escapeHtml(p.description)}</small></td>${roles
          .map((r) => {
            const editable = r.canManage && mine.has(p.id);
            const checked = valueOf(r, p.id);
            return `<td class="cell"><input type="checkbox" data-matrix-role="${escapeHtml(r.id)}" data-matrix-perm="${escapeHtml(p.id)}" ${checked ? 'checked' : ''} ${editable ? '' : 'disabled'} aria-label="${escapeHtml(r.name)}: ${escapeHtml(p.label)}" /></td>`;
          })
          .join('')}</tr>`)
        .join('');
      return `<tbody><tr class="group-row${folded ? ' folded' : ''}"><th><button type="button" class="group-toggle" data-iam-group="${escapeHtml(group)}" aria-expanded="${!folded}">${escapeHtml(group)} <span class="muted">${inGroup.length}</span></button></th>${granted
        .map((n) => `<td class="cell group-sum"><span class="muted">${n}/${inGroup.length}</span></td>`)
        .join('')}</tr>${rows}</tbody>`;
    })
    .join('');
  $('iam-matrix').innerHTML = head + (body || `<tbody><tr><td colspan="${roles.length + 1}" class="hint">No permission matches.</td></tr></tbody>`);
  $('iam-groups-toggle').textContent = collapsedGroups.size >= groups.length ? 'Expand all' : 'Collapse all';
  $('iam-matrix-actions').hidden = access.edits.size === 0;
}

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
  const id = button.dataset.iamReset || button.dataset.iamIds || button.dataset.iamToggle || button.dataset.iamDelete || button.dataset.iamTenants;
  const user = access.data.users.find((u) => u.id === id);
  if (!user) return;
  if (button.dataset.iamTenants) {
    const tenants = [...button.closest('.tn-pop').querySelectorAll('input:checked')].map((input) => input.value);
    if (!tenants.length) return setStatus('iam-status', 'Choose at least one tenant.', 'error');
    iamCall(`/api/iam/users/${id}/tenants`, { method: 'PUT', body: JSON.stringify({ tenants }) }, 'Saved.');
  } else if (button.dataset.iamReset) {
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

// ---------------------------------------------------------------------------
// Credits page: the pool, usage over time, by project, allocated vs used
// ---------------------------------------------------------------------------

const USAGE_REFRESH_MS = 30_000;
let usageTimer = null;
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

async function loadUsage() {
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
    $('credit-allocations').innerHTML = `<p class="hint">${all.length ? 'No project matches.' : mayTakeBack ? 'No project has an allocation yet — give credits above, or on the Dashboard.' : 'No project has an allocation yet.'}</p>`;
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
      .map((p) => `<tr>${mayPick ? `<td class="alloc-pick"><input type="checkbox" data-spend-pick="${escapeHtml(p.projectId)}" aria-label="Pick" ${spend.picked.has(p.projectId) ? 'checked' : ''} /></td>` : ''}<td><span translate="no">${escapeHtml(p.projectName || p.projectId)}</span><div class="hint">${allocationRule(p)}</div></td>${cells(p.triage)}${cells(p.remediation)}${mayTakeBack ? `<td class="alloc-actions"><button type="button" class="sm" data-give="${escapeHtml(p.projectId)}" title="Give this project more credits">Give</button>${unusedOf(p) ? `<button type="button" class="sm danger-soft" data-reclaim="${escapeHtml(p.projectId)}" title="Take back the ${unusedOf(p)} credit(s) this project has not used">Take back ${fmt(unusedOf(p))}</button>` : ''}</td>` : ''}</tr>`)
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
const priceOf = (n, currency) => `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${currency}`;
const cashOf = (n, currency) => (n === null || n === undefined ? '—' : `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency}`);

async function loadImpact() {
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
    ? 'No readings yet. Figures start with the next Dashboard fetch (with no date window) or tracked report refresh.'
    : `Readings start on ${d.since.slice(0, 10)}: the period before that is not included.`;
  const tile = (label, value, sub, hero = false, tone = '') => `<div class="impact-tile${hero ? ' hero' : ''}"><span class="label">${label}</span><span class="value${tone ? ` ${tone}` : ''}">${value}</span><span class="sub">${sub}</span></div>`;
  const debt = d.debt;
  $('impact-tiles').innerHTML = [
    tile('Hours saved', `${num1(d.hours.total)} h`, `<span>${num1(d.hours.triage)} h triage</span> · <span>${num1(d.hours.fix)} h fixing</span>`, true),
    m.value === null
      ? tile('Value of that time', '—', `<a href="#/settings/ai">Set an hourly cost</a>`)
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
    m.value === null ? 'Money: set an hourly cost and the price of one credit under Settings → AI & credits.' : 'Money: hours saved × the hourly cost, less the credits used × the price of one credit (both under Settings → AI & credits).',
    'Security debt: open Checkmarx One results weighted by severity (critical 10, high 5, medium 2, low 1). The date it reaches zero follows the last four weeks.',
    'Time to fix: days from first detection until Checkmarx One no longer reports it. AI-fixed and fixed by hand are compared over the same period.',
  ].map((line) => `<li>${line}</li>`).join('');
  renderImpactProjects();
  const state = $('impact-monthly-state');
  if (state) {
    // Each sentence its own piece, so each is translated whole.
    state.innerHTML = d.monthlyOn
      ? `<span>On: emailed on the first day of each month, for the month before.</span> <span>Recipients: ${(d.monthlyTo ?? []).length}.</span>${d.lastSent ? ` <span>Last sent: ${escapeHtml(d.lastSent)}.</span>` : ''}`
      : '<span>Off: add who gets it under Settings → AI & credits.</span>';
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
const spend = { picked: new Set() };

const spendSeverities = () => [...document.querySelectorAll('[data-spend-sev]:checked')].map((box) => box.dataset.spendSev);

/** The bar's buttons turn gold when the chosen projects hold credits to use: 1 to triage, 3 to remediate. */
function renderSpend(all) {
  const bar = $('cc-spend');
  bar.hidden = !canAny('triage.run credits.allocate') || !all.length;
  if (bar.hidden) return;
  for (const id of spend.picked) if (!all.some((p) => p.projectId === id)) spend.picked.delete(id);
  const chosen = spend.picked.size ? all.filter((p) => spend.picked.has(p.projectId)) : all;
  const triage = chosen.reduce((n, p) => n + (p.triage.remaining ?? 0), 0);
  const remediation = chosen.reduce((n, p) => n + (p.remediation.remaining ?? 0), 0);
  const severities = spendSeverities().length > 0;
  $('cc-run-triage').disabled = !severities || triage < 1;
  $('cc-run-remediation').disabled = !severities || remediation < 3;
  $('cc-run-triage').classList.toggle('is-golden', !$('cc-run-triage').disabled);
  $('cc-run-remediation').classList.toggle('is-golden', !$('cc-run-remediation').disabled);
  $('cc-spend-left').textContent = `${spend.picked.size ? `${chosen.length} project${chosen.length === 1 ? '' : 's'} ticked` : 'Every project'}: ${triage} triage and ${remediation} remediation credits left.`;
}

async function runCredits(kind) {
  const severities = spendSeverities();
  if (!severities.length) return setStatus('cc-spend-status', 'Pick at least one severity.', 'error');
  const all = usage.data?.allocations ?? [];
  const chosen = spend.picked.size ? all.filter((p) => spend.picked.has(p.projectId)) : all;
  const sev = severities.map((s) => s.toLowerCase()).join(', ');
  const who = spend.picked.size ? `the ${chosen.length} ticked project(s)` : `every project holding credits (${chosen.length})`;
  const question = kind === 'triage'
    ? `Run AI Triage on the ${sev} findings still awaiting triage in ${who}? It uses Checkmarx One credits.`
    : `Run AI Remediation on the confirmed ${sev} findings in ${who}? It uses 3 Checkmarx One credits each.`;
  if (!confirm(question)) return;
  const button = $(kind === 'triage' ? 'cc-run-triage' : 'cc-run-remediation');
  button.disabled = true;
  setStatus('cc-spend-status', kind === 'triage' ? 'Starting AI Triage…' : 'Starting AI Remediation…');
  try {
    const result = await api('/api/credits/run', { method: 'POST', body: JSON.stringify({ kind, severities, projectIds: [...spend.picked] }) });
    setStatus('cc-spend-status', spendText(result, kind), result.failed ? 'error' : 'ok');
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
  } finally {
    renderSpend(usage.data?.allocations ?? []);
  }
}

/** Give the ticked projects what the chosen severities need (confirmed twice with Checkmarx One), plus any extra. */
async function allocateNeededCredits() {
  const severities = spendSeverities();
  const count = (id) => Math.max(0, Math.floor(Number($(id).value) || 0));
  const triageAdd = count('cc-spend-extra-triage');
  const remediationAdd = count('cc-spend-extra-remediation');
  if (!severities.length && !triageAdd && !remediationAdd) return setStatus('cc-spend-status', 'Pick severities, or enter credits to add.', 'error');
  if (!confirm('Allocate credits from the credit pool to the ticked projects (none ticked: every project holding credits): what the ticked severities need (1 per Checkmarx One result to triage, 3 per confirmed result to remediate), plus any extra entered?')) return;
  const button = $('cc-allocate');
  button.disabled = true;
  setStatus('cc-spend-status', 'Allocating…');
  try {
    const result = await api('/api/credits/allocate-needed', { method: 'POST', body: JSON.stringify({ severities, triageAdd, remediationAdd, projectIds: [...spend.picked] }) });
    $('cc-spend-extra-triage').value = 0;
    $('cc-spend-extra-remediation').value = 0;
    if (usage.data) {
      usage.data.allocations = result.allocations;
      usage.data.pool = result.pool;
      $('credits-pool').innerHTML = poolHtml(result.pool);
    }
    renderAllocations(result.allocations);
    setStatus('cc-spend-status', 'Allocated. The table shows what each project now has.', 'ok');
    creditsChanged();
  } catch (error) {
    if (handleAuthLoss(error)) return;
    setStatus('cc-spend-status', error.message, 'error');
  } finally {
    button.disabled = false;
    renderSpend(usage.data?.allocations ?? []);
  }
}

$('cc-allocate').addEventListener('click', allocateNeededCredits);
$('cc-run-triage').addEventListener('click', () => runCredits('triage'));
$('cc-run-remediation').addEventListener('click', () => runCredits('remediation'));
for (const box of document.querySelectorAll('[data-spend-sev]')) box.addEventListener('change', () => renderSpend(usage.data?.allocations ?? []));

/**
 * Credits were given, taken back or used on one page: the Dashboard's balances
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
// Giving credits on the Credit Control page (the Dashboard gives them too)
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

// ---------------------------------------------------------------------------
// Settings → HTTPS (Admin): http → http and HTTPS side by side → HTTPS only, on the
// running server, with every certificate checked the way a browser would before use
// ---------------------------------------------------------------------------

const httpsUi = { status: null, files: [], candidate: null };
const HTTPS_MODES = { http: 'HTTP only', both: 'HTTP + HTTPS side by side', https: 'HTTPS only' };
const CERT_SOURCES = { uploaded: 'uploaded here', environment: 'from the container options', 'self-signed': 'self-signed, made here' };
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

async function loadHttps() {
  if (!can('security.https')) return;
  try {
    renderHttps(await api('/api/https', { quiet: true }));
  } catch (error) {
    if (!handleAuthLoss(error)) showError('https-status', error);
  }
}

function certCard(report, { title, candidate = false } = {}) {
  if (!report?.summary) {
    return `<div class="https-cert"><ul class="https-checks"><li class="error"><span>${escapeHtml(report?.error || 'The certificate could not be read.')}</span></li></ul></div>`;
  }
  const s = report.summary;
  const fromLetsEncrypt = report.source === 'uploaded' && /^Let's Encrypt/.test(httpsUi.status?.uploaded?.by ?? '') && !candidate;
  const meta = [fromLetsEncrypt ? "from Let's Encrypt" : CERT_SOURCES[report.source], s.keyType, report.kind === 'pfx' ? '.pfx' : ''].filter(Boolean).join(' · ');
  const chain = s.chain.length > 1 ? `<div class="chain">Chain: ${s.chain.map((c) => escapeHtml(c.subject)).join(' → ')}</div>` : '';
  const notes = report.notes?.length ? `<ul class="notes">${report.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : '';
  return `<div class="https-cert${candidate ? ' candidate' : ''}">
    <div class="title">${escapeHtml(title)}: ${escapeHtml(s.subject)} <small>${escapeHtml(meta)}</small></div>
    ${chain}
    <ul class="https-checks">${report.checks.map((c) => `<li class="${c.level}"><span>${escapeHtml(c.title)}${c.detail ? `<small>${escapeHtml(c.detail)}</small>` : ''}</span></li>`).join('')}</ul>
    ${notes}
  </div>`;
}

function renderHttps(s) {
  httpsUi.status = s;
  const cert = s.certificate;
  const realCert = Boolean(cert?.summary && cert.source !== 'self-signed');
  const badge = $('https-badge');
  badge.className = `https-badge ${s.mode}`;
  badge.textContent = HTTPS_MODES[s.mode];

  const tile = (label, value) => `<div class="tile"><b>${escapeHtml(label)}</b><span>${value}</span></div>`;
  const reminder = s.reminderServer?.url || '';
  $('https-now').innerHTML = [
    tile('This page is open over', s.viewing.secure ? `<strong>HTTPS</strong> (${escapeHtml(s.viewing.host)})` : `http (${escapeHtml(s.viewing.host)})`),
    tile('Certificate', cert?.summary ? `${escapeHtml(cert.summary.subject)}, until ${escapeHtml(day(cert.summary.validTo))}${cert.summary.daysLeft < 30 ? ` <strong class="https-note warn">(${cert.summary.daysLeft} days left)</strong>` : ''}` : 'None yet'),
    tile('Reports opened, last 24 h', `${s.reportOpens.https} over HTTPS · ${s.reportOpens.http} over http`),
    tile('Reports point readers to', reminder ? `<code>${escapeHtml(reminder)}</code>` : 'no address yet'),
    tile('Last change', s.changedAt ? `${escapeHtml(day(s.changedAt))} by ${escapeHtml(s.changedBy || 'the server')}` : `Container start setting (HTTPS=${escapeHtml(s.startMode === 'http' ? 'off' : s.startMode === 'https' ? 'on' : 'both')})`),
  ].join('');

  // 1. Certificate
  renderAcme(s.acme, s);
  $('https-cert-current').innerHTML = cert ? certCard(cert, { title: 'In use' }) : '<p class="hint">None yet. Turning HTTPS on makes a self-signed one to start with; upload your company certificate to replace it.</p>';
  $('https-files-label').textContent = realCert ? 'Choose files to replace it' : 'Choose certificate files';
  const actions = [];
  if (s.previous) actions.push(`<button type="button" id="https-previous">Put the previous certificate back (${escapeHtml(s.previous.subject)}, until ${escapeHtml(day(s.previous.validTo))})</button>`);
  if (s.uploaded) actions.push(`<button type="button" class="link" id="https-remove">Stop using the uploaded certificate</button>`);
  if (cert?.source === 'self-signed') actions.push(`<button type="button" class="link" id="https-selfsign">Make a new self-signed one for the names in use</button>`);
  $('https-cert-actions').innerHTML = actions.join('');
  if (!$('https-csr-names').value) {
    const names = new Set();
    for (const value of [s.viewing.host, reminder]) {
      try {
        const host = new URL(/^https?:/.test(value) ? value : `http://${value}`).hostname;
        if (host && !/^(localhost|127\.|\[?::1)/.test(host)) names.add(host);
      } catch {}
    }
    $('https-csr-names').value = [...names].join(', ');
  }
  $('https-csr-download').hidden = !s.request?.available;
  if (s.request) setStatus('https-csr-status', `Request for ${s.request.names.join(', ')} made ${day(s.request.at)}: waiting for the certificate from IT.`);

  // 2. Side by side
  $('https-both').disabled = s.mode !== 'http';
  $('https-both').textContent = s.mode === 'http' ? 'Turn on HTTPS next to http' : 'HTTPS is on';
  setStatus('https-both-status', s.mode === 'http' ? '' : `Answering at ${s.viewing.httpsUrl}${s.mode === 'both' ? ` and ${s.viewing.httpUrl}` : ''}.`, s.mode === 'http' ? '' : 'ok');

  // 3. Test
  $('https-open').href = `${s.viewing.httpsUrl}/#/settings/https`;
  $('https-open').classList.toggle('disabled', s.mode === 'http');
  $('https-check-browser').disabled = s.mode === 'http';
  const check = s.lastBrowserCheck;
  if (check && !$('https-browser-result').dataset.fresh) {
    $('https-browser-result').className = `https-browser ${check.ok ? 'good' : 'bad'}`;
    $('https-browser-result').textContent = `${check.ok ? '✓ Accepted' : '✕ Refused'} by ${check.by || 'a browser'} on ${day(check.at)} (${check.url}).`;
  }
  $('https-reports-hint').textContent = s.mode === 'both'
    ? `Emailed reports opened from now on try HTTPS and keep to it on machines where it works. Last 24 hours: ${s.reportOpens.https} opened over HTTPS, ${s.reportOpens.http} over http. When http keeps falling, it is time for step 4.`
    : s.mode === 'https' ? 'Reports that still use the old http address are told the new one, and switch by themselves.' : '';

  // 4. HTTPS only
  const switchButton = $('https-switch');
  switchButton.disabled = s.mode !== 'both' || !s.viewing.secure;
  switchButton.textContent = s.mode === 'https' ? 'HTTPS only is on' : 'Switch to HTTPS only';
  $('https-undo').hidden = s.mode !== 'https';
  const addressHttps = /^https:/i.test(reminder);
  $('https-update-address').closest('label').hidden = addressHttps || s.mode === 'https';
  $('https-update-address-label').textContent = `Also put ${s.viewing.httpsUrl} into new reports, as the Reminder server address (now ${reminder || 'none'})`;
  const hint = $('https-switch-hint');
  hint.className = 'https-note';
  if (s.mode === 'both' && !s.viewing.secure) {
    hint.className = 'https-note warn';
    hint.innerHTML = `Open this page over HTTPS to switch: <a href="${escapeHtml(s.viewing.httpsUrl)}/#/settings/https">${escapeHtml(s.viewing.httpsUrl)}</a>. That proves HTTPS works from your browser before http goes away.`;
  } else if (s.mode === 'both' && cert?.trust === 'self-signed') {
    hint.className = 'https-note warn';
    hint.textContent = 'The certificate is self-signed: after the switch every browser warns. Upload your company certificate first (step 1).';
  } else if (s.mode === 'https') {
    hint.textContent = `http://${s.viewing.host.replace(/^https?:\/\//, '')} now redirects to HTTPS.`;
  } else hint.textContent = '';

  // 5. Harden
  const canHarden = s.mode === 'https' && realCert;
  for (const id of ['https-hsts', 'https-hsts-age', 'https-hsts-sub', 'https-min-version', 'https-harden-save']) $(id).disabled = id === 'https-min-version' || id === 'https-harden-save' ? s.mode === 'http' : !canHarden;
  $('https-hsts').checked = Boolean(s.hsts.enabled);
  $('https-hsts-age').value = String(s.hsts.maxAge);
  $('https-hsts-sub').checked = Boolean(s.hsts.includeSubDomains);
  $('https-min-version').value = s.minVersion;
  if (!canHarden && s.mode === 'https') setStatus('https-harden-status', 'HSTS needs a certificate from IT or a public authority, not a self-signed one.');

  // Where the Admin is in the five steps.
  const done = {
    'https-step-cert': realCert && cert.usable,
    'https-step-both': s.mode !== 'http',
    'https-step-test': s.mode === 'https' || Boolean(check?.ok),
    'https-step-switch': s.mode === 'https',
    'https-step-harden': Boolean(s.hstsActive),
  };
  const locked = { 'https-step-test': s.mode === 'http', 'https-step-switch': s.mode === 'http', 'https-step-harden': s.mode !== 'https' };
  let current = '';
  for (const id of Object.keys(done)) {
    if (!current && !done[id] && !locked[id]) current = id;
    $(id).classList.toggle('done', done[id]);
    $(id).classList.toggle('locked', Boolean(locked[id]));
  }
  for (const id of Object.keys(done)) $(id).classList.toggle('current', id === current);

  let zone = 'UTC';
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {}
  $('https-ports-cmd').textContent = `podman run --replace -d --name mission-zero -p 443:3000 -p 80:3000 -v mission-zero-data:/data -e TZ=${zone} --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest`;
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

async function chooseHttpsFiles(list) {
  const files = [...(list ?? [])].slice(0, 10);
  if (!files.length) return;
  const big = files.find((f) => f.size > 256 * 1024);
  if (big) {
    $('https-candidate').innerHTML = `<p class="status error">${escapeHtml(big.name)} is larger than 256 KB, so it is not a certificate file.</p>`;
    return;
  }
  httpsUi.files = await Promise.all(files.map(async (f) => ({ name: f.name, data: toBase64(await f.arrayBuffer()) })));
  if (files.some((f) => /\.(pfx|p12)$/i.test(f.name))) $('https-pass-field').hidden = false;
  await inspectHttps();
}

async function inspectHttps() {
  const box = $('https-candidate');
  if (!httpsUi.files.length) return;
  box.innerHTML = `<p class="status">Checking ${escapeHtml(httpsUi.files.map((f) => f.name).join(', '))}…</p>`;
  try {
    const report = await api('/api/https/inspect', { method: 'POST', body: JSON.stringify({ files: httpsUi.files, passphrase: $('https-passphrase').value }) });
    httpsUi.candidate = report;
    const replacing = httpsUi.status?.certificate?.source && httpsUi.status.certificate.source !== 'self-signed';
    const warnings = report.checks.filter((c) => c.level === 'warn').length;
    box.innerHTML = `${certCard(report, { title: replacing ? 'Replacement' : 'New certificate', candidate: true })}
      <div class="actions compact">
        <button type="button" class="primary" id="https-use">${replacing ? 'Replace the certificate in use' : 'Use this certificate'}</button>
        <button type="button" class="link" id="https-discard">Choose other files</button>
        <span class="hint">${warnings ? 'It works; the warnings are what some people may see.' : 'Goes into use at once, with no restart. The one it replaces is kept, to put back in one click.'}</span>
      </div>`;
  } catch (error) {
    if (handleAuthLoss(error)) return;
    if (error.body?.needsPassphrase) {
      $('https-pass-field').hidden = false;
      $('https-passphrase').focus();
    }
    box.innerHTML = `<div class="https-cert"><ul class="https-checks"><li class="error"><span>${escapeHtml(error.message)}</span></li></ul></div>`;
  }
}

async function installHttps(confirmed = false) {
  try {
    const result = await api('/api/https/certificate', { method: 'POST', body: JSON.stringify({ files: httpsUi.files, passphrase: $('https-passphrase').value, confirm: confirmed }) });
    httpsUi.files = [];
    httpsUi.candidate = null;
    $('https-passphrase').value = '';
    $('https-pass-field').hidden = true;
    $('https-candidate').innerHTML = `<p class="status ok">In use now: ${escapeHtml(result.report.summary.subject)}, until ${escapeHtml(day(result.report.summary.validTo))}.</p>`;
    renderHttps(result.status);
    toast('The new certificate is in use. Nothing restarted.', 'good');
  } catch (error) {
    if (handleAuthLoss(error)) return;
    if (error.body?.needsConfirm && confirm(error.message)) return installHttps(true);
    $('https-candidate').insertAdjacentHTML('beforeend', `<p class="status error">${escapeHtml(error.message)}</p>`);
  }
}

async function setHttpsMode(mode, extra = {}, statusId = 'https-switch-status') {
  try {
    const result = await api('/api/https/mode', { method: 'POST', body: JSON.stringify({ mode, ...extra }) });
    renderHttps(result);
    if (result.addressChanged) {
      loadReportServer();
      toast(`New reports use ${result.addressChanged}.`, 'good');
    }
    setStatus(statusId, '');
  } catch (error) {
    if (handleAuthLoss(error)) return;
    if (error.body?.needsConfirm && confirm(error.message)) return setHttpsMode(mode, { ...extra, confirm: true }, statusId);
    setStatus(statusId, error.message, 'error');
  }
}

async function httpsAction(request, okMessage) {
  try {
    renderHttps(await request());
    if (okMessage) toast(okMessage, 'good');
  } catch (error) {
    if (handleAuthLoss(error)) return;
    setStatus('https-status', error.message, 'error');
  }
}

$('https-files').addEventListener('change', () => {
  chooseHttpsFiles($('https-files').files).finally(() => ($('https-files').value = ''));
});
for (const type of ['dragenter', 'dragover']) {
  $('https-drop').addEventListener(type, (event) => {
    event.preventDefault();
    $('https-drop').classList.add('over');
  });
}
for (const type of ['dragleave', 'drop']) $('https-drop').addEventListener(type, () => $('https-drop').classList.remove('over'));
$('https-drop').addEventListener('drop', (event) => {
  event.preventDefault();
  chooseHttpsFiles(event.dataTransfer?.files);
});
$('https-passphrase').addEventListener('change', () => inspectHttps());
$('https-candidate').addEventListener('click', (event) => {
  if (event.target.id === 'https-use') installHttps();
  if (event.target.id === 'https-discard') {
    httpsUi.files = [];
    $('https-candidate').innerHTML = '';
  }
});
$('https-cert-actions').addEventListener('click', (event) => {
  if (event.target.id === 'https-previous') httpsAction(() => api('/api/https/certificate/previous', { method: 'POST' }), 'The previous certificate is in use again.');
  if (event.target.id === 'https-selfsign') httpsAction(() => api('/api/https/self-signed', { method: 'POST', body: JSON.stringify({ names: [] }) }), 'A new self-signed certificate is in use.');
  if (event.target.id === 'https-remove') {
    const remove = (confirmed) => api(`/api/https/certificate${confirmed ? '?confirm=1' : ''}`, { method: 'DELETE' });
    httpsAction(async () => {
      try {
        return await remove(false);
      } catch (error) {
        if (error.body?.needsConfirm && confirm(error.message)) return remove(true);
        throw error;
      }
    }, 'The uploaded certificate is no longer used.');
  }
});
// ---- Free certificate from Let's Encrypt ----

let acmePoll = null;

/** The Let's Encrypt card: what it is doing, what it got, and when it renews. */
function renderAcme(a, s = httpsUi.status) {
  if (!a) return;
  if (!$('https-le-names').value) {
    const names = a.names?.length ? a.names : a.suggested?.length ? a.suggested : [];
    $('https-le-names').value = names.join(', ');
  }
  if (!$('https-le-email').value && a.email) $('https-le-email').value = a.email;
  if (a.staging) $('https-le-staging').checked = true;
  $('https-le-get').disabled = a.running;
  $('https-le-get').textContent = a.issued ? 'Get a new certificate' : 'Get a free certificate';
  $('https-le-renew').hidden = !a.enabled || a.running;
  $('https-le-stop').hidden = !a.enabled || a.running;
  const last = a.last;
  if (a.running) setStatus('https-le-status', 'Asking Let\'s Encrypt… This usually takes under a minute.');
  else if (last?.running) setStatus('https-le-status', 'The last request did not finish (the server restarted). Try again.', 'warn');
  else if (last?.ok) setStatus('https-le-status', `Certificate for ${last.names.join(', ')} put to use on ${day(last.at)}.`, 'ok');
  else if (last && !last.ok) setStatus('https-le-status', last.error, 'error');
  else setStatus('https-le-status', '');
  const info = [];
  if (a.fromEnvironment) info.push(`Set up when the server was deployed (LETSENCRYPT_DOMAIN=${a.fromEnvironment}).`);
  if (a.issued) {
    info.push(`In use until ${day(a.issued.validTo)} (${a.daysLeft} days left)${a.issued.staging ? ', from the staging service: browsers do not trust it' : ''}.`);
    info.push(a.enabled ? `Renewed by itself from ${day(a.renewsFrom)}.` : 'Automatic renewal is off.');
  }
  if (a.issued && !a.issued.staging && s?.mode === 'both') info.push('Next: open this page over HTTPS and switch to HTTPS only (step 4).');
  $('https-le-info').textContent = info.join(' ');
  clearTimeout(acmePoll);
  if (a.running) {
    acmePoll = setTimeout(async () => {
      try {
        const next = await api('/api/https/acme', { quiet: true });
        if (next.running) renderAcme(next);
        else loadHttps();
      } catch (error) {
        if (!handleAuthLoss(error)) setStatus('https-le-status', error.message, 'error');
      }
    }, 2000);
  }
}

$('https-le-get').addEventListener('click', async () => {
  const names = $('https-le-names').value.split(/[\s,;]+/).filter(Boolean);
  if (!names.length) return setStatus('https-le-status', 'Enter the name people use to reach this server, e.g. mz.company.com.', 'error');
  if (!$('https-le-agree').checked) return setStatus('https-le-status', 'Tick the box to agree to the Let\'s Encrypt Subscriber Agreement first.', 'error');
  try {
    renderAcme(await api('/api/https/acme', {
      method: 'POST',
      body: JSON.stringify({ names, email: $('https-le-email').value.trim(), agree: true, staging: $('https-le-staging').checked, skipPrecheck: $('https-le-skip').checked }),
    }));
  } catch (error) {
    if (!handleAuthLoss(error)) setStatus('https-le-status', error.message, 'error');
  }
});
$('https-le-renew').addEventListener('click', async () => {
  try {
    renderAcme(await api('/api/https/acme/renew', { method: 'POST' }));
  } catch (error) {
    if (!handleAuthLoss(error)) setStatus('https-le-status', error.message, 'error');
  }
});
$('https-le-stop').addEventListener('click', async () => {
  if (!confirm('Stop renewing the Let\'s Encrypt certificate by itself? It stays in use until it expires or you replace it.')) return;
  try {
    renderAcme(await api('/api/https/acme', { method: 'DELETE' }));
  } catch (error) {
    if (!handleAuthLoss(error)) setStatus('https-le-status', error.message, 'error');
  }
});

$('https-csr-create').addEventListener('click', async () => {
  const names = $('https-csr-names').value.split(/[\s,;]+/).filter(Boolean);
  if (!names.length) {
    setStatus('https-csr-status', 'Enter the name people use to reach this server, e.g. mz.company.com.', 'error');
    return;
  }
  try {
    const result = await api('/api/https/request', { method: 'POST', body: JSON.stringify({ names, organization: $('https-csr-org').value.trim() }) });
    renderHttps(result.status);
    setStatus('https-csr-status', 'Downloaded. Send cxmissionzero.csr to IT and ask for a server certificate with its chain.', 'ok');
    $('https-csr-download').click();
  } catch (error) {
    if (!handleAuthLoss(error)) setStatus('https-csr-status', error.message, 'error');
  }
});
$('https-both').addEventListener('click', () => setHttpsMode('both', {}, 'https-both-status'));
$('https-switch').addEventListener('click', () => {
  const s = httpsUi.status;
  if (!confirm(`Switch to HTTPS only? Plain http (${s.viewing.httpUrl}) will redirect to ${s.viewing.httpsUrl}. You can go back to both at any time.`)) return;
  setHttpsMode('https', { updateAddress: !$('https-update-address').closest('label').hidden && $('https-update-address').checked });
});
$('https-undo').addEventListener('click', () => setHttpsMode('both'));
$('https-check-browser').addEventListener('click', async () => {
  const s = httpsUi.status;
  const url = s.viewing.httpsUrl;
  const out = $('https-browser-result');
  out.dataset.fresh = '1';
  out.className = 'https-browser';
  out.textContent = `Connecting to ${url} from this browser…`;
  let ok = false;
  try {
    const response = await fetch(`${url}/api/relay/ping`, { cache: 'no-store' });
    ok = (await response.json()).service === 'mission-zero-relay';
  } catch {}
  out.className = `https-browser ${ok ? 'good' : 'bad'}`;
  out.textContent = ok
    ? `✓ This browser connects to ${url} with no certificate error.${s.viewing.secure ? ' (If you clicked past a warning on this page earlier, that counts too: check the padlock.)' : ''}`
    : `✕ This browser refused ${url}: it does not trust the certificate${s.certificate?.trust === 'self-signed' ? ' (self-signed)' : ''}, or the address is not a name in it. Open it to see the browser's reason.`;
  api('/api/https/browser-check', { method: 'POST', quiet: true, body: JSON.stringify({ ok, url }) }).catch(() => {});
  if (ok) $('https-step-test').classList.add('done');
});
$('https-harden-save').addEventListener('click', async () => {
  const hsts = { enabled: $('https-hsts').checked, maxAge: Number($('https-hsts-age').value), includeSubDomains: $('https-hsts-sub').checked };
  const label = $('https-hsts-age').selectedOptions[0]?.textContent.replace(/ \(.*\)$/, '') ?? '';
  if (hsts.enabled && !httpsUi.status.hsts.enabled && !confirm(`Turn on HSTS? Browsers that visit will use only HTTPS here for ${label}, even if this server goes back to http. Start short (1 day), then lengthen it.`)) return;
  try {
    renderHttps(await api('/api/https/hardening', { method: 'POST', body: JSON.stringify({ hsts, minVersion: $('https-min-version').value }) }));
    setStatus('https-harden-status', 'Applied.', 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) setStatus('https-harden-status', error.message, 'error');
  }
});

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
function showTermsOverlay({ mode = 'view', me = null } = {}) {
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

document.addEventListener('click', (event) => {
  const link = event.target.closest?.('[data-terms-open]');
  if (!link) return;
  event.preventDefault();
  if ($('terms-overlay').hidden) showTermsOverlay({ mode: 'view' });
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('terms-overlay').hidden && !$('terms-close').hidden) $('terms-close').click();
});

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

// ---------------------------------------------------------------------------
// Layout: the menu (kept open, or a slim bar of icons that opens when pointed at) and the
// Dashboard's top block, which stays in view while the projects scroll with the page.
// ---------------------------------------------------------------------------

const sidebarMode = () => (document.documentElement.dataset.sidebar === 'auto' ? 'auto' : 'pinned');
function applySidebarMode(mode) {
  const auto = mode === 'auto';
  if (auto) document.documentElement.dataset.sidebar = 'auto';
  else delete document.documentElement.dataset.sidebar;
  document.querySelector('.sidebar')?.classList.remove('open');
  const pin = $('sidebar-pin');
  pin.setAttribute('aria-pressed', String(!auto));
  pin.title = auto ? 'Keep the menu open beside the page' : 'Hide the menu: it becomes a slim bar of icons and opens when you point at it';
  pin.setAttribute('aria-label', pin.title);
  $('sidebar-pin-label').textContent = auto ? 'Keep menu open' : 'Hide menu';
  try {
    localStorage.setItem('mz-sidebar', mode);
  } catch {}
}
applySidebarMode(sidebarMode());
$('sidebar-pin').addEventListener('click', () => applySidebarMode(sidebarMode() === 'auto' ? 'pinned' : 'auto'));

// Pointing at the slim bar opens the menu over the page (nothing beside it moves); a short
// pause on the way in and out keeps it from flickering when the pointer only passes by.
{
  const bar = document.querySelector('.sidebar');
  let timer = null;
  const set = (open, delay) => {
    clearTimeout(timer);
    timer = setTimeout(() => bar.classList.toggle('open', open && sidebarMode() === 'auto'), delay);
  };
  bar.addEventListener('mouseenter', () => set(true, 120));
  bar.addEventListener('mouseleave', () => set(false, 260));
  bar.addEventListener('focusin', () => set(true, 0));
  bar.addEventListener('focusout', (event) => {
    if (!bar.contains(event.relatedTarget)) set(false, 0);
  });
  // Choosing a page closes it again.
  bar.addEventListener('click', (event) => {
    if (event.target.closest('a.tab')) set(false, 0);
  });
}

// The top block's height, for what sits below it (the action rail, the table's header row).
if (window.ResizeObserver) {
  const top = $('dash-top');
  let last = '';
  // Written only when it changes: a style change on the root restyles the whole page.
  const measure = () => {
    const value = `${Math.round(top.getBoundingClientRect().height)}px`;
    if (value === last || !top.offsetParent) return;
    last = value;
    document.documentElement.style.setProperty('--dash-top-h', value);
  };
  new ResizeObserver(measure).observe(top);
  measure();
}

// While the page scrolls, rows passing under the pointer do not repaint their hover highlight.
{
  let scrollIdle = null;
  window.addEventListener('scroll', () => {
    if (!document.body.classList.contains('scrolling')) document.body.classList.add('scrolling');
    clearTimeout(scrollIdle);
    scrollIdle = setTimeout(() => document.body.classList.remove('scrolling'), 150);
  }, { passive: true });
}

// ---------------------------------------------------------------------------
// Language: the page's own words in the reader's language (public/i18n.js).
// ---------------------------------------------------------------------------

/** Set once the language picker exists: offer the languages this server has unlocked. */
let languagesChanged = () => {};

{
  const select = $('lang-select');
  const SHORT = { en: 'EN', ja: 'JA', 'zh-TW': '繁中', 'zh-CN': '简中', ko: 'KO', es: 'ES', 'pt-BR': 'PT', de: 'DE', fr: 'FR', ar: 'AR', vi: 'VI', th: 'TH', ms: 'MS', id: 'ID', he: 'HE' };
  const fill = () => {
    select.innerHTML = availableLanguages().map(([code, name]) => `<option value="${code}" lang="${code}">${escapeHtml(name)}</option>`).join('');
    select.value = currentLanguage();
  };
  fill();
  // Languages unlocked by an activation code (Hebrew) are offered once the server says so. Only
  // the signed-in answer (`final`) switches someone back to English: before it, the page may not
  // know yet that this person is one of those Hebrew is open to.
  languagesChanged = (codes, final = false) => {
    const allowed = setAvailable(codes);
    fill();
    if (!allowed && final) setLanguage('en');
  };
  const show = (code) => {
    select.value = code;
    select.setAttribute('aria-label', t('Language'));
    $('lang-code').textContent = SHORT[code] ?? code.toUpperCase();
  };
  onLanguageChange(show);
  select.addEventListener('change', async () => {
    await setLanguage(select.value);
    if (state.me) saveProfile({ language: select.value });
  });
  show(currentLanguage());
  startI18n();
}

// ---------------------------------------------------------------------------
// Your profile (Settings › Your profile, also under your name at the top right): name, picture,
// language, time zone and programming languages. Stored with your account, so it follows you.
// ---------------------------------------------------------------------------

/** A person's picture in `el`, else the first letter of their name. */
function showAvatar(el, user) {
  if (user?.avatarAt) {
    el.innerHTML = `<img src="/api/users/${encodeURIComponent(user.id)}/avatar?v=${encodeURIComponent(user.avatarAt)}" alt="" />`;
  } else {
    el.textContent = (user?.name || user?.email || '?').trim()[0]?.toUpperCase() ?? '?';
  }
}

const profileZone = (profile) => (profile?.timeZoneAuto === false && profile.timeZone ? profile.timeZone : deviceTimeZone());

/** After signing in: the account's language and time zone; a new computer's zone is noted quietly. */
function applyProfile(me) {
  const profile = me.user.profile ?? {};
  setTimeZone(profileZone(profile));
  if (profile.language && profile.language !== currentLanguage()) setLanguage(profile.language);
  const quiet = {};
  if (!profile.language && currentLanguage() !== 'en') quiet.language = currentLanguage();
  if (profile.timeZoneAuto !== false && deviceTimeZone() && profile.timeZone !== deviceTimeZone()) quiet.timeZone = deviceTimeZone();
  if (Object.keys(quiet).length) saveProfile({ ...quiet, quiet: true }, { silent: true });
}

let profileSaving = Promise.resolve();
/** Save part of the profile (one request at a time, in order). */
function saveProfile(patch, { silent = false } = {}) {
  profileSaving = profileSaving.then(async () => {
    try {
      const me = await api('/api/me/profile', { method: 'PUT', body: JSON.stringify(patch) });
      state.me = { ...state.me, user: me.user };
      $('me-name').textContent = me.user.name || me.user.email;
      setTimeZone(profileZone(me.user.profile));
      if (!silent) {
        setStatus('pf-status', 'Saved.', 'ok');
        if (state.page === 'settings') renderProfile();
      }
    } catch (error) {
      if (!handleAuthLoss(error) && !silent) showError('pf-status', error);
    }
  });
  return profileSaving;
}

const PROGRAMMING = ['Apex', 'C', 'C++', 'C#', 'COBOL', 'Dart', 'Go', 'Groovy', 'Java', 'JavaScript', 'Kotlin', 'Objective-C', 'Perl', 'PHP', 'PL/SQL', 'Python', 'Ruby', 'Rust', 'Scala', 'Swift', 'TypeScript', 'VB.NET', 'Infrastructure as code'];

/** "Asia/Tokyo (UTC+09:00)". */
function profileZoneLabel(zone) {
  try {
    const offset = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? '';
    return `${zone.replace(/_/g, ' ')} (${offset.replace('GMT', 'UTC') || 'UTC'})`;
  } catch {
    return zone;
  }
}

function renderProfile() {
  const me = state.me;
  if (!me) return;
  const user = me.user;
  const profile = user.profile ?? {};
  showAvatar($('pf-avatar'), user);
  $('pf-avatar-remove').hidden = !user.avatarAt;
  $('pf-email').textContent = user.email;
  $('pf-role').textContent = me.role.name;
  $('pf-via').textContent = me.via === 'cxone' ? 'A Checkmarx One key' : 'A password';
  $('pf-last').textContent = user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : '—';
  if (document.activeElement !== $('pf-name')) $('pf-name').value = user.name ?? '';
  const language = $('pf-language');
  language.innerHTML = availableLanguages().map(([code, name]) => `<option value="${code}" lang="${code}">${escapeHtml(name)}</option>`).join('');
  language.value = profile.language || currentLanguage();
  const zones = $('pf-tz');
  if (!zones.options.length) {
    let all = [];
    try {
      all = Intl.supportedValuesOf('timeZone');
    } catch {}
    const device = deviceTimeZone();
    if (device && !all.includes(device)) all.unshift(device);
    if (!all.includes('UTC')) all.push('UTC');
    zones.innerHTML = all.map((zone) => `<option value="${escapeHtml(zone)}">${escapeHtml(profileZoneLabel(zone))}</option>`).join('');
  }
  const auto = profile.timeZoneAuto !== false;
  $('pf-tz-auto').checked = auto;
  $('pf-tz-device').textContent = profileZoneLabel(deviceTimeZone() || 'UTC');
  zones.value = profileZone(profile) || 'UTC';
  zones.disabled = auto;
  const picked = new Set(profile.programmingLanguages ?? []);
  $('pf-langs').innerHTML = PROGRAMMING.map((name) => `<label${name === 'Infrastructure as code' ? '' : ' translate="no"'}><input type="checkbox" value="${escapeHtml(name)}"${picked.has(name) ? ' checked' : ''} /> ${escapeHtml(name)}</label>`).join('');
}

{
  let nameTimer = null;
  $('pf-name').addEventListener('input', () => {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => saveProfile({ name: $('pf-name').value }), 700);
  });
  $('pf-language').addEventListener('change', async () => {
    await setLanguage($('pf-language').value);
    saveProfile({ language: $('pf-language').value });
  });
  $('pf-tz-auto').addEventListener('change', () => {
    const auto = $('pf-tz-auto').checked;
    $('pf-tz').disabled = auto;
    saveProfile(auto ? { timeZoneAuto: true, timeZone: deviceTimeZone() } : { timeZoneAuto: false, timeZone: $('pf-tz').value });
  });
  $('pf-tz').addEventListener('change', () => saveProfile({ timeZoneAuto: false, timeZone: $('pf-tz').value }));
  $('pf-langs').addEventListener('change', () => {
    saveProfile({ programmingLanguages: [...$('pf-langs').querySelectorAll('input:checked')].map((box) => box.value) });
  });
  $('me-profile').addEventListener('click', () => {
    $('user-menu').open = false;
  });

  // A picture: cut to a square, made small here (192 px), then sent.
  $('pf-avatar-file').addEventListener('change', async () => {
    const file = $('pf-avatar-file').files[0];
    $('pf-avatar-file').value = '';
    if (!file) return;
    try {
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Choose a PNG, JPEG or WebP picture.');
      const bitmap = await createImageBitmap(file);
      const side = Math.min(bitmap.width, bitmap.height);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 192;
      canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 192, 192);
      let image = canvas.toDataURL('image/webp', 0.86);
      if (!image.startsWith('data:image/webp')) image = canvas.toDataURL('image/jpeg', 0.88);
      const me = await api('/api/me/avatar', { method: 'PUT', body: JSON.stringify({ image }) });
      state.me = { ...state.me, user: me.user };
      showAvatar($('me-avatar'), me.user);
      renderProfile();
      setStatus('pf-status', 'Picture saved.', 'ok');
    } catch (error) {
      if (!handleAuthLoss(error)) showError('pf-status', error);
    }
  });
  $('pf-avatar-remove').addEventListener('click', async () => {
    try {
      const me = await api('/api/me/avatar', { method: 'PUT', body: JSON.stringify({ image: '' }) });
      state.me = { ...state.me, user: me.user };
      showAvatar($('me-avatar'), me.user);
      renderProfile();
      setStatus('pf-status', 'Picture removed.', 'ok');
    } catch (error) {
      if (!handleAuthLoss(error)) showError('pf-status', error);
    }
  });
}
