/** One rate-limit window of a subscription, as the usage mod records it. */
export interface UsageWindow {
  /** `five_hour`, `seven_day` or a gateway's `spend_limit`. */
  kind: string
  percentUsed: number
  /** ISO 8601. */
  resetsAt?: string
}

export interface ProviderUsage {
  windows: UsageWindow[]
  /** When the mod last wrote the reading (ISO 8601). */
  at: string
}

/**
 * Reads the file `resources/claude/usage-mod` writes. Anything unreadable is null — usage is a
 * convenience, so a half-written or hand-edited file must never surface as an error.
 */
export function parseUsageFile(text: string): ProviderUsage | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const { at, rateLimits } = raw as { at?: unknown; rateLimits?: unknown }
  if (typeof at !== 'string' || !Array.isArray(rateLimits)) return null
  const windows: UsageWindow[] = []
  for (const entry of rateLimits) {
    if (typeof entry !== 'object' || entry === null) continue
    const { kind, percentUsed, resetsAt } = entry as Record<string, unknown>
    if (typeof kind !== 'string' || typeof percentUsed !== 'number') continue
    windows.push({
      kind,
      percentUsed,
      ...(typeof resetsAt === 'string' ? { resetsAt } : {})
    })
  }
  return { windows, at }
}

/**
 * The window to show, or null when there is none worth showing. A window whose reset has passed
 * describes a quota that no longer applies, so it is dropped rather than shown stale.
 */
export function currentWindow(
  usage: ProviderUsage | null,
  kind: string,
  now: number
): UsageWindow | null {
  const found = usage?.windows.find((window) => window.kind === kind)
  if (!found) return null
  if (found.resetsAt && Date.parse(found.resetsAt) <= now) return null
  return found
}

/** How full one session's context window is, as the usage mod records it per terminal. */
export interface ContextUsage {
  /** 0 to 100. */
  percent: number
  tokens?: number
  /** The model's context window, in tokens. */
  window?: number
}

export function parseContextFile(text: string): ContextUsage | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const context = (raw as { context?: unknown }).context
  if (typeof context !== 'object' || context === null) return null
  const { percent, tokens, window } = context as Record<string, unknown>
  if (typeof percent !== 'number') return null
  return {
    percent,
    ...(typeof tokens === 'number' ? { tokens } : {}),
    ...(typeof window === 'number' ? { window } : {})
  }
}
