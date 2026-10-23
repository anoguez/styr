import type { ReactNode } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ORCHESTRATION_LANE_LABELS, type OrchestrationSummary } from '@core/types.js'

/** One task in the Dispatch dialog: a drag handle, a checkbox, its position and what it runs as. */
export function DispatchRow({
  entry,
  position,
  checked,
  onToggle
}: {
  entry: OrchestrationSummary['dispatch'][number]
  /** Its place among the checked rows; unchecked rows show none. */
  position: number | null
  checked: boolean
  onToggle: (checked: boolean) => void
}): ReactNode {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: entry.taskId })
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`flex items-center gap-3 bg-chrome px-3 py-2.5 ${isDragging ? 'relative z-10 opacity-70' : ''}`}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        aria-label={`Reorder ${entry.taskId}`}
        title="Drag to reorder"
        className="shrink-0 cursor-grab touch-none text-faint hover:text-ink focus-visible:outline-2 focus-visible:outline-accent active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <svg aria-hidden viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
          <circle cx="6" cy="4" r="1.2" />
          <circle cx="10" cy="4" r="1.2" />
          <circle cx="6" cy="8" r="1.2" />
          <circle cx="10" cy="8" r="1.2" />
          <circle cx="6" cy="12" r="1.2" />
          <circle cx="10" cy="12" r="1.2" />
        </svg>
      </button>
      <input
        type="checkbox"
        checked={checked}
        aria-label={`Start ${entry.taskId}`}
        onChange={(event) => onToggle(event.target.checked)}
        className="size-[15px] shrink-0 accent-[var(--color-accent)]"
      />
      <span className={`flex min-w-0 flex-1 items-center gap-3 ${checked ? '' : 'opacity-50'}`}>
        <span className="grid size-[18px] shrink-0 place-items-center rounded-[5px] bg-accent font-mono text-[10px] font-semibold text-[var(--color-on-accent)]">
          {position ?? ''}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] text-ink">{entry.title}</span>
          <span className="font-mono text-[10px] text-faint">{entry.taskId}</span>
        </span>
        <span className="shrink-0 rounded bg-raised px-1.5 py-[1px] text-[10.5px] text-dim">
          {ORCHESTRATION_LANE_LABELS[entry.lane]} ·{' '}
          {entry.provider === 'codex' ? 'Codex' : 'Claude'}
        </span>
      </span>
    </li>
  )
}
