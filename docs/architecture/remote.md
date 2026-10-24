# Remote: `styr serve` and its protocol

A workspace can live on another machine, such as a cloud VM, where a headless Styr keeps its agents
and Auto-run going while the laptop is closed. The desktop app reaches it over `ssh`. This note
covers the server (TASK-0131), the client: the router, the connection and the reconnect UI
(TASK-0132), and setting a host up, the version lock and the release bundles (TASK-0133). The full
spec, decisions and edge cases are in TASK-0129.

```
desktop main ──ssh -T host styr serve attach──▶ attach (stdio ↔ socket) ──▶ ~/.styr/server.sock
                                                                             │
                                               styr serve: hub ─▶ src/host/ services, PTYs
```

## Rules

- **`src/server/` never imports `electron`**, nor anything under `src/main/`. ESLint enforces it,
  and `vite.server.config.mts` fails the build if anything it bundles resolves `electron`. Like
  `src/host/`, the server takes what the desktop gets from Electron as a port.
- **One channel table, shared with `ipc.ts`.** `src/host/channelTable.ts` holds the invoke and
  send channels with their zod argument tuples. `ipc.ts` registers every entry with
  `ipcMain.handle` / `ipcMain.on` (parsing the arguments the same way), and `serverHost.ts` and
  the desktop's network listener (`remote-access.md`) answer the same entries through the hub, so
  the hosts cannot drift. `src/server/channels.test.ts` and the IPC contract test read the table
  from source. A handler that acts on the desktop (`host.md`, What stays in `src/main/`) stays in
  `ipc.ts` and is listed by name in `channels.test.ts`. When you add an IPC channel, add its line
  to the table, or keep it in `ipc.ts` and list it there, and give it a route in the client
  router (`src/host/remote/router.ts`: the active workspace's, a session's, or one the router
  answers itself; the tables are `src/host/remote/channels.ts`). `channels.test.ts` fails for a
  server channel with no route. Its answer (and any new broadcast the router acts on) also needs a
  schema in `src/host/remote/validation.ts`; `validation.test.ts` fails without one (see Trust
  boundary).
- **Arguments are checked with zod at the boundary.** Each entry in `channelTable.ts` has a
  `z.tuple` of its arguments, and the services parse their payloads with the existing schemas
  (`taskDraftSchema`, `settingsChangeSchema` …), as they do for IPC. A bad argument is an
  `Invalid params` error, never a throw inside a service.
- **`pinWorkspace` is never left set.** The server pins nothing itself; `inOtherWorkspace` pins
  only around synchronous work. The hub still checks after every handler, when it returns and
  when its promise settles, and clears and logs a pin left behind, since a leaked pin would send
  every client's calls to that workspace. The server also deletes `STYR_WORKSPACE_ID` from its own
  environment at start, as the main process never reads it.
- **The server's clock is the one that counts.** Agent exits (`markAgentExited`), Auto-run's
  launch history and breaker, landing and every `at` are computed in the server process. A client
  never sends a timestamp.

## Files

- `src/host/rpc/jsonRpc.ts`: the wire format, shared with the client. Newline-delimited JSON-RPC
  2.0: `encodeMessage`, `parseMessage` (zod), `LineDecoder` (chunks cut anywhere, UTF-8 safe,
  lines over 64 MiB dropped whole) and `RpcPeer`, a transport-free end that sends requests and
  notifications and answers incoming ones. Params are always the argument list. A result of
  `undefined` is sent as `null`, and the server reads a top-level `null` argument as left out,
  because JSON turns `[undefined]` into `[null]`.
- `src/server/hub.ts`: the connected clients. Each has its own peer and is greeted with
  `server:hello`. Requests go to the channel table, broadcasts go to every client, and
  `terminal:data` goes only to the clients attached to that terminal.
- `src/server/serverHost.ts`: the host services wired as `ipc.ts` wires them, over Node ports, and
  the shared channel table over them. `start()` is what `src/main/index.ts` does once the app is ready, minus the
  window, tray and updater. The services are module singletons underneath (the index, the
  watchers), so one process hosts one server.
- `src/server/socket.ts`: `listen` and `attach`.
- `src/server/serve.ts`: runs the server until SIGTERM or SIGINT. `src/server/index.ts` is the CLI
  (`cli.ts` parses it).

## The protocol

| Direction       | Kind         | Method                                         | Params                                  |
| --------------- | ------------ | ---------------------------------------------- | --------------------------------------- |
| server → client | notification | `server:hello`, on connect                     | `[ServerInfo]`                          |
| client → server | request      | `server:info`                                  | `[]` → `ServerInfo`                     |
| client → server | request      | `server:tray`, the last tray model             | `[]` → `{ statuses, titles }`           |
| client → server | request      | `server:experimental`, the client's switches   | `[{ externalSources }]` → `null`        |
| client → server | request      | any invoke channel (`tasks:list` …)            | the IPC arguments → the IPC result      |
| client → server | notification | `terminal:write`                               | `[id, data]`                            |
| client → server | request      | `terminal:attach`                              | `[id, cols?, rows?]` → `TerminalOutput` |
| client → server | request      | `terminal:detach`                              | `[id]`                                  |
| client → server | notification | `terminal:focus`                               | `[id]`                                  |
| client → server | notification | `terminal:resize`                              | `[id, cols, rows]`                      |
| server → client | notification | any broadcast channel (`tasks:changed` …)      | `[payload]`, or `[]` without one        |
| server → client | notification | `terminal:data`, to attached clients only      | `[{ id, data, sequence, marks }]`       |
| server → client | notification | `server:tray`, the tray model                  | `[{ statuses, titles }]`                |
| server → client | notification | `server:notify`, a notification for the client | `[{ title, body }]`                     |

`ServerInfo` is `{ protocol, version, pid, startedAt, storageDir, platform }`. `version` is Styr's
version, set at build time from package.json. The client compares it with its own (the version
lock, below). `protocol` (`PROTOCOL_VERSION` in `src/host/rpc/jsonRpc.ts`, shared by both sides) is
bumped only when the wire format changes.

Errors use the JSON-RPC codes: `-32700` for a line that is not JSON, `-32600` for a message of the
wrong shape, `-32601` for an unknown method, `-32602` for arguments that fail zod (with the issues
in `data`), and `-32000` for an error the handler threw, with its message. A bad line never closes
the connection.

### Terminals

The server owns the PTYs directly: no tmux. It outlives the ssh connection, so it is already the
multiplexer.

- **Attach and detach.** `terminal:attach` returns the backlog (`TerminalTranscript`, bounded as
  in the desktop app) and subscribes the client to that terminal's `terminal:data`. It is
  synchronous, so no output can fall between the backlog and the live stream. `terminal:detach`
  ends the subscription. A client that disconnects is detached from everything, and its terminals
  keep running. Reattaching, from the same client or another one, replays the backlog as a renderer
  reload does. `terminal:runtimeState` and `terminal:exit` go to every client.
- **Size follows focus.** Each client reports its view's size (`terminal:resize`, or the size in
  `terminal:attach`), and the server keeps one per client and terminal. The PTY takes the size of
  the client that sent `terminal:focus` for it last. Until any client focuses it, the first client
  to report a size owns it. Sizes from the others are kept and applied when they focus. When the
  owner leaves, the next client to report a size takes over.
- **Any client may type.** `terminal:write` is accepted from every client.
- **A stalled client is dropped.** A client more than 32 MiB behind (`MAX_BUFFERED_BYTES`: ssh hung,
  or the laptop asleep with the connection still open) is disconnected rather than buffered without
  end. It reconnects and reattaches with the backlog like any other.

### Many clients

Any number of clients may attach at once, for example two laptops. Broadcasts go to all of them.
Two clients starting the same task get the same session, because the launch gate and
`findSessionByTask` already return the running one. The server has one active workspace (its
config's `activeWorkspaceId`), and `workspaces:switch` changes it for every client, as it would
for every window of the desktop app.

## Running it

```sh
yarn build                                  # also builds out/server/
yarn serve                                  # node out/server/index.mjs serve
node out/server/index.mjs serve attach      # what `ssh -T host … attach` runs
node out/server/index.mjs serve --version
```

The socket is `~/.styr/server.sock` (`$STYR_HOME/server.sock`), or `--socket <path>` or
`$STYR_SERVER_SOCKET`. Its folder is created with mode 0700 and the socket with 0600, under a
umask, so it is never briefly open to others. A live server on the path makes a second one refuse
to start. A socket file left by a server that died is replaced. A path longer than a Unix socket
allows (about 100 bytes) is refused with a message. There is no TCP listener and no auth: being
able to reach the socket, which over the network means being able to `ssh` in, is the auth.

`attach` loads only the socket code, never the services or their native modules, because `ssh`
starts one per connection. It exits 0 when either side ends, and 2 with a message on stderr when no
server is running.

The server stores its workspaces under its own `storageDir` (default `~/Styr`), with the same
layout and settings files as the desktop app. Agents, hooks and the MCP server are configured on
the server's machine exactly as on a desktop. Every agent gets `STYR_WORKSPACE_ID`, and the MCP
server entry is `out/server/mcp/index.mjs`, bundled beside the server. Auto-run, the breaker and
the pause reasons live in the server process, so they outlive every client, and the Auto-run flag is
saved in the workspace's settings. A deleted
workspace folder goes to `~/.styr/trash/`, because headless Linux has no trash. An uncaught error
is logged and the server keeps running, as Electron's main process does, because exiting would
kill every agent. Stopping it (SIGTERM, SIGINT) kills its terminals, as quitting the desktop app
does.

## Build and native modules

`vite.server.config.mts` builds `src/server/index.ts` and `src/mcp/index.ts` into `out/server/`
for plain Node (`yarn build` runs it after electron-vite). Every JavaScript dependency is bundled.
Only `node-pty` and `better-sqlite3` stay external, and Node resolves them from the `node_modules`
next to `out/`. In a checkout that is the repo's own, which loads under Node because both modules
are N-API builds. A release's server bundle has its own Node runtime and its own builds of both,
with the same layout (`out/server/`, `resources/claude/`, `node_modules/`, plus `node/` and
`bin/styr`); see Server bundles below. It never
loads the desktop app's Electron-ABI copies from `app.asar.unpacked`. electron-builder leaves
`out/server/` out of the desktop app.

## Tests

- `src/host/rpc/jsonRpc.test.ts`: the framing and the peer.
- `src/server/hub.test.ts`: broadcasts, attach and detach, size follows focus, the pin check, with
  fake ports.
- `src/server/socket.test.ts`: the 0600 socket, stale and live sockets, and `attach`.
- `src/server/channels.test.ts`: the channel table against `ipc.ts`.
- `src/server/serve.integration.test.ts`: builds the server from the checkout, runs it under plain
  Node on a temporary socket and home (no ssh), and drives a task launch, a terminal attach,
  detach and reattach with its backlog, the size following focus across two clients, and an
  Auto-run pass, with a stand-in agent CLI. It needs a node-pty that loads under Node. The check
  job installs without scripts, so it skips there. The smoke job runs it with
  `STYR_SERVER_INTEGRATION=1`, which turns that skip into a failure.

## The client

With `experimental.remoteWorkspaces` on, the desktop app opens remote workspaces. Off, nothing
connects and no `ssh` runs; remote workspaces stay in the switcher marked "Remote workspaces are
off", and opening one is refused.

### The local stub

A remote workspace is a folder at `<storageDir>/workspaces/<id>/` holding only `workspace.json`:
`{ "name": …, "remote": { "host": …, "workspaceId": …, "server"?: … } }`. `listWorkspaces` reads
it like any other folder and puts the link on `WorkspaceInfo.remote` (`core/workspaces.ts`,
`parseRemoteLink`). The local id and the remote id are independent: two hosts can both serve a
`default`. `host` is whatever `ssh` takes, checked by `isValidRemoteHost` (never starting with `-`,
no shell characters). `server` is the command that starts `styr serve` on the host, kept as typed
and run by the host's shell (default `styr`). Removing the workspace deletes only the stub, and
the confirmation says so; nothing on the host is touched, so it works for a host gone for good.
New workspace → Remote host sets a host up and creates the stub (Host setup, below). Settings →
Remote hosts also has a form that only links a workspace a host already has (one set up from
another computer): a name, the host, the remote workspace id and the server command, which
defaults to `~/.styr/server/current/bin/styr`, where setup and `install.sh` put it.

### Files

- `core/remote.ts`: the pure rules, shared with the renderer. `sshArgs` (`-T`, `BatchMode=yes`,
  `ConnectTimeout`, `ServerAliveInterval` so ssh itself notices a link that died asleep) and
  `remoteAttachCommand`, built with the **POSIX** `ShellSyntax` whatever the local shell, because
  the remote is Linux; `reconnectDelay` (1s doubling to 30s); `remoteEditorFor` and
  `remoteEditorUri` (`vscode://vscode-remote/ssh-remote+<host><path>`, or `cursor://…`).
- `host/remote/connection.ts`: `RemoteConnection`, one per host, shared by every workspace on it.
  It owns one `ssh … serve attach` child and an `RpcPeer` over its stdio. States: `connecting`
  (child started), `connected` (the server said `server:hello`), `reconnecting` (with ssh's last
  stderr line as `lastError`, and `retryAt`), `offline` (stopped, or the machine asleep). A child
  that exits is retried after the backoff: one timer armed for a known instant, reset once
  connected, so nothing polls. An attempt that connects but brings no hello within 15s
  (`HELLO_TIMEOUT_MS`: a hung server, a remote shell that blocks) is killed and backs off the
  same way. `retryNow` skips the wait; `wake(true)` (power resume) replaces even
  a link that looks alive; `wake(false)` (network back) retries one that is down; `suspend` drops
  the link and waits for wake. A request while disconnected rejects at once: **nothing is queued**.
  The child and the clock are ports (`ConnectionPorts`); `sshTransport.ts` is the real child,
  `ssh` from PATH with no shell (OpenSSH ships with Windows 10+).
- `host/remote/router.ts`: the router (below), the composition root. It owns the connections'
  lifecycle (`refresh`), the per-call dispatch (`invoke`, `send`), the servers' events and the
  local broadcasts (`fromLocal`). Electron-free; its ports are the flag, the local workspaces,
  `connect`, `broadcast`, `notify`, `updateTray`, `openExternal`, `isLocalSession` and
  `saveGlobalSettings`. Its parts, each one concern:
  - `channels.ts`: the routing tables, pure data: which channels follow the active workspace or a
    session, which the router answers, which are writes, which reads keep a snapshot.
  - `registry.ts`: `RemoteRegistry`, which workspaces are remote and each host's state
    (`HostEntry`): `target`, `isLive`, `stubFor` and `mapIn`, the server-id-to-stub mapping.
  - `forwarding.ts`: sending a board call to a server, the `Snapshots` kept for reads, and
    `RemoteUnavailable` for writes refused while not live.
  - `terminals.ts`: remote sessions, attach and reattach (`TERMINAL_RESET`), the held output,
    `send`, and the mirror the Styr Terminal engine reads.
  - `workspaces.ts`: the servers' active workspace, switching it, the merged list and summaries.
  - `settings.ts`: the server's workspace keys with this machine's app-level ones, and saving.
  - `rollup.ts`: the merged tray (with the baseline after a connect) and switcher rollup.
  - `validation.ts`: the trust boundary: every answer and notification checked before the rest
    of the router sees it (Trust boundary, below).
- `host/remote/terminalMirror.ts`: the client's copy of an attached remote terminal (backlog, then
  the live stream, bounded like `TerminalTranscript`), for the Styr Terminal engine, whose
  `backlog` port is synchronous.
- `main/remote.ts`: binds the router to Electron. `routedIpcMain(ipcMain)` is what `ipc.ts` and
  `usage.ts` register their handlers on: the same `ipcMain.handle('channel', …)` lines, each
  wrapped so the router decides who answers. `startRemote` registers the `remote:*` channels and
  `powerMonitor`'s `suspend` and `resume`. The renderer reports the network coming back
  (`window` `online` → `remote:retry`), since the main process has no event for it.

### Routing

Per call, `router.invoke(channel, args, local)`:

- **No remote workspace at all**: `local()`, synchronously, exactly as before.
- **Board channels** (`tasks:*`, `git:*`, `agents:list`, `orchestrate:*`, `terminal:launchAgent`,
  `sources:*`, `worklog:load` …) go where the active workspace is: in-process for a local one,
  the host's connection for a remote one. The server answers for its own active workspace, which
  the client keeps pointed at the stub's remote id.
- **Session channels** (`terminal:kill`, `terminal:backlog`, `usage:context`, `agent:prompt` …)
  and the one-way `terminal:write` and `terminal:resize` go where the session runs, whatever
  workspace is open: a local tab stays local while a remote board is shown. The router learns
  each remote session's host from every result and event that carries it, and tags the session
  with `host`. `terminal:backlog` for a remote session becomes `terminal:attach` (the server
  streams that terminal's data to this client from then on); `terminal:resize` is followed by
  `terminal:focus`, so the PTY takes the size of the client that showed it last.
- **Answered by the router**: `workspaces:list` / `activity` / `boardSummary` (stubs take their
  counts and rollup from their server), `workspaces:switch` (the local switch, then
  `workspaces:switch` on the server), `settings:get` (the server's workspace keys, this machine's
  app-level keys: storage, shortcuts, updates, experimental and the active workspace never sync;
  the one exception is below),
  `settings:save` (the app-level part saved here, the workspace part on the server with the
  server's own app-level keys sent back unchanged), `settings:brokenFiles`, `terminal:list`
  (local sessions plus each host's), `diagnostics:snapshot` (the server's, with this machine's
  terminal engine), and the local-only actions below.
- **Everything else** (the window, updates, the native pickers, the terminal engine) stays local.
- **External sources follow the desktop.** The server runs a remote board's sources (sync,
  polling, mirroring, `gh`) and gates them on its own `experimental.externalSources`, so the router
  sends this machine's switch with `server:experimental` on every connect and every local
  `settings:changed`. The server saves it as its own app-level setting only when it differs, then
  restarts polling and broadcasts `settings:changed`. With many clients, the last to connect or
  change it wins. `gh` itself (`sources:ghStatus`) is the server's: installed and logged in there.

Ids from a server are mapped on the way in: every `workspaceId` becomes the stub that links to
that host and remote id, and one no stub links to becomes `remote-unlinked:<host>/<id>`, which
matches nothing locally, so its sessions and agents show nowhere. Routing and sessions therefore
key on the stub id plus the remote id, never on a task id alone.

Broadcasts are merged. The local services broadcast through `router.fromLocal`: while a remote
board is active, the local board's events (`tasks:changed`, `agents:changed`,
`orchestrate:autoState` …) are dropped, since the stub's empty folder is not the board, and the
server's take their place; while it is not live, the last agents snapshot stands in. The
switcher's rollup (`workspaces:activity`) and the tray merge local agents with every connected
server's (`server:tray`, re-tagged with the stubs' ids and names).

### Live, read-only and the server's active workspace

A remote board is **live** when its host is connected and the server's active workspace is the
stub's remote id. Only then are writes sent. Otherwise reads return the last answer the router
kept for them (`SNAPSHOT_CHANNELS`), or an empty board, and writes are refused with a message
saying why ("devbox is offline … Nothing was changed or queued"). The renderer shows the same:
`boardAccess` (`renderer/lib/remoteStatus.ts`) makes the board read-only, disables New task,
Dispatch, dragging and the task dialog's Save with the reason as tooltip, and terminal tabs on a
disconnected host get an overlay that takes no input.

`styr serve` has one active workspace, shared by every client (TASK-0131). Switching the desktop
app to a remote workspace switches the server, so the server follows the most recent client to
switch. A reconnect never switches it back on its own: if another client moved it meanwhile, the
board is not live, and the status bar's badge says "<host> is showing <name>" with **Switch
back** (`remote:switchBack`). The router notices a move from the server's `settings:changed`
(which carries its `activeWorkspaceId`) before any refetch can read the other board.

**Auto-run while the laptop is closed covers only the server's active workspace**, as on the
desktop. The Dispatch dialog says so for a remote workspace. Serving several workspaces at once
is a later change to the host services.

### Reconnect

On every `server:hello` the router fetches the server's workspace list, switches it if the user
asked for this workspace (at start, or by switching to it while disconnected), and then:

- reattaches each terminal this client had attached. Output that arrives while an attach is on
  its way (even in the same read as its reply) is held, then sent after the backlog, so the reset
  cannot wipe it. When the server's sequence moved past the
  mirror's, the backlog is sent to the views after a terminal reset (`ESC c`), so a view starts
  again from the server's scrollback rather than repeating itself; a session the server no
  longer has (it restarted) is reported exited. The renderer also lists the host's sessions again,
  so terminals started meanwhile get tabs.
- takes the rollup and the tray (`server:tray`, a request answering the last model) as a fresh
  **baseline**: agents that started waiting while disconnected are shown, not announced.
  Notifications come from the live stream only (`server:notify`, and the tray's transitions after
  the baseline), never as a backfill.
- refetches the board (`tasks:changed`, `agents:changed`, `settings:changed`, Auto-run's state).

### Local-only actions

**Browse picks on the machine the workspace lives on** (`PathBrowse`), as it does locally. The
Browse buttons (a task's working directory and context files, the Settings path fields) open this
computer's file dialog on a local workspace. On a remote one they open the in-app
`DirectoryPicker` in a dialog, fed by `terminal:listDirectories` (`includeFiles` for files), which
is routed to the active workspace's server, so it lists the host's folders and files and the path
picked is the host's. A local path stored for the host would not fail there: the server would start
the agent in its home folder. In Settings this follows the workspace being edited; since the
listing follows the open workspace, a remote workspace edited from another one cannot be browsed
until it is opened, and its Browse says so (`browseTarget`). The storage folder is this computer's
whatever the workspace, so its Browse always uses the native dialog (`local`). Dropping files on a
task's brief stays off for a remote workspace: those are this computer's paths.

"Open file" on a remote task opens `vscode://vscode-remote/ssh-remote+<host><path>` when Settings
→ Open files with is VS Code or Cursor; otherwise it is disabled, with the remote path in the
tooltip. Reveal (task file, terminal folder) is disabled with the same. Copy path works. The main
process passes a remote path on as text: it never `path.resolve`s or `existsSync`s one.

### The connection channels

| Channel                | Kind      | Payload                                                      |
| ---------------------- | --------- | ------------------------------------------------------------ |
| `remote:state`         | invoke    | `[]` → `RemoteState`                                         |
| `remote:state`         | broadcast | `RemoteState`: the flag, each host's state, each stub's live |
| `remote:retry`         | invoke    | `[host?]`: Retry now, one host or all                        |
| `remote:switchBack`    | invoke    | `[stubId]`: point the server at this workspace again         |
| `remote:inspect`       | invoke    | `[host]` → `RemoteHostInspection`: ssh, the system, boards   |
| `remote:addWorkspace`  | invoke    | `[RemoteWorkspaceDraft]` → `WorkspaceOverview`: open one     |
| `remote:setup`         | invoke    | `[RemoteSetupDraft]` → `RemoteSetupResult` (Host setup)      |
| `remote:setupProgress` | broadcast | `RemoteSetupProgress`: one step's state                      |
| `remote:runningAgents` | invoke    | `[host]` → `RemoteRunningAgents`, before a restart or stop   |
| `remote:upgrade`       | invoke    | `[host]`: install this version beside, restart into it       |
| `remote:stopServer`    | invoke    | `[host]`: stop the server, then disconnect                   |
| `remote:disconnect`    | invoke    | `[host]`: offline until Connect                              |
| `remote:connect`       | invoke    | `[host]`: start the installed server if needed, connect      |

### Client tests

- `core/remote.test.ts`: the ssh line (POSIX on any client, batch mode), hosts, the backoff, the
  VS Code link.
- `host/remote/connection.test.ts`: the state machine over a fake transport and clock
  (`remoteFixture.ts`): connect, the 1s→30s backoff and its reset, Retry now, nothing queued,
  sleep and wake, stop.
- `host/remote/router.test.ts`: the router over fake servers on the real framing: the flag, one
  child per host, routing by workspace and by session, id mapping, snapshots and refused writes,
  another client moving the server, terminal reattach with a reset, the merged tray and
  notifications, settings and the VS Code link.
- `host/remote/channels.test.ts`: every server channel has a route, and every write is routed.
- `host/remote/router.hostile.test.ts`: a compromised server (malformed, oversized and hostile
  answers and notifications on every channel kind, a bad hello, session ids it does not own,
  hostile task paths); `validation.test.ts`: every routed channel and handled notification has a
  schema, and the bounds.
- `host/remote/client.integration.test.ts`: the router and `RemoteConnection` against a real
  `styr serve` built from the checkout, the transport running `serve attach` without ssh: the
  board through the router, a launch and attach, a drop while the terminal keeps printing, and the
  reattach with its backlog. Gated and run in the smoke job like `serve.integration.test.ts`.
- `renderer/lib/remoteStatus.test.ts`: the read-only reasons, switcher notes and file actions.

## Trust boundary

A remote workspace shows on the laptop what was written on another machine: tasks and their
activity (agents write them), agent status records, source items, terminal output, settings and
notifications. If that machine is compromised, all of it is hostile. A compromised VM must not
become a compromised laptop, so each side checks what it is given.

**The server validates calls.** `styr serve` parses every request's arguments with zod
(`serverHost.ts`, the `taskSchema.ts` schemas): a bad one is `Invalid params`, never a throw in a
service. This protects the host's files from a confused client.

**The client validates answers** (`host/remote/validation.ts`). `router.refresh` wraps each host's
connection in `validatingConnection`, so every answer passes its schema in `RESPONSE_SCHEMAS`
before `forwarding.ts`, `terminals.ts`, `workspaces.ts`, `settings.ts`, `rollup.ts` or a caller
sees it; the one-off setup session (`session.ts`) does the same, and the hello is parsed in
`connection.ts`. Notifications pass `NotificationGuard` (`NOTIFICATION_SCHEMAS`) before
`onNotification`.

- **The schemas** are the `remote*` ones at the end of `core/taskSchema.ts`, bounded copies of the
  shapes in `types/`, next to the schemas the server checks with. The unbounded ones that read local
  task files are untouched: local workspaces behave as before. Unknown keys are dropped.
- **Bounds** (`REMOTE_LIMITS`): every answer is first walked by `remoteBoundsProblem` (depth 24,
  strings 1 MiB, 20,000 entries per list or object, no `__proto__`/`constructor`/`prototype`
  keys), then each field has its own cap: a task body 1 MiB, 10,000 activity bullets, 500
  sessions, a terminal backlog or chunk `TerminalTranscript`'s 200,000 units (and marks inside
  it). Lines over 64 MiB are dropped by `LineDecoder` without being held, on the client as on the
  server, and it counts bytes as they arrive, so a long line costs linear time.
- **Failure.** An answer that fails is a `RemoteInvalidResponse` (a `RemoteUnavailable`) for that
  call: the renderer shows its message, and the router's own reads fall back as when the host does
  not answer. A notification that fails is dropped and logged once per channel per connection. A
  method with no schema is refused or dropped. A hello that fails leaves the host `incompatible`.
  Nothing throws in the main process and nothing invalid reaches `broadcast`, `notify`,
  `updateTray` or `openExternal`.
- **Local actions.** Session ids must look like ids, and a server may not claim one that runs on
  this machine or was seen on another host (`terminals.ts`, `mayClaim`): an answer that does fails,
  a broadcast that does is dropped, and `terminal:data` is taken only for terminals this client
  attached on that host. Notification text loses control and bidi characters and is cut
  (`notificationText`). A task's `filePath` must be one line without control characters, and
  `remoteEditorUri` normalises it lexically and escapes each segment, so whatever the server sends
  the link is `vscode://vscode-remote/ssh-remote+<host>/…` (or `cursor://…`), never another scheme,
  a query or a fragment.

**The renderer is sandboxed** (`sandbox: true`, with `contextIsolation` and no `nodeIntegration`).
React escapes the text, but should any script ever get into the renderer, it could call
`window.api` (`terminal.create`, `terminal.write`) and so run commands on the laptop; the sandbox
at least keeps it inside Chromium's process sandbox with nothing but that API, and the API is the
one thing to keep narrow. The preload is one CommonJS script (`electron.vite.config.ts`) that
requires `electron` alone, using only `contextBridge`, `ipcRenderer` and `webUtils` (plus the
sandbox's `process.platform`); `scripts/build.mjs` fails a build whose preload requires anything
else, `src/preload/sandbox.test.ts` checks the source, and the smoke test checks the running
renderer is sandboxed (on macOS and Windows; CI's Linux runs Chromium with `--no-sandbox`).

**The window stays on the app** (`main/windowSecurity.ts`): navigation away from the app's page is
refused for every web contents (`web-contents-created`), no window or `<webview>` is ever created,
and only `http(s)` links reach `shell.openExternal`. A `prUrl` or source link from a server with
another scheme (`file:`, `smb:`, an app's own) opens nothing.

**Content Security Policy** (`src/renderer/index.html`): `default-src 'none'`; scripts only from
the app's files (`script-src 'self'`: no inline script, no `eval`); `connect-src 'self'` (the dev
server's HMR socket; the built app makes no requests); images and fonts from the app or `data:`;
no objects, frames, workers, forms or `<base>`. `style-src` keeps `'unsafe-inline'` for React's
style props and xterm.js. A new need (a worker, a fetch) is added here deliberately, never with a
wildcard.

## Host setup

The desktop app drives the install the way VS Code Remote-SSH installs its server: every step runs
on the host over ssh, and nothing is installed on the laptop.

**One dialog, four entries.** `RemoteSetupDialog` is the only setup UI. It opens from the
switcher's New workspace… (Remote host), Settings → Workspaces → New workspace (the same toggle,
`WorkspacePlace`), Settings → Remote hosts (all workspaces) → Set up a host…, and the palette's
New remote workspace…; each is behind the experimental flag, and with it off both New workspace
forms are what they were. From Settings, **Settings closes** (after confirming any unsaved
changes) and the app's New workspace dialog opens on Remote host (`newWorkspace` in
`appShell.ts`), so a finished setup switches to the new board exactly as from the switcher.

**Host first, then what to do.** The dialog takes a host and runs `remote:inspect`: the check and
probe steps below (`inspectRemoteHost`), and, when a server already answers, its boards
(`workspaces:list` over the host's shared connection or a one-off session, parsed like any
answer). The probe is kept for the setup that follows, so ssh and the probe run once. With boards
there, it offers **Open an existing workspace**, listing them by name and marking those this
computer already links to, next to **Create a new workspace**. Opening one writes only the local
stub (`remote:addWorkspace`: no install, no server write) and switches to it. Otherwise it asks for
a name and runs the rest. Nobody types a server workspace id or a server command: setup and
`install.sh` put the server at the default path (`DEFAULT_SERVER_COMMAND`).

**Nothing about agents.** A remote workspace behaves like a local one: setup checks only what
installing and running the server needs. git and the agent CLI are checked where a local workspace
checks them, Settings → Agents (`agents:cliStatus`, routed) and the check before a launch, both on
the server.

```
check    ssh -T -o BatchMode=yes <host> true      ssh's own error verbatim on failure
probe    sh -s -- --probe …   (install.sh on stdin) OS, arch, glibc, systemd, linger, versions
         └ a server running: its boards, to open one (stops here) or create one
install  sh -s -- --install --version V --sha256 H the host downloads, checks, unpacks, starts
         └ exit 20 or 22: this computer downloads, checks H, uploads (scp, or ssh … cat), --tarball
create   workspaces:create on the server           shared connection, or a one-off session
         then the local stub, and the app switches to it: the board opens empty and connected
```

- **One installer.** `resources/server/install.sh` is the only implementation. The desktop app
  pipes it to `sh -s` on the host (it ships beside the asar, `extraResources`), and each release
  publishes it with its version filled in, for setting a host up by hand or from cloud-init
  (`curl -fsSL …/releases/latest/download/install.sh | sh`, in the README). Both produce the same
  layout and unit, so either can upgrade what the other installed. Modes: `--probe`, `--install`,
  `--start`, `--restart`, `--stop`; its `::styr key=value` lines are for the app
  (`parseInstallReport`), everything else is for people. Exit 10 is not Linux, 11 an unsupported
  arch, 12 a glibc older than the bundles' floor (below), 20 a failed download, 22 a bundle that did not match its SHA-256 (told apart, since it may
  mean the download was tampered with), 30 and 31 a start or stop that did not happen.
- **Layout.** `~/.styr/server/<version>/` holds one unpacked bundle per version, side by side;
  `~/.styr/server/current` is a symlink to the one that starts next; `bin/styr` resolves the
  symlink when it starts, so a running server keeps its version. The unit is
  `~/.config/systemd/user/styr-server.service`: `ExecStart=%h/.styr/server/current/bin/styr serve`,
  `Restart=on-failure`, and the PATH of a login shell, so agents find `claude` in `~/.local/bin`
  (ssh runs the script without the profile). It is written on every install, enabled, and started only when no server answers on the
  socket (`styr serve attach` exits 0 when one does, 2 when none does).
- **Lingering.** Without it, systemd stops the user's services when their last session ends: the
  server would die with the ssh connection. Setup reports it and shows
  `sudo loginctl enable-linger $USER` to copy. Styr never runs it.
- **No systemd** (a container, WSL without it): `nohup`, with a warning that the server will not
  come back after a reboot. Connect in Settings → Remote hosts starts it again.
- **Reuse.** A server of this version already running is reused: nothing is installed. A second
  remote workspace on the same host creates its workspace over the host's shared connection, and
  its stub shares that connection (one per host, `registry.wantedHosts`). An older server keeps
  running: this version is installed beside it and takes over on Upgrade.
- **Refused, warned.** Only what cannot work is refused: no ssh, not Linux, not x86_64 or aarch64,
  a bundle that fails its hash. No systemd and an older server running are warnings (warn, don't
  refuse).

The steps are `src/host/remote/hostSetup.ts`, behind ports: the ssh runner, the uploader, the
bundle on this computer, the embedded hashes and the script (`HostSetupPorts`), plus creating the
server workspace and the stub (`SetupFlowPorts`). `sshRunner.ts` is the real ports;
`session.ts` is the one-off `serve attach` session. `src/main/remote.ts` binds them.

### Security

- **The hash comes from the signed app.** The release workflow builds the server bundles before
  the desktop app and writes their SHA-256s into it (`out/main/serverBundles.json`, by
  `scripts/server-checksums.mjs app`), so they ship inside the signed, notarised app. The app
  passes the hash to `install.sh --sha256`; the host refuses to unpack a download that does not
  match. The upload fallback checks the same hash on this computer before sending
  (`fetchBundle`), and the host checks it again. The release's `SHA256SUMS` is used only by
  `install.sh` run by hand, where it catches a corrupt download; to check provenance, verify the
  bundle's attestation (`gh attestation verify <bundle> --repo anoguez/styr`, in the README). A
  build with no hashes (development) installs nothing unless `STYR_SERVER_BUNDLE_DIR` names a
  folder holding the bundles, whose own hashes then stand in.
- **Host keys are ssh's business.** Every ssh and scp Styr runs keeps `BatchMode=yes` and ssh's
  default host-key checking (`sshCommandArgs`, `scpArgs`): never `StrictHostKeyChecking=no` or
  `accept-new`, and Styr never writes `known_hosts`. An unknown or changed key stops setup with
  ssh's message and the instruction to run `ssh <host>` once in a terminal, check the key, accept
  it, and click Retry. A live connection that hits a changed key says the same in its badge
  (`exitReason`). `core/remoteSetup.test.ts` holds every command line to this.

### Version lock

- **Protocol.** A server whose hello carries another `protocol` leaves the connection
  `incompatible`: the ssh link stays open (so nothing retries in a loop), no request, notification
  or board call passes either way, writes are refused saying to upgrade, and the badge says so with
  Upgrade server. Retry (after the upgrade) replaces the link. The one-off setup session refuses
  such a server too.
- **Version.** A server on another Styr version still connects; the host's state carries
  `upgradeTo` (this app's version), and the badge and Settings → Remote hosts offer Upgrade
  server. **Nothing restarts the server unasked**, because a restart ends its agents.
- **Upgrade server** lists the agents it would end (`remote:runningAgents`, the host's
  `terminal:list`) and proceeds only on confirm, then runs `--install` (beside the old version,
  repointing `current`) and `--restart` (the unit, or the hello's pid without one), and reconnects.

### Settings → Remote hosts

Labelled **Remote hosts (all workspaces)**, in the app-level group: "Machines that run your remote
workspaces. Your local workspaces are not affected." One row per host in use: its status, server
version, uptime (from the hello's `startedAt`) and the workspaces on it, with Disconnect (offline
until Connect, whatever wakes the computer), Connect (starts the installed server if it is not
running, then connects), Upgrade server (enabled on a version mismatch) and Stop server (asks
first, listing the running agents; then disconnects). Below, **Set up a host…** opens New
workspace → Remote host, the one way to add a remote workspace; there is no form to link one by
its server id.

### After a restart or a reboot

Sessions are gone, as after a desktop app restart. A server that stopped cleanly recorded each
agent's exit; one that died (a reboot, a crash) recorded none, so at start the server marks every
agent not already `exited` as exited (`src/server/orphans.ts`). Each resumes from its card with
`--resume`, as today.

### Server bundles

`scripts/server-bundle.mjs` (after `yarn build:server`) builds
`dist/styr-server-<version>-<platform>-<arch>.tar.gz` for the machine it runs on: `out/server/`,
`resources/claude/`, the Node runtime of the Node running it (checked against nodejs.org's
`SHASUMS256.txt`), and `node-pty` and `better-sqlite3` installed by that Node's npm, so both match
its ABI. It checks the result runs (`bin/styr serve --version`, both modules load). On a Mac it
builds a darwin bundle, useful only to try the layout.

`linux-x64` and `linux-arm64` are built on native runners inside `node:24-bookworm` by
`.github/workflows/server-bundle.yml`, the only definition of the build: CI runs it, self-check
included, on every PR, and the release builds the published bundles with it (`releases.md`). Until
0.35.1 the bundles were built only at release time, inside bullseye, and v0.35.0's arm64 build
failed its self-check: `better-sqlite3`'s prebuilt binary needs glibc 2.33.

**The glibc floor is 2.36** (Debian bookworm's): Ubuntu 22.04+, Debian 12+, RHEL/Rocky 9+, Amazon
Linux 2023. Ubuntu 20.04 and Debian 11 are not supported. The floor and that list live only in
`install.sh` (`GLIBC_FLOOR`, `GLIBC_HOSTS`, beside its arch list): `--probe` reports them with the
host's glibc (`getconf GNU_LIBC_VERSION`, else `ldd --version`), `unsupportedHost` refuses a host
below the floor ("devbox has glibc 2.31; the Styr server needs 2.36 or newer (…)"), and the script
run by hand exits 12 with the same words before downloading anything. A host whose glibc cannot be
told (musl) is not refused for it. Raising the container means raising `GLIBC_FLOOR` with it.

In development, a version has no release: build the Linux bundles (for example in a
`node:24-bookworm` container), put them in a folder, and start the app with
`STYR_SERVER_BUNDLE_DIR` pointing at it. The host's own download then fails (exit 20) and this
computer uploads the local bundle.

### Setup tests

- `core/remoteSetup.test.ts`: the release names, the `install.sh` lines, probe parsing, the
  refusals (the glibc floor included), the ssh messages, and that no ssh or scp line weakens host-key checking.
- `host/remote/hostSetup.test.ts`: the flow over fake ports: a fresh VM that downloads (nothing
  but ssh commands leaves the laptop), the upload fallback and what the UI is told, a tampered
  bundle refused on both sides, an unknown host key, a non-Linux host, the warnings (none about
  agents), inspecting first so ssh and the probe run once, reusing a running server, an older one
  left running, restart and stop.
- `host/remote/installScript.test.ts`: `install.sh` run for real in a throwaway home with stand-in
  `uname`, `getconf`, `ldd`, `curl`, `systemctl` and `loginctl` and a fake bundle: probe (no
  `--cli`), download
  and checksum, an old glibc refused with exit 12 before any download,
  the upload path, reuse without restart, stop and restart, the unit and the linger line.
- `renderer/…/newRemoteWorkspace.test.tsx`: the toggle in both New workspace forms with the flag
  on and off, Set up a host… and no link form on Remote hosts; `remotePickers.test.tsx`: Browse
  opens the in-app picker on a remote workspace and the native dialog on a local one.
- `host/remote/sshRunner.test.ts`: the bundle download checked against the app's hash, the
  embedded hashes, ssh in batch mode, and the scp → `ssh … cat` fallback.
- `host/remote/session.test.ts`, and the protocol cases in `connection.test.ts` and
  `router.test.ts`; `server/orphans.test.ts`.
