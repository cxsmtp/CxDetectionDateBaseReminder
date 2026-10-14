# Cx Credits Calculator

The **Cx Credits Calculator** works out the Checkmarx One credits a customer needs, from their own data, and makes a report of it to hand them. It has three tabs:

- **Triage & remediation:** the credits it takes to triage and remediate their backlog, from the backlog and fixes week by week in their Checkmarx One, and how fast the backlog clears.
- **Fusion:** the credits Fusion scans of their projects take, from each project's lines of code, criticality and how often it is scanned.
- **Projection reports:** every report made, to download again.

Both tabs come from the **Checkmarx One tenant this server is connected to**, in one read: see [Reading Checkmarx One](#reading-checkmarx-one). At the top, a summary strip adds the two together, with an extra % on top if you want one, and says how many **bundles** of credits that is.

It is in the side menu under **Plan**, after Act, Follow up and Prove. On a phone, open it with **Jump to** (Ctrl K) → *Cx Credits Calculator*.

## Who can use it

It is a permission, with no activation code: **Cx Credits Calculator** (`projections.use`, in the *AI & credits* group on People & roles).
- **Admins** have it, always.
- **Every other role** gets it only when an Admin ticks it for that role under **People & roles**. So on a customer's own installation (a proof of value, say), where everyone else is a Security Analyst, nobody but the Admins sees it unless an Admin decides otherwise.
- Taking it away hides the calculator from that role at once; its customers and reports are kept for when it is given back.
- **Deleting a projection report** is the separate **Delete reports** permission, which only the Admin role can hold.

From MZ-01.00.62 to this version: the calculator no longer needs its activation code, and the built-in Security Analyst role no longer has the permission by default (it was taken off once, on the update). An Admin ticks it again for whoever should have it. A calculator code applied under MZ-01.00.62 is simply no longer used.

Everyone with the permission in a tenant sees the same customers and reports. With several tenants, each tenant has its own.

## The organisation's name

Reports are made in the name of **your organisation** (the one preparing them, not the customer).

- The first time an Admin accepts the terms of use for the organisation, the terms dialog asks for the organisation's name, and **Accept** stays off until one is given.
- An Admin can change it later under **Settings → About & terms of use → Organisation**.
- In a container, `ORGANISATION_NAME` in the `.env` sets it at start-up, when none has been given yet.

The calculator shows the name the reports will carry, above **Generate projection report**.

## Customers

- **New customer** starts one, named after your organisation (the name given in the terms dialog the first time the terms were accepted) while no customer has that name yet, otherwise *Customer 2*, *Customer 3*… Type another name over it in **Name**.
- The first time the calculator is opened, with no customer yet and the organisation's name given, it starts that customer by itself and reads Checkmarx One for it.
- **Customer** switches between them. The one you had open opens again next time, in this browser.
- Every change saves itself about a second later. The line by the buttons says **Saving…**, then **Saved** and the time. If a save is refused, it says why there, and nothing that was saved before is lost.
- **Delete customer** removes it, with its uploads, plan and Fusion projects, after you confirm. Reports already made are kept.

Limits: 200 customers per tenant, and 3 MB per customer: room for years of weekly figures and thousands of projects.

Customers are in `projections.json` in the data folder (per tenant), and in every backup. A profile made with MZ-01.00.61's *Credit projections* opens here as a customer, with its exports, plan and Fusion projects; its old credits per bundle become a Fusion model.

## One click

Open the calculator and select **Generate projection report**. That is all it takes: when nothing is read yet it reads Checkmarx One first, then makes the report with every default in place (every open finding, the findings still to come over 12 months at the last 3 months' pace, falling 2% a month as teams adopt AI, 5% more found by Fusion, 10% fewer false positives with FAE, 1 and 3 credits per triage and remediation, 30% false positives). Everything below changes the defaults, when you want to.

- **Email the report** makes the report the same way and sends it, as an attachment in the page's language, to up to 10 addresses you type (through Settings → Email server, which must be set up and tested). It is in the audit log.
- **Start again** clears every choice made for the customer (the projects narrowed, the plan, the Fusion numbers, the extra credits) and reads Checkmarx One again. The Fusion models and their credits stay; reports already made are kept.

## Which projects count

Under **Read from Checkmarx One**, **Applications** and **Projects** count only some projects, for triage & remediation and Fusion alike, as narrowing the Dashboard does. Type a name and pick it from the list, or press Enter (or **Apply**, which also applies **More filters** when they are open) to add every name that contains the text; each one picked becomes a chip, removed with **×**. The figures follow at once. These applications' projects count, plus the projects picked one by one.

**More filters** narrows further:

| Field | Keeps the projects… |
| --- | --- |
| **Groups** | in these groups, as Checkmarx One lists them |
| **Project names** | whose name matches: `payments-*`, `*-api`, `svc-?` (`*` any text, `?` one character); a name without wildcards matches any name containing it |
| **Last scanned by** | whose last scan was run by these people |
| **How often they are scanned** | scanned this often in the last year |
| **Criticality** | with these criticalities, 1 to 5 |

Several values in a field: separate them with commas; any of them will do. Every field filled in must hold (on top of the applications and projects picked). Empty fields keep every project, and **Every project** clears them all. The line says how many projects the scope keeps (*10 of 40 projects · Application: Mobile*).

Two boxes under **Applications** and **Projects** leave out projects with nothing to analyse, for both parts:

| Box | Leaves out |
| --- | --- |
| **Leave out projects with no lines of code** (ticked by default) | projects whose latest scan counted 0 lines of code (lines typed in over the count are used instead); a project whose count is not known is kept |
| **Leave out projects with no open findings** (off by default) | projects with no open finding, in the engines counted, at their latest scan; keep it off for a compliance projection that must list every project |

The line says how many each took out (*14 of 16 projects · 2 with no lines of code left out*), and so does the projection report. **Every project** clears the picks but keeps these two as they are.

The backlog and fixes of the projects in the scope are added up on the server from the last read, project by project, so narrowing never reads Checkmarx One again. Each project's weeks are kept for this in `projection-read.json` in the data folder (per tenant, replaced by every read, not in backups). When the figures came from the two exports instead, they cover every project: the scope then narrows Fusion only, and the page says so. A project added by hand always counts.

## Reading Checkmarx One

**Read from Checkmarx One**, at the top of the page, reads the tenant this server is connected to, for both tabs at once:

- every project, with its criticality, its applications and groups, who ran its last scan, and the lines of code its last scan counted;
- every completed scan of each project in the last 12 months, counted **project by project** (so a project scanned 400 times a year shows 400, however many scans the tenant has in all), on its **primary branch** only: the branch set for the project in Checkmarx One, else main, else master, else the branch of its latest scan. A project is often scanned on feature branches too, and counting them would add the same findings to the backlog once per branch. A project whose primary branch was never scanned has no scans counted. Tick **Every branch** beside the button, then read, to count every branch's scans: that is also what Fusion is charged for, when feature branches are scanned with it. The projection report says which was counted;
- each of those scans' results by severity, from Checkmarx One's scan summaries.

It runs on the server in the background: a bar under the button says how far it is (*Reading the projects and their scans: 120 of 1,882…*, then *Reading the findings of each scan…*), and you can carry on meanwhile. One read runs at a time per tenant; a second person who starts one follows the first. When it finishes, its figures go into the customer that was open when it started (or into the one open now, if that has nothing read yet), and are saved with it.

- A customer with nothing read yet reads by itself when it is opened. A read finished in the last 15 minutes serves it straight away.
- **Read from Checkmarx One** again at any time brings the figures up to date. Everything you set (the plan per severity, lines of code typed over, models, scans and projects left out) stays.
- Without a connection to Checkmarx One, the line under the button says so, and the two exports can be used instead (below).
- Under the button: when the figures were last read.

## Triage & remediation

The backlog and fixes, week by week over the last 52 weeks, are worked out from the scans read:

- **Backlog at the end of a week**: for each project, the results of its last scan by then (a project's last scan before the 52 weeks counts until its next one), added up by severity.
- **Fixed in a week**: for each scan that week, what the scan before it reported, plus what this scan found new, less what this scan reports, by severity.

That is the same weekly series as Checkmarx One's *Total Vulnerabilities by Severity* and *Fixed Vulnerabilities by Severity* exports. The line at the top of the tab says where the figures came from: *From Checkmarx One*, when they were read, how many projects and scans, and the weeks they cover.

**Use the two Checkmarx One exports instead** is for a prospect whose tenant this server is not connected to: drop their two weekly exports (`.xlsx` or `.csv`, from Checkmarx One → Analytics) on the two boxes, or click a box to choose the file. **Load sample data** fills both in with two sample exports, for a quick demonstration. Exports uploaded replace the figures read, and reading Checkmarx One again replaces the exports.

**Customer view** hides the editing controls to show the figures to the customer; **Exit customer view** brings them back.

Then the page shows:

1. **What the projection counts**, as one line over the **projection period** (chosen at the top, 12 months by default, shared with Fusion). **Engines counted**, under its heading, chooses whose findings it counts: **SAST** and **SCA** unless more are ticked, because AI Triage and AI Remediation credits are spent on those two. Each project's scans are read engine by engine (a scan summary lists each engine's results apart), so any set of engines is added up without reading again; a read made by a version before MZ-01.00.75 counted every engine together, and the page says to read again. The projection report says which engines it counted. The two exports count every engine together, so with them the choice is greyed out:

   | Step | What it is |
   | --- | --- |
   | **Backlog today** | The open findings to triage: every one, unless you choose fewer |
   | **+ Still to come** | New findings a month over the period, falling each month as teams adopt AI. New findings a month are what the backlog grew by over the trend period, plus what was fixed meanwhile (never below 0), per severity. The first month comes at today's pace and each later one 2% below the one before (by default): over 12 months that is about 10.9 months' worth instead of 12. They follow what you chose under **Customize per severity**: each severity's new findings are counted in the same share as its backlog chosen, so with half of High chosen half of High's new findings count, and a severity set to none adds none |
   | **+ More found by Fusion** | When Fusion is in the projection (some project counted on the Fusion tab): this % more findings, on the backlog and on what is still to come. 5% by default |
   | **− Kept away by FAE** | FAE keeps this % of the new findings (still to come and found by Fusion) from being reported, among the false positives only: it never takes more than the false positives there are, so the true positives do not change. 10% by default |
   | **= To triage** | Each costs its triage credits; the true positives among them are remediated too |
   | **→ Credits** | Split into the backlog today and what is ahead |

   **Count findings still to come**, **AI adoption: fewer new findings each month (%)** (0 to 20; 0 keeps today's pace), **More found by Fusion (%)** and **FAE: fewer false positives (%)** change these, at once; **Defaults** puts them back. A customer saved before MZ-01.00.69 with Fusion on the old 20% default moves to 5%; a value someone typed stays. **3**, **6**, **9** or **12 months** choose the period the trend (new findings and fixes a month) is measured over: 3 by default.
2. **Customize per severity**, right under it, open: how many of the backlog to triage (**All** is every open finding, and stays every open finding when the next read finds more), the false positives expected (%), and the credits per triage and per remediation (Checkmarx One's 1 and 3 to start with). Changes count once you select **Apply**. Each severity's box ends with what it comes to: to triage, to remediate, and the credits. The estimates live here and above, next to their controls.
3. **Debt added against fixes:** one sentence first: each month new findings add X% to the backlog and fixes take away Y%, so it grows (and how much faster fixing would have to be to keep up) or shrinks. Then the timeline: the two, week by week over the last 12 months, each over 4 weeks (a single week jumps about too much) and as a share of the backlog a month. While the red line is above the green one, the backlog grows. Then a short table by severity: open now, added a month, fixed a month, and the change a month. Added is what the backlog grew by plus what was fixed; both percentages are a share of today's backlog, so they compare directly.
4. **Backlog trend and forecast:** the backlog by month, then over the projection period (shaded): if nothing changes, and with the plan. With the plan, the part of each severity not chosen keeps its own trend.
5. **By severity:** one small chart each, the backlog and then with the plan, each on its own scale.

The page no longer has the final matrix of every figure: the projection report's appendix still has it, with added, fixed and the change a month in place of the debt increase and fix rate.

Customers saved before MZ-01.00.67 open with every open finding counted where nothing was chosen, and a trend period of 3 months where it was *Latest* (the latest week, now gone: a single week says too little to project from).

Everything read, uploaded and entered is saved with the customer.

## Fusion

Fusion is paid in credits **per 10K LOC** (10,000 lines of code) **per scan**, at the rate of the AI model the scan uses. Each project's lines of code are rounded up to whole 10K units **on its own**:

| Project | Lines of code | 10K units |
| --- | --- | --- |
| A | 12,000 | 2 |
| B | 18,000 | 2 |
| **Total** | **30,000** | **4**, not 3 |

A project's credits are its 10K units × its Fusion scans × its model's credits per 10K LOC. With Opus-4.7 at 2.5, project A scanned 52 times is 2 × 52 × 2.5 = 260 credits.

### The projects

The same read lists every project in the tenant, with:

- **Lines of code**, from its last completed scan's SAST metadata, or that scan's own SAST details. With neither, the box is left empty to type the number in. A number you typed stays when you read again; the count the scan made is shown under it, with **Use it** to go back to it.
- **Criticality**, 1 to 5, as Checkmarx One has it.
- **How often it is scanned:** its completed scans in the last year (or since it was made, if it is newer), counted project by project, put in one of these: *More than 5 times a week*, *1 to 5 times a week*, *About once in 2 weeks*, *About once a month*, *About once in 2 months*, *About once in 3 months*, *About once in 6 months*, *About once a year*, *Not in the last year*.

The table lists the projects in the scope, the most often scanned first, 100 at a time (**Show more** for the next); the totals always count every project in the scope. Reading again updates the projects; every number typed over, every model chosen and every project left out is kept, and projects that are no longer in Checkmarx One are taken off, with a note of how many. You can also add projects by hand, for a prospect.

### The models

**Fusion models** lists each model with its credits per 10K LOC.

- When reading the projects, the calculator also asks Checkmarx One for the Fusion models the tenant offers, their rates and the credits remaining in the tenant. **Checkmarx One does not document an API for these yet**, so the calculator tries the likely places and uses what it finds; if the tenant does not say, nothing is made up.
- Otherwise, **Add a model** and type the name and rate as Checkmarx One shows them when a Fusion scan is started (for example *Opus-4.7*, 2.5; *Haiku-4.5*, 1.5). A model read from the tenant is marked **From Checkmarx One**. A rate left empty means projects on that model are counted in scans and 10K units, without credits, and the totals say how many.
- When the tenant says how many credits remain, a tile shows it, and whether it is enough for the projection.

### How many Fusion scans each project needs

- **Projection period**, at the top of the page: 6, 12 (the default), 18, 24 or 36 months, for both parts.
- **Default Fusion scans per project** and **Default model**: what every project gets unless a rule or the project says otherwise.
- **Fusion scans by how often projects are scanned:** a number of scans, and a model, for each frequency. A new customer starts with the scans each frequency runs today, so the forecast follows how the customer really works: 52 a year for more than 5 times a week, 26 for 1 to 5 times a week, 12 for once in 2 weeks, 6 for once a month, 4 for once in 2 or 3 months, 2 for once in 6 months, 1 otherwise, scaled to the projection period. Change a number to plan more or fewer; empty uses the default. **Back to the suggested numbers** puts them all back. A customer saved before MZ-01.00.64 with every number empty gets them on its next read.
- **Fusion scans by criticality:** a number, and a model, for each criticality, 5 (most critical) to 1.
- **When frequency and criticality both set a number:** **Use the higher** (the default), **Scan frequency wins**, or **Criticality wins**.
- **On a project:** a number of scans or a model typed in its row wins over everything else. Leave it empty to go back to the rules. The small line under the number says where it came from: *Default*, *Scan frequency*, *Criticality* or *Set here*.
- **Include** leaves a project in or out.

Click a column's heading to sort the table by it (project, criticality, how often it is scanned, lines of code, 10K units, Fusion scans, model or credits), and again for the other way: names start A to Z, numbers largest first, and a value shown as — (not known, or a project left out) always comes last. The choice is remembered in this browser. **Download CSV** downloads the table, in the same order.

## Credits required, extra %, and bundles

The strip at the top of the page adds both parts together for the customer open:

| Tile | What it is |
| --- | --- |
| **Projection period** | How many months the projection covers, for both parts |
| **Triage & remediation** | The credits over the period, split into the backlog today and what is ahead |
| **Fusion** | The credits of the Fusion scans, once there are projects with lines of code |
| **Extra credits (%)** | A margin to add on top of the two, 0 to 500% (empty is none) |
| **Total credits required** | Both, with the extra on top |
| **Credits per bundle** | How many credits one bundle holds: 10,000 unless you change it |
| **Bundles** | Total ÷ credits per bundle, **rounded up** to a whole bundle |

For example, 24,000 + 700.5 credits with 10% extra is 27,170.55 credits: 2.72 bundles of 10,000, so **3 bundles**. The extra % and the credits per bundle are saved with the customer.

## Projection reports

**Generate projection report** makes one report from both tabs and the summary, downloads it, and keeps it on the **Projection reports** tab.

**Download PDF summary** appears once the report is made: three 16:9 pages to present, in the page's language. Page 1 is triage & remediation: the backlog today, the findings still to come, to triage, the credits, and the backlog trend and forecast, with debt added against fixes in one line. Page 2 is Checkmarx Fusion: projects, lines of code, scans and credits, and the credits by how often projects are scanned. Page 3 is the total credits required, in bundles, what they are for, and the assumptions. It is drawn in your browser: nothing is sent anywhere. **PDF** beside each saved report on the **Projection reports** tab makes the same summary for that report.

- The file is named after the customer and the time it was made, on your clock: `Globex_Cx-credits-projection_2026-10-09_2047.html`.
- It is one HTML file with everything in it: no scripts and nothing loaded from anywhere. Open it in any browser, or print it to PDF (always in the light theme).
- It is written in the language the page is in when it is made or downloaded again, right to left for Arabic and Hebrew.
- **Auto**, **Light** and **Dark** at the top switch its theme; Auto follows the reader's system. It opens on the theme you use in the app.
- It is in the app's look when you make it: the next-gen look with your accent (Plus Jakarta Sans and JetBrains Mono when the reader has them), or the classic look. The PDF summary follows the same look.
- Long project or model names wrap inside their cells, and a table wider than the screen (on a phone) scrolls inside its own box: nothing runs off the page.
- It says the answer first: **Total credits required**, the bundles and the period, with one bar of what the credits are for (backlog today, findings ahead, Fusion scans, extra).
- Then that the figures are live: *Read live from Checkmarx One on 12 October 2026: 40 projects, 4,232 scans, 3,653 open vulnerabilities*, the trend period, and the projects counted when the scope was narrowed.
- Then **How we got there**: today's backlog by severity and its trend, the next months (backlog to triage, still to come, more found by Fusion, fewer false positives with FAE, to triage, to remediate, credits), Fusion (projects, lines of code, 10K units, scans, credits), and the backlog forecast.
- Then the **Assumptions**, in one short list.
- Last, **Appendix: every figure**: the matrix by severity and the charts, the Fusion models, scans by frequency and every project. A report made before MZ-01.00.67 opens in the same layout.
- **Projection reports** lists every report, newest first: customer, when, by whom, each part, the extra %, the total and the bundles. **This customer only** narrows it to the customer open. **Download** makes the same file again; **Delete** removes the report after you confirm, and is there only for Admins (the **Delete reports** permission).

Up to 500 reports are kept per tenant (the oldest go first), each up to 4 MB, in the `projection-reports/` folder of the data folder, and in every backup.

## How each number is calculated

Every figure says how it was reached, with the customer's own numbers in, in three places that share one source (`public/calculator/explain.js`), so they never disagree:

- **On the page:** the **?** beside each figure opens a small window with its calculation. Backlog today (chosen of open, per severity), still to come (open now − open then + fixed in between, ÷ the months measured, × the share chosen, × the months' worth over the projection with AI adoption), more found by Fusion, kept away by FAE (never more than the false positives), to triage, to remediate (the true positives), credits (per severity, then backlog today and findings ahead), Fusion credits (10K LOC units × scans × each model's rate) and the total in bundles.
- **In the report:** the assumptions come first, starting with the trend period and the projection period; a closed **How each number is calculated** section at the end opens on a click.
- **In the PDF summary:** a slide states the trend (added, fixed and the change a month, per severity) and how each number is worked out; an appendix after the slides carries every calculation.
