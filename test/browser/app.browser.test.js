// The page in a real browser (Chromium, through Playwright as a library), against the real server and
// the mock Checkmarx One: the first administrator's setup with the setup code, signing in, the Workbench
// with its projects, Settings, People & roles, the Admins' backup-key notice, Labs in the menu only for
// a role that holds Labs permissions, and signing out. Along the way, any error nobody caught in the
// page, any request to the server that failed or was refused, and anything loaded from outside the
// server fails the test it happened in.
//
//   npm run test:browser
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  await page.locator(`#nav a[data-route="${route}"]`).click();
  await page.locator(`#${pageId}`).waitFor({ state: 'visible' });
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

  // Two roles that differ only in Labs, and a person in each (made as the Admin, through the server).
  const same = ['findings.fetch', 'reports.view', 'settings.view'];
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
    const { page, context } = await browser.person(person.who);
    await page.goto('/');
    await signIn(page, person.email, MEMBER_PASSWORD);
    // An administrator set the password: they choose their own before anything else.
    await page.locator('#change-box').waitFor({ state: 'visible' });
    await page.fill('#change-current', MEMBER_PASSWORD);
    await page.fill('#change-next', MEMBER_NEXT_PASSWORD);
    await page.fill('#change-next2', MEMBER_NEXT_PASSWORD);
    await page.locator('#change-form button[type="submit"]').click();
    await signedInAs(page, person.name);
    // The menu has been drawn for this person once the Workbench is in it.
    await page.locator('#nav a[data-route="dashboard"]').waitFor({ state: 'visible' });
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
