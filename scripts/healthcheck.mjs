// Container health check: is the server answering? Over https when it serves https
// itself (its own certificate is not checked here: this only asks "are you up").
import http from 'node:http';
import https from 'node:https';

const tls = Boolean(process.env.TLS_CERT_FILE || process.env.TLS_PFX_FILE || /^(1|true|yes|on)$/i.test(process.env.TLS_SELF_SIGNED ?? ''));
const request = (tls ? https : http).get(
  { host: '127.0.0.1', port: Number(process.env.PORT) || 3000, path: '/api/health', timeout: 4000, rejectUnauthorized: false },
  (res) => {
    res.resume();
    process.exit(res.statusCode === 200 ? 0 : 1);
  },
);
request.on('timeout', () => request.destroy(new Error('timeout')));
request.on('error', () => process.exit(1));
