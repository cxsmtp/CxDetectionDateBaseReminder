// Settings for the server itself: activation, tenants, About and updates, integrity, the report server address,
// network and proxy, trusted certificates, the Checkmarx One integration and HTTPS.
import { initTenantMenu } from '../tenant-menu.js';
import { loadAutomation, renderGettingStarted } from '../app.js';
import { $, can, canAny, state } from './state.js';
import { escapeHtml, formatDate } from './format.js';
import { api, certificateFileData, handleAuthLoss, renderLicenceBanner, setStatus, showError, toast } from './core.js';
import { applyPermissions, calculator, parseRoute } from './nav.js';
import { languagesChanged } from './profile.js';
import { autosave, loadConnectionGuard } from './settings.js';

// ---- Activation codes: add-ons unlocked by the maintainer (Hebrew, several tenants) ----

export async function loadActivation() {
  if (!canAny('activation.manage activation.view')) return;
  try {
    renderActivation(await api('/api/activation', { quiet: true }));
  } catch (error) {
    if (!handleAuthLoss(error)) showError('act-status', error);
  }
}

/** The languages this person may use now (after Hebrew was turned on or off, or opened to other people). */
async function refreshMyLanguages() {
  try {
    const me = await api('/api/me', { quiet: true });
    if (Array.isArray(me.languages)) languagesChanged(me.languages, true);
    // A tenants code just applied brings Settings → Tenants.
    if (state.me) {
      state.me = me;
      applyPermissions();
    }
  } catch {}
}

function renderActivation(a) {
  const date = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
  const he = a.languages?.he ?? { on: false };
  const t = a.tenants;
  // Only what a code has unlocked (or whose code ran out): an add-on appears, switched on, when its code is applied.
  const p = a.product;
  // The product licence: always shown, as it says until when CxMissionZero works here.
  const lastDay = p ? date(new Date(Date.parse(p.until) - 1).toISOString()) : '';
  const rows = [
    // Each English piece is its own element, so the page translator can reach it.
    ...(p ? [`<div class="act-row"><strong>CxMissionZero</strong><span>${p.active ? '<span class="badge ok">Active</span>' : '<span class="badge warn">Deactivated</span>'} <span>Until the end of</span> <b>${escapeHtml(lastDay)}</b> <span>(UTC)</span>${p.activation ? ` · ${escapeHtml(p.activation.org)}` : ''}${p.warn ? ` <strong class="https-note warn">${p.daysLeft} days left</strong>` : ''}</span></div>`] : []),
    ...(he.on || he.expired ? [`<div class="act-row"><strong>Hebrew</strong><span>${he.on ? `<span class="badge ok">On</span> <span>Until</span> <b>${escapeHtml(date(he.expires))}</b>${he.org ? ` · ${escapeHtml(he.org)}` : ''}` : `<span class="badge warn">Expired</span> <b>${escapeHtml(date(he.expires))}</b>`}</span></div>`] : []),
    ...(a.features?.impact ? [`<div class="act-row"><strong>Cx Credits Calculator: Impact</strong><span>${a.features.impact.on ? `<span class="badge ok">On</span> <span>Until</span> <b>${escapeHtml(date(a.features.impact.expires))}</b>` : a.features.impact.expired ? `<span class="badge warn">Expired</span> <b>${escapeHtml(date(a.features.impact.expires))}</b>` : '<span class="badge muted">Off</span>'}</span></div>`] : []),
    ...(a.features?.faeFlush ? [`<div class="act-row"><strong>FAE Flush</strong><span>${a.features.faeFlush.on ? `<span class="badge ok">On</span> <span>Until</span> <b>${escapeHtml(date(a.features.faeFlush.expires))}</b>` : a.features.faeFlush.expired ? `<span class="badge warn">Expired</span> <b>${escapeHtml(date(a.features.faeFlush.expires))}</b>` : '<span class="badge muted">Off</span>'}</span></div>`] : []),
    ...(a.features?.statusBoard ? [`<div class="act-row"><strong>Status board</strong><span>${a.features.statusBoard.on ? `<span class="badge ok">On</span> <span>Until</span> <b>${escapeHtml(date(a.features.statusBoard.expires))}</b>` : a.features.statusBoard.expired ? `<span class="badge warn">Expired</span> <b>${escapeHtml(date(a.features.statusBoard.expires))}</b>` : '<span class="badge muted">Off</span>'}</span></div>`] : []),
    ...(a.features?.consolidated ? [`<div class="act-row"><strong>Consolidated view</strong><span>${a.features.consolidated.on ? `<span class="badge ok">On</span> <span>Until</span> <b>${escapeHtml(date(a.features.consolidated.expires))}</b>` : a.features.consolidated.expired ? `<span class="badge warn">Expired</span> <b>${escapeHtml(date(a.features.consolidated.expires))}</b>` : '<span class="badge muted">Off</span>'}</span></div>`] : []),
    ...(t ? [`<div class="act-row"><strong>Several tenants</strong><span>${t.valid ? '<span class="badge ok">Unlocked</span>' : '<span class="badge warn">Expired</span>'} ${escapeHtml(t.org)} · <span>Up to ${t.maxTenants} tenants</span> · <span>Until</span> <b>${escapeHtml(date(t.expires))}</b>${t.warn ? ` <strong class="https-note warn">${t.daysLeft} days left</strong>` : ''}</span></div>`] : []),
  ];
  if (rows.length === (p ? 1 : 0)) rows.push('<p class="hint">No add-ons are unlocked yet.</p>');
  if (!a.keyConfigured) rows.push('<p class="hint">This build has no maintainer key, so no code can be checked.</p>');
  // Who sees Hebrew is a permission on the roles, listed there while Hebrew is on.
  if (he.on) rows.push('<p class="hint">Who sees Hebrew: the roles with the <strong>Hebrew</strong> permission, under <a href="#/access/roles">People &amp; roles</a>. Admins always have it; tick it for Security Analyst or any other role that should.</p>');
  $('act-list').innerHTML = rows.join('');
  // Seeing the page is not changing it: an Admin enters codes.
  $('act-view-only').hidden = Boolean(a.canManage);
}

// ---- Several Checkmarx One tenants: the switcher at the top, and Settings → Tenants -----------

/**
 * The tenant switcher: shown to people who work in more than one tenant (or may see the consolidated view). A button
 * and a list (tenant-menu.js): Consolidated view first, then each tenant with its colour and when it last fetched.
 */
let tenantMenu; // set by wireActivationAndTenants(), when the page loads
export function renderTenantPicker(me) {
  tenantMenu.render(me);
}

export async function loadTenants() {
  if (!can('tenants.manage')) return;
  try {
    renderTenants(await api('/api/tenants', { quiet: true }));
  } catch (error) {
    if (!handleAuthLoss(error)) showError('tn-status', error);
  }
}

function renderTenants(v) {
  const date = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
  const a = v.activation;
  // Each English piece is its own element, so the page translator can reach it.
  $('tn-state').innerHTML = a?.valid
    ? `<div class="act-row"><strong>Several tenants</strong><span><span class="badge ok">Unlocked</span> ${escapeHtml(a.org)} · <span>Up to ${a.maxTenants} tenants</span> · <span>Until</span> <b>${escapeHtml(date(a.expires))}</b>${a.warn ? ` <strong class="https-note warn">${a.daysLeft} days left</strong>` : ''}</span></div>`
    : `<div class="act-row"><strong>Several tenants</strong><span>${a ? '<span class="badge warn">Expired</span>' : '<span class="badge muted">Not unlocked</span>'} <span>Apply a tenants activation code in Settings → Activation codes.</span></span></div>`;
  $('tn-enabled').checked = v.enabled;
  $('tn-enabled').disabled = !v.unlocked;
  $('tn-body').hidden = !v.enabled;
  $('tn-add').disabled = !v.unlocked;
  $('tn-list').innerHTML = v.tenants
    .map((t) => `<li><strong>${escapeHtml(t.name)}</strong>${t.first ? ' <span class="badge muted">First tenant</span>' : ''}${t.id === v.current ? ' <span class="badge">You are here</span>' : ''}
      <span class="hint">${t.people === 1 ? '1 person' : `${t.people} people`}</span>
      ${v.unlocked && !t.first ? `<button type="button" class="link" data-tn-rename="${escapeHtml(t.id)}">Rename</button><button type="button" class="link danger" data-tn-remove="${escapeHtml(t.id)}">Remove</button>` : ''}
      ${v.unlocked && t.first ? `<button type="button" class="link" data-tn-rename="${escapeHtml(t.id)}">Rename</button>` : ''}</li>`)
    .join('');
  tenantsView = v;
}
let tenantsView = null;

/** A change to the tenants: show it, and refresh the switcher at the top. */
async function tenantsChanged(view, message) {
  renderTenants(view);
  if (message) setStatus('tn-status', message, 'ok');
  try {
    state.me = { ...state.me, ...(await api('/api/me', { quiet: true })) };
    renderTenantPicker(state.me);
  } catch {}
}

export function wireActivationAndTenants() {
  $('act-apply').addEventListener('click', async () => {
    const code = $('act-code').value.trim();
    if (!code) return setStatus('act-status', 'Paste the activation code first.', 'error');
    $('act-apply').disabled = true;
    try {
      const result = await api('/api/activation', { method: 'POST', body: JSON.stringify({ code }) });
      renderActivation(result);
      $('act-code').value = '';
      setStatus('act-status', `Applied: ${result.applied}.`, 'ok');
      // A product code moves the licence's end: the banner follows.
      renderLicenceBanner(result.product);
      // A language turned on or off is offered (or not) at once.
      refreshMyLanguages();
    } catch (error) {
      if (!handleAuthLoss(error)) setStatus('act-status', error.message, 'error');
    } finally {
      $('act-apply').disabled = false;
    }
  });
  tenantMenu = initTenantMenu({ api, $, toast, handleAuthLoss, can, isConsolidatedPage: () => parseRoute().name === 'consolidated' });

  $('tn-enabled').addEventListener('change', async (event) => {
    const on = event.target.checked;
    try {
      await tenantsChanged(await api('/api/tenants/enabled', { method: 'POST', body: JSON.stringify({ on }) }), on ? 'Several tenants are on.' : 'Several tenants are off.');
    } catch (error) {
      event.target.checked = !on;
      if (!handleAuthLoss(error)) showError('tn-status', error);
    }
  });

  $('tn-add').addEventListener('click', async () => {
    const name = $('tn-name').value.trim();
    if (!name) return setStatus('tn-status', 'Give the tenant a name.', 'error');
    try {
      const result = await api('/api/tenants', { method: 'POST', body: JSON.stringify({ name }) });
      $('tn-name').value = '';
      await tenantsChanged(result, 'Added. Choose it at the top of the page to set it up.');
    } catch (error) {
      if (!handleAuthLoss(error)) showError('tn-status', error);
    }
  });

  $('tn-list').addEventListener('click', async (event) => {
    const rename = event.target.closest('[data-tn-rename]');
    const remove = event.target.closest('[data-tn-remove]');
    const id = rename?.dataset.tnRename ?? remove?.dataset.tnRemove;
    const tenant = tenantsView?.tenants.find((t) => t.id === id);
    if (!tenant) return;
    try {
      if (rename) {
        const name = prompt('New name for this tenant:', tenant.name);
        if (!name || name.trim() === tenant.name) return;
        await tenantsChanged(await api(`/api/tenants/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) }), 'Renamed.');
      } else {
        const typed = prompt(`Remove the tenant "${tenant.name}"? Its people lose access to it at once. Its files are kept in the state folder. Type its name to confirm:`);
        if (typed === null) return;
        await tenantsChanged(await api(`/api/tenants/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ confirm: typed.trim() }) }), 'Removed.');
      }
    } catch (error) {
      if (!handleAuthLoss(error)) showError('tn-status', error);
    }
  });
}

export function renderAbout() {
  $('about-version').textContent = state.health?.version || '—';
  const t = state.me?.terms;
  $('about-terms-state').textContent = t ? `Version ${t.version}${t.accepted ? ' — accepted by you' : ''}${t.organisationAccepted ? ', and for the organisation' : ''}` : '—';
  $('about-org').textContent = state.me?.organisationName || 'Not given yet';
  if (document.activeElement !== $('about-org-input')) $('about-org-input').value = state.me?.organisationName ?? '';
}

// ---- Settings → Update & recovery (Admin) -----------------------------------

const mzVersion = (v) => (v === 'built-in' ? 'the image’s own' : `MZ-${String(v).split('.').map((n) => n.padStart(2, '0')).join('.')}`);
let updState = null;
let updPoll = null;
/** Every version: the newest 3 at first, then 10 more per click. */
const UPD_PAGE = 10;
let updShown = 3;

export async function loadUpdates() {
  if (!can('system.update')) return;
  loadIntegrity();
  try {
    updState = await api('/api/system/update');
    renderUpdates();
    // What the page shows is never an old answer: a check older than 10 minutes is made again.
    const age = updState.lastCheck ? Date.now() - Date.parse(updState.lastCheck.at) : Infinity;
    if (age > 10 * 60_000 && !['running', 'switching'].includes(updState.job?.state)) {
      $('upd-latest-sub').textContent = 'Checking the registry…';
      updState = await api('/api/system/update/check', { method: 'POST', body: '{}', quiet: true });
      renderUpdates();
    }
  } catch (error) {
    if (!handleAuthLoss(error)) $('upd-status').textContent = error.message;
  }
}

// ---- Software integrity (Settings → Update & recovery) ----
const INTEGRITY_STATES = {
  genuine: ['Genuine', 'ok'],
  tampered: ['Files changed', 'bad'],
  'not-genuine': ['Not signed by the release workflow', 'bad'],
  unconfirmed: ['Not confirmed yet', 'warn'],
  unsigned: ['Development copy', 'muted'],
  checking: ['Checking…', 'muted'],
};

function renderIntegrity(r) {
  const [label, cls] = INTEGRITY_STATES[r.state] ?? [r.state, 'muted'];
  const badge = $('integrity-state');
  badge.textContent = label;
  badge.className = `badge ${cls}`;
  $('integrity-summary').textContent = r.summary ?? '';
  const facts = [];
  const o = r.origin?.ok ? r.origin : null;
  if (r.version) facts.push(['Version', mzVersion(r.version)]);
  if (o) facts.push(['Built from', `${o.repository} · ${o.ref.replace(/^refs\/(heads|tags)\//, '')} · ${o.commit.slice(0, 12)}`, `https://github.com/${o.repository}/commit/${o.commit}`]);
  if (o?.run) facts.push(['Workflow run', o.run.replace(/^https:\/\/github.com\//, ''), o.run]);
  if (o) facts.push(['Signed', `${new Date(o.signedAt).toLocaleString()} · Sigstore log entry ${o.logIndex}`, `https://search.sigstore.dev/?logIndex=${o.logIndex}`]);
  if (r.files) facts.push(['Files', `${r.files.checked} checked`]);
  if (r.digest) facts.push(['File list SHA-256', r.digest]);
  if (r.at) facts.push(['Checked', new Date(r.at).toLocaleString()]);
  $('integrity-facts').hidden = !facts.length;
  $('integrity-facts').innerHTML = facts
    .map(([k, v, href]) => `<dt>${escapeHtml(k)}</dt><dd translate="no">${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(v)}</a>` : escapeHtml(v)}</dd>`)
    .join('');
  const f = r.files;
  const differ = f && !f.ok;
  $('integrity-files').hidden = !differ;
  if (differ) {
    const more = (list, n) => (n > list.length ? [...list, `… and ${n - list.length} more`] : list);
    $('integrity-files-list').textContent = [
      ...more(f.changed, f.counts.changed).map((x) => `changed  ${x}`),
      ...more(f.missing, f.counts.missing).map((x) => `missing  ${x}`),
      ...more(f.extra, f.counts.extra).map((x) => `added    ${x}`),
    ].join('\n');
  }
}

async function loadIntegrity({ fresh = false } = {}) {
  if (!can('system.update')) return;
  try {
    renderIntegrity(await api(fresh ? '/api/integrity/check' : '/api/integrity', fresh ? { method: 'POST', body: '{}' } : { quiet: true }));
  } catch (error) {
    if (!handleAuthLoss(error)) $('integrity-summary').textContent = error.message;
  }
}

/** A moment on the Update page, to the second and with its time zone ("15 Oct 2026, 08:29:37 GMT+1"); UTC on hover. */
function updStamp(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const utc = `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  return `<time datetime="${d.toISOString()}" title="${utc}" translate="no">${escapeHtml(d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'long' }))}</time>`;
}

function renderUpdates() {
  const s = updState;
  if (!s) return;
  $('upd-running').textContent = mzVersion(s.running.version);
  // What runs, and since when it was chosen here (the exact moment, to the second).
  const chosenAt = s.running.source === 'update' && s.choice?.version === s.running.version ? updStamp(s.choice.at) : '';
  $('upd-running-sub').innerHTML = s.running.source === 'update'
    ? `<span>Installed from this page</span>${chosenAt ? `<small class="upd-when"><span>Switched to it</span> ${chosenAt}${s.choice.by ? ` <span translate="no">· ${escapeHtml(s.choice.by)}</span>` : ''}</small>` : ''}`
    : 'The image’s own version';
  const latest = s.latest;
  $('upd-latest').textContent = latest ? mzVersion(latest.version) : '—';
  $('upd-latest-sub').innerHTML = s.lastCheck
    ? s.lastCheck.error
      ? `Check failed: ${escapeHtml(s.lastCheck.error)}`
      : `<span>${s.updateAvailable ? 'Newer than what runs.' : 'Up to date.'}</span> <span>Checked</span> ${updStamp(s.lastCheck.at)}${s.lastCheck.warning ? ' <span>See the note below.</span>' : ''}`
    : 'Not checked yet';
  $('upd-latest-card').classList.toggle('upd-new', Boolean(s.updateAvailable));
  const install = $('upd-install-latest');
  install.hidden = !s.updateAvailable || !s.supervised;
  install.textContent = latest ? `Update now to ${mzVersion(latest.version)}` : 'Update now';
  const hour = $('upd-hour');
  if (hour.options.length === 1) for (let h = 0; h < 24; h += 1) hour.append(new Option(`${String(h).padStart(2, '0')}:00`, String(h)));
  $('upd-auto').checked = s.settings.auto;
  if (s.serverTime) {
    const clock = `${String(s.serverTime.hour).padStart(2, '0')}:${String(s.serverTime.minute).padStart(2, '0')}`;
    $('upd-zone').textContent = `(server time${s.serverTime.zone ? `, ${s.serverTime.zone}` : ''}: now ${clock})`;
  }
  hour.value = s.settings.windowHour === null ? '' : String(s.settings.windowHour);
  $('upd-auto-sub').textContent = s.settings.auto
    ? `Checked every 15 minutes${s.settings.windowHour === null ? '' : `, installed only at ${String(s.settings.windowHour).padStart(2, '0')}:00`}. A version that failed to start is never installed again by itself.${s.settings.lastAutoResult ? ` Last: ${s.settings.lastAutoResult}.` : ''}`
    : 'Off: you install updates here.';
  // What the check could not do (a blocked download host, older builds not named), in full, under the cards.
  const note = $('upd-check-note');
  note.hidden = !s.lastCheck?.warning;
  note.textContent = s.lastCheck?.warning ?? '';
  const warn = $('upd-warn');
  warn.hidden = s.supervised;
  warn.className = 'status warn';
  warn.textContent = s.supervised ? '' : 'This server was started with a custom command, so it cannot switch versions itself. Start the image with its own start command (no command after the image name) to update from here; until then, update with podman pull.';
  for (const id of ['upd-install-latest', 'upd-restart']) $(id).disabled = !s.supervised || ['running', 'switching'].includes(s.job?.state);

  const job = $('upd-job');
  job.hidden = !s.job;
  if (s.job) {
    const j = s.job;
    job.className = `upd-job ${j.state}`;
    job.textContent = j.state === 'failed' ? `Update to ${j.ref} failed: ${j.error}` : j.state === 'done' ? `MZ-${j.version} installed.` : `${j.step}${j.downloaded ? ` · ${Math.round(j.downloaded / 1024)} KB checked` : ''}…`;
  }
  const news = $('upd-news');
  news.innerHTML = s.job?.whatsNew?.length
    ? `<h3>What's new</h3>${s.job.whatsNew.map((n) => `<p><b>${escapeHtml(mzVersion(n.version))}</b> ${n.highlights.map(escapeHtml).join(' · ')}</p>`).join('')}`
    : '';

  const installed = new Map(s.installed.map((v) => [v.version, v]));
  const failed = new Set(s.failed);
  const rows = new Map((s.lastCheck?.versions ?? []).map((v) => [v.version, v]));
  for (const v of s.installed) if (!rows.has(v.version)) rows.set(v.version, { version: v.version, created: v.created, tags: [v.tag], local: true });
  const sorted = [...rows.values()].sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  // The newest 3, then 10 more at a time; what runs here is always shown.
  const runningHere = (v) => s.running.source === 'update' && v.version === s.running.version;
  const visible = sorted.filter((v, i) => i < updShown || runningHere(v));
  const busy = ['running', 'switching'].includes(s.job?.state);
  const button = (label, attrs, primary = false) => `<button type="button" class="${primary ? 'primary ' : ''}small" ${attrs} ${busy || !s.supervised ? 'disabled' : ''}>${label}</button>`;
  const body = visible.map((v) => {
    // The image's own version has its own row below: a published row of the same version points there.
    const inImage = v.version === s.builtIn && !installed.has(v.version);
    const running = s.running.source === 'update' && v.version === s.running.version && installed.has(v.version);
    const installedAt = installed.get(v.version)?.installedAt;
    const since = installedAt ? `<small class="hint upd-when"><span>Installed</span> ${updStamp(installedAt)}</small>` : '';
    const here = `${running ? '<span class="rp-chip tone-good">Running</span>' : installed.has(v.version) ? 'Installed' : inImage ? 'In the image (below)' : ''}${since}`;
    const flag = failed.has(v.version) ? ' <span class="rp-chip tone-critical" title="It did not start, and was rolled back by itself">Failed to start</span>' : '';
    const ref = (v.tags ?? []).find((t) => /^\d+\.\d+\.\d+$/.test(t)) ?? v.tags?.[0] ?? v.digest;
    const action = running || inImage ? '' : installed.has(v.version) ? button('Switch to', `data-upd-switch="${escapeHtml(v.version)}"`) : ref ? button('Install and switch', `data-upd-install="${escapeHtml(ref)}"`, v === sorted[0] && s.updateAvailable) : '';
    return `<tr><td>${escapeHtml(mzVersion(v.version))}${flag}</td><td>${updStamp(v.created)}</td><td>${here}</td><td>${action}</td></tr>`;
  });
  const imageRunning = s.running.source === 'image';
  body.push(`<tr><td>${escapeHtml(mzVersion(s.builtIn))} <span class="hint">(the image’s own)</span></td><td></td><td>${imageRunning ? '<span class="rp-chip tone-good">Running</span>' : 'In the image'}</td><td>${imageRunning ? '' : button('Switch to', 'data-upd-switch="built-in"')}</td></tr>`);
  $('upd-versions').querySelector('tbody').innerHTML = body.join('');
  const hidden = sorted.length - visible.length;
  const more = $('upd-more');
  more.hidden = hidden <= 0;
  more.textContent = `Load ${Math.min(UPD_PAGE, hidden)} more`;
  $('upd-count').textContent = sorted.length ? `${visible.length} of ${sorted.length} published version${sorted.length === 1 ? '' : 's'}` : '';

  const label = { started: 'Started', switch: 'Switch', restart: 'Restart', rollback: 'Rolled back', crash: 'Stopped unexpectedly' };
  $('upd-events').innerHTML = s.events.length
    ? s.events
        .slice(0, 12)
        .map((e) => `<li><span class="hint">${updStamp(e.at)}</span> <b>${escapeHtml(label[e.type] ?? e.type)}</b> ${escapeHtml(
          e.type === 'rollback' ? `${mzVersion(e.from)} → ${mzVersion(e.to)}: ${e.reason ?? ''}` : e.type === 'started' ? `${mzVersion(e.version)} came up in ${Math.round((e.ms ?? 0) / 1000)} s` : e.type === 'crash' ? `${mzVersion(e.version)} (code ${e.code ?? e.signal})` : `${e.from ? mzVersion(e.from) : ''}${e.to ? ` → ${mzVersion(e.to)}` : ''}${e.by ? ` by ${e.by}` : ''}`,
        )}</li>`)
        .join('')
    : '<li class="hint">Nothing yet.</li>';

  renderFullUpdate(s, sorted);

  clearTimeout(updPoll);
  if (busy || s.companion?.busy) updPoll = setTimeout(followUpdate, 2000);
}

const FULL_STATES = { running: 'Under way', done: 'Done', unchanged: 'Nothing to change', 'rolled-back': 'Went back to the previous container', failed: 'Failed', refused: 'Refused' };

/** The update companion (Beta): is it running, the image to replace with, and the last full update. */
function renderFullUpdate(s, versions) {
  const c = s.companion ?? {};
  const chip = $('upd-full-chip');
  const engineProblem = c.connected && c.heartbeat?.engineError;
  chip.textContent = !c.connected ? 'Companion not running' : engineProblem ? 'Companion: needs attention' : c.busy ? 'Replacing the image…' : 'Companion ready';
  chip.className = `rp-chip ${!c.connected ? '' : engineProblem ? 'tone-critical' : 'tone-good'}`;
  $('upd-full-on').hidden = !c.connected;
  $('upd-full-off').hidden = Boolean(c.connected);
  if (c.busy) $('upd-full').open = true;
  const select = $('upd-full-tag');
  const wanted = versions.map((v) => (v.tags ?? []).find((t) => /^\d+\.\d+\.\d+$/.test(t))).filter(Boolean);
  const current = select.value;
  select.innerHTML = ['latest', ...wanted].map((t) => `<option value="${escapeHtml(t)}">${t === 'latest' ? 'latest' : escapeHtml(mzVersion(t))}</option>`).join('');
  if (current && [...select.options].some((o) => o.value === current)) select.value = current;
  $('upd-full-go').disabled = !c.connected || c.busy || Boolean(engineProblem);
  const st = c.status;
  const lines = [];
  if (engineProblem) lines.push(`The companion cannot work: ${c.heartbeat.engineError}`);
  if (c.pending) lines.push(`Asked for ${c.pending.tag}: the companion picks it up within a few seconds.`);
  // While a new request waits, the last update's outcome is not news.
  if (st && !c.pending) {
    const when = st.finishedAt || st.at;
    lines.push(`${FULL_STATES[st.state] ?? st.state}: ${st.tag}${st.step ? ` · ${st.step}` : ''}${st.error ? ` · ${st.error}` : ''}${st.reason ? ` · ${st.reason}` : ''}${when ? ` (${new Date(when).toLocaleString()})` : ''}`);
  }
  $('upd-full-status').textContent = lines.join(' ');
}

/** While an update or switch runs: follow it, through the restart, to the new version. */
async function followUpdate() {
  const before = updState?.running.version;
  try {
    updState = await api('/api/system/update');
    renderUpdates();
    if (updState.running.version !== before) {
      $('upd-status').textContent = `Now running ${mzVersion(updState.running.version)}: reloading the page for its new screens…`;
      // The new version's own pages and scripts.
      setTimeout(() => location.reload(), 1500);
    }
  } catch {
    $('upd-status').textContent = 'Restarting: reconnecting in a few seconds…';
    updPoll = setTimeout(followUpdate, 2000);
  }
}

async function updateAction(path, body, message) {
  $('upd-status').textContent = message;
  try {
    updState = await api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
    renderUpdates();
    if (!updState?.job || updState.job.state === 'failed') loadUpdates();
    else updPoll = setTimeout(followUpdate, 1500);
  } catch (error) {
    if (!handleAuthLoss(error)) $('upd-status').textContent = error.message;
  }
}
const saveAutoUpdate = () =>
  api('/api/system/update/settings', { method: 'PUT', body: JSON.stringify({ auto: $('upd-auto').checked, windowHour: $('upd-hour').value === '' ? null : Number($('upd-hour').value) }) })
    .then((status) => {
      updState = status;
      renderUpdates();
      $('upd-status').textContent = status.settings.auto ? 'Auto-update on.' : 'Auto-update off.';
    })
    .catch((error) => !handleAuthLoss(error) && ($('upd-status').textContent = error.message));

export function wireAboutAndUpdates() {
  $('about-org-save').addEventListener('click', async () => {
    try {
      const { organisationName } = await api('/api/organisation-name', { method: 'PUT', body: JSON.stringify({ name: $('about-org-input').value }) });
      state.me = { ...state.me, organisationName };
      renderAbout();
      calculator.renderOrg();
      setStatus('about-org-status', 'Saved.', 'ok');
    } catch (error) {
      if (!handleAuthLoss(error)) showError('about-org-status', error);
    }
  });
  $('integrity-check').addEventListener('click', () => loadIntegrity({ fresh: true }));

  $('upd-full-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('upd-full-cmd').textContent.trim());
      toast('Copied: run it on the server.');
    } catch {
      toast('Select the command and copy it.');
    }
  });
  $('upd-full-go').addEventListener('click', () => {
    const tag = $('upd-full-tag').value;
    if (!tag || !confirm(`Replace the whole image with ${tag === 'latest' ? 'the latest one' : mzVersion(tag)}? A backup is taken first. The server stops for the switch (people see "reconnecting…" for up to a minute), and if the new container does not start, the companion goes back to this one.`)) return;
    $('upd-full-status').textContent = 'Asking the companion…';
    api('/api/system/update/full', { method: 'POST', body: JSON.stringify({ tag }) })
      .then((status) => {
        updState = status;
        renderUpdates();
        updPoll = setTimeout(followUpdate, 3000);
      })
      .catch((error) => !handleAuthLoss(error) && ($('upd-full-status').textContent = error.message));
  });

  $('upd-more').addEventListener('click', () => {
    updShown += UPD_PAGE;
    renderUpdates();
  });
  $('upd-check').addEventListener('click', () => updateAction('/api/system/update/check', {}, 'Checking the registry for published versions…').then(() => ($('upd-status').textContent = updState?.lastCheck?.error ? `Check failed: ${updState.lastCheck.error}` : `Checked: ${updState?.lastCheck?.versions?.length ?? 0} versions published${updState?.updateAvailable ? `, the newest is ${mzVersion(updState.latest.version)}` : ', nothing newer than what runs'}.`)));
  $('upd-install-latest').addEventListener('click', () => {
    const latest = updState?.latest;
    if (!latest || !confirm(`Update to ${mzVersion(latest.version)}? A backup is taken first. People see "reconnecting…" for a few seconds, and if it does not start, the current version comes back by itself.`)) return;
    updateAction('/api/system/update/install', { ref: latest.tags.find((t) => /^\d+\.\d+\.\d+$/.test(t)) ?? latest.tags[0] }, 'Downloading the update…');
  });
  $('upd-restart').addEventListener('click', () => {
    if (!confirm('Restart the server? Work in progress finishes first; people see "reconnecting…" for a few seconds.')) return;
    api('/api/system/update/restart', { method: 'POST', body: '{}' })
      .then(() => {
        $('upd-status').textContent = 'Restarting…';
        updPoll = setTimeout(followUpdate, 2500);
      })
      .catch((error) => !handleAuthLoss(error) && ($('upd-status').textContent = error.message));
  });
  $('upd-versions').addEventListener('click', (event) => {
    const install = event.target.closest('[data-upd-install]');
    const sw = event.target.closest('[data-upd-switch]');
    if (install) {
      if (!confirm(`Install ${install.closest('tr').cells[0].textContent.trim()} and switch to it? A backup is taken first; if it does not start, the current version comes back by itself.`)) return;
      updateAction('/api/system/update/install', { ref: install.dataset.updInstall }, 'Downloading…');
    } else if (sw) {
      const target = mzVersion(sw.dataset.updSwitch);
      if (!confirm(`Switch to ${target}? A backup is taken first. Going back to an older version can leave newer data it does not know about.`)) return;
      updateAction('/api/system/update/switch', { version: sw.dataset.updSwitch }, `Switching to ${target}…`);
    }
  });
  $('upd-auto').addEventListener('change', saveAutoUpdate);
  $('upd-hour').addEventListener('change', saveAutoUpdate);
}

// ---------------------------------------------------------------------------
// Reminder server address put into every report
// ---------------------------------------------------------------------------

const SERVER_SOURCES = {
  settings: 'set here',
  environment: 'from REPORT_SERVER_URL',
  'this page': 'the address this page is open on',
  'last dashboard address': 'the last address the dashboard was opened on',
  none: 'none',
};

export async function loadReportServer() {
  let info;
  try {
    info = await api('/api/report-server');
  } catch {
    return;
  }
  state.reportServer = info;
  if (state.page === 'dashboard') renderGettingStarted();
  const warnings = info.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
  const automatic = info.automatic.url !== info.url
    ? `<p class="hint">Automatic reminders (nobody at this page) use ${info.automatic.url ? `<code>${escapeHtml(info.automatic.url)}</code>` : '<strong>no address</strong>'} — set the address here to make them match.</p>`
    : '';
  $('server-effective').innerHTML = `
    <p>Reports use <code>${escapeHtml(info.url || 'no address')}</code> <span class="muted">(${escapeHtml(SERVER_SOURCES[info.source] ?? info.source)})</span></p>
    ${warnings ? `<ul class="server-warnings">${warnings}</ul>` : ''}
    ${automatic}`;
  const note = $('server-note');
  note.hidden = !info.warnings.length;
  note.innerHTML = info.warnings.length
    ? `Reports will point readers to <code>${escapeHtml(info.url || 'no address')}</code>: ${escapeHtml(info.warnings[0])} <a href="#/settings/server">Set the address</a>`
    : '';
}

// ---------------------------------------------------------------------------
// Checkmarx One integration (Settings): the server's own connection
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Settings → Network & proxy: the proxy, a check that says where a connection stops,
// and what the network team needs to allow (src/network.js)
// ---------------------------------------------------------------------------

const network = { text: '' };

export async function loadNetwork() {
  if (!$('network-form')) return;
  let info;
  try {
    info = await api('/api/network');
  } catch {
    return;
  }
  network.text = info.text;
  const p = info.proxy;
  const now = $('network-now');
  if (p) {
    now.textContent = `${p.source === 'environment' ? 'Using the proxy from the container (HTTPS_PROXY)' : 'Using the proxy'} ${p.url}${p.username ? `, signing in as ${p.username}` : ''}.${p.running ? '' : info.supervised ? ' Restarting to use it…' : ' Restart the server to use it.'}`;
  } else {
    now.textContent = 'Connecting directly, without a proxy.';
  }
  if (info.changedAt && !p?.running && !info.supervised) now.textContent += ' Restart the server to use the change.';
  if (p?.source === 'settings') {
    $('network-url').value = p.url;
    $('network-user').value = p.username ?? '';
    $('network-password').placeholder = p.hasPassword ? 'Saved: leave blank to keep it' : '';
    $('network-noproxy').value = p.noProxy ?? '';
  }
  $('network-remove').hidden = p?.source !== 'settings';
  $('network-target').placeholder = info.targets?.[0]?.host ?? 'ind.iam.checkmarx.net';
  $('network-rows').innerHTML = info.requirements
    .map((r) => `<tr><td>${escapeHtml(r.direction === 'In' ? 'Incoming' : 'Outgoing')}</td><td>${escapeHtml(r.what)}</td><td translate="no">${escapeHtml(r.host)}</td><td>${escapeHtml(r.port)}</td><td>${escapeHtml(r.route)}</td></tr>`)
    .join('');
}

const networkBody = () => ({
  url: $('network-url').value.trim(),
  username: $('network-user').value.trim(),
  password: $('network-password').value,
  noProxy: $('network-noproxy').value.trim(),
  target: $('network-target').value.trim(),
});

/** The steps of a check, each with a tick or a cross: where the connection stopped. */
function showNetworkSteps(results) {
  const names = { proxy: 'Proxy', tunnel: 'Connection', certificate: 'Certificate', answer: 'Checkmarx One' };
  const list = $('network-steps');
  list.hidden = !results?.length;
  list.innerHTML = (results ?? [])
    .map((r) => `<li><strong translate="no">${escapeHtml(r.host)}</strong><ul>${r.steps
      .map((s) => `<li class="${s.ok ? 'ok' : 'bad'}"><span class="net-mark" aria-hidden="true">${s.ok ? '✓' : '✕'}</span> <span class="net-name">${escapeHtml(names[s.step] ?? s.step)}</span> ${escapeHtml(s.detail)}${!s.ok ? networkAdvice(s) : ''}</li>`)
      .join('')}</ul></li>`)
    .join('');
}

/** What to do when a step failed. */
function networkAdvice(step) {
  let text = '';
  if (step.step === 'proxy') text = 'Check the proxy address and port with your network team.';
  else if (step.step === 'tunnel' && step.status === 407) text = 'The proxy wants a sign-in: give a user name and password, or ask for this server to be allowed by its IP address.';
  else if (step.step === 'tunnel' && step.status === 403) text = 'The proxy does not allow this host: ask your network team to allow *.checkmarx.net on port 443 for this server.';
  else if (step.step === 'tunnel') text = 'Ask your network team to allow this host on port 443 for this server, or set a proxy if one is required.';
  else if (step.step === 'certificate') text = 'Usually a proxy that inspects HTTPS: connect under Settings → Checkmarx One and click Trust and connect, or ask for an exception from inspection.';
  return text ? `<div class="hint">${escapeHtml(text)}</div>` : '';
}

/** Settings → Checkmarx One → Trusted certificates: the ones added here, each removable. */
export async function loadTrust() {
  const list = $('trust-list');
  if (!list) return;
  let info;
  try {
    info = await api('/api/trust');
  } catch {
    return;
  }
  const certs = info.certificates ?? [];
  $('trust-count').textContent = certs.length ? `(${certs.length})` : '';
  const how = { detected: 'Trusted from a connection', uploaded: 'Uploaded', intermediate: 'Fetched to complete a chain' };
  list.innerHTML = certs.length
    ? certs
        .map(
          (c) => `<li>
        <div><strong translate="no">${escapeHtml(c.subject)}</strong>${c.vendor ? ` <span class="calc-badge" translate="no">${escapeHtml(c.vendor)}</span>` : ''}${c.expired ? ' <span class="calc-badge warn">Expired</span>' : ''}</div>
        <div class="hint">${escapeHtml(how[c.source] ?? c.source)}${c.host ? ` · <span translate="no">${escapeHtml(c.host)}</span>` : ''} · ${escapeHtml(formatDate(c.addedAt))}${c.addedBy ? ` · <span translate="no">${escapeHtml(c.addedBy)}</span>` : ''} · valid until ${escapeHtml(formatDate(c.validTo))}</div>
        <div class="hint code cert-fp" translate="no">${escapeHtml(c.fingerprint256)}</div>
        <button type="button" class="link" data-trust-remove="${escapeHtml(c.fingerprint256)}">Remove</button>
      </li>`,
        )
        .join('')
    : '<li class="hint">None: only the public certificate authorities are trusted.</li>';
}

export async function loadIntegration() {
  loadTrust();
  let info;
  try {
    info = await api('/api/integration');
  } catch {
    return;
  }
  const c = info.connection ?? {};
  const source = { stored: 'key stored by an Admin', environment: 'CX_API_KEY on the server', none: 'not connected', 'stored (not reachable)': 'stored key — Checkmarx One not reachable' }[info.source] ?? info.source;
  $('connection-details').innerHTML = [
    ['Status', info.connected ? 'Connected' : 'Not connected'],
    ['Using', source],
    ['Tenant', c.tenant],
    ['API URL', c.baseUrl],
    ['IAM URL', c.iamUrl],
    ['Key expires', formatDate(c.expiresAt)],
  ]
    .map(([k, v]) => `<div><span class="k">${k}</span><span class="v">${escapeHtml(v ?? '—')}</span></div>`)
    .join('');
  $('integration-base').value = info.overrides?.baseUrl ?? '';
  $('integration-iam').value = info.overrides?.iamUrl ?? '';
  $('integration-tenant').value = info.overrides?.tenant ?? '';
  $('integration-remove').hidden = !info.keyStored;
  $('integration-key').placeholder = state.me?.via === 'cxone' ? 'Blank: use the key you signed in with' : 'Paste the API key for this server';
}

export function wireServerConnections() {
  $('test-report-server').addEventListener('click', async () => {
    const typed = $('link-report-server').value.trim().replace(/\/+$/, '');
    const url = typed || state.reportServer?.url || '';
    const box = $('server-effective');
    if (!url) {
      box.innerHTML = '<p class="status error">Enter an address first.</p>';
      return;
    }
    const result = document.createElement('p');
    result.className = 'status';
    result.textContent = `Checking ${url}…`;
    box.prepend(result);
    try {
      const response = await fetch(`${url}/api/relay/ping`, { cache: 'no-store' });
      const body = await response.json().catch(() => null);
      if (body?.service !== 'mission-zero-relay') throw new Error(`${url} answered, but not as this reminder server.`);
      result.className = 'status ok';
      result.textContent = `Reachable from this browser. Readers on other networks need the same access (company network or VPN).${typed && typed !== state.settings?.links?.reportServerUrl ? ' Save to use it.' : ''}`;
    } catch (error) {
      result.className = 'status error';
      result.textContent = error.message.includes('answered') ? error.message : `Could not reach ${url} from this browser: check the address, DNS and firewall.`;
    }
  });

  $('network-check')?.addEventListener('click', async () => {
    setStatus('network-status', $('network-url').value.trim() ? 'Checking through the proxy…' : 'Checking the direct connection…');
    try {
      const done = await api('/api/network/check', { method: 'POST', body: JSON.stringify(networkBody()) });
      showNetworkSteps(done.results);
      setStatus('network-status', done.ok ? 'Checkmarx One can be reached this way.' : 'Checkmarx One could not be reached this way: see the steps below.', done.ok ? 'ok' : 'error');
    } catch (error) {
      if (!handleAuthLoss(error)) showError('network-status', error);
    }
  });

  $('network-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    setStatus('network-status', 'Checking through the proxy before saving…');
    try {
      const done = await api('/api/network', { method: 'PUT', body: JSON.stringify(networkBody()) });
      showNetworkSteps(done.results);
      $('network-password').value = '';
      setStatus('network-status', done.restarting ? 'Saved. The server restarts to use the proxy; this page reconnects in a few seconds.' : 'Saved. Restart the server to use the proxy.', 'ok');
      loadNetwork();
    } catch (error) {
      if (handleAuthLoss(error)) return;
      showNetworkSteps(error.body?.results);
      showError('network-status', error);
    }
  });

  $('network-remove')?.addEventListener('click', async () => {
    if (!confirm('Stop using the proxy? This server then connects directly, which works only if your network allows it.')) return;
    try {
      const done = await api('/api/network', { method: 'DELETE' });
      for (const id of ['network-url', 'network-user', 'network-password', 'network-noproxy']) $(id).value = '';
      setStatus('network-status', done.restarting ? 'Removed. The server restarts to connect directly.' : 'Removed. Restart the server to connect directly.', 'ok');
      loadNetwork();
    } catch (error) {
      if (!handleAuthLoss(error)) showError('network-status', error);
    }
  });

  $('network-copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(network.text);
      setStatus('network-copy-status', 'Copied.', 'ok');
    } catch {
      setStatus('network-copy-status', 'Copying is blocked here: use Download.', 'error');
    }
  });

  $('network-download')?.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([network.text], { type: 'text/plain;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'missionzero-network-requirements.txt' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $('trust-list')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-trust-remove]');
    if (!button) return;
    if (!confirm('Stop trusting this certificate? Connections that need it stop working until it is trusted again.')) return;
    try {
      await api(`/api/trust/${encodeURIComponent(button.dataset.trustRemove)}`, { method: 'DELETE' });
      setStatus('trust-status', 'Removed.', 'ok');
      loadTrust();
    } catch (error) {
      if (!handleAuthLoss(error)) showError('trust-status', error);
    }
  });

  $('trust-pick')?.addEventListener('click', () => $('trust-file').click());

  $('trust-file')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setStatus('trust-status', 'Reading the certificate…');
    try {
      const done = await api('/api/trust/upload', { method: 'POST', body: JSON.stringify({ data: await certificateFileData(file) }) });
      setStatus('trust-status', done.added.length ? `Trusted ${done.added.map((a) => a.subject).join(', ')}.` : 'Already trusted.', 'ok');
      loadTrust();
    } catch (error) {
      if (!handleAuthLoss(error)) showError('trust-status', error);
    } finally {
      event.target.value = '';
    }
  });

  $('integration-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    // Connect & store verifies right away: the typed key need not also be saved as a draft.
    clearTimeout(autosave.draft);
    autosave.draft = null;
    setStatus('integration-status', 'Verifying the key against Checkmarx One…');
    try {
      await api('/api/integration/cxone', {
        method: 'POST',
        body: JSON.stringify({
          apiKey: $('integration-key').value.trim(),
          baseUrl: $('integration-base').value.trim(),
          iamUrl: $('integration-iam').value.trim(),
          tenant: $('integration-tenant').value.trim(),
        }),
      });
      $('integration-key').value = '';
      setStatus('integration-status', 'Connected and stored. Everyone signed in with a password now uses it.', 'ok');
      await loadIntegration();
      loadAutomation();
      loadConnectionGuard();
      const me = await api('/api/me');
      state.me = me;
      if (me.connection) {
        state.connection = me.connection;
        $('connection').textContent = `${me.connection.tenant} · ${me.connection.regionLabel} · ${me.connection.baseUrl}`;
        $('connection').className = 'sub conn-pill ok';
      }
    } catch (error) {
      if (!handleAuthLoss(error)) showError('integration-status', error);
    }
  });

  $('integration-remove').addEventListener('click', async () => {
    if (!confirm('Remove the stored Checkmarx One key? Password sign-ins, report triage and automation stop working until a key is stored again (unless CX_API_KEY is set on the server).')) return;
    try {
      await api('/api/integration/cxone', { method: 'DELETE' });
      setStatus('integration-status', 'Stored key removed.', 'ok');
      loadIntegration();
      loadAutomation();
      loadConnectionGuard();
    } catch (error) {
      if (!handleAuthLoss(error)) showError('integration-status', error);
    }
  });
}

// ---------------------------------------------------------------------------
// Settings → HTTPS (Admin): http → http and HTTPS side by side → HTTPS only, on the
// running server, with every certificate checked the way a browser would before use
// ---------------------------------------------------------------------------

const httpsUi = { status: null, files: [], candidate: null };
const HTTPS_MODES = { http: 'HTTP only', both: 'HTTP + HTTPS side by side', https: 'HTTPS only' };
const CERT_SOURCES = { uploaded: 'uploaded here', environment: 'from the container options', 'self-signed': 'self-signed, made here' };
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

export async function loadHttps() {
  if (!can('security.https')) return;
  try {
    renderHttps(await api('/api/https', { quiet: true }));
  } catch (error) {
    if (!handleAuthLoss(error)) showError('https-status', error);
  }
}

function certCard(report, { title, candidate = false } = {}) {
  if (!report?.summary) {
    return `<div class="https-cert"><ul class="https-checks"><li class="error"><span>${escapeHtml(report?.error || 'The certificate could not be read.')}</span></li></ul></div>`;
  }
  const s = report.summary;
  const fromLetsEncrypt = report.source === 'uploaded' && /^Let's Encrypt/.test(httpsUi.status?.uploaded?.by ?? '') && !candidate;
  const meta = [fromLetsEncrypt ? "from Let's Encrypt" : CERT_SOURCES[report.source], s.keyType, report.kind === 'pfx' ? '.pfx' : ''].filter(Boolean).join(' · ');
  const chain = s.chain.length > 1 ? `<div class="chain">Chain: ${s.chain.map((c) => escapeHtml(c.subject)).join(' → ')}</div>` : '';
  const notes = report.notes?.length ? `<ul class="notes">${report.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : '';
  return `<div class="https-cert${candidate ? ' candidate' : ''}">
    <div class="title">${escapeHtml(title)}: ${escapeHtml(s.subject)} <small>${escapeHtml(meta)}</small></div>
    ${chain}
    <ul class="https-checks">${report.checks.map((c) => `<li class="${c.level}"><span>${escapeHtml(c.title)}${c.detail ? `<small>${escapeHtml(c.detail)}</small>` : ''}</span></li>`).join('')}</ul>
    ${notes}
  </div>`;
}

function renderHttps(s) {
  httpsUi.status = s;
  const cert = s.certificate;
  const realCert = Boolean(cert?.summary && cert.source !== 'self-signed');
  const badge = $('https-badge');
  badge.className = `https-badge ${s.mode}`;
  badge.textContent = HTTPS_MODES[s.mode];

  const tile = (label, value) => `<div class="tile"><b>${escapeHtml(label)}</b><span>${value}</span></div>`;
  const reminder = s.reminderServer?.url || '';
  $('https-now').innerHTML = [
    tile('This page is open over', s.viewing.secure ? `<strong>HTTPS</strong> (${escapeHtml(s.viewing.host)})` : `http (${escapeHtml(s.viewing.host)})`),
    tile('Certificate', cert?.summary ? `${escapeHtml(cert.summary.subject)}, until ${escapeHtml(day(cert.summary.validTo))}${cert.summary.daysLeft < 30 ? ` <strong class="https-note warn">(${cert.summary.daysLeft} days left)</strong>` : ''}` : 'None yet'),
    tile('Reports opened, last 24 h', `${s.reportOpens.https} over HTTPS · ${s.reportOpens.http} over http`),
    tile('Reports point readers to', reminder ? `<code>${escapeHtml(reminder)}</code>` : 'no address yet'),
    tile('Last change', s.changedAt ? `${escapeHtml(day(s.changedAt))} by ${escapeHtml(s.changedBy || 'the server')}` : `Container start setting (HTTPS=${escapeHtml(s.startMode === 'http' ? 'off' : s.startMode === 'https' ? 'on' : 'both')})`),
  ].join('');

  // 1. Certificate
  renderAcme(s.acme, s);
  $('https-cert-current').innerHTML = cert ? certCard(cert, { title: 'In use' }) : '<p class="hint">None yet. Turning HTTPS on makes a self-signed one to start with; upload your company certificate to replace it.</p>';
  $('https-files-label').textContent = realCert ? 'Choose files to replace it' : 'Choose certificate files';
  const actions = [];
  if (s.previous) actions.push(`<button type="button" id="https-previous">Put the previous certificate back (${escapeHtml(s.previous.subject)}, until ${escapeHtml(day(s.previous.validTo))})</button>`);
  if (s.uploaded) actions.push(`<button type="button" class="link" id="https-remove">Stop using the uploaded certificate</button>`);
  if (cert?.source === 'self-signed') actions.push(`<button type="button" class="link" id="https-selfsign">Make a new self-signed one for the names in use</button>`);
  $('https-cert-actions').innerHTML = actions.join('');
  if (!$('https-csr-names').value) {
    const names = new Set();
    for (const value of [s.viewing.host, reminder]) {
      try {
        const host = new URL(/^https?:/.test(value) ? value : `http://${value}`).hostname;
        if (host && !/^(localhost|127\.|\[?::1)/.test(host)) names.add(host);
      } catch {}
    }
    $('https-csr-names').value = [...names].join(', ');
  }
  $('https-csr-download').hidden = !s.request?.available;
  if (s.request) setStatus('https-csr-status', `Request for ${s.request.names.join(', ')} made ${day(s.request.at)}: waiting for the certificate from IT.`);

  // 2. Side by side
  $('https-both').disabled = s.mode !== 'http';
  $('https-both').textContent = s.mode === 'http' ? 'Turn on HTTPS next to http' : 'HTTPS is on';
  setStatus('https-both-status', s.mode === 'http' ? '' : `Answering at ${s.viewing.httpsUrl}${s.mode === 'both' ? ` and ${s.viewing.httpUrl}` : ''}.`, s.mode === 'http' ? '' : 'ok');

  // 3. Test
  $('https-open').href = `${s.viewing.httpsUrl}/#/settings/https`;
  $('https-open').classList.toggle('disabled', s.mode === 'http');
  $('https-check-browser').disabled = s.mode === 'http';
  const check = s.lastBrowserCheck;
  if (check && !$('https-browser-result').dataset.fresh) {
    $('https-browser-result').className = `https-browser ${check.ok ? 'good' : 'bad'}`;
    $('https-browser-result').textContent = `${check.ok ? '✓ Accepted' : '✕ Refused'} by ${check.by || 'a browser'} on ${day(check.at)} (${check.url}).`;
  }
  $('https-reports-hint').textContent = s.mode === 'both'
    ? `Emailed reports opened from now on try HTTPS and keep to it on machines where it works. Last 24 hours: ${s.reportOpens.https} opened over HTTPS, ${s.reportOpens.http} over http. When http keeps falling, it is time for step 4.`
    : s.mode === 'https' ? 'Reports that still use the old http address are told the new one, and switch by themselves.' : '';

  // 4. HTTPS only
  const switchButton = $('https-switch');
  switchButton.disabled = s.mode !== 'both' || !s.viewing.secure;
  switchButton.textContent = s.mode === 'https' ? 'HTTPS only is on' : 'Switch to HTTPS only';
  $('https-undo').hidden = s.mode !== 'https';
  const addressHttps = /^https:/i.test(reminder);
  $('https-update-address').closest('label').hidden = addressHttps || s.mode === 'https';
  $('https-update-address-label').textContent = `Also put ${s.viewing.httpsUrl} into new reports, as the Reminder server address (now ${reminder || 'none'})`;
  const hint = $('https-switch-hint');
  hint.className = 'https-note';
  if (s.mode === 'both' && !s.viewing.secure) {
    hint.className = 'https-note warn';
    hint.innerHTML = `Open this page over HTTPS to switch: <a href="${escapeHtml(s.viewing.httpsUrl)}/#/settings/https">${escapeHtml(s.viewing.httpsUrl)}</a>. That proves HTTPS works from your browser before http goes away.`;
  } else if (s.mode === 'both' && cert?.trust === 'self-signed') {
    hint.className = 'https-note warn';
    hint.textContent = 'The certificate is self-signed: after the switch every browser warns. Upload your company certificate first (step 1).';
  } else if (s.mode === 'https') {
    hint.textContent = `http://${s.viewing.host.replace(/^https?:\/\//, '')} now redirects to HTTPS.`;
  } else hint.textContent = '';

  // 5. Harden
  const canHarden = s.mode === 'https' && realCert;
  for (const id of ['https-hsts', 'https-hsts-age', 'https-hsts-sub', 'https-min-version', 'https-harden-save']) $(id).disabled = id === 'https-min-version' || id === 'https-harden-save' ? s.mode === 'http' : !canHarden;
  $('https-hsts').checked = Boolean(s.hsts.enabled);
  $('https-hsts-age').value = String(s.hsts.maxAge);
  $('https-hsts-sub').checked = Boolean(s.hsts.includeSubDomains);
  $('https-min-version').value = s.minVersion;
  if (!canHarden && s.mode === 'https') setStatus('https-harden-status', 'HSTS needs a certificate from IT or a public authority, not a self-signed one.');

  // Where the Admin is in the five steps.
  const done = {
    'https-step-cert': realCert && cert.usable,
    'https-step-both': s.mode !== 'http',
    'https-step-test': s.mode === 'https' || Boolean(check?.ok),
    'https-step-switch': s.mode === 'https',
    'https-step-harden': Boolean(s.hstsActive),
  };
  const locked = { 'https-step-test': s.mode === 'http', 'https-step-switch': s.mode === 'http', 'https-step-harden': s.mode !== 'https' };
  let current = '';
  for (const id of Object.keys(done)) {
    if (!current && !done[id] && !locked[id]) current = id;
    $(id).classList.toggle('done', done[id]);
    $(id).classList.toggle('locked', Boolean(locked[id]));
  }
  for (const id of Object.keys(done)) $(id).classList.toggle('current', id === current);

  let zone = 'UTC';
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {}
  $('https-ports-cmd').textContent = `podman run --replace -d --name mission-zero -p 443:3000 -p 80:3000 -v mission-zero-data:/data -e TZ=${zone} --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest`;
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

async function chooseHttpsFiles(list) {
  const files = [...(list ?? [])].slice(0, 10);
  if (!files.length) return;
  const big = files.find((f) => f.size > 256 * 1024);
  if (big) {
    $('https-candidate').innerHTML = `<p class="status error">${escapeHtml(big.name)} is larger than 256 KB, so it is not a certificate file.</p>`;
    return;
  }
  httpsUi.files = await Promise.all(files.map(async (f) => ({ name: f.name, data: toBase64(await f.arrayBuffer()) })));
  if (files.some((f) => /\.(pfx|p12)$/i.test(f.name))) $('https-pass-field').hidden = false;
  await inspectHttps();
}

async function inspectHttps() {
  const box = $('https-candidate');
  if (!httpsUi.files.length) return;
  box.innerHTML = `<p class="status">Checking ${escapeHtml(httpsUi.files.map((f) => f.name).join(', '))}…</p>`;
  try {
    const report = await api('/api/https/inspect', { method: 'POST', body: JSON.stringify({ files: httpsUi.files, passphrase: $('https-passphrase').value }) });
    httpsUi.candidate = report;
    const replacing = httpsUi.status?.certificate?.source && httpsUi.status.certificate.source !== 'self-signed';
    const warnings = report.checks.filter((c) => c.level === 'warn').length;
    box.innerHTML = `${certCard(report, { title: replacing ? 'Replacement' : 'New certificate', candidate: true })}
      <div class="actions compact">
        <button type="button" class="primary" id="https-use">${replacing ? 'Replace the certificate in use' : 'Use this certificate'}</button>
        <button type="button" class="link" id="https-discard">Choose other files</button>
        <span class="hint">${warnings ? 'It works; the warnings are what some people may see.' : 'Goes into use at once, with no restart. The one it replaces is kept, to put back in one click.'}</span>
      </div>`;
  } catch (error) {
    if (handleAuthLoss(error)) return;
    if (error.body?.needsPassphrase) {
      $('https-pass-field').hidden = false;
      $('https-passphrase').focus();
    }
    box.innerHTML = `<div class="https-cert"><ul class="https-checks"><li class="error"><span>${escapeHtml(error.message)}</span></li></ul></div>`;
  }
}

async function installHttps(confirmed = false) {
  try {
    const result = await api('/api/https/certificate', { method: 'POST', body: JSON.stringify({ files: httpsUi.files, passphrase: $('https-passphrase').value, confirm: confirmed }) });
    httpsUi.files = [];
    httpsUi.candidate = null;
    $('https-passphrase').value = '';
    $('https-pass-field').hidden = true;
    $('https-candidate').innerHTML = `<p class="status ok">In use now: ${escapeHtml(result.report.summary.subject)}, until ${escapeHtml(day(result.report.summary.validTo))}.</p>`;
    renderHttps(result.status);
    toast('The new certificate is in use. Nothing restarted.', 'good');
  } catch (error) {
    if (handleAuthLoss(error)) return;
    if (error.body?.needsConfirm && confirm(error.message)) return installHttps(true);
    $('https-candidate').insertAdjacentHTML('beforeend', `<p class="status error">${escapeHtml(error.message)}</p>`);
  }
}

async function setHttpsMode(mode, extra = {}, statusId = 'https-switch-status') {
  try {
    const result = await api('/api/https/mode', { method: 'POST', body: JSON.stringify({ mode, ...extra }) });
    renderHttps(result);
    if (result.addressChanged) {
      loadReportServer();
      toast(`New reports use ${result.addressChanged}.`, 'good');
    }
    setStatus(statusId, '');
  } catch (error) {
    if (handleAuthLoss(error)) return;
    if (error.body?.needsConfirm && confirm(error.message)) return setHttpsMode(mode, { ...extra, confirm: true }, statusId);
    setStatus(statusId, error.message, 'error');
  }
}

async function httpsAction(request, okMessage) {
  try {
    renderHttps(await request());
    if (okMessage) toast(okMessage, 'good');
  } catch (error) {
    if (handleAuthLoss(error)) return;
    setStatus('https-status', error.message, 'error');
  }
}
// ---- Free certificate from Let's Encrypt ----

let acmePoll = null;

/** The Let's Encrypt card: what it is doing, what it got, and when it renews. */
function renderAcme(a, s = httpsUi.status) {
  if (!a) return;
  if (!$('https-le-names').value) {
    const names = a.names?.length ? a.names : a.suggested?.length ? a.suggested : [];
    $('https-le-names').value = names.join(', ');
  }
  if (!$('https-le-email').value && a.email) $('https-le-email').value = a.email;
  if (a.staging) $('https-le-staging').checked = true;
  $('https-le-get').disabled = a.running;
  $('https-le-get').textContent = a.issued ? 'Get a new certificate' : 'Get a free certificate';
  $('https-le-renew').hidden = !a.enabled || a.running;
  $('https-le-stop').hidden = !a.enabled || a.running;
  const last = a.last;
  if (a.running) setStatus('https-le-status', 'Asking Let\'s Encrypt… This usually takes under a minute.');
  else if (last?.running) setStatus('https-le-status', 'The last request did not finish (the server restarted). Try again.', 'warn');
  else if (last?.ok) setStatus('https-le-status', `Certificate for ${last.names.join(', ')} put to use on ${day(last.at)}.`, 'ok');
  else if (last && !last.ok) setStatus('https-le-status', last.error, 'error');
  else setStatus('https-le-status', '');
  const info = [];
  if (a.fromEnvironment) info.push(`Set up when the server was deployed (LETSENCRYPT_DOMAIN=${a.fromEnvironment}).`);
  if (a.issued) {
    info.push(`In use until ${day(a.issued.validTo)} (${a.daysLeft} days left)${a.issued.staging ? ', from the staging service: browsers do not trust it' : ''}.`);
    info.push(a.enabled ? `Renewed by itself from ${day(a.renewsFrom)}.` : 'Automatic renewal is off.');
  }
  if (a.issued && !a.issued.staging && s?.mode === 'both') info.push('Next: open this page over HTTPS and switch to HTTPS only (step 4).');
  $('https-le-info').textContent = info.join(' ');
  clearTimeout(acmePoll);
  if (a.running) {
    acmePoll = setTimeout(async () => {
      try {
        const next = await api('/api/https/acme', { quiet: true });
        if (next.running) renderAcme(next);
        else loadHttps();
      } catch (error) {
        if (!handleAuthLoss(error)) setStatus('https-le-status', error.message, 'error');
      }
    }, 2000);
  }
}

export function wireHttps() {
  $('https-files').addEventListener('change', () => {
    chooseHttpsFiles($('https-files').files).finally(() => ($('https-files').value = ''));
  });
  for (const type of ['dragenter', 'dragover']) {
    $('https-drop').addEventListener(type, (event) => {
      event.preventDefault();
      $('https-drop').classList.add('over');
    });
  }
  for (const type of ['dragleave', 'drop']) $('https-drop').addEventListener(type, () => $('https-drop').classList.remove('over'));
  $('https-drop').addEventListener('drop', (event) => {
    event.preventDefault();
    chooseHttpsFiles(event.dataTransfer?.files);
  });
  $('https-passphrase').addEventListener('change', () => inspectHttps());
  $('https-candidate').addEventListener('click', (event) => {
    if (event.target.id === 'https-use') installHttps();
    if (event.target.id === 'https-discard') {
      httpsUi.files = [];
      $('https-candidate').innerHTML = '';
    }
  });
  $('https-cert-actions').addEventListener('click', (event) => {
    if (event.target.id === 'https-previous') httpsAction(() => api('/api/https/certificate/previous', { method: 'POST' }), 'The previous certificate is in use again.');
    if (event.target.id === 'https-selfsign') httpsAction(() => api('/api/https/self-signed', { method: 'POST', body: JSON.stringify({ names: [] }) }), 'A new self-signed certificate is in use.');
    if (event.target.id === 'https-remove') {
      const remove = (confirmed) => api(`/api/https/certificate${confirmed ? '?confirm=1' : ''}`, { method: 'DELETE' });
      httpsAction(async () => {
        try {
          return await remove(false);
        } catch (error) {
          if (error.body?.needsConfirm && confirm(error.message)) return remove(true);
          throw error;
        }
      }, 'The uploaded certificate is no longer used.');
    }
  });

  $('https-le-get').addEventListener('click', async () => {
    const names = $('https-le-names').value.split(/[\s,;]+/).filter(Boolean);
    if (!names.length) return setStatus('https-le-status', 'Enter the name people use to reach this server, e.g. mz.company.com.', 'error');
    if (!$('https-le-agree').checked) return setStatus('https-le-status', 'Tick the box to agree to the Let\'s Encrypt Subscriber Agreement first.', 'error');
    try {
      renderAcme(await api('/api/https/acme', {
        method: 'POST',
        body: JSON.stringify({ names, email: $('https-le-email').value.trim(), agree: true, staging: $('https-le-staging').checked, skipPrecheck: $('https-le-skip').checked }),
      }));
    } catch (error) {
      if (!handleAuthLoss(error)) setStatus('https-le-status', error.message, 'error');
    }
  });
  $('https-le-renew').addEventListener('click', async () => {
    try {
      renderAcme(await api('/api/https/acme/renew', { method: 'POST' }));
    } catch (error) {
      if (!handleAuthLoss(error)) setStatus('https-le-status', error.message, 'error');
    }
  });
  $('https-le-stop').addEventListener('click', async () => {
    if (!confirm('Stop renewing the Let\'s Encrypt certificate by itself? It stays in use until it expires or you replace it.')) return;
    try {
      renderAcme(await api('/api/https/acme', { method: 'DELETE' }));
    } catch (error) {
      if (!handleAuthLoss(error)) setStatus('https-le-status', error.message, 'error');
    }
  });

  $('https-csr-create').addEventListener('click', async () => {
    const names = $('https-csr-names').value.split(/[\s,;]+/).filter(Boolean);
    if (!names.length) {
      setStatus('https-csr-status', 'Enter the name people use to reach this server, e.g. mz.company.com.', 'error');
      return;
    }
    try {
      const result = await api('/api/https/request', { method: 'POST', body: JSON.stringify({ names, organization: $('https-csr-org').value.trim() }) });
      renderHttps(result.status);
      setStatus('https-csr-status', 'Downloaded. Send cxmissionzero.csr to IT and ask for a server certificate with its chain.', 'ok');
      $('https-csr-download').click();
    } catch (error) {
      if (!handleAuthLoss(error)) setStatus('https-csr-status', error.message, 'error');
    }
  });
  $('https-both').addEventListener('click', () => setHttpsMode('both', {}, 'https-both-status'));
  $('https-switch').addEventListener('click', () => {
    const s = httpsUi.status;
    if (!confirm(`Switch to HTTPS only? Plain http (${s.viewing.httpUrl}) will redirect to ${s.viewing.httpsUrl}. You can go back to both at any time.`)) return;
    setHttpsMode('https', { updateAddress: !$('https-update-address').closest('label').hidden && $('https-update-address').checked });
  });
  $('https-undo').addEventListener('click', () => setHttpsMode('both'));
  $('https-check-browser').addEventListener('click', async () => {
    const s = httpsUi.status;
    const url = s.viewing.httpsUrl;
    const out = $('https-browser-result');
    out.dataset.fresh = '1';
    out.className = 'https-browser';
    out.textContent = `Connecting to ${url} from this browser…`;
    let ok = false;
    try {
      const response = await fetch(`${url}/api/relay/ping`, { cache: 'no-store' });
      ok = (await response.json()).service === 'mission-zero-relay';
    } catch {}
    out.className = `https-browser ${ok ? 'good' : 'bad'}`;
    out.textContent = ok
      ? `✓ This browser connects to ${url} with no certificate error.${s.viewing.secure ? ' (If you clicked past a warning on this page earlier, that counts too: check the padlock.)' : ''}`
      : `✕ This browser refused ${url}: it does not trust the certificate${s.certificate?.trust === 'self-signed' ? ' (self-signed)' : ''}, or the address is not a name in it. Open it to see the browser's reason.`;
    api('/api/https/browser-check', { method: 'POST', quiet: true, body: JSON.stringify({ ok, url }) }).catch(() => {});
    if (ok) $('https-step-test').classList.add('done');
  });
  $('https-harden-save').addEventListener('click', async () => {
    const hsts = { enabled: $('https-hsts').checked, maxAge: Number($('https-hsts-age').value), includeSubDomains: $('https-hsts-sub').checked };
    const label = $('https-hsts-age').selectedOptions[0]?.textContent.replace(/ \(.*\)$/, '') ?? '';
    if (hsts.enabled && !httpsUi.status.hsts.enabled && !confirm(`Turn on HSTS? Browsers that visit will use only HTTPS here for ${label}, even if this server goes back to http. Start short (1 day), then lengthen it.`)) return;
    try {
      renderHttps(await api('/api/https/hardening', { method: 'POST', body: JSON.stringify({ hsts, minVersion: $('https-min-version').value }) }));
      setStatus('https-harden-status', 'Applied.', 'ok');
    } catch (error) {
      if (!handleAuthLoss(error)) setStatus('https-harden-status', error.message, 'error');
    }
  });
}
