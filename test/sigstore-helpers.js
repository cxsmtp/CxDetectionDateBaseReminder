// Test-only: a Sigstore-like world in memory — a certificate authority, a GitHub Actions signing
// certificate with Fulcio's extensions, a transparency log key — and bundles made with them, so the
// verifier can be checked against good and tampered attestations without any real key.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';

const len = (n) => (n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]));
const der = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...p) => der(0x30, ...p);
const set = (...p) => der(0x31, ...p);
const int = (n) => der(0x02, Buffer.from([n]));
const utf8 = (s) => der(0x0c, Buffer.from(s));
const octet = (b) => der(0x04, b);
const bool = () => der(0x01, Buffer.from([0xff]));
const time = (d) => der(0x17, Buffer.from(`${d.toISOString().slice(2, 19).replace(/[-:T]/g, '')}Z`));
function oid(text) {
  const p = text.split('.').map(Number);
  const out = [p[0] * 40 + p[1]];
  for (const v of p.slice(2)) {
    const bytes = [v & 0x7f];
    for (let x = Math.floor(v / 128); x > 0; x = Math.floor(x / 128)) bytes.unshift((x & 0x7f) | 0x80);
    out.push(...bytes);
  }
  return der(0x06, Buffer.from(out));
}
const name = (cn) => seq(set(seq(oid('2.5.4.3'), utf8(cn))));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
const ext = (id, value, critical = false) => seq(oid(id), ...(critical ? [bool()] : []), octet(value));

export function makeCert({ subject, issuer, publicKey, signKey, serial, notBefore, notAfter, ca = false, extensions = [] }) {
  const exts = [ext('2.5.29.19', ca ? seq(bool()) : seq(), true), ...extensions];
  const tbs = seq(der(0xa0, int(2)), int(serial), ECDSA_SHA256, name(issuer), seq(time(notBefore), time(notAfter)), name(subject), publicKey.export({ type: 'spki', format: 'der' }), der(0xa3, seq(...exts)));
  return seq(tbs, ECDSA_SHA256, der(0x03, Buffer.from([0]), sign('sha256', tbs, signKey)));
}

export const ACTIONS = 'https://token.actions.githubusercontent.com';
const ec = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

/** A world: trust root (root + intermediate CA, one log), and a leaf for `repository` at `ref`. */
export function makeWorld({ repository = 'acme/mission', ref = 'refs/heads/main', workflow = '.github/workflows/container.yml', issuer = ACTIONS, now = Date.now(), validMs = 10 * 60_000 } = {}) {
  const root = ec();
  const intermediate = ec();
  const leaf = ec();
  const log = ec();
  const year = 365 * 86_400_000;
  const rootDer = makeCert({ subject: 'test root', issuer: 'test root', publicKey: root.publicKey, signKey: root.privateKey, serial: 1, notBefore: new Date(now - year), notAfter: new Date(now + year), ca: true });
  const interDer = makeCert({ subject: 'test intermediate', issuer: 'test root', publicKey: intermediate.publicKey, signKey: root.privateKey, serial: 2, notBefore: new Date(now - year), notAfter: new Date(now + year), ca: true });
  const signer = `https://github.com/${repository}/${workflow}@${ref}`;
  const leafDer = makeCert({
    subject: '',
    issuer: 'test intermediate',
    publicKey: leaf.publicKey,
    signKey: intermediate.privateKey,
    serial: 3,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now - 60_000 + validMs),
    extensions: [
      ext('2.5.29.17', seq(der(0x86, Buffer.from(signer))), true),
      ext('1.3.6.1.4.1.57264.1.1', Buffer.from(issuer)),
      ext('1.3.6.1.4.1.57264.1.8', utf8(issuer)),
      ext('1.3.6.1.4.1.57264.1.9', utf8(signer)),
      ext('1.3.6.1.4.1.57264.1.12', utf8(`https://github.com/${repository}`)),
      ext('1.3.6.1.4.1.57264.1.13', utf8('0123456789abcdef0123456789abcdef01234567')),
      ext('1.3.6.1.4.1.57264.1.14', utf8(ref)),
      ext('1.3.6.1.4.1.57264.1.21', utf8(`https://github.com/${repository}/actions/runs/1/attempts/1`)),
    ],
  });
  const logKeyDer = log.publicKey.export({ type: 'spki', format: 'der' });
  const keyId = createHash('sha256').update(logKeyDer).digest().toString('base64');
  const trustedRoot = {
    certificateAuthorities: [{ certChain: { certificates: [{ rawBytes: interDer.toString('base64') }, { rawBytes: rootDer.toString('base64') }] }, validFor: { start: new Date(now - year).toISOString() } }],
    tlogs: [{ baseUrl: 'https://log.test', publicKey: { rawBytes: logKeyDer.toString('base64'), keyDetails: 'PKIX_ECDSA_P256_SHA_256' }, logId: { keyId } }],
  };
  return { trustedRoot, leafDer, leafKey: leaf.privateKey, logKey: log.privateKey, keyId, now, repository };
}

const pae = (type, payload) => Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(type)} ${type} ${payload.length} `), payload]);

/**
 * A bundle about `digest`, signed with the world's leaf and logged in its log, either with a signed
 * entry timestamp (`proof: 'set'`) or an inclusion proof and signed checkpoint (`proof: 'checkpoint'`).
 */
export function makeBundle(world, digest, { proof = 'set', signKey = world.leafKey, integratedTime = Math.floor(world.now / 1000), tamper = {} } = {}) {
  const statement = { _type: 'https://in-toto.io/Statement/v1', subject: [{ name: 'integrity.json', digest: { sha256: digest } }], predicateType: 'https://slsa.dev/provenance/v1', predicate: {} };
  const payload = Buffer.from(JSON.stringify(statement));
  const type = 'application/vnd.in-toto+json';
  const sig = sign('sha256', pae(type, payload), signKey);
  const signedPayload = tamper.payload ? Buffer.from(JSON.stringify({ ...statement, subject: [{ name: 'x', digest: { sha256: tamper.payload } }] })) : payload;
  const pem = `-----BEGIN CERTIFICATE-----\n${world.leafDer.toString('base64').replace(/.{64}/g, '$&\n')}\n-----END CERTIFICATE-----\n`;
  const body = {
    apiVersion: '0.0.1',
    kind: 'dsse',
    spec: {
      payloadHash: { algorithm: 'sha256', value: createHash('sha256').update(tamper.loggedPayload ?? payload).digest('hex') },
      signatures: [{ signature: sig.toString('base64'), verifier: Buffer.from(pem).toString('base64') }],
    },
  };
  const canonicalizedBody = Buffer.from(JSON.stringify(body)).toString('base64');
  const entry = { logIndex: '7', logId: { keyId: world.keyId }, kindVersion: { kind: 'dsse', version: '0.0.1' }, integratedTime: String(integratedTime), canonicalizedBody };
  if (proof === 'set') {
    const signed = JSON.stringify({ body: canonicalizedBody, integratedTime, logID: Buffer.from(world.keyId, 'base64').toString('hex'), logIndex: 7 });
    entry.inclusionPromise = { signedEntryTimestamp: sign('sha256', Buffer.from(signed), tamper.logKey ?? world.logKey).toString('base64') };
  } else {
    // A tree of two leaves: ours (index 0) and another; the proof is the other leaf's hash.
    const h = (...b) => createHash('sha256').update(Buffer.concat(b)).digest();
    const ours = h(Buffer.from([0]), Buffer.from(canonicalizedBody, 'base64'));
    const other = h(Buffer.from([0]), Buffer.from('another entry'));
    const root = h(Buffer.from([1]), ours, other);
    const note = `log.test\n2\n${root.toString('base64')}\n`;
    const noteSig = Buffer.concat([Buffer.alloc(4), sign('sha256', Buffer.from(note), tamper.logKey ?? world.logKey)]);
    entry.inclusionProof = { logIndex: '0', rootHash: root.toString('base64'), treeSize: '2', hashes: [other.toString('base64')], checkpoint: { envelope: `${note}\n— log.test ${noteSig.toString('base64')}\n` } };
  }
  return {
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    verificationMaterial: { certificate: { rawBytes: world.leafDer.toString('base64') }, tlogEntries: [entry] },
    dsseEnvelope: { payload: signedPayload.toString('base64'), payloadType: type, signatures: [{ sig: sig.toString('base64') }] },
  };
}
