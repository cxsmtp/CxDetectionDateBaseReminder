import nodemailer from 'nodemailer';

import { AGE_BUCKETS } from './cxone/risks.js';
import { triggerFeedbackApp } from './cxone/feedbackApps.js';

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO', 'UNKNOWN'];

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

const formatDate = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : 'unknown');

const bucketLabel = (id) => AGE_BUCKETS.find((bucket) => bucket.id === id)?.label ?? id;

function sortRisks(risks) {
  return [...risks].sort((a, b) => {
    const severity = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    if (severity !== 0) return severity;
    return (b.ageDays ?? -1) - (a.ageDays ?? -1);
  });
}

/** Group the selected risks per project, oldest/most severe first. */
export function groupByProject(risks) {
  const groups = new Map();
  for (const risk of risks) {
    if (!groups.has(risk.projectId)) {
      groups.set(risk.projectId, { projectId: risk.projectId, projectName: risk.projectName, risks: [] });
    }
    groups.get(risk.projectId).risks.push(risk);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, risks: sortRisks(group.risks) }))
    .sort((a, b) => b.risks.length - a.risks.length);
}

/** Build the reminder subject and body from a set of selected risks. */
export function buildReminder(risks, { buckets = [], now = new Date(), maxRowsPerProject = 25 } = {}) {
  const groups = groupByProject(risks);
  const scope = buckets.length ? buckets.map(bucketLabel).join(', ') : 'all ages';
  const subject = `Checkmarx One reminder: ${risks.length} open vulnerabilit${
    risks.length === 1 ? 'y' : 'ies'
  } first detected ${scope.toLowerCase()}`;

  const severityTotals = {};
  for (const risk of risks) severityTotals[risk.severity] = (severityTotals[risk.severity] ?? 0) + 1;
  const severitySummary = SEVERITY_ORDER.filter((key) => severityTotals[key])
    .map((key) => `${severityTotals[key]} ${key.toLowerCase()}`)
    .join(', ');

  const textLines = [
    subject,
    '',
    `Generated ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    `Age scope (time since first detection): ${scope}`,
    `Projects affected: ${groups.length}`,
    severitySummary ? `Severity breakdown: ${severitySummary}` : '',
    '',
  ].filter(Boolean);

  const htmlSections = [];

  for (const group of groups) {
    const shown = group.risks.slice(0, maxRowsPerProject);
    const hidden = group.risks.length - shown.length;

    textLines.push(`${group.projectName} (${group.risks.length})`);
    for (const risk of shown) {
      textLines.push(
        `  - [${risk.severity}] ${risk.title}` +
          `${risk.location ? ` (${risk.location})` : ''}` +
          ` | first detected ${formatDate(risk.firstDetectedAt)}` +
          `${risk.ageDays === null ? '' : ` | ${risk.ageDays} days old`}`,
      );
    }
    if (hidden > 0) textLines.push(`  ... and ${hidden} more`);
    textLines.push('');

    htmlSections.push(`
      <h3 style="margin:24px 0 8px;font:600 15px/1.4 system-ui,sans-serif;color:#0f172a">
        ${escapeHtml(group.projectName)}
        <span style="font-weight:400;color:#64748b">— ${group.risks.length} open</span>
      </h3>
      <table role="presentation" style="border-collapse:collapse;width:100%;font:13px/1.5 system-ui,sans-serif">
        <thead>
          <tr style="background:#f1f5f9;text-align:left;color:#475569">
            <th style="padding:6px 8px;border-bottom:1px solid #e2e8f0">Severity</th>
            <th style="padding:6px 8px;border-bottom:1px solid #e2e8f0">Vulnerability</th>
            <th style="padding:6px 8px;border-bottom:1px solid #e2e8f0">Location</th>
            <th style="padding:6px 8px;border-bottom:1px solid #e2e8f0">First detected</th>
            <th style="padding:6px 8px;border-bottom:1px solid #e2e8f0">Age</th>
          </tr>
        </thead>
        <tbody>
          ${shown
            .map(
              (risk) => `
          <tr>
            <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9">${escapeHtml(risk.severity)}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9">${escapeHtml(risk.title)}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;color:#64748b">${escapeHtml(
              risk.location || '—',
            )}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9">${formatDate(risk.firstDetectedAt)}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9">${
              risk.ageDays === null ? '—' : `${risk.ageDays}d`
            }</td>
          </tr>`,
            )
            .join('')}
        </tbody>
      </table>
      ${hidden > 0 ? `<p style="color:#64748b;font:13px system-ui,sans-serif">…and ${hidden} more.</p>` : ''}
    `);
  }

  const html = `
    <div style="max-width:760px;margin:0 auto;padding:24px;color:#0f172a">
      <h2 style="margin:0 0 4px;font:600 19px/1.3 system-ui,sans-serif">Open Checkmarx One vulnerabilities need attention</h2>
      <p style="margin:0 0 16px;color:#475569;font:14px/1.6 system-ui,sans-serif">
        ${risks.length} finding${risks.length === 1 ? '' : 's'} across
        ${groups.length} project${groups.length === 1 ? '' : 's'} were first detected
        <strong>${escapeHtml(scope.toLowerCase())}</strong> and are still open.
        ${severitySummary ? `Severity breakdown: ${escapeHtml(severitySummary)}.` : ''}
      </p>
      ${htmlSections.join('')}
      <p style="margin-top:28px;color:#94a3b8;font:12px/1.5 system-ui,sans-serif">
        Sent by the Checkmarx detection-date reminder utility on
        ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC.
      </p>
    </div>`;

  return { subject, text: textLines.join('\n'), html, groups, totalRisks: risks.length };
}

function buildTransport(smtp) {
  if (!smtp.host) return null;
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
  });
}

/**
 * Deliver the reminder.  The recipients always come from the selected Feedback
 * App; `mode` only decides the transport:
 *   feedback - ask CxONE to send it through the feedback app
 *   smtp     - send it ourselves to the app's recipients
 *   auto     - feedback app first, SMTP if the tenant has no trigger endpoint
 */
export async function sendReminder({ client, config, app, reminder, buckets, dryRun = false }) {
  const recipients = app.recipients;
  const mode = config.delivery.mode;

  if (dryRun) {
    return { delivered: false, dryRun: true, via: 'preview', recipients, subject: reminder.subject };
  }

  if (mode !== 'smtp') {
    const payload = {
      subject: reminder.subject,
      body: reminder.html,
      text: reminder.text,
      recipients,
      buckets,
      projects: reminder.groups.map((group) => ({
        projectId: group.projectId,
        projectName: group.projectName,
        riskCount: group.risks.length,
      })),
    };

    const result = await triggerFeedbackApp(client, config, app.id, payload);
    if (result) {
      return { delivered: true, via: 'feedback-app', recipients, subject: reminder.subject, path: result.path };
    }
    if (mode === 'feedback') {
      throw new Error(
        `Feedback app "${app.name}" has no trigger endpoint on this tenant. ` +
          'Set CX_FEEDBACK_APP_TRIGGER_PATH, or use REMINDER_DELIVERY_MODE=smtp/auto.',
      );
    }
  }

  const transport = buildTransport(config.delivery.smtp);
  if (!transport) {
    throw new Error(
      'The feedback app could not be triggered through the API and SMTP is not configured. ' +
        'Set SMTP_HOST (and friends) in .env, or set CX_FEEDBACK_APP_TRIGGER_PATH.',
    );
  }
  if (recipients.length === 0) {
    throw new Error(`Feedback app "${app.name}" has no email recipients configured in Checkmarx One.`);
  }

  const info = await transport.sendMail({
    from: config.delivery.smtp.from || config.delivery.smtp.user,
    to: recipients,
    subject: reminder.subject,
    text: reminder.text,
    html: reminder.html,
  });

  return { delivered: true, via: 'smtp', recipients, subject: reminder.subject, messageId: info.messageId };
}
