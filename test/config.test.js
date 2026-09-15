import test from 'node:test';
import assert from 'node:assert/strict';

import { configProblems, deriveEndpoints, loadConfig } from '../src/config.js';
import { extractRecipients } from '../src/cxone/feedbackApps.js';
import { extractItems, mapWithConcurrency } from '../src/cxone/client.js';

const fakeApiKey = (claims) =>
  ['header', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

test('deriveEndpoints reads tenant and hosts out of the API key', () => {
  const key = fakeApiKey({ iss: 'https://eu.iam.checkmarx.net/auth/realms/acme-corp' });
  assert.deepEqual(deriveEndpoints(key), {
    iamUrl: 'https://eu.iam.checkmarx.net',
    tenant: 'acme-corp',
    baseUrl: 'https://eu.ast.checkmarx.net',
  });
});

test('deriveEndpoints returns nothing useful for a malformed key', () => {
  assert.deepEqual(deriveEndpoints('not-a-jwt'), {});
  assert.deepEqual(deriveEndpoints(fakeApiKey({ sub: 'x' })), {});
});

test('explicit env vars win over values derived from the API key', () => {
  const config = loadConfig({
    CX_API_KEY: fakeApiKey({ iss: 'https://eu.iam.checkmarx.net/auth/realms/acme' }),
    CX_BASE_URL: 'https://cx.internal.example.com/',
    CX_TENANT: 'override',
  });

  assert.equal(config.baseUrl, 'https://cx.internal.example.com');
  assert.equal(config.tenant, 'override');
  assert.equal(config.tokenUrl, 'https://eu.iam.checkmarx.net/auth/realms/override/protocol/openid-connect/token');
  assert.deepEqual(configProblems(config), []);
});

test('configProblems reports a missing API key', () => {
  assert.match(configProblems(loadConfig({})).join(' '), /CX_API_KEY is not set/);
});

test('extractRecipients finds emails wherever the feedback app keeps them', () => {
  assert.deepEqual(extractRecipients({ config: { recipients: 'a@x.com, b@x.com' } }), ['a@x.com', 'b@x.com']);
  assert.deepEqual(extractRecipients({ emails: [{ email: 'c@x.com' }, 'not-an-email'] }), ['c@x.com']);
  assert.deepEqual(extractRecipients({ settings: { to: ['d@x.com', 'd@x.com'] } }), ['d@x.com']);
  assert.deepEqual(extractRecipients({ name: 'Slack' }), []);
});

test('extractItems unwraps the various response envelopes', () => {
  assert.deepEqual(extractItems([1, 2]), [1, 2]);
  assert.deepEqual(extractItems({ projects: [1] }, 'projects'), [1]);
  assert.deepEqual(extractItems({ results: [2] }), [2]);
  assert.deepEqual(extractItems({ weirdKey: [3] }), [3]);
  assert.deepEqual(extractItems({ totalCount: 0 }), []);
});

test('mapWithConcurrency preserves order while bounding parallelism', async () => {
  let active = 0;
  let peak = 0;

  const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });

  assert.deepEqual(result, [2, 4, 6, 8, 10, 12]);
  assert.ok(peak <= 2, `peak concurrency was ${peak}`);
});
