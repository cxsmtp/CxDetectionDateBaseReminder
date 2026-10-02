# Relay load test

Emailed reports run AI Triage and AI Remediation through this server's relay,
and keep polling it for results. This kit checks how the relay holds up when
thousands of reports are open at once.

```bash
loadtest/run.sh 1000 60     # 1000 open reports for 60 seconds
LAT=200 loadtest/run.sh 3000 120   # slower tenant, more readers
```

It starts a mock Checkmarx One (200 projects × 60 findings, 80 ms per call,
counting every call), a reminder server on port 3997 with a throwaway data
directory, and then simulates the readers. Each one connects, reads its credits
and remediation state, one in five triages five findings, one in twenty
remediates one, and every reader polls triage results for its 50 findings
every 6 seconds (the report's fastest rate). The load generator retries a
"busy" answer the way the report does.

## What the server does under load

* **Shared answers, one upstream call.** Risk states per project, AI Triage
  records and AI Remediation details are cached and shared by every report;
  concurrent asks for the same thing wait on one call. Settled answers are kept
  for 10 minutes, ones still changing for seconds, findings someone just acted
  on are watched closely.
* **Never wait on a backlog.** Triage results and remediation state answer at
  once from what is known and mark the rest `pending`; the lookups run in the
  background and the report asks again a few seconds later.
* **Interactive work first.** At most `CX_MAX_CONCURRENCY` (default 24) calls
  go to Checkmarx One at a time. Triage, remediation and dashboard requests
  jump ahead of background refreshes; the background queue is capped
  (`RELAY_BACKGROUND_QUEUE`, default 2000) and anything skipped is picked up on
  the next ask.
* **Admission control.** Past `RELAY_MAX_IN_FLIGHT` (default 300) relay
  requests in flight, the server answers "busy, retry in N seconds" at once;
  reports wait and retry instead of timing out.
* **Cheap bookkeeping.** Credit balances come from running totals (not a scan
  of the ledger), and ledger writes are batched.
* **Reports poll politely.** Polling is jittered and slows down (up to 30 s)
  while nothing changes.

`GET /api/metrics` (signed in) shows relay load, cache hit rate and the
Checkmarx One queue.

## Results

Same machine for the mock, the server and the load generator (the generator
competes for the CPU, so real numbers are better).

| 1000 readers, 60 s | Before | After |
|---|---|---|
| Failed requests (timeouts, resets) | ≈800 | 0 |
| Triage results p95 | 27.7 s | 85 ms |
| Triage p95 | 23.4 s | 363 ms |
| Remediate p95 | 10.4 s | 455 ms |
| Server health check p95 | 25.2 s | 5 ms |
| Calls to Checkmarx One | 348,175 (2,917/s) | 13,583 (≈200/s) |
| Peak concurrent calls to Checkmarx One | 743 | 24 |
| Server peak | 104% CPU | 64% CPU, 234 MB |

3000 readers for 60 s: no failed or refused requests; triage results p95 530 ms
at 424 requests/s; calls to Checkmarx One stay capped at 24 concurrent.

## Tuning

| Variable | Default | |
|---|---|---|
| `CX_MAX_CONCURRENCY` | 24 | Calls to Checkmarx One at once, per connection. Raise only if your tenant allows it. |
| `RELAY_MAX_IN_FLIGHT` | 300 | Relay requests handled at once before answering "busy". |
| `RELAY_BACKGROUND_QUEUE` | 2000 | Background lookups allowed to queue. |

The server keeps its state (credit ledger, allocations, caches) in one
process. Run one instance per data directory; for more capacity give that
instance more CPU rather than running copies side by side.
