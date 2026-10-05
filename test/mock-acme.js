// A small ACME v2 certificate authority for tests (RFC 8555), strict where it matters:
// every request's JWS signature, nonce and url are checked; the HTTP-01 answer is really
// fetched from the server under test; the CSR's key is signed into a real certificate chain.
import http from 'node:http';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify, X509Certificate } from 'node:crypto';

import { makeCertificate } from '../src/tls.js';

const b64u = (data) => Buffer.from(data).toString('base64url');
const fromB64u = (text) => Buffer.from(String(text), 'base64url');

/** One DER element at `off`: { tag, start, end, body }. */
function tlv(buf, off) {
  let len = buf[off + 1];
  let head = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i += 1) len = len * 256 + buf[off + 2 + i];
    head = 2 + n;
  }
  return { tag: buf[off], start: off, end: off + head + len, body: buf.subarray(off + head, off + head + len) };
}
const children = (body) => {
  const out = [];
  for (let off = 0; off < body.length; ) {
    const item = tlv(body, off);
    out.push(item);
    off = item.end - item.start + off;
  }
  return out;
};

/** The public key in a PKCS#10 request (DER). */
function csrPublicKey(der) {
  const request = tlv(der, 0);
  const info = children(request.body)[0];
  const spki = children(info.body)[2];
  return createPublicKey({ key: Buffer.from(info.body.subarray(spki.start, spki.end)), format: 'der', type: 'spki' });
}

/**
 * @param {object} options
 * @param {(name: string) => string} options.challengeBase  where to fetch a name's HTTP-01 answer, e.g. "http://127.0.0.1:1234"
 * @param {boolean} [options.badNonceOnce]  answer the first signed request with badNonce (the client must retry)
 * @param {boolean} [options.failChallenge]  mark every challenge invalid
 */
export function startMockAcme({ challengeBase, badNonceOnce = false, failChallenge = false } = {}) {
  const ca = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const caSubject = { cn: 'Mock ACME Root', o: 'Tests' };
  const rootPem = makeCertificate({ subject: caSubject, publicKey: ca.publicKey, signerKey: ca.privateKey, ca: true });
  const nonces = new Set();
  const accounts = new Map(); // kid -> { jwk, key, contact }
  const orders = new Map();
  const authzs = new Map();
  const challenges = new Map();
  const log = { requests: [], validations: [] };
  let base = '';
  let firstSigned = badNonceOnce;

  const newNonce = () => {
    const n = b64u(randomBytes(16));
    nonces.add(n);
    return n;
  };
  const send = (res, status, body, headers = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Replay-Nonce': newNonce(), 'Content-Type': typeof body === 'string' ? 'application/pem-certificate-chain' : 'application/json', ...headers });
    res.end(text);
  };
  const problem = (res, status, type, detail) => send(res, status, { type: `urn:ietf:params:acme:error:${type}`, detail }, { 'Content-Type': 'application/problem+json' });

  /** Check a JWS POST: signature, nonce, url. Returns { payload, kid, jwk } or answers with a problem. */
  function signed(req, res, raw, { allowJwk = false } = {}) {
    let jws;
    try {
      jws = JSON.parse(raw);
    } catch {
      problem(res, 400, 'malformed', 'Not JSON.');
      return null;
    }
    const header = JSON.parse(fromB64u(jws.protected).toString('utf8'));
    if (header.alg !== 'ES256') return problem(res, 400, 'badSignatureAlgorithm', 'ES256 only.'), null;
    if (firstSigned) {
      firstSigned = false;
      nonces.delete(header.nonce);
      return problem(res, 400, 'badNonce', 'Stale nonce (on purpose).'), null;
    }
    if (!nonces.delete(header.nonce)) return problem(res, 400, 'badNonce', 'Unknown or used nonce.'), null;
    if (header.url !== `${base}${req.url}`) return problem(res, 401, 'unauthorized', `url ${header.url} is not ${base}${req.url}.`), null;
    let key;
    let kid = '';
    if (header.jwk) {
      if (!allowJwk) return problem(res, 400, 'malformed', 'Use kid.'), null;
      key = createPublicKey({ key: header.jwk, format: 'jwk' });
    } else {
      kid = header.kid;
      const account = accounts.get(kid);
      if (!account) return problem(res, 400, 'accountDoesNotExist', 'No such account.'), null;
      key = account.key;
    }
    const ok = verify('sha256', Buffer.from(`${jws.protected}.${jws.payload}`), { key, dsaEncoding: 'ieee-p1363' }, fromB64u(jws.signature));
    if (!ok) return problem(res, 400, 'malformed', 'Bad signature.'), null;
    const payload = jws.payload === '' ? '' : JSON.parse(fromB64u(jws.payload).toString('utf8'));
    return { payload, kid, jwk: header.jwk };
  }

  const thumbprint = (jwk) => b64u(createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest());

  async function validate(challenge) {
    const authz = authzs.get(challenge.authz);
    const account = accounts.get(challenge.kid);
    const expected = `${challenge.token}.${thumbprint(account.jwk)}`;
    const url = `${challengeBase(authz.identifier.value)}/.well-known/acme-challenge/${challenge.token}`;
    let got = '';
    try {
      const r = await fetch(url, { redirect: 'manual' });
      got = r.ok ? (await r.text()).trim() : `HTTP ${r.status}`;
    } catch (error) {
      got = `error ${error.message}`;
    }
    log.validations.push({ name: authz.identifier.value, url, ok: got === expected });
    if (got === expected && !failChallenge) {
      challenge.status = 'valid';
      authz.status = 'valid';
    } else {
      challenge.status = 'invalid';
      challenge.error = { type: 'urn:ietf:params:acme:error:unauthorized', detail: `Invalid response from ${url}: ${failChallenge ? 'refused (on purpose)' : got.slice(0, 80)}` };
      authz.status = 'invalid';
    }
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      log.requests.push(`${req.method} ${req.url}`);
      const url = req.url;
      if (url === '/directory') return send(res, 200, { newNonce: `${base}/new-nonce`, newAccount: `${base}/new-account`, newOrder: `${base}/new-order`, meta: { termsOfService: `${base}/terms` } });
      if (url === '/new-nonce') return send(res, req.method === 'HEAD' ? 200 : 204, '', { 'Content-Type': 'text/plain' });
      if (req.method !== 'POST') return problem(res, 405, 'malformed', 'POST only.');
      if (url === '/new-account') {
        const s = signed(req, res, raw, { allowJwk: true });
        if (!s) return;
        if (s.payload.termsOfServiceAgreed !== true) return problem(res, 403, 'userActionRequired', 'Agree to the terms.');
        const existing = [...accounts.entries()].find(([, a]) => thumbprint(a.jwk) === thumbprint(s.jwk));
        const kid = existing?.[0] ?? `${base}/acct/${accounts.size + 1}`;
        if (!existing) accounts.set(kid, { jwk: s.jwk, key: createPublicKey({ key: s.jwk, format: 'jwk' }), contact: s.payload.contact ?? [] });
        return send(res, existing ? 200 : 201, { status: 'valid', contact: accounts.get(kid).contact }, { Location: kid });
      }
      const s = signed(req, res, raw);
      if (!s) return;
      if (url === '/new-order') {
        const id = String(orders.size + 1);
        const authorizations = s.payload.identifiers.map((identifier) => {
          const aid = `${id}-${authzs.size + 1}`;
          const token = b64u(randomBytes(24));
          challenges.set(aid, { url: `${base}/chall/${aid}`, type: 'http-01', token, status: 'pending', authz: aid, kid: s.kid });
          authzs.set(aid, { identifier, status: 'pending', challenge: aid });
          return `${base}/authz/${aid}`;
        });
        orders.set(id, { status: 'pending', identifiers: s.payload.identifiers, authorizations, finalize: `${base}/finalize/${id}`, kid: s.kid });
        return send(res, 201, orders.get(id), { Location: `${base}/order/${id}` });
      }
      let m;
      if ((m = url.match(/^\/authz\/(.+)$/))) {
        const a = authzs.get(m[1]);
        const c = challenges.get(a.challenge);
        return send(res, 200, { identifier: a.identifier, status: a.status, challenges: [{ type: 'dns-01', url: `${base}/chall/dns`, token: 'x', status: 'pending' }, { type: c.type, url: c.url, token: c.token, status: c.status, ...(c.error ? { error: c.error } : {}) }] });
      }
      if ((m = url.match(/^\/chall\/(.+)$/))) {
        const c = challenges.get(m[1]);
        if (c.status === 'pending') {
          c.status = 'processing';
          setTimeout(() => validate(c), 20);
        }
        return send(res, 200, { type: c.type, url: c.url, token: c.token, status: c.status });
      }
      if ((m = url.match(/^\/order\/(.+)$/))) {
        const o = orders.get(m[1]);
        if (o.status === 'pending' && o.authorizations.every((u) => authzs.get(u.split('/authz/')[1]).status === 'valid')) o.status = 'ready';
        if (o.status === 'pending' && o.authorizations.some((u) => authzs.get(u.split('/authz/')[1]).status === 'invalid')) o.status = 'invalid';
        return send(res, 200, o);
      }
      if ((m = url.match(/^\/finalize\/(.+)$/))) {
        const o = orders.get(m[1]);
        if (o.status !== 'ready') return problem(res, 403, 'orderNotReady', `Order is ${o.status}.`);
        const publicKey = csrPublicKey(fromB64u(s.payload.csr));
        const names = o.identifiers.map((i) => i.value);
        const leaf = makeCertificate({ subject: { cn: names[0] }, issuer: caSubject, names, publicKey, signerKey: ca.privateKey, days: 90 });
        o.status = 'valid';
        o.certificate = `${base}/cert/${m[1]}`;
        o.chain = `${leaf}${rootPem}`;
        return send(res, 200, o);
      }
      if ((m = url.match(/^\/cert\/(.+)$/))) return send(res, 200, orders.get(m[1]).chain);
      return problem(res, 404, 'malformed', 'Not found.');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({ url: `${base}/directory`, rootPem, log, accounts, close: () => new Promise((r) => server.close(r)), issuedFor: (pem) => new X509Certificate(pem).issuer });
    });
  });
}
