# Beta features

**Beta or final.** Each feature starts in Beta, for roles holding "Beta features". An Admin makes it final under **Settings → Beta features** (permission "Make Beta features final"), and can put it back:
- **Code authors, once final:** anyone who may send reminders can use it, and scheduled reminders (Act → Automation → Reminders → *Also email the code authors*) email the developer who last changed the line of each finding that just crossed a threshold, up to 200 findings a run.
- **Matching usernames, once final:** anyone who may change initiator addresses can run and apply it.
- **SLAs and escalation, once final:** everyone who loads findings sees what is past its SLA and due soon. Escalation stays as set under **Settings → SLAs**: off until an Admin names who to escalate to.
- **Fusion results, once final:** everyone who loads findings sees **Labs → Fusion results** and the Workbench's **Fusion** column.
- **FAE Flush, once final:** it moves out of Labs to the top of **Act** (FAE Flush, Workbench, Automation), for anyone who manages the Checkmarx One integration; the Workbench stays the home page.

Every change of stage is in the audit log.

Code authors and username matching live in **Labs**, the section set apart at the bottom of the menu (their page is **Code authors**; until MZ-01.00.82 it was the **Beta** item under Act); **Fusion results** and **FAE Flush** are pages of their own there ([below](#fusion-results), [FAE Flush](#fae-flush)). Code authors and matching read git history and, optionally,
the APIs of GitHub, GitLab, Azure DevOps and Bitbucket; check what they find before
relying on it.

## Email the authors of vulnerable code

For each finding in the current Workbench scope (severities and a maximum you choose):

1. **Where** — the finding's scan result gives the exact file and line: the
   sink node of a SAST data flow (the vulnerable call), or the KICS line.
   Open-source (SCA) findings have no line of your code and are skipped.
2. **Which code** — the scan's commit when Checkmarx One recorded one, else its
   branch, else the project's main branch. The repository comes from the scan
   (`metadata.Handler.GitHandler.repo_url`) or the project's `repoUrl`.
3. **Who** — blame of that line, one request per file however many findings are
   in it:
   - **Through the host's API:** GitHub GraphQL, GitLab REST (`…/files/:path/blame`), or Bitbucket Data Center REST (`browse/:path?blame=true`), when that host's token is set.
   - **Otherwise `git blame` on a local clone:** Azure DevOps and Bitbucket Cloud (they have no blame API), any other host, or a host without a token.
   - **Credentials:** a clone of a private repository uses that host's own token, sent as an HTTP header in the environment, never in arguments or on disk:
     - GitHub `x-access-token`;
     - GitLab `oauth2`;
     - Azure DevOps a PAT;
     - Bitbucket an app password or an access token.
   - **Which hosts:** only github.com, gitlab.com, bitbucket.org, dev.azure.com, the hosts connected on this page, and any named in `SCM_ALLOWED_HOSTS` (comma-separated, set when the container starts). A repository address on any other host is refused, so a project's repository URL can never make the server call an internal address.
   - **Cache:** clones are kept under `git-cache/` in the state folder (never backed up) and refreshed at most every 10 minutes.
4. **Their address** — the commit's author email. When it is hidden behind a noreply
   address (GitHub's `ID+login@users.noreply…`, GitLab's `ID-username@users.noreply…`)
   or is not usable, the username is resolved with that host's methods below,
   cheapest first, starting with the history of the repository just cloned.

5. **Never the wrong person.** Local `git blame` ignores whitespace-only changes and code that
   was only moved (`-w -M -C`), skips the commits the repository lists in
   `.git-blame-ignore-revs` (mass reformatting), and looks past up to 3 commits made by bots
   (Dependabot, Renovate, GitHub Actions, any `[bot]` account) to the person who wrote the line.
   When a host's blame API answers with a bot or a commit that looks like reformatting, the line
   is blamed again locally. Each answer then says how sure it is:

   | Shown as | When | Ticked for sending? |
   |---|---|---|
   | **Sure** | Blamed at the exact commit Checkmarx One scanned, by a person, and the line still holds the vulnerable code where that can be checked. | Yes |
   | **Check** | The scan recorded no commit, so its branch was blamed and the line still matches; or the host's blame named a commit that looks like reformatting. | No |
   | **Unsure** | The line no longer holds the vulnerable code (it moved or changed after the scan), the scanned commit is gone so a later version was blamed, or the last change was a bot's. | No |

   Unsure and Check answers are shown with the reason, and are only emailed if you tick them
   yourself. Scheduled reminders only ever email **Sure** answers.

   Tested on real git repositories: a whitespace-only change, a reformatting commit listed in
   `.git-blame-ignore-revs`, a Dependabot commit on the line, and code moved down the file all
   still name the original author; a line replaced after the scan, and a scanned commit that is
   gone, are reported as Unsure.

6. **Who else owns it (read-only).** Two things the host already knows are shown next to
   the author, never used to choose who is emailed:
   - **Code owners:** the owners the repository's `CODEOWNERS` file gives the file, at the
     scanned version. It is read the way the host reads it: the last matching rule wins, and
     on GitLab the last matching rule of each `[Section]` (with the section's default
     owners). Places looked at: GitHub `.github/`, the root, `docs/`; GitLab the root,
     `docs/`, `.gitlab/`; Azure DevOps and Bitbucket also `.azuredevops/` and `.bitbucket/`.
     On GitHub and GitLab it is read through the API (at most 3 requests a repository);
     elsewhere from the clone `git blame` already made, never a new clone.
   - **The change request it came in through:** for the blamed commit, the GitHub pull
     request or GitLab merge request that merged it, who opened it, and who approved it. On
     GitHub, a reviewer counts as an approver only if their last verdict was an approval.
     A commit pushed straight to the branch shows none. At most 100 commits a run, 2
     requests each.
   A repository without a `CODEOWNERS` file, a token without access, or a host without
   these APIs (Azure DevOps and Bitbucket change requests) simply shows nothing.

Each author gets one email listing the findings on lines they last changed,
with links to the finding in Checkmarx One and to their commit, the file's code owners, and
the pull or merge request it came in through. Preview first.

Tested end to end against the real `expressjs/express` repository: 5 of 6
findings traced to their commit (the SCA one correctly skipped), 3 authors,
0 GitHub API calls; first run 1.5 s including the clone, then ~150 ms per line.

## Match GitHub usernames to email addresses

Scan initiators of SCM-triggered scans are often GitHub usernames. Four
methods, runnable side by side on your own usernames (**Compare methods**):

| Method | How | Cost | Finds |
|---|---|---|---|
| Local git history | `git log` of repositories you name (paths, or https URLs cloned without file contents). A commit made with `ID+login@users.noreply.github.com` ties the login to an author name, and that name's other commits give the real address. Logins are also matched to author names and addresses (`prohde` → Philipp Rohde, `tjrhines1` → tjrhines@…, org prefixes like `cx-` stripped); names shared by different addresses are left out. | 0 API calls | Company repos: people who commit with their work address |
| GraphQL batch | One query per 50 users: public email and `organizationVerifiedDomainEmails` (your org's verified-domain address, visible to org members even when the profile hides it). | 1 request / 50 users | Org members with a verified domain |
| Commit author | Email on the user's own commits: REST commits-by-author in repositories you list, or commit search across the org. | 1 request / user / repo; search 30 a minute | Hidden profile emails (git records the author email) |
| Public profile | `GET /users/{login}` | 1 request / user | Only users who made their email public |

### Measured

Local git history against real public repositories, scored against ground
truth (the PR author named in "Merge pull request #N from **login**/…" and the
address on that PR's commits):

| Repository | PR authors | Found | Correct | Recall | Precision | API calls | Time |
|---|---|---|---|---|---|---|---|
| expressjs/express | 116 | 69 | 69 | 59% | 100% | 0 | 0.15 s |
| axios/axios | 114 | 60 | 58 | 51% | 97% | 0 | 0.13 s |
| lodash/lodash | 71 | 43 | 43 | 61% | 100% | 0 | 0.27 s |
| pallets/flask | 525 | 334 | 331 | 63% | 99% | 0 | 0.25 s |

(Open-source ground truth understates it: maintainers commit into other
people's PR branches. In company repositories, where people commit with their
work address, recall is higher.)

The API methods could not be measured against github.com from the build
environment (its GitHub access is limited to one repository), so they were
verified against a GitHub API double for correctness and cost: 121 users
resolved with **3** GraphQL requests versus **121** profile requests. Their hit
rates depend on your organisation — run **Compare methods** on your real
usernames to see them.

### Recommendation

Run them cheapest first and stop at the first match (the code-author feature
does exactly this):

1. **Local git history** — free, fast, ~99% precise; add your main repositories.
2. **GraphQL batch** with your organisation set — one request per 50 people,
   and verified-domain emails are the most reliable address GitHub has.
3. **Commit author** in named repositories — for people who hide their
   profile email; avoid org-wide commit search for large lists (30 a minute).
4. **Public profile** — last, for the few left.

Matches you tick are saved as initiator overrides (`username = email`) and used
from the next fetch. Medium-confidence matches (name-based) are left unticked.

## SLAs and escalation

Days to fix each severity (critical 7, high 30, medium 90, low 180 unless changed under **Settings → SLAs**), counted from when the finding was first detected:
- **Workbench:** **Past SLA** (red) with how many more are due within 7 days (amber); **Past SLA** and **Due ≤ 7d** columns per project, under **Columns**.
- **Escalation:** with it switched on and someone to escalate to, each scheduled run emails one list of the findings that went past their SLA since the last run (project, severity, how far past, who ran the latest scan). Each finding is escalated once, kept in the automation's state file, and forgotten when it is fixed, so a regression is escalated again. Test mode counts without sending.
- **Issues in the repository:** with **Also open an issue in the repository** on, each scheduled run opens one issue per project listing the findings that went past their SLA, each finding once (kept separately from the email escalation, and forgotten when the finding is fixed).
  - **Where:** the repository of the project's latest scan in Checkmarx One (or the project's), through the git connection that fits it: GitHub (`POST /repos/:owner/:repo/issues`) or GitLab (`POST /projects/:id/issues`, confidential). Azure DevOps and Bitbucket are skipped with the reason.
  - **Never public:** the repository's visibility is read first (`private` or `internal` only); a public repository is skipped.
  - **Safe text:** finding titles and locations are flattened, `@` cannot mention anyone, and Markdown links, HTML and pipes are neutralised. The only link is the finding's https link into Checkmarx One.
  - **Limits:** 20 projects a run (most severe first), 50 findings listed per issue. A failure (for example a token without permission to create issues) is shown in the run history and tried again next run.
- Findings triaged as not exploitable have no SLA.

## GitLab, Azure DevOps and Bitbucket

Each host gives an address a different way, so each has its own methods, run side by side
on the Beta page (**Match usernames to email addresses**, pick the host) and cheapest first
when resolving code authors. Every method reports what it found, how sure it is, and the
requests it cost.

| Host | Method | How | Cost |
|---|---|---|---|
| **GitLab** | Local git history | `git log` of named repositories: GitLab's noreply commits name the user; the same author's other commits give the real address. Also usernames matched to author names and addresses. | 0 requests |
| | GraphQL batch | `users(usernames: …)`: public email and commit email | 1 request / 100 users |
| | User profile | `GET /users?username=`: public email (every email with an admin token) | 1 request / user |
| | Commits by their name | The name from their profile, then the address on their commits in the projects you name | ~2 requests / user |
| **Azure DevOps** | Local git history | As above | 0 requests |
| | Organisation directory | Graph `/_apis/graph/users`: sign-in name, mail address and display name of everyone, matched by any of them (or a form of the name) | 1 request / ~500 users |
| | Identity search | `/_apis/identities?searchFilter=General`: works on Azure DevOps Server too | 1 request / user |
| | Commit author | Commits by that author in repositories you name | 1 request / user / repository |
| **Bitbucket Cloud** | Local git history | As above | 0 requests |
| | Commit authors | Recent commits of repositories you name: each ties the Bitbucket user (nickname, account id) to the address in its author line. Bitbucket Cloud never shows a user's email otherwise. | 1 request / 100 commits |
| | Workspace members + local history | Members give each username a display name; local history gives that name an address | 1 request / 100 members |
| **Bitbucket Data Center** | Local git history, Commit authors | As above, from its REST API | |
| | User directory | `/rest/api/1.0/users`, with each person's email | 1 request / 1000 users |
| | User search | `/rest/api/1.0/users?filter=` | 1 request / user |

**Not guessing.** A username matched by a *form* of a name (`jdoe` → Jane Doe) is medium
confidence and left unticked; a name or key shared by two different addresses is never
matched at all.

**Tokens.** Read-only is enough:
- **GitLab:** `read_api`, `read_repository`.
- **Azure DevOps:** a personal access token with Code, Graph and Identity (read), created for the organisation you connect.
  - **The organisation** can be given as its name (`acme`), `https://dev.azure.com/acme`, a project or repository page in it (`https://dev.azure.com/acme/Payments/_git/api`), or the older `https://acme.visualstudio.com`: all are stored as `https://dev.azure.com/acme`. Its token works for repositories under either address.
  - **If Test says the token was not accepted:** Azure DevOps does not reject a wrong token, it answers as *Anonymous*. The token was created for another organisation, has expired or been revoked, or was pasted with a missing character. Create one under the right organisation (User settings → Personal access tokens → *Organization*), and paste it again.
  - **A token with no organisation** is reported as such: a token is made for one organisation and does not name it.
- **Bitbucket Cloud:** an app password with your username, or a workspace or repository access token.
- **Bitbucket Data Center:** an HTTP access token.

Each token is stored like the SMTP password, never sent back to the browser, and only ever
sent to its own host. An Azure DevOps token goes only to repositories of its own organisation.
- **Changing a host's address to another host drops its saved token,** unless a new token is
  entered with it, so a token is never sent to an address someone else typed. For Azure DevOps
  it is the organisation that counts: another form of the same organisation's address keeps the
  token, another organisation drops it.
- **A token from the .env file** goes only to the host the file names (`GITHUB_API_URL`,
  `GITLAB_URL`, `AZURE_DEVOPS_ORG_URL`, `BITBUCKET_URL`), or, when it names none, to the public
  service (api.github.com, gitlab.com, dev.azure.com, Bitbucket Cloud). An address set on the
  Beta page for another host does not get it: enter a token there too.

**Tested** against API doubles of each host, which answer like the real APIs and count
requests:
- **GitLab:** 251 usernames resolved in 3 GraphQL requests; older GitLab without `commitEmail` is asked again without it.
- **Azure DevOps:** the whole organisation directory in 2 requests.
- **Bitbucket Cloud:** 2 people from one repository's commits in 2 requests.
- **Bitbucket Data Center:** the directory in 2 requests.

Run **Compare methods** on your own usernames to see each host's real hit rate.

## Settings

**Beta → GitLab, Azure DevOps and Bitbucket**:
- **GitLab:** token, address (self-managed), group, and projects for commit lookups.
- **Azure DevOps:** token, organisation address, and repositories for commit lookups (project/repository).
- **Bitbucket:**
  - Cloud or Data Center;
  - the Data Center address;
  - a username (only with an app password);
  - the token, the workspace, and repositories for commit authors.

**Test** checks each token. The .env file can set them too:
- `GITLAB_TOKEN`, `GITLAB_URL`, `GITLAB_GROUP`;
- `AZURE_DEVOPS_TOKEN`, `AZURE_DEVOPS_ORG_URL`;
- `BITBUCKET_TOKEN`, `BITBUCKET_USERNAME`, `BITBUCKET_WORKSPACE`, `BITBUCKET_URL`.

**More than one connection to a host** (a GitHub Enterprise server next to
github.com, a second GitLab, another Azure DevOps organisation): the same
variables numbered `_2` to `_9`, e.g. `GITHUB_TOKEN_2` with `GITHUB_API_URL_2`
and `GITHUB_ORG_2`. Each repository is blamed and cloned with the connection for
its host, and when two connections share a host (two github.com tokens), the one
whose organisation, group or workspace owns the repository. Each token still
only goes to the address given with it: a stored address never takes a token
from the environment, and a new address uploaded without its token drops the
stored one. Usernames are matched with the first connection of each host. The
header's **Git** indicator shows one logo per connection, green or red.

**Beta → GitHub connection**: token (stored like the SMTP password, never sent
back; `repo` read access, `read:org` for verified-domain emails), API URL
(GitHub Enterprise: `https://github.example.com/api/v3`), organisation,
repositories for commit lookups, local repositories / clone URLs (for any host),
and whether to blame through the hosts' APIs and/or local git. The token is only
ever sent to its own GitHub host.

## Fusion results

**Labs → Fusion results** shows the Risk Hub list of each project whose latest scan ran the AI engine, a Fusion scan or a LAST scan, for what its own line names, apart from the Workbench (from MZ-01.00.94). Read-only: it never starts a scan.

- **Its own line.** `POST /api/beta/fusion/fetch` with `applications` and `projects` (names or ids, comma-separated or a list, `*` and `?` as wildcards, up to 50 each): the projects of the applications named plus the projects named, every project when nothing is named; 400 when nothing matches. Kept with the session; **Read Fusion now** (`POST /api/beta/fusion/read`) reads that scope again.
- **What it reads (src/fusion-ai.js).** Each project's latest completed scan (`GET /api/scans/{id}`). It ran the AI engine when `ai` is among its engines; it was a **Fusion** scan when its own AI settings say Fusion was on (`metadata.configs` → type `ai` → `fusionEnabled`, else `scan.config.ai.fusionEnabled` in `GET /api/configuration/scan?project-id=…&scan-id=…`, else its steps: `last-worker-fusion`), a **LAST** scan when Fusion was off (LLM-based scanning alone: `last-worker`). A scan that says neither is taken as Fusion, as before. Projects whose latest scan did not run the AI engine are left out, and the page says how many. For each of the others: its Risk Hub list, with the same reader as the Workbench (`GET /api/risks/?projectId=…`, every page, every scanner), each risk with its severity, **state** (To verify, Confirmed, Proposed not exploitable, Not exploitable, Urgent; `stateChangedBy: "ai"` when AI Triage set it), where it is, its ids, `isAiGenerated`, and its **status as Risk Hub gives it** (New, Recurrent, Fixed: fixed ones count as fixed, not as open, and are never acted on); and `GET /api/sast-results?scan-id=…&is-ai-generated=1&is-ai-generated-operation=EQUAL` (500 at a time), what the AI engine found, matched to the risks by id to add their language, CWE, source and sink. Counts are kept by severity, status and state, with how many the AI engine found and how many AI Triage set.
- **Fusion and LAST (src/sast-languages.js).** A LAST scan's risks are all **LAST**'s. In a Fusion scan, a risk the AI engine found in a language the traditional SAST engine does not support (Engine Pack 9.7.7's list: primary and secondary languages, their frameworks, and their file extensions when a result names no language) is **LAST**'s (language-agnostic static testing: Solidity, Terraform…); every other risk is **Fusion**'s. Every count is kept for each apart. Two ticks, **Fusion** and **LAST**, choose what the page shows; a project shows under the tick of its scan type, or of a result of it. The figures, the projects, the side panel, both exports and the credits follow them; the choice is kept in that browser.
- **Each project's scan facts (src/fusion-usage.js).** The **model** its latest scan ran with: the scan's own `llmModel`, else the one Checkmarx One resolved for that scan (`GET /api/configuration/scan`), with where it was set (`originLevel`: Scan, Project, Tenant, or Environment: Checkmarx One's own when nobody chose one); an older Checkmarx One without that call falls back to the project's **LLM Model** setting, then the tenant's. **What the AI added**: the scan's steps (`GET /api/scans/{id}/workflow`): "Deduplicated 47 out of 273 total results" is 273 found, 47 the traditional engine had already found, 226 added; and whether Fusion credits were reserved ("Fusion credits are disabled; skipping credit reservation" when not). **Lines of code and files** and the **SAST engine version**: `GET /api/sast-metadata?scan-ids=…` and `GET /api/sast-metadata/engine-version?scan-ids=…`, 50 scans a call. **AI scans** over the period, Fusion's and LAST's apart: the tenant's completed scans since then, every project at once (`GET /api/scans?from-date=…`, 500 a page, up to 20,000), else each project's own; they also say how many of the line's projects had a Fusion scan and a LAST scan. **Credits**: `GET /api/credits/consumption?viewBy=project&period=…` (last 30, 90 or 180 days, or the last year; as CxCreditGuard reads it), each project's credits with its AI Triage and AI Remediation actions; what is left at 1 credit a triage and 3 a remediation is shown as its Fusion scans' share, an estimate the page says is one. **The tenant**: its credits left (`GET /api/credits/info`: available, total, used, actions) and its AI settings (`GET /api/configuration/tenant`: Fusion, LLM-based scanning, the model it sets and the models it offers). A part Checkmarx One does not answer (no permission, an older tenant) shows as "—", never 0. `POST /api/beta/fusion/usage` with `period` reads the scans and credits again.
- **The page.** Three blocks (the projects by scan type and the tenant's settings; what the AI added, the models and the code; the tenant's credits, what projects were given, and whether Fusion scans are charged), a line of figures (projects, results, found by AI, critical, high, medium, low, AI scans, credits spent), chips by status and by state with **Only AI-triaged**, then one row per project, gold for a Fusion scan and pink for a LAST scan (its scan type, model and where it was set, lines of code, AI found → added, results by severity, to verify, confirmed, AI scans, credits, latest scan), searchable and filtered by severity and model. A click on a project opens its vulnerabilities in a side panel, edged in its colour: its facts, then each result as Checkmarx One's results page shows it (severity, AI-found, AI-triaged, Fusion or LAST, status and state, language and what traditional SAST supports it as, CWE, source and sink with their file, line and variable, first and last found, its id), each linking to it in Risk Hub (`resultId` = its hash), filtered by severity, status and state. **Export CSV** and **HTML report** (self-contained, nothing loaded from elsewhere, in the reader's Fusion and LAST colours) for the page or for one project, narrowed as the chips are.
- **Gold and pink everywhere.** The Workbench's fetch reads each project's latest scan type too (`GET /api/scans?scan-ids=…`, 100 a call, only for scans whose engines do not already say no AI) and colours its row: gold for Fusion, pink for LAST, with a legend and a **Scan type** filter. Each look sets its own shades for light and dark (`--scan-fusion`, `--scan-last`); each person may pick their own under Settings → Your appearance (kept on their profile as `scanColours`, `#rrggbb` only).
- **Credits within the tenant's.** The credit pool cannot be raised above what the tenant has left in Checkmarx One (`GET /api/credits/info`, read with the session's connection and kept two minutes), and no allocation (the Workbench's, Credit Control's, a report's or the Fusion page's) gives projects more, together with what they hold unused, than it has left; each refusal is in the audit log.
- **Allocate, triage, remediate (Admins).** `POST /api/beta/fusion/allocate`, `…/triage` and `…/remediate` act on the loaded results of the engines ticked, in the projects the page's filters leave (`engines` and `projectIds` in the body, kept with the session; `POST /api/beta/fusion/credits` gives the lanes' figures for them). From a project's side panel, `once: true` with that project alone acts on it without changing what the page's bar acts on. No Workbench fetch is needed: the results become findings (their hash as the id) that the Workbench's allocation, AI Triage and AI Remediation code works on, with the scan each came from. Allocation reads the projects twice and counts only those results; AI Triage takes those still to verify; AI Remediation those confirmed and not yet remediated. Each needs the Beta feature, the permission it would need on the Workbench (Allocate credits, Run AI Triage) and "Set the credit pool" (Admins). Every step is in the audit log.
- **Earlier readings.** MZ-01.00.86 to 92 read Fusion's scored results from `/api/correlation` or Application Risk Management, which list every risk of an application, so the page showed far more than Fusion found; MZ-01.00.93 reads the AI-generated SAST results instead, the ones Fusion found.
- **Troubleshoot Fusion** (bottom of the page; for whoever may manage the Checkmarx One integration): a list of paths to test, one per line, suggested to start with (the `/api/correlation` paths, the old guesses, Application Risk Management, the feature flags) and editable; `{appId}` becomes an application's id. **Test these paths** calls each once with GET through the server's own connection (only paths under `/api` on that Checkmarx One, no query, at most 20) and shows its status, time and the start of the answer. A path that answers can be pinned (**Use for Fusion results**, **Use for Fusion scan status**); it is kept in the settings (`endpoints.fusionResultsPath`, `endpoints.fusionDispatcherPath`) and tried first, before `/api/correlation/…`; **Unpin** goes back.
- **Debug mode** logs every Fusion call in full while it is on: the request (method, address, headers with the access token replaced by `[hidden]`) and the answer (status, headers, the first 256 KB of the body, time). The last 100 calls are kept with the session, never on disk; **Copy the log** and **Download the log** give them as text to share.
- **Kept with the session**, like the fetch: a reload shows it again; signing out forgets it.

## FAE Flush

**Labs → FAE Flush** (from MZ-01.00.95) applies Findings Analysis (FAE) to the backlog of every project of the tenant at once, a few scans at a time, without replacing any project: each keeps its history, triage, automations and integrations. Who may: roles holding **Beta features** see it; starting, pausing, answering, undoing and deleting also need **Checkmarx One integration** (it works with the server's own key). Details for people using it are in the [user guide](user-guide.md#labs-fae-flush).

How it works, project by project (`src/fae-flush.js`), with the server's Checkmarx One connection:

| Step | Checkmarx One API |
| --- | --- |
| Check the projects | `GET /api/projects`, `GET /api/projects/last-scan`, `GET /api/scans/{id}` (SAST completed, lines of code), `HEAD /api/repostore/scans/{id}` (code kept), `GET /api/scan-summary?scan-ids=…` (results To verify) |
| 1. Copy the code | `GET /api/repostore/code/{scanId}` (a zip, streamed to a temporary file), `POST /api/uploads`, then `PUT` to the address it gives |
| 2. Scan on `<name>_FAE` | `POST /api/projects` (same groups and criticality, tag `mz-fae-flush`), `GET`/`PATCH /api/configuration/project` (the project's own `scan.config.sast.*` settings, and `scan.config.sast.findingsAnalysis` true), `POST /api/scans` (type upload, SAST only), then `GET /api/scans/{id}` until it ends |
| 3. Compare | `GET /api/sast-results?scan-id=…` of both scans; matched by similarity id. A result the FAE scan itself judged (Proposed) not exploitable counts as not reported |
| 4. Mark | `POST /api/sast-results-predicates`, 100 at a time: state `PROPOSED_NOT_EXPLOITABLE` with a comment naming the `_FAE` project and scan |
| 5. Revalidate | Both read again |
| 6. Remove | `DELETE /api/projects/{id}` (when chosen at the start, or later with **Delete all _FAE projects**) |

- **Exceptions** stop a project before it marks anything: the FAE scan failed, was canceled or ran over 12 hours; lines of code differ by more than 2%; it would mark more than 90% of 20 or more results To verify; more than 25% of the FAE scan's results are not in the project; revalidation does not match; or a call failed. The person decides: mark anyway (accept), retry or skip.
- **Kept on disk** (`fae-flush.json` in the tenant's state folder): the run carries on after a restart. Each result marked is kept, so **Undo** can put it back to To verify, only where it is still Proposed not exploitable.
- **Not yet checked on a live tenant:** the source download (`/api/repostore/code/{scanId}`) and the predicates call are the ones Checkmarx One's own pages use; the API key's role needs to create and delete projects, start scans, download source code and change result states. Whether the FAE scans use Checkmarx One credits depends on the tenant's licence.
- **Before making it final:** run it on a few of your own projects, check some of the results it marked in Checkmarx One, and that Undo puts them back.
