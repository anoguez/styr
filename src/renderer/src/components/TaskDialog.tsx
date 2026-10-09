import { useRef, useState, type ReactNode } from 'react'
import type { Settings, Task, TaskPreset } from '@core/types.js'
import { useSubmitShortcut } from '../hooks/useSubmitShortcut.js'
import {
  choosePreset,
  initialForm,
  savePresetPlan,
  taskPayload,
  templateNames,
  type TaskForm
} from '../lib/taskForm.js'
import { Button, Modal } from './ui.js'
import { BriefTab } from './task/BriefTab.js'
import { TaskFooter } from './task/TaskFooter.js'
import { TaskHeader } from './task/TaskHeader.js'
import { TaskSidebar } from './task/TaskSidebar.js'
import { ActivityTab, ChatsTab, PromptTab, TabNav, type TabKey } from './task/TaskTabs.js'

/**
 * Creating or editing a task. The form lives here; the header, tabs, sidebar and footer are in
 * `task/`, and the rules behind them (defaults, presets, blockers, the payload) in `lib/taskForm.ts`.
 */
export function TaskDialog({
  task,
  allTasks,
  settings,
  onClose,
  onLaunch,
  onResumeSession,
  onShowChanges,
  presetId,
  onSavePresets
}: {
  task: Task | null
  /** Every task in the workspace, for choosing and checking blockers. */
  allTasks: Task[]
  settings: Settings
  /** A preset to start from, for a new task. */
  presetId?: string
  onSavePresets: (presets: TaskPreset[]) => Promise<void>
  onClose: () => void
  onLaunch: (taskId: string, templateId?: string, provider?: 'claude' | 'codex') => void
  onResumeSession: (taskId: string, sessionId: string) => void
  onShowChanges: (task: Task) => void
}): ReactNode {
  const startPreset = task ? undefined : settings.taskPresets.find((p) => p.id === presetId)
  const [form, setForm] = useState<TaskForm>(() => initialForm(task, settings, startPreset))
  const [appliedPresetId, setAppliedPresetId] = useState(startPreset?.id ?? '')
  const [tab, setTab] = useState<TabKey>('brief')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [titleMissing, setTitleMissing] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  // A new task is created by the first save (the prompt preview needs one); later saves must
  // update that record instead of creating a duplicate.
  const [saved, setSaved] = useState<Task | null>(task)

  const patch = (changes: Partial<TaskForm>): void =>
    setForm((current) => ({ ...current, ...changes }))

  function applyPreset(id: string): void {
    const choice = choosePreset(form, appliedPresetId, id, settings)
    if (choice.confirm && !window.confirm("Replace what you've typed with this preset?")) return
    if (choice.form) setForm(choice.form)
    setAppliedPresetId(choice.presetId)
  }

  /** True once saved; false when there was nothing to save or the user backed out. */
  async function savePreset(name: string): Promise<boolean> {
    const plan = savePresetPlan(settings.taskPresets, name, form)
    if (plan.kind === 'empty') return false
    if (plan.kind === 'full') {
      window.alert('This workspace already has the maximum number of presets.')
      return false
    }
    if (plan.replaces && !window.confirm(`Replace the existing "${plan.replaces.name}" preset?`))
      return false
    await onSavePresets(plan.presets)
    setAppliedPresetId(plan.presetId)
    return true
  }

  const { routed: routedName, effective: templateName } = templateNames(settings, form)

  async function save(): Promise<Task | null> {
    const payload = taskPayload(form)
    if (!payload.title) {
      setTitleMissing(true)
      titleRef.current?.focus()
      return null
    }
    setSaving(true)
    try {
      const result = saved
        ? await window.api.tasks.update(saved.id, payload)
        : await window.api.tasks.create(payload)
      setSaved(result)
      return result
    } finally {
      setSaving(false)
    }
  }

  async function saveAndClose(): Promise<void> {
    if (await save()) onClose()
  }

  async function saveAndLaunch(): Promise<void> {
    const result = await save()
    if (!result) return
    onLaunch(result.id, form.promptTemplateId || undefined, form.provider)
    onClose()
  }

  async function remove(): Promise<void> {
    if (!task) return
    await window.api.tasks.remove(task.id)
    onClose()
  }

  async function showPreview(): Promise<void> {
    const result = await save()
    if (!result) {
      setPreview(null)
      setPreviewError(true)
      return
    }
    setPreviewError(false)
    setPreview(
      await window.api.terminal.previewPrompt(result.id, form.promptTemplateId || undefined)
    )
  }

  function selectTab(next: TabKey): void {
    setTab(next)
    if (next === 'prompt') void showPreview()
  }

  useSubmitShortcut(() => void saveAndClose(), !confirmingDelete)

  const taskId = task?.id ?? 'TASK-…'
  return (
    <>
      {/* The backdrop deliberately does not close the dialog: a stray click would discard the draft. */}
      <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/65 px-8 py-[6vh] backdrop-blur-[2px]">
        <div
          role="dialog"
          aria-label={task ? task.title : 'New task'}
          className="flex h-[max(min(720px,88vh),min(78vh,1300px))] w-full max-w-[max(1000px,min(72vw,1700px))] flex-col overflow-hidden rounded-2xl border border-edge-strong bg-panel shadow-[0_24px_60px_-12px_rgba(0,0,0,0.7)]"
        >
          <TaskHeader
            task={task}
            taskId={taskId}
            useWorktree={form.useWorktree}
            title={form.title}
            titleMissing={titleMissing}
            titleRef={titleRef}
            onTitle={(title) => {
              setTitleMissing(false)
              patch({ title })
            }}
            onClose={onClose}
          />

          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_292px]">
            <section className="flex min-h-0 min-w-0 flex-col">
              <TabNav task={task} tab={tab} onSelect={selectTab} />
              {tab === 'brief' ? (
                <BriefTab
                  description={form.description}
                  contextFiles={form.contextFiles}
                  repoPath={form.repoPath}
                  onChange={patch}
                />
              ) : null}
              {tab === 'chats' && task ? (
                <ChatsTab
                  task={task}
                  onResume={(sessionId) => {
                    onResumeSession(task.id, sessionId)
                    onClose()
                  }}
                  onForget={() => void window.api.tasks.forgetSession(task.id).then(onClose)}
                />
              ) : null}
              {tab === 'activity' && task ? <ActivityTab activity={task.activity} /> : null}
              {tab === 'prompt' ? (
                <PromptTab
                  agent={form.provider === 'codex' ? 'Codex' : 'Claude'}
                  templateName={templateName}
                  preview={preview}
                  failed={previewError}
                />
              ) : null}
            </section>

            <TaskSidebar
              form={form}
              patch={patch}
              task={task}
              taskId={taskId}
              saved={saved}
              allTasks={allTasks}
              settings={settings}
              routedName={routedName}
              appliedPresetId={appliedPresetId}
              onPreset={applyPreset}
              onClose={onClose}
            />
          </div>

          <TaskFooter
            task={task}
            saving={saving}
            canStart={form.status !== 'done'}
            onSave={() => void saveAndClose()}
            onSaveAndStart={() => void saveAndLaunch()}
            onSavePreset={savePreset}
            onShowChanges={onShowChanges}
            onDelete={() => setConfirmingDelete(true)}
            onClose={onClose}
          />
        </div>
      </div>
      {confirmingDelete && task ? (
        <Modal
          title="Delete this task?"
          subtitle={`${task.id} · ${task.title}`}
          onClose={() => setConfirmingDelete(false)}
          footer={
            <>
              <Button onClick={() => setConfirmingDelete(false)}>Cancel</Button>
              <Button variant="danger" onClick={() => void remove()}>
                Delete
              </Button>
            </>
          }
        >
          <p className="text-[12.5px] text-dim">
            The task file is removed from the board. This cannot be undone.
          </p>
        </Modal>
      ) : null}
    </>
  )
}
