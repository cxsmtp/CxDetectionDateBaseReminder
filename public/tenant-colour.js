// A tenant's colour: the same tenant always gets the same one (its id, hashed), on the server and in the page, so its
// chip reads the same in the tenant switcher, the consolidated view and its exports. The colours themselves are
// tokens (--tc-0 … --tc-7 in public/styles.css), set for every look and theme.

export const TENANT_COLOURS = 8;

/** The colour index (0–7) of a tenant id. */
export function tenantColour(id) {
  let h = 2166136261;
  for (const ch of String(id ?? '')) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % TENANT_COLOURS;
}

/** A colour index as the page uses it: always one of 0–7, whatever arrives. */
export const colourIndex = (c) => (((Math.trunc(Number(c)) || 0) % TENANT_COLOURS) + TENANT_COLOURS) % TENANT_COLOURS;

/** The same colours as plain hex, for files made from the page (CSV has none; the HTML report does). */
export const TENANT_HEX = ['#0e8a8a', '#5a5fd0', '#5f8a2e', '#b4541f', '#a23b8f', '#2f6db3', '#8a6d1a', '#c2410c'];

/**
 * Every tenant's colour, in the server's order of tenants (the order they were added): each its own hashed colour, or
 * the next one free when an earlier tenant has it, so tenants side by side never share one (up to eight). A tenant
 * keeps its colour when later ones are added.
 */
export function tenantColours(ids) {
  const used = new Set();
  const out = {};
  for (const id of ids ?? []) {
    let c = tenantColour(id);
    if (used.size < TENANT_COLOURS) while (used.has(c)) c = (c + 1) % TENANT_COLOURS;
    used.add(c);
    out[id] = c;
  }
  return out;
}
