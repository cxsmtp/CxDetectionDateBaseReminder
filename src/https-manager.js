/**
 * HTTPS run from the Settings page (Admin only), so moving a running server from http to
 * https needs no new container command and never cuts anyone off.
 *
 * One port, both protocols. Every connection's first byte says what it is (a TLS handshake
 * always starts with 0x16), so http:// and https:// are answered on the same port. The
 * published port (-p 3000:3000) never changes, and the switch is three steps:
 *
 *   'http'   plain http only (a laptop, or behind a reverse proxy that does HTTPS);
 *   'both'   http and https side by side: try HTTPS, while http keeps working;
 *   'https'  https only: http answers with a redirect to https (and emailed reports with
 *            the new address, which they switch to by themselves).
 *
 * Certificates, in order of preference: one uploaded on the Settings page (PEM files or a
 * .pfx, or the certificate IT returned for a request made here); the one the container
 * names (TLS_CERT_FILE / TLS_PFX_FILE); otherwise a self-signed one. Every certificate is
 * checked before use: it is served on a private loopback port and connected to, the way a
 * browser would, so a wrong key, a missing intermediate, a name people use that it does not
 * cover, or an expired date is reported before anyone meets it.
 *
 * The choices live in DATA_DIR/https.json (0600, with the certificate files in DATA_DIR/tls);
 * HTTPS=on|off|both only sets the starting point until an Admin changes it here. Lost access?
 * `node scripts/https.mjs both` (in the container) puts http back next to https, at once.
 */

import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tls, { createSecureContext } from 'node:tls';

import { certificateRequest, describeCertificate, ensureSelfSigned, environmentCertificate, isIp, selfSignedNames, startMode } from './tls.js';

export const MODES = ['http', 'both', 'https'];
export const HSTS_AGES = [86_400, 604_800, 15_768_000, 31_536_000]; // a day, a week, half a year, a year
const MIN_VERSIONS = ['TLSv1.2', 'TLSv1.3'];
const MAX_FILE_BYTES = 256 * 1024;
const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';
const ANY_USAGE = '2.5.29.37.0';
const FILE_MODE = 0o600;

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const readIf = (file) => {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
};
const cn = (dn) => String(dn ?? '').match(/(?:^|\n)CN=([^\n]+)/)?.[1] ?? String(dn ?? '').split('\n')[0];
const daysUntil = (date, now = Date.now()) => Math.floor((Date.parse(date) - now) / 86_400_000);
const sanNames = (cert) => String(cert.subjectAltName ?? '').split(', ').map((s) => s.replace(/^(DNS|IP Address):/, '')).filter(Boolean);

function writeAtomic(file, data, mode = FILE_MODE) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, data, { mode });
  fs.renameSync(temp, file);
  fs.chmodSync(file, mode);
}

/** The roots a browser would trust: Node's bundled ones (and the system's / NODE_EXTRA_CA_CERTS where Node offers them). */
function trustedRoots() {
  try {
    if (typeof tls.getCACertificates === 'function') return tls.getCACertificates('default');
  } catch {}
  return tls.rootCertificates;
}
const PUBLIC_ROOTS = new Set();
function isPublicRoot(cert) {
  if (!PUBLIC_ROOTS.size) {
    for (const pem of trustedRoots()) {
      try {
        PUBLIC_ROOTS.add(new X509Certificate(pem).fingerprint256);
      } catch {}
    }
  }
  return PUBLIC_ROOTS.has(cert.fingerprint256);
}

// ---------------------------------------------------------------------------
// Reading what was uploaded
// ---------------------------------------------------------------------------

/**
 * Sort uploaded files into certificates, private keys and a .pfx, whatever their names:
 * PEM files (one or several blocks: server, chain, bundle, key), DER .cer / .crt files as
 * Windows exports them, and .pfx / .p12 files.
 */
export function readUploads(files, passphrase = '') {
  const certs = [];
  const keys = [];
  const notes = [];
  let pfx = null;
  if (!Array.isArray(files) || !files.length) throw fail(400, 'Choose the certificate files first.');
  if (files.length > 10) throw fail(400, 'At most 10 files at once.');
  for (const file of files) {
    const name = String(file?.name ?? 'file').slice(0, 120);
    const data = Buffer.from(String(file?.data ?? ''), 'base64');
    if (!data.length) continue;
    if (data.length > MAX_FILE_BYTES) throw fail(400, `${name} is larger than 256 KB, so it is not a certificate file.`);
    const text = data.toString('latin1');
    if (text.includes('-----BEGIN ')) {
      const blocks = [...text.matchAll(/-----BEGIN ([A-Z0-9 ]+)-----[\s\S]+?-----END \1-----/g)];
      if (!blocks.length) notes.push(`${name}: the file looks cut short (no complete BEGIN … END block).`);
      for (const [pem, label] of blocks) {
        if (label === 'CERTIFICATE' || label === 'TRUSTED CERTIFICATE') {
          try {
            const cert = new X509Certificate(pem);
            certs.push({ name, cert, pem: cert.toString() });
          } catch (error) {
            throw fail(400, `${name}: a certificate in it could not be read (${error.message}).`);
          }
        } else if (/PRIVATE KEY$/.test(label)) {
          keys.push({ name, pem, encrypted: label.startsWith('ENCRYPTED') || /Proc-Type: 4,ENCRYPTED/.test(pem) });
        } else if (/CERTIFICATE REQUEST$/.test(label)) {
          notes.push(`${name} is a certificate request (CSR). That is what IT signs; upload the certificate they send back.`);
        } else {
          notes.push(`${name}: a "${label}" block is not needed and was left out.`);
        }
      }
      continue;
    }
    try {
      const cert = new X509Certificate(data); // a binary (DER) .cer / .crt
      certs.push({ name, cert, pem: cert.toString() });
      continue;
    } catch {}
    if (/\.(pfx|p12)$/i.test(name) || isPkcs12(data)) {
      if (pfx) throw fail(400, 'Upload one .pfx at a time.');
      pfx = { name, data };
      continue;
    }
    throw fail(400, `${name} is not a certificate, a private key or a .pfx file.`);
  }
  if (pfx) {
    if (certs.length || keys.length) notes.push(`${pfx.name} already holds the certificate and its key; the other files were not needed.`);
    try {
      createSecureContext({ pfx: pfx.data, passphrase: passphrase || undefined });
    } catch (error) {
      if (/mac verify|password|passphrase|bad decrypt/i.test(error.message)) {
        throw fail(400, passphrase ? `${pfx.name} did not open with that password.` : `${pfx.name} is protected by a password: enter it, then check again.`, { needsPassphrase: true });
      }
      throw fail(400, `${pfx.name} could not be used: ${error.message}`);
    }
    return { kind: 'pfx', pfx, notes };
  }
  return { kind: 'pem', certs, keys, notes };
}

/** A PKCS#12 file starts with a DER SEQUENCE holding INTEGER 3 (its version). */
function isPkcs12(data) {
  if (data[0] !== 0x30) return false;
  const lengthBytes = data[1] & 0x80 ? data[1] & 0x7f : 0;
  const at = 2 + lengthBytes;
  return data[at] === 0x02 && data[at + 1] === 0x01 && data[at + 2] === 0x03;
}

function openKey(entry, passphrase) {
  try {
    return createPrivateKey({ key: entry.pem, passphrase: passphrase || undefined });
  } catch (error) {
    if (entry.encrypted || /passphrase|password|decrypt/i.test(error.message)) {
      throw fail(400, passphrase ? `The private key in ${entry.name} did not open with that password.` : `The private key in ${entry.name} is protected by a password: enter it, then check again.`, { needsPassphrase: true });
    }
    throw fail(400, `The private key in ${entry.name} could not be read: ${error.message}`);
  }
}

/**
 * The server certificate (the one the key belongs to), then the certificates that issued
 * it, in order; a root at the top is kept apart (browsers have their own). Certificates
 * that are not part of the chain are left out, and said so.
 */
export function assemblePem({ certs, keys, notes }, { passphrase = '', requestKey = null } = {}) {
  if (!certs.length) throw fail(400, keys.length ? 'Only a private key was given: add the certificate (.crt, .cer or .pem).' : 'No certificate in these files.');
  const opened = keys.map((entry) => ({ entry, key: openKey(entry, passphrase) }));
  if (!opened.length && requestKey) opened.push({ entry: { name: 'the request made here' }, key: createPrivateKey(requestKey), fromRequest: true });
  if (!opened.length) {
    throw fail(400, 'The private key is missing. Add the .key file that belongs to this certificate, upload a .pfx that holds both, or create the request here first so the key is already on this server.');
  }
  let leaf = null;
  let keyUsed = null;
  for (const candidate of opened) {
    leaf = certs.find((c) => c.cert.checkPrivateKey(candidate.key));
    if (leaf) {
      keyUsed = candidate;
      break;
    }
  }
  if (!leaf) {
    throw fail(400, opened.some((o) => o.fromRequest) && !keys.length
      ? 'This certificate was not made for the request created here. Add the private key it was made for, or send IT the request from this page.'
      : 'The private key does not belong to any of these certificates. They are probably from different requests: ask IT for the matching pair.');
  }
  const chain = [leaf];
  let root = null;
  const used = new Set([leaf]);
  for (let current = leaf; ; ) {
    const issuer = certs.find((c) => !used.has(c) && current.cert.checkIssued(c.cert) && current.cert.verify(c.cert.publicKey));
    if (!issuer) break;
    used.add(issuer);
    if (issuer.cert.checkIssued(issuer.cert)) {
      root = issuer;
      break;
    }
    chain.push(issuer);
    current = issuer;
  }
  const extra = certs.length - used.size;
  if (extra) notes.push(`${extra} certificate${extra === 1 ? ' was' : 's were'} not part of this certificate's chain and ${extra === 1 ? 'was' : 'were'} left out.`);
  const keyPem = keyUsed.key.export({ type: 'pkcs8', format: 'pem' });
  return {
    options: { cert: chain.map((c) => c.pem).join(''), key: keyPem },
    root: root?.pem ?? '',
    fromRequest: Boolean(keyUsed.fromRequest),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Checking a certificate the way a browser would
// ---------------------------------------------------------------------------

/** Serve `options` on a private loopback port for a moment and connect to it. */
async function handshake(options, { servername, ca, minVersion = 'TLSv1.2' }) {
  const server = tls.createServer({ ...options, minVersion });
  server.on('tlsClientError', () => {});
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  try {
    return await new Promise((resolve, reject) => {
      const socket = tls.connect(
        { host: '127.0.0.1', port: server.address().port, servername: servername && !isIp(servername) ? servername : undefined, rejectUnauthorized: false, ca, minVersion },
        () => {
          const chain = [];
          const seen = new Set();
          for (let c = socket.getPeerCertificate(true); c?.raw && !seen.has(c.fingerprint256); c = c.issuerCertificate) {
            seen.add(c.fingerprint256);
            chain.push(new X509Certificate(c.raw));
          }
          resolve({ authorized: socket.authorized, error: socket.authorizationError ? String(socket.authorizationError) : '', chain, protocol: socket.getProtocol() });
          socket.end();
        },
      );
      socket.setTimeout(5000, () => socket.destroy(new Error('no answer within 5 s')));
      socket.on('error', reject);
    });
  } finally {
    server.close();
  }
}

/**
 * Everything worth knowing before putting a certificate to use: what it is, and a list of
 * checks (ok / warn / error). `hosts` are the names people use to reach this server.
 */
export async function inspectCertificate(options, { hosts = [], root = '', minVersion = 'TLSv1.2', kind = 'pem', now = Date.now() } = {}) {
  let result;
  try {
    createSecureContext({ ...options, minVersion });
    result = await handshake(options, { servername: hosts.find((h) => !isIp(h)), ca: [...trustedRoots(), ...(root ? [root] : [])], minVersion });
  } catch (error) {
    throw fail(400, /key values mismatch/i.test(error.message) ? 'The private key does not belong to the certificate.' : `The certificate could not be served: ${error.message}`);
  }
  const [leaf] = result.chain;
  if (!leaf) throw fail(400, 'The certificate could not be read back.');
  const checks = [];
  const add = (id, level, title, detail = '') => checks.push({ id, level, title, detail });
  add('key', 'ok', 'The private key belongs to the certificate', `Answers HTTPS with ${result.protocol}.`);

  // Dates
  const days = daysUntil(leaf.validTo, now);
  if (Date.parse(leaf.validFrom) > now) add('dates', 'error', `Not valid until ${new Date(leaf.validFrom).toISOString().slice(0, 10)}`, 'Browsers refuse it until then.');
  else if (days < 0) add('dates', 'error', `Expired on ${new Date(leaf.validTo).toISOString().slice(0, 10)}`, 'Ask IT for a renewed certificate.');
  else if (days < 30) add('dates', 'warn', `Expires in ${days} day${days === 1 ? '' : 's'}`, 'Ask IT for the renewal now; upload it here when it comes, with no restart.');
  else add('dates', 'ok', `Valid until ${new Date(leaf.validTo).toISOString().slice(0, 10)} (${days} days)`);

  // Names
  const names = sanNames(leaf);
  const wanted = [...new Set(hosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean))];
  const covered = (host) => (isIp(host) ? leaf.checkIP(host) : leaf.checkHost(host, { subject: 'never' }));
  const missing = wanted.filter((h) => !covered(h));
  if (!names.length) add('names', 'error', 'It names no server (no Subject Alternative Name)', 'Browsers ignore the old common name. Ask IT to put the server name into the Subject Alternative Name.');
  else if (!wanted.length) add('names', 'ok', `Covers ${names.join(', ')}`);
  else if (!missing.length) add('names', 'ok', `Covers ${wanted.join(', ')}`, `All names in it: ${names.join(', ')}.`);
  else {
    const local = missing.every((h) => /^(localhost|127\.0\.0\.1|::1)$/.test(h));
    add('names', 'warn', `Does not cover ${missing.join(', ')}`, local
      ? `Fine: that is this machine's own name. Use ${names[0]} to reach it with no warning.`
      : `Browsers warn at an address that is not in it. It covers: ${names.join(', ')}. Use one of those names, or ask IT to add the others.`);
  }

  // Who vouches for it
  const top = result.chain[result.chain.length - 1];
  const selfSigned = result.chain.length === 1 && leaf.checkIssued(leaf);
  const issuer = cn(leaf.issuer);
  let trust;
  if (selfSigned || result.error === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
    trust = 'self-signed';
    add('trust', 'warn', 'Self-signed: nobody vouches for it', 'Every browser warns until it is trusted on that machine. Fine to try HTTPS out; for everyone, use a certificate from IT.');
  } else if (!result.error) {
    trust = isPublicRoot(top) ? 'public' : 'company';
    add('trust', 'ok', trust === 'public' ? `Trusted everywhere: issued by ${issuer}` : `Issued by your certificate authority ${cn(top.subject)}`, trust === 'public' ? '' : 'Trusted on machines that trust that authority, usually every company machine. The browser check below confirms it for yours.');
  } else if (/^CERT_HAS_EXPIRED$|^CERT_NOT_YET_VALID$/.test(result.error)) {
    trust = 'dates';
  } else if (result.error === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    trust = 'incomplete';
    add('trust', 'warn', `Issued by ${issuer}, but its chain is missing`, 'Only the server certificate was given. Add the intermediate certificates IT sent with it (often a "chain" or "bundle" file); without them some machines cannot verify it. Company machines may already have them.');
  } else if (/UNABLE_TO_GET_ISSUER_CERT|SELF_SIGNED_CERT_IN_CHAIN/.test(result.error)) {
    trust = 'company';
    add('trust', 'ok', `Issued by your certificate authority ${cn(top.issuer) || cn(top.subject)}`, 'A private (company) authority: trusted on machines that trust it, usually every company machine. The browser check below confirms it for yours.');
  } else {
    trust = 'unknown';
    add('trust', 'warn', `Could not be verified (${result.error})`, 'Browsers may warn about it.');
  }

  // Key strength and purpose
  const details = leaf.publicKey.asymmetricKeyDetails ?? {};
  const keyType = leaf.publicKey.asymmetricKeyType === 'rsa' ? `RSA ${details.modulusLength}-bit` : leaf.publicKey.asymmetricKeyType === 'ec' ? `EC ${details.namedCurve}` : String(leaf.publicKey.asymmetricKeyType ?? '').toUpperCase();
  if (leaf.publicKey.asymmetricKeyType === 'rsa' && details.modulusLength < 2048) add('strength', 'error', `${keyType} key: too weak`, 'Browsers refuse RSA keys under 2048 bits. Ask IT for a new certificate with a 2048-bit (or larger) key.');
  else add('strength', 'ok', `${keyType} key`);
  const usage = leaf.keyUsage;
  if (Array.isArray(usage) && usage.length && !usage.includes(SERVER_AUTH) && !usage.includes(ANY_USAGE)) add('usage', 'error', 'Not a web server certificate', 'Its usage leaves out server authentication, so browsers refuse it. Ask IT for a server (web) certificate.');
  if (leaf.ca) add('usage', 'warn', 'This is a certificate authority, not a server certificate', 'Check you picked the server certificate, not the CA file.');

  return {
    kind,
    usable: !checks.some((c) => c.level === 'error'),
    trust,
    summary: {
      subject: cn(leaf.subject),
      names,
      issuer,
      validFrom: new Date(leaf.validFrom).toISOString(),
      validTo: new Date(leaf.validTo).toISOString(),
      daysLeft: days,
      selfSigned,
      keyType,
      fingerprint: leaf.fingerprint256,
      chain: result.chain.map((c) => ({ subject: cn(c.subject), issuer: cn(c.issuer), validTo: new Date(c.validTo).toISOString().slice(0, 10) })),
    },
    checks,
  };
}

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------

export class HttpsManager {
  #dataDir;
  #dir;
  #file;
  #env;
  #log;
  #state;
  #stamp = '';
  #active = null; // {source, files, load, selfSigned}
  #certStamp = '';
  #report = null; // inspection of the active certificate, by its stamp and hosts
  #secureServers = new Set();
  #listeners = new Set();
  #timer = null;

  constructor({ dataDir, env = process.env, log = console }) {
    this.#dataDir = dataDir;
    this.#dir = path.join(dataDir, 'tls');
    this.#file = path.join(dataDir, 'https.json');
    this.#env = env;
    this.#log = log;
    this.#state = this.#read();
    this.#active = this.#resolve();
  }

  // --- state -------------------------------------------------------------

  #defaults() {
    const given = Boolean(environmentCertificate(this.#env));
    return {
      mode: startMode(this.#env),
      minVersion: 'TLSv1.2',
      // A certificate given to the container kept HSTS on before this page existed; one chosen here starts without it.
      hsts: { enabled: given, maxAge: given ? 31_536_000 : 86_400, includeSubDomains: given },
      selfSignedNames: [],
      uploaded: null,
      previous: null,
      request: null,
      lastBrowserCheck: null,
      changedAt: '',
      changedBy: '',
    };
  }

  #read() {
    const defaults = this.#defaults();
    try {
      const raw = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
      this.#stamp = this.#fileStamp();
      return {
        ...defaults,
        ...raw,
        mode: MODES.includes(raw.mode) ? raw.mode : defaults.mode,
        minVersion: MIN_VERSIONS.includes(raw.minVersion) ? raw.minVersion : 'TLSv1.2',
        hsts: { ...defaults.hsts, ...(raw.hsts ?? {}) },
        saved: true,
      };
    } catch {
      this.#stamp = '';
      return { ...defaults, saved: false };
    }
  }

  #fileStamp() {
    const stat = fs.statSync(this.#file, { throwIfNoEntry: false });
    return stat ? `${stat.mtimeMs}:${stat.size}` : '';
  }

  #save(by) {
    this.#state = { ...this.#state, changedAt: new Date().toISOString(), changedBy: by ?? this.#state.changedBy, saved: true };
    const { saved, ...stored } = this.#state;
    writeAtomic(this.#file, JSON.stringify(stored, null, 2));
    this.#stamp = this.#fileStamp();
  }

  get mode() {
    return this.#state.mode;
  }

  /** Called with the new mode whenever it changes (also when changed by scripts/https.mjs). */
  onChange(listener) {
    this.#listeners.add(listener);
  }

  #notify() {
    for (const listener of this.#listeners) {
      try {
        listener(this.#state.mode);
      } catch {}
    }
  }

  // --- certificates ------------------------------------------------------

  #uploadedDir(which = 'uploaded') {
    return path.join(this.#dir, which);
  }

  #resolve() {
    const up = this.#state.uploaded;
    if (up) {
      const dir = this.#uploadedDir();
      if (up.kind === 'pfx') {
        const file = path.join(dir, 'server.pfx');
        if (fs.existsSync(file)) return { source: 'uploaded', files: [file], load: () => ({ pfx: fs.readFileSync(file), passphrase: up.passphrase || undefined }), selfSigned: false, root: '' };
      } else {
        const cert = path.join(dir, 'server.crt');
        const key = path.join(dir, 'server.key');
        if (fs.existsSync(cert) && fs.existsSync(key)) {
          return { source: 'uploaded', files: [cert, key], load: () => ({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }), selfSigned: false, root: readIf(path.join(dir, 'root.crt'))?.toString() ?? '' };
        }
      }
      this.#log.warn?.('! [https] The uploaded certificate files are missing; using the next certificate available.');
    }
    const given = environmentCertificate(this.#env);
    if (given) return { source: 'environment', ...given, selfSigned: false, root: '' };
    return null;
  }

  /** The certificate in use, made (self-signed) when there is none and HTTPS is on. */
  #certificate({ make = this.#state.mode !== 'http' } = {}) {
    if (this.#active) return this.#active;
    if (!make) return null;
    const names = selfSignedNames(this.#env, this.#state.selfSignedNames);
    const { cert, key } = ensureSelfSigned(this.#dir, names);
    this.#active = { source: 'self-signed', files: [cert, key], load: () => ({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }), selfSigned: true, root: '' };
    return this.#active;
  }

  get selfSigned() {
    return Boolean(this.#certificate({ make: false })?.selfSigned ?? this.#state.mode !== 'http');
  }

  /** What https.createServer / setSecureContext need, or null when HTTPS is off and nothing is set up. */
  contextOptions() {
    const active = this.#certificate();
    if (!active) return null;
    return { ...active.load(), minVersion: this.#state.minVersion };
  }

  /** At start: fail with the reason when the certificate in use cannot be served (a wrong file, key or password). */
  check() {
    this.#apply();
  }

  /** Check the certificate in use and put it into every listening HTTPS server. */
  #apply() {
    const options = this.contextOptions();
    this.#report = null;
    this.#certStamp = this.#certificateStamp();
    if (!options) return;
    describeCertificate(options); // throws, with a readable reason, before anything is replaced
    createSecureContext(options);
    for (const server of this.#secureServers) server.setSecureContext(options);
  }

  #certificateStamp() {
    const active = this.#active;
    return active ? active.files.map((file) => fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0).join('|') : '';
  }

  /** The active certificate, checked (cached until it or the names change). */
  async activeReport(hosts = []) {
    const active = this.#certificate({ make: false });
    if (!active) return null;
    const key = `${this.#certStamp}|${this.#state.minVersion}|${hosts.join(',')}`;
    if (this.#report?.key === key) return this.#report.value;
    let value;
    try {
      value = { source: active.source, ...(await inspectCertificate(active.load(), { hosts, root: active.root, minVersion: this.#state.minVersion, kind: active.load().pfx ? 'pfx' : 'pem' })) };
    } catch (error) {
      value = { source: active.source, usable: false, error: error.message, checks: [{ id: 'key', level: 'error', title: error.message }] };
    }
    this.#report = { key, value };
    return value;
  }

  /** Check uploaded files without changing anything. */
  async inspect({ files, passphrase = '', hosts = [] }) {
    const { prepared } = this.#prepare(files, passphrase);
    const report = await inspectCertificate(prepared.options, { hosts, root: prepared.root, minVersion: this.#state.minVersion, kind: prepared.kind });
    return { ...report, notes: prepared.notes, fromRequest: prepared.fromRequest };
  }

  #prepare(files, passphrase) {
    const read = readUploads(files, passphrase);
    if (read.kind === 'pfx') {
      return { prepared: { kind: 'pfx', options: { pfx: read.pfx.data, passphrase: passphrase || undefined }, root: '', notes: read.notes, fromRequest: false, passphrase } };
    }
    const requestKey = readIf(path.join(this.#dir, 'request.key'));
    const pem = assemblePem(read, { passphrase, requestKey });
    return { prepared: { kind: 'pem', ...pem } };
  }

  /**
   * Put an uploaded certificate to use, at once, on the running server. The one it replaces
   * is kept, so "Put the previous one back" undoes it. With HTTPS only, a certificate with
   * warnings (a name people use it does not cover, self-signed…) needs `confirm`.
   */
  async install({ files, passphrase = '', hosts = [], confirm = false, by = '' }) {
    const { prepared } = this.#prepare(files, passphrase);
    const report = await inspectCertificate(prepared.options, { hosts, root: prepared.root, minVersion: this.#state.minVersion, kind: prepared.kind });
    report.notes = prepared.notes;
    if (!report.usable) throw fail(400, report.checks.find((c) => c.level === 'error')?.title ?? 'This certificate cannot be used.', { report });
    if (this.#state.mode === 'https' && !confirm && report.checks.some((c) => c.level === 'warn')) {
      throw fail(409, 'Everyone uses HTTPS now, and this certificate has warnings: confirm to use it anyway.', { report, needsConfirm: true });
    }
    const staging = this.#uploadedDir('staging');
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    if (prepared.kind === 'pfx') {
      writeAtomic(path.join(staging, 'server.pfx'), prepared.options.pfx);
    } else {
      writeAtomic(path.join(staging, 'server.crt'), prepared.options.cert, 0o644);
      writeAtomic(path.join(staging, 'server.key'), prepared.options.key);
      if (prepared.root) writeAtomic(path.join(staging, 'root.crt'), prepared.root, 0o644);
    }
    const previous = this.#uploadedDir('previous');
    fs.rmSync(previous, { recursive: true, force: true });
    if (fs.existsSync(this.#uploadedDir())) fs.renameSync(this.#uploadedDir(), previous);
    fs.renameSync(staging, this.#uploadedDir());
    const was = this.#state.uploaded;
    this.#state.previous = was ? { ...was } : null;
    this.#state.uploaded = {
      kind: prepared.kind,
      passphrase: prepared.kind === 'pfx' ? prepared.passphrase || '' : '',
      at: new Date().toISOString(),
      by,
      subject: report.summary.subject,
      validTo: report.summary.validTo,
      fingerprint: report.summary.fingerprint,
    };
    if (prepared.fromRequest) {
      fs.rmSync(path.join(this.#dir, 'request.key'), { force: true });
      fs.rmSync(path.join(this.#dir, 'request.csr'), { force: true });
      this.#state.request = null;
    }
    this.#active = this.#resolve();
    this.#apply();
    this.#save(by);
    return report;
  }

  /** Swap the certificate in use with the one it replaced. */
  restorePrevious({ by = '' } = {}) {
    const previous = this.#state.previous;
    const previousDir = this.#uploadedDir('previous');
    if (!previous || !fs.existsSync(previousDir)) throw fail(400, 'There is no previous certificate to put back.');
    if (Date.parse(previous.validTo) < Date.now()) throw fail(400, 'The previous certificate has expired.');
    const swap = this.#uploadedDir('swap');
    fs.rmSync(swap, { recursive: true, force: true });
    if (fs.existsSync(this.#uploadedDir())) fs.renameSync(this.#uploadedDir(), swap);
    fs.renameSync(previousDir, this.#uploadedDir());
    if (fs.existsSync(swap)) fs.renameSync(swap, previousDir);
    this.#state.previous = this.#state.uploaded;
    this.#state.uploaded = previous;
    this.#active = this.#resolve();
    this.#apply();
    this.#save(by);
  }

  /** Stop using the uploaded certificate: back to the container's, or a self-signed one. */
  removeUploaded({ confirm = false, by = '' } = {}) {
    if (!this.#state.uploaded) throw fail(400, 'No certificate was uploaded here.');
    const fallback = environmentCertificate(this.#env) ? 'environment' : 'self-signed';
    if (this.#state.mode === 'https' && fallback === 'self-signed' && !confirm) {
      throw fail(409, 'Everyone uses HTTPS now: without this certificate a self-signed one is used and every browser warns. Confirm to go ahead.', { needsConfirm: true });
    }
    const previous = this.#uploadedDir('previous');
    fs.rmSync(previous, { recursive: true, force: true });
    fs.renameSync(this.#uploadedDir(), previous);
    this.#state.previous = this.#state.uploaded;
    this.#state.uploaded = null;
    this.#active = this.#resolve();
    this.#apply();
    this.#save(by);
    return fallback;
  }

  /** A new self-signed certificate covering `names` too (used while no other certificate is set). */
  selfSign({ names = [], by = '' } = {}) {
    const clean = [...new Set(names.map((n) => String(n).trim().toLowerCase()).filter((n) => /^[a-z0-9.:*-]{1,253}$/.test(n)))].slice(0, 20);
    this.#state.selfSignedNames = clean;
    fs.rmSync(path.join(this.#dir, 'self-signed.crt'), { force: true });
    if (!this.#state.uploaded && !environmentCertificate(this.#env)) this.#active = null;
    this.#certificate({ make: true });
    this.#apply();
    this.#save(by);
  }

  /** A certificate request for IT; its key stays here, and is paired with the certificate when it comes back. */
  createRequest({ names = [], organization = '', by = '' } = {}) {
    const made = certificateRequest(names, { organization: String(organization).slice(0, 64) });
    writeAtomic(path.join(this.#dir, 'request.key'), made.key);
    writeAtomic(path.join(this.#dir, 'request.csr'), made.csr, 0o644);
    this.#state.request = { names: made.names, organization: String(organization).slice(0, 64), at: new Date().toISOString(), by };
    this.#save(by);
    return made.csr;
  }

  requestCsr() {
    return readIf(path.join(this.#dir, 'request.csr'))?.toString() ?? '';
  }

  // --- modes and hardening ----------------------------------------------

  /**
   * `secure`: the request asking for it arrived over HTTPS. Switching to HTTPS only needs
   * that: it shows HTTPS works from the Admin's own browser before http goes away.
   */
  setMode(mode, { secure = false, confirm = false, by = '' } = {}) {
    if (!MODES.includes(mode)) throw fail(400, `Unknown mode "${mode}".`);
    const from = this.#state.mode;
    if (mode === from) return mode;
    if (mode === 'https') {
      if (!secure) throw fail(409, 'Open this page over HTTPS and switch there: that proves HTTPS works from your browser before http goes away.', { needsHttps: true });
      const active = this.#certificate({ make: true });
      if (active.selfSigned && !confirm) throw fail(409, 'The certificate is self-signed: after the switch every browser warns until it trusts it. Confirm to go ahead, or upload your certificate first.', { needsConfirm: true });
    }
    if (mode === 'http' && from === 'https') {
      if (this.#state.hsts.enabled) throw fail(409, 'HSTS is on: browsers that saw it refuse plain http for a while. Turn HSTS off first, then go back to HTTP + HTTPS.');
      if (!confirm) throw fail(409, 'This turns HTTPS off for everyone. Confirm to go ahead.', { needsConfirm: true });
    }
    this.#state.mode = mode;
    if (mode !== 'http') {
      this.#certificate({ make: true });
      this.#apply();
    }
    this.#save(by);
    this.#notify();
    return mode;
  }

  setHardening({ hsts, minVersion } = {}, { by = '' } = {}) {
    if (minVersion !== undefined) {
      if (!MIN_VERSIONS.includes(minVersion)) throw fail(400, 'The lowest TLS version is TLSv1.2 or TLSv1.3.');
      this.#state.minVersion = minVersion;
    }
    if (hsts !== undefined) {
      const next = { ...this.#state.hsts, ...hsts };
      next.enabled = Boolean(next.enabled);
      next.includeSubDomains = Boolean(next.includeSubDomains);
      next.maxAge = HSTS_AGES.includes(Number(next.maxAge)) ? Number(next.maxAge) : 86_400;
      if (next.enabled && this.#state.mode !== 'https') throw fail(409, 'Turn on HSTS after switching to HTTPS only.');
      if (next.enabled && this.#certificate({ make: true }).selfSigned) throw fail(409, 'Not with a self-signed certificate: browsers would refuse the site outright instead of warning. Upload your certificate first.');
      this.#state.hsts = next;
    }
    this.#apply();
    this.#save(by);
  }

  /** The Strict-Transport-Security header for responses over HTTPS, or ''. */
  hstsHeader() {
    const { hsts, mode } = this.#state;
    if (!hsts.enabled || mode !== 'https' || this.selfSigned) return '';
    return `max-age=${hsts.maxAge}${hsts.includeSubDomains ? '; includeSubDomains' : ''}`;
  }

  recordBrowserCheck({ ok, url, by }) {
    this.#state.lastBrowserCheck = { ok: Boolean(ok), url: String(url ?? '').slice(0, 300), by, at: new Date().toISOString() };
    this.#save();
  }

  /** What the Settings page shows (no passphrase, no key). */
  async status(hosts = []) {
    const { uploaded, previous, request, ...rest } = this.#state;
    return {
      mode: rest.mode,
      startMode: startMode(this.#env),
      chosenHere: Boolean(rest.saved),
      minVersion: rest.minVersion,
      hsts: rest.hsts,
      hstsActive: Boolean(this.hstsHeader()),
      selfSignedNames: rest.selfSignedNames,
      environmentCertificate: Boolean(environmentCertificate(this.#env)),
      uploaded: uploaded ? { kind: uploaded.kind, at: uploaded.at, by: uploaded.by, subject: uploaded.subject, validTo: uploaded.validTo } : null,
      previous: previous && fs.existsSync(this.#uploadedDir('previous')) ? { subject: previous.subject, validTo: previous.validTo, at: previous.at } : null,
      request: request ? { ...request, available: fs.existsSync(path.join(this.#dir, 'request.csr')) } : null,
      lastBrowserCheck: rest.lastBrowserCheck,
      changedAt: rest.changedAt,
      changedBy: rest.changedBy,
      certificate: await this.activeReport(hosts),
    };
  }

  // --- serving ----------------------------------------------------------

  /**
   * Listen on one port for both protocols. `app` answers http and https; `httpsOnly`
   * answers plain http while the mode is 'https' (a redirect). Returns {close, closeIdleConnections}.
   */
  listen({ app, httpsOnly, port, host }, ready) {
    const plain = http.createServer((req, res) => (this.#state.mode === 'https' ? httpsOnly(req, res) : app(req, res)));
    const secure = https.createServer(this.contextOptions() ?? {}, app);
    this.#certStamp = this.#certificateStamp();
    secure.on('tlsClientError', () => {}); // a browser that does not trust the certificate yet hangs up; nothing to report
    this.#secureServers.add(secure);
    const front = net.createServer((socket) => {
      socket.on('error', () => {}); // a client that vanishes before saying anything
      socket.setTimeout(15_000, () => socket.destroy()); // until it says something; then http's own timeouts apply
      const first = () => {
        const chunk = socket.read(1);
        if (chunk === null) return socket.once('readable', first);
        socket.setTimeout(0);
        socket.unshift(chunk);
        if (chunk[0] !== 0x16) return plain.emit('connection', socket);
        if (this.#state.mode === 'http' || !this.#active) return socket.destroy();
        return secure.emit('connection', socket);
      };
      socket.once('readable', first);
    });
    front.listen(port, host, () => {
      // Starts http's own tracking of each connection (slow-client timeouts, closing idle ones).
      plain.emit('listening');
      secure.emit('listening');
      ready?.();
    });
    return {
      front,
      close: () => {
        front.close();
        plain.close();
        secure.close();
        this.#secureServers.delete(secure);
      },
      closeIdleConnections: () => {
        plain.closeIdleConnections?.();
        secure.closeIdleConnections?.();
      },
    };
  }

  /**
   * Every few seconds: a renewed certificate file (no restart needed), or https.json changed
   * by scripts/https.mjs (the way back in when the page cannot be reached).
   */
  watch({ intervalMs = 5000 } = {}) {
    this.#timer = setInterval(() => {
      try {
        if (this.#fileStamp() !== this.#stamp) {
          const before = this.#state.mode;
          this.#state = this.#read();
          this.#active = this.#resolve();
          this.#apply();
          this.#log.log?.(`[https] Settings changed outside this page: ${this.#state.mode}.`);
          if (this.#state.mode !== before) this.#notify();
          return;
        }
        if (this.#active && this.#certificateStamp() !== this.#certStamp) {
          this.#apply();
          this.#log.log?.('[https] Certificate files changed: the new certificate is in use.');
        }
      } catch (error) {
        this.#certStamp = this.#certificateStamp();
        this.#log.warn?.(`! [https] The changed certificate could not be used (still serving the previous one): ${error.message}`);
      }
    }, intervalMs);
    this.#timer.unref?.();
  }

  stop() {
    clearInterval(this.#timer);
  }

  /** For the log at start: what is served, with which certificate. */
  describe() {
    const active = this.#certificate({ make: false });
    const fingerprint = active ? createHash('sha256').update(active.files.join('|')).digest('hex').slice(0, 8) : '';
    return { mode: this.#state.mode, source: active?.source ?? 'none', selfSigned: Boolean(active?.selfSigned), fingerprint };
  }
}

/** Read the saved choices and change them, for scripts/https.mjs (the server picks it up within seconds). */
export function setModeOffline(dataDir, mode) {
  if (!MODES.includes(mode)) throw new Error(`Use one of: ${MODES.join(', ')}.`);
  const file = path.join(dataDir, 'https.json');
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  state = { ...state, mode, changedAt: new Date().toISOString(), changedBy: 'scripts/https.mjs' };
  if (mode !== 'https' && state.hsts) state.hsts = { ...state.hsts, enabled: false };
  writeAtomic(file, JSON.stringify(state, null, 2));
  return state;
}
