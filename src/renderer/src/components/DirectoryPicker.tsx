import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { fuzzyScore } from '../lib/fuzzy.js'

interface Listing {
  path: string
  parent: string | null
  names: string[]
}

interface Entry {
  key: string
  label: string
  path: string
  parent?: boolean
}

const icon = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

function Kbd({ children }: { children: ReactNode }): ReactNode {
  return <span className="font-mono">{children}</span>
}

/**
 * The terminal's "change directory" popover: browse one folder at a time and filter it by typing.
 * It only lists and chooses; the caller decides how a choice reaches the shell.
 */
export function DirectoryPicker({
  start,
  onChoose,
  onClose
}: {
  start: string
  onChoose: (path: string) => void
  onClose: () => void
}): ReactNode {
  const [listing, setListing] = useState<Listing>({ path: start, parent: null, names: [] })
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const [browse, setBrowse] = useState(start)

  useEffect(() => {
    let current = true
    void window.api.terminal.listDirectories(browse).then((result) => {
      if (current) setListing(result)
    })
    return () => {
      current = false
    }
  }, [browse])

  useEffect(() => input.current?.focus(), [])

  const entries = useMemo<Entry[]>(() => {
    const dirs = listing.names
      .map((name) => ({ name, score: fuzzyScore(query, name) }))
      .filter((item): item is { name: string; score: number } => item.score !== null)
      .sort((a, b) => b.score - a.score)
      .map<Entry>(({ name }) => ({
        key: name,
        label: name,
        path: `${listing.path === '/' ? '' : listing.path}/${name}`
      }))
    if (query.trim() || !listing.parent) return dirs
    return [{ key: '..', label: '..', path: listing.parent, parent: true }, ...dirs]
  }, [listing, query])

  const go = (path: string): void => {
    setBrowse(path)
    setQuery('')
    setActive(0)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    const entry = entries[active]
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((index) => (entries.length ? (index + step + entries.length) % entries.length : 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (event.metaKey || event.ctrlKey) onChoose(listing.path)
      else if (entry?.parent) go(entry.path)
      else if (entry) onChoose(entry.path)
    } else if ((event.key === 'ArrowRight' || event.key === 'Tab') && entry && !entry.parent) {
      event.preventDefault()
      go(entry.path)
    } else if (event.key === 'ArrowLeft' && !query && listing.parent) {
      event.preventDefault()
      go(listing.parent)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
  }

  return (
    <div
      role="dialog"
      aria-label="Change directory"
      className="pointer-events-auto absolute bottom-full left-1.5 z-20 mb-1 flex max-h-72 w-[360px] max-w-[calc(100%-12px)] flex-col overflow-hidden rounded-lg border border-edge-strong bg-panel shadow-2xl"
    >
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-edge px-2.5">
        <svg aria-hidden viewBox="0 0 16 16" width="14" height="14" className="shrink-0 text-faint">
          <g {...icon}>
            <circle cx="7" cy="7" r="4.25" />
            <path d="m10.25 10.25 3.25 3.25" />
          </g>
        </svg>
        <input
          ref={input}
          value={query}
          aria-label="Search directories"
          placeholder="Filter directories…"
          className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-faint"
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="flex h-[26px] shrink-0 items-center gap-2 px-2.5 font-mono text-[10.5px] text-faint">
        <span className="min-w-0 flex-1 truncate text-left" style={{ direction: 'rtl' }}>
          <bdi>{listing.path}</bdi>
        </span>
        {listing.path !== start ? (
          <button
            type="button"
            className="inline-flex h-[18px] shrink-0 items-center gap-1.5 rounded bg-raised px-1.5 font-sans text-[11px] font-medium text-ink"
            onClick={() => onChoose(listing.path)}
          >
            cd here <span className="font-mono text-[10px] text-dim">⌘↵</span>
          </button>
        ) : null}
      </div>
      <div role="listbox" className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
        {entries.map((entry, index) => (
          <div
            key={entry.key}
            role="option"
            aria-selected={index === active}
            className={`flex h-[26px] cursor-pointer items-center gap-2 rounded-md px-2 text-[12.5px] ${
              index === active ? 'bg-raised text-ink' : 'text-dim'
            }`}
            onMouseEnter={() => setActive(index)}
            onClick={() => (entry.parent ? go(entry.path) : onChoose(entry.path))}
          >
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              width="13"
              height="13"
              className="shrink-0 text-faint"
            >
              {entry.parent ? (
                <path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" {...icon} />
              ) : (
                <path
                  d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"
                  {...icon}
                />
              )}
            </svg>
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{entry.label}</span>
            {entry.path === start ? (
              <span className="text-[10.5px] text-col-done">current</span>
            ) : null}
          </div>
        ))}
        {entries.length === 0 ? (
          <div className="px-2 py-3.5 text-[12px] leading-normal text-faint">
            {query.trim() ? `No directories match “${query}”.` : 'No sub-directories here.'}
          </div>
        ) : null}
      </div>
      <div className="flex min-h-[26px] shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-edge px-2.5 py-1 text-[10.5px] text-faint">
        <span>
          <Kbd>↵</Kbd> cd
        </span>
        <span>
          <Kbd>→</Kbd> browse
        </span>
        <span>
          <Kbd>←</Kbd> up
        </span>
        <span>
          <Kbd>esc</Kbd> close
        </span>
      </div>
    </div>
  )
}
