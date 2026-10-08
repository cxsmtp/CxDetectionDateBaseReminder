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

/**
 * The report's words in the reader's language. `L('Report for {0}: {1}.', name, where)` looks the
 * English up in the translations the report carries (the translator sets them before the report
 * starts) and puts the values in: names, addresses, numbers and Checkmarx One's own words go in as
 * values and are never translated. Without translations it is the English itself.
 */
const L = (text, ...values) => {
  const out = (window.MZReportWords && window.MZReportWords.get(text)) || text;
  return values.length ? out.replace(/\{(\d+)\}/g, (all, i) => (i < values.length ? String(values[i]) : all)) : out;
};

function reportMain() {
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

  // Looked up when shown (L), so a language chosen later applies to them too.
  const VERDICT_WORDS = {
    VULNERABLE: ['Vulnerable', 'bad'],
    PROPOSED_NOT_EXPLOITABLE: ['Probably safe (AI)', 'good'],
    NOT_EXPLOITABLE: ['Not exploitable', 'good'],
    UNCERTAIN: ['Uncertain', 'warn'],
    RISK_ACCEPTED: ['Risk accepted', 'muted'],
    TO_VERIFY: ['Not checked yet', 'muted'],
    CONFIRMED: ['Confirmed', 'bad'],
    URGENT: ['Urgent', 'bad'],
    FAILED: ['Triage failed', 'bad'],
    IN_PROGRESS: ['Triaging…', 'busy'],
  };
  const VERDICTS = new Proxy(VERDICT_WORDS, { get: (words, status) => (words[status] ? [L(words[status][0]), words[status][1]] : undefined) });
  const SUB_WORDS = {
    REACHABLE: 'Reachable',
    NOT_REACHABLE: 'Not reachable',
    EXPLOITABLE: 'Exploitable',
    NOT_EXPLOITABLE: 'Not exploitable',
  };
  const SUB_LABELS = new Proxy(SUB_WORDS, { get: (words, key) => (words[key] ? L(words[key]) : undefined) });
  /** The "triage all" button's words, per severity (each language has its own word order). */
  const BULK_WORDS = {
    CRITICAL: { all: 'Triage all critical ({0})', shared: 'Triage all critical ({0} findings · {1} results)', busy: 'Triaging critical…', done: 'All critical triaged', none: 'No critical findings',
      ask: 'Run AI Triage on all {0} critical finding(s)?', askAcross: 'Run AI Triage on all {0} critical finding(s) across {1} projects?' },
    HIGH: { all: 'Triage all high ({0})', shared: 'Triage all high ({0} findings · {1} results)', busy: 'Triaging high…', done: 'All high triaged', none: 'No high findings',
      ask: 'Run AI Triage on all {0} high finding(s)?', askAcross: 'Run AI Triage on all {0} high finding(s) across {1} projects?' },
  };
  const STATE_WORDS = {
    TO_VERIFY: 'Not checked yet',
    CONFIRMED: 'Confirmed',
    URGENT: 'Urgent',
    NOT_EXPLOITABLE: 'Not exploitable',
    PROPOSED_NOT_EXPLOITABLE: 'Probably safe (AI)',
  };
  const STATE_LABELS = new Proxy(STATE_WORDS, { get: (words, key) => (words[key] ? L(words[key]) : undefined) });

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
      alert(`${text}\n\n${to ? L('Ask your administrator ({0}) to allocate more credits.', to) : L('Ask your administrator to allocate more credits.')}`);
      return;
    }
    const kind = L(KIND_LABELS[needs[0]?.kind] || 'AI Triage');
    $('credit-dialog-title').textContent = needs[0]?.kind === 'remediation' ? L('No AI Remediation credits left') : L('No AI Triage credits left');
    $('credit-dialog-text').textContent = text;
    const mail = $('credit-dialog-mail');
    $('credit-dialog-to').textContent = to ? L('Administrator: {0}', to) : '';
    if (to) {
      const lines = needs.map((n) => `- ${L('{0}: {1} {2} credit(s) needed, {3} left', n.projectName || n.projectId, n.needed, L(KIND_LABELS[n.kind] || n.kind), n.left)}`);
      const subject = L('Credits request: {0} for {1}', kind, [...new Set(needs.map((n) => n.projectName || n.projectId))].join(', ') || L('my report'));
      const body = `${L('Hi,')}\n\n${L('Please allocate more Checkmarx One credits so I can act on findings from my report:')}\n\n${lines.join('\n') || text}\n\n${L('Thank you.')}`;
      mail.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      mail.textContent = L('Email the administrator');
      mail.title = to;
      mail.hidden = false;
    } else {
      mail.hidden = true;
      $('credit-dialog-text').textContent = `${text} ${L('Contact your Checkmarx One reminder administrator.')}`;
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
          body: JSON.stringify({ ...body, ...(config.report ? { report: config.report } : {}), ...(config.tenantId ? { tenantId: config.tenantId } : {}) }),
        });
      } catch {
        if (timer) clearTimeout(timer);
        // No answer at all: the server may be restarting for an update (a few seconds).
        // Nothing reached it, so asking again is safe; the server never sends one finding twice anyway.
        if (reached && !controller?.signal.aborted && offline < 6) {
          serverState(L('Reconnecting…'), 'warn');
          await sleep(2000);
          return post(path, body, attempt, timeoutMs, offline + 1);
        }
        serverState(L('Unreachable'), 'bad');
        throw new CxError(L('Cannot reach the reminder server at {0}. It must be running and reachable from this computer (company network or VPN). If it moved, use “Change” next to its address.', base));
      }
      reached = true;
      if (offline) serverState(L('Connected'), 'good', 'connected'); // back after a restart
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
      if (!response.ok) throw new CxError(parsed?.error || L('The reminder server answered {0}.', response.status), response.status, parsed);
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
      /** Where this tracked report's rescan stands, for its developer. */
      rescanState() {
        return post('/api/relay/rescan-state', { grant: config.rescan }, 0, 15000);
      },
      /** Start the rescan of their own fixes. */
      rescan() {
        return post('/api/relay/rescan', { grant: config.rescan });
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
      /** A signed link to this finding's fix as a patch, for git apply. */
      patchLink(f) {
        return post('/api/relay/patch-link', { findings: [wire(f)] });
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
        if (f.touched) log(L('AI Triage: {0} → {1} — removed from this report.', f.title, (VERDICTS[f.triage?.status] || VERDICTS[f.state] || [L('Not exploitable')])[0]), 'success');
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
          summary.textContent = L('Why');
          const text = document.createElement('p');
          text.textContent = t.summary + (t.confidence ? ` ${L('(confidence {0})', t.confidence)}` : '');
          details.append(summary, text);
          cell.append(details);
        }
      } else if (f.noRecord) {
        const chip = document.createElement('span');
        chip.className = 'chip chip-warn';
        chip.textContent = L('No verdict');
        const sub = document.createElement('div');
        sub.className = 'sub';
        sub.textContent = L('Sent for AI Triage, but Checkmarx One has not produced a result for this finding. Check it in Checkmarx One.');
        cell.append(chip, sub);
      } else if (f.triagedAt && !(t.status === 'IN_PROGRESS')) {
        const chip = document.createElement('span');
        chip.className = 'chip chip-muted';
        chip.textContent = L('Triaged');
        chip.title = L('Sent for AI Triage on {0}', new Date(f.triagedAt).toLocaleString());
        const sub = document.createElement('div');
        sub.className = 'sub';
        sub.textContent = f.state === 'TO_VERIFY' || !f.state
          ? L('{0} · no verdict published yet — still “To verify” in Checkmarx One', new Date(f.triagedAt).toLocaleDateString())
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
        btn.textContent = L(busy ? 'Triaging…' : locked ? 'Triaged' : done ? 'Re-triage' : 'Triage');
        btn.title = locked ? L('Already triaged. Triaging again is switched off by your administrator.') : '';
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
      const words = BULK_WORDS[severity];
      if (!words) continue;
      const candidates = triageCandidates(severity);
      const n = candidates.length;
      const results = resultCount(candidates);
      const busy = findings.some((f) => f.severity === severity && isRunning(f));
      const any = findings.some((f) => f.severity === severity);
      btn.textContent = n
        ? results < n
          ? L(words.shared, n, results)
          : L(words.all, n)
        : L(busy ? words.busy : any ? words.done : words.none);
      btn.disabled = bulkRunning || n === 0;
      btn.title = results < n ? L('{0} findings here are {1} Checkmarx One results: rows sharing a result are triaged together and charged once, so this uses {1} credit(s).', n, results) : '';
    }
    // Critical/high findings AI cannot act on (IaC, …): say so, rather than leave them looking forgotten.
    const manual = findings.filter((f) => f.shown && !f.hidden && f.aiUnavailable && (f.severity === 'CRITICAL' || f.severity === 'HIGH')).length;
    $('bulk-progress').textContent = [
      running ? L(running === 1 ? '{0} triage job running…' : '{0} triage jobs running…', running) : '',
      manual ? L(manual === 1 ? '{0} critical/high finding needs a manual fix in Checkmarx One (AI Triage covers SAST and SCA only).' : '{0} critical/high findings need a manual fix in Checkmarx One (AI Triage covers SAST and SCA only).', manual) : '',
    ].filter(Boolean).join(' · ');
  }

  let connectedTenant;
  function setConnectedUI(tenant) {
    connectedTenant = tenant;
    const btn = $('connect');
    btn.textContent = backend ? L('✓ Connected to Checkmarx One · {0}', tenant) : L('Connect to act on these findings');
    btn.classList.toggle('connected', Boolean(backend));
    if (!backend) $('bulk-credits').textContent = '';
  }

  /** null means the administrator set no monthly limit. */
  let lastRemaining;
  function showCredits(remaining) {
    lastRemaining = remaining;
    if (!backend) return;
    $('bulk-credits').textContent =
      remaining === null || remaining === undefined
        ? L('AI Triage uses 1 credit per Checkmarx One result (rows that share one count once), AI Remediation 3.')
        : L('AI Triage uses 1 credit per Checkmarx One result (rows that share one count once), AI Remediation 3 · {0} left this month across all projects.', remaining);
  }

  /** `one` for 1, `many` otherwise, in the reader's language ({0} is the number). */
  const plural = (n, one, many) => L(n === 1 ? one : many, n);

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
          used('triage') > 0 ? L(used('triage') === 1 ? '{0} triage credit used, {1} left' : '{0} triage credits used, {1} left', used('triage'), c.triage.remaining) : '',
          used('remediation') > 0 ? L(used('remediation') === 1 ? '{0} remediation credit used, {1} left' : '{0} remediation credits used, {1} left', used('remediation'), c.remediation.remaining) : '',
        ].filter(Boolean);
        if (parts.length) log(L('{0}: {1}.', projectNames.get(id) || id, parts.join('; ')), 'info');
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
        ? L('{0} of {1} left', k.remaining, k.allocated) + (unit ? ` (${unit(k.remaining)})` : '')
        : L('none allocated');
      row.append(name, value);
      const bar = document.createElement('div');
      bar.className = 'credit-bar';
      bar.title = L('{0} used', k.used);
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
          line(L('AI Triage'), c.triage, (n) => plural(n, '{0} result', '{0} results')),
          line(L('AI Remediation'), c.remediation, (n) => plural(Math.floor(n / 3), '{0} remediation', '{0} remediations')),
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
      if (left === undefined) return L('{0}: {1} credit(s)', name, n);
      return left < n
        ? L('{0}: needs {1}, only {2} left', name, n, left)
        : L('{0}: {1} credit(s) — {2} left now, {3} after', name, n, left, left - n);
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
    if (engine === 'SCA') return L('This project uses a version of the package with a published vulnerability that its code can reach; a fixed version removes it.');
    if (engine === 'SAST') return L('Checkmarx One followed the data from where it enters the application to this code, and nothing on the way makes it safe.');
    return L('Checkmarx One matched this code or configuration against a known vulnerable pattern.');
  }

  function renderConfirmedWhy(f, tr) {
    const box = tr.querySelector('.state-why');
    if (!box || f.aiUnavailable) return;
    // AI Triage's latest record, else what the report was made with.
    const t = f.triage || f.ai || {};
    if (!CONFIRMED.has(f.state) && !CONFIRMED.has(t.status)) {
      box.replaceChildren();
      return;
    }
    // Said once: Why and Fix; "why?" adds only what those two lines do not say.
    // The report's own advice is in the reader's language; AI Triage's own words stay as Checkmarx One wrote them.
    const advice = f.advice ? { what: L(f.advice.what), fix: L(f.advice.fix) } : { what: L('Checkmarx One judged this finding a real vulnerability.'), fix: L('Remediate asks AI Remediation for a fix.') };
    const verdictWords = [t.reachability, t.exploitability].filter(Boolean).map((v) => SUB_LABELS[v] || v.replace(/_/g, ' ').toLowerCase());
    const verdict = verdictWords.length === 2 ? L('{0} and {1}', verdictWords[0].toLowerCase(), verdictWords[1].toLowerCase()) : (verdictWords[0] || '').toLowerCase();
    const whyFull = t.reason || advice.what;
    const fixFull = t.recommendation || advice.fix;
    const why = firstSentence(whyFull, 160);
    const fix = firstSentence(fixFull, 160);
    const more = [
      why !== whyFull ? whyFull : howKnown(f.scanner),
      verdict && (t.confidence ? L('AI Triage judged it {0} (confidence {1}).', verdict, t.confidence) : L('AI Triage judged it {0}.', verdict)),
      t.reason && advice.what !== t.reason ? L('This kind of finding: {0}', advice.what) : '',
      fix !== fixFull ? L('Fix in full: {0}', fixFull) : '',
    ].filter(Boolean);
    const details = el('details', { className: 'why-more' }, el('summary', { textContent: L('why?') }), ...more.map((text) => el('p', { textContent: text })));
    const next = el('p', {}, config.remediateHere ? L('Remediate asks Checkmarx One AI Remediation for the code change (a pull request when the project is connected to its repository).') : L('Checkmarx One shows the full data flow.'));
    if (/^https?:\/\//i.test(f.url || '')) next.append(' ', el('a', { href: f.url, target: '_blank', rel: 'noopener', textContent: L('Open in Checkmarx One') }));
    details.append(next);
    box.replaceChildren(para(L('Why:'), why, 'why-line'), para(L('Fix:'), fix, 'why-line'), details);
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
          log(L('AI Triage: {0} → no result from Checkmarx One {1} min after it was sent. The report keeps checking.', f.title, Math.round((Date.now() - sentAt) / 60000)), 'error');
          return;
        }
        if (status && !WAITING.has(status)) {
          f.settled = true;
          renderTriage(f);
          log(L('AI Triage: {0} → {1}', f.title, (VERDICTS[status] || [status])[0]), status === 'FAILED' ? 'error' : 'success');
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
      else f.triage = { ...(f.triage || {}), status: '', note: L('Still running — see Checkmarx One') };
      renderTriage(f);
    }
    if (waiting.length) log(L('{0} finding(s) had no final AI Triage verdict yet; see Checkmarx One for the latest.', waiting.length), 'info');
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
            ? L('AI Triage started for {0} finding(s).', group.length)
            : L('AI Triage already running for {0} finding(s); following it.', group.length),
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
    const words = BULK_WORDS[severity];
    if (!words) return;
    const projects = new Set(list.map((f) => f.projectId)).size;
    const ask = projects > 1 ? L(words.askAcross, list.length, projects) : L(words.ask, list.length);
    const results = resultCount(list);
    const shared = results < list.length ? ` ${L('They are {0} Checkmarx One results: rows sharing a result are triaged together and charged once.', results)}` : '';
    if (!confirm(`${ask}${shared} ${L('This uses {0} Checkmarx One credit(s).', results)}${afterText(list, 'triage', 1)}`)) return;
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
    labelHidden();
  }

  function labelHidden() {
    const n = findings.filter((x) => x.hidden && x.shown).length;
    const note = $('hidden-note');
    note.hidden = n === 0;
    note.textContent = L(n === 1 ? '{0} finding triaged as not exploitable (or proposed so) is not shown.' : '{0} findings triaged as not exploitable (or proposed so) are not shown.', n);
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
    log(L('Loaded Checkmarx One states: {0} of {1} eligible findings already triaged.', done, eligible.length), 'success');
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
    const message = L('Could not read current states from Checkmarx One: {0}', [...stateErrors][0]);
    log(message, 'error');
    banner(`${message} ${L('The report keeps trying every minute.')}`, 'warn');
    stateErrors.clear();
  }

  function markRefreshed(at = Date.now()) {
    lastRefresh = at;
    const el = $('last-refresh');
    if (el) el.textContent = L('Updated {0}', new Date(lastRefresh).toLocaleTimeString());
  }

  async function refreshStates({ manual = false } = {}) {
    if (!backend || refreshing) return;
    refreshing = true;
    if (manual) $('last-refresh').textContent = L('Updating…');
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
      if (manual) log(L('Report refreshed from Checkmarx One.'), 'success');
      backend.credits?.().catch(() => {});
    } catch (error) {
      log(L('Could not refresh: {0}', error.message), 'error');
      if (manual) reportError(error);
      if ($('last-refresh')) $('last-refresh').textContent = L('Update failed — retrying');
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
    if (job === 'FAILED' || r.data?.error) return { failed: r.data?.error || r.autoPr?.error_msg || L('AI Remediation failed.') };
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
      why: data?.analysis?.why || '',
      // Tests Checkmarx One wrote for the fix: they arrive among the file changes.
      tests: (data?.test_creation?.test_files || []).map((t) => String(t?.file_path || '')).filter(Boolean),
      // Per file, for "Apply fix in my workspace".
      changes: (data?.file_changes || [])
        .filter((c) => typeof c.diff === 'string' && /^@@ /m.test(c.diff) && MZPatch.segments(c.file_path))
        .map((c) => ({ path: MZPatch.segments(c.file_path).join('/'), diff: c.diff })),
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
      btn.textContent = L(r?.running ? 'Remediating…' : locked ? 'Remediated' : done ? 'Re-remediate' : 'Remediate');
      btn.title = locked
        ? L('Already remediated. Remediating again is switched off by your administrator.')
        : fenced ? L('Remediate works once triage has confirmed this finding (state Confirmed).') : '';
    }
    if (!r) return;
    if (r.running) {
      out.textContent = L('AI Remediation running in Checkmarx One — it triages the finding, writes a fix and opens a pull request. This can take several minutes.');
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
      headline.textContent = L('✓ Already remediated');
      out.append(headline);
      if (f.url) out.append(link(L('View the fix in Checkmarx One'), f.url));
      return;
    }
    if (r.prUrl) {
      headline.append(`${L('✓ Remediation opened')} `);
      const pr = link(L('PR {0}', prNumber(r.prUrl) || '').trim(), r.prUrl);
      pr.style.display = 'inline';
      headline.append(pr);
    } else if (r.prError) {
      headline.textContent = L('✓ Fix suggested — no pull request: {0}', r.prError);
    } else {
      headline.textContent = L('✓ Fix suggested (no pull request: the project is not connected to a code repository)');
    }
    out.append(headline);
    if (r.summary) {
      const p = document.createElement('p');
      p.textContent = r.summary;
      out.append(p);
    }
    if (r.why || r.how) {
      const more = document.createElement('details');
      more.className = 'fix-more';
      const summary = document.createElement('summary');
      summary.textContent = L('Why and how');
      more.append(summary);
      for (const [label, text] of [[L('Why:'), r.why], [L('How:'), r.how]]) {
        if (!text) continue;
        const p = document.createElement('p');
        const b = document.createElement('b');
        b.textContent = `${label} `;
        p.append(b, text);
        more.append(p);
      }
      out.append(more);
    }
    if (r.tests?.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = L(r.tests.length === 1 ? 'Includes {0} test file Checkmarx One wrote for the fix: {1}.' : 'Includes {0} test files Checkmarx One wrote for the fix: {1}.', r.tests.length, r.tests.join(', '));
      out.append(p);
    }
    if (f.url) out.append(link(L('View the fix in Checkmarx One'), f.url));
    if (r.patch) {
      const blob = URL.createObjectURL(new Blob([r.patch], { type: 'text/x-diff' }));
      out.append(link(L(r.files === 1 ? 'Download patch ({0} file)' : 'Download patch ({0} files)', r.files), blob, `${f.title.replace(/[^\w.-]+/g, '_').slice(0, 60)}.patch`));
    }
    if (r.changes?.length) out.append(workspaceActions(f, r));
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
        log(L('AI Remediation failed for {0}: {1}', f.title, result.failed), 'error');
      } else {
        log(result.prUrl ? L('AI Remediation ready: {0} — opened PR {1}', f.title, prNumber(result.prUrl)).trimEnd() : L('AI Remediation ready: {0}', f.title), 'success');
      }
      return;
    }
    f.remediation = { failed: L('Still running — the result will appear on the finding in Checkmarx One.') };
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
        f.remediation = { failed: L('AI Remediation from reports is switched off. Ask your Checkmarx One reminder administrator to allow it.') };
        return renderRemediation(f);
      }
    }
    const ask = isRemediated(f)
      ? L('Run Checkmarx One AI Remediation again for “{0}”? It uses 3 Checkmarx One credits and, for repository-connected projects, opens a pull request.', f.title)
      : L('Run Checkmarx One AI Remediation for “{0}”? It uses 3 Checkmarx One credits and, for repository-connected projects, opens a pull request.', f.title);
    if (!confirm(`${ask}${afterText([f], 'remediation', 3)}`)) return;
    const previous = f.remediation;
    f.remediation = { running: true };
    renderRemediation(f);
    try {
      const started = await backend.remediate(f);
      log(started.published ? L('AI Remediation started: {0}', f.title) : L('AI Remediation already running for {0}; following it.', f.title), 'pending');
    } catch (error) {
      if (error.status === 409 && error.body?.running) {
        log(L('AI Remediation already running for {0}; following it.', f.title), 'pending');
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
    if (done) log(L('{0} finding(s) in this report are already remediated.', done), 'info');
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
      openServerForm(L('Enter the reminder server address to open the report for {0}.', p.projectName));
      return;
    }
    const tab = window.open('', '_blank');
    if (tab) {
      // The new tab gets no way back to this report (reverse tabnabbing).
      try {
        tab.opener = null;
      } catch {}
      try {
        tab.document.title = L('{0} — building the report…', p.projectName);
        tab.document.body.innerHTML = '<p style="font:16px system-ui,sans-serif;padding:32px;color:#374151"></p>';
        tab.document.body.firstChild.textContent = L('Building the report for {0}…', p.projectName);
      } catch {}
    }
    button.disabled = true;
    projectReportStatus(L(p.count === 1 ? 'Building the report for {0} ({1} finding)…' : 'Building the report for {0} ({1} findings)…', p.projectName, p.count));
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
      projectReportStatus(shown
        ? L('The report for {0} was opened in a new tab and downloaded as {1}.', p.projectName, link.download)
        : L('The report for {0} was downloaded as {1} (allow pop-ups for this page to open it in a tab too).', p.projectName, link.download), 'ok');
      log(shown ? L('Report for {0}: opened in a new tab and downloaded.', p.projectName) : L('Report for {0}: downloaded (allow pop-ups for this page to open it in a tab too).', p.projectName), 'success');
    } catch (error) {
      if (tab && !tab.closed) tab.close();
      projectReportStatus(L('Could not build the report for {0}: {1}', p.projectName, error.message), 'error');
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

  async function connect({ quiet = false, moved = false } = {}) {
    const candidate = relayBackend();
    let status;
    try {
      status = await candidate.connect();
    } catch (error) {
      // The server went HTTPS only, and says where: follow it (once), when it answers there.
      if (!moved && error.status === 426 && error.body?.movedTo && (await switchServer(error.body.movedTo, L('The reminder server now uses HTTPS')))) {
        return connect({ quiet, moved: true });
      }
      throw error;
    }
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
    serverState(L('Connected'), 'good', 'connected');
    $('server-prompt').hidden = true;
    showCredits(status.creditsRemaining);
    updateBulk();
    banner('');
    if (!quiet) log(L('Connected to Checkmarx One ({0}) through the reminder server.', status.tenant), 'success');
    for (const f of findings) if (hasVerdict(f)) renderTriage(f);
    loadExistingTriage().catch(reportError);
    loadExistingRemediation().catch(reportError);
    candidate.credits().catch((error) => log(L('Could not read credits: {0}', error.message), 'error'));
    if (config.rescan) candidate.rescanState().then(renderRescan).catch(() => {});
    // The server answers on HTTPS too: use it from now on, if it works from this computer.
    if (status.httpsUrl && /^http:/i.test(String(config.relayUrl || ''))) {
      switchServer(status.httpsUrl, L('A secure (HTTPS) connection to the reminder server works from this computer'))
        .then((switched) => (switched ? connect({ quiet: true, moved: true }) : null))
        .catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Rescan your fixes: the developer goes first (a tracked report's round is closed)
  // ---------------------------------------------------------------------------

  let lastRescan;
  function renderRescan(s) {
    const card = $('rescan-card');
    if (!card || !s) return;
    lastRescan = s;
    const until = s.dueAt ? new Date(s.dueAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    const view = {
      ready: ['', '⟳', L('Everything here is dealt with. Prove it: rescan now'), `${L(s.onBehalf ? 'You have until {0} ({1} h). After that it is rescanned on your behalf.' : 'You have until {0} ({1} h).', until, s.hoursLeft)} ${L('You get the result by email.')}`, L('Rescan now'), false],
      scanning: ['wait', '⟳', L('Rescanning…'), `${s.startedBy ? L('Started by {0}.', s.startedBy) : s.automatic ? L('Started on your behalf.') : L('Started.')} ${L('You get the result by email.')}`, '', true],
      zero: ['ok', '✓', L('Verified at zero'), L('The rescan found nothing left in scope. Every fix worked.'), '', true],
      verified: ['wait', '✓', L('Rescanned'), L('{0} fixed, {1} still found. The updated report has been emailed to you.', s.result?.fixed ?? 0, s.result?.stillFound ?? 0), '', true],
      opening: ['', '⟳', L('Everything here is dealt with'), L('The rescan button opens in a minute.'), '', true],
      'open-findings': ['wait', '•', L('Rescan unlocks when everything here is dealt with'), s.open == null ? L('Some findings left to triage or fix. Then you rescan to prove the fixes.') : L(s.open === 1 ? '{0} finding left to triage or fix. Then you rescan to prove the fixes.' : '{0} findings left to triage or fix. Then you rescan to prove the fixes.', s.open), L('Rescan'), true],
    }[s.state];
    if (!view || !s.sameRound) {
      card.hidden = true;
      return;
    }
    const [tone, icon, title, text, button, disabled] = view;
    card.className = `rescan-card${tone ? ` ${tone}` : ''}`;
    const el = (tag, className, textContent) => Object.assign(document.createElement(tag), { className, textContent });
    const badge = el('span', 'rc-icon', icon);
    badge.setAttribute('aria-hidden', 'true');
    const words = el('span', 'rc-text', '');
    words.append(el('b', '', title), el('span', '', text));
    card.replaceChildren(badge, words);
    card.hidden = false;
    if (!button) return;
    const go = el('button', `btn${disabled ? ' btn-outline' : ''}`, button);
    go.type = 'button';
    go.disabled = disabled;
    card.append(go);
    go.addEventListener('click', async () => {
      go.disabled = true;
      go.textContent = L('Starting…');
      try {
        renderRescan({ ...(await backend.rescan()), sameRound: true });
        log(L('Rescan started: Checkmarx One scans the same repository, branch and engines again. The result comes by email.'), 'success');
      } catch (error) {
        go.disabled = false;
        go.textContent = L('Rescan now');
        log(L('Could not start the rescan: {0}', error.message), 'error');
      }
    });
  }

  /** Use another address for the reminder server (kept in this browser), when it answers there. */
  async function switchServer(url, reason) {
    let base;
    try {
      base = await checkServer(url);
    } catch {
      return false;
    }
    config.relayUrl = base;
    try {
      if (base !== ORIGINAL_SERVER) localStorage.setItem(SERVER_STORE, base);
      else localStorage.removeItem(SERVER_STORE);
    } catch {}
    showServer();
    log(L('{0}: now using {1}.', reason, base), 'info');
    return true;
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
    log(L('Disconnected from Checkmarx One.'), 'info');
  }

  /** Connect first if needed (once, however many buttons are clicked), then act. */
  function requireConnection(action) {
    if (backend) return action();
    if (!config.relayUrl) {
      openServerForm(L('Enter the reminder server address to connect.'));
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

  // What the state says (connected, unreachable, …), whatever language it is shown in.
  let serverKind = '';
  function serverState(text, kind = '', what = kind === 'bad' ? 'unreachable' : '') {
    serverKind = what;
    const el = $('server-state');
    el.textContent = text;
    el.className = `server-state ${kind}`;
  }

  function showServer() {
    const url = String(config.relayUrl || '').replace(/\/+$/, '');
    $('server-url').textContent = url || L('not set');
    $('server-change').textContent = url ? L('Change') : L('Enter address');
    $('server-reset').hidden = !ORIGINAL_SERVER || url === ORIGINAL_SERVER;
    if (!url) serverState(L('Needed to triage from this report'), 'warn');
    else if (url !== ORIGINAL_SERVER && /^https:/i.test(url) && /^http:/i.test(ORIGINAL_SERVER)) serverState(L('Switched to HTTPS'), 'good');
    else if (url !== ORIGINAL_SERVER) serverState(L('Changed in this browser'), 'warn');
    else {
      try {
        serverState(LOOPBACK.test(new URL(url).hostname) ? L('Only reachable on the server’s own computer') : '', LOOPBACK.test(new URL(url).hostname) ? 'warn' : '');
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
  async function checkServer(value, followed = false) {
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    } catch {
      throw new CxError(L('That is not a web address, e.g. {0}', 'https://cx-reminder.example.com'));
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new CxError(L('Use an http or https address.'));
    const base = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller && setTimeout(() => controller.abort(), 10000);
    let body = null;
    try {
      const response = await fetch(`${base}/api/relay/ping`, { signal: controller?.signal, cache: 'no-store' });
      body = await response.json().catch(() => null);
    } catch {
      throw new CxError(L('No reminder server answered at {0}. Check the address, and that you are on the company network or VPN.', base));
    } finally {
      if (timer) clearTimeout(timer);
    }
    // An old http address of a server that is HTTPS only now: it says where it went.
    if (body?.movedTo && !followed) return checkServer(String(body.movedTo), true);
    if (body?.service !== 'mission-zero-relay') throw new CxError(L('{0} answered, but it is not a reminder server. Check the address.', base));
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
    log(L('Reminder server set to {0}.', base), 'info');
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
    if (confirm(L('Disconnect from Checkmarx One?'))) disconnect();
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

  // ---------------------------------------------------------------------------
  // Your workspace: open a finding in your IDE, and apply a fix to your own
  // checkout. Nothing to install: VS Code, Cursor, Kiro and JetBrains IDEs open
  // their own links (vscode://, cursor://, kiro://, jetbrains://). A fix is
  // written through the browser's folder access (Chrome, Edge) only after you
  // pick the folder and see the changes; or applied with git from a command.
  // ---------------------------------------------------------------------------

  // VS Code and the editors built on it open vscode://-style links under their own name.
  const IDES = [
    { name: 'VS Code', scheme: 'vscode' },
    { name: 'Cursor', scheme: 'cursor' },
    { name: 'Kiro', scheme: 'kiro' },
    { name: 'Windsurf', scheme: 'windsurf' },
    { name: 'Antigravity', scheme: 'antigravity' },
  ];
  const JETBRAINS = {
    idea: 'IntelliJ IDEA',
    webstorm: 'WebStorm',
    pycharm: 'PyCharm',
    goland: 'GoLand',
    phpstorm: 'PhpStorm',
    rider: 'Rider',
    clion: 'CLion',
    rubymine: 'RubyMine',
  };
  const WORKSPACE_STORE = 'mzWorkspace';

  /** Where this reader keeps each repository, and their JetBrains IDE: this browser only. */
  function workspacePrefs() {
    try {
      const prefs = JSON.parse(localStorage.getItem(WORKSPACE_STORE) || '{}');
      return prefs && typeof prefs === 'object' ? prefs : {};
    } catch {
      return {};
    }
  }
  function saveWorkspacePrefs(prefs) {
    try {
      localStorage.setItem(WORKSPACE_STORE, JSON.stringify(prefs));
    } catch {}
  }

  const repoOf = (f) => config.repositories?.[f.projectId] ?? null;
  const repoName = (f) => (repoOf(f) ? MZPatch.repoKey(repoOf(f).url).split('/').pop() : '') || f.projectName;
  const folderKey = (f) => (repoOf(f) ? `repo:${MZPatch.repoKey(repoOf(f).url)}` : `project:${f.projectId}`);
  const absolute = (folder) => /^([A-Za-z]:[\\/]|\/)/.test(folder);
  const joinPath = (root, name) => `${root}${/^[A-Za-z]:/.test(root) ? '\\' : '/'}${name}`;
  const cleanFolder = (text) => String(text ?? '').trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');
  /** Where this computer keeps its code (asked once, for every repository and report). */
  const codeRoot = () => {
    const root = workspacePrefs().parent;
    return typeof root === 'string' && absolute(root) ? root : '';
  };
  /** This repository's folder: its own, if the reader set one, else <code folder>/<repository name>. */
  const folderFor = (f) => {
    const own = workspacePrefs().folders?.[folderKey(f)];
    if (typeof own === 'string' && own) return own;
    return codeRoot() ? joinPath(codeRoot(), repoName(f)) : '';
  };

  /** The one question: where repositories are checked out on this computer. */
  function askCodeRoot(f) {
    const name = repoName(f);
    const answer = prompt(
      `${L('Where do you keep your code on this computer? Asked once: each repository then opens from that folder by its name ({0}).', `${name} → <folder>${/Win/.test(navigator.platform) ? '\\' : '/'}${name}`)}\n\n${L('For example {0} or {1}', 'C:\\src', '/home/you/src')}`,
      codeRoot(),
    );
    if (answer === null) return '';
    const root = cleanFolder(answer);
    if (!absolute(root)) {
      alert(L('Enter the full path of the folder: starting with a drive letter (C:\\…) or with /.'));
      return '';
    }
    saveWorkspacePrefs({ ...workspacePrefs(), parent: root });
    return root;
  }

  /** A repository kept somewhere else, or under another name. */
  function askFolder(f) {
    const name = repoName(f);
    const answer = prompt(L('Where is {0} on this computer? Its full folder path.', name), folderFor(f) || (codeRoot() ? joinPath(codeRoot(), name) : ''));
    if (answer === null) return '';
    const folder = cleanFolder(answer);
    if (!absolute(folder)) {
      alert(L('Enter the full path of the folder: starting with a drive letter (C:\\…) or with /.'));
      return '';
    }
    const prefs = workspacePrefs();
    prefs.folders = { ...(prefs.folders && typeof prefs.folders === 'object' ? prefs.folders : {}), [folderKey(f)]: folder };
    if (!codeRoot()) prefs.parent = folder.replace(/[\\/][^\\/]+$/, '');
    saveWorkspacePrefs(prefs);
    return folder;
  }

  /** vscode://file/C:/src/app/src/db.js:42:7 (and the same for Cursor and Kiro). */
  function fileLink(scheme, folder, loc) {
    const full = `${folder.replace(/\\/g, '/')}/${loc.path}`;
    const encoded = full
      .split('/')
      .map((part, i) => (i === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)))
      .join('/');
    const at = loc.line ? `:${loc.line}${loc.column ? `:${loc.column}` : ''}` : '';
    return `${scheme}://file${encoded.startsWith('/') ? '' : '/'}${encoded}${at}`;
  }

  /** jetbrains://idea/navigate/reference?project=app&path=src/db.js:41 (JetBrains counts lines from 0). */
  function jetbrainsLink(tool, project, loc) {
    const path = encodeURIComponent(loc.path).replace(/%2F/gi, '/');
    const at = loc.line ? `:${loc.line - 1}${loc.column ? `:${loc.column - 1}` : ''}` : '';
    return `jetbrains://${tool}/navigate/reference?project=${encodeURIComponent(project)}&path=${path}${at}`;
  }

  /** Not on this computer yet: the IDE asks where to clone it, then opens it. */
  const cloneLink = (scheme, url) => `${scheme}://vscode.git/clone?url=${encodeURIComponent(url)}`;
  const jetbrainsCloneLink = (tool, url) => `jetbrains://${tool}/checkout/git?checkout.repo=${encodeURIComponent(url)}&idea.required.plugins.id=Git4Idea`;

  /** The file at its line in the code host's browser editor (or its file view): nothing local needed. */
  function webLink(f) {
    const repo = repoOf(f);
    if (!repo || !/^https:\/\//i.test(repo.url)) return null;
    const [host, ...rest] = MZPatch.repoKey(repo.url).split('/');
    const project = rest.join('/');
    const branch = (repo.branch || 'HEAD').split('/').map(encodeURIComponent).join('/');
    const file = f.loc.path.split('/').map(encodeURIComponent).join('/');
    const line = f.loc.line || 1;
    if (!project) return null;
    if (host === 'github.com') return { label: L('github.dev (in the browser)'), url: `https://github.dev/${project}/blob/${branch}/${file}#L${line}` };
    if (/(^|\.)gitlab\./.test(host)) return { label: L('GitLab Web IDE'), url: `https://${host}/-/ide/project/${project}/edit/${branch}/-/${file}` };
    if (host === 'bitbucket.org') return { label: L('View on Bitbucket'), url: `https://bitbucket.org/${project}/src/${branch}/${file}#lines-${line}` };
    if (host === 'dev.azure.com') {
      return { label: L('View in Azure Repos'), url: `https://dev.azure.com/${project}?path=/${file}&version=GB${branch}&line=${line}&lineEnd=${line}&lineStartColumn=1&lineEndColumn=1&_a=contents` };
    }
    return null;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      let copied = false;
      try {
        copied = document.execCommand('copy');
      } catch {}
      area.remove();
      return copied;
    }
  }

  /** Hand a link to the IDE registered for it (no new tab is left behind). */
  function openInIde(url) {
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
  }

  function smallButton(text, onClick, outline = true) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = outline ? 'btn btn-outline btn-small' : 'btn btn-small';
    button.textContent = text;
    button.addEventListener('click', onClick);
    return button;
  }

  function textLink(text, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'link-button';
    button.textContent = text;
    button.addEventListener('click', onClick);
    return button;
  }

  function fillIdeMenu(f, list) {
    list.replaceChildren();
    if (f.loc?.path) fillOpenOptions(f, list);
    const sub = document.createElement('p');
    sub.className = 'ide-sub';
    sub.textContent = L('Apply its AI fix with');
    list.append(sub);
    for (const fixer of FIXERS) {
      const b = textLink(L(fixer.name), (event) => fixFinding(f, fixer.id, event.currentTarget));
      b.className = 'link-button ide-fix';
      list.append(b);
    }
  }

  function fillOpenOptions(f, list) {
    const sub = document.createElement('p');
    sub.className = 'ide-sub';
    sub.textContent = L('Open this finding in');
    list.append(sub);
    const where = document.createElement('p');
    where.className = 'ide-where';
    where.textContent = f.loc.line ? L('{0}, line {1}', f.loc.path, f.loc.line) : f.loc.path;
    list.append(where);
    for (const ide of IDES) {
      list.append(
        smallButton(ide.name, () => {
          openFinding(f, ide.scheme);
          fillIdeMenu(f, list);
        }),
      );
    }
    const prefs = workspacePrefs();
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'JetBrains IDE');
    for (const [id, name] of Object.entries(JETBRAINS)) select.append(new Option(name, id));
    select.value = JETBRAINS[prefs.jetbrains] ? prefs.jetbrains : 'idea';
    select.addEventListener('change', () => saveWorkspacePrefs({ ...workspacePrefs(), jetbrains: select.value }));
    const jetbrains = document.createElement('div');
    jetbrains.className = 'ide-jb';
    jetbrains.append(
      // JetBrains finds the file by the name of the project it has open: no folder needed.
      smallButton('JetBrains', () => openFinding(f, 'jetbrains')),
      select,
    );
    list.append(jetbrains);

    const folder = folderFor(f);
    const note = document.createElement('p');
    note.className = 'ide-note';
    if (folder) {
      note.append(`${L('Opens {0}.', joinPath(folder, f.loc.path.replace(/\//g, /^[A-Za-z]:/.test(folder) ? '\\' : '/')))} `);
      note.append(textLink(L('Somewhere else?'), () => askFolder(f) && fillIdeMenu(f, list)));
    } else {
      note.append(L('The first time, it asks where you keep your code; after that it is one click.'));
    }
    list.append(note);

    const repo = repoOf(f);
    if (repo) {
      const clone = document.createElement('p');
      clone.className = 'ide-note';
      clone.append(`${L('Not on this computer yet? Clone and open:')} `);
      for (const ide of IDES) clone.append(textLink(ide.name, () => openInIde(cloneLink(ide.scheme, repo.url))), ' · ');
      clone.append(textLink('JetBrains', () => openInIde(jetbrainsCloneLink(select.value, repo.url))));
      list.append(clone);
      const web = webLink(f);
      if (web) list.append(link(web.label, web.url));
    }
  }

  function ideMenu(f) {
    const menu = document.createElement('details');
    menu.className = 'ide-menu';
    const summary = document.createElement('summary');
    summary.textContent = '▾';
    summary.title = L('Other ways to open or fix this finding');
    summary.setAttribute('aria-label', summary.title);
    const list = document.createElement('div');
    list.className = 'ide-list';
    menu.append(summary, list);
    menu.addEventListener('toggle', () => {
      if (menu.open) fillIdeMenu(f, list);
    });
    return menu;
  }

  // ---- Your tools: chosen once at the top, one click on every finding ----

  /**
   * Fixes come from Checkmarx One AI Remediation only: once a finding is remediated, its fix is
   * applied here in one click, in the reader's checkout (or with git apply).
   */
  const FIXERS = [
    { id: 'workspace', name: 'Apply in my workspace' },
    { id: 'git', name: 'git apply' },
  ];
  const OPENERS = [...IDES.map((ide) => ({ id: ide.scheme, name: ide.name })), { id: 'jetbrains', name: 'JetBrains IDE' }, { id: 'web', name: 'The browser (github.dev, GitLab…)' }];
  const defaultIde = () => (OPENERS.some((o) => o.id === workspacePrefs().ide) ? workspacePrefs().ide : 'vscode');
  const defaultFix = () => (FIXERS.some((x) => x.id === workspacePrefs().fix) ? workspacePrefs().fix : 'workspace');
  const nameOf = (list, id) => list.find((x) => x.id === id)?.name ?? id;
  const jetbrainsProject = (f) => (workspacePrefs().folders?.[folderKey(f)] || '').split(/[\\/]/).pop() || repoName(f);
  const jetbrainsTool = () => (JETBRAINS[workspacePrefs().jetbrains] ? workspacePrefs().jetbrains : 'idea');

  function openFinding(f, ideId = defaultIde()) {
    if (!f.loc?.path) return;
    if (ideId === 'jetbrains') return openInIde(jetbrainsLink(jetbrainsTool(), jetbrainsProject(f), f.loc));
    if (ideId === 'web') {
      const web = webLink(f);
      if (web) window.open(web.url, '_blank', 'noopener');
      else log(L('This repository has no browser editor link (only GitHub, GitLab, Bitbucket and Azure Repos do).'), 'error');
      return;
    }
    const ide = IDES.find((i) => i.scheme === ideId) ?? IDES[0];
    const folder = folderFor(f) || (askCodeRoot(f) && folderFor(f));
    if (folder) openInIde(fileLink(ide.scheme, folder, f.loc));
  }

  function showToolOutput(f, lines, command = '') {
    const out = row(f)?.querySelector('.tool-out');
    if (!out) return;
    out.replaceChildren();
    for (const text of lines) {
      const p = document.createElement('p');
      p.textContent = text;
      out.append(p);
    }
    if (command) {
      const code = document.createElement('code');
      code.textContent = command;
      out.append(code);
    }
  }

  async function fixFinding(f, fixId = defaultFix(), button = null) {
    const fixer = FIXERS.find((x) => x.id === fixId) ?? FIXERS[0];
    if (!f.remediation?.changes?.length) {
      return showToolOutput(f, [L('No fix yet: remediate this finding with Checkmarx One AI first (Remediate, on this row, once it is confirmed). Its fix can then be applied here in one click.')]);
    }
    if (fixer.id === 'git') return requireConnection(() => copyGitCommand(f, button ?? document.createElement('button')));
    return applyInWorkspace(f).catch((error) => log(L('Could not apply the fix: {0}', error.message), 'error'));
  }

  /** One click per finding: open it in your IDE, apply its AI fix; ▾ for anything else. */
  const rowButtons = [];
  function rowTools(f) {
    const box = document.createElement('div');
    box.className = 'row-tools';
    let open = null;
    if (f.loc?.path) {
      open = smallButton('', () => openFinding(f));
      open.title = `${f.loc.path}${f.loc.line ? `:${f.loc.line}` : ''}`;
      box.append(open);
    }
    const fix = smallButton('', (event) => fixFinding(f, defaultFix(), event.currentTarget), false);
    box.append(fix, ideMenu(f));
    const out = document.createElement('div');
    out.className = 'tool-out';
    box.append(out);
    rowButtons.push({ open, fix });
    return box;
  }
  function labelRowButtons() {
    for (const { open, fix } of rowButtons) {
      if (open) open.textContent = defaultIde() === 'web' ? L('Open in the browser') : L('Open in {0}', nameOf(OPENERS, defaultIde()));
      fix.textContent = defaultFix() === 'git' ? L('Apply AI fix (git apply)') : L('Apply AI fix');
    }
    for (const option of [...$('tool-ide').options, ...$('tool-fix').options]) option.text = L(nameOf([...OPENERS, ...FIXERS], option.value));
    const folder = codeRoot();
    $('tool-folder').textContent = folder ? L('Code folder: {0}', folder) : '';
  }

  for (const f of findings) {
    if (!f.shown) continue;
    const cell = row(f)?.querySelector('.actions-cell');
    if (cell) cell.insertBefore(rowTools(f), cell.querySelector('.fix-cell'));
  }
  if (rowButtons.length) {
    const ideSelect = $('tool-ide');
    const fixSelect = $('tool-fix');
    for (const o of OPENERS) ideSelect.append(new Option(o.name, o.id));
    for (const x of FIXERS) fixSelect.append(new Option(x.name, x.id));
    ideSelect.value = defaultIde();
    fixSelect.value = defaultFix();
    ideSelect.addEventListener('change', () => {
      saveWorkspacePrefs({ ...workspacePrefs(), ide: ideSelect.value });
      labelRowButtons();
    });
    fixSelect.addEventListener('change', () => {
      saveWorkspacePrefs({ ...workspacePrefs(), fix: fixSelect.value });
      labelRowButtons();
    });
    $('my-tools').hidden = false;
    labelRowButtons();
  }

  /** The remote addresses of a picked folder's git checkout: [] when unknown, null when it is not one. */
  async function gitRemotes(dir) {
    let git;
    try {
      git = await dir.getDirectoryHandle('.git');
    } catch {
      try {
        await dir.getFileHandle('.git'); // a worktree or submodule: its remote is elsewhere
        return [];
      } catch {
        return null;
      }
    }
    try {
      const file = await (await git.getFileHandle('config')).getFile();
      return MZPatch.remotes(await file.text());
    } catch {
      return [];
    }
  }

  /** What one file change would do in the picked folder; nothing is written here. */
  async function planChange(dir, change) {
    const parts = MZPatch.segments(change.path);
    if (!parts) return { path: change.path, ok: false, error: L('Its path leads outside the folder: not applied.'), diff: change.diff };
    const { created } = MZPatch.parse(change.diff);
    let folder = dir;
    let missing = false;
    for (const part of parts.slice(0, -1)) {
      try {
        folder = await folder.getDirectoryHandle(part);
      } catch {
        missing = true;
        break;
      }
    }
    let text = null;
    if (!missing) {
      try {
        text = await (await (await folder.getFileHandle(parts.at(-1))).getFile()).text();
      } catch {}
    }
    const path = parts.join('/');
    if (text === null && !created) return { path, ok: false, error: L('Not in this folder: is it the right repository and branch?'), diff: change.diff };
    if (text !== null && created) return { path, ok: false, error: L('Already exists, but the fix would create it.'), diff: change.diff };
    return { path, parts, created, diff: change.diff, ...MZPatch.apply(text ?? '', change.diff) };
  }

  async function writeChange(dir, plan) {
    let folder = dir;
    for (const part of plan.parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part, { create: true });
    const handle = await folder.getFileHandle(plan.parts.at(-1), { create: true });
    const writable = await handle.createWritable();
    await writable.write(plan.text);
    await writable.close();
  }

  /** Show what the fix changes in the folder; resolves true when the reader chooses to write it. */
  function previewFix(f, folderName, plans) {
    return new Promise((resolve) => {
      const ok = plans.every((p) => p.ok);
      const dialog = document.createElement('dialog');
      dialog.className = 'dialog apply-dialog';
      const form = document.createElement('form');
      form.method = 'dialog';
      const h2 = document.createElement('h2');
      h2.textContent = ok ? L('Apply the fix to {0}?', folderName) : L('The fix does not fit {0} as it is', folderName);
      const intro = document.createElement('p');
      intro.className = 'dialog-hint';
      intro.textContent = ok
        ? `${L(plans.length === 1 ? '{0}: the fix changes {1} file.' : '{0}: the fix changes {1} files.', f.title, plans.length)} ${L('Nothing is written until you choose Write changes; review them afterwards with git diff.')}`
        : L('Nothing was written. Pull the latest code and try again, or use the git command, which shows exactly where it stops.');
      const list = document.createElement('ul');
      list.className = 'apply-list';
      for (const p of plans) {
        const li = document.createElement('li');
        const name = document.createElement('code');
        name.textContent = p.path;
        const status = document.createElement('span');
        status.className = p.ok ? 'apply-ok' : 'apply-bad';
        status.textContent = p.ok
          ? ` ✓ ${L(p.changes === 1 ? '{0} change' : '{0} changes', p.changes)}${p.created ? `, ${L('new file')}` : ''}${p.moved ? `; ${L('{0} found a few lines away (the file changed since the scan)', p.moved)}` : ''}`
          : ` ✗ ${p.error}`;
        li.append(name, status);
        list.append(li);
      }
      const diff = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = L('Show the changes');
      const pre = document.createElement('pre');
      pre.className = 'apply-diff';
      pre.textContent = plans.map((p) => `# ${p.path}\n${p.diff}`).join('\n\n');
      diff.append(summary, pre);
      const actions = document.createElement('div');
      actions.className = 'dialog-actions';
      const cancel = document.createElement('button');
      cancel.className = 'btn btn-outline';
      cancel.value = 'cancel';
      cancel.textContent = ok ? L('Cancel') : L('Close');
      actions.append(cancel);
      if (ok) {
        const write = document.createElement('button');
        write.className = 'btn';
        write.value = 'write';
        write.textContent = L('Write changes');
        actions.append(write);
      }
      form.append(h2, intro, list, diff, actions);
      dialog.append(form);
      dialog.addEventListener('close', () => {
        dialog.remove();
        resolve(dialog.returnValue === 'write');
      });
      document.body.append(dialog);
      dialog.showModal();
    });
  }

  async function applyInWorkspace(f) {
    const r = f.remediation;
    if (!r?.changes?.length) return;
    let dir;
    try {
      const id = `mz-${MZPatch.repoKey(repoOf(f)?.url || f.projectId).replace(/[^\w-]+/g, '-')}`.slice(0, 32);
      dir = await window.showDirectoryPicker({ id, mode: 'readwrite' });
    } catch (error) {
      if (error?.name !== 'AbortError') log(L('Could not open the folder: {0}', error.message), 'error');
      return;
    }
    const expected = repoOf(f)?.url || '';
    const remotes = await gitRemotes(dir);
    if (remotes === null) {
      if (!confirm(L('{0} is not a git checkout (it has no .git folder), so the change cannot be reviewed or undone with git. Apply the fix to it anyway?', dir.name))) return;
    } else if (expected && remotes.length && !remotes.some((url) => MZPatch.repoKey(url) === MZPatch.repoKey(expected))) {
      if (!confirm(L('{0} is a checkout of {1}, but this fix is for {2}. Apply it anyway?', dir.name, remotes[0], expected))) return;
    }
    const plans = [];
    for (const change of r.changes) plans.push(await planChange(dir, change));
    if (!(await previewFix(f, dir.name, plans))) return;
    for (const plan of plans) await writeChange(dir, plan);
    const files = plans.length === 1 ? plans[0].path : L('{0} files', plans.length);
    log(L('Fix written to {0}: {1}. Review it with git diff, then commit.', dir.name, files), 'success');
    const done = document.createElement('p');
    done.className = 'fix-written';
    done.textContent = L('✓ Written to {0} ({1}). Review with git diff, then commit.', dir.name, files);
    row(f)?.querySelector('.ws-actions')?.append(done);
    // Straight to the change, in the IDE this reader uses (when the report knows where the folder is).
    const ide = IDES.find((i) => i.scheme === workspacePrefs().ide) ?? IDES[0];
    const folder = folderFor(f);
    if (folder && folder.split(/[\\/]/).pop() === dir.name) {
      const first = plans[0].path === f.loc?.path ? f.loc : { path: plans[0].path, line: 0, column: 0 };
      done.append(' ', textLink(L('Open it in {0}', ide.name), () => openInIde(fileLink(ide.scheme, folder, first))));
    }
  }

  async function copyGitCommand(f, button) {
    button.disabled = true;
    try {
      const { url } = await backend.patchLink(f);
      if (!safeHref(url) || !/^https?:/i.test(url) || /["\s]/.test(url)) throw new Error(L('The server sent an address that is not a web link.'));
      const command = `curl -fsSL "${url}" -o mz-fix.patch && git apply --recount mz-fix.patch`;
      const copied = await copyText(command);
      const box = row(f)?.querySelector('.ws-actions');
      box?.querySelector('.git-command')?.remove();
      const shown = document.createElement('div');
      shown.className = 'git-command';
      const hint = document.createElement('p');
      hint.textContent = `${copied ? `${L('Copied.')} ` : ''}${L('Run it in the repository folder (cmd, PowerShell or a shell). The link works for 7 days.')}`;
      const code = document.createElement('code');
      code.textContent = command;
      shown.append(hint, code);
      box?.append(shown);
      if (!copied) getSelection()?.selectAllChildren(code);
      log(copied ? L('git command for {0} copied.', f.title) : L('git command for {0} ready to copy.', f.title), 'success');
    } catch (error) {
      log(L('Could not make the git command: {0}', error.message), 'error');
    } finally {
      button.disabled = false;
    }
  }

  /** Under a finished fix: apply it to your checkout, here or with git. */
  function workspaceActions(f, r) {
    const box = document.createElement('div');
    box.className = 'ws-actions';
    if (typeof window.showDirectoryPicker === 'function') {
      box.append(
        smallButton(
          L('Apply fix in my workspace'),
          () => applyInWorkspace(f).catch((error) => log(L('Could not apply the fix: {0}', error.message), 'error')),
          Boolean(r.prUrl),
        ),
      );
    }
    const git = smallButton(L('Copy git command'), () => requireConnection(() => copyGitCommand(f, git)));
    git.title = L('A one-line command that downloads this fix and applies it with git, run in the repository folder.');
    box.append(git);
    if (typeof window.showDirectoryPicker !== 'function') {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent = L('Open this report in Chrome or Edge to apply the fix from here, or use the git command.');
      box.append(note);
    }
    return box;
  }

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
      serverState(L('Needed to triage from this report'), 'warn');
      showConnectPrompt(L('This report does not say which reminder server to use. Enter its address to connect.'));
      return;
    }
    serverState(L('Connecting…'));
    $('server-prompt').hidden = true;
    connecting ??= connect({ quiet: true }).finally(() => {
      connecting = null;
    });
    connecting.then(
      () => log(L('Connected to the reminder server automatically.'), 'success'),
      (error) => {
        log(L('Could not connect automatically: {0}', error.message), 'error');
        if (serverKind !== 'connected' && serverKind !== 'unreachable') serverState(L('Not connected'), 'bad', 'not-connected');
        showConnectPrompt(L('Could not connect to the reminder server automatically: {0}', error.message));
      },
    );
  }

  $('server-connect').addEventListener('click', () => {
    if (!config.relayUrl) return openServerForm(L('Enter the reminder server address to connect.'));
    autoConnect();
  });
  $('server-fix').addEventListener('click', () => openServerForm());
  $('refresh-now').addEventListener('click', () => (backend ? refreshStates({ manual: true }) : requireConnection(() => {})));

  // Another language chosen in the report: what is on screen now is written again in it.
  relabel = () => {
    applyLabels();
    const kind = serverKind;
    setConnectedUI(backend ? connectedTenant : undefined);
    showServer();
    if (backend) serverState(L('Connected'), 'good', 'connected');
    else if (kind === 'unreachable') serverState(L('Unreachable'), 'bad');
    else if (kind === 'not-connected') serverState(L('Not connected'), 'bad', 'not-connected');
    showCredits(lastRemaining);
    renderCredits();
    if (lastRefresh) markRefreshed(lastRefresh);
    if (lastRescan) renderRescan(lastRescan);
    labelHidden();
    // Only what the report itself rewrote; the rest the server wrote, and applyLabels relabelled it.
    for (const f of findings) if (f.shown && !f.hidden && (f.triage || f.triagedAt || f.noRecord || (f.state && f.state !== 'TO_VERIFY'))) renderTriage(f);
    for (const f of findings) if (f.remediation) renderRemediation(f);
    if (rowButtons.length) labelRowButtons();
    updateBulk();
  };

  autoConnect();
}

/** Sentences the server wrote with values in them (data-l, data-v): in the reader's language. */
function applyLabels() {
  for (const el of document.querySelectorAll('[data-l]')) {
    let values = [];
    try {
      values = JSON.parse(el.dataset.v || '[]');
    } catch {}
    el.textContent = L(el.dataset.l, ...values);
  }
  for (const el of document.querySelectorAll('[data-l-title]')) {
    let values = [];
    try {
      values = JSON.parse(el.dataset.vTitle || '[]');
    } catch {}
    el.title = L(el.dataset.lTitle, ...values);
  }
}

// Filters: severity, text and "only what AI can act on". Rows the report hides
// itself (triaged not exploitable) stay hidden whatever the filter says.
let refilter = () => {};
function reportFilters() {
  const bar = document.getElementById('report-filters');
  if (!bar) return;
  const rows = [...document.querySelectorAll('#findings tbody tr[data-key]')];
  const search = document.getElementById('report-search');
  const actionable = document.getElementById('report-actionable');
  const count = document.getElementById('filter-count');
  let severity = '';
  const text = new Map(rows.map((tr) => [tr, tr.querySelector('.finding')?.textContent.toLowerCase() ?? '']));
  function apply() {
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const tr of rows) {
      const match =
        (!severity || tr.dataset.sev === severity) &&
        words.every((w) => text.get(tr).includes(w)) &&
        (!actionable.checked || Boolean(tr.querySelector('[data-action="triage"]:not(:disabled), [data-action="remediate"]:not(:disabled)')));
      tr.classList.toggle('filtered-out', !match);
      if (match && !tr.hidden) shown += 1;
    }
    const filtering = severity || words.length || actionable.checked;
    count.textContent = filtering ? L('{0} of {1} shown', shown, rows.filter((tr) => !tr.hidden).length) : '';
  }
  bar.addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter-sev]');
    if (!button) return;
    severity = button.dataset.filterSev;
    for (const b of bar.querySelectorAll('[data-filter-sev]')) {
      b.classList.toggle('on', b === button);
      b.setAttribute('aria-pressed', String(b === button));
    }
    apply();
  });
  search.addEventListener('input', apply);
  actionable.addEventListener('change', apply);
  refilter = apply;
}

// The report starts once its language is known: the translator (in the report) calls
// MZReportStart. A browser without it, or a report without translations, starts in English.
let relabel = () => {};
let reportStarted = false;
function startReport() {
  if (reportStarted) return;
  reportStarted = true;
  applyLabels();
  reportMain();
  reportFilters();
}
window.MZReportStart = startReport;
window.MZReportStarted = () => reportStarted;
/** The reader chose another language: the translator has the new words; show them. */
window.MZReportRelabel = () => {
  if (!reportStarted) return;
  relabel();
  refilter();
};
if (!document.getElementById('report-i18n')) startReport();
else setTimeout(startReport, 4000);
