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
| `backup` | A backup is downloaded or written, a restore is staged, cancelled or applied |
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
iam.json                    people, roles and permissions (passwords as scrypt hashes)
triage-credits.json         credit ledger: every credit spent, never trimmed
credit-allocations.json     per-project allocations and admin-added credits
audit/audit-YYYY-MM.jsonl   the audit log
audit.key                   the audit log's HMAC key
report-signing.key          signs report permissions: emailed reports stay valid after a restore
tracked-reports.json, known-initiators.json, automation-state.json
projections.json            Cx Credits Calculator: each customer, as saved
projection-reports/         Cx Credits Calculator: every projection report made, one file each
git-cache/                  Beta clones: a cache, never backed up
report-files/               emailed reports for the email's download button, kept 30 days, never backed up
backups/                    default BACKUP_DIR (better on another disk)
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
  attached only when it is encrypted with `BACKUP_PASSPHRASE`; otherwise the email
  says where it is on the server. There is at most one such email every 6 hours
  (`LAST_WORDS_EVERY_HOURS`). A forced kill (SIGKILL, power loss) cannot be caught:
  the scheduled backups cover that ([hands-off](hands-off.md)).

The backup contains the SMTP password and any stored API key. Set
`BACKUP_PASSPHRASE` to encrypt backups (AES-256-GCM, key derived with scrypt).
Keep the passphrase somewhere other than the server: it is needed to restore.

## The backup mailbox: rebuilding without touching anything

Set `BACKUP_EMAIL` to a mailbox kept for backups. Every encrypted backup is then
emailed there: the scheduled ones, the one before stopping, the one before switching
versions, and **Back up to folder now**. It needs `BACKUP_PASSPHRASE` (an
unencrypted backup is never emailed, because it holds the passwords and keys) and a
tested email server. A backup over 15 MB is not emailed, and the audit log says so.

To rebuild, start a new server with an empty state folder and these settings:

| Setting | What it is |
| --- | --- |
| `BACKUP_EMAIL` | The same backup mailbox. |
| `BACKUP_EMAIL_PASSWORD` | The mailbox's password. |
| `BACKUP_PASSPHRASE` | The same passphrase as the old server. |
| `BACKUP_EMAIL_IMAP_HOST` | The mailbox server. It defaults to `SMTP_HOST`. |
| `BACKUP_EMAIL_IMAP_PORT` | The port. It defaults to 993. |
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
2. Set `DATA_DIR`, and `BACKUP_PASSPHRASE` if the backup is encrypted.
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

Anything already in the state folder is moved to `replaced-<time>/`, never deleted.

You can also restore a running server from **Audit → Restore from backup…**:

- The backup is checked, and the page shows what it holds.
- The upload is limited to 200 MB. A larger backup is restored with `npm run restore`, as above.
- The restore is staged, and applied at the next restart before anything loads.
  Otherwise the running server would write its in-memory state over the restored
  files.
- Staging and the applied restore are both recorded in the audit log.
