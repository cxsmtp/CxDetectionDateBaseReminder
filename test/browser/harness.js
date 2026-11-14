// What the browser tests share: a real server on a temporary data folder, wired to the mock Checkmarx One
// the e2e tests use, and a Chromium page that remembers everything that went wrong on it.
//
// Run with `npm run test:browser` (never by `npm test`: only the files directly in test/ are). Playwright is
// used as a library, from node --test; its version is pinned in package.json, and the Chromium it drives is
// the one installed for that version (CI: `npx playwright install --with-deps chromium`).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { freePort } from '../free-port.js';
import { SIGNING_KEY, mockApiKey } from '../test-credentials.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Stop a child and wait until it has gone (so its port and data folder are free). */
function stopChild(child, signal = 'SIGTERM') {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const hard = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('exit', () => {
      clearTimeout(hard);
      resolve();
    });
    child.kill(signal);
  });
}

/**
 * Start the mock Checkmarx One and the server (a new installation: an empty data folder, the first
 * administrator still to be created with the setup code from the log).
 * Returns { base, setupCode, log(), stop() }.
 */
export async function startServer({ projects = 3, risks = 4, env = {} } = {}) {
  const mockPort = await freePort();
  const port = await freePort();
  const mock = `http://127.0.0.1:${mockPort}`;
  const base = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-'));
  let log = '';
  const children = [];
  const stop = async () => {
    await Promise.all(children.map((child) => stopChild(child)));
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
  };
  try {
    children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(mockPort), LAT: '1', PROJECTS: String(projects), RISKS: String(risks) }, stdio: 'ignore' }));
    const server = spawn(process.execPath, ['src/server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        HTTPS: 'off',
        DATA_DIR: dataDir,
        SETTINGS_FILE: '',
        ACCEPT_TERMS: 'tests@acme.io',
        BACKUP_INTERVAL_HOURS: '0',
        BACKUP_PASSPHRASE: '',
        BACKUP_ENCRYPTION: '',
        SMTP_HOST: '',
        CX_API_KEY: mockApiKey({ iss: `${mock}/auth/realms/acme`, azp: 'integration' }),
        CX_BASE_URL: mock,
        CX_IAM_URL: mock,
        CX_TENANT: 'acme',
        REPORT_SIGNING_KEY: SIGNING_KEY,
        ADMIN_EMAIL: '',
        ADMIN_PASSWORD: '',
        FIRST_ADMIN: 'setup-code',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (d) => (log += d));
    server.stderr.on('data', (d) => (log += d));
    children.push(server);
    const end = Date.now() + 30_000;
    // Up, connected to Checkmarx One through the integration key, and the setup code is in the log.
    while (!(/running on/.test(log) && /setup code/.test(log) && /Successfully authenticated/.test(log))) {
      if (server.exitCode !== null) throw new Error(`The server stopped while starting:\n${log}`);
      if (Date.now() > end) throw new Error(`The server did not start in 30 s:\n${log}`);
      await sleep(100);
    }
    const setupCode = /^\s+([A-Z0-9]{4}(?:-[A-Z0-9]{1,4})+)\s*$/m.exec(log)?.[1];
    assert.ok(setupCode, `the setup code is in the server log:\n${log}`);
    return { base, setupCode, log: () => log, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * A Chromium page on `base` that keeps a list of what went wrong on it:
 * - every error nobody caught in the page;
 * - every request to the server itself that failed (no answer) or was answered 400 or above.
 * `expect(status, pathPattern)` says beforehand that one such answer is meant (a wrong password, say);
 * anything else is a problem, and `problems()` lists them in plain words.
 */
export async function openBrowser(base) {
  const browser = await chromium.launch();
  const origin = new URL(base).origin;
  const found = [];
  const expected = [];
  const sameOrigin = (url) => {
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  };
  const watch = (page, who) => {
    page.on('pageerror', (error) => found.push(`${who}: uncaught error in the page: ${error.message}`));
    page.on('requestfailed', (request) => {
      if (!sameOrigin(request.url())) return found.push(`${who}: the page asked for something outside the server: ${request.url()}`);
      const reason = request.failure()?.errorText ?? '';
      // The page itself gave the request up (it left the page, or stopped a stream it no longer needs).
      if (reason === 'net::ERR_ABORTED') return;
      found.push(`${who}: ${request.method()} ${new URL(request.url()).pathname} failed: ${reason}`);
    });
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.origin !== origin) return found.push(`${who}: the page loaded something from outside the server: ${response.url()}`);
      if (response.status() < 400) return;
      const i = expected.findIndex((e) => e.status === response.status() && e.path.test(url.pathname));
      if (i >= 0) return void expected.splice(i, 1);
      found.push(`${who}: ${response.request().method()} ${url.pathname} was answered ${response.status()}`);
    });
  };
  /** A person at their own browser (their own cookies): { page, context }. */
  const person = async (who) => {
    const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 } });
    context.setDefaultTimeout(15_000);
    const page = await context.newPage();
    watch(page, who);
    return { page, context };
  };
  return {
    person,
    /** One answer of `status` on a path matching `path` is meant: it is not a problem. */
    expect: (status, path) => expected.push({ status, path }),
    /** Everything that went wrong so far, and every answer that was announced and never came. */
    problems: () => [...found, ...expected.map((e) => `an answer ${e.status} on ${e.path} was expected and never came`)],
    close: () => browser.close(),
  };
}
