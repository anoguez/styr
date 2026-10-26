import type { ReactNode } from 'react'
import type { Settings, Task } from '@core/types.js'
import type { TaskForm } from '../../lib/taskForm.js'
import { AgentFields } from './AgentRunFields.js'
import { PropertiesFields } from './PropertiesFields.js'

const DIVIDER = <div className="h-px shrink-0 bg-edge" />

/** The dialog's right column: properties and the agent. */
export function TaskSidebar({
  form,
  patch,
  task,
  saved,
  allTasks,
  settings,
  routedName
}: {
  form: TaskForm
  patch: (changes: Partial<TaskForm>) => void
  task: Task | null
  saved: Task | null
  allTasks: Task[]
  settings: Settings
  routedName: string
}): ReactNode {
  return (
    <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto border-l border-edge bg-chrome/50 px-4 pb-4 pt-3.5">
      <PropertiesFields
        form={form}
        patch={patch}
        task={task}
        saved={saved}
        allTasks={allTasks}
        settings={settings}
      />
      {DIVIDER}
      <AgentFields form={form} patch={patch} routedName={routedName} settings={settings} />
    </aside>
  )
}
