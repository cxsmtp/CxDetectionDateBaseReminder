/**
 * Govern (beta): credit requests (DESIGN A, tab 3).
 *
 * Anyone holding govern.request asks for credits for themselves, or for a project, group or application: how many,
 * until when (the end of the period, or a date), and why. Those holding govern.approve approve (the amount asked or
 * less; a temporary top-up with an expiry, or a permanent raise of the budget), deny with a reason, or ask a
 * question (a thread both sides write in). An open request expires after the configured days. Approval only changes
 * the budget: the next evaluation releases a restriction if usage is now under it (never a Checkmarx One call
 * inside the request).
 */
import { randomUUID } from 'node:crypto';

import { ENTITY_TYPES, cleanAmount, cleanId, cleanText, fail } from './store.js';

export const STATUSES = ['open', 'approved', 'denied', 'expired', 'cancelled'];
const MAX_THREAD = 50;

/** A new request from `input` by `by` ({ email, name }). `self`: the requester's own Checkmarx One user id, for type 'user'. */
export function createRequest(input = {}, { by, self = null, label = '', now = new Date() }) {
  const type = String(input.entityType ?? 'user');
  if (!ENTITY_TYPES.includes(type)) throw fail(400, 'Ask for yourself, a project, a group or an application.');
  let entityId;
  if (type === 'user') {
    if (!self) throw fail(400, 'Your email address is not a Checkmarx One user here, so credits cannot be asked for you.');
    if (input.entityId && String(input.entityId) !== self) throw fail(403, 'You can only ask credits for yourself, or for a project, group or application.');
    entityId = self;
  } else entityId = cleanId(input.entityId, { label: 'entity id' });
  const amount = cleanAmount(input.amount, 'The amount asked');
  if (amount <= 0) throw fail(400, 'Ask for at least some credits.');
  let until = 'period';
  if (input.until && input.until !== 'period') {
    const t = Date.parse(String(input.until));
    if (!Number.isFinite(t) || t <= now.getTime()) throw fail(400, 'Until is "period" or a date in the future.');
    until = new Date(t).toISOString();
  }
  const reason = cleanText(input.reason, 2000);
  if (!reason) throw fail(400, 'Say why the credits are needed.');
  return {
    id: randomUUID(),
    status: 'open',
    by: String(by.email ?? '').toLowerCase().slice(0, 254),
    byName: cleanText(by.name, 200),
    entityType: type,
    entityId,
    entityLabel: cleanText(label, 300),
    amount,
    until,
    reason,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    decidedAt: null,
    decidedBy: null,
    approvedAmount: null,
    permanent: null,
    expiresAt: null,
    denyReason: '',
    budgetId: null,
    topUpId: null,
    thread: [],
  };
}

/**
 * Approve: raise the budget by `amount` (≤ the amount asked), as a top-up until `expiresAt` (default: the request's
 * own "until", or the end of the period) or, with `permanent`, the budget's own amount. Mutates and returns
 * { request, budget } (copies); the caller saves both.
 */
export function approveRequest(request, budget, { amount, permanent = false, expiresAt = null, periodEnd = null, by, note = '', now = new Date() }) {
  if (request.status !== 'open') throw fail(409, `This request is already ${request.status}.`);
  if (!budget) throw fail(409, `There is no budget for this ${request.entityType}: nothing limits it, so there is nothing to raise.`);
  const approved = amount === undefined || amount === null || amount === '' ? request.amount : cleanAmount(amount, 'The amount approved');
  if (approved <= 0) throw fail(400, 'Approve at least some credits, or deny the request.');
  if (approved > request.amount) throw fail(400, `At most the ${request.amount} credits asked.`);
  let until = null;
  if (!permanent) {
    const asked = expiresAt ?? (request.until !== 'period' ? request.until : periodEnd);
    if (asked) {
      const t = Date.parse(String(asked));
      if (!Number.isFinite(t) || t <= now.getTime()) throw fail(400, 'The top-up must end in the future.');
      until = new Date(t).toISOString();
    }
  }
  const b = { ...budget, topUps: [...(budget.topUps ?? [])] };
  const topUpId = randomUUID();
  if (permanent) b.amount = Math.round((Number(b.amount) + approved) * 10000) / 10000;
  else b.topUps.push({ id: topUpId, amount: approved, until, requestId: request.id, by, at: now.toISOString() });
  b.topUps = b.topUps.filter((t) => !t.until || Date.parse(t.until) > now.getTime()).slice(-50);
  const r = { ...request, thread: [...request.thread], status: 'approved', decidedAt: now.toISOString(), decidedBy: by, approvedAmount: approved, permanent: Boolean(permanent), expiresAt: until, budgetId: budget.id, topUpId: permanent ? null : topUpId, updatedAt: now.toISOString() };
  if (note) r.thread.push({ by, at: now.toISOString(), text: cleanText(note, 2000) });
  return { request: r, budget: b };
}

export function denyRequest(request, { reason, by, now = new Date() }) {
  if (request.status !== 'open') throw fail(409, `This request is already ${request.status}.`);
  const why = cleanText(reason, 2000);
  if (!why) throw fail(400, 'Say why the request is denied.');
  return { ...request, status: 'denied', denyReason: why, decidedAt: now.toISOString(), decidedBy: by, updatedAt: now.toISOString() };
}

/** A message in the request's thread (a question, or its answer). */
export function commentRequest(request, { text, by, now = new Date() }) {
  const body = cleanText(text, 2000);
  if (!body) throw fail(400, 'Write something.');
  if (request.thread.length >= MAX_THREAD) throw fail(409, 'This thread is full.');
  return { ...request, thread: [...request.thread, { by, at: now.toISOString(), text: body }], updatedAt: now.toISOString() };
}

export function cancelRequest(request, { by, now = new Date() }) {
  if (request.status !== 'open') throw fail(409, `This request is already ${request.status}.`);
  return { ...request, status: 'cancelled', decidedAt: now.toISOString(), decidedBy: by, updatedAt: now.toISOString() };
}

/** Open requests older than `days` expire; returns the ones that did (copies). */
export function expireRequests(requests, { days = 14, now = new Date() }) {
  const out = [];
  for (const r of requests.values()) {
    if (r.status === 'open' && now.getTime() - Date.parse(r.createdAt) > days * 86_400_000) out.push({ ...r, status: 'expired', decidedAt: now.toISOString(), decidedBy: 'Govern', updatedAt: now.toISOString() });
  }
  return out;
}

/** How long a request has waited (for the "waiting 2 h" SLA chip), in minutes. */
export const waitingMinutes = (r, now = Date.now()) => (r.status === 'open' ? Math.max(0, Math.round((now - Date.parse(r.createdAt)) / 60_000)) : null);
