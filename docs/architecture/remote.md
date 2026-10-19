# Remote: `styr serve` and its protocol

A workspace can live on another machine, such as a cloud VM, where a headless Styr keeps its agents
and Auto-run going while the laptop is closed. The desktop app reaches it over `ssh`. This note
covers the server (TASK-0131) and the client: the router, the connection and the reconnect UI
(TASK-0132). The host setup flow and release bundles are TASK-0133. The full spec, decisions and
edge cases are in TASK-0129.

```
desktop main ──ssh -T host styr serve attach──▶ attach (stdio ↔ socket) ──▶ ~/.styr/server.sock
                                                                             │
                                               styr serve: hub ─▶ src/host/ services, PTYs
```

## Rules

- **`src/server/` never imports `electron`**, nor anything under `src/main/`. ESLint enforces it,
  and `vite.server.config.mts` fails the build if anything it bundles resolves `electron`. Like
  `src/host/`, the server takes what the desktop gets from Electron as a port.
- **One channel table, kept to `ipc.ts`.** The server answers the IPC channels under the same
  names, with the same argument lists. `src/server/channels.test.ts` reads both from source and
  fails when a channel is added to one and not the other. The desktop-only handlers (`host.md`,
  What stays in `src/main/`) are listed there by name. When you add an IPC channel, add its line
  to `serverHost.ts` too, or to that list if it acts on the desktop, and give it a route in the
  client router (`src/host/remote/router.ts`: the active workspace's, a session's, or one the
  router answers itself; the tables are `src/host/remote/channels.ts`). `channels.test.ts` fails
  for a server channel with no route.
- **Arguments are checked with zod at the boundary.** Each entry in `serverHost.ts` has a
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
  the channel table. `start()` is what `src/main/index.ts` does once the app is ready, minus the
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
lock in TASK-0129). `protocol` is bumped only when the wire format changes.

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
are N-API builds. A release's server bundle (TASK-0133) has its own Node runtime and its own builds
of both, with the same layout (`out/server/`, `resources/claude/`, `node_modules/`). It never
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
For now Settings → Remote (shown with the flag) has a minimal form taking a name, host, remote
workspace id and server command; the guided setup is TASK-0133.

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
  app-level keys: storage, shortcuts, updates, experimental and the active workspace never sync),
  `settings:save` (the app-level part saved here, the workspace part on the server with the
  server's own app-level keys sent back unchanged), `settings:brokenFiles`, `terminal:list`
  (local sessions plus each host's), `diagnostics:snapshot` (the server's, with this machine's
  terminal engine), and the local-only actions below.
- **Everything else** (the window, updates, pickers, the terminal engine) stays local.

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

The Browse buttons (a task's working directory and context files, the Settings path fields) open
this computer's file dialog, so they are disabled for a remote workspace, with a tooltip saying to
type the path; dropping files on a task's brief is off too. A local path stored for the host
would not fail there: the server would start the agent in its home folder. In Settings this
follows the workspace being edited, elsewhere the open one. The storage folder is this computer's whatever the workspace, so its Browse stays on (`local`).

"Open file" on a remote task opens `vscode://vscode-remote/ssh-remote+<host><path>` when Settings
→ Open files with is VS Code or Cursor; otherwise it is disabled, with the remote path in the
tooltip. Reveal (task file, terminal folder) is disabled with the same. Copy path works. The main
process passes a remote path on as text: it never `path.resolve`s or `existsSync`s one.

### The connection channels

| Channel               | Kind      | Payload                                                      |
| --------------------- | --------- | ------------------------------------------------------------ |
| `remote:state`        | invoke    | `[]` → `RemoteState`                                         |
| `remote:state`        | broadcast | `RemoteState`: the flag, each host's state, each stub's live |
| `remote:retry`        | invoke    | `[host?]`: Retry now, one host or all                        |
| `remote:switchBack`   | invoke    | `[stubId]`: point the server at this workspace again         |
| `remote:addWorkspace` | invoke    | `[RemoteWorkspaceDraft]` → `WorkspaceOverview`               |

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
- `host/remote/client.integration.test.ts`: the router and `RemoteConnection` against a real
  `styr serve` built from the checkout, the transport running `serve attach` without ssh: the
  board through the router, a launch and attach, a drop while the terminal keeps printing, and the
  reattach with its backlog. Gated and run in the smoke job like `serve.integration.test.ts`.
- `renderer/lib/remoteStatus.test.ts`: the read-only reasons, switcher notes and file actions.
