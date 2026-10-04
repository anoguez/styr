# Terminal UI handoff for Claude Code

## Goal

Finish the native terminal UI using the approved Claude Design artifact while preserving the
semantic terminal foundation already implemented in this worktree. This is UI integration work;
do not replace xterm.js, node-pty, or the main-process semantic runtime.

## Start here

1. Read `CLAUDE.md`, especially the terminal tabs, terminal keys, theme, and renderer-boundary
   guidance.
2. Import the design through `claude_design`:
   `https://claude.ai/design/p/0d2b88fd-cab5-49ac-ae0f-6e83e70e33ba?file=Styr+Terminal.dc.html`.
3. Focus on `Styr Terminal.dc.html` and read its imported `support.js`.
4. If the Design MCP is unavailable, ask the user to run `/design-login` or provide both files.
   Do not infer a replacement design.

Work in `/Users/andersonnoguez/Workspace/styr.worktrees/styr-TASK-0017` on
`styr/styr-TASK-0017`. Do not create another worktree.

## Completed semantic foundation

Commit `79a9ad6` introduced the architecture needed by the design:

- `src/main/terminal/terminalProtocol.ts` is a stateful parser for Styr-only OSC records. It
  removes only valid `OSC 777;STYR;... ST` metadata and leaves all normal terminal data intact.
- `src/main/terminal/terminalRuntime.ts` owns live CWD, prompt state, running/last commands,
  bounded output, exit status, and unexpected termination state in the main process.
- `src/main/terminal/shellIntegration.ts` installs zsh `preexec`, `precmd`, and `chpwd` hooks by
  using a private startup directory that sources the user’s normal zsh startup files.
- `src/main/terminal/ptyManager.ts` parses data before it reaches backlog/xterm and publishes
  semantic state separately. Raw terminal compatibility always takes priority.
- `src/core/types.ts` defines `TerminalRuntimeState` and `TerminalCommand`.
- IPC/preload expose `window.api.terminal.runtimeState(sessionId)` and
  `window.api.terminal.onRuntimeState(handler)`.
- `src/renderer/src/components/TerminalSurface.tsx` is the React boundary above `TerminalView`.
  It currently renders a deliberately minimal overlay: live CWD (clickable directory picker),
  running command, and last exit code.
- `TerminalPanel` now renders `TerminalSurface`; `TerminalView` must remain focused on xterm
  lifecycle, raw output synchronization, keyboard handling, and resize.

## UI implementation constraints

- Make `TerminalSurface` and focused composable children match the imported design. Reuse existing
  `ui.tsx` primitives and theme tokens; do not introduce literal colours or browser-incompatible
  `node:*` imports in the renderer.
- Keep the overlay container `pointer-events: none`; each actual control must opt into
  `pointer-events: auto`. Terminal input must work everywhere outside those controls.
- The displayed directory is `runtime.cwd`, not `TerminalSessionInfo.cwd` (which is only the
  initial directory). Change directories only by safely writing a quoted `cd` command to the PTY;
  wait for shell metadata to update UI state.
- Preserve multiple terminal tabs, tab hiding, output backlog synchronization, keyboard shortcuts,
  ANSI colours, alternate-screen TUIs, Claude Code, and Codex sessions.
- Do not make React parse PTY output or become authoritative for runtime state.
- Preserve the existing `children` extension point on `TerminalSurface` for future actions/menu
  controls. Do not implement command blocks or convert TUI applications into React.

## Acceptance checks

- Compare every relevant state in `Styr Terminal.dc.html`, including normal, active-command,
  successful/failed exit, long CWD/command, narrow window, and available design theme states.
- Start a shell, run `pwd`, `cd`, success and failing commands, then verify the live UI updates.
- Verify clicking CWD opens the chooser and changes directory through the shell.
- Verify normal typing and a TUI are not obstructed by overlay controls.
- Run `yarn lint`, `yarn format:check`, `yarn build`, and `yarn test` before handoff.

## Existing coverage

`terminalProtocol.test.ts`, `terminalRuntime.test.ts`, and `shellIntegration.test.ts` cover parser
framing, runtime transitions, and real-zsh OSC emission. Keep them passing and add focused UI tests
only where an existing renderer test seam supports them.
