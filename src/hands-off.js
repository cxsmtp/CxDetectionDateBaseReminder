/**
 * Hands-off mode: MissionZero set up once with the wizard (Settings → Hands-off),
 * then left alone. It reminds developers on its schedule, emails a short status
 * once a week, and takes requests from those emails: a one-click link, or a reply
 * with one word (PAUSE, RESUME, RUN, STATUS, STOP, SOLVED). Nobody has to sign in.
 */

// No imports from settings.js: settings.js reads these defaults (a leaf module, like automation-config.js).
const EMAIL = /^(?=[^]{3,254}$)[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const addresses = (value) => [...new Set((Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/)).map((a) => String(a).trim().toLowerCase()).filter((a) => EMAIL.test(a)))];

export const DEFAULT_HANDS_OFF = {
  on: false,
  // Who gets the weekly status, and may steer MissionZero from it.
  statusTo: [],
  // 0 = Sunday … 6 = Saturday, and the hour (server time) it is sent.
  statusDay: 1,
  statusHour: 8,
  // Reminders and the status stop until then (ISO), from a link or a PAUSE reply.
  pausedUntil: '',
  // Read replies from the mailbox MissionZero sends from (IMAP).
  replies: false,
  imapHost: '',
  imapPort: 993,
  lastStatusAt: '',
};

const fail = (message) => Object.assign(new Error(message), { status: 400 });

/** Hands-off settings, checked. */
export function mergeHandsOff(current, incoming = null) {
  const out = { ...DEFAULT_HANDS_OFF, ...(current ?? {}) };
  out.statusTo = [...(out.statusTo ?? [])];
  if (!incoming) return out;
  if ('on' in incoming) out.on = incoming.on === true;
  if ('statusTo' in incoming) out.statusTo = addresses(incoming.statusTo).slice(0, 50);
  if ('statusDay' in incoming) {
    const day = Number(incoming.statusDay);
    if (!Number.isInteger(day) || day < 0 || day > 6) throw fail('Hands-off: choose a day of the week.');
    out.statusDay = day;
  }
  if ('statusHour' in incoming) {
    const hour = Number(incoming.statusHour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw fail('Hands-off: the hour must be from 0 to 23.');
    out.statusHour = hour;
  }
  if ('pausedUntil' in incoming) {
    const at = String(incoming.pausedUntil ?? '');
    out.pausedUntil = at && Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : '';
  }
  if ('replies' in incoming) out.replies = incoming.replies === true;
  if ('imapHost' in incoming) {
    const host = String(incoming.imapHost ?? '').trim();
    if (host && !/^[A-Za-z0-9.-]{1,253}$/.test(host)) throw fail('Hands-off: the mailbox server must be a host name, such as imap.company.com.');
    out.imapHost = host;
  }
  if ('imapPort' in incoming) {
    const port = Number(incoming.imapPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('Hands-off: the mailbox port must be from 1 to 65535.');
    out.imapPort = port;
  }
  if ('lastStatusAt' in incoming) out.lastStatusAt = String(incoming.lastStatusAt ?? '');
  return out;
}

/** Paused now? */
export const isPaused = (handsOff, now = Date.now()) => Boolean(handsOff?.pausedUntil) && Date.parse(handsOff.pausedUntil) > now;

/** Is this week's status due: its day and hour have come, and it has not gone out since? */
export function statusDue(handsOff, now = new Date()) {
  if (!handsOff?.on || !handsOff.statusTo?.length || isPaused(handsOff, now.getTime())) return false;
  const slot = new Date(now);
  slot.setHours(handsOff.statusHour, 0, 0, 0);
  slot.setDate(slot.getDate() - ((slot.getDay() - handsOff.statusDay + 7) % 7));
  if (slot > now) slot.setDate(slot.getDate() - 7);
  return !handsOff.lastStatusAt || Date.parse(handsOff.lastStatusAt) < slot.getTime();
}

/** The words a reply may start with, and what each does. */
export const COMMANDS = {
  pause: 'Pause reminders and the status (7 days, or "PAUSE 14")',
  resume: 'Resume after a pause',
  run: 'Send the reminders that are due now',
  status: 'Send me the status now',
  stop: 'Stop sending me the status',
  solved: 'Close the case this email is about',
};
const ALIASES = { close: 'solved', closed: 'solved', resolved: 'solved', fixed: 'solved', unsubscribe: 'stop', start: 'resume', continue: 'resume', report: 'status', now: 'run' };

/**
 * The command a reply asks for: its first word, above the quoted message.
 * { command, days } or null when the reply says nothing MissionZero understands.
 */
export function parseCommand(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // The quoted original starts: nothing below it is the person's own words.
    if (line.startsWith('>') || /^(On .+ wrote:|-----Original Message-----|From: )/i.test(line)) return null;
    const match = /^([A-Za-z]+)\b[\s:,-]*(\d{1,3})?/.exec(line);
    if (!match) return null;
    const word = match[1].toLowerCase();
    const command = COMMANDS[word] ? word : ALIASES[word];
    if (!command) return null;
    const days = command === 'pause' ? Math.min(90, Math.max(1, Number(match[2]) || 7)) : undefined;
    return { command, ...(days ? { days } : {}) };
  }
  return null;
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * An email MissionZero sends on its own: a few lines, facts, buttons that act
 * with one click, how to reply instead, and the reference that lets a reply act.
 * buttons: [{ label, url }]; facts: [[label, value]].
 */
export function systemEmail({ appName = 'CxMissionZero', subject, lines = [], facts = [], buttons = [], reference = '', replyHelp = true, footer = '' }) {
  const fullSubject = reference ? `${subject} [${reference}]` : subject;
  const help = replyHelp ? `Or reply to this email with one word: ${Object.keys(COMMANDS).filter((c) => c !== 'solved' || buttons.some((b) => /solved/i.test(b.label))).map((c) => c.toUpperCase()).join(', ')}.` : '';
  const text = [
    ...lines,
    ...(facts.length ? ['', ...facts.map(([k, v]) => `${k}: ${v}`)] : []),
    ...(buttons.length ? ['', ...buttons.map((b) => `${b.label}: ${b.url}`)] : []),
    ...(help ? ['', help] : []),
    ...(footer ? ['', footer] : []),
    ...(reference ? ['', `${appName} reference: ${reference}`] : []),
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;font-size:14px;line-height:1.5">
<div style="max-width:640px;margin:0 auto;padding:16px">
<p style="margin:0 0 4px;color:#64748b;font-size:12px">${esc(appName)}</p>
<h1 style="font-size:18px;margin:0 0 12px">${esc(subject)}</h1>
${lines.map((l) => `<p style="margin:0 0 8px">${esc(l)}</p>`).join('')}
${facts.length ? `<table role="presentation" style="border-collapse:collapse;margin:8px 0 12px;font-size:13px">${facts.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#64748b">${esc(k)}</td><td style="padding:2px 0">${esc(v)}</td></tr>`).join('')}</table>` : ''}
${buttons.length ? `<p style="margin:12px 0">${buttons.map((b) => `<a href="${esc(b.url)}" style="display:inline-block;margin:0 8px 8px 0;padding:8px 14px;border-radius:8px;background:#4f46e5;color:#fff;text-decoration:none;font-weight:600">${esc(b.label)}</a>`).join('')}</p>` : ''}
${help ? `<p style="margin:8px 0;color:#475467;font-size:13px">${esc(help)}</p>` : ''}
${footer ? `<p style="margin:8px 0;color:#475467;font-size:13px;white-space:pre-wrap">${esc(footer)}</p>` : ''}
${reference ? `<p style="margin:12px 0 0;color:#94a3b8;font-size:12px">${esc(appName)} reference: ${esc(reference)}</p>` : ''}
</div></body></html>`;
  return { subject: fullSubject, text, html };
}
