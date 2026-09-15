# Checkmarx One — Detection Date Reminder

A small self-hosted utility that answers one question: **which vulnerabilities have
been sitting unfixed, and for how long?** — and then nudges the right people about
them through a Feedback App you have already configured in Checkmarx One.

Click **Fetch projects**, and the tool pulls every project from the CxONE Projects
API, reads each project's risks from the **Risk Insights** API, and buckets every
finding by how long ago it was *first detected*:

| Bucket | Meaning |
| --- | --- |
| `≤ 30 days` | first detected in the last 30 days |
| `31–60 days` | first detected 31–60 days ago |
| `> 60 days` | first detected more than 60 days ago — nobody has touched these |

Pick the buckets (and optionally a subset of projects), choose a Feedback App, and
send. Recipients are **never typed into this tool** — they come from the Feedback
App's own configuration in Checkmarx One, so the distribution list stays managed in
one place.

---

## Quick start

```bash
npm install
cp .env.example .env      # then paste your CX_API_KEY into it
npm start                 # http://127.0.0.1:3000
```

The only required setting is `CX_API_KEY`. A Checkmarx One API key is itself a JWT
whose `iss` claim names your tenant and region, so the IAM URL, tenant and API host
are derived from it automatically. Generate one under
**Settings → Identity & Access Management → API Keys**.

Run the tests with `npm test`.

---

## How it works

```
public/            Single-page UI (no build step, plain ES modules)
src/server.js      Express app: /api/health, /api/scan, /api/feedback-apps, /api/reminders
src/config.js      Env parsing + endpoint derivation from the API key
src/cxone/auth.js  API key -> access token (OIDC refresh-token grant, cached)
src/cxone/client.js    Authenticated fetch: retries, 401 re-auth, offset/limit pagination
src/cxone/projects.js  Projects API
src/cxone/risks.js     Risk Insights API, first-detection normalisation, age bucketing
src/cxone/feedbackApps.js  Lists Feedback Apps and reads their recipient lists
src/reminder.js    Builds the HTML/plain-text reminder and delivers it
```

### Authentication

`POST {iam}/auth/realms/{tenant}/protocol/openid-connect/token` with
`grant_type=refresh_token`, `client_id=ast-app`, `refresh_token=<your API key>`.
The access token is cached until 30s before expiry, concurrent refreshes are
collapsed into one request, and a mid-flight `401` transparently re-authenticates.

### First-detection dates

Different Checkmarx scanners spell the first-detection field differently
(`firstFoundAt`, `firstDetectionDate`, `firstSeenAt`, `introducedAt`, …), and dates
arrive as ISO strings, epoch seconds *or* epoch milliseconds. `normalizeRisk()`
resolves all of these; anything genuinely undated lands in an `unknown` bucket and
is counted separately rather than silently treated as new.

### Delivery

`REMINDER_DELIVERY_MODE` controls the transport — the recipient list always comes
from the selected Feedback App:

- `auto` *(default)* — POST to the Feedback App trigger endpoint; if the tenant does
  not expose one, fall back to SMTP using the app's configured recipients.
- `feedback` — Feedback App trigger endpoint only.
- `smtp` — send directly via SMTP to the app's recipients.

**Preview email** renders the exact message without sending anything.

---

## ⚠️ Endpoint paths you should verify

The Risk Insights and Feedback App paths below are **configurable on purpose**.
Checkmarx's published API reference was not reachable from the environment this was
built in, so these defaults are best-effort and may not match your tenant. Nothing
else in the tool needs to change if they differ — just set the env var.

| Setting | Default | Notes |
| --- | --- | --- |
| `CX_RISKS_PATH` | `/api/risk-management/risks/{projectId}` | "Retrieve Risks with AI Insights" |
| `CX_FEEDBACK_APPS_PATH` | `/api/feedbackapps` | Lists configured Feedback Apps |
| `CX_FEEDBACK_APP_TRIGGER_PATH` | `/api/feedbackapps/{appId}/notify` | Sends through the app |

To reduce the chance of a dead end, the client **probes a short list of alternative
paths** when the configured one returns `404`/`405`, and remembers whichever answers
(`CX_RISKS_AUTODISCOVER=false` turns this off). The UI reports the path that actually
worked after a fetch, so you can pin it in `.env`.

If the Risk Management service is not enabled on your tenant at all, set
`CX_RISK_SOURCE=scan-results`. That fallback reads each project's latest completed
scan via `/api/projects/last-scan` and takes `firstFoundAt` from `/api/results`,
which gives the same ageing view from an API that is available everywhere.

Response envelopes are also unwrapped defensively (`items` / `results` / `data` /
`risks` / a bare array), so a differently-shaped payload does not break the tool.

---

## Configuration reference

See [`.env.example`](.env.example) for the annotated list. In short:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CX_API_KEY` | — | **Required.** Checkmarx One API key |
| `CX_BASE_URL` / `CX_IAM_URL` / `CX_TENANT` | derived from the key | Override for single-tenant / on-prem |
| `CX_RISK_SOURCE` | `risk-insights` | or `scan-results` |
| `CX_FETCH_CONCURRENCY` | `5` | Projects fetched in parallel |
| `REMINDER_DELIVERY_MODE` | `auto` | `auto` / `feedback` / `smtp` |
| `SMTP_HOST` … `SMTP_FROM` | — | SMTP transport settings |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Where the UI listens |

---

## Operational notes

- **`.env` is gitignored.** The API key is a long-lived credential — keep it out of
  version control and off shared machines.
- **No authentication in front of the UI.** It binds to `127.0.0.1` by default for
  that reason. Put it behind a reverse proxy with auth before exposing it.
- **A project whose risks cannot be read is reported inline**, with the error shown
  in its table row, rather than failing the whole fetch.
- **Scan results are held in memory** between fetching and sending, so a reminder
  always reflects exactly the list you were looking at. Restarting clears it.
