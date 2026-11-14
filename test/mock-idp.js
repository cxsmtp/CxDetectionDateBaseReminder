// A stand-in identity provider for the single sign-on tests: a local http server with the four
// addresses an OpenID Connect provider has (discovery, keys, token, userinfo), signing ID tokens
// with a key made here, on every run. A test plays the person at the provider's sign-in page: it
// calls grant() with what the page was sent (nonce, PKCE challenge) and who signs in, and gets the
// code the provider would send the browser back with. Every part of the token can be bent on
// purpose (another issuer, audience, key, algorithm, expiry…), which is what the tests are for.
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign as signData, constants } from 'node:crypto';
import http from 'node:http';

import { freePort } from './free-port.js';

const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A key pair of the given kind, with the public half as a JWK carrying its kid. */
export function signingKey(alg = 'RS256', { kid = `k-${randomBytes(4).toString('hex')}`, bits = 2048 } = {}) {
  const pair = alg === 'ES256' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : generateKeyPairSync('rsa', { modulusLength: bits });
  return { alg, kid, privateKey: pair.privateKey, publicKey: pair.publicKey, jwk: { ...pair.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg } };
}

/** A token: header and claims as given, signed as `alg` says ("none": no signature; "HS256": an HMAC with `secret`). */
export function signToken(claims, key, { alg = key.alg, header = {}, secret = '' } = {}) {
  const head = { typ: 'JWT', alg, kid: key.kid, ...header };
  for (const name of Object.keys(head)) if (head[name] === undefined) delete head[name];
  const signed = `${part(head)}.${part(claims)}`;
  let signature = Buffer.alloc(0);
  if (alg === 'RS256') signature = signData('sha256', Buffer.from(signed), key.privateKey);
  else if (alg === 'PS256') signature = signData('sha256', Buffer.from(signed), { key: key.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
  else if (alg === 'ES256') signature = signData('sha256', Buffer.from(signed), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  else if (alg.startsWith('HS')) signature = createHmac('sha256', secret).update(signed).digest();
  return `${signed}.${signature.toString('base64url')}`;
}

/**
 * Start the provider. `clientId` and `clientSecret` are what it expects at its token address.
 * Returns { issuer, key, requests, grant(), rotate(), set(), close() }.
 */
export async function mockIdp({ clientId = 'mission-zero', clientSecret = randomBytes(18).toString('base64url') } = {}) {
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}/realms/acme`;
  const state = { key: signingKey('RS256'), extraKeys: [], discovery: {}, down: false };
  const grants = new Map(); // code -> what to answer
  const tokens = new Map(); // access token -> userinfo
  const requests = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path: url.pathname, headers: req.headers, body });
    const send = (status, value, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(typeof value === 'string' ? value : JSON.stringify(value));
    };
    if (state.down) return send(503, 'the identity provider is down for maintenance: internal detail the person must never see');
    const base = '/realms/acme';
    if (url.pathname === `${base}/.well-known/openid-configuration`) {
      return send(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/keys`,
        userinfo_endpoint: `${issuer}/userinfo`,
        id_token_signing_alg_values_supported: ['RS256', 'PS256', 'ES256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        ...state.discovery,
      });
    }
    if (url.pathname === `${base}/keys`) return send(200, { keys: [state.key.jwk, ...state.extraKeys.map((k) => k.jwk)] });
    if (url.pathname === `${base}/token` && req.method === 'POST') {
      const form = new URLSearchParams(body);
      const expected = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
      if (req.headers.authorization !== expected) return send(401, { error: 'invalid_client', error_description: `client authentication failed for ${clientId}: internal detail` });
      const grant = grants.get(form.get('code'));
      grants.delete(form.get('code')); // a code works once
      if (!grant || form.get('grant_type') !== 'authorization_code') return send(400, { error: 'invalid_grant', error_description: 'unknown code: internal detail' });
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (challenge !== grant.challenge || form.get('redirect_uri') !== grant.redirectUri || form.get('client_id') !== clientId) return send(400, { error: 'invalid_grant', error_description: 'PKCE or redirect mismatch: internal detail' });
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: issuer, aud: clientId, sub: grant.sub, iat: now, exp: now + 300, nonce: grant.nonce, ...grant.person, ...grant.claims };
      for (const name of Object.keys(claims)) if (claims[name] === undefined) delete claims[name];
      const accessToken = randomBytes(24).toString('base64url');
      tokens.set(accessToken, { sub: grant.sub, ...grant.userinfo });
      const idToken = grant.idToken ?? signToken(claims, grant.key ?? state.key, grant.sign);
      return send(200, { access_token: accessToken, token_type: 'Bearer', expires_in: 300, id_token: idToken });
    }
    if (url.pathname === `${base}/userinfo`) {
      const info = tokens.get(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
      return info ? send(200, info) : send(401, { error: 'invalid_token' });
    }
    send(404, { error: 'not_found' });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    issuer,
    clientId,
    clientSecret,
    requests,
    get key() {
      return state.key;
    },
    /**
     * The person signs in at the provider: returns the code the browser is sent back with.
     * `from`: the query the provider's sign-in address was opened with (nonce, code_challenge, redirect_uri).
     * `person`: their claims (email, email_verified, name). `claims`: overrides of the token's own (iss, aud, exp…;
     * undefined takes one out). `key` / `sign`: sign with another key or algorithm. `userinfo`: what userinfo says.
     */
    grant(from, { person = {}, claims = {}, key, sign, userinfo = {}, sub = `sub-${randomBytes(4).toString('hex')}`, idToken } = {}) {
      const code = randomBytes(16).toString('base64url');
      grants.set(code, { nonce: from.get('nonce'), challenge: from.get('code_challenge'), redirectUri: from.get('redirect_uri'), person, claims, key, sign, userinfo, sub, idToken });
      return code;
    },
    /** A new signing key in place of the old one (the provider rotated its keys). */
    rotate() {
      state.key = signingKey('RS256');
      return state.key;
    },
    /** Change how the provider behaves: { discovery: {...overrides}, down: true, extraKeys: [...] }. */
    set(change) {
      Object.assign(state, change);
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
