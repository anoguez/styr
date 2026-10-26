import type { ReactNode, RefObject } from 'react'
import type { Settings, Task } from '@core/types.js'
import { ChevronIcon, CloseIcon, PlusIcon } from '../icons.js'
import { INPUT_TEXT } from './fields.js'

/** "Start template": fills a new task's form from a saved preset. */
function PresetPicker({
  presets,
  value,
  onChange
}: {
  presets: Settings['taskPresets']
  value: string
  onChange: (presetId: string) => void
}): ReactNode {
  return (
    <span className="relative block w-[180px] shrink-0">
      <span className="pointer-events-none absolute left-[9px] top-1/2 -translate-y-1/2 text-dim">
        <PlusIcon size={13} />
      </span>
      <select
        aria-label="Preset"
        title="Fills the form. The task keeps no link to it."
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-7 w-full cursor-pointer appearance-none rounded-lg border border-edge-strong bg-transparent pl-7 pr-[26px] text-[12px] text-ink outline-none hover:border-faint hover:bg-card focus:border-accent"
      >
        <option value="" className="bg-chrome text-ink">
          Blank task
        </option>
        {presets.map((preset) => (
          <option key={preset.id} value={preset.id} className="bg-chrome text-ink">
            {preset.name}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-faint">
        <ChevronIcon size={11} />
      </span>
    </span>
  )
}

/** The task's id (or "New task" with its preset picker), whether it is blocked, the title, and where it runs. */
export function TaskHeader({
  task,
  presets,
  appliedPresetId,
  openBlockers,
  title,
  titleMissing,
  titleRef,
  workspace,
  onPreset,
  onTitle,
  onClose
}: {
  task: Task | null
  /** Saved presets a new task can start from. */
  presets: Settings['taskPresets']
  appliedPresetId: string
  /** How many blockers are not Done yet. */
  openBlockers: number
  title: string
  titleMissing: boolean
  titleRef: RefObject<HTMLInputElement | null>
  /** The control for where the task runs, beside the title. */
  workspace: ReactNode
  onPreset: (presetId: string) => void
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
        {!task && presets.length > 0 ? (
          <PresetPicker presets={presets} value={appliedPresetId} onChange={onPreset} />
        ) : null}
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
      <div className="flex items-center gap-2">
        <input
          ref={titleRef}
          autoFocus
          aria-label="Title"
          aria-required
          aria-invalid={titleMissing}
          value={title}
          placeholder="What needs doing?"
          onChange={(event) => onTitle(event.target.value)}
          className={`-ml-2 h-[34px] min-w-0 flex-1 px-2 text-[17px] font-semibold tracking-[-0.01em] focus:bg-chrome ${INPUT_TEXT} ${titleMissing ? 'border-danger focus:border-danger' : 'border-transparent hover:border-edge focus:border-accent'}`}
        />
        {workspace}
      </div>
      {titleMissing ? (
        <span role="alert" className="text-[11.5px] text-danger">
          A title is required.
        </span>
      ) : null}
    </header>
  )
}
