/**
 * The address of this server as others reach it: what is put into every emailed report so that its reader can
 * connect, what a link in an email starts with, and what a request says it was sent to.
 *
 * Many areas need it (reports, reminders, sign-in links, hands-off emails, the HTTPS page), so it is made once in
 * src/server.js, before their routes, and handed to each.
 */
import { config } from '../config.js';
import { viaTrustedProxy } from '../security.js';

/**
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function createReportServerAddress(d) {
  const { tstate, settingsStore, httpsManager, can } = d;

  /** Where emailed reports reach this server: the configured address, else the one the dashboard is using. */
  /**
   * The reminder server address put into every report, so anyone opening it can
   * connect: the Settings page, else REPORT_SERVER_URL / PUBLIC_URL, else the
   * address the dashboard is open on. Reports sent with nobody at the dashboard
   * (automatic reminders) use the last address an administrator reached it on.
   */
  const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)$/i;

  function requestOrigin(req) {
    // Only a plain host[:port] (requestHost's rule): never a path, user name or other site smuggled into a header.
    const forwardedHost = viaTrustedProxy(req) ? String(req.get('x-forwarded-host') ?? '').split(',')[0].trim() : '';
    const host = /^([\w.-]+|\[[0-9a-f:.]+\])(:\d{1,5})?$/i.test(forwardedHost) ? forwardedHost : requestHost(req);
    return host ? `${req.protocol}://${host}` : '';
  }

  /**
   * Remember the address the dashboard is open on, for reports sent with nobody there.
   * Only from someone signed in who may set the links (an Admin, as a rule), and only the
   * plain Host they used, never X-Forwarded-Host: a report reader, or anyone able to send a
   * request, cannot point every automatic report at an address of their choosing.
   */
  function noteDashboardOrigin(req) {
    if (!req.user || !can(req, 'settings.links')) return;
    const host = requestHost(req);
    if (!host) return;
    try {
      const origin = `${req.protocol}://${host}`;
      if (!LOOPBACK.test(new URL(origin).hostname)) tstate.lastDashboardOrigin = origin;
    } catch {}
  }

  function resolveReportServer(req = null, settings = settingsStore.get()) {
    if (req) noteDashboardOrigin(req);
    if (settings.links.reportServerUrl) return { url: settings.links.reportServerUrl, source: 'settings' };
    if (config.reportServerUrl) return { url: config.reportServerUrl, source: 'environment' };
    if (req) return { url: requestOrigin(req), source: 'this page' };
    if (tstate.lastDashboardOrigin) return { url: tstate.lastDashboardOrigin, source: 'last dashboard address' };
    return { url: '', source: 'none' };
  }

  function reportServerUrl(req, settings) {
    return resolveReportServer(req, settings).url;
  }

  /** Why readers might not be able to use an address. */
  function reportServerWarnings(url) {
    if (!url) return ['No address: reports go out without one, and readers must type it in before they can triage.'];
    const warnings = [];
    try {
      const parsed = new URL(url);
      if (LOOPBACK.test(parsed.hostname)) warnings.push(`${parsed.hostname} only works on the computer running this server. Set the address others use to reach it.`);
      if (parsed.protocol === 'http:' && !LOOPBACK.test(parsed.hostname)) warnings.push('Plain http: triage requests cross the network unencrypted. Turn on HTTPS under Settings → HTTPS.');
      if (parsed.protocol === 'https:' && httpsManager.mode !== 'http' && httpsManager.selfSigned && !LOOPBACK.test(parsed.hostname)) warnings.push('This server uses a self-signed certificate: reports reach it only from machines that trust it. Upload your company certificate under Settings → HTTPS.');
    } catch {
      warnings.push('Not a valid address.');
    }
    return warnings;
  }

  /** The host[:port] this request was sent to, when it is a plain name or address (else ''). */
  function requestHost(req) {
    const header = String(req.headers.host ?? '');
    return /^([\w.-]+|\[[0-9a-f:.]+\])(:\d{1,5})?$/i.test(header) ? header : '';
  }

  return { LOOPBACK, requestOrigin, resolveReportServer, reportServerUrl, reportServerWarnings, requestHost };
}
