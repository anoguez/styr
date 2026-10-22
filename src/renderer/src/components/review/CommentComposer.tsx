import type { ReactNode } from 'react'
import { formatAccelerator, matchesAccelerator } from '@core/shortcuts.js'
import { Button, Chip, inputBase } from '../ui.js'

const SAVE_KEY = 'mod+enter'

/**
 * Writes one review comment under a diff line. Driven from the keyboard once open: ⌘↵ (Ctrl+Enter
 * off macOS) adds it, Esc cancels this composer only, never the dialog around it.
 */
export function CommentComposer({
  refLabel,
  body,
  editing,
  outdated = false,
  onChange,
  onSave,
  onCancel
}: {
  /** "Line 42" or "Old line 42". */
  refLabel: string
  body: string
  editing: boolean
  /** Its line is gone from the refreshed diff; the draft stays open at the top of the file. */
  outdated?: boolean
  onChange: (body: string) => void
  onSave: () => void
  onCancel: () => void
}): ReactNode {
  const blank = !body.trim()
  return (
    <div className="flex max-w-[680px] flex-col gap-2 rounded-[10px] border border-accent bg-panel py-2.5 pl-3 pr-2.5 shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent)_22%,transparent)]">
      <span className="flex items-center gap-2 text-[11.5px] text-dim">
        <span>
          Comment on <span className="font-mono text-[10.5px] text-ink">{refLabel}</span>
        </span>
        {outdated ? <Chip tone="warn">Outdated</Chip> : null}
      </span>
      <textarea
        // The composer opens on a click and is meant to be typed into at once.
        autoFocus
        rows={3}
        value={body}
        aria-label="Comment"
        placeholder="What should the agent change here?"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onCancel()
          } else if (matchesAccelerator(event, SAVE_KEY)) {
            event.preventDefault()
            event.stopPropagation()
            onSave()
          }
        }}
        className={`${inputBase} box-border min-h-16 w-full resize-y px-2.5 py-2 text-[12.5px] leading-normal`}
        style={{ fontFamily: 'var(--font-ui)' }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 whitespace-nowrap text-[11px] text-faint">
          {formatAccelerator(SAVE_KEY)} to {editing ? 'save' : 'add'} · Esc to cancel
        </span>
        <Button variant="subtle" className="h-7 px-2.5" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" className="h-7" disabled={blank} onClick={onSave}>
          {editing ? 'Save' : 'Add comment'}
        </Button>
      </div>
    </div>
  )
}
