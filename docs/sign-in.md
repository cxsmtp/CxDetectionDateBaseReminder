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

## Two-step sign-in

After the password, a six-digit code from an authenticator app on the person's phone (Microsoft Authenticator, Google
Authenticator, or any other that makes time-based codes). Someone who learns a password still cannot sign in.

**What it covers.** Signing in with an email and password. It is not asked for when signing in with a Checkmarx One
API key, after single sign-on (the identity provider has its own), or by the links in emailed reports.

**Turning it on, for yourself.** Settings → Your profile → **Two-step sign-in** → **Turn on two-step sign-in**.

1. Scan the QR code with the app. If the phone cannot scan it, type the key shown beside it (**Copy the key**).
2. Enter the code the app shows and press **Turn on**. Only then is it on.
3. Keep the ten **recovery codes** somewhere safe, not on the phone. They are shown once.

The QR code is made in the page itself. Nothing is fetched from the internet, and the key is sent nowhere.

**Signing in.** Email and password as before, then the code. **Use a recovery code** takes one of the ten instead:
each works once.

**Lost the phone?** Sign in with a recovery code. No codes left either: an Admin resets it under People & roles →
People → **Reset two-step**, and you set it up again.

**The only Admin lost it.** Start the server once with `RESET_TWO_STEP` set to their email address: the usual
command, with `-e RESET_TWO_STEP=…` added. For example:

```
podman run --replace -d --name mission-zero -p 3000:3000 -v mission-zero-data:/data -e TZ=Asia/Dubai -e RESET_TWO_STEP=admin@company.com --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

- The log says `Two-step sign-in was reset for admin@company.com`, and the audit log records it. They sign in with
  their password and set two-step sign-in up again.
- Then start the server again without the variable. Left in, it does nothing more: it works once for a person, until
  the server has been started without it.
- Whoever can set the server's environment can do this, as they can run `node scripts/reset-admin.mjs`.
- **The password is lost as well?** `podman exec mission-zero node scripts/reset-admin.mjs admin@company.com` sets a
  temporary password and takes two-step sign-in off in one go, without a restart. It is recorded in the audit log.

**New recovery codes** and **Turn off two-step sign-in** are in the same place. Both ask for a current code from the
app: a recovery code is not enough.

**Required for everyone.** People & roles → **Sign-in** → **Require two-step sign-in for everyone who signs in with a
password** (an Admin's switch, off by default, for the whole server). Turned on:

- a person without it sets it up at their next password sign-in, before they get in;
- nobody can turn their own off;
- people who are signed in carry on until they sign in again.

What keeps it safe:

| | |
| --- | --- |
| **A standard anyone can check** | TOTP (RFC 6238): HMAC-SHA1, six digits, a new code every 30 seconds. The code before and the code after are accepted too, because clocks differ. Made with Node's own crypto: no added library. |
| **No session before the code** | A correct password gives only a ticket: random, kept in the server's memory, for that one person, for five minutes. The session comes with the code. |
| **A code works once** | The server remembers the last code used. That code, and any older one, is refused from then on. |
| **Wrong codes are limited** | Five wrong codes end the ticket, and the password has to be typed again. They also count as wrong passwords do: five in a row lock the account for 15 minutes. |
| **Recovery codes are not kept** | Only their SHA-256 is. A used one is removed. |
| **The key is where the server needs it** | The server must work out the code, so the key cannot be a hash. It is kept with the person in `iam.json` in the state folder (readable by the server's own user only), and so it is in backups: keep them as safe as the server. When two-step sign-in is turned off or reset, the file is saved so that no earlier copy of it keeps the key. |
| **Recorded** | Turning it on and off, a reset by an Admin, a recovery code used, new recovery codes, and every refused and accepted code are in the audit log. Never a code, a key or a ticket. |

## Single sign-on (OpenID Connect)

People sign in at your organisation's identity provider and come back signed in here. It works with Microsoft Entra
ID, Okta, Keycloak, Google and any other provider that speaks OpenID Connect.

**Setting it up** (an Admin, People & roles → **Sign-in** → **Single sign-on**; for the whole server):

1. Set this server's own address first (Settings → Server address). It must be https, unless it is the computer the
   server runs on. While single sign-on is on, only an Admin changes that address, and never into one that is not
   https: turn single sign-on off first. After a change, give the provider the new redirect address.
2. At the identity provider, register CxMissionZero as a web application. Give it the **Redirect address** the page
   shows: the server address followed by `/api/session/oidc/callback`. Ask for the `openid`, `email` and `profile`
   scopes.
3. Back here, fill in the **Identity provider address (issuer)**, the **Client id** and the **Client secret** the
   provider gave you, and what the button should say.
4. Tick **Offer single sign-on on the sign-in page**, press **Save single sign-on**, then **Check the identity
   provider**.

| Setting | What it does |
| --- | --- |
| **Offer single sign-on on the sign-in page** | Off by default. Off: no button, and nobody can sign in this way. |
| **Identity provider address (issuer)** | An https address. The server reads `/.well-known/openid-configuration` under it to find the rest. Plain http is accepted only for a provider on the same computer. |
| **Client id**, **Client secret** | From the provider. The secret is stored on the server and never shown again: the page says only **(stored)** or **(not set)**. Leave the field empty to keep the stored one. A new provider address on another host needs it typed again. |
| **Button label** | What the button on the sign-in page says. |
| **Who may sign in this way** | **Only people who are already in People & roles** (the default), or **Everyone the identity provider signs in: add them with the role below**. A person added this way gets the role you choose, never Admin, and no password. It needs at least one email domain allowed. A person you remove is added again at their next single sign-on: to keep someone out, disable them instead. |
| **Email domains allowed** | Optional, unless people are added by themselves. Listed: only addresses in those domains. |
| **The identity provider must mark the email address as verified** | On by default. Turn it off only for a provider that never sends that mark. Even then, someone who may manage people is not signed in on an unverified address, unless they are already linked (below). |
| **Only Admins may still sign in with a password** | Off by default: passwords keep working beside single sign-on. On: only people with the Admin role can still use theirs, so that an Admin gets in when the provider cannot be reached. Only this switch and the first one decide it, both an Admin's. |

**Microsoft Entra ID.** The issuer is `https://login.microsoftonline.com/<tenant id>/v2.0`. In the app registration,
add the optional claim `email` to the ID token. Entra ID does not usually send the "verified" mark: if sign-in is
refused for that reason, keep the app registration to your own tenant and turn **The identity provider must mark the
email address as verified** off. People who may manage people (Admins, Security Analysts) are then not signed in this
way: they use their password, or are linked while the mark is still required.

**Who is signed in.** The first time, the person in People & roles whose email address is the one the provider gives.
That sign-in links them to their account at the provider (the provider's own address and its id for the account, in
`iam.json`). From then on they are that account, whatever its email address is called, and another account with the
same email address is refused. Their role, and what they may do, are set here, not at the provider. A disabled person
is refused. The session is the one a password sign-in gives: the same cookie, the same 8 idle hours, the same entry in
the audit log, which says it was single sign-on. Two-step sign-in is not asked for.

- **Reset single sign-on link** (People & roles → People, for a linked person): for someone whose account at the
  provider was made anew. Their next single sign-on links them again, by their email address. In the audit log.
- Changing the **Identity provider address** to another provider resets everyone's link.
- **No password of their own.** Someone who signed in with single sign-on and has no password here cannot set one
  themselves: it would keep them in after they are gone at the provider. An Admin gives them one (**Set password**).

**What is and is not covered.** Single sign-on is one more way in. Signing in with a Checkmarx One API key, and the
links in emailed reports, work as before. Removing someone at the provider stops them signing in this way; to end a
session they already have, or a password they still hold, disable them under People & roles.

What keeps it safe:

| | |
| --- | --- |
| **The standard flow** | The authorization code flow with PKCE (S256), a `state` and a `nonce`. They are kept on the server for ten minutes, used once, and tied to the browser that started by an HttpOnly, SameSite=Lax cookie: a link made in someone else's browser signs nobody in. |
| **The token is verified here** | The ID token's signature is checked against the provider's published keys with Node's own crypto. Only RS256, PS256 and ES256 are accepted: never `none`, never a shared-secret algorithm. Then its issuer, audience (and authorized party), expiry, issue time and nonce. |
| **A verified email, then the account itself** | The email comes from the ID token, or from the provider's userinfo address when the token has none, and only when the provider marks it verified (unless an Admin turned that off; never for someone who may manage people). After the first sign-in the person is the provider's account, not the address. |
| **A cookie nobody else chose** | Every start makes a new cookie for the round trip. One the browser already holds is never taken over. |
| **Outgoing calls follow the server's rules** | https only, never a link-local or cloud metadata address, through the proxy and with the certificates set under Settings → Network & proxy. Redirects are not followed. The provider is on the sheet under **What your network team needs to allow**. |
| **Plain words, no secrets** | When it does not work, the person reads one plain sentence. Tokens, the client secret and the provider's own error text are never shown, and never written to the audit log or the server log. The server log has one line that says what was wrong, for the Admin. |
| **Limited** | The same limit as every sign-in: 30 attempts in ten minutes from one address. |
| **Recorded** | Every change to these settings, every sign-in and every refusal is in the audit log. |

**When it does not work.** The sign-in page says why in a sentence. The Admin finds the detail in the audit log
(**Sign-ins**) and in the server log, on a line starting `! [single sign-on]`. The most common causes: the redirect
address at the provider is not the one shown here; the client secret is wrong; the person's email at the provider is
not their email here; the server cannot reach the provider (**Check the identity provider** tries it).
