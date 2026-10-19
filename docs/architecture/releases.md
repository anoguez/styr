# Updates and releases

Moved from CLAUDE.md verbatim; read it before touching this area.

## Updates

`src/main/updater.ts` wraps electron-updater against this repo's GitHub Releases and mirrors its
`UpdateState` to the renderer (`updates:*` IPC, `useUpdates`). It downloads automatically but never
installs on its own: `autoInstallOnAppQuit` applies it at the next quit, and `updates:install`
relaunches only after asking whenever a terminal is open, because a relaunch kills every agent
running in the app. Keep it that way — an app that restarts itself mid-turn loses work.

A dev build reports `unsupported` and never checks. A release without `latest-mac.yml` (published
by hand, or older than the updater) is reported as current, not as an error.

electron-updater defines `autoUpdater` through a getter, which Node's ESM loader cannot see as a
named export, so it is imported as the default export.

## Releases

`.github/workflows/release.yml` runs release-please on every push to `main`. It keeps a release PR
open that bumps `package.json` and writes `CHANGELOG.md` from conventional commits; merging it tags
the release as a **draft** (`draft` + `force-tag-creation` in `release-please-config.json`). A
macOS job builds, signs, notarises, verifies and attaches its files; a `publish` job that needs it
then publishes it. A Windows job (the unsigned NSIS installer and `latest.yml`) and a Linux job
(the AppImage, `.deb` and `latest-linux.yml`) are written but commented out until those builds
have been tested; re-enabling one means adding it back to `publish`'s `needs` and `if`. Never publish before the files are attached: a public release without
`latest-mac.yml` or `latest.yml` is one the updater sees but cannot install. Commit
messages must therefore be conventional (`feat:`, `fix:`, `docs:` …) or they are left out of the
changelog. `scripts/setup-signing-secrets.sh <p12>` sets the five signing secrets on the repo from a
`.p12` exported in Keychain Access — never from `security export`, which cannot reach the
data-protection keychain where the Developer ID key lives and silently exports other identities.

### Server bundles

Remote workspaces' server (`remote.md`, Server bundles) ships with every release, before the
release is published:

1. `build-server` calls `.github/workflows/server-bundle.yml` (a matrix: `x64` on
   `ubuntu-latest`, `arm64` on `ubuntu-24.04-arm`, both inside `node:24-bookworm`, so the bundles
   need glibc 2.36: Ubuntu 22.04+, Debian 12+, RHEL 9+, Amazon Linux 2023). It installs without
   scripts, runs `yarn build:server` and `scripts/server-bundle.mjs` with its self-check, and keeps
   `styr-server-<version>-linux-<arch>.tar.gz` as a workflow artifact. CI's `server-bundle` job
   runs the same workflow on every PR, so a bundle that does not build or run fails the PR, not the
   release. A different container means a different floor: change `GLIBC_FLOOR` in `install.sh`
   with it (`remote.md`, Server bundles).
2. `build-macos` needs it: after `yarn build` it writes both bundles' SHA-256s into the app
   (`scripts/server-checksums.mjs app` → `out/main/serverBundles.json`) before signing, so the
   hash a host checks its download against ships inside the signed, notarised app.
3. `server-release` writes `styr-server-<version>-SHA256SUMS` and `install.sh` with the version
   filled in (`scripts/server-checksums.mjs release`), generates a build provenance attestation
   for the bundles and the script (`actions/attest-build-provenance`), and attaches all four to
   the draft release.
4. `publish` needs both `build-macos` and `server-release`, so a release is never public without
   the bundles, their checksums and the installer. A failed bundle build blocks the app build too,
   since the app would carry no hashes.

The release job imports the certificate into its own keychain together with Apple's Developer ID
intermediates (fingerprint-pinned), passes the Developer ID identity by name as `CSC_NAME`, and fails
at import if there is none. Each of those fixed a real failure: electron-builder's own temporary
keychain cannot set its partition list on the runners, and without a named identity it signs with
any other identity in the `.p12`, which notarisation then rejects.

Before 1.0, `feat` bumps the minor version and everything else the patch.
