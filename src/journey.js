/**
 * Where a project's open findings stand on the way to Mission Zero:
 *
 *   Detect → Triage → Remediate → Fix & rescan → Verify → Mission Zero
 *
 * From one fetch: every finding is in exactly one stage. Not exploitable ones
 * are counted apart (they are dealt with, not open). `remediated` is the set of
 * risk ids sent for AI Remediation through this utility (CreditLedger).
 */

const NOT_EXPLOITABLE = new Set(['NOT_EXPLOITABLE', 'PROPOSED_NOT_EXPLOITABLE']);
const CONFIRMED = new Set(['CONFIRMED', 'URGENT']);

export function journeyOf(risks = [], remediated = new Set()) {
  const journey = { open: 0, toTriage: 0, toRemediate: 0, fixing: 0, notExploitable: 0 };
  for (const r of risks) {
    if (NOT_EXPLOITABLE.has(r.state)) {
      journey.notExploitable += 1;
      continue;
    }
    journey.open += 1;
    if (remediated.has(r.riskId)) journey.fixing += 1; // a fix was asked for: waiting to be merged and rescanned
    else if (CONFIRMED.has(r.state)) journey.toRemediate += 1;
    else journey.toTriage += 1; // to verify, or not triaged at all
  }
  return journey;
}
