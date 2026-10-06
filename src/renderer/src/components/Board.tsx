import { useState, type ReactNode } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import type { AgentStatus } from '@core/agentState.js'
import { TASK_STATUSES, type Task, type TaskStatus } from '@core/types.js'
import type { TaskBoard } from '../hooks/useTasks.js'
import type { DiffStat } from '@core/diff.js'
import { TaskCardBody, type QueuedForOrchestration } from './TaskCard.js'
import { Column } from './Column.js'

function statusOf(board: TaskBoard, id: string): TaskStatus | null {
  if (id.startsWith('column:')) return id.slice('column:'.length) as TaskStatus
  return TASK_STATUSES.find((status) => board[status].some((task) => task.id === id)) ?? null
}

export function Board({
  board,
  agents,
  queued,
  onOpen,
  onLaunch,
  onArchive,
  onShowChanges,
  onOpenTerminal,
  diffStats,
  doneFooter,
  onQuickAdd,
  templateNameFor
}: {
  board: TaskBoard
  agents: Map<string, AgentStatus>
  queued: Map<string, QueuedForOrchestration>
  onOpen: (task: Task) => void
  onLaunch: (task: Task) => void
  onArchive: (task: Task) => void
  onShowChanges: (task: Task) => void
  onOpenTerminal: (task: Task) => void
  diffStats: Map<string, DiffStat>
  /** Rendered at the foot of the Done column: the hidden count and its controls. */
  doneFooter?: ReactNode
  /** Double-click on empty Backlog space. */
  onQuickAdd?: () => void
  templateNameFor: (task: Task) => string
}): ReactNode {
  const [dragging, setDragging] = useState<Task | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  function handleDragStart(event: DragStartEvent): void {
    const source = statusOf(board, String(event.active.id))
    setDragging(source ? (board[source].find((task) => task.id === event.active.id) ?? null) : null)
  }

  async function handleDragEnd(event: DragEndEvent): Promise<void> {
    setDragging(null)
    const { active, over } = event
    if (!over) return

    const activeId = String(active.id)
    const from = statusOf(board, activeId)
    const to = statusOf(board, String(over.id))
    if (!from || !to) return

    // Done is ordered by completion date, so there is no manual position to set there.
    if (from === to && to === 'done') return

    if (from === to) {
      const ids = board[to].map((task) => task.id)
      const oldIndex = ids.indexOf(activeId)
      const newIndex = ids.indexOf(String(over.id))
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return
      await window.api.tasks.reorder(to, arrayMove(ids, oldIndex, newIndex))
      return
    }

    const targetIds = board[to].map((task) => task.id)
    const insertAt = String(over.id).startsWith('column:')
      ? targetIds.length
      : Math.max(targetIds.indexOf(String(over.id)), 0)
    targetIds.splice(insertAt, 0, activeId)

    if (to !== 'done') await window.api.tasks.reorder(to, targetIds)
    await window.api.tasks.reorder(
      from,
      board[from].filter((task) => task.id !== activeId).map((task) => task.id)
    )
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={(event) => void handleDragEnd(event)}
      onDragCancel={() => setDragging(null)}
    >
      <div className="grid min-h-0 flex-1 grid-cols-4 gap-3.5 px-4 py-4">
        {TASK_STATUSES.map((status) => (
          <Column
            key={status}
            status={status}
            tasks={board[status]}
            agents={agents}
            queued={queued}
            onOpen={onOpen}
            onLaunch={onLaunch}
            onArchive={onArchive}
            onShowChanges={onShowChanges}
            onOpenTerminal={onOpenTerminal}
            diffStats={diffStats}
            footer={status === 'done' ? doneFooter : undefined}
            onDoubleClickEmpty={status === 'backlog' ? onQuickAdd : undefined}
            templateNameFor={templateNameFor}
          />
        ))}
      </div>
      <DragOverlay>
        {dragging ? (
          <article className="w-[17rem] rotate-[1.5deg] cursor-grabbing rounded-[var(--radius-card)] border border-accent/50 bg-raised py-3 pl-3.5 pr-3 shadow-[0_18px_40px_-10px_rgba(0,0,0,0.75)]">
            <TaskCardBody task={dragging} diffStat={diffStats.get(dragging.id)} />
          </article>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
