// Updates from Settings: reading an image from its registry, unpacking only
// the app's files, keeping installed versions, and what "what's new" shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { ImageRegistry, appLayers, parseImage, untarLayer } from '../src/updates/registry.js';
import { BUILT_IN, VersionStore, compareVersions } from '../src/updates/store.js';
import { UpdateService, changesSince } from '../src/updates/service.js';

const temp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `mz-${name}-`));
const sha = (buffer) => `sha256:${createHash('sha256').update(buffer).digest('hex')}`;

/** A gzipped tar of `files` under app/ (as the image's COPY layers are). */
function layer(files) {
  const dir = temp('layer');
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, 'app', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return execFileSync('tar', ['-czf', '-', '-C', dir, 'app']);
}

/** A registry that asks for a token, serving one multi-arch image under the given tags. */
function fakeRegistry(images) {
  const blobs = new Map();
  const manifests = new Map();
  for (const { tags, layers, labels = {} } of images) {
    const config = Buffer.from(JSON.stringify({ created: '2026-10-04T05:00:00Z', config: { Labels: labels }, history: layers.map((l) => ({ created_by: l.createdBy })) }));
    blobs.set(sha(config), config);
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, config: { digest: sha(config), size: config.length }, layers: layers.map((l) => (blobs.set(sha(l.data), l.data), { digest: sha(l.data), size: l.data.length })) }));
    manifests.set(sha(manifest), manifest);
    const index = Buffer.from(JSON.stringify({ manifests: [{ digest: sha(manifest), platform: { os: 'linux', architecture: 'amd64' } }, { digest: 'sha256:' + '1'.repeat(64), platform: { os: 'unknown', architecture: 'unknown' } }] }));
    for (const tag of tags) manifests.set(tag, index);
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/token') return res.end(JSON.stringify({ token: 'anon' }));
    if (req.headers.authorization !== 'Bearer anon') {
      res.writeHead(401, { 'www-authenticate': `Bearer realm="http://127.0.0.1:${server.address().port}/token",service="fake",scope="repository:acme/mz:pull"` });
      return res.end();
    }
    let m;
    if (url.pathname === '/v2/acme/mz/tags/list') return res.end(JSON.stringify({ tags: images.flatMap((i) => i.tags) }));
    if ((m = url.pathname.match(/^\/v2\/acme\/mz\/manifests\/(.+)$/)) && manifests.has(m[1])) return res.end(manifests.get(m[1]));
    if ((m = url.pathname.match(/^\/v2\/acme\/mz\/blobs\/(.+)$/)) && blobs.has(m[1])) return res.end(blobs.get(m[1]));
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('image names: a registry is required, tags and digests are ignored', () => {
  assert.deepEqual(parseImage('ghcr.io/cxsmtp/x:latest'), { registry: 'ghcr.io', repository: 'cxsmtp/x' });
  assert.deepEqual(parseImage('localhost:5000/a/b@sha256:' + '0'.repeat(64)), { registry: 'localhost:5000', repository: 'a/b' });
  assert.throws(() => parseImage('nginx'), /registry/);
  assert.throws(() => parseImage('ghcr.io/UPPER/../x'), /Not an image name/);
});

test('only the app files of the COPY layers are unpacked, never outside app/', () => {
  const layers = [
    { createdBy: 'ADD alpine-minirootfs.tar.gz / # buildkit', size: 4e6 },
    { createdBy: 'RUN /bin/sh -c apk add nodejs # buildkit', size: 3e7 },
    { createdBy: 'COPY src ./src # buildkit', size: 2e5 },
    { createdBy: 'RUN /bin/sh -c node -p "process.versions.node" > .node-version # mz-runtime', size: 100 },
  ];
  assert.deepEqual(appLayers(layers).map((l) => l.createdBy.slice(0, 4)), ['COPY', 'RUN ']);
  const files = untarLayer(layer({ 'src/server.js': 'x', 'package.json': '{}', '../escape.txt': 'no' })).files;
  assert.deepEqual([...files.keys()].sort(), ['package.json', 'src/server.js']);
  const deep = 'node_modules/' + 'very-long-folder-name/'.repeat(8) + 'index.js';
  assert.ok(untarLayer(layer({ [deep]: 'long' })).files.has(deep), 'long names (GNU and pax headers)');
  assert.throws(() => untarLayer(Buffer.from('not a layer')), /could not be unpacked/);
});

test('the registry: token, multi-arch index, digests checked, tags listed', async () => {
  const good = layer({ 'package.json': JSON.stringify({ version: '2.0.0' }), 'src/server.js': '', 'public/index.html': '' });
  const server = await fakeRegistry([{ tags: ['latest', '2.0.0'], layers: [{ createdBy: 'COPY . . # buildkit', data: good }], labels: { 'io.cxmissionzero.version': '2.0.0' } }]);
  const registry = new ImageRegistry({ image: `127.0.0.1:${server.address().port}/acme/mz`, arch: 'x64' });
  test.after?.(() => server.close());
  assert.deepEqual(await registry.tags(), ['latest', '2.0.0']);
  const image = await registry.image('latest');
  assert.equal(image.labels['io.cxmissionzero.version'], '2.0.0');
  assert.equal(image.layers[0].createdBy, 'COPY . . # buildkit');
  const files = untarLayer(await registry.blob(image.layers[0].digest)).files;
  assert.equal(JSON.parse(files.get('package.json')).version, '2.0.0');
  await assert.rejects(registry.blob('sha256:' + 'f'.repeat(64)), /not found/);
  await assert.rejects(new ImageRegistry({ image: registry.name, arch: 'arm64' }).image('latest'), /no build for linux\/arm64/);
  server.close();
});

test('a blob that does not match its digest is refused', async () => {
  const data = Buffer.from('real');
  const server = http.createServer((req, res) => res.end('tampered')).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const registry = new ImageRegistry({ image: `127.0.0.1:${server.address().port}/acme/mz` });
  await assert.rejects(registry.blob(sha(data)), /did not match its digest/);
  server.close();
});

test('installed versions: checked, listed newest first, chosen, dropped when the image is replaced, pruned', () => {
  const data = temp('store');
  const store = new VersionStore({ dataDir: data, builtInDir: '/app', builtInVersion: '1.0.30' });
  const files = (version) => new Map([['package.json', Buffer.from(JSON.stringify({ version }))], ['src/server.js', Buffer.from('')], ['public/index.html', Buffer.from('')]]);
  assert.throws(() => store.install(new Map([['package.json', Buffer.from('{"version":"x"}')]])), /no readable version/);
  assert.throws(() => store.install(new Map([['package.json', Buffer.from('{"version":"1.0.31"}')]])), /missing src\/server.js/);
  for (const v of ['1.0.31', '1.0.29', '1.0.33', '1.0.32']) store.install(files(v), { tag: v });
  assert.deepEqual(store.list().map((v) => v.version), ['1.0.33', '1.0.32', '1.0.31', '1.0.29']);
  assert.equal(store.active().source, 'image', 'nothing chosen: the image runs');
  store.choose('1.0.31', { by: 'admin@acme.io' });
  assert.equal(store.active().version, '1.0.31');
  assert.throws(() => store.choose('9.9.9'), /not installed/);
  // A new image (podman pull) drops the choice made under the old one.
  const newer = new VersionStore({ dataDir: data, builtInDir: '/app', builtInVersion: '1.0.34' });
  assert.equal(newer.active().source, 'image');
  assert.match(newer.active().reason, /image was replaced/);
  store.choose(BUILT_IN);
  assert.equal(store.active().source, 'image');
  assert.deepEqual(store.prune({ keep: 2, protect: ['1.0.29'] }), ['1.0.31']);
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
  store.record({ type: 'rollback', from: '1.0.33', to: '1.0.32', automatic: true });
  assert.equal(store.events(1)[0].type, 'rollback');
});

test("what's new: the changelog entries newer than what runs", () => {
  const log = '# Log\n\n## MZ-01.00.31 — x\n- **Faster.** a\n- **Safer.** b\n\n## MZ-01.00.30 — x\n- **Old.** c\n\n## MZ-01.00.29 — x\n- **Older.** d\n';
  assert.deepEqual(changesSince(log, '1.0.29'), [{ version: '1.0.31', highlights: ['Faster', 'Safer'] }, { version: '1.0.30', highlights: ['Old'] }]);
  assert.deepEqual(changesSince(log, '1.0.31'), []);
});

test('auto-update: off by default; installs a newer release in its hour, never one that failed, never an older one', async () => {
  const files = (version) => layer({ 'package.json': JSON.stringify({ version }), 'src/server.js': '', 'public/index.html': '', 'CHANGELOG.md': `## MZ-0${version.replace(/\./g, '.0')} — x\n- **New.** y\n` });
  const server = await fakeRegistry([
    { tags: ['2.0.1'], layers: [{ createdBy: 'COPY . . # buildkit', data: files('2.0.1') }], labels: { 'io.cxmissionzero.version': '2.0.1' } },
    { tags: ['1.9.0'], layers: [{ createdBy: 'COPY . . # buildkit', data: files('1.9.0') }], labels: { 'io.cxmissionzero.version': '1.9.0' } },
  ]);
  const data = temp('auto');
  const store = new VersionStore({ dataDir: data, builtInDir: '/app', builtInVersion: '2.0.0' });
  const switched = [];
  const service = new UpdateService({ store, runningVersion: '2.0.0', image: `127.0.0.1:${server.address().port}/acme/mz`, supervised: true, arch: 'x64', switchTo: (m) => switched.push(m) });
  assert.equal(await service.autoUpdate(), null, 'off until an Admin turns it on');
  service.saveSettings({ auto: true, windowHour: (new Date().getHours() + 1) % 24 });
  assert.equal(await service.autoUpdate(), null, 'outside its hour');
  service.saveSettings({ auto: true, windowHour: null });
  store.record({ type: 'rollback', from: '2.0.1', to: '2.0.0', automatic: true });
  assert.equal(await service.autoUpdate(), null, '2.0.1 failed to start once: not again');
  assert.match(service.settings().lastAutoResult, /Up to date/);
  fs.writeFileSync(store.eventsFile, '');
  const job = await service.autoUpdate();
  assert.equal(job.automatic, true);
  for (let i = 0; i < 100 && job.state === 'running'; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(job.state, 'switching', job.error);
  assert.equal(job.version, '2.0.1');
  assert.deepEqual(job.whatsNew.map((n) => n.version), ['2.0.1']);
  assert.equal(store.choice().version, '2.0.1');
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(switched[0].type, 'switch');
  assert.ok(!store.list().some((v) => v.version === '1.9.0'), 'never an older one');
  server.close();
});

test('the check lists versions from their tags even when image files cannot be read, and says why', async (t) => {
  const files = (version) => layer({ 'package.json': JSON.stringify({ version }), 'src/server.js': '' });
  const server = await fakeRegistry([
    { tags: ['3.0.10', 'latest', 'sha-bbb'], layers: [{ createdBy: 'COPY . . # buildkit', data: files('3.0.10') }], labels: { 'io.cxmissionzero.version': '3.0.10' } },
    { tags: ['3.0.9', 'sha-aaa'], layers: [{ createdBy: 'COPY . . # buildkit', data: files('3.0.9') }], labels: { 'io.cxmissionzero.version': '3.0.9' } },
  ]);
  t.after(() => server.close());
  const port = server.address().port;
  const store = new VersionStore({ dataDir: temp('check'), builtInDir: '/app', builtInVersion: '3.0.9' });
  // Image files (blobs) refused, as a proxy that blocks the registry's file host does.
  const blocked = (url, options) => (String(url).includes('/blobs/') ? Promise.resolve(new Response('denied', { status: 403 })) : fetch(url, options));
  const service = new UpdateService({ store, runningVersion: '3.0.9', image: `127.0.0.1:${port}/acme/mz`, arch: 'x64', fetch: blocked });
  const status = await service.check();
  assert.deepEqual(status.lastCheck.versions.map((v) => v.version), ['3.0.10', '3.0.9'], '3.0.10 is newer than 3.0.9 (not compared as text)');
  assert.deepEqual(status.lastCheck.versions[0].tags.sort(), ['3.0.10', 'latest', 'sha-bbb'], 'latest and the commit tag matched to their version by digest');
  assert.equal(status.updateAvailable, true);
  assert.equal(status.lastCheck.error, '');
  assert.match(status.lastCheck.warning, /could not read the image files: .*answered 403.*podman pull/);

  // Nothing readable at all is never "up to date": the reason is given.
  const fresh = () => new VersionStore({ dataDir: temp('check'), builtInDir: '/app', builtInVersion: '3.0.9' });
  const nothing = new UpdateService({ store: fresh(), runningVersion: '3.0.9', image: `127.0.0.1:${port}/acme/mz`, arch: 'x64', fetch: (url, o) => (String(url).includes('/manifests/') ? Promise.resolve(new Response('', { status: 403 })) : fetch(url, o)) });
  const none = await nothing.check();
  assert.equal(none.updateAvailable, false);
  assert.match(none.lastCheck.error, /answered 403/);

  // Readable: build dates and commits come from the image files, as before.
  const open = await new UpdateService({ store: fresh(), runningVersion: '3.0.9', image: `127.0.0.1:${port}/acme/mz`, arch: 'x64' }).check();
  assert.equal(open.lastCheck.warning, '');
  assert.equal(open.lastCheck.versions[0].created, '2026-10-04T05:00:00Z');
});

test('every version is listed however many tags there are; tags already read are not read again', async (t) => {
  const files = (version) => layer({ 'package.json': JSON.stringify({ version }), 'src/server.js': '' });
  // 30 releases: the old ones with only a commit tag (as before MZ-01.00.30), the newest with a version tag too.
  const images = Array.from({ length: 30 }, (_, i) => {
    const version = `4.0.${i + 1}`;
    return { tags: i >= 25 ? [version, `sha-${i}`] : [`sha-${i}`], layers: [{ createdBy: 'COPY . . # buildkit', data: files(version) }], labels: { 'io.cxmissionzero.version': version } };
  });
  images.at(-1).tags.push('latest');
  const server = await fakeRegistry(images);
  t.after(() => server.close());
  let requests = 0;
  const counting = (url, options) => ((requests += 1), fetch(url, options));
  const store = new VersionStore({ dataDir: temp('many'), builtInDir: '/app', builtInVersion: '4.0.1' });
  const service = new UpdateService({ store, runningVersion: '4.0.1', image: `127.0.0.1:${server.address().port}/acme/mz`, arch: 'x64', fetch: counting });
  const first = await service.check();
  assert.equal(first.lastCheck.versions.length, 30, 'all 30, the commit-only ones too (61 tags)');
  assert.equal(first.lastCheck.versions[0].version, '4.0.30');
  assert.equal(first.lastCheck.versions.at(-1).version, '4.0.1');
  assert.equal(first.lastCheck.warning, '');
  const firstRequests = requests;
  requests = 0;
  const second = await service.check();
  assert.equal(second.lastCheck.versions.length, 30);
  assert.ok(requests < 10, `the second check reads only the tag list and latest (${requests} requests, first ${firstRequests})`);
});

test('auto-update waits, and says why, while the image files cannot be downloaded', async (t) => {
  const files = (version) => layer({ 'package.json': JSON.stringify({ version }), 'src/server.js': '' });
  const server = await fakeRegistry([{ tags: ['5.0.1'], layers: [{ createdBy: 'COPY . . # buildkit', data: files('5.0.1') }], labels: { 'io.cxmissionzero.version': '5.0.1' } }]);
  t.after(() => server.close());
  const blocked = (url, options) => (String(url).includes('/blobs/') ? Promise.resolve(new Response('denied', { status: 403 })) : fetch(url, options));
  const store = new VersionStore({ dataDir: temp('wait'), builtInDir: '/app', builtInVersion: '5.0.0' });
  const service = new UpdateService({ store, runningVersion: '5.0.0', image: `127.0.0.1:${server.address().port}/acme/mz`, supervised: true, arch: 'x64', fetch: blocked });
  service.saveSettings({ auto: true, windowHour: null });
  assert.equal(await service.autoUpdate(), null, 'nothing started that would fail');
  assert.match(service.settings().lastAutoResult, /MZ-5\.0\.1 is published, but this server cannot download it: .*403/);
});
