# Working on CxMissionZero

- **Version log.** Every change merged to main bumps `version` in package.json (shown as MZ-xx.xx.xx) and adds an entry to the top of CHANGELOG.md, in the same pull request:
  - heading: `## MZ-xx.xx.xx — YYYY-MM-DD HH:MM UTC · [#NN](https://github.com/cxsmtp/CxDetectionDateBaseReminder/pull/NN)`;
  - 2–8 bullets: a bold lead-in, then one plain sentence on what changed for the people using it.
  Keep package-lock.json's two version fields in step with package.json.
- **Tests:** `npm test` (node --test). Load benchmark: `loadtest/benchmark.sh` (see docs/performance.md).
- **Docs to keep in step:** README.md, docs/user-guide.md, and the docs/ page for the area changed. Podman commands are written for Windows cmd, one line each.
