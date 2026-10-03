// Mixed-workload benchmark: thousands of people at once, doing everything the
// utility does. Emailed HTML reports (triage, remediation, polling), people on
// the Dashboard (fetching data, reading credits and analytics, sending
// reminders and reports, running triage), and administrators (metrics, audit,
// troubleshooting log). Run by loadtest/benchmark.sh, which starts the mock
// Checkmarx One and the server; this file signs in, sets up, and measures.
//
// Two phases:
//   burst      BURST requests of the whole mix fired at the same instant
//   sustained  VUS virtual users, each looping through its role for DURATION s
//
// Checks as well as timings: no request may fail outright (5xx other than the
// relay's "busy, retry", network errors, timeouts), and no finding may be sent
// to Checkmarx One for triage more than once, however many people ask at once.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { ReportGrants } from '../src/report-grants.js';

const BASE = process.env.BASE || 'http://127.0.0.1:3997';
const MOCK = process.env.MOCK || 'http://127.0.0.1:4101';
const VUS = Number(process.env.VUS || 3000);
const BURST = Number(process.env.BURST || VUS);
const DURATION = Number(process.env.DURATION || 120) * 1000;
const PROJECTS = Number(process.env.PROJECTS || 200);
const POLL = Number(process.env.POLL || 6000);
const SERVER_PID = Number(process.env.SERVER_PID || 0);
const OUT = process.env.BENCH_OUT || '';
const LABEL = process.env.LABEL || '';
// Passwords for this run's throwaway server: from benchmark.sh, or made up now; never written in the source.
const runPassword = () => `bench-${randomBytes(12).toString('base64url')}`;
const ADMIN = { email: 'admin@bench.io', password: process.env.BENCH_ADMIN_PASSWORD || '', next: runPassword() };
if (!ADMIN.password) throw new Error('Set BENCH_ADMIN_PASSWORD to the ADMIN_PASSWORD the server was started with (loadtest/benchmark.sh does).');
const ANALYST_SESSIONS = Number(process.env.ANALYST_SESSIONS || 12);
const FETCHER_SESSIONS = Number(process.env.FETCHER_SESSIONS || 8);
// Who the virtual users are (shares of VUS).
const MIX = { reader: 0.8, viewer: 0.12, analyst: 0.06, fetcher: 0.015, admin: 0.005 };

const grants = new ReportGrants({ secret: process.env.REPORT_SIGNING_KEY });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms * (0.8 + Math.random() * 0.4);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const pct = (a, q) => {
  if (!a.length) return 0;
  const s = Float64Array.from(a).sort();
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

// ---------------------------------------------------------------------------
// A mail server that accepts everything and keeps only a count.
// ---------------------------------------------------------------------------
const mail = { messages: 0, recipients: 0 };
const smtp = net.createServer((socket) => {
  socket.on('error', () => {});
  let data = false;
  let pending = '';
  socket.write('220 bench.smtp ESMTP\r\n');
  socket.on('data', (chunk) => {
    pending += chunk.toString('latin1');
    const lines = pending.split('\r\n');
    pending = lines.pop();
    for (const line of lines) {
      if (data) {
        if (line === '.') {
          data = false;
          mail.messages += 1;
          socket.write('250 queued\r\n');
        }
        continue;
      }
      if (!line) continue;
      const verb = line.slice(0, 4).toUpperCase();
      if (verb === 'RCPT') mail.recipients += 1;
      if (verb === 'EHLO' || verb === 'HELO') socket.write('250-bench.smtp\r\n250 AUTH PLAIN LOGIN\r\n');
      else if (verb === 'AUTH') socket.write('235 ok\r\n');
      else if (verb === 'DATA') {
        data = true;
        socket.write('354 go ahead\r\n');
      } else if (verb === 'QUIT') socket.end('221 bye\r\n');
      else socket.write('250 ok\r\n');
    }
  });
});
await new Promise((r) => smtp.listen(0, '127.0.0.1', r));

// ---------------------------------------------------------------------------
// Requests and measurements
// ---------------------------------------------------------------------------
let phase = 'setup';
const stats = {}; // phase -> op -> { lat: [], codes: {}, retries }
const OK_REFUSALS = new Set([409, 429]); // the app saying "not now" on purpose (fetch running, sign-in limit)

function record(op, ms, status, retries = 0) {
  const p = (stats[phase] ??= {});
  const s = (p[op] ??= { lat: [], codes: {}, retries: 0 });
  s.lat.push(ms);
  s.codes[status] = (s.codes[status] || 0) + 1;
  s.retries += retries;
}

/** One operation, retried the way the report and the page retry ("busy, retry in N s"); timed end to end. */
async function call(op, method, url, { body, cookie, stream = false, timeout = 60_000, retry = true } = {}) {
  const t = performance.now();
  let status = 0;
  let json = null;
  let retries = 0;
  for (;;) {
    try {
      const r = await fetch(BASE + url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
      status = r.status;
      if (stream) {
        // Read the NDJSON stream to the end, as the page does.
        let last = '';
        const decoder = new TextDecoder();
        for await (const chunk of r.body) last = (last + decoder.decode(chunk, { stream: true })).split('\n').slice(-2).join('\n');
        const done = last.split('\n').filter(Boolean).pop();
        try {
          json = JSON.parse(done);
          if (json.type === 'error') status = 'stream-error';
        } catch {}
      } else {
        const text = await r.text();
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
    } catch (error) {
      status = error.name === 'TimeoutError' ? 'timeout' : `ERR:${error.cause?.code || error.message}`;
    }
    if (retry && status === 503 && json?.busy && retries < 8) {
      retries += 1;
      await sleep(jitter((json.retryAfter || 3) * 1000));
      continue;
    }
    break;
  }
  record(op, performance.now() - t, status, retries);
  return { status, json };
}

// ---------------------------------------------------------------------------
// Set-up: the administrator, mail, analysts with their own sessions, a tracked report
// ---------------------------------------------------------------------------
async function signIn(email, password, next) {
  const r = await fetch(`${BASE}/api/session/password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!r.ok) throw new Error(`sign-in ${email}: ${r.status} ${await r.text()}`);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  if (next) {
    const c = await fetch(`${BASE}/api/me/password`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ current: password, next }) });
    if (!c.ok) throw new Error(`password change ${email}: ${c.status} ${await c.text()}`);
  }
  return cookie;
}

const setupStarted = performance.now();
const admin = await signIn(ADMIN.email, ADMIN.password, ADMIN.next);
const put = await call('setup:settings', 'PUT', '/api/settings', {
  cookie: admin,
  body: {
    smtp: { host: '127.0.0.1', port: smtp.address().port, secure: false, requireAuth: false, rejectUnauthorized: false, fromAddress: 'mz@bench.io' },
    recipients: { to: 'lead@bench.io' },
    initiators: { copyConfiguredRecipients: false },
    links: { reportServerUrl: 'https://mz.bench.io' },
  },
});
if (put.status !== 200) throw new Error(`settings: ${put.status} ${JSON.stringify(put.json)}`);
const check = await call('setup:smtp-check', 'POST', '/api/settings/connections/check', { cookie: admin, body: { rollback: false } });
if (!check.json?.smtp?.ok) throw new Error(`smtp check: ${JSON.stringify(check.json)}`);

const people = Array.from({ length: ANALYST_SESSIONS + FETCHER_SESSIONS }, (_, i) => ({ email: `analyst${i}@bench.io`, password: runPassword(), next: runPassword() }));
for (const p of people) {
  const r = await call('setup:add-user', 'POST', '/api/iam/users', { cookie: admin, body: { email: p.email, name: `Analyst ${p.email}`, role: 'analyst', password: p.password } });
  if (r.status !== 201) throw new Error(`add user: ${r.status} ${JSON.stringify(r.json)}`);
}
const sessions = [];
for (const p of people) sessions.push(await signIn(p.email, p.password, p.next));
const analystSessions = sessions.slice(0, ANALYST_SESSIONS);
const fetcherSessions = sessions.slice(ANALYST_SESSIONS);

// Every session fetches once (all at the same time), so reminders and reports have data.
const firstFetch = performance.now();
const fetched = await Promise.all([admin, ...sessions].map((cookie) => call('setup:first-fetch', 'GET', '/api/scan', { cookie, timeout: 300_000 })));
const firstFetchMs = performance.now() - firstFetch;
if (fetched.some((f) => f.status !== 200)) throw new Error(`first fetch: ${fetched.map((f) => f.status).join(',')}`);
const projectIds = fetched[0].json.projects.map((p) => p.projectId);
const tracked = await call('setup:tracked-report', 'POST', '/api/tracked-reports', { cookie: admin, body: { name: 'Benchmark', projectIds: projectIds.slice(0, 20) } });
const trackedId = tracked.json?.id;
const setupMs = performance.now() - setupStarted;

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------
const finding = (p, i) => {
  const id = `p${p}-r${i}`;
  const f = { projectId: `p${p}`, projectName: `Project ${p}`, riskId: id, scanId: `scan-p${p}`, scanner: 'SAST', alternateId: `alt-${id}`, groupId: `sim-${id}` };
  return { ...grants.issue(f), ...f };
};
const reportFindings = Array.from({ length: PROJECTS }, (_, p) => Array.from({ length: 50 }, (_, i) => finding(p, i)));
const someProjects = (n) => Array.from({ length: n }, () => pick(projectIds));

const OPS = {
  // Emailed HTML reports, through the relay
  'report: connect': () => call('report: connect', 'POST', '/api/relay/status', { body: {} }),
  'report: hello': (p) => call('report: hello', 'POST', '/api/relay/hello', { body: { credits: [reportFindings[p][0]], findings: reportFindings[p], remediation: reportFindings[p] } }),
  'report: credits': (p = pick([...Array(PROJECTS).keys()])) => call('report: credits', 'POST', '/api/relay/credits', { body: { findings: [reportFindings[p][0]] } }),
  'report: remediation state': (p = pick([...Array(PROJECTS).keys()])) => call('report: remediation state', 'POST', '/api/relay/remediation-status', { body: { findings: reportFindings[p] } }),
  'report: triage results': (p = pick([...Array(PROJECTS).keys()])) => call('report: triage results', 'POST', '/api/relay/triage-results', { body: { findings: reportFindings[p] } }),
  'report: triage': (p = pick([...Array(PROJECTS).keys()])) => call('report: triage', 'POST', '/api/relay/triage', { body: { findings: reportFindings[p].slice(0, 5) } }),
  'report: remediate': (p = pick([...Array(PROJECTS).keys()])) => call('report: remediate', 'POST', '/api/relay/remediate', { body: { findings: [pick(reportFindings[p])] } }),
  'report: remediation details': (p = pick([...Array(PROJECTS).keys()])) => call('report: remediation details', 'POST', '/api/relay/remediation-details', { body: { findings: [reportFindings[p][0]] } }),
  // People on the Dashboard
  'page: who am I': (cookie) => call('page: who am I', 'GET', '/api/me', { cookie }),
  'page: settings': (cookie) => call('page: settings', 'GET', '/api/settings', { cookie }),
  'page: health': () => call('page: health', 'GET', '/api/health'),
  'credits: balances': (cookie) => call('credits: balances', 'GET', '/api/credits', { cookie }),
  'credits: usage analytics': (cookie) => call('credits: usage analytics', 'GET', '/api/credits/usage?bucket=day', { cookie }),
  'tracked reports: list': (cookie) => call('tracked reports: list', 'GET', '/api/tracked-reports', { cookie }),
  'tracked reports: refresh': (cookie) => call('tracked reports: refresh', 'POST', `/api/tracked-reports/${trackedId}/refresh`, { cookie, body: {} }),
  'fetch: data (streamed)': (cookie) => call('fetch: data (streamed)', 'GET', '/api/scan?stream=1', { cookie, stream: true, timeout: 300_000 }),
  'dashboard: build HTML report': (cookie) => call('dashboard: build HTML report', 'POST', '/api/reports/html', { cookie, body: { projectIds: someProjects(5) } }),
  'credits: verify (2 reads)': (cookie) => call('credits: verify (2 reads)', 'POST', '/api/credits/verify', { cookie, body: { projectIds: someProjects(2), severities: ['CRITICAL', 'HIGH'] } }),
  'reminder: email initiators': (cookie) => call('reminder: email initiators', 'POST', '/api/reminders', { cookie, body: { projectIds: someProjects(3), groupBy: 'initiator' } }),
  'reminder: HTML report to initiators': (cookie) => call('reminder: HTML report to initiators', 'POST', '/api/reminders/send-html-by-initiator', { cookie, body: { projectIds: someProjects(2), groupBy: 'initiator' } }),
  'dashboard: triage now': (cookie) => call('dashboard: triage now', 'POST', '/api/triage/run', { cookie, body: { projectIds: someProjects(1), severities: ['CRITICAL'] } }),
  'audit: browse': (cookie) => call('audit: browse', 'GET', '/api/audit?limit=100', { cookie }),
  'admin: metrics': (cookie) => call('admin: metrics', 'GET', '/api/metrics', { cookie }),
  'admin: audit integrity': (cookie) => call('admin: audit integrity', 'GET', '/api/audit/verify', { cookie }),
  'admin: troubleshooting log': (cookie) => call('admin: troubleshooting log', 'GET', '/api/diagnostics/download', { cookie }),
  'admin: backups': (cookie) => call('admin: backups', 'GET', '/api/backup', { cookie }),
};

// ---------------------------------------------------------------------------
// Resource sampling: server CPU (100% = one core), memory, responsiveness
// ---------------------------------------------------------------------------
const TICKS = 100; // USER_HZ on Linux
const samples = []; // { phase, cpu, rssMb }
let lastCpu = null;
function readProc() {
  if (!SERVER_PID) return null;
  try {
    const stat = fs.readFileSync(`/proc/${SERVER_PID}/stat`, 'utf8').split(') ')[1].split(' ');
    const ticks = Number(stat[11]) + Number(stat[12]);
    const rss = Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${SERVER_PID}/status`, 'utf8'))[1]) / 1024;
    return { ticks, rss, at: performance.now() };
  } catch {
    return null;
  }
}
const sampler = setInterval(() => {
  const now = readProc();
  if (now && lastCpu) samples.push({ phase, cpu: ((now.ticks - lastCpu.ticks) / TICKS / ((now.at - lastCpu.at) / 1000)) * 100, rssMb: now.rss });
  lastCpu = now;
}, 1000);
const probes = []; // { phase, ms }
const prober = setInterval(async () => {
  const p = phase;
  const t = performance.now();
  try {
    await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(30_000) });
    probes.push({ phase: p, ms: performance.now() - t });
  } catch {
    probes.push({ phase: p, ms: 30_000 });
  }
}, 250);

// ---------------------------------------------------------------------------
// Phase 1: burst — BURST requests of the whole mix at the same instant
// ---------------------------------------------------------------------------
const BURST_MIX = [
  ['report: triage results', 0.55], ['report: remediation state', 0.08], ['report: credits', 0.05], ['report: connect', 0.04],
  ['report: triage', 0.04], ['report: remediate', 0.02], ['report: remediation details', 0.01],
  ['credits: balances', 0.05], ['credits: usage analytics', 0.04], ['tracked reports: list', 0.03], ['page: who am I', 0.02], ['page: settings', 0.02],
  ['audit: browse', 0.01], ['dashboard: build HTML report', 0.01], ['reminder: email initiators', 0.007], ['credits: verify (2 reads)', 0.005],
  ['fetch: data (streamed)', 0.003], ['dashboard: triage now', 0.003], ['admin: metrics', 0.002],
];
await fetch(`${MOCK}/__reset`);
phase = 'burst';
const burstPlan = BURST_MIX.flatMap(([op, share]) => Array(Math.max(1, Math.round(share * BURST))).fill(op)).slice(0, BURST);
// Sessions for the signed-in requests: fetches on their own sessions, the rest on the analysts'.
const burstStarted = performance.now();
await Promise.all(
  burstPlan.map((op, i) => {
    if (op.startsWith('report:')) return OPS[op](i % PROJECTS);
    if (op.startsWith('fetch')) return OPS[op](fetcherSessions[i % fetcherSessions.length]);
    if (op.startsWith('admin')) return OPS[op](admin);
    return OPS[op](analystSessions[i % analystSessions.length]);
  }),
);
const burstMs = performance.now() - burstStarted;
await sleep(5000); // let background lookups settle between phases

// ---------------------------------------------------------------------------
// Phase 2: sustained — VUS virtual users for DURATION seconds
// ---------------------------------------------------------------------------
phase = 'sustained';
const end = Date.now() + DURATION;
const until = async (fn) => {
  while (Date.now() < end) await fn();
};
/** Think time that never runs past the end of the phase. */
const nap = (ms) => sleep(Math.max(0, Math.min(ms, end - Date.now())));

// An older server has no /api/relay/hello: its readers open the way reports did before it.
const helloMissing = (await fetch(`${BASE}/api/relay/hello`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 404;
console.log(`Reports open with ${helloMissing ? 'status + credits + triage results + remediation state (no /hello on this server)' : 'one /api/relay/hello call'}.`);
const ROLES = {
  // Someone with an emailed HTML report open: connects, reads credits and remediation
  // state, sometimes triages or remediates, and polls triage results while open.
  async reader(n) {
    const p = n % PROJECTS;
    await nap(Math.random() * POLL);
    // Opening, as the report does: one call where the server has it; otherwise the
    // status, then credits, triage results and remediation state side by side.
    const opened = performance.now();
    if (helloMissing) {
      await OPS['report: connect']();
      await Promise.all([OPS['report: credits'](p), OPS['report: triage results'](p), OPS['report: remediation state'](p)]);
    } else {
      await OPS['report: hello'](p);
    }
    record('report: open (all states known)', performance.now() - opened, 200);
    if (n % 5 === 0) await OPS['report: triage'](p);
    if (n % 20 === 0) await OPS['report: remediate'](p);
    let polls = 0;
    await until(async () => {
      polls += 1;
      const { status, json } = await (polls % 4 === 0 ? OPS['report: remediation state'](p) : OPS['report: triage results'](p));
      if (n % 20 === 0 && polls % 5 === 0) await OPS['report: remediation details'](p);
      const wait = status === 429 || status === 503 ? (json?.retryAfter ?? 5) * 1000 : POLL;
      await nap(jitter(wait));
    });
  },
  // Someone looking around the Dashboard and the Credits page.
  async viewer(n) {
    const cookie = analystSessions[n % analystSessions.length];
    await nap(Math.random() * 10_000);
    await until(async () => {
      const page = pick([
        ['page: who am I', 'page: settings', 'credits: balances'],
        ['credits: balances', 'credits: usage analytics'],
        ['tracked reports: list', 'credits: balances'],
        ['page: health', 'page: who am I'],
      ]);
      await Promise.all(page.map((op) => OPS[op](cookie)));
      await nap(jitter(10_000));
    });
  },
  // Someone acting on the data: reports, verifying credits, reminders, triage.
  async analyst(n) {
    const cookie = analystSessions[n % analystSessions.length];
    await nap(Math.random() * 15_000);
    await until(async () => {
      const op = pick(['dashboard: build HTML report', 'credits: verify (2 reads)', 'reminder: email initiators', 'reminder: HTML report to initiators', 'dashboard: triage now', 'audit: browse', 'tracked reports: refresh']);
      await OPS[op](cookie);
      await nap(jitter(15_000));
    });
  },
  // Someone fetching (and re-fetching) the data.
  async fetcher(n) {
    const cookie = fetcherSessions[n % fetcherSessions.length];
    await nap(Math.random() * 20_000);
    await until(async () => {
      await OPS['fetch: data (streamed)'](cookie);
      await nap(jitter(30_000));
    });
  },
  // An administrator watching the server.
  async admin() {
    await nap(Math.random() * 15_000);
    await until(async () => {
      await OPS[pick(['admin: metrics', 'admin: audit integrity', 'admin: troubleshooting log', 'admin: backups', 'audit: browse'])](admin);
      await nap(jitter(15_000));
    });
  },
};
const plan = [];
for (const [role, share] of Object.entries(MIX)) for (let i = 0; i < Math.round(share * VUS); i++) plan.push([role, i]);
const sustainedStarted = performance.now();
await Promise.all(plan.map(([role, i]) => ROLES[role](i)));
const sustainedMs = performance.now() - sustainedStarted;
clearInterval(sampler);
clearInterval(prober);

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
const upstream = await (await fetch(`${MOCK}/__stats`)).json();
const metrics = await call('admin: metrics', 'GET', '/api/metrics', { cookie: admin });
smtp.close();

// A failure: no answer (network error, timeout, broken stream) or a server error (5xx, including "busy" after every retry).
const failed = (code) => !Number.isFinite(Number(code)) || Number(code) === 0 || Number(code) >= 500;
const summarise = (ph, seconds) =>
  Object.fromEntries(
    Object.entries(stats[ph] ?? {})
      .sort((a, b) => b[1].lat.length - a[1].lat.length)
      .map(([op, s]) => {
        const codes = Object.entries(s.codes);
        const failures = codes.filter(([c]) => failed(c)).reduce((a, [, n]) => a + n, 0);
        const refusals = codes.filter(([c]) => OK_REFUSALS.has(Number(c))).reduce((a, [, n]) => a + n, 0);
        return [op, { n: s.lat.length, perSecond: +(s.lat.length / seconds).toFixed(1), p50: Math.round(pct(s.lat, 0.5)), p95: Math.round(pct(s.lat, 0.95)), p99: Math.round(pct(s.lat, 0.99)), max: Math.round(Math.max(...s.lat)), failures, refusals, retries: s.retries, codes: s.codes }];
      }),
  );
const resources = (ph) => {
  const s = samples.filter((x) => x.phase === ph);
  const h = probes.filter((x) => x.phase === ph).map((x) => x.ms);
  return {
    cpuAvgPct: Math.round(s.reduce((a, x) => a + x.cpu, 0) / (s.length || 1)),
    cpuPeakPct: Math.round(Math.max(0, ...s.map((x) => x.cpu))),
    rssPeakMb: Math.round(Math.max(0, ...s.map((x) => x.rssMb))),
    healthP50: Math.round(pct(h, 0.5)),
    healthP95: Math.round(pct(h, 0.95)),
    healthMax: Math.round(Math.max(0, ...h)),
  };
};
const total = (ph) => Object.values(stats[ph] ?? {}).reduce((a, s) => a + s.lat.length, 0);
const totalFailures = (ph) => Object.values(summarise(ph, 1)).reduce((a, s) => a + s.failures, 0);
const result = {
  label: LABEL,
  vus: VUS,
  burst: BURST,
  setup: { seconds: +(setupMs / 1000).toFixed(1), firstFetchOfAllSessionsSeconds: +(firstFetchMs / 1000).toFixed(1), sessions: sessions.length + 1, projects: projectIds.length },
  phases: {
    burst: { seconds: +(burstMs / 1000).toFixed(1), requests: total('burst'), failures: totalFailures('burst'), ...resources('burst'), operations: summarise('burst', burstMs / 1000) },
    sustained: { seconds: +(sustainedMs / 1000).toFixed(1), requests: total('sustained'), requestsPerSecond: +(total('sustained') / (sustainedMs / 1000)).toFixed(1), failures: totalFailures('sustained'), ...resources('sustained'), operations: summarise('sustained', sustainedMs / 1000) },
  },
  mail,
  checkmarxOne: { calls: Object.values(upstream.counts).reduce((a, b) => a + b, 0), peakConcurrent: upstream.peak, maxTriageSendsPerResult: upstream.maxSendsPerResult, resultsSentForTriage: upstream.resultsSent, byRoute: upstream.counts },
  serverMetrics: metrics.json,
};
if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 1));

// The same, readable.
const line = (cells) => `| ${cells.join(' | ')} |`;
const print = [];
print.push(`# Mixed benchmark${LABEL ? `: ${LABEL}` : ''}`, '');
print.push(`${VUS} virtual users for ${Math.round(sustainedMs / 1000)} s after a burst of ${BURST} simultaneous requests. ${projectIds.length} projects, ${sessions.length + 1} signed-in sessions.`);
print.push(`Set-up: every session fetched at once in ${result.setup.firstFetchOfAllSessionsSeconds} s.`, '');
for (const [name, ph] of Object.entries(result.phases)) {
  print.push(`## ${name}: ${ph.requests} requests in ${ph.seconds} s${ph.requestsPerSecond ? ` (${ph.requestsPerSecond}/s)` : ''}, ${ph.failures} failed`);
  print.push(`Server: CPU avg ${ph.cpuAvgPct}% / peak ${ph.cpuPeakPct}% (100% = one core), memory peak ${ph.rssPeakMb} MB; health check p50 ${ph.healthP50} ms, p95 ${ph.healthP95} ms, max ${ph.healthMax} ms.`, '');
  print.push(line(['Operation', 'Requests', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms', 'Failed', 'Refused (by design)', 'Busy retries']));
  print.push(line(Array(9).fill('---')));
  for (const [op, s] of Object.entries(ph.operations)) print.push(line([op, s.n, s.p50, s.p95, s.p99, s.max, s.failures, s.refusals, s.retries]));
  print.push('');
}
print.push(`Mail: ${mail.messages} emails to ${mail.recipients} recipients.`);
print.push(`Checkmarx One: ${result.checkmarxOne.calls} calls, at most ${upstream.peak} at once; ${upstream.resultsSent} results sent for triage, none more than ${upstream.maxSendsPerResult} time(s).`);
console.log(print.join('\n'));
if (upstream.maxSendsPerResult > 1) {
  console.error(`FAIL: a finding was sent for triage ${upstream.maxSendsPerResult} times`);
  process.exitCode = 1;
}
