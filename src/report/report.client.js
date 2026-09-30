/*
 * Runs inside the emailed HTML report.
 *
 * Remediate opens the finding in Checkmarx One Risk Hub. Triage runs
 * Checkmarx One AI Triage through the reminder server, which calls Checkmarx
 * One with its own stored connection (Checkmarx One refuses API calls from a
 * page opened as a file). The report carries a signed grant for each finding,
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
    constructor(message, status = 0) {
      super(message);
      this.status = status;
    }
  }

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
      if (!response.ok) throw new CxError(parsed?.error || `The reminder server answered ${response.status}.`, response.status);
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
        btn.disabled = busy;
        btn.textContent = busy ? 'Triaging…' : hasVerdict(f) ? 'Re-triage' : 'Triage';
      }
    }
    updateBulk();
  }

  function triageCandidates(severity) {
    return findings.filter(
      (f) => f.severity === severity && !f.aiUnavailable && !isRunning(f) && !hasVerdict(f),
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
      btn.textContent = n ? `Triage all ${label} (${n})` : busy ? `Triaging ${label}…` : `All ${label} triaged`;
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
        ? 'AI Triage uses 1 Checkmarx One credit per finding.'
        : `AI Triage uses 1 Checkmarx One credit per finding · ${remaining} left this month.`;
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
    for (const result of results) {
      const group = list.filter((f) => result.alternateIds.includes(f.alternateId));
      if (result.ok) {
        for (const f of group) {
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
      } else {
        reportError(new CxError(result.error, result.status));
      }
    }
    // Results arrive over minutes; follow them in the background so other
    // actions stay available meanwhile.
    if (started.length) pollTriage(started).catch(reportError);
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
      reportError(error);
    } finally {
      bulkRunning = false;
      updateBulk();
    }
  }

  async function loadExistingTriage() {
    const eligible = findings.filter((f) => !f.aiUnavailable);
    if (!eligible.length) return;
    const answers = await backend.results(eligible);
    const resumed = [];
    eligible.forEach((f, i) => {
      applyAnswer(f, answers[i]);
      const ai = f.triage?.status;
      if (ai === 'IN_PROGRESS' && !hasVerdict(f)) resumed.push(f);
      else if (ai === 'TO_VERIFY') f.settled = true;
      renderTriage(f);
    });
    log(`Loaded Checkmarx One states: ${eligible.filter(hasVerdict).length} of ${eligible.length} eligible findings already triaged.`, 'success');
    if (resumed.length) pollTriage(resumed).catch(reportError);
  }

  // ---------------------------------------------------------------------------
  // Connect
  // ---------------------------------------------------------------------------

  async function connect({ quiet = false } = {}) {
    const candidate = relayBackend();
    const status = await candidate.connect();
    backend = candidate;
    try {
      sessionStorage.setItem(STORE, 'relay');
    } catch {}
    setConnectedUI(status.tenant);
    showCredits(status.creditsRemaining);
    updateBulk();
    banner('');
    if (!quiet) log(`Connected to Checkmarx One (${status.tenant}) through the reminder server.`, 'success');
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
    const btn = event.target.closest('button[data-action="triage"]');
    if (!btn) return;
    const f = byKey.get(btn.closest('tr').dataset.key);
    if (!f || f.aiUnavailable) return;
    requireConnection(() => triage([f]).catch(reportError));
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
