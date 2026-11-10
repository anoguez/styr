import { portProblem } from '@host/remoteAccess/addresses.js'
import { listen } from '../socket.js'
import { createAllowList } from './allowList.js'
import { RELAY_USAGE, parseRelayArgs } from './cli.js'
import {
  createRelayControl,
  defaultAllowListPath,
  defaultRelaySocketPath,
  relayControl
} from './control.js'
import { startRelay } from './relay.js'

/**
 * `styr relay …` (`docs/architecture/remote-access.md`, Relay). Runs the relay until SIGTERM or
 * SIGINT, or sends one control call to the running one. Resolves with the exit code.
 */
export async function relayMain(args: string[]): Promise<number> {
  const parsed = parseRelayArgs(args)
  const socketPath = (command: { socket?: string }): string =>
    command.socket ?? process.env.STYR_RELAY_SOCKET ?? defaultRelaySocketPath()

  switch (parsed.command) {
    case 'help':
      process.stdout.write(`${RELAY_USAGE}\n`)
      return 0
    case 'invalid':
      console.error(`styr: ${parsed.message}\n\n${RELAY_USAGE}`)
      return 64
    case 'allow':
    case 'hosts':
    case 'revoke':
      return relayControl(parsed, socketPath(parsed), process.stdout, process.stderr)
    case 'run': {
      const problem = portProblem(parsed.listen.port)
      if (problem) throw new Error(problem)
      const allowList = createAllowList(defaultAllowListPath())
      const log = (message: string): void => void process.stdout.write(`${message}\n`)
      const relay = await startRelay({ allowList, log }, parsed.listen.address, parsed.listen.port)
      const control = await listen(socketPath(parsed), createRelayControl(allowList, relay)).catch(
        async (error: unknown) => {
          await relay.close()
          throw error
        }
      )
      const { address, port } = relay.address
      const host = address.includes(':') ? `[${address}]` : address
      log(
        `Styr relay listening on ws://${host}:${port} (${allowList.list().length} hosts allowed). ` +
          'Allow a host with `styr relay allow <fingerprint>`.'
      )
      process.on('uncaughtException', (error) => console.error('Styr relay:', error))
      process.on('unhandledRejection', (error) => console.error('Styr relay:', error))
      await new Promise<void>((resolve) => {
        const stop = (): void => {
          void control
            .close()
            .then(() => relay.close())
            .finally(resolve)
        }
        process.once('SIGTERM', stop)
        process.once('SIGINT', stop)
      })
      return 0
    }
  }
}
