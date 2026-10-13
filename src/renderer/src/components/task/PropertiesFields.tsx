import { useState, type ReactNode } from 'react'
import {
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_READINESS,
  TASK_READINESS_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  type Settings,
  type Task,
  type TaskPriority,
  type TaskReadiness
} from '@core/types.js'
import type { TaskForm } from '../../lib/taskForm.js'
import { fileName } from '../../lib/terminalPath.js'
import { SourceLink } from '../SourceLink.js'
import { BlockersField } from './BlockersField.js'
import {
  PROP_INPUT,
  PROP_LABEL,
  PROP_ROW,
  PropertySelect,
  SECTION_LABEL,
  TagsEditor
} from './fields.js'

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
export function optionsOf<T extends string>(
  values: readonly T[],
  labels: Record<T, string>
): { value: T; label: string }[] {
  return values.map((value) => ({ value, label: labels[value] }))
}

export const STATUS_OPTIONS = optionsOf(TASK_STATUSES, TASK_STATUS_LABELS)

/** Priority, readiness, project, tags, blockers, PR link and the linked source item. Status is
 *  in the header. */
export function PropertiesFields({
  form,
  patch,
  task,
  saved,
  allTasks,
  settings
}: {
  form: TaskForm
  patch: (changes: Partial<TaskForm>) => void
  task: Task | null
  /** The task as last saved; a source item can be linked only once it exists. */
  saved: Task | null
  allTasks: Task[]
  settings: Settings
}): ReactNode {
  // The source row can relink the task; that result is shown until the dialog closes.
  const [linkedTask, setLinkedTask] = useState<Task | null>(null)
  return (
    <div className="flex flex-col gap-0.5">
      <span className={`${SECTION_LABEL} pb-1.5`}>Properties</span>
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
      <div className={`${PROP_ROW} h-8`}>
        <span className={PROP_LABEL}>Project</span>
        <input
          aria-label="Project"
          value={form.project}
          placeholder={fileName(form.repoPath.trim()) || 'None'}
          onChange={(event) => patch({ project: event.target.value })}
          className={PROP_INPUT}
        />
      </div>
      <TagsEditor tags={form.tags} onChange={(tags) => patch({ tags })} />
      <BlockersField
        taskId={task?.id}
        blockedBy={form.blockedBy}
        allTasks={allTasks}
        onChange={(blockedBy) => patch({ blockedBy })}
      />
      <div className={`${PROP_ROW} h-8`}>
        <span className={PROP_LABEL}>PR link</span>
        <input
          aria-label="Pull request URL"
          type="url"
          value={form.prUrl}
          placeholder="None"
          title="Optional link to the pull or merge request, on any host"
          onChange={(event) => patch({ prUrl: event.target.value })}
          className={PROP_INPUT}
        />
      </div>
      {saved ? (
        <SourceLink task={linkedTask ?? saved} settings={settings} onTask={setLinkedTask} />
      ) : null}
    </div>
  )
}
