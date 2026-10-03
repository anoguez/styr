import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  MAX_PATCH_BYTES,
  cleanPatch,
  countPatchLines,
  parseNameStatus,
  parseNumstat,
  untrackedFiles,
  MAX_DIFF_FILES,
  type DiffResult,
  type PatchResult
} from './diff.js'
import { WORKTREE_BRANCH_PREFIX } from './types.js'

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

export interface WorktreeResult {
  path: string
  branch: string
  created: boolean
}

function git(args: string[], cwd: string, timeout?: number): string {
  const env = { ...process.env }
  for (const key of REPOSITORY_CONTEXT_ENV) delete env[key]

  return execFileSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

export function isGitRepo(dir: string): boolean {
  if (!dir || !existsSync(dir)) return false
  try {
    return git(['rev-parse', '--is-inside-work-tree'], dir) === 'true'
  } catch {
    return false
  }
}

/**
 * Worktrees live beside the repository rather than inside it, so they never show up as untracked
 * files and need no .gitignore entry in the user's project.
 */
export function worktreePathFor(repoPath: string, taskId: string): string {
  return join(dirname(repoPath), `${basename(repoPath)}.worktrees`, taskId)
}

export function branchNameFor(taskId: string): string {
  return `${WORKTREE_BRANCH_PREFIX}${taskId}`
}

function branchExists(repoPath: string, branch: string): boolean {
  try {
    git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoPath)
    return true
  } catch {
    return false
  }
}

/**
 * Creates the task's worktree if it is missing, or returns the existing one. Idempotent so a
 * resumed session lands back in the same checkout.
 */
export function ensureWorktree(
  repoPath: string,
  taskId: string,
  baseBranch?: string
): WorktreeResult {
  if (!isGitRepo(repoPath)) {
    throw new Error(`${repoPath || '(no working directory)'} is not a git repository`)
  }

  const path = worktreePathFor(repoPath, taskId)
  const branch = branchNameFor(taskId)

  git(['worktree', 'prune'], repoPath)
  if (existsSync(path)) return { path, branch, created: false }

  const args = branchExists(repoPath, branch)
    ? ['worktree', 'add', path, branch]
    : ['worktree', 'add', '-b', branch, path, startPointFor(repoPath, baseBranch)]
  git(args, repoPath)
  return { path, branch, created: true }
}

/**
 * Where a new task branch starts. The main checkout's HEAD is only as fresh as the user's last
 * pull, so work started from it lands on an old version of the app. Fetch first (best effort —
 * offline must not block a launch), then start from the remote tip of the branch the checkout is
 * on (its upstream, or `origin/<name>`), so `main` and `release/x.y.z` checkouts both advance.
 * The remote tip is used only when HEAD is strictly behind it; if HEAD is ahead or diverged it is
 * kept, as that is the user's own state.
 */
function startPointFor(repoPath: string, baseBranch?: string): string {
  let fetched = true
  try {
    git(['fetch', '--quiet', 'origin'], repoPath, 30_000)
  } catch {
    fetched = false
  }
  if (baseBranch) {
    // An explicit choice wins: the fetched remote tip, else the local branch. A branch that has
    // since vanished falls through to the automatic choice rather than failing the launch.
    const remote = `origin/${baseBranch}`
    if (fetched && refExists(repoPath, remote)) return remote
    if (refExists(repoPath, baseBranch)) return baseBranch
    if (refExists(repoPath, remote)) return remote
  }
  if (!fetched) return 'HEAD'
  for (const remote of remoteCandidates(repoPath)) {
    if (!refExists(repoPath, remote)) continue
    try {
      git(['merge-base', '--is-ancestor', 'HEAD', remote], repoPath)
      return remote
    } catch {
      return 'HEAD'
    }
  }
  return 'HEAD'
}

function remoteCandidates(repoPath: string): string[] {
  const candidates: string[] = []
  try {
    candidates.push(git(['rev-parse', '--abbrev-ref', '@{upstream}'], repoPath))
  } catch {
    // no upstream configured
  }
  try {
    const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)
    if (current && current !== 'HEAD') candidates.push(`origin/${current}`)
  } catch {
    // unborn HEAD
  }
  const base = baseBranchFor(repoPath)
  if (base) candidates.push(`origin/${base}`)
  return candidates
}

/** Branches a worktree can start from: local ones plus origin's, deduplicated, current first. */
export function listBranches(repoPath: string): { branches: string[]; current?: string } {
  if (!isGitRepo(repoPath)) return { branches: [] }
  const names = new Set<string>()
  let current: string | undefined
  try {
    const head = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)
    if (head && head !== 'HEAD') current = head
  } catch {
    // unborn HEAD
  }
  const collect = (ref: string, strip: string): void => {
    try {
      for (const line of git(['for-each-ref', '--format=%(refname:short)', ref], repoPath).split(
        '\n'
      )) {
        const name = line.startsWith(strip) ? line.slice(strip.length) : line
        if (name && name !== 'origin' && name !== 'HEAD') names.add(name)
      }
    } catch {
      // no refs of that kind
    }
  }
  collect('refs/heads', '')
  collect('refs/remotes/origin', 'origin/')
  const branches = [...names].filter((name) => !name.startsWith(WORKTREE_BRANCH_PREFIX)).sort()
  if (current) branches.sort((a, b) => Number(b === current) - Number(a === current))
  return { branches, current }
}

/**
 * The checked-out branch of a working directory, or a short SHA when detached. Reads `.git/HEAD`
 * rather than spawning git, so it is cheap enough to call on every agent refresh. In a worktree
 * `.git` is a file pointing at the real git directory, which is resolved here.
 */
export function readGitBranch(dir: string): string | undefined {
  if (!dir || !existsSync(dir)) return undefined
  try {
    const dotGit = join(dir, '.git')
    let gitDir = dotGit
    if (statSync(dotGit).isFile()) {
      const pointer = readFileSync(dotGit, 'utf8').trim()
      const target = pointer.startsWith('gitdir:') ? pointer.slice('gitdir:'.length).trim() : ''
      if (!target) return undefined
      gitDir = target.startsWith('/') ? target : join(dir, target)
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    if (head.startsWith('ref: refs/heads/')) return head.slice('ref: refs/heads/'.length)
    return head.slice(0, 7)
  } catch {
    return undefined
  }
}

export function removeWorktree(repoPath: string, taskId: string): void {
  if (!isGitRepo(repoPath)) return
  const path = worktreePathFor(repoPath, taskId)
  if (existsSync(path)) git(['worktree', 'remove', path, '--force'], repoPath)
  git(['worktree', 'prune'], repoPath)
}

export interface Landing {
  branch: string
  /** The branch the work is meant to land on. */
  base: string
  /** Commits on the task branch that are not on the base. */
  ahead: number
  /** Every commit is on the base, or (squash/rebase merges) every file it changed matches the base. */
  landed: boolean
}

function refExists(repoPath: string, ref: string): boolean {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoPath)
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
  try {
    const remoteHead = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoPath)
    const name = remoteHead.replace(/^origin\//, '')
    if (name && refExists(repoPath, `refs/heads/${name}`)) return name
  } catch {
    // no remote, or origin/HEAD was never set
  }
  for (const name of ['main', 'master']) {
    if (refExists(repoPath, `refs/heads/${name}`)) return name
  }
  try {
    const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)
    return current && current !== 'HEAD' ? current : undefined
  } catch {
    return undefined
  }
}

function countAhead(repoPath: string, base: string, branch: string): number {
  return Number(git(['rev-list', '--count', `${base}..${branch}`], repoPath))
}

/** True when every file the branch changed since its merge-base is identical on `base`. */
function contentLanded(repoPath: string, base: string, branch: string): boolean {
  try {
    const mergeBase = git(['merge-base', base, branch], repoPath)
    const changed = git(['diff', '--name-only', '-z', mergeBase, branch], repoPath)
      .split('\0')
      .filter(Boolean)
    if (changed.length === 0) return false
    git(['diff', '--quiet', base, branch, '--', ...changed], repoPath)
    return true
  } catch {
    return false
  }
}

/**
 * Whether a task branch's work is on the base. A remote-tracking base counts too, so a PR merged on
 * the host is seen before the user pulls. Undefined when there is no branch or no base to compare.
 */
export function branchLanding(repoPath: string, taskId: string): Landing | undefined {
  if (!isGitRepo(repoPath)) return undefined
  const branch = branchNameFor(taskId)
  if (!branchExists(repoPath, branch)) return undefined
  const base = baseBranchFor(repoPath)
  if (!base) return undefined

  const bases = [base, `origin/${base}`].filter((ref) => refExists(repoPath, ref))
  let ahead = countAhead(repoPath, base, branch)
  let landed = false
  for (const ref of bases) {
    const count = countAhead(repoPath, ref, branch)
    ahead = Math.min(ahead, count)
    if (count === 0 || contentLanded(repoPath, ref, branch)) landed = true
  }
  if (landed && ahead === 0 && !hasOwnCommits(repoPath, branch)) landed = false
  return { branch, base, ahead, landed }
}

/**
 * A fresh branch with no commits is trivially "on the base"; that is not landed work. The reflog
 * remembers the commit the branch was created at, so a tip that never moved is told apart from one
 * that was fast-forward merged. Without a reflog the branch is not assumed to have landed.
 */
function hasOwnCommits(repoPath: string, branch: string): boolean {
  try {
    const entries = git(['reflog', 'show', '--format=%H', `refs/heads/${branch}`], repoPath)
      .split('\n')
      .filter(Boolean)
    return entries.length > 1 && entries[0] !== entries[entries.length - 1]
  } catch {
    return false
  }
}

export interface CleanupResult {
  /** The worktree directory is gone (or never existed), so `worktreePath` can be cleared. */
  worktreeRemoved: boolean
  /** One line per thing done or left in place, for the task's Activity. */
  notes: string[]
}

/**
 * Removes what a landed task left behind: its worktree, its local branch and its remote branch.
 * Nothing is forced past a check — a dirty worktree stays, and a branch whose work cannot be shown
 * to be on the base stays — and each refusal is reported rather than thrown.
 */
export function cleanupLandedTask(repoPath: string, taskId: string): CleanupResult {
  const notes: string[] = []
  const path = worktreePathFor(repoPath, taskId)
  const branch = branchNameFor(taskId)
  const landing = branchLanding(repoPath, taskId)

  if (landing && !landing.landed) {
    notes.push(
      `Kept worktree and branch ${branch}: ${landing.ahead} commit(s) are not on ${landing.base}.`
    )
    return { worktreeRemoved: !existsSync(path), notes }
  }

  git(['worktree', 'prune'], repoPath)
  if (existsSync(path)) {
    try {
      git(['worktree', 'remove', path], repoPath)
      notes.push(`Removed worktree ${path}.`)
    } catch {
      notes.push(`Left worktree ${path} in place: it has uncommitted or untracked changes.`)
      return { worktreeRemoved: false, notes }
    }
  }
  if (!landing) return { worktreeRemoved: true, notes }

  const remoteTip = remoteBranchTip(repoPath, branch)
  const localTip = git(['rev-parse', branch], repoPath)
  try {
    git(['branch', '-D', branch], repoPath)
    notes.push(`Deleted local branch ${branch}.`)
  } catch (error) {
    notes.push(`Could not delete local branch ${branch}: ${firstLine(error)}`)
  }

  if (remoteTip === localTip) {
    try {
      git(['push', 'origin', '--delete', branch], repoPath, 30_000)
      notes.push(`Deleted remote branch origin/${branch}.`)
    } catch (error) {
      notes.push(`Could not delete remote branch origin/${branch}: ${firstLine(error)}`)
    }
  } else if (remoteTip) {
    notes.push(`Kept remote branch origin/${branch}: it has commits that are not the local tip.`)
  }
  return { worktreeRemoved: true, notes }
}

function remoteBranchTip(repoPath: string, branch: string): string | undefined {
  try {
    const line = git(['ls-remote', '--heads', 'origin', branch], repoPath, 15_000)
    return line.split(/\s/)[0] || undefined
  } catch {
    return undefined
  }
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.split('\n').find((line) => line.trim() && !line.startsWith('Command failed')) ?? text
}

/** Like `git()` but keeps the output intact and returns stdout of a command that may exit 1. */
function gitRaw(args: string[], cwd: string, okExit: number[] = [0]): string {
  const env = { ...process.env }
  for (const key of REPOSITORY_CONTEXT_ENV) delete env[key]
  try {
    return execFileSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
      maxBuffer: MAX_PATCH_BYTES * 4,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    const failure = error as { status?: number; stdout?: string }
    if (failure.status !== undefined && okExit.includes(failure.status)) return failure.stdout ?? ''
    throw error
  }
}

/** The ref a task's diff is measured against: the merge-base with its (preferably remote) base. */
function diffBaseFor(dir: string, repoPath: string, baseBranch?: string): string | undefined {
  const name = baseBranch ?? baseBranchFor(repoPath)
  const candidates = name ? [`origin/${name}`, name] : []
  let best: string | undefined
  let bestAhead = Infinity
  for (const ref of candidates) {
    if (!refExists(dir, ref)) continue
    try {
      const mergeBase = git(['merge-base', ref, 'HEAD'], dir)
      // Prefer the ref whose merge-base is closest to HEAD, so landed work is not re-shown.
      const ahead = Number(git(['rev-list', '--count', `${mergeBase}..HEAD`], dir))
      if (ahead < bestAhead) {
        best = mergeBase
        bestAhead = ahead
      }
    } catch {
      // unrelated histories: try the next candidate
    }
  }
  if (best) return best
  try {
    return git(['rev-parse', 'HEAD^'], dir)
  } catch {
    return undefined
  }
}

function diffTarget(
  repoPath: string,
  key: string,
  worktree: boolean,
  baseBranch?: string
): { dir: string; base: string; branch?: string; note?: string } | { error: string } {
  if (!isGitRepo(repoPath))
    return { error: `${repoPath || '(no repository)'} is not a git repository` }
  if (!worktree) {
    return {
      dir: repoPath,
      base: 'HEAD',
      note: 'No worktree — showing uncommitted changes in the repository.'
    }
  }
  const dir = worktreePathFor(repoPath, key)
  if (!existsSync(dir)) return { error: 'Worktree no longer exists' }
  const branch = branchNameFor(key)
  let onBranch = false
  try {
    onBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], dir) === branch
  } catch {
    // unborn HEAD
  }
  if (!onBranch) {
    return {
      dir,
      base: 'HEAD',
      note: 'Branch is missing or detached — showing uncommitted changes only.'
    }
  }
  const base = diffBaseFor(dir, repoPath, baseBranch)
  if (!base) return { error: 'Could not find a base branch to compare against' }
  return { dir, base, branch }
}

/**
 * Everything a task changed: commits since the merge-base with the base branch, plus staged,
 * unstaged and untracked work in the worktree. Patches are fetched lazily by `taskFilePatch`.
 */
export function taskDiff(
  repoPath: string,
  key: string,
  opts: { worktree: boolean; baseBranch?: string }
): DiffResult {
  try {
    const target = diffTarget(repoPath, key, opts.worktree, opts.baseBranch)
    if ('error' in target) return target
    const { dir, base } = target
    const statuses = parseNameStatus(gitRaw(['diff', '--name-status', '-z', '-M', base], dir))
    const files = parseNumstat(gitRaw(['diff', '--numstat', '-z', '-M', base], dir), statuses)
    const untracked = untrackedFiles(
      gitRaw(['ls-files', '--others', '--exclude-standard', '-z'], dir),
      new Set(files.map((file) => file.path))
    )
    for (const file of untracked) {
      const patch = untrackedPatch(dir, file.path)
      if (patch === 'binary') file.binary = true
      else if (patch !== 'too-large') Object.assign(file, countPatchLines(patch))
    }
    const all = [...files, ...untracked].sort((a, b) => a.path.localeCompare(b.path))
    return {
      base: target.base,
      branch: target.branch,
      note: target.note,
      files: all.slice(0, MAX_DIFF_FILES),
      omitted: Math.max(0, all.length - MAX_DIFF_FILES)
    }
  } catch (error) {
    return { error: firstLine(error) }
  }
}

function untrackedPatch(dir: string, path: string): string | 'binary' | 'too-large' {
  try {
    const raw = gitRaw(['diff', '--no-index', '--', '/dev/null', path], dir, [0, 1])
    if (/^Binary files /m.test(raw)) return 'binary'
    return raw
  } catch {
    return 'too-large'
  }
}

/** One file's unified patch. The path must be in the current file list — no arbitrary reads. */
export function taskFilePatch(
  repoPath: string,
  key: string,
  opts: { worktree: boolean; baseBranch?: string },
  path: string
): PatchResult {
  try {
    const target = diffTarget(repoPath, key, opts.worktree, opts.baseBranch)
    if ('error' in target) return target
    const diff = taskDiff(repoPath, key, opts)
    if ('error' in diff) return diff
    const file = diff.files.find((candidate) => candidate.path === path)
    if (!file) return { placeholder: 'unchanged' }
    if (file.binary) return { placeholder: 'binary' }
    const { dir, base } = target
    const tracked = file.status !== 'added' || refHasPath(dir, base, path)
    const raw = tracked
      ? gitRaw(['diff', '-M', base, '--', ...(file.oldPath ? [file.oldPath] : []), path], dir)
      : gitRaw(['diff', '--no-index', '--', '/dev/null', path], dir, [0, 1])
    if (/^Binary files /m.test(raw)) return { placeholder: 'binary' }
    if (/^Subproject commit /m.test(raw)) return { placeholder: 'submodule' }
    if (Buffer.byteLength(raw) > MAX_PATCH_BYTES) return { placeholder: 'too-large' }
    return { patch: cleanPatch(raw) }
  } catch (error) {
    const failure = error as { code?: string }
    if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { placeholder: 'too-large' }
    return { error: firstLine(error) }
  }
}

function refHasPath(dir: string, ref: string, path: string): boolean {
  try {
    git(['cat-file', '-e', `${ref}:${path}`], dir)
    return true
  } catch {
    return false
  }
}
