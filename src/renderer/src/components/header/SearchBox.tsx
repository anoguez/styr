import type { ReactNode, RefObject } from 'react'
import { shortcutHint } from '@core/shortcuts.js'
import type { ShortcutBindings } from '@core/types.js'
import { inputClass } from '../ui.js'

/** The board's search field: ✕ clears it, and the focus shortcut shows while it is empty. */
export function SearchBox({
  query,
  inputRef,
  bindings,
  onChange
}: {
  query: string
  inputRef: RefObject<HTMLInputElement | null>
  bindings: ShortcutBindings
  onChange: (query: string) => void
}): ReactNode {
  return (
    <div className="relative w-full max-w-md [-webkit-app-region:no-drag]">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint">
        ⌕
      </span>
      <input
        ref={inputRef}
        className={`${inputClass} h-7 py-0 pl-8 pr-12`}
        value={query}
        placeholder="Search tasks"
        onChange={(event) => onChange(event.target.value)}
      />
      {query ? (
        <button
          type="button"
          aria-label="Clear search"
          className="absolute right-3 top-1/2 -translate-y-1/2 text-faint hover:text-ink"
          onClick={() => onChange('')}
        >
          ✕
        </button>
      ) : (
        <kbd className="pointer-events-none absolute right-2 top-1/2 inline-flex h-[18px] -translate-y-1/2 items-center rounded border border-edge-strong px-[5px] font-mono text-[10.5px] text-faint">
          {shortcutHint(bindings, 'focusSearch')}
        </kbd>
      )}
    </div>
  )
}
