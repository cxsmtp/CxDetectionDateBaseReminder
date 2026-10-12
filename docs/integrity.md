# Software integrity: is this the code that was released?

From MZ-01.00.72, CxMissionZero checks by itself, all the time, that the code it runs is exactly what this repository's release workflow built, and nothing else.

## How a release is signed

1. **The file list.** The image build writes `integrity.json`: the SHA-256 of every file the server runs (`src/`, `public/`, `scripts/`, `node_modules/`, `package.json`, `package-lock.json`, `LICENSE`, `TERMS.md`, `CHANGELOG.md`), with the version and the commit it was built from.
2. **The same on every platform.** The release workflow (`.github/workflows/container.yml`) reads the list from the amd64 and the arm64 image it has just published, and stops if they differ.
3. **Signed.** It then signs the list and the image with a **GitHub build attestation**. The signing certificate comes from Sigstore and names the workflow, the repository, the branch or tag and the commit. The signature is recorded in Sigstore's public transparency log, where anyone can see it and nobody can remove it. No signing key is kept anywhere that could leak.

## What the server checks

At start, every 6 hours (`INTEGRITY_CHECK_HOURS`), with **Check now**, and before an update is installed or a version is switched to:

- **Files:** every file of the running version against the list. A changed, missing or added file is found, with no network needed.
- **Who built it:** the list's attestation is fetched from `api.github.com` and checked on the server itself, with no outside library:
  - the certificate chains to Sigstore's root (`src/integrity/trusted-root.json`) and was valid when it was used;
  - it was issued to GitHub Actions for `cxsmtp/CxDetectionDateBaseReminder`'s `container.yml`, on main or a version tag;
  - the signature is good and is over this very list;
  - the transparency log recorded it, through its signed timestamp, or an inclusion proof with a signed checkpoint.

  Once confirmed for a list, the answer is kept in the data folder (`integrity-origin.json`), so a server without internet still knows after a restart.

**Settings → Update & recovery → Software integrity** shows the result:

| State | Meaning |
| --- | --- |
| **Genuine** | Every file matches, and the list is signed by the release workflow. The panel links the commit, the workflow run and the Sigstore log entry. |
| **Files changed** | Some files differ from what was built. They are listed, and the change is recorded in the audit log and the troubleshooting log. |
| **Not signed by the release workflow** | The files match their list, but no valid signature from this repository's workflow exists for it. |
| **Not confirmed yet** | The files match; GitHub could not be asked yet (`api.github.com` is unreachable). |
| **Development copy** | No file list: a copy run from source, or a version older than MZ-01.00.72. |

People who look after updates also see an alert when they sign in while the state is **Files changed** or **Not signed by the release workflow**.

## Updates

- **Installing:** from MZ-01.00.72, a version is installed only when every file matches its signed list and the signature checks out. Older versions have no list; they still install, and the audit log says so.
- **Switching:** before switching to an installed version, its files are checked again.
- **Starting:** the launcher runs the image's own version instead of an installed one whose files have changed.

A server that cannot reach `api.github.com` can install with the file check alone: start it with `INTEGRITY_OFFLINE=allow`.

## Check it yourself (Windows cmd, one line each)

The files in a running container against their list:

```
podman exec mission-zero node scripts/integrity.mjs check
```

The image's signature, with the GitHub CLI:

```
gh attestation verify oci://ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest --owner cxsmtp
```

The file list's signature: copy it out, then check it.

```
podman cp mission-zero:/app/integrity.json integrity.json
```

```
gh attestation verify integrity.json --owner cxsmtp
```

Every attestation is also listed on the repository's **Attestations** page on GitHub, and each signature can be looked up in Sigstore's log at search.sigstore.dev.

## Network

The check asks `api.github.com` over HTTPS (through the proxy when one is set). The network requirements sheet under Settings → Network & proxy lists it.
