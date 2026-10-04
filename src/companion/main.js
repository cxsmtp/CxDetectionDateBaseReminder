/**
 * The update companion (Beta): a second container, from the same image, that can replace the
 * CxMissionZero container with a new image when an Admin asks on the Update page.
 *
 *   podman run -d --name mission-zero-updater --user root --restart=always --security-opt label=disable
 *     -v mission-zero-data:/data -v /run/podman/podman.sock:/run/podman/podman.sock
 *     ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest node src/companion/main.js
 *
 * It has the engine's socket, which is as powerful as the engine itself, so it does one thing:
 * it reads updater/request.json in the data volume and replaces one container (TARGET_CONTAINER,
 * "mission-zero" by default) with the same container on UPDATE_IMAGE at the version asked for
 * (src/companion/full-update.js). It listens on no port and takes no other instruction.
 *
 * Environment: DATA_DIR (/data), ENGINE_SOCKET (/run/podman/podman.sock), TARGET_CONTAINER,
 * UPDATE_IMAGE, UPDATE_REGISTRY_TOKEN, UPDATE_START_TIMEOUT_SECONDS (150).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EngineClient } from './engine.js';
import { TAG, fullUpdate, repositoryOf } from './full-update.js';
import { readJson, updaterDir, writeJson } from '../updates/companion.js';

const DEFAULT_IMAGE = 'ghcr.io/cxsmtp/cxdetectiondatebasereminder';
const HISTORY = 20;

export function companionConfig(env = process.env) {
  return {
    dataDir: path.resolve(env.DATA_DIR || '/data'),
    socketPath: env.ENGINE_SOCKET || env.PODMAN_SOCKET || '/run/podman/podman.sock',
    container: env.TARGET_CONTAINER || 'mission-zero',
    image: repositoryOf(env.UPDATE_IMAGE || DEFAULT_IMAGE),
    token: env.UPDATE_REGISTRY_TOKEN || '',
    startTimeoutMs: Math.max(30, Number(env.UPDATE_START_TIMEOUT_SECONDS) || 150) * 1000,
  };
}

/** Resolves when ack.json says a server started after `since` (and runs `version` when known). */
export function waitForAck(dir, { since, version, timeoutMs, pollMs = 2000 }) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const look = () => {
      const ack = readJson(path.join(dir, 'ack.json'));
      if (ack && Date.parse(ack.startedAt) >= since - 1000 && (!version || ack.builtIn === version || ack.version === version)) return resolve(ack);
      if (Date.now() > deadline) return reject(new Error(`The new server did not start within ${Math.round(timeoutMs / 1000)} s.`));
      setTimeout(look, pollMs);
    };
    look();
  });
}

/** One pass: the heartbeat, then the request if there is one. Returns what was done. */
export async function tick({ config, engine, now = () => Date.now(), settleMs, beat = true }) {
  const dir = updaterDir(config.dataDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    // The companion runs as root (for the engine's socket); the server must still write here.
    try {
      const owner = fs.statSync(config.dataDir);
      fs.chownSync(dir, owner.uid, owner.gid);
    } catch {}
  }
  if (beat) {
    const heartbeat = { at: new Date(now()).toISOString(), container: config.container, image: config.image, engine: '', engineError: '' };
    try {
      await engine.ping();
      const target = await engine.inspect(config.container);
      heartbeat.engine = 'ok';
      heartbeat.running = Boolean(target.State?.Running);
      heartbeat.runs = target.Config?.Image ?? '';
      if (repositoryOf(heartbeat.runs) !== config.image) heartbeat.engineError = `"${config.container}" runs ${heartbeat.runs}, not ${config.image}.`;
    } catch (error) {
      heartbeat.engine = 'error';
      heartbeat.engineError = error.message;
    }
    writeJson(path.join(dir, 'companion.json'), heartbeat);
  }

  const requestFile = path.join(dir, 'request.json');
  const request = readJson(requestFile);
  if (!request) {
    if (fs.existsSync(requestFile)) fs.rmSync(requestFile, { force: true }); // unreadable: never acted on
    return null;
  }
  fs.rmSync(requestFile, { force: true });
  const status = { id: String(request.id ?? ''), tag: String(request.tag ?? ''), by: String(request.by ?? '').slice(0, 200), state: 'running', step: 'Starting', startedAt: new Date(now()).toISOString() };
  const save = (patch) => {
    Object.assign(status, patch, { at: new Date(now()).toISOString() });
    writeJson(path.join(dir, 'status.json'), status);
  };
  if (!TAG.test(status.tag)) {
    save({ state: 'refused', error: 'Not a version, latest or a commit tag.' });
    return status;
  }
  save({});
  try {
    const result = await fullUpdate({
      engine,
      name: config.container,
      image: config.image,
      tag: status.tag,
      step: (text) => save({ step: text }),
      waitReady: ({ since, version }) => waitForAck(dir, { since, version, timeoutMs: config.startTimeoutMs }),
      ...(settleMs === undefined ? {} : { settleMs }),
    });
    save({ ...result, step: '', finishedAt: new Date(now()).toISOString() });
  } catch (error) {
    save({ state: 'failed', error: error.message, step: '', finishedAt: new Date(now()).toISOString() });
  }
  const historyFile = path.join(dir, 'history.json');
  writeJson(historyFile, [status, ...(readJson(historyFile) ?? [])].slice(0, HISTORY));
  return status;
}

async function main() {
  const config = companionConfig();
  const engine = new EngineClient({ socketPath: config.socketPath, registryToken: config.token });
  console.log(`[companion] Looking after "${config.container}" (${config.image}) through ${config.socketPath}; requests in ${updaterDir(config.dataDir)}.`);
  let last = 0;
  let busy = false;
  const loop = async () => {
    if (busy) return;
    busy = true;
    try {
      const beat = Date.now() - last > 30_000;
      if (beat) last = Date.now();
      const done = await tick({ config, engine, beat });
      if (done) console.log(`[companion] ${done.tag}: ${done.state}${done.error ? ` (${done.error})` : ''}`);
    } catch (error) {
      console.error(`[companion] ${error.message}`);
    } finally {
      busy = false;
    }
  };
  await loop();
  setInterval(loop, 5000);
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
