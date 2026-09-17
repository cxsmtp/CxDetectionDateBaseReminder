/**
 * A small, safe mail-template renderer.
 *
 * The administrator authors the template, so its own markup is emitted as
 * written. Everything substituted *into* it comes from Checkmarx and is
 * HTML-escaped by default; `{{{name}}}` opts a value out of escaping.
 *
 * Supported syntax:
 *   {{name}}            escaped value
 *   {{{name}}}          raw value
 *   {{#section}}…{{/section}}   repeat for an array, or show once if truthy
 *   {{^section}}…{{/section}}   show only when empty or falsy
 *   {{.}}               the current item inside an array of primitives
 *
 * There is no expression evaluation of any kind: a name is a dotted path
 * looked up in the current scope chain, nothing more.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Look a dotted path up through the scope stack, innermost scope first. */
function lookup(stack, name) {
  if (name === '.') return stack[stack.length - 1];

  const parts = name.split('.');
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    let value = stack[i];
    if (value === null || value === undefined) continue;

    let found = true;
    for (const part of parts) {
      if (value !== null && typeof value === 'object' && part in value) {
        value = value[part];
      } else {
        found = false;
        break;
      }
    }
    if (found) return value;
  }
  return undefined;
}

const isEmpty = (value) =>
  value === undefined ||
  value === null ||
  value === false ||
  value === '' ||
  (Array.isArray(value) && value.length === 0);

// render() recurses for section bodies, so the pattern is compiled per call:
// a shared /g regex would have its lastIndex clobbered by the inner render
// and restart the outer scan from zero, looping forever.
const TOKEN_SOURCE = String.raw`\{\{([#^/]?)\s*([{]?)([\w.]+)\s*[}]?\}\}`;

export class TemplateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TemplateError';
    this.status = 400;
  }
}

/**
 * Render `source` against `data`.
 *
 * @param {string} source
 * @param {object} data
 * @param {{escape?: boolean}} [options]  escape:false renders a plain-text
 *   template, where HTML escaping would only corrupt the output.
 */
export function render(source, data, { escape = true } = {}) {
  return renderWithStack(source, [data], escape);
}

/**
 * The scope chain is threaded through the recursion rather than flattened, so
 * a section body can see both the current item and everything outside it, and
 * `{{.}}` resolves to the item itself even when it is a primitive.
 */
function renderWithStack(source, stack, escape) {
  // Compiled per call: a shared /g regex would have its lastIndex clobbered by
  // the inner render and restart the outer scan from zero, looping forever.
  const token = new RegExp(TOKEN_SOURCE, 'g');
  const out = [];
  // Each open section records where its body began so that, on close, we can
  // re-render that body once per item.
  const sections = [];
  let cursor = 0;
  let match;

  while ((match = token.exec(source)) !== null) {
    const [raw, sigil, brace, name] = match;
    const text = source.slice(cursor, match.index);
    cursor = match.index + raw.length;

    if (sections.length === 0) out.push(text);

    if (sigil === '#' || sigil === '^') {
      sections.push({ name, inverted: sigil === '^', start: cursor });
      continue;
    }

    if (sigil === '/') {
      const open = sections.pop();
      if (!open) throw new TemplateError(`Unexpected {{/${name}}} with no matching opening tag.`);
      if (open.name !== name) {
        throw new TemplateError(`{{#${open.name}}} is closed by {{/${name}}}.`);
      }
      if (sections.length > 0) continue; // Inner section: handled by this pass.

      const body = source.slice(open.start, match.index);
      const value = lookup(stack, open.name);

      if (open.inverted) {
        if (isEmpty(value)) out.push(renderWithStack(body, stack, escape));
        continue;
      }

      if (isEmpty(value)) continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        stack.push(item);
        out.push(renderWithStack(body, stack, escape));
        stack.pop();
      }
      continue;
    }

    if (sections.length > 0) continue; // Inside a section body; rendered later.

    const value = lookup(stack, name);
    if (value === undefined || value === null) continue;
    out.push(brace === '{' || !escape ? String(value) : escapeHtml(value));
  }

  if (sections.length > 0) {
    throw new TemplateError(`{{#${sections[0].name}}} is never closed.`);
  }

  out.push(source.slice(cursor));
  return out.join('');
}

/** Names the editor advertises, so an administrator is not guessing. */
export const TEMPLATE_VARIABLES = [
  { name: 'subject', description: 'The rendered subject line (body templates only)' },
  { name: 'tenant', description: 'Checkmarx One tenant name' },
  { name: 'generatedAt', description: 'When the reminder was produced (UTC)' },
  { name: 'scope', description: 'Age buckets the reminder covers, e.g. "more than 60 days"' },
  { name: 'totalRisks', description: 'Number of findings in the reminder' },
  { name: 'projectCount', description: 'Number of affected projects' },
  { name: 'severitySummary', description: 'e.g. "2 critical, 5 high"' },
  { name: 'severities', description: 'Loop: {{#severities}}{{label}} {{count}}{{/severities}}' },
  { name: 'projects', description: 'Loop over affected projects' },
  { name: 'initiator', description: 'Who ran the latest scan (per-initiator sends only)' },
  { name: 'initiatorEmail', description: "That person's email address" },
  { name: 'projects.projectName', description: 'Project name (inside the projects loop)' },
  { name: 'projects.initiator', description: 'Who ran that project\'s latest scan' },
  { name: 'projects.lastScanDate', description: 'Date of that project\'s latest scan' },
  { name: 'projects.riskCount', description: 'Findings in that project' },
  { name: 'projects.oldestFirstDetected', description: 'Earliest first-detection date in that project' },
  { name: 'projects.risks', description: 'Loop over findings within a project' },
  { name: 'risks.title', description: 'Finding name' },
  { name: 'risks.severity', description: 'CRITICAL / HIGH / MEDIUM / LOW' },
  { name: 'risks.location', description: 'File or package' },
  { name: 'risks.firstDetectedAt', description: 'First-detection date (YYYY-MM-DD)' },
  { name: 'risks.ageDays', description: 'Days since first detection' },
  { name: 'risks.state', description: 'Finding state, when the tenant reports one' },
  { name: 'hiddenCount', description: 'Findings omitted from a truncated project list' },
];

export const DEFAULT_TEMPLATE = {
  subject:
    'Checkmarx One: {{totalRisks}} open finding(s) first detected {{scope}}',
  html: `<div style="max-width:760px;margin:0 auto;padding:24px;font:14px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;color:#0f172a">

  <h2 style="margin:0 0 4px;font-size:19px">Open vulnerabilities need attention</h2>

  <p style="margin:0 0 20px;color:#475569">
    <strong>{{totalRisks}}</strong> finding(s) across <strong>{{projectCount}}</strong> project(s)
    were first detected <strong>{{scope}}</strong> and are still open.
    {{#severitySummary}}Severity breakdown: {{severitySummary}}.{{/severitySummary}}
  </p>

  {{#projects}}
  <h3 style="margin:24px 0 8px;font-size:15px">
    {{projectName}} <span style="font-weight:400;color:#64748b">&mdash; {{riskCount}} open</span>
  </h3>

  <table role="presentation" style="border-collapse:collapse;width:100%;font-size:13px">
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
      {{#risks}}
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9">{{severity}}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9">{{title}}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;color:#64748b">{{location}}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9">{{firstDetectedAt}}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9">{{ageDays}}d</td>
      </tr>
      {{/risks}}
    </tbody>
  </table>
  {{#hiddenCount}}<p style="color:#64748b;font-size:13px">&hellip;and {{hiddenCount}} more.</p>{{/hiddenCount}}
  {{/projects}}

  <p style="margin-top:28px;color:#94a3b8;font-size:12px">
    Sent from the Checkmarx detection-date reminder for tenant {{tenant}} on {{generatedAt}} UTC.
  </p>
</div>`,
};
