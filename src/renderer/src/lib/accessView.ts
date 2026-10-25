import type { AccessDevice, AccessInterface, AccessState } from '@core/types.js'

/**
 * How Settings → Remote access reads (`docs/architecture/remote-access.md`). Pure, so the wording
 * and the QR geometry are tested without a window.
 */

const KIND_LABEL: Record<AccessInterface['kind'], string> = {
  loopback: 'this computer only',
  tailscale: 'Tailscale'
}

export function interfaceLabel(choice: AccessInterface): string {
  return `${choice.address} · ${choice.name} · ${KIND_LABEL[choice.kind]}`
}

/** The interfaces to offer: the saved address stays in the list, marked, when it has gone away. */
export function interfaceOptions(
  state: Pick<AccessState, 'interfaces' | 'bindAddress'>
): { value: string; label: string }[] {
  const options = state.interfaces.map((choice) => ({
    value: choice.address,
    label: interfaceLabel(choice)
  }))
  if (
    state.bindAddress &&
    !state.interfaces.some((choice) => choice.address === state.bindAddress)
  ) {
    options.push({ value: state.bindAddress, label: `${state.bindAddress} · not available now` })
  }
  return options
}

/** A fingerprint in groups of four, so two can be compared by eye. */
export function groupedFingerprint(fingerprint: string): string {
  return (fingerprint.match(/.{1,4}/g) ?? []).slice(0, 8).join(' ')
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

/** Why the listener is not up, or what it is doing, for the line under the switch. */
export function listenerStatus(state: AccessState): string {
  if (state.listening) {
    return `Listening on ${state.bindAddress}:${state.port}. Only devices you paired can sign in.`
  }
  if (!state.bindAddress) return 'Pick a network interface to listen on.'
  return 'Not listening. No port is open.'
}
