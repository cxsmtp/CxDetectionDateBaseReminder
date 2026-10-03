// Container health check: is the server answering? The mode can change on the Settings page
// (http, http and https side by side, https only) without a restart, so this asks over https
// first and falls back to plain http. The certificate is not checked: this only asks "are you up".
import http from 'node:http';
import https from 'node:https';

const port = Number(process.env.PORT) || 3000;
const ask = (client) =>
  new Promise((resolve) => {
    const request = client.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 4000, rejectUnauthorized: false }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => resolve(false));
  });

process.exit((await ask(https)) || (await ask(http)) ? 0 : 1);
