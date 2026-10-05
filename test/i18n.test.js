// The page in nine more languages: every piece of English has a translation in each, and every
// translation keeps what must not change (numbers, markup, code) and the language's own script
// and register. The checks themselves are tested first.
import test from 'node:test';
import assert from 'node:assert/strict';

import { preferredLanguage } from '../public/i18n.js';
import { LANGUAGE_CODES, checkAll, loadCatalog, loadLanguage, problems } from '../scripts/i18n-check.mjs';

test('the language: the saved choice, else the browser’s when it is one of ours, else English', () => {
  assert.equal(preferredLanguage('ko', ['ja-JP']), 'ko');
  assert.equal(preferredLanguage(null, ['ja-JP', 'en']), 'ja');
  assert.equal(preferredLanguage(null, ['zh-TW']), 'zh-TW');
  assert.equal(preferredLanguage(null, ['zh-Hant-HK']), 'zh-TW');
  assert.equal(preferredLanguage(null, ['zh']), 'zh-CN');
  assert.equal(preferredLanguage(null, ['zh-Hans-CN']), 'zh-CN');
  assert.equal(preferredLanguage(null, ['in-ID']), 'id', 'the old code for Indonesian');
  assert.equal(preferredLanguage(null, ['ms-MY']), 'ms');
  assert.equal(preferredLanguage(null, ['es-419']), 'es');
  assert.equal(preferredLanguage(null, ['en-GB', 'ja']), 'en', 'the first language the browser names wins');
  assert.equal(preferredLanguage(null, ['fr-FR', 'de']), 'en');
  assert.equal(preferredLanguage('xx', []), 'en');
});

test('the checks catch what would break the page or read wrongly', () => {
  assert.deepEqual(problems('Load <b>{0}</b> findings', '<b>{0}</b> 件の検出結果を読み込む', 'ja'), []);
  assert.match(problems('{0} of {1}', '{0}', 'ja').join(), /placeholders/);
  assert.match(problems('See <a href="#/settings/ai">AI</a>', 'AI を参照', 'ja').join(), /markup/);
  assert.match(problems('Use <code>REPORT_SERVER_URL</code>', '<code>报告服务器</code> を使用', 'ja').join(), /code/);
  assert.match(problems('Save', '<img src=x onerror=alert(1)>保存', 'ja').join(), /markup|script/);
  assert.match(problems('Settings', '设置', 'zh-TW').join(), /simplified/);
  assert.match(problems('Settings', '設定值', 'zh-CN').join(), /traditional/);
  assert.match(problems('Settings', 'Pengaturan', 'ms').join(), /Indonesian/);
  assert.match(problems('Settings', 'Tetapan', 'id').join(), /Malay/);
  assert.match(problems('Done', 'เสร็จแล้วครับ', 'th').join(), /informal/);
  assert.match(problems('Reports', 'Reportes', 'es').join(), /informal/);
  assert.match(problems('Save changes', 'Save changes', 'ko').join(), /not translated/);
  assert.deepEqual(problems('Checkmarx One', 'Checkmarx One', 'ko'), [], 'names stay in English');
  assert.match(problems('{0} project(s)', '{0} projek(s)', 'ms').join(), /\(s\)/);
});

const catalog = loadCatalog();

for (const code of LANGUAGE_CODES) {
  test(`${code}: every piece of English is translated, and every translation passes the checks`, () => {
    const file = loadLanguage(code);
    assert.equal(file.language, code);
    const missing = Object.keys(catalog).filter((english) => !(english in file.strings));
    assert.deepEqual(missing.slice(0, 10), [], `${missing.length} without a translation`);
    const found = checkAll(file.strings, code, catalog);
    assert.deepEqual(found.slice(0, 5), [], `${found.length} translations with problems`);
  });
}
