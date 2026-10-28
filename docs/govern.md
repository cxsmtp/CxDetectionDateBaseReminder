# Govern (beta)

**Govern is the credits command center for security champions.** It sets a budget of AI credits on a person, a group, a project or an application, reads what Checkmarx One reports each of them used, warns near and over the budget, lets anyone ask for more, and, only for a budget someone set to **Enforce**, takes AI away in Checkmarx One at the limit and puts it back afterwards. Everything it changes is written to the audit log and can be undone.

It is in **Labs → Govern** while it is in Beta, behind its own activation code. Once an Admin makes it final, it moves to a menu group of its own, **Govern**, between Prove and Plan.

**Contents**
1. [What it is for](#what-it-is-for)
2. [Unlock it](#unlock-it)
3. [Who can do what](#who-can-do-what)
4. [The page](#the-page): [Overview](#overview), [Budgets](#budgets), [Requests](#requests), [Restrictions and alerts](#restrictions-and-alerts), [Attribution](#attribution), [Settings](#settings)
5. [The cycle](#the-cycle)
6. [How usage in a period is counted](#how-usage-in-a-period-is-counted)
7. [Safety by design](#safety-by-design)
8. [Known limits](#known-limits)
9. [Troubleshooting](#troubleshooting)
10. [For developers](#for-developers)

---

## What it is for

Checkmarx One counts the AI credits a tenant uses (AI Triage, AI Remediation, Auto Triage, Fusion) but does not let you give a team, a project or a person a share of them. Govern does:
- **Budgets.** So many credits a month, a quarter, between two dates or for good, for one user, group, project or application.
- **Who used what.** What Checkmarx One reports each of them used, attributed to the right person or project, with the names that match nobody put in a queue to decide.
- **Alerts.** Near the budget (at a share you choose) and over it, in the page, by email and by webhook.
- **Requests.** Anyone may ask for more credits; a Security Champion or an Admin approves (all or part, for a while or for good), denies with a reason, or asks a question.
- **Enforce, when you choose it.** At the limit, a person loses the AI roles, a project's Auto Triage and PR remediation are turned off, and CxMissionZero itself spends no more credits on them. All of it is put back when usage is under the budget again, a request is approved, the period ends or someone restores it.

A budget is **Monitor** by default: it counts and warns, and changes nothing in Checkmarx One.

## Unlock it

Govern is held back until its **activation code** is applied (scope `feature:govern`; [activation codes](activation-codes.md)). Until then it is not in the menu, nor under **Settings → Beta features**, and every `/api/govern` call answers 403. An Admin applies the code under **Settings → Activation codes**; the maintainer makes it with `node scripts/activation.mjs feature issuer-key.pem "Acme Corp" govern on` (or `off`), or, on Windows with Podman, in one line:

`podman run --rm -v "%USERPROFILE%\mz-keys:/keys:ro" ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest node scripts/activation.mjs feature /keys/issuer-key.pem "Acme Corp" govern on`

With the code in force, Govern is for everyone whose role holds **See Govern** or **Ask for credits** (every built-in role does; below), in Beta too: no **Beta features** permission is needed, and Beta features alone is not enough, since every tab needs its Govern permission. Applying or removing the code is in the audit log.

**While the code is off** (removed, or expired): the cycles stop, nothing is read from Checkmarx One, CxMissionZero's own spend is no longer refused, and the page is gone. Restrictions already made in Checkmarx One **stay** until the code is back and someone restores them ([known limits](#known-limits)).

**Making it final** (Settings → Beta features → **Make final**, permission "Make Beta features final"): it loses its Beta label and moves to its own menu group, **Govern**, between Prove and Plan. Everyone holding a Govern permission keeps using it as before. Before you do: keep every budget in Monitor until the figures match what Checkmarx One shows for your own users and projects and the Attribution queue is settled; then switch one budget to Enforce and check that Restore puts everything back.

## Who can do what

Eight permissions, in the group **Govern** on People & roles. The built-in roles hold them as follows (✓ = holds it):

| Permission | What it allows | Admin | Security Champion | Security Analyst | User |
| --- | --- | :---: | :---: | :---: | :---: |
| **See Govern** (`govern.view`) | Every tab but Settings: the tenant's credits, every budget, what each one used, restrictions, alerts, attribution; Diagnose a figure; export the budgets. | ✓ | ✓ | ✓ | |
| **Ask for credits** (`govern.request`) | Ask for credits for oneself, or for a project, group or application. Without See Govern: only one's own usage, budget and requests. | ✓ | ✓ | ✓ | ✓ |
| **Approve credit requests** (`govern.approve`) | Approve (all or part, until a date or for good), deny with a reason, ask a question. | ✓ | ✓ | | |
| **Manage budgets** (`govern.budgets`) | Create, change, import and delete budgets and exemptions (in Monitor); on an Enforce budget, only what makes it restrict less; Run now. | ✓ | ✓ | | |
| **Enforce budgets** (`govern.enforce`) | Switch a budget to Enforce, change what an Enforce budget restricts, and confirm a restriction that reaches more targets than the budget's limit; Run now. | ✓ | ✓ | | |
| **Restore restrictions** (`govern.restore`) | Put back at once what Govern took, with a grace. | ✓ | ✓ | | |
| **Decide attribution** (`govern.attribution`) | Map a name to someone, reject a match for good, ignore a shared account, clear a decision. | ✓ | ✓ | | |
| **Govern settings** (`govern.settings`) | The cycle, what Enforce takes away, AI-only groups, notifications (email, webhook and its secret), the permission check; Run now. Of the built-in roles, the Admin's alone. | ✓ | | | |

- **Security Champion** is a built-in role new with Govern: complete control of the credits in the pool (budgets, Enforce, requests, restores, attribution), plus **Fetch findings**, **View tracked reports** and **View credits**. Not Govern settings, not users and roles. Give it on People & roles like any other role; it can be renamed or duplicated.
- **On upgrade**, the built-in Security Analyst gets See Govern and Ask for credits, and the built-in User gets Ask for credits, once. Roles made by people are left as they are.
- **A User** (only Ask for credits) sees **Your AI credits**: their budget, what they used, what is left, and their own requests. They can ask for themselves only if their sign-in email is a Checkmarx One user of the tenant; they cannot pick other people.
- Every permission is checked on the server; the page only hides what a role may not use.

## The page

**Labs → Govern** has a compact top: the title, **Last cycle** (how long ago, and *Partly read* or *Failed* when it was), when the next one runs (or *cycles are off*), **Run now** (Manage budgets, Enforce budgets or Govern settings), and the figures line, on every tab:

| Figure | What it is |
| --- | --- |
| **Tenant credits** | The tenant's total, used and available credits, from Checkmarx One (`/api/credits/info`). |
| **In the pool** | What CxMissionZero itself may spend (Credit Control). |
| **Assigned to budgets** | The sum of the active budgets, top-ups included; "N over the pool" when it is more. |
| **Used this period** | The sum of what the active budgets used in their current period. |
| **Near limit**, **Restricted** | Budgets past their warning share; budgets restricted, being restricted or partly restricted ("N partly"). |

Six tabs, each shown to the permissions that read it. Every table has the same tools: a search, sort and filter on each heading, **Columns** (tick to show, arrows to move, kept in this browser), a click on a row opens the side panel, ticked rows bring an action bar with only the actions that fit them, and **Export CSV** and **Export HTML** of what the table shows. The page reads everything from the server's memory and polls every 60 seconds while it is in view; a cycle never blocks it.

### Overview

- **Banners**: a level Checkmarx One does not report for this tenant ("nothing is assumed zero"); the last poll did not finish (figures are from the last complete one, nothing is restricted or released on them); credits used by names that match nobody (**Open Attribution →**); figures that are still estimates.
- **Credit pool**: one bar from the left: used, assigned and not used, free (or assigned over the pool), for the pool's period.
- **Credits over time**: by action (AI Triage, AI Remediation, Auto Triage, Fusion), per day, for 7 days, this period or 90 days, or by month (**12 months**, from the 90 days it keeps). **Show as a table** gives the figures.
- **Top consumers**: Users, Projects, Groups or Applications, the top 10 by credits in the lookback window, each with its budget, use, share and status.

Someone holding only Ask for credits sees **Your AI credits** here instead: their budget, used, left, open requests, their requests, and **Ask for credits**.

### Budgets

One row per budget: **Who** (with its level), **Period**, **Budget** (top-ups included), **Used**, **Of the budget** (a bar from the left, with a tick where it warns), **Status**, **Mode**, **Updated**; and, from Columns, Level, Warn at, Days left, Restrictions, Notes and the Checkmarx One id. Chips filter by level (All, Users, Groups, Projects, Applications, with counts). Under the table, **Exemptions**.

**Statuses**

| Status | Meaning |
| --- | --- |
| **Within** | Under the warning share. |
| **Near** | At or past the warning share (80 % by default). Warned once per period. |
| **Over** | Used up: usage is at or past the budget. In Monitor it stays so: warned, nothing removed. A budget of 0 is over from the start. |
| **Restricting** | Over, in Enforce: being restricted in Checkmarx One. |
| **Restricted** | Over, in Enforce: every restriction is in place. |
| **Partial** | Over, in Enforce: some restriction could not be made in full, failed, or was skipped; the line under the name says why ([Partial](#partial)). |
| **Needs confirming** | Over, in Enforce, but restricting would reach more targets than the budget's limit: nothing is restricted in Checkmarx One until someone confirms it. |
| **Exempt** | Counted, shown and warned about; never restricted. |
| **Not reported** | Checkmarx One does not report usage at this level for this tenant, or has not been read yet: nothing is assumed zero, nothing is held or released. |
| **Paused** | Not active: nothing is counted against it or restricted. |
| **Not open yet** | A custom period that has not started, or has ended. |
| **Not checked yet** | Not evaluated yet. |

The line under a name also says when a budget is in grace after a restore, when its figure is from an earlier poll (the last one failed), and when it is an estimate.

**Monitor and Enforce.** **Monitor** (the default) counts and warns. **Enforce** also restricts at the limit ([what it restricts](#what-enforce-restricts)); switching a budget to Enforce needs **Enforce budgets** and records who did it and when. So does anything that makes an Enforce budget restrict more (from MZ-01.01.05), by edit, bulk edit or CSV: a higher **Most targets restricted at once**, fewer credits, turning on **Count group members**, **Count subgroups**, **Count usage from before the period** or **Hold until released**, making it **Active** again after a pause, or a different period or dates. Without it, Manage budgets may still narrow an Enforce budget (fewer targets, more credits, an option switched off), pause it, change its notes and warning threshold, or switch it to Monitor. Switching it back to Monitor, pausing it, exempting it or deleting it lifts its restrictions in the background.

**A budget** (New budget, or a row's side panel; Manage budgets):
- **Who**: a user, group, project or application, picked from what Govern last read of Checkmarx One. One budget per entity.
- **Credits** (decimals allowed, up to 100,000,000) and **Warn at** (1 to 100 % of the budget).
- **Period**: **Monthly** and **Quarterly** (calendar months and quarters, UTC), **Lifetime** (from the day the budget was made), or **Custom** (from a start date; the end date may be left open).
- **At the limit**: Monitor or Enforce.
- **Active**; **Count group members' usage** and **Count subgroups** (groups only); **Count usage from before the period** (off: the period counts from its start); **Hold until released** (once restricted, it stays so after the period ends, until someone restores it); **Exempt**, with a reason.
- **More options**: **Most targets restricted at once** (25 by default, from Settings): a group or application can reach many projects; above this, Enforce waits for **Confirm restricting more than that** (Enforce budgets).
- **Notes**.
- **Pool guard**: a budget that takes the assigned credits past the pool says by how much. It is allowed (in Monitor and in Enforce), with the warning.
- **Diagnose this figure** (side panel of a budget): [below](#diagnose-a-figure).

Ticked rows offer **Set amount**, **Warn at %**, **Monitor**, **Enforce** (Enforce budgets), **Pause**, **Resume**, **Exempt** and **Not exempt**, up to 500 at once; approved top-ups stay. A budget changed by someone else since you opened it is refused ("look again").

**Exemptions** (Manage budgets): a user, group, project or application, with or without a budget, that is never restricted: shared or service accounts, say. Its usage is still counted, shown and warned about. An exempt project is also skipped when its group's or application's budget restricts.

#### CSV export and import

**Export CSV** (See Govern) downloads every budget with every field, `govern-budgets-YYYYMMDD-HHMM.csv`; **Export the table** downloads only the rows and columns shown. The full export can be edited and imported again (Manage budgets): export then import changes nothing.

| Column | On import |
| --- | --- |
| `budget_id` | The budget to change. Empty: the entity's budget if it has one, else a new one. An id that does not exist is an error. |
| `version` | The version exported. A budget changed since is an error (export again). |
| `entity_type` | Required: `user`, `group`, `project` or `application`. |
| `entity_id` | Required: the Checkmarx One id. One row per entity. Once Govern has read the org, it must be in it. |
| `entity_label` | A name to show (Govern prefers Checkmarx One's). |
| `amount` | Credits, decimals allowed. Required for a new budget. |
| `period` | `monthly` (default), `quarterly`, `lifetime` or `custom`. |
| `custom_start`, `custom_end` | `YYYY-MM-DD` (UTC day) or a full ISO 8601 time. Custom needs a start; the end must be after it. |
| `warn_pct` | Whole number, 1 to 100 (default 80). |
| `mode` | `monitor` (default) or `enforce` (needs Enforce budgets). |
| `active`, `include_members`, `include_subgroups`, `count_existing`, `hold_until_released` | `true`/`false` (also `1`/`0`, `yes`/`no`, `y`/`n`, `on`/`off`). Members and subgroups count for groups only. |
| `max_targets` | Whole number, 1 to 10,000. |
| `exempt`, `exempt_reason` | Whether the entity is exempt, and why. |
| `notes` | Free text, kept exactly as written. |
| `delete` | `true` deletes that budget. |
| `used`, `period_key`, `status` | Exported for reading only: ignored on import. |

- **Rules.** Headers are trimmed and case-insensitive; a header Govern does not know is refused (a typo such as `enforced` never turns enforcement off silently), and so is a header that appears twice. On a budget that exists, a column left out leaves its field as it is, and so does an empty cell, except `notes`, `custom_end` and `exempt_reason`, which an empty cell clears. At most 1 MiB and 5,000 rows; a UTF-8 BOM is dropped.
- **Spreadsheet formulas.** A text cell that starts with `=`, `+`, `-`, `@`, a tab, a carriage return or an apostrophe is exported with one apostrophe in front, and import removes exactly one.
- **Validate, then apply.** **Import CSV** checks the file first and changes nothing: the figures (created, changed, unchanged, deleted, errors), every error with its row, and every row's change, field by field (before struck through → after), with **Download the plan**. **Apply** makes exactly those changes, all or nothing: any error and nothing is applied, and Apply stays off. Apply is refused if a budget it touches, or the file, changed since the check (the check's plan hash includes each budget's version): **Check again**. Applying writes budgets only; restrictions and restores follow in the background, never inside the import. The import is one entry in the audit log, with before and after.

### Requests

Anyone with **Ask for credits** asks: for **me**, or for a project, group or application; how many; **until** the end of the period or a date; and why. Up to 20 open requests per person. A new request is an alert (Requests).

Those with **Approve credit requests** (and See Govern, read-only) see every request (chips Open, Approved, Denied, Expired, Withdrawn; **waiting 2 h** on open ones) and, in its side panel:
- **Approve**: the credits asked or fewer; **until the end of the period**, until a date, or **For good (raise the budget)**. A temporary approval is a top-up on the budget that ends on its date; for good raises the budget's own amount. Restrictions are lifted as soon as usage is under the new budget, and the requester is emailed. A request for something with no budget cannot be approved: nothing limits it, so set a budget first.
- **Deny**, with a reason the requester is emailed.
- **Ask a question**: a thread both sides write in; the requester is emailed.
- Ticked open requests: **Approve as asked**, **Deny…**. A requester can **Withdraw** their own.

An open request expires after 14 days (Settings). Every request, decision, comment and expiry is in the audit log. The requester's emails go through CxMissionZero's own mail server whatever the notification settings.

### Restrictions and alerts

**Active restrictions**: one row per thing Govern took away: **Who**, **What** (AI roles removed, Auto Triage off, PR remediation off), **Because of** (the budgets), **Since**, **Restore** (*Exact* or *Default*) and **State** (Waiting, Restricting, Restricted, Partial, Failed, Skipped, Restoring). Budgets in a grace after a restore are listed too, **In grace**, with until when.

#### What Enforce restricts

| Budget over | What Govern does in Checkmarx One | Put back |
| --- | --- | --- |
| **A user** | Removes the AI roles from the user on `ast-app`: by default `view-risk-management`, `view-risk-management-dashboard`, `view-risk-management-tab` (Settings; `view-scans` only if an Admin adds it, since it also stops the person seeing scans). It reads the user's effective roles, removes those mapped directly, and leaves an AI-only group (Settings) when that is where a role comes from. | The roles removed are added back, and the person rejoins any group they left. |
| **A project** | Turns its **Auto Triage** off, writing back the whole AI agents configuration it just read with only that switch changed; only if it was on. Turns its **PR remediation** off (no severities) when the project has a repository. | Auto Triage on again (only if it was on before); PR remediation's severities as they were. |
| **A group or application** | The same, for each of its projects (subgroups' too, when the budget counts them). Exempt projects are skipped. | The same. |

**CxMissionZero's own spend stops at once**, too: AI Triage and AI Remediation requested through CxMissionZero (the Workbench, the emailed report) for a project, or by a person, whose budget in Enforce is used up are refused with the reason, while the budget is over, not exempt and not in a grace. This applies even while a large restriction waits to be confirmed.

**Several budgets on one thing** (a project's own budget and its application's, say): the first to need it restricts it and records what was there before; it is put back only when the last of them releases it.

#### Partial

Govern never says **Restricted** while Checkmarx One still gives the person an AI role. After removing the roles, it reads the effective roles again; if one remains, the restriction is **Partial**, with the reason: *Group /Developers grants view-risk-management* (the group is not marked AI-only), *A composite role grants …*, or *Still holds …*. Mark such a group as **AI-only** under Settings to let Govern take the person out of it (they are put back on restore), or change the role in Checkmarx One. A budget is also shown **Partial** when one of its restrictions **Failed** (Checkmarx One refused or did not answer: tried again next cycle) or was **Skipped** (PR remediation whose setting could not be read is left on, since it could not be put back exactly; tried again after an hour). Partial is a critical alert, Failed an error, Skipped a warning.

**Restore mode.** *Exact*: put back what was read before. *Default*: PR remediation that could not be read was turned off anyway (only with **Turn off PR remediation even when its setting cannot be read** on); restore then sets Checkmarx One's default, `CRITICAL` and `HIGH`.

#### Restore and grace

**Restore…** (ticked rows, or a row's button; Restore restrictions) puts back, in Checkmarx One and in the background, what Govern took from those targets, whatever the budgets behind them say. Each of those budgets then has a **grace**: no new restriction until usage grows past the figure at the restore by **1 credit** (Settings: Grace after a manual restore), or until the date chosen in the dialog (by default the end of the period; a lifetime budget's grace ends only with usage). The grace shows on the budget and in the list; after it, a new breach restricts again.

Govern lifts restrictions by itself, with no grace, when the budget is raised (an edit, or an approved request), when it is switched to Monitor, paused, exempted or deleted, and when a new period starts under the budget. **A new breach after any of these restricts again.** **Hold until released** keeps last period's restrictions through the new period, until someone restores them.

#### Alerts and their delivery

The feed: **Severity** (Info, Warning, Error, Critical; "and above"), **Category** chips (Warnings, Enforcement, Restoration, Attribution, Sync errors, Requests), **Unread only**, a search, and per row **When**, **Alert**, **Category**, **Delivery** (each channel: *sent*, *waiting*, *failed 2×, retrying*, *not delivered*) and **About**. Read state is each person's own (**Mark read**, **Mark all read**); the tab shows the unread count. Govern keeps the newest 5,000 alerts.

| Alert | Severity |
| --- | --- |
| Near a budget; over a budget in Monitor or exempt; a restriction waiting to be confirmed, skipped, or undone in Checkmarx One and made again; part of a poll not read; credits nobody counts (each 100 more) | Warning |
| Over a budget in Enforce; restricted; partly restricted | Critical |
| A restriction or restore failed (once a day per target); a budget that cannot be evaluated, or whose period is wrong | Error |
| Restored; back under a budget; credit requests and their answers | Info |

An alert is raised once (a new breach, after a release, is a new alert). It is sent to each channel whose minimum severity it meets (Settings): one delivery per channel, kept on disk with its attempts, tried up to 6 times with growing waits (30 s, 1 min, 2 min…), so a restart neither forgets nor repeats it, and a failing channel never makes a working one send twice. A webhook address the server may never call, or a webhook that answers 400, is given up at once.

### Attribution

Checkmarx One reports usage under a name: an email, a username, a display name, a project's or application's name. **Attribution** shows how each one counts here, in four views:
- **Disputes**: two or more could be meant, or nobody is sure. Check them once; what you decide sticks.
- **Matched**: counted towards the budget shown, exactly, by name, or by hand.
- **Unmatched**: counted towards no budget until it is mapped or ignored.
- **Ignored**: shared or service accounts, counted towards no one.

Chips narrow it to Users, Projects, Applications or Groups. Each row: **Reported as**, **Credits** (in the lookback window), **Counts towards**, **Suggestions** (with a score). Decide (Decide attribution):
- **Map** (or click a suggestion): it counts towards that person or project.
- **Reject this match**: never matched to that one again; the name goes back to Disputes, or Unmatched.
- **Ignore**: counted towards no one.
- **Clear the decision**: matched again as Govern would.

How Govern matches a user: your decision first; then exactly, by email, an email-shaped name, the username (also without a `cx-`, `svc-`, `sa-` or similar prefix) or a full name only one person has; then by likeness, never to someone you rejected: 0.85 or more, with no runner-up within 0.05, matches; from 0.60 it is suggested and disputed; below, unmatched. Two people with the same name are never merged. Bots (`dependabot`, `renovate`, `github-actions`, names with `[bot]`…) are never matched, and automation (`Auto-triage`, `system`…) counts tenant-wide, never towards a person. Projects, applications and groups match by id, then by a name only one has; a name two share is a dispute.

A decision is kept, is in the audit log (who, when, why), applies at once (budgets are evaluated again in memory) and carries over to another spelling of the same name. A name mapped to someone no longer in Checkmarx One goes back to Disputes, its credits counting towards no one.

### Settings

**Govern settings** only (Admins by default). Every change is in the audit log (the webhook secret never: only that it changed).

| Setting | Default | What it does |
| --- | --- | --- |
| **Check usage and act** | Every 15 min | Every 2, 5, 15 or 60 minutes, or **Off** (Run now still works). |
| **Lookback window** | Last 30 days | The window Checkmarx One reports totals over: last month, 30, 90 or 180 days, or last year. 30 days suits monthly budgets: the first read is spread evenly over the window, so a longer window understates this month until Govern has its own history. Choose a longer one for lifetime budgets and "count usage before the period", which reach back only as far as the window. | [How it is used](#how-usage-in-a-period-is-counted). |
| **Grace after a manual restore** | 1 credit | How much usage must grow after a restore before a new restriction. |
| **Rows per Checkmarx One page** | 1000 | Consumption page size, 1 to 1000 (100 by itself when a tenant refuses 1000). |
| **Read people, groups and projects every** | 30 min | 5 to 1440. Run now always reads them. |
| **Check restrictions are still in place every** | 4 cycles | 1 to 96; each restriction at most once an hour. |
| **Most targets per breach, by default** | 25 | For new budgets, 1 to 10,000. |
| **Open requests expire after** | 14 days | 1 to 365. |
| **Usage counts as stale after** | 3 cycles without a complete read | A level whose last complete read is older than this many cycles counts as stale; a read that fails part-way keeps the previous complete one and marks the level stale at once. |
| **AI roles to remove from a person** | the three `view-risk-management…` roles | 1 to 20 role names; adding `view-scans` asks you to confirm. |
| **AI-only groups** | none | Groups Govern may take a person out of to remove an AI role (up to 100). |
| **Turn off PR remediation even when its setting cannot be read** | Off | Off: such projects are reported, not changed. On: turned off, and restored to the default. |
| **Send from severity** | Warning | The lowest severity sent by any channel. Every alert is in the feed either way. |
| **Email** | Off | Up to 50 recipients and a minimum severity; through CxMissionZero's own mail server (Settings → Email server). Subject `[CxMissionZero Govern] <title>`. |
| **Webhook** | Off | An `https` address and a minimum severity. Never a link-local or cloud metadata address, nor this machine; the name is resolved once and only that address is called; no redirect is followed; 10 s timeout. |
| **Webhook signing secret** | none | Up to 256 characters. Write-only: never shown again, only "Set". Empty: calls are not signed. |

**Send test email** (to the recipients, or to you when there are none) and **Send test webhook** say what happened. **Permission check**: [below](#permission-check).

#### Webhook calls and their signature

Each alert is a `POST` of compact JSON:

```json
{"id":"<alert id>:webhook","alertId":"<alert id>","created_at":"2026-10-24T09:15:00.000Z","severity":"critical","category":"enforcement","title":"Restricted: AI roles removed for user jane@example.com","body":"…","entity":{"type":"user","id":"…","label":"jane@example.com"},"tenant":"acme","source":{"name":"CxMissionZero","version":"MZ-…"}}
```

Headers: `Content-Type: application/json`, `User-Agent: CxMissionZero/<version>`, `X-MZ-Timestamp: <unix seconds>`, `X-MZ-Delivery: <id>` (the same on every retry of one delivery: use it to ignore a repeat) and, with a secret, `X-MZ-Signature: sha256=<hex>`, where hex is the HMAC-SHA256, keyed with the secret, of the timestamp, a dot, and the raw body as received. Any 2xx answer is success. The test call's body is `{"id":"test-…","test":true,"title":…,"created_at":…,"source":…}`, signed the same way.

To check a call, compute the signature over the raw body (before parsing it), compare in constant time, and refuse old timestamps. In Node.js:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
function verify(secret, headers, rawBody) {
  const ts = headers['x-mz-timestamp'];
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(`${ts}.`).update(rawBody).digest('hex')}`);
  const got = Buffer.from(String(headers['x-mz-signature'] ?? ''));
  return got.length === want.length && timingSafeEqual(got, want) && Math.abs(Date.now() / 1000 - Number(ts)) < 300;
}
```

In Python:

```python
import hashlib, hmac, time
def verify(secret: bytes, headers, raw_body: bytes) -> bool:
    ts = headers["X-MZ-Timestamp"]
    want = "sha256=" + hmac.new(secret, ts.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, headers.get("X-MZ-Signature", "")) and abs(time.time() - int(ts)) < 300
```

## The cycle

Each tenant's Govern runs its own cycle, on the server, while its code is in force and the tenant has a Checkmarx One integration (Settings → Checkmarx One). The server looks every 15 seconds whether one is due: the first soon after start, then every interval (15 minutes by default), each tenant shifted by up to a minute so tenants do not all start together. Never two at once for a tenant. **Run now** starts one at once and answers straight away (the page follows its progress); a run already going is shown instead. A change made on the page (a budget, an import, an approval, a decision, a restore) is evaluated at once in memory, and only its Checkmarx One side follows in the background.

1. **Read**, changing nothing yet: the org when due (users, groups, projects, applications, every 30 minutes, and on Run now), the tenant's credits, then the credit consumption by user, action, application, project and group.
2. **Commit** the polls that arrived complete, and swap in the new figures in one step. A poll that did not complete leaves that level at its last complete poll, marked stale.
3. **Evaluate** every budget (in memory, no Checkmarx One call), record what should be restricted or released, raise the alerts, expire old requests.
4. **Enforce**: restrict and put back, 4 targets at a time, each written ahead, done and checked ([safety](#safety-by-design)); no new write is started after 10 minutes. Every so many cycles, restrictions in place are checked against Checkmarx One and made again if someone undid them (one alert a day).

A run ends **success**, **partial** (part of the org or a level was not read, or the 10 minutes ran out), **failed** or **skipped** (no Checkmarx One connection). The last 20 are kept, with what each read and how many Checkmarx One calls and writes it made. Alerts are sent apart from the cycle, on the same 15-second tick, which never waits for them.

### Checkmarx One calls, and what the API key needs

All through the server's own Checkmarx One connection (the integration's API key). **Permission check** shows which reads the key may make; a write can only be known after the first real one.

| What | Call | When | The key needs |
| --- | --- | --- | --- |
| Credit consumption | `GET /api/credits/consumption?viewBy=<user\|action\|application\|project\|group>&period=<window>&page=&size=&sort_by=creditsUsed&sort_order=desc`, page by page; once, while a level's support is unknown, `viewBy=__mz_unsupported_probe__` | Every cycle | Read credit consumption |
| Tenant credits | `GET /api/credits/info` | Every cycle | Read credits |
| Users | `GET {IAM}/auth/realms/{tenant}/users/v2` (first page without parameters, then `first`/`max=100`) | Org read | Read users in IAM |
| Groups | `GET {IAM}/auth/realms/{tenant}/groups` | Org read | Read groups in IAM |
| Projects, applications | `GET /api/projects`, `GET /api/applications` (`limit=100`, `offset`) | Org read | Read projects and applications, tenant-wide |
| The `ast-app` client | `GET {IAM}/auth/admin/realms/{tenant}/clients?clientId=ast-app&max=1&search=true` | Restricting a user | IAM administration |
| A user's AI roles | `GET …/users/{id}/role-mappings/clients/{uuid}` and `…/composite`; `GET …/users/{id}/groups`, `GET …/groups/{id}/role-mappings/clients/{uuid}/composite` | Restricting, restoring, checking a user | IAM administration (read) |
| Remove, add back AI roles | `DELETE` / `POST …/users/{id}/role-mappings/clients/{uuid}` | Enforce, restore | IAM administration: manage role mappings |
| Leave, rejoin an AI-only group | `DELETE` / `PUT …/users/{id}/groups/{groupId}` | Enforce, restore | IAM administration: manage group membership |
| Auto Triage | `GET` / `PUT /api/ai-agents-coordinator/projects/{id}/configuration` | Restricting, restoring, checking a project | Manage the project's configuration |
| PR remediation | `GET` / `PATCH /api/repos-manager/repo/{repoId}?projectId={id}` (`remediationSeverities`) | The same, for a project with a repository | Manage the project's configuration |

A key that may read but not write: Govern is **monitor-only** for what it may not change. The first write refused (403) shows **Refused (403): monitor only** in the permission check, and each one is an error alert (once a day per target).

### Its own call budget

Govern has its own budget of Checkmarx One calls inside the connection's: **at most 4 at once and 5 a second**, at background priority, so the Workbench, reports and AI requests are never starved by a cycle. Reads are tried twice at most; **writes are never retried blindly** (a failed one is tried again next cycle, after reading the state again). With the defaults, a cycle reads each level's consumption once (1,000 rows a page), the tenant's credits once, and the org every 30 minutes; it reads a user's roles or a project's settings only for what it is changing or checking, and checks each restriction in place at most once an hour. A page view never calls Checkmarx One and never reads a file: it is served from memory, with an ETag (an unchanged view answers 304).

## How usage in a period is counted

Checkmarx One reports **totals over a sliding window** (the lookback window), not each use. Govern keeps every complete poll and, from two in a row, works out what each subject used in between: what its total grew by, plus what left the window meanwhile (which it knows from its own earlier polls). A period's usage is the sum of those amounts inside the period, shared by time.
- **The first poll** cannot know when the window's total was used: it spreads it evenly over the window and marks it **estimated**. Once Govern has polled for a whole window, every new figure is exact. The same happens after a change of the lookback window, or a gap longer than the window.
- **Custom periods** count from their own start, **lifetime** from the budget's creation; **Count usage from before the period** counts everything Govern knows of before it (what Checkmarx One still reports).
- **Groups and applications** use Checkmarx One's figure for them when it reports one; otherwise, and for a group counting subgroups, the sum of their projects. **Count group members' usage** adds what each member used themselves.
- **Not reported** is never zero: a level Checkmarx One does not report (it answers an unknown level with the user view, which Govern detects with a probe and refuses), and a level not read yet, show **Not reported**, and nothing is held or released on them. A **stale** level (its last poll failed) keeps its last complete figures, and nothing is held or released on them either.

## Safety by design

- **Write ahead.** Before each change in Checkmarx One, Govern writes to disk (flushed) what it is about to change and what was there before. A crash in the middle leaves that record; the next cycle reads Checkmarx One and finishes or puts it back, with the first snapshot kept.
- **Verify by reading again.** After each change Govern reads the state again: a user is **Restricted** only when no AI role is left (else **Partial**), Auto Triage only when it reads off, PR remediation only when it reads empty.
- **Write back only what was read.** Auto Triage is turned off by writing back the configuration just read, with one switch changed; a configuration in a shape Govern does not know is left alone, with an alert. A setting that cannot be read is not changed (no exact undo), unless an Admin allowed it.
- **Re-breach.** A release because the budget was raised, switched, exempted, deleted or a new period started never stops a new restriction later in the period. Only an admin's restore gives a grace, and the grace ends when usage grows or its date comes.
- **One record per target.** Restrictions are counted per thing restricted, not per budget: overlapping budgets never fight, and the state before is put back only by the last release.
- **Snapshot only when complete.** A level's poll counts only when every page arrived and the subjects match what Checkmarx One said it has; an org list that comes back implausibly short (under half of the last one) is not taken. Otherwise the last good one stays, and nothing is restricted or released on partial data.
- **Outbox.** Every notification is written to disk per channel before it is sent, with its attempts: a restart neither forgets nor repeats it.
- **Nothing in a request.** Saving a budget, importing, approving and restoring never call Checkmarx One inside the request; a failure there never undoes what was saved.
- **Bounded.** A breach of a group or application that would reach more than the budget's limit of targets waits for confirmation; every list and input has a limit.
- **Audited.** Every budget, exemption, import, request, decision, restore, setting, cycle started by hand, restriction made, lifted or failed is in the tenant's audit log (type **govern**), with who, before and after.
- **Stored per tenant**, in the tenant's state folder under `govern/` (files written whole, mode 0600), and in every backup.

## Known limits

- **One lookback window, and estimates.** Govern reads one window for every budget. Until it has polled for a whole window, the usage before its first poll is an estimate, spread evenly (marked so); a change of window, or a pause longer than the window, starts the estimate again. A longer window shows more of the past at the first poll, and stays an estimate for longer.
- **After the fact.** Checkmarx One's consumption is read once a cycle: a team can go over its budget between two cycles, by what it used in that time. CxMissionZero's own AI requests are refused at once.
- **A composite role is not named.** When an AI role comes from a composite role, the restriction is Partial with *A composite role grants …*, without saying which one; find it in Checkmarx One's IAM. A role granted through a group is named, with the group.
- **Restrictions stay while the code is off.** Without its activation code Govern does not run and its page is gone, so it cannot restore. Renew the code, then Restore. What each restriction took is in the audit log (type govern, *enforcement.applied*, before).
- **Groups by name.** Checkmarx One names a user's groups; a name two groups share is not joined to either (a path always is).
- **Credits over time** shows at most 90 days.
- **Checked against the mock and the tests.** The calls above are the ones Govern makes against `loadtest/mock-cxone.mjs` and in `test/govern*.test.js`. On a new tenant, run the permission check, keep budgets in Monitor first, and try Enforce and Restore on one budget before relying on it.

## Troubleshooting

### Permission check

**Settings → Permission check → Run check** tries one cheap read for each thing Govern needs, with the server's key, and shows a matrix: what it is **used for**, **Read** (Allowed, or the reason, *Refused (403): the API key lacks this permission*) and **Change** (Worked, Refused (403): monitor only, or *Shown after the first change*).

| Row | Read tried | Used for | If refused |
| --- | --- | --- | --- |
| Credit consumption | `/api/credits/consumption?viewBy=user&period=last_month&page=1&size=1` | Every budget | Every budget shows Not reported. |
| Tenant credits | `/api/credits/info` | The figures line | Tenant credits shows —. |
| IAM users | `{IAM}/auth/realms/{tenant}/users/v2?first=0&max=1` | Who a budget is for | Users cannot be picked, and usage cannot be attributed to them (their names stay Unmatched). |
| IAM groups | `{IAM}/auth/realms/{tenant}/groups` | Group budgets and their members | Groups cannot be picked; their members are not known. |
| Projects, Applications | `/api/projects`, `/api/applications` | Project and application budgets | They cannot be picked; groups and applications cannot add up or restrict their projects. |
| IAM administration (ast-app client) | `{IAM}/auth/admin/realms/{tenant}/clients?clientId=ast-app` | Removing and restoring AI roles | User budgets in Enforce cannot restrict: they fail, with an alert. |
| Project AI agents configuration | `/api/ai-agents-coordinator/projects/{one project}/configuration` | Turning Auto Triage off and on | Project budgets in Enforce cannot turn it off. |
| PR remediation settings | — (no safe read) | Turning PR remediation off and on | Shown after the first change. |

A row "Not checked" has nothing to check yet (no IAM address, or no project read yet).

### Diagnose a figure

In a budget's side panel, **Diagnose this figure** (See Govern) walks through how its figure was made and says what is wrong:
1. **In Checkmarx One**: the entity is in the org Govern last read (and when).
2. **Reported by Checkmarx One**: the level is reported, when it was last polled complete and over which window; or that it is not reported (groups and applications then add up their projects), or that its last poll failed.
3. **Attributed**: which names Checkmarx One reported count towards it, or are only suggested for it.
4. **Budget period**, **Usage in the period** (and from where: its own figure, its projects, its members), **Budget state** (with any grace).

The verdict: *the figure is what Checkmarx One reports*; *not in Checkmarx One as Govern last read it*; *not reported at this level*; *reported under a name Govern could not attribute* (decide it under Attribution); or *an estimate*.

### When something looks wrong

| You see | Why, and what to do |
| --- | --- |
| A budget shows **Not reported** | Checkmarx One does not report usage at that level for this tenant, or nothing has been read yet. Run now; check Credit consumption in the permission check. Group and application budgets add up their projects when the project level is reported. |
| A person's usage is lower than in Checkmarx One | Part of it is reported under a name that matches nobody, or is disputed: see Attribution (the Overview banner says how many credits). Diagnose the figure. |
| **Estimated** next to figures | Govern has less history than the lookback window. It becomes exact on its own. |
| **Partial** on a user | An AI role comes from a group or a composite role. Mark the group AI-only, or change the role in Checkmarx One; the restriction is completed next cycle. |
| **Failed** with 403 | The key may not make that change: Govern is monitor-only for it. Give the key the permission, or keep those budgets in Monitor. |
| **Skipped** PR remediation | Its setting could not be read, so it was left on. Check the project's repository integration, or allow turning it off without a readable setting (restored to the default). |
| **Needs confirming** | The budget would restrict more projects than its limit. Open it: **Confirm restricting more than that** (Enforce budgets), or raise the limit. |
| The last cycle **Partly read** | A page of consumption or part of the org did not arrive. The last complete figures stay in use; the Sync errors alerts say which. |
| Restored, then restricted again | Usage grew past the grace after the restore. Raise the budget or approve a request instead. |
| No emails | Email on, recipients set, minimum severity met, and CxMissionZero's mail server working (Send test email). The Delivery column says what happened to each alert. |
| The webhook says **failed** | The Delivery column has the reason. Send test webhook: an address that is not `https`, carries a user name or password, or resolves to a link-local or cloud metadata address or to this machine is refused; a redirect or an answer other than 2xx is a failure. |

## For developers

- **Code**: `src/govern/` (`routes.js` lists every endpoint and the permission each needs; `cycle.js` the cycle and its call budget; `ingest.js` reading and increments; `evaluate.js` budgets, periods and targets; `enforce.js` restrictions; `attribution.js`; `csv.js`; `notify.js`; `requests.js`; `store.js`; `usage-index.js`; `view.js`), `public/govern.js` (the page), `src/iam.js` (the permissions and the Security Champion role), `src/features.js` and `src/activation.js` (`feature:govern`).
- **API**: everything under `/api/govern`, each route behind the feature and its `govern.*` permission. Lists take `offset` and `limit` (up to 500). Changes are audited.
- **State**, per tenant in `govern/`: `budgets.json`, `periods.json`, `subjects.json`, `requests.json`, `settings.json`, `runs.json`, `holds.jsonl` (the write-ahead record), `alerts.jsonl`, `alert-reads.json`, `outbox.jsonl`, `usage-<level>.json`, `org.json`, `dimensions.json`, `credits.json`. `GOVERN_TICK_MS` changes the 15-second tick.
- **The mock**: `loadtest/mock-cxone.mjs` with `GOVERN=1` answers consumption for every level (group and unknown levels with the user view, to test the trap), IAM users, groups, role mappings and composites, Auto Triage and PR remediation. Test controls: `/__consumption?key=user:<email>&add=<credits>`, `/__govern-fail?view=<level>&on=1` (a partial poll), `/__iam`, `/__autotriage`.
- **Tests**: `test/govern*.test.js` (`npm test`).
