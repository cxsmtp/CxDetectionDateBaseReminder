#!/usr/bin/env node
/**
 * FAE Flush probe: every Checkmarx One call FAE Flush makes, tried on one project of YOUR tenant, each way it can be
 * made (with and without the access token), with what Checkmarx One answered. Self-contained: plain Node 18+, no
 * other file, so it runs in any CxMissionZero image (or with Node alone).
 *
 *   Read-only (the default): reads the project, its latest scan, Checkmarx One's stored copy of its code (first byte,
 *   then the whole zip to a temporary file, deleted at the end), asks for an upload address, and reads one result's
 *   state history. Nothing is created or changed.
 *
 *   --write: also one throwaway project "<name>_FAE_PROBE_<n>" (tag mz-fae-probe), Findings Analysis on, the code
 *   uploaded and scanned there, and (when the project has a repository) a repository scan too, to see what Checkmarx
 *   One answers; --wait <minutes> follows those scans; the throwaway project is deleted at the end (--keep keeps it).
 *   No result of the real project is ever marked.
 *
 *   --compare: compares the project's latest scan with its "<name>_FAE" project's latest completed scan as FAE Flush
 *   does (only results To verify; those the AI engine added left out, since the FAE scan is SAST only) and lists what
 *   would be marked. Read-only. --fae-scan <id> names the FAE scan instead.
 *
 *   --mark pne|ne: as --compare, then marks those (Proposed not exploitable or Not exploitable) ONE AT A TIME, with
 *   Checkmarx One's answer for each; one it refuses is tried once more without its severity, to tell why.
 *   --limit <n> marks only the first n (start with --limit 1). This changes the project's results, as FAE Flush would.
 *
 * The API key comes from the environment (CX_API_KEY), never the command line; it and the access token are never
 * printed or written. Signed addresses' signatures and email addresses are masked in the report.
 *
 * Windows cmd, from the folder holding this file (one line each):
 *   set CX_API_KEY=<your Checkmarx One API key>
 *   podman run --rm -e CX_API_KEY -v "%CD%:/probe" ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest node /probe/fae-probe.mjs --project "ai-fix-demo"
 *   podman run --rm -e CX_API_KEY -v "%CD%:/probe" ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest node /probe/fae-probe.mjs --project "ai-fix-demo" --write --wait 15
 *
 * Options: --project <name or id> (required) · --write · --wait <minutes> · --keep · --compare · --mark pne|ne ·
 * --limit <n> · --fae-scan <id> · --out <folder> (default: this file's folder) · --base-url / --iam-url / --tenant
 * (only when the key does not carry them).
 *
 *   podman run --rm -e CX_API_KEY -v "%CD%:/probe" ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest node /probe/fae-probe.mjs --project "ai-fix-demo" --compare
 *   podman run --rm -e CX_API_KEY -v "%CD%:/probe" ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest node /probe/fae-probe.mjs --project "ai-fix-demo" --mark ne --limit 1
 */
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);
const PROJECT = opt('project');
const WRITE = flag('write');
const WAIT_MIN = Math.max(0, Number(opt('wait', '0')) || 0);
const KEEP = flag('keep');
const OUT = opt('out', path.dirname(fileURLToPath(import.meta.url)));
const MARK = ['pne', 'ne'].includes(opt('mark')) ? opt('mark') : '';
const COMPARE = flag('compare') || Boolean(MARK);
const LIMIT = Math.max(0, Math.floor(Number(opt('limit', '0')) || 0));
const FAE_SCAN = opt('fae-scan');
if (flag('mark') && !MARK) {
  console.error('Say how to mark them: --mark pne (Proposed not exploitable) or --mark ne (Not exploitable).');
  process.exit(2);
}
const ACCEPT = 'application/json; version=1.0';

if (!PROJECT) {
  console.error('Say which project: --project "<name or id>". See the top of this file for the full command.');
  process.exit(2);
}
const KEY = String(process.env.CX_API_KEY ?? '').trim();
if (!KEY) {
  console.error('Set CX_API_KEY first (Windows cmd: set CX_API_KEY=<your key>), then pass it with: podman run -e CX_API_KEY ...');
  process.exit(2);
}

// ---- Masking: nothing secret or personal leaves this run ----
const mask = (value) =>
  String(value ?? '')
    .replace(/(X-Amz-(?:Signature|Credential|Security-Token))=[^&\s"]+/gi, '$1=…')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1…')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '<jwt>')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>');
const short = (value, n = 300) => mask(value).replace(/\s+/g, ' ').trim().slice(0, n);
const where = (address, base) => {
  try {
    const u = new URL(address);
    return `${u.host === new URL(base).host ? 'same host' : u.host} ${u.pathname.split('/').slice(0, 4).join('/')}/…${u.searchParams.get('X-Amz-Expires') ? ` (valid ${u.searchParams.get('X-Amz-Expires')} s)` : ''}`;
  } catch {
    return short(address, 80);
  }
};

// ---- The connection, from the API key as CxMissionZero works it out ----
function connection() {
  let claims = {};
  try {
    claims = JSON.parse(Buffer.from(KEY.split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    /* not a JWT: the options must say */
  }
  const m = String(claims.iss ?? '').match(/^(https?:\/\/[^/]+)\/auth\/realms\/([^/?#]+)/);
  const iamUrl = (opt('iam-url') || (m ? m[1] : '')).replace(/\/+$/, '');
  const tenant = opt('tenant') || (m ? decodeURIComponent(m[2]) : '');
  let baseUrl = opt('base-url').replace(/\/+$/, '');
  if (!baseUrl && iamUrl) {
    const u = new URL(iamUrl);
    baseUrl = `${u.protocol}//${u.host.replace(/^iam\./i, 'ast.').replace(/\.iam\./i, '.ast.')}`;
  }
  if (!iamUrl || !tenant || !baseUrl) throw new Error('The API key does not say its tenant: add --iam-url, --tenant and --base-url.');
  return { iamUrl, tenant, baseUrl, tokenUrl: `${iamUrl}/auth/realms/${encodeURIComponent(tenant)}/protocol/openid-connect/token` };
}

// ---- The report ----
const steps = [];
const conclusions = [];
const started = Date.now();
function step(name, ok, detail, extra = {}) {
  const row = { step: name, ok, detail: short(detail, 400), ...extra };
  steps.push(row);
  console.log(`${ok === true ? '✓' : ok === false ? '✗' : '·'} ${name}: ${row.detail}`);
  return row;
}

let token = '';
async function call(method, pathOrUrl, { body, query, auth = true, headers = {}, redirect = 'follow', raw = false, timeoutMs = 120_000 } = {}) {
  const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : `${conn.baseUrl}${pathOrUrl}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const t0 = Date.now();
  const response = await fetch(url, {
    method,
    redirect,
    headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), ...(raw ? {} : { Accept: ACCEPT }), ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    ...(raw && body ? { duplex: 'half' } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { response, ms: Date.now() - t0 };
}
const json = async (response) => {
  const text = await response.text().catch(() => '');
  try {
    return { text, data: text ? JSON.parse(text) : null };
  } catch {
    return { text, data: null };
  }
};

let conn;
let tmp = '';
let probeProjectId = '';

async function main() {
  conn = connection();
  step('Connection', true, `API ${new URL(conn.baseUrl).host}, IAM ${new URL(conn.iamUrl).host}, tenant ${conn.tenant}`);

  // 1. The access token.
  const tr = await fetch(conn.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'ast-app', refresh_token: KEY }), signal: AbortSignal.timeout(60_000) });
  const tok = await json(tr);
  token = tok.data?.access_token ?? '';
  step('Access token', Boolean(token), token ? `${tr.status}: received (not shown)` : `${tr.status} ${short(tok.text)}`);
  if (!token) return;

  // 2. The project.
  let project = null;
  {
    const byId = /^[0-9a-f-]{36}$/i.test(PROJECT) ? await call('GET', `/api/projects/${encodeURIComponent(PROJECT)}`) : null;
    if (byId?.response.ok) project = (await json(byId.response)).data;
    if (!project) {
      const { response } = await call('GET', '/api/projects', { query: { name: PROJECT, limit: '20' } });
      const { data, text } = await json(response);
      const list = Array.isArray(data?.projects) ? data.projects : [];
      project = list.find((p) => p.name === PROJECT) ?? null;
      if (!project) step('Project', false, `${response.status}: no project named "${PROJECT}" (${list.length} near: ${list.map((p) => p.name).slice(0, 5).join(', ') || short(text, 120)})`);
    }
    if (!project) return;
    step('Project', true, `${project.name} · ${project.id}`);
  }

  // 3. Its latest completed scan.
  const ls = await call('GET', '/api/projects/last-scan', { query: { 'project-ids': project.id, 'scan-status': 'Completed' } });
  const last = (await json(ls.response)).data;
  const scanId = String(last?.[project.id]?.id ?? last?.[project.id]?.scanId ?? '');
  step('Latest completed scan', Boolean(scanId), scanId ? `${ls.response.status}: ${scanId}` : `${ls.response.status}: none`);
  if (!scanId) return;
  const sc = await call('GET', `/api/scans/${encodeURIComponent(scanId)}`);
  const scan = (await json(sc.response)).data ?? {};
  const git = scan?.metadata?.Handler?.GitHandler ?? scan?.metadata?.handler?.gitHandler ?? {};
  const repoUrl = String(git.repo_url ?? git.repoUrl ?? '');
  const commit = String(git.commit_id ?? git.commitId ?? '');
  const sast = (scan.statusDetails ?? []).find((d) => String(d?.name).toLowerCase() === 'sast');
  step('That scan', sc.response.ok, `${sc.response.status}: ${scan.status ?? '?'} · branch ${scan.branch || '—'} · source ${scan.sourceType ?? scan.sourceOrigin ?? '?'} · SAST ${sast?.status ?? '—'}${sast?.loc ? ` (${sast.loc} LOC)` : ''} · repository ${repoUrl ? short(repoUrl, 120) : '—'}${commit ? ` @ ${commit.slice(0, 12)}` : ''}`);
  if (COMPARE) return compareAndMark(project, scanId);

  // 4. Does Checkmarx One keep its code?
  const kept = await call('HEAD', `/api/repostore/scans/${encodeURIComponent(scanId)}`);
  step('Code kept by Checkmarx One (HEAD /api/repostore/scans/…)', kept.response.ok, `${kept.response.status}`);

  // 5. The "download source code" redirect, and the stored copy read with and without the access token.
  const rd = await call('GET', `/api/repostore/code/${encodeURIComponent(scanId)}`, { redirect: 'manual', raw: true });
  const location = rd.response.headers.get('location') ? new URL(rd.response.headers.get('location'), conn.baseUrl).href : '';
  await rd.response.body?.cancel().catch(() => {});
  step('Download redirect (GET /api/repostore/code/…)', Boolean(location), `${rd.response.status}${location ? ` → ${where(location, conn.baseUrl)}` : ''}`);
  let storageAuth = null;
  if (location) {
    for (const withToken of [false, true]) {
      const { response, ms } = await call('GET', location, { auth: withToken, raw: true, headers: { Range: 'bytes=0-0' } });
      const size = Number((response.headers.get('content-range') ?? '').split('/')[1] ?? response.headers.get('content-length'));
      const body = response.ok ? '' : short(await response.text().catch(() => ''), 120);
      await response.body?.cancel().catch(() => {});
      step(`Stored copy, first byte ${withToken ? 'WITH' : 'WITHOUT'} the access token`, response.status < 400, `${response.status} ${response.headers.get('content-type') ?? ''}${Number.isFinite(size) ? ` · ${size} bytes in all` : ''}${body ? ` · ${body}` : ''} · ${ms} ms`);
      if (response.status < 400 && storageAuth === null) storageAuth = withToken;
    }
    conclusions.push(storageAuth === null ? 'The stored copy of the code could not be read either way.' : `The stored copy is read ${storageAuth ? 'WITH' : 'WITHOUT'} the access token.`);
  }

  // 6. The whole zip, the way that worked, to a temporary file.
  let zip = '';
  if (location && storageAuth !== null) {
    tmp = mkdtempSync(path.join(tmpdir(), 'fae-probe-'));
    zip = path.join(tmp, 'code.zip');
    const { response, ms } = await call('GET', location, { auth: storageAuth, raw: true, timeoutMs: 30 * 60_000 });
    if (response.ok) {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(zip));
      const bytes = statSync(zip).size;
      const pk = readFileSync(zip).subarray(0, 2).toString('latin1') === 'PK';
      step('Whole stored copy downloaded', pk, `${bytes} bytes · ${pk ? 'a zip' : 'NOT a zip'} · ${ms} ms`);
      if (!pk) zip = '';
    } else {
      step('Whole stored copy downloaded', false, `${response.status} ${short(await response.text().catch(() => ''), 160)}`);
      zip = '';
    }
  }

  // 7. An upload address (asking for one creates nothing in a project).
  const up = await call('POST', '/api/uploads');
  const upData = await json(up.response);
  const uploadUrl = String(upData.data?.url ?? '');
  step('Upload address (POST /api/uploads)', Boolean(uploadUrl), `${up.response.status}${uploadUrl ? ` → ${where(uploadUrl, conn.baseUrl)}` : ` ${short(upData.text, 160)}`}`);

  // 8. One result's state history: what FAE Flush's marking would change (read only).
  const rs = await call('GET', '/api/sast-results', { query: { 'scan-id': scanId, limit: '1' } });
  const rsData = (await json(rs.response)).data;
  const first = rsData?.results?.[0];
  const toVerify = rsData?.totalCount;
  step('SAST results of the scan', rs.response.ok, `${rs.response.status}: ${toVerify ?? '?'} results${first ? ` · first: ${first.state ?? '?'} · similarity id ${first.similarityID ?? first.similarityId ?? '?'}` : ''}`);
  if (first) {
    const sim = String(first.similarityID ?? first.similarityId ?? '');
    const pr = await call('GET', `/api/sast-results-predicates/${encodeURIComponent(sim)}`, { query: { 'project-ids': project.id } });
    const prData = await json(pr.response);
    step('State history of that result (GET /api/sast-results-predicates/…)', pr.response.ok, `${pr.response.status}${pr.response.ok ? '' : ` ${short(prData.text, 160)}`}`);
  }

  // 9. The project's own SAST settings with a value (Checkmarx One lists every one as the project's, most empty):
  //    FAE Flush copies these to the _FAE project, with Findings Analysis on.
  const st = await call('GET', '/api/configuration/project', { query: { 'project-id': project.id } });
  const stData = await json(st.response);
  const all = Array.isArray(stData.data) ? stData.data : [];
  const own = all.filter((e) => String(e?.originLevel ?? '').toLowerCase() === 'project' && /^scan\.config\.sast\./.test(String(e?.key ?? '')) && e.key !== 'scan.config.sast.findingsAnalysis' && String(e?.value ?? '').trim() !== '');
  const locked = all.filter((e) => /^scan\.config\.sast\./.test(String(e?.key ?? '')) && e?.allowOverride === false).map((e) => e.key);
  step('Its own SAST settings (GET /api/configuration/project)', st.response.ok, `${st.response.status}: ${st.response.ok ? `${own.length} set on the project${own.length ? `: ${own.map((e) => `${e.key}=${short(e.value, 60)}`).join(' · ')}` : ''}${locked.length ? ` · locked above the project: ${locked.join(', ')}` : ''}` : short(stData.text, 200)}`);

  if (!WRITE) {
    conclusions.push('Read-only run: add --write to try the upload, the throwaway project and the scans.');
    return;
  }

  // ---- --write: a throwaway project, the upload, the scans ----
  if (zip && uploadUrl) {
    let uploadAuth = null;
    for (const withToken of [false, true]) {
      const size = statSync(zip).size;
      const { response, ms } = await call('PUT', uploadUrl, { auth: withToken, raw: true, body: createReadStream(zip), headers: { 'Content-Type': 'application/zip', 'Content-Length': String(size) }, timeoutMs: 30 * 60_000 });
      const body = response.ok ? '' : short(await response.text().catch(() => ''), 160);
      step(`Upload the code ${withToken ? 'WITH' : 'WITHOUT'} the access token (PUT)`, response.ok, `${response.status}${body ? ` · ${body}` : ''} · ${ms} ms`);
      if (response.ok) {
        uploadAuth = withToken;
        break;
      }
    }
    conclusions.push(uploadAuth === null ? 'The upload address refused the code both ways.' : `The upload address takes the code ${uploadAuth ? 'WITH' : 'WITHOUT'} the access token.`);
  } else step('Upload the code', null, 'Skipped: no code downloaded or no upload address.');

  const name = `${project.name}_FAE_PROBE_${Math.floor(Date.now() / 1000) % 100000}`;
  const cp = await call('POST', '/api/projects', { body: { name, groups: project.groups ?? [], tags: { 'mz-fae-probe': '' } } });
  const cpData = await json(cp.response);
  probeProjectId = String(cpData.data?.id ?? '');
  step('Throwaway project made', Boolean(probeProjectId), `${cp.response.status}: ${probeProjectId ? `${name} · ${probeProjectId}` : short(cpData.text, 200)}`);
  if (!probeProjectId) return;

  // As FAE Flush does: the project's own SAST settings and Findings Analysis, in one PATCH; if refused, which one.
  const setting = (e) => ({ key: e.key, value: String(e.value ?? '') });
  if (own.length) {
    const together = await call('PATCH', '/api/configuration/project', { query: { 'project-id': probeProjectId }, body: [...own.map(setting), { key: 'scan.config.sast.findingsAnalysis', value: 'true' }] });
    const tText = together.response.ok ? '' : short((await json(together.response)).text, 200);
    step(`Its ${own.length} own SAST setting(s) and Findings Analysis in one PATCH (as FAE Flush does)`, together.response.ok, `${together.response.status}${tText ? ` ${tText}` : ''}`);
    if (!together.response.ok) {
      const refused = [];
      for (const e of own) {
        const one = await call('PATCH', '/api/configuration/project', { query: { 'project-id': probeProjectId }, body: [setting(e)] });
        const oText = one.response.ok ? '' : short((await json(one.response)).text, 160);
        step(`  ${e.key} alone`, one.response.ok, `${one.response.status}${oText ? ` ${oText}` : ''} · ${e.allowOverride === false ? 'locked' : 'not locked'}`);
        if (!one.response.ok) refused.push(`${e.key} (${one.response.status})`);
      }
      conclusions.push(refused.length ? `Checkmarx One refuses these settings on the new project: ${refused.join(', ')}. FAE Flush should leave them out and carry on.` : 'Each setting is taken alone but not all together.');
    }
  }
  const cfg = await call('PATCH', '/api/configuration/project', { query: { 'project-id': probeProjectId }, body: [{ key: 'scan.config.sast.findingsAnalysis', value: 'true' }] });
  const cfgText = cfg.response.ok ? '' : short((await json(cfg.response)).text, 200);
  const read = await call('GET', '/api/configuration/project', { query: { 'project-id': probeProjectId } });
  const fa = ((await json(read.response)).data ?? []).find?.((e) => e?.key === 'scan.config.sast.findingsAnalysis');
  step('Findings Analysis turned on (PATCH /api/configuration/project)', cfg.response.ok && String(fa?.value) === 'true', `${cfg.response.status}${cfgText ? ` ${cfgText}` : ''} · now ${fa ? `"${fa.value}"` : 'not listed'}`);

  const scans = [];
  const startScan = async (label, type, handler) => {
    const body = { type, handler: { branch: scan.branch || 'main', ...handler }, project: { id: probeProjectId }, config: [{ type: 'sast', value: { incremental: 'false', findingsAnalysis: 'true' } }], tags: { 'mz-fae-probe': '' } };
    const { response } = await call('POST', '/api/scans', { body });
    const { data, text } = await json(response);
    const id = String(data?.id ?? '');
    step(`${label} scan started (POST /api/scans, type ${type})`, Boolean(id), `${response.status}: ${id || short(text, 300)}`);
    if (id) scans.push({ label, id });
    else conclusions.push(`Checkmarx One refused the ${label.toLowerCase()} scan: ${response.status} ${short(text, 200)}`);
  };
  if (uploadUrl && conclusions.some((c) => /upload address takes/.test(c))) await startScan('Uploaded code', 'upload', { uploadUrl });
  if (location) await startScan("Checkmarx One's own copy, in place", 'upload', { uploadUrl: location });
  if (repoUrl) await startScan('Repository', 'git', { repoUrl, ...(commit ? { commitId: commit } : {}) });

  // Follow the scans for a while.
  const until = Date.now() + WAIT_MIN * 60_000;
  const waitFrom = Date.now();
  const open = new Set(scans.map((s) => s.id));
  if (open.size && WAIT_MIN) console.log(`… following ${open.size} scan(s) for up to ${WAIT_MIN} min: a status line every minute`);
  let lastLine = 0;
  while (open.size && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 20_000));
    const now = [];
    for (const s of scans.filter((x) => open.has(x.id))) {
      const { response } = await call('GET', `/api/scans/${encodeURIComponent(s.id)}`);
      const d = (await json(response)).data ?? {};
      const status = String(d.status ?? '').toLowerCase();
      const sastNow = (d.statusDetails ?? []).find((x) => String(x?.name).toLowerCase() === 'sast');
      now.push(`${s.label}: ${d.status ?? '?'}${sastNow ? ` (SAST ${sastNow.status}${sastNow.details ? `, ${sastNow.details}` : ''})` : ''}`);
      if (['completed', 'failed', 'canceled', 'partial'].includes(status)) {
        open.delete(s.id);
        const detail = (d.statusDetails ?? []).map((x) => `${x.name}: ${x.status}${x.details ? ` (${x.details})` : ''}${x.loc ? ` ${x.loc} LOC` : ''}`).join('; ');
        step(`${s.label} scan ended`, status === 'completed', `${d.status} · ${detail || '—'}`);
        conclusions.push(`${s.label} scan: ${d.status}.`);
      }
    }
    if (open.size && Date.now() - lastLine >= 60_000) {
      lastLine = Date.now();
      console.log(`  … ${Math.round((Date.now() - waitFrom) / 60_000)} min: ${short(now.join(' · '), 300)}`);
    }
  }
  for (const s of scans.filter((x) => open.has(x.id))) step(`${s.label} scan`, null, WAIT_MIN ? `still running after ${WAIT_MIN} min` : 'started (add --wait <minutes> to follow it)');
}

// ---- --compare / --mark: FAE Flush's steps 3 and 4 for one project, on its own ----
const upper = (v) => String(v ?? '').toUpperCase();
const simOf = (r) => String(r?.similarityID ?? r?.similarityId ?? '');
/** Added by the AI engine (no SAST query behind it): the FAE scan, SAST only, can never report it. */
const fromAi = (r) => {
  if (r?.isAiGenerated === true) return true;
  const q = r?.queryID ?? r?.queryId;
  return q !== undefined && q !== null && q !== '' && Number(q) === 0;
};
async function allResults(scanId) {
  const out = [];
  for (let page = 0; page < 40; page += 1) {
    const { response } = await call('GET', '/api/sast-results', { query: { 'scan-id': scanId, limit: '500', offset: String(page * 500) } });
    const { data, text } = await json(response);
    if (!response.ok) throw new Error(`GET /api/sast-results (scan ${scanId}): ${response.status} ${short(text, 160)}`);
    const rows = Array.isArray(data?.results) ? data.results : [];
    out.push(...rows);
    if (rows.length < 500 || out.length >= Number(data?.totalCount ?? Infinity)) break;
  }
  return out;
}
async function compareAndMark(project, scanId) {
  let faeScan = FAE_SCAN;
  if (!faeScan) {
    const name = `${project.name}_FAE`;
    const { response } = await call('GET', '/api/projects', { query: { name, limit: '20' } });
    const fp = ((await json(response)).data?.projects ?? []).find((p) => p.name === name);
    step('Its _FAE project', Boolean(fp), fp ? `${fp.name} · ${fp.id}` : `${response.status}: none named "${name}" (pass --fae-scan <scan id> to name the FAE scan)`);
    if (!fp) return;
    const ls = await call('GET', '/api/projects/last-scan', { query: { 'project-ids': fp.id, 'scan-status': 'Completed' } });
    const last = (await json(ls.response)).data;
    faeScan = String(last?.[fp.id]?.id ?? last?.[fp.id]?.scanId ?? '');
    step('Its latest completed FAE scan', Boolean(faeScan), faeScan || `${ls.response.status}: none completed yet`);
    if (!faeScan) return;
  }
  const [original, fae] = await Promise.all([allResults(scanId), allResults(faeScan)]);
  step('SAST results read', true, `${original.length} in the project's scan · ${fae.length} in the FAE scan`);
  const toVerify = original.filter((r) => upper(r?.state || 'TO_VERIFY') === 'TO_VERIFY' && upper(r?.status) !== 'FIXED' && simOf(r));
  const open = toVerify.filter((r) => !fromAi(r));
  const theirs = new Set(fae.filter((r) => !['PROPOSED_NOT_EXPLOITABLE', 'NOT_EXPLOITABLE'].includes(upper(r?.state))).map(simOf).filter(Boolean));
  const findings = new Map();
  for (const r of open) {
    const f = findings.get(simOf(r));
    if (f) f.results += 1;
    else findings.set(simOf(r), { similarityId: simOf(r), severity: upper(r.severity) || 'MEDIUM', query: String(r.queryName ?? ''), results: 1 });
  }
  const notReported = [...findings.values()].filter((f) => !theirs.has(f.similarityId));
  const nr = notReported.reduce((n, f) => n + f.results, 0);
  step('Compared, as FAE Flush does', true, `${toVerify.length} To verify · ${toVerify.length - open.length} added by the AI engine (left out) · ${open.length - nr} still reported · ${nr} not (${notReported.length} findings)`);
  const bySeverity = {};
  for (const f of notReported) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + f.results;
  if (notReported.length) console.log(`    not reported, by severity: ${Object.entries(bySeverity).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  for (const f of notReported.slice(0, 30)) console.log(`    ${f.severity} · ${short(f.query, 80)} · similarity ${f.similarityId}${f.results > 1 ? ` (${f.results} results)` : ''}`);
  if (notReported.length > 30) console.log(`    … and ${notReported.length - 30} more`);
  if (!MARK) {
    conclusions.push(nr ? `FAE Flush would mark ${nr} result(s) (${notReported.length} finding(s)). Add --mark pne or --mark ne (with --limit 1 to start) to mark them one at a time and see Checkmarx One's answer.` : 'Nothing to mark: the FAE scan reports every result To verify.');
    return;
  }
  const state = MARK === 'ne' ? 'NOT_EXPLOITABLE' : 'PROPOSED_NOT_EXPLOITABLE';
  const list = LIMIT ? notReported.slice(0, LIMIT) : notReported;
  const comment = `FAE Flush probe: not reported when the same code was scanned again with Findings Analysis (scan ${faeScan}).`;
  let marked = 0;
  const refused = [];
  let withoutSeverity = 0;
  for (const f of list) {
    const tryOne = (withSeverity) => call('POST', '/api/sast-results-predicates', { body: [{ similarityId: f.similarityId, projectId: project.id, ...(withSeverity ? { severity: f.severity } : {}), state, comment }] });
    const first = await tryOne(true);
    if (first.response.ok) {
      marked += 1;
      continue;
    }
    const why = `${first.response.status} ${short((await json(first.response)).text, 300)}`;
    const again = await tryOne(false);
    if (again.response.ok) {
      marked += 1;
      withoutSeverity += 1;
      step(`  ${f.severity} ${short(f.query, 60)} (${f.similarityId})`, true, `refused with its severity (${why}); taken without it`);
    } else {
      refused.push(why);
      step(`  not marked: ${f.severity} ${short(f.query, 60)} (${f.similarityId})`, false, `${why} · without its severity: ${again.response.status} ${short((await json(again.response)).text, 200)}`);
    }
  }
  step(`Marked ${MARK === 'ne' ? 'Not exploitable' : 'Proposed not exploitable'}`, !refused.length, `${marked} of ${list.length} finding(s)${refused.length ? `; ${refused.length} refused` : ''}${withoutSeverity ? `; ${withoutSeverity} only without their severity` : ''}`);
  if (refused.length) conclusions.push(`Checkmarx One refused ${refused.length} mark(s): ${refused[0]}`);
  if (withoutSeverity) conclusions.push(`Checkmarx One took ${withoutSeverity} mark(s) only without the result's severity: FAE Flush should leave the severity out.`);
  if (!refused.length && !withoutSeverity) conclusions.push(`Every mark was taken (${marked}).`);
}

async function cleanup() {
  if (probeProjectId && !KEEP) {
    try {
      const { response } = await call('DELETE', `/api/projects/${encodeURIComponent(probeProjectId)}`);
      step('Throwaway project deleted', response.ok || response.status === 404, `${response.status}`);
    } catch (error) {
      step('Throwaway project deleted', false, error.message);
    }
  } else if (probeProjectId) step('Throwaway project kept (--keep)', null, probeProjectId);
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
}

let failed = '';
try {
  await main();
} catch (error) {
  failed = error.message;
  step('Stopped', false, error.message);
} finally {
  await cleanup().catch(() => {});
}
const report = { probe: 'FAE Flush', version: 1, at: new Date().toISOString(), write: WRITE, compare: COMPARE, mark: MARK, limit: LIMIT, waitMinutes: WAIT_MIN, seconds: Math.round((Date.now() - started) / 1000), steps, conclusions, ...(failed ? { stopped: short(failed) } : {}) };
const file = path.join(OUT, `fae-probe-report-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
try {
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nReport: ${file} (no API key, token, signature or email address in it)`);
} catch (error) {
  console.log(`\nCould not write the report (${error.message}); copy the lines above instead.`);
}
console.log(conclusions.length ? `\n${conclusions.map((c) => `• ${c}`).join('\n')}` : '');
process.exit(failed ? 1 : 0);
