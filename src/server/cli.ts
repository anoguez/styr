/** What `styr serve …` was asked to do. */
export type ServerCommand =
  | { command: 'serve'; socket?: string }
  | { command: 'attach'; socket?: string }
  | { command: 'version' }
  | { command: 'help' }
  | { command: 'invalid'; message: string }

export const USAGE = `Usage:
  styr serve [--socket <path>]          Run the headless Styr server
  styr serve attach [--socket <path>]   Pipe stdio to the running server (what ssh runs)
  styr serve --version                  Print the server's version

The socket defaults to ~/.styr/server.sock ($STYR_HOME/server.sock), or $STYR_SERVER_SOCKET.`

/**
 * Parses the server's arguments: `serve`, then an optional `attach`, then `--socket <path>`.
 * The leading `serve` is optional, so the entry also runs as `node out/server/index.mjs attach`.
 */
export function parseServerArgs(argv: string[]): ServerCommand {
  const args = argv[0] === 'serve' ? argv.slice(1) : [...argv]
  let command: 'serve' | 'attach' = 'serve'
  let socket: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === 'attach' && i === 0) command = 'attach'
    else if (arg === '--version' || arg === '-v') return { command: 'version' }
    else if (arg === '--help' || arg === '-h') return { command: 'help' }
    else if (arg === '--socket') {
      const value = args[++i]
      if (!value) return { command: 'invalid', message: '--socket needs a path' }
      socket = value
    } else if (arg.startsWith('--socket=')) socket = arg.slice('--socket='.length)
    else return { command: 'invalid', message: `Unknown argument: ${arg}` }
  }
  return socket ? { command, socket } : { command }
}
