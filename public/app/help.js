// Get help: the menu in the header, support cases and enhancement requests, and how the team answers them.
import { $, state } from './state.js';
import { escapeHtml } from './format.js';
import { api, handleAuthLoss, setStatus } from './core.js';

// ---- Get help: support cases and enhancements ------------------------------
// The sidebar's Get help opens a small menu when pointed at (or clicked, or
// focused): raise a support case, request an enhancement, or track requests.
// Everyone sees their own requests; the support team (support.manage) sees the
// queue of the tenants they work in, answers, and moves each one on.

const help = { data: null, open: '', team: false, justRaised: '' };
const HELP_STATUS = { new: ['New', 'info'], 'in-progress': ['In progress', 'info'], waiting: ['Waiting for reply', 'warning'], completed: ['Completed', 'good'], declined: ['Declined', ''] };
const HELP_KIND = { case: 'Support case', enhancement: 'Enhancement' };
const HELP_PRIORITY = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
const helpChip = (status) => {
  const [label, tone] = HELP_STATUS[status] ?? [status, ''];
  return `<span class="rp-chip${tone ? ` tone-${tone}` : ''}" data-i18n-ctx="request">${label}</span>`;
};
const helpWhen = (iso) => `<time datetime="${escapeHtml(iso)}" translate="no">${escapeHtml(new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</time>`;

// The menu: shown beside the sidebar (it scrolls, so the menu lives outside it).
let helpTimer = null;
function placeHelpMenu() {
  const side = document.querySelector('.sidebar').getBoundingClientRect();
  const button = $('help-open').getBoundingClientRect();
  const pop = $('help-pop');
  const rtl = document.documentElement.dir === 'rtl';
  pop.style.left = rtl ? 'auto' : `${Math.round(side.right + 8)}px`;
  pop.style.right = rtl ? `${Math.round(window.innerWidth - side.left + 8)}px` : 'auto';
  pop.style.bottom = `${Math.max(8, Math.round(window.innerHeight - button.bottom))}px`;
}
function showHelpMenu() {
  clearTimeout(helpTimer);
  placeHelpMenu();
  $('help-pop').hidden = false;
  $('help-open').setAttribute('aria-expanded', 'true');
}
function hideHelpMenu(delay = 200) {
  clearTimeout(helpTimer);
  helpTimer = setTimeout(() => {
    $('help-pop').hidden = true;
    $('help-open').setAttribute('aria-expanded', 'false');
  }, delay);
}

/** Email mode: a mailto: link to the support address, with a short template and the context the team needs. */
function supportMailto(kind) {
  const isCase = kind === 'case';
  const me = state.me?.user ?? {};
  const tenant = state.me?.tenancy?.current?.name ?? '';
  const body = [
    isCase ? 'What happened:' : 'What I would like:', '', '',
    isCase ? 'What I expected:' : 'Who it helps, and how I would use it:', '', '',
    ...(isCase ? ['Steps to see it:', '', '', 'Priority (low, normal, high, urgent): normal', ''] : []),
    '---',
    `From: ${me.name ? `${me.name} ` : ''}<${me.email ?? ''}>`,
    `Version: ${$('app-version').textContent.trim()}`,
    ...(tenant ? [`Tenant: ${tenant}`] : []),
    `Server: ${location.origin}`,
  ].join('\n');
  const subject = isCase ? 'Support case: ' : 'Enhancement request: ';
  return `mailto:${state.me.support.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** Get help follows the installation's choice (Settings → Get help): the portal here, or each person's email app. */
export function applySupportChannel() {
  const email = state.me?.support?.mode === 'email' && state.me.support.email ? state.me.support.email : '';
  const [caseItem, enhItem] = $('help-pop').querySelectorAll('.help-item');
  caseItem.href = email ? supportMailto('case') : '#/help/case';
  enhItem.href = email ? supportMailto('enhancement') : '#/help/enhancement';
  caseItem.querySelector('small').textContent = email
    ? 'Opens your email app, addressed to the support team, with a short template to fill in.'
    : 'Something does not work, or you are stuck. The support team answers you here.';
  enhItem.querySelector('small').textContent = email
    ? 'Opens your email app: say what you would like, and who it helps.'
    : 'A new feature or an improvement. Follow it until it is done.';
  $('help-pop').querySelector('.help-track').hidden = Boolean(email);
  $('help-bar-case').href = caseItem.href;
  $('help-bar-enh').href = enhItem.href;
  $('help-mail-case').href = caseItem.href;
  $('help-mail-enh').href = enhItem.href;
  $('help-mail-to').textContent = email;
}

export async function loadHelp() {
  try {
    help.data = await api('/api/support');
  } catch (error) {
    if (handleAuthLoss(error)) return;
    $('help-list').innerHTML = `<p class="status error">${escapeHtml(error.message)}</p>`;
    return;
  }
  help.team = Boolean(help.data.team);
  $('help-whose-box').hidden = !help.team;
  renderHelpList();
}

function renderHelpList() {
  if (!help.data) return;
  const kind = $('help-kind').value;
  const status = $('help-status').value;
  const everyone = help.team && $('help-whose').value === 'all';
  const all = help.data.requests ?? [];
  const rows = all.filter((r) => (!kind || r.kind === kind) && (!status || (status === 'open' ? !['completed', 'declined'].includes(r.status) : r.status === status)) && (everyone || r.mine));
  $('help-queue-title').textContent = everyone ? 'Support queue' : 'My requests';
  $('help-count').textContent = `${rows.length} shown`;
  $('help-list').innerHTML = rows.length
    ? `<ul class="help-rows">${rows
        .map((r) => `<li><a class="help-row${r.id === help.open ? ' on' : ''}" href="#/help/${escapeHtml(r.id)}"${r.id === help.open ? ' aria-current="true"' : ''}>
          <span class="help-row-top"><span class="help-num" translate="no">${escapeHtml(r.id)}</span>${helpChip(r.status)}${r.priority === 'urgent' || r.priority === 'high' ? `<span class="rp-chip tone-critical">${HELP_PRIORITY[r.priority]}</span>` : ''}</span>
          <span class="help-row-title" translate="no">${escapeHtml(r.subject)}</span>
          <span class="hint">${r.mine ? '' : `<span translate="no">${escapeHtml(r.requester.name || r.requester.email)}</span>${r.tenant ? ` · <span translate="no">${escapeHtml(r.tenant)}</span>` : ''} · `}${helpWhen(r.updatedAt)}</span>
        </a></li>`)
        .join('')}</ul>`
    : `<p class="hint">${all.length ? 'Nothing matches these filters.' : state.me?.support?.mode === 'email' ? 'Requests go by email here, so none are listed.' : 'No requests yet. Raise one with the buttons above.'}</p>`;
}

/** #/help, #/help/case, #/help/enhancement or #/help/SUP-0001. */
export function helpRoute(view) {
  const v = String(view ?? '');
  $('help-form').hidden = true;
  $('help-view').hidden = true;
  $('help-empty').hidden = true;
  $('help-mail').hidden = true;
  applySupportChannel();
  const byEmail = state.me?.support?.mode === 'email' && Boolean(state.me.support.email);
  if (byEmail && !/^(SUP|ENH)-\d+$/i.test(v)) {
    help.open = '';
    $('help-mail').hidden = false;
  } else if (v === 'case' || v === 'enhancement') {
    help.open = '';
    openHelpForm(v);
  } else if (/^(SUP|ENH)-\d+$/i.test(v)) {
    help.open = v.toUpperCase();
    openHelpRequest(help.open);
  } else {
    help.open = '';
    $('help-empty').hidden = false;
  }
  renderHelpList();
}

function openHelpForm(kind) {
  const isCase = kind === 'case';
  $('help-form').hidden = false;
  $('help-form').dataset.kind = kind;
  $('help-form-title').textContent = isCase ? 'Submit a support case' : 'Request an enhancement';
  $('help-form-hint').textContent = isCase
    ? 'Tell the support team what is not working, or where you are stuck. You get an email with the case number, and every answer.'
    : 'Describe the feature or improvement you would like, and why it helps. You get an email with its number, and can follow it until it is done.';
  $('help-text').placeholder = isCase ? 'What happened, what you expected, and the steps to see it' : 'What you would like, who it helps, and how you would use it';
  $('help-priority-box').hidden = !isCase;
  setStatus('help-form-status', '');
  $('help-subject').focus();
}

/** What happened to the emails, in words (the error itself is the mail server's, untranslated). */
function helpEmailNote(emailed) {
  if (emailed?.error) return `<span>Saved, but an email could not be sent:</span> <span translate="no">${escapeHtml(emailed.error)}</span>`;
  return emailed?.sent ? '<span>Saved, and emailed.</span>' : '<span>Saved.</span>';
}

async function openHelpRequest(id) {
  const box = $('help-view');
  box.hidden = false;
  box.innerHTML = '<p class="hint">Loading…</p>';
  try {
    const { request, team } = await api(`/api/support/${encodeURIComponent(id)}`);
    if (help.open !== id) return;
    renderHelpRequest(request, team);
  } catch (error) {
    if (handleAuthLoss(error)) return;
    box.innerHTML = `<p class="status error">${escapeHtml(error.message)}</p>`;
  }
}

function renderHelpRequest(r, team) {
  const raised = help.justRaised === r.id;
  help.justRaised = '';
  const emailNote = raised && help.emailed?.error
    ? `<p class="status warn"><span>The email with your number could not be sent:</span> <span translate="no">${escapeHtml(help.emailed.error)}</span></p>`
    : '';
  const thanks = raised
    ? `<div class="help-thanks"><strong><span>Thank you. Your number is</span> <span translate="no">${escapeHtml(r.id)}</span></strong><p>${r.kind === 'case' ? 'The support team has been told. You get an email with every answer.' : 'It is now in the list of enhancements. You get an email whenever its status changes.'}</p>${emailNote}</div>`
    : '';
  const statusOptions = Object.entries(HELP_STATUS).map(([id, [label]]) => `<option value="${id}"${id === r.status ? ' selected' : ''}>${label}</option>`).join('');
  $('help-view').innerHTML = `${thanks}
    <div class="help-head">
      <span class="help-num" translate="no">${escapeHtml(r.id)}</span>
      <span class="rp-chip">${HELP_KIND[r.kind]}</span>
      ${helpChip(r.status)}
      ${r.priority ? `<span class="hint"><span>Priority</span>: <span>${HELP_PRIORITY[r.priority] ?? r.priority}</span></span>` : ''}
    </div>
    <h2 class="help-subject" translate="no">${escapeHtml(r.subject)}</h2>
    <p class="hint"><span>Raised by</span> <span translate="no">${escapeHtml(r.requester.name || r.requester.email)}</span> · ${helpWhen(r.createdAt)}${r.tenant ? ` · <span translate="no">${escapeHtml(r.tenant)}</span>` : ''}</p>
    <ol class="help-thread">${r.conversation
      .map((m) => `<li class="help-msg${m.team ? ' team' : ''}${m.mine ? ' mine' : ''}">
        <div class="help-msg-head"><strong translate="no">${escapeHtml(m.name)}</strong>${m.team ? '<span class="rp-chip tone-info">Support team</span>' : ''}${helpWhen(m.at)}</div>
        <div class="help-msg-text" translate="no">${escapeHtml(m.text)}</div>
      </li>`)
      .join('')}</ol>
    <form class="help-reply" data-help-reply="${escapeHtml(r.id)}">
      <label class="field"><span>${r.mine ? 'Add to your request' : 'Answer'}</span><textarea name="text" rows="4" maxlength="10000" required placeholder="${r.mine ? 'More detail, or an answer to the support team' : 'Your answer: it is emailed to the person who raised it'}"></textarea></label>
      <div class="actions compact"><button type="submit" class="primary">Send</button></div>
    </form>
    ${team ? `<div class="help-set">
      <label class="field"><span>Status</span><select data-help-status data-i18n-ctx="request">${statusOptions}</select></label>
      <button type="button" data-help-set="${escapeHtml(r.id)}">Update status</button>
      <p class="hint">The person who raised it gets an email with the new status.</p>
    </div>` : ''}
    <p class="status" id="help-view-status"></p>
    <details class="disclosure help-history"><summary>Status history</summary><ul>${r.history
      .map((h) => `<li>${helpChip(h.status)} <span translate="no">${escapeHtml(h.name)}</span> · ${helpWhen(h.at)}</li>`)
      .join('')}</ul></details>`;
}

export function wireHelp() {
  for (const el of [$('help-open'), $('help-pop')]) {
    el.addEventListener('mouseenter', showHelpMenu);
    el.addEventListener('mouseleave', () => hideHelpMenu());
  }
  $('help-open').addEventListener('click', () => ($('help-pop').hidden ? showHelpMenu() : hideHelpMenu(0)));
  $('help-open').addEventListener('focus', showHelpMenu);
  $('help-open').addEventListener('blur', (event) => {
    if (!$('help-pop').contains(event.relatedTarget)) hideHelpMenu();
  });
  $('help-pop').addEventListener('focusout', (event) => {
    if (!$('help-pop').contains(event.relatedTarget) && event.relatedTarget !== $('help-open')) hideHelpMenu(0);
  });
  $('help-pop').addEventListener('click', (event) => {
    if (event.target.closest('a')) hideHelpMenu(0);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('help-pop').hidden) {
      hideHelpMenu(0);
      $('help-open').focus();
    }
  });
  for (const id of ['help-kind', 'help-status', 'help-whose']) $(id).addEventListener('change', renderHelpList);

  $('help-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const kind = $('help-form').dataset.kind;
    $('help-submit').disabled = true;
    setStatus('help-form-status', 'Submitting…');
    try {
      const result = await api('/api/support', {
        method: 'POST',
        body: JSON.stringify({ kind, subject: $('help-subject').value, text: $('help-text').value, priority: $('help-priority').value }),
      });
      $('help-subject').value = '';
      $('help-text').value = '';
      $('help-priority').value = 'normal';
      setStatus('help-form-status', '');
      help.justRaised = result.request.id;
      help.emailed = result.emailed;
      await loadHelp();
      location.hash = `#/help/${result.request.id}`;
    } catch (error) {
      if (handleAuthLoss(error)) return;
      setStatus('help-form-status', error.message, 'error');
    } finally {
      $('help-submit').disabled = false;
    }
  });

  $('help-view').addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-help-reply]');
    if (!form) return;
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const result = await api(`/api/support/${encodeURIComponent(form.dataset.helpReply)}/messages`, { method: 'POST', body: JSON.stringify({ text: form.elements.text.value }) });
      renderHelpRequest(result.request, help.team);
      $('help-view-status').innerHTML = helpEmailNote(result.emailed);
      $('help-view-status').className = `status ${result.emailed?.error ? 'warn' : 'ok'}`;
      loadHelp();
    } catch (error) {
      if (handleAuthLoss(error)) return;
      setStatus('help-view-status', error.message, 'error');
      button.disabled = false;
    }
  });

  $('help-view').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-help-set]');
    if (!button) return;
    const status = $('help-view').querySelector('[data-help-status]').value;
    button.disabled = true;
    try {
      const result = await api(`/api/support/${encodeURIComponent(button.dataset.helpSet)}/status`, { method: 'POST', body: JSON.stringify({ status }) });
      renderHelpRequest(result.request, help.team);
      $('help-view-status').innerHTML = helpEmailNote(result.emailed);
      $('help-view-status').className = `status ${result.emailed?.error ? 'warn' : 'ok'}`;
      loadHelp();
    } catch (error) {
      if (handleAuthLoss(error)) return;
      setStatus('help-view-status', error.message, 'error');
      button.disabled = false;
    }
  });
}
