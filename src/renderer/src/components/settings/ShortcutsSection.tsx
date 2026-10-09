import { useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { DEFAULT_SHORTCUTS, SHORTCUT_COMMANDS, type ShortcutCommand } from '@core/types.js'
import {
  acceleratorFor,
  formatAccelerator,
  isReserved,
  SHORTCUT_LABELS,
  SHORTCUT_SCOPES,
  shortcutConflicts
} from '@core/shortcuts.js'
import { Card, Hint } from '../ui.js'
import type { SectionProps } from './sections.js'

function ShortcutRow({
  command,
  bindings,
  conflicted,
  onChange
}: {
  command: ShortcutCommand
  bindings: string[]
  conflicted: boolean
  onChange: (next: string[]) => void
}): ReactNode {
  const [recording, setRecording] = useState(false)
  const [rejected, setRejected] = useState('')

  function capture(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      setRecording(false)
      setRejected('')
      return
    }
    const accelerator = acceleratorFor(event)
    if (!accelerator) return
    if (isReserved(accelerator)) {
      setRejected(`${formatAccelerator(accelerator)} belongs to the terminal`)
      return
    }
    onChange([accelerator])
    setRecording(false)
    setRejected('')
  }

  const isDefault = bindings.join(' ') === DEFAULT_SHORTCUTS[command].join(' ')
  const keys = bindings.length === 0 ? 'Not bound' : bindings.map(formatAccelerator).join(' ')

  return (
    <div className="flex items-center gap-3 border-t border-edge py-2 pl-3.5 pr-2.5 first:border-t-0">
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="truncate text-[12.5px] text-ink">{SHORTCUT_LABELS[command]}</span>
        {SHORTCUT_SCOPES[command] === 'terminal' ? (
          <span className="shrink-0 text-[11px] text-faint">in the terminal</span>
        ) : null}
      </span>

      {rejected ? (
        <span className="shrink-0 text-[11px] text-col-review-text">{rejected}</span>
      ) : null}

      {bindings.length > 0 ? (
        <button
          type="button"
          className="h-6 rounded-md px-1.5 text-[11.5px] text-faint transition-colors hover:text-ink"
          onClick={() => onChange([])}
        >
          Clear
        </button>
      ) : null}
      {!isDefault || bindings.length === 0 ? (
        <button
          type="button"
          className="h-6 rounded-md px-1.5 text-[11.5px] text-faint transition-colors hover:text-ink"
          onClick={() => onChange([...DEFAULT_SHORTCUTS[command]])}
        >
          Reset
        </button>
      ) : null}

      <button
        type="button"
        title="Click, then press the new keys"
        onKeyDown={recording ? capture : undefined}
        onBlur={() => setRecording(false)}
        onClick={() => {
          setRecording((on) => !on)
          setRejected('')
        }}
        className={`inline-flex h-[26px] min-w-24 items-center justify-center rounded-[7px] border px-2 font-mono text-[11.5px] transition-colors ${
          recording
            ? 'border-accent bg-accent/15 text-[var(--color-accent-text)]'
            : conflicted
              ? 'border-col-review bg-panel text-col-review-text'
              : 'border-edge-strong bg-panel text-ink hover:border-faint'
        }`}
      >
        {recording ? 'Press keys…' : keys}
      </button>
    </div>
  )
}

export function ShortcutsSection({ draft, patch }: SectionProps): ReactNode {
  const conflicts = shortcutConflicts(draft.shortcuts)
  return (
    <>
      <Card>
        {SHORTCUT_COMMANDS.map((command) => (
          <ShortcutRow
            key={command}
            command={command}
            bindings={draft.shortcuts[command]}
            conflicted={draft.shortcuts[command].some((accelerator) => conflicts.has(accelerator))}
            onChange={(next) => patch({ shortcuts: { ...draft.shortcuts, [command]: next } })}
          />
        ))}
      </Card>

      {conflicts.size > 0 ? (
        <p className="text-[11.5px] text-col-review-text">
          {[...conflicts]
            .map(
              ([accelerator, commands]) =>
                `${formatAccelerator(accelerator)} is bound to ${commands
                  .map((command) => SHORTCUT_LABELS[command])
                  .join(' and ')}`
            )
            .join('; ')}
          . The first in the list wins.
        </p>
      ) : null}

      <Hint>
        Click Change and press the new keys. Esc closes a dialog and{' '}
        {formatAccelerator('mod+enter')} saves one; both are fixed. Ctrl+C, Ctrl+D, Ctrl+L, Ctrl+Z,
        Esc, Enter and Tab cannot be bound — the terminal needs them.
      </Hint>
    </>
  )
}
