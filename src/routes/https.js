/**
 * Settings → HTTPS (Admin only): the certificate this server serves with, and how (src/https-manager.js).
 *
 * The routes under /api/https: the state, a certificate to inspect, upload, put back or remove, a self-signed
 * one, a certificate request, the mode (http, both, https only), hardening, and the browser's own check; and
 * under /api/https/acme a free certificate from Let's Encrypt, got and renewed by this server (src/acme.js).
 * The HTTPS manager and the ACME service themselves are made in src/server.js, before the first middleware.
 */
import { config } from '../config.js';
import { viaTrustedProxy } from '../security.js';
import { HSTS_AGES } from '../https-manager.js';
import { validName } from '../acme.js';
import { logSafe } from './shared.js';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerHttpsRoutes(app, d) {
  const {
    settingsStore, audit, httpsManager, acme, LETSENCRYPT_DOMAIN, asyncRoute, requirePermission, resolveReportServer,
    requestHost, adminActor,
  } = d;

  // ---------------------------------------------------------------------------
  // HTTPS (Settings → HTTPS, Admin only): see src/https-manager.js
  // ---------------------------------------------------------------------------

  /** Reports opened over http and over https, by hour, for the last day: shows when http can go. */
  const reportOpens = {
    hours: new Map(),
    record(secure) {
      const hour = Math.floor(Date.now() / 3_600_000);
      const bucket = this.hours.get(hour) ?? { http: 0, https: 0 };
      bucket[secure ? 'https' : 'http'] += 1;
      this.hours.set(hour, bucket);
      for (const key of this.hours.keys()) if (key < hour - 24) this.hours.delete(key);
    },
    lastDay() {
      const since = Math.floor(Date.now() / 3_600_000) - 23;
      const total = { http: 0, https: 0 };
      for (const [hour, bucket] of this.hours) {
        if (hour < since) continue;
        total.http += bucket.http;
        total.https += bucket.https;
      }
      return total;
    },
  };

  /** The names people use to reach this server: this page's, the CxMissionZero server address's, and any given. */
  function httpsHosts(req, extra = []) {
    const hosts = new Set();
    const add = (value) => {
      const host = String(value ?? '').trim().toLowerCase().replace(/^\[(.*)\](:\d+)?$/, '$1').replace(/^([^:]+):\d+$/, '$1');
      if (host && host.length < 254 && /^[a-z0-9.:*-]+$/.test(host)) hosts.add(host);
    };
    add(requestHost(req));
    try {
      add(new URL(resolveReportServer(null, settingsStore.get()).url).hostname);
    } catch {}
    for (const host of Array.isArray(extra) ? extra.slice(0, 10) : []) add(host);
    return [...hosts];
  }

  /** Errors from the HTTPS settings carry what the page needs to ask next (confirm, a password, open https). */
  const httpsRoute = (handler) => asyncRoute(async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (!error.status) throw error;
      const { status, report, needsConfirm, needsHttps, needsPassphrase } = error;
      res.status(status).json({ error: error.message, ...(report ? { report } : {}), ...(needsConfirm ? { needsConfirm } : {}), ...(needsHttps ? { needsHttps } : {}), ...(needsPassphrase ? { needsPassphrase } : {}) });
    }
  });

  function auditHttps(req, actor, reason, details) {
    audit.record({ type: 'settings', outcome: 'changed', reason, actor, ...(details ? { details: { https: details } } : {}) });
  }

  async function httpsStatus(req) {
    const host = requestHost(req) || `localhost:${config.port}`;
    return {
      ...(await httpsManager.status(httpsHosts(req))),
      viewing: { secure: Boolean(req.secure), host, httpUrl: `http://${host}`, httpsUrl: `https://${host}` },
      reminderServer: resolveReportServer(req),
      reportOpens: reportOpens.lastDay(),
      hstsAges: HSTS_AGES,
      behindProxy: Boolean(req.get('x-forwarded-proto')) && viaTrustedProxy(req),
      acme: acmeView(req),
    };
  }

  app.get('/api/https', requirePermission('security.https'), httpsRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await httpsStatus(req));
  }));

  app.post('/api/https/inspect', requirePermission('security.https'), httpsRoute(async (req, res) => {
    const { files, passphrase, hosts } = req.body ?? {};
    res.json(await httpsManager.inspect({ files, passphrase: String(passphrase ?? ''), hosts: httpsHosts(req, hosts) }));
  }));

  app.post('/api/https/certificate', requirePermission('security.https'), httpsRoute(async (req, res) => {
    const { files, passphrase, hosts, confirm } = req.body ?? {};
    const actor = await adminActor(req);
    const report = await httpsManager.install({ files, passphrase: String(passphrase ?? ''), hosts: httpsHosts(req, hosts), confirm: Boolean(confirm), by: actor.user });
    auditHttps(req, actor, `HTTPS certificate for ${report.summary.subject} put to use (valid until ${report.summary.validTo.slice(0, 10)}).`, { subject: report.summary.subject, names: report.summary.names, issuer: report.summary.issuer, validTo: report.summary.validTo, fingerprint: report.summary.fingerprint });
    console.log(`[https] Certificate for ${logSafe(report.summary.subject)} put to use by ${logSafe(actor.user)}.`);
    res.json({ report, status: await httpsStatus(req) });
  }));

  app.post('/api/https/certificate/previous', requirePermission('security.https'), httpsRoute(async (req, res) => {
    const actor = await adminActor(req);
    httpsManager.restorePrevious({ by: actor.user });
    auditHttps(req, actor, 'Previous HTTPS certificate put back.');
    res.json(await httpsStatus(req));
  }));

  app.delete('/api/https/certificate', requirePermission('security.https'), httpsRoute(async (req, res) => {
    const actor = await adminActor(req);
    const fallback = httpsManager.removeUploaded({ confirm: req.query.confirm === '1', by: actor.user });
    auditHttps(req, actor, `Uploaded HTTPS certificate no longer used (now ${fallback === 'environment' ? "the container's certificate" : 'a self-signed one'}).`);
    res.json(await httpsStatus(req));
  }));

  app.post('/api/https/self-signed', requirePermission('security.https'), httpsRoute(async (req, res) => {
    const actor = await adminActor(req);
    const names = httpsHosts(req, req.body?.names);
    httpsManager.selfSign({ names, by: actor.user });
    auditHttps(req, actor, `Self-signed certificate made for ${names.join(', ')}.`);
    res.json(await httpsStatus(req));
  }));

  app.post('/api/https/request', requirePermission('security.https'), httpsRoute(async (req, res) => {
    const actor = await adminActor(req);
    const names = Array.isArray(req.body?.names) ? req.body.names.slice(0, 20) : [];
    const csr = httpsManager.createRequest({ names, organization: req.body?.organization ?? '', by: actor.user });
    auditHttps(req, actor, `Certificate request created for ${names.join(', ')}.`);
    res.json({ csr, status: await httpsStatus(req) });
  }));

  app.get('/api/https/request.csr', requirePermission('security.https'), (req, res) => {
    const csr = httpsManager.requestCsr();
    if (!csr) return res.status(404).json({ error: 'No certificate request was made here.' });
    res.set('Content-Type', 'application/pkcs10');
    res.set('Content-Disposition', 'attachment; filename="cxmissionzero.csr"');
    res.send(csr);
  });

  app.post('/api/https/mode', requirePermission('security.https'), httpsRoute(async (req, res) => {
    const actor = await adminActor(req);
    const mode = String(req.body?.mode ?? '');
    const from = httpsManager.mode;
    httpsManager.setMode(mode, { secure: Boolean(req.secure), confirm: Boolean(req.body?.confirm), by: actor.user });
    // Emailed reports carry the CxMissionZero server address: the https one from now on.
    let addressChanged = '';
    if (mode === 'https' && req.body?.updateAddress) {
      const current = settingsStore.get().links.reportServerUrl;
      const host = requestHost(req);
      if (host && !/^https:/i.test(current || '')) {
        addressChanged = `https://${host}`;
        settingsStore.save({ links: { reportServerUrl: addressChanged } });
      }
    }
    const names = { http: 'HTTP only', both: 'HTTP and HTTPS side by side', https: 'HTTPS only (http redirects to https)' };
    auditHttps(req, actor, `Server switched from ${names[from]} to ${names[mode]}.${addressChanged ? ` CxMissionZero server address set to ${addressChanged}.` : ''}`, { from, to: mode });
    console.log(`[https] ${names[mode]}, switched by ${logSafe(actor.user)}.`);
    res.json({ ...(await httpsStatus(req)), addressChanged });
  }));

  app.post('/api/https/hardening', requirePermission('security.https'), httpsRoute(async (req, res) => {
    const actor = await adminActor(req);
    const { hsts, minVersion } = req.body ?? {};
    httpsManager.setHardening({ ...(hsts ? { hsts } : {}), ...(minVersion ? { minVersion } : {}) }, { by: actor.user });
    const status = await httpsStatus(req);
    auditHttps(req, actor, `HTTPS hardening: HSTS ${status.hsts.enabled ? `on (${status.hsts.maxAge} s${status.hsts.includeSubDomains ? ', subdomains' : ''})` : 'off'}, lowest TLS version ${status.minVersion}.`, { hsts: status.hsts, minVersion: status.minVersion });
    res.json(status);
  }));

  app.post('/api/https/browser-check', requirePermission('security.https'), httpsRoute(async (req, res) => {
    const actor = await adminActor(req);
    httpsManager.recordBrowserCheck({ ok: req.body?.ok, url: req.body?.url, by: actor.user });
    res.json({ ok: true });
  }));

  // ---- Free certificate from Let's Encrypt (src/acme.js) ----

  /** The Let's Encrypt part of Settings → HTTPS: its state, and the names this page is reached by. */
  function acmeView(req) {
    return { ...acme.status(), suggested: httpsHosts(req).filter(validName), fromEnvironment: LETSENCRYPT_DOMAIN };
  }

  acme.onEvent((event) => {
    const names = event.names.join(', ');
    const staging = event.staging ? ' (staging: not trusted by browsers)' : '';
    if (event.kind === 'issued') {
      audit.record({ type: 'settings', outcome: 'changed', reason: `Let's Encrypt certificate for ${names} put to use${staging}, valid until ${event.validTo.slice(0, 10)}.`, actor: { kind: 'system', user: event.by || "Let's Encrypt" }, details: { https: { letsEncrypt: { names: event.names, staging: event.staging, validTo: event.validTo } } } });
      try {
        // A trusted certificate is in: deployed with LETSENCRYPT_DOMAIN, the server goes HTTPS only by itself;
        // from the Settings page, http and https side by side (switch to HTTPS only there).
        if (event.by === 'LETSENCRYPT_DOMAIN' && !event.staging) httpsManager.setMode('https', { system: true, by: "Let's Encrypt" });
        else if (httpsManager.mode === 'http') httpsManager.setMode('both', { by: "Let's Encrypt" });
      } catch (error) {
        console.warn(`! [https] ${error.message}`);
      }
    } else {
      audit.record({ type: 'settings', outcome: 'failed', reason: `Let's Encrypt certificate for ${names} not obtained${staging}: ${event.error}`, actor: { kind: 'system', user: event.by || "Let's Encrypt" }, details: { https: { letsEncrypt: { names: event.names, staging: event.staging, error: event.error } } } });
    }
  });

  app.get('/api/https/acme', requirePermission('security.https'), (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(acmeView(req));
  });

  app.post('/api/https/acme', requirePermission('security.https'), httpsRoute(async (req, res) => {
    const { names, email, staging, agree, skipPrecheck } = req.body ?? {};
    const actor = await adminActor(req);
    acme.start({ names, email, staging: staging === true, agree: agree === true, skipPrecheck: skipPrecheck === true, by: actor.user });
    auditHttps(req, actor, `Free certificate requested from Let's Encrypt${staging === true ? ' (staging)' : ''} for ${acme.status().last?.names?.join(', ')}.`);
    res.status(202).json(acmeView(req));
  }));

  app.post('/api/https/acme/renew', requirePermission('security.https'), httpsRoute(async (req, res) => {
    const actor = await adminActor(req);
    acme.renew({ by: actor.user });
    auditHttps(req, actor, 'Let\'s Encrypt certificate renewal started by hand.');
    res.status(202).json(acmeView(req));
  }));

  app.delete('/api/https/acme', requirePermission('security.https'), httpsRoute(async (req, res) => {
    const actor = await adminActor(req);
    acme.disable();
    auditHttps(req, actor, 'Automatic renewal of the Let\'s Encrypt certificate turned off (the certificate in use stays until it expires or is replaced).');
    res.json(acmeView(req));
  }));

  return { reportOpens };
}
