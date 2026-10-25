// Govern (beta): alerts once, an outbox per channel with persisted attempts, signed webhooks, read state per person.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { Notifier, postWebhook, signWebhook } from '../src/govern/notify.js';
import { DEFAULT_SETTINGS, cleanSettings } from '../src/govern/store.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'govern-notify-'));
const settingsWith = (notify) => cleanSettings({ notify }, DEFAULT_SETTINGS);

test('an alert is raised once per dedupe key, and a delivery made only for channels whose threshold it meets (B6)', async () => {
  const sent = [];
  const settings = settingsWith({ minSeverity: 'info', email: { on: true, recipients: ['ops@acme.io'], minSeverity: 'critical' }, webhook: { on: true, url: 'https://h.acme.io/x', minSeverity: 'warning' } });
  const n = new Notifier({ dir: dir(), settings: () => settings, sendMail: async (m, to) => sent.push({ m, to }), post: async (url, body) => sent.push({ url, body }) });
  assert.ok(n.raise({ severity: 'warning', title: 'Near', dedupe: 'warn:b:2026-10' }));
  assert.equal(n.raise({ severity: 'warning', title: 'Near', dedupe: 'warn:b:2026-10' }), null);
  const a = n.raise({ severity: 'critical', category: 'enforcement', title: 'Restricted', dedupe: 'x' });
  n.raise({ severity: 'info', title: 'Restored' });
  assert.deepEqual([...n.outbox.values()].map((d) => d.channel).sort(), ['email', 'webhook', 'webhook']);
  await n.drain();
  assert.equal(sent.length, 3);
  assert.deepEqual(n.deliveryOf(a.id), { email: { status: 'sent', attempts: 1, lastError: '' }, webhook: { status: 'sent', attempts: 1, lastError: '' } });
  assert.match(sent.find((s) => s.m).m.subject, /^\[CxMissionZero Govern\] Restricted/);
});

test('a failing channel is retried with back-off and never repeats the working one; attempts survive a restart', async () => {
  const d = dir();
  const settings = settingsWith({ minSeverity: 'info', email: { on: true, recipients: ['ops@acme.io'], minSeverity: 'info' }, webhook: { on: true, url: 'https://h.acme.io/x', minSeverity: 'info' } });
  let mails = 0;
  const n = new Notifier({ dir: d, settings: () => settings, sendMail: async () => (mails += 1), post: async () => { throw Object.assign(new Error('The webhook answered 500.'), { status: 500 }); } });
  const a = n.raise({ severity: 'error', title: 'Could not restrict' });
  await n.drain();
  await n.drain({ now: Date.now() + 10 * 60_000 });
  assert.equal(mails, 1, 'email sent once although the webhook failed twice');
  const reopened = new Notifier({ dir: d, settings: () => settings, sendMail: async () => {}, post: async () => {} });
  assert.deepEqual(reopened.deliveryOf(a.id).webhook.attempts, 2);
  assert.equal(reopened.deliveryOf(a.id).webhook.status, 'failed');
  assert.equal(reopened.backlog().webhook, 1);
  await reopened.drain({ now: Date.now() + 60 * 60_000 });
  assert.equal(reopened.deliveryOf(a.id).webhook.status, 'sent');
  // A requester told directly, whatever the channels.
  const b = reopened.raise({ severity: 'info', category: 'request', title: 'Approved', to: ['Uma@acme.io'] });
  assert.deepEqual(reopened.outbox.get(`${b.id}:direct`).to, ['uma@acme.io']);
});

test('read state is per person; the feed filters and pages on the server', () => {
  const n = new Notifier({ dir: dir(), settings: () => DEFAULT_SETTINGS, sendMail: async () => {} });
  const ids = [];
  for (let i = 0; i < 5; i += 1) ids.push(n.raise({ severity: i % 2 ? 'critical' : 'info', category: i % 2 ? 'enforcement' : 'restoration', title: `Alert ${i}`, entity: { type: 'user', id: 'u', label: i === 4 ? 'Grace' : 'Ada' } }).id);
  assert.equal(n.markRead('admin', { ids: [ids[0]] }), 4);
  assert.equal(n.unreadCount('champ'), 5);
  assert.equal(n.feed('admin', { category: 'enforcement' }).total, 2);
  assert.equal(n.feed('admin', { severity: 'critical' }).total, 2);
  assert.equal(n.feed('admin', { q: 'grace' }).items[0].title, 'Alert 4');
  assert.equal(n.feed('admin', { unread: true }).total, 4);
  assert.equal(n.feed('admin', { limit: 2 }).items.length, 2);
  assert.equal(n.markRead('admin', { all: true }), 0);
  assert.equal(n.unreadCount('champ'), 5);
});

test('webhooks: https only (loopback http in tests), never link-local; signed over timestamp.body; no redirect followed', async () => {
  await assert.rejects(postWebhook('http://hooks.acme.io/x', '{}'), { status: 400 });
  await assert.rejects(postWebhook('https://169.254.169.254/latest', '{}'), { status: 400 });
  await assert.rejects(postWebhook('https://evil.acme.io/', '{}', { lookup: async () => [{ address: '169.254.169.254', family: 4 }] }), /link-local/);
  await assert.rejects(postWebhook('https://local.acme.io/', '{}', { lookup: async () => [{ address: '127.0.0.1', family: 4 }] }), /this machine/);
  const got = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ headers: req.headers, body });
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: 'http://169.254.169.254/' });
        return res.end();
      }
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(postWebhook(`${url}/x`, '{}'), { status: 400 }, 'plain http only to this machine under tests');
    const body = JSON.stringify({ a: 1 });
    assert.equal((await postWebhook(`${url}/x`, body, { secret: 'k', deliveryId: 'd1', allowLoopback: true })).status, 200);
    const h = got[0].headers;
    assert.equal(h['x-mz-signature'], `sha256=${createHmac('sha256', 'k').update(`${h['x-mz-timestamp']}.${body}`).digest('hex')}`);
    assert.equal(h['x-mz-signature'], signWebhook('k', h['x-mz-timestamp'], body));
    assert.equal(h['x-mz-delivery'], 'd1');
    assert.equal(got[0].body, body);
    await assert.rejects(postWebhook(`${url}/redirect`, '{}', { allowLoopback: true }), /answered 302/);
    assert.equal(got.length, 2, 'the redirect was not followed');
    await postWebhook(`${url}/x`, '{}', { allowLoopback: true });
    assert.equal(got[2].headers['x-mz-signature'], undefined, 'no secret: not signed');
  } finally {
    server.close();
  }
});
