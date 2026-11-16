// The menu and Settings, as files: what exists stays reachable, by the same people, however it is grouped.
// Every routed page has its menu item behind the same permissions, every Settings link has its section,
// and every address and saved choice from before still leads somewhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NAV_FLAT_MAX, NAV_GROUPS, OLD_NAV_GROUPS, SETTINGS_PARTS, navFoldsFrom, navIsFlat, settingsSectionFor } from '../public/nav-map.js';
import { PAGE_SCRIPT_FILES, pageScript } from './page-script.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const html = read('public/index.html');
// The page's script: public/app.js and its modules under public/app/ (test/page-script.js).
const app = pageScript();

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
/** Sections that are now an advanced part of another one: old name → the section that holds it. */
const FOLDED_INTO = { endpoint: 'connection', links: 'server' };

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

/** The pages under each heading, as the page is written (before a final feature moves): [[group, heading, [routes]]]. */
const menuGroups = (() => {
  const piece = between('<nav class="nav" id="nav"', '</nav>');
  const groups = [];
  for (const m of piece.matchAll(/<p class="nav-group[^"]*" data-group="(\w+)"[^>]*>(?:<i[^>]*><\/i>)?([^<]+)<\/p>|<a href="#\/\w+" data-route="(\w+)" class="tab"[^>]* data-group="(\w+)"/g)) {
    if (m[1]) groups.push([m[1], m[2], []]);
    else {
      assert.equal(m[4], groups.at(-1)[0], `${m[3]} folds with the heading it sits under`);
      groups.at(-1)[2].push(m[3]);
    }
  }
  return groups;
})();

test('the menu has four groups: Act, Credits, Set up and Labs', () => {
  assert.deepEqual(menuGroups, [
    ['pinned', 'Pinned', []],
    ['act', 'Act', ['dashboard', 'automation', 'reports']],
    ['credits', 'Credits', ['credits', 'impact', 'audit', 'calculator']],
    ['setup', 'Set up', ['access', 'settings', 'logs']],
    ['labs', 'Labs', ['beta', 'fusion', 'flush', 'status', 'consolidated', 'govern']],
  ]);
  assert.deepEqual(menuGroups.slice(1).map(([group]) => group), NAV_GROUPS);
  assert.equal(menuGroups.flatMap(([, , routes]) => routes).length, menuItems.length, 'every item is in a group');
  // The colour and the label beside each page title are as they were: Dashboard is still Follow up, the credit pages Prove, the calculator Plan.
  const stage = Object.fromEntries(menuItems.map((a) => [a['data-route'], a['data-stage']]));
  assert.deepEqual(stage, { dashboard: 'act', automation: 'act', reports: 'followup', credits: 'prove', impact: 'prove', audit: 'prove', calculator: 'plan', access: 'setup', settings: 'setup', logs: 'setup', beta: 'labs', fusion: 'labs', flush: 'labs', status: 'labs', consolidated: 'labs', govern: 'labs' });
  assert.match(app, /const STAGES = \{ govern: 'labs', status: 'labs', consolidated: 'labs', flush: 'labs', dashboard: 'act', automation: 'act', beta: 'labs', fusion: 'labs', reports: 'followup', credits: 'prove', impact: 'prove', audit: 'prove', calculator: 'plan', access: 'setup', settings: 'setup', logs: 'setup' \};/);
  assert.match(app, /const STAGE_LABELS = \{ act: 'Act', followup: 'Follow up', prove: 'Prove', govern: 'Govern', plan: 'Plan', setup: 'Set up', labs: 'Labs' \};/);
  assert.match(html, /<p class="sidebar-foot">Act · Follow up · Prove — down to zero<\/p>/, 'and so is the line under the menu');
});

test('a heading shows when a page under it does, and never hides one', () => {
  // No heading but Labs has permissions of its own (Impact used to show under a Prove heading that could be hidden).
  const headings = menu.filter((el) => el.tag === 'p' && /\bnav-group\b/.test(el.class));
  assert.deepEqual(headings.map((el) => [el['data-group'], el['data-perm'] ?? '']), [['pinned', ''], ['act', ''], ['credits', ''], ['setup', ''], ['labs', 'labs.active']]);
  // The page hides a heading with nothing under it for this person, and every heading in a flat list.
  const fn = app.slice(app.indexOf('function applyNavGroups() {'), app.indexOf('function toggleNavGroup('));
  assert.match(fn, /const shown = navTabs\(\)\.filter\(\(tab\) => !tab\.classList\.contains\('perm-hidden'\)\);/);
  assert.match(fn, /const flat = navIsFlat\(shown\.length\);/);
  assert.match(fn, /group\.hidden = flat \|\| !shown\.some\(\(tab\) => tab\.dataset\.group === group\.dataset\.group\);/);
  // It runs whenever what a person may do is applied, after a final feature has moved to its group.
  const stages = app.slice(app.indexOf('function renderFeatureStages() {'), app.indexOf('function placeNavTab('));
  assert.ok(stages.indexOf('applyNavGroups();') > stages.indexOf("governTab.dataset.group = governFinal ? 'credits' : 'labs';"));
  assert.match(app, /function applyPermissions\(\) \{\n {2}for \(const el of document\.querySelectorAll\('\[data-perm\]'\)\) el\.classList\.toggle\('perm-hidden', !canAny\(el\.dataset\.perm\)\);[^]*?\n {2}renderFeatureStages\(\);/);
});

test('seven pages or fewer make a flat list; more keep the groups', () => {
  assert.equal(NAV_FLAT_MAX, 7);
  assert.equal(navIsFlat(1), true);
  assert.equal(navIsFlat(7), true, 'a User: Workbench, Automation, Dashboard, Credit Control, Impact, Settings, Logs');
  assert.equal(navIsFlat(8), false);
  assert.equal(navIsFlat(16), false);
  // In a flat list the folds kept in the browser hide nothing; on a phone the sheet then has one list with no labels.
  assert.match(app, /const open = !folded\.has\(group\.dataset\.group\) \|\| \(flat && group\.dataset\.group !== 'pinned'\);/);
  assert.match(read('public/mobile.js'), /for \(const el of copy\.querySelectorAll\('\.nav-pinned-head, \.nav-pinned-empty, \.nav-pin, \.perm-hidden, \[hidden\]'\)\) el\.remove\(\);/);
});

test('final features move to their group with their pin: FAE Flush to the top of Act, Govern into Credits after Audit', () => {
  const stages = app.slice(app.indexOf('function renderFeatureStages() {'), app.indexOf('function placeNavTab('));
  assert.match(stages, /placeNavTab\(flush, final \? document\.querySelector\('#nav \.nav-group\[data-group="act"\]'\) : document\.querySelector\('#nav > a\.tab\[data-route="fusion"\]'\)\);/);
  assert.match(stages, /flush\.dataset\.group = flush\.dataset\.stage = final \? 'act' : 'labs';/);
  assert.match(stages, /placeNavTab\(governTab, governFinal \? document\.querySelector\('#nav > a\.tab\[data-route="audit"\]'\) : document\.getElementById\('nav-consolidated'\)\);/);
  assert.match(stages, /governTab\.dataset\.group = governFinal \? 'credits' : 'labs';/);
  assert.doesNotMatch(html, /nav-group-govern/, 'Govern has no group of its own');
  const place = app.slice(app.indexOf('function placeNavTab('), app.indexOf('\n}\n', app.indexOf('function placeNavTab(')));
  assert.match(place, /\(pinOf\(anchor\) \?\? anchor\)\.after\(tab\);\n {2}if \(pin\) tab\.after\(pin\);/);
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
    assert.equal(settingsSectionFor(name), host, `#/settings/${name} opens ${host}`);
  }
  // Automation's link leaves Settings for its own page, for the people who may open that page.
  const out = settingsNav.filter((el) => el.tag === 'a' && !el['data-set']);
  assert.deepEqual(out.map((a) => [a.href, gate(a['data-perm'])]), [['#/automation', gate(PAGES_BEFORE.automation)]]);
});

test('Settings has five groups, with every link in its place', () => {
  const piece = between('<nav class="set-nav" id="set-nav"', '</nav>');
  const groups = [];
  for (const m of piece.matchAll(/<p class="set-group[^>]*>([^<]+)<\/p>|<a href="#\/settings\/(\w+)" data-set="\2"|<a href="#\/(automation)" class="set-out"/g)) {
    if (m[1]) groups.push([m[1].replace('&amp;', '&'), []]);
    else groups.at(-1)[1].push(m[2] ?? `→ ${m[3]}`);
  }
  assert.deepEqual(groups, [
    ['You', ['profile', 'appearance', 'mybrand']],
    ['Connections', ['import', 'connection', 'smtp', 'network', 'https', 'server']],
    ['Reminders', ['handsoff', 'initiators', 'template', '→ automation', 'sla']],
    ['Organisation', ['ai', 'branding', 'features', 'support']],
    ['About', ['activation', 'tenants', 'update', 'about']],
  ]);
  // A heading has no permissions of its own: it shows with settings.view, like the links under it that everyone with it sees.
  for (const el of settingsNav.filter((p) => p.tag === 'p')) assert.equal(el['data-perm'], undefined, 'no heading can hide while a link under it shows');
});

test('every old address and saved choice still leads somewhere', () => {
  // Pages renamed long ago, and Automation's old place in Settings.
  const aliases = Object.fromEntries([.../const ROUTE_ALIASES = \{([^}]*)\}/.exec(app)[1].matchAll(/'?([\w-]+)'?: '(\w+)'/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(aliases, { iam: 'access', 'credit-control': 'credits' });
  for (const target of Object.values(aliases)) assert.ok(target in pagePerms, `${target} is a page`);
  assert.match(app, /if \(location\.hash === '#\/settings\/automation'\) history\.replaceState\(null, '', '#\/automation'\);/);
  // #/settings/<name>, and the section kept in the browser (mz-settings-section): a link of that name, or one it now leads to.
  const names = settingsLinks.map((a) => a['data-set']);
  assert.deepEqual(SETTINGS_PARTS, FOLDED_INTO);
  for (const name of Object.keys(SETTINGS_BEFORE)) {
    const target = settingsSectionFor(name);
    assert.ok(names.includes(target), `#/settings/${name} opens a section (${target})`);
    assert.equal(settingsSectionFor(target), target, 'in one step');
  }
  for (const [from, to] of Object.entries(SETTINGS_PARTS)) {
    assert.ok(!names.includes(from) && names.includes(to), `${from} → ${to}: an old name to a section there is`);
  }
  assert.equal(settingsSectionFor(''), '', 'no name: the section kept in the browser, else Checkmarx One');
  assert.equal(settingsSectionFor('nowhere'), 'nowhere', 'a name there never was falls back the same way');
  // The page asks the map for the name in the address and for the one it kept (mz-settings-section).
  assert.match(app, /const SETTINGS_KEY = 'mz-settings-section';/);
  assert.match(app, /const wanted = settingsSectionFor\(id\);/);
  assert.match(app, /usable\.find\(\(a\) => a\.dataset\.set === settingsSectionFor\(saved\)\)/);
  // Pinned pages (mz-nav-pins) are kept by route: every route there was is still a menu item (checked above).
  assert.match(app, /const NAV_PINS_KEY = 'mz-nav-pins';/);
  assert.match(app, /const routes = new Set\(navTabs\(\)\.map\(\(t\) => t\.dataset\.route\)\);/);
  // Folded groups (mz-nav-folded) are kept by group name: the names there were are read as today's.
  assert.match(app, /const NAV_FOLDS_KEY = 'mz-nav-folded';/);
  assert.match(app, /return navFoldsFrom\(JSON\.parse\(localStorage\.getItem\(NAV_FOLDS_KEY\) \|\| '\[\]'\)\);/);
  const before = ['act', 'followup', 'prove', 'govern', 'plan', 'setup', 'labs', 'pinned'];
  for (const name of before) assert.ok(NAV_GROUPS.includes(name) || name === 'pinned' || name in OLD_NAV_GROUPS, `${name}: a group there is, or one that is mapped`);
  for (const now of Object.values(OLD_NAV_GROUPS)) assert.ok(now === null || NAV_GROUPS.includes(now));
  assert.deepEqual([...navFoldsFrom(before)].sort(), ['act', 'credits', 'labs', 'pinned', 'setup'], 'Fold every group, kept from before: everything is still folded');
  assert.deepEqual([...navFoldsFrom(['prove'])], ['credits'], 'Prove folded: Credits folded');
  assert.deepEqual([...navFoldsFrom(['followup', 'plan', 'govern'])], [], 'a one-page group that was folded hides nothing in the group its page joined');
  assert.deepEqual([...navFoldsFrom(['act', 'credits'])].sort(), ['act', 'credits'], 'today\'s names pass through');
  assert.deepEqual([...navFoldsFrom('act')], []);
  assert.deepEqual([...navFoldsFrom([1, null, 'setup'])], ['setup']);
});

test('Settings outside "You" still needs settings.view, except About & terms of use', () => {
  const line = app.split('\n').find((l) => l.includes("classList.toggle('no-settings', !settingsToo)"));
  assert.ok(line, 'one line hides the rest of Settings from whoever lacks settings.view');
  const open = [...line.matchAll(/:not\(\[data-set="(\w+)"\]\)/g)].map((m) => m[1]);
  // About & terms of use is for everyone since the flattening: the version at the bottom of the menu leads there,
  // and it holds nothing but the version, the licence and the terms (its one control has a permission of its own).
  assert.deepEqual(open, ['profile', 'appearance', 'mybrand', 'about'], 'only the sections under You, and About & terms of use, are for everyone');
  assert.match(line, /#set-nav \.set-group:not\(\.set-you\):not\(\.set-open\), /, 'with their two headings');
  const headings = [...between('<nav class="set-nav" id="set-nav"', '</nav>').matchAll(/<p class="set-group( [\w -]+)?">([^<]+)<\/p>/g)].map((m) => [m[2], (m[1] ?? '').trim()]);
  assert.deepEqual(headings.filter(([, cls]) => cls), [['You', 'set-you'], ['About', 'set-open']]);
  const about = between('<section class="panel" id="set-about">', '</section>');
  assert.deepEqual(tags(about, 'input|button|select|textarea').length, 3, 'the organisation name and its Save, and Read the terms of use');
  assert.match(about, /<span class="about-org-edit" data-perm="settings\.branding"><input type="text" id="about-org-input"[^>]*> <button type="button" id="about-org-save">Save<\/button>/, 'the name is changed only with its permission');
  // It is filled for everyone, before the rest of Settings is loaded for whoever may see it.
  const reload = app.slice(app.indexOf('const reloadSettingsPage = () => {'), app.indexOf('};', app.indexOf('const reloadSettingsPage = () => {')));
  assert.ok(reload.indexOf('renderAbout();') > 0 && reload.indexOf('renderAbout();') < reload.indexOf("if (!can('settings.view')) return;"));
  assert.match(app, /const settingsToo = can\('settings\.view'\);/);
});

test('the words follow the menu, and every heading has its translation', () => {
  const catalog = JSON.parse(read('i18n/catalog.json'));
  // A menu heading is looked up with its dot; its tooltip and each Settings heading as plain words.
  const piece = between('<nav class="nav" id="nav"', '</nav>');
  const headings = [...piece.matchAll(/<p class="nav-group[^"]*"[^>]* title="([^"]+)"[^>]*>(<i aria-hidden="true"><\/i>[^<]+)<\/p>/g)];
  assert.equal(headings.length, 5);
  for (const [, title, inner] of headings) {
    assert.equal(catalog[inner]?.kind, 'html', `${inner} is in the catalog`);
    assert.equal(catalog[title]?.kind, 'attr:title', `${title} is in the catalog`);
  }
  for (const [, label] of between('<nav class="set-nav" id="set-nav"', '</nav>').matchAll(/<p class="set-group[^>]*>([^<]+)<\/p>/g)) assert.ok(label in catalog, `${label} is in the catalog`);
  // What a feature does once final says where it goes now, in every language.
  const features = read('src/features.js');
  const said = [
    'It moves out of Labs to the top of Act (FAE Flush, Workbench, Automation, Dashboard); the Workbench stays the home page.',
    'It moves out of Labs to the Credits group of the menu, after Audit.',
  ];
  for (const sentence of said) {
    assert.ok(features.includes(`'${sentence}'`), sentence);
    assert.ok(sentence in catalog, `in the catalog: ${sentence}`);
  }
  // Nothing the page or the server says names a group that is gone.
  for (const file of [...PAGE_SCRIPT_FILES, 'public/index.html', 'public/mobile.js', 'src/server.js', 'src/features.js', 'src/diagnostics.js', 'src/impact-summary.js']) {
    assert.doesNotMatch(read(file), /Settings → (?:AI & credits|Start|Security|Reports & brand|Risks endpoint|Links into Checkmarx One)\b|(?:Prove|Plan|Follow up) → (?!Prove, plus Set up)|own menu group/, file);
  }
  for (const sentence of ['Money: set an hourly cost and the price of one credit under Settings → AI & credit pool.', 'Off: add who gets it under Settings → AI & credit pool.']) {
    assert.ok(app.includes(sentence) && sentence in catalog, sentence);
  }
});
