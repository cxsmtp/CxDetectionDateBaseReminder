# Credit audit log, state folder and backups

Checkmarx One credits are spent from the emailed reports and the dashboard. Every
credit event is recorded in an audit log so any consumption, and any failure, can be
traced to who did it, when, from where, on which findings, and what Checkmarx One
answered.

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
  - for the dashboard: the Checkmarx One user behind the API key.
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
triage-credits.json         credit ledger: every credit spent, never trimmed
credit-allocations.json     per-project allocations and admin-added credits
audit/audit-YYYY-MM.jsonl   the audit log
audit.key                   the audit log's HMAC key
report-signing.key          signs report permissions: emailed reports stay valid after a restore
tracked-reports.json, known-initiators.json, automation-state.json
git-cache/                  Beta clones: a cache, never backed up
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

The backup contains the SMTP password and any stored API key. Set
`BACKUP_PASSPHRASE` to encrypt backups (AES-256-GCM, key derived with scrypt).
Keep the passphrase somewhere other than the server: it is needed to restore.

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
- The restore is staged, and applied at the next restart before anything loads.
  Otherwise the running server would write its in-memory state over the restored
  files.
- Staging and the applied restore are both recorded in the audit log.
