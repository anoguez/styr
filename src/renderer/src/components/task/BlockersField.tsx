import type { ReactNode } from 'react'
import { indexTasks } from '@core/blocking.js'
import { TASK_STATUS_LABELS, type Task } from '@core/types.js'
import { blockerState } from '../../lib/taskForm.js'
import { PlusIcon } from '../icons.js'
import { PROP_LABEL, RemoveButton, STATUS_DOT } from './fields.js'

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
    <div className="grid grid-cols-[84px_minmax(0,1fr)] items-start gap-2">
      <span className={`${PROP_LABEL} pt-2`} title="The task waits until each of these is Done.">
        Blocked by
      </span>
      <div className="flex min-w-0 flex-col gap-1 py-0.5">
        {blockedBy.map((id) => {
          const blocker = lookup.get(id)
          return (
            <span
              key={id}
              title={
                blocker
                  ? `${id} — ${blocker.title} · ${TASK_STATUS_LABELS[blocker.status]}`
                  : `${id} does not exist`
              }
              className={`flex h-[26px] min-w-0 items-center gap-1.5 rounded-[7px] border bg-card pl-2 pr-[3px] text-[12px] ${
                blocker
                  ? 'border-edge text-ink'
                  : 'border-[var(--color-col-review)]/50 text-[var(--color-col-review-text)]'
              }`}
            >
              <span
                aria-hidden
                className="size-1.5 shrink-0 rounded-full"
                style={{
                  background: blocker ? STATUS_DOT[blocker.status] : 'var(--color-col-review)'
                }}
              />
              <span className="shrink-0 font-mono text-[10.5px]">{id}</span>
              <span className="min-w-0 flex-1 truncate">{blocker ? blocker.title : 'unknown'}</span>
              <RemoveButton
                label={`Remove blocker ${id}`}
                onClick={() => onChange(blockedBy.filter((current) => current !== id))}
              />
            </span>
          )
        })}
        <span className="relative block">
          <select
            aria-label="Add blocker"
            value=""
            onChange={(event) => {
              if (event.target.value) onChange([...blockedBy, event.target.value])
            }}
            className="h-7 w-full cursor-pointer appearance-none rounded-[7px] border border-transparent bg-transparent pl-2 pr-[26px] text-[12.5px] text-faint outline-none hover:border-edge hover:bg-card hover:text-ink focus:border-accent"
          >
            <option value="" className="bg-chrome text-ink">
              Add blocker…
            </option>
            {choices.map((choice) => (
              <option
                key={choice.id}
                value={choice.id}
                disabled={choice.cycle}
                className="bg-chrome text-ink"
              >
                {choice.id} — {choice.title}
                {choice.cycle ? ' (would create a cycle)' : ''}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-faint">
            <PlusIcon size={12} />
          </span>
        </span>
        {cycle ? (
          <span
            title={`${cycle.join(' → ')}. None of these can start.`}
            className="text-[11px] leading-[1.4] text-[var(--color-col-review-text)]"
          >
            Dependency cycle.
          </span>
        ) : null}
        {missing.length > 0 ? (
          <span
            title="Ignored until it exists. Remove it to clear this."
            className="text-[11px] leading-[1.4] text-[var(--color-col-review-text)]"
          >
            {missing.join(', ')} not found.
          </span>
        ) : null}
      </div>
    </div>
  )
}
