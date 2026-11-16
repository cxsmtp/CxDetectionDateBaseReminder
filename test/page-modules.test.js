// The page's script is public/app.js and the modules under public/app/, loaded by the browser itself (no build
// step). What holds them together, as files: every module is loaded from app.js and asked for early by index.html,
// none imports app.js back, and everything a module does when the page loads is called from app.js, once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PAGE_SCRIPT_FILES } from './page-script.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const html = read('public/index.html');
const app = read('public/app.js');
const modules = PAGE_SCRIPT_FILES.filter((file) => file !== 'public/app.js').map((file) => file.replace('public/', ''));

test('the page loads app.js as a module, and nothing else of its own script', () => {
  assert.deepEqual([...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map((m) => m[0]), ['<script type="module" src="app.js">']);
});

/** The files a file of the page's script imports, as paths under public/. */
const importsOf = (file) => [...read(`public/${file}`).matchAll(/^import (?:\{[^}]*\} from )?'([^']+)';$/gm)].map((m) => path.posix.join(path.posix.dirname(file), m[1]));

test('every module under app/ is reached from app.js and preloaded by index.html, and no preload points at nothing', () => {
  assert.ok(modules.length >= 10, `the modules are there: ${modules.join(', ')}`);
  const reached = new Set();
  const queue = ['app.js'];
  while (queue.length) {
    for (const file of importsOf(queue.pop())) {
      if (!file.startsWith('app/') || reached.has(file)) continue;
      reached.add(file);
      queue.push(file);
    }
  }
  assert.deepEqual([...reached].sort(), modules, 'app.js loads each of them, itself or through another');
  const preloaded = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)" \/>/g)].map((m) => m[1]).sort();
  assert.deepEqual(preloaded, modules, 'index.html asks for each of them at once');
});

test('no module imports the entry point, and each imports only files that exist', () => {
  for (const file of modules) {
    for (const target of importsOf(file)) {
      assert.notEqual(target, 'app.js', `${file} does not import app.js`);
      assert.ok(!target.startsWith('..') && fs.existsSync(path.join(ROOT, 'public', target)), `${file}: ${target} is a file of the page`);
    }
  }
});

test('what a module does when the page loads is in its wire…() functions, each called once from app.js', () => {
  const wired = [];
  for (const file of modules) {
    for (const [, name] of read(`public/${file}`).matchAll(/^export function (wire[A-Z]\w*)\(\) \{$/gm)) wired.push(name);
  }
  assert.ok(wired.length >= 20, `the wire functions are there: ${wired.length}`);
  assert.equal(new Set(wired).size, wired.length, 'each has its own name');
  const called = [...app.matchAll(/^(wire[A-Z]\w*)\(\);$/gm)].map((m) => m[1]);
  assert.deepEqual([...called].sort(), [...wired].sort(), 'app.js calls each of them, once');
  for (const name of wired) assert.match(app, new RegExp(`^import \\{[^}]*\\b${name}\\b[^}]*\\} from '\\./app/[\\w-]+\\.js';$`, 'm'), `${name} is imported`);
});
