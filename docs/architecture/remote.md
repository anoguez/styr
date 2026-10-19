# Remote: `styr serve` and its protocol

A workspace can live on another machine, such as a cloud VM, where a headless Styr keeps its agents
and Auto-run going while the laptop is closed. The desktop app reaches it over `ssh`. This note
covers the server side (TASK-0131). The client router and reconnect UI are TASK-0132, and the host
setup flow and release bundles are TASK-0133. The full spec, decisions and edge cases are in
TASK-0129.

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
  to `serverHost.ts` too, or to that list if it acts on the desktop.
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
