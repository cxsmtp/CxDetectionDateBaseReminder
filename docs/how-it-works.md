# How CxMissionZero works

The technical reference: what happens under each feature, where data lives, and how it is kept safe. To learn how to *use* the features, see the [user guide](user-guide.md).

## Request flow

1. **Fetching.** A person fetches from the Dashboard, and the server reads Checkmarx One with the integration key (or the person's own key). It reads three things:
   - the projects;
   - who ran each project's latest scan;
   - each project's findings.
2. **Ageing.** Findings are aged by `firstDetectionDate`, and summaries stream to the page as each project arrives.
3. **Reminders.** A reminder renders the mail template per recipient. Each scan initiator only ever gets their own projects, and the server re-checks every message before it goes. It is sent through your SMTP server, with the interactive report attached.
4. **The emailed report** calls this server's report relay, never Checkmarx One directly: browsers refuse API calls from a page opened as a file. The relay acts only on findings carrying a valid signed grant, and calls AI Triage / AI Remediation with the server's own connection.
5. **Credits.** Every request is checked against the project's allocation and the credit pool, then recorded in the credit ledger and the hash-chained audit log.

## Checkmarx One API

**Authentication**
- The API key is a JWT whose `iss` claim names the tenant and region, so the IAM URL, tenant and API host are worked out from it.
- Connecting exchanges the key for a token (proving the key and IAM URL), then makes one `/api/projects` call (proving the API URL). So a wrong host is reported differently from a bad key.
- Single-tenant and on-prem deployments can set all three by hand (`CX_BASE_URL`, `CX_IAM_URL`, `CX_TENANT`).

**Findings**
- Read with `GET /api/risks/?projectId=…`, paged at 200 and sorted by `firstDetectionDate`. Dates may be RFC 3339 or unix timestamps; both are handled.
- `/api/risks/ai-insights` adds AI Triage status.
- `CX_RISK_SOURCE=scan-results` reads `firstFoundAt` from the latest completed scan instead, for tenants without the risks service.
- Every call sends `Accept: application/json; version=1.0`; without it the gateway answers 400.
- **Detect** (Settings → Risks endpoint) probes the known paths. 400, 403, 404 and 405 all mean "try the next one".

**Scan initiators** come from `/api/projects/last-scan` (one call per 50 projects), then `/api/scans?project-id=…` for any project it did not cover. An address is resolved in this order:
1. an email on the scan, or a username that is an address;
2. an override (`username = email`);
3. the tenant IAM directory, read once and matched locally;
4. a suggestion from your tenant's naming pattern (`cx-julian-chuan` → `julian.chuan@company.com`), which waits for someone to confirm it.

**Fetch speed**
- Initiators and findings are fetched at the same time, with findings for 10 projects at once (`CX_FETCH_CONCURRENCY`).
- **Big projects, a few pages at once.** The first page of findings says how many there are; the remaining pages are read 4 at a time (`CX_PAGES_AT_ONCE`) and kept in order. Last-scan lookups go out a few chunks at once too.
- **Shared recent reads.** A project read in the last 2 minutes (`CX_FETCH_CACHE_SECONDS`, 0 switches it off) is reused by the next fetch instead of read again, when all of these hold:
  - it is the same Checkmarx One key on the same tenant (people on different keys never share what they can see);
  - its latest scan is still the one it was read for;
  - nobody triaged or remediated it from CxMissionZero in the last 30 minutes (those are read fresh every time while Checkmarx One works through them);
  - **Read everything fresh** is not ticked.

  Changes made directly in Checkmarx One show up within those 2 minutes, or at once with **Read everything fresh**. The page says how many projects were reused. Verify, credits, triage and remediation never use these reads: they always ask Checkmarx One.
- Every Checkmarx One call shares a cap of 24 in flight (`CX_MAX_CONCURRENCY`). Interactive work goes ahead of background refreshes.
- The page receives per-project summaries. The findings themselves stay on the server, for reminders and reports.
- **Compressed when it pays.** Replies of 32 KB and more (the page itself, the fetch stream, full results, downloads) are compressed with brotli or gzip, whichever the browser accepts; the fetch stream line by line. A 200-project fetch stream goes from 445 KB to 11 KB. Small, frequent replies such as report polls are not: on a 2 vCPU server that costs more than it saves ([performance](performance.md)).

**AI Triage and AI Remediation**
- **IDs.** AI Triage is keyed by the result's `alternateId` (resolved from the scan results by similarity id). AI Remediation is keyed by scan and result.
- **Several rows, one result.** Rows that share a result are one request and 1 credit; the billing unit is alternateId, else groupId, else riskId.
- **Never sent twice.** Before any triage or remediation is sent (from the Dashboard, a tracked report or any emailed report), the server claims each finding by result id, group id and risk id (`src/send-guard.js`). Another request for the same finding gets "already being sent". Afterwards the ledger records it, so it is never counted as needed again.
- **"Needed" is read twice.** Credit need is confirmed by two independent reads of Checkmarx One (findings plus the result ids AI Triage would be sent). Allocation goes ahead only when both reads agree, result for result.
- **Remediation is fenced to Confirmed.** The report's button is disabled for any other state, and the server re-reads the state and refuses anything else.

## Report relay
- **Grants.** Each finding in a report carries a grant signed with `report-signing.key` (or `REPORT_SIGNING_KEY`), valid for 30 days. The relay acts on nothing else.
- **Shared answers.** Risk states, AI Triage records and AI Remediation details are cached and shared across reports. Concurrent asks for the same thing wait on one call.
- **Never waiting on a backlog.** Unknown answers come back `pending` at once, while lookups run in the background.
- **Admission control.** Past `RELAY_MAX_IN_FLIGHT` (300) requests in flight, the server answers "busy, retry in N s" at once, and reports back off and retry. The background queue is capped by `RELAY_BACKGROUND_QUEUE` (2000).
- **One call to open.** A report opens with `/api/relay/hello`: the status, its projects' credits, and where AI Triage and AI Remediation stand for every finding, in one round trip instead of four. Against an older server (no `/hello`) it asks the separate questions, so reports and servers of any version work together.
- **Polling.** Reports poll with jitter and slow down (up to 30 s) while nothing changes.
- **Measured.** 3000 people at once on 2 vCPU: see [performance.md](performance.md).

## Links into Checkmarx One

| | Default template |
| --- | --- |
| Project | `{baseUrl}/riskhub/{projectId}` |
| Finding | `{baseUrl}/riskhub/{projectId}?pagination=…&grouping=…&resultId={riskId}` |

- **Placeholders:** `{baseUrl}`, `{projectId}`, `{scanId}`, `{engine}` and `{riskId}`. Every value is URL-encoded, and only `http(s)` links are emitted.
- **Engines** map to the UI's tabs: SAST → `sast`, SCA → `sca`, IaC → `kics`.
- **Missing values:** a finding with no scan falls back to its project link. With no base URL the mail still renders, without links.

## Mail template
- **Values:** `{{name}}` inserts a value, HTML-escaped; `{{{name}}}` inserts raw HTML (only when the braces are balanced).
- **Lists:** `{{#projects}}…{{/projects}}` repeats a block; `{{^projects}}…{{/projects}}` renders it only when the list is empty.
- **No code runs.** There is no expression evaluation: a name is a dotted path.
- **Scope.** A section can see both the current item and everything outside it, so `{{projectCount}}` works inside `{{#projects}}`.
- **Per-initiator sends** add `{{initiator}}` and `{{initiatorEmail}}`. Inside `{{#projects}}` there are also `{{initiator}}` and `{{lastScanDate}}` for that project.
- **Escaping.** Finding titles and project names from Checkmarx One are always escaped.

```html
<h2>{{totalRisks}} findings across {{projectCount}} projects</h2>
{{#projects}}
  <h3>{{projectName}}: {{riskCount}} open</h3>
  {{#risks}}<p>[{{severity}}] {{title}}, first detected {{firstDetectedAt}} ({{ageDays}}d)</p>{{/risks}}
  {{#hiddenCount}}<p>…and {{hiddenCount}} more.</p>{{/hiddenCount}}
{{/projects}}
```

## Automation without nagging
Each *(finding, threshold)* pair is recorded in a ledger once reported, and only unrecorded pairs are emailed.

| Situation | What happens |
| --- | --- |
| A finding reaches 30 days | One message. |
| The same finding the next day | Silence. |
| It reaches 60 days | One message. |
| It is already 200 days old on the first run | One message, for the highest threshold passed. |
| It is fixed, then comes back | Reported again, as a regression. |

The ledger survives restarts. **Reset history** clears it.

## Last known good connections
The Checkmarx One integration and the mail server are the two settings that can stop the utility, so a change to either is checked before it counts.
- **While a change is unproven,** the last known good one keeps running.
- **A change that fails** is rolled back when the editor leaves Settings. If nobody was there, the server rolls it back on its own after `CONFIG_ROLLBACK_IDLE_MINUTES` (10) or at start-up, and every administrator sees a notice once.
- **A check that takes too long** (`CONNECTION_CHECK_TIMEOUT_MS`, 25 s) counts as failed.
- **Where:** the last known good configuration is kept in `connection-guard.json`. Every check and rollback is audited.

## Where things are stored
All state lives in one folder: `/data` in the container, `DATA_DIR` elsewhere (default `~/.mission-zero`). The folder is mode `0700`, its files `0600`.

| What | File |
| --- | --- |
| Settings: SMTP password, the integration key, template, credit settings | `settings.json` |
| People and roles (passwords as scrypt hashes) | `iam.json` |
| Credit ledger, per-project allocations | `triage-credits.json`, `credit-allocations.json` |
| Audit log (append-only, hash-chained) | `audit/audit-YYYY-MM.jsonl`, `audit.key` |
| Tracked reports, emailed reports kept for download | `tracked-reports.json`, `report-files/` |
| Resolved initiator addresses, automation state | `known-initiators.json`, `automation-state.json` |
| Last known good connections | `connection-guard.json` |
| Sign-ins (session ids as SHA-256 only) and each person's fetched data, so restarts sign nobody out | `sessions/` |
| Report signing key | `report-signing.key` |
| Troubleshooting log (no sensitive data) | `diagnostics.jsonl` |
| Backups | `backups/` (or `BACKUP_DIR`) |
| A person's own Checkmarx One API key (key sign-in) | Server memory only; never written to disk |

See [audit-and-backup.md](audit-and-backup.md) for backups and rebuilding a server.

## Security
- **Sign-in**
  - Passwords are hashed with scrypt and must be at least 12 characters.
  - Five failures lock an account for 15 minutes, and an address is slowed after 30 attempts.
  - Sessions are opaque `HttpOnly`, `SameSite=Lax` cookies (`Secure` over HTTPS).
  - API keys never reach the browser, the logs or the disk.
- **Permissions.** 29 permissions, checked on every API route. Nobody can grant more than they hold, and there is always one active Admin.
- **Cross-site requests.** Changing requests must come from this server's own pages (an `Origin`/`Referer` check). The report relay is exempt, and needs a signed grant per finding instead.
- **Headers**
  - A Content Security Policy allowing only this server's scripts.
  - No framing.
  - `nosniff`, same-origin referrers and a restrictive `Permissions-Policy`.
  - HSTS over HTTPS, and no `X-Powered-By`.
- **Input**
  - Ids never resolve to built-in object properties.
  - Email checks are length-capped.
  - Links are `http(s)` only, and template output is escaped.
- **Container and CI**
  - The image runs as a non-root user on Alpine, has no package manager at run time, and is checked in CI with a read-only root, no capabilities and `no-new-privileges`.
  - GitHub Actions are pinned to commit SHAs.
- **Dependencies.** `npm audit` reports no known vulnerabilities.

## Code layout

```
public/              Web app (no build step) and sample.env
src/server.js        Express API, sign-in, permissions, relay, credits
src/cxone/           Checkmarx One: auth, client (concurrency cap), projects, risks, initiators, AI ids
src/reminder.js      Findings → template data → email
src/html-report.js   The interactive report (+ src/report/report.client.js, which runs in it)
src/credits.js       Credit ledger (+ credit-allocations.js, credit-usage.js)
src/send-guard.js    One request per vulnerability at a time
src/audit-log.js     Hash-chained audit log
src/diagnostics.js   Privacy-safe troubleshooting log
src/automation.js    Age-threshold reminders
scripts/             backup, restore, reset-admin
loadtest/            Mock Checkmarx One and the benchmarks
```
