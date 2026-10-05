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

test('a grant binds its tenant; the first tenant signs exactly as before', () => {
  const grants = new ReportGrants({ secret: 'tenant-key' });
  const base = { projectId: 'p0', riskId: 'r1', scanId: 's', scanner: 'SAST' };
  // The default tenant (and old reports with no tenant) produce an identical grant.
  const plain = grants.issue(base);
  assert.equal(grants.verify({ ...base, ...plain }), '');
  assert.equal(grants.verify({ ...base, tenant: 'default', ...plain }), '', 'default is the same as no tenant');
  // A report for tenant "acme" verifies only as acme.
  const acme = grants.issue({ ...base, tenant: 'acme' });
  assert.equal(grants.verify({ ...base, tenant: 'acme', ...acme }), '');
  assert.equal(grants.verify({ ...base, tenant: 'other', ...acme }), 'invalid', 'cannot be replayed into another tenant');
  assert.equal(grants.verify({ ...base, ...acme }), 'invalid', 'nor stripped back to the first tenant');
});

test('on a server with several tenants, grants and links are bound to the running tenant, whatever a request claims', () => {
  let running = 'acme';
  const grants = new ReportGrants({ secret: 'tenant-key', tenantOf: () => running });
  const base = { projectId: 'p1', riskId: 'r1', scanId: 's1' };
  const issued = grants.issue(base);
  assert.equal(grants.verify({ ...base, ...issued }), '');
  // A request naming the first tenant inside acme's context still verifies only as acme.
  assert.equal(grants.verify({ ...base, tenant: 'default', ...issued }), '');
  running = 'other';
  assert.equal(grants.verify({ ...base, ...issued }), 'invalid', 'acme\'s report cannot act in another tenant');
  running = 'default';
  assert.equal(grants.verify({ ...base, ...issued }), 'invalid', 'nor in the first tenant');
  // Links and tokens (macText) too, while the first tenant signs exactly as without tenants.
  const plain = new ReportGrants({ secret: 'tenant-key' });
  assert.equal(grants.macText('download\nabc'), plain.macText('download\nabc'));
  running = 'acme';
  assert.notEqual(grants.macText('download\nabc'), plain.macText('download\nabc'));
  const report = grants.signReport({ id: 'rep-1', recipient: 'dev@acme.io', issuedAt: '2026-01-01T00:00:00Z' });
  assert.ok(grants.verifyReport(report));
  running = 'other';
  assert.equal(grants.verifyReport(report), null);
});
