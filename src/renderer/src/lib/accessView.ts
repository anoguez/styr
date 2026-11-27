import type {
  AccessDevice,
  AccessInterface,
  AccessState,
  AccessWorkspace,
  LanHostInfo,
  RemoteState,
  WorkspaceOverview
} from '@core/types.js'

/**
 * How Settings → Connections reads (`docs/architecture/remote-access.md`). Pure, so the wording
 * and the QR geometry are tested without a window.
 */

const KIND_LABEL: Record<AccessInterface['kind'], string> = {
  loopback: 'this computer only',
  lan: 'local network',
  tailscale: 'VPN'
}

export function interfaceLabel(choice: AccessInterface): string {
  const family = choice.address.includes(':') ? ' IPv6' : ''
  return `${choice.address} · ${choice.name} · ${KIND_LABEL[choice.kind]}${family}`
}

/** Shown while Tailscale's Shields Up is on: devices cannot connect in, whatever Styr does. */
export const SHIELDS_UP_WARNING =
  'Tailscale Shields Up is on, so this computer blocks incoming connections from your devices: pairing and sign-in time out. In Tailscale, turn on Allow incoming connections (or run tailscale set --shields-up=false), then pair again.'

/** Shields Up matters only while devices may connect: it blocks them over Tailscale. */
export function showShieldsUpWarning(state: Pick<AccessState, 'shieldsUp' | 'enabled'>): boolean {
  return state.shieldsUp === true && state.enabled
}

/** A device is paired but no workspace is shared, so it has nothing to open. */
export function needsSharedWorkspace(
  state: Pick<AccessState, 'devices' | 'workspaceShared'>
): boolean {
  return state.devices.length > 0 && !state.workspaceShared
}

/** A fingerprint in groups of four, so two can be compared by eye. */
export function groupedFingerprint(fingerprint: string): string {
  return (fingerprint.match(/.{1,4}/g) ?? []).slice(0, 8).join(' ')
}

/**
 * Where a pasted or clicked pair link leads, to show before Connect: the address a device tries
 * first, the port and the start of the fingerprint it pins. Undefined for anything that is not a
 * complete link (the main process reads it strictly when pairing, `parsePairLink`).
 */
export function pairLinkSummary(text: string): string | undefined {
  const value = text.trim()
  if (!/^styr:\/\/pair\b/i.test(value)) return undefined
  let params: URLSearchParams
  try {
    params = new URL(value).searchParams
  } catch {
    return undefined
  }
  const host = params.get('host') ?? ''
  const port = params.get('port') ?? ''
  const fingerprint = params.get('fp') ?? ''
  if (!host || !/^\d{1,5}$/.test(port) || !/^[0-9a-f]{64}$/.test(fingerprint)) return undefined
  const short = groupedFingerprint(fingerprint).split(' ').slice(0, 2).join(' ')
  return `${host}:${port} · fingerprint ${short}`
}

function when(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (Number.isNaN(minutes)) return ''
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`
  return `${Math.round(minutes / 60 / 24)} d ago`
}

export function deviceLine(device: AccessDevice, now: number): string {
  const seen = device.connected
    ? 'Connected'
    : device.lastSeenAt
      ? `Last seen ${when(device.lastSeenAt, now)}`
      : 'Never connected'
  return `${seen} · paired ${when(device.createdAt, now)}`
}

/** One SVG path for the dark modules, with a quiet zone of `quiet` modules around the code. */
export function qrPath(modules: boolean[][], quiet = 4): { path: string; size: number } {
  const size = modules.length + quiet * 2
  const runs: string[] = []
  modules.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      if (!row[x]) {
        x++
        continue
      }
      const start = x
      while (x < row.length && row[x]) x++
      runs.push(`M${start + quiet} ${y + quiet}h${x - start}v1h-${x - start}z`)
    }
  })
  return { path: runs.join(''), size }
}

/** What the switch is doing, for the line under it. */
export function listenerStatus(state: AccessState): string {
  if (state.listening) {
    if (state.interfaces.length === 0) {
      return 'On, but this computer is on no network a device could reach. Connect it to Wi-Fi, Ethernet or a VPN.'
    }
    return 'Only devices you pair can sign in. Quitting Styr, or this computer sleeping, ends their connections.'
  }
  return 'Off. No port is open.'
}

/** The device that paired while the Add device dialog was open: one whose id was not there before. */
export function newlyPaired(
  before: ReadonlySet<string>,
  devices: readonly AccessDevice[]
): AccessDevice | undefined {
  return devices.find((device) => !before.has(device.id))
}

/**
 * What the Add device dialog offers to share before showing the QR: the workspaces already shared,
 * or, when none is, the open one (if it is this computer's). The user confirms the choice; nothing
 * is shared without it.
 */
export function initialShareChoice(
  workspaces: readonly AccessWorkspace[],
  openId: string
): Set<string> {
  const shared = workspaces.filter((entry) => entry.shared).map((entry) => entry.id)
  if (shared.length > 0) return new Set(shared)
  return new Set(workspaces.some((entry) => entry.id === openId) ? [openId] : [])
}

/** The line beside the page's title: off, waiting, or who is connected. */
export function connectionSummary(
  state: Pick<AccessState, 'enabled' | 'listening' | 'devices'>
): string {
  if (!state.enabled) return 'Off'
  if (!state.listening) return 'Not listening'
  const connected = state.devices.filter((device) => device.connected).length
  if (connected > 0) return `${connected} ${connected === 1 ? 'device' : 'devices'} connected`
  const paired = state.devices.length
  return paired === 0 ? 'On · no devices yet' : `On · ${paired} paired`
}

/** Six digits as two groups of three, easier to compare at a glance: `482 915`. */
export function groupedCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code
}

/**
 * A paired computer's line under Other computers: whether this desktop is connected to it now,
 * from the remote router's state of the host its workspaces link to.
 */
export function lanHostStatus(
  host: LanHostInfo,
  overview: WorkspaceOverview,
  remote: RemoteState
): { connected: boolean; text: string } {
  const stubs = overview.workspaces.filter(
    (workspace) => workspace.remote?.lan?.fingerprint === host.fingerprint
  )
  if (stubs.length === 0) return { connected: false, text: 'Paired · no workspace open here' }
  const state = remote.hosts.find((entry) => entry.host === stubs[0]!.remote!.host)
  const count = `${stubs.length} workspace${stubs.length === 1 ? '' : 's'}`
  switch (state?.status) {
    case 'connected':
      return { connected: true, text: `Connected · ${count}` }
    case 'connecting':
      return { connected: false, text: `Connecting… · ${count}` }
    case 'reconnecting':
      return {
        connected: false,
        text: `Unreachable${state.lastError ? `: ${state.lastError}` : ''} · ${count}`
      }
    case 'incompatible':
      return { connected: false, text: `Runs another version of Styr · ${count}` }
    default:
      return { connected: false, text: `Offline · ${count}` }
  }
}
