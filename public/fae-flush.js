/**
 * FAE Flush (Labs, then Act): the page. The run itself is on the server (src/fae-flush.js); this shows the
 * projects it would take (ticked to choose), starts it (asking first whether to delete or keep the _FAE
 * projects), shows each project's progress and timeline, asks about the ones that stopped, and offers Mark now,
 * Pause, Undo, Export and Delete all _FAE. The Value tab shows what every run has been worth; Troubleshoot tests
 * one project, keeps a debug log and chooses where the code comes from.
 */
const STEP_LABEL = {
  waiting: 'Waiting',
  copying: 'Copying the code',
  scanning: 'Scanning',
  comparing: 'Comparing',
  'needs-ok': 'Asks you',
  reported: 'Ready to mark',
  marking: 'Marking',
  revalidating: 'Revalidating',
  cleaning: 'Removing _FAE',
  done: 'Done',
  skipped: 'Skipped',
  'left-out': 'Left out',
  undone: 'Undone',
};
const STEP_KIND = { done: 'ok', skipped: 'muted', 'left-out': 'muted', undone: 'muted', 'needs-ok': 'warn', waiting: 'muted', reported: 'run' };
const ACTIVE = new Set(['copying', 'scanning', 'comparing', 'marking', 'revalidating', 'cleaning']);
const SEVERITIES = [['CRITICAL', 'Critical'], ['HIGH', 'High'], ['MEDIUM', 'Medium'], ['LOW', 'Low']];
const num = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString());
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');
const csvText = (rows) => rows.map((r) => r.map((v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''))).join(',')).join('\n');

/** Roughly how long: the projects' last SAST scans, so many at once. */
export function estimate(preview, concurrency, count = preview?.eligible ?? 0) {
  const share = preview?.eligible ? count / preview.eligible : 0;
  const seconds = ((preview?.sastSeconds ?? 0) * share) / Math.max(1, concurrency) + (count * 60) / Math.max(1, concurrency);
  if (!seconds) return '—';
  const h = seconds / 3600;
  return h >= 1 ? `≈ ${h.toFixed(h < 10 ? 1 : 0)} h` : `≈ ${Math.max(1, Math.round(seconds / 60))} min`;
}

/** The run's figures, a row per project, as the page gives them. */
export function csvOf(job) {
  const state = job?.options?.markAs === 'ne' ? 'Not exploitable' : 'Proposed not exploitable';
  const rows = [['Project', 'Step', 'Code from', 'To verify (results)', 'To verify (findings)', 'Reported by FAE', 'Not reported', `Marked ${state} (results)`, 'Marked (findings)', 'Revalidated', 'FAE project', 'FAE scan', 'Note']];
  for (const p of job?.projects ?? []) {
    const c = p.counts ?? {};
    rows.push([p.name, STEP_LABEL[p.step] ?? p.step, p.codeSource ?? '', c.toVerify ?? '', c.toVerifyFindings ?? '', c.reported ?? '', c.notReported ?? '', c.marked ?? p.markedCount ?? '', c.markedFindings ?? '', c.revalidated ?? '', p.faeProjectId ? `${p.name}_FAE${p.faeDeleted ? ' (deleted)' : ''}` : '', p.faeScanId ?? '', p.exception?.text ?? p.note ?? '']);
  }
  return csvText(rows);
}

/** What every run has been worth, a row per project and run. */
export function valueCsvOf(value) {
  const currency = value?.saved?.currency ?? '';
  const rows = [['Project', 'Runs', 'To verify', 'False positives removed (results)', 'False positives removed (findings)', `Money saved (${currency})`, 'Last']];
  for (const p of value?.projects ?? []) rows.push([p.project, p.runs, p.toVerify, p.kept, p.keptFindings ?? '', p.money ?? '', p.last]);
  rows.push([]);
  rows.push(['Run started', 'By', 'Marked as', 'Projects', 'To verify', 'Marked', 'Revalidated', 'Undone', `Money saved (${currency})`]);
  for (const r of value?.runs ?? []) rows.push([r.at, r.by, r.state === 'NOT_EXPLOITABLE' ? 'Not exploitable' : 'Proposed not exploitable', r.projects, r.toVerify, r.marked, r.revalidated, r.undone, r.money ?? '']);
  rows.push([]);
  const s = value?.saved ?? {};
  rows.push(['Minutes per triage', s.minutesPerTriage ?? '', 'Hourly cost', s.hourlyRate ?? '', 'Credit price', s.creditPrice ?? '', 'Money saved', s.money ?? '']);
  return csvText(rows);
}

export function initFaeFlush({ api, $, esc, toast, showError, setStatus, can, fmtDateTime, t = (s) => s }) {
  let view = null;
  let value = null;
  let timer = 0;
  // The projects ticked (by id): every one that can be flushed, until changed.
  let chosen = null;
  let chosenFrom = '';
  let opened = '';
  const allowed = () => can('integration.cxone');
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
  const picked = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
  // The run marks them Not exploitable (chosen at its start, Admins only), or Proposed not exploitable.
  const ne = () => view?.job?.options?.markAs === 'ne';
  const markAsChosen = () => (can('faeFlush.notExploitable') && picked('flush-markas') === 'ne' ? 'ne' : 'pne');
  const showMarkAs = () => {
    $('flush-markas-dd').hidden = !can('faeFlush.notExploitable');
    const final = markAsChosen() === 'ne';
    $('flush-markas-hint').hidden = final || !can('faeFlush.notExploitable');
    $('flush-markas-warn').hidden = !final;
  };
  for (const radio of document.querySelectorAll('input[name="flush-markas"]')) radio.addEventListener('change', showMarkAs);
  const save = (name, blob) => {
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  async function load({ quiet = false } = {}) {
    clearTimeout(timer);
    try {
      view = await api('/api/fae-flush', { quiet: true });
      render();
    } catch (error) {
      if (!quiet) showError('flush-status', error);
    }
    // While something is under way (a preview, a run), look again.
    const busy = view?.previewing || view?.job?.state === 'running';
    if (busy && !$('page-flush').hidden) timer = setTimeout(() => load({ quiet: true }), view?.previewing ? 1500 : 4000);
  }

  async function loadValue() {
    try {
      value = await api('/api/fae-flush/value', { quiet: true });
      renderValue();
    } catch (error) {
      showError('flush-status', error);
    }
  }

  function eligible() {
    return (view?.preview?.projects ?? []).filter((p) => !p.leftOut);
  }

  function render() {
    const { preview, job, summary } = view ?? {};
    showMarkAs();
    $('flush-perm-note').hidden = allowed();
    for (const id of ['flush-preview', 'flush-start', 'flush-pause', 'flush-undo', 'flush-delete-fae', 'flush-mark-now']) $(id).hidden = !allowed();
    if (!view?.connected) setStatus('flush-status', 'The server is not connected to Checkmarx One: an Admin connects it under Settings → Checkmarx One.', 'error');
    else if (view.previewError) setStatus('flush-status', `Checking the projects did not finish: ${view.previewError}`, 'error');
    else if (view.previewing) setStatus('flush-status', 'Checking every project: its latest scan, whether its code is kept, and its results To verify…');
    else {
      setStatus('flush-status', '');
      // The date apart from the words, so the words are translated.
      if (preview) $('flush-status').innerHTML = `<span>Projects checked</span> <time translate="no">${esc(fmtDateTime(preview.readAt))}</time>`;
    }
    // A new check ticks every project that can be flushed again.
    if (preview && chosenFrom !== preview.readAt) {
      chosen = new Set(eligible().map((p) => p.id));
      chosenFrom = preview.readAt;
    }
    const concurrency = Number($('flush-concurrency').value) || 4;
    const running = job && !['done', 'stopped'].includes(job.state);
    const n = chosen?.size ?? 0;
    $('flush-chosen').textContent = preview ? `${num(n)} of ${num(eligible().length)}` : 'None yet';
    $('flush-chosen-sub').textContent = preview ? `Tick them in the list below: try a few first. ${estimate(preview, concurrency, n)} at ${concurrency} scans at once.` : 'Check the projects first, then tick them in the list below: try a few first.';
    $('flush-preview').disabled = Boolean(view?.previewing) || Boolean(running);
    $('flush-start').disabled = !n || Boolean(running) || Boolean(view?.previewing);
    $('flush-start').textContent = n ? `Start FAE Flush (${num(n)} project${n === 1 ? '' : 's'})` : 'Start FAE Flush';
    if (view?.debug) {
      $('flush-debug-on').checked = view.debug.on;
      $('flush-debug-count').textContent = view.debug.entries ? `${num(view.debug.entries)} call(s) logged` : '';
    }

    // Tiles: what the run would take (or took).
    const totals = summary?.totals;
    $('flush-tiles').innerHTML = job
      ? [
          [num(totals.marked), ne() ? 'false positives marked Not exploitable' : 'false positives marked Proposed not exploitable', 'flush-pne'],
          [pct(totals.marked, totals.toVerify), `of ${num(totals.toVerify)} results To verify`],
          [`${num(summary.finished)} / ${num(summary.projects)}`, 'projects finished'],
          [num(summary.steps['needs-ok']), 'ask you', summary.steps['needs-ok'] ? 'flush-warn' : ''],
        ].map(([b, s, cls]) => `<div class="flush-tile"><b class="${cls ?? ''}">${esc(b)}</b><span>${esc(s)}</span></div>`).join('')
      : preview
        ? [
            [num(preview.eligible), 'projects with a completed SAST scan whose code can be scanned again'],
            [num(preview.toVerify), 'SAST results To verify in them'],
            [num(preview.leftOut), 'left out (shown below, with why)'],
          ].map(([b, s]) => `<div class="flush-tile"><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join('')
        : '';

    // The projects checked, each ticked or not: until a run starts from them (its own table then shows each one).
    $('flush-preview-panel').hidden = !preview || Boolean(job && preview.readAt <= job.startedAt);
    if (preview) {
      $('flush-preview-sub').textContent = `${num(preview.eligible)} to flush, ${num(preview.leftOut)} left out.`;
      $('flush-preview-table').tBodies[0].innerHTML = preview.projects
        .map((p) => {
          const tick = p.leftOut ? '' : `<input type="checkbox" data-flush-pick="${esc(p.id)}"${chosen.has(p.id) ? ' checked' : ''} aria-label="${esc(p.name)}" />`;
          const how = p.leftOut ? `<span class="pill muted">Left out</span> <span class="hint">${esc(p.leftOut)}</span>` : p.codeKept === false ? '<span class="pill ok">Will be flushed</span> <span class="hint">from its repository (Checkmarx One does not keep its code)</span>' : '<span class="pill ok">Will be flushed</span>';
          return `<tr><td class="flush-tick">${tick}</td><td><b translate="no">${esc(p.name)}</b></td><td>${p.sourceScanId ? `<span translate="no">${esc(p.branch || '')}</span>` : '—'}</td><td class="num">${num(p.loc)}</td><td class="num">${num(p.toVerify)}</td><td>${how}</td></tr>`;
        })
        .join('');
    }
    // Troubleshoot: the projects to test; those of the run when the projects were not checked since a restart.
    const testable = preview?.projects?.length ? preview.projects : job?.projects ?? [];
    const select = $('flush-test-project');
    const was = select.value;
    select.innerHTML = testable.map((p) => `<option value="${esc(p.id)}"${p.id === was ? ' selected' : ''} translate="no">${esc(p.name)}</option>`).join('');

    // The run.
    $('flush-progress').hidden = !job;
    if (!job) return;
    const scanning = (summary.steps.copying ?? 0) + (summary.steps.scanning ?? 0);
    const ready = summary.steps.reported ?? 0;
    $('flush-progress-title').textContent = job.state === 'done' ? (ready ? 'Ready to mark' : 'Finished') : job.state === 'paused' ? 'Paused' : `Progress · ${num(summary.finished)} of ${num(summary.projects)} finished · ${num(scanning)} scanning`;
    // Dates and who apart from the sentences, so each sentence is translated whole.
    // Checkmarx One marks every result sharing a similarity id: say so when results and findings differ.
    const findings = ready ? totals.notReportedFindings : totals.markedFindings;
    const shared = findings && findings !== (ready ? totals.notReported : totals.marked) ? ` <span>${esc(`${num(findings)} distinct findings: Checkmarx One marks every result that shares one.`)}</span>` : '';
    const outcome = ready
      ? `<span>${esc(ne() ? `${num(totals.notReported)} results To verify would be marked Not exploitable: not reported by the FAE scan of the same code. Nothing is marked until you select Mark now.` : `${num(totals.notReported)} results To verify would be marked Proposed not exploitable: not reported by the FAE scan of the same code. Nothing is marked until you select Mark now.`)}</span>${shared}`
      : `<span><b class="flush-pne">${esc(num(totals.marked))}</b> ${esc(ne() ? `of ${num(totals.toVerify)} results To verify marked Not exploitable: not reported by the FAE scan of the same code.` : `of ${num(totals.toVerify)} results To verify marked Proposed not exploitable: not reported by the FAE scan of the same code.`)}</span>${shared} <span>${esc(num(totals.revalidated))} revalidated; ${esc(num(totals.reported))} still reported, left To verify.</span>`;
    $('flush-result').innerHTML = `<span class="flush-meta"><span>Started</span> <time translate="no">${esc(fmtDateTime(job.startedAt))}</time> · <span translate="no">${esc(job.startedBy || '—')}</span>${job.finishedAt ? ` · <span>Finished</span> <time translate="no">${esc(fmtDateTime(job.finishedAt))}</time>` : ''}</span><br />${outcome} <span>${esc(job.deleteFae ? 'Each _FAE project is deleted once checked.' : 'The _FAE projects are kept.')}</span>`;
    $('flush-mark-now').hidden = !allowed() || !ready || job.state !== 'done';
    $('flush-mark-now').textContent = `Mark now (${num(totals.notReported)})`;
    $('flush-pause').textContent = job.state === 'paused' ? 'Resume' : 'Pause';
    $('flush-pause').hidden = !allowed() || job.state === 'done';
    $('flush-delete-fae').hidden = !allowed() || !summary.faeKept;
    $('flush-delete-fae').textContent = `Delete all _FAE projects (${num(summary.faeKept)})`;
    $('flush-undo').hidden = !allowed() || !totals.marked;
    const skipped = summary.steps.skipped ?? 0;
    $('flush-back-all').hidden = !allowed() || !skipped;
    $('flush-back-all').textContent = skipped === 1 ? 'Bring back the skipped project' : `Bring back all ${num(skipped)} skipped`;

    // Those that stopped to ask.
    const asks = job.projects.filter((p) => p.step === 'needs-ok');
    $('flush-asks').innerHTML = asks
      .map((p) => {
        const markable = !['scan', 'error', 'copy', 'settings'].includes(p.exception?.code);
        const carryOn = p.exception?.code === 'settings' ? `<button type="button" class="sm" data-decide="continue">${esc('Carry on without them')}</button>` : '';
        const mark = p.exception?.code === 'revalidation' ? 'Accept' : `Mark ${num(p.counts?.notReported ?? 0)} anyway`;
        // The reason in a sentence of its own (translated), a failed call's own message as it came.
        const reason = ['error', 'copy', 'settings'].includes(p.exception?.code) ? `<span translate="no">${esc(p.exception?.text ?? '')}</span>` : `<span>${esc(p.exception?.text ?? '')}</span>`;
        const detail = p.exception?.detail ? ` <span class="hint" translate="no">${esc(p.exception.detail)}</span>` : '';
        return `<div class="flush-ask" data-id="${esc(p.id)}"><p><b translate="no">${esc(p.name)}</b> ${reason}${detail}</p>${allowed() ? `<div class="actions">${markable ? `<button type="button" class="sm" data-decide="mark">${esc(mark)}</button>` : ''}${carryOn}<button type="button" class="sm" data-decide="retry">Retry</button><button type="button" class="sm" data-decide="skip">Skip</button></div>` : ''}</div>`;
      })
      .join('');

    // Each project, and (opened) what it went through.
    const timeline = (p) => `<tr class="flush-timeline"><td colspan="7"><ol>${(p.attempts ?? []).map((a) => `<li class="${a.ok ? 'ok' : 'bad'}"><time translate="no">${esc(fmtDateTime(a.at))}</time> <span>${esc(a.what)}</span>${a.detail ? ` <span class="hint" translate="no">${esc(a.detail)}</span>` : ''}</li>`).join('') || `<li>${esc('Nothing yet.')}</li>`}</ol></td></tr>`;
    $('flush-table').tBodies[0].innerHTML = job.projects
      .map((p) => {
        const c = p.counts ?? {};
        const kind = STEP_KIND[p.step] ?? (ACTIVE.has(p.step) ? 'run' : '');
        const skippedBy = p.step === 'skipped' && /^Skipped by /.test(p.note ?? '') ? p.note.slice('Skipped by '.length) : '';
        const why = skippedBy ? `<span>Skipped by</span> <span translate="no">${esc(skippedBy)}</span>${p.exception?.text ? ` · <span>${esc(p.exception.text)}</span>` : ''}` : `<span>${esc(p.note || p.exception?.text || '')}</span>`;
        const cells = p.step === 'left-out' || p.step === 'skipped' ? `<td colspan="4" class="hint">${why}</td>` : `<td class="num">${num(c.reported)}</td><td class="num flush-pne">${num(p.markedCount || c.notReported)}</td><td>${c.revalidated !== undefined && c.revalidated !== null ? `✓ ${num(c.revalidated)} of ${num(p.markedCount)}` : '—'}</td><td>${p.faeProjectId ? (p.faeDeleted ? 'Removed' : `<span translate="no">${esc(`${p.name}_FAE`)}</span>`) : '—'}</td>`;
        const back = p.step === 'skipped' && allowed() ? ` <button type="button" class="sm flush-back" data-flush-back="${esc(p.id)}">${esc('Bring back')}</button>` : '';
        const row = `<tr class="flush-row${opened === p.id ? ' is-open' : ''}" data-flush-open="${esc(p.id)}"><td><b translate="no">${esc(p.name)}</b></td><td class="flush-step"><span class="pill ${kind}">${esc(STEP_LABEL[p.step] ?? p.step)}</span>${back}</td><td class="num">${num(c.toVerify)}</td>${cells}</tr>`;
        return opened === p.id ? row + timeline(p) : row;
      })
      .join('');
  }

  function renderValue() {
    const v = value;
    if (!v) return;
    // Money in the currency of Settings → AI & credit pool → Impact, as the viewer's locale writes it.
    const money = (n) => {
      if (n === null || n === undefined) return '—';
      try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: v.saved.currency, maximumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n);
      } catch {
        return `${num(n)} ${v.saved.currency}`;
      }
    };
    const s = v.saved;
    const rate = (text) => ` <span class="flush-rate" translate="no">(${esc(text)})</span>`;
    const tile = (b, caption, cls = '', extra = '') => `<div class="flush-tile ${cls === 'is-money' ? cls : ''}"><b class="${cls === 'is-money' ? '' : cls}" translate="no">${esc(b)}</b><span>${esc(caption)}</span>${extra}</div>`;
    $('flush-value-tiles').innerHTML = [
      s.money !== null
        ? tile(money(s.money), 'money saved', 'is-money', `<br /><span class="hint"><span translate="no">${esc(money(s.hoursCost ?? 0))}</span> <span>${esc('of triage time')}</span> + <span translate="no">${esc(money(s.creditsCost ?? 0))}</span> <span>${esc('of AI Triage credits')}</span></span>`)
        : tile('—', 'money saved: add an hourly cost and the price of one credit', 'is-money'),
      tile(num(v.total.kept), 'false positives removed (still marked)', 'flush-pne'),
      tile(pct(v.total.kept, v.total.toVerify), `of ${num(v.total.toVerify)} results To verify they were in`),
      tile(`${num(s.hours)} h`, `manual triage saved at ${num(s.minutesPerTriage)} min each`, '', s.hourlyRate ? rate(`${money(s.hourlyRate)}/h`) : ''),
      tile(num(s.credits), 'AI Triage credits not needed', '', s.creditPrice ? rate(`× ${money(s.creditPrice)}`) : ''),
    ].join('');
    const tot = v.total;
    $('flush-value-note').innerHTML = [
      tot.keptFindings && tot.keptFindings !== tot.kept ? `<span>${esc(`${num(tot.kept)} results in ${num(tot.keptFindings)} distinct findings: Checkmarx One marks every result that shares one. Time counts each finding once; credits count each result.`)}</span>` : '',
      tot.byState?.NOT_EXPLOITABLE ? `<span>${esc(`${num(tot.byState.PROPOSED_NOT_EXPLOITABLE ?? 0)} Proposed not exploitable · ${num(tot.byState.NOT_EXPLOITABLE)} Not exploitable.`)}</span>` : '',
      `<span>${esc(s.money !== null ? 'Time and money use the figures under' : 'To see the money saved, set an hourly cost and the price of one credit under')}</span> <a href="#/settings/ai">${esc('Settings → AI & credit pool → Impact')}</a>`,
    ].filter(Boolean).join(' ');
    const most = Math.max(1, ...SEVERITIES.map(([k]) => v.total.bySeverity[k] ?? 0));
    $('flush-value-sev').innerHTML = v.total.kept
      ? SEVERITIES.map(([k, label]) => `<div class="flush-sev-row"><span>${esc(label)}</span><i class="sev-${k.toLowerCase()}" style="width:${(((v.total.bySeverity[k] ?? 0) / most) * 100).toFixed(1)}%"></i><b>${esc(num(v.total.bySeverity[k] ?? 0))}</b></div>`).join('')
      : `<p class="hint">${esc('Nothing marked yet: the value shows here after a run marks false positives.')}</p>`;
    $('flush-value-runs').tBodies[0].innerHTML = v.runs.map((r) => `<tr><td><time translate="no">${esc(fmtDateTime(r.at))}</time></td><td translate="no">${esc(r.by || '—')}</td><td class="num">${num(r.projects)}</td><td class="num">${num(r.toVerify)}</td><td class="num flush-pne">${num(r.marked)}</td><td class="num">${num(r.revalidated)}</td><td class="num">${num(r.undone)}</td><td class="num" translate="no">${esc(money(r.money))}</td></tr>`).join('') || `<tr><td colspan="8" class="hint">${esc('No run has marked anything yet.')}</td></tr>`;
    $('flush-value-projects').tBodies[0].innerHTML = v.projects.map((p) => `<tr><td translate="no"><b>${esc(p.project)}</b></td><td class="num">${num(p.runs)}</td><td class="num">${num(p.toVerify)}</td><td class="num flush-pne">${num(p.kept)}</td><td class="num" translate="no">${esc(money(p.money))}</td><td><time translate="no">${esc(fmtDateTime(p.last))}</time></td></tr>`).join('') || `<tr><td colspan="6" class="hint">${esc('No project yet.')}</td></tr>`;
  }

  async function act(path, body, done) {
    try {
      view = await post(path, body);
      render();
      if (done) toast(done(view), 'ok');
    } catch (error) {
      showError('flush-status', error);
    }
    load({ quiet: true });
  }

  $('flush-preview').addEventListener('click', () => act('/api/fae-flush/preview'));
  $('flush-concurrency').addEventListener('change', () => view && render());
  $('flush-preview-table').addEventListener('change', (event) => {
    const box = event.target.closest('[data-flush-pick]');
    if (!box) return;
    if (box.checked) chosen.add(box.dataset.flushPick);
    else chosen.delete(box.dataset.flushPick);
    render();
  });
  $('flush-tick-all').addEventListener('click', () => {
    chosen = new Set(eligible().map((p) => p.id));
    render();
  });
  $('flush-tick-none').addEventListener('click', () => {
    chosen = new Set();
    render();
  });
  $('flush-start').addEventListener('click', () => {
    const p = view?.preview;
    const n = chosen?.size ?? 0;
    if (!p || !n) return;
    const concurrency = Number($('flush-concurrency').value) || 4;
    const report = picked('flush-mode') === 'report';
    const final = markAsChosen() === 'ne';
    $('flush-dialog-body').innerHTML = `<p>${esc(final
      ? `${num(n)} projects, ${concurrency} scans at a time (${estimate(p, concurrency, n)}). Each project's code is scanned again on a new project named after it with _FAE at the end, with Findings Analysis on; its results To verify that the FAE scan no longer reports become Not exploitable in the project itself, with a comment naming the FAE scan.`
      : `${num(n)} projects, ${concurrency} scans at a time (${estimate(p, concurrency, n)}). Each project's code is scanned again on a new project named after it with _FAE at the end, with Findings Analysis on; its results To verify that the FAE scan no longer reports become Proposed not exploitable in the project itself, with a comment naming the FAE scan.`)}</p>${final ? `<p class="status error">${esc('Not exploitable is final: these results leave every count and dashboard at once, with no one confirming them. Undo puts them back to To verify.')}</p>` : ''}${report ? `<p><b>${esc('Only show what it would mark: nothing is marked until you select Mark now.')}</b></p>` : ''}<p class="hint">${esc('Projects that look off stop and ask you first. Every mark is in the audit log, and Undo puts them all back to To verify.')}</p>`;
    for (const radio of document.querySelectorAll('input[name="flush-keep"]')) radio.checked = false;
    const dialog = $('flush-dialog');
    dialog.returnValue = '';
    dialog.showModal();
  });
  $('flush-dialog').addEventListener('close', () => {
    if ($('flush-dialog').returnValue !== 'go') return;
    const keep = document.querySelector('input[name="flush-keep"]:checked')?.value;
    if (!keep) return;
    act('/api/fae-flush/start', {
      concurrency: Number($('flush-concurrency').value) || 4,
      deleteFae: keep === 'delete',
      projectIds: [...(chosen ?? [])],
      mode: picked('flush-mode') ?? 'mark',
      sensitivity: picked('flush-sensitivity') ?? 'normal',
      source: $('flush-source').value,
      markAs: markAsChosen(),
    }, () => 'FAE Flush started: it runs on the server, you can close this page.');
  });
  $('flush-mark-now').addEventListener('click', () => {
    const n = view?.summary?.totals?.notReported ?? 0;
    const question = ne() ? `Mark ${num(n)} results Not exploitable now?` : `Mark ${num(n)} results Proposed not exploitable now?`;
    if (!confirm(t(`${question}\n\nThe results the report found that the FAE scan no longer reports, in their projects; then revalidated. Undo puts them back.`))) return;
    act('/api/fae-flush/mark-now', {}, () => 'Marking: it runs on the server, you can close this page.');
  });
  $('flush-pause').addEventListener('click', () => act(view?.job?.state === 'paused' ? '/api/fae-flush/resume' : '/api/fae-flush/pause'));
  $('flush-asks').addEventListener('click', (event) => {
    const button = event.target.closest('[data-decide]');
    if (!button) return;
    act('/api/fae-flush/decide', { projectId: button.closest('[data-id]').dataset.id, decision: button.dataset.decide });
  });
  $('flush-table').addEventListener('click', (event) => {
    const back = event.target.closest('[data-flush-back]');
    if (back) return act('/api/fae-flush/bring-back', { projectIds: [back.dataset.flushBack] }, () => 'Brought back: it starts again when a scan slot is free.');
    const row = event.target.closest('[data-flush-open]');
    if (!row) return;
    opened = opened === row.dataset.flushOpen ? '' : row.dataset.flushOpen;
    render();
  });
  $('flush-undo').addEventListener('click', () => {
    const n = view?.summary?.totals?.marked ?? 0;
    const back = ne() ? `The ${num(n)} results it marked Not exploitable go back to To verify, apart from any someone changed since (those stay as they are).` : `The ${num(n)} results it marked Proposed not exploitable go back to To verify, apart from any someone changed since (those stay as they are).`;
    if (!confirm(t(`Undo FAE Flush?\n\n${back}`))) return;
    act('/api/fae-flush/undo', {}, (v) => `${num(v.restored)} results back to To verify${v.changedSince ? `; ${num(v.changedSince)} changed since, left as they are` : ''}.`);
  });
  $('flush-delete-fae').addEventListener('click', () => {
    const n = view?.summary?.faeKept ?? 0;
    if (!confirm(t(`Delete all ${num(n)} _FAE projects from Checkmarx One?\n\nThe projects FAE Flush made, and their scans. Your own projects and the results marked in them are not touched.`))) return;
    act('/api/fae-flush/delete-fae', {}, (v) => `${num(v.deleted)} _FAE project${v.deleted === 1 ? '' : 's'} deleted${v.failed?.length ? `; ${v.failed.length} could not be` : ''}.`);
  });
  $('flush-back-all').addEventListener('click', () => act('/api/fae-flush/bring-back', {}, () => 'Brought back: they start again when a scan slot is free.'));
  $('flush-csv').addEventListener('click', () => view?.job && save(`fae-flush-${view.job.startedAt.slice(0, 10)}.csv`, new Blob([csvOf(view.job)], { type: 'text/csv' })));

  // ---- Troubleshoot ----
  $('flush-test').addEventListener('click', async () => {
    const projectId = $('flush-test-project').value;
    if (!projectId) return toast('Check the projects first: then choose one to test.', 'warn');
    const out = $('flush-test-out');
    out.hidden = false;
    out.querySelector('tbody').innerHTML = `<tr><td colspan="2" class="hint">${esc('Testing…')}</td></tr>`;
    try {
      const { checks } = await post('/api/fae-flush/test', { projectId });
      const mark = (ok) => (ok === true ? '<span class="pill ok">✓</span>' : ok === false ? '<span class="pill warn">✗</span>' : '<span class="pill muted">?</span>');
      out.querySelector('tbody').innerHTML = checks.map((c) => `<tr><td>${mark(c.ok)} <span>${esc(c.check)}</span></td><td class="hint" translate="no">${esc(c.detail)}</td></tr>`).join('');
    } catch (error) {
      out.querySelector('tbody').innerHTML = `<tr><td colspan="2" translate="no">${esc(error.message)}</td></tr>`;
    }
    load({ quiet: true });
  });
  $('flush-debug-on').addEventListener('change', async (event) => {
    try {
      await api('/api/fae-flush/debug', { method: 'PUT', body: JSON.stringify({ on: event.target.checked }) });
      toast(event.target.checked ? 'Debug log on: every FAE Flush call to Checkmarx One is recorded.' : 'Debug log off.', 'ok');
    } catch (error) {
      showError('flush-status', error);
    }
    load({ quiet: true });
  });
  $('flush-debug-download').addEventListener('click', async () => {
    try {
      const { log } = await api('/api/fae-flush/debug', { quiet: true });
      save(`fae-flush-debug-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`, new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' }));
    } catch (error) {
      showError('flush-status', error);
    }
  });
  $('flush-debug-clear').addEventListener('click', async () => {
    try {
      await api('/api/fae-flush/debug', { method: 'DELETE' });
    } catch (error) {
      showError('flush-status', error);
    }
    load({ quiet: true });
  });

  // ---- Value ----
  document.querySelector('[data-ptabs="flush"] [data-pt="value"]')?.addEventListener('click', loadValue);
  $('flush-value-csv').addEventListener('click', () => value && save(`fae-flush-value-${new Date().toISOString().slice(0, 10)}.csv`, new Blob([valueCsvOf(value)], { type: 'text/csv' })));

  return {
    load: (opts) => {
      if (!$('page-flush').querySelector('[data-ptpanel="flush:value"]').hidden) loadValue();
      return load(opts);
    },
    stop: () => clearTimeout(timer),
  };
}
