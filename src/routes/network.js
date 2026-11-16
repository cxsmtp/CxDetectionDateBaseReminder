/**
 * Settings → Network (src/network.js): the outgoing proxy this server uses, what it must be able to reach (Checkmarx
 * One, the mail server, the git hosts, the identity provider, Let's Encrypt, the update registry), and a check of
 * each from here. The routes under /api/network; a change takes effect when the server restarts.
 */
import { config } from '../config.js';
import { SCM_LABELS, scmConfigs } from '../scm/providers.js';
import { activeProxy, checkRoute, cleanProxy, proxyWithAuth, readNetwork, requirements, requirementsText, saveNetwork } from '../network.js';
import { hostOfUrl } from '../settings.js';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerNetworkRoutes(app, d) {
  const {
    dataDir, backupMailbox, settingsStore, audit, iam, integrationOverrides, acme, LETSENCRYPT_DOMAIN, asyncRoute,
    requirePermission, adminActor, githubConfig, cxHosts, SERVER_NAME, refuseOtherTenants, TRUST_EDIT, updates,
  } = d;

  // ---------------------------------------------------------------------------
  // Network & proxy (src/network.js): how this server reaches the internet, a check that
  // says where a connection stops, and the sheet a network team needs. Server-wide.
  // ---------------------------------------------------------------------------

  /** Set when the proxy was saved or removed: it is used from the next start, which follows at once when supervised. */
  let networkChangedAt = '';

  /** The Checkmarx One hosts this server uses: the stored key's, the environment's, else the one typed. */
  function networkTargets(typed = '') {
    const settings = settingsStore.get();
    const known = [
      ...(settings.automationApiKey ? cxHosts(settings.automationApiKey, integrationOverrides(settings)) : []),
      ...(config.bootstrapApiKey ? cxHosts(config.bootstrapApiKey, config.overrides) : []),
    ];
    const text = String(typed ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
    if (text) {
      const [host, port] = text.split(':');
      if (!SERVER_NAME.test(host)) throw Object.assign(new Error('Give a Checkmarx One address, for example ind.iam.checkmarx.net.'), { status: 400 });
      return [{ host, port: Number(port) || 443 }];
    }
    const seen = new Set();
    return known.filter((t) => !seen.has(t.host) && seen.add(t.host));
  }

  /** Git hosts with a token: the ones code authors are read from. */
  function gitHosts(settings) {
    const out = [];
    const github = githubConfig(settings);
    if (github.token) out.push({ label: 'GitHub', host: hostOfUrl(github.apiUrl) });
    for (const [id, cfg] of Object.entries(scmConfigs(settings))) {
      const url = [cfg?.apiUrl, cfg?.orgUrl].find((u) => /^https?:\/\//.test(u ?? ''));
      if (cfg?.token && url) out.push({ label: SCM_LABELS[id] ?? id, host: hostOfUrl(url) });
    }
    return out;
  }

  /** The identity provider's host and port, while single sign-on is on: one more connection for the network team's sheet. */
  function ssoHost() {
    const sso = iam.sso();
    if (!sso.enabled) return null;
    try {
      const url = new URL(sso.issuer);
      return { host: url.hostname, port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) };
    } catch {
      return null;
    }
  }

  function networkView() {
    const settings = settingsStore.get();
    const proxy = activeProxy(dataDir);
    let letsEncrypt = Boolean(LETSENCRYPT_DOMAIN);
    try {
      letsEncrypt ||= Boolean(acme.status()?.issued);
    } catch {}
    const rows = requirements({
      checkmarxOne: networkTargets(),
      smtp: settings.smtp?.host ? { host: settings.smtp.host, port: settings.smtp.port } : null,
      backupMail: backupMailbox.email && backupMailbox.host ? { host: backupMailbox.host, port: backupMailbox.port } : null,
      git: gitHosts(settings),
      sso: ssoHost(),
      letsEncrypt,
      updates: updates.supervised,
      inboundPort: Number(process.env.HTTPS_PUBLIC_PORT || process.env.PORT) || 3000,
      proxy,
    });
    const saved = readNetwork(dataDir);
    return {
      proxy: proxy ? { ...proxy, hasPassword: Boolean(saved?.proxy?.password) } : null,
      changedAt: networkChangedAt,
      supervised: updates.supervised,
      targets: networkTargets(),
      requirements: rows,
      text: requirementsText(rows, { proxy }),
    };
  }

  /** The proxy typed in the form, with the saved password when the same user leaves it blank. */
  function typedProxy(body) {
    if (!String(body?.url ?? '').trim()) return null;
    const typed = cleanProxy(body);
    const saved = readNetwork(dataDir)?.proxy;
    if (typed.username && !typed.password && saved?.username === typed.username && saved.url === typed.url) typed.password = saved.password;
    return typed;
  }

  app.get('/api/network', requirePermission('settings.view', ...TRUST_EDIT), (req, res) => res.set('Cache-Control', 'no-store').json(networkView()));

  /** Check the way to Checkmarx One with the proxy typed (or directly), step by step, before anything is saved. */
  app.post(
    '/api/network/check',
    requirePermission(...TRUST_EDIT),
    asyncRoute(async (req, res) => {
      const proxy = typedProxy(req.body);
      const targets = networkTargets(req.body?.target);
      if (!targets.length) return res.status(400).json({ error: 'Give the Checkmarx One address to check, for example ind.iam.checkmarx.net (the IAM address of your region).' });
      const results = [];
      for (const t of targets) results.push(await checkRoute({ proxy: proxy ? proxyWithAuth(proxy) : '', host: t.host, port: t.port }));
      res.json({ ok: results.every((r) => r.ok), via: proxy ? proxy.url : 'direct', results });
    }),
  );

  /** Save the proxy (after the same check) and restart the server to use it. */
  app.put(
    '/api/network',
    requirePermission(...TRUST_EDIT),
    asyncRoute(async (req, res) => {
      if (refuseOtherTenants(req, res)) return;
      const proxy = typedProxy(req.body);
      if (!proxy) return res.status(400).json({ error: 'Give the proxy as host:port, for example proxy.acme.local:8080.' });
      const targets = networkTargets(req.body?.target);
      const results = [];
      for (const t of targets) results.push(await checkRoute({ proxy: proxyWithAuth(proxy), host: t.host, port: t.port }));
      // A proxy that cannot be reached, or refuses Checkmarx One, is not saved: it would only stop what works.
      const blocked = results.find((r) => r.steps.some((s) => !s.ok && (s.step === 'proxy' || s.step === 'tunnel')));
      if (blocked) return res.status(422).json({ error: 'Not saved: Checkmarx One could not be reached through this proxy.', results });
      const actor = await adminActor(req);
      saveNetwork(dataDir, { proxy, changedAt: new Date().toISOString(), changedBy: actor.user });
      networkChangedAt = new Date().toISOString();
      audit.record({ type: 'settings', outcome: 'changed', reason: `Outgoing connections now go through the proxy ${proxy.url}${proxy.username ? ` (signing in as ${proxy.username})` : ''}.`, actor, details: { url: proxy.url, username: proxy.username, noProxy: proxy.noProxy } });
      if (updates.supervised) setTimeout(() => updates.switchTo({ type: 'restart', by: actor.user }), 600).unref?.();
      res.json({ ...networkView(), results, restarting: updates.supervised });
    }),
  );

  app.delete(
    '/api/network',
    requirePermission(...TRUST_EDIT),
    asyncRoute(async (req, res) => {
      if (refuseOtherTenants(req, res)) return;
      if (!readNetwork(dataDir)) return res.status(404).json({ error: 'No proxy is set here.' });
      const actor = await adminActor(req);
      saveNetwork(dataDir, null);
      networkChangedAt = new Date().toISOString();
      audit.record({ type: 'settings', outcome: 'changed', reason: 'Outgoing connections no longer go through the proxy set in Settings.', actor });
      if (updates.supervised) setTimeout(() => updates.switchTo({ type: 'restart', by: actor.user }), 600).unref?.();
      res.json({ ...networkView(), restarting: updates.supervised });
    }),
  );
}
