import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReportData } from '../src/reminder.js';
import { generateHtmlReport } from '../src/html-report.js';

const risk = (i, severity) => ({
  id: `r${i}`,
  riskId: `r${i}`,
  scanId: 's1',
  projectId: 'p1',
  projectName: 'Proj',
  title: `Vuln ${i}`,
  severity,
  scanner: 'SAST',
  location: `a.js:${i}`,
  state: 'TO_VERIFY',
  firstDetectedAt: '2025-01-01T00:00:00.000Z',
  ageDays: 100 + i,
});

test('the HTML report keeps every finding and carries the severity counts', () => {
  const risks = Array.from({ length: 60 }, (_, i) => risk(i, i % 3 ? 'HIGH' : 'CRITICAL'));
  const data = buildReportData(risks, { tenant: 't' });
  const html = generateHtmlReport(data, { apiBaseUrl: 'http://localhost' });

  assert.equal(data.criticalCount, 20);
  assert.equal(data.highCount, 40);
  assert.equal((html.match(/class="finding-card"/g) ?? []).length, 60);
  assert.ok(html.includes('data-risk-id="r0"'));
  assert.ok(html.includes('Engine:</span> SAST'));
  assert.ok(!html.includes('undefined'));
});
