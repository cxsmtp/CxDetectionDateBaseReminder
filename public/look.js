/**
 * The command-center look's accents, shared by the server (the interactive report) and the pages (the
 * Cx Credits Calculator's report), so a report has the same colours as the app: for each, the text
 * colour on light and on dark, then two softer steps of the same hue. public/nextgen.css has the same.
 */
export const NEXTGEN_ACCENTS = {
  // Ink, Lagoon, Sage, Plum, Ochre: earth colours. The last two are a lighter and a softer step of the same hue.
  indigo: ['#34507a', '#a8bedb', '#4a6a96', '#7a93b5'],
  cyan: ['#1f6b68', '#86c9c1', '#2f8580', '#6fb0a8'],
  emerald: ['#3e6a46', '#a3c9a0', '#55835c', '#8fb48f'],
  violet: ['#6c4265', '#d1a9c7', '#865580', '#b98aae'],
  amber: ['#8f5716', '#e5b76f', '#b0731c', '#d79b4a'],
};

/**
 * The looks, every one kept for the organisation to choose: Cabin (a luxury car's cockpit: glass, ambient
 * light in the accent colour, the default), Circuit (a sports car's gauges), Residence (a grand hotel: ivory,
 * navy and gold), Chronometer (a fine watch: green and gold) — these four drawn on Signal's pages — Signal
 * (paper, ink and one signal colour), Command center (the first next-gen look), Studio (bright, on Command center's pages), Atelier
 * (warm paper and a watchmaker's taupe) and Classic. Every look but Classic is html[data-ui="nextgen"],
 * and each but Command center adds html[data-look].
 */
export const LOOKS = ['cabin', 'circuit', 'residence', 'chronometer', 'signal', 'nextgen', 'studio', 'atelier', 'classic'];
export const DEFAULT_LOOK = 'cabin';

/** A report's look from what it was asked for: anything unknown is the classic look on the reader's device. */
export function reportLook(look = {}) {
  return {
    ui: look?.ui === 'nextgen' ? 'nextgen' : 'classic',
    theme: ['light', 'dark'].includes(look?.theme) ? look.theme : 'auto',
    accent: Object.hasOwn(NEXTGEN_ACCENTS, look?.accent ?? '') ? look.accent : 'indigo',
  };
}
