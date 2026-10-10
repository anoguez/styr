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

## Command blocks

The native engine draws the same blocks as xterm.js (`ui.md`, "Terminal command blocks"): the
surface's `TerminalBlocks` overlay, fed the same `BlockLayout`. Only where the lines come from differs.

- `NativeTerminalHost` writes each chunk in pieces split at its `TerminalMark`s, as `writeOutput`
  does for xterm.js, so the engine's cursor is where the shell was. A `start` mark calls
  `markLine(id, -1)` (the command's own row); an `end` mark records the block's span from that row to
  the cursor (plus its row when the output had no final newline).
- The engine tags the row inside its grid, so the mark follows the row through scrolling, reflow and
  trimming and disappears with it. The tag carries a per-engine nonce: output cannot forge or move
  one. A command whose mark is gone is forgotten, which bounds the host's map by the buffer.
- Blocks travel with frames (`NativeFrameEvent.blocks`, sent only when they change) and with the
  attach reply, computed from the backlog's marks, so a remount rebuilds them. `BlockFeed` resolves
  an event overtaking the reply; `nativeBlockLayout` numbers the viewport as xterm.js does
  (`viewportY = historySize - displayOffset`).
- `TerminalHandle.text`/`lines` return a promise for the native engine (its buffer is in the main
  process), so copy and Ask agent read the whole scrollback rather than the visible screen.
- A finished block's span is fixed when it ends, so a resize that reflows its output can move its
  end by the rows the reflow added or removed; its start stays exact.

## Block list (Warp-style)

With zsh and Styr's shell integration, a native session is drawn as the terminal design's block
list instead of a grid. The shell integration's `PROMPT_READY` becomes a `prompt` mark beside the
command `start`/`end` marks, and the host starts a `BlockSession` (`main/terminal/blockSession.ts`)
at a session's first prompt mark; a shell that sends none stays a grid.

- Each segment — the prompt, then each command — is written into its own fresh engine. A finished
  command is frozen into styled rows (`styledLines`, package 0.3.0) that the renderer rejoins into
  logical lines, so the page wraps and scrolls them natively. The running command streams rows that
  scrolled off its screen (`history`, tracked with a mark so trimming cannot resend or skip rows) and
  its live screen (`frame`). A full-screen program takes over the panel as a grid.
- The shell's prompt is parsed (modes, cursor queries) but never shown: blocks start with the
  design's `❯ command` row, and the input is Styr's own (`commandInput.ts`): Enter runs, Shift+Enter
  adds a line (several lines go as one bracketed paste), Up/Down step through the list's commands,
  Ctrl+C discards, Ctrl+L and `clear` empty the list. zsh's completion and autosuggestions do not
  see the line until it is submitted.
- Finished blocks are capped (`MAX_FINISHED_BLOCKS`, `MAX_FINISHED_ROWS` in the main process,
  `VIEW_FINISHED_BLOCKS` in the view) and a command's own engine keeps `BLOCK_SCROLLBACK` lines.
- The PTY gets the columns left after the list's indent (`LIST_INSET`), so output wraps where it is
  shown. Output a program laid out in columns keeps the width it ran at.

## Agent blocks

An agent CLI running in the block list (a task session, or `claude`/`codex` typed into a shell) is
drawn by Styr from its conversation instead of its TUI, as the task's block model has it: the
person's prompts, the agent's messages, each tool call with how it went, an edit's diff, an approval
while the agent waits, and Styr's `❯` input. It is provider-agnostic end to end:

- `core/agentConversation.ts` is the neutral shape — `{ at, working, messages }`, each message's
  tool calls with their results — and the mapping to `StyrBlock`s. It names no provider.
- Each terminal gets `STYR_CONVERSATION_FILE` (`main/usage.ts`), watched like the context files and
  sent as `agent:conversation`. Whatever a provider's source is, it lands there in that shape. Claude
  Code's mod (`resources/claude/usage-mod`) writes it from `$.session.messages()` on session start,
  prompt submit, each tool call and turn end. Codex has no source yet, so it keeps its TUI.
- What differs per CLI when drawing — its tool names, the notes it wraps a prompt in — is a
  `ConversationAdapter` in `core/providers/conversation.ts` (Claude's in `claudeConversation.ts`),
  keyed by provider id like `AGENT_PROVIDER_LABELS`. Which CLI a command starts comes from
  `agentProgramProvider` (`AGENT_PROVIDER_PROGRAMS`), or the task session's provider.
- Prompts go through the agent's own channel when it has one: each terminal gets
  `STYR_PROMPT_INBOX`, Styr appends `{"text"}` lines to it (`agent:prompt`), and Claude Code's mod
  reads it (`tail -F`) and submits each with `$.prompt.submit({ asUser: true })`, so it is the
  person's own words — typed into the TUI, a prompt of several lines is filed as pasted content.
  The conversation's `promptInbox` says the inbox is read. `promptRoute` keeps keystrokes for no
  inbox, a `/command` (it may open the CLI's picker) and a one-line `@path` mention (only the TUI
  expands those). Typed prompts go as one bracketed paste and Enter as its own keystroke after
  `AGENT_ENTER_DELAY_MS`: written together, an agent's input takes the Enter as part of a paste.
- Everything else the view sends goes to the CLI's PTY as if typed: Escape to interrupt or deny,
  Enter to allow. The CLI still decides
  everything; "<agent> view" shows its own TUI for menus and dialogs, and "Styr view" returns.
- The file may carry the CLI's slash commands (`commands`; Claude's from `$.command.list()`), which
  the input offers in a menu while `/name` is typed (`commandMenu.ts`). A command may answer in the
  CLI's own interface (a picker, a dialog), so sending one shows that view, and the next change to
  the conversation brings Styr's back.
- Styr's mod is put first in `CLAUDE_CODE_PLUGIN_DIRS`: of two plugins with one name the earlier
  loads, and an inherited list may hold another Styr install's copy.

## Capabilities and known limitations (experimental level)

| Capability                                                                | xterm.js                   | Styr Terminal                                                                  |
| ------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------ |
| Command blocks                                                            | yes                        | yes — with a package that has command marks (0.2.0 and later)                  |
| Clickable links                                                           | yes                        | no                                                                             |
| Mouse reporting to programs                                               | yes                        | no — reported in `modes.mouse`, not forwarded                                  |
| Select/copy beyond screen                                                 | yes                        | partly — DOM selection is the visible screen; copy actions read the scrollback |
| Bracketed paste, file drop                                                | yes                        | yes                                                                            |
| Alternate screen (vim, TUIs)                                              | yes                        | yes — wheel sends arrow keys, as xterm.js does                                 |
| IME composition                                                           | yes                        | no                                                                             |
| Hyperlinks (OSC 8), images (sixel, kitty, iTerm2), kitty keyboard, OSC 52 | partly                     | no                                                                             |
| Screen readers                                                            | xterm's accessibility tree | `role="log"` over plain text rows                                              |

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

`nativeEngine.integration.test.ts` runs the real loader and host against a real build of the
package. It is skipped unless `STYR_TERMINAL_PATH` names the package directory, so public CI never
needs it. To check the binary in Styr's own Electron runtime:

```sh
ELECTRON_RUN_AS_NODE=1 STYR_TERMINAL_PATH=<styr-terminal>/packages/node \
  node_modules/.bin/electron node_modules/vitest/vitest.mjs run src/main/terminal/nativeEngine.integration.test.ts
```

For a dev run of the app with the engine: `STYR_TERMINAL_PATH=<styr-terminal>/packages/node
STYR_EXPERIMENTAL_TERMINAL=1 yarn dev`.

## Platforms

`NATIVE_ENGINE_TARGETS` lists where it is built and verified: **darwin-arm64** only, matching the
macOS release. Everywhere else `unsupported-platform`, and the Settings switch is not offered.
Windows (x64, MSVC) and Linux (x64, glibc) are planned in the private repo and must be added here
only once their artifacts load in Styr's Electron.

## Release access

- CI (`ci.yml`) and pull requests never reference the token; they install with
  `--ignore-scripts` and test against the fixture. A fork or a public clone builds and runs the same.
- `build-macos` in `release.yml` runs in the `release` environment, which holds
  `STYR_TERMINAL_PACKAGES_TOKEN`: a classic personal access token with the `read:packages` scope
  alone (GitHub Packages' npm registry does not take fine-grained tokens).
  Protect the environment: deployment branches `main` and `v*` tags, a required reviewer. The token
  is passed to one step, `scripts/fetch-native-terminal.mjs`, which uses it only as an
  Authorization header to the pinned registry — no `.npmrc`, no logging.
- `native-terminal.lock.json` pins the version, the npm tarball integrity and each binary's SHA-256.
  The script checks the registry record, the tarball, the unpacked package's name and version, and
  the binary before vendoring it into `resources/native/styr-terminal`. Nothing pinned, or no token,
  skips it; a mismatch fails the release. electron-builder copies the directory to
  `Contents/Resources/native` (outside the asar) and signs the `.node` with the app; the verify step
  checks that signature.
- To ship a new engine version: merge styr-terminal's release PR (release-please publishes it), then
  update the lock file with the version, the tarball's integrity (`sha512-` of the release's `.tgz`,
  which is what npm records) and the `SHA256SUMS` entry for each target. Run
  `nativeEngine.integration.test.ts` against the unpacked tarball, in Node and in Electron, first.

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
