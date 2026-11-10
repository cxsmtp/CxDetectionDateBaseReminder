'use strict';
// The Cx Credits Calculator as one program (scripts/package-calculator.mjs puts this, the calculator's files and
// its page into a copy of Node.js). It does what cx-credits-calculator.mjs does: the files go to a folder of their
// own in the computer's temporary folder, then the launcher starts. The data file sits beside the program, wherever
// it was started from (a double-click on macOS starts in the home folder).
const sea = require('node:sea');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

/** Says what went wrong and waits, so a window opened by a double-click does not close before it can be read. */
function stop(message) {
  console.error(message);
  if (!process.stdin.isTTY) process.exit(1);
  console.error('Press Enter to close.');
  process.stdin.once('data', () => process.exit(1));
}

try {
  const FILES = JSON.parse(sea.getAsset('files.json', 'utf8'));
  const HTML = sea.getAsset('page.html', 'utf8');
  const hash = createHash('sha256').update(JSON.stringify(FILES)).digest('hex').slice(0, 16);
  const dir = path.join(os.tmpdir(), `cx-credits-calculator-${hash}`);
  if (!fs.existsSync(path.join(dir, '.complete'))) {
    for (const [file, text] of Object.entries({ ...FILES, 'package.json': '{"type":"module"}\n' })) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
    fs.writeFileSync(path.join(dir, '.complete'), '');
  }
  // The launcher is ES modules: imported from a CommonJS file on disk (the program's own script cannot import).
  const boot = path.join(dir, 'boot.cjs');
  if (!fs.existsSync(boot)) fs.writeFileSync(boot, 'module.exports = (url) => import(url);\n');
  const load = createRequire(boot)('./boot.cjs');
  load(pathToFileURL(path.join(dir, 'src', 'calculator-launcher.js')).href)
    .then(({ startLauncher, DEFAULT_PORT }) => {
      const asked = option('--port');
      const beside = path.join(path.dirname(process.execPath), 'cx-credits-calculator-data.json');
      return startLauncher({ html: HTML, port: asked ? Number(asked) : DEFAULT_PORT, fallback: !asked, open: !args.includes('--no-open'), dataFile: path.resolve(option('--data') ?? beside) });
    })
    .catch((error) => stop(`The calculator could not start: ${error.message}`));
} catch (error) {
  stop(`The calculator could not start: ${error.message}`);
}
