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

`RELEASE_PLEASE_TOKEN` is a required fine-grained personal access token with Contents and Pull
requests read/write permissions. It must not fall back to `GITHUB_TOKEN`: GitHub suppresses CI
events created by the default workflow token. The workflow validates the secret before invoking
release-please so a missing token is a visible release-workflow failure, not an unchecked release PR.

The release job imports the certificate into its own keychain together with Apple's Developer ID
intermediates (fingerprint-pinned), passes the Developer ID identity by name as `CSC_NAME`, and fails
at import if there is none. Each of those fixed a real failure: electron-builder's own temporary
keychain cannot set its partition list on the runners, and without a named identity it signs with
any other identity in the `.p12`, which notarisation then rejects.

Before 1.0, `feat` bumps the minor version and everything else the patch.
