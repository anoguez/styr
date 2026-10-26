import { useEffect, useState, type ReactNode } from 'react'
import type { Settings, Task } from '@core/types.js'
import type { TaskForm } from '../../lib/taskForm.js'
import { fileName } from '../../lib/terminalPath.js'
import { BranchIcon, ChevronIcon, FolderIcon } from '../icons.js'
import { WorkspaceFields } from './AgentRunFields.js'

/**
 * Where the task runs, as a compact button beside the title: the directory's name and, with a
 * worktree, its branch. It opens the directory, worktree, base branch and extra repos.
 */
export function WorkspaceMenu({
  form,
  patch,
  task,
  taskId,
  settings,
  onClose
}: {
  form: TaskForm
  patch: (changes: Partial<TaskForm>) => void
  task: Task | null
  taskId: string
  settings: Settings
  onClose: () => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  // Esc closes the menu, not the dialog behind it.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  const directory = form.repoPath.trim() || settings.defaultRepoPath
  const name = fileName(directory) || 'Workspace folder'
  const title = form.useWorktree
    ? `${directory || 'Workspace folder'} · own worktree on styr/${taskId}`
    : `Runs in ${directory || 'the workspace folder'}`
  return (
    <div className="relative w-[180px] shrink-0">
      <button
        type="button"
        aria-label="Where this task runs"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((current) => !current)}
        className={`inline-flex h-7 w-full items-center gap-1.5 rounded-lg border border-edge-strong pl-[9px] pr-2 font-mono text-[11.5px] text-ink hover:border-faint hover:bg-card ${open ? 'bg-card' : ''}`}
      >
        <span className="shrink-0 text-dim">
          <FolderIcon size={13} />
        </span>
        <span className="min-w-0 flex-1 truncate text-left">{name}</span>
        {form.useWorktree ? (
          <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap border-l border-edge-strong pl-1.5 text-[var(--color-accent-text)]">
            <BranchIcon size={11} />
            {task ? task.id : 'new branch'}
          </span>
        ) : null}
        <span className="shrink-0 text-faint">
          <ChevronIcon size={11} />
        </span>
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-[19]" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label="Where this task runs"
            className="absolute right-0 top-[34px] z-20 flex w-[340px] flex-col gap-1 rounded-xl border border-edge-strong bg-card p-1.5 shadow-[0_16px_40px_-10px_rgba(0,0,0,0.7)]"
          >
            <WorkspaceFields
              form={form}
              patch={patch}
              task={task}
              taskId={taskId}
              settings={settings}
              onClose={onClose}
            />
          </div>
        </>
      ) : null}
    </div>
  )
}
