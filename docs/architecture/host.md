# Host layer (`src/host/`)

The logic the main process runs for a workspace, free of Electron, so the headless `styr serve`
(`src/server/`, see `remote.md`) hosts the same services that the desktop app hosts. It also makes the main process
testable without Electron: each service takes injected ports, and its test fakes them.

`src/core/` is still the lowest layer (types, schemas, the task store, pure rules). `src/host/` sits
on top of it and holds the stateful services and the Electron-free adapters they run over (the
SQLite index, the file watchers). `src/main/` is the Electron adapter: it implements the ports, binds the
services to them and keeps the `ipcMain.handle` lines, plus the desktop-only handlers listed at the
end.

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
- `agentsService.ts`: the agents. `agentStatuses` (each record tagged with its branch),
  `notifyAgentsChanged` (broadcast `agents:changed`, hand the tray model to `updateTray`, broadcast
  the `workspaces:activity` rollup and keep it for `activity()`, request Auto-run),
  `markAgentExited` with `removedWhileLive` and the plan-run archive, `agents:remove`,
  `terminal:resumeSession`, and the session lifecycle (`core/sessionLifecycle.ts`: launch, ask PR /
  review / fork, hand-off) wired to its ports. It creates the Codex monitor through the
  `createMonitor` port before the lifecycle; `ipc.ts` creates the service at load, after the tasks
  and workspaces services, so the monitor comes up when it always has. `previewPrompt` renders the
  prompt a launch would send (`terminal:previewPrompt`). Its ports are the agent
  store (`diskAgentStore`), git (`diskGit`), the index and task files, the terminals, the monitor,
  `publishConversation` (the usage service), the CLI checks, `updateTray` (main's `tray.ts`, which
  owns the Electron `Tray` and the "needs you" `Notification`) and the Auto-run request.
- `dispatchService.ts`: Dispatch and Auto-run. `plan()` (`orchestrate:plan`, the summary without
  task objects), `run(taskIds?)` (`orchestrate:run`: the bounded merged-work check, then the plan,
  then each launch), `autoState` / `autoSet` (`orchestrate:autoState`, `orchestrate:autoSet`), and
  the Auto-run runner (`core/autoDispatchRunner.ts`) wired to its ports: the flag written to the
  active workspace's file with a `settings:changed` broadcast, `orchestrate:autoStarted` for each
  session it starts, the failure and rework notes, and the breaker's pause and rework-cap messages
  through `notify`. `requestAutoRun`, `startAutoRun` (the startup grace) and `autoRunFlagChanged`
  are what the tasks and agents services, `index.ts` and `settings:save` call. Its ports are the
  settings (`diskDispatchSettings`), the index and `addNote`, the live sessions, the agent rows,
  the agents service's `launch`, main's `checkForMergedWork` and the clock (`realClock`). The rules
  stay pure in `core/orchestrate.ts` and `core/autoDispatch.ts`. `ipc.ts` creates it after the
  agents service.
- `landing.ts`: "Done means landed" (see `agents.md`). `createLanding` runs the rules of
  `core/landing.ts` over the board and performs their writes: `settleLandedTasks` (from
  `notifyTasksChanged`) and `fetchAndSettle` (fetch `origin`, then settle the repositories that
  moved), with the `LandingCache` and `RemoteFetcher` living as long as it does. `mergedWorkCheck`
  is `checkForMergedWork`: fetch and settle, then `notifyTasksChanged` if that wrote, never
  rejecting. Its ports are the task files, `checkoutGit`, `fetchOrigin`, the clock and the index
  (`diskLandingStore` plus `query`).
- `gitService.ts`: the checkouts' views. `taskDiff` and `filePatch` (`git:taskDiff`,
  `git:filePatch`: a bad request is an `{ error }`, not a throw), `diffStats` (`git:diffStats`: one
  pass at a time, yielding to the event loop between tasks through the `yieldTurn` port, `nextTurn`
  for real), `branches`, `gitContext` (`terminal:gitContext`) and `checkout(task)`, the active
  workspace's checkout of a task, which the tasks service removes a worktree through. Its ports are
  the settings, the index and `diskRepoGit` (`taskCheckout` and the `core/worktree.ts` reads).
- `worklogService.ts`: `worklog:load`, the Worklog for a span, yielding between tasks like the diff
  stats. Its ports are the index, the transcripts (`diskWorklogSources`) and `yieldTurn`.
- `sourceSync.ts`: external sources (see `sources.md`). `createSourceSync` over a `SourceSyncStore`
  (`diskSourceSyncStore`: the settings, `currentSources`, `adapterFor`, the guarded
  `writableSource`, `testRestRequest`, the task files and the poll timers): sync, preview, a
  reviewed `applySource`, link / unlink / refresh, `observeTasks` and its push-back, the polling,
  the REST test behind the experimental flag, and `ghStatus`. `initSourceSync` takes the
  `onTasksChanged` and `onState` hooks `ipc.ts` wires to `notifyTasksChanged` and `sources:state`.
- `usage.ts`: the agent CLIs' usage and conversations. `createUsage` serves the account quota, a
  terminal's context fill, a Codex session's usage (from its rollout), the conversation Styr
  Terminal draws, prompts and approval answers sent back to the agent, and `usageEnv` for each new
  terminal; `start()` clears the last run's files and watches the mod's files, broadcasting
  `usage:claude`, `usage:context` and `agent:conversation`. Its ports are `broadcast`, `appPaths`
  (where the mod is), `sessionTask` and `findTask`, `codexTranscript` and `watch` (`watchFiles`,
  chokidar).
- `agentCli.ts`: the agent CLI checks. `createAgentCliChecks(runShell)` gives `agentCliStatus`
  (Settings, always run) and `ensureAgentCli` (before a launch, remembering a CLI that was ready);
  `execFileShell` is the real shell runner. The decisions are `core/agentCli.ts`.
- `diagnostics.ts`: the Performance panel's sampling. `createDiagnostics` keeps the recent
  `notifyTasksChanged` durations and the event-loop histogram (sampled only between snapshots);
  its ports are `appPaths` and `processMetrics` (Electron's `app.getAppMetrics()` in main).
- `settingsService.ts`: `settings:get`, `settings:save` (persist, then the workspaces service's
  `afterSettingsSave` and Dispatch's `autoRunFlagChanged`, even when the write failed) and
  `app:mcpCommand`. Its ports are the settings files (`diskSettingsStore`), those two follow-ups and
  `mcpEntry` (main's, which knows the asar layout).
- `codexMonitor.ts`: the Codex app-server client (`CodexMonitor`, `prepareCodex`).
- `taskIndex.ts`: the derived SQLite index (see CLAUDE.md for its rules).
- `watcher.ts`: the tasks and agents chokidar watchers (see `agents.md` for the close race).
- `directories.ts`: `listDirectories`, the folders under a path for the terminal's directory picker.
- `rpc/jsonRpc.ts`: the newline-delimited JSON-RPC framing and peer that `styr serve` and its
  clients speak (see `remote.md`).
- `terminals/terminalsService.ts`: the terminal sessions (`createTerminalsService`), what main
  calls `ptyManager`. One PTY per session, its transcript (backlog, command marks, runtime state),
  `findSessionByTask` (workspace and task id), and the data, runtime-state and exit listeners. Its
  ports are `spawn` (`terminals/nodePty.ts` is the real one, kept apart so tests never load
  node-pty) and `usageEnv` (the usage service, bound in main's `usage.ts`).
  `terminalBroadcasts(broadcast)` sends `terminal:data`, `terminal:runtimeState` and
  `terminal:exit`; `index.ts` subscribes it, beside the agent work it runs on an exit.
- `terminals/`: the rest of the terminal plumbing, all Electron-free: the shell integration, the
  protocol parser, `TerminalRuntime`, `TerminalTranscript`, and the Styr Terminal native host
  (`nativeHost`, `nativeEngine`, `blockSession`, `commandBlockTracker`). Electron stays in
  `src/main/terminal/terminalEngines.ts`, which loads the package from the app's paths and holds
  the native engine's IPC; `core/terminalEngine.ts` is still the one place that branches on the
  engine.

`src/main/taskIndex.ts`, `src/main/watcher.ts` and `src/main/codexMonitor.ts` re-export the host
modules. `src/main/terminal/ptyManager.ts` binds the terminals service to node-pty and the usage
mod, `landing.ts` binds the landing to main's index, `sourceSync.ts` the source sync to the disk
store, `usage.ts` the usage service to the app's paths, the index and the terminals (and registers
its `usage:*` and `agent:*` handlers), `agentCli.ts` the checks to a real shell, and
`diagnostics.ts` the sampling to `app.getAppMetrics()`; each re-exports the functions main uses.
`ipc.ts` and `index.ts` import through them, so the main-process characterisation tests
(TASK-0135) can mock them by their main paths. Main passes the index and watchers to the services
as ports. Ports taken from a module the tests mock are passed as lambdas (`() => fetchAndSettle()`):
a mock without that export then fails only if the handler runs, not when `ipc.ts` loads.

## The slices

The extraction landed in five PRs, each with no user-visible change:

1. Scaffold, ports, tasks and workspaces.
2. Terminals: `ptyManager`, transcripts, the plain `terminal:*` handlers, the native host.
3. Agents: agent statuses, `markAgentExited`, `CodexMonitor`, the session lifecycle wiring, the tray
   model inputs.
4. Dispatch and Auto-run wiring.
5. The rest: landing, diffs, sources, usage, worklog, diagnostics, the CLI check.

## What stays in `src/main/`

`ipc.ts` is the wiring: it creates the services in order (tasks, workspaces, agents, git, worklog,
the merged-work check, Dispatch, settings), binds their ports to main's modules, and holds one
`ipcMain.handle` / `ipcMain.on` line per channel, each passing its arguments to a service. It has no
task, launch, landing or Dispatch logic.

The OS-integration handlers stay in `src/main/` on purpose, because they are desktop-only by
nature and a headless host has no desktop to act on:

- opening a file with the app chosen in Settings (`tasks:openInEditor`, `openPathWith`) and in VS
  Code (`terminal:openInCode`), and `launchDetached`, which starts that program outside Styr;
- listing the installed apps that open text (`settings:listApps`, which reads macOS bundles);
- Reveal in Finder and opening a folder or link (`tasks:reveal`, `terminal:revealDirectory`,
  `terminal:openLink`);
- the native pickers (`settings:pickDirectory`, `settings:pickApp`, `settings:pickFiles`). The
  terminal's directory picker (`terminal:listDirectories`) reads the folders through
  `src/host/directories.ts`, so `styr serve` answers it with the remote machine's folders;
- the title-bar overlay (`app:titleBarColors`) and `app:info`;
- the updater (`updater.ts`), the tray (`tray.ts`) and the window and app lifecycle in `index.ts`.
