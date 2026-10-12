// A company proxy and a Checkmarx One stand-in for tests: CONNECT tunnels with an optional
// basic sign-in and refusals, and an HTTPS server whose certificate nobody trusts unless told.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { generateKeyPairSync } from 'node:crypto';

import { makeCertificate } from '../src/tls.js';

/** A forward proxy: CONNECT tunnels to 127.0.0.1 whatever the host, optional basic sign-in, optional refusals. */
export async function testProxy({ user = '', pass = '', refuse = [] } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => res.writeHead(405).end());
  server.on('connect', (req, socket, head) => {
    const auth = req.headers['proxy-authorization'] ?? '';
    seen.push({ target: req.url, auth });
    if (user && auth !== `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`) return socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n');
    if (refuse.some((h) => req.url.startsWith(h))) return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    const port = Number(req.url.slice(req.url.lastIndexOf(':') + 1));
    const upstream = net.connect(port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, port: server.address().port, seen, close: () => server.close() };
}

/** An HTTPS server for "iam.checkmarx.test", with a certificate nobody trusts unless told. */
export async function fakeCheckmarx() {
  const k = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const cert = makeCertificate({ subject: { cn: 'iam.checkmarx.test' }, names: ['iam.checkmarx.test'], publicKey: k.publicKey, signerKey: k.privateKey });
  const server = https.createServer({ cert, key: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) }, (req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, cert, close: () => server.close() };
}

