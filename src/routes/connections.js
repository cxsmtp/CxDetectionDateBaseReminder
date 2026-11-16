/**
 * The server's own connections, and keeping them working (src/connection-guard.js).
 *
 * - The Checkmarx One integration: its state (GET /api/integration) and connecting or removing the key
 *   (/api/integration/cxone).
 * - Last known good connections: settings save as typed, and a change that does not work is rolled back. The
 *   check itself (checkConnections), what is pending, the settings mail is sent with meanwhile
 *   (sendingSettings), and the routes around it: /api/settings/connections, the draft of new Checkmarx One
 *   details, importing a .env file, and acknowledging a notice.
 */
import { config } from '../config.js';
import { checkServiceUrl, publicConnection } from '../cxone/endpoints.js';
import { testConnection } from '../mailer.js';
import { checkCxKey, checkEnvFile, explainCxone, explainSmtp, refusedByCheck } from '../troubleshoot.js';
import { isVerified, overlayBranding, smtpFingerprint } from '../settings.js';
import { describeCxone, describeSmtp } from '../connection-guard.js';
import { ENV_SETTINGS, isSecretVariable, parseEnvText, settingsFromEnv } from '../env-import.js';
import { numberedVariable } from '../scm/instances.js';
import { SYSTEM_ACTOR } from './shared.js';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerConnectionRoutes(app, d) {
  const {
    sessions, tenancy, tstate, settingsStore, guard, audit, integrationOverrides, integrationSession,
    keyForEndpoints, cxoneFingerprint, activateIntegration, resolveAutomationSession, productActive, asyncRoute,
    requireSession, presenting, can, requirePermission, adminActor, ssoAddressProblem, connectCheckmarxOne,
    settingsFor,
  } = d;

  // ---------------------------------------------------------------------------
  // Checkmarx One integration: the server's own connection (Admin)
  // ---------------------------------------------------------------------------

  function integrationStatus() {
    const session = integrationSession();
    const settings = settingsStore.get();
    let connection = null;
    try {
      connection = session ? publicConnection(session.connection) : null;
    } catch {}
    return {
      connected: Boolean(session),
      source: session ? (session.id === tstate.automationSessionId ? 'stored' : 'environment') : settings.automationApiKey ? 'stored (not reachable)' : 'none',
      keyStored: Boolean(settings.automationApiKey),
      environmentKey: Boolean(config.bootstrapApiKey),
      overrides: settings.integrationOverrides ?? { baseUrl: '', iamUrl: '', tenant: '' },
      connection,
      // Saved but not working yet: the running connection stays the last known good one.
      pending: cxonePending(settings),
      lastGood: lastGoodView('cxone'),
    };
  }

  app.get('/api/integration', requirePermission('settings.view', 'integration.cxone'), (req, res) => res.json(integrationStatus()));

  /** Connect the server to Checkmarx One with an API key, verified first, then stored. */
  app.post(
    '/api/integration/cxone',
    requirePermission('integration.cxone'),
    asyncRoute(async (req, res) => {
      const { apiKey, baseUrl = '', iamUrl = '', tenant = '' } = req.body ?? {};
      // Use this session's own key when none is pasted (signed in with a Checkmarx One key).
      const key = String(apiKey ?? '').trim() || (req.session.via === 'cxone' ? req.session.connection.apiKey : '');
      if (!key) return res.status(400).json({ error: 'Paste a Checkmarx One API key.', help: explainCxone(new Error('no key'), { apiKey: '' }) });
      // A key that cannot work (its ID, cut short, quoted, expired) is said so before it is tried.
      const malformed = checkCxKey(key);
      if (malformed && malformed !== 'cx.key-no-issuer') {
        const help = explainCxone(new Error('malformed'), { apiKey: key });
        return res.status(400).json({ error: help.problem, help });
      }
      const overrides = { baseUrl: String(baseUrl).trim().replace(/\/+$/, ''), iamUrl: String(iamUrl).trim().replace(/\/+$/, ''), tenant: String(tenant).trim() };
      // Typed addresses are checked before the key goes anywhere: https, never a link-local or metadata address.
      if (overrides.baseUrl) overrides.baseUrl = checkServiceUrl(overrides.baseUrl, 'API URL');
      if (overrides.iamUrl) overrides.iamUrl = checkServiceUrl(overrides.iamUrl, 'IAM URL');
      const session = await connectCheckmarxOne(key, {
        baseUrl: overrides.baseUrl || config.overrides.baseUrl,
        iamUrl: overrides.iamUrl || config.overrides.iamUrl,
        tenant: overrides.tenant || config.overrides.tenant,
      });
      settingsStore.save({ automationApiKey: key, integrationOverrides: overrides });
      activateIntegration(session, key, overrides);
      noteConnectionHelp('cxone', { ok: true });
      audit.record({ type: 'settings', outcome: 'changed', reason: `Checkmarx One integration connected to tenant ${session.connection.tenant}.`, actor: await adminActor(req), details: { tenant: session.connection.tenant, baseUrl: session.connection.baseUrl } });
      res.json(integrationStatus());
    }),
  );

  app.delete(
    '/api/integration/cxone',
    requirePermission('integration.cxone'),
    asyncRoute(async (req, res) => {
      settingsStore.save({ automationApiKey: '' });
      if (tstate.automationSessionId) sessions.destroy(tstate.automationSessionId);
      tstate.automationSessionId = null;
      tstate.integrationFingerprint = null;
      audit.record({ type: 'settings', outcome: 'changed', reason: 'Stored Checkmarx One integration key removed.', actor: await adminActor(req) });
      res.json(integrationStatus());
    }),
  );

  // ---------------------------------------------------------------------------
  // Last known good connections: settings save as typed; a change that does not
  // work is rolled back (src/connection-guard.js)
  // ---------------------------------------------------------------------------

  const CONNECTION_CHECK_TIMEOUT_MS = Math.max(1000, Number(process.env.CONNECTION_CHECK_TIMEOUT_MS) || 25_000);
  const ROLLBACK_IDLE_MS = Math.max(1, Number(process.env.CONFIG_ROLLBACK_IDLE_MINUTES) || 10) * 60_000;

  /** Reject when `promise` takes longer than the connection check allows. */
  function withTimeout(promise, label, ms = CONNECTION_CHECK_TIMEOUT_MS) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error(`${label} did not answer within ${Math.round(ms / 1000)} seconds (connection timed out).`), { status: 504, timedOut: true })),
        ms,
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /** A stored integration key or endpoints that differ from the running connection. */
  function cxonePending(settings = settingsStore.get()) {
    return Boolean(settings.automationApiKey) && cxoneFingerprint(settings.automationApiKey, settings.integrationOverrides ?? {}) !== tstate.integrationFingerprint;
  }

  /** Mail server settings that have not passed a connection test. */
  function smtpPending(settings = settingsStore.get()) {
    return !isVerified(settings) && (Boolean(settings.smtp.host) || Boolean(guard.lastGood('smtp')));
  }

  /**
   * The settings mail is sent with: the current ones, except that while a
   * changed mail server waits to be checked, the last known good one keeps
   * sending — so editing Settings never stops reminders.
   */
  function sendingSettings(settings = settingsStore.get()) {
    const own = presenting();
    if (own) settings = { ...settings, branding: overlayBranding(settings.branding, own) };
    if (!smtpPending(settings)) return settings;
    const good = guard.lastGood('smtp');
    if (!good) return settings;
    const { at, ...smtp } = good;
    return { ...settings, smtp, verifiedAt: at, verifiedFingerprint: smtpFingerprint(smtp) };
  }

  /** What the last known good configuration of a part was (no secrets). */
  function lastGoodView(part) {
    const good = guard.lastGood(part);
    if (!good) return null;
    return { ...(part === 'cxone' ? describeCxone(good) : describeSmtp(good)), at: good.at, ...(part === 'cxone' && !good.apiKey ? { source: 'environment' } : {}) };
  }

  function connectionStatus(settings = settingsStore.get()) {
    return {
      pending: { cxone: cxonePending(settings), smtp: smtpPending(settings) },
      lastGood: { cxone: lastGoodView('cxone'), smtp: lastGoodView('smtp') },
      changedAt: guard.changedAt,
      rollbackAfterMinutes: ROLLBACK_IDLE_MS / 60_000,
    };
  }

  /** Remember why a connection last failed (cleared when it works), for the header's connection chips. */
  function noteConnectionHelp(part, outcome) {
    if (!outcome || outcome.superseded) return;
    tstate.connectionHelp ??= {};
    if (outcome.ok) delete tstate.connectionHelp[part];
    else if (outcome.help) tstate.connectionHelp[part] = outcome.help;
  }

  /** Checks run one at a time: a second caller waits for the first and then checks again. */
  let checkQueue = Promise.resolve();
  function checkConnections(options) {
    const run = checkQueue.then(() => runConnectionCheck(options));
    checkQueue = run.catch(() => {});
    return run;
  }

  /**
   * Try every changed connection setting. One that works becomes the last known
   * good one. One that fails stays saved (so it can be corrected) unless
   * `rollback`: then the last known good configuration is put back, and a notice
   * tells every administrator what happened. A configuration identical to the
   * last known good one is never "rolled back" — that failure is an outage.
   */
  async function runConnectionCheck({ rollback = false, trigger = 'check', actor = null } = {}) {
    const result = { cxone: null, smtp: null, notice: null };
    const parts = [];
    const who = actor?.user || actor?.kind || '';

    let settings = settingsStore.get();
    if (cxonePending(settings)) {
      const key = settings.automationApiKey;
      const overrides = { baseUrl: '', iamUrl: '', tenant: '', ...(settings.integrationOverrides ?? {}) };
      const tried = cxoneFingerprint(key, overrides);
      try {
        const session = await connectCheckmarxOne(key, integrationOverrides(settings));
        if (cxoneFingerprint(settingsStore.get().automationApiKey, settingsStore.get().integrationOverrides ?? {}) !== tried) {
          sessions.destroy(session.id);
          result.cxone = { ok: false, superseded: true };
        } else {
          activateIntegration(session, key, overrides);
          result.cxone = { ok: true, tenant: session.connection.tenant };
          audit.record({ type: 'settings', outcome: 'changed', reason: `Checkmarx One integration checked and in use (tenant ${session.connection.tenant}).`, actor: actor ?? SYSTEM_ACTOR, details: { tenant: session.connection.tenant, baseUrl: session.connection.baseUrl, trigger } });
        }
      } catch (error) {
        result.cxone = { ok: false, error: error.message, timedOut: Boolean(error.timedOut), help: explainCxone(error, { apiKey: key, ...overrides }) };
        const good = guard.lastGood('cxone');
        const current = settingsStore.get();
        const unchanged = cxoneFingerprint(current.automationApiKey, current.integrationOverrides ?? {}) === tried;
        if (rollback && good && unchanged && cxoneFingerprint(good.apiKey, good.overrides) !== tried) {
          settingsStore.save({ automationApiKey: good.apiKey, integrationOverrides: good.overrides });
          if (!good.apiKey) {
            // The last working connection was the environment's CX_API_KEY.
            if (tstate.automationSessionId && tstate.automationSessionId !== tstate.bootstrapSessionId) sessions.destroy(tstate.automationSessionId);
            tstate.automationSessionId = null;
            tstate.integrationFingerprint = null;
          } else if (cxoneFingerprint(good.apiKey, good.overrides) !== tstate.integrationFingerprint || !integrationSession()) {
            tstate.automationSessionId = null;
            await resolveAutomationSession();
          }
          result.cxone.rolledBack = true;
          parts.push({ part: 'cxone', error: error.message, timedOut: Boolean(error.timedOut), help: result.cxone.help, attempted: describeCxone({ overrides }), restored: describeCxone(good), restoredAt: good.at });
        }
      }
    }

    settings = settingsStore.get();
    if (smtpPending(settings)) {
      const good = guard.lastGood('smtp');
      const tried = smtpFingerprint(settings.smtp);
      const attempted = describeSmtp(settings.smtp);
      try {
        const outcome = await withTimeout(testConnection(settings.smtp), 'The mail server');
        if (smtpFingerprint(settingsStore.get().smtp) !== tried) {
          result.smtp = { ok: false, superseded: true };
        } else {
          settingsStore.markVerified();
          guard.recordGood('smtp', settingsStore.get().smtp);
          result.smtp = { ok: true, host: settings.smtp.host, message: outcome?.message ?? '' };
        }
      } catch (error) {
        result.smtp = { ok: false, error: error.message, timedOut: Boolean(error.timedOut) || /timed? ?out|ETIMEDOUT/i.test(error.message), help: error.help ?? explainSmtp(error, settings.smtp) };
        const unchanged = smtpFingerprint(settingsStore.get().smtp) === tried;
        if (rollback && good && unchanged && smtpFingerprint(good) !== tried) {
          settingsStore.restoreSmtp(good);
          result.smtp.rolledBack = true;
          parts.push({ part: 'smtp', error: error.message, timedOut: result.smtp.timedOut, help: result.smtp.help, attempted, restored: describeSmtp(good), restoredAt: good.at });
        }
      }
    }

    // What the header shows while a connection does not work: why, and how to fix it.
    for (const part of ['cxone', 'smtp']) noteConnectionHelp(part, result[part]);
    if (parts.length) {
      result.notice = guard.addNotice({ trigger, actor: who, parts });
      audit.record({
        type: 'settings',
        outcome: 'changed',
        reason: `Rolled back to the last known good ${parts.map((p) => (p.part === 'cxone' ? 'Checkmarx One integration' : 'mail server settings')).join(' and ')}: the new ${parts.length > 1 ? 'ones' : 'one'} did not work (${trigger}).`,
        actor: actor ?? SYSTEM_ACTOR,
        details: { rollback: parts },
      });
      console.warn(`! [settings] ${parts.map((p) => `${p.part} rolled back: ${p.error}`).join('; ')}`);
    }
    if (rollback) guard.settle();
    return { ...result, status: connectionStatus() };
  }

  /** Changes nobody is checking (the browser closed mid-edit) are checked once they have been left alone a while. */
  const idleCheck = setInterval(() => {
    if (!productActive()) return;
    tenancy.each(() => {
      const changedAt = guard.changedAt;
      if (!changedAt || Date.now() - Date.parse(changedAt) < ROLLBACK_IDLE_MS) return;
      if (!cxonePending() && !smtpPending()) return guard.settle();
      checkConnections({ rollback: true, trigger: 'no change for a while' }).catch((error) => console.warn(`! [settings] Connection check failed: ${error.message}`));
    });
  }, Math.min(60_000, ROLLBACK_IDLE_MS));
  idleCheck.unref?.();

  const mayChangeConnections = (req) => can(req, 'integration.cxone') || can(req, 'integration.smtp');

  app.get('/api/settings/connections', requirePermission('settings.view', 'integration.cxone', 'integration.smtp'), (req, res) => {
    res.json(connectionStatus());
  });

  /** Check changed connection settings now; `rollback` puts back the last known good ones that fail (on leaving Settings). */
  app.post(
    '/api/settings/connections/check',
    requirePermission('integration.cxone', 'integration.smtp'),
    asyncRoute(async (req, res) => {
      const rollback = req.body?.rollback === true;
      const trigger = rollback ? 'left the Settings page' : 'check';
      const result = await checkConnections({ rollback, trigger, actor: await adminActor(req) });
      // The person who was there has seen it: they are not shown it again at sign-in.
      if (result.notice && req.body?.present !== false) guard.acknowledge(req.user.id, [result.notice.id]);
      res.json(result);
    }),
  );

  /** Save the integration key and endpoints as typed, without connecting yet (the check decides). */
  app.put(
    '/api/integration/cxone/draft',
    requirePermission('integration.cxone'),
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const current = settingsStore.get();
      const clean = (v) => String(v ?? '').trim().replace(/\/+$/, '');
      const overrides = { ...(current.integrationOverrides ?? { baseUrl: '', iamUrl: '', tenant: '' }) };
      for (const field of ['baseUrl', 'iamUrl', 'tenant']) if (field in body) overrides[field] = clean(body[field]);
      // Saved as typed, but never an address the key must not go to (https, no link-local or metadata address).
      for (const [field, label] of [['baseUrl', 'API URL'], ['iamUrl', 'IAM URL']]) if (field in body && overrides[field]) overrides[field] = checkServiceUrl(overrides[field], label);
      const key = String(body.apiKey ?? '').trim();
      const before = cxoneFingerprint(current.automationApiKey, current.integrationOverrides ?? {});
      // The stored key is never sent to another host: new IAM or API hosts need the key pasted again.
      settingsStore.save({ automationApiKey: keyForEndpoints(current, overrides, key), integrationOverrides: overrides });
      const after = settingsStore.get();
      if (cxoneFingerprint(after.automationApiKey, after.integrationOverrides ?? {}) !== before) guard.touch();
      res.json(integrationStatus());
    }),
  );

  /** Configure from an uploaded .env file: the variables this person may set are saved, then checked. */
  app.post(
    '/api/settings/import-env',
    requirePermission('integration.cxone', 'integration.smtp', 'settings.links', 'beta.use'),
    asyncRoute(async (req, res) => {
      const all = parseEnvText(req.body?.text);
      // Checked before anything is applied: a value that cannot work is not applied, so the working one stays.
      const findings = checkEnvFile(req.body?.text, all, { known: Object.keys(ENV_SETTINGS), isKnown: (name) => Boolean(numberedVariable(name)) });
      const skipped = refusedByCheck(findings);
      const vars = Object.fromEntries(Object.entries(all).filter(([name]) => !skipped.has(name)));
      const { changes, applied, refused, ignored } = settingsFromEnv(vars, (permission) => can(req, permission));
      if (!applied.length) {
        if (refused.length) return res.status(403).json({ error: `Your role cannot set ${refused.join(', ')}.`, applied, refused, ignored, findings });
        if (skipped.size) return res.status(400).json({ error: 'Nothing was applied: the file has mistakes that would break the connections. Each one is listed below with how to fix it.', applied, refused, ignored, findings });
        const blank = Object.keys(vars).some((name) => Object.hasOwn(ENV_SETTINGS, name) || numberedVariable(name));
        return res.status(400).json({
          error: blank
            ? 'Every setting in that file is blank, so nothing changed. Fill in the values you want to set (blank ones keep what is set now) and upload it again.'
            : 'No setting this page understands was found in that file.',
          applied, refused, ignored, findings,
        });
      }
      const addressProblem = ssoAddressProblem(req, changes.links);
      if (addressProblem) return res.status(400).json({ error: addressProblem, applied: [], refused, ignored, findings });
      if (changes.cxone) {
        const current = settingsStore.get();
        const { apiKey, ...endpoints } = changes.cxone;
        // Endpoints the file leaves out are derived from the key, as at start-up.
        const overrides = { baseUrl: '', iamUrl: '', tenant: '', ...(apiKey ? {} : current.integrationOverrides ?? {}), ...endpoints };
        // The stored key is never sent to another host: new IAM or API hosts need the key in the file too.
        settingsStore.save({ automationApiKey: keyForEndpoints(current, overrides, apiKey), integrationOverrides: overrides });
      }
      if (changes.smtp) settingsStore.save({ smtp: changes.smtp });
      if (changes.links) settingsStore.save({ links: changes.links });
      if (changes.github) settingsStore.save({ beta: { github: changes.github } });
      for (const host of ['gitlab', 'azure', 'bitbucket']) if (changes[host]) settingsStore.save({ beta: { [host]: changes[host] } });
      if (changes.instances) settingsStore.save({ beta: { instances: changes.instances } });
      guard.touch();
      const actor = await adminActor(req);
      audit.record({ type: 'settings', outcome: 'changed', reason: `Settings imported from a .env file: ${applied.join(', ')}.`, actor, details: { applied, refused, ignored, notApplied: [...skipped], secrets: applied.filter(isSecretVariable) } });
      const check = await checkConnections({ rollback: false, trigger: 'import', actor });
      res.json({ applied, refused, ignored, findings, check, settings: settingsFor(req, settingsStore.get()), integration: integrationStatus() });
    }),
  );

  /** Rollback notices this person has seen. */
  app.post('/api/settings/notices/ack', requireSession, (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    res.json({ acknowledged: guard.acknowledge(req.user.id, ids) });
  });

  return {
    integrationStatus, withTimeout, cxonePending, smtpPending, sendingSettings, connectionStatus, noteConnectionHelp,
    checkConnections,
  };
}
