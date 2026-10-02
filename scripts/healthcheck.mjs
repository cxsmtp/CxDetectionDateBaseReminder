// Container health check: is the server answering? Over https when it serves https
// itself (its own certificate is not checked here: this only asks "are you up").
import http from 'node:http';
import https from 'node:https';

// The same rule as src/tls.js: HTTPS=off is plain http; HTTPS=on, a certificate, or a self-signed one is https.
const mode = String(process.env.HTTPS ?? '').trim().toLowerCase();
const tls = !/^(off|false|no|0)$/.test(mode) && Boolean(/^(on|true|yes|1)$/.test(mode) || process.env.TLS_CERT_FILE || process.env.TLS_PFX_FILE || /^(1|true|yes|on)$/i.test(process.env.TLS_SELF_SIGNED ?? ''));
const request = (tls ? https : http).get(
  { host: '127.0.0.1', port: Number(process.env.PORT) || 3000, path: '/api/health', timeout: 4000, rejectUnauthorized: false },
  (res) => {
    res.resume();
    process.exit(res.statusCode === 200 ? 0 : 1);
  },
);
request.on('timeout', () => request.destroy(new Error('timeout')));
request.on('error', () => process.exit(1));
