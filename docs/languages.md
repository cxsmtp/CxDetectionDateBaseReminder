# Languages

CxMissionZero's page is available in fifteen languages. Fourteen are open to everyone; Hebrew is switched on with an activation code, for the people an Admin chooses (below).

| Code | Language |
|---|---|
| `en` | English |
| `ja` | 日本語 (Japanese) |
| `zh-TW` | 繁體中文 (Traditional Chinese, Taiwan) |
| `zh-CN` | 简体中文 (Simplified Chinese) |
| `ko` | 한국어 (Korean) |
| `es` | Español (Spanish, neutral international) |
| `pt-BR` | Português (Brasil) (Brazilian Portuguese, for every Portuguese browser) |
| `de` | Deutsch (German, formal "Sie") |
| `fr` | Français (French, formal "vous") |
| `ar` | العربية (Arabic, Modern Standard; right to left) |
| `vi` | Tiếng Việt (Vietnamese) |
| `th` | ไทย (Thai) |
| `ms` | Bahasa Melayu (Malay, Malaysia) |
| `id` | Bahasa Indonesia (Indonesian) |
| `he` | עברית (Hebrew; right to left; needs an activation code, for chosen people) |

**Choosing a language.** Use the globe at the top right, or **Your profile** (under your name, and in Settings). The choice is saved with the person's account. The first time, the browser's own language is used when it is one of these.

**What is translated:**
- menus, page names, tabs, buttons, options, headings and column headings;
- hints, tooltips and screen-reader labels;
- status messages and confirmation dialogs.

**What stays as it is:**
- **Names and data:** project, person and finding names from Checkmarx One, logs and code.
- **The terms of use:** the English text is the binding version.
- **The Cx Credits Calculator's name**, and the names of the two Checkmarx One exports it asks for, so people find them in Checkmarx One. The calculator itself is translated; the projection report it downloads is in English.
- **Emails:** reminder emails stay in English. The interactive report they carry is translated (below).

**Right to left.** In Arabic and Hebrew the whole page is mirrored: the menu is on the right, text starts on the right, and arrows in menu paths point left (Settings ← HTTPS). Charts, code, addresses and numbers keep their left-to-right order.

**Hebrew is switched on with a code, for the people you choose.** An Admin pastes a Hebrew activation code in **Settings → Activation codes**, then ticks the people who may use it under **Who may use Hebrew** (the Admin who applied the code is ticked already). Only they see Hebrew in the language pickers; nobody else is offered it, or ever sent its translation. It lasts until the code expires (12 months) or a deactivation code is pasted; a renewed code keeps the people chosen. Nobody is ever switched to Hebrew automatically from their browser's language; people choose it themselves. Someone who loses Hebrew sees English. Codes come from the maintainer of CxMissionZero; they are checked on the server, with nothing sent anywhere.

**Tone.** While an action runs, every language other than English shows plain, factual status lines, such as "Verifying with Checkmarx One…" instead of a quip.

**Dates and times** are shown in each person's own time zone (their profile; by default their computer's), in their language's format.

## The interactive report

The interactive HTML report (attached to reminders, or downloaded) is in the same languages as the page.

**Which language it opens in:**
1. the language its reader chose in the report before, in that browser;
2. else the language in the profile of the person it was made for (a reminder to one developer, or the person who downloaded it);
3. else the browser's language, when it is one of these;
4. else English.

**Switching.** The **Language** list at the top of the report switches it at any time.
- **Carried in the report:** the profile's language, and Hebrew for the people it is on for. These work offline.
- **Fetched when picked:** any other language comes from the reminder server, which the report reaches anyway to triage. It is then kept in that browser, so it works offline from then on.
- **No server address:** a report that has none offers only what it carries.
- **Size:** each language adds about 60 KB, so a report does not carry all fifteen.

**What is translated:** the headings, the buttons, the counts, the filters and the table headings. Also the messages and confirmations, the credits panel, the **Why** and **Fix** lines under a confirmed finding, and the tools for opening and fixing code.

**What stays as it is:**
- finding titles, project names, file paths, addresses and code;
- what Checkmarx One wrote itself: AI Triage's summary and reasons, and AI Remediation's description of its fix;
- messages the reminder server sends back, such as a refusal for lack of credits.

**Hebrew** travels only in the reports of people it is on for; the reminder server never hands it out.

**Right to left.** In Arabic and Hebrew the report is mirrored like the page.

**How it works:**
- The report carries the page's own translator (`public/i18n.js`), its start-up (`src/report/i18n-boot.client.js`) and the translations of its own wording.
- That wording is listed in `src/report/report-keys.json`, which ships with the server; `scripts/i18n-report.mjs` collects it. If the list cannot be read, reports are still made, in English.
- Wording with a name in it ("{0} — vulnerability report", "tenant {0}") is written by the report's script from `data-l` and `data-v`, so the name is never translated.
- `GET /api/relay/report-words/<code>` serves one open language's words to a report.

## How it works

- **Lazy loading:** `public/i18n.js` loads `public/i18n/<code>.json` only when a language other than English is chosen. In English the page pays nothing extra.
- **Hidden until ready:** while the file loads, the page is hidden for at most 2 seconds, so it never shows English first.
- **How words are swapped:** the page is written in English, and its words are replaced as they appear, once for the whole page and then for whatever the app adds or changes.
- **Sentences with markup:** a sentence containing bold text, code or a link is translated as one piece, so its word order can follow the language. The app's own elements inside it keep working.
- **Numbers:** they become `{0}`, `{1}`… in the lookup, so "Take back 5 unused credits" and "Take back 12 unused credits" share one translation.
- **One English word, two meanings:** the element carries `data-i18n-ctx`. For example, a date range's "To" is looked up as `date|To`, apart from the email "To" field.
- **Left untouched:** anything marked `translate="no"`, such as names, logs and the terms text.

## Keeping it current

1. **Collect the English:** run `scripts/i18n-collect.mjs` for the page, and `scripts/i18n-report.mjs` for the interactive report. It needs Playwright and opens every page, tab, Settings section, panel and dialog with sample data, recording each piece of English exactly as the page will look it up. It writes `i18n/catalog.json`.
2. **Translate:** add each new or changed entry to every language file, following `i18n/GLOSSARY.md`: rules, register for each language, core terms, and terms that must stay distinct.
3. **Check:** run `node scripts/i18n-check.mjs`. `npm test` runs the same checks and fails on any missing entry. The checks cover:
   - placeholders, markup and `<code>` kept exactly;
   - the language's own script used;
   - no simplified characters in Traditional Chinese, and no traditional ones in Simplified Chinese;
   - no Indonesian words in Malay, and no Malay words in Indonesian;
   - no casual particles, and no informal "du" or "tu" in German and French;
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
| German (MZ-01.00.47) | 1,445 | 2 | 2 |
| French (MZ-01.00.47) | 1,445 | 0 | 1 |
| Arabic (MZ-01.00.47) | 1,445 | 18 | 16 |
| Hebrew (MZ-01.00.47) | 1,445 | 16, and 52 menu-path arrows turned to point left | 16 |
| Portuguese, Brazil (MZ-01.00.48) | 1,531 | 72 (one shared term sheet across three translators, accuracy, Brazilian forms) | 15 |

**Fixed in the English itself.** The reviews found places where one English word was doing two jobs:
- **"From" and "To":** used for both email fields and date ranges.
- **"Last month":** meant both the last 30 days and the previous calendar month.

These now have separate entries.

**Added after collection.** Six entries were translated afterwards and then reviewed twice in all nine languages: the date-range "From"/"To", the code-author confidence badges "Sure", "Check" and "Unsure", and the calendar "Last month".

**Added in MZ-01.00.46.** The Credit Control page's **Give credits** bar, its messages, and the row's **Give** and **Take back** buttons: 22 entries in all nine languages. Each was translated against the glossary and the app's existing wording, so **Give** and **Take back** read as opposites everywhere. It then went through the same two separate reviews:
- **Review 1:** 2 corrections (Simplified Chinese and Korean punctuation).
- **Review 2:** 4 corrections: a counter added in Japanese and Thai, Korean quotation marks, and a Malay sentence made less literal.

The **Allocated vs used** table's column headings, the line under each project and the take-back note had stayed in English, because the collected sample had no allocations. They are now 8 more entries in every language, translated and reviewed the same way:
- **Review 1:** 7 corrections (a repeated counter in both Chinese scripts, and "No severities" in Spanish).
- **Review 2:** 4 corrections (the one-credit note worded in the singular in Chinese and Thai, and the standard Indonesian "pertama kali").

**Added in MZ-01.00.47.** 63 entries in all thirteen languages: the sidebar groups **Act**, **Follow up**, **Prove** and **Set up**, the free Let's Encrypt certificate card, **Settings → Activation codes**, and **Show more** in long project lists. "Set up" was checked against each language's word for **Settings**, so the group heading and the page name never read alike. The stage label beside each page title is looked up as `stage|Set up`, apart from the **Set up** button. Each entry was translated, then reviewed twice:
- **Review 1:** 13 corrections. "Set up" moved away from the word for Settings in Spanish, Arabic, Hebrew and Thai. "Act" in Traditional Chinese no longer reads as "mobile". A missing "fast" was restored in four languages, and a Spanish subjunctive was fixed.
- **Review 2:** 11 corrections. Japanese now proves how each credit was used, not the credit. The Chinese scripts gained spacing before a Latin link. Korean and German were made idiomatic. Indonesian uses "Penyiapan", as the rest of its file does. Arabic tooltips use the noun form. Thai gained counting words and a completed sentence.

**Added in MZ-01.00.48.** 34 entries in all thirteen languages: **Settings → Tenants**, the tenant switcher, **Super Admin**, choosing who works in which tenant, **Who may use Hebrew**, and the **Connect** label over the first Get started step. "Super Admin" is the same everywhere it appears in each language. "Tenant" reuses each language's 1.0.47 word. Each entry was translated, then reviewed twice:
- **Review 1:** 3 corrections. Korean "Save who may use Hebrew" no longer reads as "Hebrew speakers", and Spanish gained "Usted está aquí" and "Todas las personas".
- **Review 2:** 7 corrections. A Korean grammar fix; German, Spanish, Vietnamese and Indonesian made clearer ("Die Funktion „Mehrere Tenants“ ist aktiviert"). "Connect" was translated in this round in seven languages, and then checked on its own.

**Added in MZ-01.00.49.** 111 entries in all fourteen languages. The tracked-report panel on the Reports page (Overview, Remind, Triage, Verify and History tabs) and the portfolio strip above it had stayed in English: the collector never opened a saved report. It now saves one when the Dashboard's Track step did not, and opens each tab. The batch also has this release's **Triage with AI Assist now** and **Remediate with AI Assist now** (with "AI Assist" kept as a product name), Credit Control's **Use the credits** bar and the messages after each run. Each entry was translated against the app's existing wording, then reviewed twice:
- **Review 1:** 58 corrections. Portuguese and Spanish "rescanned on their behalf" no longer read "rescanned by them". Arabic now uses its existing word for "no longer detected", and its number agreement was fixed. German and French "every how many days" became "interval in days". Thai "awaiting" now says "awaiting triage". Malay "branch" is the Malaysian "cawangan".
- **Review 2:** 52 corrections. Chinese, Korean and Thai numbers gained their counters ("{0} 點", "เครดิต"). A French sentence gained its missing verb. Malay lost three Indonesian words ("setelah"). Hebrew's "Needs follow-up" chip no longer repeats the word for "tracked".

While checking this release, five German and five French entries were found with their lookup context left in the wording, for example "credits|Übrig". They are fixed, and the automatic check now refuses a translation that starts with one.

**Added in MZ-01.00.50.** 84 entries in all fourteen languages: the **Impact** page (its Executive and Detail tabs, the figures, the security debt chart and table, time to fix, how the figures are worked out) and its settings. "Impact", "Security debt", "Noise removed", "Hours saved", "Time to fix" and "with AI / by hand" read the same in every entry of each language. Amounts with their currency are left as they are, and the words beside them are translated on their own. A number with decimals or thousands separators (43.3 h, 1,828) now finds its translation too. Each entry was translated, then reviewed twice:
- **Review 1:** 55 corrections. "Zero by" a date now means "no later than" in Spanish, German, French and Portuguese, not "on". Arabic no longer reads "first detection" as "the first finding". Recipients gained their counters in Japanese, Chinese and Korean. Malay "send by email" follows the Malay file.
- **Review 2:** 91 corrections. The tab names became natural: "Executive summary" in Arabic, Hebrew, Spanish, Portuguese, Vietnamese and Thai; "Synthèse" in French. Hebrew "sooner/later" no longer reads "faster/slower". The Japanese "Checked by AI" heading no longer reads "Confirmed by AI". French uses "manuellement" for "by hand". "Open is what is open now" now explains itself.

**Added in MZ-01.00.51.** 11 entries in all fourteen languages: **Allocate credits for triage and remediation** on a tracked report's Triage tab and on Credit Control, Credit Control's **Allocate and use credits** bar (which replaces **Use the credits**), its **Extra credits each** boxes, both confirm questions and the message after allocating. Five entries that are no longer shown were dropped. "Allocate" follows each language's existing "Allocate credits to projects". The **Give credits** note quotes the new button name word for word. Each entry was translated, then reviewed twice:
- **Review 1:** 6 corrections. The quotation marks around the button name now match each file (Korean, Spanish, Portuguese). German no longer says projects "hold" credits, and Hebrew says it the way the rest of its file does. Malay "for each project" reads correctly.
- **Review 2:** 6 corrections. In both Chinese files the two confirm dialogs are now a single question, in the same pattern as the app's other confirm dialogs. German "any extra credits" no longer reads "random extra credits". The Thai questions end the way the file's other confirm dialogs do.

**Added in MZ-01.00.53.** 80 entries in all fourteen languages: **Get help**. That covers the sidebar menu, both forms, the request page with its conversation and status history, the support queue and its filters, the "Answer support cases & enhancements" permission, **Settings → Get help**, and the email mode. "Get help", "support case", "enhancement", "support team" and the five statuses read the same in every entry of each language. Two entries carry a context: a request's own **New** and its **Open** filter. They have their own wording because the app's existing "New" and "Open" were written for findings, often in the plural. Each entry was translated, then reviewed twice:
- **Review 1:** about 60 corrections. Filter options now pair ("All / Mine" rather than "Everyone / Me"). Statuses and priorities agree with a request in Spanish, Portuguese and French. "Blocked" is no longer masculine-only in Spanish and French. The quotation marks around feature names now follow each file. German, Spanish, Portuguese and French no longer count one request in the plural.
- **Review 2:** about 40 corrections. In Arabic and Thai, "template" is no longer the word for "form". In Arabic, Hebrew, Vietnamese and Thai, "addressed to" belongs to the message, not to the email app. German "Waiting for reply" reads as a status. The open-requests filter matches its singular neighbours in Spanish, Portuguese and French. Arabic "Get help" is shortened to fit the sidebar.

**Added in MZ-01.00.54.** 32 entries in all fourteen languages: **Settings → Your branding**, the three new permissions (**See the Branding page**, **Their own branding**, **See the Activation codes page**) with their descriptions and role labels, and the read-only note on Activation codes. One entry that is no longer shown was dropped. "Your branding" follows each file's "Your profile" and stays distinct from the organisation's "Branding". Each entry was translated, then reviewed twice:
- **Review 1:** 27 corrections. The small button next to the colour picker now says it brings back the organisation's colour, not its "settings". Spanish, Portuguese and French no longer use a pronoun with nothing to refer to ("with it on"). Malay and Indonesian no longer translate "carry" word for word. The role names in Portuguese and French sentences follow each file.
- **Review 2:** 54 corrections. The permission "Their own branding" now uses the same word as the section in Japanese, both Chinese files, Vietnamese and Malay, and is gender-neutral in Arabic. "Off:" matches each file's other switches in Spanish, Portuguese, French and Arabic. Spanish status lines no longer read as an informal command. Vietnamese, Thai and Malay fragments gained their missing verbs, and Chinese no longer repeats "you".

**Added in MZ-01.00.55.** 2 entries in all fourteen languages, on **Settings → Activation codes**: a new opening sentence that names no add-on, and **No add-ons are unlocked yet**. The old opening sentence, which named Hebrew and several tenants, was dropped. "Unlocked" reads the same as the page's **Unlocked** badge in each file. Each entry was translated, then reviewed twice:
- **Review 1:** 5 corrections. Japanese and Korean now say "add-ons", as the files do, instead of a general word for features. Portuguese no longer says "na hora" (too casual), and the Thai and Malay sentences now say clearly that the code does the unlocking.
- **Review 2:** 3 corrections. The Korean sentence is split in two, as the old one was. Thai no longer repeats "the system will", and Malay says "what it unlocks" rather than "anything".

**Added in MZ-01.00.56.** 57 entries in all fourteen languages: **Settings → Hands-off**. That covers the four questions, the ready checks, steering by email, the self-check, weekday names and the messages. "Hands-off" has one name per language, used everywhere it appears and kept apart from "Automation". Examples: ja 無人運用, zh 無人值守 / 无人值守, ko 무인 운영, es and pt-BR "Piloto automático", de "Autopilot" and fr "Pilote automatique". The command words PAUSE, RESUME, RUN, STATUS and STOP stay in English, because people type them in a reply. Each entry was translated, then reviewed twice:
- **Review 1:** 54 corrections. Japanese and Malay got a name that cannot be confused with Automation (無人運用, Autopandu). "Ageing findings", "Tick" and the "now" buttons now use each file's own words. French recipient labels read naturally, and Hebrew asks what MissionZero *should* do.
- **Review 2:** 56 corrections. Japanese and Thai use the file's existing word for "self-check". French calls the weekly email a "bilan", where "point" could be read as "an item". The step headings read as a set of short questions. German messages are less colloquial, and the feature name is spelled the same everywhere in Vietnamese and Indonesian.


**Added in MZ-01.00.57.** 259 entries in all fourteen languages: the **How to fix it** box (what is wrong with the email server, Checkmarx One or a git host, and the steps that fix it) and the .env file check. Variable names, values to type, commands, addresses and the names of other products' screens (for example **Authenticated SMTP**, **App Password**, **Settings → Developer settings → Personal access tokens**) stay in English, so administrators can find them. MissionZero's own screens and options use each file's existing words. Each entry was translated, then reviewed twice:
- **Review 1:** 151 corrections. French "fewer projects in one report" no longer reads as "compared to a report". Spanish, Vietnamese and Thai now say a Gmail password is not 16 characters long, rather than "not an App Password". Japanese "Did you mean" no longer reads "Candidates". Korean, Malay and Indonesian no longer translate DNS "resolve" as "check" or "solve". "Relay", "sign-in" and "repository" each use one word per language.
- **Review 2:** 196 corrections, 57 of them Spanish and Portuguese quotation marks matching their files. Indonesian "Did you mean" no longer reads "What do you mean?". Arabic, Vietnamese and Thai say the mail server sends *from* signed-in accounts, not *to* them, and Hebrew's port 443 is "websites", not "the internet". "Would break the connections" reads as "would stop them working", not "interrupt" or "cut off", and the polite "your company" is used in both Chinese files.

**Added in MZ-01.00.58.** 1 entry in all fourteen languages: the warning on **Settings → Activation codes** when Hebrew is on but nobody is ticked under **Who may use Hebrew**. It uses each file's words for Hebrew, ticking and saving. Translated, then reviewed twice:
- **Review 1:** 4 corrections. Malay "anda" is lower case as in its file, Spanish speaks of people who will *use* Hebrew, the Thai sentence no longer stops mid-verb, and Hebrew uses the file's word for "user".
- **Review 2:** 9 corrections. The Chinese files no longer call the language "it", German and Korean say Hebrew appears in nobody's list, and Spanish, French, Malay and Indonesian drop a casual "so".

**Added in MZ-01.00.59.** 407 entries in all fourteen languages: everything the interactive HTML report says. That covers its page, buttons, messages and confirmations, the credits panel, the tools for opening and fixing code, and the fix advice under a confirmed finding (64 sentences). Product, engine and tool names, code, headers, paths and numbers stay as they are. Checkmarx One's own state name “To verify” stays in English, because that is what Checkmarx One shows. Two entries are new kinds:
- **"That language could not be loaded…":** the message when the reminder server does not answer.
- **`verdict|Not exploitable`:** one finding's verdict, in the singular. The app's "Not exploitable" is a filter of many findings, plural in several languages. In Arabic every verdict agrees with the masculine الاكتشاف.

Each entry was translated, then reviewed twice:
- **Review 1:** 247 corrections. "✓ Remediation opened" now leads into its "PR #42" link in every language, instead of reading "remediation started". French "reachable" (the AI Triage verdict about code) no longer reads as "can be contacted". Japanese, Korean, Malay and Indonesian now keep it apart from the server's "Unreachable". Credit counts read correctly for 1 in German, French, Spanish, Portuguese and Hebrew. Vietnamese and Thai "encode" no longer reads as "encrypt", and Arabic and Hebrew arrows point right to left.
- **Review 2:** 132 corrections, 29 of them Vietnamese AI feature names in lower case mid-sentence, as its file writes them. Hebrew "reachable" is no longer the server's word. German "Uncertain" no longer reads as "insecure", and Simplified Chinese "Secret" no longer reads as "key". Spanish and Portuguese "Verified at zero" now says that nothing is left. Japanese and Korean "prove the fixes" now says the fixes worked.

The late message was corrected in seven languages by the first review and in none by the second. The singular verdict needed no correction.

**Added in MZ-01.00.61.** 77 entries in all fourteen languages: the **Credit projections** page (profiles, the Fusion tab, its totals and messages, and the permission). The backlog cost calculator on the À la carte tab stays in English, and so do the two Checkmarx One export names it asks for, so people can find them in Checkmarx One. "Fusion" stays as it is, also on its own as a tab label; the checks now allow that. Numbers the page formats itself (10,000, 10.000 or 10 000, the reader's way) are one placeholder, so each language's own thousands separator works. Each entry was translated, then reviewed twice:
- **Review 1:** 106 corrections. "Remove" a project now reads "take out of the projection", not "delete", in Japanese, Indonesian, Vietnamese and Korean, and "taken off" says *from the projection* in seven languages. "Profile" in both Chinese files no longer reads as a settings file. Thai "Include" no longer reads as "Total", and "Read lines of code" as reading the code itself. The fixed example text uses each language's own thousands separator.
- **Review 2:** 27 corrections. Arabic uses the dual for the two example projects. Hebrew no longer compares bundles with lines. Spanish and Portuguese tooltips address the reader as their files do, and the Chinese "No scan" reads "no scan yet". Japanese and Korean needed none.


**Added in MZ-01.00.62.** 176 entries in all fourteen languages: the **Cx Credits Calculator** (its Plan menu group, the triage & remediation and Fusion tabs, the extra % and bundles, projection reports, and the organisation's name on the terms dialog and in Settings). The 50 entries of MZ-01.00.61's Credit projections page that are no longer used were taken out of every file. "Cx Credits Calculator" stays as it is, as a name; the checks now allow that. The calculator's markup was changed so that every label is translated whole: chart legends and severity swatches no longer put colour codes into the text, and the backlog line is one sentence with its two dates. Each entry was translated, then reviewed twice:
- **Review 1:** 111 corrections. Japanese "criticality" was one character away from "severity" and is now ビジネス重要度. The "Latest" period button no longer reads as "the previous week" in Arabic and Hebrew. The "Scanned today" column now says "current scan frequency" in German, Arabic and Hebrew, not "being scanned now". "&" in tab labels follows each file's own way of writing it (y, e, et, và, และ, و, ו), and the criticality rows no longer read "at least critical" in Malay and Indonesian.
- **Review 2:** 47 corrections. "Includes {0} extra" now says extra *credits* in five languages, "{0}, rounded up" reads "rounded up from {0}" in Vietnamese and Thai, where the decimal comma made it ambiguous, and the reports list's "By" / "Made" columns read as a pair in German, French, Arabic and Hebrew. In Arabic and Hebrew, "Cx Credits Calculator → Fusion" in Jump to has a right-to-left mark, so the arrow points the right way when both sides are in Latin script.