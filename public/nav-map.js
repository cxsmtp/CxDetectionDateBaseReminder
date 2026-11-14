// Where things were before the menu and Settings were flattened, so that an old address, a bookmark and what a
// browser remembers (the last Settings section, the folded groups) still lead somewhere. Plain data and
// functions with no page in them: public/app.js uses them, and test/navigation.test.js checks them.

/**
 * Settings sections that became an advanced part of another section: old name → the section that holds it.
 * The part is a <details id="set-part-<old name>"> inside that section, changed by the same people.
 */
export const SETTINGS_PARTS = { endpoint: 'connection', links: 'server' };

/** The Settings section to open for a name from an address (#/settings/<name>) or from the browser's memory. */
export const settingsSectionFor = (name) => SETTINGS_PARTS[name] ?? name;

/** The menu's groups, by the name each is folded under (data-group in public/index.html); pinned pages have a heading of their own. */
export const NAV_GROUPS = ['act', 'credits', 'setup', 'labs'];

/**
 * The groups there were before (Act, Follow up, Prove, Govern, Plan, Set up, Labs), for the folds a browser kept
 * (mz-nav-folded). Prove became Credits: folded then, folded now. Follow up, Plan and Govern each held one page
 * that now sits in a larger group; their fold is forgotten, so it never hides the pages somebody left in view
 * there. "Fold every group" kept every name, so everything is still folded.
 */
export const OLD_NAV_GROUPS = { prove: 'credits', followup: null, plan: null, govern: null };

/** The folded groups under today's names, from what a browser kept. */
export function navFoldsFrom(list) {
  const folded = new Set();
  for (const name of Array.isArray(list) ? list : []) {
    if (typeof name !== 'string') continue;
    const now = name in OLD_NAV_GROUPS ? OLD_NAV_GROUPS[name] : name;
    if (now) folded.add(now);
  }
  return folded;
}

/** With this many pages or fewer in somebody's menu, it is one flat list with no group headings. */
export const NAV_FLAT_MAX = 7;
export const navIsFlat = (pages) => pages <= NAV_FLAT_MAX;
