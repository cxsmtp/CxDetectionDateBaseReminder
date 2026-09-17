import nodemailer from 'nodemailer';

import { isVerified } from './settings.js';

/**
 * SMTP transport built from the administrator's own settings.
 *
 * Nothing is sent until a connection test has succeeded for exactly the
 * settings in force, which `isVerified()` decides by fingerprint.
 */

export class MailError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'MailError';
    this.status = status;
  }
}

export function buildTransport(smtp) {
  if (!smtp.host) throw new MailError('No SMTP host is configured. Set one on the Settings page.');

  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: Boolean(smtp.secure),
    auth: smtp.requireAuth && smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
    tls: { rejectUnauthorized: smtp.rejectUnauthorized !== false },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
}

/** `"Name" <address>`, falling back to the auth user when no from is set. */
export function fromAddress(smtp) {
  const address = smtp.fromAddress || smtp.user;
  if (!address) return '';
  return smtp.fromName ? `"${smtp.fromName.replace(/"/g, '')}" <${address}>` : address;
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

const GMAIL_HOSTS = /(^|\.)(gmail|googlemail)\.com$/i;

const friendly = (error, smtp = {}) => {
  const code = error.code ?? '';
  const mismatch = tlsModeMismatch(smtp);

  if (code === 'EAUTH') {
    if (GMAIL_HOSTS.test(String(smtp.host ?? ''))) {
      return (
        'Gmail rejected those credentials. With 2-step verification enabled, Gmail ' +
        'requires a 16-character App Password here, not your account password.'
      );
    }
    return 'The server rejected those credentials.';
  }

  if (code === 'ECONNREFUSED') {
    return `Nothing is listening on ${smtp.host}:${smtp.port}.`;
  }

  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || /timed? ?out/i.test(error.message)) {
    // A TLS-mode mismatch stalls the handshake, so it arrives here rather than
    // as a TLS error. Name it instead of blaming the network.
    if (mismatch) return `${mismatch} (The connection stalled during the TLS handshake.)`;
    return 'Could not reach the server — check the host, port and any firewall.';
  }

  if (code === 'EDNS' || /getaddrinfo|ENOTFOUND/i.test(error.message)) {
    return `That hostname did not resolve: ${smtp.host}`;
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
    throw new MailError(`SMTP test failed: ${friendly(error, smtp)}`, 400);
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
      subject: 'Checkmarx reminder utility — test message',
      text: 'This is a test message from the Checkmarx detection-date reminder utility. SMTP is working.',
      html:
        '<p>This is a test message from the <strong>Checkmarx detection-date reminder</strong> utility.</p>' +
        '<p>SMTP is working.</p>',
    });
    return { ok: true, messageId: info.messageId, accepted: info.accepted ?? [] };
  } catch (error) {
    throw new MailError(`Test message failed: ${friendly(error, smtp)}`, 400);
  } finally {
    transport.close();
  }
}

/**
 * Deliver a rendered reminder.
 *
 * @param {object} settings  Full settings, including the SMTP password.
 * @param {{subject: string, html: string, text: string}} message
 * @param {{to?: string[], cc?: string[], bcc?: string[]}} [overrides]
 */
export async function sendReminderMail(settings, message, overrides = {}) {
  if (!isVerified(settings)) {
    throw new MailError(
      'Test the SMTP connection on the Settings page before sending. ' +
        'Changing any connection detail clears a previous successful test.',
    );
  }

  const to = overrides.to?.length ? overrides.to : settings.recipients.to;
  const cc = overrides.cc?.length ? overrides.cc : settings.recipients.cc;
  const bcc = overrides.bcc?.length ? overrides.bcc : settings.recipients.bcc;

  if (to.length + cc.length + bcc.length === 0) {
    throw new MailError('No recipients are configured. Add at least one on the Settings page.');
  }
  if (!fromAddress(settings.smtp)) {
    throw new MailError('No From address is configured. Set one on the Settings page.');
  }

  const transport = buildTransport(settings.smtp);
  try {
    const info = await transport.sendMail({
      from: fromAddress(settings.smtp),
      to,
      cc,
      bcc,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    return {
      delivered: true,
      messageId: info.messageId,
      accepted: info.accepted ?? [],
      rejected: info.rejected ?? [],
      recipients: { to, cc, bcc },
    };
  } catch (error) {
    throw new MailError(`Sending failed: ${friendly(error, settings.smtp)}`, 502);
  } finally {
    transport.close();
  }
}
