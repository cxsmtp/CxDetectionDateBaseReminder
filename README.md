# CxMissionZero

**Act on Checkmarx One findings, follow them up to zero, and prove every credit.** CxMissionZero shows which vulnerabilities have sat unfixed and for how long, and emails each developer *their own* findings. Developers can then triage and fix them with Checkmarx One AI straight from that email, with every credit accounted for.

Self-hosted, one container, nothing to install for developers.

> <span style="color:#065f46">**On premise, your data stays yours.** Runs on your own servers and sends your data to no one: it connects only to the services you connect it to (Checkmarx One, your email server and any code host you add; and, only when an Admin checks for or installs updates, the registry its own image comes from). No telemetry, no analytics, nothing calls home, and you can monitor its traffic to check.</span>
>
> **An independent project, not a Checkmarx product.** Free for Checkmarx One customers to use inside their own organisation ([PolyForm Internal Use 1.0.0](LICENSE)). It comes as is, with no warranty and no promise of support or fixes, and neither its author nor Checkmarx is responsible for how it is used or for any credit discrepancy. Its credit figures and audit reports are supporting information only, never evidence in a dispute with Checkmarx. Using it means accepting the [terms of use](TERMS.md), which an Admin accepts for the organisation at the first sign-in.

| You get | How |
| --- | --- |
| **Know what is ageing** | Every project's findings bucketed by first detection (≤ 30, 31–60, > 60 days), streamed in as they are read. **Stop** part-way keeps what has loaded, ready to use. |
| **SLAs (Beta)** | Days to fix each severity: what is past its SLA and due within 7 days, in total and per project, and one escalation email per finding that goes past it. |
| **The right person, only their projects** | Reminders go to whoever ran each project's latest scan, by email, as a summary or one per project. The server refuses any email that would show someone a project they did not scan. |
| **Fix from the inbox** | An interactive report in every email: **Triage** and **Remediate** with Checkmarx One AI, see the verdict, open the pull request. Developers pick their IDE once (VS Code, Cursor, Kiro, Windsurf, Antigravity, JetBrains). Then every finding is **Open in …** and **Apply AI fix**, one click each: the fix Checkmarx One AI Remediation wrote lands in their own checkout, even when there is no pull request. |
| **Credits under control** | A credit pool, and per-project allocations, given on the Dashboard or on Credit Control. Every action re-checks Checkmarx One twice first and stops if anyone changed the findings meanwhile. Never two requests for one vulnerability, and unused credits are taken back. |
| **See the way to zero** | One slim line on the Dashboard: how many projects are at zero, and Detect → Triage → Remediate → Fix → Verify with a count at each stage. The stage to act on next is highlighted, and one click opens what moves it on. |
| **Prove it with a rescan** | When a tracked scope's findings are all dealt with, the developers who fixed them get the **Rescan** button first (24 hours to 14 days, 48 by default). If they don't, CxMissionZero rescans in Checkmarx One on their behalf and tells them. Either way it shows what is really fixed, which fixes did not work, and what is new. Then it starts the next round, for example medium and low, until everything is at zero, and keeps watching it stays there. |
| **Updates itself** | Settings → Update & recovery: update to any published version (or back) in one click, or let it auto-update in a quiet hour. Each download is checked against the image's digests, a backup is taken first, and a version that does not start is rolled back by itself. Nobody signs in to the server. For the rare release that needs a new base image, an optional update companion (Beta) replaces the whole container from the same page. |
| **Prove the return** | The **Impact** page shows the hours AI saved, the money they are worth after credits, the findings AI showed not exploitable, and time to fix with AI against by hand. It also tracks the security debt week by week and when it reaches zero at the current pace. The CISO tab has six figures and one chart; the AppSec tab has every project. A one-page summary can be downloaded, or emailed each month. Every figure says how it was worked out, and a fix counts only once Checkmarx One no longer reports it ([impact](docs/impact.md)). |
| **Help built in** | **Get help** at the bottom of the sidebar: submit a support case or request an enhancement. Each gets a number by email (SUP-0001, ENH-0001). The person can follow it and talk with the support team, who answer, move it on and mark it completed, with an email at every step. On an offline server, an Admin can send Get help by email to a set address instead ([support](docs/support.md)). |
| **Hands-off, if you want** | For teams that don't want one more tool to look after: set it up once in four questions (Settings → Hands-off). MissionZero then reminds developers on its own and emails a short weekly status with buttons: send now, pause, resume, stop. People can also reply with one word, such as PAUSE or RUN. Nobody has to sign in ([hands-off](docs/hands-off.md)). |
| **Looks after itself** | Every 5 minutes it checks Checkmarx One, the email server, its automatic runs and its error rate. It puts back the last working connection, signs in again, or goes back to the previous version if a new one broke something. It emails the administrators, and with auto-update on it raises a support case for them to forward to the maintainer. They close it with a link or a reply. If the service is stopped, killed or crashes, it backs up first and emails the administrators the encrypted copy with how to restore it. With a backup mailbox (`BACKUP_EMAIL`), every backup goes there too, and a new server restores the newest one by itself on its first start ([hands-off](docs/hands-off.md), [backups](docs/audit-and-backup.md)). |
| **Your brand in demos** | Each Admin and Security Analyst can set their own names, logo and colours under Settings → Your branding. The reports and reminders they make then carry them, while everyone else keeps the organisation's. Permissions decide who sees the Branding and Activation codes pages. People & roles shows each person only their own level and below, so analysts never see who the Admins are ([branding](docs/branding.md)). |
| **Hands-off follow-up** | Age-threshold automation that never nags twice, and tracked reports that measure progress and send follow-ups. |
| **Accountable** | A hash-chained audit log of every credit and change, role-based access, one-file backups, and a privacy-safe troubleshooting log. |
| **Easy to work in** | Pages grouped as Act, Follow up, Prove and Set up, in tabs instead of long scrolls; every page keeps your work when you switch; Jump to (Ctrl K); a layout that fits phone, tablet, laptop and wide screens. |
| **In your language** | Menus and options in Japanese, Traditional Chinese (Taiwan), Simplified Chinese, Korean, Spanish, Brazilian Portuguese, German, French, Arabic, Vietnamese, Thai, Malay and Indonesian, as well as English; Hebrew with an activation code, for the people an Admin chooses. Arabic and Hebrew read right to left. Each translation was checked by two separate reviews and by automated checks ([languages](docs/languages.md)). Each person has a profile with their own picture, language, time zone (picked up from their computer) and programming languages. |
| **Scales** | 3000 people at once on 2 vCPU / 4 GB, 6 failed of 64,320 requests; a report opens in 53 ms (p50) ([benchmark](docs/performance.md)). |

## Architecture

![CxMissionZero architecture: people use the web app; CxMissionZero reads Checkmarx One, emails each developer their own projects, and developers triage and remediate from the report through CxMissionZero, which calls Checkmarx One AI; fixes land as pull requests](docs/architecture.svg)

**How a finding gets fixed** (the numbers match the diagram)
1. **Fetch.** CxMissionZero reads projects, developers and findings from Checkmarx One with one integration key, and ages each finding.
2. **Remind.** A reminder emails each developer their own projects through your SMTP server, with the interactive report attached. It is sent by hand, by automation, or from a tracked report.
3. **Act from the report.** The developer clicks **Triage** or **Remediate**. The report calls CxMissionZero, never Checkmarx One directly, and CxMissionZero checks the finding's signed grant and its project's credits.
4. **AI runs.** CxMissionZero calls Checkmarx One AI Triage or AI Remediation. However many people click at once, one vulnerability is sent only once.
5. **Fix lands.** AI Remediation opens a pull request on the developer's repository.

Every credit and change is recorded in the audit log. The Dashboard, tracked reports and Credit Control show progress toward zero.

More detail: [How it works](docs/how-it-works.md).

## Run it

You need Podman or Docker, a Checkmarx One API key, and an SMTP server. The commands below are for Windows cmd; they work the same in PowerShell, bash and zsh. Each one is a single line.

**Podman**

```
podman run -d --name mission-zero -p 3000:3000 -v mission-zero-data:/data -e TZ=Asia/Dubai --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

```
podman logs mission-zero
```

The log prints the first administrator's email and password, once. Open <https://localhost:3000>, sign in, and choose your own password.

**HTTPS is the default.** With no certificate given, the server makes a self-signed one, so the browser warns once ("Your connection is not private": **Advanced**, then continue). For a real certificate, see [HTTPS](#https).

**Plain http on your own machine:** add `-e HTTPS=off`, then open <http://localhost:3000>:

```
podman run --replace -d --name mission-zero -p 3000:3000 -v mission-zero-data:/data -e TZ=Asia/Dubai -e HTTPS=off --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

**Docker:** the same commands with `docker` in place of `podman`.

**With your settings file**: fill in the [sample .env](public/sample.env), then:

```
podman run -d --name mission-zero -p 3000:3000 -v mission-zero-data:/data --env-file mission-zero.env ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

**Sized for up to 3000 people at once** (2 vCPU, 4 GB host):

```
podman run -d --name mission-zero -p 3000:3000 -v mission-zero-data:/data -e TZ=Asia/Dubai -e NODE_OPTIONS=--max-old-space-size=2048 --cpus 2 --memory 3g --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

**Another port** (e.g. 3001): change the left side only, `-p 3001:3000`, and open <https://localhost:3001> (or <http://localhost:3001> with `HTTPS=off`).

**Update without losing anything:** download first, then swap. Use the command you started with: add `-e HTTPS=off` if you run plain http, or use your [HTTPS](#https) command if you gave a certificate.

```
podman pull ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

```
podman run --replace -d --name mission-zero -p 3000:3000 -v mission-zero-data:/data -e TZ=Asia/Dubai --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

Use the same options you started it with. What carries over:
- **The swap.** The running server finishes what it is doing and hands over to the new version in a few seconds. Browsers and emailed reports reconnect by themselves.
- **People** stay signed in with the data they fetched.
- **All data** stays in the volume: credits, the audit log, settings.

The version shows bottom-left as `MZ-xx.xx.xx`. Details and rollback: [Updating](docs/updating.md).

**Compose** (from a checkout): `podman compose up -d`. It binds to `127.0.0.1` unless `BIND_ADDRESS=0.0.0.0` is set in `.env`.

**Without a container** (Node 20+): `npm install`, then `npm start`.

More container options: [docs/container.md](docs/container.md).

## HTTPS

**No certificate from your organisation? One setting.** With a DNS name pointing at the server and port 80 open to the internet:

```
podman run --replace -d --name mission-zero -p 80:3000 -p 443:3000 -v mission-zero-data:/data -e TZ=Asia/Dubai -e LETSENCRYPT_DOMAIN=mz.company.com -e LETSENCRYPT_EMAIL=appsec@company.com --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

The server gets a free Let's Encrypt certificate, switches to HTTPS only, and renews it by itself. Setting `LETSENCRYPT_DOMAIN` means you accept the [Let's Encrypt Subscriber Agreement](https://letsencrypt.org/repository/). It is also one button under Settings → HTTPS. More: [docs/https-and-hosting.md](docs/https-and-hosting.md#b-free-certificate-from-lets-encrypt-public-name).

**From the Settings page (recommended with your organisation's certificate).** An Admin moves a running server to HTTPS under **Settings → HTTPS**, with no new command and no restart:

1. **Certificate.** Drop in the files from IT (certificate, chain, key, or one `.pfx`). It is checked the way a browser would before anything changes: the key, the chain, the names people use, the dates. No certificate yet? **Create a request (CSR) for IT** there; the key stays on the server.
2. **Turn on HTTPS next to http.** The same address and port answer both `http://` and `https://`. Nobody is cut off.
3. **Test it.** Open the https address, and check your browser accepts it. Emailed reports switch to HTTPS by themselves where it works, and the page counts report opens over each.
4. **Switch to HTTPS only,** from a page open over HTTPS. Plain http then redirects to https, and older reports are told the new address.
5. **Harden:** HSTS (start with 1 day), and TLS 1.3 only if you want.

**Replacing a certificate** (a renewal, or another one) works the same way: upload it, it is checked, and it goes into use at once. The previous one is kept, to put back in one click. **Locked out?** `podman exec mission-zero node scripts/https.mjs both` brings http back next to HTTPS within 5 seconds.

**From the container options** instead: the image starts with `HTTPS=on` (HTTPS only, self-signed until a certificate is given). `HTTPS=off` starts with plain http, `HTTPS=both` with both. Once an Admin changes it on the Settings page, the page's choice is kept across restarts and updates. Ways to give the certificate on the command line:

In every command below, replace `mz.company.com` with your server's name.

**A. Your company's certificate.** Put `server.crt` (with its chain) and `server.key` in `C:\mission-zero\certs`, then:

```
podman run --replace -d --name mission-zero -p 443:3000 -p 80:8080 -v mission-zero-data:/data -v C:\mission-zero\certs:/certs:ro -e TZ=Asia/Dubai -e TLS_CERT_FILE=/certs/server.crt -e TLS_KEY_FILE=/certs/server.key -e HTTP_REDIRECT_PORT=8080 -e REPORT_SERVER_URL=https://mz.company.com --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

- **With a `.pfx` instead:** replace the two `TLS_CERT_FILE` / `TLS_KEY_FILE` options with `-e TLS_PFX_FILE=/certs/server.pfx -e TLS_PFX_PASSPHRASE=…`.
- **Port 80** (`-p 80:8080` and `HTTP_REDIRECT_PORT`) only sends `http://` visitors to `https://`.
- **Renewals:** copy the renewed files over the old ones. It switches over within 5 minutes, with no restart.

**B. Automatic certificate** (public name): `LETSENCRYPT_DOMAIN`, above, does it with no proxy. Or Caddy in front: it fetches and renews the certificate and speaks plain http to CxMissionZero on their private network (hence `HTTPS=off`); CxMissionZero has no port of its own:

```
podman network create mz-net
```

```
podman run --replace -d --name mission-zero --network mz-net -v mission-zero-data:/data -e TZ=Asia/Dubai -e HTTPS=off -e REPORT_SERVER_URL=https://mz.company.com --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

```
podman run --replace -d --name mz-caddy --network mz-net -p 80:80 -p 443:443 -v caddy-data:/data --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges:true docker.io/library/caddy:2 caddy reverse-proxy --from mz.company.com --to mission-zero:3000
```

**C. Self-signed** (try it out): what the image does when no certificate is given. `TLS_HOSTNAMES` adds names to it. Then open <https://localhost:3443>:

```
podman run --replace -d --name mission-zero -p 3443:3000 -v mission-zero-data:/data -e TZ=Asia/Dubai -e TLS_HOSTNAMES=mz.company.com --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

**Check it worked**
- `podman logs mission-zero` shows `running on https://…`, and for A and C the certificate's name and expiry date. Self-signed also logs a warning: fine to try it out, not for everyday use. A certificate that does not fit its key, or a wrong `.pfx` password, stops the start with the reason; it never falls back to plain http.
- The browser shows the padlock at `https://mz.company.com`.
- **Settings → Reminder server address** shows the `https://` address, so new emailed reports use it. It comes from `REPORT_SERVER_URL`, unless an address was saved on that page before: then change it there, and click **Test**.

**After switching to HTTPS**
- **People sign in once** at the new address.
- **Reports emailed before the switch** still carry the old address. Readers click **Change** next to the server address in the report and enter the new one once; the report remembers it.
- **Updating:** `podman pull`, then the same command you started with, including its HTTPS options.
- **"Permission denied" on ports 80 / 443** (Podman on Windows): run `podman machine stop`, `podman machine set --rootful`, `podman machine start`. Or use `-p 8443:3000 -e HTTPS_PUBLIC_PORT=8443` and the address `https://mz.company.com:8443`.

Step by step, and what to do when it goes wrong: [User guide → Turn on HTTPS](docs/user-guide.md#turn-on-https). Other reverse proxies, all the options, and a checklist for hosting it safely: [HTTPS and hosting](docs/https-and-hosting.md).

## Configure

**The quickest way:** go to **Settings → Quick setup from a .env file** and **Download the sample .env**. Fill in your Checkmarx One key and mail server, then upload the file. Every connection is checked at once, and one that does not work is rolled back to the last known good settings. Everything else is set on the Settings page, which saves as you type. Step by step: [Set up in 10 minutes](docs/user-guide.md#set-up-in-10-minutes).

**All options.** Every one is optional. Set them with `-e NAME=value`, `--env-file`, or upload them on Settings (the ones marked ⬆).

| Option | What for |
| --- | --- |
| **Checkmarx One** | |
| `CX_API_KEY` ⬆ | The integration key: password sign-ins, report triage, automation. An Admin can also store it in Settings. |
| `CX_BASE_URL`, `CX_IAM_URL`, `CX_TENANT` ⬆ | Single-tenant / on-prem only. Otherwise worked out from the key. |
| `CX_RISK_SOURCE`, `CX_RISKS_PATH` | Where findings come from (`risk-insights` with `/api/risks/`, or `scan-results`). `/api/risks/ai-insights` adds AI status. |
| `CX_MAX_CONCURRENCY` (24), `CX_FETCH_CONCURRENCY` (10), `CX_PAGES_AT_ONCE` (4) | Calls to Checkmarx One at once; projects read at once per fetch; pages of one big project read at once. |
| `HTTP_COMPRESSION` (on), `HTTP_COMPRESSION_MIN_KB` (32) | Compress big replies (the page, the fetch stream, downloads). `off` when your reverse proxy compresses. |
| `CX_FETCH_CACHE_SECONDS` (120) | A project someone fetched this recently is reused by the next fetch (same key, same latest scan, not triaged from here since). `0` switches it off. |
| **Email** | |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` ⬆ | The mail server. 465 needs `SMTP_SECURE=true`; 587 / 25 / 2525 need `false`. |
| `SMTP_USER`, `SMTP_PASS` ⬆ | The sending account (Gmail: an App Password). |
| `SMTP_FROM`, `SMTP_FROM_NAME`, `SMTP_REQUIRE_AUTH`, `SMTP_REJECT_UNAUTHORIZED` ⬆ | Sender, and authentication / certificate checks. |
| **Reports** | |
| `REPORT_SERVER_URL` ⬆ | The HTTPS address developers' reports use to reach this server. |
| `REPORT_SIGNING_KEY` | Signs report permissions. Default: a key generated in `/data`. |
| `RELAY_MAX_IN_FLIGHT` (300), `RELAY_BACKGROUND_QUEUE` (2000) | Report requests at once before "busy, retry"; queued background lookups. |
| **People** | |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | The first administrator, created on first start. Default `admin@mission-zero.local` with a generated password printed in the log. |
| `FIRST_ADMIN=setup-code` | Create the first administrator in the browser with a code from the log instead. |
| `ACCEPT_TERMS` | Your email address: you accept the [terms of use](TERMS.md) for the organisation and everyone using this installation (for automated setups; recorded under your name). Unset, an Admin accepts them in the app at the first sign-in. |
| `SESSION_IDLE_MINUTES` (480) | Idle sign-ins end after this. |
| `SESSION_SAVE_SECONDS` (30) | A signed-in person's fetched data is saved at once, then at most this often while it keeps changing (it survives updates and restarts). |
| **GitHub (Beta)** | |
| `GITHUB_TOKEN` ⬆ | A GitHub token for the Beta features (code authors, username matching). |
| `GITHUB_API_URL`, `GITHUB_ORG` ⬆ | GitHub Enterprise API (e.g. `https://github.company.com/api/v3`), and your organisation. |
| `GITLAB_TOKEN`, `GITLAB_URL`, `GITLAB_GROUP` ⬆ | GitLab (gitlab.com or self-managed) for the Beta features. |
| `AZURE_DEVOPS_TOKEN`, `AZURE_DEVOPS_ORG_URL` ⬆ | Azure DevOps for the Beta features: the organisation as `https://dev.azure.com/acme`, `acme`, a project page in it, or `https://acme.visualstudio.com`. |
| `BITBUCKET_TOKEN`, `BITBUCKET_USERNAME`, `BITBUCKET_WORKSPACE`, `BITBUCKET_URL` ⬆ | Bitbucket Cloud (app password with username, or an access token), or Data Center (its address and an HTTP access token), for the Beta features. |
| `GITHUB_TOKEN_2` … `_9` (and `GITHUB_API_URL_2`, `GITLAB_TOKEN_2`, `GITLAB_URL_2`, `AZURE_DEVOPS_TOKEN_2`, `BITBUCKET_TOKEN_2` …) ⬆ | More connections to the same host: a second GitHub, another GitLab or Azure DevOps organisation. Each shows as its own logo on the header's **Git** indicator. |
| `SCM_ALLOWED_HOSTS` | Other git hosts (comma-separated) whose repositories the Beta features may clone. github.com, gitlab.com, bitbucket.org, dev.azure.com and the connected hosts are always allowed; nothing else is cloned. |
| `UPDATE_IMAGE`, `UPDATE_REGISTRY_TOKEN`, `UPDATE_START_TIMEOUT_SECONDS` (150) | Settings → Update & recovery: where updates come from (a private copy of the image, and a token that can read it), and how long a new version may take to start before it is rolled back. |
| **Server** | |
| `HTTPS` (`on` in the image) | How it starts: `on` HTTPS only (self-signed when no certificate is given), `off` plain http (your own machine, or behind a reverse proxy), `both` side by side. **Settings → HTTPS** changes it while running. |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` (or `TLS_PFX_FILE`, `TLS_PFX_PASSPHRASE`), `TLS_SELF_SIGNED` | Serve HTTPS: your certificate, a `.pfx`, or a self-signed one ([HTTPS and hosting](docs/https-and-hosting.md)). |
| `HTTP_REDIRECT_PORT`, `HTTPS_PUBLIC_PORT` (443), `TRUST_PROXY` | Redirect plain http to https; whose `X-Forwarded-*` headers to believe (a proxy on this machine, loopback, by default; nobody when serving HTTPS itself; name a proxy in another container or machine, e.g. `uniquelocal` or its address). |
| `TZ` | Time zone for automation and email dates, e.g. `Asia/Dubai`. Default UTC. |
| `NODE_OPTIONS` | e.g. `--max-old-space-size=2048` with `--memory 3g`. |
| `NODE_EXTRA_CA_CERTS` | A company CA, when a proxy inspects TLS. |
| `BACKUP_INTERVAL_HOURS` (24), `BACKUP_KEEP` (14), `BACKUP_PASSPHRASE`, `BACKUP_DIR` | Scheduled, optionally encrypted backups of `/data`. |
| `SHUTDOWN_DRAIN_SECONDS` (8), `INSTANCE_LOCK_WAIT_SECONDS` (45) | Updates: how long running requests may finish when stopping; how long a new server waits for the old one ([Updating](docs/updating.md)). |
| `CONNECTION_CHECK_TIMEOUT_MS` (25000), `CONFIG_ROLLBACK_IDLE_MINUTES` (10) | When a changed connection counts as failed, and when an unattended one is rolled back. |
| `PORT` (3000), `HOST`, `DATA_DIR` | Outside a container only; the image sets them. |

## Performance and security status

Every release is load-tested and checked before it ships. These are the latest; [every version since the first](docs/status.md) is kept.

| Version | Requests/s, failed (3000 users, 2 vCPU) | Report opens p95 | Triage polls p95 | Tests | Dependencies (`npm audit`) | Checkmarx One scan of this code |
| --- | --- | --- | --- | --- | --- | --- |
| **MZ-01.00.55** | 522/s, 0 failed (main 514, 0 failed) | 4.7 s | 311 ms | 534 pass | 0 vulnerabilities | No new scan. Open: the 53 of rescan 27982f85 (MZ-01.00.52), all judged not exploitable |
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

How it is measured, and what is open and why: [Performance and security status](docs/status.md). Sizing: [Performance and sizing](docs/performance.md).

## Documentation

| | |
| --- | --- |
| [User guide](docs/user-guide.md) | Every page and option, step by step, for administrators, analysts and developers. With recipes and troubleshooting. |
| [How it works](docs/how-it-works.md) | Architecture, the Checkmarx One API, credits and safety nets, storage, security. |
| [Updating](docs/updating.md) | New versions without downtime, sign-outs or data loss; rollback. |
| [HTTPS and hosting](docs/https-and-hosting.md) | Your certificate, automatic Let's Encrypt, or self-signed; and a checklist for hosting it safely. |
| [Containers](docs/container.md) | Docker / Podman / Compose options, proxies. |
| [Performance and sizing](docs/performance.md) | The 3000-user benchmark and the recommended server size. |
| [Performance and security status](docs/status.md) | Every version's benchmark, tests, dependency audit and Checkmarx One scan result. |
| [Audit log and backups](docs/audit-and-backup.md) | The tamper-evident audit log, backups, restore, moving servers. |
| [Languages](docs/languages.md) | The fifteen languages, right-to-left Arabic and Hebrew, and how translations are kept current and reviewed. |
| [Several tenants](docs/multi-tenant.md) | One server for several Checkmarx One tenants, each with its own connection, settings, credits, reports, audit log and people; a Super Admin manages them (with an activation code). |
| [Hands-off and self-healing](docs/hands-off.md) | Set it up once, steer it by email (links and one-word replies), and how it checks, repairs and reports on itself. |
| [Activation codes](docs/activation-codes.md) | Add-ons unlocked with a code (Hebrew; several Checkmarx One tenants): applying one, and how they are issued. |
| [Beta features](docs/beta-features.md) | Emailing the authors of vulnerable code (git blame, down to the exact developer), and matching usernames to addresses, on GitHub, GitLab, Azure DevOps and Bitbucket. An Admin makes each one final when it has proved itself. |

## Licence, terms of use and contributing

- **[LICENSE](LICENSE): PolyForm Internal Use License 1.0.0.** Any organisation, every Checkmarx One customer included, may run and adapt CxMissionZero for its own internal business. Selling it, sublicensing it, distributing it or running it as a service for others is not allowed.
- **[TERMS.md](TERMS.md): the terms of use and disclaimer.**
  - It is independent of Checkmarx, and comes as is, with no warranty, support or fixes.
  - Neither the author nor Checkmarx is liable for its use or for credit discrepancies.
  - Credit figures, the audit log and reports are supporting information only, not for claims or disputes with Checkmarx.
- **Read them in the app:** Settings → About & terms of use.
- **Who accepts, and when.**
  - **In the app:** after the first sign-in, an Admin accepts the terms for the organisation before anything can be used, including emailed reports and automation. Each person then accepts them once. Changed terms are asked for again, and every acceptance is in the audit log.
  - **Automated setups:** `ACCEPT_TERMS=<your email>` accepts them for the organisation and everyone, on record under that name.
- **[CONTRIBUTING.md](CONTRIBUTING.md):** improvements are welcome, as issues and pull requests.
- **[CHANGELOG.md](CHANGELOG.md):** every version, when it was released, and what it brought.

## Develop

```bash
npm install
npm test                          # unit and end-to-end tests (mock Checkmarx One, fake mail server)
npm start                         # http://127.0.0.1:3000
loadtest/benchmark.sh 3000 120    # mixed-load benchmark
```

The version is `version` in `package.json`, shown as `MZ-xx.xx.xx` and bumped with every change merged to `main`. Pushing to `main` publishes `ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest` after a container smoke test.
