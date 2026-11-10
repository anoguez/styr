import { DEFAULT_RELAY_PORT, normaliseFingerprint } from '@host/remoteAccess/relayProtocol.js'
import { parseListen, type ListenSpec } from '../cli.js'

/** What `styr relay …` was asked to do. */
export type RelayCommand =
  | { command: 'run'; listen: ListenSpec; socket?: string }
  | { command: 'allow' | 'revoke'; fingerprint: string; socket?: string }
  | { command: 'hosts'; socket?: string }
  | { command: 'help' }
  | { command: 'invalid'; message: string }

export const RELAY_USAGE = `Usage:
  styr relay --listen <address>[:port] [--socket <path>]
                                        Forward phones to hosts that cannot accept connections,
                                        listening on one Tailscale or loopback address (port ${DEFAULT_RELAY_PORT})
  styr relay allow <fingerprint> [--socket <path>]
                                        Let the host with this key fingerprint register
                                        (Settings → Remote devices shows it)
  styr relay hosts [--socket <path>]    List the allowed hosts and whether they are connected
  styr relay revoke <fingerprint> [--socket <path>]
                                        Remove a host and end its sessions

allow, hosts and revoke talk to the running relay. The socket defaults to ~/.styr/relay.sock
($STYR_HOME/relay.sock), or $STYR_RELAY_SOCKET; the allow list is ~/.styr/relay.json.`

/** Parses the arguments after `relay`. */
export function parseRelayArgs(args: string[]): RelayCommand {
  let command: 'run' | 'allow' | 'hosts' | 'revoke' = 'run'
  let fingerprint: string | undefined
  let socket: string | undefined
  let listen: ListenSpec | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === 'hosts' && i === 0) command = arg
    else if ((arg === 'allow' || arg === 'revoke') && i === 0) {
      command = arg
      const value = args[++i]
      if (!value) return { command: 'invalid', message: `${arg} needs a host fingerprint` }
      fingerprint = normaliseFingerprint(value)
      if (!fingerprint) {
        return { command: 'invalid', message: `${value} is not a host fingerprint (64 hex digits)` }
      }
    } else if (arg === '--help' || arg === '-h') return { command: 'help' }
    else if (arg === '--socket' || arg.startsWith('--socket=')) {
      const value = arg === '--socket' ? args[++i] : arg.slice('--socket='.length)
      if (!value) return { command: 'invalid', message: '--socket needs a path' }
      socket = value
    } else if (arg === '--listen' || arg.startsWith('--listen=')) {
      const value = arg === '--listen' ? args[++i] : arg.slice('--listen='.length)
      const spec = value ? parseListen(value, DEFAULT_RELAY_PORT) : undefined
      if (!spec) return { command: 'invalid', message: '--listen needs <address>[:port]' }
      listen = spec
    } else return { command: 'invalid', message: `Unknown argument: ${arg}` }
  }
  const withSocket = socket ? { socket } : {}
  if (command === 'run') {
    if (!listen) {
      return { command: 'invalid', message: 'styr relay needs --listen <address>[:port]' }
    }
    return { command, listen, ...withSocket }
  }
  if (listen) return { command: 'invalid', message: `${command} takes only --socket` }
  if (command === 'hosts') return { command, ...withSocket }
  return { command, fingerprint: fingerprint!, ...withSocket }
}
