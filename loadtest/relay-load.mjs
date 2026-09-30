// Simulates report readers hammering the relay: connect, poll triage results,
// check remediation, triage and remediate — all at once.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { ReportGrants } from '../src/report-grants.js';

const BASE = process.env.BASE || 'http://127.0.0.1:3997';
const MOCK = process.env.MOCK || 'http://127.0.0.1:4101';
const READERS = Number(process.env.READERS || 1000);
const DURATION = Number(process.env.DURATION || 60) * 1000;
const POLL = Number(process.env.POLL || 6000);
const PROJECTS = Number(process.env.PROJECTS || 200);
const grants = new ReportGrants({ secret: process.env.REPORT_SIGNING_KEY });

const finding = (p, i) => {
  const id = `p${p}-r${i}`;
  return { ...grants.issue({ projectId: `p${p}`, projectName: `Project ${p}`, riskId: id, scanId: `scan-p${p}`, scanner: 'SAST', alternateId: `alt-${id}`, groupId: `sim-${id}` }), projectId: `p${p}`, projectName: `Project ${p}`, riskId: id, scanId: `scan-p${p}`, scanner: 'SAST', alternateId: `alt-${id}`, groupId: `sim-${id}` };
};

const stats = {};
const record = (name, ms, status) => {
  const s = (stats[name] ??= { n: 0, lat: [], codes: {} });
  s.n++; s.lat.push(ms); s.codes[status] = (s.codes[status] || 0) + 1;
};
async function post(name, path, body, attempt = 0) {
  const r = await post1(name, path, body);
  // Like the report: a busy answer is retried after the time the server asks for.
  if (r.status === 503 && r.json?.busy && attempt < 6) {
    await sleep((r.json.retryAfter || 3) * 1000 * (0.8 + Math.random() * 0.4));
    return post(name, path, body, attempt + 1);
  }
  return r;
}
async function post1(name, path, body) {
  const t = performance.now();
  let status = 0, json = null;
  try {
    const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    status = r.status;
    json = await r.json().catch(() => null);
  } catch (e) { status = 'ERR:' + (e.cause?.code || e.message); }
  record(name, performance.now() - t, status);
  return { status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, q) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

await fetch(MOCK + '/__reset');
const lag = monitorEventLoopDelay({ resolution: 20 }); lag.enable();
const probe = [];
const probeTimer = setInterval(async () => { const t = performance.now(); try { await fetch(BASE + '/api/health'); probe.push(performance.now() - t); } catch {} }, 500);

const end = Date.now() + DURATION;
async function reader(n) {
  const p = n % PROJECTS;
  const list = Array.from({ length: 50 }, (_, i) => finding(p, i));
  await sleep(Math.random() * POLL);
  await post('status', '/api/relay/status', {});
  await post('credits', '/api/relay/credits', { findings: [list[0]] });
  await post('remediation-status', '/api/relay/remediation-status', { findings: list });
  if (n % 5 === 0) await post('triage', '/api/relay/triage', { findings: list.slice(0, 5) });
  if (n % 20 === 0) await post('remediate', '/api/relay/remediate', { findings: [list[(n / 20) % 50 | 0]] });
  while (Date.now() < end) {
    const { status, json } = await post('triage-results', '/api/relay/triage-results', { findings: list });
    const wait = status === 429 || status === 503 ? (json?.retryAfter ?? 5) * 1000 : POLL;
    await sleep(wait * (0.8 + Math.random() * 0.4));
  }
}
const t0 = Date.now();
await Promise.all(Array.from({ length: READERS }, (_, n) => reader(n)));
clearInterval(probeTimer);
lag.disable();
const secs = (Date.now() - t0) / 1000;
const upstream = await (await fetch(MOCK + '/__stats')).json();
const out = { readers: READERS, seconds: Math.round(secs), endpoints: {} };
for (const [name, s] of Object.entries(stats)) out.endpoints[name] = { n: s.n, rps: +(s.n / secs).toFixed(1), p50: Math.round(pct(s.lat, 0.5)), p95: Math.round(pct(s.lat, 0.95)), p99: Math.round(pct(s.lat, 0.99)), codes: s.codes };
const up = Object.values(upstream.counts).reduce((a, b) => a + b, 0);
out.upstream = { total: up, perSecond: +(up / secs).toFixed(1), peakConcurrent: upstream.peak, byRoute: upstream.counts };
out.health = { p50: Math.round(pct(probe, 0.5)), p95: Math.round(pct(probe, 0.95)), max: Math.round(Math.max(0, ...probe)) };
out.eventLoopLagMs = { mean: +(lag.mean / 1e6).toFixed(1), p99: +(lag.percentile(99) / 1e6).toFixed(1) };
console.log(JSON.stringify(out, null, 1));
