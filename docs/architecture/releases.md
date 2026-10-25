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

**What's new.** `WhatsNewDialog` shows release notes in two modes, and both render through the
dependency-free `Markdown` component (React elements only, `http(s)` links only, raw HTML as text).
After an update the notes come from the `CHANGELOG.md` bundled in the app (`files` in
`electron-builder.yml`; `app:changelog` reads it from `app.getAppPath()`), because it works offline
and matches the installed version exactly. `core/changelog.ts` parses release-please's format and
`whatsNewToShow` decides what to open; the last version seen is `localStorage`
`styr.whatsNew.seen`, a per-machine convenience that is not in `Settings`. Before installing, the
notes are the GitHub release body (`releaseNotes.ts`, a best-effort `net.fetch` once per discovered
version, 5 s timeout, any failure is silent), served by `updates:notes`, not electron-updater's
`releaseNotes`, which is HTML. Neither path touches `UpdateState`, and nothing installs without a
click on Restart. Both channels are desktop-only (`src/server/channels.test.ts`).

electron-updater defines `autoUpdater` through a getter, which Node's ESM loader cannot see as a
named export, so it is imported as the default export.

## Releases

`.github/workflows/release.yml` runs release-please on every push to `main`. It keeps a release PR
open that bumps `package.json` and writes `CHANGELOG.md` from conventional commits; merging it tags
the release as a **draft** (`draft` + `force-tag-creation` in `release-please-config.json`).
`build-macos` builds, signs, notarises, verifies and attaches its files; `build-windows` (the
unsigned NSIS installer, its blockmap and `latest.yml`) and `build-linux` (the AppImage, `.deb` and
`latest-linux.yml`) build, check their package with `scripts/verify-package.mjs` and attach theirs.
A `publish` job needs every one of them and `server-release`, and requires each to succeed: if any
platform fails, the release stays a draft — there is no publishing a release with a platform
missing. Recovery is **Run workflow** with the tag, which rebuilds every job (the server bundles
too, so every app carries the hashes of the bundles attached). A new platform job goes into
`publish`'s `needs` and `if` the same way. Never publish before the files are attached: a public
release without `latest-mac.yml`, `latest.yml` or `latest-linux.yml` is one the updater sees but
cannot install.

`build-linux` runs on `ubuntu-22.04`, not `ubuntu-latest`: node-pty and better-sqlite3 are compiled
there and need the runner's glibc or newer, and 2.35 is also Styr Terminal's linux-x64 floor.
`verify-package.mjs` fails the build if any native module needs a newer glibc (`GLIBC_FLOOR`);
moving the runner means moving that floor and the README with it. A `.deb` install updates through
electron-updater's `DebUpdater` (the `package-type` file electron-builder writes into it), so
`latest-linux.yml` must keep listing the `.deb` beside the AppImage, and the script checks it does. Commit
messages must therefore be conventional (`feat:`, `fix:`, `docs:` …) or they are left out of the
changelog. `scripts/setup-signing-secrets.sh <p12>` sets the five signing secrets on the repo from a
`.p12` exported in Keychain Access — never from `security export`, which cannot reach the
data-protection keychain where the Developer ID key lives and silently exports other identities.

### Branch protection (a repository setting, applied by the owner)

CI only protects `main` if GitHub requires it. Settings → Branches → rule for `main` (or a
ruleset): **Require status checks to pass before merging** with **Require branches to be up to
date before merging**, and these checks:

- `check` (lint, format, build, unit tests, coverage)
- `windows`
- `smoke`
- `server-bundle / build (x64, ubuntu-latest)` and `server-bundle / build (arm64, ubuntu-24.04-arm)`
  (the reusable workflow's jobs, whose names carry the matrix)

Do not require `smoke-native` (skipped on most PRs, and a skipped required check blocks merging
under some rulesets) or `osv-scanner`. A renamed job needs this list updated, or the PR waits for a
check that never reports. Merging Dependabot PRs stays manual, after these are green.

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
2. `build-macos`, `build-windows` and `build-linux` need it: after `yarn build` each writes both
   bundles' SHA-256s into its app (`scripts/server-checksums.mjs app` → `out/main/serverBundles.json`)
   before packaging, so the hash a host checks its download against ships inside the app (signed
   and notarised on macOS). Without it a remote workspace cannot set up its host from that
   platform; `verify-package.mjs` checks it is there on Windows and Linux.
3. `server-release` writes `styr-server-<version>-SHA256SUMS` and `install.sh` with the version
   filled in (`scripts/server-checksums.mjs release`), generates a build provenance attestation
   for the bundles and the script (`actions/attest-build-provenance`), and attaches all four to
   the draft release.
4. `publish` needs every platform's build and `server-release`, so a release is never public without
   the bundles, their checksums and the installer. A failed bundle build blocks the app build too,
   since the app would carry no hashes.

The release job imports the certificate into its own keychain together with Apple's Developer ID
intermediates (fingerprint-pinned), passes the Developer ID identity by name as `CSC_NAME`, and fails
at import if there is none. Each of those fixed a real failure: electron-builder's own temporary
keychain cannot set its partition list on the runners, and without a named identity it signs with
any other identity in the `.p12`, which notarisation then rejects.

Before 1.0, `feat` bumps the minor version and everything else the patch.
