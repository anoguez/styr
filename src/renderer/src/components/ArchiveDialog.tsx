import type { ReactNode } from 'react'
import { TASK_STATUS_LABELS, type Task } from '@core/types.js'
import { Button, Modal } from './ui.js'

function archivedOn(task: Task): string {
  const date = task.archivedAt ? new Date(task.archivedAt) : null
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString() : ''
}

export function ArchiveDialog({
  tasks,
  onOpen,
  onClose
}: {
  tasks: Task[]
  onOpen: (task: Task) => void
  onClose: () => void
}): ReactNode {
  return (
    <Modal
      title="Archive"
      subtitle="Archived tasks are off the board and out of Dispatch. Their files are kept."
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {tasks.length === 0 ? (
        <p className="py-6 text-center text-[12px] text-faint">Nothing archived</p>
      ) : (
        <ul className="flex flex-col divide-y divide-edge overflow-hidden rounded-lg border border-edge-strong bg-chrome">
          {tasks.map((task) => (
            <li key={task.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px] text-ink">{task.title}</p>
                <p className="mt-0.5 font-mono text-[10.5px] text-faint">
                  {task.id} · {TASK_STATUS_LABELS[task.status]}
                  {archivedOn(task) ? ` · archived ${archivedOn(task)}` : ''}
                </p>
              </div>
              <Button onClick={() => onOpen(task)}>View</Button>
              <Button onClick={() => void window.api.tasks.archive(task.id, false)}>
                Unarchive
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
