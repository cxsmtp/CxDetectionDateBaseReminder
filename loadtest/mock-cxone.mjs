// Mock Checkmarx One for load tests: many projects, fixed latency, per-route call counts.
import http from 'http';
import { createHash } from 'crypto';
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
// Fusion (Labs → Fusion): FUSION=0 is a tenant without it (every Fusion path answers 404).
const FUSION = process.env.FUSION !== '0' && process.env.FUSION !== 'risk';
// FUSION=risk: no correlation service; Fusion's scored results through Application Risk Management, as some tenants serve them.
const RISK_MGMT = process.env.FUSION === 'risk';
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
// LAST scans (the AI engine with Fusion off): project 4, and every sixth project after it.
const lastScanProject = (i) => i % 6 === 4;
// The tenant's credits left in Checkmarx One (TENANT_CREDITS=n), of 30,000; /__tenant-credits?n= changes them.
let TENANT_CREDITS = Number(process.env.TENANT_CREDITS || 28854);
let REFUSE_SETTING = '';
let TRIAGE_BY = 'similarity';
// A result's attack vector id (16 hex characters), and back to its similarity group.
const avGroups = new Map();
const attackVectorOf = (groupId) => {
  const av = createHash('sha256').update(String(groupId)).digest('hex').slice(0, 16);
  avGroups.set(av, groupId);
  return av;
};
// One of a project's past scans: every other one ran the AI engine (Fusion, or LAST for a LAST project).
const histScan = (i, k, n) => ({ id: `hist-p${i}-${k}`, projectId: `p${i}`, status: 'Completed', engines: k % 2 ? ['sast', 'sca'] : ['sast', 'sca', 'ai'], metadata: { configs: k % 2 ? [] : [{ type: 'ai', value: { fusionEnabled: lastScanProject(i) ? 'false' : 'true' } }] }, createdAt: new Date(Date.now() - ((k + 0.5) * 365 * 86400000) / n).toISOString() });
const risksFor = (pid) => allRisksFor(pid).filter((r) => !fixedByRescan(pid, `alt-${r.groupId.replace(/^sim-/, '')}`, r.id));
const allRisksFor = (pid) => Array.from({ length: BRANCHES && Number(String(pid).slice(1)) % 10 === 9 ? 0 : RISKS }, (_, i) => {
  const id = `${pid}-r${i}`;
  const twin = SHARED && Math.floor(i / 4) % 2 === 1 ? `${pid}-r${i - 4}` : id;
  const alt = `alt-${twin}`;
  const t = triaged.get(alt);
  const state = t && Date.now() - t > FLIP_MS ? (i % 3 ? 'PROPOSED_NOT_EXPLOITABLE' : 'CONFIRMED') : 'TO_VERIFY';
  const k = Number(twin.split('-r')[1]);
  const named = VULN_NAMES ? VULNS[k % VULNS.length] : null;
  // Risk Hub's status: new and recurrent by turns.
  return { id, riskName: named ? named[0] : SHARED ? `Finding ${twin}` : `Finding ${id}`, ...(named ? { cweId: named[1] } : {}), severity: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'][i % 4], engine: MIXED_ENGINES ? MOCK_ENGINES[k % MOCK_ENGINES.length] : 'SAST', state, stateChangedBy: t && Date.now() - t > FLIP_MS ? 'ai' : 'unchanged', status: i % 2 ? 'RECURRENT' : 'NEW', firstDetectionDate: day(40), groupId: `sim-${twin}`, fileName: `src/routes/file${i % 4}.js`, subAssetName: `handler${i}`, ...(BRANCHES ? { scanId: hasFeature(Number(pid.slice(1))) && i % 5 === 4 ? `feat-${pid}` : `scan-${pid}` } : {}) };
});
// Access tokens are only the ones this mock handed out; request bodies are small.
// FAE Flush: "<name>_FAE" projects made here, their upload scans (FAE on), and states set by predicates.
const FAE_SCAN_MS = Number(process.env.FAE_SCAN_MS || RESCAN_MS);
const FAE_LINK_REFUSED = process.env.FAE_LINK_REFUSED === '1'; // POST /api/scans refuses Checkmarx One's signed storage address
const FAE_FAIL = new Set(String(process.env.FAE_FAIL || '').split(',').filter(Boolean)); // these projects' FAE scans fail
const faeProjects = new Map(); // id -> { name, tags }
const faeScans = new Map(); // scanId -> { projectId, source: 'p3', at }
const predicates = new Map(); // `${projectId}|${similarityId}` -> state
const uploads = new Set();
let faeMade = 0;
const codeKept = (i) => i % 9 !== 8; // every ninth project: Checkmarx One no longer keeps its latest scan's code
const faeSourceOf = (projectId) => faeProjects.get(projectId)?.source ?? '';
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
      // A SAST setting Checkmarx One refuses to set on a project (403), as a live tenant may: /__refuse-setting?key=…
      if (u.pathname === '/__triage-by') { TRIAGE_BY = u.searchParams.get('by') === 'av' ? 'av' : 'similarity'; return send(200, { by: TRIAGE_BY }); }
      if (u.pathname === '/__refuse-setting') { REFUSE_SETTING = u.searchParams.get('key') ?? ''; return send(200, { key: REFUSE_SETTING }); }
      if (u.pathname === '/__tenant-credits') { TENANT_CREDITS = Number(u.searchParams.get('n') ?? TENANT_CREDITS); return send(200, { available: TENANT_CREDITS }); }
      if (u.pathname === '/__changing') { changing = u.searchParams.get('on') === '1'; return send(200, { changing }); }
      if (u.pathname === '/__rescans') return send(200, Object.fromEntries(rescans));
      if (u.pathname === '/__reset') { for (const k of Object.keys(counts)) delete counts[k]; peak = 0; return send(200, {}); }
      // FAE Flush: the states predicates set, and the _FAE projects and scans made.
      if (u.pathname === '/__predicates') {
        // ?clear=<project id>: its results back to how the scans found them.
        const clear = u.searchParams.get('clear');
        if (clear) for (const k of [...predicates.keys()]) if (k.startsWith(`${clear}|`)) predicates.delete(k);
        return send(200, Object.fromEntries(predicates));
      }
      if (u.pathname === '/__fae') return send(200, { projects: Object.fromEntries(faeProjects), scans: Object.fromEntries(faeScans) });
      // Checkmarx One's signed storage address of a scan's code (what /api/repostore/code/{scanId} redirects to): behind
      // its gateway, which wants the access token as well as the signature (as on a real tenant), a Range answered.
      if (u.pathname.startsWith('/storage/repostore.mock/')) {
        bump('storage-get');
        if (!/^Bearer \S/.test(req.headers.authorization ?? '')) { res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Unauthorized\n'); }
        if (!u.searchParams.get('X-Amz-Signature')) return send(403, { message: 'AccessDenied' });
        const zip = Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'binary');
        if (req.headers.range) { res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes 0-0/${zip.length}` }); return res.end(zip.subarray(0, 1)); }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': zip.length });
        return res.end(zip);
      }
      // The upload address (POST /api/uploads): on Checkmarx One's own host, behind its gateway, which wants the access
      // token (as on a real tenant).
      if (req.method === 'PUT' && u.pathname.startsWith('/__upload/')) {
        bump('upload-put');
        if (!/^Bearer \S/.test(req.headers.authorization ?? '')) { res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Unauthorized\n'); }
        return uploads.has(u.pathname) ? (uploads.delete(u.pathname), send(200, {})) : send(404, {});
      }
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
      let sm0;
      const offset = Number(u.searchParams.get('offset') || 0);
      if (req.method === 'POST' && u.pathname === '/api/projects') {
        bump('project-create');
        const body = JSON.parse(b || '{}');
        if (!body.name) return send(400, { message: 'name is required' });
        if ([...faeProjects.values()].some((p) => p.name === body.name)) return send(409, { message: 'project name already exists' });
        const id = `fae-${(faeMade += 1)}`;
        faeProjects.set(id, { name: body.name, tags: body.tags ?? {}, groups: body.groups ?? [], source: `p${String(body.name).replace(/^Project (\d+)_FAE$/, '$1')}` });
        return send(201, { id, name: body.name });
      }
      if (req.method === 'DELETE' && (sm0 = u.pathname.match(/^\/api\/projects\/([^/]+)$/))) {
        bump('project-delete');
        return faeProjects.delete(decodeURIComponent(sm0[1])) ? send(204) : send(404, { message: 'project not found' });
      }
      if (req.method === 'PATCH' && u.pathname === '/api/configuration/project') { bump('configuration-patch'); if (REFUSE_SETTING && JSON.parse(b || '[]').some?.((e) => e?.key === REFUSE_SETTING)) return send(403, { code: 403, message: 'Forbidden' }); return faeProjects.has(u.searchParams.get('project-id')) ? send(204) : send(404, {}); }
      if (req.method === 'POST' && u.pathname === '/api/uploads') { bump('uploads'); const path = `/__upload/${uploads.size + 1}-${Date.now()}`; uploads.add(path); return send(200, { url: `http://127.0.0.1:${process.env.PORT || 4101}${path}` }); }
      // A scan's source code, as Checkmarx One keeps it (a zip).
      if ((sm0 = u.pathname.match(/^\/api\/repostore\/(code|scans)\/(?:(?:scan|feat)-)?p(\d+)$/))) {
        bump(`repostore-${sm0[1]}`);
        if (!codeKept(Number(sm0[2]))) return send(404, { message: 'source code not found' });
        if (req.method === 'HEAD' || sm0[1] === 'scans') return send(200, {});
        // As Checkmarx One: a redirect to the code's signed storage address, valid 15 minutes.
        const where = `/storage/repostore.mock/tenant-1/repos/https:%252F%252Fgithub.com%252Facme%252Fp${sm0[2]}/scan-p${sm0[2]}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=900&X-Amz-Signature=mocksig${sm0[2]}`;
        res.writeHead(302, { Location: `http://127.0.0.1:${process.env.PORT || 4101}${where}` });
        return res.end();
      }
      // Projects FAE Flush made are listed too (tagged), as in Checkmarx One.
      if (u.pathname === '/api/projects') { bump('projects'); const all = [...Array.from({ length: PROJECTS }, (_, i) => ({ id: `p${i}`, name: `Project ${i}`, criticality: (i % 5) + 1, createdAt: day(800), groups: [`team-${'abc'[i % 3]}`], ...(BRANCHES ? { mainBranch: mainBranchOf(i) } : {}) })), ...[...faeProjects].map(([id, p]) => ({ id, name: p.name, tags: p.tags, groups: p.groups, createdAt: day(0) }))]; const total = all.length; const lim = Number(u.searchParams.get('limit') || 100); return send(200, { projects: all.slice(offset, offset + lim), totalCount: total }); }
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
        if (body.type === 'upload' || (body.type === 'git' && faeProjects.has(pid))) {
          if (!faeProjects.has(pid) || !(body.handler?.uploadUrl || body.handler?.repoUrl)) return send(400, { message: 'bad upload scan request' });
          if (FAE_LINK_REFUSED && String(body.handler.uploadUrl ?? '').includes('/storage/repostore')) return send(400, { message: 'invalid upload url' });
          const id = `fae-scan-${faeScans.size + 1}`;
          faeScans.set(id, { projectId: pid, source: faeSourceOf(pid), at: Date.now(), code: body.type === 'git' ? 'git' : String(body.handler.uploadUrl).includes('/storage/repostore') ? 'link' : 'upload', findingsAnalysis: body.config?.find?.((c) => c.type === 'sast')?.value?.findingsAnalysis === 'true' });
          return send(201, { id, status: 'Queued' });
        }
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
        // With their engines and their own AI settings, as a scan's details give them.
        if (ids.length) return send(200, { scans: ids.map((id) => { const projectId = rescans.get(id)?.projectId ?? id.replace(/^(feat|scan|old)-/, '').replace(/^hist-(p\d+)-\d+$/, '$1'); const i = Number(projectId.replace(/^p/, '')); const ai = !rescans.has(id) && i % 3 !== 2; return { id, projectId, status: 'Completed', engines: ai ? ['sast', 'sca', 'kics', 'ai'] : ['sast', 'sca', 'kics'], metadata: { configs: ai ? [{ type: 'ai', value: { fusionEnabled: lastScanProject(i) ? 'false' : 'true' } }] : [] }, ...(BRANCHES ? { branch: branchOfScan(id) } : {}) }; }), totalCount: ids.length });
        const pid = u.searchParams.get('project-id');
        if (pid) {
          const i = Number(pid.replace(/^p/, ''));
          const n = perYear[i % 5];
          const own = BRANCHES ? [...(hasFeature(i) ? [{ id: `feat-p${i}`, projectId: pid, status: 'Completed', createdAt: day(0.5) }] : []), { id: `scan-p${i}`, projectId: pid, status: 'Completed', createdAt: day(1) }] : [];
          // Every other scan also ran the AI engine (Labs → Fusion results counts those).
          const all = [...own, ...Array.from({ length: n }, (_, k) => histScan(i, k, n)), { id: `old-p${i}`, projectId: pid, status: 'Completed', createdAt: new Date(Date.now() - 400 * 86400000).toISOString() }];
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
          scans.push({ ...histScan(i, n, perYear[i % 5]), ...(BRANCHES ? { branch: branchOfScan(`hist-p${i}-${n}`) } : {}) });
        }
        return send(200, { scans, totalCount: total, filteredTotalCount: total });
      }
      if (req.method === 'POST' && u.pathname === '/api/sast-results-predicates/attack-vector') {
        bump('predicates-attack-vector');
        const body = JSON.parse(b || '[]');
        if (!Array.isArray(body) || body.some((p) => !/^[0-9a-fA-F]{16}$/.test(p.attackVectorId ?? '') || !p.projectId || !avGroups.has(p.attackVectorId))) return send(400, { code: 4000, message: 'invalid attack vector predicate' });
        for (const p of body) predicates.set(`${p.projectId}|${avGroups.get(p.attackVectorId)}`, p.state);
        return send(201, {});
      }
      if (req.method === 'POST' && u.pathname === '/api/sast-results-predicates') {
        bump('predicates');
        const body = JSON.parse(b || '[]');
        // A tenant that groups similar results by attack vector (/__triage-by?by=av) takes marks only by attack vector.
        if (TRIAGE_BY === 'av') return send(400, { code: 4002, message: 'Account is configured to use Attack Vector IDs. Updates by Similarity ID are not allowed.', data: null });
        if (!Array.isArray(body) || body.some((p) => !p.similarityId || !p.projectId || !p.state)) return send(400, { message: 'bad predicates' });
        for (const p of body) predicates.set(`${p.projectId}|${p.similarityId}`, p.state);
        return send(201, {});
      }
      if (u.pathname === '/api/scan-summary' && u.searchParams.getAll('scan-ids').some((id) => /^(scan|feat)-p\d+$/.test(id))) {
        bump('scan-summary');
        // Latest scans (FAE Flush's preview): results To verify, from their SAST results.
        const scansSummaries = u.searchParams.getAll('scan-ids').map((scanId) => {
          const pid = scanId.replace(/^(scan|feat)-/, '');
          const rows = risksFor(pid);
          const toVerify = rows.filter((r) => (predicates.get(`${pid}|${r.groupId}`) ?? r.state) === 'TO_VERIFY').length;
          const by = {};
          for (const r of rows) by[r.severity] = (by[r.severity] ?? 0) + 1;
          const severityCounters = Object.entries(by).map(([severity, counter]) => ({ severity, counter }));
          return { scanId, sastCounters: { severityCounters, stateCounters: [{ state: 'TO_VERIFY', counter: toVerify }, { state: 'PROPOSED_NOT_EXPLOITABLE', counter: rows.length - toVerify }], totalCounter: rows.length } };
        });
        return send(200, { scansSummaries, totalCount: scansSummaries.length });
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
      if ((sm = u.pathname.match(/^\/api\/sast-metadata\/([^/]+)$/)) && sm[1] !== 'engine-version') {
        bump('sast-metadata');
        const id = decodeURIComponent(sm[1]);
        const i = Number((rescans.get(id)?.projectId ?? id.replace(/^(scan|feat)-/, '').replace(/^hist-(p\d+)-\d+$/, '$1').replace(/^old-/, '')).replace(/^p/, ''));
        if (!Number.isInteger(i) || i % 7 === 3) return send(404, { message: 'no SAST metadata for this scan' });
        return send(200, { scanId: id, loc: BRANCHES && i % 10 === 5 ? 0 : mockLoc(i), fileCount: 40 + (i % 300), isIncremental: false, queryPreset: 'ASA Premium' });
      }
      if ((sm = u.pathname.match(/^\/api\/scans\/([^/]+)$/))) {
        bump('scan-get');
        const id = decodeURIComponent(sm[1]);
        const fae = faeScans.get(id);
        if (fae) {
          const age = Date.now() - fae.at;
          const status = age < 200 ? 'Queued' : age < FAE_SCAN_MS ? 'Running' : FAE_FAIL.has(fae.source) ? 'Failed' : 'Completed';
          const i = Number(fae.source.replace(/^p/, ''));
          return send(200, { id, projectId: fae.projectId, status, branch: 'main', engines: ['sast'], sourceType: 'upload', statusDetails: [{ name: 'general', status }, { name: 'sast', status, ...(status === 'Completed' ? { loc: mockLoc(i), startDate: new Date(fae.at).toISOString(), endDate: new Date(fae.at + FAE_SCAN_MS).toISOString() } : {}) }] });
        }
        const re = rescans.get(id);
        if (re) return send(200, { id, projectId: re.projectId, status: rescanStatus(re), branch: re.branch ?? 'main', engines: ['sast', 'sca', 'kics'], metadata: { Handler: { GitHandler: { repo_url: `https://github.com/acme/${re.projectId}`, branch: 'main' } } } });
        const pid = id.replace(/^(scan|feat|old)-/, '').replace(/^hist-(p\d+)-\d+$/, '$1');
        if (UPLOADS.has(pid)) return send(200, { id, projectId: pid, status: 'Completed', sourceType: 'upload', engines: ['sast'] });
        const i = Number(pid.replace(/^p/, ''));
        const statusDetails = [{ name: 'general', status: 'Completed' }, { name: 'sast', status: 'Completed', ...(i % 14 === 3 ? {} : { loc: BRANCHES && i % 10 === 5 ? 0 : mockLoc(i) }) }];
        const branch = BRANCHES ? branchOfScan(id) : 'main';
        // The model a Fusion scan ran with is in its configuration for every third project. Fusion is on in each AI
        // scan's settings, but for project 4 and every sixth after it: LAST scans (LLM-based scanning, Fusion off).
        const fusionEnabled = lastScanProject(i) ? 'false' : 'true';
        const configs = i % 3 === 0 ? [{ type: 'sast', value: { presetName: 'ASA Premium' } }, { type: 'ai', value: { llmModel: 'mythos-5.1', fusionEnabled } }] : [{ type: 'sast', value: { presetName: 'ASA Premium' } }, { type: 'ai', value: { fusionEnabled } }];
        // Every third project's latest scan (i % 3 === 2) was not a Fusion scan: no AI engine.
        const engines = i % 3 === 2 ? ['sast', 'sca', 'kics'] : ['sast', 'sca', 'kics', 'ai'];
        return send(200, { id, projectId: pid, status: 'Completed', branch, engines, statusDetails, metadata: { configs, Handler: { GitHandler: { repo_url: `https://github.com/acme/${pid}`, branch, commit_id: 'abc123' } } } });
      }
      // A scan's steps: the AI worker that ran (Fusion's or LAST's), what it added, and Fusion credits not charged.
      if ((sm = u.pathname.match(/^\/api\/scans\/([^/]+)\/workflow$/))) {
        bump('scan-workflow');
        const i = Number(decodeURIComponent(sm[1]).replace(/^(scan|feat|old)-p/, '').replace(/^hist-p(\d+)-\d+$/, '$1'));
        const at = (s) => new Date(Date.now() - 86400000 + s * 1000).toISOString();
        const step = (Source, Info, s) => ({ Source: `${Source}-frankfurt`, Info, Timestamp: at(s) });
        const last = lastScanProject(i);
        return send(200, [
          { Source: 'scans', Info: 'Scan created', Timestamp: at(0) },
          ...(last ? [] : [step('checkmarx-fusion-credit-seize', 'checkmarx-fusion-credit-seize-frankfurt Fusion credits are disabled; skipping credit reservation.', 1)]),
          step(last ? 'last-worker' : 'last-worker-fusion', `${last ? 'last-worker' : 'last-worker-fusion'}-frankfurt started`, 2),
          step('last-result-handler', `last-result-handler-frankfurt Deduplicated ${i % 4} out of ${RISKS + (i % 4)} total results`, 9),
          { Source: 'scans', Info: 'Scan Completed', Timestamp: at(10) },
        ]);
      }
      // What a scan ran with, as Checkmarx One resolves it: the project's "LLM Model" for every third project (the
      // next one), else Checkmarx One's own (Environment); Fusion as the scan's settings say.
      if (u.pathname === '/api/configuration/scan') {
        bump('configuration');
        const i = Number(String(u.searchParams.get('project-id') ?? '').replace(/^p/, ''));
        const model = i % 3 === 1 ? { value: 'opus-5.0', originLevel: 'Project' } : { value: 'opus-4.7', originLevel: 'Environment' };
        return send(200, [{ key: 'scan.config.ai.fusionEnabled', name: 'Fusion Scan', value: lastScanProject(i) ? 'false' : 'true', originLevel: 'Scan' }, { key: 'scan.config.sast.extendedAnalysis', name: 'LLM-based scanning', value: 'true', originLevel: 'Tenant' }, { key: 'scan.config.ai.llmModel', name: 'LLM Model', ...model, valuetype: 'List', valuetypeparams: 'opus-4.7,haiku-4.5,opus-5.0,opus-5.5,mythos-5.1' }]);
      }
      // Lines of code and files of several scans at once, and the SAST engine's version.
      if (u.pathname === '/api/sast-metadata' || u.pathname === '/api/sast-metadata/engine-version') {
        bump('sast-metadata');
        const ids = u.searchParams.getAll('scan-ids').flatMap((v) => v.split(',')).filter(Boolean);
        const of = (id) => Number(id.replace(/^(scan|feat|old)-p/, '').replace(/^hist-p(\d+)-\d+$/, '$1'));
        if (u.pathname.endsWith('engine-version')) return send(200, ids.map((scanId) => ({ scanId, engineVersion: '9.7.7-679962' })));
        return send(200, { totalCount: ids.length, scans: ids.map((scanId) => ({ scanId, loc: mockLoc(of(scanId)), fileCount: 40 + (of(scanId) % 300), isIncremental: false, queryPreset: 'All' })) });
      }
      // The tenant's credits in Checkmarx One.
      if (u.pathname === '/api/credits/info') {
        bump('credits-info');
        return send(200, { available: String(TENANT_CREDITS), total: '30000', used: String(30000 - TENANT_CREDITS), actionsAvailable: 6557, actionsPerformed: 3475, enforcement: { state: 'active', consumptionPct: 4, warningThresholdPct: 100, cutoffThresholdPct: 100 } });
      }
      // Scan settings: the project's "LLM Model" for every third project (the next one), else the tenant's.
      if (u.pathname === '/api/configuration/project' || u.pathname === '/api/configuration/tenant') {
        bump('configuration');
        const i = Number(String(u.searchParams.get('project-id') ?? '').replace(/^p/, ''));
        const value = u.pathname.endsWith('tenant') ? 'opus-5.5' : i % 3 === 1 ? 'opus-5.0' : '';
        return send(200, [...(u.pathname.endsWith('tenant') ? [{ key: 'scan.config.sast.advancedTriageMode', name: 'Grouping Similar Results', value: TRIAGE_BY === 'av' ? 'Attack Vector ID' : 'Similarity ID', originLevel: 'Tenant' }] : []), { key: 'scan.config.ai.fusionEnabled', name: 'Fusion Scan', value: 'true' }, { key: 'scan.config.sast.extendedAnalysis', name: 'LLM-based scanning', value: 'true', originLevel: 'Project' }, { key: 'scan.config.sast.presetName', name: 'presetName', value: '', originLevel: 'Project' }, { key: 'scan.config.ai.llmModel', name: 'LLM Model', value, valuetype: 'List', valuetypeparams: 'opus-4.7,haiku-4.5,opus-5.0,opus-5.5,mythos-5.1' }]);
      }
      // Credits used, by project (as CxCreditGuard reads it): project i used 4i + 6, with i % 3 triage and i % 2 remediation actions.
      if (u.pathname === '/api/credits/consumption') {
        bump('credits-consumption');
        if (!/^(last_month|last_30_days|last_90_days|last_180_days|last_year)$/.test(u.searchParams.get('period') ?? '')) return send(400, { error: 'invalid period query parameter' });
        const scale = { last_30_days: 1, last_month: 1, last_90_days: 3, last_180_days: 6, last_year: 12 }[u.searchParams.get('period')];
        const all = Array.from({ length: PROJECTS }, (_, i) => ({ name: `Project ${i}`, projectId: `p${i}`, creditsUsed: (4 * i + 6) * scale, actionsPerformed: { actions: [{ actionType: 'triage', transactionCount: (i % 3) * scale }, { actionType: 'remediation', transactionCount: (i % 2) * scale }], total: ((i % 3) + (i % 2)) * scale } }));
        const size = Number(u.searchParams.get('size') || 100);
        const page = Number(u.searchParams.get('page') || 1);
        return send(200, { items: all.slice((page - 1) * size, page * size), totalItems: all.length, totalPages: Math.ceil(all.length / size), currentPage: page });
      }
      // SAST results of a scan (Labs → Fusion results): every third finding is one the AI engine found (isAiGenerated),
      // filtered by is-ai-generated as Checkmarx One does; counted by severity, and compared with the scan before.
      // Of those, every other one is in Solidity, a language the traditional engine does not cover (LAST's).
      if (u.pathname === '/api/sast-results' || u.pathname === '/api/sast-scan-summary/aggregate' || u.pathname === '/api/sast-scan-summary/compare/aggregate') {
        bump(u.pathname.includes('compare') ? 'sast-compare' : u.pathname.includes('aggregate') ? 'sast-aggregate' : 'sast-results');
        const scanId = String(u.searchParams.get('scan-id') ?? '');
        const faeScan = faeScans.get(scanId);
        const pid = faeScan ? faeScan.source : scanId.replace(/^(scan|feat)-/, '');
        const ai = u.searchParams.get('is-ai-generated');
        // An FAE scan of the same code (SAST only) reports one in three of the project's results (Findings Analysis
        // drops the rest) and none the AI engine added (every third, query id 0), and two of its own; the project's
        // results carry the states predicates gave them.
        const kept = (r) => !faeScan || Number(r.id.split('-r')[1]) % 3 === 1;
        const extra = faeScan ? [0, 1].map((n) => ({ id: `${pid}-x${n}`, riskName: `Finding ${pid}-x${n}`, severity: 'HIGH', state: 'TO_VERIFY', status: 'NEW', firstDetectionDate: day(0), groupId: `sim-${pid}-x${n}` })) : [];
        const rows = [...risksFor(pid).filter(kept), ...extra].map((r) => ({ ...r, state: faeScan ? r.state : (predicates.get(`${pid}|${r.groupId}`) ?? r.state) })).map((r) => {
          const k = Number(r.id.split(/-[rx]/)[1]);
          const last = k % 6 === 3;
          const file = last ? `contracts/Token${k % 4}.sol` : `src/routes/file${k % 4}.ts`;
          const language = last ? 'Solidity' : 'TypeScript';
          return { resultHash: r.id, similarityID: r.groupId,  ...(u.searchParams.getAll('visible-columns').includes('attack-vector-id') ? { attackVectorID: attackVectorOf(r.groupId) } : {}), queryName: r.riskName.replace(/ /g, '_'), queryID: k % 3 === 0 ? 0 : 1000 + k, group: k % 3 === 0 ? `${language}_${r.severity}` : 'TypeScript_High_Risk', languageName: language, cweID: [287, 89, 79][k % 3], severity: r.severity, state: r.state, status: k % 2 ? 'RECURRENT' : 'NEW', firstFoundAt: r.firstDetectionDate, foundAt: day(1), confidenceLevel: 0, nodes: [{ fileName: file, line: 40 + k, column: 13, name: 'input', method: 'handler' }, { fileName: file, line: 42 + k, column: 31, name: 'query', method: 'handler' }], isAiGenerated: k % 3 === 0, ...(k % 3 === 0 ? { description: `<p>The <code>input</code> parameter of <b>handler</b> reaches a ${last ? 'contract call' : 'database query'} in ${file} without being checked, so an attacker can change what it does.</p>` } : {}) };
        }).filter((r) => (ai === '1' ? r.isAiGenerated : ai === '0' ? !r.isAiGenerated : true));
        if (u.pathname === '/api/sast-results') {
          const lim = Number(u.searchParams.get('limit') || 20);
          return send(200, { results: rows.slice(offset, offset + lim), totalCount: rows.length });
        }
        if (u.pathname.includes('compare')) {
          // One AI-generated TypeScript result fixed since the scan before in every other project, and one in
          // Solidity in every fourth; counted by language, as asked (group-by-field=LANGUAGE).
          const n = Number(pid.replace(/^p/, ''));
          const fixed = u.searchParams.get('status') === 'FIXED' ? [n % 2 === 0 && { language: 'TypeScript', count: 1 }, n % 4 === 0 && { language: 'Solidity', count: 1 }].filter(Boolean) : [];
          const summaries = u.searchParams.get('group-by-field') === 'LANGUAGE' ? fixed : fixed.map(({ count }) => ({ cweID: 287, count }));
          return send(200, { summaries, totalCount: summaries.length });
        }
        const by = {};
        for (const r of rows) by[r.severity] = (by[r.severity] ?? 0) + 1;
        const summaries = Object.entries(by).map(([severity, count]) => ({ severity, count }));
        return send(200, { summaries, totalCount: summaries.length });
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
      // Fusion's Results and Dispatcher services, under /api/correlation as on a tenant. Applications app-0 to app-2 have had a Fusion scan
      // (app-3 never); in them, two projects in three have results: project i has (i % 5) + 1, and
      // its result j (the finding p{i}-r{j}) moves from an old risk score to a new one (some raised into critical or high,
      // some lowered), SCA correlated with SAST.
      if (FUSION && u.pathname === '/api/correlation/results/applications') { bump('fusion-applications'); return send(200, { applications: ['app-0', 'app-1', 'app-2'] }); }
      if (FUSION && (m = u.pathname.match(/^\/api\/correlation\/results\/applications\/([^/]+)\/risk-scores$/))) {
        bump('fusion-risk-scores');
        const k = Number(decodeURIComponent(m[1]).replace(/^app-/, ''));
        if (!(k >= 0 && k <= 2)) return send(404, { message: 'application not found', code: 404 });
        const OLD = [5.5, 3.2, 6.8, 8.1, 2.0], NEW = [9.4, 7.6, 3.1, 9.8, 4.5];
        const results = [];
        for (let i = k; i < PROJECTS; i += 4) {
          if (i % 3 === 2) continue;
          for (let j = 0; j < (i % 5) + 1; j++) results.push({ resultId: `p${i}-r${j}`, fusionScanId: `fscan-${k}`, tenantId: 'acme', vulnerabilityEngine: 'SCA', correlatedEngine: 'SAST', oldRiskValue: OLD[(i + j) % 5], newRiskValue: NEW[(i + j) % 5], scanId: `scan-p${i}`, resultInfo: NEW[(i + j) % 5] > OLD[(i + j) % 5] ? 'Exploitable path: the vulnerable package is called from reachable code' : 'No exploitable path found', projectId: `p${i}` });
        }
        // No paging parameters, as the service's description has none: every result at once.
        return send(200, { totalCount: results.length, results });
      }
      if (FUSION && (m = u.pathname.match(/^\/api\/correlation\/dispatcher\/([^/]+)\/scan-status$/))) {
        bump('fusion-scan-status');
        const k = Number(decodeURIComponent(m[1]).replace(/^app-/, ''));
        if (!(k >= 0 && k <= 2)) return send(404, { message: 'no Fusion scan', code: 404 });
        return send(200, { tenantId: 'acme', applicationId: `app-${k}`, scanId: `fscan-${k}`, scanStatus: k === 2 ? 'In Progress' : 'Completed', stage: k === 2 ? 60 : 100, stageDescription: k === 2 ? 'Correlating' : 'Done', scanTimestamp: Math.floor((Date.now() - (k + 1) * 3600e3) / 1000), errorMessage: '' });
      }
      // Application Risk Management (FUSION=risk): applications app-0 to app-2 with results, each naming its project and risk.
      if (RISK_MGMT && u.pathname === '/api/risk-management/summary') {
        bump('risk-summary');
        return send(200, { summary: [0, 1, 2].map((k) => ({ id: `app-${k}`, name: `App ${k}`, riskScore: 9.3 - k, riskSeverity: k ? 'high' : 'critical', remediationStats: { new: 1, processing: 0, analyzed: 0 } })) });
      }
      if (RISK_MGMT && (m = u.pathname.match(/^\/api\/risk-management\/([^/]+)\/results$/))) {
        bump('risk-results');
        const k = Number(decodeURIComponent(m[1]).replace(/^app-/, ''));
        if (!(k >= 0 && k <= 2)) return send(404, { message: 'application not found', code: 404 });
        const SCORE = [9.4, 7.8, 5.2, 9.1, 3.3];
        const all = [];
        for (let i = k; i < PROJECTS; i += 4) {
          if (i % 3 === 2) continue;
          for (let j = 0; j < (i % 5) + 1; j++) {
            const sc = SCORE[(i + j) % 5];
            all.push({ id: `p${i}-r${j}`, name: ['Improper Neutralization of Special Elements used in a Command', 'CVE-2026-112366', 'Docker Socket Mounted In Container'][j % 3], hash: `h${i}${j}`, type: ['code', 'sca', 'kics'][j % 3], status: j % 2 ? 'RECURRENT' : 'NEW', state: 'TO_VERIFY', risk: { score: sc, severity: sc >= 9 ? 'critical' : sc >= 7 ? 'high' : sc >= 4 ? 'medium' : 'low' }, createdAt: `2026-10-${String(10 + ((i + j) % 15)).padStart(2, '0')}T14:14:47Z`, ...(j === 2 ? {} : { projects: [{ id: `p${i}`, name: `Project ${i}` }] }) });
          }
        }
        const offset = Number(u.searchParams.get('offset') || 0), limit = Number(u.searchParams.get('limit') || 100);
        return send(200, { results: all.slice(offset, offset + limit), totalCount: all.length });
      }
      bump(`unhandled ${u.pathname}`);
      send(404, {});
    }, LAT);
  });
}).listen(Number(process.env.PORT || 4101), '127.0.0.1');
