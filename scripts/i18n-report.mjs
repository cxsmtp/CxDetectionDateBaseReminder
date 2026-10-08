// Collect the interactive report's English wording, for the translations a report carries with it:
// what its script writes (every L('…') in src/report/report.client.js, and its word tables), the
// fix advice it shows (src/fix-advice.js), and what the report's page says, read the way
// public/i18n.js looks it up from sample reports that between them show every part of the page.
// Writes i18n/report-keys.json and adds what is new to i18n/catalog.json (kind "report"); `npm test`
// then lists what each language is missing.
//
//   node scripts/i18n-report.mjs            (needs Playwright: PLAYWRIGHT=/path/to/playwright/index.mjs)
//   node scripts/i18n-report.mjs --static   only what the script itself writes (no browser), to check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { adviceTexts } from '../src/fix-advice.js';
import { generateHtmlReport } from '../src/html-report.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = fs.readFileSync(path.join(ROOT, 'src/report/report.client.js'), 'utf8');

/** A JavaScript string literal's text ('…' or "…", no template). */
const unquote = (literal) => JSON.parse(literal[0] === '"' ? literal : `"${literal.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`);
const LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g;

/** The first argument of every L(…) and fail(…) call: each string literal in it (a ternary names two). */
export function clientKeys(source = CLIENT) {
  const keys = new Set();
  for (const name of ['L(', 'fail(']) for (let at = source.indexOf(name); at !== -1; at = source.indexOf(name, at + name.length)) {
    if (/[\w$.`]/.test(source[at - 1] ?? '')) continue; // fooL(, x.L( or one in a comment's `code`
    let depth = 0;
    let end = at + name.length;
    let quote = '';
    for (; end < source.length; end += 1) {
      const c = source[end];
      if (quote) {
        if (c === '\\') end += 1;
        else if (c === quote) quote = '';
        continue;
      }
      if (c === "'" || c === '"' || c === '`') quote = c;
      else if ('([{'.includes(c)) depth += 1;
      else if (')]}'.includes(c)) {
        if (depth === 0) break;
        depth -= 1;
      } else if (c === ',' && depth === 0) break;
    }
    for (const [literal] of source.slice(at + name.length, end).matchAll(LITERAL)) {
      const text = unquote(literal);
      if (/\p{L}/u.test(text)) keys.add(text);
    }
  }
  // The word tables the script looks up by status (VERDICT_WORDS, BULK_WORDS…), and the names of its tools.
  const block = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  for (const part of ['const VERDICT_WORDS = {', 'const SUB_WORDS = {', 'const BULK_WORDS = {', 'const STATE_WORDS = {', 'const KIND_LABELS = {'].map((start) => block(start, '};'))) {
    for (const [literal] of part.matchAll(LITERAL)) {
      const text = unquote(literal);
      if (/\s|^[A-Z][a-z]/.test(text) && !/^(bad|good|warn|muted|busy)$/.test(text)) keys.add(text);
    }
  }
  for (const [, name] of block('const FIXERS = [', '];').matchAll(/name: '([^']+)'/g)) if (name !== 'git apply') keys.add(name);
  for (const [, name] of block('const OPENERS = [', ';\n').matchAll(/name: '([^']+)'/g)) keys.add(name);
  return keys;
}

/** Sample reports that between them show every part of the report's page. */
function sampleReports() {
  const risk = (n, extra) => ({ title: `Finding ${n}`, severity: 'HIGH', state: 'TO_VERIFY', scanner: 'SAST', ageDays: n, location: `src/f${n}.js`, riskId: `r${n}`, alternateId: `a${n}`, groupId: `g${n}`, scanId: 's', url: `https://cx.example/r${n}`, ...extra });
  const sign = () => ({ exp: 1, grant: 'g' });
  // Enough to need "Showing 50 of …", low and new, so the rows above stay among those shown.
  const many = Array.from({ length: 60 }, () => risk(0, { severity: 'LOW', ageDays: 0 }));
  const one = {
    generatedAt: '2026-10-08 10:00',
    projects: [{ projectId: 'p1', projectName: 'Sample', risks: [
      risk(1, { severity: 'CRITICAL', state: 'CONFIRMED', aiReachability: 'REACHABLE', aiExploitability: 'EXPLOITABLE' }),
      risk(2, { alternateId: 'shared', location: 'src/a.js' }), risk(3, { alternateId: 'shared', location: 'src/b.js' }),
      risk(4, { alternateId: '', groupId: 'gs', location: '' }), risk(5, { alternateId: '', groupId: 'gs', location: '' }),
      risk(6, { alternateId: '', groupId: '', riskId: 'rs', location: 'src/c.js' }), risk(7, { alternateId: '', groupId: '', riskId: 'rs', location: 'src/c.js' }),
      risk(8, { scanner: 'SCA', state: 'URGENT', fixVersion: '2.0.0' }),
      risk(9, { scanner: 'KICS', severity: 'MEDIUM' }), { title: 'Unknown', severity: 'LOW', ageDays: 1 },
      { title: 'No ids', severity: 'LOW', scanner: 'SAST', state: 'NOT_EXPLOITABLE', ageDays: 2 },
      risk(90, { state: 'PROPOSED_NOT_EXPLOITABLE' }),
      ...['CONTAINERS', 'APISEC', 'SECRETS', 'IAC'].map((scanner, i) => risk(70 + i, { scanner, severity: 'MEDIUM' })),
      ...many,
    ] }],
  };
  const two = {
    generatedAt: '2026-10-08 10:00',
    projects: [
      { projectId: 'p1', projectName: 'One', risks: [risk(1), ...many] },
      { projectId: 'p2', projectName: 'Two', risks: [risk(2, { scanner: 'CONTAINERS', url: '' })] },
    ],
  };
  const small = { generatedAt: '2026-10-08 10:00', projects: [{ projectId: 'p1', projectName: 'One', risks: [risk(1)] }, { projectId: 'p2', projectName: 'Two', risks: [risk(2)] }] };
  const single = { generatedAt: '2026-10-08 10:00', projects: [{ projectId: 'p1', projectName: 'One', risks: [risk(1, { url: '' })] }] };
  const project = () => ({ exp: 1, sig: 's' });
  return [
    // With languages to pick from: the picker's label.
    generateHtmlReport(one, { relayUrl: 'https://mz.example', remediationViaRelay: true, sign, connection: { tenant: 'acme' }, i18n: { languages: [['en', 'English'], ['ja', '日本語']], strings: { ja: { x: 'y' } }, fetch: true } }),
    generateHtmlReport(two, { sign, signProjectReport: project }),
    generateHtmlReport(small, { relayUrl: 'https://mz.example', sign, signProjectReport: project, remediationViaRelay: true }),
    generateHtmlReport(single, { relayUrl: 'https://mz.example', sign }),
  ];
}

/** What the page says, as public/i18n.js looks it up, and the data-l wording the script rewrites. */
async function pageKeys() {
  const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
  const i18n = fs.readFileSync(path.join(ROOT, 'public/i18n.js'), 'utf8');
  const browser = await chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
  const keys = new Set();
  try {
    const page = await browser.newPage();
    for (const html of sampleReports()) {
      // The page as the server wrote it, before its script changes anything.
      await page.setContent(html.replace(/<script(?![^>]*application\/json)[^>]*>[^]*?<\/script>/g, ''));
      // A tooltip the script writes again from data-l-title is not looked up as it stands.
      await page.evaluate(() => document.querySelectorAll('[data-l-title]').forEach((el) => el.removeAttribute('title')));
      await page.addScriptTag({ type: 'module', content: `${i18n}\nwindow.collected = collect().map((x) => x.key);` });
      await page.waitForFunction(() => Array.isArray(window.collected));
      const found = await page.evaluate(() => [
        ...window.collected,
        ...[...document.querySelectorAll('[data-l]')].map((el) => el.dataset.l),
        ...[...document.querySelectorAll('[data-l-title]')].map((el) => el.dataset.lTitle),
      ]);
      for (const key of found) {
        // Numbers become {0}, {1}… (as the translator looks them up); a sample's own words are left out.
        const pattern = /\{\d+\}/.test(key) ? key : key.replace(/\d+/g, (() => { let i = 0; return () => `{${i++}}`; })());
        // Engine names (a cell's tooltip) and the address placeholder stay as they are.
        if (/^(SAST|SCA|KICS|IAC|CONTAINERS|APISEC|SECRETS)$|^https?:/.test(pattern)) continue;
        if (/\p{L}/u.test(pattern.replace(/\{\d+\}/g, '')) && !/^(Sample|One|Two|Finding \{0\}|acme)$/.test(pattern)) keys.add(pattern);
      }
    }
  } finally {
    await browser.close();
  }
  return keys;
}

/** Everything the report's scripts write themselves, and the advice: what needs no browser to find. */
export function scriptKeys() {
  const boot = fs.readFileSync(path.join(ROOT, 'src/report/i18n-boot.client.js'), 'utf8');
  return new Set([...clientKeys(), ...clientKeys(boot), ...adviceTexts()]);
}

const main = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
const onlyStatic = process.argv.includes('--static');
// A page word looked up in one sense ("verdict|Confirmed") falls back to the plain wording: it is listed
// only when the script has that sense too, so it needs its own translation.
const all = main ? new Set([...scriptKeys(), ...(onlyStatic ? [] : [...(await pageKeys())].filter((key) => !/^[a-z]+\|/.test(key) || scriptKeys().has(key)))]) : null;
if (!main) {
  // Imported (by the tests): nothing to write.
} else if (onlyStatic) {
  console.log([...all].sort().join('\n'));
} else {
  const keys = [...all].sort((a, b) => a.localeCompare(b));
  fs.writeFileSync(path.join(ROOT, 'i18n/report-keys.json'), `${JSON.stringify(keys, null, 1)}\n`);
  const file = path.join(ROOT, 'i18n/catalog.json');
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  let added = 0;
  for (const key of keys) {
    if (catalog[key]) continue;
    catalog[key] = { kind: 'report', seen: ['interactive HTML report'] };
    added += 1;
  }
  const sorted = Object.fromEntries(Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(file, `${JSON.stringify(sorted, null, 1)}\n`);
  console.log(`${keys.length} pieces of report wording → i18n/report-keys.json (${added} new in i18n/catalog.json)`);
}
