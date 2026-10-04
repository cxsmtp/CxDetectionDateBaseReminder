// SLAs (Beta): days to fix each severity, overdue and due soon, escalated once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_SLA, addSla, escalationMail, mergeSla, newlyOverdue, pruneEscalated, slaOf, slaSummary } from '../src/sla.js';
import { AutomationState } from '../src/automation.js';

const DAY = 86_400_000;
const now = Date.parse('2026-10-04T12:00:00Z');
const risk = (id, severity, daysAgo, extra = {}) => ({ id, riskId: id, projectId: extra.projectId ?? 'p1', projectName: 'Payments', severity, state: 'TO_VERIFY', title: `Finding ${id}`, firstDetectedAt: new Date(now - daysAgo * DAY).toISOString(), ...extra });

test('SLA settings: days per severity kept in range, 0 means none, addresses checked', () => {
  const s = mergeSla(DEFAULT_SLA, { days: { CRITICAL: '3', HIGH: 0, MEDIUM: 99999, LOW: 'x' }, escalate: true, escalateTo: 'Lead@Acme.com, not-an-address; ops@acme.com' });
  assert.deepEqual(s.days, { CRITICAL: 3, HIGH: 0, MEDIUM: 3650, LOW: 0 });
  assert.equal(s.escalate, true);
  assert.deepEqual(s.escalateTo, ['lead@acme.com', 'ops@acme.com']);
  assert.deepEqual(mergeSla(s, { escalate: false }).days, s.days, 'other fields untouched');
  assert.deepEqual(mergeSla(undefined).days, DEFAULT_SLA.days);
});

test('a finding is overdue past its severity\'s days, due soon within 7; not exploitable and no-date findings have none', () => {
  assert.equal(slaOf(risk('a', 'CRITICAL', 8), DEFAULT_SLA, now).overdue, true);
  assert.equal(slaOf(risk('b', 'CRITICAL', 6), DEFAULT_SLA, now).overdue, false);
  assert.equal(slaOf(risk('b', 'CRITICAL', 6), DEFAULT_SLA, now).dueSoon, true);
  assert.equal(slaOf(risk('c', 'HIGH', 10), DEFAULT_SLA, now).dueSoon, false, '20 days left');
  assert.equal(slaOf(risk('d', 'HIGH', 40, { state: 'NOT_EXPLOITABLE' }), DEFAULT_SLA, now), null);
  assert.equal(slaOf(risk('e', 'INFO', 400), DEFAULT_SLA, now), null, 'no SLA for INFO');
  assert.equal(slaOf({ ...risk('f', 'LOW', 1), firstDetectedAt: null }, DEFAULT_SLA, now), null);
  assert.equal(slaOf(risk('g', 'HIGH', 400), { days: { HIGH: 0 } }, now), null, '0: no SLA');

  const summary = slaSummary([risk('a', 'CRITICAL', 8), risk('b', 'CRITICAL', 6), risk('h', 'HIGH', 45), risk('i', 'LOW', 1)], DEFAULT_SLA, now);
  assert.deepEqual(summary, { overdue: 2, dueSoon: 1, bySeverity: { CRITICAL: 1, HIGH: 1 }, mostOverdueDays: 15 });
  assert.deepEqual(addSla([summary, slaSummary([risk('j', 'MEDIUM', 100)], DEFAULT_SLA, now), null]), { overdue: 3, dueSoon: 1, bySeverity: { CRITICAL: 1, HIGH: 1, MEDIUM: 1 }, mostOverdueDays: 15 });
});

test('each overdue finding is escalated once; fixed ones are forgotten, so a regression is escalated again', () => {
  const open = [risk('a', 'CRITICAL', 8), risk('h', 'HIGH', 45), risk('b', 'CRITICAL', 6)];
  const escalated = {};
  const first = newlyOverdue(open, DEFAULT_SLA, escalated, now);
  assert.deepEqual(first.map((x) => x.risk.id), ['h', 'a'], 'most overdue first');
  for (const { risk: r } of first) escalated[`${r.projectId}|${r.riskId}`] = 'x';
  assert.equal(newlyOverdue(open, DEFAULT_SLA, escalated, now).length, 0);
  assert.equal(pruneEscalated(escalated, [risk('a', 'CRITICAL', 8)]), 1, 'h was fixed');
  assert.deepEqual(newlyOverdue([...open], DEFAULT_SLA, escalated, now).map((x) => x.risk.id), ['h'], 'h came back: escalated again');
});

test('the escalation email lists each finding, how far past, and who ran the latest scan, escaping what it shows', () => {
  const items = newlyOverdue([risk('a', 'CRITICAL', 8, { title: '<script>x</script>' }), risk('h', 'HIGH', 45, { projectId: 'p2' })], DEFAULT_SLA, {}, now);
  const mail = escalationMail(items, { appName: 'CxMissionZero', initiators: { p1: { email: 'dev@acme.io' }, p2: { initiator: 'jdoe' } } });
  assert.equal(mail.subject, '2 findings past their SLA in 2 projects');
  assert.match(mail.html, /15 days<\/b>/);
  assert.match(mail.html, /dev@acme\.io/);
  assert.match(mail.html, /jdoe/);
  assert.doesNotMatch(mail.html, /<script>x/);
  assert.match(mail.text, /15 days past SLA \(30\)/);
});

test('what was escalated is kept across restarts (the automation state file)', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sla-state-')), 'state.json');
  const state = new AutomationState({ file });
  assert.deepEqual(state.ledger.escalated, {}, 'nothing escalated yet');
  state.ledger.escalated['p1|a'] = '2026-10-04T12:00:00.000Z';
  state.persist();
  assert.deepEqual(new AutomationState({ file }).ledger.escalated, { 'p1|a': '2026-10-04T12:00:00.000Z' });
});
