# Activation codes

A few add-ons are unlocked per installation with an activation code:

| Add-on | Code | What it does |
| --- | --- | --- |
| **Hebrew** | an activation code and a deactivation code | Adds Hebrew (עברית) to the language pickers of the people an Admin chooses, until the code expires, or removes it. |
| **Several tenants** | an activation code naming the organisation and how many tenants | Unlocks the Super Admin tasks for organisations that run more than one Checkmarx One tenant ([several tenants](multi-tenant.md)). |
| **Cx Credits Calculator** | an activation code and a deactivation code | Shows the [Cx Credits Calculator](credit-projections.md) (menu group *Plan*) to the people with its permission, until the code expires, or hides it again. Its customers and reports are kept while it is off. |

Everything else works without a code.

## For Admins: applying a code

1. Open **Settings → Activation codes**. You need the **Activation codes** permission; Admins have it.
2. Paste the code you were sent, then select **Apply the code**.

What the code unlocks is switched on at once. The section then shows it, for which organisation and until when, and warns 30 days before the code expires. It lists only what a code has unlocked (an expired one stays listed, to renew); before the first code it says **No add-ons are unlocked yet**. **Settings → Tenants** appears once a tenants code is applied. **Cx Credits Calculator** appears in the menu, for the people with its permission, once a calculator code is applied.

With Hebrew on, tick the people who may use it under **Who may use Hebrew**, then **Save who may use Hebrew**. Only they are offered it. A new Hebrew code starts with the Admin who applied it, so they see Hebrew in the language list at once; tick everyone else who should have it. A renewed code keeps the people chosen. If nobody is ticked, the page says so: nobody sees Hebrew until people are chosen. A server where an older version left Hebrew on for nobody gives it to the Admin who applied the code on its next start.

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
| Turn the Cx Credits Calculator on | `node scripts/activation.mjs calculator issuer-key.pem "Acme Corp" on` |
| Turn the Cx Credits Calculator off | `node scripts/activation.mjs calculator issuer-key.pem "Acme Corp" off` |
| See what a code contains | `node scripts/activation.mjs show MZ1.…` |

- **Validity:** a code lasts 12 months. Add a number of months as the last argument to change that.
- **Format:** a code is `MZ1.<payload>.<signature>`. The payload names the organisation, what the code unlocks and when it expires. Anyone can read it with `show`, but only your key can sign one.
