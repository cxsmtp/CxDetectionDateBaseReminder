import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dominantDomain,
  indexDirectory,
  normalizeUsername,
  suggestEmail,
} from '../src/cxone/directory.js';
import { groupRisksByProject } from '../src/cxone/initiators.js';
import { isSafeImageUrl } from '../src/settings.js';

test('a Checkmarx username normalises to the local part the tenant already uses', () => {
  assert.equal(normalizeUsername('cx-julian-chuan'), 'julian.chuan');
  assert.equal(normalizeUsername('cx_mallory_woods'), 'mallory.woods');
  assert.equal(normalizeUsername('CX-Andy-Schmit'), 'andy.schmit');
  assert.equal(normalizeUsername('svc-build'), 'build');
  assert.equal(normalizeUsername('rustin.sides@checkmarx.com'), 'rustin.sides');
  assert.equal(normalizeUsername(''), '');
  assert.equal(normalizeUsername('--weird--name--'), 'weird.name');
});

test('the dominant domain is learned from the addresses already known', () => {
  assert.equal(
    dominantDomain([
      'avery.speller@checkmarx.com',
      'serge.ingber@checkmarx.com',
      'someone@contractor.io',
    ]),
    'checkmarx.com',
  );
  assert.equal(dominantDomain([]), '');
  assert.equal(dominantDomain(['', null, 'not-an-email']), '');
});

test('an unresolved username becomes a confident suggestion from the pattern alone', () => {
  const domain = 'checkmarx.com';
  const result = suggestEmail('cx-julian-chuan', { domain });

  assert.equal(result.email, 'julian.chuan@checkmarx.com');
  assert.equal(result.via, 'pattern');
  assert.equal(result.confidence, 'likely', 'offered for confirmation, not applied silently');
});

test('a name-shaped username is a likely match; a single word is only a guess', () => {
  assert.equal(suggestEmail('cx-jeff-clare', { domain: 'x.com' }).confidence, 'likely');
  assert.equal(suggestEmail('buildbot', { domain: 'x.com' }).confidence, 'guess');
});

test('the directory beats the pattern, and counts as exact', () => {
  const index = indexDirectory([
    { username: 'cx-jacob-rand', email: 'j.rand@checkmarx.com', firstName: 'Jacob', lastName: 'Rand' },
  ]);
  const result = suggestEmail('cx-jacob-rand', { index, domain: 'checkmarx.com' });

  // Without the directory the pattern would have produced jacob.rand@…, which
  // is wrong here — so an exact hit has to win.
  assert.equal(result.email, 'j.rand@checkmarx.com');
  assert.equal(result.confidence, 'exact');
});

test('the directory is matched by username, local part and full name', () => {
  const index = indexDirectory([
    { username: 'mwoods', email: 'mallory.woods@checkmarx.com', firstName: 'Mallory', lastName: 'Woods' },
  ]);
  assert.equal(suggestEmail('mwoods', { index }).email, 'mallory.woods@checkmarx.com');
  assert.equal(suggestEmail('mallory.woods', { index }).email, 'mallory.woods@checkmarx.com');
  assert.equal(suggestEmail('cx-mallory-woods', { index }).email, 'mallory.woods@checkmarx.com');
});

test('an override still wins, and an address-shaped username needs no help', () => {
  assert.equal(
    suggestEmail('cx-jeff-clare', { domain: 'x.com', overrides: { 'cx-jeff-clare': 'jc@other.com' } }).email,
    'jc@other.com',
  );
  const direct = suggestEmail('Rustin.Sides@checkmarx.com', {});
  assert.equal(direct.email, 'rustin.sides@checkmarx.com');
  assert.equal(direct.confidence, 'exact');
});

test('with no domain to work from, nothing is invented', () => {
  assert.deepEqual(suggestEmail('cx-julian-chuan', {}), { email: '', via: 'unresolved', confidence: 'none' });
  assert.equal(suggestEmail('', { domain: 'x.com' }).confidence, 'none');
});

// ---------------------------------------------------------------------------

test('per-project grouping gives one message per project, not per person', () => {
  const risk = (projectId, projectName, id) => ({ projectId, projectName, id, severity: 'HIGH' });
  const byProject = {
    p1: { initiator: 'jdoe', email: 'jane@x.com' },
    p2: { initiator: 'jdoe', email: 'jane@x.com' },
    p3: { initiator: 'jdoe', email: 'jane@x.com' },
    p4: { initiator: 'jdoe', email: 'jane@x.com' },
  };

  const groups = groupRisksByProject(
    [risk('p1', 'A', 1), risk('p2', 'B', 2), risk('p3', 'C', 3), risk('p4', 'D', 4), risk('p1', 'A', 5)],
    byProject,
  );

  // One person, four projects -> four messages.
  assert.equal(groups.length, 4);
  assert.ok(groups.every((g) => g.email === 'jane@x.com'));
  assert.deepEqual(groups.map((g) => g.projectName).sort(), ['A', 'B', 'C', 'D']);
  assert.equal(groups[0].projectName, 'A', 'largest project first');
  assert.equal(groups[0].risks.length, 2);
  assert.ok(groups.every((g) => g.projectCount === 1));
});

test('a logo URL is only accepted over https or as an inline image', () => {
  assert.equal(isSafeImageUrl('https://acme.com/logo.png'), true);
  assert.equal(isSafeImageUrl('data:image/png;base64,iVBORw0KGgo='), true);
  assert.equal(isSafeImageUrl('http://acme.com/logo.png'), false, 'mail clients block mixed content');
  assert.equal(isSafeImageUrl('javascript:alert(1)'), false);
  assert.equal(isSafeImageUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(isSafeImageUrl(''), false);
});
