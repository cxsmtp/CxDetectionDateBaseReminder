/*
 * Runs inside the emailed HTML report. Triage and Remediate are links into
 * Checkmarx One Risk Hub (the reader's own portal login). Optionally, with an
 * API key, AI Triage runs from the report itself: the key is exchanged for a
 * token at the tenant's IAM and the AI Triage API is called directly.
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

  const KEY_STORE = 'cxReportApiKey';
  const POLL_MS = 6000;
  const TRIAGE_TIMEOUT_MS = 20 * 60 * 1000;
  const TERMINAL_WAIT = new Set(['IN_PROGRESS', 'NOT_TRIAGED', 'PENDING', 'QUEUED', 'RUNNING']);

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

  let auth = null;
  let bulkRunning = false;

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const row = (f) => document.querySelector(`tr[data-key="${CSS.escape(f.key)}"]`);

  // ---------------------------------------------------------------------------
  // Activity log
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

  // ---------------------------------------------------------------------------
  // Checkmarx One access
  // ---------------------------------------------------------------------------

  class CxError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  function decodeKey(apiKey) {
    try {
      const payload = String(apiKey).trim().split('.')[1];
      const json = JSON.parse(
        decodeURIComponent(
          atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
            .split('')
            .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
            .join(''),
        ),
      );
      const match = String(json.iss || '').match(/^(https?:\/\/[^/]+)\/auth\/realms\/([^/?#]+)/);
      if (!match) return null;
      return { iamUrl: match[1], tenant: decodeURIComponent(match[2]) };
    } catch {
      return null;
    }
  }

  function connectionFor(apiKey) {
    const claims = decodeKey(apiKey);
    if (!claims) return null;
    const sameTenant = config.tenant && claims.tenant === config.tenant;
    const iamUrl = sameTenant && config.iamUrl ? config.iamUrl : claims.iamUrl;
    const derivedApi = claims.iamUrl.replace(/\/\/iam\./i, '//ast.').replace(/\.iam\./i, '.ast.');
    return {
      apiKey,
      tenant: claims.tenant,
      sameTenant,
      tokenUrl: `${iamUrl}/auth/realms/${encodeURIComponent(claims.tenant)}/protocol/openid-connect/token`,
      apiBase: sameTenant && config.apiBaseUrl ? config.apiBaseUrl : derivedApi,
      token: null,
      expiresAt: 0,
    };
  }

  async function send(url, init) {
    try {
      return await fetch(url, init);
    } catch {
      throw new CxError(
        `The browser could not complete a request to ${new URL(url).host}. Either this computer cannot reach ` +
          'Checkmarx One, or Checkmarx One does not accept requests from a report opened as a local file (CORS). ' +
          'The browser console (F12) shows which.',
        0,
      );
    }
  }

  async function getToken(force = false) {
    if (!force && auth.token && Date.now() < auth.expiresAt) return auth.token;
    const response = await send(auth.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'ast-app', refresh_token: auth.apiKey }),
    });
    if (!response.ok) {
      throw new CxError('Checkmarx One rejected this API key (invalid, revoked or expired).', response.status);
    }
    const data = await response.json();
    auth.token = data.access_token;
    auth.expiresAt = Date.now() + Math.max(((Number(data.expires_in) || 600) - 30) * 1000, 5000);
    return auth.token;
  }

  function describeFailure(status, body, action) {
    const detail = (body && (body.message || body.error || body.detail)) || '';
    if (status === 402) return `Not enough Checkmarx One credits to run ${action}.`;
    if (status === 403) return `This API key's role is not allowed to run ${action}. Ask an admin for the AI Triage / Remediation permissions.`;
    if (status === 422) return `Checkmarx One could not accept this ${action} request${detail ? `: ${detail}` : '.'}`;
    if (status === 503) return `${action} is temporarily unavailable in Checkmarx One. Try again shortly.`;
    return `${action} failed (${status})${detail ? `: ${detail}` : ''}`;
  }

  /** Call the Checkmarx One API. Resolves {status, body}; 404 is not an error. */
  async function api(path, { method = 'GET', body, action = 'The request' } = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await getToken(attempt > 0);
      const response = await send(auth.apiBase + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json; version=1.0',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (response.status === 401 && attempt === 0) continue;
      let parsed = null;
      try {
        parsed = await response.json();
      } catch {}
      if (response.ok || response.status === 404) return { status: response.status, body: parsed };
      throw new CxError(describeFailure(response.status, parsed, action), response.status);
    }
    throw new CxError('Checkmarx One keeps rejecting the access token. Reconnect with a fresh API key.', 401);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function renderTriage(f) {
    const tr = row(f);
    if (!tr) return;
    const cell = tr.querySelector('.ai-cell');
    const btn = tr.querySelector('[data-action="triage"]');
    const t = f.triage;
    cell.replaceChildren();

    if (t && t.status && t.status !== 'NOT_TRIAGED') {
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
      if (t.error) cell.title = t.error;
    } else {
      cell.textContent = '—';
    }

    if (btn && auth && !f.aiUnavailable) {
      const busy = t?.status === 'IN_PROGRESS';
      btn.classList.toggle('is-busy', busy);
      btn.textContent = busy ? 'Triaging…' : hasVerdict(f) ? 'Re-triage' : 'Triage';
    }
    updateBulk();
  }

  const hasVerdict = (f) =>
    Boolean(f.triage?.status) && !TERMINAL_WAIT.has(f.triage.status) && f.triage.status !== 'FAILED';

  function triageCandidates() {
    return findings.filter((f) => !f.aiUnavailable && f.triage?.status !== 'IN_PROGRESS' && !hasVerdict(f));
  }

  function updateBulk() {
    const btn = $('bulk-triage');
    btn.hidden = !auth;
    $('bulk-portal').hidden = Boolean(auth);
    if (!auth) {
      $('bulk-credits').textContent = '';
      $('bulk-progress').textContent = '';
      return;
    }
    const n = triageCandidates().length;
    const running = findings.filter((f) => f.triage?.status === 'IN_PROGRESS').length;
    btn.disabled = bulkRunning || n === 0;
    btn.textContent = n ? `Triage ${n} finding${n === 1 ? '' : 's'}` : 'All eligible findings triaged';
    $('bulk-credits').textContent = n ? `Uses ${n} Checkmarx One credit${n === 1 ? '' : 's'} (1 per finding)` : '';
    $('bulk-progress').textContent = running ? `${running} triage job${running === 1 ? '' : 's'} running…` : '';
  }

  function setConnectedUI() {
    $('connect').textContent = auth ? `✓ API connected · ${auth.tenant} (disconnect)` : 'Run AI Triage here with an API key';
    $('connect').classList.toggle('connected', Boolean(auth));
    for (const f of findings) {
      const btn = row(f)?.querySelector('[data-action="triage"]');
      if (btn && !(auth && !f.aiUnavailable)) {
        btn.classList.remove('is-busy');
        btn.textContent = 'Triage';
      }
    }
    updateBulk();
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

  async function readTriage(f) {
    const { status, body } = await api(
      `/api/ai-triage/triage/${encodeURIComponent(f.projectId)}/${encodeURIComponent(f.groupId)}`,
      { action: 'AI Triage lookup' },
    );
    return status === 404 ? null : triageFromBody(body);
  }

  async function pollTriage(list) {
    const deadline = Date.now() + TRIAGE_TIMEOUT_MS;
    let waiting = list.slice();
    while (waiting.length && Date.now() < deadline) {
      await sleep(POLL_MS);
      const still = [];
      for (const f of waiting) {
        try {
          const result = await readTriage(f);
          if (result && !TERMINAL_WAIT.has(result.status)) {
            f.triage = result;
            renderTriage(f);
            log(`AI Triage: ${f.title} → ${(VERDICTS[result.status] || [result.status])[0]}`, result.status === 'FAILED' ? 'error' : 'success');
          } else {
            still.push(f);
          }
        } catch (error) {
          if (error.status === 0 || error.status === 401) throw error;
          still.push(f);
        }
      }
      waiting = still;
    }
    for (const f of waiting) {
      f.triage = { status: '', error: 'Still running in Checkmarx One — reconnect later to see the result.' };
      renderTriage(f);
      log(`AI Triage for ${f.title} is taking longer than expected; the result will appear in Checkmarx One.`, 'info');
    }
  }

  async function triage(list) {
    const buckets = new Map();
    for (const f of list) {
      const key = `${f.scanId}|${f.scanner}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(f);
    }

    const started = [];
    for (const group of buckets.values()) {
      const { scanId, scanner } = group[0];
      const resultIDs = [...new Set(group.map((f) => f.alternateId))];
      try {
        const { body } = await api('/api/ai-triage/triage', {
          method: 'POST',
          action: 'AI Triage',
          body: { scanID: scanId, buckets: [{ scannerType: scanner.toLowerCase(), resultIDs }] },
        });
        for (const f of group) {
          f.triage = { status: 'IN_PROGRESS' };
          renderTriage(f);
        }
        started.push(...group);
        log(
          body && body.published === false
            ? `AI Triage already running for ${group.length} finding(s); following the existing job.`
            : `AI Triage started for ${group.length} finding(s).`,
          'pending',
        );
      } catch (error) {
        log(error.message, 'error');
        banner(error.message);
        if (error.status === 0 || error.status === 401 || error.status === 402 || error.status === 403) break;
      }
    }
    if (started.length) await pollTriage(started);
  }

  async function bulkTriage() {
    if (!auth) return;
    const list = triageCandidates();
    if (!list.length) return;
    if (!confirm(`Run AI Triage on ${list.length} finding(s)? This uses ${list.length} Checkmarx One credit(s).`)) return;
    bulkRunning = true;
    updateBulk();
    try {
      await triage(list);
    } catch (error) {
      banner(error.message);
      log(error.message, 'error');
    } finally {
      bulkRunning = false;
      updateBulk();
    }
  }

  async function loadExistingTriage() {
    const eligible = findings.filter((f) => !f.aiUnavailable);
    let cursor = 0;
    const resumed = [];
    const worker = async () => {
      while (cursor < eligible.length) {
        const f = eligible[cursor++];
        const result = await readTriage(f);
        if (result) {
          f.triage = result;
          renderTriage(f);
          if (result.status === 'IN_PROGRESS') resumed.push(f);
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    const done = eligible.filter((f) => f.triage && !TERMINAL_WAIT.has(f.triage.status)).length;
    log(`Loaded AI Triage results: ${done} of ${eligible.length} eligible findings already triaged.`, 'success');
    if (resumed.length) pollTriage(resumed).catch((error) => log(error.message, 'error'));
  }

  // ---------------------------------------------------------------------------
  // Connect
  // ---------------------------------------------------------------------------

  function openConnect() {
    $('key-input').value = '';
    $('key-status').textContent = '';
    $('key-detected').hidden = true;
    $('connect-dialog').showModal();
    $('key-input').focus();
  }

  async function connect(apiKey, { quiet = false } = {}) {
    const candidate = connectionFor(apiKey);
    if (!candidate) throw new CxError('That does not look like a Checkmarx One API key.', 400);
    const previous = auth;
    auth = candidate;
    try {
      await getToken(true);
      await api('/api/projects?limit=1&offset=0', { action: 'Connection check' });
    } catch (error) {
      auth = previous;
      throw error;
    }
    try {
      sessionStorage.setItem(KEY_STORE, apiKey);
    } catch {}
    setConnectedUI();
    banner('');
    if (!candidate.sameTenant && config.tenant) {
      banner(`This key is for tenant "${candidate.tenant}", but the report was generated from "${config.tenant}". Actions will fail unless the findings exist there.`, 'warn');
    }
    if (!quiet) log(`Connected to Checkmarx One (${candidate.tenant}).`, 'success');
    loadExistingTriage().catch((error) => log(error.message, 'error'));
  }

  async function submitKey(event) {
    event.preventDefault();
    const apiKey = $('key-input').value.trim();
    const status = $('key-status');
    const claims = decodeKey(apiKey);
    if (!claims) {
      status.textContent = 'That does not look like a Checkmarx One API key.';
      return;
    }
    $('key-tenant').textContent = claims.tenant;
    $('key-host').textContent = new URL(claims.iamUrl).host;
    $('key-detected').hidden = false;
    status.textContent = 'Connecting…';
    $('key-submit').disabled = true;
    try {
      await connect(apiKey);
      $('connect-dialog').close();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      $('key-submit').disabled = false;
    }
  }

  function disconnect() {
    auth = null;
    try {
      sessionStorage.removeItem(KEY_STORE);
    } catch {}
    setConnectedUI();
    log('Disconnected from Checkmarx One.', 'info');
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  $('connect').addEventListener('click', () => (auth ? confirm('Disconnect from Checkmarx One?') && disconnect() : openConnect()));
  $('key-form').addEventListener('submit', submitKey);
  $('key-cancel').addEventListener('click', () => $('connect-dialog').close());
  $('bulk-triage').addEventListener('click', bulkTriage);
  // Triage opens the finding in Checkmarx One Risk Hub, unless an API key is
  // connected, in which case it runs AI Triage right here.
  $('findings').addEventListener('click', (event) => {
    const btn = event.target.closest('a[data-action="triage"]');
    if (!btn || !auth) return;
    const f = byKey.get(btn.closest('tr').dataset.key);
    if (!f || f.aiUnavailable) return;
    event.preventDefault();
    if (btn.classList.contains('is-busy')) return;
    triage([f]).catch((error) => {
      banner(error.message);
      log(error.message, 'error');
    });
  });

  updateBulk();
  setConnectedUI();
  let stored = null;
  try {
    stored = sessionStorage.getItem(KEY_STORE);
  } catch {}
  if (stored) {
    connect(stored, { quiet: true }).catch((error) => log(`Could not reconnect: ${error.message}`, 'error'));
  }
})();
