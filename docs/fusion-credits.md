# Fusion credits

From MZ-01.01.19, **Credits → Fusion credits** gives Checkmarx One credits to projects for **Fusion scans only**: the AI engine that scans code alongside SAST. Credits given here cannot be spent on AI Triage or AI Remediation, and the credits given on Credit Control cannot be spent on Fusion. The two are separate buckets, and together they never hold more than the tenant has left in Checkmarx One.

The page follows the **Cx Credits Calculator's Fusion plan**: the same models, credits per 10,000 lines of code, scans per year and the rules by scan frequency or criticality. Agree the plan with the customer in the calculator, bring it here, and give every project its credits and schedule its scans in one click each.

## Who can use it

- The page and its menu item are for **credits.allocate** (Admins and Security Analysts by default). Everyone with **credits.view** can read the figures through the API.
- **The rates** (credits per 10,000 lines for each model) are set by **Admins only**. Others see them, and the Rates tab says so.
- Every allocation, take-back, schedule, pause, resume and rate change is in the audit log.

## The rates

| Model | Credits per 10,000 lines of code, per scan |
| --- | ---: |
| Opus 5.5 | 2 |
| Opus 4.7 | 2.5 |
| Haiku 4.5 | 1.5 |

The **Rates** tab changes them, adds a model (its name and its credits) or removes one. A model without a rate is shown as *No rate for its model yet*, and its projects get no recommendation until it has one. New rates apply to recommendations from then on, and to what each project's scans cost, worked out again from its scans since its allocation.

## The plan

The plan says how many Fusion scans each project gets in the period, and with which model. It comes from one of three places, named on the page's source line:

1. **A plan saved in the calculator here.** *Choose a plan saved in the calculator…*, pick the customer, **Use this plan**. CxMissionZero reads the customer's Fusion tab as it was saved: the models and their credits, the period, how rules combine (by scan frequency, by criticality, or both), the default scans and model, each frequency's and criticality's scans and model, and each project's own scans, model, branch, criticality and whether it is left out.
2. **A plan file.** When the calculator runs at its own address (MZ-01.01.13 and later), open the customer there, **Fusion → Download the Fusion plan**, and open the file here with *Or open a Fusion plan file*. The file holds the same details as above.
3. **Here.** Change the period or a frequency's scans on the page and **Save the plan**.

When the calculator's rate for a model differs from the rate here, the line under the plan shows both. The rate here is the one charged.

## Plan & allocate

**Read projects** reads every project of the tenant from Checkmarx One: its branch, the model its scans use, its lines of code on that branch, the scans of the last 12 months (and so how often it is scanned), its Fusion scans, and the credits the tenant has left. The tiles show:

- **Tenant credits left (Checkmarx One)**;
- **Held for Triage & Remediation** (given on Credit Control and not used);
- **Held for Fusion** (given here and not used);
- **Free to allocate**: what is left after both.

The table has one row a project:

| Column | Meaning |
| --- | --- |
| **Branch** | The branch the credits are worked out on: the primary branch set in Checkmarx One, else *main* or *master*, else the branch of the latest scan. Select it to choose another: the list puts the usual protected branches first (main, master, trunk, develop, dev, release/…, security, hotfix/…, prod, stable), and the project is read again on the branch chosen. The plan's branch, if it names one, is used before the primary branch. |
| **Model** | The model the project's scans use, else the model the plan names for it. |
| **LOC (10K blocks)** | The lines of code on that branch, and how many blocks of 10,000 they make (rounded up). |
| **Scanned today → planned** | Scans a year now, and the Fusion scans the plan gives it in the period. |
| **Recommended** | Blocks × planned scans × the model's rate. |
| **Allocated · Used · Left · State** | What it was given, what its Fusion scans since then cost, what is left, and *On plan*, *Less than one scan left* or *Spent* (*Spent · Fusion paused* when it is paused). |

**Allocate recommended** gives every ticked project its recommended credits, after a confirmation that shows the total. When the page opens, the projects of the plan that have no Fusion credits yet are ticked. On a row, **Allocate** gives a project with no Fusion credits its recommendation, and on a spent project **Add** gives it what one more scan costs (and what it used beyond its credits). An allocation is refused, with what is free, when it would hold more than the tenant has left in Checkmarx One after Triage & Remediation and the other Fusion allocations.

Each allocation keeps what it was worked out for: the scans, the model, the rate, the lines of code and blocks, the branch, the period and the plan's name.

## Scheduling the plan's scans in one click

**Schedule planned scans** schedules, for every ticked project that has been given credits for the plan, the Fusion scans of its plan that have not run yet, spread evenly over the rest of the plan's period (from its first allocation), the first one now. Each scan:

- scans the project again like its latest scan on the plan's branch (the same repository or upload), with Fusion on and the plan's model;
- is started only while the project has credits left for one more scan. Otherwise it waits, the audit log says so once, and it starts once credits are added;
- is tagged `cxmissionzero: fusion-plan` in Checkmarx One.

Projects that cannot be scheduled are listed with the reason (no credits for the plan yet, no scan on its branch to scan again like, every planned scan already run, or a scan from an upload that cannot be repeated). **Used & scheduled → Stop planned scans** stops them; the scans already started go on.

## When the lines of code grow

Every half hour, CxMissionZero reads again the projects that hold Fusion credits. When a project now has more 10,000-line blocks than its credits were worked out for, and what it has left no longer covers the rest of its planned scans, it:

- writes an audit entry (*allocation, refused*) with the extra credits needed;
- emails **every Admin and every Security Analyst** with an address: the lines of code before and now, the blocks, the planned scans still to run, the credits they need, the credits left, the extra credits needed, the branch and the plan.

It does this once for each growth: a project that grows again is reported again. **Allocate recommended** gives it what the plan needs at its new size.

## When a project's credits are spent

What happens is chosen on the Rates tab (Admins):

- **Warn and pause Fusion** (the default): the Admins and the project's owner (who ran its latest scan, when that is an email address) are emailed once, and Fusion is switched off in the project's settings in Checkmarx One (`scan.config.ai.fusionEnabled`). Its scans go on without the AI engine. When credits are added, Fusion goes back as it was: the project's own setting is put back, or, if it had none, the tenant's applies again.
- **Warn only**: the email, and the project is flagged here; its Fusion scans go on.

## Used & scheduled

Every project given Fusion credits: its branch, allocation, Fusion scans since then, used, left, planned scans (left, next, or why waiting), what it needs when its lines of code grew, and whether Fusion is on or paused in Checkmarx One. **Take back unused** gives back to the tenant what the ticked projects have not used; a project with nothing left is then paused like any spent one.

## What it does not do, and what is estimated

- **Usage is estimated**, as in the calculator: each Fusion scan since the allocation × the blocks of the project's lines of code now × the rate of the scan's model (or the project's model when the scan does not name one). Checkmarx One does not report the credits a Fusion scan was charged.
- **A pipeline that asks for Fusion in the scan itself is not stopped** by the project's setting. Pausing stops the scans that follow the project's settings.
- **Projects without a Fusion allocation are never paused**: the page governs only the projects it has given credits to.
- **The scheduled scans' Fusion settings** (`type: ai`, `fusionEnabled`, `llmModel`) were tested against CxMissionZero's test double of Checkmarx One, not yet against a live tenant. The first scheduled scan's entry in the audit log shows whether Checkmarx One accepted it.
- CxMissionZero itself never started Fusion scans before this release: verification rescans and FAE Flush stay SAST only.

## Where it is kept

`fusion-credits.json` in the data folder (per tenant), and in every backup: the rates, the plan, each project's allocation and its history, branch choices, schedules and pauses.
