/*
 * Runs inside the emailed HTML report.
 *
 * Remediate opens the finding in Checkmarx One Risk Hub. Triage runs
 * Checkmarx One AI Triage from the report, over one of two connections:
 *   1. through the reminder server, which calls Checkmarx One with its own
 *      stored connection (the report carries signed grants for its findings);
 *   2. direct to Checkmarx One through the "Checkmarx One Report Connector"
 *      browser extension. Checkmarx One refuses API calls from a page opened
 *      as a file; the extension is exempt. It signs the reader in on the
 *      Checkmarx One login page and keeps that session.
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
  const CONNECTOR = 'cx-report-connector';
  const POLL_MS = 6000;
  const TRIAGE_TIMEOUT_MS = 20 * 60 * 1000;
  const WAITING = new Set(['IN_PROGRESS', 'NOT_TRIAGED', 'PENDING', 'QUEUED', 'RUNNING']);

  const VERDICTS = {
    VULNERABLE: ['Vulnerable', 'bad'],
    PROPOSED_NOT_EXPLOITABLE: ['Proposed not exploitable', 'good'],
    NOT_EXPLOITABLE: ['Not exploitable', 'good'],
    UNCERTAIN: ['Uncertain', 'warn'],
    RISK_ACCEPTED: ['Risk accepted', 'muted'],
    TO_VERIFY: ['To verify', 'muted'],
    CONFIRMED: ['Confirmed', 'bad'],
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

  let backend = null;
  let afterConnect = null;
  let bulkRunning = false;

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

  function describeFailure(status, body, action) {
    const detail = (body && (body.message || body.error || body.detail)) || '';
    if (status === 402) return `Not enough Checkmarx One credits to run ${action}.`;
    if (status === 403) return `Your Checkmarx One role is not allowed to run ${action}. Ask an admin for the AI Triage permissions.`;
    if (status === 422) return `Checkmarx One could not accept this ${action} request${detail ? `: ${detail}` : '.'}`;
    if (status === 503) return `${action} is temporarily unavailable in Checkmarx One. Try again shortly.`;
    return `${action} failed (${status})${detail ? `: ${detail}` : ''}`;
  }

  /** Split findings into one AI Triage request per scan and scanner, whatever the project. */
  function bucketsOf(list) {
    const groups = new Map();
    for (const f of list) {
      const key = `${f.scanId}|${f.scanner}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    return [...groups.values()];
  }

  // ---------------------------------------------------------------------------
  // Option 1: through the reminder server
  // ---------------------------------------------------------------------------

  const wire = (f) => ({
    projectId: f.projectId,
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
      mode: 'relay',
      label: 'via reminder server',
      async connect() {
        return { tenant: (await post('/api/relay/status', {})).tenant };
      },
      async triage(list) {
        return (await post('/api/relay/triage', { findings: list.map(wire) })).results;
      },
      async results(list) {
        const out = [];
        for (let i = 0; i < list.length; i += 200) {
          out.push(...(await post('/api/relay/triage-results', { findings: list.slice(i, i + 200).map(wire) })).results);
        }
        return out;
      },
      disconnect() {},
    };
  }

  // ---------------------------------------------------------------------------
  // Option 2: direct, through the Report Connector extension
  // ---------------------------------------------------------------------------

  const connectorVersion = () => document.documentElement.getAttribute('data-cx-report-connector');
  const pendingCalls = new Map();
  let callSeq = 0;

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== window || data?.channel !== CONNECTOR || data.kind !== 'response') return;
    const settle = pendingCalls.get(data.id);
    if (!settle) return;
    pendingCalls.delete(data.id);
    settle(data.response || { error: 'The Report Connector returned nothing.' });
  });

  /** Ask the extension to do something; it answers {ok, ...} or {error}. */
  function connector(op, args = {}, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const id = `c${++callSeq}`;
      const timer = setTimeout(() => {
        pendingCalls.delete(id);
        reject(new CxError('The Report Connector extension did not answer.'));
      }, timeoutMs);
      pendingCalls.set(id, (response) => {
        clearTimeout(timer);
        if (response.error) reject(new CxError(response.error, response.status || 0));
        else resolve(response);
      });
      window.postMessage({ channel: CONNECTOR, kind: 'request', id, request: { op, ...args } }, '*');
    });
  }

  function directBackend(signIn) {
    const target = {
      iamUrl: config.iamUrl,
      tenant: config.tenant,
      apiBaseUrl: config.apiBaseUrl,
      portalUrl: config.portalUrl || config.apiBaseUrl,
    };

    async function api(path, { method = 'GET', body, action = 'The request' } = {}) {
      const response = await connector('api', { ...target, method, path, body: body ?? null });
      let parsed = null;
      try {
        parsed = response.text ? JSON.parse(response.text) : null;
      } catch {}
      if ((response.status >= 200 && response.status < 300) || response.status === 404) return { status: response.status, body: parsed };
      if (response.status === 401) throw new CxError('Your Checkmarx One session has ended. Connect again.', 401);
      throw new CxError(describeFailure(response.status, parsed, action), response.status);
    }

    return {
      mode: 'direct',
      label: 'direct',
      async connect() {
        if (!connectorVersion()) {
          throw new CxError('The “Checkmarx One Report Connector” browser extension is not installed (or not allowed to read local files).');
        }
        const session = await signIn(target);
        await api('/api/projects?limit=1&offset=0', { action: 'Connection check' });
        return { tenant: session.tenant || target.tenant };
      },
      async triage(list) {
        const results = [];
        for (const group of bucketsOf(list)) {
          const alternateIds = [...new Set(group.map((f) => f.alternateId))];
          try {
            const { body } = await api('/api/ai-triage/triage', {
              method: 'POST',
              action: 'AI Triage',
              body: { scanID: group[0].scanId, buckets: [{ scannerType: group[0].scanner.toLowerCase(), resultIDs: alternateIds }] },
            });
            results.push({ alternateIds, ok: true, published: body?.published !== false });
          } catch (error) {
            results.push({ alternateIds, ok: false, status: error.status, error: error.message });
            if (!error.status || error.status === 401 || error.status === 402 || error.status === 403) break;
          }
        }
        return results;
      },
      async results(list) {
        const out = new Array(list.length);
        let cursor = 0;
        const worker = async () => {
          while (cursor < list.length) {
            const index = cursor++;
            const f = list[index];
            try {
              const { status, body } = await api(
                `/api/ai-triage/triage/${encodeURIComponent(f.projectId)}/${encodeURIComponent(f.groupId)}`,
                { action: 'AI Triage lookup' },
              );
              out[index] = status === 404 ? { found: false } : { found: true, body };
            } catch (error) {
              if (!error.status || error.status === 401) throw error;
              out[index] = { found: false, status: error.status, error: error.message };
            }
          }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        return out;
      },
      disconnect() {
        connector('signout', target).catch(() => {});
      },
    };
  }

  /** Sign in on the Checkmarx One login page; the extension keeps the session. */
  const loginSignIn = (target) => connector('signin', target, 6 * 60 * 1000);
  /** Reuse a session the extension already holds, without opening the login page. */
  const existingSession = async (target) => {
    const status = await connector('status', target);
    if (!status.signedIn) throw new CxError('Not signed in.');
    return status;
  };
  const apiKeySignIn = (apiKey) => (target) => connector('signin-key', { ...target, apiKey });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  const hasVerdict = (f) => Boolean(f.triage?.status) && !WAITING.has(f.triage.status) && f.triage.status !== 'FAILED';

  function renderTriage(f) {
    const tr = row(f);
    if (tr) {
      const cell = tr.querySelector('.ai-cell');
      const btn = tr.querySelector('[data-action="triage"]');
      const t = f.triage;
      cell.replaceChildren();
      if (t?.status && t.status !== 'NOT_TRIAGED') {
        const [label, tone] = VERDICTS[t.status] || [t.status.replace(/_/g, ' ').toLowerCase(), 'muted'];
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
        cell.textContent = t?.note || '—';
      }
      if (btn && !f.aiUnavailable) {
        const busy = t?.status === 'IN_PROGRESS';
        btn.disabled = busy;
        btn.textContent = busy ? 'Triaging…' : hasVerdict(f) ? 'Re-triage' : 'Triage';
      }
    }
    updateBulk();
  }

  function triageCandidates(severity) {
    return findings.filter(
      (f) => f.severity === severity && !f.aiUnavailable && f.triage?.status !== 'IN_PROGRESS' && !hasVerdict(f),
    );
  }

  function updateBulk() {
    const running = findings.filter((f) => f.triage?.status === 'IN_PROGRESS').length;
    for (const btn of bulkButtons()) {
      const severity = btn.dataset.severity;
      const label = SEVERITY_LABELS[severity];
      const n = triageCandidates(severity).length;
      const busy = findings.some((f) => f.severity === severity && f.triage?.status === 'IN_PROGRESS');
      btn.textContent = n ? `Triage all ${label} (${n})` : busy ? `Triaging ${label}…` : `All ${label} triaged`;
      btn.disabled = bulkRunning || n === 0;
    }
    $('bulk-progress').textContent = running ? `${running} triage job${running === 1 ? '' : 's'} running…` : '';
  }

  function setConnectedUI(tenant) {
    const btn = $('connect');
    btn.textContent = backend ? `✓ Connected to CxONE · ${tenant} (${backend.label})` : 'Connect to CxONE for action';
    btn.classList.toggle('connected', Boolean(backend));
    $('bulk-credits').textContent = backend ? 'AI Triage uses 1 Checkmarx One credit per finding.' : '';
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
        const result = answers[i]?.found ? triageFromBody(answers[i].body) : null;
        if (result && !WAITING.has(result.status)) {
          f.triage = result;
          renderTriage(f);
          log(`AI Triage: ${f.title} → ${(VERDICTS[result.status] || [result.status])[0]}`, result.status === 'FAILED' ? 'error' : 'success');
        } else {
          still.push(f);
        }
      });
      waiting = still;
    }
    for (const f of waiting) {
      f.triage = { status: '', note: 'Still running — see Checkmarx One' };
      renderTriage(f);
    }
    if (waiting.length) log(`${waiting.length} AI Triage job(s) are still running; the results will appear in Checkmarx One.`, 'info');
  }

  async function triage(list) {
    const results = await backend.triage(list);
    const started = [];
    for (const result of results) {
      const group = list.filter((f) => result.alternateIds.includes(f.alternateId));
      if (result.ok) {
        for (const f of group) {
          f.triage = { status: 'IN_PROGRESS' };
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
      const result = answers[i]?.found ? triageFromBody(answers[i].body) : null;
      if (!result) return;
      f.triage = result;
      renderTriage(f);
      if (result.status === 'IN_PROGRESS') resumed.push(f);
    });
    log(`Loaded AI Triage results: ${eligible.filter(hasVerdict).length} of ${eligible.length} eligible findings already triaged.`, 'success');
    if (resumed.length) pollTriage(resumed).catch(reportError);
  }

  // ---------------------------------------------------------------------------
  // Connect
  // ---------------------------------------------------------------------------

  function renderConnectorStatus() {
    const version = connectorVersion();
    $('connector-status').textContent = version
      ? `✓ Report Connector ${version} installed`
      : 'Needs the “Checkmarx One Report Connector” browser extension, with “Allow access to file URLs” switched on.';
    $('connector-status').className = version ? 'ok' : 'muted';
    $('direct-connect').disabled = !version;
  }

  function openConnect(then = null) {
    afterConnect = then;
    $('connect-status').textContent = '';
    renderConnectorStatus();
    $('connect-dialog').showModal();
  }

  async function connectWith(candidate, { quiet = false } = {}) {
    const { tenant } = await candidate.connect();
    backend = candidate;
    try {
      sessionStorage.setItem(STORE, candidate.mode);
    } catch {}
    setConnectedUI(tenant);
    updateBulk();
    if (!quiet) log(`Connected to Checkmarx One (${tenant}) ${candidate.label}.`, 'success');
    loadExistingTriage().catch(reportError);
  }

  async function submitConnect(makeBackend, button, waitingText) {
    const status = $('connect-status');
    status.textContent = waitingText;
    button.disabled = true;
    try {
      await connectWith(makeBackend());
      $('connect-dialog').close();
      banner('');
      const then = afterConnect;
      afterConnect = null;
      if (then) then();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
      renderConnectorStatus();
    }
  }

  function disconnect() {
    backend?.disconnect();
    backend = null;
    try {
      sessionStorage.removeItem(STORE);
    } catch {}
    setConnectedUI();
    updateBulk();
    log('Disconnected from Checkmarx One.', 'info');
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  const requireConnection = (action) => (backend ? action() : openConnect(action));

  $('connect').addEventListener('click', () => {
    if (!backend) return openConnect();
    if (confirm('Disconnect from Checkmarx One?')) disconnect();
  });
  if ($('relay-connect')) {
    $('relay-connect').addEventListener('click', () =>
      submitConnect(relayBackend, $('relay-connect'), 'Connecting to the reminder server…'),
    );
  }
  $('direct-connect').addEventListener('click', () =>
    submitConnect(() => directBackend(loginSignIn), $('direct-connect'), 'Sign in on the Checkmarx One page that opened; it closes by itself when you are done.'),
  );
  $('key-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const apiKey = $('key-input').value.trim();
    if (!apiKey) return;
    submitConnect(() => directBackend(apiKeySignIn(apiKey)), $('key-submit'), 'Connecting…');
  });
  $('connect-cancel').addEventListener('click', () => $('connect-dialog').close());

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
  updateBulk();

  // Pick up where this browser left off: the extension keeps its session.
  let saved = null;
  try {
    saved = sessionStorage.getItem(STORE);
  } catch {}
  if (saved === 'relay' && config.relayUrl) {
    connectWith(relayBackend(), { quiet: true }).catch((error) => log(`Could not reconnect: ${error.message}`, 'error'));
  } else if (connectorVersion()) {
    connectWith(directBackend(existingSession), { quiet: true }).catch(() => {});
  }
})();
