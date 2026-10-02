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

## Run it anywhere (Docker or Podman)

```
docker run -d --name mission-zero -p 3000:3000 -v mission-zero-data:/data ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

Swap `docker` for `podman` to use Podman. From a checkout you can instead run
`docker compose up -d` (or `podman compose up -d`).

Open <http://localhost:3000> and sign in with the administrator's email and
password, which `docker logs mission-zero` shows once, at first start. See
[docs/container.md](docs/container.md) for options, backups, upgrades and
proxies.

**Version.** Every screen shows the running version in its bottom-left corner,
as `MZ-xx.xx.xx` (from `version` in `package.json`, bumped with every change
merged to `main`). The server log prints it at start, and `/api/health` returns
it, so you can tell which image a container runs.

## The pages

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

**Only these projects or people.** A third row fetches just what you name instead of every
project: **Projects, by name** (suggestions as you type; Enter adds every project whose name
contains the text) and **People who ran the latest scan** (a username or an email address —
`sudha@acme.io` also finds scans recorded as `sudha`, and an override or a remembered address
counts too). A project named in either list is fetched. Named projects are fetched whatever
their last scan date, so *Projects last scanned in* is set aside while anything is named;
*Findings first detected in* still applies. Only the named projects' findings are read, so
this is also the quickest fetch. The names come from `GET /api/scope/options` (one project
listing plus one last-scan lookup per 50 projects, kept for five minutes).

The project table can then be searched by name, filtered by severity or age bucket,
sorted by any column, and used to select a subset. A reminder covers the selected
projects, or all of them if none are selected.

**Columns.** The table starts lean: project, total, oldest first detection, who ran the
latest scan, and credits. **Columns** adds the age buckets (≤ 30d, 31–60d, > 60d, no
date) and per-severity counts; the choice is kept in the browser. New optional columns
are one entry in `OPTIONAL_COLUMNS` in `public/app.js`. **Export CSV** downloads every
shown project with every column — chosen or not — and its credits (allocated, used, left
and needed).

**Fetching faster.** A fetch reads three things from Checkmarx One: the projects, who ran
each project's latest scan, and each project's findings. These run as wide as is safe:
initiators and findings are fetched at the same time, findings 10 projects at a time
(`CX_FETCH_CONCURRENCY`; every Checkmarx One call also shares a cap of 24 in flight,
`CX_MAX_CONCURRENCY`), and the page receives per-project summaries rather than every
finding (those stay on the server for reminders and reports). Against a simulated tenant
of 60 projects × 600 findings with 80 ms per call this took a fetch from 1.8 s to 0.7 s.
The biggest further savings are scope: **Projects last scanned in** skips idle projects
before any finding is read, and **Findings first detected in** is filtered by Checkmarx One
itself.

### Credits on the Dashboard: allocate, then triage or remediate

**Nothing is ever allocated on its own.** A fetch, a refresh, a triage verdict or a tracked
report only work out what each project *needs* for the ticked severities; the credit
columns show it as "N more needed". Credits move only when someone confirms it:

1. **AI Triage** — 1 credit per finding still to verify. **Allocate N for triage** gives the
   selected projects (or all shown) exactly what they lack; **Triage selected now** runs it.
   If you triage beyond what is allocated, the confirmation says how many credits you are
   allocating by confirming, and the audit log records them as yours.
2. **AI Remediation** — only for findings **confirmed** (that state, and only that state:
   never proposed not exploitable, never still to verify). Once triage has confirmed, say,
   3 of 10 findings, remediation needs 3 × 3 = 9 credits; **Allocate 9 for remediation**
   gives them. **Remediate selected** shows each project, its confirmed findings and the
   cost — 3 credits per confirmed vulnerability — and runs only after you confirm. It
   re-reads each finding's state in Checkmarx One first and leaves anything not confirmed
   alone. Developers get the results as when they click Remediate in their report: a pull
   request where the project is connected to a repository, otherwise the remediation
   details.

The same fence applies everywhere: the report's **Remediate** button is disabled until a
finding is confirmed, and the server refuses (and audits) a remediation request for any
other state whatever the report says.

Everything allocated comes out of the **credit pool** (Settings → AI & credits); an
allocation larger than what the pool has free is refused. Upgrading from a release that
allocated on its own removes those allocations once — each project keeps what it used and
any extra credits it was given and has not used — and records it in the audit log.

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

**A scan initiator only ever gets their own projects.** Select four projects where Sudha
ran the latest scan of two and Sean of the other two: Sudha's email — its summary, and the
interactive report attached to it — covers her two projects only, and Sean's his two. This
holds for every combination: summary or one per project, with or without the attached
report, from the Dashboard, from a tracked report's follow-up and from automatic
reminders, and with people picked in the Scan initiators panel (only they are mailed).
- The server checks every email before it goes: a message that would hold a project its
  recipient did not scan is refused, not sent.
- The configured **Cc / Bcc are not copied** on initiators' emails unless *Copy the
  configured Cc/Bcc on per-initiator emails* is ticked (Settings → Scan initiators).
- After sending, **who got which projects** is listed under the Send button.
- `test/initiator-scope.e2e.test.js` sends through a fake mail server and reads every
  message (and its attached report) back, for each of those combinations.

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

Everything is here, and everything can be changed at any time. **Changes save as you
type** — there is no Save button.

- **Quick setup from a .env file** — upload a `.env` and the variables it holds are applied:
  `CX_API_KEY`, `CX_BASE_URL`, `CX_IAM_URL`, `CX_TENANT`, `SMTP_HOST`, `SMTP_PORT`,
  `SMTP_SECURE`, `SMTP_REQUIRE_AUTH`, `SMTP_REJECT_UNAUTHORIZED`, `SMTP_USER`, `SMTP_PASS`
  (or `SMTP_PASSWORD`), `SMTP_FROM`, `SMTP_FROM_NAME` and `REPORT_SERVER_URL`. Each
  connection is checked at once. Variables that only mean something when the server starts
  (`PORT`, `DATA_DIR`…) are listed as not applied; secrets are never echoed back; the
  import is audited by variable name.
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

**Sending needs a mail server that passed a connection test.** The passing test is
fingerprinted against the exact connection settings, so changing the host, port,
user, password or TLS options needs a new test. Changing recipients or the template
does not.

**Last known good connections.** The Checkmarx One integration and the mail server are
the two settings that can stop the utility, so a change to either is checked before it
counts:

- Typing saves the new values and checks them after a short pause. Until they work, the
  **last known good** ones keep running: reports and automation keep the previous
  Checkmarx One connection, and reminders keep sending through the previous mail server.
- A check that passes makes the new configuration the last known good one.
- **Leaving Settings** checks what is still pending. A configuration that does not work —
  wrong key, wrong host, or a connection that times out (`CONNECTION_CHECK_TIMEOUT_MS`,
  25 s by default) — is **rolled back** to the last known good one, with a message saying
  what failed and what is back in use (tenant, API and IAM URLs; mail server, user and
  From address).
- If nobody was there to see it — the tab was closed mid-edit, the browser lost the
  connection, or the server restarted — the server checks on its own (after
  `CONFIG_ROLLBACK_IDLE_MINUTES`, 10 by default, or at start-up), and every administrator
  sees the same message as a pop-up at their next sign-in, once.
- A failure of the configuration that *is* the last known good one is an outage, not a
  bad change: it is reported, never "rolled back" to itself.
- Every check and rollback is in the audit log. The last known good configuration is kept
  in `connection-guard.json` in the state folder (owner-only; it holds the key and password
  like `settings.json` does).

**The credit pool** (Settings → AI & credits) is the master limit: the most the utility may
spend on AI Triage and AI Remediation together, refilled on the 1st of each month (UTC) or
as one pool that does not refill. It shows what was used — split into triage and
remediation — what is left, what is given to projects and not used yet, and what is still
free to give. Every allocation comes out of it, and spending stops when it is used up.
0 means no limit. Only an Admin can change it (`credits.limit`).

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

### Automation uses the server's connections

Unattended runs use the server's **Checkmarx One integration** (`CX_API_KEY`, or the key an
Admin connected under Settings → Checkmarx One integration) and its mail server. The
panel shows both as they are now — connected and to which tenant, whether the mail server
passed its test — and updates as soon as either changes. Without a connection the schedule
still runs, but every pass is skipped with that reason recorded.

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
goes through this server, which runs AI Triage and AI Remediation on its own
stored Checkmarx One connection (`CX_API_KEY`, or the key an Admin stored).
Readers need no key and nothing to install; Checkmarx One records the triage
under the server's account.

**From the email to fixing.**
- **The button.** The email's **Let's start fixing the vulnerabilities** button
  downloads the same interactive report that is attached. Mail clients cannot
  link to an attachment, so the server keeps each emailed report and the button
  downloads it through a signed link.
  - The link works for 30 days, the life of the report's permissions.
  - A changed or made-up link gets nothing.
  - Each download is recorded in the audit log.
  - Without a reminder server address, the button opens the project in Checkmarx
    One instead.
- **Opening the report.** The downloaded file, or the attachment itself, connects
  to the reminder server as soon as it is opened.
  - If it cannot, it says why and offers **Connect** to try again, or **Change
    address** if the server moved.
  - **Connect to CxONE for action** in the header does the same.

- **Administrator control.** Nothing runs until allowed under **Settings → AI
  Triage & Remediation from reports**, with separate switches for triage and
  for remediation (which can open pull requests). The **credit pool** covers both
  and is enforced before each request (concurrent requests cannot overrun it
  together). Whether Remediate runs AI Remediation is fixed
  when a report is generated; the server re-checks the switch on every request.
- **Costs.** AI Triage uses 1 credit per finding, AI Remediation 3.
  - One finding here means one Checkmarx One result: rows that share a result,
    such as the same vulnerability listed twice, are triaged and counted once.
- **Allocations.** A project can spend only what someone allocated to it on the
  Dashboard (see *Credits on the Dashboard*); nothing is allocated on its own.
  What it *needs* follows the severities its rule covers (critical and high by default):
  - **Triage:** 1 for each finding still to triage.
  - **Remediation:** 3 for each **confirmed** finding not yet remediated. Remediate
    is disabled in the report, and refused by the server, for any other state.
  - **Triaged findings are never counted again.** A finding sent for AI Triage
    stays "To verify" while it runs, and after a vulnerable verdict. The credit
    ledger records every result sent for triage, so it is not counted as "still
    to triage" again and what is needed does not jump while AI Triage runs.
  - **Re-triage is refused while re-triage is off,** from the report, the
    dashboard and tracked reports alike, so it is never charged twice.
  - `test/credits-lifecycle.e2e.test.js` checks allocation, use and the audit
    trail after every stage: fetch (nothing allocated), allocating for triage,
    triage, a second triage attempt, verdicts (still nothing allocated),
    allocating for remediation, the confirmed-only fence, remediation and its
    repeat, **Remediate selected**, duplicate rows, the pool limit, and
    reconciliation.
- **Not exploitable is left out.** Findings marked not exploitable, or proposed
  not exploitable, never appear in HTML reports or reminders, including
  automatic ones.
  - This covers the live Checkmarx One state, and AI Triage's verdict while the
    state still reads "To verify".
  - A finding triaged from an open report disappears from it as soon as that
    verdict arrives, and the report counts how many it has hidden.
  - Switch this off under the same Settings panel.
- **No verdict.** If Checkmarx One has produced no AI Triage result for a finding
  6 minutes after it was sent, the report says "No verdict" instead of
  "Triaging…" forever, and keeps checking.
  - An SCA finding is only triaged as its own package version. If the latest
    scan only has that vulnerability in another version, it is reported as not
    found rather than triaged (and charged) as the other version.
- **Live usage.** The **Credits** page (every signed-in user with `credits.view`)
  shows the pool, usage over any period — by day, week or month, triage against
  remediation, with a table view and CSV export — usage by project, and each
  project's allocated vs used. This is the utility's own
  count — one credit per finding in each request Checkmarx One accepted as a new
  job — kept in `triage-credits.json` in the state folder; it is not Checkmarx One's billing.
- **Results.** The report shows AI Triage's verdict and each finding's live
  Checkmarx One state — the one Risk Hub shows — which is what settles when AI
  Triage finishes (its own record can lag behind, or be missing for grouped SAST
  findings).
- **Reminder server address.** Every report carries the address readers'
  browsers use to reach this server, shown at the top of the report.
  - **Where it comes from:** **Settings → Reminder server address**, else
    `REPORT_SERVER_URL`, else the address the dashboard is open on. Automatic
    reminders use the same address, falling back to the last one an
    administrator used.
  - **Warnings:** the Settings page and the dashboard warn when the address is
    `localhost` (no one else can reach it) or plain http. **Test** checks that
    it answers as this server.
  - **In the report:** readers can enter or correct the address (**Change** /
    **Enter address**). The report checks that it really is a reminder server
    before using it. The correction is remembered in that browser for every
    report sent with the same original address, so a moved server is fixed
    once. A report sent without an address can still be connected this way.
  - **Private networks:** browsers that ask before a page opened from disk
    calls a company-network address get the server's consent header.
    Use HTTPS.
- **Scope.** Each finding in a report carries a signed grant, valid for 30 days;
  the server acts only on findings with a valid grant, so it cannot be used to
  triage anything a report did not list. The signing key is kept in
  `report-signing.key` in the state folder, or set `REPORT_SIGNING_KEY`.

## Credits page

For everyone who can sign in (`credits.view`, which every built-in role has): how the credit
pool is being used, so the Settings page stays about settings.

- **Filters**, one row above everything they scope: last 7 / 30 / 90 days, this or last
  month, last 12 months or a custom range; grouped by day, week or month (automatic by the
  length of the period); one project or all.
- **Credit pool**: size, used (triage / remediation), remaining, given to projects and not
  used, free to give — as tiles and as one bar.
- **Credits used over time**: totals for the period, then a stacked column per day / week /
  month (triage at the base, remediation on top; hover or focus a column for its numbers),
  with **Show as a table** for the exact figures and a running total.
- **By project, in this period**: each project's triage and remediation credits, with its
  share.
- **Allocated vs used**: per project, all time — first allocated, allocated now, used and
  left, for triage and remediation, with a filter.
- **Export CSV** downloads the period's series, the by-project figures and the allocations.

Data: `GET /api/credits/usage?from=YYYY-MM-DD&to=YYYY-MM-DD&bucket=day|week|month&projectId=`
(UTC, at most two years), built from the credit ledger.

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

## Access control

Every person signs in, and has one **role**: a set of permissions covering every
part of the utility. Admins and Security Analysts manage people and roles on the
**Access** page; it is hidden from Users.

| Role | Can |
| --- | --- |
| **Admin** | Everything, including the Admin-only permissions below |
| **Security Analyst** | Everything except the Admin-only permissions, including people and roles |
| **User** | Fetch findings, send reminders, follow tracked reports and send their follow-ups, see credits; Settings read-only; no Access, Audit or Beta |

The Admin-only permissions are:

- **Checkmarx One integration:** the server's own API key and endpoints.
- **Email server (SMTP).**
- **The credit pool:** its size and whether it refills monthly, on the Settings page.
- **Download and restore backups:** a backup holds the SMTP password, the
  integration key and every user, so handing it out is as powerful as the other three.

Analysts still allocate credits to projects, out of the pool. Uploading a `.env` file
sets only the variables the person's own permissions cover; the rest are refused.

**Permissions.** There are 29 of them, in groups: Dashboard, Tracked reports,
AI & credits, Settings (one per section), Integrations, Audit & data, Beta and
Access.
- Every API route checks them on the server; the screens only hide what the server
  would refuse anyway.
- A settings save keeps only the sections the person may change.
- The **Access** page shows a matrix of permissions against roles. You can change
  what Security Analyst and User may do, or create your own roles. The Admin role
  is fixed and always holds everything.

**Nobody can grant more than they hold.**
- A person can only assign a role, or build one, whose permissions they all have.
- They can only change or remove people whose role they could have assigned.
- So an analyst can manage Users and other analysts, but cannot create an Admin,
  promote anyone to Admin, or touch an Admin's account.
- Nobody can change their own role or disable themselves, and there is always at
  least one active Admin.

**Signing in.**
- **Email and password.**
  - Passwords are hashed with scrypt and need at least 12 characters.
  - Five wrong attempts lock the account for 15 minutes, and a single address is
    slowed down after 30 attempts.
  - When an Admin or Analyst sets a temporary password, the person must choose
    their own at next sign-in.
  - People who sign in this way reach Checkmarx One through the server's
    integration (**Settings → Checkmarx One**, Admin).
- **Checkmarx One API key.**
  - The key's identity (email, username or client id) must be listed against a
    person on the Access page. The person's email always counts.
  - The key must be for the integration's tenant.
  - The session then calls Checkmarx One with that person's own key.

Disabling or removing someone ends their sessions at once, and a role change
applies on their next click.

**First start.**
- With no users yet, the server creates an administrator and prints its email and
  a generated password once in its log (or the container log). The administrator
  chooses their own password at first sign-in.
- `ADMIN_EMAIL` sets that email. `ADMIN_PASSWORD` sets the password instead of
  generating one.
- Lost it? `node scripts/reset-admin.mjs` sets a new temporary one. It works
  while the server runs, and the reset is audited.
- `FIRST_ADMIN=setup-code` restores the older flow: create the first
  administrator in the browser with a one-time code from the log.

**Audit.** Sign-ins (and refusals and lockouts), people and role changes, and
integration changes are recorded in the audit log (types `access` and `iam`).
Credit events carry the person's email, role and how they signed in.

## Where things are stored

All state lives in **one folder outside the project**, so redeploying or
replacing the code never touches it and one backup rebuilds the server:
`DATA_DIR`, default `~/.mission-zero` (the service user's home). The first start
after upgrading copies an old in-project `data/` folder there once, and leaves the
old copy in place.

| | File in the state folder | Survives restart |
| --- | --- | --- |
| A person's own Checkmarx One API key (key sign-in) | server memory, per session | no |
| SMTP password, recipients, template, credit settings, the integration key | `settings.json`, mode `0600` | yes |
| **Users, roles and permissions** (passwords as scrypt hashes) | `iam.json` | yes |
| Credit ledger (every credit spent) | `triage-credits.json` | yes |
| Per-project credit allocations | `credit-allocations.json` | yes |
| Last known good connections, rollback notices | `connection-guard.json` | yes |
| **Audit log** (append-only, hash-chained) | `audit/audit-YYYY-MM.jsonl` + `audit.key` | yes |
| Tracked reports | `tracked-reports.json` | yes |
| Resolved initiator addresses | `known-initiators.json` | yes |
| Report signing key | `report-signing.key` | yes |
| Automation state | `automation-state.json` | yes |
| Scan results | server memory, per session | no |

See [docs/audit-and-backup.md](docs/audit-and-backup.md) for the audit log,
backups and rebuilding a server from scratch.

A key someone signs in with is never written to disk, never logged, and never sent
back to the browser — the browser holds only an opaque `HttpOnly` session cookie.
**Sign out** ends the session; idle sessions expire after `SESSION_IDLE_MINUTES`
(default 8h). The server's own integration key, which an Admin stores under
**Settings → Checkmarx One**, is kept in `settings.json` like the SMTP password.

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

## Security

- **Dependencies:** `npm audit` reports no known vulnerabilities; the image installs
  production dependencies only, and the runtime image carries no package manager.
- **Headers on every response:** a Content Security Policy that allows only this
  server's own scripts (the one inline snippet is allowed by its hash), no framing
  (`frame-ancestors 'none'`, `X-Frame-Options: DENY`), `nosniff`, `same-origin`
  referrers, a restrictive `Permissions-Policy`, HSTS over HTTPS, no `X-Powered-By`.
- **Cross-site requests:** besides the `SameSite=Lax`, `HttpOnly` session cookie
  (`Secure` over HTTPS), a request that changes anything must come from this server's
  own pages — a POST/PUT/PATCH/DELETE whose `Origin` (or `Referer`) names another site
  is refused. The report relay is exempt by design: it is called from reports opened
  from disk, and every action there needs a signed per-finding grant instead.
- **Input:** role ids and initiator overrides never resolve to an object's built-in
  properties (`__proto__`, `constructor`); email checks are capped at 254 characters so
  no input can make them backtrack; links built from Checkmarx One or relay data are
  `http(s)` only; template triple braces render raw only when balanced.
- **Container and CI:** the image runs as `node`, is built in two stages, takes the
  latest Alpine fixes (`apk upgrade`), and runs in CI with a read-only root, no Linux
  capabilities and `no-new-privileges` (as `compose.yaml` does). GitHub Actions are
  pinned to commit SHAs, with read-only permissions except where publishing needs
  `packages: write`, and checkouts do not keep credentials.

## Operational notes

- **Everyone signs in.** There is no shared session: even with `CX_API_KEY` set,
  the UI does nothing until someone signs in, and each person can do only what
  their role allows (see [Access control](#access-control)). Serve it over HTTPS
  (a reverse proxy) when it leaves `127.0.0.1`, so passwords and session cookies
  are encrypted in transit.
- **A project whose risks cannot be read is reported inline** in its table row, rather
  than failing the whole fetch.
- **Scan results are held in memory** between fetching and sending, so a reminder
  always reflects exactly the list you were looking at.
