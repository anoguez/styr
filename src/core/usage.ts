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

/** "2h 14m", "38m" or "<1m" until `resetsAt`; null when there is no time or it has passed. */
export function resetsIn(resetsAt: string | undefined, now: number): string | null {
  if (!resetsAt) return null
  const ms = Date.parse(resetsAt) - now
  if (!Number.isFinite(ms) || ms <= 0) return null
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '<1m'
  const hours = Math.floor(minutes / 60)
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

/**
 * The newest reading in a Codex rollout (`~/.codex/sessions/**\/rollout-*.jsonl`): its last
 * `token_count` event carries both the account's rate-limit windows and this thread's context
 * fill. Windows are named by length, since Codex calls them primary and secondary. Context is the
 * last response's tokens over the model's window, which is what the TUI's own meter approximates.
 * Takes the tail of a file, so a first line cut mid-way is skipped like any unparseable one.
 */
export function parseCodexRollout(
  text: string
): { usage: ProviderUsage | null; context: ContextUsage | null } | null {
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!
    if (!line.includes('"token_count"')) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const at = (event as { timestamp?: unknown }).timestamp
    const payload = (event as { payload?: Record<string, unknown> }).payload
    if (!payload || payload.type !== 'token_count') continue

    const windows: UsageWindow[] = []
    const limits = payload.rate_limits as Record<string, unknown> | null | undefined
    for (const name of ['primary', 'secondary']) {
      const entry = limits?.[name] as Record<string, unknown> | null | undefined
      if (!entry || typeof entry.used_percent !== 'number') continue
      const kind =
        entry.window_minutes === 300
          ? 'five_hour'
          : entry.window_minutes === 10080
            ? 'seven_day'
            : null
      if (!kind) continue
      windows.push({
        kind,
        percentUsed: entry.used_percent,
        ...(typeof entry.resets_at === 'number'
          ? { resetsAt: new Date(entry.resets_at * 1000).toISOString() }
          : {})
      })
    }

    const info = payload.info as Record<string, unknown> | null | undefined
    const last = info?.last_token_usage as Record<string, unknown> | undefined
    const window = info?.model_context_window
    let context: ContextUsage | null = null
    if (typeof last?.total_tokens === 'number' && typeof window === 'number' && window > 0) {
      context = {
        percent: Math.min(100, Math.round((last.total_tokens / window) * 100)),
        tokens: last.total_tokens,
        window
      }
    }
    return {
      usage: windows.length > 0 ? { windows, at: typeof at === 'string' ? at : '' } : null,
      context
    }
  }
  return null
}
