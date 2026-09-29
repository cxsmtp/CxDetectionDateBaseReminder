/**
 * Interactive HTML report generator for vulnerability triage and remediation.
 * Generates a self-contained HTML file with real-time status updates.
 */

export function generateHtmlReport(reminderData, options = {}) {
  const {
    apiBaseUrl = '',
    sessionCookie = '',
    branding = {},
  } = options;

  const {
    projects = [],
    totalRisks = 0,
    criticalCount = 0,
    highCount = 0,
    mediumCount = 0,
    lowCount = 0,
    oldestFirstDetected = '',
    projectName = '',
    multipleProjects = false,
  } = reminderData;

  // Extract top 5 critical vulnerabilities across all projects
  const topCriticals = extractTopVulnerabilities(projects, 'CRITICAL', 5);
  const topHighs = extractTopVulnerabilities(projects, 'HIGH', 5);

  const logoHtml = branding.logoUrl
    ? `<img src="${sanitizeUrl(branding.logoUrl)}" alt="${branding.companyName || 'Company'}" height="${branding.logoHeight || 60}" style="max-width: 300px;">`
    : `<div style="font-size: 20px; font-weight: bold; color: ${branding.accentColor || '#0066cc'};">${branding.companyName || 'Company'}</div>`;

  const accentColor = branding.accentColor || '#0066cc';

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Vulnerability Report - Interactive Triage & Remediation</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: #f5f5f5;
            color: #333;
            line-height: 1.6;
        }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        .header {
            background: white;
            padding: 30px;
            border-radius: 8px;
            margin-bottom: 20px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .logo { margin-bottom: 20px; }
        .title { font-size: 28px; font-weight: bold; margin: 20px 0 10px; }
        .subtitle { color: #666; margin-bottom: 20px; }
        .summary-band {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 15px;
            margin-top: 20px;
        }
        .summary-card {
            background: white;
            border-left: 4px solid #999;
            padding: 15px;
            border-radius: 4px;
            text-align: center;
        }
        .summary-card.critical { border-left-color: #d32f2f; }
        .summary-card.high { border-left-color: #f57c00; }
        .summary-card.medium { border-left-color: #fbc02d; }
        .summary-card.low { border-left-color: #388e3c; }
        .summary-count { font-size: 32px; font-weight: bold; color: ${accentColor}; }
        .summary-label { font-size: 12px; color: #666; text-transform: uppercase; margin-top: 5px; }

        .actions-section {
            background: white;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .actions-title { font-weight: bold; margin-bottom: 15px; font-size: 16px; }
        .action-buttons {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
        }
        .action-btn {
            padding: 10px 20px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            transition: all 0.2s;
            background: ${accentColor};
            color: white;
        }
        .action-btn:hover { opacity: 0.9; transform: translateY(-2px); box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
        .action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .action-btn-secondary {
            background: #f5f5f5;
            color: #333;
            border: 1px solid #ddd;
        }
        .action-btn-secondary:hover { background: #efefef; }

        .top-findings {
            background: white;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .findings-title { font-weight: bold; margin-bottom: 15px; font-size: 16px; }
        .finding-summary {
            display: flex;
            align-items: center;
            padding: 12px;
            margin-bottom: 10px;
            background: #f9f9f9;
            border-left: 3px solid #999;
            border-radius: 4px;
        }
        .finding-summary.critical { border-left-color: #d32f2f; background: #ffebee; }
        .finding-summary.high { border-left-color: #f57c00; background: #fff3e0; }
        .finding-summary.medium { border-left-color: #fbc02d; background: #fffde7; }
        .finding-summary.low { border-left-color: #388e3c; background: #e8f5e9; }
        .finding-severity {
            font-weight: bold;
            font-size: 12px;
            padding: 4px 8px;
            border-radius: 3px;
            margin-right: 10px;
            min-width: 70px;
            text-align: center;
            text-transform: uppercase;
        }
        .finding-severity.critical { background: #d32f2f; color: white; }
        .finding-severity.high { background: #f57c00; color: white; }
        .finding-severity.medium { background: #fbc02d; color: #333; }
        .finding-severity.low { background: #388e3c; color: white; }
        .finding-title { flex: 1; margin: 0 10px; }
        .finding-title-text { font-weight: 500; }
        .finding-meta { font-size: 12px; color: #666; margin-top: 4px; }
        .finding-age { color: #d32f2f; font-weight: bold; }

        .all-findings {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .findings-grid { display: grid; gap: 15px; }
        .finding-card {
            border: 1px solid #ddd;
            border-radius: 4px;
            padding: 15px;
            background: #fafafa;
        }
        .finding-card.triaged { background: #e8f5e9; border-color: #4caf50; }
        .finding-card.remediated { background: #c8e6c9; border-color: #2e7d32; }
        .finding-header {
            display: flex;
            align-items: start;
            gap: 15px;
            margin-bottom: 12px;
        }
        .finding-card-severity {
            font-weight: bold;
            font-size: 12px;
            padding: 4px 8px;
            border-radius: 3px;
            text-transform: uppercase;
            min-width: 70px;
            text-align: center;
        }
        .finding-card-severity.critical { background: #d32f2f; color: white; }
        .finding-card-severity.high { background: #f57c00; color: white; }
        .finding-card-severity.medium { background: #fbc02d; color: #333; }
        .finding-card-severity.low { background: #388e3c; color: white; }
        .finding-details { flex: 1; }
        .finding-title-card { font-weight: 600; margin-bottom: 8px; }
        .finding-info { font-size: 13px; color: #666; margin-bottom: 8px; }
        .finding-info-item { display: inline-block; margin-right: 20px; }
        .finding-info-label { color: #999; font-size: 12px; }
        .finding-actions {
            display: flex;
            gap: 10px;
            margin-top: 12px;
            flex-wrap: wrap;
        }
        .finding-btn {
            padding: 6px 12px;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            transition: all 0.2s;
        }
        .finding-btn-triage {
            background: #2196f3;
            color: white;
        }
        .finding-btn-triage:hover { background: #1976d2; }
        .finding-btn-remediate {
            background: #4caf50;
            color: white;
        }
        .finding-btn-remediate:hover { background: #388e3c; }
        .finding-btn-disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .finding-status {
            font-size: 12px;
            padding: 4px 8px;
            border-radius: 3px;
            display: inline-block;
            margin-left: 10px;
        }
        .finding-status.triaged {
            background: #bbdefb;
            color: #0d47a1;
        }
        .finding-status.remediated {
            background: #c8e6c9;
            color: #1b5e20;
        }

        .loading {
            display: inline-block;
            width: 14px;
            height: 14px;
            border: 2px solid #f3f3f3;
            border-top: 2px solid ${accentColor};
            border-radius: 50%;
            animation: spin 0.6s linear infinite;
            vertical-align: middle;
            margin-right: 5px;
        }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

        .call-to-action {
            background: ${accentColor};
            color: white;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            text-align: center;
        }

        @media (max-width: 600px) {
            .summary-band { grid-template-columns: 1fr 1fr; }
            .action-buttons { flex-direction: column; }
            .action-btn { width: 100%; }
            .finding-header { flex-direction: column; }
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- Header -->
        <div class="header">
            <div class="logo">${logoHtml}</div>
            <div class="title">Vulnerability Report</div>
            <div class="subtitle">
                ${totalRisks} findings ${multipleProjects ? 'across projects' : 'in ' + projectName} |
                Oldest: <span class="finding-age">${oldestFirstDetected || 'Unknown'}</span>
            </div>

            <!-- Summary Band -->
            <div class="summary-band">
                <div class="summary-card critical">
                    <div class="summary-count">${criticalCount}</div>
                    <div class="summary-label">Critical</div>
                </div>
                <div class="summary-card high">
                    <div class="summary-count">${highCount}</div>
                    <div class="summary-label">High</div>
                </div>
                <div class="summary-card medium">
                    <div class="summary-count">${mediumCount}</div>
                    <div class="summary-label">Medium</div>
                </div>
                <div class="summary-card low">
                    <div class="summary-count">${lowCount}</div>
                    <div class="summary-label">Low</div>
                </div>
            </div>
        </div>

        <!-- Call to Action -->
        ${branding.callToAction ? `<div class="call-to-action">${escapeHtml(branding.callToAction)}</div>` : ''}

        <!-- Bulk Actions -->
        <div class="actions-section">
            <div class="actions-title">Quick Actions</div>
            <div class="action-buttons">
                <button class="action-btn" onclick="triageAll('CRITICAL')">Triage All Critical (${criticalCount})</button>
                <button class="action-btn" onclick="triageAll('HIGH')">Triage All High (${highCount})</button>
                <button class="action-btn action-btn-secondary" onclick="toggleAllFinding('remediate')">Mark All as Remediated</button>
                <button class="action-btn action-btn-secondary" onclick="location.reload()">Refresh Status</button>
            </div>
        </div>

        <!-- Top Findings Summary -->
        ${topCriticals.length > 0 ? `
            <div class="top-findings">
                <div class="findings-title">Top Critical Findings</div>
                ${topCriticals.map(f => `
                    <div class="finding-summary critical">
                        <span class="finding-severity critical">${f.severity}</span>
                        <div class="finding-title">
                            <div class="finding-title-text">${escapeHtml(f.title)}</div>
                            <div class="finding-meta">
                                <span class="finding-age">${ageLabel(f.ageDays)} old</span> ·
                                Project: ${escapeHtml(f.projectName)} ·
                                Engine: ${escapeHtml(f.scanner || f.engine)}
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
        ` : ''}

        ${topHighs.length > 0 ? `
            <div class="top-findings">
                <div class="findings-title">Top High-Severity Findings</div>
                ${topHighs.map(f => `
                    <div class="finding-summary high">
                        <span class="finding-severity high">${f.severity}</span>
                        <div class="finding-title">
                            <div class="finding-title-text">${escapeHtml(f.title)}</div>
                            <div class="finding-meta">
                                <span>${ageLabel(f.ageDays)} old</span> ·
                                Project: ${escapeHtml(f.projectName)} ·
                                Engine: ${escapeHtml(f.scanner || f.engine)}
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
        ` : ''}

        <!-- All Findings -->
        <div class="all-findings">
            <div class="findings-title">All Vulnerabilities (${totalRisks})</div>
            <div class="findings-grid" id="findings-grid">
                ${generateFindingCards(projects)}
            </div>
        </div>
    </div>

    <script>
        // Configuration from server
        const apiBaseUrl = '${sanitizeJsString(apiBaseUrl)}';
        const sessionCookie = '${sanitizeJsString(sessionCookie)}';

        // Track finding states locally
        const findingStates = {};

        async function triageAll(severity) {
            if (!confirm(\`Triage all \${severity} vulnerabilities?\`)) return;

            const findings = document.querySelectorAll(\`[data-severity="\${severity}"]\`);
            if (findings.length === 0) return;

            const buttons = Array.from(document.querySelectorAll('button')).filter(b =>
                b.textContent.includes('Triage') || b.textContent.includes('Remediated')
            );
            buttons.forEach(b => b.disabled = true);

            for (const finding of findings) {
                const riskId = finding.getAttribute('data-risk-id');
                const projectId = finding.getAttribute('data-project-id');
                const scanId = finding.getAttribute('data-scan-id');

                if (!findingStates[riskId] || !findingStates[riskId].triaged) {
                    await triageFinding(riskId, projectId, scanId, finding);
                }
            }

            buttons.forEach(b => b.disabled = false);
        }

        async function toggleAllFinding(action) {
            if (!confirm(\`Mark all findings as \${action}?\`)) return;

            const findings = document.querySelectorAll('[data-risk-id]');
            if (findings.length === 0) return;

            const buttons = Array.from(document.querySelectorAll('button'));
            buttons.forEach(b => b.disabled = true);

            for (const finding of findings) {
                const riskId = finding.getAttribute('data-risk-id');
                const projectId = finding.getAttribute('data-project-id');
                const scanId = finding.getAttribute('data-scan-id');

                if (action === 'remediate') {
                    await remediateFinding(riskId, projectId, scanId, finding);
                }
            }

            buttons.forEach(b => b.disabled = false);
        }

        async function triageFinding(riskId, projectId, scanId, cardElement) {
            const btn = cardElement.querySelector('[data-action="triage"]');
            if (!btn) return;

            btn.disabled = true;
            btn.innerHTML = '<span class="loading"></span>Triaging...';

            try {
                const response = await fetch(apiBaseUrl + '/api/risks/triage', {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ riskId, projectId, scanId, action: 'triage' })
                });

                if (response.ok) {
                    findingStates[riskId] = { ...findingStates[riskId], triaged: true };
                    updateFindingCard(cardElement, 'triaged');
                    btn.innerHTML = '✓ Triaged';
                    btn.classList.add('finding-btn-disabled');
                } else {
                    btn.innerHTML = '⚠ Triage';
                    alert('Failed to triage. Try again or refresh.');
                }
            } catch (error) {
                btn.innerHTML = '✕ Error';
                console.error('Triage error:', error);
            }
        }

        async function remediateFinding(riskId, projectId, scanId, cardElement) {
            const btn = cardElement.querySelector('[data-action="remediate"]');
            if (!btn) return;

            btn.disabled = true;
            btn.innerHTML = '<span class="loading"></span>Remediating...';

            try {
                const response = await fetch(apiBaseUrl + '/api/risks/remediate', {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ riskId, projectId, scanId, action: 'remediate' })
                });

                if (response.ok) {
                    findingStates[riskId] = { ...findingStates[riskId], remediated: true };
                    updateFindingCard(cardElement, 'remediated');
                    btn.innerHTML = '✓ Remediated';
                    btn.classList.add('finding-btn-disabled');
                } else {
                    btn.innerHTML = '⚠ Remediate';
                    alert('Failed to remediate. Try again or refresh.');
                }
            } catch (error) {
                btn.innerHTML = '✕ Error';
                console.error('Remediate error:', error);
            }
        }

        function updateFindingCard(cardElement, status) {
            if (status === 'triaged') {
                cardElement.classList.add('triaged');
            } else if (status === 'remediated') {
                cardElement.classList.add('remediated', 'triaged');
            }
        }

        // Initialize
        document.addEventListener('DOMContentLoaded', () => {
            console.log('Report loaded. API base:', apiBaseUrl);
        });
    </script>
</body>
</html>`;
}

function extractTopVulnerabilities(projects, severity, limit) {
  const findings = [];
  for (const project of projects) {
    for (const risk of project.risks || []) {
      if (risk.severity === severity) {
        findings.push({
          ...risk,
          projectName: project.projectName,
        });
      }
    }
  }
  return findings.sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1)).slice(0, limit);
}

const SEVERITY_RANK = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO', 'UNKNOWN'];

function ageLabel(days) {
  return days === null || days === undefined ? 'age unknown' : `${days}d`;
}

function generateFindingCards(projects) {
  const all = [];
  for (const project of projects) {
    for (const risk of project.risks || []) all.push({ project, risk });
  }

  // Worst first, then oldest, so the top of the list is what to fix next.
  all.sort((a, b) => {
    const bySeverity = SEVERITY_RANK.indexOf(a.risk.severity) - SEVERITY_RANK.indexOf(b.risk.severity);
    if (bySeverity !== 0) return bySeverity;
    return (b.risk.ageDays ?? -1) - (a.risk.ageDays ?? -1);
  });

  return all
    .map(({ project, risk }) => {
      const severity = String(risk.severity || 'UNKNOWN');
      const detected = risk.firstDetectedAt ? String(risk.firstDetectedAt).slice(0, 10) : 'unknown';
      const title = risk.url
        ? `<a href="${escapeHtml(risk.url)}" target="_blank" rel="noopener">${escapeHtml(risk.title)}</a>`
        : escapeHtml(risk.title);
      const item = (label, value) =>
        value
          ? `<span class="finding-info-item"><span class="finding-info-label">${label}:</span> ${escapeHtml(value)}</span>`
          : '';
      const args = `'${escapeHtml(risk.riskId)}', '${escapeHtml(project.projectId)}', '${escapeHtml(risk.scanId)}', this.closest('.finding-card')`;

      return `
        <div class="finding-card" data-risk-id="${escapeHtml(risk.riskId)}" data-project-id="${escapeHtml(project.projectId)}" data-scan-id="${escapeHtml(risk.scanId)}" data-severity="${escapeHtml(severity)}">
          <div class="finding-header">
            <span class="finding-card-severity ${severity.toLowerCase()}">${escapeHtml(severity)}</span>
            <div class="finding-details">
              <div class="finding-title-card">${title}</div>
              <div class="finding-info">
                ${item('Project', project.projectName)}
                <span class="finding-info-item"><span class="finding-info-label">Age:</span> <strong>${ageLabel(risk.ageDays)}</strong></span>
                ${item('Engine', risk.scanner || risk.engine)}
                ${item('Detected', detected)}
                ${item('Location', risk.location)}
                ${item('State', risk.state)}
                ${item('Status', risk.status)}
                ${item('AI triage', risk.aiTriageStatus)}
                ${item('Exploitability', risk.aiExploitability)}
                ${item('Reachability', risk.aiReachability)}
              </div>
            </div>
          </div>
          <div class="finding-actions">
            <button class="finding-btn finding-btn-triage" data-action="triage" onclick="triageFinding(${args})">Triage</button>
            <button class="finding-btn finding-btn-remediate" data-action="remediate" onclick="remediateFinding(${args})">Remediate</button>
          </div>
        </div>
      `;
    })
    .join('');
}

function escapeHtml(text) {
  if (!text) return '';
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return String(text).replace(/[&<>"']/g, (m) => map[m]);
}

function sanitizeUrl(url) {
  if (!url) return '';
  if (url.startsWith('data:')) return url;
  if (url.startsWith('https://')) return escapeHtml(url);
  return '';
}

function sanitizeJsString(str) {
  if (!str) return '';
  return escapeHtml(str).replace(/'/g, "\\'");
}
