import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';

import { CxClient } from './cxone/client.js';
import { deriveConnection } from './cxone/endpoints.js';
import { branchScopeOf } from './cxone/branches.js';
import { DEFAULT_ENGINES, cleanEngines } from './engines.js';
import { TenantReadStore, readFusionOffer, readTenant, seriesFor } from './projections.js';
import { createGitCounter, gitSource, listRepositories, sweepLeftovers } from './fusion-git.js';
import { MAX_PROJECTS, cleanOrigins, readLimit } from '../public/calculator/model.js';

/**
 * The standalone Cx Credits Calculator's launcher (cx-credits-calculator.mjs, built by
 * src/standalone-calculator.js): the calculator page, served on this computer only, that reads
 * Checkmarx One with the API key typed into it, with the same code as CxMissionZero's calculator.
 * A browser cannot call Checkmarx One from a page opened from disk (its API answers no other
 * site), so the reads go through here. Nothing is kept: the key and what was read live in this
 * process's memory until it stops. Only the page it served can use it (a secret in that page,
 * and this computer's own address). It also counts a new customer's code lines from git, with
 * this computer's git and a token typed for that count (src/fusion-git.js).
 */

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function body(req) {
  let size = 0;
  const parts = [];
  for await (const chunk of req) {
    size += chunk.length;
    // A scope's project ids: up to MAX_PROJECTS of them.
    if (size > 8 * 1024 * 1024) throw Object.assign(new Error('Too large.'), { status: 413 });
    parts.push(chunk);
  }
  if (!parts.length) return {};
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw Object.assign(new Error('That request is not JSON.'), { status: 400 });
  }
}

/** Open the page in this computer's browser; when that does not work, the address printed is enough. */
function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}

/** A token typed into the page for one count (Fusion — new customer, Count from git): checked, never kept. */
function typedSource(input) {
  const typed = input?.token && typeof input.token === 'object' ? input.token : null;
  if (!typed) throw Object.assign(new Error('Give the git host, its address and a token.'), { status: 400 });
  return gitSource({ provider: String(typed.provider ?? ''), address: String(typed.address ?? ''), token: String(typed.token ?? '') });
}

export async function startLauncher({ html, port = 0, host = '127.0.0.1', open = true, log = console.log, connect = (connection) => new CxClient(connection), gitBin = 'git' } = {}) {
  // Plain http, so this computer only: the page's secret and the API key never cross a network.
  if (!['127.0.0.1', 'localhost', '::1'].includes(String(host))) throw new Error(`The calculator only serves this computer (127.0.0.1), not ${host}.`);
  const secret = randomBytes(24).toString('base64url');
  const page = html.replace('"__CALCULATOR_LAUNCHER__"', JSON.stringify({ token: secret }));
  const state = { client: null, connection: null, job: null, read: new TenantReadStore({ file: null }) };
  // Counting from git with this computer's git: any host the token is for, never a link-local or metadata address.
  const counter = createGitCounter({ log, bin: gitBin, maxRunning: 1 });
  sweepLeftovers();

  const readView = (job) => (job ? { id: job.id, state: job.state, step: job.step, done: job.done, total: job.total, startedAt: job.startedAt, finishedAt: job.finishedAt ?? null, error: job.error ?? null, ...(job.state === 'done' ? { result: job.result } : {}) } : { state: 'none' });

  const routes = {
    'GET /launcher/status': () => ({ connected: Boolean(state.client), tenant: state.connection?.tenant ?? '', baseUrl: state.connection?.baseUrl ?? '' }),
    // Connect with a key: checked against Checkmarx One once, then kept in memory only.
    'POST /launcher/connect': async (input) => {
      const overrides = { baseUrl: String(input.baseUrl ?? '').trim(), iamUrl: String(input.iamUrl ?? '').trim(), tenant: String(input.tenant ?? '').trim() };
      let client;
      let connection;
      try {
        connection = deriveConnection(String(input.apiKey ?? ''), overrides);
        client = connect(connection);
        await client.request('/api/projects', { query: { limit: 1, offset: 0 }, retries: 1 });
      } catch (error) {
        throw Object.assign(new Error(error.status === 401 || error.status === 403 ? 'Checkmarx One refused that API key: check it has not expired and may read projects and scans.' : error.message), { status: 400 });
      }
      Object.assign(state, { client, connection, job: null, read: new TenantReadStore({ file: null }) });
      log(`Connected to Checkmarx One: tenant ${state.connection.tenant}.`);
      return { connected: true, tenant: state.connection.tenant, baseUrl: state.connection.baseUrl };
    },
    'POST /launcher/disconnect': () => {
      Object.assign(state, { client: null, connection: null, job: null, read: new TenantReadStore({ file: null }) });
      return { connected: false };
    },
    // As CxMissionZero's calculator reads (src/server.js, /api/projections/read): in the background, followed by the page.
    'POST /api/projections/read': (input) => {
      if (!state.client) throw Object.assign(new Error('Connect to Checkmarx One first: paste the API key at the top.'), { status: 409 });
      if (state.job?.state === 'running') return readView(state.job);
      const job = { id: randomUUID(), state: 'running', step: 'projects', done: 0, total: 0, startedAt: new Date().toISOString() };
      state.job = job;
      const client = state.client;
      Promise.all([
        readTenant(client, { branches: branchScopeOf(input?.branches), maxProjects: readLimit(input?.maxProjects), onProgress: (step, done, total) => Object.assign(job, { step, done, total }) }),
        readFusionOffer(client).catch(() => ({ models: [], remainingCredits: null })),
      ])
        .then(([{ perProject, ...tenant }, offer]) => {
          state.read.save(perProject);
          Object.assign(job, { state: 'done', result: { ...tenant, ...offer }, finishedAt: new Date().toISOString() });
          log(`Read ${tenant.projects?.length ?? 0} projects from Checkmarx One.`);
        })
        .catch((error) => {
          Object.assign(job, { state: 'failed', error: error.status === 401 || error.status === 403 ? 'Checkmarx One refused the read: check the API key may read projects and scans.' : `Checkmarx One could not be read: ${error.message}`, finishedAt: new Date().toISOString() });
        });
      return readView(job);
    },
    'GET /api/projections/read': () => readView(state.job),
    'POST /api/projections/series': (input) => {
      const read = state.read.get();
      if (!read?.weeks?.length) throw Object.assign(new Error('Read Checkmarx One first: the scope is worked out from the last read.'), { status: 409 });
      const ids = Array.isArray(input?.projectIds) ? input.projectIds.slice(0, MAX_PROJECTS).map((id) => String(id).slice(0, 100)) : [];
      return seriesFor(read, ids, cleanEngines(input?.engines).length ? cleanEngines(input.engines) : DEFAULT_ENGINES, cleanOrigins(input?.origins));
    },
    // Fusion — new customer, Count from git, as CxMissionZero counts (src/fusion-git.js), on this computer: a token
    // typed for one count only (there are no Admin's connections here), held in memory while the count runs.
    'GET /api/projections/git/connections': () => ({ connections: [] }),
    'POST /api/projections/git/repositories': (input) => listRepositories(typedSource(input), input?.owner),
    'POST /api/projections/git/count': (input) => counter.start('local', { source: typedSource(input), repositories: input?.repositories }),
    'GET /api/projections/git/count': (_input, url) => counter.view('local', url.searchParams.get('id')),
  };

  const server = http.createServer(async (req, res) => {
    const { port: own } = server.address();
    // Only this computer's own address (no other name pointed at it), and only the page served here.
    if (![`127.0.0.1:${own}`, `localhost:${own}`].includes(String(req.headers.host ?? ''))) return json(res, 421, { error: 'Open the calculator at the address the launcher printed.' });
    const url = new URL(req.url, `http://127.0.0.1:${own}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
      return res.end(page);
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return json(res, 404, { error: 'Not found.' });
    if (req.headers['x-calculator-token'] !== secret) return json(res, 403, { error: 'Open the calculator at the address the launcher printed.' });
    try {
      json(res, 200, await route(req.method === 'POST' ? await body(req) : null, url));
    } catch (error) {
      if (error.status) return json(res, error.status, { error: error.message });
      // Unexpected: the details (paths, internals) go to the launcher's own window, not to the page.
      log(`Something went wrong (${req.method} ${url.pathname}): ${error.stack ?? error.message}`);
      json(res, 500, { error: 'Something went wrong: the window the calculator was started from says what.' });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  log(`Cx Credits Calculator: ${url}`);
  log('Paste a Checkmarx One API key at the top of the page to read the tenant. Nothing is kept: press Ctrl+C to stop.');
  if (open) openBrowser(url);
  return { url, server, close: () => new Promise((resolve) => server.close(resolve)) };
}
