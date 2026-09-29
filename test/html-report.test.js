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

test('the HTML report includes activity tab functionality for logging and status', () => {
  const risks = Array.from({ length: 5 }, (_, i) => risk(i, i % 2 ? 'HIGH' : 'CRITICAL'));
  const data = buildReportData(risks, { tenant: 't' });
  const html = generateHtmlReport(data, { apiBaseUrl: 'http://localhost' });

  // Verify activity tab structure exists
  assert.ok(html.includes('activity-tabs'), 'Should have activity tabs container');
  assert.ok(html.includes('switchActivityTab'), 'Should have tab switching function');
  assert.ok(html.includes('Overview'), 'Should have Overview tab label');
  assert.ok(html.includes('Activity Log'), 'Should have Activity Log tab label');

  // Verify tab panels exist
  assert.ok(html.includes('id="overviewPanel"'), 'Should have overview panel');
  assert.ok(html.includes('id="activityPanel"'), 'Should have activity panel');
  assert.ok(html.includes('activity-log'), 'Should have activity log styling');

  // Verify tab switching functionality
  assert.ok(html.includes("if (tab === 'overview')"), 'Should have overview tab logic');
  assert.ok(html.includes("overviewPanel.style.display = 'block'"), 'Should show overview panel');
  assert.ok(html.includes("activityPanel.style.display = 'none'"), 'Should hide activity panel');

  // Verify authentication section exists
  assert.ok(html.includes('authenticateWithApiKey'), 'Should have API key authentication');
  assert.ok(html.includes('sessionStorage'), 'Should use sessionStorage for API key');
  assert.ok(html.includes('clearApiKey'), 'Should have clear API key function');
});
