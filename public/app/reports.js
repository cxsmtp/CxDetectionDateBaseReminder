// The Dashboard of tracked reports: the portfolio, the list, a report's drawer (overview, remind, triage, verify,
// schedule) and following a report up.
import { SEVERITIES_ALL, creditTiers } from '../credit-tiers.js';
import { describeEngines } from '../engines.js';
import { t } from '../i18n.js';
import { $, can, state } from './state.js';
import { escapeHtml, fmt } from './format.js';
import { api, handleAuthLoss, helpTip, setStatus, showError } from './core.js';
import { windowParams } from './workbench.js';
import { AUDIENCE_TEXT, allocationScope, audience } from './actions.js';
import { creditsChanged, noteGone } from './credits.js';

// ---------------------------------------------------------------------------
// Tracked reports
// ---------------------------------------------------------------------------

function trackScope() {
  const severity = $('severity-filter').value;
  // (How old the findings are is part of what was loaded, "Findings open for": the table no longer narrows by age.)
  const bucket = '';
  const projects = allocationScope();
  const parts = [
    $('scope-summary').textContent,
    severity ? `${severity.toLowerCase()} only` : 'all severities',
    describeEngines(state.lastScan?.engines ?? []),
    `${projects.length} project${projects.length === 1 ? '' : 's'}`,
  ].filter(Boolean);
  return { severity, bucket, projects, label: parts.join(' · ') };
}

export function renderTrackRow() {
  $('track-row').hidden = !state.projects.length;
  if (!state.projects.length) return;
  $('track-scope').textContent = `Saves: ${trackScope().label}`;
}

async function saveTrackedReport() {
  const name = $('track-name').value.trim();
  if (!name) return setStatus('track-status', 'Give the report a name.', 'error');
  const scope = trackScope();
  const params = windowParams();
  const windows = Object.fromEntries(
    ['activity', 'detection'].map((prefix) => [
      prefix,
      { preset: params.get(`${prefix}Preset`), from: params.get(`${prefix}From`) ?? undefined, to: params.get(`${prefix}To`) ?? undefined },
    ]),
  );
  try {
    const report = await api('/api/tracked-reports', {
      method: 'POST',
      body: JSON.stringify({
        name,
        projectIds: scope.projects.map((p) => p.projectId),
        severities: scope.severity ? [scope.severity] : [],
        buckets: scope.bucket ? [scope.bucket] : [],
        windows,
        scopeLabel: scope.label,
      }),
    });
    $('track-name').value = '';
    setStatus('track-status', `Saved "${report.name}" with ${report.baselineCount} finding(s). See Tracked reports.`, 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('track-status', error);
  }
}

const TRACK_POLL_MS = 30_000;
let trackTimer = null;
// The CxMissionZero server's time zone, which automatic reminders run in.
let serverZone = { name: '', offset: 'UTC' };
const zoneLabel = () => (serverZone.name ? `${serverZone.name} (${serverZone.offset})` : serverZone.offset);

export async function loadTrackedReports() {
  clearTimeout(trackTimer);
  if ($('page-reports').hidden) return;
  try {
    const data = await api('/api/tracked-reports');
    if (data.timeZone) serverZone = data.timeZone;
    renderTrackedReports(data);
  } catch (error) {
    if (handleAuthLoss(error)) return;
    $('reports-list').innerHTML = `<p class="status error">${escapeHtml(error.message)}</p>`;
  }
  trackTimer = setTimeout(loadTrackedReports, TRACK_POLL_MS);
}

const OUTCOME_LABELS = {
  resolved: 'No longer detected',
  notExploitable: 'Not exploitable',
  confirmed: 'Confirmed',
  awaiting: 'Awaiting triage',
};

/** Outcomes as one bar: what was dealt with, in colour, on a neutral track that is what is left. */
function progressBar(outcomes, total, { legend = true } = {}) {
  if (!total) return '<div class="rp-bar" role="img" aria-label="Nothing to track"></div>';
  const done = ['resolved', 'notExploitable', 'confirmed'];
  const label = done.map((k) => `${OUTCOME_LABELS[k]} ${outcomes[k] ?? 0}`).join(', ');
  const rest = Math.max(0, total - done.reduce((n, k) => n + (outcomes[k] ?? 0), 0));
  return `<div class="rp-bar" role="img" aria-label="${escapeHtml(`${label}, awaiting triage ${outcomes.awaiting ?? 0}, of ${total}`)}">${done
    .map((key) => (outcomes[key] ? `<span class="out-${key}" style="flex:${outcomes[key]} 1 0" title="${escapeHtml(OUTCOME_LABELS[key])}: ${outcomes[key]}"></span>` : ''))
    .join('')}${rest ? `<span class="out-track" style="flex:${rest} 1 0" title="Awaiting triage: ${rest}"></span>` : ''}</div>${legend ? `<div class="rp-legend">${Object.entries(OUTCOME_LABELS)
    .map(([key, text]) => `<span><i class="out-${key}"></i>${escapeHtml(text)} <b>${outcomes[key] ?? 0}</b></span>`)
    .join('')}</div>` : ''}`;
}

const trackedById = new Map();
export const rpState = { filter: 'all', search: '', sort: 'open', open: '', tab: 'overview', data: null };

/** Open findings at each reading: awaiting triage, confirmed or new (and not triaged as not exploitable). */
const openSeries = (r) => {
  const points = (r.history ?? []).map((h) => ({ at: h.at, open: (h.awaiting ?? 0) + (h.confirmed ?? 0) + (h.newOpen ?? h.newFindings ?? 0) }));
  if (r.latest && (!points.length || points.at(-1).at !== r.latest.at)) points.push({ at: r.latest.at, open: r.latest.open ?? 0 });
  return points;
};

/** Where a report stands, in one word: tells the team where to look first. */
function reportStatus(r) {
  const l = r.latest;
  if (r.lastError) return { key: 'attention', tone: 'critical', label: 'Update failed', icon: '!' };
  if (r.automation?.lastError) return { key: 'attention', tone: 'critical', label: 'Reminder failed', icon: '!' };
  if (!l) return { key: 'pending', tone: 'neutral', label: 'Not measured yet', icon: '…' };
  // Verified at zero, and kept there: new findings in scope after that are called out at once.
  if (r.verification?.result?.zero && l.open) return { key: 'attention', tone: 'critical', label: `Left zero: ${l.open} open again`, icon: '!' };
  if (r.verification?.result?.zero) return { key: 'complete', tone: 'good', label: `Verified at zero · round ${r.verification.round}`, icon: '✓' };
  if (r.verification && !r.verification.finishedAt && !r.verification.result) return { key: 'scheduled', tone: 'info', label: 'Verifying…', icon: '⟳' };
  if (l.baseline && !l.open) return { key: 'complete', tone: 'good', label: 'Complete', icon: '✓' };
  if (r.automation?.enabled) return { key: 'scheduled', tone: 'info', label: 'On schedule', icon: '⟳' };
  return { key: 'attention', tone: 'warning', label: 'Needs follow-up', icon: '!' };
}

function relativeTime(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  const abs = Math.abs(ms);
  const units = [['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000]];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of units) if (abs >= size || unit === 'minute') return rtf.format(Math.round(ms / size), unit);
  return '';
}

/** A tiny line of open findings over the readings (no axes: the row says the numbers). */
function sparkline(points) {
  if (points.length < 2) return '<span class="rp-spark empty" aria-hidden="true"></span>';
  const w = 96;
  const h = 28;
  const max = Math.max(1, ...points.map((p) => p.open));
  const xy = points.map((p, i) => [(i / (points.length - 1)) * (w - 4) + 2, h - 3 - (p.open / max) * (h - 6)]);
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = xy.at(-1);
  const first = points[0].open;
  const last = points.at(-1).open;
  return `<svg class="rp-spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="Open findings: ${first} to ${last} over ${points.length} readings"><title>Open findings: ${first} → ${last} over ${points.length} readings</title>
    <path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${lx}" cy="${ly}" r="3" fill="currentColor" stroke="var(--surface)" stroke-width="2"/></svg>`;
}

function statusChip(status) {
  return `<span class="rp-chip tone-${status.tone}"><span aria-hidden="true">${status.icon}</span>${escapeHtml(status.label)}</span>`;
}

export function scheduleText(auto, { short = false } = {}) {
  if (!auto?.enabled) return short ? 'Not scheduled' : 'No automatic reminders';
  const every = auto.everyDays === 1 ? 'daily' : `every ${auto.everyDays} days`;
  return short ? `${every[0].toUpperCase()}${every.slice(1)}` : `Every ${auto.everyDays === 1 ? 'day' : `${auto.everyDays} days`} at ${String(auto.hour ?? 9).padStart(2, '0')}:00`;
}

function renderTrackedReports(data) {
  rpState.data = data;
  const { reports, autoRefresh } = data;
  trackedById.clear();
  for (const r of reports) trackedById.set(r.id, r);
  $('reports-meta').textContent = autoRefresh
    ? 'Updates automatically: hourly, and every few minutes after anyone triages or remediates.'
    : 'Automatic updates need a stored Checkmarx One connection (CX_API_KEY, or arm automation in Settings); use Refresh meanwhile.';
  renderPortfolio(reports, data.portfolio);
  renderUpcoming(reports);
  renderReportList();
  if (rpState.open) {
    if (trackedById.has(rpState.open)) renderReportDetail(rpState.open);
    else closeReportDetail();
  }
}

/** What the Dashboard's numbers mean: one definition each, behind a ?. */
const RP_DEFINE = {
  tracked: 'The findings each report held when it was saved (or when its round began), added up over the reports; a finding in two reports counts in both. They are awaiting triage, confirmed or closed: the next three tiles add up to this one. Actioned: confirmed or closed.',
  awaiting: 'Still To verify in Checkmarx One: nobody has triaged them yet.',
  confirmed: 'Triaged as Confirmed or Urgent: real, and still to be fixed.',
  closed: 'Triaged as not exploitable, or no longer reported by Checkmarx One. No longer detected is not proof of a fix: the code may have changed or the project may not have been scanned since. Only a verification rescan proves a fix.',
  fresh: 'First found by Checkmarx One after the report was saved, and matching its filters. Older findings that only now match (for example, ones that aged past 60 days) are not new.',
  followups: 'Reminders a report sends by itself, every few days at a set hour. Open a report, then Remind → Automatic follow-up.',
  credits: 'AI Triage / AI Remediation credits spent on these reports\' projects since each report was saved. A project in two reports is counted once.',
  open: 'Awaiting triage, confirmed, or new since saved: what is still to deal with before the report reaches zero.',
  hero: 'Actioned: confirmed, not exploitable or no longer detected. No longer detected means Checkmarx One no longer reports it, which is not proof of a fix: the code may have changed, or the project may not have been scanned since. Only a verification rescan proves a fix.',
};

/** A watch dial's minute marks: `n` ticks around (cx, cy) at radius r, every fifth one longer. */
export function dialTicks(cx, cy, r, n) {
  let out = '';
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * 2 * Math.PI;
    const long = i % 5 === 0;
    const r1 = r - (long ? 7 : 3.5);
    const c = Math.cos(a);
    const s = Math.sin(a);
    out += `<line class="${long ? 'tick-long' : 'tick'}" x1="${(cx + c * r1).toFixed(2)}" y1="${(cy + s * r1).toFixed(2)}" x2="${(cx + c * r).toFixed(2)}" y2="${(cy + s * r).toFixed(2)}" />`;
  }
  return out;
}

/**
 * The tracked findings as a sunflower (the command-center and Studio looks), after Giorgia Lupi's data
 * humanism: every finding is one seed, laid out on the golden angle the way a sunflower grows. Closed ones
 * sit at the calm grey heart, confirmed ones are solid ink, and those awaiting triage are open rings in the
 * signal colour around the rim; bigger seeds are more severe. As the work is done the heart grows outward.
 */
const SEED_SIZE = { CRITICAL: 1.3, HIGH: 1.05, MEDIUM: 0.82, LOW: 0.64 };
const SEED_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'UNKNOWN', 'INFO'];
const MAX_SEEDS = 1400;

function sunflower(parts) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  const per = Math.max(1, Math.ceil(total / MAX_SEEDS));
  // Seeds from the heart outward: closed, then confirmed, then awaiting triage; within each, mildest first.
  const seeds = [];
  for (const p of ['closed', 'confirmed', 'awaiting'].map((k) => parts.find((x) => x.key === k))) {
    const sev = p.bySeverity ?? {};
    const known = Object.values(sev).reduce((n, v) => n + v, 0);
    const counts = known ? SEED_ORDER.map((s) => [s, sev[s] ?? 0]) : [['MEDIUM', p.value]];
    for (const [severity, count] of counts) for (let i = 0; i < Math.ceil(count / per); i += 1) seeds.push({ key: p.key, severity });
  }
  const n = seeds.length;
  if (!n) return '';
  const R0 = 68;
  const R1 = 146;
  const c = Math.sqrt((R1 * R1 - R0 * R0) / n);
  const i0 = (R0 / c) ** 2;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const base = Math.min(5.2, Math.max(0.9, c * 0.36));
  const out = { closed: [], confirmed: [], awaiting: [] };
  seeds.forEach((seed, i) => {
    const r = c * Math.sqrt(i + i0);
    const a = (i + i0) * golden;
    const x = 150 + r * Math.cos(a);
    const y = 150 + r * Math.sin(a);
    const size = (base * (SEED_SIZE[seed.severity] ?? 0.8)).toFixed(2);
    out[seed.key].push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${size}" />`);
  });
  return `<svg class="seedfield" viewBox="0 0 300 300" role="img" aria-label="${escapeHtml(parts.map((p) => `${p.label}: ${p.value}`).join(', '))}">
    <g class="seeds seeds-closed">${out.closed.join('')}</g>
    <g class="seeds seeds-confirmed">${out.confirmed.join('')}</g>
    <g class="seeds seeds-awaiting">${out.awaiting.join('')}</g>
  </svg>${per > 1 ? `<span class="seed-note">One seed for every ${per} findings</span>` : ''}`;
}

function renderFlow(reports) {
  const box = $('rp-flow');
  const measured = reports.filter((r) => r.latest);
  if (!measured.length) {
    box.hidden = true;
    return;
  }
  const n = (key) => measured.reduce((sum, r) => sum + (r.latest.outcomes?.[key] ?? 0), 0);
  const sev = (...keys) => {
    const out = {};
    for (const r of measured) for (const key of keys) for (const [s, v] of Object.entries(r.latest.bySeverity?.[key] ?? {})) out[s] = (out[s] ?? 0) + v;
    return out;
  };
  const baseline = measured.reduce((sum, r) => sum + (r.latest.baseline ?? 0), 0);
  const actioned = measured.reduce((sum, r) => sum + (r.latest.actioned ?? 0), 0);
  const pct = baseline ? Math.round((actioned / baseline) * 100) : 0;
  const parts = [
    { key: 'awaiting', label: 'Awaiting triage', value: n('awaiting'), sub: 'not triaged yet', bySeverity: sev('awaiting') },
    { key: 'confirmed', label: 'Confirmed', value: n('confirmed'), sub: 'real, fix pending', bySeverity: sev('confirmed') },
    { key: 'closed', label: 'Closed', value: n('notExploitable') + n('resolved'), sub: `${n('notExploitable').toLocaleString()} not exploitable · ${n('resolved').toLocaleString()} no longer detected`, bySeverity: sev('notExploitable', 'resolved') },
  ];
  const ringHelp = helpTip(RP_DEFINE.tracked);
  box.hidden = false;
  box.innerHTML = `<div class="flow-source" style="--pct: ${pct}">
      ${sunflower(parts)}
      <div class="flow-source-text">
        <span class="flow-big">${baseline.toLocaleString()}</span>
        <span class="flow-label">Findings tracked${ringHelp.button}</span>
        <span class="flow-sub">${pct}% actioned</span>
      </div>
    </div>
    <ol class="flow-outcomes">${parts
      .map((p) => {
        const help = helpTip(RP_DEFINE[p.key]);
        return `<li class="flow-outcome flow-${p.key}">
          <svg class="seed-key" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6" /></svg>
          <span class="flow-num">${p.value.toLocaleString()}</span>
          <span class="flow-what"><span class="flow-label">${escapeHtml(p.label)}${help.button}</span><span class="flow-sub">${p.sub}</span>${help.text}</span>
        </li>`;
      })
      .join('')}
      <li class="seed-legend">Each seed is one finding; the bigger it is, the more severe.</li></ol>
    ${ringHelp.text}`;
}

function renderPortfolio(reports, portfolio = {}) {
  renderFlow(reports);
  const measured = reports.filter((r) => r.latest);
  const sum = (fn) => measured.reduce((n, r) => n + (fn(r) || 0), 0);
  const baseline = sum((r) => r.latest.baseline);
  const actioned = sum((r) => r.latest.actioned);
  const pct = baseline ? Math.round((actioned / baseline) * 100) : 0;
  const scheduled = reports.filter((r) => r.automation?.enabled);
  const next = scheduled.map((r) => r.automation.nextRunAt).filter(Boolean).sort()[0];
  const tile = (key, label, value, sub, extra = '') => {
    const help = helpTip(RP_DEFINE[key]);
    return `<div class="rp-tile rp-${key}"><span class="rp-tile-label">${escapeHtml(label)}${help.button}</span><span class="rp-tile-value">${value}</span>${extra}<span class="rp-tile-sub">${sub}</span>${help.text}</div>`;
  };
  const n = (key) => sum((r) => r.latest.outcomes?.[key]);
  // Credits counted once per project (from the server); an older server: each report's own figure.
  const credits = portfolio.aiActions ?? { triage: sum((r) => r.latest.aiActions?.triage), remediation: sum((r) => r.latest.aiActions?.remediation) };
  const pending = reports.length - measured.length;
  $('rp-portfolio').innerHTML = !reports.length
    ? ''
    : [
        // The first four add up: tracked = awaiting triage + confirmed + closed.
        tile('tracked', 'Findings tracked', baseline.toLocaleString(), `${pct}% actioned · in ${measured.length} report${measured.length === 1 ? '' : 's'}${pending ? ` (${pending} not measured yet)` : ''}`, `<span class="rp-meter" role="img" aria-label="${pct}% actioned"><span style="width:${pct}%"></span></span>`),
        tile('awaiting', 'Awaiting triage', n('awaiting').toLocaleString(), 'not triaged yet'),
        tile('confirmed', 'Confirmed', n('confirmed').toLocaleString(), 'real, fix pending'),
        tile('closed', 'Closed', (n('notExploitable') + n('resolved')).toLocaleString(), `${n('notExploitable').toLocaleString()} not exploitable · ${n('resolved').toLocaleString()} no longer detected`),
        tile('fresh', 'New since saved', sum((r) => r.latest.newFindings).toLocaleString(), 'first found after saving'),
        tile('followups', 'Follow-ups scheduled', `${scheduled.length}<small> of ${reports.length}</small>`, next ? `next ${escapeHtml(serverTime(next))}` : 'none due'),
        tile('credits', 'AI credits used', `${(credits.triage ?? 0).toLocaleString()}<small> / ${(credits.remediation ?? 0).toLocaleString()}</small>`, 'triage / remediation'),
      ].join('');
}

function renderUpcoming(reports) {
  const due = reports
    .filter((r) => r.automation?.enabled && r.automation.nextRunAt)
    .sort((a, b) => Date.parse(a.automation.nextRunAt) - Date.parse(b.automation.nextRunAt));
  const to = (a) => (a.onlyTo?.length ? `only ${a.onlyTo.join(', ')}` : { developers: 'each developer', list: 'the fixed list', both: 'developers and list' }[a.sendTo] ?? AUDIENCE_TEXT[audience()].toLowerCase());
  $('rp-upcoming').innerHTML = due.length
    ? due
        .map((r) => {
          const at = new Date(r.automation.nextRunAt);
          const day = at.toLocaleDateString(undefined, { day: 'numeric', ...(serverZone.name ? { timeZone: serverZone.name } : {}) });
          const month = at.toLocaleDateString(undefined, { month: 'short', ...(serverZone.name ? { timeZone: serverZone.name } : {}) });
          return `<li><button type="button" class="rp-agenda-item" data-open-report="${escapeHtml(r.id)}" data-tab="remind">
            <span class="rp-date"><b>${escapeHtml(day)}</b>${escapeHtml(month)}</span>
            <span class="rp-agenda-text"><span class="rp-name">${escapeHtml(r.name)}</span>
              <span class="rp-sub">${escapeHtml(relativeTime(r.automation.nextRunAt))} · ${escapeHtml(scheduleText(r.automation, { short: true }).toLowerCase())} · to ${escapeHtml(to(r.automation))}${r.automation.attachHtml ? ' · HTML report' : ''}</span></span>
          </button></li>`;
        })
        .join('')
    : `<li class="rp-empty-small">Nothing scheduled. Open a report, then <strong>Remind → Automatic follow-up</strong>, to send its follow-ups by themselves.</li>`;
}

function renderReportList() {
  const reports = rpState.data?.reports ?? [];
  const counts = { all: reports.length, attention: 0, scheduled: 0, complete: 0 };
  for (const r of reports) {
    const key = reportStatus(r).key;
    if (key in counts && key !== 'all') counts[key] += 1;
  }
  for (const [key, n] of Object.entries(counts)) {
    const el = document.querySelector(`[data-count="${key}"]`);
    if (el) el.textContent = n;
  }
  if (!reports.length) {
    $('reports-list').innerHTML = `<div class="rp-empty">
      <h3>No tracked reports yet</h3>
      <p>Choose a scope on the Workbench (projects, people, time windows), fetch, then <strong>Save as tracked report</strong>.
        Each report keeps the findings it covered and follows what happens to them: triaged, confirmed, not exploitable or no longer detected.</p>
      <a class="button primary" href="#/dashboard">Go to the Workbench</a></div>`;
    return;
  }
  const term = rpState.search.trim().toLowerCase();
  const shown = reports
    .filter((r) => rpState.filter === 'all' || reportStatus(r).key === rpState.filter)
    .filter((r) => !term || `${r.name} ${r.scopeLabel ?? ''}`.toLowerCase().includes(term))
    .sort((a, b) => {
      if (rpState.sort === 'name') return a.name.localeCompare(b.name);
      if (rpState.sort === 'updated') return Date.parse(b.latest?.at ?? 0) - Date.parse(a.latest?.at ?? 0);
      if (rpState.sort === 'progress') return (a.latest?.percentActioned ?? 0) - (b.latest?.percentActioned ?? 0);
      return (b.latest?.open ?? 0) - (a.latest?.open ?? 0);
    });
  $('reports-list').innerHTML = shown.length
    ? `<div class="rp-head" aria-hidden="true"><span>Report</span><span>Progress</span><span class="num" title="${escapeHtml(RP_DEFINE.open)}">Open</span><span class="num" title="${escapeHtml(RP_DEFINE.fresh)}">New</span><span>Trend</span><span>Status</span></div>${shown
        .map((r) => {
          const l = r.latest;
          const status = reportStatus(r);
          const projects = r.projects?.length ?? l?.byProject?.length ?? 0;
          return `<button type="button" class="rp-row${rpState.open === r.id ? ' active' : ''}" data-open-report="${escapeHtml(r.id)}">
            <span class="rp-cell rp-title"><span class="rp-name">${escapeHtml(r.name)}</span>
              <span class="rp-sub">${projects ? `${projects} project${projects === 1 ? '' : 's'} · ` : ''}${l ? `updated ${escapeHtml(relativeTime(l.at))}` : 'not measured yet'}</span></span>
            <span class="rp-cell rp-progress">${l ? progressBar(l.outcomes, l.baseline, { legend: false }) : ''}<span class="rp-pct">${l ? `${l.percentActioned}% actioned` : '—'}</span></span>
            <span class="rp-cell num" data-label="Open"><b>${l?.open ?? '—'}</b></span>
            <span class="rp-cell num" data-label="New"><b class="${l?.newFindings ? 'up' : ''}">${l ? (l.newFindings ? `+${l.newFindings}` : '0') : '—'}</b></span>
            <span class="rp-cell rp-trend">${sparkline(openSeries(r))}</span>
            <span class="rp-cell rp-status">${statusChip(status)}<span class="rp-sched${r.automation?.enabled ? ' on' : ''}">${escapeHtml(scheduleText(r.automation, { short: true }))}</span></span>
          </button>`;
        })
        .join('')}`
    : '<p class="rp-empty-small">No report matches. Clear the search or pick another filter.</p>';
}

/** Open findings over the readings, with a crosshair and the values on hover. */
function trendChart(points) {
  if (points.length < 2) return '<p class="hint">The trend appears after the second reading (hourly, or Refresh).</p>';
  const w = 640;
  const h = 170;
  const pad = { l: 8, r: 8, t: 12, b: 8 };
  const max = Math.max(1, ...points.map((p) => p.open));
  const x = (i) => pad.l + (i / (points.length - 1)) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / max) * (h - pad.t - pad.b);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.open).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${h - pad.b} L${x(0).toFixed(1)},${h - pad.b} Z`;
  const fmt = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `<figure class="rp-trend-chart" data-points='${escapeHtml(JSON.stringify(points.map((p, i) => ({ x: x(i) / w, y: y(p.open) / h, open: p.open, at: fmt(p.at) }))))}'>
    <figcaption><span>Open findings</span><span class="rp-sub">${points[0].open} → ${points.at(-1).open} over ${points.length} readings</span></figcaption>
    <div class="rp-plot">
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Open findings from ${points[0].open} to ${points.at(-1).open}">
        <line x1="${pad.l}" x2="${w - pad.r}" y1="${y(max)}" y2="${y(max)}" class="grid"/>
        <line x1="${pad.l}" x2="${w - pad.r}" y1="${y(max / 2)}" y2="${y(max / 2)}" class="grid"/>
        <line x1="${pad.l}" x2="${w - pad.r}" y1="${h - pad.b}" y2="${h - pad.b}" class="axis"/>
        <path d="${area}" class="area"/>
        <path d="${line}" class="line" vector-effect="non-scaling-stroke"/>
      </svg>
      <span class="rp-y rp-y-max">${max}</span><span class="rp-y rp-y-mid">${Math.round(max / 2)}</span>
      <span class="rp-cross" hidden></span><span class="rp-dot" hidden></span><span class="rp-tip" hidden></span>
    </div>
    <div class="rp-x"><span>${escapeHtml(fmt(points[0].at))}</span><span>${escapeHtml(fmt(points.at(-1).at))}</span></div>
  </figure>`;
}

function bindTrendChart(root) {
  const fig = root.querySelector('.rp-trend-chart');
  if (!fig) return;
  const points = JSON.parse(fig.dataset.points);
  const plot = fig.querySelector('.rp-plot');
  const [cross, dot, tip] = ['.rp-cross', '.rp-dot', '.rp-tip'].map((sel) => plot.querySelector(sel));
  const show = (clientX) => {
    const box = plot.getBoundingClientRect();
    const rel = (clientX - box.left) / box.width;
    const p = points.reduce((best, q) => (Math.abs(q.x - rel) < Math.abs(best.x - rel) ? q : best), points[0]);
    for (const el of [cross, dot, tip]) el.hidden = false;
    cross.style.left = `${p.x * 100}%`;
    dot.style.left = `${p.x * 100}%`;
    dot.style.top = `${p.y * 100}%`;
    tip.innerHTML = `<b>${p.open}</b> open<br><span>${escapeHtml(p.at)}</span>`;
    tip.style.left = `${Math.min(Math.max(p.x * 100, 12), 88)}%`;
  };
  plot.addEventListener('pointermove', (event) => show(event.clientX));
  plot.addEventListener('pointerleave', () => {
    for (const el of [cross, dot, tip]) el.hidden = true;
  });
}

const RP_TABS = [
  ['overview', 'Overview'],
  ['remind', 'Remind'],
  ['triage', 'Triage'],
  ['verify', 'Verify'],
  ['history', 'History'],
];

function openReportDetail(id, tab = 'overview') {
  rpState.open = id;
  // Schedule is part of Remind now (one place for who, what and when).
  rpState.tab = tab === 'schedule' ? 'remind' : tab;
  $('rp-sheet').innerHTML = '';
  renderReportDetail(id);
  $('rp-drawer').hidden = false;
  document.body.classList.add('rp-locked');
  renderReportList();
  $('rp-sheet').querySelector('.rp-tabs [aria-selected="true"]')?.focus();
}

function closeReportDetail() {
  const id = rpState.open;
  rpState.open = '';
  $('rp-drawer').hidden = true;
  document.body.classList.remove('rp-locked');
  renderReportList();
  document.querySelector(`.rp-row[data-open-report="${CSS.escape(id)}"]`)?.focus();
}

function renderReportDetail(id) {
  const r = trackedById.get(id);
  if (!r) return;
  const kept = captureReportsState();
  const sheet = $('rp-sheet');
  const scroll = sheet.querySelector('.rp-body')?.scrollTop ?? 0;
  const l = r.latest;
  const status = reportStatus(r);
  const rid = escapeHtml(r.id);
  const tabs = RP_TABS.map(([key, label]) => `<button type="button" role="tab" id="rp-tab-${key}" aria-controls="rp-panel-${key}" aria-selected="${rpState.tab === key}" tabindex="${rpState.tab === key ? 0 : -1}" data-rp-tab="${key}">${label}${(key === 'remind' && r.automation?.enabled) || (key === 'verify' && r.verify?.auto) ? ' <i class="rp-on" aria-label="on"></i>' : ''}${key === 'verify' && r.verification?.result?.zero ? ' ✓' : ''}</button>`).join('');
  const panel = (key, html) => `<div class="rp-panel" role="tabpanel" id="rp-panel-${key}" aria-labelledby="rp-tab-${key}" ${rpState.tab === key ? '' : 'hidden'}>${html}</div>`;
  const kpi = (label, value, sub = '', define = '') => {
    const help = define ? helpTip(define) : { button: '', text: '' };
    return `<div class="rp-kpi"><span class="rp-tile-label">${escapeHtml(label)}${help.button}</span><span class="rp-kpi-value">${value}</span>${sub ? `<span class="rp-tile-sub">${sub}</span>` : ''}${help.text}</div>`;
  };
  const heroHelp = helpTip(RP_DEFINE.hero);
  const overview = l
    ? `<div class="rp-hero">
        <div class="rp-hero-number"><span class="rp-big">${l.percentActioned}%</span><span class="rp-sub">actioned · ${l.actioned} of ${l.baseline} findings confirmed, not exploitable or no longer detected ${heroHelp.button}</span></div>
        ${heroHelp.text}
        ${progressBar(l.outcomes, l.baseline)}
      </div>
      <div class="rp-kpis">
        ${kpi('Open now', l.open ?? 0, 'awaiting, confirmed or new', RP_DEFINE.open)}
        ${kpi('New since saved', l.newFindings, 'first found after saving', RP_DEFINE.fresh)}
        ${kpi('Matching now', l.currentMatching, `was ${l.baseline} when saved`, 'Every finding the report\'s filters match today, old or new, whatever its state.')}
        ${kpi('AI credits used', `${l.aiActions.triage} <small>/ ${l.aiActions.remediation}</small>`, 'triage / remediation', 'AI Triage / AI Remediation credits spent on this report\'s projects since it was saved.')}
      </div>
      ${trendChart(openSeries(r))}
      ${l.byProject?.length ? `<h3 class="rp-h3">By project</h3><div class="table-wrap"><table class="data-table rp-table">
        <thead><tr><th>Project</th><th>Progress</th><th class="num">Open</th><th class="num">Confirmed</th><th class="num">New</th><th class="num">Now</th></tr></thead>
        <tbody>${l.byProject
          .slice()
          .sort((a, b) => b.awaiting + b.confirmed + (b.newOpen ?? b.newFindings) - (a.awaiting + a.confirmed + (a.newOpen ?? a.newFindings)))
          .map((p) => `<tr><td>${escapeHtml(p.projectName || p.projectId)}</td>
            <td class="rp-mini">${progressBar({ resolved: p.resolved, notExploitable: p.notExploitable, confirmed: p.confirmed, awaiting: p.awaiting }, p.baseline, { legend: false })}</td>
            <td class="num">${p.awaiting + p.confirmed + (p.newOpen ?? p.newFindings)}</td><td class="num">${p.confirmed}</td><td class="num">${p.newFindings}</td><td class="num">${p.currentMatching}</td></tr>`)
          .join('')}</tbody></table></div>` : ''}`
    : '<p class="hint">Not measured yet: Refresh reads Checkmarx One now.</p>';
  const history = r.history?.length
    ? `<div class="table-wrap"><table class="data-table rp-table">
        <thead><tr><th>Reading</th><th class="num">Awaiting</th><th class="num">Confirmed</th><th class="num">Not exploitable</th><th class="num">No longer detected</th><th class="num">New</th><th class="num">Matching now</th></tr></thead>
        <tbody>${r.history
          .slice()
          .reverse()
          .map((h) => `<tr><td>${escapeHtml(new Date(h.at).toLocaleString())}</td><td class="num">${h.awaiting}</td><td class="num">${h.confirmed}</td><td class="num">${h.notExploitable}</td><td class="num">${h.resolved}</td><td class="num">${h.newFindings}</td><td class="num">${h.currentMatching}</td></tr>`)
          .join('')}</tbody></table></div>`
    : '<p class="hint">No readings yet.</p>';
  sheet.innerHTML = `<article class="rp-detail" data-report="${rid}">
    <header class="rp-d-head">
      <div class="rp-d-title">
        <span class="rp-eyebrow">Tracked report ${statusChip(status)}</span>
        <h2 id="rp-d-title">${escapeHtml(r.name)}</h2>
        <p class="rp-sub">${escapeHtml(r.scopeLabel || '')}</p>
        <p class="rp-sub">Saved ${escapeHtml(new Date(r.createdAt).toLocaleDateString())} · ${l ? `updated ${escapeHtml(relativeTime(l.at))}` : 'not updated yet'}${r.lastError ? ` · <span class="status error">last update failed: ${escapeHtml(r.lastError)}</span>` : ''}</p>
      </div>
      <div class="rp-d-actions">
        <button type="button" data-report-refresh="${rid}">Refresh</button>
        <button type="button" data-report-html="${rid}">Download HTML</button>
        ${can('reports.delete') ? `<button type="button" class="link danger" data-report-delete="${rid}">Delete</button>` : ''}
        <button type="button" class="ghost rp-close" data-rp-close aria-label="Close">✕</button>
      </div>
    </header>
    <nav class="rp-tabs" role="tablist" aria-label="Report sections">${tabs}</nav>
    <div class="rp-body">
      ${panel('overview', overview)}
      ${panel('remind', `${remindSection(r)}<h3 class="rp-h3">Automatic follow-up</h3>${scheduleSection(r)}`)}
      ${panel('triage', triageSection(r))}
      ${panel('verify', verifySection(r))}
      ${panel('history', history)}
      <p class="status" data-follow-status="${rid}"></p>
    </div>
  </article>`;
  restoreReportsState(kept);
  const card = sheet.querySelector('[data-report]');
  syncSendTo(card);
  updateNeed(card);
  bindTrendChart(sheet);
  sheet.querySelector('.rp-body').scrollTop = scroll;
}

const radioFor = (id) => (name, value, label, current) =>
  `<label class="check"><input type="radio" name="${name}-${id}" value="${value}" data-keep ${current === value ? 'checked' : ''} /> ${label}</label>`;

/** Who gets a reminder, and what: used by "Send now" and by the schedule. */
function remindSection(r) {
  const id = escapeHtml(r.id);
  const auto = r.automation ?? {};
  const radio = radioFor(id);
  const onlyTo = auto.onlyTo?.length ? auto.onlyTo.join(', ') : '';
  // 'initiator' was the default every report was saved with: it follows the shared choice too.
  const sendTo = onlyTo ? 'only' : ({ initiator: 'settings', settings: 'settings' }[auto.sendTo] ?? auto.sendTo ?? 'settings');
  const own = sendTo !== 'settings';
  const open = r.latest?.open ?? 0;
  const reminders = (r.reminders ?? []).slice(0, 10);
  return `<p class="rp-lead">${open} open finding${open === 1 ? '' : 's'} (awaiting triage, confirmed or new). Remind the people who can act on them.</p>
    <div class="rp-form">
      <div class="rp-field"><span class="rp-label">Send to</span><div class="rp-options">
        ${radio('sendTo', 'settings', `Who gets reminders everywhere: ${escapeHtml(AUDIENCE_TEXT[audience()].toLowerCase())}`, sendTo)}
        <details class="rp-own"${own ? ' open' : ''}><summary>Only for this report…</summary>
          ${radio('sendTo', 'developers', 'Each developer', sendTo)}
          ${radio('sendTo', 'list', 'The fixed list', sendTo)}
          ${radio('sendTo', 'both', 'Both', sendTo)}
          ${radio('sendTo', 'only', 'Only to', sendTo)}
          <input type="text" class="only-to" data-field="onlyTo" data-keep value="${escapeHtml(onlyTo)}" placeholder="name@company.com, …" aria-label="Send only to these addresses" />
        </details>
      </div></div>
      <div class="rp-field" data-content-row><span class="rp-label">Content</span><div class="rp-options">
        ${radio('content', 'summary', 'One summary per person', auto.emailContent ?? 'summary')}
        ${radio('content', 'per-project', 'One email per project', auto.emailContent)}
      </div></div>
      <div class="rp-field"><span class="rp-label">Attachment</span><div class="rp-options">
        <label class="check"><input type="checkbox" data-field="attachHtml" data-keep ${auto.attachHtml ? 'checked' : ''} /> Interactive HTML report (triage and remediate from it)</label>
      </div></div>
    </div>
    <div class="actions compact">
      ${can('reports.remind') ? `<button type="button" data-remind="${id}" data-dry="1">Preview</button><button type="button" data-remind="${id}" class="primary">Send reminder now</button>` : '<span class="hint">Your role cannot send reminders.</span>'}
    </div>
    <p class="hint">The automatic follow-up below uses the same choices.</p>
    ${reminders.length ? `<h3 class="rp-h3">Sent</h3>${remindersTable(reminders)}` : ''}`;
}

function remindersTable(reminders) {
  return `<div class="table-wrap"><table class="data-table rp-table">
    <thead><tr><th>Sent</th><th>To</th><th class="num">Open</th><th class="num">Emails</th><th>Result</th></tr></thead>
    <tbody>${reminders
      .map((m) => `<tr><td>${escapeHtml(new Date(m.at).toLocaleString())}${m.automatic ? ' <span class="rp-tag">automatic</span>' : ''}</td>
        <td>${m.sendTo === 'only' ? `Only ${escapeHtml((m.onlyTo ?? []).join(', '))}` : escapeHtml({ initiator: 'Each developer', list: 'Fixed list', both: 'Developers + list' }[m.sendTo] ?? m.sendTo)}${m.attachHtml ? ' · HTML' : ''}</td>
        <td class="num">${m.openFindings}</td><td class="num">${m.sent}</td>
        <td>${m.error ? `<span class="status error">${escapeHtml(m.error)}</span>` : 'Sent'}</td></tr>`)
      .join('')}</tbody></table></div>`;
}

function scheduleSection(r) {
  const id = escapeHtml(r.id);
  const auto = r.automation ?? {};
  const manage = can('reports.manage');
  const reminders = (r.reminders ?? []).filter((m) => m.automatic).slice(0, 10);
  return `<div class="rp-schedule-state ${auto.enabled ? 'on' : ''}">
      <span class="rp-big-icon" aria-hidden="true">${auto.enabled ? '⟳' : '○'}</span>
      <div><strong>${escapeHtml(scheduleText(auto))}${auto.enabled ? ` ${escapeHtml(zoneLabel())}` : ''}</strong>
        <span class="rp-sub">${auto.enabled && auto.nextRunAt ? `Next ${escapeHtml(serverTime(auto.nextRunAt))} (${escapeHtml(relativeTime(auto.nextRunAt))})` : 'Turn it on to follow up without anyone remembering to.'}${auto.lastRunAt ? ` · last ${escapeHtml(serverTime(auto.lastRunAt))}` : ''}</span>
        ${auto.lastError ? `<span class="status error">${escapeHtml(auto.lastError)}</span>` : ''}</div>
    </div>
    <div class="rp-form"${manage ? '' : ' hidden'}>
      <div class="rp-field"><span class="rp-label">Automatic reminders</span><div class="rp-options">
        <label class="switch"><input type="checkbox" data-field="autoEnabled" data-keep ${auto.enabled ? 'checked' : ''} /> <span><strong>On</strong><small>Only while something is still open</small></span></label>
      </div></div>
      <div class="rp-field"><span class="rp-label">Every</span><div class="rp-options">
        <input type="number" min="1" max="90" data-field="everyDays" data-keep value="${auto.everyDays ?? 7}" class="small-num" aria-label="Every how many days" /> days at
        <input type="number" min="0" max="23" data-field="hour" data-keep value="${auto.hour ?? 9}" class="small-num" aria-label="Hour" />:00
        <span class="hint" title="Time zone of the machine running ${escapeHtml(state.health?.app?.name || 'CxMissionZero')}">${escapeHtml(zoneLabel())}</span>
      </div></div>
    </div>
    <p class="hint">Sends to the people, and with the content, chosen above. Every automatic reminder and follow-up is also listed under <a href="#/automation">Act → Automation</a>.</p>
    ${manage ? `<div class="actions compact"><button type="button" class="primary" data-schedule="${id}">Save schedule</button></div>` : '<p class="hint">Your role cannot change schedules.</p>'}
    ${reminders.length ? `<h3 class="rp-h3">Sent automatically</h3>${remindersTable(reminders)}` : ''}`;
}

/** Each tracked report's credit tiers, for triage and remediation (credits by severity). */
function reportTiers(r) {
  const triageBy = Object.fromEntries(SEVERITIES_ALL.map((s) => [s, r.latest?.toTriageResults?.[s] ?? r.latest?.toTriage?.[s] ?? 0]));
  const remediationBy = Object.fromEntries(SEVERITIES_ALL.map((s) => [s, 3 * (r.latest?.toRemediate?.[s] ?? 0)]));
  return {
    triage: creditTiers(triageBy, r.credits?.triage?.remaining ?? 0),
    remediation: creditTiers(remediationBy, r.credits?.remediation?.remaining ?? 0),
  };
}

/**
 * One row per kind of credit: what is needed and left, then "Allocate for <next tier>" and
 * "<Triage|Remediate> <widest tier the credits cover>", gold. One button each, chosen from
 * the findings' severities and the credits given, so the next step is always plain.
 */
export function creditLane(id, kind, t, { allocate, run }, prefix = 'report') {
  const verb = kind === 'triage' ? 'Triage' : 'Remediate';
  const title = kind === 'triage' ? 'AI Triage' : 'AI Remediation';
  const unit = kind === 'triage' ? 'to triage' : 'to remediate';
  const figures = t.total
    ? `<span><b>${fmt(t.total)}</b> credits needed ${unit}</span> · <span><b>${fmt(t.left)}</b> left</span>`
    : `<span>${kind === 'triage' ? 'Nothing awaiting triage.' : 'Nothing confirmed to remediate yet: AI Triage confirms findings first.'}</span>`;
  const sev = (tier) => escapeHtml(tier.severities.join(','));
  const give = allocate && t.next
    ? `<button type="button" data-${prefix}-allocate="${id}" data-kind="${kind}" data-severities="${sev(t.next)}" data-needs-data title="${escapeHtml(`About ${fmt(t.next.need - t.left)} more credits, confirmed with Checkmarx One as they are given`)}">Allocate for ${t.next.name}</button>`
    : '<span class="lane-slot"></span>';
  const act = !run || !t.total
    ? '<span class="lane-slot"></span>'
    : t.covered
      ? `<button type="button" data-${prefix}-${kind === 'triage' ? 'triage' : 'remediate'}="${id}" data-severities="${sev(t.covered)}" class="primary is-golden" data-needs-data>${verb} ${t.covered.name}</button>`
      : `<button type="button" class="primary" disabled title="Allocate credits first">${verb} ${t.next.name}</button>`;
  return `<div class="credit-lane" data-lane="${kind}">
      <div class="lane-head"><strong>${title}</strong><span class="lane-figures">${figures}</span></div>
      <div class="lane-actions">${give}${act}</div>
    </div>`;
}

/** Per severity: what awaits triage and what is confirmed to remediate, behind the rows' tiers. */
function severityBreakdown(r) {
  const line = (label, by) => {
    // Each piece in its own span, so each is translated on its own.
    const parts = SEVERITIES_ALL.filter((s) => by?.[s]).map((s) => `<span>${SEV_NAMES[s]} ${fmt(by[s])}</span>`);
    return parts.length ? `<span>${label}:</span> ${parts.join(' · ')}` : '';
  };
  const triage = Object.fromEntries(SEVERITIES_ALL.map((s) => [s, r.latest?.toTriageResults?.[s] ?? r.latest?.toTriage?.[s] ?? 0]));
  return [line('Results awaiting triage', triage), line('Confirmed to remediate', r.latest?.toRemediate)].filter(Boolean).join('<br />');
}

function triageSection(r) {
  const id = escapeHtml(r.id);
  const allowed = can('triage.run') || can('credits.allocate');
  if (!allowed) return '<p class="hint">Your role cannot run AI Triage or allocate credits.</p>';
  const tiers = reportTiers(r);
  const ways = { allocate: can('credits.allocate'), run: can('triage.run') };
  return `<p class="rp-lead">Each row offers one step: allocate the credits for the next severities, then run AI on everything the credits cover, critical first. The button turns gold when the credits are there.</p>
    <div class="credit-lanes" data-lanes="${id}">${creditLane(id, 'triage', tiers.triage, ways)}${creditLane(id, 'remediation', tiers.remediation, ways)}</div>
    <p class="rp-need" data-need="${id}">${severityBreakdown(r)}</p>
    ${ways.allocate ? `<details class="disclosure alloc-more"><summary>Extra credits</summary>
      <div class="rp-options alloc-extra">
        <label class="inline">Triage <input type="number" min="0" max="100000" data-field="triageAdd" data-keep class="small-num" placeholder="0" aria-label="Extra triage credits" /></label>
        <label class="inline">Remediation <input type="number" min="0" max="100000" step="3" data-field="remediationAdd" data-keep class="small-num" placeholder="0" aria-label="Extra remediation credits" /></label>
        <button type="button" data-report-allocate="${id}" data-kind="extra" data-needs-data>Add extra credits</button>
      </div></details>` : ''}
    <p class="hint">1 credit to check a finding with AI, 3 to fix it. Nothing is given until you click.</p>`;
}

const SEV_NAMES = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };
const sevList = (list) => (list?.length ? list.map((s) => SEV_NAMES[s] ?? s).join(', ') : 'every severity');
const VERIFY_STATUS = {
  Queued: ['Queued in Checkmarx One', 'info'],
  Running: ['Scanning…', 'info'],
  Completed: ['Scanned', 'good'],
  Partial: ['Scanned (partly)', 'warning'],
  Failed: ['Scan failed', 'critical'],
  Canceled: ['Scan cancelled', 'critical'],
  waiting: ['Waiting for its next scan', 'neutral'],
};

/** Verify: prove the round's fixes with a Checkmarx One rescan, then start the next round. */
function verifySection(r) {
  const id = escapeHtml(r.id);
  const round = r.round ?? 1;
  const c = r.latest?.closure;
  const v = r.verification;
  const manage = can('reports.manage');
  const scanning = v && !v.finishedAt && v.projects.some((p) => p.status !== 'waiting' && !['Completed', 'Partial', 'Failed', 'Canceled'].includes(p.status));
  const closure = c
    ? `<div class="vf-closure ${c.closed ? 'is-closed' : ''}">
        <span class="vf-badge">${c.closed ? '✓ Ready to verify' : `${c.open} still open`}</span>
        <span title="${escapeHtml(`${c.gone} no longer found, ${c.notExploitable} not exploitable, ${c.remediated} sent for an AI fix${c.open ? `; still open: ${c.awaiting} not checked yet, ${c.confirmedNotRemediated} confirmed but not fixed` : ''}`)}">${c.inScope - c.open} of ${c.inScope} dealt with${c.open ? `: ${c.awaiting ? `${c.awaiting} to check` : ''}${c.awaiting && c.confirmedNotRemediated ? ', ' : ''}${c.confirmedNotRemediated ? `${c.confirmedNotRemediated} to fix` : ''}` : ''}.</span>
      </div>`
    : '<p class="hint">Refresh to see where this round stands.</p>';
  // The developers' turn to rescan (the round's scope is closed, nobody rescanned yet).
  const w = r.verifyWindow && r.verifyWindow.round === round ? r.verifyWindow : null;
  const windowHtml = w && !(v && v.round === round)
    ? `<div class="vf-window">
        <span class="vf-badge">⟳ Developers' turn</span>
        <span>${w.developers?.length ? `${escapeHtml(w.developers.map((d) => d.name || d.email).join(', '))} ${w.developers.length === 1 ? 'has' : 'have'}` : 'The developers have'} until <b>${escapeHtml(new Date(w.dueAt).toLocaleString())}</b> to rescan from their report or the emailed link${r.verify?.auto ? '. After that it is rescanned on their behalf, and they are told.' : '. Automatic rescan is off: after that, rescan here.'}${w.notified?.ready ? '' : ' Email is not set up, so they were not told: send them their links.'}</span>
        ${can('reports.manage') ? `<button type="button" class="link" data-rescan-links="${id}">Their rescan links</button>` : ''}
        <div class="vf-links" data-rescan-links-out="${id}" hidden></div>
      </div>`
    : '';
  const result = v?.result;
  const tile = (label, value, sub, tone = '') => `<div class="rp-kpi ${tone}"><span class="rp-tile-label">${escapeHtml(label)}</span><span class="rp-kpi-value">${value}</span><span class="rp-tile-sub">${escapeHtml(sub)}</span></div>`;
  const resultHtml = result
    ? `${result.zero ? `<p class="vf-zero">✓ Mission Zero for this scope: everything in round ${v.round} is verified fixed by a rescan.</p>` : ''}
      <div class="rp-kpis">
        ${tile('Verified fixed', result.fixed, 'gone after the rescan', 'tone-good')}
        ${tile('Still found', result.stillFound.length, result.ineffective ? `${result.ineffective} after AI Remediation: the fix did not work` : 'still reported by Checkmarx One', result.stillFound.length ? 'tone-critical' : '')}
        ${tile('Accepted', result.accepted, 'triaged not exploitable')}
        ${tile('New in scope', result.newInScope, 'found since the round started', result.newInScope ? 'tone-warning' : '')}
      </div>
      ${result.notChecked ? `<p class="hint">${result.notChecked} finding(s) in projects still waiting for a scan are not checked yet.</p>` : ''}
      ${result.stillFound.length ? `<details class="vf-still"><summary>Still found (${result.stillFound.length})</summary><ul>${result.stillFound
        .slice(0, 50)
        .map((f) => `<li><b>${escapeHtml(SEV_NAMES[f.severity] ?? f.severity)}</b> ${escapeHtml(f.title)} <span class="hint">· ${escapeHtml(f.projectName)}${f.remediated ? ' · remediated, still found' : ''}</span></li>`)
        .join('')}</ul></details>` : ''}`
    : '';
  const scans = v
    ? `<h3 class="rp-h3">Verification ${v.automatic ? '(started automatically)' : ''} · ${escapeHtml(new Date(v.requestedAt).toLocaleString())}</h3>
      <div class="table-wrap"><table class="data-table rp-table"><thead><tr><th>Project</th><th>Rescan</th><th>Branch</th></tr></thead><tbody>${v.projects
        .map((p) => {
          const [label, tone] = VERIFY_STATUS[p.status] ?? [p.status, 'neutral'];
          return `<tr><td>${escapeHtml(p.projectName || p.projectId)}</td><td><span class="rp-chip tone-${tone}">${escapeHtml(label)}</span>${p.fromElsewhere ? ' <span class="hint">(a scan from elsewhere)</span>' : ''}${p.error ? `<div class="hint vf-why">${escapeHtml(p.error)}</div>` : ''}</td><td>${escapeHtml(p.branch ?? '')}</td></tr>`;
        })
        .join('')}</tbody></table></div>
      ${resultHtml}`
    : '';
  const nextSevs = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].filter((s) => !(r.filters?.severities ?? []).includes(s));
  const controls = manage
    ? `<div class="actions compact">
        <button type="button" class="${c?.closed && !scanning ? 'primary' : ''}" data-report-verify="${id}" ${scanning ? 'disabled' : ''}>${scanning ? 'Rescanning…' : 'Rescan now to verify'}</button>
        <label class="check"><input type="checkbox" data-verify-auto="${id}" ${r.verify?.auto ? 'checked' : ''} /> If the developers have not rescanned within</label>
        <label class="inline"><input type="number" class="small-num" min="24" max="336" step="12" data-verify-grace="${id}" value="${escapeHtml(String(r.verify?.graceHours ?? 48))}" /> hours, rescan on their behalf</label>
      </div>
      <p class="hint">When everything is dealt with, the developers get the Rescan button first. If they don't use it in time, it is rescanned for them.</p>
      <details class="disclosure" data-advanced><summary>How the rescan works</summary><p class="hint">Each project is scanned again like its last scan: same repository, branch and engines. Code uploaded from a pipeline is checked by its next scan instead. A fix made outside CxMissionZero counts once the rescan no longer finds it.</p></details>`
    : '<p class="hint">Your role can follow verification; rescans and new rounds need “Manage tracked reports”.</p>';
  const nextRound = manage
    ? `<h3 class="rp-h3">Next round</h3>
      <p class="hint">Next target, for example medium and low once critical and high are at zero. This round is kept below.</p>
      <div class="rp-options">${['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
        .map((s) => `<label class="check"><input type="checkbox" data-next-sev="${s}" data-field="next-${s}" data-keep ${nextSevs.includes(s) ? 'checked' : ''} /> ${SEV_NAMES[s]}</label>`)
        .join('')}</div>
      <div class="actions compact"><button type="button" data-next-round="${id}" ${scanning ? 'disabled' : ''}>Start round ${round + 1}</button></div>`
    : '';
  const rounds = r.rounds?.length
    ? `<h3 class="rp-h3">Earlier rounds</h3><div class="table-wrap"><table class="data-table rp-table"><thead><tr><th>Round</th><th>Scope</th><th class="num">In scope</th><th class="num">Verified fixed</th><th class="num">Still found</th><th>Result</th></tr></thead><tbody>${r.rounds
        .slice()
        .reverse()
        .map((x) => {
          const res = x.verification?.result;
          return `<tr><td>${x.round}</td><td>${escapeHtml(sevList(x.severities))}</td><td class="num">${x.baseline}</td><td class="num">${res ? res.fixed : '—'}</td><td class="num">${res ? res.stillFound.length : '—'}</td><td>${res?.zero ? '<span class="rp-chip tone-good">✓ At zero</span>' : res ? 'Verified' : 'Not verified'}</td></tr>`;
        })
        .join('')}</tbody></table></div>`
    : '';
  return `<p class="rp-lead">Round ${round} · ${escapeHtml(sevList(r.filters?.severities))} · ${r.baselineCount} finding${r.baselineCount === 1 ? '' : 's'} in scope. Prove the fixes: once everything is dealt with, a rescan in Checkmarx One shows what is really fixed.</p>
    ${closure}${windowHtml}
    ${controls}
    ${scans}
    ${nextRound}
    ${rounds}`;
}

/** Rescan, automatic verification and next round, from the Verify tab. */
async function verifyAction(event) {
  const verify = event.target.closest('[data-report-verify]');
  const next = event.target.closest('[data-next-round]');
  if (!verify && !next) return false;
  const button = verify || next;
  const id = verify ? verify.dataset.reportVerify : next.dataset.nextRound;
  const card = button.closest('[data-report]');
  button.disabled = true;
  try {
    if (verify) {
      const c = trackedById.get(id)?.latest?.closure;
      if (c && !c.closed && !confirm(`${c.open} finding(s) in this round are still open. Rescan anyway? Checkmarx One scans each project again (this uses scans, not AI credits).`)) return true;
      followStatus(id, 'Asking Checkmarx One to rescan…');
      const report = await api(`/api/tracked-reports/${encodeURIComponent(id)}/verify`, { method: 'POST', body: '{}' });
      trackedById.set(id, report);
      const started = report.verification.projects.filter((p) => p.scanId).length;
      followStatus(id, `${started} rescan(s) started${report.verification.projects.length > started ? `; ${report.verification.projects.length - started} project(s) wait for their next scan` : ''}. Results appear here when the scans finish.`, 'ok');
    } else {
      const severities = [...card.querySelectorAll('[data-next-sev]:checked')].map((x) => x.dataset.nextSev);
      if (!severities.length) return followStatus(id, 'Choose the severities for the next round.', 'error'), true;
      if (!confirm(`Start the next round with ${sevList(severities).toLowerCase()} findings, on what Checkmarx One reports now? This round is kept in the report.`)) return true;
      followStatus(id, 'Reading Checkmarx One for the new round…');
      const report = await api(`/api/tracked-reports/${encodeURIComponent(id)}/next-round`, { method: 'POST', body: JSON.stringify({ severities }) });
      trackedById.set(id, report);
      followStatus(id, `Round ${report.round} started: ${report.baselineCount} finding(s) in scope.`, 'ok');
    }
    renderReportDetail(id);
  } catch (error) {
    if (!handleAuthLoss(error)) followStatus(id, error.message, 'error');
  } finally {
    button.disabled = false;
  }
  return true;
}

/** The automatic-verification switch. */
async function verifyAutoChange(event) {
  const box = event.target.closest('[data-verify-auto]');
  if (!box) return;
  const id = box.dataset.verifyAuto;
  try {
    const report = await api(`/api/tracked-reports/${encodeURIComponent(id)}/verify-settings`, { method: 'PUT', body: JSON.stringify({ auto: box.checked }) });
    trackedById.set(id, report);
    followStatus(id, box.checked ? `On: if the developers have not rescanned within ${report.verify?.graceHours ?? 48} hours, it is rescanned on their behalf.` : 'Off: after the developers\' turn, rescan by hand.', 'ok');
  } catch (error) {
    box.checked = !box.checked;
    if (!handleAuthLoss(error)) followStatus(id, error.message, 'error');
  }
}

export function wireRescanLinks() {
  /** Each developer's own rescan link, to send by hand. */
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-rescan-links]');
    if (!button) return;
    const id = button.dataset.rescanLinks;
    const out = document.querySelector(`[data-rescan-links-out="${CSS.escape(id)}"]`);
    try {
      const { links } = await api(`/api/tracked-reports/${encodeURIComponent(id)}/rescan-links`);
      out.innerHTML = links
        .map((l) => `<div class="vf-link"><span><b>${escapeHtml(l.name || l.email)}</b> <span class="hint">${escapeHtml(l.email)} · ${escapeHtml(l.projects.join(', '))}</span></span><button type="button" class="sm" data-copy-link="${escapeHtml(l.link)}">Copy link</button></div>`)
        .join('') || '<p class="hint">No developer with an address: tag their addresses on the Workbench (People).</p>';
      out.hidden = false;
    } catch (error) {
      if (!handleAuthLoss(error)) followStatus(id, error.message, 'error');
    }
  });
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy-link]');
    if (!button) return;
    try {
      await navigator.clipboard.writeText(button.dataset.copyLink);
      button.textContent = 'Copied';
    } catch {
      prompt('Copy this link', button.dataset.copyLink);
    }
  });
}

/** How long the developers have to rescan themselves (24 hours to 14 days). */
async function verifyGraceChange(event) {
  const input = event.target.closest('[data-verify-grace]');
  if (!input) return;
  const id = input.dataset.verifyGrace;
  try {
    const report = await api(`/api/tracked-reports/${encodeURIComponent(id)}/verify-settings`, { method: 'PUT', body: JSON.stringify({ graceHours: Number(input.value) }) });
    trackedById.set(id, report);
    input.value = report.verify?.graceHours ?? 48;
    followStatus(id, `Developers have ${report.verify?.graceHours ?? 48} hours to rescan themselves.`, 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) followStatus(id, error.message, 'error');
  }
}

/** A time as the CxMissionZero server's clock shows it. */
function serverTime(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, serverZone.name ? { timeZone: serverZone.name, dateStyle: 'medium', timeStyle: 'short' } : undefined);
  } catch {
    return new Date(iso).toLocaleString();
  }
}

/** "Needs N credits · M of A left" for a tracked report's chosen severities, as HTML (numbers and fixed wording only). */
/** The report's rows again, after its numbers or credits changed. */
function updateNeed(card) {
  const report = trackedById.get(card.dataset.report);
  const lanes = card.querySelector('[data-lanes]');
  if (!report || !lanes) return;
  const id = escapeHtml(report.id);
  const tiers = reportTiers(report);
  const ways = { allocate: can('credits.allocate'), run: can('triage.run') };
  lanes.innerHTML = creditLane(id, 'triage', tiers.triage, ways) + creditLane(id, 'remediation', tiers.remediation, ways);
  const breakdown = card.querySelector('[data-need]');
  if (breakdown) breakdown.innerHTML = severityBreakdown(report);
}

/** "Only to" is picked by typing an address; the per-person options don't apply to it. */
function syncSendTo(card) {
  const only = card.querySelector('input[value="only"]')?.checked;
  for (const box of card.querySelectorAll('[data-content-row] input')) box.disabled = Boolean(only);
  card.querySelector('[data-content-row]')?.classList.toggle('muted-row', Boolean(only));
}

function followUpOptions(card) {
  const id = card.dataset.report;
  const value = (name) => card.querySelector(`input[name="${name}-${CSS.escape(id)}"]:checked`)?.value;
  const field = (name) => card.querySelector(`[data-field="${name}"]`);
  const sendTo = value('sendTo') ?? 'settings';
  return {
    sendTo: sendTo === 'only' ? 'list' : sendTo,
    onlyTo: sendTo === 'only' ? field('onlyTo').value : '',
    emailContent: value('content') ?? 'summary',
    attachHtml: field('attachHtml').checked,
    triageAdd: Number(field('triageAdd')?.value) || 0,
    remediationAdd: Number(field('remediationAdd')?.value) || 0,
    enabled: field('autoEnabled').checked,
    everyDays: Number(field('everyDays').value) || 7,
    hour: Number(field('hour').value) || 0,
  };
}

/** The button last clicked in a report card: its message is shown right under it, where the eye is. */
let followButton = null;

function followStatus(id, text, kind = '') {
  const near = followButton?.isConnected && followButton.closest(`[data-report="${CSS.escape(id)}"]`) ? followButton.closest('.actions') : null;
  // Said once: under the button clicked when it is on screen, else at the foot of the report.
  const el = document.querySelector(`[data-follow-status="${CSS.escape(id)}"]`);
  if (el) {
    el.textContent = near ? '' : text;
    el.className = `status ${kind}`;
  }
  if (near) {
    let inline = near.nextElementSibling?.matches?.('.inline-status') ? near.nextElementSibling : null;
    if (!inline) {
      inline = document.createElement('p');
      near.after(inline);
    }
    inline.textContent = text;
    inline.className = `status inline-status ${kind}`;
  }
}

function describeSend(result) {
  if (result.dryRun) {
    if (Array.isArray(result.messages)) {
      const people = result.messages.map((m) => m.email).join(', ');
      return `Would send ${result.messages.length} email(s)${people ? ` to ${people}` : ''}${result.consolidated ? ', plus a copy to the recipient list' : ''}${result.skipped?.length ? `; ${result.skipped.length} initiator(s) have no email address` : ''}.`;
    }
    return `Would send "${result.subject}" covering ${result.totalRisks} finding(s) to ${(result.recipients?.to ?? []).join(', ') || 'the recipient list'}.`;
  }
  const sent = Array.isArray(result.sent) ? result.sent.length : result.messageId ? 1 : 0;
  const failed = (result.failed?.length ?? 0) + (result.errors?.length ?? 0);
  return `Sent ${sent} email(s)${failed ? `, ${failed} failed` : ''}${result.skipped?.length ? `; ${result.skipped.length} initiator(s) skipped (no email address)` : ''}.`;
}

async function followUpAction(event) {
  const button = event.target.closest('[data-remind], [data-schedule], [data-report-triage], [data-report-remediate], [data-report-html], [data-report-allocate]');
  if (!button) return false;
  const card = button.closest('[data-report]');
  const id = card.dataset.report;
  const options = followUpOptions(card);
  // The smart buttons carry their own severities: the tier the credits cover, or the next to allocate for.
  const severities = (button.dataset.severities || '').split(',').filter(Boolean);
  button.disabled = true;
  followButton = button;
  const label = button.textContent;
  try {
    if (button.dataset.reportHtml) {
      button.textContent = 'Preparing…';
      followStatus(id, 'Building the HTML report from the current open findings in Checkmarx One — this can take a minute for large reports…');
      await downloadTrackedHtml(id);
      followStatus(id, 'HTML report downloaded — this is what an attached report contains.', 'ok');
    } else if (button.dataset.reportAllocate) {
      const kind = button.dataset.kind;
      const extra = kind === 'extra';
      if (extra && !options.triageAdd && !options.remediationAdd) return followStatus(id, 'Enter the credits to add.', 'error'), true;
      const question = extra
        ? `Add ${options.triageAdd} triage and ${options.remediationAdd} remediation credit(s) to each of this report's projects, from the credit pool?`
        : kind === 'triage'
          ? "Allocate AI Triage credits from the credit pool to this report's projects: what their findings at the severities on the button need (1 per Checkmarx One result), confirmed with Checkmarx One as they are given?"
          : "Allocate AI Remediation credits from the credit pool to this report's projects: what their confirmed findings at the severities on the button need (3 per confirmed result), confirmed with Checkmarx One as they are given?";
      if (!confirm(question)) return true;
      followStatus(id, 'Allocating…');
      const result = await api(`/api/tracked-reports/${encodeURIComponent(id)}/allocate`, {
        method: 'POST',
        body: JSON.stringify(extra
          ? { severities: [], triageAdd: options.triageAdd, remediationAdd: options.remediationAdd }
          : { severities, kind, triageAdd: 0, remediationAdd: 0 }),
      });
      const { report } = result;
      trackedById.set(id, report);
      for (const name of ['triageAdd', 'remediationAdd']) card.querySelector(`[data-field="${name}"]`).value = '';
      updateNeed(card);
      const c = report.credits;
      followStatus(id, `Allocated. Projects now have ${c.triage.remaining} triage and ${c.remediation.remaining} remediation credit(s) left.${noteGone(result)}`, 'ok');
      creditsChanged();
    } else if (button.dataset.remind) {
      const dryRun = Boolean(button.dataset.dry);
      const onlyTo = options.onlyTo.split(/[;,\s]+/).filter(Boolean);
      if (card.querySelector('input[value="only"]')?.checked && !onlyTo.length) {
        return followStatus(id, 'Enter at least one address to send to.', 'error'), true;
      }
      if (!dryRun && !confirm(onlyTo.length ? `Send this report's open findings only to ${onlyTo.join(', ')}?` : 'Send a reminder about this report\'s open findings now?')) return true;
      followStatus(id, dryRun ? 'Preparing preview…' : 'Sending…');
      const result = await api(`/api/tracked-reports/${encodeURIComponent(id)}/remind`, {
        method: 'POST',
        body: JSON.stringify({ ...options, dryRun }),
      });
      followStatus(id, describeSend(result), 'ok');
      if (!dryRun) loadTrackedReports();
    } else if (button.dataset.schedule) {
      if (card.querySelector('input[value="only"]')?.checked && !options.onlyTo.trim()) {
        return followStatus(id, 'Enter at least one address to send to.', 'error'), true;
      }
      await api(`/api/tracked-reports/${encodeURIComponent(id)}/automation`, { method: 'PUT', body: JSON.stringify(options) });
      followStatus(id, options.enabled ? `Automatic reminders every ${options.everyDays} day(s) at ${options.hour}:00 ${zoneLabel()}.` : 'Automatic reminders are off.', 'ok');
      loadTrackedReports();
    } else if (button.dataset.reportRemediate) {
      if (!severities.length) return true;
      if (!confirm("Run AI Remediation on this report's confirmed findings at the severities on the button? It uses 3 Checkmarx One credits each.")) return true;
      followStatus(id, 'Starting AI Remediation…');
      const result = await api(`/api/tracked-reports/${encodeURIComponent(id)}/remediate`, {
        method: 'POST',
        body: JSON.stringify({ severities }),
      });
      followStatus(id, spendText(result, 'remediation'), result.failed ? 'error' : 'ok');
      if (result.report) {
        trackedById.set(id, result.report);
        updateNeed(card);
      }
      creditsChanged();
    } else {
      if (!severities.length) return true;
      if (!confirm("Run AI Triage on this report's findings at the severities on the button that are still awaiting triage? It uses Checkmarx One credits.")) return true;
      followStatus(id, 'Starting AI Triage…');
      const result = await api(`/api/tracked-reports/${encodeURIComponent(id)}/triage`, {
        method: 'POST',
        body: JSON.stringify({ severities }),
      });
      followStatus(id, spendText(result, 'triage'), result.failed ? 'error' : 'ok');
      if (result.report) {
        trackedById.set(id, result.report);
        updateNeed(card);
      }
      creditsChanged();
    }
  } catch (error) {
    if (!handleAuthLoss(error)) followStatus(id, button.dataset.reportHtml ? `Could not build the HTML report: ${error.message}` : error.message, 'error');
  } finally {
    button.textContent = label;
    button.disabled = false;
  }
  return true;
}

/** What a Triage now / Remediate now click did, in one line. */
export function spendText(result, kind) {
  if (!result.requested) return kind === 'triage' ? 'Nothing awaiting triage at those severities.' : 'Nothing confirmed to remediate at those severities.';
  const parts = [
    kind === 'triage' ? `AI Triage started for ${result.started} finding(s)` : `AI Remediation started for ${result.started} finding(s)`,
    result.skipped ? `${result.skipped} not eligible (SAST and SCA only)` : '',
    result.failed ? `${result.failed} failed: ${result.errors.join('; ')}` : '',
  ];
  return `${parts.filter(Boolean).join(' · ')}.`;
}

async function downloadTrackedHtml(id) {
  const response = await fetch(`/api/tracked-reports/${encodeURIComponent(id)}/html`, { credentials: 'same-origin' });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.error || `${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  const name = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') || '')?.[1] || 'report.html';
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Radios and checkboxes are told apart by value; text and number fields are one key each. */
function keepKey(el) {
  const card = el.closest('[data-report]');
  const choice = el.type === 'checkbox' || el.type === 'radio';
  return `${card?.dataset.report}|${el.name || el.dataset.field || el.dataset.sev}${choice ? `|${el.value}` : ''}`;
}

/** Remember form state and opened sections across the periodic re-render. */
function captureReportsState() {
  const values = new Map();
  for (const el of document.querySelectorAll('#rp-sheet [data-keep]')) {
    const key = keepKey(el);
    values.set(key, el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value);
  }
  const open = new Set([...document.querySelectorAll('#rp-sheet details[open]')].map((d) => d.dataset.keepOpen || d.querySelector('summary')?.textContent));
  const statuses = new Map([...document.querySelectorAll('[data-follow-status]')].map((el) => [el.dataset.followStatus, [el.textContent, el.className]]));
  return { values, open, statuses };
}

function restoreReportsState({ values, open, statuses }) {
  for (const el of document.querySelectorAll('#rp-sheet [data-keep]')) {
    const key = keepKey(el);
    if (!values.has(key)) continue;
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = values.get(key);
    else el.value = values.get(key);
  }
  for (const d of document.querySelectorAll('#rp-sheet details')) {
    const key = d.dataset.keepOpen || d.querySelector('summary')?.textContent;
    if (open.has(key) || open.has(t(key))) d.open = true;
  }
  for (const [id, [text, className]] of statuses) {
    const el = document.querySelector(`[data-follow-status="${CSS.escape(id)}"]`);
    if (el) {
      el.textContent = text;
      el.className = className;
    }
  }
}

async function trackedReportAction(event) {
  if (await verifyAction(event)) return;
  if (await followUpAction(event)) return;
  const refresh = event.target.closest('[data-report-refresh]');
  const remove = event.target.closest('[data-report-delete]');
  if (refresh) {
    refresh.disabled = true;
    refresh.textContent = 'Refreshing…';
    try {
      await api(`/api/tracked-reports/${encodeURIComponent(refresh.dataset.reportRefresh)}/refresh`, { method: 'POST', body: '{}' });
    } catch (error) {
      if (!handleAuthLoss(error)) alert(error.message);
    }
    loadTrackedReports();
  } else if (remove && confirm('Delete this tracked report? Its history is lost.')) {
    closeReportDetail();
    try {
      await api(`/api/tracked-reports/${encodeURIComponent(remove.dataset.reportDelete)}`, { method: 'DELETE' });
    } catch (error) {
      if (!handleAuthLoss(error)) alert(error.message);
    }
    loadTrackedReports();
  }
}

function selectReportTab(tab) {
  rpState.tab = tab;
  for (const button of document.querySelectorAll('#rp-sheet [role="tab"]')) {
    const on = button.dataset.rpTab === tab;
    button.setAttribute('aria-selected', String(on));
    button.tabIndex = on ? 0 : -1;
    if (on) button.focus();
  }
  for (const panel of document.querySelectorAll('#rp-sheet [role="tabpanel"]')) panel.hidden = panel.id !== `rp-panel-${tab}`;
}

export function wireReports() {
  $('track-save').addEventListener('click', saveTrackedReport);
  // Reports page: rows and agenda open a report; the detail panel holds every action.
  for (const id of ['reports-list', 'rp-upcoming']) {
    $(id).addEventListener('click', (event) => {
      const row = event.target.closest('[data-open-report]');
      if (row) openReportDetail(row.dataset.openReport, row.dataset.tab || 'overview');
    });
  }
  // Act → Automation: "Open →" goes to that report, on its Remind tab.
  $('auto-elsewhere').addEventListener('click', (event) => {
    const link = event.target.closest('[data-open-report]');
    if (!link) return;
    event.preventDefault();
    location.hash = '#/reports';
    const started = Date.now();
    const open = () => {
      if (trackedById.has(link.dataset.openReport)) openReportDetail(link.dataset.openReport, link.dataset.tab || 'overview');
      else if (Date.now() - started < 8000) setTimeout(open, 150);
    };
    open();
  });
  $('rp-drawer').addEventListener('click', (event) => {
    if (event.target.closest('[data-rp-close]')) return closeReportDetail();
    const tab = event.target.closest('[data-rp-tab]');
    if (tab) return selectReportTab(tab.dataset.rpTab);
    trackedReportAction(event);
  });
  $('rp-sheet').addEventListener('keydown', (event) => {
    if (!event.target.matches('[role="tab"]') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const keys = RP_TABS.map(([key]) => key);
    const at = keys.indexOf(rpState.tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length;
    event.preventDefault();
    selectReportTab(keys[next]);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('rp-drawer').hidden && $('terms-overlay').hidden) closeReportDetail();
  });
  $('rp-sheet').addEventListener('change', (event) => {
    const card = event.target.closest('[data-report]');
    if (!card) return;
    if (event.target.name?.startsWith('sendTo-')) syncSendTo(card);
    if (event.target.matches('[data-verify-auto]')) verifyAutoChange(event);
    if (event.target.matches('[data-verify-grace]')) verifyGraceChange(event);
  });
  // Typing an address picks "Only to".
  $('rp-sheet').addEventListener('input', (event) => {
    if (!event.target.matches('[data-field="onlyTo"]')) return;
    const card = event.target.closest('[data-report]');
    const only = card.querySelector('input[value="only"]');
    if (event.target.value.trim() && !only.checked) {
      only.checked = true;
      syncSendTo(card);
    }
  });
  for (const radio of document.querySelectorAll('input[name="rpFilter"]')) {
    radio.addEventListener('change', () => {
      rpState.filter = radio.value;
      renderReportList();
    });
  }
  $('rp-search').addEventListener('input', () => {
    rpState.search = $('rp-search').value;
    renderReportList();
  });
  $('rp-sort').addEventListener('change', () => {
    rpState.sort = $('rp-sort').value;
    renderReportList();
  });
}
