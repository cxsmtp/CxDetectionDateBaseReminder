import { LOOK_PALETTES, NEXTGEN_ACCENTS } from '../public/look.js';
import { render, escapeHtml } from './template.js';

/**
 * The reminder email (Act → Automation → Email): written as a few plain fields, not HTML, and branded like
 * the portal unless chosen otherwise. Each field may hold {{placeholders}} (REMINDER_PLACEHOLDERS); what is
 * filled in comes from Checkmarx One and is escaped. `style: 'html'` uses the HTML template instead
 * (Settings → Mail template, kept for whoever wrote their own).
 */

export const DEFAULT_REMINDER_EMAIL = {
  style: 'simple',
  // Empty: the same as the portal (the Email server's From name; replies to the From address).
  senderName: '',
  replyTo: '',
  // 'portal' (Settings → Branding's logo), 'custom' (logoUrl) or 'none'.
  logo: 'portal',
  logoUrl: '',
  // Empty: the portal's colours (its look; Branding's colour on Command center and Classic).
  color: '',
  headerText: 'Security reminder',
  // Empty: the company name and the From address.
  footer: '',
  subject: '{{count}} findings in your projects are past our limits',
  greeting: 'Hi {{firstName}},',
  opening: 'Some findings in your projects have been open longer than our limits. Please take a look this week.',
  button: 'Open my findings',
  signOff: 'Thanks,\nThe AppSec team',
  listProjects: true,
  attachReport: false,
};

export const REMINDER_PLACEHOLDERS = ['name', 'firstName', 'count', 'critical', 'high', 'oldestDays', 'projects', 'limit', 'company'];

const LOOK_NAMES = { cabin: 'Cabin', circuit: 'Circuit', residence: 'Residence', chronometer: 'Chronometer', signal: 'Signal', nextgen: 'Command center', studio: 'Studio', atelier: 'Atelier', classic: 'Classic' };
const HEX = /^#[0-9a-f]{6}$/i;
// Settings → Branding's colour until an Admin picks one.
const DEFAULT_BRAND_COLOUR = '#1d4ed8';
const LIMITS = { senderName: 80, headerText: 80, footer: 300, subject: 200, greeting: 120, opening: 2000, button: 60, signOff: 300 };

/** Admin input, checked: lengths capped, a logo an https image (or a data: one), a colour #rrggbb, a reply-to one address. */
export function mergeReminderEmail(current, incoming, { isSafeImageUrl = () => false, emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/ } = {}) {
  const out = { ...DEFAULT_REMINDER_EMAIL, ...(current ?? {}) };
  if (!incoming || typeof incoming !== 'object') return out;
  if (incoming.restore === true) return { ...DEFAULT_REMINDER_EMAIL };
  if ('style' in incoming) out.style = incoming.style === 'html' ? 'html' : 'simple';
  for (const [key, max] of Object.entries(LIMITS)) if (key in incoming) out[key] = String(incoming[key] ?? '').replace(/\r\n?/g, '\n').slice(0, max);
  for (const key of ['senderName', 'headerText', 'subject', 'greeting', 'button']) out[key] = out[key].replace(/\n/g, ' ');
  if ('replyTo' in incoming) {
    const address = String(incoming.replyTo ?? '').trim();
    if (address && !emailRe.test(address)) throw Object.assign(new Error('Reply-to: enter one email address, or tick "Same as the portal".'), { status: 400 });
    out.replyTo = address;
  }
  if ('logo' in incoming) out.logo = ['portal', 'custom', 'none'].includes(incoming.logo) ? incoming.logo : 'portal';
  if ('logoUrl' in incoming) {
    const url = String(incoming.logoUrl ?? '').trim();
    if (url && !isSafeImageUrl(url)) throw Object.assign(new Error('The reminder logo must be an https address of an image, or a pasted image.'), { status: 400 });
    out.logoUrl = url;
  }
  if ('color' in incoming) {
    const colour = String(incoming.color ?? '').trim();
    out.color = HEX.test(colour) ? colour.toLowerCase() : '';
  }
  if ('listProjects' in incoming) out.listProjects = incoming.listProjects !== false;
  if ('attachReport' in incoming) out.attachReport = incoming.attachReport === true;
  if (!out.subject.trim()) out.subject = DEFAULT_REMINDER_EMAIL.subject;
  return out;
}

/**
 * The portal's colours for the email's band and button, and what to call them: the brand colour an Admin
 * chose under Settings → Branding, else the look's own (Command center's navy; Classic's blue).
 */
export function portalColours(branding = {}) {
  const look = branding.look ?? 'nextgen';
  const chosen = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(branding.accentColor ?? '') && branding.accentColor.toLowerCase() !== DEFAULT_BRAND_COLOUR ? branding.accentColor : '';
  if (chosen) return { head: chosen, headInk: '#ffffff', button: chosen, buttonInk: '#ffffff', name: 'brand colour' };
  const palette = LOOK_PALETTES[look];
  if (palette) return { head: palette.head, headInk: palette.headInk, button: palette.light.button, buttonInk: palette.light.buttonInk, name: LOOK_NAMES[look] ?? look };
  const colour = look === 'classic' ? DEFAULT_BRAND_COLOUR : NEXTGEN_ACCENTS.indigo[0];
  return { head: colour, headInk: '#ffffff', button: colour, buttonInk: '#ffffff', name: LOOK_NAMES[look] ?? 'Command center' };
}

/** What the email's branding comes to: each field the email's own, else the portal's. */
export function effectiveBranding(email, settings) {
  const branding = settings.branding ?? {};
  const portal = portalColours(branding);
  const own = HEX.test(email.color ?? '') ? email.color : '';
  const company = branding.companyName || branding.appName || 'CxMissionZero';
  return {
    senderName: email.senderName || settings.smtp?.fromName || company,
    replyTo: email.replyTo || '',
    logoUrl: email.logo === 'none' ? '' : email.logo === 'custom' ? email.logoUrl : branding.logoUrl || '',
    logoHeight: Math.min(64, branding.logoHeight || 40),
    colours: own ? { head: own, headInk: '#ffffff', button: own, buttonInk: '#ffffff', name: own } : portal,
    footer: email.footer || [company, settings.smtp?.fromAddress].filter(Boolean).join(' · '),
    company,
    portalLook: portal.name,
  };
}

/** "ana.lopez@acme.io" or "ana_lopez" → "Ana Lopez"; nothing usable → ''. */
export function personName(initiator = '', email = '') {
  const base = String(initiator || email || '').split('@')[0];
  const words = base.split(/[._\-\s]+/).filter((w) => /^[\p{L}]/u.test(w));
  return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

/** The values a field's {{placeholders}} take, from the reminder's data (src/reminder.js buildTemplateData). */
export function placeholderValues(data, { initiator = '', email = '', company = '' } = {}) {
  const name = personName(initiator, email);
  const limits = [...new Set((data.crossedLimits ?? []).map((l) => l.days))].sort((a, b) => b - a);
  return {
    name: name || 'there',
    firstName: name.split(' ')[0] || 'there',
    count: data.totalRisks ?? 0,
    critical: data.criticalCount ?? 0,
    high: data.highCount ?? 0,
    oldestDays: data.maxAgeDays ?? 0,
    projects: data.projectCount ?? 0,
    limit: limits.length ? `${limits[0]} days` : '',
    company,
  };
}

const fill = (text, values) => render(String(text ?? ''), values, { escape: false });
const paragraphs = (text) => escapeHtml(text).split(/\n{2,}/).map((p) => p.replace(/\n/g, '<br>'));

/**
 * The finished email: subject, HTML and text. `data` is the reminder's (with `crossedLimits`, and each project's
 * critical/high counts and oldest age); `button` the address the button opens.
 */
export function buildBrandedReminder(data, email, settings, { initiator = '', to = '', buttonUrl = '', why = '' } = {}) {
  const brand = effectiveBranding(email, settings);
  const values = placeholderValues(data, { initiator, email: to, company: brand.company });
  const subject = fill(email.subject, values).replace(/\s+/g, ' ').trim();
  const greeting = fill(email.greeting, values).trim();
  const opening = fill(email.opening, values).trim();
  const buttonLabel = fill(email.button, values).trim();
  const signOff = fill(email.signOff, values).trim();
  const headerText = fill(email.headerText, values).trim();
  const c = brand.colours;
  const url = /^https?:\/\//i.test(buttonUrl) ? buttonUrl : '';
  const logo = /^(https:\/\/|data:image\/)/i.test(brand.logoUrl)
    ? `<img src="${escapeHtml(brand.logoUrl)}" alt="" height="${brand.logoHeight > 36 ? 36 : brand.logoHeight}" style="height:${Math.min(36, brand.logoHeight)}px;vertical-align:middle;margin-right:12px;border:0">`
    : '';
  const projects = data.projects ?? [];
  const cell = 'padding:8px 6px;border-bottom:1px solid #e6e2d8';
  const table = email.listProjects && projects.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">` +
      `<tr style="background:#f3f0e8"><th align="left" style="${cell}">Project</th><th align="right" style="${cell}">Critical</th><th align="right" style="${cell}">High</th><th align="right" style="${cell}">Oldest</th></tr>` +
      projects
        .map((p) => {
          const name = p.url ? `<a href="${escapeHtml(p.url)}" style="color:${c.button}">${escapeHtml(p.projectName)}</a>` : escapeHtml(p.projectName);
          return `<tr><td style="${cell}">${name}</td><td align="right" style="${cell};color:${p.critical ? '#b42318' : '#1f2330'};font-weight:${p.critical ? 600 : 400}">${p.critical ?? 0}</td><td align="right" style="${cell}">${p.high ?? 0}</td><td align="right" style="${cell}">${p.oldestDays ?? 0} d</td></tr>`;
        })
        .join('') +
      `</table>`
    : '';
  const action = url && buttonLabel
    ? `<p style="text-align:center;margin:20px 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:${c.button};color:${c.buttonInk};text-decoration:none;font-weight:600;padding:12px 22px;border-radius:6px">${escapeHtml(buttonLabel)}</a></p>`
    : '';
  const html =
    `<div style="background:#f3f0e8;padding:24px 12px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#1f2330">` +
    `<div style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #e6e2d8;border-radius:8px;overflow:hidden">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:${c.head};color:${c.headInk}"><tr>` +
    `<td style="padding:16px 20px;font-size:16px;font-weight:700">${logo}${escapeHtml(brand.senderName)}</td>` +
    `<td align="right" style="padding:16px 20px;font-size:12px;opacity:.85">${escapeHtml(headerText)}</td></tr></table>` +
    `<div style="padding:24px 20px;font-size:14px;line-height:1.6">` +
    (greeting ? `<p style="margin:0 0 14px">${escapeHtml(greeting)}</p>` : '') +
    paragraphs(opening).map((p) => `<p style="margin:0 0 14px">${p}</p>`).join('') +
    table +
    action +
    (signOff ? `<p style="margin:16px 0 0">${escapeHtml(signOff).replace(/\n/g, '<br>')}</p>` : '') +
    `</div>` +
    `<div style="padding:12px 20px;border-top:1px solid #e6e2d8;font-size:11px;color:#667085">${[brand.footer, why].filter(Boolean).map(escapeHtml).join(' · ')}</div>` +
    `</div></div>`;
  const text = [
    greeting,
    '',
    opening,
    '',
    ...(email.listProjects ? projects.map((p) => `- ${p.projectName}: ${p.critical ?? 0} critical, ${p.high ?? 0} high, oldest ${p.oldestDays ?? 0} days${p.url ? ` (${p.url})` : ''}`) : []),
    ...(url ? ['', `${buttonLabel}: ${url}`] : []),
    '',
    signOff,
    '',
    [brand.footer, why].filter(Boolean).join(' · '),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { subject, html, text, from: { name: brand.senderName, replyTo: brand.replyTo } };
}
