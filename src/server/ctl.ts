import { connect } from 'node:net'
import { renderUnicodeCompact } from 'uqr'
import type { AccessDevice, AccessPairing } from '@core/types/access.js'
import { RpcPeer } from '@host/rpc/jsonRpc.js'
import type { ServerCommand } from './cli.js'

/** What a running `styr serve --listen` answers on its Unix socket, and no network client can call. */
export const CTL = {
  pair: 'access:pair',
  devices: 'access:devices',
  revoke: 'access:revoke'
} as const

function request(socketPath: string, method: string, params: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    const peer = new RpcPeer((line) => socket.write(line), {})
    socket.on('data', (chunk) => peer.receive(chunk))
    socket.once('error', (error: NodeJS.ErrnoException) =>
      reject(
        new Error(`no Styr server is running on ${socketPath} (${error.code ?? error.message})`)
      )
    )
    socket.once('connect', () => {
      peer
        .request(method, params)
        .then(resolve, reject)
        .finally(() => socket.destroy())
    })
  })
}

/** `styr serve pair | devices | revoke <id>`: talks to the running server. Resolves with the exit code. */
export async function control(
  command: Extract<ServerCommand, { command: 'pair' | 'devices' | 'revoke' }>,
  socketPath: string,
  out: NodeJS.WritableStream,
  errors: NodeJS.WritableStream
): Promise<number> {
  try {
    if (command.command === 'pair') {
      const pairing = (await request(socketPath, CTL.pair, [])) as AccessPairing
      out.write(
        `Scan this with the Styr app within 2 minutes (it works once):\n\n` +
          `${renderUnicodeCompact(pairing.uri, { ecc: 'M' })}\n${pairing.uri}\n`
      )
    } else if (command.command === 'devices') {
      const devices = (await request(socketPath, CTL.devices, [])) as AccessDevice[]
      out.write(
        devices.length === 0
          ? 'No paired devices.\n'
          : devices
              .map(
                (d) =>
                  `${d.id}  ${d.name}  ${d.connected ? 'connected' : `last seen ${d.lastSeenAt ?? 'never'}`}\n`
              )
              .join('')
      )
    } else {
      await request(socketPath, CTL.revoke, [command.id])
      out.write(`Removed ${command.id}; its connections are closed.\n`)
    }
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    errors.write(
      /Method not found|Unknown method/i.test(message)
        ? 'styr: this server is not listening for devices. Start it with --listen <address>.\n'
        : `styr: ${message}\n`
    )
    return 1
  }
}
