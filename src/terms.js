/**
 * The terms of use (TERMS.md): accepted by an Admin for the organisation before anyone can
 * use CxMissionZero, then by each person before they first use it. Acceptance is tied to the
 * exact text (its hash), so changed terms are asked for again. Kept in DATA_DIR/terms.json;
 * every acceptance is also in the audit log.
 *
 * ACCEPT_TERMS=<email>: the person deploying accepts for the organisation and everyone using
 * this installation (for automated setups), recorded with that name.
 */

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** First, in green, wherever the terms or the report's notice appear: what the utility talks to, and nothing else. */
export const ON_PREMISE_NOTICE =
  'Runs on your own servers and sends your data to no one: it connects only to the services you connect it to (Checkmarx One, your email server and any code host you add; and, only when an Admin checks for or installs updates, the registry its own image comes from). ' +
  'No telemetry, no analytics, nothing calls home, and you can monitor its traffic to check.';

/** One line for reports, the audit log and exports. */
export const SUPPORTING_NOTICE =
  'Supporting information only: figures here are worked out from Checkmarx One data at a moment in time and may be incomplete or wrong. ' +
  "Checkmarx's own records are authoritative, and this must not be used or shared with Checkmarx as evidence in any claim, dispute or credit request. " +
  'CxMissionZero is an independent project, not a Checkmarx product, provided as is with no warranty or support (see its terms of use).';

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export class Terms {
  #file;
  #state;

  constructor({ file, textFile }) {
    this.#file = file;
    this.text = fs.readFileSync(textFile, 'utf8');
    this.version = this.text.match(/^Version ([\w.]+)/m)?.[1] ?? '1';
    this.hash = createHash('sha256').update(this.text).digest('hex').slice(0, 16);
    try {
      this.#state = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.#state = { organisation: null, users: {} };
    }
    this.#state.users ??= {};
  }

  #save() {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const temp = `${this.#file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.#state, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, this.#file);
  }

  /** The organisation's acceptance of the current terms, or null. */
  organisation() {
    const org = this.#state.organisation;
    return org?.hash === this.hash ? org : null;
  }

  /** Whether this person accepted the current terms (or the deployer accepted for everyone). */
  acceptedBy(userId) {
    if (this.organisation()?.everyone) return true;
    return this.#state.users[userId]?.hash === this.hash;
  }

  userAcceptance(userId) {
    const entry = this.#state.users[userId];
    return entry?.hash === this.hash ? entry : null;
  }

  acceptForOrganisation({ by, ip = '', via = 'page', everyone = false }) {
    this.#state.organisation = { version: this.version, hash: this.hash, by, ip, via, everyone, at: new Date().toISOString() };
    this.#save();
  }

  acceptForUser({ userId, email, ip = '' }) {
    this.#state.users[userId] = { version: this.version, hash: this.hash, email, ip, at: new Date().toISOString() };
    this.#save();
  }

  /** ACCEPT_TERMS=<email>: accepted for the organisation and everyone, by that person. Returns true when newly recorded. */
  acceptFromEnvironment(value) {
    const email = String(value ?? '').trim();
    if (!email) return false;
    if (!EMAIL.test(email)) throw new Error('ACCEPT_TERMS must be the email address of the person accepting the terms of use (TERMS.md) for the organisation.');
    const org = this.organisation();
    if (org?.everyone && org.by === email) return false;
    this.acceptForOrganisation({ by: email, via: 'ACCEPT_TERMS', everyone: true });
    return true;
  }
}
