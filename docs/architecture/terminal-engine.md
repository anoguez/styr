# Terminal engines (Styr Terminal, experimental)

Read this before touching `TerminalView`, `NativeTerminalView`, `TerminalEngineView`,
`main/terminal/native*.ts`, `terminalEngines.ts` or the release job's native step.

## The boundary

```text
TerminalPanel → TerminalSurface → TerminalEngineView ─┬─ TerminalView (xterm.js)      standard
                                                      └─ NativeTerminalView           experimental
                                                              │ IPC (frames, keys via terminal:write)
main: ptyManager (node-pty, backlog, marks) ──► NativeTerminalHost ──► @anoguez/styr-terminal
```

- **The PTY is never the engine's.** `ptyManager` owns every session, its backlog and its sequence
  numbers whichever engine shows it. Input from either view goes through `terminal:write`; resize
  goes through `terminal:resize` (the native view also resizes its engine).
- **xterm.js is the default and the recovery path.** With `experimental.nativeTerminal` off and no
  override, `TerminalEngineView` renders `TerminalView` synchronously — no IPC, no package lookup.
- **The native engine is a terminal model, not a terminal.** `@anoguez/styr-terminal` (private repo
  `anoguez/styr-terminal`: Rust core over `alacritty_terminal`, NAPI-RS bindings) parses output into
  a grid and hands back frames. It runs in the main process next to `ptyManager`, because a `.node`
  cannot load in the sandboxed renderer. Its protocol is mirrored in `core/types/terminalEngine.ts`
  (`TERMINAL_ENGINE_API_VERSION`); the package's `docs/PROTOCOL.md` is the source.
- **Selection is pure** (`core/terminalEngine.ts`): `selectTerminalEngine`, `checkNativeModule`,
  `isNativeTargetSupported`. Never branch on an engine anywhere else; ask
  `TERMINAL_ENGINE_CAPABILITIES` what the session's engine can do.

## Loading

`main/terminal/nativeEngine.ts` is electron-free and testable; `terminalEngines.ts` binds it to the
app. The package is **not in package.json**: it lives in a private registry, and yarn classic fails an
install on an unreachable optional dependency, so a public clone would break. It is looked for at:

1. `STYR_TERMINAL_PATH` — a package directory, **dev builds only** (ignored when packaged).
2. `resources/native/styr-terminal` (dev) / `<resources>/native/styr-terminal` (packaged).
3. `require('@anoguez/styr-terminal')` — a linked copy in a dev build.

Loading happens once per run and only via `terminal:engineEnvironment`, which the renderer calls
only when a view wants the native engine. `terminal:engineAvailability` (for Settings) checks the
platform and the directory without loading. Every way it can fail is a `NativeEngineStatus`:
`unsupported-platform`, `missing-package`, `incompatible-version` (wrong `API_VERSION`, wrong shape,
or `engineInfo()` disagreeing), `init-failed` (the probe engine could not be created, written, read
or freed). None of them is fatal; the app runs on xterm.js.

## Fallback without losing output

`NativeTerminalHost.attach` reads the session backlog, seeds a new engine and registers it in one
synchronous main-process turn, so live output after it is neither missed nor written twice. Any
throw from the engine afterwards (`guard`) frees it and sends `terminal:nativeFailed`; the renderer
mounts `TerminalView`, which replays the backlog and continues with live chunks newer than its
sequence (`TerminalOutputSynchronizer`), exactly as on a first mount. Nothing is buffered in the
engine path that is not already in the backlog, so a failing chunk is never dropped. The handoff is
tested end to end in `nativeHost.test.ts` ("handoff to xterm.js"). The shell keeps running throughout.

Frames carry `attachId`; a frame from a replaced engine (StrictMode, remount) is ignored. Frames are
coalesced to one per session per event-loop turn (`setImmediate`, no timers), and the engine's
replies to device queries (DSR, DA) are written back to the PTY — except replies to queries in the
backlog, which whoever showed that output first already answered.

A view's engine is chosen once, at mount. Toggling the setting affects new terminals only, since
remounting would cost the running one its scrollback.

## Untrusted output

Terminal output is untrusted. `NativeTerminalView` puts every character in as React text — never
markup — and turns nothing into a link or action. Bounds live on both sides: the engine caps a write
at 1 MiB (the host splits backlog and bursts at `WRITE_CHUNK` UTF-16 units, never inside a surrogate
pair), scrollback at `NATIVE_SCROLLBACK` lines, a frame at one viewport, and queued replies at 64 KiB.
OSC 52 clipboard reads are ignored by the engine. Bracketed paste strips an embedded end marker.

## Capabilities and known limitations (experimental level)

| Capability                                                                | xterm.js                   | Styr Terminal                                                                 |
| ------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------- |
| Command blocks                                                            | yes                        | no — blocks need buffer markers; none are reported                            |
| Clickable links                                                           | yes                        | no                                                                            |
| Mouse reporting to programs                                               | yes                        | no — reported in `modes.mouse`, not forwarded                                 |
| Select/copy beyond screen                                                 | yes                        | no — DOM selection of the visible screen; "Copy all output" copies the screen |
| Bracketed paste, file drop                                                | yes                        | yes                                                                           |
| Alternate screen (vim, TUIs)                                              | yes                        | yes — wheel sends arrow keys, as xterm.js does                                |
| IME composition                                                           | yes                        | no                                                                            |
| Hyperlinks (OSC 8), images (sixel, kitty, iTerm2), kitty keyboard, OSC 52 | partly                     | no                                                                            |
| Screen readers                                                            | xterm's accessibility tree | `role="log"` over plain text rows                                             |

Wide characters render in fixed two-cell boxes; fonts without a glyph may still look misaligned.
High-DPI follows the browser's own text rendering (no canvas).

## Compatibility checklist

Before widening availability, each of these must hold on every declared target, in both engines:
incremental UTF-8 (split multibyte, emoji), CR/LF, backspace, cursor movement, SGR colours (16, 256,
24-bit) and attributes, alternate screen in and out, resize while running a TUI, scrollback limit,
DSR/DA replies, bracketed paste, Shift+Enter (`ESC CR`), Ctrl+C / Ctrl+D / Ctrl+Z, arrow keys in
normal and application cursor mode, `vim`, `less`, `htop`, `git log`, `claude`, `codex`. The engine's
own Rust tests and corpus cover the parser side (private repo); the public tests cover selection,
loading, the host, fallback order, keys, frames and styles with the `nativeEngineFixture` fake.

## Platforms

`NATIVE_ENGINE_TARGETS` lists where it is built and verified: **darwin-arm64** only, matching the
macOS release. Everywhere else `unsupported-platform`, and the Settings switch is not offered.
Windows (x64, MSVC) and Linux (x64, glibc) are planned in the private repo and must be added here
only once their artifacts load in Styr's Electron.

## Release access

- CI (`ci.yml`) and pull requests never reference the token; they install with
  `--ignore-scripts` and test against the fixture. A fork or a public clone builds and runs the same.
- `build-macos` in `release.yml` runs in the `release` environment, which holds
  `STYR_TERMINAL_PACKAGES_TOKEN` (a fine-grained or classic token with `read:packages` only).
  Protect the environment: deployment branches `main` and `v*` tags, a required reviewer. The token
  is passed to one step, `scripts/fetch-native-terminal.mjs`, which uses it only as an
  Authorization header to the pinned registry — no `.npmrc`, no logging.
- `native-terminal.lock.json` pins the version, the npm tarball integrity and each binary's SHA-256.
  The script checks the registry record, the tarball, the unpacked package's name and version, and
  the binary before vendoring it into `resources/native/styr-terminal`. Nothing pinned, or no token,
  skips it; a mismatch fails the release. electron-builder copies the directory to
  `Contents/Resources/native` (outside the asar) and signs the `.node` with the app; the verify step
  checks that signature.
- To ship a new engine version: publish it from the private repo, then update the lock file with the
  version, its `dist.integrity` and the `SHA256SUMS` entry for each target.

## Diagnostics

`terminalEngineDiagnostics()` keeps the last 20 engine choices (session id, requested, selected,
fallback reason, a path-stripped one-line detail, engine and core version, platform/arch) in memory.
They appear in the Performance panel's report, and a fallback logs one `[terminal-engine]` warning.
No terminal contents, environment or tokens are ever recorded.

## Blocks

`core/types/blocks.ts` is the agent-native block model (`command`, `output`, `agent-message`,
`agent-tool-call`, `diff`, `approval`, `active-terminal`) with one lifecycle (`core/blocks.ts`:
`updateBlock`, `canTransition`, `orderBlocks`). It is deliberately separate from terminal emulation:
an `active-terminal` block names a session, and that session's engine draws it. Today's command
blocks over xterm.js (`ui.md`, "Terminal command blocks") are the first consumer to migrate.
