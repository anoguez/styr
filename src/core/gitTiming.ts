import type { SlowGitCall } from './diagnostics.js'

/** A git call at least this slow is kept for the Performance panel. */
export const SLOW_GIT_MS = 100

const KEPT = 50
const slow: SlowGitCall[] = []

/**
 * Records one git call's duration; only slow ones are kept, newest last. Memory-only and cheap (the
 * caller reads the clock twice), so it is always on. `blocking` is a synchronous call, which held
 * the main thread for its whole duration.
 */
export function recordGitCall(
  args: readonly string[],
  cwd: string,
  ms: number,
  blocking: boolean
): void {
  if (ms < SLOW_GIT_MS) return
  slow.push({
    command: `git ${args.join(' ')}`,
    folder: cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd,
    ms: Math.round(ms),
    blocking,
    at: new Date().toISOString()
  })
  if (slow.length > KEPT) slow.shift()
}

export function slowGitCalls(): SlowGitCall[] {
  return [...slow]
}

/** Tests only. */
export function clearSlowGitCalls(): void {
  slow.length = 0
}
