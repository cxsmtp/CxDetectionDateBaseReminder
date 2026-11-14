// Runs the tests (`npm test`, or `npm test -- test/one.test.js` for some of them) with a temporary folder of their
// own, removed when they finish. The tests make thousands of throwaway data folders; left in the system's temporary
// folder they fill the disk within a few runs, on a developer's machine and in CI alike.
//
//   node scripts/run-tests.mjs [node --test options] [test files]
//   KEEP_TEST_TMP=1 keeps the folder (its path is printed) to look into after a failure.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const options = args.filter((a) => a.startsWith('-'));
let files = args.filter((a) => !a.startsWith('-'));
if (!files.length) {
  files = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join('test', f));
}

// Short on purpose: some tests open Unix sockets under it, and a socket's path may not pass about 100 characters.
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mzt-'));
const clean = () => {
  if (process.env.KEEP_TEST_TMP) return console.error(`Test files kept in ${tmp}`);
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    console.error(`Could not remove ${tmp}: ${error.message}`);
  }
};

const child = spawn(process.execPath, ['--test', ...options, ...files], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp } });
// Ctrl+C reaches the tests too (same terminal); wait for them, then tidy up.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  clean();
  process.exit(code ?? (signal ? 1 : 0));
});
child.on('error', (error) => {
  console.error(error.message);
  clean();
  process.exit(1);
});
