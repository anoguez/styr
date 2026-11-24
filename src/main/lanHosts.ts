import { join } from 'node:path'
import { configDir } from '@core/config.js'
import type { RemoteWorkspaceLink } from '@core/types.js'
import type { TransportChild } from '@host/remote/connection.js'
import { createLanHosts, type LanHosts } from '@host/remote/lanHosts.js'
import { lanTransport } from '@host/remote/lanLink.js'
import { keychain } from './keychain.js'

/**
 * The other computers this desktop paired with (`src/host/remote/lanHosts.ts`), with their keys
 * sealed in the OS keychain, and the transport the remote router runs for a workspace on one.
 */
let store: LanHosts | undefined
export function lanHosts(): LanHosts {
  store ??= createLanHosts({
    path: join(configDir(), 'lan-hosts.json'),
    now: Date.now,
    secrets: keychain
  })
  return store
}

/** A transport that ends at once, saying why: the router shows it as the host's error. */
function failed(message: string): TransportChild {
  const exits: ((code: number | null) => void)[] = []
  const errors: ((chunk: string) => void)[] = []
  setTimeout(() => {
    for (const listener of errors) listener(`${message}\n`)
    for (const listener of exits) listener(1)
  }, 0)
  return {
    write: () => undefined,
    onStdout: () => undefined,
    onStderr: (listener) => errors.push(listener as (chunk: string) => void),
    onExit: (listener) => exits.push(listener),
    kill: () => undefined
  }
}

/** The LAN transport for a stub that names another computer by its fingerprint. */
export function lanTransportFor(link: RemoteWorkspaceLink): TransportChild {
  const fingerprint = link.lan!.fingerprint
  try {
    const credentials = lanHosts().credentials(fingerprint)
    const name = lanHosts().get(fingerprint)?.name ?? link.host
    if (!credentials) {
      return failed(
        `${name} is not paired with this computer any more. Add it again in Settings → Connections.`
      )
    }
    return lanTransport(credentials, name)
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  }
}
