import { branchNameFor, type Checkout } from './worktree.js'
import type { CleanupResult, Landing } from './worktreeLanding.js'
import { worktreeKey, type Task, type TaskStatus } from './types.js'

/** git is slow enough (~0.2s a task) that re-checking every kept worktree on each write froze the app. */
export const LANDING_TTL_MS = 5 * 60_000

/**
 * Remembers which tasks were already checked for landing and found nothing to do, so a task-file
 * write does not re-run git for every kept worktree. A task is checked again when its fingerprint
 * (status, worktree and the refs the answer depends on) changes, or when `ttlMs` has passed — the
 * expiry covers what a fingerprint cannot see, such as a dirty worktree being cleaned up.
 */
export class LandingCache {
  private readonly entries = new Map<string, { fingerprint: string; at: number }>()

  constructor(
    private readonly ttlMs: number = LANDING_TTL_MS,
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

/**
 * What a task's landing answer depends on: the tips of its branch and of every ref it could be
 * measured against, picked out of a `refListing`. Equal fingerprints mean `branchLanding` would say
 * the same thing.
 */
export function refsFingerprint(
  listing: string | undefined,
  key: string,
  baseBranch?: string
): string {
  if (listing === undefined) return 'unavailable'
  const names = [baseBranch, 'main', 'master'].filter((name): name is string => Boolean(name))
  const wanted = new Set([
    `refs/heads/${branchNameFor(key)}`,
    'refs/remotes/origin/HEAD',
    ...names.flatMap((name) => [`refs/heads/${name}`, `refs/remotes/origin/${name}`])
  ])
  return listing
    .split('\n')
    .filter((line) => wanted.has(line.split(' ')[0] ?? ''))
    .join('\n')
}

/** True when the latest note by `author` already says `message`, so a retry does not repeat it. */
export function isRepeatNote(
  activity: { author: string; message: string }[],
  author: string,
  message: string
): boolean {
  const last = [...activity].reverse().find((entry) => entry.author === author)
  return last?.message === message
}

/** The git half of the decision, injected so the rules can be tested without a repository. */
export interface LandingGit {
  refListing(repoPath: string): string | undefined
  branchLanding(checkout: Checkout): Landing | undefined
  cleanupLandedTask(checkout: Checkout): CleanupResult
}

export interface LandingPorts {
  git: LandingGit
  /** Lives as long as the process: it is what keeps a write from re-running git for every task. */
  cache: LandingCache
  workspaceId: string
}

export type LandingTask = Pick<
  Task,
  'id' | 'status' | 'useWorktree' | 'repoPath' | 'worktreePath' | 'baseBranch' | 'activity'
>

/** One task-file change the caller performs, in order, through the task store. */
export type LandingWrite =
  | { kind: 'status'; taskId: string; status: TaskStatus }
  | { kind: 'clearWorktree'; taskId: string }
  | { kind: 'note'; taskId: string; message: string }

export interface LandingError {
  taskId: string
  error: unknown
}

export interface LandingOutcome {
  writes: LandingWrite[]
  /**
   * Tasks whose check threw. They are not cached, so the next pass retries them; the caller reports
   * them rather than letting a git failure vanish or break a refresh.
   */
  errors: LandingError[]
}

/**
 * Keeps the board honest about merges without asking any host. An In Review task whose branch has
 * landed on the base moves to Done, and a Done task's worktree and branches are removed. Returns
 * the task-file writes to perform; git side effects (the cleanup) happen through `ports.git`.
 *
 * Tasks without a worktree are skipped: with no `styr/<id>` branch there is nothing to compare or
 * delete, and the work lives in the user's own checkout.
 */
export function settleTasks(tasks: readonly LandingTask[], ports: LandingPorts): LandingOutcome {
  const { git, cache, workspaceId } = ports
  const writes: LandingWrite[] = []
  const errors: LandingError[] = []
  // One ref listing per repository per pass, not one per task.
  const listings = new Map<string, string | undefined>()
  const listingFor = (path: string): string | undefined => {
    if (!listings.has(path)) listings.set(path, git.refListing(path))
    return listings.get(path)
  }

  for (const task of tasks) {
    const { repoPath } = task
    if (!task.useWorktree || !repoPath) continue
    if (task.status !== 'in_review' && !(task.status === 'done' && task.worktreePath)) continue
    const key = worktreeKey(workspaceId, task.id)
    const cacheKey = `${workspaceId}:${task.id}`
    const taskWrites: LandingWrite[] = []
    try {
      const refs = refsFingerprint(listingFor(repoPath), key, task.baseBranch)
      const fingerprint = `${task.status}|${task.worktreePath ?? ''}|${refs}`
      if (cache.isFresh(cacheKey, fingerprint)) continue
      settle(task, { repoPath, key, baseBranch: task.baseBranch }, git, taskWrites)
      if (taskWrites.length > 0) cache.forget(cacheKey)
      else cache.remember(cacheKey, fingerprint)
    } catch (error) {
      // Keep what was decided before the failure (a landed task must still reach Done) and retry
      // the rest next pass; the caller reports the error.
      if (taskWrites.length > 0) cache.forget(cacheKey)
      errors.push({ taskId: task.id, error })
    }
    writes.push(...taskWrites)
  }
  return { writes, errors }
}

function settle(task: LandingTask, checkout: Checkout, git: LandingGit, out: LandingWrite[]): void {
  if (task.status === 'in_review') {
    const landing = git.branchLanding(checkout)
    if (!landing?.landed) return
    out.push(
      { kind: 'status', taskId: task.id, status: 'done' },
      { kind: 'note', taskId: task.id, message: `Work landed on ${landing.base}; moved to done.` }
    )
    cleanup(task, checkout, git, out)
    return
  }
  cleanup(task, checkout, git, out)
}

function cleanup(
  task: LandingTask,
  checkout: Checkout,
  git: LandingGit,
  out: LandingWrite[]
): void {
  const result = git.cleanupLandedTask(checkout)
  if (result.worktreeRemoved && task.worktreePath) {
    out.push({ kind: 'clearWorktree', taskId: task.id })
  }
  // Deduped against the task's own Activity, which survives a restart; a refusal is reported once.
  const message = result.notes.join(' ')
  if (message && !isRepeatNote(task.activity, 'styr', message)) {
    out.push({ kind: 'note', taskId: task.id, message })
  }
}
