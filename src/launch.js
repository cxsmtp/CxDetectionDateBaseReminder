/**
 * The container's start command: runs the version of CxMissionZero the
 * Admin chose on the Update page (or the image's own), and keeps it running.
 *
 *  - Switch: the server asks (after installing or choosing a version); the
 *    running one stops cleanly (as for a container update) and the chosen one
 *    starts. People see "reconnecting…" for a few seconds, as with an update.
 *  - Automatic rollback: a newly switched-to version that does not come up
 *    within START_TIMEOUT, or crashes repeatedly at first, is put back to the
 *    version that ran before, and the event is recorded for the Update page.
 *  - Self-healing: a crash is restarted with a growing pause (1 s … 30 s).
 *  - Stop: SIGTERM / SIGINT go to the server, which drains and saves; the
 *    container stops when it has.
 *
 * `node src/server.js` still works on its own (development, old start
 * commands); the Update page then says updates need this start command.
 */

import { fork } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILT_IN, VersionStore } from './updates/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const builtInDir = path.join(here, '..');
const builtInVersion = JSON.parse(fs.readFileSync(path.join(builtInDir, 'package.json'), 'utf8')).version;
const dataDir = path.resolve(process.env.DATA_DIR || path.join(builtInDir, 'data'));
const START_TIMEOUT_MS = Math.max(10, Number(process.env.UPDATE_START_TIMEOUT_SECONDS) || 150) * 1000;
const TRIAL_MS = 2 * 60_000;

const store = new VersionStore({ dataDir, builtInDir, builtInVersion });
const say = (message) => console.log(`[launch] ${message}`);

let child = null;
let current = null; // {version, dir, source}
let previous = null; // what ran before a switch, while the new one is on trial
let trialUntil = 0;
let stopping = false;
let switching = false;
let crashes = [];
let readyTimer = null;

function start(target, { trial = false } = {}) {
  current = target;
  const entry = path.join(target.dir, 'src', 'server.js');
  say(`Starting MZ-${target.version} (${target.source === 'update' ? 'installed from the Update page' : 'the image’s own'}).`);
  child = fork(entry, process.argv.slice(2), {
    cwd: process.cwd(),
    env: { ...process.env, MZ_SUPERVISOR: '1', MZ_BUILTIN_VERSION: builtInVersion, MZ_BUILTIN_DIR: builtInDir },
    stdio: 'inherit',
  });
  const started = Date.now();
  let ready = false;
  trialUntil = trial ? started + TRIAL_MS : 0;
  clearTimeout(readyTimer);
  readyTimer = setTimeout(() => {
    if (ready || stopping) return;
    say(`MZ-${target.version} did not come up within ${START_TIMEOUT_MS / 1000} s.`);
    if (trial && previous) rollBack(`did not come up within ${START_TIMEOUT_MS / 1000} s`);
    else child?.kill('SIGTERM');
  }, START_TIMEOUT_MS);
  readyTimer.unref?.();

  const markReady = () => {
    if (ready) return;
    ready = true;
    clearTimeout(readyTimer);
    if (trial) store.record({ type: 'started', version: target.version, from: previous?.version ?? '', ms: Date.now() - started });
  };
  // Versions from before the launcher never say "ready": their port answering is the sign.
  const probe = setInterval(() => {
    if (ready || !child) return clearInterval(probe);
    const socket = net.connect({ port: Number(process.env.PORT) || 3000, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      // Give a server that does say "ready" the chance to (it finishes starting first).
      setTimeout(() => !ready && child && probeOnly && markReady(), 20_000).unref?.();
    });
    socket.once('error', () => socket.destroy());
  }, 2000);
  probe.unref?.();
  let probeOnly = true;

  child.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      probeOnly = false;
      markReady();
    } else if (message.type === 'switch' || message.type === 'restart') {
      switchTo(message.type === 'restart' ? 'restart' : 'switch', message.by);
    }
  });

  child.on('exit', (code, signal) => {
    clearInterval(probe);
    const exited = child;
    child = null;
    clearTimeout(readyTimer);
    if (stopping) return process.exit(code ?? 0);
    if (switching) {
      switching = false;
      const next = store.active();
      const changed = next.version !== current.version || next.dir !== current.dir;
      if (changed) previous = current;
      return start(next, { trial: changed });
    }
    // Not asked to stop: a crash.
    const now = Date.now();
    crashes = [...crashes.filter((t) => now - t < 10 * 60_000), now];
    store.record({ type: 'crash', version: current.version, code, signal: signal ?? '' });
    if (trialUntil && now < trialUntil && previous) return rollBack(`stopped with code ${code ?? signal} ${Math.round((now - started) / 1000)} s after starting`);
    const pause = Math.min(30_000, 1000 * 2 ** Math.max(0, crashes.length - 1));
    say(`MZ-${current.version} stopped unexpectedly (code ${code ?? signal}); starting it again in ${pause / 1000} s.`);
    setTimeout(() => !stopping && !child && exited && start(current), pause).unref?.();
  });
}

/** The running server stops cleanly; the version now chosen starts. */
function switchTo(kind, by = '') {
  if (!child || switching || stopping) return;
  switching = true;
  const next = store.active();
  say(kind === 'restart' ? `Restarting MZ-${current.version}.` : `Switching from MZ-${current.version} to MZ-${next.version}.`);
  store.record({ type: kind, from: current.version, to: next.version, by });
  child.kill('SIGTERM');
}

/** The version on trial failed: go back to the one that ran before it. */
function rollBack(reason) {
  const failed = current;
  const back = previous;
  previous = null;
  trialUntil = 0;
  say(`MZ-${failed.version} failed (${reason}); going back to MZ-${back.version}.`);
  store.record({ type: 'rollback', from: failed.version, to: back.version, reason, automatic: true });
  try {
    store.choose(back.source === 'image' ? BUILT_IN : back.version, { by: 'automatic rollback' });
  } catch (error) {
    say(`Could not record the rollback (${error.message}); running the image’s own version.`);
    store.choose(BUILT_IN, { by: 'automatic rollback' });
  }
  if (!child) return start(store.active());
  // Still running (it never came up): stop it cleanly so it lets go of the data folder, then start the previous one.
  const failing = child;
  child = null;
  switching = false;
  failing.removeAllListeners('exit');
  failing.on('exit', (code) => (stopping ? process.exit(code ?? 0) : start(store.active())));
  failing.kill('SIGTERM');
  setTimeout(() => failing.exitCode === null && failing.signalCode === null && failing.kill('SIGKILL'), 15_000).unref?.();
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    if (child) child.kill(signal);
    else process.exit(0);
  });
}

start(store.active());
