# cloc-fusion's engine, vendored

The Cx Credits Calculator's **Fusion — new customer** tab measures a customer's repositories with this engine
(through `src/fusion-git.js`): discovery across connections and organizations, line counting the way cloc counts,
commits on the default branch, change frequency and contributing developers.

| | |
|---|---|
| Source | cloc-fusion (github.com/cxsmtp/cloc-fusion) |
| Version | 1.3.2 |
| Commit | `1a320621d0f5eed271ea973a670930c8cdf1ec01` |
| Licence | MIT ([LICENSE](LICENSE)) |
| `cloc-fusion.html` | 188,061 bytes, SHA-256 `edc89d4cc33f953f24dc28ee6666c7cda6787e36456e2307c4ed9717d5ad74ab` |

What is here, unchanged except for a one-line header naming its origin: `http.js`, `pool.js`, `discover.js`, `languages.js`, `loc.js`, `commits.js`, `fusion.js`, `archive.js`, `tar.js`, `apiengine.js`, `git.js`, `providers/index.js`, `providers/github.js`, `providers/gitlab.js`, `providers/azure.js`, `providers/bitbucket.js`, `providers/bitbucket-server.js`, `providers/generic.js`.
Not here: cloc-fusion's command line, setup wizard, web app, updater, AI plan, report writers and sign-in helpers.

CxMissionZero keeps its own hardening around the engine (`src/fusion-git.js`): clone and API hosts on the allowed
list only, names that resolve to link-local or metadata addresses refused and git and the API client held to the
addresses checked, tokens redacted from every message, counts seen only by whoever started them, and temporary
folders swept after a crash.

`cloc-fusion.html` is cloc-fusion's one-file page, handed out by the tab's **Download cloc-fusion** button: the
server checks its SHA-256 against `origin.js` before serving it, as a download only.

Copy a newer version in with `node scripts/sync-cloc-fusion.mjs /path/to/cloc-fusion`, then run `npm test`.
