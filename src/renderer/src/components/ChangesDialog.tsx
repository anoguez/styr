import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DiffFile, DiffResult, PatchResult, TaskDiff } from '@core/diff.js'
import { buildRows } from '@core/diffView.js'
import type { Task } from '@core/types.js'
import { DiffPane } from './DiffPane.js'
import { Glyph, PaneMessage, Spinner } from './changesParts.js'
import { Modal, StatusBadge, type FileStatusLetter } from './ui.js'

const NARROW_BELOW = 900
const LAYOUT_KEY = 'styr.changes.layout'

type Layout = 'flat' | 'tree'
interface LoadedPatch {
  version: number
  result: PatchResult
  full: boolean
}

const LETTER: Record<DiffFile['status'], FileStatusLetter> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R'
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

function splitPath(path: string): [string, string] {
  const at = path.lastIndexOf('/')
  return at < 0 ? ['', path] : [path.slice(0, at), path.slice(at + 1)]
}

function updatedLabel(at: number | undefined, now: number): string {
  if (at === undefined) return 'Loading…'
  const minutes = Math.floor((now - at) / 60_000)
  return minutes < 1 ? 'Updated just now' : `Updated ${minutes} min ago`
}

const filesLabel = (count: number): string =>
  `${count.toLocaleString()} ${count === 1 ? 'file' : 'files'}`

interface TreeFolder {
  dirs: Map<string, TreeFolder>
  files: DiffFile[]
}

type ListRow =
  | { kind: 'folder'; key: string; name: string; count: number; depth: number; open: boolean }
  | { kind: 'file'; file: DiffFile; depth: number }

function treeRows(files: DiffFile[], collapsed: Set<string>): ListRow[] {
  const root: TreeFolder = { dirs: new Map(), files: [] }
  for (const file of files) {
    let node = root
    for (const part of splitPath(file.path)[0].split('/').filter(Boolean)) {
      const next = node.dirs.get(part) ?? { dirs: new Map(), files: [] }
      node.dirs.set(part, next)
      node = next
    }
    node.files.push(file)
  }
  const count = (node: TreeFolder): number =>
    node.files.length + [...node.dirs.values()].reduce((sum, child) => sum + count(child), 0)
  const rows: ListRow[] = []
  const walk = (node: TreeFolder, depth: number, prefix: string): void => {
    for (const name of [...node.dirs.keys()].sort()) {
      let child = node.dirs.get(name)!
      let label = name
      // Collapse chains of single-child folders into one row: src/renderer/src.
      while (child.files.length === 0 && child.dirs.size === 1) {
        const [only] = [...child.dirs.keys()]
        label += `/${only}`
        child = child.dirs.get(only!)!
      }
      const key = prefix + label
      const open = !collapsed.has(key)
      rows.push({ kind: 'folder', key, name: label, count: count(child), depth, open })
      if (open) walk(child, depth + 1, `${key}/`)
    }
    for (const file of node.files) rows.push({ kind: 'file', file, depth })
  }
  walk(root, 0, '')
  return rows
}

function Counts({
  file
}: {
  file: Pick<DiffFile, 'additions' | 'deletions' | 'binary'>
}): ReactNode {
  if (file.binary) return <span className="text-faint">bin</span>
  return (
    <>
      <span className="text-[var(--color-col-done-text)]">+{file.additions}</span>
      <span className="text-danger">−{file.deletions}</span>
    </>
  )
}

const UNCOMMITTED_DOT = (
  <span
    aria-label="Uncommitted"
    title="Uncommitted"
    className="box-border size-1.5 shrink-0 rounded-full border-[1.5px] border-[var(--color-col-review-text)]"
  />
)

/** Read-only view of what a task changed: one combined, file-by-file unified diff. */
export function ChangesDialog({ task, onClose }: { task: Task; onClose: () => void }): ReactNode {
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

  const load = useCallback(() => {
    const request = ++requestRef.current
    void window.api.git.taskDiff(task.id).then((next) => {
      if (request !== requestRef.current) return
      if (!('error' in next)) for (const file of next.files) knownFiles.current.set(file.path, file)
      setResult(next)
      setLoadedAt(Date.now())
      setVersion((current) => current + 1)
    })
  }, [task.id])

  useEffect(load, [load])

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
        .filePatch(task.id, path, full)
        .then((patch) =>
          setPatches((all) => ({ ...all, [path]: { version, result: patch, full } }))
        )
    },
    [task.id, version]
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

  const repoName = splitPath(task.repoPath ?? '')[1]
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

  const iconButton =
    'inline-flex size-7 items-center justify-center rounded-lg border border-transparent text-dim hover:bg-raised/70 hover:text-ink'

  const fileCurrent = current
  const [curDir, curName] = fileCurrent ? splitPath(fileCurrent.path) : ['', '']

  const fileList = (
    <aside
      className={
        narrow
          ? `absolute inset-x-2 top-[50px] z-[6] ${drawer ? 'flex' : 'hidden'} h-[min(440px,calc(100%-64px))] min-h-0 flex-col overflow-hidden rounded-xl border border-edge-strong bg-panel shadow-[0_16px_40px_-8px_rgba(0,0,0,0.7)]`
          : 'flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-edge bg-chrome/50'
      }
    >
      <div className="flex shrink-0 flex-col gap-2 px-2.5 pb-2 pt-2.5">
        <div className="relative">
          <span className="pointer-events-none absolute left-[9px] top-1/2 -translate-y-1/2 text-faint">
            <Glyph name="search" />
          </span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Filter files"
            placeholder="Filter files"
            className="box-border h-7 w-full rounded-lg border border-edge-strong bg-chrome pl-[29px] pr-2.5 text-[12.5px] text-ink outline-none focus:border-accent focus:shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-accent)_40%,transparent)]"
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <div
            role="radiogroup"
            aria-label="File layout"
            className="inline-flex gap-0.5 rounded-lg border border-edge-strong bg-panel p-0.5"
          >
            {(['flat', 'tree'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={layout === value}
                onClick={() => setLayout(value)}
                className={`h-[22px] rounded-md px-2.5 text-[12px] font-medium ${layout === value ? 'bg-raised text-ink' : 'text-dim'}`}
              >
                {value === 'flat' ? 'List' : 'Tree'}
              </button>
            ))}
          </div>
          {diff?.kind !== 'repo' ? (
            <span
              title="Not committed yet: staged, unstaged or untracked"
              className="inline-flex items-center gap-[5px] text-[11px] text-faint"
            >
              {UNCOMMITTED_DOT}Uncommitted
            </span>
          ) : null}
        </div>
      </div>
      <div
        ref={listRef}
        role="listbox"
        tabIndex={0}
        aria-label="Changed files"
        className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1.5 pb-2 pt-0.5 outline-offset-[-2px]"
      >
        {isLoading
          ? [
              '52%/28%',
              '38%/34%',
              '44%/22%',
              '30%/40%',
              '56%/18%',
              '36%/30%',
              '48%/24%',
              '32%/36%'
            ].map((pair) => {
              const [a, b] = pair.split('/')
              return (
                <div key={pair} className="flex h-7 items-center gap-2 px-2">
                  <span className="size-4 shrink-0 rounded bg-raised" />
                  <span className="h-[9px] rounded bg-raised" style={{ width: a }} />
                  <span className="h-[9px] rounded bg-raised opacity-55" style={{ width: b }} />
                </div>
              )
            })
          : null}
        {listRows.map((row) => {
          if (row.kind === 'folder') {
            return (
              <button
                key={`d:${row.key}`}
                type="button"
                aria-expanded={row.open}
                onClick={() =>
                  setCollapsed((all) => {
                    const next = new Set(all)
                    if (!next.delete(row.key)) next.add(row.key)
                    return next
                  })
                }
                className="flex h-[26px] shrink-0 items-center gap-1.5 rounded-md pr-2 text-left text-[12px] text-dim hover:bg-raised/60 hover:text-ink"
                style={{ paddingLeft: 8 + row.depth * 14 }}
              >
                <span className={`shrink-0 text-faint ${row.open ? '' : '-rotate-90'}`}>
                  <Glyph name="chevron" size={11} />
                </span>
                <span className="min-w-0 truncate font-medium">{row.name}</span>
                <span className="ml-auto shrink-0 font-mono text-[10.5px] text-faint">
                  {row.count}
                </span>
              </button>
            )
          }
          const { file } = row
          const [dir, name] = splitPath(file.path)
          const on = current?.path === file.path
          const renamed = file.oldPath && splitPath(file.oldPath)[1] !== name
          return (
            <div
              key={file.path}
              role="option"
              aria-selected={on}
              onClick={() => select(file.path)}
              title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
              className={`flex h-7 shrink-0 cursor-pointer items-center gap-2 rounded-md border pr-2 hover:bg-raised ${on ? 'border-edge-strong bg-raised' : 'border-transparent'}`}
              style={{ paddingLeft: 8 + row.depth * 14 }}
            >
              <StatusBadge status={LETTER[file.status]} />
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden whitespace-nowrap">
                {renamed ? (
                  <>
                    <span className="shrink-0 text-[12.5px] text-faint line-through decoration-faint/60">
                      {splitPath(file.oldPath!)[1]}
                    </span>
                    <span aria-hidden className="shrink-0 text-[11px] text-faint">
                      →
                    </span>
                  </>
                ) : null}
                <span className="shrink-0 text-[12.5px] font-semibold text-ink">{name}</span>
                {layout === 'flat' ? (
                  <span className="min-w-0 truncate text-[11px] text-faint">{dir}</span>
                ) : null}
              </span>
              {file.uncommitted && diff?.kind !== 'repo' ? UNCOMMITTED_DOT : null}
              <span className="flex shrink-0 gap-[5px] font-mono text-[10.5px]">
                {file.status === 'renamed' && file.additions + file.deletions === 0 ? (
                  <span className="text-faint">100%</span>
                ) : (
                  <Counts file={file} />
                )}
              </span>
            </div>
          )
        })}
        {!isLoading && visible.length === 0 ? (
          <p className="m-0 px-2 py-4 text-center text-[12px] text-faint">
            No files match “{query}”
          </p>
        ) : null}
      </div>
      {diff && diff.omitted > 0 ? (
        <div className="flex shrink-0 flex-col gap-0.5 border-t border-edge px-3.5 py-[9px]">
          <span className="text-[11.5px] text-dim">
            Showing {diff.files.length.toLocaleString()} of {diff.totalFiles.toLocaleString()} files
          </span>
          <span className="text-[11px] leading-[1.45] text-faint">
            Filter by path to reach the rest.
          </span>
        </div>
      ) : null}
    </aside>
  )

  return (
    <Modal title={`Changes — ${task.title}`} onClose={onClose} bare xl>
      <div
        ref={rootRef}
        role="dialog"
        aria-label={`Changes — ${task.title}`}
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden text-[13px] text-ink"
        onKeyDown={(event) => {
          const tag = (event.target as HTMLElement).tagName
          if (tag === 'INPUT' || tag === 'TEXTAREA') return
          const inList = listRef.current?.contains(event.target as Node)
          if (event.key === 'j' || (inList && event.key === 'ArrowDown')) {
            event.preventDefault()
            move(1)
          } else if (event.key === 'k' || (inList && event.key === 'ArrowUp')) {
            event.preventDefault()
            move(-1)
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
                  {task.repoPath} · no worktree for this task
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
            {fileList}
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
                tabIndex={0}
                role="region"
                aria-label={`Diff of ${fileCurrent?.path ?? ''}`}
                className="relative flex min-h-0 flex-1 flex-col overflow-auto bg-chrome outline-offset-[-2px]"
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
            ['↑↓', 'J K', 'Files'],
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
          <span className="ml-auto">
            {diff?.note ??
              (diff?.kind === 'repo'
                ? 'Read-only · working tree vs HEAD'
                : diff?.mergeBase
                  ? `Read-only · against merge base ${diff.mergeBase}`
                  : 'Read-only')}
          </span>
        </footer>
      </div>
    </Modal>
  )
}
