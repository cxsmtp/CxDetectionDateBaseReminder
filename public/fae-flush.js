/**
 * FAE Flush (Labs, then Act): the page. The run itself is on the server (src/fae-flush.js); this shows the
 * projects it would take (ticked to choose), starts it (asking first whether to delete or keep the _FAE
 * projects), shows each project's progress and timeline, asks about the ones that stopped, and offers Mark now,
 * Pause, Undo, Export and Delete all _FAE. The Value tab shows what every run has been worth; Troubleshoot tests
 * one project, keeps a debug log and chooses where the code comes from.
 */
import { sortAndFilter } from './table-tools.js';

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
  // The projects list: what is searched for (several terms, separated by commas), which ones to show, how many.
  const PAGE_ROWS = 100;
  let showWhat = 'all';
  let pageRows = PAGE_ROWS;
  // The run's table: the step tab, what is searched for, the projects selected, how many rows.
  let stepTab = 'all';
  let runRows = PAGE_ROWS;
  let selected = new Set();
  let projectsShown = [];
  let runShown = [];
  const termsOf = (id) => $(id).value.toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  const matches = (words, ...fields) => !words.length || words.some((w) => fields.join(' ').toLowerCase().includes(w));
  const skippedLast = () => new Set((view?.job?.projects ?? []).filter((p) => p.step === 'skipped').map((p) => p.id));
  const shown = (p) => {
    if (!matches(termsOf('flush-search'), p.name, p.branch ?? '')) return false;
    if (showWhat === 'eligible') return !p.leftOut;
    if (showWhat === 'left-out') return Boolean(p.leftOut);
    if (showWhat === 'ticked') return !p.leftOut && Boolean(chosen?.has(p.id));
    if (showWhat === 'unticked') return !p.leftOut && !chosen?.has(p.id);
    if (showWhat === 'skipped') return skippedLast().has(p.id);
    return true;
  };
  // The run's steps, as tabs.
  const TABS = [
    ['all', 'All', () => true],
    ['work', 'At work', (p) => ACTIVE.has(p.step) || p.step === 'waiting'],
    ['asks', 'Asks you', (p) => p.step === 'needs-ok'],
    ['ready', 'Ready to mark', (p) => p.step === 'reported'],
    ['done', 'Done', (p) => p.step === 'done'],
    ['skipped', 'Skipped', (p) => p.step === 'skipped'],
    ['undone', 'Undone', (p) => p.step === 'undone'],
    ['left-out', 'Left out', (p) => p.step === 'left-out'],
  ];
  // What each action on the selected projects applies to.
  const BULK = {
    // Asking, with an FAE scan's results to mark (not a scan, copy or settings question).
    anyway: (p) => p.step === 'needs-ok' && !['scan', 'error', 'copy', 'settings', 'rescan'].includes(p.exception?.code) && (p.counts?.notReported ?? 0) > 0,
    continue: (p) => p.step === 'needs-ok' && p.exception?.code === 'settings',
    retry: (p) => p.step === 'needs-ok',
    skip: (p) => p.step === 'needs-ok',
    back: (p) => p.step === 'skipped',
    mark: (p) => p.step === 'reported',
    delete: (p) => p.faeProjectId && !p.faeDeleted && !ACTIVE.has(p.step) && p.step !== 'reported',
    undo: (p) => (p.markedCount ?? 0) > 0,
  };
  const allowed = () => can('integration.cxone');
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
  const picked = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
  // The run marks them Not exploitable (chosen at its start, Admins only), or Proposed not exploitable.
  const ne = () => view?.job?.options?.markAs === 'ne';
  const markAsChosen = () => (can('faeFlush.notExploitable') && picked('flush-markas') === 'ne' ? 'ne' : 'pne');
  const showMarkAs = () => {
    $('flush-markas-dd').hidden = !can('faeFlush.notExploitable');
    const final = markAsChosen() === 'ne';
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
    for (const id of ['flush-preview', 'flush-start', 'flush-pause']) $(id).hidden = !allowed();
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
    if (preview) renderProjects(preview);
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
    const left = [totals.aiLeft ? `<span>${esc(`${num(totals.aiLeft)} found by the AI engine, left as they are.`)}</span>` : '', totals.notMarked ? `<span>${esc(`${num(totals.notMarked)} Checkmarx One would not mark (each project's timeline says why).`)}</span>` : ''].join(' ');
    $('flush-result').innerHTML = `<span class="flush-meta"><span>Started</span> <time translate="no">${esc(fmtDateTime(job.startedAt))}</time> · <span translate="no">${esc(job.startedBy || '—')}</span>${job.finishedAt ? ` · <span>Finished</span> <time translate="no">${esc(fmtDateTime(job.finishedAt))}</time>` : ''}</span><br />${outcome} ${left} <span>${esc(job.deleteFae ? 'Each _FAE project is deleted once checked.' : 'The _FAE projects are kept.')}</span>`;
    $('flush-pause').textContent = job.state === 'paused' ? 'Resume' : 'Pause';
    $('flush-pause').hidden = !allowed() || job.state === 'done';
    const earlier = (job.earlier ?? []).filter((p) => p.faeProjectId && !p.faeDeleted).length;
    $('flush-delete-earlier').hidden = !allowed() || !earlier;
    $('flush-delete-earlier').textContent = `Delete ${num(earlier)} _FAE project${earlier === 1 ? '' : 's'} of earlier runs`;
    // The column says the state this run marks with.
    $('flush-col-marked').textContent = ne() ? 'Not reported → Not exploitable' : 'Not reported → Proposed not exploitable';
    renderRun(job);
  }

  /** The projects checked: searched, shown by kind, sorted and filtered from the headings, a page at a time. */
  function renderProjects(preview) {
    $('flush-preview-sub').textContent = `${num(preview.projects.length)} in the tenant · ${num(preview.eligible)} can be flushed · ${num(preview.leftOut)} left out.`;
    $('flush-av-warn').hidden = !preview.groupsByAttackVector;
    const skipped = skippedLast();
    document.querySelector('#flush-show [data-show="skipped"]').hidden = !skipped.size;
    if (showWhat === 'skipped' && !skipped.size) showWhat = 'all';
    for (const chip of document.querySelectorAll('#flush-show [data-show]')) chip.classList.toggle('primary', chip.dataset.show === showWhat);
    const codeFrom = (p) => (p.leftOut ? '' : p.codeKept === false ? 'Repository' : 'Stored copy');
    const rows = sortAndFilter('flush-projects', preview.projects.filter(shown), [
      null,
      (p) => p.name,
      (p) => p.branch ?? '',
      { value: (p) => (p.scannedAt ? Date.parse(p.scannedAt) : null), text: (p) => (p.scannedAt ? fmtDateTime(p.scannedAt) : '') },
      (p) => p.loc ?? null,
      (p) => p.toVerify ?? null,
      codeFrom,
      (p) => (p.leftOut ? 'Left out' : 'Can be flushed'),
    ], () => renderProjects(view.preview));
    const pickable = rows.filter((p) => !p.leftOut);
    const ticked = pickable.filter((p) => chosen?.has(p.id)).length;
    const head = $('flush-tick-head');
    head.checked = pickable.length > 0 && ticked === pickable.length;
    head.indeterminate = ticked > 0 && ticked < pickable.length;
    head.disabled = !pickable.length;
    const n = chosen?.size ?? 0;
    const tickedAll = eligible().filter((p) => chosen?.has(p.id));
    $('flush-sel-count').textContent = `${num(n)} ticked`;
    $('flush-sel-sub').textContent = n ? `of ${num(preview.eligible)} · ${num(tickedAll.reduce((a, p) => a + (p.toVerify ?? 0), 0))} results To verify · ${estimate(preview, Number($('flush-concurrency').value) || 4, n)}` : `of ${num(preview.eligible)}: tick the projects to flush (the box in the heading ticks every one shown)`;
    $('flush-untick-all').hidden = !n;
    $('flush-found').textContent = rows.length !== preview.projects.length ? `${num(rows.length)} of ${num(preview.projects.length)} shown` : '';
    $('flush-preview-table').tBodies[0].innerHTML = rows
      .slice(0, pageRows)
      .map((p) => {
        const tick = p.leftOut ? '' : `<input type="checkbox" data-flush-pick="${esc(p.id)}"${chosen?.has(p.id) ? ' checked' : ''} aria-label="${esc(p.name)}" />`;
        const how = p.leftOut ? `<span class="pill muted">Left out</span> <span class="hint">${esc(p.leftOut)}</span>` : '<span class="pill ok">Can be flushed</span>';
        return `<tr><td class="flush-tick">${tick}</td><td><b translate="no">${esc(p.name)}</b></td><td>${p.sourceScanId ? `<span translate="no">${esc(p.branch || '')}</span>` : '—'}</td><td>${p.scannedAt ? `<time translate="no">${esc(fmtDateTime(p.scannedAt))}</time>` : '—'}</td><td class="num">${num(p.loc)}</td><td class="num">${num(p.toVerify)}</td><td>${p.leftOut ? '—' : esc(codeFrom(p))}</td><td>${how}</td></tr>`;
      })
      .join('') || `<tr><td colspan="8" class="hint">${esc('No project matches.')}</td></tr>`;
    $('flush-more').hidden = rows.length <= pageRows;
    $('flush-more').textContent = `Show ${num(Math.min(PAGE_ROWS, rows.length - pageRows))} more (${num(rows.length - pageRows)} left)`;
    projectsShown = pickable;
  }

  /** The run, a project a row: the step tabs, search, headings, and what can be done with those selected. */
  function renderRun(job) {
    const counts = Object.fromEntries(TABS.map(([key, , test]) => [key, job.projects.filter(test).length]));
    if (stepTab !== 'all' && !counts[stepTab]) stepTab = 'all';
    $('flush-steps').innerHTML = TABS.filter(([key]) => key === 'all' || counts[key]).map(([key, label]) => `<button type="button" data-tab="${key}" class="sm${key === stepTab ? ' primary' : ''}"><span>${esc(label)}</span> <b translate="no">${num(counts[key])}</b></button>`).join('');
    const test = TABS.find(([key]) => key === stepTab)[2];
    const words = termsOf('flush-run-search');
    const markedLabel = ne() ? 'Not exploitable' : 'Proposed not exploitable';
    const rows = sortAndFilter('flush-run', job.projects.filter((p) => test(p) && matches(words, p.name, STEP_LABEL[p.step] ?? p.step, p.exception?.text ?? '', p.note ?? '')), [
      null,
      (p) => p.name,
      (p) => STEP_LABEL[p.step] ?? p.step,
      (p) => p.counts?.toVerify ?? null,
      (p) => p.counts?.reported ?? null,
      (p) => p.markedCount || p.counts?.notReported || null,
      (p) => p.counts?.revalidated ?? null,
      (p) => (p.faeProjectId ? (p.faeDeleted ? 'Removed' : `${p.name}_FAE`) : ''),
    ], () => renderRun(view.job));
    // The selection keeps only projects still in the run.
    const ids = new Set(job.projects.map((p) => p.id));
    selected = new Set([...selected].filter((id) => ids.has(id)));
    const shownIds = rows.map((p) => p.id);
    const on = shownIds.filter((id) => selected.has(id)).length;
    const head = $('flush-run-head');
    head.checked = shownIds.length > 0 && on === shownIds.length;
    head.indeterminate = on > 0 && on < shownIds.length;
    head.disabled = !allowed() || !shownIds.length;
    const chosenRows = job.projects.filter((p) => selected.has(p.id));
    $('flush-actbar').hidden = !allowed() || !chosenRows.length;
    $('flush-act-count').textContent = `${num(chosenRows.length)} selected`;
    const LABEL = { anyway: 'Mark anyway', continue: 'Carry on without them', retry: 'Retry', skip: 'Skip', back: 'Bring back', mark: 'Mark now', delete: 'Delete _FAE projects', undo: 'Undo marks' };
    for (const button of document.querySelectorAll('#flush-actbar [data-bulk]')) {
      const n = chosenRows.filter(BULK[button.dataset.bulk]).length;
      // Only what fits the projects ticked.
      button.hidden = !n;
      button.textContent = n ? `${LABEL[button.dataset.bulk]} (${num(n)})` : LABEL[button.dataset.bulk];
    }
    const timeline = (p) => `<tr class="flush-timeline"><td colspan="8"><ol>${(p.attempts ?? []).map((a) => `<li class="${a.ok ? 'ok' : 'bad'}"><time translate="no">${esc(fmtDateTime(a.at))}</time> <span>${esc(a.what)}</span>${a.detail ? ` <span class="hint" translate="no">${esc(a.detail)}</span>` : ''}</li>`).join('') || `<li>${esc('Nothing yet.')}</li>`}</ol></td></tr>`;
    const question = (p) => {
      const code = p.exception?.code;
      const markable = !['scan', 'error', 'copy', 'settings', 'rescan'].includes(code) && (code === 'revalidation' || (p.counts?.notReported ?? 0) > 0);
      const mark = code === 'revalidation' ? 'Accept' : `Mark ${num(p.counts?.notReported ?? 0)} anyway`;
      const reason = ['error', 'copy', 'settings', 'rescan'].includes(code) ? `<span translate="no">${esc(p.exception?.text ?? '')}</span>` : `<span>${esc(p.exception?.text ?? '')}</span>`;
      const detail = p.exception?.detail ? ` <span class="hint" translate="no">${esc(p.exception.detail)}</span>` : '';
      const buttons = allowed() ? `<span class="flush-row-actions">${markable ? `<button type="button" class="sm" data-decide="mark">${esc(mark)}</button>` : ''}${code === 'settings' ? `<button type="button" class="sm" data-decide="continue">${esc('Carry on without them')}</button>` : ''}<button type="button" class="sm" data-decide="retry">Retry</button><button type="button" class="sm" data-decide="skip">Skip</button></span>` : '';
      return `<span class="flush-ask-line">${reason}${detail}</span>${buttons}`;
    };
    const why = (p) => {
      if (p.step === 'needs-ok') return question(p);
      if (p.step === 'skipped' && /^Skipped by /.test(p.note ?? '')) return `<span class="flush-why"><span>Skipped by</span> <span translate="no">${esc(p.note.slice('Skipped by '.length))}</span>${p.exception?.text ? ` · <span translate="no">${esc(p.exception.text)}</span>` : ''}</span>`;
      const text = p.step === 'left-out' || p.step === 'skipped' ? p.note || p.exception?.text : p.counts?.notMarked ? `${num(p.counts.notMarked)} not marked: Checkmarx One refused them (see the timeline)` : '';
      return text ? `<span class="flush-why">${esc(text)}</span>` : '';
    };
    $('flush-table').tBodies[0].innerHTML = rows
      .slice(0, runRows)
      .map((p) => {
        const c = p.counts ?? {};
        const kind = STEP_KIND[p.step] ?? (ACTIVE.has(p.step) ? 'run' : '');
        const box = allowed() ? `<input type="checkbox" data-flush-sel="${esc(p.id)}"${selected.has(p.id) ? ' checked' : ''} aria-label="${esc(p.name)}" />` : '';
        const row = `<tr class="flush-row${opened === p.id ? ' is-open' : ''}${p.step === 'needs-ok' ? ' is-asking' : ''}" data-flush-open="${esc(p.id)}" data-id="${esc(p.id)}"><td class="flush-tick">${box}</td><td><b translate="no">${esc(p.name)}</b>${why(p)}</td><td><span class="pill ${kind}">${esc(STEP_LABEL[p.step] ?? p.step)}</span></td><td class="num">${num(c.toVerify)}</td><td class="num">${num(c.reported)}</td><td class="num flush-pne" title="${esc(markedLabel)}">${num(p.markedCount || c.notReported)}</td><td>${c.revalidated !== undefined && c.revalidated !== null ? `✓ ${num(c.revalidated)} of ${num(p.markedCount)}` : '—'}</td><td>${p.faeProjectId ? (p.faeDeleted ? 'Removed' : `<span translate="no">${esc(`${p.name}_FAE`)}</span>`) : '—'}</td></tr>`;
        return opened === p.id ? row + timeline(p) : row;
      })
      .join('') || `<tr><td colspan="8" class="hint">${esc('No project matches.')}</td></tr>`;
    $('flush-run-more').hidden = rows.length <= runRows;
    $('flush-run-more').textContent = `Show ${num(Math.min(PAGE_ROWS, rows.length - runRows))} more (${num(rows.length - runRows)} left)`;
    runShown = shownIds;
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
  // The projects list.
  $('flush-preview-table').addEventListener('change', (event) => {
    const box = event.target.closest('[data-flush-pick]');
    if (!box) return;
    if (box.checked) (chosen ??= new Set()).add(box.dataset.flushPick);
    else chosen?.delete(box.dataset.flushPick);
    render();
  });
  // The box in the heading: every project shown (the whole filtered list, not only this page).
  $('flush-tick-head').addEventListener('change', (event) => {
    for (const p of projectsShown) {
      if (event.target.checked) (chosen ??= new Set()).add(p.id);
      else chosen?.delete(p.id);
    }
    render();
  });
  $('flush-untick-all').addEventListener('click', () => {
    chosen = new Set();
    render();
  });
  $('flush-search').addEventListener('input', () => {
    pageRows = PAGE_ROWS;
    if (view) render();
  });
  $('flush-show').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-show]');
    if (!chip) return;
    showWhat = chip.dataset.show;
    pageRows = PAGE_ROWS;
    render();
  });
  $('flush-more').addEventListener('click', () => {
    pageRows += PAGE_ROWS;
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
  $('flush-pause').addEventListener('click', () => act(view?.job?.state === 'paused' ? '/api/fae-flush/resume' : '/api/fae-flush/pause'));
  // The run's table: a project's own answer, opening its timeline, selecting.
  $('flush-table').addEventListener('click', (event) => {
    const answer = event.target.closest('[data-decide]');
    if (answer) return act('/api/fae-flush/decide', { projectId: answer.closest('[data-id]').dataset.id, decision: answer.dataset.decide });
    if (event.target.closest('input, button, a')) return;
    const row = event.target.closest('[data-flush-open]');
    if (!row) return;
    opened = opened === row.dataset.flushOpen ? '' : row.dataset.flushOpen;
    render();
  });
  $('flush-table').addEventListener('change', (event) => {
    const box = event.target.closest('[data-flush-sel]');
    if (!box) return;
    if (box.checked) selected.add(box.dataset.flushSel);
    else selected.delete(box.dataset.flushSel);
    render();
  });
  $('flush-run-head').addEventListener('change', (event) => {
    for (const id of runShown) {
      if (event.target.checked) selected.add(id);
      else selected.delete(id);
    }
    render();
  });
  $('flush-act-clear').addEventListener('click', () => {
    selected = new Set();
    render();
  });
  $('flush-steps').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]');
    if (!tab) return;
    stepTab = tab.dataset.tab;
    runRows = PAGE_ROWS;
    render();
  });
  $('flush-run-search').addEventListener('input', () => {
    runRows = PAGE_ROWS;
    if (view) render();
  });
  $('flush-run-more').addEventListener('click', () => {
    runRows += PAGE_ROWS;
    render();
  });
  // One action on the selected projects (only those it applies to).
  $('flush-actbar').addEventListener('click', (event) => {
    const button = event.target.closest('[data-bulk]');
    if (!button || button.disabled) return;
    const kind = button.dataset.bulk;
    const list = (view?.job?.projects ?? []).filter((p) => selected.has(p.id) && BULK[kind](p));
    const projectIds = list.map((p) => p.id);
    if (!projectIds.length) return;
    const n = projectIds.length;
    const many = `${num(n)} project${n === 1 ? '' : 's'}`;
    const done = () => {
      selected = new Set();
    };
    if (kind === 'anyway') {
      const results = list.reduce((a, p) => a + (p.counts?.notReported ?? 0), 0);
      const question = ne() ? `Mark ${num(results)} results Not exploitable anyway, in ${many}?` : `Mark ${num(results)} results Proposed not exploitable anyway, in ${many}?`;
      if (!confirm(t(`${question}\n\nEach of these projects stopped to ask; its question is in its row. The results the FAE scan no longer reports are marked, then revalidated. Undo puts them back.`))) return;
      act('/api/fae-flush/decide-many', { projectIds, decision: 'mark' }, (v) => `Marking ${num(v.done)}: it runs on the server, you can close this page.`);
    } else if (kind === 'continue') {
      act('/api/fae-flush/decide-many', { projectIds, decision: 'continue' }, (v) => `${num(v.done)} carry on without the settings Checkmarx One would not copy: they go on when a scan slot is free.`);
    } else if (kind === 'retry' || kind === 'skip') {
      act('/api/fae-flush/decide-many', { projectIds, decision: kind }, (v) => (kind === 'retry' ? `Retrying ${num(v.done)}: they go on when a scan slot is free.` : `${num(v.done)} skipped.`));
    } else if (kind === 'back') {
      act('/api/fae-flush/bring-back', { projectIds }, () => 'Brought back: they start again when a scan slot is free.');
    } else if (kind === 'mark') {
      const results = list.reduce((a, p) => a + (p.counts?.notReported ?? 0), 0);
      const question = ne() ? `Mark ${num(results)} results Not exploitable now, in ${many}?` : `Mark ${num(results)} results Proposed not exploitable now, in ${many}?`;
      if (!confirm(t(`${question}\n\nThe results the report found that the FAE scan no longer reports, in their projects; then revalidated. Undo puts them back.`))) return;
      act('/api/fae-flush/mark-now', { projectIds }, () => 'Marking: it runs on the server, you can close this page.');
    } else if (kind === 'delete') {
      if (!confirm(t(`Delete the _FAE projects of ${many} from Checkmarx One?\n\nThe projects FAE Flush made, and their scans. Your own projects and the results marked in them are not touched.`))) return;
      act('/api/fae-flush/delete-fae', { projectIds }, (v) => `${num(v.deleted)} _FAE project${v.deleted === 1 ? '' : 's'} deleted${v.failed?.length ? `; ${v.failed.length} could not be` : ''}.`);
    } else if (kind === 'undo') {
      const results = list.reduce((a, p) => a + (p.markedCount ?? 0), 0);
      const back = ne() ? `The ${num(results)} results marked Not exploitable in ${many} go back to To verify, apart from any someone changed since (those stay as they are).` : `The ${num(results)} results marked Proposed not exploitable in ${many} go back to To verify, apart from any someone changed since (those stay as they are).`;
      if (!confirm(t(`Undo FAE Flush for these projects?\n\n${back}`))) return;
      act('/api/fae-flush/undo', { projectIds }, (v) => `${num(v.restored)} results back to To verify${v.changedSince ? `; ${num(v.changedSince)} changed since, left as they are` : ''}.`);
    }
    done();
  });
  $('flush-delete-earlier').addEventListener('click', () => {
    const earlier = (view?.job?.earlier ?? []).filter((p) => p.faeProjectId && !p.faeDeleted);
    if (!earlier.length || !confirm(t(`Delete ${num(earlier.length)} _FAE projects of earlier runs from Checkmarx One?\n\nThe projects FAE Flush made, and their scans. Your own projects are not touched.`))) return;
    act('/api/fae-flush/delete-fae', { earlier: true }, (v) => `${num(v.deleted)} _FAE project${v.deleted === 1 ? '' : 's'} deleted${v.failed?.length ? `; ${v.failed.length} could not be` : ''}.`);
  });
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
