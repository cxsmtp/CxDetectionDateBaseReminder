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
