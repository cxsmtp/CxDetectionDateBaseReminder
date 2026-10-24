// Govern (beta): who consumption counts towards, and decisions that stick.
import test from 'node:test';
import assert from 'node:assert/strict';

import { attribute, decide, isBot, ratio, score, tabOf, tokens } from '../src/govern/attribution.js';

const users = new Map(
  [
    { id: 'u1', username: 'ada', email: 'ada.lovelace@acme.io', firstName: 'Ada', lastName: 'Lovelace' },
    { id: 'u2', username: 'cx-julian-chuan', email: 'julian@acme.io', firstName: 'Julian', lastName: 'Chuan' },
    { id: 's1', username: 'sean.casey', email: 'sean.casey@acme.io', firstName: 'Sean', lastName: 'Casey' },
    { id: 's2', username: 'scasey', email: 's.casey@acme.io', firstName: 'Sean', lastName: 'Casey' },
    { id: 'g1', username: 'grace.hopper', email: 'grace.hopper@acme.io', firstName: 'Grace', lastName: 'Hopper' },
  ].map((u) => [u.id, { enabled: true, groups: [], ...u }]),
);
const org = { users, projects: new Map([['p1', { id: 'p1', name: 'Payments' }], ['p2', { id: 'p2', name: 'Web' }], ['p3', { id: 'p3', name: 'Web' }]]), applications: new Map(), groups: new Map() };
const row = (name, email = '', credits = 1, id = '') => ({ key: (email || name).toLowerCase(), name, email, id, credits });
const latest = (rows, projects = []) => ({ user: new Map(rows.map((r) => [r.key, r])), project: new Map(projects.map((r) => [r.key, r])) });

test('tokens, scores and bots as the spec defines them', () => {
  assert.deepEqual(tokens('cx-julian.chuan@acme.io'), ['julian', 'chuan']);
  assert.deepEqual(tokens('J Smith'), ['smith']);
  assert.equal(score(['ada', 'lovelace'], ['lovelace', 'ada']), 1);
  assert.ok(score(['grace', 'hoper'], ['grace', 'hopper']) >= 0.6);
  assert.ok(Math.abs(ratio('abcd', 'bcde') - 0.75) < 1e-9, 'SequenceMatcher-like');
  assert.equal(isBot('dependabot[bot]'), true);
  assert.equal(isBot('renovate@acme.io'), true);
  assert.equal(isBot('ada'), false);
});

test('the exact ladder, automation and bots, and namesakes never merged', () => {
  const { rows, map } = attribute(latest([row('Ada', 'ADA.LOVELACE@acme.io'.toLowerCase()), row('julian-chuan'), row('Sean Casey'), row('Auto-triage'), row('dependabot[bot]'), row('grace hoper')]), org, new Map());
  const by = (name) => rows.find((r) => r.name === name);
  assert.equal(by('Ada').status, 'exact');
  assert.equal(by('julian-chuan').entityId, 'u2', 'username without the cx- prefix');
  assert.equal(by('Sean Casey').status, 'disputed');
  assert.equal(by('Sean Casey').suggestions.length, 2);
  assert.equal(by('Auto-triage').status, 'automation');
  assert.equal(by('dependabot[bot]').status, 'bot');
  assert.equal(by('grace hoper').status, 'auto', 'a close, clear fuzzy match');
  assert.equal(map.user.get('grace hoper'), 'g1');
  assert.ok(!map.user.has('sean casey'), 'a dispute counts towards nobody');
  assert.equal(tabOf(by('Sean Casey')), 'disputes');
  assert.equal(tabOf(by('dependabot[bot]')), 'unmatched');
});

test('projects: by id, then unique name; duplicate names are disputes', () => {
  const { rows } = attribute(latest([], [{ key: 'payments', name: 'Payments', email: '', id: '', credits: 3 }, { key: 'web', name: 'Web', email: '', id: '', credits: 2 }, { key: 'p9', name: 'Gone', email: '', id: 'p9', credits: 1 }]), org, new Map());
  const by = (name) => rows.find((r) => r.name === name);
  assert.equal(by('Payments').entityId, 'p1');
  assert.equal(by('Web').status, 'disputed');
  assert.deepEqual(by('Web').suggestions.map((s) => s.id).sort(), ['p2', 'p3']);
  assert.equal(by('Gone').status, 'unmatched');
});

test('decisions stick: a rejected match never re-attaches, a pin wins, ignore counts towards nobody; aliases carry them', () => {
  const decisions = new Map();
  const rows = [row('grace hoper')];
  decide(decisions, { key: 'user:grace hoper', action: 'reject', currentMatch: 'g1', name: 'grace hoper' }, { by: 'admin@acme.io' });
  let r = attribute(latest(rows), org, decisions).rows[0];
  assert.notEqual(r.entityId, 'g1');
  assert.ok(!r.suggestions.some((s) => s.id === 'g1'), 'never suggested again');
  decide(decisions, { key: 'user:grace hoper', action: 'pin', entityId: 'g1' }, { by: 'admin@acme.io' });
  r = attribute(latest(rows), org, decisions).rows[0];
  assert.equal(r.status, 'pinned');
  // The same person under another spelling with the same tokens: the decision carries over.
  const alias = attribute(latest([row('Hoper, Grace')]), org, decisions);
  assert.equal(alias.rows[0].status, 'pinned');
  assert.equal(alias.rows[0].decision.alias, true);
  assert.deepEqual(alias.aliasesAdded, [['user:grace hoper', 'hoper, grace']]);
  decide(decisions, { key: 'user:grace hoper', action: 'ignore' }, { by: 'admin@acme.io' });
  assert.equal(attribute(latest(rows), org, decisions).rows[0].status, 'ignored');
  // A pin to someone no longer in Checkmarx One: kept, flagged, back in the disputes.
  decide(decisions, { key: 'user:grace hoper', action: 'pin', entityId: 'gone' }, { by: 'admin@acme.io' });
  const ghost = attribute(latest(rows), org, decisions).rows[0];
  assert.deepEqual([ghost.status, ghost.ghost, ghost.entityId], ['disputed', true, null]);
  assert.equal(decide(decisions, { key: 'user:grace hoper', action: 'clear' }, { by: 'a' }).after, null);
  assert.throws(() => decide(decisions, { key: 'tenant:x', action: 'pin', entityId: 'y' }, { by: 'a' }), { status: 400 });
  assert.throws(() => decide(decisions, { key: 'user:x', action: 'reject' }, { by: 'a' }), /no match/);
});
