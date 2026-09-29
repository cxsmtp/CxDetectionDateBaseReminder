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
            background: linear-gradient(135deg, #d32f2f 0%, #c62828 100%);
            color: white;
            padding: 30px;
            border-radius: 8px;
            margin-bottom: 20px;
            text-align: center;
            box-shadow: 0 4px 12px rgba(211, 47, 47, 0.3);
        }
        .cta-title { font-size: 20px; font-weight: bold; margin-bottom: 10px; }
        .cta-subtitle { font-size: 14px; opacity: 0.95; margin-bottom: 15px; }
        .cta-metrics {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 15px;
            margin-top: 15px;
            padding-top: 15px;
            border-top: 1px solid rgba(255, 255, 255, 0.3);
        }
        .cta-metric { text-align: center; }
        .cta-metric-value { font-size: 32px; font-weight: bold; }
        .cta-metric-label { font-size: 12px; opacity: 0.9; text-transform: uppercase; }

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

        @media (max-width: 600px) {
            .summary-band { grid-template-columns: 1fr 1fr; }
            .action-buttons { flex-direction: column; }
            .action-btn { width: 100%; }
            .finding-header { flex-direction: column; }
            .cta-metrics { grid-template-columns: 1fr; }
            .remediation-content { padding: 20px; max-width: 95vw; }
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

        <!-- Critical CTA Section -->
        <div class="call-to-action">
            <div class="cta-title">⚠️ Immediate Action Required</div>
            <div class="cta-subtitle">Review and remediate critical and high-severity vulnerabilities</div>
            <div class="cta-metrics">
                <div class="cta-metric">
                    <div class="cta-metric-value">${criticalCount}</div>
                    <div class="cta-metric-label">Critical Issues</div>
                </div>
                <div class="cta-metric">
                    <div class="cta-metric-value">${highCount}</div>
                    <div class="cta-metric-label">High Severity</div>
                </div>
            </div>
        </div>

        <!-- Call to Action Custom -->
        ${branding.callToAction ? `<div class="call-to-action" style="background: white; color: #333; border-top: 2px solid #d32f2f; padding: 20px;">${escapeHtml(branding.callToAction)}</div>` : ''}

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

        <!-- Priority Findings (Critical + High Only) -->
        <div class="all-findings">
            <div class="findings-title">Priority Vulnerabilities to Address (${priorityFindingsCount})</div>
            <div class="findings-grid" id="findings-grid">
                ${generateFindingCards(priorityProjects)}
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

    <script>
        // Configuration from server
        const apiBaseUrl = '${sanitizeJsString(apiBaseUrl)}';
        const sessionCookie = '${sanitizeJsString(sessionCookie)}';

        // Track finding states locally
        const findingStates = {};

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
              'HTML5': '<script nonce="random123">// Use nonce attributes for inline scripts</script>',
              'Headers': 'Content-Security-Policy: default-src \'self\'; script-src \'self\''
            }
          },
          'INSECURE_DIRECT_OBJECT_REFERENCE': {
            title: 'Insecure Direct Object Reference (IDOR)',
            description: 'IDOR vulnerabilities occur when an application exposes internal object references (IDs) without proper access control, allowing unauthorized users to access others\' data.',
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
              'Test thoroughly to ensure the fix doesn\'t introduce new issues',
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
            <button class="finding-btn finding-btn-remediate" data-action="remediate" onclick="showRemediationModal('${escapeHtml(risk.riskId)}')">📋 View Remediation Guide</button>
            <button class="finding-btn finding-btn-triage" data-action="triage" onclick="triageFinding(${args})">✓ Mark as Triaged</button>
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
