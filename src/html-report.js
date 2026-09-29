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

  // Filter for critical and high findings only
  const filterByPriority = (proj) => ({
    ...proj,
    risks: (proj.risks || []).filter(r => ['CRITICAL', 'HIGH'].includes(r.severity))
  });
  const priorityProjects = projects.map(filterByPriority).filter(p => p.risks.length > 0);
  const priorityFindingsCount = criticalCount + highCount;

  // Extract top 5 critical vulnerabilities across all projects
  const topCriticals = extractTopVulnerabilities(projects, 'CRITICAL', 5);
  const topHighs = extractTopVulnerabilities(projects, 'HIGH', 5);

  const logoHtml = branding.logoUrl
    ? `<img src="${sanitizeUrl(branding.logoUrl)}" alt="${branding.companyName || 'Company'}" height="${branding.logoHeight || 60}" style="max-width: 300px;">`
    : `<div style="font-size: 20px; font-weight: bold; color: ${branding.accentColor || '#0066cc'};">${branding.companyName || 'Company'}</div>`;

  const accentColor = branding.accentColor || '#0066cc';

  // Every finding, oldest first within a severity, so the sliders triage the most overdue ones.
  const allFindings = projects
    .flatMap((project) => (project.risks || []).map((risk) => ({
      riskId: risk.riskId,
      projectId: project.projectId,
      scanId: risk.scanId,
      severity: String(risk.severity || 'UNKNOWN').toUpperCase(),
      title: risk.title || risk.riskId,
      ageDays: risk.ageDays ?? -1,
    })))
    .filter((f) => f.riskId)
    .sort((a, b) => b.ageDays - a.ageDays);
  const countBySeverity = {};
  for (const f of allFindings) countBySeverity[f.severity] = (countBySeverity[f.severity] || 0) + 1;

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
            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
            min-height: 100vh;
            color: #1f2937;
            line-height: 1.6;
        }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            border-radius: 12px;
            margin-bottom: 30px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.15);
            position: relative;
        }
        .header-auth-button {
            position: absolute;
            top: 20px;
            right: 20px;
            z-index: 2;
        }
        .logo { margin-bottom: 8px; font-size: 14px; opacity: 0.95; font-weight: 500; }
        .title { font-size: 28px; font-weight: 700; margin: 8px 0 5px; letter-spacing: -0.5px; }
        .subtitle { opacity: 0.9; margin-bottom: 12px; font-size: 14px; }
        .summary-band {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
            gap: 15px;
            margin-top: 20px;
        }
        .summary-card {
            background: rgba(255,255,255,0.15);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255,255,255,0.2);
            padding: 16px;
            border-radius: 8px;
            text-align: center;
            color: white;
            transition: transform 0.2s, box-shadow 0.2s;
        }
        .summary-card:hover { transform: translateY(-2px); box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
        .summary-card.critical { background: rgba(211, 47, 47, 0.9); }
        .summary-card.high { background: rgba(245, 124, 0, 0.9); }
        .summary-card.medium { background: rgba(251, 192, 45, 0.9); color: #1f2937; }
        .summary-card.low { background: rgba(56, 142, 60, 0.9); }
        .summary-count { font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
        .summary-label { font-size: 11px; opacity: 0.85; text-transform: uppercase; margin-top: 6px; font-weight: 600; letter-spacing: 0.5px; }

        .actions-section {
            background: white;
            padding: 25px;
            border-radius: 12px;
            margin-bottom: 25px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.08);
        }
        .actions-title { font-weight: 700; margin-bottom: 18px; font-size: 18px; color: #1f2937; }
        .action-buttons {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
        }
        .action-btn {
            padding: 12px 24px;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 600;
            transition: all 0.3s;
            background: ${accentColor};
            color: white;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }
        .action-btn:hover {
            opacity: 0.95;
            transform: translateY(-2px);
            box-shadow: 0 6px 16px rgba(0,0,0,0.15);
        }
        .action-btn:active { transform: translateY(0); }
        .action-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
        .action-btn-secondary {
            background: #f3f4f6;
            color: #374151;
            border: 1px solid #d1d5db;
        }
        .action-btn-secondary:hover { background: #e5e7eb; border-color: #9ca3af; }

        .top-findings {
            background: white;
            padding: 25px;
            border-radius: 12px;
            margin-bottom: 25px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.08);
        }
        .findings-title { font-weight: 700; margin-bottom: 18px; font-size: 18px; color: #1f2937; }
        .finding-summary {
            display: flex;
            align-items: center;
            padding: 14px;
            margin-bottom: 12px;
            background: #f9fafb;
            border-left: 4px solid #999;
            border-radius: 6px;
            transition: all 0.2s;
        }
        .finding-summary:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.05); }
        .finding-summary.critical { border-left-color: #dc2626; background: #fef2f2; }
        .finding-summary.high { border-left-color: #ea580c; background: #fef3c7; }
        .finding-summary.medium { border-left-color: #d97706; background: #fefce8; }
        .finding-summary.low { border-left-color: #16a34a; background: #f0fdf4; }
        .finding-severity {
            font-weight: 700;
            font-size: 11px;
            padding: 6px 10px;
            border-radius: 4px;
            margin-right: 12px;
            min-width: 75px;
            text-align: center;
            text-transform: uppercase;
            letter-spacing: 0.3px;
        }
        .finding-severity.critical { background: #dc2626; color: white; }
        .finding-severity.high { background: #ea580c; color: white; }
        .finding-severity.medium { background: #d97706; color: white; }
        .finding-severity.low { background: #16a34a; color: white; }
        .finding-title { flex: 1; margin: 0 12px; }
        .finding-title-text { font-weight: 600; color: #1f2937; }
        .finding-meta { font-size: 13px; color: #6b7280; margin-top: 4px; }
        .finding-age { color: #dc2626; font-weight: 700; }

        .all-findings {
            background: white;
            padding: 20px;
            border-radius: 12px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.08);
        }
        .findings-grid {
            display: flex;
            flex-direction: column;
            gap: 0;
        }
        .finding-card {
            border-bottom: 1px solid #e5e7eb;
            padding: 12px;
            background: #ffffff;
            display: grid;
            grid-template-columns: 75px 1fr 90px 90px 80px 140px;
            gap: 12px;
            align-items: center;
            font-size: 13px;
            transition: background 0.2s;
        }
        .finding-card:hover { background: #f9fafb; }
        .finding-card.triaged { background: #f0fdf4; }
        .finding-card.remediated { background: #dcfce7; }
        .finding-card-header-row {
            display: grid;
            grid-template-columns: 75px 1fr 90px 90px 80px 140px;
            gap: 12px;
            padding: 12px;
            background: #f3f4f6;
            font-weight: 700;
            font-size: 12px;
            color: #374151;
            letter-spacing: 0.3px;
            border-bottom: 2px solid #ddd;
            position: sticky;
            top: 0;
            z-index: 10;
            text-transform: uppercase;
            color: #666;
        }

        .finding-header {
            display: contents;
        }
        .finding-card-severity {
            font-weight: bold;
            font-size: 11px;
            padding: 3px 6px;
            border-radius: 3px;
            text-transform: uppercase;
            text-align: center;
            min-width: 60px;
        }
        .finding-card-severity.critical { background: #d32f2f; color: white; }
        .finding-card-severity.high { background: #f57c00; color: white; }
        .finding-card-severity.medium { background: #fbc02d; color: #333; }
        .finding-card-severity.low { background: #388e3c; color: white; }

        .finding-details {
            display: contents;
        }
        .finding-title-card {
            font-weight: 600;
            color: #000;
            text-decoration: none;
        }
        .finding-title-card a {
            color: #1d4ed8;
            text-decoration: none;
        }
        .finding-title-card a:hover {
            text-decoration: underline;
        }
        .finding-info { display: none; }
        .finding-info-item { display: none; }
        .finding-info-label { display: none; }

        .finding-age-cell {
            font-weight: 600;
            color: #d32f2f;
        }
        .finding-ai-cell {
            font-size: 11px;
            font-weight: 500;
        }
        .finding-ai-high { color: #d32f2f; }
        .finding-ai-medium { color: #f57c00; }
        .finding-actions {
            display: flex;
            gap: 4px;
            flex-wrap: wrap;
            justify-content: flex-end;
        }
        .finding-btn {
            padding: 3px 8px;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 10px;
            font-weight: 500;
            transition: all 0.2s;
            white-space: nowrap;
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

        .header-top {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }
        .header-left { flex: 1; }
        .auth-button {
            padding: 10px 18px;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 600;
            background: #f3f4f6;
            color: #374151;
            border: 1px solid #d1d5db;
            transition: all 0.3s;
            white-space: nowrap;
            box-shadow: 0 2px 6px rgba(0,0,0,0.08);
        }
        .auth-button.connected {
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            color: white;
            border: none;
        }
        .auth-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0,0,0,0.12);
        }
        .auth-button:active { transform: translateY(0); }

        .status-bar {
            background: linear-gradient(135deg, #1f2937 0%, #111827 100%);
            padding: 24px;
            border-radius: 12px;
            margin-bottom: 25px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.15);
            display: flex;
            flex-direction: column;
        }
        .severity-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 14px;
            margin-bottom: 16px;
        }
        .severity-card {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            padding: 14px;
            border-radius: 6px;
            color: white;
        }
        .severity-card.critical { border-left: 4px solid #d32f2f; }
        .severity-card.high { border-left: 4px solid #f57c00; }
        .severity-card.medium { border-left: 4px solid #fbc02d; }
        .severity-card.low { border-left: 4px solid #388e3c; }
        .severity-header {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 10px;
        }
        .severity-badge {
            width: 10px;
            height: 10px;
            border-radius: 2px;
            flex-shrink: 0;
        }
        .severity-badge.critical { background: #d32f2f; }
        .severity-badge.high { background: #f57c00; }
        .severity-badge.medium { background: #fbc02d; }
        .severity-badge.low { background: #388e3c; }
        .severity-title {
            font-size: 13px;
            font-weight: 600;
            flex: 1;
        }
        .severity-count {
            font-size: 16px;
            font-weight: bold;
            color: #fff;
        }
        .severity-triage-label {
            font-size: 11px;
            color: rgba(255, 255, 255, 0.7);
            margin-bottom: 6px;
        }
        .severity-triage-count {
            font-size: 14px;
            font-weight: bold;
            color: #fff;
            margin-bottom: 8px;
        }
        .severity-slider {
            width: 100%;
            height: 6px;
            border-radius: 3px;
            background: rgba(255, 255, 255, 0.2);
            outline: none;
            -webkit-appearance: none;
            appearance: none;
        }
        .severity-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 16px;
            height: 16px;
            border-radius: 50%;
            background: #a78bfa;
            cursor: pointer;
            box-shadow: 0 0 5px rgba(167, 139, 250, 0.5);
        }
        .severity-slider::-moz-range-thumb {
            width: 16px;
            height: 16px;
            border-radius: 50%;
            background: #a78bfa;
            cursor: pointer;
            border: none;
            box-shadow: 0 0 5px rgba(167, 139, 250, 0.5);
        }

        .triage-button-bar {
            display: flex;
            gap: 12px;
            justify-content: flex-end;
            align-items: center;
            margin-top: 10px;
        }
        .fix-all-hint { color: #9ca3af; font-size: 12px; }
        .fix-all-btn {
            padding: 6px 14px;
            background: #a78bfa;
            color: white;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-weight: 600;
            font-size: 11px;
            transition: all 0.2s;
            height: fit-content;
        }
        .fix-all-btn:hover { background: #9370db; }
        .fix-all-btn:disabled { opacity: 0.5; cursor: not-allowed; }

        .remediation-modal {
            display: none;
            position: fixed;
            z-index: 1000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.5);
            animation: fadeIn 0.2s;
        }
        .remediation-modal.show { display: flex; }
        .remediation-content {
            background-color: white;
            margin: auto;
            padding: 30px;
            border-radius: 8px;
            max-width: 800px;
            max-height: 85vh;
            overflow-y: auto;
            box-shadow: 0 5px 20px rgba(0, 0, 0, 0.3);
        }
        .remediation-header { display: flex; justify-content: space-between; align-items: start; margin-bottom: 20px; }
        .remediation-title { font-size: 20px; font-weight: bold; }
        .remediation-close {
            background: none;
            border: none;
            font-size: 24px;
            cursor: pointer;
            color: #666;
        }
        .remediation-section { margin-bottom: 20px; }
        .remediation-section-title { font-weight: bold; font-size: 14px; color: #d32f2f; text-transform: uppercase; margin-bottom: 10px; }
        .remediation-section-content { font-size: 14px; line-height: 1.6; color: #333; }
        .code-block {
            background: #f5f5f5;
            border-left: 3px solid #d32f2f;
            padding: 12px;
            margin: 10px 0;
            border-radius: 4px;
            font-family: 'Courier New', monospace;
            font-size: 12px;
            overflow-x: auto;
        }
        .remediation-actions { margin-top: 20px; display: flex; gap: 10px; }
        .btn-close-modal { background: #f5f5f5; border: 1px solid #ddd; padding: 10px 20px; border-radius: 4px; cursor: pointer; }
        .btn-close-modal:hover { background: #efefef; }

        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

        .activity-section {
            background: white;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .activity-tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 15px;
            border-bottom: 2px solid #f0f0f0;
        }
        .activity-tab {
            padding: 10px 15px;
            border: none;
            background: none;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            color: #999;
            border-bottom: 3px solid transparent;
            transition: all 0.2s;
        }
        .activity-tab.active {
            color: ${accentColor};
            border-bottom-color: ${accentColor};
        }
        .activity-tab:hover { color: #333; }

        .activity-log {
            max-height: 300px;
            overflow-y: auto;
            font-size: 13px;
            font-family: 'Courier New', monospace;
        }
        .activity-item {
            padding: 8px;
            margin-bottom: 5px;
            border-radius: 3px;
            display: flex;
            gap: 10px;
            align-items: flex-start;
        }
        .activity-item.pending {
            background: #e3f2fd;
            color: #1976d2;
        }
        .activity-item.success {
            background: #e8f5e9;
            color: #2e7d32;
        }
        .activity-item.error {
            background: #ffebee;
            color: #c62828;
        }
        .activity-icon {
            min-width: 20px;
            font-weight: bold;
        }
        .activity-text {
            flex: 1;
            word-break: break-word;
        }
        .activity-time {
            font-size: 11px;
            opacity: 0.7;
            min-width: 60px;
        }
        .status-badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: bold;
            margin-left: 10px;
        }
        .status-badge.pending { background: #bbdefb; color: #0d47a1; }
        .status-badge.success { background: #c8e6c9; color: #1b5e20; }
        .status-badge.error { background: #ffcdd2; color: #b71c1c; }

        @media (max-width: 1024px) {
            .triage-controls { flex-wrap: wrap; }
            .triage-slider-container { width: 100%; margin: 10px 0; }
            .status-counts { grid-template-columns: repeat(2, 1fr); }
        }

        @media (max-width: 768px) {
            .header-auth-button { position: static; margin-bottom: 10px; }
            .finding-card { grid-template-columns: 60px 1fr 70px 70px 60px; font-size: 11px; gap: 5px; }
            .finding-card-header-row { grid-template-columns: 60px 1fr 70px 70px 60px; font-size: 10px; gap: 5px; }
            .triage-controls { gap: 10px; padding-top: 10px; }
            .triage-btn { padding: 6px 12px; font-size: 12px; }
        }

        @media (max-width: 600px) {
            .summary-band { grid-template-columns: 1fr 1fr; }
            .action-buttons { flex-direction: column; }
            .action-btn { width: 100%; }
            .finding-card { grid-template-columns: 50px 1fr 50px; }
            .finding-card-header-row { grid-template-columns: 50px 1fr 50px; }
            .finding-ai-cell { display: none; }
            .finding-age-cell { font-size: 10px; }
            .status-counts { grid-template-columns: repeat(2, 1fr); gap: 10px; }
            .triage-controls { flex-direction: column; align-items: flex-start; }
            .triage-slider-container { width: 100%; }
            .remediation-content { padding: 20px; max-width: 95vw; }
            .activity-tabs { flex-wrap: wrap; }
            .auth-button { padding: 8px 12px; font-size: 12px; }
            .header-auth-button { position: static; }
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- Header -->
        <div class="header">
            <div class="header-auth-button">
                <button class="auth-button" id="authBtn" onclick="toggleAuthPanel()" title="Connect with Checkmarx One API for interactive triage and remediation">Connect with CxONE</button>
            </div>
            <div class="logo">${logoHtml}</div>
            <div class="title">Vulnerability Report</div>
            <div class="subtitle">
                ${totalRisks} findings ${multipleProjects ? 'across projects' : 'in ' + projectName} |
                Oldest: <span class="finding-age">${oldestFirstDetected || 'Unknown'}</span>
            </div>
        </div>

        <!-- Status Bar with Severity Counts & Triage Controls -->
        <div class="status-bar">
            <div class="severity-grid">
                <!-- Critical Severity Card -->
                <div class="severity-card critical">
                    <div class="severity-header">
                        <span class="severity-badge critical">●</span>
                        <span class="severity-title">Critical</span>
                    </div>
                    <div class="severity-count">${criticalCount}</div>
                    <div class="severity-triage-label">To triage</div>
                    <div class="severity-triage-count" id="criticalTriageCount">0</div>
                    <input type="range" class="severity-slider" id="criticalSlider" min="0" max="${countBySeverity.CRITICAL || 0}" value="0"
                           oninput="updateTriageSlider('critical')">
                </div>

                <!-- High Severity Card -->
                <div class="severity-card high">
                    <div class="severity-header">
                        <span class="severity-badge high">●</span>
                        <span class="severity-title">High</span>
                    </div>
                    <div class="severity-count">${highCount}</div>
                    <div class="severity-triage-label">To triage</div>
                    <div class="severity-triage-count" id="highTriageCount">0</div>
                    <input type="range" class="severity-slider" id="highSlider" min="0" max="${countBySeverity.HIGH || 0}" value="0"
                           oninput="updateTriageSlider('high')">
                </div>

                <!-- Medium Severity Card -->
                <div class="severity-card medium">
                    <div class="severity-header">
                        <span class="severity-badge medium">●</span>
                        <span class="severity-title">Medium</span>
                    </div>
                    <div class="severity-count">${mediumCount}</div>
                    <div class="severity-triage-label">To triage</div>
                    <div class="severity-triage-count" id="mediumTriageCount">0</div>
                    <input type="range" class="severity-slider" id="mediumSlider" min="0" max="${countBySeverity.MEDIUM || 0}" value="0"
                           oninput="updateTriageSlider('medium')">
                </div>

                <!-- Low Severity Card -->
                <div class="severity-card low">
                    <div class="severity-header">
                        <span class="severity-badge low">●</span>
                        <span class="severity-title">Low</span>
                    </div>
                    <div class="severity-count">${lowCount}</div>
                    <div class="severity-triage-label">To triage</div>
                    <div class="severity-triage-count" id="lowTriageCount">0</div>
                    <input type="range" class="severity-slider" id="lowSlider" min="0" max="${countBySeverity.LOW || 0}" value="0"
                           oninput="updateTriageSlider('low')">
                </div>
            </div>

            <!-- Triage Button Bar -->
            <div class="triage-button-bar">
                <span class="fix-all-hint" id="fixAllHint"></span>
                <button class="fix-all-btn" id="fixAllBtn" onclick="bulkTriageSelected()" disabled>Fix All</button>
            </div>
        </div>

        <!-- Authentication Modal (Popup) -->
        <div id="authModal" style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 9999; justify-content: center; align-items: center; visibility: hidden; opacity: 0; transition: opacity 0.3s ease;">
            <div style="background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.3); max-width: 500px; width: 90%; animation: slideIn 0.3s ease; max-height: 85vh; overflow-y: auto;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                    <div style="font-weight: bold; font-size: 16px;">Connect to Checkmarx One</div>
                    <button onclick="closeAuthModal()" style="background: none; border: none; font-size: 24px; cursor: pointer; color: #999;">✕</button>
                </div>

                <div style="margin-bottom: 20px;">
                    <p style="font-size: 13px; color: #666; margin-bottom: 15px;">
                        Paste an API key from <strong>Checkmarx One → Settings → Identity &amp; Access Management → API Keys</strong>
                    </p>

                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 8px; font-weight: 500; color: #333; font-size: 13px;">API Key</label>
                        <textarea id="apiKeyInput" placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…"
                                  rows="3" spellcheck="false"
                                  style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; font-family: monospace; resize: vertical;"></textarea>
                    </div>
                </div>

                <div id="detectedInfo" style="display: none; padding: 12px; background: #f5f5f5; border-radius: 4px; margin-bottom: 15px; font-size: 12px;">
                    <div style="margin-bottom: 8px;"><strong>Detected from key:</strong></div>
                    <div><span style="color: #666;">Tenant:</span> <span id="detectedTenant"></span></div>
                    <div><span style="color: #666;">Region:</span> <span id="detectedRegion"></span></div>
                </div>

                <div style="display: flex; gap: 10px; margin-top: 20px;">
                    <button id="authenticateApiKeyBtn" onclick="authenticateWithApiKey()" style="flex: 1; padding: 10px 16px; background: #1976d2; color: white; border: none; border-radius: 4px; font-weight: 500; cursor: pointer; font-size: 14px;">Connect</button>
                    <button onclick="closeAuthModal()" style="flex: 1; padding: 10px 16px; background: #f5f5f5; color: #333; border: 1px solid #ddd; border-radius: 4px; font-weight: 500; cursor: pointer; font-size: 14px;">Cancel</button>
                </div>

                <span id="authStatus" style="font-size: 12px; color: #d32f2f; margin-top: 15px; display: block; text-align: center;"></span>
            </div>
        </div>
        <style>
            @keyframes slideIn {
                from { transform: translateY(-50px); opacity: 0; }
                to { transform: translateY(0); opacity: 1; }
            }
        </style>

        <!-- Priority Findings (Critical + High Only) - Compact Table View -->
        <div class="all-findings">
            <div class="findings-title">Priority Vulnerabilities to Address (${priorityFindingsCount})</div>
            <div style="overflow-x: auto;">
                <div class="finding-card-header-row">
                    <div>Severity</div>
                    <div>Finding / Location</div>
                    <div>Age (days)</div>
                    <div>AI Analysis</div>
                    <div>Engine</div>
                    <div>Actions</div>
                </div>
                <div class="findings-grid" id="findings-grid">
                    ${generateFindingCards(priorityProjects)}
                </div>
            </div>
        </div>

        <!-- Activity & Status Tab -->
        <div class="activity-section" id="activitySection">
            <div class="activity-tabs">
                <button class="activity-tab active" onclick="switchActivityTab('overview')">📊 Overview</button>
                <button class="activity-tab" onclick="switchActivityTab('activity')">📝 Activity Log</button>
            </div>
            <div id="overviewPanel" class="activity-tab-content">
                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px;">
                    <div style="padding: 15px; background: #f5f5f5; border-radius: 4px;">
                        <div style="font-size: 24px; font-weight: bold; color: #d32f2f;" id="triageCount">0</div>
                        <div style="font-size: 12px; color: #666; margin-top: 5px;">Triaged Today</div>
                    </div>
                    <div style="padding: 15px; background: #f5f5f5; border-radius: 4px;">
                        <div style="font-size: 24px; font-weight: bold; color: #4caf50;" id="remediateCount">0</div>
                        <div style="font-size: 12px; color: #666; margin-top: 5px;">Remediated</div>
                    </div>
                    <div style="padding: 15px; background: #f5f5f5; border-radius: 4px;">
                        <div style="font-size: 24px; font-weight: bold; color: #f57c00;" id="pendingCount">0</div>
                        <div style="font-size: 12px; color: #666; margin-top: 5px;">Pending Action</div>
                    </div>
                </div>
            </div>
            <div id="activityPanel" class="activity-log" style="display: none;">
                <div id="activityLog"></div>
            </div>
        </div>

        <!-- Remediation Modal -->
        <div id="remediationModal" class="remediation-modal">
            <div class="remediation-content">
                <div class="remediation-header">
                    <div class="remediation-title" id="modalTitle">Remediation Guidance</div>
                    <button class="remediation-close" onclick="closeRemediationModal()">&times;</button>
                </div>
                <div id="remediationBody"></div>
                <div class="remediation-actions">
                    <button class="btn-close-modal" onclick="closeRemediationModal()">Close</button>
                </div>
            </div>
        </div>
    </div>

    <script type="application/json" id="reportFindings">${jsonForScript(allFindings)}</script>
    <script>
        // Configuration from server
        const apiBaseUrl = '${sanitizeJsString(apiBaseUrl)}';
        const sessionCookie = '${sanitizeJsString(sessionCookie)}';
        let userApiKey = null;

        // Track finding states locally
        const findingStates = {};

        // Activity logging system
        const activityLog = [];

        const SEVERITIES = ['critical', 'high', 'medium', 'low'];
        const ALL_FINDINGS = JSON.parse(document.getElementById('reportFindings').textContent);
        let bulkRunning = false;

        function setAuthStatus(text, color) {
          const status = document.getElementById('authStatus');
          status.textContent = text;
          status.style.color = color || '#d32f2f';
        }

        function toggleAuthPanel() {
          if (userApiKey) {
            if (confirm('Disconnect from Checkmarx One?')) clearApiKey();
            return;
          }
          const modal = document.getElementById('authModal');
          modal.style.display = 'flex';
          modal.style.visibility = 'visible';
          modal.style.opacity = '1';
          document.getElementById('apiKeyInput').value = '';
          document.getElementById('detectedInfo').style.display = 'none';
          setAuthStatus('');
          setTimeout(() => document.getElementById('apiKeyInput').focus(), 50);
        }

        function closeAuthModal() {
          const modal = document.getElementById('authModal');
          modal.style.display = 'none';
          modal.style.visibility = 'hidden';
          modal.style.opacity = '0';
        }

        function sliderValue(sev) {
          return parseInt(document.getElementById(sev + 'Slider').value, 10) || 0;
        }

        function updateTriageSlider(sev) {
          document.getElementById(sev + 'TriageCount').textContent = sliderValue(sev);
          enableFixAllButton();
        }

        function enableFixAllButton() {
          const total = SEVERITIES.reduce((n, sev) => n + sliderValue(sev), 0);
          const btn = document.getElementById('fixAllBtn');
          const hint = document.getElementById('fixAllHint');
          if (bulkRunning) return;
          btn.disabled = total === 0 || !userApiKey;
          btn.textContent = total > 0 ? \`Triage \${total} finding\${total === 1 ? '' : 's'}\` : 'Fix All';
          if (!userApiKey) hint.textContent = 'Connect with CxONE to triage findings.';
          else if (total === 0) hint.textContent = 'Move a slider to choose how many findings to triage (oldest first).';
          else hint.textContent = '';
        }

        async function postRiskAction(action, finding) {
          let response;
          try {
            response = await fetch(apiBaseUrl + '/api/risks/' + action, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-API-Key': userApiKey },
              body: JSON.stringify({ riskId: finding.riskId, projectId: finding.projectId, scanId: finding.scanId }),
            });
          } catch (error) {
            return { ok: false, status: 0, error: \`Cannot reach the reminder server at \${apiBaseUrl} — it must be running and reachable from this computer.\` };
          }
          if (response.ok) return { ok: true, status: response.status };
          let message = response.statusText;
          try { message = (await response.json()).error || message; } catch {}
          return { ok: false, status: response.status, error: message };
        }

        async function bulkTriageSelected() {
          if (!userApiKey) { toggleAuthPanel(); return; }
          const queue = [];
          for (const sev of SEVERITIES) {
            const pending = ALL_FINDINGS.filter(f => f.severity === sev.toUpperCase() && !findingStates[f.riskId]?.triaged);
            queue.push(...pending.slice(0, sliderValue(sev)));
          }
          if (queue.length === 0) {
            logActivity('Nothing left to triage for the selected counts.', 'info');
            return;
          }
          if (!confirm(\`Triage \${queue.length} finding\${queue.length === 1 ? '' : 's'} in Checkmarx One?\`)) return;

          const btn = document.getElementById('fixAllBtn');
          bulkRunning = true;
          btn.disabled = true;
          logActivity(\`Bulk triage started for \${queue.length} findings\`, 'pending');
          let ok = 0, failed = 0;
          for (const finding of queue) {
            btn.textContent = \`Triaging \${ok + failed + 1}/\${queue.length}…\`;
            const result = await postRiskAction('triage', finding);
            const card = document.querySelector(\`.finding-card[data-risk-id="\${CSS.escape(finding.riskId)}"]\`);
            if (result.ok) {
              ok++;
              findingStates[finding.riskId] = { ...findingStates[finding.riskId], triaged: true };
              if (card) markCardTriaged(card);
              logActivity(\`Triaged: \${finding.title}\`, 'success');
            } else {
              failed++;
              logActivity(\`Failed to triage \${finding.title}: \${result.error}\`, 'error');
              if (result.status === 0 || result.status === 401) break;
            }
          }
          bulkRunning = false;
          for (const sev of SEVERITIES) {
            document.getElementById(sev + 'Slider').value = 0;
            document.getElementById(sev + 'TriageCount').textContent = '0';
          }
          enableFixAllButton();
          logActivity(\`Bulk triage finished: \${ok} triaged, \${failed} failed\`, failed ? 'error' : 'success');
        }

        async function authenticateWithApiKey() {
          const apiKey = document.getElementById('apiKeyInput').value.trim();
          const authBtn = document.getElementById('authenticateApiKeyBtn');
          const detectedInfo = document.getElementById('detectedInfo');

          if (!apiKey) {
            setAuthStatus('Paste an API key first.');
            return;
          }
          const keyInfo = decodeApiKey(apiKey);
          if (!keyInfo) {
            detectedInfo.style.display = 'none';
            setAuthStatus('That does not look like a Checkmarx One API key.');
            return;
          }
          document.getElementById('detectedTenant').textContent = keyInfo.tenant;
          document.getElementById('detectedRegion').textContent = keyInfo.regionLabel;
          detectedInfo.style.display = 'block';

          setAuthStatus('Verifying key with Checkmarx One…', '#1976d2');
          authBtn.disabled = true;
          try {
            let response;
            try {
              response = await fetch(apiBaseUrl + '/api/risks/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
                body: '{}',
              });
            } catch {
              setAuthStatus(\`Cannot reach the reminder server at \${apiBaseUrl}. It must be running and reachable from this computer.\`);
              logActivity('Connection failed: reminder server unreachable', 'error');
              return;
            }
            if (!response.ok) {
              let message = response.statusText;
              try { message = (await response.json()).error || message; } catch {}
              setAuthStatus(message);
              logActivity('Connection failed: ' + message, 'error');
              return;
            }
            userApiKey = apiKey;
            sessionStorage.setItem('cxApiKey', apiKey);
            setAuthStatus('✓ Connected', '#2e7d32');
            updateAuthUI();
            enableInteractiveButtons();
            logActivity(\`Connected to Checkmarx One (\${keyInfo.tenant}, \${keyInfo.regionLabel})\`, 'success');
            setTimeout(closeAuthModal, 400);
          } finally {
            authBtn.disabled = false;
          }
        }

        function decodeApiKey(apiKey) {
          try {
            const payload = String(apiKey).trim().split('.')[1];
            if (!payload) return null;
            const json = JSON.parse(
              decodeURIComponent(
                atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
                  .split('')
                  .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
                  .join(''),
              ),
            );
            const match = String(json.iss ?? '').match(new RegExp('^(https?://[^/]+)/auth/realms/([^/?#]+)'));
            if (!match) return null;
            const [, iamUrl, tenant] = match;
            const host = new URL(iamUrl).host;
            const region = host.match(new RegExp('^([a-z0-9-]+)[.](?:iam|ast)[.]', 'i'))?.[1]?.toLowerCase() ??
                          (new RegExp('^(iam|ast)[.]', 'i').test(host) ? 'us' : '');
            const regionLabels = {
              us: 'US', us2: 'US 2', eu: 'EU', eu2: 'EU 2', deu: 'Germany',
              anz: 'Australia / NZ', ind: 'India', sng: 'Singapore', uae: 'UAE', mea: 'Middle East',
            };
            return {
              tenant: decodeURIComponent(tenant),
              iamUrl,
              regionLabel: regionLabels[region] ?? (region ? region.toUpperCase() : 'Custom'),
            };
          } catch {
            return null;
          }
        }

        function clearApiKey() {
          userApiKey = null;
          sessionStorage.removeItem('cxApiKey');
          updateAuthUI();
          disableInteractiveButtons();
          logActivity('Disconnected from Checkmarx One', 'info');
        }

        function updateAuthUI() {
          const authBtn = document.getElementById('authBtn');
          if (userApiKey) {
            authBtn.textContent = '✓ Connected to CxONE';
            authBtn.classList.add('connected');
          } else {
            authBtn.textContent = 'Connect with CxONE';
            authBtn.classList.remove('connected');
          }
          enableFixAllButton();
        }

        function enableInteractiveButtons() {
          document.querySelectorAll('.finding-card:not(.triaged) [data-action="triage"]').forEach(btn => {
            btn.disabled = false;
          });
          enableFixAllButton();
        }

        function disableInteractiveButtons() {
          document.querySelectorAll('[data-action="triage"]').forEach(btn => {
            btn.disabled = true;
          });
          enableFixAllButton();
        }

        function restoreApiKey() {
          const stored = sessionStorage.getItem('cxApiKey');
          if (stored) {
            userApiKey = stored;
            updateAuthUI();
            enableInteractiveButtons();
            logActivity('Reconnected using the key from this browser session', 'info');
          }
        }

        function getTimeString() {
          const now = new Date();
          return now.toLocaleTimeString('en-US', { hour12: false });
        }

        function logActivity(message, type = 'info') {
          const entry = {
            timestamp: getTimeString(),
            message,
            type
          };
          activityLog.push(entry);
          updateActivityUI();
        }

        function updateActivityUI() {
          const activityDiv = document.getElementById('activityLog');
          if (!activityDiv) return;

          activityDiv.innerHTML = activityLog.map(entry => \`
            <div class="activity-item \${entry.type}">
              <div class="activity-icon">
                \${entry.type === 'success' ? '✓' : entry.type === 'error' ? '✕' : entry.type === 'pending' ? '⟳' : 'ℹ'}
              </div>
              <div class="activity-text">\${escapeHtml(entry.message)}</div>
              <div class="activity-time">\${entry.timestamp}</div>
            </div>
          \`).join('');

          // Auto-scroll to bottom
          activityDiv.scrollTop = activityDiv.scrollHeight;

          // Update overview counters
          const triaged = activityLog.filter(l => l.message.includes('Triaged') && l.type === 'success').length;
          const remediated = activityLog.filter(l => l.message.includes('Remediated') && l.type === 'success').length;
          const pending = document.querySelectorAll('[data-severity="CRITICAL"], [data-severity="HIGH"]').length - triaged - remediated;

          document.getElementById('triageCount').textContent = triaged;
          document.getElementById('remediateCount').textContent = remediated;
          document.getElementById('pendingCount').textContent = Math.max(0, pending);
        }

        function switchActivityTab(tab) {
          const overviewPanel = document.getElementById('overviewPanel');
          const activityPanel = document.getElementById('activityPanel');
          const tabs = document.querySelectorAll('.activity-tab');

          tabs.forEach(t => t.classList.remove('active'));
          event.target.classList.add('active');

          if (tab === 'overview') {
            overviewPanel.style.display = 'block';
            activityPanel.style.display = 'none';
          } else {
            overviewPanel.style.display = 'none';
            activityPanel.style.display = 'block';
          }
        }

        // Remediation guidance database
        const remediationGuide = {
          'SQL_INJECTION': {
            title: 'SQL Injection',
            description: 'SQL Injection vulnerabilities occur when user input is directly concatenated into SQL queries without proper parameterization, allowing attackers to execute arbitrary database commands.',
            risk: 'An attacker could read, modify, or delete sensitive data; bypass authentication; or execute administrative operations.',
            remediation: [
              'Use parameterized queries (prepared statements) for all database operations',
              'Implement input validation and sanitization on the server side',
              'Apply the principle of least privilege to database user accounts',
              'Use an ORM framework that handles parameterization automatically',
              'Enable SQL query logging and monitoring'
            ],
            examples: {
              'JavaScript/Node.js': 'const result = await db.query("SELECT * FROM users WHERE id = ?", [userId]);',
              'Python': 'cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))',
              'Java': 'PreparedStatement stmt = conn.prepareStatement("SELECT * FROM users WHERE id = ?");',
              'PHP': '$stmt = $pdo->prepare("SELECT * FROM users WHERE id = ?");'
            }
          },
          'CROSS_SITE_SCRIPTING': {
            title: 'Cross-Site Scripting (XSS)',
            description: 'XSS vulnerabilities allow attackers to inject malicious scripts into web pages viewed by other users, compromising user data and session tokens.',
            risk: 'Session hijacking, credential theft, malware distribution, website defacement, or unauthorized actions on behalf of users.',
            remediation: [
              'Encode all user input when rendering in HTML context',
              'Use Content Security Policy (CSP) headers to restrict script execution',
              'Implement input validation on the server side',
              'Use templating engines with automatic escaping enabled',
              'Keep all client-side libraries and frameworks up to date'
            ],
            examples: {
              'JavaScript': 'element.textContent = userInput; // Always use textContent, not innerHTML',
              'React': '{userInput} // JSX auto-escapes by default',
              'HTML5': '<script nonce="random123">// Use nonce attributes for inline scripts<\\/script>',
              'Headers': "Content-Security-Policy: default-src 'self'; script-src 'self'"
            }
          },
          'INSECURE_DIRECT_OBJECT_REFERENCE': {
            title: 'Insecure Direct Object Reference (IDOR)',
            description: 'IDOR vulnerabilities occur when an application exposes internal object references (IDs) without proper access control, allowing unauthorized users to access others’ data.',
            risk: 'Unauthorized access to sensitive information, data manipulation, or complete account takeover.',
            remediation: [
              'Implement proper access control checks on every resource access',
              'Use role-based access control (RBAC) or attribute-based access control (ABAC)',
              'Verify the current user has permission to access the requested resource',
              'Use indirect references instead of direct IDs when possible',
              'Log and monitor access to sensitive resources'
            ],
            examples: {
              'Node.js': 'if (req.user.id !== userId) { return res.status(403).send("Forbidden"); }',
              'Python/Flask': '@login_required def get_user(user_id):\\n    if current_user.id != user_id:\\n        abort(403)',
              'Java/Spring': '@PreAuthorize("#user.id == authentication.principal.id")',
              'General': 'Always verify: req.user.id == resource.owner_id'
            }
          },
          'INSECURE_DESERIALIZATION': {
            title: 'Insecure Deserialization',
            description: 'Insecure deserialization occurs when an application unserializes untrusted data without validation, potentially allowing remote code execution.',
            risk: 'Remote code execution, arbitrary command execution, denial of service attacks, or complete system compromise.',
            remediation: [
              'Avoid deserializing untrusted data',
              'Use data formats like JSON instead of native serialization',
              'Implement integrity checks (HMAC) on serialized data',
              'Use whitelist validation for allowed classes during deserialization',
              'Keep serialization libraries patched and updated'
            ],
            examples: {
              'Python': 'import json; data = json.loads(user_input) # Use JSON instead of pickle',
              'Java': '// Avoid: ObjectInputStream ois = new ObjectInputStream(is);',
              'PHP': '$data = json_decode($user_input); // Use JSON, not unserialize()',
              'General': 'Principle: Never deserialize untrusted data with object instantiation'
            }
          },
          'DEFAULT': {
            title: 'Security Vulnerability',
            description: 'This finding identifies a potential security vulnerability that requires attention and remediation.',
            risk: 'The vulnerability could potentially be exploited by an attacker to compromise the security or integrity of the application.',
            remediation: [
              'Review the detailed finding information and location in your codebase',
              'Consult with your security team to understand the impact',
              'Implement the recommended fix for this vulnerability type',
              'Test thoroughly to ensure the fix doesn’t introduce new issues',
              'Document the remediation in your change log'
            ],
            examples: {}
          }
        };

        function getRemediationContent(risk) {
          const type = risk.title?.toUpperCase()?.replace(/[^A-Z0-9_]/g, '_') || 'DEFAULT';
          const guide = remediationGuide[type] || remediationGuide.DEFAULT;

          let html = \`<div class="remediation-section">
            <div class="remediation-section-title">Vulnerability Type</div>
            <div class="remediation-section-content">\${escapeHtml(guide.title)}</div>
          </div>

          <div class="remediation-section">
            <div class="remediation-section-title">Description</div>
            <div class="remediation-section-content">\${escapeHtml(guide.description)}</div>
          </div>

          <div class="remediation-section">
            <div class="remediation-section-title">Risk Impact</div>
            <div class="remediation-section-content">\${escapeHtml(guide.risk)}</div>
          </div>\`;

          if (risk.location) {
            html += \`<div class="remediation-section">
              <div class="remediation-section-title">Location</div>
              <div class="remediation-section-content"><strong>File/Path:</strong> \${escapeHtml(risk.location)}</div>
            </div>\`;
          }

          html += \`<div class="remediation-section">
            <div class="remediation-section-title">Remediation Steps</div>
            <div class="remediation-section-content">
              <ol style="margin-left: 20px;">
                \${guide.remediation.map(step => \`<li style="margin-bottom: 8px;">\${escapeHtml(step)}</li>\`).join('')}
              </ol>
            </div>
          </div>\`;

          if (Object.keys(guide.examples).length > 0) {
            html += \`<div class="remediation-section">
              <div class="remediation-section-title">Code Examples</div>
              <div class="remediation-section-content">
                \${Object.entries(guide.examples).map(([lang, code]) =>
                  \`<div style="margin-bottom: 15px;">
                    <strong>\${escapeHtml(lang)}:</strong>
                    <div class="code-block">\${escapeHtml(code)}</div>
                  </div>\`
                ).join('')}
              </div>
            </div>\`;
          }

          return html;
        }

        function showRemediationModal(riskId) {
          const card = document.querySelector(\`[data-risk-id="\${riskId}"]\`);
          if (!card) return;

          const risk = {
            title: card.querySelector('.finding-title-card')?.textContent || 'Unknown',
            location: card.querySelector('[data-finding-location]')?.textContent || '',
            severity: card.getAttribute('data-severity')
          };

          document.getElementById('modalTitle').textContent = \`Remediation: \${escapeHtml(risk.title)}\`;
          document.getElementById('remediationBody').innerHTML = getRemediationContent(risk);
          document.getElementById('remediationModal').classList.add('show');
        }

        function closeRemediationModal() {
          document.getElementById('remediationModal').classList.remove('show');
        }

        window.addEventListener('click', (e) => {
          const modal = document.getElementById('remediationModal');
          if (e.target === modal) modal.classList.remove('show');
        });

        function escapeHtml(text) {
          return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]);
        }

        function markCardTriaged(card) {
          card.classList.add('triaged');
          const btn = card.querySelector('[data-action="triage"]');
          if (btn) {
            btn.textContent = '✓ Triaged';
            btn.disabled = true;
            btn.classList.add('finding-btn-disabled');
          }
        }

        async function triageFinding(riskId, projectId, scanId, cardElement) {
          if (!userApiKey) { toggleAuthPanel(); return; }
          const btn = cardElement.querySelector('[data-action="triage"]');
          const title = cardElement.querySelector('.finding-title-card')?.textContent.trim() || riskId;
          btn.disabled = true;
          btn.innerHTML = '<span class="loading"></span>Triaging...';
          logActivity(\`Triaging: \${title}\`, 'pending');
          const result = await postRiskAction('triage', { riskId, projectId, scanId });
          if (result.ok) {
            findingStates[riskId] = { ...findingStates[riskId], triaged: true };
            markCardTriaged(cardElement);
            logActivity(\`Triaged: \${title}\`, 'success');
          } else {
            btn.textContent = '⚠ Retry';
            btn.disabled = false;
            logActivity(\`Failed to triage \${title}: \${result.error}\`, 'error');
          }
        }

        document.addEventListener('DOMContentLoaded', () => {
          restoreApiKey();
          enableFixAllButton();
          logActivity('Report loaded', 'info');

          document.querySelectorAll('[data-risk-id]').forEach(card => {
            const exploitability = card.getAttribute('data-exploitability');
            const reachability = card.getAttribute('data-reachability');
            if (exploitability || reachability) {
              displayAiTriageRecommendation(card, exploitability, reachability);
            }
          });
        });

        function displayAiTriageRecommendation(card, exploitability, reachability) {
            // Create a recommendation banner based on AI analysis
            if (exploitability || reachability) {
                const rec = document.createElement('div');
                rec.style.cssText = 'background: #fff3e0; border-left: 3px solid #ff9800; padding: 10px; margin-top: 10px; border-radius: 3px; font-size: 12px;';
                rec.innerHTML = '<strong>🤖 AI Recommendation:</strong> ';

                const factors = [];
                if (exploitability === 'HIGH') factors.push('High exploitability');
                if (reachability === 'HIGH') factors.push('Highly reachable');

                if (factors.length > 0) {
                    rec.innerHTML += factors.join(' · ') + ' - Prioritize for remediation';
                } else {
                    rec.innerHTML += 'Review for context';
                }

                const actionDiv = card.querySelector('.finding-actions');
                if (actionDiv) {
                    actionDiv.parentNode.insertBefore(rec, actionDiv);
                }
            }
        }
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
      const title = risk.url
        ? `<a href="${escapeHtml(risk.url)}" target="_blank" rel="noopener">${escapeHtml(risk.title)}</a>`
        : escapeHtml(risk.title);
      const location = risk.location && risk.location !== '—' ? risk.location : '';
      const titleWithLocation = location ? `${title} · <span style="color: #999;">@${escapeHtml(location)}</span>` : title;
      
      const args = `'${escapeHtml(risk.riskId)}', '${escapeHtml(project.projectId)}', '${escapeHtml(risk.scanId)}', this.closest('.finding-card')`;

      // AI Analysis summary
      let aiAnalysis = '';
      if (risk.aiExploitability || risk.aiReachability) {
        const parts = [];
        if (risk.aiExploitability) {
          const cls = risk.aiExploitability === 'HIGH' ? 'finding-ai-high' : 'finding-ai-medium';
          parts.push(`<span class="${cls}">E: ${risk.aiExploitability}</span>`);
        }
        if (risk.aiReachability) {
          const cls = risk.aiReachability === 'HIGH' ? 'finding-ai-high' : 'finding-ai-medium';
          parts.push(`<span class="${cls}">R: ${risk.aiReachability}</span>`);
        }
        aiAnalysis = `<div class="finding-ai-cell">${parts.join(' ')}</div>`;
      } else {
        aiAnalysis = '<div class="finding-ai-cell" style="color: #999;">—</div>';
      }

      const engine = risk.scanner || risk.engine || '—';

      return `
        <div class="finding-card" data-risk-id="${escapeHtml(risk.riskId)}" data-project-id="${escapeHtml(project.projectId)}" data-scan-id="${escapeHtml(risk.scanId)}" data-severity="${escapeHtml(severity)}" data-exploitability="${escapeHtml(risk.aiExploitability)}" data-reachability="${escapeHtml(risk.aiReachability)}">
          <span class="finding-card-severity ${severity.toLowerCase()}">${escapeHtml(severity)}</span>
          <div class="finding-title-card">${titleWithLocation}</div>
          <div class="finding-age-cell">${ageLabel(risk.ageDays)}</div>
          ${aiAnalysis}
          <div style="font-size: 11px; color: #666;"><span style="color: #999;">Engine:</span> ${escapeHtml(engine)}</div>
          <div class="finding-actions">
            <button class="finding-btn finding-btn-remediate" data-action="remediate" onclick="showRemediationModal('${escapeHtml(risk.riskId)}')">Guide</button>
            <button class="finding-btn finding-btn-triage" data-action="triage" onclick="triageFinding(${args})" disabled>Triage</button>
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

function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function sanitizeJsString(str) {
  if (!str) return '';
  return escapeHtml(str).replace(/'/g, "\\'");
}
