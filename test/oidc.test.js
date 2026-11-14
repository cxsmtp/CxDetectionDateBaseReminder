// Single sign-on, piece by piece: what an ID token must be to be believed, the settings an Admin
// saves (and the secret that never leaves), the round trip kept between leaving and coming back, and
// the calls to the provider (which addresses may be called, what is kept, what is read again).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { IamStore } from '../src/iam.js';
import { DEFAULT_SSO, ID_TOKEN_ALGORITHMS, OidcClient, SsoError, SsoFlows, identityProblem, mergeSso, publicSso, ssoChanges, storedSso, verifyIdToken } from '../src/oidc.js';
import { lastGoodCopy } from '../src/state-file.js';
import { mockIdp, signToken, signingKey } from './mock-idp.js';

const ISSUER = 'https://login.acme.example/realms/acme';
const CLIENT = 'mission-zero';
const NONCE = randomBytes(32).toString('base64url');
const SECRET = randomBytes(18).toString('base64url');
const rsa = signingKey('RS256');
const now = Date.now();
const seconds = Math.floor(now / 1000);
const good = (over = {}) => ({ iss: ISSUER, aud: CLIENT, sub: 'ada', iat: seconds, exp: seconds + 300, nonce: NONCE, email: 'ada@acme.io', email_verified: true, ...over });
const check = (token, { keys = [rsa.jwk], ...over } = {}) => verifyIdToken(token, { keys, issuer: ISSUER, clientId: CLIENT, nonce: NONCE, now, ...over });
const refused = (token, pattern, options) => assert.throws(() => check(token, options), (error) => error instanceof SsoError && error.code === 'token' && pattern.test(error.message), `expected ${pattern}`);

test('an ID token signed by the provider is believed: RS256, PS256 and ES256', () => {
  assert.deepEqual(ID_TOKEN_ALGORITHMS, ['RS256', 'PS256', 'ES256']);
  assert.equal(check(signToken(good(), rsa)).email, 'ada@acme.io');
  const pss = signingKey('PS256');
  assert.equal(check(signToken(good(), pss), { keys: [rsa.jwk, pss.jwk] }).sub, 'ada');
  const ec = signingKey('ES256');
  assert.equal(check(signToken(good(), ec), { keys: [ec.jwk] }).sub, 'ada');
  // One key and no key id in the token: that key.
  assert.equal(check(signToken(good(), rsa, { header: { kid: undefined } })).sub, 'ada');
});

test('never "none", never a shared-secret algorithm, never an algorithm the key is not for', () => {
  refused(signToken(good(), rsa, { alg: 'none' }), /"none", which is not accepted/);
  refused(`${signToken(good(), rsa, { alg: 'none' })}x`, /not accepted/);
  // The classic trick: HS256 with the provider's public key as the "secret".
  for (const secret of [rsa.publicKey.export({ type: 'spki', format: 'pem' }), rsa.jwk.n, '']) refused(signToken(good(), rsa, { alg: 'HS256', secret }), /"HS256", which is not accepted/);
  for (const alg of ['HS384', 'HS512', 'RS384', 'ES384', 'EdDSA', 'rs256', '', undefined, 5]) refused(signToken(good(), rsa, { alg: 'RS256', header: { alg } }), /not accepted/);
  // An RSA key's signature presented as ES256, and the other way round.
  refused(signToken(good(), rsa, { alg: 'RS256', header: { alg: 'ES256' } }), /key the identity provider does not publish/);
  const ec = signingKey('ES256');
  refused(signToken(good(), ec, { alg: 'ES256', header: { alg: 'RS256' } }), /does not publish/, { keys: [ec.jwk] });
  // A PS256 signature is not an RS256 one.
  refused(signToken(good(), rsa, { alg: 'PS256', header: { alg: 'RS256' } }), /signature does not match/, { keys: [{ ...rsa.jwk, alg: undefined }] });
  refused(signToken(good(), rsa, { header: { crit: ['exp'] } }), /extension/);
});

test('signed with another key, or changed after it was signed: refused', () => {
  const other = signingKey('RS256');
  refused(signToken(good(), other), /does not publish/, { keys: [rsa.jwk] });
  refused(signToken(good(), other, { header: { kid: rsa.kid } }), /signature does not match/, { keys: [rsa.jwk] });
  const [head, , signature] = signToken(good(), rsa).split('.');
  const forged = Buffer.from(JSON.stringify(good({ email: 'admin@acme.io' }))).toString('base64url');
  refused(`${head}.${forged}.${signature}`, /signature does not match/);
  refused(`${head}.${forged}.`, /signature does not match/);
  for (const junk of ['', 'a.b', 'a.b.c.d', 'not a token', null, undefined, 42, `${head}.bm90IGpzb24.${signature}`, 'x'.repeat(70_000)]) refused(junk, /no ID token that can be read/);
  // A key marked for encryption, or for another algorithm, is not used for signatures.
  refused(signToken(good(), rsa), /does not publish/, { keys: [{ ...rsa.jwk, use: 'enc' }] });
  refused(signToken(good(), rsa), /does not publish/, { keys: [{ ...rsa.jwk, alg: 'PS256' }] });
  refused(signToken(good(), rsa), /does not publish/, { keys: [] });
  refused(signToken(good(), rsa), /cannot be read/, { keys: [{ ...rsa.jwk, n: undefined }] });
  refused(signToken(good(), rsa), /cannot be read|shorter than 2048 bits/, { keys: [{ ...rsa.jwk, n: '!!' }] });
  const short = signingKey('RS256', { bits: 1024 });
  refused(signToken(good(), short), /shorter than 2048 bits/, { keys: [short.jwk] });
});

test('issuer, audience, authorized party, expiry, issue time and nonce are each checked', () => {
  refused(signToken(good({ iss: 'https://login.evil.example/realms/acme' }), rsa), /another issuer/);
  refused(signToken(good({ iss: `${ISSUER}/` }), rsa), /another issuer/);
  refused(signToken(good({ iss: undefined }), rsa), /another issuer/);
  refused(signToken(good({ aud: 'another-app' }), rsa), /another application \(audience\)/);
  refused(signToken(good({ aud: undefined }), rsa), /audience/);
  refused(signToken(good({ aud: ['another-app'] }), rsa), /audience/);
  assert.equal(check(signToken(good({ aud: [CLIENT] }), rsa)).sub, 'ada');
  assert.equal(check(signToken(good({ aud: [CLIENT, 'api'], azp: CLIENT }), rsa)).sub, 'ada');
  refused(signToken(good({ aud: [CLIENT, 'api'] }), rsa), /several audiences/);
  refused(signToken(good({ aud: [CLIENT, 'api'], azp: 'api' }), rsa), /several audiences/);
  refused(signToken(good({ azp: 'another-app' }), rsa), /authorized party/);
  refused(signToken(good({ exp: seconds - 120 }), rsa), /expired/);
  refused(signToken(good({ exp: undefined }), rsa), /expired/);
  refused(signToken(good({ exp: '9999999999' }), rsa), /expired/);
  assert.equal(check(signToken(good({ exp: seconds - 30 }), rsa)).sub, 'ada', 'a minute of clock difference is allowed');
  refused(signToken(good({ iat: undefined }), rsa), /issue time/);
  refused(signToken(good({ iat: seconds + 600 }), rsa), /issue time/);
  refused(signToken(good({ nbf: seconds + 600 }), rsa), /not valid yet/);
  refused(signToken(good({ nonce: randomBytes(32).toString('base64url') }), rsa), /nonce/);
  refused(signToken(good({ nonce: undefined }), rsa), /nonce/);
  refused(signToken(good({ sub: '' }), rsa), /subject/);
  // What is said never holds the token, or a claim from it.
  try {
    check(signToken(good({ aud: 'another-app' }), rsa));
  } catch (error) {
    assert.doesNotMatch(error.message, /another-app|ada@acme\.io|eyJ/);
  }
});

test('who may come in: an email, verified by the provider, in an allowed domain', () => {
  const sso = storedSso({ issuer: ISSUER, clientId: CLIENT });
  assert.equal(identityProblem(sso, { email: 'ada@acme.io', verified: true }), null);
  assert.equal(identityProblem(sso, { email: '', verified: true }).code, 'email');
  assert.equal(identityProblem(sso, { email: 'ada@acme.io', verified: false }).code, 'email');
  assert.equal(identityProblem({ ...sso, requireVerifiedEmail: false }, { email: 'ada@acme.io', verified: false }), null, 'only when an Admin turned the check off');
  const limited = { ...sso, domains: ['acme.io'] };
  assert.equal(identityProblem(limited, { email: 'ada@acme.io', verified: true }), null);
  assert.equal(identityProblem(limited, { email: 'ada@acme.io.evil.example', verified: true }).code, 'domain');
  assert.equal(identityProblem(limited, { email: 'ada@sub.acme.io', verified: true }).code, 'domain', 'a domain is itself, not what is under it');
});

// --- Settings ---------------------------------------------------------------------------------

test('off by default; what an Admin saves is checked field by field', () => {
  assert.equal(DEFAULT_SSO.enabled, false);
  assert.equal(DEFAULT_SSO.provision, 'existing');
  assert.equal(DEFAULT_SSO.requireVerifiedEmail, true);
  assert.equal(DEFAULT_SSO.passwordAdminsOnly, false);
  const roles = ['analyst', 'user'];
  const saved = mergeSso(null, { enabled: true, issuer: ` ${ISSUER} `, clientId: CLIENT, clientSecret: SECRET, label: '  Sign in with Acme  ', domains: '@Acme.io, acme.com;acme.io' }, { roles });
  assert.deepEqual(saved, { ...DEFAULT_SSO, enabled: true, issuer: ISSUER, clientId: CLIENT, clientSecret: SECRET, label: 'Sign in with Acme', domains: ['acme.io', 'acme.com'] });
  const bad = (incoming, pattern, current = saved) => assert.throws(() => mergeSso(current, incoming, { roles }), (error) => error.status === 400 && pattern.test(error.message));
  bad({ issuer: 'http://login.acme.example' }, /must be an https address/);
  bad({ issuer: 'https://user:pw@login.acme.example' }, /user name or password/);
  bad({ issuer: 'https://169.254.169.254/' }, /link-local or cloud metadata/);
  bad({ issuer: 'https://metadata.google.internal/' }, /metadata/);
  bad({ issuer: 'https://login.acme.example/?x=1' }, /"\?" or "#"/);
  bad({ issuer: 'ftp://login.acme.example' }, /https/);
  bad({ issuer: 'login' }, /not a web address/);
  assert.equal(mergeSso(saved, { issuer: 'http://127.0.0.1:8080/realms/acme', clientSecret: SECRET }, { roles }).issuer, 'http://127.0.0.1:8080/realms/acme', 'plain http only on this machine');
  bad({ domains: 'acme' }, /not an email domain/);
  bad({ domains: ['acme.io', 'a b.com'] }, /not an email domain/);
  bad({ provision: 'everyone' }, /Choose who may sign in/);
  bad({ provision: 'create', role: 'admin' }, /cannot be given the Admin role/);
  bad({ provision: 'create', role: 'no-such-role' }, /Choose the role/);
  assert.equal(mergeSso(saved, { provision: 'create', role: 'user' }, { roles }).provision, 'create');
  bad({ enabled: true }, /before turning single sign-on on/, null);
  bad({ enabled: true, issuer: ISSUER }, /client id/, null);
  bad({ passwordAdminsOnly: true }, /Turn single sign-on on/, null);
  bad({ enabled: false, passwordAdminsOnly: true }, /Turn single sign-on on/);
  bad({ clientSecret: 'x'.repeat(2001) }, /too long/);
  assert.equal(mergeSso(saved, { label: '' }, { roles }).label, DEFAULT_SSO.label);
  assert.equal(mergeSso(saved, { requireVerifiedEmail: false }, { roles }).requireVerifiedEmail, false);
});

test('the client secret is kept, replaced or taken out; never sent to another host; never shown', () => {
  const saved = mergeSso(null, { enabled: true, issuer: ISSUER, clientId: CLIENT, clientSecret: SECRET });
  assert.equal(mergeSso(saved, { label: 'Company sign-in' }).clientSecret, SECRET, 'left out: kept');
  assert.equal(mergeSso(saved, { clientSecret: '' }).clientSecret, SECRET, 'an empty field keeps it');
  const next = randomBytes(18).toString('base64url');
  assert.equal(mergeSso(saved, { clientSecret: next }).clientSecret, next);
  assert.equal(mergeSso(saved, { clientSecret: null }).clientSecret, '');
  assert.equal(mergeSso(saved, { issuer: `${ISSUER}/v2` }).clientSecret, SECRET, 'the same host keeps it');
  assert.equal(mergeSso(saved, { issuer: 'https://login.other.example/realms/acme' }).clientSecret, '', 'another host: typed again');
  assert.equal(mergeSso(saved, { issuer: 'https://login.other.example/realms/acme', clientSecret: next }).clientSecret, next);

  const shown = publicSso(saved);
  assert.equal(shown.clientSecretSet, true);
  assert.equal('clientSecret' in shown, false);
  assert.doesNotMatch(JSON.stringify(shown), new RegExp(SECRET));
  assert.equal(publicSso(mergeSso(saved, { clientSecret: null })).clientSecretSet, false);
  assert.deepEqual(ssoChanges(saved, mergeSso(saved, { clientSecret: next, label: 'x' })), ['client secret', 'button label'], 'the log names what changed, never the secret');
});

test('what a file from another version holds loads without stopping the server', () => {
  for (const raw of [undefined, null, 'x', 5, [], { issuer: 'not an address', enabled: true }, { enabled: true }, { domains: 'x', role: 7, provision: 'all' }]) {
    const sso = storedSso(raw);
    assert.equal(sso.enabled, false, JSON.stringify(raw));
    assert.equal(sso.provision, 'existing');
  }
  assert.equal(storedSso({ enabled: false, issuer: ISSUER, clientId: CLIENT, passwordAdminsOnly: true }).passwordAdminsOnly, false, 'only with single sign-on on');
});

test('saved in iam.json, owner only; replacing or removing the secret leaves no copy of it behind', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sso-'));
  const file = path.join(dir, 'iam.json');
  const iam = new IamStore({ file });
  await iam.createUser({ email: 'ada@acme.io', role: 'admin' });
  assert.equal(iam.sso().enabled, false);
  iam.setSso(mergeSso(iam.sso(), { enabled: true, issuer: ISSUER, clientId: CLIENT, clientSecret: SECRET }));
  assert.match(fs.readFileSync(file, 'utf8'), new RegExp(SECRET));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(new IamStore({ file }).sso().clientSecret, SECRET, 'read back after a restart');
  assert.doesNotMatch(JSON.stringify([iam.users(), iam.roles()]), new RegExp(SECRET));
  iam.setSso(mergeSso(iam.sso(), { label: 'Company sign-in' })); // one more save: the copy of the file before now holds the secret
  assert.match(fs.readFileSync(lastGoodCopy(file), 'utf8'), new RegExp(SECRET));
  iam.setSso(mergeSso(iam.sso(), { clientSecret: null }));
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), new RegExp(SECRET));
  assert.equal(fs.existsSync(lastGoodCopy(file)), false, 'no last good copy keeps it');
  assert.equal(iam.sso().label, 'Company sign-in');
  assert.equal(iam.passwordResetPolicy(), 'everyone');
});

// --- The round trip ---------------------------------------------------------------------------

test('a round trip is found by its state, once, and only by the browser that started it', () => {
  const flows = new SsoFlows();
  const t0 = 1_000_000;
  const flow = flows.start('', t0);
  for (const value of [flow.state, flow.nonce, flow.verifier, flow.cookie, flow.challenge]) assert.match(value, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(new Set([flow.state, flow.nonce, flow.verifier, flow.cookie]).size, 4);
  assert.equal(flows.take(flow.state, '', t0), null, 'no cookie: another browser');
  assert.equal(flows.take(flow.state, flow.cookie, t0), null, 'and the state is used up by the try');

  const second = flows.start(flow.cookie, t0);
  assert.equal(second.cookie, flow.cookie, 'a second tab keeps the browser\'s cookie');
  assert.equal(flows.take(second.state, flows.start('', t0).cookie, t0), null, 'someone else\'s cookie');
  const third = flows.start(flow.cookie, t0);
  assert.deepEqual(flows.take(third.state, flow.cookie, t0 + 1000), { nonce: third.nonce, verifier: third.verifier });
  assert.equal(flows.take(third.state, flow.cookie, t0 + 1000), null, 'once');
  const late = flows.start(flow.cookie, t0);
  assert.equal(flows.take(late.state, flow.cookie, t0 + 11 * 60_000), null, 'ten minutes at most');
  for (const state of ['', 'x', null, undefined, ['a'], { length: 43 }]) assert.equal(flows.take(state, flow.cookie, t0), null);
  assert.equal(flows.start('not a cookie this server made', t0).cookie.length, 43);
});

test('round trips never pile up', () => {
  const flows = new SsoFlows({ max: 20 });
  for (let i = 0; i < 200; i += 1) flows.start('');
  assert.ok(flows.size <= 20, `${flows.size} kept`);
  const old = new SsoFlows();
  old.start('', 0);
  old.start('', 11 * 60_000);
  assert.equal(old.size, 1, 'the ones that are over go when the next starts');
});

// --- The calls to the provider ------------------------------------------------------------------

/** A provider made of answers: { 'https://…': body | (request) => ({ status, body }) }. */
function fakeProvider(answers) {
  const calls = [];
  const fetch = async (address, options = {}) => {
    calls.push({ address, ...options });
    const answer = typeof answers[address] === 'function' ? answers[address](options) : answers[address] ? { status: 200, body: answers[address] } : { status: 404, body: { error: 'not_found' } };
    const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
    return { status: answer.status, body: [Buffer.from(text)] };
  };
  return { fetch, calls };
}
const discoveryDoc = (over = {}) => ({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/keys`, userinfo_endpoint: `${ISSUER}/userinfo`, ...over });
const WELL_KNOWN = `${ISSUER}/.well-known/openid-configuration`;
const publicLookup = async () => [{ address: '203.0.113.10', family: 4 }];
const sso = storedSso({ enabled: true, issuer: ISSUER, clientId: CLIENT, clientSecret: SECRET });
const REDIRECT = 'https://mz.acme.example/api/session/oidc/callback';
const ssoError = (code, pattern) => (error) => error instanceof SsoError && error.code === code && pattern.test(error.message);

test('the sign-in address carries the code flow with PKCE, state and nonce; discovery is read once', async () => {
  const provider = fakeProvider({ [WELL_KNOWN]: discoveryDoc() });
  const client = new OidcClient({ fetch: provider.fetch, lookup: publicLookup, proxy: () => '' });
  const flow = new SsoFlows().start('');
  const url = new URL(await client.authorizationUrl(sso, REDIRECT, flow));
  assert.equal(`${url.origin}${url.pathname}`, `${ISSUER}/authorize`);
  assert.deepEqual(Object.fromEntries(url.searchParams), { response_type: 'code', client_id: CLIENT, redirect_uri: REDIRECT, scope: 'openid email profile', state: flow.state, nonce: flow.nonce, code_challenge: flow.challenge, code_challenge_method: 'S256' });
  assert.doesNotMatch(url.href, new RegExp(flow.verifier), 'the verifier stays here');
  assert.doesNotMatch(url.href, new RegExp(SECRET));
  await client.authorizationUrl(sso, REDIRECT, flow);
  assert.equal(provider.calls.length, 1, 'kept, not read again for every sign-in');
  assert.equal(provider.calls[0].redirect, 'manual', 'a redirect is never followed');
  client.forget();
  await client.authorizationUrl(sso, REDIRECT, flow);
  assert.equal(provider.calls.length, 2, 'read again once the settings change');
});

test('discovery must name this issuer, and every address it gives must be one the server may call', async () => {
  const attempt = async (doc, lookup = publicLookup, issuer = ISSUER) => {
    const provider = fakeProvider({ [`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`]: doc });
    return new OidcClient({ fetch: provider.fetch, lookup, proxy: () => '' }).discover(issuer);
  };
  await assert.rejects(attempt(discoveryDoc({ issuer: 'https://login.evil.example/realms/acme' })), ssoError('setup', /names another issuer/));
  await assert.rejects(attempt(discoveryDoc({ token_endpoint: 'http://login.acme.example/token' })), ssoError('setup', /token address must be an https address/));
  await assert.rejects(attempt(discoveryDoc({ jwks_uri: 'https://169.254.169.254/latest/meta-data' })), ssoError('setup', /keys address points at a link-local or cloud metadata address/));
  await assert.rejects(attempt(discoveryDoc({ userinfo_endpoint: 'http://127.0.0.1:8080/userinfo' })), ssoError('setup', /userinfo address must be an https address/), 'plain http to this machine only when the issuer itself is');
  await assert.rejects(attempt(discoveryDoc({ authorization_endpoint: undefined })), ssoError('setup', /no sign-in address/));
  await assert.rejects(attempt('<html>not json</html>'), ssoError('provider', /answered 200 without JSON/));
  // A name that resolves to the cloud's metadata service is never called.
  await assert.rejects(attempt(discoveryDoc(), async () => [{ address: '203.0.113.10', family: 4 }, { address: '169.254.169.254', family: 4 }]), ssoError('setup', /resolves to a link-local or cloud metadata address/));
  await assert.rejects(attempt(discoveryDoc(), async () => Promise.reject(new Error('ENOTFOUND'))), ssoError('provider', /does not resolve/));
  // An issuer with a slash at the end is the same issuer.
  assert.equal((await attempt(discoveryDoc({ issuer: `${ISSUER}/` }), publicLookup, `${ISSUER}/`)).issuer, `${ISSUER}/`);
  const local = 'http://127.0.0.1:8080/realms/acme';
  const doc = await attempt({ issuer: local, authorization_endpoint: `${local}/authorize`, token_endpoint: `${local}/token`, jwks_uri: `${local}/keys` }, publicLookup, local);
  assert.equal(doc.token_endpoint, `${local}/token`);
  assert.equal(doc.userinfo_endpoint, undefined);
});

test('the way back: code exchanged with the secret and the PKCE verifier, the token verified, the email taken from it', async () => {
  const token = (claims) => signToken({ iss: ISSUER, aud: CLIENT, sub: 'ada', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, nonce: NONCE, ...claims }, rsa);
  const provider = fakeProvider({
    [WELL_KNOWN]: discoveryDoc(),
    [`${ISSUER}/keys`]: { keys: [rsa.jwk] },
    [`${ISSUER}/token`]: () => ({ status: 200, body: { id_token: token({ email: 'Ada@Acme.io', email_verified: true, name: 'Ada' }), access_token: 'at' } }),
  });
  const client = new OidcClient({ fetch: provider.fetch, lookup: publicLookup, proxy: () => '' });
  const identity = await client.finish(sso, REDIRECT, { code: 'the-code', nonce: NONCE, verifier: 'the-verifier' });
  assert.deepEqual(identity, { email: 'ada@acme.io', verified: true, name: 'Ada', sub: 'ada' });
  const call = provider.calls.find((c) => c.address === `${ISSUER}/token`);
  assert.equal(call.method, 'POST');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(call.body)), { grant_type: 'authorization_code', code: 'the-code', redirect_uri: REDIRECT, client_id: CLIENT, code_verifier: 'the-verifier' });
  assert.equal(call.headers.Authorization, `Basic ${Buffer.from(`${CLIENT}:${encodeURIComponent(SECRET)}`).toString('base64')}`, 'the secret in the header, not the address');
  assert.equal(provider.calls.some((c) => c.address.includes('userinfo')), false, 'userinfo is not asked when the token has the email');

  // A provider that takes the secret in the body only.
  const posting = fakeProvider({ [`${ISSUER}/keys`]: { keys: [rsa.jwk] }, [WELL_KNOWN]: discoveryDoc({ token_endpoint_auth_methods_supported: ['client_secret_post'] }), [`${ISSUER}/token`]: () => ({ status: 200, body: { id_token: token({ email: 'ada@acme.io' }) } }) });
  const unverified = await new OidcClient({ fetch: posting.fetch, lookup: publicLookup, proxy: () => '' }).finish(sso, REDIRECT, { code: 'c', nonce: NONCE, verifier: 'v' });
  assert.equal(unverified.verified, false, 'no email_verified claim is not verified');
  const posted = posting.calls.find((c) => c.address === `${ISSUER}/token`);
  assert.equal(new URLSearchParams(posted.body).get('client_secret'), SECRET);
  assert.equal(posted.headers.Authorization, undefined);
});

test('no email in the token: userinfo is asked, and believed only for the same person', async () => {
  const token = signToken({ iss: ISSUER, aud: CLIENT, sub: 'ada', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, nonce: NONCE }, rsa);
  const provider = (info) => fakeProvider({ [WELL_KNOWN]: discoveryDoc(), [`${ISSUER}/keys`]: { keys: [rsa.jwk] }, [`${ISSUER}/token`]: { id_token: token, access_token: 'the-access-token' }, [`${ISSUER}/userinfo`]: info });
  const same = provider({ sub: 'ada', email: 'ada@acme.io', email_verified: 'true', name: 'Ada' });
  assert.deepEqual(await new OidcClient({ fetch: same.fetch, lookup: publicLookup, proxy: () => '' }).finish(sso, REDIRECT, { code: 'c', nonce: NONCE, verifier: 'v' }), { email: 'ada@acme.io', verified: true, name: 'Ada', sub: 'ada' });
  assert.equal(same.calls.at(-1).headers.Authorization, 'Bearer the-access-token');
  const other = provider({ sub: 'someone-else', email: 'admin@acme.io', email_verified: true });
  assert.equal((await new OidcClient({ fetch: other.fetch, lookup: publicLookup, proxy: () => '' }).finish(sso, REDIRECT, { code: 'c', nonce: NONCE, verifier: 'v' })).email, '', 'another subject\'s userinfo is not this person\'s email');
});

test('the provider changed its keys: they are read again, at once when what is kept is not fresh, and never more than every half minute', async () => {
  const next = signingKey('RS256');
  let published = [rsa.jwk];
  let clock = 1_800_000_000_000;
  const token = (key) => signToken({ iss: ISSUER, aud: CLIENT, sub: 'ada', iat: Math.floor(clock / 1000), exp: Math.floor(clock / 1000) + 300, nonce: NONCE, email: 'ada@acme.io', email_verified: true }, key);
  let signer = rsa;
  const provider = fakeProvider({ [WELL_KNOWN]: discoveryDoc(), [`${ISSUER}/keys`]: () => ({ status: 200, body: { keys: published } }), [`${ISSUER}/token`]: () => ({ status: 200, body: { id_token: token(signer) } }) });
  const client = new OidcClient({ fetch: provider.fetch, lookup: publicLookup, proxy: () => '', now: () => clock });
  const count = (what) => provider.calls.filter((c) => c.address.endsWith(what)).length;
  const finish = () => client.finish(sso, REDIRECT, { code: 'c', nonce: NONCE, verifier: 'v' });

  assert.equal((await finish()).email, 'ada@acme.io');
  assert.equal((await finish()).email, 'ada@acme.io');
  assert.deepEqual([count('/keys'), count('openid-configuration')], [1, 1], 'kept between sign-ins');

  // Ten minutes later the provider signs with a new key and publishes it: found in the same sign-in.
  clock += 10 * 60_000;
  signer = next;
  published = [next.jwk];
  assert.equal((await finish()).email, 'ada@acme.io');
  assert.equal(count('/keys'), 2, 'read again because the token\'s key was not among the ones kept');

  // A token signed with a key the provider does not publish: the keys are not read again for every such token.
  signer = signingKey('RS256');
  await assert.rejects(finish(), ssoError('token', /does not publish/));
  await assert.rejects(finish(), ssoError('token', /does not publish/));
  assert.equal(count('/keys'), 2, 'not more often than every half minute, whoever asks');
  // After a failure, what is kept is read afresh half a minute later, not an hour later.
  clock += 31_000;
  signer = next;
  assert.equal((await finish()).email, 'ada@acme.io');
  assert.deepEqual([count('/keys'), count('openid-configuration')], [3, 3]);
  // And an hour on, both are read again by themselves.
  clock += 61 * 60_000;
  assert.equal((await finish()).email, 'ada@acme.io');
  assert.deepEqual([count('/keys'), count('openid-configuration')], [4, 4]);
});

test('what the provider says when it refuses is never passed on: only its short error code, in the log line', async () => {
  const provider = fakeProvider({
    [WELL_KNOWN]: discoveryDoc(),
    [`${ISSUER}/keys`]: { keys: [rsa.jwk] },
    [`${ISSUER}/token`]: () => ({ status: 401, body: { error: 'invalid_client', error_description: `the secret ${SECRET} is wrong for tenant 42` } }),
  });
  await assert.rejects(new OidcClient({ fetch: provider.fetch, lookup: publicLookup, proxy: () => '' }).finish(sso, REDIRECT, { code: 'c', nonce: NONCE, verifier: 'v' }), (error) => {
    assert.equal(error.code, 'setup');
    assert.match(error.message, /did not accept the code \(HTTP 401, invalid_client\)/);
    assert.doesNotMatch(error.message, new RegExp(SECRET));
    assert.doesNotMatch(error.message, /tenant 42/);
    return true;
  });
  const weird = fakeProvider({ [WELL_KNOWN]: discoveryDoc(), [`${ISSUER}/token`]: () => ({ status: 500, body: { error: '<script>alert(1)</script> not a code' } }) });
  await assert.rejects(new OidcClient({ fetch: weird.fetch, lookup: publicLookup, proxy: () => '' }).finish(sso, REDIRECT, { code: 'c', nonce: NONCE, verifier: 'v' }), ssoError('provider', /^the identity provider did not accept the code \(HTTP 500\)$/));
  const down = { fetch: async () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })) };
  await assert.rejects(new OidcClient({ fetch: down.fetch, lookup: publicLookup, proxy: () => '' }).discover(ISSUER), ssoError('provider', /could not be reached \(ECONNREFUSED\)/));
  const huge = { fetch: async () => ({ status: 200, body: [Buffer.alloc(600 * 1024, 0x20)] }) };
  await assert.rejects(new OidcClient({ fetch: huge.fetch, lookup: publicLookup, proxy: () => '' }).discover(ISSUER), ssoError('provider', /more than this server reads/));
});

test('against a provider on the network: discovery, keys and the Admin\'s check', async () => {
  const idp = await mockIdp();
  try {
    const client = new OidcClient();
    const local = storedSso({ enabled: true, issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret });
    const checked = await client.check(local);
    assert.deepEqual(checked, { ok: true, message: 'The identity provider answered: 1 signing key found.', issuer: idp.issuer });
    idp.set({ down: true });
    const failed = await client.check(local);
    assert.equal(failed.ok, false);
    assert.match(failed.message, /^The identity provider could not be checked: the identity provider's discovery address answered 503 without JSON\.$/);
    assert.doesNotMatch(failed.message, /maintenance|internal detail/, 'never the provider\'s own words');
  } finally {
    await idp.close();
  }
});
