# Activation codes

A few add-ons are unlocked per installation with an activation code:

| Add-on | Code | What it does |
| --- | --- | --- |
| **Hebrew** | an activation code and a deactivation code | Adds Hebrew (עברית) to the language pickers until the code expires, or removes it. |
| **Several tenants** | an activation code naming the organisation and how many tenants | Unlocks the Super Admin tasks for organisations that run more than one Checkmarx One tenant. |

Everything else works without a code.

## For Admins: applying a code

1. Open **Settings → Activation codes**. You need the **Activation codes** permission; Admins have it.
2. Paste the code you were sent, then select **Apply the code**.

The section then shows what is unlocked, for which organisation and until when. It warns 30 days before a code expires.

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
| See what a code contains | `node scripts/activation.mjs show MZ1.…` |

- **Validity:** a code lasts 12 months. Add a number of months as the last argument to change that.
- **Format:** a code is `MZ1.<payload>.<signature>`. The payload names the organisation, what the code unlocks and when it expires. Anyone can read it with `show`, but only your key can sign one.
