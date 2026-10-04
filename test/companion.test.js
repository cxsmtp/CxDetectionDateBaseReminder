// Full image updates through the update companion (Beta): the same container on a new image,
// only this app's image, and back to the old container when the new one does not come up.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { EngineClient } from '../src/companion/engine.js';
import { TAG, cloneSpec, fullUpdate, repositoryOf } from '../src/companion/full-update.js';
import { tick, waitForAck } from '../src/companion/main.js';
import { acknowledgeStart, companionState, requestFullUpdate, updaterDir } from '../src/updates/companion.js';

const IMAGE = 'ghcr.io/cxsmtp/cxdetectiondatebasereminder';
const oldImage = { Id: 'img-old', Config: { Env: ['PATH=/usr/bin', 'NODE_ENV=production', 'PORT=3000'], Cmd: ['node', 'src/launch.js'], Entrypoint: ['/sbin/tini', '--'], User: 'node', WorkingDir: '/app', Labels: { 'io.cxmissionzero.version': '1.0.40', 'org.opencontainers.image.revision': 'abc' }, ExposedPorts: { '3000/tcp': {} } } };
const container = (image = `${IMAGE}:latest`) => ({
  Id: 'c-old',
  Image: 'img-old',
  Name: '/mission-zero',
  State: { Running: true },
  Config: {
    Image: image,
    Env: ['PATH=/usr/bin', 'NODE_ENV=production', 'PORT=3000', 'TZ=Asia/Dubai', 'HTTPS=off'],
    Cmd: ['node', 'src/launch.js'],
    Entrypoint: ['/sbin/tini', '--'],
    User: 'node',
    WorkingDir: '/app',
    Labels: { 'io.cxmissionzero.version': '1.0.40', team: 'appsec' },
    ExposedPorts: { '3000/tcp': {} },
  },
  HostConfig: { Binds: ['mission-zero-data:/data'], PortBindings: { '3000/tcp': [{ HostPort: '3000' }] }, ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], RestartPolicy: { Name: 'always' } },
  NetworkSettings: { Networks: { podman: {}, appnet: { Aliases: ['c-old', 'mz'] } } },
});

test('tags and repositories: only a version, latest or a commit tag, of the configured image', () => {
  for (const ok of ['1.0.41', 'latest', 'sha-0123abc']) assert.ok(TAG.test(ok), ok);
  for (const bad of ['', '1.0', 'v1.0.41', 'latest; rm -rf /', '../x', 'sha-XYZ', 'evil/image:1.0.0']) assert.ok(!TAG.test(bad), bad);
  assert.equal(repositoryOf('GHCR.io/CxSmtp/App:1.2.3'), 'ghcr.io/cxsmtp/app');
  assert.equal(repositoryOf('localhost:5000/app@sha256:abc'), 'localhost:5000/app');
  assert.equal(repositoryOf('localhost:5000/app'), 'localhost:5000/app');
});

test('the new container keeps what the person started it with, and takes the rest from the new image', () => {
  const spec = cloneSpec(container(), oldImage, `${IMAGE}:1.0.41`);
  assert.equal(spec.Image, `${IMAGE}:1.0.41`);
  assert.deepEqual(spec.Env, ['TZ=Asia/Dubai', 'HTTPS=off'], "the old image's own environment is not carried over");
  assert.deepEqual(spec.Labels, { team: 'appsec' });
  assert.equal(spec.Cmd, undefined, 'the image’s own command: the new image’s is used');
  assert.equal(spec.Entrypoint, undefined);
  assert.equal(spec.User, undefined);
  assert.deepEqual(spec.HostConfig.Binds, ['mission-zero-data:/data']);
  assert.equal(spec.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(spec.NetworkingConfig, { EndpointsConfig: { appnet: { Aliases: ['mz'] } } }, 'own networks kept, the default one left to the engine');

  const custom = container();
  custom.Config.Cmd = ['node', 'src/server.js'];
  assert.deepEqual(cloneSpec(custom, oldImage, 'x').Cmd, ['node', 'src/server.js'], 'a command given at run time is kept');
});

/** An in-memory engine with one container, recording what was asked. */
function fakeEngine({ startFails = false, pullFails = false, runs = `${IMAGE}:latest`, freshId = 'img-new' } = {}) {
  const containers = new Map([['c-old', { ...container(runs), name: 'mission-zero', running: true }]]);
  const calls = [];
  let next = 0;
  const find = (ref) => containers.get(ref) ?? [...containers.values()].find((c) => c.name === ref);
  return {
    calls,
    containers,
    async inspect(ref) {
      const c = find(ref);
      if (!c) throw Object.assign(new Error(`no container ${ref}`), { status: 404 });
      return { ...c, State: { Running: c.running, ExitCode: c.running ? 0 : 1 } };
    },
    async inspectImage(ref) {
      return ref === 'img-old' ? oldImage : { Id: freshId, Config: { Labels: { 'io.cxmissionzero.version': '1.0.41' } } };
    },
    async pull(image, tag) {
      calls.push(['pull', `${image}:${tag}`]);
      if (pullFails) throw new Error('manifest unknown');
    },
    async stop(id) {
      calls.push(['stop', id]);
      find(id).running = false;
    },
    async rename(id, name) {
      calls.push(['rename', id, name]);
      if ([...containers.values()].some((c) => c.name === name && c.Id !== id)) throw new Error(`name ${name} in use`);
      find(id).name = name;
    },
    async create(name, spec) {
      next += 1;
      const Id = `c-new-${next}`;
      calls.push(['create', name, spec.Image]);
      containers.set(Id, { Id, name, spec, Config: { Image: spec.Image }, running: false });
      return { Id };
    },
    async start(id) {
      calls.push(['start', id]);
      find(id).running = !(startFails && id !== 'c-old');
    },
    async remove(ref) {
      const c = find(ref);
      if (!c) throw Object.assign(new Error('no such container'), { status: 404 });
      calls.push(['remove', c.Id]);
      containers.delete(c.Id);
    },
  };
}

test('a full update parks the old container, starts the new one with the same settings, and keeps it once it said it started', async () => {
  const engine = fakeEngine();
  const steps = [];
  const result = await fullUpdate({ engine, name: 'mission-zero', image: IMAGE, tag: '1.0.41', waitReady: async ({ version }) => assert.equal(version, '1.0.41'), step: (s) => steps.push(s), settleMs: 0 });
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.equal(result.to, '1.0.41');
  assert.equal(result.from, '1.0.40');
  const names = Object.fromEntries([...engine.containers.values()].map((c) => [c.name, c.Id]));
  assert.equal(names['mission-zero-previous'], 'c-old');
  assert.equal(names['mission-zero'], 'c-new-1');
  assert.deepEqual(engine.calls.map((c) => c[0]), ['pull', 'stop', 'rename', 'create', 'start'], 'pulled while the old one ran, then stopped before the new one started');
  assert.ok(steps.some((s) => /saves/.test(s)));
});

test('a new container that does not come up is removed, and the old one is put back and started', async () => {
  const engine = fakeEngine();
  const result = await fullUpdate({ engine, name: 'mission-zero', image: IMAGE, tag: '1.0.41', waitReady: async () => { throw new Error('The new server did not start within 150 s.'); }, settleMs: 0 });
  assert.equal(result.state, 'rolled-back');
  assert.match(result.error, /did not start/);
  const old = engine.containers.get('c-old');
  assert.equal(old.name, 'mission-zero');
  assert.equal(old.running, true);
  assert.equal(engine.containers.size, 1, 'the failed one is gone');

  // Came up, then stopped during the settle time: also undone.
  const crashing = fakeEngine({ startFails: true });
  const again = await fullUpdate({ engine: crashing, name: 'mission-zero', image: IMAGE, tag: '1.0.41', waitReady: async () => {}, settleMs: 0 });
  assert.equal(again.state, 'rolled-back');
  assert.match(again.error, /stopped/);
});

test('nothing is touched for another image, a failed download, or the image that already runs', async () => {
  const other = fakeEngine({ runs: 'docker.io/library/postgres:16' });
  await assert.rejects(fullUpdate({ engine: other, name: 'mission-zero', image: IMAGE, tag: '1.0.41', waitReady: async () => {} }), /not replaced/);
  assert.deepEqual(other.calls, []);

  const offline = fakeEngine({ pullFails: true });
  await assert.rejects(fullUpdate({ engine: offline, name: 'mission-zero', image: IMAGE, tag: '1.0.41', waitReady: async () => {} }), /manifest unknown/);
  assert.ok(!offline.calls.some(([c]) => c === 'stop'), 'the server was never stopped');

  const same = fakeEngine({ freshId: 'img-old' });
  assert.equal((await fullUpdate({ engine: same, name: 'mission-zero', image: IMAGE, tag: 'latest', waitReady: async () => {} })).state, 'unchanged');

  await assert.rejects(fullUpdate({ engine: same, name: 'mission-zero', image: IMAGE, tag: 'latest --privileged', waitReady: async () => {} }), /not a version/);
});

test('the engine client speaks the Docker-compatible API over the socket, and reads errors out of a pull stream', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-'));
  const socketPath = path.join(dir, 'engine.sock');
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push([req.method, req.url, req.headers['x-registry-auth'] ?? '', body]);
      if (req.url === '/v1.41/_ping') return res.end('OK');
      if (req.url.includes('tag=missing')) return res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: 'manifest for x:missing not found' }) + '\n');
      if (req.url.startsWith('/v1.41/images/create')) {
        res.write('{"status":"Pulling"}\n');
        return res.end(req.url.includes('tag=bad') ? '{"errorDetail":{"message":"manifest unknown"},"error":"manifest unknown"}\n' : '{"status":"Done"}\n');
      }
      if (req.url === '/v1.41/containers/mission-zero/json') return res.end(JSON.stringify({ Id: 'c1' }));
      if (req.url.startsWith('/v1.41/containers/c1/stop')) return res.writeHead(304).end();
      if (req.url.startsWith('/v1.41/containers/create?name=mz')) return res.writeHead(201).end(JSON.stringify({ Id: 'c2' }));
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: 'no such container' }));
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const engine = new EngineClient({ socketPath, registryToken: 'tok' });
  assert.equal(await engine.ping(), 'OK');
  assert.equal((await engine.inspect('mission-zero')).Id, 'c1');
  await engine.pull(IMAGE, '1.0.41');
  const auth = JSON.parse(Buffer.from(seen.at(-1)[2], 'base64url').toString());
  assert.deepEqual(auth, { username: 'token', password: 'tok', serveraddress: 'ghcr.io' });
  await assert.rejects(engine.pull(IMAGE, 'bad'), /manifest unknown/);
  await assert.rejects(engine.pull(IMAGE, 'missing'), (error) => error.message === 'manifest for x:missing not found', 'the message, not the raw JSON');
  await engine.stop('c1', 5); // 304: already stopped is fine
  assert.equal((await engine.create('mz', { Image: 'x' })).Id, 'c2');
  assert.equal(JSON.parse(seen.at(-1)[3]).Image, 'x');
  await assert.rejects(engine.inspect('nope'), (error) => error.status === 404 && /no such container/.test(error.message));
  await assert.rejects(new EngineClient({ socketPath: path.join(dir, 'missing.sock') }).ping(), /Cannot reach the container engine/);
});

test('the server asks through the data volume: only when the companion is there, one at a time, and a valid tag', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-'));
  try {
    assert.equal(companionState(dataDir).connected, false);
    assert.throws(() => requestFullUpdate(dataDir, { tag: '1.0.41' }), (error) => error.status === 409 && /not running/.test(error.message));
    fs.mkdirSync(updaterDir(dataDir), { recursive: true });
    fs.writeFileSync(path.join(updaterDir(dataDir), 'companion.json'), JSON.stringify({ at: new Date().toISOString(), engine: 'ok' }));
    assert.equal(companionState(dataDir).connected, true);
    assert.throws(() => requestFullUpdate(dataDir, { tag: 'latest && reboot' }), (error) => error.status === 400);
    const request = requestFullUpdate(dataDir, { tag: '1.0.41', by: 'admin@acme.io' });
    assert.equal(companionState(dataDir).pending.id, request.id);
    assert.equal(companionState(dataDir).busy, true);
    assert.throws(() => requestFullUpdate(dataDir, { tag: '1.0.41' }), /already under way/);
    assert.equal((fs.statSync(path.join(updaterDir(dataDir), 'request.json')).mode & 0o777).toString(8), '600');
    // An old heartbeat: not connected.
    assert.equal(companionState(dataDir, Date.now() + 120_000).connected, false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the companion takes a request once, waits for the new server to say it started, and records how it ended', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-'));
  try {
    const config = { dataDir, container: 'mission-zero', image: IMAGE, startTimeoutMs: 5000 };
    const engine = fakeEngine();
    engine.ping = async () => 'OK';
    // No request: only the heartbeat.
    assert.equal(await tick({ config, engine }), null);
    const heartbeat = JSON.parse(fs.readFileSync(path.join(updaterDir(dataDir), 'companion.json'), 'utf8'));
    assert.equal(heartbeat.engine, 'ok');
    assert.equal(heartbeat.engineError, '');

    fs.writeFileSync(path.join(updaterDir(dataDir), 'request.json'), JSON.stringify({ id: 'r1', tag: '1.0.41', by: 'admin@acme.io' }));
    // The new container's server writes its acknowledgement once it is started.
    const start = engine.start.bind(engine);
    engine.start = async (id) => {
      await start(id);
      setTimeout(() => acknowledgeStart(dataDir, { version: '1.0.41', builtIn: '1.0.41' }), 50);
    };
    const status = await tick({ config, engine, settleMs: 0 });
    assert.equal(status.state, 'done', JSON.stringify(status));
    assert.ok(!fs.existsSync(path.join(updaterDir(dataDir), 'request.json')), 'taken once');
    const saved = companionState(dataDir);
    assert.equal(saved.status.state, 'done');
    assert.equal(saved.busy, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(updaterDir(dataDir), 'history.json'), 'utf8'))[0].id, 'r1');

    // A request with a bad tag is refused without touching anything.
    fs.writeFileSync(path.join(updaterDir(dataDir), 'request.json'), JSON.stringify({ id: 'r2', tag: '$(reboot)' }));
    const calls = engine.calls.length;
    assert.equal((await tick({ config, engine, beat: false })).state, 'refused');
    assert.equal(engine.calls.length, calls);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('waiting for the acknowledgement: an older one does not count, and it gives up in time', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-'));
  try {
    const dir = updaterDir(dataDir);
    acknowledgeStart(dataDir, { version: '1.0.40' });
    await assert.rejects(waitForAck(dir, { since: Date.now() + 5000, version: '', timeoutMs: 300, pollMs: 50 }), /did not start/);
    await assert.rejects(waitForAck(dir, { since: 0, version: '1.0.41', timeoutMs: 300, pollMs: 50 }), /did not start/, 'another version');
    assert.equal((await waitForAck(dir, { since: 0, version: '1.0.40', timeoutMs: 300, pollMs: 50 })).version, '1.0.40');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
