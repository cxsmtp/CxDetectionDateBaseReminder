// Prints what the server registers on its Express app, in registration order: every middleware and every route,
// each route with its method, its path and the names of the functions in front of its handler.
//
//   node scripts/list-routes.mjs            prints the list
//   node scripts/list-routes.mjs --write    writes it to test/fixtures/routes.txt
//   node scripts/list-routes.mjs --code     adds a fingerprint of each function's source, indentation aside: two
//                                           lists that are the same prove that code was moved and not changed
//
// Express runs middleware and routes in the order they were registered, so this order is behaviour: a body
// parser, the licence gate or a permission check that moves behind a route no longer applies to it.
// test/route-order.test.js compares this list with test/fixtures/routes.txt, so the order cannot change
// unnoticed. After a change that is meant (a new route, a new guard), look at the difference and run --write.
//
// The list is read from the running app (src/server.js started on an empty data folder of its own, on a port
// the system picks, with nothing of this machine's .env), not from the source.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SNAPSHOT = path.join(ROOT, 'test', 'fixtures', 'routes.txt');

const WITH_CODE = process.env.LIST_ROUTES_CODE === '1';
/** A function's name and, when asked for, a fingerprint of its source that moving it (deeper or shallower) keeps. */
const nameOf = (fn) => {
  const name = fn?.name || '<anonymous>';
  if (!WITH_CODE || typeof fn !== 'function') return name;
  const source = Function.prototype.toString.call(fn).replace(/^[ \t]+/gm, '');
  return `${name}#${createHash('sha256').update(source).digest('hex').slice(0, 10)}`;
};

/** Where a middleware is mounted, from the expression Express made of its path ('' when it sees every request). */
function mountOf(layer) {
  if (layer.regexp?.fast_slash) return '';
  if (layer.regexp?.fast_star) return '*';
  return String(layer.regexp?.source ?? '')
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\\\//g, '/')
    .replace(/\\\./g, '.');
}

/** The lines for a stack of layers (an app's or a mounted router's), in order. */
function linesOf(stack, prefix = '') {
  const lines = [];
  for (const layer of stack) {
    if (layer.route) {
      const paths = [].concat(layer.route.path).map((p) => `${prefix}${p}`).join(' | ');
      // One line for each method in a row (app.get(path, a, b) is one; app.route(path).get(a).post(b) is two).
      let line = null;
      for (const step of layer.route.stack) {
        const method = (step.method ?? 'all').toUpperCase();
        if (!line || line.method !== method) lines.push((line = { method, paths, names: [] }));
        line.names.push(nameOf(step.handle));
      }
    } else if (Array.isArray(layer.handle?.stack)) {
      lines.push({ method: 'USE', paths: `${prefix}${mountOf(layer)}`, names: ['<router>'] });
      lines.push(...linesOf(layer.handle.stack, `${prefix}${mountOf(layer)}`));
    } else {
      lines.push({ method: 'USE', paths: `${prefix}${mountOf(layer)}` || '(every request)', names: [`${nameOf(layer.handle)}${layer.handle.length === 4 ? ' (error handler)' : ''}`] });
    }
  }
  return lines;
}

export const format = (lines) => `${lines.map((l) => `${l.method.padEnd(7)}${l.paths}  [${l.names.join(', ')}]`).join('\n')}\n`;

/** Start the server in a process of its own and read the list from its app. */
export async function listRoutes({ withCode = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mz-routes-'));
  const out = path.join(dataDir, 'routes.out');
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--from-app', out], {
      cwd: ROOT,
      // The same for everyone: nothing of this machine's settings decides what is registered.
      env: {
        PATH: process.env.PATH,
        TMPDIR: os.tmpdir(),
        PORT: '0',
        HOST: '127.0.0.1',
        HTTPS: 'off',
        DATA_DIR: dataDir,
        SETTINGS_FILE: '',
        ACCEPT_TERMS: 'tests@acme.io',
        BACKUP_INTERVAL_HOURS: '0',
        BACKUP_PASSPHRASE: '',
        BACKUP_ENCRYPTION: '',
        BACKUP_DIR: '',
        BACKUP_EMAIL: '',
        SMTP_HOST: '',
        CX_API_KEY: '',
        CX_BASE_URL: '',
        CX_IAM_URL: '',
        CX_TENANT: '',
        ADMIN_EMAIL: '',
        ADMIN_PASSWORD: '',
        GITHUB_TOKEN: '',
        GITLAB_TOKEN: '',
        AZURE_DEVOPS_TOKEN: '',
        BITBUCKET_TOKEN: '',
        LETSENCRYPT_DOMAIN: '',
        HTTP_REDIRECT_PORT: '',
        TRUST_PROXY: '',
        COMPRESSION: '',
        LIST_ROUTES_CODE: withCode ? '1' : '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    const code = await new Promise((resolve) => child.on('exit', resolve));
    if (code !== 0 || !fs.existsSync(out)) throw new Error(`The server did not start (exit code ${code}):\n${log}`);
    return fs.readFileSync(out, 'utf8');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (process.argv[2] === '--from-app') {
  // In the process started above: every route is registered once the module has been evaluated.
  const { app } = await import(pathToFileURL(path.join(ROOT, 'src', 'server.js')).href);
  fs.writeFileSync(process.argv[3], format(linesOf(app._router.stack)));
  process.exit(0);
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const list = await listRoutes({ withCode: process.argv[2] === '--code' });
  if (process.argv[2] === '--write') {
    fs.writeFileSync(SNAPSHOT, list);
    console.log(`Wrote ${list.split('\n').length - 1} lines to ${path.relative(ROOT, SNAPSHOT)}`);
  } else {
    process.stdout.write(list);
  }
}
