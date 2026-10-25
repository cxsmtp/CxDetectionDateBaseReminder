import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  SESSION_COOKIE,
  SessionStore,
  describeSession,
  readSessionCookie,
} from '../src/session.js';

const apiKey = (tenant) =>
  [
    'header',
    Buffer.from(JSON.stringify({ iss: `https://eu.iam.checkmarx.net/auth/realms/${tenant}` })).toString(
      'base64url',
    ),
    'signature',
  ].join('.');

/** Stand-in for the Checkmarx One token + projects endpoints. */
async function startStub({ tokenStatus = 200, projectsStatus = 200 } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    if (req.url.includes('openid-connect/token')) {
      res.writeHead(tokenStatus, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(tokenStatus === 200 ? { access_token: 't', expires_in: 300 } : {}));
    }
    res.writeHead(projectsStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ totalCount: 0, projects: [] }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, calls, close: () => new Promise((r) => server.close(r)) };
}

test('create verifies the key and the API host, then opens a session', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());

  const store = new SessionStore();
  const session = await store.create(apiKey('acme'), { iamUrl: stub.origin, baseUrl: stub.origin });

  assert.equal(session.connection.tenant, 'acme');
  assert.equal(store.size, 1);
  // Both the token exchange and the probe call must have happened.
  assert.ok(stub.calls.some((url) => url.includes('openid-connect/token')));
  assert.ok(stub.calls.some((url) => url.startsWith('/api/projects')));
});

test('create rejects a bad key without leaving a session behind', async (t) => {
  const stub = await startStub({ tokenStatus: 401 });
  t.after(() => stub.close());

  const store = new SessionStore();
  await assert.rejects(
    store.create(apiKey('acme'), { iamUrl: stub.origin, baseUrl: stub.origin }),
    /invalid, revoked or expired/,
  );
  assert.equal(store.size, 0);
});

test('create surfaces a wrong API host separately from a bad key', async (t) => {
  const stub = await startStub({ projectsStatus: 404 });
  t.after(() => stub.close());

  const store = new SessionStore();
  await assert.rejects(
    store.create(apiKey('acme'), { iamUrl: stub.origin, baseUrl: stub.origin }),
    /404/,
  );
  assert.equal(store.size, 0);
});

test('sessions expire once idle and can be destroyed explicitly', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());

  const store = new SessionStore({ idleMs: 20 });
  const session = await store.create(apiKey('acme'), { iamUrl: stub.origin, baseUrl: stub.origin });

  assert.ok(store.get(session.id));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(store.get(session.id), null, 'idle session should be gone');

  const fresh = await store.create(apiKey('acme'), { iamUrl: stub.origin, baseUrl: stub.origin });
  assert.equal(store.destroy(fresh.id), true);
  assert.equal(store.get(fresh.id), null);
});

test('get returns null for unknown ids', () => {
  const store = new SessionStore();
  assert.equal(store.get(undefined), null);
  assert.equal(store.get('nope'), null);
});

test('describeSession hides the API key from the browser payload', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());

  const key = apiKey('acme');
  const store = new SessionStore();
  const session = await store.create(key, { iamUrl: stub.origin, baseUrl: stub.origin });
  const described = describeSession(session);

  assert.equal(described.connected, true);
  assert.equal(described.connection.apiKey, undefined);
  assert.ok(!JSON.stringify(described).includes(key));
});

test('readSessionCookie picks its cookie out of a crowded header', () => {
  assert.equal(readSessionCookie({ headers: {} }), null);
  assert.equal(readSessionCookie({ headers: { cookie: 'a=1; b=2' } }), null);
  assert.equal(readSessionCookie({ headers: { cookie: `a=1; ${SESSION_COOKIE}=abc-123; b=2` } }), 'abc-123');
});

test('the session cookie is Secure wherever the browser is known to be on HTTPS, and plain http still signs in', async () => {
  const { setSessionCookie, cookieShouldBeSecure } = await import('../src/session.js');
  const cookieFor = (req) => {
    const set = [];
    setSessionCookie({ headers: {}, ...req }, { append: (name, value) => set.push(value) }, 'abc');
    return set[0];
  };
  // HTTPS here, or at a proxy named in TRUST_PROXY (Express sets req.secure).
  assert.match(cookieFor({ secure: true }), /; Secure$/);
  // A proxy that does TLS but is not named in TRUST_PROXY, or a page that says it is on https.
  assert.match(cookieFor({ headers: { 'x-forwarded-proto': 'https' } }), /; Secure$/);
  assert.match(cookieFor({ headers: { 'x-forwarded-proto': 'HTTPS, http' } }), /; Secure$/);
  assert.match(cookieFor({ headers: { origin: 'https://mz.acme.io' } }), /; Secure$/);
  assert.match(cookieFor({ headers: { referer: 'https://mz.acme.io/#settings' } }), /; Secure$/);
  // Plain http on a local network: no Secure, or the browser would drop the cookie and nobody could sign in.
  const plain = cookieFor({ headers: { origin: 'http://10.0.0.5:3000', referer: 'https://elsewhere.example/' } });
  assert.doesNotMatch(plain, /Secure/);
  assert.match(plain, new RegExp(`^${SESSION_COOKIE}=abc; Path=/; HttpOnly; SameSite=Lax$`));
  assert.equal(cookieShouldBeSecure({ headers: { 'x-forwarded-proto': 'http' } }), false);
  assert.equal(cookieShouldBeSecure({ headers: {} }), false);
});
