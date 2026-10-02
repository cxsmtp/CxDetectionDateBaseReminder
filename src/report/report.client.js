/*
 * Runs inside the emailed HTML report.
 *
 * Triage and Remediate run Checkmarx One AI Triage and AI Remediation through
 * the reminder server, which calls Checkmarx One with its own stored
 * connection (Checkmarx One refuses API calls from a page opened as a file).
 * When remediation is not allowed, Remediate is a link to Risk Hub instead. The report carries a signed grant for each finding,
 * and the server's administrator decides whether triage is allowed and how
 * many credits it may use.
 *
 * Kept as a plain file (inlined by html-report.js) so it can be syntax
 * checked and is never subject to template-literal escaping.
 */
'use strict';

(() => {
  const DATA = JSON.parse(document.getElementById('report-data').textContent);
  const config = DATA.config;
  const findings = DATA.findings;
  const byKey = new Map(findings.map((f) => [f.key, f]));
  // One Checkmarx One result can be listed once per code path. AI Triage works on
  // the result, so rows sharing one are triaged together and charged once.
  const resultKey = (f) =>
    f.alternateId ? `${f.projectId}|a:${f.alternateId}` : f.groupId ? `${f.projectId}|g:${f.groupId}` : `${f.projectId}|r:${f.riskId}`;
  const sameResult = new Map();
  for (const f of findings) {
    if (f.aiUnavailable) continue;
    if (!sameResult.has(resultKey(f))) sameResult.set(resultKey(f), []);
    sameResult.get(resultKey(f)).push(f);
  }
  /** The rows that are the same Checkmarx One result as `f` (itself included). */
  const sameAs = (f) => sameResult.get(resultKey(f)) ?? [f];
  const resultCount = (list) => new Set(list.map(resultKey)).size;

  const STORE = 'cxReportConnection';
  // The address the report was sent with; a reader's correction is kept in
  // this browser for every report that carries the same original address.
  const ORIGINAL_SERVER = String(config.relayUrl || '').replace(/\/+$/, '');
  const SERVER_STORE = `cxReportServer:${ORIGINAL_SERVER}`;
  try {
    const override = localStorage.getItem(SERVER_STORE);
    if (override) config.relayUrl = override;
  } catch {}
  const POLL_MS = 6000;
  const MAX_POLL_MS = 30000;
  const TRIAGE_TIMEOUT_MS = 20 * 60 * 1000;
  // Sent this long ago and Checkmarx One still has no AI Triage record at all: stop saying "Triaging…".
  const NO_RECORD_MS = 6 * 60 * 1000;
  const REMEDIATION_POLL_MS = 12000;
  const REMEDIATION_TIMEOUT_MS = 40 * 60 * 1000;
  // AI Triage's own record can say TO_VERIFY after it finished, while the
  // finding itself settles a little later, so that is still worth waiting on.
  const WAITING = new Set(['IN_PROGRESS', 'NOT_TRIAGED', 'PENDING', 'QUEUED', 'RUNNING', 'TO_VERIFY']);

  const VERDICTS = {
    VULNERABLE: ['Vulnerable', 'bad'],
    PROPOSED_NOT_EXPLOITABLE: ['Proposed not exploitable', 'good'],
    NOT_EXPLOITABLE: ['Not exploitable', 'good'],
    UNCERTAIN: ['Uncertain', 'warn'],
    RISK_ACCEPTED: ['Risk accepted', 'muted'],
    TO_VERIFY: ['To verify', 'muted'],
    CONFIRMED: ['Confirmed', 'bad'],
    URGENT: ['Urgent', 'bad'],
    FAILED: ['Triage failed', 'bad'],
    IN_PROGRESS: ['Triaging…', 'busy'],
  };
  const SUB_LABELS = {
    REACHABLE: 'Reachable',
    NOT_REACHABLE: 'Not reachable',
    EXPLOITABLE: 'Exploitable',
    NOT_EXPLOITABLE: 'Not exploitable',
  };
  const SEVERITY_LABELS = { CRITICAL: 'critical', HIGH: 'high' };
  const STATE_LABELS = {
    TO_VERIFY: 'To verify',
    CONFIRMED: 'Confirmed',
    URGENT: 'Urgent',
    NOT_EXPLOITABLE: 'Not exploitable',
    PROPOSED_NOT_EXPLOITABLE: 'Proposed not exploitable',
  };

  let backend = null;
  // Credits per project, from the reminder server: {triage: {allocated, used, remaining}, remediation: {...}}.
  const credits = {};
  const projectNames = new Map(findings.map((f) => [f.projectId, f.projectName]));
  let bulkRunning = false;
  let connecting = null;

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const row = (f) => document.querySelector(`tr[data-key="${CSS.escape(f.key)}"]`);
  const bulkButtons = () => [...document.querySelectorAll('button.bulk[data-severity]')];

  class CxError extends Error {
    constructor(message, status = 0, body = null) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }

  const NOT_EXPLOITABLE = new Set(['NOT_EXPLOITABLE', 'PROPOSED_NOT_EXPLOITABLE']);

  /** The administrator decides whether a finding with a verdict may be triaged again. */
  const retriageAllowed = () => (backend ? backend.retriageAllowed : config.allowRetriage) === true;
  const reremediationAllowed = () => (backend ? backend.reremediationAllowed : config.allowReremediation) === true;
  /** A finished remediation (with or without details); a failed one may be run again. */
  const isRemediated = (f) => Boolean(f.remediation && !f.remediation.running && !f.remediation.failed);
  const contact = () => backend?.adminContact || config.adminContact || '';

  // ---------------------------------------------------------------------------
  // Activity log and banner
  // ---------------------------------------------------------------------------

  function log(message, type = 'info') {
    const item = document.createElement('li');
    item.className = `log-${type}`;
    const time = document.createElement('time');
    time.textContent = new Date().toLocaleTimeString();
    item.append(time, ' ', message);
    $('activity-list').prepend(item);
    $('activity-count').textContent = String($('activity-list').children.length);
    if (type === 'error') $('activity').open = true;
  }

  function banner(message, type = 'error') {
    const el = $('banner');
    el.textContent = message;
    el.className = `banner banner-${type}`;
    el.hidden = !message;
  }

  function reportError(error) {
    banner(error.message);
    log(error.message, 'error');
  }

  // ---------------------------------------------------------------------------
  // "No credits" dialog: ask the administrator for more
  // ---------------------------------------------------------------------------

  const KIND_LABELS = { triage: 'AI Triage', remediation: 'AI Remediation' };

  /** refusals: [{error, credits: {projectName, kind, needed, left, adminContact}}] */
  function showCreditDialog(refusals) {
    const dialog = $('credit-dialog');
    const needs = refusals.map((r) => r.credits).filter(Boolean);
    const text = refusals.map((r) => r.error).join(' ');
    for (const r of refusals) log(r.error, 'error');
    const to = needs.find((n) => n.adminContact)?.adminContact || contact();
    if (!dialog || typeof dialog.showModal !== 'function') {
      alert(`${text}\n\nAsk your administrator${to ? ` (${to})` : ''} to allocate more credits.`);
      return;
    }
    const kind = KIND_LABELS[needs[0]?.kind] || 'AI Triage';
    $('credit-dialog-title').textContent = `No ${kind} credits left`;
    $('credit-dialog-text').textContent = text;
    const mail = $('credit-dialog-mail');
    $('credit-dialog-to').textContent = to ? `Administrator: ${to}` : '';
    if (to) {
      const lines = needs.map((n) => `- ${n.projectName || n.projectId}: ${n.needed} ${KIND_LABELS[n.kind] || n.kind} credit(s) needed, ${n.left} left`);
      const subject = `Credits request: ${kind} for ${[...new Set(needs.map((n) => n.projectName || n.projectId))].join(', ') || 'my report'}`;
      const body = `Hi,\n\nPlease allocate more Checkmarx One credits so I can act on findings from my report:\n\n${lines.join('\n') || text}\n\nThank you.`;
      mail.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      mail.textContent = 'Email the administrator';
      mail.title = to;
      mail.hidden = false;
    } else {
      mail.hidden = true;
      $('credit-dialog-text').textContent = `${text} Contact your Checkmarx One reminder administrator.`;
    }
    if (!dialog.open) dialog.showModal();
  }

  /** Is this refusal about credits (the project's allocation or the monthly limit)? */
  const isCreditRefusal = (status, body) => status === 402 && (Boolean(body?.credits) || !/busy/i.test(body?.error || ''));

  // ---------------------------------------------------------------------------
  // The reminder server relay
  // ---------------------------------------------------------------------------

  const wire = (f) => ({
    projectId: f.projectId,
    projectName: f.projectName,
    riskId: f.riskId,
    scanId: f.scanId,
    scanner: f.scanner,
    alternateId: f.alternateId,
    groupId: f.groupId,
    exp: f.exp,
    grant: f.grant,
  });

  function relayBackend() {
    const base = String(config.relayUrl || '').replace(/\/+$/, '');

    let reached = false; // answered at least once: losing it now means a restart, not a wrong address
    async function post(path, body, attempt = 0, timeoutMs = 0, offline = 0) {
      let response;
      const controller = timeoutMs && typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller && setTimeout(() => controller.abort(), timeoutMs);
      try {
        response = await fetch(base + path, {
          method: 'POST',
          signal: controller?.signal,
          headers: { 'Content-Type': 'application/json' },
          // Who this report was made for (signed): the server's audit log attributes actions to it.
          body: JSON.stringify(config.report ? { ...body, report: config.report } : body),
        });
      } catch {
        if (timer) clearTimeout(timer);
        // No answer at all: the server may be restarting for an update (a few seconds).
        // Nothing reached it, so asking again is safe; the server never sends one finding twice anyway.
        if (reached && !controller?.signal.aborted && offline < 6) {
          serverState('Reconnecting…', 'warn');
          await sleep(2000);
          return post(path, body, attempt, timeoutMs, offline + 1);
        }
        serverState('Unreachable', 'bad');
        throw new CxError(`Cannot reach the reminder server at ${base}. It must be running and reachable from this computer (company network or VPN). If it moved, use "Change" next to its address.`);
      }
      reached = true;
      if (offline) serverState('Connected', 'good'); // back after a restart
      let parsed = null;
      try {
        parsed = await response.json();
      } catch {}
      // Busy: the server turned the request away before doing anything, so
      // waiting as asked and trying again is always safe.
      if ((response.status === 503 && parsed?.busy) || response.status === 429) {
        if (attempt < 6) {
          const wait = (Number(response.headers.get('Retry-After')) || parsed?.retryAfter || 3) * 1000;
          await sleep(wait * (0.8 + Math.random() * 0.4));
          return post(path, body, attempt + 1);
        }
      }
      if (!response.ok) throw new CxError(parsed?.error || `The reminder server answered ${response.status}.`, response.status, parsed);
      return parsed;
    }

    // Answers that came with the opening call, used once by the first ask for
    // each finding (and only for a few seconds), so opening is one round trip.
    const early = { triage: new Map(), remediation: new Map(), credits: null };
    let earlyUntil = 0;
    const takeEarly = (map, list) => {
      const out = new Array(list.length);
      const rest = [];
      const valid = Date.now() < earlyUntil;
      list.forEach((f, i) => {
        if (valid && map.has(f)) out[i] = map.get(f);
        else rest.push(i);
        map.delete(f);
      });
      return { out, rest };
    };
    async function batched(path, list, map) {
      const { out, rest } = takeEarly(map, list);
      for (let i = 0; i < rest.length; i += 200) {
        const part = rest.slice(i, i + 200);
        const answer = await post(path, { findings: part.map((index) => wire(list[index])) });
        part.forEach((index, k) => (out[index] = answer.results[k]));
      }
      return out;
    }
    // One signed finding per project is enough to ask about that project.
    const perProject = () => {
      const one = new Map();
      for (const f of findings) if (f.grant && !one.has(f.projectId)) one.set(f.projectId, f);
      return [...one.values()];
    };

    return {
      async connect() {
        // Bounded: an address that never answers must not leave the report "connecting" for minutes.
        // One call brings the status, the credits and where every finding stands. A server
        // from before that call answers 404, and the report asks the separate questions instead.
        const triageList = findings.filter((f) => !f.aiUnavailable && f.grant).slice(0, 500);
        const remediationList = remediationCandidates().filter((f) => f.grant).slice(0, 500);
        const creditList = perProject().slice(0, 500);
        let hello;
        try {
          hello = await post('/api/relay/hello', {
            credits: creditList.map(wire),
            findings: triageList.map(wire),
            remediation: remediationList.map(wire),
          }, 0, 15000);
        } catch (error) {
          // An older server (404), or a list it turned down: ask the separate questions, as reports always did.
          if (!(error.status >= 400 && error.status < 500 && error.status !== 429)) throw error;
          return post('/api/relay/status', {}, 0, 15000);
        }
        earlyUntil = Date.now() + 10_000;
        hello.triageResults?.results?.forEach((answer, i) => early.triage.set(triageList[i], answer));
        hello.remediationStatus?.results?.forEach((answer, i) => early.remediation.set(remediationList[i], answer));
        if (hello.projects) early.credits = { projects: hello.projects, creditsRemaining: hello.creditsRemaining };
        return hello;
      },
      async credits() {
        if (early.credits && Date.now() < earlyUntil) {
          const answer = early.credits;
          early.credits = null;
          updateCredits(answer.projects);
          showCredits(answer.creditsRemaining);
          return;
        }
        const list = perProject();
        if (!list.length) return;
        const answer = await post('/api/relay/credits', { findings: list.map(wire) });
        updateCredits(answer.projects);
        showCredits(answer.creditsRemaining);
      },
      async triage(list) {
        const answer = await post('/api/relay/triage', { findings: list.map(wire) });
        showCredits(answer.creditsRemaining);
        updateCredits(answer.projects, true);
        return answer.results;
      },
      results(list) {
        return batched('/api/relay/triage-results', list, early.triage);
      },
      async remediate(f) {
        const answer = await post('/api/relay/remediate', { findings: [wire(f)] });
        showCredits(answer.creditsRemaining);
        updateCredits(answer.projects, true);
        return answer;
      },
      remediationDetails(f) {
        return post('/api/relay/remediation-details', { findings: [wire(f)] });
      },
      /** One project's own report, built by the server (signed link from this report). */
      projectReport(p) {
        return post('/api/relay/project-report', { projectId: p.projectId, projectName: p.projectName, exp: p.exp, sig: p.sig, scope: p.scope }, 0, 180000);
      },
      remediationStatus(list) {
        return batched('/api/relay/remediation-status', list, early.remediation);
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  /**
   * What to show for a finding: AI Triage's verdict when it has a definite
   * one, otherwise the finding's own Checkmarx One state once it has moved
   * past "To verify" (that is what Risk Hub shows).
   */
  function effectiveStatus(f) {
    const ai = f.triage?.status || '';
    if (ai && !WAITING.has(ai)) return ai;
    if (f.state && f.state !== 'TO_VERIFY') return f.state;
    return ai;
  }

  const hasVerdict = (f) => {
    const status = effectiveStatus(f);
    return f.settled || (Boolean(status) && !WAITING.has(status) && status !== 'FAILED');
  };

  /** Fold an answer from the relay into the finding: its live state and AI Triage record. */
  function applyAnswer(f, answer) {
    if (answer?.state) f.state = answer.state;
    // Sent for AI Triage through the reminder server: it stays "To verify" in
    // Checkmarx One when judged vulnerable, so the state alone cannot say so.
    if (answer?.triagedAt) f.triagedAt = answer.triagedAt;
    if (answer?.stateError) stateErrors.add(answer.stateError);
    const ai = answer?.found ? triageFromBody(answer.body) : null;
    if (ai) f.triage = { ...ai, note: '' };
  }

  /** Marked not exploitable (or proposed so) by AI Triage or in Checkmarx One: never shown in the report. */
  const notExploitable = (f) => NOT_EXPLOITABLE.has(f.state) || NOT_EXPLOITABLE.has(f.triage?.status);

  function renderTriage(f) {
    if (notExploitable(f)) {
      if (!f.hidden) {
        if (f.touched) log(`AI Triage: ${f.title} → ${(VERDICTS[f.triage?.status] || VERDICTS[f.state] || ['not exploitable'])[0]} — removed from this report.`, 'success');
        hideNotExploitable(f);
      }
      updateBulk();
      return;
    }
    const tr = row(f);
    if (tr) {
      const cell = tr.querySelector('.ai-cell');
      const btn = tr.querySelector('[data-action="triage"]');
      const t = f.triage || {};
      const status = effectiveStatus(f);
      const stateLabel = tr.querySelector('.state-label');
      if (stateLabel && f.state) stateLabel.textContent = STATE_LABELS[f.state] || f.state.replace(/_/g, ' ').toLowerCase();
      renderConfirmedWhy(f, tr);
      // AI cannot act on it (e.g. IaC): the "Manual fix" note from the report stays.
      if (f.aiUnavailable) {
        updateBulk();
        return;
      }
      cell.replaceChildren();
      if (status && status !== 'NOT_TRIAGED') {
        const [label, tone] = VERDICTS[status] || [status.replace(/_/g, ' ').toLowerCase(), 'muted'];
        const chip = document.createElement('span');
        chip.className = `chip chip-${tone}`;
        chip.textContent = label;
        cell.append(chip);
        const subs = [SUB_LABELS[t.reachability], SUB_LABELS[t.exploitability]].filter(Boolean);
        if (subs.length) {
          const sub = document.createElement('div');
          sub.className = 'sub';
          sub.textContent = subs.join(' · ');
          cell.append(sub);
        }
        if (t.summary) {
          const details = document.createElement('details');
          const summary = document.createElement('summary');
          summary.textContent = 'Why';
          const text = document.createElement('p');
          text.textContent = t.summary + (t.confidence ? ` (confidence ${t.confidence})` : '');
          details.append(summary, text);
          cell.append(details);
        }
      } else if (f.noRecord) {
        const chip = document.createElement('span');
        chip.className = 'chip chip-warn';
        chip.textContent = 'No verdict';
        const sub = document.createElement('div');
        sub.className = 'sub';
        sub.textContent = 'Sent for AI Triage, but Checkmarx One has not produced a result for this finding. Check it in Checkmarx One.';
        cell.append(chip, sub);
      } else if (f.triagedAt && !(t.status === 'IN_PROGRESS')) {
        const chip = document.createElement('span');
        chip.className = 'chip chip-muted';
        chip.textContent = 'Triaged';
        chip.title = `Sent for AI Triage on ${new Date(f.triagedAt).toLocaleString()}`;
        const sub = document.createElement('div');
        sub.className = 'sub';
        sub.textContent = f.state === 'TO_VERIFY' || !f.state
          ? `${new Date(f.triagedAt).toLocaleDateString()} · no verdict published yet — still “To verify” in Checkmarx One`
          : new Date(f.triagedAt).toLocaleDateString();
        cell.append(chip, sub);
      } else {
        cell.textContent = t.note || '—';
      }
      if (btn && !f.aiUnavailable) {
        const busy = t.status === 'IN_PROGRESS' && !hasVerdict(f);
        const done = hasVerdict(f) || Boolean(f.triagedAt);
        const locked = !busy && done && !retriageAllowed();
        btn.disabled = busy || locked;
        btn.textContent = busy ? 'Triaging…' : locked ? 'Triaged' : done ? 'Re-triage' : 'Triage';
        btn.title = locked ? 'Already triaged. Triaging again is switched off by your administrator.' : '';
      }
      // A verdict may have just confirmed it: Remediate follows.
      if (tr.querySelector('[data-action="remediate"]')) renderRemediation(f);
    }
    updateBulk();
  }

  function triageCandidates(severity) {
    return findings.filter(
      (f) => f.severity === severity && !f.hidden && !f.aiUnavailable && !isRunning(f) && !hasVerdict(f) && !f.triagedAt,
    );
  }

  const isRunning = (f) => f.triage?.status === 'IN_PROGRESS' && !hasVerdict(f);

  function updateBulk() {
    const running = findings.filter(isRunning).length;
    for (const btn of bulkButtons()) {
      const severity = btn.dataset.severity;
      const label = SEVERITY_LABELS[severity];
      const candidates = triageCandidates(severity);
      const n = candidates.length;
      const results = resultCount(candidates);
      const busy = findings.some((f) => f.severity === severity && isRunning(f));
      const any = findings.some((f) => f.severity === severity);
      btn.textContent = n
        ? results < n
          ? `Triage all ${label} (${n} findings · ${results} results)`
          : `Triage all ${label} (${n})`
        : busy
          ? `Triaging ${label}…`
          : any
            ? `All ${label} triaged`
            : `No ${label} findings`;
      btn.disabled = bulkRunning || n === 0;
      btn.title = results < n ? `${n} findings here are ${results} Checkmarx One results: rows sharing a result are triaged together and charged once, so this uses ${results} credit(s).` : '';
    }
    // Critical/high findings AI cannot act on (IaC, …): say so, rather than leave them looking forgotten.
    const manual = findings.filter((f) => f.shown && !f.hidden && f.aiUnavailable && (f.severity === 'CRITICAL' || f.severity === 'HIGH')).length;
    $('bulk-progress').textContent = [
      running ? `${running} triage job${running === 1 ? '' : 's'} running…` : '',
      manual ? `${manual} critical/high finding${manual === 1 ? '' : 's'} need${manual === 1 ? 's' : ''} a manual fix in Checkmarx One (AI Triage covers SAST and SCA only).` : '',
    ].filter(Boolean).join(' · ');
  }

  function setConnectedUI(tenant) {
    const btn = $('connect');
    btn.textContent = backend ? `✓ Connected to CxONE · ${tenant}` : 'Connect to CxONE for action';
    btn.classList.toggle('connected', Boolean(backend));
    if (!backend) $('bulk-credits').textContent = '';
  }

  /** null means the administrator set no monthly limit. */
  function showCredits(remaining) {
    if (!backend) return;
    $('bulk-credits').textContent =
      remaining === null || remaining === undefined
        ? 'AI Triage uses 1 credit per Checkmarx One result (rows that share one count once), AI Remediation 3.'
        : `AI Triage uses 1 credit per Checkmarx One result (rows that share one count once), AI Remediation 3 · ${remaining} left this month across all projects.`;
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  /** Merge fresh balances; with `flash`, highlight the projects whose balance moved. */
  function updateCredits(projects, flash = false) {
    if (!projects) return;
    const moved = new Set();
    for (const [id, c] of Object.entries(projects)) {
      const before = credits[id];
      if (before && (before.triage.remaining !== c.triage.remaining || before.remediation.remaining !== c.remediation.remaining)) {
        moved.add(id);
        const used = (kind) => before[kind].remaining - c[kind].remaining;
        const parts = [
          used('triage') > 0 ? `${plural(used('triage'), 'triage credit')} used, ${c.triage.remaining} left` : '',
          used('remediation') > 0 ? `${plural(used('remediation'), 'remediation credit')} used, ${c.remediation.remaining} left` : '',
        ].filter(Boolean);
        if (parts.length) log(`${projectNames.get(id) || id}: ${parts.join('; ')}.`, 'info');
      }
      credits[id] = c;
    }
    renderCredits(flash ? moved : new Set());
  }

  function renderCredits(flash = new Set()) {
    const box = $('credit-balance');
    const ids = Object.keys(credits);
    box.hidden = !backend || ids.length === 0;
    if (box.hidden) return;
    const line = (label, k, unit) => {
      const out = k.remaining === 0;
      const pct = k.allocated ? Math.round((k.remaining / k.allocated) * 100) : 0;
      const div = document.createElement('div');
      const row = document.createElement('div');
      row.className = 'credit-line';
      const name = document.createElement('span');
      name.textContent = label;
      const value = document.createElement('b');
      value.className = out ? 'out' : '';
      value.textContent = k.allocated
        ? `${k.remaining} of ${k.allocated} left${unit ? ` (${unit(k.remaining)})` : ''}`
        : 'none allocated';
      row.append(name, value);
      const bar = document.createElement('div');
      bar.className = 'credit-bar';
      bar.title = `${k.used} used`;
      const fill = document.createElement('span');
      fill.style.width = `${pct}%`;
      bar.append(fill);
      div.append(row, bar);
      return div;
    };
    const cards = ids
      .sort((a, b) => (projectNames.get(a) || a).localeCompare(projectNames.get(b) || b))
      .map((id) => {
        const c = credits[id];
        const card = document.createElement('div');
        card.className = `credit-card${flash.has(id) ? ' credit-flash' : ''}`;
        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = projectNames.get(id) || id;
        card.append(
          name,
          line('AI Triage', c.triage, (n) => plural(n, 'result')),
          line('AI Remediation', c.remediation, (n) => plural(Math.floor(n / 3), 'remediation')),
        );
        return card;
      });
    $('credit-projects').replaceChildren(...cards);
  }

  /** "Payments: 5 left → 1 after" for a request's cost per project, for confirmations. */
  function afterText(list, kind, perFinding) {
    // Charged per Checkmarx One result, not per row: rows sharing a result count once.
    const cost = new Map();
    const seen = new Set();
    for (const f of list) {
      if (seen.has(resultKey(f))) continue;
      seen.add(resultKey(f));
      cost.set(f.projectId, (cost.get(f.projectId) ?? 0) + perFinding);
    }
    const lines = [...cost].map(([id, n]) => {
      const left = credits[id]?.[kind]?.remaining;
      const name = projectNames.get(id) || id;
      if (left === undefined) return `${name}: ${n} credit(s)`;
      return left < n
        ? `${name}: needs ${n}, only ${left} left`
        : `${name}: ${n} credit(s) — ${left} left now, ${left - n} after`;
    });
    return lines.length ? `\n\n${lines.join('\n')}` : '';
  }

  // ---------------------------------------------------------------------------
  // AI Triage
  // ---------------------------------------------------------------------------

  function triageFromBody(body) {
    if (!body) return null;
    const status = body.triageStatus || (body.jobStatus === 'IN_PROGRESS' ? 'IN_PROGRESS' : body.jobStatus === 'FAILED' ? 'FAILED' : '');
    if (!status) return null;
    const analysis = body.analysis || {};
    return {
      status,
      reachability: body.reachabilityStatus || analysis.reachability?.status || '',
      exploitability: body.exploitabilityStatus || analysis.exploitability?.status || '',
      summary: body.summary || '',
      confidence: analysis.confidence?.score || '',
      // Why AI Triage judged it so, and what it suggests: the first of the fields Checkmarx One fills.
      reason: firstText(body.reason, body.justification, body.explanation, body.reasoning, analysis.summary, analysis.exploitability?.reason,
        analysis.exploitability?.justification, analysis.exploitability?.explanation, analysis.exploitability?.description,
        analysis.reachability?.reason, analysis.reachability?.explanation, body.summary),
      recommendation: firstText(body.recommendation, body.recommendedFix, body.fixRecommendation, typeof body.remediation === 'string' ? body.remediation : '',
        analysis.recommendation, analysis.mitigation, analysis.remediation?.recommendation, analysis.remediation?.description),
    };
  }

  const firstText = (...values) => values.find((v) => typeof v === 'string' && v.trim())?.trim() || '';

  // ---------------------------------------------------------------------------
  // "Why confirmed": under the state, why it was confirmed and how to fix it,
  // with "why?" for the details (the same note html-report.js renders).
  // ---------------------------------------------------------------------------

  const CONFIRMED = new Set(['CONFIRMED', 'URGENT', 'VULNERABLE']);
  const firstSentence = (text, max = 120) => {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    const sentence = (/^.+?[.!?](?=\s|$)/.exec(clean) || [clean])[0];
    if (sentence.length <= max) return sentence;
    const cut = sentence.slice(0, max);
    const at = Math.max(cut.lastIndexOf(', '), cut.lastIndexOf('; '));
    return `${(at > max / 2 ? cut.slice(0, at) : cut.slice(0, cut.lastIndexOf(' '))).replace(/[,;:]$/, '')}…`;
  };
  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((c) => c !== null && c !== undefined && c !== ''));
    return node;
  };
  const para = (label, text, className) => el('p', className ? { className } : {}, el('b', { textContent: label }), ` ${text}`);

  /** How Checkmarx One knows, by engine (the same words as howKnown in html-report.js). */
  function howKnown(scanner) {
    const engine = String(scanner || '').toUpperCase();
    if (engine === 'SCA') return 'This project uses a version of the package with a published vulnerability that its code can reach; a fixed version removes it.';
    if (engine === 'SAST') return 'Checkmarx One followed the data from where it enters the application to this code, and nothing on the way makes it safe.';
    return 'Checkmarx One matched this code or configuration against a known vulnerable pattern.';
  }

  function renderConfirmedWhy(f, tr) {
    const box = tr.querySelector('.state-why');
    if (!box || f.aiUnavailable) return;
    const t = f.triage || {};
    if (!CONFIRMED.has(f.state) && !CONFIRMED.has(t.status)) {
      box.replaceChildren();
      return;
    }
    // Said once: Why and Fix; "why?" adds only what those two lines do not say.
    const advice = f.advice || { what: 'Checkmarx One judged this finding a real vulnerability.', fix: 'Remediate asks AI Remediation for a fix.' };
    const verdict = [t.reachability, t.exploitability].filter(Boolean).map((v) => v.replace(/_/g, ' ').toLowerCase()).join(' and ');
    const whyFull = t.reason || advice.what;
    const fixFull = t.recommendation || advice.fix;
    const why = firstSentence(whyFull, 160);
    const fix = firstSentence(fixFull, 160);
    const more = [
      why !== whyFull ? whyFull : howKnown(f.scanner),
      verdict && `AI Triage judged it ${verdict}${t.confidence ? ` (confidence ${t.confidence})` : ''}.`,
      t.reason && advice.what !== t.reason ? `This kind of finding: ${advice.what}` : '',
      fix !== fixFull ? `Fix in full: ${fixFull}` : '',
    ].filter(Boolean);
    const details = el('details', { className: 'why-more' }, el('summary', { textContent: 'why?' }), ...more.map((text) => el('p', { textContent: text })));
    const next = el('p', {}, config.remediateHere ? 'Remediate asks Checkmarx One AI Remediation for the code change (a pull request when the project is connected to its repository).' : 'Checkmarx One shows the full data flow.');
    if (f.url) next.append(' ', el('a', { href: f.url, target: '_blank', rel: 'noopener', textContent: 'Open in Checkmarx One' }));
    details.append(next);
    box.replaceChildren(para('Why:', why, 'why-line'), para('Fix:', fix, 'why-line'), details);
  }

  async function pollTriage(list) {
    const deadline = Date.now() + TRIAGE_TIMEOUT_MS;
    let waiting = list.slice();
    let interval = POLL_MS;
    while (waiting.length && backend && Date.now() < deadline) {
      // Jittered, and slower while nothing changes, so many open reports do not poll in step.
      await sleep(interval * (0.85 + Math.random() * 0.3));
      const answers = await backend.results(waiting);
      const before = waiting.length;
      const still = [];
      waiting.forEach((f, i) => {
        applyAnswer(f, answers[i]);
        const status = effectiveStatus(f);
        const sentAt = Date.parse(f.triagedAt || '') || f.sentAt || Date.now();
        if (answers[i]?.found === false && !answers[i]?.pending && Date.now() - sentAt > NO_RECORD_MS && (!status || status === 'IN_PROGRESS' || status === 'TO_VERIFY')) {
          f.triage = { status: '' };
          f.noRecord = true;
          renderTriage(f);
          log(`AI Triage: ${f.title} → no result from Checkmarx One ${Math.round((Date.now() - sentAt) / 60000)} min after it was sent. The report keeps checking.`, 'error');
          return;
        }
        if (status && !WAITING.has(status)) {
          f.settled = true;
          renderTriage(f);
          log(`AI Triage: ${f.title} → ${(VERDICTS[status] || [status])[0]}`, status === 'FAILED' ? 'error' : 'success');
        } else {
          still.push(f);
        }
      });
      waiting = still;
      interval = waiting.length < before ? POLL_MS : Math.min(MAX_POLL_MS, Math.round(interval * 1.3));
    }
    for (const f of waiting) {
      // Analysis finished without changing the finding: it stays "To verify".
      if (effectiveStatus(f) === 'TO_VERIFY') f.settled = true;
      else f.triage = { ...(f.triage || {}), status: '', note: 'Still running — see Checkmarx One' };
      renderTriage(f);
    }
    if (waiting.length) log(`${waiting.length} finding(s) had no final AI Triage verdict yet; see Checkmarx One for the latest.`, 'info');
  }

  async function triage(list) {
    const results = await backend.triage(list);
    const started = [];
    const refusals = [];
    for (const result of results) {
      const group = list.filter((f) => result.alternateIds.includes(f.alternateId));
      if (result.ok) {
        for (const f of group) {
          f.touched = true;
          f.sentAt = Date.now();
          f.noRecord = false;
          f.triage = { status: 'IN_PROGRESS' };
          f.settled = false;
          if (f.state && f.state !== 'TO_VERIFY') f.state = 'TO_VERIFY';
          renderTriage(f);
        }
        started.push(...group);
        log(
          result.published
            ? `AI Triage started for ${group.length} finding(s).`
            : `AI Triage already running for ${group.length} finding(s); following it.`,
          'pending',
        );
      } else if (result.retriage) {
        // The server found it already triaged (e.g. in Checkmarx One since this report loaded):
        // show its current state instead.
        log(result.error, 'info');
        backend
          .results(group)
          .then((answers) =>
            group.forEach((f, i) => {
              applyAnswer(f, answers[i]);
              f.settled = true;
              renderTriage(f);
            }),
          )
          .catch(reportError);
      } else if (isCreditRefusal(result.status, result)) {
        refusals.push(result);
        if (result.credits) {
          const c = credits[result.credits.projectId];
          if (c) updateCredits({ [result.credits.projectId]: { ...c, triage: { ...c.triage, remaining: result.credits.left } } });
        }
      } else {
        reportError(new CxError(result.error, result.status));
      }
    }
    if (refusals.length) showCreditDialog(refusals);
    // Results arrive over minutes; follow them in the background so other
    // actions stay available meanwhile.
    if (started.length) pollTriage(started).catch(reportError);
  }

  /** A whole request refused for credits opens the dialog; anything else is reported. */
  function handleActionError(error) {
    if (isCreditRefusal(error.status, error.body)) showCreditDialog([{ error: error.message, credits: error.body?.credits }]);
    else reportError(error);
  }

  async function bulkTriage(severity) {
    const list = triageCandidates(severity);
    if (!list.length) return;
    const label = SEVERITY_LABELS[severity];
    const projects = new Set(list.map((f) => f.projectId)).size;
    const where = projects > 1 ? ` across ${projects} projects` : '';
    const results = resultCount(list);
    const shared = results < list.length ? ` They are ${results} Checkmarx One results: rows sharing a result are triaged together and charged once.` : '';
    if (!confirm(`Run AI Triage on all ${list.length} ${label} finding(s)${where}?${shared} This uses ${results} Checkmarx One credit(s).${afterText(list, 'triage', 1)}`)) return;
    bulkRunning = true;
    updateBulk();
    try {
      await triage(list);
    } catch (error) {
      handleActionError(error);
    } finally {
      bulkRunning = false;
      updateBulk();
    }
  }

  function hideNotExploitable(f) {
    f.hidden = true;
    const tr = row(f);
    if (tr) tr.hidden = true;
    const n = findings.filter((x) => x.hidden && x.shown).length;
    const note = $('hidden-note');
    note.hidden = n === 0;
    note.textContent = `${n} finding${n === 1 ? '' : 's'} triaged as not exploitable (or proposed so) ${n === 1 ? 'is' : 'are'} not shown.`;
  }

  /**
   * Ask the server about `list`, then ask again (a few times, a little later
   * each time) about anything it said it was still looking up.
   */
  async function askUntilKnown(list, ask, onAnswer) {
    let pending = list;
    for (let round = 0; pending.length && backend && round < 8; round += 1) {
      if (round) await sleep(Math.min(15000, 2000 * 1.5 ** round) * (0.8 + Math.random() * 0.4));
      const answers = await ask(pending);
      const next = [];
      pending.forEach((f, i) => {
        if (answers[i]?.pending) next.push(f);
        onAnswer(f, answers[i]);
      });
      pending = next;
    }
  }

  async function loadExistingTriage() {
    const eligible = findings.filter((f) => !f.aiUnavailable);
    if (!eligible.length) return;
    const resumed = [];
    await askUntilKnown(eligible, (list) => backend.results(list), (f, answer) => {
      if (answer?.pending && !answer.state) return;
      applyAnswer(f, answer);
      // Already triaged as not exploitable: nothing left to do here, so it is skipped.
      if (notExploitable(f)) {
        renderTriage(f);
        return;
      }
      const ai = f.triage?.status;
      if (ai === 'IN_PROGRESS' && !hasVerdict(f) && !resumed.includes(f)) resumed.push(f);
      else if (ai === 'TO_VERIFY') f.settled = true;
      renderTriage(f);
    });
    const done = eligible.filter((f) => hasVerdict(f) || f.triagedAt).length;
    log(`Loaded Checkmarx One states: ${done} of ${eligible.length} eligible findings already triaged.`, 'success');
    reportStateErrors();
    markRefreshed();
    if (resumed.length) pollTriage(resumed).catch(reportError);
  }

  // ---------------------------------------------------------------------------
  // Keep the report current while it is open: triage done anywhere (another
  // copy of the report, the dashboard, Checkmarx One itself) shows up here.
  // ---------------------------------------------------------------------------

  const stateErrors = new Set();
  const REFRESH_MS = 60_000;
  let refreshing = false;
  let lastRefresh = 0;

  function reportStateErrors() {
    if (!stateErrors.size) return;
    const message = `Could not read current states from Checkmarx One: ${[...stateErrors][0]}`;
    log(message, 'error');
    banner(`${message} The report keeps trying every minute.`, 'warn');
    stateErrors.clear();
  }

  function markRefreshed() {
    lastRefresh = Date.now();
    const el = $('last-refresh');
    if (el) el.textContent = `Updated ${new Date(lastRefresh).toLocaleTimeString()}`;
  }

  async function refreshStates({ manual = false } = {}) {
    if (!backend || refreshing) return;
    refreshing = true;
    if (manual) $('last-refresh').textContent = 'Updating…';
    try {
      const list = findings.filter((f) => !f.aiUnavailable && !f.hidden);
      const answers = await backend.results(list);
      list.forEach((f, i) => {
        const answer = answers[i];
        if (!answer || (answer.pending && !answer.state && !answer.triagedAt)) return;
        applyAnswer(f, answer);
        if (answer.found === false && f.triage?.status === 'IN_PROGRESS' && f.triagedAt && Date.now() - Date.parse(f.triagedAt) > NO_RECORD_MS) {
          f.triage = { status: '' };
          f.noRecord = true;
        } else if (answer.found) {
          f.noRecord = false;
        }
        renderTriage(f);
      });
      reportStateErrors();
      markRefreshed();
      if (manual) log('Report refreshed from Checkmarx One.', 'success');
      backend.credits?.().catch(() => {});
    } catch (error) {
      log(`Could not refresh: ${error.message}`, 'error');
      if (manual) reportError(error);
      if ($('last-refresh')) $('last-refresh').textContent = 'Update failed — retrying';
    } finally {
      refreshing = false;
    }
  }

  setInterval(() => {
    if (document.visibilityState === 'visible' && Date.now() - lastRefresh >= REFRESH_MS) refreshStates();
  }, 15_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && backend && Date.now() - lastRefresh >= 15_000) refreshStates();
  });

  // ---------------------------------------------------------------------------
  // AI Remediation
  // ---------------------------------------------------------------------------

  /** Only web and blob links: a URL from a server response is never allowed to be javascript: or data:. */
  function safeHref(href) {
    try {
      const url = new URL(String(href), location.href);
      return ['http:', 'https:', 'blob:', 'mailto:'].includes(url.protocol) ? url.href : '';
    } catch {
      return '';
    }
  }

  function link(text, href, download) {
    const a = document.createElement('a');
    const safe = safeHref(href);
    if (!safe) {
      const span = document.createElement('span');
      span.textContent = text;
      return span;
    }
    a.href = safe;
    a.textContent = text;
    if (download) a.download = download;
    else {
      a.target = '_blank';
      a.rel = 'noopener';
    }
    return a;
  }

  /** Remediation details: null while running, {failed} or the finished result. */
  function remediationFromBody(body) {
    const r = body?.results?.[0];
    if (!r) return null;
    const job = String(r.jobStatus || r.status || '').toUpperCase();
    if (job === 'FAILED' || r.data?.error) return { failed: r.data?.error || r.autoPr?.error_msg || 'AI Remediation failed.' };
    const data = r.data;
    if (!r.finishedAt && !data?.summary && !data?.file_changes?.length) return null;
    const patch = (data?.file_changes || [])
      .filter((c) => c.diff)
      .map((c) => `# ${c.file_path}\n${c.analysis ? `# ${String(c.analysis).replace(/\n/g, '\n# ')}\n` : ''}${c.diff}\n`)
      .join('\n');
    return {
      summary: data?.summary || data?.analysis?.what || '',
      how: data?.analysis?.how || '',
      // From Checkmarx One via the relay: only an http(s) address becomes a link.
      prUrl: /^https?:\/\//i.test(String(r.autoPr?.url || '')) ? String(r.autoPr.url) : '',
      prStatus: String(r.autoPr?.status || ''),
      prError: r.autoPr?.error_msg || '',
      patch,
      files: (data?.file_changes || []).length,
    };
  }

  /** "#42" from a GitHub / GitLab / Azure DevOps / Bitbucket pull request address. */
  function prNumber(url) {
    const match = String(url).match(/\/(?:pull|pulls|merge_requests|pullrequest|pull-requests)\/(\d+)/i);
    return match ? `#${match[1]}` : '';
  }

  function renderRemediation(f) {
    const tr = row(f);
    if (!tr) return;
    const btn = tr.querySelector('[data-action="remediate"]');
    const out = tr.querySelector('.fix-cell');
    const r = f.remediation;
    out.replaceChildren();
    out.className = 'fix-cell';
    if (btn) {
      const done = isRemediated(f);
      const locked = done && !reremediationAllowed();
      // The fence: only a finding triaged and confirmed can be remediated.
      const fenced = !done && !r?.running && !isConfirmed(f);
      btn.disabled = r?.running === true || locked || fenced;
      btn.textContent = r?.running ? 'Remediating…' : locked ? 'Remediated' : done ? 'Re-remediate' : 'Remediate';
      btn.title = locked
        ? 'Already remediated. Remediating again is switched off by your administrator.'
        : fenced ? 'Remediate works once triage has confirmed this finding (state Confirmed).' : '';
    }
    if (!r) return;
    if (r.running) {
      out.textContent = 'AI Remediation running in Checkmarx One — it triages the finding, writes a fix and opens a pull request. This can take several minutes.';
      return;
    }
    if (r.failed) {
      out.className = 'fix-cell fix-failed';
      out.textContent = r.failed;
      return;
    }
    const headline = document.createElement('p');
    headline.className = 'fix-headline';
    if (r.doneElsewhere) {
      headline.textContent = '✓ Already remediated';
      out.append(headline);
      if (f.url) out.append(link('View the fix in Checkmarx One', f.url));
      return;
    }
    if (r.prUrl) {
      headline.append('✓ Remediation opened ');
      const pr = link(`PR ${prNumber(r.prUrl) || ''}`.trim(), r.prUrl);
      pr.style.display = 'inline';
      headline.append(pr);
    } else if (r.prError) {
      headline.textContent = `✓ Fix suggested — no pull request: ${r.prError}`;
    } else {
      headline.textContent = '✓ Fix suggested (no pull request: the project is not connected to a code repository)';
    }
    out.append(headline);
    if (r.summary) {
      const p = document.createElement('p');
      p.textContent = r.summary;
      out.append(p);
    }
    if (f.url) out.append(link('View the fix in Checkmarx One', f.url));
    if (r.patch) {
      const blob = URL.createObjectURL(new Blob([r.patch], { type: 'text/x-diff' }));
      out.append(link(`Download patch (${r.files} file${r.files === 1 ? '' : 's'})`, blob, `${f.title.replace(/[^\w.-]+/g, '_').slice(0, 60)}.patch`));
    }
  }

  /** Poll Checkmarx One until the remediation for `f` has a result. */
  async function followRemediation(f) {
    const deadline = Date.now() + REMEDIATION_TIMEOUT_MS;
    while (Date.now() < deadline && backend) {
      await sleep(REMEDIATION_POLL_MS);
      const answer = await backend.remediationDetails(f);
      const result = answer?.found ? remediationFromBody(answer.body) : null;
      if (!result) continue;
      f.remediation = result;
      renderRemediation(f);
      if (result.failed) {
        log(`AI Remediation failed for ${f.title}: ${result.failed}`, 'error');
      } else {
        log(`AI Remediation ready: ${f.title}${result.prUrl ? ` — opened PR ${prNumber(result.prUrl)}`.trimEnd() : ''}`, 'success');
      }
      return;
    }
    f.remediation = { failed: 'Still running — the result will appear on the finding in Checkmarx One.' };
    renderRemediation(f);
  }

  /** Confirmed in Checkmarx One: the only state AI Remediation runs on. */
  const isConfirmed = (f) => f.state === 'CONFIRMED';

  async function remediate(f) {
    if (f.remediation?.running) return;
    if (!isConfirmed(f)) return renderRemediation(f);
    if (isRemediated(f) && !reremediationAllowed()) return renderRemediation(f);
    if (backend.remediationAllowed === false) {
      // The administrator may have allowed it since this report connected.
      try {
        backend.remediationAllowed = (await backend.connect()).remediation !== false;
      } catch {}
      if (backend.remediationAllowed === false) {
        f.remediation = { failed: 'AI Remediation from reports is switched off. Ask your Checkmarx One reminder administrator to allow it.' };
        return renderRemediation(f);
      }
    }
    const again = isRemediated(f) ? ' again' : '';
    if (!confirm(`Run Checkmarx One AI Remediation${again} for "${f.title}"? It uses 3 Checkmarx One credits and, for repository-connected projects, opens a pull request.${afterText([f], 'remediation', 3)}`)) return;
    const previous = f.remediation;
    f.remediation = { running: true };
    renderRemediation(f);
    try {
      const started = await backend.remediate(f);
      log(started.published ? `AI Remediation started: ${f.title}` : `AI Remediation already running for ${f.title}; following it.`, 'pending');
    } catch (error) {
      if (error.status === 409 && error.body?.running) {
        log(`AI Remediation already running for ${f.title}; following it.`, 'pending');
      } else if (error.status === 409 && error.body?.remediated) {
        // Remediated meanwhile (in Checkmarx One, or from another report): show that result.
        f.remediation = remediationFromBody(error.body.body) || previous || { doneElsewhere: true };
        log(error.message, 'info');
        return renderRemediation(f);
      } else if (isCreditRefusal(error.status, error.body)) {
        updateCredits(error.body?.projects);
        f.remediation = previous ?? null;
        renderRemediation(f);
        return showCreditDialog([{ error: error.message, credits: error.body?.credits }]);
      } else {
        // Not confirmed in Checkmarx One after all: show its real state; Remediate stays locked.
        if (error.body?.notConfirmed && error.body.state) f.state = error.body.state;
        f.remediation = { failed: error.message };
        log(error.message, 'error');
        renderTriage(f);
        return renderRemediation(f);
      }
    }
    await followRemediation(f).catch((error) => {
      f.remediation = { failed: error.message };
      renderRemediation(f);
    });
  }

  /** Show remediations already done (or running) for the findings in this report. */
  /** The findings whose remediation state the report shows. */
  function remediationCandidates() {
    return findings.filter((f) => f.shown && !f.hidden && !f.aiUnavailable && row(f)?.querySelector('[data-action="remediate"]'));
  }

  async function loadExistingRemediation() {
    const eligible = remediationCandidates();
    if (!eligible.length) return;
    let done = 0;
    await askUntilKnown(eligible, (list) => backend.remediationStatus(list), (f, a) => {
      if (!a || a.pending || f.remediation?.running) return;
      if (a.status === 'done') {
        f.remediation = remediationFromBody(a.body) || { doneElsewhere: true };
        if (f.remediation.failed) f.remediation = { doneElsewhere: true };
        done += 1;
        renderRemediation(f);
      } else if (a.status === 'running') {
        f.remediation = { running: true };
        renderRemediation(f);
        followRemediation(f).catch(reportError);
      } else if (a.status === 'failed') {
        f.remediation = remediationFromBody(a.body);
        renderRemediation(f);
      }
    });
    if (done) log(`${done} finding(s) in this report are already remediated.`, 'info');
  }

  // ---------------------------------------------------------------------------
  // One project's own report (a report covering several projects)
  // ---------------------------------------------------------------------------

  function projectReportStatus(text, kind = '') {
    const el = $('project-report-status');
    if (!el) return;
    el.hidden = !text;
    el.textContent = text;
    el.className = `muted ${kind}`;
  }

  /**
   * Ask the reminder server for one project's report, then open it in a new tab and
   * download it. The tab is opened at the click (later, a browser would block it) and
   * filled once the report arrives. Nothing here goes to Checkmarx One.
   */
  async function openProjectReport(p, button) {
    if (!p) return;
    if (!config.relayUrl) {
      openServerForm(`Enter the reminder server address to open the report for ${p.projectName}.`);
      return;
    }
    const tab = window.open('', '_blank');
    if (tab) {
      try {
        tab.document.title = `${p.projectName} — building the report…`;
        tab.document.body.innerHTML = '<p style="font:16px system-ui,sans-serif;padding:32px;color:#374151">Building the report…</p>';
        tab.document.body.firstChild.textContent = `Building the report for ${p.projectName}…`;
      } catch {}
    }
    button.disabled = true;
    projectReportStatus(`Building the report for ${p.projectName} (${p.count} finding${p.count === 1 ? '' : 's'})…`);
    try {
      const answer = await relayBackend().projectReport(p);
      const url = URL.createObjectURL(new Blob([answer.html], { type: 'text/html' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = answer.filename || 'project-report.html';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      let shown = false;
      if (tab && !tab.closed) {
        try {
          tab.document.open();
          tab.document.write(answer.html);
          tab.document.close();
          shown = true;
        } catch {}
      }
      const where = shown ? 'opened in a new tab and downloaded' : 'downloaded (allow pop-ups for this page to open it in a tab too)';
      projectReportStatus(`The report for ${p.projectName} was ${where} as ${link.download}.`, 'ok');
      log(`Report for ${p.projectName}: ${where}.`, 'success');
    } catch (error) {
      if (tab && !tab.closed) tab.close();
      projectReportStatus(`Could not build the report for ${p.projectName}: ${error.message}`, 'error');
      reportError(error);
    } finally {
      button.disabled = false;
    }
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('button[data-project-report]');
    if (button) openProjectReport((DATA.projectReports || [])[Number(button.dataset.projectReport)], button);
  });

  // ---------------------------------------------------------------------------
  // Connect
  // ---------------------------------------------------------------------------

  async function connect({ quiet = false } = {}) {
    const candidate = relayBackend();
    const status = await candidate.connect();
    candidate.remediationAllowed = status.remediation !== false;
    candidate.retriageAllowed = status.retriage === true;
    candidate.reremediationAllowed = status.reremediation === true;
    candidate.adminContact = status.adminContact || '';
    backend = candidate;
    try {
      sessionStorage.setItem(STORE, 'relay');
    } catch {}
    setConnectedUI(status.tenant);
    showServer();
    serverState('Connected', 'good');
    $('server-prompt').hidden = true;
    showCredits(status.creditsRemaining);
    updateBulk();
    banner('');
    if (!quiet) log(`Connected to Checkmarx One (${status.tenant}) through the reminder server.`, 'success');
    for (const f of findings) if (hasVerdict(f)) renderTriage(f);
    loadExistingTriage().catch(reportError);
    loadExistingRemediation().catch(reportError);
    candidate.credits().catch((error) => log(`Could not read credits: ${error.message}`, 'error'));
  }

  function disconnect() {
    backend = null;
    try {
      sessionStorage.removeItem(STORE);
    } catch {}
    setConnectedUI();
    showServer();
    renderCredits();
    updateBulk();
    log('Disconnected from Checkmarx One.', 'info');
  }

  /** Connect first if needed (once, however many buttons are clicked), then act. */
  function requireConnection(action) {
    if (backend) return action();
    if (!config.relayUrl) {
      openServerForm('Enter the reminder server address to connect.');
      return;
    }
    connecting ??= connect().finally(() => {
      connecting = null;
    });
    connecting.then(action, reportError);
  }

  // ---------------------------------------------------------------------------
  // Reminder server address: shown, checked, and correctable by the reader
  // ---------------------------------------------------------------------------

  const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i;

  function serverState(text, kind = '') {
    const el = $('server-state');
    el.textContent = text;
    el.className = `server-state ${kind}`;
  }

  function showServer() {
    const url = String(config.relayUrl || '').replace(/\/+$/, '');
    $('server-url').textContent = url || 'not set';
    $('server-change').textContent = url ? 'Change' : 'Enter address';
    $('server-reset').hidden = !ORIGINAL_SERVER || url === ORIGINAL_SERVER;
    if (!url) serverState('Needed to triage from this report', 'warn');
    else if (url !== ORIGINAL_SERVER) serverState('Changed in this browser', 'warn');
    else {
      try {
        serverState(LOOPBACK.test(new URL(url).hostname) ? 'Only reachable on the server’s own computer' : '', LOOPBACK.test(new URL(url).hostname) ? 'warn' : '');
      } catch {
        serverState('');
      }
    }
  }

  function openServerForm(message = '') {
    $('server-form').hidden = false;
    $('server-input').value = config.relayUrl ? String(config.relayUrl).replace(/\/+$/, '') : '';
    $('server-error').hidden = !message;
    $('server-error').textContent = message;
    $('server-error').style.color = message && !config.relayUrl ? 'var(--warn)' : '';
    $('server-input').focus();
  }

  /** Is this address a reminder server? Resolves with the clean address, or throws a readable reason. */
  async function checkServer(value) {
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    } catch {
      throw new CxError('That is not a web address, e.g. https://cx-reminder.example.com');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new CxError('Use an http or https address.');
    const base = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller && setTimeout(() => controller.abort(), 10000);
    let body = null;
    try {
      const response = await fetch(`${base}/api/relay/ping`, { signal: controller?.signal, cache: 'no-store' });
      body = await response.json().catch(() => null);
    } catch {
      throw new CxError(`No reminder server answered at ${base}. Check the address, and that you are on the company network or VPN.`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (body?.service !== 'mission-zero-relay') throw new CxError(`${base} answered, but it is not a reminder server. Check the address.`);
    return base;
  }

  async function useServer(base) {
    config.relayUrl = base;
    try {
      if (base && base !== ORIGINAL_SERVER) localStorage.setItem(SERVER_STORE, base);
      else localStorage.removeItem(SERVER_STORE);
    } catch {}
    if (backend) disconnect();
    showServer();
    $('server-form').hidden = true;
    log(`Reminder server set to ${base}.`, 'info');
    await connect();
  }

  $('server-change').addEventListener('click', () => ($('server-form').hidden ? openServerForm() : ($('server-form').hidden = true)));
  $('server-cancel').addEventListener('click', () => {
    $('server-form').hidden = true;
  });
  $('server-reset').addEventListener('click', () => {
    useServer(ORIGINAL_SERVER).catch(reportError);
  });
  $('server-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = $('server-form').querySelector('button[type="submit"]');
    submit.disabled = true;
    $('server-error').hidden = true;
    try {
      await useServer(await checkServer($('server-input').value.trim()));
    } catch (error) {
      $('server-error').style.color = '';
      $('server-error').textContent = error.message;
      $('server-error').hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  showServer();

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  $('connect').addEventListener('click', () => {
    if (!backend) return requireConnection(() => {});
    if (confirm('Disconnect from Checkmarx One?')) disconnect();
  });
  for (const btn of bulkButtons()) {
    btn.addEventListener('click', () => requireConnection(() => bulkTriage(btn.dataset.severity)));
  }
  $('findings').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-action="triage"], button[data-action="remediate"]');
    if (!btn) return;
    const f = byKey.get(btn.closest('tr').dataset.key);
    if (!f || f.aiUnavailable) return;
    if (btn.dataset.action === 'remediate') requireConnection(() => remediate(f));
    else requireConnection(() => (hasVerdict(f) && !retriageAllowed() ? renderTriage(f) : triage(sameAs(f)).catch(handleActionError)));
  });

  // Rows that are one Checkmarx One result light up together; following a link to a twin flashes it.
  const twins = (tr) => (tr?.dataset.result ? document.querySelectorAll(`tr[data-result="${CSS.escape(tr.dataset.result)}"]`) : []);
  $('findings').addEventListener('mouseover', (event) => {
    const tr = event.target.closest('tr.shared-row');
    for (const t of document.querySelectorAll('tr.twin-hi')) if (!tr || t.dataset.result !== tr.dataset.result) t.classList.remove('twin-hi');
    for (const t of twins(tr)) t.classList.add('twin-hi');
  });
  $('findings').addEventListener('mouseleave', () => {
    for (const t of document.querySelectorAll('tr.twin-hi')) t.classList.remove('twin-hi');
  });

  setConnectedUI();
  for (const f of findings) if (f.state && f.state !== 'TO_VERIFY') renderTriage(f);
  updateBulk();

  // ---------------------------------------------------------------------------
  // Connect on open: straight to the reminder server; if that fails, say why
  // and offer to connect (or to correct the address).
  // ---------------------------------------------------------------------------

  function showConnectPrompt(reason) {
    const prompt = $('server-prompt');
    $('server-prompt-text').textContent = reason;
    prompt.hidden = false;
  }

  function autoConnect() {
    if (!config.relayUrl) {
      serverState('Needed to triage from this report', 'warn');
      showConnectPrompt('This report does not say which reminder server to use. Enter its address to connect.');
      return;
    }
    serverState('Connecting…');
    $('server-prompt').hidden = true;
    connecting ??= connect({ quiet: true }).finally(() => {
      connecting = null;
    });
    connecting.then(
      () => log('Connected to the reminder server automatically.', 'success'),
      (error) => {
        log(`Could not connect automatically: ${error.message}`, 'error');
        if (/^(Connected|Unreachable)$/.test($('server-state').textContent) === false) serverState('Not connected', 'bad');
        showConnectPrompt(`Could not connect to the reminder server automatically: ${error.message}`);
      },
    );
  }

  $('server-connect').addEventListener('click', () => {
    if (!config.relayUrl) return openServerForm('Enter the reminder server address to connect.');
    autoConnect();
  });
  $('server-fix').addEventListener('click', () => openServerForm());
  $('refresh-now').addEventListener('click', () => (backend ? refreshStates({ manual: true }) : requireConnection(() => {})));

  autoConnect();
})();
