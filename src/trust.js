// Which certificate authorities this server trusts when it calls out over HTTPS (Checkmarx One,
// the mail server, Git hosts): Node's bundled roots, the container's own store, NODE_EXTRA_CA_CERTS,
// and the ones an Admin added, saved in the data folder. Applied live with
// tls.setDefaultCACertificates, so a change needs no restart and no environment variable.
//
// Two reasons a certificate is "not trusted", and what this does about each:
// - The server left out an intermediate certificate (browsers fetch it themselves; Node does not).
//   It is fetched from the address the certificate names (its "CA Issuers" link), and kept only if
//   it chains to a root already trusted. Nothing to ask: it changes no one's trust.
// - A company proxy inspects HTTPS and signs with its own root. Its root is found (in what the
//   proxy presents, or through the same links) and shown to an Admin, who trusts it with a click,
//   or uploads it. Never trusted without that.
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';

import { openTunnel, proxyFor } from './network.js';

const UNTRUSTED = new Set(['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_UNTRUSTED']);
/** Whether a TLS error code means "issued by someone not trusted here" (not expired, not the wrong name). */
export const isUntrustedCode = (code) => UNTRUSTED.has(String(code ?? ''));

const MAX_SAVED = 50;
const MAX_DOWNLOAD = 64 * 1024;
const HOPS = 4;

// Products that inspect HTTPS, by the names their certificates carry: said to the Admin, so the
// certificate is recognised ("this is our Zscaler").
const VENDORS = [
  [/zscaler/i, 'Zscaler'],
  [/netskope/i, 'Netskope'],
  [/palo ?alto|pan-?os|globalprotect|prisma/i, 'Palo Alto Networks'],
  [/forti(net|gate|proxy)/i, 'Fortinet'],
  [/umbrella|cisco/i, 'Cisco'],
  [/blue ?coat|symantec web|proxysg/i, 'Symantec / Blue Coat'],
  [/forcepoint|websense/i, 'Forcepoint'],
  [/sophos/i, 'Sophos'],
  [/check ?point/i, 'Check Point'],
  [/mcafee|skyhigh/i, 'Skyhigh / McAfee'],
  [/cloudflare/i, 'Cloudflare'],
  [/iboss/i, 'iboss'],
  [/menlo/i, 'Menlo Security'],
  [/barracuda/i, 'Barracuda'],
  [/watchguard/i, 'WatchGuard'],
  [/sonicwall/i, 'SonicWall'],
  [/kaspersky/i, 'Kaspersky'],
  [/eset/i, 'ESET'],
  [/avast|avg /i, 'Avast'],
  [/bitdefender/i, 'Bitdefender'],
  [/trend ?micro/i, 'Trend Micro'],
  [/squid/i, 'Squid'],
];

const field = (dn, key) => {
  const line = String(dn ?? '').split('\n').find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1) : '';
};
const nameOf = (dn) => field(dn, 'CN') || field(dn, 'O') || String(dn ?? '').split('\n')[0] || '';
const isSelfSigned = (cert) => {
  try {
    return cert.checkIssued(cert) && cert.verify(cert.publicKey);
  } catch {
    return false;
  }
};
const issuedBy = (cert, issuer) => {
  try {
    return cert.checkIssued(issuer) && cert.verify(issuer.publicKey);
  } catch {
    return false;
  }
};
const expired = (cert, now = Date.now()) => Date.parse(cert.validTo) < now || Date.parse(cert.validFrom) > now + 86_400_000;

/** What an Admin is shown about a certificate (nothing secret: certificates are public). */
export function describe(cert) {
  const subject = nameOf(cert.subject);
  const issuer = nameOf(cert.issuer);
  const text = `${cert.subject}\n${cert.issuer}`;
  return {
    subject,
    organization: field(cert.subject, 'O'),
    issuer,
    fingerprint256: cert.fingerprint256,
    validFrom: new Date(cert.validFrom).toISOString(),
    validTo: new Date(cert.validTo).toISOString(),
    ca: Boolean(cert.ca),
    selfSigned: isSelfSigned(cert),
    vendor: VENDORS.find(([re]) => re.test(text))?.[1] ?? '',
  };
}

/** The certificates in a PEM bundle, or one DER certificate (also base64 of DER, as .cer files often are). */
export function parseCertificates(input) {
  const text = Buffer.isBuffer(input) ? input.toString('latin1') : String(input ?? '');
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (blocks) return blocks.map((b) => new X509Certificate(b));
  const der = Buffer.isBuffer(input) ? input : /^[A-Za-z0-9+/=\s]+$/.test(text) ? Buffer.from(text.replace(/\s+/g, ''), 'base64') : null;
  if (!der?.length) return [];
  try {
    return [new X509Certificate(der)];
  } catch {
    return [];
  }
}

/** "CA Issuers" links (http/https) in a certificate's Authority Information Access. */
export function caIssuersUrls(cert) {
  return String(cert.infoAccess ?? '')
    .split('\n')
    .filter((l) => /^CA Issuers - URI:/i.test(l))
    .map((l) => l.replace(/^CA Issuers - URI:/i, '').trim())
    .filter((u) => /^https?:\/\//i.test(u));
}

// A link comes from a certificate someone else presents: never to a cloud's instance metadata,
// nor to this server itself. Checked on the address the name resolves to (so a public DNS name
// for 169.254.169.254, or 127.0.0.1 written as ::ffff:7f00:1, is refused too), and again at
// connect time on a direct connection. Company networks' own addresses (10.x, 192.168.x…) stay
// allowed: a company CA publishes its certificates there.
const METADATA = /^(169\.254\.\d+\.\d+|\[?fd00:ec2::254\]?|metadata\.google\.internal|metadata)$/i;
const NEVER = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['100.100.100.200', 32], ['224.0.0.0', 4], ['240.0.0.0', 4]]) {
  NEVER.addSubnet(address, prefix, 'ipv4');
  NEVER.addSubnet(`::ffff:${address}`, 96 + prefix, 'ipv6');
}
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fe80::', 10], ['fd00:ec2::254', 128], ['ff00::', 8]]) NEVER.addSubnet(address, prefix, 'ipv6');
const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');
LOOPBACK.addAddress('::1', 'ipv6');

/** Whether an issuer link may be followed to this IP address (`allowLoopback`: tests' own local servers only). */
export function followableAddress(address, { allowLoopback = false } = {}) {
  const family = net.isIP(String(address ?? ''));
  if (!family) return false;
  const type = family === 6 ? 'ipv6' : 'ipv4';
  if (allowLoopback && LOOPBACK.check(address, type)) return true;
  return !NEVER.check(address, type);
}

const refused = (url, why) => Object.assign(new Error(`${url} is not followed (${why})`), { code: 'EADDRNOTAVAIL' });

/** A DNS lookup that only answers with addresses an issuer link may be followed to. */
const safeLookup = (allowLoopback) => (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const bad = addresses.find((a) => !followableAddress(a.address, { allowLoopback }));
    if (bad || !addresses.length) return callback(refused(hostname, bad ? 'a local, link-local or metadata address' : 'no address'));
    if (options?.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
};

/**
 * A certificate from a "CA Issuers" link: http(s) only, never to this server or instance
 * metadata, at most 64 KB, a few seconds, two redirects (each checked the same way).
 */
export async function fetchIssuer(url, { timeoutMs = 8000, redirects = 2, allowLoopback = false } = {}) {
  let target;
  try {
    target = new URL(url);
  } catch {
    throw refused(url, 'not an address');
  }
  if (!['http:', 'https:'].includes(target.protocol)) throw refused(url, 'only http and https');
  const host = target.hostname.replace(/^\[|\]$/g, '');
  if (METADATA.test(host)) throw refused(url, 'instance metadata');
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.promises.lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw refused(url, 'its name does not resolve');
  const bad = addresses.find((a) => !followableAddress(a.address, { allowLoopback }));
  if (bad) throw refused(url, 'a local, link-local or metadata address');
  // Through the company proxy, the proxy resolves the name; directly, the connection uses only checked addresses.
  const direct = !proxyFor(host);
  return new Promise((resolve, reject) => {
    const get = target.protocol === 'https:' ? https.get : http.get;
    const req = get(target, { timeout: timeoutMs, headers: { Accept: 'application/pkix-cert, application/x-x509-ca-cert, */*' }, ...(direct ? { lookup: safeLookup(allowLoopback) } : {}) }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        let next;
        try {
          next = new URL(res.headers.location, target).href;
        } catch {
          return reject(refused(url, 'a broken redirect'));
        }
        return fetchIssuer(next, { timeoutMs, redirects: redirects - 1, allowLoopback }).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${url} answered ${res.statusCode}`));
      }
      const parts = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_DOWNLOAD) return req.destroy(new Error(`${url} is larger than a certificate`));
        parts.push(chunk);
      });
      res.on('end', () => {
        // A .p7c (PKCS#7) bundle is not read; one certificate, DER or PEM, is.
        const [cert] = parseCertificates(Buffer.concat(parts));
        cert ? resolve(cert) : reject(new Error(`${url} did not hold a certificate`));
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${url} did not answer`)));
    req.on('error', reject);
  });
}
const download = (url) => fetchIssuer(url);

/**
 * Connect to host:port and read the certificates it presents, without trusting them; whether
 * they are trusted here, and why not. Nothing is sent but the handshake. Through the company
 * proxy when this server uses one, as its other connections are.
 */
export async function inspect(host, port = 443, { timeoutMs = 10_000, proxy = proxyFor(host) } = {}) {
  const tunnel = proxy ? await openTunnel(proxy, host, port, { timeoutMs }) : null;
  return new Promise((resolve, reject) => {
    const servername = /^[\d.]+$|:/.test(host) ? undefined : host;
    // Reads what is presented without refusing it: this is the look at an untrusted chain an Admin
    // asked for. Nothing but the handshake is sent, and Node still checks the chain and the name
    // (`host`, also through a tunnel) into `authorized`, which every caller goes by.
    const socket = tls.connect({ ...(tunnel ? { socket: tunnel } : { port }), host, servername, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const chain = [];
      const seen = new Set();
      for (let peer = socket.getPeerCertificate(true); peer?.raw && !seen.has(peer.fingerprint256); peer = peer.issuerCertificate) {
        seen.add(peer.fingerprint256);
        chain.push(new X509Certificate(peer.raw));
      }
      const result = { host, port, authorized: socket.authorized, error: socket.authorized ? '' : String(socket.authorizationError?.code ?? socket.authorizationError ?? ''), chain };
      socket.end();
      resolve(result);
    });
    socket.on('timeout', () => socket.destroy(Object.assign(new Error(`${host}:${port} did not answer within ${Math.round(timeoutMs / 1000)} seconds`), { code: 'ETIMEDOUT' })));
    socket.on('error', reject);
  });
}

export class TrustStore {
  #file;
  #base;
  #saved = [];
  #trusted = null; // X509Certificate[] of everything trusted, parsed on first need
  #log;

  /** @param {{dir: string, log?: Function}} options  dir: the data folder; certificates go in dir/trust. */
  constructor({ dir, log = () => {} }) {
    this.dir = path.join(dir, 'trust');
    this.#file = path.join(this.dir, 'certificates.json');
    this.#log = log;
    this.#base = baseCertificates();
    try {
      const list = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
      this.#saved = (Array.isArray(list) ? list : []).filter((e) => {
        try {
          new X509Certificate(e.pem);
          return true;
        } catch {
          return false;
        }
      });
    } catch {}
    this.apply();
  }

  /** The certificates an Admin added (or that were fetched to complete a chain), newest first. */
  list() {
    return this.#saved
      .map(({ pem, ...meta }) => ({ ...meta, ...describe(new X509Certificate(pem)), expired: expired(new X509Certificate(pem)) }))
      .sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
  }

  /** Every trusted certificate, for chain building. */
  #all() {
    if (!this.#trusted) {
      this.#trusted = [];
      for (const pem of [...this.#base, ...this.#saved.map((e) => e.pem)]) {
        try {
          this.#trusted.push(new X509Certificate(pem));
        } catch {}
      }
    }
    return this.#trusted;
  }

  /** Make outbound TLS (fetch, https, mail, and git's child processes) use the current list. */
  apply() {
    this.#trusted = null;
    const extra = this.#saved.filter((e) => !expired(new X509Certificate(e.pem))).map((e) => e.pem);
    if (typeof tls.setDefaultCACertificates === 'function') tls.setDefaultCACertificates([...new Set([...this.#base, ...extra])]);
    // git runs as its own process with OpenSSL's store: hand it the same list.
    const bundle = path.join(this.dir, 'bundle.pem');
    if (extra.length) {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(bundle, [...new Set([...this.#base, ...extra])].join('\n'), { mode: 0o644 });
      process.env.GIT_SSL_CAINFO = bundle;
    } else if (process.env.GIT_SSL_CAINFO === bundle) {
      delete process.env.GIT_SSL_CAINFO;
    }
  }

  #save() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.#saved, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
    this.apply();
  }

  /** Whether `cert` is trusted here, or issued by a trusted certificate. */
  #anchored(cert) {
    return this.#all().some((t) => t.fingerprint256 === cert.fingerprint256 || issuedBy(cert, t));
  }

  /**
   * Add certificate authorities (X509Certificate[]). Only CA certificates that have not expired;
   * a server's own certificate is refused with a reason.
   */
  add(certs, { source, host = '', by = '' }) {
    const added = [];
    for (const cert of certs) {
      if (!cert.ca) throw Object.assign(new Error(`"${nameOf(cert.subject)}" is a server's own certificate, not a certificate authority. Give the root certificate it was issued by ("${nameOf(cert.issuer)}").`), { status: 400 });
      if (expired(cert)) throw Object.assign(new Error(`"${nameOf(cert.subject)}" expired on ${new Date(cert.validTo).toISOString().slice(0, 10)}.`), { status: 400 });
      if (this.#saved.some((e) => new X509Certificate(e.pem).fingerprint256 === cert.fingerprint256)) continue;
      if (this.#base.includes(cert.toString())) continue;
      this.#saved.push({ pem: cert.toString(), source, host, addedBy: by, addedAt: new Date().toISOString() });
      added.push(describe(cert));
    }
    if (this.#saved.length > MAX_SAVED) throw Object.assign(new Error(`At most ${MAX_SAVED} certificates can be added. Remove ones no longer needed first.`), { status: 400 });
    if (added.length) this.#save();
    return added;
  }

  /** Remove an added certificate by its SHA-256 fingerprint. */
  remove(fingerprint256) {
    const before = this.#saved.length;
    const removed = this.#saved.find((e) => new X509Certificate(e.pem).fingerprint256 === fingerprint256);
    this.#saved = this.#saved.filter((e) => e !== removed);
    if (this.#saved.length !== before) this.#save();
    return removed ? describe(new X509Certificate(removed.pem)) : null;
  }

  /**
   * Follow "CA Issuers" links up from the top of what a server presented, until a certificate
   * that is trusted here, or a self-signed root, or nothing more to follow.
   */
  async complete(chain, { fetch = download } = {}) {
    const fetched = [];
    let top = chain.at(-1);
    for (let hop = 0; top && hop < HOPS && !this.#anchored(top) && !isSelfSigned(top); hop++) {
      let next = null;
      for (const url of caIssuersUrls(top)) {
        try {
          const cert = await fetch(url);
          if (issuedBy(top, cert)) {
            next = cert;
            break;
          }
        } catch {}
      }
      if (!next) break;
      fetched.push(next);
      top = next;
    }
    return { fetched, top, anchored: Boolean(top && this.#anchored(top)) };
  }

  /**
   * Why host:port's certificate is not trusted, and what to do: "trusted" (nothing),
   * "repaired" (missing intermediates fetched and kept, now trusted), "needs-consent" (a
   * private root to show an Admin), "needs-upload" (its root could not be found), or "other"
   * (expired, wrong name: not a trust question).
   */
  async diagnose(host, port = 443, { repair = true, fetch = download, timeoutMs } = {}) {
    const seen = await inspect(host, port, { timeoutMs });
    if (seen.authorized) return { status: 'trusted', host, port };
    if (!isUntrustedCode(seen.error)) return { status: 'other', host, port, error: seen.error, presented: seen.chain.map(describe) };
    const done = await this.complete(seen.chain, { fetch });
    const presented = seen.chain.map(describe);
    if (done.anchored) {
      // The server left out intermediates that a public root vouches for.
      const intermediates = done.fetched.filter((c) => c.ca && !this.#all().some((t) => t.fingerprint256 === c.fingerprint256));
      if (!repair || !intermediates.length) return { status: 'repairable', host, port, error: seen.error, presented, intermediates: intermediates.map(describe) };
      const added = this.add(intermediates, { source: 'intermediate', host });
      const again = await inspect(host, port, { timeoutMs });
      if (again.authorized) {
        this.#log(`[trust] ${host}:${port} left out its intermediate certificate; fetched ${added.map((a) => `"${a.subject}"`).join(', ')} from its issuer, which a trusted root vouches for.`);
        return { status: 'repaired', host, port, added };
      }
      for (const a of added) this.remove(a.fingerprint256);
      return { status: 'needs-upload', host, port, error: again.error, presented, issuer: nameOf(seen.chain.at(-1)?.issuer) };
    }
    const root = [...seen.chain, ...done.fetched].find((c) => c.ca && isSelfSigned(c));
    if (root && !expired(root)) {
      const intermediates = done.fetched.filter((c) => c !== root && c.ca);
      return { status: 'needs-consent', host, port, error: seen.error, presented, candidate: describe(root), intermediates: intermediates.map(describe) };
    }
    return { status: 'needs-upload', host, port, error: seen.error, presented, issuer: nameOf((done.top ?? seen.chain.at(-1))?.issuer), vendor: presented.map((p) => p.vendor).find(Boolean) ?? '' };
  }

  /**
   * An Admin trusts the root that host:port's network presents, by its fingerprint: looked up
   * again here (never taken from the browser), so only what was shown can be trusted. Kept only
   * if host:port is then trusted.
   */
  async trustPresented(host, port, fingerprint256, { by = '', fetch = download, timeoutMs } = {}) {
    const found = await this.diagnose(host, port, { repair: true, fetch, timeoutMs });
    if (found.status === 'trusted' || found.status === 'repaired') return { ...found, added: found.added ?? [] };
    if (found.status !== 'needs-consent' || found.candidate.fingerprint256 !== fingerprint256) {
      throw Object.assign(new Error(`${host} no longer presents that certificate. Try connecting again to see what it presents now.`), { status: 409 });
    }
    const seen = await inspect(host, port, { timeoutMs });
    const done = await this.complete(seen.chain, { fetch });
    const certs = [...seen.chain, ...done.fetched].filter((c) => c.ca && (c.fingerprint256 === fingerprint256 || found.intermediates.some((i) => i.fingerprint256 === c.fingerprint256)));
    const added = this.add(certs, { source: 'detected', host, by });
    const again = await inspect(host, port, { timeoutMs });
    if (!again.authorized) {
      for (const a of added) this.remove(a.fingerprint256);
      throw Object.assign(new Error(`${host} is still not trusted with that certificate (${again.error || 'unknown reason'}). Upload your company's root certificate instead.`), { status: 422 });
    }
    return { status: 'trusted', host, port, added };
  }

  /**
   * An Admin uploads certificate authorities (PEM bundle, or DER / base64 DER). With what a
   * failing server presented (`chain`), only the certificates that complete its chain are kept,
   * so a whole exported store (every certificate Windows trusts) can be given as it is.
   */
  upload(input, { by = '', chain = null, host = '' } = {}) {
    let certs;
    try {
      certs = parseCertificates(input);
    } catch {
      certs = [];
    }
    if (!certs.length) throw Object.assign(new Error('That file holds no certificate. Upload a .pem, .crt or .cer file.'), { status: 400 });
    if (chain?.length) {
      const needed = [];
      let top = chain.at(-1);
      for (let hop = 0; top && hop < HOPS && !this.#anchored(top) && !isSelfSigned(top); hop++) {
        const issuer = certs.find((c) => c.ca && issuedBy(top, c) && !needed.includes(c));
        if (!issuer) break;
        needed.push(issuer);
        top = issuer;
      }
      if (!needed.length) {
        throw Object.assign(new Error(`None of the ${certs.length} certificate(s) in that file issued ${host || 'the server'}'s certificate, which is issued by "${nameOf(chain.at(-1).issuer)}". Upload the certificate with that name.`), { status: 400 });
      }
      return this.add(needed, { source: 'uploaded', host, by });
    }
    const usable = certs.filter((c) => c.ca && !expired(c) && !this.#all().some((t) => t.fingerprint256 === c.fingerprint256));
    if (!usable.length && certs.some((c) => !c.ca)) return this.add(certs.filter((c) => !c.ca).slice(0, 1), { source: 'uploaded', by }); // says why
    if (usable.length > MAX_SAVED - this.#saved.length) {
      throw Object.assign(new Error(`That file holds ${usable.length} certificates not trusted yet. Upload it where the connection failed, so only the ones it needs are kept, or upload just your company's root certificate.`), { status: 400 });
    }
    return this.add(usable, { source: 'uploaded', by });
  }

  /** What host:port presents now (for an upload that completes its chain). */
  async presented(host, port = 443, { timeoutMs } = {}) {
    return (await inspect(host, port, { timeoutMs })).chain;
  }
}

/** Node's bundled roots and NODE_EXTRA_CA_CERTS, and the container's own store (where a build added a company CA). */
function baseCertificates() {
  const all = new Set();
  for (const kind of ['default', 'system']) {
    try {
      for (const pem of tls.getCACertificates?.(kind) ?? []) all.add(pem);
    } catch {}
  }
  if (!all.size) for (const pem of tls.rootCertificates) all.add(pem);
  return [...all];
}
