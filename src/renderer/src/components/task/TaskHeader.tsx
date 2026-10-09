import type { ReactNode, RefObject } from 'react'
import type { Task } from '@core/types.js'
import { BranchIcon, CloseIcon } from '../icons.js'
import { INPUT_TEXT } from './fields.js'

/** The task's id and file (or "New task"), its worktree branch, and the title field. */
export function TaskHeader({
  task,
  taskId,
  useWorktree,
  title,
  titleMissing,
  titleRef,
  onTitle,
  onClose
}: {
  task: Task | null
  /** The task's id, or a placeholder before the first save. */
  taskId: string
  useWorktree: boolean
  title: string
  titleMissing: boolean
  titleRef: RefObject<HTMLInputElement | null>
  onTitle: (title: string) => void
  onClose: () => void
}): ReactNode {
  return (
    <header className="flex items-start gap-4 border-b border-edge py-4 pl-5 pr-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex h-[18px] min-w-0 items-center gap-2.5 font-mono text-[10.5px] text-faint">
          {task ? (
            <>
              <span className="text-dim">{task.id}</span>
              <span className="truncate">{task.filePath}</span>
            </>
          ) : (
            <span className="font-[family-name:var(--font-ui)] text-[11.5px]">
              New task · saved to the board as a markdown file
            </span>
          )}
          {useWorktree ? (
            <span className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-md bg-accent/15 px-1.5 text-[var(--color-accent-text)]">
              <BranchIcon size={11} />
              {`styr/${taskId}`}
            </span>
          ) : null}
        </div>
        <input
          ref={titleRef}
          autoFocus
          aria-label="Title"
          aria-required
          aria-invalid={titleMissing}
          value={title}
          placeholder="What needs doing?"
          onChange={(event) => onTitle(event.target.value)}
          className={`-ml-2 h-[34px] w-full px-2 text-[17px] font-semibold tracking-[-0.01em] focus:bg-chrome ${INPUT_TEXT} ${titleMissing ? 'border-[var(--color-pri-urgent)] focus:border-[var(--color-pri-urgent)]' : 'border-edge-strong hover:border-faint/60 focus:border-accent'}`}
        />
        {titleMissing ? (
          <span role="alert" className="text-[11.5px] text-[var(--color-pri-urgent)]">
            A title is required.
          </span>
        ) : null}
      </div>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-dim transition-colors hover:bg-raised/70 hover:text-ink"
      >
        <CloseIcon size={14} />
      </button>
    </header>
  )
}
