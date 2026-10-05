// Azure DevOps: the organisation written any way still gets its token, never another
// organisation's; and when the connection fails, it says what to change.
import test from 'node:test';
import assert from 'node:assert/strict';

import { azureOrgKey, azureOrgName, normalizeAzureOrgUrl } from '../src/scm/azure-url.js';
import { azureCheck, azureClient } from '../src/scm/azure.js';
import { checkConnections, cloneAuthFor, scmConfigs } from '../src/scm/providers.js';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/settings.js';

test('every way of writing the organisation is the same organisation', () => {
  for (const pasted of [
    'checkmarxdemo',
    'https://dev.azure.com/checkmarxdemo',
    'https://dev.azure.com/checkmarxdemo/',
    'dev.azure.com/checkmarxdemo',
    'https://dev.azure.com/checkmarxdemo/Payments',
    'https://dev.azure.com/checkmarxdemo/Payments/_git/api',
    'https://checkmarxdemo@dev.azure.com/checkmarxdemo/Payments/_git/api',
    'https://checkmarxdemo.visualstudio.com',
    'https://checkmarxdemo.visualstudio.com/Payments/_git/api',
    'https://vssps.dev.azure.com/checkmarxdemo',
  ]) {
    assert.equal(normalizeAzureOrgUrl(pasted), 'https://dev.azure.com/checkmarxdemo', pasted);
  }
  assert.equal(azureOrgKey('https://CheckmarxDemo.visualstudio.com/P/_git/r'), 'dev.azure.com/checkmarxdemo');
  assert.equal(azureOrgName('https://dev.azure.com/checkmarxdemo/Payments'), 'checkmarxdemo');
  // Azure DevOps Server keeps its collection; a repository or API path after it is dropped.
  assert.equal(normalizeAzureOrgUrl('https://tfs.acme.io/tfs/DefaultCollection/'), 'https://tfs.acme.io/tfs/DefaultCollection');
  assert.equal(normalizeAzureOrgUrl('https://tfs.acme.io/tfs/DefaultCollection/Payments/_git/api'), 'https://tfs.acme.io/tfs/DefaultCollection');
  assert.equal(normalizeAzureOrgUrl('https://tfs.acme.io/tfs/DefaultCollection/_apis/connectionData'), 'https://tfs.acme.io/tfs/DefaultCollection');
  assert.equal(azureOrgName('https://tfs.acme.io/tfs/DefaultCollection'), '');
  assert.equal(normalizeAzureOrgUrl(''), '');
});

test('saving: a project page or a bare name is stored as the organisation, and the token stays', () => {
  const merge = (current, azure) => mergeSettings({ ...DEFAULT_SETTINGS, beta: { ...DEFAULT_SETTINGS.beta, azure: current } }, { beta: { azure } }).beta.azure;
  const saved = merge({ orgUrl: '', token: '' }, { orgUrl: 'https://dev.azure.com/checkmarxdemo/Payments/_git/api', token: ' pat-123 ' });
  assert.equal(saved.orgUrl, 'https://dev.azure.com/checkmarxdemo');
  assert.equal(saved.token, 'pat-123', 'spaces around a pasted token are dropped');
  // The same organisation written another way keeps the token...
  assert.equal(merge(saved, { orgUrl: 'https://checkmarxdemo.visualstudio.com' }).token, 'pat-123');
  assert.equal(merge(saved, { orgUrl: 'checkmarxdemo' }).token, 'pat-123');
  // ...another organisation on the same host does not.
  assert.equal(merge(saved, { orgUrl: 'https://dev.azure.com/other-org' }).token, '');
  assert.throws(() => merge(saved, { orgUrl: 'http://evil.example/x' }), /https/);
});

test('connections: an address stored before this fix (a project page) works, and the .env token follows the organisation', () => {
  const stored = scmConfigs({ beta: { azure: { orgUrl: 'https://dev.azure.com/checkmarxdemo/Payments', token: 'pat' } } }, {});
  assert.equal(stored.azure.orgUrl, 'https://dev.azure.com/checkmarxdemo');
  const fromEnv = (url, envUrl) => scmConfigs({ beta: { azure: { orgUrl: url } } }, { AZURE_DEVOPS_TOKEN: 'envpat', ...(envUrl ? { AZURE_DEVOPS_ORG_URL: envUrl } : {}) }).azure.token;
  assert.equal(fromEnv('https://checkmarxdemo.visualstudio.com', 'https://dev.azure.com/checkmarxdemo'), 'envpat', 'same organisation, older address');
  assert.equal(fromEnv('', 'checkmarxdemo'), 'envpat');
  assert.equal(fromEnv('https://dev.azure.com/checkmarxdemo', ''), 'envpat', 'the .env names no organisation: any on dev.azure.com');
  assert.equal(fromEnv('https://dev.azure.com/other-org', 'https://dev.azure.com/checkmarxdemo'), '', "never another organisation's");
  assert.equal(fromEnv('https://tfs.acme.io/tfs/Default', ''), '', 'nor a Server it was not given for');
});

test('git clones: the token goes to the organisation’s repositories in either address form, and nowhere else', () => {
  const configs = scmConfigs({ beta: { azure: { orgUrl: 'checkmarxdemo', token: 'pat' } } }, {});
  const basic = (header) => Buffer.from(header.replace(/^Basic /, ''), 'base64').toString();
  assert.equal(basic(cloneAuthFor('https://dev.azure.com/checkmarxdemo/P/_git/api', configs)), ':pat');
  assert.equal(basic(cloneAuthFor('https://checkmarxdemo.visualstudio.com/P/_git/api', configs)), ':pat');
  assert.equal(basic(cloneAuthFor('https://checkmarxdemo@dev.azure.com/checkmarxdemo/P/_git/api', configs)), ':pat');
  assert.equal(cloneAuthFor('https://dev.azure.com/other-org/P/_git/api', configs), '');
  assert.equal(cloneAuthFor('https://other-org.visualstudio.com/P/_git/api', configs), '');
  assert.equal(cloneAuthFor('https://github.com/checkmarxdemo/api.git', configs), '');
  const server = scmConfigs({ beta: { azure: { orgUrl: 'https://tfs.acme.io/tfs/Default', token: 'spat' } } }, {});
  assert.equal(basic(cloneAuthFor('https://tfs.acme.io/tfs/Default/P/_git/api', server)), ':spat');
  assert.equal(cloneAuthFor('https://tfs.other.io/tfs/Default/P/_git/api', server), '');
});

const answer = (status, body) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('the connection check says what to change', async () => {
  const cfg = { orgUrl: 'https://dev.azure.com/checkmarxdemo', token: 'pat' };
  const ok = await azureCheck(azureClient(cfg, answer(200, { authenticatedUser: { providerDisplayName: 'Sean Casey' } })));
  assert.deepEqual(ok, { ok: true, who: 'Sean Casey', organisation: 'checkmarxdemo' });

  // A wrong, expired or revoked token: Azure DevOps answers 200, as Anonymous.
  await assert.rejects(azureCheck(azureClient(cfg, answer(200, { authenticatedUser: { providerDisplayName: 'Anonymous' } }))), (error) => /not accepted for the organisation "checkmarxdemo"/.test(error.message) && /expired/.test(error.message));
  await assert.rejects(azureCheck(azureClient(cfg, answer(401, { message: 'nope' }))), /refused for https:\/\/dev\.azure\.com\/checkmarxdemo \(401\)/);
  await assert.rejects(azureCheck(azureClient({ ...cfg, orgUrl: 'https://tfs.acme.io/tfs/Wrong' }, answer(404, 'Not found'))), /no Azure DevOps organisation at https:\/\/tfs\.acme\.io\/tfs\/Wrong/);
});

test('a token without the organisation is reported, not silently ignored', async () => {
  const configs = scmConfigs({ beta: { azure: { orgUrl: '', token: 'pat' } } }, {});
  const result = await checkConnections({ gitlab: null, azure: null, bitbucket: null }, configs, ['azure']);
  assert.equal(result.azure.ok, false);
  assert.match(result.azure.reason, /add the organisation/);
});
