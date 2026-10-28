// Copies cloc-fusion's measuring engine into src/cloc-fusion/ from a checkout of cloc-fusion, as it is there:
// its providers, discovery, API client, line counting, commit statistics, archives and Fusion buckets, and its
// one-file HTML page (cloc-fusion.html, for the calculator's Download cloc-fusion button). Not its command line,
// wizard, web app, updater, AI plan or sign-in helpers: CxMissionZero has its own (src/fusion-git.js).
//
//   node scripts/sync-cloc-fusion.mjs /path/to/cloc-fusion
//
// Each JavaScript file gets a one-line header naming where it came from; nothing else in it changes. The HTML
// page is copied byte for byte, and its SHA-256 written to src/cloc-fusion/origin.js, which the server checks
// before it hands the page out. Run `npm test` after: test/cloc-fusion-engine.test.js checks the copy.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'cloc-fusion');

/** The engine's modules, each with everything it imports. */
export const ENGINE_FILES = [
  'http.js', 'pool.js', 'discover.js', 'languages.js', 'loc.js', 'commits.js', 'fusion.js', 'archive.js', 'tar.js', 'apiengine.js', 'git.js',
  'providers/index.js', 'providers/github.js', 'providers/gitlab.js', 'providers/azure.js', 'providers/bitbucket.js', 'providers/bitbucket-server.js', 'providers/generic.js',
];
const PAGE = 'cloc-fusion.html';

const MIT = (holder) => `MIT License

Copyright (c) 2026 ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

export const header = ({ version, commit }) => `// Vendored from cloc-fusion ${version} (commit ${commit.slice(0, 12)}), MIT licence: src/cloc-fusion/LICENSE. Do not edit here: scripts/sync-cloc-fusion.mjs copies it again.\n`;

function readme({ version, commit, sha256, bytes }) {
  return `# cloc-fusion's engine, vendored

The Cx Credits Calculator's **Fusion — new customer** tab measures a customer's repositories with this engine
(through \`src/fusion-git.js\`): discovery across connections and organizations, line counting the way cloc counts,
commits on the default branch, change frequency and contributing developers.

| | |
|---|---|
| Source | cloc-fusion (github.com/cxsmtp/cloc-fusion) |
| Version | ${version} |
| Commit | \`${commit}\` |
| Licence | MIT ([LICENSE](LICENSE)) |
| \`cloc-fusion.html\` | ${bytes.toLocaleString('en-US')} bytes, SHA-256 \`${sha256}\` |

What is here, unchanged except for a one-line header naming its origin: ${ENGINE_FILES.map((f) => `\`${f}\``).join(', ')}.
Not here: cloc-fusion's command line, setup wizard, web app, updater, AI plan, report writers and sign-in helpers.

CxMissionZero keeps its own hardening around the engine (\`src/fusion-git.js\`): clone and API hosts on the allowed
list only, names that resolve to link-local or metadata addresses refused and git and the API client held to the
addresses checked, tokens redacted from every message, counts seen only by whoever started them, and temporary
folders swept after a crash.

\`cloc-fusion.html\` is cloc-fusion's one-file page, handed out by the tab's **Download cloc-fusion** button: the
server checks its SHA-256 against \`origin.js\` before serving it, as a download only.

Copy a newer version in with \`node scripts/sync-cloc-fusion.mjs /path/to/cloc-fusion\`, then run \`npm test\`.
`;
}

export function syncClocFusion(from, { out = OUT, log = console.log } = {}) {
  const src = path.resolve(from);
  const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
  if (pkg.name !== 'cloc-fusion') throw new Error(`${src} is not a cloc-fusion checkout (its package.json names ${pkg.name}).`);
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', src, 'status', '--porcelain', '--', 'src', PAGE], { encoding: 'utf8' }).trim();
    if (dirty) log(`Note: ${src} has changes not committed; the commit noted (${commit.slice(0, 12)}) does not include them.`);
  } catch {
    log('Note: not a git checkout; the commit is noted as unknown.');
  }
  const meta = { version: pkg.version, commit };
  fs.rmSync(out, { recursive: true, force: true });
  for (const file of ENGINE_FILES) {
    const text = fs.readFileSync(path.join(src, 'src', file), 'utf8');
    fs.mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
    fs.writeFileSync(path.join(out, file), header(meta) + text);
  }
  const page = fs.readFileSync(path.join(src, PAGE));
  fs.writeFileSync(path.join(out, PAGE), page);
  const sha256 = createHash('sha256').update(page).digest('hex');
  fs.writeFileSync(
    path.join(out, 'origin.js'),
    `// Where src/cloc-fusion/ came from (written by scripts/sync-cloc-fusion.mjs; do not edit).\nexport const CLOC_FUSION = Object.freeze({ version: ${JSON.stringify(meta.version)}, commit: ${JSON.stringify(commit)}, page: ${JSON.stringify(PAGE)}, sha256: ${JSON.stringify(sha256)}, bytes: ${page.length} });\n`,
  );
  fs.writeFileSync(path.join(out, 'LICENSE'), MIT('cxsmtp'));
  fs.writeFileSync(path.join(out, 'README.md'), readme({ ...meta, sha256, bytes: page.length }));
  log(`cloc-fusion ${meta.version} (${commit.slice(0, 12)}): ${ENGINE_FILES.length} engine files and ${PAGE} (SHA-256 ${sha256}) copied to ${path.relative(ROOT, out) || out}.`);
  return { ...meta, sha256 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const from = process.argv[2];
  if (!from) {
    console.error('Usage: node scripts/sync-cloc-fusion.mjs /path/to/cloc-fusion');
    process.exit(1);
  }
  try {
    syncClocFusion(from);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
