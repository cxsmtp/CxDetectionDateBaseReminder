// Collect the page's English wording for translation: start the app against the mock Checkmarx One,
// visit every page, tab, settings section, panel and dialog, and record each piece of text the
// way public/i18n.js will look it up. Writes i18n/catalog.json (English, with where each piece was
// seen); the translations live in public/i18n/<code>.json.
//
//   node scripts/i18n-collect.mjs            (needs Playwright: PLAYWRIGHT=/path/to/playwright/index.mjs)
//
// Maintainers run it after changing the page's wording; `npm test` then lists what each
// language is missing.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const MOCK_PORT = 47391;
const APP_PORT = 47392;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const KEY = `${b64({ alg: 'none' })}.${b64({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' })}.sig`;
const PASSWORD = 'correct horse battery 1';
const children = [];
const stop = () => children.forEach((child) => child.kill());

function start(env) {
  let log = '';
  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(APP_PORT), HOST: '127.0.0.1', HTTPS: 'off', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-')), BACKUP_INTERVAL_HOURS: '0', CX_API_KEY: KEY, CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme', SMTP_HOST: '', GITHUB_TOKEN: '', UPDATE_IMAGE: '127.0.0.1:1/none/none', ...env },
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  children.push(server);
  return { server, ready: async () => { for (let i = 0; i < 200 && !/running on/.test(log); i++) await new Promise((r) => setTimeout(r, 100)); } };
}

const found = new Map(); // key → { kind, places:Set }
const where = { place: '' };
const record = (items) => {
  for (const { key, kind, tag, near } of items) {
    const entry = found.get(key) ?? { kind, places: new Set() };
    entry.places.add([where.place, tag, near].filter(Boolean).join(' › '));
    found.set(key, entry);
  }
};

children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '14', RISKS: '8', SHARED: '1', FLIP_MS: '500' }, stdio: 'ignore' }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const dialogs = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    d.type() === 'prompt' ? d.dismiss() : d.accept();
  });
  const grab = async (place, wait = 500) => {
    await page.waitForTimeout(wait);
    where.place = place;
    record(await page.evaluate(async () => (await import('/i18n.js')).collect()));
  };
  const click = async (selector, place, wait) => {
    const target = page.locator(selector).first();
    if (!(await target.count()) || !(await target.isVisible().catch(() => false))) return false;
    await target.click({ timeout: 3000 }).catch(() => {});
    if (place) await grab(place, wait);
    return true;
  };

  // First start: create the first administrator.
  let app = start({ ACCEPT_TERMS: '' });
  await app.ready();
  await page.goto(BASE);
  await grab('first start');
  app.server.kill();
  await new Promise((r) => setTimeout(r, 800));

  // Signed out, then signed in with sample data.
  app = start({ ACCEPT_TERMS: 'tests@acme.io', ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: PASSWORD });
  await app.ready();
  await new Promise((r) => setTimeout(r, 1500));
  await page.goto(BASE);
  await grab('sign in');
  await page.evaluate(async (password) => {
    const post = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    await post('/api/session/password', { email: 'admin@acme.io', password });
    await post('/api/me/password', { current: password, next: `${password}2` });
  }, PASSWORD);
  await page.goto(`${BASE}/#/dashboard`);
  await page.reload();
  await grab('Dashboard', 2500);
  await page.check('#me-advanced').catch(() => {});
  await grab('Dashboard (advanced)');
  for (const chip of ['cxone', 'smtp', 'git']) await click(`[data-conn="${chip}"]`, `connection: ${chip}`);
  await page.keyboard.press('Escape');
  await click('#user-menu summary', 'user menu');
  await click('#user-menu summary');
  await page.selectOption('#activity-preset', 'any').catch(() => {});
  await page.selectOption('#detection-preset', 'any').catch(() => {});
  await click('#narrow-toggle', 'Dashboard › narrow');
  await page.click('#fetch');
  await grab('Dashboard › fetching', 300);
  await page.waitForFunction(() => !document.getElementById('fetch').disabled, null, { timeout: 60000 });
  await grab('Dashboard › loaded', 1500);
  for (const tab of ['remind', 'credits', 'people', 'track']) {
    await click(`[data-rail-open="${tab}"]`, `Dashboard › ${tab}`) || (await click(`.ptab[data-pt="${tab}"]`, `Dashboard › ${tab}`));
  }
  await click('#preview', 'Dashboard › reminder preview', 2500);
  await click('#alloc-verify', 'Dashboard › credits verify', 3000);
  await click('#projects-body td.c-half button, #projects-body [data-credit-edit]', 'Dashboard › credit editor');
  await click('#alloc-triage', 'Dashboard › allocate', 3000);
  await click('#run-triage', 'Dashboard › triage', 300);
  await grab('Dashboard › triage done', 4000);
  await page.fill('#track-name', 'Weekly').catch(() => {});
  await click('#track-save, [data-track-save], #save-tracked', 'Dashboard › track saved', 2000);
  // The Reports page's detail panel needs a saved report: save one directly when the Track panel did not.
  await page.evaluate(async () => {
    const { reports } = await (await fetch('/api/tracked-reports')).json();
    if (!reports.length) await fetch('/api/tracked-reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Weekly', severities: ['CRITICAL', 'HIGH'] }) });
  });
  await page.keyboard.press('Control+k');
  await grab('Jump to');
  await page.keyboard.type('set');
  await grab('Jump to › search');
  await page.keyboard.press('Escape');

  const routes = await page.evaluate(() => [...new Set([...document.querySelectorAll('a[data-route]')].map((a) => a.dataset.route))]);
  for (const route of routes) {
    await page.evaluate((r) => (location.hash = `#/${r}`), route);
    await grab(route, 1500);
    const tabs = await page.evaluate((r) => [...document.querySelectorAll(`#page-${r} .ptab[data-pt]`)].map((t) => t.dataset.pt), route);
    for (const tab of tabs) await click(`#page-${route} .ptab[data-pt="${tab}"]`, `${route} › ${tab}`, 900);
  }
  const sections = await page.evaluate(() => [...document.querySelectorAll('#set-nav a[href^="#/settings/"]')].map((a) => a.getAttribute('href')));
  for (const href of sections) {
    await page.evaluate((h) => (location.hash = h), href);
    await grab(`settings › ${href.split('/').pop()}`, 900);
  }
  // Your branding, on and with a name; and Activation codes as someone who may only see it.
  await page.evaluate(() => (location.hash = '#/settings/mybrand'));
  await page.check('#mb-on').catch(() => {});
  await page.fill('#mb-name', 'Globex').catch(() => {});
  await grab('settings › mybrand (on)', 1500);
  await page.uncheck('#mb-on').catch(() => {});
  await grab('settings › mybrand (off)', 1200);
  await page.evaluate(() => (location.hash = '#/settings/activation'));
  await page.evaluate(() => (document.getElementById('act-view-only').hidden = false));
  await grab('settings › activation (view only)', 600);
  // Reports: open the saved report and each of its tabs.
  await page.evaluate(() => (location.hash = '#/reports'));
  await grab('reports', 1500);
  if (await click('.rp-row', 'reports › detail', 1500)) {
    const tabs = await page.evaluate(() => [...document.querySelectorAll('#rp-sheet [data-rp-tab], #rp-sheet .ptab')].map((t) => t.dataset.rpTab ?? t.dataset.pt));
    for (const tab of tabs) await click(`#rp-sheet [data-rp-tab="${tab}"], #rp-sheet .ptab[data-pt="${tab}"]`, `reports › detail › ${tab}`, 900);
  }
  // Get help: the sidebar menu, both forms, a request just raised (with its thank-you), and the queue.
  await page.evaluate(() => (location.hash = '#/dashboard'));
  // Credit projections: none yet, then a profile with its Fusion projects read, one typed over and one added by hand.
  await page.evaluate(() => (location.hash = '#/projections'));
  await grab('projections › none', 900);
  await click('#pj-new', 'projections › new', 2000);
  await click('#page-projections .ptab[data-pt="fusion"]', 'projections › fusion', 600);
  await click('#pj-read', 'projections › read', 4000);
  await page.fill('#pj-rows tr:nth-child(1) [data-pj-loc]', '123456').catch(() => {});
  await page.press('#pj-rows tr:nth-child(1) [data-pj-loc]', 'Tab').catch(() => {});
  await click('#pj-add', 'projections › added', 1500);
  await page.fill('#pj-filter', 'zzz').catch(() => {});
  await grab('projections › no match', 400);
  await page.fill('#pj-filter', '').catch(() => {});
  await click('#pj-none', 'projections › none included', 400);
  await click('#page-projections .ptab[data-pt="alacarte"]', 'projections › à la carte', 900);
  await click('#pj-delete', 'projections › deleted', 1500);
  await page.hover('#help-open').catch(() => {});
  await grab('Get help › menu', 400);
  await page.evaluate(() => (location.hash = '#/help/enhancement'));
  await grab('help › enhancement', 900);
  await page.evaluate(() => (location.hash = '#/help/case'));
  await grab('help › case', 900);
  await page.fill('#help-subject', 'Sample').catch(() => {});
  await page.fill('#help-text', 'Sample').catch(() => {});
  await page.selectOption('#help-priority', 'high').catch(() => {});
  await click('#help-submit', 'help › raised', 2000);
  await page.selectOption('#help-whose', 'mine').catch(() => {});
  await grab('help › mine', 400);
  await page.selectOption('#help-status', 'completed').catch(() => {});
  await grab('help › filtered', 400);
  // Get help by email (Settings → Get help): the menu and the page.
  await page.evaluate(() => fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ support: { mode: 'email', email: 'support@example.com' } }) }));
  await page.reload();
  await page.evaluate(() => (location.hash = '#/help'));
  await grab('help › by email', 1500);
  await page.hover('#help-open').catch(() => {});
  await grab('Get help › menu by email', 400);
  await page.evaluate(() => (location.hash = '#/settings/support'));
  await grab('settings › support (email)', 900);
  await page.fill('#support-email', '').catch(() => {});
  await grab('settings › support (no address)', 300);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (location.hash = '#/dashboard'));
  await grab('phone', 1200);
  where.place = 'dialog';
  for (const message of dialogs) for (const line of message.split('\n')) if (line.trim()) record([{ key: line.replace(/\s+/g, ' ').trim(), kind: 'dialog', tag: '', near: '' }]);
} finally {
  await browser.close();
  stop();
}

// Wording the page builds in code and only shows while something runs.
const source = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const literal = /'((?:[^'\\\n]|\\.)*)'/g;
const block = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
where.place = 'busy line';
for (const part of [block('const ACTIVITIES = [', '\n];'), block('const PLAIN_QUIPS = [', 'const PLAIN_SLOW'), block('const PLAIN_SLOW', '\n')]) {
  for (const [, text] of part.matchAll(literal)) if (/\p{L}/u.test(text) && !/^(GET|POST|PUT|DELETE|PATCH)$/.test(text)) record([{ key: text.replace(/\\'/g, "'"), kind: 'busy', tag: '', near: '' }]);
}

// Messages shown after an action (status lines, toasts, button labels set in code): plain text,
// and text built only from numbers ("Take back ${n} unused credits").
where.place = 'message';
const NUMERIC = /^(?:[\w.?]*(?:length|count|size|total|seconds|minutes|hours|days|Days|pct|remaining|used|allocated|left|short|needed|sent|n|done|failed|skipped|rows|risks|projects)\b[\w.?() ]*|fmt\([^)]*\))$/;
const MESSAGE_LINE = /\b(setStatus|followStatus|toast|showToast|statusLine)\(|\.(textContent|title|placeholder)\s*=|\bconfirm\(|\balert\(/;
for (const line of source.split('\n')) {
  if (!MESSAGE_LINE.test(line)) continue;
  for (const [, text] of line.matchAll(literal)) {
    if (/^[A-Z][^]*\p{L}/u.test(text) && !/^[A-Z_]+$|^(GET|POST|PUT|DELETE)\b|^[a-z-]+$|\//.test(text)) record([{ key: text.replace(/\\'/g, "'").replace(/\\n/g, ' '), kind: 'message', tag: '', near: '' }]);
  }
  for (const [, whole] of line.matchAll(/`((?:[^`\\]|\\.)*)`/g)) {
    const body = whole.replace(/\$\{[^}]*$/, ''); // a template nested inside: its outer text only
    const parts = [...body.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim());
    if (!parts.length || !parts.every((expression) => NUMERIC.test(expression))) continue;
    if (!/^[A-Z$]/.test(body) || /[<>]|\//.test(body)) continue;
    let i = 0;
    record([{ key: body.replace(/\$\{[^}]*\}/g, () => `${i++}`).replace(/\s+/g, ' ').trim(), kind: 'message', tag: '', near: '' }]);
  }
}

// Numbers become {0}, {1}…; sample data (names, addresses) is left out.
const SAMPLE = /@|\bProject \d|\bProjection \d|\bFinding p\d|\bp\d+-r\d|\bdev-?\d|\bWeekly\b|acme|127\.0\.0\.1|\bsim-|handler\d|file\d\.js|correct horse/i;
const catalog = {};
for (const [key, { kind, places }] of [...found].sort(([a], [b]) => a.localeCompare(b))) {
  if (SAMPLE.test(key)) continue;
  const pattern = key.replace(/\d+/g, (() => { let i = 0; return () => `{${i++}}`; })());
  if (!/\p{L}/u.test(pattern.replace(/\{\d+\}/g, ''))) continue;
  if (/^(https?:\/\/|\/)\S*$/.test(pattern)) continue; // an address or a path, not wording
  const entry = (catalog[pattern] ??= { kind, seen: [] });
  for (const place of places) if (entry.seen.length < 3 && !entry.seen.includes(place)) entry.seen.push(place);
}
fs.mkdirSync(path.join(ROOT, 'i18n'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'i18n/catalog.json'), `${JSON.stringify(catalog, null, 1)}\n`);
console.log(`${Object.keys(catalog).length} pieces of English → i18n/catalog.json`);
process.exit(0);
