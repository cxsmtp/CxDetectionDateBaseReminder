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
