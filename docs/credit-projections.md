# Credit projections

**Credit projections** (bottom of the sidebar, just above **Get help**) works out the Checkmarx One credits a customer would need, from their own data. It is built for showing a customer, live:

- **À la carte:** what it costs in credits to triage and remediate their backlog, from two exports they upload, and how fast the backlog clears.
- **Fusion:** what one Fusion scan of each of their projects costs, from the lines of code each project's last scan counted.

Each customer gets a **profile**. Everything in it is saved on this server as you go, so you can close the page, come back later, open the profile again and carry on.

## Who can use it

It takes the **Credit projections** permission (`projections.use`, in the *AI & credits* group on People & roles).
- **Admins** have it.
- **Security Analysts** have it on a new installation. On an installation that existed before MZ-01.00.61, an Admin ticks it for the role, or for any other role, under **People & roles**.

Everyone with the permission in a tenant sees the same profiles. With several tenants, each tenant has its own.

On a phone the sidebar's lower buttons are hidden: open the page with **Jump to** (Ctrl K) → *Credit projections*.

## Profiles

- **New profile** starts one. Type the customer's name over *Projection 1*.
- Click a profile in the list to open it. The list shows the customer's name, whether the à la carte projection has both exports, how many projects the Fusion projection has, and when it was last changed. The one changed last is at the top.
- Every change saves itself about a second later. The line by the name says **Saving…**, then **Saved** and the time. If a save is refused, it says why there, and nothing that was saved before is lost.
- **Delete profile** removes it, with its exports and projects, after you confirm.
- The profile you had open opens again next time, in this browser.

Limits: 200 profiles per tenant, and 3 MB per profile. That is room for years of weekly figures and a logo. A bigger logo is the usual reason a save is refused.

Profiles are in `projections.json` in the data folder (per tenant), and in every backup.

## À la carte: triage and remediation of the backlog

This tab holds the **Checkmarx Backlog Cost Calculator**, which stays in English in every language. It needs two exports from the customer's Checkmarx One, as `.xlsx` (or `.csv`):

| Export | What it holds |
| --- | --- |
| **Total vulnerabilities by severity** | The open backlog at the end of each week |
| **Fixed vulnerabilities by severity** | What was closed during each week |

Drop both on the page together, or one at a time. **Load sample data** fills it in with two sample exports, for a quick demonstration.

Then:
1. **Customer and data.** The customer's name, who prepared it, and their logo if you have one (PNG, JPEG or SVG).
2. **What is happening.** How many findings arrive each week against how many are fixed. The arrival rate is worked out from the two exports.
3. **The plan.** Per severity, how many findings to put through triage and how many are expected to be false positives. Presets: everything, nothing, Critical + High.
4. **The credits.** 1 credit per triage and 3 per remediation (both can be changed). A false positive costs only its triage credit.
5. **The way to zero.** The backlog projected forward against doing nothing, and when it reaches zero.

**Export customer report** downloads one interactive HTML file to give the customer. In it, they can change *what* gets fixed, but not *what it costs*.

Everything you enter and upload is saved with the profile: the customer, the logo, both exports' weekly figures, the plan, the rates, the time window and the pace. Opening the profile puts it all back.

## Fusion: one scan of each project

Fusion is bought in **bundles of lines of code**. Each project is rounded up to whole bundles **on its own**, and the bundles are then added up:

| Project | Lines of code | Bundles (10,000 lines each) |
| --- | --- | --- |
| A | 12,000 | 2 |
| B | 18,000 | 2 |
| **Total** | **30,000** | **4**, not 3 |

The 30,000 lines would make 3 bundles if they could be added up first. They cannot, so it is 4. The page shows that difference above the table, so the customer sees where it comes from.

**The terms, per profile:**
- **Lines of code per bundle:** 10,000 unless you change it.
- **Credits per bundle, per scan:** 1 unless you change it.

The projection is for **one scan** of every project counted.

**Read lines of code from Checkmarx One** lists every project in the tenant this server is connected to. For each, it reads the lines of code its last completed scan counted:
- from the scan's SAST scan metadata;
- if that has no count, from the scan's own SAST details;
- if neither has one, the project is listed with an empty field to type the number in. The totals say how many included projects still have no count.

Reading again updates the counts. Every number you typed over a count, and every project you left out, is kept. Projects that are no longer in Checkmarx One are taken off, and you are told how many.

**In the table:**
- **Include** leaves a project in or out. **Include all** and **Include none** act on the projects shown, so you can find a group of projects and include just those.
- **Lines of code:** type over the count to use another number. The count the scan gave stays underneath, with **Use it** to go back to it.
- **Add a project by hand:** for a prospect, or a project not scanned yet. Name it and type its lines of code. **Remove** takes it off again.
- **Bundles** and **Credits per scan** per project, and the totals above: projects counted, lines of code, bundles, and credits per scan.
- **Download CSV:** every project with its lines of code (the scan's count and the one used), where the count came from, bundles and credits, then the totals and the terms.

Without a Checkmarx One connection (Settings → Checkmarx One), reading says so; you can still add every project by hand.

## Security and privacy

- Nothing is sent anywhere but this server. The calculator runs in the browser and reads the exports there. The lines of code come from your own Checkmarx One, through the connection this server already has.
- The calculator is a page of this server shown inside the Credit projections page. It is the only page that may be shown inside another, and only inside this server's own pages (`frame-ancestors 'self'`). The calculator and the page around it accept messages only from each other, on this server.
- The server keeps only what a projection needs: numbers, dates, names, and a logo only as a PNG, JPEG or SVG image. It drops anything else that is sent to it.
- Creating, opening, changing and deleting a profile all need the **Credit projections** permission, checked by the server on every request.
