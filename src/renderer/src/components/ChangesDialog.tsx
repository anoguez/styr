import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { DiffFile, DiffResult, PatchResult, TaskDiff } from '@core/diff.js'
import { buildRows } from '@core/diffView.js'
import type { ReviewSent, Task } from '@core/types.js'
import { useTaskReview } from '../hooks/useTaskReview.js'
import { TaskLookupContext } from '../lib/blockerContext.js'
import { pendingByPath } from '../lib/reviewLayout.js'
import {
  ChangesFileList,
  CommentCount,
  LETTER,
  splitPath,
  treeRows,
  type Layout,
  type ListRow
} from './ChangesFileList.js'
import { DiffPane } from './DiffPane.js'
import { Glyph, PaneMessage, Spinner } from './changesParts.js'
import { RequestChangesSheet } from './review/RequestChangesSheet.js'
import { ReviewFooter, ReviewHint } from './review/ReviewFooter.js'
import { ReviewCommentList } from './review/ReviewCommentList.js'
import { useCommentJump } from './review/useCommentJump.js'
import { useDiffPaneReview } from './review/useDiffPaneReview.js'
import { repoDisplayNames } from '@core/repoNames.js'
import { Modal, Segmented, StatusBadge } from './ui.js'

const NARROW_BELOW = 900
const LAYOUT_KEY = 'styr.changes.layout'

interface LoadedPatch {
  version: number
  result: PatchResult
  full: boolean
}

const ORIGIN_LABEL: Record<DiffFile['origin'], string> = {
  committed: 'Committed',
  uncommitted: 'Uncommitted',
  untracked: 'Untracked',
  both: 'Committed + uncommitted'
}

function readLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'tree' ? 'tree' : 'flat'
  } catch {
    return 'flat'
  }
}

function updatedLabel(at: number | undefined, now: number): string {
  if (at === undefined) return 'Loading…'
  const minutes = Math.floor((now - at) / 60_000)
  return minutes < 1 ? 'Updated just now' : `Updated ${minutes} min ago`
}

const filesLabel = (count: number): string =>
  `${count.toLocaleString()} ${count === 1 ? 'file' : 'files'}`

interface RepoTotals {
  files: number
  additions: number
  deletions: number
}

/**
 * What a task changed: one combined, file-by-file unified diff, where the person can leave review
 * comments on lines and send them to the task's agent with Request changes. A multi-repo task adds
 * a switcher at the top and shows one repository's diff at a time (the choice is UI state only).
 */
export function ChangesDialog({
  task,
  onClose,
  onSent
}: {
  task: Task
  onClose: () => void
  /** Request changes delivered: the dialog closes and the app confirms it. */
  onSent: (sent: ReviewSent) => void
}): ReactNode {
  const paths = useMemo(
    () => [
      ...(task.repoPath ? [task.repoPath] : []),
      ...(task.useWorktree ? task.extraRepos.map((extra) => extra.repoPath) : [])
    ],
    [task.repoPath, task.useWorktree, task.extraRepos]
  )
  const [repo, setRepo] = useState<string | undefined>(undefined)
  const [totals, setTotals] = useState<Record<string, RepoTotals | undefined>>({})
  const multi = paths.length > 1

  // Every repository's own totals for the switcher, read again when the task file changes.
  useEffect(() => {
    if (!multi) return
    let live = true
    for (const path of paths) {
      void window.api.git.taskDiff(task.id, path).then((next) => {
        if (live) setTotals((all) => ({ ...all, [path]: totalsOf(next) }))
      })
    }
    return () => {
      live = false
    }
  }, [multi, paths, task.id, task.updatedAt])

  if (!multi) return <ChangesView task={task} onClose={onClose} onSent={onSent} />
  const names = repoDisplayNames(paths)
  const active = repo && paths.includes(repo) ? repo : (paths[0] as string)
  const options = paths.map((path, index) => ({
    value: path,
    label: repoLabel(names[index] as string, totals[path])
  }))
  return (
    <ChangesView
      key={active}
      task={task}
      repo={active}
      onClose={onClose}
      onSent={onSent}
      onLoaded={(next) => setTotals((all) => ({ ...all, [active]: totalsOf(next) }))}
      switcher={
        options.length <= 3 ? (
          <Segmented label="Repository" value={active} options={options} onChange={setRepo} />
        ) : (
          <div role="tablist" aria-label="Repository" className="flex gap-1 overflow-x-auto">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="tab"
                aria-selected={option.value === active}
                onClick={() => setRepo(option.value)}
                className={`h-6 shrink-0 whitespace-nowrap rounded-md px-2.5 text-[12px] font-medium ${
                  option.value === active ? 'bg-raised text-ink' : 'text-dim hover:text-ink'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        )
      }
    />
  )
}

function totalsOf(result: DiffResult): RepoTotals | undefined {
  return 'error' in result
    ? undefined
    : {
        files: result.totalFiles,
        additions: result.totalAdditions,
        deletions: result.totalDeletions
      }
}

/** `api · 3 files +10 −2`, or `api · No changes`; just the name while the totals load. */
function repoLabel(name: string, totals: RepoTotals | undefined): string {
  if (!totals) return name
  if (totals.files === 0) return `${name} · No changes`
  return `${name} · ${totals.files} ${totals.files === 1 ? 'file' : 'files'} +${totals.additions.toLocaleString()} −${totals.deletions.toLocaleString()}`
}

function ChangesView({
  task,
  repo,
  switcher,
  onLoaded,
  onClose,
  onSent
}: {
  task: Task
  /** The repository of a multi-repo task to show; unset is the task's own. */
  repo?: string
  switcher?: ReactNode
  onLoaded?: (result: DiffResult) => void
  onClose: () => void
  onSent: (sent: ReviewSent) => void
}): ReactNode {
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const requestRef = useRef(0)
  const knownFiles = useRef(new Map<string, DiffFile>())

  const [result, setResult] = useState<DiffResult | null>(null)
  const [version, setVersion] = useState(0)
  const [loadedAt, setLoadedAt] = useState<number>()
  const [now, setNow] = useState(() => Date.now())
  const [patches, setPatches] = useState<Record<string, LoadedPatch>>({})
  const [selected, setSelected] = useState<string>()
  const [query, setQuery] = useState('')
  const [layout, setLayoutState] = useState<Layout>(readLayout)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [wrap, setWrap] = useState(false)
  const [narrow, setNarrow] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [copied, setCopied] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [showComments, setShowComments] = useState(false)
  const [commentQuery, setCommentQuery] = useState('')
  const diffRef = useRef<HTMLDivElement>(null)
  const reviewState = useTaskReview(task.id)

  const load = useCallback(() => {
    const request = ++requestRef.current
    void window.api.git.taskDiff(task.id, repo).then((next) => {
      if (request !== requestRef.current) return
      onLoaded?.(next)
      if (!('error' in next)) for (const file of next.files) knownFiles.current.set(file.path, file)
      setResult(next)
      setLoadedAt(Date.now())
      setVersion((current) => current + 1)
    })
    // `onLoaded` is the parent's setter and changes with each render; the request does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, repo])

  useEffect(load, [load])

  // Take focus on open: the dialog's keys only work from inside it.
  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < NARROW_BELOW)
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  // App closes every dialog on Escape; with the file drawer open, Escape closes only the drawer.
  useEffect(() => {
    if (!drawer) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setDrawer(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [drawer])

  const diff: TaskDiff | null = result && !('error' in result) ? result : null
  const error = result && 'error' in result ? result.error : undefined
  const isLoading = result === null
  const files = useMemo(() => diff?.files ?? [], [diff])
  const needle = query.trim().toLowerCase()
  const visible = useMemo(
    () =>
      needle
        ? files.filter((file) =>
            `${file.path} ${file.oldPath ?? ''}`.toLowerCase().includes(needle)
          )
        : files,
    [files, needle]
  )

  // A file that vanished on refresh stays selected, with its last patch, until the user moves on.
  const inList = visible.find((file) => file.path === selected)
  const ghost =
    !inList && selected && patches[selected] ? knownFiles.current.get(selected) : undefined
  const current = inList ?? ghost ?? visible[0]
  const stale = Boolean(ghost && !inList)
  const currentIndex = current ? visible.indexOf(current) : -1

  const fetchPatch = useCallback(
    (path: string, full: boolean) => {
      void window.api.git
        .filePatch(task.id, path, full, repo)
        .then((patch) =>
          setPatches((all) => ({ ...all, [path]: { version, result: patch, full } }))
        )
    },
    [task.id, repo, version]
  )

  const entry = current ? patches[current.path] : undefined
  useEffect(() => {
    if (!current || stale) return
    if (entry && entry.version === version) return
    fetchPatch(current.path, entry?.full ?? false)
    // Only refetch when the file or the list version changes, not on every patch arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.path, version, stale])

  const rows = useMemo(
    () => (entry && 'patch' in entry.result ? buildRows(entry.result.patch) : []),
    [entry]
  )
  const comments = useMemo(() => pendingByPath(reviewState.review), [reviewState.review])
  const lookup = useContext(TaskLookupContext)
  const jump = useCommentJump({
    region: diffRef,
    review: reviewState.review,
    openFile: (path) => {
      setSelected(path)
      setDrawer(false)
      setSheet(false)
    },
    expand: (path) => {
      if (current?.path !== path || !entry || entry.version !== version || entry.full) return false
      fetchPatch(path, true)
      return true
    }
  })
  const paneReview = useDiffPaneReview(
    reviewState,
    current?.path,
    rows,
    Boolean(!stale && entry && 'patch' in entry.result),
    jump.focusId
  )
  const { checkOutdated } = reviewState
  const pendingCount = reviewState.pending.length
  // The Comments tab marks outdated comments in every file, which the host works out from each
  // file's patch: when the tab opens and on a refresh only, never on each comment's save.
  useEffect(() => {
    if (showComments) checkOutdated()
  }, [showComments, version, checkOutdated])
  const outdated = useMemo(
    () =>
      new Set([...reviewState.outdated, ...(paneReview?.layout.outdated.map((c) => c.id) ?? [])]),
    [reviewState.outdated, paneReview]
  )
  const outdatedPending = reviewState.pending.filter((c) => outdated.has(c.id)).length
  const openComments = (): void => {
    setShowComments(true)
    if (narrow) setDrawer(true)
  }

  const select = (path: string): void => {
    setSelected(path)
    setDrawer(false)
  }
  const move = (step: 1 | -1): void => {
    const next = visible[Math.min(visible.length - 1, Math.max(0, currentIndex + step))]
    if (next) setSelected(next.path)
  }
  const setLayout = (next: Layout): void => {
    setLayoutState(next)
    try {
      localStorage.setItem(LAYOUT_KEY, next)
    } catch {
      // not remembered
    }
  }

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [current?.path, layout])

  const copyPath = (): void => {
    if (!current) return
    void navigator.clipboard.writeText(current.path).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  const listRows: ListRow[] = useMemo(
    () =>
      layout === 'tree'
        ? treeRows(visible, collapsed)
        : visible.map((file) => ({ kind: 'file', file, depth: 0 })),
    [layout, visible, collapsed]
  )

  const repoPath = repo ?? task.repoPath ?? ''
  const repoName = splitPath(repoPath)[1]
  const uncommitted = files.filter((file) => file.uncommitted).length
  const branchLabel = diff?.branch

  let message:
    | {
        glyph: string
        tone: 'faint' | 'done' | 'danger'
        title: string
        body: string
        detail?: string
        action?: string
      }
    | undefined
  if (error) {
    message = {
      glyph: '!',
      tone: 'danger',
      title: 'Couldn’t read changes',
      body: 'Git returned an error. The board and the rest of Styr are unaffected.',
      detail: error,
      action: 'Retry'
    }
  } else if (diff?.kind === 'empty') {
    message = {
      glyph: '∅',
      tone: 'faint',
      title: 'No changes yet',
      body: `Changes appear here once the agent edits files on ${branchLabel}.`
    }
  } else if (diff?.kind === 'landed') {
    message = {
      glyph: '✓',
      tone: 'done',
      title: 'Landed',
      body: `This branch has been merged into ${diff.baseName}. Nothing ahead of base.`
    }
  } else if (diff?.kind === 'gone') {
    message = {
      glyph: '—',
      tone: 'faint',
      title: 'Worktree no longer exists',
      body: `It was cleaned up after the task landed.${diff.branchKept ? ` The branch ${diff.branch} is kept.` : ''}`
    }
  } else if (diff?.kind === 'repo' && diff.files.length === 0) {
    message = {
      glyph: '∅',
      tone: 'faint',
      title: 'No changes yet',
      body: `${repoName} has no uncommitted changes.`
    }
  }

  // Commenting needs the diff on screen: not in the whole-dialog states, nor while loading.
  const reviewing = !message && !isLoading && entry !== undefined

  const iconButton =
    'inline-flex size-7 items-center justify-center rounded-lg border border-transparent text-dim hover:bg-raised/70 hover:text-ink'

  const fileCurrent = current
  const [curDir, curName] = fileCurrent ? splitPath(fileCurrent.path) : ['', '']

  return (
    <Modal title={`Changes — ${task.title}`} onClose={onClose} bare xl>
      <div
        ref={rootRef}
        role="dialog"
        tabIndex={-1}
        aria-label={`Changes — ${task.title}`}
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden text-[13px] text-ink outline-none"
        onKeyDown={(event) => {
          const tag = (event.target as HTMLElement).tagName
          if (tag === 'INPUT' || tag === 'TEXTAREA') return
          // Arrows walk the files from the list or the bare dialog; in the diff they scroll it.
          const inList =
            event.target === event.currentTarget || listRef.current?.contains(event.target as Node)
          // On the Comments tab they walk the comments instead, across files.
          const step = showComments ? jump.step : move
          if (event.key === 'j' || (inList && event.key === 'ArrowDown')) {
            event.preventDefault()
            step(1)
          } else if (event.key === 'k' || (inList && event.key === 'ArrowUp')) {
            event.preventDefault()
            step(-1)
          }
        }}
      >
        <header className="flex shrink-0 items-start gap-4 border-b border-edge py-3.5 pl-5 pr-3 pb-3">
          <div className="flex min-w-0 flex-1 flex-col gap-[7px]">
            <div className="flex min-w-0 items-baseline gap-2.5">
              <span className="shrink-0 font-mono text-[10.5px] text-faint">{task.id}</span>
              <h2 className="m-0 min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em]">
                {task.title}
              </h2>
            </div>
            {switcher}
            {isLoading ? (
              <div className="flex h-5 items-center gap-2.5">
                <span className="h-2.5 w-[190px] rounded bg-raised" />
                <span className="h-2.5 w-[110px] rounded bg-raised opacity-60" />
              </div>
            ) : null}
            {diff && diff.kind !== 'repo' && diff.kind !== 'gone' ? (
              <div className="flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-dim">
                {branchLabel ? (
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <span
                      title="Task branch"
                      className="inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-accent/15 px-[7px] font-mono text-[11px] text-[var(--color-accent-text)]"
                    >
                      <Glyph name="branch" size={11} />
                      {branchLabel}
                    </span>
                    <span aria-hidden className="text-faint">
                      →
                    </span>
                    <span className="inline-flex h-5 shrink-0 items-center gap-[5px] whitespace-nowrap rounded-md border border-edge px-[7px] font-mono text-[11px] text-ink">
                      {diff.baseName}
                      <span className="font-[var(--font-ui)] text-[10px] font-semibold uppercase tracking-[0.06em] text-faint">
                        base
                      </span>
                    </span>
                  </span>
                ) : null}
                {diff.kind === 'changes' ? (
                  <>
                    <span className="inline-flex items-center gap-2 font-mono text-[11.5px]">
                      <span className="text-dim">{filesLabel(diff.totalFiles)}</span>
                      <span className="text-[var(--color-col-done-text)]">
                        +{diff.totalAdditions.toLocaleString()}
                      </span>
                      <span className="text-danger">−{diff.totalDeletions.toLocaleString()}</span>
                    </span>
                    {uncommitted > 0 ? (
                      <span className="inline-flex items-center gap-1.5 text-[11.5px] text-dim">
                        <span className="box-border size-1.5 rounded-full border-[1.5px] border-[var(--color-col-review-text)]" />
                        {uncommitted} uncommitted
                      </span>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
            {diff?.kind === 'repo' ? (
              <div className="flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-dim">
                <span className="inline-flex items-center gap-1.5 text-ink">
                  Uncommitted changes in <span className="font-semibold">{repoName}</span>
                </span>
                <span className="font-mono text-[11px] text-faint">
                  {repoPath} · no worktree, working in the main checkout
                </span>
                <span className="inline-flex items-center gap-2 font-mono text-[11.5px]">
                  <span className="text-dim">{filesLabel(diff.totalFiles)}</span>
                  <span className="text-[var(--color-col-done-text)]">
                    +{diff.totalAdditions.toLocaleString()}
                  </span>
                  <span className="text-danger">−{diff.totalDeletions.toLocaleString()}</span>
                </span>
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <span className="whitespace-nowrap px-1.5 text-[11.5px] text-faint">
              {error ? 'Failed just now' : updatedLabel(loadedAt, now)}
            </span>
            <button
              type="button"
              aria-label="Refresh"
              title="Refresh"
              className={iconButton}
              onClick={load}
            >
              <Glyph name="refresh" size={14} />
            </button>
            <button
              type="button"
              aria-label="Close"
              title="Close (Esc)"
              className={iconButton}
              onClick={onClose}
            >
              <Glyph name="close" size={14} />
            </button>
          </div>
        </header>

        {message ? (
          <div className="flex min-h-0 flex-1 bg-chrome">
            <PaneMessage
              glyph={message.glyph}
              tone={message.tone}
              title={message.title}
              body={message.body}
              detail={message.detail}
              action={message.action}
              onAction={load}
            />
          </div>
        ) : (
          <div
            className={`relative grid min-h-0 flex-1 ${narrow ? 'grid-cols-[minmax(0,1fr)]' : 'grid-cols-[300px_minmax(0,1fr)]'}`}
          >
            <ChangesFileList
              narrow={narrow}
              drawer={drawer}
              query={showComments ? commentQuery : query}
              layout={layout}
              showComments={showComments}
              pendingCount={pendingCount}
              commentSummary={
                pendingCount
                  ? `${pendingCount} pending${outdatedPending ? ` · ${outdatedPending} outdated` : ''}`
                  : ''
              }
              commentList={
                <ReviewCommentList
                  review={reviewState.review}
                  outdated={outdated}
                  query={commentQuery}
                  focusId={jump.focusId}
                  onGo={jump.go}
                />
              }
              diff={diff}
              isLoading={isLoading}
              listRows={listRows}
              visible={visible}
              current={current}
              comments={comments}
              listRef={listRef}
              onQuery={showComments ? setCommentQuery : setQuery}
              onLayout={(next) => {
                setShowComments(false)
                setLayout(next)
              }}
              onShowComments={() => setShowComments(true)}
              onToggleFolder={(key) =>
                setCollapsed((all) => {
                  const next = new Set(all)
                  if (!next.delete(key)) next.add(key)
                  return next
                })
              }
              onSelect={select}
            />
            <section className="flex min-h-0 min-w-0 flex-col">
              {narrow ? (
                <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-edge bg-chrome/50 px-2">
                  <button
                    type="button"
                    aria-haspopup="listbox"
                    aria-expanded={drawer}
                    onClick={() => setDrawer((open) => !open)}
                    className="flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-lg border border-edge-strong bg-chrome pl-2 pr-2.5 text-left"
                  >
                    {fileCurrent ? <StatusBadge status={LETTER[fileCurrent.status]} /> : null}
                    <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden whitespace-nowrap">
                      <span className="shrink-0 text-[12.5px] font-semibold text-ink">
                        {curName}
                      </span>
                      <span className="min-w-0 truncate text-[11px] text-faint">{curDir}</span>
                    </span>
                    <CommentCount count={fileCurrent ? (comments.get(fileCurrent.path) ?? 0) : 0} />
                    <span className="shrink-0 font-mono text-[10.5px] text-faint">
                      {currentIndex >= 0 ? `${currentIndex + 1} of ${visible.length}` : ''}
                    </span>
                    <span className="shrink-0 text-dim">
                      <Glyph name="chevron" size={12} />
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label="Previous file (K)"
                    title="Previous file (K)"
                    onClick={() => move(-1)}
                    className="inline-flex size-[30px] items-center justify-center rounded-lg border border-edge-strong bg-raised/70 text-dim"
                  >
                    <Glyph name="up" />
                  </button>
                  <button
                    type="button"
                    aria-label="Next file (J)"
                    title="Next file (J)"
                    onClick={() => move(1)}
                    className="inline-flex size-[30px] items-center justify-center rounded-lg border border-edge-strong bg-raised/70 text-dim"
                  >
                    <Glyph name="chevron" />
                  </button>
                </div>
              ) : null}

              <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-edge bg-panel pl-3.5 pr-2">
                {isLoading ? (
                  <>
                    <span className="size-4 rounded bg-raised" />
                    <span className="h-2.5 w-[260px] rounded bg-raised" />
                  </>
                ) : null}
                {fileCurrent && !isLoading ? (
                  <>
                    <StatusBadge status={LETTER[fileCurrent.status]} />
                    <span
                      title={fileCurrent.path}
                      className="flex min-w-0 items-baseline gap-2 overflow-hidden whitespace-nowrap"
                    >
                      <span className="min-w-0 truncate font-mono text-[11.5px]">
                        <span className="text-faint">{curDir ? `${curDir}/` : ''}</span>
                        <span className="text-ink">{curName}</span>
                      </span>
                      {fileCurrent.oldPath ? (
                        <span className="shrink-0 text-[11px] text-faint">
                          from{' '}
                          {splitPath(fileCurrent.oldPath)[0] === curDir
                            ? splitPath(fileCurrent.oldPath)[1]
                            : fileCurrent.oldPath}
                        </span>
                      ) : null}
                    </span>
                    {fileCurrent.uncommitted && diff?.kind !== 'repo' ? (
                      <span className="inline-flex h-[18px] shrink-0 items-center rounded-md bg-[color-mix(in_oklab,var(--color-col-review)_15%,transparent)] px-1.5 text-[10.5px] font-medium text-[var(--color-col-review-text)]">
                        {ORIGIN_LABEL[fileCurrent.origin]}
                      </span>
                    ) : null}
                    {!fileCurrent.binary ? (
                      <span className="flex shrink-0 gap-1.5 font-mono text-[11px]">
                        <span className="text-[var(--color-col-done-text)]">
                          +{fileCurrent.additions}
                        </span>
                        <span className="text-danger">−{fileCurrent.deletions}</span>
                      </span>
                    ) : null}
                    <div aria-hidden className="min-w-3 flex-1" />
                    <button
                      type="button"
                      onClick={() => setWrap((on) => !on)}
                      aria-pressed={wrap}
                      title="Wrap long lines"
                      className={`inline-flex h-[26px] shrink-0 items-center gap-[5px] whitespace-nowrap rounded-[7px] border px-2 text-[12px] font-medium ${wrap ? 'border-edge-strong bg-raised text-ink' : 'border-transparent text-dim'}`}
                    >
                      <Glyph name="wrap" />
                      Wrap
                    </button>
                    <button
                      type="button"
                      onClick={copyPath}
                      title="Copy path"
                      aria-label="Copy path"
                      className="inline-flex h-[26px] shrink-0 items-center gap-[5px] whitespace-nowrap rounded-[7px] border border-transparent px-2 text-[12px] font-medium text-dim hover:bg-raised/70 hover:text-ink"
                    >
                      <Glyph name="copy" />
                      {narrow ? '' : copied ? 'Copied' : 'Copy path'}
                    </button>
                  </>
                ) : null}
              </div>

              <div
                ref={diffRef}
                tabIndex={0}
                role="region"
                aria-label={`Diff of ${fileCurrent?.path ?? ''}`}
                className="relative flex min-h-0 flex-1 flex-col overflow-auto bg-chrome outline-offset-[-2px] [container-type:inline-size]"
              >
                {isLoading ? (
                  <Spinner label="Reading file list…" />
                ) : fileCurrent ? (
                  <DiffPane
                    file={fileCurrent}
                    patch={entry?.result}
                    rows={rows}
                    wrap={wrap}
                    stale={stale}
                    review={paneReview}
                    onFold={() => fetchPatch(fileCurrent.path, true)}
                    onRefresh={load}
                  />
                ) : null}
              </div>
            </section>
          </div>
        )}

        <footer className="flex min-h-[34px] shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-edge bg-chrome/40 px-3.5 py-1.5 text-[11.5px] text-faint">
          {[
            ['↑↓', 'J K', showComments ? 'Comments' : 'Files'],
            ['⇥', '', 'Focus diff'],
            ['Esc', '', 'Close']
          ].map(([a, b, label]) => (
            <span key={label} className="inline-flex items-center gap-1.5">
              {[a, b].filter(Boolean).map((key) => (
                <kbd
                  key={key}
                  className="inline-flex h-[18px] items-center rounded border border-edge-strong px-[5px] font-mono text-[10.5px] text-dim"
                >
                  {key}
                </kbd>
              ))}
              {label}
            </span>
          ))}
          {reviewing ? <ReviewHint /> : null}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1.5">
            <span>
              {diff?.note ??
                (diff?.kind === 'repo'
                  ? 'Working tree vs HEAD'
                  : diff?.mergeBase
                    ? `Against merge base ${diff.mergeBase}`
                    : '')}
            </span>
            <ReviewFooter
              active={reviewing}
              pending={pendingCount}
              lastSent={reviewState.review.lastSent}
              saveError={reviewState.saveError}
              onShowComments={openComments}
              onRequestChanges={() => setSheet(true)}
            />
          </div>
        </footer>
        {sheet && reviewState.pending.length > 0 ? (
          <RequestChangesSheet
            task={lookup.get(task.id) ?? task}
            pending={reviewState.pending}
            onClose={() => setSheet(false)}
            onJump={jump.go}
            onSend={async (summary) => {
              const sent = await reviewState.requestChanges(summary)
              onSent(sent)
              return sent
            }}
          />
        ) : null}
      </div>
    </Modal>
  )
}
