// The page's script as the tests read it: public/app.js (the entry point) and the modules it imports from
// public/app/, one per page or concern. Tests that check what the page's code says look in all of them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = path.join(ROOT, 'public/app');

/** The files, from the project's folder: public/app.js first, then public/app/*.js by name. */
export const PAGE_SCRIPT_FILES = ['public/app.js', ...fs.readdirSync(MODULES).filter((f) => f.endsWith('.js')).sort().map((f) => `public/app/${f}`)];

/** All of it as one text. */
export const pageScript = () => PAGE_SCRIPT_FILES.map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
