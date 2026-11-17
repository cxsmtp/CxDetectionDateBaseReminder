// The page in a real browser (Chromium, through Playwright as a library), against the real server and
// the mock Checkmarx One: the first administrator's setup with the setup code, signing in, the Workbench
// with its projects, Settings, People & roles, the Admins' backup-key notice, the menu's groups (four for
// an Admin, one flat list for a User or a Security Champion, also at a phone's width), the addresses and
// the choices a browser kept from before the menu and Settings were regrouped, Labs in the menu only for
// a role that holds Labs permissions, and signing out. Along the way, any error nobody caught in the
// page, any request to the server that failed or was refused, and anything loaded from outside the
// server fails the test it happened in.
//
//   npm run test:browser
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MEMBER_NEXT_PASSWORD, MEMBER_PASSWORD, NEXT_PASSWORD } from '../test-credentials.js';
import { openBrowser, startServer } from './harness.js';

const PROJECTS = 3;
const ADMIN = { email: 'admin@acme.io', name: 'Ada Admin', password: NEXT_PASSWORD };

let server;
let browser;
/** The Admin's page, kept from one test to the next: they are one visit, in order. */
let admin;

test.before(async () => {
  server = await startServer({ projects: PROJECTS, risks: 4 });
  browser = await openBrowser(server.base);
  admin = (await browser.person('the Admin')).page;
});

test.after(async () => {
  await browser?.close();
  await server?.stop();
});

/** Nothing went wrong in any page so far; with the server's log when something did. */
function nothingWentWrong() {
  const problems = browser.problems();
  assert.deepEqual(problems, [], `${problems.join('\n')}\n\nServer log:\n${server.log().slice(-3000)}`);
}

/** Signed in: the menu is there and the corner says who. */
async function signedInAs(page, name) {
  await page.locator('#nav').waitFor({ state: 'visible' });
  await page.locator('#user-menu').waitFor({ state: 'visible' });
  assert.equal((await page.locator('#me-name').textContent()).trim(), name);
}

async function signOut(page) {
  // As a person does it: once the page has settled. (A request still on its way when the visit ends is answered
  // 401, rightly, and would be listed as a problem: on a slow runner the page that was just opened was still
  // reading People & roles.)
  await page.waitForLoadState('networkidle');
  await page.locator('#user-menu summary').click();
  await page.locator('#disconnect').click();
  await page.locator('#signin-box').waitFor({ state: 'visible' });
  await page.locator('#nav').waitFor({ state: 'hidden' });
}

async function signIn(page, email, password) {
  await page.locator('#signin-box').waitFor({ state: 'visible' });
  await page.fill('#signin-email', email);
  await page.fill('#signin-password', password);
  await page.locator('#signin-submit').click();
}

/** Open a page from the menu and wait until it shows. */
async function open(page, route, pageId) {
  await page.locator(`#nav > a[data-route="${route}"]`).click();
  await page.locator(`#${pageId}`).waitFor({ state: 'visible' });
}

/** Go to an address in the page (#/…), as a bookmark or a link in an email would, and wait until a page shows. */
async function goTo(page, hash, pageId) {
  await page.evaluate((h) => (location.hash = h), hash);
  await page.locator(`#${pageId}`).waitFor({ state: 'visible' });
}

/** The menu as it is seen: each heading in brackets, then the pages under it. */
const menuSeen = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#nav > .nav-group, #nav > a.tab')]
      .filter((el) => el.getClientRects().length)
      .map((el) => (el.matches('.nav-group') ? `[${el.textContent.trim()}]` : el.querySelector('span').textContent.trim())),
  );

/** Someone an Admin just added signs in for the first time: they choose their own password first. */
async function firstSignIn(who, { email, name }) {
  const { page, context } = await browser.person(who);
  await page.goto('/');
  await signIn(page, email, MEMBER_PASSWORD);
  await page.locator('#change-box').waitFor({ state: 'visible' });
  await page.fill('#change-current', MEMBER_PASSWORD);
  await page.fill('#change-next', MEMBER_NEXT_PASSWORD);
  await page.fill('#change-next2', MEMBER_NEXT_PASSWORD);
  await page.locator('#change-form button[type="submit"]').click();
  await signedInAs(page, name);
  // The menu has been drawn for this person once the Workbench is in it.
  await page.locator('#nav > a[data-route="dashboard"]').waitFor({ state: 'visible' });
  return { page, context };
}

/** The first visit to a server nobody has set up: the setup code from its log makes the first administrator. */
async function createFirstAdmin(page, setupCode) {
  await page.goto('/');
  await page.locator('#setup-box').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#nav').isVisible(), false, 'nothing to use before there is an administrator');
  await page.fill('#setup-code', setupCode);
  await page.fill('#setup-name', ADMIN.name);
  await page.fill('#setup-email', ADMIN.email);
  await page.fill('#setup-password', ADMIN.password);
  await page.fill('#setup-password2', ADMIN.password);
  await page.locator('#setup-form button[type="submit"]').click();
  await signedInAs(page, ADMIN.name);
}

test('first start: the first administrator is created with the setup code from the server log', async () => {
  await createFirstAdmin(admin, server.setupCode);
  assert.equal((await admin.locator('#me-role').textContent()).trim(), 'Admin');
  nothingWentWrong();
});

test('signing out, and signing in again with the password', async () => {
  await signOut(admin);
  assert.match(await admin.locator('#signin-status').textContent(), /Signed out/);
  await signIn(admin, ADMIN.email, ADMIN.password);
  await signedInAs(admin, ADMIN.name);
  nothingWentWrong();
});

test('the Workbench loads the projects from Checkmarx One', async () => {
  await open(admin, 'dashboard', 'page-dashboard');
  await admin.locator('#fetch').click();
  const rows = admin.locator('#projects-body tr:not(.empty)');
  await rows.nth(PROJECTS - 1).waitFor();
  assert.equal(await rows.count(), PROJECTS);
  const text = (await admin.locator('#projects-body').innerText()).replace(/\s+/g, ' ');
  for (let i = 0; i < PROJECTS; i += 1) assert.ok(text.includes(`Project ${i}`), `Project ${i} is listed: ${text}`);
  assert.match(text, /dev0@acme\.com/, 'with who ran its last scan');
  await admin.locator('#table-meta').filter({ hasText: `${PROJECTS} of ${PROJECTS} project(s) shown` }).waitFor();
  nothingWentWrong();
});

test('Fusion results: the total results of each project, and the severity of a result in its own colour', async () => {
  await goTo(admin, '#/fusion', 'page-fusion');
  await admin.locator('#fusion-fetch').click();
  const first = admin.locator('#fusion-body tr').filter({ has: admin.locator('button[data-fusion-project]') }).first();
  await first.waitFor();
  const headings = async () => (await admin.locator('#fusion-head th').allTextContents()).map((t) => t.trim());
  // Fusion and LAST both ticked: each row by its own scan; a Fusion scan's AI results over all of its SAST results.
  let shown = await headings();
  assert.ok(shown.includes('AI / total results') && !shown.includes('AI share of SAST') && !shown.includes('Total results'), shown.join(', '));
  const cell = first.locator('td').nth(shown.indexOf('AI / total results'));
  assert.match((await cell.textContent()).replace(/\s+/g, ' ').trim(), /^[\d,]+ \/ [\d,]+$/);
  assert.match(await cell.getAttribute('title'), /^[\d,]+ of [\d,]+ SAST results are the AI engine's: \d+%$/);
  // The heading says what the ticks show, and keeps its sort and filter controls.
  await admin.locator('#fusion-show-last').uncheck();
  await admin.locator('#fusion-head th').filter({ hasText: 'Fusion / total results' }).waitFor();
  await admin.locator('#fusion-head th').filter({ hasText: 'Fusion / total results' }).locator('.tt-sort').waitFor();
  await admin.locator('#fusion-show-last').check();
  await admin.locator('#fusion-show-fusion').uncheck();
  await admin.locator('#fusion-head th').filter({ hasText: 'LAST results' }).waitFor();
  await admin.locator('#fusion-show-fusion').check();
  await admin.locator('#fusion-head th').filter({ hasText: 'AI / total results' }).waitFor();
  shown = await headings();
  // Its results: the severity is a word in that severity's colour, in the line under the name and in the details.
  await first.locator('button[data-fusion-project]').click();
  const result = admin.locator('#fusion-side-list .fusion-vuln').first();
  await result.waitFor();
  const seen = await result.evaluate((el) => {
    const colour = (node) => getComputedStyle(node).color;
    const [line, detail] = [el.querySelector('.fusion-vuln-sub .sev-word'), el.querySelector('dd .sev-word')];
    return { words: [line.textContent, detail.textContent], classes: [line.className, detail.className], colours: [colour(line), colour(detail)], rest: colour(el.querySelector('.fusion-vuln-sub')), dot: getComputedStyle(el.querySelector('.sev-dot')).backgroundColor };
  });
  assert.equal(seen.words[0], seen.words[1]);
  assert.match(seen.words[0], /^(Critical|High|Medium|Low)$/);
  assert.match(seen.classes[0], new RegExp(`sev-word-${seen.words[0].toLowerCase()}`));
  assert.equal(seen.colours[0], seen.colours[1], 'the same colour in both places');
  assert.notEqual(seen.colours[0], seen.rest, 'not the grey of the rest of the line');
  // Every severity has a colour of its own.
  const colours = await admin.evaluate(() => ['critical', 'high', 'medium', 'low'].map((k) => {
    const el = document.body.appendChild(Object.assign(document.createElement('span'), { className: `sev-word sev-word-${k}` }));
    const colour = getComputedStyle(el).color;
    el.remove();
    return colour;
  }));
  assert.equal(new Set(colours).size, 4, colours.join(' | '));
  await admin.keyboard.press('Escape');
  await admin.locator('#fusion-drawer').waitFor({ state: 'hidden' });
  await open(admin, 'dashboard', 'page-dashboard');
  nothingWentWrong();
});

test('the Ashoka Chakra says what it stands for while it is the logo; a company logo takes its place, and a reset brings it back', async () => {
  const chakra = admin.locator('.sidebar .brand-mark');
  const words = 'Ashoka Chakra: a 24-spoke wheel that stands for duty and progress around the clock, as Mission Zero works day and night to eliminate vulnerabilities and keep applications secure.';
  assert.equal(await chakra.getAttribute('title'), words);
  assert.equal(await chakra.getAttribute('aria-label'), words);
  assert.equal(await chakra.isVisible(), true);
  // A company logo: the Chakra, and what it says, go.
  const logo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const set = await admin.request.put('/api/settings', { data: { branding: { logoUrl: logo } } });
  assert.equal(set.status(), 200, await set.text());
  await admin.reload();
  await signedInAs(admin, ADMIN.name);
  await admin.locator('#app-logo').waitFor({ state: 'visible' });
  assert.equal(await chakra.isVisible(), false);
  // Reset: the Chakra and its words are back.
  assert.equal((await admin.request.put('/api/settings', { data: { branding: { logoUrl: '' } } })).status(), 200);
  await admin.reload();
  await signedInAs(admin, ADMIN.name);
  await chakra.waitFor({ state: 'visible' });
  assert.equal(await chakra.getAttribute('title'), words);
  nothingWentWrong();
});

test('Fusion credits: read the projects, set the rates, allocate what the plan recommends', async () => {
  await goTo(admin, '#/fusioncredits', 'page-fusioncredits');
  assert.equal((await admin.locator('#page-title').textContent()).trim(), 'Fusion credits');
  await admin.locator('#fc-read').click();
  await admin.locator('#fc-body [data-fc-pick]').first().waitFor({ timeout: 30000 });
  // Projects 0 and 1 ran Fusion last; their models have no rate yet.
  assert.equal(await admin.locator('#fc-body tr').count(), 2);
  assert.match(await admin.locator('#fc-body').innerText(), /mythos-5\.1/);
  assert.equal(await admin.locator('#fc-allocate').isDisabled(), true, 'nothing to allocate without a rate');
  // An Admin sets the rates.
  await admin.locator('[data-ptabs="fusioncredits"] [data-pt="rates"]').click();
  await admin.locator('[data-fc-rate="mythos-5.1"]').fill('3');
  await admin.locator('[data-fc-rate="opus-5.0"]').fill('1');
  await admin.locator('#fc-rates-save').click();
  await admin.locator('#fc-rates-status').filter({ hasText: 'Rates saved.' }).waitFor();
  // Back to the plan: both are recommended, and given it in one click.
  await admin.locator('[data-ptabs="fusioncredits"] [data-pt="plan"]').click();
  const allocate = admin.locator('#fc-allocate');
  await allocate.filter({ hasText: 'Allocate recommended to 2 project(s)' }).waitFor();
  admin.once('dialog', (dialog) => dialog.accept());
  await allocate.click();
  await admin.locator('#fc-body .fc-chip.good').nth(1).waitFor();
  assert.equal(await admin.locator('#fc-body .fc-chip.good').count(), 2, 'both on plan');
  // The used tab lists them.
  await admin.locator('[data-ptabs="fusioncredits"] [data-pt="used"]').click();
  assert.equal(await admin.locator('#fc-used-body tr').count(), 2);
  await open(admin, 'dashboard', 'page-dashboard');
  nothingWentWrong();
});

test("the Branch column names each project's branch; another is chosen from its menu, and Settings → Primary branches writes one to Checkmarx One", async () => {
  await open(admin, 'dashboard', 'page-dashboard');
  await admin.locator('#fetch').click();
  await admin.locator('#table-meta').filter({ hasText: `${PROJECTS} of ${PROJECTS} project(s) shown` }).waitFor({ timeout: 30000 });
  // This mock's scans do not say their branch: the column says so rather than guess.
  const first = admin.locator('#projects-body [data-branch-pick="p0"]');
  assert.equal((await first.innerText()).replace('▾', '').trim(), '—');
  assert.match(await admin.locator('#projects-body tr[data-id="p0"] .br-why').innerText(), /branch not reported/);
  // Its menu: with no git host connected, it says its branches come from Checkmarx One only.
  await first.click();
  await admin.locator('#branch-pop').filter({ hasText: 'No git host connected for it' }).waitFor();
  await admin.keyboard.press('Escape');
  assert.equal(await admin.locator('#branch-pop').count(), 0);
  // The picker: one branch for every project, from a typed name.
  await admin.locator('#focus-pick summary').click();
  await admin.locator('#branch-mode-one').check();
  await admin.locator('#branch-one-name').fill('develop');
  await admin.locator('#branch-one-name').press('Enter');
  assert.equal((await admin.locator('#focus-summary').innerText()).trim(), 'One branch · develop');
  await admin.locator('#branch-mode-primary').check();
  assert.match((await admin.locator('#focus-summary').innerText()).trim(), /^Primary branch/);
  await admin.locator('#focus-pick summary').click();

  // Settings → Primary branches: read, then the suggestion written to Checkmarx One by the Admin.
  await goTo(admin, '#/settings/branches', 'page-settings');
  await admin.locator('#set-branches').waitFor({ state: 'visible' });
  await admin.locator('#pb-read').click();
  await admin.locator('#pb-body tr[data-pb-row]').nth(PROJECTS - 1).waitFor({ timeout: 30000 });
  assert.match(await admin.locator('#pb-order').innerText(), /main/);
  const setAll = admin.locator('#pb-set-all');
  await setAll.filter({ hasText: `Set all ${PROJECTS} suggested in Checkmarx One` }).waitFor();
  admin.once('dialog', (dialog) => dialog.accept());
  await setAll.click();
  await admin.locator('#pb-body tr[data-pb-row="p0"]').filter({ hasText: 'Set in Checkmarx One' }).waitFor();
  assert.equal(await setAll.isVisible(), false, 'nothing left to suggest');
  await open(admin, 'dashboard', 'page-dashboard');
  nothingWentWrong();
});

test('Settings and People & roles open, with what the Admin may see', async () => {
  await open(admin, 'settings', 'page-settings');
  const sections = (await admin.locator('#set-nav [data-set]:visible').allTextContents()).map((t) => t.trim());
  for (const name of ['Your profile', 'Checkmarx One', 'Email server', 'Update & recovery']) assert.ok(sections.includes(name), `Settings lists ${name}: ${sections.join(', ')}`);
  // One section at a time: the email server's opens when chosen.
  await admin.locator('#set-nav [data-set="smtp"]').click();
  await admin.locator('#smtp-host').waitFor({ state: 'visible' });

  await open(admin, 'access', 'page-access');
  await admin.locator('[data-ptpanel="access:people"]').getByText(ADMIN.email).first().waitFor();
  await admin.locator('[data-ptabs="access"] [data-pt="roles"]').click();
  // The roles, one column each, with the permissions under them.
  const columns = admin.locator('#iam-matrix th.role-col .role-pill');
  await columns.first().waitFor({ state: 'visible' });
  assert.deepEqual((await columns.allTextContents()).map((t) => t.trim()), ['Admin', 'Security Analyst', 'User', 'Security Champion']);
  await admin.locator('#iam-matrix').getByText('See Labs', { exact: true }).first().waitFor({ state: 'visible' });
  nothingWentWrong();
});

test('a new installation: the Admin is told to save the backup key, sees it, confirms, and the notice goes', async () => {
  const banner = admin.locator('#backup-banner');
  await banner.waitFor({ state: 'visible' });
  assert.match(await banner.textContent(), /nobody has confirmed saving the key somewhere else yet/);
  await banner.getByRole('link').click();
  const panel = admin.locator('#backup-key-panel');
  await panel.waitFor({ state: 'visible' });
  assert.match(await admin.locator('#backup-facts').innerText(), /on, with this server's backup key/);
  await admin.locator('#backup-key-show').click();
  const key = (await admin.locator('#backup-key-value').textContent()).trim();
  assert.match(key, /^([A-HJ-NP-Z2-9]{4}-){7}[A-HJ-NP-Z2-9]{4}$/, 'groups of letters and digits that can be typed');
  // "Download as a text file" hands over a small file with the key in it.
  const [download] = await Promise.all([admin.waitForEvent('download'), admin.locator('#backup-key-download').click()]);
  assert.equal(download.suggestedFilename(), 'cxmissionzero-backup-key.txt');
  // "I have saved it" asks once more, then the notice is gone on every page and the key is put away.
  admin.once('dialog', (dialog) => dialog.accept());
  await admin.locator('#backup-key-confirm').click();
  await banner.waitFor({ state: 'hidden' });
  await panel.getByText('Saved somewhere else: confirmed').waitFor();
  assert.equal(await admin.locator('#backup-key-value').count(), 0);
  assert.ok(!server.log().includes(key), 'the key is not in the server log');
  nothingWentWrong();
});

test('Labs is in the menu only for a role that holds Labs permissions', async () => {
  // The Admin holds every permission: Labs is there, with its items.
  await admin.locator('#nav .nav-labs').waitFor({ state: 'visible' });
  await admin.locator('#nav a[data-route="beta"]').waitFor({ state: 'visible' });

  // Two roles that differ only in Labs, and a person in each (made as the Admin, through the server). Both have
  // more than seven pages, so their menu keeps its headings.
  const same = ['findings.fetch', 'reports.view', 'settings.view', 'credits.view', 'audit.view'];
  const people = [
    { who: 'someone without Labs', email: 'plain@acme.io', name: 'Pat Plain', role: 'Without Labs', permissions: same, labs: false },
    { who: 'someone with Labs', email: 'labs@acme.io', name: 'Lee Labs', role: 'With Labs', permissions: [...same, 'labs.view', 'labs.codeAuthors'], labs: true },
  ];
  for (const person of people) {
    const made = await admin.request.post('/api/iam/roles', { data: { name: person.role, permissions: person.permissions } });
    assert.equal(made.status(), 201, await made.text());
    const roleId = (await made.json()).roles.find((r) => r.name === person.role).id;
    const added = await admin.request.post('/api/iam/users', { data: { email: person.email, name: person.name, role: roleId, password: MEMBER_PASSWORD } });
    assert.equal(added.status(), 201, await added.text());
  }

  for (const person of people) {
    // An administrator set the password: they choose their own before anything else.
    const { page, context } = await firstSignIn(person.who, person);
    const labsGroup = page.locator('#nav .nav-labs');
    const labsItems = page.locator('#nav a[data-stage="labs"]:visible');
    if (person.labs) {
      await labsGroup.waitFor({ state: 'visible' });
      await page.locator('#nav a[data-route="beta"]').waitFor({ state: 'visible' });
      assert.deepEqual((await labsItems.allTextContents()).map((t) => t.trim()), ['Code authors'], 'only the Labs item their role holds');
    } else {
      assert.equal(await labsGroup.isVisible(), false, 'no Labs in the menu');
      assert.equal(await labsItems.count(), 0, 'and none of its items');
    }
    // Neither role manages people or backups: those pages and the Admins' backup notice are not theirs.
    assert.equal(await page.locator('#nav a[data-route="access"]').isVisible(), false);
    assert.equal(await page.locator('#backup-banner').isVisible(), false);
    await signOut(page);
    await context.close();
  }
  nothingWentWrong();
});

test('the menu: an Admin sees four groups, each with its pages', async () => {
  assert.deepEqual(await menuSeen(admin), [
    '[Act]', 'Workbench', 'Automation', 'Dashboard',
    '[Credits]', 'Credit Control', 'Fusion credits', 'Impact', 'Audit',
    '[Set up]', 'People & roles', 'Settings', 'Logs',
    '[Labs]', 'Code authors', 'Fusion results',
  ]);
  // (No Cx Credits Calculator: it is in the menu only once an Admin has given its address and turned it on.)
  assert.equal(await admin.locator('#nav').evaluate((nav) => nav.classList.contains('nav-flat')), false);
  // The label beside a page's title is as it was: Credit Control is still "Prove", the Dashboard "Follow up".
  await open(admin, 'credits', 'page-credits');
  assert.equal((await admin.locator('#page-stage').textContent()).trim(), 'Prove');
  await open(admin, 'reports', 'page-reports');
  assert.equal((await admin.locator('#page-stage').textContent()).trim(), 'Follow up');
  assert.equal((await admin.locator('#page-title').textContent()).trim(), 'Dashboard');

  // A group folds with a click on its name, and the page that is open stays in view.
  const credits = admin.locator('#nav .nav-group[data-group="credits"]');
  await credits.click();
  assert.equal(await credits.getAttribute('aria-expanded'), 'false');
  assert.deepEqual((await menuSeen(admin)).slice(0, 6), ['[Act]', 'Workbench', 'Automation', 'Dashboard', '[Credits]', '[Set up]']);
  await open(admin, 'settings', 'page-settings');
  await goTo(admin, '#/audit', 'page-audit');
  assert.deepEqual((await menuSeen(admin)).slice(4, 7), ['[Credits]', 'Audit', '[Set up]'], 'a folded group still shows the page that is open');
  await credits.click();
  assert.equal(await credits.getAttribute('aria-expanded'), 'true');

  // Fold every group, and unfold them again.
  await admin.locator('#nav-fold-all').click();
  assert.deepEqual(await menuSeen(admin), ['[Act]', '[Credits]', 'Audit', '[Set up]', '[Labs]']);
  await admin.locator('#nav-fold-all').click();
  assert.equal((await menuSeen(admin)).length, 16);

  // A pinned page sits at the top, and Focus shows only the pinned pages and the one that is open.
  await admin.locator('#nav > a[data-route="impact"]').hover();
  await admin.locator('#nav > .nav-pin[data-route="impact"]').click();
  assert.deepEqual((await admin.locator('#nav-pinned a.tab').allTextContents()).map((t) => t.trim()), ['Impact']);
  await admin.locator('#nav-focus').click();
  assert.deepEqual(await menuSeen(admin), ['[Pinned]', 'Audit']);
  await admin.locator('#nav-pinned a.tab').click();
  await admin.locator('#page-impact').waitFor({ state: 'visible' });
  await admin.locator('#nav-focus').click();
  await admin.locator('#nav > a[data-route="impact"]').hover();
  await admin.locator('#nav > .nav-pin[data-route="impact"]').click();
  assert.equal(await admin.locator('#nav-pinned a.tab').count(), 0);
  assert.equal((await menuSeen(admin)).length, 16);
  nothingWentWrong();
});

test('the Cx Credits Calculator is off until an Admin gives its address; then the menu opens it there', async () => {
  const item = admin.locator('#nav > a[data-route="calculator"]');
  // As installed: not in the menu, and its old address leads to the Workbench.
  assert.equal(await item.isVisible(), false);
  assert.equal((await menuSeen(admin)).includes('Cx Credits Calculator'), false);
  await goTo(admin, '#/audit', 'page-audit');
  await goTo(admin, '#/calculator', 'page-dashboard');
  assert.equal(await admin.evaluate(() => location.hash), '#/dashboard');
  assert.equal(await admin.locator('#page-calculator').isVisible(), false);
  // Settings → Beta features, under Organisation since the regrouping.
  await open(admin, 'settings', 'page-settings');
  await admin.locator('#set-nav [data-set="features"]').click();
  assert.equal((await admin.locator('#calc-address-badge').textContent()).trim(), 'Off');
  assert.match(await admin.locator('#calc-address p:visible').first().textContent(), /runs on its own, at an address of its own and with its own sign-in/);
  await admin.locator('#calc-address-url').fill('http://127.0.0.1:8333/');
  await admin.locator('#calc-address-on').check();
  await admin.locator('#calc-address-save').click();
  await admin.locator('#calc-address-status').filter({ hasText: 'in the menu now opens this address' }).waitFor();
  assert.equal(await item.isVisible(), true);
  assert.equal(await item.getAttribute('href'), 'http://127.0.0.1:8333/');
  assert.equal(await item.getAttribute('target'), '_blank');
  assert.deepEqual((await menuSeen(admin)).slice(4, 11), ['[Credits]', 'Credit Control', 'Fusion credits', 'Impact', 'Audit', 'Cx Credits Calculator', '[Set up]'], 'in its place in the menu');
  // Its page in CxMissionZero only says where the calculator is; the built-in calculator stays put away.
  await goTo(admin, '#/calculator', 'calc-moved');
  assert.equal(await admin.locator('#calc-moved-open').getAttribute('href'), 'http://127.0.0.1:8333/');
  assert.equal(await admin.locator('#page-calculator').isVisible(), false);
  // Off again: gone from the menu.
  await goTo(admin, '#/settings/features', 'page-settings');
  await admin.locator('#calc-address-on').uncheck();
  await admin.locator('#calc-address-save').click();
  await admin.locator('#calc-address-status').filter({ hasText: 'is off: the menu does not show it' }).waitFor();
  assert.equal(await item.isVisible(), false);
  assert.equal((await menuSeen(admin)).length, 16);
  nothingWentWrong();
});

test('Settings has five groups, and the old addresses and the section a browser kept still lead there', async () => {
  await open(admin, 'settings', 'page-settings');
  const listed = () =>
    admin.evaluate(() =>
      [...document.querySelectorAll('#set-nav .set-nav-list > *')]
        .filter((el) => el.getClientRects().length)
        .map((el) => (el.matches('.set-group') ? `[${el.textContent.trim()}]` : el.firstChild.textContent.trim())),
    );
  assert.deepEqual(await listed(), [
    '[You]', 'Your profile', 'Your appearance', 'Your branding',
    '[Connections]', 'Quick setup (.env)', 'Checkmarx One', 'Primary branches', 'Email server', 'Network & proxy', 'HTTPS', 'Server address',
    '[Reminders]', 'Hands-off', 'Developer addresses', 'Automation', 'SLAs',
    '[Organisation]', 'AI & credit pool', 'Branding', 'Beta features', 'Get help',
    '[About]', 'Activation codes', 'Update & recovery', 'About & terms of use',
  ]);

  // Risks endpoint and Links into Checkmarx One were sections of their own, shown with the advanced options.
  // Without them, the old address opens the section that holds the part, as it fell back before.
  await goTo(admin, '#/settings/endpoint', 'set-connection');
  assert.equal(await admin.evaluate(() => location.hash), '#/settings/connection');
  assert.equal(await admin.locator('#risks-path').isVisible(), false);
  await admin.locator('#user-menu summary').click();
  await admin.locator('#me-advanced').check();
  await admin.locator('#user-menu summary').click();
  assert.ok((await listed()).includes('Mail template'), 'the advanced sections are listed');
  for (const gone of ['Risks endpoint', 'Links into Checkmarx One']) assert.ok(!(await listed()).includes(gone), `${gone} is no longer a section of its own`);
  // With them, the part opens inside its section.
  await goTo(admin, '#/settings/endpoint', 'set-connection');
  await admin.locator('#risks-path').waitFor({ state: 'visible' });
  assert.equal(await admin.evaluate(() => location.hash), '#/settings/connection');
  assert.equal(await admin.locator('#set-nav a.active').getAttribute('data-set'), 'connection');
  await goTo(admin, '#/settings/links', 'set-server');
  await admin.locator('#link-base').waitFor({ state: 'visible' });
  assert.equal(await admin.locator('#set-nav a.active').getAttribute('data-set'), 'server');
  assert.equal(await admin.locator('#link-report-server').isVisible(), true, 'beside the server address it belongs with');
  // The last section a browser kept, under its old name, opens the same way.
  await open(admin, 'logs', 'page-logs');
  await admin.evaluate(() => localStorage.setItem('mz-settings-section', 'endpoint'));
  await open(admin, 'settings', 'page-settings');
  await admin.locator('#set-connection').waitFor({ state: 'visible' });
  assert.equal(await admin.evaluate(() => localStorage.getItem('mz-settings-section')), 'connection');
  // "Jump to" still finds both by name.
  await admin.locator('#palette-open').click();
  await admin.locator('#palette-q').fill('Risks endpoint');
  await admin.locator('#palette-list li[role="option"]').filter({ hasText: 'Settings → Risks endpoint' }).click();
  await admin.locator('#risks-path').waitFor({ state: 'visible' });
  await admin.locator('#user-menu summary').click();
  await admin.locator('#me-advanced').uncheck();
  await admin.locator('#user-menu summary').click();

  // Pages that were renamed, and Automation's old place in Settings.
  await goTo(admin, '#/credit-control', 'page-credits');
  await goTo(admin, '#/iam', 'page-access');
  await goTo(admin, '#/settings/automation', 'page-automation');
  assert.equal(await admin.evaluate(() => location.hash), '#/automation');
  nothingWentWrong();
});

test('folded groups and pinned pages a browser kept from before the regrouping still apply', async () => {
  // Before: Act, Follow up, Prove, Plan, Set up, Labs. This browser had Prove and Follow up folded, and two pages pinned.
  await goTo(admin, '#/dashboard', 'page-dashboard');
  await admin.evaluate(() => {
    localStorage.setItem('mz-nav-folded', JSON.stringify(['prove', 'followup']));
    localStorage.setItem('mz-nav-pins', JSON.stringify(['reports', 'impact', 'a-page-there-never-was']));
  });
  await admin.reload();
  await signedInAs(admin, ADMIN.name);
  await admin.locator('#nav-pinned a.tab').first().waitFor({ state: 'visible' });
  assert.deepEqual(await menuSeen(admin), [
    '[Pinned]',
    '[Act]', 'Workbench', 'Automation', 'Dashboard',
    '[Credits]',
    '[Set up]', 'People & roles', 'Settings', 'Logs',
    '[Labs]', 'Code authors', 'Fusion results',
  ], 'Prove folded is Credits folded; the Dashboard, alone under Follow up before, stays in view under Act');
  assert.deepEqual((await admin.locator('#nav-pinned a.tab').allTextContents()).map((t) => t.trim()), ['Dashboard', 'Impact']);
  // A pinned page opens its page.
  await admin.locator('#nav-pinned a.tab[data-route="impact"]').click();
  await admin.locator('#page-impact').waitFor({ state: 'visible' });
  // Unfolding writes today's names.
  await admin.locator('#nav .nav-group[data-group="credits"]').click();
  assert.equal(await admin.evaluate(() => localStorage.getItem('mz-nav-folded')), '[]');
  await admin.evaluate(() => localStorage.removeItem('mz-nav-pins'));
  await admin.reload();
  await signedInAs(admin, ADMIN.name);
  await admin.locator('#nav > a[data-route="dashboard"]').waitFor({ state: 'visible' });
  assert.equal((await menuSeen(admin)).length, 16);
  nothingWentWrong();
});

test('a User and a Security Champion have seven pages or fewer: one flat list, with no headings', async () => {
  const people = [
    { who: 'a User', email: 'una@acme.io', name: 'Una User', role: 'user', menu: ['Workbench', 'Automation', 'Dashboard', 'Credit Control', 'Impact', 'Settings', 'Logs'] },
    { who: 'a Security Champion', email: 'cy@acme.io', name: 'Cy Champion', role: 'champion', menu: ['Workbench', 'Dashboard', 'Credit Control', 'Impact', 'Settings', 'Logs'] },
  ];
  for (const person of people) {
    const added = await admin.request.post('/api/iam/users', { data: { email: person.email, name: person.name, role: person.role, password: MEMBER_PASSWORD } });
    assert.equal(added.status(), 201, await added.text());
    const { page, context } = await firstSignIn(person.who, person);
    assert.deepEqual(await menuSeen(page), person.menu, `${person.who}: the pages, and no heading`);
    assert.equal(await page.locator('#nav').evaluate((nav) => nav.classList.contains('nav-flat')), true);
    assert.equal(await page.locator('#nav-fold-all').isVisible(), false, 'nothing to fold');
    assert.equal(await page.locator('#nav-focus').isVisible(), true, 'pinning and Focus still work');
    // Folds kept from before hide nothing in a flat list.
    await page.evaluate(() => localStorage.setItem('mz-nav-folded', JSON.stringify(['act', 'prove', 'setup'])));
    await open(page, 'credits', 'page-credits');
    assert.deepEqual(await menuSeen(page), person.menu);
    assert.equal((await page.locator('#page-stage').textContent()).trim(), 'Prove');

    // Settings: what each may see, under the same five headings.
    await open(page, 'settings', 'page-settings');
    const groups = (await page.locator('#set-nav .set-group:visible').allTextContents()).map((t) => t.trim());
    const sections = (await page.locator('#set-nav [data-set]:visible').allTextContents()).map((t) => t.trim());
    if (person.role === 'user') {
      assert.deepEqual(groups, ['You', 'Connections', 'Reminders', 'Organisation', 'About']);
      assert.deepEqual(sections, ['Your profile', 'Your appearance', 'Checkmarx One', 'Primary branches', 'Email server', 'Server address', 'Hands-off', 'Developer addresses', 'AI & credit pool', 'About & terms of use']);
    } else {
      // No "View settings": only what is under You, and About & terms of use, where the version in the menu leads.
      assert.deepEqual(groups, ['You', 'About']);
      assert.deepEqual(sections, ['Your profile', 'Your appearance', 'About & terms of use']);
      await open(page, 'dashboard', 'page-dashboard');
      await page.locator('#app-version').click();
      await page.locator('#set-about').waitFor({ state: 'visible' });
      assert.match((await page.locator('#about-version').textContent()).trim(), /^MZ-\d\d\.\d\d\.\d\d$/);
      assert.equal(await page.locator('#about-org-input').isVisible(), false, 'the organisation name is not theirs to change');
      // The rest of Settings stays closed to them: the address of a section they may not see opens one of their own.
      await goTo(page, '#/settings/connection', 'page-settings');
      assert.equal(await page.evaluate(() => location.hash), '#/settings/about');
      assert.equal(await page.locator('#set-connection').isVisible(), false);
      assert.equal(await page.locator('#set-about').isVisible(), true);
    }

    // At a phone's width: four pages in the bar, the rest in the More sheet, in one list with no labels.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.m-more').waitFor({ state: 'visible' });
    const bar = (await page.locator('#nav > a.tab[data-primary]:visible').allTextContents()).map((t) => t.trim());
    assert.deepEqual(bar, person.menu.slice(0, 4));
    await page.locator('.m-more').click();
    const sheet = page.locator('.m-menu .m-pages');
    await sheet.waitFor({ state: 'visible' });
    assert.equal(await sheet.locator('.m-group-label').count(), 0, 'no group labels in a flat menu');
    assert.equal(await sheet.locator('.m-group').count(), 1);
    assert.deepEqual((await sheet.locator('a.tab').allTextContents()).map((t) => t.trim()), person.menu);
    await sheet.locator('a.tab[data-route="logs"]').click();
    await page.locator('#page-logs').waitFor({ state: 'visible' });
    await sheet.waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await signOut(page);
    await context.close();
  }
  nothingWentWrong();
});

test('at a phone\'s width the Admin\'s menu keeps its four groups in the More sheet', async () => {
  await admin.setViewportSize({ width: 390, height: 844 });
  await admin.locator('.m-more').waitFor({ state: 'visible' });
  assert.deepEqual((await admin.locator('#nav > a.tab[data-primary]:visible').allTextContents()).map((t) => t.trim()), ['Workbench', 'Automation', 'Dashboard', 'Credit Control']);
  await admin.locator('.m-more').click();
  const sheet = admin.locator('.m-menu .m-pages');
  await sheet.waitFor({ state: 'visible' });
  const groups = await sheet.evaluate((pages) => [...pages.children].map((el) => (el.matches('.m-group-label') ? `[${el.textContent.trim()}]` : [...el.querySelectorAll('a.tab > span:not(.badge)')].map((s) => s.textContent.trim()).join(', '))));
  assert.deepEqual(groups, [
    '[Act]', 'Workbench, Automation, Dashboard',
    '[Credits]', 'Credit Control, Fusion credits, Impact, Audit',
    '[Set up]', 'People & roles, Settings, Logs',
    '[Labs]', 'Code authors, Fusion results',
  ]);
  // A page chosen in the sheet opens, and the sheet closes.
  await sheet.locator('a.tab[data-route="audit"]').click();
  await admin.locator('#page-audit').waitFor({ state: 'visible' });
  await sheet.waitFor({ state: 'hidden' });
  // Settings' sections are one button that opens a list, under the same five headings.
  await admin.locator('.m-more').click();
  await sheet.locator('a.tab[data-route="settings"]').click();
  await admin.locator('#page-settings').waitFor({ state: 'visible' });
  await admin.locator('#page-settings .m-tabpick').first().click();
  const picker = admin.locator('#m-pick');
  await picker.locator('.m-pick-list').first().waitFor({ state: 'visible' });
  assert.deepEqual((await picker.locator('.m-group-label').allTextContents()).map((t) => t.trim()), ['You', 'Connections', 'Reminders', 'Organisation', 'About']);
  await picker.locator('.m-row').filter({ hasText: 'About & terms of use' }).click();
  await admin.locator('#set-about').waitFor({ state: 'visible' });
  await admin.setViewportSize({ width: 1440, height: 900 });
  await admin.locator('#nav .nav-group[data-group="act"]').waitFor({ state: 'visible' });
  nothingWentWrong();
});

test('signing out ends the visit: the menu goes, and the server no longer answers this browser', async () => {
  await signOut(admin);
  assert.equal(await admin.locator('#backup-banner').isVisible(), false);
  // Asked on purpose, and announced: signed out, the server refuses.
  browser.expect(401, /^\/api\/me$/);
  const status = await admin.evaluate(() => fetch('/api/me', { credentials: 'same-origin' }).then((r) => r.status));
  assert.equal(status, 401);
  // A reload shows the sign-in again, not the workspace.
  await admin.reload();
  await admin.locator('#signin-box').waitFor({ state: 'visible' });
  assert.equal(await admin.locator('#nav').isVisible(), false);
  nothingWentWrong();
});

test('a feature made final leaves Labs for its group: FAE Flush to the top of Act, Govern into Credits after Audit', async () => {
  // A server of its own that takes activation codes signed with a key made here (as the maintainer's are).
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'menu-key-'));
  const script = (...args) => execFileSync(process.execPath, ['scripts/activation.mjs', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const publicKey = script('keygen', path.join(keyDir, 'issuer.pem')).split('\n').pop();
  const own = await startServer({ projects: 1, risks: 1, env: { MZ_ACTIVATION_TEST_KEY: publicKey } });
  const visit = await openBrowser(own.base);
  try {
    const { page } = await visit.person('the Admin of a server with FAE Flush and Govern');
    await createFirstAdmin(page, own.setupCode);
    const reloaded = async () => {
      await page.reload();
      await signedInAs(page, ADMIN.name);
      await page.locator('#nav > a[data-route="dashboard"]').waitFor({ state: 'visible' });
    };
    const stage = async (feature, to) => {
      const made = await page.request.put(`/api/features/${feature}`, { data: { stage: to } });
      assert.equal(made.status(), 200, await made.text());
    };
    for (const feature of ['faeFlush', 'govern']) {
      const applied = await page.request.post('/api/activation', { data: { code: script('feature', path.join(keyDir, 'issuer.pem'), 'Acme', feature, 'on') } });
      assert.equal(applied.status(), 200, await applied.text());
    }

    // In Beta: both in Labs.
    await reloaded();
    assert.deepEqual(await menuSeen(page), [
      '[Act]', 'Workbench', 'Automation', 'Dashboard',
      '[Credits]', 'Credit Control', 'Fusion credits', 'Impact', 'Audit',
      '[Set up]', 'People & roles', 'Settings', 'Logs',
      '[Labs]', 'Code authors', 'Fusion results', 'FAE Flush', 'Govern',
    ]);

    // Final: FAE Flush first under Act, Govern under Credits after Audit; no group of its own.
    await stage('faeFlush', 'final');
    await stage('govern', 'final');
    await reloaded();
    assert.deepEqual(await menuSeen(page), [
      '[Act]', 'FAE Flush', 'Workbench', 'Automation', 'Dashboard',
      '[Credits]', 'Credit Control', 'Fusion credits', 'Impact', 'Audit', 'Govern',
      '[Set up]', 'People & roles', 'Settings', 'Logs',
      '[Labs]', 'Code authors', 'Fusion results',
    ]);
    // Each took its pin along (the pin sits right after its page), and folds with its new group.
    for (const route of ['flush', 'govern']) assert.equal(await page.locator(`#nav > a.tab[data-route="${route}"] + .nav-pin[data-route="${route}"]`).count(), 1, `${route}: its pin follows it`);
    await goTo(page, '#/logs', 'page-logs');
    await page.locator('#nav .nav-group[data-group="credits"]').click();
    assert.deepEqual((await menuSeen(page)).slice(5, 7), ['[Credits]', '[Set up]'], 'Govern folds with Credits');
    await page.locator('#nav .nav-group[data-group="credits"]').click();
    await page.locator('#nav .nav-group[data-group="act"]').click();
    assert.deepEqual((await menuSeen(page)).slice(0, 2), ['[Act]', '[Credits]'], 'FAE Flush folds with Act');
    await page.locator('#nav .nav-group[data-group="act"]').click();
    // On a phone: the same groups in the More sheet.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.m-more').click();
    const sheet = page.locator('.m-menu .m-pages');
    await sheet.waitFor({ state: 'visible' });
    const groups = await sheet.evaluate((pages) => [...pages.children].map((el) => (el.matches('.m-group-label') ? `[${el.textContent.trim()}]` : [...el.querySelectorAll('a.tab > span:not(.badge)')].map((s) => s.textContent.trim()).join(', '))));
    assert.deepEqual(groups.slice(0, 4), ['[Act]', 'FAE Flush, Workbench, Automation, Dashboard', '[Credits]', 'Credit Control, Fusion credits, Impact, Audit, Govern']);
    await page.setViewportSize({ width: 1440, height: 900 });

    // Back in Beta: both return to Labs, in their places.
    await stage('faeFlush', 'beta');
    await stage('govern', 'beta');
    await reloaded();
    assert.deepEqual((await menuSeen(page)).slice(13), ['[Labs]', 'Code authors', 'Fusion results', 'FAE Flush', 'Govern']);
    assert.deepEqual(visit.problems(), []);
  } finally {
    await visit.close();
    await own.stop();
    fs.rmSync(keyDir, { recursive: true, force: true });
  }
});

test('an existing installation: the Admin is told its backups are not encrypted, turns encryption on, and is shown the key to save', async () => {
  // A server of its own, on a data folder an earlier version left something in.
  const existing = await startServer({ projects: 1, risks: 1, prepare: (dataDir) => fs.writeFileSync(path.join(dataDir, 'tracked-reports.json'), JSON.stringify({ reports: [] })) });
  const visit = await openBrowser(existing.base);
  try {
    const { page } = await visit.person('the Admin of an existing installation');
    await createFirstAdmin(page, existing.setupCode);
    const banner = page.locator('#backup-banner');
    await banner.waitFor({ state: 'visible' });
    assert.match(await banner.textContent(), /Backups of this server are not encrypted/);
    await banner.getByRole('link').click();
    const panel = page.locator('#backup-key-panel');
    await panel.getByText('Backups are not encrypted.').waitFor();
    assert.match(await page.locator('#backup-facts').innerText(), /off — each backup holds the keys and passwords in the clear/);
    // Turning it on asks first, then shows the key at once and asks for it to be saved.
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#backup-encrypt-on').click();
    const key = (await page.locator('#backup-key-value').textContent()).trim();
    assert.match(key, /^([A-HJ-NP-Z2-9]{4}-){7}[A-HJ-NP-Z2-9]{4}$/);
    await banner.filter({ hasText: 'nobody has confirmed saving the key somewhere else yet' }).waitFor();
    await page.locator('#backup-facts').getByText("on, with this server's backup key").waitFor();
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#backup-key-confirm').click();
    await banner.waitFor({ state: 'hidden' });
    await panel.getByText('Saved somewhere else: confirmed').waitFor();
    assert.ok(!existing.log().includes(key), 'the key is not in the server log');
    assert.deepEqual(visit.problems(), []);
  } finally {
    await visit.close();
    await existing.stop();
  }
});

test('the watch itself works: an error nobody caught and a refused request are both noticed', async () => {
  // A browser of its own, so what is provoked here stays out of the visit above.
  const other = await openBrowser(server.base);
  try {
    const { page } = await other.person('a visitor');
    await page.goto('/');
    await page.locator('#signin-box').waitFor({ state: 'visible' });
    assert.deepEqual(other.problems(), []);
    // The page reports its own uncaught errors to the server, which refuses a visitor: announced, so not a problem.
    other.expect(401, /^\/api\/diagnostics\/client-error$/);
    const reported = page.waitForResponse((r) => r.url().endsWith('/api/diagnostics/client-error'));
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('thrown on purpose');
      }, 0);
    });
    assert.equal(await page.evaluate(() => fetch('/api/backup/key/show', { method: 'POST' }).then((r) => r.status)), 401);
    await reported;
    const found = other.problems();
    assert.equal(found.length, 2, found.join('\n'));
    assert.ok(found.some((p) => /uncaught error in the page: thrown on purpose/.test(p)), found.join('\n'));
    assert.ok(found.some((p) => /POST \/api\/backup\/key\/show was answered 401/.test(p)), found.join('\n'));
    // An answer that was announced and never came is a problem too.
    other.expect(403, /^\/api\/never$/);
    assert.equal(other.problems().length, 3);
  } finally {
    await other.close();
  }
});
