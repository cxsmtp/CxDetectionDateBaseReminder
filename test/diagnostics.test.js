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

test('scrub cuts huge text before scrubbing, so a 4 MB message costs next to nothing', () => {
  const huge = 'a.b-'.repeat(1024 * 1024);
  const started = performance.now();
  const clean = scrub(huge);
  assert.ok(performance.now() - started < 200, 'scrubbing 4 MB took too long');
  assert.ok(clean.length <= 300);
});

test('scrub stays quick on text built to make its patterns backtrack, and keeps its catches', () => {
  // Shapes that make a pattern with nested or overlapping repeats crawl: long runs of labels,
  // separators and near-misses of every kind it looks for, each at the most the scrubber reads.
  const shapes = ['a.', 'a-', '/a', '/', 'a@', 'b.', 'eyJ.', '1.', 'a+', 'a.b-', 'x@y.', '\\a', 'C:/a', 'a'];
  for (const shape of shapes) {
    const text = shape.repeat(Math.ceil(4000 / shape.length));
    const started = performance.now();
    for (let i = 0; i < 5; i += 1) scrub(text);
    assert.ok((performance.now() - started) / 5 < 50, `scrubbing ${JSON.stringify(shape)}… took too long`);
  }
  assert.equal(scrub('host db.corp.internal:5432 and first.last@mail.acme.co.uk from 192.168.1.10:8080 in C:\\Users\\bob\\x.json'), 'host <host>:5432 and <email> from <ip> in <path>');
});

test('a feature or event called __proto__ or constructor is just a name in the report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-'));
  const file = path.join(dir, 'd.jsonl');
  // As if the log file held such names (the server only ever writes fixed ones).
  const lines = [
    { at: new Date().toISOString(), kind: 'usage', event: '__proto__', status: 500, ms: 5 },
    { at: new Date().toISOString(), kind: 'usage', event: 'constructor', status: 200, ms: 7 },
    { at: new Date().toISOString(), kind: 'error', event: '__proto__' },
  ];
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const report = new Diagnostics({ file }).report();
  assert.equal(Object.prototype.uses, undefined, 'Object.prototype untouched');
  assert.equal({}.failures, undefined);
  assert.equal(Object.getOwnPropertyDescriptor(report.features, '__proto__').value.uses, 1);
  assert.equal(Object.getOwnPropertyDescriptor(report.features, 'constructor').value.averageMs, 7);
  assert.equal(Object.getOwnPropertyDescriptor(report.errors.byEvent, '__proto__').value, 1);
  assert.equal(Object.getPrototypeOf(report.errors.byEvent), Object.prototype);
});
