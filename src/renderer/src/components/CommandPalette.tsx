import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { rankBy } from '../lib/fuzzy.js'
import { splitQuery, type PaletteMode } from '../lib/paletteMode.js'
import { inputClass } from './ui.js'

export type CommandGroup = 'Tasks' | 'Agents' | 'Terminals' | 'Workspaces' | 'Settings' | 'Actions'

export type { PaletteMode }

export interface CommandEntry {
  id: string
  label: string
  group: CommandGroup
  mode: PaletteMode
  hint?: string
  keywords?: string
  run: () => void
  /** Optional second action, offered on ⌘↵. */
  altLabel?: string
  runAlt?: () => void
}

const GROUP_ORDER: CommandGroup[] = [
  'Actions',
  'Workspaces',
  'Tasks',
  'Agents',
  'Terminals',
  'Settings'
]

function searchText(entry: CommandEntry): string {
  return [entry.label, entry.hint, entry.keywords, entry.group].filter(Boolean).join(' ')
}

const PLACEHOLDERS: Record<PaletteMode, string> = {
  go: 'Go to a task, agent or terminal… (type > for commands)',
  command: 'Run a command…'
}

export function CommandPalette({
  entries,
  initialMode,
  onClose
}: {
  entries: CommandEntry[]
  initialMode: PaletteMode
  onClose: () => void
}): ReactNode {
  const [raw, setRaw] = useState(initialMode === 'command' ? '>' : '')
  const { mode, text: query } = splitQuery(raw)
  const [active, setActive] = useState(0)
  const list = useRef<HTMLUListElement>(null)

  const matches = useMemo(() => {
    const inMode = entries.filter((entry) => entry.mode === mode)
    const ranked = rankBy(query, inMode, searchText).map((result) => result.item)
    if (query.trim().length > 0) return ranked.slice(0, 40)
    return [...ranked]
      .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
      .slice(0, 40)
  }, [entries, mode, query])

  useEffect(() => setActive(0), [raw])

  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, matches])

  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      event.preventDefault()
      setActive((current) => (matches.length === 0 ? 0 : (current + 1) % matches.length))
    } else if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault()
      setActive((current) =>
        matches.length === 0 ? 0 : (current - 1 + matches.length) % matches.length
      )
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const entry = matches[active]
      if (!entry) return
      if ((event.metaKey || event.ctrlKey) && entry.runAlt) entry.runAlt()
      else entry.run()
      onClose()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
  }

  let lastGroup: CommandGroup | null = null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-8 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-[60vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-edge-strong bg-panel shadow-[0_24px_60px_-12px_rgba(0,0,0,0.75)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-edge p-2.5">
          <input
            autoFocus
            value={raw}
            placeholder={PLACEHOLDERS[mode]}
            onChange={(event) => setRaw(event.target.value)}
            onKeyDown={onKeyDown}
            className={`${inputClass} border-transparent bg-transparent text-[14px] focus:border-transparent focus:ring-0`}
          />
        </div>

        {matches.length === 0 ? (
          <p className="px-4 py-6 text-center text-[12.5px] text-faint">Nothing matches that</p>
        ) : (
          <ul ref={list} className="flex-1 overflow-y-auto p-1.5">
            {matches.map((entry, index) => {
              const header = entry.group !== lastGroup ? entry.group : null
              lastGroup = entry.group
              const selected = index === active
              return (
                <li key={entry.id}>
                  {header ? (
                    <p className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-faint">
                      {header}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    data-active={selected}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => {
                      entry.run()
                      onClose()
                    }}
                    className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors ${
                      selected ? 'bg-raised text-ink' : 'text-dim hover:bg-raised/60'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate text-[12.5px]">{entry.label}</span>
                    {entry.hint ? (
                      <span className="shrink-0 font-mono text-[10px] text-faint">
                        {entry.hint}
                      </span>
                    ) : null}
                    {selected && entry.altLabel ? (
                      <span className="shrink-0 rounded bg-chrome px-1.5 py-[1px] text-[10px] text-faint">
                        ⌘↵ {entry.altLabel}
                      </span>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
