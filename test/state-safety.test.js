// The stores on top of src/state-file.js: a damaged state file is never read as "nothing there" (and then
// saved over), and what they save is kept with its last good copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AuditLog } from '../src/audit-log.js';
import { CreditAllocations } from '../src/credit-allocations.js';
import { CreditLedger } from '../src/credits.js';
import { SessionPersistence } from '../src/handover.js';
import { IamStore } from '../src/iam.js';
import { readNetwork, saveNetwork } from '../src/network.js';
import { ReportGrants } from '../src/report-grants.js';
import { StateFileError } from '../src/state-file.js';
import { Tenancy } from '../src/tenancy.js';
import { TrackedReports } from '../src/tracked-reports.js';
import { NEXT_PASSWORD } from './test-credentials.js';

/** A folder of its own for one test, removed when the test ends. */
function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-safety-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Run `fn` with the console's error and warning lines collected instead of printed; returns [result, lines]. */
function quietly(fn) {
  const lines = [];
  const { error, warn } = console;
  console.error = console.warn = (...args) => lines.push(args.join(' '));
  try {
    return [fn(), lines];
  } finally {
    Object.assign(console, { error, warn });
  }
}

const sept = new Date('2026-09-15T10:00:00Z');

test('a damaged iam.json never means "no users": it is refused, left as it is, and no first administrator can be saved over it', async (t) => {
  const file = path.join(folder(t), 'iam.json');
  const iam = new IamStore({ file });
  assert.equal(iam.hasUsers(), false, 'a new installation: no file, nobody yet');
  await iam.createUser({ email: 'admin@acme.io', role: 'admin', password: NEXT_PASSWORD, mustChangePassword: false });
  assert.equal(new IamStore({ file }).hasUsers(), true);

  // One save only, so there is no last good copy: the file is cut short, as a crash mid-save left it before.
  fs.rmSync(`${file}.bak`, { force: true });
  const whole = fs.readFileSync(file, 'utf8');
  for (const damaged of [whole.slice(0, Math.floor(whole.length / 2)), '']) {
    fs.writeFileSync(file, damaged);
    assert.throws(() => new IamStore({ file }), (error) => error instanceof StateFileError && error.file === file && /users/.test(error.message));
    assert.equal(fs.readFileSync(file, 'utf8'), damaged, 'not written over');
  }
});

test('a damaged iam.json with a last good copy: the users come back from the copy', async (t) => {
  const dir = folder(t);
  const file = path.join(dir, 'iam.json');
  const iam = new IamStore({ file });
  await iam.createUser({ email: 'admin@acme.io', role: 'admin', password: NEXT_PASSWORD, mustChangePassword: false });
  await iam.createUser({ email: 'ana@acme.io', role: 'analyst', password: NEXT_PASSWORD, mustChangePassword: false });
  fs.writeFileSync(file, '{"version":1,"users":[{"id"');

  const [recovered, lines] = quietly(() => new IamStore({ file }));
  assert.equal(recovered.hasUsers(), true, 'never "no users" because of damage');
  assert.deepEqual(recovered.users().map((u) => u.email), ['admin@acme.io'], 'as of the save before the last');
  assert.ok(lines.some((line) => line.includes(file) && /last good copy/.test(line)), 'said on the error log');
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('iam.json.damaged-')).length, 1, 'the damaged file is kept');
});

test('a running server keeps its users when iam.json is damaged under it', async (t) => {
  const file = path.join(folder(t), 'iam.json');
  const iam = new IamStore({ file });
  const admin = await iam.createUser({ email: 'admin@acme.io', role: 'admin', password: NEXT_PASSWORD, mustChangePassword: false });
  fs.rmSync(`${file}.bak`, { force: true });
  fs.writeFileSync(file, '{ cut short');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000)); // seen as changed by another process
  assert.equal(iam.hasUsers(), true);
  assert.equal(iam.user(admin.id)?.email, 'admin@acme.io');
});

test('a damaged credit ledger never reads as zero spent', (t) => {
  const dir = folder(t);
  const file = path.join(dir, 'triage-credits.json');
  const ledger = new CreditLedger({ file, writeDelayMs: 0 });
  ledger.record({ projectId: 'p1', projectName: 'Payments', credits: 3 }, sept);
  assert.equal(fs.existsSync(`${file}.bak`), false);

  // No last good copy yet: refused, and the ledger is left for a backup to replace.
  const whole = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, whole.slice(0, whole.length - 9));
  assert.throws(() => new CreditLedger({ file }), (error) => error instanceof StateFileError && /credit ledger/.test(error.message));
  assert.equal(fs.readFileSync(file, 'utf8'), whole.slice(0, whole.length - 9));
  fs.writeFileSync(file, '');
  assert.throws(() => new CreditLedger({ file }), { code: 'STATE_FILE_DAMAGED' });

  // With one: what was spent as of the save before comes back, not zero.
  fs.writeFileSync(file, whole);
  const again = new CreditLedger({ file, writeDelayMs: 0 });
  again.record({ projectId: 'p1', projectName: 'Payments', credits: 2 }, sept);
  fs.writeFileSync(file, '{"entries":[{"proj');
  const [recovered] = quietly(() => new CreditLedger({ file }));
  assert.equal(recovered.summary('2026-09').total, 3);
});

test('the debounced ledger write is still one write for a burst, and it keeps the last good copy', async (t) => {
  const file = path.join(folder(t), 'triage-credits.json');
  const ledger = new CreditLedger({ file, writeDelayMs: 20 });
  ledger.record({ projectId: 'p1', credits: 1 }, sept);
  ledger.record({ projectId: 'p1', credits: 1 }, sept);
  assert.equal(fs.existsSync(file), false, 'not written at each record');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entries.length, 2);
  ledger.record({ projectId: 'p1', credits: 1 }, sept);
  ledger.flush();
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).entries.length, 2);
  assert.equal(new CreditLedger({ file }).summary('2026-09').total, 3);
});

test('damaged allocations, tracked reports and tenant list are refused, not read as none', (t) => {
  const dir = folder(t);
  const ledger = new CreditLedger({ file: path.join(dir, 'triage-credits.json') });
  for (const [name, open] of [
    ['credit-allocations.json', (file) => new CreditAllocations({ file, ledger })],
    ['tracked-reports.json', (file) => new TrackedReports({ file })],
  ]) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, '{ "cut": ');
    assert.throws(() => open(file), { code: 'STATE_FILE_DAMAGED', file }, name);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ "cut": ', name);
  }
  fs.writeFileSync(path.join(dir, 'tenants.json'), '');
  assert.throws(() => new Tenancy({ dataDir: dir, build: () => ({}) }), { code: 'STATE_FILE_DAMAGED' });
});

test('a key file cut short is refused, never replaced by a new key without a word', (t) => {
  const dir = folder(t);
  const keyFile = path.join(dir, 'audit.key');
  const log = new AuditLog({ dir: path.join(dir, 'audit'), keyFile });
  log.record({ type: 'system', outcome: 'info' });
  const key = fs.readFileSync(keyFile);
  assert.equal(key.length, 32);
  if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);

  fs.writeFileSync(keyFile, key.subarray(0, 10));
  assert.throws(() => new AuditLog({ dir: path.join(dir, 'audit'), keyFile }), (error) => error instanceof StateFileError && /at least 32/.test(error.message));
  assert.equal(fs.readFileSync(keyFile).length, 10, 'left as it is');
  fs.writeFileSync(keyFile, key);
  assert.equal(new AuditLog({ dir: path.join(dir, 'audit'), keyFile }).verify().ok, true);

  const signing = path.join(dir, 'report-signing.key');
  new ReportGrants({ file: signing });
  const signingKey = fs.readFileSync(signing);
  new ReportGrants({ file: signing });
  assert.deepEqual(fs.readFileSync(signing), signingKey, 'the same key at the next start');
  fs.writeFileSync(signing, '');
  assert.throws(() => new ReportGrants({ file: signing }), { code: 'STATE_FILE_DAMAGED' });
});

test('audit entries go on being written and verified with the month file kept open: across months, and when the file is moved away', (t) => {
  const dir = folder(t);
  const auditDir = path.join(dir, 'audit');
  const log = new AuditLog({ dir: auditDir, keyFile: path.join(dir, 'audit.key') });
  t.after(() => log.close());
  for (let i = 0; i < 5; i += 1) log.record({ type: 'system', outcome: 'info', details: { i } }, new Date('2026-09-30T23:59:00Z'));
  log.record({ type: 'system', outcome: 'info' }, new Date('2026-10-01T00:00:01Z'));
  log.record({ type: 'system', outcome: 'info' }, new Date('2026-10-01T00:00:02Z'));
  assert.deepEqual(log.files(), ['audit-2026-09.jsonl', 'audit-2026-10.jsonl']);
  assert.equal(fs.readFileSync(path.join(auditDir, 'audit-2026-09.jsonl'), 'utf8').trim().split('\n').length, 5);
  assert.deepEqual(log.verify().problems, []);
  assert.equal(log.verify().entries, 7);
  assert.equal(log.writeError, null);

  // Another process adds an entry (an admin command run next to the server): the chain carries on from it.
  new AuditLog({ dir: auditDir, keyFile: path.join(dir, 'audit.key') }).record({ type: 'iam', outcome: 'changed' }, new Date('2026-10-01T00:00:03Z'));
  log.record({ type: 'system', outcome: 'info' }, new Date('2026-10-01T00:00:04Z'));
  assert.equal(log.verify().ok, true);
  assert.equal(log.verify().entries, 9);

  // The month file is moved away under the open log (a restore does this): the next entry goes to a file
  // that is really in the folder, not to the one that left.
  const october = path.join(auditDir, 'audit-2026-10.jsonl');
  fs.renameSync(october, path.join(dir, 'moved-away.jsonl'));
  const entry = log.record({ type: 'system', outcome: 'info' }, new Date('2026-10-02T00:00:00Z'));
  assert.ok(fs.readFileSync(october, 'utf8').includes(entry.id));
  assert.ok(!fs.readFileSync(path.join(dir, 'moved-away.jsonl'), 'utf8').includes(entry.id));
});

test('the saved proxy: a damaged file does not stop the server, and removing the proxy removes its last good copy', (t) => {
  const dir = folder(t);
  saveNetwork(dir, { proxy: { url: 'http://proxy-a:3128' } });
  saveNetwork(dir, { proxy: { url: 'http://proxy-b:3128' } });
  assert.equal(readNetwork(dir).proxy.url, 'http://proxy-b:3128');

  // Damaged: put right from the copy.
  fs.writeFileSync(path.join(dir, 'network.json'), '{');
  const [recovered] = quietly(() => readNetwork(dir));
  assert.equal(recovered.proxy.url, 'http://proxy-a:3128');

  // Removed on purpose: the copy goes too, or it would be read as the proxy the next time.
  saveNetwork(dir, { proxy: { url: 'http://proxy-c:3128' } });
  saveNetwork(dir, null);
  assert.equal(readNetwork(dir), null);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f === 'network.json' || f === 'network.json.bak'), []);

  // Damaged with no copy: no proxy, said once, and the file is left for whoever looks into it.
  fs.writeFileSync(path.join(dir, 'network.json'), '{');
  const [none, lines] = quietly(() => [readNetwork(dir), readNetwork(dir)]);
  assert.deepEqual(none, [null, null]);
  assert.equal(lines.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'network.json'), 'utf8'), '{');
});

test('saved sign-ins: a damaged index means people sign in again, never a server that will not start', (t) => {
  const dir = folder(t);
  const sessions = new SessionPersistence(dir);
  const key = 'a'.repeat(64);
  sessions.saveIndex([{ key, userId: 'u1', via: 'password', createdAt: 1, lastUsedAt: 2 }]);
  assert.deepEqual(new SessionPersistence(dir).load().map((s) => s.userId), ['u1']);

  const index = path.join(dir, 'sessions', 'index.json');
  fs.writeFileSync(index, '');
  const [loaded, lines] = quietly(() => new SessionPersistence(dir).load());
  assert.deepEqual(loaded, []);
  assert.equal(lines.length, 1);

  // With a last good copy, the sign-ins come back from it.
  sessions.saveIndex([{ key, userId: 'u1', via: 'password', createdAt: 1, lastUsedAt: 2 }]);
  sessions.saveIndex([{ key, userId: 'u1', via: 'password', createdAt: 1, lastUsedAt: 3 }]);
  fs.writeFileSync(index, '{"version":1,"sess');
  const [again] = quietly(() => new SessionPersistence(dir).load());
  assert.deepEqual(again.map((s) => s.userId), ['u1']);
});
