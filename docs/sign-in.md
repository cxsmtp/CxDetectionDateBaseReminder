# Sign-in and passwords

How people sign in, and what happens when someone forgets their password. For the screens themselves, see the
[user guide](user-guide.md#sign-in).

## Forgot your password?

**Forgot your password?** under the **Sign in** button sends a one-time link to the account's own email address. It
shows only when it can work: an Admin allows it (People & roles → **Sign-in**), the email server is set up and tested,
and the server's own address is set (Settings → Server address, or `REPORT_SERVER_URL` / `PUBLIC_URL`).

What keeps it safe:

| | |
| --- | --- |
| **Nothing to learn from asking** | The answer is word for word the same whether or not the address has an account, and the account is looked up only after the answer is given, so neither the words nor the timing say anything. What was typed is kept in the audit log only when it is an account here (it could be a password typed in the wrong box). |
| **Only to the account's own address** | The link goes to the email address of the account, never to one given in the request. Accounts that sign in with a Checkmarx One key only, disabled accounts, and the maintainer's address never get one. |
| **Only to this server** | The link points at the address set for this server, never at the address a request arrived on, which anyone can forge to steer the link to their own site. It must be https (unless it is the computer the server runs on). |
| **A secret no one else holds** | The link carries 256 random bits after `#`: browsers never send that part to a server or in a `Referer`, and mail scanners that open the link cannot use it up. The page takes it out of the address bar at once. The server keeps only its SHA-256, in memory: neither a copy of the data folder nor the audit log holds a working link, and a restart ends every link. |
| **Once, for 30 minutes** | A link works once. Asking again replaces the earlier link; changing the password any other way, disabling the account, removing it or changing its email ends it too. |
| **Limited** | At most 3 links an hour to one person, a minute apart, and at most 10 requests (and 10 links that do not work) a quarter of an hour from one network address. |
| **Strong, and new** | The new password follows the same rules as everywhere (12+ characters, not repetitive) and may not be the current one. |
| **Everyone out** | Saving it signs the account out everywhere, clears a lock after wrong passwords, and an email to the account confirms the change with when and from where. |
| **Recorded** | Each link sent (or not sent, and why), and each password reset, is in the audit log, never the link itself. |

**Who may use it** (People & roles → **Sign-in**, for the whole server): **Everyone with a password** (the default),
**Everyone except Admins** (people who may manage people or tenants), or **Nobody**. An Admin who may not reset by email
gets a temporary password from another Admin, or on the server with `node scripts/reset-admin.mjs`.

## An Admin edits someone's profile

People & roles → **Edit profile** opens the person's profile: name, language, time zone, programming languages, Impact
figures, look and picture, and their sign-in email. It is open to people who may manage people, for the people whose
permissions they hold all of (the rule for changing a role), never their own (that is Settings → Your profile).

- **A new sign-in email** must not be anyone else's address or Checkmarx One identity. It is confirmed first, ends any
  password reset link sent to the old address, and both the old and the new address are told by email. The person's
  sessions carry on; from then on they sign in with the new address.
- **Everything is checked before anything is saved**: a wrong time zone, language or figure changes nothing.
- **Every change is in the audit log** (type **Access change**), with the old and the new email.
