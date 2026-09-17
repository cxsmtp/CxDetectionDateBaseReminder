import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ConnectionError,
  deriveApiUrl,
  deriveConnection,
  publicConnection,
  regionFromHost,
  regionLabel,
} from '../src/cxone/endpoints.js';
import { configProblems, loadConfig } from '../src/config.js';
import { ACCEPT, extractItems, mapWithConcurrency } from '../src/cxone/client.js';

const apiKey = (claims) =>
  ['header', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join('.');

const euKey = apiKey({ iss: 'https://eu.iam.checkmarx.net/auth/realms/acme-corp', exp: 1_900_000_000 });

test('deriveConnection reads tenant, region and both hosts from the API key alone', () => {
  const connection = deriveConnection(euKey);

  assert.equal(connection.tenant, 'acme-corp');
  assert.equal(connection.iamUrl, 'https://eu.iam.checkmarx.net');
  assert.equal(connection.baseUrl, 'https://eu.ast.checkmarx.net');
  assert.equal(connection.region, 'eu');
  assert.equal(connection.regionLabel, 'EU');
  assert.equal(
    connection.tokenUrl,
    'https://eu.iam.checkmarx.net/auth/realms/acme-corp/protocol/openid-connect/token',
  );
});

test('deriveApiUrl handles prefixed, unprefixed and already-ast hosts', () => {
  assert.equal(deriveApiUrl('https://eu.iam.checkmarx.net'), 'https://eu.ast.checkmarx.net');
  assert.equal(deriveApiUrl('https://iam.checkmarx.net'), 'https://ast.checkmarx.net');
  assert.equal(deriveApiUrl('https://us.ast.checkmarx.net'), 'https://us.ast.checkmarx.net');
  assert.equal(deriveApiUrl('https://cx.internal.example.com'), 'https://cx.internal.example.com');
  assert.equal(deriveApiUrl('nonsense'), '');
});

test('regionFromHost and regionLabel cover known and unknown regions', () => {
  assert.equal(regionFromHost('deu.iam.checkmarx.net'), 'deu');
  assert.equal(regionFromHost('iam.checkmarx.net'), 'us');
  assert.equal(regionFromHost('cx.internal.example.com'), '');
  assert.equal(regionLabel('deu'), 'Germany');
  assert.equal(regionLabel('zzz'), 'ZZZ');
  assert.equal(regionLabel(''), 'Custom / single-tenant');
});

test('deriveConnection rejects malformed and non-Checkmarx keys with actionable messages', () => {
  assert.throws(() => deriveConnection(''), (e) => e instanceof ConnectionError && /Paste your/.test(e.message));
  assert.throws(() => deriveConnection('not-a-jwt'), /three dot-separated parts/);
  assert.throws(() => deriveConnection(apiKey({ sub: 'nobody' })), /tenant issuer claim/);
});

test('overrides win over values derived from the key', () => {
  const connection = deriveConnection(euKey, {
    baseUrl: 'https://cx.internal.example.com/',
    tenant: 'on-prem',
  });

  assert.equal(connection.baseUrl, 'https://cx.internal.example.com');
  assert.equal(connection.tenant, 'on-prem');
  assert.equal(
    connection.tokenUrl,
    'https://eu.iam.checkmarx.net/auth/realms/on-prem/protocol/openid-connect/token',
  );
});

test('publicConnection never exposes the API key', () => {
  const safe = publicConnection(deriveConnection(euKey));
  assert.equal(safe.apiKey, undefined);
  assert.equal(safe.tenant, 'acme-corp');
  assert.ok(!JSON.stringify(safe).includes(euKey));
});

test('config carries no credential and defaults to the documented risks path', () => {
  const config = loadConfig({});
  assert.deepEqual(configProblems(config), []);
  assert.equal(config.risks.path, '/api/risks/');
  assert.equal(config.bootstrapApiKey, '');
  assert.match(configProblems(loadConfig({ CX_RISK_SOURCE: 'guesswork' })).join(' '), /not one of/);
});

test('the Accept header carries the API version the risks endpoint requires', () => {
  // Without "version=", Checkmarx One answers 400 Bad Request.
  assert.match(ACCEPT, /version\s*=\s*1\.0/);
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
