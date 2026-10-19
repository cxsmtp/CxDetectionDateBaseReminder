/**
 * Smart credit buttons: from what each severity needs and the credits held, the one tier
 * to run (the widest the credits cover) and the one to allocate for next. Shared by the
 * Workbench, the tracked reports and the tests.
 */

/** Severities from the top down, each tier taking in the next: what a smart button can cover. */
export const SEV_TIERS = [['CRITICAL'], ['CRITICAL', 'HIGH'], ['CRITICAL', 'HIGH', 'MEDIUM'], ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']];
export const TIER_NAMES = ['critical', 'critical & high', 'critical, high & medium', 'all'];
export const SEVERITIES_ALL = SEV_TIERS[3];

/**
 * The tiers worth a button for one kind of credit: `needBy` is the credits each severity needs,
 * `left` the credits the projects hold. A tier that adds nothing to the one above is skipped, and
 * the first that covers everything is "all". `covered` is the widest tier the credits pay for,
 * `next` the narrowest they do not.
 */
export function creditTiers(needBy, left) {
  const tiers = [];
  let before = 0;
  for (const [i, severities] of SEV_TIERS.entries()) {
    const need = severities.reduce((n, s) => n + (needBy[s] ?? 0), 0);
    if (need > before) tiers.push({ severities, need, name: TIER_NAMES[i] });
    before = need;
  }
  for (const t of tiers) if (t.need === before) Object.assign(t, { severities: SEV_TIERS[3], name: 'all' });
  return {
    total: before,
    left,
    covered: [...tiers].reverse().find((t) => t.need <= left) ?? null,
    next: tiers.find((t) => t.need > left) ?? null,
  };
}

/** "critical & high" when the ticked severities make a tier, "ticked severities" otherwise. */
export function tierName(severities) {
  const i = SEV_TIERS.findIndex((t) => t.length === severities.length && t.every((s) => severities.includes(s)));
  return i < 0 ? 'ticked severities' : TIER_NAMES[i];
}
