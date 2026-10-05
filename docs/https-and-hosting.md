# HTTPS and hosting

Everything people send to CxMissionZero is sensitive: sign-ins, the vulnerabilities in reports, and triage and remediation requests. Serve it over HTTPS only. Then nobody on the network can read it or change it on the way.

The container image serves HTTPS by default (`HTTPS=on`): with your certificate when you give one, otherwise with a self-signed one it makes (way C). A production release never serves plain http by accident. `HTTPS=off` turns it off: for your own machine, or behind a reverse proxy that does HTTPS (way B).

**The easiest way: Settings → HTTPS** (Admin). On the running server, with no new command:
1. upload the certificate (or create a request for IT there), checked like a browser would;
2. turn on HTTPS next to http, on the same address and port;
3. test it; emailed reports switch to HTTPS by themselves where it works;
4. switch to HTTPS only;
5. add HSTS.

Replacing a certificate works the same way, and the previous one can be put back in one click. Step by step: [User guide → Turn on HTTPS](user-guide.md#turn-on-https). Way B (a reverse proxy in front) stays a container choice.

**One port, both protocols.** Every connection's first byte tells a TLS handshake from plain http, so `http://` and `https://` are answered on the same port. The published port never has to change, and http on an HTTPS-only server gets a redirect instead of an error.

Or pick one of the three ways below, from the container options. All the commands are for Windows cmd, one line each, and work the same in PowerShell and bash.

| Way | Use it when | You need |
| --- | --- | --- |
| **A. Your company's certificate**, served by CxMissionZero itself | It runs inside the company network or VPN (the usual case) | A certificate for its name from your company CA or IT: `server.crt` and `server.key`, or one `.pfx` and its password |
| **B. Automatic certificates** (Let's Encrypt, through Caddy) | It has a public name that the internet can reach | A DNS name (e.g. `mz.company.com`) pointing at the host, with ports 80 and 443 open to it |
| **C. Self-signed**, made by CxMissionZero (the default) | Trying it out, or a closed lab | Nothing. Browsers warn until the certificate is trusted |

## A. Your company's certificate

1. Ask IT for a server certificate for the name people will use, e.g. `mz.company.com`. The name must be in the certificate's *Subject Alternative Name*. Ask for the full chain (server and intermediate certificates in one file), or for a `.pfx`.
2. Put the files in a folder, e.g. `C:\mission-zero\certs`.
3. Start CxMissionZero with them:

```
podman run --replace -d --name mission-zero -p 443:3000 -p 80:8080 -v mission-zero-data:/data -v C:\mission-zero\certs:/certs:ro -e TZ=Asia/Dubai -e TLS_CERT_FILE=/certs/server.crt -e TLS_KEY_FILE=/certs/server.key -e HTTP_REDIRECT_PORT=8080 -e REPORT_SERVER_URL=https://mz.company.com --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

**With a `.pfx` instead:** replace the two `TLS_CERT_FILE` / `TLS_KEY_FILE` options with these:
- `-e TLS_PFX_FILE=/certs/server.pfx`
- `-e TLS_PFX_PASSPHRASE=…`

Better still, keep the password in an env file (`--env-file`) rather than on the command line.

**What happens:**
- **HTTPS on 443.** Only TLS 1.2 and 1.3 are accepted.
- **http redirects.** Plain `http://` on port 80 is redirected to `https://`. That's what `HTTP_REDIRECT_PORT=8080` does; leave it out if you don't want port 80.
- **Checked at start.** The log shows the certificate's name and expiry date. A certificate and key that don't match, or a wrong `.pfx` password, stop the start with the reason. A wrong certificate never results in plain http.
- **Renewals need no restart.** When IT gives you a renewed certificate, replace the files in the folder. CxMissionZero picks it up within 5 minutes.

**Ports 80 and 443.** On Windows, Podman may refuse ports below 1024 ("permission denied"). If so, either:
- run `podman machine stop`, then `podman machine set --rootful`, then `podman machine start`; or
- use other ports, e.g. `-p 8443:3000 -e HTTPS_PUBLIC_PORT=8443`, and tell people the address `https://mz.company.com:8443`.

**On Linux,** the key file must be readable by the container's user (uid 1000).

## B. Automatic certificates with Caddy (public name)

**Best choice when you will not get a certificate from your organisation.** Caddy gets a certificate from Let's Encrypt, renews it by itself, and forwards requests to CxMissionZero. CxMissionZero then has no published port of its own; only Caddy faces the network. You need a DNS name pointing at the server and ports 80 and 443 reachable from the internet.

**Ready-made setup:** [`deploy/caddy/`](../deploy/caddy/) has a compose file and `Caddyfile` that do all of this. Set your name and start it:

```
set MZ_DOMAIN=mz.company.com
```

```
cd deploy\caddy && docker compose up -d
```

(or `podman compose up -d`). An internal-only server (no public DNS) can use Caddy's locally-trusted certificate instead — see that folder's README. The manual equivalent, container by container:

```
podman network create mz-net
```

```
podman run --replace -d --name mission-zero --network mz-net -v mission-zero-data:/data -e TZ=Asia/Dubai -e HTTPS=off -e TRUST_PROXY=uniquelocal -e REPORT_SERVER_URL=https://mz.company.com --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

```
podman run --replace -d --name mz-caddy --network mz-net -p 80:80 -p 443:443 -v caddy-data:/data docker.io/library/caddy:2 caddy reverse-proxy --from mz.company.com --to mission-zero:3000
```

Replace `mz.company.com` with your name, in both places. Then open `https://mz.company.com`.

How it fits together:
- Caddy does HTTPS and speaks plain http to CxMissionZero on their private network, hence `HTTPS=off`. Without it, Caddy would reach a self-signed HTTPS server and fail.
- Caddy tells CxMissionZero the real client address and that the request was HTTPS.
- CxMissionZero believes those headers only from a proxy it is told to trust (`TRUST_PROXY`). Here that is `uniquelocal`: the private container network, which only Caddy can reach because CxMissionZero publishes no port. So cookies are `Secure`, HSTS is on, and the audit log shows real addresses.
- Updating CxMissionZero works as before: `podman pull`, then the same `podman run` line. Caddy keeps running.

**Another reverse proxy** (nginx, IIS / ARR, an F5, a cloud load balancer) works the same way:
- Terminate HTTPS there and forward to port 3000, with `-e HTTPS=off` on CxMissionZero (or forward to `https://…:3000` and have the proxy accept its certificate).
- Pass on `X-Forwarded-Proto`, `X-Forwarded-For` and `X-Forwarded-Host`.
- Unless the proxy runs on the same machine (and reaches CxMissionZero over `localhost`), set `TRUST_PROXY` to its address, e.g. `-e TRUST_PROXY=10.20.0.15`. Without it the proxy's headers are not believed: cookies are not marked `Secure` and the audit log shows the proxy's address.

**Why not trust the whole private network by default.** On a company network most people's computers have private addresses too. If every private address were trusted, anyone could send `X-Forwarded-For` and appear as any address in the audit log (and spread their sign-in attempts over made-up addresses). So by default only a proxy on this machine (`loopback`) is believed. Name your proxy's address, or its network (a CIDR such as `10.89.0.0/24`), and only if no one else can reach CxMissionZero directly from that network use `uniquelocal`.

## C. Self-signed (trying it out)

```
podman run --replace -d --name mission-zero -p 3443:3000 -v mission-zero-data:/data -e TZ=Asia/Dubai -e TLS_HOSTNAMES=mz.company.com --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

This is what the image does when no certificate is given; `TLS_HOSTNAMES` only adds names. Open `https://localhost:3443`. The browser warns once, because nobody vouches for the certificate.
- **The certificate.** CxMissionZero makes it at the first start and keeps it in the data volume (`/data/tls/self-signed.crt`) for about 13 months. It covers `localhost`, the host's name, and the names in `TLS_HOSTNAMES`. It is remade when the names change or it nears expiry.
- **No HSTS.** With a self-signed certificate CxMissionZero does not send HSTS, so a browser is never locked out of a site it can't verify. The log warns at every start that it is self-signed.
- **To stop the warning on your machines,** import that `.crt` as a trusted certificate. In practice it's simpler to switch to way A or B.

## Settings

| Option | Default | What for |
| --- | --- | --- |
| `HTTPS` | `on` in the image; unset with `npm start` | How it starts: `on` HTTPS only (your certificate, else self-signed; plain http on the same port redirects), `off` plain http, `both` side by side. Unset: HTTPS only when a certificate option is given. Once changed under **Settings → HTTPS**, the page's choice wins. |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | — | PEM certificate (with its chain) and key. CxMissionZero then serves HTTPS. |
| `TLS_KEY_PASSPHRASE` | — | If the key is encrypted. |
| `TLS_PFX_FILE`, `TLS_PFX_PASSPHRASE` | — | A `.pfx` / `.p12`, instead of the two PEM files. |
| `TLS_SELF_SIGNED` | off | `1`: make and use a self-signed certificate (what `HTTPS=on` does without a certificate). |
| `TLS_HOSTNAMES` | — | Extra names for the self-signed certificate (comma-separated). |
| `HTTP_REDIRECT_PORT` | — | Also listen for plain http on this port: redirected to https while HTTPS only. Rarely needed now: `-p 80:3000` does the same through the main port. |
| `HTTPS_PUBLIC_PORT` | 443 | The https port people use, for that redirect. |
| `TRUST_PROXY` | `loopback` (a proxy on this machine); nobody when CxMissionZero serves HTTPS itself | Whose `X-Forwarded-*` headers to believe: `off`, `on`, an address, a CIDR (comma-separated for several), `loopback`, or `uniquelocal` (every private address). Set it to your reverse proxy's address when the proxy runs in another container or on another machine. |
| `REPORT_SERVER_URL` | — | The `https://` address put into every emailed report. Set it to the name in the certificate. |

## What I need from you

- **The name** people will use (e.g. `mz.company.com`), and whether it is reachable from the internet or only inside the company or VPN.
- **For way A:**
  - the certificate for that name and its key (or a `.pfx` and its password), from IT;
  - a DNS record for the name, pointing at the host.
- **For way B:** a public DNS name for the host, and ports 80 and 443 open to it. Let's Encrypt checks the name over port 80.

## Hosting it safely: checklist

**Network**
- [ ] **Keep it internal if you can.** If everyone who uses the Dashboard or the reports is on the company network or VPN, don't expose it to the internet at all. That removes most risks at once.
- [ ] **If it must face the internet,** allow only your company's address ranges at the firewall where possible. Expose only 443, plus 80 for redirects and Let's Encrypt; never port 3000. With way B, CxMissionZero has no published port at all.
- [ ] **HTTPS only.** Use one of the three ways above. Set the **Reminder server address** (Settings) or `REPORT_SERVER_URL` to the `https://` name, so emailed reports use it too.

**Access**
- [ ] **Sign-ins.**
  - The first administrator must choose a new password at the first sign-in.
  - Give everyone else their own account with the least role they need (Access page).
  - Remove accounts people no longer need.
  - Sign-in attempts are limited per address (30 per 10 minutes), and that limit can't be dodged with forged headers.
- [ ] **The Checkmarx One key.** Use an integration key whose role covers only what CxMissionZero needs. Give it in an env file only you can read (`--env-file`), or on the Settings page. Never type it into a shared shell history.

**Data and email**
- [ ] **The data volume** holds settings, the audit log, the credit ledger, sign-ins and the report-signing key.
  - Back it up with a passphrase (`BACKUP_PASSPHRASE`), and copy the backups off the host (see [Audit log and backups](audit-and-backup.md)).
  - Only administrators of the host should be able to read the volume.
- [ ] **Mail.** Use port 587 with TLS (`SMTP_SECURE=false` upgrades with STARTTLS) or 465 (`SMTP_SECURE=true`). Leave certificate checks on: `SMTP_REJECT_UNAUTHORIZED` stays `true`.

**Running it**
- [ ] **Keep it current.** Pull the image regularly (`podman pull`, then the same `podman run`); updates carry security fixes for the base image too. Updating never signs people out ([Updating](updating.md)).
- [ ] **Keep the container hardened.** Keep the options in every command here: `--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true`. CxMissionZero runs as a non-root user.
- [ ] **Watch it.**
  - The **Audit log** records every sign-in, credit and change, and checks its own integrity.
  - The **Logs** page lists slow or failing operations.
  - `/api/health` is there for your monitoring.

**Already built in, nothing to do:**
- HTTPS by default in the container image, and run from **Settings → HTTPS** while it runs.
- Every certificate checked before use; the way back in: `podman exec mission-zero node scripts/https.mjs both`.
- HSTS (with a real certificate) and a strict Content Security Policy.
- No framing, no MIME sniffing.
- Same-origin checks on every change.
- `HttpOnly`, `SameSite`, `Secure` session cookies.
- Session IDs stored only hashed on disk.
- Signed, expiring permissions in every emailed report.
- Rate limits that answer "busy, retry" rather than fall over.
