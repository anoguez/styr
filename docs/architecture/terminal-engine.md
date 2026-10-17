# Terminal engines (Styr Terminal, experimental)

Read this before touching `TerminalView`, `NativeTerminalView`, `TerminalEngineView`,
`host/terminals/native*.ts`, `terminalEngines.ts` or the release job's native step.

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

`host/terminals/nativeEngine.ts` is electron-free and testable; `terminalEngines.ts` binds it to the
app. The package is **not in package.json**: it lives in a private registry, and yarn classic fails an
install on an unreachable optional dependency, so a public clone would break. It is looked for at:

1. `STYR_TERMINAL_PATH` — a package directory, **dev builds only** (ignored when packaged).
2. `resources/native/styr-terminal` (dev) / `<resources>/native/styr-terminal` (packaged).
3. `require('@anoguez/styr-terminal')` — a linked copy in a dev build.

Loading happens once per run and only via `terminal:engineEnvironment`, which the renderer calls
only when a view wants the native engine. `terminal:engineAvailability` (for Settings) checks the
platform and the directory without loading. Every way it can fail is a `NativeEngineStatus`:
`unsupported-platform`, `missing-package` (no copy found), `load-failed` (a copy was found but its
binary would not load — on Linux usually a glibc older than the build's), `incompatible-version`
(wrong `API_VERSION`, wrong shape, or `engineInfo()` disagreeing), `init-failed` (the probe engine
could not be created, written, read or freed). None of them is fatal; the app runs on xterm.js.

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

**Pacing.** The view acknowledges every frame and block event as it arrives
(`terminal:nativeReceived`, with its `attachId`). Until it does, a flush still writes the replies to
the PTY but sends nothing to draw; the next acknowledgement sends everything that changed meanwhile.
A `cat` reaches the main process in ~1 KB chunks, each its own event-loop turn, so without this the
host sent one event per chunk. Paced by the view, a burst goes out as a few large events, and a slow
view gets fewer, larger ones. No timer, and nothing is dropped: the engine holds the state, the
events only gather it. An acknowledgement for a replaced engine is ignored.

A view's engine is chosen once, at mount. Toggling the setting affects new terminals only, since
remounting would cost the running one its scrollback.

## Untrusted output

Terminal output is untrusted. `NativeTerminalView` puts every character in as React text — never
markup. Links are the one thing output can offer (`lib/nativeTerminal/links.ts`): plain `http(s)`
URLs found in the text and OSC 8 hyperlinks the engine reports on runs (`EngineRun.link`, package
0.4.0; with an older one OSC 8 text is plain). They open only on an explicit click — a press and
release on the same cell, never a drag — through `terminal:openLink`, which takes web links alone;
an OSC 8 link's address is shown on hover, since its text need not say where it goes, and any other
scheme (`file:`, `javascript:`) is plain text. Bounds live on both sides: the engine caps a write at
1 MiB (the host splits backlog and bursts at `WRITE_CHUNK` UTF-16 units, never inside a surrogate
pair), scrollback at `NATIVE_SCROLLBACK` lines, a frame at one viewport, and queued replies at 64
KiB. OSC 52 clipboard reads are ignored by the engine. Bracketed paste strips an embedded end
marker.

## The grid: pointer, selection and input

What the grid does with the pointer depends on the program (`lib/nativeTerminal/mouse.ts`):

- **Mouse reporting.** When the frame's `modes.mouse` asks for it (1000 click, 1002 drag, 1003
  motion), presses, releases, motion and the wheel are encoded as xterm does — SGR when
  `modes.sgrMouse` (1006), else the X10 form, which cannot say past column/row 223 — and written to
  the PTY like keys. The engine only reports the modes; it encodes nothing. Shift keeps the pointer
  for selecting, and ⌘-click (Ctrl elsewhere) still opens a link.
- **Selection** is the grid's own (`selection.ts`), in buffer lines rather than DOM nodes, so it
  reaches into the scrollback: dragging past the top or bottom edge scrolls the engine, double click
  takes a word and triple click a line, Shift-click extends. Copying (⌘C arrives as the menu's
  `copy` event; Ctrl+C elsewhere as a key) and the selection popover read the lines from the engine
  (`terminal:nativeStyledLines`) and cut them by cell (`cells.ts`), so wide characters keep their
  columns. A width change clears the selection, since the buffer reflows under it.
- **Input** goes through a hidden textarea at the cursor rather than the focusable `div`, so input
  methods work: the preedit is drawn at the cursor and the committed text written on
  `compositionend`; keys are not encoded while `isComposing`. Text that arrives without a key the
  grid encodes (the emoji picker, dictation) is written from the `input` event. Styr's own `❯` input
  is a textarea already; Enter while composing confirms the composition, never submits.

The block list keeps the DOM's selection: every row is on the page, as styled lines near the
viewport and as plain text elsewhere (see "Block list").

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

With Styr's shell integration (zsh, bash, fish and PowerShell 7; `ui.md`, "Shell integration"), a
native session is drawn as the terminal design's block list instead of a grid. The shell integration's `PROMPT_READY` becomes a `prompt` mark beside the
command `start`/`end` marks, and the host starts a `BlockSession` (`host/terminals/blockSession.ts`)
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
  `VIEW_FINISHED_BLOCKS`, `VIEW_FINISHED_ROWS` in the view) and a command's own engine keeps
  `BLOCK_SCROLLBACK` lines.
- Output that cannot keep up is the block list's main risk (TASK-0123: a 5 MiB `cat` took 97 s).
  Each history row is read and sent once: `markLine` with an id already in use adds a mark rather
  than moving the old one, so `newHistory` starts after the **newest** sent mark. The fake engine
  (`nativeEngineFixture.ts`) adds marks the same way, so a test catches a resend. In the view, a
  running command's history is kept in chunks (`HistoryChunk`, `HISTORY_CHUNK_ROWS`) that are frozen
  once full and drawn by a memoised component, so a frame redraws the open chunk and the live screen,
  not every row. The whole-session engine keeps parsing while the list is drawn, but its frames
  are not taken.
- Renderer memory is the other risk (TASK-0124: 3× 50 MiB took the renderer from 393 MB to 1.3 GB,
  with a JS heap of only 63 MB). The cost was the page itself: a `div` per line and a `span` per
  styled run for every kept row. A finished block's output is cut into chunks (`outputChunks`),
  each with `content-visibility: auto`. A chunk is drawn styled only while the browser says it is
  near the viewport (`contentvisibilityautostatechange`); elsewhere it is one text node
  (`chunkText`) with the same characters and height, whose layout the browser skips. Every row
  stays on the page, so the DOM selection, copy and native wrapping work as before, and a chunk
  holding the selection stays relevant. A running command's closed chunks stay styled: turning
  them into text as they streamed past slowed a 50 MiB `cat` by a third.
- The PTY gets the columns left after the list's indent (`LIST_INSET`), so output wraps where it is
  shown. A finished block is rejoined into logical lines, so text re-wraps at any later width, but
  output a program laid out in columns (`ls`, tables) keeps the width it ran at. That is
  deliberately not fixed by replaying the block's bytes at the new width: the program chose its
  columns from the width it was given, so a replay draws the same layout and only re-wraps it, which
  the logical lines already do. Only running the command again lays it out anew (Retry).

## Agent blocks

An agent CLI running in the block list (a task session, or `claude`/`codex` typed into a shell) is
drawn by Styr from its conversation instead of its TUI, as the task's block model has it: the
person's prompts, the agent's messages, each tool call with how it went, an edit's diff, an approval
while the agent waits, and Styr's `❯` input. It is provider-agnostic end to end:

- **Tool calls and diffs** read as the CLI's own view does: `⏺ Tool what it works on`, wrapped
  rather than cut (a long command folds after three lines), then `⎿` with the first lines of what it
  returned (`ToolDescription.output`, escapes stripped; an adapter leaves out what the block already
  shows, like a file read or an edit's result) and "+N lines". `editPatch` diffs each edit by line,
  so the context an agent quotes to place an edit shows unchanged, with three lines around each
  change; `editRows` (`core/diffView.ts`) draws it, and Codex's `apply_patch`, with the Changes
  pane's word emphasis. An MCP tool shows as `server · tool` with its arguments.
- `core/agentConversation.ts` is the neutral shape — `{ at, working, messages }`, each message's
  tool calls with their results — and the mapping to `StyrBlock`s. It names no provider.
- Each terminal gets `STYR_CONVERSATION_FILE` (`host/usage.ts`), watched like the context files and
  sent as `agent:conversation`. Whatever a provider's source is, it lands there in that shape. Claude
  Code's mod (`resources/claude/usage-mod`) writes it from `$.session.messages()` on session start,
  prompt submit, each tool call and turn end, and on each streamed step and permission request. Codex has no source yet, so it keeps its TUI.
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
- **Streaming.** The file's `streaming` is the reply's text so far while a turn runs, drawn as an
  `agent-message` block in state `streaming` until the CLI records the message (`agentBlocks` drops
  it once the last message starts with it). Claude's mod fills it from `turn.step` text chunks,
  main loop only, clipped like a message and written at most every `STREAM_EVERY_MS`.
- **Approvals.** The file's `approval` carries the real request — `tool`, `input` and the CLI's
  `options` (`allow` / `allow-always` / `deny` kinds; none means Allow and Deny) — and the view
  draws it with the adapter's `describeTool` (an edit's diff included). Styr answers it by option
  id over `agent:approval`: a provider with a live channel (Codex's daemon) answers through
  `publishAgentConversation`'s handler; otherwise `sendApprovalAnswer` appends
  `{"approval", "option"}` to the inbox. Claude's mod shows it from a `classic.PermissionRequest`
  hook while the TUI's dialog is up too, waits on its own `tail` of the inbox, and returns the
  dialog's decision (Yes; Yes with the request's `permission_suggestions`; No with `interrupt`).
  Whichever answers first wins: the wait ends when the tool call settles or the turn ends.
- **Images.** A plugin's prompt carries no image bytes, so an image pasted into Styr's input goes
  the keystroke way: the adapter's `pasteImageKey` (Claude's Ctrl+V) makes the TUI attach it from
  the clipboard, and the next prompt is typed into the TUI rather than sent through the inbox.
- Without a channel the view types: Escape to interrupt or deny, Enter to allow (the dialog's
  default option, so the buttons show the keys). The CLI still decides everything; "<agent> view"
  shows its own TUI for menus and dialogs, and "Styr view" returns.
- The file may carry the CLI's slash commands (`commands`; Claude's from `$.command.list()`), which
  the input offers in a menu while `/name` is typed (`commandMenu.ts`). A command may answer in the
  CLI's own interface (a picker, a dialog), so sending one shows that view, and the next change to
  the conversation brings Styr's back.
- Styr's mod is put first in `CLAUDE_CODE_PLUGIN_DIRS`: of two plugins with one name the earlier
  loads, and an inherited list may hold another Styr install's copy.

## Capabilities and known limitations (experimental level)

| Capability                                            | xterm.js                   | Styr Terminal                                                              |
| ----------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------- |
| Command blocks                                        | yes                        | yes — with a package that has command marks (0.2.0 and later)              |
| Clickable links                                       | yes                        | yes — web URLs; OSC 8 with package 0.4.0                                   |
| Mouse reporting to programs                           | yes                        | yes — SGR and X10 (to cell 223); not UTF-8 (1005) or urxvt (1015)          |
| Select/copy beyond screen                             | yes                        | yes — the grid's own selection, read from the engine's scrollback          |
| Bracketed paste, file drop                            | yes                        | yes                                                                        |
| Alternate screen (vim, TUIs)                          | yes                        | yes — without mouse reporting the wheel sends arrow keys, as xterm.js does |
| IME composition                                       | yes                        | yes — grid and Styr's input                                                |
| Hyperlinks (OSC 8)                                    | yes                        | yes — package 0.4.0; web links only                                        |
| Images (sixel, kitty, iTerm2), kitty keyboard, OSC 52 | partly                     | no                                                                         |
| Screen readers                                        | xterm's accessibility tree | `role="log"` over plain text rows                                          |

Wide characters render in fixed two-cell boxes; fonts without a glyph may still look misaligned.
High-DPI follows the browser's own text rendering (no canvas).

Command blocks and the block list need the shell integration, so `/bin/sh`, cmd and Windows
PowerShell 5.1 stay a grid. A block list's finished output re-wraps but keeps a column layout's width
(see "Block list").

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
  node_modules/.bin/electron node_modules/vitest/vitest.mjs run src/host/terminals/nativeEngine.integration.test.ts
```

For a dev run of the app with the engine: `STYR_TERMINAL_PATH=<styr-terminal>/packages/node
STYR_EXPERIMENTAL_TERMINAL=1 yarn dev`.

### Results (2026-10-13, darwin-arm64, engine 0.4.0)

The app runs used a build of the engine branch that became 0.4.0; the released 0.4.0 package
passes `nativeEngine.integration.test.ts` in Node and Electron, OSC 8 links included.

Run in a dev build of the app (Electron, isolated `HOME`/`STYR_HOME`), driven through the window:

| Check                                                                | Result                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------- |
| UTF-8 (é, emoji in two cells), SGR 256 and 24-bit colour, bold       | pass                                                       |
| CR/LF, backspace, cursor movement (`less`, `vim`)                    | pass                                                       |
| Alternate screen in and out (`less`, `vim`)                          | pass — the screen before is restored                       |
| Resize while running a TUI (`vim` follows to the new size)           | pass                                                       |
| Scrollback: wheel, selection past the screen, copy (48 lines)        | pass                                                       |
| DSR/DA replies (PSReadLine, `vim`)                                   | pass                                                       |
| Ctrl+C, Ctrl+D, Ctrl+Z (job stopped, `kill %1`)                      | pass                                                       |
| Arrow keys and application cursor mode (`vim`)                       | pass                                                       |
| Mouse: `vim mouse=a` click, drag, wheel (SGR); raw X10 and SGR bytes | pass — bytes checked exactly                               |
| Links: URL click, drag does not open, OSC 8 opens its target         | pass — `file:` OSC 8 not clickable                         |
| IME: preedit at the cursor, commit in the grid and in Styr's input   | pass — Chromium's IME emulation (CDP), not a physical IME  |
| `git log` (colour), `less`                                           | pass                                                       |
| `claude`, `codex`: TUI draws and exits                               | pass — first-run screens (no sign-in in the isolated home) |
| Block list with zsh, bash 3.2, fish 4.9, PowerShell 7                | pass                                                       |
| `htop`                                                               | not run — not installed here                               |

Bracketed paste and Shift+Enter are covered by the unit tests (`keys`, `commandInput`).

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
  the binary before vendoring it into `resources/native/styr-terminal`, dropping every other target's
  `.node` (the package's `index.js` picks the binary by platform, so the rest is dead weight).
  Nothing pinned, or no token, skips it; a mismatch fails the release. electron-builder copies the
  directory to `Contents/Resources/native` (outside the asar) and signs the `.node` with the app; the
  verify step checks that there is exactly one and that it is signed.
- To ship a new engine version: merge styr-terminal's release PR (release-please publishes it), then
  update the lock file with the version, the tarball's integrity (`sha512-` of the release's `.tgz`,
  which is what npm records) and the `SHA256SUMS` entry for each target. Run
  `nativeEngine.integration.test.ts` against the unpacked tarball, in Node and in Electron, first.

## Diagnostics

`terminalEngineDiagnostics()` keeps the last 20 engine choices (session id, requested, selected,
fallback reason, a path-stripped one-line detail, engine and core version, platform/arch) in memory.
They appear in the Performance panel's report, and a fallback logs one `[terminal-engine]` warning.
No terminal contents, environment or tokens are ever recorded.

For the engine comparison, a dev build started with `STYR_TERMINAL_BENCH=1` also logs one
`[terminal-bench]` line per shell command: how long its output took to be drawn in this engine, and
CPU and memory per process over it (`core/terminalBench.ts`; xterm.js reports from `TerminalView`,
the native host through its `drawn` port). It adds no timers and records no contents, and a
packaged app ignores it. The procedure is in `scripts/terminal-bench/README.md`.

## Blocks

`core/types/blocks.ts` is the agent-native block model (`command`, `output`, `agent-message`,
`agent-tool-call`, `diff`, `approval`, `active-terminal`) with one lifecycle (`core/blocks.ts`:
`updateBlock`, `canTransition`, `orderBlocks`). It is deliberately separate from terminal emulation:
an `active-terminal` block names a session, and that session's engine draws it. Today's command
blocks over xterm.js (`ui.md`, "Terminal command blocks") are the first consumer to migrate.
