# Run Mission Zero in a container (Docker or Podman)

One image runs on Linux, macOS (Intel and Apple Silicon) and Windows, under
Docker or Podman. Everything the utility keeps — settings, people and roles,
the credit ledger, the audit log, backups — lives in one volume, `/data`.

## One line

**With the published image** (built by `.github/workflows/container.yml` from
the default branch):

```
docker run -d --name mission-zero -p 3000:3000 -v mission-zero-data:/data ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

```
podman run -d --name mission-zero -p 3000:3000 -v mission-zero-data:/data ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

The same line works in PowerShell, cmd, bash and zsh.

If the repository is private, so is the image:
- Run `docker login ghcr.io` (or `podman login ghcr.io`) first, with a GitHub
  token that has `read:packages`.
- Or make the package public under the repository's **Packages** settings.

**From this folder** (builds the image the first time):

```
docker compose up -d
```

```
podman compose up -d
```

Then open <http://localhost:3000>.

## The administrator's sign-in

The first start creates an administrator and prints the sign-in once in the
container log:

```
docker logs mission-zero        # or: podman logs mission-zero / docker compose logs
```

```
================================================================
  First start: an administrator was created. Sign in with:
      Email:    admin@mission-zero.local
      Password: W5AP3-RSkHE-hBePY-Nigku
  You choose your own password at first sign-in. ...
================================================================
```

- The password is generated, shown once and never stored in clear. It is not
  printed again on a restart.
- The administrator chooses their own password at first sign-in, then adds the
  team under **Access**.
- To use your own email for this account, add `-e ADMIN_EMAIL=appsec-lead@company.com`
  to the first `run`.
- **Lost it?** Set a new temporary password. This works on a running container
  and is recorded in the audit log:

  ```
  docker exec mission-zero node scripts/reset-admin.mjs
  ```

## Options

Add any of these to `docker run` / `podman run` as `-e NAME=value`, or put them in a `.env` file next to `compose.yaml`.

| Variable | What for |
| --- | --- |
| `TZ` | Time zone for automatic reminders, e.g. `Asia/Dubai`. Default UTC. |
| `ADMIN_EMAIL` | The first administrator's email (default `admin@mission-zero.local`). |
| `REPORT_SERVER_URL` | The address people use to reach this server, put in every report (e.g. `https://cx-reminder.company.com`). |
| `CX_API_KEY` | Checkmarx One integration key; an Admin can store one in Settings instead. |
| `BACKUP_DIR`, `BACKUP_INTERVAL_HOURS`, `BACKUP_KEEP`, `BACKUP_PASSPHRASE` | Scheduled backups — see [audit-and-backup.md](audit-and-backup.md). |
| `NODE_EXTRA_CA_CERTS` | A company CA file (mounted into the container) when a proxy inspects TLS to Checkmarx One or your mail server. |

To publish on another port, change the left side: `-p 8080:3000`.

## Data, backups and upgrades

- **Data.** The `mission-zero-data` volume holds everything. Removing the
  container keeps it; `docker volume rm mission-zero-data` deletes it.
- **Backups.** Backups go to `/data/backups` by default. To keep them somewhere
  else, mount a host folder:
  - `-v /srv/mz-backups:/backups -e BACKUP_DIR=/backups`
  - Podman with SELinux: `-v /srv/mz-backups:/backups:Z`
  - Or use **Audit → Download backup**.
- **Upgrade.** Pull the new image, remove the container, and run the same line
  again. The volume carries everything over:

  ```
  docker pull ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
  docker rm -f mission-zero
  docker run -d --name mission-zero -p 3000:3000 -v mission-zero-data:/data ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
  ```

  With compose: `git pull`, then `docker compose up -d --build`.
- **Move to another machine.**
  1. Download a backup from **Audit**.
  2. Start the container on the new machine.
  3. Restore the backup there (**Audit → Restore from backup…**, then restart the container).

## Building behind a company proxy

If the proxy inspects TLS, give the build its CA certificate. Nothing else changes:

```
docker build --secret id=ca,src=company-ca.pem -t mission-zero .
```

`podman build` takes the same flag.

## What is in the image

- `node:22-alpine`, plus `git` (Beta code-author lookups), `tini` (signal
  handling) and `tzdata`.
- It runs as the unprivileged `node` user, listens on port 3000, and has a
  health check on `/api/health`.
- The state folder is created `0700`, so only that user can read it.
