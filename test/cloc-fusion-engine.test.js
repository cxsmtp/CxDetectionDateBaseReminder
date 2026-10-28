// cloc-fusion inside CxMissionZero: its engine vendored as it is (src/cloc-fusion/, scripts/sync-cloc-fusion.mjs),
// its one-file page handed out as noted, its report imported as the new customer's projects (counts only, checked
// and capped), and a project's change frequency pricing its Fusion scans by the Fusion tab's rules, said in the
// report, the PDF and the "?" of every number.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ENGINE_FILES, header, syncClocFusion } from '../scripts/sync-cloc-fusion.mjs';
import { CLOC_FUSION } from '../src/cloc-fusion/origin.js';
import { clocFusionPage } from '../src/fusion-git.js';
import { buildStandaloneCalculator } from '../src/standalone-calculator.js';
import { MAX_CLOC_FUSION_BYTES, newCustomerEstimate, parseClocFusionReport, suggestedScans } from '../public/calculator/model.js';
import { cleanFusionNew } from '../public/calculator/profiles.js';
import { buildReport } from '../public/calculator/report.js';
import { slideContent } from '../public/calculator/slides.js';
import { allSections } from '../public/calculator/explain.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const VENDOR = path.join(ROOT, 'src', 'cloc-fusion');
const MODELS = [{ id: 'm1', name: 'opus-5.5', creditsPer10k: 4 }, { id: 'm2', name: 'haiku-4.5', creditsPer10k: 1 }];

test('cloc-fusion\'s engine is vendored as it is: each file with its origin, the MIT licence, and its page as noted', () => {
  assert.match(CLOC_FUSION.version, /^\d+\.\d+\.\d+$/);
  assert.match(CLOC_FUSION.commit, /^[0-9a-f]{40}$/);
  for (const file of ENGINE_FILES) {
    const text = fs.readFileSync(path.join(VENDOR, file), 'utf8');
    assert.ok(text.startsWith(header(CLOC_FUSION)), `${file} names where it came from`);
  }
  // Only the engine: no command line, wizard, web app, updater, AI plan or sign-in helpers.
  const all = fs.readdirSync(VENDOR, { recursive: true }).map(String).filter((f) => f.endsWith('.js')).sort();
  assert.deepEqual(all, [...ENGINE_FILES.map((f) => f.split('/').join(path.sep)), 'origin.js'].sort());
  assert.match(fs.readFileSync(path.join(VENDOR, 'LICENSE'), 'utf8'), /^MIT License\n\nCopyright \(c\) 2026 cxsmtp\n[^]*WITHOUT WARRANTY OF ANY KIND/);
  const readme = fs.readFileSync(path.join(VENDOR, 'README.md'), 'utf8');
  assert.ok(readme.includes(CLOC_FUSION.version) && readme.includes(CLOC_FUSION.commit) && readme.includes(CLOC_FUSION.sha256));
  const page = fs.readFileSync(path.join(VENDOR, CLOC_FUSION.page));
  assert.equal(createHash('sha256').update(page).digest('hex'), CLOC_FUSION.sha256);
  assert.equal(page.length, CLOC_FUSION.bytes);
  // No new runtime dependency: the engine uses Node's standard library and its own files only.
  for (const file of ENGINE_FILES) {
    for (const m of fs.readFileSync(path.join(VENDOR, file), 'utf8').matchAll(/^import\s[^;]*?from\s*'([^']+)'/gms)) assert.ok(m[1].startsWith('.') || m[1].startsWith('node:'), `${file} imports ${m[1]}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['compression', 'dotenv', 'express', 'imapflow', 'nodemailer']);
});

test('scripts/sync-cloc-fusion.mjs copies a checkout again, the same as what is here', () => {
  // A checkout of the same version, from the copy here (each file without its header).
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'cloc-fusion-checkout-'));
  fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: 'cloc-fusion', version: CLOC_FUSION.version }));
  for (const file of ENGINE_FILES) {
    fs.mkdirSync(path.dirname(path.join(checkout, 'src', file)), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'src', file), fs.readFileSync(path.join(VENDOR, file), 'utf8').slice(header(CLOC_FUSION).length));
  }
  fs.copyFileSync(path.join(VENDOR, CLOC_FUSION.page), path.join(checkout, CLOC_FUSION.page));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cloc-fusion-out-'));
  const said = [];
  const copied = syncClocFusion(checkout, { out, log: (l) => said.push(l) });
  assert.equal(copied.sha256, CLOC_FUSION.sha256);
  assert.match(said.join('\n'), /not a git checkout/);
  for (const file of ENGINE_FILES) assert.equal(fs.readFileSync(path.join(out, file), 'utf8').slice(header(copied).length), fs.readFileSync(path.join(VENDOR, file), 'utf8').slice(header(CLOC_FUSION).length), file);
  assert.throws(() => syncClocFusion(path.join(ROOT), { out, log: () => {} }), /not a cloc-fusion checkout/);
});

test('its one-file page: handed out only as noted, in the server and the launcher, and inside the calculator\'s own one-file HTML', () => {
  const page = clocFusionPage();
  assert.deepEqual([page.file, page.version, page.sha256, page.bytes], ['cloc-fusion.html', CLOC_FUSION.version, CLOC_FUSION.sha256, CLOC_FUSION.bytes]);
  assert.equal(createHash('sha256').update(page.html).digest('hex'), CLOC_FUSION.sha256);
  const file = buildStandaloneCalculator({ version: '9.9.9' });
  const island = JSON.parse(file.match(/<script type="application\/json" id="cx-cloc-fusion">([^<]*)<\/script>/)[1]);
  assert.equal(createHash('sha256').update(Buffer.from(island.base64, 'base64')).digest('hex'), CLOC_FUSION.sha256, 'opaque: nothing in it can be read as the calculator\'s own markup');
  assert.ok(!buildStandaloneCalculator({ version: '9.9.9', launcher: true }).includes('id="cx-cloc-fusion"'), 'the launcher hands it out itself');
});

test('a project whose change frequency is known gets the Fusion tab\'s scans for it; one without keeps this tab\'s default; its own scans win', () => {
  const fusion = { models: MODELS, periodMonths: 12, byFrequency: { 'more-5-week': { scans: 52, model: 'm2' }, month: { scans: 6 } } };
  const value = {
    defaultScans: 12,
    defaultModel: 'm1',
    projects: [
      { id: 'a', name: 'busy', langs: { Java: 25000 }, activity: { frequency: 'more-5-week', commits: 400, windowDays: 365, devs90: 9 } },
      { id: 'b', name: 'monthly', langs: { Go: 10000 }, activity: { frequency: 'month', commits: 12, windowDays: 365, devs90: 2 } },
      { id: 'c', name: 'cloc-only', langs: { Python: 10000 } },
      { id: 'd', name: 'pinned', langs: { Java: 10000 }, activity: { frequency: 'more-5-week', commits: 300, windowDays: 365, devs90: 4 }, scansOverride: 3 },
      { id: 'e', name: 'critical', langs: { Java: 10000 }, activity: { frequency: 'month', commits: 12, windowDays: 365 }, criticality: 5 },
    ],
  };
  const fusionWithCrit = { ...fusion, byCriticality: { 5: { scans: 26 } } };
  const est = newCustomerEstimate(value, fusionWithCrit);
  const by = Object.fromEntries(est.rows.map((r) => [r.name, r]));
  assert.deepEqual([by.busy.scans, by.busy.scansFrom, by.busy.model, by.busy.frequency, by.busy.devs90], [52, 'frequency', 'm2', 'more-5-week', 9], 'its frequency\'s scans and model, as on the Fusion tab');
  assert.equal(by.busy.credits, 3 * 52 * 1);
  assert.deepEqual([by.monthly.scans, by.monthly.scansFrom, by.monthly.model], [6, 'frequency', 'm1']);
  assert.deepEqual([by['cloc-only'].scans, by['cloc-only'].scansFrom, by['cloc-only'].frequency], [12, 'default', null], 'cloc results: this tab\'s default');
  assert.deepEqual([by.pinned.scans, by.pinned.scansFrom], [3, 'project']);
  assert.deepEqual([by.critical.scans, by.critical.scansFrom], [26, 'criticality'], 'the higher of frequency and criticality, as the Fusion tab combines them');
  assert.deepEqual([est.totals.byRule, est.totals.byDefault, est.totals.byProject, est.totals.developers, est.totals.withActivity], [3, 1, 1, 15, 4]);
  assert.equal(est.byFrequency.find((b) => b.id === 'more-5-week').projects, 2);
  // A frequency's rule the Fusion tab has not changed: its suggested scans.
  const plain = newCustomerEstimate({ projects: [{ id: 'x', name: 'x', langs: { Java: 1 }, activity: { frequency: '2-weeks' } }] }, { models: MODELS });
  assert.equal(plain.rows[0].scans, suggestedScans('2-weeks', 12));
  // A customer saved before (no activity): exactly as before.
  const old = newCustomerEstimate(cleanFusionNew({ defaultScans: 12, projects: [{ name: 'legacy', langs: { Go: 100 } }] }), { models: MODELS });
  assert.deepEqual([old.rows[0].scans, old.rows[0].scansFrom], [12, 'default']);
});

/** A report as cloc-fusion 1.3.x writes it (src/report/build.js), with what this calculator must never keep. */
function clocFusionReport() {
  const repo = (over) => ({
    connection: 'github', provider: 'github', org: 'globex', analyzedAt: '2026-10-27T10:00:00.000Z', defaultBranch: 'main', branch: 'main', headSha: '3f2a1c9d00000000000000000000000000000000', cloneUrl: 'https://github.com/globex/claims-portal.git',
    loc: 120000, windowDays: 365, commits: 400, frequency: 'more-5-week', lastCommitAt: '2026-10-26T09:00:00.000Z', devs90: 6, bots90: 1, criticality: null, scansOverride: null, modelOverride: null,
    contributors90: [{ email: 'ana@globex.io', name: 'Ana Silva', commits: 40, bot: false }],
    languages: { Java: { category: 'code', files: 300, code: 110000, comment: 9000, blank: 12000 }, YAML: { category: 'data', files: 4, code: 300, comment: 10, blank: 3 } },
    ...over,
  });
  return {
    tool: 'cloc-fusion', version: '1.3.2', generatedAt: '2026-10-27T10:05:00.000Z',
    settings: { windowDays: 365, connections: [{ name: 'github', provider: 'github' }], fusion: { models: [{ id: 'fast', name: 'Haiku-4.5', creditsPer10k: 1 }] } },
    developers: { windowDays: 90, total: 7, bots: 1, repos: 3 },
    contributors: [{ name: 'Ana Silva', email: 'ana@globex.io', repos: ['globex/claims-portal'] }],
    repos: [
      repo({ name: 'claims-portal', fullName: 'globex/claims-portal' }),
      repo({ name: 'claims-portal', fullName: 'initech/claims-portal', org: 'initech', cloneUrl: 'https://github.com/initech/claims-portal.git', commits: 3, frequency: 'year', devs90: 1, criticality: 4, scansOverride: 8, modelOverride: 'fast', languages: { Go: { category: 'code', files: 2, code: 900 } } }),
      repo({ name: 'skipped', fullName: 'globex/skipped', skip: 'archived' }),
      repo({ name: 'broken', fullName: 'globex/broken', error: 'refused', analyzedAt: undefined }),
    ],
  };
}

test('a cloc-fusion report becomes the same projects: counts only, checked and capped, its plan\'s hints kept', () => {
  // A crafted name among the languages: never an object's own key.
  const text = JSON.stringify(clocFusionReport()).replace('"YAML":', '"__proto__":{"category":"code","files":1,"code":5},"constructor":{"code":1},"YAML":');
  assert.match(text, /__proto__/);
  const found = parseClocFusionReport(text, 'C:\\out\\cloc-fusion-report.json', { models: MODELS });
  assert.deepEqual([found.projects.length, found.skipped, found.developers, found.version], [2, 2, 7, 'cloc-fusion 1.3.2'.split(' ')[1]]);
  const [a, b] = found.projects;
  assert.deepEqual(a.langs, { Java: 110000, YAML: 300 }, 'by language, for the languages left out; never an object\'s own key');
  assert.deepEqual(a.activity, { commits: 400, windowDays: 365, lastCommitAt: '2026-10-26T09:00:00.000Z', frequency: 'more-5-week', devs90: 6, engine: 'report' });
  assert.equal(a.file, 'cloc-fusion-report.json');
  assert.equal(a.git.url, 'https://github.com/globex/claims-portal.git');
  assert.deepEqual([b.criticality, b.scansOverride, b.modelOverride], [4, 8, 'm2'], 'a model pinned there is this calculator\'s model of the same name');
  // Saved: counts only, never a name or an email from its contributors.
  const saved = cleanFusionNew({ projects: found.projects });
  const kept = JSON.stringify(saved);
  assert.ok(!kept.includes('ana@globex.io') && !kept.includes('Ana Silva'));
  assert.equal(saved.projects[0].activity.frequency, 'more-5-week');
  assert.equal(saved.projects[0].git.commit, '3f2a1c9d0000');
  // Priced: by its change frequency, its own scans where its plan pinned them.
  const est = newCustomerEstimate({ ...saved, defaultScans: 12 }, { models: MODELS });
  assert.deepEqual(est.rows.map((r) => [r.scans, r.scansFrom]), [[52, 'frequency'], [8, 'project']]);
  // Not a report, or too big: said.
  for (const bad of ['{"tool":"other","repos":[]}', 'not json', '{"tool":"cloc-fusion"}', '[]']) assert.throws(() => parseClocFusionReport(bad, 'x.json'), (error) => error.notReport && /not a cloc-fusion report/.test(error.message), bad);
  assert.throws(() => parseClocFusionReport(' '.repeat(MAX_CLOC_FUSION_BYTES + 1), 'big.json'), /over 64 MB/);
  // A frequency it does not say is worked out from its commits, as cloc-fusion does.
  const odd = clocFusionReport();
  odd.repos[0].frequency = 'hourly';
  odd.repos[0].commits = 26;
  assert.equal(parseClocFusionReport(JSON.stringify(odd), 'r.json').projects[0].activity.frequency, '2-weeks');
});

test('the report, its PDF and the "?" say where the new customer\'s Fusion scans came from, and the total counts both Fusion parts', () => {
  const fusion = { models: MODELS, periodMonths: 12 };
  const est = newCustomerEstimate({ defaultScans: 12, defaultModel: 'm1', projects: [{ id: 'a', name: 'payments-api', langs: { Java: 25000 }, activity: { frequency: 'more-5-week', commits: 400, windowDays: 365, devs90: 9 } }, { id: 'b', name: 'legacy', langs: { Go: 10000 } }] }, fusion);
  const fusionNew = { periodMonths: 12, defaultScans: 12, defaultModel: 'm1', models: MODELS, rules: est.settings.byFrequency, leftOut: [], byModel: est.byModel, byFrequency: est.byFrequency, totals: est.totals, rows: est.rows.map((r) => ({ name: r.name, included: true, lines: r.lines, units: r.units, frequency: r.frequency, commits: r.commits, windowDays: 365, devs90: r.devs90, scans: r.scans, scansFrom: r.scansFrom, model: r.model, credits: r.credits, languages: r.languages })) };
  const data = { customer: 'Globex', generatedAt: '2026-10-28T10:00:00Z', months: 12, summary: { settings: {} }, tr: null, fusion: null, fusionNew };
  const html = buildReport(data, {});
  assert.match(html, /Fusion scans: 1 projects by how often they change \(commits on the default branch, as on the Fusion tab\), 1 at the default of 12, 0 set for the project\./);
  assert.match(html, /<th>Change frequency<\/th><th>Developers \(90 days\)<\/th>/);
  assert.match(html, /More than 5 times a week <small>\(400 commits in 365 days\)<\/small>/);
  assert.match(html, /Developers in the last 90 days \(added up per project\)/);
  const { pages } = slideContent(data, {});
  assert.ok(pages.find((p) => p.kind === 'fusion').lines.some((l) => /New customer Fusion scans: 1 projects by how often they change/.test(l)));
  const words = { w: (text, ...args) => text.replace(/\{(\d+)\}/g, (_, i) => args[i]), num: (n) => String(n ?? '—') };
  const sections = allSections(data, words);
  const fresh = sections.find((s) => s.key === 'fusion-new-credits');
  assert.ok(fresh.lines.some((l) => /More than 5 times a week: 1 projects, 52 Fusion scans each/.test(l.text)));
  const total = sections.find((s) => s.key === 'total');
  assert.match(total.lines[0].text, new RegExp(`Fusion ${est.totals.credits} =`), 'the total counts the new customer\'s part');
});
