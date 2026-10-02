# Mission Zero user guide

Everything you can do in Mission Zero, page by page, with every option explained.

**Who needs which part**
- Developers who only receive emails need [The emailed report](#the-emailed-report).
- Administrators setting it up start with [Set up in 10 minutes](#set-up-in-10-minutes).

**Contents**
1. [Who can do what](#who-can-do-what)
2. [Sign in](#sign-in)
3. [Set up in 10 minutes](#set-up-in-10-minutes) (Admin)
4. [Settings, option by option](#settings-option-by-option)
5. [Dashboard: fetch, credits, remind](#dashboard)
6. [The emailed report](#the-emailed-report) (for developers)
7. [Reports: tracked reports](#reports-tracked-reports)
8. [Credits page](#credits-page)
9. [Audit page: credit audit log and backups](#audit-page)
10. [Access page: people and roles](#access-page)
11. [Beta page](#beta-page)
12. [Logs page](#logs-page)
13. [Everyday recipes](#everyday-recipes)
14. [Troubleshooting](#troubleshooting)

The running version is shown in the bottom-left corner of every screen, as `MZ-xx.xx.xx`.

---

## Who can do what

Everyone signs in and has one role. Tabs and buttons you are not allowed to use are hidden, and the server refuses them anyway.

| Role | Can |
| --- | --- |
| **Admin** | Everything, including the Checkmarx One integration, the email server, the credit pool and backups. |
| **Security Analyst** | Everything else: fetch, remind, allocate credits, triage and remediate, tracked reports, audit, people and roles, beta. |
| **User** | Fetch findings, send reminders, follow tracked reports, see credits. Settings are read-only. No Access, Audit or Beta. |

Admins and Analysts can change what Security Analyst and User may do, or create new roles, on the [Access page](#access-page).

---

## Sign in

**Email and password.** Use the address and password you were given. The first time, you must choose your own password: at least 12 characters.

**Checkmarx One API key** (optional). Paste your own key on the sign-in screen.
- It works only if an administrator listed your Checkmarx One identity (your email, username or client id) against your account on the Access page.
- The key must be for the same tenant as the server.
- Checkmarx One then sees your actions as yours.

**The first administrator.** On its very first start the server creates an administrator and prints the email and password in its log:

```
podman logs mission-zero
```

The password is also kept in `/data/first-admin-password.txt` until it is changed.
- If the log shows no password, the volume already holds people from an earlier install.
- To set a new temporary password, run `podman exec mission-zero node scripts/reset-admin.mjs`.
- To start from scratch, remove the volume (`podman volume rm mission-zero-data`). This deletes every setting and the audit log.

**Locked out?** Five wrong passwords lock an account for 15 minutes. An Admin or Analyst can set a new temporary password for you on the Access page (**Set password**).

**Sign out** is under your name, top right. Idle sessions end after 8 hours (`SESSION_IDLE_MINUTES`).

---

## Set up in 10 minutes

As an Admin, open **Settings** and work down this list.

| Step | Where | What to do |
| --- | --- | --- |
| 1 | Quick setup from a .env file | **Download the sample .env**, fill in your Checkmarx One key and mail server, and upload it. This does steps 2–4 in one go. |
| 2 | Checkmarx One integration | Paste the API key, then **Connect & store**. |
| 3 | Email server (SMTP) | Host, port, user and password. Then **Test connection** and **Send test email**. |
| 4 | Reminder server address | The HTTPS address people use to reach this server. Then **Test**. |
| 5 | AI Triage & Remediation from reports | Decide what developers may run from their reports, and set the credit pool. |
| 6 | Branding | Company name, logo and colour for emails and reports. |
| 7 | Automation (optional) | Turn on age-threshold reminders. Start with **Dry run**. |

Then go to the **Dashboard**, click **Fetch vulnerability data**, and send your first reminder.

Settings **save as you type**; there is no Save button.
- A changed Checkmarx One or mail connection is checked straight away.
- If it does not work, the **last known good** settings come back when you leave the page, so nothing stops working. Every administrator is told what was rolled back.

---

## Settings, option by option

Use the section links at the top of Settings to jump to a section. Sections your role cannot change are shown read-only.

### Quick setup from a .env file
Sets the connections from one file, the same file you can start the container with.

1. **Download the sample .env.** Every setting is explained in it, with blanks to fill in.
2. Fill it in with any text editor and save it.
3. **Choose a .env file** (or drop it on the box).

What happens when you upload:
- **Section 1** of the file (Checkmarx One, mail server, reminder server address) applies at once, and each connection is checked.
- **Blank values keep what is set now**, so you can upload only what changed.
- **Section 2** (time zone, backups, tuning) only takes effect when the container starts with `--env-file`. An upload lists those variables as not applied.
- **Only what you may change is applied.** Variables your role cannot set are refused by name.
- **Secrets stay hidden:** the key and password are never shown back. The audit log records which variables were imported.

### Checkmarx One integration (Admin)
The server's own connection to Checkmarx One. It is used for:
- password sign-ins;
- triage and remediation from emailed reports;
- automation;
- tracked reports.

| Field | Meaning |
| --- | --- |
| API key | Create one in Checkmarx One under Identity and Access Management → API Keys. Its role must allow reading projects and results, and running AI Triage / AI Remediation if you use them. Leave blank to use the key you signed in with. |
| Single-tenant / on-prem overrides | IAM URL, API URL and tenant. Only needed when they cannot be worked out from the key (single-tenant or on-prem). |
| **Connect & store** | Checks the key (token exchange plus one project call) and stores it. |
| **Remove stored key** | Removes the stored key. If the server was started with `CX_API_KEY`, it falls back to that key. |

### Email server (SMTP) (Admin)
| Field | Meaning |
| --- | --- |
| Host, Port | Your mail server. Port and TLS mode are paired: picking port 465 turns on Implicit TLS, and 587 / 25 / 2525 turn it off. |
| Implicit TLS | On only for port 465. |
| Server requires authentication | Usually on. |
| Verify TLS certificate | Leave on. Turn off only for an internal relay with a self-signed certificate. |
| Username, Password | The sending account. The password is stored on the server and never shown again. |
| From name, From address | Who the reminders come from. A blank address uses the username. |
| **Test connection** | Connects and logs in without sending anything. |
| **Send test email** | Sends a real email to the address you type. |

**Sending needs a passing test.** Changing the host, port, user, password or TLS options needs a new test.

**Common servers**
- **Gmail:** `smtp.gmail.com`, port 587, Implicit TLS off, and an [App Password](https://myaccount.google.com/apppasswords); your normal password will not work.
- **Office 365:** `smtp.office365.com`, port 587.

### Scan initiators
Checkmarx One records who ran a scan as a username, which is not always an email address. These options turn usernames into addresses.

| Option | Meaning |
| --- | --- |
| Look usernames up in the tenant IAM directory | Matches usernames against Checkmarx One users (one lookup, matched locally). |
| Copy the configured Cc/Bcc on per-initiator emails | Off by default, so developers' own emails do not go to the whole list. |
| Default domain | Appended to a username when nothing else resolves (e.g. `jdoe` → `jdoe@company.com`). Addresses that follow your tenant's naming pattern are also suggested for you to confirm. |
| Overrides | One per line: `jdoe = jane.doe@company.com`. Always wins. |

### Mail template
| Field | Meaning |
| --- | --- |
| Subject, Body | HTML with placeholders. |
| Available variables | The full list, such as `{{totalRisks}}`, `{{projectCount}}` and `{{initiator}}`. |
| **Preview template** | Renders the template with sample data. |
| **Restore default** | Puts back the built-in template. |

**Placeholder syntax**
- `{{name}}` inserts a value, escaped.
- `{{{name}}}` inserts raw HTML.
- `{{#projects}}…{{/projects}}` repeats a block for each item.
- `{{^projects}}…{{/projects}}` shows a block only when the list is empty.

### Automation
Watches findings on a timer and emails the moment one crosses an age threshold. Each finding is reported **once per threshold**, so a daily run does not nag.

| Option | Meaning |
| --- | --- |
| Run automatically | Turns the schedule on. |
| Dry run | Decides and logs, but sends nothing. Use it for the first run, because an older tenant has a backlog that crosses every threshold at once. |
| Thresholds (days) | For example `30, 60, 90`. |
| Check every (minutes) | From 15 minutes to 1 week. |
| Address to | Each scan initiator (their own projects only), or the configured recipient list. |
| Severities | For example `CRITICAL, HIGH`. Blank means all. |
| Mode | **Report each threshold once** (recommended), or **digest**: re-report everything past a threshold on every run. |
| **Run once now** | Runs a pass immediately. |
| **Reset history** | Forgets what was reported, so the next run reports everything again. |

The panel shows:
- whether the Checkmarx One connection and the mail server are ready;
- the last runs (scanned, crossed, sent).

### AI Triage & Remediation from reports
| Option | Meaning |
| --- | --- |
| Allow AI Triage from reports | Developers can click **Triage** in their emailed report. Uses credits. |
| Allow re-triage | Triage a finding again when it already has a verdict (charged again). |
| Allow AI Remediation from reports | Developers can click **Remediate**. It may open a pull request, and applies to reports generated after you turn it on. |
| Allow re-remediation | Remediate a finding again (3 credits again; may open another pull request). |
| Leave not-exploitable findings out | Findings proposed or confirmed not exploitable are left out of reminders and reports. On by default. |
| Administrator contact | Who developers ask for more credits; the report's "Ask the administrator" button emails them. Blank: the From address. |
| **Credit pool** (Admin) | The most the utility may spend on triage and remediation together. 0 means no limit. |
| Refill | Every month on the 1st (UTC), or never (one pool). |

**Costs:** 1 credit per Checkmarx One result triaged, and 3 per finding remediated.

### Branding
| Field | Meaning |
| --- | --- |
| App name | Shown in this app's header. |
| Company name, Company logo | Head every email and report. An `https` logo URL works best, because mail clients block embedded images. You can also upload a PNG, JPG, SVG or WebP up to 200 KB. |
| Logo height | 16–200 pixels. |
| Accent colour | Buttons and headings in emails and reports. |
| Call to action | The sentence above the findings in every email. |

The preview shows the email header exactly as recipients will see it.

### Links into Checkmarx One
Every finding in an email links straight to it in Checkmarx One (Risk Hub).
- If links land in the wrong place, edit the **base URL**, **project link** or **finding link** template. The example underneath updates as you type.
- Placeholders: `{baseUrl}`, `{projectId}`, `{scanId}`, `{engine}`, `{riskId}`.

### Reminder server address
The address people's browsers use to reach this server, put into every emailed report so readers can triage from it. For example `https://mission-zero.company.com`.
- **Test** checks that it answers as this server.
- You are warned if it is `localhost` (nobody else can reach it) or plain `http`.

### Risks endpoint
Where findings are read from. The default is `/api/risks/`.
- **Detect** tries the known paths against your tenant and shows what each returned.
- `/api/risks/ai-insights` adds AI Triage status to each finding.

---

## Dashboard

### 1. Scope: what to fetch
| Option | Meaning |
| --- | --- |
| Projects last scanned in | Skips projects with no scan in this window, so fewer calls are made. Choose from last week, month, 90 days or year, or a custom range. |
| Findings first detected in | Only findings first detected in this window. Checkmarx One filters them. |
| Only these projects or people | Optional. **Projects, by name**: type to pick, or press Enter to add every project whose name contains the text. **People who ran the latest scan**: a username or an email. Only those projects are fetched, which is the fastest fetch. |

### 2. Fetch vulnerability data
- Rows appear as each project is read.
- An **amber flare** (bottom-right) says the fetch is in progress, with how many projects are in so far. It turns **green, Data fetch complete**, when the last one arrives.
- Until then, triage, remediation and credit allocation are switched off, so nothing is decided on half the data.

Each finding falls into an age bucket by when it was **first detected**:

| Bucket | Meaning |
| --- | --- |
| ≤ 30 days | First detected in the last 30 days. |
| 31–60 days | First detected 31–60 days ago. |
| > 60 days | Nobody has touched these for two months. |

### 3. Projects table
| Control | Meaning |
| --- | --- |
| Search, Severity, Age, Hide empty | Filter the table. |
| Click a column header | Sort by that column. |
| **Columns** | Add the age-bucket and per-severity columns. Your choice is remembered in this browser. |
| **Export CSV** | Every shown project, every column, with credits. |
| Tick boxes | Select projects. Reminders, credits and tracking apply to the selection, or to every shown project when none is selected. |
| Latest scan by | Who ran the project's latest scan, and the email it resolved to. |
| Triage / Remediation credits | Left / allocated, and how many more are needed. |
| Track this scope as … → **Save as tracked report** | Follow these projects and filters over time (see [Reports](#reports-tracked-reports)). |

### 4. AI Triage & Remediation credits
**Nothing is allocated until you confirm it.** For the ticked severities (Critical and High by default), the panel shows what the selected projects **need**:
- **Triage:** 1 credit per Checkmarx One result still to triage.
- **Remediation:** 3 credits per **confirmed** finding not yet remediated.

**Why rows and credits can differ.** Checkmarx One can list one result once per code path. For example, 12 rows can be 10 results: those rows are triaged together and charged once, so the need is 10 credits, not 12. Counts always show both.

| Button | What it does |
| --- | --- |
| **Refresh & verify with Checkmarx One** (green border) | Re-reads the findings twice, independently. The numbers are marked verified only when both reads agree. Every button below runs it first by itself. |
| **Allocate for triage** | Verifies first, then shows what will be given and asks you to confirm. Credits come out of the credit pool. |
| **Triage selected now** | Runs AI Triage on the selected projects' findings, within their credits. |
| **Allocate for remediation** | The same, for confirmed findings. |
| **Remediate selected** | Lists each project's confirmed findings and the cost, then runs AI Remediation after you confirm. Each finding is re-checked first; anything no longer confirmed is left alone. |
| Email each scan initiator… | On by default. When you triage or remediate for someone, each scan initiator gets one email about their own projects: what was started on their behalf, and what to do next (refresh their report, review and approve the pull requests). |
| Extra credits → **Add extra credits** | Gives every selected project a fixed extra amount. |
| **Take back extra credits** | Returns the extras. |
| **Take back unused credits** | Returns everything allocated but not used (people did not act on it) to the pool. It never goes below what was used or is in flight. |

**Every action checks first.** Each button in this panel (allocate, triage, remediate, extra credits, taking credits back) first runs **Refresh & verify**. Developers may be triaging or remediating in Checkmarx One itself, or from their emailed report, while you look at this page.
- **Nothing changed:** the action goes ahead with the confirmed numbers.
- **Something changed** (for example, results to triage 10 → 8, or remediation credits left 6 → 3): the action is **cancelled**. The panel now shows the real numbers, and a message lists exactly what changed. Click again to go ahead with them.
- **The two reads disagree** (someone is working on those findings right now): the action is cancelled. Wait a moment and click again.

**Safety nets**
- The same vulnerability is never sent twice, from any page, report or person, even at the same moment.
- A triaged finding is never counted as "needed" again.
- Every credit movement is in the audit log.

### 5. Scan initiators
Everyone who ran a latest scan, with their email.
- **Missing an address?** Type it and **Save**. It is used at once and remembered for later fetches.
- **Suggested address?** Click **Confirm**. A suggestion is never used until someone confirms it.
- **Pick who gets the reminder:** tick people, or use **Select all**, **Clear** or **Pick missing**. **All / Selected / Missing email** filter the list.

### 6. Send reminder
| Option | Meaning |
| --- | --- |
| Send to | **Recipient list**, **Scan initiators**, or **Both**. A scan initiator only ever gets their own projects; the server refuses any email that would show someone a project they did not scan. |
| Content | **One summary** (one email per person, all their projects), or **One per project**. |
| Attach the interactive HTML report | On by default. Developers can triage and remediate straight from it. |
| Recipient list | To / Cc / Bcc, edited here. **Save list** keeps it. |
| **Preview email**, **Preview report**, **Download HTML** | Check before sending. |
| **Send reminder** | Sends, then lists who got which projects and who was skipped (for example, no address). |

The age filter is the Scope's job: a reminder covers the findings in scope.
- Findings proposed or confirmed **not exploitable** are left out (unless switched off in Settings).

---

## The emailed report

*For developers.* Your reminder email has a button, **Let's start fixing the vulnerabilities**, and the same report attached.

1. **Open it.** Click the button (it downloads the report; the link works for 30 days) or open the attachment. Any browser works, and nothing needs installing.
2. **It connects by itself** to the reminder server shown at the top.
   - If it cannot, it says why. Click **Connect** to try again.
   - If the server moved, click **Change address**. The report checks that the new address really is the reminder server, and remembers it.
   - You need to be on the company network or VPN.
3. **Read the list.** It shows the top 50 findings: worst severity first, then oldest. Each one shows:
   - its live Checkmarx One state;
   - a link into Checkmarx One.
4. **Triage** runs Checkmarx One AI Triage on a finding. The verdict appears in the row within a few minutes.
   - **Triage all critical / Triage all high** cover every critical or high finding in the report, across its projects, and skip ones already triaged.
   - A finding judged **not exploitable** disappears from the report, which counts how many it has hidden.
5. **Remediate** works once a finding is **Confirmed**. It runs AI Remediation and then offers the fix:
   - a summary;
   - the pull request (for repository-connected projects);
   - a downloadable patch;
   - a link to Risk Hub.
6. **Refresh** re-reads states at any time. The report also refreshes by itself.

**What the marks mean**

| Mark | Meaning |
| --- | --- |
| **Same result R1**, **R2**, … | Rows with the same label and colour are **one** Checkmarx One result, listed once per code path. They are triaged together for 1 credit. **below ↓ / above ↑** jumps to the twin; hovering a row lights up its whole group. **why?** shows the shared result ID. |
| **Why / Fix** under Confirmed | Why the finding is a real vulnerability and how to fix it, said once, in two lines. **why?** adds only what those lines do not say: <ul><li>how Checkmarx One knows (for example, it followed the data from input to this code);</li><li>AI Triage's verdict (reachable / exploitable, confidence) when there is one;</li><li>what Remediate will do.</li></ul> |
| **Triaging…** | AI Triage is running. |
| **No verdict** | Checkmarx One produced no AI Triage result within 6 minutes. Check the finding in Checkmarx One; the report keeps checking. |
| **Manual fix** | AI cannot act on this kind of finding (for example IaC). Use **Fix in Checkmarx One**. |
| Your credits | What your projects have left. When they run out, **Ask the administrator** emails them. |

Your report can only act on the findings it lists: each one carries a signature that is valid for 30 days.

---

## Reports: tracked reports

Save a scope from the Dashboard (**Save as tracked report**) and follow it over time.

**Each tracked report shows**
- **Baseline findings and what happened to them:** awaiting triage, confirmed, not exploitable, no longer detected. Also the share triaged or resolved, and what changed since it was saved.
- **Matching now:** how many findings the same filters match today, and how many of them are new.
- **AI credits used** on its projects since it was saved.
- A per-project breakdown and a history of readings.

| Action | What it does |
| --- | --- |
| **Refresh** | Re-reads now. Reports also update hourly, and every few minutes after someone triages or remediates. |
| **Download HTML report** | The interactive report for its open findings. |
| Follow up → **Send a reminder about the open findings** | Chooses: <ul><li>who: initiators, list or both;</li><li>content: summary or one per project;</li><li>whether to attach the report.</li></ul>**Preview** first, then **Send reminder now**. |
| Follow up → **Automatic reminders** | Every N days at a set hour, only while something is still open. **Save schedule**. Each send is listed. |
| Follow up → **Triage the open findings now** | AI Triage for the chosen severities, within each project's credits (**Allocate credits** first if needed). |
| **Delete** | Removes the tracked report. History in the audit log stays. |

---

## Credits page

How the credit pool is being used. Everyone with **credits.view** sees it.

| Part | Meaning |
| --- | --- |
| Filters | <ul><li>Period: last 7 / 30 / 90 days, this or last month, last 12 months, or a custom range.</li><li>Group by day, week or month.</li><li>One project, or all.</li></ul> |
| Credit pool | Size; used (triage / remediation); remaining; given to projects but not used; free to give. |
| Credits used over time | Columns per day / week / month: triage at the base, remediation on top. Hover for numbers. **Show as a table** gives exact figures. |
| By project, in this period | Each project's triage and remediation credits, with its share. |
| Allocated vs used | Per project, all time. |
| **Export CSV** | Everything above, for the chosen period. |

---

## Audit page

**Credit audit log.** Every triage and remediation request (charged, refused, failed or not charged), allocation, settings change, report issued, backup and sign-in.
- Each entry records who, when, from where, and which findings, with the balance before and after.
- **Filters:**
  - from / to;
  - type;
  - outcome;
  - project;
  - free-text search (user, email, IP, finding id, error).
- **Export CSV** or **Export JSON Lines**.
- **Verify integrity** recomputes the hash chain: any edited, removed or reordered entry is reported by number.
- **Reconcile** checks that a month's charged credits in the audit log match the credit ledger.

**State folder & backups.** Everything lives in one folder (`/data` in the container), and one backup file rebuilds the server.

| Action | Who | What |
| --- | --- | --- |
| **Download backup** | Admin | One `.mzbackup` file. It holds the keys, the mail password and the users, so keep it safe. |
| **Back up to folder now** | Admin / Analyst | Writes a backup to the backup folder. Scheduled backups run every 24 hours by default. |
| **Restore from backup…** | Admin | Checks the file (asks for the passphrase if it is encrypted), shows what it holds, then **Restore at next restart**: the state is replaced when the server next starts. |

See [audit-and-backup.md](audit-and-backup.md) for encrypted backups and moving to a new server.

---

## Access page

**People**

| Action | What it does |
| --- | --- |
| **Add person** | Fields: <ul><li>email and name;</li><li>role;</li><li>a temporary password (they choose their own at first sign-in);</li><li>optionally their **Checkmarx One identities** (usernames or client ids allowed to sign in with an API key).</li></ul> |
| Role (per person) | Change it. It applies on their next click. |
| **Set password** | A new temporary password. |
| **Disable / Enable** | Disabling ends their sessions at once. |
| **Remove** | Deletes the account. |

**Roles & permissions** is a matrix of permissions against roles.
- Tick or untick boxes, then **Save role changes** (or **Discard**).
- **New role** builds your own role.
- The Admin role is fixed. Permissions marked **Admin** are Admin-only by default.
- You can never grant a permission you do not have yourself, or touch an Admin's account unless you are an Admin.
- There is always at least one active Admin.

---

## Beta page

Early features: check what they find before relying on them. Details are in [beta-features.md](beta-features.md).
- **Email the authors of vulnerable code.** Uses `git blame` on the vulnerable line to find who wrote it, and emails them.
- **Match GitHub usernames to email addresses**, four ways, with a confidence for each.
- **GitHub connection:** a token, the API URL (GitHub Enterprise too), the organisation and repositories.

---

## Logs page

**Troubleshooting log.** **Download troubleshooting log** gives one file covering:
- which features are used and how fast;
- where errors happen;
- where numbers disagree;
- recommended fixes.

Send it to whoever maintains Mission Zero when something goes wrong. **It captures no sensitive information:** no names, email addresses, passwords, keys, tokens, hosts, URLs, findings or code.

**Activity log.** What this browser did, filtered by API calls, errors and successes, and searchable. **Export** saves it; **Clear** empties it.

---

## Everyday recipes

**Weekly reminder to every developer, their own projects only**
1. Dashboard → Scope: *Projects last scanned in* = last month.
2. **Fetch vulnerability data** and wait for the green flare.
3. Send reminder: **Scan initiators**, **One summary**, attachment on. **Preview email**, then **Send reminder**.

To have it happen by itself, use Settings → Automation, or a tracked report's **Automatic reminders**.

**Triage every critical and high finding for one team**
1. Scope → Only these projects or people: add the team's projects.
2. Fetch, then in the credits panel tick Critical and High.
3. **Allocate for triage** (it verifies with Checkmarx One first), then confirm.
4. **Triage selected now.** Each developer is emailed that triage ran on their behalf.

**Remediate what triage confirmed**
1. Fetch again (or use **Refresh & verify**).
2. **Allocate for remediation**, then **Remediate selected**: check the list and the cost, then confirm.

**Take back credits nobody used**
- Credits panel → *Extra credits, and taking credits back* → **Take back unused credits**.

**Move to a new server**
1. Audit page → **Download backup**.
2. Start the new container.
3. **Restore from backup…**

---

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| No administrator password in the log | The volume already has people from an earlier install. Run `podman exec mission-zero node scripts/reset-admin.mjs`, or start fresh by removing the `mission-zero-data` volume. |
| "Settings rolled back to the last known good configuration" | The new Checkmarx One key or mail server did not work. The message says what failed; fix it and try again. |
| SMTP test times out | Usually the port and TLS mode do not match: 465 needs Implicit TLS on, 587 needs it off. Otherwise a firewall is blocking the port. |
| Gmail refuses the password | Use an App Password, not your normal password. |
| The report says it cannot reach the server | Be on the company network or VPN. Check **Settings → Reminder server address**, and use **Change address** in the report if the server moved. |
| More rows than credits needed | Several rows can be one Checkmarx One result (marked **Same result R1** …). You are charged per result. |
| "Fetch still running" when you click Allocate or Triage | Wait for the green **Data fetch complete** flare. |
| "Could not be confirmed twice" when allocating | Someone was triaging, or a scan finished, between the two reads. Wait a minute and use **Refresh & verify** again. |
| "… cancelled: Checkmarx One changed since this page last showed it" | Someone triaged or remediated meanwhile, in Checkmarx One or from a report. The panel now shows the real numbers; click the button again. |
| "Mission Zero is restarting for an update — reconnecting…" | A new version is being applied. Wait a few seconds; you stay signed in and nothing is lost. |
| A report says "busy, retrying" | Many reports are open at once. It retries by itself; nothing is lost. |
| Credits refused | The project has no credits left. Allocate on the Dashboard, or raise the credit pool (Admin). |
| Anything else | Logs page → **Download troubleshooting log** and send it to your maintainer. |
