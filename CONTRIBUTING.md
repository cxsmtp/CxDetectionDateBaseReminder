# Contributing to CxMissionZero

Improvements are welcome: bug reports, ideas, documentation and code.

## How

1. **Open an issue** describing the problem or the improvement. For a larger change, agree the approach there first.
2. **Fork, branch and change.** Keep each pull request to one purpose.
3. **Check it.**
   - `npm test` must pass, and new behaviour comes with a test.
   - For speed-related changes, run `loadtest/benchmark.sh` (see docs/performance.md).
4. **Keep the docs in step:**
   - README.md;
   - docs/user-guide.md;
   - the docs/ page for the area you changed.
5. **Record the release.**
   - Bump `version` in package.json (shown in the app as MZ-xx.xx.xx), and the two matching fields in package-lock.json.
   - Add an entry to the top of CHANGELOG.md, as described in CLAUDE.md.
6. **Open a pull request** against `main`. The container build and smoke test must pass.

## What you agree to when contributing

- **You may contribute it.** The contribution is your own work, or you otherwise have the right to submit it. It contains no one else's confidential information, keys or customer data.
- **Licence to the owner.** You grant the project owner a perpetual, worldwide, royalty-free, irrevocable licence to use, change, distribute and sublicense it, as part of CxMissionZero, under the project's licence (`LICENSE`) or any other terms the owner chooses.
- **No warranty, no obligation.** Contributions are given without warranty. They create no obligation for the owner to accept, merge or maintain them.
- **The terms still apply.** These terms (`TERMS.md`) apply to contributions as to the rest of the project: CxMissionZero is independent of Checkmarx, and neither the owner nor Checkmarx gives support or warranty.

## Security problems

Do not open a public issue for a vulnerability. Contact the owner through GitHub (https://github.com/cxsmtp) and allow reasonable time for a fix. As the terms say, there is no promise of one.
