# Updating without downtime or data loss

New versions are applied **without losing data, sign-ins or work in progress**. The service is unavailable for only the few seconds the new container takes to start, and the browsers and reports wait through that by themselves.

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
  - Use exactly the options you started it with. For example, add `--cpus 2 --memory 3g -e NODE_OPTIONS=--max-old-space-size=2048` if you run it sized, or `--env-file mission-zero.env`, or `-p 3001:3000` for another port.
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
