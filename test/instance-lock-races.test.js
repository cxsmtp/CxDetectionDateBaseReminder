// One server per data folder, also when things happen at the same moment:
// a lock is never read half written, two servers starting on a dead server's
// lock never both get it, a server whose lock was taken finds out and stops,
// and another machine's clock is never compared with this one's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { InstanceLock, LOCK_FILE } from '../src/instance-lock.js';

const MODULE = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'instance-lock.js')).href;
const LOCKED = /Another CxMissionZero server .* is using this data folder/;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lockFile = (dir) => path.join(dir, LOCK_FILE);
const readLock = (dir) => JSON.parse(fs.readFileSync(lockFile(dir), 'utf8'));
const leftovers = (dir) => fs.readdirSync(dir).filter((name) => name !== LOCK_FILE);

/**
 * What a test leaves behind, tidied when it ends, pass or fail: first its other
 * processes are stopped (they write into the folders), then its folders go.
 */
const tidying = new WeakMap();
function tidy(t) {
  if (!tidying.has(t)) {
    const made = { children: [], dirs: [] };
    tidying.set(t, made);
    t.after(async () => {
      for (const proc of made.children) proc.kill('SIGKILL');
      await Promise.all(made.children.map((proc) => proc.exited));
      for (const dir of made.dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    });
  }
  return tidying.get(t);
}

/** A temporary folder, removed when the test ends. */
function folder(t, name = 'lock-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  tidy(t).dirs.push(dir);
  return dir;
}

/** Wait for something to become true, rather than for a fixed time. */
async function until(what, check, { timeoutMs = 10_000, everyMs = 5 } = {}) {
  const end = performance.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (performance.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await pause(everyMs);
  }
}

/** A lock as a server that died left it. */
function deadLock(dir, more = {}) {
  fs.writeFileSync(lockFile(dir), JSON.stringify({ id: 'dead', host: 'old', pid: 1, startedAt: '2026-01-01T00:00:00.000Z', beat: Date.now(), ...more }));
}

/** Another process, running `code` as a module; it can be sent messages. Killed when the test ends. */
function child(t, code, args = []) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  proc.out = '';
  proc.err = '';
  proc.messages = [];
  proc.stdout.on('data', (d) => (proc.out += d));
  proc.stderr.on('data', (d) => (proc.err += d));
  proc.on('message', (m) => proc.messages.push(m));
  proc.exited = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })));
  tidy(t).children.push(proc);
  proc.next = (type) => until(`"${type}" from a child process (${proc.err})`, () => proc.messages.find((m) => m.type === type));
  return proc;
}

// A server holding the lock in a process of its own. Options: {staleMs, beatMs, marker}.
const HOLDER = `
import fs from 'node:fs';
import { InstanceLock } from ${JSON.stringify(MODULE)};
const [dir, json] = process.argv.slice(1);
const { marker, ...options } = JSON.parse(json);
// What a clean stop or process.exit would do: save. It must not happen once the lock is lost.
if (marker) process.on('exit', () => fs.writeFileSync(marker, 'saved on exit'));
const lock = await new InstanceLock(dir, options).acquire({ waitMs: 0 });
process.send({ type: 'held', id: lock.id });
process.on('message', (m) => {
  if (m.type !== 'stop') return;
  lock.release();
  process.exit(0);
});
setInterval(() => {}, 1000);
`;

// An older server (up to MZ-01.01.09): rewrites its lock in place, so the file is empty for a moment at every beat.
const OLD_WRITER = `
import fs from 'node:fs';
const [file] = process.argv.slice(1);
const pad = 'x'.repeat(300000);
let told = false;
for (;;) {
  fs.writeFileSync(file, JSON.stringify({ id: 'old-server', host: 'old', pid: process.pid, startedAt: 'then', beat: Date.now(), pad }), { mode: 0o600, flag: 'w' });
  if (!told) process.send({ type: 'writing' });
  told = true;
  await new Promise((resolve) => setImmediate(resolve));
}
`;

// Several servers starting at the same moment on many data folders, each with a dead server's lock.
const RACER = `
import { InstanceLock } from ${JSON.stringify(MODULE)};
const lost = [];
let locks = [];
process.on('message', async (m) => {
  if (m.type === 'go') {
    while (Date.now() < m.at) await new Promise((resolve) => setImmediate(resolve));
    locks = m.dirs.map((dir, round) => new InstanceLock(dir, { ...m.options, onLost: (reason) => lost.push({ round, reason }) }));
    const results = await Promise.all(locks.map((lock) => lock.acquire({ waitMs: 0 }).then(() => ({ won: true, id: lock.id }), (error) => ({ won: false, code: error.code, message: error.message }))));
    process.send({ type: 'results', results });
  } else if (m.type === 'report') {
    process.send({ type: 'state', held: locks.map((lock) => lock.held), lost });
  } else if (m.type === 'stop') {
    for (const lock of locks) lock.release();
    process.exit(0);
  }
});
process.send({ type: 'ready' });
`;

test('a heartbeat is never seen half written: every read during hundreds of beats is a whole lock', async (t) => {
  const dir = folder(t);
  const holder = child(t, HOLDER, [dir, JSON.stringify({ staleMs: 3000, beatMs: 10 })]);
  const { id } = await holder.next('held');
  let reads = 0;
  const bad = [];
  let seq = 0;
  const end = performance.now() + 30_000;
  while (seq < 300) {
    assert.ok(performance.now() < end, `only ${seq} beats in 30 s (${holder.err})`);
    for (let i = 0; i < 200; i += 1) {
      reads += 1;
      let raw = null;
      try {
        raw = fs.readFileSync(lockFile(dir), 'utf8');
        const held = JSON.parse(raw);
        assert.equal(held.id, id);
        seq = held.seq;
      } catch (error) {
        bad.push(`${error.code ?? error.message}: ${JSON.stringify(raw)}`.slice(0, 120));
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(bad.slice(0, 3), [], `${bad.length} of ${reads} reads did not see a whole lock`);
  assert.ok(reads > 1000);
  t.diagnostic(`${reads} reads across ${seq} beats, all whole`);

  // And a server that wants the folder meanwhile is refused every time, never let in.
  for (let i = 0; i < 20; i += 1) {
    await assert.rejects(new InstanceLock(dir, { staleMs: 3000, pollMs: 2 }).acquire({ waitMs: 0 }), LOCKED);
  }
  assert.equal(readLock(dir).id, id);
  holder.send({ type: 'stop' });
  assert.deepEqual(await holder.exited, { code: 0, signal: null });
  assert.deepEqual(fs.readdirSync(dir), [], 'a clean stop leaves nothing behind');
});

test('a lock an older server rewrites in place (empty for a moment at each beat) is held, never taken', async (t) => {
  const dir = folder(t);
  const writer = child(t, OLD_WRITER, [lockFile(dir)]);
  await writer.next('writing');
  let partial = 0;
  for (let i = 0; i < 25; i += 1) {
    // Shorter than any stale time a server uses: an unreadable moment must still never count as a dead server.
    await assert.rejects(new InstanceLock(dir, { staleMs: 60, pollMs: 1, retryMs: 1 }).acquire({ waitMs: 0 }), LOCKED);
    for (let j = 0; j < 40; j += 1) {
      try {
        JSON.parse(fs.readFileSync(lockFile(dir), 'utf8'));
      } catch {
        partial += 1;
      }
    }
  }
  t.diagnostic(`${partial} of 1000 plain reads caught the lock half written`);
  writer.kill('SIGKILL');
  await writer.exited;
  // Once that server is dead its lock stops changing, whatever state it was left in, and is taken over.
  const next = await new InstanceLock(dir, { staleMs: 150, pollMs: 5 }).acquire({ waitMs: 0 });
  assert.equal(readLock(dir).id, next.id);
  next.release();
});

test('servers racing for a dead server\'s lock in one process: exactly one gets it, every time', async (t) => {
  const ROUNDS = 60;
  const round = async () => {
    const dir = folder(t);
    deadLock(dir);
    const lost = [];
    const locks = Array.from({ length: 4 }, () => new InstanceLock(dir, { staleMs: 40, pollMs: 1, onLost: (reason) => lost.push(reason) }));
    const results = await Promise.allSettled(locks.map((lock) => lock.acquire({ waitMs: 0 })));
    const winners = locks.filter((_, i) => results[i].status === 'fulfilled');
    assert.equal(winners.length, 1, `${winners.length} servers hold one data folder`);
    for (const result of results) if (result.status === 'rejected') assert.match(result.reason.message, LOCKED);
    assert.equal(readLock(dir).id, winners[0].id);
    assert.deepEqual(locks.map((lock) => lock.held), locks.map((lock) => lock === winners[0]));
    assert.deepEqual(leftovers(dir), [], 'the dead lock moved aside is removed');
    for (const lock of locks) lock.release();
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.deepEqual(lost, []);
  };
  for (let done = 0; done < ROUNDS; done += 20) await Promise.all(Array.from({ length: 20 }, round));
});

test('servers racing for a dead server\'s lock in three processes: exactly one gets it, and keeps it', async (t) => {
  const ROUNDS = 40;
  const dirs = Array.from({ length: ROUNDS }, () => {
    const dir = folder(t);
    deadLock(dir);
    return dir;
  });
  const racers = [0, 1, 2].map(() => child(t, RACER));
  await Promise.all(racers.map((racer) => racer.next('ready')));
  const at = Date.now() + 100;
  for (const racer of racers) racer.send({ type: 'go', at, dirs, options: { staleMs: 120, pollMs: 2 } });
  const results = (await Promise.all(racers.map((racer) => racer.next('results')))).map((m) => m.results);
  // Every winner has beaten a few times since, so one whose lock was taken from it has had the chance to notice.
  const beats = (dir) => {
    try {
      return readLock(dir).seq;
    } catch {
      return 0;
    }
  };
  await until('the winners to beat', () => dirs.every((dir) => beats(dir) >= 4));
  for (const racer of racers) racer.send({ type: 'report' });
  const states = await Promise.all(racers.map((racer) => racer.next('state')));
  for (const [round, dir] of dirs.entries()) {
    const winners = racers.map((_, r) => r).filter((r) => results[r][round].won);
    assert.equal(winners.length, 1, `round ${round}: ${winners.length} servers hold one data folder`);
    for (const r of [0, 1, 2]) {
      if (r === winners[0]) continue;
      assert.equal(results[r][round].code, 'ELOCKED', results[r][round].message);
    }
    assert.equal(readLock(dir).id, results[winners[0]][round].id);
    assert.deepEqual(states.map((state) => state.held[round]), [0, 1, 2].map((r) => r === winners[0]), `round ${round}: who still holds it`);
  }
  assert.deepEqual(states.flatMap((state) => state.lost), [], 'nobody had a lock taken from it');
  t.diagnostic(`wins per process: ${[0, 1, 2].map((r) => results[r].filter((x) => x.won).length).join(' / ')}`);
  for (const racer of racers) racer.send({ type: 'stop' });
  for (const racer of racers) assert.deepEqual(await racer.exited, { code: 0, signal: null });
  for (const dir of dirs) assert.deepEqual(fs.readdirSync(dir), [], 'every lock let go, nothing left behind');
});

test('a server whose lock was replaced is told, stops beating, and leaves the new lock alone', async (t) => {
  const dir = folder(t);
  let lost;
  const told = new Promise((resolve) => (lost = (reason, holder) => resolve({ reason, holder })));
  const lock = await new InstanceLock(dir, { staleMs: 150, onLost: lost }).acquire();
  assert.equal(lock.held, true);
  await until('a first beat', () => readLock(dir).seq >= 2);

  const theirs = JSON.stringify({ id: 'the-other-server', host: 'elsewhere', pid: 7, startedAt: 'later', beat: Date.now() });
  fs.writeFileSync(lockFile(dir), theirs);
  const { reason, holder } = await until('the loss to be noticed', () => Promise.race([told, pause(1).then(() => null)]));
  assert.match(reason, /Lost the lock on the data folder .*another CxMissionZero server \(host elsewhere, started later\) has taken it over/);
  assert.equal(holder.id, 'the-other-server');
  assert.equal(lock.held, false);

  // Several beat times later the file is exactly as the other server wrote it.
  await pause(250);
  assert.equal(fs.readFileSync(lockFile(dir), 'utf8'), theirs);
  assert.deepEqual(leftovers(dir), [], 'no half-made beat left behind');
  lock.release();
  assert.equal(fs.readFileSync(lockFile(dir), 'utf8'), theirs, 'release does not remove a lock that is not ours');
});

test('a server whose lock file was removed, or overwritten with something else, is told as well', async (t) => {
  for (const [damage, expected] of [
    [(file) => fs.rmSync(file), /the lock file was removed/],
    [(file) => fs.writeFileSync(file, '{"id":'), /overwritten with something that is not a lock/],
  ]) {
    const dir = folder(t);
    let lost;
    const told = new Promise((resolve) => (lost = resolve));
    const lock = await new InstanceLock(dir, { staleMs: 150, retryMs: 5, onLost: lost }).acquire();
    damage(lockFile(dir));
    const reason = await until('the loss to be noticed', () => Promise.race([told, pause(1).then(() => null)]));
    assert.match(reason, expected);
    assert.equal(lock.held, false);
    const after = fs.existsSync(lockFile(dir)) ? fs.readFileSync(lockFile(dir), 'utf8') : null;
    await pause(200);
    assert.equal(fs.existsSync(lockFile(dir)) ? fs.readFileSync(lockFile(dir), 'utf8') : null, after, 'it does not write the lock again');
    lock.release();
  }
});

test('by default a server that lost its lock ends at once, without the saving a clean stop does', async (t) => {
  const dir = folder(t);
  const marker = path.join(folder(t), 'saved');
  const holder = child(t, HOLDER, [dir, JSON.stringify({ staleMs: 150, marker })]);
  await holder.next('held');
  const theirs = JSON.stringify({ id: 'the-other-server', host: 'elsewhere', pid: 7, startedAt: 'later', beat: Date.now() });
  fs.writeFileSync(lockFile(dir), theirs);
  assert.deepEqual(await holder.exited, { code: null, signal: 'SIGKILL' });
  assert.match(holder.err, /Lost the lock on the data folder .* has taken it over\. Stopping at once, without saving anything more/);
  assert.equal(fs.existsSync(marker), false, 'nothing ran on the way out');
  assert.equal(fs.readFileSync(lockFile(dir), 'utf8'), theirs);
});

test('release removes our own lock, and never one that is not ours', async (t) => {
  const dir = folder(t);
  // A server that never got the lock.
  deadLock(dir);
  const before = fs.readFileSync(lockFile(dir), 'utf8');
  new InstanceLock(dir).release();
  assert.equal(fs.readFileSync(lockFile(dir), 'utf8'), before);
  // One that was refused it.
  const holder = await new InstanceLock(dir, { staleMs: 90, pollMs: 2 }).acquire({ waitMs: 0 });
  const refused = new InstanceLock(dir, { staleMs: 90, pollMs: 2 });
  await assert.rejects(refused.acquire({ waitMs: 0 }), LOCKED);
  refused.release();
  assert.equal(readLock(dir).id, holder.id);
  // The holder itself.
  holder.release();
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(holder.held, false);
});

test('a lock that cannot be read is held: taken over only once it has not changed for the stale time', async (t) => {
  for (const content of ['', '{"id":"half', 'not a lock at all']) {
    const dir = folder(t);
    fs.writeFileSync(lockFile(dir), content);
    const started = performance.now();
    const waiting = [];
    const lock = await new InstanceLock(dir, { staleMs: 300, pollMs: 5, retryMs: 2 }).acquire({ waitMs: 0, onWait: (held) => waiting.push(held.host) });
    const took = performance.now() - started;
    assert.ok(took >= 300, `taken after ${Math.round(took)} ms, before the stale time`);
    assert.deepEqual(waiting, ['unknown'], 'the wait is announced, with no holder to name');
    assert.equal(readLock(dir).id, lock.id);
    lock.release();
  }

  // One that cannot be read but keeps changing belongs to somebody alive: refused, and left as it is.
  const dir = folder(t);
  let n = 0;
  const scribble = () => fs.writeFileSync(lockFile(dir), `{"id":"half ${(n += 1)}`);
  scribble();
  const writer = setInterval(scribble, 20);
  t.after(() => clearInterval(writer));
  await assert.rejects(new InstanceLock(dir, { staleMs: 200, pollMs: 5, retryMs: 2 }).acquire({ waitMs: 400 }), /Another CxMissionZero server \(host unknown, started unknown\) is using this data folder/);
  clearInterval(writer);
  assert.match(fs.readFileSync(lockFile(dir), 'utf8'), /^\{"id":"half \d+$/);
});

test('staleness is how long the lock went unchanged on our own clock, not the time another machine wrote in it', async (t) => {
  // A live server whose clock is an hour behind: its beats look ancient, yet they keep coming.
  const behind = folder(t);
  let n = 0;
  const beat = () => {
    const tmp = `${lockFile(behind)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ id: 'slow-clock', host: 'far', startedAt: 'then', beat: Date.now() - 3_600_000, n: (n += 1) }));
    fs.renameSync(tmp, lockFile(behind));
  };
  beat();
  const beating = setInterval(beat, 20);
  t.after(() => clearInterval(beating));
  await assert.rejects(new InstanceLock(behind, { staleMs: 150, pollMs: 5 }).acquire({ waitMs: 400 }), /Another CxMissionZero server \(host far/);
  clearInterval(beating);
  assert.equal(readLock(behind).id, 'slow-clock');

  // A dead server whose clock was a day ahead: its last beat is "in the future", and it is still taken over.
  const ahead = folder(t);
  deadLock(ahead, { beat: Date.now() + 86_400_000 });
  const started = performance.now();
  const lock = await new InstanceLock(ahead, { staleMs: 200, pollMs: 5 }).acquire({ waitMs: 0 });
  assert.ok(performance.now() - started >= 200);
  lock.release();
});

test('a dead lock is taken over even when the wait allowed is shorter than the stale time, and never sooner than three of its holder\'s beats', async (t) => {
  const dir = folder(t);
  deadLock(dir);
  let started = performance.now();
  const first = await new InstanceLock(dir, { staleMs: 250, pollMs: 5 }).acquire({ waitMs: 0 });
  assert.ok(performance.now() - started >= 250);
  first.release();

  // The dead server said it beat every 150 ms: a server set to a shorter stale time still waits three beats.
  deadLock(dir, { beatMs: 150 });
  started = performance.now();
  const second = await new InstanceLock(dir, { staleMs: 100, pollMs: 5 }).acquire({ waitMs: 0 });
  assert.ok(performance.now() - started >= 450);
  second.release();
});

test('a starting server killed in the middle of taking over does not keep the others out for ever', async (t) => {
  const dir = folder(t);
  deadLock(dir);
  // What it left: its marker that a takeover is under way, and the dead lock it had moved aside.
  const killed = '0b0e6f6e-9d0c-4c57-8f43-3d1f5a1c2b7e';
  fs.writeFileSync(`${lockFile(dir)}.takeover`, killed);
  fs.writeFileSync(`${lockFile(dir)}.stale-${killed}`, 'the lock it moved');
  const started = performance.now();
  const lock = await new InstanceLock(dir, { staleMs: 200, pollMs: 5 }).acquire({ waitMs: 0 });
  const took = performance.now() - started;
  assert.ok(took >= 400, `taken after ${Math.round(took)} ms: the marker is given a stale time of its own`);
  assert.equal(readLock(dir).id, lock.id);
  assert.deepEqual(leftovers(dir), [], 'what the killed server left is cleared');
  lock.release();
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a lock that cannot be opened at all is held for good: a start waits, refuses, and takes nothing over', async (t) => {
  const dir = folder(t);
  // Something there that reading fails on, the same at every look (as a file of another user's would be).
  fs.mkdirSync(lockFile(dir));
  const started = performance.now();
  await assert.rejects(new InstanceLock(dir, { staleMs: 150, pollMs: 5 }).acquire({ waitMs: 700 }), (error) => error.code === 'ELOCKED');
  assert.ok(performance.now() - started >= 650, 'not before the wait allowed, though the stale time passed four times');
  assert.ok(fs.statSync(lockFile(dir)).isDirectory(), 'left as it was');
  assert.deepEqual(leftovers(dir), []);
});

test('a heartbeat never writes through a link left under a name it might use', async (t) => {
  const dir = folder(t);
  const victim = path.join(dir, 'iam.json');
  fs.writeFileSync(victim, '{"users":["kept"]}');
  const lock = await new InstanceLock(dir, { staleMs: 300, beatMs: 20 }).acquire({ waitMs: 0 });
  // The name every beat used to write to, now a link to a state file.
  fs.symlinkSync(victim, `${lockFile(dir)}.${lock.id}.tmp`);
  const first = readLock(dir).seq;
  await until('a few more beats', () => readLock(dir).seq >= first + 3);
  assert.equal(fs.readFileSync(victim, 'utf8'), '{"users":["kept"]}');
  lock.release();
});

test('touch() is a heartbeat made at once, for work that gives the timer no turn', async (t) => {
  const dir = folder(t);
  const lock = await new InstanceLock(dir, { staleMs: 60_000 }).acquire({ waitMs: 0 });
  const before = fs.readFileSync(lockFile(dir), 'utf8');
  assert.equal(lock.touch(), true);
  const after = fs.readFileSync(lockFile(dir), 'utf8');
  assert.notEqual(after, before);
  assert.equal(JSON.parse(after).id, lock.id);
  assert.deepEqual(leftovers(dir), [], 'no temporary file left');
  // Taken by another server: touch says so and writes nothing.
  fs.writeFileSync(lockFile(dir), JSON.stringify({ id: 'someone-else', host: 'other', startedAt: 'now' }));
  assert.equal(lock.touch(), false);
  assert.equal(readLock(dir).id, 'someone-else');
});
