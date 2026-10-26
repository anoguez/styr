# Remote access: devices reaching a workspace over a private network

A phone (the Flutter app) can use a workspace that lives in the desktop app, or on a `styr serve`,
without that workspace ever having been "remote". Everything stays on the computer: tasks, agents,
terminals, worktrees, Auto-run and settings. The device sends calls and shows what comes back;
nothing is queued on it, and a call while it is disconnected is refused. Its paths are the
computer's (a directory picker lists the computer's folders through `terminal:listDirectories`).
The computer has to be awake with Styr running: quitting or sleeping ends the connection and the
terminals, as today. For a laptop-closed setup run `styr serve` (`remote.md`).

This is separate from the ssh remote workspaces of `remote.md`, where the desktop is the client.
Here the desktop (or `styr serve --listen`) is the server, and the client is a device.

```
device ──ws://<private address>:7878──▶ wsListener ─handshake─▶ hub ─▶ gate ─▶ channel table
                                                                              │
                                  desktop: ipc.ts services       styr serve: serverHost services
```

## Rules

- **Off by default, two switches.** Settings → Remote devices → "Allow other devices to connect"
  starts the listener; each workspace then opts in with `remoteAccess` (Settings → Remote access,
  "Allow remote clients to open this workspace", a workspace setting, default `false`). Neither
  alone exposes a workspace. The flag is ignored for an ssh remote workspace's stub.
- **Tailscale (and loopback) only, enforced in code** (`host/remoteAccess/addresses.ts`). The listener
  binds only to loopback or Tailscale addresses (`100.64.0.0/10`,
  `fd7a:115c:a1e0::/48`; the IPv4 range also covers carrier-grade NAT); `0.0.0.0`, `::`, a hostname, a LAN (RFC 1918 / link-local) or public address and "nothing picked" are
  refused with a message, and the default is none. Every accepted socket's source address is
  checked against the same ranges before a byte is read, so a port-forward cannot let the internet
  in. Requests with `X-Forwarded-For`, `Forwarded`, `X-Real-IP` … are refused (no reverse
  proxies), and so is any request with an `Origin` (a web page cannot be a device). Reachability is
  the user's network: Tailscale, or an ssh tunnel to loopback. No UPnP, relay or hole punching.
- **No hub traffic before the handshake.** An unauthenticated peer never reaches `hub.connect`.
  Five failed handshakes from one address in a minute turn that address away (429) for the rest of
  the minute; every refusal is logged. Loopback is not counted (every ssh-tunnelled device shares
  127.0.0.1, and sign-in is a signature, so there is nothing to guess) and gets a larger
  connection cap.
- **No TLS in v1.** The handshake keeps every reusable credential off the wire instead (below). Encryption beyond
  the private network (Tailscale's WireGuard, an ssh tunnel) is a follow-up.
- **Network clients get a narrower API** (`gate.ts`): no desktop-only channels, no `remote:*`,
  `updates:*`, `access:*` or `server:experimental`, no `workspaces:create`, no `server:notify`, and
  `settings:save` only for a shared workspace with the app-level part unchanged. The local window
  and the Unix socket have no policy and are never filtered.
- **One active workspace, shared by all clients.** A device that switches workspace moves the
  desktop window too, as another window would. It sees the active workspace in `workspaces:list`
  (`activeId`, empty when the active one is not shared) and `settings:changed`.

## Known limits

- A peer on the private network can spend the single-use pairing secret with a bad `pair`
  message, forcing a rescan; anyone who sees the QR during its 2 minutes can pair.
- Loopback is allowed (for an ssh tunnel), so a local tunnel agent (ngrok, cloudflared) pointed at
  the listener would expose it; devices would still need their key.
- `remote-access.json` holds the host's private key in plaintext (mode 0600).

## Files

- `src/host/channelTable.ts`: the shared channel table (see `remote.md`).
- `src/host/remoteAccess/addresses.ts`: the private ranges, `bindAddressProblem`, the interfaces
  Settings offers, the proxy-header list.
- `src/host/remoteAccess/accessStore.ts`: `~/.styr/remote-access.json` (mode 0600, written
  atomically): the listener's settings, the devices' public keys, this install's Ed25519 key pair and
  the in-memory pairing offer. Not in `Settings`: those reach the renderer and the clients.
- `src/host/remoteAccess/handshake.ts`: the handshake, as a pure state machine plus the proof
  functions a client uses.
- `src/host/remoteAccess/gate.ts`: `createNetworkPolicy`, the per-client filter the hub applies.
- `src/host/remoteAccess/accessService.ts`: what Settings drives: switch on/off, move, pair, revoke,
  the keep-awake hold (`keepAwake.ts`). A listener that cannot start (port in use, interface gone)
  leaves the setting off with the reason in `error`; the app carries on.
- `src/server/wsListener.ts`: the WebSocket transport. `networkAccess.ts` wires store + policy +
  service for a host and `forwardToHub` feeds the hub the host's broadcasts. `src/main/networkAccess.ts`
  is the desktop's half (the `access:*` channels, `powerSaveBlocker`, the hub over `ipc.ts`'s table);
  `styr serve --listen <address>[:port] [--pair]` is the server's.

## `styr serve` on a machine with no window (a cloud VM)

`styr serve --listen <tailscale-address>[:port] [--pair]` listens for devices (a public address is
refused, so a VM needs Tailscale). `--pair` prints a QR and the URI at start. Later, without a
restart (which would end the agents), on the same machine:

```sh
styr serve pair          # a new QR, 2 minutes, one use
styr serve devices       # id, name, connected / last seen
styr serve revoke <id>   # removes it and ends its connections at once
```

These go over the Unix socket (`access:pair`, `access:devices`, `access:revoke`, answered only
there; the gate refuses `access:*` from devices). The pairing secret is printed to the terminal,
so avoid running `--pair` where a service manager logs stdout; use `styr serve pair` from a shell.
A workspace is shared by `remoteAccess` in its settings: toggle it from the desktop (the remote
workspace's Settings → Remote access) or set it in the workspace's `settings.json`.

## Pairing and sign-in

Pairing happens once per device. "Pair a device…" shows a QR for
`styr://pair?v=1&host=…&port=…&fp=<fingerprint>&secret=<secret>&exp=<ms>`: the address, this
install's key fingerprint to pin, and a one-time secret that works for 2 minutes and one attempt
(a wrong guess spends it too). Pairing is refused while nothing is listening. The device makes its
own Ed25519 key pair and keeps the private key in the platform secure store (Keychain / Keystore)
with the fingerprint; **the private key never reaches the computer**, which stores only the public
key, the device's name and its id. The key has no expiry; app, computer or network restarts change
nothing. It stops working only on Revoke, which also ends that device's live connections; adding
the device again needs a new QR.

Text frames, JSON, at most 2 KiB and 10 seconds until `ready`:

```
C → S  {type:'hello', protocol?, clientNonce}            clientNonce: 16 random bytes, hex
S → C  {type:'challenge', protocol, serverNonce, serverKey, signature}
         serverKey: Ed25519 public key (SPKI DER, base64); the client checks SHA-256(serverKey) hex
         equals the QR's fingerprint, and signature (Ed25519, base64) over
         "styr-server-v1\n" + clientNonce + "\n" + serverNonce. A mismatch: close, send nothing.
C → S  {type:'auth', deviceId, signature}
         signature = base64 Ed25519 (device private key) over
           "styr-auth-v1\n" + deviceId + "\n" + serverNonce + "\n" + clientNonce + "\n" + fingerprint
   or   {type:'pair', name, publicKey, proof}
         publicKey: the device's Ed25519 public key (SPKI DER, base64)
         proof = hex HMAC-SHA256(key = the QR's secret, utf-8,
           "styr-pair-v1\n" + serverNonce + "\n" + clientNonce + "\n" + fingerprint + "\n" + name + "\n" + publicKey)
S → C  [{type:'paired', deviceId}] {type:'ready'}   — then JSON-RPC, one message per text frame
   or  {type:'error', code:'unauthorized'}, then close 4401   (every failure looks the same)
```

Nothing a passive listener captures can be replayed: the sign-in signature and the pairing proof
both cover this connection's two fresh nonces, and the pairing proof is keyed by the QR's secret,
which is never sent. The device's credential (the private key) is never sent. A server that does
not hold the pinned key fails the signature check on the phone, so the phone sends nothing to an
impostor. **What this does not do is encrypt the session:** after `ready`, terminal I/O, tasks and
settings are cleartext, and a peer that can sit in the path can read them or take over the
connection. That is why only Tailscale (WireGuard) and loopback (an ssh tunnel) are accepted: a
LAN address is refused rather than warned about. After `ready` the session is `remote.md`'s protocol, starting with
`server:hello`; `docs/protocol/styr-remote.schema.json` lists the channels and argument schemas,
generated from the zod tuples (`protocolSchema.ts`; `UPDATE_PROTOCOL_SCHEMA=1 yarn vitest run
src/server/protocolSchema.test.ts` rewrites it, and the test fails when it is stale).

Differences from the Unix socket: one JSON-RPC message per frame (no newline needed), frames over
8 MiB close the connection, a client more than 32 MiB behind is dropped, and a device that misses a
liveness ping is dropped (it reconnects, reattaches, and gets the terminal backlog as always).
Close codes: 4400 bad request, 4401 unauthorized, 4403 revoked, 4408 handshake timeout. A refusal
by the gate is JSON-RPC error `-32001`.

## The gate (what a device sees)

`isOpen(workspace)` = flagged, a real folder, not a stub. `createNetworkPolicy` then:

- `workspaces:list` / `switch` / `rename` / `delete` answers list only open workspaces; `switch`,
  `rename`, `delete` of another one are refused, `create` always is. `activeId` is `''` while the
  active workspace is not open. The rollups (`workspaces:activity`, `:boardSummary`) and the tray
  (`server:tray`, rows and titles) are filtered to open workspaces.
- **A channel the gate does not name is refused.** Every channel in `channelTable.ts` is listed in
  `gate.ts` (`BOARD`, `SESSION_FIRST`, `WITHOUT_ACTIVE`, `NEVER`); `gate.test.ts` fails until a new
  one is classified, so it stays closed to devices until someone decides. Board channels need the
  active workspace to be open. Session channels (`terminal:*`, `agent:*`, `usage:*` with a
  terminal id) are refused for a terminal whose workspace is not open. A plain shell tab belongs to
  no workspace: a device may use only the shells _it_ opened (`terminal:create`), never the ones
  open on the desktop.
- **Secrets are not sent.** Settings answers and `settings:changed` show REST sources' header
  values and bodies as `[hidden]`; a save that sends `[hidden]` back keeps the stored value.
  The stored values are restored only while the source keeps its URL and method, so a device cannot
  point a source at its own host and have the secrets sent there. This is a courtesy, not a
  boundary: a paired device can already run anything in a terminal, so shell and agent commands are
  shown and a determined device can read `settings.json`.
- Broadcasts: only events named in `gate.ts` are sent at all. Board events reach a device only while the active workspace is open;
  `terminal:runtimeState`, `agent:conversation` and `usage:context` only for open terminals
  (`terminal:exit` also reaches a device that was attached to it); `terminal:data` only for
  terminals it attached to; `settings:changed` always, but reduced to `{ remoteAccess: false }`
  once the workspace stopped being shared. `server:notify` and the desktop's own events never.
- Unsharing a workspace: the hub re-checks on `settings:changed` / `workspaces:changed`
  (`forwardToHub`) and detaches the device's terminals; the PTYs keep running. Its next call is
  refused.

A paired device is fully trusted once the workspace is shared (commands, the folder listing,
deleting the shared workspace); there are no per-device scopes in v1.

## Tests

`host/remoteAccess/*.test.ts` (addresses, store, handshake pieces, gate, service),
`server/wsListener.test.ts` (hostile input: bad handshakes, binary and oversized frames, proxy
headers, origins, rate limiting, leakage on every broadcast kind), `server/networkAccess.test.ts`
(off by default opens no port; pair once, reconnect across a restart, revoke),
`server/network.integration.test.ts` (the built `styr serve --listen` with a paired device).
