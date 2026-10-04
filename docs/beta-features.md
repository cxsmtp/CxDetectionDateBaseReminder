# Beta features

**Beta or final.** Each feature starts in Beta, for roles holding "Beta features". An Admin makes it final under **Settings → Beta features** (permission "Make Beta features final"), and can put it back:
- **Code authors, once final:** anyone who may send reminders can use it, and scheduled reminders (Settings → Automation → *Also email the code authors*) email the developer who last changed the line of each finding that just crossed a threshold, up to 200 findings a run.
- **Matching usernames, once final:** anyone who may change initiator addresses can run and apply it.
- **SLAs and escalation, once final:** everyone who loads findings sees what is past its SLA and due soon. Escalation stays as set under **Settings → SLAs**: off until an Admin names who to escalate to.

Every change of stage is in the audit log.

Both features live on the **Beta** tab. They read git history and, optionally,
the APIs of GitHub, GitLab, Azure DevOps and Bitbucket; check what they find before
relying on it.

## Email the authors of vulnerable code

For each finding in the current Dashboard scope (severities and a maximum you choose):

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

Each author gets one email listing the findings on lines they last changed,
with links to the finding in Checkmarx One and to their commit. Preview first.

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
- **Dashboard:** **Past SLA** (red) with how many more are due within 7 days (amber), and a **Past SLA** column per project (**Due ≤ 7d** under **Columns**).
- **Escalation:** with it switched on and someone to escalate to, each scheduled run emails one list of the findings that went past their SLA since the last run (project, severity, how far past, who ran the latest scan). Each finding is escalated once, kept in the automation's state file, and forgotten when it is fixed, so a regression is escalated again. Test mode counts without sending.
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
- **Azure DevOps:** a personal access token with Code, Graph and Identity (read).
- **Bitbucket Cloud:** an app password with your username, or a workspace or repository access token.
- **Bitbucket Data Center:** an HTTP access token.

Each token is stored like the SMTP password, never sent back to the browser, and only ever
sent to its own host. An Azure DevOps token goes only to repositories of its own organisation.
- **Changing a host's address to another host drops its saved token,** unless a new token is
  entered with it, so a token is never sent to an address someone else typed.
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
