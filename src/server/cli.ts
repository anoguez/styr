/** What `styr serve …` was asked to do. */
export type ServerCommand =
  | { command: 'serve'; socket?: string; listen?: ListenSpec; pair?: boolean }
  | { command: 'attach'; socket?: string }
  | { command: 'pair'; socket?: string }
  | { command: 'devices'; socket?: string }
  | { command: 'revoke'; socket?: string; id: string }
  | { command: 'version' }
  | { command: 'help' }
  | { command: 'invalid'; message: string }

/** `--listen [--port <port>]`: devices on this machine's networks reach it (`remote-access.md`). */
export interface ListenSpec {
  port: number
}

export const DEFAULT_LISTEN_PORT = 7878

const LISTEN_CHANGED =
  "--listen no longer takes an address: devices on any of this machine's private networks " +
  '(its LAN, or a VPN such as Tailscale) can connect. Use --listen, and --port <port> to change ' +
  'the port.'

export const USAGE = `Usage:
  styr serve [--socket <path>]          Run the headless Styr server
  styr serve --listen [--port <port>] [--pair]
                                        Also accept paired devices on this machine's own
                                        networks (its LAN, or a VPN such as Tailscale), never
                                        the internet; port 7878 by default. --pair prints a
                                        QR to pair a device with
  styr serve attach [--socket <path>]   Pipe stdio to the running server (what ssh runs)
  styr serve pair [--socket <path>]     Show a QR to pair another device with the running server
  styr serve devices [--socket <path>]  List the paired devices
  styr serve revoke <id> [--socket <path>]
                                        Remove a paired device and end its connections
  styr serve --version                  Print the server's version

Devices see only the workspaces that have "Allow remote clients" switched on in their settings.
The socket defaults to ~/.styr/server.sock ($STYR_HOME/server.sock), or $STYR_SERVER_SOCKET.`

/**
 * Parses the server's arguments: `serve`, then an optional `attach`, then `--socket <path>`.
 * The leading `serve` is optional, so the entry also runs as `node out/server/index.mjs attach`.
 */
export function parseServerArgs(argv: string[]): ServerCommand {
  const args = argv[0] === 'serve' ? argv.slice(1) : [...argv]
  let command: 'serve' | 'attach' | 'pair' | 'devices' | 'revoke' = 'serve'
  let id: string | undefined
  let socket: string | undefined
  let listen = false
  let port: number | undefined
  let pair = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if ((arg === 'attach' || arg === 'pair' || arg === 'devices') && i === 0) command = arg
    else if (arg === 'revoke' && i === 0) {
      command = 'revoke'
      id = args[++i]
      if (!id) return { command: 'invalid', message: 'revoke needs a device id' }
    } else if (arg === '--version' || arg === '-v') return { command: 'version' }
    else if (arg === '--help' || arg === '-h') return { command: 'help' }
    else if (arg === '--socket') {
      const value = args[++i]
      if (!value) return { command: 'invalid', message: '--socket needs a path' }
      socket = value
    } else if (arg.startsWith('--socket=')) socket = arg.slice('--socket='.length)
    else if (arg === '--pair') pair = true
    else if (arg === '--listen') {
      // `--listen <address>` from before: say what changed rather than read the address as junk.
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('-'))
        return { command: 'invalid', message: LISTEN_CHANGED }
      listen = true
    } else if (arg.startsWith('--listen=')) return { command: 'invalid', message: LISTEN_CHANGED }
    else if (arg === '--port' || arg.startsWith('--port=')) {
      const value = arg === '--port' ? args[++i] : arg.slice('--port='.length)
      const parsed = /^\d{1,5}$/.test(value ?? '') ? Number(value) : NaN
      if (!(parsed >= 1024 && parsed <= 65535)) {
        return { command: 'invalid', message: '--port needs a port from 1024 to 65535' }
      }
      port = parsed
    } else return { command: 'invalid', message: `Unknown argument: ${arg}` }
  }
  if (pair && !listen) return { command: 'invalid', message: '--pair needs --listen' }
  if (port !== undefined && !listen) return { command: 'invalid', message: '--port needs --listen' }
  if (command !== 'serve' && (listen || pair)) {
    return { command: 'invalid', message: `${command} takes only --socket` }
  }
  if (command === 'revoke') return { command, id: id!, ...(socket ? { socket } : {}) }
  return {
    command,
    ...(socket ? { socket } : {}),
    ...(listen ? { listen: { port: port ?? DEFAULT_LISTEN_PORT } } : {}),
    ...(pair ? { pair } : {})
  } as ServerCommand
}
