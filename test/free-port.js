// A port nothing is listening on, for a server a test is about to start (test files run in parallel).
//
// Asking the OS for one (listen on 0, look, close) left a gap: between the look and the server's start,
// the OS could hand the same port to another test file's look, or to an outgoing connection, and the
// server then failed with EADDRINUSE. So the port is taken from below the range the OS hands out by
// itself (32768 and up on Linux, 49152 and up elsewhere), and claimed with a file made exclusively in
// the temporary folder, which only one test process can make: no two test files get the same port.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const FIRST = 10_000;
const LAST = 32_000;
/** A claim left by a test run that was killed is given up after this long. */
const STALE_MS = 10 * 60_000;
const claimed = [];
process.on('exit', () => {
  for (const file of claimed) fs.rmSync(file, { force: true });
});

function claim(port) {
  const file = path.join(os.tmpdir(), `mz-test-port-${port}`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.closeSync(fs.openSync(file, 'wx'));
      claimed.push(file);
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') return false;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(file).mtimeMs;
      } catch {}
      if (age < STALE_MS) return false;
      fs.rmSync(file, { force: true });
    }
  }
  return false;
}

const canListen = (port) =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });

export async function freePort() {
  for (let tries = 0; tries < 200; tries += 1) {
    const port = FIRST + Math.floor(Math.random() * (LAST - FIRST));
    if (claim(port) && (await canListen(port))) return port;
  }
  throw new Error('No free port found for a test server.');
}
