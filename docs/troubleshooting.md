# When a connection does not work

Setting up the email server, Checkmarx One or a git host is where most time gets lost: a wrong port, a TLS setting that does not match it, a key copied in two pieces, an app password that was needed, a company proxy. MissionZero does not just say "it failed". It says what is wrong in one sentence, then the steps that fix it.

## Where you see it

A **How to fix it** box appears under:

- **Test connection** and **Send test email** (Settings → Email server);
- **Connect & store** (Settings → Checkmarx One);
- the check that runs after you change either one, and the notice when it was put back to the last working settings;
- **Test** next to each git host (Beta → Source-code hosts);
- the header's connection chips (Checkmarx One, Email, Git), while a connection does not work;
- a **.env upload** (Settings → Quick setup), for each connection it checks.

The box shows:

- **The problem**, in one sentence.
- **How to fix it**: numbered steps, most likely first.
- **What was tried**, folded away: the server and port, the TLS setting, the account, the tenant and addresses, and the other side's own answer (for example `535 5.7.139 Authentication unsuccessful`). Passwords, keys and tokens are never shown.

It is in the language you chose. Names of settings, commands and the other products' own screens (for example **Authenticated SMTP** in Microsoft 365) stay as they are, so you can find them.

## A .env file is checked before anything in it is used

When you upload a .env file, every line is read first:

- **A mistake that would break a connection is not applied**, so the setting that works stays. It is listed with its line number, what is wrong and how to fix it. For example: a port that is not a number, `SMTP_SECURE=ssl`, a host written as `smtp://…:587`, a misspelt name (**Did you mean** `SMTP_USER`?), the API key's ID instead of the key, an example value left in.
- **Something that is probably wrong but could work is applied** and listed as **Check this**. For example: a Gmail password that is not a 16-character App Password, or an `http://` server address.
- **Everything else is applied**, and each connection in the file is tested, as before.

If nothing in the file can be used, nothing changes and every mistake is listed.

An API key that cannot work is also refused before it is tried when it is pasted under Settings → Checkmarx One: its ID instead of the key, a key cut short or in quotes, or an expired one.

## Every problem it recognises, and what to do

These are the same sentences the page shows.

## Email server (SMTP)

**No mail server is set.**
1. Enter the mail server name under Settings → Email server, or set SMTP_HOST in the .env file.
2. Office 365: smtp.office365.com, port 587. Gmail: smtp.gmail.com, port 587. Leave "Secure connection from the start" off for port 587.

**The mail server name is not a plain host name.**
1. Enter only the name, for example smtp.office365.com: no smtp:// or https:// in front, no port and no path after it.
2. Put the port in its own field (SMTP_PORT in the .env file).

**The port is not a valid number.**
1. Use 587 for STARTTLS (most servers, Office 365, Gmail), 465 for implicit TLS, or 25 for an internal relay.

**The server needs a username and password, and one of them is empty.**
1. Enter the username (usually the full email address of the sending mailbox) and its password.
2. In a .env file: SMTP_USER and SMTP_PASS. A blank value keeps what is set now, so a password never set stays empty.
3. If the server is an internal relay that accepts mail without signing in, turn off "Server needs a user name and password" (SMTP_REQUIRE_AUTH=false).

**The mail server name could not be found (DNS).**
1. Check the spelling of the server name.
2. An internal name must be resolvable from where MissionZero runs: inside a container, use the full name (for example mail.company.local) or the IP address.
3. Test it from the server: nslookup followed by the server name.

**The name server did not answer when looking up the mail server.**
1. Try again in a minute.
2. If it keeps failing, the container or server has no working DNS: check its network settings.

**The mail server refused the connection on this port.**
1. Check the port: 587 (STARTTLS) or 465 (implicit TLS) for most providers, 25 for an internal relay.
2. Check that the mail service is running on that server, and that its firewall allows connections from MissionZero.
3. Inside a container, localhost is the container itself: use the mail server's name or IP address instead.

**"Secure connection from the start" does not match the port.**
1. Port 465 is encrypted from the first byte: turn "Secure connection from the start" on (SMTP_SECURE=true).
2. Or keep it off and use port 587.

**The mail server's certificate is for a different name than the one entered.**
1. Enter the server name exactly as it is on its certificate (for example smtp.office365.com, not an IP address or an alias).
2. For an internal relay addressed by IP, ask for its certificate name, or turn off "Check the mail server's certificate" for that relay only.

**The mail server's certificate is not trusted.**
1. If your company inspects TLS traffic or uses its own certificate authority, give MissionZero that CA certificate: NODE_EXTRA_CA_CERTS=/certs/company-ca.pem, with the folder mounted into the container.
2. For an internal relay with a self-signed certificate, turn off "Check the mail server's certificate" (SMTP_REJECT_UNAUTHORIZED=false).

**Something answered on this port, but not a mail server.**
1. Check the port: 587 or 465 for most providers. Ports such as 993 (IMAP) or 443 (web) are not for sending mail.
2. Check "Secure connection from the start": on for port 465, off for 587, 25 and 2525.

**"Secure connection from the start" does not match the port, so the connection stalled.**
1. Port 587 (and 25, 2525) starts unencrypted and then upgrades: turn "Secure connection from the start" off (SMTP_SECURE=false).
2. Or keep it on and use port 465.

**No answer on port 25, which many networks and cloud providers block.**
1. Use port 587 with STARTTLS if your mail server offers it.
2. Otherwise ask your network team to allow outgoing connections from MissionZero to the mail server on port 25.

**The mail server did not answer in time.**
1. Check the server name and port.
2. Ask your network team to allow outgoing connections from MissionZero to the mail server on this port. MissionZero does not use a web proxy for mail.
3. Test it from the server: Test-NetConnection with the server name and -Port, or telnet with the server name and port.

**The mail server closed the connection.**
1. Check "Secure connection from the start": on for port 465, off for 587, 25 and 2525.
2. The server may only accept connections from known addresses: ask its administrator to allow the address MissionZero sends from.

**The mail server only accepts a sign-in over an encrypted connection.**
1. Use port 587 with "Secure connection from the start" off (it upgrades with STARTTLS), or port 465 with it on.

**Microsoft 365 refused the sign-in: SMTP sign-in (SMTP AUTH) is turned off for this mailbox or for your organisation.**
1. In the Microsoft 365 admin center, open the sending mailbox → Mail → Manage email apps, and turn on Authenticated SMTP.
2. If your organisation turned it off for everyone, or uses Security defaults, an Exchange administrator must allow it for this mailbox (Set-CASMailbox -SmtpClientAuthenticationDisabled $false).
3. If the account has multi-factor sign-in, use an app password, or send through a relay that does not need a sign-in.

**Microsoft 365 refused the sign-in.**
1. Check that the username is the mailbox's full email address and the password is current.
2. If the account has multi-factor sign-in, use an app password, or send through a relay that does not need a sign-in.
3. In the Microsoft 365 admin center, open the sending mailbox → Mail → Manage email apps, and check that Authenticated SMTP is on.
4. If your organisation uses Security defaults, SMTP sign-in is blocked: an Exchange administrator must allow it for this mailbox.

**Google refused the sign-in: Gmail needs an App Password, not the account password.**
1. Turn on 2-Step Verification for the Google account, then create an App Password at https://myaccount.google.com/apppasswords.
2. Paste the 16-character App Password as the password (SMTP_PASS). Spaces in it are removed for you.
3. Use the full Gmail address the App Password belongs to as the username.
4. Google Workspace: an administrator may have to allow less secure sign-in or SMTP relay for the domain.

**The mail server does not offer a sign-in on this connection.**
1. If the server needs a sign-in, it usually offers it only after encryption: use port 587 with "Secure connection from the start" off, or 465 with it on.
2. If it is an internal relay that accepts mail without signing in, turn off "Server needs a user name and password" (SMTP_REQUIRE_AUTH=false).

**The mail server refused the username or password.**
1. Check the username: most servers want the full email address of the sending mailbox.
2. Enter the password again: it may have been changed, have expired, or been pasted with a space or line break.
3. If the account uses multi-factor sign-in, create an app password for it and use that.
4. Some providers need SMTP sending turned on for the mailbox first: ask your mail administrator.

**The mail server will not send with this From address.**
1. Use the signed-in mailbox's own address as the From address (SMTP_FROM), or leave it blank to use the username.
2. To send as another address (a shared mailbox), the signed-in account needs Send As permission for it: Microsoft 365 admin center → the shared mailbox → Send as.

**The mail server only sends for signed-in accounts.**
1. Turn on "Server needs a user name and password" (SMTP_REQUIRE_AUTH=true) and enter the mailbox's username and password.

**The mail server will not pass mail on to other domains from MissionZero.**
1. Sign in with a mailbox account (turn on "Server needs a user name and password"), so the server knows who is sending.
2. Or ask the mail administrator to allow relaying from the address MissionZero runs on.

**The mail server refused a recipient address.**
1. Check the address for typos.
2. An external address may need relaying to be allowed for the sending account: ask your mail administrator.

**The message is larger than the mail server accepts.**
1. Send fewer projects in one report, or ask the mail administrator to raise the message size limit.

**The mail server blocked mail from this account or address.**
1. Ask your mail administrator why the sending account or the server's address is blocked, and to unblock it.
2. Microsoft 365: a new or suspicious account can be held for unusual sending; check the Restricted entities page in the Defender portal.

**The mail server asked to try again later (too many messages or connections).**
1. Wait a few minutes and send again: MissionZero tries again on its next run.
2. If it happens every time, ask the mail administrator about the sending limits for this account.

**The mail server test failed for a reason MissionZero does not recognise.**
1. Read the server's answer below: it usually names the problem.
2. Check, in order: the server name, the port, "Secure connection from the start" (on for 465, off for 587), the username and the password.
3. Send the server's answer to your mail administrator.

## Checkmarx One

**No Checkmarx One API key is set.**
1. Create one in Checkmarx One: Settings → Identity and Access Management → API Keys → Create API key.
2. Paste it under Settings → Checkmarx One, or set CX_API_KEY in the .env file.

**The API key has quotes around it.**
1. Paste the key without quotes. In a .env file write CX_API_KEY=eyJ… with nothing around the value.

**The API key starts with "Bearer" or "token".**
1. Paste only the key itself: it starts with eyJ.

**That is the API key's ID, not the key.**
1. The key is the long text shown once when the key is created; it starts with eyJ and has two dots in it.
2. If it was not copied then, create a new API key in Checkmarx One and copy it straight away.

**That does not look like a whole Checkmarx One API key.**
1. A key is one long line that starts with eyJ and has exactly two dots in it.
2. It is often cut short or broken over two lines when copied: copy it again in one piece, with no spaces or line breaks.
3. An OAuth client secret is not an API key: create an API key under Identity and Access Management → API Keys.

**The API key has expired.**
1. Create a new API key in Checkmarx One (Identity and Access Management → API Keys) and paste it here, or set it as CX_API_KEY.
2. Choose a longer expiry when you create it, and note the date: MissionZero shows when the key ends.

**The API key does not say which tenant it belongs to.**
1. Open "Single-tenant / on-prem addresses" under Settings → Checkmarx One and enter the IAM URL and the tenant name (CX_IAM_URL and CX_TENANT in a .env file).

**The Checkmarx One address must start with https://.**
1. Enter the address as https://…, for example https://eu.ast.checkmarx.net.
2. Or leave the addresses blank: they are worked out from the API key on the multi-tenant cloud.

**The Checkmarx One API address could not be worked out.**
1. Open "Single-tenant / on-prem addresses" under Settings → Checkmarx One and enter the API URL (CX_BASE_URL), for example https://eu.ast.checkmarx.net.

**The Checkmarx One address could not be found (DNS).**
1. Leave CX_BASE_URL and CX_IAM_URL blank on the multi-tenant cloud: they are worked out from the key.
2. If you set them, check the spelling and the region, for example https://eu.ast.checkmarx.net and https://eu.iam.checkmarx.net.
3. Check that MissionZero's server can resolve internet names: inside a container, check its DNS.

**The certificate presented for Checkmarx One is not trusted, usually because a company proxy inspects HTTPS.**
1. Get your company's root CA certificate (a .pem file) from your network team.
2. Mount it into the container and set NODE_EXTRA_CA_CERTS to its path, for example NODE_EXTRA_CA_CERTS=/certs/company-ca.pem, then restart MissionZero.
3. Or ask the network team to exclude *.checkmarx.net from HTTPS inspection.

**The certificate presented for Checkmarx One has expired.**
1. This is almost always a company proxy or firewall with an old certificate: ask your network team to renew it or to exclude *.checkmarx.net from HTTPS inspection.
2. Check the server's date and time too: a clock far off makes valid certificates look expired.

**MissionZero could not reach Checkmarx One.**
1. Ask your network team to allow outgoing HTTPS (port 443) from MissionZero's server to your Checkmarx One addresses (the IAM and API hosts, *.checkmarx.net on the cloud).
2. MissionZero connects directly, not through a web proxy: if outgoing traffic must go through one, ask for these hosts to be allowed directly.
3. If it worked before, check https://status.checkmarx.com and try again in a few minutes.

**The tenant name or IAM address is wrong.**
1. Leave CX_TENANT and CX_IAM_URL blank on the multi-tenant cloud: they are read from the key.
2. If you set them, the tenant is the name you sign in to Checkmarx One with, and the IAM URL is your region's, for example https://eu.iam.checkmarx.net.

**Checkmarx One no longer accepts this API key: it was deleted, revoked, or its user was disabled.**
1. Create a new API key in Checkmarx One (Identity and Access Management → API Keys) and paste it here, or set it as CX_API_KEY.
2. Check that the user the key belongs to is still active in Checkmarx One.

**Checkmarx One rejected the API key.**
1. Copy the key again in one piece: it is often cut short or broken over two lines.
2. Check that it is for this tenant and region: a key from another tenant is refused.
3. If it is old, create a new one in Checkmarx One (Identity and Access Management → API Keys).

**The API key works, but its roles do not allow this.**
1. In Checkmarx One, open Identity and Access Management → API Keys (or the key's user) and give it roles that can view projects, scans and results.
2. For AI Triage, AI Remediation and rescans, the key also needs the roles that run them.
3. Create the key again after changing its roles if the change does not take effect.

**Checkmarx One answered "not found": the API address is probably wrong.**
1. Leave CX_BASE_URL blank on the multi-tenant cloud, or set it to your region's ast address, for example https://eu.ast.checkmarx.net (not the iam one).
2. For single-tenant Checkmarx One, use the address you open Checkmarx One with in a browser.

**Checkmarx One asked MissionZero to slow down.**
1. Wait a minute and try again.
2. If it happens often, lower CX_MAX_CONCURRENCY (for example to 8).

**Checkmarx One had a problem answering.**
1. Try again in a few minutes, and check https://status.checkmarx.com.
2. If it lasts, raise a case with Checkmarx support and include the answer below.

**The Checkmarx One connection failed for a reason MissionZero does not recognise.**
1. Read Checkmarx One's answer below: it usually names the problem.
2. Check, in order: the API key (whole, current, for this tenant), then the addresses under "Single-tenant / on-prem addresses" (blank on the multi-tenant cloud).

## Git hosts (GitHub, GitLab, Azure DevOps, Bitbucket)

**Azure DevOps needs the organisation as well as the token.**
1. Set AZURE_DEVOPS_ORG_URL to the organisation, for example https://dev.azure.com/acme, or just acme.
2. A token is made for one organisation: use the one it was created in.

**The git host's address could not be found (DNS).**
1. Check the address (GITHUB_API_URL, GITLAB_URL, AZURE_DEVOPS_ORG_URL or BITBUCKET_URL): leave it blank for github.com, gitlab.com and bitbucket.org.
2. For a self-hosted server, use the address you open it with in a browser, and check that MissionZero's server can resolve that name.

**The git host's certificate is not trusted.**
1. If it is a self-hosted server with a company certificate, or a proxy inspects HTTPS, mount the company CA certificate and set NODE_EXTRA_CA_CERTS to its path, then restart MissionZero.

**MissionZero could not reach the git host.**
1. Check the address, and ask your network team to allow outgoing HTTPS (port 443) from MissionZero's server to it.

**GitHub refused the token for this organisation until it is authorised for single sign-on.**
1. On GitHub, open Settings → Developer settings → Personal access tokens, find the token, choose Configure SSO and authorise it for your organisation.

**The git host is limiting how many requests this token may make.**
1. Wait for the limit to reset (usually within an hour) and try again.
2. A token of a dedicated account with its own limits avoids sharing them with other tools.

**Azure DevOps did not accept the token for this organisation.** (Azure DevOps)
1. Check that the token has not expired and was created in this organisation (a token is made for one organisation, or for all accessible organisations).
2. Create a personal access token in Azure DevOps: User settings → Personal access tokens, for the same organisation, with Code (Read), Graph (Read) and Identity (Read).
3. Paste it as AZURE_DEVOPS_TOKEN, and set AZURE_DEVOPS_ORG_URL to the organisation, for example https://dev.azure.com/acme.

**The git host rejected the token: it is wrong, expired or revoked.** (GitHub)
1. Copy the token again in one piece, with no spaces, quotes or "Bearer" in front.
2. Create a token on GitHub: Settings → Developer settings → Personal access tokens. Fine-grained: choose your organisation as the resource owner and give Contents and Metadata read access. Classic: the repo and read:org scopes.
3. Paste the whole token (it starts with github_pat_ or ghp_), with no spaces or quotes, as GITHUB_TOKEN.

**The git host rejected the token: it is wrong, expired or revoked.** (GitLab)
1. Copy the token again in one piece, with no spaces, quotes or "Bearer" in front.
2. Create a token in GitLab: your avatar → Preferences → Access tokens, with the read_api and read_repository scopes.
3. Paste the whole token (it usually starts with glpat-), with no spaces or quotes, as GITLAB_TOKEN.

**The git host rejected the token: it is wrong, expired or revoked.** (Bitbucket)
1. Copy the token again in one piece, with no spaces, quotes or "Bearer" in front.
2. Bitbucket Cloud: use an app password with Repositories and Account read permissions, and set BITBUCKET_USERNAME to your Bitbucket username (not your email address). A workspace or repository access token works alone, without a username.
3. Bitbucket Data Center: create an HTTP access token with Project read and Repository read, and set BITBUCKET_URL to your Bitbucket address.

**The git host accepted the token, but it lacks a permission this needs.**
1. Create a token in GitLab: your avatar → Preferences → Access tokens, with the read_api and read_repository scopes.
2. Paste the whole token (it usually starts with glpat-), with no spaces or quotes, as GITLAB_TOKEN.

**The git host answered "not found": the organisation, group or workspace name, or the address, is wrong, or the token cannot see it.**
1. Check the organisation, group or workspace name (GITHUB_ORG, GITLAB_GROUP, BITBUCKET_WORKSPACE).
2. GitHub Enterprise: GITHUB_API_URL ends with /api/v3, for example https://github.company.com/api/v3.
3. Check that the token's account is a member and can see it.

**The git host refused the request for a reason MissionZero does not recognise.**
1. Read the answer below: it usually names the problem.
2. Create a token on GitHub: Settings → Developer settings → Personal access tokens. Fine-grained: choose your organisation as the resource owner and give Contents and Metadata read access. Classic: the repo and read:org scopes.
3. Paste the whole token (it starts with github_pat_ or ghp_), with no spaces or quotes, as GITHUB_TOKEN.

## Mistakes in a .env file

**This line is not a setting.** — not applied
1. Write each setting on its own line as NAME=value, with no spaces in the name and nothing before it (no "set" or "$env:").

**Setting names are upper case.** — not applied
1. Write the name in capitals, as in the sample file.

**This setting name is not known, and looks like a misspelling.** — not applied
1. Use the name shown under "Did you mean", as in the sample file.

**This setting is in the file more than once: only the last one counts.** — applied, worth checking
1. Keep one line for it and delete the others.

**This value is still the example text from a template.** — applied, worth checking
1. Replace it with your real value, or leave it blank to keep what is set now.

**This value has a quote at only one end.** — not applied
1. Remove the quotes, or put one at each end. Values need no quotes.

**This key or token contains spaces or a line break.** — not applied
1. Copy it again in one piece: keys and tokens have no spaces.

**This token starts with "Bearer" or "token".** — not applied
1. Paste only the token itself.

**SMTP_HOST must be a plain host name.** — not applied
1. Write only the name, for example smtp.office365.com: no smtp:// in front, no :587 or path after it. Put the port in SMTP_PORT.

**SMTP_PORT must be a number from 1 to 65535.** — not applied
1. Use 587 for STARTTLS (most servers, Office 365, Gmail), 465 for implicit TLS, or 25 for an internal relay.

**This setting takes true or false.** — not applied
1. Write true or false. For SMTP_SECURE: true for port 465 (SSL/TLS), false for 587 (STARTTLS).

**SMTP_SECURE does not match SMTP_PORT, so the connection will stall.** — not applied
1. Port 465: SMTP_SECURE=true. Ports 587, 25 and 2525: SMTP_SECURE=false.

**Microsoft 365 sends on port 587, not 465.** — not applied
1. Set SMTP_PORT=587 and SMTP_SECURE=false.

**Gmail needs a 16-character App Password, and this one is not.** — applied, worth checking
1. Create an App Password at https://myaccount.google.com/apppasswords (it needs 2-Step Verification) and use it as SMTP_PASS.

**SMTP_REQUIRE_AUTH is true but SMTP_USER is empty.** — applied, worth checking
1. Set SMTP_USER to the sending mailbox's address and SMTP_PASS to its password, or set SMTP_REQUIRE_AUTH=false for a relay that needs no sign-in.

**This is not an email address.** — not applied
1. Write one address, for example missionzero@company.com.

**This is not a web address.** — not applied
1. Write the whole address starting with https://, for example https://mission-zero.company.com.

**This address is not https.** — not applied
1. Use https://: the key and tokens are only sent over an encrypted connection.

**CX_BASE_URL is the IAM address; it should be the API (ast) address.** — not applied
1. Set CX_BASE_URL to the ast address, for example https://eu.ast.checkmarx.net, and CX_IAM_URL to the iam one. On the multi-tenant cloud, leave both blank.

**CX_IAM_URL is the API address; it should be the IAM address.** — not applied
1. Set CX_IAM_URL to the iam address, for example https://eu.iam.checkmarx.net. On the multi-tenant cloud, leave it blank.

**CX_TENANT should be the tenant name only.** — not applied
1. Write the name you sign in to Checkmarx One with, for example acme: not an address. On the multi-tenant cloud, leave it blank.

**GITHUB_API_URL is the web address, not the API address.** — not applied
1. Leave it blank for github.com. For GitHub Enterprise, use the address followed by /api/v3, for example https://github.company.com/api/v3.

**GITHUB_TOKEN does not look like a GitHub token.** — applied, worth checking
1. A GitHub token starts with github_pat_, ghp_, gho_ or ghs_. Create one under GitHub → Settings → Developer settings → Personal access tokens.

**AZURE_DEVOPS_ORG_URL is not an Azure DevOps organisation.** — not applied
1. Write the organisation, for example https://dev.azure.com/acme, or just acme.
