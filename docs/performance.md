# Performance benchmark and sizing

Can one CxMissionZero server handle **3000 people at once**? This page answers that. The people are:
- readers of emailed HTML reports, triaging, remediating and polling for results;
- people on the Dashboard, fetching data, reading credits and analytics, and sending reminders and reports;
- administrators.

It also gives the server, VM or container size to run.

**Short answer: yes, on 2 vCPU and 4 GB of RAM.**
- In the burst, 2,970 requests arrived at the same instant and none failed.
- Over two minutes of sustained load, 1 of 66,116 requests failed. It was a reminder email that hit the generator's 60-second timeout while every Dashboard user was fetching.
- No finding was ever sent to Checkmarx One for triage twice.

## How it was measured

`loadtest/benchmark.sh` starts three things: a mock Checkmarx One, a real CxMissionZero server with a throwaway data folder and a mock mail server, and the load generator `loadtest/mixed-load.mjs`.

**Phase 1: burst.** 3000 requests of the whole mix are fired at the same instant.

**Phase 2: sustained.** 3000 virtual users loop through their role for 120 seconds.

| Role | Users | What each one does |
| --- | --- | --- |
| Emailed-report reader | 2400 (80%) | Connects, reads credits and remediation state; 1 in 5 triages 5 findings, 1 in 20 remediates one. Then polls triage results every 6 s (remediation state every 4th poll) for as long as the report is open. |
| Dashboard viewer | 360 (12%) | Every ~10 s loads a page's data: who am I, settings, credit balances, usage analytics, tracked reports, health. |
| Analyst | 180 (6%) | Every ~15 s one of: <ul><li>build an HTML report (5 projects)</li><li>Refresh & verify credits (two independent reads of Checkmarx One)</li><li>email reminders to scan initiators</li><li>email HTML reports to initiators</li><li>triage now (Dashboard)</li><li>browse the audit log</li><li>refresh a tracked report</li></ul> |
| Fetcher | 45 (1.5%) | Fetches the whole tenant (streamed), then again ~30 s later. |
| Administrator | 15 (0.5%) | Metrics, audit integrity check, troubleshooting-log download, backups, audit log. |

**Tenant and sessions**
- The mock tenant has 200 projects with 60 findings each (12,000 findings) and 40 scan initiators.
- Each call takes 80 ms; one run used 250 ms.
- There are 21 signed-in sessions (the admin, plus 20 analysts on separate accounts).
- At set-up, every session fetched the whole tenant at the same moment.

**What counts as failed**
- No answer: a network error, a timeout (60 s; 300 s for a fetch) or a broken stream.
- A server error (5xx), including the relay's "busy, retry" answer once a report has retried 8 times. Reports retry "busy" exactly as the real report does.
- These are *refused by design*, not failures:
  - remediating a finding that is not confirmed;
  - a request that waits for a running fetch (409).

**What else is checked**
- The mock tenant counts how many times each finding was sent for AI Triage. The run fails if any finding was sent more than once.

**The machine**
- A 4-vCPU, 16 GB Linux VM with Node 22.
- The mock tenant and the load generator ran on the same machine. For the sized runs the server was pinned to its own CPUs with `taskset`, and everything else to the remaining CPUs.
- The generator itself competes for CPU, so real servers do somewhat better than these numbers.

## Every version, before and after

Every change is benchmarked on main before it and on its branch after it: 3000 people, a burst then 120 s sustained, server on 2 CPUs (`SERVER_CPUS=0-1 GEN_CPUS=2-3`). Failed = no answer, a timeout or a server error (see above).

| Version | Run | Burst: time / failed | Sustained: requests / failed | Requests per second | Report opens p50 / p95 | Triage results p50 / p95 | Sent for triage twice |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MZ-01.00.25 (main) | 1 | 10.6 s / 0 | 63,069 / 2 | 518 | 69 / 6,980 ms | 19 / 763 ms | none |
| MZ-01.00.25 (main) | 2 | 9.2 s / 0 | 63,372 / 0 | 501 | 69 / 6,235 ms | 16 / 689 ms | none |
| MZ-01.00.26 | 1 | 10.4 s / 0 | 62,992 / 0 | 510 | 63 / 7,246 ms | 18 / 911 ms | none |
| MZ-01.00.26 | 2 | 15.8 s / 0 | 62,108 / 144 | 501 | 76 / 10,825 ms | 17 / 801 ms | none |
| MZ-01.00.26 | 3 (event-loop monitor on) | 15.9 s / 0 | 63,013 / 0 | 502 | — | — | none |
| MZ-01.00.26 + Checkmarx One fixes | 4 | 9.4 s / 0 | 62,597 / 0 | 506 | 89 / 8,235 ms | 14 / 793 ms | none |
| MZ-01.00.26 (main) | 5 | 9.2 s / 0 | 64,321 / 0 | 506 | 54 / 4,356 ms | 6 / 237 ms | none |
| MZ-01.00.27 (no location cache) | 1 | 15.8 s / 0 | 64,465 / 0 | 520 | 69 / 2,768 ms | 8 / 253 ms | none |
| MZ-01.00.27 | 2 | 8.2 s / 0 | 64,140 / 0 | 518 | 47 / 4,991 ms | 10 / 289 ms | none |
| MZ-01.00.28 | 1 | 8.3 s / 0 | 64,244 / 0 | 522 | 54 / 1,321 ms | 8 / 316 ms | none |
| MZ-01.00.29 | 1 | 8.4 s / 0 | 64,440 / 0 | 508 | 58 / 2,575 ms | 8 / 206 ms | none |
| MZ-01.00.30 | 1 | 7.4 s / 0 | 64,211 / 0 | 524 | 53 / 4,136 ms | 8 / 371 ms | none |
| MZ-01.00.30 (main) | 2 | 8.4 s / 0 | 64,118 / 0 | 517 | 62 / 5,149 ms | 9 / 350 ms | none |
| **MZ-01.00.31** | 1 | 8.8 s / 0 | 64,421 / 0 | 524 | 55 / **2,528 ms** | 5 / **106 ms** | none |
| MZ-01.00.31 (main) | 2 | 7.8 s / 0 | 64,243 / 0 | 516 | 52 / 3,439 ms | 6 / 125 ms | none |
| MZ-01.00.32 (Beta → final only) | 1 | 11.1 s / 0 | 64,259 / 0 | 509 | 64 / 4,550 ms | 5 / 141 ms | none |
| MZ-01.00.32 (Beta → final only) | 2 | 7.5 s / 0 | 64,380 / 0 | 511 | 51 / 3,051 ms | 6 / 114 ms | none |
| MZ-01.00.32 | 3 | 9.4 s / 0 | 64,589 / 0 | 511 | 46 / 2,470 ms | 6 / 145 ms | none |
| MZ-01.00.32 (main) | 4 | 9.3 s / 0 | 64,689 / 0 | 516 | 51 / 542 ms | 7 / 119 ms | none |
| MZ-01.00.33 (journey line only) | 1 | 8.3 s / 0 | 64,764 / 0 | 527 | 52 / 407 ms | 7 / 97 ms | none |
| MZ-01.00.33 | 2 | 9.6 s / 0 | 64,159 / 0 | 517 | 53 / 5,216 ms | 9 / 157 ms | none |
| MZ-01.00.33 | 3 | 9.3 s / 0 | 64,296 / 0 | 511 | 52 / 3,902 ms | 8 / 172 ms | none |
| MZ-01.00.32 (main) | 5 | 7.7 s / 0 | 64,053 / 0 | 513 | 59 / 5,184 ms | 7 / 139 ms | none |
| MZ-01.00.33 (main) | 4 | 9.4 s / 0 | 64,189 / 0 | 518 | 60 / 4,810 ms | 7 / 150 ms | none |
| **MZ-01.00.34** | 1 | 11.2 s / 0 | 64,230 / 0 | 514 | 57 / **4,184 ms** | 7 / **122 ms** | none |
| MZ-01.00.34 (main) | 2 | 10.9 s / 0 | 64,299 / 0 | 523 | 63 / 3,662 ms | 7 / 141 ms | none |
| MZ-01.00.35 | 1 | 8.0 s / 0 | 63,998 / 0 | 525 | 60 / 5,580 ms | 6 / 181 ms | none |
| MZ-01.00.35 | 2 | 7.8 s / 0 | 63,983 / 0 | 516 | 73 / 6,074 ms | 6 / 131 ms | none |
| MZ-01.00.34 (main) | 3 | 8.4 s / 0 | 64,559 / 0 | 516 | 34 / 427 ms | 6 / 121 ms | none |
| MZ-01.00.34 (main) | 4 | 8.1 s / 0 | 64,631 / 0 | 526 | 53 / 386 ms | 5 / 108 ms | none |
| **MZ-01.00.35** | 3 | 10.2 s / 0 | 64,488 / **0** | **529** | 50 / **554 ms** | 7 / **113 ms** | none |
| MZ-01.00.35 (main) | 1 | 10.9 s / 0 | 64,267 / 0 | 523 | 71 / 4,135 ms | 6 / 161 ms | none |
| MZ-01.00.36 (Stop only) | 1 | 8.9 s / 0 | 64,026 / 0 | 525 | 58 / 5,926 ms | 7 / 147 ms | none |
| MZ-01.00.36 (while tests ran) | 2 | 10.2 s / 0 | 64,121 / 0 | 511 | 56 / 5,166 ms | — | none |
| MZ-01.00.35 (main) | 2 | 9.2 s / 0 | 63,945 / 0 | 515 | 53 / 5,548 ms | — | none |
| MZ-01.00.35 (main) | 3 | 7.1 s / 0 | 64,694 / 0 | 525 | 61 / 631 ms | 6 / 115 ms | none |
| **MZ-01.00.36** | 3 | 8.9 s / 0 | 64,423 / **0** | 492 | 50 / 2,262 ms | 6 / **118 ms** | none |
| MZ-01.00.36 (main) | 4 | 10.7 s / 0 | 63,521 / 0 | 504 | 100 / 7,155 ms | 9 / 257 ms | none |
| MZ-01.00.37 | 1 | 16.3 s / 0 | 64,230 / 0 | 519 | 61 / 4,051 ms | 10 / 201 ms | none |
| MZ-01.00.36 (main) | 5 | 8.0 s / 0 | 64,269 / 0 | 518 | 52 / 5,116 ms | 8 / 123 ms | none |
| **MZ-01.00.37** | 2 | 9.9 s / 0 | 64,117 / **0** | 508 | 54 / 5,126 ms | 8 / **179 ms** | none |
| MZ-01.00.37 (main) | 3 | 9.9 s / 0 | 63,256 / 0 | 517 | 70 / 7,441 ms | 9 / 271 ms | none |
| **MZ-01.00.38** | 1 | 11.0 s / 0 | 64,367 / **0** | **518** | 57 / **575 ms** | 10 / **146 ms** | none |
| **MZ-01.00.39** | 1 | 8.7 s / 0 | 63,674 / **0** | 512 | 65 / 5,709 ms | 11 / 240 ms | none |
| MZ-01.00.38 (main) | 1 | 8.1 s / 0 | 63,910 / 0 | 526 | 76 / 5,709 ms | 8 / 187 ms | none |
| MZ-01.00.39 (main) | 1 | 8.6 s / 0 | 63,861 / 0 | 509 | 60 / 6,041 ms | 12 / 243 ms | none |
| MZ-01.00.40 | 1 | 9.8 s / 0 | 63,122 / 9 | 514 | 74 / 9,315 ms | 11 / 254 ms | none |
| MZ-01.00.40 | 2 | 10.2 s / 0 | 63,904 / 0 | 518 | 65 / 5,125 ms | 10 / 193 ms | none |
| MZ-01.00.39 (main) | 2 | 9.3 s / 0 | 64,165 / 0 | 520 | 55 / 4,092 ms | 11 / 170 ms | none |
| **MZ-01.00.40** | 3 | 12.0 s / 0 | 63,758 / **0** | 516 | 66 / 5,937 ms | 11 / **183 ms** | none |
| MZ-01.00.41 | 1 | 10.7 s / 0 | 63,205 / 0 | 515 | 104 / 6,416 ms | 13 / 370 ms | none |
| MZ-01.00.40 (main) | 1 | 11.2 s / 0 | 63,566 / 0 | 513 | 83 / 6,477 ms | 10 / 273 ms | none |
| MZ-01.00.40 (main) | 2 | 8.8 s / 0 | 63,660 / 0 | 520 | 63 / 6,178 ms | 12 / 236 ms | none |
| **MZ-01.00.41** | 2 | 9.6 s / 0 | 64,309 / **0** | **519** | 57 / **886 ms** | 9 / **171 ms** | none |
| MZ-01.00.42 (slower host) | 1 | 12.4 s / 0 | 53,183 / 507 | 396 | 105 / 18,777 ms | 60 / 13,829 ms | none |
| MZ-01.00.41 (main, slower host) | 1 | 12.3 s / 0 | 50,567 / 787 | 367 | 187 / 34,912 ms | 57 / 12,509 ms | none |
| MZ-01.00.41 (main, slower host) | 2 | 12.5 s / 0 | 54,466 / 379 | 407 | 86 / 26,727 ms | 53 / 9,779 ms | none |
| MZ-01.00.42 (slower host) | 2 | 13.1 s / 52 | 55,453 / 400 | 422 | 113 / 18,495 ms | 52 / 10,203 ms | none |
| **MZ-01.00.43** | 1 | 9.7 s / 0 | 63,773 / **0** | 511 | 73 / 5,725 ms | 9 / **224 ms** | none |
| MZ-01.00.42 (main) | 1 | 9.5 s / 0 | 63,853 / 0 | 518 | 61 / 5,174 ms | 9 / 271 ms | none |
| **MZ-01.00.44** | 1 | 11.0 s / 0 | 63,174 / **0** | **520** | 88 / 7,129 ms | 11 / 384 ms | none |
| MZ-01.00.43 (main) | 1 | 9.3 s / 0 | 63,481 / 0 | 502 | 64 / 6,447 ms | 13 / 355 ms | none |
| **MZ-01.00.45** | 1 | 10.2 s / 0 | 62,542 / **0** | **497** | 66 / 7,883 ms | 24 / 1,170 ms | none |
| MZ-01.00.44 (main) | 1 | 10.7 s / 0 | 61,320 / 145 | 484 | 127 / 12,087 ms | 24 / 1,132 ms | none |
| MZ-01.00.45 (main) | 1 | 12.8 s / 0 | 61,700 / 88 | 498 | 88 / 11,265 ms | 25 / 945 ms | none |
| MZ-01.00.46 | 1 | 10.9 s / 0 | 61,352 / 151 | 470 | 93 / 11,441 ms | 26 / 1,519 ms | none |
| **MZ-01.00.46** | 2 | 10.3 s / 0 | 61,238 / **44** | 468 | 79 / 10,114 ms | 33 / 1,324 ms | none |
| MZ-01.00.45 (main) | 2 | 10.1 s / 0 | 61,057 / 177 | 475 | 91 / 10,896 ms | 27 / 1,149 ms | none |
| MZ-01.00.46 (main) | 1 | 10.7 s / 0 | 60,659 / 53 | 480 | 130 / 12,571 ms | 25 / 1,998 ms | none |
| MZ-01.00.47 | 1 | 11.1 s / 0 | 61,117 / 112 | 486 | 107 / 13,322 ms | 21 / 1,011 ms | none |
| **MZ-01.00.47** | 2 | 15.8 s / 0 | 63,787 / **0** | **519** | 64 / **5,251 ms** | 16 / **310 ms** | none |
| MZ-01.00.46 (main) | 2 | 9.1 s / 0 | 63,066 / 0 | 504 | 79 / 6,355 ms | 19 / 539 ms | none |
| MZ-01.00.47 (main) | 1 | 12.7 s / 0 | 62,695 / 0 | 503 | 60 / 7,787 ms | 24 / 845 ms | none |
| MZ-01.00.48 (first build) | 1 | 16.4 s / 0 | 60,694 / 223 | 468 | 76 / 13,418 ms | 37 / 1,238 ms | none |
| **MZ-01.00.48** | 2 | 9.9 s / 0 | 62,456 / **7** | **498** | 76 / **8,185 ms** | 28 / **880 ms** | none |
| MZ-01.00.47 (main) | 2 | 11.2 s / 0 | 61,743 / 44 | 489 | 67 / 10,051 ms | 23 / 888 ms | none |
| MZ-01.00.48 (main) | 1 | 10.8 s / 0 | 60,693 / 206 | 469 | 103 / 12,655 ms | 35 / 1,587 ms | none |
| **MZ-01.00.49** | 1 | 9.3 s / 0 | 62,106 / **0** | **498** | 82 / **8,302 ms** | 19 / **1,101 ms** | none |
| MZ-01.00.49 (main) | 1 | 10.3 s / 0 | 63,084 / 0 | 507 | 80 / 7,262 ms | 16 / 355 ms | none |
| MZ-01.00.50 (host stall) | 1 | 11.5 s / 0 | 62,252 / 29 | 498 | 84 / 8,990 ms | 19 / 746 ms | none |
| **MZ-01.00.50** | 2 | 10.3 s / 0 | 63,299 / **0** | **510** | 60 / **5,886 ms** | 15 / **341 ms** | none |
| MZ-01.00.49 (main) | 2 | 16.2 s / 0 | 62,420 / 10 | 506 | 87 / 9,792 ms | 12 / 505 ms | none |
| MZ-01.00.50 (main) | 1 | 11.1 s / 0 | 62,874 / 0 | 514 | 121 / 7,153 ms | 17 / 633 ms | none |
| **MZ-01.00.51** | 1 | 10.0 s / 0 | 61,999 / **0** | **480** | 106 / **9,404 ms** | 26 / **951 ms** | none |
| MZ-01.00.50 (main) | 2 | 10.2 s / 0 | 61,845 / 56 | 487 | 87 / 10,346 ms | 25 / 802 ms | none |
| MZ-01.00.51 | 2 | 10.6 s / 0 | 62,434 / 31 | 482 | 91 / 8,168 ms | 27 / 743 ms | none |
| MZ-01.00.51 (main) | 1 | 14.5 s / 0 | 63,067 / 0 | 518 | 81 / 7,563 ms | 14 / 600 ms | none |
| MZ-01.00.52 | 1 | 8.3 s / 0 | 62,903 / **2** | **504** | 78 / **7,488 ms** | 14 / **483 ms** | none |
| MZ-01.00.52 (main) | 1 | 10.4 s / 0 | 64,045 / 0 | 524 | 64 / 4,729 ms | 7 / 142 ms | none |
| **MZ-01.00.53** | 1 | 9.5 s / 0 | 64,730 / **0** | **527** | 48 / **330 ms** | 7 / **96 ms** | none |
| MZ-01.00.53 (main) | 1 | 8.4 s / 0 | 64,148 / 0 | 520 | 76 / 4,194 ms | 9 / 244 ms | none |
| **MZ-01.00.54** | 1 | 11.0 s / 0 | 63,705 / **0** | **523** | 75 / **6,957 ms** | 8 / **212 ms** | none |
| MZ-01.00.54 | 2 | 9.9 s / 0 | 64,050 / 0 | 515 | 60 / 4,865 ms | 9 / 191 ms | none |
| MZ-01.00.53 (main) | 2 | 12.6 s / 0 | 64,269 / 0 | 523 | 64 / 3,956 ms | 8 / 125 ms | none |
| MZ-01.00.54 (main) | 1 | 10.4 s / 0 | 63,402 / 0 | 514 | 76 / 6,726 ms | 12 / 333 ms | none |
| **MZ-01.00.55** | 1 | 10.5 s / 0 | 63,724 / **0** | **522** | 78 / **4,747 ms** | 9 / **311 ms** | none |
| MZ-01.00.55 (main) | 1 | 10.9 s / 0 | 63,130 / 0 | 501 | 81 / 6,746 ms | 18 / 521 ms | none |
| MZ-01.00.56 (draft) | 1 | 10.5 s / 0 | 62,899 / 0 | 504 | 69 / 6,092 ms | 19 / 730 ms | none |
| **MZ-01.00.56** | 2 | 10.0 s / 0 | 63,386 / **0** | **494** | 75 / **5,539 ms** | 14 / **345 ms** | none |
| MZ-01.00.55 (main) | 2 | 9.4 s / 0 | 63,096 / 0 | 495 | 65 / 7,143 ms | 12 / 316 ms | none |
| MZ-01.00.56 (main) | 1 | 11.5 s / 0 | 62,197 / 40 | 501 | 82 / 9,764 ms | 15 / 745 ms | none |
| MZ-01.00.57 | 1 | 9.3 s / 0 | 61,558 / 87 | 484 | 92 / 11,631 ms | 19 / 924 ms | none |
| MZ-01.00.56 (main) | 2 | 9.8 s / 0 | 62,899 / 10 | 512 | 73 / 9,063 ms | 15 / 310 ms | none |
| MZ-01.00.57 | 2 | 12.9 s / 0 | 61,706 / 95 | 493 | 75 / 12,245 ms | 18 / 942 ms | none |
| **MZ-01.00.57** | 3 | 11.1 s / 0 | 63,153 / **0** | **499** | 72 / **6,381 ms** | 21 / **627 ms** | none |
| MZ-01.00.56 (main) | 3 | 10.2 s / 0 | 60,076 / 328 | 466 | 80 / 16,400 ms | 43 / 1,541 ms | none |
| **MZ-01.00.58** | 1 | 11.6 s / 0 | 61,919 / **0** | **502** | 99 / **11,820 ms** | 16 / **648 ms** | none |
| MZ-01.00.57 (main) | 1 | 16.4 s / 0 | 62,463 / 31 | 514 | 79 / 10,685 ms | 15 / 322 ms | none |

**MZ-01.00.37: what the differences were.** Two pairs with main, alternating. Report opens at p95 were 4.1 and 5.1 s on the branch against 7.2 and 5.1 s on main; triage results 201 and 179 ms against 257 and 123 ms; requests a second 519 and 508 against 504 and 518, with 0 failed requests and no finding sent twice in any run. The first branch run's opening burst took 16.3 s, a little above the 7.4–15.8 s seen before, and its fetches were slower (17 s against 12 s at the median); in the second pair the burst took 9.9 s (main 8.0 s) and fetches matched main (13.5 s against 13.0 s at the median). What the fetch now does in addition is one pass over each project's findings to count what is past its SLA, which is a few microseconds a finding next to reading them from Checkmarx One. Escalation runs only on the automation's schedule, which the benchmark does not use.

**MZ-01.00.53: what the differences were.** One pair, main then branch, on a calm host, both with 0 failed. The branch served 527 requests a second against main's 524. Report opens took 330 ms against 4.7 s at p95, and triage polls 96 against 142 ms. The release adds Get help (its own routes and file, which the benchmark's people do not call), one field in the sign-in answer (`/api/me`) and one settings section. None of these is on the measured paths, so the faster tail is the host, not the change. No finding was sent twice.

**MZ-01.00.54: what the differences were.** Two pairs, alternating main and branch, all four with 0 failed requests and no finding sent twice. The branch served 523 and 515 requests a second, against main's 520 and 523. At p50 every operation matched main. At p95, report opens took 7.0 and 4.9 s on the branch against 4.2 and 4.0 s on main, and triage polls 212 and 191 ms against 244 and 125 ms. The same branch code gave 7.0 s and then 4.9 s, so this host's tail moves by 2 s from run to run. The slower tail is the host, not the change, because report opens never reach the changed code: they go to `/api/relay/hello`, which needs no sign-in. On signed-in routes the release adds one check of the person's own branding. The new per-request context (an `AsyncLocalStorage`) is never switched on unless someone has turned on their own branding, and nobody in the benchmark has. A first main run, made while tests were running alongside it, is left out: it had 12 failed requests at 509 a second. After the benchmark, `proxy-addr` moved from 2.0.7 to 2.0.8 for a security fix: a patch release that only changes how trusted proxy addresses are matched.

**MZ-01.00.55: what the differences were.** One pair, main then branch, both with 0 failed requests and no finding sent twice. The branch served 522 requests a second against main's 514. Report opens took 4.7 s at p95 (main 6.7 s), and triage polls 311 ms (main 333 ms). The release changes only the Activation codes page and adds one flag to the sign-in answer (`/api/me`), so nothing on the measured paths is slower.

**MZ-01.00.56: what the differences were.** Two pairs with main, all four with 0 failed requests and no finding sent twice. The first branch run was of an earlier draft, and tests ran alongside its last seconds, so it is shown but not used. On the final code the branch served 494 requests a second against main's 495 and 501. Report opens took 5.5 s at p95 against 7.1 and 6.7 s. Triage polls took 345 ms against 316 and 521 ms: within the spread of main's own runs.

What this release adds while the benchmark runs:
- **A self-check every 5 minutes.** It asks Checkmarx One one small question, connects to the mail server, and reads a counter.
- **A five-minute look at whether the weekly status is due.**

Nothing on the measured paths changed. The work done when the server stops (a backup, and the emails) happens after the benchmark ends.

**MZ-01.00.58: what the differences were.** One pair, branch first on a quiet host. The branch served 502 requests a second with 0 failed; main 514 with 31 failed. The branch's tail was slower (report opens 11.8 s against 10.7 s, triage polls 648 against 322 ms at p95), and its run had a 30 s health check: the host stalled. The release changes the Activation codes page and one step at start-up, none of which the benchmark calls. No finding was sent twice.

**MZ-01.00.57: what the differences were.** Three pairs with main. No finding was sent twice in any run, and no burst failed. In the first two pairs, translation and review work ran on the same 4-CPU host (pinning the server to two CPUs does not keep other programs off them), and every run had failed requests during host stalls. In those stalls even the health check and "who am I" waited up to 9 s (main) and 17–30 s (branch), with the server at about half its CPU: main had 40 and 10 failed, the branch 87 and 95. The third pair ran on a quiet host with the branch first: the branch served 499 requests a second with **0 failed**, report opens 6.4 s and triage polls 627 ms at p95; main, second, stalled (a 30 s health check) and had 328 failed. The release adds nothing to the measured paths: explanations are built only when a connection test, a send or a .env upload fails, and the one change on every error answer is a check of the route's path.

**MZ-01.00.52: what the differences were.** One pair, main then branch. The branch served 504 requests a second against main's 518, with a slightly faster tail: report opens 7.5 s against 7.6 s at p95, triage polls 483 against 600 ms. It had 2 failed requests, one report hello and one triage-results poll. Both happened while the host stalled (health checks up to 7.3 s; main's run reached 6.2 s), and neither request touches this release's one server change: temporary report file names now come from `crypto.randomBytes`. The rest of the release is tests and the Caddy compose file. No finding was sent twice.

**MZ-01.00.51: what the differences were.** None from the change: the benchmark never calls the routes it touches (allocating from a tracked report or Credit Control, and a page-only scroll fix). There were two pairs, main then branch each time.
- **First pair:** both had 0 failed. Main served 514 requests a second, the branch 480 with a slower tail: report opens 9.4 s against 7.2 s at p95, triage polls 951 against 633 ms. The host stalled during the branch's run: one health check waited 17.9 s (main's worst was 8.5 s), and the run took 129 s instead of 122.
- **Second pair:** the stall hit both. Main served 487 a second with 56 failed and the branch 482 with 31 failed, spread over report polls and opens, credit balances and analytics, none of them a route this release changed. This time the branch's tail was the faster one: report opens 8.2 s against 10.3 s, triage polls 743 against 802 ms.
- **Sent twice:** no finding in any run.

**MZ-01.00.50: what the differences were.** None from the change. There were two pairs: main then branch, then branch then main.
- **First pair:** main served 507 requests a second with 0 failed. The branch served 498 with 29 failed, spread over report polls and opens, and a slower tail (report opens 9.0 s against 7.3 s at p95). Its health checks waited up to 15 s against main's 7 s: the host stalled during the branch's run.
- **What the change costs:** the finding journal that feeds the Impact page records each fetch's findings in memory and writes them to disk at most every 5 seconds. Measured on its own with 200 projects and 12,000 findings: 8 ms per Dashboard fetch and 10 ms per write, 1 to 2% of one core over a run. That is far too little to explain the first pair.
- **Second pair:** the branch served 510 a second with 0 failed, against main's 506 with 10 failed (main's turn to meet the stall: health checks up to 12 s). Report opens took 5.9 s against 9.8 s at p95, and triage polls 341 ms against 505 ms.
- **Sent twice:** no finding in any run.

**MZ-01.00.49: what the differences were.** One pair, main then branch. The branch served 498 requests a second with 0 failed, against main's 469 with 206 failed. Report opens took 8.3 s against 12.7 s at p95, and triage polls 1.1 s against 1.6 s. Main's run hit a host stall: its health checks waited up to 18 s, and its failures were spread over every kind of request, while the branch's health checks peaked at 16 s with none failing. The change adds three routes (a tracked report's **Remediate with AI Assist now**, Credit Control's **Use the credits**, and the Dashboard's credit refresh) that the benchmark's people do not call. The one measured path that changed is a tracked report's refresh, which now also counts the confirmed findings still to remediate (one more pass over the findings it already reads): it took 12.4 s at p95 against main's 13.0 s. No finding was sent twice.

**MZ-01.00.48: what the differences were.** The first build was slower, and that was fixed. In the first pair, main served 503 requests a second with 0 failed. The branch served 468 a second, with 223 connection-level failures and report opens at 13.4 s p95.
- **The cause:** the branch ran every request inside an AsyncLocalStorage context, to know which tenant it is for. On Node 22, the version on the benchmark machine, that tracking slows every promise down: about 2.7× inside a context, and still about 40% after the first use.
- **The fix:** with one tenant, the context is never entered, so tracking stays off and costs nothing on any Node version. Store methods are now bound once per store, not on every call. The container image runs Node 24, where the context costs little anyway, so it only matters for servers that turn on several tenants.
- **After the fix:** the second pair ran branch then main. The branch served 498 a second with 7 failed (connect timeouts), against main's 489 with 44 failed (resets and timeouts). Report opens took 8.2 s against 10.1 s at p95, and triage polls 880 ms against 888 ms. No finding was sent twice in any run.

**MZ-01.00.47: what the differences were.** None from the change. There were two pairs: main then branch, then branch then main.
- **First pair:** the host stalled, with health checks waiting up to 17 s (main) and 20 s (branch). Both runs had failures, and every one was at connection level (`ECONNRESET`, connect timeout), never an answer from the server: main 53, branch 112. Report opens took 12.6 and 13.3 s at p95.
- **Second pair:** the host was calm. Both runs had 0 failed requests. The branch served 519 requests a second against main's 504. Report opens took 5.3 s against 6.4 s at p95, and triage polls 310 ms against 539 ms.
- **Sent twice:** no finding in any run.

What the server gained is off the measured paths. The Let's Encrypt challenge check is one string comparison per request. The `/i18n` check runs only for language files. The activation and certificate routes are not called by the benchmark, and `/api/health` adds a short list of language codes.

**MZ-01.00.46: what the differences were.** Two pairs: main then branch, then branch then main. Every run had failed requests, and in every one each failure was a connection that was reset or not accepted in time (`ECONNRESET`, connect timeout), never an answer from the server. The health check stalled for up to 20–22 s in both runs of the second pair, so the machine itself paused: main, whose code served 497 a second with 0 failed at its own release, failed 88 and 177 times here. Across the two pairs:
- **Failed requests:** branch 151 and 44, main 88 and 177.
- **Requests a second:** branch 470 and 468, main 498 and 475.
- **Report opens at p95:** branch 11.4 and 10.1 s, main 11.3 and 10.9 s.
- **Triage polls at p95:** branch 1.5 and 1.3 s, main 0.9 and 1.1 s.
- **Sent twice:** no finding in any run.

The change adds two routes that only Credit Control's give bar calls (the project list and giving credits), and the benchmark calls neither. The paths it measures are unchanged.

**MZ-01.00.45: what the differences were.** One pair, main then branch, with nothing else running on the machine. The branch served 497 requests a second with 0 failed. Main served 484 a second with 145 failed. Main's code is the MZ-01.00.44 that served 520 a second with 0 failed at its own release, so those failures come from the machine being slower that day, not from either version. With the branch:
- report opens took 7.9 s at p95 against main's 12.1 s;
- triage polls took 1.2 s against 1.1 s;
- no finding was sent twice.

The server-side changes are the profile routes, and the auto-update looking once an hour outside its install hour. Neither is on the paths the benchmark uses. The language files are only fetched by browsers set to another language.

**MZ-01.00.44: what the differences were.** None from the change. This version changes only the browser's page (layout and styles) and the user guide, so the server is the same as MZ-01.00.43's. One pair, branch then main, both with 0 failed requests and no finding sent twice. The branch served 520 requests a second against 502. Report opens took 7.1 s against 6.4 s at p95 and triage polls 384 ms against 355 ms, both above the previous pair on main as well (5.2 s, 271 ms): the machine was slower for both runs.

**MZ-01.00.43: what the differences were.** One pair, branch then main, on a host back to its usual speed. Main ran 518 requests a second with 0 failed, as earlier releases did, which also confirms that MZ-01.00.42's failed runs came from that machine. The branch ran 511 a second, also with 0 failed and no finding sent twice. Report opens were 5.7 s against 5.2 s at p95 (both in the slow mode) and triage polls 224 ms against 271 ms. The change is to how the Azure DevOps connection reads its address and binds its token. That code runs when Settings is saved, when the Git chip checks its connections (at most every 5 minutes) and when Code authors clones a repository; the benchmark does none of these.

**MZ-01.00.42: what the differences were.** None from the change. This version changes only the browser's page (`public/app.js`, `index.html`, `styles.css`) and the user guide, and the server is the same as MZ-01.00.41's. The benchmark ran on a different, slower machine: the session had moved to a fresh container. There, main and the branch were degraded alike. Main failed 787 and 379 requests and the branch 507 and 400, out of about 54,000. Throughput was 367 and 407 requests a second on main against 396 and 422 on the branch, and report opens took 27–35 s at p95 on main against 18–19 s. Health checks stalled for up to 30 s on main too. These four rows cannot be compared with the earlier ones, so the status tables show "—" for this version. No run sent a finding twice.

**MZ-01.00.41: what the differences were.** Two pairs with main, alternating (branch, main, main, branch). Every run had 0 failed requests, and none sent a finding twice. In the first pair, requests a second were 515 against 513 and report opens 6.4 against 6.5 s at p95 (both slow mode). Triage polls were 370 ms against 273 ms at p95, above main's usual range. The second pair reversed that: 171 ms on the branch against 236 ms on main, report opens 0.9 s against 6.2 s, and 519 against 520 requests a second. This version adds no work to the triage-poll path. On request paths it adds two things: the Update page reads three small files (Admins only, when the page is open), and the server writes one file when it starts. The update companion is a separate container, which the benchmark does not run.

**MZ-01.00.40: what the differences were.** Two pairs with main, then one more branch run. The first branch run had **9 failed requests** out of 63,122 (4 triage-result polls, 3 report opens, 2 triage requests) and report opens at 9.3 s at p95. In that run the server stalled for up to 13.8 s; every kind of request waited, health checks included (9.4 s at most, against 1.1–5.0 s in the other runs). The status codes were not recorded for that run, so whether the 9 were dropped connections or 5xx answers is not known. Main had a run like it in MZ-01.00.17 (6 failed). Nothing this version changes runs during the benchmark. The new code runs only on the automation's schedule, when SLA issues are switched on, and the benchmark uses neither. The rest of the change is a checkbox on the Settings page and a POST method on the GitHub client. The next branch runs had 0 failed requests and 518 and 516 requests a second, against 509 and 520 on main. Report opens were 5.1 and 5.9 s at p95 against 6.0 and 4.1 s, and triage polls 193 and 183 ms against 243 and 170 ms. The last run recorded its status codes (`BENCH_OUT`) in case the stall came back; it did not. No run sent a finding twice.

**MZ-01.00.39: what the differences were.** One pair, branch first then main. Report opens at p95 were the same, 5.7 s on both (both runs in the slow mode). Requests a second were 512 against 526, and triage results at p95 240 ms against 187 ms: both within what main alone has measured across releases (492–529 a second, 113–271 ms). Neither run had a failed request or a finding sent twice. On the request paths the benchmark uses, this version adds one field to each finding when it is read (the recommended package version, a few property reads) and one optional label to each row of the report. Code owners and change requests are read only when someone clicks **Find code authors**, which the benchmark does not do.

**MZ-01.00.38: what the differences were.** One pair with main, back to back. Requests a second were 518 on the branch against 517 on main, with 0 failed requests and no finding sent twice in either run. Report opens at p95 were 575 ms against 7.4 s on main, and triage results 146 ms against 271 ms: the branch run landed in the fast mode of report opens (about 0.4 s) and main in the slow one (4–6 s, see MZ-01.00.35 and MZ-01.00.36 below), so this is not a speed-up from the change. The opening burst took 11.0 s against 9.9 s on main, within the 7.1–16.3 s seen before. This version changes who a reminder goes to and where things are shown, not how requests are served: a scheduled run reads one more setting, and a tracked report's reminder looks it up once.

**MZ-01.00.36: what the differences were.** None from the change, across three pairs with main. Report opens at p95 were 5.9, 5.2 and 2.3 s on the branch against 4.1, 5.5 and 0.6 s on main: both land in the slow mode (4–6 s, when opens arrive while a fetch or an HTML report is being built), main in two of three pairs here and three of six counting MZ-01.00.35's. The server's CPU was the same in every run (98–102 % of a core) for the same work (64,000 requests, 0 failed, no finding sent twice). The last branch run took 131 s instead of 123 s to finish its requests, so its rate reads 492 a second for the same 64,423 requests. What changed on the server: Stop (a flag checked before each project is read), the browser icon (a route the benchmark does not call), and the update check (not on any request path the benchmark uses). The second branch run overlapped test runs on the same machine and is listed for completeness.

**MZ-01.00.35: what the differences were.** None from the change, after three pairs run back to back. The first two branch runs had report opens at p95 of 5.6 and 6.1 s, against 3.7 and 0.4 s on main. A third pair, main first, gave 0.39 s on main and 0.55 s on the branch, with the branch at 529 requests a second, the most of the six runs. Report opens fall into two modes: about 0.4 s, or 4 to 6 s when a run hits a stall, and main has landed in both (0.4 to 5.2 s across releases). Nothing on the report path changed. The Git chip's checks run only when someone opens a page (at most every 5 minutes per connection), taking back credits is a rare admin action, and the benchmark sets no git tokens. All six runs had 0 failed requests and no finding sent twice.

**MZ-01.00.34: what the differences were.** None from the change. Making the page simpler is all in the browser: a switch hides advanced options, and the words changed. The server only got two clearer error messages. Run back to back with main, report opens and triage polls were a little faster, with 0 failed requests and no finding sent twice. The burst took 11.2 s against 9.4 s; burst times have ranged from 7.4 to 15.8 s with the same code.

**MZ-01.00.33: what the differences were.** None from the change. The developer's rescan window, its links and emails only do anything when a tracked report's round is closed, and the benchmark's tracked report (20 projects) never is. Email volume was the same as main's (1,076 to 1,129 a run).
- **Report opens:** the tail (p95) moved between 0.4 and 5.2 s from run to run, for main and the branch alike. Main itself gave 542 ms in run 4 and 5,184 ms in run 5, an hour apart. Run back to back, the branch had 3.9 s and main 5.2 s.
- **No failures:** every run had 0 failed requests, and no finding was sent for triage twice.

**MZ-01.00.32: what the differences were.** None that matters. Making a Beta feature final, and the hardened git blame, only run when someone uses the Beta page, or on a scheduled run with *Also email the code authors* switched on. The mixed load does neither. Each request to `/api/me` now also lists the feature stages, which is a lookup in memory.
- **Run 1 was slower** (report opens p95 4.6 s, and the burst took 11.1 s with 795 busy retries). It ran right after the container restarted. Main and the branch were then run back to back from clean worktrees:
  - main (MZ-01.00.31) run 2: 3.4 s;
  - the branch: 3.1 s;
  - the final code (run 3): 2.5 s.
- **All three are inside the spread** of the same code seen before (1.3 to 7 s). Every run had 0 failed requests, and no finding was sent for triage twice.

**MZ-01.00.31: profiled, and faster again.** Main (MZ-01.00.30 run 2) and the branch were run back to back on the same machine. A CPU profile under the full load found no single long block: the server's one thread was simply busy, and report opens waited behind it. What changed:
- **Report opens no longer wait on Checkmarx One for finding states.** The states are kept 30 s. When they ran out, the next open report waited for a fresh read, queued behind every fetch. Now it is answered from the last states known while they are read again in the background, so p95 went from 5.1 s to 2.5 s. An action from a report still reads the state fresh.
- **Credit figures are worked out in one pass per project.** Before, it took a dozen passes, twice per project on every fetch.
- **Emailed reports are compressed off the main thread.** A report of several megabytes used to be gzipped in line.
- **API calls skip the static-file lookup**, which was one disk `stat` per request.
- **Dates are no longer turned back into text and parsed again**, once per finding per fetch.

| Sustained, same machine | Main (MZ-01.00.30) | MZ-01.00.31 |
| --- | --- | --- |
| Failed requests | 0 of 64,118 | **0 of 64,421** |
| Requests per second | 517 | **524** |
| Report opens (p50 / p95) | 62 ms / 5.1 s | **55 ms / 2.5 s** |
| Report polls: triage results (p50 / p95 / p99) | 9 / 350 / 1,728 ms | **5 / 106 / 1,209 ms** |
| Report: triage (p95) | 5.5 s | **4.0 s** |
| Dashboard: build HTML report (p95 / p99) | 9.6 s / 12.8 s | **7.4 s / 10.9 s** |
| Reminder: HTML report to initiators (p95) | 7.1 s | **5.4 s** |
| Reminder: email initiators (p95) | 5.4 s | **4.4 s** |
| Pages: health (p50 / p95) | 11 / 108 ms | **4 / 65 ms** |
| Server CPU (average) | 101% | 97% |

Two operations were slightly slower at p95: tracked-report refresh (6.9 s against 6.4 s) and Refresh & verify credits (6.4 s against 6.1 s). Both wait on Checkmarx One, and the branch made more upstream calls in the same time (36,048 against 35,041). The difference is within the spread between runs of the same code (see MZ-01.00.28). No finding was sent for triage twice.

**MZ-01.00.30: what the differences were.** None that matters: Update & recovery only does work when an Admin uses it (and auto-update looks every 15 minutes, off by default). In production the server now runs under the launcher; that adds one small process and nothing per request. The benchmark runs the server directly, as before.

**MZ-01.00.29: what the differences were.** None expected, and none seen: the change is in the emailed report's own page (the tools bar and the row buttons), not on the server. The "before" is MZ-01.00.28 run 1.

**MZ-01.00.28: what the differences were.** Nothing that matters. Verification adds a closure count to each tracked-report reading (a pass over its findings already in memory), and rescans only run when someone verifies, so the mixed load never starts one. Tracked-report refresh p50 1.48 s against 1.87 s, p95 8.4 s against 6.8 s, which is within the spread between runs. No failed requests, and no finding sent twice. The "before" is MZ-01.00.27 run 2, the same code as main.

**MZ-01.00.27: what the differences were.**
- **Building a report costs a little more, by design.** Each finding now gets its file and line ("Open in IDE"), read from the scan's results. Run 1 read them on every build: the dashboard's "build HTML report" went from 1.41 s to 2.15 s (p50).
- **A completed scan's locations never change, so they are now cached** (30 minutes, the last 40 scans, file and line only). Run 2 builds in 1.65 s (p50); p95 8.7 s against main's 9.7 s. The first build after a fetch still reads the scan once, which is what the burst shows (7.2 s against 4.4 s for its 30 builds at once).
- **Nothing else moved.** No failed requests, the same request rate, report opens and triage polls within the runs before, and no finding sent twice. Run 1's slower burst (15.8 s) is the load generator's pace, seen before (MZ-01.00.26 below).

**MZ-01.00.26: what the differences were.**
- **The Checkmarx One fixes (run 4) cost nothing measurable.** They sit on paths the load barely touches: git clone, sign-in, the mail From header, and one id check per audit entry. Run 4 had no failures, and its tail (report opens p95 8.2 s) is inside the range of the runs before it, main included (6.2 to 10.8 s).
- **The 144 failures in run 2 did not come back.** They were report opens and status polls that timed out, and the health check once waited 30 s. A third run with an event-loop monitor inside the server, and six more runs alternating with main, had no failures, and the monitor saw the loop block for at most 0.5 s. Run 2 was not traced itself, so its cause is not proven: the likeliest is the load generator, which shares its two CPUs with the mock Checkmarx One.
- **The slower bursts (15.8 s) were the load generator's pace, not a slowdown.** Six short burst runs, alternating main and the branch with nothing else on the machine:

  | Burst of 2970 | Run 1 | Run 2 | Run 3 |
  | --- | --- | --- | --- |
  | main | 9.9 s | 7.6 s | 9.0 s |
  | MZ-01.00.26 | 8.8 s | 11.1 s | 9.1 s |

  Both vary over the same range, all with 0 failures. When the generator fires fast enough, more than 300 report requests arrive at once and the server answers some "busy, retry" (main run 3: 638; MZ-01.00.26 run 1: 127). When it fires slower, none are turned away and the last ones simply wait longer.
- **The changes on the server's hot paths cost nothing measurable.** Template rendering counts its work, a Checkmarx One sign-in is shared between concurrent requests, and a few more inputs are capped.

## MZ-01.00.47: the page with 1,000 projects

The server benchmark above measures the server. This one measures the browser, because a large tenant made the Dashboard itself slow. Each run has 1,000 projects with 20 findings each, Chromium with the CPU slowed 4× (a modest laptop), and MZ-01.00.46 (main) against MZ-01.00.47:

| What the person does | MZ-01.00.46 | MZ-01.00.47 |
| --- | --- | --- |
| **Load findings:** longest freeze while results stream in | 2.7 s | 0.24 s |
| **Load findings:** time until the page is usable again | 9.5 s | 6.0 s |
| **Type "Project 1" in the project search:** time until it settles | 21.5 s | 1.8 s |
| **Type in the search:** slowest frame | 3.6 s | 0.13 s |
| **Scroll the project list:** 95th-percentile frame | 33 ms | 17 ms |
| **Back to the Dashboard** from another page | 1.9 s | 0.25 s |
| **Elements on the page** after loading | 106,581 | 11,993 |

What changed in the page:
- **Rows:** the project list shows 100 rows, with **Show 100 more** and **Show all** below. Sorting, filtering, selecting and exporting still cover every project.
- **Search:** the filter waits for typing to pause (150 ms) before it redraws.
- **Loading:** while results stream in, the list is redrawn at most every 0.4 s instead of after every project.
- **Scrolling:** hover effects are paused while the list scrolls.

The other pages (Reports, Credit Control, Audit, People & roles, Settings, Logs) opened in 50–410 ms on both versions.

## MZ-01.00.21: profiled, and the slow tail removed

A CPU profile of the server under the full load showed where its single thread went besides real work. What changed:
- **A click never waits behind a background read.** The report's status polls start low-priority reads in the background. A person who then clicked (AI Remediation details), or a Dashboard HTML report or reminder that needed the same finding's triage verdict, joined that read and waited behind every bulk fetch. They now read at their own, normal priority. This removed the 60 s timeouts.
- **Saving a person's fetched data:** at once, then at most every 30 s while it keeps changing (`SESSION_SAVE_SECONDS`), instead of turning a large fetch into JSON on every change. A stop or update still writes everything at once.
- **Checkmarx One records shared by recent reads** are turned into the tool's form once per record, project and day, not once per person per fetch.
- **Report permissions** (the signed grants in every report) are checked once, then remembered for exactly the same fields and expiry.
- **The audit log** keeps what it has already parsed, and reads only lines added since. The part already read is hash-checked on every read, so an edited or removed entry is still seen at once by the integrity check.
- **Credit ledger lookups** hand out read-only views instead of copies.

Same machine, same load (3000 users, 120 s, server pinned to 2 vCPU), same load generator for both.

| Sustained load | Before (MZ-01.00.20) | After (MZ-01.00.21) |
| --- | --- | --- |
| **Failed requests** | 34 of 61,773 | **0 of 63,324** |
| Requests per second | 462 | **505** |
| **Report opens, all states known** (p50 / p95 / p99) | 96 ms / 11.0 s / 15.3 s | **60 ms / 6.2 s / 7.6 s** |
| Report polls: triage results (p50 / p95) | 28 ms / 1.3 s | **19 ms / 0.7 s** |
| Report: AI Remediation details (p95 / p99) | 284 ms / 2.1 s | **192 ms / 1.8 s** |
| **Dashboard: build HTML report** (p50 / p95 / failed) | 4.1 s / 60 s / 9 | **2.5 s / 8.4 s / 0** |
| **Reminder: HTML report to initiators** (p95 / p99 / failed) | 38.6 s / 60 s / 5 | **7.5 s / 10.1 s / 0** |
| Reminder: email initiators (p95 / p99) | 10.0 s / 50.9 s | **5.7 s / 8.3 s** |
| Refresh & verify credits (p50) | 4.3 s | **3.3 s** |
| Fetch, whole tenant (p50 / p95) | 23.5 s / 35.0 s | **17.2 s / 28.0 s** |
| Audit log: browse (p99) | 12.2 s | **1.7 s** |
| Pages: who am I, settings, health (p50 / p99) | 42 ms / 7.0 s | **26 ms / 2.9–4.9 s** |
| Server health check (worst) | 14.1 s | **5.9 s** |
| Checkmarx One calls | 31,931 | 32,548 |

**Burst** (2,970 requests at the same instant): 0 failed both times, all answered in 10.2 s (12.4 s before).

The server's one thread is still the limit at this load (about one core busy on average), so beyond it, give it more resources or run separate instances for separate tenants; see [Recommended size](#recommended-size).

## MZ-01.00.17: faster fetches and report opening

What changed:
- **Shared recent reads.** A project fetched by anyone in the last 2 minutes is reused by the next fetch on the same Checkmarx One key, while its latest scan is unchanged and nobody triaged it from here (see [How it works](how-it-works.md)).
- **Big projects, a few pages at once**, and last-scan lookups in parallel.
- **Reports open with one call** (`/api/relay/hello`) instead of four.
- **Big replies compressed** (32 KB and up): the page, the fetch stream, full results, downloads.

Same machine, same load (3000 users, 120 s, server pinned to 2 vCPU), same load generator for both. Reports open the way the real report does: before, the status then credits, triage results and remediation state side by side; after, the one call.

| Sustained load | Before (MZ-01.00.16) | After (MZ-01.00.17) |
| --- | --- | --- |
| **Failed requests** | 242 of 69,796 | **6 of 64,320** |
| **Report opens, all states known** (p50 / p95 / p99) | 222 ms / 11.7 s / 14.5 s | **53 ms / 2.1 s / 4.4 s** |
| Report polls: triage results (p95 / p99) | 1.1 s / 8.2 s | **240 ms / 1.3 s** |
| Report polls: remediation state (p95 / p99) | 5.9 s / 10.7 s | **65 ms / 149 ms** |
| Report: triage (p95) | 6.1 s | **3.9 s** |
| **Fetch, whole tenant** (p50 / p95) | 26.2 s / 34.7 s | **10.3 s / 25.1 s** |
| 21 people fetching at the same moment | 15.2 s | **2.7 s** |
| Refresh & verify credits (p50 / p95) | 4.4 s / 7.0 s | **1.9 s / 5.6 s** |
| Tracked report refresh (p50) | 2.8 s | **1.5 s** |
| Email reminders to initiators (p95) | 20.8 s | **6.6 s** |
| Pages: who am I, settings, health (p50 / p99) | 10 ms / 0.3–0.4 s | 10 ms / 0.2 s |
| Server health check (worst) | 30 s | **0.3 s** |
| Checkmarx One calls | 37,781 (113 fetches) | 36,706 (136 fetches) |

Requests per second fell (536 → 494) because each report now opens with one request instead of four; the work done went up.

**Burst** (2,970 requests at the same instant): 0 failed both times, all answered in about 15.5 s both times; a fetch inside the burst took 4.8 s instead of 10.5 s.

**Not better yet:** building an HTML report or emailing HTML reports still has a slow tail (p99 up to the 60 s timeout, 2–3 of ~170 each run, before and after), waiting behind everything else in the Checkmarx One queue.

**Compression, measured** (bytes on the wire):

| Reply | Plain | gzip | brotli |
| --- | --- | --- | --- |
| Opening the page (script, styles, HTML) | 426 KB | 110 KB | 106 KB |
| Fetch stream, 200 projects | 445 KB | 105 KB | 11 KB |
| Full fetch result, 200 projects | 241 KB | 8 KB | 4.5 KB |

Compressing *every* reply was tried and measured first: on 2 vCPU it cost more CPU than it saved on the hundreds of small report polls a second, and page latency at p99 rose to about 10 s. Hence the 32 KB threshold (`HTTP_COMPRESSION_MIN_KB`). Behind a reverse proxy that compresses, `HTTP_COMPRESSION=off` leaves it to the proxy.

## Results (MZ-01.00.06)

### Summary

| Run | Burst: failed / requests | Burst: report-poll p95 | Sustained: requests/s | Sustained: failed | Server CPU avg / peak | Memory peak |
| --- | --- | --- | --- | --- | --- | --- |
| **2 vCPU** (server pinned to 2 cores) | **0 / 2,970** | 4.4 s | **518/s** | 1 of 66,116 | 86% / 124% of one core | 1.19 GB |
| 1 vCPU | 0 / 2,970 | 6.2 s | 499/s | 6 of 65,110 | 81% / 99% | 1.14 GB |
| 4 vCPU shared with the generator | 0 / 2,970 | 7.1 s | 514/s | 4 of 65,904 | 86% / 136% | 1.14 GB |
| 2 vCPU, slower tenant (250 ms a call) | 0 / 2,970 | 8.8 s | 359/s | 17 of 58,252 | 54% / 127% | 1.15 GB |

**With a slower tenant (250 ms a call instead of 80 ms)**
- The server was *less* busy: 54% CPU on average. Its health check still answered in 53 ms (p95).
- Everything that waits on Checkmarx One took about three times longer:
  - a full fetch took 2 minutes;
  - Refresh & verify took 26 s;
  - an HTML report took 18 s (p50).
- Report polls answered "busy, retry" more often (the admission control keeping the server responsive). They still answered in 6 ms (p50).
- 17 requests (0.03%) hit the 60-second timeout: 12 remediation-detail look-ups and 5 report or reminder emails. All of them sat in the Checkmarx One queue behind 45 people re-fetching the whole tenant.

**So the size of the server is not what decides speed against a slow tenant.** The Checkmarx One call budget and how often people re-fetch do.

### Sustained load on 2 vCPU: 3000 users, 128 s, 518 requests/s

| Operation | Requests | p50 | p95 | p99 | Failed |
| --- | --- | --- | --- | --- | --- |
| Report: triage results (poll) | 35,965 | 6 ms | 565 ms | 1.7 s | 0 |
| Report: remediation state | 13,232 | 6 ms | 93 ms | 4.4 s | 0 |
| Credits: balances | 3,235 | 10 ms | 122 ms | 285 ms | 0 |
| Report: connect | 2,400 | 73 ms | 157 ms | 4.4 s | 0 |
| Report: credits | 2,400 | 75 ms | 4.4 s | 5.3 s | 0 |
| Page: who am I / settings / health | 4,266 | 8 ms | 108 ms | 214 ms | 0 |
| Credits: usage analytics | 1,072 | 12 ms | 113 ms | 269 ms | 0 |
| Tracked reports: list | 1,102 | 8 ms | 125 ms | 230 ms | 0 |
| Report: triage (5 findings) | 480 | 83 ms | 4.4 s | 5.7 s | 0 |
| Report: remediation details | 400 | 4 ms | 1.3 s | 2.2 s | 0 |
| Tracked report: refresh | 184 | 3.2 s | 10.6 s | 12.6 s | 0 |
| Reminder: email initiators | 181 | 371 ms | 15.5 s | 59.6 s | 1 (timeout) |
| Dashboard: build HTML report | 179 | 2.7 s | 10.3 s | 27.5 s | 0 |
| Reminder: HTML report to initiators | 179 | 3.0 s | 10.5 s | 37.5 s | 0 |
| Credits: Refresh & verify (2 reads) | 165 | 3.9 s | 8.1 s | 8.2 s | 0 |
| Dashboard: triage now | 160 | 1.4 s | 4.0 s | 4.6 s | 0 |
| Report: remediate | 120 | 985 ms | 5.2 s | 7.0 s | 0 (117 refused: not confirmed) |
| Fetch: whole tenant, streamed | 108 | 27 s | 35 s | 39 s | 0 |
| Admin: metrics, audit integrity, log, backups | 107 | 5–64 ms | 30–149 ms | ≤185 ms | 0 |

Other figures from the same run:
- **Mail:** 1,050 emails were sent.
- **Checkmarx One:**
  - 38,497 calls in total, never more than 25 at once.
  - 2,202 results were sent for triage, each exactly once.
- **Responsiveness:** the server's health check answered in 6 ms (p50), 92 ms (p95) and 4.3 s at worst.

### Burst on 2 vCPU: 2,970 requests at the same instant

- All were answered in 16.4 s, and none failed.
- Report polls took 2.2 s (p50) and 4.4 s (p95). 135 of them were told "busy, retry" and got their answer on retry.
- Signed-in page requests took 0.6–1.0 s.
- Fetches took 10 s.

## What limits it

1. **Checkmarx One, not the server.**
   - At most 24 calls go to Checkmarx One at a time (`CX_MAX_CONCURRENCY`).
   - Everything that needs fresh data from it waits its turn: fetches, verification, tracked-report refreshes, HTML reports, triage.
   - With 45 people re-fetching a 12,000-finding tenant every 30 seconds, that queue sets the 10–40 s times above. More CPU does not shorten it. A tenant that allows more concurrent calls does (see *Tuning*).
2. **One process, about one core.**
   - The server is one Node.js process. Peak CPU was 1.2–1.4 cores (the main thread, plus garbage collection and I/O threads).
   - Going from 1 to 2 vCPU cut failures from 6 to 1 and burst waits by 30–55%.
   - A third or fourth vCPU helps only if the same VM also runs TLS termination, a reverse proxy or a mail relay.
3. **Memory follows signed-in sessions × tenant size.**
   - Each session keeps its last fetch in memory, so reminders and reports match exactly what that person saw.
   - With 21 sessions holding 12,000 findings each, plus shared caches, the peak was about 1.2 GB.
   - Allow roughly 50 MB per signed-in session per 10,000 findings, plus 500 MB.
4. **Event-loop pauses during storms.**
   - When 2,400 reports connect within the same few seconds, and fetch results are being assembled, the slowest requests wait up to 4–7 s.
   - None failed: the relay's admission control answers "busy, retry" instead of queueing without limit.

## Recommended size

| Load | vCPU | RAM | Container limits | Notes |
| --- | --- | --- | --- | --- |
| Small: ≤300 open reports, ≤10 Dashboard users, ≤5,000 findings | 1 | 1–2 GB | `--cpus 1 --memory 1g` | |
| **Up to 3000 people at once** (this benchmark): ≤20 people fetching, ≤20,000 findings | **2** | **4 GB** | `--cpus 2 --memory 3g`, heap 2 GB | For example: AWS c6i.large / t3.medium; Azure D2s v5 / B2s; GCP e2-medium / e2-standard-2. |
| Larger: >3000 people, >50 Dashboard users, or >50,000 findings | 4 | 8 GB | `--cpus 4 --memory 6g`, heap 4 GB | Raise `CX_MAX_CONCURRENCY` if the tenant allows it. |

**Everywhere**
- **Disk:** 10 GB for the `/data` volume. Settings, users, the credit ledger, the audit log and backups are small, but the audit log grows with use.
- **Network:** one HTTPS route to Checkmarx One (up to ~300 calls/s at this load) and one to the mail server. Readers' reports reach the server over HTTPS: the container serves it by default; give it your certificate or put a reverse proxy in front ([HTTPS and hosting](https-and-hosting.md)).
- **One instance per data folder.** Credits, the ledger and the duplicate-send guard live in one process. To serve more, give that instance more resources (scale up), or run separate instances for separate tenants or business units, each with its own volume. Never run two copies on one volume.

### Podman: run it at the recommended size (2 vCPU, 4 GB host)

Windows cmd, one line:

```
podman run -d --name mission-zero -p 3000:3000 -v mission-zero-data:/data -e TZ=Asia/Dubai -e NODE_OPTIONS=--max-old-space-size=2048 --cpus 2 --memory 3g --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

**Option notes**
- `--memory 3g` caps the container below the host's RAM.
- `--max-old-space-size=2048` keeps the JavaScript heap within that cap, with room for Node's other memory.
- On Podman for Windows/macOS, the Podman machine needs at least that much: `podman machine set --cpus 2 --memory 4096` (with the machine stopped).

## Tuning

| Variable | Default | When to change it |
| --- | --- | --- |
| `CX_MAX_CONCURRENCY` | 24 | Calls to Checkmarx One at once. Raise it (e.g. 48) only if your tenant's rate limits allow; it shortens fetch, verify and report times under load. |
| `CX_FETCH_CONCURRENCY` | 10 | Projects read at once by one fetch. |
| `CX_PAGES_AT_ONCE` | 4 | Pages of one big project read at once, once its size is known. |
| `HTTP_COMPRESSION`, `HTTP_COMPRESSION_MIN_KB` | on, 32 | Compress replies of at least this many KB (brotli or gzip). `off` when a reverse proxy compresses. |
| `CX_FETCH_CACHE_SECONDS` | 120 | How long a project someone fetched is reused by the next fetch on the same key (see [How it works](how-it-works.md)). Longer means fewer calls and staler states; `0` reads everything every time. |
| `SESSION_SAVE_SECONDS` | 30 | How often, at most, a person's changing fetched data is saved to disk (the first save is at once). Lower is closer to the last second after a crash; higher saves more CPU. |
| `RELAY_MAX_IN_FLIGHT` | 300 | Report requests handled at once before answering "busy, retry". Raise it on 4 vCPU. |
| `RELAY_BACKGROUND_QUEUE` | 2000 | Background lookups allowed to queue. |
| `NODE_OPTIONS=--max-old-space-size=N` | Node's default | About two-thirds of the container's memory limit, in MB. |

`GET /api/metrics` shows the following live:
- relay load (in flight, peak, shed);
- cache hit rate;
- the Checkmarx One queue.

The troubleshooting log on the Logs page records any operation that is getting slow or failing.

## Run it yourself

```bash
loadtest/benchmark.sh 3000 120                                      # 3000 users for 120 s
SERVER_CPUS=0-1 GEN_CPUS=2-3 loadtest/benchmark.sh 3000 120         # server pinned to 2 CPUs
LAT=250 PROJECTS=500 loadtest/benchmark.sh 3000 120                 # slower, larger tenant
BENCH_OUT=result.json LABEL="my VM" loadtest/benchmark.sh 1000 60   # keep the full results
```

**What it prints**
- One table per phase: requests, p50/p95/p99/max, failures, refusals and "busy" retries for each operation.
- Server CPU, memory and health-check latency.
- Emails sent.
- Checkmarx One calls, and the most times any finding was sent for triage.

**Exit code:** non-zero if any finding was sent twice. `loadtest/run.sh` is the earlier, report-relay-only test.
