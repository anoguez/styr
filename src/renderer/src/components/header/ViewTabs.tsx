import type { ReactNode } from 'react'
import { shortcutHint } from '@core/shortcuts.js'
import type { ShortcutBindings } from '@core/types.js'
import type { View } from '../../lib/appShell.js'

/** Board | Inbox, with the count of tasks that need you on Inbox. */
export function ViewTabs({
  view,
  needsYou,
  bindings,
  onChange
}: {
  view: View
  needsYou: number
  bindings: ShortcutBindings
  onChange: (view: View) => void
}): ReactNode {
  return (
    <div
      role="tablist"
      aria-label="View"
      className="flex h-7 items-center gap-0.5 rounded-lg border border-edge-strong bg-chrome p-0.5"
    >
      {(
        [
          { id: 'board', label: 'Board', command: 'viewBoard' },
          { id: 'inbox', label: 'Inbox', command: 'viewInbox' }
        ] as const
      ).map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={view === tab.id}
          title={`${tab.label} view ${shortcutHint(bindings, tab.command)}`.trim()}
          onClick={() => onChange(tab.id)}
          className={`inline-flex h-[22px] items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium transition-colors ${
            view === tab.id
              ? 'border-edge-strong bg-raised text-ink'
              : 'border-transparent text-dim hover:text-ink'
          }`}
        >
          {tab.label}
          {tab.id === 'inbox' && needsYou > 0 ? (
            <span className="rounded-[5px] bg-[var(--color-col-review)]/15 px-[5px] font-mono text-[10.5px] font-semibold leading-4 text-[var(--color-col-review-text)]">
              {needsYou}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  )
}
