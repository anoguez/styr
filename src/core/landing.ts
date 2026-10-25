import { branchNameFor } from './worktree.js'
import {
  checkoutOf,
  checkoutsOf,
  type Checkout,
  type CheckoutGit,
  type Landing,
  type TaskRepoCheckout
} from './taskCheckout.js'
import type { ExtraRepo, Task, TaskStatus, WorktreeLocation } from './types.js'

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

export interface LandingPorts {
  /** The git half of the decision: `checkoutGit`, or a fake so the rules test without a repository. */
  git: CheckoutGit
  /** Lives as long as the process: it is what keeps a write from re-running git for every task. */
  cache: LandingCache
  workspaceId: string
  /** The workspace's `worktreeLocation`, for a task whose worktree path is not recorded. */
  worktreeLocation?: WorktreeLocation
}

export type LandingTask = Pick<
  Task,
  'id' | 'status' | 'useWorktree' | 'repoPath' | 'worktreePath' | 'baseBranch' | 'activity'
> & { extraRepos?: readonly ExtraRepo[] }

/** Every repository a landing pass looks at for a task: the primary, then its extras. */
export function taskRepoPaths(
  task: Pick<LandingTask, 'repoPath' | 'extraRepos' | 'useWorktree'>
): string[] {
  return [
    ...(task.repoPath ? [task.repoPath] : []),
    ...(task.useWorktree ? (task.extraRepos ?? []).map((extra) => extra.repoPath) : [])
  ]
}

/** One task-file change the caller performs, in order, through the task store. */
export type LandingWrite =
  | { kind: 'status'; taskId: string; status: TaskStatus }
  /** `extras`: the extra repositories' recorded worktrees are cleared too (a multi-repo task). */
  | { kind: 'clearWorktree'; taskId: string; extras?: true }
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
export async function settleTasks(
  tasks: readonly LandingTask[],
  ports: LandingPorts
): Promise<LandingOutcome> {
  const { git, cache, workspaceId, worktreeLocation } = ports
  const writes: LandingWrite[] = []
  const errors: LandingError[] = []
  // One ref listing per repository per pass, not one per task.
  const listings = new Map<string, Promise<string | undefined>>()
  const listingFor = (path: string): Promise<string | undefined> => {
    let listing = listings.get(path)
    if (!listing) {
      listing = git.refListing(path)
      listings.set(path, listing)
    }
    return listing
  }

  for (const task of tasks) {
    const { repoPath } = task
    if (!task.useWorktree || !repoPath) continue
    const extras = task.extraRepos ?? []
    const hasWorktree = Boolean(task.worktreePath) || extras.some((extra) => extra.worktreePath)
    if (task.status !== 'in_review' && !(task.status === 'done' && hasWorktree)) continue
    const checkout = checkoutOf(workspaceId, task, repoPath, worktreeLocation)
    const cacheKey = `${workspaceId}:${task.id}`
    const taskWrites: LandingWrite[] = []
    try {
      if (extras.length > 0) {
        const repos = countedRepos(
          checkoutsOf(workspaceId, { ...task, repoPath }, worktreeLocation),
          extras
        )
        const refs: string[] = []
        for (const { checkout: repo } of repos) {
          refs.push(refsFingerprint(await listingFor(repo.repoPath), repo.key, repo.baseBranch))
        }
        const paths = [task.worktreePath ?? '', ...extras.map((extra) => extra.worktreePath ?? '')]
        const fingerprint = `${task.status}|${paths.join(',')}|${refs.join('||')}`
        if (cache.isFresh(cacheKey, fingerprint)) continue
        await settleMultiRepo(task, repos, git, taskWrites)
        if (taskWrites.length > 0) cache.forget(cacheKey)
        else cache.remember(cacheKey, fingerprint)
        writes.push(...taskWrites)
        continue
      }
      const refs = refsFingerprint(await listingFor(repoPath), checkout.key, task.baseBranch)
      const fingerprint = `${task.status}|${task.worktreePath ?? ''}|${refs}`
      if (cache.isFresh(cacheKey, fingerprint)) continue
      await settle(task, checkout, git, taskWrites)
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

/**
 * The repositories a multi-repo task is measured on: the primary, and each extra that has a
 * worktree. An extra that fell back to the plain repository has no recorded worktree and is not
 * landable, so it neither counts toward Done nor blocks it.
 */
function countedRepos(
  repos: readonly TaskRepoCheckout[],
  extras: readonly ExtraRepo[]
): TaskRepoCheckout[] {
  return repos.filter((repo, index) => repo.role === 'primary' || extras[index - 1]?.worktreePath)
}

function commits(count: number): string {
  return `${count} commit${count === 1 ? '' : 's'}`
}

/**
 * A multi-repo task is Done only when every landable repository has landed. A repository with no
 * commits of its own (the agent never touched it) has nothing to land and does not block, but the
 * task needs at least one repository that really landed. Some landed and some not leaves it In
 * Review with one note naming both sets; nothing is rolled back.
 */
async function settleMultiRepo(
  task: LandingTask,
  repos: readonly TaskRepoCheckout[],
  git: CheckoutGit,
  out: LandingWrite[]
): Promise<void> {
  if (task.status === 'in_review') {
    const measured: { repo: TaskRepoCheckout; landing: Landing | undefined }[] = []
    for (const repo of repos) {
      measured.push({ repo, landing: await git.branchLanding(repo.checkout) })
    }
    const landed = measured.filter(({ landing }) => landing?.landed)
    const blocking = measured.filter(
      ({ landing }) => !landing?.landed && (!landing || landing.ahead > 0)
    )
    if (blocking.length > 0) {
      if (landed.length === 0) return
      const message = `Landed: ${landed.map(({ repo }) => repo.repoName).join(', ')}. Not landed: ${blocking
        .map(({ repo, landing }) =>
          landing
            ? `${repo.repoName} (${commits(landing.ahead)} ahead of ${landing.base})`
            : `${repo.repoName} (no task branch)`
        )
        .join(', ')}`
      if (!isRepeatNote(task.activity, 'styr', message)) {
        out.push({ kind: 'note', taskId: task.id, message })
      }
      return
    }
    if (landed.length === 0) return
    out.push(
      { kind: 'status', taskId: task.id, status: 'done' },
      {
        kind: 'note',
        taskId: task.id,
        message: `Work landed in every repository (${landed
          .map(({ repo, landing }) => `${repo.repoName} on ${landing?.base}`)
          .join(', ')}); moved to done.`
      }
    )
    await cleanupAll(task, measured, git, out)
    return
  }
  await cleanupAll(
    task,
    repos.map((repo) => ({ repo, landing: undefined })),
    git,
    out
  )
}

/** Each repository is cleaned on its own: a refusal in one is a note and never blocks the rest. */
async function cleanupAll(
  task: LandingTask,
  repos: readonly { repo: TaskRepoCheckout; landing: Landing | undefined }[],
  git: CheckoutGit,
  out: LandingWrite[]
): Promise<void> {
  const notes: string[] = []
  let allDone = true
  for (const { repo, landing } of repos) {
    const result = await git.cleanupLandedTask(repo.checkout, landing)
    if (!result.worktreeRemoved) allDone = false
    notes.push(...result.notes.map((note) => `${repo.repoName}: ${note}`))
  }
  const recorded = Boolean(task.worktreePath) || (task.extraRepos ?? []).some((e) => e.worktreePath)
  if (allDone && recorded) out.push({ kind: 'clearWorktree', taskId: task.id, extras: true })
  const message = notes.join(' ')
  if (message && !isRepeatNote(task.activity, 'styr', message)) {
    out.push({ kind: 'note', taskId: task.id, message })
  }
}

async function settle(
  task: LandingTask,
  checkout: Checkout,
  git: CheckoutGit,
  out: LandingWrite[]
): Promise<void> {
  if (task.status === 'in_review') {
    const landing = await git.branchLanding(checkout)
    if (!landing?.landed) return
    out.push(
      { kind: 'status', taskId: task.id, status: 'done' },
      { kind: 'note', taskId: task.id, message: `Work landed on ${landing.base}; moved to done.` }
    )
    // The cleanup reuses this check rather than measuring the branch a second time.
    await cleanup(task, checkout, git, out, landing)
    return
  }
  await cleanup(task, checkout, git, out)
}

async function cleanup(
  task: LandingTask,
  checkout: Checkout,
  git: CheckoutGit,
  out: LandingWrite[],
  landing?: Landing
): Promise<void> {
  const result = await git.cleanupLandedTask(checkout, landing)
  if (result.worktreeRemoved && task.worktreePath) {
    out.push({ kind: 'clearWorktree', taskId: task.id })
  }
  // Deduped against the task's own Activity, which survives a restart; a refusal is reported once.
  const message = result.notes.join(' ')
  if (message && !isRepeatNote(task.activity, 'styr', message)) {
    out.push({ kind: 'note', taskId: task.id, message })
  }
}

/** At most one `git fetch` per repository in this window, however many triggers arrive. */
export const FETCH_THROTTLE_MS = 60_000

/**
 * The repositories worth fetching before a landing pass: those with an In Review worktree task.
 * A Done task's cleanup needs no remote, and a task without a worktree has no branch to land.
 */
export function reposAwaitingLanding(tasks: readonly LandingTask[]): string[] {
  const repos = new Set<string>()
  for (const task of tasks) {
    if (task.status === 'in_review' && task.useWorktree) {
      for (const repo of taskRepoPaths(task)) repos.add(repo)
    }
  }
  return [...repos]
}

export interface RemoteFetchPorts {
  /** Updates the repository's `origin` refs. Asynchronous: it must never block the main thread. */
  fetch(repoPath: string): Promise<void>
  /** A fetch failed (offline, no `origin`, auth). Called once per repository per session. */
  warn(repoPath: string, error: unknown): void
  now(): number
}

/**
 * Fetches `origin` so a PR merged on the host becomes visible to `branchLanding`, which only reads
 * local refs. Event-driven and best-effort: a repository is fetched at most once per `throttleMs`,
 * a trigger that arrives while its fetch is in flight joins that fetch, and a failure resolves
 * quietly (it is reported once, then carries on), so nothing that awaits it is ever blocked by it.
 */
export class RemoteFetcher {
  private readonly lastStarted = new Map<string, number>()
  private readonly inFlight = new Map<string, Promise<boolean>>()
  private readonly warned = new Set<string>()

  constructor(
    private readonly ports: RemoteFetchPorts,
    private readonly throttleMs: number = FETCH_THROTTLE_MS
  ) {}

  /** Resolves with the repositories whose refs this call's fetches updated. Never rejects. */
  async refresh(repos: readonly string[]): Promise<string[]> {
    const results = await Promise.all(
      repos.map(async (repo) => ((await this.fetchOne(repo)) ? repo : undefined))
    )
    return results.filter((repo): repo is string => repo !== undefined)
  }

  private fetchOne(repo: string): Promise<boolean> {
    const pending = this.inFlight.get(repo)
    if (pending) return pending
    const last = this.lastStarted.get(repo)
    const now = this.ports.now()
    if (last !== undefined && now - last < this.throttleMs) return Promise.resolve(false)
    this.lastStarted.set(repo, now)
    let started: Promise<void>
    try {
      started = this.ports.fetch(repo)
    } catch (error) {
      started = Promise.reject(error)
    }
    const run = started.then(
      () => true,
      (error: unknown) => {
        if (!this.warned.has(repo)) {
          this.warned.add(repo)
          this.ports.warn(repo, error)
        }
        return false
      }
    )
    const tracked = run.finally(() => this.inFlight.delete(repo))
    this.inFlight.set(repo, tracked)
    return tracked
  }
}
