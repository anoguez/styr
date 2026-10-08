# Building and packaging

## Scripts

| Script                              | What it does                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| `yarn dev`                          | Run the app with hot reload — the header shows an amber `DEV` badge                               |
| `yarn build`                        | Typecheck both projects, build `out/`, and fail if renderer code pulls in a Node builtin          |
| `yarn start`                        | Run the built app                                                                                 |
| `yarn mcp`                          | Run the MCP server on stdio (for debugging)                                                       |
| `yarn lint`                         | ESLint                                                                                            |
| `yarn format` / `yarn format:check` | Prettier: rewrite, or only report                                                                 |
| `yarn package`                      | Build a signed macOS `.app` and `.dmg` into `dist/`, notarised if the `APPLE_*` variables are set |
| `yarn package:adhoc`                | The same with an ad-hoc signature, for building without a Developer ID                            |
| `yarn package:win`                  | Build the Windows installer (`dist/Styr-Setup-<version>.exe`), unsigned                           |
| `yarn package:linux`                | Build the Linux `.deb` and AppImage (x64); run it on Linux or inside WSL2                         |
| `yarn icon`                         | Regenerate `resources/icon.png` (any OS) and `icon.icns` + the tray icon (macOS) from the SVGs    |

`yarn lint`, `yarn format:check` and `yarn build` are the checks; CI runs them on every pull request,
and a pre-commit hook runs ESLint and Prettier on staged files plus the typecheck. There is no test
suite yet.

After changing dependencies, run `yarn postinstall` to rebuild the native modules (`node-pty`,
`better-sqlite3`) against Electron. On Windows it skips the rebuild: both modules ship N-API
prebuilds for win32, which Electron loads as they are, so no Windows SDK is needed. (`yarn install`
may still try to compile `better-sqlite3` on its own and fail without the SDK; use
`yarn install --ignore-scripts`, then `node node_modules/electron/install.js` and
`node node_modules/node-pty/scripts/post-install.js`.)

## Installing it as a Mac app

```sh
yarn package
```

That produces `dist/mac-arm64/Styr.app` and `dist/Styr-<version>-arm64.dmg`.
Drag the app into Applications, or:

```sh
cp -R "dist/mac-arm64/Styr.app" /Applications/
```

## Installing it on Windows

```sh
yarn package:win
```

That produces `dist/Styr-Setup-<version>.exe`, a per-user installer (no administrator rights), and
`dist/win-unpacked/Styr.exe` to run without installing. The installer is unsigned, so SmartScreen
shows **Windows protected your PC** on first run: **More info → Run anyway**.

On Windows agents launch from **Git Bash** or **PowerShell 7** (`pwsh`); pick either under Settings
→ Preferences → Shell. With none set, Styr uses Git Bash (found through `CLAUDE_CODE_GIT_BASH_PATH`,
the standard install folders, or the `git.exe` on `PATH`), else PowerShell 7, else Windows
PowerShell. Windows PowerShell 5.1 and Command Prompt open as terminals, but agents cannot launch
from them: 5.1 splits arguments that contain quotes when it passes them to a program, which breaks
the prompt. Install PowerShell 7 with `winget install Microsoft.PowerShell`. Claude Code itself still
uses Git Bash for its hooks and its own commands. `mod` in shortcuts is Ctrl; inside the terminal, Ctrl+letter goes to the
shell and Ctrl+Shift+letter reaches the command bound to Ctrl+letter.

## Installing it on Linux, or in WSL2

Build on Linux itself (a WSL2 distro counts): node-pty has no Linux prebuild, so `yarn install`
compiles it against Electron. On Ubuntu (24.04 shown) that needs a compiler, and Electron needs a few
libraries a WSL2 distro often lacks:

```sh
sudo apt update && sudo apt install -y build-essential libnss3 libasound2t64 libxss1 libfuse2t64
```

Then, in a clone inside the Linux filesystem (not under `/mnt/c`, which is much slower):

```sh
yarn install && yarn package:linux
```

That produces `dist/Styr-<version>-amd64.deb` (`sudo apt install ./dist/Styr-*.deb`, then run
`styr`) and `dist/Styr-<version>-x86_64.AppImage`, which updates itself and needs FUSE 2
(`libfuse2t64`). Under WSL2, Windows 11 shows the window through WSLg, and the app, its git, the
repositories and the agents all live in Linux, so nothing crosses into Windows. The shell defaults to
`$SHELL`, else bash. `mod` in shortcuts is Ctrl, with the same terminal rules as on Windows.

## Signing and notarisation

`yarn package` signs with the _Developer ID Application_ certificate in your keychain. To notarise a
local build as well, copy `.env.example` to `.env` and fill in `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`; `yarn package` loads it. Without them
electron-builder skips notarisation with a warning. If you set `CSC_NAME`, leave out the
`Developer ID Application:` prefix, or electron-builder refuses it. Check a build with:

```sh
codesign --verify --deep --strict --verbose=2 "dist/mac-arm64/Styr.app"
spctl --assess --type execute --verbose "dist/mac-arm64/Styr.app"
```

Without a Developer ID, `yarn package:adhoc` signs ad-hoc. That app runs on the machine that built
it; on any other Mac Gatekeeper blocks it once (right-click → **Open**, or
`xattr -dr com.apple.quarantine /Applications/Styr.app`).

## Releases

Releases are cut by [release-please](https://github.com/googleapis/release-please) from
conventional commits:

1. Every push to `main` updates a release PR that bumps the version and writes `CHANGELOG.md`.
   `feat:` commits bump the minor version (before 1.0), everything else the patch.
2. Merging the release PR tags `vX.Y.Z` and creates the GitHub release **as a draft**, invisible
   to visitors and to the updater.
3. A macOS runner builds, signs, notarises and verifies the app, and a Windows runner builds the
   installer; each attaches its files to the draft. A final job publishes it once both succeeded.
   A release only goes public once it is complete; if a build fails, the draft stays unpublished
   and can be rebuilt with **Run workflow** and its tag.

Each release carries the DMG for people installing by hand, plus `Styr-x.y.z-arm64-mac.zip`, its
`.blockmap` and `latest-mac.yml`: the update feed installed copies read through electron-updater.
For Windows it carries `Styr-Setup-x.y.z.exe`, its `.blockmap` and `latest.yml`.
The feed location comes from the `publish` block in `electron-builder.yml`. Because releases are
published only after those files are attached, an installed copy never sees a release without them;
if one ever lacks `latest-mac.yml` anyway (a release edited by hand), the app reports "up to date"
rather than an error.

The workflow needs these repository secrets. First export the certificate from **Keychain Access →
My Certificates → Developer ID Application: … → Export…** as a `.p12` with a password, then run:

```sh
scripts/setup-signing-secrets.sh path/to/certificate.p12
```

It reads `.env`, checks the `.p12` really holds a Developer ID Application identity for your team,
and sets all five secrets with `gh`, prompting for anything `.env` does not have. The export has to
be done in Keychain Access: on current macOS the Developer ID key usually lives in the
data-protection keychain, which `security export` cannot reach — a scripted export silently leaves
it out, and CI then signs with the wrong identity.

| Secret                        | What it is                                              |
| ----------------------------- | ------------------------------------------------------- |
| `CSC_LINK`                    | The Developer ID certificate and key as a base64 `.p12` |
| `CSC_KEY_PASSWORD`            | The password protecting that `.p12`                     |
| `APPLE_ID`                    | The Apple ID used to notarise                           |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password for that Apple ID              |
| `APPLE_TEAM_ID`               | The developer team id                                   |

Optionally add `RELEASE_PLEASE_TOKEN`, a fine-grained token with contents and pull-request write
access. A release PR opened with the default token does not trigger other workflows, so CI would not
run on it.

**Re-register the MCP server after packaging.** Use the command Settings shows verbatim, quotes
included. The packaged app runs the MCP server from inside the
bundle, so its path differs from the dev one. Open Settings in the packaged app, copy the command it
shows, and run it — otherwise Claude keeps pointing at `out/` in this repo, which breaks if you move
or clean the checkout.

## The app icon

`resources/icon.svg` is the source; `resources/icon.icns` is generated from it:

```sh
yarn icon
```

That rasterises the SVG at 1024px, produces all ten `.iconset` renditions and runs `iconutil`.
Edit the SVG, re-run it, then `yarn package`. macOS only, and it uses Google Chrome to rasterise.

## Extension points

`externalRef` (`{ provider, id, url }`) is carried through the schema, frontmatter, index and MCP
payloads but nothing writes it yet — it is the hook for syncing tasks from Zendesk, Jira or another
MCP source later.
