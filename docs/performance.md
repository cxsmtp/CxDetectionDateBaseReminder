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
