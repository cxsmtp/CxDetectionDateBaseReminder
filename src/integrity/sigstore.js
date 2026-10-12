/**
 * Checks one GitHub build attestation (a Sigstore bundle) with Node.js alone, no library:
 *
 *  1. the signing certificate was issued by Sigstore's certificate authority (the trust root kept in
 *     trusted-root.json) and was valid when the signature was logged;
 *  2. it names the release workflow of this repository, run by GitHub Actions, on main or a version tag;
 *  3. the signature over the attestation is good;
 *  4. the attestation is about these exact bytes (its subject's SHA-256);
 *  5. Sigstore's public transparency log recorded it (its signed timestamp, or its inclusion proof and
 *     signed checkpoint), and that record is of this signature and this certificate.
 *
 * Returns {ok: true, signedAt, repository, ref, commit, workflow, run} or {ok: false, reason}.
 */
import { X509Certificate, createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

const ISSUER = 'https://token.actions.githubusercontent.com';
const OID = {
  issuerV1: '1.3.6.1.4.1.57264.1.1',
  issuerV2: '1.3.6.1.4.1.57264.1.8',
  buildSignerUri: '1.3.6.1.4.1.57264.1.9',
  sourceRepositoryUri: '1.3.6.1.4.1.57264.1.12',
  sourceRepositoryDigest: '1.3.6.1.4.1.57264.1.13',
  sourceRepositoryRef: '1.3.6.1.4.1.57264.1.14',
  runInvocationUri: '1.3.6.1.4.1.57264.1.21',
};

const b64 = (s) => Buffer.from(String(s ?? ''), 'base64');
const sha256 = (data) => createHash('sha256').update(data).digest();
const fail = (reason) => ({ ok: false, reason });

// ---- A little DER, enough to read a certificate's extensions ------------------------------------

function tlv(buf, offset) {
  if (offset + 2 > buf.length) throw new Error('truncated');
  const tag = buf[offset];
  let len = buf[offset + 1];
  let start = offset + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4 || start + n > buf.length) throw new Error('bad length');
    len = 0;
    for (let i = 0; i < n; i += 1) len = len * 256 + buf[start + i];
    start += n;
  }
  const end = start + len;
  if (end > buf.length) throw new Error('truncated');
  return { tag, start, end };
}

function children(buf, { start, end }) {
  const out = [];
  for (let at = start; at < end; ) {
    const item = tlv(buf, at);
    out.push(item);
    at = item.end;
  }
  return out;
}

function oidText(bytes) {
  const parts = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let value = 0;
  for (let i = 1; i < bytes.length; i += 1) {
    value = value * 128 + (bytes[i] & 0x7f);
    if (!(bytes[i] & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join('.');
}

/** A certificate's extensions: Map(OID → the extension's value bytes). */
export function certificateExtensions(der) {
  const out = new Map();
  const cert = tlv(der, 0);
  const tbs = children(der, cert)[0];
  for (const field of children(der, tbs)) {
    if (field.tag !== 0xa3) continue; // [3] extensions
    const list = children(der, field)[0];
    for (const ext of children(der, list)) {
      const parts = children(der, ext);
      const oid = oidText(der.subarray(parts[0].start, parts[0].end));
      const value = parts[parts.length - 1];
      out.set(oid, der.subarray(value.start, value.end));
    }
  }
  return out;
}

/** Fulcio writes its newer extensions as a DER UTF8String and the oldest ones as raw text. */
function extensionText(value) {
  if (!value) return '';
  if (value[0] === 0x0c) {
    try {
      const s = tlv(value, 0);
      return value.subarray(s.start, s.end).toString('utf8');
    } catch {}
  }
  return value.toString('utf8');
}

// ---- Pieces of the check ------------------------------------------------------------------------

/** DSSE's pre-authentication encoding: what the signature is over. */
export function pae(payloadType, payload) {
  const type = Buffer.from(payloadType, 'utf8');
  return Buffer.concat([Buffer.from(`DSSEv1 ${type.length} `), type, Buffer.from(` ${payload.length} `), payload]);
}

function keyOf(rawBytesB64) {
  return createPublicKey({ key: b64(rawBytesB64), format: 'der', type: 'spki' });
}

const verifyWith = (key, data, signature) => {
  try {
    return verifySignature(key.asymmetricKeyType === 'ed25519' ? null : 'sha256', data, key, signature);
  } catch {
    return false;
  }
};

/** The certificate authority in the trust root that issued `leaf`, checked link by link to its root. */
function chainToTrustRoot(leaf, signedAt, trustedRoot) {
  for (const ca of trustedRoot.certificateAuthorities ?? []) {
    const from = Date.parse(ca.validFor?.start ?? 0);
    const to = ca.validFor?.end ? Date.parse(ca.validFor.end) : Infinity;
    if (!(signedAt >= from && signedAt <= to)) continue;
    const chain = (ca.certChain?.certificates ?? []).map((c) => new X509Certificate(b64(c.rawBytes)));
    if (!chain.length || !leaf.checkIssued(chain[0]) || !leaf.verify(chain[0].publicKey)) continue;
    let linked = true;
    for (let i = 0; i < chain.length; i += 1) {
      const issuer = chain[i + 1] ?? chain[i]; // the last is the root, signed by itself
      if (!chain[i].checkIssued(issuer) || !chain[i].verify(issuer.publicKey)) linked = false;
    }
    if (linked) return true;
  }
  return false;
}

/** RFC 9162: the root a leaf's inclusion proof leads to. */
export function rootFromInclusionProof(index, size, leafHash, proof) {
  let fn = BigInt(index);
  let sn = BigInt(size) - 1n;
  if (fn > sn) return null;
  let r = leafHash;
  for (const p of proof) {
    if (sn === 0n) return null;
    if ((fn & 1n) === 1n || fn === sn) {
      r = sha256(Buffer.concat([Buffer.from([1]), p, r]));
      if ((fn & 1n) === 0n) {
        while (!((fn & 1n) === 1n || fn === 0n)) {
          fn >>= 1n;
          sn >>= 1n;
        }
      }
    } else {
      r = sha256(Buffer.concat([Buffer.from([1]), r, p]));
    }
    fn >>= 1n;
    sn >>= 1n;
  }
  return sn === 0n ? r : null;
}

/** A signed checkpoint (a signed note): its root hash when one of its signatures is the log's. */
function checkpointRoot(envelope, key) {
  const split = envelope.indexOf('\n\n');
  if (split < 0) return null;
  const body = envelope.slice(0, split + 1);
  const lines = body.split('\n');
  const root = b64(lines[2]);
  for (const line of envelope.slice(split + 2).split('\n')) {
    const m = /^— (\S+) (\S+)$/.exec(line);
    if (!m) continue;
    const sig = b64(m[2]).subarray(4); // a 4-byte key hint first
    if (verifyWith(key, Buffer.from(body, 'utf8'), sig)) return root;
  }
  return null;
}

/** Every string anywhere in a JSON value. */
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
}

/** The log entry is this signature's: it carries the payload's hash and the signing certificate. */
function entryIsOurs(bodyBytes, payload, leafDer) {
  let body;
  try {
    body = JSON.parse(bodyBytes.toString('utf8'));
  } catch {
    return false;
  }
  const hash = sha256(payload);
  const all = strings(body);
  const hashed = all.some((s) => s === hash.toString('hex') || s === hash.toString('base64'));
  const certB64 = leafDer.toString('base64');
  const certified = all.some((s) => {
    if (s === certB64) return true;
    const text = b64(s).toString('utf8');
    return text.includes('BEGIN CERTIFICATE') && text.replace(/-----[^-]+-----|\s/g, '') === certB64;
  });
  return hashed && certified;
}

function logged(entry, payload, leafDer, trustedRoot) {
  const keyId = entry.logId?.keyId;
  const log = (trustedRoot.tlogs ?? []).find((t) => t.logId?.keyId === keyId);
  if (!log) return 'the transparency log that recorded it is not one this server trusts';
  const key = keyOf(log.publicKey.rawBytes);
  const body = b64(entry.canonicalizedBody);
  if (!entryIsOurs(body, payload, leafDer)) return 'the transparency log record is not of this signature';
  const set = entry.inclusionPromise?.signedEntryTimestamp;
  if (set) {
    const signed = JSON.stringify({ body: entry.canonicalizedBody, integratedTime: Number(entry.integratedTime), logID: b64(keyId).toString('hex'), logIndex: Number(entry.logIndex) });
    if (verifyWith(key, Buffer.from(signed), b64(set))) return '';
  }
  const proof = entry.inclusionProof;
  if (proof?.checkpoint?.envelope) {
    const root = rootFromInclusionProof(proof.logIndex, proof.treeSize, sha256(Buffer.concat([Buffer.from([0]), body])), (proof.hashes ?? []).map(b64));
    const signedRoot = checkpointRoot(proof.checkpoint.envelope, key);
    if (root && signedRoot && root.equals(signedRoot) && root.equals(b64(proof.rootHash))) return '';
  }
  return 'the transparency log did not confirm it';
}

// ---- The whole check ----------------------------------------------------------------------------

/**
 * @param bundle       a Sigstore bundle (as GitHub's attestations API returns it)
 * @param digest       the SHA-256 (hex) of the file it must be about
 * @param repository   "owner/name" of the repository whose workflow must have signed it
 * @param workflow     that workflow's path in the repository
 * @param refs         which git refs may have built it
 */
export function verifyBundle(bundle, { digest, trustedRoot, repository, workflow = '.github/workflows/container.yml', refs = /^refs\/(heads\/(main|master)|tags\/v[\w.-]+)$/ }) {
  try {
    if (!String(bundle?.mediaType ?? '').startsWith('application/vnd.dev.sigstore.bundle')) return fail('not a Sigstore bundle');
    const material = bundle.verificationMaterial ?? {};
    const certB64 = material.certificate?.rawBytes ?? material.x509CertificateChain?.certificates?.[0]?.rawBytes;
    if (!certB64) return fail('no signing certificate');
    const leafDer = b64(certB64);
    const leaf = new X509Certificate(leafDer);
    const entry = material.tlogEntries?.[0];
    const signedAt = Number(entry?.integratedTime) * 1000;
    if (!entry || !Number.isFinite(signedAt) || signedAt <= 0) return fail('no transparency log time');

    // 1. Issued by Sigstore, valid when it was used.
    if (!chainToTrustRoot(leaf, signedAt, trustedRoot)) return fail('the signing certificate was not issued by Sigstore');
    if (signedAt < Date.parse(leaf.validFrom) || signedAt > Date.parse(leaf.validTo)) return fail('the signing certificate was not valid when it was used');

    // 2. Who signed: this repository's release workflow on GitHub Actions.
    const ext = certificateExtensions(leafDer);
    const issuer = extensionText(ext.get(OID.issuerV2)) || extensionText(ext.get(OID.issuerV1));
    if (issuer !== ISSUER) return fail('not signed by GitHub Actions');
    const repoUri = extensionText(ext.get(OID.sourceRepositoryUri));
    const wanted = `https://github.com/${repository}`;
    if (repoUri.toLowerCase() !== wanted.toLowerCase()) return fail(`built from ${repoUri || 'another repository'}, not ${wanted}`);
    const ref = extensionText(ext.get(OID.sourceRepositoryRef));
    const signer = extensionText(ext.get(OID.buildSignerUri)) || String(leaf.subjectAltName ?? '').replace(/^URI:/, '');
    if (!signer.toLowerCase().startsWith(`${wanted}/${workflow}@`.toLowerCase())) return fail(`signed by ${signer || 'an unknown workflow'}, not ${workflow}`);
    if (!refs.test(ref)) return fail(`built from ${ref || 'an unknown ref'}, not main or a version tag`);

    // 3. The signature.
    const envelope = bundle.dsseEnvelope;
    if (!envelope?.payload || !envelope.signatures?.length) return fail('no signed attestation');
    const payload = b64(envelope.payload);
    const signed = envelope.signatures.some((s) => verifyWith(leaf.publicKey, pae(envelope.payloadType, payload), b64(s.sig)));
    if (!signed) return fail('the signature does not match');

    // 4. About these bytes.
    const statement = JSON.parse(payload.toString('utf8'));
    if (!(statement.subject ?? []).some((s) => s?.digest?.sha256 === digest)) return fail('the attestation is about other files');

    // 5. In the public log.
    const notLogged = logged(entry, payload, leafDer, trustedRoot);
    if (notLogged) return fail(notLogged);

    return {
      ok: true,
      signedAt: new Date(signedAt).toISOString(),
      repository: repoUri.replace('https://github.com/', ''),
      ref,
      commit: extensionText(ext.get(OID.sourceRepositoryDigest)),
      workflow: signer,
      run: extensionText(ext.get(OID.runInvocationUri)),
      logIndex: Number(entry.logIndex),
    };
  } catch (error) {
    return fail(`the attestation could not be read (${error.message})`);
  }
}
