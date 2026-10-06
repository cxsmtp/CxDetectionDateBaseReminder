/**
 * Get help: support cases and enhancement requests, each with a number
 * (SUP-0001, ENH-0001), a status, and a conversation between the person who
 * raised it and the support team (people with the support.manage permission).
 *
 * One file for the whole server (support.json in the state folder, in every
 * backup); each request remembers the Checkmarx One tenant it was raised in, so
 * the team of that tenant (and a Super Admin) is the one who sees it.
 */

import fs from 'node:fs';
import path from 'node:path';

export const KINDS = {
  case: { prefix: 'SUP', label: 'Support case' },
  enhancement: { prefix: 'ENH', label: 'Enhancement' },
};
export const STATUSES = {
  new: 'New',
  'in-progress': 'In progress',
  waiting: 'Waiting for reply',
  completed: 'Completed',
  declined: 'Declined',
};
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
export const LIMITS = { subject: 200, text: 10_000, messages: 500 };

const fail = (status, message) => Object.assign(new Error(message), { status });
const clean = (value, max) => String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
const person = (p) => ({ id: String(p?.id ?? ''), name: String(p?.name ?? ''), email: String(p?.email ?? '') });

export class SupportDesk {
  #file;
  #state;

  constructor({ file }) {
    this.#file = file;
    this.#state = this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
      const tickets = Array.isArray(raw.tickets) ? raw.tickets.filter((t) => t?.id && KINDS[t.kind]) : [];
      return { counters: { case: Number(raw.counters?.case) || 0, enhancement: Number(raw.counters?.enhancement) || 0 }, tickets };
    } catch {
      return { counters: { case: 0, enhancement: 0 }, tickets: [] };
    }
  }

  #save() {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.#state, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
  }

  /** Every request, newest first. */
  list() {
    return [...this.#state.tickets].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id) {
    return this.#state.tickets.find((t) => t.id === String(id ?? '').toUpperCase()) ?? null;
  }

  /** How many requests `requester` raised since `since` (to keep a runaway script from flooding the team). */
  raisedSince(requesterId, since) {
    return this.#state.tickets.filter((t) => t.requester.id === requesterId && t.createdAt >= since).length;
  }

  create({ kind, tenant, subject, text, priority = 'normal', requester, now = new Date() }) {
    if (!KINDS[kind]) throw fail(400, 'Choose a support case or an enhancement.');
    const title = clean(subject, LIMITS.subject);
    const body = clean(text, LIMITS.text);
    if (!title) throw fail(400, 'Give it a short title.');
    if (!body) throw fail(400, 'Describe what you need.');
    const at = now.toISOString();
    const n = ++this.#state.counters[kind];
    const ticket = {
      id: `${KINDS[kind].prefix}-${String(n).padStart(4, '0')}`,
      kind,
      tenant: String(tenant ?? ''),
      subject: title,
      priority: kind === 'case' && PRIORITIES.includes(priority) ? priority : kind === 'case' ? 'normal' : '',
      status: 'new',
      requester: person(requester),
      createdAt: at,
      updatedAt: at,
      messages: [{ at, by: person(requester), team: false, text: body }],
      history: [{ at, by: person(requester), status: 'new' }],
    };
    this.#state.tickets.push(ticket);
    this.#save();
    return ticket;
  }

  /**
   * A message in the conversation. When the person who raised it answers, a
   * request that was waiting for them, or closed, goes back to the team.
   */
  reply(id, { by, team, text, now = new Date() }) {
    const ticket = this.get(id);
    if (!ticket) throw fail(404, 'No such request.');
    const body = clean(text, LIMITS.text);
    if (!body) throw fail(400, 'Write a message first.');
    if (ticket.messages.length >= LIMITS.messages) throw fail(409, 'This conversation is full. Raise a new request that refers to this one.');
    const at = now.toISOString();
    ticket.messages.push({ at, by: person(by), team: Boolean(team), text: body });
    if (!team) {
      const next = ticket.status === 'waiting' ? 'in-progress' : ['completed', 'declined'].includes(ticket.status) ? 'new' : null;
      if (next) {
        ticket.status = next;
        ticket.history.push({ at, by: person(by), status: next });
      }
    }
    ticket.updatedAt = at;
    this.#save();
    return ticket;
  }

  /** The team moves a request on (New → In progress → Waiting for you → Completed, or Declined). */
  setStatus(id, status, { by, now = new Date() }) {
    const ticket = this.get(id);
    if (!ticket) throw fail(404, 'No such request.');
    if (!STATUSES[status]) throw fail(400, `Status must be one of: ${Object.keys(STATUSES).join(', ')}.`);
    if (ticket.status === status) return ticket;
    const at = now.toISOString();
    ticket.status = status;
    ticket.history.push({ at, by: person(by), status });
    ticket.updatedAt = at;
    this.#save();
    return ticket;
  }
}

/** The email about a request: to the person who raised it, or to the team. */
export function supportEmail(ticket, { event, to, appName = 'CxMissionZero', url = '', message = null }) {
  const kind = KINDS[ticket.kind].label;
  const status = STATUSES[ticket.status];
  const link = url ? `${url.replace(/\/$/, '')}/#/help/${ticket.id}` : '';
  const forTeam = to === 'team';
  const lines = {
    created: forTeam
      ? [`${ticket.requester.name || ticket.requester.email} raised ${kind.toLowerCase()} ${ticket.id}.`]
      : [`Thank you: your ${kind.toLowerCase()} is ${ticket.id}. Keep this number to follow it.`, 'The support team has been told and will answer here.'],
    message: forTeam
      ? [`${ticket.requester.name || ticket.requester.email} wrote on ${ticket.id}.`]
      : [`The support team answered on ${ticket.id}.`],
    status: [`${ticket.id} is now: ${status}.`],
  }[event];
  const subject = `[${ticket.id}] ${event === 'status' ? `${status}: ` : event === 'message' ? 'New message: ' : ''}${ticket.subject}`;
  const quoted = message ?? (event === 'created' ? ticket.messages[0]?.text : '');
  const facts = [
    ['Number', ticket.id],
    ['Type', kind],
    ['Status', status],
    ...(ticket.priority ? [['Priority', ticket.priority[0].toUpperCase() + ticket.priority.slice(1)]] : []),
    ['Raised by', `${ticket.requester.name ? `${ticket.requester.name} ` : ''}<${ticket.requester.email}>`],
  ];
  const text = [
    ...lines,
    '',
    ...facts.map(([k, v]) => `${k}: ${v}`),
    `Title: ${ticket.subject}`,
    ...(quoted ? ['', quoted] : []),
    ...(link ? ['', `Follow it, and answer, at ${link}`] : []),
  ].join('\n');
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;font-size:14px;line-height:1.5">
<div style="max-width:640px;margin:0 auto;padding:16px">
<p style="margin:0 0 4px;color:#64748b;font-size:12px">${esc(appName)} · ${esc(kind)}</p>
<h1 style="font-size:18px;margin:0 0 12px">${esc(ticket.id)} · ${esc(ticket.subject)}</h1>
${lines.map((l) => `<p style="margin:0 0 8px">${esc(l)}</p>`).join('')}
<table role="presentation" style="border-collapse:collapse;margin:8px 0 12px;font-size:13px">${facts.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#64748b">${esc(k)}</td><td style="padding:2px 0">${esc(v)}</td></tr>`).join('')}</table>
${quoted ? `<blockquote style="margin:0 0 12px;padding:8px 12px;border-left:3px solid #c7d2fe;background:#f8fafc;white-space:pre-wrap">${esc(quoted)}</blockquote>` : ''}
${link ? `<p style="margin:0"><a href="${esc(link)}">Follow it, and answer, in ${esc(appName)}</a></p>` : ''}
</div></body></html>`;
  return { subject, text, html };
}
