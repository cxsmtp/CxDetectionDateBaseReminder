// Through a company proxy: the address is checked, the way to Checkmarx One is checked step by
// step (proxy, tunnel, certificate, answer), and the server is started with Node's own proxy
// support so every fetch goes through it (src/network.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fakeCheckmarx, testProxy } from './fake-proxy.js';
import { activeProxy, bypasses, checkRoute, cleanProxy, openTunnel, proxyEnvironment, proxyWithAuth, requirements, requirementsText, saveNetwork } from '../src/network.js';

// The test proxies' passwords: made afresh on every run, never written in the code.
const fresh = (label) => `${label}-${randomBytes(12).toString('base64url')}`;
const PROXY_PASSWORD = fresh('proxy');

test('a proxy address is cleaned up, and anything else is refused with a reason', () => {
  assert.deepEqual(cleanProxy({ url: 'proxy.acme.local:8080', username: ' ana ', password: 'p w', noProxy: '.acme.local, 10.0.0.5;smtp.acme.local .acme.local' }), {
    url: 'http://proxy.acme.local:8080', username: 'ana', password: 'p w', noProxy: '.acme.local,10.0.0.5,smtp.acme.local',
  });
  assert.equal(cleanProxy({ url: 'https://proxy.acme.local' }).url, 'https://proxy.acme.local:443');
  assert.equal(cleanProxy({ url: 'http://10.1.2.3' }).url, 'http://10.1.2.3:80');
  assert.throws(() => cleanProxy({ url: 'socks5://proxy:1080' }), /SOCKS proxy is not supported/);
  assert.throws(() => cleanProxy({ url: 'http://ana:secret@proxy:8080' }), /in their own fields/);
  assert.throws(() => cleanProxy({ url: 'http://proxy:8080/path' }), /without a path/);
  assert.throws(() => cleanProxy({ url: 'proxy:8080', noProxy: 'a b"c' }), /Hosts that skip the proxy/);
  assert.equal(proxyWithAuth({ url: 'http://proxy:8080', username: 'ACME\\ana', password: 'p@ss:w/rd' }), 'http://ACME%5Cana:p%40ss%3Aw%2Frd@proxy:8080');
  assert.equal(proxyWithAuth({ url: 'http://proxy:8080', username: '' }), 'http://proxy:8080');
});

test('which hosts skip the proxy', () => {
  assert.ok(bypasses('localhost') && bypasses('127.0.0.1'), 'this machine always');
  assert.ok(bypasses('smtp.acme.local', '.acme.local') && bypasses('acme.local', '.acme.local') && bypasses('a.b.acme.local', '*.acme.local'));
  assert.ok(bypasses('10.0.0.5', '10.0.0.5') && bypasses('anything', '*'));
  assert.ok(!bypasses('ind.iam.checkmarx.net', '.acme.local,10.0.0.5'));
  assert.ok(!bypasses('notacme.local', '.acme.local'));
});

test('the server is started with the saved proxy, else the container\'s; nothing when there is none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'net-'));
  assert.deepEqual(proxyEnvironment(dir, {}), {});
  assert.equal(activeProxy(dir, {}), null);
  const fromContainer = proxyEnvironment(dir, { HTTPS_PROXY: 'http://corp-proxy:3128', NO_PROXY: '.acme.local' });
  assert.equal(fromContainer.NODE_USE_ENV_PROXY, '1', 'fetch follows it too');
  assert.equal(fromContainer.HTTPS_PROXY, 'http://corp-proxy:3128');
  assert.equal(fromContainer.NO_PROXY, 'localhost,127.0.0.1,::1,.acme.local');
  assert.equal(activeProxy(dir, { https_proxy: 'http://u:p@corp-proxy:3128' }).url, 'http://corp-proxy:3128', 'no password shown');

  saveNetwork(dir, { proxy: cleanProxy({ url: 'proxy.acme.local:8080', username: 'svc', password: PROXY_PASSWORD, noProxy: '.acme.local' }) });
  assert.equal(fs.statSync(path.join(dir, 'network.json')).mode & 0o777, 0o600);
  const saved = proxyEnvironment(dir, { HTTPS_PROXY: 'http://corp-proxy:3128' });
  assert.equal(saved.HTTPS_PROXY, `http://svc:${PROXY_PASSWORD}@proxy.acme.local:8080`, 'Settings win');
  assert.equal(saved.https_proxy, saved.HTTPS_PROXY, 'git, which reads the lower-case one, too');
  const shown = activeProxy(dir, {});
  assert.deepEqual([shown.url, shown.username, shown.source, shown.running], ['http://proxy.acme.local:8080', 'svc', 'settings', false]);
  assert.ok(!JSON.stringify(shown).includes(PROXY_PASSWORD));
  saveNetwork(dir, null);
  assert.deepEqual(proxyEnvironment(dir, {}), {});
});

test('the check says where the way to Checkmarx One stops: proxy, tunnel, certificate, answer', async () => {
  const cx = await fakeCheckmarx();
  const open = await testProxy({ user: 'svc', pass: PROXY_PASSWORD, refuse: ['blocked.checkmarx.test'] });
  try {
    const host = 'iam.checkmarx.test';
    const ok = await checkRoute({ proxy: `http://svc:${PROXY_PASSWORD}@127.0.0.1:${open.port}`, host, port: cx.port });
    assert.deepEqual(ok.steps.map((s) => [s.step, s.ok]), [['proxy', true], ['tunnel', true], ['certificate', false]], 'reached, but the certificate is not trusted here');
    assert.match(ok.steps[2].detail, /not trusted here \(DEPTH_ZERO_SELF_SIGNED_CERT\)/);
    assert.equal(open.seen.at(-1).target, `${host}:${cx.port}`);

    const noAuth = await checkRoute({ proxy: open.url, host, port: cx.port });
    assert.deepEqual(noAuth.steps.map((s) => [s.step, s.ok, s.status ?? 0]), [['proxy', true, 0], ['tunnel', false, 407]]);

    const refused = await checkRoute({ proxy: `http://svc:${PROXY_PASSWORD}@127.0.0.1:${open.port}`, host: 'blocked.checkmarx.test', port: cx.port });
    assert.deepEqual(refused.steps.map((s) => [s.step, s.ok, s.status ?? 0]), [['proxy', true, 0], ['tunnel', false, 403]]);

    const closed = await checkRoute({ proxy: 'http://127.0.0.1:1', host, port: cx.port, timeoutMs: 2000 });
    assert.deepEqual(closed.steps.map((s) => [s.step, s.ok]), [['proxy', false]]);
    assert.match(closed.steps[0].detail, /could not be reached: ECONNREFUSED/);

    const direct = await checkRoute({ host: '127.0.0.1', port: cx.port });
    assert.deepEqual(direct.steps.map((s) => s.step), ['tunnel', 'certificate'], 'without a proxy: straight to the host');

    const tunnel = await openTunnel(`http://svc:${PROXY_PASSWORD}@127.0.0.1:${open.port}`, host, cx.port);
    tunnel.destroy();
  } finally {
    cx.close();
    open.close();
  }
});

test('started with that environment, fetch and https go through the proxy, with its sign-in', async () => {
  const cx = await fakeCheckmarx();
  const proxy = await testProxy({ user: 'svc', pass: 'p@ss' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'net-'));
  saveNetwork(dir, { proxy: cleanProxy({ url: `127.0.0.1:${proxy.port}`, username: 'svc', password: 'p@ss' }) });
  // Only the environment the launcher builds (the test machine's own proxy variables left out).
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_proxy$/i.test(k)));
  // The child trusts the stand-in's own certificate (and checks it, name included), nothing more.
  const caFile = path.join(dir, 'fake-checkmarx.pem');
  fs.writeFileSync(caFile, cx.cert);
  const url = `https://iam.checkmarx.test:${cx.port}/auth`;
  const code = `fetch('${url}').then((r) => r.text()).then((t) => console.log('fetch', t), (e) => console.log('fetch failed', e.cause?.code || e.message));`;
  try {
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--no-warnings', '-e', code], { env: { ...base, ...proxyEnvironment(dir, base), NODE_EXTRA_CA_CERTS: caFile } });
      let text = '';
      child.stdout.on('data', (d) => (text += d));
      child.stderr.on('data', (d) => (text += d));
      child.on('exit', () => resolve(text.trim()));
    });
    assert.equal(out, 'fetch {"ok":true}');
    assert.equal(proxy.seen.length, 1);
    assert.equal(proxy.seen[0].target, `iam.checkmarx.test:${cx.port}`, 'the name went to the proxy: it resolves it, not this server');
  } finally {
    cx.close();
    proxy.close();
  }
});

test('the sheet for the network team lists every connection from the settings, with the proxy rule', () => {
  const rows = requirements({
    checkmarxOne: ['ind.iam.checkmarx.net', 'ind.ast.checkmarx.net'],
    smtp: { host: 'smtp.office365.com', port: 587 },
    git: [{ label: 'GitHub', host: 'api.github.com' }],
    letsEncrypt: true,
    updates: true,
    inboundPort: 443,
    proxy: { url: 'http://proxy.acme.local:8080' },
  });
  const hosts = rows.map((r) => `${r.direction} ${r.host}:${r.port} ${r.route}`);
  assert.ok(hosts.includes('In this server:443 Direct'));
  assert.ok(hosts.includes('Out ind.iam.checkmarx.net:443 Through the proxy'));
  assert.ok(hosts.includes('Out smtp.office365.com:587 Direct (mail does not go through a web proxy)'));
  assert.ok(hosts.includes('Out api.github.com:443 Through the proxy'));
  assert.ok(hosts.includes('In this server:80 Direct'), 'Let\'s Encrypt validation');
  const text = requirementsText(rows, { proxy: { url: 'http://proxy.acme.local:8080' } });
  assert.match(text, /through the proxy http:\/\/proxy\.acme\.local:8080/);
  assert.match(text, /Allow this server's IP address to ind\.iam\.checkmarx\.net and ind\.ast\.checkmarx\.net on port 443 \(HTTP CONNECT\)/);
  assert.match(text, /Without HTTPS inspection/);
  assert.match(text, /NTLM\/Kerberos/);
  const none = requirements({});
  assert.ok(none.some((r) => r.host === '<region>.iam.checkmarx.net'), 'before a key is given: the pattern');
  assert.ok(!none.some((r) => r.what === 'Email server'));
});
