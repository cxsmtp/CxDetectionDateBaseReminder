# Credit audit log, state folder and backups

Checkmarx One credits are spent from the emailed reports and the dashboard. Every
credit event is recorded in an audit log so any consumption, and any failure, can be
traced to who did it, when, from where, on which findings, and what Checkmarx One
answered.

> **Supporting information only.** The audit log, its exports and the credit figures help
> your own calculation. They are worked out from Checkmarx One data at a moment in time and
> may be incomplete or wrong. Checkmarx's own records are authoritative: do not use or share
> them with Checkmarx as evidence in any claim, dispute or credit request. CxMissionZero is
> an independent project, not a Checkmarx product ([terms of use](../TERMS.md)).

## What is recorded

One entry per event, in `audit/audit-YYYY-MM.jsonl` in the state folder:

| Type | Recorded when |
| --- | --- |
| `triage`, `remediation` | Every request from a report or the dashboard, whatever the result |
| `allocation` | An admin adds or removes credits, and every automatic recalculation after a scan or triage |
| `settings` | A credit setting changes: switches, monthly limit, re-triage or re-remediation, admin contact |
| `report` | A report is issued (downloaded, emailed to an initiator, or sent to "only to" addresses), with its recipient |
| `backup` | A backup is downloaded or written, a restore is staged, cancelled or applied; backup encryption is turned on; the backup key is shown, or confirmed as saved (the key itself is never recorded) |
| `audit` | Someone ran "Verify integrity" |
| `access` | Every sign-in and sign-out, and every refused sign-in (wrong password, lockout, a key with no matching person) |
| `iam` | People added, changed, disabled or removed; roles created, changed or removed; passwords set |

Outcomes:

- **charged**: credits were consumed.
- **not-charged**: accepted, but Checkmarx One started no new job, so nothing was spent.
- **refused**: nothing was sent to Checkmarx One. The reason is given: no credits
  left, feature switched off, re-triage blocked, report expired, or altered report
  permission or identity.
- **failed**: the request was sent and Checkmarx One or the network failed. The
  entry includes the HTTP status, error and duration.
- **changed** / **info**: allocation or settings changes, reports and backups.

Each entry records:

- **Who acted:**
  - for a report reader: the report's recipient and report id, taken from a
    signed identity token in the report, plus IP address and browser;
  - for the dashboard: the signed-in person (email, role, and whether they used a
    password or a Checkmarx One key).
- **What it touched:** the project and the findings (risk id, alternate id, scan,
  scanner).
- **Credits:** credits requested and charged, and the project's allocated, used and
  remaining balance before and after.
- **Month:** the monthly limit and what remains of it.
- **Checkmarx One's answer:** the call made, HTTP status, job id, error and
  duration.

A report whose identity token was altered is refused and recorded. A recipient
cannot spend credits under someone else's name. Reports emailed before auditing
existed carry no token. They still work, and their entries are marked "report
without identity".

Requests that do not carry a report's permission at all (forged or altered) are
refused, and listed here only so often (from MZ-01.01.10): at most 10 a minute
from one address and 40 a minute from everyone, with one line saying how many
more were left out. Nobody has signed in on those routes, so without that limit
anyone who can reach the server could fill the disk with refusals. A request
naming a finding with ids or names longer than a report sends is refused without
being listed.

The same holds for someone who does hold a report: a request of theirs that is
refused as a whole (an altered report identity, AI Triage switched off, a triage
already under way) is listed at most 10 times a minute for one report and 40
times a minute in all, and each entry lists the first 20 findings and counts the
rest. Refused product activation codes and refused sign-ins have limits of
their own (10 and 30 a minute from one address, 40 and 120 in all), each with
its line saying how many were left out, so a flood of one kind never hides
another.

## User activity

Next to the audit log, each tenant keeps `activity.jsonl` in its state folder: what each person did, one line each — when, who (email, name, role), the IP address, the page or action, the item it was about, the **names** of the fields a change touched (never their values), the status and how long it took. Pages and tabs opened are reported by the browser; everything else is recorded by the server as it answers, including refused sign-ins. Reads that change nothing are not recorded, except downloads and exports. The file moves to `activity.1.jsonl` past 20 MB; entries older than a year are not shown. **Logs → User activity** shows it (with the **audit.view** permission), filtered by person, kind, dates or text, and exports it as CSV. It is not hash-chained: the audit log stays the record of credits and access.

## Tamper evidence

Each entry has a sequence number and an HMAC-SHA256 over the previous entry's MAC
and its own content. The key is `audit.key`, generated on first start. Editing,
deleting or reordering any entry breaks the chain from that point.

**Audit → Verify integrity** re-checks every entry and names each broken one. The
log is only ever appended to; nothing is trimmed or rewritten, and the credit ledger
is no longer trimmed either.

## Reconciliation

**Audit → Reconcile** compares, for a month, the credits the audit log recorded as
charged with the credit ledger the balances are computed from, per project:

- every charged ledger entry carries the id of its audit entry;
- ledger entries without one were spent before auditing began, and are listed
  separately;
- a ledger entry pointing to a missing audit entry is flagged.

## Exports

**Export CSV** opens in a spreadsheet; cells that look like formulas are
neutralised. **Export JSON Lines** gives the complete entries, MACs included, for
archiving or for a SIEM. Both honour the filters on screen.

## The state folder

All state lives in one folder outside the project:

- `DATA_DIR`, default `~/.mission-zero` for the user the server runs as;
- the folder is created `0700` and its files `0600`;
- the server logs its location at start, and warns if it is inside the project folder;
- older setups with `SETTINGS_FILE` keep using that file's folder.

On the first start after upgrading, the old in-project `data/` folder is copied into
the state folder once. The old copy is left in place; delete it once the server
runs well from the new location.

The state folder holds:

```
settings.json               SMTP, recipients, template, credit settings, stored keys
iam.json                    people, roles and permissions (passwords as scrypt hashes), two-step sign-in keys,
                            and the sign-in rules with the single sign-on client secret
triage-credits.json         credit ledger: every credit spent, never trimmed
credit-allocations.json     per-project allocations and admin-added credits
audit/audit-YYYY-MM.jsonl   the audit log
audit.key                   the audit log's HMAC key
report-signing.key          signs report permissions: emailed reports stay valid after a restore
backup-key.json             the server's backup key and whether backups are encrypted: never part of a backup
tracked-reports.json, known-initiators.json, automation-state.json
projections.json            Cx Credits Calculator: each customer, as saved
projection-reports/         Cx Credits Calculator: every projection report made, one file each
git-cache/                  Beta clones: a cache, never backed up
report-files/               emailed reports for the email's download button, kept 30 days, never backed up
backups/                    default BACKUP_DIR (better on another disk)
<file>.bak                  the last good copy of a state file: what it held before its latest save
<file>.damaged-<time>       a state file that could not be read, kept aside (never deleted)
```

### How state files are saved, and what happens when one is damaged (from MZ-01.01.10)

Every save is written to a new file, flushed to the disk, and only then put in the place of the old one.
A power cut or a full disk in the middle of a save leaves the old file as it was. The file from before
the save is kept beside it as `<file>.bak`. An audit entry is in the log's file before the action it
records is answered, so it survives the server crashing or being killed; its flush to the disk, which
makes it survive a power cut, follows a few milliseconds later, one flush for the entries written
meanwhile.

Files that hold only secrets or that are rebuilt by themselves keep no `.bak`: the audit and
report-signing keys, the backup key, the saved sign-ins, the Govern files, the connection guard, and the network and
watchdog files. Removing a stored
key or password from Settings also removes it from the `.bak`.

When the server starts and a state file cannot be read:

| What it finds | What it does |
| --- | --- |
| The file is damaged and its `.bak` reads | Uses the `.bak`, moves the damaged file to `<file>.damaged-<time>`, and says so on the server's log. What was saved after the `.bak` was made is lost: at most the latest change. |
| The file is damaged and there is no usable `.bak` | **Does not start.** It names the file, says what it holds, and stops with exit code 78. Nothing is written over the file. |
| The file is not there at all, and neither is a `.bak` | Starts with that part empty, as on a new installation. |

A server that will not start for this reason says how to go on. There are two ways:

1. Restore a backup (below), with the server stopped.
2. Or start that part afresh on purpose: move the named file and its `.bak` out of the state folder
   (somewhere safe, not deleted), then start the server.

In a container the server is tried again every few seconds and prints the same message each time; an
update is never rolled back for this reason, because an older version would read the damaged file as
empty and write over it. Stop the container before restoring:

```
podman stop mission-zero
```

## Backups

A backup is one `.mzbackup` file: every state file and audit month, gzipped, with
a SHA-256 per file and over the whole set. A damaged backup is refused whole, never
half-restored. There are three ways to make one:

- **Scheduled.**
  - The first backup runs one minute after start, then every
    `BACKUP_INTERVAL_HOURS` (default 24).
  - Backups go into `BACKUP_DIR`, which defaults to `<state folder>/backups`, and
    the newest `BACKUP_KEEP` (default 14) are kept.
  - Point `BACKUP_DIR` at another disk or a network share, so a disk failure does
    not take the backups with it. The Audit tab warns while they share a disk.
- **Audit → Download backup**, or **Back up to folder now**.
- **Command line**, with the server running or stopped:
  `npm run backup -- /mnt/backups/`.
- **Before stopping.** When the server is stopped or killed with a signal (SIGTERM or
  SIGINT), or crashes under its launcher, it writes everything to disk and makes one
  more backup into `BACKUP_DIR`. When nobody asked for the stop from the Update page,
  it also emails the administrators the backup and how to restore it. The backup is
  attached only when it is encrypted; otherwise the email says where it is on the
  server. The backup key is never in the email. There is at most one such email every 6 hours
  (`LAST_WORDS_EVERY_HOURS`). A forced kill (SIGKILL, power loss) cannot be caught:
  the scheduled backups cover that ([hands-off](hands-off.md)).

## Backups are encrypted

A backup holds the Checkmarx One key, the mail password and the signing keys. So a
new installation encrypts every backup, wherever it goes: downloaded, written to the
backup folder, or emailed. An installation that already existed turns this on first
(below). The encryption is AES-256-GCM, with the key derived by scrypt.

**What encrypts a backup.** One of three things, in this order:

| The server has | Backups are |
| --- | --- |
| `BACKUP_PASSPHRASE` set | Encrypted with that passphrase. Nothing else on this page changes that. |
| No passphrase, encryption on | Encrypted with **the server's own backup key**. |
| No passphrase, encryption off | Not encrypted. Admins see a notice on every page, unless it is off on purpose (`BACKUP_ENCRYPTION=off`). |

**A new installation encrypts from its first backup.** At its first start the server
makes a backup key of its own: eight groups of four letters and digits, such as
`K7QM-2HXD-…`, random, and easy to type. It keeps the key in `backup-key.json` in the
state folder, readable only by the server's user. Every backup is encrypted with it.

**Save the key somewhere else.** If the server is lost, a backup opens only with its
key. So an Admin keeps a copy away from the server:

1. Open **Audit → State & backups**. The **Backup key** box is there for Admins (the
   *Download & restore backups* permission).
2. **Show backup key**, then **Copy** it or **Download as a text file**. Put it in a
   password manager or a safe, not on the server.
3. **I have saved it.** Until someone confirms, Admins see a notice on every page.

- Each time the key is shown is recorded in the audit log, with who asked. The key
  itself is never recorded.
- The key is never emailed, never written into a backup or into the restore
  instructions an email carries, and never written to the server's log.
- The key is not part of a backup. A restore leaves the server's own key as it is.

**An installation that already existed is not changed.** A server that ran before
backups were encrypted by default, with no `BACKUP_PASSPHRASE`, keeps making plain
backups: nobody holds a key for them yet. Admins see a notice that backups are not
encrypted. To encrypt them, an Admin opens **Audit → State & backups** and chooses
**Turn on backup encryption**. The server makes its backup key then, shows it, and
asks for the same **I have saved it**. Backups made before stay as they are.

**How the server tells new from existing.** It decides once, at the first start that
finds no decision, before it loads or writes anything, and keeps the answer in
`backup-key.json`:

- **New:** nothing from before is there. No state file of any version (no `.json`,
  `.jsonl` or `.key` file in the state folder, and no `.bak` of one), no audit month,
  no tenant folder, no saved sign-in, nothing an update or a restore left, and no
  plain backup in the backup folder. At a first start the folder holds only the
  server's lock.
- **Existing:** anything else. A doubt always ends in "leave it as it was", never in
  encrypting the backups of people who hold no key for them.
- The server's log says which it was, and what it found.
- It is never decided again. If `backup-key.json` is damaged, the server does not
  start and says so, as for the other state files. Moving the file away makes the
  server an existing installation: its backups are plain until an Admin turns
  encryption on again, which makes a new key.

**`BACKUP_PASSPHRASE` still wins.** With it set, backups are encrypted with the
passphrase, as before, and the server's key is not used. Keep the passphrase
somewhere other than the server: it is needed to restore.

**To keep backups plain on purpose**, set `BACKUP_ENCRYPTION=off`. Backups are then
not encrypted, Admins see no notice, and encryption cannot be turned on from the
page. A `BACKUP_PASSPHRASE` still wins over it. Keep plain backups where only
administrators of the host can read them.

**Opening an encrypted backup.** A backup made with the server's key is in the same
format a passphrase gives. Give the key wherever a passphrase is asked for:

- **On the page:** *Restore from backup…* opens a backup this server made by itself.
  For another server's backup it asks for the backup key or passphrase.
- **On the command line:** set `BACKUP_PASSPHRASE` to the key for the restore command.
  A backup of the same state folder's own server opens without it.
- The key can be typed in lower case, and with spaces or nothing in place of the dashes.
- Without a key, or with the wrong one, the restore says so and writes nothing.
- Plain backups, and backups encrypted with a passphrase by an earlier version,
  restore as they always did.

`npm run backup` follows the same rules as the server's own backups.

**Going back to an older version.** A version from before backups were encrypted by
default does not know the backup key. While it runs, with no `BACKUP_PASSPHRASE`, the
backups it makes are plain. The key stays in the state folder, and the newer version
uses it again when it is back.

## The backup mailbox: rebuilding without touching anything

Set `BACKUP_EMAIL` to a mailbox kept for backups. Every encrypted backup is then
emailed there: the scheduled ones, the one before stopping, the one before switching
versions, and **Back up to folder now**. It needs encrypted backups (an
unencrypted backup is never emailed, because it holds the passwords and keys) and a
tested email server. The backup key is never emailed with it. A backup over 15 MB is not emailed, and the audit log says so.

To rebuild, start a new server with an empty state folder and these settings:

| Setting | What it is |
| --- | --- |
| `BACKUP_EMAIL` | The same backup mailbox. |
| `BACKUP_EMAIL_PASSWORD` | The mailbox's password. |
| `BACKUP_PASSPHRASE` | The same passphrase as the old server. If the old server used its own backup key, the key an Admin saved. |
| `BACKUP_EMAIL_IMAP_HOST` | The mailbox server. It defaults to `SMTP_HOST`. |
| `BACKUP_EMAIL_IMAP_PORT` | The port. It defaults to 993. On any other port (such as 143) the server must offer STARTTLS: the password is only ever sent over an encrypted connection, and the server log says so if it cannot be (from MZ-01.01.05). |
| `BACKUP_EMAIL_USER` | The account. It defaults to `BACKUP_EMAIL`. |

Before anything loads, the server reads the mailbox. It looks at the newest 20 emails
whose subject starts with "MissionZero backup", takes the newest backup that opens
with the passphrase, and restores it. It then starts as the old server was: the same
people and passwords, settings, credits, tracked reports and audit log. Nobody has to
sign in or upload anything.

- **What it accepts.** Only an encrypted backup that opens with the passphrase. A
  backup someone else put in the mailbox, encrypted or not, is passed over.
- **When it looks.** Only while the state folder is new, so a running server is
  never replaced by a backup.
- **It changes nothing in the mailbox.** It only reads it.
- **When nothing is found.** If nothing usable is there, or the mailbox does not
  answer within 90 seconds, the server starts fresh and the log says why.
- **The audit log.** The restore is recorded there, with the mailbox it came from.

## Rebuilding a server from scratch

1. Install the application on the new server (`npm ci`).
2. Set `DATA_DIR`. If the backup is encrypted, set `BACKUP_PASSPHRASE` to what it was
   encrypted with: the old server's passphrase, or the backup key an Admin saved.
3. Check the backup first. This writes nothing:

   ```
   npm run restore -- mission-zero-2026-09-30T02-00-00.mzbackup
   ```

4. Restore it:

   ```
   npm run restore -- mission-zero-2026-09-30T02-00-00.mzbackup --yes
   ```

5. Start the server. Run **Audit → Verify integrity** to confirm the restored log
   is intact.

Everything comes back from the backup:

- settings;
- credit balances and allocations;
- the credit history and the audit log. The chain continues from the backup's
  last entry.
- tracked reports;
- the signing keys, so reports already emailed keep working.

A server rebuilt with the old server's backup key keeps that key: its backups go on
being encrypted with the key already saved, and nothing needs confirming again. A
server rebuilt from a backup that was encrypted with a passphrase needs the same
`BACKUP_PASSPHRASE` when it starts. Without it, its backups are plain until an Admin
turns encryption on.

Anything already in the state folder is moved to `replaced-<time>/`, never deleted. That includes
the `.bak` copies, so an older state cannot come back after the restore.

**The restore refuses while a server is running on the folder** (from MZ-01.01.10). A running server
would write its own copy over the restored files, so the restore takes the server's lock on the state
folder first:

- A server is running: nothing is written, and the restore says which server holds the folder. Stop it and run the restore again.
- A server crashed and left its lock: the restore watches the lock for 30 s (`INSTANCE_LOCK_STALE_SECONDS`), then goes on.
- `--force` restores without looking at the lock. Use it only when that server is certainly not running, for example when the folder was copied from another machine.

With the container, stop it and run the restore from the same image on the same volume (Windows cmd, one line; the backup is in the volume's `backups` folder):

```
podman run --rm -v mission-zero-data:/data ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest node scripts/restore.mjs /data/backups/mission-zero-2026-09-30T02-00-00.mzbackup --yes
```

On the same volume an encrypted backup opens by itself: the volume holds the server's backup key. On a new, empty volume, give the key (or the old passphrase) on the same line:

```
podman run --rm -e BACKUP_PASSPHRASE=K7QM-2HXD-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF -v mission-zero-data:/data ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest node scripts/restore.mjs /data/backups/mission-zero-2026-09-30T02-00-00.mzbackup --yes
```

Then start the container again with `podman start mission-zero`.

You can also restore a running server from **Audit → Restore from backup…**:

- The backup is checked, and the page shows what it holds. An encrypted backup of
  another server asks for its backup key or passphrase first.
- The upload is limited to 200 MB. A larger backup is restored with `npm run restore`, as above.
- The restore is staged, and applied at the next restart before anything loads.
  Otherwise the running server would write its in-memory state over the restored
  files.
- Staging and the applied restore are both recorded in the audit log.
