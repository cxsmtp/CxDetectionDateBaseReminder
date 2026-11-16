/**
 * Certificates this server trusts for outgoing HTTPS (src/trust.js), and connecting to Checkmarx One.
 *
 * connectCheckmarxOne makes a session from an API key; when the connection fails because a certificate is not
 * trusted (a company proxy that inspects TLS, a private certificate authority), the error says so and carries
 * what was presented, so an Admin can look at it and trust it. The routes under /api/trust: the certificates
 * trusted, trusting one that was presented or uploaded, and removing one.
 */
import { deriveConnection } from '../cxone/endpoints.js';
import { isUntrustedCode } from '../trust.js';
import { SYSTEM_ACTOR } from './shared.js';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerTrustRoutes(app, d) {
  const { trust, sessions, audit, asyncRoute, requirePermission, adminActor, mayChangeRoles, withTimeout } = d;

  // ---------------------------------------------------------------------------
  // Certificates outgoing HTTPS trusts (src/trust.js): a server that left out its
  // intermediate is completed on its own; a company proxy's root is shown to an
  // Admin to trust, or uploaded. Applied at once, no restart.
  // ---------------------------------------------------------------------------

  /** The "not trusted" TLS code somewhere in an error's causes (fetch wraps it twice). */
  function untrustedCode(error) {
    for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth++) if (isUntrustedCode(e.code)) return e.code;
    return '';
  }

  /** The Checkmarx One hosts a key connects to: IAM, then the API. */
  function cxHosts(apiKey, endpoints = {}) {
    try {
      const c = deriveConnection(apiKey, endpoints);
      return [...new Set([c.iamUrl, c.baseUrl].filter(Boolean))].map((u) => {
        const url = new URL(u);
        return { host: url.hostname, port: Number(url.port) || 443 };
      });
    } catch {
      return [];
    }
  }

  /**
   * Why `hosts` are not trusted, when `error` says so: a server that left out its intermediate is
   * completed ("repaired"); otherwise what an Admin is shown ("needs-consent" with the root found,
   * "needs-upload" with the issuer's name). null when the error was something else.
   */
  async function certificateTrouble(error, hosts) {
    if (!untrustedCode(error)) return null;
    let repaired = null;
    for (const { host, port } of hosts) {
      let found;
      try {
        found = await trust.diagnose(host, port);
      } catch (cause) {
        return { status: 'unknown', host, port, error: cause.message };
      }
      if (found.status === 'repaired') {
        repaired = found;
        audit.record({ type: 'settings', outcome: 'changed', reason: `${host} left out its intermediate certificate: fetched ${found.added.map((a) => `"${a.subject}"`).join(', ')} from its issuer, which a trusted root vouches for.`, actor: SYSTEM_ACTOR, details: { host, port, added: found.added } });
      } else if (found.status !== 'trusted') {
        return found;
      }
    }
    return repaired;
  }

  /** Connect to Checkmarx One with a key; a certificate chain that could be completed is, and tried once more. */
  async function connectCheckmarxOne(apiKey, endpoints) {
    try {
      return await withTimeout(sessions.create(apiKey, endpoints), 'Checkmarx One');
    } catch (error) {
      const found = await certificateTrouble(error, cxHosts(apiKey, endpoints));
      if (found?.status === 'repaired') return withTimeout(sessions.create(apiKey, endpoints), 'Checkmarx One');
      if (found) error.certificate = found;
      throw error;
    }
  }

  const SERVER_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
  function trustTarget(body) {
    const host = String(body?.host ?? '').trim().toLowerCase();
    const port = Number(body?.port ?? 443);
    if (!SERVER_NAME.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('Give a server name and port, for example eu.iam.checkmarx.net and 443.'), { status: 400 });
    return { host, port };
  }
  /** Trusted certificates are the whole server's: changed from the first tenant only. */
  function refuseOtherTenants(req, res) {
    if (mayChangeRoles(req)) return false;
    res.status(403).json({ error: 'Trusted certificates apply to the whole server, so only people who work in the first tenant change them.' });
    return true;
  }
  const TRUST_EDIT = ['integration.cxone', 'integration.smtp'];

  app.get('/api/trust', requirePermission('settings.view', ...TRUST_EDIT), (req, res) => res.set('Cache-Control', 'no-store').json({ certificates: trust.list() }));

  /** Trust the root a server presents, by the fingerprint the Admin was shown (looked up again here). */
  app.post(
    '/api/trust/presented',
    requirePermission(...TRUST_EDIT),
    asyncRoute(async (req, res) => {
      if (refuseOtherTenants(req, res)) return;
      const { host, port } = trustTarget(req.body);
      const actor = await adminActor(req);
      const done = await trust.trustPresented(host, port, String(req.body?.fingerprint256 ?? ''), { by: actor.user });
      if (done.added.length) audit.record({ type: 'settings', outcome: 'changed', reason: `Trusted the certificate ${host} presents: ${done.added.map((a) => `"${a.subject}"`).join(', ')}.`, actor, details: { host, port, added: done.added } });
      res.json({ ...done, certificates: trust.list() });
    }),
  );

  /** Upload certificate authorities; with the server that failed, only those its chain needs are kept. */
  app.post(
    '/api/trust/upload',
    requirePermission(...TRUST_EDIT),
    asyncRoute(async (req, res) => {
      if (refuseOtherTenants(req, res)) return;
      const data = String(req.body?.data ?? '');
      if (!data.trim()) return res.status(400).json({ error: 'Choose a certificate file (.pem, .crt or .cer).' });
      if (data.length > 3_000_000) return res.status(413).json({ error: 'That file is too large for certificates (3 MB at most).' });
      const target = req.body?.host ? trustTarget(req.body) : null;
      const chain = target ? await trust.presented(target.host, target.port).catch(() => null) : null;
      const actor = await adminActor(req);
      const added = trust.upload(data, { by: actor.user, chain, host: target?.host ?? '' });
      if (added.length) audit.record({ type: 'settings', outcome: 'changed', reason: `Trusted uploaded certificate${added.length === 1 ? '' : 's'}: ${added.map((a) => `"${a.subject}"`).join(', ')}.`, actor, details: { host: target?.host ?? '', added } });
      const now = target ? await trust.diagnose(target.host, target.port, { repair: false }).catch(() => null) : null;
      res.json({ added, trusted: now ? now.status === 'trusted' : null, certificates: trust.list() });
    }),
  );

  app.delete(
    '/api/trust/:fingerprint',
    requirePermission(...TRUST_EDIT),
    asyncRoute(async (req, res) => {
      if (refuseOtherTenants(req, res)) return;
      const removed = trust.remove(String(req.params.fingerprint));
      if (!removed) return res.status(404).json({ error: 'That certificate is not in the list.' });
      audit.record({ type: 'settings', outcome: 'changed', reason: `No longer trusts the certificate "${removed.subject}".`, actor: await adminActor(req), details: { removed } });
      res.json({ certificates: trust.list() });
    }),
  );

  return { cxHosts, connectCheckmarxOne, SERVER_NAME, refuseOtherTenants, TRUST_EDIT };
}
