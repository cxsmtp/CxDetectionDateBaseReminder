// Checks a translation against the English it translates: what must survive unchanged
// (placeholders, markup, code) and what must not slip in (the other Chinese script, the
// other Malay, casual particles). Used by `npm test` and by translators:
//
//   node scripts/i18n-check.mjs                 every public/i18n/<code>.json against i18n/catalog.json
//   node scripts/i18n-check.mjs ja work.json    one file of { "<English>": "<translation>" }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LANGUAGE_CODES = ['ja', 'zh-TW', 'zh-CN', 'ko', 'es', 'pt-BR', 'de', 'fr', 'ar', 'vi', 'th', 'ms', 'id', 'he'];

const sorted = (list) => [...list].sort();
const placeholders = (text) => sorted(text.match(/\{\d+\}/g) ?? []);
const tags = (text) => sorted((text.match(/<\/?[a-zA-Z][^>]*>/g) ?? []).map((tag) => tag.replace(/\s+/g, ' ')));
const codes = (text) => sorted([...text.matchAll(/<code>([^]*?)<\/code>/g)].map((m) => m[1]));
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const words = (text) => text.replace(/<[^>]+>/g, ' ').replace(/\{\d+\}/g, ' ');

// Characters that exist in only one of the two Chinese scripts (common UI vocabulary).
const SIMPLIFIED_ONLY = /[这们个为时发现点设说项与无关录认证务问题级报扫开选择删数据专应称将进复读链码户账权页显图单击键钮输导间试错误态览续统额删储览帮]/;
const TRADITIONAL_ONLY = /[這們個為時發現點設說項與無關錄認證務問題級報掃開選擇刪數據專應稱將進復讀鏈碼戶帳權頁顯圖單擊鍵鈕輸導間試錯誤態覽續統額儲幫]/;
const SCRIPT = {
  ja: /[぀-ヿ一-鿿]/,
  'zh-TW': /[一-鿿]/,
  'zh-CN': /[一-鿿]/,
  ko: /[가-힯]/,
  th: /[฀-๿]/,
  ar: /[\u0600-\u06FF]/,
  he: /[\u0590-\u05FF]/,
};
// Words that belong to the other language (Malaysian Malay vs Indonesian).
const NOT_MALAY = /\b(pengaturan|perbarui|proyek|pemindaian|unduh|kata sandi|berhasil|aktifkan|nonaktifkan|tautan|surel|dasbor)\b/i;
const NOT_INDONESIAN = /\b(tetapan|kemas kini|projek|imbasan|muat turun|kata laluan|berjaya|pautan|papan pemuka|log masuk)\b/i;
const CASUAL = {
  th: /ครับ|ค่ะ|จ้า(?=[\s.!?]|$)/,
  es: /(?<!\p{L})(tú|vosotros|reporte|reportes)(?!\p{L})/iu,
  ja: /だよ|だね|してね|よね/,
  ko: /(해요|했어|거야)(?![가-힣])/,
  // Formal register: no informal "you" forms. The boundary excludes letters, digits
  // and "_", so an env-var name like BACKUP_DIR and accented words (requêtes, êtes) do not trip it.
  de: /(?<![\p{L}\d_])(du|dein|deine|deinem|deinen|deiner|dich|dir)(?![\p{L}\d_])/iu,
  fr: /(?<![\p{L}\d_])(tu|ton|ta|tes|toi)(?![\p{L}\d_])/iu,
  // Brazilian Portuguese addresses the reader as "você", never "tu".
  'pt-BR': /(?<![\p{L}\d_])(tu|teu|tua|teus|tuas|contigo)(?![\p{L}\d_])/iu,
};
// Stays in English everywhere (brands, protocol names): an entry made only of these may be identical.
const KEEP = /^(?:[\s\d{}.,:;·•—–\-+()/&|→←…'"%#*!?]|CxMissionZero|Mission Zero|Checkmarx One|Checkmarx|GitHub|GitLab|Azure DevOps|Bitbucket|Jira|SAST|SCA|IaC|KICS|API Security|API|SMTP|HTTPS|HTTP|TLS|SLAs|SLA|URL|PAT|IDE|AI|VS Code|JetBrains|Cursor|Kiro|Podman|Docker|Beta|Git|Cc|Bcc|Cloud|Data Center|Server|latest|OK|ID|CSV|JSON|PDF|HTML|PEM|PFX|MZ|UTC|GMT|Ctrl|Cmd|K|N\/A|v\d|[A-Z_]{2,}|\.env|\.pfx|[a-z0-9.-]+\.[a-z]{2,}|\S+@\S+|\S*\/\S*)+$/;

/** Problems with one translation: [] when it is fine. */
export function problems(english, translation, lang) {
  const out = [];
  if (typeof translation !== 'string' || !translation.trim()) return ['empty'];
  if (!same(placeholders(english), placeholders(translation))) out.push(`placeholders ${placeholders(english).join(' ')} → ${placeholders(translation).join(' ')}`);
  if (!same(tags(english), tags(translation))) out.push('markup differs (every tag must stay, with the same attributes)');
  if (!same(codes(english), codes(translation))) out.push('text inside <code> must not change');
  if (/<script|on\w+\s*=|javascript:/i.test(translation) && !/<script|on\w+\s*=|javascript:/i.test(english)) out.push('script or event handler added');
  const text = words(translation);
  if (lang === 'zh-TW' && SIMPLIFIED_ONLY.test(text)) out.push(`simplified character in Traditional Chinese: ${text.match(SIMPLIFIED_ONLY)[0]}`);
  if (lang === 'zh-CN' && TRADITIONAL_ONLY.test(text)) out.push(`traditional character in Simplified Chinese: ${text.match(TRADITIONAL_ONLY)[0]}`);
  if (lang === 'ms' && NOT_MALAY.test(text)) out.push(`Indonesian word in Malay: ${text.match(NOT_MALAY)[0]}`);
  if (lang === 'id' && NOT_INDONESIAN.test(text)) out.push(`Malay word in Indonesian: ${text.match(NOT_INDONESIAN)[0]}`);
  if (CASUAL[lang]?.test(text)) out.push(`informal wording: ${text.match(CASUAL[lang])[0]}`);
  const plain = words(english).replace(/<code>[^]*?<\/code>/g, ' ');
  if (SCRIPT[lang] && /\p{L}{3}/u.test(plain) && !KEEP.test(plain.trim()) && !SCRIPT[lang].test(text)) out.push('not translated (no text in the language’s script)');
  if (/\(s\)/.test(translation) && lang !== 'es') out.push('"(s)" left in');
  return out;
}

/** Every problem in a set of translations: [{ english, translation, problems }]. */
export function checkAll(strings, lang, catalog) {
  const found = [];
  for (const [english, translation] of Object.entries(strings)) {
    if (catalog && !(english in catalog)) {
      found.push({ english, translation, problems: ['not in the catalog (the English changed or was removed)'] });
      continue;
    }
    const list = problems(english, translation, lang);
    if (list.length) found.push({ english, translation, problems: list });
  }
  return found;
}

export function loadCatalog() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n/catalog.json'), 'utf8'));
}

export function loadLanguage(code) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'public/i18n', `${code}.json`), 'utf8'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const catalog = loadCatalog();
  const [lang, file] = process.argv.slice(2);
  let failed = 0;
  for (const code of lang ? [lang] : LANGUAGE_CODES) {
    const strings = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : loadLanguage(code).strings;
    const found = checkAll(strings, code, file ? null : catalog);
    const missing = file ? [] : Object.keys(catalog).filter((k) => !(k in strings));
    failed += found.length;
    const identical = Object.entries(strings).filter(([en, out]) => en === out && !KEEP.test(words(en).trim())).length;
    console.log(`${code}: ${Object.keys(strings).length} translated, ${missing.length} missing, ${found.length} with problems, ${identical} left as the English (check these are names)`);
    for (const f of found.slice(0, 60)) console.log(`  - ${JSON.stringify(f.english).slice(0, 120)}\n    → ${JSON.stringify(f.translation).slice(0, 120)}\n    ${f.problems.join('; ')}`);
  }
  process.exit(failed ? 1 : 0);
}
