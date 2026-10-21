import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Cx Credits Calculator as one HTML file that runs on its own, in any browser, with no server
 * (public/calculator/standalone.js). Built here from the same files the app serves: the calculator's
 * page (index.html's #page-calculator), its modules, the .xlsx reader, the sample exports and the
 * app's styles, so its projection and its reports are exactly the app's. It works from the two
 * Checkmarx One exports; nothing in it calls anywhere, and its content security policy says so.
 */

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// The modules, each after those it imports.
const MODULES = ['engines.js', 'look.js', 'i18n.js', 'help-tips.js', 'calculator/model.js', 'calculator/charts.js', 'calculator/explain.js', 'calculator/report.js', 'calculator/slides.js', 'calculator/profiles.js', 'calculator/page.js', 'calculator/standalone.js'];
const SAMPLES = ['Total_Vulnerabilities_by_Severity.xlsx', 'Fixed_Vulnerabilities_by_Severity.xlsx'];

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
const scriptText = (s) => s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');

const cache = new Map();

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
  const vendor = ['calculator/vendor/xlsx-lite.js', 'calculator/vendor/parse.js'].map((file) => `<script>\n${scriptText(read(file))}\n</script>`).join('\n');
  const css = `${inlined(read('styles.css'), root)}\n${inlined(read('nextgen.css'), root)}\n${STANDALONE_CSS}`;
  const label = version ? `MZ-${version.split('.').map((n) => n.padStart(2, '0')).join('.')}` : '';
  const html = `<!doctype html>
<html lang="en" data-ui="nextgen">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src ${launcher ? "'self'" : "'none'"}; object-src 'none'; base-uri 'none'; form-action 'none'" />
<meta name="generator" content="CxMissionZero ${escapeText(label)}" />
<title>Cx Credits Calculator</title>
<style>
${css}
</style>
</head>
<body>
<div class="shell standalone">
  <div class="content">
    <header class="topbar sa-top">
      <div class="topbar-title">
        <div class="title-row"><h1>Cx Credits Calculator</h1></div>
        <p class="sa-sub">${launcher ? 'The credits a customer needs, read from Checkmarx One with an API key, or from two exports. Runs on its own on this computer: customers and reports stay in this browser.' : 'The credits a customer needs, from two Checkmarx One exports. Runs on its own in this browser: nothing leaves it.'}</p>
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
${launcher ? '<script>window.CX_LAUNCHER = "__CALCULATOR_LAUNCHER__";</script>' : ''}
${vendor}
<script type="module">
${scriptText(`const __m = [];\n${bundle}\n__m[${index.get('calculator/standalone.js')}].startStandalone({ samples: ${JSON.stringify(samples)} });`)}
</script>
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
        <label class="field sa-key"><span>Checkmarx One API key</span><input type="password" id="sa-key" spellcheck="false" placeholder="Paste the API key" autocomplete="off" /></label>
        <button type="submit" class="primary sm" id="sa-connect-go">Connect</button>
        <button type="button" class="ghost sm" id="sa-disconnect" hidden>Disconnect</button>
        <span class="status" id="sa-connect-status" aria-live="polite"></span>
        <details class="sa-advanced"><summary>Advanced</summary>
          <div class="sa-advanced-grid">
            <label class="field"><span>API URL</span><input id="sa-base" spellcheck="false" placeholder="From the key" /></label>
            <label class="field"><span>IAM URL</span><input id="sa-iam" spellcheck="false" placeholder="From the key" /></label>
            <label class="field"><span>Tenant</span><input id="sa-tenant" spellcheck="false" placeholder="From the key" /></label>
          </div>
        </details>
      </form>`;

// The page on its own: no menu, the head above the calculator, and nothing the app's server would answer.
const STANDALONE_CSS = `
.shell.standalone { display: block; min-height: 100vh; }
.shell.standalone .content { margin: 0 auto; max-width: 1480px; padding: 0 clamp(12px, 3vw, 32px) 24px; }
.shell.standalone .sa-top { position: static; display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px 24px; padding: 18px 0 14px; }
.shell.standalone .sa-top .topbar-title { flex: 1 1 320px; min-width: 0; }
.shell.standalone .sa-top h1 { white-space: normal; overflow: visible; }
.shell.standalone .sa-sub { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
.shell.standalone .sa-names { display: flex; flex-wrap: wrap; gap: 10px; }
.shell.standalone .sa-names .field { margin: 0; min-width: 180px; }
.shell.standalone .sa-actions { display: flex; flex: none; gap: 6px; align-items: center; }
.shell.standalone #sa-theme { min-width: 36px; display: inline-flex; align-items: center; justify-content: center; }
.shell.standalone #sa-theme svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; }
.shell.standalone:not(.can-read) #calc-read, .shell.standalone:not(.can-read) .calc-branches, .shell.standalone:not(.can-read) .calc-source-state, .shell.standalone #calc-email-open, .shell.standalone #calc-email-form, .shell.standalone .calc-toolbar { display: none !important; }
.shell.standalone .sa-connect { flex: 1 1 100%; display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 12px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); order: 5; }
.shell.standalone .sa-connect .sa-key { margin: 0; flex: 1 1 320px; max-width: 520px; }
.shell.standalone .sa-connect .status { align-self: center; }
.shell.standalone .sa-advanced { flex: 1 1 100%; font-size: 13px; }
.shell.standalone .sa-advanced-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px 12px; margin-top: 8px; }
.shell.standalone .sa-advanced .field { margin: 0; }
.shell.standalone .sa-foot { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; margin-top: 24px; color: var(--muted); font-size: 12px; }
@media (max-width: 640px) { .shell.standalone .sa-names .field { min-width: 0; flex: 1 1 140px; } }
`;

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
  const html = buildStandaloneCalculator({ version, root, launcher: true });
  const label = version ? `MZ-${version.split('.').map((n) => n.padStart(2, '0')).join('.')}` : '';
  const text = `#!/usr/bin/env node
// Cx Credits Calculator — on its own, reading Checkmarx One with an API key.${label ? ` From CxMissionZero ${label}.` : ''}
//
//   node cx-credits-calculator.mjs            opens the calculator in this computer's browser
//   node cx-credits-calculator.mjs --port 8080 --no-open
//
// Needs Node.js 20 or later, nothing else. The page is served on this computer only (127.0.0.1), the API key
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
const { startLauncher } = await import(pathToFileURL(path.join(dir, 'src', 'calculator-launcher.js')).href);
try {
  await startLauncher({ html: HTML, port: Number(option('--port') ?? 0), open: !args.includes('--no-open') });
} catch (error) {
  console.error(\`The calculator could not start: \${error.message}\`);
  process.exit(1);
}
`;
  cache.set(key, text);
  return text;
}
