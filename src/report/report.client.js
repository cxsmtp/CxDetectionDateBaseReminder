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

  const STORE = 'cxReportConnection';
  const POLL_MS = 6000;
  const TRIAGE_TIMEOUT_MS = 20 * 60 * 1000;
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

    async function post(path, body) {
      let response;
      try {
        response = await fetch(base + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch {
        throw new CxError(`Cannot reach the reminder server at ${new URL(base).host}. It must be running and reachable from this computer.`);
      }
      let parsed = null;
      try {
        parsed = await response.json();
      } catch {}
      if (!response.ok) throw new CxError(parsed?.error || `The reminder server answered ${response.status}.`, response.status, parsed);
      return parsed;
    }

    return {
      connect() {
        return post('/api/relay/status', {});
      },
      async triage(list) {
        const answer = await post('/api/relay/triage', { findings: list.map(wire) });
        showCredits(answer.creditsRemaining);
        return answer.results;
      },
      async results(list) {
        const out = [];
        for (let i = 0; i < list.length; i += 200) {
          out.push(...(await post('/api/relay/triage-results', { findings: list.slice(i, i + 200).map(wire) })).results);
        }
        return out;
      },
      async remediate(f) {
        const answer = await post('/api/relay/remediate', { findings: [wire(f)] });
        showCredits(answer.creditsRemaining);
        return answer;
      },
      remediationDetails(f) {
        return post('/api/relay/remediation-details', { findings: [wire(f)] });
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
    const ai = answer?.found ? triageFromBody(answer.body) : null;
    if (ai) f.triage = { ...ai, note: '' };
  }

  function renderTriage(f) {
    const tr = row(f);
    if (tr) {
      const cell = tr.querySelector('.ai-cell');
      const btn = tr.querySelector('[data-action="triage"]');
      const t = f.triage || {};
      const status = effectiveStatus(f);
      const stateCell = tr.querySelector('.state-cell');
      if (stateCell && f.state) stateCell.textContent = STATE_LABELS[f.state] || f.state.replace(/_/g, ' ').toLowerCase();
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
      } else {
        cell.textContent = t.note || '—';
      }
      if (btn && !f.aiUnavailable) {
        const busy = t.status === 'IN_PROGRESS' && !hasVerdict(f);
        const locked = !busy && hasVerdict(f) && !retriageAllowed();
        btn.disabled = busy || locked;
        btn.textContent = busy ? 'Triaging…' : locked ? 'Triaged' : hasVerdict(f) ? 'Re-triage' : 'Triage';
        btn.title = locked ? 'Already triaged. Triaging again is switched off by your administrator.' : '';
      }
    }
    updateBulk();
  }

  function triageCandidates(severity) {
    return findings.filter(
      (f) => f.severity === severity && !f.hidden && !f.aiUnavailable && !isRunning(f) && !hasVerdict(f),
    );
  }

  const isRunning = (f) => f.triage?.status === 'IN_PROGRESS' && !hasVerdict(f);

  function updateBulk() {
    const running = findings.filter(isRunning).length;
    for (const btn of bulkButtons()) {
      const severity = btn.dataset.severity;
      const label = SEVERITY_LABELS[severity];
      const n = triageCandidates(severity).length;
      const busy = findings.some((f) => f.severity === severity && isRunning(f));
      const any = findings.some((f) => f.severity === severity);
      btn.textContent = n
        ? `Triage all ${label} (${n})`
        : busy
          ? `Triaging ${label}…`
          : any
            ? `All ${label} triaged`
            : `No ${label} findings`;
      btn.disabled = bulkRunning || n === 0;
    }
    $('bulk-progress').textContent = running ? `${running} triage job${running === 1 ? '' : 's'} running…` : '';
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
        ? 'AI Triage uses 1 Checkmarx One credit per finding, AI Remediation 3.'
        : `AI Triage uses 1 Checkmarx One credit per finding, AI Remediation 3 · ${remaining} left this month.`;
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
    };
  }

  async function pollTriage(list) {
    const deadline = Date.now() + TRIAGE_TIMEOUT_MS;
    let waiting = list.slice();
    while (waiting.length && backend && Date.now() < deadline) {
      await sleep(POLL_MS);
      const answers = await backend.results(waiting);
      const still = [];
      waiting.forEach((f, i) => {
        applyAnswer(f, answers[i]);
        const status = effectiveStatus(f);
        if (status && !WAITING.has(status)) {
          f.settled = true;
          renderTriage(f);
          log(`AI Triage: ${f.title} → ${(VERDICTS[status] || [status])[0]}`, status === 'FAILED' ? 'error' : 'success');
        } else {
          still.push(f);
        }
      });
      waiting = still;
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
    if (!confirm(`Run AI Triage on all ${list.length} ${label} finding(s)${where}? This uses ${list.length} Checkmarx One credit(s).`)) return;
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
    note.textContent = `${n} finding${n === 1 ? '' : 's'} already triaged as not exploitable in Checkmarx One ${n === 1 ? 'is' : 'are'} not shown.`;
  }

  async function loadExistingTriage() {
    const eligible = findings.filter((f) => !f.aiUnavailable);
    if (!eligible.length) return;
    const answers = await backend.results(eligible);
    const resumed = [];
    eligible.forEach((f, i) => {
      applyAnswer(f, answers[i]);
      // Already triaged as not exploitable: nothing left to do here, so it is skipped.
      if (NOT_EXPLOITABLE.has(f.state) && !f.touched) {
        hideNotExploitable(f);
        return;
      }
      const ai = f.triage?.status;
      if (ai === 'IN_PROGRESS' && !hasVerdict(f)) resumed.push(f);
      else if (ai === 'TO_VERIFY') f.settled = true;
      renderTriage(f);
    });
    log(`Loaded Checkmarx One states: ${eligible.filter(hasVerdict).length} of ${eligible.length} eligible findings already triaged.`, 'success');
    if (resumed.length) pollTriage(resumed).catch(reportError);
  }

  // ---------------------------------------------------------------------------
  // AI Remediation
  // ---------------------------------------------------------------------------

  function link(text, href, download) {
    const a = document.createElement('a');
    a.href = href;
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
      prUrl: r.autoPr?.url || '',
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
      btn.disabled = r?.running === true;
      btn.textContent = r?.running ? 'Remediating…' : 'Remediate';
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

  async function remediate(f) {
    if (f.remediation?.running) return;
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
    if (!confirm(`Run Checkmarx One AI Remediation for "${f.title}"? It uses 3 Checkmarx One credits and, for repository-connected projects, opens a pull request.`)) return;
    f.remediation = { running: true };
    renderRemediation(f);
    try {
      const started = await backend.remediate(f);
      log(started.published ? `AI Remediation started: ${f.title}` : `AI Remediation already running for ${f.title}; following it.`, 'pending');
      const deadline = Date.now() + REMEDIATION_TIMEOUT_MS;
      while (Date.now() < deadline) {
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
    } catch (error) {
      if (isCreditRefusal(error.status, error.body)) {
        f.remediation = null;
        renderRemediation(f);
        return showCreditDialog([{ error: error.message, credits: error.body?.credits }]);
      }
      f.remediation = { failed: error.message };
      log(error.message, 'error');
    }
    renderRemediation(f);
  }

  // ---------------------------------------------------------------------------
  // Connect
  // ---------------------------------------------------------------------------

  async function connect({ quiet = false } = {}) {
    const candidate = relayBackend();
    const status = await candidate.connect();
    candidate.remediationAllowed = status.remediation !== false;
    candidate.retriageAllowed = status.retriage === true;
    candidate.adminContact = status.adminContact || '';
    backend = candidate;
    try {
      sessionStorage.setItem(STORE, 'relay');
    } catch {}
    setConnectedUI(status.tenant);
    showCredits(status.creditsRemaining);
    updateBulk();
    banner('');
    if (!quiet) log(`Connected to Checkmarx One (${status.tenant}) through the reminder server.`, 'success');
    for (const f of findings) if (hasVerdict(f)) renderTriage(f);
    loadExistingTriage().catch(reportError);
  }

  function disconnect() {
    backend = null;
    try {
      sessionStorage.removeItem(STORE);
    } catch {}
    setConnectedUI();
    updateBulk();
    log('Disconnected from Checkmarx One.', 'info');
  }

  /** Connect first if needed (once, however many buttons are clicked), then act. */
  function requireConnection(action) {
    if (backend) return action();
    if (!config.relayUrl) return reportError(new CxError('This report was generated without a reminder server address.'));
    connecting ??= connect().finally(() => {
      connecting = null;
    });
    connecting.then(action, reportError);
  }

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
    else requireConnection(() => (hasVerdict(f) && !retriageAllowed() ? renderTriage(f) : triage([f]).catch(handleActionError)));
  });

  setConnectedUI();
  for (const f of findings) if (f.state && f.state !== 'TO_VERIFY') renderTriage(f);
  updateBulk();

  // Reconnect automatically if this report was connected earlier in this tab.
  let saved = null;
  try {
    saved = sessionStorage.getItem(STORE);
  } catch {}
  if (saved === 'relay' && config.relayUrl) {
    connect({ quiet: true }).catch((error) => log(`Could not reconnect: ${error.message}`, 'error'));
  }
})();
