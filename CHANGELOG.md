# CxMissionZero version log

Every release, newest first: the version shown bottom-left in the app (MZ-xx.xx.xx), when it was merged, and the main features. Updated with every release.

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
