// Links in the emails MissionZero writes: whatever an address comes from (settings, Checkmarx One,
// a template value), only a web or mail address becomes a link, never javascript: or data:.
import test from 'node:test';
import assert from 'node:assert/strict';

import { render, safeUrl } from '../src/template.js';
import { impactSummary } from '../src/impact-summary.js';
import { supportEmail } from '../src/support.js';
import { systemEmail } from '../src/hands-off.js';

const HOSTILE = ['javascript:alert(1)', ' JavaScript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', '\u0001javascript:alert(1)'];

test('safeUrl keeps web, mail and relative addresses and refuses every other scheme', () => {
  for (const good of ['https://cx.example/projects/1', 'http://mz.local:3000/#/impact', 'mailto:team@example.com', '/#/help/SUP-0001', '#top', 'reports/1?x=1&y=2']) assert.equal(safeUrl(good), good, good);
  for (const bad of HOSTILE) assert.equal(safeUrl(bad), '', JSON.stringify(bad));
  assert.equal(safeUrl(null), '');
  assert.equal(safeUrl(''), '');
});

test('a template value that starts a link is a web address or nothing; the same value as text is only escaped', () => {
  for (const bad of HOSTILE) {
    const html = render('<a href="{{url}}">{{url}}</a> <img src={{url}}>', { url: bad });
    assert.ok(!/href="[^"]*script:/i.test(html) && !/src=[^>]*script:/i.test(html), html);
    assert.match(html, /^<a href="">/);
  }
  assert.equal(render('<a href="{{url}}">x</a>', { url: 'https://cx.example/a?b=1&c=2' }), '<a href="https://cx.example/a?b=1&amp;c=2">x</a>');
  assert.equal(render("<a href='{{{url}}}'>x</a>", { url: 'javascript:alert(1)' }), "<a href=''>x</a>", 'raw values are checked too');
  assert.equal(render('Open {{url}}', { url: 'javascript:alert(1)' }), 'Open javascript:alert(1)', 'not a link: shown, escaped, as written');
  assert.equal(render('<a href="https://cx.example/{{id}}">x</a>', { id: 'javascript:1' }), '<a href="https://cx.example/javascript:1">x</a>', 'inside a fixed address it cannot change the scheme');
  assert.equal(render('{{url}}', { url: 'javascript:alert(1)' }, { escape: false }), 'javascript:alert(1)', 'plain-text templates are left alone');
});

const impact = { money: { value: null, cost: null, net: null, currency: '' }, debt: { change: null, start: 0, now: 0, zeroBy: null }, hours: { total: 0, triage: 0, fix: 0 }, noiseRemoved: 0, aiFixed: 0, manualFixed: 0, credits: { triage: 0, remediation: 0, total: 0 }, timeToFix: [], byProject: [], series: [], settings: { triageMinutes: 10, fixMinutes: 30, hourlyRate: null }, from: '2026-01-01', to: '2026-02-01', partial: false, since: null };

test('the monthly impact summary links to the Impact page only at a web address', () => {
  const good = impactSummary(impact, { email: true, pageUrl: 'https://mz.example/#/impact' });
  assert.match(good.html, /<a href="https:\/\/mz\.example\/#\/impact">Open the Impact page<\/a>/);
  for (const bad of HOSTILE) {
    const { html, text } = impactSummary(impact, { email: true, pageUrl: bad });
    assert.doesNotMatch(html, /Open the Impact page/, JSON.stringify(bad));
    assert.ok(!text.includes(bad), 'nor in the text');
  }
});

const ticket = { id: 'SUP-0001', kind: 'case', status: 'new', subject: 'Help', priority: '', requester: { name: 'Ann', email: 'ann@example.com' }, messages: [{ text: 'Hi' }] };

test('a support email links to the request only at a web address', () => {
  const good = supportEmail(ticket, { event: 'created', to: 'requester', url: 'https://mz.example/' });
  assert.match(good.html, /<a href="https:\/\/mz\.example\/#\/help\/SUP-0001">/);
  assert.match(good.text, /at https:\/\/mz\.example\/#\/help\/SUP-0001/);
  for (const bad of HOSTILE) {
    const { html } = supportEmail(ticket, { event: 'created', to: 'requester', url: bad });
    assert.doesNotMatch(html, /<a href=/, JSON.stringify(bad));
  }
});

test("a system email's buttons are links only at web addresses", () => {
  const m = systemEmail({ subject: 'Status', buttons: [{ label: 'Pause', url: 'https://mz.example/a/x' }, ...HOSTILE.map((url) => ({ label: 'Evil', url }))] });
  assert.match(m.html, /<a href="https:\/\/mz\.example\/a\/x"[^>]*>Pause<\/a>/);
  assert.doesNotMatch(m.html, /Evil|script:/i);
});
