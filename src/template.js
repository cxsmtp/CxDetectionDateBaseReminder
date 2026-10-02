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
// Raw output needs the braces balanced, `{{{name}}}`: an unbalanced `{{{name}}`
// is not a raw tag, so it can never switch escaping off by accident.
const TOKEN_SOURCE = String.raw`\{\{([#^/]?)\s*(?:(\{)\s*([\w.]+)\s*\}|([\w.]+))\s*\}\}`;

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
    const [raw, sigil, brace, rawName, plainName] = match;
    const name = rawName ?? plainName;
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
  { name: 'criticalCount', description: 'Number of critical findings (also highCount, mediumCount, lowCount)' },
  { name: 'maxAgeDays', description: 'Age of the oldest finding, in days' },
  { name: 'oldestFirstDetected', description: 'Date of the earliest first detection' },
  { name: 'projectName', description: 'Set only when the mail covers a single project' },
  { name: 'multipleProjects', description: 'Truthy only when more than one project is covered' },
  { name: 'companyName', description: 'Your company name, from Settings -> Branding' },
  { name: 'logoUrl', description: 'Your logo, shown in the header' },
  { name: 'accentColor', description: 'Brand colour used for rules and links' },
  { name: 'callToAction', description: 'The instruction shown above the findings' },
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
  { name: 'projects.url', description: "Link to the project in Checkmarx One" },
  { name: 'risks.title', description: 'Finding name' },
  { name: 'risks.url', description: 'Link straight to that finding in Checkmarx One' },
  { name: 'risks.severity', description: 'CRITICAL / HIGH / MEDIUM / LOW' },
  { name: 'risks.location', description: 'File or package' },
  { name: 'risks.firstDetectedAt', description: 'First-detection date (YYYY-MM-DD)' },
  { name: 'risks.ageDays', description: 'Days since first detection' },
  { name: 'risks.state', description: 'Finding state, when the tenant reports one' },
  { name: 'hiddenCount', description: 'Findings omitted from a truncated project list' },
];

export const DEFAULT_TEMPLATE = {
  subject:
    '{{#projectName}}[{{projectName}}] {{/projectName}}Checkmarx One: {{totalRisks}} open finding(s), oldest {{maxAgeDays}} days',

  html: `<div style="max-width:780px;margin:0 auto;padding:24px;font:14px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;color:#0f172a">

  {{#logoUrl}}
  <div style="padding-bottom:16px;border-bottom:2px solid {{accentColor}};margin-bottom:20px">
    <img src="{{logoUrl}}" alt="{{companyName}}" height="{{logoHeight}}" style="height:{{logoHeight}}px;max-width:280px;display:block;border:0" />
  </div>
  {{/logoUrl}}
  {{^logoUrl}}
  {{#companyName}}
  <div style="padding-bottom:12px;border-bottom:2px solid {{accentColor}};margin-bottom:20px;font-size:17px;font-weight:600">
    {{companyName}}
  </div>
  {{/companyName}}
  {{/logoUrl}}

  <h2 style="margin:0 0 6px;font-size:20px">
    {{#projectName}}{{projectName}}{{/projectName}}{{^projectName}}Open security findings need attention{{/projectName}}
  </h2>

  <p style="margin:0 0 18px;color:#475569">
    <strong>{{totalRisks}}</strong> open finding(s){{#multipleProjects}} across <strong>{{projectCount}}</strong> projects{{/multipleProjects}},
    first detected {{scope}}. The oldest has been open for <strong>{{maxAgeDays}} days</strong>{{#oldestFirstDetected}} (since {{oldestFirstDetected}}){{/oldestFirstDetected}}.
  </p>

  <table role="presentation" style="border-collapse:separate;border-spacing:8px 0;margin:0 0 18px">
    <tr>
      <td style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 16px;text-align:center">
        <div style="font-size:22px;font-weight:700;color:#b91c1c">{{criticalCount}}</div>
        <div style="font-size:11px;color:#7f1d1d;text-transform:uppercase;letter-spacing:.05em">Critical</div>
      </td>
      <td style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:10px 16px;text-align:center">
        <div style="font-size:22px;font-weight:700;color:#c2410c">{{highCount}}</div>
        <div style="font-size:11px;color:#7c2d12;text-transform:uppercase;letter-spacing:.05em">High</div>
      </td>
      <td style="background:#fefce8;border:1px solid #fde68a;border-radius:8px;padding:10px 16px;text-align:center">
        <div style="font-size:22px;font-weight:700;color:#a16207">{{mediumCount}}</div>
        <div style="font-size:11px;color:#713f12;text-transform:uppercase;letter-spacing:.05em">Medium</div>
      </td>
      <td style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 16px;text-align:center">
        <div style="font-size:22px;font-weight:700;color:#475569">{{lowCount}}</div>
        <div style="font-size:11px;color:#334155;text-transform:uppercase;letter-spacing:.05em">Low</div>
      </td>
    </tr>
  </table>

  {{#callToAction}}
  <p style="margin:0 0 22px;padding:12px 16px;background:#eff6ff;border-left:4px solid {{accentColor}};border-radius:4px;color:#1e3a8a">
    {{callToAction}}
  </p>
  {{/callToAction}}

  {{#projects}}
  <h3 style="margin:24px 0 8px;font-size:15px">
    {{#url}}<a href="{{url}}" style="color:{{accentColor}};text-decoration:none">{{projectName}}</a>{{/url}}
    {{^url}}{{projectName}}{{/url}}
    <span style="font-weight:400;color:#64748b">&mdash; {{riskCount}} open, oldest {{oldestFirstDetected}}</span>
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
        <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9">
          {{#url}}<a href="{{url}}" style="color:{{accentColor}};text-decoration:none">{{title}}</a>{{/url}}
          {{^url}}{{title}}{{/url}}
        </td>
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
    Each finding above links straight to it in Checkmarx One &mdash; click through to start fixing.<br />
    Sent for tenant {{tenant}} on {{generatedAt}} UTC.
  </p>
</div>`,
};
