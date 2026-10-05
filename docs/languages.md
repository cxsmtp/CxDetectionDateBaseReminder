# Languages

CxMissionZero's page is available in ten languages:

| Code | Language |
|---|---|
| `en` | English |
| `ja` | 日本語 (Japanese) |
| `zh-TW` | 繁體中文 (Traditional Chinese, Taiwan) |
| `zh-CN` | 简体中文 (Simplified Chinese) |
| `ko` | 한국어 (Korean) |
| `es` | Español (Spanish, neutral international) |
| `vi` | Tiếng Việt (Vietnamese) |
| `th` | ไทย (Thai) |
| `ms` | Bahasa Melayu (Malay, Malaysia) |
| `id` | Bahasa Indonesia (Indonesian) |

**Choosing a language.** Use the globe at the top right, or **Your profile** (under your name, and in Settings). The choice is saved with the person's account. The first time, the browser's own language is used when it is one of these.

**What is translated:**
- menus, page names, tabs, buttons, options, headings and column headings;
- hints, tooltips and screen-reader labels;
- status messages and confirmation dialogs.

**What stays as it is:**
- **Names and data:** project, person and finding names from Checkmarx One, logs and code.
- **The terms of use:** the English text is the binding version.
- **Emails:** the emailed report and reminder emails stay in English.

**Tone.** While an action runs, every language other than English shows plain, factual status lines, such as "Verifying with Checkmarx One…" instead of a quip.

**Dates and times** are shown in each person's own time zone (their profile; by default their computer's), in their language's format.

## How it works

- **Lazy loading:** `public/i18n.js` loads `public/i18n/<code>.json` only when a language other than English is chosen. In English the page pays nothing extra.
- **Hidden until ready:** while the file loads, the page is hidden for at most 2 seconds, so it never shows English first.
- **How words are swapped:** the page is written in English, and its words are replaced as they appear, once for the whole page and then for whatever the app adds or changes.
- **Sentences with markup:** a sentence containing bold text, code or a link is translated as one piece, so its word order can follow the language. The app's own elements inside it keep working.
- **Numbers:** they become `{0}`, `{1}`… in the lookup, so "Take back 5 unused credits" and "Take back 12 unused credits" share one translation.
- **One English word, two meanings:** the element carries `data-i18n-ctx`. For example, a date range's "To" is looked up as `date|To`, apart from the email "To" field.
- **Left untouched:** anything marked `translate="no"`, such as names, logs and the terms text.

## Keeping it current

1. **Collect the English:** run `scripts/i18n-collect.mjs`. It needs Playwright and opens every page, tab, Settings section, panel and dialog with sample data, recording each piece of English exactly as the page will look it up. It writes `i18n/catalog.json`.
2. **Translate:** add each new or changed entry to every language file, following `i18n/GLOSSARY.md`: rules, register for each language, core terms, and terms that must stay distinct.
3. **Check:** run `node scripts/i18n-check.mjs`. `npm test` runs the same checks and fails on any missing entry. The checks cover:
   - placeholders, markup and `<code>` kept exactly;
   - the language's own script used;
   - no simplified characters in Traditional Chinese, and no traditional ones in Simplified Chinese;
   - no Indonesian words in Malay, and no Malay words in Indonesian;
   - no casual particles;
   - the five Mission Zero stages reading differently.

## How the first translation was validated

Every language was translated from the catalog and glossary, then checked by **two separate review passes**. Each pass read every entry against the English and its place in the app, looking at:
- accuracy;
- terminology;
- register;
- language quality;
- length;
- mechanics (placeholders, markup and code).

The second reviewer worked from the first reviewer's corrected text, without being told what had changed. Every correction had to pass the automated checks before it was applied.

| Language | Entries | Corrections, review 1 | Corrections, review 2 |
|---|---|---|---|
| Japanese | 1,416 | 21 | 13 |
| Traditional Chinese (Taiwan) | 1,416 | 24 | 36 |
| Simplified Chinese | 1,416 | 17 | 7 |
| Korean | 1,416 | 12 | 19 |
| Spanish | 1,416 | 21 | 13 |
| Vietnamese | 1,416 | 22 | 17 |
| Thai | 1,416 | 17 | 20 |
| Malay | 1,416 | 21 | 13 |
| Indonesian | 1,416 | 53 | 17 |

**Fixed in the English itself.** The reviews found places where one English word was doing two jobs:
- **"From" and "To":** used for both email fields and date ranges.
- **"Last month":** meant both the last 30 days and the previous calendar month.

These now have separate entries.

**Added after collection.** Six entries were translated afterwards and then reviewed twice in all nine languages: the date-range "From"/"To", the code-author confidence badges "Sure", "Check" and "Unsure", and the calendar "Last month".
