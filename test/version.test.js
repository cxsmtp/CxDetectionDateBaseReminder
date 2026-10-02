import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { APP_VERSION, displayVersion } from '../src/version.js';

test('versions show as MZ-xx.xx.xx', () => {
  assert.equal(displayVersion('1.0.0'), 'MZ-01.00.00');
  assert.equal(displayVersion('2.13.7'), 'MZ-02.13.07');
  assert.equal(displayVersion('3'), 'MZ-03.00.00');
  const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(APP_VERSION, displayVersion(version));
  assert.match(APP_VERSION, /^MZ-\d{2}\.\d{2}\.\d{2}$/);
});
