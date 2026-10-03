# Working on CxMissionZero

- **Version log.** Every change merged to main bumps `version` in package.json (shown as MZ-xx.xx.xx) and adds an entry to the top of CHANGELOG.md, in the same pull request:
  - heading: `## MZ-xx.xx.xx — YYYY-MM-DD HH:MM UTC · [#NN](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/NN)`;
  - 2–8 bullets: a bold lead-in, then one plain sentence on what changed for the people using it.
  Keep package-lock.json's two version fields in step with package.json.
- **Tests:** `npm test` (node --test).
- **Benchmark every change, before and after.** Run `loadtest/benchmark.sh 3000 120` (with `SERVER_CPUS=0-1 GEN_CPUS=2-3` on a 4-CPU machine) on main before the change and on the branch after it, and add a row for the new version to the version table in docs/performance.md: failed requests, requests per second, p50 and p95 per role, and any finding sent twice. A run with failed requests or a slower tail is explained, or fixed, before merging. Mention the comparison in the pull request.
- **Docs to keep in step:** README.md, docs/user-guide.md, and the docs/ page for the area changed. Podman commands are written for Windows cmd, one line each.
