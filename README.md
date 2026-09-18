# Checkmarx One — Detection Date Reminder

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

The **Scan initiators** panel lists everyone found in the current results with their
project and finding counts. Tick **any number** of them to narrow the table and the
reminder; ticking none includes everyone. *Select all*, *Clear* and *Only those missing
an email* are there for the common cases.

Anyone whose address could not be resolved gets an inline field: type an address, press
Save, and it is applied to the current results immediately **and** stored as an override
so future fetches resolve it without asking again. Tagging one person never disturbs the
others.

**Send as → One email per scan initiator** then addresses each person directly. Someone
who owns five projects gets a single message covering all of their open findings, not
five messages. Anyone still without an address is reported as skipped — with their
finding count — rather than silently dropped.

Checkmarx records the initiator as a username, which is not always an address, so
resolution is layered (Settings → Scan initiators):

1. an email already on the scan record
2. the username, when it is itself an address
3. an explicit `username = email` override
4. the tenant's IAM directory, if the API key has IAM read access
5. a default domain appended to the username

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

## Links into Checkmarx One

Every finding in the reminder is a hyperlink straight to it in the platform, so the mail
is a ready reckoner: click a row and start fixing. Project names link to the project
overview, in the mail and in the dashboard table. The plain-text part carries the same
URLs, for clients that strip HTML.

The web app's routes are **not** part of the published API reference, so the defaults
below are best-effort and a tenant may differ:

| | Default |
| --- | --- |
| Project | `{baseUrl}/projects/{projectId}/overview` |
| Finding | `{baseUrl}/results/{scanId}/{projectId}/{engine}?result-id={riskId}` |

Both are editable under **Settings → Links into Checkmarx One**, which renders a worked
example as you type — so if a link lands in the wrong place, you can see and fix it
without sending a mail to find out. `{baseUrl}` defaults to the API host your key
resolved to; set it explicitly if your UI is served elsewhere. Available placeholders
are `{baseUrl}`, `{projectId}`, `{scanId}`, `{engine}` and `{riskId}`.

Engine names map to the UI's tabs (`SAST`→`sast`, `SCA`→`sca`, `IAC`→`kics`). Every
substituted value is URL-encoded, which matters because a risk id such as
`cye0DZkmtm6xwMN4J1Td3BKw03o=` contains `/`, `+` and `=`. Only `http`/`https` links are
ever emitted. A finding with no scan falls back to its project overview, and if no base
URL can be resolved the mail still renders — just without links, rather than with broken
ones.

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

| | Where | Survives restart |
| --- | --- | --- |
| Checkmarx API key | server memory, per session | no |
| SMTP password | `data/settings.json`, mode `0600` | yes |
| Recipients, template, endpoint | `data/settings.json` | yes |
| Scan results | server memory, per session | no |

The API key is never written to disk, never logged, and never sent back to the
browser — the browser holds only an opaque `HttpOnly` session cookie. **Disconnect**
destroys the session; idle sessions expire after `SESSION_IDLE_MINUTES` (default 8h).

The SMTP password *is* stored, because a mail server has to be reachable without
someone re-typing it. `data/` is gitignored and written owner-only. The password is
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
