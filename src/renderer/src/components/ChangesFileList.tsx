import type { ReactNode, RefObject } from 'react'
import type { DiffFile, TaskDiff } from '@core/diff.js'
import { plural } from '@core/review.js'
import { Glyph } from './changesParts.js'
import { StatusBadge, type FileStatusLetter } from './ui.js'

export type Layout = 'flat' | 'tree'

export const LETTER: Record<DiffFile['status'], FileStatusLetter> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R'
}

export function splitPath(path: string): [string, string] {
  const at = path.lastIndexOf('/')
  return at < 0 ? ['', path] : [path.slice(0, at), path.slice(at + 1)]
}

interface TreeFolder {
  dirs: Map<string, TreeFolder>
  files: DiffFile[]
}

export type ListRow =
  | { kind: 'folder'; key: string; name: string; count: number; depth: number; open: boolean }
  | { kind: 'file'; file: DiffFile; depth: number }

export function treeRows(files: DiffFile[], collapsed: Set<string>): ListRow[] {
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

/** A file's pending review comments, beside its name. */
export function CommentCount({ count }: { count: number }): ReactNode {
  if (count === 0) return null
  const label = plural(count, 'comment')
  return (
    <span
      title={label}
      aria-label={label}
      className="inline-flex shrink-0 items-center gap-[3px] font-mono text-[10.5px] text-[var(--color-accent-text)]"
    >
      <Glyph name="comment" size={11} />
      {count}
    </span>
  )
}

/** The Changes dialog's file list: filter, List / Tree, and the files; a drawer when narrow. */
export function ChangesFileList({
  narrow,
  drawer,
  query,
  layout,
  diff,
  isLoading,
  listRows,
  visible,
  current,
  comments,
  listRef,
  onQuery,
  onLayout,
  onToggleFolder,
  onSelect
}: {
  narrow: boolean
  drawer: boolean
  query: string
  layout: Layout
  diff: TaskDiff | null
  isLoading: boolean
  listRows: ListRow[]
  visible: DiffFile[]
  current: DiffFile | undefined
  /** Pending review comments per path. */
  comments: ReadonlyMap<string, number>
  listRef: RefObject<HTMLDivElement | null>
  onQuery: (query: string) => void
  onLayout: (layout: Layout) => void
  onToggleFolder: (key: string) => void
  onSelect: (path: string) => void
}): ReactNode {
  return (
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
            onChange={(event) => onQuery(event.target.value)}
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
                onClick={() => onLayout(value)}
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
                onClick={() => onToggleFolder(row.key)}
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
              onClick={() => onSelect(file.path)}
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
              <CommentCount count={comments.get(file.path) ?? 0} />
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
}
