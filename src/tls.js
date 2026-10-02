/**
 * HTTPS served by CxMissionZero itself, when there is no reverse proxy in front.
 *
 * Certificates, in order of preference:
 *   1. TLS_CERT_FILE + TLS_KEY_FILE (PEM; the certificate file may carry the chain),
 *      with TLS_KEY_PASSPHRASE when the key is encrypted;
 *   2. TLS_PFX_FILE (+ TLS_PFX_PASSPHRASE): a .pfx / .p12 export, as Windows and
 *      many company CAs hand them out;
 *   3. TLS_SELF_SIGNED=1: a certificate made here and kept in DATA_DIR/tls, for
 *      trying it out or a closed network. Browsers warn about it until it is trusted.
 *
 * HTTPS (the switch): `on` = always HTTPS, with 1 or 2 when given, else 3 (the
 * container image's default, so a production release never serves plain http by
 * accident); `off` = plain http (a laptop, or behind a reverse proxy that does
 * HTTPS); unset = HTTPS only when a certificate option above is given.
 *
 * Certificate files are re-read when they change (a renewal), without a restart.
 */

import { createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { createSecureContext } from 'node:tls';
import path from 'node:path';

const readFile = (file) => fs.readFileSync(file);

/** null when HTTPS is not configured; otherwise what https.createServer needs, plus how to reload it. */
export function tlsConfig(env = process.env, dataDir = '') {
  const mode = String(env.HTTPS ?? '').trim().toLowerCase();
  if (/^(off|false|no|0)$/.test(mode)) return null;
  if (mode && !/^(on|true|yes|1)$/.test(mode)) throw new Error(`HTTPS must be on or off, not "${env.HTTPS}".`);
  const certFile = env.TLS_CERT_FILE?.trim();
  const keyFile = env.TLS_KEY_FILE?.trim();
  const pfxFile = env.TLS_PFX_FILE?.trim();
  let files;
  let load;
  if (certFile || keyFile) {
    if (!certFile || !keyFile) throw new Error('HTTPS needs both TLS_CERT_FILE and TLS_KEY_FILE.');
    files = [certFile, keyFile];
    load = () => ({ cert: readFile(certFile), key: readFile(keyFile), passphrase: env.TLS_KEY_PASSPHRASE || undefined });
  } else if (pfxFile) {
    files = [pfxFile];
    load = () => ({ pfx: readFile(pfxFile), passphrase: env.TLS_PFX_PASSPHRASE || undefined });
  } else if (mode || /^(1|true|yes|on)$/i.test(env.TLS_SELF_SIGNED ?? '')) {
    const names = selfSignedNames(env);
    const { cert, key } = ensureSelfSigned(path.join(dataDir || '.', 'tls'), names);
    files = [cert, key];
    load = () => ({ cert: readFile(cert), key: readFile(key) });
  } else {
    return null;
  }
  const options = { ...load(), minVersion: 'TLSv1.2' };
  describeCertificate(options); // fails early, with a readable reason, on a wrong file or passphrase
  return { options, files, load: () => ({ ...load(), minVersion: 'TLSv1.2' }), selfSigned: !certFile && !keyFile && !pfxFile };
}

/** "CN=mz.acme.io, valid until 2027-05-01 (DNS:mz.acme.io)" for the log. */
export function describeCertificate(options) {
  if (options.pfx) {
    try {
      createSecureContext({ pfx: options.pfx, passphrase: options.passphrase });
    } catch (error) {
      throw new Error(/mac verify|password|passphrase/i.test(error.message) ? 'The .pfx file did not open: wrong TLS_PFX_PASSPHRASE?' : `The .pfx file could not be used: ${error.message}`);
    }
    return 'the .pfx certificate';
  }
  const pem = String(options.cert).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
  if (!pem) throw new Error('The certificate file has no PEM certificate in it.');
  const cert = new X509Certificate(pem);
  // The key must open (passphrase) and belong to the certificate.
  const key = createPrivateKey({ key: options.key, passphrase: options.passphrase });
  if (!cert.checkPrivateKey(key)) throw new Error('The private key does not belong to the certificate.');
  return `${cert.subject.replace(/\n/g, ', ')}, valid until ${new Date(cert.validTo).toISOString().slice(0, 10)}${cert.subjectAltName ? ` (${cert.subjectAltName})` : ''}`;
}

/**
 * Re-read the certificate when its files change (checked every few minutes), so
 * a renewed certificate is served without restarting. Returns stop().
 */
export function watchCertificate(server, tls, { intervalMs = 5 * 60 * 1000, log = console } = {}) {
  const stamp = () => tls.files.map((file) => fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0).join('|');
  let seen = stamp();
  const timer = setInterval(() => {
    const now = stamp();
    if (now === seen) return;
    seen = now;
    try {
      const options = tls.load();
      describeCertificate(options);
      server.setSecureContext(options);
      log.log(`[https] Certificate reloaded: ${describeCertificate(options)}`);
    } catch (error) {
      log.warn(`! [https] The changed certificate could not be used (still serving the previous one): ${error.message}`);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// Self-signed certificate, made with node:crypto alone (no openssl needed)
// ---------------------------------------------------------------------------

function selfSignedNames(env) {
  const names = new Set(['localhost', '127.0.0.1', os.hostname()]);
  for (const name of String(env.TLS_HOSTNAMES ?? '').split(',')) if (name.trim()) names.add(name.trim().toLowerCase());
  try {
    if (env.REPORT_SERVER_URL) names.add(new URL(env.REPORT_SERVER_URL).hostname.toLowerCase());
  } catch {}
  return [...names].filter(Boolean).sort();
}

/** The self-signed certificate in `dir`, made (again) when missing, expiring or for other names. */
export function ensureSelfSigned(dir, names, now = Date.now()) {
  const cert = path.join(dir, 'self-signed.crt');
  const key = path.join(dir, 'self-signed.key');
  try {
    const existing = new X509Certificate(fs.readFileSync(cert));
    const have = new Set((existing.subjectAltName ?? '').toLowerCase().split(', '));
    const covered = names.every((n) => have.has(isIp(n) ? `ip address:${ipText(n)}` : `dns:${n}`));
    if (covered && Date.parse(existing.validTo) - now > 30 * 86_400_000 && fs.existsSync(key)) return { cert, key };
  } catch {}
  const made = selfSignedCertificate(names, now);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(key, made.key, { mode: 0o600 });
  fs.writeFileSync(cert, made.cert, { mode: 0o644 });
  return { cert, key };
}

const isIp = (name) => /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.includes(':');

/** A self-signed ECDSA P-256 certificate for `names` (DNS names and IP addresses), valid for 397 days. */
export function selfSignedCertificate(names, now = Date.now()) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const cn = names.find((n) => !isIp(n)) ?? 'localhost';
  const name = seq(set(seq(oid('2.5.4.3'), utf8(cn))), set(seq(oid('2.5.4.10'), utf8('CxMissionZero (self-signed)'))));
  const ecdsaSha256 = seq(oid('1.2.840.10045.4.3.2'));
  const san = seq(
    ...names.map((n) => (isIp(n) ? tagged(0x87, ipBytes(n)) : tagged(0x82, Buffer.from(n, 'ascii')))),
  );
  const extensions = seq(
    seq(oid('2.5.29.17'), octets(san)), // subjectAltName
    seq(oid('2.5.29.19'), bool(true), octets(seq())), // basicConstraints: not a CA
    seq(oid('2.5.29.15'), bool(true), octets(bitString(Buffer.from([0x80]), 7))), // keyUsage: digitalSignature
    seq(oid('2.5.29.37'), octets(seq(oid('1.3.6.1.5.5.7.3.1')))), // extKeyUsage: serverAuth
  );
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) || 1; // positive, and no leading zero byte (DER is strict about both)
  const tbs = seq(
    tagged(0xa0, integer(Buffer.from([2]))), // v3
    integer(serial),
    ecdsaSha256,
    name,
    seq(time(now - 60_000), time(now + 397 * 86_400_000)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    tagged(0xa3, extensions),
  );
  const signature = sign('sha256', tbs, privateKey); // DER-encoded ECDSA signature
  const der = seq(tbs, ecdsaSha256, bitString(signature));
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { cert: pem, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

// Minimal DER encoding: just what a certificate needs.
function length(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tagged = (tag, body) => Buffer.concat([Buffer.from([tag]), length(body.length), body]);
const seq = (...items) => tagged(0x30, Buffer.concat(items));
const set = (...items) => tagged(0x31, Buffer.concat(items));
const octets = (body) => tagged(0x04, body);
const utf8 = (text) => tagged(0x0c, Buffer.from(text, 'utf8'));
const bool = (value) => tagged(0x01, Buffer.from([value ? 0xff : 0]));
const bitString = (body, unused = 0) => tagged(0x03, Buffer.concat([Buffer.from([unused]), body]));
function integer(bytes) {
  const body = bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes;
  return tagged(0x02, body);
}
function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    for (let v = part >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tagged(0x06, Buffer.from(bytes));
}
function time(ms) {
  const iso = new Date(ms).toISOString();
  const year = Number(iso.slice(0, 4));
  const compact = iso.replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  return year < 2050 ? tagged(0x17, Buffer.from(`${compact.slice(2)}Z`)) : tagged(0x18, Buffer.from(`${compact}Z`));
}
/** An IP address as certificates print it (IPv6 in full, without leading zeros). */
function ipText(ip) {
  if (!ip.includes(':')) return ip;
  const bytes = ipBytes(ip);
  return Array.from({ length: 8 }, (_, i) => ((bytes[2 * i] << 8) | bytes[2 * i + 1]).toString(16)).join(':');
}
function ipBytes(ip) {
  if (!ip.includes(':')) return Buffer.from(ip.split('.').map(Number));
  const [head, tail = ''] = ip.split('::');
  const groups = (part) => (part ? part.split(':') : []);
  const h = groups(head);
  const t = groups(tail);
  const all = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return Buffer.from(all.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 0xff]));
}
