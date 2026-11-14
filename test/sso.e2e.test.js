// Single sign-on with OpenID Connect, end to end: the real server against a stand-in identity provider
// (test/mock-idp.js), which signs with a key made in this run. The happy path, and every way an answer
// must be refused: wrong state, wrong nonce, an expired token, another audience, another issuer, another
// key, "alg none", an unverified email, an unknown person, a disabled person, and the switch being off.
// Nothing secret may reach the page, the audit log or the server log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { totp } from '../src/mfa.js';
import { freePort } from './free-port.js';
import { mockIdp, signingKey } from './mock-idp.js';
import { FIRST_PASSWORD, MEMBER_NEXT_PASSWORD, NEXT_PASSWORD, mockApiKey } from './test-credentials.js';

const MOCK_PORT = await freePort();
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const CALLBACK = '/api/session/oidc/callback';
const DEV_PASSWORD = MEMBER_NEXT_PASSWORD;
const children = [];
let log = '';
let dataDir;
let idp;
let serial = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A browser: its own cookies (the session's, and the one for the round trip), its own address, and it follows no redirect by itself. */
function browser() {
  const jar = new Map();
  const ip = `198.51.100.${(serial += 1)}`;
  const call = async (method, url, body) => {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const res = await fetch(BASE + url, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.getSetCookie();
    for (const line of set) {
      const [name, ...value] = line.split(';')[0].split('=');
      if (/Max-Age=0/.test(line)) jar.delete(name);
      else jar.set(name, value.join('='));
    }
    return { status: res.status, location: res.headers.get('location') ?? '', body: await res.json().catch(() => null), set };
  };
  call.jar = jar;
  call.signedIn = async () => (await call('GET', '/api/me')).status === 200;
  return call;
}
const admin = browser();
const analyst = browser();

async function until(check, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out\n${log.slice(-2000)}`);
}
const auditLog = async () => (await admin('GET', '/api/audit?types=access,iam&limit=300')).body.entries;
const reasons = async () => (await auditLog()).map((e) => `${e.outcome}: ${e.reason}`).join('\n');
const setSso = (sso) => admin('PUT', '/api/iam/sign-in', { sso });

/** Press the button: the server sends the browser to the provider. Returns where to, and the query the provider's sign-in page is opened with. */
async function leave(b) {
  const sent = await b('GET', '/api/session/oidc/start');
  assert.equal(sent.status, 302, JSON.stringify(sent));
  assert.ok(sent.location.startsWith(`${idp.issuer}/authorize?`), sent.location);
  return { sent, query: new URL(sent.location).searchParams };
}

/** A person has one account at the provider: the same subject every time they sign in there (unless a test says otherwise). */
const as = (grant) => ({ sub: `id-${grant.person?.email ?? grant.userinfo?.email ?? 'nobody'}`.toLowerCase(), ...grant });

/** The person signs in at the provider (as `grant` says) and the browser comes back with the code. */
async function comeBack(b, grant = {}) {
  const { query } = await leave(b);
  const code = idp.grant(query, as(grant));
  return b('GET', `${CALLBACK}?code=${code}&state=${query.get('state')}`);
}

/** The answer was refused: back to the sign-in page with only a short code, nobody signed in, and the reason in the audit log. */
async function assertRefused(b, answer, code, reason) {
  assert.equal(answer.status, 302, JSON.stringify(answer.body));
  assert.equal(answer.location, `/#sso=${code}`, 'only a short code goes back to the page');
  assert.equal(b.jar.has('cxdr_sid'), false, 'no session cookie');
  assert.equal(await b.signedIn(), false);
  if (reason) assert.match(await reasons(), reason);
}

const dev = { email: 'dev@acme.io', email_verified: true, name: 'Dev' };
let devId = '';

test.before(async () => {
  idp = await mockIdp();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sso-'));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '1', RISKS: '1' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HTTPS: 'off', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: mockApiKey({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' }), CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD, REPORT_SERVER_URL: BASE, RESET_TWO_STEP: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  children.push(server);
  await until(() => /Successfully authenticated/.test(log) && /First administrator created/.test(log));
  await admin('POST', '/api/session/password', { email: 'admin@acme.io', password: FIRST_PASSWORD });
  await admin('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD });
  for (const [email, role] of [['dev@acme.io', 'user'], ['analyst@acme.io', 'analyst'], ['gone@acme.io', 'user']]) {
    assert.equal((await admin('POST', '/api/iam/users', { email, role, password: FIRST_PASSWORD })).status, 201);
  }
  const b = browser();
  await b('POST', '/api/session/password', { email: 'dev@acme.io', password: FIRST_PASSWORD });
  assert.equal((await b('POST', '/api/me/password', { current: FIRST_PASSWORD, next: DEV_PASSWORD })).status, 200);
  const people = (await admin('GET', '/api/iam')).body.users;
  devId = people.find((u) => u.email === 'dev@acme.io').id;
  assert.equal((await admin('PATCH', `/api/iam/users/${people.find((u) => u.email === 'gone@acme.io').id}`, { disabled: true })).status, 200);
});

test.after(async () => {
  for (const child of children) child.kill();
  await idp?.close();
});

test('off by default: no button, and neither address does anything', async () => {
  assert.equal((await browser()('GET', '/api/session')).body.sso, null);
  const view = (await admin('GET', '/api/iam')).body.signIn.security;
  assert.equal(view.sso.enabled, false);
  assert.equal(view.sso.provision, 'existing', 'people must already be in People & roles');
  assert.equal(view.sso.requireVerifiedEmail, true);
  assert.equal(view.sso.passwordAdminsOnly, false);
  assert.equal(view.redirectUri, `${BASE}${CALLBACK}`, 'the address to register at the provider');
  const b = browser();
  const start = await b('GET', '/api/session/oidc/start');
  assert.deepEqual([start.status, start.location], [302, '/#sso=off']);
  await assertRefused(b, await b('GET', `${CALLBACK}?code=x&state=${randomBytes(32).toString('base64url')}`), 'off', /refused: Single sign-on refused: single sign-on is turned off\./);
  assert.equal(idp.requests.length, 0, 'the provider is not called');
  assert.equal((await admin('GET', '/api/network')).body.requirements.some((r) => /Identity provider/.test(r.what)), false);
});

test('only an Admin sets it up; the client secret goes in and never comes out', async () => {
  await analyst('POST', '/api/session/password', { email: 'analyst@acme.io', password: FIRST_PASSWORD });
  await analyst('POST', '/api/me/password', { current: FIRST_PASSWORD, next: `${NEXT_PASSWORD}-analyst` });
  assert.equal((await analyst('GET', '/api/iam')).body.signIn.security, null);
  assert.equal((await analyst('PUT', '/api/iam/sign-in', { sso: { enabled: true, issuer: idp.issuer, clientId: idp.clientId } })).status, 403);
  assert.equal((await analyst('POST', '/api/iam/sign-in/sso/check')).status, 403);
  assert.equal((await browser()('PUT', '/api/iam/sign-in', { sso: { enabled: true } })).status, 401);

  const bad = await setSso({ enabled: true, issuer: 'http://login.acme.example/realms/acme', clientId: idp.clientId });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /must be an https address/);
  assert.equal((await setSso({ enabled: true, issuer: 'https://169.254.169.254/', clientId: idp.clientId })).status, 400);
  assert.equal((await setSso({ provision: 'create', role: 'admin' })).status, 400, 'nobody is added as Admin');

  const saved = await setSso({ enabled: true, issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, label: 'Sign in with Acme' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const view = saved.body.signIn.security;
  assert.equal(view.sso.enabled, true);
  assert.equal(view.sso.clientSecretSet, true);
  assert.equal('clientSecret' in view.sso, false);
  assert.deepEqual(view.missing, []);
  for (const b of [admin, analyst]) {
    for (const url of ['/api/iam', '/api/me', '/api/settings', '/api/session']) assert.doesNotMatch(JSON.stringify((await b('GET', url)).body), new RegExp(idp.clientSecret), url);
  }
  assert.deepEqual((await browser()('GET', '/api/session')).body.sso, { label: 'Sign in with Acme', passwordAdminsOnly: false }, 'the button, with the Admin\'s label');
  assert.match(await reasons(), /changed: Changed single sign-on: on or off, identity provider address, client id, client secret, button label\./);

  const checked = await admin('POST', '/api/iam/sign-in/sso/check');
  assert.deepEqual(checked.body, { ok: true, message: 'The identity provider answered: 1 signing key found.' });
  // One more connection on the sheet for the network team.
  const row = (await admin('GET', '/api/network')).body.requirements.find((r) => r.what === 'Identity provider (single sign-on)');
  assert.deepEqual([row.direction, row.host, row.port], ['Out', '127.0.0.1', new URL(idp.issuer).port]);
  // On the disk it is in iam.json, owner only.
  assert.match(fs.readFileSync(path.join(dataDir, 'iam.json'), 'utf8'), new RegExp(idp.clientSecret));
  assert.equal(fs.statSync(path.join(dataDir, 'iam.json')).mode & 0o777, 0o600);
});

test('the happy path: off to the provider with PKCE, state and nonce; back with a code; the same session a password gives', async () => {
  const b = browser();
  const { sent, query } = await leave(b);
  assert.deepEqual([query.get('response_type'), query.get('client_id'), query.get('redirect_uri'), query.get('code_challenge_method')], ['code', idp.clientId, `${BASE}${CALLBACK}`, 'S256']);
  assert.match(query.get('scope'), /\bopenid\b.*\bemail\b/);
  for (const name of ['state', 'nonce', 'code_challenge']) assert.match(query.get(name), /^[A-Za-z0-9_-]{43}$/, name);
  assert.doesNotMatch(sent.location, new RegExp(idp.clientSecret));
  const roundTrip = sent.set.find((c) => c.startsWith('cxdr_sso='));
  assert.match(roundTrip, /; Path=\/api\/session\/oidc; HttpOnly; SameSite=Lax; Max-Age=600$/, 'kept for the round trip only, out of scripts\' reach');
  // A new value at every start, whatever the browser holds: a cookie someone planted is never taken over.
  const planted = randomBytes(32).toString('base64url');
  const fixed = browser();
  fixed.jar.set('cxdr_sso', planted);
  const second = await leave(fixed);
  assert.notEqual(fixed.jar.get('cxdr_sso'), planted);
  assert.notEqual(fixed.jar.get('cxdr_sso'), b.jar.get('cxdr_sso'));
  const planter = browser();
  planter.jar.set('cxdr_sso', planted);
  await assertRefused(planter, await planter('GET', `${CALLBACK}?code=${idp.grant(second.query, as({ person: dev }))}&state=${second.query.get('state')}`), 'expired');
  assert.equal(await b.signedIn(), false);

  const back = await b('GET', `${CALLBACK}?code=${idp.grant(query, as({ person: dev }))}&state=${query.get('state')}`);
  assert.equal(back.status, 302, JSON.stringify(back.body));
  assert.equal(back.location, `${BASE}/`, 'into the app, with nothing in the address');
  const session = back.set.find((c) => c.startsWith('cxdr_sid='));
  assert.match(session, /; Path=\/; HttpOnly; SameSite=Lax$/, 'the same cookie a password sign-in sets');
  assert.ok(back.set.some((c) => /^cxdr_sso=; .*Max-Age=0/.test(c)), 'the round trip\'s cookie is gone');
  const me = await b('GET', '/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'dev@acme.io');
  assert.equal(me.body.via, 'sso');
  assert.equal(me.body.role.id, 'user', 'their role here, not anything the provider says');
  assert.match(await reasons(), /info: dev@acme\.io signed in with single sign-on\./);
  assert.ok((await admin('GET', '/api/iam')).body.users.find((u) => u.id === devId).lastLoginAt);

  // The token request: the code with the PKCE verifier and the client secret in the header (the stand-in checks both).
  const token = idp.requests.find((r) => r.path.endsWith('/token'));
  assert.match(token.headers.authorization, /^Basic /);
  assert.match(new URLSearchParams(token.body).get('code_verifier'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(new URLSearchParams(token.body).get('client_secret'), null);

  // Opened at another address than the server's own: sent to the server's own first, once, so the round trip begins where it ends.
  const elsewhere = await fetch(`${BASE}/api/session/oidc/start`, { redirect: 'manual', headers: { 'X-Forwarded-Host': 'mz.old-name.example' } });
  assert.deepEqual([elsewhere.status, elsewhere.headers.get('location')], [302, `${BASE}/api/session/oidc/start?at=server`]);
  const once = await fetch(`${BASE}/api/session/oidc/start?at=server`, { redirect: 'manual', headers: { 'X-Forwarded-Host': 'mz.old-name.example' } });
  assert.ok(once.headers.get('location').startsWith(`${idp.issuer}/authorize?`), 'never in circles');

  // The same code and state a second time open nothing.
  const replay = browser();
  await assertRefused(replay, await replay('GET', back.location === `${BASE}/` ? `${CALLBACK}?code=x&state=${query.get('state')}` : ''), 'expired');
  const activity = (await admin('GET', '/api/activity?kind=sign-in&limit=20')).body.entries ?? [];
  assert.ok(activity.some((e) => e.user === 'dev@acme.io' && e.action === 'Signed in with single sign-on'), JSON.stringify(activity.slice(0, 3)));
});

test('the first single sign-on links the person to their account at the provider; another account with their email is refused', async () => {
  const person = () => admin('GET', '/api/iam').then((r) => r.body.users.find((u) => u.id === devId));
  assert.equal((await person()).ssoLinked, true);
  assert.match(await reasons(), /changed: dev@acme\.io was linked to their account at the identity provider at their first single sign-on\./);
  assert.doesNotMatch(JSON.stringify((await admin('GET', '/api/iam')).body), /id-dev@acme\.io/, 'which account it is stays on the server');

  // The address was given to a new account at the provider (a leaver's address reused, an account made anew): not the same person.
  const other = browser();
  await assertRefused(other, await comeBack(other, { person: dev, sub: 'another-account' }), 'link', /refused: Single sign-on refused for dev@acme\.io: dev@acme\.io is linked to another account at the identity provider/);
  // Their own account, whatever its address is called now, is still them.
  const renamed = browser();
  assert.equal((await comeBack(renamed, { person: { email: 'dev.renamed@acme.io', email_verified: true }, sub: 'id-dev@acme.io' })).location, `${BASE}/`);
  assert.equal((await renamed('GET', '/api/me')).body.user.email, 'dev@acme.io');

  // An Admin resets the link when the account at the provider really was made anew; nobody without the permission does.
  assert.equal((await renamed('DELETE', `/api/iam/users/${devId}/sso-link`)).status, 403);
  const reset = await admin('DELETE', `/api/iam/users/${devId}/sso-link`);
  assert.equal(reset.status, 200);
  assert.equal(reset.body.users.find((u) => u.id === devId).ssoLinked, false);
  assert.match(await reasons(), /changed: Reset the single sign-on link of dev@acme\.io\./);
  const anew = browser();
  assert.equal((await comeBack(anew, { person: dev, sub: 'another-account' })).location, `${BASE}/`, 'linked again, by their email address');
  const old = browser();
  await assertRefused(old, await comeBack(old, { person: dev }), 'link');
  // (Back to the account the other tests sign in with.)
  await admin('DELETE', `/api/iam/users/${devId}/sso-link`);
  assert.equal((await comeBack(browser(), { person: dev })).location, `${BASE}/`);
  assert.equal((await person()).ssoLinked, true);
});

test('someone who may manage people is never linked on an unverified address, whatever the switch says', async () => {
  assert.equal((await setSso({ requireVerifiedEmail: false })).status, 200);
  const unverified = (email) => ({ person: { email, email_verified: false } });
  for (const email of ['analyst@acme.io', 'admin@acme.io']) {
    const b = browser();
    await assertRefused(b, await comeBack(b, unverified(email)), 'email', new RegExp(`refused: Single sign-on refused for ${email.replace('.', '\\.')}: the identity provider does not mark ${email.replace('.', '\\.')} as verified, and someone who may manage people is not signed in on such an address until they are linked\\.`));
  }
  const user = browser();
  assert.equal((await comeBack(user, unverified('dev@acme.io'))).location, `${BASE}/`, 'someone who manages nobody follows the switch');
  // Linked on a verified address, the same account is them from then on.
  const verified = browser();
  assert.equal((await comeBack(verified, { person: { email: 'analyst@acme.io', email_verified: true } })).location, `${BASE}/`);
  const later = browser();
  assert.equal((await comeBack(later, unverified('analyst@acme.io'))).location, `${BASE}/`);
  // Nor is anyone added, on an unverified address, with a role that may manage people.
  assert.equal((await setSso({ provision: 'create', role: 'analyst', domains: 'acme.io' })).status, 200);
  const newcomer = browser();
  await assertRefused(newcomer, await comeBack(newcomer, unverified('newcomer@acme.io')), 'email', /nobody is added with a role that may manage people on such an address/);
  assert.equal((await admin('GET', '/api/iam')).body.users.some((u) => u.email === 'newcomer@acme.io'), false);
  assert.equal((await setSso({ provision: 'existing', role: 'user', domains: '', requireVerifiedEmail: true })).status, 200);
});

test('another identity provider: the links to the old one are reset', async () => {
  const moved = await setSso({ issuer: `${idp.issuer}/moved` });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.users.some((u) => u.ssoLinked), false);
  assert.equal(moved.body.signIn.security.sso.clientSecretSet, true, 'the same host keeps the secret');
  assert.match(await reasons(), /changed: The identity provider changed: the single sign-on links of 2 people were reset\. Each is linked again at their next single sign-on\./);
  assert.equal((await setSso({ issuer: idp.issuer })).status, 200);
  assert.equal((await comeBack(browser(), { person: dev })).location, `${BASE}/`);
});

test('two-step sign-in is not asked for after single sign-on', async () => {
  const withPassword = browser();
  assert.equal((await withPassword('POST', '/api/session/password', { email: 'dev@acme.io', password: DEV_PASSWORD })).status, 201);
  const setup = await withPassword('POST', '/api/me/two-step/setup');
  assert.equal((await withPassword('POST', '/api/me/two-step/enable', { code: totp(setup.body.secret) })).status, 200);
  assert.equal((await browser()('POST', '/api/session/password', { email: 'dev@acme.io', password: DEV_PASSWORD })).body.twoStep, true, 'a password is asked for the code');
  const b = browser();
  const back = await comeBack(b, { person: dev });
  assert.equal(back.location, `${BASE}/`);
  assert.equal(await b.signedIn(), true, 'the provider has already made sure who this is');
  assert.equal((await admin('DELETE', `/api/iam/users/${devId}/two-step`)).status, 200);
});

test('wrong state: an answer that belongs to no sign-in from this browser signs nobody in', async () => {
  // Made up.
  const a = browser();
  await leave(a);
  await assertRefused(a, await a('GET', `${CALLBACK}?code=x&state=${randomBytes(32).toString('base64url')}`), 'expired', /refused: Single sign-on refused: the answer belongs to no sign-in started from this browser in the last ten minutes \(state\)\./);
  // Someone else's: a link to the way back, made in one browser and opened in another (how a person would be signed in as someone else).
  const attacker = browser();
  const { query } = await leave(attacker);
  const link = `${CALLBACK}?code=${idp.grant(query, as({ person: dev }))}&state=${query.get('state')}`;
  const victim = browser();
  await assertRefused(victim, await victim('GET', link), 'expired');
  const started = browser();
  await leave(started);
  await assertRefused(started, await started('GET', link), 'expired', null);
  // And it is used up by the try: the browser that started it cannot finish it either.
  await assertRefused(attacker, await attacker('GET', link), 'expired');
  // No state at all, or several.
  const none = browser();
  await leave(none);
  await assertRefused(none, await none('GET', `${CALLBACK}?code=x`), 'expired');
  await assertRefused(none, await none('GET', `${CALLBACK}?code=x&state=a&state=b`), 'expired');
});

test('wrong nonce: a token made for another sign-in is refused', async () => {
  const b = browser();
  await assertRefused(b, await comeBack(b, { person: dev, claims: { nonce: randomBytes(32).toString('base64url') } }), 'token', /refused: Single sign-on refused: the ID token does not belong to this sign-in \(nonce\)\./);
  const none = browser();
  await assertRefused(none, await comeBack(none, { person: dev, claims: { nonce: undefined } }), 'token');
});

test('an expired token is refused', async () => {
  const b = browser();
  const past = Math.floor(Date.now() / 1000) - 3600;
  await assertRefused(b, await comeBack(b, { person: dev, claims: { iat: past - 300, exp: past } }), 'token', /refused: Single sign-on refused: the ID token has expired\./);
});

test('wrong audience: a token made for another application is refused', async () => {
  const b = browser();
  await assertRefused(b, await comeBack(b, { person: dev, claims: { aud: 'another-app' } }), 'token', /refused: Single sign-on refused: the ID token was made for another application \(audience\)\./);
  const several = browser();
  await assertRefused(several, await comeBack(several, { person: dev, claims: { aud: [idp.clientId, 'another-app'], azp: 'another-app' } }), 'token', /several audiences and another authorized party/);
});

test('wrong issuer: a token from another provider is refused', async () => {
  const b = browser();
  await assertRefused(b, await comeBack(b, { person: dev, claims: { iss: 'https://login.evil.example/realms/acme' } }), 'token', /refused: Single sign-on refused: the ID token comes from another issuer\./);
});

test('a token signed with another key is refused', async () => {
  const other = signingKey('RS256');
  const b = browser();
  await assertRefused(b, await comeBack(b, { person: dev, key: other }), 'token', /refused: Single sign-on refused: the ID token is signed with a key the identity provider does not publish\./);
  // …even when it claims the provider's own key id.
  const same = browser();
  await assertRefused(same, await comeBack(same, { person: dev, key: other, sign: { header: { kid: idp.key.kid } } }), 'token', /the ID token's signature does not match the identity provider's key/);
});

test('"alg none" and shared-secret algorithms are refused', async () => {
  const b = browser();
  await assertRefused(b, await comeBack(b, { person: dev, sign: { alg: 'none' } }), 'token', /refused: Single sign-on refused: the ID token is signed with "none", which is not accepted \(only RS256, PS256, ES256\)\./);
  // HS256 with the provider's public key as the secret.
  const hs = browser();
  await assertRefused(hs, await comeBack(hs, { person: dev, sign: { alg: 'HS256', secret: idp.key.publicKey.export({ type: 'spki', format: 'pem' }) } }), 'token', /signed with "HS256", which is not accepted/);
  const junk = browser();
  await assertRefused(junk, await comeBack(junk, { idToken: 'not.a.token' }), 'token');
});

test('an unverified email is refused, unless an Admin turns that check off', async () => {
  const b = browser();
  await assertRefused(b, await comeBack(b, { person: { ...dev, email_verified: false } }), 'email', /refused: Single sign-on refused: the identity provider does not mark dev@acme\.io as verified\./);
  const silent = browser();
  await assertRefused(silent, await comeBack(silent, { person: { email: 'dev@acme.io' } }), 'email', null);
  const nothing = browser();
  await assertRefused(nothing, await comeBack(nothing, { person: {} }), 'email', /the identity provider gave no email address/);

  assert.equal((await setSso({ requireVerifiedEmail: false })).status, 200);
  assert.match(await reasons(), /changed: Changed single sign-on: verified email check\./);
  const trusting = browser();
  assert.equal((await comeBack(trusting, { person: { ...dev, email_verified: false } })).location, `${BASE}/`);
  assert.equal(await trusting.signedIn(), true);
  assert.equal((await setSso({ requireVerifiedEmail: true })).status, 200);
});

test('the email comes from userinfo when the token has none, and only for the same person', async () => {
  const b = browser();
  const back = await comeBack(b, { person: { name: 'Dev' }, userinfo: { email: 'DEV@acme.io', email_verified: true } });
  assert.equal(back.location, `${BASE}/`);
  assert.equal((await b('GET', '/api/me')).body.user.email, 'dev@acme.io');
  assert.ok(idp.requests.some((r) => r.path.endsWith('/userinfo') && /^Bearer /.test(r.headers.authorization)));
});

test('an unknown person is refused; added only when an Admin chose that, with the role chosen', async () => {
  const stranger = { email: 'stranger@acme.io', email_verified: true, name: 'Stranger' };
  const b = browser();
  await assertRefused(b, await comeBack(b, { person: stranger }), 'unknown', /refused: Single sign-on refused: stranger@acme\.io is not in People & roles\./);
  assert.equal((await admin('GET', '/api/iam')).body.users.some((u) => u.email === 'stranger@acme.io'), false, 'nobody was added');

  // Adding people by themselves needs an email domain to hold them to.
  const open = await setSso({ provision: 'create', role: 'user' });
  assert.equal(open.status, 400);
  assert.match(open.body.error, /List at least one email domain allowed before adding people at their first single sign-on/);
  assert.equal((await setSso({ provision: 'create', role: 'user', domains: 'acme.io' })).status, 200);
  assert.equal((await setSso({ domains: '' })).status, 400, 'nor can the last domain be taken out while people are added');
  const outsider = browser();
  await assertRefused(outsider, await comeBack(outsider, { person: { email: 'stranger@other.example', email_verified: true } }), 'domain', /refused: Single sign-on refused: stranger@other\.example is not in an allowed email domain\./);
  const added = browser();
  assert.equal((await comeBack(added, { person: stranger })).location, `${BASE}/`);
  const me = (await added('GET', '/api/me')).body;
  assert.deepEqual([me.user.email, me.user.name, me.role.id, me.user.hasPassword, me.via], ['stranger@acme.io', 'Stranger', 'user', false, 'sso']);
  const said = await reasons();
  assert.match(said, /changed: Added stranger@acme\.io as User at their first single sign-on\./);
  assert.match(said, /info: stranger@acme\.io signed in with single sign-on\./);
  assert.equal((await browser()('POST', '/api/session/password', { email: 'stranger@acme.io', password: '' })).status, 401, 'no password was set for them');

  // Signed in by single sign-on, they cannot give themselves a password: it would keep them in after they are gone at the provider.
  const own = `own-${randomBytes(12).toString('base64url')}`;
  const tried = await added('POST', '/api/me/password', { next: own });
  assert.equal(tried.status, 403);
  assert.match(tried.body.error, /You signed in with single sign-on and have no password here, so you cannot set one yourself\. An administrator can give you one under People & roles\./);
  assert.equal((await added('POST', '/api/me/password', { current: '', next: own })).status, 403);
  assert.equal((await added('GET', '/api/me')).body.user.hasPassword, false);
  assert.equal((await browser()('POST', '/api/session/password', { email: 'stranger@acme.io', password: own })).status, 401);
  // Someone who has a password still changes it with the current one, as always; and an Admin can give the stranger one.
  const known = browser();
  await comeBack(known, { person: dev });
  assert.equal((await known('POST', '/api/me/password', { next: own })).status, 400, 'the current password is asked for');
  const strangerId = (await admin('GET', '/api/iam')).body.users.find((u) => u.email === 'stranger@acme.io').id;
  assert.equal((await admin('POST', `/api/iam/users/${strangerId}/password`, { password: own })).status, 200);

  // Removed, they are added again at their next single sign-on: disabling is what keeps someone out.
  assert.equal((await admin('DELETE', `/api/iam/users/${strangerId}`)).status, 200);
  const again = browser();
  assert.equal((await comeBack(again, { person: stranger })).location, `${BASE}/`, 'added again');
  const againId = (await admin('GET', '/api/iam')).body.users.find((u) => u.email === 'stranger@acme.io').id;
  assert.equal((await admin('PATCH', `/api/iam/users/${againId}`, { disabled: true })).status, 200);
  const out = browser();
  await assertRefused(out, await comeBack(out, { person: stranger }), 'disabled');
  assert.equal((await setSso({ provision: 'existing', domains: '' })).status, 200);
});

test('a disabled person is refused', async () => {
  const b = browser();
  await assertRefused(b, await comeBack(b, { person: { email: 'gone@acme.io', email_verified: true } }), 'disabled', /refused: Single sign-on refused for gone@acme\.io: the account is disabled\./);
});

test('the provider says no, or is down: a plain sentence for the person, the provider\'s own words nowhere', async () => {
  const cancelled = browser();
  const { query } = await leave(cancelled);
  const answer = await cancelled('GET', `${CALLBACK}?error=access_denied&error_description=${encodeURIComponent('<b>internal</b> policy 42 denied dev@acme.io')}&state=${query.get('state')}`);
  await assertRefused(cancelled, answer, 'cancelled', /refused: Single sign-on refused: the identity provider answered access_denied\./);
  // A wrong code: the provider's token address refuses it.
  const wrong = browser();
  const started = await leave(wrong);
  await assertRefused(wrong, await wrong('GET', `${CALLBACK}?code=made-up&state=${started.query.get('state')}`), 'provider', /the identity provider did not accept the code \(HTTP 400, invalid_grant\)/);
  const text = `${JSON.stringify(await auditLog())}\n${log}`;
  assert.doesNotMatch(text, /internal detail|policy 42|error_description/, 'never the provider\'s own error text');
});

test('with single sign-on on, passwords still work; "only Admins" keeps them for Admins', async () => {
  assert.equal((await browser()('POST', '/api/session/password', { email: 'dev@acme.io', password: DEV_PASSWORD })).status, 201, 'available by default');
  assert.equal((await setSso({ passwordAdminsOnly: true })).status, 200);
  assert.match(await reasons(), /changed: Changed single sign-on: passwords for Admins only\./);
  assert.deepEqual((await browser()('GET', '/api/session')).body.sso, { label: 'Sign in with Acme', passwordAdminsOnly: true });

  const b = browser();
  const refused = await b('POST', '/api/session/password', { email: 'dev@acme.io', password: DEV_PASSWORD });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /turned off for this account\. Use single sign-on\./);
  assert.equal(await b.signedIn(), false);
  assert.equal((await b('POST', '/api/session/password', { email: 'dev@acme.io', password: `wrong-${randomBytes(6).toString('hex')}` })).status, 401, 'a wrong password learns nothing about it');
  assert.match(await reasons(), /refused: Sign-in refused for dev@acme\.io: only Admins may sign in with a password; everyone else uses single sign-on\./);
  assert.equal((await browser()('POST', '/api/session/password', { email: 'admin@acme.io', password: NEXT_PASSWORD })).status, 201, 'an Admin still gets in, whatever happens to the provider');
  const viaSso = browser();
  assert.equal((await comeBack(viaSso, { person: dev })).location, `${BASE}/`);

  assert.equal((await setSso({ passwordAdminsOnly: false })).status, 200);
  assert.equal((await browser()('POST', '/api/session/password', { email: 'dev@acme.io', password: DEV_PASSWORD })).status, 201);
});

test('while single sign-on is on, only an Admin changes the server address, and never into one that breaks it', async () => {
  assert.equal((await setSso({ passwordAdminsOnly: true })).status, 200);
  const address = (b, value) => b('PUT', '/api/settings', { links: { reportServerUrl: value } });
  // Someone who may set links but is not an Admin (the Security Analyst): no change at all.
  for (const value of ['http://mz.example', 'https://mz.example', 'http://127.0.0.1:1']) {
    const r = await address(analyst, value);
    assert.equal(r.status, 400, value);
    assert.match(r.body.error, /Single sign-on is on, and the identity provider sends people back to this server's address, so only an Admin changes it\./);
  }
  // An Admin: not into an address the way back cannot use. They turn single sign-on off first.
  const broken = await address(admin, 'http://mz.example');
  assert.equal(broken.status, 400);
  assert.match(broken.body.error, /it must stay an https address\. Give an https address, or turn single sign-on off first \(People & roles → Sign-in\)\./);
  const uploaded = await admin('POST', '/api/settings/import-env', { text: 'REPORT_SERVER_URL=http://mz.example\n' });
  assert.equal(uploaded.status, 400, 'nor with an uploaded .env file');
  assert.equal((await admin('GET', '/api/settings')).body.links.reportServerUrl ?? '', '');
  // Nothing changed: the button is there, and a password is still not enough for someone who is not an Admin.
  assert.deepEqual((await browser()('GET', '/api/session')).body.sso, { label: 'Sign in with Acme', passwordAdminsOnly: true });
  assert.equal((await browser()('POST', '/api/session/password', { email: 'dev@acme.io', password: DEV_PASSWORD })).status, 403);
  // An https address is the Admin's to give; taking it out again goes back to the deployment's own (REPORT_SERVER_URL).
  assert.equal((await address(admin, 'https://mz.example')).status, 200);
  assert.equal((await admin('GET', '/api/iam')).body.signIn.security.redirectUri, `https://mz.example${CALLBACK}`);
  assert.equal((await address(admin, '')).status, 200);
  assert.equal((await admin('GET', '/api/iam')).body.signIn.security.redirectUri, `${BASE}${CALLBACK}`);

  // An address saved while single sign-on was off, and not https: the deployment's own is used, so turning it on works.
  assert.equal((await setSso({ enabled: false })).status, 200);
  assert.equal((await address(analyst, 'http://mz.example')).status, 200, 'with single sign-on off, the address is theirs to change as before');
  assert.equal((await setSso({ enabled: true, passwordAdminsOnly: true })).status, 200);
  assert.equal((await admin('GET', '/api/iam')).body.signIn.security.redirectUri, `${BASE}${CALLBACK}`);
  assert.equal((await comeBack(browser(), { person: dev })).location, `${BASE}/`);
  assert.equal((await browser()('POST', '/api/session/password', { email: 'dev@acme.io', password: DEV_PASSWORD })).status, 403);
  assert.equal((await address(admin, '')).status, 200);
  assert.equal((await setSso({ passwordAdminsOnly: false })).status, 200);
});

test('nothing secret reaches the audit log or the server log: no token, no code, no client secret', async () => {
  const text = `${JSON.stringify(await auditLog())}\n${log}`;
  assert.doesNotMatch(text, new RegExp(idp.clientSecret));
  assert.doesNotMatch(text, /eyJ[A-Za-z0-9_-]{10,}\.eyJ/, 'no token');
  assert.doesNotMatch(text, /code_verifier|access_token|id_token"/);
  for (const request of idp.requests.filter((r) => r.path.endsWith('/token'))) {
    const form = new URLSearchParams(request.body);
    assert.doesNotMatch(text, new RegExp(form.get('code_verifier')));
  }
  assert.match(log, /! \[single sign-on\] Not signed in \(token\): the ID token has expired\./, 'a scrubbed line for the Admin');
});

test('turned off again: the button goes, and an answer on its way back is refused', async () => {
  const b = browser();
  const { query } = await leave(b);
  const code = idp.grant(query, as({ person: dev }));
  const off = await setSso({ enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.signIn.security.sso.enabled, false);
  assert.equal(off.body.signIn.security.sso.clientSecretSet, true, 'the settings are kept for the next time');
  assert.equal((await browser()('GET', '/api/session')).body.sso, null);
  await assertRefused(b, await b('GET', `${CALLBACK}?code=${code}&state=${query.get('state')}`), 'off', /Single sign-on refused: single sign-on is turned off\./);
  const again = browser();
  assert.equal((await again('GET', '/api/session/oidc/start')).location, '/#sso=off');
  // Taking the secret out leaves no copy of it on the disk.
  assert.equal((await setSso({ clientSecret: null })).body.signIn.security.sso.clientSecretSet, false);
  for (const file of ['iam.json', 'iam.json.bak']) {
    const full = path.join(dataDir, file);
    assert.equal(fs.existsSync(full) && fs.readFileSync(full, 'utf8').includes(idp.clientSecret), false, file);
  }
});
