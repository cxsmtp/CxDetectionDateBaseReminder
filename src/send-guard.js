/**
 * Fail-safe: one request at a time per vulnerability.
 *
 * Every path that sends AI Triage or AI Remediation (Dashboard, tracked reports,
 * the emailed report's relay, any number of people at once) claims its findings
 * here first. A finding already claimed by another request, under any of its
 * identities (Checkmarx One result id, vulnerability group, risk id), is not sent
 * again; it is handed back as busy. Claims are released when the request
 * finishes, after the credit ledger has recorded what was sent, so a later
 * request then sees it as already sent.
 */
export class SendGuard {
  #inFlight = new Map(); // key -> claim token

  static keys(kind, finding) {
    const project = String(finding.projectId ?? '');
    return [
      finding.alternateId && `${kind}|${project}|a:${finding.alternateId}`,
      finding.groupId && `${kind}|${project}|g:${finding.groupId}`,
      finding.riskId && `${kind}|${project}|r:${finding.riskId}`,
    ].filter(Boolean);
  }

  /**
   * Claim `findings` for `kind` ('triage' | 'remediation'). Synchronous, so no
   * other request can claim between the check and the claim.
   * Returns { claimed, busy, release }: send only `claimed`, and always call
   * release() when done (it is safe to call more than once).
   */
  claim(kind, findings) {
    const token = Symbol(kind);
    const claimed = [];
    const busy = [];
    for (const finding of findings) {
      const keys = SendGuard.keys(kind, finding);
      if (keys.some((key) => this.#inFlight.has(key) && this.#inFlight.get(key) !== token)) {
        busy.push(finding);
        continue;
      }
      for (const key of keys) this.#inFlight.set(key, token);
      claimed.push(finding);
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      for (const [key, owner] of this.#inFlight) if (owner === token) this.#inFlight.delete(key);
    };
    return { claimed, busy, release };
  }

  /** How many identities are claimed right now (for tests and diagnostics). */
  get size() {
    return this.#inFlight.size;
  }
}
