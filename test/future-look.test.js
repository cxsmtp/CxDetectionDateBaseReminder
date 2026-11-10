// Future: the standalone Cx Credits Calculator's look, for its files only (report and PDF summary), never offered in the app.
import test from 'node:test';
import assert from 'node:assert/strict';

import { FILE_LOOKS, LOOKS, lookPalette, reportLook } from '../public/look.js';
import { buildReport } from '../public/calculator/report.js';

test('Future is a look for files only: the app does not offer it, a report made in it opens light', () => {
  assert.ok(!LOOKS.includes('future'));
  assert.ok(FILE_LOOKS.includes('future'));
  assert.deepEqual(reportLook({ ui: 'nextgen', look: 'future' }), { look: 'future', ui: 'nextgen', theme: 'light', accent: 'indigo' });
  assert.equal(reportLook({ ui: 'nextgen', look: 'cabin' }).theme, 'light', 'as every look');
  assert.equal(lookPalette('future').future, true);
});

test('a report in Future: its own style, opened light, its dark one beside it', () => {
  const html = buildReport({ version: 2, customer: 'Acme', generatedAt: '2026-11-10T12:00:00.000Z', source: { kind: 'cxone' }, tr: null, fusion: null, fusionNew: null }, { look: { ui: 'nextgen', look: 'future' } });
  assert.match(html, /<input type="radio" name="theme" id="theme-light" checked>/);
  assert.match(html, /linear-gradient\(90deg,#22d3ee,#8b5cf6\)/);
  assert.match(html, /--fx1:#5ee7ff/, 'its dark glow');
  const plain = buildReport({ version: 2, customer: 'Acme', generatedAt: '2026-11-10T12:00:00.000Z', source: { kind: 'cxone' }, tr: null, fusion: null, fusionNew: null }, { look: { ui: 'nextgen', look: 'cabin' } });
  assert.doesNotMatch(plain, /--fx1:/, 'no other look takes it');
});
