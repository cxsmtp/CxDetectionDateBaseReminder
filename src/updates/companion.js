/**
 * Full image updates through the companion container (Beta), the server's side.
 *
 * The companion (src/companion/main.js) is a second container with the container engine's
 * socket; this server never gets the socket. They talk through files in the shared data
 * volume, under updater/:
 *   companion.json  the companion's heartbeat: it is there, it reaches the engine, the container it looks after;
 *   request.json    written here: replace the image with {tag} (one at a time);
 *   status.json     written by the companion: where the update is, and how it ended;
 *   ack.json        written here at every start: which version runs, and since when, so the
 *                   companion knows the new container came up.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { TAG } from '../companion/full-update.js';

export const HEARTBEAT_FRESH_MS = 90_000;
const FINISHED = new Set(['done', 'unchanged', 'rolled-back', 'failed', 'refused']);

export const updaterDir = (dataDir) => path.join(dataDir, 'updater');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode });
  fs.renameSync(temp, file);
}

/** What the Update page shows: is the companion there, and the last full update. */
export function companionState(dataDir, now = Date.now()) {
  const dir = updaterDir(dataDir);
  const heartbeat = readJson(path.join(dir, 'companion.json'));
  const status = readJson(path.join(dir, 'status.json'));
  const pending = readJson(path.join(dir, 'request.json'));
  const age = heartbeat ? now - Date.parse(heartbeat.at ?? '') : Infinity;
  return {
    connected: Number.isFinite(age) && age < HEARTBEAT_FRESH_MS,
    heartbeat: heartbeat ? { at: heartbeat.at, engine: heartbeat.engine ?? '', engineError: heartbeat.engineError ?? '', container: heartbeat.container ?? '', image: heartbeat.image ?? '', version: heartbeat.version ?? '' } : null,
    status,
    pending: pending ? { id: pending.id, tag: pending.tag, by: pending.by, at: pending.at } : null,
    busy: Boolean(pending) || Boolean(status && !FINISHED.has(status.state)),
  };
}

/** Ask the companion to replace the image with `tag`. One at a time, and only once it is there. */
export function requestFullUpdate(dataDir, { tag, by = '' }, now = Date.now()) {
  const value = String(tag ?? '').trim();
  if (!TAG.test(value)) throw Object.assign(new Error('Choose a version (for example 1.0.41), latest, or a commit tag.'), { status: 400 });
  const state = companionState(dataDir, now);
  if (!state.connected) throw Object.assign(new Error('The update companion is not running: start it (see Settings → Update & recovery → Full image update), or update with podman pull.'), { status: 409 });
  if (state.busy) throw Object.assign(new Error('A full image update is already under way.'), { status: 409 });
  const request = { id: randomUUID(), tag: value, by, at: new Date(now).toISOString() };
  writeJson(path.join(updaterDir(dataDir), 'request.json'), request, 0o600);
  return request;
}

/** Written at every start: the companion waits for it after starting a new container. */
export function acknowledgeStart(dataDir, { version, builtIn }) {
  try {
    writeJson(path.join(updaterDir(dataDir), 'ack.json'), { version, builtIn: builtIn || version, startedAt: new Date().toISOString(), pid: process.pid });
    return true;
  } catch {
    return false; // a read-only or full volume must never stop the server starting
  }
}

export { readJson, writeJson };
