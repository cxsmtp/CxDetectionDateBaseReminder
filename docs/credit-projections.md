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

## Reading Checkmarx One

**Read from Checkmarx One**, at the top of the page, reads the tenant this server is connected to, for both tabs at once:

- every project, with its criticality and the lines of code its last scan counted;
- every completed scan of each project in the last 12 months, counted **project by project** (so a project scanned 400 times a year shows 400, however many scans the tenant has in all);
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

1. **The backlog as of the latest week**, against the week before.
2. **Choose what to fix.** Per severity: how many open findings to triage (the slider, filled up to where it is: empty at 0, full at all of them), the false positives expected (%), and the credits per triage and per remediation. They start at Checkmarx One's 1 and 3 credits and 30% false positives: set them to the customer's agreement and your estimate. **All** and **None** by each severity fill in its number in one go. Changes count once you select **Apply**.
3. **The credits.** Each finding triaged costs its triage credits. The ones expected to be true positives are remediated too and cost the remediation credits; a false positive costs only its triage.
4. **The final matrix.** Every figure by severity: current backlog, debt increase, fix rate, to triage, false and true positives, credits, and the backlog after. **Latest**, **3**, **6**, **9** and **12 months** choose the period the debt increase and fix rate are worked out over.
5. **The last 3 months, week by week:** the backlog, and the fix rate against the rate the debt grows.
6. **Backlog trend and forecast:** the next 6 months with no action and with the plan.
7. **3-month plan by severity:** each severity's backlog with the plan, on a log scale.

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

The table lists the most often scanned projects first. Reading again updates the projects; every number typed over, every model chosen and every project left out is kept, and projects that are no longer in Checkmarx One are taken off, with a note of how many. You can also add projects by hand, for a prospect.

### The models

**Fusion models** lists each model with its credits per 10K LOC.

- When reading the projects, the calculator also asks Checkmarx One for the Fusion models the tenant offers, their rates and the credits remaining in the tenant. **Checkmarx One does not document an API for these yet**, so the calculator tries the likely places and uses what it finds; if the tenant does not say, nothing is made up.
- Otherwise, **Add a model** and type the name and rate as Checkmarx One shows them when a Fusion scan is started (for example *Opus-4.7*, 2.5; *Haiku-4.5*, 1.5). A rate left empty is *Not known*: projects on that model are counted in scans and 10K units, without credits, and the totals say how many.
- When the tenant says how many credits remain, a tile shows it, and whether it is enough for the projection.

### How many Fusion scans each project needs

- **Projection period (months)**: 12 by default, up to 60.
- **Default Fusion scans per project** and **Default model**: what every project gets unless a rule or the project says otherwise.
- **Fusion scans by how often projects are scanned:** a number of scans, and a model, for each frequency. A new customer starts with the scans each frequency runs today, so the forecast follows how the customer really works: 52 a year for more than 5 times a week, 26 for 1 to 5 times a week, 12 for once in 2 weeks, 6 for once a month, 4 for once in 2 or 3 months, 2 for once in 6 months, 1 otherwise, scaled to the projection period. Change a number to plan more or fewer; empty uses the default. **Back to the suggested numbers** puts them all back. A customer saved before MZ-01.00.64 with every number empty gets them on its next read.
- **Fusion scans by criticality:** a number, and a model, for each criticality, 5 (most critical) to 1.
- **When frequency and criticality both set a number:** **Use the higher** (the default), **Scan frequency wins**, or **Criticality wins**.
- **On a project:** a number of scans or a model typed in its row wins over everything else. Leave it empty to go back to the rules. The small line under the number says where it came from: *Default*, *Scan frequency*, *Criticality* or *Set here*.
- **Include** leaves a project in or out.

**Download CSV** downloads the table.

## Credits required, extra %, and bundles

The strip at the top of the page adds both parts together for the customer open:

| Tile | What it is |
| --- | --- |
| **Triage & remediation** | The credits of the plan, once both exports are in |
| **Fusion** | The credits of the Fusion scans, once there are projects with lines of code |
| **Extra credits (%)** | A margin to add on top of the two, 0 to 500% (empty is none) |
| **Total credits required** | Both, with the extra on top |
| **Credits per bundle** | How many credits one bundle holds: 10,000 unless you change it |
| **Bundles** | Total ÷ credits per bundle, **rounded up** to a whole bundle |

For example, 24,000 + 700.5 credits with 10% extra is 27,170.55 credits: 2.72 bundles of 10,000, so **3 bundles**. The extra % and the credits per bundle are saved with the customer.

## Projection reports

**Generate projection report** makes one report from both tabs and the summary, downloads it, and keeps it on the **Projection reports** tab.

- The file is named after the customer and the time it was made, on your clock: `Globex_Cx-credits-projection_2026-10-09_2047.html`.
- It is one HTML file with everything in it: no scripts and nothing loaded from anywhere. Open it in any browser, or print it to PDF (always in the light theme).
- It is written in the language the page is in when it is made or downloaded again, right to left for Arabic and Hebrew.
- **Auto**, **Light** and **Dark** at the top switch its theme; Auto follows the reader's system.
- Long project or model names wrap inside their cells, and a table wider than the screen (on a phone) scrolls inside its own box: nothing runs off the page.
- It carries your organisation's name and who made it, then **Credits required** (each part, the extra, the total and the bundles), then the triage & remediation figures and charts, then the Fusion models, scans by frequency and every project.
- **Projection reports** lists every report, newest first: customer, when, by whom, each part, the extra %, the total and the bundles. **This customer only** narrows it to the customer open. **Download** makes the same file again; **Delete** removes the report after you confirm, and is there only for Admins (the **Delete reports** permission).

Up to 500 reports are kept per tenant (the oldest go first), each up to 4 MB, in the `projection-reports/` folder of the data folder, and in every backup.
