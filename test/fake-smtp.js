// A minimal SMTP server for tests: answers a connection check (EHLO, QUIT)
// and accepts mail. `silent: true` accepts the connection but never greets,
// which is what a firewall black hole or a wrong port looks like: a timeout.
import net from 'node:net';

export function fakeSmtp({ silent = false } = {}) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    if (silent) return;
    let data = false;
    socket.write('220 fake.smtp ESMTP ready\r\n');
    socket.on('data', (chunk) => {
      for (const line of chunk.toString().split('\r\n').filter(Boolean)) {
        if (data) {
          if (line === '.') {
            data = false;
            socket.write('250 queued\r\n');
          }
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
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
        close: () => {
          for (const s of sockets) s.destroy();
          server.close();
        },
      }),
    );
  });
}
