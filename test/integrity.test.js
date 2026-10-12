// The built-in integrity check: the file list (what is on disk against what was built) and the
// signature check of GitHub's build attestation (who built it, from where, logged publicly).
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildManifest, compareFiles, manifestText, readManifest, sha256 } from '../src/integrity/manifest.js';
import { rootFromInclusionProof, verifyBundle } from '../src/integrity/sigstore.js';
import { makeBundle, makeWorld } from './sigstore-helpers.js';

function appFolder() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-'));
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  put('package.json', '{"version":"1.0.72"}');
  put('src/server.js', 'console.log(1)');
  put('public/index.html', '<html>');
  put('node_modules/express/index.js', 'module.exports = 1');
  put('node_modules/.package-lock.json', '{}');
  put('data/settings.json', '{}');
  put('.node-version', '24');
  return { root, put };
}

test('the file list covers the app and its dependencies, not what is written beside them', () => {
  const { root } = appFolder();
  const m = buildManifest(root, { version: '1.0.72', commit: 'abc' });
  assert.deepEqual(Object.keys(m.files), ['node_modules/express/index.js', 'package.json', 'public/index.html', 'src/server.js']);
  assert.equal(m.files['src/server.js'], sha256('console.log(1)'));
  assert.equal(manifestText(m), manifestText(buildManifest(root, { version: '1.0.72', commit: 'abc' })), 'the same files give the same bytes');
});

test('a changed, missing or added file is found; the rest still match', () => {
  const { root, put } = appFolder();
  const m = buildManifest(root);
  fs.writeFileSync(path.join(root, 'integrity.json'), manifestText(m));
  assert.deepEqual(compareFiles(root, readManifest(root).manifest), { ok: true, checked: 4, changed: [], missing: [], extra: [] });
  put('src/server.js', 'console.log(2)');
  fs.rmSync(path.join(root, 'public/index.html'));
  put('src/backdoor.js', 'evil()');
  const r = compareFiles(root, m);
  assert.equal(r.ok, false);
  assert.deepEqual([r.changed, r.missing, r.extra], [['src/server.js'], ['public/index.html'], ['src/backdoor.js']]);
});

test('the digest is of the exact bytes on disk', () => {
  const { root } = appFolder();
  const text = manifestText(buildManifest(root));
  fs.writeFileSync(path.join(root, 'integrity.json'), text);
  assert.equal(readManifest(root).digest, sha256(text));
  assert.equal(readManifest(fs.mkdtempSync(path.join(os.tmpdir(), 'none-'))), null);
});

const DIGEST = sha256('the file list');

test('a good attestation passes, with a signed timestamp or with an inclusion proof', () => {
  const world = makeWorld();
  for (const proof of ['set', 'checkpoint']) {
    const r = verifyBundle(makeBundle(world, DIGEST, { proof }), { digest: DIGEST, trustedRoot: world.trustedRoot, repository: 'acme/mission' });
    assert.equal(r.ok, true, `${proof}: ${r.reason}`);
    assert.equal(r.ref, 'refs/heads/main');
    assert.equal(r.commit, '0123456789abcdef0123456789abcdef01234567');
    assert.match(r.run, /actions\/runs\/1/);
  }
  const tag = makeWorld({ ref: 'refs/tags/v1.0.72' });
  assert.equal(verifyBundle(makeBundle(tag, DIGEST), { digest: DIGEST, trustedRoot: tag.trustedRoot, repository: 'ACME/Mission' }).ok, true, 'a version tag, and the repository in any case');
});

test('each way an attestation can be wrong is refused, with the reason', () => {
  const world = makeWorld();
  const check = (bundle, opts = {}) => verifyBundle(bundle, { digest: DIGEST, trustedRoot: world.trustedRoot, repository: 'acme/mission', ...opts });
  const good = makeBundle(world, DIGEST);
  assert.match(check(good, { digest: sha256('other files') }).reason, /about other files/);
  assert.match(check(good, { repository: 'someone/else' }).reason, /not https:\/\/github.com\/someone\/else/);
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  assert.match(check(makeBundle(world, DIGEST, { signKey: other.privateKey })).reason, /signature does not match/);
  assert.match(check(makeBundle(world, DIGEST, { tamper: { payload: DIGEST } })).reason, /signature does not match/, 'a payload swapped after signing');
  assert.match(check(makeBundle(world, DIGEST, { tamper: { logKey: other.privateKey } })).reason, /did not confirm/);
  assert.match(check(makeBundle(world, DIGEST, { proof: 'checkpoint', tamper: { logKey: other.privateKey } })).reason, /did not confirm/);
  assert.match(check(makeBundle(world, DIGEST, { tamper: { loggedPayload: Buffer.from('else') } })).reason, /record is not of this signature/);
  assert.match(check(makeBundle(world, DIGEST, { integratedTime: Math.floor(world.now / 1000) + 3600 })).reason, /not valid when it was used/);
  const stranger = makeWorld();
  assert.match(check(makeBundle(stranger, DIGEST)).reason, /not issued by Sigstore/, 'a certificate from another authority');
  const pr = makeWorld({ ref: 'refs/pull/9/merge' });
  assert.match(verifyBundle(makeBundle(pr, DIGEST), { digest: DIGEST, trustedRoot: pr.trustedRoot, repository: 'acme/mission' }).reason, /not main or a version tag/);
  const elsewhere = makeWorld({ workflow: '.github/workflows/other.yml' });
  assert.match(verifyBundle(makeBundle(elsewhere, DIGEST), { digest: DIGEST, trustedRoot: elsewhere.trustedRoot, repository: 'acme/mission' }).reason, /not \.github\/workflows\/container\.yml/);
  const notActions = makeWorld({ issuer: 'https://accounts.example' });
  assert.match(verifyBundle(makeBundle(notActions, DIGEST), { digest: DIGEST, trustedRoot: notActions.trustedRoot, repository: 'acme/mission' }).reason, /not signed by GitHub Actions/);
  assert.match(check({ mediaType: 'text/plain' }).reason, /not a Sigstore bundle/);
});

test('inclusion proofs follow RFC 9162', () => {
  const leaf = Buffer.alloc(32, 1);
  assert.deepEqual(rootFromInclusionProof(0, 1, leaf, []), leaf);
  assert.equal(rootFromInclusionProof(2, 2, leaf, []), null);
  assert.equal(rootFromInclusionProof(0, 2, leaf, []), null, 'a proof too short');
});

import { IntegrityService, compareFileMap } from '../src/integrity/service.js';

test("an update's files are checked against the list among them", () => {
  const list = { format: 1, version: '1.0.72', files: { 'package.json': sha256('{}'), 'src/server.js': sha256('ok') } };
  const files = (over = {}) => new Map(Object.entries({ 'package.json': Buffer.from('{}'), 'src/server.js': Buffer.from('ok'), 'integrity.json': Buffer.from(JSON.stringify(list)), '.node-version': Buffer.from('24'), ...over }));
  assert.equal(compareFileMap(files()).ok, true);
  assert.equal(compareFileMap(new Map([['package.json', Buffer.from('{}')]])), null, 'no list at all');
  const bad = compareFileMap(files({ 'src/server.js': Buffer.from('evil'), 'src/extra.js': Buffer.from('x') }));
  assert.deepEqual([bad.ok, bad.changed, bad.extra], [false, ['src/server.js'], ['src/extra.js']]);
});

test('the running copy: genuine, tampered, unconfirmed offline, not genuine, unsigned; a confirmed origin is kept', async () => {
  const world = makeWorld({ repository: 'acme/mission' });
  const { root, put } = appFolder();
  const text = manifestText(buildManifest(root, { version: '1.0.72' }));
  fs.writeFileSync(path.join(root, 'integrity.json'), text);
  const digest = sha256(text);
  let answer = 'signed';
  let calls = 0;
  const fetch = async (url) => {
    calls += 1;
    assert.match(String(url), new RegExp(`/repos/acme/mission/attestations/sha256:${digest}$`));
    if (answer === 'offline') throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    if (answer === 'none') return new Response('{}', { status: 404 });
    return Response.json({ attestations: [{ bundle: makeBundle(answer === 'stranger' ? makeWorld({ repository: 'acme/mission' }) : world, digest) }] });
  };
  const records = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-data-'));
  const make = () => new IntegrityService({ appDir: root, dataDir, repository: 'acme/mission', fetch, trustedRoot: world.trustedRoot, record: (r) => records.push(r) });

  answer = 'offline';
  assert.equal((await make().check()).state, 'unconfirmed');
  answer = 'none';
  assert.equal((await make().check()).state, 'not-genuine');
  answer = 'stranger';
  const stranger = await make().check();
  assert.equal(stranger.state, 'not-genuine');
  assert.match(stranger.summary, /not issued by Sigstore/);
  assert.equal(records.at(-1).outcome, 'failure');

  answer = 'signed';
  const service = make();
  const good = await service.check();
  assert.equal(good.state, 'genuine', good.summary);
  assert.match(good.summary, /acme\/mission's release workflow built from main/);
  answer = 'offline';
  calls = 0;
  assert.equal((await make().check()).state, 'genuine', 'confirmed once, known offline after a restart');
  assert.equal(calls, 0);

  put('src/server.js', 'changed');
  const tampered = await service.check();
  assert.equal(tampered.state, 'tampered');
  assert.deepEqual(tampered.files.changed, ['src/server.js']);
  assert.equal(records.at(-1).outcome, 'failure');

  const none = new IntegrityService({ appDir: fs.mkdtempSync(path.join(os.tmpdir(), 'plain-')), dataDir, repository: 'acme/mission', fetch });
  assert.equal((await none.check()).state, 'unsigned');
});
