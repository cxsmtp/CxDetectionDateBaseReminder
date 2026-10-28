import nodemailer from 'nodemailer';

import { isVerified } from './settings.js';
import { explainSmtp, networkCode } from './troubleshoot.js';

/**
 * SMTP transport built from the administrator's own settings.
 *
 * Nothing is sent until a connection test has succeeded for exactly the
 * settings in force, which `isVerified()` decides by fingerprint.
 */

const GMAIL_HOSTS = /(^|\.)(gmail|googlemail)\.com$/i;

export class MailError extends Error {
  /** `help`: what went wrong and how to fix it (src/troubleshoot.js). */
  constructor(message, status = 400, help = null) {
    super(message);
    this.name = 'MailError';
    this.status = status;
    if (help) this.help = help;
  }
}

/**
 * The forms the mail password can take on the wire: as typed, as sent (Google's spaces taken
 * out), and base64 as AUTH LOGIN and AUTH PLAIN carry it. Shortest last, so a longer form is
 * never left half-replaced.
 */
function secretForms(smtp = {}) {
  const forms = new Set();
  const user = String(smtp.user ?? '');
  for (const pass of [String(smtp.password ?? ''), normalizePassword(smtp)]) {
    if (!pass) continue;
    forms.add(pass);
    forms.add(Buffer.from(pass).toString('base64'));
    forms.add(Buffer.from(`\u0000${user}\u0000${pass}`).toString('base64'));
  }
  return [...forms].filter((f) => f.length >= 3).sort((a, b) => b.length - a.length);
}

/** `value` with every form of the mail password replaced by "[hidden]" (strings, arrays and plain objects). */
export function redactSecrets(value, smtp = {}, forms = secretForms(smtp)) {
  if (!forms.length) return value;
  if (typeof value === 'string') return forms.reduce((text, form) => text.split(form).join('[hidden]'), value);
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, smtp, forms));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactSecrets(v, smtp, forms)]));
  }
  return value;
}

/**
 * A failed connection or send, with its explanation. The server's own answer is part of it,
 * so the password is taken out of both, whatever the server echoed back.
 */
const failed = (prefix, error, smtp, status) =>
  new MailError(redactSecrets(`${prefix}: ${friendly(error, smtp)}`, smtp), status, redactSecrets(explainSmtp(error, smtp), smtp));

/**
 * Certificate checks for the mail server are on unless an Admin turned them off ("Check the
 * mail server's certificate", SMTP_REJECT_UNAUTHORIZED=false): only an explicit `false` does.
 * The choice applies to this one connection, never to the rest of the server, and is said in
 * the server log once per mail server, so it is never silent.
 */
export const verifiesCertificate = (account = {}) => account.rejectUnauthorized !== false;

const warned = new Set();
export function warnUnverified(kind, account = {}, log = console.warn) {
  if (verifiesCertificate(account)) return;
  const where = `${String(account.host ?? '').replace(/[^\w.:[\]-]/g, '')}:${Number(account.port) || ''}`;
  if (warned.has(`${kind}|${where}`)) return;
  warned.add(`${kind}|${where}`);
  log(`! [mail] Certificate checks are off for the ${kind} ${where} (an Admin's choice: Settings → Email server → "Check the mail server's certificate"). Its identity is not verified; add its certificate authority under Trusted certificates and turn the check back on.`);
}

/**
 * Google shows an App Password as four space-separated groups ("abcd efgh ijkl
 * mnop"), so it is routinely pasted with the spaces still in it and rejected.
 * Google's own passwords never contain spaces, so stripping them for Google
 * hosts is safe -- and is not done for any other server, where a space could
 * be a legitimate part of the secret.
 */
export function normalizePassword(smtp) {
  const password = String(smtp.password ?? '');
  if (!GMAIL_HOSTS.test(String(smtp.host ?? ''))) return password;

  const stripped = password.replace(/\s+/g, '');
  return /^[A-Za-z0-9]{16}$/.test(stripped) ? stripped : password;
}

export function buildTransport(smtp) {
  if (!smtp.host) throw new MailError('No SMTP host is configured. Set one on the Settings page.', 400, explainSmtp(new Error('no host'), smtp));
  warnUnverified('mail server', smtp);

  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: Boolean(smtp.secure),
    // A login is never sent in clear: without TLS from the start, STARTTLS must be offered and taken.
    requireTLS: !smtp.secure && Boolean(smtp.requireAuth && smtp.user),
    auth: smtp.requireAuth && smtp.user ? { user: smtp.user, pass: normalizePassword(smtp) } : undefined,
    tls: { rejectUnauthorized: verifiesCertificate(smtp) },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
}

/** `"Name" <address>`, falling back to the auth user when no from is set. */
export function fromAddress(smtp) {
  const address = smtp.fromAddress || smtp.user;
  if (!address) return '';
  // No line breaks, quotes or angle brackets: nothing can end the header and start another.
  const clean = (value) => String(value).replace(/[\r\n"<>]/g, '').trim();
  return smtp.fromName ? `"${clean(smtp.fromName)}" <${clean(address)}>` : clean(address);
}

/** Ports that expect plaintext first and upgrade via STARTTLS. */
const STARTTLS_PORTS = new Set([25, 587, 2525]);
const IMPLICIT_TLS_PORT = 465;

/**
 * The single most common misconfiguration: implicit TLS against a port that
 * expects STARTTLS (or the reverse). The TLS handshake never completes, so the
 * failure surfaces as a timeout and reads like a firewall problem.
 */
export function tlsModeMismatch(smtp) {
  if (smtp.secure && STARTTLS_PORTS.has(Number(smtp.port))) {
    return (
      `Port ${smtp.port} expects STARTTLS, but "Implicit TLS" is on. ` +
      'Either turn Implicit TLS off, or use port 465.'
    );
  }
  if (!smtp.secure && Number(smtp.port) === IMPLICIT_TLS_PORT) {
    return (
      'Port 465 expects TLS from the first byte, but "Implicit TLS" is off. ' +
      'Either turn Implicit TLS on, or use port 587.'
    );
  }
  return '';
}

const friendly = (error, smtp = {}) => {
  const code = error.code ?? '';
  const mismatch = tlsModeMismatch(smtp);

  if (code === 'EAUTH') {
    if (GMAIL_HOSTS.test(String(smtp.host ?? ''))) {
      return (
        'Google rejected those credentials. Gmail does not accept your account ' +
        'password over SMTP: create a 16-character App Password at ' +
        'https://myaccount.google.com/apppasswords and paste that here. ' +
        'Check too that the username is the full address of the account the App ' +
        'Password belongs to.'
      );
    }
    // Neither the user name nor the host is repeated here: this text reaches logs and audit entries;
    // the troubleshooting card (explainSmtp) shows the settings to the Admin who is looking at them.
    return 'The server rejected that username and password.';
  }

  if (code === 'ECONNREFUSED' || networkCode(error) === 'ECONNREFUSED') {
    return `Nothing is listening on port ${Number(smtp.port) || ''} of the mail server.`;
  }

  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || /timed? ?out/i.test(error.message)) {
    // A TLS-mode mismatch stalls the handshake, so it arrives here rather than
    // as a TLS error. Name it instead of blaming the network.
    if (mismatch) return `${mismatch} (The connection stalled during the TLS handshake.)`;
    return 'Could not reach the server — check the host, port and any firewall.';
  }

  if (code === 'EDNS' || /getaddrinfo|ENOTFOUND/i.test(error.message)) {
    return 'The mail server name did not resolve: check the spelling and the DNS.';
  }

  if (/wrong version number|packet length too long|SSL routines/i.test(error.message)) {
    return mismatch || 'TLS negotiation failed — the server did not speak TLS the way this port expects.';
  }

  if (/self.signed|certificate/i.test(error.message)) {
    return (
      'The server presented a certificate that could not be verified. ' +
      'If it uses a private CA, turn off certificate verification.'
    );
  }

  return mismatch ? `${error.message} (${mismatch})` : error.message;
};

/**
 * Open a connection and run the SMTP handshake (plus auth, if configured)
 * without sending anything.
 */
export async function testConnection(smtp) {
  const transport = buildTransport(smtp);
  try {
    await transport.verify();
    return { ok: true, message: `Connected to ${smtp.host}:${smtp.port} and authenticated.` };
  } catch (error) {
    throw failed('SMTP test failed', error, smtp, 400);
  } finally {
    transport.close();
  }
}

/** Send a one-off message to prove delivery end to end. */
export async function sendTestEmail(smtp, to) {
  if (!to) throw new MailError('Enter an address to send the test message to.');
  const transport = buildTransport(smtp);

  try {
    const info = await transport.sendMail({
      from: fromAddress(smtp),
      to,
      subject: 'CxMissionZero — test message',
      text: 'This is a test message from CxMissionZero, the Checkmarx One reminder utility. SMTP is working.',
      html:
        '<p>This is a test message from <strong>CxMissionZero</strong>, the Checkmarx One reminder utility.</p>' +
        '<p>SMTP is working.</p>',
    });
    return { ok: true, messageId: info.messageId, accepted: info.accepted ?? [] };
  } catch (error) {
    throw failed('Test message failed', error, smtp, 400);
  } finally {
    transport.close();
  }
}

/**
 * Deliver a rendered reminder.
 *
 * @param {object} settings  Full settings, including the SMTP password.
 * @param {{subject: string, html: string, text: string}} message
 * @param {{to?: string[], cc?: string[], bcc?: string[], attachments?: object[]}} [overrides]
 */
/** Told about every failed send (for the troubleshooting log); never given the message or addresses. */
let onSendFailure = null;
export function onMailFailure(fn) {
  onSendFailure = fn;
}

export async function sendReminderMail(settings, message, overrides = {}) {
  if (!isVerified(settings)) {
    throw new MailError(
      'Test the SMTP connection on the Settings page before sending. ' +
        'Changing any connection detail clears a previous successful test.',
    );
  }

  // `exact` sends to the given addresses only, never the configured list.
  const pick = (kind) => (overrides.exact ? overrides[kind] ?? [] : overrides[kind]?.length ? overrides[kind] : settings.recipients[kind]);
  const to = pick('to');
  const cc = pick('cc');
  const bcc = pick('bcc');

  if (to.length + cc.length + bcc.length === 0) {
    throw new MailError('No recipients are configured. Add at least one on the Settings page.');
  }
  if (!fromAddress(settings.smtp)) {
    throw new MailError('No From address is configured. Set one on the Settings page.');
  }

  const transport = buildTransport(settings.smtp);
  try {
    const mailOptions = {
      // A sender name of its own (Act → Automation → Email), on the same From address.
      from: fromAddress(overrides.fromName ? { ...settings.smtp, fromName: overrides.fromName } : settings.smtp),
      ...(overrides.replyTo ? { replyTo: overrides.replyTo } : {}),
      to,
      cc,
      bcc,
      subject: message.subject,
      html: message.html,
      text: message.text,
    };

    if (overrides.attachments?.length) {
      mailOptions.attachments = overrides.attachments;
    }

    const info = await transport.sendMail(mailOptions);
    return {
      delivered: true,
      messageId: info.messageId,
      accepted: info.accepted ?? [],
      rejected: info.rejected ?? [],
      recipients: { to, cc, bcc },
    };
  } catch (error) {
    try {
      onSendFailure?.(error);
    } catch {
      /* never in the way of the real error */
    }
    throw failed('Sending failed', error, settings.smtp, 502);
  } finally {
    transport.close();
  }
}
