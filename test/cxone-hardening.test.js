// Checkmarx One addresses and credentials (scan 7a769856): the API key's issuer and the Admin's endpoints
// are checked before the key or a token is sent anywhere (SSRF), and no token, key or signature reaches an
// error message (secret leak in error messages).
import test from 'node:test';
import assert from 'node:assert/strict';

import { TokenProvider } from '../src/cxone/auth.js';
import { CxApiError, CxClient } from '../src/cxone/client.js';
import { clearDirectoryCache, fetchDirectory } from '../src/cxone/directory.js';
import { ConnectionError, checkServiceUrl, deriveConnection, scrubText } from '../src/cxone/endpoints.js';
import { PASSPHRASE, proxyWithLogin } from './test-credentials.js';

const key = (claims) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const jwt = (claims) => `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.c2lnbmF0dXJlLXZhbHVl`;

/** Run `fn` with fetch replaced, recording every address asked for. */
async function withFetch(answer, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (typeof init?.body?.destroy === 'function') {
      // A file stream nobody will read: closed before answering.
      const closed = new Promise((resolve) => init.body.once('close', resolve));
      init.body.destroy();
      await closed;
    }
    return answer(String(url), init);
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function inProduction(fn) {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
}

test('an API key whose issuer points at a metadata, link-local or disguised address is refused (SSRF)', () => {
  const refused = [
    'https://169.254.169.254/auth/realms/acme',
    'https://2852039166/auth/realms/acme', // 169.254.169.254 written as one number
    'https://[::ffff:169.254.169.254]/auth/realms/acme',
    'https://[fe80::1]/auth/realms/acme',
    'https://[fd00:ec2::254]/auth/realms/acme',
    'https://0.0.0.0/auth/realms/acme',
    'https://metadata.google.internal/auth/realms/acme',
    'https://eu.iam.checkmarx.net@169.254.169.254/auth/realms/acme', // userinfo hides the real host
    proxyWithLogin('https://eu.iam.checkmarx.net/auth/realms/acme'), // a user name and password, made at run time
    'https://intranet/auth/realms/acme', // not a full host name
    'http://10.0.0.5/auth/realms/acme',
  ];
  for (const iss of refused) {
    assert.throws(() => deriveConnection(key({ iss })), ConnectionError, iss);
  }
  // Nor through the Admin's own endpoints.
  const good = key({ iss: 'https://eu.iam.checkmarx.net/auth/realms/acme' });
  assert.throws(() => deriveConnection(good, { baseUrl: 'https://169.254.169.254' }), /API URL points at a link-local or cloud metadata address/);
  assert.throws(() => deriveConnection(good, { iamUrl: 'https://eu.iam.checkmarx.net/?next=//evil' }), /IAM URL must be a plain address/);
  assert.throws(() => deriveConnection(key({ iss: 'https://eu.iam.checkmarx.net/auth/realms/%E0%A4%A' })), /tenant name that cannot be read/);
});

test('ordinary Checkmarx One, single-tenant and local mock addresses still connect', () => {
  assert.equal(deriveConnection(key({ iss: 'https://eu.iam.checkmarx.net/auth/realms/acme' })).baseUrl, 'https://eu.ast.checkmarx.net');
  assert.equal(deriveConnection(key({ iss: 'https://cx.corp.example.com:8443/auth/realms/acme' })).iamUrl, 'https://cx.corp.example.com:8443');
  assert.equal(checkServiceUrl('https://10.20.0.7/', 'API URL'), 'https://10.20.0.7');
  assert.equal(checkServiceUrl('https://EU.ast.checkmarx.net/', 'API URL'), 'https://eu.ast.checkmarx.net');
  assert.equal(deriveConnection(key({ iss: 'http://127.0.0.1:4101/auth/realms/acme' })).iamUrl, 'http://127.0.0.1:4101');
});

test('in production this machine is never a Checkmarx One address, over http or https', () => {
  inProduction(() => {
    assert.throws(() => checkServiceUrl('http://127.0.0.1:4101', 'IAM URL'), /must be an https address/);
    assert.throws(() => checkServiceUrl('https://localhost', 'IAM URL'), /points at this machine/);
    assert.throws(() => checkServiceUrl('https://[::1]:8443', 'IAM URL'), /points at this machine/);
    assert.equal(checkServiceUrl('https://eu.iam.checkmarx.net', 'IAM URL'), 'https://eu.iam.checkmarx.net');
  });
});

test('the token exchange never goes to an unchecked IAM address, and its errors carry no key', async () => {
  const apiKey = jwt({ sub: 'svc', typ: 'Offline' });
  await withFetch(() => new Response('', { status: 200 }), async (calls) => {
    const tokens = new TokenProvider({ tokenUrl: 'https://169.254.169.254/auth/realms/a/protocol/openid-connect/token', apiKey });
    await assert.rejects(tokens.getToken(), /link-local or cloud metadata address/);
    assert.equal(calls.length, 0, 'nothing was sent');
  });
  // An IAM host that echoes what it was sent: the key is not repeated in the error.
  await withFetch(() => new Response(`bad gateway; refresh_token=${apiKey}`, { status: 502, statusText: 'Bad Gateway' }), async () => {
    const tokens = new TokenProvider({ tokenUrl: 'https://eu.iam.checkmarx.net/auth/realms/a/protocol/openid-connect/token', apiKey });
    const error = await tokens.getToken().then(() => null, (e) => e);
    assert.ok(error);
    assert.ok(!error.message.includes(apiKey), error.message);
    assert.ok(!String(error.detail).includes(apiKey));
  });
});

test('the access token is only ever sent to the connection\'s own Checkmarx One hosts', async () => {
  const token = jwt({ sub: 'u1', email: 'u1@acme.io' });
  const connection = { baseUrl: 'https://eu.ast.checkmarx.net', iamUrl: 'https://eu.iam.checkmarx.net', tokenUrl: 'https://eu.iam.checkmarx.net/auth/realms/a/protocol/openid-connect/token' };
  const client = new CxClient(connection, { getToken: async () => token, reset() {} });
  await withFetch(() => Response.json({ ok: true }), async (calls) => {
    for (const target of ['https://169.254.169.254/latest/meta-data/', 'https://evil.example/api/projects', '@evil.example/api/projects', proxyWithLogin('https://eu.ast.checkmarx.net/api/projects')]) {
      await assert.rejects(client.request(target, { retries: 0 }), /Refused to send the access token/, target);
      await assert.rejects(client.redirectOf(target), /Refused to send the access token/, target);
      await assert.rejects(client.download(target, '/dev/null'), /Refused to send the access token/, target);
    }
    assert.equal(calls.length, 0, 'nothing was sent');
    assert.deepEqual(await client.request('/api/projects', { retries: 0 }), { ok: true });
    assert.deepEqual(await client.request('https://eu.iam.checkmarx.net/auth/admin/realms/a/users?first=0&max=1', { retries: 0 }), { ok: true });
    assert.deepEqual(calls.map((c) => new URL(c.url).host), ['eu.ast.checkmarx.net', 'eu.iam.checkmarx.net']);
  });
});

test('Checkmarx One errors never repeat the access token, even when the answer echoes it', async () => {
  const token = jwt({ sub: 'u1' });
  const client = new CxClient({ baseUrl: 'https://eu.ast.checkmarx.net' }, { getToken: async () => token, reset() {} });
  const echo = `{"error":"denied","request":{"headers":{"Authorization":"Bearer ${token}"}},"access_token":"${token}"}`;
  await withFetch(() => new Response(echo, { status: 403, statusText: 'Forbidden' }), async () => {
    for (const run of [() => client.request('/api/projects', { retries: 0 }), () => client.redirectOf('/api/repostore/code/s1'), () => client.download('/api/repostore/code/s1', '/dev/null')]) {
      const error = await run().then(() => null, (e) => e);
      assert.ok(error instanceof CxApiError);
      assert.equal(error.status, 403);
      for (const text of [error.message, error.body, error.path, JSON.stringify(error)]) assert.ok(!String(text).includes(token), text);
    }
  });
});

test('scrubText hides bearer tokens, JWTs, signatures and URL passwords and keeps the rest', () => {
  const token = jwt({ sub: 'x' });
  assert.equal(scrubText(`Authorization: Bearer ${token}`), 'Authorization: Bearer [hidden]');
  assert.equal(scrubText(`key ${token} end`), 'key [hidden token] end');
  assert.equal(
    scrubText('https://s3.example.com/o?X-Amz-Expires=300&X-Amz-Signature=abc123&x=1'),
    'https://s3.example.com/o?X-Amz-Expires=300&X-Amz-Signature=[hidden]&x=1',
  );
  const withLogin = proxyWithLogin('https://proxy.example.com:8080');
  assert.ok(withLogin.includes(PASSPHRASE));
  assert.equal(scrubText(withLogin), 'https://[hidden]@proxy.example.com:8080');
  assert.equal(scrubText('GET /api/projects failed: 503 Service Unavailable'), 'GET /api/projects failed: 503 Service Unavailable');
});

test('the IAM user directory is not read from an unchecked IAM address', async () => {
  clearDirectoryCache();
  let asked = 0;
  const client = { request: async () => (asked++, []) };
  const result = await fetchDirectory(client, { iamUrl: 'https://169.254.169.254', tenant: 'acme' });
  assert.equal(asked, 0);
  assert.deepEqual(result.users, []);
  assert.match(result.note, /link-local or cloud metadata address/);
});

test('a storage or upload address on another host never gets the access token, even when it refuses without', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const token = jwt({ sub: 'u1' });
  const client = new CxClient({ baseUrl: 'https://eu.ast.checkmarx.net', iamUrl: 'https://eu.iam.checkmarx.net' }, { getToken: async () => token, reset() {} });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cx-upload-')), 'empty.zip');
  fs.writeFileSync(file, Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'binary'));
  const sentToken = (calls) => calls.map((c) => [new URL(c.url).host, Boolean(c.init?.headers?.Authorization)]);
  await withFetch(() => new Response('denied', { status: 403 }), async (calls) => {
    const probe = await client.probeUrl('https://storage.example.net/bucket/code.zip?X-Amz-Signature=abc');
    assert.equal(probe.auth, 'none');
    assert.equal(probe.tried, '403 without it');
    await assert.rejects(client.uploadFile('https://storage.example.net/upload?sig=abc', file), /PUT upload failed: 403 without it/);
    assert.deepEqual(sentToken(calls), [['storage.example.net', false], ['storage.example.net', false]], 'one try each, never with the token');
  });
  // On Checkmarx One's own host: with the token first, then once without it.
  await withFetch(() => new Response('denied', { status: 401 }), async (calls) => {
    const probe = await client.probeUrl('https://eu.ast.checkmarx.net/storage/code.zip');
    assert.equal(probe.tried, '401 with the access token, 401 without it');
    assert.deepEqual(sentToken(calls), [['eu.ast.checkmarx.net', true], ['eu.ast.checkmarx.net', false]]);
  });
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
