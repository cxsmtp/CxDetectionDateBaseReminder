// Act → Automation: age limits per severity, what reminders cover, when they go out, and the
// branded reminder email (src/automation-config.js, src/automation.js, src/reminder-email.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_AUTOMATION, findCrossings, focusProjects, limitsFor, mergeAutomation, nextRunAfter } from '../src/automation.js';
import { buildBrandedReminder, DEFAULT_REMINDER_EMAIL, effectiveBranding, mergeReminderEmail, personName, portalColours } from '../src/reminder-email.js';
import { SettingsStore } from '../src/settings.js';
import { DEFAULT_TEMPLATE } from '../src/template.js';

test('each severity its own limits: blank is none, nonsense dropped; the same list for all when not', () => {
  const each = mergeAutomation(DEFAULT_AUTOMATION, { perSeverity: true, severityLimits: { CRITICAL: '14, 7, 7', HIGH: [60, 'x', 30], MEDIUM: '', LOW: 'none', INFO: '1' } });
  assert.deepEqual(each.severityLimits, { CRITICAL: [7, 14], HIGH: [30, 60], MEDIUM: [], LOW: [] });
  assert.deepEqual(limitsFor(each, 'HIGH'), [30, 60]);
  assert.deepEqual(limitsFor(each, 'INFO'), [], 'a severity without its own limits is not reminded about');
  assert.deepEqual(limitsFor({ ...each, perSeverity: false }, 'LOW'), DEFAULT_AUTOMATION.thresholds);

  const risks = [
    { projectId: 'p', id: 'c', severity: 'CRITICAL', ageDays: 10 },
    { projectId: 'p', id: 'h', severity: 'HIGH', ageDays: 10 },
    { projectId: 'p', id: 'm', severity: 'MEDIUM', ageDays: 400 },
  ];
  const { crossed } = findCrossings(risks, (r) => limitsFor(each, r.severity), { notified: {} });
  assert.deepEqual(crossed.map((r) => [r.id, r.threshold]), [['c', 7]], 'critical past 7 days; high not yet 30; medium has none');
});

test('when: days, a time and a time zone are checked; nothing to send on is refused', () => {
  const ok = mergeAutomation(DEFAULT_AUTOMATION, { when: 'schedule', days: [5, 1, 1, 9], at: '7:05', timeZone: 'Europe/Berlin' });
  assert.deepEqual([ok.days, ok.at, ok.timeZone], [[1, 5], '07:05', 'Europe/Berlin']);
  assert.equal(mergeAutomation(DEFAULT_AUTOMATION, { when: 'other' }).when, 'schedule');
  assert.throws(() => mergeAutomation(DEFAULT_AUTOMATION, { days: [] }), /at least one day/);
  assert.throws(() => mergeAutomation(DEFAULT_AUTOMATION, { at: '25:00' }), /hours and minutes/);
  assert.throws(() => mergeAutomation(DEFAULT_AUTOMATION, { timeZone: 'Mars/Olympus' }), /time zone/);
  assert.equal(mergeAutomation(DEFAULT_AUTOMATION, { timeZone: '' }).timeZone, '', 'blank: the server’s');
});

test('the next run: the next chosen day at the time, in its zone, across a clock change; an interval from now', () => {
  const tue = new Date('2026-10-20T20:30:00Z');
  const berlin = { ...DEFAULT_AUTOMATION, when: 'schedule', days: [1, 2, 3, 4, 5], at: '09:00', timeZone: 'Europe/Berlin' };
  assert.equal(nextRunAfter(berlin, tue).toISOString(), '2026-10-21T07:00:00.000Z', 'Wednesday 09:00 summer time');
  assert.equal(nextRunAfter({ ...berlin, days: [0] }, tue).toISOString(), '2026-10-25T08:00:00.000Z', 'Sunday 09:00, winter time from that night');
  assert.equal(nextRunAfter({ ...berlin, timeZone: 'America/New_York', days: [2] }, new Date('2026-10-20T12:30:00Z')).toISOString(), '2026-10-20T13:00:00.000Z', 'later the same day');
  assert.equal(nextRunAfter({ ...berlin, days: [] }, tue), null);
  assert.equal(nextRunAfter({ ...berlin, when: 'interval', intervalMinutes: 60 }, tue).toISOString(), '2026-10-20T21:30:00.000Z');
});

test('focus: named applications, tags or projects (any of them), less those left out; nothing named is every project', () => {
  const projects = [
    { id: '1', name: 'payments-api', tags: { team: 'pay' } },
    { id: '2', name: 'payments-sandbox', tags: {} },
    { id: '3', name: 'web', tags: { team: 'Web', tier: '1' } },
    { id: '4', name: 'mobile-app', tags: {} },
    { id: '5', name: 'demo-x', tags: {} },
  ];
  const apps = [{ id: 'a', name: 'Mobile', projectIds: ['4'] }];
  const ids = (focus) => focusProjects(projects, focus, apps).map((p) => p.id);
  assert.deepEqual(ids({}), ['1', '2', '3', '4', '5']);
  assert.deepEqual(ids({ applications: ['mobile'], projects: ['payments-*'], exclude: ['*-sandbox'] }), ['1', '4']);
  assert.deepEqual(ids({ tags: ['team:web'] }), ['3'], 'key:value, either case');
  assert.deepEqual(ids({ tags: ['tier'] }), ['3'], 'a key alone');
  assert.deepEqual(ids({ exclude: ['demo-?'] }), ['1', '2', '3', '4']);
  assert.deepEqual(mergeAutomation(DEFAULT_AUTOMATION, { focus: { projects: 'a, b,,a', exclude: ['  c '] } }).focus, { applications: [], tags: [], projects: ['a', 'b'], exclude: ['c'] });
});

const data = {
  totalRisks: 3, criticalCount: 2, highCount: 1, maxAgeDays: 41, projectCount: 2,
  crossedLimits: [{ days: 30 }, { days: 7 }],
  projects: [
    { projectName: 'payments-api', url: 'https://cx.example/riskhub/p1', critical: 2, high: 0, oldestDays: 41 },
    { projectName: '<img src=x>', url: '', critical: 0, high: 1, oldestDays: 9 },
  ],
};
const settings = { smtp: { fromName: 'Acme AppSec', fromAddress: 'security@acme.io' }, branding: { companyName: 'Acme Corp', appName: 'CxMissionZero', logoUrl: 'https://acme.io/logo.png', look: 'residence' } };

test('the branded email: the portal’s name, logo, colours and footer by default, each field filled in and escaped', () => {
  const email = { ...DEFAULT_REMINDER_EMAIL, opening: 'Hello {{name}}: {{count}} past {{limit}} <b>now</b>.' };
  const built = buildBrandedReminder(data, email, settings, { initiator: 'ana.lopez', buttonUrl: 'https://cx.example/projects', why: 'Because.' });
  assert.equal(built.subject, '3 findings in your projects are past our limits');
  assert.match(built.html, /Hi Ana,/);
  assert.match(built.html, /Hello Ana Lopez: 3 past 30 days &lt;b&gt;now&lt;\/b&gt;\./, 'what is typed is text, not markup');
  assert.match(built.html, /&lt;img src=x&gt;/);
  assert.ok(!built.html.includes('<img src=x>'));
  assert.match(built.html, /src="https:\/\/acme\.io\/logo\.png"/);
  assert.match(built.html, new RegExp(portalColours(settings.branding).head));
  assert.match(built.html, /Acme Corp · security@acme\.io · Because\./);
  assert.deepEqual(built.from, { name: 'Acme AppSec', replyTo: '' });
  assert.match(built.text, /payments-api: 2 critical, 0 high, oldest 41 days/);

  const own = buildBrandedReminder(data, { ...email, senderName: 'AppSec', replyTo: 'appsec@acme.io', logo: 'none', color: '#123456', listProjects: false }, settings, { buttonUrl: 'javascript:alert(1)' });
  assert.deepEqual(own.from, { name: 'AppSec', replyTo: 'appsec@acme.io' });
  assert.ok(!own.html.includes('logo.png'));
  assert.match(own.html, /#123456/);
  assert.ok(!own.html.includes('payments-api'), 'no project list');
  assert.ok(!own.html.includes('javascript:'), 'only an http(s) button');
  assert.equal(personName('', 'li.wei@acme.io'), 'Li Wei');
  assert.equal(effectiveBranding(DEFAULT_REMINDER_EMAIL, { smtp: {}, branding: {} }).senderName, 'CxMissionZero');
});

test('the email’s fields, checked: one reply-to address, an https logo, a #rrggbb colour; restore puts back the default', () => {
  const safe = { isSafeImageUrl: (u) => u.startsWith('https://') };
  assert.throws(() => mergeReminderEmail({}, { replyTo: 'not an address' }, safe), /Reply-to/);
  assert.throws(() => mergeReminderEmail({}, { logoUrl: 'http://x/logo.png' }, safe), /logo/);
  const e = mergeReminderEmail({}, { color: 'red', subject: '  ', senderName: 'A\nB', style: 'html', logo: 'weird' }, safe);
  assert.deepEqual([e.color, e.subject, e.senderName, e.style, e.logo], ['', DEFAULT_REMINDER_EMAIL.subject, 'A B', 'html', 'portal']);
  assert.deepEqual(mergeReminderEmail({ subject: 'x' }, { restore: true }), DEFAULT_REMINDER_EMAIL);
});

test('settings saved before: a schedule keeps its interval, and a hand-written HTML template stays in use', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-migrate-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ automation: { enabled: true, intervalMinutes: 120 }, template: { subject: 's', html: '<p>mine</p>' } }));
  const old = new SettingsStore({ file }).get();
  assert.equal(old.automation.when, 'interval');
  assert.equal(old.reminderEmail.style, 'html');
  fs.writeFileSync(file, JSON.stringify({ template: DEFAULT_TEMPLATE }));
  const fresh = new SettingsStore({ file }).get();
  assert.equal(fresh.automation.when, 'schedule');
  assert.equal(fresh.reminderEmail.style, 'simple');
});
