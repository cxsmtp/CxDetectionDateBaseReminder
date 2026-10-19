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
let changing = false; // /__changing?on=1: findings change state between reads, and scan results differ on every read
const gone = new Set(); // /__gone?id=p1&on=1: that project is deleted from Checkmarx One
let reads = 0;
const remediated = new Map();
// Verification rescans (POST /api/scans): Queued, then Running, then Completed after RESCAN_MS.
// A completed rescan no longer reports the findings remediated before it, except INEFFECTIVE ones
// (risk ids whose fix did not work). UPLOAD_PROJECTS were scanned from uploaded code (no repository).
const RESCAN_MS = Number(process.env.RESCAN_MS || 3000);
const INEFFECTIVE = new Set(String(process.env.INEFFECTIVE || '').split(',').filter(Boolean));
const UPLOADS = new Set(String(process.env.UPLOAD_PROJECTS || '').split(',').filter(Boolean));
const rescans = new Map(); // scanId -> {projectId, at}
const rescanStatus = (scan) => { const age = Date.now() - scan.at; return age < 300 ? 'Queued' : age < RESCAN_MS ? 'Running' : 'Completed'; };
const latestRescan = (pid) => [...rescans.entries()].filter(([, s]) => s.projectId === pid && rescanStatus(s) === 'Completed').sort((a, b) => b[1].at - a[1].at)[0];
const fixedByRescan = (pid, alt, riskId) => { const last = latestRescan(pid); const t = remediated.get(alt); return Boolean(last && t && t < last[1].at && !INEFFECTIVE.has(riskId)); };
const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
/** Lines of code project p<i>'s last scan counted: fixed per project, 1,500 to 49,499. */
const mockLoc = (i) => 1500 + ((i * 7919) % 48000);
// SHARED=1: like a real tenant, some findings are another code path into the same vulnerable code
// (risk i+4 shares risk i's similarity group, for i in 0–3, 8–11, …), so they are one result.
const SHARED = process.env.SHARED === '1';
const RESULT_ROWS = Number(process.env.RESULT_ROWS || 0);
// VULN_NAMES=1: findings named as Checkmarx One names them (its query names, with their CWE), not "Finding p0-r1".
const VULN_NAMES = process.env.VULN_NAMES === '1';
// MIXED_ENGINES=1: findings from several engines (SAST, SCA, KICS, containers), not SAST only.
const MIXED_ENGINES = process.env.MIXED_ENGINES === '1';
const MOCK_ENGINES = ['SAST', 'SCA', 'SAST', 'KICS', 'SAST', 'Containers'];
// BRANCHES=1: projects scanned on several branches, as most are. Project i's primary branch is main, master,
// develop or not set (i % 4); unset ones are scanned on main, except i % 8 = 7 (trunk only). i % 8 = 6 never
// had its primary branch scanned. Every even project also has a newer feature/login scan, and one finding in
// five of it comes from that scan. i % 10 = 5 counted 0 lines of code; i % 10 = 9 has no findings.
const BRANCHES = process.env.BRANCHES === '1';
const mainBranchOf = (i) => ['main', 'master', 'develop', ''][i % 4];
const primaryScanBranch = (i) => (i % 8 === 6 ? 'feature/old' : i % 8 === 7 ? 'trunk' : mainBranchOf(i) || 'main');
const hasFeature = (i) => BRANCHES && i % 2 === 0;
/** The branch a mock scan ran on. */
const branchOfScan = (id) => {
  const re = rescans.get(id);
  if (re) return re.branch ?? 'main';
  const m = String(id).match(/^(feat|scan|old)-p(\d+)$|^hist-p(\d+)-(\d+)$/);
  if (!m) return '';
  if (m[1] === 'feat') return 'feature/login';
  const i = Number(m[2] ?? m[3]);
  return m[4] !== undefined && Number(m[4]) % 3 === 2 ? 'feature/login' : primaryScanBranch(i);
};
const VULNS = [['SQL_Injection', 89], ['Reflected_XSS_All_Clients', 79], ['SSRF', 918], ['Path_Traversal', 22], ['Hardcoded_password_in_Connection_String', 798], ['Stored_XSS', 79], ['Command_Injection', 78], ['Missing_HSTS_Header', 319], ['Blind_SQL_Injections', 89], ['Server_Side_Request_Forgery', 918], ['XML_External_Entity', 611], ['Log_Forging', 117]];
const risksFor = (pid) => allRisksFor(pid).filter((r) => !fixedByRescan(pid, `alt-${r.groupId.replace(/^sim-/, '')}`, r.id));
const allRisksFor = (pid) => Array.from({ length: BRANCHES && Number(String(pid).slice(1)) % 10 === 9 ? 0 : RISKS }, (_, i) => {
  const id = `${pid}-r${i}`;
  const twin = SHARED && Math.floor(i / 4) % 2 === 1 ? `${pid}-r${i - 4}` : id;
  const alt = `alt-${twin}`;
  const t = triaged.get(alt);
  const state = t && Date.now() - t > FLIP_MS ? (i % 3 ? 'PROPOSED_NOT_EXPLOITABLE' : 'CONFIRMED') : 'TO_VERIFY';
  const k = Number(twin.split('-r')[1]);
  const named = VULN_NAMES ? VULNS[k % VULNS.length] : null;
  return { id, riskName: named ? named[0] : SHARED ? `Finding ${twin}` : `Finding ${id}`, ...(named ? { cweId: named[1] } : {}), severity: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'][i % 4], engine: MIXED_ENGINES ? MOCK_ENGINES[k % MOCK_ENGINES.length] : 'SAST', state, firstDetectionDate: day(40), groupId: `sim-${twin}`, fileName: `src/routes/file${i % 4}.js`, subAssetName: `handler${i}`, ...(BRANCHES ? { scanId: hasFeature(Number(pid.slice(1))) && i % 5 === 4 ? `feat-${pid}` : `scan-${pid}` } : {}) };
});
// Access tokens are only the ones this mock handed out; request bodies are small.
const issued = new Set();
const MAX_BODY = 1024 * 1024;
http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => {
    b += c;
    if (b.length > MAX_BODY) req.destroy();
  });
  req.on('end', () => {
    inFlight++; peak = Math.max(peak, inFlight);
    setTimeout(() => {
      inFlight--;
      const u = new URL(req.url, 'http://x');
      const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json', 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' }); res.end(JSON.stringify(o ?? {})); };
      if (u.pathname === '/__stats') return send(200, { counts, peak, maxSendsPerResult: Math.max(0, ...sentCount.values()), resultsSent: sentCount.size });
      // A project deleted from Checkmarx One: its risks and the project itself answer 404.
      if (u.pathname === '/__gone') { const id = u.searchParams.get('id'); if (u.searchParams.get('on') === '1') gone.add(id); else gone.delete(id); return send(200, { gone: [...gone] }); }
      if (u.pathname === '/__changing') { changing = u.searchParams.get('on') === '1'; return send(200, { changing }); }
      if (u.pathname === '/__rescans') return send(200, Object.fromEntries(rescans));
      if (u.pathname === '/__reset') { for (const k of Object.keys(counts)) delete counts[k]; peak = 0; return send(200, {}); }
      if (u.pathname.endsWith('/openid-connect/token')) {
        bump('token');
        // The access token carries the identity claims of the API key (email, preferred_username), like Checkmarx One's.
        let claims = {};
        try { claims = JSON.parse(Buffer.from(new URLSearchParams(b).get('refresh_token').split('.')[1], 'base64url')); } catch {}
        const who = { email: claims.email, preferred_username: claims.preferred_username, azp: claims.azp };
        const token = `h.${Buffer.from(JSON.stringify(who)).toString('base64url')}.tok`;
        if (issued.size > 100_000) issued.clear();
        issued.add(token);
        return send(200, { access_token: token, expires_in: 3600 });
      }
      if (!issued.has(String(req.headers.authorization || '').replace(/^Bearer /, ''))) return send(401, {});
      const offset = Number(u.searchParams.get('offset') || 0);
      if (u.pathname === '/api/projects') { bump('projects'); const all = Array.from({ length: PROJECTS }, (_, i) => ({ id: `p${i}`, name: `Project ${i}`, criticality: (i % 5) + 1, createdAt: day(800), groups: [`team-${'abc'[i % 3]}`], ...(BRANCHES ? { mainBranch: mainBranchOf(i) } : {}) })); const lim = Number(u.searchParams.get('limit') || 100); return send(200, { projects: all.slice(offset, offset + lim), totalCount: PROJECTS }); }
      if (u.pathname === '/api/applications') {
        bump('applications');
        // Four applications, each grouping every fourth project.
        const apps = ['Payments', 'Mobile', 'Platform', 'Web'].map((name, k) => ({ id: `app-${k}`, name, projectIds: Array.from({ length: PROJECTS }, (_, i) => `p${i}`).filter((_, i) => i % 4 === k) }));
        const lim = Number(u.searchParams.get('limit') || 100);
        return send(200, { applications: apps.slice(offset, offset + lim), totalCount: apps.length });
      }
      if (u.pathname === '/api/projects/last-scan') {
        bump('last-scan');
        return send(200, Object.fromEntries(Array.from({ length: PROJECTS }, (_, i) => {
          const latest = latestRescan(`p${i}`);
          if (latest) return [`p${i}`, { id: latest[0], updatedAt: new Date(latest[1].at + RESCAN_MS).toISOString(), initiator: 'cxmissionzero', ...(BRANCHES ? { branch: branchOfScan(latest[0]) } : {}) }];
          const id = hasFeature(i) ? `feat-p${i}` : `scan-p${i}`;
          return [`p${i}`, { id, updatedAt: hasFeature(i) ? day(0.5) : day(1), initiator: `dev${i % INITIATORS}@acme.com`, ...(BRANCHES ? { branch: branchOfScan(id) } : {}) }];
        })));
      }
      if (req.method === 'POST' && u.pathname === '/api/scans') {
        bump('scan-post');
        const body = JSON.parse(b || '{}');
        const pid = body.project?.id;
        if (!pid || body.type !== 'git' || !body.handler?.repoUrl || !body.handler?.branch || !Array.isArray(body.config)) return send(400, { message: 'bad scan request' });
        const id = `rescan-${pid}-${rescans.size + 1}`;
        rescans.set(id, { projectId: pid, at: Date.now(), tags: body.tags ?? {}, branch: body.handler.branch });
        return send(201, { id, status: 'Queued' });
      }
      if (u.pathname === '/api/scans') {
        bump('scans');
        // The tenant's completed scans since a date (Cx Credits Calculator → Fusion: how often each
        // project is scanned): project i is scanned 400, 100, 20, 4 or 0 times a year, by i % 5.
        const perYear = [400, 100, 20, 4, 0];
        // One project's scans (Cx Credits Calculator): those since from-date, newest first, or
        // with to-date the one before it (every project also has a scan 400 days ago).
        // Scans by id (which branch each ran on).
        const ids = u.searchParams.getAll('scan-ids').flatMap((v) => v.split(',')).filter(Boolean);
        if (ids.length) return send(200, { scans: ids.map((id) => ({ id, projectId: rescans.get(id)?.projectId ?? id.replace(/^(feat|scan|old)-/, '').replace(/^hist-(p\d+)-\d+$/, '$1'), status: 'Completed', ...(BRANCHES ? { branch: branchOfScan(id) } : {}) })), totalCount: ids.length });
        const pid = u.searchParams.get('project-id');
        if (pid) {
          const i = Number(pid.replace(/^p/, ''));
          const n = perYear[i % 5];
          const own = BRANCHES ? [...(hasFeature(i) ? [{ id: `feat-p${i}`, projectId: pid, status: 'Completed', createdAt: day(0.5) }] : []), { id: `scan-p${i}`, projectId: pid, status: 'Completed', createdAt: day(1) }] : [];
          const all = [...own, ...Array.from({ length: n }, (_, k) => ({ id: `hist-p${i}-${k}`, projectId: pid, status: 'Completed', createdAt: new Date(Date.now() - ((k + 0.5) * 365 * 86400000) / n).toISOString() })), { id: `old-p${i}`, projectId: pid, status: 'Completed', createdAt: new Date(Date.now() - 400 * 86400000).toISOString() }];
          const fromDate = Date.parse(u.searchParams.get('from-date') ?? '');
          const toDate = Date.parse(u.searchParams.get('to-date') ?? '');
          if (BRANCHES) for (const x of all) x.branch = branchOfScan(x.id);
          all.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
          const branch = u.searchParams.get('branch');
          const hits = all.filter((x) => (!Number.isFinite(fromDate) || Date.parse(x.createdAt) >= fromDate) && (!Number.isFinite(toDate) || Date.parse(x.createdAt) <= toDate) && (!branch || x.branch === branch));
          const lim = Math.min(1000, Number(u.searchParams.get('limit') || 100));
          return send(200, { scans: hits.slice(offset, offset + lim), totalCount: all.length, filteredTotalCount: hits.length });
        }
        if (!u.searchParams.get('from-date')) return send(200, { scans: [] });
        const total = Array.from({ length: PROJECTS }, (_, i) => perYear[i % 5]).reduce((a, n) => a + n, 0);
        const lim = Math.min(1000, Number(u.searchParams.get('limit') || 100));
        const scans = [];
        for (let k = offset, i = 0, before = 0; k < Math.min(total, offset + lim); k += 1) {
          while (before + perYear[i % 5] <= k) before += perYear[i++ % 5];
          const n = k - before;
          scans.push({ id: `hist-p${i}-${n}`, projectId: `p${i}`, status: 'Completed', ...(BRANCHES ? { branch: branchOfScan(`hist-p${i}-${n}`) } : {}), createdAt: new Date(Date.now() - ((n + 0.5) * 365 * 86400000) / perYear[i % 5]).toISOString() });
        }
        return send(200, { scans, totalCount: total, filteredTotalCount: total });
      }
      if (u.pathname === '/api/scan-summary') {
        bump('scan-summary');
        // Results by severity of each scan: the older the scan, the bigger the backlog; a few new each scan.
        const perYear = [400, 100, 20, 4, 0];
        const scansSummaries = u.searchParams.getAll('scan-ids').map((scanId) => {
          const m = scanId.match(/^(?:hist-p(\d+)-(\d+)|old-p(\d+))$/);
          if (!m) return null;
          const i = Number(m[1] ?? m[3]);
          const age = m[3] !== undefined ? 1.1 : (Number(m[2]) + 0.5) / perYear[i % 5];
          const base = { CRITICAL: i % 3, HIGH: 5 + (i % 7), MEDIUM: 20 + (i % 11), LOW: 40 + (i % 13) };
          const severityCounters = Object.entries(base).map(([severity, b]) => ({ severity, counter: Math.round(b * (1 + 0.5 * age)) }));
          const severityStatusCounters = Object.entries(base).map(([severity, b]) => ({ severity, status: 'NEW', counter: Math.round(b * 0.02) }));
          return { scanId, sastCounters: { severityCounters, severityStatusCounters, totalCounter: severityCounters.reduce((a, c) => a + c.counter, 0) }, kicsCounters: { severityCounters: [{ severity: 'LOW', counter: 2 }] } };
        }).filter(Boolean);
        return send(200, { scansSummaries, totalCount: scansSummaries.length });
      }
      let sm;
      // Lines of code a scan counted (Credit projections → Fusion): one project in seven has no SAST
      // scan metadata; half of those still have it in the scan's own SAST details, half have none.
      if ((sm = u.pathname.match(/^\/api\/sast-metadata\/([^/]+)$/))) {
        bump('sast-metadata');
        const id = decodeURIComponent(sm[1]);
        const i = Number((rescans.get(id)?.projectId ?? id.replace(/^(scan|feat)-/, '').replace(/^hist-(p\d+)-\d+$/, '$1').replace(/^old-/, '')).replace(/^p/, ''));
        if (!Number.isInteger(i) || i % 7 === 3) return send(404, { message: 'no SAST metadata for this scan' });
        return send(200, { scanId: id, loc: BRANCHES && i % 10 === 5 ? 0 : mockLoc(i), fileCount: 40 + (i % 300), isIncremental: false, queryPreset: 'ASA Premium' });
      }
      if ((sm = u.pathname.match(/^\/api\/scans\/([^/]+)$/))) {
        bump('scan-get');
        const id = decodeURIComponent(sm[1]);
        const re = rescans.get(id);
        if (re) return send(200, { id, projectId: re.projectId, status: rescanStatus(re), branch: re.branch ?? 'main', engines: ['sast', 'sca', 'kics'], metadata: { Handler: { GitHandler: { repo_url: `https://github.com/acme/${re.projectId}`, branch: 'main' } } } });
        const pid = id.replace(/^(scan|feat|old)-/, '').replace(/^hist-(p\d+)-\d+$/, '$1');
        if (UPLOADS.has(pid)) return send(200, { id, projectId: pid, status: 'Completed', sourceType: 'upload', engines: ['sast'] });
        const i = Number(pid.replace(/^p/, ''));
        const statusDetails = [{ name: 'general', status: 'Completed' }, { name: 'sast', status: 'Completed', ...(i % 14 === 3 ? {} : { loc: BRANCHES && i % 10 === 5 ? 0 : mockLoc(i) }) }];
        const branch = BRANCHES ? branchOfScan(id) : 'main';
        return send(200, { id, projectId: pid, status: 'Completed', branch, engines: ['sast', 'sca', 'kics'], statusDetails, metadata: { Handler: { GitHandler: { repo_url: `https://github.com/acme/${pid}`, branch, commit_id: 'abc123' } } } });
      }
      if (u.pathname === '/api/risks/' || u.pathname === '/api/risks') {
        bump('risks');
        const pid = u.searchParams.get('projectId');
        if (gone.has(pid)) return send(404, { message: 'project not found' });
        // Paged like the real API: offset/limit, with the total on every page.
        const all = risksFor(pid);
        // While "changing" is on, someone is triaging: the project's first open finding changes state on every read.
        if (changing && offset === 0 && all.length) {
          const flipped = ++reads % 2 ? 'PROPOSED_NOT_EXPLOITABLE' : 'TO_VERIFY';
          all[0] = { ...all[0], state: flipped };
        }
        const lim = Number(u.searchParams.get('limit') || 200);
        return send(200, { risks: all.slice(offset, offset + lim), totalCount: all.length });
      }
      if (u.pathname === '/api/results/' || u.pathname === '/api/results') {
        bump('results');
        // The scan's results: one SAST row per finding, so AI ids resolve (alternateId by similarityId).
        const pid = String(u.searchParams.get('scan-id') ?? '').replace(/^(scan|feat)-/, '');
        const page = Number(u.searchParams.get('offset') ?? 0);
        // While "changing" is on, every read returns other result ids (as if someone were working on the scan).
        const v = changing ? `-${++reads}` : '';
        // One result per similarity group (findings that share it are one result).
        const groups = [...new Set(risksFor(pid).map((r) => r.groupId))];
        const own = pid ? groups.map((g) => ({ type: 'sast', similarityId: g, alternateId: `alt-${g.replace(/^sim-/, '')}${v}`, id: `alt-${g.replace(/^sim-/, '')}${v}` })) : [];
        // RESULT_ROWS=n: the scan lists n results in all (other engines' too), paged as Checkmarx One does
        // (offset is the page number); without it, every row comes on the first page.
        if (!RESULT_ROWS) return send(200, { results: page === 0 ? own : [], totalCount: own.length });
        const nodes = u.searchParams.get('include-nodes') === 'false' ? undefined : Array.from({ length: 8 }, (_, k) => ({ fileName: `src/f${k}.js`, line: k + 1, column: 1, name: 'x' }));
        const all = Math.max(RESULT_ROWS, own.length);
        const lim = Number(u.searchParams.get('limit') || 100);
        const rows = [];
        for (let k = page * lim; k < Math.min(all, (page + 1) * lim); k += 1) rows.push(k < own.length ? own[k] : { type: k % 3 ? 'kics' : 'sca', similarityId: `other-${k}`, alternateId: `oth-${pid}-${k}`, id: `oth-${pid}-${k}`, data: nodes ? { nodes } : {} });
        return send(200, { results: rows, totalCount: all });
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
        for (const bk of JSON.parse(b).buckets) for (const id of bk.resultIDs) remediated.set(id, Date.now());
        return send(202, { published: true });
      }
      if ((m = u.pathname.match(/^\/api\/remediation\/remediation-details\/([^/]+)\/(.+)$/))) {
        bump('remediation-get');
        const t = remediated.get(decodeURIComponent(m[2]));
        if (!t) return send(404, {});
        return send(200, { results: [Date.now() - t < 30000 ? { jobStatus: 'IN_PROGRESS' } : { finishedAt: 't', data: { summary: 'fix', file_changes: [{ file_path: '/src/app.js', diff: '@@ -1 +1 @@\n-const q = input;\n+const q = sanitize(input);' }] } }] });
      }
      bump(`unhandled ${u.pathname}`);
      send(404, {});
    }, LAT);
  });
}).listen(Number(process.env.PORT || 4101), '127.0.0.1');
