// Audit: credit events and their integrity, reconciliation, what people did, backups and restore.
import { sortAndFilter, tableFiltered } from '../table-tools.js';
import { $, can, state } from './state.js';
import { escapeHtml, formatTime } from './format.js';
import { api, handleAuthLoss, setStatus, showError, toast } from './core.js';

// ---------------------------------------------------------------------------
// Audit: credit events, integrity, reconciliation, backups
// ---------------------------------------------------------------------------

const audit = { entries: [], next: 0, more: false, loaded: false, page: 0 };
const OUTCOME_BADGES = {
  charged: ['Charged', ''],
  'not-charged': ['Not charged', 'muted'],
  refused: ['Refused', 'warn'],
  failed: ['Failed', 'bad'],
  changed: ['Changed', 'muted'],
  info: ['Info', 'muted'],
};
const TYPE_LABELS = {
  triage: 'Triage',
  remediation: 'Remediation',
  allocation: 'Allocation',
  settings: 'Credit settings',
  report: 'Report issued',
  backup: 'Backup',
  audit: 'Audit check',
  access: 'Sign-in',
  iam: 'Access change',
};
const formatBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

function auditQuery(extra = {}) {
  const params = new URLSearchParams();
  const set = (key, value) => value && params.set(key, value);
  set('from', $('audit-from').value);
  set('to', $('audit-to').value);
  set('types', $('audit-type').value);
  set('outcomes', $('audit-outcome').value);
  set('project', $('audit-project').value.trim());
  set('q', $('audit-q').value.trim());
  for (const [key, value] of Object.entries(extra)) set(key, String(value));
  return params.toString();
}

function actorText(actor = {}) {
  if (actor.kind === 'report') {
    return [actor.recipient || 'report recipient', `emailed report${actor.reportVerified === false ? ' (unsigned)' : ''}`];
  }
  if (actor.kind === 'admin') return [actor.email || actor.user || actor.name || 'administrator', `admin${actor.tenant ? ` · ${actor.tenant}` : ''}`];
  if (actor.kind === 'user') return [actor.email || actor.user || 'unknown', [actor.role, actor.via].filter(Boolean).join(' · ') || 'signed-in user'];
  return [actor.user || actor.kind || 'system', actor.kind || ''];
}

function renderAuditTotals(totals) {
  const outcome = totals.byOutcome ?? {};
  const tiles = [
    ['Credits charged', totals.charged, 'accent'],
    ['Triage credits', totals.triageCharged, ''],
    ['Remediation credits', totals.remediationCharged, ''],
    ['Refused', outcome.refused ?? 0, outcome.refused ? 'warn' : ''],
    ['Failed', outcome.failed ?? 0, outcome.failed ? 'bad' : ''],
    ['Entries', totals.entries, ''],
  ];
  $('audit-totals').innerHTML = tiles
    .map(([label, value, cls]) => `<div><span class="value ${cls}">${Number(value ?? 0).toLocaleString()}</span><span class="label">${label}</span></div>`)
    .join('');
}

function auditDetail(e) {
  const [who, role] = actorText(e.actor);
  const facts = [
    ['Entry', `#${e.seq} · ${e.id}`],
    ['Time', `${formatTime(e.at)} (${e.at})`],
    ['Who', `${who} — ${role}`],
    e.actor?.ip && ['From', `${e.actor.ip}${e.actor.userAgent ? ` · ${e.actor.userAgent}` : ''}`, 'origin'],
    e.actor?.reportId && ['Report', e.actor.reportId],
    e.project && ['Project', `${e.project.name || ''} (${e.project.id})`],
    e.credits && ['Credits', `${e.credits.kind}: requested ${e.credits.requested ?? 0}, charged ${e.credits.charged ?? 0}`],
    e.balance?.before && ['Before', `allocated ${e.balance.before.allocated} · used ${e.balance.before.used} · remaining ${e.balance.before.remaining}`],
    e.balance?.after && ['After', `allocated ${e.balance.after.allocated} · used ${e.balance.after.used} · remaining ${e.balance.after.remaining}`],
    e.month && ['Month', `limit ${e.month.limit || 'none'} · remaining ${e.month.remaining ?? '—'}`],
    e.upstream && ['Checkmarx One', [e.upstream.call, e.upstream.status && `HTTP ${e.upstream.status}`, e.upstream.jobId && `job ${e.upstream.jobId}`, e.upstream.ms != null && `${e.upstream.ms} ms`, e.upstream.error].filter(Boolean).join(' · ')],
    e.findings?.length && ['Findings', `${e.findings.length}: ${e.findings.slice(0, 8).map((f) => f.riskId).join(', ')}${e.findings.length > 8 ? '…' : ''}`],
    ['Chain', `mac ${e.mac?.slice(0, 16)}… ← ${e.prev?.slice(0, 16)}…`],
  ].filter(Boolean);
  return `<div class="facts">${facts.map(([k, v, ctx]) => `<div><b${ctx ? ` data-i18n-ctx="${ctx}"` : ''}>${escapeHtml(k)}</b>${escapeHtml(v)}</div>`).join('')}</div>
    <details><summary class="hint">Full entry (JSON)</summary><pre>${escapeHtml(JSON.stringify(e, null, 2))}</pre></details>`;
}

const AUDIT_PAGE = 25;

/** What each heading of the audit log reads (sorting and the heading filters cover every entry loaded). */
const AUDIT_COLUMNS = [
  (e) => e.seq,
  { value: (e) => Date.parse(e.at) || null, text: (e) => formatTime(e.at) },
  (e) => `${TYPE_LABELS[e.type] ?? e.type} ${e.reason || ''}`,
  (e) => (OUTCOME_BADGES[e.outcome] ?? [e.outcome])[0],
  (e) => actorText(e.actor).join(' '),
  (e) => e.project?.name || e.project?.id || '',
  { value: (e) => e.credits?.charged ?? null, text: (e) => String(e.credits?.charged ?? '') },
  { value: (e) => (e.balance?.after?.remaining === undefined ? null : Number(e.balance.after.remaining)), text: (e) => String(e.balance?.after?.remaining ?? '') },
  null,
];
let auditShown = [];

function renderAuditRows() {
  auditShown = sortAndFilter('audit', audit.entries, AUDIT_COLUMNS, () => {
    audit.page = 0;
    renderAuditRows();
  });
  if (!auditShown.length) {
    $('audit-body').innerHTML = '<tr><td colspan="9" class="hint">No audit entries match these filters.</td></tr>';
  } else {
    const pages = Math.max(1, Math.ceil(auditShown.length / AUDIT_PAGE));
    audit.page = Math.min(audit.page ?? 0, pages - 1);
    const first = audit.page * AUDIT_PAGE;
    const indexOf = new Map(audit.entries.map((e, i) => [e, i]));
    $('audit-body').innerHTML = auditShown
      .slice(first, first + AUDIT_PAGE)
      .map((e) => {
        const i = indexOf.get(e);
        const [label, cls] = OUTCOME_BADGES[e.outcome] ?? [e.outcome, 'muted'];
        const [who, role] = actorText(e.actor);
        const charged = e.credits?.charged ? `<b>${e.credits.charged}</b>` : e.credits?.requested ? `<span class="muted">0 / ${e.credits.requested}</span>` : '';
        const remaining = e.balance?.after?.remaining ?? '';
        return `<tr data-audit="${i}">
          <td class="num muted c-seq">${e.seq}</td>
          <td class="when c-when">${escapeHtml(formatTime(e.at))}</td>
          <td class="c-event"><strong>${escapeHtml(TYPE_LABELS[e.type] ?? e.type)}</strong><span class="reason">${escapeHtml(e.reason || '')}</span></td>
          <td class="c-outcome"><span class="badge ${cls}">${escapeHtml(label)}</span></td>
          <td class="who c-who">${escapeHtml(who)}<small>${escapeHtml(role)}${e.actor?.ip ? ` · ${escapeHtml(e.actor.ip)}` : ''}</small></td>
          <td class="c-project">${escapeHtml(e.project?.name || e.project?.id || '')}</td>
          <td class="num c-credits">${charged}</td>
          <td class="num c-remaining">${remaining === '' ? '' : `<span class="m-label">left </span>${escapeHtml(remaining)}`}</td>
          <td class="c-open"><button type="button" class="link" data-audit-open="${i}" aria-expanded="false">Details</button></td>
        </tr>`;
      })
      .join('');
  }
  const pages = Math.max(1, Math.ceil(auditShown.length / AUDIT_PAGE));
  const first = (audit.page ?? 0) * AUDIT_PAGE;
  $('audit-more').hidden = true;
  $('audit-prev').disabled = !audit.page;
  $('audit-next').disabled = audit.page >= pages - 1 && !audit.more;
  $('audit-page').textContent = auditShown.length ? `Page ${audit.page + 1}${audit.more ? '' : ` of ${pages}`}` : '';
  $('audit-count').textContent = !auditShown.length
    ? ''
    : tableFiltered('audit')
      ? `${auditShown.length.toLocaleString()} of the ${audit.entries.length.toLocaleString()} entries loaded match the column filters`
      : `Entries ${(first + 1).toLocaleString()}–${Math.min(first + AUDIT_PAGE, auditShown.length).toLocaleString()}${audit.more ? ', newest first' : ` of ${auditShown.length.toLocaleString()}, newest first`}`;
}



async function loadAudit({ append = false } = {}) {
  setStatus('audit-status', append ? '' : 'Loading…');
  try {
    const result = await api(`/api/audit?${auditQuery({ limit: 100, ...(append ? { before: audit.next } : {}) })}`);
    audit.entries = append ? audit.entries.concat(result.entries) : result.entries;
    if (!append) audit.page = 0;
    audit.next = result.next;
    audit.more = result.more;
    renderAuditTotals(result.totals);
    renderAuditRows();
    if (result.writeError) setStatus('audit-status', `${result.writeError.entries} audit entr${result.writeError.entries === 1 ? 'y is' : 'ies are'} held in memory — the log folder cannot be written: ${result.writeError.error}`, 'error');
    else setStatus('audit-status', '');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('audit-status', error);
  }
}

function downloadAudit(format) {
  const link = document.createElement('a');
  link.href = `/api/audit/export?${auditQuery({ format })}`;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}

// ---- Logs → User activity: what each person did (GET /api/activity) ---------------------------

const UA_PAGE = 50;
export const userActivity = { offset: 0, total: 0, loaded: false };
const UA_KINDS = { action: 'Action', page: 'Page', 'sign-in': 'Sign-in', event: 'Event' };

/** The filters as query parameters; a date's day runs from midnight to midnight in this browser's time. */
function userActivityQuery() {
  const params = new URLSearchParams();
  const set = (key, value) => value && params.set(key, value);
  set('user', $('ua-user').value);
  set('kind', $('ua-kind').value);
  set('q', $('ua-q').value.trim());
  if ($('ua-from').value) set('from', new Date(`${$('ua-from').value}T00:00:00`).toISOString());
  if ($('ua-to').value) set('to', new Date(`${$('ua-to').value}T23:59:59.999`).toISOString());
  return params;
}

function userActivityResult(e) {
  if (e.status == null) return '';
  if (e.status >= 400) return `<span class="badge bad">${escapeHtml(e.kind === 'sign-in' ? 'Refused' : 'Failed')}</span> <small class="muted" translate="no">HTTP ${e.status}</small>`;
  return `<span class="badge ok">Done</span>${e.ms != null ? ` <small class="muted" translate="no">${e.ms} ms</small>` : ''}`;
}

function renderUserActivity(result) {
  const select = $('ua-user');
  const chosen = select.value;
  select.innerHTML = `<option value="">Everyone</option>${result.people.map((p) => `<option value="${escapeHtml(p.email)}">${escapeHtml(p.name ? `${p.name} (${p.email})` : p.email)}</option>`).join('')}`;
  select.value = result.people.some((p) => p.email === chosen) ? chosen : '';
  userActivity.total = result.total;
  $('ua-body').innerHTML = result.entries.length
    ? result.entries
        .map((e) => {
          // The actions and items are kept as recorded (in English, as in the audit log); the labels around them are translated.
          const details = [e.target && `<span translate="no">${escapeHtml(e.target)}</span>`, e.fields?.length && `<span class="muted">Fields:</span> <span translate="no">${escapeHtml(e.fields.join(', '))}</span>`].filter(Boolean).join('<br />');
          return `<tr>
          <td class="when">${escapeHtml(formatTime(e.at))}</td>
          <td class="who"><span translate="no">${escapeHtml(e.name || e.user || '—')}</span><small><span translate="no">${escapeHtml(e.name ? e.user : '')}</span>${e.role ? `${e.name ? ' · ' : ''}${escapeHtml(e.role)}` : ''}</small></td>
          <td class="ua-action"><span class="badge muted">${escapeHtml(UA_KINDS[e.kind] ?? e.kind)}</span> <span translate="no">${escapeHtml(e.action)}</span></td>
          <td class="ua-details">${details}</td>
          <td>${userActivityResult(e)}</td>
          <td class="muted" translate="no">${escapeHtml(e.ip || '')}</td>
        </tr>`;
        })
        .join('')
    : '<tr><td colspan="6" class="hint">Nothing recorded matches these filters.</td></tr>';
  const first = userActivity.offset;
  $('ua-prev').disabled = first === 0;
  $('ua-next').disabled = first + UA_PAGE >= result.total;
  $('ua-count').textContent = result.total ? `Entries ${(first + 1).toLocaleString()}–${Math.min(first + UA_PAGE, result.total).toLocaleString()} of ${result.total.toLocaleString()}, newest first` : '';
}

export async function loadUserActivity({ offset = 0 } = {}) {
  if (!can('audit.view')) return;
  userActivity.offset = Math.max(0, offset);
  setStatus('ua-status', 'Loading…');
  try {
    const params = userActivityQuery();
    params.set('limit', UA_PAGE);
    params.set('offset', userActivity.offset);
    renderUserActivity(await api(`/api/activity?${params}`));
    userActivity.loaded = true;
    setStatus('ua-status', '');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('ua-status', error);
  }
}

/**
 * Which page and tab each person opens goes into the user activity log (the server adds who and when).
 * Fire and forget: a page never waits on it, and the same page twice in a row is sent once.
 */
export function reportVisit(name) {
  // A property, not a variable: route() may run before this part of the file has.
  if (!state.me || !name || name === reportVisit.last) return;
  reportVisit.last = name;
  reportActivity('page', name);
}
function reportActivity(kind, name) {
  const clean = String(name).replace(/[^\w .,:/#&()'’›→-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!clean) return;
  fetch('/api/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', keepalive: true, body: JSON.stringify({ kind, name: clean }) }).catch(() => {});
}

async function loadBackupStatus() {
  try {
    const b = await api('/api/backup');
    const last = b.last
      ? b.last.ok
        ? `${formatTime(b.last.at)} — ${b.last.trigger}, ${b.last.files} files`
        : `${formatTime(b.last.at)} — failed: ${b.last.error}`
      : b.backups[0]
        ? formatTime(b.backups[0].at)
        : 'none yet';
    const facts = [
      ['State folder', `${b.dataDir}${b.insideProject ? ' — inside the project folder: set DATA_DIR' : ''}`, b.insideProject],
      ['Holds', `${b.files} files, ${formatBytes(b.bytes)}`],
      ['Backup folder', `${b.backupDir}${b.sameDisk ? ' — same disk as the state: set BACKUP_DIR to another disk or share' : ''}`, b.sameDisk],
      ['Schedule', b.intervalHours ? `every ${b.intervalHours} h, keeping ${b.keep}${b.encrypted ? ', encrypted' : ', not encrypted'}` : 'off (BACKUP_INTERVAL_HOURS=0)', !b.encrypted],
      ['Encryption', backupEncryptionText(b.encryption), !b.encryption.encrypted || b.encryption.notice === 'save-key'],
      ['Last backup', last, b.last && !b.last.ok],
      b.pendingRestore && ['Restore staged', 'applied when the server restarts', true],
      b.restoredAtStart && ['Restored at start', `backup of ${formatTime(b.restoredAtStart.createdAt)} (${b.restoredAtStart.files} files)`],
    ].filter(Boolean);
    $('backup-facts').innerHTML = facts.map(([k, v, warn]) => `<div><dt>${escapeHtml(k)}</dt><dd class="${warn ? 'warn' : ''}">${escapeHtml(v)}</dd></div>`).join('');
    $('backup-list-wrap').hidden = !b.backups.length;
    $('backup-list').innerHTML = b.backups.map((f) => `<tr><td class="code">${escapeHtml(f.name)}</td><td class="num">${formatBytes(f.size)}</td><td>${escapeHtml(formatTime(f.at))}</td></tr>`).join('');
    renderBackupKeyPanel(b.encryption);
    if (b.pendingRestore && $('restore-panel').hidden) {
      $('restore-panel').hidden = false;
      $('restore-panel').className = 'audit-result';
      $('restore-panel').innerHTML = '<span>A restore is staged and will be applied when the server restarts.</span><div><button type="button" id="restore-cancel" class="sm">Cancel the restore</button></div>';
    }
  } catch (error) {
    if (!handleAuthLoss(error)) showError('backup-status', error);
  }
}

// ---- Backup encryption and the server's backup key (Admins: backup.manage) ----

/** The "Encryption" line of the facts: what encrypts a backup made now. */
function backupEncryptionText(e) {
  if (e.source === 'passphrase') return 'on, with BACKUP_PASSPHRASE';
  if (e.source === 'key') {
    return e.keySaved
      ? `on, with this server's backup key (saved somewhere else: confirmed ${formatTime(e.keySavedAt)}${e.keySavedBy ? ` by ${e.keySavedBy}` : ''})`
      : 'on, with this server\'s backup key — nobody has confirmed saving the key somewhere else yet';
  }
  return e.optedOut ? 'off (BACKUP_ENCRYPTION=off is set on the server)' : 'off — each backup holds the keys and passwords in the clear';
}

/** The key while it is on screen (never kept anywhere else in the page). */
let backupKeyShown = null;

/** The Admins' block under the backup buttons: turn encryption on, see the key, copy or download it, confirm it is saved. */
function renderBackupKeyPanel(encryption) {
  const panel = $('backup-key-panel');
  panel.dataset.source = encryption.source;
  if (encryption.source !== 'key') backupKeyShown = null;
  // With BACKUP_PASSPHRASE the server's key is not used: there is nothing to do here.
  panel.hidden = encryption.source === 'passphrase';
  // (classList, not className: the permission class on the panel stays.)
  panel.classList.toggle('bad', Boolean(encryption.notice));
  if (encryption.source === 'none') {
    panel.innerHTML = encryption.optedOut
      ? '<strong>Backups are not encrypted.</strong><span>BACKUP_ENCRYPTION=off is set on the server. Each backup holds the Checkmarx One key, the mail password and the signing keys in the clear. To encrypt them, remove that setting and restart the server.</span>'
      : `<strong>Backups are not encrypted.</strong>
        <span>Each backup holds the Checkmarx One key, the mail password and the signing keys in the clear. Turn encryption on and the server makes a backup key, shows it to you, and encrypts every backup from then on. Backups made before stay as they are.</span>
        <div><button type="button" id="backup-encrypt-on" class="sm">Turn on backup encryption</button></div>`;
    return;
  }
  const saved = encryption.keySaved
    ? `<span class="hint">Saved somewhere else: confirmed ${escapeHtml(formatTime(encryption.keySavedAt))}${encryption.keySavedBy ? ` by ${escapeHtml(encryption.keySavedBy)}` : ''}.</span>`
    : '<span><b>Nobody has confirmed saving this key yet.</b> Show it, keep a copy somewhere other than this server (a password manager, a safe), then confirm.</span>';
  const shown = backupKeyShown
    ? `<code class="code" id="backup-key-value">${escapeHtml(backupKeyShown.key)}</code>
       <div><button type="button" id="backup-key-copy" class="sm">Copy</button> <button type="button" id="backup-key-download" class="sm">Download as a text file</button> <button type="button" id="backup-key-hide" class="sm ghost">Hide</button></div>`
    : '<div><button type="button" id="backup-key-show" class="sm">Show backup key</button></div>';
  panel.innerHTML = `<strong>Backup key</strong>
    <span>Every backup is encrypted with this server's backup key. Keep the key somewhere other than this server: if the server is lost, a backup opens only with it. To restore on another server, give the key when the restore asks, or set BACKUP_PASSPHRASE to it. The key is never emailed and is not inside a backup.</span>
    ${shown}
    ${saved}
    ${backupKeyShown && !encryption.keySaved ? '<div><button type="button" id="backup-key-confirm" class="sm">I have saved it</button></div>' : ''}`;
}

/** The Admins' notice at the top of every page, until they act. */
export function renderBackupBanner(notice) {
  const banner = $('backup-banner');
  if (!banner) return;
  banner.hidden = !notice;
  if (!notice) return;
  banner.innerHTML = notice === 'save-key'
    ? 'Backups are encrypted with this server\'s backup key, and nobody has confirmed saving the key somewhere else yet. If this server is lost, its backups open only with that key. <a href="#/audit/backups">Save the backup key</a>'
    : 'Backups of this server are not encrypted: each one holds the Checkmarx One key, the mail password and the signing keys in the clear. <a href="#/audit/backups">Turn on backup encryption</a>';
}

/** After a change to backup encryption: the panel, the facts and the notice follow. */
function backupEncryptionChanged(encryption) {
  if (state.me) state.me = { ...state.me, backupNotice: encryption.notice };
  renderBackupBanner(encryption.notice);
  loadBackupStatus();
}

async function showBackupKey() {
  backupKeyShown = await api('/api/backup/key/show', { method: 'POST' });
}

let restoreUpload = null;
async function sendRestore(check) {
  const headers = { 'Content-Type': 'application/octet-stream' };
  if (restoreUpload.passphrase) headers['X-Backup-Passphrase'] = restoreUpload.passphrase;
  const response = await fetch(`/api/backup/restore${check ? '?check=1' : ''}`, { method: 'POST', credentials: 'same-origin', headers, body: restoreUpload.file });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
  return payload;
}

export function wireAudit() {
  $('audit-prev').addEventListener('click', () => {
    audit.page = Math.max(0, (audit.page ?? 0) - 1);
    renderAuditRows();
    $('audit-body').closest('.panel').scrollIntoView({ block: 'nearest' });
  });
  $('audit-next').addEventListener('click', async () => {
    const next = (audit.page ?? 0) + 1;
    if (next * AUDIT_PAGE >= auditShown.length && audit.more) await loadAudit({ append: true });
    audit.page = next;
    renderAuditRows();
    $('audit-body').closest('.panel').scrollIntoView({ block: 'nearest' });
  });

  $('audit-filters').addEventListener('submit', (event) => {
    event.preventDefault();
    loadAudit();
  });
  for (const id of ['audit-type', 'audit-outcome', 'audit-from', 'audit-to']) $(id).addEventListener('change', () => loadAudit());
  $('audit-reset').addEventListener('click', () => {
    $('audit-filters').reset();
    loadAudit();
  });
  $('audit-more').addEventListener('click', () => loadAudit({ append: true }));
  $('audit-body').addEventListener('click', (event) => {
    const button = event.target.closest('[data-audit-open]');
    if (!button) return;
    const row = button.closest('tr');
    const open = row.nextElementSibling?.classList.contains('detail');
    if (open) {
      row.nextElementSibling.remove();
      button.setAttribute('aria-expanded', 'false');
      return;
    }
    row.insertAdjacentHTML('afterend', `<tr class="detail"><td colspan="9">${auditDetail(audit.entries[Number(button.dataset.auditOpen)])}</td></tr>`);
    button.setAttribute('aria-expanded', 'true');
  });
  $('audit-export-csv').addEventListener('click', () => downloadAudit('csv'));
  $('audit-export-jsonl').addEventListener('click', () => downloadAudit('jsonl'));

  $('ua-filters').addEventListener('submit', (event) => {
    event.preventDefault();
    loadUserActivity();
  });
  for (const id of ['ua-user', 'ua-kind', 'ua-from', 'ua-to']) $(id).addEventListener('change', () => loadUserActivity());
  $('ua-reset').addEventListener('click', () => {
    $('ua-filters').reset();
    loadUserActivity();
  });
  $('ua-prev').addEventListener('click', () => loadUserActivity({ offset: userActivity.offset - UA_PAGE }));
  $('ua-next').addEventListener('click', () => loadUserActivity({ offset: userActivity.offset + UA_PAGE }));
  $('ua-export').addEventListener('click', () => {
    const link = document.createElement('a');
    link.href = '/api/activity/export';
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
  });
  window.mzReportActivity = reportActivity;

  $('audit-verify').addEventListener('click', async () => {
    const box = $('audit-verify-result');
    box.hidden = false;
    box.className = 'audit-result';
    box.textContent = 'Checking every entry…';
    try {
      const r = await api('/api/audit/verify');
      box.className = `audit-result ${r.ok ? 'ok' : 'bad'}`;
      box.innerHTML = r.ok
        ? `<strong>Intact.</strong> <span>${r.entries.toLocaleString()} entries${r.first ? `, ${escapeHtml(formatTime(r.first))} → ${escapeHtml(formatTime(r.last))}` : ''}: none edited, removed or reordered.</span>`
        : `<strong>${r.problems.length} problem(s) found in ${r.entries.toLocaleString()} entries.</strong>
         <ul>${r.problems.map((p) => `<li>${p.seq ? `Entry #${p.seq}: ` : `${escapeHtml(p.file ?? '')}: `}${escapeHtml(p.problem)}</li>`).join('')}</ul>
         <span class="hint">Restore the audit folder from a backup, or keep this result as evidence.</span>`;
      loadAudit();
    } catch (error) {
      box.className = 'audit-result bad';
      box.textContent = error.message;
    }
  });

  $('audit-reconcile').addEventListener('click', async () => {
    const box = $('audit-reconcile-result');
    box.hidden = false;
    box.className = 'audit-result';
    box.textContent = 'Comparing…';
    try {
      const r = await api(`/api/audit/reconcile?month=${encodeURIComponent($('audit-month').value)}`);
      box.className = `audit-result ${r.matched ? 'ok' : 'bad'}`;
      const rows = r.projects
        .map((p) => `<tr><td>${escapeHtml(p.projectName || p.projectId)}</td><td class="num">${p.ledger}</td><td class="num">${p.audited}</td><td class="num ${p.difference ? 'aged' : ''}">${p.difference}</td></tr>`)
        .join('');
      box.innerHTML = `<strong>${escapeHtml(r.month)}: ledger ${r.ledgerTotal} credits, audit log ${r.auditedTotal}. ${r.matched ? 'Everything is accounted for.' : 'Differences found.'}</strong>
      ${r.unlinked.entries ? `<span>${r.unlinked.entries} ledger entr${r.unlinked.entries === 1 ? 'y' : 'ies'} (${r.unlinked.credits} credits) have no audit link — ${escapeHtml(r.unlinked.note)}</span>` : ''}
      ${r.missing.length ? `<span>${r.missing.length} ledger entr${r.missing.length === 1 ? 'y points' : 'ies point'} to audit entries that are missing.</span>` : ''}
      ${rows ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Project</th><th class="num">Ledger</th><th class="num">Audit log</th><th class="num">Difference</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<span class="hint">No credits used this month.</span>'}`;
    } catch (error) {
      box.className = 'audit-result bad';
      box.textContent = error.message;
    }
  });

  // Signed out (the sign-in panel shows): the notice goes away with the workspace it is about.
  new MutationObserver(() => {
    if (!$('connect-panel').hidden) renderBackupBanner(null);
  }).observe($('connect-panel'), { attributes: true, attributeFilter: ['hidden'] });

  $('backup-key-panel').addEventListener('click', async (event) => {
    const id = event.target.id;
    if (!id) return;
    try {
      if (id === 'backup-encrypt-on') {
        if (!confirm('Turn on backup encryption? The server makes a backup key and encrypts every backup from now on. You will be shown the key: keep it somewhere other than this server, because a backup opens only with it.')) return;
        const { encryption } = await api('/api/backup/encryption', { method: 'POST', body: JSON.stringify({ on: true }) });
        await showBackupKey();
        backupEncryptionChanged(encryption);
      } else if (id === 'backup-key-show') {
        await showBackupKey();
        loadBackupStatus();
      } else if (id === 'backup-key-hide') {
        backupKeyShown = null;
        loadBackupStatus();
      } else if (id === 'backup-key-copy') {
        try {
          await navigator.clipboard.writeText(backupKeyShown.key);
          toast('Backup key copied.');
        } catch {
          toast('Select the key and copy it.');
        }
      } else if (id === 'backup-key-download') {
        const text = [
          'CxMissionZero backup key',
          '',
          backupKeyShown.key,
          '',
          `Server: ${backupKeyShown.host}`,
          `Saved from the Audit page: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
          '',
          'Keep this file somewhere other than the server. Anyone who has it and a backup can read everything in the backup.',
          'To restore a backup on another server: give this key when the restore asks for it, or set BACKUP_PASSPHRASE to it.',
          '',
        ].join('\r\n');
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
        link.download = 'cxmissionzero-backup-key.txt';
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      } else if (id === 'backup-key-confirm') {
        if (!confirm('Have you saved the backup key somewhere other than this server? Without it, a backup cannot be opened if this server is lost.')) return;
        const { encryption } = await api('/api/backup/key/confirm', { method: 'POST' });
        backupKeyShown = null;
        backupEncryptionChanged(encryption);
      }
    } catch (error) {
      if (!handleAuthLoss(error)) showError('backup-status', error);
    }
  });

  $('backup-download').addEventListener('click', () => {
    const link = document.createElement('a');
    link.href = '/api/backup/download';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(loadBackupStatus, 1500);
  });

  $('backup-now').addEventListener('click', async () => {
    setStatus('backup-status', 'Backing up…');
    try {
      const r = await api('/api/backup/now', { method: 'POST' });
      setStatus('backup-status', `Written: ${r.file}`, 'ok');
      loadBackupStatus();
    } catch (error) {
      showError('backup-status', error);
    }
  });

  $('restore-file').addEventListener('change', async () => {
    const file = $('restore-file').files[0];
    $('restore-file').value = '';
    if (!file) return;
    restoreUpload = { file, passphrase: '' };
    const panel = $('restore-panel');
    panel.hidden = false;
    panel.className = 'audit-result';
    panel.textContent = `Checking ${file.name}…`;
    let result;
    for (;;) {
      try {
        result = await sendRestore(true);
        break;
      } catch (error) {
        if (/encrypted|passphrase/i.test(error.message)) {
          const passphrase = prompt(`${error.message}\n\nBackup key or passphrase:`);
          if (passphrase) {
            restoreUpload.passphrase = passphrase;
            continue;
          }
        }
        panel.className = 'audit-result bad';
        panel.textContent = error.message;
        return;
      }
    }
    const b = result.backup;
    panel.innerHTML = `<strong>${escapeHtml(file.name)}: checksum OK.</strong>
    <span>Made ${escapeHtml(formatTime(b.createdAt))} on ${escapeHtml(b.host)} — ${b.files} files, ${formatBytes(b.bytes)}. Settings ${b.hasSettings ? '✓' : '✗'} · credit ledger ${b.hasLedger ? '✓' : '✗'} · allocations ${b.hasAllocations ? '✓' : '✗'} · audit months: ${escapeHtml(b.auditMonths.join(', ') || 'none')}.</span>
    <span class="hint">Restoring replaces everything in the state folder when the server next restarts; the current files are kept in a replaced-… folder beside it.</span>
    <div><button type="button" id="restore-confirm" class="primary sm">Restore at next restart</button> <button type="button" id="restore-dismiss" class="sm ghost">Cancel</button></div>`;
  });

  $('restore-panel').addEventListener('click', async (event) => {
    const panel = $('restore-panel');
    if (event.target.id === 'restore-dismiss') {
      panel.hidden = true;
      restoreUpload = null;
    } else if (event.target.id === 'restore-confirm') {
      if (!confirm('Replace all settings, credit balances, tracked reports and the audit log with this backup at the next restart?')) return;
      try {
        await sendRestore(false);
        panel.className = 'audit-result ok';
        panel.innerHTML = '<strong>Restore staged.</strong><span>Restart the server to apply it. Until then nothing changes.</span><div><button type="button" id="restore-cancel" class="sm">Cancel the restore</button></div>';
        restoreUpload = null;
        loadBackupStatus();
      } catch (error) {
        panel.className = 'audit-result bad';
        panel.textContent = error.message;
      }
    } else if (event.target.id === 'restore-cancel') {
      await api('/api/backup/restore', { method: 'DELETE' });
      panel.hidden = true;
      loadBackupStatus();
    }
  });
}

export function renderAudit() {
  if (!$('audit-month').value) $('audit-month').value = new Date().toISOString().slice(0, 7);
  loadAudit();
  loadBackupStatus();
}
