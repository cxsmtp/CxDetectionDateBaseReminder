// Explanations behind a "?". The grey line that explains a heading (a .hint right after it) or a form
// field (the .hint inside its label) is folded away, and a small ? beside the heading or the field's
// name opens it in place. What the app keeps up to date (a line with an id: counts, statuses), warnings,
// and anything marked data-help-keep stay where they are. "Explanations: Shown" in Settings → Your appearance
// (html[data-help="shown"]) shows them all again.

const HEADING = 'h1, h2, h3, h4';
const EXPLANATION = 'p.hint, p.lead, small.hint, span.hint';
const KEEP = '[id], [data-help-keep], .warn, .error, .bad, .status, .callout, .notice, .inline-hint, .feat-caution, .beta-banner, .server-note, .calc-verdict';
// Where explanations are never folded: menus and pop-ups, tables, empty states, and the ? pop-ups themselves.
const LEAVE = '.look-body, .user-menu-body, .help-pop, .conn-pop, .tt-pop, table, .empty, dialog, .calc-pop, [data-help-keep]';
// A paragraph of explanation away from any heading is folded only when it is long enough to be worth it.
const LONG = 90;
let say = (text) => text;
let serial = 0;

/** The explanation to fold for this heading: the .hint right after it, if it is one. */
function explanationAfter(heading) {
  const next = heading.nextElementSibling;
  if (!next || !next.matches(EXPLANATION) || next.matches(KEEP) || next.closest('[data-help-keep]')) return null;
  return next.textContent.trim().length >= 20 ? next : null;
}

function questionButton(text) {
  const id = text.id || `help-${++serial}`;
  text.id = id;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'help-q';
  button.textContent = '?';
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', id);
  button.setAttribute('aria-label', say('What is this?'));
  button.title = say('What is this?');
  return button;
}

/** Fold `text` behind the ? on `anchor`: one ? per anchor, opening every explanation folded onto it. */
function fold(anchor, text) {
  if (text.classList.contains('help-text')) return;
  const existing = anchor.querySelector(':scope > .help-q');
  if (existing) {
    text.id ||= `help-${++serial}`;
    existing.setAttribute('aria-controls', `${existing.getAttribute('aria-controls')} ${text.id}`);
  } else {
    anchor.append(' ', questionButton(text));
  }
  text.classList.add('help-text');
}

/** A field's name: the words of a label.field (its <span>), or the label of a .field block. */
const fieldName = (el) => el?.matches?.('label.field, .field') ? el.querySelector(':scope > span:not(.hint), :scope > label') : null;

/**
 * A long explanation that sits on its own: its ? goes on what it explains. That is the heading
 * just before it (or the heading inside the block before it), else the field just after it (the
 * line above "API key" explains the key). With nothing to sit beside, it stays in view: a ? never
 * stands alone, and a line with a link in it (the terms of use) is never hidden.
 */
function foldInPlace(text) {
  if (text.classList.contains('help-text')) return;
  const before = text.previousElementSibling;
  const heading = before?.matches(HEADING) ? before : before?.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > div > h2, :scope > div > h3');
  if (heading) return fold(heading, text);
  if (text.querySelector('a[href], button')) return;
  const after = text.nextElementSibling;
  const name = fieldName(after) ?? fieldName(after?.querySelector(':scope > label.field, :scope > .field'));
  if (name) return fold(name, text);
}

/** Fold the explanations under `root`: a heading's line, each form field's note, an option's description, long notes. */
function scan(root = document) {
  for (const heading of root.querySelectorAll(HEADING)) {
    if (heading.__help) continue;
    heading.__help = true;
    const text = heading.closest(LEAVE) ? null : explanationAfter(heading);
    if (text) fold(heading, text);
  }
  for (const note of root.querySelectorAll('label.field > small.hint, label.field > span.hint')) {
    if (note.__help || note.matches(KEEP) || note.closest('[data-help-keep]')) continue;
    note.__help = true;
    const name = note.parentElement.querySelector(':scope > span:not(.hint)');
    if (name && note.textContent.trim().length >= 20) fold(name, note);
  }
  // An option's description: <label><input> <span><strong>Name</strong><small>what it does</small></span></label>,
  // or any bold title with its grey note: <strong>Title.</strong> <small class="hint">more</small>.
  for (const note of root.querySelectorAll('label strong + small, strong + small.hint')) {
    if (note.__help || note.matches(KEEP) || note.closest(LEAVE)) continue;
    note.__help = true;
    if (note.textContent.trim().length >= 40) fold(note.previousElementSibling, note);
  }
  // Any other long explanation: a ? where it was (marked data-help-fold to fold one that is not grey).
  for (const note of root.querySelectorAll('p.hint, div.hint, p.lead, [data-help-fold]')) {
    if (note.__help || note.classList.contains('help-text') || note.matches(KEEP) || note.closest(LEAVE)) continue;
    note.__help = true;
    if (note.textContent.trim().length >= LONG || note.hasAttribute('data-help-fold')) foldInPlace(note);
  }
}

export function startHelpTips({ translate } = {}) {
  if (translate) say = (text) => translate(text);
  document.addEventListener('click', (event) => {
    const button = event.target.closest('.help-q');
    if (!button) return;
    // Inside a <summary> or a <label>: open the explanation, not the section or the field.
    event.preventDefault();
    event.stopPropagation();
    const texts = (button.getAttribute('aria-controls') || '').split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean);
    if (!texts.length) return;
    const open = button.getAttribute('aria-expanded') !== 'true';
    for (const text of texts) text.classList.toggle('help-open', open);
    button.setAttribute('aria-expanded', String(open));
  }, true);
  // Only what was added is looked at (its parent too, for a heading and its line added one after the other),
  // and nothing inside a table: findings stream in by the thousand, and this must cost them nothing.
  const pending = new Set();
  let queued = false;
  new MutationObserver((records) => {
    for (const record of records) {
      if (!record.addedNodes.length || record.target.closest?.('table, [data-help-keep]')) continue;
      pending.add(record.target);
    }
    if (queued || !pending.size) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const roots = [...pending].filter((el) => el.isConnected);
      pending.clear();
      for (const root of roots) scan(root.parentElement ?? root);
    });
  }).observe(document.body, { childList: true, subtree: true });
  scan();
}

/** "Behind ?" (the default) or "shown": every explanation shown as before. Kept in this browser. */
export function setHelpMode(mode) {
  const shown = mode === 'shown';
  document.documentElement.toggleAttribute('data-help', shown);
  if (shown) document.documentElement.dataset.help = 'shown';
  try {
    localStorage.setItem('mz-help', shown ? 'shown' : 'tips');
  } catch {}
}

export function helpMode() {
  try {
    return localStorage.getItem('mz-help') === 'shown' ? 'shown' : 'tips';
  } catch {
    return 'tips';
  }
}
