# Updating without downtime or data loss

New versions are applied **without losing data, sign-ins or work in progress**. The service is unavailable for only the few seconds the new container takes to start, and the browsers and reports wait through that by themselves.

## From the app: Settings → Update & recovery (Admins, from MZ-01.00.30)

No server sign-in after deployment: everything an update needs is on this page.

- **Check for updates** lists every published version: version, when it was built, and whether it is installed here or running.
  - The versions come from the registry's tags (ghcr.io), so a newer one is listed even when the image files cannot be downloaded. Build dates and commits come from the image files when they can be read.
  - **The image files come from another host.** ghcr.io serves them from `pkg-containers.githubusercontent.com`. If a proxy or firewall blocks it, the page says exactly that, and installing from the page waits until it is allowed over HTTPS; `podman pull` works meanwhile. Up to MZ-01.00.35, a blocked host made the check list nothing and report "up to date": update once with `podman pull` to get the fix.
- **Update now** (or **Install and switch** on any version) does the rest:
  1. Downloads only CxMissionZero's own files from its image (about 1.5 MB, not the 40 MB of the whole image), and checks each piece against the image's sha256 digests.
  2. Keeps them in the data volume (`/data/app/versions/`).
  3. Takes a backup.
  4. Switches. The running server finishes its work and saves, exactly as for a container update; the new version starts and picks everyone up. People see "reconnecting…" for a few seconds. The page reloads itself on the new version.
- **A version that does not start is rolled back by itself.** If it does not come up within 150 s, or stops within 2 minutes of starting, the launcher goes back to the version that ran before. It is recorded under **Recent events** and marked **Failed to start**.
- **Go back to any version.** **Switch to** an installed one, **Install and switch** to any published one, or **Switch to** the image's own version. Going back to an older version can leave newer data it does not know. The backup taken before every switch is under Audit → Backups.
- **Auto-update** (off until an Admin turns it on): every 15 minutes the server looks for a newer release and installs it the same way. **at** limits this to one hour of the day (server time), for example 02:00. A version that once failed to start is never installed automatically again.
- **Restart the server**, and **Download troubleshooting report**:
  - versions, recent events, memory, disk, HTTPS mode and connection state;
  - the last backup and relay load;
  - no secrets.
- **Every action is in the audit log** (type **Updates & system**).

**What it needs**
- **The launcher.** The image's own start command runs it (`node src/launch.js`, since MZ-01.00.30). Start the container without a command after the image name. **The first update to MZ-01.00.30 is a `podman pull` (below)**; after that, updates come from the page.
- **Outbound HTTPS** to `ghcr.io` and `pkg-containers.githubusercontent.com` (where GitHub serves image layers). Nothing else is sent: the request carries no data from the tool.
- **A private copy** of the image: `UPDATE_IMAGE=ghcr.io/your-org/your-image` and `UPDATE_REGISTRY_TOKEN=<a read-only token>`.

**When the image itself must be replaced.** Rarely, a release needs a newer Node.js or OS base. The page then says so, and the update is the two lines below. A full image update from the page (a companion container) comes in a later release.

| Variable | Default | |
| --- | --- | --- |
| `UPDATE_IMAGE` | `ghcr.io/cxsmtp/cxdetectiondatebasereminder` | Where updates come from. |
| `UPDATE_REGISTRY_TOKEN` | (none) | Only for a private image: a token that can read it. |
| `UPDATE_START_TIMEOUT_SECONDS` | 150 | How long a new version may take to come up before it is rolled back. |

## Update (Podman, Windows cmd, two lines)

```
podman pull ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

```
podman run --replace -d --name mission-zero -p 3000:3000 -v mission-zero-data:/data -e TZ=Asia/Dubai --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

**What each line does**
- **Line 1** downloads the new version while the current one keeps running. Nothing is interrupted.
- **Line 2** replaces the running container with the new version, using the same name, port, volume and options.
  - Use exactly the options you started it with. For example, add `-e HTTPS=off` if you use plain http (the image serves HTTPS by default since MZ-01.00.21), your certificate options if you gave one, add `--cpus 2 --memory 3g -e NODE_OPTIONS=--max-old-space-size=2048` if you run it sized, or `--env-file mission-zero.env`, or `-p 3001:3000` for another port.
  - If your Podman version does not know `--replace`, run `podman stop mission-zero`, then `podman rm mission-zero`, then the same `podman run` line without `--replace`.

**Check it.** The bottom-left corner of the app shows the new version (`MZ-xx.xx.xx`). Or run `podman logs mission-zero`; the start of the log shows the version and says how many sign-ins were picked up.

**Docker:** `docker pull …`, then `docker stop mission-zero`, `docker rm mission-zero`, and the same `docker run` line.

**Compose:** `podman compose pull`, then `podman compose up -d`.

## What happens during the swap

| Step | What the old server does | What people see |
| --- | --- | --- |
| 1. Stop is requested | Stops taking new work. Requests already running (a triage, an allocation, an email being sent) finish, for up to 8 s. | New requests get "restarting, retry in 3 s". The Dashboard and reports retry by themselves. |
| 2. Save | Writes the latest sign-ins and fetched data (already saved as they happen, see below), the credit ledger and the audit log, then releases the data folder. | Nothing. |
| 3. The new version starts (2–5 s) | Picks up everyone who was signed in, and carries on. | The Dashboard shows "reconnecting…", then continues. Reports show **Reconnecting…**, then **Connected**. |

**Afterwards**
- **Still signed in, never cut off in the middle.**
  - **Saved as it happens.** Every password sign-in is saved to `/data/sessions/` the moment it happens, and each person's fetched data and scope right after a fetch (and every minute while they work). So people stay signed in after an update, a restart, and even a crash or `podman kill`.
  - **Signing out is final.** Signing out, idling out (8 hours), being disabled or removed, and a password reset end the saved sign-in too.
  - **Your own API key.** People who signed in with their own Checkmarx One API key sign in again, because that key is never written to disk.
- **The Dashboard comes back as it was.** Reloading the page, after an update or any time, shows the same fetched data and the same scope (time windows, named projects and people), without reading Checkmarx One again. **Fetch vulnerability data** gets the latest.
- **Nothing is lost.** Credits, allocations, the ledger, the audit log, tracked reports, settings, people and roles live in the `mission-zero-data` volume, which the update never touches.
- **Emailed reports keep working.** Their permissions are signed with a key kept in the volume.
- **Automation and tracked-report follow-ups** resume on the new server from where they were.

**Never two at once.** Two servers on one data folder would corrupt credits and the audit log, so the second one waits for the first to let go of the folder (up to 45 s), and refuses to start if it does not. A side-by-side "blue/green" copy on the same volume is therefore not possible, and not needed.

**The first update to MZ-01.00.10 or later** (from MZ-01.00.09 or older) signs people out once, because the old version did not save sign-ins yet. Every update after that keeps them signed in.

## If something goes wrong

- **Go back to the previous version:** run the same `podman run --replace …` line with the previous version's tag instead of `:latest`, e.g. `ghcr.io/cxsmtp/cxdetectiondatebasereminder:sha-<commit>`. Every build is published with its commit tag.
- **Before a big upgrade,** download a backup: Audit page → **Download backup**.
- **The container was killed** instead of stopped (power loss, `podman kill`): everything already written is safe, including sign-ins. The new server takes over the data folder after about 30 s. At most the last minute of changes to someone's Dashboard data is lost; a refresh brings it back.

## Options

| Variable | Default | |
| --- | --- | --- |
| `SHUTDOWN_DRAIN_SECONDS` | 8 | How long requests in progress may finish when stopping. Keep it below the container's stop timeout (10 s by default; raise both together with `--stop-timeout`). |
| `INSTANCE_LOCK_WAIT_SECONDS` | 45 | How long a starting server waits for the previous one to let go of the data folder. |
