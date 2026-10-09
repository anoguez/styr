# Styr — working notes

Electron + React kanban board. See README.md for what it does and how to run it.

## Architecture rules

- `src/core/` is the shared, Electron-free layer: types, zod schemas, config, markdown
  serialisation, the filesystem task store and the prompt builder. Both the main process and the MCP
  server import it. **Never import `electron` from `src/core/`** — it would break the MCP server.
- Markdown files under `<workspace folder>/tasks/` are the only source of truth. All writes go through
  `src/core/taskStore.ts`.
- `src/main/taskIndex.ts` is a derived SQLite cache, written only by the main process. It must stay
  reconstructible from the markdown alone — never store anything there that is not in a file. When
  you change its columns, bump `SCHEMA_VERSION`; the index drops and rebuilds itself from the task
  files, so no migration code is needed.
- The main process serves renderer reads from the index (`queryTasks`, `findTask`) and routes writes
  through `taskStore`, then calls `notifyTasksChanged()` to re-index and broadcast.
- External writes (the MCP server, an editor, a `git pull`) are picked up by the chokidar watcher in
  `src/main/watcher.ts`, which runs the same `notifyTasksChanged()`.

## Where the detail lives

This file holds only the rules that apply everywhere plus the traps most likely to bite. Per-area
notes are in `docs/architecture/` — read the one for the area you are changing before editing it.

| Area                                                                                                     | File                                   |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Workspaces, per-workspace settings, `pinWorkspace`, settings store                                       | `docs/architecture/workspaces.md`      |
| Git worktrees, base branch, landing                                                                      | `docs/architecture/worktrees.md`       |
| Agent providers, Codex, launch, agent state, Orchestrate, Auto-run, prompt routing, "Done means landed"  | `docs/architecture/agents.md`          |
| Menu bar, board, Settings dialog, terminal tabs/blocks/keys, theme, shortcuts, palette, inbox, title bar | `docs/architecture/ui.md`              |
| Task dependencies, hand-edited files, Ask agent, presets, done cap/archive, diagnostics                  | `docs/architecture/tasks.md`           |
| External sources (GitHub Issues, experimental)                                                           | `docs/architecture/sources.md`         |
| Updater and release pipeline                                                                             | `docs/architecture/releases.md`        |
| Terminal engines: xterm.js and experimental Styr Terminal, fallback, native package, release access      | `docs/architecture/terminal-engine.md` |

Keep this file under 300 lines. A new subsystem note goes in the matching file above, not here;
add a line here only for a rule that must hold in every change.

## Rules that hold everywhere

- **Workspaces vs `storageDir`.** A workspace is an isolated board; `Settings.storageDir` is the
  folder holding them. Build paths only with `workspaceDir(settings, id?)` / `pathsInWorkspace`.
  Anything finding "the session of task X" must match workspace _and_ task id (`TASK-0001` exists in
  every workspace). Never read `STYR_WORKSPACE_ID` in the main process, and never leave
  `pinWorkspace` set across an `await`.
- **Settings keys.** Every key is in exactly one of `GLOBAL_SETTING_KEYS` or `WORKSPACE_SETTING_KEYS`
  (`types/settings.ts`); a test enforces it. `loadSettings` results are deep-frozen and cached —
  spread before changing. `pathsInWorkspace` is paths only; use `loadSettings(id)` for behaviour.
- **Worktrees.** Pass a `Checkout` (`{repoPath, key, baseBranch?}`), not loose values; key it with
  `worktreeKey`. Worktree failure is never fatal (fall back to the repo with a warning).
  `prompt.ts` is imported by the renderer, so it must not import `worktree.ts` or any `node:*`.
- **Shells.** Differences between shells live behind `TerminalShell` (`resolveShell`, node side) and
  `ShellSyntax` (`syntaxFor`, pure): how to start one, run a line in it, and quote, `cd`, call a
  command or pass a file in its dialect. Never branch on a shell's name elsewhere, and never type a
  literal quote or `$(…)` into a terminal — ask the shell's syntax. Sessions carry their `dialect`.
- **Providers.** Differences between agent CLIs live behind `AgentProvider`; never branch on the
  provider outside `providerFor`. Status records are provider-neutral, with `event` from `EVENT_STATE`.
- **Launch logic** belongs in `core/sessionLifecycle.ts` with a fake-port test, not in `ipc.ts`.
- **Agent state.** `core/agentState.ts` is pure (renderer imports it); `agentStore.ts` is node-only.
  `idle` is never "finished"; `SessionStart` is `ready`, never `working`. Archived/Done agents drop
  out of every list and count via `isAgentArchived` — derive counts from the filtered rows.
- **Derived, not stored.** Blocked (`openBlockers`), the Inbox grouping and the Done cap compute from
  files and write nothing. Archive goes only through `setArchived`, not `TaskPatch`.
- **Hand-edited task files.** Normalise in `markdown.ts`, never in zod schemas. A file with
  frontmatter that fails validation is skipped and never rewritten. Unparseable activity bullets
  must round-trip.
- **Event-driven, no timers.** Auto-run and the watchers react to writes; do not add an interval.
  `notifyTasksChanged` runs on every task write and the main process is single-threaded with
  synchronous git — keep it cheap (see the Performance panel).
- **Orchestrate.** `laneFor` mirrors `resolveTemplateFor` (readiness outranks status); change both
  together. Only Backlog and In Review are dispatchable.
- **Warn, don't refuse.** Shortcut conflicts, launching a blocked task and similar user choices
  warn and proceed on confirm.
- **Experimental features** sit behind a key in `ExperimentalSettings` and a `flag` on their
  `SECTIONS` entry. External sources are read-only unless `writableSource` allows it; never call
  `adapter.writer` elsewhere.
- **Shortcuts.** `core/shortcuts.ts` is the only key list. Labels come from `shortcutHint`; add a
  command to `SHORTCUT_COMMANDS` and handle it in `runShortcutCommand` (`lib/appShell.ts`). No
  second list, no literal `⌘…`.
- **Terminal engines.** The PTY belongs to `ptyManager` whatever renders it. xterm.js is the default
  and the fallback; never import `@anoguez/styr-terminal` statically or add it to package.json, and
  never branch on the engine outside `core/terminalEngine.ts` (`TERMINAL_ENGINE_CAPABILITIES`).
- **Terminal.** Never remount `TerminalView` (it destroys scrollback): key by session id, push theme
  and bindings in via effects/refs. Command blocks are overlays on xterm, positioned from marks
  stamped with output offsets — not from runtime-state events.
- **Theme and UI.** No hardcoded colour literals (use theme tokens such as `text-danger`). Dropdowns
  are `Select` from `ui.tsx`; `Field` is a `div`, never a `label`. Prefer the `ui.tsx` pieces
  (`Card`, `Switch`, `Segmented`, …) over new controls. `DEFAULT_THEME` lives in `core/types.ts`.
  The window is deliberately opaque. `-webkit-app-region: no-drag` goes on controls, not wrappers.
- **Updater.** Never install or relaunch on its own; a relaunch kills running agents.
- **Releases.** Conventional commits (`feat:`, `fix:` …) or the changelog omits them. Never publish
  a release before its files are attached.

## Types

Domain types live in one file per domain under `src/core/types/` (`task`, `agents`, `settings`,
`workspaces`, `terminal`); the external-source types live in `src/core/sources/types.ts`.
`src/core/types.ts` re-exports all of them and holds the theme (`DEFAULT_THEME`), so import from
`@core/types` or `./types.js` as before. `src/core/taskSchema.ts` holds the zod schemas that validate
anything crossing a process boundary. Extend these rather than declaring new shapes — the renderer,
preload, IPC layer and MCP server all share them. A new domain file goes in `types/` (which
`tsconfig.web.json` already includes) and needs an `export *` in the barrel.

## Build specifics

- electron-vite v5 emits ESM (`.mjs`). `package.json#main`, the preload path in
  `src/main/index.ts` and the MCP path in `src/main/ipc.ts` all reference `.mjs` — keep them in sync
  if entry points move.
- `electron`, `better-sqlite3` and `node-pty` are externalised in `electron.vite.config.ts`. Both
  native modules are compiled against Electron's ABI by `electron-builder install-app-deps`, so the
  MCP server (plain `node`) must never import them.
- After changing dependencies, re-run `yarn postinstall` to rebuild the native modules. On Windows
  it skips the rebuild (`scripts/postinstall.mjs`): both modules' N-API prebuilds load in Electron.
- **Windows.** Never hardcode `/bin/zsh`, `$SHELL`, `open`, `:` as a PATH separator or `/` as the
  only path separator. Shortcut `mod` is Ctrl there, set once
  by `setPrimaryModifier` in the renderer; show keys with `formatAccelerator`/`shortcutHint`.
- `out/main/**` is in `asarUnpack`. The MCP server is launched by plain `node`, which cannot read
  inside an asar archive, so `app:mcpCommand` resolves it under `app.asar.unpacked` when packaged.
  Anything else that must be run by a non-Electron process needs the same treatment. An AppImage
  mounts itself only while running, so there `mcpEntry.ts` copies `out/main` to `~/.styr/mcp-server`.
- Anything that builds a shell command from a path must run it through `shellQuote`.
  `app:mcpCommand` is copy-pasted by the user into a terminal, and a path with a space (an
  install location, a home folder) silently splits into two arguments without it.
- `resources/icon.svg` is the icon source of truth; `resources/icon.icns` is derived by
  `yarn icon`. Never hand-edit the `.icns`.
- Releases are signed with the Developer ID and notarised: electron-builder finds the identity in
  the keychain locally or decodes `CSC_LINK` on CI, and notarises whenever the `APPLE_*` variables
  are set. `yarn package:adhoc` (`mac.identity` `"-"`) is the fallback without a certificate. Never
  set `mac.identity` to `null`: that skips signing entirely, leaving the bundle's resources unsealed,
  and macOS then reports the app as _damaged_ with no right-click-to-open escape.
- The entitlements file is mandatory: the hardened runtime enforces library validation, which
  blocks `node-pty` and `better-sqlite3` under an ad-hoc signature.

## Checks

```sh
yarn lint           # ESLint
yarn format:check   # Prettier
yarn build          # typechecks tsconfig.node.json + tsconfig.web.json, then builds
```

CI runs all three on every PR. The pre-commit hook runs lint-staged (ESLint and Prettier on staged
files) and the typecheck.

The README coverage badge is refreshed by the pre-commit hook (`yarn coverage:badge`, staged
automatically) and by the release workflow when release-please cuts a release. CI's
`coverage:check` fails only when coverage falls more than half a point below the badge — a rise
never fails.

TypeScript 7 (`@typescript/native`) is the compiler; the `typescript` package name is the TS 6
compatibility build (`@typescript/typescript6`), because typescript-eslint needs the compiler API
that TS 7 no longer ships.
