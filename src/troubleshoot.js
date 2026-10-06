/**
 * What went wrong, and how to put it right: a connection error (the mail server,
 * Checkmarx One, a git host) or a .env file, turned into one plain sentence and
 * the steps that fix it, instead of a raw error to guess from.
 *
 *   { topic, code, problem, steps: [...], facts: [[label, value]...] }
 *
 * `problem` and `steps` are fixed sentences (so the page can translate them);
 * what differs each time (the host, the port, the server's own answer) is in
 * `facts`. Secrets are never put in either.
 */

const GMAIL = /(^|\.)(gmail|googlemail)\.com$/i;
const MICROSOFT = /(^|\.)(office365\.com|outlook\.com|hotmail\.com|live\.com)$/i;
const STARTTLS_PORTS = new Set([25, 587, 2525]);
/** Implicit TLS on a STARTTLS port, or the reverse (the same rule as the mailer's). */
const tlsModeMismatch = (smtp) => (smtp.secure ? STARTTLS_PORTS.has(Number(smtp.port)) : Number(smtp.port) === 465);

const help = (topic, code, problem, steps, facts = []) => ({ topic, code, problem, steps, facts: facts.filter(([, v]) => v !== '' && v != null) });
const clip = (text, n = 300) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** The network error code under an error (DNS, refused, timeout, certificate), if any. */
export function networkCode(error) {
  for (let e = error, depth = 0; e && depth < 4; e = e.cause, depth += 1) {
    const code = e.networkCode || e.code;
    // Mail errors carry a general code (ESOCKET, EDNS…): the specific one is then in the message.
    if (typeof code === 'string' && /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_[A-Z_]+|CERT_[A-Z_]+|UNABLE_TO_[A-Z_]+|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_[A-Z_]+)$/.test(code)) return code;
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'TimeoutError';
  }
  const text = String(error?.message ?? '');
  if (/ENOTFOUND|host name not found|getaddrinfo/i.test(text)) return 'ENOTFOUND';
  if (/EAI_AGAIN|DNS lookup failed temporarily/i.test(text)) return 'EAI_AGAIN';
  if (/ECONNREFUSED|connection refused/i.test(text)) return 'ECONNREFUSED';
  if (/EHOSTUNREACH|ENETUNREACH|no route to host|network is unreachable/i.test(text)) return 'EHOSTUNREACH';
  if (/ECONNRESET|connection reset|socket hang up|closed unexpectedly/i.test(text)) return 'ECONNRESET';
  if (/certificate expired|CERT_HAS_EXPIRED/i.test(text)) return 'CERT_HAS_EXPIRED';
  if (/altname|Hostname\/IP does not match/i.test(text)) return 'ERR_TLS_CERT_ALTNAME_INVALID';
  if (/self.signed|not trusted|unable to verify|unable to get local issuer/i.test(text)) return 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
  if (/timed? ?out|ETIMEDOUT|no answer within|did not answer within/i.test(text)) return 'ETIMEDOUT';
  return '';
}

const isTimeout = (code) => ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'TimeoutError', 'AbortError', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code);
const isUntrusted = (code) => ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT'].includes(code);

// ---------------------------------------------------------------------------
// The mail server (SMTP)
// ---------------------------------------------------------------------------

/**
 * Why the mail server test (or a send) failed, and what to do.
 * smtp: the settings tried (the password is only looked at, never shown).
 */
export function explainSmtp(error, smtp = {}) {
  const host = String(smtp.host ?? '').trim();
  const port = Number(smtp.port);
  const answer = clip(error?.response || '');
  const text = `${error?.message ?? ''} ${answer}`;
  const code = error?.code ?? '';
  const net = networkCode(error);
  const mismatch = tlsModeMismatch(smtp);
  const facts = [
    ['Server', host ? `${host}:${smtp.port ?? ''}` : ''],
    ['TLS', smtp.secure ? 'implicit TLS (SMTP_SECURE=true)' : 'STARTTLS (SMTP_SECURE=false)'],
    ['Signs in as', smtp.requireAuth ? smtp.user || '(no username)' : '(no sign-in)'],
    ['Server answer', answer || clip(error?.message)],
  ];
  const H = (c, problem, steps) => help('smtp', c, problem, steps, facts);

  if (!host) {
    return H('smtp.no-host', 'No mail server is set.', [
      'Enter the mail server name under Settings → Email server, or set SMTP_HOST in the .env file.',
      'Office 365: smtp.office365.com, port 587. Gmail: smtp.gmail.com, port 587. Leave "Secure connection from the start" off for port 587.',
    ]);
  }
  if (/^[a-z]+:\/\//i.test(host) || /[\s/]/.test(host) || /:\d+$/.test(host)) {
    return H('smtp.host-format', 'The mail server name is not a plain host name.', [
      'Enter only the name, for example smtp.office365.com: no smtp:// or https:// in front, no port and no path after it.',
      'Put the port in its own field (SMTP_PORT in the .env file).',
    ]);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return H('smtp.port', 'The port is not a valid number.', [
      'Use 587 for STARTTLS (most servers, Office 365, Gmail), 465 for implicit TLS, or 25 for an internal relay.',
    ]);
  }
  if (/Missing credentials/i.test(text) || (smtp.requireAuth && !smtp.user && !net)) {
    return H('smtp.no-credentials', 'The server needs a username and password, and one of them is empty.', [
      'Enter the username (usually the full email address of the sending mailbox) and its password.',
      'In a .env file: SMTP_USER and SMTP_PASS. A blank value keeps what is set now, so a password never set stays empty.',
      'If the server is an internal relay that accepts mail without signing in, turn off "Server needs a user name and password" (SMTP_REQUIRE_AUTH=false).',
    ]);
  }
  if (net === 'ENOTFOUND') {
    return H('smtp.dns', 'The mail server name could not be found (DNS).', [
      'Check the spelling of the server name.',
      'An internal name must be resolvable from where MissionZero runs: inside a container, use the full name (for example mail.company.local) or the IP address.',
      'Test it from the server: nslookup followed by the server name.',
    ]);
  }
  if (net === 'EAI_AGAIN') {
    return H('smtp.dns-temporary', 'The name server did not answer when looking up the mail server.', [
      'Try again in a minute.',
      'If it keeps failing, the container or server has no working DNS: check its network settings.',
    ]);
  }
  if (net === 'ECONNREFUSED') {
    return H('smtp.refused', 'The mail server refused the connection on this port.', [
      'Check the port: 587 (STARTTLS) or 465 (implicit TLS) for most providers, 25 for an internal relay.',
      'Check that the mail service is running on that server, and that its firewall allows connections from MissionZero.',
      'Inside a container, localhost is the container itself: use the mail server\'s name or IP address instead.',
    ]);
  }
  if (/wrong version number|packet length too long|SSL routines|unknown protocol|EPROTO/i.test(text) || code === 'EPROTO') {
    return H('smtp.tls-mode', '"Secure connection from the start" does not match the port.', mismatch ? tlsSteps(port) : [
      'Port 465 needs "Secure connection from the start" on (SMTP_SECURE=true). Ports 587, 25 and 2525 need it off (SMTP_SECURE=false).',
      'If the port and setting already match, the server does not speak TLS on this port: ask its administrator which port to use.',
    ]);
  }
  if (net === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return H('smtp.cert-name', 'The mail server\'s certificate is for a different name than the one entered.', [
      'Enter the server name exactly as it is on its certificate (for example smtp.office365.com, not an IP address or an alias).',
      'For an internal relay addressed by IP, ask for its certificate name, or turn off "Check the mail server\'s certificate" for that relay only.',
    ]);
  }
  if (net === 'CERT_HAS_EXPIRED') {
    return H('smtp.cert-expired', 'The mail server\'s certificate has expired.', [
      'Ask the mail server\'s administrator to renew its certificate.',
      'Until then, an internal relay can be used with "Check the mail server\'s certificate" turned off (SMTP_REJECT_UNAUTHORIZED=false).',
    ]);
  }
  if (isUntrusted(net) || /self.signed|certificate/i.test(text)) {
    return H('smtp.cert-untrusted', 'The mail server\'s certificate is not trusted.', [
      'If your company inspects TLS traffic or uses its own certificate authority, give MissionZero that CA certificate: NODE_EXTRA_CA_CERTS=/certs/company-ca.pem, with the folder mounted into the container.',
      'For an internal relay with a self-signed certificate, turn off "Check the mail server\'s certificate" (SMTP_REJECT_UNAUTHORIZED=false).',
    ]);
  }
  if (/Greeting never received/i.test(text)) {
    return H('smtp.greeting', 'Something answered on this port, but not a mail server.', mismatch ? tlsSteps(port) : [
      'Check the port: 587 or 465 for most providers. Ports such as 993 (IMAP) or 443 (web) are not for sending mail.',
      'Check "Secure connection from the start": on for port 465, off for 587, 25 and 2525.',
    ]);
  }
  if (isTimeout(net) || code === 'ESOCKET' || code === 'ETIMEDOUT' || error?.timedOut) {
    if (mismatch) return H('smtp.tls-mode', '"Secure connection from the start" does not match the port, so the connection stalled.', tlsSteps(port));
    if (port === 25) {
      return H('smtp.port25-blocked', 'No answer on port 25, which many networks and cloud providers block.', [
        'Use port 587 with STARTTLS if your mail server offers it.',
        'Otherwise ask your network team to allow outgoing connections from MissionZero to the mail server on port 25.',
      ]);
    }
    return H('smtp.timeout', 'The mail server did not answer in time.', [
      'Check the server name and port.',
      'Ask your network team to allow outgoing connections from MissionZero to the mail server on this port. MissionZero does not use a web proxy for mail.',
      'Test it from the server: Test-NetConnection with the server name and -Port, or telnet with the server name and port.',
    ]);
  }
  if (net === 'ECONNRESET') {
    if (mismatch) return H('smtp.tls-mode', '"Secure connection from the start" does not match the port.', tlsSteps(port));
    return H('smtp.reset', 'The mail server closed the connection.', [
      'Check "Secure connection from the start": on for port 465, off for 587, 25 and 2525.',
      'The server may only accept connections from known addresses: ask its administrator to allow the address MissionZero sends from.',
    ]);
  }
  if (/must issue a STARTTLS|STARTTLS is required|5\.7\.0 .*TLS/i.test(text)) {
    return H('smtp.starttls-required', 'The mail server only accepts a sign-in over an encrypted connection.', [
      'Use port 587 with "Secure connection from the start" off (it upgrades with STARTTLS), or port 465 with it on.',
    ]);
  }

  // Signing in
  if (code === 'EAUTH' || /^5\d\d/.test(String(error?.responseCode ?? '')) && /auth/i.test(text)) {
    if (/SmtpClientAuthentication is disabled|5\.7\.139|basic authentication is disabled|security defaults/i.test(text)) {
      return H('smtp.microsoft-auth-off', 'Microsoft 365 refused the sign-in: SMTP sign-in (SMTP AUTH) is turned off for this mailbox or for your organisation.', [
        'In the Microsoft 365 admin center, open the sending mailbox → Mail → Manage email apps, and turn on Authenticated SMTP.',
        'If your organisation turned it off for everyone, or uses Security defaults, an Exchange administrator must allow it for this mailbox (Set-CASMailbox -SmtpClientAuthenticationDisabled $false).',
        'If the account has multi-factor sign-in, use an app password, or send through a relay that does not need a sign-in.',
      ]);
    }
    if (MICROSOFT.test(host)) {
      return H('smtp.microsoft-auth', 'Microsoft 365 refused the sign-in.', [
        'Check that the username is the mailbox\'s full email address and the password is current.',
        'If the account has multi-factor sign-in, use an app password, or send through a relay that does not need a sign-in.',
        'In the Microsoft 365 admin center, open the sending mailbox → Mail → Manage email apps, and check that Authenticated SMTP is on.',
        'If your organisation uses Security defaults, SMTP sign-in is blocked: an Exchange administrator must allow it for this mailbox.',
      ]);
    }
    if (GMAIL.test(host)) {
      return H('smtp.gmail-app-password', 'Google refused the sign-in: Gmail needs an App Password, not the account password.', [
        'Turn on 2-Step Verification for the Google account, then create an App Password at https://myaccount.google.com/apppasswords.',
        'Paste the 16-character App Password as the password (SMTP_PASS). Spaces in it are removed for you.',
        'Use the full Gmail address the App Password belongs to as the username.',
        'Google Workspace: an administrator may have to allow less secure sign-in or SMTP relay for the domain.',
      ]);
    }
    if (/not supported|no supported authentication|AUTH not available|does not support auth/i.test(text)) {
      return H('smtp.auth-not-offered', 'The mail server does not offer a sign-in on this connection.', [
        'If the server needs a sign-in, it usually offers it only after encryption: use port 587 with "Secure connection from the start" off, or 465 with it on.',
        'If it is an internal relay that accepts mail without signing in, turn off "Server needs a user name and password" (SMTP_REQUIRE_AUTH=false).',
      ]);
    }
    return H('smtp.auth', 'The mail server refused the username or password.', [
      'Check the username: most servers want the full email address of the sending mailbox.',
      'Enter the password again: it may have been changed, have expired, or been pasted with a space or line break.',
      'If the account uses multi-factor sign-in, create an app password for it and use that.',
      'Some providers need SMTP sending turned on for the mailbox first: ask your mail administrator.',
    ]);
  }

  // Sending
  if (/SendAsDenied|5\.7\.60|not owned by user|Sender address rejected|not authorized to send|sender .*not allowed|5\.7\.1 .*sender/i.test(text)) {
    return H('smtp.from-denied', 'The mail server will not send with this From address.', [
      'Use the signed-in mailbox\'s own address as the From address (SMTP_FROM), or leave it blank to use the username.',
      'To send as another address (a shared mailbox), the signed-in account needs Send As permission for it: Microsoft 365 admin center → the shared mailbox → Send as.',
    ]);
  }
  if (/5\.7\.57|Client not authenticated to send/i.test(text)) {
    return H('smtp.not-signed-in', 'The mail server only sends for signed-in accounts.', [
      'Turn on "Server needs a user name and password" (SMTP_REQUIRE_AUTH=true) and enter the mailbox\'s username and password.',
    ]);
  }
  if (/relay|Relaying denied|5\.7\.1 Unable to relay/i.test(text)) {
    return H('smtp.relay-denied', 'The mail server will not pass mail on to other domains from MissionZero.', [
      'Sign in with a mailbox account (turn on "Server needs a user name and password"), so the server knows who is sending.',
      'Or ask the mail administrator to allow relaying from the address MissionZero runs on.',
    ]);
  }
  if (/5\.1\.1|5\.1\.0|User unknown|Recipient address rejected|mailbox unavailable|No such user|recipients were rejected/i.test(text)) {
    return H('smtp.recipient', 'The mail server refused a recipient address.', [
      'Check the address for typos.',
      'An external address may need relaying to be allowed for the sending account: ask your mail administrator.',
    ]);
  }
  if (/552|5\.3\.4|size|too large/i.test(text)) {
    return H('smtp.too-large', 'The message is larger than the mail server accepts.', [
      'Send fewer projects in one report, or ask the mail administrator to raise the message size limit.',
    ]);
  }
  if (/5\.7\.708|5\.7\.705|5\.7\.750|not accepted from this IP|blocked|blacklist|blocklist|spamhaus|banned/i.test(text)) {
    return H('smtp.blocked', 'The mail server blocked mail from this account or address.', [
      'Ask your mail administrator why the sending account or the server\'s address is blocked, and to unblock it.',
      'Microsoft 365: a new or suspicious account can be held for unusual sending; check the Restricted entities page in the Defender portal.',
    ]);
  }
  if (/^4/.test(String(error?.responseCode ?? '')) || /421|4\.7\.|rate|too many|throttl|try again later/i.test(text)) {
    return H('smtp.busy', 'The mail server asked to try again later (too many messages or connections).', [
      'Wait a few minutes and send again: MissionZero tries again on its next run.',
      'If it happens every time, ask the mail administrator about the sending limits for this account.',
    ]);
  }
  return H('smtp.unknown', 'The mail server test failed for a reason MissionZero does not recognise.', [
    'Read the server\'s answer below: it usually names the problem.',
    'Check, in order: the server name, the port, "Secure connection from the start" (on for 465, off for 587), the username and the password.',
    'Send the server\'s answer to your mail administrator.',
  ]);
}

const tlsSteps = (port) =>
  STARTTLS_PORTS.has(port)
    ? ['Port 587 (and 25, 2525) starts unencrypted and then upgrades: turn "Secure connection from the start" off (SMTP_SECURE=false).', 'Or keep it on and use port 465.']
    : ['Port 465 is encrypted from the first byte: turn "Secure connection from the start" on (SMTP_SECURE=true).', 'Or keep it off and use port 587.'];

// ---------------------------------------------------------------------------
// Checkmarx One
// ---------------------------------------------------------------------------

/** The claims of a Checkmarx One API key (a JWT), or null. */
function claimsOf(apiKey) {
  const part = String(apiKey ?? '').trim().split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Why a Checkmarx One API key looks wrong before it is even tried, or null. */
export function checkCxKey(apiKey, now = Date.now()) {
  const key = String(apiKey ?? '');
  if (!key.trim()) return 'cx.no-key';
  if (/^\s|\s$/.test(key) && key.trim().split('.').length === 3) return null; // trimmed before use
  if (/^["']|["']$/.test(key.trim())) return 'cx.key-quoted';
  if (/^(bearer|token)\s/i.test(key.trim())) return 'cx.key-prefix';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key.trim())) return 'cx.key-is-id';
  const parts = key.trim().split('.');
  if (parts.length !== 3 || /\s/.test(key.trim())) return 'cx.key-format';
  const claims = claimsOf(key);
  if (!claims) return 'cx.key-format';
  if (typeof claims.exp === 'number' && claims.exp * 1000 < now) return 'cx.key-expired';
  if (typeof claims.iss !== 'string' || !/\/auth\/realms\//.test(claims.iss)) return 'cx.key-no-issuer';
  return null;
}

const CX_KEY_HELP = {
  'cx.no-key': ['No Checkmarx One API key is set.', [
    'Create one in Checkmarx One: Settings → Identity and Access Management → API Keys → Create API key.',
    'Paste it under Settings → Checkmarx One, or set CX_API_KEY in the .env file.',
  ]],
  'cx.key-quoted': ['The API key has quotes around it.', [
    'Paste the key without quotes. In a .env file write CX_API_KEY=eyJ… with nothing around the value.',
  ]],
  'cx.key-prefix': ['The API key starts with "Bearer" or "token".', [
    'Paste only the key itself: it starts with eyJ.',
  ]],
  'cx.key-is-id': ['That is the API key\'s ID, not the key.', [
    'The key is the long text shown once when the key is created; it starts with eyJ and has two dots in it.',
    'If it was not copied then, create a new API key in Checkmarx One and copy it straight away.',
  ]],
  'cx.key-format': ['That does not look like a whole Checkmarx One API key.', [
    'A key is one long line that starts with eyJ and has exactly two dots in it.',
    'It is often cut short or broken over two lines when copied: copy it again in one piece, with no spaces or line breaks.',
    'An OAuth client secret is not an API key: create an API key under Identity and Access Management → API Keys.',
  ]],
  'cx.key-expired': ['The API key has expired.', [
    'Create a new API key in Checkmarx One (Identity and Access Management → API Keys) and paste it here, or set it as CX_API_KEY.',
    'Choose a longer expiry when you create it, and note the date: MissionZero shows when the key ends.',
  ]],
  'cx.key-no-issuer': ['The API key does not say which tenant it belongs to.', [
    'Open "Single-tenant / on-prem addresses" under Settings → Checkmarx One and enter the IAM URL and the tenant name (CX_IAM_URL and CX_TENANT in a .env file).',
  ]],
};

/**
 * Why connecting to Checkmarx One failed, and what to do.
 * context: { apiKey, iamUrl, baseUrl, tenant } as tried (the key is only looked at).
 */
export function explainCxone(error, context = {}) {
  const status = Number(error?.httpStatus ?? error?.status ?? 0);
  const detail = clip(error?.detail ?? (typeof error?.body === 'string' ? error.body : error?.body ? JSON.stringify(error.body) : ''));
  const text = `${error?.message ?? ''} ${detail}`;
  const net = networkCode(error);
  const host = (() => {
    const m = /(?:at|host at) ([a-z0-9.-]+\.[a-z]{2,})/i.exec(String(error?.message ?? ''));
    return m ? m[1] : '';
  })();
  const facts = [
    ['Tenant', context.tenant || ''],
    ['IAM URL', context.iamUrl || ''],
    ['API URL', context.baseUrl || ''],
    ['Host', host],
    ['Checkmarx One answer', detail || clip(error?.message)],
  ];
  const H = (c, problem, steps) => help('cxone', c, problem, steps, facts);

  const keyProblem = context.apiKey !== undefined ? checkCxKey(context.apiKey) : null;
  if (keyProblem && CX_KEY_HELP[keyProblem]) return H(keyProblem, ...CX_KEY_HELP[keyProblem]);
  if (/does not look like a Checkmarx One API key/i.test(text)) return H('cx.key-format', ...CX_KEY_HELP['cx.key-format']);
  if (/does not carry a tenant issuer/i.test(text)) return H('cx.key-no-issuer', ...CX_KEY_HELP['cx.key-no-issuer']);
  if (/Paste your Checkmarx One API key|No Checkmarx One API key/i.test(text)) return H('cx.no-key', ...CX_KEY_HELP['cx.no-key']);
  if (/must be an https address/i.test(text)) {
    return H('cx.not-https', 'The Checkmarx One address must start with https://.', [
      'Enter the address as https://…, for example https://eu.ast.checkmarx.net.',
      'Or leave the addresses blank: they are worked out from the API key on the multi-tenant cloud.',
    ]);
  }
  if (/Could not work out the API URL/i.test(text)) {
    return H('cx.api-url', 'The Checkmarx One API address could not be worked out.', [
      'Open "Single-tenant / on-prem addresses" under Settings → Checkmarx One and enter the API URL (CX_BASE_URL), for example https://eu.ast.checkmarx.net.',
    ]);
  }

  if (net === 'ENOTFOUND' || net === 'EAI_AGAIN') {
    return H('cx.dns', 'The Checkmarx One address could not be found (DNS).', [
      'Leave CX_BASE_URL and CX_IAM_URL blank on the multi-tenant cloud: they are worked out from the key.',
      'If you set them, check the spelling and the region, for example https://eu.ast.checkmarx.net and https://eu.iam.checkmarx.net.',
      'Check that MissionZero\'s server can resolve internet names: inside a container, check its DNS.',
    ]);
  }
  if (isUntrusted(net) || net === 'ERR_TLS_CERT_ALTNAME_INVALID' || /not trusted|self-signed TLS/i.test(text)) {
    return H('cx.proxy-cert', 'The certificate presented for Checkmarx One is not trusted, usually because a company proxy inspects HTTPS.', [
      'Get your company\'s root CA certificate (a .pem file) from your network team.',
      'Mount it into the container and set NODE_EXTRA_CA_CERTS to its path, for example NODE_EXTRA_CA_CERTS=/certs/company-ca.pem, then restart MissionZero.',
      'Or ask the network team to exclude *.checkmarx.net from HTTPS inspection.',
    ]);
  }
  if (net === 'CERT_HAS_EXPIRED') {
    return H('cx.cert-expired', 'The certificate presented for Checkmarx One has expired.', [
      'This is almost always a company proxy or firewall with an old certificate: ask your network team to renew it or to exclude *.checkmarx.net from HTTPS inspection.',
      'Check the server\'s date and time too: a clock far off makes valid certificates look expired.',
    ]);
  }
  if (isTimeout(net) || net === 'ECONNREFUSED' || net === 'ECONNRESET' || error?.timedOut) {
    return H('cx.unreachable', 'MissionZero could not reach Checkmarx One.', [
      'Ask your network team to allow outgoing HTTPS (port 443) from MissionZero\'s server to your Checkmarx One addresses (the IAM and API hosts, *.checkmarx.net on the cloud).',
      'MissionZero connects directly, not through a web proxy: if outgoing traffic must go through one, ask for these hosts to be allowed directly.',
      'If it worked before, check https://status.checkmarx.com and try again in a few minutes.',
    ]);
  }

  if (/Realm does not exist|realm.*not found/i.test(text) || (status === 404 && /openid-connect|IAM|realm/i.test(text))) {
    return H('cx.tenant', 'The tenant name or IAM address is wrong.', [
      'Leave CX_TENANT and CX_IAM_URL blank on the multi-tenant cloud: they are read from the key.',
      'If you set them, the tenant is the name you sign in to Checkmarx One with, and the IAM URL is your region\'s, for example https://eu.iam.checkmarx.net.',
    ]);
  }
  if (/not active|session not found|Offline user session|Session not active|revoked/i.test(text)) {
    return H('cx.key-revoked', 'Checkmarx One no longer accepts this API key: it was deleted, revoked, or its user was disabled.', [
      'Create a new API key in Checkmarx One (Identity and Access Management → API Keys) and paste it here, or set it as CX_API_KEY.',
      'Check that the user the key belongs to is still active in Checkmarx One.',
    ]);
  }
  if (/Invalid refresh token|invalid_grant|unauthorized_client|rejected the API key/i.test(text) || (status === 401 && !/forbidden/i.test(text))) {
    return H('cx.key-rejected', 'Checkmarx One rejected the API key.', [
      'Copy the key again in one piece: it is often cut short or broken over two lines.',
      'Check that it is for this tenant and region: a key from another tenant is refused.',
      'If it is old, create a new one in Checkmarx One (Identity and Access Management → API Keys).',
    ]);
  }
  if (status === 403) {
    return H('cx.roles', 'The API key works, but its roles do not allow this.', [
      'In Checkmarx One, open Identity and Access Management → API Keys (or the key\'s user) and give it roles that can view projects, scans and results.',
      'For AI Triage, AI Remediation and rescans, the key also needs the roles that run them.',
      'Create the key again after changing its roles if the change does not take effect.',
    ]);
  }
  if (status === 404) {
    return H('cx.api-url', 'Checkmarx One answered "not found": the API address is probably wrong.', [
      'Leave CX_BASE_URL blank on the multi-tenant cloud, or set it to your region\'s ast address, for example https://eu.ast.checkmarx.net (not the iam one).',
      'For single-tenant Checkmarx One, use the address you open Checkmarx One with in a browser.',
    ]);
  }
  if (status === 429) {
    return H('cx.busy', 'Checkmarx One asked MissionZero to slow down.', [
      'Wait a minute and try again.',
      'If it happens often, lower CX_MAX_CONCURRENCY (for example to 8).',
    ]);
  }
  if (status >= 500) {
    return H('cx.outage', 'Checkmarx One had a problem answering.', [
      'Try again in a few minutes, and check https://status.checkmarx.com.',
      'If it lasts, raise a case with Checkmarx support and include the answer below.',
    ]);
  }
  return H('cx.unknown', 'The Checkmarx One connection failed for a reason MissionZero does not recognise.', [
    'Read Checkmarx One\'s answer below: it usually names the problem.',
    'Check, in order: the API key (whole, current, for this tenant), then the addresses under "Single-tenant / on-prem addresses" (blank on the multi-tenant cloud).',
  ]);
}

// ---------------------------------------------------------------------------
// Git hosts (GitHub, GitLab, Azure DevOps, Bitbucket)
// ---------------------------------------------------------------------------

const GIT_TOKEN_STEPS = {
  github: [
    'Create a token on GitHub: Settings → Developer settings → Personal access tokens. Fine-grained: choose your organisation as the resource owner and give Contents and Metadata read access. Classic: the repo and read:org scopes.',
    'Paste the whole token (it starts with github_pat_ or ghp_), with no spaces or quotes, as GITHUB_TOKEN.',
  ],
  gitlab: [
    'Create a token in GitLab: your avatar → Preferences → Access tokens, with the read_api and read_repository scopes.',
    'Paste the whole token (it usually starts with glpat-), with no spaces or quotes, as GITLAB_TOKEN.',
  ],
  azure: [
    'Create a personal access token in Azure DevOps: User settings → Personal access tokens, for the same organisation, with Code (Read), Graph (Read) and Identity (Read).',
    'Paste it as AZURE_DEVOPS_TOKEN, and set AZURE_DEVOPS_ORG_URL to the organisation, for example https://dev.azure.com/acme.',
  ],
  bitbucket: [
    'Bitbucket Cloud: use an app password with Repositories and Account read permissions, and set BITBUCKET_USERNAME to your Bitbucket username (not your email address). A workspace or repository access token works alone, without a username.',
    'Bitbucket Data Center: create an HTTP access token with Project read and Repository read, and set BITBUCKET_URL to your Bitbucket address.',
  ],
};

/** Why a git host refused or could not be reached, and what to do. */
export function explainGit(provider, error, context = {}) {
  const label = { github: 'GitHub', gitlab: 'GitLab', azure: 'Azure DevOps', bitbucket: 'Bitbucket' }[provider] ?? 'The git host';
  const status = Number(error?.status ?? 0);
  const answer = clip(error?.message);
  const text = `${answer} ${typeof error?.body === 'string' ? clip(error.body) : ''}`;
  const net = networkCode(error);
  const facts = [['Host', label], ['Address', context.url || ''], ['Variable', context.variable || ''], ['Answer', answer]];
  const H = (c, problem, steps) => help('git', c, problem, steps, facts);

  if (provider === 'azure' && /organisation|organization/i.test(text) && !status) {
    return H('git.azure.org', 'Azure DevOps needs the organisation as well as the token.', [
      'Set AZURE_DEVOPS_ORG_URL to the organisation, for example https://dev.azure.com/acme, or just acme.',
      'A token is made for one organisation: use the one it was created in.',
    ]);
  }
  if (net === 'ENOTFOUND' || net === 'EAI_AGAIN') {
    return H('git.dns', 'The git host\'s address could not be found (DNS).', [
      'Check the address (GITHUB_API_URL, GITLAB_URL, AZURE_DEVOPS_ORG_URL or BITBUCKET_URL): leave it blank for github.com, gitlab.com and bitbucket.org.',
      'For a self-hosted server, use the address you open it with in a browser, and check that MissionZero\'s server can resolve that name.',
    ]);
  }
  if (isUntrusted(net) || net === 'CERT_HAS_EXPIRED' || net === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return H('git.cert', 'The git host\'s certificate is not trusted.', [
      'If it is a self-hosted server with a company certificate, or a proxy inspects HTTPS, mount the company CA certificate and set NODE_EXTRA_CA_CERTS to its path, then restart MissionZero.',
    ]);
  }
  if (isTimeout(net) || net === 'ECONNREFUSED' || net === 'ECONNRESET' || /Could not reach/i.test(text)) {
    return H('git.unreachable', 'MissionZero could not reach the git host.', [
      'Check the address, and ask your network team to allow outgoing HTTPS (port 443) from MissionZero\'s server to it.',
    ]);
  }
  if (provider === 'github' && /SAML|SSO|single sign-on/i.test(text)) {
    return H('git.github.sso', 'GitHub refused the token for this organisation until it is authorised for single sign-on.', [
      'On GitHub, open Settings → Developer settings → Personal access tokens, find the token, choose Configure SSO and authorise it for your organisation.',
    ]);
  }
  if (/rate limit|API rate|too many requests/i.test(text) || status === 429) {
    return H('git.rate', 'The git host is limiting how many requests this token may make.', [
      'Wait for the limit to reset (usually within an hour) and try again.',
      'A token of a dedicated account with its own limits avoids sharing them with other tools.',
    ]);
  }
  if (provider === 'azure' && (status === 203 || status === 401 || /<html|sign in|TF400813|not authorized/i.test(text))) {
    return H('git.azure.token', 'Azure DevOps did not accept the token for this organisation.', [
      'Check that the token has not expired and was created in this organisation (a token is made for one organisation, or for all accessible organisations).',
      ...GIT_TOKEN_STEPS.azure,
    ]);
  }
  if (status === 401 || /Bad credentials|invalid_token|Unauthorized|401/i.test(text)) {
    return H(`git.${provider}.token`, 'The git host rejected the token: it is wrong, expired or revoked.', [
      'Copy the token again in one piece, with no spaces, quotes or "Bearer" in front.',
      ...(GIT_TOKEN_STEPS[provider] ?? []),
    ]);
  }
  if (status === 403 || /insufficient_scope|forbidden|permission/i.test(text)) {
    return H('git.permission', 'The git host accepted the token, but it lacks a permission this needs.', GIT_TOKEN_STEPS[provider] ?? []);
  }
  if (status === 404) {
    return H('git.not-found', 'The git host answered "not found": the organisation, group or workspace name, or the address, is wrong, or the token cannot see it.', [
      'Check the organisation, group or workspace name (GITHUB_ORG, GITLAB_GROUP, BITBUCKET_WORKSPACE).',
      'GitHub Enterprise: GITHUB_API_URL ends with /api/v3, for example https://github.company.com/api/v3.',
      'Check that the token\'s account is a member and can see it.',
    ]);
  }
  return H('git.unknown', 'The git host refused the request for a reason MissionZero does not recognise.', [
    'Read the answer below: it usually names the problem.',
    ...(GIT_TOKEN_STEPS[provider] ?? []),
  ]);
}

// ---------------------------------------------------------------------------
// .env files
// ---------------------------------------------------------------------------

const ENV_HELP = {
  'env.syntax': ['This line is not a setting.', ['Write each setting on its own line as NAME=value, with no spaces in the name and nothing before it (no "set" or "$env:").']],
  'env.lowercase': ['Setting names are upper case.', ['Write the name in capitals, as in the sample file.']],
  'env.typo': ['This setting name is not known, and looks like a misspelling.', ['Use the name shown under "Did you mean", as in the sample file.']],
  'env.duplicate': ['This setting is in the file more than once: only the last one counts.', ['Keep one line for it and delete the others.']],
  'env.placeholder': ['This value is still the example text from a template.', ['Replace it with your real value, or leave it blank to keep what is set now.']],
  'env.quotes': ['This value has a quote at only one end.', ['Remove the quotes, or put one at each end. Values need no quotes.']],
  'env.spaces': ['This key or token contains spaces or a line break.', ['Copy it again in one piece: keys and tokens have no spaces.']],
  'env.bearer': ['This token starts with "Bearer" or "token".', ['Paste only the token itself.']],
  'env.smtp-host': ['SMTP_HOST must be a plain host name.', ['Write only the name, for example smtp.office365.com: no smtp:// in front, no :587 or path after it. Put the port in SMTP_PORT.']],
  'env.smtp-port': ['SMTP_PORT must be a number from 1 to 65535.', ['Use 587 for STARTTLS (most servers, Office 365, Gmail), 465 for implicit TLS, or 25 for an internal relay.']],
  'env.boolean': ['This setting takes true or false.', ['Write true or false. For SMTP_SECURE: true for port 465 (SSL/TLS), false for 587 (STARTTLS).']],
  'env.smtp-tls': ['SMTP_SECURE does not match SMTP_PORT, so the connection will stall.', ['Port 465: SMTP_SECURE=true. Ports 587, 25 and 2525: SMTP_SECURE=false.']],
  'env.smtp-office365-465': ['Microsoft 365 sends on port 587, not 465.', ['Set SMTP_PORT=587 and SMTP_SECURE=false.']],
  'env.gmail-password': ['Gmail needs a 16-character App Password, and this one is not.', ['Create an App Password at https://myaccount.google.com/apppasswords (it needs 2-Step Verification) and use it as SMTP_PASS.']],
  'env.smtp-user-missing': ['SMTP_REQUIRE_AUTH is true but SMTP_USER is empty.', ['Set SMTP_USER to the sending mailbox\'s address and SMTP_PASS to its password, or set SMTP_REQUIRE_AUTH=false for a relay that needs no sign-in.']],
  'env.email': ['This is not an email address.', ['Write one address, for example missionzero@company.com.']],
  'env.url': ['This is not a web address.', ['Write the whole address starting with https://, for example https://mission-zero.company.com.']],
  'env.http': ['This address is not https.', ['Use https://: the key and tokens are only sent over an encrypted connection.']],
  'env.cx-iam-as-base': ['CX_BASE_URL is the IAM address; it should be the API (ast) address.', ['Set CX_BASE_URL to the ast address, for example https://eu.ast.checkmarx.net, and CX_IAM_URL to the iam one. On the multi-tenant cloud, leave both blank.']],
  'env.cx-ast-as-iam': ['CX_IAM_URL is the API address; it should be the IAM address.', ['Set CX_IAM_URL to the iam address, for example https://eu.iam.checkmarx.net. On the multi-tenant cloud, leave it blank.']],
  'env.cx-tenant': ['CX_TENANT should be the tenant name only.', ['Write the name you sign in to Checkmarx One with, for example acme: not an address. On the multi-tenant cloud, leave it blank.']],
  'env.github-web-url': ['GITHUB_API_URL is the web address, not the API address.', ['Leave it blank for github.com. For GitHub Enterprise, use the address followed by /api/v3, for example https://github.company.com/api/v3.']],
  'env.github-token': ['GITHUB_TOKEN does not look like a GitHub token.', ['A GitHub token starts with github_pat_, ghp_, gho_ or ghs_. Create one under GitHub → Settings → Developer settings → Personal access tokens.']],
  'env.azure-org': ['AZURE_DEVOPS_ORG_URL is not an Azure DevOps organisation.', ['Write the organisation, for example https://dev.azure.com/acme, or just acme.']],
};

const KNOWN_START_UP = ['TZ', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'SUPPORT_MODE', 'SUPPORT_EMAIL', 'MAINTAINER_EMAIL', 'LETSENCRYPT_DOMAIN', 'LETSENCRYPT_EMAIL', 'HTTPS', 'TLS_CERT_FILE', 'TLS_KEY_FILE', 'TLS_PFX_FILE', 'TLS_PFX_PASSPHRASE', 'TLS_SELF_SIGNED', 'HTTP_REDIRECT_PORT', 'TRUST_PROXY', 'SCM_ALLOWED_HOSTS', 'UPDATE_IMAGE', 'UPDATE_REGISTRY_TOKEN', 'UPDATE_START_TIMEOUT_SECONDS', 'ACCEPT_TERMS', 'SESSION_IDLE_MINUTES', 'SESSION_SAVE_SECONDS', 'SHUTDOWN_DRAIN_SECONDS', 'INSTANCE_LOCK_WAIT_SECONDS', 'BACKUP_INTERVAL_HOURS', 'BACKUP_KEEP', 'BACKUP_PASSPHRASE', 'BACKUP_DIR', 'BACKUP_EMAIL', 'BACKUP_EMAIL_PASSWORD', 'BACKUP_EMAIL_IMAP_HOST', 'BACKUP_EMAIL_IMAP_PORT', 'BACKUP_EMAIL_USER', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'CX_MAX_CONCURRENCY', 'CX_FETCH_CONCURRENCY', 'CX_PAGES_AT_ONCE', 'CX_FETCH_CACHE_SECONDS', 'HTTP_COMPRESSION', 'HTTP_COMPRESSION_MIN_KB', 'RELAY_MAX_IN_FLIGHT', 'CX_RISK_SOURCE', 'CX_RISKS_PATH', 'HOST', 'PORT', 'DATA_DIR', 'WATCHDOG_EVERY_SECONDS', 'INBOX_EVERY_SECONDS', 'LAST_WORDS_EVERY_HOURS'];

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

const BOOLEAN = /^(1|0|true|false|yes|no|on|off)$/i;
const SECRET_NAME = /(KEY|TOKEN|PASS|PASSWORD|SECRET)(_\d)?$/;
const PLACEHOLDER = /^(<.*>|\[.*\]|\{.*\}|x{3,}|\*{3,}|your[-_ ].*|changeme|change[-_ ]me|replace[-_ ]?me|todo|tbd|example|placeholder|\.\.\.)$/i;
const ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/**
 * Check an uploaded .env file before anything in it is applied.
 * known: the names applied from an upload (ENV_SETTINGS) — the rest of the sample's are start-up ones.
 * isKnown(name): whether a (numbered) name is applied.
 * Returns [{ name, line, level: 'error' | 'warn', code, problem, steps, suggestion }]; an
 * 'error' means the value is not applied (a working setting keeps its current value).
 */
export function checkEnvFile(text, vars, { known = [], isKnown = () => false } = {}) {
  const findings = [];
  const add = (level, code, name, line, suggestion = '') => {
    const [problem, steps] = ENV_HELP[code];
    findings.push({ name, line, level, code, problem, steps, ...(suggestion ? { suggestion } : {}) });
  };
  const all = [...new Set([...known, ...KNOWN_START_UP])];
  const lineOf = {};
  const seen = new Map();
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
  let quoted = null;
  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = raw.trim();
    if (quoted) {
      if (line.includes(quoted.mark)) quoted = null;
      return;
    }
    if (!line || line.startsWith('#')) return;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      const name = /^(?:set\s+|\$env:)?([A-Za-z_][A-Za-z0-9_ ]*?)\s*[:=]/i.exec(line)?.[1]?.replace(/\s+/g, '_') ?? '';
      add('error', 'env.syntax', name.toUpperCase() || '?', n);
      return;
    }
    const [, name, value] = match;
    const q = value[0];
    if ((q === '"' || q === "'") && !value.slice(1).includes(q)) quoted = { mark: q, name, line: n };
    lineOf[name] = n;
    if (seen.has(name)) add('warn', 'env.duplicate', name, n);
    seen.set(name, n);
    if (/[a-z]/.test(name) && all.includes(name.toUpperCase())) return add('error', 'env.lowercase', name, n, name.toUpperCase());
    if (!all.includes(name) && !isKnown(name)) {
      const most = name.length >= 8 ? 2 : 1;
      const near = all.map((k) => [k, distance(name, k)]).filter(([, d]) => d > 0 && d <= most).sort((a, b) => a[1] - b[1])[0];
      if (near) add('error', 'env.typo', name, n, near[0]);
    }
  });
  // A quote opened and never closed swallows every line after it.
  if (quoted) add('error', 'env.quotes', quoted.name, quoted.line);

  const v = (name) => String(vars[name] ?? '').trim();
  const at = (name) => lineOf[name] ?? 0;
  const bad = (code, name, level = 'error') => add(level, code, name, at(name));

  for (const [name, rawValue] of Object.entries(vars)) {
    const value = String(rawValue ?? '');
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (PLACEHOLDER.test(trimmed)) {
      bad('env.placeholder', name);
      continue;
    }
    if (/^["'][^"']*$|^[^"']*["']$/.test(trimmed)) bad('env.quotes', name);
    if (SECRET_NAME.test(name) && !/PASSPHRASE|PASSWORD$|_PASS$/.test(name)) {
      if (/^(bearer|token)\s/i.test(trimmed)) bad('env.bearer', name);
      else if (/\s/.test(trimmed)) bad('env.spaces', name);
    }
  }

  // The mail server
  const host = v('SMTP_HOST');
  if (host && (/^[a-z]+:\/\//i.test(host) || /[\s/]/.test(host) || /:\d+$/.test(host))) bad('env.smtp-host', 'SMTP_HOST');
  const portText = v('SMTP_PORT');
  const port = Number(portText);
  if (portText && (!/^\d+$/.test(portText) || port < 1 || port > 65535)) bad('env.smtp-port', 'SMTP_PORT');
  for (const name of ['SMTP_SECURE', 'SMTP_REQUIRE_AUTH', 'SMTP_REJECT_UNAUTHORIZED']) if (v(name) && !BOOLEAN.test(v(name))) bad('env.boolean', name);
  if (portText && BOOLEAN.test(v('SMTP_SECURE')) && tlsModeMismatch({ port, secure: /^(1|true|yes|on)$/i.test(v('SMTP_SECURE')) })) bad('env.smtp-tls', 'SMTP_SECURE');
  if (MICROSOFT.test(host) && port === 465) bad('env.smtp-office365-465', 'SMTP_PORT');
  const pass = v('SMTP_PASS') || v('SMTP_PASSWORD');
  if (GMAIL.test(host) && pass && !/^[A-Za-z0-9]{16}$/.test(pass.replace(/\s+/g, ''))) bad('env.gmail-password', vars.SMTP_PASS !== undefined ? 'SMTP_PASS' : 'SMTP_PASSWORD', 'warn');
  if (/^(1|true|yes|on)$/i.test(v('SMTP_REQUIRE_AUTH')) && 'SMTP_USER' in vars && !v('SMTP_USER')) bad('env.smtp-user-missing', 'SMTP_USER', 'warn');
  for (const name of ['SMTP_FROM', 'SMTP_FROM_ADDRESS']) if (v(name) && !ADDRESS.test(v(name))) bad('env.email', name);

  // Checkmarx One
  if (v('CX_API_KEY')) {
    const problem = checkCxKey(vars.CX_API_KEY);
    if (problem && problem !== 'cx.no-key') {
      const [p, steps] = CX_KEY_HELP[problem];
      findings.push({ name: 'CX_API_KEY', line: at('CX_API_KEY'), level: problem === 'cx.key-no-issuer' ? 'warn' : 'error', code: problem, problem: p, steps });
    }
  }
  for (const name of ['CX_BASE_URL', 'CX_IAM_URL', 'REPORT_SERVER_URL', 'PUBLIC_URL', 'GITHUB_API_URL', 'GITLAB_URL', 'BITBUCKET_URL']) {
    const value = v(name);
    if (!value) continue;
    let url = null;
    try {
      url = new URL(value);
    } catch {}
    if (!url || !/^https?:$/.test(url.protocol)) bad('env.url', name);
    else if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) bad('env.http', name, /^(REPORT_SERVER_URL|PUBLIC_URL)$/.test(name) ? 'warn' : 'error');
  }
  if (/(^|[./])iam\./i.test(v('CX_BASE_URL'))) bad('env.cx-iam-as-base', 'CX_BASE_URL');
  if (/(^|[./])ast\./i.test(v('CX_IAM_URL'))) bad('env.cx-ast-as-iam', 'CX_IAM_URL');
  if (v('CX_TENANT') && /[\s/:.]/.test(v('CX_TENANT'))) bad('env.cx-tenant', 'CX_TENANT');

  // Git hosts
  if (/^https?:\/\/(www\.)?github\.com\/?$/i.test(v('GITHUB_API_URL')) || (v('GITHUB_API_URL') && !/github\.com/i.test(v('GITHUB_API_URL')) && !/\/api\/v3\/?$/.test(v('GITHUB_API_URL')))) bad('env.github-web-url', 'GITHUB_API_URL');
  const gh = v('GITHUB_TOKEN');
  if (gh && !/^(bearer|token)\s/i.test(gh) && !/\s/.test(gh) && !/^(github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}$/.test(gh) && !/^[0-9a-f]{40}$/.test(gh)) bad('env.github-token', 'GITHUB_TOKEN', 'warn');
  const org = v('AZURE_DEVOPS_ORG_URL');
  if (org && !/^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/.test(org) && !/^https:\/\/[^\s/]+(\/[^\s]*)?$/i.test(org)) bad('env.azure-org', 'AZURE_DEVOPS_ORG_URL');

  const unique = new Map(findings.map((f) => [`${f.name}|${f.code}`, f]));
  return [...unique.values()].sort((a, b) => (a.line || 1e9) - (b.line || 1e9));
}

/** The names a check found wrong enough not to apply. */
export const refusedByCheck = (findings) => new Set(findings.filter((f) => f.level === 'error').map((f) => f.name));
