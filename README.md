# Mission Zero — Checkmarx One reminders, triage and tracking

A small self-hosted utility that answers one question: **which vulnerabilities have
been sitting unfixed, and for how long?** — then emails the right people about them
through your own SMTP server, using a message template you control.

```bash
npm install
npm start          # http://127.0.0.1:3000
```

Nothing needs configuring on disk. Open the portal, paste a Checkmarx One API key,
and set everything else up on the Settings page.

Run the tests with `npm test`.

---

## The two pages

### Dashboard

Pick a **scope**, click **Fetch vulnerability data**, and every project comes back
bucketed by how long ago each finding was *first detected*:

| Bucket | Meaning |
| --- | --- |
| `≤ 30 days` | first detected in the last 30 days |
| `31–60 days` | first detected 31–60 days ago |
| `> 60 days` | first detected more than 60 days ago — nobody has touched these |

Two independent scope filters narrow the work before the fetch runs:

- **Projects last scanned in** — skips projects with no scan in the window, so the
  fetch makes fewer API calls.
- **Findings first detected in** — passed to the API as `fromDate`/`toDate`, so
  Checkmarx filters server-side instead of the tool downloading and discarding.

Both offer last week / last month / last 90 days / last year / custom range. A short
detection window empties the older age buckets by definition; the UI says so when you
pick one.

The project table can then be searched by name, filtered by severity or age bucket,
sorted by any column, and used to select a subset. A reminder covers the selected
projects, or all of them if none are selected.

**The age buckets are a filter, not a requirement.** Leave all three unticked and
findings of any age are included, so a selection of projects or initiators is enough on
its own to send.

### Scan initiators

Each project shows **who ran its latest scan** and the email that resolved to. After a
rescan it is the latest scan that counts, so the reminder follows whoever ran it most
recently, not whoever ran it first.

The **Scan initiators** panel only takes up room when it has something to say. When every
initiator has an address and you have not narrowed the list, it collapses to a single
line — *"All 11 scan initiators have an email address"* — with a link to open it, since
the rows double as the filter for who a reminder goes to. Anything needing attention
sorts to the top and keeps the panel open.

Anyone whose address could not be resolved gets an inline field: type an address, press
Save, and it is applied to the current results immediately **and** stored as an override
so future fetches resolve it without asking again. Tagging one person never disturbs the
others.

**Send as** offers three shapes, and the recipient list is edited right there rather
than on the Settings page:

| Mode | Result |
| --- | --- |
| One email to the list | Everything in one message |
| One per developer | Someone with four projects gets **one** message covering all four |
| One per project | Someone with four projects gets **four** messages, each naming its project |

Either of the per-person modes can add **…plus a consolidated copy to the list**, so the
developers get their own messages *and* a lead gets the whole picture in one. The
recipient list is its own block below, so it is clear when it applies.

Anyone still without an address is reported as skipped — with their finding count —
rather than silently dropped.

Age is **not** asked for again here: the Scope panel at the top of the page already
decided it.

Checkmarx records the initiator as a username, which is not always an address. Most of
the work is done for you:

1. an email already on the scan record, or a username that *is* an address
2. an explicit `username = email` override
3. the tenant's IAM directory — fetched **once** and matched locally, by username,
   email local part or full name
4. **the naming pattern your own tenant reveals.** If `avery.speller@checkmarx.com` is
   already known, then `cx-julian-chuan` is almost certainly
   `julian.chuan@checkmarx.com`. That suggestion is pre-filled with a **Confirm**
   button — one click, no typing, and it needs no IAM permission at all.

A suggestion is never applied silently: only an exact match (directory, override or an
address-shaped username) resolves on its own. Anything inferred waits for a human.

You are also only asked where it matters. **With projects selected, only those projects'
initiators are prompted for**; the rest are dimmed as "not needed for the current
selection".

Where the initiator comes from, in order: `/api/projects/last-scan` (bulk, one call per
50 projects), then `/api/scans?project-id=…` for anything it did not cover. The
`/projects` overview endpoint documented as *"Get overview for the tenant projects"* is
**deprecated and returns 410 Gone**, so it is only consulted as a last resort and its
410 is reported as a plain note rather than an error.

### Settings

Everything is here, and everything can be changed at any time:

- **Checkmarx One connection** — what the API key resolved to; swap keys from here.
- **SMTP server** — your own mail server. **Test connection** runs a real handshake
  (and authentication) without sending anything; **Send test email** proves delivery
  end to end.
- **Recipients** — To / Cc / Bcc lists that receive every reminder.
- **Mail template** — subject and HTML body, with a live preview.
- **Risks endpoint** — the API path, with a **Detect** probe.

**Port and TLS mode are paired.** Port 465 speaks TLS from the first byte
("Implicit TLS"); ports 25, 587 and 2525 start in plaintext and upgrade with
STARTTLS. Picking one sets the other, because the wrong combination does not fail
cleanly — the handshake stalls and surfaces fifteen seconds later as a connection
timeout that reads like a firewall problem. A mismatch reaching the form some other
way is flagged inline, and the test result names it rather than blaming the network.

**Gmail:** `smtp.gmail.com`, port 587, Implicit TLS **off**. Gmail does not accept an
account password over SMTP at all — you need a 16-character
[App Password](https://myaccount.google.com/apppasswords), and the username must be the
full address of the account that App Password belongs to. Google displays the password
as four space-separated groups; pasting it with the spaces is fine, they are stripped.
Leave *From address* blank to use the authenticated account, which Gmail requires
anyway.

**Sending is locked until an SMTP connection test passes.** The passing test is
fingerprinted against the exact connection settings, so changing the host, port,
user, password or TLS options re-locks it until you test again. Changing recipients
or the template does not.

---

## Automation

**Settings → Automation** turns the tool into a watcher: it checks on a timer and mails
the moment a finding crosses one of your age thresholds (30 / 60 / 90 by default, or any
list you type).

The interesting problem is not the timer, it is **not nagging**. A daily sweep would
otherwise re-send the same finding every day once it passed 30 days. So each
*(finding, threshold)* pair is recorded in a ledger once reported, and only unrecorded
pairs are mailed:

| Situation | What happens |
| --- | --- |
| Finding reaches 30 days | One message |
| Same finding next day, still 30+ | Silence |
| It reaches 60 days | One message |
| It is already 200 days old on the first run | **One** message, against the highest threshold passed — not three |
| It gets fixed | Dropped from the ledger |
| It comes back | Reported again, as a genuine regression |

The ledger is persisted, so a restart does not cause duplicate mail. **Reset history**
clears it if you want the next run to report from scratch. *Report each threshold once*
is the recommended mode; *digest* re-reports everything past a threshold on every run.

Runs are addressed per scan initiator or to the configured list, can be limited to
chosen severities, and **Dry run** decides and logs without sending — worth using for the
first pass, since an established tenant will have a backlog that all crosses at once.
The panel shows the last runs with what was scanned, crossed and sent.

### Automation needs a stored credential

The API key is normally per-session and memory-only. An unattended run has no browser to
paste one into, so it needs a credential that outlives a session. Two ways:

- **`CX_API_KEY` in the environment** — preferred. The key stays out of the settings file
  and out of the UI.
- **Arm with current key** — stores this session's key in `settings.json` in the state folder
  (owner-only, gitignored) so runs can authenticate. **Forget stored key** revokes it.

Without either, the schedule still runs but every pass is skipped with that reason
recorded, and **Run once now** falls back to your own session so you can rehearse first.
The panel states plainly which of the three situations you are in.

---

## Triage from the emailed report

The report attached to reminder mails lists the top 50 findings with their
Checkmarx One state. **Triage**, **Triage all critical** and **Triage all high**
run Checkmarx One AI Triage; the "all" buttons cover every critical or high
finding in the report, across all of its projects, and skip findings already
triaged in Checkmarx One. **Remediate** runs Checkmarx One AI Remediation and
then offers the suggested fix: its summary, the pull request Checkmarx One opened
(for repository-connected projects), a link to the finding in Risk Hub, and the
code change as a downloadable patch. When remediation is not allowed, Remediate
simply opens the finding in Risk Hub.

Checkmarx One refuses API calls from a page opened as a file, so the report
goes through this server: **Connect to CxONE for action** connects to it, and it
runs AI Triage and AI Remediation on its own stored Checkmarx One connection (`CX_API_KEY`, or the
key armed for automation). Readers need no key and nothing to install; Checkmarx
One records the triage under the server's account.

- **Administrator control.** Nothing runs until allowed under **Settings → AI
  Triage & Remediation from reports**, with separate switches for triage and
  for remediation (which can open pull requests). An optional **monthly credit
  limit** covers both and is enforced before each request (concurrent requests
  cannot overrun it together). Whether Remediate runs AI Remediation is fixed
  when a report is generated; the server re-checks the switch on every request.
- **Costs.** AI Triage uses 1 credit per finding, AI Remediation 3.
- **Not exploitable is left out.** Reminders and reports (including automatic
  ones) leave out findings triaged as proposed not exploitable or not
  exploitable, by their live Checkmarx One state at send time — so triage run
  just before sending counts. Switch this off under the same Settings panel.
- **Live usage.** The same panel lists the credits used per project for any
  month — triage, remediation and total — refreshing every 15 seconds while it
  is open. This is the utility's own
  count — one credit per finding in each request Checkmarx One accepted as a new
  job — kept in `triage-credits.json` in the state folder; it is not Checkmarx One's billing.
- **Results.** The report shows AI Triage's verdict and each finding's live
  Checkmarx One state — the one Risk Hub shows — which is what settles when AI
  Triage finishes (its own record can lag behind, or be missing for grouped SAST
  findings).
- **Reachability.** Set **Settings → Reminder server address for reports** to an
  address recipients' browsers can reach (use HTTPS).
- **Scope.** Each finding in a report carries a signed grant, valid for 30 days;
  the server acts only on findings with a valid grant, so it cannot be used to
  triage anything a report did not list. The signing key is kept in
  `report-signing.key` in the state folder, or set `REPORT_SIGNING_KEY`.

## Tracked reports

**Save as tracked report** (under the project table) saves the current scope —
the project and first-detection windows, the selected projects (or every shown
one), and the severity and age filters — with a baseline of the findings it
covers. The **Tracked reports** tab then follows each report:

- what happened to the baseline findings, from their live Checkmarx One state:
  awaiting triage, confirmed, not exploitable (proposed or confirmed), or no
  longer detected — with the share triaged or resolved and how many changed
  since the report was saved;
- how many findings the same filters match now, and how many of those are new
  (relative windows such as "last 90 days" are re-evaluated each time);
- AI Triage / Remediation credits used on its projects since it was saved;
- a per-project breakdown and a history of readings.

Each report also has **Follow up**:

- **Send a reminder** about its open findings (baseline findings awaiting
  triage or confirmed, plus new ones its filters match) — to scan initiators,
  the recipient list, or both; one summary per person or one email per project;
  optionally with the interactive HTML report attached. **Preview** first.
- **Automatic reminders** every N days at a set hour (UTC), with the same
  options, only while something is still open. Each send is listed with the
  report.
- **Triage now**: AI Triage on its findings still awaiting triage, for the
  chosen severities, within each project's credits.

Reports update hourly, and every few minutes for half an hour after anyone
triages or remediates in one of their projects (from a report or the
dashboard); the tab refreshes itself while open. Background updates use the
server's stored connection (`CX_API_KEY`, or automation armed); **Refresh**
works any time. Data is kept in `tracked-reports.json` in the state folder.

## Links into Checkmarx One

Every finding in the reminder is a hyperlink straight to it in the platform, so the mail
is a ready reckoner: click a row and start fixing. Links open **Risk Hub**, where findings
are triaged and remediated: project names open the project's Risk Hub, and each finding
opens Risk Hub with that finding's details panel open. Recipients sign in with their normal
Checkmarx One login. The plain-text part carries the same URLs, for clients that strip HTML.

The web app's routes are **not** part of the published API reference, so the defaults
below are best-effort and a tenant may differ:

| | Default |
| --- | --- |
| Project | `{baseUrl}/riskhub/{projectId}` |
| Finding | `{baseUrl}/riskhub/{projectId}?pagination=…&grouping=…&resultId={riskId}` |

Both are editable under **Settings → Links into Checkmarx One**, which renders a worked
example as you type — so if a link lands in the wrong place, you can see and fix it
without sending a mail to find out. Settings saved with the earlier defaults (the
`/projects/…/overview` and `/results/…` routes) move to these automatically; customised
links are kept. `{baseUrl}` defaults to the API host your key resolved to; set it
explicitly if your UI is served elsewhere. Available placeholders are `{baseUrl}`,
`{projectId}`, `{scanId}`, `{engine}` and `{riskId}`.

Engine names map to the UI's tabs (`SAST`→`sast`, `SCA`→`sca`, `IAC`→`kics`). Every
substituted value is URL-encoded, which matters because a risk id such as
`cye0DZkmtm6xwMN4J1Td3BKw03o=` contains `/`, `+` and `=`. Only `http`/`https` links are
ever emitted. With a template that uses `{scanId}`, a finding with no scan falls back to its
project link, and if no base URL can be resolved the mail still renders — just without
links, rather than with broken ones.

---

## What the mail looks like

Every reminder opens with your logo (Settings → Branding), then a headline count, a
**summary band of critical / high / medium / low**, and your call-to-action message —
so the recipient sees the shape of the problem before the detail. Then the findings,
each linking straight into Checkmarx One.

A single-project mail is titled with the project name and subject-prefixed `[Project]`;
a multi-project one is not. The subject always carries the age of the oldest finding,
since that is the number that prompts action.

Branding takes a company name, an `https` logo URL (or an inline `data:` image), a
height, an accent colour and the call-to-action text. A logo over plain `http`, or any
other scheme, is rejected — mail clients block it, and it would be a way to smuggle a
script URL into a message sent to other people. The Settings page previews the header
exactly as recipients will see it.

---

## The mail template

The body is yours to decide. Values are inserted with `{{name}}` and HTML-escaped;
`{{{name}}}` inserts raw HTML. Lists repeat with `{{#projects}}…{{/projects}}`, and
`{{^projects}}…{{/projects}}` renders only when something is empty.

```html
<h2>{{totalRisks}} findings across {{projectCount}} projects</h2>
{{#projects}}
  <h3>{{projectName}} — {{riskCount}} open</h3>
  {{#risks}}
    <p>[{{severity}}] {{title}} — first detected {{firstDetectedAt}} ({{ageDays}}d)</p>
  {{/risks}}
  {{#hiddenCount}}<p>…and {{hiddenCount}} more.</p>{{/hiddenCount}}
{{/projects}}
```

`{{initiator}}` and `{{initiatorEmail}}` are set on per-initiator sends, so a template
can greet the recipient by name; inside `{{#projects}}` there is also
`{{initiator}}` and `{{lastScanDate}}` for that project.

A section body can see both the current item and everything outside it, so
`{{projectCount}}` still works inside `{{#projects}}`. The full variable list is in
the editor under **Available variables**.

There is no expression evaluation — a name is a dotted path, nothing more. Finding
titles and project names come from Checkmarx and are always escaped, so a crafted
finding name cannot inject markup into the mail.

---

## Checkmarx One API

**Authentication.** The API key is a JWT whose `iss` claim names your tenant and
region, so the IAM URL, tenant and API host are derived from it — the connect screen
shows what it detected before you commit. Connecting exchanges the key for a token
(proving the key and IAM URL) and makes one cheap `/api/projects` call (proving the
derived API URL), so a wrong host reports differently from a bad key. Single-tenant
and on-prem deployments can set all three by hand under **Advanced**.

**Risks.** `GET /api/risks/` with a required `projectId`, paged at the documented
maximum of 200, sorted by `firstDetectionDate` ascending. The first-detection date
comes from `firstDetectionDate`, which the API documents as RFC3339 *or* a unix
timestamp — both are handled. Point the path at `/api/risks/ai-insights` to pull AI
triage and remediation status alongside each finding.

**The Accept header carries the API version** (`application/json; version=1.0`).
Without it the gateway answers `400 Bad Request` — this was the cause of the original
"400" on every call.

If a path is wrong for your tenant, **Detect** on the Settings page probes the known
candidates and prints the status and response body for each, then fills in whichever
answered. An unknown path can come back as `400`, `403`, `404` or `405` depending on
how your gateway is fronted, so all of those mean "try the next candidate" rather than
failing the fetch. `CX_RISK_SOURCE=scan-results` falls back to reading `firstFoundAt`
from each project's latest completed scan, for tenants without the risks service.

---

## Where things are stored

All state lives in **one folder outside the project**, so redeploying or
replacing the code never touches it and one backup rebuilds the server:
`DATA_DIR`, default `~/.mission-zero` (the service user's home). The first start
after upgrading copies an old in-project `data/` folder there once, and leaves the
old copy in place.

| | File in the state folder | Survives restart |
| --- | --- | --- |
| Checkmarx API key | server memory, per session | no |
| SMTP password, recipients, template, credit settings | `settings.json`, mode `0600` | yes |
| Credit ledger (every credit spent) | `triage-credits.json` | yes |
| Per-project credit allocations | `credit-allocations.json` | yes |
| **Audit log** (append-only, hash-chained) | `audit/audit-YYYY-MM.jsonl` + `audit.key` | yes |
| Tracked reports | `tracked-reports.json` | yes |
| Resolved initiator addresses | `known-initiators.json` | yes |
| Report signing key | `report-signing.key` | yes |
| Automation state | `automation-state.json` | yes |
| Scan results | server memory, per session | no |

See [docs/audit-and-backup.md](docs/audit-and-backup.md) for the audit log,
backups and rebuilding a server from scratch.

The API key is never written to disk, never logged, and never sent back to the
browser — the browser holds only an opaque `HttpOnly` session cookie. **Disconnect**
destroys the session; idle sessions expire after `SESSION_IDLE_MINUTES` (default 8h).

The SMTP password *is* stored, because a mail server has to be reachable without
someone re-typing it. The state folder is created `0700` and its files `0600`. The password is
never returned to the browser: the settings form shows only whether one is set, and
saving an unrelated field leaves it untouched.

---

## Layout

```
public/            Single-page UI (no build step): dashboard + settings
src/server.js      Express API
src/session.js     Per-browser Checkmarx connection + session cookie
src/settings.js    Persisted administrator settings, with SMTP fingerprinting
src/mailer.js      SMTP transport, connection test, sending
src/template.js    Safe template renderer + the default template
src/reminder.js    Turns selected findings into template data and a message
src/window.js      Time-window presets and custom ranges
src/cxone/         Auth, HTTP client, projects, risks, initiators, endpoint discovery
```

`.env` is optional; see [`.env.example`](.env.example) for the handful of
deployment-level settings (port, bind address, concurrency, on-prem URL overrides,
and an optional `CX_API_KEY` bootstrap for headless deployments).

---

## Operational notes

- **No authentication in front of the UI.** It binds to `127.0.0.1` for that reason.
  Anyone who can reach the port can use a connected session and send mail as your
  SMTP user, so put it behind a reverse proxy with auth before exposing it.
- **A project whose risks cannot be read is reported inline** in its table row, rather
  than failing the whole fetch.
- **Scan results are held in memory** between fetching and sending, so a reminder
  always reflects exactly the list you were looking at.
