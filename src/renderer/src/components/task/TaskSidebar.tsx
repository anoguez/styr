import type { ReactNode } from 'react'
import type { Settings, Task } from '@core/types.js'
import type { TaskForm } from '../../lib/taskForm.js'
import { AgentFields, WorkspaceFields } from './AgentRunFields.js'
import { PropertySelect } from './fields.js'
import { PropertiesFields } from './PropertiesFields.js'

/** "Start from": fills a new task's form from a saved preset. */
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
    <div className="-mx-1.5 -mt-1 flex flex-col gap-0.5 rounded-[9px] border border-accent/30 bg-accent/10 p-1.5 pl-1">
      <PropertySelect
        label="Start from"
        ariaLabel="Preset"
        value={value}
        options={[
          { value: '', label: 'Blank task' },
          ...presets.map((preset) => ({ value: preset.id, label: preset.name }))
        ]}
        hint="Fills the form. The task keeps no link to it."
        onChange={onChange}
      />
    </div>
  )
}

const DIVIDER = <div className="h-px shrink-0 bg-edge" />

/** The dialog's right column: preset (new tasks), properties, the agent, and where it runs. */
export function TaskSidebar({
  form,
  patch,
  task,
  taskId,
  saved,
  allTasks,
  settings,
  routedName,
  appliedPresetId,
  onPreset,
  onClose
}: {
  form: TaskForm
  patch: (changes: Partial<TaskForm>) => void
  task: Task | null
  taskId: string
  saved: Task | null
  allTasks: Task[]
  settings: Settings
  routedName: string
  appliedPresetId: string
  onPreset: (presetId: string) => void
  onClose: () => void
}): ReactNode {
  return (
    <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto border-l border-edge bg-chrome/50 px-4 pb-4 pt-3.5">
      {!task && settings.taskPresets.length > 0 ? (
        <PresetPicker presets={settings.taskPresets} value={appliedPresetId} onChange={onPreset} />
      ) : null}
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
      {DIVIDER}
      <WorkspaceFields
        form={form}
        patch={patch}
        task={task}
        taskId={taskId}
        settings={settings}
        onClose={onClose}
      />
    </aside>
  )
}
