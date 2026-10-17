# Host layer (`src/host/`)

The logic the main process runs for a workspace, free of Electron, so a headless `styr serve`
(TASK-0131) can host the same services that the desktop app hosts. It also makes the main process
testable without Electron: each service takes injected ports, and its test fakes them.

`src/core/` is still the lowest layer (types, schemas, the task store, pure rules). `src/host/` sits
on top of it and holds the stateful services and the Electron-free adapters they run over (the
SQLite index, the file watchers). `src/main/` is the Electron adapter: it implements the ports and
keeps only the `ipcMain.handle` lines.

```
src/main/  (Electron: ipcMain, BrowserWindow, Notification, dialogs, tray)
   │ implements HostPorts / WindowPorts, wires the services
   ▼
src/host/  (services + Electron-free adapters)
   │
   ▼
src/core/  (types, schemas, taskStore, pure rules)
```

## Rules

- **`src/host/` never imports `electron`**, nor anything under `src/main/`. ESLint enforces it
  (`no-restricted-imports` in `eslint.config.mjs`), and the same rule keeps `electron`,
  `src/main/` and `src/host/` out of `src/core/`. A service that needs Electron takes a port.
- **No async boundary.** A call that is synchronous in-process stays synchronous through a service:
  no Promise-returning `host.call()`, no serialisation, no `await` on the `switchWorkspace`,
  `pinWorkspace`, watcher or `notifyTasksChanged` paths. The ports are synchronous unless the
  operation they wrap already is not (`trashItem`, `showOpenDialog`).
- **Services take ports, not imports, for anything with side effects outside the files**, and are
  tested with fakes in the style of `core/sessionLifecycle.test.ts`. A port group backed by `core/`
  has a real default exported next to it (`diskWorkspaceStore`), like `diskWorklogSources`.
- **Broadcast channels stay literal** at the call site (`ports.broadcast('tasks:changed')`): the IPC
  contract test scans `src/host/` along with `src/main/` and `src/core/`.
- **Keep `notifyTasksChanged` within the TASK-0135 baseline** (see `tasks.md`, Diagnostics). Re-run
  the benchmark before and after moving anything on its path.

## Ports (`ports.ts`)

- `HostPorts`: `broadcast(channel, payload?)` to every renderer, `notify(title, body)` for a
  desktop notification, `trashItem(path)`, and `appPaths` (`isPackaged`, `version`, `appPath`,
  `resourcesPath`, read lazily).
- `WindowPorts<Caller>`: operations bound to the window that asked, `setTitleBarOverlay` and
  `showOpenDialog` parented to it. `Caller` is opaque to the services (Electron's `WebContents`).

`src/main/electronHost.ts` implements both (`electronHost`, `electronWindows`).

## Services

- `tasksService.ts`: the active board. `notifyTasksChanged` (sync the index, settle landed work,
  re-sync if that wrote a file, observe for sources, time it, broadcast `tasks:changed` once,
  request Auto-run), the `tasks:*` reads (`list`, `get`, `problems`) and the writes from
  `taskWrites.ts`. Its ports are the index, the task store, landing, the source observer, the
  diagnostics timer, the Auto-run request and `notifyAgents`.
- `workspacesService.ts`: the `workspaces:*` operations (overview, switch, create, rename, delete,
  board summaries, activity), broken settings files and `afterSettingsSave`. Switching and
  repointing are `core/workspaceSession.ts`; the service wires its ports. `inOtherWorkspace` is
  exported from here.
- `taskIndex.ts`: the derived SQLite index (see CLAUDE.md for its rules).
- `watcher.ts`: the tasks and agents chokidar watchers (see `agents.md` for the close race).
- `terminals/terminalsService.ts`: the terminal sessions (`createTerminalsService`), what main
  calls `ptyManager`. One PTY per session, its transcript (backlog, command marks, runtime state),
  `findSessionByTask` (workspace and task id), and the data, runtime-state and exit listeners. Its
  ports are `spawn` (`terminals/nodePty.ts` is the real one, kept apart so tests never load
  node-pty) and `usageEnv` (main's `usage.ts`, which needs the app's paths).
  `terminalBroadcasts(broadcast)` sends `terminal:data`, `terminal:runtimeState` and
  `terminal:exit`; `index.ts` subscribes it, beside the agent work it runs on an exit.
- `terminals/`: the rest of the terminal plumbing, all Electron-free: the shell integration, the
  protocol parser, `TerminalRuntime`, `TerminalTranscript`, and the Styr Terminal native host
  (`nativeHost`, `nativeEngine`, `blockSession`, `commandBlockTracker`). Electron stays in
  `src/main/terminal/terminalEngines.ts`, which loads the package from the app's paths and holds
  the native engine's IPC; `core/terminalEngine.ts` is still the one place that branches on the
  engine.

`src/main/taskIndex.ts` and `src/main/watcher.ts` re-export the host modules, and
`src/main/terminal/ptyManager.ts` binds the terminals service to node-pty and the usage mod and
re-exports its functions. `ipc.ts` and
`index.ts` import through them, so the main-process characterisation tests (TASK-0135) can mock
them by their main paths. Main passes the index and watchers to the services as ports.

## The slices

The extraction lands in five PRs, each with no user-visible change:

1. Scaffold, ports, tasks and workspaces.
2. Terminals: `ptyManager`, transcripts, the plain `terminal:*` handlers, the native host.
3. Agents: agent statuses, `markAgentExited`, `CodexMonitor`, the session lifecycle wiring, the tray
   model inputs.
4. Dispatch and Auto-run wiring.
5. The rest: landing, diffs, sources, usage, worklog, diagnostics, the CLI check.

The OS-integration handlers stay in `src/main/` because they are desktop-only by nature: open with
an app, list installed apps, `launchDetached`, Reveal in Finder, the directory and file pickers, the
title-bar overlay and the updater.
