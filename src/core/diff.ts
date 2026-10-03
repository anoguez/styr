export type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed'

export type DiffOrigin = 'committed' | 'uncommitted' | 'untracked' | 'both'

export interface DiffFile {
  path: string
  oldPath?: string
  status: DiffStatus
  additions: number
  deletions: number
  binary: boolean
  /** Not committed yet: staged, unstaged or untracked. */
  uncommitted: boolean
  origin: DiffOrigin
}

export type DiffKind = 'changes' | 'empty' | 'landed' | 'repo' | 'gone'

export interface TaskDiff {
  kind: DiffKind
  /** What the diff is measured against, as shown to the user (`main`, or `HEAD` for the repo). */
  baseName: string
  /** Short merge-base sha when diffing a branch. */
  mergeBase?: string
  branch?: string
  /** For `gone`: the branch survived the worktree's removal. */
  branchKept?: boolean
  /** Why the diff is not the usual branch-versus-base one, shown as a note. */
  note?: string
  files: DiffFile[]
  /** Files beyond `MAX_DIFF_FILES` that were left out. */
  omitted: number
  totalFiles: number
  totalAdditions: number
  totalDeletions: number
}

export function emptyDiff(kind: DiffKind): TaskDiff {
  return {
    kind,
    baseName: 'HEAD',
    files: [],
    omitted: 0,
    totalFiles: 0,
    totalAdditions: 0,
    totalDeletions: 0
  }
}

/** What a card shows: totals for a task's branch against its base. */
export interface DiffStat {
  added: number
  removed: number
  files: number
}

export type DiffResult = TaskDiff | { error: string }

export type PatchResult =
  | { patch: string }
  | { placeholder: 'binary' | 'too-large'; bytes?: number }
  | { placeholder: 'submodule'; from?: string; to?: string }
  | { placeholder: 'unchanged' }
  | { error: string }

export const MAX_DIFF_FILES = 1000
export const MAX_PATCH_BYTES = 256 * 1024
export const MAX_LINE_CHARS = 2000

const STATUS_LETTERS: Record<string, DiffStatus> = {
  A: 'added',
  M: 'modified',
  T: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'added'
}

/** `git diff --name-status -z`: `M\0path\0`, `R100\0old\0new\0`. Returns the path -> entry map. */
export function parseNameStatus(
  raw: string
): Map<string, { status: DiffStatus; oldPath?: string }> {
  const parts = raw.split('\0')
  const out = new Map<string, { status: DiffStatus; oldPath?: string }>()
  for (let i = 0; i < parts.length;) {
    const code = parts[i++]
    if (!code) continue
    const status = STATUS_LETTERS[code.charAt(0)] ?? 'modified'
    if (code[0] === 'R' || code[0] === 'C') {
      const oldPath = parts[i++]
      const path = parts[i++]
      if (path !== undefined)
        out.set(path, { status, oldPath: code[0] === 'R' ? oldPath : undefined })
    } else {
      const path = parts[i++]
      if (path !== undefined) out.set(path, { status })
    }
  }
  return out
}

/**
 * `git diff --numstat -z -M`: `add\tdel\tpath\0`, or for a rename `add\tdel\t\0old\0new\0`.
 * Binary files report `-` for both counts. Joined with the name-status map for the status.
 */
export function parseNumstat(
  raw: string,
  statuses: Map<string, { status: DiffStatus; oldPath?: string }>
): DiffFile[] {
  const parts = raw.split('\0')
  const files: DiffFile[] = []
  for (let i = 0; i < parts.length;) {
    const head = parts[i++]
    if (!head) continue
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head)
    if (!match) continue
    const binary = match[1] === '-'
    let path = match[3] ?? ''
    let oldPath: string | undefined
    if (path === '') {
      oldPath = parts[i++]
      path = parts[i++] ?? ''
    }
    const known = statuses.get(path)
    files.push({
      path,
      oldPath: known?.oldPath ?? oldPath,
      status: known?.status ?? (oldPath ? 'renamed' : 'modified'),
      additions: binary ? 0 : Number(match[1]),
      deletions: binary ? 0 : Number(match[2]),
      binary,
      uncommitted: false,
      origin: 'committed'
    })
  }
  return files
}

/** Untracked paths from `git ls-files --others --exclude-standard -z`, as `added` entries. */
export function untrackedFiles(raw: string, known: Set<string>): DiffFile[] {
  return raw
    .split('\0')
    .filter((path) => path && !known.has(path))
    .map((path) => ({
      path,
      status: 'added' as const,
      additions: 0,
      deletions: 0,
      binary: false,
      uncommitted: true,
      origin: 'untracked' as const
    }))
}

/** Counts `+`/`-` lines in a unified patch, ignoring the file headers. */
export function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  let inHunk = false
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) inHunk = true
    else if (!inHunk) continue
    else if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  return { additions, deletions }
}

/** Drops the `diff --git`/`index`/`---`/`+++` preamble and truncates very long lines. */
export function cleanPatch(patch: string): string {
  const lines = patch.split('\n')
  const start = lines.findIndex((line) => line.startsWith('@@'))
  const body = start === -1 ? [] : lines.slice(start)
  return body
    .map((line) =>
      line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… (line truncated)` : line
    )
    .join('\n')
}
