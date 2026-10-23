// Which columns a table shows, and in what order: chosen from its Columns menu (tick to show, arrows to move),
// kept in this browser. A table is drawn from its column list, so its heading sort and filters (table-tools.js)
// follow the columns as they are shown.
//
//   const shown = shownColumns('fusion', COLUMNS);         // [{ id, label, … }] in the reader's order
//   columnMenu($('fusion-cols'), 'fusion', COLUMNS, redraw);  // fills a <details class="col-picker">
//
// Each column: { id, label, title?, fixed? (always shown, never moved: a tick box, the project name), off? (hidden
// until chosen) }.

const KEY = (key) => `mz.columns.${key}`;

function saved(key) {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(key)) ?? 'null');
    return v && Array.isArray(v.order) && Array.isArray(v.hidden) ? v : null;
  } catch {
    return null;
  }
}
function save(key, value) {
  try {
    if (value) localStorage.setItem(KEY(key), JSON.stringify(value));
    else localStorage.removeItem(KEY(key));
  } catch {}
}

/** Every column, in the reader's order (the fixed ones where they are), each with `shown`. */
export function orderedColumns(key, columns) {
  const pref = saved(key);
  const movable = columns.filter((c) => !c.fixed);
  let order = movable;
  if (pref) {
    const byId = new Map(movable.map((c) => [c.id, c]));
    order = pref.order.map((id) => byId.get(id)).filter(Boolean);
    // A column added since: after the one it follows by default.
    for (const c of movable) {
      if (order.includes(c)) continue;
      const before = movable[movable.indexOf(c) - 1];
      const at = before ? order.indexOf(before) + 1 : 0;
      order.splice(at, 0, c);
    }
  }
  const hidden = new Set(pref ? pref.hidden : movable.filter((c) => c.off).map((c) => c.id));
  let next = 0;
  return columns.map((c) => (c.fixed ? { ...c, shown: true } : { ...order[next++], shown: !hidden.has(order[next - 1].id) }));
}

/** The columns shown, in order. */
export const shownColumns = (key, columns) => orderedColumns(key, columns).filter((c) => c.shown);

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

/** Fill a <details class="col-picker"> with the table's Columns menu; `changed()` redraws the table. */
export function columnMenu(details, key, columns, changed) {
  if (!details) return;
  const menu = details.querySelector('.col-menu');
  const draw = () => {
    const all = orderedColumns(key, columns).filter((c) => !c.fixed);
    menu.innerHTML = `<ol class="col-order">${all
      .map((c, i) => `<li data-col="${esc(c.id)}"><label class="check"${c.title ? ` title="${esc(c.title)}"` : ''}><input type="checkbox" data-col-show="${esc(c.id)}"${c.shown ? ' checked' : ''} /> <span>${esc(c.label)}</span></label><span class="col-move"><button type="button" class="icon-btn" data-col-move="-1" aria-label="Move up"${i === 0 ? ' disabled' : ''}>↑</button><button type="button" class="icon-btn" data-col-move="1" aria-label="Move down"${i === all.length - 1 ? ' disabled' : ''}>↓</button></span></li>`)
      .join('')}</ol><div class="col-menu-foot"><button type="button" class="link" data-col-reset>Reset</button><span class="hint">Kept in this browser.</span></div>`;
  };
  const store = (all) => save(key, { order: all.map((c) => c.id), hidden: all.filter((c) => !c.shown).map((c) => c.id) });
  if (!details.dataset.colMenu) {
    details.dataset.colMenu = '1';
    menu.addEventListener('change', (event) => {
      const id = event.target.dataset.colShow;
      if (!id) return;
      const all = orderedColumns(key, columns).filter((c) => !c.fixed);
      for (const c of all) if (c.id === id) c.shown = event.target.checked;
      // At least one column besides the fixed ones stays.
      if (!all.some((c) => c.shown)) return draw();
      store(all);
      changed();
    });
    menu.addEventListener('click', (event) => {
      if (event.target.closest('[data-col-reset]')) {
        save(key, null);
        draw();
        return changed();
      }
      const button = event.target.closest('[data-col-move]');
      if (!button) return;
      const id = button.closest('[data-col]').dataset.col;
      const all = orderedColumns(key, columns).filter((c) => !c.fixed);
      const i = all.findIndex((c) => c.id === id);
      const j = i + Number(button.dataset.colMove);
      if (i < 0 || j < 0 || j >= all.length) return;
      [all[i], all[j]] = [all[j], all[i]];
      store(all);
      draw();
      menu.querySelector(`[data-col="${CSS.escape(id)}"] [data-col-move="${button.dataset.colMove}"]`)?.focus();
      changed();
    });
    document.addEventListener('click', (event) => {
      if (details.open && !details.contains(event.target)) details.open = false;
    });
  }
  draw();
}
