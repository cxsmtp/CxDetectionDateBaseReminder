/**
 * What a confirmed finding means and how it is usually fixed, in a sentence
 * each, for the "why confirmed" note in the HTML report. Checkmarx One's own
 * AI Triage explanation is shown first when there is one; this is what a
 * developer reads when there is not, and the fix suggestion either way.
 *
 * Keyed by the Checkmarx One query name (e.g. "Reflected_XSS"), normalised to
 * lower case without punctuation; anything unknown falls back to a keyword
 * match, then to a general note.
 */

const ADVICE = [
  [['reflected xss', 'reflected xss all clients', 'xss'], 'Input from the request is written into the page without encoding, so an attacker can run script in a victim\'s browser.', 'Encode output for its context (HTML, attribute, JavaScript, URL) or use the template engine\'s auto-escaping; validate input against an allow-list.'],
  [['stored xss'], 'Data saved earlier (database, file) is written into the page without encoding, so script stored by one user runs for every viewer.', 'Encode stored data when it is output, use auto-escaping templates, and sanitise rich text with a vetted library.'],
  [['dom xss', 'client dom xss', 'client potential xss'], 'Script in the page writes untrusted data into the DOM (innerHTML, document.write, eval).', 'Use textContent or setAttribute instead of innerHTML, avoid eval, and sanitise any HTML with a vetted library such as DOMPurify.'],
  [['sql injection', 'sql injection evasion attack', 'second order sql injection'], 'Input reaches a SQL query built by string concatenation, so an attacker can change the query.', 'Use parameterised queries or prepared statements (or the ORM\'s query builder); never concatenate input into SQL.'],
  [['nosql injection', 'mongodb nosql injection'], 'Input reaches a NoSQL query as an object or operator, so an attacker can change what the query matches.', 'Cast input to the expected type (string, number), reject objects and $-operators, and use the driver\'s query builders.'],
  [['command injection', 'os command injection', 'command argument injection'], 'Input reaches an operating-system command, so an attacker can run commands on the server.', 'Avoid the shell: call the program with an argument list (execFile/spawn without shell), and allow-list the values passed.'],
  [['code injection', 'server side code injection', 'unsafe use of eval'], 'Input is evaluated as code (eval, Function, vm), so an attacker can run code on the server.', 'Remove eval-style calls; parse data with JSON.parse or a proper parser, and map input to a fixed set of actions.'],
  [['path traversal', 'relative path traversal', 'absolute path traversal', 'file inclusion'], 'Input is used to build a file path, so an attacker can read or write files outside the intended folder.', 'Resolve the path and check it stays inside the allowed base folder; map input to known file names rather than using it directly.'],
  [['open redirect', 'unvalidated redirect', 'unvalidated forward'], 'Input decides where the user is redirected, so a link to this site can send people to an attacker\'s site.', 'Redirect only to relative paths or an allow-list of destinations; never to a URL taken straight from the request.'],
  [['missing hsts header', 'hsts header not set'], 'Responses do not send Strict-Transport-Security, so browsers may connect over plain HTTP and be intercepted.', 'Send "Strict-Transport-Security: max-age=31536000; includeSubDomains" on every HTTPS response (for example with helmet in Express).'],
  [['poor database access control', 'improper access control', 'missing authorization', 'insecure direct object reference', 'idor'], 'Data is read or changed by an id from the request without checking that the signed-in user may access it.', 'Check ownership or permission on the server for every record before reading or changing it; scope queries by the current user.'],
  [['ssrf', 'server side request forgery'], 'Input decides which address the server connects to, so an attacker can reach internal services.', 'Allow-list destination hosts, block private and metadata addresses, and do not follow redirects to other hosts.'],
  [['xxe', 'xml external entity'], 'XML is parsed with external entities enabled, so an attacker can read files or reach internal hosts.', 'Disable DTDs and external entities in the XML parser.'],
  [['deserialization of untrusted data', 'unsafe deserialization', 'insecure deserialization'], 'Untrusted data is deserialised into objects, which can run code or change program state.', 'Deserialise only plain data (JSON) into validated shapes; never use serialisers that can create arbitrary types on untrusted input.'],
  [['hardcoded password', 'hardcoded credentials', 'hardcoded secret', 'password in configuration file', 'use of hardcoded password', 'hardcoded api key'], 'A password, key or token is written in the code, where anyone with the code can read it.', 'Move it to a secret store or environment variable, rotate the exposed value, and remove it from history.'],
  [['csrf', 'cross site request forgery'], 'A state-changing request can be made from another site using the victim\'s session.', 'Require a CSRF token (or SameSite=strict cookies plus an Origin check) on every state-changing request.'],
  [['weak cryptographic algorithm', 'use of broken or risky cryptographic algorithm', 'weak hashing', 'use of insufficiently random values', 'insecure randomness'], 'A weak algorithm or predictable random values protect sensitive data.', 'Use modern algorithms (AES-GCM, SHA-256+, bcrypt/scrypt/argon2 for passwords) and crypto.randomBytes / randomUUID for secrets.'],
  [['log forging', 'log injection'], 'Input is written to logs unencoded, so an attacker can forge log entries.', 'Strip or encode newlines and control characters before logging input; prefer structured (JSON) logging.'],
  [['prototype pollution'], 'Input can set properties on Object.prototype, changing behaviour across the application.', 'Reject __proto__, constructor and prototype keys, use Object.create(null) or Map for lookups, and keep merge libraries up to date.'],
  [['regex injection', 'redos', 'regular expression denial of service'], 'Input builds or is matched by a regular expression that can take exponential time.', 'Escape input before using it in a RegExp, and rewrite patterns without nested quantifiers (or use a safe regex engine).'],
  [['information exposure', 'information exposure through an error message', 'sensitive data exposure', 'privacy violation', 'stack trace exposure'], 'Sensitive data (errors, stack traces, personal data) is sent to users or logs.', 'Return generic error messages, log details server-side only, and mask personal data.'],
  [['insecure cookie', 'cookie without secure flag', 'httponly cookie flag not set', 'missing httponly'], 'A cookie is set without Secure / HttpOnly / SameSite, so it can leak or be read by script.', 'Set Secure, HttpOnly and SameSite on session cookies.'],
  [['missing content security policy', 'csp header not set', 'missing csp'], 'Pages do not send a Content-Security-Policy, so injected script is not contained.', 'Send a Content-Security-Policy that allows only your own scripts (for example with helmet).'],
  [['clickjacking', 'missing x frame options', 'frameable response'], 'Pages can be framed by another site and used to trick clicks.', 'Send "X-Frame-Options: DENY" or a CSP frame-ancestors directive.'],
  [['ldap injection'], 'Input reaches an LDAP query, so an attacker can change what it matches.', 'Escape LDAP special characters in input and use the library\'s filter builders.'],
  [['xpath injection'], 'Input reaches an XPath query, so an attacker can change what it selects.', 'Use parameterised XPath (variables) or escape input before building the query.'],
  [['header injection', 'http response splitting', 'crlf injection'], 'Input is written into an HTTP header, so an attacker can add headers or split the response.', 'Reject CR and LF in values written to headers, and use the framework\'s header APIs.'],
  [['session fixation'], 'The session id is kept across sign-in, so an attacker who planted it can take over the session.', 'Issue a new session id at sign-in (regenerate the session).'],
  [['improper certificate validation', 'disabled certificate validation', 'trust all certificates'], 'TLS certificates are not checked, so connections can be intercepted.', 'Keep certificate validation on (rejectUnauthorized: true) and trust a private CA explicitly if one is needed.'],
  [['unchecked input for loop condition', 'denial of service', 'uncontrolled resource consumption'], 'Input controls how much work or memory the server spends, so an attacker can exhaust it.', 'Cap sizes and counts taken from input, and add timeouts and rate limits.'],
];

// Keyword fallbacks for query names not listed above: [word in the name, the entry it means]. First match wins.
const KEYWORDS = [
  ['nosql', 'nosql injection'], ['stored', 'stored xss'], ['dom', 'dom xss'], ['xss', 'xss'], ['sql', 'sql injection'],
  ['command', 'command injection'], ['eval', 'code injection'], ['code injection', 'code injection'], ['traversal', 'path traversal'],
  ['redirect', 'open redirect'], ['hsts', 'missing hsts header'], ['access control', 'poor database access control'],
  ['authoriz', 'missing authorization'], ['ssrf', 'ssrf'], ['xxe', 'xxe'], ['deserializ', 'unsafe deserialization'],
  ['hardcoded', 'hardcoded secret'], ['password', 'hardcoded password'], ['secret', 'hardcoded secret'], ['csrf', 'csrf'],
  ['crypto', 'weak cryptographic algorithm'], ['random', 'insecure randomness'], ['log', 'log injection'],
  ['prototype', 'prototype pollution'], ['regex', 'redos'], ['exposure', 'information exposure'], ['cookie', 'insecure cookie'],
  ['csp', 'missing csp'], ['frame', 'clickjacking'], ['ldap', 'ldap injection'], ['xpath', 'xpath injection'],
  ['header', 'header injection'], ['session', 'session fixation'], ['certificate', 'improper certificate validation'],
];

const norm = (title) => String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const index = new Map();
ADVICE.forEach(([names], i) => names.forEach((name) => index.set(name, i)));

/** {what, fix} for a finding: by its query name, by a keyword in it, or a general note. */
export function fixAdvice(finding) {
  const title = norm(finding?.title);
  const scanner = String(finding?.scanner ?? '').toUpperCase();
  if (scanner === 'SCA' || /^cve \d/.test(title)) {
    return {
      what: 'A package this project uses has a known vulnerability that the code can reach.',
      fix: 'Upgrade the package to the version Checkmarx One recommends (or remove it); then rebuild and rescan.',
    };
  }
  let i = index.get(title);
  if (i === undefined) i = index.get(KEYWORDS.find(([word]) => title.includes(word))?.[1]);
  if (i !== undefined) return { what: ADVICE[i][1], fix: ADVICE[i][2] };
  return {
    what: 'Checkmarx One found a path from untrusted input to a sensitive operation that nothing on the way makes safe.',
    fix: 'Validate or sanitise the input where it enters, or protect the operation where it is used; Remediate asks AI Remediation for a concrete fix.',
  };
}
