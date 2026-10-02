// Mock Checkmarx One for load tests: many projects, fixed latency, per-route call counts.
import http from 'http';
const PROJECTS = Number(process.env.PROJECTS || 200);
const RISKS = Number(process.env.RISKS || 60);
// How many different people ran the latest scans: project i was scanned by dev(i % INITIATORS).
const INITIATORS = Math.max(1, Number(process.env.INITIATORS || 40));
const LAT = Number(process.env.LAT || 80);
const KEY = process.env.KEY;
// How long AI Triage takes before verdicts (and the new states) appear.
const FLIP_MS = Number(process.env.FLIP_MS || 20000);
const counts = {};
let inFlight = 0, peak = 0;
const bump = (k) => (counts[k] = (counts[k] || 0) + 1);
const triaged = new Map(); // alternateId -> time
const sentCount = new Map(); // alternateId -> times it was sent for AI Triage
const remediated = new Map();
const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
const risksFor = (pid) => Array.from({ length: RISKS }, (_, i) => {
  const id = `${pid}-r${i}`;
  const alt = `alt-${id}`;
  const t = triaged.get(alt);
  const state = t && Date.now() - t > FLIP_MS ? (i % 3 ? 'PROPOSED_NOT_EXPLOITABLE' : 'CONFIRMED') : 'TO_VERIFY';
  return { id, riskName: `Finding ${id}`, severity: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'][i % 4], engine: 'SAST', state, firstDetectionDate: day(40), groupId: `sim-${id}` };
});
http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    inFlight++; peak = Math.max(peak, inFlight);
    setTimeout(() => {
      inFlight--;
      const u = new URL(req.url, 'http://x');
      const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json', 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' }); res.end(JSON.stringify(o ?? {})); };
      if (u.pathname === '/__stats') return send(200, { counts, peak, maxSendsPerResult: Math.max(0, ...sentCount.values()), resultsSent: sentCount.size });
      if (u.pathname === '/__reset') { for (const k of Object.keys(counts)) delete counts[k]; peak = 0; return send(200, {}); }
      if (u.pathname.endsWith('/openid-connect/token')) {
        bump('token');
        // The access token carries the identity claims of the API key (email, preferred_username), like Checkmarx One's.
        let claims = {};
        try { claims = JSON.parse(Buffer.from(new URLSearchParams(b).get('refresh_token').split('.')[1], 'base64url')); } catch {}
        const who = { email: claims.email, preferred_username: claims.preferred_username, azp: claims.azp };
        return send(200, { access_token: `h.${Buffer.from(JSON.stringify(who)).toString('base64url')}.tok`, expires_in: 3600 });
      }
      if (!/^Bearer h\.[\w-]*\.tok$/.test(req.headers.authorization || '')) return send(401, {});
      const offset = Number(u.searchParams.get('offset') || 0);
      if (u.pathname === '/api/projects') { bump('projects'); const all = Array.from({ length: PROJECTS }, (_, i) => ({ id: `p${i}`, name: `Project ${i}` })); const lim = Number(u.searchParams.get('limit') || 100); return send(200, { projects: all.slice(offset, offset + lim), totalCount: PROJECTS }); }
      if (u.pathname === '/api/projects/last-scan') { bump('last-scan'); return send(200, Object.fromEntries(Array.from({ length: PROJECTS }, (_, i) => [`p${i}`, { id: `scan-p${i}`, updatedAt: day(1), initiator: `dev${i % INITIATORS}@acme.com` }]))); }
      if (u.pathname === '/api/scans') { bump('scans'); return send(200, { scans: [] }); }
      if (u.pathname === '/api/risks/' || u.pathname === '/api/risks') {
        bump('risks');
        const pid = u.searchParams.get('projectId');
        const rows = offset ? [] : risksFor(pid);
        return send(200, { risks: rows, totalCount: rows.length });
      }
      if (u.pathname === '/api/results/' || u.pathname === '/api/results') {
        bump('results');
        // The scan's results: one SAST row per finding, so AI ids resolve (alternateId by similarityId).
        const pid = String(u.searchParams.get('scan-id') ?? '').replace(/^scan-/, '');
        const page = Number(u.searchParams.get('offset') ?? 0);
        const rows = pid && page === 0 ? risksFor(pid).map((r) => ({ type: 'sast', similarityId: r.groupId, alternateId: `alt-${r.id}`, id: `alt-${r.id}` })) : [];
        return send(200, { results: rows, totalCount: rows.length });
      }
      let m;
      if (req.method === 'POST' && u.pathname === '/api/ai-triage/triage') {
        bump('triage-post');
        for (const bk of JSON.parse(b).buckets) for (const id of bk.resultIDs) { triaged.set(id, Date.now()); sentCount.set(id, (sentCount.get(id) ?? 0) + 1); }
        return send(202, { status: 'accepted', published: true });
      }
      if ((m = u.pathname.match(/^\/api\/ai-triage\/triage\/([^/]+)\/(.+)$/))) {
        bump('triage-get');
        const id = decodeURIComponent(m[2]).replace(/^sim-/, '');
        const t = triaged.get(`alt-${id}`);
        if (!t) return send(404, {});
        const i = Number(id.split('-r')[1]);
        return send(200, Date.now() - t < FLIP_MS ? { jobStatus: 'IN_PROGRESS' } : { triageStatus: i % 3 ? 'PROPOSED_NOT_EXPLOITABLE' : 'VULNERABLE', summary: 'x' });
      }
      if (req.method === 'POST' && u.pathname === '/api/remediation/remediate') {
        bump('remediate-post');
        remediated.set(JSON.parse(b).buckets[0].resultIDs[0], Date.now());
        return send(202, { published: true });
      }
      if ((m = u.pathname.match(/^\/api\/remediation\/remediation-details\/([^/]+)\/(.+)$/))) {
        bump('remediation-get');
        const t = remediated.get(decodeURIComponent(m[2]));
        if (!t) return send(404, {});
        return send(200, { results: [Date.now() - t < 30000 ? { jobStatus: 'IN_PROGRESS' } : { finishedAt: 't', data: { summary: 'fix' } }] });
      }
      bump(`unhandled ${u.pathname}`);
      send(404, {});
    }, LAT);
  });
}).listen(Number(process.env.PORT || 4101), '127.0.0.1');
