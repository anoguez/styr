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

/** `--listen <address>[:port]`: where devices reach this server (`remote-access.md`). */
export interface ListenSpec {
  address: string
  port: number
}

export const DEFAULT_LISTEN_PORT = 7878

export const USAGE = `Usage:
  styr serve [--socket <path>]          Run the headless Styr server
  styr serve --listen <address>[:port] [--pair]
                                        Also accept paired devices over WebSocket on one
                                        private address (loopback, LAN or Tailscale); --pair
                                        prints a QR to pair a device with
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
  let listen: ListenSpec | undefined
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
    else if (arg === '--listen' || arg.startsWith('--listen=')) {
      const value = arg === '--listen' ? args[++i] : arg.slice('--listen='.length)
      const spec = value ? parseListen(value) : undefined
      if (!spec) return { command: 'invalid', message: '--listen needs <address>[:port]' }
      listen = spec
    } else return { command: 'invalid', message: `Unknown argument: ${arg}` }
  }
  if (pair && !listen) return { command: 'invalid', message: '--pair needs --listen' }
  if (command !== 'serve' && (listen || pair)) {
    return { command: 'invalid', message: `${command} takes only --socket` }
  }
  if (command === 'revoke') return { command, id: id!, ...(socket ? { socket } : {}) }
  return {
    command,
    ...(socket ? { socket } : {}),
    ...(listen ? { listen } : {}),
    ...(pair ? { pair } : {})
  } as ServerCommand
}

/** `192.168.1.5`, `192.168.1.5:7878`, `[fd7a::1]:7878` or `fd7a::1`. */
export function parseListen(value: string): ListenSpec | undefined {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value)
  const ipv4 = /^([^:]+)(?::(\d+))?$/.exec(value)
  const match = bracketed ?? ipv4
  const address = match?.[1] ?? (value.includes(':') ? value : undefined)
  if (!address) return undefined
  const port = match?.[2] ? Number(match[2]) : DEFAULT_LISTEN_PORT
  return { address, port }
}
