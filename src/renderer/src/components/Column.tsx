import type { ReactNode } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type { AgentStatus } from '@core/agentState.js'
import { TASK_STATUS_LABELS, type Task, type TaskStatus } from '@core/types.js'
import { TaskCard, type QueuedForOrchestration } from './TaskCard.js'

const COLUMN_ACCENT: Record<TaskStatus, string> = {
  backlog: 'var(--color-col-backlog)',
  in_progress: 'var(--color-col-progress)',
  in_review: 'var(--color-col-review)',
  done: 'var(--color-col-done)'
}

const EMPTY_HINT: Record<TaskStatus, string> = {
  backlog: 'Nothing queued up',
  in_progress: 'Nothing in flight',
  in_review: 'Nothing waiting on you',
  done: 'Nothing shipped yet'
}

export function Column({
  status,
  tasks,
  agents,
  queued,
  onOpen,
  onLaunch,
  templateNameFor
}: {
  status: TaskStatus
  tasks: Task[]
  agents: Map<string, AgentStatus>
  queued: Map<string, QueuedForOrchestration>
  onOpen: (task: Task) => void
  onLaunch: (task: Task) => void
  templateNameFor: (task: Task) => string
}): ReactNode {
  const { setNodeRef, isOver } = useDroppable({ id: `column:${status}` })
  const accent = COLUMN_ACCENT[status]

  return (
    <section className="flex min-h-0 w-full flex-col">
      <header className="flex items-center gap-2 px-1 pb-2.5">
        <span
          aria-hidden
          className="size-[7px] rounded-full"
          style={{ backgroundColor: accent }}
        />
        <h2 className="text-[12px] font-semibold tracking-[-0.005em] text-ink">
          {TASK_STATUS_LABELS[status]}
        </h2>
        <span className="rounded-md bg-raised px-1.5 py-[1px] font-mono text-[10.5px] text-dim">
          {tasks.length}
        </span>
      </header>

      <div
        ref={setNodeRef}
        className={`flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-xl border border-t-2 p-2 transition-colors duration-150 ${
          isOver ? 'border-dashed border-accent/60 bg-accent/[0.07]' : 'border-edge bg-panel/80'
        }`}
        style={
          isOver
            ? undefined
            : { borderTopColor: `color-mix(in oklab, ${accent} 60%, transparent)` }
        }
      >
        <SortableContext items={tasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              agent={agents.get(task.id)}
              queued={queued.get(task.id)}
              onOpen={onOpen}
              onLaunch={onLaunch}
              templateNameFor={templateNameFor}
            />
          ))}
        </SortableContext>

        {tasks.length === 0 ? (
          <p className="m-auto select-none px-2 text-center text-[11.5px] text-faint/70">
            {EMPTY_HINT[status]}
          </p>
        ) : null}
      </div>
    </section>
  )
}
