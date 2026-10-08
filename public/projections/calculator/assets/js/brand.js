/*
 * brand.js — Checkmarx brand tokens and the chart palettes built on them.
 *
 * Brand colours are the published Checkmarx values (checkmarx.com/brand-kit):
 *   Electric Violet #6B34FC · Deep Koamaru #121185 · Titan White #EFEDFF
 *
 * The severity and flow palettes are NOT eyeballed. Both were generated in
 * OKLCH and checked with the data-viz validator against the exact surfaces
 * this app renders on (#FFFFFF light, #111129 dark):
 *
 *   severity, adjacent pairs   light: worst CVD ΔE 12.5, normal ΔE 16.1
 *                              dark:  worst CVD ΔE 12.0, normal ΔE 15.2
 *   flow, all pairs            light: worst CVD ΔE  8.6, normal ΔE 25.6
 *                              dark:  worst CVD ΔE 12.4, normal ΔE 21.0
 *
 * Two slots sit under 3:1 against their surface (Medium in light mode, Info in
 * dark). Both carry the required relief: a legend is always present, stacked
 * segments are direct-labelled, and every chart has a table view beneath it.
 */
window.CxBrand = {
  BRAND: {
    violet: '#6B34FC',
    violetDark: '#9480EB',   // the same brand hue, stepped for a dark surface
    koamaru: '#121185',
    titanWhite: '#EFEDFF',
  },

  /* Severity: ordered semantic heat, validated as an adjacent-pair palette. */
  severity: {
    light: {
      Critical: '#A1252A',
      High: '#D96014',
      Medium: '#E4A40F',
      Low: '#007EFD',
      Info: '#9B50AF',
    },
    dark: {
      Critical: '#E84D64',
      High: '#AB4500',
      Medium: '#BD8708',
      Low: '#2D87E9',
      Info: '#7B3DA9',
    },
  },

  /* Flow: three identities that appear together — arrivals, clearances, backlog. */
  flow: {
    light: { introduced: '#D96014', cleared: '#0E8F63', backlog: '#6B34FC' },
    dark: { introduced: '#D6782C', cleared: '#12A9A0', backlog: '#9480EB' },
  },

  /* Scenario lines reuse the flow identities plus a muted "do nothing". */
  scenario: {
    light: { nothing: '#8C8AA6', current: '#D96014', target: '#0E8F63', deadline: '#6B34FC' },
    dark: { nothing: '#918DAC', current: '#D6782C', target: '#12A9A0', deadline: '#9480EB' },
  },

  currentTheme() {
    const stamped = document.documentElement.getAttribute('data-theme');
    if (stamped === 'dark' || stamped === 'light') return stamped;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark' : 'light';
  },

  severityColors(theme) { return CxBrand.severity[theme || CxBrand.currentTheme()]; },
  flowColors(theme) { return CxBrand.flow[theme || CxBrand.currentTheme()]; },
  scenarioColors(theme) { return CxBrand.scenario[theme || CxBrand.currentTheme()]; },

  onThemeChange(handler) {
    if (window.matchMedia) {
      const query = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = () => handler(CxBrand.currentTheme());
      if (query.addEventListener) query.addEventListener('change', listener);
      else if (query.addListener) query.addListener(listener);
    }
  },

  /**
   * Placeholder Checkmarx mark.
   *
   * The official logo files live behind checkmarx.com/brand-kit, which this
   * build environment cannot reach, so this is a brand-coloured stand-in — not
   * the official asset. Drop the real SVG/PNG in through the "Company logo"
   * upload in the app (or replace assets/img/logo.svg) and it is used here and
   * embedded into every exported report.
   */
  logoSvg(height) {
    const h = height || 28;
    return `<svg class="cx-logo" height="${h}" viewBox="0 0 168 32" role="img" aria-label="Checkmarx">
      <rect x="0" y="2" width="28" height="28" rx="8" fill="#6B34FC"/>
      <path d="M8 16.4l4.6 4.6L20.4 11" fill="none" stroke="#FFFFFF" stroke-width="3"
            stroke-linecap="round" stroke-linejoin="round"/>
      <text x="38" y="23" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif"
            font-size="19" font-weight="700" letter-spacing="-0.4" fill="currentColor">Checkmarx</text>
    </svg>`;
  },
};
