import { useState, type ReactNode } from 'react'
import {
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_READINESS,
  TASK_READINESS_LABELS,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  type Settings,
  type Task,
  type TaskPriority,
  type TaskReadiness,
  type TaskStatus
} from '@core/types.js'
import type { TaskForm } from '../../lib/taskForm.js'
import { fileName } from '../../lib/terminalPath.js'
import { SourceLink } from '../SourceLink.js'
import { INPUT_TEXT, PropertySelect, SECTION_LABEL, TagsEditor } from './fields.js'

const STATUS_DOT: Record<TaskStatus, string> = {
  backlog: 'var(--color-col-backlog)',
  in_progress: 'var(--color-col-progress)',
  in_review: 'var(--color-col-review)',
  done: 'var(--color-col-done)'
}
const PRIORITY_DOT: Record<TaskPriority, string> = {
  low: 'var(--color-pri-low)',
  medium: 'var(--color-pri-medium)',
  high: 'var(--color-pri-high)',
  urgent: 'var(--color-pri-urgent)'
}
const READINESS_DOT: Record<TaskReadiness, string> = {
  ready: 'var(--color-col-done)',
  needs_spec: 'var(--color-col-review)'
}

/** Pairs each value with its label, for a `PropertySelect`. */
function optionsOf<T extends string>(
  values: readonly T[],
  labels: Record<T, string>
): { value: T; label: string }[] {
  return values.map((value) => ({ value, label: labels[value] }))
}

/** Status, priority, readiness, project, PR link, the linked source item and tags. */
export function DetailsFields({
  form,
  patch,
  saved,
  settings
}: {
  form: TaskForm
  patch: (changes: Partial<TaskForm>) => void
  /** The task as last saved; a source item can be linked only once it exists. */
  saved: Task | null
  settings: Settings
}): ReactNode {
  // The source row can relink the task; that result is shown until the dialog closes.
  const [linkedTask, setLinkedTask] = useState<Task | null>(null)
  const fieldClass = `h-7 w-full rounded-[7px] px-2 text-[12.5px] hover:border-edge hover:bg-card focus:border-accent focus:bg-chrome ${INPUT_TEXT}`
  return (
    <div className="flex flex-col gap-0.5">
      <span className={`${SECTION_LABEL} pb-1.5`}>Details</span>
      <PropertySelect
        label="Status"
        value={form.status}
        dots={STATUS_DOT}
        options={optionsOf(TASK_STATUSES, TASK_STATUS_LABELS)}
        onChange={(status) => patch({ status })}
      />
      <PropertySelect
        label="Priority"
        value={form.priority}
        dots={PRIORITY_DOT}
        options={optionsOf(TASK_PRIORITIES, TASK_PRIORITY_LABELS)}
        onChange={(priority) => patch({ priority })}
      />
      <PropertySelect
        label="Readiness"
        value={form.readiness}
        dots={READINESS_DOT}
        options={optionsOf(TASK_READINESS, TASK_READINESS_LABELS)}
        onChange={(readiness) => patch({ readiness })}
      />
      <div className="grid h-8 grid-cols-[76px_minmax(0,1fr)] items-center gap-2">
        <span className="text-[12px] text-dim">Project</span>
        <input
          aria-label="Project"
          value={form.project}
          placeholder={fileName(form.repoPath.trim()) || 'None'}
          onChange={(event) => patch({ project: event.target.value })}
          className={`border-transparent ${fieldClass}`}
        />
      </div>
      <div className="grid h-8 grid-cols-[76px_minmax(0,1fr)] items-center gap-2">
        <span className="text-[12px] text-dim">PR link</span>
        <input
          aria-label="Pull request URL"
          type="url"
          value={form.prUrl}
          placeholder="None"
          title="Optional link to the pull or merge request, on any host"
          onChange={(event) => patch({ prUrl: event.target.value })}
          className={fieldClass}
        />
      </div>
      {saved ? (
        <SourceLink task={linkedTask ?? saved} settings={settings} onTask={setLinkedTask} />
      ) : null}
      <TagsEditor tags={form.tags} onChange={(tags) => patch({ tags })} />
    </div>
  )
}
