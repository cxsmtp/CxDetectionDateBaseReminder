/**
 * Govern (beta): the alert feed and its deliveries (SPEC §4.4, B6, B20, B27, B28).
 *
 * An alert is raised once per dedupe key and kept in alerts.jsonl (the feed: newest 5,000 in memory, read state per
 * person). Each alert that meets a channel's minimum severity gets one outbox row for that channel — email through
 * MZ's own verified-TLS mailer, or a webhook — persisted with its attempts and next try, so a restart neither
 * forgets nor repeats a delivery, and a channel that works never re-sends because another failed. A worker drains
 * the outbox apart from the cycle; the cycle never waits for it.
 *
 * Webhook: POST of compact JSON, `X-MZ-Timestamp: <unix seconds>`, `X-MZ-Delivery: <id>` (for receiver-side
 * idempotency) and, with a secret, `X-MZ-Signature: sha256=<hex>` where hex = HMAC-SHA256(secret, timestamp + "." +
 * raw body). The address is checked (https only, never link-local or cloud metadata; outbound-url.js), its name
 * resolved once and every address checked, and the connection pinned to the checked address; redirects are not
 * followed; 10 s timeout.
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';

import { blockedHost, checkOutboundUrl } from '../outbound-url.js';
import { appendDurable, readJson, readJsonl, writeAtomic } from './store.js';

export const CATEGORIES = ['warning', 'enforcement', 'restoration', 'attribution', 'sync_error', 'request'];
export const RANK = { info: 0, warning: 1, error: 2, critical: 3 };
const KEEP = 5000;
const MAX_ATTEMPTS = 6;
const text = (v, max = 2000) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);
const LOOPBACK = (address) => /^(127\.|::1$|::ffff:127\.)/.test(address);

/** The signature of a webhook body: sha256=hex(HMAC(secret, ts + "." + rawBody)). */
export function signWebhook(secret, ts, rawBody) {
  return `sha256=${createHmac('sha256', Buffer.from(String(secret), 'utf8')).update(`${ts}.`).update(rawBody).digest('hex')}`;
}

/**
 * POST `rawBody` to a webhook address. Throws (status 400) on an address the server may not call, else
 * resolves { status }. Never follows a redirect; a non-2xx answer is an error.
 */
export async function postWebhook(url, rawBody, { secret = '', deliveryId = '', userAgent = 'CxMissionZero', timeoutMs = 10_000, allowLoopback = false, lookup = dns.promises.lookup } = {}) {
  checkOutboundUrl(url, { label: 'webhook address', allowLoopbackHttp: allowLoopback });
  const u = new URL(url);
  const host = u.hostname.replace(/^\[(.*)\]$/, '$1');
  const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await lookup(host, { all: true });
  if (!addresses.length) throw Object.assign(new Error('The webhook address does not resolve.'), { status: 400 });
  for (const a of addresses) {
    if (blockedHost(a.address)) throw Object.assign(new Error('The webhook address resolves to a link-local or cloud metadata address, which the server never calls.'), { status: 400 });
    if (!allowLoopback && LOOPBACK(a.address)) throw Object.assign(new Error('The webhook address resolves to this machine.'), { status: 400 });
  }
  const pinned = addresses[0];
  const ts = String(Math.floor(Date.now() / 1000));
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(rawBody),
    'User-Agent': userAgent,
    'X-MZ-Timestamp': ts,
    ...(deliveryId ? { 'X-MZ-Delivery': deliveryId } : {}),
    ...(secret ? { 'X-MZ-Signature': signWebhook(secret, ts, rawBody) } : {}),
  };
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        method: 'POST',
        hostname: host,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        headers,
        servername: net.isIP(host) ? undefined : host,
        // The checked address, and only it: a second DNS answer cannot move the request elsewhere.
        lookup: (_name, options, cb) => (options?.all ? cb(null, [{ address: pinned.address, family: pinned.family }]) : cb(null, pinned.address, pinned.family)),
        timeout: timeoutMs,
      },
      (res) => {
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > 65_536) res.destroy();
        });
        res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve({ status: res.statusCode }) : reject(Object.assign(new Error(`The webhook answered ${res.statusCode}.`), { status: res.statusCode }))));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error(`The webhook did not answer within ${Math.round(timeoutMs / 1000)} s.`), { status: 0 })));
    req.on('error', (error) => reject(Object.assign(new Error(`The webhook could not be reached: ${text(error.code || error.message, 120)}.`), { status: error.status ?? 0 })));
    req.end(rawBody);
  });
}

export class Notifier {
  #dir;
  #settings;
  #sendMail;
  #post;
  #meta;
  alerts = [];
  #byId = new Map();
  #dedupe = new Set();
  #reads = new Map();
  outbox = new Map();
  #outboxLines = 0;
  #alertLines = 0;
  #draining = null;

  /**
   * @param {object} p
   * @param {string} p.dir
   * @param {() => object} p.settings          Govern settings (notify.*)
   * @param {(message, to: string[]) => Promise} p.sendMail   MZ's mailer
   * @param {(url, rawBody, options) => Promise} [p.post]    postWebhook (tests may pass their own)
   * @param {() => object} [p.meta]             { tenant, version, allowLoopback }
   */
  constructor({ dir, settings, sendMail, post = postWebhook, meta = () => ({}) }) {
    this.#dir = dir;
    this.#settings = settings;
    this.#sendMail = sendMail;
    this.#post = post;
    this.#meta = meta;
    for (const a of readJsonl(this.#file('alerts.jsonl'))) {
      this.#alertLines += 1;
      if (!a?.id || this.#byId.has(a.id)) continue;
      this.alerts.push(a);
      this.#byId.set(a.id, a);
      if (a.dedupe) this.#dedupe.add(a.dedupe);
    }
    this.alerts = this.alerts.slice(-KEEP);
    const reads = readJson(this.#file('alert-reads.json'), {});
    for (const [user, r] of Object.entries(reads.users ?? {})) this.#reads.set(user, { all: String(r?.all ?? ''), ids: new Set(Array.isArray(r?.ids) ? r.ids.slice(-KEEP) : []) });
    for (const d of readJsonl(this.#file('outbox.jsonl'))) {
      this.#outboxLines += 1;
      if (d?.id) this.outbox.set(d.id, d);
    }
  }

  #file(name) {
    return path.join(this.#dir, name);
  }

  /**
   * Raise an alert once per `dedupe` key: { severity, category, title, body, entity, targetKey, dedupe, to }. `to`:
   * addresses this alert is emailed to whatever the channel settings (a requester told of a decision).
   * Returns the alert, or null when it was raised before.
   */
  raise({ severity = 'info', category = 'warning', title, body = '', entity = null, targetKey = '', dedupe = '', to = [] }, now = new Date()) {
    if (dedupe && this.#dedupe.has(dedupe)) return null;
    const alert = {
      id: randomUUID(),
      at: now.toISOString(),
      severity: RANK[severity] !== undefined ? severity : 'info',
      category: CATEGORIES.includes(category) ? category : 'warning',
      title: text(title, 256),
      body: text(body, 2000),
      entity: entity ? { type: text(entity.type, 20), id: text(entity.id, 200), label: text(entity.label, 300) } : null,
      targetKey: text(targetKey, 300),
      dedupe: text(dedupe, 300),
    };
    appendDurable(this.#file('alerts.jsonl'), JSON.stringify(alert));
    this.#alertLines += 1;
    this.alerts.push(alert);
    this.#byId.set(alert.id, alert);
    if (alert.dedupe) this.#dedupe.add(alert.dedupe);
    if (this.alerts.length > KEEP) {
      for (const old of this.alerts.splice(0, this.alerts.length - KEEP)) this.#byId.delete(old.id);
    }
    if (this.#alertLines > KEEP * 1.5) {
      writeAtomic(this.#file('alerts.jsonl'), this.alerts.map((a) => JSON.stringify(a)).join('\n') + '\n');
      this.#alertLines = this.alerts.length;
    }
    // One delivery per channel whose threshold the alert meets (B6): the threshold is applied here, once.
    const s = this.#settings().notify;
    const meets = (min) => RANK[alert.severity] >= RANK[min ?? 'warning'] && RANK[alert.severity] >= RANK[s.minSeverity ?? 'warning'];
    if (s.email.on && s.email.recipients.length && meets(s.email.minSeverity)) this.#enqueue(alert, 'email', s.email.recipients, now);
    if (s.webhook.on && s.webhook.url && meets(s.webhook.minSeverity)) this.#enqueue(alert, 'webhook', [], now);
    const direct = [...new Set((to ?? []).map((a) => String(a).toLowerCase()).filter((a) => a.includes('@')))].slice(0, 10);
    if (direct.length) this.#enqueue(alert, 'direct', direct, now);
    return alert;
  }

  #enqueue(alert, channel, to, now) {
    this.#putDelivery({ id: `${alert.id}:${channel}`, alertId: alert.id, channel, to, status: 'pending', attempts: 0, nextAttemptAt: now.toISOString(), lastError: '', sentAt: null });
  }

  #putDelivery(d) {
    appendDurable(this.#file('outbox.jsonl'), JSON.stringify(d));
    this.#outboxLines += 1;
    this.outbox.set(d.id, d);
    if (this.#outboxLines > 4000) this.#compactOutbox();
  }

  #compactOutbox(now = Date.now()) {
    for (const [id, d] of this.outbox) if (['sent', 'given_up'].includes(d.status) && now - Date.parse(d.sentAt ?? d.nextAttemptAt ?? 0) > 7 * 86_400_000) this.outbox.delete(id);
    writeAtomic(this.#file('outbox.jsonl'), [...this.outbox.values()].map((d) => JSON.stringify(d)).join('\n') + (this.outbox.size ? '\n' : ''));
    this.#outboxLines = this.outbox.size;
  }

  /** The delivery state of an alert, per channel (for the feed). */
  deliveryOf(alertId) {
    const out = {};
    for (const channel of ['email', 'webhook', 'direct']) {
      const d = this.outbox.get(`${alertId}:${channel}`);
      if (d) out[channel] = { status: d.status, attempts: d.attempts, lastError: d.lastError };
    }
    return out;
  }

  /** The webhook body of an alert: compact JSON. */
  webhookBody(alert, deliveryId) {
    const m = this.#meta();
    return JSON.stringify({ id: deliveryId, alertId: alert.id, created_at: alert.at, severity: alert.severity, category: alert.category, title: alert.title, body: alert.body, entity: alert.entity, tenant: m.tenant ?? '', source: { name: 'CxMissionZero', version: m.version ?? '' } });
  }

  /**
   * Deliver what is due, at most `max` per channel this turn (1 email/s, 5 webhooks/s at the worker's pace).
   * One turn at a time; never throws.
   */
  drain({ max = { email: 5, webhook: 10, direct: 5 }, now = Date.now() } = {}) {
    if (this.#draining) return this.#draining;
    this.#draining = this.#drain(max, now).finally(() => (this.#draining = null));
    return this.#draining;
  }

  async #drain(max, now) {
    const s = this.#settings().notify;
    const taken = { email: 0, webhook: 0, direct: 0 };
    const due = [...this.outbox.values()].filter((d) => ['pending', 'failed'].includes(d.status) && Date.parse(d.nextAttemptAt) <= now).sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt));
    let sent = 0;
    for (const d of due) {
      if (taken[d.channel] >= (max[d.channel] ?? 5)) continue;
      taken[d.channel] += 1;
      const alert = this.#byId.get(d.alertId);
      if (!alert) {
        this.#putDelivery({ ...d, status: 'given_up', lastError: 'The alert is no longer kept.' });
        continue;
      }
      try {
        if (d.channel === 'webhook') {
          if (!s.webhook.url) throw new Error('No webhook address is set.');
          await this.#post(s.webhook.url, this.webhookBody(alert, d.id), { secret: s.webhook.secret, deliveryId: d.id, userAgent: `CxMissionZero/${this.#meta().version ?? ''}`, allowLoopback: Boolean(this.#meta().allowLoopback) });
        } else {
          const subject = `[CxMissionZero Govern] ${alert.title}`.replace(/\s+/g, ' ').slice(0, 200);
          const lines = [alert.title, '', alert.body, '', ...(alert.entity ? [`${alert.entity.type}: ${alert.entity.label || alert.entity.id}`] : []), `Severity: ${alert.severity}`, `Raised: ${alert.at}`, ...(this.#meta().tenant ? [`Tenant: ${this.#meta().tenant}`] : [])];
          if (alert.category === 'enforcement') lines.push('', 'Restrictions are reversible: Govern → Restrictions & alerts → Restore.');
          await this.#sendMail({ subject, text: lines.join('\n'), html: `<pre style="font-family:inherit;white-space:pre-wrap">${lines.map(escapeHtml).join('\n')}</pre>` }, d.to);
        }
        this.#putDelivery({ ...d, status: 'sent', attempts: d.attempts + 1, sentAt: new Date().toISOString(), lastError: '' });
        sent += 1;
      } catch (error) {
        const attempts = d.attempts + 1;
        const given = attempts >= MAX_ATTEMPTS || error.status === 400;
        this.#putDelivery({ ...d, status: given ? 'given_up' : 'failed', attempts, lastError: text(error.message, 300), nextAttemptAt: new Date(Date.now() + 30_000 * 2 ** (attempts - 1)).toISOString() });
      }
    }
    return { sent };
  }

  /** How many deliveries are waiting, per channel. */
  backlog() {
    const out = { email: 0, webhook: 0, direct: 0 };
    for (const d of this.outbox.values()) if (['pending', 'failed'].includes(d.status)) out[d.channel] += 1;
    return out;
  }

  #isRead(user, alert) {
    const r = this.#reads.get(user);
    return Boolean(r && ((r.all && alert.at <= r.all) || r.ids.has(alert.id)));
  }

  /**
   * The feed for one person, newest first: filtered by category, severity (at least), unread, text; paged.
   * { total, unread, items: [alert + read + delivery] }.
   */
  feed(user, { category = '', severity = '', unread = false, q = '', offset = 0, limit = 100 } = {}) {
    const query = String(q ?? '').toLowerCase().slice(0, 200);
    const min = RANK[severity] ?? -1;
    const out = [];
    let unreadCount = 0;
    for (let i = this.alerts.length - 1; i >= 0; i -= 1) {
      const a = this.alerts[i];
      const read = this.#isRead(user, a);
      if (!read) unreadCount += 1;
      if (category && a.category !== category) continue;
      if (RANK[a.severity] < min) continue;
      if (unread && read) continue;
      if (query && !`${a.title} ${a.body} ${a.entity?.label ?? ''}`.toLowerCase().includes(query)) continue;
      out.push(a);
    }
    const page = out.slice(offset, offset + limit).map((a) => ({ ...a, read: this.#isRead(user, a), delivery: this.deliveryOf(a.id) }));
    return { total: out.length, unread: unreadCount, items: page };
  }

  unreadCount(user) {
    let n = 0;
    for (const a of this.alerts) if (!this.#isRead(user, a)) n += 1;
    return n;
  }

  /** Mark alerts read for one person: some by id, or all up to now. */
  markRead(user, { ids = [], all = false } = {}, now = new Date()) {
    const r = this.#reads.get(user) ?? { all: '', ids: new Set() };
    if (all) {
      r.all = now.toISOString();
      r.ids = new Set();
    } else for (const id of ids.slice(0, 1000)) if (this.#byId.has(String(id))) r.ids.add(String(id));
    if (r.ids.size > KEEP) r.ids = new Set([...r.ids].slice(-KEEP));
    this.#reads.set(user, r);
    writeAtomic(this.#file('alert-reads.json'), JSON.stringify({ users: Object.fromEntries([...this.#reads].map(([u, v]) => [u, { all: v.all, ids: [...v.ids] }])) }));
    return this.unreadCount(user);
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
