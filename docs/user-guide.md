# CxMissionZero user guide

Everything you can do in CxMissionZero, page by page, with every option explained.

**Who needs which part**
- Developers who only receive emails need [The emailed report](#the-emailed-report).
- Administrators setting it up start with [Set up in 10 minutes](#set-up-in-10-minutes), and serve it over HTTPS: [Turn on HTTPS](#turn-on-https).

**Contents**
1. [Find your way: Detect, Eliminate, Govern](#find-your-way)
1. [Who can do what](#who-can-do-what)
2. [Sign in](#sign-in), and the [terms of use](#terms-of-use)
3. [Set up in 10 minutes](#set-up-in-10-minutes) (Admin)
4. [Turn on HTTPS](#turn-on-https) (Admin)
5. [Settings, option by option](#settings-option-by-option)
6. [Dashboard: fetch, credits, remind](#dashboard)
7. [The emailed report](#the-emailed-report) (for developers)
8. [Reports: tracked reports](#reports-tracked-reports)
9. [Credit Control](#credit-control)
10. [Audit page: credit audit log and backups](#audit-page)
11. [People & roles](#people--roles)
12. [Beta page](#beta-page)
13. [Logs page](#logs-page)
14. [Performance and security status](#performance-and-security-status)
15. [Everyday recipes](#everyday-recipes)
16. [Troubleshooting](#troubleshooting)

The running version is shown at the bottom of the sidebar, as `MZ-xx.xx.xx`. Click it for Settings → About.

---

## Find your way

The sidebar follows a vulnerability from finding it to closing it:

| Stage | Pages | What you do there |
| --- | --- | --- |
| **Detect** | Dashboard, Beta | Fetch ageing findings, see who owns them, find who wrote the vulnerable code. |
| **Eliminate** | Reports, Credit Control | Follow tracked scopes down to zero, schedule follow-ups, give and track AI Triage and Remediation credits. |
| **Govern** | Audit, People & roles, Settings, Logs | The credit audit log and backups, people and roles, configuration, troubleshooting. |

The coloured label next to each page title says which stage you are in.

**Every page keeps what you were doing.** Go to another page and come back: your filters, tabs, selections, open rows, typed text and unsaved role changes are still there, and so is the scroll position.
- **↻** (top right) reloads the data of the page you are on and keeps your filters and tabs.
- **Refresh** (bottom of the sidebar; in the menu under your name on a phone) starts over: CxMissionZero reloads and every page opens as new. Saved settings, reports and credits are not affected.

**Jump to (Ctrl K, or ⌘K on a Mac)** goes to any page, tab, Settings section or common action: type a few letters (for example *smtp*, *allocated*, *backups*) and press Enter.

**Tabs instead of long pages.** Most pages have tabs at the top (for example Audit: *Credit audit log*, *Integrity & reconcile*, *State & backups*). The tab you last used opens next time. The address bar follows the tab, so `#/audit/backups` or `#/settings/smtp` opens that place directly.

**Any screen.** The layout adapts to the screen: a full sidebar on a desktop, an icon rail on a tablet, a bottom bar on a phone, and wide screens use their full width. The header is one line: the page's name and what it is for.

**Hide the menu.** **Hide menu** (bottom of the sidebar) turns the sidebar into a slim bar of icons, so the pages get the width. Point at the bar and the full menu opens **over** the page, without moving anything on it; it closes when the pointer leaves or you choose a page. **Keep menu open** (the same place) brings it back beside the page. Your choice is remembered in this browser.

---

**Your language.** The globe at the top right switches the page to any of these languages:
- 日本語 (Japanese);
- 繁體中文 (Traditional Chinese, Taiwan);
- 简体中文 (Simplified Chinese);
- 한국어 (Korean);
- Español (Spanish);
- Tiếng Việt (Vietnamese);
- ไทย (Thai);
- Bahasa Melayu (Malay);
- Bahasa Indonesia (Indonesian);
- English.

The first time, CxMissionZero uses your browser's language when it is one of these. Your choice is saved with your account, so it follows you to any browser you sign in from.

What is translated, and what is not:
- **Translated:** menus, options, buttons, headings, hints and status messages.
- **Not translated:**
  - names of projects, people and findings, which are shown as they are in Checkmarx One;
  - logs and code;
  - the terms of use, whose English text is the binding version.
- While something runs, the status line says plainly what is happening in every language other than English.
- The emailed report and reminder emails stay in English.

**Your profile.** Open your name at the top right, then **Your profile** (also Settings → Your profile). Every person has one, whatever their role:
- **Picture:** PNG, JPEG or WebP. It is cut to a square and made small in your browser before it is saved.
- **Email, role and last sign-in:** shown for reference. An administrator manages these under People & roles.
- **Name:** how you appear in this app.
- **Language:** the same choice as the globe.
- **Time zone:** picked up from your computer by default. Untick **Use this computer's time zone** to choose another. Dates and times on every page are shown in it.
- **Programming languages:** the languages you work in.

Changes save as you make them and are recorded in the audit log. A time zone or first language picked up from your computer is saved without an audit entry.

**Simple by default.** Fine-tuning most people never need is hidden: the reminder format and attachment, extra credits, custom link and mail templates, the risks endpoint, mail-server certificate checks, HTTPS hardening and similar. To see it, open your name (top right) and turn on **Show advanced options**. The choice is kept in your browser.

## Who can do what

Everyone signs in and has one role. Tabs and buttons you are not allowed to use are hidden, and the server refuses them anyway.

| Role | Can |
| --- | --- |
| **Admin** | Everything, including the Checkmarx One integration, the email server, the credit pool and backups. |
| **Security Analyst** | Everything else: fetch, remind, allocate credits, triage and remediate, tracked reports, audit, people and roles, beta. |
| **User** | Fetch findings, send reminders, follow tracked reports, see credits. Settings are read-only. No Access, Audit or Beta. |

Admins and Analysts can change what Security Analyst and User may do, or create new roles, on the [People & roles page](#people--roles).

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
- If the log shows no password, the volume already holds people from an earlier install.
- To set a new temporary password, run `podman exec mission-zero node scripts/reset-admin.mjs`.
- To start from scratch, remove the volume (`podman volume rm mission-zero-data`). This deletes every setting and the audit log.

**Locked out?** Five wrong passwords lock an account for 15 minutes. An Admin or Analyst can set a new temporary password for you on the People & roles page (**Set password**).

**Connections, top right.** One look shows whether CxMissionZero can reach what it needs:

| Indicator | Green when | Red until |
| --- | --- | --- |
| **Checkmarx One** | The server's integration is connected. | An Admin connects it (Settings, `CX_API_KEY`, or the .env upload). |
| **Email** | The mail server passed its test with the current settings. | It is set and tested (Settings → Email server → Test connection, or the .env upload, which tests it). |
| **Git** | Every git connection answers: one small logo per connection (GitHub, GitLab, Azure DevOps, Bitbucket), each ringed green when its token works and red when it does not. Two GitHub connections show two GitHub logos (the second marked 2). Amber when some work and some do not. Checked every 5 minutes, and whenever a token changes. | A token is set: `GITHUB_TOKEN`, `GITLAB_TOKEN`, `AZURE_DEVOPS_TOKEN` or `BITBUCKET_TOKEN` (in the .env file, or on the Beta page). |

Click one for its details: tenant and URLs, mail server and sender, and what to do when it is red. **Git** lists every connection with its host, the account its token belongs to and where the token comes from, then the hosts not connected yet and the variable that connects each. They update as soon as settings are saved or a .env file is uploaded.

**More than one connection to the same host.** A second GitHub (an Enterprise server next to github.com, or another organisation's token), GitLab, Azure DevOps organisation or Bitbucket: the same variables numbered `_2` to `_9`, in the .env file or uploaded under Settings, for example `GITHUB_TOKEN_2` with `GITHUB_API_URL_2` and `GITHUB_ORG_2`. Each repository is read with the connection for its host; when two share a host (two github.com tokens), with the one whose organisation, group or workspace owns the repository. Usernames are matched with the first connection of each host.

**Progress flares, bottom right.** Whatever you start shows a flare while it runs:
- **Amber, with something fast racing along:** in progress. Each action gets one of 21 icons (a rocket, a cheetah, a bullet train, a falcon…), a different one each time. The top line is a light-hearted note about what it is doing, new every few seconds; the line under it is live: the action, how many projects, and the seconds so far (e.g. *Checking with Checkmarx One (two independent reads) · 12 projects · 4s*). The button and the part of the page it came from are paused, so nothing is started twice.
- **Green:** done. The icon glides to a stop and a tick mark draws itself in. With *reduce motion* turned on in your system settings, the tick shows straight away and nothing moves.
- **Red:** it did not finish, and says why.

Several actions can run at once, each with its own flare.

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
- **The first Admin**, right after choosing a password at the first sign-in. The terms show in full: scroll to the end, tick **I have read these terms and accept them for myself and on behalf of my organisation**, then **Accept and continue**. Until then nothing can be used, by anyone:
  - the Dashboard and Settings;
  - emailed reports (they say the server is not in use yet);
  - automatic reminders.
- **Everyone else**, once, at their first sign-in. Before an Admin has accepted, they see **An administrator must accept these terms…**, with **Check again**.
- **Declining** signs you out.
- **When the terms change,** everyone is asked again.
- **On record.** Each acceptance (who, when, from which address, which version) is in the **Audit log**.

**Read them any time:** **Settings → About & terms of use** (or click the version at the bottom of the sidebar); or the link on the sign-in page.

**Automated setups:** `ACCEPT_TERMS=you@company.com` in the container options accepts the terms for the organisation and everyone, under your name (in the log and the audit log). Anything but an email address stops the start.

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
| 7 | Automation (optional) | Turn on age-threshold reminders. Start with **Test mode**. |

Then go to the **Dashboard**, click **Load findings**, and send your first reminder.

Settings **save as you type**; there is no Save button.
- A changed Checkmarx One or mail connection is checked straight away.
- If it does not work, the **last known good** settings come back when you leave the page, so nothing stops working. Every administrator is told what was rolled back.

---

## Turn on HTTPS

Do this before anyone else signs in or receives a report. Over HTTPS, sign-ins, findings and triage requests cross the network encrypted. Plain http sends them as readable text to anyone on the way.

### From the Settings page (recommended)

Admins only: **Settings → HTTPS**. It moves the running server from http to HTTPS in five steps, with no new command, no restart, and nobody cut off. The badge top right shows where it stands: **HTTP only**, **HTTP + HTTPS side by side**, or **HTTPS only**.

1. **Certificate.**
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
     - the Dashboard, if open over http, moves itself to HTTPS;
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
podman run --replace -d --name mz-caddy --network mz-net -p 80:80 -p 443:443 -v caddy-data:/data docker.io/library/caddy:2 caddy reverse-proxy --from mz.company.com --to mission-zero:3000
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

Install a new version, go back to any version, turn on auto-update, restart the server, or download a troubleshooting report, all without signing in to the server. How it works and what it needs: [Updating](updating.md).

- **Running** and **Latest published**, with **Update now** when there is a newer one. **Check for updates** reads the registry again and says how many versions are published and whether one is newer.
- **Versions come from their tags**, so a newer one is always listed. Installing downloads the image files, which ghcr.io serves from `pkg-containers.githubusercontent.com`. If a proxy or firewall blocks that host, the page says so (*the versions are listed, but this server could not read the image files…*): allow it over HTTPS, or update with `podman pull`. A check never reports "up to date" when it could not read the registry; it says why.
- **Auto-update:** off until you tick it. **at** limits it to one hour of the day. A version that failed to start once is never installed by itself again. While this server cannot download image files, it waits and says why instead of trying every 15 minutes.
- **Every version:** the newest 3 first; **Load 10 more** shows older ones, 10 at a time, until all are there (the count says how many of how many). The version running here is always shown. **Install and switch** (any published version) or **Switch to** (an installed one, or the image's own).
  - Every published version is listed, however many there are. Up to MZ-01.00.35 only the newest 40 registry tags were read, and every release adds two, so the oldest versions dropped off the list.
  - The page checks again by itself when it opens and the last check is more than 10 minutes old.
  - A backup is taken before every switch.
  - A version that does not start is rolled back by itself.
- **Recent events:** switches, starts, automatic rollbacks, restarts.
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
| **Code authors (git blame)** | Anyone who may **send reminders** can find and email the developers who wrote the vulnerable code. The sidebar entry becomes **Code authors**, the Dashboard's Remind panel links to it, and Settings → Automation can email code authors on every run. |
| **Match usernames to email addresses** | Anyone who may change **initiator addresses** can run and apply the matching. |

### About & terms of use
The version, the licence, the project's address, which version of the terms you accepted, and **Read the terms of use**.

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
| Single-tenant / on-prem overrides | IAM URL, API URL and tenant. Only needed when they cannot be worked out from the key (single-tenant or on-prem). Pointing the IAM or API URL at another host clears the stored key: paste it again with the new address. |
| **Connect & store** | Checks the key (token exchange plus one project call) and stores it. |
| **Remove stored key** | Removes the stored key. If the server was started with `CX_API_KEY`, it falls back to that key. |

### Email server (SMTP) (Admin)
| Field | Meaning |
| --- | --- |
| Host, Port | Your mail server. Port and TLS mode are paired: picking port 465 turns on Implicit TLS, and 587 / 25 / 2525 turn it off. |
| Implicit TLS | On only for port 465. |
| Server requires authentication | Usually on. |
| Verify TLS certificate | Leave on. Turn off only for an internal relay with a self-signed certificate. |
| Username, Password | The sending account. The password is stored on the server and never shown again. Changing the host clears it: type it again for the new server. |
| From name, From address | Who the reminders come from. A blank address uses the username. |
| **Test connection** | Connects and logs in without sending anything. |
| **Send test email** | Sends a real email to the address you type. |

**Sending needs a passing test.** Changing the host, port, user, password or TLS options needs a new test.

**Common servers**
- **Gmail:** `smtp.gmail.com`, port 587, Implicit TLS off, and an [App Password](https://myaccount.google.com/apppasswords); your normal password will not work.
- **Office 365:** `smtp.office365.com`, port 587.

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
| Escalate findings that go past their SLA, once each | Each scheduled run (Settings → Automation must be on) emails the people below one list of the findings that went past their SLA since the last run: project, severity, how far past, and who ran the latest scan. A finding is escalated once; if it is fixed and comes back, it is escalated again. **Test mode** in Automation counts them without sending. |
| Escalate to | The addresses that get the escalation, one per line. |
| Also open an issue in the repository | Each scheduled run opens **one issue in each project's repository** listing its findings that went past their SLA (severity, finding, where, first found, days past, a link to Checkmarx One), each finding once. GitHub, and GitLab as a **confidential** issue, with the token connected under Beta → Source-code hosts (it needs permission to create issues). **Private and internal repositories only:** a public one is skipped, so vulnerabilities are never published. Text from findings cannot mention anyone or add links. At most 20 projects a run, the most severe first; the rest next run. Works with or without the email escalation. **Test mode** counts them without opening any. |

Findings triaged as not exploitable (proposed or confirmed) have no SLA. On the **Dashboard**, **Past SLA** shows how many open findings are past their SLA (red), with how many more are due within 7 days under it (amber). The projects table has a **Past SLA** column, shown by default, and **Due ≤ 7d** under **Columns**; both are in the CSV export. The automation's run history says how many were escalated, how many repository issues were opened, and which projects were skipped and why (no repository, no token, public repository, no permission).

### Automation
Watches findings on a timer and emails the moment one crosses an age threshold. Each finding is reported **once per threshold**, so a daily run does not nag.

| Option | Meaning |
| --- | --- |
| Run automatically | Turns the schedule on. |
| Test mode | Decides and logs, but sends nothing. Use it for the first run, because an older tenant has a backlog that crosses every threshold at once. |
| Thresholds (days) | For example `30, 60, 90`. |
| Check every (minutes) | From 15 minutes to 1 week. |
| Sends to | Shown, not set here: it follows **Dashboard → Remind → Send to** (each developer, the fixed list, or both). With **Both** and an empty fixed list, the run says so instead of sending to nobody. |
| Severities | For example `CRITICAL, HIGH`. Blank means all. |
| Mode | **Report each threshold once** (recommended), or **digest**: re-report everything past a threshold on every run. |
| Also email the code authors | Shown once an Admin has made **Code authors** final. Each run also emails the developer who last changed the line of each finding that just crossed (SAST and KICS, most severe first, up to 200 a run), with the findings in their code. Developers are still emailed as before. In digest mode the authors are emailed on every run too. |
| **Run once now** | Runs a pass immediately. |
| **Reset history** | Forgets what was reported, so the next run reports everything again. |

The panel shows:
- whether the Checkmarx One connection and the mail server are ready;
- the last runs (scanned, crossed, sent, and how many code authors were emailed);
- **Also running by itself:** everything else that runs on its own, in one list: SLA escalation (on or off), and each tracked report's automatic follow-up and rescan, with **Open** to go to that report's Remind tab.

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
| Browser icon | The icon in the browser tab, bookmarks and the developer pages. Empty is CxMissionZero's own **MZ0** (a white MZ inside a green zero). Paste an `https` address, or **Upload an icon** (SVG, PNG, ICO, WebP or JPG, up to 100 KB; square works best); **Use MZ0 (the default)** puts it back. It changes for everyone as soon as it is saved. |
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
- Use the `https://` name in your certificate ([Turn on HTTPS](#turn-on-https)). `REPORT_SERVER_URL` fills it in when the page has none saved.
- With neither set, reports sent with nobody at the dashboard (scheduled ones) use the last address someone who may change this setting opened the dashboard on. Behind a reverse proxy that is often an internal name, so set the address here.

### Risks endpoint
Where findings are read from. The default is `/api/risks/`.
- **Detect** tries the known paths against your tenant and shows what each returned.
- `/api/risks/ai-insights` adds AI Triage status to each finding.

---

## Dashboard

**Get started.** Until the basics are in place, one row of steps at the top shows what is left: connect Checkmarx One, fetch vulnerabilities, set up email, give reports a reachable address, cap AI credits, invite your team. Done steps are ticked green and joined by a green line; each step still to do has its button. **Hide** puts the row away.

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
- **The top block** holds what to load (both windows, **Narrow to projects or people**, **Load findings**), one line of totals and the way to Mission Zero. It takes about a fifth of a 1080p screen and under a third of a laptop's, and **stays in view** while you scroll: the scope and **Load findings** are always at hand.
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
| Only these projects or people | Optional; open it with **Narrow to projects or people**. **Projects, by name**: type to pick, or press Enter to add every project whose name contains the text. **People who ran the latest scan**: a username or an email. Only those projects are fetched, which is the fastest fetch. |

### 2. Load findings
- Rows appear as each project is read.
- An **amber flare** (bottom-right) says the fetch is in progress, with how many projects are in so far. It turns **green, Data fetch complete**, when the last one arrives.
- Until then, triage, remediation and credit allocation are switched off, so nothing is decided on half the data.
- **Stop** (beside the button, while it loads) ends the load early. Projects already being read finish, the rest are not read, and the projects loaded so far are kept: the totals, the projects list, reminders, AI checks and fixes and reports all work on them, as after a full load. The flare turns green with **Stopped — kept 6 of 20 project(s)**, and the note under the button says how many were left out. **Load findings** again reads them all. Closing or leaving the page while it loads stops it the same way.
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
| Search, Severity, Age, Hide empty | Filter the table. |
| Click a column header | Sort by that column. |
| **Columns** | Add the age-bucket and per-severity columns. Your choice is remembered in this browser. |
| **Export CSV** | Every shown project, every column, with credits. |
| Tick boxes | Select projects. Reminders, credits and tracking apply to the selection, or to every shown project when none is selected. |
| Latest scan by | Who ran the project's latest scan, and the email it resolved to. |
| Triage / Remediation credits | Left / allocated, and how many more are needed. |
| Action panel → **Track** → **Save as tracked report** | Follow these projects and filters over time (see [Reports](#reports-tracked-reports)). |

### 4. AI Triage & Remediation credits
*Action panel → **AI credits**.* **Nothing is allocated until you confirm it.** (**How allocation works** opens the rules below.) For the ticked severities (Critical and High by default), the panel shows what the selected projects **need**:
- **Triage:** 1 credit per Checkmarx One result still to triage.
- **Remediation:** 3 credits per **confirmed** finding not yet remediated.

**Why rows and credits can differ.** Checkmarx One can list one result once per code path. For example, 12 rows can be 10 results: those rows are triaged together and charged once, so the need is 10 credits, not 12. Counts always show both.
- **Why fewer results than findings** (in the panel and in each project's credit editor) lists them: each Checkmarx One result that covers more than one finding, its severity and title, how many findings, and where each code path ends (file and method).
- Those findings are one vulnerable piece of code reached by several data flows. They are triaged once, for 1 credit, and **one fix closes them all**, so fix them in one go.

| Button | What it does |
| --- | --- |
| **Refresh & verify with Checkmarx One** (green border) | Re-reads the findings twice, independently. The numbers are marked verified only when both reads agree. Every button below runs it first by itself. |
| **Give credits** (AI check) | Verifies first, then shows what will be given and asks you to confirm. Credits come out of the credit pool. |
| **Check with AI now** | Runs AI Triage on the selected projects' findings, within their credits. |
| **Give credits** (AI fix) | The same, for confirmed findings. |
| **Fix with AI now** | Lists each project's confirmed findings and the cost, then runs AI Remediation after you confirm. Each finding is re-checked first; anything no longer confirmed is left alone. |
| Email each scan initiator… | On by default. When you triage or remediate for someone, each scan initiator gets one email about their own projects: what was started on their behalf, and what to do next (refresh their report, review and approve the pull requests). |
| **Take back N unused credits** (top of the panel, next to **Check the numbers again**) | Returns everything the selected projects were given and did not use (people did not act on it) to the pool; the button says how many. It never goes below what was used or is in flight. **Every project: Credit Control →** takes back from all projects at once. |
| Extra credits → **Add extra credits** | Gives every selected project a fixed extra amount. |
| Extra credits → **Take back extra credits** | Returns the extras. |

**Every action checks first.** Each button in this panel (allocate, triage, remediate, extra credits, taking credits back) first runs **Refresh & verify**. Developers may be triaging or remediating in Checkmarx One itself, or from their emailed report, while you look at this page.
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
| Send to | **Each developer**, **A fixed list**, or **Both**. **This is the one place that decides who gets reminders**: here, Settings → Automation's scheduled runs, and tracked reports' follow-ups all use it (changing it needs **settings.recipients**). A scan initiator only ever gets their own projects; the server refuses any email that would show someone a project they did not scan. |
| Content | **One summary** (one email per person, all their projects), or **One per project**. |
| Attach the interactive HTML report | On by default. Developers can triage and remediate straight from it. |
| Fixed list | To / Cc / Bcc, edited here. **Save list** keeps it. |
| **Preview email**, **Preview report**, **Download HTML** | Check before sending. **Download HTML** is always there: it saves the interactive report of the selected projects, to share it yourself. |
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
3. **Read the list.** The header sums it up: open findings, how many critical, high, medium and low, and the oldest. It shows the top 50 findings: worst severity first, then oldest.
   - **Filter it:** pick a severity, search (finding, project, file), or tick **Only what AI can act on**.
   - **How this report works** explains Triage, Remediate and the reminder server.
   - Each finding shows:
     - its live Checkmarx One state;
     - a link into Checkmarx One;
     - for an open-source package, **upgrade to …**: the version Checkmarx One recommends, when it gives one.
4. **Triage** runs Checkmarx One AI Triage on a finding. The verdict appears in the row within a few minutes.
   - **Triage all critical / Triage all high** cover every critical or high finding in the report, across its projects, and skip ones already triaged.
   - A finding judged **not exploitable** disappears from the report, which counts how many it has hidden.
   - **Your tools, chosen once.** Above the list, pick where code opens (**VS Code**, **Cursor**, **Kiro**, **Windsurf**, **Antigravity**, a **JetBrains IDE**, or **the browser**) and how a fix is applied (**Apply in my workspace** or **git apply**). It is remembered in this browser, for every report. Every finding then has two buttons, **Open in …** and **Apply AI fix**: one click each. **▾** on a finding picks another way, for that finding only.
   - **Open in …** opens the file at the finding's line.
     - **One question, once per computer:** where you keep your code (for example `C:\src`). Every repository then opens from there by its name (`C:\src\payments-api`). In **▾**, **Somewhere else?** sets a different folder for one repository.
     - **JetBrains** needs no folder: it opens the file in the project of that name you have open or opened before.
     - **The browser** opens github.dev or the GitLab Web IDE at the line (Bitbucket and Azure Repos show the file).
     - **Not on this computer yet?** In **▾**, **Clone and open** hands the repository to the IDE, which asks where to clone it.
   - **Apply AI fix** applies the fix Checkmarx One AI Remediation wrote for the finding (see below). Fixes come only from AI Remediation: until a finding is remediated, the button says to remediate it first.
5. **Remediate** works once a finding is **Confirmed**. It runs AI Remediation and then offers the fix:
   - a summary;
   - the pull request (for repository-connected projects);
   - a downloadable patch;
   - a link to Risk Hub.
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
| **Why / Fix** under Confirmed | Why the finding is a real vulnerability and how to fix it, said once, in two lines. **why?** adds only what those lines do not say: <ul><li>how Checkmarx One knows (for example, it followed the data from input to this code);</li><li>AI Triage's verdict (reachable / exploitable, confidence) when there is one;</li><li>what Remediate will do.</li></ul> |
| **Triaging…** | AI Triage is running. |
| **No verdict** | Checkmarx One produced no AI Triage result within 6 minutes. Check the finding in Checkmarx One; the report keeps checking. |
| **Manual fix** | AI cannot act on this kind of finding (for example IaC). Use **Fix in Checkmarx One**. |
| Your credits | What your projects have left. When they run out, **Ask the administrator** emails them. |

Your report can only act on the findings it lists: each one carries a signature that is valid for 30 days.

---

## Reports: tracked reports

Save a scope from the Dashboard (**Save as tracked report**) and follow it over time. The Reports page is laid out for a security team that tracks many scopes at once: the whole picture first, then one report at a time.

**At the top: every report together**

| Tile | What it counts |
| --- | --- |
| **Findings tracked** | The findings all reports covered when saved. |
| **Actioned** | The share triaged (confirmed or not exploitable) or no longer detected. |
| **Open now** | Awaiting triage, confirmed, or new. |
| **New since saved** | New findings matching the reports' filters. |
| **Follow-ups scheduled** | How many reports send reminders by themselves, and when the next one goes out. |
| **AI credits used** | Triage / remediation, on the reports' projects since they were saved. |

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
| **Remind** | Who gets it follows **who gets reminders everywhere** (Dashboard → Remind → Send to); **Only for this report…** gives this report its own choice (developers, fixed list, both, or only some addresses). The content (one summary per person, or one email per project), and whether to attach the interactive report. **Preview**, then **Send reminder now**. The sends so far are listed. Below, **Automatic follow-up**: reminders every N days at a set hour (the server's time zone), only while something is still open, with the same options; it shows the next and last send. **Save schedule**. |
| **Triage** | AI Triage for the chosen severities (**Triage now**), with what it needs and what is left. Credits are given in one place: **Give credits on the Dashboard** opens the Dashboard's AI credits panel with this report's projects in scope and loads their findings. |
| **Verify** | Prove the fixes with a Checkmarx One rescan, then start the next round (below). |
| **History** | Every reading: awaiting, confirmed, not exploitable, no longer detected, new, matching now. |

At the top of the panel: **Refresh** (re-reads now; reports also update hourly, and every few minutes after someone triages or remediates), **Download HTML** (the interactive report for its open findings) and **Delete** (its history in the audit log stays).

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
   - **Rescan now to verify** asks Checkmarx One to scan each project again, like its last scan: same repository, same branch, same engines. It is there at any time, and uses scans, not AI credits.
   - Projects Checkmarx One cannot fetch (code uploaded from a pipeline or the CLI) **wait for their next scan**: whichever scan comes next, from your pipeline or Checkmarx One, verifies them, for up to 30 days.
4. **See what it proved,** per project and in total:
   - **Verified fixed:** gone after the rescan.
   - **Still found:** still reported. **After AI Remediation** means the fix did not work. These are listed.
   - **Accepted:** triaged not exploitable.
   - **New in scope:** found since the round started.
   - When nothing is still found or new: **✓ Mission Zero for this scope**, and the report shows **Verified at zero**. If new findings appear later, it shows **Left zero** at once.
5. **Next round.** Pick the next scope (for example medium and low) and **Start round N**. It starts from what Checkmarx One reports now, after the rescan. The round just finished, with its verification result, stays in **Earlier rounds**.

**Rescans stay with the developer.** Checkmarx One records whoever owns the API key as a scan's initiator, so on its own every verification rescan would look like the administrator's.
- **In CxMissionZero:** it remembers, for each rescan it starts, whose work it verifies (the initiator of the scan before it) and who asked. Reminders, reports, tracked reports and the Dashboard go on naming that developer.
- **In Checkmarx One:** the rescan carries the tags `verifies-work-of` (the developer) and `requested-by` (you, or "automatic verification").

Who: anyone with **Manage tracked reports** (Admins and Security Analysts by default). Every rescan, result, switch and new round is in the audit log (type **Verification rescans**).

"Sent for remediation" counts AI Remediation sent from CxMissionZero. A fix made any other way (by hand, or remediated directly in Checkmarx One) counts as fixed when the rescan no longer finds it. **Rescan now** is always there for that.

---

## Credit Control

How the credit pool is being used, in three tabs. Everyone with **credits.view** sees it. The period, grouping and project, top right, apply to every tab.

| Part | Meaning |
| --- | --- |
| Filters | <ul><li>Period: last 7 / 30 / 90 days, this or last month, last 12 months, or a custom range.</li><li>Group by day, week or month.</li><li>One project, or all.</li></ul> |
| **Overview** → Credit pool | Size; used (triage / remediation); remaining; given to projects but not used; free to give. |
| **Overview** → Credits used over time | Columns per day / week / month: triage at the base, remediation on top. Hover for numbers. **Show as a table** gives exact figures. |
| **By project** | Each project's triage and remediation credits in the period, with its share. |
| **Allocated vs used** | Per project, all time. |
| **Give credits** (Allocated vs used, for **credits.allocate**) | Type a project name (every Checkmarx One project is listed, not only those that already hold credits), enter AI Triage and AI Remediation credits, then **Give credits** and confirm. No findings need loading. The credits are extra credits, out of the credit pool, and the bar shows how many are free to give. **Give** on a row fills in that project. Each gift is in the audit log. To give exactly what a project's findings need, use the Dashboard, which checks the count with Checkmarx One first. |
| **Take credits back** (Allocated vs used, for **credits.allocate**) | **Take back all unused credits** is the clean slate: every project's unused credits go back to the pool at once, with no findings loaded. **Take back** on a row does it for one project. Used credits stay counted, and each take-back is in the audit log. Developers cannot triage or remediate from their reports until credits are given again. |
| **Export CSV** | Everything above, for the chosen period. |
| **Pool & AI settings** | Opens Settings → AI & credit pool, to change the pool size and what reports may do (Admin). |

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

Identity and access management, in two tabs.

**People.** Search by name, email or Checkmarx One identity, and filter by role or status (active, locked, disabled, must set password). 20 people a page.

| Action | What it does |
| --- | --- |
| **Add person** | Fields: <ul><li>email and name;</li><li>role;</li><li>a temporary password (they choose their own at first sign-in);</li><li>optionally their **Checkmarx One identities** (usernames or client ids allowed to sign in with an API key).</li></ul> |
| Role (per person) | Change it. It applies on their next click. |
| **Set password** | A new temporary password. |
| **Disable / Enable** | Disabling ends their sessions at once. |
| **Remove** | Deletes the account. |

**Roles & permissions** is a matrix of permissions against roles.
- **Find a permission** narrows the matrix; click a group name to fold it, or **Collapse all**. Each group row shows how many of its permissions each role has.
- Tick or untick boxes, then **Save role changes** (or **Discard**). Unsaved changes are kept if you go to another page and come back.
- **New role** builds your own role.
- The Admin role is fixed. Permissions marked **Admin** are Admin-only by default.
- You can never grant a permission you do not have yourself, or touch an Admin's account unless you are an Admin.
- There is always at least one active Admin.

---

## Beta page (Code authors)

Early features: check what they find before relying on them. A feature an Admin made final ([Settings → Beta features](#beta-features-admin)) loses its Beta label, and the page is called **Code authors** in the sidebar once that one is final. Details are in [beta-features.md](beta-features.md). Three tabs: **Code authors**, **Match usernames**, **Source-code hosts** (the connections: GitHub, GitLab, Azure DevOps, Bitbucket).
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

## Logs page

Two tabs: **Activity in this browser** and **Troubleshooting log**.

**Troubleshooting log.** **Download troubleshooting log** gives one file covering:
- which features are used and how fast;
- where errors happen;
- where numbers disagree;
- recommended fixes.

Send it to whoever maintains CxMissionZero when something goes wrong. **It captures no sensitive information:** no names, email addresses, passwords, keys, tokens, hosts, URLs, findings or code.

**Activity log.** What this browser asked the server, newest first, 100 lines a page. By default it shows each answer (**Success** and **Errors**, with counts); tick **Sent** to see each request as it goes out too. Searchable. **Export** saves it; **Clear** empties it.

---

## Performance and security status

How fast and how safe the version you run is. Each release is measured with 3000 people using it at once, on a 2 vCPU server, and checked for known vulnerabilities in its dependencies and in its own code (a Checkmarx One scan with every engine). The version you run is shown bottom-left (MZ-xx.xx.xx).

| Version | Requests/s, failed (3000 users, 2 vCPU) | Report opens p95 | Triage polls p95 | Tests | Dependencies (`npm audit`) | Checkmarx One scan of this code |
| --- | --- | --- | --- | --- | --- | --- |
| **MZ-01.00.46** | 468/s, 44 failed (host stalls; main 177) | 10.1 s | 1.3 s | 479 pass | 0 vulnerabilities | Last scan (MZ-01.00.26): no critical, high or medium open; 15 low judged false positives |
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
1. Dashboard → Scope: *Projects last scanned in* = last month.
2. **Load findings** and wait for the green flare.
3. Send reminder: **Each developer**, **One summary**, attachment on. **Preview email**, then **Send reminder**.

To have it happen by itself, use Settings → Automation, or a tracked report's **Automatic follow-up** (Remind tab).

**Triage every critical and high finding for one team**
1. Scope → Only these projects or people: add the team's projects.
2. Fetch, then in the credits panel tick Critical and High.
3. **Give credits** (AI check) (it verifies with Checkmarx One first), then confirm.
4. **Check with AI now.** Each developer is emailed that triage ran on their behalf.

**Remediate what triage confirmed**
1. Fetch again (or use **Refresh & verify**).
2. **Give credits** (AI fix), then **Fix with AI now**: check the list and the cost, then confirm.

**Give a project credits without loading findings**
1. Credit Control → **Allocated vs used** → **Give credits**.
2. Type the project's name, enter the AI Triage and AI Remediation credits, then **Give credits** and confirm.

**Take back credits nobody used (clean slate)**
- Every project: Credit Control → **Allocated vs used** → **Take back all unused credits**.
- One project: **Take back** on its row there.
- The projects loaded on the Dashboard: Credits panel → **Take back unused credits**.

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
| "CxMissionZero is restarting for an update — reconnecting…" | A new version is being applied. Wait a few seconds; you stay signed in and nothing is lost. |
| A report says "busy, retrying" | Many reports are open at once. It retries by itself; nothing is lost. |
| Credits refused | The project has no credits left. Allocate on the Dashboard, or raise the credit pool (Admin). |
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
