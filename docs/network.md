# Network and proxy

How CxMissionZero reaches Checkmarx One and the other services it uses, and what your network team needs to allow. Everything it sends is encrypted (HTTPS, TLS 1.2 or later).

## Directly, or through your company's proxy

By default the server connects directly. When your network lets outgoing web traffic out only through a proxy, set it under **Settings → Network & proxy**:

| Field | Meaning |
| --- | --- |
| **Proxy server** | The proxy, as `host:port`, for example `proxy.acme.local:8080` (`http://` is assumed; `https://` works too). A SOCKS proxy is not supported. |
| **User name, if the proxy asks for one** / **Password** | For a proxy that asks for a user name and password (basic authentication). The password is kept on the server and never shown again; leave it blank to keep the saved one. |
| **Hosts that skip the proxy** | Names or addresses reached directly, separated by commas: `.acme.local` (the domain and everything under it), `smtp.acme.local`, `10.0.0.5`. This machine is always reached directly. |
| **Checkmarx One address to check** | Filled in from the API key once one is stored. Before that, type your region's IAM address, for example `ind.iam.checkmarx.net`. |

**Check the connection** tries the way to Checkmarx One with what is typed, before anything is saved, and says where it stops:

| Step | ✓ | ✕, and what to do |
| --- | --- | --- |
| **Proxy** | The proxy answered | The address or port is wrong, or the proxy is not reachable from the server: check them with your network team |
| **Connection** | The proxy opened a connection to Checkmarx One | **407**: the proxy wants a sign-in (a user name and password, or allow the server by its IP address). **403**: the proxy does not allow the host (ask for `*.checkmarx.net` on port 443) |
| **Certificate** | Checkmarx One's certificate is trusted | Usually a proxy that inspects HTTPS: connect under **Settings → Checkmarx One** and select **Trust and connect** (see [troubleshooting](troubleshooting.md#certificates)), or ask for an exception from inspection |
| **Checkmarx One** | Checkmarx One answered | — |

With the proxy empty, the same check tries the direct connection.

**Save and restart** checks again and saves the proxy only if it lets Checkmarx One through, then restarts the server to use it: people see "reconnecting…" for a few seconds, as with an update, and stay signed in. **Stop using the proxy** goes back to direct connections the same way. Both are in the audit log. Only administrators of the first tenant change it, as it applies to the whole server.

Windows-integrated sign-in to the proxy (NTLM / Kerberos) is not supported: a server process cannot use it. Ask for the server to be allowed by its IP address, or for a user name and password for it.

**Through the proxy:** Checkmarx One, git hosts, Let's Encrypt and updates (everything the server reaches over HTTPS). **Directly:** the email server, which speaks SMTP rather than web traffic, and the hosts that skip the proxy.

### With environment variables instead

The usual `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` variables work too, for example (Windows cmd, one line):

```
podman run -d --name mission-zero -p 3000:3000 -v mission-zero-data:/data -e HTTPS_PROXY=http://proxy.acme.local:8080 -e NO_PROXY=.acme.local --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

A proxy saved under Settings takes precedence over them. Both need the image's own start command (the launcher), which hands the proxy to the server at every start.

## What your network team needs to allow

**Settings → Network & proxy** lists every connection the server makes or takes, worked out from its own settings: the Checkmarx One addresses of your key, your email server, the git hosts with a token, Let's Encrypt when it is used, updates, and the port people's browsers use. **Copy for your network team** and **Download (.txt)** give it as text for a ticket or an email.

For Checkmarx One through a proxy, one rule is enough:

- Allow the CxMissionZero server's IP address to `*.checkmarx.net` (or your region's IAM and API hosts) on port 443, as HTTP CONNECT.
- Without HTTPS inspection for these hosts. If inspection must stay, the server can trust the proxy's certificate instead (**Trust and connect**).
- Without Windows-integrated sign-in: allow by IP address, or give a user name and password for basic authentication.
