// How this server reaches the internet: directly, or through a company proxy, and what a
// network team needs to allow. The proxy is set under Settings → Network (saved in the data
// folder) or with the usual HTTPS_PROXY / NO_PROXY environment variables. Node's own proxy
// support (NODE_USE_ENV_PROXY) carries fetch and http(s) through it, so the launcher sets it
// when it starts the server; a change restarts the server, as an update does.
//
// The check opens the same tunnel by hand, step by step, so it can say where it stopped:
// the proxy, the tunnel to the host, the certificate, or the host's answer.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';

export const NETWORK_FILE = 'network.json';
const ALWAYS_DIRECT = ['localhost', '127.0.0.1', '::1'];

/** The saved proxy (password included: server side only), or null. */
export function readNetwork(dataDir) {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, NETWORK_FILE), 'utf8'));
    return saved?.proxy?.url ? saved : null;
  } catch {
    return null;
  }
}

export function saveNetwork(dataDir, value) {
  const file = path.join(dataDir, NETWORK_FILE);
  if (!value) return fs.rmSync(file, { force: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** A proxy address as typed: http(s)://host:port, no path. Throws with a reason. */
export function cleanProxy({ url = '', username = '', password = '', noProxy = '' } = {}) {
  const text = String(url).trim();
  let parsed;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    throw Object.assign(new Error('Give the proxy as host:port, for example proxy.acme.local:8080.'), { status: 400 });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw Object.assign(new Error('The proxy must be an http:// or https:// address (a SOCKS proxy is not supported).'), { status: 400 });
  if (parsed.username || parsed.password) throw Object.assign(new Error('Give the proxy\'s user name and password in their own fields, not in the address.'), { status: 400 });
  if (!parsed.hostname || (parsed.pathname && parsed.pathname !== '/')) throw Object.assign(new Error('Give the proxy as host:port, without a path.'), { status: 400 });
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  const hosts = String(noProxy)
    .split(/[\s,;]+/)
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (hosts.some((h) => !/^[a-z0-9.*:[\]-]+$/.test(h))) throw Object.assign(new Error('Hosts that skip the proxy: names or addresses separated by commas, for example .acme.local, 10.0.0.5.'), { status: 400 });
  return {
    url: `${parsed.protocol}//${parsed.hostname}:${port}`,
    username: String(username).trim(),
    password: String(password),
    noProxy: [...new Set(hosts)].join(','),
  };
}

/** The proxy address with its sign-in, as the proxy variables carry it. */
export function proxyWithAuth({ url, username, password }) {
  if (!username) return url;
  const u = new URL(url);
  u.username = encodeURIComponent(username);
  u.password = encodeURIComponent(password ?? '');
  return u.href.replace(/\/$/, '');
}

const fromEnv = (env, name) => env[name] || env[name.toLowerCase()] || '';

/**
 * What the launcher adds to the server's environment: the saved proxy (it wins), or the
 * container's own HTTPS_PROXY made to work for fetch too. Nothing when neither is set.
 */
export function proxyEnvironment(dataDir, env = process.env) {
  const saved = readNetwork(dataDir)?.proxy;
  const proxy = saved ? proxyWithAuth(saved) : fromEnv(env, 'HTTPS_PROXY') || fromEnv(env, 'HTTP_PROXY');
  if (!proxy) return {};
  const noProxy = [...new Set([...ALWAYS_DIRECT, ...(saved ? saved.noProxy : fromEnv(env, 'NO_PROXY')).split(',').map((h) => h.trim()).filter(Boolean)])].join(',');
  return { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: noProxy, no_proxy: noProxy };
}

/** The proxy this server uses now (no password), and where it came from. */
export function activeProxy(dataDir, env = process.env) {
  const saved = readNetwork(dataDir)?.proxy;
  if (saved) return { url: saved.url, username: saved.username, noProxy: saved.noProxy, source: 'settings', running: Boolean(fromEnv(env, 'HTTPS_PROXY')) && env.NODE_USE_ENV_PROXY === '1' };
  const raw = fromEnv(env, 'HTTPS_PROXY') || fromEnv(env, 'HTTP_PROXY');
  if (!raw) return null;
  let shown = raw;
  let username = '';
  try {
    const u = new URL(raw);
    username = decodeURIComponent(u.username);
    shown = `${u.protocol}//${u.host}`;
  } catch {}
  return { url: shown, username, noProxy: fromEnv(env, 'NO_PROXY'), source: 'environment', running: env.NODE_USE_ENV_PROXY === '1' };
}

/** Whether `host` skips the proxy (NO_PROXY rules: exact, .suffix, *.suffix, or *). */
export function bypasses(host, noProxy = '') {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return [...ALWAYS_DIRECT, ...String(noProxy).split(',')]
    .map((r) => r.trim().toLowerCase().replace(/:\d+$/, ''))
    .filter(Boolean)
    .some((rule) => rule === '*' || h === rule.replace(/^\*?\./, '') || (rule.replace(/^\*/, '').startsWith('.') && h.endsWith(rule.replace(/^\*/, ''))));
}

/** The proxy (with sign-in) this process sends `host` through, from its environment; '' for direct. */
export function proxyFor(host, env = process.env) {
  if (env.NODE_USE_ENV_PROXY !== '1') return '';
  const proxy = fromEnv(env, 'HTTPS_PROXY') || fromEnv(env, 'HTTP_PROXY');
  return proxy && !bypasses(host, fromEnv(env, 'NO_PROXY')) ? proxy : '';
}

const stepError = (step, message, extra = {}) => Object.assign(new Error(message), { step, ...extra });

/**
 * A raw connection to host:port: through `proxy` (an HTTP CONNECT tunnel, with its sign-in)
 * or directly. Errors say which step failed: "proxy" (not reached) or "tunnel" (refused).
 */
export function openTunnel(proxy, host, port, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!proxy) {
      const socket = net.connect({ host, port, timeout: timeoutMs });
      socket.once('connect', () => {
        socket.setTimeout(0);
        resolve(socket);
      });
      socket.once('timeout', () => socket.destroy(stepError('direct', `${host}:${port} did not answer within ${Math.round(timeoutMs / 1000)} seconds`, { code: 'ETIMEDOUT' })));
      socket.once('error', (e) => reject(e.step ? e : stepError('direct', `${host}:${port}: ${e.code || e.message}`, { code: e.code })));
      return;
    }
    const p = new URL(proxy);
    const auth = p.username ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}` } : {};
    const request = (p.protocol === 'https:' ? https : http).request({
      host: p.hostname,
      port: Number(p.port) || (p.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}`, ...auth },
      timeout: timeoutMs,
      agent: false,
    });
    request.once('connect', (res, socket) => {
      if (res.statusCode === 200) return resolve(socket);
      socket.destroy();
      const reason = res.statusMessage ? `${res.statusCode} ${res.statusMessage}` : String(res.statusCode);
      reject(stepError('tunnel', `The proxy refused the connection to ${host}:${port} (${reason}).`, { status: res.statusCode, proxyAnswer: reason }));
    });
    request.once('response', (res) => {
      res.resume();
      reject(stepError('tunnel', `The proxy answered ${res.statusCode} instead of opening a connection to ${host}:${port}.`, { status: res.statusCode }));
    });
    request.once('timeout', () => request.destroy(stepError('proxy', `The proxy ${p.host} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, { code: 'ETIMEDOUT' })));
    request.once('error', (e) => reject(e.step ? e : stepError('proxy', `The proxy ${p.host} could not be reached: ${e.code || e.message}.`, { code: e.code })));
    request.end();
  });
}

/**
 * Check the way to an HTTPS host, one step at a time: the proxy (when there is one), the
 * tunnel, the certificate, and an answer to `pathname`. Never throws; says where it stopped.
 */
export async function checkRoute({ proxy = '', host, port = 443, pathname = '/', timeoutMs = 10_000 }) {
  const steps = [];
  const label = proxy ? new URL(proxy).host : '';
  let socket;
  try {
    socket = await openTunnel(proxy, host, port, { timeoutMs });
    if (proxy) steps.push({ step: 'proxy', ok: true, detail: `Reached the proxy ${label}.` });
    steps.push({ step: 'tunnel', ok: true, detail: proxy ? `The proxy opened a connection to ${host}:${port}.` : `Connected to ${host}:${port} directly.` });
  } catch (error) {
    if (proxy && error.step === 'tunnel') steps.push({ step: 'proxy', ok: true, detail: `Reached the proxy ${label}.` });
    steps.push({ step: error.step === 'direct' ? 'tunnel' : error.step, ok: false, detail: error.message, status: error.status ?? 0, code: error.code ?? '' });
    return { ok: false, host, port, steps };
  }
  const secure = await new Promise((resolve) => {
    const s = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, timeout: timeoutMs }, () => resolve(s));
    s.once('error', (e) => resolve({ failed: e }));
    s.once('timeout', () => resolve({ failed: new Error('no TLS answer') }));
  });
  if (secure.failed) {
    steps.push({ step: 'certificate', ok: false, detail: `No secure connection with ${host}: ${secure.failed.code || secure.failed.message}.` });
    socket.destroy();
    return { ok: false, host, port, steps };
  }
  if (!secure.authorized) {
    const code = String(secure.authorizationError?.code ?? secure.authorizationError ?? '');
    const issuer = secure.getPeerCertificate()?.issuer?.CN ?? '';
    steps.push({ step: 'certificate', ok: false, code, detail: `${host}'s certificate${issuer ? `, issued by "${issuer}",` : ''} is not trusted here (${code}).`, issuer });
    secure.destroy();
    return { ok: false, host, port, steps };
  }
  steps.push({ step: 'certificate', ok: true, detail: `${host}'s certificate is trusted.` });
  const answer = await new Promise((resolve) => {
    const req = https.request({ host, port, path: pathname, method: 'GET', createConnection: () => secure, agent: false, timeout: timeoutMs, headers: { Accept: 'application/json' } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.once('timeout', () => req.destroy(new Error('no answer')));
    req.once('error', (e) => resolve({ error: e }));
    req.end();
  });
  secure.destroy();
  if (answer.error || answer.status >= 500) {
    steps.push({ step: 'answer', ok: false, detail: `${host} did not answer properly (${answer.error?.message ?? answer.status}).` });
    return { ok: false, host, port, steps };
  }
  steps.push({ step: 'answer', ok: true, detail: `${host} answered (${answer.status}).`, status: answer.status });
  return { ok: true, host, port, steps };
}

/**
 * Every connection this server makes or takes, for a network team: what, where, port,
 * through the proxy or not, and why. From this server's own settings.
 */
export function requirements({ checkmarxOne = [], smtp = null, git = [], letsEncrypt = false, updates = false, inboundPort = 3000, proxy = null, backupMail = null }) {
  const viaProxy = proxy ? 'Through the proxy' : 'Direct';
  const rows = [];
  const add = (direction, what, host, port, route, why) => rows.push({ direction, what, host, port, route, why });
  add('In', 'People\'s browsers, and links in emailed reports', 'this server', String(inboundPort), 'Direct', 'The web pages, sign-in and the reports people open.');
  for (const h of checkmarxOne.length ? checkmarxOne : ['<region>.iam.checkmarx.net', '<region>.ast.checkmarx.net']) {
    add('Out', 'Checkmarx One', h, '443', viaProxy, 'Sign-in with the API key, projects, scans, findings, triage and remediation.');
  }
  if (smtp?.host) add('Out', 'Email server', smtp.host, String(smtp.port || 587), 'Direct (mail does not go through a web proxy)', 'Reminders, reports and notices.');
  if (backupMail?.host) add('Out', 'Mailbox for backups', backupMail.host, String(backupMail.port || 993), 'Direct', 'Backups sent by email.');
  for (const g of git) add('Out', g.label, g.host, '443', viaProxy, 'Code authors for findings (Beta).');
  if (letsEncrypt) {
    add('Out', 'Let\'s Encrypt', 'acme-v02.api.letsencrypt.org', '443', viaProxy, 'This server\'s HTTPS certificate.');
    add('In', 'Let\'s Encrypt validation', 'this server', '80', 'Direct', 'Proves the server name when the certificate is issued and renewed.');
  }
  if (updates) add('Out', 'Updates', 'ghcr.io, pkg-containers.githubusercontent.com', '443', viaProxy, 'New versions from the Update page.');
  add('Out', 'Certificate authorities (rarely)', 'the address in a server\'s certificate', '80', viaProxy, 'Only when a server leaves out its intermediate certificate.');
  return rows;
}

/** The sheet as plain text, ready to paste into a ticket or an email to the network team. */
export function requirementsText(rows, { proxy = null, serverName = '' } = {}) {
  const cx = rows.filter((r) => r.what === 'Checkmarx One').map((r) => r.host);
  const lines = [
    `Network requirements for CxMissionZero${serverName ? ` (${serverName})` : ''}`,
    '',
    proxy ? `Outgoing web traffic goes through the proxy ${proxy.url}.` : 'Outgoing web traffic goes directly (no proxy configured).',
    '',
    'Please allow:',
    ...rows.map((r) => `- ${r.direction === 'In' ? 'Incoming to' : 'Outgoing to'} ${r.host}, port ${r.port} (${r.route}): ${r.what}. ${r.why}`),
    '',
    'For the proxy (if there is one), one rule covers Checkmarx One:',
    `- Allow this server's IP address to ${cx.length ? cx.join(' and ') : '*.checkmarx.net'} on port 443 (HTTP CONNECT).`,
    '- Without HTTPS inspection for these hosts (or tell us, and we trust the proxy\'s certificate in the app).',
    '- Without Windows-integrated sign-in (NTLM/Kerberos): allow by IP address, or give a user name and password for basic authentication.',
    '',
    'All traffic is encrypted (HTTPS / TLS 1.2 or later); nothing else is sent anywhere.',
  ];
  return lines.join('\n');
}
