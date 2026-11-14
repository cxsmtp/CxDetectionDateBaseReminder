import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { CxClient } from './cxone/client.js';
import { deriveConnection } from './cxone/endpoints.js';
import { branchScopeOf } from './cxone/branches.js';
import { DEFAULT_ENGINES, cleanEngines } from './engines.js';
import { TenantReadStore, readFusionOffer, readJobView, readProgressOf, readTenant, seriesFor } from './projections.js';
import { writeState } from './state-file.js';
import { CLOC_FUSION, GIT_COUNT_LIMITS, clocFusionPage, createGitCounter, gitSource, listOrganizations, listRepositories, sweepLeftovers } from './fusion-git.js';
import { MAX_PROJECTS, cleanOrigins, readLimit } from '../public/calculator/model.js';

/**
 * The standalone Cx Credits Calculator's launcher (cx-credits-calculator.mjs, built by
 * src/standalone-calculator.js): the calculator page, served on this computer only, that reads
 * Checkmarx One with the API key typed into it, with the same code as CxMissionZero's calculator.
 * A browser cannot call Checkmarx One from a page opened from disk (its API answers no other
 * site), so the reads go through here. Nothing is kept: the key and what was read live in this
 * process's memory until it stops. Only the page it served can use it (a secret in that page,
 * and this computer's own address). It also measures a new customer's repositories with cloc-fusion's
 * engine, as CxMissionZero does (src/fusion-git.js): this computer's git (or the platforms' APIs) and a
 * token typed for that run; and hands out cloc-fusion's one-file page.
 */

/** The page's secret, compared in constant time (equal-length digests), so its answer times say nothing of it. */
const sameSecret = (given, secret) => timingSafeEqual(createHash('sha256').update(String(given ?? '')).digest(), createHash('sha256').update(secret).digest());

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function body(req, limit = 8 * 1024 * 1024) {
  let size = 0;
  const parts = [];
  for await (const chunk of req) {
    size += chunk.length;
    // A scope's project ids: up to MAX_PROJECTS of them (the data file: every customer and report, so more).
    if (size > limit) throw Object.assign(new Error('Too large.'), { status: 413 });
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

/** A token typed into the page for one run (Fusion — new customer, Count from git): checked, never kept. */
function typedSource(input) {
  const typed = input?.token && typeof input.token === 'object' ? input.token : null;
  if (!typed) throw Object.assign(new Error('Give the git host, its address and a token.'), { status: 400 });
  return gitSource({ provider: String(typed.provider ?? ''), address: String(typed.address ?? ''), token: String(typed.token ?? ''), key: 'token' });
}
/** What to list of the token's account: the organizations ticked (or the one typed), or everything it can see. */
const typedAsk = (input) => ({ orgs: (Array.isArray(input?.token?.orgs) ? input.token.orgs : input?.owner !== undefined ? [input.owner] : []).map(String).filter(Boolean), everything: input?.token?.everything === true });

/** The data file's name: kept in the folder the calculator was started from, so the data stays with whoever runs it. */
export const DATA_FILE = 'cx-credits-calculator-data.json';
const DATA_LIMIT = 256 * 1024 * 1024;
const emptyData = () => ({ kind: 'cx-credits-calculator', version: 1, savedAt: null, names: { organisation: '', preparedBy: '' }, customers: [], reports: [] });

/**
 * The customers, reports and names on the reports, kept in one JSON file beside where the launcher was started (the
 * page cleans each one as it loads them, as Restore does). Made when it is not there; a file that is not this
 * calculator's data is left as it is, and nothing is written over it.
 */
export function dataFileStore(file) {
  let broken = '';
  const read = () => {
    if (!fs.existsSync(file)) {
      write(emptyData());
      return emptyData();
    }
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data?.kind !== 'cx-credits-calculator' || !Array.isArray(data.customers) || !Array.isArray(data.reports)) throw new Error('not this calculator\'s data');
      broken = '';
      return data;
    } catch (error) {
      broken = `${file} could not be read (${error.message}): it is left as it is and nothing is saved over it. Move it away and start again to keep the data in a new file.`;
      throw Object.assign(new Error(broken), { status: 409 });
    }
  };
  // Written whole to a file beside it, then put in its place: a stop half-way never leaves half a file.
  const write = (data) => {
    if (broken) throw Object.assign(new Error(broken), { status: 409 });
    // Flushed to the disk too, so a computer that loses power just after does not come back with an empty file.
    writeState(file, `${JSON.stringify(data, null, 1)}\n`, { keepLast: false });
  };
  return {
    file,
    read,
    save: (input) => {
      if (input?.kind !== 'cx-credits-calculator' || !Array.isArray(input.customers) || !Array.isArray(input.reports)) throw Object.assign(new Error('That is not this calculator\'s data.'), { status: 400 });
      const names = input.names && typeof input.names === 'object' ? { organisation: String(input.names.organisation ?? '').slice(0, 120), preparedBy: String(input.names.preparedBy ?? '').slice(0, 120) } : emptyData().names;
      const savedAt = new Date().toISOString();
      write({ kind: 'cx-credits-calculator', version: 1, savedAt, names, customers: input.customers, reports: input.reports });
      return { savedAt, customers: input.customers.length, reports: input.reports.length };
    },
  };
}

/** The launcher's own port: fixed, so the browser finds the customers saved in earlier runs at the same address. */
export const DEFAULT_PORT = 47317;

export async function startLauncher({ html, port = 0, fallback = false, host = '127.0.0.1', open = true, log = console.log, connect = (connection) => new CxClient(connection), gitBin = 'git', dataFile = null } = {}) {
  // Plain http, so this computer only: the page's secret and the API key never cross a network.
  if (!['127.0.0.1', 'localhost', '::1'].includes(String(host))) throw new Error(`The calculator only serves this computer (127.0.0.1), not ${host}.`);
  const secret = randomBytes(24).toString('base64url');
  const page = html.replace('"__CALCULATOR_LAUNCHER__"', JSON.stringify({ token: secret }));
  const state = { client: null, connection: null, job: null, read: new TenantReadStore({ file: null }) };
  // Counting from git with this computer's git: any host the token is for, never a link-local or metadata address.
  const counter = createGitCounter({ log, bin: gitBin, maxRunning: 1 });
  sweepLeftovers();

  const readView = (job, url) => readJobView(job, { since: url?.searchParams.get('since') });
  // The data file, made now when it is not there yet.
  const data = dataFile ? dataFileStore(path.resolve(dataFile)) : null;
  if (data) {
    try {
      data.read();
    } catch (error) {
      log(error.message);
    }
  }

  const routes = {
    // The data file: read when the page opens, written after each change.
    'GET /launcher/data': () => (data ? { file: data.file, data: data.read() } : { file: null, data: null }),
    'POST /launcher/data': (input) => {
      if (!data) throw Object.assign(new Error('This launcher keeps no data file.'), { status: 409 });
      return { file: data.file, ...data.save(input) };
    },
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
      const job = { id: randomUUID(), state: 'running', step: 'projects', done: 0, total: 0, read: 0, found: 0, startedAt: new Date().toISOString(), live: {} };
      state.job = job;
      const client = state.client;
      Promise.all([
        readTenant(client, { branches: branchScopeOf(input?.branches), maxProjects: readLimit(input?.maxProjects), onProgress: readProgressOf(job), live: job.live }),
        readFusionOffer(client).catch(() => ({ models: [], remainingCredits: null })).then((offer) => Object.assign(job.live ?? {}, { offer }) && offer),
      ])
        .then(([{ perProject, ...tenant }, offer]) => {
          state.read.save(perProject);
          Object.assign(job, { state: 'done', result: { ...tenant, ...offer }, finishedAt: new Date().toISOString(), live: null });
          log(`Read ${tenant.projects?.length ?? 0} projects from Checkmarx One.`);
        })
        .catch((error) => {
          Object.assign(job, { state: 'failed', error: error.status === 401 || error.status === 403 ? 'Checkmarx One refused the read: check the API key may read projects and scans.' : `Checkmarx One could not be read: ${error.message}`, finishedAt: new Date().toISOString(), live: null });
        });
      return readView(job);
    },
    'GET /api/projections/read': (_input, url) => readView(state.job, url),
    'POST /api/projections/series': (input) => {
      const read = state.read.get();
      if (!read?.weeks?.length) throw Object.assign(new Error('Read Checkmarx One first: the scope is worked out from the last read.'), { status: 409 });
      const ids = Array.isArray(input?.projectIds) ? input.projectIds.slice(0, MAX_PROJECTS).map((id) => String(id).slice(0, 100)) : [];
      return seriesFor(read, ids, cleanEngines(input?.engines).length ? cleanEngines(input.engines) : DEFAULT_ENGINES, cleanOrigins(input?.origins));
    },
    // Fusion — new customer, Count from git, as CxMissionZero measures (src/fusion-git.js, cloc-fusion's engine), on
    // this computer: a token typed for one run only (there are no Admin's connections here), held in memory while it runs.
    'GET /api/projections/git/connections': () => ({ connections: [], limits: { repositories: GIT_COUNT_LIMITS.repositories, windowDays: GIT_COUNT_LIMITS.windowDays }, clocFusion: { version: CLOC_FUSION.version, sha256: CLOC_FUSION.sha256 } }),
    'POST /api/projections/git/organizations': async (input) => {
      const source = typedSource(input);
      return { sources: [await listOrganizations(source)] };
    },
    'POST /api/projections/git/repositories': (input) => listRepositories(typedSource(input), typedAsk(input)),
    'POST /api/projections/git/count': (input) => counter.start('local', { source: typedSource(input), repositories: input?.repositories, engine: String(input?.engine ?? 'auto') }),
    'GET /api/projections/git/count': (_input, url) => counter.view('local', url.searchParams.get('id'), { after: url.searchParams.get('after') }),
    'GET /api/projections/git/cloc-fusion': () => clocFusionPage(),
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
    if (!sameSecret(req.headers['x-calculator-token'], secret)) return json(res, 403, { error: 'Open the calculator at the address the launcher printed.' });
    try {
      json(res, 200, await route(req.method === 'POST' ? await body(req, url.pathname === '/launcher/data' ? DATA_LIMIT : undefined) : null, url));
    } catch (error) {
      if (error.status) return json(res, error.status, { error: error.message });
      // Unexpected: the details (paths, internals) go to the launcher's own window, not to the page.
      log(`Something went wrong (${req.method} ${url.pathname}): ${error.stack ?? error.message}`);
      json(res, 500, { error: 'Something went wrong: the window the calculator was started from says what.' });
    }
  });

  // The browser keeps customers and reports per address (127.0.0.1:<port>), so the same port every run is what
  // makes them come back. Only when that port is taken does it fall back to any free one, and says so.
  await new Promise((resolve, reject) => {
    const attempt = (p, retry) => {
      server.once('error', (error) => {
        if (retry && error.code === 'EADDRINUSE') {
          log(`Port ${p} is in use (is the calculator already open in another window?). Starting on another port: customers saved before are not shown in this window. Close the other one and start again to see them.`);
          attempt(0, false);
        } else reject(error);
      });
      server.listen(p, host, resolve);
    };
    attempt(port, fallback);
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  log(`Cx Credits Calculator: ${url}`);
  log(data ? `Your data stays with you: customers and reports are saved to ${data.file}, in the folder the calculator was started from, and loaded from it next time.` : 'Customers and reports are saved in this browser for this address.');
  log('Paste a Checkmarx One API key at the top of the page to read the tenant. The key is not kept. Press Ctrl+C to stop.');
  if (open) openBrowser(url);
  return { url, server, close: () => new Promise((resolve) => server.close(resolve)) };
}
