/**
 * The server's own Checkmarx One connection (the "integration"): the session that report triage, automation and
 * everyone who signed in with a password work through.
 *
 * It is made from CX_API_KEY at start-up (src/server.js) or from the key an administrator stored: looking it up
 * (integrationSession), signing in with the stored key when it is needed, one attempt at a time
 * (resolveAutomationSession), making a new session the integration (activateIntegration), and telling a change of
 * key or endpoints from the running one. The routes that show and change it are in src/routes/connections.js.
 */
import { config } from '../config.js';
import { createHash } from 'node:crypto';
import { deriveConnection } from '../cxone/endpoints.js';
import { hostOfUrl } from '../settings.js';
import { DEFAULT_TENANT } from '../tenancy.js';

/**
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function createIntegrationSession(d) {
  const { sessions, tstate, settingsStore, guard, scheduler, connectCheckmarxOne, tenantOf = () => DEFAULT_TENANT } = d;

  /**
   * The deployment's Checkmarx One endpoints (CX_BASE_URL, CX_IAM_URL, CX_TENANT): the first tenant's. Another
   * tenant's key goes where the key itself says (its issuer), or where its own Admin typed: with the first
   * tenant's endpoints filled in, a key for another Checkmarx One tenant was sent to the first one, and every
   * tenant added on a server started with them read the first tenant's data.
   */
  function environmentOverrides() {
    return tenantOf() === DEFAULT_TENANT ? config.overrides : {};
  }

  /**
   * The session unattended runs use. Automation has no browser to paste a key,
   * so it needs a credential that outlives a session: either CX_API_KEY, or one
   * the administrator explicitly armed from the Settings page.
   */

  /** Where the stored integration key connects: what the administrator entered, else the deployment's overrides. */
  function integrationOverrides(settings = settingsStore.get()) {
    const stored = settings.integrationOverrides ?? {};
    const deployed = environmentOverrides();
    return {
      baseUrl: stored.baseUrl || deployed.baseUrl,
      iamUrl: stored.iamUrl || deployed.iamUrl,
      tenant: stored.tenant || deployed.tenant,
    };
  }

  /**
   * The server's own Checkmarx One connection (the "integration"): used by
   * report triage, automation, and everyone who signed in with a password.
   */
  function integrationSession() {
    return sessions.get(tstate.automationSessionId) ?? sessions.get(tstate.bootstrapSessionId);
  }

  /**
   * The IAM and API hosts the stored key would be sent to with these endpoints (the key's
   * own issuer where none is set), so a change of host can be told from a change of tenant.
   */
  function cxoneHosts(key, overrides = {}) {
    const deployed = environmentOverrides();
    const effective = {
      baseUrl: overrides.baseUrl || deployed.baseUrl,
      iamUrl: overrides.iamUrl || deployed.iamUrl,
      tenant: overrides.tenant || deployed.tenant,
    };
    let { iamUrl, baseUrl } = effective;
    try {
      ({ iamUrl, baseUrl } = deriveConnection(key, effective));
    } catch {
      /* not a key we can read: compare the addresses as given */
    }
    return `${hostOfUrl(iamUrl)} ${hostOfUrl(baseUrl)}`;
  }

  /** The stored key, unless the endpoints now point at another host and no new key came with them. */
  function keyForEndpoints(current, overrides, newKey) {
    if (newKey) return newKey;
    const key = current.automationApiKey;
    if (!key) return key;
    return cxoneHosts(key, current.integrationOverrides ?? {}) === cxoneHosts(key, overrides) ? key : '';
  }

  /** Which key and endpoints a connection was made from (to tell a changed configuration from the running one). */
  const cxoneFingerprint = (key, overrides = {}) =>
    createHash('sha256').update(JSON.stringify([key ?? '', overrides.baseUrl ?? '', overrides.iamUrl ?? '', overrides.tenant ?? ''])).digest('hex');
  /** The fingerprint of the configuration the running integration session was made from. */

  /**
   * Make `session` the integration: it replaces the previous one, and the key and
   * endpoints it was made from become the last known good Checkmarx One configuration.
   */
  function activateIntegration(session, key, overrides = {}) {
    session.pinned = true;
    const previous = tstate.automationSessionId;
    tstate.automationSessionId = session.id;
    tstate.integrationFingerprint = cxoneFingerprint(key, overrides);
    tstate.integrationFailure = { fingerprint: null, until: 0 };
    if (previous && previous !== session.id && previous !== tstate.bootstrapSessionId) sessions.destroy(previous);
    const { tenant, baseUrl, iamUrl } = session.connection;
    guard.recordGood('cxone', { apiKey: key, overrides: { baseUrl: overrides.baseUrl ?? '', iamUrl: overrides.iamUrl ?? '', tenant: overrides.tenant ?? '' }, connection: { tenant, baseUrl, iamUrl } });
    scheduler.sync();
  }

  /**
   * Signing in with the stored key: one attempt at a time however many requests are waiting
   * for it, and after a failure none for a while (30-60 s), so a wrong key or an unreachable
   * IAM is not asked again on every request. A changed key or endpoints are tried at once.
   */

  async function resolveAutomationSession() {
    const existing = integrationSession();
    if (existing) return existing;

    const settings = settingsStore.get();
    const storedKey = settings.automationApiKey;
    if (!storedKey) return null;

    const fingerprint = cxoneFingerprint(storedKey, settings.integrationOverrides ?? {});
    if (tstate.integrationFailure.fingerprint === fingerprint && Date.now() < tstate.integrationFailure.until) return null;
    if (tstate.integrationAttempt?.fingerprint === fingerprint) return tstate.integrationAttempt.promise;

    const promise = (async () => {
      try {
        const session = await connectCheckmarxOne(storedKey, integrationOverrides(settings));
        activateIntegration(session, storedKey, settings.integrationOverrides ?? {});
        tstate.integrationFailure = { fingerprint: null, until: 0 };
        return session;
      } catch (error) {
        console.warn(`! Stored automation key could not be used: ${error.message}`);
        tstate.integrationFailure = { fingerprint, until: Date.now() + 30_000 + Math.floor(Math.random() * 30_000), error };
        return null;
      } finally {
        if (tstate.integrationAttempt?.promise === promise) tstate.integrationAttempt = null;
      }
    })();
    tstate.integrationAttempt = { fingerprint, promise };
    return promise;
  }

  return {
    integrationOverrides, integrationSession, keyForEndpoints, cxoneFingerprint, activateIntegration,
    resolveAutomationSession, environmentOverrides,
  };
}
