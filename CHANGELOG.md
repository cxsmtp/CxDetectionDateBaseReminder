# CxMissionZero version log

Every release, newest first: the version shown bottom-left in the app (MZ-xx.xx.xx), when it was merged, and the main features. Updated with every release.

### Performance and security status

Measured for every release: 3000 people at once on a 2 vCPU server, all tests, `npm audit --omit=dev`, and the last Checkmarx One scan of this code. Every version since the first is in [docs/status.md](docs/status.md).

| Version | Requests/s, failed | Report opens p95 | Triage polls p95 | Tests | Dependencies | Checkmarx One |
| --- | --- | --- | --- | --- | --- | --- |
| MZ-01.00.49 | 498/s, 0 (main 469, 206) | 8.3 s | 1.1 s | TESTS | 0 vulnerabilities | Last scan (MZ-01.00.26): no critical, high or medium open; 15 low judged false positives |
| MZ-01.00.48 | 498/s, 7 (main 489, 44) | 8.2 s | 880 ms | 519 | 0 | same |
| MZ-01.00.47 | 519/s, 0 (main 504) | 5.3 s | 310 ms | 506 | 0 | same |
| MZ-01.00.46 | 468/s, 44 (host stalls; main 177) | 10.1 s | 1.3 s | 479 | 0 | same |
| MZ-01.00.45 | 497/s, 0 | 7.9 s | 1.2 s | 478 | 0 | same |
| MZ-01.00.44 | 520/s, 0 | 7.1 s | 384 ms | 461 | 0 | same |
| MZ-01.00.43 | 511/s, 0 | 5.7 s | 224 ms | 461 | 0 | same |
| MZ-01.00.42 | — (page only) | — | — | 455 | 0 | same |
| MZ-01.00.41 | 519/s, 0 | 0.9 s | 171 ms | 455 | 0 | same |
| MZ-01.00.40 | 516/s, 0 | 5.9 s | 183 ms | 445 | 0 | same |
| MZ-01.00.39 | 512/s, 0 | 5.7 s | 240 ms | 439 | 0 | same |
| MZ-01.00.38 | 518/s, 0 | 0.6 s | 146 ms | 430 | 0 | same |
| MZ-01.00.37 | 508/s, 0 | 5.1 s | 179 ms | 427 | 0 | same |
| MZ-01.00.36 | 492/s, 0 | 2.3 s | 118 ms | 421 | 0 | same |
| MZ-01.00.35 | 529/s, 0 | 0.6 s | 113 ms | 414 | 0 | same |
| MZ-01.00.34 | 514/s, 0 | 4.2 s | 122 ms | 407 | 0 | same |
| MZ-01.00.33 | 511/s, 0 | 3.9 s | 172 ms | 407 | 0 | same |
| MZ-01.00.32 | 511/s, 0 | 2.5 s | 145 ms | 402 | 0 | same |
| MZ-01.00.31 | 524/s, 0 | 2.5 s | 106 ms | 388 | 0 | same |
| MZ-01.00.30 | 524/s, 0 | 4.1 s | 371 ms | 386 | 0 | same |
| MZ-01.00.29 | 508/s, 0 | 2.6 s | 206 ms | 375 | 0 | same |
| MZ-01.00.28 | 522/s, 0 | 1.3 s | 316 ms | 374 | 0 | same |
| MZ-01.00.27 | 518/s, 0 | 5.0 s | 289 ms | 368 | 0 | same |
| MZ-01.00.26 | 506/s, 0 | 4.4 s | 237 ms | 359 | 0 | Scan 617100eb: 0 / 1 / 0 / 15; the high fixed before release |
| MZ-01.00.25 | 501/s, 0 | 6.2 s | 689 ms | 331 | 0 | Scan 0d6b0f2e: SAST 4 / 19 / 38 / 77 + 5 API; fixed in MZ-01.00.26 |
| MZ-01.00.21 | 505/s, 0 | 6.2 s | 0.7 s | 314 | 0 | not scanned |
| MZ-01.00.17 | 494/s, 6 | 2.1 s | 240 ms | 303 | 0 | not scanned |

## MZ-01.00.49 — MERGE_TIME UTC · [#PRNUM](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/PRNUM)
- **The same two golden buttons in three places.** **Triage with AI Assist now** and **Remediate with AI Assist now** are on the Dashboard, on a tracked report's **Triage** tab and on Credit Control. Each turns gold, with its glow and sweep, once the credits given cover the work, and goes back to plain once the work is sent.
- **Remediate from a tracked report.** Next to triage, a report now sends its confirmed findings, at the chosen severities, for AI Remediation: 3 credits each, out of what its projects were given. The line above the buttons now also says how many confirmed findings wait to be fixed.
- **Use the credits on Credit Control.** Tick projects in **Allocated vs used** (or none, for every project) and the severities, then **Triage with AI Assist now** or **Remediate with AI Assist now**. Findings are read fresh from Checkmarx One, so nothing needs loading on the Dashboard. Each run is in the audit log as started from Credit Control.
- **Credits in step everywhere.** Credits given, taken back or used on Reports or Credit Control show on the Dashboard straight away, without loading findings again; Reports and Credit Control show the latest whenever they are opened.
- **The Reports panel in every language.** The tracked-report panel (Overview, Remind, Triage, Verify, History) and the portfolio strip had stayed in English. They are 111 entries, with this release's buttons, translated into all fourteen languages and reviewed twice ([languages](docs/languages.md)).
- **Status.** In the benchmark pair, the branch served 498 requests a second with 0 failed, against main's 469 with 206 failed while its host stalled. Report opens took 8.3 s and triage polls 1.1 s at p95 (main 12.7 s and 1.6 s). No finding was sent twice. TESTS tests pass; `npm audit` finds 0 vulnerabilities; the last Checkmarx One scan (MZ-01.00.26) has no critical, high or medium open.

## MZ-01.00.48 — 2026-10-05 15:30 UTC · [#71](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/71)
- **Several Checkmarx One tenants on one server.** With a tenants activation code, a Super Admin turns on **Settings → Tenants** and adds tenants, up to the number the code allows. Each tenant keeps its own Checkmarx One connection, email server, settings, credits, tracked reports, automation, audit log and people. People who work in several tenants switch between them at the top of the page. Without a code, nothing changes ([several tenants](docs/multi-tenant.md)).
- **Each tenant stays separate.** People added in a tenant work only there, without the permissions that act on the whole server (HTTPS, backups, updates, activation codes). A Super Admin chooses who works where under **People & roles**. Emailed reports, and every link in them, act only in their own tenant. A Super Admin adding or opening a tenant is recorded in that tenant's audit log.
- **Hebrew for the people you choose.** With the Hebrew code in force, tick the people who may use it under **Settings → Activation codes → Who may use Hebrew**. Only they are offered Hebrew, or ever sent its translation.
- **Português (Brasil).** Brazilian Portuguese is open to everyone, and every Portuguese browser picks it. It was translated in full and reviewed twice.
- **Golden buttons when the credits are in place.** **Check with AI now** and **Fix with AI now** on the Dashboard turn gold, with a slow glow and a light sweeping across, once the credits given cover what is selected; so does a tracked report's **Triage now**. One click then checks, or fixes, everything selected across projects.
- **Get started begins with Connect.** The first step, **Connect Checkmarx One**, is labelled **Connect**.
- **Backups hold everything.** One backup now includes every tenant, the activation codes in force and the language settings.
- **Status.** In the calm pair, the branch served 498 requests a second with 7 failed (connect timeouts), against main's 489 with 44. Report opens took 8.2 s and triage polls 880 ms at p95 (main 10.1 s and 888 ms). A first build was slower on Node 22, because of the tenant context on every request; with one tenant that context is now never entered ([performance](docs/performance.md)). No finding was sent twice. 519 tests pass; `npm audit` finds 0 vulnerabilities; the last Checkmarx One scan (MZ-01.00.26) has no critical, high or medium open.

## MZ-01.00.47 — 2026-10-05 14:33 UTC · [#70](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/70)
- **A free HTTPS certificate in one click.** **Settings → HTTPS → Free certificate from Let's Encrypt** gets a certificate trusted by every browser and renews it by itself 30 days before it expires. It needs a DNS name for the server and port 80 open to the internet. To set it up at deployment instead, use one line: `LETSENCRYPT_DOMAIN=mz.company.com`. The server then gets the certificate, switches to HTTPS only and renews it with no further steps ([HTTPS and hosting](docs/https-and-hosting.md)).
- **German, French and Arabic.** They join the language pickers for everyone, in a formal register. Arabic reads right to left: the whole page is mirrored, while charts, code and addresses keep their direction.
- **Hebrew with an activation code.** An Admin pastes a Hebrew code in **Settings → Activation codes**, and Hebrew (right to left) appears for everyone until the code expires or a deactivation code is pasted. Nobody is switched to it automatically.
- **Activation codes.** A new Settings section shows what is unlocked (Hebrew; several Checkmarx One tenants), for whom and until when, and warns 30 days before a code expires. Codes last 12 months. They are checked on the server with nothing sent anywhere, and every code entered is in the audit log ([activation codes](docs/activation-codes.md)).
- **Fast with 1,000 projects.** The project list shows 100 rows at a time, with **Show more** and **Show all**. Search waits for a pause in typing, and loading redraws less often. On a slow laptop:
  - the longest freeze while loading findings went from 2.7 s to 0.24 s;
  - searching settles in 1.8 s instead of 21.5 s;
  - going back to the Dashboard takes 0.25 s instead of 1.9 s ([performance](docs/performance.md#mz-010047-the-page-with-1000-projects)).
- **Pages grouped by what you came to do.** The sidebar's groups are now **Act** (Dashboard, Beta), **Follow up** (Reports), **Prove** (Credit Control, Audit) and **Set up** (People & roles, Settings, Logs). The emailed report's strip reads "Found by Checkmarx One → Fix it here → Every credit audited".
- **Translated, and reviewed twice.** German, French, Arabic and Hebrew were each translated and then reviewed twice in full. The 63 new pieces of wording are in all thirteen languages, also reviewed twice ([languages](docs/languages.md)).
- **Status.** Two pairs with main. In the calm pair, the branch served 519 requests a second with 0 failed (main 504, 0 failed). Report opens took 5.3 s and triage polls 310 ms at p95 (main 6.4 s and 539 ms). In the first pair, the host stalled and both sides lost connections (main 53, branch 112). No finding was sent twice. 506 tests pass; `npm audit` finds 0 vulnerabilities; the last Checkmarx One scan (MZ-01.00.26) has no critical, high or medium open.

## MZ-01.00.46 — 2026-10-05 09:02 UTC · [#69](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/69)
- **Give credits on Credit Control too.** **Allocated vs used** has a **Give credits** bar for anyone allowed to allocate credits:
  - type a project's name (every Checkmarx One project is listed, not only those that already hold credits);
  - enter AI Triage and AI Remediation credits, then confirm.

  No findings need loading. The credits come out of the credit pool, and the bar shows how many are free to give.
- **Give on each row.** Next to **Take back**, **Give** fills in that project.
- **Same safeguards as the Dashboard.** A gift larger than the pool has free is refused. Every gift and refusal is in the audit log, and **Take back** returns what was not used. To give exactly what a project's findings need, use the Dashboard, which checks the count with Checkmarx One first.
- **Translated, and reviewed twice.** The new wording is in all nine languages. So are the table's column headings, the take-back note and the line under each project, which had stayed in English.
- **Status.** Every failed request was a connection reset while the host stalled. Over two pairs, the branch failed 151 and 44 times and main failed 88 and 177 times. The branch served 468–470 requests a second (main 475–498), with report opens at 10.1–11.4 s p95 (main 10.9–11.3 s). No finding was sent twice. 479 tests pass; `npm audit` finds 0 vulnerabilities; the last Checkmarx One scan (MZ-01.00.26) has no critical, high or medium open.

## MZ-01.00.45 — 2026-10-05 07:19 UTC · [#68](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/68)
- **In nine more languages.**
  - The languages: Japanese, Traditional Chinese (Taiwan), Simplified Chinese, Korean, Spanish, Vietnamese, Thai, Malay and Indonesian.
  - Choose with the globe at the top right; the first time, CxMissionZero uses your browser's language.
  - Translated: menus, options, buttons, hints and messages. Names, logs, code and the terms of use stay as they are.
  - English pages load nothing extra.
- **Checked twice, in a professional tone.** Each language went through two separate full reviews and automated checks of placeholders, markup, script and register. While something runs, the status line is plain and factual in every language ([languages](docs/languages.md)).
- **Your profile.** Open your name at the top right, then **Your profile**; it is in Settings too, for every role.
  - **Shown:** your email, role and last sign-in.
  - **Set:** your picture, name, language, time zone (your computer's by default) and programming languages.
  - **Saved:** with your account; every page shows times in your time zone.
- **Fixes come from Checkmarx One AI.** The emailed report no longer offers outside AI assistants. Each finding has **Open in …** and **Apply AI fix**, which applies the fix AI Remediation wrote; until then, it asks the developer to remediate the finding first.
- **Auto-update says why it waits.** The Update page now says what each check found:
  - up to date;
  - which release is waiting, and for which hour, in the server's time zone (shown next to the hour);
  - or what stops it.

  It also looks a minute after every start, and a half-finished install no longer blocks it.
- **Status.** 497 requests a second with 3000 people at once and 0 failed; main, measured the same day on the same slower machine, had 145 failed. Report opens take 7.9 s and triage polls 1.2 s at p95 (main: 12.1 s and 1.1 s). 478 tests pass; `npm audit` finds 0 vulnerabilities; the last Checkmarx One scan (MZ-01.00.26) has no critical, high or medium open.

## MZ-01.00.44 — 2026-10-05 02:59 UTC · [#67](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/67)
- **Hide the menu.** **Hide menu** (bottom of the sidebar) turns it into a slim bar of icons. Point at it and the full menu opens over the page without moving anything; **Keep menu open** brings it back. The choice is remembered, and the menu is also narrower when kept open.
- **The Dashboard's top stays in view.** What to load, **Load findings**, the totals and the way to Mission Zero now form one compact block. It takes about a fifth of a 1080p screen (under a third of a laptop's) and stays at the top while you scroll, so the scope and **Load findings** are always at hand.
- **One scroll bar.** The projects table no longer scrolls inside its own box. The page scrolls, and the table's header row and the action panel stay in view under the top block.
- **Leaner header and totals.** Each page's title and subtitle share one line, and the totals are one-line chips ("18 Projects", "36 Past SLA").
- **Status.** The server is unchanged; 520 requests a second with 3000 people at once and 0 failed (main 502). Report opens take 7.1 s and triage polls 384 ms at p95 (main 6.4 s and 355 ms on the same slower machine). 461 tests pass; `npm audit` finds 0 vulnerabilities; the last Checkmarx One scan (MZ-01.00.26) has no critical, high or medium open.

## MZ-01.00.43 — 2026-10-05 02:41 UTC · [#66](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/66)
- **Azure DevOps takes the organisation in any form.** You can enter its name (`checkmarxdemo`), `https://dev.azure.com/checkmarxdemo`, a project or repository page you copied from the browser, or the older `checkmarxdemo.visualstudio.com`. All are stored as `https://dev.azure.com/checkmarxdemo`. A project page used to make every request fail with "not found", and addresses saved that way now work without being entered again.
- **The token follows the organisation.** Writing the same organisation another way keeps its token, and another organisation on dev.azure.com drops it. When cloning for Code authors, the token is sent to the organisation's repositories under either address.
- **Test says what to fix.** Azure DevOps does not reject a wrong token; it answers as Anonymous. Test now names the organisation, says the token was not accepted, and lists what to check: made for that organisation, active, not expired, pasted in full. A wrong address and a token saved without its organisation are each explained too.
- **Status.** 511 requests a second with 3000 people at once and 0 failed (main 518). Report opens take 5.7 s and triage polls 224 ms at p95. 461 tests pass; `npm audit` finds 0 vulnerabilities; the last Checkmarx One scan (MZ-01.00.26) has no critical, high or medium open.

## MZ-01.00.42 — 2026-10-04 18:17 UTC · [#65](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/65)
- **Download HTML is back.** It sits next to **Preview email** and **Preview report** under Remind again. It no longer hides behind *Show advanced options* or the attachment switch.
- **Take back unused credits, at the top.** The AI credits panel shows it next to **Check the numbers again**, with how many it would return ("Take back 36 unused credits").
- **Last week by default.** *Projects last scanned in* and *Findings first found in* start at **Last week** instead of any time. After a load, the page keeps the scope you used.
- **Severities in one row.** Critical, High, Medium and Low no longer leave Low on a line of its own.
- **Report names in full.** On the Reports page, a narrower window no longer cuts off the first letters of each report's name.
- **Status.** The server is unchanged from MZ-01.00.41; this version changes only the page. 455 tests pass and `npm audit` finds 0 vulnerabilities. The benchmark ran on a slower machine where main failed requests too, so it is shown as "—" (details in docs/performance.md). The last Checkmarx One scan (MZ-01.00.26) has no critical, high or medium open.

## MZ-01.00.41 — 2026-10-04 13:58 UTC · [#64](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/64)
- **Replace the whole image from the Update page (Beta).** For the rare release that needs a new Node.js or OS base: pick **latest** or a version under **Settings → Update & recovery → Replace the whole image**, and click **Replace the image**. A backup is taken first.
- **The update companion does it.** It is a second small container you start once; the command is on the page and in docs/updating.md, for Podman on Windows cmd. It downloads the image while the server keeps running, stops the server (which saves first), and starts the same container on the new image with the same ports, volume, environment, limits and security options.
- **Back by itself if it fails.** If the new server does not say it started within 150 s, or stops soon after, the companion removes it and starts the previous container again. A download that fails changes nothing.
- **Kept to one job.** Only the companion gets the Podman socket, never the app. It opens no port and replaces only the one container, and only with this app's image at a version, `latest` or a commit tag. A request cannot name another image or change how the container starts.
- **Tested on a real engine.** Clicking **Replace the image** moved the real app from a 1.0.90 image to 1.0.91 in about 20 s with its data and hardening options kept, and the page reloaded on the new version. A crashing image was rolled back.
- **Status.** 519 requests a second with 3000 people at once and 0 failed (main 520); report opens 0.9 s and triage polls 171 ms at p95 (the first of two pairs was 6.4 s and 370 ms against main's 6.5 s and 273 ms; see docs/performance.md). 455 tests pass; `npm audit` finds 0 vulnerabilities; the last Checkmarx One scan (MZ-01.00.26) has no critical, high or medium open.

## MZ-01.00.40 — 2026-10-04 13:32 UTC · [#63](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/63)
- **Past SLA, in the repository too (Beta).** Turn on **Settings → SLAs → Also open an issue in the repository**. Each scheduled run then opens one issue in each project's repository listing its findings that went past their SLA, with severity, where, how far past and a link to Checkmarx One.
- **Once per finding.** A finding goes into an issue once, kept separately from the email escalation, so either can be used alone. A fixed finding that comes back is listed again.
- **Never published.** Issues are opened only in private and internal repositories (on GitLab as confidential issues), and a public one is skipped. Text from findings cannot mention anyone or add links.
- **GitHub and GitLab.** It uses the token connected under Beta → Source-code hosts, which needs permission to create issues. Azure DevOps and Bitbucket repositories are skipped, with the reason shown.
- **Visible in the run history.** Each run says how many issues it opened, or would open in test mode, and which projects were skipped and why. **Also running by itself** on the Automation page shows it is on.
- **Status.** 516 requests a second with 3000 people at once and 0 failed (main 509 and 520). One of three branch runs stalled and had 9 failed requests; the other two had none, and the change is not on any path the benchmark uses (see docs/performance.md). Report opens are 5.9 s and triage polls 183 ms at p95; 445 tests pass; `npm audit` finds 0 vulnerabilities; the last Checkmarx One scan (MZ-01.00.26) has no critical, high or medium open.

## MZ-01.00.39 — 2026-10-04 13:14 UTC · [#62](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/62)
- **Code owners next to the author.** Code authors shows the owners the repository's `CODEOWNERS` file gives each file, read the way GitHub and GitLab read it (including GitLab sections), at the scanned version.
- **The change request behind a line.** For each blamed commit on GitHub or GitLab, the Commit column shows the pull or merge request it came in through, who opened it and who approved it; a reviewer who approved and then asked for changes is not counted.
- **In the authors' email too.** Each code author's email now lists the file's code owners and links the pull or merge request for each finding.
- **Which version to upgrade to.** In the emailed report, an open-source package finding says **upgrade to …** when Checkmarx One gives a recommended version.
- **Read-only, and nothing new to set up.** These use the host tokens you already connected: at most 3 requests a repository for `CODEOWNERS` and 2 per commit for its change request. Azure DevOps and Bitbucket show code owners from the clone git blame already made, and never get a new clone just for this.
- **Status.** 512 requests a second with 3000 people at once and 0 failed (main 526); report opens 5.7 s at p95 on both this version and main, and triage polls 240 ms; 439 tests pass; `npm audit` finds 0 vulnerabilities; the last Checkmarx One scan (MZ-01.00.26) has no critical, high or medium open.

## MZ-01.00.38 — 2026-10-04 13:03 UTC · [#61](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/61)
- **Who gets reminders: one choice.** **Dashboard → Remind → Send to** (each developer, the fixed list, or both) now decides it everywhere: reminders sent by hand, scheduled runs and tracked reports' follow-ups. Settings → Automation shows the choice instead of asking again, and an older setup keeps sending to whoever its scheduled runs did.
- **Both, now for everyone.** **Both** is no longer an advanced option. If the fixed list is empty, a scheduled run says so instead of quietly sending to nobody.
- **A tracked report's follow-up sits with its reminder.** The Schedule tab is gone: its **Automatic follow-up** is under the Remind tab, and the Upcoming follow-ups list opens it there. **Only for this report…** still gives one report its own recipients.
- **Credits are given in one place.** A tracked report's Triage tab no longer has its own extra-credit fields: **Give credits on the Dashboard** opens the Dashboard's AI credits panel with the report's projects in scope and loads their findings.
- **Everything that runs by itself, in one list.** Settings → Automation has **Also running by itself**: SLA escalation, and each tracked report's automatic follow-up and rescan, each with a link to open it.
- **Status.** 518 requests a second with 3000 people at once and 0 failed (main 517); report opens 0.6 s and triage polls 146 ms at p95; 430 tests pass; `npm audit` finds 0 vulnerabilities; the last Checkmarx One scan (MZ-01.00.26) has no critical, high or medium open.

## MZ-01.00.37 — 2026-10-04 12:45 UTC · [#60](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/60)
- **SLAs, in Beta.** Each severity has a number of days to be fixed, counted from first detection: critical 7, high 30, medium 90 and low 180, unless you change them under **Settings → SLAs**. Findings triaged as not exploitable have none.
- **Past SLA on the Dashboard.** A red tile shows how many open findings are past their SLA, with how many more are due within 7 days under it. Each project has a **Past SLA** column (**Due ≤ 7d** under **Columns**), and both are in the CSV export.
- **Escalation, once per finding.** Switch it on and name who to escalate to. Each scheduled run then emails one list of the findings that went past their SLA since the last run, with the project, severity, how far past and who ran the latest scan. A fixed finding that comes back is escalated again, and test mode counts without sending.
- **In Beta until you're happy with it.** Roles with Beta access see it. An Admin makes it final under **Settings → Beta features**, and from then on everyone who loads findings sees the SLA figures.
- **Status.** 64,117 requests with 0 failed for 3000 people at once on 2 vCPU, and no finding sent twice. Report opens took 5.1 s at p95 (main 5.1 s in the same pair). All 427 tests pass, and `npm audit` finds 0 vulnerabilities. The last Checkmarx One scan leaves no critical, high or medium finding open.

## MZ-01.00.36 — 2026-10-04 11:55 UTC · [#59](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/59)
- **Stop while loading findings.** A **Stop** button sits beside **Load findings** while it loads. Projects already being read finish, the rest are skipped, and what has loaded is kept and ready to use, as after a full load. Leaving the page mid-load stops it the same way.
- **Your own browser icon.** Settings → Branding has a **Browser icon**: paste an https address or upload an image, up to 100 KB. By default it is CxMissionZero's new **MZ0** icon, a white MZ inside a green zero, which also appears on the sign-in and developer pages.
- **The Dashboard never loads findings by itself.** Going back to the Dashboard after the page reloaded elsewhere (for example after an update) started a full load with the scope shown. Now only **Load findings**, the Dashboard's reload button or Jump to start one.
- **Updates are listed again.** If this server could not download image files (ghcr.io serves them from `pkg-containers.githubusercontent.com`), the check listed nothing and said "up to date". Now newer versions are always listed, and the page names the blocked host. The update check also read only the newest 40 tags, so older versions dropped off the list as releases came out; now every version is listed.
- **Every version: newest 3, then Load 10 more.** The version running here is always shown. The page checks again by itself when it opens and the last check is over 10 minutes old.
- **Auto-update waits instead of failing.** When the image files cannot be downloaded, it says why rather than trying, and failing, every 15 minutes.
- **Status.** 64,423 requests with 0 failed for 3000 people at once on 2 vCPU, and no finding sent twice. Report opens took 2.3 s at p95 (main 0.6 s in the same pair, 5.5 s in the pair before; see docs/performance.md). All 421 tests pass, and `npm audit` finds 0 vulnerabilities. The last Checkmarx One scan leaves no critical, high or medium finding open.

## MZ-01.00.35 — 2026-10-04 11:20 UTC · [#58](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/58)
- **One Git indicator for every host.** The header's GitHub chip is now **Git**, with one small logo per connection (GitHub, GitLab, Azure DevOps, Bitbucket). Each logo is ringed green when its token works and red when it does not, so you can see at a glance how many hosts are connected. Click it for each connection's host, account and token source, and the variable that connects each missing host.
- **More than one connection per host.** A second GitHub, GitLab, Azure DevOps organisation or Bitbucket comes from the same .env variables with a number, `_2` to `_9` (for example `GITHUB_TOKEN_2` with `GITHUB_API_URL_2`). They are set at start-up or by uploading the .env file. Code authors are found with the connection for each repository's host and organisation, and each token only ever goes to its own address.
- **Take credits back, from every project at once.** Credit Control → Allocated vs used has **Take back all unused credits** for a clean slate, without loading findings, and **Take back** on each project's row. The Dashboard's **Take back unused credits** is visible again (1.0.34 had hidden it under advanced options). Used credits stay counted, and every take-back is in the audit log.
- **Get started in one row.** The six setup steps are one slim line of steps, joined by a green line as each is done.
- **Fix.** Local git blame now clones with a `GITHUB_TOKEN` set only in the .env file. Before, it used only a token saved on the Beta page.
- **Status.** 529 requests a second with 0 failed for 3000 people at once on 2 vCPU. Report opens took 0.55 s at p95 (main 0.39 s, in the third of three back-to-back pairs; see docs/performance.md). All 414 tests pass, and `npm audit` finds 0 vulnerabilities. The last Checkmarx One scan leaves no critical, high or medium finding open.

## MZ-01.00.34 — 2026-10-04 09:05 UTC · [#57](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/57)
- **Simple by default.** Fine-tuning most people never need is hidden until someone turns on **Show advanced options** in their menu (top right). That includes the reminder format, extra credits, mail and link templates, the risks endpoint, mail certificate checks and HTTPS hardening. Settings shows 13 sections instead of 16.
- **Plain words.** "Fetch vulnerability data" is now **Load findings**, "Scan initiators" is now **Developers**, "Recipient list" is now **A fixed list**, "Allocate" is now **Give credits**, triage and remediation are now **Check with AI** and **Fix with AI**, "Dry run" is now **Test mode**, and "IAM" is now **People & roles**.
- **Reminders go to each developer by default,** with their own projects only. The format and attachment choices fold away.
- **The emailed report speaks plainly.** "To verify" is now **Not checked yet** and "Proposed not exploitable" is now **Probably safe (AI)**. The Engine column is now **Type**: Code, Open-source package, Configuration and so on.
- **Shorter help.** The longest explanations are now one short sentence each, and the details sit in tooltips or under **How it works**.
- **Status.** 514 requests a second with 0 failed for 3000 people at once on 2 vCPU. Run back to back with main, reports open in 4.2 s at p95 (main 4.8 s). All 407 tests pass, and `npm audit` finds 0 vulnerabilities. The last Checkmarx One scan leaves no critical, high or medium finding open.

## MZ-01.00.33 — 2026-10-04 08:55 UTC · [#56](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/56)
- **The developer rescans first.** When every finding in a tracked report's round is dealt with, the developers who fixed them get **Rescan now** in their report and by email, for 24 hours to 14 days (48 by default). The rescan they start is recorded as theirs.
- **Then on their behalf, and they are told.** If nobody rescans in time and automatic rescan is on, CxMissionZero starts it and emails them. Everyone gets the result, and the updated report of whatever is still open.
- **The button waits for clean.** Until everything in scope is dealt with, the report's Rescan card shows how many findings are left, and its button stays off.
- **Send the links yourself.** **Their rescan links**, on the Verify tab, gives each developer's link to send by hand when email is not set up.
- **The way to Mission Zero, on the Dashboard.** One slim line shows how many projects are at zero, then **Detect → Triage → Remediate → Fix → Verify** with a count at each stage. The stage to act on next is highlighted, and the green line runs up to it.
- **Status.** 511 requests a second with 0 failed for 3000 people at once on 2 vCPU. Reports open in 3.9 s at p95, inside the run-to-run spread of main (0.5 to 5.2 s today). All 407 tests pass, and `npm audit` finds 0 vulnerabilities. The last Checkmarx One scan leaves no critical, high or medium finding open.

## MZ-01.00.32 — 2026-10-04 08:25 UTC · [#55](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/55)
- **Beta features can be made final.** Admins have a new **Settings → Beta features** page: **Make final** gives a feature to everyone holding its own permission and drops its Beta label, and **Back to Beta** undoes it. Every change is in the audit log.
- **Code authors (git blame) stays in Beta.** It is not made final until it is fully reliable. Once an Admin does make it final: anyone who may send reminders can use it, the sidebar entry becomes **Code authors**, the Dashboard's Remind panel links to it, and **Settings → Automation → Also email the code authors** emails the developer behind every finding that just crossed a threshold (up to 200 a run).
- **Git blame: never the wrong developer.** It looks past whitespace-only changes, moved code, the commits listed in `.git-blame-ignore-revs` and bot commits (Dependabot, Renovate…). Each answer is now **Sure**, **Check** or **Unsure**, with the reason. Only Sure answers are ticked for sending, and scheduled reminders only email Sure ones.
- **Match usernames, once final:** anyone who may change initiator addresses can run and apply the matching.
- **Status.** 511 requests a second with 0 failed for 3000 people at once on 2 vCPU, and reports open in 2.5 s at p95. All 402 tests pass, and `npm audit` finds 0 vulnerabilities. The last Checkmarx One scan leaves no critical, high or medium finding open.

## MZ-01.00.31 — 2026-10-04 06:30 UTC · [#54](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/54)
- **Rescans keep the developer's name.** Checkmarx One records whoever owns the API key as the initiator of a scan this server starts. Verification rescans are now credited to the developer whose work they verify, so reminders, reports and the Dashboard still name that developer, not the server's account. In Checkmarx One the rescan is tagged `verifies-work-of` and `requested-by`.
- **Faster again.** Under the 3000-user benchmark, reports open in 2.5 s at p95 (5.1 s for MZ-01.00.30 on the same machine), and an open report's status checks answer in 106 ms at p95 (350 ms). The server also uses less CPU, with no failed requests.
- **Reports never wait for Checkmarx One to show states.** An open report is answered from the last known states while fresh ones are read in the background.
- **Lighter fetches and saves.** Credit figures are worked out in one pass per project instead of a dozen. Emailed reports are compressed in the background, and API calls no longer look for files on disk.
- **Status published.** Every release now publishes its performance and security status (benchmark, tests, dependency audit, Checkmarx One scan and what is still open, with the reason) in the README, the user guide, this log and [docs/status.md](docs/status.md), with earlier versions back to the first.
- **Status.** 524 requests a second with 0 failed for 3000 people at once on 2 vCPU. All 388 tests pass, and `npm audit` finds 0 vulnerabilities. The last Checkmarx One scan leaves no critical, high or medium finding open.

## MZ-01.00.30 — 2026-10-04 06:05 UTC · [#53](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/53)
- **Settings → Update & recovery (Admins).** CxMissionZero updates itself, with nobody signing in to the server. **Check for updates** lists every published version, and **Update now** installs the newest. A backup is taken first, and people see "reconnecting…" for a few seconds.
- **Checked, small downloads.** Only CxMissionZero's own files are downloaded from its image (about 1.5 MB of 40 MB), each piece checked against the image's sha256 digests, and kept in the data volume.
- **Rolls back by itself.** A version that does not come up, or stops soon after starting, is replaced by the one before it straight away. It is never installed automatically again.
- **Any version, any time.** **Install and switch** to any published version, **Switch to** any installed one, or go back to the image's own version, in one click.
- **Auto-update.** Off until an Admin turns it on. A newer release is then installed by itself, optionally only in a chosen hour of the day.
- **Restart and troubleshooting report.** Restart the server from the page, or download a summary for whoever helps: versions, events, memory, disk, HTTPS and connections, with no secrets.
- **One manual update first.** The image now starts a small launcher that runs the chosen version. The first update to MZ-01.00.30 is a `podman pull`; every later one can come from the page. Each release is also published under its version number (for example `:1.0.30`), and the on-premise statement now names the registry that updates come from.

## MZ-01.00.29 — 2026-10-04 05:52 UTC · [#52](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/52)
- **Your tools, chosen once.** At the top of every report, the developer picks where code opens (VS Code, Cursor, Kiro, Windsurf, Antigravity, a JetBrains IDE or the browser) and what fixes it (Claude Code, OpenAI Codex, Gemini CLI, GitHub Copilot, Cursor, Kiro, Windsurf, Antigravity, Apply in my workspace, git apply, or any other assistant). It is remembered in that browser, for every report.
- **One click per finding.** Each finding shows **Open in …** and **Fix with …** for those choices. **▾** picks another way for that one finding only.
- **AI assistants, directly.**
  - **Command line assistants** get a ready one-line command for the repository folder. Once AI Remediation has written the fix, the command also downloads it, so the assistant applies it where the code now lives.
  - **IDE assistants** open at the file, with the prompt copied for their chat.
- **Nothing can run from a finding's text.** The finding text in a command is reduced to plain letters and punctuation, which a test checks against a real shell.

## MZ-01.00.28 — 2026-10-04 05:47 UTC · [#51](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/51)
- **Prove the fixes with a rescan.** A tracked report's new **Verify** tab shows when everything in its scope has been dealt with (triaged not exploitable, or confirmed and sent for remediation). **Rescan now** then has Checkmarx One scan each project again, with the same repository, branch and engines.
- **Or automatically.** With one tick, the rescan starts by itself the moment the scope is closed, once per round.
- **What the rescan proved.**
  - Verified fixed (gone).
  - Still found, with the fixes that did not work after AI Remediation listed.
  - Accepted as not exploitable.
  - New in scope.
  - When nothing is left: **✓ Mission Zero for this scope**, and the report shows **Verified at zero**. If new findings appear later, it shows **Left zero**.
- **Rounds.** **Start round 2** takes a new scope (for example medium and low) from what Checkmarx One reports after the rescan, and the finished round is kept with its result.
- **Uploaded code too.** Projects Checkmarx One cannot fetch (code uploaded by a pipeline or the CLI) are verified by their next scan from anywhere, for up to 30 days.
- **Governed.** Every rescan, result, switch and new round is in the audit log, under the new type **Verification rescans**.
- **On premise, your data stays yours.** A dark-green line now comes first in the terms dialog, on the sign-in page, in Settings → About, the README and every emailed report. It says the tool runs on your servers and connects only to Checkmarx One, your email server and the code hosts you add, with no telemetry. This was checked against every connection the code makes.

## MZ-01.00.27 — 2026-10-04 05:30 UTC · [#50](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/50)
- **Open in IDE from the report, in one click.** Each code finding opens at its file and line in VS Code, Cursor, Kiro or a JetBrains IDE (IntelliJ IDEA, WebStorm, PyCharm, GoLand and others), with nothing to install.
  - The report asks once per computer where the code lives, and from then on every repository opens by name. JetBrains needs no folder at all.
  - A repository that isn't on the computer yet can be cloned and opened by the IDE itself, or opened at the line in github.dev or the GitLab Web IDE.
- **A prompt for your AI assistant.** **Copy prompt** gives Claude Code, Copilot, Cursor or Kiro the finding, its file and line and the fix, so the assistant finds the file and places the change even where the code moved (an idea from cx-findings-to-fix).
- **More of the fix.** The fix now shows why and how it works, and the test files Checkmarx One wrote for it.
- **Apply fix in my workspace.** When AI Remediation has written a fix but there is no pull request, or it failed, the developer picks their checkout in Chrome or Edge and the report puts the fix in.
  - It checks the folder is that project's repository, shows every change first, and writes nothing until they confirm.
  - A change still lands if lines were added above it since the scan. If the code there itself changed, that file is refused and nothing is written.
- **Or one git line.** **Copy git command** gives `curl … -o mz-fix.patch && git apply --recount mz-fix.patch` for cmd, PowerShell or a shell. The link is signed for that one finding, works for 7 days, and each download is in the audit log.
- **Built once.** Each scan's results are read once per report, for both the AI ids and the code locations, and repository addresses are never put in a report with credentials in them.

## MZ-01.00.26 — 2026-10-03 16:47 UTC · [#49](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/49)
- **Detect · Eliminate · Govern.** The sidebar groups every page by stage: Detect (Dashboard, Beta), Eliminate (Reports, Credit Control), and Govern (Audit, IAM, Settings, Logs). Each page shows its stage, and Ctrl/Cmd+K jumps to any page or setting.
- **Pages keep their place.** Tabs, filters, scroll position and the open Settings section survive moving between pages. ↻ reloads the current page, and "Refresh & reset" in the sidebar starts everything afresh.
- **A calmer dashboard.** A getting-started checklist, a compact scope bar, and projects beside one action panel (Remind, People, Credits, Track) that docks on wide screens and slides in on smaller ones.
- **No more endless lists.** Credits is renamed Credit Control and Access is renamed IAM. Credit Control, Audit, IAM, Beta and Logs are split into tabs and paged. Settings shows one section at a time, and the terms of use are under Settings → About.
- **The HTML report matches.** It now has summary tiles, a lifecycle strip, and filters by severity, search and "actionable only", with the explanation folded away until needed.
- **Fits any screen.** The layout adjusts from phone to ultra-wide, with no sideways scrolling.
- **Hardened after a Checkmarx One scan with every engine.** Repositories are cloned only from known git hosts (`SCM_ALLOWED_HOSTS` adds others). Checkmarx One addresses must be https. Further fixes cover redirects to unlisted names, mail header injection and prototype pollution. A locked account no longer reveals itself, audit entries can't choose their own file, and inputs are bounded more tightly.
- **Benchmark on every change.** The benchmark works again with the terms of use, and docs/performance.md now has a before-and-after row for each version.

## MZ-01.00.25 — 2026-10-03 11:30 UTC · [#48](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/48)
- **A redesigned Reports page.** Built for a security team tracking many scopes: the whole picture first, then one report at a time, with far less on screen at once.
- **Portfolio at a glance.** Tiles across every tracked report: findings tracked, % actioned, open now, new since saved, follow-ups scheduled (and the next one), AI credits used.
- **One row per report.** Progress bar, open and new counts, a trend line of open findings, and a status (Complete, On schedule, Needs follow-up, Update failed); filter, search and sort.
- **Upcoming follow-ups.** Every scheduled reminder, soonest first, with who it goes to; one click opens its schedule.
- **A panel per report with tabs.** Overview (outcomes, trend with values on hover, by project), Remind, Schedule, Triage and History: every action from before, out of the way until needed.
- **Accessible and responsive.** Outcome colours checked for colour-blind separation in light and dark mode, keyboard tabs, and a layout for phones.

## MZ-01.00.24 — 2026-10-03 11:18 UTC · [#47](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/47)
- **GitLab, Azure DevOps and Bitbucket in the Beta features.** Finding who wrote vulnerable code, and matching usernames to email addresses, now work for repositories on these hosts too (cloud or self-hosted), next to GitHub.
- **Blame through each host's API.** GitLab and Bitbucket Data Center are asked directly, one request per file; Azure DevOps and Bitbucket Cloud (no blame API) use git blame on a clone made with that host's own token, so private repositories work.
- **Every way each host offers to find an address.** GitLab: GraphQL batches of 100, profiles, commits by name, its noreply addresses. Azure DevOps: the whole organisation directory in a few requests, identity search, commits. Bitbucket: commit authors (Cloud never shows emails otherwise), workspace members joined to local history, the Data Center user directory.
- **Compared side by side.** Pick the host on the Beta page and compare its methods on your own usernames, with coverage, requests and a recommendation; code authors are resolved cheapest method first.
- **Tokens stay with their host.** Each is stored like the SMTP password, never sent back, and only ever sent to its own host (an Azure DevOps token only to its organisation); also settable from the .env file.

## MZ-01.00.23 — 2026-10-03 11:03 UTC · [#46](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/46)
- **Licence.** CxMissionZero is now licensed under the PolyForm Internal Use License 1.0.0: any organisation, every Checkmarx One customer included, may run and adapt it for its own internal business, but not sell, distribute or host it for others.
- **Terms of use and disclaimer (TERMS.md).** An independent project, not a Checkmarx product; as is, with no warranty, support or fixes; neither the author nor Checkmarx is responsible for its use or for credit discrepancies; its figures and audit reports are supporting information only, not for claims or disputes with Checkmarx.
- **Accepted before anything works.** After the first sign-in an Admin accepts the terms for the organisation; until then the app, emailed reports and automation are closed. Each person then accepts them once, changed terms are asked for again, and every acceptance is in the audit log.
- **`ACCEPT_TERMS=<email>`.** Automated setups accept the terms by name, on record.
- **Notices where figures appear.** HTML reports, the audit log page and every audit export say the figures are supporting information only.
- **Contributing guide.** CONTRIBUTING.md explains how to propose improvements and what contributors agree to.

## MZ-01.00.22 — 2026-10-03 10:54 UTC · [#45](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/45)
- **HTTPS from the Settings page.** Admins move a running server to HTTPS in five steps (certificate, HTTPS next to http, test, HTTPS only, harden), with no new container command and no restart.
- **One port, both protocols.** http:// and https:// are answered on the same port, so HTTPS can run next to http while it is tested; once HTTPS only, plain http redirects instead of failing.
- **Certificates checked before use.** Uploads in any form (PEM files in any order, DER .cer, .pfx with password) are checked the way a browser would: key, chain (missing intermediates spotted), names in use, dates, key strength and purpose.
- **Certificate requests for IT, and live replacement.** Create a CSR on the page (the key never leaves the server); renewals and replacements go into use at once, the previous certificate can be put back in one click, and expiry is flagged 30 days ahead.
- **Reports and the Dashboard follow HTTPS by themselves.** Reports switch to HTTPS where it works on the reader's machine, the page counts report opens over each, and after the switch http callers are told the new address.
- **Safe to get wrong.** HTTPS only can be switched on only from a page already open over HTTPS, HSTS is staged (1 day first), every change is audited, and `scripts/https.mjs both` brings http back within 5 seconds.
- **This version log.** CHANGELOG.md lists every release with its time and main features, and is updated with each one.

## MZ-01.00.21 — 2026-10-02 21:55 UTC · [#44](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/44)
- **No more 60-second timeouts.** A click (such as opening AI Remediation details) no longer waits behind a queued background read, so HTML reports and reminders to initiators no longer time out under load.
- **Speed-ups from a CPU profile.** Session saves, shared Checkmarx One records, report grants, the audit log and the credit ledger do less repeated work; under a 3000-user load, report opens and audit log browsing got markedly faster.
- **HTTPS on by default in the container image.** The image serves HTTPS with a self-signed certificate until you provide one; `HTTPS=off` gives plain http on a laptop or behind a reverse proxy.
- **`SESSION_SAVE_SECONDS` setting.** Controls how often a person's changing fetched data is saved to disk (default 30 s; the first save is immediate).
- **Updated performance guide.** Before/after benchmark for this release in docs/performance.md.

## MZ-01.00.20 — 2026-10-02 20:47 UTC · [#43](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/43)
- **Renamed to CxMissionZero.** The new name appears everywhere it is shown: page title and header, emails, server log, error messages, backups, the self-signed certificate, the sample .env, the docs and the architecture diagram.
- **Old default names upgraded.** Settings saved with an earlier default name (Mission Zero, Detection Date Reminder) load as CxMissionZero; a name the admin chose is kept. Container, volume and image names are unchanged.

## MZ-01.00.19 — 2026-10-02 20:22 UTC · [#42](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/42)
- **HTTPS in the README.** The three ways to turn on HTTPS (company certificate, automatic Let's Encrypt via Caddy, self-signed) as one-line commands, plus how to check it worked.
- **"Turn on HTTPS" in the user guide.** A step-by-step admin section, including trusting a self-signed certificate on Windows, what changes after the switch, and troubleshooting.

## MZ-01.00.18 — 2026-10-02 20:10 UTC · [#41](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/41)
- **Per-project reports from a combined report.** A report covering several projects lists them as buttons at the bottom; each builds and downloads that project's own fresh report in a new tab.
- **HTTPS built in.** Serve HTTPS with your own certificate (PEM or PFX) or a generated self-signed one; certificates are checked at start and reloaded on renewal without a restart.
- **HTTP-to-HTTPS redirect.** `HTTP_REDIRECT_PORT` redirects plain http to https.
- **Trusted proxies only.** `TRUST_PROXY` controls whose X-Forwarded-* headers are believed, so faked headers can no longer get around the sign-in limit.
- **Hosting guide.** New docs/https-and-hosting.md covers company certificates, Caddy with Let's Encrypt, self-signed certificates and a hosting checklist.

## MZ-01.00.17 — 2026-10-02 17:11 UTC · [#40](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/40)
- **Faster fetches.** Projects read in the last 2 minutes are reused while their latest scan is unchanged, and big projects' pages are read several at a time; "Read everything fresh" skips the reuse.
- **Faster report opening.** A report now opens with one call to the server instead of four.
- **Compressed replies.** Large replies (32 KB and over by default) are compressed; `HTTP_COMPRESSION=off` and `HTTP_COMPRESSION_MIN_KB` adjust this.
- **Benchmarked.** Under a 3000-user load, failed requests fell from 242 to 6 and a whole-tenant fetch from 26 s to 10 s (median); details in docs/performance.md.

## MZ-01.00.16 — 2026-10-02 16:35 UTC · [#39](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/39)
- **Light-hearted busy messages.** Progress flares show a playful line, themed to the action, that changes every few seconds above a live status line (action, projects, seconds elapsed).
- **Screen-reader friendly.** Screen readers hear the plain action once instead of every update.

## MZ-01.00.15 — 2026-10-02 16:25 UTC · [#38](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/38)
- **21 progress icons.** Each action's progress flare uses the next icon from a shuffled set of 21 fast-moving icons.
- **Finished animation.** When done, the icon glides to a stop and a green tick draws itself; reduced-motion settings show the tick straight away.

## MZ-01.00.14 — 2026-10-02 16:15 UTC · [#37](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/37)
- **Flying hero in the progress flare.** The amber "in progress" flare shows an original caped speedster instead of a running mouse; reduced-motion settings still stop the animation.

## MZ-01.00.13 — 2026-10-02 16:10 UTC · [#36](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/36)
- **"Why fewer results than findings."** The credits panel and each project's credit editor list every Checkmarx One result that covers several findings, with what ties them together, so they can be fixed in one go for one credit.

## MZ-01.00.12 — 2026-10-02 15:19 UTC · [#35](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/35)
- **Connection indicators.** The header shows green/red indicators for Checkmarx One, Email and GitHub; click one for details and what to do when it is red.
- **Progress flares for every action.** Every action shows an amber flare while running (pausing the part of the page it came from, so nothing starts twice), then green when done or red with the reason.
- **GitHub settings in the .env.** `GITHUB_TOKEN`, `GITHUB_API_URL` and `GITHUB_ORG` are in the sample .env and can be applied by the Settings upload.

## MZ-01.00.11 — 2026-10-02 15:17 UTC · [#34](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/34)
- **Sign-ins survive any restart.** Password sign-ins are saved securely as they happen, so updates, restarts and crashes no longer sign anyone out (API-key sign-ins are still never written to disk).
- **Same Dashboard after a reload.** A page reload or restart shows the same fetched projects, time windows and scope without reading Checkmarx One again.

## MZ-01.00.10 — 2026-10-02 14:59 UTC · [#33](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/33)
- **Every credit action re-checks Checkmarx One.** Allocating, triaging, remediating, adding or taking back credits first runs Refresh & verify, and cancels with a list of what changed if the numbers moved.
- **Graceful stop.** On shutdown, requests in progress finish and the ledger and logs are written before the server exits.
- **Updates without sign-outs.** Sign-ins and fetched data are handed over to the next version, and the Dashboard and emailed reports wait through a restart.
- **One server per data folder.** A second server waits for the first to stop and refuses to run beside it.
- **Update guide.** docs/updating.md describes updating with `podman pull` + `podman run --replace`.

## MZ-01.00.09 — 2026-10-02 14:47 UTC · [#32](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/32)
- **One clear explanation per confirmed finding.** Under Confirmed, the Why and Fix lines are the explanation; "why?" now adds only what they do not say, and repeated text and the "Someone (or AI Triage) marked this" line are gone.

## MZ-01.00.08 — 2026-10-02 14:42 UTC · [#31](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/31)
- **Compact README.** Rewritten around what you get, with an architecture diagram, how to run the container and every option in one table (about 150 lines instead of 842).
- **Full user guide.** New docs/user-guide.md walks through every page and option, with recipes and troubleshooting; technical detail moved to docs/how-it-works.md.
- **Sample .env on Settings.** Settings → Quick setup offers "Download the sample .env" with every setting explained; blank values never overwrite a working setting when uploaded.

## MZ-01.00.07 — 2026-10-02 14:24 UTC · [#30](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/30)
- **3000-user benchmark and sizing.** A mixed-load benchmark and docs/performance.md with results and a recommended server size (2 vCPU / 4 GB is enough).
- **Clearer shared results in the report.** Rows that share one Checkmarx One result are labelled R1, R2, … with their own colour, link to each other and light up together on hover.
- **Why and Fix under Confirmed.** Confirmed findings show a short Why and Fix, from AI Triage's explanation when there is one.

## MZ-01.00.06 — 2026-10-02 14:03 UTC · [#29](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/29)
- **Take back unused credits.** Returns credits that projects were given but did not use to the credit pool, never below what is used or in flight.
- **Initiators told when you act for them.** Triage and remediation from the Dashboard or a tracked report email each scan initiator about their own projects and what to do next (can be switched off).
- **Allocation verifies first.** Allocating for triage or remediation runs Refresh & verify and shows the numbers Checkmarx One just confirmed.

## MZ-01.00.05 — 2026-10-02 14:00 UTC · [#28](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/28)
- **Troubleshooting log.** Records feature usage, errors and discrepancies (such as Checkmarx One answering differently on two reads) and adds recommended fixes to the download.
- **Privacy-safe by design.** Emails, URLs, hosts, IPs, tokens and paths are scrubbed and project ids are replaced by one-way codes.
- **Download from the Logs page.** "Download troubleshooting log", behind a new permission given to Admins and Security Analysts.

## MZ-01.00.04 — 2026-10-02 13:54 UTC · [#27](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/27)
- **Findings vs results everywhere.** The report, Dashboard and tracked reports explain when several rows are one Checkmarx One result (for example "12 findings here are 10 results"), with a "Same result" chip.
- **Correct credit counts.** Confirmations and credit lines count results, which is what AI Triage charges, instead of rows.

## MZ-01.00.03 — 2026-10-02 13:46 UTC · [#26](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/26)
- **Refresh & verify with Checkmarx One.** A Dashboard button reads each project's findings twice, independently, and trusts the credit need only when both reads agree.
- **Allocation is always confirmed.** Allocating "what is needed" does the double read itself and refuses when it cannot confirm.

## MZ-01.00.02 — 2026-10-02 13:44 UTC · [#25](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/25)
- **No double requests.** Triage and remediation requests claim their findings first, so two people acting at once can never send the same vulnerability to Checkmarx One twice; the duplicate is answered "already being sent" and audited.

## MZ-01.00.01 — 2026-10-02 13:38 UTC · [#24](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/24)
- **Projects stream in as they are fetched.** The Dashboard shows rows and totals as they arrive.
- **Fetch progress flare.** A bottom-right flare shows "n of m" in amber, then green when complete or red with the reason it stopped.
- **Actions locked until the fetch finishes.** Triage, remediation and credit allocation are disabled while a fetch runs, and credit needs are shown only for complete data.

## MZ-01.00.00 — 2026-10-02 13:11 UTC · [#23](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/23)
- **Version shown on every screen.** The version, MZ-xx.xx.xx, appears bottom-left on every screen (sign-in included), is returned by the health check and printed in the server log at start. From here on it is bumped with every change merged to main.

## Before versioning

Everything below shipped as package version 1.0.0, before the app displayed a version. Grouped by merge date.

### 2026-10-02 · [#14](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/14), [#16](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/16), [#18](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/18), [#19](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/19), [#20](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/20), [#21](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/21), [#22](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/22)
Merged 05:33–10:01 UTC.
- **Container image published as `:latest`.** Pushes to main publish the `:latest` image tag ([#14](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/14)).
- **Settings save as you type.** A changed Checkmarx One or mail connection is checked, and the last known good one keeps running until the new one works; settings can also be set up from an uploaded .env ([#16](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/16)).
- **Credit pool and Credits page.** The credit pool is the master limit, with explicit per-project allocation and "Remediate selected" ([#16](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/16)).
- **Initiators get only their own projects.** Every reminder format sends each scan initiator only the projects they scanned, and an email that would include someone else's project is refused ([#18](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/18)).
- **Fetch by project name or person.** A new Scope row fetches only named projects, or the projects named people last scanned ([#19](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/19)).
- **Security fixes from Checkmarx One scans.** Container, IaC, secret, SCA and SAST findings fixed; the image moved to Alpine with Node.js 24, the port binds to localhost by default, and report errors no longer expose upstream details ([#20](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/20), [#21](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/21)).
- **First admin sign-in in the log.** The first start of a new data volume prints the administrator's email and password once in the container log again ([#22](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/22)).

### 2026-10-02 05:24 UTC · [#12](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/12)
Large pull request collecting work from 2026-09-29 to 2026-10-01.
- **AI Triage and AI Remediation from the report.** The interactive report shows the top 50 findings and triages or remediates them through the reminder server, including "Triage all critical/high" and the remediation pull request link.
- **Per-project AI credits.** Administrators allocate AI Triage and Remediation credits per project, with a monthly limit and live usage; remediation costs 3 credits per finding.
- **Tracked reports.** Save a scope and follow progress on its findings over time, with follow-up reminders and automatic reminders every N days.
- **Mission Zero branding and redesign.** The app took the name Mission Zero with an editable name and logo, and got a compact, responsive interface in light and dark.
- **Role-based access control.** Everyone signs in (password or Checkmarx One API key), with Admin, Security Analyst and User roles, custom roles and 29 granular permissions.
- **Audit log and backups.** A tamper-evident audit log of every credit event, state kept outside the project folder, and scheduled, optionally encrypted backups with restore.
- **Built for scale.** The report relay handles thousands of open reports with shared caches, priorities and admission control.
- **Beta tab and container.** A Beta tab emails the authors of vulnerable code (via git blame and GitHub identity matching), and the app ships as one Docker/Podman image.

### 2026-09-29 · direct commits to main (no pull request)
Pushed 2026-09-28 21:45 to 2026-09-29 09:29 UTC.
- **SMTP password kept server-side.** SMTP settings from the environment no longer reach the browser.
- **.env loaded automatically.** `npm start` reads `./.env` and then `../.env`, and SMTP settings from the environment are verified at startup so sending is not locked.
- **Complete HTML reports.** Fixed the HTML report dropping most findings and showing zero counts, and the project filter matching nothing.
- **Report focused on critical and high.** The report highlights critical and high findings with remediation guidance, an activity log tab, and works standalone with API-key sign-in.
- **Clearer connection errors.** API key loading tolerates stray quotes and line endings, and errors say whether the network or the credentials are at fault.

### 2026-09-28 · [#1](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/1), [#2](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/2), [#3](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/3), [#4](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/4), [#5](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/5), [#6](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/6), [#8](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/8), [#9](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/9), [#10](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/10)
Merged 09:42–21:43 UTC; [#1](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/1) carries the work from 2026-09-15 to 2026-09-28.
- **Detection-date reminder utility.** Connect with a Checkmarx One API key (tenant and URLs detected automatically), fetch projects and findings by age since first detection, and filter by scan date and detection date ([#1](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/1)).
- **Own SMTP server and mail template.** Send through your own mail server, unlocked by a connection test, with an editable template and a Settings page; Gmail App Passwords and port/TLS pairing are handled ([#1](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/1)).
- **Reminders to scan initiators.** Each person who ran a project's latest scan gets one email covering their projects, with email address suggestions, overrides and per-project sends ([#1](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/1)).
- **Links and branding.** Every finding links to Checkmarx One, and the mail carries a logo header, severity summary and call to action ([#1](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/1)).
- **Automation.** Mails once when a finding crosses 30, 60 or 90 days (or custom thresholds), without repeating, with a dry-run mode and run history ([#1](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/1)).
- **Compact UI.** The resolved initiator list collapses and the send panel is compacted ([#2](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/2)).
- **Interactive HTML report.** Reminders can carry an interactive HTML report with triage and remediation buttons, sent per initiator in one click ([#3](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/3), [#4](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/4), [#6](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/6)).
- **Fixes and setup.** nodemailer upgraded to fix SMTP security vulnerabilities, report and send bugs fixed, and setup and Gmail guides plus helper scripts added ([#4](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/4), [#5](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/5), [#8](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/8), [#9](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/9), [#10](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/10)).

### 2026-09-15 · initial commit
- **First version.** A small self-hosted tool that fetches Checkmarx One projects and findings, buckets them by time since first detection, and sends reminders through a Checkmarx One Feedback App (later replaced by your own SMTP server).
