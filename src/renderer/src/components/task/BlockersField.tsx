import type { ReactNode } from 'react'
import { indexTasks } from '@core/blocking.js'
import { TASK_STATUS_LABELS, type Task } from '@core/types.js'
import { blockerState } from '../../lib/taskForm.js'
import { Select } from '../ui.js'
import { RemoveButton, SECTION_LABEL } from './fields.js'

/** The tasks this one waits on, a picker for more, and warnings for cycles and unknown ids. */
export function BlockersField({
  taskId,
  blockedBy,
  allTasks,
  onChange
}: {
  /** Unset for a new task, which can be in no cycle yet. */
  taskId: string | undefined
  blockedBy: string[]
  allTasks: Task[]
  onChange: (blockedBy: string[]) => void
}): ReactNode {
  const { missing, cycle, choices } = blockerState(taskId, blockedBy, allTasks)
  const lookup = indexTasks(allTasks)
  return (
    <div className="flex flex-col gap-2">
      <span className={SECTION_LABEL}>Blocked by</span>
      <div className="flex flex-col items-stretch gap-1.5">
        {blockedBy.map((id) => {
          const blocker = lookup.get(id)
          return (
            <span
              key={id}
              title={blocker ? `${id} — ${blocker.title}` : `${id} does not exist`}
              className={`inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-[7px] border bg-card pl-2 pr-1 text-[12px] ${
                blocker
                  ? 'border-edge text-ink'
                  : 'border-[var(--color-col-review)]/50 text-[var(--color-col-review-text)]'
              }`}
            >
              <span className="font-mono text-[10.5px]">{id}</span>
              <span className="truncate">
                {blocker ? `${blocker.title} · ${TASK_STATUS_LABELS[blocker.status]}` : 'unknown'}
              </span>
              <RemoveButton
                label={`Remove blocker ${id}`}
                onClick={() => onChange(blockedBy.filter((current) => current !== id))}
              />
            </span>
          )
        })}
        <Select
          compact
          aria-label="Add blocker"
          value=""
          onChange={(event) => {
            if (event.target.value) onChange([...blockedBy, event.target.value])
          }}
        >
          <option value="">Add blocker…</option>
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id} disabled={choice.cycle}>
              {choice.id} — {choice.title}
              {choice.cycle ? ' (would create a cycle)' : ''}
            </option>
          ))}
        </Select>
      </div>
      <span className="text-[11px] text-faint">The task waits until each of these is Done.</span>
      {cycle ? (
        <span className="text-[11px] text-[var(--color-col-review-text)]">
          Dependency cycle: {cycle.join(' → ')}. None of these can start.
        </span>
      ) : null}
      {missing.length > 0 ? (
        <span className="text-[11px] text-[var(--color-col-review-text)]">
          {missing.join(', ')} not found — ignored until it exists. Remove it to clear this.
        </span>
      ) : null}
    </div>
  )
}
