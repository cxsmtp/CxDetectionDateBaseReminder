# Primary branches

From MZ-01.01.20, CxMissionZero names the branch each project's findings come from, lets anyone who loads findings choose another, and suggests a primary branch from what each repository's git host protects.

## Why a branch at all

A project in Checkmarx One is usually scanned on several branches: main, release branches, feature branches. Counting every branch's findings counts the same vulnerability several times and mixes work in progress into the backlog. So the Workbench reads each project on one branch: its **primary branch**, as set for the project in Checkmarx One.

Many projects have no primary branch set. Until MZ-01.01.19, CxMissionZero then took **main**, else **master**, else the branch of the project's latest scan. That is wrong for a team whose main line is **trunk** or **develop**, and the latest scan is often a feature branch's. The branch the team protects on its git host is a better guess: that is where code is reviewed before it lands.

## On the Workbench

**The Branch picker** (in the row above the projects) has three choices:

| Choice | What is loaded |
| --- | --- |
| **Each project's primary branch** (the default) | The primary branch set in Checkmarx One; with none set, the suggested protected branch (below) once the projects were read under Settings → Primary branches; else main or master; else the latest scan's branch. The button names the branches in use: *Primary branch · main, master*. |
| **One branch for every project** | One branch or pattern for every project that has a scan on it: pick one of the protected branches found across the tenant (with how many projects have each), or type a name or a pattern such as `develop` or `release/*` (`*` stands for any characters; for a pattern, the project's newest matching scan). Projects with no scan on it stay on their primary branch, and their row says *no develop scan*. |
| **Every branch** | Every branch's latest scan, as before. |

**The Branch column**, after the project's name, names the branch, marks it with a lock when its git host protects it, and says why it was used:

| Under the branch | Meaning |
| --- | --- |
| primary in Checkmarx One | The primary branch set for the project in Checkmarx One. |
| no primary set: protected branch | No primary branch set; the protected branch its git host suggests. |
| no primary set: main or master | No primary branch set and nothing suggested; main or master was scanned. |
| no primary set: latest scan | None of those scanned: the branch of its latest scan. |
| one branch for every project | The branch chosen in the picker. |
| chosen here · primary is main | A branch chosen for this project in its menu. |

Select a project's branch to open its menu: the branches its git host protects come first, in the suggested order, then the other branches Checkmarx One has scanned, each with when it was last scanned. A branch never scanned is listed but cannot be chosen. Choosing one loads the Workbench again; the other projects, read moments ago, are reused, so only that project is read from Checkmarx One. The choice is kept in this browser for later loads; **Back to its primary branch** undoes it.

What follows the branch: the totals, the projects table, reports, reminders, tracked reports saved from the load, AI credits and verification rescans. The Impact page records only findings read on a project's primary branch: a branch chosen in the table or the picker is left out of it, so trying another branch never changes what Impact counts as fixed.

## Settings → Primary branches

| Part | Who | What it does |
| --- | --- | --- |
| The page | Everyone who loads findings | Shows the order, what was read, and every project's state. |
| **Read the projects** | The Checkmarx One integration permission (Admins) | Reads every project (up to 5,000): its primary branch and its branches in Checkmarx One (`GET /api/projects/branches`), and, for a repository on a connected git host, what that host protects. Runs in the background, four projects at a time. |
| **Edit the order**, **The usual order** | Admins | The order protected branches are suggested in. |
| **Set in Checkmarx One**, **Set all N suggested** | Admins | Write a primary branch to the project in Checkmarx One, after a confirmation. |

### What each git host is asked

The tokens already set for the git hosts (Settings → Beta features: GitHub, GitLab, Azure DevOps, Bitbucket) are used, each only for its own host. A project's repository address comes from Checkmarx One.

| Host | Request | Token needs |
| --- | --- | --- |
| GitHub (and Enterprise Server) | `GET /repos/{owner}/{repo}/branches?protected=true` | Contents read (a public repository needs none, within GitHub's rate limits). |
| GitLab | `GET /projects/{path}/protected_branches` (names may be patterns: `release/*`) | `read_api`; GitLab may require the Maintainer role. |
| Azure DevOps | The repository (`_apis/git/repositories/{repo}`), then its project's branch policies (`_apis/policy/configurations`): every enabled policy on that repository, or on all of them, names a protected branch; a prefix policy is a pattern. Only repositories of the organisation the token is for. | Code read. |
| Bitbucket Cloud | `GET /repositories/{workspace}/{repo}/branch-restrictions` (branching-model rules are skipped) | Repository admin. |
| Bitbucket Data Center | `GET /rest/branch-permissions/2.0/projects/{project}/repos/{repo}/restrictions` (branch and pattern matchers) | Repository admin. |

When a host refuses or cannot find the repository, the row says so in a few words (*GitHub: not found, or the token cannot see it*) and the project's branches come from Checkmarx One only, as for a project uploaded without a repository.

### The suggestion

The order, by default: **main › master › trunk › develop · dev · development › release/\* · release · releases/\* › security · security/\* › hotfix/\* · hotfix › prod · production · stable · live**. Each entry is one or more names or patterns separated by `|` when an Admin edits it (one entry a line, up to twenty).

For each project, of its branches (scanned in Checkmarx One, and the plain names its host protects):
1. the protected branch that comes first in the order (one that matches no entry comes after those that do, by name): *Suggested: protected*;
2. with nothing protected known, main, master or trunk if it has one: *Suggested: a usual name*;
3. else nothing.

A project whose primary branch is set in Checkmarx One keeps it. When its host protects a branch that comes earlier in the order, the row says *Checkmarx One says develop; master is protected and comes first*, and the drop-down offers it; nothing changes until an Admin writes it.

### Writing to Checkmarx One

**Set in Checkmarx One** reads the project (`GET /api/projects/{id}`) and writes it back with the new primary branch (`PUT /api/projects/{id}`, its name, groups, repository, origin, tags and criticality as they were). A pattern is never written. Every write, done or refused, is in the audit log (*Primary branch set in Checkmarx One: none → main*). Writing a primary branch changes what every tool that uses Checkmarx One's primary branch sees, which is the point: one primary branch for everyone.

## Where it is kept

`branch-settings.json` in the data folder (per tenant), and in every backup: the order and the last read. The branches chosen on the Workbench stay in each person's browser (`mz-branch-for`).

## Limits

- Credit Control's **Allocate and use credits** and Settings → Automation still read each project's primary branch (or every branch): the Workbench's one-branch and per-project choices apply to the Workbench's load.
- A project with no primary branch is read on its suggested branch only after **Read the projects**; the suggestions follow later protection changes on the next read.
- The git hosts' requests were tested against a test double of each API, and GitHub's against a stand-in on CxMissionZero's mock Checkmarx One; not against live hosts.
