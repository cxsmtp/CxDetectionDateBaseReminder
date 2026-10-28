import test from 'node:test';
import assert from 'node:assert/strict';

import { numberOf, setTableState, sortAndFilter, tableFiltered } from '../public/table-tools.js';

test('numbers as tables write them: separators, units, currency and percentages', () => {
  assert.equal(numberOf('1,234'), 1234);
  assert.equal(numberOf('97,715'), 97715);
  assert.equal(numberOf('12.5 %'), 12.5);
  assert.equal(numberOf('$7.50'), 7.5);
  assert.equal(numberOf('39d'), 39);
  assert.equal(numberOf('-3'), -3);
  assert.equal(numberOf('—'), null);
  assert.equal(numberOf(''), null);
  assert.equal(numberOf('Project 10'), null, 'a name with a number is a name');
  assert.equal(numberOf('2026-10-14'), null, 'a date is not one number');
});

test('every row is sorted and filtered, not one page; empty values go last; the table’s own order comes back', () => {
  const people = [
    { name: 'Dev', role: 'User', last: Date.parse('2026-10-01') },
    { name: 'ana', role: 'Admin', last: null },
    { name: 'Bo', role: 'User', last: Date.parse('2026-10-14') },
    { name: 'Cy', role: 'Security Analyst', last: Date.parse('2026-09-01') },
  ];
  const cols = [(p) => p.name, (p) => p.role, { value: (p) => p.last, text: (p) => (p.last ? new Date(p.last).toISOString().slice(0, 10) : '') }];
  const names = (list) => list.map((p) => p.name);
  assert.deepEqual(names(sortAndFilter('t1', people, cols)), ['Dev', 'ana', 'Bo', 'Cy'], 'nothing chosen: as given');
  setTableState('t1', { col: 0, dir: 'asc' });
  assert.deepEqual(names(sortAndFilter('t1', people, cols)), ['ana', 'Bo', 'Cy', 'Dev'], 'A to Z, whatever the case');
  setTableState('t1', { col: 2, dir: 'desc' });
  assert.deepEqual(names(sortAndFilter('t1', people, cols)), ['Bo', 'Dev', 'Cy', 'ana'], 'newest first, never-signed-in last');
  setTableState('t1', { col: 2, dir: 'asc' });
  assert.deepEqual(names(sortAndFilter('t1', people, cols)), ['Cy', 'Dev', 'Bo', 'ana'], 'empty last both ways');
  setTableState('t1', { filter: [1, { values: ['User'] }] });
  assert.equal(tableFiltered('t1'), true);
  assert.deepEqual(names(sortAndFilter('t1', people, cols)), ['Dev', 'Bo'], 'only the values ticked');
  setTableState('t1', { filter: [1, null], col: -1 });
  setTableState('t1', { filter: [0, { text: 'Y' }] });
  assert.deepEqual(names(sortAndFilter('t1', people, cols)), ['Cy'], 'contains, ignoring case');
  setTableState('t1', { filter: [0, null] });
  assert.equal(tableFiltered('t1'), false);
});

test('a column of numbers compares: >10, <=5, =0', () => {
  const rows = [{ n: 0 }, { n: 5 }, { n: 12 }, { n: null }];
  const cols = [(r) => r.n];
  const out = (text) => sortAndFilter('t2', rows, cols).map((r) => r.n) && (setTableState('t2', { filter: [0, { text }] }), sortAndFilter('t2', rows, cols).map((r) => r.n));
  assert.deepEqual(out('>10'), [12]);
  assert.deepEqual(out('<=5'), [0, 5]);
  assert.deepEqual(out('=0'), [0]);
  setTableState('t2', { col: 0, dir: 'desc', filter: [0, null] });
  assert.deepEqual(sortAndFilter('t2', rows, cols).map((r) => r.n), [12, 5, 0, null], 'largest first, empty last');
});

test('a table drawn a page at a time keeps what is picked on its headings under its renderer\'s key', async () => {
  // The heading's funnel and arrows store the reader's choice under keyOf(table); the renderer reads it with
  // sortAndFilter(key): for a paged table (data-tt) they must be the same key, or a filter shows but does nothing.
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../public/table-tools.js', import.meta.url), 'utf8');
  assert.match(source, /const keyOf = \(table\) => \{\n\s*if \(table\.dataset\.tt\) return table\.dataset\.tt;/);
  setTableState('paged-key', { filter: [0, { values: ['b'] }] });
  assert.deepEqual(sortAndFilter('paged-key', [{ v: 'a' }, { v: 'b' }], [(r) => r.v]).map((r) => r.v), ['b']);
  assert.equal(tableFiltered('paged-key'), true);
});
