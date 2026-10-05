// Throw-away credentials for the test servers, made afresh on every run so that
// none is written in the code. Each test file runs in its own process and sees
// one set of values throughout.
import { randomBytes } from 'node:crypto';

const fresh = (label) => `${label}-${randomBytes(12).toString('base64url')}`;

/** The password a test server's first Admin starts with. */
export const FIRST_PASSWORD = fresh('first');
/** The password that Admin changes it to. */
export const NEXT_PASSWORD = fresh('next');
/** A backup passphrase. */
export const PASSPHRASE = fresh('passphrase');

/**
 * A stand-in Checkmarx One API key for the mock server: only its claims are
 * read (the issuer says where to sign in), and the signature is random bytes.
 */
export function mockApiKey(claims) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ typ: 'JWT', alg: 'RS256' })}.${part(claims)}.${randomBytes(32).toString('base64url')}`;
}
