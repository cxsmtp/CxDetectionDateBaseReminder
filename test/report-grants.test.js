import test from 'node:test';
import assert from 'node:assert/strict';

import { GRANT_TTL_MS, ReportGrants } from '../src/report-grants.js';

const finding = { projectId: 'p1', scanId: 's1', scanner: 'SAST', alternateId: 'alt-1', groupId: '42' };

test('a grant verifies only for the exact finding it was issued for, until it expires', () => {
  const grants = new ReportGrants({ secret: 'test-secret' });
  const now = Date.now();
  const issued = grants.issue(finding, now);

  assert.equal(grants.verify({ ...finding, ...issued }, now), '');
  assert.equal(grants.verify({ ...finding, ...issued, alternateId: 'alt-2' }, now), 'invalid');
  assert.equal(grants.verify({ ...finding, ...issued, exp: issued.exp + 1 }, now), 'invalid');
  assert.equal(grants.verify({ ...finding, ...issued }, now + GRANT_TTL_MS + 1), 'expired');
  assert.equal(grants.verify({ ...finding }, now), 'invalid');
  assert.equal(new ReportGrants({ secret: 'other' }).verify({ ...finding, ...issued }, now), 'invalid');
});
