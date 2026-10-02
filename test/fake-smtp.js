// A minimal SMTP server for tests: answers a connection check (EHLO, QUIT)
// and accepts mail, keeping each message ({to: [addresses], raw}) in `messages`.
// `silent: true` accepts the connection but never greets, which is what a
// firewall black hole or a wrong port looks like: a timeout.
import net from 'node:net';

export function fakeSmtp({ silent = false } = {}) {
  const sockets = new Set();
  const messages = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    if (silent) return;
    let data = false;
    let pending = '';
    let message = null;
    socket.write('220 fake.smtp ESMTP ready\r\n');
    socket.on('data', (chunk) => {
      pending += chunk.toString();
      const lines = pending.split('\r\n');
      pending = lines.pop();
      for (const line of lines) {
        if (data) {
          if (line === '.') {
            data = false;
            messages.push(message);
            message = null;
            socket.write('250 queued\r\n');
          } else {
            message.raw += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
          }
          continue;
        }
        if (!line) continue;
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'MAIL') message = { to: [], raw: '' };
        if (verb === 'RCPT') message?.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250-fake.smtp\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (verb === 'AUTH') socket.write('235 ok\r\n');
        else if (verb === 'DATA') {
          data = true;
          socket.write('354 go ahead\r\n');
        } else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        messages,
        close: () => {
          for (const s of sockets) s.destroy();
          server.close();
        },
      }),
    );
  });
}

/** A message's text parts and attachments, decoded (base64 / quoted-printable). */
export function decodeMessage(raw) {
  const parts = [];
  const boundaries = [...raw.matchAll(/boundary="?([^";\r\n]+)"?/gi)].map((m) => m[1]);
  const chunks = boundaries.length ? raw.split(new RegExp(boundaries.map((b) => `--${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).join('|'))) : [raw];
  for (const chunk of chunks) {
    const split = chunk.indexOf('\r\n\r\n');
    if (split < 0) continue;
    const head = chunk.slice(0, split);
    let body = chunk.slice(split + 4);
    if (/multipart\//i.test(head)) continue;
    if (/content-transfer-encoding:\s*base64/i.test(head)) body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    else if (/content-transfer-encoding:\s*quoted-printable/i.test(head)) {
      body = Buffer.from(body.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
    }
    parts.push({ head, body, attachment: /content-disposition:\s*attachment/i.test(head) });
  }
  const subject = /^Subject: (.*(?:\r\n[ \t].*)*)/m.exec(raw)?.[1]?.replace(/\r\n[ \t]/g, ' ') ?? '';
  return { subject, parts, text: parts.filter((p) => !p.attachment).map((p) => p.body).join('\n'), attachments: parts.filter((p) => p.attachment).map((p) => p.body) };
}
