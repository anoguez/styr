import type { ReactNode, RefObject } from 'react'
import { TASK_STATUS_LABELS, type Task, type TaskStatus } from '@core/types.js'
import { ChevronIcon, CloseIcon } from '../icons.js'
import { INPUT_TEXT, STATUS_DOT } from './fields.js'
import { STATUS_OPTIONS } from './PropertiesFields.js'

/** The status as a pill. A transparent native select sits over it, so the menu stays native. */
function StatusPill({
  status,
  onChange
}: {
  status: TaskStatus
  onChange: (status: TaskStatus) => void
}): ReactNode {
  return (
    <span className="relative inline-flex h-6 items-center gap-1.5 rounded-full border border-edge-strong bg-chrome pl-2 pr-2 text-[12px] font-medium text-ink hover:border-faint focus-within:border-accent">
      <span
        aria-hidden
        className="size-[7px] shrink-0 rounded-full"
        style={{ background: STATUS_DOT[status] }}
      />
      <span className="whitespace-nowrap">{TASK_STATUS_LABELS[status]}</span>
      <span className="text-faint">
        <ChevronIcon size={11} />
      </span>
      <select
        aria-label="Status"
        value={status}
        onChange={(event) => onChange(event.target.value as TaskStatus)}
        className="absolute inset-0 cursor-pointer appearance-none rounded-full opacity-0"
      >
        {STATUS_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  )
}

/** The task's id (or "New task"), its status, whether it is blocked, and the title field. */
export function TaskHeader({
  task,
  status,
  openBlockers,
  title,
  titleMissing,
  titleRef,
  onStatus,
  onTitle,
  onClose
}: {
  task: Task | null
  status: TaskStatus
  /** How many blockers are not Done yet. */
  openBlockers: number
  title: string
  titleMissing: boolean
  titleRef: RefObject<HTMLInputElement | null>
  onStatus: (status: TaskStatus) => void
  onTitle: (title: string) => void
  onClose: () => void
}): ReactNode {
  return (
    <header className="flex flex-col gap-1.5 border-b border-edge pb-3 pl-5 pr-4 pt-3.5">
      <div className="flex h-7 min-w-0 items-center gap-2">
        {task ? (
          <span className="font-mono text-[11px] text-dim">{task.id}</span>
        ) : (
          <span className="text-[11.5px] text-faint">New task</span>
        )}
        <StatusPill status={status} onChange={onStatus} />
        {openBlockers > 0 ? (
          <span
            title="Waits until its blockers are Done"
            className="inline-flex h-5 items-center rounded-md bg-[var(--color-col-review)]/10 px-[7px] text-[11px] font-medium text-[var(--color-col-review-text)]"
          >
            Waiting on {openBlockers}
          </span>
        ) : null}
        <div className="flex-1" />
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-dim transition-colors hover:bg-raised/70 hover:text-ink"
        >
          <CloseIcon size={14} />
        </button>
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
        className={`-ml-2 h-[34px] w-full px-2 text-[17px] font-semibold tracking-[-0.01em] focus:bg-chrome ${INPUT_TEXT} ${titleMissing ? 'border-danger focus:border-danger' : 'border-transparent hover:border-edge focus:border-accent'}`}
      />
      {titleMissing ? (
        <span role="alert" className="text-[11.5px] text-danger">
          A title is required.
        </span>
      ) : null}
    </header>
  )
}
