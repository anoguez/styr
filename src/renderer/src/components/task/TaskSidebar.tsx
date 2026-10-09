import type { ReactNode } from 'react'
import type { Settings, Task } from '@core/types.js'
import type { TaskForm } from '../../lib/taskForm.js'
import { Select } from '../ui.js'
import { AgentRunFields } from './AgentRunFields.js'
import { BlockersField } from './BlockersField.js'
import { DetailsFields } from './DetailsFields.js'
import { SECTION_LABEL } from './fields.js'

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
    <div className="flex flex-col gap-1.5">
      <span className={SECTION_LABEL}>Preset</span>
      <Select
        compact
        aria-label="Preset"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Blank task</option>
        {presets.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.name}
          </option>
        ))}
      </Select>
      <span className="text-[11px] leading-[1.4] text-faint">
        Fills in this form from a saved starting point. The task keeps no link to it.
      </span>
    </div>
  )
}

/** The dialog's right column: preset (new tasks), blockers, details and how the agent runs. */
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
    <aside className="flex min-h-0 flex-col gap-5 overflow-y-auto border-l border-edge bg-chrome/50 p-4">
      {!task && settings.taskPresets.length > 0 ? (
        <PresetPicker presets={settings.taskPresets} value={appliedPresetId} onChange={onPreset} />
      ) : null}
      <BlockersField
        taskId={task?.id}
        blockedBy={form.blockedBy}
        allTasks={allTasks}
        onChange={(blockedBy) => patch({ blockedBy })}
      />
      <DetailsFields form={form} patch={patch} saved={saved} settings={settings} />
      <div className="h-px shrink-0 bg-edge" />
      <AgentRunFields
        form={form}
        patch={patch}
        task={task}
        taskId={taskId}
        routedName={routedName}
        settings={settings}
        onClose={onClose}
      />
    </aside>
  )
}
