/**
 * Troubleshooting log: which features are used, where errors happen, and
 * where numbers disagree — so a deployed server can be diagnosed from one
 * download, and the fix (to the flow or to the tool) recommended from it.
 *
 * Privacy by construction: entries hold only structured, non-personal fields
 * (feature names, route templates, status codes, counts, durations, error
 * types). Any free text that does get in (an error message) is scrubbed of
 * email addresses, URLs, host names, IP addresses, tokens and file paths, and
 * project ids are replaced by a short one-way hash used only to tell projects
 * apart. Names, addresses, keys, passwords, findings and code never go in.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

const KINDS = new Set(['usage', 'error', 'discrepancy', 'client-error']);
const MAX_TEXT = 300;
// Text is cut to this before scrubbing, so a huge message cannot make the patterns crawl.
const MAX_INPUT = 2000;

/** Remove anything that could identify a person, a system or a secret. */
export function scrub(value) {
  return String(value ?? '')
    .slice(0, MAX_INPUT)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+/g, '<email>')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '<url>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<ip>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b(?:eyJ[\w-]+\.){1,2}[\w-]+\b/g, '<token>')
    .replace(/\b[A-Za-z0-9_\-+/=]{24,}\b/g, '<token>')
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.-]+){2,}/g, '<path>')
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|local|internal|cloud|ai|co|uk|ae|in|eu|de)\b/gi, '<host>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

/** A short one-way stand-in for an identifier: lets entries about one project be grouped, says nothing about it. */
export const pseudonym = (value) => (value ? createHash('sha256').update(`mz-diag|${value}`).digest('hex').slice(0, 10) : '');

/** Names fixed by the code (features, route templates such as "POST /api/credits/:id"): kept as such, letters and route punctuation only. */
const codeName = (value) => String(value ?? '').replace(/[^\w /:.-]/g, '').slice(0, 80);
const CODE_FIELDS = new Set(['route', 'method', 'feature', 'page', 'kind', 'stage', 'severity', 'engine', 'source']);

/** Only these field names are kept, and only as numbers, booleans or short scrubbed strings. */
const SAFE_FIELDS = new Set([
  'route', 'method', 'status', 'ms', 'feature', 'count', 'projects', 'findings', 'results', 'rows', 'credits', 'kind',
  'reason', 'errorType', 'message', 'stage', 'severity', 'engine', 'project', 'agreed', 'reads', 'busy', 'refused',
  'source', 'page', 'line', 'column', 'detail',
]);

function clean(fields = {}) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_FIELDS.has(key) || value === undefined || value === null || value === '') continue;
    if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (Array.isArray(value)) out[key] = value.filter((v) => typeof v === 'number').slice(0, 10);
    else out[key] = key === 'project' ? pseudonym(value) : CODE_FIELDS.has(key) ? codeName(value) : scrub(value);
  }
  return out;
}

export class Diagnostics {
  #file;
  #maxEntries;
  #version;
  #startedAt = new Date().toISOString();
  #pending = [];
  #errorTimes = [];
  #lines = 0;

  constructor({ file, maxEntries = 20_000, version = '' }) {
    this.#file = file;
    this.#maxEntries = maxEntries;
    this.#version = version;
    try {
      this.#lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
    } catch {
      this.#lines = 0;
    }
  }

  /** kind: usage | error | discrepancy | client-error; event: a short fixed name. */
  record(kind, event, fields = {}) {
    if (!KINDS.has(kind)) return;
    this.#pending.push(JSON.stringify({ at: new Date().toISOString(), kind, event: codeName(event), ...clean(fields) }));
    if (this.#pending.length >= 50) this.flush();
    else this.#scheduleFlush();
  }

  usage(feature, fields = {}) {
    this.record('usage', feature, fields);
  }

  error(event, error, fields = {}) {
    this.#errorTimes.push(Date.now());
    if (this.#errorTimes.length > 1000) this.#errorTimes.splice(0, this.#errorTimes.length - 1000);
    this.record('error', event, { ...fields, errorType: error?.name || 'Error', message: error?.message ?? String(error ?? '') });
  }

  /** How many errors were recorded in the last `ms` milliseconds (the self-check's error rate). */
  recentErrors(ms, now = Date.now()) {
    return this.#errorTimes.filter((t) => now - t <= ms).length;
  }

  discrepancy(event, fields = {}) {
    this.record('discrepancy', event, fields);
  }

  #timer = null;
  #scheduleFlush() {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, 2000);
    this.#timer.unref?.();
  }

  /** Write what is pending; keep only the newest entries when the file grows past its limit. */
  flush() {
    if (!this.#pending.length) return;
    const lines = this.#pending.splice(0);
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.#file, `${lines.join('\n')}\n`, { mode: 0o600 });
      this.#lines += lines.length;
      if (this.#lines > this.#maxEntries * 1.2) {
        const kept = fs.readFileSync(this.#file, 'utf8').split('\n').filter(Boolean).slice(-this.#maxEntries);
        fs.writeFileSync(this.#file, `${kept.join('\n')}\n`, { mode: 0o600 });
        this.#lines = kept.length;
      }
    } catch {
      /* the troubleshooting log never breaks the app */
    }
  }

  entries() {
    this.flush();
    try {
      return fs
        .readFileSync(this.#file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** The download: environment, what is used, what fails, what disagrees, and what to do about it. */
  report({ extra = {} } = {}) {
    const entries = this.entries();
    const tally = (list, key) => {
      const out = {};
      for (const e of list) out[e[key]] = (out[e[key]] ?? 0) + 1;
      return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
    };
    const usage = entries.filter((e) => e.kind === 'usage');
    const errors = entries.filter((e) => e.kind === 'error' || e.kind === 'client-error');
    const discrepancies = entries.filter((e) => e.kind === 'discrepancy');

    // Request timings per feature: how often, how slow, how often it failed.
    const features = {};
    for (const e of usage) {
      const f = (features[e.event] ??= { uses: 0, failures: 0, totalMs: 0, slowestMs: 0 });
      f.uses += 1;
      if (Number(e.status) >= 500) f.failures += 1;
      if (typeof e.ms === 'number') {
        f.totalMs += e.ms;
        f.slowestMs = Math.max(f.slowestMs, e.ms);
      }
    }
    for (const f of Object.values(features)) {
      f.averageMs = f.uses ? Math.round(f.totalMs / f.uses) : 0;
      delete f.totalMs;
    }
    const ranked = Object.fromEntries(Object.entries(features).sort((a, b) => b[1].uses - a[1].uses));

    return {
      about: 'CxMissionZero troubleshooting log. Holds no names, email addresses, hosts, URLs, keys, passwords, findings or code: only feature names, counts, timings, status codes and scrubbed error types. Project ids are one-way hashes.',
      generatedAt: new Date().toISOString(),
      version: this.#version,
      runtime: { node: process.version, platform: `${os.platform()} ${os.arch()}`, uptimeSeconds: Math.round(process.uptime()), serverStartedAt: this.#startedAt, memoryMb: Math.round(process.memoryUsage().rss / 1048576) },
      entries: entries.length,
      firstEntryAt: entries[0]?.at ?? null,
      features: ranked,
      errors: { total: errors.length, byEvent: tally(errors, 'event'), recent: errors.slice(-50) },
      discrepancies: { total: discrepancies.length, byEvent: tally(discrepancies, 'event'), recent: discrepancies.slice(-50) },
      recommendations: recommend({ features, errors, discrepancies }),
      ...extra,
      recent: entries.slice(-300),
    };
  }
}

/** Plain-language next steps from what the log shows. */
export function recommend({ features, errors, discrepancies }) {
  const out = [];
  const count = (list, event) => list.filter((e) => e.event === event).length;
  const add = (severity, issue, fix) => out.push({ severity, issue, fix });

  const disagreed = count(discrepancies, 'credit-verify-disagreed');
  if (disagreed) add('medium', `Checkmarx One gave different results on two reads ${disagreed} time(s) while credits were being verified.`, 'The findings were changing (someone triaging, or a scan finishing). Wait a minute and use Refresh & verify again before allocating; if it keeps happening for one project, check its scans in Checkmarx One.');
  const busy = count(discrepancies, 'send-busy');
  if (busy) add('low', `${busy} triage/remediation request(s) were refused because the same finding was already being sent.`, 'Two people, tabs or reports acted on the same finding at once. Nothing was sent twice; agree who acts on which project.');
  const refused = count(discrepancies, 'credit-refused');
  if (refused) add('medium', `${refused} request(s) were refused for lack of allocated credits.`, 'Allocate credits for the projects (Dashboard → Refresh & verify, then Allocate) or raise the credit pool under Settings → AI & credits.');
  const fetchFailed = count(errors, 'fetch-failed') + count(discrepancies, 'project-read-failed');
  if (fetchFailed) add('high', `Reading projects from Checkmarx One failed ${fetchFailed} time(s).`, 'Check the Checkmarx One connection and the risks endpoint under Settings; a proxy or an expired key is the usual cause.');
  const mailFailed = count(errors, 'mail-failed');
  if (mailFailed) add('high', `Sending email failed ${mailFailed} time(s).`, 'Run the SMTP connection test under Settings → Integrations; check the server, port, TLS and credentials.');
  const clientErrors = errors.filter((e) => e.kind === 'client-error').length;
  if (clientErrors) add('high', `The browser page hit ${clientErrors} script error(s).`, 'A bug in the page: send this log to the maintainers — the entries say which page and line.');
  for (const [feature, f] of Object.entries(features)) {
    if (f.failures >= 3 && f.failures / f.uses >= 0.2) add('high', `${feature} failed ${f.failures} of ${f.uses} time(s).`, 'See errors.recent for its error type; this is a fault to fix in the tool or its connection, not in how it is used.');
    if (f.uses >= 3 && f.averageMs > 60_000) add('low', `${feature} takes ${Math.round(f.averageMs / 1000)}s on average.`, 'Narrow the scope (project names, people, or a shorter time window) or raise CX_FETCH_CONCURRENCY.');
  }
  const serverErrors = errors.filter((e) => e.kind === 'error' && e.event === 'unexpected-error').length;
  if (serverErrors) add('high', `${serverErrors} unexpected server error(s).`, 'A bug in the server: send this log to the maintainers — the entries say which route and error type.');
  if (!out.length) add('info', 'No errors or discrepancies recorded.', 'Nothing to fix.');
  const order = { high: 0, medium: 1, low: 2, info: 3 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}
