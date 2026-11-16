// The server is called "CxMissionZero server" wherever people read it: the page, the emailed report, the emails,
// the documents and every language. Before MZ-01.01.13 it was called by the two words put together below; only the
// change log and the past security reviews, which say what was true then, still use them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BEFORE = new RegExp(['reminder', 'server'].join('[ -]?'), 'i');
const TEXT = /\.(js|mjs|cjs|json|md|html|css|cmd|env|txt|yml)$/;
const LEFT_ALONE = (rel) => rel === 'CHANGELOG.md' || rel.startsWith(`docs${path.sep}security${path.sep}`);

function* files(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (TEXT.test(entry.name)) yield full;
  }
}

test('nothing people read still calls the server by its old name', () => {
  const found = [];
  const places = ['src', 'public', 'docs', 'i18n', 'scripts', 'loadtest'].flatMap((dir) => [...files(path.join(ROOT, dir))]).concat(['README.md', 'CONTRIBUTING.md', 'CLAUDE.md'].map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f)));
  for (const file of places) {
    const rel = path.relative(ROOT, file);
    if (LEFT_ALONE(rel)) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      // (reminderServer is a field of the HTTPS settings' answer, which programs read, not people.)
      if (BEFORE.test(line.replaceAll('reminderServer', ''))) found.push(`${rel}:${i + 1}`);
    });
  }
  assert.deepEqual(found, []);
});

test('an audit entry written under the old name is shown under today\'s', () => {
  const page = fs.readFileSync(path.join(ROOT, 'public/app/audit.js'), 'utf8');
  assert.match(page, /const SERVER_NAME_BEFORE = \['reminder', 'server'\]\.join\(' '\);/);
  assert.match(page, /actor\.user === SERVER_NAME_BEFORE \? 'CxMissionZero server' : actor\.user/);
});
