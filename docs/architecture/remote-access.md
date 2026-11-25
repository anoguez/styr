# Remote access: devices on the same network reaching a workspace

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
device ──ws://<this computer's LAN or VPN address>:7878──▶ wsListener ─admit─handshake─▶ hub ─▶ gate ─▶ channel table
                                                                              │
                                  desktop: ipc.ts services       styr serve: serverHost services
```

## Rules

- **Off by default, two switches, one page.** Settings → Connections → "Allow devices on your
  network to connect" starts the listener; each workspace then opts in with `remoteAccess` (a
  workspace setting, default `false`), switched on the same page under Shared workspaces. Neither
  alone exposes a workspace. There is nothing else to set up: no address to pick, no port to type.
  The flag is ignored for an ssh remote workspace's stub; such a workspace's own Settings → Remote
  access page (`remoteOnly`, shown only while a remote workspace is edited) sets the flag on its
  host, for devices paired with that host's `styr serve`.
- **Same network only, enforced in code** (`host/remoteAccess/addresses.ts`, `admitConnection`).
  The listener binds every interface (one dual-stack `::` socket, `0.0.0.0` where IPv6 is off), so
  it follows the computer from one network to the next, and decides per socket, from its local and
  remote address and `os.networkInterfaces()` as they are at that moment, before a byte is read:
  - arrived on a **network card** (Wi-Fi, Ethernet): the peer must be inside that interface's own
    subnet (`cidr`). A router that forwards a port, or routes another subnet in, is refused even
    with a private source address.
  - arrived on a **VPN tunnel** (`utun*`, `tun*`, `wg*`, `zt*`, `tailscale0`, or a Windows adapter
    named Tailscale, WireGuard, ZeroTier): the peer must have a private address, outside every
    network card's subnet (a peer on the Wi-Fi aiming at the VPN address is refused), and a
    Tailscale address when this one is (`tunnelPeerProblem`). A tunnel's peers are not in its
    subnet (Tailscale gives each machine a /32).
  - **loopback** (an ssh tunnel) only from loopback.
  - refused: a public address on either end; 100.64.0.0/10 on a network card (carrier-grade NAT, an
    internet provider's network shared with its other customers; it used to be only a warning); an
    address the computer no longer has (it left that network).

  Private is RFC 1918, 169.254/16, IPv6 unique local (`fc00::/7`) and link-local (`fe80::/10`),
  Tailscale's 100.64/10 and `fd7a:115c:a1e0::/48`, and loopback; a dual-stack socket's
  `::ffff:a.b.c.d` is read as IPv4 first (`normalizeAddress`). The rule runs on `connection` and
  again on `upgrade`. One address may hold at most twice its connection cap in sockets, upgraded or
  not (`guardSockets`, which also gives HTTP the handshake's 10 s to send its headers), and an IPv6
  /64 at most twice its connection cap. Requests
  with `X-Forwarded-For`, `Forwarded`, `X-Real-IP` … are refused (no reverse proxies), and so is
  any request with an `Origin` (a web page cannot be a device). No UPnP, hole punching or relay.

- **The port finds itself.** 7878 by default (`AccessConfig.port`, not in Settings); when it is
  taken the service tries the next nine (`PORT_ATTEMPTS`) and saves the one it got, so a paired
  device finds it there after a restart. `styr serve --port` sets it.
- **An older config reads as off.** A `remote-access.json` with `bindAddress` or `relay` (before
  same-network access, when the listener took one Tailscale address) loads switched off
  (`fromOlderConfig`): on, it would reach every network the computer is on, which the user never
  agreed to. Paired devices stay paired; switching on again writes the new shape.
- **No hub traffic before the handshake.** An unauthenticated peer never reaches `hub.connect`.
  Five failed handshakes from one address in a minute turn that address away (429) for the rest of
  the minute; every refusal is logged. A failure is a refusal, a timeout, a peer that hangs up
  before signing in, or a pairing request left unanswered, so a peer cannot hold slots for free by
  opening and closing. 16 handshakes may be in flight, at most 4 from one address (8 from
  loopback). Failures, handshakes and connections count per address; an IPv6 /64 (`limitKey`)
  also has a shared, larger cap (30 failures a minute, 8 handshakes, 32 connections), so rotating
  addresses buys only so much; an address that signed in within the last day is never turned away
  by its /64's failures or held off by its /64's socket, handshake and connection caps, so a
  neighbour failing or crowding on purpose cannot lock out devices that work. Loopback is not counted as failing (every ssh-tunnelled device shares 127.0.0.1, and
  sign-in is a signature, so there is nothing to guess) and gets a larger connection cap.
- **End to end, and on the network as well.** Every session is protocol 2 (Noise, below), so
  anyone else on the Wi-Fi or the VPN can neither read nor change it, nor sign in without a paired
  key; the same-network rule is the second layer, keeping the port off the internet.
- **Network clients get a narrower API** (`gate.ts`): no desktop-only channels, no `remote:*`,
  `updates:*`, `access:*` or `server:experimental`, no `workspaces:create`, no `server:notify`, and
  `settings:save` only for a shared workspace with the app-level part unchanged. The local window
  and the Unix socket have no policy and are never filtered.
- **One active workspace, shared by all clients.** A device that switches workspace moves the
  desktop window too, as another window would. It sees the active workspace in `workspaces:list`
  (`activeId`, empty when the active one is not shared) and `settings:changed`.

## What Settings warns about

- **Shields Up.** With Tailscale's Shields Up on, nothing connects in over Tailscale and the phone
  only sees a timeout (shown while access is on). `tailscale.ts` runs `tailscale debug prefs` (a child process, never synchronous, trying
  the Mac app's binary when `tailscale` is not on the app's PATH) and reads `ShieldsUp` alone; the
  answer is `AccessState.shieldsUp`. It is asked when Settings → Connections opens
  (`access:checkNetwork`) and when access is switched on, never on a timer.
- **Nothing shared.** `AccessState.workspaces` lists this computer's own workspaces (never a stub)
  and whether each is shared; `workspaceShared` is false while none is, and the page says the
  devices have nothing to open. A switch there calls `access:setShared(id, shared)`, which checks the
  id names a workspace here and not a stub, then saves the flag through `settings:save` (so the hub
  re-checks what devices hold, and every window hears `settings:changed`). The access state is
  re-sent on `settings:changed` / `workspaces:changed`.

## The Connections page

`renderer/components/settings/ConnectionsSection.tsx` and `ConnectDialogs.tsx`; the wording and
choices are pure helpers in `renderer/lib/accessView.ts`.

- **First run.** Off with no device: one card and a Get started button. It opens an intro
  (`ConnectIntroDialog`: what a device can do, that it stays on the network, Later / Get started).
  Get started switches access on, then opens Add device.
- **Add device** (`AddDeviceDialog`). While nothing is shared it first asks what the device may open
  (the open workspace ticked when it is this computer's, `initialShareChoice`; Continue needs at
  least one), so a device never pairs into nothing. Then the QR (`access:pair`), with the start of
  this computer's fingerprint; the code is made only when that step shows. A device that appears in
  `AccessState.devices` while the dialog is open (`newlyPaired`) is shown as connected. The QR
  comes off at its expiry (one timer for that instant) with a New code button, and closing the
  dialog before a device used it withdraws the offer (`access:cancelPair`), however it closes.
- **The page once on:** the switch, a status line (`connectionSummary`), keep-awake; Devices with
  Add device and Remove (confirmed, `access:revoke`); Shared workspaces; Network details (the port,
  the addresses, the fingerprint) folded away.
- **The log names the step.** A refusal says whether sign-in, the pairing code or a late message
  failed, and a handshake that went quiet says whether the device sent no `hello` or hung up after
  the challenge (the key check a phone fails without a word).

## Other computers: the desktop as a device

Settings → Connections → Other computers opens the workspaces another Styr on the same network
shares with this one. This desktop pairs with it exactly as a phone does, and then reaches it as
a remote host (`remote.md`), behind the same Experimental switch (Remote workspaces).

- **Pairing** is by approval only (`requestLanPairing`, `src/host/remote/lanLink.ts`): Add
  computer takes an address (`192.168.1.20`, `studio.local:7878`, `parseTarget`), and the other
  computer's Add device window must be open there. Both screens show the code; this desktop sends
  its own computer name. Allowed there and confirmed here ("Did it show this code?"), it keeps the other computer's fingerprint (the key it was shown),
  the device id it was given and its own Ed25519 key in `~/.styr/lan-hosts.json` (`lanHosts.ts`:
  0600, atomic, the key sealed with the keychain where there is one, `src/main/keychain.ts`).
  Settings never gets a key.
- **The same network, from this side too** (`privateAddress`): a target must be a private
  address, or a name that resolves to one, and the socket goes to that checked address, never to
  the name again. A public address is refused before a packet is sent.
- **A workspace on it** is a stub like an ssh remote's, with `remote.lan = { fingerprint }` and
  `host` only a name for it (`studio-a1b2c3d4e5f60718`: its name and the first 64 bits of its
  fingerprint, the same for all its workspaces; a name another stub already uses is refused, since
  the router keys connections by it), never handed to ssh: Open in VS Code and the editor do
  nothing for such a workspace. The router's connection runs `lanTransport` in
  place of `ssh … serve attach` (`src/main/lanHosts.ts`, `lanTransportFor`): sign in with the
  stored key against the pinned fingerprint, then one sealed message per JSON-RPC line. A host
  that is not the pinned one is refused before anything is sent; a removal there ends it (4403)
  and says so. ssh's actions (inspect, set up, upgrade, stop or start a server) refuse such a host
  (`refuseLan`), and Remote hosts does not list it.
- **What it sees is a device's view**: the other computer's gate applies (only what it shares;
  `server:experimental` and the other desktop-only channels refused, which the router tolerates).
- **Forget** deletes the entry and its key; the workspaces linked to it stay in the switcher,
  offline, until removed.
- Channels (desktop only, never on the channel table): `lan:hosts`, `lan:pair` (with `lan:pairCode`
  broadcast while it waits), `lan:cancelPair`, `lan:boards`, `lan:addWorkspace`, `lan:remove`.

## Known limits

- Any VPN this computer is on counts as its network. On macOS every VPN is a `utun` interface, a
  company's included, so everyone on that VPN can reach the listener and, while Add device is open,
  ask to pair (the person still has to compare the code and allow it). Settings does not list which
  VPNs are in use.
- Most systems accept a packet for any of their addresses on any interface. The rule refuses a peer
  from a network card's subnet aiming at the VPN address, but a tunnel's peers are otherwise taken
  on their private source address (Node cannot say which interface a packet came in on).
- Someone on the network with many addresses (a dozen IPv4 addresses, or several IPv6 /64s) can
  still hold the 16 handshake slots, each address at most 4 (8 from loopback) and each failure
  counted.
- Anyone on the network can close an open Add device window by beginning a request and leaving
  (one code per window, above), or hold it for up to 60 s by asking and not answering. That only
  makes the person make a new code, and the dialog says why.
- A new IPv6 device, one that has not signed in from that address yet, can be kept out for a minute
  at a time by a neighbour in its /64 failing 30 times a minute from rotating addresses.
- A peer on the same network can spend the single-use pairing secret with a bad `pair` message,
  forcing a rescan; anyone who sees the QR during its 2 minutes can pair.
- A router that forwards a port and rewrites the source to its own LAN address (some do, for
  "hairpin" NAT) looks like a peer on the network and passes `admitConnection`; Styr never asks for
  a forward, and the device would still need its paired key.
- Loopback is allowed (for an ssh tunnel), so a local tunnel agent (ngrok, cloudflared) pointed at
  the listener would expose it; devices would still need their key. So are containers and virtual
  machines on this computer (`docker0`, `vEthernet`), whose subnets are this computer's networks.
- A VPN whose adapter has none of the tunnel names and gives each peer a /32 (WireGuard on Windows
  under a custom name) is a network card to the rule, and its peers are refused.
- `styr serve` keeps the host's private key in `remote-access.json` in plaintext (mode 0600). The
  desktop seals it with `safeStorage` (Keychain, DPAPI, libsecret; not Linux's `basic_text`
  fallback) and drops the plaintext. A `styr serve` on the same machine shares the file, so once
  the desktop has sealed the key it cannot sign and says so; the fingerprint is never replaced.
- The key is made the first time the listener comes up, never at startup or to draw Settings
  (`AccessStore.fingerprint()` reads without making one): sealing asks the macOS Keychain on the
  main process, which blocked v0.42.0's start-up before its window on the release runner.

## Files

- `src/host/channelTable.ts`: the shared channel table (see `remote.md`).
- `src/host/remoteAccess/addresses.ts`: the private ranges, `admitConnection` (the same-network
  rule), `reachableAddresses` (what Settings shows and the QR carries), the proxy-header list.
- `src/host/remoteAccess/accessStore.ts`: `~/.styr/remote-access.json` (mode 0600, written
  atomically): the listener's settings, the devices' public keys, this install's Ed25519 key pair and
  the in-memory pairing offer. Not in `Settings`: those reach the renderer and the clients.
- `src/host/remoteAccess/handshake.ts`: the handshake's limits and the Ed25519 key checks the
  protocol shares.
- `src/host/remoteAccess/noise.ts`, `secureSession.ts`, `secureClient.ts`: protocol 2 (below):
  Noise XX (`node:crypto` for X25519 and SHA-256; ChaCha20-Poly1305 from `@noble/ciphers`, since
  Electron's BoringSSL has no such cipher), the host's handshake and `SecureFrameChannel`, and the device's side
  (tests and the transcript vector only; the phone has its own in Dart).
- `src/host/remoteAccess/gate.ts`: `createNetworkPolicy`, the per-client filter the hub applies.
- `src/host/remoteAccess/tailscale.ts`: the Shields Up probe.
- `src/host/remoteAccess/accessService.ts`: what Settings drives: switch on/off, pair, revoke, the
  free port, the keep-awake hold (`keepAwake.ts`). A listener that cannot start (no port free, the
  system refused) leaves the setting off with the reason in `error`; the app carries on.
- `src/server/wsListener.ts`: the WebSocket transport. `networkAccess.ts` wires store + policy +
  service for a host and `forwardToHub` feeds the hub the host's broadcasts. `src/main/networkAccess.ts`
  is the desktop's half (the `access:*` channels, `powerSaveBlocker`, the hub over `ipc.ts`'s table);
  `styr serve --listen [--port <port>] [--pair]` is the server's.

## `styr serve` on a machine with no window (a cloud VM)

`styr serve --listen [--port <port>] [--pair]` listens for devices on the machine's own networks,
under the same rule as the desktop (a cloud VM's devices therefore reach it over a VPN such as
Tailscale). `--listen <address>`, from before, is refused with a message saying so rather than read.
It prints the addresses devices reach it at; `--pair` prints a QR and the URI at start. Later,
without a restart (which would end the agents), on the same machine:

```sh
styr serve pair          # a new QR, 2 minutes, one use
styr serve devices       # id, name, connected / last seen
styr serve revoke <id>   # removes it and ends its connections at once
```

These go over the Unix socket (`access:pair`, `access:devices`, `access:revoke`, answered only
there; the gate refuses `access:*` from devices). The pairing secret is printed to the terminal,
so avoid running `--pair` where a service manager logs stdout; use `styr serve pair` from a shell.
A workspace is shared by `remoteAccess` in its settings: toggle it from a desktop that has the
server as a remote host (the remote workspace's Settings → Remote access) or set it in the
workspace's `settings.json`.

## Pairing and sign-in

Pairing happens once per device. Add device shows a QR for
`styr://pair?v=2&host=…&port=…&hosts=<a,b,…>&fp=<fingerprint>&secret=<secret>&exp=<ms>`. `host` is
the address a device on the same Wi-Fi reaches first; `hosts` is every address of
`reachableAddresses`, best first (network cards, then VPNs, then virtual machines; IPv6 in
brackets), for a device on the computer's VPN. It carries this install's key fingerprint to pin,
and a one-time secret that works for 2 minutes and one attempt (a wrong guess spends it too).
Pairing is refused while nothing is listening, or while the computer is on no network a device
could reach. The device
makes its own Ed25519 key pair and keeps the private key in the platform secure store (Keychain /
Keystore) with the fingerprint; **the private key never reaches the computer**, which stores only
the public key, the device's name and its id. The key has no expiry; app, computer or network
restarts change nothing. It stops working only on Revoke, which also ends that device's live
connections; adding the device again needs a new QR.

### Pairing by approval (no QR)

A device that found the computer on the network (or was given its address) and has no QR asks to
pair. It pins nothing yet (`pinnedFingerprint` is optional for a request alone; it still checks the
host's signature binds its key to this session), and the code both screens show is built in a
fixed order, commit then reveal:

```
C → S  message 3: {type:'request', name, identityKey, signature, commit}   commit = hex SHA-256(Nd)
S → C  sealed {type:'nonce', nonce: b64(Nh)}
C → S  sealed {type:'reveal', nonce: b64(Nd)}           must hash to commit, else 4401
       both: code = approvalCode(h, Nd, Nh)             then the host asks; Allow → paired, ready
```

- **Why commit then reveal.** A code taken from the handshake hash alone can be steered: whoever
  relays between the device and the host writes the host's message 3 last and can vary it (a name,
  an extra key) until the hash gives the device's code, a few seconds' work for six digits. Here
  `Nd` (32 random bytes) is fixed by its commitment before `Nh` is sent, and `Nh` before `Nd` is
  revealed, so a relay cannot try values: one chance in a million per attempt, and each attempt
  needs the person at the host to answer. `approvalCode` is HMAC-SHA256(key = `h`,
  `"styr-noise-approval-v2\n" ‖ Nd ‖ Nh`), first four bytes big-endian mod 10⁶. The request and
  reveal messages are strict: no other keys.
- **One code per window.** A relay playing the device towards the host knows its own `Nd`, so
  once it has `Nh` it can work out the host's code and, if it does not match, hang up before
  revealing and try again, with nothing on the screen. So a request claims the window before it is
  sent `Nh` (`store.claimPairing`): another request in the same window, side by side or after, is
  refused before it learns anything. When the claiming connection ends without Allow (a hang-up, a
  bad reveal, a timeout, Turn down) the listener closes that window, and only that one
  (`store.cancelPairing(claimed)`, so a stale request cannot close a window opened since; nor can
  it reveal, ask or have its answer spend a window other than the one it claimed). The
  dialog says a device began to pair and left, and offers a new code. Every look at a code costs a
  window the person sees close. `styr serve`, which nobody can answer, refuses a request before
  sending anything (`acceptsRequests` off), so its QR stays usable.
- **Only while Add device is open.** The host accepts a request only while a pairing offer is open
  (`store.pairing()`), that is while the Add device window shows; otherwise it closes with 4401
  before anyone is asked, so a stranger on the network cannot put a prompt on the screen. `styr
serve` takes none (`takesRequests` off: nobody is there to answer).
- **The prompt** shows the device's name cleaned of controls, bidi overrides and zero-width marks,
  whitespace collapsed, at most 100 characters (`deviceDisplayName`; also what is stored and
  logged), its address and the code, with Turn down / Allow (`AccessState.request`,
  `access:answer`).
- **Waiting.** The listener holds the connection (`phase: 'approval'`): nothing reaches the hub and
  nothing is sent until the answer; anything the device sends meanwhile ends it (4401). One request
  waits at a time (another gets 4429); it is withdrawn when the device leaves, after 60 s
  (`APPROVAL_TIMEOUT_MS`, 4408), or turned down when the window closes or access goes off. An answer
  for a request no longer waiting throws, so a stale click allows nothing. A request left
  unanswered, or a device that hangs up, counts as a failed attempt for its address.
- **The answer spends the window**, as a QR attempt spends its secret: allowed, the device is added
  and gets `paired` then `ready`; turned down, it gets 4401 and counts as a failed attempt.
- **Both sides confirm.** The host's Allow proves nothing to the device: whoever answered at that
  address could be anyone running a listener that allows everything. So a device keeps the pairing
  (the key it was shown, its device id) only once it got `paired` **and** the person at the device
  says the code matched. The desktop (Other computers) asks "Did it show this code?" and writes
  nothing before a yes (`lan:confirmPair`); a phone must do the same.

## The session: protocol 2, end to end

Every connection is end-to-end encrypted with
`Noise_XX_25519_ChaChaPoly_SHA256` (`noise.ts`, checked against the official vector in
`noiseXX.vector.json`; `secureSession.ts` the host's side). There is no other protocol: the
plain handshake of earlier versions is gone, and anything but a protocol-2 hello (an old one
included) is closed with 4401 without an answer, so nothing can downgrade a session. At most
2 KiB per handshake frame and 10 seconds until `ready`.

Text frames, each one Noise message in strict, padded base64. Prologue `styr-noise-v1`.

```
C → S  {"type":"hello","protocol":2,"noise":b64(-> e)}                  empty payload
S → C  b64(<- e, ee, s, es, payload)   payload = JSON {identityKey, signature}
C → S  b64(-> s, se, payload)          payload = JSON {type:'auth', deviceId, signature}
                                              or {type:'pair', name, identityKey, signature, proof}
                                              or {type:'request', name, identityKey, signature}
S → C  sealed {type:'paired', deviceId}  (pairing only), then sealed {type:'ready'}
       then JSON-RPC, one message per sealed message           any refusal: close 4401, nothing sent
```

- **Static keys** are X25519 and made per connection. Identity is still the Ed25519 key:
  `signature` is Ed25519 (base64, 64 bytes) over `label ‖ sender's Noise static key (32 bytes) ‖
h`, where `label` is `"styr-noise-host-v1\n"` for the host and `"styr-noise-device-v1\n"` for the
  device, and `h` is the handshake hash just before that payload is encrypted. `identityKey` is
  SPKI DER (44 bytes), base64. Every base64 field is strict and padded.
- **The device checks the host first:** SHA-256(`identityKey`) must be the QR's fingerprint and the
  signature must verify over the static key Noise just delivered. Otherwise it closes without
  writing message 3, so an impostor on the network learns nothing about the device.
- **Sign-in:** the host verifies `signature` with the stored key for `deviceId` (a dummy key for an
  unknown one, so a miss costs the same). **Pairing:** `proof` = hex HMAC-SHA256(key = the QR's
  secret, utf-8; `"styr-noise-pair-v1\n" ‖ h ‖ "\n" + name + "\n" + identityKey`), and the
  signature must be by `identityKey`. `h` covers both ephemeral and both static keys, so a machine
  in the middle running a handshake with each side cannot carry a proof from one to the other; the secret never
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

Nothing a passive listener captures can be replayed or read: the sign-in signature and the
pairing proof are bound to this connection's handshake hash, the secret and the device's private
key never travel, and after `ready` every message is sealed. A host that does not hold the pinned
key fails the device's check, so the device sends nothing to an impostor. After `ready` the session
is `remote.md`'s protocol, starting with `server:hello`; `docs/protocol/styr-remote.schema.json`
lists the handshake messages, the channels and their argument schemas, generated from the zod
schemas (`protocolSchema.ts`; `UPDATE_PROTOCOL_SCHEMA=1 yarn vitest run
src/server/protocolSchema.test.ts` rewrites it, and the test fails when it is stale).

Differences from the Unix socket: one JSON-RPC message per sealed message (no newline needed), a
message over 8 MiB closes the connection, a client more than 32 MiB behind is dropped, and a
device that misses a liveness ping is dropped (it reconnects, reattaches, and gets the terminal
backlog as always). Close codes: 4400 bad request (and any frame that fails to decrypt), 4401
unauthorized, 4403 revoked, 4408 handshake timeout. A refusal by the gate is JSON-RPC error
`-32001`.

**What the device must do itself** (the host cannot enforce it): never speak anything but
protocol 2, whatever the other end answers; reject an all-zero X25519 result (small-order key), as
`noise.ts` does; send no JSON-RPC before `ready`; end the session on any failed frame.

**What someone else on the network still learns:** that a device connects when, each message's
length (there is no padding), that a session is a pairing (message 3's size and the `paired`
record), and the host's identity key, by running a handshake with it. Anyone on the network while
a QR is open can spend it with one bad attempt, forcing a rescan.

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
drop, downgrade, wrong host, a machine in the middle that cannot pair; the transcript vector),
`server/wsListener.secure.test.ts` (protocol 2 over the socket),
`server/wsListener.test.ts` (hostile input: bad handshakes, binary and oversized frames, proxy
headers, origins, rate limiting, leakage on every broadcast kind), `server/networkAccess.test.ts`
(off by default opens no port; pair once, reconnect across a restart, revoke),
`server/network.integration.test.ts` (the built `styr serve --listen` with a paired device).
`host/remoteAccess/addresses.test.ts` holds the same-network rule's cases (the same Wi-Fi, a VPN,
loopback, a routed or forwarded private address, carrier-grade NAT on a network card, an address
the computer left), and `server/wsListener.test.ts` that a refused socket gets no byte back and
never reaches the handshake.
`server/lanLink.test.ts` holds the desktop-as-device side against a real host: pairing by approval
(allowed, turned down, no window open), `RemoteConnection` over `lanTransport` seeing only what is
shared, a host that is not the pinned one, removal; and `privateAddress`, `parseTarget` and the
`lanHosts` store (sealed key, 0600, move, forget).
