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
| **MZ-01.00.41** | 2026-10-04 HH:MM | 64,309 / **0** | 519 | 57 / 886 ms | 9 / 171 ms | 455 | 0 vulnerabilities | No new scan. Open: 15 low from 617100eb, judged false positives (see below) |
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

These 15 low-severity SAST findings are from scan 617100eb. Each one was reviewed and judged a false positive or by design. They will be marked not exploitable in Checkmarx One:

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
