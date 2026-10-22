/**
 * FAE Flush (Labs, then Act): the page. The run itself is on the server (src/fae-flush.js); this shows the
 * projects it would take, starts it (asking first whether to delete or keep the _FAE projects), shows each
 * project's progress, asks about the ones that stopped, and offers Pause, Undo, Export and Delete all _FAE.
 */
const STEP_LABEL = {
  waiting: 'Waiting',
  copying: 'Copying the code',
  scanning: 'Scanning',
  comparing: 'Comparing',
  'needs-ok': 'Asks you',
  marking: 'Marking',
  revalidating: 'Revalidating',
  cleaning: 'Removing _FAE',
  done: 'Done',
  skipped: 'Skipped',
  'left-out': 'Left out',
  undone: 'Undone',
};
const STEP_KIND = { done: 'ok', skipped: 'muted', 'left-out': 'muted', undone: 'muted', 'needs-ok': 'warn', waiting: 'muted' };
const ACTIVE = new Set(['copying', 'scanning', 'comparing', 'marking', 'revalidating', 'cleaning']);
const num = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString());
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');

/** Roughly how long: the projects' last SAST scans, so many at once. */
export function estimate(preview, concurrency) {
  const seconds = (preview?.sastSeconds ?? 0) / Math.max(1, concurrency) + (preview?.eligible ?? 0) * 60 / Math.max(1, concurrency);
  if (!seconds) return '—';
  const h = seconds / 3600;
  return h >= 1 ? `≈ ${h.toFixed(h < 10 ? 1 : 0)} h` : `≈ ${Math.max(1, Math.round(seconds / 60))} min`;
}

/** One line a person can act on: the run's figures, as the CSV and the page give them. */
export function csvOf(job) {
  const rows = [['Project', 'Step', 'To verify', 'Reported by FAE', 'Not reported', 'Marked Proposed not exploitable', 'Revalidated', 'FAE project', 'FAE scan', 'Note']];
  for (const p of job?.projects ?? []) {
    const c = p.counts ?? {};
    rows.push([p.name, STEP_LABEL[p.step] ?? p.step, c.toVerify ?? '', c.reported ?? '', c.notReported ?? '', c.marked ?? '', c.revalidated ?? '', p.faeProjectId ? `${p.name}_FAE${p.faeDeleted ? ' (deleted)' : ''}` : '', p.faeScanId ?? '', p.exception?.text ?? p.note ?? '']);
  }
  return rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(',')).join('\n');
}

export function initFaeFlush({ api, $, esc, toast, showError, setStatus, can, fmtDateTime, t = (s) => s }) {
  let view = null;
  let timer = 0;
  const allowed = () => can('integration.cxone');
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

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

  function render() {
    const { preview, job, summary } = view ?? {};
    $('flush-perm-note').hidden = allowed();
    for (const id of ['flush-preview', 'flush-start', 'flush-pause', 'flush-undo', 'flush-delete-fae']) $(id).hidden = !allowed();
    if (!view?.connected) setStatus('flush-status', 'The server is not connected to Checkmarx One: an Admin connects it under Settings → Checkmarx One.', 'error');
    else if (view.previewError) setStatus('flush-status', `Checking the projects did not finish: ${view.previewError}`, 'error');
    else if (view.previewing) setStatus('flush-status', 'Checking every project: its latest scan, whether its code is kept, and its results To verify…');
    else {
      setStatus('flush-status', '');
      // The date apart from the words, so the words are translated.
      if (preview) $('flush-status').innerHTML = `<span>Projects checked</span> <time translate="no">${esc(fmtDateTime(preview.readAt))}</time>`;
    }
    const concurrency = Number($('flush-concurrency').value) || 4;
    const running = job && !['done', 'stopped'].includes(job.state);
    $('flush-preview').disabled = Boolean(view?.previewing) || Boolean(running);
    $('flush-start').disabled = !preview?.eligible || Boolean(running) || Boolean(view?.previewing);
    $('flush-start').textContent = preview?.eligible ? `Start FAE Flush for ${num(preview.eligible)} project${preview.eligible === 1 ? '' : 's'}` : 'Start FAE Flush';

    // Tiles: what the run would take (or took).
    const totals = summary?.totals;
    $('flush-tiles').innerHTML = job
      ? [
          [num(totals.marked), 'false positives marked Proposed not exploitable', 'flush-pne'],
          [pct(totals.marked, totals.toVerify), `of ${num(totals.toVerify)} results To verify`],
          [`${num(summary.finished)} / ${num(summary.projects)}`, 'projects finished'],
          [num(summary.steps['needs-ok']), 'ask you', summary.steps['needs-ok'] ? 'flush-warn' : ''],
        ].map(([b, s, cls]) => `<div class="flush-tile"><b class="${cls ?? ''}">${esc(b)}</b><span>${esc(s)}</span></div>`).join('')
      : preview
        ? [
            [num(preview.eligible), 'projects with a completed SAST scan and their code kept'],
            [num(preview.toVerify), 'SAST results To verify in them'],
            [num(preview.leftOut), 'left out (shown below, with why)'],
            [estimate(preview, concurrency), `at ${concurrency} scans at once (their last scans' times)`],
          ].map(([b, s]) => `<div class="flush-tile"><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join('')
        : '';

    // The projects checked (before a run).
    // The projects checked: until a run starts from them (its own table then shows each one).
    $('flush-preview-panel').hidden = !preview || Boolean(job && preview.readAt <= job.startedAt);
    if (preview) {
      $('flush-preview-sub').textContent = `${num(preview.eligible)} to flush, ${num(preview.leftOut)} left out.`;
      $('flush-preview-table').tBodies[0].innerHTML = preview.projects
        .map((p) => `<tr><td><b translate="no">${esc(p.name)}</b></td><td>${p.sourceScanId ? `<span translate="no">${esc(p.branch || '')}</span>` : '—'}</td><td class="num">${num(p.loc)}</td><td class="num">${num(p.toVerify)}</td><td>${p.leftOut ? `<span class="pill muted">Left out</span> <span class="hint">${esc(p.leftOut)}</span>` : '<span class="pill ok">Will be flushed</span>'}</td></tr>`)
        .join('');
    }

    // The run.
    $('flush-progress').hidden = !job;
    if (!job) return;
    const scanning = (summary.steps.copying ?? 0) + (summary.steps.scanning ?? 0);
    $('flush-progress-title').textContent = job.state === 'done' ? 'Finished' : job.state === 'paused' ? 'Paused' : `Progress · ${num(summary.finished)} of ${num(summary.projects)} finished · ${num(scanning)} scanning`;
    // Dates and who apart from the sentences, so each sentence is translated whole.
    $('flush-result').innerHTML = `<span class="flush-meta"><span>Started</span> <time translate="no">${esc(fmtDateTime(job.startedAt))}</time> · <span translate="no">${esc(job.startedBy || '—')}</span>${job.finishedAt ? ` · <span>Finished</span> <time translate="no">${esc(fmtDateTime(job.finishedAt))}</time>` : ''}</span><br /><span><b class="flush-pne">${esc(num(totals.marked))}</b> of ${esc(num(totals.toVerify))} results To verify marked Proposed not exploitable: not reported by the FAE scan of the same code.</span> <span>${esc(num(totals.revalidated))} revalidated; ${esc(num(totals.reported))} still reported, left To verify.</span> <span>${esc(job.deleteFae ? 'Each _FAE project is deleted once checked.' : 'The _FAE projects are kept.')}</span>`;
    $('flush-pause').textContent = job.state === 'paused' ? 'Resume' : 'Pause';
    $('flush-pause').hidden = !allowed() || job.state === 'done';
    $('flush-delete-fae').hidden = !allowed() || !summary.faeKept;
    $('flush-delete-fae').textContent = `Delete all _FAE projects (${num(summary.faeKept)})`;
    $('flush-undo').hidden = !allowed() || !totals.marked;

    // Those that stopped to ask.
    const asks = job.projects.filter((p) => p.step === 'needs-ok');
    $('flush-asks').innerHTML = asks
      .map((p) => {
        const markable = p.exception?.code !== 'scan' && p.exception?.code !== 'error';
        const mark = p.exception?.code === 'revalidation' ? 'Accept' : `Mark ${num(p.counts?.notReported ?? 0)} anyway`;
        // The reason in a sentence of its own (translated), a failed call's own message as it came.
        const reason = p.exception?.code === 'error' ? `<span translate="no">${esc(p.exception?.text ?? '')}</span>` : `<span>${esc(p.exception?.text ?? '')}</span>`;
        const detail = p.exception?.detail ? ` <span class="hint" translate="no">${esc(p.exception.detail)}</span>` : '';
        return `<div class="flush-ask" data-id="${esc(p.id)}"><p><b translate="no">${esc(p.name)}</b> ${reason}${detail}</p>${allowed() ? `<div class="actions">${markable ? `<button type="button" class="sm" data-decide="mark">${esc(mark)}</button>` : ''}<button type="button" class="sm" data-decide="retry">Retry</button><button type="button" class="sm" data-decide="skip">Skip</button></div>` : ''}</div>`;
      })
      .join('');

    $('flush-table').tBodies[0].innerHTML = job.projects
      .map((p) => {
        const c = p.counts ?? {};
        const kind = STEP_KIND[p.step] ?? (ACTIVE.has(p.step) ? 'run' : '');
        const skippedBy = p.step === 'skipped' && /^Skipped by /.test(p.note ?? '') ? p.note.slice('Skipped by '.length) : '';
        const why = skippedBy ? `<span>Skipped by</span> <span translate="no">${esc(skippedBy)}</span>${p.exception?.text ? ` · <span>${esc(p.exception.text)}</span>` : ''}` : `<span>${esc(p.note || p.exception?.text || '')}</span>`;
        const note = p.step === 'left-out' || p.step === 'skipped' ? `<td colspan="4" class="hint">${why}</td>` : `<td class="num">${num(c.reported)}</td><td class="num flush-pne">${num(p.markedCount || c.notReported)}</td><td>${c.revalidated !== undefined && c.revalidated !== null ? `✓ ${num(c.revalidated)} of ${num(p.markedCount)}` : '—'}</td><td>${p.faeProjectId ? (p.faeDeleted ? 'Removed' : `<span translate="no">${esc(`${p.name}_FAE`)}</span>`) : '—'}</td>`;
        return `<tr><td><b translate="no">${esc(p.name)}</b></td><td><span class="pill ${kind}">${esc(STEP_LABEL[p.step] ?? p.step)}</span></td><td class="num">${num(c.toVerify)}</td>${note}</tr>`;
      })
      .join('');
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
  $('flush-start').addEventListener('click', () => {
    const p = view?.preview;
    if (!p) return;
    const concurrency = Number($('flush-concurrency').value) || 4;
    $('flush-dialog-body').innerHTML = `<p>${esc(`${num(p.eligible)} projects, ${concurrency} scans at a time (${estimate(p, concurrency)}). Each project's code is scanned again on a new project named after it with _FAE at the end, with Findings Analysis on; its results To verify that the FAE scan no longer reports become Proposed not exploitable in the project itself, with a comment naming the FAE scan.`)}</p><p class="hint">${esc('Projects that look off stop and ask you first. Every mark is in the audit log, and Undo puts them all back to To verify.')}</p>`;
    for (const radio of document.querySelectorAll('input[name="flush-keep"]')) radio.checked = false;
    const dialog = $('flush-dialog');
    dialog.returnValue = '';
    dialog.showModal();
  });
  $('flush-dialog').addEventListener('close', () => {
    if ($('flush-dialog').returnValue !== 'go') return;
    const keep = document.querySelector('input[name="flush-keep"]:checked')?.value;
    if (!keep) return;
    act('/api/fae-flush/start', { concurrency: Number($('flush-concurrency').value) || 4, deleteFae: keep === 'delete' }, () => 'FAE Flush started: it runs on the server, you can close this page.');
  });
  $('flush-pause').addEventListener('click', () => act(view?.job?.state === 'paused' ? '/api/fae-flush/resume' : '/api/fae-flush/pause'));
  $('flush-asks').addEventListener('click', (event) => {
    const button = event.target.closest('[data-decide]');
    if (!button) return;
    act('/api/fae-flush/decide', { projectId: button.closest('[data-id]').dataset.id, decision: button.dataset.decide });
  });
  $('flush-undo').addEventListener('click', () => {
    const n = view?.summary?.totals?.marked ?? 0;
    if (!confirm(t(`Undo FAE Flush?\n\nThe ${num(n)} results it marked Proposed not exploitable go back to To verify, apart from any someone changed since (those stay as they are).`))) return;
    act('/api/fae-flush/undo', {}, (v) => `${num(v.restored)} results back to To verify${v.changedSince ? `; ${num(v.changedSince)} changed since, left as they are` : ''}.`);
  });
  $('flush-delete-fae').addEventListener('click', () => {
    const n = view?.summary?.faeKept ?? 0;
    if (!confirm(t(`Delete all ${num(n)} _FAE projects from Checkmarx One?\n\nThe projects FAE Flush made, and their scans. Your own projects and the results marked in them are not touched.`))) return;
    act('/api/fae-flush/delete-fae', {}, (v) => `${num(v.deleted)} _FAE project${v.deleted === 1 ? '' : 's'} deleted${v.failed?.length ? `; ${v.failed.length} could not be` : ''}.`);
  });
  $('flush-csv').addEventListener('click', () => {
    if (!view?.job) return;
    const url = URL.createObjectURL(new Blob([csvOf(view.job)], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `fae-flush-${view.job.startedAt.slice(0, 10)}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  return { load, stop: () => clearTimeout(timer) };
}
