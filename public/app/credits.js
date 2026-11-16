// Credit Control: the credit pool, usage over time and by project, allocations, using the credits and giving them.
import { describeEngines } from '../engines.js';
import { $, can, canAny, state } from './state.js';
import { escapeHtml, fmt, fmtDateTime } from './format.js';
import { api, handleAuthLoss, logger, setStatus } from './core.js';
import { focusPick } from './workbench.js';
import { renderProjects } from './projects.js';
import { renderAllocation } from './actions.js';
import { spendText } from './reports.js';

// ---------------------------------------------------------------------------
// The credit pool (Settings → AI & credit pool; live while the page is open)
// ---------------------------------------------------------------------------

const CREDIT_REFRESH_MS = 15_000;
export let creditTimer = null;
const periodText = (pool) => (pool.period === 'all' ? 'one pool, does not refill' : 'refills on the 1st of each month (UTC)');

export async function loadPool({ fresh = false } = {}) {
  clearTimeout(creditTimer);
  if ($('page-settings').hidden) return;
  try {
    const data = await api(fresh ? '/api/credits?fresh=1' : '/api/credits');
    renderPool(data);
  } catch (error) {
    if (handleAuthLoss(error)) return;
    $('pool-view').innerHTML = `<p class="status error">${escapeHtml(error.message)}</p>`;
  }
  creditTimer = setTimeout(loadPool, CREDIT_REFRESH_MS);
}

/** Pool meter + tiles: used (triage / remediation), left, given to projects, free to give. */
function poolHtml(pool, { compact = false } = {}) {
  const used = pool.used;
  const tiles = [
    { label: 'Pool', value: pool.limited ? fmt(pool.size) : 'No limit', detail: pool.limited ? (pool.period === 'all' ? 'One pool' : 'This month') : 'Set a pool size to cap spending' },
    { label: 'Used', value: fmt(used.total), detail: `Triage ${fmt(used.triage)} · Remediation ${fmt(used.remediation)}`, hero: true },
    { label: 'Remaining', value: pool.limited ? fmt(pool.remaining) : '—', detail: pool.limited ? `${Math.round(((pool.remaining ?? 0) / Math.max(1, pool.size)) * 100)}% of the pool` : 'No limit set', bad: pool.limited && pool.remaining === 0 },
    { label: 'Given to projects, not used', value: fmt(pool.outstanding.total), detail: `Triage ${fmt(pool.outstanding.triage)} · Remediation ${fmt(pool.outstanding.remediation)}` },
    { label: 'Free to give', value: pool.limited ? fmt(pool.unallocated) : '—', detail: pool.overAllocated ? `Projects hold ${fmt(pool.overAllocated)} more than the pool has left` : 'Can still be allocated to projects', bad: pool.overAllocated > 0 },
  ];
  // Checkmarx One has fewer credits left for the tenant than the pool: spending stops at what the tenant has left.
  if (pool.overTenant) Object.assign(tiles[2], { detail: `Checkmarx One: ${fmt(pool.tenantLeft)} left for the tenant`, bad: true });
  const over = pool.overTenant
    ? `<p class="status error">${escapeHtml(`The pool has ${fmt(pool.remaining)} credits left, but Checkmarx One has only ${fmt(pool.tenantLeft)} left for this tenant: spending stops at ${fmt(pool.tenantLeft)}.`)} <a href="#/settings/ai">${escapeHtml('Lower the pool')}</a></p>`
    : '';
  const tileHtml = `${over}<div class="stat-tiles">${tiles
    .map((t) => `<div class="${t.hero ? 'hero' : ''} ${t.bad ? 'bad' : ''}"><span class="label">${escapeHtml(t.label)}</span><span class="value">${escapeHtml(t.value)}</span><span class="detail">${escapeHtml(t.detail)}</span></div>`)
    .join('')}</div>`;
  if (!pool.limited) return compact ? tileHtml : tileHtml;
  const pct = (n) => `${Math.max(0, (n / Math.max(1, pool.size)) * 100).toFixed(2)}%`;
  const given = Math.min(pool.outstanding.total, pool.remaining ?? 0);
  const meter = `<div class="pool-meter" role="img" aria-label="${escapeHtml(`Of ${fmt(pool.size)} credits: ${fmt(used.triage)} used for triage, ${fmt(used.remediation)} for remediation, ${fmt(given)} given to projects and not used, ${fmt(pool.unallocated)} free`)}">
      <span class="m-triage" style="width:${pct(used.triage)}" title="Triage: ${fmt(used.triage)}"></span>
      <span class="m-remediation" style="width:${pct(used.remediation)}" title="Remediation: ${fmt(used.remediation)}"></span>
      <span class="m-given" style="width:${pct(given)}" title="Given to projects, not used: ${fmt(given)}"></span>
    </div>
    <div class="pool-legend">
      <span><i class="key key-triage"></i>Used for triage <b>${fmt(used.triage)}</b></span>
      <span><i class="key key-remediation"></i>Used for remediation <b>${fmt(used.remediation)}</b></span>
      <span><i class="key key-given"></i>Given to projects, not used <b>${fmt(given)}</b></span>
      <span><i class="key key-free"></i>Free to give <b>${fmt(pool.unallocated)}</b></span>
    </div>`;
  return tileHtml + meter;
}

function renderPool(data) {
  const pool = data.pool;
  const allowed = [data.enabled && 'triage', data.remediationEnabled && 'remediation'].filter(Boolean);
  $('credit-state').textContent = allowed.length
    ? `Allowed: ${allowed.join(' and ')}${pool.limited ? ` · ${fmt(pool.remaining)} of ${fmt(pool.size)} credits left` : ' · no credit limit'}`
    : 'Switched off';
  $('credit-state').className = `hint ${allowed.length ? 'ok-hint' : ''}`;
  const warning = allowed.length && !data.relayConnected
    ? '<p class="status error">This server is not connected to Checkmarx One, so reports cannot triage or remediate. Connect it under "Checkmarx One integration" above.</p>'
    : '';
  // What the tenant has left in Checkmarx One: the pool, and what projects are given, stay within it.
  poolTenant = data.tenant ?? null;
  renderPoolTenant(data);
  checkPoolLimit();
  $('pool-view').innerHTML = `${warning}${poolHtml(pool)}<p class="hint wide">${escapeHtml(pool.limited ? `The pool ${periodText(pool)}.` : 'No pool size set: spending is limited by what each project is allocated, and by what the tenant has left.')} Per project and over time: <a href="#/credits">Credits</a>.</p>`;
}

/** The tenant's credits as Checkmarx One last said (Settings → AI & credit pool), or null when it did not answer. */
export let poolTenant = null;

/** The Checkmarx One tenant card beside the pool size: what is left, used, given to projects. */
function renderPoolTenant(data) {
  const t = data.tenant;
  const held = data.pool?.outstanding?.total ?? 0;
  const read = `<small>${t?.readAt ? `<span>${escapeHtml('read')}</span> <time translate="no">${escapeHtml(fmtDateTime(t.readAt))}</time> · ` : ''}<a href="#" id="pool-tenant-read">${escapeHtml('read again')}</a></small>`;
  if (!t) {
    $('pool-tenant-card').innerHTML = `<h4>${escapeHtml('Checkmarx One tenant')} ${read}</h4><p class="hint">${escapeHtml('Checkmarx One did not say what this tenant has left. The pool is checked against it when it answers.')}</p>`;
    return;
  }
  const pct = (n) => (t.total ? `${Math.min(100, (n / t.total) * 100).toFixed(2)}%` : '0%');
  const within = (n) => `<span class="${n <= t.available ? 'ok-text' : 'bad-text'}">${escapeHtml(n <= t.available ? 'within what is left' : 'more than is left')}</span>`;
  const size = data.pool?.limited ? data.pool.size : 0;
  const charged = { off: 'not charged on this tenant', reserved: 'credits reserved for each scan' }[data.fusionCharged];
  const rows = [
    t.used !== null && ['Used', escapeHtml(`${fmt(t.used)}${t.actionsPerformed !== null ? ` · ${fmt(t.actionsPerformed)} actions` : ''}`)],
    ['Given to projects', `${escapeHtml(`${fmt(held)} of ${fmt(t.available)}`)} · ${within(held)}`],
    ["This app's pool", size ? `${escapeHtml(fmt(size))} · ${within(size)}` : escapeHtml('no size: up to what is left')],
    charged && ['Fusion scans', escapeHtml(charged)],
  ];
  $('pool-tenant-card').innerHTML = `<h4>${escapeHtml('Checkmarx One tenant')} ${read}</h4>
    <div class="fusion-big"><div><b>${escapeHtml(fmt(t.available))}</b><span>${escapeHtml(t.total !== null ? `credits left of ${fmt(t.total)}` : 'credits left')}</span></div></div>
    ${t.total ? `<div class="fusion-meter" role="img" aria-label="${escapeHtml(`${fmt(t.used ?? 0)} of ${fmt(t.total)} used`)}"><i class="is-used" style="width:${pct(t.used ?? 0)}"></i><i class="is-held" style="width:${pct(held)}"></i></div>` : ''}
    <dl class="fusion-kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

/** The pool size against what the tenant has left, as it is typed: within it, or why it cannot be saved. */
export function checkPoolLimit() {
  const t = poolTenant;
  const box = $('ai-limit-check');
  $('ai-limit-max').textContent = t ? `at most ${fmt(t.available)}` : '';
  const size = Math.floor(Number($('ai-limit').value) || 0);
  $('ai-limit').classList.toggle('is-invalid', Boolean(t && size > t.available));
  if (!t) {
    box.innerHTML = '';
    return;
  }
  if (size <= 0) {
    box.innerHTML = `<p class="hint">${escapeHtml(`No size: up to the ${fmt(t.available)} credits the tenant has left.`)}</p>`;
  } else if (size <= t.available) {
    box.innerHTML = `<p class="hint"><span class="ok-text">✓ <span>${escapeHtml('Within what the tenant has left')}</span></span> · <span>${escapeHtml(`${fmt(t.available - size)} credits stay outside the pool.`)}</span></p>`;
  } else {
    box.innerHTML = `<p class="status error"><span>${escapeHtml(`${fmt(size)} is more than the ${fmt(t.available)} credits this tenant has left in Checkmarx One. Set ${fmt(t.available)} or less to save.`)}</span> <button type="button" class="sm" id="ai-limit-fit">${escapeHtml(`Use ${fmt(t.available)}`)}</button></p>`;
  }
}

export function wireCreditPool() {
  $('ai-limit').addEventListener('input', checkPoolLimit);
  $('ai-limit-check').addEventListener('click', (event) => {
    if (!event.target.closest('#ai-limit-fit') || !poolTenant) return;
    $('ai-limit').value = String(poolTenant.available);
    $('ai-limit').dispatchEvent(new Event('input', { bubbles: true }));
  });
  $('pool-tenant-card').addEventListener('click', (event) => {
    if (!event.target.closest('#pool-tenant-read')) return;
    event.preventDefault();
    loadPool({ fresh: true });
  });
}

// ---------------------------------------------------------------------------
// Credits page: the pool, usage over time, by project, allocated vs used
// ---------------------------------------------------------------------------

const USAGE_REFRESH_MS = 30_000;
export let usageTimer = null;
const usage = { data: null, loading: false };
const isoDay = (date) => date.toISOString().slice(0, 10);

/** The period the filters describe, as from/to dates (UTC). */
function usageRange() {
  const preset = $('usage-preset').value;
  const today = new Date();
  const day = (offset) => isoDay(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset)));
  if (preset === 'custom') return { from: $('usage-from').value, to: $('usage-to').value };
  if (preset === 'this-month') return { from: isoDay(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))), to: day(0) };
  if (preset === 'last-month') {
    return {
      from: isoDay(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1))),
      to: isoDay(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0))),
    };
  }
  return { from: day(1 - Number(preset)), to: day(0) };
}

export async function loadUsage() {
  clearTimeout(usageTimer);
  if ($('page-credits').hidden) return;
  const range = usageRange();
  const query = new URLSearchParams({ ...range, bucket: $('usage-bucket').value, projectId: $('usage-project').value });
  $('page-credits').classList.add('loading');
  try {
    usage.data = await api(`/api/credits/usage?${query}`);
    renderUsage(usage.data);
  } catch (error) {
    if (handleAuthLoss(error)) return;
    $('usage-chart').innerHTML = `<p class="status error">${escapeHtml(error.message)}</p>`;
  } finally {
    $('page-credits').classList.remove('loading');
  }
  usageTimer = setTimeout(loadUsage, USAGE_REFRESH_MS);
}

const BUCKET_NAMES = { day: 'day', week: 'week', month: 'month' };
function bucketLabel(start, bucket, { long = false } = {}) {
  const d = new Date(`${start}T00:00:00Z`);
  if (bucket === 'month') return d.toLocaleDateString(undefined, { month: long ? 'long' : 'short', year: 'numeric', timeZone: 'UTC' });
  const text = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return bucket === 'week' && long ? `Week of ${text}` : text;
}

function renderUsage(data) {
  // Projects to filter by: every one with an allocation or usage, keeping the choice.
  const select = $('usage-project');
  const chosen = select.value;
  const names = new Map(data.projects.map((p) => [p.projectId, p.projectName || p.projectId]));
  for (const p of data.byProject) if (!names.has(p.projectId)) names.set(p.projectId, p.projectName || p.projectId);
  select.innerHTML = `<option value="">All projects</option>${[...names]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, name]) => `<option value="${escapeHtml(id)}"${id === chosen ? ' selected' : ''}>${escapeHtml(name)}</option>`)
    .join('')}`;

  const pool = data.pool;
  $('pool-period-note').textContent = pool.limited ? `${fmt(pool.size)} credits · ${periodText(pool)}` : 'No pool size set';
  $('credits-pool').innerHTML = poolHtml(pool);

  const t = data.totals;
  const span = `${new Date(`${data.from}T00:00:00Z`).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' })} – ${new Date(`${data.to}T00:00:00Z`).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' })}`;
  $('usage-range-note').textContent = `${span} · by ${BUCKET_NAMES[data.bucket]}${data.projectId ? ` · ${names.get(data.projectId) ?? data.projectId}` : ''}`;
  const share = (n) => (t.credits ? `${Math.round((n / t.credits) * 100)}% of credits used` : '—');
  $('usage-tiles').innerHTML = [
    { label: 'Credits used', value: fmt(t.credits), detail: `${fmt(t.requests)} request${t.requests === 1 ? '' : 's'} · ${fmt(t.projects)} project${t.projects === 1 ? '' : 's'}`, hero: true },
    { label: 'AI Triage', value: fmt(t.triage), detail: share(t.triage), key: 'triage' },
    { label: 'AI Remediation', value: fmt(t.remediation), detail: share(t.remediation), key: 'remediation' },
    { label: `Average per ${BUCKET_NAMES[data.bucket]}`, value: fmt(Math.round((t.credits / Math.max(1, data.series.length)) * 10) / 10), detail: `Busiest: ${busiest(data)}` },
  ]
    .map((x) => `<div class="${x.hero ? 'hero' : ''}"><span class="label">${x.key ? `<i class="key key-${x.key}"></i>` : ''}${escapeHtml(x.label)}</span><span class="value">${escapeHtml(x.value)}</span><span class="detail">${escapeHtml(x.detail)}</span></div>`)
    .join('');

  drawUsageChart(data);
  renderUsageTable(data);
  renderUsageProjects(data);
  renderAllocations(data.allocations ?? []);
}

function busiest(data) {
  const top = data.series.reduce((best, row) => (row.credits > (best?.credits ?? 0) ? row : best), null);
  return top ? `${bucketLabel(top.start, data.bucket, { long: true })} (${fmt(top.credits)})` : 'none yet';
}

/** A clean axis maximum and step: 1, 2 or 5 × 10^n. */
function niceScale(max, ticks = 4) {
  if (max <= 0) return { top: 4, step: 1 };
  const raw = max / ticks;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((v) => v >= raw);
  return { top: Math.ceil(max / step) * step, step: Math.max(1, step) };
}

/** Stacked columns per day/week/month: triage at the base, remediation on top. */
function drawUsageChart(data) {
  const box = $('usage-chart');
  const series = data.series;
  if (!data.totals.credits) {
    box.innerHTML = '<div class="chart-empty">No credits used in this period.</div>';
    return;
  }
  const width = Math.max(320, box.clientWidth || 800);
  const height = 260;
  const pad = { top: 18, right: 8, bottom: 28, left: 40 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const { top, step } = niceScale(Math.max(...series.map((r) => r.credits)));
  const y = (v) => pad.top + plotH - (v / top) * plotH;
  const band = plotW / series.length;
  const barW = Math.max(2, Math.min(24, band * 0.7));
  const GAP = 2;
  // A rectangle with a 4px rounded top (square at the baseline, or square top when another segment sits on it).
  const rect = (x, yTop, h, roundTop) => {
    if (h <= 0) return '';
    const r = roundTop ? Math.min(4, barW / 2, h) : 0;
    return `M${x},${yTop + h}V${yTop + r}${r ? `Q${x},${yTop} ${x + r},${yTop}` : ''}H${x + barW - r}${r ? `Q${x + barW},${yTop} ${x + barW},${yTop + r}` : ''}V${yTop + h}Z`;
  };
  const grid = [];
  for (let v = 0; v <= top; v += step) {
    grid.push(`<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(v)}" y2="${y(v)}" /><text x="${pad.left - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`);
  }
  const labelEvery = Math.ceil(series.length / Math.max(1, Math.floor(plotW / 64)));
  const peak = series.reduce((best, row, i) => (row.credits > series[best].credits ? i : best), 0);
  const cols = series
    .map((row, i) => {
      const x = pad.left + i * band + (band - barW) / 2;
      const hT = (row.triage / top) * plotH;
      const hR = (row.remediation / top) * plotH;
      const baseY = pad.top + plotH;
      const triageTop = baseY - hT;
      const remTop = triageTop - hR - (hT > 0 && hR > 0 ? GAP : 0);
      const paths = `<path class="bar-triage" d="${rect(x, triageTop, hT, hR <= 0)}" /><path class="bar-remediation" d="${rect(x, remTop, hR, true)}" />`;
      const label = i % labelEvery === 0 ? `<text class="axis-x" x="${x + barW / 2}" y="${height - 8}" text-anchor="middle">${escapeHtml(bucketLabel(row.start, data.bucket))}</text>` : '';
      const peakLabel = i === peak && row.credits ? `<text class="peak" x="${x + barW / 2}" y="${Math.min(remTop, triageTop) - 5}" text-anchor="middle">${fmt(row.credits)}</text>` : '';
      return `<g class="col" data-i="${i}" tabindex="0" role="img" aria-label="${escapeHtml(`${bucketLabel(row.start, data.bucket, { long: true })}: ${row.triage} triage, ${row.remediation} remediation`)}">
        <rect class="hit" x="${pad.left + i * band}" y="${pad.top}" width="${band}" height="${plotH}" />${paths}${peakLabel}</g>${label ? `<g class="axis">${label}</g>` : ''}`;
    })
    .join('');
  box.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-label="Credits used per ${data.bucket}">
    <g class="grid axis">${grid.join('')}</g>${cols}</svg><div class="tip" hidden></div>`;

  const tip = box.querySelector('.tip');
  const show = (g) => {
    const row = series[Number(g.dataset.i)];
    tip.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'tip-title';
    title.textContent = bucketLabel(row.start, data.bucket, { long: true });
    tip.append(title);
    for (const [name, value, color] of [['AI Triage', row.triage, 'var(--series-1)'], ['AI Remediation', row.remediation, 'var(--series-2)'], ['Total', row.credits, '']]) {
      const line = document.createElement('div');
      line.className = 'tip-row';
      line.innerHTML = `<span class="line-key" style="background:${color || 'transparent'}"></span><b></b><span></span>`;
      line.querySelector('b').textContent = fmt(value);
      line.querySelector('span:last-child').textContent = name;
      tip.append(line);
    }
    tip.hidden = false;
    const hit = g.querySelector('.hit').getBBox();
    const scale = box.clientWidth / width;
    const left = (hit.x + hit.width / 2) * scale;
    tip.style.left = `${Math.min(Math.max(0, left - tip.offsetWidth / 2), box.clientWidth - tip.offsetWidth)}px`;
    tip.style.top = `${Math.max(0, pad.top * scale - 4)}px`;
  };
  for (const g of box.querySelectorAll('.col')) {
    g.addEventListener('pointerenter', () => show(g));
    g.addEventListener('focus', () => show(g));
    g.addEventListener('pointerleave', () => (tip.hidden = true));
    g.addEventListener('blur', () => (tip.hidden = true));
  }
}

function renderUsageTable(data) {
  $('usage-table').innerHTML = `<div class="table-wrap"><table class="probe">
    <thead><tr><th>${data.bucket === 'day' ? 'Day' : data.bucket === 'week' ? 'Week of' : 'Month'}</th><th class="num">AI Triage</th><th class="num">AI Remediation</th><th class="num">Total</th><th class="num">Requests</th><th class="num">Running total</th></tr></thead>
    <tbody>${data.series
      .map((r) => `<tr><td>${escapeHtml(bucketLabel(r.start, data.bucket, { long: true }))}</td><td class="num">${fmt(r.triage)}</td><td class="num">${fmt(r.remediation)}</td><td class="num"><b>${fmt(r.credits)}</b></td><td class="num">${fmt(r.requests)}</td><td class="num">${fmt(r.cumulative)}</td></tr>`)
      .join('')}</tbody>
    <tfoot><tr><th>Total</th><th class="num">${fmt(data.totals.triage)}</th><th class="num">${fmt(data.totals.remediation)}</th><th class="num">${fmt(data.totals.credits)}</th><th class="num">${fmt(data.totals.requests)}</th><th></th></tr></tfoot>
  </table></div>`;
}

function renderUsageProjects(data) {
  if (!data.byProject.length) {
    $('usage-projects').innerHTML = '<p class="hint">No project used credits in this period.</p>';
    return;
  }
  const max = Math.max(...data.byProject.map((p) => p.credits));
  const pct = (n) => `${((n / max) * 100).toFixed(2)}%`;
  $('usage-projects').innerHTML = `<div class="table-wrap"><table class="probe">
    <thead><tr><th>Project</th><th class="share-cell">Share</th><th class="num">AI Triage</th><th class="num">AI Remediation</th><th class="num">Total</th><th class="num">Requests</th><th>Last used</th></tr></thead>
    <tbody>${data.byProject
      .map((p) => `<tr>
        <td>${escapeHtml(p.projectName || p.projectId)}</td>
        <td class="share-cell"><div class="hbar" title="${p.triage} triage, ${p.remediation} remediation"><span class="m-triage" style="width:${pct(p.triage)}"></span><span class="m-remediation" style="width:${pct(p.remediation)}"></span></div></td>
        <td class="num">${fmt(p.triage)}</td><td class="num">${fmt(p.remediation)}</td><td class="num"><b>${fmt(p.credits)}</b></td><td class="num">${fmt(p.requests)}</td>
        <td>${escapeHtml(new Date(p.lastUsedAt).toLocaleString())}</td></tr>`)
      .join('')}</tbody>
    <tfoot><tr><th>Total</th><th></th><th class="num">${fmt(data.totals.triage)}</th><th class="num">${fmt(data.totals.remediation)}</th><th class="num">${fmt(data.totals.credits)}</th><th class="num">${fmt(data.totals.requests)}</th><th></th></tr></tfoot>
  </table></div>`;
}

/** Per project: first allocated, allocated now, used through this utility, left. */
function renderAllocations(all) {
  const filter = $('alloc-search').value.trim().toLowerCase();
  const list = filter ? all.filter((p) => (p.projectName || p.projectId).toLowerCase().includes(filter)) : all;
  renderTakeBack(all);
  renderGive();
  renderSpend(all);
  const mayTakeBack = can('credits.allocate');
  const mayPick = canAny('triage.run credits.allocate');
  if (!list.length) {
    $('credit-allocations').innerHTML = `<p class="hint">${all.length ? 'No project matches.' : mayTakeBack ? 'No project has an allocation yet — give credits above, or on the Workbench.' : 'No project has an allocation yet.'}</p>`;
    return;
  }
  const bar = (k) => {
    const pct = k.allocated ? Math.min(100, Math.round((k.used / k.allocated) * 100)) : 0;
    return `<div class="use-bar" title="${k.used} of ${k.allocated} used"><span style="width:${pct}%"></span></div>`;
  };
  const cells = (k) => `<td class="num">${fmt(k.initial)}</td><td class="num">${fmt(k.allocated)}</td><td class="num"><b>${fmt(k.used)}</b>${bar(k)}</td><td class="num">${fmt(k.remaining)}</td>`;
  const sum = (kind, key) => list.reduce((n, p) => n + (p[kind][key] ?? 0), 0);
  const totals = (kind) => ['initial', 'allocated', 'used', 'remaining'].map((key) => `<th class="num">${fmt(sum(kind, key))}</th>`).join('');
  $('credit-allocations').innerHTML = `<div class="table-wrap"><table class="probe alloc-table">
    <thead>
      <tr>${mayPick ? '<th rowspan="2" class="alloc-pick"><span class="sr-only">Pick</span></th>' : ''}<th rowspan="2">Project</th><th colspan="4" class="group">AI Triage</th><th colspan="4" class="group">AI Remediation</th>${mayTakeBack ? '<th rowspan="2"><span class="sr-only">Give or take back</span></th>' : ''}</tr>
      <tr>${'<th class="num">At start</th><th class="num">Allocated</th><th class="num">Used</th><th class="num" data-i18n-ctx="credits">Left</th>'.repeat(2)}</tr>
    </thead>
    <tbody>${list
      .map((p) => `<tr>${mayPick ? `<td class="alloc-pick"><input type="checkbox" data-spend-pick="${escapeHtml(p.projectId)}" aria-label="Pick" ${spend.picked.has(p.projectId) ? 'checked' : ''} /></td>` : ''}<td><span translate="no">${escapeHtml(p.projectName || p.projectId)}</span><div class="hint">${allocationRule(p)}</div>${spend.gone.has(p.projectId) ? '<div class="hint is-warn">No longer in Checkmarx One: take its credits back.</div>' : ''}</td>${cells(p.triage)}${cells(p.remediation)}${mayTakeBack ? `<td class="alloc-actions"><button type="button" class="sm" data-give="${escapeHtml(p.projectId)}" title="Give this project more credits">Give</button>${unusedOf(p) ? `<button type="button" class="sm danger-soft" data-reclaim="${escapeHtml(p.projectId)}" title="Take back the ${unusedOf(p)} credit(s) this project has not used">Take back ${fmt(unusedOf(p))}</button>` : ''}</td>` : ''}</tr>`)
      .join('')}</tbody>
    <tfoot><tr>${mayPick ? '<th></th>' : ''}<th>Total</th>${totals('triage')}${totals('remediation')}${mayTakeBack ? '<th></th>' : ''}</tr></tfoot>
  </table></div>`;
}

/** Under a project's name: the severities its needs cover, and when it was first given credits (each piece translatable). */
function allocationRule(p) {
  const severities = p.severities.length ? p.severities.map((s) => `<span>${escapeHtml(s.charAt(0) + s.slice(1).toLowerCase())}</span>`).join(', ') : '<span>No severities</span>';
  return `${severities}${p.initialAt ? ` · <span>First given:</span> <span translate="no">${escapeHtml(new Date(p.initialAt).toLocaleDateString())}</span>` : ''}`;
}

/** Credits a project was given and has not used (nor has in flight): what taking back returns. */
const unusedOf = (p) => (p.triage.remaining ?? 0) + (p.remediation.remaining ?? 0);

/** The clean-slate bar above the allocations: how much every project holds unused. */
function renderTakeBack(all) {
  const bar = $('cc-takeback');
  if (!can('credits.allocate')) return (bar.hidden = true);
  const unused = all.reduce((n, p) => n + unusedOf(p), 0);
  const holding = all.filter((p) => unusedOf(p) > 0).length;
  bar.hidden = all.length === 0;
  $('cc-reclaim-all').disabled = unused === 0;
  $('cc-reclaim-all').textContent = unused ? `Take back all ${fmt(unused)} unused credits` : 'Nothing to take back';
  // Plain numbers (no thousands separator), so each wording is one entry to translate.
  $('cc-takeback-note').textContent = unused
    ? `${holding} project${holding === 1 ? ' holds' : 's hold'} ${unused} credit${unused === 1 ? '' : 's'} they have not used. Taking them back returns them to the credit pool; used credits stay counted.`
    : 'Every project has used what it was given. Nothing is waiting to be taken back.';
}

/** Take back unused credits: from every project (clean slate), or one. */
async function takeBackCredits(projectIds = null) {
  const all = usage.data?.allocations ?? [];
  const chosen = projectIds ? all.filter((p) => projectIds.includes(p.projectId)) : all;
  const triage = chosen.reduce((n, p) => n + (p.triage.remaining ?? 0), 0);
  const remediation = chosen.reduce((n, p) => n + (p.remediation.remaining ?? 0), 0);
  if (!triage && !remediation) return setStatus('cc-takeback-status', 'Nothing to take back.', 'ok');
  const who = projectIds ? `"${chosen[0]?.projectName || chosen[0]?.projectId}"` : `every project (${chosen.filter((p) => unusedOf(p)).length})`;
  if (!confirm(`Take back ${triage + remediation} unused credit(s) — ${triage} triage, ${remediation} remediation — from ${who} to the credit pool?\n\nDevelopers cannot triage or remediate from their reports until credits are given again. Used credits stay counted.`)) return;
  try {
    const result = await api('/api/credits/reclaim', { method: 'POST', body: JSON.stringify(projectIds ? { projectIds } : { all: true }) });
    setStatus('cc-takeback-status', `Took back ${fmt(result.reclaimed)} credit(s) from ${result.projects} project(s) to the credit pool.`, 'ok');
    logger.add(`Took back ${result.reclaimed} unused credit(s) from ${result.projects} project(s)`, 'success');
    if (usage.data) {
      usage.data.allocations = result.allocations;
      usage.data.pool = result.pool;
      $('credits-pool').innerHTML = poolHtml(result.pool);
    }
    renderAllocations(result.allocations);
    creditsChanged();
  } catch (error) {
    if (handleAuthLoss(error)) return;
    setStatus('cc-takeback-status', error.message, 'error');
  }
}

export function wireTakeBack() {
  // Taking back spends nothing, so it needs no findings loaded and no check with Checkmarx One first.
  $('cc-reclaim-all').addEventListener('click', () => takeBackCredits());
  $('credit-allocations').addEventListener('change', (event) => {
    const box = event.target.closest('[data-spend-pick]');
    if (!box) return;
    if (box.checked) spend.picked.add(box.dataset.spendPick);
    else spend.picked.delete(box.dataset.spendPick);
    renderSpend(usage.data?.allocations ?? []);
  });
  $('credit-allocations').addEventListener('click', (event) => {
    const button = event.target.closest('[data-reclaim]');
    if (button) takeBackCredits([button.dataset.reclaim]);
    const give = event.target.closest('[data-give]');
    if (give) chooseGiveProject(give.dataset.give);
  });
}

// ---------------------------------------------------------------------------
// Using the credits on the Credit Control page: Triage now / Remediate now
// ---------------------------------------------------------------------------

/** Projects ticked in Allocated vs used; none ticked means every project. */
const spend = { picked: new Set(), gone: new Set() };

/** Projects the last spend or allocation found deleted from Checkmarx One: marked in the table, named in the status. */
export function noteGone(result) {
  for (const p of result?.gone ?? []) spend.gone.add(p.projectId);
  return result?.goneNote ? ` ${result.goneNote}` : '';
}

const spendSeverities = () => [...document.querySelectorAll('[data-spend-sev]:checked')].map((box) => box.dataset.spendSev);
/** The AI engines ticked (SAST and SCA by default; none ticked is never sent). */
const spendEngines = () => [...document.querySelectorAll('[data-spend-engine]:checked')].map((box) => box.dataset.spendEngine);

/**
 * What the ticked projects' chosen severities need, for those loaded on the Workbench
 * (Credit Control reads Checkmarx One only when a button is pressed); null when unknown.
 */
function spendNeed(chosen, severities) {
  const loaded = new Map(state.projects.filter((p) => p.credits).map((p) => [p.projectId, p.credits]));
  if (!chosen.length || !chosen.every((p) => loaded.has(p.projectId))) return null;
  const sum = (key) => chosen.reduce((n, p) => n + severities.reduce((m, s) => m + (loaded.get(p.projectId)[key]?.[s] ?? 0), 0), 0);
  return { triage: sum('toTriage'), remediation: 3 * sum('toRemediateBySeverity') };
}

/**
 * The bar's buttons work once the chosen projects hold credits to use (1 to triage, 3 to remediate),
 * and turn gold only when projects are ticked and their credits cover what the ticked severities need.
 */
function renderSpend(all) {
  const bar = $('cc-spend');
  bar.hidden = !canAny('triage.run credits.allocate') || !all.length;
  if (bar.hidden) return;
  for (const id of spend.picked) if (!all.some((p) => p.projectId === id)) spend.picked.delete(id);
  const chosen = spend.picked.size ? all.filter((p) => spend.picked.has(p.projectId)) : all;
  const triage = chosen.reduce((n, p) => n + (p.triage.remaining ?? 0), 0);
  const remediation = chosen.reduce((n, p) => n + (p.remediation.remaining ?? 0), 0);
  const severities = spendSeverities().length > 0 && spendEngines().length > 0;
  const need = spend.picked.size ? spendNeed(chosen, spendSeverities()) : null;
  const covers = (kind, left) => need !== null && need[kind] > 0 && left >= need[kind];
  $('cc-run-triage').disabled = !severities || triage < 1;
  $('cc-run-remediation').disabled = !severities || remediation < 3;
  $('cc-run-triage').classList.toggle('is-golden', !$('cc-run-triage').disabled && covers('triage', triage));
  $('cc-run-remediation').classList.toggle('is-golden', !$('cc-run-remediation').disabled && covers('remediation', remediation));
  const figures = (left, needed) => `${fmt(left)} credits left${needed === null ? '' : ` · ${fmt(needed)} needed`}`;
  $('cc-lane-triage').textContent = figures(triage, need?.triage ?? null);
  $('cc-lane-remediation').textContent = figures(remediation, need?.remediation ?? null);
  $('cc-spend-left').textContent = spend.picked.size
    ? `${chosen.length} project${chosen.length === 1 ? '' : 's'} ticked.${need ? '' : ' Load them on the Workbench to see what they need; the buttons turn gold once their credits cover it.'}`
    : 'Every project. Tick projects to see what they need: the buttons turn gold once their credits cover it.';
}

async function runCredits(kind) {
  const severities = spendSeverities();
  if (!severities.length) return setStatus('cc-spend-status', 'Pick at least one severity.', 'error');
  const engines = spendEngines();
  if (!engines.length) return setStatus('cc-spend-status', 'Pick at least one engine.', 'error');
  const all = usage.data?.allocations ?? [];
  const chosen = spend.picked.size ? all.filter((p) => spend.picked.has(p.projectId)) : all;
  const sev = `${severities.map((s) => s.toLowerCase()).join(', ')} ${describeEngines(engines)}`;
  const who = spend.picked.size ? `the ${chosen.length} ticked project(s)` : `every project holding credits (${chosen.length})`;
  const question = kind === 'triage'
    ? `Run AI Triage on the ${sev} findings still awaiting triage in ${who}? It uses Checkmarx One credits.`
    : `Run AI Remediation on the confirmed ${sev} findings in ${who}? It uses 3 Checkmarx One credits each.`;
  if (!confirm(question)) return;
  const button = $(kind === 'triage' ? 'cc-run-triage' : 'cc-run-remediation');
  button.disabled = true;
  setStatus('cc-spend-status', kind === 'triage' ? 'Starting AI Triage…' : 'Starting AI Remediation…');
  try {
    const result = await api('/api/credits/run', { method: 'POST', body: JSON.stringify({ kind, severities, engines, branches: focusPick.allBranches ? 'all' : 'primary', projectIds: [...spend.picked] }) });
    setStatus('cc-spend-status', spendText(result, kind) + noteGone(result), result.failed ? 'error' : 'ok');
    logger.add(spendText(result, kind), result.failed ? 'error' : 'success');
    if (usage.data) {
      usage.data.allocations = result.allocations;
      usage.data.pool = result.pool;
      $('credits-pool').innerHTML = poolHtml(result.pool);
    }
    renderAllocations(result.allocations);
    creditsChanged();
  } catch (error) {
    if (handleAuthLoss(error)) return;
    setStatus('cc-spend-status', error.message, 'error');
    if (error.body?.gone?.length) {
      noteGone(error.body);
      renderAllocations(usage.data?.allocations ?? []);
    }
  } finally {
    renderSpend(usage.data?.allocations ?? []);
  }
}

/** Give the ticked projects what the chosen severities need for one kind of credit (confirmed twice with Checkmarx One), plus its extra. */
async function allocateNeededCredits(kind) {
  const severities = spendSeverities();
  const extraField = kind === 'triage' ? 'cc-spend-extra-triage' : 'cc-spend-extra-remediation';
  const extra = Math.max(0, Math.floor(Number($(extraField).value) || 0));
  if (!severities.length && !extra) return setStatus('cc-spend-status', 'Pick severities, or enter credits to add.', 'error');
  const engines = spendEngines();
  if (severities.length && !engines.length) return setStatus('cc-spend-status', 'Pick at least one engine.', 'error');
  const question = kind === 'triage'
    ? 'Allocate AI Triage credits (1 per Checkmarx One result) from the credit pool to the ticked projects (none ticked: every project holding credits): what the ticked severities need, plus any extra entered?'
    : 'Allocate AI Remediation credits (3 per confirmed result) from the credit pool to the ticked projects (none ticked: every project holding credits): what the ticked severities need, plus any extra entered?';
  if (!confirm(question)) return;
  const button = $(kind === 'triage' ? 'cc-allocate-triage' : 'cc-allocate-remediation');
  button.disabled = true;
  setStatus('cc-spend-status', 'Allocating…');
  try {
    const body = { severities, engines, kind, branches: focusPick.allBranches ? 'all' : 'primary', triageAdd: kind === 'triage' ? extra : 0, remediationAdd: kind === 'triage' ? 0 : extra, projectIds: [...spend.picked] };
    const result = await api('/api/credits/allocate-needed', { method: 'POST', body: JSON.stringify(body) });
    $(extraField).value = 0;
    if (usage.data) {
      usage.data.allocations = result.allocations;
      usage.data.pool = result.pool;
      $('credits-pool').innerHTML = poolHtml(result.pool);
    }
    renderAllocations(result.allocations);
    setStatus('cc-spend-status', `Allocated. The table shows what each project now has.${noteGone(result)}`, 'ok');
    creditsChanged();
  } catch (error) {
    if (handleAuthLoss(error)) return;
    setStatus('cc-spend-status', error.message, 'error');
    if (error.body?.gone?.length) {
      noteGone(error.body);
      renderAllocations(usage.data?.allocations ?? []);
    }
  } finally {
    button.disabled = false;
    renderSpend(usage.data?.allocations ?? []);
  }
}

/**
 * Credits were given, taken back or used on one page: the Workbench's balances
 * (and its gold buttons) follow at once. Reports and Credit Control read theirs
 * again whenever they are opened.
 */
export async function creditsChanged() {
  if (!state.projects?.length || state.fetching || !can('credits.view')) return;
  try {
    const { projects } = await api('/api/credits/views');
    let changed = false;
    for (const p of state.projects) {
      if (!projects[p.projectId]) continue;
      p.credits = projects[p.projectId];
      changed = true;
    }
    if (changed) {
      renderProjects();
      renderAllocation();
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Giving credits on the Credit Control page (the Workbench gives them too)
// ---------------------------------------------------------------------------

const give = { projects: null, loading: null, warning: null };

/** Projects credits can be given to: every Checkmarx One project, read once when the bar is first used. */
async function loadGiveProjects({ refresh = false } = {}) {
  if (give.projects && !refresh) return give.projects;
  give.loading ??= api(`/api/credits/projects${refresh ? '?refresh=1' : ''}`)
    .then((result) => {
      give.projects = result.projects;
      give.warning = result.warning;
      renderGiveOptions();
      return give.projects;
    })
    .finally(() => (give.loading = null));
  return give.loading;
}

function renderGiveOptions() {
  const known = new Map((usage.data?.allocations ?? []).map((p) => [p.projectId, p.projectName || p.projectId]));
  for (const p of give.projects ?? []) known.set(p.projectId, p.projectName);
  $('cc-give-options').innerHTML = [...known.values()]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => `<option value="${escapeHtml(name)}"></option>`)
    .join('');
  if (give.warning) setStatus('cc-give-status', give.warning, 'warn');
}

/** The give bar: shown to people who may allocate, with what the pool has free. */
function renderGive() {
  const form = $('cc-give');
  form.hidden = !can('credits.allocate');
  if (form.hidden) return;
  if (!give.projects) renderGiveOptions();
  const pool = usage.data?.pool;
  $('cc-give-free').hidden = !pool?.limited;
  $('cc-give-free-n').textContent = pool?.limited ? fmt(pool.unallocated) : '';
}

/** Which project the typed name means: an exact name (any case), else the only one that contains it. */
function giveProjectOf(text) {
  const wanted = text.trim().toLowerCase();
  if (!wanted) return null;
  const all = new Map((usage.data?.allocations ?? []).map((p) => [p.projectId, { projectId: p.projectId, projectName: p.projectName || p.projectId }]));
  for (const p of give.projects ?? []) all.set(p.projectId, p);
  const list = [...all.values()];
  const exact = list.filter((p) => p.projectName.toLowerCase() === wanted || p.projectId.toLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  const partial = list.filter((p) => p.projectName.toLowerCase().includes(wanted));
  return partial.length === 1 ? partial[0] : null;
}

function chooseGiveProject(projectId) {
  const p = (usage.data?.allocations ?? []).find((x) => x.projectId === projectId) ?? (give.projects ?? []).find((x) => x.projectId === projectId);
  $('cc-give-project').value = p?.projectName || projectId;
  $('cc-give').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('cc-give-triage').focus();
  $('cc-give-triage').select();
}

async function giveCredits() {
  const count = (id) => Math.floor(Number($(id).value) || 0);
  const triage = count('cc-give-triage');
  const remediation = count('cc-give-remediation');
  if (triage < 0 || remediation < 0) return setStatus('cc-give-status', 'Credits cannot be negative. To take credits back, use Take back.', 'error');
  if (!triage && !remediation) return setStatus('cc-give-status', 'Enter how many AI Triage or AI Remediation credits to give.', 'error');
  await loadGiveProjects().catch(() => null);
  const project = giveProjectOf($('cc-give-project').value);
  if (!project) return setStatus('cc-give-status', 'Choose a project from the list.', 'error');
  // One line per sentence, the project's name on its own: each line is translated as it is.
  if (!confirm(`Give ${triage} AI Triage and ${remediation} AI Remediation credits out of the credit pool to this project?\n${project.projectName}\n\nThey stay with the project until they are used or taken back.`)) return;
  $('cc-give-submit').disabled = true;
  setStatus('cc-give-status', 'Giving…');
  try {
    const result = await api('/api/credits/give', { method: 'POST', body: JSON.stringify({ projectId: project.projectId, triage, remediation }) });
    setStatus('cc-give-status', `Gave ${result.triage} AI Triage and ${result.remediation} AI Remediation credits.`, 'ok');
    logger.add(`Gave ${result.given} credit(s) to ${result.projectName}`, 'success');
    $('cc-give-triage').value = 0;
    $('cc-give-remediation').value = 0;
    if (usage.data) {
      usage.data.allocations = result.allocations;
      usage.data.pool = result.pool;
      $('credits-pool').innerHTML = poolHtml(result.pool);
    }
    renderAllocations(result.allocations);
    creditsChanged();
  } catch (error) {
    if (handleAuthLoss(error)) return;
    setStatus('cc-give-status', error.message, 'error');
  } finally {
    $('cc-give-submit').disabled = false;
  }
}

function exportUsageCsv() {
  const data = usage.data;
  if (!data) return;
  const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = [
    ['Section', 'Period start', 'Project', 'AI Triage', 'AI Remediation', 'Total', 'Requests'],
    ...data.series.map((r) => ['over time', r.start, data.projectId || 'all projects', r.triage, r.remediation, r.credits, r.requests]),
    ...data.byProject.map((p) => ['by project', `${data.from}..${data.to}`, p.projectName || p.projectId, p.triage, p.remediation, p.credits, p.requests]),
    [],
    ['Allocations (all time)', '', 'Project', 'Triage allocated', 'Triage used', 'Remediation allocated', 'Remediation used'],
    ...data.allocations.map((p) => ['allocation', '', p.projectName || p.projectId, p.triage.allocated, p.triage.used, p.remediation.allocated, p.remediation.used]),
  ];
  const blob = new Blob([rows.map((r) => r.map(cell).join(',')).join('\n')], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `credits-${data.from}-to-${data.to}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
let usageResize = null;

export function wireCreditControl() {
  $('cc-allocate-triage').addEventListener('click', () => allocateNeededCredits('triage'));
  $('cc-allocate-remediation').addEventListener('click', () => allocateNeededCredits('remediation'));
  $('cc-run-triage').addEventListener('click', () => runCredits('triage'));
  $('cc-run-remediation').addEventListener('click', () => runCredits('remediation'));
  for (const box of document.querySelectorAll('[data-spend-sev], [data-spend-engine]')) box.addEventListener('change', () => renderSpend(usage.data?.allocations ?? []));

  $('cc-give').addEventListener('submit', (event) => {
    event.preventDefault();
    giveCredits();
  });
  $('cc-give-project').addEventListener('focus', () => loadGiveProjects().catch((error) => !handleAuthLoss(error) && setStatus('cc-give-status', error.message, 'error')), { once: true });

  $('usage-preset').addEventListener('change', () => {
    const custom = $('usage-preset').value === 'custom';
    $('usage-from-field').hidden = !custom;
    $('usage-to-field').hidden = !custom;
    if (custom && !$('usage-from').value) {
      const { from, to } = usage.data ?? usageRange();
      $('usage-from').value = from;
      $('usage-to').value = to;
    }
    loadUsage();
  });
  for (const id of ['usage-from', 'usage-to', 'usage-bucket', 'usage-project']) $(id).addEventListener('change', loadUsage);
  $('usage-filters').addEventListener('submit', (event) => event.preventDefault());
  $('usage-export').addEventListener('click', exportUsageCsv);
  $('alloc-search').addEventListener('input', () => renderAllocations(usage.data?.allocations ?? []));
  window.addEventListener('resize', () => {
    clearTimeout(usageResize);
    usageResize = setTimeout(() => usage.data && !$('page-credits').hidden && drawUsageChart(usage.data), 150);
  });
}
