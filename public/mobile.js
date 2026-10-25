// Phones: CxMissionZero behaves like an app. The menu becomes a bar of four pages and More; More opens a sheet
// that lists every page and the controls from the top bar as one grouped list; the Workbench folds what to
// load into one row that opens a sheet, lists projects as rows, and opens a project on its own screen.
// The look itself is public/mobile.css; this file only adds the few pieces that cannot simply be restyled,
// and puts everything back where it was when the window grows.

const PHONE = '(max-width: 760px)';
const PRIMARY = 4;

const svg = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const MORE_ICON = svg('<circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />');
const CLOSE_ICON = svg('<path d="M6 6l12 12M18 6L6 18" />');
const BACK_ICON = svg('<path d="M15 5l-7 7 7 7" />');
const SCOPE_ICON = svg('<path d="M4 6h16M7 12h10M10 18h4" />');
const HELP_ICON = svg('<circle cx="12" cy="12" r="9" /><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6" /><path d="M12 17h.01" />');
const ROW_ICONS = {
  tenant: svg('<rect x="3" y="4" width="7" height="7" rx="1.5" /><rect x="14" y="4" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />'),
  conn: svg('<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" />'),
  lang: svg('<circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />'),
  theme: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />'),
};

/** Tabs a person may use, in menu order: pinned pages first. */
function usableTabs(nav) {
  const shown = (a) => !a.hidden && !a.classList.contains('perm-hidden') && !a.closest('[hidden]');
  const main = [...nav.querySelectorAll(':scope > a.tab[data-route]')].filter(shown);
  const pinned = [...nav.querySelectorAll('#nav-pinned a.tab[data-route]')].map((a) => a.dataset.route);
  const byRoute = new Map(main.map((a) => [a.dataset.route, a]));
  const first = pinned.map((r) => byRoute.get(r)).filter(Boolean);
  return [...new Set([...first, ...main])];
}

/** A bottom sheet: a grip, a title with a close or Done button, and a body. */
function makeSheet({ id, title, closeLabel = 'Close', done = false, top = false }) {
  const backdrop = document.createElement('div');
  backdrop.className = top ? 'm-backdrop m-top' : 'm-backdrop';
  backdrop.hidden = true;
  const sheet = document.createElement('section');
  sheet.className = top ? 'm-sheet m-top' : 'm-sheet';
  sheet.id = id;
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', `${id}-title`);
  sheet.hidden = true;
  sheet.innerHTML = `<div class="m-grip" aria-hidden="true"></div>
    <header class="m-sheet-head"><h2 id="${id}-title">${title}</h2>${
      done
        ? `<button type="button" class="m-done m-flat">${closeLabel}</button>`
        : `<button type="button" class="icon-btn m-close" aria-label="${closeLabel}">${CLOSE_ICON}</button>`
    }</header>
    <div class="m-sheet-body"></div>`;
  document.body.append(backdrop, sheet);
  let opener = null;
  const api = {
    sheet,
    body: sheet.querySelector('.m-sheet-body'),
    get open() {
      return !sheet.hidden;
    },
    show() {
      if (!sheet.hidden) return;
      opener = document.activeElement;
      backdrop.hidden = false;
      sheet.hidden = false;
      document.documentElement.classList.add('m-sheet-open');
      sheet.querySelector('.m-close, .m-done').focus();
      api.onshow?.();
    },
    hide({ restore = true } = {}) {
      if (sheet.hidden) return;
      sheet.hidden = true;
      backdrop.hidden = true;
      if (!document.querySelector('.m-sheet:not([hidden])')) document.documentElement.classList.remove('m-sheet-open');
      api.onhide?.();
      if (restore && opener?.isConnected) opener.focus();
    },
  };
  backdrop.addEventListener('click', () => api.hide());
  sheet.querySelector('.m-close, .m-done').addEventListener('click', () => api.hide());
  return api;
}

export function initMobile() {
  const nav = document.getElementById('nav');
  const sidebar = document.querySelector('.sidebar');
  if (!nav || !sidebar) return;
  const phone = window.matchMedia(PHONE);
  const root = document.documentElement;

  // ---- The bar: four pages and More ------------------------------------------------------------------------
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'tab m-more m-flat';
  more.setAttribute('aria-haspopup', 'dialog');
  more.setAttribute('aria-expanded', 'false');
  more.innerHTML = `${MORE_ICON}<span>More</span>`;
  sidebar.append(more);

  const menu = makeSheet({ id: 'm-sheet', title: 'More' });
  menu.sheet.classList.add('m-menu');
  menu.sheet.setAttribute('aria-label', 'Menu');
  menu.body.innerHTML = `<div class="m-me" hidden><span class="avatar m-me-avatar" aria-hidden="true"></span><span class="m-me-text"><b translate="no"></b><small></small></span></div>
    <nav class="m-pages" aria-label="Main"></nav>
    <div class="m-tools"></div>`;
  more.setAttribute('aria-controls', menu.sheet.id);
  const tools = menu.body.querySelector('.m-tools');

  // The top bar's controls, each in a row of its own; a marker keeps each one's place for wider screens.
  const rows = [
    ['tenant', 'Tenant', document.getElementById('tenant-pick')],
    ['conn', 'Connections', document.getElementById('conn-group')],
    ['lang', 'Language', document.querySelector('.topbar-actions > .lang-pick')],
    ['theme', 'Theme', document.getElementById('theme-toggle')],
  ].filter(([, , el]) => el);
  const movable = rows.map(([key, label, el]) => {
    const row = document.createElement('div');
    row.className = `m-row m-row-${key}`;
    row.innerHTML = `<span class="m-ico" aria-hidden="true">${ROW_ICONS[key]}</span><span class="m-lbl">${label}</span>`;
    tools.append(row);
    const mark = document.createComment(`m:${el.id || el.className}`);
    el.before(mark);
    return { el, mark, home: row };
  });
  const theme = document.getElementById('theme-toggle');
  tools.querySelector('.m-row-theme')?.addEventListener('click', (event) => {
    if (theme && !theme.contains(event.target)) theme.click();
  });
  const help = document.createElement('a');
  help.className = 'm-row m-row-help';
  help.href = '#/help';
  help.innerHTML = `<span class="m-ico" aria-hidden="true">${HELP_ICON}</span><span class="m-lbl">Get help</span>`;
  tools.append(help);
  const refresh = document.getElementById('app-refresh');
  if (refresh) {
    const mark = document.createComment('m:app-refresh');
    refresh.before(mark);
    movable.push({ el: refresh, mark, home: tools });
  }

  function markPrimary() {
    const tabs = usableTabs(nav);
    const primary = new Set(tabs.slice(0, PRIMARY));
    for (const a of nav.querySelectorAll(':scope > a.tab')) a.toggleAttribute('data-primary', primary.has(a));
    // More is "where you are" when the page you are on is not one of the four.
    const current = nav.querySelector(':scope > a.tab.active');
    more.classList.toggle('active', Boolean(current && !primary.has(current)) || menu.open);
    more.hidden = tabs.length <= PRIMARY && !movable.length;
  }

  // Every page, grouped as the menu groups them, each group one rounded list.
  function fillPages() {
    const pages = menu.body.querySelector('.m-pages');
    const copy = nav.cloneNode(true);
    copy.querySelector('#nav-pinned')?.remove();
    for (const el of copy.querySelectorAll('.nav-pinned-head, .nav-pinned-empty, .nav-pin, .perm-hidden, [hidden]')) el.remove();
    for (const el of copy.querySelectorAll('[id]')) el.removeAttribute('id');
    const out = [];
    let group = null;
    let tone = 0;
    const start = (head) => {
      group = document.createElement('div');
      group.className = 'm-group';
      group.dataset.tone = String(tone++ % 6);
      if (head) {
        const label = document.createElement('p');
        label.className = 'm-group-label';
        label.textContent = head.textContent.trim();
        out.push(label);
      }
      out.push(group);
    };
    for (const el of [...copy.children]) {
      if (el.classList.contains('nav-group')) start(el);
      else if (el.matches('a.tab')) {
        if (!group) start(null);
        el.classList.remove('nav-folded');
        el.removeAttribute('data-primary');
        group.append(el);
      }
    }
    // A heading with nothing under it is dropped.
    pages.replaceChildren(...out.filter((el, i) => !(el.classList.contains('m-group-label') && !out[i + 1]?.children.length) && !(el.classList.contains('m-group') && !el.children.length)));
    // Who you are, at the top.
    const name = document.getElementById('me-name')?.textContent.trim();
    const me = menu.body.querySelector('.m-me');
    me.hidden = !name;
    if (name) {
      me.querySelector('.m-me-avatar').textContent = document.getElementById('me-avatar')?.textContent ?? '';
      me.querySelector('b').textContent = name;
      me.querySelector('small').textContent = document.getElementById('me-role')?.textContent ?? '';
    }
  }

  menu.onshow = () => {
    more.setAttribute('aria-expanded', 'true');
    markPrimary();
  };
  menu.onhide = () => {
    more.setAttribute('aria-expanded', 'false');
    markPrimary();
  };
  more.addEventListener('click', () => {
    if (menu.open) return menu.hide();
    fillPages();
    menu.show();
  });
  menu.sheet.addEventListener('click', (event) => {
    if (event.target.closest('.m-pages a.tab, a.m-row')) menu.hide({ restore: false });
  });

  // ---- The Workbench: what to load is one row that opens a sheet ------------------------------------------
  const scopePanel = document.querySelector('#page-dashboard .panel.scope');
  const scope = scopePanel && makeSheet({ id: 'm-scope', title: 'What to load', closeLabel: 'Done', done: true });
  let scopeRow = null;
  if (scope) {
    scope.sheet.classList.add('m-scope-sheet');
    const scopeMark = document.createComment('m:scope');
    scopePanel.before(scopeMark);
    movable.push({ el: scopePanel, mark: scopeMark, home: scope.body });
    scopeRow = document.createElement('div');
    scopeRow.className = 'm-scope-row';
    scopeRow.innerHTML = `<button type="button" class="m-scope-open m-flat" aria-haspopup="dialog" aria-controls="m-scope"><span class="m-ico" aria-hidden="true">${SCOPE_ICON}</span><span class="m-scope-text"><b></b><small></small></span></button><button type="button" class="m-scope-load m-flat">Load</button>`;
    const metrics = document.querySelector('#dash-top .dash-metrics');
    (metrics ?? scopeMark).after(scopeRow);
    const fetchBtn = document.getElementById('fetch');
    const stopBtn = document.getElementById('fetch-stop');
    const load = scopeRow.querySelector('.m-scope-load');
    const summarise = () => {
      // The time window only: engines, branch and narrowing wait behind Narrow down.
      const picks = [...scopePanel.querySelectorAll('.scope-row > .scope-field > select')].map((select) => select.selectedOptions[0]?.textContent.trim()).filter(Boolean);
      scopeRow.querySelector('b').textContent = [...new Set(picks)].join(' · ');
      const narrowed = document.getElementById('scope-summary');
      const meta = document.getElementById('fetch-meta');
      scopeRow.querySelector('small').textContent = (narrowed && !narrowed.hidden && narrowed.textContent.trim()) || meta?.textContent.trim() || '';
      const loading = stopBtn && !stopBtn.hidden;
      load.textContent = loading ? stopBtn.textContent.trim() : 'Load';
      load.classList.toggle('m-stop', Boolean(loading));
      load.disabled = !loading && Boolean(fetchBtn?.disabled);
      load.hidden = !fetchBtn || fetchBtn.classList.contains('perm-hidden') || fetchBtn.hidden;
    };
    let queued = false;
    const later = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        summarise();
      });
    };
    new MutationObserver(later).observe(scopePanel, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'class'] });
    scopePanel.addEventListener('change', later);
    scopeRow.querySelector('.m-scope-open').addEventListener('click', () => scope.show());
    load.addEventListener('click', () => (stopBtn && !stopBtn.hidden ? stopBtn : fetchBtn)?.click());
    fetchBtn?.addEventListener('click', () => scope.hide({ restore: false }));
    summarise();
  }

  // Get started folds into one line; a tap opens it.
  const started = document.getElementById('getting-started');
  started?.addEventListener('click', (event) => {
    if (!root.hasAttribute('data-phone') || !event.target.closest('.gs-head') || event.target.closest('button, a')) return;
    started.classList.toggle('m-open');
  });

  // ---- Projects: rows, a Select mode, and a project's own screen -------------------------------------------
  const table = document.getElementById('projects');
  const body = document.getElementById('projects-body');
  let detailId = null;
  if (table && body) {
    const head = document.querySelector('#page-dashboard .wb-main > .panel-head');
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'link m-select';
    select.setAttribute('aria-pressed', 'false');
    select.textContent = 'Select';
    head?.querySelector('h2')?.after(select);
    select.addEventListener('click', () => {
      const on = !table.classList.contains('m-selecting');
      table.classList.toggle('m-selecting', on);
      select.setAttribute('aria-pressed', String(on));
      select.textContent = on ? 'Done' : 'Select';
    });

    const backCell = () => {
      const td = document.createElement('td');
      td.className = 'm-detail-head';
      td.innerHTML = `<button type="button" class="m-back m-flat">${BACK_ICON}<span>Projects</span></button>`;
      return td;
    };
    // The Workbench's actions, for this project alone: the same buttons the selection bar has.
    const actCell = () => {
      const td = document.createElement('td');
      td.className = 'm-detail-act';
      const shown = [...document.querySelectorAll('#act-bar [data-rail-open]')].filter((b) => !b.hidden && !b.classList.contains('perm-hidden') && !b.disabled);
      for (const b of shown) {
        const act = document.createElement('button');
        act.type = 'button';
        act.className = 'm-row m-flat';
        act.dataset.mAct = b.dataset.railOpen;
        act.innerHTML = `<span class="m-ico" aria-hidden="true">${b.querySelector('svg')?.outerHTML ?? ''}</span><span class="m-lbl"></span>`;
        act.querySelector('.m-lbl').textContent = b.textContent.trim();
        td.append(act);
      }
      return shown.length ? td : null;
    };
    const apply = () => {
      for (const tr of body.querySelectorAll('tr.m-detail')) tr.classList.remove('m-detail');
      if (!detailId) return;
      const tr = body.querySelector(`tr[data-id="${CSS.escape(detailId)}"]`);
      if (!tr) return closeDetail({ fromHistory: false });
      tr.classList.add('m-detail');
      if (!tr.querySelector('.m-detail-head')) tr.prepend(backCell());
      if (!tr.querySelector('.m-detail-act')) {
        const act = actCell();
        if (act) tr.append(act);
      }
    };
    // Acting on one project: it alone is ticked, then the action's panel opens.
    const actOn = (id, rail) => {
      for (;;) {
        const other = [...body.querySelectorAll('input[data-select]:checked')].find((box) => box.dataset.select !== id);
        if (!other) break;
        other.click();
      }
      const own = body.querySelector(`input[data-select="${CSS.escape(id)}"]`);
      if (own && !own.checked) own.click();
      closeDetail();
      document.querySelector(`#act-bar [data-rail-open="${CSS.escape(rail)}"]`)?.click();
    };
    const openDetail = (id) => {
      detailId = id;
      root.classList.add('m-detail-open');
      history.pushState({ mDetail: id }, '');
      apply();
      body.querySelector('tr.m-detail')?.scrollTo(0, 0);
      const screen = body.querySelector('tr.m-detail');
      if (screen) {
        screen.tabIndex = -1;
        screen.focus({ preventScroll: true });
      }
    };
    function closeDetail({ fromHistory = false } = {}) {
      if (!detailId) return;
      const id = detailId;
      detailId = null;
      root.classList.remove('m-detail-open');
      for (const tr of body.querySelectorAll('tr.m-detail')) tr.classList.remove('m-detail');
      for (const td of body.querySelectorAll('td.m-detail-head, td.m-detail-act')) td.remove();
      if (!fromHistory && history.state?.mDetail) history.back();
      body.querySelector(`tr[data-id="${CSS.escape(id)}"] td.name`)?.focus?.();
    }
    window.addEventListener('popstate', () => closeDetail({ fromHistory: true }));
    // The table redraws itself after every change: keep the open project open.
    new MutationObserver(apply).observe(body, { childList: true });
    body.addEventListener('click', (event) => {
      if (!root.hasAttribute('data-phone')) return;
      if (event.target.closest('.m-back')) return closeDetail();
      const act = event.target.closest('[data-m-act]');
      if (act && detailId) return actOn(detailId, act.dataset.mAct);
      const tr = event.target.closest('tr[data-id]');
      if (!tr || tr.classList.contains('m-detail')) return;
      if (table.classList.contains('m-selecting')) {
        const box = tr.querySelector('input[data-select]');
        if (box && event.target !== box) {
          event.preventDefault();
          box.click();
        }
        return;
      }
      if (event.target.closest('button, input, select, textarea, label, details')) return;
      event.preventDefault();
      openDetail(tr.dataset.id);
    });
  }

  // ---- Tabs: nothing scrolls sideways. Up to three tabs share the width; more become one button that
  // opens a sheet listing them (with the group headings Settings has).
  const STRIPS = '.ptabs, .set-nav-list, .tabs, .subtabs, .section-nav';
  const ITEMS = ':scope > button, :scope > a, :scope > [role="tab"]';
  const isActive = (el) => el.matches('.active, [aria-selected="true"], [aria-current="page"], [aria-current="true"]');
  const usable = (el) => !el.hidden && !el.classList.contains('perm-hidden') && getComputedStyle(el).display !== 'none' && !el.closest('[hidden]');
  const picker = makeSheet({ id: 'm-pick', title: '', top: true });
  picker.sheet.classList.add('m-pick-sheet');
  const CHEVRON = svg('<path d="M7 10l5 5 5-5" />');
  const CHECK = svg('<path d="M5 12l5 5 9-10" />');
  const strips = new Map();
  function labelOf(item) {
    const copy = item.cloneNode(true);
    for (const x of copy.querySelectorAll('.badge, .help-q, [aria-hidden="true"]:not(.ptab-count)')) x.remove();
    return copy.textContent.replace(/\s+/g, ' ').trim();
  }
  function refreshStrip(strip) {
    const entry = strips.get(strip);
    if (!entry || !root.hasAttribute('data-phone')) return;
    const items = [...strip.querySelectorAll(ITEMS)];
    // Its own classes are left as they are while they are right: changing them would wake the observer again.
    const shown = items.filter(usable);
    const few = shown.length <= 3 && !strip.matches('.set-nav-list');
    strip.classList.toggle('m-seg', few);
    strip.classList.toggle('m-picked', !few);
    if (entry.button.hidden !== few) entry.button.hidden = few;
    if (!few) {
      const active = shown.find(isActive) ?? shown[0];
      const text = active ? labelOf(active) : '';
      const span = entry.button.querySelector('span');
      if (span.textContent !== text) span.textContent = text;
    }
  }
  function openPicker(strip) {
    const items = [...strip.querySelectorAll(':scope > *')];
    const title = strip.getAttribute('aria-label') || strip.closest('[aria-label]')?.getAttribute('aria-label') || '';
    picker.sheet.querySelector('h2').textContent = title;
    const out = [];
    let group = null;
    for (const el of items) {
      if (el.matches('.set-group, .nav-group')) {
        if (!usable(el)) continue;
        const label = document.createElement('p');
        label.className = 'm-group-label';
        label.textContent = el.textContent.trim();
        out.push(label);
        group = null;
        continue;
      }
      if (!el.matches('button, a, [role="tab"]') || !usable(el)) continue;
      if (!group) {
        group = document.createElement('div');
        group.className = 'm-group m-pick-list';
        out.push(group);
      }
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'm-row m-flat';
      row.innerHTML = `<span class="m-lbl"></span>${isActive(el) ? `<span class="m-check" aria-hidden="true">${CHECK}</span>` : ''}`;
      row.querySelector('.m-lbl').textContent = labelOf(el);
      if (isActive(el)) row.setAttribute('aria-current', 'true');
      row.addEventListener('click', () => {
        picker.hide({ restore: false });
        el.click();
        strips.get(strip)?.button.focus({ focusVisible: false });
      });
      group.append(row);
    }
    // A heading with nothing under it is dropped.
    picker.body.replaceChildren(...out.filter((el, i) => !(el.classList.contains('m-group-label') && !out[i + 1]?.classList.contains('m-group'))));
    picker.show();
  }
  function enhanceStrips() {
    for (const strip of document.querySelectorAll(STRIPS)) {
      if (strip.closest('.m-sheet') || strips.has(strip)) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'm-tabpick m-flat';
      button.hidden = true;
      button.setAttribute('aria-haspopup', 'dialog');
      button.innerHTML = `<span></span>${CHEVRON}`;
      button.addEventListener('click', () => openPicker(strip));
      strip.before(button);
      strips.set(strip, { button });
      new MutationObserver(() => refreshStrip(strip)).observe(strip, { subtree: true, attributes: true, attributeFilter: ['class', 'aria-selected', 'aria-current', 'hidden'], childList: true, characterData: true });
      refreshStrip(strip);
    }
  }

  // ---- Filters: the search stays; everything else waits behind Filter --------------------------------------
  const filterSheets = [];
  for (const box of document.querySelectorAll('.filters, .gv-tools')) {
    const search = box.querySelector(':scope > input[type="search"]');
    if (!search) continue;
    const rest = [...box.children].filter((el) => el !== search);
    if (!rest.length) continue;
    const sheet = makeSheet({ id: `m-filter-${filterSheets.length}`, title: 'Filter', closeLabel: 'Done', done: true });
    sheet.sheet.classList.add('m-filter-sheet');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'm-filter m-flat';
    button.setAttribute('aria-haspopup', 'dialog');
    button.innerHTML = `${svg('<path d="M4 6h16M7 12h10M10 18h4" />')}<span>Filter</span><b class="m-filter-n" hidden></b>`;
    box.append(button);
    for (const el of rest) {
      const mark = document.createComment('m:filter');
      el.before(mark);
      movable.push({ el, mark, home: sheet.body });
    }
    const count = () => {
      const n = rest.filter((el) => (el.matches('select') && el.value) || el.querySelector?.(':scope > select:not([value=""])')?.value || el.querySelector?.('input[type="checkbox"]:checked') || (el.matches('input[type="checkbox"]') && el.checked)).length;
      const badge = button.querySelector('.m-filter-n');
      badge.textContent = String(n);
      badge.hidden = !n;
      button.classList.toggle('on', n > 0);
    };
    sheet.body.addEventListener('change', count);
    box.addEventListener('change', count);
    button.addEventListener('click', () => sheet.show());
    // Exporting is done from the sheet; it closes so you see the result.
    sheet.body.addEventListener('click', (event) => {
      if (event.target.closest('button:not(.col-picker *)')) sheet.hide({ restore: false });
    });
    filterSheets.push({ sheet, count });
    count();
  }

  // ---- Closing, and the app bar settling as the page scrolls ----------------------------------------------
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    const open = [picker, ...filterSheets.map((f) => f.sheet), menu, scope].find((s) => s?.open);
    if (open) open.hide();
    else if (detailId && !root.classList.contains('m-sheet-open') && !event.target.closest?.('.credit-editor, .wb-rail')) body?.querySelector('tr.m-detail .m-back')?.click();
  });
  window.addEventListener('hashchange', () => {
    menu.hide({ restore: false });
    scope?.hide({ restore: false });
    picker.hide({ restore: false });
    for (const f of filterSheets) f.sheet.hide({ restore: false });
    if (detailId) {
      detailId = null;
      root.classList.remove('m-detail-open');
      for (const td of document.querySelectorAll('td.m-detail-head, td.m-detail-act')) td.remove();
      for (const tr of document.querySelectorAll('tr.m-detail')) tr.classList.remove('m-detail');
    }
    queueMicrotask(markPrimary);
    setTimeout(() => {
      enhanceStrips();
      for (const strip of strips.keys()) refreshStrip(strip);
    }, 0);
  });
  let scrolled = false;
  window.addEventListener(
    'scroll',
    () => {
      const now = window.scrollY > 6;
      if (now !== scrolled) root.classList.toggle('m-scrolled', (scrolled = now));
    },
    { passive: true },
  );

  function place() {
    const onPhone = phone.matches;
    root.toggleAttribute('data-phone', onPhone);
    for (const { el, mark, home } of movable) {
      if (onPhone && el.parentNode !== home) home.append(el);
      else if (!onPhone && el.parentNode === home) mark.after(el);
    }
    if (scopeRow) scopeRow.hidden = !onPhone;
    if (onPhone) enhanceStrips();
    for (const [strip, { button }] of strips) {
      if (onPhone) refreshStrip(strip);
      else {
        strip.classList.remove('m-seg', 'm-picked');
        button.hidden = true;
      }
    }
    for (const f of filterSheets) f.count();
    if (!onPhone) {
      menu.hide({ restore: false });
      scope?.hide({ restore: false });
      picker.hide({ restore: false });
      for (const f of filterSheets) f.sheet.hide({ restore: false });
      table?.classList.remove('m-selecting');
    }
    markPrimary();
  }
  phone.addEventListener('change', place);
  let looking = false;
  new MutationObserver(() => {
    if (looking || !root.hasAttribute('data-phone')) return;
    looking = true;
    requestAnimationFrame(() => {
      looking = false;
      enhanceStrips();
    });
  }).observe(document.querySelector('main') ?? document.body, { childList: true, subtree: true });
  // Permissions, pins and the active page change the four: watch the menu.
  new MutationObserver(markPrimary).observe(nav, { subtree: true, attributes: true, attributeFilter: ['class', 'hidden'], childList: true });
  place();
  return { menu, scope, markPrimary };
}
