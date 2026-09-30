# Checkmarx One Report Connector

A small Chrome / Edge extension that lets the vulnerability report attached to
reminder mails connect **directly** to Checkmarx One.

## Why it is needed

The report is opened from an email attachment, i.e. as a local file. Checkmarx
One's API refuses calls from such a page (browsers enforce this through CORS),
so without help the report cannot triage anything. Browser extensions are the
one thing exempt from that rule. This extension does exactly two things for a
report:

1. **Sign-in.** *Connect to CxONE for action → Sign in to Checkmarx One* opens
   your tenant's normal sign-in page (username and password, or SSO) in a small
   window. When you have signed in, the window closes by itself and the report
   shows **✓ Connected**. The session is kept until the browser closes, and
   AI Triage runs as *you* — Checkmarx One's audit trail shows your name.
   (Pasting an API key instead is also supported.)
2. **AI Triage calls.** Only `POST /api/ai-triage/triage`,
   `GET /api/ai-triage/triage/{projectId}/{groupId}` and a connection check.
   It makes no other Checkmarx One call, so no other local file can use your
   signed-in session for anything else. It stores no password; the session
   lives in the browser's session storage and is gone when the browser closes.

## Install (each developer, once)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Switch on **Developer mode**.
3. **Load unpacked** → choose this `extension` folder.
4. Open the extension's **Details** and switch on **Allow access to file URLs**
   — reports open as files, so without this the report cannot see the extension.

For a company roll-out, publish it privately to the Chrome Web Store / Edge
Add-ons, or force-install it with the `ExtensionInstallForcelist` policy; file
URL access can be allowed by policy as well.

## Tenants

It works with Checkmarx One hosts under `*.checkmarx.net`. For a single-tenant
or custom domain, add that host to `host_permissions` in `manifest.json`.

Sign-in uses the Checkmarx One portal's own public client (`ast-app`) with the
OAuth authorization-code flow and PKCE, returning to the portal address. If the
sign-in window shows *"Invalid parameter: redirect_uri"*, your tenant does not
allow this; use an API key in the same dialog, or connect through the reminder
server instead.
