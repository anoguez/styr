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
import { resolveTemplateFor } from '@core/prompt.js'
import {
  Button,
  Checkbox,
  DirectoryInput,
  Field,
  FileListInput,
  Modal,
  Select,
  inputClass
} from './ui.js'

interface FormState {
  title: string
  status: TaskStatus
  priority: TaskPriority
  readiness: TaskReadiness
  project: string
  tags: string
  repoPath: string
  useWorktree: boolean
  orchestrate: boolean
  contextFiles: string[]
  promptTemplateId: string
  description: string
}

function toForm(task: Task | null, settings: Settings): FormState {
  return {
    title: task?.title ?? '',
    status: task?.status ?? 'backlog',
    priority: task?.priority ?? 'medium',
    readiness: task?.readiness ?? 'ready',
    project: task?.project ?? '',
    tags: task?.tags.join(', ') ?? '',
    repoPath: task?.repoPath ?? settings.defaultRepoPath,
    useWorktree: task?.useWorktree ?? false,
    orchestrate: task?.orchestrate ?? true,
    contextFiles: task?.contextFiles ?? [],
    promptTemplateId: task?.promptTemplateId ?? '',
    description: task?.description ?? ''
  }
}

export function TaskDialog({
  task,
  settings,
  onClose,
  onLaunch,
  onResumeSession
}: {
  task: Task | null
  settings: Settings
  onClose: () => void
  onLaunch: (taskId: string, templateId?: string) => void
  onResumeSession: (taskId: string, sessionId: string) => void
}): ReactNode {
  const [form, setForm] = useState<FormState>(() => toForm(task, settings))
  const [preview, setPreview] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const patch = (changes: Partial<FormState>): void =>
    setForm((current) => ({ ...current, ...changes }))

  const routedName = resolveTemplateFor(settings, {
    status: form.status,
    readiness: form.readiness
  }).name

  const payload = {
    title: form.title.trim(),
    status: form.status,
    priority: form.priority,
    readiness: form.readiness,
    project: form.project.trim() || undefined,
    tags: form.tags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean),
    repoPath: form.repoPath.trim() || undefined,
    useWorktree: form.useWorktree,
    orchestrate: form.orchestrate,
    contextFiles: form.contextFiles,
    promptTemplateId: form.promptTemplateId || undefined,
    description: form.description
  }

  async function save(): Promise<Task | null> {
    if (!payload.title) return null
    setSaving(true)
    try {
      return task
        ? await window.api.tasks.update(task.id, payload)
        : await window.api.tasks.create(payload)
    } finally {
      setSaving(false)
    }
  }

  async function saveAndClose(): Promise<void> {
    if (await save()) onClose()
  }

  async function saveAndLaunch(): Promise<void> {
    const saved = await save()
    if (!saved) return
    onLaunch(saved.id, form.promptTemplateId || undefined)
    onClose()
  }

  async function remove(): Promise<void> {
    if (!task) return
    await window.api.tasks.remove(task.id)
    onClose()
  }

  async function showPreview(): Promise<void> {
    const saved = await save()
    if (saved)
      setPreview(
        await window.api.terminal.previewPrompt(saved.id, form.promptTemplateId || undefined)
      )
  }

  return (
    <Modal
      wide
      title={task ? task.title : 'New task'}
      subtitle={task ? `${task.id} · ${task.filePath}` : 'Added to the board as a markdown file'}
      onClose={onClose}
      onSubmit={() => void saveAndClose()}
      footer={
        <>
          {task ? (
            <>
              <Button variant="danger" onClick={() => void remove()}>
                Delete
              </Button>
              <Button onClick={() => void window.api.tasks.openInEditor(task.id)}>Open file</Button>
              <Button onClick={() => void window.api.tasks.reveal(task.id)}>Reveal</Button>
            </>
          ) : null}
          <Button onClick={() => void showPreview()}>Preview prompt</Button>
          <Button onClick={() => void saveAndLaunch()} disabled={saving}>
            Save &amp; start Claude
          </Button>
          <Button variant="primary" onClick={() => void saveAndClose()} disabled={saving}>
            Save <kbd className="ml-0.5 font-mono text-[10px] opacity-70">⌘↵</kbd>
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Title">
          <input
            autoFocus
            className={inputClass}
            value={form.title}
            placeholder="What needs doing?"
            onChange={(event) => patch({ title: event.target.value })}
          />
        </Field>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Status">
            <Select
              value={form.status}
              onChange={(event) => patch({ status: event.target.value as TaskStatus })}
            >
              {TASK_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {TASK_STATUS_LABELS[status]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            <Select
              value={form.priority}
              onChange={(event) => patch({ priority: event.target.value as TaskPriority })}
            >
              {TASK_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {TASK_PRIORITY_LABELS[priority]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Readiness">
            <Select
              value={form.readiness}
              onChange={(event) => patch({ readiness: event.target.value as TaskReadiness })}
            >
              {TASK_READINESS.map((readiness) => (
                <option key={readiness} value={readiness}>
                  {TASK_READINESS_LABELS[readiness]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Project">
            <input
              className={inputClass}
              value={form.project}
              onChange={(event) => patch({ project: event.target.value })}
            />
          </Field>
          <Field label="Tags">
            <input
              className={inputClass}
              value={form.tags}
              placeholder="bug, api"
              onChange={(event) => patch({ tags: event.target.value })}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Working directory" hint="Where Claude runs for this task.">
            <DirectoryInput
              value={form.repoPath}
              placeholder="/Users/you/Workspace/project"
              onChange={(repoPath) => patch({ repoPath })}
            />
          </Field>
          <Field
            label="Prompt template"
            hint={
              form.promptTemplateId
                ? 'Pinned — this task always uses this template, whatever column it is in.'
                : `Auto — this task currently runs "${routedName}".`
            }
          >
            <Select
              value={form.promptTemplateId}
              onChange={(event) => patch({ promptTemplateId: event.target.value })}
            >
              <option value="">Auto — match the column</option>
              {settings.promptTemplates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Checkbox
          checked={form.orchestrate}
          onChange={(orchestrate) => patch({ orchestrate })}
          label="Let Orchestrate start this task"
          hint="On by default. Turn it off to keep Orchestrate's hands off this one — you can still start it yourself."
        />

        <Checkbox
          checked={form.useWorktree}
          onChange={(useWorktree) => patch({ useWorktree })}
          label="Run this task in its own git worktree"
          hint={
            form.repoPath
              ? `Claude gets a separate checkout on branch styr/${task?.id ?? 'TASK-…'}, created beside the repo, so parallel agents never share a working directory.`
              : 'Set a working directory first — the worktree is created from that repository.'
          }
        />

        {task?.worktreePath ? (
          <Field
            label="Worktree"
            hint="Removing it deletes that checkout and any uncommitted work inside it. The branch is kept."
          >
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-lg border border-edge-strong bg-chrome px-3 py-2 font-mono text-[11px] text-dim">
                {task.worktreePath}
              </code>
              <Button
                variant="danger"
                className="shrink-0"
                onClick={() => {
                  void window.api.tasks.removeWorktree(task.id).then(onClose)
                }}
              >
                Remove
              </Button>
            </div>
          </Field>
        ) : null}

        {task && task.sessions.length > 0 ? (
          <Field
            label="Claude chats"
            hint="Every run on this task, newest first. Open one to read back what it did — that reopens the conversation without starting new work. Forget only clears which chat the next run continues; the history stays."
          >
            <ul className="flex flex-col divide-y divide-edge overflow-hidden rounded-lg border border-edge-strong bg-chrome">
              {[...task.sessions].reverse().map((entry) => (
                <li key={entry.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-2 text-[12.5px] text-ink">
                      {entry.label}
                      {entry.id === task.claudeSessionId ? (
                        <span className="rounded bg-accent/15 px-1.5 text-[10px] text-[var(--color-accent-text)]">
                          continues next
                        </span>
                      ) : null}
                    </span>
                    <span className="truncate font-mono text-[10px] text-faint" title={entry.id}>
                      {new Date(entry.startedAt).toLocaleString()} · {entry.id.slice(0, 8)}
                    </span>
                  </span>
                  <Button
                    className="shrink-0"
                    onClick={() => {
                      onResumeSession(task.id, entry.id)
                      onClose()
                    }}
                  >
                    Open
                  </Button>
                </li>
              ))}
            </ul>
            {task.claudeSessionId ? (
              <Button
                className="mt-2 self-start"
                onClick={() => {
                  void window.api.tasks.forgetSession(task.id).then(onClose)
                }}
              >
                Forget current chat
              </Button>
            ) : null}
          </Field>
        ) : null}

        <Field
          label="Context files"
          hint="Their paths are added to the prompt so Claude reads them before starting. The files stay where they are — nothing is copied."
        >
          <FileListInput
            files={form.contextFiles}
            startIn={form.repoPath || undefined}
            onChange={(contextFiles) => patch({ contextFiles })}
          />
        </Field>

        <Field label="Description (markdown)">
          <textarea
            className={`${inputClass} min-h-52 resize-y font-mono text-[12px] leading-relaxed`}
            value={form.description}
            placeholder="Paste a wayfinder spec here, or write the brief yourself."
            onChange={(event) => patch({ description: event.target.value })}
          />
        </Field>

        {preview ? (
          <Field label="Prompt preview">
            <pre className="max-h-56 overflow-auto rounded-md border border-edge bg-surface p-3 font-mono text-[11px] leading-relaxed text-muted whitespace-pre-wrap">
              {preview}
            </pre>
          </Field>
        ) : null}

        {task && task.activity.length > 0 ? (
          <Field label="Activity">
            <ul className="flex flex-col gap-2 rounded-md border border-edge bg-surface p-3">
              {task.activity.map((entry, index) => (
                <li key={`${index}-${entry.at}`} className="text-[12px] leading-snug">
                  {entry.at ? (
                    <span className="font-mono text-[10px] text-muted">
                      {new Date(entry.at).toLocaleString()}
                      {entry.author ? ` · ${entry.author}` : ''}
                    </span>
                  ) : null}
                  <p className="whitespace-pre-wrap text-ink">{entry.message}</p>
                </li>
              ))}
            </ul>
          </Field>
        ) : null}
      </div>
    </Modal>
  )
}
