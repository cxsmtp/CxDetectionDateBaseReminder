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
 * The looks, every one kept for the organisation to choose: Command center (the base look, the default),
 * Cabin (a luxury car's cockpit: glass, ambient light in the accent colour), Circuit (a sports car's gauges), Residence (a grand hotel: ivory,
 * navy and gold), Chronometer (a fine watch: green and gold) — these four drawn on Signal's pages — Signal
 * (paper, ink and one signal colour), Studio (bright, on Command center's pages), Atelier
 * (warm paper and a watchmaker's taupe) and Classic. Every look but Classic is html[data-ui="nextgen"],
 * and each but Command center adds html[data-look].
 */
export const LOOKS = ['cabin', 'circuit', 'residence', 'chronometer', 'signal', 'nextgen', 'studio', 'atelier', 'classic'];
export const DEFAULT_LOOK = 'nextgen';

/**
 * A report's look from what it was asked for: anything unknown is the classic look on the reader's device.
 * `look` names the look itself (one of LOOKS); `ui` is "nextgen" for every look but Classic.
 */
export function reportLook(look = {}) {
  const ui = look?.ui === 'nextgen' ? 'nextgen' : 'classic';
  const name = ui === 'classic' ? 'classic' : LOOKS.includes(look?.look) && look.look !== 'classic' ? look.look : 'nextgen';
  return {
    look: name,
    ui,
    // Files made from the app open light, whatever the maker's screen is set to; the reader can switch.
    theme: 'light',
    accent: Object.hasOwn(NEXTGEN_ACCENTS, look?.accent ?? '') ? look.accent : 'indigo',
  };
}

/*
 * Each new look's colours for the files made from the app (the findings report, the calculator's report and
 * PDF, Impact's summary), the same as public/nextgen.css: the page, its panels, ink, quiet text, lines, the
 * colour of what to act on (`accent`), the band at the top (`head`, `headInk`, with a line of `accent` under it)
 * and the main button. Command center and Classic keep the reports' own styles. `accents` maps the accent picker
 * to the look's colour where the look follows it: [light, dark].
 */
const SANS = '"Founders Grotesk", "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
const SERIF = '"Fraunces", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';
export const LOOK_PALETTES = {
  cabin: {
    display: SANS, displayWeight: 300, radius: 18, labels: 'caps',
    light: { bg: '#eef1f5', surface: '#ffffff', surface2: '#e7ebf1', ink: '#0b1220', muted: '#5b6676', line: '#dde3ea', accent: '#1d7fd8', button: '#1d7fd8', buttonInk: '#ffffff' },
    dark: { bg: '#05070a', surface: '#0c1117', surface2: '#121922', ink: '#eef3f8', muted: '#8b97a6', line: '#1b232d', accent: '#5cb8ff', button: '#5cb8ff', buttonInk: '#04121c' },
    head: '#070a0f', headInk: '#eef3f8',
    accents: { cyan: ['#0a9e9a', '#2fe6d6'], emerald: ['#139a59', '#4ee38f'], violet: ['#7a4fd6', '#b68cff'], amber: ['#c97a0a', '#ffb057'] },
  },
  circuit: {
    display: SANS, displayWeight: 500, italicFigures: true, radius: 10, labels: 'caps',
    light: { bg: '#e9eaec', surface: '#f6f6f7', surface2: '#dfe0e3', ink: '#0e0f11', muted: '#5c6169', line: '#d3d5d9', accent: '#d5001c', button: '#0e0f11', buttonInk: '#ffffff' },
    dark: { bg: '#0a0b0d', surface: '#131417', surface2: '#1a1c20', ink: '#f1f2f3', muted: '#8e939b', line: '#22252a', accent: '#ff2a3d', button: '#f1f2f3', buttonInk: '#0a0b0d' },
    head: '#0e0f11', headInk: '#f1f2f3',
    accents: { cyan: ['#2a63d4', '#4c8dff'], emerald: ['#3e9b2e', '#6fd04f'], violet: ['#7f3fbf', '#b07cff'], amber: ['#e0a800', '#ffcc00'] },
  },
  residence: {
    display: SERIF, displayWeight: 400, radius: 14, labels: 'caps',
    light: { bg: '#f6f1e7', surface: '#fffdf8', surface2: '#efe8da', ink: '#0d1f3c', muted: '#5f6a7d', line: '#e6dccb', accent: '#a8823a', button: '#0d1f3c', buttonInk: '#f6f1e7' },
    dark: { bg: '#07122a', surface: '#0c1a33', surface2: '#11223e', ink: '#f3ecdd', muted: '#a7adba', line: '#1b2d4c', accent: '#d4af6a', button: '#f3ecdd', buttonInk: '#07122a' },
    head: '#0d1f3c', headInk: '#f3ecdd',
  },
  chronometer: {
    display: SERIF, displayWeight: 450, radius: 16, labels: 'caps',
    light: { bg: '#f2efe7', surface: '#fbfaf6', surface2: '#e9e4d7', ink: '#0a2a1e', muted: '#56665d', line: '#e0d9c9', accent: '#a37e2c', button: '#006039', buttonInk: '#f4e9c8' },
    dark: { bg: '#03130c', surface: '#062017', surface2: '#0a281d', ink: '#f1ead8', muted: '#9fb3a8', line: '#113328', accent: '#d1aa52', button: '#0f7a4f', buttonInk: '#f4ecd6' },
    head: '#00432c', headInk: '#f4ecd6',
  },
  signal: {
    display: SANS, displayWeight: 500, radius: 16, labels: 'caps',
    light: { bg: '#f3f3ef', surface: '#fafaf7', surface2: '#ebebe5', ink: '#111111', muted: '#66665f', line: '#d6d6ce', accent: '#ff4f1a', button: '#111111', buttonInk: '#fafaf7' },
    dark: { bg: '#0b0b0b', surface: '#111111', surface2: '#181818', ink: '#f2f2ec', muted: '#9a9a92', line: '#242424', accent: '#ff6a33', button: '#f2f2ec', buttonInk: '#0b0b0b' },
    head: '#111111', headInk: '#f2f2ec',
    accents: { cyan: ['#00a3b4', '#00a3b4'], emerald: ['#12a150', '#12a150'], violet: ['#c23fd0', '#c23fd0'], amber: ['#f2a100', '#f2a100'] },
  },
  studio: {
    display: SANS, displayWeight: 680, radius: 16, labels: 'plain',
    light: { bg: '#f6f5fc', surface: '#ffffff', surface2: '#f3f1fb', ink: '#16133a', muted: '#646085', line: '#e7e4f3', accent: '#5b47e0', button: '#5b47e0', buttonInk: '#ffffff' },
    dark: { bg: '#0e0c22', surface: '#161334', surface2: '#1c1940', ink: '#ecebff', muted: '#a6a3c8', line: '#29254f', accent: '#a99bff', button: '#a99bff', buttonInk: '#0e0c22' },
    head: '#16133a', headInk: '#ecebff',
  },
  atelier: {
    display: SERIF, displayWeight: 400, radius: 4, labels: 'caps',
    light: { bg: '#fbfaf9', surface: '#ffffff', surface2: '#f6f4f1', ink: '#2e2e33', muted: '#75706a', line: '#e8e4e0', accent: '#8c7a66', button: '#2e2e33', buttonInk: '#fbfaf9' },
    dark: { bg: '#0e1522', surface: '#121a29', surface2: '#172032', ink: '#f4f2f0', muted: '#a7a39c', line: '#243049', accent: '#c9a587', button: '#c9a587', buttonInk: '#0e1522' },
    head: '#2e2e33', headInk: '#f4f2f0',
  },
};

/** A look's palette for a file, its accent applied; null for Command center and Classic (the files' own styles). */
export function lookPalette(name, accent = 'indigo') {
  const p = LOOK_PALETTES[name];
  if (!p) return null;
  const [light, dark] = p.accents?.[accent] ?? [];
  return { ...p, light: { ...p.light, ...(light ? { accent: light } : {}) }, dark: { ...p.dark, ...(dark ? { accent: dark } : {}) } };
}
