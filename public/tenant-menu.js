/**
 * The tenant switcher at the top: a button and a listbox (not a native select), so each tenant can show its colour and
 * when it last fetched. "Consolidated view" comes first, then a line, for those who may see it (Labs). Keyboard: the
 * arrows, Home and End move; Enter or Space chooses; Escape (or Tab) closes and gives the focus back to the button.
 * Choosing another tenant works as before: POST /api/me/tenant, then the page starts afresh in it.
 */
import { ago, esc, tenantChip } from './labs-common.js';
import { tenantColour } from './tenant-colour.js';

export function initTenantMenu({ api, $, toast, handleAuthLoss, can, isConsolidatedPage }) {
  const wrap = $('tenant-pick');
  const button = $('tenant-button');
  const list = $('tenant-menu');
  let me = null;
  let items = [];
  let active = -1;

  const consolidatedAllowed = () => can('feature.consolidated');

  function render(next = me) {
    me = next;
    const t = me?.tenancy;
    const show = Boolean(t && (t.tenants.length > 1 || consolidatedAllowed()));
    wrap.hidden = !show;
    if (!show) return close(false);
    const onConsolidated = consolidatedAllowed() && isConsolidatedPage();
    button.classList.toggle('is-consolidated', onConsolidated);
    $('tenant-name').innerHTML = onConsolidated ? '<span>Consolidated view</span>' : esc(t.current.name);
    $('tenant-name').setAttribute('translate', onConsolidated ? 'yes' : 'no');
    button.style.setProperty('--tc', `var(--tc-${t.tenants.find((x) => x.id === t.current.id)?.colour ?? tenantColour(t.current.id)})`);
    items = [
      ...(consolidatedAllowed() ? [{ id: '#consolidated', selected: onConsolidated }] : []),
      ...t.tenants.map((x) => ({ id: x.id, selected: !onConsolidated && x.id === t.current.id, tenant: x })),
    ];
    const age = (x) => (x.fetchFailed ? '<small class="bad-text">fetch failed</small>' : x.fetchedAt ? `<small translate="no">${esc(ago(x.fetchedAt))}</small>` : '<small>not loaded</small>');
    list.innerHTML = items
      .map((item, i) => {
        const attrs = `role="option" id="tenant-opt-${i}" class="cv-item${item.selected ? ' on' : ''}" aria-selected="${item.selected}" data-index="${i}"`;
        if (item.id === '#consolidated') {
          return `<div ${attrs}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></svg><span>Consolidated view</span><small>${esc(`${t.tenants.length} tenants`)}</small></div><div class="cv-sep" role="separator"></div>`;
        }
        return `<div ${attrs}>${tenantChip(item.tenant.id, item.tenant.name, item.tenant.colour)}${age(item.tenant)}</div>`;
      })
      .join('');
  }

  function focusItem(i) {
    if (!items.length) return;
    active = (i + items.length) % items.length;
    for (const el of list.querySelectorAll('[role="option"]')) el.classList.toggle('is-active', Number(el.dataset.index) === active);
    list.setAttribute('aria-activedescendant', `tenant-opt-${active}`);
    list.querySelector(`#tenant-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
  }

  function open() {
    if (!list.hidden) return;
    render();
    list.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    list.focus();
    focusItem(Math.max(0, items.findIndex((x) => x.selected)));
  }

  function close(refocus = true) {
    if (list.hidden) return;
    list.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    list.removeAttribute('aria-activedescendant');
    if (refocus) button.focus();
  }

  async function choose(i) {
    const item = items[i];
    if (!item) return;
    close();
    if (item.id === '#consolidated') {
      location.hash = '#/consolidated';
      return;
    }
    const t = me.tenancy;
    if (item.id === t.current.id) {
      // The tenant already open: from the consolidated view, back to its Workbench.
      if (isConsolidatedPage()) location.hash = '#/dashboard';
      return;
    }
    try {
      await api('/api/me/tenant', { method: 'POST', body: JSON.stringify({ id: item.id }) });
      // Every page shows the other tenant's data: start the page afresh in it.
      if (isConsolidatedPage()) location.hash = '#/dashboard';
      location.reload();
    } catch (error) {
      if (!handleAuthLoss(error)) toast(error.message, 'error');
      render();
    }
  }

  button.addEventListener('click', () => (list.hidden ? open() : close()));
  button.addEventListener('keydown', (event) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      open();
      if (event.key === 'ArrowUp') focusItem(items.length - 1);
    }
  });
  list.addEventListener('keydown', (event) => {
    const keys = { ArrowDown: () => focusItem(active + 1), ArrowUp: () => focusItem(active - 1), Home: () => focusItem(0), End: () => focusItem(items.length - 1), Enter: () => choose(active), ' ': () => choose(active), Escape: () => close() };
    if (event.key === 'Tab') return close(false);
    const act = keys[event.key];
    if (!act) return;
    event.preventDefault();
    act();
  });
  list.addEventListener('click', (event) => {
    const el = event.target.closest('[role="option"]');
    if (el) choose(Number(el.dataset.index));
  });
  list.addEventListener('mousemove', (event) => {
    const el = event.target.closest('[role="option"]');
    if (el && Number(el.dataset.index) !== active) focusItem(Number(el.dataset.index));
  });
  document.addEventListener('click', (event) => {
    if (!list.hidden && !wrap.contains(event.target)) close(false);
  });
  window.addEventListener('hashchange', () => render());

  return { render };
}
