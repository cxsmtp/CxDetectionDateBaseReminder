# Performance and security status, every version

What each release was measured at, and what was known about its security when it shipped. The newest release is first. Earlier rows are never rewritten. README.md, the user guide and CHANGELOG.md show the latest rows.

## How to read it

- **Benchmark.** The same 3000-user mixed load for every version: a burst of 2,970 requests at once, then 120 s sustained, with the server pinned to 2 vCPU. The details are in [Performance and sizing](performance.md).
  - **Failed** means no answer, a timeout or a server error. Answers of "busy, retry", which reports handle themselves, do not count.
  - **Report opens** is the time for an emailed report to open with every state known.
  - **Triage polls** is an open report asking where AI Triage stands, every 6 s.
  - "—" means the version was not benchmarked, because it did not touch the server's request paths.
- **Tests.** All of `npm test` passing, with 0 failures, when the version was merged.
- **Dependencies.** `npm audit --omit=dev`, meaning known vulnerabilities in what the server runs.
- **Checkmarx One.** A scan of CxMissionZero's own code with every engine (SAST, SCA, KICS, containers, secret detection, API security), with the counts by severity: critical / high / medium / low. **Open** is what was still to fix or triage when the version shipped.

## Status by version

| Version | Merged (UTC) | Sustained: requests / failed | Requests/s | Report opens p50 / p95 | Triage polls p50 / p95 | Tests | Dependencies | Checkmarx One |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **MZ-01.00.57** | 2026-10-06 20:20 | 63,153 / **0** | 499 | 72 / 6,381 ms | 21 / 627 ms | 557 | 0 vulnerabilities | No new scan: the Checkmarx One connector needs signing in again. Open: the 53 of rescan 27982f85 (MZ-01.00.52), all judged not exploitable (see below). Three pairs with main: on a quiet host the branch had 0 failed; runs made while other work shared the host, on main as well, had 10 to 328 ([performance](performance.md)) |
| MZ-01.00.56 | 2026-10-06 13:32 | 63,386 / **0** | 494 | 75 / 5,539 ms | 14 / 345 ms | 548 | 0 vulnerabilities (adds `imapflow` 2.2.6 for reading replies and the backup mailbox) | No new scan: the Checkmarx One connector needs signing in again. Open: the 53 of rescan 27982f85 (MZ-01.00.52), all judged not exploitable (see below). Main 495/s, opens p95 7.1 s ([performance](performance.md)) |
| MZ-01.00.55 | 2026-10-06 12:27 | 63,724 / **0** | 522 | 78 / 4,747 ms | 9 / 311 ms | 534 | 0 vulnerabilities | No new scan: the Checkmarx One connector needs signing in again. Open: the 53 of rescan 27982f85 (MZ-01.00.52), all judged not exploitable (see below). Main 514/s, opens p95 6.7 s ([performance](performance.md)) |
| MZ-01.00.54 | 2026-10-06 08:54 | 63,705 / **0** | 523 | 75 / 6,957 ms | 8 / 212 ms | 534 | 0 vulnerabilities (`proxy-addr` 2.0.7 → 2.0.8 fixes a critical advisory, GHSA-jqcg-44mw-7w3h) | No new scan: the Checkmarx One connector needs signing in again. Open: the 53 of rescan 27982f85 (MZ-01.00.52), all judged not exploitable (see below). 48 SAST to be set by hand; 5 KICS and secret-detection results await the owner's approval. Second run 515/s, opens p95 4.9 s; main 520 and 523/s, 4.2 and 4.0 s: the tail moves 2 s between runs of the same code ([performance](performance.md)) |
| MZ-01.00.53 | 2026-10-06 02:15 | 64,730 / **0** | 527 | 48 / 330 ms | 7 / 96 ms | 530 | 0 vulnerabilities | No new scan. Open: the 53 of rescan 27982f85 (MZ-01.00.52), all judged not exploitable (see below). 48 SAST to be set by hand; 5 KICS and secret-detection results await the owner's approval ([performance](performance.md)) |
| MZ-01.00.52 | 2026-10-05 19:14 | 62,903 / 2 | 504 | 78 / 7,488 ms | 14 / 483 ms | 526 | 0 vulnerabilities | Rescan 27982f85 of this branch: 1 critical, 20 high, 14 medium, 18 low, down from 62. The 12 results closed in code are gone; 2 are marked not exploitable; the rest are judged not exploitable (see below). The 2 failed requests came during a host stall, on routes this release does not change ([performance](performance.md)) |
| MZ-01.00.51 | 2026-10-05 18:41 | 61,999 / **0** | 480 | 106 / 9,404 ms | 26 / 951 ms | 526 | 0 vulnerabilities | New scan 82d48cec of MZ-01.00.50 (main, e97f2c1): 6 critical, 20 high, 17 medium, 19 low, being triaged (see below). A second pair on a stalling host had failures on both sides (main 56, branch 31) ([performance](performance.md)) |
| MZ-01.00.50 | 2026-10-05 17:30 | 63,299 / **0** | 510 | 60 / 5,886 ms | 15 / 341 ms | 525 | 0 vulnerabilities | No new scan. Open: 15 low from 617100eb, judged false positives (see below). A first pair had 29 failed on the branch while the host stalled; the second pair had 0 on the branch and 10 on main ([performance](performance.md)) |
| MZ-01.00.49 | 2026-10-05 16:13 | 62,106 / **0** | 498 | 82 / 8,302 ms | 19 / 1,101 ms | 521 | 0 vulnerabilities | No new scan. Open: 15 low from 617100eb, judged false positives (see below). Main failed 206 in the same pair while its host stalled (health checks up to 18 s) ([performance](performance.md)) |
| MZ-01.00.48 | 2026-10-05 15:30 | 62,456 / 7 | 498 | 76 / 8,185 ms | 28 / 880 ms | 519 | 0 vulnerabilities | No new scan. Open: 15 low from 617100eb, judged false positives (see below). The 7 failed were connect timeouts; main failed 44 in the same pair. A first build was slower on Node 22 and was fixed before release ([performance](performance.md)) |
| MZ-01.00.47 | 2026-10-05 14:33 | 63,787 / **0** | 519 | 64 / 5,251 ms | 16 / 310 ms | 506 | 0 vulnerabilities | No new scan. Open: 15 low from 617100eb, judged false positives (see below). A first pair on a stalling host had connection-level failures on both sides (main 53, branch 112); the second pair had 0 on both, main at 504/s ([performance](performance.md)) |
| MZ-01.00.46 | 2026-10-05 09:02 | 61,238 / 44 | 468 | 79 / 10,114 ms | 33 / 1,324 ms | 479 | 0 vulnerabilities | No new scan. Open: 15 low from 617100eb, judged false positives (see below). Failed requests were connection resets while the host stalled; main failed 177 in the same pair ([performance](performance.md)) |
| MZ-01.00.45 | 2026-10-05 07:19 | 62,542 / **0** | 497 | 66 / 7,883 ms | 24 / 1,170 ms | 478 | 0 vulnerabilities | No new scan. Open: 15 low from 617100eb, judged false positives (see below). Benchmarked on a slower host than 1.0.44's release run (main measured the same day: 145 failed, report opens p95 12.1 s) |
| MZ-01.00.44 | 2026-10-05 02:59 | 63,174 / **0** | 520 | 88 / 7,129 ms | 11 / 384 ms | 461 | 0 vulnerabilities | No new scan. Open: 15 low from 617100eb, judged false positives (see below) |
| MZ-01.00.43 | 2026-10-05 02:41 | 63,773 / **0** | 511 | 73 / 5,725 ms | 9 / 224 ms | 461 | 0 vulnerabilities | No new scan. Open: 15 low from 617100eb, judged false positives (see below) |
| MZ-01.00.42 | 2026-10-04 18:17 | — | — | — | — | 455 | 0 vulnerabilities | No new scan. Open: 15 low from 617100eb, judged false positives (see below). Page-only change, benchmarked on a slower host: see performance.md |
| MZ-01.00.41 | 2026-10-04 13:58 | 64,309 / **0** | 519 | 57 / 886 ms | 9 / 171 ms | 455 | 0 vulnerabilities | No new scan. Open: 15 low from 617100eb, judged false positives (see below) |
| MZ-01.00.40 | 2026-10-04 13:32 | 63,758 / **0** | 516 | 66 / 5,937 ms | 11 / 183 ms | 445 | 0 vulnerabilities | No new scan. Open: 15 low from 617100eb, judged false positives (see below) |
| MZ-01.00.39 | 2026-10-04 13:14 | 63,674 / **0** | 512 | 65 / 5,709 ms | 11 / 240 ms | 439 | 0 vulnerabilities | No new scan. Open: 15 low from 617100eb, judged false positives (see below) |
| MZ-01.00.38 | 2026-10-04 13:03 | 64,367 / **0** | 518 | 57 / 575 ms | 10 / 146 ms | 430 | 0 vulnerabilities | No new scan. Open: 15 low from 617100eb, judged false positives (see below) |
| MZ-01.00.37 | 2026-10-04 12:45 | 64,117 / **0** | 508 | 54 / 5,126 ms | 8 / 179 ms | 427 | 0 vulnerabilities | No new scan. Open: 15 low from 617100eb, judged false positives (see below) |
| MZ-01.00.36 | 2026-10-04 11:55 | 64,423 / **0** | 492 | 50 / 2,262 ms | 6 / 118 ms | 421 | 0 vulnerabilities | No new scan. Open: 15 low from 617100eb, judged false positives (see below) |
| MZ-01.00.35 | 2026-10-04 11:20 | 64,488 / **0** | 529 | 50 / 554 ms | 7 / 113 ms | 414 | 0 vulnerabilities | No new scan. Open: 15 low from 617100eb, judged false positives (see below) |
| MZ-01.00.34 | 2026-10-04 09:05 | 64,230 / **0** | 514 | 57 / 4,184 ms | 7 / 122 ms | 407 | 0 vulnerabilities | No new scan. Open: 15 low from 617100eb, judged false positives (see below) |
| MZ-01.00.33 | 2026-10-04 08:55 | 64,296 / **0** | 511 | 52 / 3,902 ms | 8 / 172 ms | 407 | 0 vulnerabilities | No new scan. Open: 15 low from 617100eb, judged false positives (see below) |
| MZ-01.00.32 | 2026-10-04 08:25 | 64,589 / **0** | 511 | 46 / **2,470 ms** | 6 / **145 ms** | 402 | 0 vulnerabilities | No new scan. Open: 15 low from 617100eb, judged false positives (see below) |
| MZ-01.00.31 | 2026-10-04 06:30 | 64,421 / **0** | 524 | 55 / **2,528 ms** | 5 / **106 ms** | 388 | 0 vulnerabilities | No new scan. Open: 15 low from 617100eb, judged false positives (see below) |
| MZ-01.00.30 | 2026-10-04 06:05 | 64,211 / 0 | 524 | 53 / 4,136 ms | 8 / 371 ms | 386 | 0 vulnerabilities | No new scan. Open: the same 15 low |
| MZ-01.00.29 | 2026-10-04 05:52 | 64,440 / 0 | 508 | 58 / 2,575 ms | 8 / 206 ms | 375 | 0 | No new scan. Open: the same 15 low |
| MZ-01.00.28 | 2026-10-04 05:47 | 64,244 / 0 | 522 | 54 / 1,321 ms | 8 / 316 ms | 374 | 0 | No new scan. Open: the same 15 low |
| MZ-01.00.27 | 2026-10-04 05:30 | 64,140 / 0 | 518 | 47 / 4,991 ms | 10 / 289 ms | 368 | 0 | No new scan. Open: the same 15 low |
| MZ-01.00.26 | 2026-10-03 16:47 | 64,321 / 0 | 506 | 54 / 4,356 ms | 6 / 237 ms | 359 | 0 | Scan 617100eb: **0 / 1 / 0 / 15**. The 1 high (UI redressing, unused CSS) was removed before the merge. Open: 15 low |
| MZ-01.00.25 | 2026-10-03 11:30 | 63,372 / 0 | 501 | 69 / 6,235 ms | 16 / 689 ms | 331 | 0 | Scan 0d6b0f2e: SAST 4 / 19 / 38 / 77, API security 5. All real ones were fixed in MZ-01.00.26 |
| MZ-01.00.22 – .24 | 2026-10-03 | — | — | — | — | 316 – 331 | 0 | No scan |
| MZ-01.00.21 | 2026-10-02 21:55 | 63,324 / 0 | 505 | 60 / 6,200 ms | 19 / 700 ms | 314 | 0 | No scan |
| MZ-01.00.20 | 2026-10-02 20:47 | 61,773 / 34 | 462 | 96 / 11,000 ms | 28 / 1,300 ms | 310 | 0 | No scan |
| MZ-01.00.18 – .19 | 2026-10-02 | — | — | — | — | 309 | 0 | No scan |
| MZ-01.00.17 | 2026-10-02 17:11 | 64,320 / 6 | 494 | 53 / 2,100 ms | — / 240 ms | 303 | 0 | No scan |
| MZ-01.00.16 | 2026-10-02 16:35 | 69,796 / 242 | 536 | 222 / 11,700 ms | — / 1,100 ms | 294 | 0 (after adding `compression`) | No scan |
| MZ-01.00.07 – .15 | 2026-10-02 | — | — | — | — | 287 – 294 | 0 | No scan |
| MZ-01.00.06 | 2026-10-02 14:03 | 66,116 / 1 | 518 | — | 6 / 565 ms | 285 | 0 | No scan |
| MZ-01.00.00 – .05 | 2026-10-02 | — | — | — | — | 270 – 285 | 0 | No scan |
| Before MZ versions | 2026-10-02 | — | — | — | — | 269 | 0, after nodemailer was upgraded (1 high fixed) and `debug` pinned to 4.4.3 | Scan 26e2baff: 2 / 14 / 31 / 54, mostly in the old container image. Fixed by moving to Alpine with Node.js 24, plus KICS and error-exposure fixes. Rescan 482e05ad: 4 / 0 / 21 / 41. The 4 critical secret-detection findings were judged not real secrets and marked not exploitable |

Rows for MZ-01.00.25 to .30 are the run on main listed in [the version table](performance.md#every-version-before-and-after). Earlier rows come from the before-and-after sections there. The MZ-01.00.20 row is the "before" of MZ-01.00.21, and the MZ-01.00.16 row is the "before" of MZ-01.00.17.

## What is open now

**Scan 82d48cec** (MZ-01.00.50, every engine) had 62 results: 6 critical, 20 high, 17 medium, 19 low. Each was checked against the code, and none was found exploitable in what the server runs.

- **Closed in code in MZ-01.00.52 (12):**
  - Test passwords, the backup passphrase and mock API keys are now made fresh on every run (`test/test-credentials.js`), and the fake key is no longer an unsigned `alg: none` token.
  - A test's credentialed clone URL is now built in code.
  - Temporary report file names come from `crypto.randomBytes`.
  - The Caddy container drops every capability except binding ports 80 and 443, sets `no-new-privileges`, and has a health check.
- **Rescan 27982f85** of MZ-01.00.52 has 53 results: 1 critical, 20 high, 14 medium, 18 low. All are judged not exploitable, each with a reason citing the code:
  - **48 SAST results:** SSRF to addresses an Admin or the operator configures, the load-test mock and generator (not in the image), secrets that must be readable to work (files at 0600), error messages that name no secret, escaped template output, and similar. They are to be set to Not exploitable in Checkmarx One by hand: the API key the CxMCP server uses cannot change SAST result states.
  - **2 secret-detection results:** the old placeholder URL, which is now only in git history.
  - **3 KICS results on Caddy:** ports 80 and 443 must be published for a public HTTPS proxy, and `NET_BIND_SERVICE` is the one capability Caddy needs to bind them.
  - **Already marked:** 2 KICS results on Caddy's ports, set to Not exploitable from scan 82d48cec.

Still open from scan 617100eb, 15 low-severity SAST findings, each reviewed and judged a false positive or by design:

| Where | Query | Why it is not a vulnerability |
| --- | --- | --- |
| `loadtest/mixed-load.mjs` (10 results) | Privacy, secret and PCI data in error messages | The load generator prints its own made-up test data. It is not part of the server or the image. |
| `src/backup.js:106` | Secret leak in error messages | The message is the fixed text "Wrong passphrase, or the backup is damaged." It never includes the passphrase. |
| `src/scm/client.js:48` | Secret leak in URL | The git host's token goes in the Authorization header, never in the URL. This line adds paging parameters, and refuses to send credentials to any other host. |
| `src/iam.js:272` | Privacy violation in error messages | "… already has access" is only shown to someone who is adding users on the IAM page. |
| `src/settings.js:35` | Empty password | This is the empty default before an admin enters the SMTP password. No password is built in. |
| `public/speedsters.js:158` | Insufficiently random values | It picks which animated icon to show. Nothing secret depends on it. |

## How it is kept up to date

Every release adds its row to this page, in the same pull request that changes the version (see CONTRIBUTING.md and CLAUDE.md). After a scan of CxMissionZero's own code, its result goes into the row of the version it scanned, and anything it finds is fixed or triaged before the next release.
