// A failed connection or a mistaken .env file is explained: one sentence on what is wrong,
// the steps that fix it, and what was tried — never a secret.
import test from 'node:test';
import assert from 'node:assert/strict';

import { checkCxKey, checkEnvFile, explainCxone, explainGit, explainSmtp, networkCode } from '../src/troubleshoot.js';
import { ENV_SETTINGS, parseEnvText } from '../src/env-import.js';
import { numberedVariable } from '../src/scm/instances.js';
import { mockApiKey } from './test-credentials.js';

const mailError = (props) => Object.assign(new Error(props.message ?? ''), props);
const office = { host: 'smtp.office365.com', port: 587, secure: false, requireAuth: true, user: 'alerts@acme.io', password: 'S3cret-pw' };
const gmail = { host: 'smtp.gmail.com', port: 587, secure: false, requireAuth: true, user: 'alerts@gmail.com', password: 'my real password' };

/** Every explanation: a sentence, at least one step, and no secret anywhere in it. */
function wellFormed(help, ...secrets) {
  assert.ok(help.problem && /[.?]$/.test(help.problem), help.problem);
  assert.ok(help.steps.length >= 1);
  for (const step of help.steps) assert.ok(/[.)]$/.test(step), step);
  for (const secret of secrets) assert.doesNotMatch(JSON.stringify(help), new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  return help;
}

test('mail server: the usual failures each get their own explanation', () => {
  const cases = [
    [{}, { ...office, host: '' }, 'smtp.no-host'],
    [{}, { ...office, host: 'smtp://smtp.office365.com:587' }, 'smtp.host-format'],
    [{}, { ...office, port: 70000 }, 'smtp.port'],
    [{ code: 'EAUTH', message: 'Missing credentials for "PLAIN"' }, { ...office, password: '' }, 'smtp.no-credentials'],
    [{ code: 'EDNS', message: 'getaddrinfo ENOTFOUND smtp.offfice365.com' }, office, 'smtp.dns'],
    [{ code: 'ESOCKET', message: 'connect ECONNREFUSED 10.0.0.5:587' }, office, 'smtp.refused'],
    [{ code: 'ETIMEDOUT', message: 'Connection timeout' }, { ...office, secure: true }, 'smtp.tls-mode'],
    [{ code: 'ESOCKET', message: 'wrong version number' }, { ...office, port: 465 }, 'smtp.tls-mode'],
    [{ code: 'ETIMEDOUT', message: 'Connection timeout' }, { ...office, port: 25 }, 'smtp.port25-blocked'],
    [{ code: 'ETIMEDOUT', message: 'Connection timeout' }, office, 'smtp.timeout'],
    [{ code: 'ESOCKET', message: "Hostname/IP does not match certificate's altnames" }, office, 'smtp.cert-name'],
    [{ code: 'ESOCKET', message: 'self-signed certificate in certificate chain' }, office, 'smtp.cert-untrusted'],
    [{ code: 'ESOCKET', message: 'certificate has expired', cause: { code: 'CERT_HAS_EXPIRED' } }, office, 'smtp.cert-expired'],
    [{ code: 'EAUTH', response: '535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant.' }, office, 'smtp.microsoft-auth-off'],
    [{ code: 'EAUTH', response: '535 5.7.3 Authentication unsuccessful' }, office, 'smtp.microsoft-auth'],
    [{ code: 'EAUTH', response: '534-5.7.9 Application-specific password required.' }, gmail, 'smtp.gmail-app-password'],
    [{ code: 'EAUTH', response: '535 Incorrect authentication data' }, { ...office, host: 'mail.acme.io' }, 'smtp.auth'],
    [{ code: 'EENVELOPE', response: '554 5.2.252 SendAsDenied; alerts@acme.io not allowed to send as ciso@acme.io' }, office, 'smtp.from-denied'],
    [{ code: 'EENVELOPE', response: '550 5.7.1 Unable to relay' }, { ...office, host: 'relay.acme.io', requireAuth: false }, 'smtp.relay-denied'],
    [{ code: 'EENVELOPE', response: '550 5.1.1 <nobody@acme.io>: Recipient address rejected: User unknown' }, office, 'smtp.recipient'],
    [{ code: 'EMESSAGE', responseCode: 421, response: '421 4.7.0 Too many connections, try again later' }, office, 'smtp.busy'],
    [{ code: 'EPROTOCOL', message: 'Greeting never received' }, { ...office, port: 993 }, 'smtp.greeting'],
    [{ code: 'EPROTOCOL', message: 'Something odd' }, office, 'smtp.unknown'],
  ];
  for (const [error, smtp, code] of cases) {
    const help = wellFormed(explainSmtp(mailError(error), smtp), smtp.password || 'never-a-password');
    assert.equal(help.code, code, `${JSON.stringify(error)} → ${help.code}`);
    assert.equal(help.topic, 'smtp');
  }
  // What was tried is shown (the server and its answer), the password never.
  const help = explainSmtp(mailError({ code: 'EAUTH', response: '535 5.7.3 Authentication unsuccessful' }), office);
  assert.deepEqual(help.facts.find(([k]) => k === 'Server'), ['Server', 'smtp.office365.com:587']);
  assert.match(help.facts.find(([k]) => k === 'Server answer')[1], /5\.7\.3/);
  assert.doesNotMatch(JSON.stringify(help), /S3cret-pw/);
});

test('Checkmarx One: a key that cannot work is named before it is tried', () => {
  const now = Date.UTC(2026, 9, 6);
  const good = mockApiKey({ iss: 'https://eu.iam.checkmarx.net/auth/realms/acme', exp: now / 1000 + 86400 });
  assert.equal(checkCxKey(good, now), null);
  assert.equal(checkCxKey('', now), 'cx.no-key');
  assert.equal(checkCxKey(`"${good}"`, now), 'cx.key-quoted');
  assert.equal(checkCxKey(`Bearer ${good}`, now), 'cx.key-prefix');
  assert.equal(checkCxKey('0f8fad5b-d9cb-469f-a165-70867728950e', now), 'cx.key-is-id');
  assert.equal(checkCxKey(good.slice(0, 40), now), 'cx.key-format');
  assert.equal(checkCxKey(`${good.slice(0, 50)}\n${good.slice(50)}`, now), 'cx.key-format');
  assert.equal(checkCxKey(mockApiKey({ iss: 'https://eu.iam.checkmarx.net/auth/realms/acme', exp: now / 1000 - 60 }), now), 'cx.key-expired');
  assert.equal(checkCxKey(mockApiKey({ sub: 'x' }), now), 'cx.key-no-issuer');
});

test('Checkmarx One: each refusal and network failure gets its own explanation', () => {
  const key = mockApiKey({ iss: 'https://eu.iam.checkmarx.net/auth/realms/acme' });
  const ctx = { apiKey: key, tenant: 'acme' };
  const auth = (status, detail) => Object.assign(new Error(`Checkmarx One rejected the API key (${status}).`), { name: 'AuthError', status: 401, httpStatus: status, detail });
  const api = (status) => Object.assign(new Error(`GET /api/projects failed: ${status}`), { name: 'CxApiError', status });
  const net = (code, message = 'fetch failed') => Object.assign(new Error(`Could not reach Checkmarx One at eu.ast.checkmarx.net: ${message}.`), { cause: Object.assign(new Error('x'), { code }) });
  const cases = [
    [auth(400, '{"error":"invalid_grant","error_description":"Token is not active"}'), 'cx.key-revoked'],
    [auth(400, '{"error":"invalid_grant","error_description":"Invalid refresh token"}'), 'cx.key-rejected'],
    [auth(404, '{"error":"Realm does not exist"}'), 'cx.tenant'],
    [api(403), 'cx.roles'],
    [api(404), 'cx.api-url'],
    [api(429), 'cx.busy'],
    [api(503), 'cx.outage'],
    [net('ENOTFOUND'), 'cx.dns'],
    [net('SELF_SIGNED_CERT_IN_CHAIN'), 'cx.proxy-cert'],
    [net('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'), 'cx.proxy-cert'],
    [net('CERT_HAS_EXPIRED'), 'cx.cert-expired'],
    [net('UND_ERR_CONNECT_TIMEOUT'), 'cx.unreachable'],
    [Object.assign(new Error('Checkmarx One did not answer within 25 seconds (connection timed out).'), { timedOut: true }), 'cx.unreachable'],
    [Object.assign(new Error('The Checkmarx One IAM URL must be an https address: http://eu.iam.checkmarx.net'), { name: 'ConnectionError' }), 'cx.not-https'],
  ];
  for (const [error, code] of cases) {
    const help = wellFormed(explainCxone(error, ctx), key);
    assert.equal(help.code, code, `${error.message} → ${help.code}`);
  }
  // The key itself is looked at first: the ID instead of the key is said plainly.
  assert.equal(explainCxone(auth(401, 'invalid_grant'), { apiKey: '0f8fad5b-d9cb-469f-a165-70867728950e' }).code, 'cx.key-is-id');
  assert.equal(explainCxone(new Error('anything'), { apiKey: undefined }).code, 'cx.unknown');
});

test('git hosts: wrong, expired, unauthorised and unreachable tokens are told apart', () => {
  const err = (status, message, body) => Object.assign(new Error(message), { status, body });
  const cases = [
    ['github', err(401, 'Bad credentials'), 'git.github.token'],
    ['github', err(403, 'Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.'), 'git.github.sso'],
    ['github', err(403, 'API rate limit exceeded for user ID 1.'), 'git.rate'],
    ['github', err(404, 'Not Found'), 'git.not-found'],
    ['gitlab', err(401, '401 Unauthorized'), 'git.gitlab.token'],
    ['gitlab', err(403, 'insufficient_scope'), 'git.permission'],
    ['azure', err(203, 'Azure DevOps answered 203.', '<html>Sign In</html>'), 'git.azure.token'],
    ['azure', new Error('set the organisation address (AZURE_DEVOPS_ORG_URL) too'), 'git.azure.org'],
    ['bitbucket', err(401, 'Unauthorized'), 'git.bitbucket.token'],
    ['gitlab', Object.assign(new Error('Could not reach GitLab: getaddrinfo ENOTFOUND gitlab.acme.local'), { cause: { code: 'ENOTFOUND' } }), 'git.dns'],
    ['github', Object.assign(new Error('Could not reach GitHub: connect ETIMEDOUT'), {}), 'git.unreachable'],
    ['github', Object.assign(new Error('Could not reach GitHub: unable to get local issuer certificate'), { cause: { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' } }), 'git.cert'],
  ];
  for (const [provider, error, code] of cases) {
    const help = wellFormed(explainGit(provider, error, { url: 'https://example.test', variable: 'X_TOKEN' }));
    assert.equal(help.code, code, `${provider}: ${error.message} → ${help.code}`);
    assert.equal(help.topic, 'git');
  }
  // The token's own instructions are in the steps (what to create, which scopes).
  assert.match(explainGit('gitlab', err(401, 'x')).steps.join(' '), /read_api/);
  assert.match(explainGit('bitbucket', err(401, 'x')).steps.join(' '), /BITBUCKET_USERNAME/);
});

test('network codes under an error are found however deep, or in its message', () => {
  assert.equal(networkCode({ code: 'ESOCKET', message: 'connect ECONNREFUSED 1.2.3.4:25' }), 'ECONNREFUSED');
  assert.equal(networkCode({ message: 'x', cause: { message: 'y', cause: { code: 'ENOTFOUND' } } }), 'ENOTFOUND');
  assert.equal(networkCode({ name: 'TimeoutError', message: 'The operation was aborted due to timeout' }), 'TimeoutError');
  assert.equal(networkCode({ message: 'Could not reach Checkmarx One at x: host name not found (DNS).' }), 'ENOTFOUND');
  assert.equal(networkCode({ message: 'Bad credentials' }), '');
});

const envCheck = (text) => checkEnvFile(text, parseEnvText(text), { known: Object.keys(ENV_SETTINGS), isKnown: (name) => Boolean(numberedVariable(name)) });
const codes = (findings) => findings.map((f) => `${f.name}:${f.code}:${f.level}`);

test('.env files: mistakes are found line by line before anything is applied', () => {
  const key = mockApiKey({ iss: 'https://eu.iam.checkmarx.net/auth/realms/acme' });
  const text = [
    '# the mail server',
    'SMTP_HOST=smtp.office365.com',
    'SMTP_PORT=587a',
    'SMTP_SECURE=ssl',
    'SMPT_USER=alerts@acme.io',
    'smtp_from=alerts@acme.io',
    'set SMTP_FROM_NAME=MissionZero',
    'SMTP_PASS=<your password>',
    `CX_API_KEY=${key}`,
    'CX_BASE_URL=https://eu.iam.checkmarx.net',
    'CX_TENANT=https://eu.ast.checkmarx.net/acme',
    'GITHUB_API_URL=https://github.com',
    'GITHUB_TOKEN=Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'GITLAB_TOKEN=glpat-abc def',
    'REPORT_SERVER_URL=mz.acme.io',
    'SMTP_HOST=smtp://smtp.office365.com:587',
  ].join('\n');
  const found = envCheck(text);
  assert.deepEqual(new Set(codes(found)), new Set([
    'SMTP_HOST:env.duplicate:warn',
    'SMTP_HOST:env.smtp-host:error',
    'SMTP_PORT:env.smtp-port:error',
    'SMTP_SECURE:env.boolean:error',
    'SMPT_USER:env.typo:error',
    'smtp_from:env.lowercase:error',
    'SMTP_FROM_NAME:env.syntax:error',
    'SMTP_PASS:env.placeholder:error',
    'CX_BASE_URL:env.cx-iam-as-base:error',
    'CX_TENANT:env.cx-tenant:error',
    'GITHUB_API_URL:env.github-web-url:error',
    'GITHUB_TOKEN:env.bearer:error',
    'GITLAB_TOKEN:env.spaces:error',
    'REPORT_SERVER_URL:env.url:error',
  ]));
  assert.equal(found.find((f) => f.code === 'env.typo').suggestion, 'SMTP_USER');
  assert.equal(found.find((f) => f.code === 'env.lowercase').suggestion, 'SMTP_FROM');
  assert.equal(found.find((f) => f.code === 'env.smtp-port').line, 3);
  for (const f of found) {
    assert.ok(f.problem && f.steps.length, f.code);
    assert.doesNotMatch(JSON.stringify(f), /ghp_abc|glpat-abc|<your password>/, 'values are never repeated back');
  }
});

test('.env files: settings that disagree with each other, and Gmail and Microsoft 365 specifics', () => {
  assert.deepEqual(codes(envCheck('SMTP_PORT=587\nSMTP_SECURE=true')), ['SMTP_SECURE:env.smtp-tls:error']);
  assert.deepEqual(codes(envCheck('SMTP_PORT=465\nSMTP_SECURE=false')), ['SMTP_SECURE:env.smtp-tls:error']);
  assert.deepEqual(codes(envCheck('SMTP_HOST=smtp.office365.com\nSMTP_PORT=465\nSMTP_SECURE=true')), ['SMTP_PORT:env.smtp-office365-465:error']);
  assert.deepEqual(codes(envCheck('SMTP_HOST=smtp.gmail.com\nSMTP_PASS=my-normal-password')), ['SMTP_PASS:env.gmail-password:warn']);
  assert.deepEqual(codes(envCheck('SMTP_HOST=smtp.gmail.com\nSMTP_PASS=abcd efgh ijkl mnop')), [], 'an App Password with its spaces is fine');
  assert.deepEqual(codes(envCheck('SMTP_REQUIRE_AUTH=true\nSMTP_USER=')), ['SMTP_USER:env.smtp-user-missing:warn']);
  assert.deepEqual(codes(envCheck('SMTP_FROM=MissionZero')), ['SMTP_FROM:env.email:error']);
  assert.deepEqual(codes(envCheck('CX_IAM_URL=https://eu.ast.checkmarx.net')), ['CX_IAM_URL:env.cx-ast-as-iam:error']);
  assert.deepEqual(codes(envCheck('CX_BASE_URL=http://eu.ast.checkmarx.net')), ['CX_BASE_URL:env.http:error']);
  assert.deepEqual(codes(envCheck('REPORT_SERVER_URL=http://mz.acme.io')), ['REPORT_SERVER_URL:env.http:warn']);
  assert.deepEqual(codes(envCheck('CX_API_KEY=0f8fad5b-d9cb-469f-a165-70867728950e')), ['CX_API_KEY:cx.key-is-id:error']);
  assert.deepEqual(codes(envCheck('GITHUB_API_URL=https://github.acme.com')), ['GITHUB_API_URL:env.github-web-url:error']);
  assert.deepEqual(codes(envCheck('GITHUB_TOKEN=abc123')), ['GITHUB_TOKEN:env.github-token:warn']);
  assert.deepEqual(codes(envCheck('AZURE_DEVOPS_ORG_URL=dev azure com/acme')), ['AZURE_DEVOPS_ORG_URL:env.azure-org:error']);
  assert.deepEqual(codes(envCheck('SMTP_PASS="unclosed\nSMTP_HOST=mail.acme.io')), ['SMTP_PASS:env.quotes:error']);
});

test('.env files: a correct file, the sample file and numbered connections raise nothing', async () => {
  const fs = await import('node:fs');
  assert.deepEqual(envCheck(fs.readFileSync('.env.example', 'utf8')), []);
  const key = mockApiKey({ iss: 'https://eu.iam.checkmarx.net/auth/realms/acme' });
  const text = [
    `CX_API_KEY=${key}`,
    'SMTP_HOST=smtp.office365.com', 'SMTP_PORT=587', 'SMTP_SECURE=false', 'SMTP_REQUIRE_AUTH=true',
    'SMTP_USER=alerts@acme.io', 'SMTP_PASS=pass word with spaces is fine', 'SMTP_FROM=alerts@acme.io', 'SMTP_FROM_NAME=Mission Zero',
    'REPORT_SERVER_URL=https://mz.acme.io',
    'GITHUB_TOKEN=github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz', 'GITHUB_API_URL=https://github.acme.com/api/v3',
    'GITLAB_TOKEN_2=glpat-abcdefghij', 'GITLAB_URL_2=https://gitlab.acme.com',
    'AZURE_DEVOPS_ORG_URL=acme', 'PORT=8080', 'export TZ=Asia/Dubai', 'BACKUP_PASSPHRASE="a long phrase"',
  ].join('\n');
  assert.deepEqual(envCheck(text), []);
});
