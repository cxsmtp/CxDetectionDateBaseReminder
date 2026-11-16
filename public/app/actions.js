// What the Workbench does with the loaded findings: AI credits per project (giving, taking back, triage and
// remediation) and sending reminders (who to, the preview, the HTML report, the result).
import { tierName } from '../credit-tiers.js';
import { $, can, state } from './state.js';
import { escapeHtml } from './format.js';
import { api, handleAuthLoss, logger, setStatus, showError, toast } from './core.js';
import { downloadHtmlReport, renderGettingStarted, renderJourney, renderRailScope, totalsOf } from './workbench.js';
import { renderProjects, sharedResultsHtml, visibleProjects } from './projects.js';

/** "10 Checkmarx One results (12 findings — rows sharing a result count once)": why the rows and the credits differ. */
export function resultsText(results, rows) {
  const r = `${results} Checkmarx One result${results === 1 ? '' : 's'}`;
  return rows > results ? `${r} (${rows} findings — rows that share one result are triaged, and charged, once)` : r;
}
/** How long a "confirmed twice with Checkmarx One" count stays good for. */
const VERIFY_TTL_MS = 10 * 60 * 1000;
const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

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
// AI credits per project
// ---------------------------------------------------------------------------

export function creditCell(project, kind) {
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

export function allocationScope() {
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

export function renderAllocation() {
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

export function applyCredits(byProject) {
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

export function renderTotals(totals) {
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

/** Who gets reminders: one choice (Settings: reminders.audience), set here on the Workbench and used everywhere. */
export const AUDIENCE_TEXT = { initiator: 'Each developer (their own projects)', list: 'The fixed list', both: 'Each developer, and the fixed list' };
export const audience = () => state.settings?.reminders?.audience ?? 'initiator';
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

export function wireReminders() {
  $('preview').addEventListener('click', () => submitReminder({ dryRun: true }));
  $('send').addEventListener('click', () => submitReminder({ dryRun: false }));
  $('close-preview').addEventListener('click', () => {
    $('preview-panel').hidden = true;
  });

  // Update hints when send options change
  for (const radio of document.querySelectorAll('input[name="sendTo"], input[name="emailContent"]')) {
    radio.addEventListener('change', renderRecipientHint);
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
}

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

export function wireAllocation() {
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
  $('alloc-remediation').addEventListener('click', () => guardedAction('Allocating for remediation', () => allocateNeeded('remediation'), 'remediation'));
}
