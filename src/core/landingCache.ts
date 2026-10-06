/**
 * Remembers which tasks were already checked for landing and found nothing to do, so a task-file
 * write does not re-run git for every kept worktree. A task is checked again when its fingerprint
 * (status, worktree and the refs the answer depends on) changes, or when `ttlMs` has passed — the
 * expiry covers what a fingerprint cannot see, such as a dirty worktree being cleaned up.
 */
export class LandingCache {
  private readonly entries = new Map<string, { fingerprint: string; at: number }>()

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now
  ) {}

  /** True when this task was checked with the same fingerprint recently and needed no action. */
  isFresh(key: string, fingerprint: string): boolean {
    const entry = this.entries.get(key)
    return (
      entry !== undefined && entry.fingerprint === fingerprint && this.now() - entry.at < this.ttlMs
    )
  }

  /** Record a check that did nothing. A check that wrote must not be recorded: the next one is needed. */
  remember(key: string, fingerprint: string): void {
    this.entries.set(key, { fingerprint, at: this.now() })
  }

  forget(key: string): void {
    this.entries.delete(key)
  }
}
