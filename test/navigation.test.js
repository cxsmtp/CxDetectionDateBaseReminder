// The menu and Settings, as files: what exists stays reachable, by the same people, however it is grouped.
// Every routed page has its menu item behind the same permissions, every Settings link has its section,
// and every address and saved choice from before still leads somewhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const html = read('public/index.html');
const app = read('public/app.js');

/** The attributes of one opening tag: { class: 'tab', 'data-route': 'credits', 'data-advanced': '' }. */
const attrs = (text) => Object.fromEntries([...text.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((m) => [m[1], m[2] ?? '']));
/** The opening tags of one kind inside a piece of the page, in order. */
const tags = (piece, names) => [...piece.matchAll(new RegExp(`<(${names})\\b([^>]*)>`, 'g'))].map((m) => ({ tag: m[1], ...attrs(m[2]) }));
const between = (start, end) => {
  const from = html.indexOf(start);
  assert.ok(from >= 0, `the page has ${start}`);
  return html.slice(from, html.indexOf(end, from));
};
/** A permission gate, whatever order it is written in. */
const gate = (list) => String(list ?? '').split(/\s+/).filter(Boolean).sort().join(' ');

const menu = tags(between('<nav class="nav" id="nav"', '</nav>'), 'p|a');
const menuItems = menu.filter((el) => el.tag === 'a' && el['data-route']);
const settingsNav = tags(between('<nav class="set-nav" id="set-nav"', '</nav>'), 'p|a');
const settingsLinks = settingsNav.filter((el) => el.tag === 'a' && el['data-set']);
const sections = Object.fromEntries([...html.matchAll(/<section class="panel[^"]*" id="set-([a-z]+)"([^>]*)>/g)].map((m) => [m[1], attrs(m[2])]));

/** PAGE_PERMS in public/app.js: which permissions open each page (any one of them). */
const pagePerms = (() => {
  const body = app.slice(app.indexOf('const PAGE_PERMS = {'), app.indexOf('\n};', app.indexOf('const PAGE_PERMS = {')));
  return Object.fromEntries([...body.matchAll(/^ {2}(\w+): '([^']*)'/gm)].map((m) => [m[1], m[2]]));
})();

// What the menu held before it was flattened (MZ-01.01.11), and who could open each page.
const PAGES_BEFORE = {
  dashboard: '',
  automation: 'settings.view settings.automation',
  reports: 'reports.view',
  credits: 'credits.view',
  impact: 'reports.view',
  audit: 'audit.view backup.view',
  calculator: 'projections.use',
  access: 'iam.view',
  settings: '',
  logs: '',
  beta: 'feature.codeAuthors feature.identityMatching',
  fusion: 'feature.fusionResults',
  flush: 'feature.faeFlush',
  status: 'feature.statusBoard',
  consolidated: 'feature.consolidated',
  govern: 'feature.govern',
};

// Every Settings section before the flattening: [who sees its link, who sees its panel, who may change it].
// Besides these, everything outside "You" needs settings.view (checked below).
const SETTINGS_BEFORE = {
  profile: ['', '', ''],
  appearance: ['', '', ''],
  mybrand: ['branding.personal', 'branding.personal', ''],
  import: ['integration.cxone integration.smtp settings.links beta.use', 'integration.cxone integration.smtp settings.links beta.use', ''],
  handsoff: ['settings.automation settings.view', 'settings.automation settings.view', 'settings.automation'],
  connection: ['', '', 'integration.cxone'],
  smtp: ['', '', 'integration.smtp'],
  network: ['integration.cxone integration.smtp', 'integration.cxone integration.smtp', 'integration.cxone'],
  endpoint: ['', '', 'integration.cxone'],
  initiators: ['', '', 'settings.initiators'],
  template: ['', '', 'settings.template'],
  sla: ['feature.sla', 'feature.sla', 'settings.automation'],
  ai: ['', '', 'settings.ai'],
  server: ['', '', 'settings.links'],
  links: ['', '', 'settings.links'],
  branding: ['branding.view settings.branding', 'branding.view settings.branding', 'settings.branding'],
  https: ['security.https', 'security.https', ''],
  features: ['features.manage', 'features.manage', ''],
  activation: ['activation.manage activation.view', 'activation.manage activation.view', ''],
  tenants: ['tenants.manage', 'tenants.manage', ''],
  support: ['support.manage', '', 'support.manage'],
  update: ['system.update', 'system.update', ''],
  about: ['', '', ''],
};
/** Sections shown only with "Show advanced options" on. */
const ADVANCED_BEFORE = ['endpoint', 'template', 'links'];
/** Sections that are now a part of another one: old name → the section that holds it. */
const FOLDED_INTO = {};

/** Old Settings section names that lead to another section (public/app.js), if any. */
const settingsAliases = (() => {
  const found = /const SETTINGS_ALIASES = (\{[^}]*\});/.exec(app);
  return found ? Object.fromEntries([...found[1].matchAll(/(\w+): '(\w+)'/g)].map((m) => [m[1], m[2]])) : {};
})();

test('every page that can be opened has its place in the menu, behind the same permissions', () => {
  assert.deepEqual(Object.keys(pagePerms).sort(), [...Object.keys(PAGES_BEFORE), 'help'].sort(), 'the pages are the ones there were, plus Get help');
  for (const [page, perms] of Object.entries(pagePerms)) {
    assert.match(html, new RegExp(`<div id="page-${page}"`), `page-${page} is in the page`);
    if (page === 'help') continue; // opened from Get help, never from the menu
    assert.equal(gate(perms), gate(PAGES_BEFORE[page]), `${page} opens for whoever it opened for`);
    const items = menuItems.filter((a) => a['data-route'] === page);
    assert.equal(items.length, 1, `${page} is in the menu once`);
    assert.equal(items[0].href, `#/${page}`, `${page}: its address has not changed`);
    assert.equal(gate(items[0]['data-perm']), gate(perms), `${page}: the menu item shows for whoever may open the page`);
  }
  assert.equal(menuItems.length, Object.keys(PAGES_BEFORE).length, 'and the menu holds nothing else');
});

test('every menu item sits under a group heading that shows whenever the item can', () => {
  let heading = null;
  for (const el of menu) {
    if (el.tag === 'p' && /\bnav-group\b/.test(el.class)) heading = el;
    if (el.tag !== 'a' || !el['data-route']) continue;
    assert.ok(heading, `${el['data-route']} comes after a heading`);
    // Labs (and Govern until it is final) move when a feature is made final: checked in the browser.
    if (heading['data-perm'] === 'labs.active') continue;
    if (!heading['data-perm']) continue;
    const needs = gate(heading['data-perm']).split(' ');
    for (const perm of gate(el['data-perm']).split(' ')) {
      // Known before the flattening: Impact (reports.view) under Prove, whose heading did not list it.
      if (el['data-route'] === 'impact' && heading['data-stage'] === 'prove' && !heading['data-group']) continue;
      assert.ok(needs.includes(perm), `${el['data-route']} (${perm}) can show without its heading (${heading['data-perm']})`);
    }
  }
});

test('every Settings link has its section, shown and changed by the same people', () => {
  const names = settingsLinks.map((a) => a['data-set']);
  assert.equal(new Set(names).size, names.length, 'no section is listed twice');
  for (const a of settingsLinks) {
    const name = a['data-set'];
    assert.equal(a.href, `#/settings/${name}`, `${name}: its address has not changed`);
    assert.ok(sections[name], `Settings → ${name} has a section set-${name}`);
    const before = SETTINGS_BEFORE[name];
    assert.ok(before, `${name} was a Settings section before`);
    assert.equal(gate(a['data-perm']), gate(before[0]), `${name}: the link shows for whoever saw it`);
    assert.equal(gate(sections[name]['data-perm']), gate(before[1]), `${name}: the section shows for whoever saw it`);
    assert.equal(gate(sections[name]['data-edit-perm']), gate(before[2]), `${name}: changed by whoever could change it`);
    assert.equal('data-advanced' in a, ADVANCED_BEFORE.includes(name), `${name}: an advanced option, or not, as before`);
  }
  // Nothing went missing: a section is listed, or it is now a part of another one that the same people may change.
  for (const [name, before] of Object.entries(SETTINGS_BEFORE)) {
    if (names.includes(name)) continue;
    const host = FOLDED_INTO[name];
    assert.ok(host && names.includes(host), `${name} is listed in Settings, or is a part of a section that is`);
    const part = new RegExp(`<details class="disclosure" id="set-part-${name}" data-advanced>`);
    assert.match(html, part, `${name} is an advanced part of ${host}`);
    const hostHtml = html.slice(html.indexOf(`id="set-${host}"`), html.indexOf('</section>', html.indexOf(`id="set-${host}"`)));
    assert.match(hostHtml, part, `inside set-${host}`);
    assert.equal(gate(SETTINGS_BEFORE[host][0]), gate(before[0]), `${name}: seen by whoever sees ${host}`);
    assert.equal(gate(SETTINGS_BEFORE[host][2]), gate(before[2]), `${name}: changed by whoever changes ${host}`);
    assert.ok(ADVANCED_BEFORE.includes(name), `${name} was an advanced option already`);
    assert.equal(settingsAliases[name], host, `#/settings/${name} opens ${host}`);
  }
  // Automation's link leaves Settings for its own page, for the people who may open that page.
  const out = settingsNav.filter((el) => el.tag === 'a' && !el['data-set']);
  assert.deepEqual(out.map((a) => [a.href, gate(a['data-perm'])]), [['#/automation', gate(PAGES_BEFORE.automation)]]);
});

test('every old address and saved choice still leads somewhere', () => {
  // Pages renamed long ago, and Automation's old place in Settings.
  const aliases = Object.fromEntries([.../const ROUTE_ALIASES = \{([^}]*)\}/.exec(app)[1].matchAll(/'?([\w-]+)'?: '(\w+)'/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(aliases, { iam: 'access', 'credit-control': 'credits' });
  for (const target of Object.values(aliases)) assert.ok(target in pagePerms, `${target} is a page`);
  assert.match(app, /if \(location\.hash === '#\/settings\/automation'\) history\.replaceState\(null, '', '#\/automation'\);/);
  // #/settings/<name>, and the section kept in the browser (mz-settings-section): a link of that name, or one it now leads to.
  const names = settingsLinks.map((a) => a['data-set']);
  for (const name of Object.keys(SETTINGS_BEFORE)) {
    const target = settingsAliases[name] ?? name;
    assert.ok(names.includes(target), `#/settings/${name} opens a section (${target})`);
  }
  for (const [from, to] of Object.entries(settingsAliases)) {
    assert.ok(!names.includes(from) && names.includes(to), `${from} → ${to}: an old name to a section there is`);
  }
  assert.match(app, /const SETTINGS_KEY = 'mz-settings-section';/);
  // Pinned pages (mz-nav-pins) are kept by route: every route there was is still a menu item (checked above).
  assert.match(app, /const NAV_PINS_KEY = 'mz-nav-pins';/);
  assert.match(app, /const NAV_FOLDS_KEY = 'mz-nav-folded';/);
});

test('Settings outside "You" still needs settings.view', () => {
  const line = app.split('\n').find((l) => l.includes("classList.toggle('no-settings', !settingsToo)"));
  assert.ok(line, 'one line hides the rest of Settings from whoever lacks settings.view');
  const open = [...line.matchAll(/:not\(\[data-set="(\w+)"\]\)/g)].map((m) => m[1]);
  assert.deepEqual(open, ['profile', 'appearance', 'mybrand'], 'only the sections under You are for everyone');
  assert.match(line, /#set-nav \.set-group:not\(\.set-you\)/, 'and only the You heading');
  assert.match(app, /const settingsToo = can\('settings\.view'\);/);
});
