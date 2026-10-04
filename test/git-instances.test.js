// More than one connection to the same git host: GITHUB_TOKEN_2, GITLAB_URL_2 …
import test from 'node:test';
import assert from 'node:assert/strict';

import { settingsFromEnv, isSecretVariable } from '../src/env-import.js';
import { extraInstanceNumbers, instanceSource, mergeStoredInstances, numberedVariable, providersIn, setForRepo } from '../src/scm/instances.js';
import { scmConfigs } from '../src/scm/providers.js';
import { publicSettings, DEFAULT_SETTINGS } from '../src/settings.js';

test('numbered variables are the plain ones with _2 … _9, for the four hosts only', () => {
  assert.deepEqual(numberedVariable('GITLAB_TOKEN_2'), { name: 'GITLAB_TOKEN', provider: 'gitlab', n: 2 });
  assert.deepEqual(numberedVariable('AZURE_DEVOPS_ORG_URL_9'), { name: 'AZURE_DEVOPS_ORG_URL', provider: 'azure', n: 9 });
  assert.equal(numberedVariable('GITHUB_TOKEN_1'), null);
  assert.equal(numberedVariable('GITHUB_TOKEN_10'), null);
  assert.equal(numberedVariable('SMTP_PASS_2'), null);
  assert.ok(isSecretVariable('BITBUCKET_TOKEN_3'));
  assert.ok(!isSecretVariable('BITBUCKET_URL_3'));
});

test('a numbered set reads as the plain variables, and its token stays on its own host', () => {
  const env = { GITLAB_TOKEN: 'one', GITLAB_TOKEN_2: 'two', GITLAB_URL_2: 'https://gitlab.acme.com', GITHUB_TOKEN_3: 'gh3' };
  assert.deepEqual(extraInstanceNumbers({}, env), [2, 3]);
  const second = instanceSource({}, 2, env);
  assert.deepEqual(second, { GITLAB_TOKEN: 'two', GITLAB_URL: 'https://gitlab.acme.com' });
  assert.deepEqual(providersIn(second), ['gitlab']);
  const cfg = scmConfigs({}, second);
  assert.equal(cfg.gitlab.token, 'two');
  assert.equal(cfg.gitlab.host, 'gitlab.acme.com');
  // A stored address elsewhere never receives the environment's token for set 2.
  const moved = instanceSource({ beta: { instances: { 2: { GITLAB_URL: 'https://evil.example' } } } }, 2, env);
  assert.equal(scmConfigs({}, moved).gitlab.token, '', 'the token was given for gitlab.acme.com only');
});

test('an uploaded new address without its token drops the stored token', () => {
  const stored = mergeStoredInstances({}, { 2: { GITHUB_TOKEN: 't', GITHUB_API_URL: 'https://ghe.acme.com/api/v3' } });
  assert.equal(stored[2].GITHUB_TOKEN, 't');
  const moved = mergeStoredInstances(stored, { 2: { GITHUB_API_URL: 'https://other.example/api/v3' } });
  assert.equal(moved[2].GITHUB_TOKEN, undefined);
  const same = mergeStoredInstances(stored, { 2: { GITHUB_ORG: 'acme' } });
  assert.equal(same[2].GITHUB_TOKEN, 't', 'other changes keep it');
  assert.deepEqual(mergeStoredInstances({}, { 12: { GITHUB_TOKEN: 'x' }, 3: { NOT_A_VAR: 'y' } }), {}, 'unknown numbers and names are dropped');
});

test('an uploaded .env file stores numbered sets, needing Beta access; the page never sees their tokens', () => {
  const { changes, applied } = settingsFromEnv({ GITHUB_TOKEN_2: 'ghp_secret', GITHUB_API_URL_2: 'https://ghe.acme.com/api/v3', GITLAB_TOKEN_4: '' });
  assert.deepEqual(applied.sort(), ['GITHUB_API_URL_2', 'GITHUB_TOKEN_2']);
  assert.deepEqual(changes.instances, { 2: { GITHUB_TOKEN: 'ghp_secret', GITHUB_API_URL: 'https://ghe.acme.com/api/v3' } });
  assert.deepEqual(settingsFromEnv({ GITHUB_TOKEN_2: 'x' }, (p) => p !== 'beta.use').refused, ['GITHUB_TOKEN_2']);
  const settings = { ...DEFAULT_SETTINGS, smtp: { ...DEFAULT_SETTINGS.smtp }, beta: { ...DEFAULT_SETTINGS.beta, instances: changes.instances } };
  const view = JSON.stringify(publicSettings(settings));
  assert.doesNotMatch(view, /ghp_secret/);
  assert.match(view, /ghe\.acme\.com/);
});

test('each repository goes to the set with a token for its host, and its organisation when two share a host', () => {
  const sets = [
    { n: 1, hosts: [{ provider: 'github', host: 'github.com', owner: 'acme' }] },
    { n: 2, hosts: [{ provider: 'github', host: 'github.com', owner: 'globex' }] },
    { n: 3, hosts: [{ provider: 'gitlab', host: 'gitlab.acme.com', owner: '' }] },
  ];
  assert.equal(setForRepo(sets, { host: 'github.com', owner: 'globex' }).n, 2);
  assert.equal(setForRepo(sets, { host: 'github.com', owner: 'acme' }).n, 1);
  assert.equal(setForRepo(sets, { host: 'github.com', owner: 'someone' }).n, 1, 'a tie stays with the first');
  assert.equal(setForRepo(sets, { host: 'gitlab.acme.com', owner: 'team/app' }).n, 3);
  assert.equal(setForRepo(sets, { host: 'bitbucket.org', owner: 'x' }).n, 1, 'no set has that host: the first');
  assert.equal(setForRepo(sets, null).n, 1);
});
