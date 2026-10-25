# CxMissionZero user guide

Everything you can do in CxMissionZero, page by page, with every option explained.

**Who needs which part**
- Developers who only receive emails need [The emailed report](#the-emailed-report).
- Administrators setting it up start with [Set up in 10 minutes](#set-up-in-10-minutes), and serve it over HTTPS: [Turn on HTTPS](#turn-on-https).

**Contents**
1. [Find your way: Act, Follow up, Prove, Set up](#find-your-way)
1. [Who can do what](#who-can-do-what)
2. [Sign in](#sign-in), and the [terms of use](#terms-of-use)
3. [Set up in 10 minutes](#set-up-in-10-minutes) (Admin)
4. [Turn on HTTPS](#turn-on-https) (Admin)
5. [Settings, option by option](#settings-option-by-option)
6. [Workbench: fetch, credits, remind](#workbench)
7. [The emailed report](#the-emailed-report) (for developers)
8. [Dashboard: tracked reports](#dashboard-tracked-reports)
9. [Credit Control](#credit-control)
10. [Impact: hours saved and the security debt](#impact)
11. [Audit page: credit audit log and backups](#audit-page)
12. [People & roles](#people--roles)
13. [Labs: Code authors](#labs-code-authors)
14. [Labs: Fusion results](#labs-fusion-results)
15. [Labs: FAE Flush](#labs-fae-flush)
16. [Labs: Status board](#labs-status-board)
17. [Labs: Consolidated view](#labs-consolidated-view)
18. [Labs: Govern](#labs-govern)
19. [Logs page](#logs-page)
20. [Performance and security status](#performance-and-security-status)
21. [Everyday recipes](#everyday-recipes)
22. [Troubleshooting](#troubleshooting)

The running version is shown at the bottom of the sidebar, as `MZ-xx.xx.xx`. Click it for Settings → About.

---

## Find your way

The sidebar is grouped by what you came to do:

| Group | Pages | What you do there |
| --- | --- | --- |
| **Act** | Workbench, Automation | Load ageing findings, see who owns them, remind them, triage and remediate; set reminders to go out by themselves, preview them and brand their email. |
| **Follow up** | Dashboard | Follow tracked scopes down to zero and schedule follow-ups. |
| **Prove** | Credit Control, Impact, Audit | Give and track AI Triage and Remediation credits; the hours AI saved and how fast the security debt shrinks; the credit audit log and backups. |
| **Plan** | Cx Credits Calculator | The credits a customer needs for triage and remediation of their backlog and for Fusion scans, and projection reports, from the Checkmarx One tenant. Shown to Admins and the roles an Admin gives its permission to. |
| **Set up** | People & roles, Settings, Logs | People and roles, configuration, troubleshooting. |
| **Labs** | Code authors, Fusion results, FAE Flush, Status board, Consolidated, Govern | Early features, set apart at the bottom of the menu, each its own page: who wrote the vulnerable code, and their email; what Checkmarx One's AI engine found in SAST (Fusion and LAST) in the projects you load; Findings Analysis (FAE) on the whole tenant's backlog at once; budgets of AI credits per person, group, project or application (Govern). Shown to roles holding **Beta features**; Govern to the roles holding its own permissions. |

The coloured label next to each page title says which group the page is in.

**Every page keeps what you were doing.** Go to another page and come back: your filters, tabs, selections, open rows, typed text and unsaved role changes are still there, and so is the scroll position.
- **↻** (top right) reloads the data of the page you are on and keeps your filters and tabs.
- **Refresh** (bottom of the sidebar; under **More** on a phone) starts over: CxMissionZero reloads and every page opens as new. Saved settings, reports and credits are not affected.

**Get help** (bottom of the sidebar; under **More** on a phone): point at it and choose **Submit a support case** or **Request an enhancement**, or **Track my requests**. See [Get help](#get-help-support-cases-and-enhancements).

**Sort and filter any table from its headings.** Next to each column heading of a data table (projects, people, the audit and activity logs, reports, credits, the downloaded HTML report…) there are two small buttons:
- **⇅ Sort by this column**: the first click sorts numbers largest first and words A to Z, the second reverses it, the third goes back to the table's own order. Empty cells stay at the bottom either way.
- **Funnel: Filter this column**: type in **Contains…**, or tick the values to keep (columns with up to 15 different values). In a column of numbers, `>10`, `<=5` or `=0` compare. **Clear** removes the column's filter, **Done** closes it.
- A line above a filtered table says **Showing 12 of 40 rows**, with **Clear filters**. Tables that show everything at once filter every row; the People list, Projects and the credit audit log sort and filter every row loaded, not only the page in view; a table the server sends a page at a time (Logs → User activity) says **on this page**.
- Findings that share one Checkmarx One result stay together whatever the sort, and the sort and filters are kept when you switch pages.
- **Every table fits its panel.** Headings wrap (the sort and filter buttons go under a long label) and long text wraps inside its column, so no column runs off the right; the audit log shows each entry's reason on up to two lines (**Details** has it all).
- **On a phone** each table row is shown as a small card, its column headings beside the values, and the Workbench's projects are a list you tap (see [On a phone](#on-a-phone)); between 761 and 1024 pixels wide the Workbench's projects are cards. Cards and lists have no headings to sort by: narrow them with the search and filter pills above them.

**Jump to (Ctrl K, or ⌘K on a Mac)** goes to any page, tab, Settings section or common action: type a few letters (for example *smtp*, *allocated*, *backups*) and press Enter.

**Tabs instead of long pages.** Most pages have tabs at the top (for example Audit: *Credit audit log*, *Integrity & reconcile*, *State & backups*). The tab you last used opens next time. The address bar follows the tab, so `#/audit/backups` or `#/settings/smtp` opens that place directly.

**Any screen.** The layout adapts to the screen: a full sidebar on a desktop, an icon rail on a tablet, a bottom bar on a phone, and wide screens use their full width. Tables stay inside their panels: long emails go onto two lines after their @, and below 1024 pixels wide (tablets and phones) the Workbench's projects are shown as one card each, so no column is cut off at the right. The header is one line: the page's name and what it is for.

### On a phone

Up to 760 pixels wide CxMissionZero works like a phone app, in every look and in light and dark:
- **The tab bar** at the bottom holds four pages (your pinned pages first, then the menu's order) and **More**. **More** opens a sheet with you at the top, every page you may open as a grouped list (Act, Follow up, Prove, Plan, Set up, Labs), and then the tenant, the connections, the language, the theme, **Get help** and **Refresh**.
- **The page's name** is large at the top and settles into a slim bar as you scroll; search and your name stay at the right.
- **The Workbench** opens with its summary: Get started folded into one line (tap it for the steps), Mission Zero, then the totals as cards you swipe. **What to load** is one row: it says the time window and engines, and **Load** loads findings straight away (**Stop** while loading). Tap the row to change the window, engines, branch or **Narrow down** in a sheet; **Load findings** there loads and closes it.
- **Projects are a list**: each row shows the project, its languages, a bar of its open findings by severity, how many and how old. Tap a row for the project's own screen: its findings by severity, every column you chose under Columns, its AI credits (tap them to give extra credits) and **Remind**, **People**, **AI credits** and **Track** for that project alone (it becomes the only ticked project). **‹ Projects** or your phone's back gesture returns to the list.
- **Select** (beside Projects) shows tick boxes to choose several projects; the actions bar floating above the tab bar then acts on them, as **Remind**, **People**, **AI credits** and **Track** do on a computer.
- Side panels (Fusion, Status board, a report's details, the Workbench's actions) rise from the bottom as sheets.

<a id="your-appearance"></a>**Your appearance: your own look, light or dark.** Settings → **Your appearance** (under **You**, next to Your profile and Your branding) holds how the app looks to you. The sun or moon button in the top bar stays for a quick switch of the theme:
- **Look**: **The organisation's** (whatever the Admin chose; out of the box **Command center**: warm paper or night ink, a dark menu console, headings and figures in Fraunces), or one of your own, each shown as a small picture: **Cabin** (a luxury car's cockpit at night, with a line of ambient light), **Circuit** (a sports car's gauges, with a needle on the Dashboard), **Residence** (a grand hotel: ivory, navy and gold), **Chronometer** (a fine watch: green and gold, a fluted bezel), **Signal**, **Studio**, **Atelier** or **Classic** (the look before MZ-01.00.77, unchanged). In every look but Classic, buttons stand off the page; the golden buttons stay gold.
- **Theme**: **Auto** (your device's setting), **Light** or **Dark**. The sun or moon button in the top bar switches the same thing.
- **Accent**: the colour for what you act on: Ink, Lagoon, Sage, Plum or Ochre (in Cabin, the colour of its ambient light; in Circuit and Signal, the signal colour).
- **Fusion and LAST colours**: the colour of projects whose latest scan was a Fusion scan (gold by default) and a LAST scan (pink by default), on the Workbench, Labs → Fusion results and its reports. Each look has its own shades, for light and dark; pick one of five, **Custom…** for any colour, or **Use the look's colours**. A preview shows them in your look. If the two are too close to tell apart, or close to the critical or high severity colour, it says so; the Fusion and LAST tags stay on every row either way.
- **Explanations**: **Behind ?** (the default: each explanation folds behind a small **?** next to its heading, field or option; click the **?** to read it) or **Shown** (every explanation shown, as before). Warnings, statuses and figures are never folded. Kept in this browser.

Your look is saved to your profile, so it is the same on every computer, and the reports you download use it (see [The emailed report](#the-emailed-report)). The organisation's look is the Admin's, under [Branding](#branding), with whether people may choose their own and where the menu sits. If an Admin has turned the choice off, everyone has the organisation's look and Your appearance offers the theme, accent and explanations only; your own choice is kept for when it is turned on again.

**Fold the menu.** Click a group's name (**Act**, **Follow up**, **Prove**, **Plan**, **Set up**, **Labs**) to fold its pages away, and again to unfold them; the button at the top of the menu folds or unfolds every group at once. The page you are on always stays in view. Remembered in this browser.

**Pin your pages, and Focus.** Point at a page in the menu and click its pin: it stays at the top under **Pinned**. **Focus** (top of the menu) shows only your pinned pages and the page you are on; click it again for every page. Remembered in this browser; on a tablet's icon rail, a phone, or with the menu along the top, every page is shown as before.

**Hide the menu.** **Hide menu** (bottom of the sidebar) turns the sidebar into a slim bar of icons, so the pages get the width. Point at the bar and the full menu opens **over** the page, without moving anything on it; it closes when the pointer leaves or you choose a page. **Keep menu open** (the same place) brings it back beside the page. Your choice is remembered in this browser.

---

**Your language.** The globe at the top right switches the page to any of these languages:
- 日本語 (Japanese);
- 繁體中文 (Traditional Chinese, Taiwan);
- 简体中文 (Simplified Chinese);
- 한국어 (Korean);
- Español (Spanish);
- Português (Brasil) (Brazilian Portuguese);
- Deutsch (German);
- Français (French);
- العربية (Arabic);
- Tiếng Việt (Vietnamese);
- ไทย (Thai);
- Bahasa Melayu (Malay);
- Bahasa Indonesia (Indonesian);
- English;
- עברית (Hebrew), for the people an Admin chose after switching it on with an activation code (Settings → Activation codes).

In Arabic and Hebrew the page reads right to left, with the menu on the right.

The first time, CxMissionZero uses your browser's language when it is one of these (never Hebrew: choose it yourself). Your choice is saved with your account, so it follows you to any browser you sign in from.

What is translated, and what is not:
- **Translated:** menus, options, buttons, headings, hints and status messages.
- **Not translated:**
  - names of projects, people and findings, which are shown as they are in Checkmarx One;
  - logs and code;
  - the terms of use, whose English text is the binding version.
- While something runs, the status line says plainly what is happening in every language other than English.
- The interactive report is in your language too (see [The emailed report](#the-emailed-report)); reminder emails stay in English.

<a id="your-profile"></a>**Your profile.** Open your name at the top right, then **Your profile** (also Settings → Your profile). Every person has one, whatever their role:
- **Picture:** PNG, JPEG or WebP. It is cut to a square and made small in your browser before it is saved.
- **Email, role and last sign-in:** shown for reference. An administrator manages these under People & roles.
- **Name:** how you appear in this app.
- **Language:** the same choice as the globe.
- **Time zone:** picked up from your computer by default. Untick **Use this computer's time zone** to choose another. Dates and times on every page are shown in it.
- **Programming languages:** the languages you work in.
- **Currency:** any country's currency, for money on the Impact page and in the summary you download. Choose it, then give the exchange rate from the organisation's currency, for example **1 USD = 83.2 INR**. Until you give a rate, amounts stay in the organisation's currency. Only you see your choice.

Changes save as you make them and are recorded in the audit log. A time zone or first language picked up from your computer is saved without an audit entry.

<a id="your-branding"></a>**Your branding** (Settings → Your branding, for roles with **Their own branding**). Your own names, logo and colours, for demonstrations:
- Fill in the app name, company name, logo, logo height, accent colour and call to action: typing in any of them turns on **Use my branding**, and the header shows your app name and logo at once. An empty field keeps the organisation's, shown in grey. Turn **Use my branding** off to go back to the organisation's; what you typed is kept.
- While it is on, this app shows you your app name and logo, and the reports you download and the reminders you send carry your branding.
- Everyone else, and every scheduled run, keeps the organisation's branding.
- Turn it off to go back. **Clear my branding** empties it. Details: [branding](branding.md).

**Simple by default.** Fine-tuning most people never need is hidden: the reminder format and attachment, extra credits, custom link and mail templates, the risks endpoint, mail-server certificate checks, HTTPS hardening and similar. To see it, open your name (top right) and turn on **Show advanced options**. The choice is kept in your browser.

## Who can do what

Everyone signs in and has one role. Tabs and buttons you are not allowed to use are hidden, and the server refuses them anyway.

| Role | Can |
| --- | --- |
| **Admin** | Everything, including the Checkmarx One integration, the email server, the credit pool and backups. |
| **Security Analyst** | Everything else: fetch, remind, allocate credits, triage and remediate, tracked reports, audit, people and roles, beta; in Govern, see everything and ask for credits. |
| **Security Champion** | Govern (once its activation code is applied): budgets, Enforce, credit requests, restores and attribution, but not Govern's settings; also fetch findings and see tracked reports and credits. No people and roles. |
| **User** | Fetch findings, send reminders, follow tracked reports, see credits. Settings are read-only. No Access or Audit. In Labs, once their codes are applied, the Status board and Govern (their own AI credits, and asking for more). |

**Cx Credits Calculator** is for Admins; give it to any other role by ticking **Cx Credits Calculator** on People & roles.

**Deleting reports** (tracked reports, and the calculator's projection reports) is for the Admin role only: the **Delete reports** permission cannot be given to another role. Everything else on tracked reports (saving, scheduling, follow-ups, rescans) every role can do.

**Hebrew**, once its activation code is applied, is for the roles with the **Hebrew** permission: Admins always; tick it for any other role on People & roles.

Every role can raise support cases and enhancement requests under **Get help**. Admins answer them (**Answer support cases & enhancements**); on a new installation Security Analysts can too.

Admins and Analysts can change what Security Analyst and User may do, or create new roles, on the [People & roles page](#people--roles).

**Each person sees their own level and below.** On People & roles, a Security Analyst sees Security Analysts and Users, not who the Admins are. To move someone down, change their role to Security Analyst.

**Branding for demonstrations.** Admins and, on new installations, Security Analysts can set [their own branding](#your-branding) for when they present CxMissionZero. Who may see the Branding page and the Activation codes page is a permission too ([branding](branding.md)).

---

## Sign in

**Email and password.** Use the address and password you were given. The first time, you must choose your own password: at least 12 characters.

**Checkmarx One API key** (optional). Paste your own key on the sign-in screen.
- It works only if an administrator listed your Checkmarx One identity (your email, username or client id) against your account on the People & roles page.
- The key must be for the same tenant as the server.
- Checkmarx One then sees your actions as yours.

**The first administrator.** On its very first start the server creates an administrator and prints the email and password in its log:

```
podman logs mission-zero
```

The password is also kept in `/data/first-admin-password.txt` until it is changed.
- If the log shows no password, the volume already holds people from an earlier install. The log then names an administrator and the command below.
- To set a new temporary password, run this. It prints the email and the password to sign in with:

```
podman exec mission-zero node scripts/reset-admin.mjs
```

  With Docker: `docker exec mission-zero node scripts/reset-admin.mjs`. Add an email (`… reset-admin.mjs ana@acme.io`) to reset that person. The server keeps running.
- To start from scratch, remove the volume (`podman volume rm mission-zero-data`). This deletes every setting and the audit log.

**Forgot your password?** The link under **Sign in** (shown once an Admin has set up the email server and the server's https address).
1. Enter the email address you sign in with and press **Send the link**. The answer is the same whether or not the address has an account.
2. If it does, and your account may reset its password by email, a link arrives at that address. It works once, for 30 minutes, and only the latest one works.
3. Open it, choose a new password (12+ characters, not your current one) and press **Save password**. Every place you were signed in is signed out, and an email confirms the change.
4. Sign in with the new password.

Nothing arrived? Check spam, or ask an Admin: at most 3 links an hour are sent to one person, and an Admin may have kept Admins, or everyone, out of resetting by email (People & roles → **Sign-in**).

**Locked out?** Five wrong passwords lock an account for 15 minutes. Resetting your password by email unlocks it. An Admin or Analyst can also set a new temporary password for you on the People & roles page (**Set password**).

**Connections, top right.** One look shows whether CxMissionZero can reach what it needs:

| Indicator | Green when | Red until |
| --- | --- | --- |
| **Checkmarx One** | The server's integration is connected. | An Admin connects it (Settings, `CX_API_KEY`, or the .env upload). |
| **Email** | The mail server passed its test with the current settings. | It is set and tested (Settings → Email server → Test connection, or the .env upload, which tests it). |
| **Git** | Every git connection answers: one small logo per connection (GitHub, GitLab, Azure DevOps, Bitbucket), each ringed green when its token works and red when it does not. Two GitHub connections show two GitHub logos (the second marked 2). Amber when some work and some do not. Checked every 5 minutes, and whenever a token changes. | A token is set: `GITHUB_TOKEN`, `GITLAB_TOKEN`, `AZURE_DEVOPS_TOKEN` or `BITBUCKET_TOKEN` (in the .env file, or on the Beta page). |

Click one for its details: tenant and URLs, mail server and sender, and what to do when it is red. **Git** lists every connection with its host, the account its token belongs to and where the token comes from, then the hosts not connected yet and the variable that connects each. They update as soon as settings are saved or a .env file is uploaded.

**More than one connection to the same host.** A second GitHub (an Enterprise server next to github.com, or another organisation's token), GitLab, Azure DevOps organisation or Bitbucket: the same variables numbered `_2` to `_9`, in the .env file or uploaded under Settings, for example `GITHUB_TOKEN_2` with `GITHUB_API_URL_2` and `GITHUB_ORG_2`. Each repository is read with the connection for its host; when two share a host (two github.com tokens), with the one whose organisation, group or workspace owns the repository. Usernames are matched with the first connection of each host.

**Progress flares, bottom right.** Whatever you start shows a flare while it runs:
- **Amber, with something fast racing along:** in progress. Each action gets one of 21 icons (a rocket, a cheetah, a bullet train, a falcon…), a different one each time. The top line says what it is doing (*Checking with Checkmarx One (two independent reads)…*); the line under it is live: the step it is on, how many projects, and the time so far (*Matching each finding to its result · 12 projects · 0:04*). The button and the part of the page it came from are paused, so nothing is started twice.
- **Green:** done. The icon glides to a stop and a tick mark draws itself in.
- **Red:** it did not finish, and says why.

Several actions can run at once, each with its own flare. With *reduce motion* turned on in your system settings, the tick shows straight away and nothing moves.

**Sign out** is under your name, top right. Idle sessions end after 8 hours (`SESSION_IDLE_MINUTES`).

**Staying signed in.** Reloading the page, an update of CxMissionZero, or a server restart never signs you out, or loses the data you fetched and the scope you chose. Only signing out, 8 idle hours, or an administrator changing your access does.
- If you signed in with your own Checkmarx One API key, you sign in again after a restart: that key is never written to disk.

---

## Terms of use

CxMissionZero is an independent project, not a Checkmarx product. Using it means accepting its [terms of use](../TERMS.md):
- **As is.** No warranty, and no promise of support or bug fixes.
- **No responsibility.** Neither its author nor Checkmarx is responsible for how it is used, or for any credit discrepancy.
- **Supporting information only.** Its credit figures, audit log and reports help your own calculation. They are never evidence in a claim or dispute with Checkmarx, whose records are authoritative.

**When they are asked for**
- **The first Admin**, right after choosing a password at the first sign-in. The terms show in full: scroll to the end, give **Your organisation’s name** (it goes on the Cx Credits Calculator's reports; change it later under **Settings → About & terms**), tick **I have read these terms and accept them for myself and on behalf of my organisation**, then **Accept and continue**. Until then nothing can be used, by anyone:
  - the Workbench and Settings;
  - emailed reports (they say the server is not in use yet);
  - automatic reminders.
- **Everyone else**, once, at their first sign-in. Before an Admin has accepted, they see **An administrator must accept these terms…**, with **Check again**.
- **Declining** signs you out.
- **When the terms change,** everyone is asked again.
- **On record.** Each acceptance (who, when, from which address, which version) is in the **Audit log**.

**Read them any time:** **Settings → About & terms of use** (or click the version at the bottom of the sidebar); or the link on the sign-in page.

**Automated setups:** `ACCEPT_TERMS=you@company.com` in the container options accepts the terms for the organisation and everyone, under your name (in the log and the audit log). Anything but an email address stops the start. `ORGANISATION_NAME=Acme Partners` gives the organisation's name the same way.

**Licence.** [PolyForm Internal Use 1.0.0](../LICENSE): use and adapt it inside your own organisation; do not sell it, distribute it, or run it as a service for others. Improvements are welcome: [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## Set up in 10 minutes

As an Admin, open **Settings** and work down this list.

| Step | Where | What to do |
| --- | --- | --- |
| 1 | Quick setup from a .env file | **Download the sample .env**, fill in your Checkmarx One key and mail server, and upload it. This does steps 2–4 in one go. |
| 2 | Checkmarx One integration | Paste the API key, then **Connect & store**. |
| 3 | Email server (SMTP) | Host, port, user and password. Then **Test connection** and **Send test email**. |
| 4 | Reminder server address | The `https://` address people use to reach this server. Then **Test**. Serve it over HTTPS first: [Turn on HTTPS](#turn-on-https). |
| 5 | AI Triage & Remediation from reports | Decide what developers may run from their reports, and set the credit pool. |
| 6 | Branding | Company name, logo and colour for emails and reports. |
| 7 | Automation (optional) | **Act → Automation**: set the age limits, preview who would get what, then turn it on. Start with **Test mode**. |
| 8 | Hands-off (optional) | Or answer four questions under **Settings → Hands-off**: MissionZero then reminds, reports weekly and looks after itself, and nobody needs to sign in. |

Then go to the **Workbench**, click **Load findings**, and send your first reminder.

Settings **save as you type**; there is no Save button.
- A changed Checkmarx One or mail connection is checked straight away.
- If it does not work, the **last known good** settings come back when you leave the page, so nothing stops working. Every administrator is told what was rolled back.
- When something does not connect, a **How to fix it** box says what is wrong and the steps that fix it ([When a connection does not work](troubleshooting.md)).

---

## Turn on HTTPS

Do this before anyone else signs in or receives a report. Over HTTPS, sign-ins, findings and triage requests cross the network encrypted. Plain http sends them as readable text to anyone on the way.

### From the Settings page (recommended)

Admins only: **Settings → HTTPS**. It moves the running server from http to HTTPS in five steps, with no new command, no restart, and nobody cut off. The badge top right shows where it stands: **HTTP only**, **HTTP + HTTPS side by side**, or **HTTPS only**.

1. **Certificate.**
   - **Free from Let's Encrypt (easiest, no IT needed).** Under **Free certificate from Let's Encrypt**: the server name is filled in; add an email for expiry notices if you like, tick **I agree to the Let's Encrypt Subscriber Agreement**, and click **Get a free certificate**. In under a minute it is in use, trusted by every browser, and HTTPS is on next to http. It renews by itself 30 days before it expires (**Renew now** and **Stop automatic renewal** are there too). It needs a DNS name pointing at this server and port 80 open to the internet; the server checks that first, so a wrong DNS entry is reported before Let's Encrypt is asked. Deploying fresh? `-e LETSENCRYPT_DOMAIN=mz.company.com` on the container does all of this, HTTPS only included, with no clicks: [HTTPS and hosting](https-and-hosting.md#b-free-certificate-from-lets-encrypt-public-name).
   - **Get one from IT.** No certificate yet? Open **No certificate yet? Create a request (CSR) for IT**, enter the name people use (e.g. `mz.company.com`), and click **Create the request**. A `cxmissionzero.csr` file downloads: send it to IT. The private key is made and kept on the server, so IT only sends a certificate back.
   - **Upload it.** Click **Choose certificate files**, or drop them on the box. Give everything IT sent, in any order and with any names: the certificate (`.crt`, `.cer` or `.pem`), the chain or bundle, and the key (`.key`). Or give one `.pfx` / `.p12`, then its password when asked.
   - **Read the check.** Nothing changes yet. Each line is a tick (fine), **!** (works, but some people may see a warning) or **✕** (cannot be used, and why):
     - the key belongs to the certificate;
     - the dates;
     - the names it covers, compared with the address you are using and the Reminder server address;
     - who issued it: a public authority, your company's, or self-signed. Missing intermediate certificates are spotted here;
     - the key's strength and purpose.
   - **Use it.** Click **Use this certificate**. It goes into use at once; the one it replaces is kept.
2. **Turn on HTTPS next to http.** The same address and port now answer both `http://` and `https://`. Everyone on http carries on as before. If no certificate was uploaded yet, a self-signed one is used until you upload yours.
3. **Test it.**
   - **Open the HTTPS address**: no warning should appear, and the padlock shows.
   - **Check this browser accepts it**: connects in the background and says yes or no.
   - **Reports.** Emailed reports opened from now on try HTTPS and keep to it on machines where it works. The page shows how many reports were opened over each in the last 24 hours: when http keeps falling, it is time for step 4.
4. **Switch to HTTPS only.**
   - **Do it from the HTTPS address.** The button works only on a page opened over HTTPS: that proves HTTPS works from your browser before http goes away.
   - **New reports.** Keep **Also put the https address into new reports** ticked, so new reports carry the https address.
   - **Afterwards:**
     - plain `http://` redirects to `https://`;
     - the Workbench, if open over http, moves itself to HTTPS;
     - reports that still use the old http address are told the new one, and switch by themselves (reports emailed before this version show the new address to enter under **Change**).
   - **Undo.** **Back to http and HTTPS side by side** puts http back at any time.
5. **Harden.**
   - **HSTS** makes browsers that visited once use only HTTPS here. Start with **1 day**, then lengthen it to a week, six months, a year. It needs a certificate from IT or a public authority (not self-signed). While it is on, the server cannot go back to plain http (turn it off first, and wait that long).
   - **Lowest TLS version:** 1.2 works with every browser; 1.3 only with current ones.
   - **Always on over HTTPS:** `Secure`, `HttpOnly` and `SameSite` session cookies, a strict Content Security Policy, and no framing.

**Replacing a certificate.** A renewal, or a different certificate: upload it in step 1 (**Choose files to replace it**). It is checked first, then goes into use at once, with no restart; open connections carry on.
- **Undo:** **Put the previous certificate back** returns the one before, in one click.
- **Expiry warning:** 30 days before expiry, step 1 and the status tiles warn.
- **With HTTPS only on,** a replacement with warnings asks you to confirm.

**Standard ports (443, and 80 for http).** Both protocols share one port inside the container. To use the standard ports, publish both to it, once. `http://` on port 80 then redirects to `https://` on 443. The page shows the command, e.g.:

```
podman run --replace -d --name mission-zero -p 443:3000 -p 80:3000 -v mission-zero-data:/data -e TZ=Asia/Dubai --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

**Locked out?** For example, nobody's browser accepts the certificate, or HSTS was turned on with a bad certificate. On the server, run:

```
podman exec mission-zero node scripts/https.mjs both
```

Within 5 seconds http works again next to HTTPS, HSTS is off, and no restart is needed. Then fix the certificate on the page. Every change, from the page or this command, is in the **Audit log**.

### From the container options

The image starts with `HTTPS=on`: HTTPS only, self-signed until a certificate is given. `HTTPS=off` starts with plain http, `HTTPS=both` with both side by side. These only set the starting point: once an Admin changes it on the Settings page, the page's choice is kept across restarts and updates.

**Plain http on your own machine:** add `-e HTTPS=off` and open `http://localhost:3000`:

```
podman run --replace -d --name mission-zero -p 3000:3000 -v mission-zero-data:/data -e TZ=Asia/Dubai -e HTTPS=off --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

You need access to the machine that runs the container (Podman or Docker). The commands are for Windows cmd, one line each. In every command, replace `mz.company.com` with your server's name.

#### 1. Choose how

| Way | Use it when | You need |
| --- | --- | --- |
| **A. Your company's certificate** | CxMissionZero runs inside the company network or VPN. This is the usual case, and the safest. | A certificate for its name from IT, and a DNS name pointing at the machine |
| **B. Automatic certificate** (Let's Encrypt) | It has a public name the internet can reach | A public DNS name pointing at the machine, with ports 80 and 443 open to it |
| **C. Self-signed** (the default) | Trying it out, or a lab | Nothing. Browsers warn about it until you trust it |

#### 2A. With your company's certificate

1. **Ask IT for a server certificate** for the name people will use, e.g. `mz.company.com`.
   - The name must be in the certificate's *Subject Alternative Name*.
   - Ask for the **full chain**: your certificate and the intermediate certificates in one file.
   - You get either two files, `server.crt` and `server.key`, or one `.pfx` file and its password.
2. **Put the files in a folder** on the machine, e.g. `C:\mission-zero\certs`.
3. **Start CxMissionZero with them.** This replaces the running container; no data is lost.

```
podman run --replace -d --name mission-zero -p 443:3000 -p 80:8080 -v mission-zero-data:/data -v C:\mission-zero\certs:/certs:ro -e TZ=Asia/Dubai -e TLS_CERT_FILE=/certs/server.crt -e TLS_KEY_FILE=/certs/server.key -e HTTP_REDIRECT_PORT=8080 -e REPORT_SERVER_URL=https://mz.company.com --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

   - **With a `.pfx`:** replace `-e TLS_CERT_FILE=/certs/server.crt -e TLS_KEY_FILE=/certs/server.key` with `-e TLS_PFX_FILE=/certs/server.pfx -e TLS_PFX_PASSPHRASE=yourpassword`. To keep the password off the command line, put that line in your settings file and use `--env-file`.
   - **`-p 80:8080` and `HTTP_REDIRECT_PORT=8080`** send anyone who types `http://` to `https://`. Leave both out if you don't want port 80.
4. **Check it** (see [Check it worked](#3-check-it-worked)).

**When the certificate is renewed,** copy the new files over the old ones in the folder. CxMissionZero switches to them within 5 minutes, with no restart. If a new file is broken, it keeps serving the old certificate and says why in its log.

#### 2B. With an automatic certificate (public name)

Caddy, a small web server, gets a free certificate from Let's Encrypt, renews it by itself, and passes requests on to CxMissionZero over plain http on their private network. That is why CxMissionZero runs with `-e HTTPS=off` here. CxMissionZero itself then has no open port. `-e TRUST_PROXY=uniquelocal` lets it believe what Caddy says about each visitor (their address, and that they used HTTPS); that is safe here because only Caddy can reach it.

```
podman network create mz-net
```

```
podman run --replace -d --name mission-zero --network mz-net -v mission-zero-data:/data -e TZ=Asia/Dubai -e HTTPS=off -e TRUST_PROXY=uniquelocal -e REPORT_SERVER_URL=https://mz.company.com --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

```
podman run --replace -d --name mz-caddy --network mz-net -p 80:80 -p 443:443 -v caddy-data:/data --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges:true docker.io/library/caddy:2 caddy reverse-proxy --from mz.company.com --to mission-zero:3000
```

Let's Encrypt checks that it really reaches your name on port 80, so the DNS name must point at this machine before you start. `podman logs mz-caddy` shows the certificate being obtained.

#### 2C. Self-signed (to try it out)

```
podman run --replace -d --name mission-zero -p 3443:3000 -v mission-zero-data:/data -e TZ=Asia/Dubai -e TLS_HOSTNAMES=mz.company.com --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

Open <https://localhost:3443>.

**The certificate**
- This is what the image does whenever no certificate is given; `TLS_HOSTNAMES` adds names to it.
- CxMissionZero makes it at the first start and keeps it in the data volume. It covers `localhost`, the machine's name and the names in `TLS_HOSTNAMES`.
- The browser warns once ("Your connection is not private"), because no authority vouches for it. Click **Advanced**, then the link that continues to the site.

**To stop the warning on a Windows machine (Edge and Chrome)**
1. Copy the certificate out of the container:

```
podman cp mission-zero:/data/tls/self-signed.crt C:\mission-zero\self-signed.crt
```

2. Double-click `self-signed.crt`, then **Install Certificate** → **Local Machine**.
3. Choose **Place all certificates in the following store** → **Trusted Root Certification Authorities**.

Firefox keeps its own list: **Settings → Certificates → View Certificates → Authorities → Import**.

For everyday use, switch to way A or B instead: every reader's machine would have to trust a self-signed certificate.

#### 3. Check it worked

1. **The log:** run `podman logs mission-zero`. You should see:
   - `running on https://…`;
   - for A and C, a line `[https] Certificate: CN=mz.company.com, valid until …` with the names it covers.

   If the start fails, the log says why (see [Troubleshooting](#troubleshooting)).
2. **The browser:** open `https://mz.company.com`. It shows the padlock, with no warning.
3. **Settings → Reminder server address:** it should show `https://mz.company.com`. Click **Test**.
   - The address comes from `REPORT_SERVER_URL`. If one was saved on this page before, that one wins: change it here.
   - New emailed reports carry this address.

#### 4. After the switch

- **Everyone signs in once** at the new address. A browser keeps its sign-in per address, and the old `http://` one is no longer used.
- **Reports emailed before the switch** still point at the old address.
  - A reader clicks **Change** next to *Reminder server* at the top of the report, enters `https://mz.company.com`, and the report remembers it.
  - Alternatively, send new reports.
- **Updating** works as before: `podman pull`, then the same command you started with, **including its HTTPS options**. Without a certificate option it still serves HTTPS, with the self-signed certificate.
- **Ports 80 and 443 on Windows:** Podman may refuse them ("permission denied"). Either:
  - run `podman machine stop`, then `podman machine set --rootful`, then `podman machine start`; or
  - use another port, e.g. `-p 8443:3000 -e HTTPS_PUBLIC_PORT=8443`, with the address `https://mz.company.com:8443`.

**Behind a reverse proxy you already have** (nginx, IIS, an F5, a cloud load balancer):
- Let it handle HTTPS and forward to port 3000, with the `X-Forwarded-Proto`, `X-Forwarded-For` and `X-Forwarded-Host` headers. Start CxMissionZero with `-e HTTPS=off`, so the proxy speaks plain http to it.
- Unless the proxy runs on the same machine, add `-e TRUST_PROXY=<its address>`. Otherwise those headers are not believed: by default only a proxy on this machine is.

All the options, and a checklist for hosting CxMissionZero safely: [HTTPS and hosting](https-and-hosting.md).

---

## Settings, option by option

Settings shows one section at a time: pick it from the list on the left (a strip across the top on a tablet or phone). The groups are **You** (your profile, for everyone), **Start**, **Connections**, **Reminders**, **AI & credits**, **Reports & brand**, **Security** and **About**. Sections your role cannot change are shown read-only. Everything saves as you type.

### Update & recovery (Admin)

Install a new version, go back to any version, turn on auto-update, restart the server, or download a troubleshooting report, all without signing in to the server. A click on the version number at the bottom left (`MZ-xx.xx.xx`) opens it; for someone who may not update the server, the same click opens About & terms of use. How it works and what it needs: [Updating](updating.md).

- **Software integrity** says whether the code running is exactly what this repository's release workflow built and signed: **Genuine** (with the commit, the workflow run and the Sigstore log entry), **Files changed** (with the files), **Not signed by the release workflow**, **Not confirmed yet** (GitHub not reachable yet) or **Development copy**. It is checked at start, every 6 hours, with **Check now**, and before any update is installed or switched to; only a version whose files match its signed list is installed ([software integrity](integrity.md)).

- **Running** and **Latest published**, with **Update now** when there is a newer one. **Check for updates** reads the registry again and says how many versions are published and whether one is newer.
- **Versions come from their tags**, so a newer one is always listed. Installing downloads the image files, which ghcr.io serves from `pkg-containers.githubusercontent.com`. If a proxy or firewall blocks that host, the page says so (*the versions are listed, but this server could not read the image files…*): allow it over HTTPS, or update with `podman pull`. A check never reports "up to date" when it could not read the registry; it says why.
- **Auto-update:** off until you tick it. **at** limits it to one hour of the day. A version that failed to start once is never installed by itself again. While this server cannot download image files, it waits and says why instead of trying every 15 minutes.
- **Every version:** the newest 3 first; **Load 10 more** shows older ones, 10 at a time, until all are there (the count says how many of how many). The version running here is always shown. **Install and switch** (any published version) or **Switch to** (an installed one, or the image's own).
  - Every published version is listed, however many there are. Up to MZ-01.00.35 only the newest 40 registry tags were read, and every release adds two, so the oldest versions dropped off the list.
  - The page checks again by itself when it opens and the last check is more than 10 minutes old.
  - A backup is taken before every switch.
  - A version that does not start is rolled back by itself.
- **Recent events:** switches, starts, automatic rollbacks, restarts.
- **Exact times.** Every moment on the page is shown to the second with its time zone, in your profile's time zone and your language's format (for example *Oct 15, 2026, 8:41:07 AM UTC*): when each version was built, when it was installed here, when the running version was switched to and by whom, the last check, and each event. Point at a time to see it in UTC.
- **Replace the whole image (Beta).** For the rare release that needs a new Node.js or OS base. The **update companion**, a second small container you start once, replaces the container itself:
  1. It downloads the image while the server keeps running.
  2. It stops the server, which saves first, as for any update.
  3. It starts the same container on the new image, with the same ports, volume, environment, limits and security options.
  4. If the new server does not say it started within 150 s, or stops soon after, it goes back to the old container.

  The chip on the section says whether the companion is ready. Choose **latest** or a version, then **Replace the image**; a backup is taken first. The page shows each step and how it ended. Starting the companion is one line, shown on the page and in [Updating](updating.md#full-image-update-from-the-page-beta).

### Beta features (Admin)

A feature starts in Beta: only roles holding **Beta features** see it. When you trust it, **Make final**:
- it loses its Beta label, and anyone holding the feature's own permission can use it;
- what it adds elsewhere turns on.

**Back to Beta** undoes it. Every change is in the audit log (type **System**), with who made it.

| Feature | Once final |
| --- | --- |
| **Code authors (git blame)** | Anyone who may **send reminders** can find and email the developers who wrote the vulnerable code. The sidebar entry becomes **Code authors**, the Workbench's Remind panel links to it, and Act → Automation can email code authors on every run. |
| **Match usernames to email addresses** | Anyone who may change **initiator addresses** can run and apply the matching. |
| **Fusion results** | Everyone who loads findings sees **Labs → Fusion results**, with its own line to load Fusion's results, and the Workbench's **Fusion** column. |
| **FAE Flush** | It moves out of Labs to the top of **Act** (FAE Flush, Workbench, Automation); the Workbench stays the home page. Anyone who manages the Checkmarx One integration can run it. |
| **Govern** | It moves out of Labs to its own menu group, **Govern**, between Prove and Plan. Everyone holding a Govern permission keeps using it as before. |

### Hands-off (set it up once)

For teams that would rather not sign in to one more tool. **Settings → Hands-off** asks four questions:
1. What MissionZero does on its own: remind developers, a weekly status, the monthly summary.
2. Which findings: severities, and their age in days.
3. Who: where reminders go, who gets the status, who gets the summary.
4. When: how often it checks, and the status's day and hour.

**Turn on hands-off** saves it all. The weekly status has buttons that act after one more click: **Send the reminders now**, **Pause for 7 days** or **Resume**, and **Stop sending me this**. With **Also read replies** ticked, a reply that starts with one word also works: PAUSE, RESUME, RUN, STATUS, STOP or SOLVED. MissionZero acts only when the reply comes from the address it wrote to.

**Self-check.** Every 5 minutes MissionZero checks Checkmarx One, the email server, its automatic runs and its error rate, and puts right what it can. It emails the administrators when something needs them, and again when it works. With auto-update on, a problem it cannot fix becomes a support case that the administrators forward to the maintainer; they close it with **Mark as solved** or a SOLVED reply. The box at the bottom shows what is wrong now and the last events; **Check now** runs a check. Details: [hands-off](hands-off.md).

### Activation codes (Admin)

**CxMissionZero itself** works until the end of 31 December 2026 (UTC). From 1 December, Admins see a banner with the date; the first line here shows it too. After that date every page says **The product has been deactivated. Please reach out to Bhawani Singh.** until a product activation code from the maintainer is entered, here before the date or on that page after it. Nothing is deleted and backups go on ([the product licence](activation-codes.md#the-product-licence-cxmissionzero-stops-after-31-december-2026)).

Some add-ons are unlocked with a code from the maintainer of CxMissionZero:
- **Hebrew:** an activation code switches Hebrew on; a deactivation code removes it. Who sees it is a role permission: **Hebrew** on People & roles (listed while Hebrew is on). Admins always have it; tick it for Security Analyst or any other role.
- **Several tenants:** for organisations that run more than one Checkmarx One tenant (the Super Admin tasks).
- **Govern:** shows **Labs → Govern** to the roles holding its permissions ([Labs: Govern](#labs-govern)). Turned off, its cycles stop; restrictions it made in Checkmarx One stay until it is back and someone restores them.

Paste the code and select **Apply the code**. What it unlocks is switched on at once. The page lists only what a code has unlocked: until then it says **No add-ons are unlocked yet**, and **Settings → Tenants** is not shown. It shows what is unlocked, for whom and until when, and warns 30 days before a code expires. A code lasts 12 months. It is checked here, against the maintainer's public key, with nothing sent anywhere. Every code applied, or refused, is in the audit log (type **System**). Everything else in CxMissionZero works without a code. Only roles holding **Activation codes** enter codes. Roles with **See the Activation codes page** see the section read-only: what is unlocked, and until when. [How codes are issued](activation-codes.md).

### Tenants (Super Admin)

For organisations that run several Checkmarx One tenants. This section appears once a tenants activation code has been applied. Turn on **Several tenants**, then **Add tenant**: each tenant has its own connection, email server, settings, credits, reports, audit log and people. Choose a tenant at the top of the page to work in it. **Rename** and **Remove** are next to each tenant; removing one keeps its files. People added while you work in a tenant work only there; a Super Admin changes that with **Tenants** on each person under People & roles. The whole story: [several tenants](multi-tenant.md).

### About & terms of use
The version, the licence, the project's address, which version of the terms you accepted, and **Read the terms of use**. **Organisation** is your organisation's name, given when the terms were accepted for it; it goes on the Cx Credits Calculator's reports. Roles with **Branding** (Admins) can change it here.

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
- **Mistakes are caught first.** Every line is checked before anything is applied. A value that would break a connection (a port that is not a number, `SMTP_SECURE=ssl`, `smtp://` in the host, a misspelt name, the API key's ID instead of the key) is **not applied**, so the working setting stays. It is listed with its line, what is wrong and how to fix it. Something that is probably wrong but could work (a Gmail password that is not an App Password) is applied and listed as **Check this**.

### Checkmarx One integration (Admin)
The server's own connection to Checkmarx One. It is used for:
- password sign-ins;
- triage and remediation from emailed reports;
- automation;
- tracked reports.

| Field | Meaning |
| --- | --- |
| API key | Create one in Checkmarx One under Identity and Access Management → API Keys. Its role must allow reading projects and results, and running AI Triage / AI Remediation if you use them. Leave blank to use the key you signed in with. |
| Single-tenant / on-prem overrides | IAM URL, API URL and tenant. Only needed when they cannot be worked out from the key (single-tenant or on-prem). Pointing the IAM or API URL at another host clears the stored key: paste it again with the new address. |
| **Connect & store** | Checks the key (token exchange plus one project call) and stores it. A key that cannot work (its ID, cut short, in quotes, expired) is refused before it is tried. When it does not connect, **How to fix it** says why and what to do. |
| **Remove stored key** | Removes the stored key. If the server was started with `CX_API_KEY`, it falls back to that key. |
| **Trusted certificates** | Certificate authorities the server trusts for its own connections (Checkmarx One, email, git) besides the public ones. Each shows who added it, when, and its fingerprint, with **Remove**. **Upload a certificate…** adds a company root certificate (.pem, .crt or .cer). Changes apply at once, with no restart. |

**Behind a company proxy that inspects HTTPS.** When **Connect & store** fails because the certificate is not trusted, the box under it shows what your network presents:
- **The proxy's root certificate was found:** its name, the product (Zscaler, Netskope, Palo Alto Networks…), how long it is valid and its SHA-256 fingerprint. Check the fingerprint with your network team if you are unsure, then click **Trust and connect**: the certificate is trusted and the connection is tried again.
- **Only the certificate's name is known:** click **Upload a certificate…** and choose your company's root certificate. Not sure which one? **Export the certificates from Windows** gives one command for cmd that saves every certificate the computer trusts to `company-certificates.pem` on the desktop. Upload that file: only the certificates this connection needs are kept.
- **A server that left out its intermediate certificate** (browsers fetch it themselves) is completed on its own: the missing certificate is fetched from the address in the server's certificate and kept only if a public root vouches for it. Nothing to click; the audit log records it.

Only Admins of the first tenant change trusted certificates, as they apply to the whole server. Each change is in the audit log.

### Network & proxy (Admin)
How the server reaches Checkmarx One: directly, or through your company's proxy (**Proxy server**, a user name and password if it asks for one, and the hosts that skip it). **Check the connection** tries it step by step before saving (Proxy, Connection, Certificate, Checkmarx One) and says where it stops and what to do; **Save and restart** saves it only when Checkmarx One can be reached through it, then restarts the server for a few seconds to use it. Below, **What your network team needs to allow** lists every connection the server makes or takes, from its own settings, with **Copy for your network team** and **Download (.txt)**. Windows-integrated sign-in to the proxy (NTLM/Kerberos) is not supported. Details: [Network and proxy](network.md).

### Email server (SMTP) (Admin)
| Field | Meaning |
| --- | --- |
| Host, Port | Your mail server. Port and TLS mode are paired: picking port 465 turns on **Secure connection from the start**, and 587 / 25 / 2525 turn it off. |
| Secure connection from the start (port 465) | On only for port 465. |
| Server needs a user name and password | Usually on. |
| Check the mail server's certificate | Leave on. Turn off only for an internal relay with a self-signed certificate. |
| Username, Password | The sending account. The password is stored on the server and never shown again. Changing the host clears it: type it again for the new server. |
| From name, From address | Who the reminders come from. A blank address uses the username. |
| **Test connection** | Connects and logs in without sending anything. When it fails, **How to fix it** says what is wrong and what to do (below). |
| **Send test email** | Sends a real email to the address you type. A refused sender or recipient is explained the same way. |

**Sending needs a passing test.** Changing the host, port, user, password or TLS options needs a new test.

**Common servers**
- **Gmail:** `smtp.gmail.com`, port 587, **Secure connection from the start** off, and an [App Password](https://myaccount.google.com/apppasswords); your normal password will not work.
- **Office 365:** `smtp.office365.com`, port 587. The mailbox needs **Authenticated SMTP** turned on (Microsoft 365 admin center → the mailbox → Mail → Manage email apps).

**When it does not work.** The box under the button says what is wrong in one sentence, then the steps that fix it, most likely first. For example: the port and **Secure connection from the start** do not match; Microsoft 365 has SMTP sign-in turned off; Gmail needs an App Password; the name cannot be found; the server's certificate is not trusted; the server will not send with this From address. **What was tried** shows the server, the account and the server's own answer, never the password. The header's **Email** chip shows the same until it works. Every problem it recognises is listed in [When a connection does not work](troubleshooting.md).

### Developers
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

### SLAs (Beta)
How many days each severity has to be fixed, counted from when the finding was **first detected**. Shown to roles holding **Beta features** while it is in Beta, and to everyone who loads findings once an Admin makes it final (Settings → Beta features).

| Option | Meaning |
| --- | --- |
| Critical / High / Medium / Low | Days to fix. Defaults: 7, 30, 90 and 180. **0** means no SLA for that severity. |
| Escalate findings that go past their SLA, once each | Each reminder run (Act → Automation must be on) emails the people below one list of the findings that went past their SLA since the last run: project, severity, how far past, and who ran the latest scan. A finding is escalated once; if it is fixed and comes back, it is escalated again. **Test mode** in Automation counts them without sending. |
| Escalate to | The addresses that get the escalation, one per line. |
| Also open an issue in the repository | Each scheduled run opens **one issue in each project's repository** listing its findings that went past their SLA (severity, finding, where, first found, days past, a link to Checkmarx One), each finding once. GitHub, and GitLab as a **confidential** issue, with the token connected under Beta → Source-code hosts (it needs permission to create issues). **Private and internal repositories only:** a public one is skipped, so vulnerabilities are never published. Text from findings cannot mention anyone or add links. At most 20 projects a run, the most severe first; the rest next run. Works with or without the email escalation. **Test mode** counts them without opening any. |

Findings triaged as not exploitable (proposed or confirmed) have no SLA. On the **Workbench**, **Past SLA** shows how many open findings are past their SLA (red), with how many more are due within 7 days under it (amber). The projects table has a **Past SLA** column, shown by default, and **Due ≤ 7d** under **Columns**; both are in the CSV export. The automation's run history says how many were escalated, how many repository issues were opened, and which projects were skipped and why (no repository, no token, public repository, no permission).

### Automation
Moved to its own page under **Act → Automation** in MZ-01.00.88: see [Automation](#automation). **Settings → Automation** in the menu, and old links to it, open that page.

### AI Triage & Remediation from reports
| Option | Meaning |
| --- | --- |
| Allow AI Triage from reports | Developers can click **Triage** in their emailed report. Uses credits. |
| Allow re-triage | Triage a finding again when it already has a verdict (charged again). |
| Allow AI Remediation from reports | Developers can click **Remediate**. It may open a pull request, and applies to reports generated after you turn it on. |
| Allow re-remediation | Remediate a finding again (3 credits again; may open another pull request). |
| Leave not-exploitable findings out | Findings proposed or confirmed not exploitable are left out of reminders and reports. On by default. |
| Administrator contact | Who developers ask for more credits; the report's "Ask the administrator" button emails them. Blank: the From address. |
| **Credit pool** (Admin) | The most the utility may spend on triage and remediation together, never more than the tenant has left in Checkmarx One; 0 means up to what the tenant has left. Beside it, the **Checkmarx One tenant** card shows the credits left of the tenant's total, a bar of what is used and given to projects, how many are used, given to projects and in this pool, and whether Fusion scans charge credits; **read again** asks Checkmarx One afresh. **Pool size** says **at most** what the tenant has left and checks it as you type: within it, or why it cannot be saved, with **Use** to set exactly what is left (a pool above it is not saved; the rest of the page is). If the tenant later has fewer left than the pool (credits spent elsewhere), Settings and Credits say so in red, and spending, and what can be given to projects, stop at what the tenant has left. Projects are never given more than the tenant has left, pool or no pool. |
| Refill | Every month on the 1st (UTC), or never (one pool). |

**Costs:** 1 credit per Checkmarx One result triaged, and 3 per finding remediated.

**Impact: time and money** (for the [Impact page](#impact)):

| Option | Meaning |
| --- | --- |
| Minutes to triage one finding by hand | 20 by default: the hours AI Triage saved. |
| Minutes to fix one finding by hand | 120 by default: the hours AI Remediation saved. |
| Hourly cost of an engineer, price of one credit, currency | Money figures; leave them at 0 to show hours only. The currency is chosen from every country's currency. Each person can see the amounts in their own currency under [Your profile](#your-profile). |
| Monthly summary to | Who gets the summary on the first day of each month, for the month before. Nobody: not sent. |

### Branding
Everyone's default branding. Seen by roles with **See the Branding page**, and changed by roles with **Branding**. Each person can present with [their own](#your-branding) over it.

| Field | Meaning |
| --- | --- |
| App name | Shown in this app's header. |
| Browser icon | The icon in the browser tab, bookmarks and the developer pages. Empty is CxMissionZero's own icon (the wheel in saffron, white and green, also shown in the menu). Paste an `https` address, or **Upload an icon** (SVG, PNG, ICO, WebP or JPG, up to 100 KB; square works best); **Default** puts it back. It changes for everyone as soon as it is saved. |
| Company name, Company logo | Head every email and report. An `https` logo URL works best, because mail clients block embedded images. You can also upload a PNG, JPG, SVG or WebP up to 200 KB. |
| Logo height | 16–200 pixels. |
| Accent colour | Buttons and headings in emails and reports. |
| Call to action | The sentence above the findings in every email. |
| Look of the app | The organisation's look, picked from picture cards: **Command center** (the default), Cabin, Circuit, Residence, Chronometer, Signal, Studio, Atelier or Classic. Everyone has it unless they pick their own under Settings → [Your appearance](#your-appearance). |
| Let people choose their own look | On (the default): each person may pick another look. Off: everyone has the organisation's look, and every report follows it. |
| Menu in the new looks | **Down the left side** (the default) or **Along the top**, for everyone. Along the top needs a wide screen (1261 pixels and up); narrower screens keep the side menu, the icon rail or the phone's bottom bar. |

The preview shows the email header exactly as recipients will see it. The look of the app, and where its menu sits, change for everyone as soon as they are saved; see [the look of the app](branding.md#the-look-of-the-app-nine-looks-to-choose-from).

### Links into Checkmarx One
Every finding in an email links straight to it in Checkmarx One (Risk Hub).
- If links land in the wrong place, edit the **base URL**, **project link** or **finding link** template. The example underneath updates as you type.
- Placeholders: `{baseUrl}`, `{projectId}`, `{scanId}`, `{engine}`, `{riskId}`.

### Reminder server address
The address people's browsers use to reach this server, put into every emailed report so readers can triage from it. For example `https://mission-zero.company.com`.
- **Test** checks that it answers as this server.
- You are warned if it is `localhost` (nobody else can reach it) or plain `http`.
- Use the `https://` name in your certificate ([Turn on HTTPS](#turn-on-https)). `REPORT_SERVER_URL` fills it in when the page has none saved.
- With neither set, reports sent with nobody at the dashboard (scheduled ones) use the last address someone who may change this setting opened the dashboard on. Behind a reverse proxy that is often an internal name, so set the address here.

### Risks endpoint
Where findings are read from. The default is `/api/risks/`.
- **Detect** tries the known paths against your tenant and shows what each returned.
- `/api/risks/ai-insights` adds AI Triage status to each finding.

---

## Workbench

**Get started.** Until the basics are in place, one row of steps at the top shows what is left: connect Checkmarx One, fetch vulnerabilities, set up email, give reports a reachable address, cap AI credits, invite your team. The first step is labelled **Connect**; each other step carries the name of the sidebar group it belongs to (Act, Prove, Set up). Done steps are ticked green and joined by a green line; each step still to do has its button. **Hide** puts the row away.

**The way to Mission Zero.** Under the totals, one line shows where the fetched findings stand:
- **Mission Zero:** a ring with how many projects have nothing open.
- **Detect → Triage → Remediate → Fix → Verify:** the number at each stage.
  - **Detect:** open findings.
  - **Triage:** findings still to verify.
  - **Remediate:** confirmed findings.
  - **Fix:** findings with a fix asked for, waiting to be merged and rescanned.
  - **Verify:** tracked reports verified at zero by a rescan.
- **What is next:** the stage to act on is highlighted, and the green line runs up to it. A stage turns green only when it, and every stage before it, is clear. **Verify** turns red when a report verified at zero has findings again.
- **Hover** a stage for the detail. **Triage** and **Remediate** open **AI credits**; **Fix** and **Verify** open Reports.

**How the page is laid out.** One compact block at the top, then the projects.
- **The top block** holds what to load (both windows, engines, branch, **Narrow down** and **Load findings**), one line of totals and the way to Mission Zero. It takes about a fifth of a 1080p screen and under a third of a laptop's, and **stays in view** while you scroll: the scope and **Load findings** are always at hand.
- **The projects scroll with the page.** There is one scroll bar: the table has none of its own, and its header row stays under the top block as you scroll. The action panel beside it stays in view too.
- On a screen narrower than 1100 px, or less than 640 px tall, the top block scrolls away with the page instead.

Everything you do with the projects is in the **action panel**, with four tabs:

| Tab | What is in it |
| --- | --- |
| **Remind** | Send a reminder (step 6 below). |
| **People** | The developers (step 5 below). |
| **AI credits** | Allocate, triage and remediate (step 4 below). |
| **Track** | Save the scope as a tracked report. |

- **Wide screens (1600 px and more):** the panel stays beside the projects.
- **Smaller screens:** the projects use the full width, and the bar above them (**Remind**, **People**, **AI credits**, **Track**) opens the panel from the right. Close it with **✕**, **Esc** or a click outside. It keeps whatever you were doing in it.
- The line at the top of the panel says what its actions apply to: the ticked projects, or every shown project.

### 1. Scope: what to fetch
| Option | Meaning |
| --- | --- |
| Projects last scanned in | Skips projects with no scan in this window, so fewer calls are made. **Last week** by default; choose any time, last week, month, 90 days or year, or a custom range. After a load, the page keeps the scope you used. |
| Findings first detected in | Only findings first detected in this window. Checkmarx One filters them. **Last week** by default. |
| Engines | Which Checkmarx One engines' findings are loaded. **SAST** and **SCA** are ticked by default: they are the engines AI Triage and AI Remediation work on. Tick **IaC**, **Containers**, **API Security** or **Secrets** to add theirs (marked **No AI**), or untick SCA to focus on code only. At least one stays ticked; the choice is remembered in this browser. Changed after a load, it says so: **Load findings** again applies it. Everything that follows works on these engines only: the totals and the projects table, reports and reminders (a report says **Engines: SAST, SCA** at its top), tracked reports saved from here, and AI credits (allocate, triage, remediate, verified twice on these engines' findings). |
| Branch | Which branch's findings count. A project is usually scanned on several branches (main, release, feature branches), and counting each would count the same vulnerability several times. By default (**Primary branch**) only each project's primary branch counts: the one set for the project in Checkmarx One, else **main**, else **master**; a project with none of those set or scanned counts the branch of its latest scan. Its latest completed scan there is the one used, findings from other branches' scans are left out, and the projects table, reports, reminders, tracked reports, credits and verification rescans follow it. Tick **Every branch** to count every branch's findings, as before. Two more boxes: **Leave out projects with no lines of code** (ticked by default: a project whose scan counted no code has nothing to analyse) and **Leave out projects with no open findings** (off by default: keep them in for a compliance report that must list every project). After a load, a line under the row says how many projects were left out and why: a primary branch with no completed scan, no lines of code, or no open findings. The choice is remembered in this browser. |
| Only these applications, projects, people or vulnerabilities | Optional; open it with **Narrow down** (it reads **Narrowed (N)** while something is chosen). **Applications**: the applications defined in Checkmarx One; type to pick one, and every project in it is fetched (the list says how many each holds). **Projects, by name**: type to pick, or press Enter to add every project whose name contains the text. **People who ran the latest scan**: a username or an email. Any mix works: an application and two more projects fetch all of them. Only those projects are fetched, which is the fastest fetch. |
| A vulnerability (in **Narrow down**) | Optional: type what to find (**SQL injection**, **SSRF**, **path traversal**, **CWE-89**) and press **Search**. Only the findings of that vulnerability are loaded, and only the projects that have it are shown. |

**Find a vulnerability, and fix it here.** The search box in **Narrow down** loads only the findings whose name matches, so you can go after one kind of weakness across every project:
- It ignores case, underscores and dashes, and a word may be the start of a longer one: *sql inject* finds *SQL_Injection* and *Blind_SQL_Injections*.
- Usual short forms work: *SSRF* also finds *Server_Side_Request_Forgery*; *XSS* finds cross-site scripting, *SQLi* SQL injection, *XXE*, *CSRF*, *RCE*, *LFI*. *CWE-89* finds findings of that weakness.
- Several at once: separate them with commas (*SSRF, path traversal*).
- As you type, it suggests the names of the findings loaded last, most frequent first.
- A line under the box says what is loaded (*SSRF · Findings: 240 in 30 projects*). **Every action here then works on those findings only**: the totals, reminders, **AI credits** (allocate, triage, remediate, each verified twice with Checkmarx One on those findings), and tracked reports saved from here. **Show every finding** (or emptying the box and pressing **Search**) loads everything again.

### 2. Load findings
- Rows appear as each project is read.
- An **amber flare** (bottom-right) says the fetch is in progress, with how many projects are in so far. It turns **green, Data fetch complete**, when the last one arrives.
- Until then, triage, remediation and credit allocation are switched off, so nothing is decided on half the data.
- **Stop** (beside the button, while it loads) ends the load early. Projects already being read finish, the rest are not read, and the projects loaded so far are kept: the totals, the projects list, reminders, AI checks and fixes and reports all work on them, as after a full load. The flare turns green with **Stopped — kept 6 of 20 project(s)**, and the note under the button says how many were left out. **Load findings** again reads them all. Closing or leaving the page while it loads stops it the same way.
- **How long it takes** depends mostly on how many pages of findings Checkmarx One has to send (200 findings a page) and how fast it answers each: 24 projects are read at once, as many calls as the connection allows. Narrowing to applications, projects or people, a shorter **Findings first found in**, or a vulnerability search reads fewer. Changing the **Engines** and loading again is quick: projects read in the last couple of minutes are reused, and only their findings are picked again. **Primary branch** costs a little more on the first load only: a project whose latest scan is on another branch has its recent scans looked through once (one call), and the branch of each scan its findings name is read once (50 scans a call); scans never change branch, so both are remembered. **Leave out projects with no lines of code** reads each scan's line count once, for the same reason.
- **Faster when someone just fetched.** A project read by anyone in the last couple of minutes is reused, unless it was rescanned or triaged from CxMissionZero since. Under the button it says how many were reused. Tick **Read everything fresh from Checkmarx One** to read every project again, for example right after changing findings directly in Checkmarx One.

Each finding falls into an age bucket by when it was **first detected**:

| Bucket | Meaning |
| --- | --- |
| ≤ 30 days | First detected in the last 30 days. |
| 31–60 days | First detected 31–60 days ago. |
| > 60 days | Nobody has touched these for two months. |

### 3. Projects table
| Control | Meaning |
| --- | --- |
| Search, Severity, Age, Scan type, Hide empty | Filter the table. **Scan type**: projects whose latest scan was a Fusion scan (gold rows), a LAST scan (pink rows) or neither; the legend under the table says how many of each. |
| Click a column header | Sort by that column. |
| **Columns** | Add the age-bucket and per-severity columns, and (with SLAs) **Past SLA** and **Due ≤ 7d**. Your choice is remembered in this browser. |
| **Export CSV** | Every shown project, every column, with credits. |
| Tick boxes | Select projects. Reminders, credits and tracking apply to the selection, or to every shown project when none is selected. |
| Open findings | Open findings of every severity in the project, in the period chosen above. A finding is one place where Checkmarx One found a vulnerability. (It was called **Total vulnerabilities**.) |
| Oldest open since | When the project's oldest open finding was first found, and how many days ago. |
| Last scanned by | Who ran the project's last scan, and the email it resolved to: reminders go to them. |
| AI Triage / AI Remediation credits | **Left / allocated** (the **?** in the heading says so), and in orange how many more are needed. Click the numbers to open the project's credit editor: **Give it extra AI credits**, with what the project **needs**, what it has **left**, a box for the **extra** credits of each kind, and **Save extra credits**. Extra credits come out of the credit pool and stay with the project until you change them. |
| Action panel → **Track** → **Save as tracked report** | Follow these projects and filters over time (see [Dashboard](#dashboard-tracked-reports)). |

### 4. AI Triage & Remediation credits
*Action panel → **AI credits**.* **Nothing is allocated until you confirm it.** (**How allocation works** opens the rules below.) For the ticked severities (Critical and High by default), the panel shows what the selected projects **need**:
- **Triage:** 1 credit per Checkmarx One result still to triage.
- **Remediation:** 3 credits per **confirmed** finding not yet remediated.

**Why rows and credits can differ.** Checkmarx One can list one result once per code path. For example, 12 rows can be 10 results: those rows are triaged together and charged once, so the need is 10 credits, not 12. Counts always show both.
- **Why fewer results than findings** (in the panel and in each project's credit editor) lists them: each Checkmarx One result that covers more than one finding, its severity and title, how many findings, and where each code path ends (file and method).
- Those findings are one vulnerable piece of code reached by several data flows. They are triaged once, for 1 credit, and **one fix closes them all**, so fix them in one go.

| Button | What it does |
| --- | --- |
| **Check the numbers again** (green border) | Re-reads the findings twice, independently. The numbers are marked confirmed only when both reads agree. Every button below runs it first by itself, so you rarely need to press it. |
| **Give credits** (AI check) | Verifies first, then shows what will be given and asks you to confirm. Credits come out of the credit pool. |
| **Triage critical & high** (named after the ticked severities) | Runs AI Triage on the selected projects' findings at those severities, within their credits. It turns gold once the credits cover them all. |
| **Give credits** (AI fix) | The same, for confirmed findings. |
| **Remediate critical & high** (named after the ticked severities) | Lists each project's confirmed findings and the cost, then runs AI Remediation after you confirm. Each finding is re-checked first; anything no longer confirmed is left alone. |
| Email each scan initiator… | On by default. When you triage or remediate for someone, each scan initiator gets one email about their own projects: what was started on their behalf, and what to do next (refresh their report, review and approve the pull requests). |
| **Take back N unused credits** (top of the panel, next to **Check the numbers again**) | Returns everything the selected projects were given and did not use (people did not act on it) to the pool; the button says how many. It never goes below what was used or is in flight. **Every project: Credit Control →** takes back from all projects at once. |
| Extra credits → **Add extra credits** | Gives every selected project a fixed extra amount. |
| Extra credits → **Take back extra credits** | Returns the extras. |

**Every action checks first.** Each button in this panel (allocate, triage, remediate, extra credits, taking credits back) first checks the numbers again (as **Check the numbers again** does). Allocating, triaging and remediating check only the projects that have something to triage or remediate (not every project shown), each project's two reads side by side, 8 projects at once. Matching each finding to its Checkmarx One result reads the scan's result list once, without code paths and 8 pages at a time, and keeps it for 10 minutes for your sign-in (a scan's results do not change), so the second read and the allocation after it reuse it: a check that took close to two minutes on a large scan takes seconds. Developers may be triaging or remediating in Checkmarx One itself, or from their emailed report, while you look at this page.
- **Nothing changed:** the action goes ahead with the confirmed numbers.
- **Something changed** (for example, results to triage 10 → 8, or remediation credits left 6 → 3): the action is **cancelled**. The panel now shows the real numbers, and a message lists exactly what changed. Click again to go ahead with them.
- **The two reads disagree** (someone is working on those findings right now): the action is cancelled. Wait a moment and click again.

**Safety nets**
- The same vulnerability is never sent twice, from any page, report or person, even at the same moment.
- A triaged finding is never counted as "needed" again.
- Every credit movement is in the audit log.

### 5. Developers
*Action panel → **People**.* Everyone who ran a latest scan, with their email.
- **Missing an address?** Type it and **Save**. It is used at once and remembered for later fetches.
- **Suggested address?** Click **Confirm**. A suggestion is never used until someone confirms it.
- **Pick who gets the reminder:** tick people, or use **Select all**, **Clear** or **Pick missing**. **All / Selected / Missing email** filter the list.

### 6. Send reminder
*Action panel → **Remind**.* **Preview email** and **Preview report** open over the page; close them with **Close**, **Esc** or a click outside.

| Option | Meaning |
| --- | --- |
| Send to | **Each developer**, **A fixed list**, or **Both**. **This is the one place that decides who gets reminders**: here, Act → Automation's runs, and tracked reports' follow-ups all use it (changing it needs **settings.recipients**). A scan initiator only ever gets their own projects; the server refuses any email that would show someone a project they did not scan. |
| Content | **One summary** (one email per person, all their projects), or **One per project**. |
| Attach the interactive HTML report | On by default. Developers can triage and remediate straight from it. |
| Fixed list | To / Cc / Bcc, edited here. **Save list** keeps it. |
| **Preview email**, **Preview report**, **Download HTML** | Check before sending. **Download HTML** is always there: it saves the interactive report of the selected projects, to share it yourself. |
| **Send reminder** | Sends, then lists who got which projects and who was skipped (for example, no address). |

The age filter is the Scope's job: a reminder covers the findings in scope.
- Findings proposed or confirmed **not exploitable** are left out (unless switched off in Settings).

---

## Automation
**Act → Automation**: age reminders and everything else that runs by itself, on seven tabs. Who may see and change it is as before: roles that may **view settings** see it read-only; roles with **Automation** (`settings.automation`) change, preview, run and reset it. Each tab saves with its own **Save** button.

### Reminders
People are emailed once when a finding in their projects gets older than each age limit. Each finding is reported **once per limit**, so a daily run does not nag.

| Option | Meaning |
| --- | --- |
| Run automatically | Ticking it and pressing **Save** opens **Preview** first: who would get what now, and a **Turn on** button. Nothing runs by itself until it is turned on from there. |
| Test mode | Decides and logs, but sends nothing. Use it for the first run, because an older tenant has a backlog that crosses every limit at once. |
| Also email the code authors | Shown once an Admin has made **Code authors** final. Each run also emails the developer who last changed the line of each finding that just crossed (SAST and KICS, most severe first, up to 200 a run). |
| Age limits, by severity | **The same for every severity** (one list, such as `30, 60, 90`), or **Each severity its own** (such as Critical `7, 14, 30`, High `30, 60`, Medium `90`, Low none). A severity with no days is not reminded about. |
| Reminders On | Which severities are reminded about at all. All ticked means every severity. |
| Findings past a limit now | From the last **Preview**: how many findings of each severity a run would remind about now. |
| When a finding is already past several limits | **Report each limit once** (recommended), or **Remind about everything past a limit, every run**. |
| Sends to | Shown, not set here: it follows **Workbench → Remind → Send to** (each developer, the fixed list, or both). |
| **Run once now** | Runs a pass immediately (in test mode if that is ticked). |

The tab also says whether the Checkmarx One connection and the mail server are ready for unattended runs.

### Focus
What reminders cover. Leave everything blank to cover every project the server's Checkmarx One key can see.

| Option | Meaning |
| --- | --- |
| Applications | Checkmarx One applications by name, separated by commas. The names offered come from the tenant; a name that matches no application is pointed out. |
| Project tags | A tag key (`team`) or key and value (`team:payments`). |
| Projects | Project names; `*` stands for any characters and `?` for one, such as `payments-*`. |
| Leave out projects | Names or patterns left out, such as `*-sandbox, demo-*`. |
| Engines | **SAST** and **SCA** (what AI Triage and Remediation work on) for a new installation. A schedule saved before engines could be chosen keeps every engine. |
| Branch and projects | **Every branch** off: each project's primary branch only. **Leave out projects with no lines of code** on. |

A project is covered when it is in a named application, has a named tag, **or** matches a named project, and does not match a left-out pattern. Under the fields, **Matches N of M projects** says what the names typed cover, as you type.

Checkmarx One reports a project's groups as ids without names, so Focus names applications and tags rather than groups.

### Schedule
| Option | Meaning |
| --- | --- |
| On a schedule | Reminders go out on the **days** ticked, at the time given (**At**), in the **time zone** given. Blank: the server's (`TZ`). The default for a new installation is Monday to Friday at 09:00. Clock changes are followed: 09:00 stays 09:00. |
| Every so many minutes | From 15 minutes to 1 week, counted from when it was turned on. A schedule saved before MZ-01.00.88 keeps this, with its interval. |

The badge says when the next run goes out, or would if it were on.

### Email
The reminder each person gets, written as fields rather than HTML, with a live preview beside it.

| Field | Meaning |
| --- | --- |
| Sender name, Reply-to, Footer | **Same as the portal** by default: the Email server's sender name and From address, and the company name. Untick it to write the email's own. |
| Logo | **Same as the portal** (Settings → Branding), **Another for reminders** (an `https` image), or **None**. |
| Colours and look | **Same as the portal**: the brand colour chosen under Settings → Branding, or else the organisation's look (Command center's navy, Residence's navy and ivory, and so on). Untick it to pick a colour. |
| Header text | Shown on the right of the band at the top, such as **Security reminder**. |
| Subject, Greeting, Opening, Button, Sign-off | The words. **Insert** adds a placeholder where the cursor is: `{{name}}`, `{{firstName}}`, `{{count}}`, `{{critical}}`, `{{high}}`, `{{oldestDays}}`, `{{projects}}`, `{{limit}}` (the highest limit crossed) and `{{company}}`. What is typed is text: markup is shown as typed, never run. |
| List each project with its counts | A table of the person's projects: critical, high and the oldest finding's age. |
| Attach the HTML report | Each person's interactive report, attached, as with reminders sent by hand. |
| Edit the HTML instead (advanced) | Sends the HTML template (Settings → Mail template) instead; branding above does not apply to it. An installation whose template was changed before MZ-01.00.88 keeps sending it. |

**Send me a test** sends the email as typed to you only, with its sender name and reply-to. **Restore default** puts back the portal's branding and the default words. The preview shows the first person of the last **Preview**, or a sample.

### Preview
**Preview now** reads Checkmarx One as a run would and lists who would get what: people, projects, findings past a limit and critical, then one row per email with its projects, counts and the limits crossed. **See the email** opens that person's email as it would be sent. People whose address is not known are on one row, with **Set addresses**. Nothing is sent, and nothing is remembered as reported. **Email me the preview** sends you the list (not anyone's email).

### Follow-ups & escalation
Everything else that runs by itself, wherever it is set: tracked reports' automatic follow-ups and verification rescans (Dashboard), and SLA escalation (Settings → SLAs), which goes out with each reminder run. Each row says when it runs and when it last ran, with **Open**.

### History
Each run: when, how (scheduled or **Run once now**, in test mode or not), the findings past a limit, the emails sent, and the outcome (**Sent**, **Logged only**, **Nothing new**, **Skipped** or **Failed**), with what went wrong. **Reset history** forgets what was reported, so the next run reports every finding past a limit again.

## The emailed report

*For developers.* Your reminder email has a button, **Let's start fixing the vulnerabilities**, and the same report attached.

1. **Open it.** Click the button (it downloads the report; the link works for 30 days) or open the attachment. Any browser works, and nothing needs installing.
   - It opens in your profile's language, else your browser's. **Language** at the top switches it.
   - It is in your profile's look (its colours, its band across the top and its face; Classic the classic one), light, dark or your device's, and your accent (see [Find your way](#find-your-way)). Without an account, it is in the organisation's default.
   - Your profile's language works offline. Any other language comes from the reminder server the first time, and is then kept in your browser.
   - Finding titles, project names, code, and what Checkmarx One's AI wrote stay as they are.
2. **It connects by itself** to the reminder server shown at the top.
   - If it cannot, it says why. Click **Connect** to try again.
   - If the server moved, click **Change address**. The report checks that the new address really is the reminder server, and remembers it.
   - You need to be on the company network or VPN.
3. **Read the list.** The header sums it up: open findings, how many critical, high, medium and low, and the oldest. It shows the top 50 findings: worst severity first, then oldest.
   - **Filter it:** pick a severity, search (finding, project, file), or tick **Only what AI can act on**.
   - **How this report works** explains Triage, Remediate and the reminder server.
   - Each finding shows:
     - its live Checkmarx One state;
     - a link into Checkmarx One.
   - **Fixes come only from Checkmarx One AI Remediation.** The report never writes a fix, a prompt or coding advice of its own: under a confirmed finding, **Fix:** says to press **Remediate** (or, when the report cannot remediate, to remediate it in Checkmarx One).
4. **Triage** runs Checkmarx One AI Triage on a finding. The verdict appears in the row within a few minutes.
   - **Triage all critical / Triage all high** cover every critical or high finding in the report, across its projects, and skip ones already triaged.
   - A finding judged **not exploitable** disappears from the report, which counts how many it has hidden.
   - **Your tools, chosen once.** Above the list, pick where code opens (**VS Code**, **Cursor**, **Kiro**, **Windsurf**, **Antigravity**, a **JetBrains IDE**, or **the browser**) and how a fix is applied (**Apply in my workspace** or **git apply**). It is remembered in this browser, for every report. Every finding then has two buttons, **Open in …** and **Apply AI fix**: one click each. **▾** on a finding picks another way, for that finding only.
   - **Open in …** opens the file at the finding's line.
     - **One question, once per computer:** where you keep your code (for example `C:\src`). Every repository then opens from there by its name (`C:\src\payments-api`). In **▾**, **Somewhere else?** sets a different folder for one repository.
     - **JetBrains** needs no folder: it opens the file in the project of that name you have open or opened before.
     - **The browser** opens github.dev or the GitLab Web IDE at the line (Bitbucket and Azure Repos show the file).
     - **Not on this computer yet?** In **▾**, **Clone and open** hands the repository to the IDE, which asks where to clone it.
   - **Apply AI fix** applies the fix Checkmarx One AI Remediation wrote for the finding (see below). It stays greyed out until the finding is remediated: there is no other fix to apply.
5. **Remediate** works once a finding is **Confirmed**. It runs AI Remediation and then offers the fix:
   - a summary;
   - the pull request (for repository-connected projects);
   - a downloadable patch;
   - a link to Risk Hub.

   **Remediate all critical**, **Remediate all high** and **Remediate all** run AI Remediation on many confirmed findings at once, critical first, within the AI Remediation credits your administrator allocated:
   - Each finding costs 3 credits. Rows that are one Checkmarx One result are remediated once.
   - A project's credits cover the severities they were allocated for (critical and high unless your administrator chose others). **Remediate all** covers every one of those severities.
   - When the credits cover only some findings, the button says so, for example **Remediate critical: 3 of 4**. Hover it to see why the rest are left out. When they cover none, clicking it opens **Ask the administrator** with what each project needs.
   - One confirmation lists the cost per project. The findings are then sent one at a time, and each fix appears on its row when Checkmarx One finishes. Findings already remediated or running are skipped; **Re-remediate** stays a choice you make on a row.
6. **Apply the fix in your own checkout** (no pull request, a failed one, or you'd rather see it locally first):
   - The fix shows what it changes, **Why and how**, and the test files Checkmarx One wrote for it (they are applied with it).
   - **Apply fix in my workspace** (Chrome or Edge): pick the repository's folder. The report checks the folder's git remote is that project's repository and asks first if it isn't. It then shows each file and the change. **Nothing is written until you click Write changes**; then review with `git diff` and commit as usual. **Open it in VS Code** (or the IDE you last used) then jumps to the change.
     - A change is found even if lines were added above it since the scan. If the code there was itself changed, that file is refused and nothing is written: pull the latest code, or use the git command.
   - **Copy git command** copies one line to run in the repository folder (cmd, PowerShell or a shell): `curl -fsSL "<link>" -o mz-fix.patch && git apply --recount mz-fix.patch`. The link is signed for that one finding and works for 7 days; each download is in the audit log.
7. **Refresh** re-reads states at any time. The report also refreshes by itself.
8. **One project's own report.** A report covering several projects lists them at the bottom.
   - Clicking one asks the reminder server for that project's own report: the same kind of report, for that project alone, read fresh, and limited to the severities and age the original covered.
   - It opens in a new tab and is downloaded too. If the browser blocks the tab, the download still arrives; allow pop-ups for the report to get the tab as well.
   - These buttons never lead to Checkmarx One.

**What the marks mean**

| Mark | Meaning |
| --- | --- |
| **Same result R1**, **R2**, … | Rows with the same label and colour are **one** Checkmarx One result, listed once per code path. They are triaged together for 1 credit. **below ↓ / above ↑** jumps to the twin; hovering a row lights up its whole group. **why?** shows the shared result ID. |
| **Why / Fix** under Confirmed | Why the finding is a real vulnerability, and where its fix comes from: Checkmarx One AI Remediation only (**press Remediate**, or the fix it already wrote). **why?** adds only what those lines do not say: <ul><li>how Checkmarx One knows (for example, it followed the data from input to this code);</li><li>AI Triage's verdict (reachable / exploitable, confidence) when there is one;</li><li>what Remediate will do.</li></ul> |
| **Triaging…** | AI Triage is running. |
| **No verdict** | Checkmarx One produced no AI Triage result within 6 minutes. Check the finding in Checkmarx One; the report keeps checking. |
| **Manual fix** | AI cannot act on this kind of finding (for example IaC). Use **Fix in Checkmarx One**. |
| Your credits | What your projects have left. When they run out, **Ask the administrator** emails them. |

Your report can only act on the findings it lists: each one carries a signature that is valid for 30 days.

---

## Dashboard: tracked reports

Save a scope from the Workbench (**Save as tracked report**) and follow it over time. The Dashboard is laid out for a security team that tracks many scopes at once: the whole picture first, then one report at a time.

**At the top: every report together**

| Tile | What it counts |
| --- | --- |
| **Findings tracked** | The findings the reports held when saved (or when their round began), added up; a finding in two reports counts in both. Under it, the % **actioned** (confirmed, not exploitable or no longer detected), and how many reports are not measured yet. |
| **Awaiting triage** | Still To verify: nobody has triaged them. |
| **Confirmed** | Triaged as Confirmed or Urgent: real, and still to be fixed. |
| **Closed** | Triaged as not exploitable, or no longer detected. **No longer detected is not proof of a fix**: Checkmarx One no longer reports the finding, which can also mean the code changed or the project was not scanned since. Only a [verification rescan](#dashboard-tracked-reports) proves a fix. |
| **New since saved** | Findings **first found after the report was saved** that match its filters. A finding that was there all along and only now matches (for example, one that aged past 60 days into a "> 60 days" report) is not new. |
| **Follow-ups scheduled** | How many reports send reminders by themselves, and when the next one goes out. Set one up in a report's **Remind** tab → **Automatic follow-up**. |
| **AI credits used** | Triage / remediation credits spent on the reports' projects since they were saved. A project in two reports is counted once. |

**Every finding, drawn** (in every look but Classic). The first four figures are shown as a sunflower of seeds: each seed is one tracked finding, set on the golden angle like the seeds in a sunflower, and the bigger the seed, the more severe the finding. Closed findings sit at the calm heart, confirmed ones around them in solid ink, and those awaiting triage are open rings round the rim; as the work is done, the heart grows outward. Beside it, the three outcomes with their numbers; in the middle, Findings tracked and the % actioned. With more than 1,400 findings, one seed stands for several (the caption says how many). In Classic the four tiles are shown instead.

**The first row adds up:** Findings tracked = Awaiting triage + Confirmed + Closed. Each tile's **?** says what it counts. A report's **Open** (in the list, and **Open now** in its overview) is awaiting triage + confirmed + new: what is still to deal with before it reaches zero.

**The list: one row per report**
- **Progress:** a bar of what happened to its findings (aqua: no longer detected, blue: not exploitable, orange: confirmed; the grey rest is still open) and the % actioned.
- **Open, New** and a small **trend** line of open findings over its readings.
- **Status:**
  - **Verified at zero · round N:** a rescan proved everything in the round's scope fixed (or triaged not exploitable).
  - **Left zero:** it was verified at zero, and new findings in scope have appeared since.
  - **Verifying…:** rescans are running in Checkmarx One.
  - **Complete:** nothing left open.
  - **On schedule:** automatic reminders are on.
  - **Needs follow-up:** open findings and no schedule.
  - **Update failed** or **Reminder failed:** the last refresh or send went wrong.
- **Find a report:**
  - **Filter:** All, Needs attention, Scheduled, Complete, with counts.
  - **Search** by name.
  - **Sort** by most open, least progress, recently updated or name.

**Upcoming follow-ups** (right, or below on a narrow screen): every scheduled reminder, soonest first, with who it goes to. Click one to open that report's **Remind** tab.

**Click a report** to open its panel (Escape or ✕ closes it):

| Tab | What is in it |
| --- | --- |
| **Overview** | The % actioned with the outcome bar and counts; open, new, matching now, credits used; the **trend** of open findings (hover for each reading); and a by-project table, most open first. |
| **Remind** | Who gets it follows **who gets reminders everywhere** (Workbench → Remind → Send to); **Only for this report…** gives this report its own choice (developers, fixed list, both, or only some addresses). The content (one summary per person, or one email per project), and whether to attach the interactive report. **Preview**, then **Send reminder now**. The sends so far are listed. Below, **Automatic follow-up**: reminders every N days at a set hour (the server's time zone), only while something is still open, with the same options; it shows the next and last send. **Save schedule**. |
| **Triage** | Two rows, **AI Triage** and **AI Remediation**, each saying the credits needed and left, with one button to allocate and one to run, lined up. The buttons are chosen for you from the findings' severities and the credits held, critical first: the run button covers the widest set the credits pay for (**Triage critical**, **Triage critical & high**, **Triage critical, high & medium**, or **Triage all**) and is gold; the allocate button (for **credits.allocate**) gives what the next set needs (**Allocate for critical, high & medium**, say), counted twice with Checkmarx One first, out of the credit pool. When the credits cover everything, only **Triage all** is left. Remediation works the same on what AI Triage confirmed (3 credits each). A line under the rows lists what awaits triage and what is confirmed, per severity. **Extra credits** adds a fixed amount to every project of the report. Each allocation asks first and is in the audit log. |
| **Verify** | Prove the fixes with a Checkmarx One rescan, then start the next round (below). |
| **History** | Every reading: awaiting, confirmed, not exploitable, no longer detected, new, matching now. |

At the top of the panel: **Refresh** (re-reads now; reports also update hourly, and every few minutes after someone triages or remediates), **Download HTML** (the interactive report for its open findings) and **Delete** (Admins only; its history in the audit log stays).

### Verify: rescan, see what is really fixed, next round

A tracked report is worked in **rounds**. Round 1 is the scope it was saved with (for example critical and high). The **Verify** tab closes the loop:

1. **Is the round closed?** It shows how many findings in scope are dealt with: no longer detected, triaged not exploitable, or confirmed and sent for AI Remediation. What is still open is split into awaiting triage and confirmed but not remediated. **✓ Ready to verify** appears when nothing is open.
2. **The developers rescan first.** When the round is closed, the developers who fixed it get the first chance to prove it:
   - **In their report:** a **Rescan now** card appears. Until everything in scope is dealt with, it shows how many findings are left, and the button stays off.
   - **By email,** when email is set up: a **Rescan now** link that opens a one-button page. **Their rescan links**, on the Verify tab, gives you each developer's link to send by hand.
   - **Their turn lasts 24 hours to 14 days** (48 hours by default; set it on the Verify tab). A rescan they start is theirs: Checkmarx One records them in `requested-by`.
   - **If nobody rescans in time** and **rescan on their behalf** is ticked, CxMissionZero starts it, and tells them by email.
   - **Either way, they get the result by email,** and the updated report of whatever is still open.
3. **Rescan by hand.**
   - **Rescan now to verify** asks Checkmarx One to scan each project again, like its latest scan of the branch the report counts (its primary branch, for a report saved from a **Primary branch** load): same repository, same branch, same engines. It is there at any time, and uses scans, not AI credits.
   - Projects Checkmarx One cannot fetch (code uploaded from a pipeline or the CLI) **wait for their next scan**: whichever scan comes next, from your pipeline or Checkmarx One, verifies them, for up to 30 days.
4. **See what it proved,** per project and in total:
   - **Verified fixed:** gone after the rescan.
   - **Still found:** still reported. **After AI Remediation** means the fix did not work. These are listed.
   - **Accepted:** triaged not exploitable.
   - **New in scope:** found since the round started.
   - When nothing is still found or new: **✓ Mission Zero for this scope**, and the report shows **Verified at zero**. If new findings appear later, it shows **Left zero** at once.
5. **Next round.** Pick the next scope (for example medium and low) and **Start round N**. It starts from what Checkmarx One reports now, after the rescan. The round just finished, with its verification result, stays in **Earlier rounds**.

**Rescans stay with the developer.** Checkmarx One records whoever owns the API key as a scan's initiator, so on its own every verification rescan would look like the administrator's.
- **In CxMissionZero:** it remembers, for each rescan it starts, whose work it verifies (the initiator of the scan before it) and who asked. Reminders, reports, tracked reports and the Workbench go on naming that developer.
- **In Checkmarx One:** the rescan carries the tags `verifies-work-of` (the developer) and `requested-by` (you, or "automatic verification").

Who: anyone with **Manage tracked reports** (every role by default). Every rescan, result, switch and new round is in the audit log (type **Verification rescans**).

"Sent for remediation" counts AI Remediation sent from CxMissionZero. A fix made any other way (by hand, or remediated directly in Checkmarx One) counts as fixed when the rescan no longer finds it. **Rescan now** is always there for that.

---

## Credit Control

How the credit pool is being used, in three tabs. Everyone with **credits.view** sees it. The period, grouping and project, top right, apply to every tab.

| Part | Meaning |
| --- | --- |
| Filters | <ul><li>Period: last 7 / 30 / 90 days, this or last month, last 12 months, or a custom range.</li><li>Group by day, week or month.</li><li>One project, or all.</li></ul> |
| **Overview** → Credit pool | Size; used (triage / remediation); remaining; given to projects but not used; free to give. In red when Checkmarx One has fewer credits left for the tenant than the pool: spending and free to give then stop at what the tenant has left. |
| **Overview** → Credits used over time | Columns per day / week / month: triage at the base, remediation on top. Hover for numbers. **Show as a table** gives exact figures. |
| **By project** | Each project's triage and remediation credits in the period, with its share. |
| **Allocated vs used** | Per project, all time. |
| **Give credits** (Allocated vs used, for **credits.allocate**) | Type a project name (every Checkmarx One project is listed, not only those that already hold credits), enter AI Triage and AI Remediation credits, then **Give credits** and confirm. No findings need loading. The credits are extra credits, out of the credit pool, and the bar shows how many are free to give. **Give** on a row fills in that project. Each gift is in the audit log. To give exactly what findings need, use **Allocate for triage** or **Allocate for remediation** in the bar below. |
| **Allocate and use credits** (Allocated vs used, for **credits.allocate** or **triage.run**) | Works on the projects ticked in the table (none ticked: every project holding credits), at the ticked severities and engines (**SAST** and **SCA**, the two AI works on; untick one to spend on the other only), on the branch chosen on the Workbench (each project's primary branch unless **Every branch** is ticked there). Two rows, **AI Triage** and **AI Remediation**, each with its own **Allocate for triage** / **Allocate for remediation** (what those severities need, counted twice with Checkmarx One first, plus that row's **Extra credits each**) and **Triage with AI Assist now** / **Remediate with AI Assist now**, lined up. Their findings are read fresh from Checkmarx One, so nothing needs loading. A run button turns gold only when projects are ticked and their credits cover what the ticked severities need (shown on the row once those projects are loaded on the Workbench); with nothing ticked it still works, on every project holding credits, but is not gold. A project deleted from Checkmarx One since it was given credits is skipped and named, and marked in the table so its credits can be taken back. Each run is in the audit log as started from Credit Control. |
| **Take credits back** (Allocated vs used, for **credits.allocate**) | **Take back all unused credits** is the clean slate: every project's unused credits go back to the pool at once, with no findings loaded. **Take back** on a row does it for one project. Used credits stay counted, and each take-back is in the audit log. Developers cannot triage or remediate from their reports until credits are given again. |
| **Export CSV** | Everything above, for the chosen period. |
| **Pool & AI settings** | Opens Settings → AI & credit pool, to change the pool size and what reports may do (Admin). |

---

## Impact

What AI Triage and AI Remediation did for the backlog. Open it from **Prove → Impact**; anyone who may view tracked reports can. The full explanation of each figure is in [Impact](impact.md).

| Part | What it shows |
| --- | --- |
| **Period** | The last 30 or 90 days, the last 12 months, or everything since the first reading. |
| **Executive** tab | **Hours saved**, their value after the cost of credits, **Noise removed** (findings AI Triage showed not exploitable), **Fixed with AI** (with fixes by hand next to it), the **Security debt** change and when it reaches zero at this pace, and **Credits per finding closed**. Below: the security debt week by week (point at the chart for each week, or **Show as a table**), and **Time to fix, AI-assisted and by hand**, by severity. **How these are worked out** lists every assumption. |
| **Detail** tab | Every project: checked by AI, not exploitable, fixed with AI and by hand, median days to fix, credits, credits per finding closed, and what is open now. **Export CSV**. **Monthly summary by email**: whether it is on, and **Email last month's summary now**. |
| **Download the one-page summary** | The Executive figures and chart as one page, to print or save as PDF, in your currency. |
| **Currency →** | Opens Your profile → Currency: see the amounts in your own currency, at the exchange rate you give. The page then says which rate it used. |

A fix counts only once Checkmarx One no longer reports the finding, and rows that share one result count once. Readings start when this version is installed; the page says so when the period begins earlier.

---

## Audit page

Totals at the top, then three tabs: **Credit audit log**, **Integrity & reconcile**, **State & backups**.

**Credit audit log.** 25 entries a page, newest first: **Older** and **Newer** move between pages, and older entries are read from the server as you go. **Details** opens an entry in full. Every triage and remediation request (charged, refused, failed or not charged), allocation, settings change, report issued, backup and sign-in.
- Each entry records who, when, from where, and which findings, with the balance before and after.
- **Filters:**
  - from / to;
  - type;
  - outcome;
  - project;
  - free-text search (user, email, IP, finding id, error).
- **Export CSV** or **Export JSON Lines**. Each export starts with a notice line: it is supporting information only.
- **Verify integrity** recomputes the hash chain: any edited, removed or reordered entry is reported by number.
- **Reconcile** checks that a month's charged credits in the audit log match the credit ledger.
- **Supporting information only.** The audit log and its exports help your own calculation of credits. Checkmarx's own records are authoritative, so do not use or share them with Checkmarx as evidence in any claim, dispute or credit request ([Terms of use](#terms-of-use)).

**State folder & backups.** Everything lives in one folder (`/data` in the container), and one backup file rebuilds the server.

| Action | Who | What |
| --- | --- | --- |
| **Download backup** | Admin | One `.mzbackup` file. It holds the keys, the mail password and the users, so keep it safe. |
| **Back up to folder now** | Admin / Analyst | Writes a backup to the backup folder. Scheduled backups run every 24 hours by default. |
| **Restore from backup…** | Admin | Checks the file (asks for the passphrase if it is encrypted), shows what it holds, then **Restore at next restart**: the state is replaced when the server next starts. |

See [audit-and-backup.md](audit-and-backup.md) for encrypted backups and moving to a new server.

---

## People & roles

Identity and access management, in three tabs.

**People.** Search by name, email or Checkmarx One identity, and filter by role or status (active, locked, disabled, must set password). 20 people a page.

| Action | What it does |
| --- | --- |
| **Add person** | Fields: <ul><li>email and name;</li><li>role;</li><li>a temporary password (they choose their own at first sign-in);</li><li>optionally their **Checkmarx One identities** (usernames or client ids allowed to sign in with an API key).</li></ul> |
| **Edit profile** | Their profile, as on Settings → Your profile: name, language, time zone, programming languages, Impact figures, look (the organisation's or one of the nine, theme, accent) and picture, and their **sign-in email** (**Change email**, after a confirmation). A new email ends any password reset link sent to the old one, and both addresses are told by email. Every change is in the audit log. For people whose permissions you hold all of, never your own (that is Your profile). **Back to People & roles** returns. |
| Role (per person) | Change it. It applies on their next click. |
| **Set password** | A new temporary password. |
| **Disable / Enable** | Disabling ends their sessions at once. |
| **Remove** | Deletes the account. |
| **Tenants** (Super Admin, several tenants) | Choose the Checkmarx One tenants the person works in. Under each name, the tenants they work in now. |

**Sign-in** (people who may manage people): who may reset a forgotten password by email, for the whole server (a Super Admin's choice when there are several tenants).
- **Everyone with a password** (the default), **Everyone except Admins** (people who may manage people or tenants then get a temporary password from another Admin, or with `node scripts/reset-admin.mjs`), or **Nobody**.
- Under it, what is still missing for **Forgot your password?** to show: the email server set up and tested, and the server's https address (Settings → Server address).
- Accounts that sign in with a Checkmarx One key only, and disabled accounts, are never sent a link.

**Roles & permissions** is a matrix of permissions against roles.
- **Find a permission** narrows the matrix; click a group name to fold it, or **Collapse all**. Each group row shows how many of its permissions each role has.
- Tick or untick boxes, then **Save role changes** (or **Discard**). Unsaved changes are kept if you go to another page and come back.
- **New role** builds your own role.
- **Rename** (under a role's name) changes its name and description: its people keep it and its permissions stay as they are. Security Analyst and User can be renamed too; Admin keeps its name. Names are unique.
- **Duplicate** makes a new role with the same permissions (less any you do not hold yourself), named "… (copy)" until you rename it. Nobody has it until you give it to someone.
- **Show only the differences** hides the permissions every role holds alike and colours the rest (green: holds it, red: does not). Tick **Compare** for two or more roles to see just those side by side; "These roles hold the same permissions" when there is no difference.
- Renames, new roles and permission changes are each in the audit log (*Renamed role "User" to "Developers"*).
- The Admin role is fixed. Permissions marked **Admin** are Admin-only by default.
- You can never grant a permission you do not have yourself, or touch an Admin's account unless you are an Admin.
- You see only the people and roles within your own permissions. A Security Analyst does not see the Admins or the Admin role.
- There is always at least one active Admin.

---

## Labs: Code authors

Early features, in their own **Labs** section at the bottom of the menu (it was the **Beta** item under Act): check what they find before relying on them. A feature an Admin made final ([Settings → Beta features](#beta-features-admin)) loses its Beta label. Details are in [beta-features.md](beta-features.md). Three tabs: **Code authors**, **Match usernames**, **Source-code hosts** (the connections: GitHub, GitLab, Azure DevOps, Bitbucket).
- **Email the authors of vulnerable code.** Finds who last changed the vulnerable line, and emails them.
  - **Where the code is:** GitHub, GitLab, Azure DevOps or Bitbucket.
  - **Through the host's API** where it has one: GitHub, GitLab and Bitbucket Data Center, one request per file.
  - **Otherwise `git blame`** on a clone, made with that host's own token: Azure DevOps, Bitbucket Cloud, or any host.
  - **The Commit column** shows which host and way it used, and the pull or merge request the commit came in through (GitHub and GitLab), with who opened it and who approved it.
  - **Code owners** of the file, from the repository's `CODEOWNERS`, are shown under **Where**. Both are for information: who is emailed is still the author.
  - **How sure:** each answer is **Sure**, **Check** or **Unsure**, with the reason. Only Sure answers are ticked for sending; scheduled reminders only email Sure ones. Whitespace changes, moved code, `.git-blame-ignore-revs` and bot commits are looked past. Details: [beta-features.md](beta-features.md).
- **Match usernames to email addresses.**
  - **Pick the host:** GitHub, GitLab, Azure DevOps or Bitbucket.
  - **Load developers:** offers the usernames from projects on that host.
  - **Compare methods:** runs that host's methods side by side, with coverage, requests, time and a recommendation.
  - **Use selected matches:** saves the ones you tick as initiator overrides.

  | Host | Methods, cheapest first |
  | --- | --- |
  | GitHub | Local git history, GraphQL batch, commit author, public profile |
  | GitLab | Local git history (also GitLab's noreply addresses), GraphQL batch (100 a request), user profile, commits by their name |
  | Azure DevOps | Local git history, organisation directory (everyone in a few requests), identity search, commit author |
  | Bitbucket Cloud | Local git history, commit authors (each user tied to the address on their commits), workspace members joined to local history |
  | Bitbucket Data Center | Local git history, commit authors, user directory (1000 a request), user search |
- **GitHub connection:**
  - A token, the API URL (GitHub Enterprise too), the organisation and repositories.
  - The token can also come from the .env file (`GITHUB_TOKEN`, `GITHUB_API_URL`, `GITHUB_ORG`), uploaded on Settings or used at start-up.
  - Its logo on the **Git** indicator, top right, is ringed green when it works.
- **GitLab, Azure DevOps and Bitbucket:** one box each, with a token, the address (self-hosted too), and the projects or repositories to read. **Test** says whether the token is accepted, and if not, what to change.
  - **Azure DevOps organisation:** its name (`acme`), `https://dev.azure.com/acme`, a project page in it, or `https://acme.visualstudio.com` all work. The token must be created for that organisation; one for another organisation, expired or revoked shows as *not accepted … answered as Anonymous*.
  - **Tokens:** stored like the SMTP password, never shown again, and only ever sent to their own host. An Azure DevOps token goes only to its own organisation.
  - **Changing an address to another host** clears that host's saved token (GitHub's too): enter the token again with the new address. A token from the .env file is only used for the host the file names (or the public service when it names none).
  - **Or from the .env file:**
    - `GITLAB_TOKEN`, `GITLAB_URL`, `GITLAB_GROUP`;
    - `AZURE_DEVOPS_TOKEN`, `AZURE_DEVOPS_ORG_URL`;
    - `BITBUCKET_TOKEN`, `BITBUCKET_USERNAME`, `BITBUCKET_WORKSPACE`, `BITBUCKET_URL`.
  - **A second (third …) connection to a host:** the same variables numbered `_2` to `_9` (`GITLAB_TOKEN_2`, `GITLAB_URL_2` …). **More connections to the same host**, at the bottom of the tab, lists them with their state.

---

## Labs: Fusion results

Its own page under **Labs**: only what the AI engine reported (from MZ-01.00.95), for each project whose latest scan ran it, a **Fusion** scan (gold) or a **LAST** scan (pink), with its own line, apart from the Workbench. The traditional engines' results (SAST, SCA and the others) are never on it. Projects whose latest scan did not run the AI engine, or whose AI engine reported nothing (LAST on by default, no AI results, no credits), are left out, and the line under the title says how many. Beta: shown to roles holding **Beta features**, and to everyone who loads findings once an Admin makes it final ([Settings → Beta features](#beta-features-admin)).
- **Its own line.** **Applications** and **Projects** (names separated by commas, `*` and `?` as wildcards; empty is every one), then **Load results**. **Read Fusion now** reads them again. Nothing is started: it only reads what the AI engine already found.
- **Fusion and LAST.** A scan that ran the AI engine with Fusion on (in its settings) is a **Fusion** scan; one that ran it with Fusion off (LLM-based scanning alone, for a language such as ABAP that only the AI engine covers) is a **LAST** scan (language-agnostic static testing). Each project goes by its latest scan's kind (from MZ-01.00.99): a Fusion scan's results are all Fusion's, a LAST scan's all LAST's, so **LAST** ticked alone shows LAST scans only; what the AI engine found in a language only it covers still shows, as the **LAST** languages. Tick **Fusion**, **LAST** or both under **Show**: everything on the page, both downloads and the credits follow the ticks. The number beside each tick is how many projects' latest scans were of that kind.
- **One line of figures** under **Load results** (from MZ-01.00.98): the projects shown, how many latest scans were **Fusion** (gold) and **LAST** (pink) and how many were **left out** (hover it for why), the AI engine's results with a chip per severity, the credits the latest scans used, and the credits the tenant has left. Only what the AI engine itself found is counted: never how many the traditional engine had also found.
- **Details**, at the end of that line, opens three blocks (the page remembers it in this browser): **Projects**: Fusion, LAST and without AI, how many of the line's projects had a Fusion scan and a LAST scan in the last year, and the tenant's settings (Fusion, LLM-based scanning, its model). **AI results**: how many the AI engine found in the latest scans, with the models used and the lines of code and files. **Credits**: what the tenant has left in Checkmarx One, what it used, what projects were given here (never more than it has left), and whether Fusion scans are charged on the tenant.
- **Status and state.** Chips for Risk Hub's **New**, **Recurrent** and **Fixed**, and for its states: **To verify** (each new risk's), **Confirmed**, **Proposed not exploitable**, **Not exploitable** and **Urgent**, each with how many; **Only AI-triaged** keeps the risks whose state AI Triage set. A chip narrows the projects, the figures, the side panel and both downloads.
- **The projects:** one row per project, gold for a Fusion scan and pink for a LAST one: its **Scan**, its **Languages** (**SAST**: those its SAST engine scanned; **LAST**: those of what the AI engine found in a language only it covers), the **Model** its latest scan ran with (hover it for where that was set: **set on this scan**, **project setting**, **tenant setting**, or **set by Checkmarx One** when nobody chose one), **LOC**, its **AI results** by severity, the **AI share of SAST** (the AI engine's results as a share of all its latest scan's SAST results: 20 of 100 is 20%), **To verify**, **Confirmed**, **Credits, latest scan**: what its latest scan used (0 for a LAST scan or when its scan said Fusion credits are disabled; otherwise ≈ an estimate, the Fusion credits it used over the last year per Fusion scan, since Checkmarx One does not say one scan's own), and its **Latest scan**. Sort and filter on any heading, as on the Workbench; **Columns** hides, shows and reorders them (kept in this browser); search, pick a severity or a model. **Export CSV** and **HTML report** give what is shown, in your Fusion and LAST colours.
- **A project's vulnerabilities.** Click a project: a side panel opens, edged in its scan's colour, with its model and where it was set, how many results the AI engine found, its lines of code, files and SAST engine version, the credits its latest scan used, and whether its Fusion scan was charged credits; then each of the AI engine's results, with its **description** first (what it is and why, as Checkmarx One words it), then: severity, scanner, **AI-found** and **AI-triaged** where they apply, Fusion or LAST, status and state, language, CWE, where it is (and, for what the AI engine found, source and sink: file, line and variable), first and last found, its id, and **Open this result in Checkmarx One**. Filter by severity, New, Recurrent or Fixed, and by state; the fixed ones are listed last. **Open in Checkmarx One**, **Export CSV** and **HTML report** are for that project. **Esc** or **✕** closes it.
- **Acting on them (Admins).** In the side panel, **AI Triage** and **AI Remediation** for that project's results: **Allocate for** the next severities, then **Triage …** or **Remediate …**, which turns gold once the credits are there. **Allocate credits**, **AI Triage** and **AI Remediation** in the bar above the table do the same for every project shown. Only the results of the engines ticked count; no Workbench fetch is needed. Remediation only ever takes confirmed results.
- **No results:** **Read Fusion again** (Admins) reads them once more.
- **Troubleshoot Fusion** (bottom of the page; Admins who manage the Checkmarx One integration): test which addresses your Checkmarx One serves Fusion at (one per line, `{appId}` filled in), see each answer, and pin the one that works with **Use for Fusion results** or **Use for Fusion scan status**: the page reads Fusion from there from then on. **Debug mode** logs every Fusion call in full (the access token never in it) to copy or download and share with support.
- **On the Workbench:** each project whose latest scan was a Fusion scan is gold and a LAST scan pink, with a legend under the table and a **Scan type** filter beside the others. The **Fusion** column (under **Columns**) shows each project's results (Fusion, LAST or both, as ticked), filled in when Fusion has been read.
- **When Fusion cannot be read** the page says why: no Fusion on the tenant, or an API key whose role in Checkmarx One may not read Fusion results; under it, each address asked and what Checkmarx One answered.

## Labs: FAE Flush

Findings Analysis (FAE) only cuts the noise in results found after it is turned on: the backlog stays. **FAE Flush** applies it to the backlog once, for every project of the tenant at once (a few scans at a time), and leaves every project as it is: its history, triage, automations and integrations stay. Held back until an **activation code** turns it on ([activation codes](activation-codes.md)): before that it is not in the menu, nor under Settings → Beta features. Then Beta: shown to roles holding **Beta features**; starting it also needs the **Checkmarx One integration** permission, since it creates, scans and deletes projects with the server's own key. Once an Admin makes it final ([Settings → Beta features](#beta-features-admin)) it is the first page under **Act** (FAE Flush, Workbench, Automation); the Workbench stays the home page.

For each project:
1. **Copy the code**: the exact code of its latest scan, as Checkmarx One keeps it, downloaded and uploaded again (a temporary file on this server, deleted straight after); if that fails, or the code is no longer kept, its repository at the latest scan's commit.
2. **Scan it on `<name>_FAE`**: a new project with the project's own SAST settings and Findings Analysis on, SAST only. Only the settings the project sets itself, with a value, are copied, in one call; if Checkmarx One refuses, each is tried alone and the timeline names those refused. If it refuses one that changes the results (the preset, language mode, extended analysis, the default configuration, scan mode or light queries), the project stops and asks: **Continue** without it, **Skip** or **Retry**.
3. **Compare**: each SAST result of the project still **To verify** against the FAE scan's results (by similarity id). Results a person or AI Triage already set are never touched, and nor are those the AI engine found (Fusion and LAST): FAE does not judge them, so they are left out and counted apart.
4. **Mark**: those the FAE scan no longer reports become **Proposed not exploitable** in the original project (or **Not exploitable**, if an Admin chose it), with a comment naming the FAE scan. Checkmarx One keeps a result's state by its similarity id, so one mark covers every result sharing it (the same flow reached twice, say), on every branch of the project: FAE Flush counts results as Checkmarx One shows them, and says how many distinct findings they are when the two differ. On a tenant that groups similar results by **Attack Vector ID** (Checkmarx One → Account settings → Grouping similar results), Checkmarx One refuses marks by similarity id; FAE Flush then reads each result's attack vector id and marks by it instead, by itself, and Undo does the same. A result Checkmarx One still refuses is left To verify and listed as **not marked**; if none can be marked, the project stops and asks, with what to change.
5. **Revalidate**: both are read again: every result marked is marked, and still not reported.
6. **Remove `_FAE`**: the copy is deleted once checked, or kept, as you chose when you started.

It has two tabs, **Run** and **Value**.

**Run** asks three things, on one line (hover a choice's label for what it means):
- **Projects**: **Check the projects** reads every project (its latest scan, whether SAST ran, whether Checkmarx One still keeps its code or knows its repository, its lines of code and results To verify) and lists them as the Workbench does (from MZ-01.00.98): sort and filter on any heading, **Search** by name or branch (several, separated by commas), and **Show** **All**, **Can be flushed**, **Ticked**, **Not ticked**, **Left out** or **Skipped last run**. The tick box in the heading ticks or unticks every project shown; **Untick all** clears the rest. The line says how many are ticked, their results To verify, and roughly how long they take at the **Scans at once** chosen. A hundred rows show at a time, with **Show more**. Those left out say why.
- **What to do**: **Mark false positives**, or **Only show what it would mark**: it scans and compares, and marks nothing; the run then ends **Ready to mark**, with **Mark now**, which marks what it found (and revalidates it), keeping the `_FAE` projects until then.
- **Mark them as** (Admins only, shown only to them): **Proposed not exploitable** (the default: a person confirms each later), or **Not exploitable**, final at once: those results leave every count and dashboard without anyone confirming them, so the choice turns red and the start dialog says so again. Undo puts them back to To verify either way. Another role that may run FAE Flush always marks Proposed not exploitable, and cannot **Mark anyway** or **Mark now** on a run an Admin started Not exploitable.
- **Stop and ask me if**: **Rarely**, **Something looks off** (the default) or **Often**: how readily a project stops before marking (below).
- **Start FAE Flush** asks first what to do with each `_FAE` project once its project is checked: **Delete it**, or **Keep it** to look at. It runs on the server: closing the page does not stop it, and after a restart it carries on where it was.
- **It asks you about exceptions.** A project stops before marking anything, and the rest carry on, when the FAE scan did not complete, counted more or fewer lines of code than the project's latest scan (it may not be the same code), would mark nearly every result To verify, or reported many results the project does not have; also when revalidation does not match. A project with nothing to mark never asks (from MZ-01.00.99): it goes on and marks none. With **Something looks off**: lines of code 2% apart, more than 90% of 20 or more results, more than a quarter of its results, a scan over 12 hours; **Rarely**: 10%, 98% of 50 or more, half, 24 hours; **Often**: 1%, 75% of 10 or more, a tenth, 6 hours. Each one shows why, with **Mark … anyway** (or **Accept** after revalidation), **Retry** and **Skip**.
- **The result.** The tiles and the line under **Finished** say how many false positives were marked **Proposed not exploitable**, of how many results To verify, how many were revalidated and how many are still reported (left To verify); the table gives each project's figures. **Export CSV** downloads them.
- **The run's table** works the same way (**Columns** on both tables hides, shows and reorders them, kept in this browser): chips for **All**, **At work**, **Asks you**, **Ready to mark**, **Done**, **Skipped**, **Undone** and **Left out**, a search, sorting and filters. A project that stops to ask shows its question and its answers in its own row.
- **Act on the projects ticked**: a bar over the table offers what fits them, with how many each covers: **Mark anyway** and **Carry on without them** (from MZ-01.00.99: one answer for every project ticked that asks it), **Retry**, **Skip**, **Bring back** (a skipped project goes back in line, with its latest scan read again and a fresh `_FAE` copy if the old one was removed), **Mark now**, **Delete _FAE projects** and **Undo marks**. Each one that changes results asks first. A retried `_FAE` project that was deleted in Checkmarx One meanwhile is made again; an answer given after the run finished puts it back to work.
- **Pause** stops it starting anything new (scans under way finish in Checkmarx One and are picked up on **Resume**). **Undo marks** puts every result it marked (in the projects ticked, or all) back to To verify, apart from any someone changed since. **Delete _FAE projects of earlier runs** removes, in one click, every `_FAE` project kept from earlier runs, any day after.
- **Audited.** The start (and who started it), each scan, each project's marks, every answer to an exception, Undo and every deletion are in the audit log.
- **Each project's timeline.** Click a project in the run's table: every step it went through, where its code came from (Checkmarx One's own copy, download and upload, or the repository), each attempt and its error.
- `_FAE` projects are tagged `mz-fae-flush` and never appear on the Workbench, in reminders or in reports.

**Troubleshoot** (at the bottom of Run, for whoever manages the Checkmarx One integration; nothing in it changes your projects):
- **Test one project** runs every step without creating or changing anything, and says what worked: its latest scan and SAST, whether its code is kept, its stored copy (the signed download address, how long it is valid, and whether it answers, reading one byte, and whether with the access token or without), whether the upload address takes code (an empty zip, which no project or scan uses), its repository and commit, its own SAST settings, the Findings Analysis setting, and its results To verify.
- **Debug log**: **On** records every FAE Flush call to Checkmarx One (address, request, answer, status and time; never the access token, and signed addresses' signatures hidden), the last 500 until **Clear** or a restart; **Download** saves it to send to support.
- **Where the code comes from**: **Automatic** (download and upload, then the repository), or one of them only. Both the stored copy and the upload address are reached with the access token on Checkmarx One's own host, as a browser does. When Checkmarx One refuses a call, the project's timeline and its question give Checkmarx One's own reason.
- **The projects to test** are those checked with **Check the projects**; after a server restart, until they are checked again, those of the current run.
- **A standalone probe** for a tenant where FAE Flush fails: `scripts/fae-probe.mjs` tries every call FAE Flush makes on one project, each way it can be made, and writes a report to send to support (no key, token, signature or email address in it). Save it in a folder, then in Windows cmd, from that folder: `set CX_API_KEY=<the API key>` and `podman run --rm -e CX_API_KEY -v "%CD%:/probe" ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest node /probe/fae-probe.mjs --project "<project>"` (read-only), adding `--write --wait 15` to try a throwaway project's upload and scans too (it is deleted at the end). `--compare` reads the project's `_FAE` scan and lists what FAE Flush would mark, the AI engine's results left out; `--mark ne --limit 1` (or `pne`) marks that many of them, by similarity id, or by attack vector id where the tenant groups by it, to show the mark Checkmarx One takes.

**Value** keeps every false positive FAE Flush marked, after each run (kept in `fae-flush-history.json` with the state folder). It leads with the **money saved**, in the currency set under **Settings → AI & credit pool → Impact**: the manual triage time saved (each distinct finding once, at the minutes per triage and hourly cost set there) plus the AI Triage credits not needed (one per result, at the price of one credit set there); with no hourly cost or credit price set, it says which to add, with a link. Then how many results are still marked (those undone taken out), the share of the results To verify they were, the hours, the credits, a line on results against distinct findings and, when an Admin marked Not exploitable, how many of each state; by severity, by run and by project, each with its money saved. **Export CSV** downloads it, with the figures used.

## Labs: Status board

Every project the Workbench loaded, at a glance: its last scan and its results. Held back until an **activation code** turns it on ([activation codes](activation-codes.md)); then for everyone who may load findings. It shows what the Workbench loaded: load findings there first (it says so when nothing is loaded).

- **The figures line**: projects, scanned in the last 30 days, failed scans in the last 7 days, not scanned for 30+ days, open critical + high.
- **Bar shows**: **Results** (open results by severity from the left, numbers inside, the total and critical + high at the end; gold outline for a Fusion scan, pink for LAST) or **Scan health** (days since the latest scan, up to 60: green under 7, amber under 30, red after, striped when a newer scan failed; the engines it ran, a failed one in red).
- **Under each name**: application and languages, when the latest scan ran and on which branch, and, when a newer scan failed, when, on which branch and why ("The results shown are from the scan before").
- **Group by** application, group or scan health; search (several words, separated by commas); sort and filter from each heading; **Columns** (tick to show, arrows to move: Critical, High, Medium, Low, Past SLA, Engines, Latest scan, Application, Branch…).
- **Click a row** for its last five scans: status, engines, duration, lines of code, results and the change from the scan before, each linked to Checkmarx One.
- **Export CSV** and **HTML report**: the rows and columns the table shows.

## Labs: Consolidated view

Every connected tenant on one page, read only, for the people an Admin ticks (**People & roles → May see the consolidated view (all connected tenants)**; no role holds it, not even Admin). Held back until its own activation code turns it on. It is **Consolidated** in the menu and the first entry of the tenant switcher.

- **Overview**: a card per tenant (its colour at the top): projects, overdue, open results, AI credits used and available, Fusion and LAST, Govern's budgets, when it last loaded findings, and its health (**Healthy**, **Last fetch failed**, **Not fetched for a day**, or **Not loaded — open it once** for a tenant nobody has loaded findings in since the server started). Then the tenants side by side.
- **Projects**, **Fusion**, **Credits**, **Status board**: the same across tenants, each row naming its tenant; a tenant filter above every table; search, sort, filter, Columns, CSV and HTML report.
- **Open** goes into the tenant, as the switcher does. Nothing here changes a tenant or reads Checkmarx One, and each visit is written to each tenant's audit log.

## Labs: Govern

Budgets of AI credits, and what happens at the limit: the credits command center for security champions. Held back until an **activation code** turns it on ([activation codes](activation-codes.md)); then for the roles holding its own permissions, in Beta too. Once an Admin makes it final ([Settings → Beta features](#beta-features-admin)) it has its own menu group, **Govern**, between Prove and Plan. Everything about it is in [Govern](govern.md).

- **Who**: **Admin** everything; **Security Champion** (a built-in role) budgets, Enforce, requests, restores and attribution, not Govern's settings; **Security Analyst** sees it all and asks for credits; **User** sees their own AI credits and asks for more. Each is a permission on People & roles (group *Govern*).
- **The top**: the last cycle and the next, **Run now**, and the figures line: tenant credits, in the pool, assigned to budgets, used this period, near limit, restricted.
- **Overview**: the credit pool as one bar, credits over time by action, the top consumers by user, project, group or application, and banners for what Checkmarx One does not report, a poll that did not finish and credits nobody counts.
- **Budgets**: a budget per user, group, project or application, monthly, quarterly, custom or lifetime, with a warning share. **Monitor** (the default) warns; **Enforce** also takes AI away at the limit. Statuses, exemptions, bulk changes, and **Export CSV** / **Import CSV** (checked first, then applied all or nothing).
- **Requests**: anyone asks for credits for themselves or a project, group or application; Security Champions and Admins approve (all or part, until a date or for good), deny or ask a question, and the requester is emailed.
- **Restrictions & alerts**: what Enforce took (a person's AI roles, a project's Auto Triage and PR remediation), **Partial** when Checkmarx One still gives an AI role through a group, **Restore** with a grace; and every alert, with how it was delivered by email and webhook.
- **Attribution**: names Checkmarx One reports that match nobody, or more than one: map, reject a match for good, or ignore a shared account.
- **Settings** (Admins): the cycle, the lookback window, the AI roles Enforce removes, AI-only groups, email and a signed webhook, and a permission check of the server's Checkmarx One key.
- **Safe by default**: nothing changes in Checkmarx One unless a budget is in Enforce; every change is written ahead, checked by reading it again, reversible, and in the audit log. CxMissionZero's own AI Triage and Remediation stop at once for a project or person whose enforced budget is used up.

## Logs page

Three tabs: **Activity in this browser**, **User activity** (for anyone who may see the audit log) and **Troubleshooting log**.

**User activity.** What each person did here, newest first:
- **When**, **Who** (name, email and role) and **From** (the IP address).
- **Page or action**: each page and tab they opened, and each thing they did — signing in (refused sign-ins too) and out, changing settings, people, roles or their profile, fetching findings, checking credit needs, allocating credits, running AI Triage or Remediation, making, emailing or downloading reports and the PDF summary, exporting logs, backups, updates and more.
- **Details**: the item it was about and the **names** of the fields a change touched. What was typed is never kept: no passwords, keys or text.
- **Result**: Done (with how long it took), Failed or Refused.

Narrow it by **Person**, **Kind** (actions, pages visited, sign-ins, other events), **From**/**To** dates and **Search**; **Export CSV** downloads everything kept. It is kept for a year in `activity.jsonl` in the tenant's state folder (so it is in backups), and each entry is written as it was recorded, in English, as the audit log is.

**Troubleshooting log.** **Download troubleshooting log** gives one file covering:
- which features are used and how fast;
- where errors happen;
- where numbers disagree;
- recommended fixes.

Send it to whoever maintains CxMissionZero when something goes wrong. **It captures no sensitive information:** no names, email addresses, passwords, keys, tokens, hosts, URLs, findings or code.

**Activity log.** What this browser asked the server, newest first, 100 lines a page. By default it shows each answer (**Success** and **Errors**, with counts); tick **Sent** to see each request as it goes out too. Searchable. **Export** saves it; **Clear** empties it.

---

## Cx Credits Calculator

**Cx Credits Calculator** (menu group **Plan**; on a phone, under **More**) works out the credits a customer needs, from their own data, and makes a report of it. It is for Admins, and for any role an Admin gives the **Cx Credits Calculator** permission to. Each **customer** is saved on this server as you go: **New customer** starts one, named after your organisation (the name given with the terms) while no customer has it, **Customer** switches between them, **Delete customer** removes one (its reports stay). The first time, the calculator starts that customer by itself.

**One click.** **Generate projection report** reads Checkmarx One first when nothing is read yet, then makes the report with every default in place. **Email the report** sends it, in the page's language, to up to 10 addresses (through Settings → Email server). Once it is made, **Download PDF summary** gives the pages to present: triage & remediation with the backlog forecast, Checkmarx Fusion, the total credits required, and the trend with how each number is worked out, followed by an appendix with every calculation. **Start again** clears every choice made for the customer and reads Checkmarx One again (the Fusion models stay).

**Read from Checkmarx One** (at the top) fills both tabs from the tenant this server is connected to: every project with its lines of code, criticality, applications, groups, who last scanned it and its completed scans in the last year (counted project by project), and the backlog and fixes week by week over the last 52 weeks, from each scan's results by severity. Only each project's primary branch is read (as set in Checkmarx One, else main, else master), so a finding scanned on several branches is counted once; tick **Every branch** beside the button, then read, to count every branch's scans (also what Fusion is charged for when feature branches are scanned with it). The projection report says which it counted. It runs in the background with a progress bar; a customer with nothing read yet reads by itself when it is opened.

**Applications** and **Projects**, at the top, count only some projects, for both parts: type a name and pick it (Enter, or **Apply**, adds every name that contains the text); each becomes a chip. These applications' projects count, plus the projects picked. **More filters** narrows further by **Groups**, **Project names** (wildcards: `payments-*`, `*-api`), **Last scanned by**, how often they are scanned, and criticality. **Leave out projects with no lines of code** (ticked by default) and **Leave out projects with no open findings** (of the engines counted; off by default) take out the projects with nothing to analyse, for both parts; the line at the top says how many each took out, and so does the projection report. The backlog of just those projects is added up from the last read, without reading Checkmarx One again.

**Triage & remediation.** The line at the top says where the figures came from and when. For a prospect whose tenant this server is not connected to, **Use the two Checkmarx One exports instead** takes their **Total Vulnerabilities by Severity** and **Fixed Vulnerabilities by Severity** exports (or **Load sample data**). **What the projection counts** shows, over the **projection period** (12 months unless chosen at the top): every open finding today, **+** the findings still to come at the pace of the last 3 months, 2% fewer each month as teams adopt AI, in the same share per severity as the backlog you chose (none for a severity set to none), **+** 5% more found by Fusion when Fusion is in the projection, **−** 10% fewer false positives reported with FAE, **=** the findings to triage, and the credits (backlog today + ahead). Change the four assumptions under it, and the trend period (3, 6, 9 or 12 months). **Engines counted** (read from Checkmarx One) chooses whose findings count: **SAST** and **SCA** by default, since AI Triage and Remediation credits are spent on those; tick IaC, Containers, API Security or Secrets to add theirs. The projection report says which engines it counted. The two exports count every engine together, so with them the boxes are greyed out. **Customize per severity**, right under it, sets how many to triage, the false positives expected, and the credits per triage and per remediation (1 and 3 to start with), then **Apply**. Each severity's box ends with what it comes to (to triage, to remediate, credits). **Debt added against fixes** then says in one sentence whether the backlog grows or shrinks each month and by how much, with the two side by side on a timeline over the last 12 months and a short table by severity (open now, added a month, fixed a month, change a month). The page also shows the backlog forecast and a small chart per severity. **Customer view** hides the editing controls for showing the customer.

**How each number is worked out.** A **?** beside each figure (backlog today, still to come, more found by Fusion, kept away by FAE, to triage, credits, Fusion credits and the total) opens a small window with the calculation, step by step, with the real figures in. The projection report states its assumptions first (the trend period and projection period among them) and ends with a closed **How each number is calculated** section that opens on a click; the PDF summary's fourth slide is the impact (what the credits give back), and its fifth, **Appendix – Calculations**, opens its appendix: a slide on the trend and the calculations, then every calculation, step by step (eight or nine slides with the usual data). All three come from one source, so they always agree.

**Fusion.** The projects in the scope, with their lines of code, criticality and how often each was scanned in the last year, the most often scanned first, 100 at a time. Each project is rounded up to whole 10K LOC units on its own, and a scan costs its model's credits per 10K LOC. **Fusion models** starts with the models Checkmarx One offers a Fusion scan (opus-4.7, haiku-4.5, opus-5.0, opus-5.5, mythos-5.1); reading the tenant lists the ones its **LLM Model** setting offers, with the credits it has left. Type each model's credits per 10K LOC (no Checkmarx One API says them), or add a model by hand. Set a **default** number of scans and model, then numbers for each **scan frequency** (they start at the scans each frequency runs today; **Back to the suggested numbers** puts them back) and each **criticality**, and choose which wins when both set one. A number or model typed on a project wins over everything. For a customer not taking Fusion, untick **Include Fusion projection** at the top, beside **Read from Checkmarx One**: Fusion is then left out of the credits (**Left out**), the findings it adds (Triage & remediation's **More found by Fusion** shows 0% and cannot be changed), Impact and the report, and its settings are kept for when it is ticked again, with the % you had. Click a column's heading (**Project**, **Criticality**, **Scanned today**, **Lines of code**, **10K units**, **Fusion scans**, **Model** or **Credits**) to sort the table by it, and again for the other way: names start A to Z, numbers largest first, and a value shown as — always comes last. The choice is remembered in this browser. **Download CSV** downloads the table, in the same order.

**Impact.** Held back while it matures: the tab appears only once an activation code turns it on (Settings → Activation codes); until then the projection report and the PDF summary have no impact section, and the standalone calculator never has it. What the triage & remediation credits give back: **Hours given back** (findings triaged × the minutes to triage one by hand, plus true positives fixed × the minutes to fix one by hand less the minutes to review the AI fix), the same as developer-years, **Value of that time** (hours × what a developer's hour costs), **What the credits cost** (credits × a credit's price), the **Return** ((value − cost) ÷ cost) and the months until the credits are paid back, and the **False positives cleared** that never reach a developer, with a table by severity and every step under **How each number is calculated**. Below, **Fusion**: the expert review Fusion's frontier models replace (lines read ÷ lines an expert reviews in an hour), how often every line is read, the cost per 10K lines read against an expert's, the reviewers it would take to keep pace, how long a team takes to read the code once, flaws found earlier and fixed cheaper, and the breach cost avoided (an expected cost, counted in the return only when ticked). At the top, **All the credits give back** puts both together against what every credit costs. Every assumption starts from Settings → Impact (or a stated default) and is kept with each customer. The projection report has the same section, and the PDF summary's fourth slide shows the return on all the credits.

**Credits required.** The strip at the top adds both tabs together. Type an **Extra credits (%)** to add a margin on top; **Total credits required** includes it. **Bundles** is the total ÷ **Credits per bundle** (10,000), rounded up to a whole bundle.

**Projection reports.** **Generate projection report** downloads one HTML report, named after the customer and the time (for example `Globex_Cx-credits-projection_2026-10-09_2047.html`), in your organisation's name, and keeps it on the **Projection reports** tab to download again. The report says the answer first (the total credits and bundles, and what they are for), then that the figures were read live from Checkmarx One and when, how the number was reached, the assumptions, and last every figure. It is in the language the page is in, has **Auto**, **Light** and **Dark** themes at the top, and keeps long names inside its tables. **Download PDF summary** appears once the report is made: three 16:9 pages to present, in the page's language. Page 1 is triage & remediation: the backlog today, the findings still to come, to triage, the credits, and the backlog trend and forecast, with debt added against fixes in one line. Page 2 is Checkmarx Fusion: projects, lines of code, scans and credits, and the credits by how often projects are scanned. Page 3 is the total credits required, in bundles, what they are for, and the assumptions. It is drawn in your browser: nothing is sent anywhere. **PDF** beside each saved report on the **Projection reports** tab makes the same summary for that report.

**On its own: Download standalone calculator.** The button at the top right of the page downloads `cx-credits-calculator.mjs`: this calculator on its own, blank, to give to anyone (a partner, a customer, a colleague without access here), reading Checkmarx One with their own API key.
- **Run it** with Node.js 20 or later: `node cx-credits-calculator.mjs`. The calculator opens in the browser.
- **Paste a Checkmarx One API key** at the top and **Connect**; **Read from Checkmarx One** then reads the tenant as here. **Advanced** sets the Checkmarx One address, IAM address or tenant when the key does not say them.
- **Only on that computer:** the page is served on 127.0.0.1 and answers only itself; the key stays in the launcher's memory until it stops, and is never saved, logged or put in a report. Behind TLS inspection, set `NODE_EXTRA_CA_CERTS` to your company's root certificate first.
- **HTML only**, beside the button, downloads `cx-credits-calculator.html` instead: one file that opens in any browser with no Node.js, working from the two Checkmarx One exports (Analytics → **Total Vulnerabilities by Severity** and **Fixed Vulnerabilities by Severity**) or **Load sample data**.
- **Everything the calculator has:** customers, triage & remediation and its plan per severity, Fusion (with **Include Fusion projection**), Impact, the scope, **Generate projection report** and **Download PDF summary**, made by the same code as here, so they are the same reports, and the **Projection reports** tab.
- **Your organisation** and **Prepared by**, at the top, are the names on its reports.
- **Kept in that browser:** its customers and reports are kept in the browser it is opened in. **Back up** saves them all as one file; **Restore** brings them back, in that browser or another.
- **In English**, in the Command center look, light or dark (the button at the top right), with its fonts inside.

More: [Cx Credits Calculator](credit-projections.md).

## Get help: support cases and enhancements

**Get help** sits at the bottom of the sidebar. Point at it, or click it, and two choices open:
- **Submit a support case**: something does not work, or you are stuck. Add a title, a description and a priority.
- **Request an enhancement**: a new feature or an improvement.

Each request gets a number (SUP-0001 for cases, ENH-0001 for enhancements). It is shown on screen and emailed to you, with a link to follow it. The **Get help** page lists your requests. Filter them by type and status, open one to see the conversation, and add to it.

| Status | Meaning |
| --- | --- |
| New | Raised, not picked up yet |
| In progress | Being worked on |
| Waiting for reply | The team needs something from you; your answer sends it back to them |
| Completed | Done |
| Declined | Will not be done; the conversation says why |

**The support team** are the people whose role has **Answer support cases & enhancements**: Admins, and anyone else given it under People & roles. They see the **Support queue** for the tenants they work in (a Super Admin sees every tenant), get an email for every new request, answer, and change the status. Every answer and status change is emailed to the person who raised the request. Emails go through **Settings → Email**; when it is not set up, the request is still saved, and the page says the email was not sent. More: [support](support.md).

**Settings → Get help** (Admins): keep the **support portal**, or choose **Email**. With Email, Get help opens each person's own email app instead of a form, addressed to the address you enter, with a short template. Use it on a server whose mail cannot leave its network. `SUPPORT_MODE=email` and `SUPPORT_EMAIL=…` set the default when the container starts.

---

## Performance and security status

How fast and how safe the version you run is. Each release is measured with 3000 people using it at once, on a 2 vCPU server, and checked for known vulnerabilities in its dependencies and in its own code (a Checkmarx One scan with every engine). The version you run is shown bottom-left (MZ-xx.xx.xx).

| Version | Requests/s, failed (3000 users, 2 vCPU) | Report opens p95 | Triage polls p95 | Tests | Dependencies (`npm audit`) | Checkmarx One scan of this code |
| --- | --- | --- | --- | --- | --- | --- |
| **MZ-01.01.00** | 488/s, 0 failed (main 483, 4) | 9.0 s | 659 ms | 955 pass | 0 vulnerabilities | Rescan 4c87c223 (every engine with Fusion): 57 open (10 critical, 22 high, 13 medium, 12 low), down from 120 on the first Fusion scan; about 110 fixed in code over six rounds; 29 marked not exploitable with their reasons, the 57 left are SAST results judged not exploitable, waiting for SAST triage rights to be marked (see [status](status.md#mz-010100-security-review)) |
| MZ-01.00.99 | 515/s, 0 failed (main 509, 0) | 7.0 s | 350 ms | 799 pass | 0 vulnerabilities | No new scan: checked in Checkmarx One for this release, there is no scan of this code newer than rescan fe2eb036 (18 October). Its 3 critical secret findings (an example GUID in tests) are marked not exploitable; the critical SAST hit on the load-test mock (not shipped) and the rest are still to triage |
| MZ-01.00.98 | 484/s, 15 failed (main 459, 181; all runs on a busy host, see status) | 10.2 s | 1.5 s | 796 pass | 0 vulnerabilities | No new scan: checked in Checkmarx One for this release, there is no scan of this code newer than rescan fe2eb036 (18 October). Its 3 critical secret findings (an example GUID in tests) are marked not exploitable; the critical SAST hit on the load-test mock (not shipped) and the rest are still to triage |
| MZ-01.00.97 | 518/s, 0 failed (main 496, 147 in a host pause) | 7.3 s | 826 ms | 783 pass | 0 vulnerabilities | No new scan: the Checkmarx One connector needs signing in again, so this release could not be checked; the latest scan known is rescan fe2eb036 (18 October). Its 3 critical secret findings (an example GUID in tests) are marked not exploitable; the critical SAST hit on the load-test mock (not shipped) and the rest are still to triage |
| MZ-01.00.96 | 510/s, 0 failed (main 492, 37 in host pauses) | 6.1 s | 546 ms | 782 pass | 0 vulnerabilities | No new scan: the Checkmarx One connector needs signing in again, so this release could not be checked; the latest scan known is rescan fe2eb036 (18 October). Its 3 critical secret findings (an example GUID in tests) are marked not exploitable; the critical SAST hit on the load-test mock (not shipped) and the rest are still to triage |
| MZ-01.00.95 | 514/s, 0 failed (main 507, 0) | 6.5 s | 573 ms | 780 pass | 0 vulnerabilities | No new scan: the Checkmarx One connector needs signing in again, so this release could not be checked; the latest scan known is rescan fe2eb036 (18 October). Its 3 critical secret findings (an example GUID in tests) are marked not exploitable; the critical SAST hit on the load-test mock (not shipped) and the rest are still to triage |
| MZ-01.00.94 | 513/s, 0 failed (main 494, 0) | 6.8 s | 303 ms | 765 pass | 0 vulnerabilities | No new scan: checked for this release, the latest scan of this code in Checkmarx One is still from MZ-01.00.82's time (rescan fe2eb036 the latest known). Its 3 critical secret findings (an example GUID in tests) are marked not exploitable; the critical SAST hit on the load-test mock (not shipped) and the rest are still to triage |
| MZ-01.00.93 | 509/s, 0 failed (main 491, 0) | 5.5 s | 646 ms | 758 pass | 0 vulnerabilities | No new scan: rescan fe2eb036 (MZ-01.00.82) is the latest known (not checked again for this release: the Checkmarx One connection here needed signing in again). Its 3 critical secret findings (an example GUID in tests) are marked not exploitable; the critical SAST hit on the load-test mock (not shipped) and the rest are still to triage |
| MZ-01.00.92 | 479/s, 153 failed (main 462, 152; a busy host) | 16.0 s | 2.0 s | 748 pass | 0 vulnerabilities | No new scan: rescan fe2eb036 (MZ-01.00.82) is the latest known (not checked again for this release). Its 3 critical secret findings (an example GUID in tests) are marked not exploitable; the critical SAST hit on the load-test mock (not shipped) and the rest are still to triage |
| MZ-01.00.91 | 461/s, 45 failed (main 437, 430; a busy host) | 14.2 s | 3.1 s | 747 pass | 0 vulnerabilities | No new scan: rescan fe2eb036 (MZ-01.00.82) is the latest known (not checked again for this release). Its 3 critical secret findings (an example GUID in tests) are marked not exploitable; the critical SAST hit on the load-test mock (not shipped) and the rest are still to triage |
| MZ-01.00.90 | 469/s, 0 failed in its clean run (main 494, 0); other runs of both lost 0–298 to host pauses | 8.2 s | 1.6 s | 746 pass | 0 vulnerabilities | No new scan: rescan fe2eb036 (MZ-01.00.82) is the latest known (not checked again for this release). Its 3 critical secret findings (an example GUID in tests) are marked not exploitable; the critical SAST hit on the load-test mock (not shipped) and the rest are still to triage |
| MZ-01.00.89 | 501/s, 0 failed (main 502, 0) | 9.6 s | 644 ms | 741 pass | 0 vulnerabilities | No new scan: rescan fe2eb036 (MZ-01.00.82) is the latest known (not checked again for this release). Its 3 critical secret findings (an example GUID in tests) are marked not exploitable; the critical SAST hit on the load-test mock (not shipped) and the rest are still to triage |
| MZ-01.00.88 | 469/s and 445/s, 266 and 210 failed (main 456 and 473, 394 and 197; a busy host, both sides alike) | 18.8 s | 1.9 s | 736 pass | 0 vulnerabilities | No new scan: rescan fe2eb036 (MZ-01.00.82) is the latest known (not checked again for this release). Its 3 critical secret findings (an example GUID in tests) are marked not exploitable; the critical SAST hit on the load-test mock (not shipped) and the rest are still to triage |
| MZ-01.00.87 | 465/s, 84 failed (main 470, 89; a busier host than usual, both sides alike) | 13.2 s | 1.8 s | 723 pass | 0 vulnerabilities | No new scan: rescan fe2eb036 (MZ-01.00.82). Its 3 critical secret findings (an example GUID in tests) are marked not exploitable; the critical SAST hit on the load-test mock (not shipped) and the rest are still to triage |
| MZ-01.00.86 | 303/s and 285/s, 2,052 and 2,266 failed on a saturated host (main 375 and 278, 1,201 and 2,336) | 60 s (the client timeout, main too) | 24.1 s | 721 pass | 0 vulnerabilities | No new scan: rescan fe2eb036 (MZ-01.00.82). Its 3 critical secret findings (an example GUID in tests) are marked not exploitable; the critical SAST hit on the load-test mock (not shipped) and the rest are still to triage |
| MZ-01.00.85 | 498/s and 513/s, 0 failed (main 491 and 520, 0) | 6.3 s | 463 ms | 720 pass | 0 vulnerabilities | No new scan: rescan fe2eb036 (MZ-01.00.82). Its 3 critical secret findings (an example GUID in tests) are marked not exploitable; the critical SAST hit on the load-test mock (not shipped) and the rest are still to triage |
| MZ-01.00.84 | 502/s, 0 failed (main 497, 0) | 6.7 s | 593 ms | 698 pass | 0 vulnerabilities | No new scan: rescan fe2eb036 (MZ-01.00.82). Its 3 critical secret findings (an example GUID in tests) are marked not exploitable; the critical SAST hit on the load-test mock (not shipped) and the rest are still to triage |
| MZ-01.00.83 | 521/s, 0 failed (main 519, 0; the first pair 520 against 525, 0 failed) | 2.1 s | 205 ms | 696 pass | 0 vulnerabilities | No new scan: rescan fe2eb036 (MZ-01.00.82). Its 3 critical secret findings (an example GUID in tests) are now marked not exploitable; the critical SAST hit on the load-test mock (not shipped) and the rest are still to triage |
| MZ-01.00.82 | 492/s, 0 failed (main 489, 0; the first pair 48 against 104, in host stalls) | 9.6 s | 1.5 s | 688 pass | 0 vulnerabilities (nodemailer 10.0.13) | Rescan fe2eb036 (2026-10-18, every engine): 4 critical, 39 high, 17 medium, 26 low, 1 info, none triaged yet. Checked: the 3 critical secrets are an example GUID in tests, the critical SAST hit is the load-test mock (not shipped), nodemailer's CVE-2026-110869 is fixed here, zlib's CVE-2026-85091 is in the alpine base (the build's `apk upgrade` takes alpine's fix); 43 new since rescan 27982f85, mostly SAST in code added since, are still to triage |
| MZ-01.00.73 | 507/s, 0 failed (main 497, 10) | 6.8 s | 615 ms | 645 pass | 0 vulnerabilities | No new scan. Open: the 53 of rescan 27982f85 (MZ-01.00.52), all judged not exploitable |
| MZ-01.00.60 | 505/s, 0 failed (main 499, 0 failed) | 6.9 s | 501 ms | 566 pass | 0 vulnerabilities | No new scan. Open: the 53 of rescan 27982f85 (MZ-01.00.52), all judged not exploitable |
| MZ-01.00.59 | 513/s, 0 failed (main 518, 0 failed) | 6.2 s | 229 ms | 565 pass | 0 vulnerabilities | No new scan. Open: the 53 of rescan 27982f85 (MZ-01.00.52), all judged not exploitable |
| MZ-01.00.58 | 502/s, 0 failed (main 514, 31 failed) | 11.8 s | 648 ms | 559 pass | 0 vulnerabilities | No new scan. Open: the 53 of rescan 27982f85 (MZ-01.00.52), all judged not exploitable |
| MZ-01.00.57 | 499/s, 0 failed (main 512, 10 failed) | 6.4 s | 627 ms | 557 pass | 0 vulnerabilities | No new scan. Open: the 53 of rescan 27982f85 (MZ-01.00.52), all judged not exploitable |
| MZ-01.00.56 | 494/s, 0 failed (main 495, 0 failed) | 5.5 s | 345 ms | 548 pass | 0 vulnerabilities | No new scan. Open: the 53 of rescan 27982f85 (MZ-01.00.52), all judged not exploitable |
| MZ-01.00.55 | 522/s, 0 failed (main 514, 0 failed) | 4.7 s | 311 ms | 534 pass | 0 vulnerabilities | No new scan. Open: the 53 of rescan 27982f85 (MZ-01.00.52), all judged not exploitable |
| MZ-01.00.54 | 523/s, 0 failed (main 520, 0 failed) | 7.0 s (second run 4.9 s) | 212 ms | 534 pass | 0 vulnerabilities (`proxy-addr` updated) | No new scan. Open: the 53 of rescan 27982f85 (MZ-01.00.52), all judged not exploitable |
| MZ-01.00.53 | 527/s, 0 failed (main 524, 0 failed) | 0.3 s | 96 ms | 530 pass | 0 vulnerabilities | No new scan. Open: the 53 of rescan 27982f85 (MZ-01.00.52), all judged not exploitable |
| MZ-01.00.52 | 504/s, 2 failed (main 518, 0 failed) | 7.5 s | 483 ms | 526 pass | 0 vulnerabilities | Rescan 27982f85 (MZ-01.00.52): 1 critical, 20 high, 14 medium, 18 low, all judged not exploitable; 12 closed in code |
| MZ-01.00.51 | 480/s, 0 failed (main 514, 0 failed) | 9.4 s | 951 ms | 526 pass | 0 vulnerabilities | Scan 82d48cec of MZ-01.00.50: 6 critical, 20 high, 17 medium, 19 low, being triaged |
| MZ-01.00.50 | 510/s, 0 failed (main 506, 10 failed) | 5.9 s | 341 ms | 525 pass | 0 vulnerabilities | Last scan (MZ-01.00.26): no critical, high or medium open; 15 low judged false positives |
| MZ-01.00.49 | 498/s, 0 failed (main 469, 206 failed) | 8.3 s | 1.1 s | 521 pass | 0 vulnerabilities | same |
| MZ-01.00.48 | 498/s, 7 failed (main 489, 44 failed) | 8.2 s | 880 ms | 519 pass | 0 vulnerabilities | same |
| MZ-01.00.47 | 519/s, 0 failed (main 504) | 5.3 s | 310 ms | 506 pass | 0 vulnerabilities | same |
| MZ-01.00.46 | 468/s, 44 failed (host stalls; main 177) | 10.1 s | 1.3 s | 479 pass | 0 vulnerabilities | same |
| MZ-01.00.45 | 497/s, 0 failed | 7.9 s | 1.2 s | 478 pass | 0 vulnerabilities | same |
| MZ-01.00.44 | 520/s, 0 failed | 7.1 s | 384 ms | 461 pass | 0 vulnerabilities | same |
| MZ-01.00.43 | 511/s, 0 failed | 5.7 s | 224 ms | 461 pass | 0 vulnerabilities | same |
| MZ-01.00.42 | — (page-only change) | — | — | 455 pass | 0 vulnerabilities | same |
| MZ-01.00.41 | 519/s, 0 failed | 0.9 s | 171 ms | 455 pass | 0 vulnerabilities | same |
| MZ-01.00.40 | 516/s, 0 failed | 5.9 s | 183 ms | 445 pass | 0 vulnerabilities | same |
| MZ-01.00.39 | 512/s, 0 failed | 5.7 s | 240 ms | 439 pass | 0 vulnerabilities | same |
| MZ-01.00.38 | 518/s, 0 failed | 0.6 s | 146 ms | 430 pass | 0 vulnerabilities | same |
| MZ-01.00.37 | 508/s, 0 failed | 5.1 s | 179 ms | 427 pass | 0 vulnerabilities | same |
| MZ-01.00.36 | 492/s, 0 failed | 2.3 s | 118 ms | 421 pass | 0 vulnerabilities | same |
| MZ-01.00.35 | 529/s, 0 failed | 0.6 s | 113 ms | 414 pass | 0 vulnerabilities | same |
| MZ-01.00.34 | 514/s, 0 failed | 4.2 s | 122 ms | 407 pass | 0 vulnerabilities | same |
| MZ-01.00.33 | 511/s, 0 failed | 3.9 s | 172 ms | 407 pass | 0 vulnerabilities | same |
| MZ-01.00.32 | 511/s, 0 failed | 2.5 s | 145 ms | 402 pass | 0 vulnerabilities | same |
| MZ-01.00.31 | 524/s, 0 failed | 2.5 s | 106 ms | 388 pass | 0 vulnerabilities | same |
| MZ-01.00.30 | 524/s, 0 failed | 4.1 s | 371 ms | 386 pass | 0 vulnerabilities | same |
| MZ-01.00.29 | 508/s, 0 failed | 2.6 s | 206 ms | 375 pass | 0 vulnerabilities | same |
| MZ-01.00.26 | 506/s, 0 failed | 4.4 s | 237 ms | 359 pass | 0 vulnerabilities | Scanned (617100eb): the 1 high was fixed before release |

- **Report opens** is how long an emailed report takes to open with every finding's state shown. **Triage polls** is how long an open report waits each time it asks where AI Triage stands.
- **Failed** means a request got no answer, timed out or hit a server error. "Busy, retrying", which reports handle on their own, is not a failure.
- Every earlier version, the findings still open and why each one is not a vulnerability: [Performance and security status](status.md).

## Everyday recipes

**Weekly reminder to every developer, their own projects only**
1. Workbench → Scope: *Projects last scanned in* = last month.
2. **Load findings** and wait for the green flare.
3. Send reminder: **Each developer**, **One summary**, attachment on. **Preview email**, then **Send reminder**.

To have it happen by itself, use Act → Automation, or a tracked report's **Automatic follow-up** (Remind tab).

**Triage every critical and high finding for one team**
1. Scope → Only these applications, projects or people: add the team's application, or its projects.
2. Fetch, then in the credits panel tick Critical and High.
3. **Give credits** (AI check) (it verifies with Checkmarx One first), then confirm.
4. **Triage critical & high.** Each developer is emailed that triage ran on their behalf.

**Remediate what triage confirmed**
1. Load findings again (or use **Check the numbers again**).
2. **Give credits** (AI fix), then **Remediate critical & high**: check the list and the cost, then confirm.

**Give a project credits without loading findings**
1. Credit Control → **Allocated vs used** → **Give credits**.
2. Type the project's name, enter the AI Triage and AI Remediation credits, then **Give credits** and confirm.

**Allocate exactly what the findings need, from wherever you are** (administrators)
- Workbench: load findings, tick the projects, then the AI credits panel's **Give credits**.
- Reports: open the report → **Triage** tab → the **Allocate for …** button on the AI Triage or AI Remediation row (it names the severities it covers next).
- Credit Control → **Allocated vs used**: tick the projects and severities → **Allocate for triage** or **Allocate for remediation**.

Each one counts what is needed twice with Checkmarx One first, asks before giving anything, and stops if the credit pool is short.

**Use credits already given, from wherever you are**
- Workbench: tick the projects and severities, then **Triage critical & high** or **Remediate critical & high** (each named after the severities ticked).
- Reports: open the report → **Triage** tab → the gold button on each row (**Triage all**, **Triage critical & high**, …).
- Credit Control → **Allocated vs used**: tick the projects → **Allocate and use credits** → **Triage with AI Assist now** or **Remediate with AI Assist now**.

The buttons turn gold once the credits cover the work. Credits given, taken back or used in one place show on the Workbench straight away; Reports and Credit Control show them whenever you open them.

**Take back credits nobody used (clean slate)**
- Every project: Credit Control → **Allocated vs used** → **Take back all unused credits**.
- One project: **Take back** on its row there.
- The projects loaded on the Workbench: Credits panel → **Take back unused credits**.

**Move to a new server**
1. Audit page → **Download backup**.
2. Start the new container.
3. **Restore from backup…**

---

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| No administrator password in the log | The volume already has people from an earlier install. Run `podman exec mission-zero node scripts/reset-admin.mjs`, or start fresh by removing the `mission-zero-data` volume. |
| The email server, Checkmarx One or a git host does not connect | Read the **How to fix it** box under the button (or in the header chip): it names the problem and the steps. Every problem it recognises is in [When a connection does not work](troubleshooting.md). |
| "Settings rolled back to the last known good configuration" | The new Checkmarx One key or mail server did not work. The message says what failed and how to fix it; fix it and try again. |
| SMTP test times out | Usually the port and **Secure connection from the start** do not match: 465 needs it on, 587 needs it off. Otherwise a firewall is blocking the port. |
| Hebrew is on (Settings → Activation codes) but not in the language list | Only roles with the **Hebrew** permission are offered it (Admins always). On **People & roles**, tick **Hebrew** for the role, then **Save**; it applies at once. |
| Gmail refuses the password | Use an App Password, not your normal password. |
| An uploaded .env file "Not applied" | That line has a mistake (listed with its line number and how to fix it); the setting that worked is kept. Fix the line and upload again. |
| The report says it cannot reach the server | Be on the company network or VPN. Check **Settings → Reminder server address**, and use **Change address** in the report if the server moved. |
| More rows than credits needed | Several rows can be one Checkmarx One result (marked **Same result R1** …). You are charged per result. |
| "Fetch still running" when you click Allocate or Triage | Wait for the green **Data fetch complete** flare. |
| "Could not be confirmed twice" when allocating | Someone was triaging, or a scan finished, between the two reads. Wait a minute and use **Check the numbers again**. |
| "… cancelled: Checkmarx One changed since this page last showed it" | Someone triaged or remediated meanwhile, in Checkmarx One or from a report. The panel now shows the real numbers; click the button again. |
| "CxMissionZero is restarting for an update — reconnecting…" | A new version is being applied. Wait a few seconds; you stay signed in and nothing is lost. |
| A report says "busy, retrying" | Many reports are open at once. It retries by itself; nothing is lost. |
| Credits refused | The project has no credits left. Allocate on the Workbench, or raise the credit pool (Admin). |
| **HTTPS:** the container stops; the log says "HTTPS is not set up correctly: …" | It tells you what is wrong:<ul><li>*The private key does not belong to the certificate*: the two files are from different requests. Ask IT for the matching pair.</li><li>*The .pfx file did not open: wrong TLS_PFX_PASSPHRASE?*: check the password.</li><li>*needs both TLS_CERT_FILE and TLS_KEY_FILE*: give both, or use `TLS_PFX_FILE`.</li><li>*no such file*: the folder is not mounted (`-v C:\mission-zero\certs:/certs:ro`), or the file name differs.</li></ul> |
| **HTTPS:** the browser warns "Your connection is not private" | <ul><li>Self-signed: expected; trust it, or use your company's certificate.</li><li>Company certificate: the address you typed is not a name in the certificate (*Subject Alternative Name*); open the right name, or ask IT to add it.</li><li>The chain is missing intermediates: ask IT for the full chain in `server.crt`.</li></ul> |
| **HTTPS:** after updating, `http://localhost:3000` no longer opens ("This page isn't working", "connection was reset") | Since MZ-01.00.21 the image serves HTTPS by default. Open `https://localhost:3000` instead, or add `-e HTTPS=off` to your `podman run` line to keep plain http. |
| **HTTPS:** a reverse proxy (Caddy, nginx) answers 502 Bad Gateway | CxMissionZero serves HTTPS by default, and the proxy speaks http to it. Add `-e HTTPS=off` to CxMissionZero's `podman run` line. |
| **HTTPS:** "HTTPS must be on, off or both" in the log | `HTTPS` takes `on`, `off` or `both` (also `true`/`false`, `yes`/`no`, `1`/`0`). |
| "Accept the terms of use to continue" / "An administrator must accept the terms of use" | An Admin signs in and accepts the terms for the organisation, then each person accepts them once ([Terms of use](#terms-of-use)). |
| A report says "This reminder server is not in use yet" | An Admin has not accepted the terms of use yet. Once they do, the report works (reload it). |
| **HTTPS:** locked out of the Settings page after a change | On the server: `podman exec mission-zero node scripts/https.mjs both`. Within 5 seconds http works next to HTTPS again, with HSTS off. |
| **HTTPS:** **Switch to HTTPS only** is greyed out | Open the page over HTTPS (the link under the button) and switch there. It also needs **HTTP + HTTPS side by side** first (step 2). |
| **HTTPS:** "The private key is missing" | Add the `.key` file IT gave with the certificate, or upload a `.pfx` that holds both. If the request was made on this page, the key is already on the server: upload the certificate IT sent for *that* request. |
| **HTTPS:** "Issued by …, but its chain is missing" | Add the intermediate certificates IT sent (a "chain", "bundle" or "CA" file) in the same upload. |
| **HTTPS:** "Does not cover …" | The address in the warning is not a name in the certificate. Use one of the names it lists, or ask IT for a certificate that adds it. `localhost` never matters. |
| **HTTPS:** "permission denied" when starting on ports 80 / 443 | Podman on Windows: `podman machine stop`, `podman machine set --rootful`, `podman machine start`. Or use `-p 8443:3000 -e HTTPS_PUBLIC_PORT=8443`. |
| **HTTPS:** Let's Encrypt (Caddy) gets no certificate | `podman logs mz-caddy` says why. Usually the DNS name does not point at this machine yet, or port 80 is blocked from the internet. |
| **HTTPS:** a renewed certificate is not being used | Wait 5 minutes. If the log says *The changed certificate could not be used*, the new files do not fit together; the old certificate stays in use meanwhile. |
| **HTTPS:** reports cannot reach the server after the switch | Reports sent before carry the old address. In the report, click **Change** next to the reminder server and enter the `https://` address. Check **Settings → Reminder server address** shows it too. |
| Anything else | Logs page → **Download troubleshooting log** and send it to your maintainer. |
