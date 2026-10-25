/**
 * Failed handshakes per source address. Past `max` failures inside `windowMs`, that address is
 * refused until the oldest failure ages out.
 */
export function createFailureLimiter(options: {
  max: number
  windowMs: number
  now: () => number
}) {
  const failures = new Map<string, number[]>()

  function recent(source: string): number[] {
    const cutoff = options.now() - options.windowMs
    const kept = (failures.get(source) ?? []).filter((at) => at > cutoff)
    if (kept.length) failures.set(source, kept)
    else failures.delete(source)
    return kept
  }

  return {
    blocked: (source: string): boolean => recent(source).length >= options.max,
    fail(source: string): void {
      if (failures.size > 1000) for (const known of [...failures.keys()]) recent(known)
      failures.set(source, [...recent(source), options.now()])
    },
    reset: (source: string): void => void failures.delete(source),
    /** Addresses being tracked, so a long-running listener can see it does not grow. */
    size: (): number => failures.size
  }
}
