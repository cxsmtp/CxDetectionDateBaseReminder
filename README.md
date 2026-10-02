# Mission Zero

**Drive Checkmarx One findings to zero.** Mission Zero shows which vulnerabilities have sat unfixed and for how long, and emails each developer *their own* findings. Developers can then triage and fix them with Checkmarx One AI straight from that email, with every credit accounted for.

Self-hosted, one container, nothing to install for developers.

| You get | How |
| --- | --- |
| **Know what is ageing** | Every project's findings bucketed by first detection (≤ 30, 31–60, > 60 days), streamed in as they are read. |
| **The right person, only their projects** | Reminders go to whoever ran each project's latest scan, by email, as a summary or one per project. The server refuses any email that would show someone a project they did not scan. |
| **Fix from the inbox** | An interactive report in every email: **Triage** and **Remediate** with Checkmarx One AI, see the verdict, open the pull request. |
| **Credits under control** | A credit pool, and per-project allocations. Every action re-checks Checkmarx One twice first and stops if anyone changed the findings meanwhile. Never two requests for one vulnerability, and unused credits are taken back. |
| **Hands-off follow-up** | Age-threshold automation that never nags twice, and tracked reports that measure progress and send follow-ups. |
| **Accountable** | A hash-chained audit log of every credit and change, role-based access, one-file backups, and a privacy-safe troubleshooting log. |
| **Scales** | 3000 people at once on 2 vCPU / 4 GB, 6 failed of 64,320 requests; a report opens in 53 ms (p50) ([benchmark](docs/performance.md)). |

## Architecture

![Mission Zero architecture: people use the web app; Mission Zero reads Checkmarx One, emails each developer their own projects, and developers triage and remediate from the report through Mission Zero, which calls Checkmarx One AI; fixes land as pull requests](docs/architecture.svg)

**How a finding gets fixed** (the numbers match the diagram)
1. **Fetch.** Mission Zero reads projects, scan initiators and findings from Checkmarx One with one integration key, and ages each finding.
2. **Remind.** A reminder emails each developer their own projects through your SMTP server, with the interactive report attached. It is sent by hand, by automation, or from a tracked report.
3. **Act from the report.** The developer clicks **Triage** or **Remediate**. The report calls Mission Zero, never Checkmarx One directly, and Mission Zero checks the finding's signed grant and its project's credits.
4. **AI runs.** Mission Zero calls Checkmarx One AI Triage or AI Remediation. However many people click at once, one vulnerability is sent only once.
5. **Fix lands.** AI Remediation opens a pull request on the developer's repository.

Every credit and change is recorded in the audit log. The Dashboard, tracked reports and the Credits page show progress toward zero.

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

The log prints the first administrator's email and password, once. Open <http://localhost:3000>, sign in, and choose your own password.

**Docker:** the same commands with `docker` in place of `podman`.

**With your settings file**: fill in the [sample .env](public/sample.env), then:

```
podman run -d --name mission-zero -p 3000:3000 -v mission-zero-data:/data --env-file mission-zero.env ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

**Sized for up to 3000 people at once** (2 vCPU, 4 GB host):

```
podman run -d --name mission-zero -p 3000:3000 -v mission-zero-data:/data -e TZ=Asia/Dubai -e NODE_OPTIONS=--max-old-space-size=2048 --cpus 2 --memory 3g --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

**Another port** (e.g. 3001): change the left side only, `-p 3001:3000`, and open <http://localhost:3001>.

**Update without losing anything:** download first, then swap.

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

**HTTPS** (do this before anyone else uses it). With your company's certificate in `C:\mission-zero\certs`:

```
podman run --replace -d --name mission-zero -p 443:3000 -p 80:8080 -v mission-zero-data:/data -v C:\mission-zero\certs:/certs:ro -e TZ=Asia/Dubai -e TLS_CERT_FILE=/certs/server.crt -e TLS_KEY_FILE=/certs/server.key -e HTTP_REDIRECT_PORT=8080 -e REPORT_SERVER_URL=https://mz.company.com --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

The other ways:
- a `.pfx`;
- automatic Let's Encrypt certificates through Caddy, for a public name;
- a self-signed certificate, to try it out.

The guide also has a checklist for hosting it safely: [HTTPS and hosting](docs/https-and-hosting.md). More container options and upgrades are in [docs/container.md](docs/container.md).

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
| `SESSION_IDLE_MINUTES` (480) | Idle sign-ins end after this. |
| **GitHub (Beta)** | |
| `GITHUB_TOKEN` ⬆ | A GitHub token for the Beta features (code authors, username matching). |
| `GITHUB_API_URL`, `GITHUB_ORG` ⬆ | GitHub Enterprise API (e.g. `https://github.company.com/api/v3`), and your organisation. |
| **Server** | |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` (or `TLS_PFX_FILE`, `TLS_PFX_PASSPHRASE`), `TLS_SELF_SIGNED` | Serve HTTPS: your certificate, a `.pfx`, or a self-signed one ([HTTPS and hosting](docs/https-and-hosting.md)). |
| `HTTP_REDIRECT_PORT`, `HTTPS_PUBLIC_PORT` (443), `TRUST_PROXY` | Redirect plain http to https; whose `X-Forwarded-*` headers to believe (private networks by default; nobody when serving HTTPS itself). |
| `TZ` | Time zone for automation and email dates, e.g. `Asia/Dubai`. Default UTC. |
| `NODE_OPTIONS` | e.g. `--max-old-space-size=2048` with `--memory 3g`. |
| `NODE_EXTRA_CA_CERTS` | A company CA, when a proxy inspects TLS. |
| `BACKUP_INTERVAL_HOURS` (24), `BACKUP_KEEP` (14), `BACKUP_PASSPHRASE`, `BACKUP_DIR` | Scheduled, optionally encrypted backups of `/data`. |
| `SHUTDOWN_DRAIN_SECONDS` (8), `INSTANCE_LOCK_WAIT_SECONDS` (45) | Updates: how long running requests may finish when stopping; how long a new server waits for the old one ([Updating](docs/updating.md)). |
| `CONNECTION_CHECK_TIMEOUT_MS` (25000), `CONFIG_ROLLBACK_IDLE_MINUTES` (10) | When a changed connection counts as failed, and when an unattended one is rolled back. |
| `PORT` (3000), `HOST`, `DATA_DIR` | Outside a container only; the image sets them. |

## Documentation

| | |
| --- | --- |
| [User guide](docs/user-guide.md) | Every page and option, step by step, for administrators, analysts and developers. With recipes and troubleshooting. |
| [How it works](docs/how-it-works.md) | Architecture, the Checkmarx One API, credits and safety nets, storage, security. |
| [Updating](docs/updating.md) | New versions without downtime, sign-outs or data loss; rollback. |
| [HTTPS and hosting](docs/https-and-hosting.md) | Your certificate, automatic Let's Encrypt, or self-signed; and a checklist for hosting it safely. |
| [Containers](docs/container.md) | Docker / Podman / Compose options, proxies. |
| [Performance and sizing](docs/performance.md) | The 3000-user benchmark and the recommended server size. |
| [Audit log and backups](docs/audit-and-backup.md) | The tamper-evident audit log, backups, restore, moving servers. |
| [Beta features](docs/beta-features.md) | Emailing the authors of vulnerable code; GitHub username matching. |

## Develop

```bash
npm install
npm test                          # unit and end-to-end tests (mock Checkmarx One, fake mail server)
npm start                         # http://127.0.0.1:3000
loadtest/benchmark.sh 3000 120    # mixed-load benchmark
```

The version is `version` in `package.json`, shown as `MZ-xx.xx.xx` and bumped with every change merged to `main`. Pushing to `main` publishes `ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest` after a container smoke test.
