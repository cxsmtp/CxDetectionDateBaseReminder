# Run CxMissionZero in a container (Docker or Podman)

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

Then open <https://localhost:3000>. The image serves HTTPS by default (`HTTPS=on`), with a self-signed certificate until you give it yours, so the browser warns once. For plain http on your own machine, add `-e HTTPS=off` and open <http://localhost:3000>. Certificates and hosting: [HTTPS and hosting](https-and-hosting.md).

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
      Password: xxxxx-xxxxx-xxxxx-xxxxx
  You choose your own password at first sign-in. This is shown only once;
  until then it is also in /data/first-admin-password.txt.
================================================================
```

- It is printed only on the very first start of a new data volume. A volume
  from an earlier run already has its administrator, so nothing is printed:
  use **Lost it?** below.
- Scrolled out of the log? `docker exec mission-zero cat /data/first-admin-password.txt`
  shows it until the administrator chooses their own password (the file is
  then deleted, and is never part of a backup).
- The administrator chooses their own password at first sign-in, then adds the
  team under **Access**.
- To use your own email for this account, add `-e ADMIN_EMAIL=appsec-lead@company.com`
  to the first `run`.
- **Lost it?** Set a new temporary password. This works on a running container
  and is recorded in the audit log:

  ```
  docker exec mission-zero node scripts/reset-admin.mjs
  ```

**`manifest unknown`** when pulling means that tag has not been published yet.
- Images are published by the "Container image" workflow on every push to
  `main` (as `:latest` and `:sha-<commit>`), and on version tags `v*`.
- Check the repository's **Actions** tab, or pull a published `:sha-<commit>`
  tag instead.

## Options

Every option is listed, with what it is for, in the README's [Configure](../README.md#configure) table. Three ways to set them:

- `-e NAME=value` on `docker run` / `podman run`, e.g. `-e TZ=Asia/Dubai`.
- **A settings file:** download the sample from **Settings → Quick setup from a .env file** (or use [`public/sample.env`](../public/sample.env)), fill it in, and add `--env-file mission-zero.env`.
  ```
  podman run -d --name mission-zero -p 3000:3000 -v mission-zero-data:/data --env-file mission-zero.env ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
  ```
- With compose, a `.env` file next to `compose.yaml` (copy `.env.example`, which is the same sample). Compose passes on the variables `compose.yaml` lists (`TZ`, `ADMIN_EMAIL`, `REPORT_SERVER_URL`, `CX_API_KEY`, `NODE_OPTIONS`, plus `BIND_ADDRESS` and `PORT` for the published port). Upload the same file on the Settings page for the mail server.

The connection settings in the file (Checkmarx One, mail server, reminder server address) can also be uploaded later on the Settings page, without restarting.

To publish on another port, change the left side: `-p 8080:3000`.

`compose.yaml` publishes the port on this machine only (`127.0.0.1`). To let
other machines reach it, set `BIND_ADDRESS=0.0.0.0` (or one interface's
address) in `.env`, and serve it over HTTPS ([HTTPS and hosting](https-and-hosting.md)). `PORT` changes the
port on the host.

## Data, backups and upgrades

- **Data.** The `mission-zero-data` volume holds everything. Removing the
  container keeps it; `docker volume rm mission-zero-data` deletes it.
- **Backups.** Backups go to `/data/backups` by default. To keep them somewhere
  else, mount a host folder:
  - `-v /srv/mz-backups:/backups -e BACKUP_DIR=/backups`
  - Podman with SELinux: `-v /srv/mz-backups:/backups:Z`
  - Or use **Audit → Download backup**.
- **Upgrade.** See [updating.md](updating.md) for the two-line update that keeps
  people signed in. With Docker: pull the new image, stop and remove the
  container, and run the same line again. The volume carries everything over:

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

- `alpine:3.24` with Alpine's own Node.js 24 package, plus `git` (Beta
  code-author lookups) and `tini` (signal handling). Time zones come from the
  ICU data inside Node.js. Packages are pinned to their major version line.
- It does not use the official `node` image, which bundles npm and its
  dependencies (and their CVEs) even when the app never runs npm.
- It runs as the unprivileged `node` user, listens on port 3000, and has a
  health check on `/api/health`.
- Built in two stages: npm installs the dependencies in the first, and the
  runtime image gets only `node_modules` — no npm, npx, corepack or yarn. OS
  packages are upgraded to their latest fixes at build time.
- The runtime user keeps uid 1000, so volumes from earlier images still work.
- It runs with a read-only root filesystem, no Linux capabilities and no
  privilege escalation (`compose.yaml` sets this; CI tests the image the same
  way). With `docker run`, add the same:
  `--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true`.
- The state folder is created `0700`, so only that user can read it.
