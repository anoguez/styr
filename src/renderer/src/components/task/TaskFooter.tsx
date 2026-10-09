import { useState, type ReactNode } from 'react'
import type { TaskDiff } from '@core/diff.js'
import { formatAccelerator } from '@core/shortcuts.js'
import type { Task } from '@core/types.js'
import { useTaskDiff } from '../../hooks/useTaskDiff.js'
import { changesTitle } from '../../lib/taskForm.js'
import { DiffIcon, ExternalIcon, FolderIcon, TrashIcon } from '../icons.js'
import { DiffCount } from '../ui.js'
import { GHOST_BTN } from './fields.js'

function ChangesButton({
  changes,
  onShow
}: {
  changes: TaskDiff | null
  onShow: () => void
}): ReactNode {
  const count = changes?.files.length ?? 0
  return (
    <button
      type="button"
      className={`${GHOST_BTN} h-7`}
      disabled={count === 0}
      title={changesTitle(changes)}
      onClick={onShow}
    >
      <DiffIcon />
      Changes
      {changes && count > 0 ? (
        <DiffCount
          added={changes.totalAdditions}
          removed={changes.totalDeletions}
          files={changes.totalFiles}
        />
      ) : null}
    </button>
  )
}

/** What an existing task's file can do: open, reveal, show changes, archive, delete. */
function TaskActions({
  task,
  onShowChanges,
  onDelete,
  onClose
}: {
  task: Task
  onShowChanges: (task: Task) => void
  onDelete: () => void
  onClose: () => void
}): ReactNode {
  const { changes, noGit } = useTaskDiff(task)
  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        className={`${GHOST_BTN} h-7`}
        onClick={() => void window.api.tasks.openInEditor(task.id)}
      >
        <ExternalIcon />
        Open file
      </button>
      <button
        type="button"
        className={`${GHOST_BTN} h-7`}
        onClick={() => void window.api.tasks.reveal(task.id)}
      >
        <FolderIcon />
        Reveal
      </button>
      {noGit ? null : <ChangesButton changes={changes} onShow={() => onShowChanges(task)} />}
      <button
        type="button"
        className={`${GHOST_BTN} h-7`}
        title={
          task.archivedAt
            ? 'Put this task back on the board'
            : 'Take this task off the board; the file is kept'
        }
        onClick={() => void window.api.tasks.archive(task.id, !task.archivedAt).then(onClose)}
      >
        {task.archivedAt ? 'Unarchive' : 'Archive'}
      </button>
      <span className="mx-1 h-4 w-px bg-edge" />
      <button
        type="button"
        aria-label="Delete task"
        title="Delete task"
        className="inline-flex h-7 items-center justify-center gap-1.5 rounded-[7px] px-2 text-[12px] text-danger transition-colors hover:bg-red-500/10"
        onClick={onDelete}
      >
        <TrashIcon size={14} />
        Delete
      </button>
    </div>
  )
}

/** "Save as preset…", which opens into a name field. Esc in the field backs out. */
function SavePresetForm({ onSave }: { onSave: (name: string) => Promise<boolean> }): ReactNode {
  const [name, setName] = useState<string | null>(null)
  if (name === null) {
    return (
      <button type="button" className={`${GHOST_BTN} h-7`} onClick={() => setName('')}>
        Save as preset…
      </button>
    )
  }
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault()
        void onSave(name).then((saved) => saved && setName(null))
      }}
    >
      <input
        autoFocus
        aria-label="Preset name"
        placeholder="Preset name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            setName(null)
          }
        }}
        className="h-7 w-40 rounded-[7px] border border-edge-strong bg-chrome px-2 text-[12px] text-ink outline-none focus:border-accent"
      />
      <button type="submit" disabled={!name.trim()} className={`${GHOST_BTN} h-7`}>
        Save preset
      </button>
      <button type="button" className={`${GHOST_BTN} h-7`} onClick={() => setName(null)}>
        Cancel
      </button>
    </form>
  )
}

/** File actions for a task (or Save as preset for a new one), then Save and Save & Start. */
export function TaskFooter({
  task,
  saving,
  canStart,
  onSave,
  onSaveAndStart,
  onSavePreset,
  onShowChanges,
  onDelete,
  onClose
}: {
  task: Task | null
  saving: boolean
  /** Done tasks have nothing to start. */
  canStart: boolean
  onSave: () => void
  onSaveAndStart: () => void
  /** Resolves true once saved, which closes the name field. */
  onSavePreset: (name: string) => Promise<boolean>
  onShowChanges: (task: Task) => void
  onDelete: () => void
  onClose: () => void
}): ReactNode {
  return (
    <footer className="flex shrink-0 items-center gap-2 border-t border-edge bg-chrome/40 py-3 pl-3 pr-4">
      {task ? (
        <TaskActions
          task={task}
          onShowChanges={onShowChanges}
          onDelete={onDelete}
          onClose={onClose}
        />
      ) : (
        <SavePresetForm onSave={onSavePreset} />
      )}
      <div className="flex-1" />
      <button
        type="button"
        disabled={saving}
        onClick={onSave}
        className="inline-flex h-[30px] items-center gap-2 rounded-lg border border-edge-strong bg-raised/70 px-3 text-[12.5px] font-medium text-dim transition-colors hover:bg-raised hover:text-ink disabled:pointer-events-none disabled:opacity-40"
      >
        Save
        <kbd className="font-mono text-[10px] text-faint">{formatAccelerator('mod+enter')}</kbd>
      </button>
      {canStart ? (
        <button
          type="button"
          disabled={saving}
          onClick={onSaveAndStart}
          className="inline-flex h-[30px] items-center gap-[7px] rounded-lg border border-accent bg-accent px-3.5 text-[12.5px] font-semibold text-[var(--color-on-accent)] shadow-[0_1px_0_rgba(255,255,255,0.12)_inset] transition-colors hover:bg-accent/90 disabled:pointer-events-none disabled:opacity-40"
        >
          <svg aria-hidden viewBox="0 0 16 16" width="11" height="11" fill="currentColor">
            <path d="M5 3.5v9l7.25-4.5z" />
          </svg>
          Save &amp; Start
        </button>
      ) : null}
    </footer>
  )
}
