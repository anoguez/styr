import { existsSync, statSync } from 'node:fs'
import { lstat, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  MAX_PATCH_BYTES,
  cleanPatch,
  countPatchLines,
  parseNameStatus,
  parseNumstat,
  untrackedFiles,
  emptyDiff,
  MAX_DIFF_FILES,
  type DiffResult,
  type DiffStat,
  type PatchResult
} from './diff.js'
import {
  baseBranchFor,
  baseBranchSteps,
  branchExistsSteps,
  branchNameFor,
  checkoutPath,
  firstLine,
  git,
  gitRaw,
  gitRawStep,
  gitStep,
  isGitRepoSteps,
  refExistsSteps,
  runGitAsync,
  runGitSync,
  type Checkout,
  type GitSteps
} from './gitExec.js'
import { branchLanding } from './worktreeLanding.js'

/** The ref a task's diff is measured against: the merge-base with its (preferably remote) base. */
function* diffBaseFor(
  dir: string,
  { repoPath, baseBranch }: Checkout
): GitSteps<string | undefined> {
  const name = baseBranch ?? (yield* baseBranchSteps(repoPath))
  const candidates = name ? [`origin/${name}`, name] : []
  let best: string | undefined
  let bestAhead = Infinity
  for (const ref of candidates) {
    if (!(yield* refExistsSteps(dir, ref))) continue
    try {
      const mergeBase = yield* gitStep(['merge-base', ref, 'HEAD'], dir)
      // Prefer the ref whose merge-base is closest to HEAD, so landed work is not re-shown.
      const ahead = Number(yield* gitStep(['rev-list', '--count', `${mergeBase}..HEAD`], dir))
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
    return yield* gitStep(['rev-parse', 'HEAD^'], dir)
  } catch {
    return undefined
  }
}

type DiffTarget =
  | {
      dir: string
      base: string
      mergeBase?: string
      branch?: string
      note?: string
      repo?: boolean
    }
  | { gone: true; branch: string; branchKept: boolean }
  | { error: string }

/** True when the task is meant to have a worktree; false diffs the repository itself. */
function diffTarget(checkout: Checkout, worktree: boolean): DiffTarget {
  return runGitSync(diffTargetSteps(checkout, worktree))
}

function* diffTargetSteps(checkout: Checkout, worktree: boolean): GitSteps<DiffTarget> {
  const { repoPath, key } = checkout
  if (!(yield* isGitRepoSteps(repoPath))) {
    return { error: `${repoPath || '(no repository)'} is not a git repository` }
  }
  if (!worktree) {
    return {
      dir: repoPath,
      base: 'HEAD',
      repo: true,
      note: 'No worktree for this task — showing uncommitted changes in the repository.'
    }
  }
  const branch = branchNameFor(key)
  const dir = checkoutPath(checkout)
  if (!existsSync(dir)) {
    return { gone: true, branch, branchKept: yield* branchExistsSteps(repoPath, branch) }
  }
  let onBranch = false
  try {
    onBranch = (yield* gitStep(['rev-parse', '--abbrev-ref', 'HEAD'], dir)) === branch
  } catch {
    // unborn HEAD
  }
  if (!onBranch) {
    return {
      dir,
      base: 'HEAD',
      note: 'The task branch is missing or detached — showing uncommitted changes only.'
    }
  }
  const base = yield* diffBaseFor(dir, checkout)
  if (!base) return { error: 'Could not find a base branch to compare against' }
  return {
    dir,
    base,
    mergeBase: base,
    branch
  }
}

function pathSet(raw: string): Set<string> {
  return new Set(raw.split('\0').filter(Boolean))
}

/**
 * Everything a task changed: commits since the merge-base with the base branch, plus staged,
 * unstaged and untracked work in the worktree. Patches are fetched lazily by `taskFilePatch`.
 */
export function taskDiff(checkout: Checkout, worktree: boolean): DiffResult {
  try {
    const target = diffTarget(checkout, worktree)
    if ('error' in target) return target
    if ('gone' in target) {
      return { ...emptyDiff('gone'), branch: target.branch, branchKept: target.branchKept }
    }
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
    // Which files are not committed yet: dirty against HEAD, or untracked.
    const dirty = pathSet(gitRaw(['diff', '--name-only', '-z', 'HEAD'], dir))
    const committed =
      base === 'HEAD'
        ? new Set<string>()
        : pathSet(gitRaw(['diff', '--name-only', '-z', base, 'HEAD'], dir))
    const untrackedPaths = new Set(untracked.map((file) => file.path))
    const all = [...files, ...untracked].sort((a, b) => a.path.localeCompare(b.path))
    for (const file of all) {
      const isDirty = dirty.has(file.path) || untrackedPaths.has(file.path)
      file.uncommitted = isDirty
      file.origin = untrackedPaths.has(file.path)
        ? 'untracked'
        : isDirty && committed.has(file.path)
          ? 'both'
          : isDirty
            ? 'uncommitted'
            : 'committed'
    }
    const kind = target.repo
      ? 'repo'
      : all.length > 0
        ? 'changes'
        : branchIsLanded(checkout)
          ? 'landed'
          : 'empty'
    return {
      kind,
      baseName: target.repo
        ? 'HEAD'
        : (checkout.baseBranch ?? baseBranchFor(checkout.repoPath) ?? 'HEAD'),
      mergeBase: target.mergeBase ? target.mergeBase.slice(0, 7) : undefined,
      branch: target.branch,
      note: target.note,
      files: all.slice(0, MAX_DIFF_FILES),
      omitted: Math.max(0, all.length - MAX_DIFF_FILES),
      totalFiles: all.length,
      totalAdditions: all.reduce((sum, file) => sum + file.additions, 0),
      totalDeletions: all.reduce((sum, file) => sum + file.deletions, 0)
    }
  } catch (error) {
    return { error: firstLine(error) }
  }
}

/**
 * A card's change totals: `taskDiff`'s `totalAdditions`/`totalDeletions`/`totalFiles` when its
 * kind is `changes`, undefined otherwise. Off the main thread — the git runs in child processes and
 * untracked files are counted from disk, not with one git process each — because the board asks
 * for every worktree task's totals after each change.
 */
export async function taskDiffStat(
  checkout: Checkout,
  worktree: boolean
): Promise<DiffStat | undefined> {
  try {
    const listed = await runGitAsync(checkout.repoPath, statSteps(checkout, worktree))
    if (!listed) return undefined
    const { dir, files, untracked } = listed
    let added = 0
    let removed = 0
    for (const file of files) {
      added += file.additions
      removed += file.deletions
    }
    for (const path of untracked) added += await untrackedLines(dir, path)
    const total = files.length + untracked.length
    return total > 0 ? { added, removed, files: total } : undefined
  } catch {
    return undefined
  }
}

function* statSteps(
  checkout: Checkout,
  worktree: boolean
): GitSteps<
  { dir: string; files: ReturnType<typeof parseNumstat>; untracked: string[] } | undefined
> {
  const target = yield* diffTargetSteps(checkout, worktree)
  if ('error' in target || 'gone' in target || target.repo) return undefined
  const { dir, base } = target
  const statuses = parseNameStatus(
    yield* gitRawStep(['diff', '--name-status', '-z', '-M', base], dir)
  )
  const files = parseNumstat(
    yield* gitRawStep(['diff', '--numstat', '-z', '-M', base], dir),
    statuses
  )
  const untracked = untrackedFiles(
    yield* gitRawStep(['ls-files', '--others', '--exclude-standard', '-z'], dir),
    new Set(files.map((file) => file.path))
  ).map((file) => file.path)
  return { dir, files, untracked }
}

/** Bytes git inspects for a NUL when deciding a file is binary. */
const BINARY_SNIFF_BYTES = 8000

/**
 * The lines `git diff --no-index /dev/null <path>` would add for an untracked file, as
 * `untrackedPatch` counts them: none for a binary file, a directory, or a patch over `gitRaw`'s
 * buffer, which `taskDiff` reads as too large to count.
 */
async function untrackedLines(dir: string, path: string): Promise<number> {
  try {
    const full = join(dir, path)
    const info = await lstat(full)
    // git diffs a symlink as its target path: one line, without a trailing newline.
    if (info.isSymbolicLink()) return (await readlink(full)).length > 0 ? 1 : 0
    if (!info.isFile() || info.size === 0 || info.size > RAW_PATCH_LIMIT) return 0
    const content = await readFile(full)
    if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return 0
    let lines = 0
    for (const byte of content) if (byte === 0x0a) lines++
    if (content[content.length - 1] !== 0x0a) lines++
    // Each line gains a `+`, plus the patch's header: over the buffer, git's answer is unreadable.
    return content.length + lines + PATCH_HEADER_BYTES + path.length * 4 > RAW_PATCH_LIMIT
      ? 0
      : lines
  } catch {
    return 0
  }
}

/** `gitRaw`'s output buffer: a patch past it is not counted. */
const RAW_PATCH_LIMIT = MAX_PATCH_BYTES * 4
const PATCH_HEADER_BYTES = 120

function branchIsLanded(checkout: Checkout): boolean {
  try {
    return branchLanding(checkout)?.landed === true
  } catch {
    return false
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

function fileBytes(dir: string, path: string): number | undefined {
  try {
    return statSync(join(dir, path)).size
  } catch {
    return undefined
  }
}

/**
 * One file's unified patch. The path must be in the current file list — no arbitrary reads.
 * `full` asks for the whole file as context so folded unchanged lines can be shown.
 */
export function taskFilePatch(
  checkout: Checkout,
  worktree: boolean,
  path: string,
  full = false
): PatchResult {
  try {
    const target = diffTarget(checkout, worktree)
    if ('error' in target) return target
    if ('gone' in target) return { error: 'Worktree no longer exists' }
    const diff = taskDiff(checkout, worktree)
    if ('error' in diff) return diff
    const file = diff.files.find((candidate) => candidate.path === path)
    if (!file) return { placeholder: 'unchanged' }
    const { dir, base } = target
    if (file.binary) return { placeholder: 'binary', bytes: fileBytes(dir, path) }
    const context = full ? ['-U1000000'] : []
    const tracked = file.status !== 'added' || refHasPath(dir, base, path)
    const raw = tracked
      ? gitRaw(
          ['diff', '-M', ...context, base, '--', ...(file.oldPath ? [file.oldPath] : []), path],
          dir
        )
      : gitRaw(['diff', '--no-index', ...context, '--', '/dev/null', path], dir, [0, 1])
    if (/^Binary files /m.test(raw)) return { placeholder: 'binary', bytes: fileBytes(dir, path) }
    if (/^[-+]Subproject commit /m.test(raw)) {
      const from = /^-Subproject commit (\w+)/m.exec(raw)?.[1]
      const to = /^\+Subproject commit (\w+)/m.exec(raw)?.[1]
      return { placeholder: 'submodule', from: from?.slice(0, 7), to: to?.slice(0, 7) }
    }
    if (Buffer.byteLength(raw) > MAX_PATCH_BYTES) {
      return { placeholder: 'too-large', bytes: fileBytes(dir, path) ?? Buffer.byteLength(raw) }
    }
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
