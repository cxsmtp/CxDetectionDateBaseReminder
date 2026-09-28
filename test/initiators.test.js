import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDefaultDomain,
  groupRisksByInitiator,
  resolveFromRules,
  scanInitiator,
  scanInitiatorEmail,
} from '../src/cxone/initiators.js';
import { parseOverrides } from '../src/settings.js';

test('scanInitiator reads whichever field the tenant records', () => {
  assert.equal(scanInitiator({ initiator: 'jdoe' }), 'jdoe');
  assert.equal(scanInitiator({ createdBy: 'jdoe' }), 'jdoe');
  assert.equal(scanInitiator({ userName: '  jdoe  ' }), 'jdoe');
  assert.equal(scanInitiator({}), '');
  assert.equal(scanInitiator(undefined), '');
});

test('scanInitiatorEmail only accepts an actual address', () => {
  assert.equal(scanInitiatorEmail({ initiatorEmail: 'a@x.com' }), 'a@x.com');
  assert.equal(scanInitiatorEmail({ userEmail: 'a@x.com' }), 'a@x.com');
  assert.equal(scanInitiatorEmail({ email: 'jdoe' }), '', 'a bare username is not an address');
  assert.equal(scanInitiatorEmail({}), '');
});

test('resolution prefers the scan email, then an override, then the username', () => {
  const rules = { overrides: { jdoe: 'jane.doe@x.com' } };

  assert.deepEqual(resolveFromRules('jdoe', 'from.scan@x.com', rules), {
    email: 'from.scan@x.com',
    via: 'scan',
  });
  assert.deepEqual(resolveFromRules('jdoe', '', rules), { email: 'jane.doe@x.com', via: 'override' });
  assert.deepEqual(resolveFromRules('someone@x.com', '', {}), { email: 'someone@x.com', via: 'username' });
  assert.deepEqual(resolveFromRules('jdoe', '', {}), { email: '', via: 'unresolved' });
  assert.deepEqual(resolveFromRules('', '', {}), { email: '', via: 'none' });
});

test('an override is ignored unless it is a valid address', () => {
  assert.equal(resolveFromRules('jdoe', '', { overrides: { jdoe: 'not-an-email' } }).email, '');
});

test('the default domain applies only to a bare username', () => {
  assert.equal(applyDefaultDomain('jdoe', { defaultDomain: 'x.com' }), 'jdoe@x.com');
  assert.equal(applyDefaultDomain('jdoe', { defaultDomain: '@x.com' }), 'jdoe@x.com');
  // Someone who already has an address must not become jane@x.com@x.com.
  assert.equal(applyDefaultDomain('jane@other.com', { defaultDomain: 'x.com' }), '');
  assert.equal(applyDefaultDomain('jdoe', {}), '', 'no domain configured, no guess');
  assert.equal(applyDefaultDomain('', { defaultDomain: 'x.com' }), '');
});

test('parseOverrides accepts the formats an administrator is likely to type', () => {
  assert.deepEqual(
    parseOverrides('alice = alice@x.com\nbob:bob@x.com\ncarl -> carl@x.com;dee,dee@x.com'),
    { alice: 'alice@x.com', bob: 'bob@x.com', carl: 'carl@x.com', dee: 'dee@x.com' },
  );
  assert.deepEqual(parseOverrides('bad = nope\n\n   '), {});
  assert.deepEqual(parseOverrides({ alice: 'alice@x.com', bad: 'nope' }), { alice: 'alice@x.com' });
});

// ---------------------------------------------------------------------------

const risk = (projectId, id) => ({ projectId, id, severity: 'HIGH', bucket: '60+' });

test('one person with several projects receives a single grouped message', () => {
  const byProject = {
    p1: { initiator: 'jdoe', email: 'jane@x.com', via: 'override' },
    p2: { initiator: 'jdoe', email: 'jane@x.com', via: 'override' },
    p3: { initiator: 'bsmith', email: 'bob@x.com', via: 'directory' },
  };

  const groups = groupRisksByInitiator(
    [risk('p1', 1), risk('p2', 2), risk('p2', 3), risk('p3', 4)],
    byProject,
  );

  assert.equal(groups.length, 2, 'two people, two messages');

  const jane = groups.find((g) => g.email === 'jane@x.com');
  assert.equal(jane.risks.length, 3);
  assert.equal(jane.projectCount, 2, 'both of her projects in one message');
  assert.deepEqual(jane.projectIds.sort(), ['p1', 'p2']);

  const bob = groups.find((g) => g.email === 'bob@x.com');
  assert.equal(bob.risks.length, 1);
  assert.equal(bob.projectCount, 1);
});

test('groups are ordered by volume, largest first', () => {
  const byProject = {
    p1: { initiator: 'a', email: 'a@x.com' },
    p2: { initiator: 'b', email: 'b@x.com' },
  };
  const groups = groupRisksByInitiator([risk('p1', 1), risk('p2', 2), risk('p2', 3)], byProject);
  assert.equal(groups[0].email, 'b@x.com');
});

test('findings with no resolvable initiator group separately, not silently dropped', () => {
  const byProject = {
    p1: { initiator: 'jdoe', email: 'jane@x.com' },
    p2: { initiator: 'ghost', email: '' },
    p3: { initiator: '', email: '' },
  };

  const groups = groupRisksByInitiator([risk('p1', 1), risk('p2', 2), risk('p3', 3)], byProject);
  const unreachable = groups.filter((g) => !g.email);

  assert.equal(groups.length, 3);
  assert.equal(unreachable.length, 2);
  // Their findings are still present, so the caller can report them as skipped.
  assert.equal(unreachable.reduce((n, g) => n + g.risks.length, 0), 2);
  assert.ok(unreachable.some((g) => g.initiator === 'ghost'));
  assert.ok(unreachable.some((g) => g.initiator === ''));
});

test('a project missing from the initiator map still groups without throwing', () => {
  const groups = groupRisksByInitiator([risk('unknown-project', 1)], {});
  assert.equal(groups.length, 1);
  assert.equal(groups[0].email, '');
  assert.equal(groups[0].risks.length, 1);
});
