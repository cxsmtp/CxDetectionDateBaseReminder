/**
 * The next-gen look's accents, shared by the server (the interactive report) and the pages (the
 * Cx Credits Calculator's report), so a report has the same colours as the app: for each, the text
 * colour on light and on dark, then the two ends of the gradient. public/nextgen.css has the same.
 */
export const NEXTGEN_ACCENTS = {
  indigo: ['#4f46e5', '#a5b4fc', '#6366f1', '#06b6d4'],
  cyan: ['#0e7490', '#67e8f9', '#06b6d4', '#6366f1'],
  emerald: ['#047857', '#6ee7b7', '#10b981', '#06b6d4'],
  violet: ['#6d28d9', '#c4b5fd', '#8b5cf6', '#6366f1'],
  amber: ['#b45309', '#fcd34d', '#f59e0b', '#f43f5e'],
};

/** A report's look from what it was asked for: anything unknown is the classic look on the reader's device. */
export function reportLook(look = {}) {
  return {
    ui: look?.ui === 'nextgen' ? 'nextgen' : 'classic',
    theme: ['light', 'dark'].includes(look?.theme) ? look.theme : 'auto',
    accent: Object.hasOwn(NEXTGEN_ACCENTS, look?.accent ?? '') ? look.accent : 'indigo',
  };
}
