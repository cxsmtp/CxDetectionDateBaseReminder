// Hardening without a running server: whose forwarded headers are believed, the sign-in
// throttle under a flood of addresses, secrets that stay with their host, a malformed
// cookie, a backup that unpacks to too much, and old clones cleared from the cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import express from 'express';

import { pruneAttempts, trustProxySetting } from '../src/security.js';
import { DEFAULT_SETTINGS, mergeSettings, smtpFingerprint } from '../src/settings.js';
import { scmConfigs } from '../src/scm/providers.js';
import { readSessionCookie } from '../src/session.js';
import { readBackup } from '../src/backup.js';
import { pruneStaleClones } from '../src/github/identity.js';
import { settingsFromEnv } from '../src/env-import.js';

const trusts = (setting, address) => {
  const app = express();
  app.set('trust proxy', setting);
  return app.get('trust proxy fn')(address, 0);
};

test('by default only a proxy on this machine is believed, not every private address', () => {
  assert.equal(trustProxySetting(undefined, false), 'loopback');
  assert.equal(trustProxySetting('', false), 'loopback');
  assert.equal(trustProxySetting('', true), false, 'serving HTTPS itself: nobody');
  const fallback = trustProxySetting('', false);
  assert.ok(trusts(fallback, '127.0.0.1'));
  assert.ok(trusts(fallback, '::1'));
  for (const address of ['10.0.0.5', '192.168.1.20', '172.16.4.4', '169.254.1.1', 'fd00::1']) {
    assert.ok(!trusts(fallback, address), `${address} could forge X-Forwarded-For`);
  }
  // Named explicitly, a proxy elsewhere is believed.
  assert.ok(trusts(trustProxySetting('10.20.0.15', false), '10.20.0.15'));
  assert.ok(trusts(trustProxySetting('uniquelocal', false), '10.89.0.4'));
  assert.equal(trustProxySetting('off', false), false);
  assert.equal(trustProxySetting('2', false), 2);
});

test('the sign-in throttle forgets expired addresses first, then the least recent, never everyone', () => {
  const now = 1_000_000_000;
  const attempts = new Map();
  attempts.set('old-1', [now - 20 * 60_000]);
  attempts.set('old-2', [now - 11 * 60_000]);
  attempts.set('guesser', Array.from({ length: 30 }, () => now - 60_000));
  attempts.set('recent-1', [now - 1000]);
  attempts.set('recent-2', [now - 500]);
  pruneAttempts(attempts, now, { windowMs: 10 * 60_000, max: 3 });
  assert.deepEqual([...attempts.keys()], ['guesser', 'recent-1', 'recent-2'], 'expired ones went; the guesser is still counted');

  pruneAttempts(attempts, now, { windowMs: 10 * 60_000, max: 2 });
  assert.deepEqual([...attempts.keys()], ['recent-1', 'recent-2'], 'still too many: the least recent went');

  pruneAttempts(attempts, now, { windowMs: 10 * 60_000, max: 5 });
  assert.equal(attempts.size, 2, 'under the cap nothing is touched');
});

const base = () => structuredClone(DEFAULT_SETTINGS);

test('a stored GitHub token is dropped when the API address moves to another host, kept otherwise', () => {
  const start = mergeSettings(base(), { beta: { github: { token: 'ghp_secret' } } });
  assert.equal(start.beta.github.token, 'ghp_secret');

  const moved = mergeSettings(start, { beta: { github: { apiUrl: 'https://evil.example/api/v3' } } });
  assert.equal(moved.beta.github.apiUrl, 'https://evil.example/api/v3');
  assert.equal(moved.beta.github.token, '', 'the token never goes to the new host');

  assert.equal(mergeSettings(start, { beta: { github: { apiUrl: 'https://api.github.com/' } } }).beta.github.token, 'ghp_secret', 'same host');
  assert.equal(mergeSettings(start, { beta: { github: { org: 'acme' } } }).beta.github.token, 'ghp_secret', 'unrelated field');
  assert.equal(mergeSettings(start, { beta: { github: { apiUrl: 'https://ghe.acme.io/api/v3', token: 'ghe_new' } } }).beta.github.token, 'ghe_new', 'a new token comes with the new host');
});

test('GitLab, Azure DevOps and Bitbucket tokens stay with their host too', () => {
  const start = mergeSettings(base(), { beta: {
    gitlab: { apiUrl: 'https://git.acme.io', token: 'glpat' },
    azure: { orgUrl: 'https://dev.azure.com/acme', token: 'pat' },
    bitbucket: { kind: 'server', apiUrl: 'https://bitbucket.acme.io', token: 'bbt' },
  } });
  const moved = mergeSettings(start, { beta: {
    gitlab: { apiUrl: 'https://evil.example' },
    azure: { orgUrl: 'https://evil.example/acme' },
    bitbucket: { apiUrl: 'https://evil.example' },
  } });
  assert.equal(moved.beta.gitlab.token, '');
  assert.equal(moved.beta.azure.token, '');
  assert.equal(moved.beta.bitbucket.token, '');
  assert.equal(mergeSettings(start, { beta: { bitbucket: { kind: 'cloud' } } }).beta.bitbucket.token, '', 'server to cloud is another host');

  const same = mergeSettings(start, { beta: {
    gitlab: { apiUrl: 'https://git.acme.io/', group: 'team' },
    azure: { orgUrl: 'https://acme.visualstudio.com' },
    bitbucket: { apiUrl: 'https://bitbucket.acme.io/rest' },
  } });
  assert.equal(same.beta.gitlab.token, 'glpat');
  assert.equal(same.beta.azure.token, 'pat', 'the same Azure DevOps organisation, at its older address');
  // An Azure DevOps token belongs to one organisation: another one on the same host does not get it.
  assert.equal(mergeSettings(start, { beta: { azure: { orgUrl: 'https://dev.azure.com/acme-two' } } }).beta.azure.token, '');
  assert.equal(same.beta.bitbucket.token, 'bbt');
});

test('the SMTP password is dropped when the mail server changes, unless a new one is given', () => {
  const start = mergeSettings(base(), { smtp: { host: 'smtp.acme.io', password: 'secret' } });
  assert.equal(mergeSettings(start, { smtp: { host: 'mail.evil.example' } }).smtp.password, '');
  assert.equal(mergeSettings(start, { smtp: { host: 'SMTP.acme.io ' } }).smtp.password, 'secret', 'same server');
  assert.equal(mergeSettings(start, { smtp: { port: 465 } }).smtp.password, 'secret');
  assert.equal(mergeSettings(start, { smtp: { host: 'mail.acme.io', password: 'new one' } }).smtp.password, 'new one');
});

test('the SMTP fingerprint is unchanged by writing its separator as an escape', () => {
  const smtp = { host: 'smtp.acme.io', port: 587, secure: false, requireAuth: true, user: 'u', password: 'p', rejectUnauthorized: true };
  const material = [smtp.host, smtp.port, smtp.secure, smtp.requireAuth, smtp.user, smtp.password, smtp.rejectUnauthorized].join(String.fromCharCode(0));
  assert.equal(smtpFingerprint(smtp), createHash('sha256').update(material).digest('hex').slice(0, 32));
  assert.ok(!fs.readFileSync(new URL('../src/settings.js', import.meta.url)).includes(0), 'no raw NUL byte in the source');
});

test('a token from the environment goes only to the host the environment names', () => {
  const env = { GITLAB_TOKEN: 'glpat', AZURE_DEVOPS_TOKEN: 'pat', BITBUCKET_TOKEN: 'bbt' };
  const publicHosts = scmConfigs({ beta: { azure: { orgUrl: 'https://dev.azure.com/acme' } } }, env);
  assert.equal(publicHosts.gitlab.token, 'glpat', 'gitlab.com by default');
  assert.equal(publicHosts.azure.token, 'pat', 'dev.azure.com by default');
  assert.equal(publicHosts.bitbucket.token, 'bbt', 'Bitbucket Cloud by default');

  const elsewhere = scmConfigs({ beta: {
    gitlab: { apiUrl: 'https://evil.example' },
    azure: { orgUrl: 'https://evil.example/acme' },
    bitbucket: { kind: 'server', apiUrl: 'https://evil.example' },
  } }, env);
  for (const id of ['gitlab', 'azure', 'bitbucket']) {
    assert.equal(elsewhere[id].token, '', `${id}: the environment's token is not sent to an address set in Settings`);
    assert.equal(elsewhere[id].tokenSource, 'none');
  }

  const named = scmConfigs({ beta: { gitlab: { apiUrl: 'https://git.acme.io' } } }, { ...env, GITLAB_URL: 'https://git.acme.io' });
  assert.equal(named.gitlab.token, 'glpat', 'the host GITLAB_URL names');
});

test('a malformed session cookie is no session, not a server error', () => {
  assert.equal(readSessionCookie({ headers: { cookie: 'cxdr_sid=%E0%A4%A' } }), null);
  assert.equal(readSessionCookie({ headers: { cookie: 'other=1; cxdr_sid=abc%20def' } }), 'abc def');
});

test('a backup that unpacks to more than the limit is refused with a plain reason', () => {
  const bomb = zlib.gzipSync(Buffer.alloc(2 * 1024 * 1024, 32));
  assert.throws(() => readBackup(bomb, { maxUnpackedBytes: 1024 * 1024 }), /unpacks to more than 1 MB/);
  assert.throws(() => readBackup(Buffer.from('not gzip')), /Not a CxMissionZero backup/);
});

test('clones not used for 30 days are removed from the cache; recent ones and other folders stay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-cache-'));
  const make = (name, ageDays) => {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, 'HEAD'), 'ref');
    const when = new Date(Date.now() - ageDays * 86_400_000);
    fs.utimesSync(path.join(dir, name), when, when);
  };
  make('0123456789abcdef', 45);
  make('fedcba9876543210-full', 31);
  make('00112233445566aa', 2);
  make('keep-me', 400);
  assert.equal(pruneStaleClones(dir, { force: true }), 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['00112233445566aa', 'keep-me']);
  assert.equal(pruneStaleClones(path.join(dir, 'missing'), { force: true }), 0, 'no cache yet: nothing to do');
});

test('a .env file cannot reach settings through inherited names', () => {
  const { applied, ignored } = settingsFromEnv({ constructor: 'x', toString: 'y', __proto__: 'z', SMTP_HOST: 'smtp.acme.io' });
  assert.deepEqual(applied, ['SMTP_HOST']);
  assert.ok(ignored.includes('constructor') && ignored.includes('toString'));
});
