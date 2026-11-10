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
  refused with a message. Settings lists the Tailscale IPv4 address first, and switching access on
  with nothing picked listens there (`defaultBindAddress`); it never picks IPv6 or loopback by
  itself, and never replaces an address the user chose (the QR carries it, and an IPv6 host fails
  on networks that reach the IPv4 one). Every accepted socket's source address is
  checked against the same ranges before a byte is read, so a port-forward cannot let the internet
  in. Requests with `X-Forwarded-For`, `Forwarded`, `X-Real-IP` … are refused (no reverse
  proxies), and so is any request with an `Origin` (a web page cannot be a device). Reachability is
  the user's network: Tailscale, or an ssh tunnel to loopback. No UPnP or hole punching; the only
  relay is one the owner runs on their own tailnet (`styr relay`, below).
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

## What Settings warns about

- **Shields Up.** With Tailscale's Shields Up on, nothing connects in and the phone only sees a
  timeout (the warning is not shown while this computer is connected to a relay, which it reaches
  by connecting out). `tailscale.ts` runs `tailscale debug prefs` (a child process, never synchronous, trying
  the Mac app's binary when `tailscale` is not on the app's PATH) and reads `ShieldsUp` alone; the
  answer is `AccessState.shieldsUp`. It is asked when Settings → Remote devices opens
  (`access:checkNetwork`) and when access is switched on, never on a timer.
- **Nothing shared.** `AccessState.workspaceShared` is false while no workspace has `remoteAccess`
  on; with a device paired, the page offers "Share this workspace" (`access:shareWorkspace`), which
  saves the flag on the open workspace through `settings:save`. The access state is re-sent on
  `settings:changed` / `workspaces:changed`.
- **The log names the step.** A refusal says whether sign-in, the pairing code or a late message
  failed, and a handshake that went quiet says whether the device sent no `hello` or hung up after
  the challenge (the key check a phone fails without a word).

## Known limits

- A peer on the private network can spend the single-use pairing secret with a bad `pair`
  message, forcing a rescan; anyone who sees the QR during its 2 minutes can pair.
- Loopback is allowed (for an ssh tunnel), so a local tunnel agent (ngrok, cloudflared) pointed at
  the listener would expose it; devices would still need their key.
- `styr serve` keeps the host's private key in `remote-access.json` in plaintext (mode 0600). The
  desktop seals it with `safeStorage` (Keychain, DPAPI, libsecret; not Linux's `basic_text`
  fallback) and drops the plaintext. A `styr serve` on the same machine shares the file, so once
  the desktop has sealed the key it cannot sign and says so; the fingerprint is never replaced.

## Files

- `src/host/channelTable.ts`: the shared channel table (see `remote.md`).
- `src/host/remoteAccess/addresses.ts`: the private ranges, `bindAddressProblem`, the interfaces
  Settings offers, the proxy-header list.
- `src/host/remoteAccess/accessStore.ts`: `~/.styr/remote-access.json` (mode 0600, written
  atomically): the listener's settings, the devices' public keys, this install's Ed25519 key pair and
  the in-memory pairing offer. Not in `Settings`: those reach the renderer and the clients.
- `src/host/remoteAccess/handshake.ts`: the handshake, as a pure state machine plus the proof
  functions a client uses.
- `src/host/remoteAccess/noise.ts`, `secureSession.ts`, `secureClient.ts`: protocol 2 (below):
  Noise XX on `node:crypto`, the host's handshake and `SecureFrameChannel`, and the device's side
  (tests and the transcript vector only; the phone has its own in Dart).
- `src/host/remoteAccess/gate.ts`: `createNetworkPolicy`, the per-client filter the hub applies.
- `src/host/remoteAccess/tailscale.ts`: the Shields Up probe.
- `src/host/remoteAccess/accessService.ts`: what Settings drives: switch on/off, move, pair, revoke,
  the keep-awake hold (`keepAwake.ts`). A listener that cannot start (port in use, interface gone)
  leaves the setting off with the reason in `error`; the app carries on.
- `src/server/wsListener.ts`: the WebSocket transport. `networkAccess.ts` wires store + policy +
  service for a host and `forwardToHub` feeds the hub the host's broadcasts. `src/main/networkAccess.ts`
  is the desktop's half (the `access:*` channels, `powerSaveBlocker`, the hub over `ipc.ts`'s table);
  `styr serve --listen <address>[:port] [--pair]` is the server's.
- `src/host/remoteAccess/relayClient.ts`: the host's side of a relay (below); `dialRelay` in
  `src/server/networkAccess.ts` gives it its `ws` socket.
- `src/host/remoteAccess/relayProtocol.ts`: the relay's wire (paths, messages, close codes, what
  the host signs). `src/server/relay/`: `styr relay` (`relay.ts` the forwarding, `allowList.ts`,
  `control.ts` the Unix socket calls, `cli.ts`, `main.ts`).

## `styr serve` on a machine with no window (a cloud VM)

`styr serve --listen <tailscale-address>[:port] [--pair]` listens for devices (a public address is
refused, so a VM needs Tailscale). `styr serve --relay <address>[:port] [--pair]` (port 7879 by
default) takes them through a `styr relay` instead, or as well; it prints the fingerprint to allow
on the relay, and `--pair` waits up to 10 seconds for the relay to register it before the QR.
Either flag switches the other path off for the run (the config is the same file the desktop uses). `--pair` prints a QR and the URI at start. Later, without a
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

## Protocol 2: end to end over a path the host does not trust

For a relay (TASK-0212's "Design: relay mode"), the session is end-to-end encrypted with
`Noise_XX_25519_ChaChaPoly_SHA256` (`noise.ts`, checked against the official vector in
`noiseXX.vector.json`). The listener's `secureSessions` picks what it takes: `off` (direct mode,
the default: protocol 1 exactly as above, and a protocol-2 hello gets `{type:'error',
code:'protocol', protocol:1}`), `allow` (the client's hello picks; `STYR_REMOTE_PROTOCOL2=1` turns
it on for direct sockets while the phone is being built) and `require` (a relay: a protocol-1
hello is closed with 4401 and no plaintext answer, so a relay cannot downgrade a session).

Text frames, each one Noise message in strict, padded base64. Prologue `styr-noise-v1`.

```
C → S  {"type":"hello","protocol":2,"noise":b64(-> e)}                  empty payload
S → C  b64(<- e, ee, s, es, payload)   payload = JSON {identityKey, signature}
C → S  b64(-> s, se, payload)          payload = JSON {type:'auth', deviceId, signature}
                                              or {type:'pair', name, identityKey, signature, proof}
S → C  sealed {type:'paired', deviceId}  (pairing only), then sealed {type:'ready'}
       then JSON-RPC, one message per sealed message           any refusal: close 4401, nothing sent
```

- **Static keys** are X25519 and made per connection. Identity is still the Ed25519 key:
  `signature` is Ed25519 (base64, 64 bytes) over `label ‖ sender's Noise static key (32 bytes) ‖
h`, where `label` is `"styr-noise-host-v1\n"` for the host and `"styr-noise-device-v1\n"` for the
  device, and `h` is the handshake hash just before that payload is encrypted. `identityKey` is
  SPKI DER (44 bytes), base64, as in protocol 1. Every base64 field is strict and padded.
- **The device checks the host first:** SHA-256(`identityKey`) must be the QR's fingerprint and the
  signature must verify over the static key Noise just delivered. Otherwise it closes without
  writing message 3, so an impostor (a relay among them) learns nothing about the device.
- **Sign-in:** the host verifies `signature` with the stored key for `deviceId` (a dummy key for an
  unknown one, so a miss costs the same). **Pairing:** `proof` = hex HMAC-SHA256(key = the QR's
  secret, utf-8; `"styr-noise-pair-v1\n" ‖ h ‖ "\n" + name + "\n" + identityKey`), and the
  signature must be by `identityKey`. `h` covers both ephemeral and both static keys, so a relay
  running a handshake with each side cannot carry a proof from one to the other; the secret never
  travels, and the attempt spends it. `name` is at most 100 characters, so message 3 fits the 2 KiB
  handshake limit whatever they are.
- **Records.** Each sealed message is `flag ‖ bytes` (flag 1: the message ends here, 0: more
  follows); a message longer than 65,518 bytes is split, and every non-final record carries exactly
  65,518 (a message ends on its last chunk, never on an empty record). A message reassembles to at most 8 MiB and must be UTF-8. Noise's counters make any
  altered, replayed, reordered or dropped frame fail the next decrypt, and the host then closes
  with 4400: the session cannot recover.

`secureSession.vector.json` holds full transcripts from fixed keys (pairing and sign-in, both
directions, a split message) plus answers the phone must refuse (another host, a signature over
another Noise key) and frame sequences the host must refuse (tampered, replayed, reordered,
dropped). styr-app's Dart client replays the same file; `UPDATE_SECURE_VECTOR=1 yarn vitest run
src/host/remoteAccess/secureSession.vector.test.ts` rewrites it, which is a wire change on both
sides.

**What the device must do itself** (the host cannot enforce it): over a relay, never fall back to
protocol 1, whatever the host answers; reject an all-zero X25519 result (small-order key), as
`noise.ts` does; send no JSON-RPC before `ready`; end the session on any failed frame.

**What a relay still learns:** who connects when, each message's length (there is no padding), that a
session is a pairing (message 3's size and the `paired` record), and the host's identity key, by
running a handshake with it. Like protocol 1, anyone who can reach the host while a QR is open can
spend it with one bad attempt, forcing a rescan. The listener's failure limit and connection caps
are per source address; behind a relay every device shares one, so the relay client needs its own
per-session limits.

## Relay: `styr relay`

For a host that cannot accept connections (Tailscale Shields Up, a firewall), the host and the
phone each connect _out_ to a relay on the owner's tailnet, which moves the phone's frames to the
host and back (TASK-0212, "Design: relay mode"). `src/server/relay/` is the relay;
`host/remoteAccess/relayClient.ts` the host's side (below). The phone's dial is a later step.

```sh
styr relay --listen <tailscale-address>[:port]   # default port 7879; loopback or Tailscale only
styr relay allow <host fingerprint>             # Settings → Remote devices shows it; ':' and case are fine
styr relay hosts                                # allowed hosts, connected or offline, sessions
styr relay revoke <host fingerprint>            # removes it and ends its sessions at once
```

`allow`, `hosts` and `revoke` go over the relay's own Unix socket (`~/.styr/relay.sock`, or
`$STYR_RELAY_SOCKET`, `--socket`; apart from `server.sock`, so a relay and a server can share a
machine), with `relay:allow`, `relay:hosts`, `relay:revoke`; nothing on the network can call them.
The allow list is `~/.styr/relay.json` (fingerprints only, mode 0600, written atomically); a file
that exists but cannot be read stops the relay from starting. No secret crosses the network to
enrol a host: it proves its key on every registration.

**Trust.** The relay is trusted for admission and availability only. It cannot read or alter a
session (protocol 2 is end to end, above, and the host requires it over a relay); it can refuse
service and see who connects when, and how large each frame is.

Wire (`host/remoteAccess/relayProtocol.ts`, shared with the host's client). Text frames, JSON:

```
GET /host
R → H  {type:'challenge', nonce}                      nonce: 16 random bytes, hex
H → R  {type:'register', hostKey, signature}          hostKey: Ed25519, SPKI DER, base64;
         signature: Ed25519 over "styr-relay-host-v1\n" + nonce
R → H  {type:'registered'}       or close 4401 (bad signature), 4403 (not on the allow list)
R → H  {type:'open', sessionId}  {type:'frame', sessionId, frame}  {type:'close', sessionId}
H → R  {type:'frame', sessionId, frame}  {type:'close', sessionId, code?}

GET /phone/<host fingerprint, 64 hex>
R ↔ P  the frames, bare, both ways         or close 4404 at once: the host is not connected
```

- **Says nothing about hosts.** A phone asking for a host that is offline, unknown or not allowed
  gets the same close, 4404 `host offline`, after the upgrade, and no frame. The signature is
  checked before the allow list, so only the key's holder learns it is not allowed. A host that
  goes away ends its sessions with 4404; one key registered again takes over (the old socket gets
  4409); a revoked host gets 4403.
- **Frames are opaque.** The relay never parses a phone's frame; it carries text frames up to
  one protocol-2 record (`RELAY_FRAME_MAX_CHARS`; larger closes with 1009, binary with 4400).
  A host's close `code` (1000, or 4000–4999) reaches the phone, so a refused device still sees 4401. A malformed host message closes the host (4400) and its sessions.
- **Limits, as `wsListener.ts`.** Bound to one loopback or Tailscale address (`bindAddressProblem`);
  every socket's source is checked before a byte is read; proxy headers and an `Origin` are
  refused; an unknown path is a plain 404. Five failed registrations (bad signature, not allowed,
  bad message, 10 s timeout, a hang-up) from one address in a minute turn it away (429); thirty
  4404s do the same for phones (a phone retries while its host is away). At most 16 hosts
  registering, 8 connections per address (32 from loopback), 32 sessions per host (4429). Each
  session may have 8 MiB on its way to the host, and all of a host's sessions together 16 MiB;
  the session that would pass either ends alone (4429), so phones cannot take the host link down.
  A frame is measured as the host receives it, inside its JSON envelope (a `"` escapes to two
  characters); one over the host's message limit ends that session (4400). The host's socket
  more than 32 MiB behind (a host that stopped reading) is cut, ending all its sessions; a phone
  more than 32 MiB behind ends its own. Both get a liveness ping every 20 s.
- **What a relay still reveals:** a phone that knows a fingerprint learns whether that host is
  online (that is the point of 4404), and 4429 says it is busy.

## The host on a relay: `relayClient.ts`

Settings → Remote devices → "Connect through a relay" (`AccessConfig.relay`: `enabled`, `address`,
`port`, in `remote-access.json`; a file without it reads as off), or `styr serve --relay`. It is a
switch apart from "Allow other devices to connect": either, both or neither can be on.

- **Loopback or Tailscale only.** `relayAddressProblem` refuses anything else (a hostname, a LAN
  or public address) before anything is dialled; the setting stays on and says why.
- **One outbound socket.** It dials `ws://<address>:<port>/host`, signs the relay's nonce with the
  host's identity key and waits for `registered`. A drop (or a relay that breaks the protocol:
  bad JSON, a session before `registered`) ends every session through it and dials again after
  1 s, doubling to 60 s; `registered` resets the delay. A liveness ping every 20 s while connected
  notices a dead link. 4403 (not on the allow list) shows "Not allowed on this relay" and keeps
  trying, so `styr relay allow` takes effect without touching the host. 4409 means another process
  with this key (the desktop and `styr serve` on one machine) registered: this one stops and says
  so rather than take the link back and forth. No other timers.
- **One session per `open`.** Each runs `createSecureServerHandshake` alone: protocol 2 or nothing
  (a protocol-1 hello is closed with 4401 and no plaintext). Then the hub with
  `createNetworkPolicy`, exactly as a direct socket: the gate and each workspace's `remoteAccess`
  apply unchanged, `store.touch` marks the device seen and it shows as connected. Close codes to
  the device match the listener's (4400 a bad frame, 4401, 4403 revoked, 4408 handshake timeout,
  4429 busy); a session the relay closes is just dropped.
- **Its own per-session limits.** Every relayed device shares the relay's address, so the
  listener's per-address failure limit would let one phone lock out the rest; instead at most 16
  sessions may be mid-handshake (more get 4429), each has the 10 s handshake timeout and the 2 KiB
  handshake frame limit, and a message reassembles to at most 8 MiB. The relay's own per-address
  limits (30 4404s a minute, 8 connections) still apply to phones.
- **Revoke** ends a device's relayed sessions as it ends its direct ones (4403), including a device
  removed by another process, which is noticed at the next ping.
- **The link is shared.** The socket's limit on incoming messages allows three bytes per character
  of the relay's limit, so a phone's frame of non-ASCII characters cannot cut the link; a link
  more than 32 MiB behind (a relay that stopped reading) is cut and dialled again.

**Pairing through the relay.** "Pair a device…" makes `styr://pair?v=2&relay=<host:port>&hostfp=<fp>&fp=<fp>&secret=…&exp=…`
when the relay is the way in: the listener is off, or Tailscale Shields Up blocks it. With the
listener up it is the `v=1` QR as before. It is refused while the relay has not registered this
host ("Styr is not connected to the relay"), as it is while nothing listens. The secret, its 2
minutes and its single use are the same; the proof is protocol 2's, so a relay cannot pair.

Settings shows the status ("Connected", "Relay unreachable", "Not allowed on this relay", and why)
under the switch, with this computer's fingerprint and a button to copy it for `styr relay allow`.
`AccessState.relayStatus` / `relayError` carry it; `access:configure` takes a `relay` patch, so no
new channel was added.

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
`host/remoteAccess/secureSession*.test.ts` (protocol 2's release gates: tamper, replay, reorder,
drop, downgrade, wrong host, a relay that cannot pair; the transcript vector),
`server/wsListener.secure.test.ts` (protocol 2 over the socket),
`server/wsListener.test.ts` (hostile input: bad handshakes, binary and oversized frames, proxy
headers, origins, rate limiting, leakage on every broadcast kind), `server/networkAccess.test.ts`
(off by default opens no port; pair once, reconnect across a restart, revoke),
`server/network.integration.test.ts` (the built `styr serve --listen` with a paired device),
`host/remoteAccess/relayClient.test.ts` (the client on a fake link: registration, pairing and
sign-in end to end, protocol 1 refused, tampered frames, revoke, handshake timeout and cap, backoff,
4403 / 4409, a relay that breaks the protocol or stops answering pings),
`server/networkAccess.relay.test.ts` (the real client, relay and hub: allowed late, pairs, the gate
refuses an unshared workspace, revoke ends both sessions, the relay going away),
`server/relay/relay.test.ts` (forwarding, the same 4404 for offline / unknown / not allowed, bad
and replayed signatures, revoke, takeover, frame and backlog limits, rate limits, bind addresses,
a protocol-2 pairing through the relay that sees only ciphertext), `server/relay/control.test.ts`
(the CLI, the allow list file, the Unix socket calls).
