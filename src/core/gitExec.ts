import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { MAX_PATCH_BYTES } from './diff.js'
import { recordGitCall } from './gitTiming.js'
import { WORKTREE_BRANCH_PREFIX, type WorktreeLocation } from './types.js'

// Private to the checkout cluster: imported by worktree.ts, worktreeLanding.ts and worktreeDiff.ts only.

const REPOSITORY_CONTEXT_ENV = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_WORK_TREE'
]

/**
 * A task's checkout: the repository, the worktree key (`worktreeKey(workspaceId, taskId)`, not a
 * bare task id), the base branch the task chose, if any, and where its worktree lives. The worktree
 * path and branch name derive from it, so no caller can pair a key with the wrong repository or base.
 */
export interface Checkout {
  repoPath: string
  key: string
  baseBranch?: string
  /** Unset is `beside`, where every worktree lived before the setting existed. */
  location?: WorktreeLocation
}

/**
 * The folder holding a repository's worktrees. `beside` keeps them out of the repository, so they
 * never show up as untracked files; `inside` puts them under `.styr/worktrees`, which
 * `ensureWorktree` hides from git with its own `.gitignore`.
 */
export function worktreesDir(repoPath: string, location: WorktreeLocation = 'beside'): string {
  return location === 'inside'
    ? join(repoPath, '.styr', 'worktrees')
    : join(dirname(repoPath), `${basename(repoPath)}.worktrees`)
}

export function checkoutPath({ repoPath, key, location }: Checkout): string {
  return join(worktreesDir(repoPath, location), key)
}

export function branchNameFor(key: string): string {
  return `${WORKTREE_BRANCH_PREFIX}${key}`
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of REPOSITORY_CONTEXT_ENV) delete env[key]
  return env
}

export function git(args: string[], cwd: string, timeout?: number): string {
  const started = performance.now()
  try {
    return execFileSync('git', args, {
      cwd,
      env: cleanEnv(),
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } finally {
    recordGitCall(args, cwd, performance.now() - started, true)
  }
}

/**
 * `git()` in a child process the caller does not wait on: for slow, network-bound commands that
 * must stay off the main process's thread. It never prompts for credentials — a fetch that would
 * ask fails instead of hanging.
 */
export function gitAsync(args: string[], cwd: string, timeout: number): Promise<string> {
  return execAsync({ args, cwd, timeout })
}

/** Like `git()` but keeps the output intact and returns stdout of a command that may exit 1. */
export function gitRaw(args: string[], cwd: string, okExit: number[] = [0]): string {
  const started = performance.now()
  try {
    return execFileSync('git', args, {
      cwd,
      env: cleanEnv(),
      encoding: 'utf8',
      maxBuffer: RAW_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    const failure = error as { status?: number; stdout?: string }
    if (failure.status !== undefined && okExit.includes(failure.status)) return failure.stdout ?? ''
    throw error
  } finally {
    recordGitCall(args, cwd, performance.now() - started, true)
  }
}

const RAW_MAX_BUFFER = MAX_PATCH_BYTES * 4

/**
 * One git invocation a step sequence asks for. `raw` is `gitRaw` (untrimmed output, `okExit`
 * accepted), otherwise `git`.
 */
export interface GitCall {
  args: string[]
  cwd: string
  raw?: boolean
  okExit?: number[]
  timeout?: number
}

/**
 * A git conversation written once and run either way: a generator that yields each `GitCall` and
 * receives its output (a failed call is thrown back in at the `yield`, so `try`/`catch` reads as
 * it would around `git()`). `runGitSync` runs it on the calling thread; `runGitAsync` runs it in
 * child processes the main thread does not wait on.
 */
export type GitSteps<T> = Generator<GitCall, T, string>

export function* gitStep(args: string[], cwd: string, timeout?: number): GitSteps<string> {
  return yield { args, cwd, timeout }
}

export function* gitRawStep(args: string[], cwd: string, okExit: number[] = [0]): GitSteps<string> {
  return yield { args, cwd, raw: true, okExit }
}

export function runGitSync<T>(steps: GitSteps<T>): T {
  let next = steps.next()
  while (!next.done) {
    const call = next.value
    let output: string
    try {
      output = call.raw
        ? gitRaw(call.args, call.cwd, call.okExit)
        : git(call.args, call.cwd, call.timeout)
    } catch (error) {
      next = steps.throw(error)
      continue
    }
    next = steps.next(output)
  }
  return next.value
}

/**
 * Runs `steps` in child processes. Conversations about one repository (`repoPath`) run one after
 * another, in the order asked, so they never race each other on git's lock files or read refs
 * halfway through another's change; different repositories run side by side.
 */
export function runGitAsync<T>(repoPath: string, steps: GitSteps<T>): Promise<T> {
  return inRepoQueue(repoPath, async () => {
    let next = steps.next()
    while (!next.done) {
      let output: string
      try {
        output = await execAsync(next.value)
      } catch (error) {
        next = steps.throw(error)
        continue
      }
      next = steps.next(output)
    }
    return next.value
  })
}

const repoQueues = new Map<string, Promise<unknown>>()

function inRepoQueue<T>(repoPath: string, work: () => Promise<T>): Promise<T> {
  const key = resolve(repoPath)
  const run = (repoQueues.get(key) ?? Promise.resolve()).then(work)
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  repoQueues.set(key, tail)
  void tail.then(() => {
    if (repoQueues.get(key) === tail) repoQueues.delete(key)
  })
  return run
}

/**
 * One git call in a child process. A failure carries `status` (the exit code) and `stdout` the way
 * `execFileSync`'s does, so a step's `catch` cannot tell the two apart.
 */
function execAsync({ args, cwd, raw, okExit = [0], timeout }: GitCall): Promise<string> {
  const started = performance.now()
  return new Promise((done, fail) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: { ...cleanEnv(), GIT_TERMINAL_PROMPT: '0' },
        encoding: 'utf8',
        timeout,
        maxBuffer: raw ? RAW_MAX_BUFFER : 1024 * 1024
      },
      (error, stdout, stderr) => {
        recordGitCall(args, cwd, performance.now() - started, false)
        if (!error) return done(raw ? stdout : stdout.trim())
        const status = typeof error.code === 'number' ? error.code : undefined
        if (raw && status !== undefined && okExit.includes(status)) return done(stdout)
        fail(Object.assign(error, { status, stdout, stderr }))
      }
    )
  })
}

export function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.split('\n').find((line) => line.trim() && !line.startsWith('Command failed')) ?? text
}

export function isGitRepo(dir: string): boolean {
  return runGitSync(isGitRepoSteps(dir))
}

export function* isGitRepoSteps(dir: string): GitSteps<boolean> {
  if (!dir || !existsSync(dir)) return false
  try {
    return (yield* gitStep(['rev-parse', '--is-inside-work-tree'], dir)) === 'true'
  } catch {
    return false
  }
}

export function branchExists(repoPath: string, branch: string): boolean {
  return runGitSync(branchExistsSteps(repoPath, branch))
}

export function* branchExistsSteps(repoPath: string, branch: string): GitSteps<boolean> {
  try {
    yield* gitStep(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoPath)
    return true
  } catch {
    return false
  }
}

export function refExists(repoPath: string, ref: string): boolean {
  return runGitSync(refExistsSteps(repoPath, ref))
}

export function* refExistsSteps(repoPath: string, ref: string): GitSteps<boolean> {
  try {
    yield* gitStep(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoPath)
    return true
  } catch {
    return false
  }
}

/**
 * The branch work is meant to land on: the remote's default branch when there is one, else
 * `main`/`master`, else whatever the main checkout is on (a worktree branches from its HEAD).
 */
export function baseBranchFor(repoPath: string): string | undefined {
  return runGitSync(baseBranchSteps(repoPath))
}

export function* baseBranchSteps(repoPath: string): GitSteps<string | undefined> {
  try {
    const remoteHead = yield* gitStep(
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      repoPath
    )
    const name = remoteHead.replace(/^origin\//, '')
    if (name && (yield* refExistsSteps(repoPath, `refs/heads/${name}`))) return name
  } catch {
    // no remote, or origin/HEAD was never set
  }
  for (const name of ['main', 'master']) {
    if (yield* refExistsSteps(repoPath, `refs/heads/${name}`)) return name
  }
  try {
    const current = yield* gitStep(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)
    return current && current !== 'HEAD' ? current : undefined
  } catch {
    return undefined
  }
}
