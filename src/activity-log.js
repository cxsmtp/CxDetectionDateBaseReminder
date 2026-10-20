/**
 * What people do in CxMissionZero, one line each: who (name, email, role), when, from where (IP),
 * what (the action, the page or the item), which fields a change touched (their names only, never
 * their values: no passwords, keys or text are kept), and how it ended (status, time taken).
 *
 * Kept per tenant in activity.jsonl in the state folder (so in backups too), newest at the end.
 * When the file passes `maxBytes` it moves to activity.1.jsonl (the one before is dropped), and
 * entries older than `keepDays` are not shown. The most recent `memory` entries are held in
 * memory for the Logs page; the files hold the rest for export.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_TEXT = 200;
const clean = (value, max = MAX_TEXT) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);

export class ActivityLog {
  constructor({ file, maxBytes = 20 * 1024 * 1024, memory = 20_000, keepDays = 365 } = {}) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.memory = memory;
    this.keepDays = keepDays;
    this.entries = [];
    this.pending = [];
    this.timer = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.#load();
  }

  #load() {
    for (const f of [this.#older(), this.file]) {
      let text = '';
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          this.entries.push(JSON.parse(line));
        } catch {}
      }
    }
    if (this.entries.length > this.memory) this.entries = this.entries.slice(-this.memory);
  }

  #older() {
    return this.file.replace(/\.jsonl$/, '.1.jsonl');
  }

  /** One thing someone did. Fields are cut to size; nothing but these fields is kept. */
  record(entry) {
    const row = {
      at: entry.at ?? new Date().toISOString(),
      user: clean(entry.user, 254),
      name: clean(entry.name, 120),
      role: clean(entry.role, 60),
      ip: clean(entry.ip, 64),
      kind: ['action', 'page', 'sign-in', 'event'].includes(entry.kind) ? entry.kind : 'action',
      action: clean(entry.action),
      target: clean(entry.target),
      fields: Array.isArray(entry.fields) ? entry.fields.slice(0, 30).map((f) => clean(f, 60)) : [],
      method: clean(entry.method, 8),
      route: clean(entry.route, 120),
      status: Number.isInteger(entry.status) ? entry.status : null,
      ms: Number.isFinite(entry.ms) ? Math.round(entry.ms) : null,
    };
    this.entries.push(row);
    if (this.entries.length > this.memory * 1.1) this.entries = this.entries.slice(-this.memory);
    this.pending.push(row);
    // Written together a moment later: one disk write for a burst of actions, not one each.
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 500);
      this.timer.unref?.();
    }
    return row;
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending.length) return;
    const text = this.pending.map((r) => JSON.stringify(r)).join('\n') + '\n';
    this.pending = [];
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size + text.length > this.maxBytes) fs.renameSync(this.file, this.#older());
      fs.appendFileSync(this.file, text, { mode: 0o600 });
    } catch (error) {
      console.error(`[activity] could not write the activity log: ${error.message}`);
    }
  }

  /**
   * The newest first, `limit` at a time from `offset`, narrowed to one person (`user`), a text
   * (`q`, in any field), a kind, and a time window (`from`/`to`, ISO). `people`: everyone seen.
   */
  list({ limit = 50, offset = 0, user = '', q = '', kind = '', from = '', to = '' } = {}) {
    const since = new Date(Date.now() - this.keepDays * 86_400_000).toISOString();
    const needle = clean(q).toLowerCase();
    const matches = [];
    const people = new Map();
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const e = this.entries[i];
      if (e.at < since) continue;
      if (e.user) people.set(e.user, e.name || people.get(e.user) || '');
      if (user && e.user !== user) continue;
      if (kind && e.kind !== kind) continue;
      if (from && e.at < from) continue;
      if (to && e.at > to) continue;
      if (needle && !`${e.user} ${e.name} ${e.role} ${e.ip} ${e.action} ${e.target} ${e.fields.join(' ')} ${e.status ?? ''}`.toLowerCase().includes(needle)) continue;
      matches.push(e);
    }
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.min(500, Math.max(1, Number(limit) || 50));
    return {
      total: matches.length,
      entries: matches.slice(start, start + size),
      people: [...people].map(([email, name]) => ({ email, name })).sort((a, b) => a.email.localeCompare(b.email)),
    };
  }

  /** Every entry still kept (both files), oldest first, as CSV. */
  csv() {
    this.flush();
    const cols = ['at', 'user', 'name', 'role', 'ip', 'kind', 'action', 'target', 'fields', 'status', 'ms'];
    const cell = (v) => {
      const s = Array.isArray(v) ? v.join(' ') : String(v ?? '');
      // Never a formula when opened in a spreadsheet.
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const lines = [cols.join(',')];
    for (const f of [this.#older(), this.file]) {
      let text = '';
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          lines.push(cols.map((c) => cell(e[c])).join(','));
        } catch {}
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

// ---------------------------------------------------------------------------------------------
// What a request was, in words
// ---------------------------------------------------------------------------------------------

/** The actions people take, by "METHOD route". Anything else is described from its route. */
export const ACTIONS = {
  // Signing in and out, and one's own account
  'POST /api/session/password': 'Signed in with a password',
  'POST /api/session': 'Signed in with a Checkmarx One key',
  'DELETE /api/session': 'Signed out',
  'POST /api/setup': 'Set up the first administrator',
  'POST /api/me/password': 'Changed their password',
  'PUT /api/me/profile': 'Changed their profile',
  'PUT /api/me/avatar': 'Changed their picture',
  'PUT /api/me/branding': 'Changed their branding',
  'POST /api/me/tenant': 'Switched tenant',
  'POST /api/terms/accept': 'Accepted the terms of use',
  // People and roles
  'POST /api/iam/users': 'Added a person',
  'PATCH /api/iam/users/:id': 'Changed a person',
  'DELETE /api/iam/users/:id': 'Removed a person',
  'POST /api/iam/users/:id/password': 'Set a person\'s password',
  'PUT /api/iam/users/:id/tenants': 'Changed a person\'s tenants',
  'PUT /api/iam/users/:id/profile': 'Changed a person\'s profile',
  'PUT /api/iam/users/:id/avatar': 'Changed a person\'s picture',
  'PUT /api/iam/policy': 'Changed who may reset a password by email',
  'POST /api/iam/roles': 'Added a role',
  'PUT /api/iam/roles/:id': 'Changed a role',
  'DELETE /api/iam/roles/:id': 'Removed a role',
  // Settings and connections
  'PUT /api/settings': 'Changed settings',
  'POST /api/settings/import-env': 'Uploaded a .env file',
  'POST /api/settings/connections/check': 'Checked the connections',
  'POST /api/settings/smtp/test': 'Tested the email server',
  'POST /api/settings/smtp/send-test': 'Sent a test email',
  'POST /api/integration/cxone': 'Connected Checkmarx One',
  'DELETE /api/integration/cxone': 'Disconnected Checkmarx One',
  'PUT /api/organisation-name': 'Changed the organisation name',
  'PUT /api/network': 'Changed the proxy',
  'DELETE /api/network': 'Removed the proxy',
  'POST /api/network/check': 'Checked the way to Checkmarx One',
  'POST /api/trust/upload': 'Uploaded a trusted certificate',
  'POST /api/trust/presented': 'Trusted a presented certificate',
  'DELETE /api/trust/:fingerprint': 'Removed a trusted certificate',
  'POST /api/https/certificate': 'Uploaded an HTTPS certificate',
  'POST /api/https/certificate/previous': 'Went back to the previous HTTPS certificate',
  'DELETE /api/https/certificate': 'Removed the HTTPS certificate',
  'POST /api/https/self-signed': 'Made a self-signed certificate',
  'POST /api/https/request': 'Made a certificate request',
  'POST /api/https/mode': 'Changed HTTP and HTTPS',
  'POST /api/https/hardening': 'Changed HTTPS hardening',
  'POST /api/https/acme': 'Set up Let\'s Encrypt',
  'POST /api/https/acme/renew': 'Renewed the Let\'s Encrypt certificate',
  'DELETE /api/https/acme': 'Removed Let\'s Encrypt',
  'PUT /api/features/:id': 'Changed a feature',
  'PUT /api/hands-off': 'Changed hands-off mode',
  'POST /api/hands-off/check': 'Ran the hands-off check',
  'PUT /api/automation': 'Changed the automation',
  'POST /api/automation/arm': 'Armed the automation',
  'DELETE /api/automation/arm': 'Disarmed the automation',
  'POST /api/automation/run': 'Ran the automation now',
  'POST /api/automation/reset': 'Reset the automation',
  // Findings, reminders, credits and AI
  'GET /api/scan': 'Fetched findings from Checkmarx One',
  'POST /api/scan/stop': 'Stopped a fetch',
  'POST /api/discover': 'Detected the Checkmarx One endpoints',
  'POST /api/initiators/tag': 'Tagged projects with their scan initiators',
  'POST /api/reminders': 'Sent reminders',
  'POST /api/reminders/send-html-by-initiator': 'Sent reports to scan initiators',
  'POST /api/reports/html': 'Made a findings report',
  'POST /api/credits/verify': 'Checked credit needs with Checkmarx One',
  'POST /api/credits/refresh': 'Read credit use again',
  'POST /api/credits/allocate': 'Allocated credits',
  'POST /api/triage/run': 'Ran AI Triage',
  'POST /api/remediation/run': 'Ran AI Remediation',
  // Tracked reports
  'POST /api/tracked-reports': 'Created a tracked report',
  'DELETE /api/tracked-reports/:id': 'Deleted a tracked report',
  'PUT /api/tracked-reports/:id/automation': 'Changed a tracked report\'s automation',
  'PUT /api/tracked-reports/:id/verify-settings': 'Changed a tracked report\'s verification',
  'POST /api/tracked-reports/:id/remind': 'Sent a tracked report\'s reminder',
  'POST /api/tracked-reports/:id/allocate': 'Allocated credits from a tracked report',
  'POST /api/tracked-reports/:id/triage': 'Ran AI Triage from a tracked report',
  'POST /api/tracked-reports/:id/remediate': 'Ran AI Remediation from a tracked report',
  'POST /api/tracked-reports/:id/refresh': 'Refreshed a tracked report',
  'POST /api/tracked-reports/:id/verify': 'Verified a tracked report by rescan',
  'POST /api/tracked-reports/:id/next-round': 'Started a tracked report\'s next round',
  // Cx Credits Calculator and Impact
  'POST /api/projections': 'Created a calculator customer',
  'PUT /api/projections/:id': 'Changed a calculator customer',
  'DELETE /api/projections/:id': 'Deleted a calculator customer',
  'POST /api/projections/read': 'Read Checkmarx One for the calculator',
  'POST /api/projections/fusion/read': 'Read Fusion projects for the calculator',
  'POST /api/projections/reports': 'Generated a projection report',
  'GET /api/projections/reports/:id': 'Downloaded a projection report',
  'DELETE /api/projections/reports/:id': 'Deleted a projection report',
  'POST /api/projections/reports/:id/email': 'Emailed a projection report',
  'POST /api/impact/email': 'Emailed the Impact summary',
  'GET /api/impact/summary.html': 'Downloaded the Impact summary',
  // Logs, backups, updates, tenants, support
  'GET /api/audit/export': 'Exported the audit log',
  'GET /api/activity/export': 'Exported the user activity log',
  'GET /api/diagnostics/download': 'Downloaded the troubleshooting log',
  'GET /api/backup/download': 'Downloaded a backup',
  'POST /api/backup/now': 'Made a backup',
  'POST /api/backup/restore': 'Restored a backup',
  'DELETE /api/backup/restore': 'Cancelled a restore',
  'POST /api/system/update/check': 'Checked for updates',
  'POST /api/system/update/install': 'Installed an update',
  'POST /api/system/update/switch': 'Switched to another version',
  'POST /api/system/update/full': 'Started a full image update',
  'POST /api/system/update/restart': 'Restarted the server',
  'PUT /api/system/update/settings': 'Changed the update settings',
  'POST /api/activation': 'Entered an activation code',
  'POST /api/tenants': 'Added a tenant',
  'PATCH /api/tenants/:id': 'Changed a tenant',
  'DELETE /api/tenants/:id': 'Removed a tenant',
  'POST /api/tenants/enabled': 'Turned several tenants on or off',
  'POST /api/support': 'Opened a support case',
  'POST /api/support/:id/messages': 'Wrote on a support case',
  'POST /api/support/:id/status': 'Changed a support case\'s status',
  // Beta
  'POST /api/beta/github/evaluate': 'Compared GitHub username matching',
  'POST /api/beta/github/apply': 'Applied GitHub username matches',
  'POST /api/beta/scm/evaluate': 'Compared username matching',
  'POST /api/beta/scm/apply': 'Applied username matches',
  'POST /api/beta/scm/check': 'Checked a source-code host',
  'POST /api/beta/authors/find': 'Found code authors',
  'POST /api/beta/authors/notify': 'Emailed code authors',
  'POST /api/beta/fusion/read': 'Read Fusion results',
  'POST /api/beta/fusion/allocate': 'Allocated credits for Fusion results',
  'POST /api/beta/fusion/triage': 'Ran AI Triage on Fusion results',
  'POST /api/beta/fusion/remediate': 'Ran AI Remediation on Fusion results',
};

const VERBS = { POST: 'Did', PUT: 'Changed', PATCH: 'Changed', DELETE: 'Removed', GET: 'Opened' };

/** "PUT /api/tracked-reports/:id/automation" → "Changed tracked reports › automation", when it has no name of its own. */
export function describe(method, route) {
  const named = ACTIONS[`${method} ${route}`];
  if (named) return named;
  const words = String(route).replace(/^\/api\//, '').split('/').filter((p) => p && !p.startsWith(':')).map((p) => p.replace(/[-_]/g, ' '));
  return `${VERBS[method] ?? method} ${words.join(' › ') || route}`;
}

/** The names of the fields a request sent (two levels deep), never their values. */
export function fieldNames(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const out = [];
  for (const [k, v] of Object.entries(body)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const k2 of Object.keys(v)) out.push(`${k}.${k2}`);
    else out.push(k);
    if (out.length >= 30) break;
  }
  return out;
}

/** Which item a request was about: its route's ids (":id" → "id 7f3a…"). */
export function targetOf(params) {
  return Object.entries(params ?? {}).map(([k, v]) => `${k} ${String(v).slice(0, 60)}`).join(', ');
}

/** GET requests worth recording: downloads, exports, reports. Everything else read is not. */
export function recordsGet(route) {
  return Boolean(ACTIONS[`GET ${route}`]) || /\/(download|export)\b|\.(html|csv)$/.test(route);
}
