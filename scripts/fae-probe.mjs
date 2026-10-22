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
 * The API key comes from the environment (CX_API_KEY), never the command line; it and the access token are never
 * printed or written. Signed addresses' signatures and email addresses are masked in the report.
 *
 * Windows cmd, from the folder holding this file (one line each):
 *   set CX_API_KEY=<your Checkmarx One API key>
 *   podman run --rm -e CX_API_KEY -v "%CD%:/probe" ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest node /probe/fae-probe.mjs --project "ai-fix-demo"
 *   podman run --rm -e CX_API_KEY -v "%CD%:/probe" ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest node /probe/fae-probe.mjs --project "ai-fix-demo" --write --wait 15
 *
 * Options: --project <name or id> (required) · --write · --wait <minutes> · --keep · --out <folder> (default: this
 * file's folder) · --base-url / --iam-url / --tenant (only when the key does not carry them).
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
  const open = new Set(scans.map((s) => s.id));
  while (open.size && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 20_000));
    for (const s of scans.filter((x) => open.has(x.id))) {
      const { response } = await call('GET', `/api/scans/${encodeURIComponent(s.id)}`);
      const d = (await json(response)).data ?? {};
      const status = String(d.status ?? '').toLowerCase();
      if (['completed', 'failed', 'canceled', 'partial'].includes(status)) {
        open.delete(s.id);
        const detail = (d.statusDetails ?? []).map((x) => `${x.name}: ${x.status}${x.details ? ` (${x.details})` : ''}${x.loc ? ` ${x.loc} LOC` : ''}`).join('; ');
        step(`${s.label} scan ended`, status === 'completed', `${d.status} · ${detail || '—'}`);
        conclusions.push(`${s.label} scan: ${d.status}.`);
      }
    }
  }
  for (const s of scans.filter((x) => open.has(x.id))) step(`${s.label} scan`, null, WAIT_MIN ? `still running after ${WAIT_MIN} min` : 'started (add --wait <minutes> to follow it)');
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
const report = { probe: 'FAE Flush', version: 1, at: new Date().toISOString(), write: WRITE, waitMinutes: WAIT_MIN, seconds: Math.round((Date.now() - started) / 1000), steps, conclusions, ...(failed ? { stopped: short(failed) } : {}) };
const file = path.join(OUT, `fae-probe-report-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
try {
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nReport: ${file} (no API key, token, signature or email address in it)`);
} catch (error) {
  console.log(`\nCould not write the report (${error.message}); copy the lines above instead.`);
}
console.log(conclusions.length ? `\n${conclusions.map((c) => `• ${c}`).join('\n')}` : '');
process.exit(failed ? 1 : 0);
