/**
 * The routing tables of the remote router (`router.ts`): where each IPC channel goes and how it
 * behaves while a remote board is not live. Every call table is derived from the one catalog
 * (`core/channelCatalog.ts`), so a new channel is classified by one entry there, and
 * `channels.test.ts` checks every channel the server answers has a route.
 */
import {
  CHANNEL_CATALOG,
  CHANNEL_SPECS,
  type ChannelRoute,
  type ChannelSpec,
  type OfflineDefault
} from '@core/channelCatalog.js'

export type { ChannelRoute } from '@core/channelCatalog.js'

const channelsWhere = (test: (spec: ChannelSpec) => boolean | undefined): ReadonlySet<string> =>
  new Set(CHANNEL_SPECS.filter(([, spec]) => test(spec)).map(([channel]) => channel))

/** The renderer's board reads and writes: they follow the active workspace. */
export const ACTIVE_CHANNELS = channelsWhere((spec) => spec.route === 'active')

/** Calls about one terminal session, whose id is the first argument: they go where it runs. */
export const SESSION_CHANNELS = channelsWhere((spec) => spec.route === 'session' && !spec.send)

/** One-way calls about one session (`ipcMain.on`), sent where it runs. */
export const SESSION_SENDS = channelsWhere((spec) => spec.route === 'session' && spec.send)

/**
 * Channels the router answers itself: merging local and remote answers, or acting on this
 * machine for a remote path.
 */
export const SPECIAL_CHANNELS = channelsWhere((spec) => spec.route === 'special')

/** Calls that change something. While a remote board is not live they are refused, never queued. */
export const WRITE_CHANNELS = channelsWhere((spec) => spec.write)

/** Reads whose last answer is kept, so a disconnected board stays visible read-only. */
export const SNAPSHOT_CHANNELS = channelsWhere((spec) => spec.snapshot)

const OFFLINE_VALUES: Readonly<Record<OfflineDefault, () => unknown>> = {
  list: () => [],
  none: () => null,
  record: () => ({}),
  off: () => ({ on: false })
}

/** What a read answers with when it has no snapshot yet: an empty board, not an error. */
export const OFFLINE_DEFAULTS: Readonly<Record<string, () => unknown>> = Object.fromEntries(
  CHANNEL_SPECS.flatMap(([channel, spec]) =>
    spec.offline ? [[channel, OFFLINE_VALUES[spec.offline]]] : []
  )
)

/** Calls whose result is one new terminal session, which the router tags with its host. */
export const SESSION_RESULT_CHANNELS = channelsWhere((spec) => spec.sessionResult)

/** Board broadcasts: from the local services they are dropped while a remote board is active. */
export const BOARD_BROADCASTS: ReadonlySet<string> = new Set([
  'tasks:changed',
  'agents:changed',
  'orchestrate:autoState',
  'orchestrate:autoStarted',
  'sources:state',
  'usage:claude',
  'review:changed'
])

/** Broadcasts addressed to one terminal session: forwarded from every host. */
export const SESSION_BROADCASTS: ReadonlySet<string> = new Set([
  'terminal:runtimeState',
  'usage:context',
  'agent:conversation'
])

/** Where a channel goes, for the coverage test against the server's table. */
export function channelRoute(channel: string): ChannelRoute {
  return Object.hasOwn(CHANNEL_CATALOG, channel)
    ? CHANNEL_CATALOG[channel as keyof typeof CHANNEL_CATALOG].route
    : 'local'
}
