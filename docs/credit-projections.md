# Cx Credits Calculator

The **Cx Credits Calculator** works out the Checkmarx One credits a customer needs, from their own data, and makes a report of it to hand them. It has four tabs:

- **Triage & remediation:** the credits it takes to triage and remediate their backlog, from the backlog and fixes week by week in their Checkmarx One, and how fast the backlog clears.
- **Fusion:** the credits Fusion scans of their projects take, from each project's lines of code, criticality and how often it is scanned.
- **Impact:** what using the credits gives back: hours developers no longer spend triaging and fixing, the expert code review Fusion replaces, flaws found earlier, the breach cost avoided, what the credits cost, and the return (see [Impact](#impact)).
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

Open the calculator and select **Generate projection report**. That is all it takes: when nothing is read yet it reads Checkmarx One first, then makes the report with every default in place (every open finding, the findings still to come over 12 months at the last 12 months' pace, falling 2% over a year as teams adopt AI, 5% more SAST findings found by Fusion, 1 and 3 credits per triage and remediation, 30% false positives). Everything below changes the defaults, when you want to.

- **Email the report** makes the report the same way and sends it, as an attachment in the page's language, to up to 10 addresses you type (through Settings → Email server, which must be set up and tested). It is in the audit log.
- **Start again** clears every choice made for the customer (the projects narrowed, the plan, the Fusion numbers, the extra credits) and reads Checkmarx One again. The Fusion models and their credits stay; reports already made are kept.

## One Apply for every setting at the top

Every setting at the top of the page waits for **Apply**: **Every branch**, **Projects to read**, **Add Fusion** (both ticks), **Include scans from**, the project filters below them (applications, projects, the two leave-out boxes, **More filters**), **Projection period**, **Extra credits (%)** and **Credits per bundle**. Change any of them and a dark bar appears under the credits strip: *2 changes not applied yet*, each change named (*Include scans from*, *Extra credits (%)*…), and each control changed is outlined. Nothing is worked out again, or saved, until **Apply**, which applies them all at once; **Undo** puts every one back as it was. Text typed in **Applications** or **Projects** and not yet added is added by **Apply** too, and Enter in a **More filters** field applies.

A change the last read cannot answer needs Checkmarx One read again, and the bar says so beside it (*Every branch (reads Checkmarx One again)*): **Every branch** ticked or unticked, **Projects to read** raised above where the last read stopped (lowering it, or raising it when the last read took every project, waits for the next read), and **Include scans from** when the last read was made before scan origins were recorded. **Apply** then asks first, saying why and that it reads Checkmarx One again, and reads once you agree (cancel, and the changes keep waiting). **Read from Checkmarx One** applies whatever waits without asking, then reads.

Opening another customer drops the changes waiting. The plan inside the tabs (**Customize per severity**, which keeps its own **Apply** per severity, the trend months, the engines counted, the Fusion numbers) still counts as it is changed; **Include it** on a Fusion tab counts at once too.

On a phone the bar sits above the tab bar, over the **Read from Checkmarx One** sheet the settings are changed in, and hides while the scan-origin list is open.

## Which scans count: Include scans from

**Include scans from**, after **Add Fusion**, lists every scan origin the last read found: where each scan came from, as Checkmarx One records it (the tool that started it: a CI plugin, the CLI, the API, the web portal). Each origin shows its scans in the last year and the projects scanned from it (*Jenkins · 41,220 scans · 3,104 projects*), most scans first. Every origin is ticked to start with, and one a later read finds for the first time starts ticked too; **Select all** and **Clear** tick or untick them all. The button says how many count (*Every scan origin (8)*, *7 of 8 scan origins*, *No scan origin*).

Only the scans from the origins ticked count:

- **Fusion — existing customer**: how often each project is scanned (its scan frequency, and so its Fusion scans) is worked out from its scans from those origins only. A project scanned 52 times a year from Jenkins and 8 times by hand in the web portal is *1 to 5 times a week* with Jenkins alone, *About once in 2 months* with the web portal alone.
- **Triage & remediation**: the backlog and its trend count each project at its latest scan from those origins, week by week, with the fixes between those scans. **More found by Fusion** stays on SAST's own part of that backlog.
- A project with no scan from any origin ticked is left out of both, and the scope line says how many (*10 with no scan from the scan origins chosen left out*). A project scanned from several origins keeps its scans from the ones ticked. A project added by hand always counts.

The origins are recorded by the read (Checkmarx One's `sourceOrigin` on each scan, else its user agent), as readable names: **Jenkins**, **GitHub Actions**, **Azure DevOps**, **GitLab CI**, **Bitbucket Pipelines**, **TeamCity**, **Bamboo**, **CircleCI**, **Travis CI**, **IDE**, **Code repository (webhook)**, **GitHub**, **CLI**, **API**, **Web portal (by hand)**; a tool not known here keeps the name Checkmarx One gives it, and a scan that says nothing is **Not said**. The read keeps each project's weeks per origin on the server (in `projection-read.json`; a project scanned from several origins also keeps its scans in short), so changing the origins is worked out from the last read, never reading Checkmarx One again. A read made before scan origins were recorded has none: the list then says to read again, and **Apply** asks to read.

The origins ticked are saved with the customer (every origin, unless some are unticked); a customer saved before opens with every origin. The projection report and its PDF summary name the origins counted when not all (*Scans from: Jenkins, GitHub Actions.*), and the projects left out for having no scan from them. When triage & remediation comes from the two exports, the exports count every scan: the origins then choose Fusion's scans only, and the page and the report say so. The HTML-only calculator works from the exports and has no scan origins: the list is hidden there; the Node.js one reads them as this page does.

## Which projects count

Under **Read from Checkmarx One**, **Applications** and **Projects** count only some projects, for triage & remediation and Fusion alike, as narrowing the Workbench does. Type a name and pick it from the list, or press Enter to add every name that contains the text; each one picked becomes a chip, removed with **×**. Like every setting at the top, they count once you select **Apply** ([above](#one-apply-for-every-setting-at-the-top)). These applications' projects count, plus the projects picked one by one.

**More filters** narrows further:

| Field | Keeps the projects… |
| --- | --- |
| **Groups** | in these groups, as Checkmarx One lists them |
| **Project names** | whose name matches: `payments-*`, `*-api`, `svc-?` (`*` any text, `?` one character); a name without wildcards matches any name containing it |
| **Last scanned by** | whose last scan was run by these people |
| **How often they are scanned** | scanned this often in the last year |
| **Criticality** | with these criticalities, 1 to 5 |

Several values in a field: separate them with commas; any of them will do. Every field filled in must hold (on top of the applications and projects picked). Empty fields keep every project, and **Every project** clears them all. The line says how many projects the scope keeps, as applied (*10 of 40 projects · Application: Mobile*). **How often they are scanned** is each project's frequency from the scans of the origins ticked.

Two boxes under **Applications** and **Projects** leave out projects with nothing to analyse, for both parts:

| Box | Leaves out |
| --- | --- |
| **Leave out projects with no lines of code** (ticked by default) | projects whose latest scan counted 0 lines of code (lines typed in over the count are used instead); a project whose count is not known is kept |
| **Leave out projects with no open findings** (off by default) | projects with no open finding, in the engines counted, at their latest scan; keep it off for a compliance projection that must list every project |

The line says how many each took out (*14 of 16 projects · 2 with no lines of code left out*), and so does the projection report. **Every project** clears the picks but keeps these two, **Projects to read** and the scan origins as they are.

The backlog and fixes of the projects in the scope are added up on the server from the last read, project by project, so narrowing never reads Checkmarx One again. Each project's weeks are kept for this in `projection-read.json` in the data folder (per tenant, replaced by every read, not in backups). When the figures came from the two exports instead, they cover every project: the scope then narrows Fusion only, and the page says so. A project added by hand always counts.

## Reading Checkmarx One

**Read from Checkmarx One**, at the top of the page, reads the tenant this server is connected to, for both tabs at once:

- every project, with its criticality, its applications and groups, who ran its last scan, and the lines of code its last scan counted;
- every completed scan of each project in the last 12 months, counted **project by project** (so a project scanned 400 times a year shows 400, however many scans the tenant has in all), on its **primary branch** only: the branch set for the project in Checkmarx One, else main, else master, else the branch of its latest scan. A project is often scanned on feature branches too, and counting them would add the same findings to the backlog once per branch. A project whose primary branch was never scanned has no scans counted. Tick **Every branch** beside the button and **Apply** (it asks, then reads), to count every branch's scans: that is also what Fusion is charged for, when feature branches are scanned with it. The projection report says which was counted;
- each of those scans' results by severity, from Checkmarx One's scan summaries;
- where each scan came from (its scan origin), for **Include scans from** ([above](#which-scans-count-include-scans-from)).

**Projects to read**, beside **Every branch**, is how many of the tenant's projects a read takes: 10,000 unless you set another number, up to 50,000, kept with the customer once applied (raised above where the last read stopped, **Apply** asks to read again). A tenant with more is read only in part, and the read says so (*Read the first 10,000 of 12,431 projects in Checkmarx One: set Projects to read to 12,431 or more and read again to count them all*). A customer keeps up to 50,000 projects (32 MB); before MZ-01.01.03 a read stopped at 5,000 without saying so.

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
   | **+ Still to come** | New findings a month over the period, falling as teams adopt AI. New findings a month are what the backlog grew by over the trend period, plus what was fixed meanwhile (never below 0), per severity. Each engine counts only from the scans it ran in, so a scan that ran only some engines does not make the others look new. The first month comes at today's pace and the pace falls evenly to 2% lower after a year (by default): over 12 months that is about 11.9 months' worth instead of 12. They follow what you chose under **Customize per severity**: each severity's new findings are counted in the same share as its backlog chosen, so with half of High chosen half of High's new findings count, and a severity set to none adds none |
   | **+ More found by Fusion** | When Fusion is in the projection (**Add Fusion: Existing customer** ticked, and some project counted on the Fusion — existing customer tab): this % more SAST findings, on the SAST part of the backlog chosen and of what is still to come: Fusion reads code, so it adds to SAST only. Each severity's SAST share is its own, from the read (SAST's open findings against all those counted, and SAST's new findings against all new ones). 5% by default; 0%, and not editable, while Fusion is left out. The two exports add every engine together, so with them the % is on every finding, and the page says so; a customer saved before MZ-01.01.04 is added up again from the last read when it is opened (if that read is gone, **Read from Checkmarx One** again) |
   | **= To triage** | Each costs its triage credits; the true positives among them are remediated too |
   | **→ Credits** | Split into the backlog today and what is ahead |

   **Count findings still to come**, **AI adoption: fewer new findings over a year (%)** (0 to 90; 0 keeps today's pace) and **More found by Fusion (%)** change these, at once; **Defaults** puts them back. A customer saved before MZ-01.00.69 with Fusion on the old 20% default moves to 5%; a value someone typed stays. **3**, **6**, **9** or **12 months** choose the period the trend (new findings and fixes a month) is measured over: 12 by default, and a customer saved on the old default of 3 moves to 12. FAE is not part of the projection from MZ-01.01.03: a customer saved with an FAE percentage keeps it stored, unused.
2. **Customize per severity**, right under it, open: how many of the backlog to triage (**All** is every open finding, and stays every open finding when the next read finds more), the false positives expected (%), and the credits per triage and per remediation (Checkmarx One's 1 and 3 to start with). Changes count once you select **Apply**. Each severity's box ends with what it comes to: to triage, to remediate, and the credits. The estimates live here and above, next to their controls.
3. **Debt added against fixes:** one sentence first: each month new findings add X% to the backlog and fixes take away Y%, so it grows (and how much faster fixing would have to be to keep up) or shrinks. Then the timeline: the two, week by week over the trend period chosen (never less than 6 months), each over 4 weeks (a single week jumps about too much) and as a share of the backlog a month. While the red line is above the green one, the backlog grows. Then a short table by severity: open now, added a month, fixed a month, and the change a month. Added is what the backlog grew by plus what was fixed; both percentages are a share of today's backlog, so they compare directly.
4. **Backlog trend and forecast:** the backlog by month, then over the projection period (shaded): if nothing changes, and with the plan. With the plan, the part of each severity not chosen keeps its own trend.
5. **By severity:** one small chart each, the backlog and then with the plan, each on its own scale.

The page no longer has the final matrix of every figure: the projection report's appendix still has it, with added, fixed and the change a month in place of the debt increase and fix rate.

Customers saved before MZ-01.00.67 open with every open finding counted where nothing was chosen, and a trend period of 3 months where it was *Latest* (the latest week, now gone: a single week says too little to project from).

Everything read, uploaded and entered is saved with the customer.

## Fusion

The calculator has two Fusion tabs: **Fusion — existing customer**, for projects already in Checkmarx One, read with their lines of code, criticality and how often they are scanned; and **Fusion — new customer**, for code not in Checkmarx One yet, counted from git or with cloc ([below](#fusion--new-customer-code-counted-from-git-or-with-cloc)). **Add Fusion**, in the main configuration at the top, has a tick for each, **Existing customer** and **New customer** (both ticked by default): the total counts only the ticked ones.

**Leaving Fusion out.** For a customer not taking Fusion, untick **Add Fusion: Existing customer** in the main configuration at the top, beside **Read from Checkmarx One** (ticked by default). Fusion is then left out of everything: the credits (the tile says **Left out**), the findings Fusion adds to triage & remediation (**More found by Fusion** shows 0% and cannot be changed), the Impact tab, the projection report and its PDF summary. The Fusion — existing customer tab says so at its top, with **Include it** to count it again, and keeps its models, numbers and projects for when it is; ticking it again brings back the % it had. The choice is saved with the customer; **Start again** ticks it again.

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

- A new customer starts with the models Checkmarx One offers a Fusion scan: **opus-4.7**, **haiku-4.5**, **opus-5.0**, **opus-5.5** and **mythos-5.1** (marked **Checkmarx One model**), their credits per 10K LOC left empty to type in: no Checkmarx One API says them. The standalone calculator starts with the same five.
- When reading the projects, the calculator asks the tenant which models its **LLM Model** setting offers (`scan.config.ai.llmModel`, `GET /api/configuration/tenant`) and lists those, marked **From Checkmarx One**; a model already listed by that name keeps its place and the credits typed for it. It also reads the credits the tenant has left (`GET /api/credits/info`).
- Otherwise, **Add a model** and type the name and rate as Checkmarx One shows them when a Fusion scan is started (for example *opus-4.7*, 2.5; *haiku-4.5*, 1.5). A rate left empty means projects on that model are counted in scans and 10K units, without credits, and the totals say how many.
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

## Fusion — new customer (code counted from git or with cloc)

For a customer whose code is not in Checkmarx One yet, the lines of code are counted one of two ways, picked at the top of the tab: **Count from git** or **Upload cloc results**. Either way each repository becomes a project in the same table, counted the same way (below), and a project of the same name is replaced.

### Count from git

**1 · Where the code is.** One of the Admin's git connections (GitHub, GitLab, Azure DevOps and Bitbucket, from the Beta page or the environment, numbered ones included: the same as Code authors), shown by host and kind only; their tokens stay on the server. Or **A token for this count only**: the git host, its address (github.com, gitlab.com and bitbucket.org unless another is typed; an Azure DevOps organisation such as `https://dev.azure.com/acme`) and a read-only token: GitHub *Contents: read*, GitLab *read_repository*, Azure DevOps *Code (Read)*, Bitbucket *Repositories: Read* (or `user:app-password`). The typed token is used for that request and the count it starts, then dropped: it is never saved with the customer, never written to a log, the audit or activity log, a file, an address or a command line, never sent back to the browser, and removed from any error git or the host gives. It goes only to its own host (an Azure DevOps token only to its own organisation), as an Authorization header; git gets it through its environment (`http.extraHeader`), never as an argument.

**Which hosts.** The same rule as cloning for Code authors: github.com, gitlab.com, bitbucket.org, dev.azure.com, the hosts the Admin connected, and `SCM_ALLOWED_HOSTS`; https only, never with a user name or password in the address, and never a link-local or cloud metadata address (a name that leads to one is refused too). git is given https only and follows no redirects.

**2 · Which repositories.** Type the organisation (GitHub, or a user), group (GitLab, with its subgroups), project (Azure DevOps; empty for every project) or workspace or project key (Bitbucket), and **List its repositories**: up to 1,000, each with its default branch, size and *archived* tag; those not archived are ticked, up to 50. Or paste clone addresses, one a line (https; a password in one is refused). **Count code lines (N repositories)** counts up to 50 at once, two at a time.

**How it is counted.** For each repository, git fetches only the default branch's latest commit (`--depth 1`, no history, no tags) into a folder of its own (`mz-git-count-…`, readable by the server's user only) under the temporary folder; the files are read where git keeps them (no checkout), counted, and the folder is deleted at once, also when the count fails or runs out of time. A folder left by a server that stopped mid-count is removed at its next start. Each file's language comes from its name or extension (a file without one, from its `#!` line), as cloc names it; blank lines and comment lines (each language's line and block comments, a marker inside a string not counting) are left out; a file in two places is counted once; files git would call binary (a NUL byte in their first 8,000 bytes) and files over 1 MB are skipped. The result is the same shape as cloc's (per language, its files and code lines), so **Languages found** and the credits read it the same way. There is no cloc to install, so totals may differ slightly from cloc's. A repository over 2 GB, or taking more than 10 minutes, is stopped and says so.

**Progress.** A line per repository: *Waiting*, *Fetching the latest commit…*, *Counting… 2,104 of 3,880 files*, then its code lines and main languages, or why it was not counted (the token refused, not found, the host not allowed, too big, too slow). Each repository becomes a project as soon as it is counted.

**From, and Count again.** The table's **From** column says where a project's lines came from: *git · main · 3f2a1c9* (branch and commit; the host and path on hover) or *cloc · payments-api.json*. **Count again** on a git project counts its repository's latest commit again, with the connection it was counted with when it is still set up, or else what step 1 says. The customer keeps, with each git project, its host, repository path and address, branch, commit, when it was counted and the connection's id: never a token. Customers saved before keep their projects as they were.

**Who, and where.** Anyone with the Cx Credits Calculator permission. In the standalone calculator, the launcher (`node cx-credits-calculator.mjs`) counts on its own computer with that computer's git and a token typed there (it has no Admin's connections); without git installed it says so. The HTML file on its own cannot reach git: it offers **Upload cloc results** only.

### Upload cloc results

When the code must not leave the customer, the lines of code come from **cloc** (Count Lines of Code, a free open-source tool) run where the code is: only the counts leave the customer's machine, never the code. `docker.io/aldanial/cloc` is cloc's official image, from its author Al Danial. The tab shows the commands, one line each for Windows cmd:

- **One repository a file:** `podman run --rm -v "C:\code\payments-api:/src:ro" docker.io/aldanial/cloc --json --quiet /src > payments-api.json`, or with cloc installed `cloc --json --quiet --report-file=payments-api.json C:\code\payments-api`.
- **Many repositories in one file:** `podman run --rm -v "C:\code:/src:ro" docker.io/aldanial/cloc --json --by-file --quiet /src > all-repos.json`. Each folder directly in `C:\code` becomes a project.
- **CSV** (`--csv` in place of `--json`) is read too.

Drop the files on the tab, or **choose files** (up to 50 MB each; a larger --by-file report is refused with what to do: run cloc without --by-file). A one-repository file becomes a project named after the file (`payments-api.json` → *payments-api*), renamed in the table if needed; a project of the same name is replaced, so a recount updates it. A file that is not a cloc report is refused, saying to run cloc with --json or --csv. **Add a project by hand** takes a name and its lines.

**What counts.** Only code lines, never blank or comment lines, and only in languages Fusion scans. **Languages found** lists every language in the files with its lines: JSON, YAML, Markdown, XML, CSV, Text, SVG and HTML start crossed out (documentation, data and markup, not counted); click a language to count it, or to leave it out. Lines typed on a project win over its counted ones.

**Credits.** As on the existing customer tab: each project's lines are rounded up to whole 10K LOC units on its own, and its credits are its units × its Fusion scans × its model's credits per 10K LOC. **Fusion scans per project** (12 to start with, over the projection period) and **Model** apply to every project; a number of scans or a model typed on a project wins. The models and their rates are the existing customer tab's, and **Model** starts as that tab's default. For example, 182,400 lines of Java is 19 units: 19 × 12 scans × 40 credits = 9,120 credits. A model without a rate is said, not counted as free.

**Counted once.** A project whose name is also on the existing customer tab is flagged, so the same code is not counted on both by mistake: untick it on one of them unless it really is a second copy. **Include** leaves a project in or out; unticking **Add Fusion: New customer** leaves the whole tab out (it says **Left out**) and keeps its projects and settings.

The tab is saved with the customer, and the projection report, its PDF summary and the standalone calculator show it as its own part of the Fusion credits.

## Credits required, extra %, and bundles

The strip at the top of the page adds both parts together for the customer open:

| Tile | What it is |
| --- | --- |
| **Projection period** | How many months the projection covers, for both parts |
| **Triage & remediation** | The credits over the period, split into the backlog today and what is ahead |
| **Fusion — existing** | The credits of the Fusion scans of the customer's projects in Checkmarx One, once there are projects with lines of code. **Add Fusion: Existing customer** (at the top) unticked: **Left out**, and nothing of it counts |
| **Fusion — new** | The credits of the Fusion scans of the code counted from git or with cloc. **Add Fusion: New customer** unticked: **Left out** |
| **Extra credits (%)** | A margin to add on top of the two, 0 to 500% (empty is none) |
| **Total credits required** | Triage & remediation and each Fusion part ticked, with the extra on top |
| **Credits per bundle** | How many credits one bundle holds: 10,000 unless you change it |
| **Bundles** | Total ÷ credits per bundle, **rounded up** to a whole bundle |

For example, 24,000 + 700.5 credits with 10% extra is 27,170.55 credits: 2.72 bundles of 10,000, so **3 bundles**. The projection period, the extra % and the credits per bundle wait for **Apply** like every setting at the top, and are saved with the customer.

## Impact

**Held back while it matures (from MZ-01.00.91).** The **Impact** tab is shown only once an activation code turns it on ([activation codes](activation-codes.md): `feature … impact on`); an `impact off` code, or the code running out, hides it again. While it is off, the projection report and its PDF summary have no impact section, and the standalone calculator (both downloads) never has the tab.

What the triage & remediation credits give back, worked out from the **Triage & remediation** tab with six assumptions kept with each customer. A new customer starts from **Settings → Impact** (the minutes and rates used on the Impact page); change them here for this customer.

| Assumption | Default | Used for |
| --- | --- | --- |
| Minutes to triage a finding by hand | 20 | Every finding AI Triage looks at is one a person does not. |
| Minutes to fix a finding by hand | 120 | Every true positive AI Remediation fixes saves this… |
| Minutes to review an AI fix | 15 | …less the time a developer reviews the AI fix. |
| A developer's hour costs | (empty) | The hours, as money. Without it, the tab shows hours only. |
| A credit costs | (empty) | What the credits cost. Without it, there is no return to work out. |
| Currency | from Settings → Impact | How money is written. |

What it shows, for the projection period:

- **Hours given back:** findings to triage × minutes to triage ÷ 60, plus true positives × (minutes to fix − minutes to review) ÷ 60; and the same as **developer-years** at 1,800 working hours a year.
- **Value of that time:** hours × a developer's hour.
- **What the credits cost:** the triage & remediation credits × a credit's price.
- **Return:** (value − cost) ÷ cost, as a percentage, and **paid back in**: cost ÷ the value of a month.
- **False positives cleared:** findings to triage − true positives; none of them reaches a developer.
- **By severity:** findings triaged by AI, false positives cleared, fixed by AI, hours saved and credits, for each severity.

Each step is shown with the figures in under **How each number is calculated**, on the tab, in the report and in the PDF's appendix. The figures say what people would no longer do by hand; they are an estimate from the assumptions above, which the customer can check against their own.

### Fusion's impact

Fusion has frontier AI models read every line of each project on every Fusion scan. What that gives back, from the **Fusion** tab (each project's lines of code and Fusion scans) and the **Triage & remediation** tab (the findings Fusion adds), with six more assumptions kept with each customer:

| Assumption | Default | Used for |
| --- | --- | --- |
| Lines an expert reviews in an hour | 200 | The expert review Fusion replaces. |
| Reviewers in a team | 3 | How long a team takes to read the code once. |
| A fix after release costs (× a fix while coding) | 5 | What finding a flaw earlier saves. |
| Chance a critical or high finding leads to a breach (%) | 0.5 | The breach cost avoided. |
| A breach costs | 4,880,000 | IBM's Cost of a Data Breach 2024 average, in the customer's currency once changed. |
| Count the breach cost avoided in the return | off | It is an expected cost, not money saved. |

- **Expert review replaced:** lines read (each project's lines × its Fusion scans) ÷ lines an expert reviews in an hour, in hours, and their value at a developer's hour.
- **Every line read:** how many times, on average, over the period.
- **Cost per 10K lines read:** what the Fusion credits cost ÷ the lines read in 10K units, beside what an expert costs for the same 10K lines.
- **Reviewers to keep pace:** the expert hours ÷ the working hours in the period: full-time reviewers it would take to read what Fusion reads.
- **A team reading it once:** the lines ÷ lines an hour ÷ (reviewers × 40 hours), in weeks.
- **Found earlier, fixed cheaper:** the true positives Fusion adds (more found by Fusion, less their false positives) fixed while the code is being written: × (the multiple − 1) × the minutes to fix one by hand, in hours and money.
- **Breach cost avoided:** the critical and high ones among them × the chance one leads to a breach × what a breach costs. Shown always; in the return only when ticked.

**All the credits give back**, at the top of the tab, adds triage & remediation and Fusion together, against what every credit costs: the **Return** and when the credits are **paid back**. The PDF's slide 4 shows that, with where the value comes from (AI Triage, AI Remediation, expert review replaced, found earlier, and the breach cost when counted).

## Projection reports

**Generate projection report** makes one report from both tabs and the summary, downloads it, and keeps it on the **Projection reports** tab.

**Download PDF summary** appears once the report is made: 16:9 pages to present, in the page's language: the three below and the impact. Tick **Include the calculations in the PDF** (beside **Generate projection report**, unticked by default) for the appendix too: the trend and every number worked out, step by step (eight or nine pages in all with the usual data). Page 1 is triage & remediation: the total of open vulnerabilities today (small), the findings still to come (only when counted), to triage with the severities taken whole and in part (*All Critical · All High · Medium: 12,000 of 80,000*), the credits with the false positives assumed, and the backlog trend and forecast, with debt added against fixes in one line. Page 2 is Checkmarx Fusion: projects, lines of code, scans and credits, and the credits by how often projects are scanned. Page 3 is the total credits required, in bundles, what they are for, and the assumptions. Page 4 is what all the credits give back: their value (or hours) for triage & remediation and Fusion together, what they cost, the return, the hours given back, where the value comes from, and the false positives cleared, how often Fusion reads every line and when the credits are paid back. It is drawn in your browser: nothing is sent anywhere. **PDF** beside each saved report on the **Projection reports** tab makes the same summary for that report.

- The file is named after the customer and the time it was made, on your clock: `Globex_Cx-credits-projection_2026-10-09_2047.html`.
- It is one HTML file with everything in it: no scripts and nothing loaded from anywhere. Open it in any browser, or print it to PDF (always in the light theme).
- It is written in the language the page is in when it is made or downloaded again, right to left for Arabic and Hebrew.
- **Auto**, **Light** and **Dark** at the top switch its theme. It opens light, whatever the theme you use in the app.
- It is in the app's look when you make it: the command-center look with your accent (Fraunces and IBM Plex when the reader has them, else Palatino or Georgia and the system's sans), or the classic look. The PDF summary follows the same look.
- Long project or model names wrap inside their cells, and a table wider than the screen (on a phone) scrolls inside its own box: nothing runs off the page.
- It says the answer first: **Total credits required**, the bundles and the period, with one bar of what the credits are for (backlog today, findings ahead, Fusion scans, extra).
- Then **How we got there**: today's backlog by severity and its trend, the next months (the vulnerabilities in scope, with the severities included and excluded; still to come, when it is counted; more found by Fusion; to triage, to remediate and credits, with the false positives assumed), Fusion (projects, lines of code, 10K units, scans, credits), and the backlog forecast.
- Then the **Assumptions**, in one short list.
- Then **Appendix: every figure**: the matrix by severity (backlog, the debt rate and fixing rate over the last 6 months as a share of the backlog, to triage, the true positives after the false positives assumed, and the credits) and the charts, the Fusion models, scans by frequency and every project. A report made before MZ-01.00.67 opens in the same layout.
- Last, **Data source**, closed until opened: that the figures are live (*Read live from Checkmarx One on 12 October 2026: 40 projects, 4,232 scans, 3,653 open vulnerabilities*), the trend period, the projects counted when the scope was narrowed, and those left out for having no scan from the scan origins counted. The assumptions name those origins when not every one counts (*Scans from: Jenkins, GitHub Actions.*), in the PDF summary too.
- **Projection reports** lists every report, newest first: customer, when, by whom, each part, the extra %, the total and the bundles. **This customer only** narrows it to the customer open. **Download** makes the same file again; **Delete** removes the report after you confirm, and is there only for Admins (the **Delete reports** permission).

Up to 500 reports are kept per tenant (the oldest go first), each up to 4 MB, in the `projection-reports/` folder of the data folder, and in every backup.

## On its own: the standalone calculator

The calculator can be given to anyone (a partner, a customer, a colleague without access here) in two forms, both blank: nothing of this server's customers, reports, people or Checkmarx One key is in them. Both are for those with the Cx Credits Calculator permission.

**Download standalone calculator**, at the top right of the calculator, downloads `cx-credits-calculator.mjs` (`GET /api/projections/standalone?kind=launcher`): the calculator with a small launcher that reads Checkmarx One with an API key.

- **Run it with Node.js** (20 or later, nothing else to install): `node cx-credits-calculator.mjs`. It opens the calculator in the browser at the address it prints (`--port 8080` picks the port, `--no-open` only prints the address); Ctrl+C stops it.
- **Paste a Checkmarx One API key** at the top of the page and **Connect**. The key says the tenant and where it is; **Advanced** overrides the Checkmarx One address, the IAM address or the tenant, for a key that does not say them. **Read from Checkmarx One** then reads the tenant as this page does, with the same code (`src/projections.js`, `src/cxone/`), **Every branch** and **Include scans from** included; **Disconnect** forgets the key.
- **Kept to that computer.** The launcher listens on 127.0.0.1 only and answers only the page it served: each run puts a new secret in the page, and a request without it, or under another host name, is refused (403, 421). It sends no CORS headers, so no other site can call it. The key is checked once against Checkmarx One and then held in the launcher's memory only: it is never written to disk, logged or put in a report, and is gone when the launcher stops. What was read is kept in that memory too.
- **Behind TLS inspection**, set `NODE_EXTRA_CA_CERTS` to the company's root certificate before running it. A proxy that needs to be configured is not supported: run it where Checkmarx One can be reached directly.
- **The page** is the same as the HTML file below, with the read added: about 1.5 MB, the launcher's own code included (`src/calculator-launcher.js`). When Node.js is not to hand, it can still work from the two exports.

**HTML only**, beside it, downloads `cx-credits-calculator.html` (`GET /api/projections/standalone`): the calculator as one file, for a computer without Node.js.

- **One file, no server.** It opens in any browser, from a disk, an email or a share, with no install and no sign-in. Its content security policy allows it no network calls at all: nothing it holds leaves the browser.
- **From the two exports.** Checkmarx One's API refuses calls from a page outside its own website (its gateway answers the browser's preflight with 401 and no CORS headers), so a file opened from disk cannot read a tenant with an API key: that is what the launcher is for. The two exports stand in, as for a prospect here; Fusion's projects and models are added by hand. The read from Checkmarx One, **Every branch**, **Projects to read** and **Include scans from** are not in it.

Both:

- **The same calculator.** They are built, when downloaded, from the files this page runs on: the page itself, its modules (`public/calculator/*.js`), the .xlsx reader, the sample exports and the app's styles (`src/standalone-calculator.js`). So the projection, the Impact, both Fusion tabs, **Add Fusion**, the projection report and its PDF summary are this page's, figure for figure. Customers and reports are checked by the same rules as on the server (`public/calculator/profiles.js`, used by both). **Email the report** is not in them.
- **Names on the reports.** **Your organisation** and **Prepared by**, at the top, are remembered in that browser.
- **Kept in the browser.** Customers and reports are kept in the browser's own database (IndexedDB), at most 200 customers and 500 reports, as here. **Back up** downloads them all as one JSON file; **Restore** adds a backup back (same ids replaced, others kept), in that browser or another. A browser that keeps nothing for files opened from disk (some private windows) says so, and keeps them until the page is closed.
- **Their look.** English, the Command center look, opening light (the button at the top right switches to dark), with the open-licence fonts Fraunces and IBM Plex inside and their licence (SIL OFL) at the end of the file.

## How each number is calculated

Every figure says how it was reached, with the customer's own numbers in, in three places that share one source (`public/calculator/explain.js`), so they never disagree:

- **On the page:** the **?** beside each figure opens a small window with its calculation. Backlog today (chosen of open, per severity), still to come (open now − open then + fixed in between, ÷ the months measured, × the share chosen, × the months' worth over the projection, with AI adoption over a year), more found by Fusion, to triage, to remediate (the true positives), credits (per severity, then backlog today and findings ahead), Fusion credits (10K LOC units × scans × each model's rate) and the total in bundles.
- **In the report:** the assumptions come first, starting with the trend period and the projection period; a closed **How each number is calculated** section at the end opens on a click.
- **In the PDF summary,** when **Include the calculations in the PDF** is ticked: eight or nine slides with the usual data. After triage & remediation, Fusion, the total and the impact, slide 5, **Appendix – Calculations**, opens the appendix and lists its pages. Slide 6 states the trend (added, fixed and the change a month, per severity) and how each number is worked out, and the slides after it carry every calculation, step by step (as many as it takes; two with the usual data).
