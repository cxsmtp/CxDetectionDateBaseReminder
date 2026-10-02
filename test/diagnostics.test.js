import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Diagnostics, pseudonym, recommend, scrub } from '../src/diagnostics.js';

test('scrub removes anything personal, secret or identifying', () => {
  const dirty = 'Sending to sudha@acme.io failed at https://mail.acme.io:587/x from 10.1.2.3 with key eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc and token AbCdEf0123456789AbCdEf0123456789 in /opt/app/data/settings.json on smtp.acme.com';
  const clean = scrub(dirty);
  for (const leak of ['sudha', 'acme', '10.1.2.3', 'eyJ', 'AbCdEf0123', '/opt/app', 'settings.json']) assert.ok(!clean.includes(leak), `${leak} leaked: ${clean}`);
  assert.match(clean, /<email>.*<url>.*<ip>.*<token>.*<token>.*<path>.*<host>/);
});

test('only safe fields are kept, project ids are one-way codes, and the report recommends fixes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-'));
  const d = new Diagnostics({ file: path.join(dir, 'd.jsonl'), version: 'MZ-01.00.05' });
  d.usage('GET /api/scan', { status: 200, ms: 1200, email: 'x@y.io', password: 'secret' });
  d.discrepancy('credit-verify-disagreed', { project: 'p-123', reads: [10, 11] });
  d.error('mail-failed', new Error('535 auth failed for bob@corp.com'));
  const report = d.report();
  const text = JSON.stringify(report);
  for (const leak of ['x@y.io', 'secret', 'p-123', 'bob@corp.com']) assert.ok(!text.includes(leak), `${leak} leaked`);
  assert.ok(text.includes(pseudonym('p-123')));
  assert.equal(report.features['GET /api/scan'].uses, 1);
  assert.equal(report.discrepancies.byEvent['credit-verify-disagreed'], 1);
  assert.ok(report.recommendations.some((r) => /different results on two reads/.test(r.issue)));
  assert.ok(report.recommendations.some((r) => /Sending email failed/.test(r.issue)));
});

test('nothing recorded: the recommendation says so', () => {
  assert.equal(recommend({ features: {}, errors: [], discrepancies: [] })[0].severity, 'info');
});
