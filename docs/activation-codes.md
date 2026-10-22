# Activation codes

A few add-ons are unlocked per installation with an activation code:

| Add-on | Code | What it does |
| --- | --- | --- |
| **Hebrew** | an activation code and a deactivation code | Adds Hebrew (עברית) to the language pickers of the roles that hold the **Hebrew** permission (Admins always do), until the code expires, or removes it. |
| **Cx Credits Calculator: Impact** | an activation code and a deactivation code | Shows the calculator's **Impact** tab and puts its section back in the projection report and the PDF summary, until the code expires, or hides them again. Off until a code turns it on (from MZ-01.00.91), while it matures; the standalone calculator's downloads never have it. |
| **FAE Flush** | an activation code and a deactivation code | Shows **Labs → FAE Flush** (from MZ-01.00.95) to the roles with Beta access, until the code expires, or hides it again; a run under way pauses while it is off and carries on once it is back. Not offered, nor listed under Settings → Beta features, until a code turns it on. |
| **Several tenants** | an activation code naming the organisation and how many tenants | Unlocks the Super Admin tasks for organisations that run more than one Checkmarx One tenant ([several tenants](multi-tenant.md)). |

Everything else works without a code, until the product licence's end date (below).

## The product licence: CxMissionZero stops after 31 December 2026

From MZ-01.00.93, CxMissionZero works until the **end of 31 December 2026, UTC** (04:00 on 1 January in the UAE). After that it stops until the **product activation code** from the maintainer is entered. There is **one product code for everyone** who has downloaded or uses CxMissionZero: it is not tied to a server or an organisation, so the same key, given to everyone, works on every installation and in the standalone calculator. The code says until when CxMissionZero works; a new one, issued when the licensing changes, extends it again.

- **Before the end.** From 1 December (30 days before), Admins see a banner at the top of every page with the date and the days left, and **Settings → Activation codes** shows **CxMissionZero · Active · Until the end of 31 Dec 2026**. A product code applied there moves the date at once.
- **After the end.** Every page shows **The product has been deactivated. Please reach out to Bhawani Singh.**, with **Enter an activation code**. Nobody can sign in; every other request is refused. Scheduled reminders, automation, AI Triage and AI Remediation, emails and reads of Checkmarx One all stop. The container's health check (`/api/health`) still answers, so the container is not restarted over and over.
- **Nothing is deleted.** Settings, people, history and reports stay on disk, and scheduled backups go on. Once a code is entered, everything works again as it was, with no restart.
- **Entering the code after the end.** Paste it on the deactivation page and select **Activate**: anyone who reaches the server can, since only a code the maintainer signed is accepted (a few tries a minute from one address). Every code applied or refused there is in the audit log (type **System**, by *deactivation page* and the address).
- **The standalone Cx Credits Calculator** (the HTML file and the launcher's page) built from this release stops at the same moment and takes the same code, checked in the browser. Customers and reports kept in the browser are left as they are. Copies downloaded from releases before MZ-01.00.93 have no end date.
- **Setting the clock back does not help.** The licence goes by the latest time the server (or the browser, for the calculator) has seen, kept in `DATA_DIR/activation.json`; a code whose date has already passed on that clock is refused. The release's file check ([integrity](integrity.md)) reports any changed file as *tampered*, so a copy edited to remove the date shows as such.


## For Admins: applying a code

1. Open **Settings → Activation codes**. You need the **Activation codes** permission; Admins have it.
2. Paste the code you were sent, then select **Apply the code**.

What the code unlocks is switched on at once. The section then shows it, for which organisation and until when, and warns 30 days before the code expires. It lists only what a code has unlocked (an expired one stays listed, to renew); before the first code it says **No add-ons are unlocked yet**. **Settings → Tenants** appears once a tenants code is applied.

With Hebrew on, who sees it is a role permission. **People & roles** lists **Hebrew** (group *Languages*) while a Hebrew code is in force. Admins always have it; tick it for Security Analyst, or any other role, and everyone with that role is offered Hebrew at once. With Hebrew off, the permission is not listed, and roles keep their tick for when it is back. (MZ-01.00.58 to 62 chose people one by one instead; that list is no longer used.)

The Cx Credits Calculator needed a code in MZ-01.00.62 only: it is a permission now ([Cx Credits Calculator](credit-projections.md)).

Codes are checked on the server against the maintainer's public key, which is built into CxMissionZero. Nothing is sent anywhere. Every code applied, or refused, is recorded in the audit log (type **System**) with who entered it.

## For the maintainer: issuing codes

Codes are signed with an Ed25519 key, using `scripts/activation.mjs`.

- **The private key stays with you.** Keep it outside the repository and the container, and back it up.
- **Only the public key is built in,** as `ISSUER_KEYS` in `src/activation.js`.
- **A new key pair** (once): `node scripts/activation.mjs keygen issuer-key.pem`. It refuses to overwrite an existing file and prints the public key to put in `ISSUER_KEYS`.

| To | Command |
| --- | --- |
| Allow several tenants | `node scripts/activation.mjs issue issuer-key.pem "Acme Corp" 5` |
| Turn Hebrew on | `node scripts/activation.mjs lang issuer-key.pem "Acme Corp" he on` |
| Turn Hebrew off | `node scripts/activation.mjs lang issuer-key.pem "Acme Corp" he off` |
| Turn the calculator's Impact tab on | `node scripts/activation.mjs feature issuer-key.pem "Acme Corp" impact on` |
| Turn the calculator's Impact tab off | `node scripts/activation.mjs feature issuer-key.pem "Acme Corp" impact off` |
| Turn FAE Flush on | `node scripts/activation.mjs feature issuer-key.pem "Acme Corp" faeFlush on` |
| Turn FAE Flush off | `node scripts/activation.mjs feature issuer-key.pem "Acme Corp" faeFlush off` |
| Keep CxMissionZero working until the end of a day (UTC) | `node scripts/activation.mjs product issuer-key.pem 2027-12-31` |
| Keep CxMissionZero working for some months | `node scripts/activation.mjs product issuer-key.pem 12` |
| See what a code contains | `node scripts/activation.mjs show MZ1.…` |

### On Windows, without Node: `scripts/activation-codes.cmd`

`scripts/activation-codes.cmd` makes every code above from Windows cmd with Podman alone. Each command runs `scripts/activation.mjs` from the CxMissionZero image in a throwaway container (`podman run --rm`), with the folder holding `issuer-key.pem` mounted read-only; the key never goes into the image or a running container. Set `KEYDIR` (the key's folder, `%USERPROFILE%\mz-keys` by default) once at the top of the file, then:

| To | Command (Windows cmd) |
| --- | --- |
| The product code for everyone, until the end of a day (UTC) | `activation-codes.cmd product 2027-12-31` |
| The product code, for some months | `activation-codes.cmd product 12` |
| Several tenants | `activation-codes.cmd tenants "Acme Corp" 5` |
| Hebrew on / off | `activation-codes.cmd hebrew-on "Acme Corp"` · `activation-codes.cmd hebrew-off "Acme Corp"` |
| The calculator's Impact tab on / off | `activation-codes.cmd impact-on "Acme Corp"` · `activation-codes.cmd impact-off "Acme Corp"` |
| FAE Flush on / off (images from MZ-01.00.95) | `activation-codes.cmd fae-on "Acme Corp"` · `activation-codes.cmd fae-off "Acme Corp"` |
| A code for 6 months instead of 12 | add the months last: `activation-codes.cmd fae-on "Acme Corp" 6` |
| See what a code contains | `activation-codes.cmd show MZ1.…` |
| A new key pair (only to replace the key; the public key then goes into `ISSUER_KEYS`) | `activation-codes.cmd keygen` |

The same, one line, without the file: `podman run --rm -v "%USERPROFILE%\mz-keys:/keys:ro" ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest node scripts/activation.mjs feature /keys/issuer-key.pem "Acme Corp" faeFlush on`

- **Validity:** a code lasts 12 months. Add a number of months as the last argument to change that.
- **Format:** a code is `MZ1.<payload>.<signature>`. The payload names the organisation, what the code unlocks and when it expires. Anyone can read it with `show`, but only your key can sign one.
