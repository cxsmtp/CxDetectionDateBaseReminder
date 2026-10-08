// Credit projections → Fusion: what one Fusion scan of each project costs, from the lines of code
// its last scan counted. Fusion is sold in bundles of lines of code (10,000 by default), and each
// project is rounded up to whole bundles on its own: 12,000 and 18,000 lines are 2 + 2 = 4
// bundles, never the 3 that the 30,000 lines together would make. Shared by the page
// (public/app.js) and the tests.

export const FUSION_DEFAULTS = Object.freeze({ bundleLoc: 10000, creditsPerBundle: 1 });

/** A whole number ≥ 0 from whatever was typed or read; null when there is none. */
export function wholeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[\s,_]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** The profile's Fusion terms, made safe to compute with. */
export function fusionTerms(terms = {}) {
  const bundleLoc = wholeNumber(terms.bundleLoc);
  const credits = Number(terms.creditsPerBundle);
  return {
    bundleLoc: bundleLoc && bundleLoc > 0 ? bundleLoc : FUSION_DEFAULTS.bundleLoc,
    creditsPerBundle: Number.isFinite(credits) && credits >= 0 ? credits : FUSION_DEFAULTS.creditsPerBundle,
  };
}

/** Bundles one project needs for one scan: its own lines, rounded up. No lines, no bundle. */
export function bundlesFor(loc, bundleLoc = FUSION_DEFAULTS.bundleLoc) {
  const lines = wholeNumber(loc);
  return lines ? Math.ceil(lines / bundleLoc) : 0;
}

/** The lines a project counts at: what was typed for it, else what its last scan counted. */
export const linesOf = (project) => wholeNumber(project?.locOverride) ?? wholeNumber(project?.loc);

/**
 * One scan of every included project: per project its lines, bundles and credits, and the totals.
 * `pooledBundles` is what the same lines would be if they could be added up first: the gap to
 * `bundles` is why projects are counted one by one.
 */
export function fusionEstimate(projects = [], terms = {}) {
  const { bundleLoc, creditsPerBundle } = fusionTerms(terms);
  const rows = projects.map((project) => {
    const loc = linesOf(project);
    const included = project.included !== false;
    const bundles = included ? bundlesFor(loc, bundleLoc) : 0;
    return { ...project, lines: loc, included, bundles, credits: bundles * creditsPerBundle, unknown: loc === null };
  });
  const counted = rows.filter((row) => row.included && row.lines);
  const loc = counted.reduce((sum, row) => sum + row.lines, 0);
  const bundles = counted.reduce((sum, row) => sum + row.bundles, 0);
  const pooledBundles = loc ? Math.ceil(loc / bundleLoc) : 0;
  return {
    bundleLoc,
    creditsPerBundle,
    rows,
    projects: counted.length,
    unknown: rows.filter((row) => row.included && row.unknown).length,
    loc,
    bundles,
    credits: bundles * creditsPerBundle,
    pooledBundles,
    roundingBundles: bundles - pooledBundles,
  };
}
