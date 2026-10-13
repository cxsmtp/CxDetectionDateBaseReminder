/**
 * What a confirmed finding means, in one sentence, for the "why confirmed"
 * note in the HTML report. Checkmarx One's own AI Triage explanation is shown
 * first when there is one; this is what a developer reads when there is not.
 *
 * It says what is wrong, never how to fix it: fixes come from Checkmarx One
 * AI Remediation only (Remediate in the report, or in Checkmarx One).
 *
 * Keyed by the Checkmarx One query name (e.g. "Reflected_XSS"), normalised to
 * lower case without punctuation; anything unknown falls back to a keyword
 * match, then to a general note.
 */

const MEANINGS = [
  [['reflected xss', 'reflected xss all clients', 'xss'], 'Input from the request is written into the page without encoding, so an attacker can run script in a victim\'s browser.'],
  [['stored xss'], 'Data saved earlier (database, file) is written into the page without encoding, so script stored by one user runs for every viewer.'],
  [['dom xss', 'client dom xss', 'client potential xss'], 'Script in the page writes untrusted data into the DOM (innerHTML, document.write, eval).'],
  [['sql injection', 'sql injection evasion attack', 'second order sql injection'], 'Input reaches a SQL query built by string concatenation, so an attacker can change the query.'],
  [['nosql injection', 'mongodb nosql injection'], 'Input reaches a NoSQL query as an object or operator, so an attacker can change what the query matches.'],
  [['command injection', 'os command injection', 'command argument injection'], 'Input reaches an operating-system command, so an attacker can run commands on the server.'],
  [['code injection', 'server side code injection', 'unsafe use of eval'], 'Input is evaluated as code (eval, Function, vm), so an attacker can run code on the server.'],
  [['path traversal', 'relative path traversal', 'absolute path traversal', 'file inclusion'], 'Input is used to build a file path, so an attacker can read or write files outside the intended folder.'],
  [['open redirect', 'unvalidated redirect', 'unvalidated forward'], 'Input decides where the user is redirected, so a link to this site can send people to an attacker\'s site.'],
  [['missing hsts header', 'hsts header not set'], 'Responses do not send Strict-Transport-Security, so browsers may connect over plain HTTP and be intercepted.'],
  [['poor database access control', 'improper access control', 'missing authorization', 'insecure direct object reference', 'idor'], 'Data is read or changed by an id from the request without checking that the signed-in user may access it.'],
  [['ssrf', 'server side request forgery'], 'Input decides which address the server connects to, so an attacker can reach internal services.'],
  [['xxe', 'xml external entity'], 'XML is parsed with external entities enabled, so an attacker can read files or reach internal hosts.'],
  [['deserialization of untrusted data', 'unsafe deserialization', 'insecure deserialization'], 'Untrusted data is deserialised into objects, which can run code or change program state.'],
  [['hardcoded password', 'hardcoded credentials', 'hardcoded secret', 'password in configuration file', 'use of hardcoded password', 'hardcoded api key'], 'A password, key or token is written in the code, where anyone with the code can read it.'],
  [['csrf', 'cross site request forgery'], 'A state-changing request can be made from another site using the victim\'s session.'],
  [['weak cryptographic algorithm', 'use of broken or risky cryptographic algorithm', 'weak hashing', 'use of insufficiently random values', 'insecure randomness'], 'A weak algorithm or predictable random values protect sensitive data.'],
  [['log forging', 'log injection'], 'Input is written to logs unencoded, so an attacker can forge log entries.'],
  [['prototype pollution'], 'Input can set properties on Object.prototype, changing behaviour across the application.'],
  [['regex injection', 'redos', 'regular expression denial of service'], 'Input builds or is matched by a regular expression that can take exponential time.'],
  [['information exposure', 'information exposure through an error message', 'sensitive data exposure', 'privacy violation', 'stack trace exposure'], 'Sensitive data (errors, stack traces, personal data) is sent to users or logs.'],
  [['insecure cookie', 'cookie without secure flag', 'httponly cookie flag not set', 'missing httponly'], 'A cookie is set without Secure / HttpOnly / SameSite, so it can leak or be read by script.'],
  [['missing content security policy', 'csp header not set', 'missing csp'], 'Pages do not send a Content-Security-Policy, so injected script is not contained.'],
  [['clickjacking', 'missing x frame options', 'frameable response'], 'Pages can be framed by another site and used to trick clicks.'],
  [['ldap injection'], 'Input reaches an LDAP query, so an attacker can change what it matches.'],
  [['xpath injection'], 'Input reaches an XPath query, so an attacker can change what it selects.'],
  [['header injection', 'http response splitting', 'crlf injection'], 'Input is written into an HTTP header, so an attacker can add headers or split the response.'],
  [['session fixation'], 'The session id is kept across sign-in, so an attacker who planted it can take over the session.'],
  [['improper certificate validation', 'disabled certificate validation', 'trust all certificates'], 'TLS certificates are not checked, so connections can be intercepted.'],
  [['unchecked input for loop condition', 'denial of service', 'uncontrolled resource consumption'], 'Input controls how much work or memory the server spends, so an attacker can exhaust it.'],
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
MEANINGS.forEach(([names], i) => names.forEach((name) => index.set(name, i)));

/** What this finding means: by its query name, by a keyword in it, or a general note. */
export function findingMeaning(finding) {
  const title = norm(finding?.title);
  const scanner = String(finding?.scanner ?? '').toUpperCase();
  if (scanner === 'SCA' || /^cve \d/.test(title)) return 'A package this project uses has a known vulnerability that the code can reach.';
  let i = index.get(title);
  if (i === undefined) i = index.get(KEYWORDS.find(([word]) => title.includes(word))?.[1]);
  if (i !== undefined) return MEANINGS[i][1];
  return 'Checkmarx One found a path from untrusted input to a sensitive operation that nothing on the way makes safe.';
}

/** Every sentence findingMeaning can return: the report carries their translations (scripts/i18n-report.mjs). */
export function meaningTexts() {
  return [...new Set([...MEANINGS.map(([, what]) => what), findingMeaning({ scanner: 'SCA' }), findingMeaning({ title: '' })])];
}
