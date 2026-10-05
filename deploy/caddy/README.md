# Automatic HTTPS with Caddy

Use this when you will **not** get a certificate from your organisation and want
HTTPS that browsers trust and that renews itself. [Caddy](https://caddyserver.com)
gets a free certificate from Let's Encrypt, renews it on its own, and forwards to
CxMissionZero, which runs plain http behind it (`HTTPS=off`).

Recommended over building Let's Encrypt into the app: Caddy is a dedicated,
battle-tested TLS front door, and CxMissionZero needs no code change.

## What you need

- A **DNS name** (e.g. `mz.company.com`) pointing at this server's public address.
- Ports **80 and 443** reachable from the internet (Let's Encrypt verifies over them).

## Start it

Commands are written for Windows cmd, one line each; they work the same in
PowerShell, bash and zsh. Run them from this folder (`deploy/caddy`).

```
set MZ_DOMAIN=mz.company.com
```

```
set ACME_EMAIL=appsec@company.com
```

```
docker compose -f compose.yaml up -d
```

(or `podman compose -f compose.yaml up -d`). Then open `https://mz.company.com`.
The first start prints the administrator sign-in:

```
docker compose -f compose.yaml logs mission-zero
```

## Internal-only server (no public DNS)

Let's Encrypt cannot verify a server it cannot reach. Add this one line inside the
site block of `Caddyfile`:

```
tls internal
```

Caddy then issues a **locally-trusted** certificate. Install Caddy's root CA
(in the `caddy-data` volume, under `caddy/pki/authorities/local/root.crt`) on the
machines that open CxMissionZero, so they trust it.

## How it fits together

- **Caddy does HTTPS**; it speaks plain http to CxMissionZero over the private
  `mz-net`, so the app runs with `HTTPS=off`.
- Caddy passes the real client address and the `https` scheme on, which
  CxMissionZero reads because `TRUST_PROXY=uniquelocal` — and only Caddy can reach
  the app, since it publishes no port of its own. So cookies are `Secure`, HSTS is
  on, and the audit log shows real addresses.
- `REPORT_SERVER_URL` is set to `https://$MZ_DOMAIN`, so emailed reports link back
  over HTTPS too.
- **Updating** CxMissionZero: `docker compose -f compose.yaml pull mission-zero`
  then `docker compose -f compose.yaml up -d`. Caddy and the certificate are untouched.

See also `docs/https-and-hosting.md` for the other ways to serve HTTPS (your own
certificate, container TLS files, or the self-signed fallback).
