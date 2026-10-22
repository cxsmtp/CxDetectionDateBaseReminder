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
| **MZ-01.00.59** | 1 | 10.3 s / 0 | 63,841 / **0** | **513** | 64 / **6,162 ms** | 9 / **229 ms** | none |
| MZ-01.00.58 (main) | 1 | 10.1 s / 0 | 63,584 / 0 | 518 | 75 / 6,451 ms | 8 / 214 ms | none |
| MZ-01.00.61 | 1 | 9.2 s / 0 | 62,554 / 42 | 511 | 93 / 9,498 ms | 15 / 613 ms | none |
| MZ-01.00.60 (main) | 1 | 12.1 s / 0 | 63,009 / 0 | 508 | 122 / 7,176 ms | 15 / 575 ms | none |
| **MZ-01.00.61** | 2 | 10.0 s / 0 | 63,041 / **0** | **505** | 83 / **7,702 ms** | 19 / **426 ms** | none |
| **MZ-01.00.60** | 1 | 9.5 s / 0 | 62,998 / **0** | **505** | 110 / **6,946 ms** | 17 / **501 ms** | none |
| MZ-01.00.59 (main) | 1 | 10.6 s / 0 | 62,962 / 0 | 499 | 103 / 7,948 ms | 15 / 545 ms | none |
| MZ-01.00.61 (main) | 1 | 11.5 s / 0 | 61,188 / 199 | 483 | 88 / 12,576 ms | 24 / 1,189 ms | none |
| MZ-01.00.62 | 1 | 11.1 s / 0 | 62,039 / 0 | 493 | 93 / 9,003 ms | 22 / 1,140 ms | none |
| MZ-01.00.61 (main) | 2 | 11.8 s / 0 | 62,508 / 0 | 509 | 95 / 7,558 ms | 20 / 1,172 ms | none |
| **MZ-01.00.62** | 2 | 9.6 s / 0 | 62,833 / **0** | **501** | 70 / **7,315 ms** | 21 / **586 ms** | none |
| MZ-01.00.62 (main) | 1 | 19.0 s / 117 | 52,257 / 793 | 398 | 159 / 32,951 ms | 53 / 11,603 ms | none |
| MZ-01.00.63 | 1 | 17.8 s / 6 | 52,741 / 702 | 397 | 133 / 27,444 ms | 58 / 12,303 ms | none |
| MZ-01.00.62 (main) | 2 | 14.5 s / 0 | 52,437 / 585 | 394 | 103 / 55,486 ms | 48 / 11,603 ms | none |
| **MZ-01.00.63** | 2 | 11.8 s / 0 | 54,656 / **203** | **415** | 88 / **18,606 ms** | 47 / **10,883 ms** | none |
| MZ-01.00.63 (main) | 1 | 11 s / 0 | 63,791 / 0 | 521 | 65 / 6,428 ms | 10 / 217 ms | none |
| **MZ-01.00.64** | 1 | 8.5 s / 0 | 63,687 / **0** | **526** | 57 / **5,909 ms** | 9 / **246 ms** | none |
| MZ-01.00.64 (main) | 5 | 10.9 s / 0 | 64,047 / 0 | 520 | 76 / 5,395 ms | 8 / 185 ms | none |
| **MZ-01.00.65** | 5 | 9.2 s / 0 | 63,871 / **0** | **511** | 58 / **4,962 ms** | 8 / **276 ms** | none |
| MZ-01.00.65 (main) | 1 | 11.2 s / 0 | 62,959 / 0 | 501 | 99 / 7,830 ms | 14 / 630 ms | none |
| MZ-01.00.66 | 1 | 12 s / 0 | 62,618 / 39 | 505 | 81 / 8,394 ms | 13 / 845 ms | none |
| **MZ-01.00.66** | 2 | 10 s / 0 | 63,664 / **0** | **514** | 62 / **6,090 ms** | 9 / **243 ms** | none |
| MZ-01.00.66 (main) | 1 | 11.3 s / 0 | 62,252 / 31 | 495 | 95 / 9,068 ms | 16 / 892 ms | none |
| MZ-01.00.67 | 1 | 12.2 s / 0 | 62,068 / 18 | 493 | 77 / 11,002 ms | 19 / 939 ms | none |
| MZ-01.00.66 (main) | 2 | 9.7 s / 0 | 62,824 / 0 | 505 | 77 / 8,962 ms | 14 / 571 ms | none |
| **MZ-01.00.67** | 2 | 9.9 s / 0 | 62,978 / **0** | **508** | 90 / **6,697 ms** | 14 / **816 ms** | none |
| MZ-01.00.67 (main) | 1 | 17.3 s / 0 | 60,490 / 272 | 468 | 129 / 16,633 ms | 19 / 1,418 ms | none |
| MZ-01.00.68 | 1 | 9.8 s / 0 | 62,256 / 0 | 482 | 93 / 7,361 ms | 29 / 1,209 ms | none |
| MZ-01.00.67 (main) | 2 | 9.7 s / 0 | 62,393 / 0 | 487 | 187 / 7,721 ms | 26 / 792 ms | none |
| **MZ-01.00.68** | 2 | 11.0 s / 3 | 62,619 / **0** | **486** | 97 / **7,946 ms** | 21 / **984 ms** | none |
| MZ-01.00.68 (main) | 1 | 9.7 s / 0 | 62,144 / 0 | 497 | 87 / 11,527 ms | 16 / 706 ms | none |
| **MZ-01.00.69** | 1 | 10.7 s / 0 | 62,786 / **0** | **497** | 75 / **7,542 ms** | 22 / **784 ms** | none |
| MZ-01.00.69 (main) | 1 | 10.5 s / 0 | 63,245 / 0 | 500 | 71 / 7,677 ms | 12 / 344 ms | none |
| **MZ-01.00.70** | 1 | 8.9 s / 0 | 63,237 / **0** | **511** | 76 / **6,708 ms** | 13 / **452 ms** | none |
| MZ-01.00.70 (main) | 1 | 10 s / 0 | 63,028 / 0 | 503 | 73 / 6,837 ms | 14 / 597 ms | none |
| MZ-01.00.71 | 1 | 10.3 s / 0 | 62,541 / 13 | 491 | 80 / 8,586 ms | 16 / 827 ms | none |
| MZ-01.00.71 | 2 | 16 s / 0 | 62,481 / 0 | 501 | 78 / 9,698 ms | 16 / 775 ms | none |
| MZ-01.00.71 | 3 | 16 s / 0 | 63,205 / 0 | 497 | 69 / 6,772 ms | 14 / 619 ms | none |
| MZ-01.00.70 (main) | 2 | 9.4 s / 0 | 62,560 / 0 | 487 | 65 / 9,452 ms | 13 / 656 ms | none |
| **MZ-01.00.71** | 4 | 9.4 s / 0 | 62,804 / **0** | **488** | 73 / **8,921 ms** | 15 / **627 ms** | none |
| MZ-01.00.71 (main) | 1 | 10.1 s / 0 | 63,105 / 0 | 501 | 72 / 6,144 ms | 16 / 828 ms | none |
| MZ-01.00.72 | 1 | 9.6 s / 0 | 62,289 / 25 | 486 | 68 / 9,655 ms | 17 / 959 ms | none |
| MZ-01.00.72 | 2 | 10 s / 0 | 61,281 / 45 | 476 | 92 / 11,943 ms | 19 / 1,430 ms | none |
| MZ-01.00.71 (main) | 2 | 10.2 s / 0 | 62,380 / 0 | 495 | 67 / 8,103 ms | 17 / 944 ms | none |
| **MZ-01.00.72** | 3 | 10.6 s / 0 | 62,624 / **0** | **486** | 70 / **7,951 ms** | 18 / **1,042 ms** | none |
| MZ-01.00.71 (main) | 3 | 10.6 s / 0 | 62,758 / 0 | 503 | 60 / 8,918 ms | 15 / 574 ms | none |
| MZ-01.00.72 (main) | 1 | 10.4 s / 0 | 62,194 / 10 | 497 | 72 / 9,219 ms | 14 / 1,080 ms | none |
| MZ-01.00.73 | 1 | 12.5 s / 0 | 63,131 / 0 | 507 | 78 / 6,788 ms | 13 / 615 ms | none |
| MZ-01.00.73 (main) | 1 | 11 s / 0 | 63,513 / 0 | 514 | 64 / 6,510 ms | 13 / 344 ms | none |
| MZ-01.00.74 | 1 | 17.1 s / 0 | 62,966 / 0 | 513 | 61 / 9,104 ms | 15 / 647 ms | none |
| MZ-01.00.74 | 2 | 9.4 s / 0 | 62,373 / 0 | 498 | 70 / 9,076 ms | 17 / 767 ms | none |
| MZ-01.00.73 (main) | 2 | 10.9 s / 0 | 63,288 / 0 | 519 | 61 / 5,424 ms | 13 / 717 ms | none |
| **MZ-01.00.74** | 3 | 10.5 s / 0 | 63,714 / **0** | **514** | 55 / **5,870 ms** | 12 / **252 ms** | none |
| MZ-01.00.74 (main) | 1 | 11.2 s / 0 | 60,785 / 145 | 478 | 239 / 11,172 ms | 23 / 2,232 ms | none |
| MZ-01.00.75 (first build) | 1 | 10.2 s / 0 | 61,266 / 326 | 488 | 82 / 11,855 ms | 22 / 1,077 ms | none |
| MZ-01.00.74 (main) | 2 | 10.5 s / 0 | 61,020 / 138 | 482 | 86 / 13,962 ms | 22 / 1,209 ms | none |
| MZ-01.00.75 (first build) | 2 | 9.3 s / 0 | 61,029 / 7 | 475 | 86 / 9,773 ms | 27 / 2,274 ms | none |
| MZ-01.00.74 (main) | 3 | 11.5 s / 0 | 61,151 / 74 | 486 | 70 / 15,501 ms | 23 / 1,099 ms | none |
| MZ-01.00.75 (first build) | 3 | 11 s / 0 | 61,505 / 8 | 487 | 69 / 9,810 ms | 25 / 1,556 ms | none |
| **MZ-01.00.75** | 4 | 10 s / 0 | 61,867 / **3** | **492** | 67 / **10,480 ms** | 26 / **1,111 ms** | none |
| MZ-01.00.75 | 5 | 9.4 s / 0 | 61,511 / 36 | 486 | 68 / 13,188 ms | 23 / 1,118 ms | none |
| MZ-01.00.74 (main) | 4 | 11.3 s / 0 | 62,180 / 0 | 482 | 76 / 8,512 ms | 21 / 1,310 ms | none |
| MZ-01.00.75 (main) | 1 | 12.8 s / 0 | 60,439 / 198 | 470 | 149 / 13,536 ms | 26 / 1,937 ms | none |
| **MZ-01.00.76** | 1 | 11.4 s / 0 | 61,900 / **0** | **506** | 89 / **9,348 ms** | 24 / **1,225 ms** | none |
| MZ-01.00.76 (main) | 1 | 13.4 s / 0 | 61,040 / 186 | 487 | 252 / 11,644 ms | 21 / 1,594 ms | none |
| MZ-01.00.77 | 1 | 10 s / 0 | 62,083 / 49 | 497 | 76 / 9,563 ms | 21 / 1,259 ms | none |
| MZ-01.00.77 | 2 | 15.7 s / 0 | 61,668 / 43 | 499 | 86 / 12,875 ms | 21 / 1,087 ms | none |
| MZ-01.00.76 (main) | 2 | 12.2 s / 0 | 62,390 / 10 | 504 | 75 / 10,340 ms | 15 / 607 ms | none |
| **MZ-01.00.77** | 3 | 12.4 s / 0 | 62,527 / **0** | **510** | 77 / **10,206 ms** | 17 / **529 ms** | none |
| MZ-01.00.77 (main) | 1 | 14.1 s / 0 | 62,447 / 0 | 499 | 90 / 7,344 ms | 20 / 1,384 ms | none |
| MZ-01.00.78 | 1 | 9.2 s / 0 | 61,468 / 60 | 483 | 95 / 10,855 ms | 26 / 1,398 ms | none |
| MZ-01.00.78 | 2 | 11.4 s / 0 | 61,206 / 73 | 480 | 89 / 12,049 ms | 27 / 1,593 ms | none |
| MZ-01.00.77 (main) | 2 | 9.1 s / 0 | 62,555 / 22 | 497 | 80 / 8,273 ms | 20 / 768 ms | none |
| MZ-01.00.77 (main) | 3 | 9.4 s / 0 | 62,567 / 0 | 494 | 53 / 6,606 ms | 30 / 1,365 ms | none |
| **MZ-01.00.78** | 3 | 11.1 s / 0 | 62,100 / **4** | **495** | 56 / **10,214 ms** | 25 / **1,029 ms** | none |
| MZ-01.00.78 (main) | 1 | 16.7 s / 0 | 59,901 / 240 | 465 | 101 / 18,704 ms | 36 / 2,420 ms | none |
| MZ-01.00.79 | 1 | 10.6 s / 0 | 61,596 / 62 | 490 | 79 / 11,328 ms | 27 / 1,273 ms | none |
| MZ-01.00.79 | 2 | 16.4 s / 0 | 60,734 / 117 | 478 | 86 / 14,331 ms | 28 / 1,516 ms | none |
| MZ-01.00.78 (main) | 2 | 11.9 s / 0 | 61,176 / 0 | 479 | 84 / 12,294 ms | 30 / 2,272 ms | none |
| MZ-01.00.78 (main) | 3 | 11.4 s / 0 | 61,365 / 0 | 483 | 73 / 13,019 ms | 29 / 1,220 ms | none |
| **MZ-01.00.79** | 3 | 11.3 s / 0 | 61,909 / **0** | **472** | 91 / **8,965 ms** | 34 / **1,610 ms** | none |
| MZ-01.00.79 (main) | 1 | 9.8 s / 0 | 60,828 / 85 | 476 | 91 / 13,266 ms | 33 / 1,721 ms | none |
| MZ-01.00.80 | 1 | 10.1 s / 15 | 62,068 / 0 | 487 | 78 / 8,479 ms | 26 / 1,169 ms | none |
| **MZ-01.00.80** | 2 | 10.5 s / 0 | 61,559 / **0** | **488** | 65 / **9,608 ms** | 24 / **1,755 ms** | none |
| MZ-01.00.79 (main) | 2 | 10.7 s / 0 | 60,900 / 38 | 477 | 81 / 10,495 ms | 33 / 1,955 ms | none |
| MZ-01.00.80 (main) | 1 | 19.3 s / 0 | 45,297 / 1,696 | 330 | 210 / 60,001 ms | 66 / 22,453 ms | none |
| MZ-01.00.81 | 1 | 15.5 s / 60 | 47,260 / 1,396 | 342 | 157 / 55,402 ms | 65 / 20,620 ms | none |
| MZ-01.00.81 | 2 | 18.6 s / 0 | 46,705 / 1,359 | 327 | 161 / 60,001 ms | 72 / 20,611 ms | none |
| MZ-01.00.80 (main) | 2 | 13.7 s / 0 | 44,942 / 1,609 | 318 | 254 / 60,001 ms | 83 / 22,964 ms | none |
| MZ-01.00.81 | 3 | 18.7 s / 0 | 48,099 / 1,388 | 345 | 108 / 33,314 ms | 78 / 14,207 ms | none |
| MZ-01.00.80 (main) | 3 | 17.9 s / 10 | 46,314 / 1,691 | 333 | 156 / 60,001 ms | 82 / 21,988 ms | none |
| MZ-01.00.81 (main) | 1 | 12.1 s / 0 | 61,828 / 104 | 503 | 85 / 13,368 ms | 18 / 777 ms | none |
| MZ-01.00.82 | 1 | 9.2 s / 0 | 61,570 / 48 | 484 | 66 / 10,867 ms | 20 / 1,278 ms | none |
| MZ-01.00.81 (main) | 2 | 10.6 s / 0 | 62,286 / 0 | 490 | 66 / 7,559 ms | 21 / 1,409 ms | none |
| MZ-01.00.82 | 2 | 9.0 s / 0 | 62,166 / 0 | 485 | 71 / 8,946 ms | 20 / 1,038 ms | none |
| MZ-01.00.81 (main) | 3 | 16.5 s / 0 | 62,624 / 0 | 489 | 77 / 8,907 ms | 21 / 960 ms | none |
| **MZ-01.00.82** | 3 | 9.1 s / 0 | 61,523 / **0** | **492** | 71 / **9,640 ms** | 23 / **1,474 ms** | none |
| MZ-01.00.82 (main) | 1 | 10.6 s / 0 | 63,712 / 0 | 525 | 84 / 5,819 ms | 13 / 313 ms | none |
| MZ-01.00.83 | 1 | 9.2 s / 0 | 62,944 / 0 | 520 | 74 / 7,526 ms | 16 / 463 ms | none |
| MZ-01.00.82 (main) | 2 | 9.9 s / 0 | 63,918 / 0 | 519 | 44 / 5,179 ms | 10 / 284 ms | none |
| **MZ-01.00.83** | 2 | 9.4 s / 0 | 64,265 / **0** | **521** | 59 / **2,115 ms** | 9 / **205 ms** | none |
| MZ-01.00.83 (main) | 1 | 10.4 s / 0 | 63,567 / 0 | 497 | 64 / 6,120 ms | 13 / 551 ms | none |
| **MZ-01.00.84** | 1 | 8.5 s / 0 | 63,216 / **0** | **502** | 56 / **6,683 ms** | 14 / **593 ms** | none |
| MZ-01.00.84 (main) | 1 | 9.9 s / 0 | 63,104 / 0 | 512 | 66 / 7,744 ms | 12 / 480 ms | none |
| MZ-01.00.85 (first build) | 1 | 8.7 s / 0 | 63,198 / 0 | 506 | 80 / 7,928 ms | 14 / 473 ms | none |
| MZ-01.00.84 (main) | 2 | 9.1 s / 0 | 64,087 / 0 | 516 | 49 / 4,602 ms | 11 / 187 ms | none |
| MZ-01.00.85 (first build) | 2 | 9.8 s / 0 | 63,384 / 0 | 499 | 52 / 8,277 ms | 13 / 466 ms | none |
| MZ-01.00.85 | 3 | 9.2 s / 0 | 63,691 / **0** | **513** | 49 / **6,176 ms** | 11 / **331 ms** | none |
| MZ-01.00.84 (main) | 3 | 16.4 s / 0 | 63,995 / 0 | 520 | 48 / 5,679 ms | 8 / 152 ms | none |
| **MZ-01.00.85** | 4 | 9.6 s / 0 | 63,463 / **0** | **498** | 68 / **6,319 ms** | 12 / **463 ms** | none |
| MZ-01.00.84 (main) | 4 | 9.3 s / 0 | 63,850 / 0 | 491 | 48 / 5,496 ms | 9 / 220 ms | none |
| MZ-01.00.85 (slow host) | 5 | 17.2 s / 88 | 46,062 / 1,705 | 309 | 126 / 60,005 ms | 88 / 16,848 ms | none |
| MZ-01.00.84 (main, slow host) | 5 | 18.8 s / 47 | 47,200 / 1,130 | 327 | 102 / 60,001 ms | 63 / 19,067 ms | none |
| MZ-01.00.84 (main, slow host) | 6 | 12.9 s / 0 | 50,140 / 1,011 | 338 | 95 / 60,001 ms | 58 / 16,882 ms | none |
| MZ-01.00.85 (slow host) | 6 | 13.9 s / 0 | 55,159 / 531 | 425 | 100 / 27,413 ms | 61 / 8,189 ms | none |
| MZ-01.00.85 (main, slow host) | 1 | 16.2 s / 0 | 45,189 / 2,336 | 278 | 124 / 60,000 ms | 78 / 24,598 ms | none |
| MZ-01.00.86 (first build, slow host) | 1 | 20.1 s / 0 | 45,279 / 2,266 | 285 | 194 / 60,002 ms | 89 / 19,081 ms | none |
| **MZ-01.00.86** (slow host) | 2 | 16.5 s / 0 | 43,577 / **2,052** | **303** | 148 / **60,003 ms** | 79 / **24,079 ms** | none |
| MZ-01.00.85 (main, slow host) | 2 | 17.5 s / 4 | 50,148 / 1,201 | 375 | 123 / 60,001 ms | 68 / 10,444 ms | none |
| MZ-01.00.86 (main, overlapped by screenshots) | 1 | 14.2 s / 0 | 61,210 / 104 | 476 | 66 / 14,282 ms | 32 / 1,518 ms | none |
| MZ-01.00.87 | 1 | 12.1 s / 0 | 59,010 / 234 | 466 | 92 / 17,452 ms | 45 / 2,309 ms | none |
| MZ-01.00.86 (main) | 2 | 11.3 s / 0 | 60,469 / 89 | 470 | 85 / 11,621 ms | 32 / 2,257 ms | none |
| **MZ-01.00.87** | 2 | 8.7 s / 0 | 60,425 / **84** | **465** | 81 / **13,157 ms** | 29 / **1,791 ms** | none |
| MZ-01.00.87 (main) | 1 | 17.5 s / 0 | 60,298 / 197 | 473 | 76 / 14,027 ms | 28 / 1,986 ms | none |
| MZ-01.00.88 | 1 | 16.4 s / 0 | 59,405 / 210 | 445 | 79 / 15,687 ms | 40 / 2,391 ms | none |
| **MZ-01.00.88** | 2 | 13.0 s / 0 | 60,072 / **266** | **469** | 86 / **18,783 ms** | 28 / **1,915 ms** | none |
| MZ-01.00.87 (main) | 2 | 11.1 s / 0 | 58,662 / 394 | 456 | 82 / 17,320 ms | 37 / 3,173 ms | none |
| MZ-01.00.88 (main) | 1 | 12.5 s / 0 | 61,595 / 0 | 478 | 82 / 10,834 ms | 22 / 1,349 ms | none |
| MZ-01.00.89 (overlapped by the test suite) | 1 | 10.0 s / 0 | 60,832 / 52 | 487 | 69 / 11,948 ms | 25 / 1,980 ms | none |
| **MZ-01.00.89** | 2 | 15.7 s / 0 | 62,538 / **0** | **501** | 75 / **9,569 ms** | 16 / **644 ms** | none |
| MZ-01.00.88 (main) | 2 | 11.5 s / 0 | 63,092 / 0 | 502 | 59 / 7,172 ms | 18 / 563 ms | none |
| MZ-01.00.89 (main) | 1 | 11.1 s / 0 | 61,528 / 12 | 486 | 96 / 12,174 ms | 27 / 1,426 ms | none |
| MZ-01.00.90 | 1 | 10.8 s / 0 | 60,256 / 252 | 457 | 96 / 16,313 ms | 30 / 1,837 ms | none |
| MZ-01.00.90 | 2 | 12.6 s / 0 | 60,741 / 243 | 477 | 101 / 14,506 ms | 31 / 1,408 ms | none |
| MZ-01.00.89 (main) | 2 | 9.0 s / 0 | 62,579 / 0 | 494 | 77 / 8,718 ms | 24 / 930 ms | none |
| **MZ-01.00.90** | 3 | 8.6 s / 0 | 61,896 / **0** | **469** | 66 / **8,202 ms** | 38 / **1,604 ms** | none |
| MZ-01.00.90 | 4 | 16.6 s / 0 | 60,802 / 109 | 482 | 76 / 15,741 ms | 28 / 1,461 ms | none |
| MZ-01.00.89 (main) | 3 | 15.8 s / 0 | 60,233 / 298 | 455 | 84 / 17,446 ms | 30 / 1,523 ms | none |
| MZ-01.00.90 (main) | 1 | 13.4 s / 0 | 56,808 / 430 | 437 | 111 / 23,590 ms | 51 / 3,223 ms | none |
| **MZ-01.00.91** | 1 | 10.9 s / 0 | 59,008 / **45** | **461** | 83 / **14,227 ms** | 46 / **3,076 ms** | none |
| MZ-01.00.91 (main) | 1 | 13.3 s / 0 | 59,525 / 152 | 462 | 73 / 14,451 ms | 38 / 2,181 ms | none |
| **MZ-01.00.92** | 1 | 11.1 s / 0 | 60,364 / **153** | **479** | 83 / **16,043 ms** | 32 / **1,988 ms** | none |
| MZ-01.00.92 (main) | 1 | 10.9 s / 0 | 62,322 / 0 | 491 | 90 / 8,876 ms | 24 / 1,408 ms | none |
| **MZ-01.00.93** | 1 | 8.3 s / 0 | 63,363 / **0** | **509** | 61 / **5,545 ms** | 16 / **646 ms** | none |
| MZ-01.00.93 (main) | 1 | 11.9 s / 0 | 62,109 / 0 | 494 | 67 / 7,954 ms | 25 / 1,421 ms | none |
| MZ-01.00.94 (first run) | 1 | 15.1 s / 0 | 62,188 / 0 | 471 | 113 / 8,264 ms | 18 / 2,016 ms | none |
| **MZ-01.00.94** | 2 | 10.5 s / 0 | 63,403 / **0** | **513** | 56 / **6,810 ms** | 12 / **303 ms** | none |
| MZ-01.00.94 (main) | 1 | 12.2 s / 0 | 61,895 / 64 | 494 | 102 / 11,846 ms | 16 / 925 ms | none |
| **MZ-01.00.95** | 1 | 9.0 s / 0 | 63,023 / **0** | **511** | 66 / **6,971 ms** | 13 / **622 ms** | none |

**MZ-01.00.37: what the differences were.** Two pairs with main, alternating. Report opens at p95 were 4.1 and 5.1 s on the branch against 7.2 and 5.1 s on main; triage results 201 and 179 ms against 257 and 123 ms; requests a second 519 and 508 against 504 and 518, with 0 failed requests and no finding sent twice in any run. The first branch run's opening burst took 16.3 s, a little above the 7.4–15.8 s seen before, and its fetches were slower (17 s against 12 s at the median); in the second pair the burst took 9.9 s (main 8.0 s) and fetches matched main (13.5 s against 13.0 s at the median). What the fetch now does in addition is one pass over each project's findings to count what is past its SLA, which is a few microseconds a finding next to reading them from Checkmarx One. Escalation runs only on the automation's schedule, which the benchmark does not use.

**MZ-01.00.53: what the differences were.** One pair, main then branch, on a calm host, both with 0 failed. The branch served 527 requests a second against main's 524. Report opens took 330 ms against 4.7 s at p95, and triage polls 96 against 142 ms. The release adds Get help (its own routes and file, which the benchmark's people do not call), one field in the sign-in answer (`/api/me`) and one settings section. None of these is on the measured paths, so the faster tail is the host, not the change. No finding was sent twice.

**MZ-01.00.54: what the differences were.** Two pairs, alternating main and branch, all four with 0 failed requests and no finding sent twice. The branch served 523 and 515 requests a second, against main's 520 and 523. At p50 every operation matched main. At p95, report opens took 7.0 and 4.9 s on the branch against 4.2 and 4.0 s on main, and triage polls 212 and 191 ms against 244 and 125 ms. The same branch code gave 7.0 s and then 4.9 s, so this host's tail moves by 2 s from run to run. The slower tail is the host, not the change, because report opens never reach the changed code: they go to `/api/relay/hello`, which needs no sign-in. On signed-in routes the release adds one check of the person's own branding. The new per-request context (an `AsyncLocalStorage`) is never switched on unless someone has turned on their own branding, and nobody in the benchmark has. A first main run, made while tests were running alongside it, is left out: it had 12 failed requests at 509 a second. After the benchmark, `proxy-addr` moved from 2.0.7 to 2.0.8 for a security fix: a patch release that only changes how trusted proxy addresses are matched.

**MZ-01.00.55: what the differences were.** One pair, main then branch, both with 0 failed requests and no finding sent twice. The branch served 522 requests a second against main's 514. Report opens took 4.7 s at p95 (main 6.7 s), and triage polls 311 ms (main 333 ms). The release changes only the Activation codes page and adds one flag to the sign-in answer (`/api/me`), so nothing on the measured paths is slower.

**MZ-01.00.56: what the differences were.** Two pairs with main, all four with 0 failed requests and no finding sent twice. The first branch run was of an earlier draft, and tests ran alongside its last seconds, so it is shown but not used. On the final code the branch served 494 requests a second against main's 495 and 501. Report opens took 5.5 s at p95 against 7.1 and 6.7 s. Triage polls took 345 ms against 316 and 521 ms: within the spread of main's own runs.

What this release adds while the benchmark runs:
- **A self-check every 5 minutes.** It asks Checkmarx One one small question, connects to the mail server, and reads a counter.
- **A five-minute look at whether the weekly status is due.**

Nothing on the measured paths changed. The work done when the server stops (a backup, and the emails) happens after the benchmark ends.

**MZ-01.00.61: what the differences were.** Main first, then the branch twice; no finding was sent twice in any run. Main served 508 requests a second with 0 failed. The branch's first run served 511 a second but had 42 failed requests. They were spread over unrelated endpoints, the health check included, and all fell in one stall of up to 18 s, while the server's CPU stayed at its usual level: the host paused, as in MZ-01.00.58's pair. Run again, the branch served 505 a second with 0 failed. At p95, report opens took 7.7 s (main 7.2 s) and triage polls 426 ms (main 575 ms). The release adds the Credit projections page and its API, which the benchmark does not call; on the measured paths it adds one check per request, whether the page asked for may be framed.

**MZ-01.00.62: what the differences were.** Main and the branch twice each, in turn; no finding was sent twice in any run. Main's first run had 199 failed requests, spread over unrelated endpoints, the health check included, all in one stall of up to 17 s while the server's CPU stayed at its usual level: the host paused, as in earlier pairs. Run again, main served 509 requests a second with 0 failed. The branch's first run had 0 failed at 493 a second, but its report opens were slower at p95 (9.0 s against 7.6 s); its health check also stalled, for up to 14 s. Its second run, with no stall, served 501 a second with 0 failed, report opens at 7.3 s and triage polls at 586 ms at p95 (main 7.6 s and 1,172 ms). The release adds the Cx Credits Calculator's API, which the benchmark does not call; on the measured paths it adds only the organisation's name and whether the calculator is on to the "who am I" answer, and drops MZ-01.00.61's check on every request of whether the page asked for may be framed.

**MZ-01.00.66: what the differences were.** One pair, then the branch again. The branch's first run had 39 failed requests (26 triage polls, 10 report opens, 2 triages, 1 HTML report), every one a 15-second client timeout in its last half-minute: the project's test suite was started on the same machine while it ran, so it is not counted. Run again on its own, the release served 514 requests a second with 0 failed against main's 501, opened reports faster at p95 (6.1 s against 7.8 s) and answered triage polls faster (243 ms against 630 ms at p95); no finding was sent for triage twice. What changed for the server is how the credit checks read a scan's result ids: once, without code paths, 8 pages at a time, and kept 10 minutes per connection. With Checkmarx One answering in 0.8 s and 20,000 rows in a scan's result list, checking 2 projects took 6.6 s against main's 34.8 s, with 82 calls for result pages against 164. The new look and the Applications filter do not touch the server's hot paths.

**MZ-01.00.67: what the differences were.** Two pairs, main first each time, with nothing else running. In the first pair both sides had failed requests, main 31 and the branch 18. Every one was a 15-second client timeout, mostly on triage polls, and main's slower tail (report opens 9.1 s at p95) shows the host was busier than usual. In the second pair both served every request: the release did 508 requests a second against main's 505, and opened reports faster at p95 (6.7 s against 9.0 s). Triage polls were 816 ms against 571 ms at p95, with the same 14 ms median, and no finding was sent for triage twice. This release changes the Cx Credits Calculator, which the benchmark does not call. It adds two routes: one adds up the weekly series of the projects a customer narrows to, from the last read, and one emails a projection report. Each runs only when someone with the calculator's permission clicks, and neither touches the report, triage or fetch paths the load exercises.

**MZ-01.00.68: what the differences were.** Two pairs, main first each time, with nothing else running. In the first pair main had 272 failed requests and a slow tail (report opens 16.6 s at p95, the opening burst 17.3 s), while the release served every request (482 a second, opens 7.4 s at p95); the host was busier while main ran. In the second pair both served every sustained request, 486 a second against main's 487, with report opens at 7.9 s against 7.7 s and triage polls at 984 ms against 792 ms at p95. The release's opening burst had 3 failed requests of 2,970: triage polls that reached the 15-second client timeout while every request arrived at once, the same kind main lost 114 of in its first pair. This release changes which certificate authorities outgoing HTTPS trusts. The list is read once at start-up and applied to Node's TLS defaults, and it is consulted again only when a connection fails on a certificate. No request the benchmark makes passes through it. No finding was sent for triage twice.

**MZ-01.00.69: what the differences were.** One pair, main first, on a quiet host. A first pair was thrown away: a test server left running from an earlier screenshot run was using a whole core throughout, and both sides suffered alike. In the clean pair both served every request at 497 a second, with no finding sent for triage twice. The release opened reports faster at p95 (7.5 s against 11.5 s) and kept its worst case lower (11.4 s against 31.4 s); triage polls were 784 ms against 706 ms at p95, with medians of 22 and 16 ms. The opening burst took 10.7 s against 9.7 s. This release adds the proxy settings (read once when the server starts), the network check and sheet (only when an administrator asks), each person's own Impact figures (a few numbers merged into the Impact page's settings), and calculator changes that run in the browser, the PDF included. None of them is on the report, triage or fetch paths the load exercises.

**MZ-01.00.73: what the differences were.** One pair, main first, with nothing else running. This release changes only the release workflow; the server's code is the same as MZ-01.00.72's. Even so, main had 10 failed triage polls (report opens 9.2 s at p95) and the release none (507 a second, report opens 6.8 s, triage polls 615 ms), with the opening burst 12.5 s against 10.4 s: the same code failing in one run and not the next, which is what MZ-01.00.72's failed runs were too. No finding was sent for triage twice.

**MZ-01.00.76: what the differences were.** One pair, main then the release. The release changes only the Cx Credits Calculator's page (its Fusion projects table sorts by any column) and nothing the server runs, so the two serve the same code. Main's run met a host stall (the health check waited 30 s) and failed 198 requests, all timed out triage polls and report hellos during it; the release's run, straight after, served 506 a second with none failed, opened reports in 9.3 s at p95 (main 13.5 s) and answered triage polls in 1.2 s (main 1.9 s). No finding was sent for triage twice.

**MZ-01.00.77: what the differences were.** Two pairs with main, alternating, then one more run of the release. The release adds the next-gen look: a stylesheet and fonts the browser loads, and, on the server, the reader's look written into the interactive report as it is built. The polls, report hellos and credit reads that make up most of the load run the same code as main. Every one of the five runs met host stalls (the health check answered in about 130 ms at p95 but waited 8.6 to 15.9 s at its slowest), and the failed requests (main 186 and 10, the release 49 and 43) are triage polls, report hellos and credit reads that timed out during them, on main and the release alike. The third run of the release served 510 a second with none failed, opened reports in 10.2 s at p95 (main 11.6 and 10.3 s) and answered triage polls in 529 ms (main 1.6 s and 607 ms). No finding was sent for triage twice.

**MZ-01.00.78: what the differences were.** Three pairs with main: main, the release, the release, main, then main and the release once more. The release adds forgotten-password links, Admins editing profiles and the sign-in policy, none of which the load test calls, and keeps a shared result's rows together when an interactive report is built; the report hellos, triage polls and credit reads that make up the load run the same code as main (the diff does not touch them). The first two runs of the release met the longest host stalls of the six (the health check waited 18.3 and 18.7 s at its slowest, against 3.6, 13.4 and 6.5 s on main's runs), and their 60 and 73 failed requests are triage polls, report hellos and credit reads that timed out in them, as main's 22 did in its second run. In the last pair the release served 495 a second to main's 494, with 4 failed against none, and answered triage polls faster at p95 (1.0 s against 1.4 s). Report opens at p95 stayed slower on the release in every pair (10.2 to 12.0 s against 6.6 to 8.3 s): that number is the slowest twentieth of the 2,400 opens, which come in bursts and so take the stalls first, and the request behind it is unchanged; it is the one to watch in the next release. No finding was sent for triage twice.

**MZ-01.00.82: what the differences were.** Three pairs with main (main, then the release, three times), on a host back to its usual speed after MZ-01.00.81's slow day. The release served 484, 485 and 492 requests a second against main's 503, 490 and 489, with 48, 0 and 0 failed against 104, 0 and 0: the failures in the first pair, on both sides, are report hellos and triage polls that timed out during host stalls (the health check waited up to 17 s on main and 30 s on the release). Report opens at p95 were 10.9, 8.9 and 9.6 s against 13.4, 7.6 and 8.9 s; triage results 1.3, 1.0 and 1.5 s against 0.8, 1.4 and 1.0 s; the opening burst of 2,970 requests finished faster on the release in all three pairs (9.0 to 9.2 s against 10.6 to 16.5 s). These swing both ways within the host's noise. What the release changes on the server is small: a tracked report's new findings must be first found after it was saved (one date compared per finding at each refresh), and the list of tracked reports adds up the AI credits once per project (one pass over the credit log per listing); its p95 was 124 to 148 ms against main's 99 to 165 ms. The rest is the browser: the Dashboard's tiles, Labs, Your appearance, the Workbench's narrowing and credit editor. In the browser the release is as fast as main: a fetch of 200 projects' findings (mock tenant at 20 ms a call, Chromium, three runs each) took 506 to 923 ms against 503 to 898 ms, the page ready (DOMContentLoaded) in 89 to 121 ms against 84 to 108 ms, and long tasks 0 to 135 ms against 0 to 133 ms. nodemailer 10.0.13 (a fix to how the server reads a mail server's greeting) came in after these runs; the benchmark's mail goes through the same code. No finding was sent for triage twice.

**MZ-01.00.83: what the differences were.** Two pairs with main (main, then the release, twice), every run with 0 failed requests and no finding sent twice. In the first pair the release served 520 requests a second against main's 525, with a slower tail (report opens 7.5 s at p95 against 5.8 s, triage polls 463 ms against 313 ms); the translation reviews were running on the same host during the release's run. In the second pair, with nothing else running, it served 521 against main's 519, and its tail was faster (report opens 2.1 s against 5.2 s, triage polls 205 ms against 284 ms): the first pair's difference was the host, not the release. What the release changes on the server is small: each tracked report's reading also counts its outcomes by severity (one more increment per baseline finding at each refresh), and two routes serve the organisation's own brand font from its folder (the folder is read at most once a minute; only the page asks for them). The rest is the browser: the looks, the menu's pins and Focus, the Dashboard's seeds.

**MZ-01.00.87: what the differences were.** Two pairs with main (main first both times). The first main run shared the machine with a round of browser screenshots and is not compared; in the second pair, with nothing else running, the release served 465 requests a second with 84 failed against main's 470 and 89, on a host busier than on a quiet day (when both serve every request). The failures are connection timeouts on both sides alike. Report opens took 13.2 s at p95 against main's 11.6 s, and triage polls 1.8 s against 2.3 s: one each way, within the spread of main's own two runs (11.6 and 14.3 s; 1.5 and 2.3 s). The release changes nothing on the measured paths: the Fusion page's test and debug routes are called only by an Admin from that page, the Checkmarx One client's trace hook does nothing unless one is passed, and the drawer fix and translations are in the browser. No finding was sent for triage twice.

**MZ-01.00.88: what the differences were.** Two pairs with main, main first and then the release first, on a host as busy as for MZ-01.00.87 (both sides lose a few hundred requests to connection timeouts). In the first pair the release served 445 requests a second with 210 failed against main's 473 and 197; in the second 469 with 266 failed against main's 456 and 394. Report opens took 15.7 and 18.8 s at p95 against main's 14.0 and 17.3 s, and triage polls 2.4 and 1.9 s against 2.0 and 3.2 s: each way once, within main's own spread between its two runs. The release changes nothing on the measured paths: Act → Automation's routes are called only from that page, the scheduled runs are off in the benchmark, and the reminder email is built only when a run sends. No finding was sent for triage twice.

**MZ-01.00.89: what the differences were.** Two pairs with main, main first and then the release first, on a quiet host again (main served every request in both its runs). The release's first run overlapped the test suite, run by mistake at the same time: 52 failed, so it is recorded and not compared. In the clean pair the release served 501 requests a second against main's 502, none failed on either side; report opens took 9.6 s at p95 against 7.2 s, and triage polls 644 against 563 ms, both inside main's own spread between its two runs (10.8 and 7.2 s; 1.3 s and 563 ms). The release adds nothing on the measured paths: the standalone calculator is built only when it is downloaded, and the calculator's customers and reports are checked by the same rules as before, now in a shared module. No finding was sent for triage twice.

**MZ-01.00.90: what the differences were.** Seven runs: main, the release twice, main, the release twice, main, on a busy host again. Four runs lost requests in the same way, main's third and the release's first, second and fourth: for 20 to 30 seconds the whole server answered nothing, so every kind of request timed out at once, the health check included (its maximum 20.9 to 30 s), with nothing in the server's log. Main lost the most (298), and its first run 12 in a shorter pause (11.8 s). Main and the release each had one run with none (main 494 requests a second, the release 469, report opens 8.7 s and 8.2 s at p95). Over all runs the release served 457 to 482 requests a second against main's 455 to 494, inside main's own spread. The release adds nothing on the measured paths: the launcher is built only when it is downloaded, the read it serves runs in the launcher on the user's computer and never on this server, and **Include Fusion** is a field of a calculator customer, which the benchmark does not use. No finding was sent for triage twice.

**MZ-01.00.91: what the differences were.** One pair with main (main first), released quickly at the maintainer's request, on a host as busy as for MZ-01.00.90: both runs had the same whole-server pause (health check 30 s at most) that took requests with it. The release served 461 requests a second with 45 failed against main's 437 with 430, with a shorter tail (report opens 14.2 s at p95 against 23.6 s; triage polls 3.1 s against 3.2 s). The release adds one look-up to who-am-I (whether the calculator's Impact tab is unlocked) and nothing else on the measured paths. No finding was sent for triage twice.

**MZ-01.00.95: what the differences were.** Main first, then the release, on the same host. The release served 511 requests a second against main's 494, none failed against main's 64, with a shorter tail on every path people wait on (report opens 7.0 s at p95 against 11.8 s; triage polls 622 ms against 925 ms; the fetch 26 s against 29 s). Main's 64 were lost in one host stall during its run (its health check waited 30 s once, the release's at most 8.7 s), spread over the report, credits and settings calls; FAE Flush adds nothing to these paths: its page reads only when opened, and the server's run does nothing until someone starts one. No finding was sent for triage twice.

**MZ-01.00.94: what the differences were.** Main first, then the release, on the same host. The release's first run served 471 requests a second against main's 494, none failed, but two paths had a longer tail: the credits page (`GET /api/credits`, p95 15.8 s against 0.5 s) now waited for the tenant's credits from Checkmarx One, a call queued behind every other one at low priority, and the Workbench fetch (p95 55 s against 31 s) waited for its read of each project's scan type, queued the same way. Both were fixed before merging: the credits page shows the figure last read and reads it again behind (the pool and allocations still check it), and the scan-type read (one call per 100 projects) runs at the fetch's own priority. Run again: 513 requests a second against main's 494, none failed on either side, and a shorter tail than main (report opens 6.8 s at p95 against 8.0 s; triage polls 303 ms against 1.4 s; the fetch 22 s against 31 s). It makes 290 more scan-list calls and 12 credit reads per run. No finding was sent for triage twice.

**MZ-01.00.93: what the differences were.** One clean pair with main (main first) on a quieter host than the week's: none failed on either side, and no pause of the whole server. The release served 509 requests a second against main's 491, its burst took 8.3 s against 10.9 s, and its tail was shorter (report opens 5.5 s at p95 against 8.9 s; triage polls 646 ms against 1.4 s). On the measured paths it adds one check per request, whether the product licence is in date (a date comparison, its clock written at most once an hour); Fusion's reads, its scans and credits and its actions are called only from Labs → Fusion results, which the benchmark does not use. No finding was sent for triage twice.

**MZ-01.00.92: what the differences were.** One pair with main (main first) on a host still as busy: both runs had pauses of the whole server (health check up to 17.1 s on main and 21.6 s on the release) and lost the same number of requests to them (152 on main, 153 on the release). The release served 479 requests a second against main's 462, triage polls 2.0 s at p95 against 2.2 s, report opens 16.0 s against 14.5 s, inside the spread of the runs of this week. The release changes nothing on the measured paths: Fusion is read only from Labs → Fusion results, which the benchmark does not use. No finding was sent for triage twice.

**MZ-01.00.86: what the differences were.** Two pairs with main (main first, then the release first), on a host as saturated as MZ-01.00.85's last two pairs: main itself served 278 and 375 requests a second and failed 2,336 and 1,201, against 491 to 520 with none on a normal day. Every failure on both sides is at the connection (timeouts as the host saturates), none an error from the server, and report opens reached the 60-second client timeout at p95 on both. The first build of the release (the Fusion path fix) served 285 a second with 2,266 failed, better than main's run just before it; the final build served 303 with 2,052 failed, worse than main's run just after it (375, 1,201): the host, not the code, decides these runs. What the release changes on the server is off the measured paths: Fusion's reads and its allocate, triage and remediate routes are called only from Labs → Fusion results, by Admins, and the shared allocation step gains one optional filter that the Workbench, Credit Control and tracked reports never pass. No finding was sent for triage twice.

**MZ-01.00.85: what the differences were.** Four pairs with main, every run with 0 failed requests and no finding sent twice; the release makes 6% fewer calls to Checkmarx One (32,744–34,858 against 33,217–36,669). The first build (pairs 1 and 2, main first) read six projects' live states at once for a report instead of three, and its report opens reached 7.9 and 8.3 s at p95 against main's 7.7 and 4.6 s; that was put back. As shipped (pairs 3 and 4, the release first) it served 513 and 498 requests a second against main's 520 and 491, its opening burst finished in 9.2 and 9.6 s (main 16.4 and 9.3 s), and report opens reached 6.2 and 6.3 s at p95 against main's 5.7 and 5.5 s, with triage polls at 331 and 463 ms against 152 and 220 ms. Why the readers' tail is a little longer: an HTML report now finds its AI ids in the result-id list kept for 30 minutes, the same list the Workbench's **Triage now** reads, so the analysts' Triage now ran a third faster (0.4–0.6 s at the median against 0.75–0.94 s; 3.0–3.9 s at p95 against 5.4–5.7 s) and did more in the two minutes (181 and 193 runs against 164 and 174; 2,346 and 2,422 results sent for triage against 2,266 and 2,295), so more triage was in flight for the readers' polls to look up. Against the first measured release (MZ-01.00.25 on main: 501 and 518 requests a second, report opens 6.2 and 7.0 s at p95, triage results 689 and 763 ms) the release serves as much, opens reports as quickly, and answers triage polls in under half the time. Two more pairs (5, the release first; 6, main first) were run after this session's machine was restarted, on a host as slow as MZ-01.00.81's: main itself served only 327 and 338 requests a second and failed 1,130 and 1,011, against 491 to 520 with none the day before. Every failure on both sides is at the connection (timeouts as the host saturates), none an error from the server, and report opens hit the 60-second client timeout at p95 on both. The release served 309 and 425 a second with 1,705 and 531 failed: worse than main in pair 5 and better in pair 6, so the host, not the code, decides these runs, and pairs 3 and 4 stay the comparison of record. The code added since pair 4 adds no request to the paths the load exercises: the Impact tab and its Fusion figures run in the browser, the new icon is one file, and Labs → Fusion results is read by its own route (`POST /api/beta/fusion/read`), called by the page after a fetch only for people who may use it, in the background queue to Checkmarx One so it waits behind report opens and triage. Allocating from a tracked report or Credit Control reads each project twice instead of three times (176 ms against 335 ms for 20 projects on the mock), and building the same HTML report again takes 0.2 s instead of 1.25 s for 12,000 findings; neither is in the mixed load's numbers above.

**MZ-01.00.84: what the differences were.** One pair with main (main, then the release), nothing else running, both with 0 failed requests and no finding sent twice. The release served 502 requests a second against main's 497, and its opening burst finished sooner (8.5 s against 10.4 s). Report opens took 6.7 s at p95 against 6.1 s, and triage polls 593 ms against 551 ms: within main's own spread on the same host today (5.2 to 6.1 s, and 284 to 551 ms, over three runs). What the release changes on the server: a report file carries its reader's look (a few kilobytes more style when the look is not Command center or Classic, built once per report), Impact's summary is coloured by the look, and Settings remembers whether an Admin typed the app name. None of it is on the report-open or triage-poll path the load exercises.

**MZ-01.00.81: what the differences were.** Three pairs with main on a host far slower than the days before (this session's machine started fresh that morning): main itself served only 318 to 333 requests a second and failed 1,609 to 1,696 of them, against 476 to 483 and at most 85 a day earlier. Every failure on both sides is at the connection (connect timeouts, resets and timeouts as the host saturates), none an error from the server. Within that, the release did better in every pair: 342, 327 and 345 requests a second against 330, 318 and 333; 1,396, 1,359 and 1,388 failed against 1,696, 1,609 and 1,691; report opens at p95 33.3 and 55.4 s against main's 60 s timeout (once both at it); and the health check's p95 under a second where main's was 18 to 20 s. The release changes what the browser draws (the command-center look, the Workbench and Dashboard names, the folding menu, explanations behind a ?) and the interactive report's styles; the requests the load makes are main's code. The 60 failures in its first opening burst are triage-result reads reset by the network (main had 10 in its last); the second and third bursts had none. In the browser the release is as fast or faster: a fetch of 200 projects' findings (mock tenant at 20 ms a call, Chromium, three runs each) took 660 to 1,220 ms against 782 to 1,202 ms on main, with 0 to 255 ms of long tasks against 128 to 264 ms, the page ready (DOMContentLoaded) in 141 to 175 ms against 155 to 182 ms, and 119 KB less of fonts to load. No finding was sent for triage twice.

**MZ-01.00.80: what the differences were.** Two pairs with main: main, the release, the release, main. The release changes only what the browser draws (table headings that wrap, cards on phones, credit cells, exact times on the Update page) and its wording; the interactive report carries the same table script with one more function. Under sustained load the release served 487 and 488 requests a second with none failed, against main's 476 and 477 with 85 and 38 failed (report hellos and triage polls that timed out in host stalls of 14 and 10 s). Report opens at p95 were faster on the release in both pairs (8.5 and 9.6 s against 13.3 and 10.5 s), and triage polls 1.2 and 1.8 s against 1.7 and 2.0 s. In the release's first run, 15 of the 150 credit reads in the opening burst of 2,970 simultaneous requests were reset by the network (ECONNRESET) at 9.2 s; the request behind them is unchanged, and the second run's burst had none. No finding was sent for triage twice.

**MZ-01.00.79: what the differences were.** Three pairs with main: main then the release, the release then main, main then the release. The release adds sort and filter controls to table headings and role renaming, duplicating and comparing, all in the browser, and embeds the table controls' script (about 20 KB) in each interactive report it builds; the report hellos, triage polls and credit reads that make up the load are otherwise the code main runs. The first pair met long host stalls on both sides (the health check waited 30 s at its slowest in each): main failed 240 requests and the release 62. In the second the release met the longer stall (21 s against main's 10 s) and failed 117 requests to main's none; those are report hellos and triage polls that timed out in it, as main's did in the first pair. In the last pair neither failed: the release served 472 a second to main's 483, opened reports faster at p95 (9.0 s against 13.0 s) and answered triage polls in 1.6 s against 1.2 s. Over the three pairs the release served 490, 478 and 472 a second against main's 465, 479 and 483, and report opens at p95 were faster in two pairs of three (11.3 and 9.0 s against 18.7 and 13.0 s), so the report-open tail flagged in MZ-01.00.78 did not grow. No finding was sent for triage twice.

**MZ-01.00.75: what the differences were.** A slow day on the host: main itself failed 145, 138 and 74 requests in its first three runs (none in its fourth), with the health check stalling for up to 30 s, and opened reports in 8.5–15.5 s at p95 against 5.4–6.5 s the day before. The failures on both sides are requests timed out during those stalls (triage polls and report hellos), never a wrong answer, and no finding was sent for triage twice in any run. The first build of the release served about the same (475–488 a second against 478–486), but its median Dashboard fetch was slower in two of three runs (17.2 and 24.2 s against main's 15.8 and 14.7 s): it read each project's lines of code (for **Leave out projects with no lines of code**) before reading any findings. The release now asks for them side by side with each project's findings, so the check adds no wait, and remembers them per Checkmarx One key and scan; its next two runs fetched at 16.0 and 15.4 s at the median (main 14.7–16.0 s) and served 492 and 486 a second (3 and 36 failed, the 36 during a 30 s host stall), against main's fourth run at 482 with none failed. The benchmark's mock tenant does not say which branch a scan ran on, so the branch lookups are not exercised here: they cost one call per project whose latest scan is on another branch, and one call per 50 scans named by findings, each remembered (`test/branches.test.js` covers them against a tenant scanned on several branches). The release made 30,626 calls to Checkmarx One in its fourth run against main's 31,432.

**MZ-01.00.74: what the differences were.** Main, then the release twice, then main and the release again: every run served every request, and no finding was sent for triage twice. The release's first two runs opened reports slower at p95 (9.1 s against main's 6.5 s), with the health check stalling for 9.6 and 14.9 s against main's 7.1 s; its third run, on the same quiet host as main's second, was in line with main (514 a second, report opens 5.9 s against 5.4 s, triage polls 252 ms against 717 ms, health check at most 6.0 s against 5.6 s). The report-open call changed only by one more field per project (the severities its credits are allocated for), and generating a 200-project report takes the same 39 ms with either version (2.2 MB each): the slow runs were host stalls, not the release. The rest of the release is in the report's own script (fix wording, Remediate all), which runs in the reader's browser.

**MZ-01.00.72: what the differences were.** Three pairs on the same host, with nothing else running. Main (MZ-01.00.71) served every request in all three, at 495–503 a second. The release served every request in its third run (486 a second, report opens 8.0 s at p95 against main's 8.9 s in the run after it), but not in its first two: 25 and 45 failed requests, all triage polls timing out during host stalls; in the run with 45, even the health check, which does nothing, once took 30 s. The release changes no request path: the integrity check runs at start and every 6 hours, and on a copy without a signed file list (as here, run from source) it reads one missing file and stops; the page gains one panel. Triage polls at p95 ranged 959–1,430 ms for the release and 574–944 ms for main, report opens 8.0–11.9 s against 6.1–8.9 s; the third pair, closest in time, is the one shown in bold. No finding was sent for triage twice in any run.

**MZ-01.00.71: what the differences were.** Main once, the release three times, main again, then the release as shipped. The first release run had 13 failed requests (10 triage polls, 1 triage, 2 remediate, during host stalls: the health check's slowest answer was 13.6 s against main's 9.5 s); a rerun of the same code had none. Runs 2 and 3 served every request but took the opening burst in 16 s against main's 10: the credit check then started reading each scan's result ids beside its two reads, and 15 checks at once queued those scans' pages ahead of the reports' own calls to Checkmarx One. That overlap was taken out; result ids are now read ahead only when projects are picked on the Dashboard, two scans at a time. Measured back to back with main on the same host, the release as shipped took the burst in 9.4 s like main, served 488 requests a second against 487 with none failed and no finding sent twice, opened reports in 8.9 s at p95 against 9.5 s and answered triage polls in 627 ms against 656 ms. Recording user activity adds one line in memory per change, sign-in or download (written to disk in batches), and none for the reports' own calls.

**MZ-01.00.70: what the differences were.** One pair, main first, with nothing else running. Both served every request, with no finding sent for triage twice: the release did 511 requests a second against main's 500, opened reports faster at p95 (6.7 s against 7.7 s) and took the opening burst in 8.9 s against 10.5 s. Triage polls were 452 ms against 344 ms at p95, with medians of 13 and 12 ms. This release changes only how the Cx Credits Calculator counts findings still to come, in the browser; the server's request paths are untouched.

**MZ-01.00.65: what the differences were.** Five pairs, all with 0 failed requests and no finding sent twice; the table keeps the last, which measured the version released. The release reads 24 projects at once when loading findings (10 before) and verifies 8 projects at once with their two reads side by side (3, one after the other), and the pairs were what tuned it. The first two, with nothing else changed, showed the cost: under load the branch's report opens were slower at p95 in the second (5.8 s against main's 4.2 s), as a fetch's 24 projects and a verify's 16 reads put up to a hundred calls in the queue to Checkmarx One ahead of a report opening. Two attempts to fix it were worse and were dropped: fetch pages at low priority starved the fetches under load (83 s at the median), and one gate shared by every fetch slowed them to 34 s. What was kept bounds each read's own queue: a fetch never has more than 24 calls waiting or running (main could have about 40), a verify never more than 12 (as main). In the last pair the branch opened reports faster at p95 (5.0 s against 5.4 s), loaded findings faster (8.6 s against 12.8 s at the median, 142 fetches done against 131) and verified as fast (5.5 s against 5.4 s at p95). Triage polls at p95 were 276 ms against 185 ms: just above the spread main itself showed in these pairs (152 to 268 ms), with the median the same (8 ms); they read states Checkmarx One is asked for alongside the extra fetches the branch finished. Requests a second, 511 against 520, are close to main's own spread (516 to 528), with more fetches finished in the same two minutes. On its own, with Checkmarx One answering in 0.8 s, a fetch of 151 projects and 94,375 findings took 25.5 s against main's 31.0 s, and verifying 40 projects took 6.3 s against 23.4 s (0.2 s answers).

**MZ-01.00.64: what the differences were.** One pair, main first, both with 0 failed requests and no finding sent twice, on a host back at its usual speed (main, which is MZ-01.00.63, served 521 requests a second with 0 failed; MZ-01.00.63's own pair, on the slower host, could not show that). The branch served 526 a second; at p95, report opens took 5.9 s (main 6.4 s), and triage polls 246 ms against main's 217 ms. That one slower tail is within run-to-run spread: the same polls' p99 was lower on the branch (2.2 s against 2.5 s), their median was 9 ms against 10, and the burst finished sooner (8.5 s against 11 s) with fewer busy retries (172 against 702). The release changes no measured path: the calculator's background read of Checkmarx One and its new routes are not called by the benchmark, and the rest is the calculator page, its report file and the language files, which the benchmark does not load.

**MZ-01.00.63: what the differences were.** Main and the branch twice each, in turn, on a different host from MZ-01.00.62's (the session's container was new): no finding was sent twice in any run. Every run on this host was slow and lost requests, main as much as the branch. Main, which is MZ-01.00.62 exactly as it served 509 requests a second with 0 failed the day before, served 394 to 398 a second with 585 to 793 failed, and its health check stalled for up to 30 s. So the host was slower, not the code. The failures were timeouts spread over every endpoint, the health check included, with the server's CPU at its usual level. In both pairs the branch did as well as main or better: 397 a second with 702 failed against 398 with 793, then 415 with 203 failed against 394 with 585, and report opens at p95 18.6 s against 55.5 s. The release changes no measured path's work: a language check now reads the person's role, and the calculator's check is one permission instead of a permission and an activation code. It is to be measured again on a host that runs main at its usual speed.

**MZ-01.00.60: what the differences were.** One pair, branch first, both with 0 failed requests and no finding sent twice. The branch served 505 requests a second against main's 499. At p95, report opens took 6.9 s (main 7.9 s) and triage polls 501 ms (main 545 ms). The release moves one file into `src/` and adds a fallback around building a report's languages, so the measured paths do the same work as before. In the burst, 238 triage-result polls on the branch were turned away as busy and retried, as designed, and none failed.

**MZ-01.00.59: what the differences were.** One pair on a quiet host, branch first, both with 0 failed and no finding sent twice. The branch served 513 requests a second against main's 518. At p95, report opens took 6.2 s (main 6.5 s), triage polls 229 ms (main 214 ms), and building a report from the Dashboard 9.0 s (main 11.5 s).

What the release adds on the measured paths:
- **Building a report:** a few more steps. The person it is for is looked up by email. Their language's words are taken from memory (read from disk once per language), and the translator is put in the page.
- **Report size:** a 60-finding report went from 208 KB to 244 KB with no language of its own. With its reader's language it is 295 to 303 KB (German, Arabic, Japanese).
- **The language route:** `GET /api/relay/report-words/<code>` answers from memory. The benchmark does not call it, as its readers stay in English.

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
| `CX_FETCH_CONCURRENCY` | 24 | Projects read at once by one fetch (10 before MZ-01.00.65). |
| `CX_FETCH_SLOTS` | `CX_MAX_CONCURRENCY` | Calls one fetch keeps waiting or running at once, however many projects it reads side by side: a report opened meanwhile waits behind at most this many (a verify keeps at most 12). |
| `CX_VERIFY_CONCURRENCY` | 8 | Projects verified at once by **Refresh & verify** and the credit actions, each with its two reads side by side (3, one read after the other, before MZ-01.00.65). |
| `CX_PAGES_AT_ONCE` | 4 | Pages of one big project read at once, once its size is known. |
| `CX_RESULT_IDS_CACHE_SECONDS` | 1800 | How long the credit checks keep a scan's result ids (to match each finding to its Checkmarx One result), per signed-in connection, never shared between keys or tenants. A scan's results do not change, so the two reads and the allocation after them read the list once, and an HTML report built after them (or built again) finds its AI ids there too: only the code paths of the 50 findings it shows are read. `0` reads it every time. |
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
