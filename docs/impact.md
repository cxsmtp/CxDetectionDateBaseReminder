# Impact: what AI did for the backlog

The **Impact** page (sidebar group **Prove**) shows what AI Triage and AI Remediation did for your vulnerability backlog, in hours, money and findings. It also shows how fast the security debt is shrinking. Anyone who may view tracked reports can open it.

It has two tabs:

- **Executive** is for the CISO and leadership: six headline figures, the security debt week by week, and time to fix with AI against by hand.
- **Detail** is for the AppSec team: every project, with CSV export, and the monthly summary email.

Choose the period at the top: the last 30 or 90 days, the last 12 months, or everything since the first reading. **Download the one-page summary** saves the same figures as one HTML page, ready to print or save as PDF from the browser.

## The figures

| Figure | What it says | How it is worked out |
| --- | --- | --- |
| **Hours saved** | The work AI did for your people | Checkmarx One results triaged by AI × minutes per manual triage, plus fixes with AI × minutes per manual fix |
| **Value of that time** / **Saved, after credits** | The same in money | Hours saved × the hourly cost, less the credits used × the price of one credit |
| **Noise removed** | Findings nobody had to look at | Results AI Triage showed not exploitable |
| **Fixed with AI** | Fixes AI wrote that worked | Results sent for AI Remediation that Checkmarx One no longer reports. Fixes made by hand are shown next to it |
| **Security debt** | Is the backlog shrinking, and when will it reach zero? | Open results weighted by severity (critical 10, high 5, medium 2, low 1). The change over the period, and the date it reaches zero at the pace of the last four weeks |
| **Credits per finding closed** | Value for the credits spent | Credits used ÷ findings fixed or cleared by AI (and in money, with a price per credit) |
| **Time to fix, AI-assisted and by hand** | Whether AI shortens exposure | Median days from first detection until Checkmarx One no longer reports the finding, by severity, over the same period, with how many of each |

The numbers are deliberately conservative, so nobody can call them inflated:

- **One result, one count.** Several rows that share one Checkmarx One result count once, as they are charged once.
- **A fix counts only when it is proven.** That means Checkmarx One no longer reports the finding: a pull request opened, or a fix written, is not yet a fix.
- **Same period.** AI-assisted fixes are compared with fixes made by hand over the same weeks, not with an older period when other things were different.
- **Every assumption on show.** **How these are worked out**, at the bottom of the page and of the summary, shows the minutes, rate and price used.

## Settings

**Settings → AI & credits → Impact: time and money**:

| Setting | Default | What it does |
| --- | --- | --- |
| Minutes to triage one finding by hand | 20 | Hours saved by AI Triage |
| Minutes to fix one finding by hand | 120 | Hours saved by AI Remediation |
| Hourly cost of an engineer | 0 | Money figures (0: hours only) |
| Price of one credit | 0 | The cost of credits, subtracted from the value (0: not subtracted) |
| Currency | USD | Shown next to every amount |
| Monthly summary to | none | Who gets the summary by email on the first day of each month, for the month before. Nobody: it is not sent |

Changing any of them updates every figure at once, including past periods. People with the **AI Triage & Remediation rules** permission can change them.

## Where the readings come from

The server keeps a small record of each finding: when it was first seen open, and when it was judged not exploitable or stopped being reported by Checkmarx One. The file is `finding-journal.json` in the state folder, and it is included in backups.

It is filled from reads the server makes anyway, never by extra calls to Checkmarx One:

- every **Dashboard** fetch with no date window;
- every tracked report's refresh (hourly, and soon after anyone triages or remediates);
- **Allocate and use credits** on Credit Control.

A finding is marked as no longer reported only when a read covers every finding of its project. A date window, or a project that could not be read, never marks anything gone.

**Readings start when you install this version.** The page says so when the chosen period begins earlier. Closed findings are kept for two years.

## The monthly email

Add addresses under **Monthly summary to** and the summary of the month before is emailed on the first day of each month (UTC). It is sent once, through the mail server in **Settings → Email**. Email clients drop charts, so the email has the figures, the time-to-fix table and the projects, and links to the Impact page for the chart.

**Email last month's summary now**, on the Detail tab, sends it straight away, for example to check how it looks. Each summary sent, or refused by the mail server, is in the audit log.
