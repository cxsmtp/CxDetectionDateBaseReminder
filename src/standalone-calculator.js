import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { licenceGateScript } from './licence-gate.js';
import { liveCspMeta } from '../public/calculator/report.js';

/**
 * The Cx Credits Calculator as one HTML file that runs on its own, in any browser, with no server
 * (public/calculator/standalone.js). Built here from the same files the app serves: the calculator's
 * page (index.html's #page-calculator), its modules, the .xlsx reader, the sample exports and the
 * app's styles, so its projection and its reports are exactly the app's. It works from the two
 * Checkmarx One exports; nothing in it calls anywhere, and its content security policy says so.
 */

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// The modules, each after those it imports.
const MODULES = ['engines.js', 'look.js', 'i18n.js', 'help-tips.js', 'speedsters.js', 'calculator/model.js', 'calculator/charts.js', 'calculator/explain.js', 'calculator/report.js', 'calculator/slides.js', 'calculator/levers.js', 'calculator/profiles.js', 'calculator/page.js', 'calculator/standalone.js'];
const SAMPLES = ['Total_Vulnerabilities_by_Severity.xlsx', 'Fixed_Vulnerabilities_by_Severity.xlsx'];
/** cloc-fusion's one-file page (vendored with its engine, scripts/sync-cloc-fusion.mjs), from the repository's root. */
export const CLOC_FUSION_PAGE = 'src/cloc-fusion/cloc-fusion.html';

/**
 * cloc-fusion's page as data inside the calculator's own file, for its Download cloc-fusion button: base64 in JSON,
 * in a script element that never runs (opaque, so nothing in it can close the element or be read as this page's
 * own markup, styles or addresses), checked against the SHA-256 noted when it was copied in.
 */
export function clocFusionData() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bytes = fs.readFileSync(path.join(repo, CLOC_FUSION_PAGE));
  const origin = fs.readFileSync(path.join(repo, 'src', 'cloc-fusion', 'origin.js'), 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (!origin.includes(`sha256: "${sha256}"`)) throw new Error(`${CLOC_FUSION_PAGE} does not match the SHA-256 in src/cloc-fusion/origin.js: copy it again with scripts/sync-cloc-fusion.mjs`);
  const version = /version: "([^"]+)"/.exec(origin)?.[1] ?? '';
  return JSON.stringify({ file: 'cloc-fusion.html', version, sha256, bytes: bytes.length, base64: bytes.toString('base64') });
}

const IMPORT = /^import\s*\{([^}]*)\}\s*from\s*'([^']+)';?[ \t]*$/gm;
const EXPORT_DECL = /^export\s+(async\s+function\*?|function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * One ES module as a function scope: its imports read from the modules before it, its exports
 * returned. The app's modules only use named imports and `export function|const|let|class`; anything
 * else is refused, so a module written another way fails the build rather than the file.
 */
export function wrapModule(file, source, index) {
  const names = [];
  let code = source.replace(IMPORT, (_, list, from) => {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), from));
    if (!index.has(target)) throw new Error(`${file}: imports ${from}, which is not bundled`);
    const bindings = list.split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/\s+as\s+/, ': '));
    return `const { ${bindings.join(', ')} } = __m[${index.get(target)}];`;
  });
  code = code.replace(EXPORT_DECL, (_, kind, name) => {
    names.push(name);
    return `${kind} ${name}`;
  });
  if (/^\s*(import|export)\b/m.test(code)) throw new Error(`${file}: an import or export the bundler does not handle`);
  return `__m[${index.get(file)}] = (() => {\n${code}\nreturn { ${names.join(', ')} };\n})();`;
}

/** The calculator's page from index.html: its own <div>, shown. */
export function calculatorMarkup(indexHtml) {
  const start = indexHtml.indexOf('<div id="page-calculator"');
  if (start < 0) throw new Error('index.html has no calculator page');
  const tag = /<\/?div\b[^>]*>/g;
  tag.lastIndex = start;
  let depth = 0;
  for (let m = tag.exec(indexHtml); m; m = tag.exec(indexHtml)) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return indexHtml.slice(start, tag.lastIndex).replace(/^<div id="page-calculator" class="page calc-page" hidden>/, '<div id="page-calculator" class="page calc-page">');
  }
  throw new Error('The calculator page in index.html does not close');
}

/** The page's words where they speak of the app's server: on its own, the two exports, or the launcher, are the way in. */
export function standaloneMarkup(markup, { launcher = false } = {}) {
  const swaps = [
    ['<summary>Use the two Checkmarx One exports instead</summary>', launcher ? '<summary>Or the two Checkmarx One exports</summary>' : '<summary>The two Checkmarx One exports</summary>'],
    ['<p class="hint">For a prospect whose tenant this server is not connected to: drop their two weekly exports from Checkmarx One → Analytics on the boxes below.</p>', launcher ? '<p class="hint">Without an API key: drop the customer\'s two weekly exports from Checkmarx One → Analytics on the boxes below. <b>Load sample data</b> shows how it works.</p>' : '<p class="hint">Drop the customer\'s two weekly exports from Checkmarx One → Analytics on the boxes below, or click a box to choose the file. <b>Load sample data</b> shows how it works.</p>'],
    ['<p class="hint" id="calc-rows-empty">No projects yet. <strong>Read from Checkmarx One</strong> lists every project in this tenant with its lines of code, criticality and how often it is scanned; or add projects by hand for a prospect.</p>', launcher ? '<p class="hint" id="calc-rows-empty">No projects yet. Connect with an API key at the top, then <strong>Read from Checkmarx One</strong> lists every project in the tenant with its lines of code, criticality and how often it is scanned; or add projects by hand.</p>' : '<p class="hint" id="calc-rows-empty">No projects yet: add them by hand, with their lines of code. To read them from Checkmarx One with an API key, use the launcher, <code>cx-credits-calculator.mjs</code>.</p>'],
    // Count from git: in the launcher, this computer's git fetches and counts (the file on its own says it cannot, and points to cloc-fusion).
    ['is fetched from git into a temporary folder on this server,', launcher ? 'is fetched from git into a temporary folder on this computer,' : 'is fetched from git into a temporary folder on this server,'],
  ];
  let out = markup;
  for (const [from, to] of swaps) {
    if (!out.includes(from)) throw new Error(`The calculator page no longer says: ${from.slice(0, 60)}`);
    out = out.replace(from, to);
  }
  return out;
}

const MIME = { '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
/**
 * The app's styles with what they point to (its open-licence fonts, Fraunces and IBM Plex, and its
 * background drawings) put inside, so nothing is fetched. Anything else they name stays out.
 */
const inlined = (css, root) =>
  css.replace(/url\(([^)'"]+)\)/g, (whole, ref) => {
    const mime = MIME[path.extname(ref)];
    const file = path.join(root, ref);
    if (!mime || ref.includes('..') || !fs.existsSync(file)) return whole;
    return `url(data:${mime};base64,${fs.readFileSync(file).toString('base64')})`;
  });

const escapeText = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
/** Script text that cannot end its own <script> element. */
// Line ends as the HTML parser reads them (CRLF → LF), so a script's hash is the hash of what the browser runs.
const scriptText = (s) => s.replace(/\r\n?/g, '\n').replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');

const cache = new Map();

/** The CSP source that lets exactly this inline script or style element apply ('sha256-…' of its text). */
const contentHash = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/**
 * The page's content security policy. Scripts: only the inline ones this file was built with (by hash,
 * so no injected script, event handler or javascript: link runs). Stylesheets: only the file's own
 * <style> (by hash; no injected <style> or stylesheet applies). Style attributes stay allowed: the
 * calculator's charts and bars colour and size themselves with style="…" from their data
 * (public/calculator/charts.js, page.js) and the licence notice is styled inline (src/licence-gate.js);
 * a browser without style-src-elem/-attr reads style-src. Nothing is loaded from anywhere, and only the
 * launcher's page may call back to the launcher that served it.
 */
export const standaloneCsp = (scripts, { launcher = false, styles = [] } = {}) =>
  `default-src 'none'; script-src ${scripts.map(contentHash).join(' ')}; script-src-attr 'none'; style-src 'unsafe-inline'; style-src-elem ${styles.length ? styles.map(contentHash).join(' ') : "'none'"}; style-src-attr 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src ${launcher ? "'self'" : "'none'"}; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;

/**
 * The standalone calculator's HTML, built once per server start (the files do not change while it runs).
 * `launcher`: the page the launcher serves (cx-credits-calculator.mjs), which may call that launcher only.
 */
export function buildStandaloneCalculator({ version = '', root = PUBLIC, launcher = false } = {}) {
  const key = `${version}\u0000${root}\u0000${launcher}`;
  if (cache.has(key)) return cache.get(key);
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  const index = new Map(MODULES.map((file, i) => [file, i]));
  const bundle = MODULES.map((file) => wrapModule(file, read(file), index)).join('\n\n');
  const samples = Object.fromEntries(SAMPLES.map((name) => [name, fs.readFileSync(path.join(root, 'calculator', 'samples', name)).toString('base64')]));
  // Every script the page runs, as written into it: the CSP names each by its hash.
  const gate = `\n${scriptText(licenceGateScript())}\n`;
  // The launcher writes its token into the JSON below when it serves the page, so the script that reads it never changes.
  const launcherConfig = "window.CX_LAUNCHER = JSON.parse(document.getElementById('cx-launcher').textContent);";
  const vendorScripts = ['calculator/vendor/xlsx-lite.js', 'calculator/vendor/parse.js'].map((file) => `\n${scriptText(read(file))}\n`);
  const vendor = vendorScripts.map((text) => `<script>${text}</script>`).join('\n');
  const main = `\n${scriptText(`const __m = [];\n${bundle}\n// The product licence (src/licence-gate.js) may hold it back until an activation code is entered.\nlet __started = false;\nwindow.__mzStart = () => {\n  if (__started) return;\n  __started = true;\n  __m[${index.get('calculator/standalone.js')}].startStandalone({ samples: ${JSON.stringify(samples)} });\n};\nif (!window.__mzBlocked) window.__mzStart();`)}\n`;
  const css = `\n${`${inlined(read('styles.css'), root)}\n${inlined(read('nextgen.css'), root)}\n${STANDALONE_CSS}`.replace(/\r\n?/g, '\n')}\n`;
  const csp = standaloneCsp([gate, ...(launcher ? [launcherConfig] : []), ...vendorScripts, main], { launcher, styles: [css] });
  const label = version ? `MZ-${version.split('.').map((n) => n.padStart(2, '0')).join('.')}` : '';
  const html = `<!doctype html>
<html lang="en" data-ui="nextgen">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="generator" content="CxMissionZero ${escapeText(label)}" />
<title>Cx Credits Calculator</title>
<style>${css}</style>
</head>
<body>
<div class="shell standalone">
  <div class="content">
    <header class="topbar sa-top">
      <div class="topbar-title">
        <div class="title-row"><h1 title="${launcher ? 'The credits a customer needs, read from Checkmarx One with an API key, or from two exports. Runs on its own on this computer: customers and reports stay in this browser.' : 'The credits a customer needs, from two Checkmarx One exports. Runs on its own in this browser: nothing leaves it.'}">Cx Credits Calculator</h1></div>
      </div>
      ${launcher ? CONNECT_BAR : ''}
      <div class="sa-names">
        <label class="field"><span>Your organisation</span><input id="sa-org" maxlength="120" autocomplete="organization" placeholder="On every report" /></label>
        <label class="field"><span>Prepared by</span><input id="sa-by" maxlength="120" autocomplete="name" placeholder="Your name" /></label>
      </div>
      <div class="sa-actions">
        <button type="button" class="ghost sm" id="sa-backup" title="Every customer and report kept here, as one file">Back up</button>
        <button type="button" class="ghost sm" id="sa-restore" title="Bring back a backup made here or in another browser">Restore</button>
        <input type="file" id="sa-restore-file" accept="application/json,.json" hidden />
        <button type="button" class="ghost sm" id="sa-theme" aria-label="Light or dark" title="Light or dark"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" /></svg></button>
      </div>
    </header>
    <main>
${standaloneMarkup(calculatorMarkup(read('index.html')), { launcher })}
    </main>
    <footer class="sa-foot"><span>Cx Credits Calculator${label ? ` · from CxMissionZero ${escapeText(label)}` : ''}</span><span>Customers and reports are kept in this browser only: use Back up to keep them elsewhere.</span></footer>
  </div>
</div>
<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
<script>${gate}</script>
${launcher ? `<script type="application/json" id="cx-launcher">"__CALCULATOR_LAUNCHER__"</script>\n<script>${launcherConfig}</script>` : `<script type="application/json" id="cx-cloc-fusion">${clocFusionData()}</script>`}
<script type="application/json" id="cx-report-runtime">${JSON.stringify(reportRuntime({ root })).replace(/</g, '\\u003c')}</script>
${vendor}
<script type="module">${main}</script>
</body>
</html>
<!-- The fonts in this file, Fraunces and IBM Plex, are used under the SIL Open Font License:
${read('fonts/OFL.txt').replace(/--/g, '- -')}
-->
`;
  cache.set(key, html);
  return html;
}

// The launcher's page: the key, and where it connects (worked out from the key unless given).
const CONNECT_BAR = `<form class="sa-connect" id="sa-connect" autocomplete="off">
        <div class="sa-keybox">
          <div class="sa-key-head"><span class="sa-kick">Triage &amp; remediation · Fusion</span><label for="sa-key" class="sa-key-label">Checkmarx One API key</label><span class="status" id="sa-connect-status" aria-live="polite"></span></div>
          <div class="sa-key-row">
            <input type="password" id="sa-key" class="sa-key" spellcheck="false" placeholder="Paste the API key" autocomplete="off" />
            <button type="submit" class="primary sm" id="sa-connect-go">Connect</button>
            <button type="button" class="link" id="sa-disconnect" hidden>Disconnect</button>
          </div>
          <p class="sa-key-note">Reads the backlog by severity and its trend, and the projects Fusion · Checkmarx One is worked out from.</p>
        </div>
        <div class="sa-keybox sa-keybox-git">
          <div class="sa-key-head"><span class="sa-kick sa-kick-git">Fusion · from Git</span><label for="sa-git-token" class="sa-key-label">Git tokens</label><span class="status" id="sa-git-status" aria-live="polite"></span></div>
          <div class="sa-key-row">
            <select id="sa-git-provider" class="sa-git-provider" aria-label="Git host"><option value="github">GitHub</option><option value="gitlab">GitLab</option><option value="azure">Azure DevOps</option><option value="bitbucket">Bitbucket</option></select>
            <input type="password" id="sa-git-token" class="sa-key" spellcheck="false" placeholder="Paste a read-only token (one or more)" autocomplete="off" />
            <button type="button" class="secondary sm" id="sa-git-add">Add</button>
          </div>
          <div class="sa-git-list" id="sa-git-list"><span class="sa-key-note">Optional: each token's organisations and repositories are counted on Fusion · from Git. Kept for this run only.</span></div>
        </div>
        <details class="sa-advanced"><summary>Advanced</summary>
          <div class="sa-advanced-grid">
            <label class="field"><span>API URL</span><input id="sa-base" spellcheck="false" placeholder="From the key" /></label>
            <label class="field"><span>IAM URL</span><input id="sa-iam" spellcheck="false" placeholder="From the key" /></label>
            <label class="field"><span>Tenant</span><input id="sa-tenant" spellcheck="false" placeholder="From the key" /></label>
            <label class="field"><span>Git address (a self-hosted git)</span><input id="sa-git-address" spellcheck="false" placeholder="The platform's own" /></label>
          </div>
        </details>
      </form>`;

// The page on its own: no menu, the head above the calculator, and nothing the app's server would answer.
const STANDALONE_CSS = `
/* Aptos as the one standard font across the downloaded calculator; MZ's own fonts stay as the fallback where Aptos is not installed. */
:root { --font: "Aptos", "MZ Brand Sans", "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif; --ng-display: "Aptos", "Aptos Display", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif; }
.shell.standalone { display: block; min-height: 100vh; }
.shell.standalone .content { margin: 0 auto; max-width: 1480px; padding: 0 clamp(12px, 3vw, 32px) 24px; }
/* The head on one line: title, Customer ▾ and when it was saved, then the names for the report and the tools; the key below. */
.shell.standalone .sa-top { position: static; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; padding: 14px 0 12px; }
.shell.standalone .sa-top .topbar-title { flex: none; min-width: 0; }
.shell.standalone .sa-top h1 { white-space: nowrap; overflow: visible; font-size: clamp(20px, 2.2vw, 26px); margin: 0; }
.shell.standalone .sa-top .calc-customer { flex: 0 1 auto; min-width: 0; }
.shell.standalone .sa-top .sa-names { margin-left: auto; }
.shell.standalone .sa-top .sa-names .field { min-width: 150px; flex: 0 1 170px; }
.shell.standalone .sa-top .sa-names .field > span { font-size: 11px; }
.shell.standalone .sa-top .sa-names input { padding-top: 6px; padding-bottom: 6px; }
.shell.standalone .sa-sub { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
.shell.standalone .sa-names { display: flex; flex-wrap: wrap; gap: 10px; }
.shell.standalone .sa-names .field { margin: 0; min-width: 180px; }
.shell.standalone .sa-actions { display: flex; flex: none; gap: 6px; align-items: center; }
.shell.standalone #sa-theme { min-width: 36px; display: inline-flex; align-items: center; justify-content: center; }
.shell.standalone #sa-theme svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; }
.shell.standalone:not(.can-read) #calc-read, .shell.standalone:not(.can-read) .calc-branches, .shell.standalone:not(.can-read) .calc-read-limit, .shell.standalone:not(.can-read) .calc-source-state, .shell.standalone:not(.can-read) .calc-origins, .shell.standalone:not(.can-read) .calc-apply-read, .shell.standalone #calc-email-open, .shell.standalone #calc-email-form, .shell.standalone .calc-toolbar { display: none !important; }
/* The key card: the Checkmarx One key and the git tokens side by side, each with what it is for and its state on one line; Advanced below. */
.shell.standalone .sa-connect { flex: 1 1 100%; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px 22px; padding: 12px 16px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); order: 5; }
.shell.standalone .sa-keybox { display: grid; grid-template-columns: minmax(0, 1fr); gap: 7px; align-content: start; min-width: 0; }
.shell.standalone .sa-keybox-git { padding-inline-start: 22px; border-inline-start: 1px solid var(--border); }
.shell.standalone .sa-kick-git { color: #0d7f74; }
.shell.standalone .sa-git-provider { flex: none; width: auto; margin: 0; padding-top: 6px; padding-bottom: 6px; }
.shell.standalone #sa-git-status { margin-left: auto; font-size: 12px; font-weight: 600; }
.shell.standalone .sa-git-list { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-height: 22px; }
.shell.standalone .sa-git-chip { display: inline-flex; align-items: center; gap: 6px; padding: 2px 4px 2px 10px; border-radius: 999px; font-size: 12px; border: 1px solid color-mix(in srgb, #0d7f74 35%, transparent); background: color-mix(in srgb, #0d7f74 9%, transparent); animation: readfx-pop .35s ease-out; }
.shell.standalone .sa-git-chip b { font-weight: 600; }
.shell.standalone .sa-git-chip code { font-size: 11.5px; color: var(--muted); }
.shell.standalone .sa-git-chip button { border: 0; background: none; color: var(--muted); cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 6px; border-radius: 999px; }
.shell.standalone .sa-git-chip button:hover { color: var(--danger, #c4372f); }
.shell.standalone .sa-git-list .link { font-size: 12px; }
/* The keys and the settings as one section: one slim line (the connection, the read and its bar, what is set, Settings)
   that folds the rest away once a read starts, so the credits come first. The title line slim too. */
.shell.standalone .sa-top { padding: 8px 0 8px; gap: 8px 16px; }
.shell.standalone .sa-top h1 { font-size: clamp(18px, 1.7vw, 22px); }
.shell.standalone .sa-top .sa-names .field > span { font-size: 10.5px; }
.shell.standalone .sa-top .sa-names input { padding-top: 4px; padding-bottom: 4px; font-size: 13px; }
.shell.standalone .sa-setup { flex: 1 1 100%; order: 5; display: grid; gap: 8px; }
.shell.standalone .sa-setup-body { display: grid; gap: 8px; }
.shell.standalone .sa-setup.folded .sa-setup-body { display: none; }
.shell.standalone .sa-setup-bar { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 5px 8px 5px 14px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); font-size: 12.5px; }
.shell.standalone .sa-setup-text { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--muted); }
.shell.standalone .sa-setup-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--ok, #157347); }
.shell.standalone .sa-setup.offline .sa-setup-dot { background: var(--muted); }
.shell.standalone .sa-setup.reading .sa-setup-dot { background: var(--accent); animation: readfx-live 1.4s ease-out infinite; }
.shell.standalone .sa-setup-toggle { flex: none; font-weight: 600; padding: 2px 8px; }
.shell.standalone #sa-setup-progress:not([hidden]) { flex: 0 1 220px; appearance: none; -webkit-appearance: none; height: 4px; border: 0; border-radius: 999px; background: color-mix(in srgb, var(--muted) 16%, transparent); overflow: hidden; }
.shell.standalone #sa-setup-progress::-webkit-progress-bar { background: transparent; }
.shell.standalone #sa-setup-progress::-webkit-progress-value { border-radius: 999px; background: linear-gradient(90deg, var(--accent), #0d9488, var(--accent)); background-size: 200% 100%; animation: sa-progress 1.6s linear infinite; transition: width .8s ease-out; }
.shell.standalone #sa-setup-progress::-moz-progress-bar { border-radius: 999px; background: linear-gradient(90deg, var(--accent), #0d9488, var(--accent)); background-size: 200% 100%; animation: sa-progress 1.6s linear infinite; }
@media (max-width: 640px) { .shell.standalone #sa-setup-progress:not([hidden]) { flex-basis: 80px; } }
/* The projection settings under the keys, squeezed: the read and its settings on one line with Apply at the end,
   the reading line under them (its bar runs while Checkmarx One is read), the project filters folded. */
.shell.standalone .calc-heart-compact { gap: 6px 14px; padding: 8px 14px; grid-template-columns: minmax(0, 1fr) auto; align-items: center; border-width: 1px; }
.calc-heart-compact .calc-heart-head { display: none; }
.calc-heart-compact .calc-apply-hint { display: none; }
.calc-heart-compact > .calc-source { grid-column: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 0; padding: 0; border: 0; font-size: 12.5px; }
.calc-heart-compact #calc-read { padding: 4px 12px; min-height: 0; font-size: 12.5px; }
.calc-heart-compact .pill-check { padding: 3px 10px; font-size: 12px; }
.calc-heart-compact .calc-read-limit input { width: 8ch; padding: 3px 6px; }
.calc-heart-compact .calc-origin-pick > summary { padding: 3px 10px; font-size: 12px; }
.calc-heart-compact .calc-source-state { flex: 1 1 100%; display: grid; gap: 4px; }
.calc-heart-compact #calc-read-note { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0; background: none; }
.calc-heart-compact #calc-read-note:empty { display: none; }
.calc-heart-compact #calc-read-progress:not([hidden]) { appearance: none; -webkit-appearance: none; width: 100%; max-width: none; height: 4px; border: 0; border-radius: 999px; background: color-mix(in srgb, var(--muted) 16%, transparent); overflow: hidden; }
.calc-heart-compact #calc-read-progress::-webkit-progress-bar { background: transparent; }
.calc-heart-compact #calc-read-progress::-webkit-progress-value { border-radius: 999px; background: linear-gradient(90deg, var(--accent), #0d9488, var(--accent)); background-size: 200% 100%; animation: sa-progress 1.6s linear infinite; transition: width .8s ease-out; }
.calc-heart-compact #calc-read-progress::-moz-progress-bar { border-radius: 999px; background: linear-gradient(90deg, var(--accent), #0d9488, var(--accent)); background-size: 200% 100%; animation: sa-progress 1.6s linear infinite; }
@keyframes sa-progress { from { background-position: 200% 0; } to { background-position: 0 0; } }
.calc-heart-compact > .calc-pending { grid-column: 2; grid-row: 1; margin: 0; padding: 4px 6px 4px 12px; gap: 10px; }
.calc-heart-compact > .calc-pending #calc-pending-count { font-size: 12.5px; }
.calc-heart-compact > .calc-pending ul { display: none; }
.calc-heart-compact > .calc-pending button { padding: 4px 12px; min-height: 0; font-size: 12.5px; }
.calc-heart-compact > .calc-scope { grid-column: 1 / -1; margin: 0; padding: 4px 0 0; border-top: 1px solid var(--border); font-size: 12.5px; }
.calc-heart-compact .calc-scope-line { gap: 4px 10px; }
body.calc-presenting-on .calc-heart-compact { display: none; }
@media (max-width: 760px) { .shell.standalone .calc-heart-compact { grid-template-columns: minmax(0, 1fr); } .calc-heart-compact > .calc-pending { grid-column: 1; grid-row: auto; } }
@media (prefers-reduced-motion: reduce) { .calc-heart-compact #calc-read-progress::-webkit-progress-value, .calc-heart-compact #calc-read-progress::-moz-progress-bar { animation: none; } }
@media (max-width: 900px) { .shell.standalone .sa-connect { grid-template-columns: minmax(0, 1fr); } .shell.standalone .sa-keybox-git { padding-inline-start: 0; border-inline-start: 0; padding-top: 10px; border-top: 1px solid var(--border); } }
.shell.standalone .sa-key-head { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }
.shell.standalone .sa-kick { font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--accent); }
.shell.standalone .sa-key-label { font-size: 13px; font-weight: 600; color: var(--muted); }
.shell.standalone #sa-connect-status { margin-left: auto; font-size: 12px; font-weight: 600; }
.shell.standalone #sa-connect-status.ok, .shell.standalone #sa-connect-status.muted { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; }
.shell.standalone #sa-connect-status.ok { background: color-mix(in srgb, var(--ok, #157347) 12%, transparent); color: var(--ok, #157347); border: 1px solid color-mix(in srgb, var(--ok, #157347) 30%, transparent); }
.shell.standalone #sa-connect-status.muted { background: var(--surface-2, transparent); color: var(--muted); border: 1px solid var(--border); }
.shell.standalone #sa-connect-status.ok::before, .shell.standalone #sa-connect-status.muted::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.shell.standalone .sa-key-row { grid-column: 1 / -1; display: flex; gap: 8px; align-items: center; }
.shell.standalone .sa-key-row .sa-key { flex: 1 1 auto; min-width: 0; margin: 0; }
.shell.standalone .sa-key-note { grid-column: 1; margin: 0; font-size: 12px; color: var(--muted); align-self: center; }
.shell.standalone .sa-advanced { grid-column: 1 / -1; font-size: 12.5px; }
.shell.standalone .sa-advanced > summary { color: var(--accent); font-weight: 600; cursor: pointer; width: max-content; }
/* Back up and Restore as links, the theme as a small framed icon, as in the head of the design. */
.shell.standalone .sa-actions button.ghost:not(#sa-theme) { color: var(--accent); font-weight: 600; padding: 0 6px; }
.shell.standalone #sa-theme { border: 1px solid var(--border-strong); border-radius: 8px; width: 32px; height: 32px; min-width: 32px; padding: 0; }
.shell.standalone .sa-advanced-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px 12px; margin-top: 8px; }
.shell.standalone .sa-advanced .field { margin: 0; }
.shell.standalone .sa-foot { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; margin-top: 24px; color: var(--muted); font-size: 12px; }
@media (max-width: 640px) { .shell.standalone .sa-names .field { min-width: 0; flex: 1 1 140px; } }
`;

// The script a projection report made with its levers carries (public/calculator/report-live.js and what it imports).
const REPORT_RUNTIME = ['engines.js', 'look.js', 'calculator/model.js', 'calculator/charts.js', 'calculator/explain.js', 'calculator/report.js', 'calculator/slides.js', 'calculator/levers.js', 'calculator/report-live.js'];

/**
 * That script, as written into the report, and the CSP source that allows it alone: the calculator asks for it
 * when it makes a report (GET /calculator/report-live, and the standalone files carry it). Built once per start.
 */
export function reportRuntime({ root = PUBLIC } = {}) {
  const key = `runtime\u0000${root}`;
  if (cache.has(key)) return cache.get(key);
  const index = new Map(REPORT_RUNTIME.map((file, i) => [file, i]));
  const bundle = REPORT_RUNTIME.map((file) => wrapModule(file, fs.readFileSync(path.join(root, file), 'utf8'), index)).join('\n\n');
  const text = `\n${scriptText(`(() => {\n'use strict';\nconst __m = [];\n${bundle}\n})();`)}\n`;
  // Every quoted text in the report's modules: the calculator passes on the translations it has of them.
  const phrases = new Set();
  for (const file of REPORT_RUNTIME) {
    for (const m of fs.readFileSync(path.join(root, file), 'utf8').matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)) {
      const phrase = (m[1] ?? m[2]).replace(/\\(.)/g, '$1');
      if (/\p{L}{2}/u.test(phrase) && /\s/.test(phrase.trim()) || /^[A-Z][a-z]+$/.test(phrase)) phrases.add(phrase);
    }
  }
  const runtime = { text, hash: contentHash(text), phrases: [...phrases] };
  cache.set(key, runtime);
  return runtime;
}

/**
 * Is this not the calculator's own report file? It has no script, handler or anything embedded or posted
 * anywhere (checked in its tags; names in its text are escaped), except, in a report with its levers, exactly
 * three parts this server makes: its content security policy, its figures as JSON (with no `<` in them) and
 * the levers' script, this server's own to the byte. Those are taken out before the tags are checked.
 */
export function projectionFileProblem(html) {
  let rest = html;
  const runtime = reportRuntime();
  const script = `<script>${runtime.text}</script>`;
  if (rest.includes(script)) {
    rest = rest.replace(script, '');
    const csp = liveCspMeta(runtime.hash);
    const json = rest.match(/<script type="application\/json" id="cx-live">([^<]*)<\/script>/);
    if (!rest.includes(csp) || !json) return 'levers';
    try {
      JSON.parse(json[1]);
    } catch {
      return 'levers';
    }
    rest = rest.replace(csp, '').replace(json[0], '');
  }
  const tags = rest.match(/<[^>]*>/g) ?? [];
  return tags.some((tag) => /^<\/?(script|iframe|object|embed|form|link|meta\s+http-equiv|base)\b|\son\w+\s*=|javascript:|\s(src|href|action)\s*=\s*(?!["']?#)/i.test(tag)) ? 'tags' : '';
}

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

/** The files a module needs, itself first, following its relative imports and re-exports. */
export function moduleGraph(entry) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/^(?:import|export)\s[^;]*?from\s*'(\.[^']+)'/gms)) walk(path.resolve(path.dirname(file), m[1]));
  };
  walk(entry);
  return [...seen];
}

/**
 * The launcher: one file, cx-credits-calculator.mjs, run with `node cx-credits-calculator.mjs`. It holds the
 * calculator's page (built for the launcher) and the code that reads Checkmarx One (src/calculator-launcher.js
 * and what it imports, the same files as CxMissionZero's calculator), puts them in a folder of its own under the
 * computer's temporary folder, and starts. Nothing of this server's data is in it.
 */
export function buildCalculatorLauncher({ version = '', root = PUBLIC } = {}) {
  const key = `launcher\u0000${version}\u0000${root}`;
  if (cache.has(key)) return cache.get(key);
  const repo = path.resolve(SRC, '..');
  const files = Object.fromEntries(moduleGraph(path.join(SRC, 'calculator-launcher.js')).map((file) => [path.relative(repo, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8')]));
  // cloc-fusion's one-file page, which the launcher hands out (checked against its SHA-256 there, as here).
  files[CLOC_FUSION_PAGE] = fs.readFileSync(path.join(repo, CLOC_FUSION_PAGE), 'utf8');
  const html = buildStandaloneCalculator({ version, root, launcher: true });
  const label = version ? `MZ-${version.split('.').map((n) => n.padStart(2, '0')).join('.')}` : '';
  const text = `#!/usr/bin/env node
// Cx Credits Calculator — on its own, reading Checkmarx One with an API key.${label ? ` From CxMissionZero ${label}.` : ''}
//
//   node cx-credits-calculator.mjs            opens the calculator in this computer's browser
//   node cx-credits-calculator.mjs --port 8080 --no-open
//
// Needs Node.js 20 or later, and git only to count code lines from git (Fusion — new customer). The page is
// served on this computer only (127.0.0.1), the API key
// stays in this program's memory until it stops, and customers and reports are kept in the browser. Checkmarx
// One is read with the same code as CxMissionZero's calculator. Behind a company proxy or TLS inspection, set
// NODE_EXTRA_CA_CERTS to your company's root certificate.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  console.error(\`The Cx Credits Calculator needs Node.js 20 or later; this is \${process.version}. Get it from https://nodejs.org.\`);
  process.exit(1);
}

const FILES = ${JSON.stringify(files)};
const HTML = ${JSON.stringify(html)};

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const hash = createHash('sha256').update(JSON.stringify(FILES)).digest('hex').slice(0, 16);
const dir = path.join(os.tmpdir(), \`cx-credits-calculator-\${hash}\`);
if (!fs.existsSync(path.join(dir, '.complete'))) {
  for (const [file, text] of Object.entries({ ...FILES, 'package.json': '{"type":"module"}\\n' })) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  fs.writeFileSync(path.join(dir, '.complete'), '');
}
const { startLauncher, DEFAULT_PORT } = await import(pathToFileURL(path.join(dir, 'src', 'calculator-launcher.js')).href);
try {
  // The same port every run (unless --port says another), so the browser shows the customers saved before.
  const asked = option('--port');
  await startLauncher({ html: HTML, port: asked ? Number(asked) : DEFAULT_PORT, fallback: !asked, open: !args.includes('--no-open') });
} catch (error) {
  console.error(\`The calculator could not start: \${error.message}\`);
  process.exit(1);
}
`;
  cache.set(key, text);
  return text;
}
