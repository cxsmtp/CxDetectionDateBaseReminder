import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_LOOK, LOOKS } from '../public/look.js';
import { BrandFonts, brandFontCss, describeFontFile } from '../src/brand-fonts.js';
import { LOOKS as PROFILE_LOOKS, cleanProfile } from '../src/iam.js';
import { DEFAULT_SETTINGS, SettingsStore, mergeSettings } from '../src/settings.js';

const base = () => structuredClone(DEFAULT_SETTINGS);
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cxdr-looks-'));

test('every look is kept to choose from; Command center, the base look, is the default', () => {
  assert.deepEqual(LOOKS, ['cabin', 'circuit', 'residence', 'chronometer', 'signal', 'nextgen', 'studio', 'atelier', 'classic']);
  assert.equal(DEFAULT_LOOK, 'nextgen');
  assert.equal(PROFILE_LOOKS, LOOKS, 'a profile may hold any of them');
  assert.equal(cleanProfile({ look: 'chronometer' }).look, 'chronometer');
  assert.equal(cleanProfile({ look: 'sparkly' }).look, '', 'anything else is the organisation\'s');
});

test('the organisation\'s look: an admin picks it, and whether people may choose their own', () => {
  const b = base().branding;
  assert.deepEqual([b.look, b.lookChoice, b.nextGen], ['nextgen', true, true]);
  const residence = mergeSettings(base(), { branding: { look: 'residence', lookChoice: false } }).branding;
  assert.deepEqual([residence.look, residence.lookChoice, residence.nextGen], ['residence', false, true]);
  assert.equal(mergeSettings(base(), { branding: { look: 'sparkly' } }).branding.look, 'nextgen', 'an unknown look is ignored');
  const classicForAll = mergeSettings(base(), { branding: { look: 'classic', lookChoice: false } }).branding;
  assert.equal(classicForAll.nextGen, false, 'classic for everyone, with no choice, is the old switch off');
});

test('the old switch alone still works: off is the classic look for everyone, on brings the looks back', () => {
  const off = mergeSettings(base(), { branding: { nextGen: false } });
  assert.deepEqual([off.branding.look, off.branding.lookChoice, off.branding.nextGen], ['classic', false, false]);
  const on = mergeSettings(off, { branding: { nextGen: true } }).branding;
  assert.deepEqual([on.look, on.lookChoice, on.nextGen], ['nextgen', true, true]);
  assert.equal(mergeSettings(base(), { branding: { look: 'cabin' } }).branding.nextGen, true);
});

test('a settings file from before there were looks keeps what it had', () => {
  const load = (branding) => {
    const file = path.join(tempDir(), 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ branding }));
    return new SettingsStore({ file }).get().branding;
  };
  const off = load({ appName: 'Acme', nextGen: false });
  assert.deepEqual([off.look, off.lookChoice, off.nextGen], ['classic', false, false], 'turned off: classic for everyone');
  const on = load({ appName: 'Acme' });
  assert.deepEqual([on.look, on.lookChoice, on.nextGen], ['nextgen', true, true], 'on: the base look, and people choose');
  assert.equal(load({ look: 'circuit', lookChoice: true }).look, 'circuit', 'a saved look stays');
});

test('brand font files: the family, weight and style come from the name; nothing else is a font', () => {
  assert.deepEqual(describeFontFile('FoundersGrotesk-SemiboldItalic.woff2'), { file: 'FoundersGrotesk-SemiboldItalic.woff2', ext: '.woff2', format: 'woff2', family: 'MZ Brand Sans', weight: 600, style: 'italic' });
  assert.equal(describeFontFile('FoundersGroteskCond-Bold.otf').family, 'MZ Brand Condensed');
  assert.equal(describeFontFile('FoundersGroteskXCond-Light.otf').family, 'MZ Brand Extra Condensed');
  assert.equal(describeFontFile('FoundersGrotesk-Light.otf').weight, 300);
  assert.equal(describeFontFile('FoundersGrotesk-Regular.otf').weight, 400);
  assert.equal(describeFontFile('readme.txt'), null);
  assert.equal(describeFontFile('licence.pdf'), null);
});

test('brand font CSS: the smallest file of each face, an installed copy first, and the installed font even with no files', () => {
  const css = brandFontCss(['FoundersGrotesk-Regular.otf', 'FoundersGrotesk-Regular.woff2'].map(describeFontFile));
  assert.match(css, /url\(brand-fonts\/FoundersGrotesk-Regular\.woff2\) format\("woff2"\)/);
  assert.doesNotMatch(css, /Regular\.otf/, 'the woff2 wins over the otf');
  assert.match(css, /local\("Founders Grotesk Regular"\)/);
  assert.match(css, /ascent-override: 80%/, 'Founders Grotesk is centred in its line');
  const none = brandFontCss([]);
  assert.match(none, /font-family: "MZ Brand Sans"; font-style: normal; font-weight: 300;.*src: local\("Founders Grotesk Light"\)/);
  assert.doesNotMatch(none, /url\(/, 'no files: only installed copies');
});

test('brand fonts are served only from their folder, and only the font files in it', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'FoundersGrotesk-Light.woff2'), 'x');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  const fonts = new BrandFonts({ dir });
  assert.equal(fonts.count, 1);
  assert.equal(fonts.path('FoundersGrotesk-Light.woff2'), path.join(dir, 'FoundersGrotesk-Light.woff2'));
  assert.equal(fonts.path('notes.txt'), null);
  assert.equal(fonts.path('../settings.json'), null);
  assert.equal(new BrandFonts({ dir: path.join(dir, 'missing') }).count, 0, 'no folder: no files, no error');
});

test('a report is in its reader\'s look: the look named, its colours, and Classic or Command center as before', async () => {
  const { reportLook } = await import('../public/look.js');
  const { generateHtmlReport } = await import('../src/html-report.js');
  const { buildReportData } = await import('../src/reminder.js');
  const { impactSummary } = await import('../src/impact-summary.js');
  assert.deepEqual(reportLook({ ui: 'nextgen', look: 'residence', theme: 'dark', accent: 'violet' }), { look: 'residence', ui: 'nextgen', theme: 'light', accent: 'violet' }, 'files open light');
  assert.equal(reportLook({ ui: 'classic', look: 'residence' }).look, 'classic', 'the organisation’s Classic wins');
  assert.equal(reportLook({ ui: 'nextgen' }).look, 'nextgen', 'a look not named is Command center');
  assert.equal(reportLook({ ui: 'nextgen', look: 'sparkly' }).look, 'nextgen');

  const data = buildReportData([{ id: 'r1', riskId: 'r1', scanId: 's', projectId: 'p', projectName: 'P', title: 'V', severity: 'HIGH', scanner: 'SAST', location: 'a.js:1', state: 'TO_VERIFY', firstDetectedAt: '2025-01-01T00:00:00.000Z', ageDays: 5 }], { tenant: 't' });
  const residence = generateHtmlReport(data, { look: { ui: 'nextgen', look: 'residence' } });
  assert.match(residence, /<html lang="en" data-ui="nextgen" data-accent="indigo" data-look="residence" data-theme="light">/);
  assert.match(residence, /\/\* The residence look\. \*\//);
  assert.match(residence, /#0d1f3c/, 'the hotel’s navy band');
  const base = generateHtmlReport(data, { look: { ui: 'nextgen', look: 'nextgen' } });
  assert.doesNotMatch(base, /data-look=|The \w+ look\. \*\//, 'Command center keeps the report’s own styles');
  assert.match(base, /\.btn:hover:not\(:disabled\) \{ transform: translateY\(-1px\)/, 'buttons stand off the page in every new look');
  const classic = generateHtmlReport(data, { look: { ui: 'classic', look: 'cabin' } });
  assert.doesNotMatch(classic, /data-ui=|translateY/, 'Classic is unchanged');

  const impact = { money: { value: null, cost: null, net: null, currency: '' }, debt: { change: null, start: 0, now: 0, zeroBy: null }, hours: { total: 0, triage: 0, fix: 0 }, noiseRemoved: 0, aiFixed: 0, manualFixed: 0, credits: { triage: 0, remediation: 0 }, timeToFix: [], byProject: [], series: [], settings: { triageMinutes: 10, fixMinutes: 30, hourlyRate: null }, from: '2026-01-01', to: '2026-02-01', partial: false, since: null };
  const chrono = impactSummary(impact, { look: { ui: 'nextgen', look: 'chronometer' } }).html;
  assert.match(chrono, /background:#00432c/, 'the watch’s green band');
  assert.doesNotMatch(impactSummary(impact, {}).html, /#00432c/, 'no look: the classic summary');
});
