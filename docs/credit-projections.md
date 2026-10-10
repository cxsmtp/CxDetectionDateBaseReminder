# Cx Credits Calculator

The **Cx Credits Calculator** works out the Checkmarx One credits a customer needs, from their own data, and makes a report of it to hand them. It has three tabs:

- **Triage & remediation:** the credits it takes to triage and remediate their backlog, from two exports they upload, and how fast the backlog clears.
- **Fusion:** the credits Fusion scans of their projects take, from each project's lines of code, criticality and how often it is scanned.
- **Projection reports:** every report made, to download again.

At the top, a summary strip adds the two together, with an extra % on top if you want one, and says how many **bundles** of credits that is.

It is in the side menu under **Plan**, after Act, Follow up and Prove. On a phone, open it with **Jump to** (Ctrl K) → *Cx Credits Calculator*.

## Turning it on

The calculator is **off until its activation code is applied**, and then only for the people with its permission. Both are needed.

**1. The activation code.** It is issued with the same private key as the other [activation codes](activation-codes.md), on the machine that holds `issuer-key.pem`:

```
node scripts/activation.mjs calculator issuer-key.pem "Acme Partners" on
```

- Add a number of months at the end for a code that lasts other than 12 months.
- An Admin pastes the code under **Settings → Activation codes**. The calculator turns on straight away for this server, in every tenant.
- `off` instead of `on` makes a deactivation code: the calculator disappears from the menu and the server refuses its requests. The customers and reports are kept for when it is turned on again.
- Each code is recorded in the credit audit log.

**2. The permission.** **Cx Credits Calculator** (`projections.use`, in the *AI & credits* group on People & roles):
- **Admins** have it.
- **Security Analysts** have it on a new installation. On an installation that existed before MZ-01.00.61, an Admin ticks it for the role, or for any other role, under **People & roles**.

So you can keep the calculator off on a customer's own installation (a proof of value, say), and on for your own.

Everyone with the permission in a tenant sees the same customers and reports. With several tenants, each tenant has its own.

## The organisation's name

Reports are made in the name of **your organisation** (the one preparing them, not the customer).

- The first time an Admin accepts the terms of use for the organisation, the terms dialog asks for the organisation's name, and **Accept** stays off until one is given.
- An Admin can change it later under **Settings → About & terms of use → Organisation**.
- In a container, `ORGANISATION_NAME` in the `.env` sets it at start-up, when none has been given yet.

The calculator shows the name the reports will carry, above **Generate projection report**.

## Customers

- **New customer** starts one. Type the customer's name over *New customer* in **Name**.
- **Customer** switches between them. The one you had open opens again next time, in this browser.
- Every change saves itself about a second later. The line by the buttons says **Saving…**, then **Saved** and the time. If a save is refused, it says why there, and nothing that was saved before is lost.
- **Delete customer** removes it, with its uploads, plan and Fusion projects, after you confirm. Reports already made are kept.

Limits: 200 customers per tenant, and 3 MB per customer: room for years of weekly figures and thousands of projects.

Customers are in `projections.json` in the data folder (per tenant), and in every backup. A profile made with MZ-01.00.61's *Credit projections* opens here as a customer, with its exports, plan and Fusion projects; its old credits per bundle become a Fusion model.

## Triage & remediation

It needs two exports from the customer's Checkmarx One, as `.xlsx` (or `.csv`):

| Export | What it holds |
| --- | --- |
| **Total Vulnerabilities by Severity** | The open backlog at the end of each week |
| **Fixed Vulnerabilities by Severity** | What was closed during each week |

Drop each on its box, or click the box to choose the file. **Load sample data** fills both in with two sample exports, for a quick demonstration. **Customer view** hides the editing controls to show the figures to the customer; **Exit customer view** brings them back.

Then the page shows:

1. **The backlog as of the latest week**, against the week before.
2. **Choose what to fix.** Per severity: how many open findings to triage, the false positives expected (%), and the credits per triage and per remediation. They start at Checkmarx One's 1 and 3 credits and 30% false positives: set them to the customer's agreement and your estimate. **All** and **None** by each severity fill in its number in one go. Changes count once you select **Apply**.
3. **The credits.** Each finding triaged costs its triage credits. The ones expected to be true positives are remediated too and cost the remediation credits; a false positive costs only its triage.
4. **The final matrix.** Every figure by severity: current backlog, debt increase, fix rate, to triage, false and true positives, credits, and the backlog after. **Latest**, **3**, **6**, **9** and **12 months** choose the period the debt increase and fix rate are worked out over.
5. **The last 3 months, week by week:** the backlog, and the fix rate against the rate the debt grows.
6. **Backlog trend and forecast:** the next 6 months with no action and with the plan.
7. **3-month plan by severity:** each severity's backlog with the plan, on a log scale.

Everything uploaded and entered is saved with the customer.

## Fusion

Fusion is paid in credits **per 10K LOC** (10,000 lines of code) **per scan**, at the rate of the AI model the scan uses. Each project's lines of code are rounded up to whole 10K units **on its own**:

| Project | Lines of code | 10K units |
| --- | --- | --- |
| A | 12,000 | 2 |
| B | 18,000 | 2 |
| **Total** | **30,000** | **4**, not 3 |

A project's credits are its 10K units × its Fusion scans × its model's credits per 10K LOC. With Opus-4.7 at 2.5, project A scanned 52 times is 2 × 52 × 2.5 = 260 credits.

### Reading the projects

**Read projects from Checkmarx One** lists every project in the tenant this server is connected to, with:

- **Lines of code**, from its last completed scan's SAST metadata, or that scan's own SAST details. With neither, the box is left empty to type the number in. A number you typed stays when you read again; the count the scan made is shown under it, with **Use it** to go back to it.
- **Criticality**, 1 to 5, as Checkmarx One has it.
- **How often it is scanned:** its completed scans in the last year (or since it was made, if it is newer), put in one of these: *More than 5 times a week*, *1 to 5 times a week*, *About once in 2 weeks*, *About once a month*, *About once in 2 months*, *About once in 3 months*, *About once in 6 months*, *About once a year*, *Not in the last year*.

The table lists the most often scanned projects first. Reading again updates the projects; every number typed over, every model chosen and every project left out is kept, and projects that are no longer in Checkmarx One are taken off, with a note of how many. You can also add projects by hand, for a prospect.

### The models

**Fusion models** lists each model with its credits per 10K LOC.

- When reading the projects, the calculator also asks Checkmarx One for the Fusion models the tenant offers, their rates and the credits remaining in the tenant. **Checkmarx One does not document an API for these yet**, so the calculator tries the likely places and uses what it finds; if the tenant does not say, nothing is made up.
- Otherwise, **Add a model** and type the name and rate as Checkmarx One shows them when a Fusion scan is started (for example *Opus-4.7*, 2.5; *Haiku-4.5*, 1.5). A rate left empty is *Not known*: projects on that model are counted in scans and 10K units, without credits, and the totals say how many.
- When the tenant says how many credits remain, a tile shows it, and whether it is enough for the projection.

### How many Fusion scans each project needs

- **Projection period (months)**: 12 by default, up to 60.
- **Default Fusion scans per project** and **Default model**: what every project gets unless a rule or the project says otherwise.
- **Fusion scans by how often projects are scanned:** a number of scans, and a model, for each frequency. **Suggest from how often they are scanned** fills them in, never more than the scans each frequency runs today (52 a year for more than 5 times a week, 26 for 1 to 5 times a week, 12 for once in 2 weeks, 6 for once a month, 4 for once in 2 or 3 months, 2 for once in 6 months, 1 otherwise), scaled to the period.
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
- It is one HTML file with everything in it: no scripts and nothing loaded from anywhere. Open it in any browser, or print it to PDF.
- It carries your organisation's name and who made it, then **Credits required** (each part, the extra, the total and the bundles), then the triage & remediation figures and charts, then the Fusion models, scans by frequency and every project.
- **Projection reports** lists every report, newest first: customer, when, by whom, each part, the extra %, the total and the bundles. **This customer only** narrows it to the customer open. **Download** makes the same file again; **Delete** removes the report after you confirm.

Up to 500 reports are kept per tenant (the oldest go first), each up to 4 MB, in the `projection-reports/` folder of the data folder, and in every backup.
