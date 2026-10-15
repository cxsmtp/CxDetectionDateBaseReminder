// Sort and filter from the column headings, on every data table: the page's (the app, the Cx
// Credits Calculator) and the interactive report's (inlined there by src/html-report.js).
//
// Each heading gets a sort arrow and a filter funnel. Click the heading (or its arrow) to sort,
// again for the other way, a third time for the table's own order. The funnel opens a small box:
// type to keep rows whose cell contains it (on a column of numbers, ">10", "<=5" or "=0" compare),
// or tick the values to keep when the column has only a few. Filters on several columns combine.
//
// Tables the app shows whole are sorted and filtered where they stand, and again whenever the app
// draws them anew. A table shown a page at a time says so with data-tt="<key>": its renderer asks
// sortAndFilter() for the rows in order, so sorting and filtering cover every row, not one page.
// Rows that belong together move together: a row with fewer cells than the headings (its detail
// line) stays under the row above it, and rows sharing data-result (one Checkmarx One result) stay
// side by side. Empty cells ("—") always come last. Nothing is sent anywhere, and nothing is kept
// beyond this page: a reload shows each table in its own order again.

const SELECTOR = 'table.data-table, table.probe, table.rp-table, table.net-table, table#findings';
const SKIP = '.iam-matrix, [data-tt-off]';
const EMPTY = /^(?:|—|-|–|n\/a)$/i;
// The note above a filtered table (its numbers looked up as {0}, {1} by the translator).
const NOTE = 'Showing {0} of {1} rows';
const NOTE_PAGE = 'Showing {0} of {1} rows on this page';
const FUNNEL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16l-6 7.5V19l-4 1.5v-8z"/></svg>';
const ARROWS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="tt-up" d="M8 10l4-4 4 4"/><path class="tt-down" d="M8 14l4 4 4-4"/></svg>';

const states = new Map(); // table key -> { col, dir, filters: Map(col -> { text, values: Set|null }) }
const arrayTables = new Map(); // key -> { rerender, items, columns }
const done = new WeakSet();
let say = (text) => text;
let pop = null;
let popFor = null;

const stateOf = (key) => {
  if (!states.has(key)) states.set(key, { col: -1, dir: '', filters: new Map() });
  return states.get(key);
};

/** "1,234", "56 %", "$7.50", "12 d", "3.4 h": the number in it, or null. */
export function numberOf(text) {
  const s = String(text ?? '').replace(/[\s  ]/g, '');
  if (!s || EMPTY.test(s)) return null;
  const m = /^[^\d+-]{0,3}([+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[+-]?\d+(?:\.\d+)?)(?:[%a-zA-Z/×]{0,6})$/.exec(s);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

const textOf = (cell) => (cell ? cell.textContent.replace(/\s+/g, ' ').trim() : '');
/** What a cell sorts by: its data-tt-sort (a severity's rank, a date's time) when it has one, else its text. */
const sortTextOf = (cell) => (cell?.dataset.ttSort !== undefined ? cell.dataset.ttSort : textOf(cell));
const headerCells = (table) => [...(table.tHead?.rows[table.tHead.rows.length - 1]?.cells ?? [])];
const usable = (th) => !th.classList.contains('checkbox') && !th.querySelector('input') && th.dataset.ttCol !== 'off' && th.textContent.trim() !== '';
const keyOf = (table) => {
  const host = table.id || table.tBodies[0]?.id || table.closest('[id]')?.id || '';
  return `${table.dataset.tt || host}|${headerCells(table).map((th) => th.textContent.trim()).join('|')}`;
};

const isEmpty = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v)) || EMPTY.test(String(v).trim());

/** Compare two values for sorting: numbers as numbers, text naturally; empty last whichever way. */
function compare(a, b, numeric, dir = 'asc') {
  const ea = isEmpty(a);
  const eb = isEmpty(b);
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  const d = numeric ? Number(a) - Number(b) : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  return dir === 'desc' ? -d : d;
}

/** Does a value pass a column's filter (typed text, or the values ticked)? */
function passes(filter, text, numeric) {
  if (!filter) return true;
  if (filter.values && !filter.values.has(text)) return false;
  const want = String(filter.text ?? '').trim();
  if (!want) return true;
  const cmp = /^(<=|>=|<|>|=)\s*(-?[\d.,]+)$/.exec(want);
  if (cmp && numeric) {
    const n = numberOf(text);
    const v = Number(cmp[2].replace(/,/g, ''));
    if (n === null) return false;
    return { '<': n < v, '<=': n <= v, '>': n > v, '>=': n >= v, '=': n === v }[cmp[1]];
  }
  return text.toLowerCase().includes(want.toLowerCase());
}

const active = (state) => state.col >= 0 || [...state.filters.values()].some((f) => f.values || String(f.text ?? '').trim());

// ---- Tables shown whole: sorted and filtered where they stand ------------------------------------

/** The table's rows as units: a row with its detail rows, and units of one result kept together. */
function unitsOf(table) {
  const width = headerCells(table).length;
  const units = [];
  for (const row of table.tBodies[0]?.rows ?? []) {
    const span = [...row.cells].reduce((n, c) => n + (c.colSpan || 1), 0);
    const lead = row.cells.length >= Math.min(width, 2) && !(row.cells.length === 1 && span >= width);
    if (lead && row.cells.length > 1) units.push({ rows: [row], lead: row });
    else if (units.length) units[units.length - 1].rows.push(row);
    else units.push({ rows: [row], lead: null }); // "Loading…", "Nothing here": stays where it is
  }
  units.forEach((u, i) => {
    if (u.lead && u.lead.__ttOrder === undefined) u.lead.__ttOrder = i;
  });
  return units;
}

function numericColumn(values) {
  const filled = values.filter((v) => !EMPTY.test(String(v).trim()));
  return filled.length > 0 && filled.filter((v) => numberOf(v) !== null).length / filled.length >= 0.8;
}

function applyDom(table) {
  const key = keyOf(table);
  const state = stateOf(key);
  const units = unitsOf(table);
  const leads = units.filter((u) => u.lead);
  const tbody = table.tBodies[0];
  if (!tbody || !leads.length) return;
  const cols = headerCells(table).length;
  const numeric = [];
  for (let c = 0; c < cols; c++) numeric[c] = numericColumn(leads.map((u) => sortTextOf(u.lead.cells[c])));
  // Filter: a unit shows when its lead row passes every column's filter.
  const filterNumeric = new Map([...state.filters.keys()].map((c) => [c, numericColumn(leads.map((l) => textOf(l.lead.cells[c])))]));
  let shown = 0;
  for (const u of leads) {
    const ok = [...state.filters].every(([c, f]) => passes(f, textOf(u.lead.cells[c]), filterNumeric.get(c)));
    for (const r of u.rows) r.classList.toggle('tt-hidden', !ok);
    if (ok) shown += 1;
  }
  // Sort: by the chosen column, else the table's own order; one result's rows stay side by side.
  const value = (u) => {
    const text = sortTextOf(u.lead.cells[state.col]);
    return numeric[state.col] ? numberOf(text) : text;
  };
  const ordered = [...leads].sort((a, b) => {
    if (state.col < 0 || !state.dir) return a.lead.__ttOrder - b.lead.__ttOrder;
    return compare(value(a), value(b), numeric[state.col], state.dir) || a.lead.__ttOrder - b.lead.__ttOrder;
  });
  const grouped = [];
  const placed = new Set();
  for (const u of ordered) {
    if (placed.has(u)) continue;
    const group = u.lead.dataset.result ? ordered.filter((o) => o.lead.dataset.result === u.lead.dataset.result) : [u];
    for (const g of group) {
      placed.add(g);
      grouped.push(g);
    }
  }
  const before = units.filter((u) => !u.lead);
  const order = [...before, ...grouped].flatMap((u) => u.rows);
  if (order.some((r, i) => tbody.rows[i] !== r)) for (const r of order) tbody.append(r);
  for (const u of leads) u.lead.__ttDone = true;
  note(table, active(state) && [...state.filters.values()].some((f) => f.values || String(f.text ?? '').trim()) ? { shown, total: leads.length } : null);
}

/** "Showing 12 of 40 rows · Clear filters" above a filtered table. */
function note(table, counts) {
  const anchor = table.closest('.table-wrap, .scroll') ?? table;
  let bar = anchor.previousElementSibling?.classList.contains('tt-note') ? anchor.previousElementSibling : null;
  if (!counts) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'tt-note';
    anchor.before(bar);
  }
  // A table the server sends a page at a time is filtered on the page in view only, and says so.
  const words = (table.hasAttribute('data-tt-page') ? NOTE_PAGE : NOTE).replace('{0}', counts.shown).replace('{1}', counts.total);
  bar.innerHTML = `<span>${say(words)}</span> <button type="button" class="link tt-clear">${say('Clear filters')}</button>`;
  bar.querySelector('.tt-clear').onclick = () => {
    stateOf(keyOf(table)).filters.clear();
    refresh(table);
  };
}

// ---- Tables shown a page at a time: the renderer sorts and filters every row ---------------------

/**
 * For a table drawn a page at a time (<table data-tt="key">): register how to draw it again, and
 * get its rows sorted and filtered by what the reader chose. `columns[i]` reads heading i from an
 * item: a function, or {value, text} (value sorts, text filters; text defaults to value), or null.
 */
export function sortAndFilter(key, items, columns, rerender) {
  arrayTables.set(key, { rerender, items, columns });
  const state = stateOf(key);
  const read = (c, item) => {
    const col = columns[c];
    if (!col) return { value: '', text: '' };
    const value = typeof col === 'function' ? col(item) : col.value(item);
    const text = typeof col === 'function' || !col.text ? String(value ?? '') : String(col.text(item) ?? '');
    return { value, text };
  };
  const numeric = columns.map((col, c) => (col ? items.length > 0 && items.every((it) => { const v = read(c, it).value; return v === null || v === undefined || v === '' || typeof v === 'number'; }) : false));
  let out = items.filter((it) => [...state.filters].every(([c, f]) => passes(f, read(c, it).text, numeric[c])));
  if (state.col >= 0 && state.dir && columns[state.col]) {
    const indexed = out.map((it, i) => ({ it, i, v: read(state.col, it).value }));
    indexed.sort((a, b) => compare(a.v, b.v, numeric[state.col], state.dir) || a.i - b.i);
    out = indexed.map((x) => x.it);
  }
  if (typeof document !== 'undefined') for (const table of document.querySelectorAll(`table[data-tt="${CSS.escape(key)}"]`)) paintHeaders(table);
  return out;
}

/** Choose a sort or a filter on a table from code (tests; a page preset): {col, dir} and/or {filter: [col, {text, values}]}. */
export function setTableState(key, { col, dir, filter } = {}) {
  const state = stateOf(key);
  if (col !== undefined) Object.assign(state, { col, dir: dir ?? '' });
  if (filter) {
    const [c, f] = filter;
    if (f) state.filters.set(c, { text: f.text ?? '', values: f.values ? new Set(f.values) : null });
    else state.filters.delete(c);
  }
}

/** Is anything chosen on this table (so a renderer can say "of all" / reset its page)? */
export const tableFiltered = (key) => [...stateOf(key).filters.values()].some((f) => f.values || String(f.text ?? '').trim());

// ---- The headings ------------------------------------------------------------------------------

function paintHeaders(table) {
  const state = stateOf(keyOf(table));
  const arr = arrayTables.get(table.dataset.tt || '');
  headerCells(table).forEach((th, c) => {
    if (!th.__tt) return;
    // A column its renderer gives nothing to sort or filter by (buttons, credits being edited): no controls.
    const tools = th.querySelector('.tt-tools');
    if (tools) tools.hidden = Boolean(arr) && !arr.columns[c];
    th.classList.toggle('tt-sortable', !tools?.hidden && Boolean(tools?.querySelector('.tt-sort')));
    const sorted = state.col === c && state.dir;
    if (!th.dataset.sort) th.setAttribute('aria-sort', sorted ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    th.classList.toggle('tt-sorted', Boolean(sorted));
    th.dataset.ttDir = sorted ? state.dir : '';
    const f = state.filters.get(c);
    th.classList.toggle('tt-filtered', Boolean(f && (f.values || String(f.text ?? '').trim())));
  });
}

function refresh(table) {
  const key = keyOf(table);
  const arr = arrayTables.get(table.dataset.tt || '');
  if (arr) arr.rerender?.();
  else applyDom(table);
  for (const t of document.querySelectorAll(SELECTOR)) if (keyOf(t) === key) paintHeaders(t);
}

function sortBy(table, c) {
  const state = stateOf(keyOf(table));
  const arr = arrayTables.get(table.dataset.tt || '');
  const numeric = arr
    ? arr.items.length > 0 && arr.columns[c] && arr.items.every((it) => typeof (typeof arr.columns[c] === 'function' ? arr.columns[c](it) : arr.columns[c].value(it)) !== 'string')
    : numericColumn(unitsOf(table).filter((u) => u.lead).map((u) => sortTextOf(u.lead.cells[c])));
  // Numbers start largest first, words A to Z; a third click goes back to the table's own order.
  const first = numeric ? 'desc' : 'asc';
  if (state.col !== c) Object.assign(state, { col: c, dir: first });
  else if (state.dir === first) state.dir = first === 'asc' ? 'desc' : 'asc';
  else Object.assign(state, { col: -1, dir: '' });
  refresh(table);
}

function enhance(table) {
  if (done.has(table) || table.matches(SKIP)) return;
  const heads = headerCells(table);
  if (heads.length < 2) return;
  done.add(table);
  table.classList.add('tt');
  // A table with its own sorting (th[data-sort]) keeps it; it gains the filters.
  const ownSort = heads.some((th) => th.dataset.sort);
  heads.forEach((th, c) => {
    if (!usable(th) || th.__tt) return;
    th.__tt = true;
    const label = th.textContent.trim();
    const tools = document.createElement('span');
    tools.className = 'tt-tools';
    tools.innerHTML = `${ownSort ? '' : `<button type="button" class="tt-sort" title="${say('Sort by this column')}" aria-label="${say('Sort by this column')}">${ARROWS}</button>`}<button type="button" class="tt-filter" title="${say('Filter this column')}" aria-label="${say('Filter this column')}" aria-haspopup="dialog">${FUNNEL}</button>`;
    th.append(tools);
    th.classList.add('tt-th');
    if (!ownSort) th.classList.add('tt-sortable');
    tools.querySelector('.tt-filter').addEventListener('click', (event) => {
      event.stopPropagation();
      openFilter(table, c, label, event.currentTarget);
    });
    tools.querySelector('.tt-sort')?.addEventListener('click', (event) => {
      event.stopPropagation();
      sortBy(table, c);
    });
    if (!ownSort) {
      th.addEventListener('click', (event) => {
        if (event.target.closest('a, button, input, select, label, summary, .col-menu') || tools.hidden) return;
        sortBy(table, c);
      });
    }
  });
  paintHeaders(table);
  if (!table.dataset.tt && active(stateOf(keyOf(table)))) applyDom(table);
}

// ---- The filter box --------------------------------------------------------------------------------

function valuesOf(table, c) {
  const arr = arrayTables.get(table.dataset.tt || '');
  if (arr) {
    const col = arr.columns[c];
    if (!col) return [];
    return arr.items.map((it) => String((typeof col === 'function' ? col(it) : (col.text ?? col.value)(it)) ?? '').trim());
  }
  return unitsOf(table).filter((u) => u.lead).map((u) => textOf(u.lead.cells[c]));
}

function openFilter(table, c, label, button) {
  closeFilter();
  const state = stateOf(keyOf(table));
  const current = state.filters.get(c) ?? { text: '', values: null };
  const all = valuesOf(table, c);
  const counts = new Map();
  for (const v of all) counts.set(v, (counts.get(v) ?? 0) + 1);
  const distinct = [...counts.keys()].sort((a, b) => compare(a, b, false));
  const list = distinct.length > 1 && distinct.length <= 15;
  pop = document.createElement('div');
  pop.className = 'tt-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', say('Filter this column'));
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
  pop.innerHTML = `<p class="tt-pop-title"><span>${say('Filter')}</span>: <b translate="no">${esc(label)}</b></p>
    <input type="search" class="tt-pop-text" placeholder="${esc(say('Contains…'))}" value="${esc(current.text ?? '')}" />
    ${numericColumn(all) ? `<p class="tt-pop-hint">${say('Numbers: >10, <=5 or =0 compare.')}</p>` : ''}
    ${list ? `<div class="tt-pop-values">${distinct.map((v, i) => `<label><input type="checkbox" value="${i}"${!current.values || current.values.has(v) ? ' checked' : ''} /> <span translate="no">${esc(EMPTY.test(v) ? '—' : v)}</span> <em>${counts.get(v)}</em></label>`).join('')}</div>` : ''}
    <div class="tt-pop-actions"><button type="button" class="link tt-pop-clear">${say('Clear')}</button><button type="button" class="sm primary tt-pop-done">${say('Done')}</button></div>`;
  document.body.append(pop);
  popFor = { table, button };
  const place = () => {
    const r = button.getBoundingClientRect();
    const w = pop.offsetWidth;
    const left = Math.max(8, Math.min(window.scrollX + r.left - w / 2 + r.width / 2, window.scrollX + document.documentElement.clientWidth - w - 8));
    pop.style.left = `${left}px`;
    pop.style.top = `${window.scrollY + r.bottom + 6}px`;
  };
  place();
  button.setAttribute('aria-expanded', 'true');
  const apply = () => {
    const text = pop.querySelector('.tt-pop-text').value;
    let values = null;
    if (list) {
      const ticked = [...pop.querySelectorAll('.tt-pop-values input')].filter((b) => b.checked).map((b) => distinct[Number(b.value)]);
      if (ticked.length < distinct.length) values = new Set(ticked);
    }
    if (!String(text).trim() && !values) state.filters.delete(c);
    else state.filters.set(c, { text, values });
    refresh(table);
  };
  let timer = null;
  pop.querySelector('.tt-pop-text').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(apply, 200);
  });
  pop.querySelector('.tt-pop-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      apply();
      closeFilter();
    }
  });
  pop.querySelector('.tt-pop-values')?.addEventListener('change', apply);
  pop.querySelector('.tt-pop-clear').addEventListener('click', () => {
    state.filters.delete(c);
    refresh(table);
    closeFilter();
  });
  pop.querySelector('.tt-pop-done').addEventListener('click', () => {
    apply();
    closeFilter();
  });
  pop.querySelector('.tt-pop-text').focus();
}

function closeFilter() {
  if (!pop) return;
  popFor?.button?.setAttribute('aria-expanded', 'false');
  popFor?.button?.focus?.({ preventScroll: true });
  pop.remove();
  pop = null;
  popFor = null;
}

// ---- Start -----------------------------------------------------------------------------------------

/**
 * Give every data table on the page (now, and whenever one is drawn) sorting and filtering on its
 * headings. `translate` words the controls in the reader's language.
 */
export function startTableTools({ translate } = {}) {
  if (translate) say = (text) => translate(text);
  const scan = () => {
    for (const table of document.querySelectorAll(SELECTOR)) {
      if (!done.has(table)) {
        enhance(table);
        continue;
      }
      // Headings drawn anew (a column added or taken away): give the new ones their controls.
      if (headerCells(table).some((th) => usable(th) && !th.__tt)) {
        done.delete(table);
        enhance(table);
      }
      if (!table.dataset.tt && active(stateOf(keyOf(table)))) {
        // Rows drawn anew by the app: put the reader's sorting and filters back.
        const fresh = [...(table.tBodies[0]?.rows ?? [])].some((r) => r.cells.length > 1 && !r.__ttDone);
        if (fresh) applyDom(table);
      }
    }
  };
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      scan();
    });
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('click', (event) => {
    if (pop && !pop.contains(event.target) && !event.target.closest('.tt-filter')) closeFilter();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && pop) closeFilter();
  });
  scan();
}
