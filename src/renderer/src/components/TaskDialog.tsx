import { useEffect, useRef, useState, type ReactNode } from 'react'
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
  type TaskPreset,
  type TaskStatus
} from '@core/types.js'
import type { TaskDiff } from '@core/diff.js'
import { danglingBlockers, findCycle, indexTasks } from '@core/blocking.js'
import { resolveTemplateFor } from '@core/prompt.js'
import {
  canAddPreset,
  matchesPreset,
  newPresetId,
  presetFields,
  presetFromFields
} from '@core/taskPreset.js'
import { Button, Chip, DiffCount, Modal, Select } from './ui.js'
import { SourceLink } from './SourceLink.js'

interface FormState {
  title: string
  status: TaskStatus
  priority: TaskPriority
  readiness: TaskReadiness
  project: string
  tags: string[]
  repoPath: string
  prUrl: string
  useWorktree: boolean
  baseBranch: string
  orchestrate: boolean
  blockedBy: string[]
  contextFiles: string[]
  promptTemplateId: string
  provider: 'claude' | 'codex'
  description: string
}

type TabKey = 'brief' | 'chats' | 'activity' | 'prompt'

function toForm(task: Task | null, settings: Settings): FormState {
  return {
    title: task?.title ?? '',
    status: task?.status ?? 'backlog',
    priority: task?.priority ?? 'medium',
    readiness: task?.readiness ?? 'ready',
    project: task?.project ?? '',
    tags: task?.tags ?? [],
    repoPath: task?.repoPath ?? settings.defaultRepoPath,
    prUrl: task?.prUrl ?? '',
    useWorktree: task?.useWorktree ?? settings.taskDefaults.useWorktree,
    baseBranch: task?.baseBranch ?? '',
    orchestrate: task?.orchestrate ?? settings.taskDefaults.orchestrate,
    blockedBy: task?.blockedBy ?? [],
    contextFiles: task?.contextFiles ?? [],
    promptTemplateId: task?.promptTemplateId ?? '',
    provider: task?.provider ?? settings.defaultProvider,
    description: task?.description ?? ''
  }
}

/** The form with a preset's values laid over it; an empty preset title keeps what was typed. */
function withPreset(form: FormState, preset: TaskPreset, settings: Settings): FormState {
  const fields = presetFields(preset, settings)
  return { ...form, ...fields, title: fields.title || form.title }
}

function formPresetFields(form: FormState): ReturnType<typeof presetFields> {
  return {
    title: form.title,
    description: form.description,
    tags: form.tags,
    priority: form.priority,
    readiness: form.readiness,
    useWorktree: form.useWorktree,
    orchestrate: form.orchestrate,
    provider: form.provider,
    promptTemplateId: form.promptTemplateId,
    baseBranch: form.baseBranch
  }
}

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

const providerLabel = (provider: string): string => (provider === 'codex' ? 'Codex' : 'Claude Code')

const SECTION_LABEL = 'text-[10.5px] font-semibold uppercase tracking-[0.06em] text-faint'
const GHOST_BTN =
  'inline-flex items-center gap-1.5 rounded-[7px] border border-transparent px-2 text-[12px] font-medium text-dim transition-colors hover:bg-raised/70 hover:text-ink disabled:pointer-events-none disabled:opacity-40'
const BOXED_CONTROL =
  'h-[30px] w-full rounded-[7px] border border-edge-strong bg-chrome px-2.5 text-[12.5px] text-ink outline-none focus:border-accent'

function Icon({ children, size = 13 }: { children: ReactNode; size?: number }): ReactNode {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      {children}
    </svg>
  )
}

const CloseIcon = (props: { size?: number }): ReactNode => (
  <Icon {...props}>
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
  </Icon>
)
const PlusIcon = (props: { size?: number }): ReactNode => (
  <Icon {...props}>
    <path d="M8 3.5v9M3.5 8h9" />
  </Icon>
)
const FolderIcon = (props: { size?: number }): ReactNode => (
  <Icon {...props}>
    <path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
  </Icon>
)

/** One row of the Details list: a label and a select dressed as plain text with a status dot. */
function PropertySelect<T extends string>({
  label,
  value,
  options,
  dots,
  onChange
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  dots: Record<T, string>
  onChange: (value: T) => void
}): ReactNode {
  const current = options.find((option) => option.value === value) ?? options[0]!
  return (
    <div className="grid h-8 grid-cols-[76px_minmax(0,1fr)] items-center gap-2">
      <span className="text-[12px] text-dim">{label}</span>
      <span className="relative block">
        <span
          aria-hidden
          className="pointer-events-none absolute left-[9px] top-1/2 z-[1] size-[7px] -translate-y-1/2 rounded-full"
          style={{ background: dots[current.value] }}
        />
        <span className="pointer-events-none absolute left-[23px] right-[26px] top-1/2 z-[1] -translate-y-1/2 truncate text-[12.5px] text-ink">
          {current.label}
        </span>
        <select
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value as T)}
          className="h-7 w-full cursor-pointer appearance-none rounded-[7px] border border-transparent bg-transparent pl-[23px] pr-[26px] text-[12.5px] text-transparent outline-none hover:border-edge hover:bg-card focus:border-accent"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} className="bg-chrome text-ink">
              {option.label}
            </option>
          ))}
        </select>
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-faint"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </span>
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  label,
  hint
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  hint: string
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-start gap-2.5 text-left"
    >
      <span className="flex flex-col gap-0.5">
        <span className="text-[12.5px] text-ink">{label}</span>
        <span className="text-[11px] leading-[1.4] text-faint">{hint}</span>
      </span>
      <span
        className={`relative mt-px block h-4 w-7 rounded-full transition-colors duration-150 ${checked ? 'bg-accent' : 'bg-edge-strong'}`}
      >
        <span
          className={`absolute top-0.5 size-3 rounded-full bg-ink transition-[left] duration-150 ${checked ? 'left-3.5' : 'left-0.5'}`}
        />
      </span>
    </button>
  )
}

function TagsEditor({
  tags,
  onChange
}: {
  tags: string[]
  onChange: (tags: string[]) => void
}): ReactNode {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  function commit(): void {
    const tag = draft.trim()
    if (tag && !tags.includes(tag)) onChange([...tags, tag])
    setDraft('')
    setAdding(false)
  }

  return (
    <div className="grid min-h-8 grid-cols-[76px_minmax(0,1fr)] items-center gap-2">
      <span className="text-[12px] text-dim">Tags</span>
      <div className="flex flex-wrap items-center gap-1 px-2 py-[5px]">
        {tags.map((tag) => (
          <span
            key={tag}
            className="group inline-flex h-[18px] items-center gap-1 rounded-md bg-raised px-1.5 text-[10.5px] font-medium text-dim"
          >
            {tag}
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              className="hidden text-faint hover:text-ink group-hover:inline-flex"
              onClick={() => onChange(tags.filter((current) => current !== tag))}
            >
              <CloseIcon size={9} />
            </button>
          </span>
        ))}
        {adding ? (
          <input
            autoFocus
            value={draft}
            aria-label="New tag"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                commit()
              } else if (event.key === 'Escape') {
                event.stopPropagation()
                setDraft('')
                setAdding(false)
              }
            }}
            className="h-[18px] w-20 rounded-md border border-accent bg-chrome px-1.5 text-[10.5px] text-ink outline-none"
          />
        ) : (
          <button
            type="button"
            aria-label="Add tag"
            onClick={() => setAdding(true)}
            className="inline-flex size-[18px] items-center justify-center rounded-[5px] border border-dashed border-edge-strong text-faint hover:border-faint hover:text-ink"
          >
            <PlusIcon size={10} />
          </button>
        )}
      </div>
    </div>
  )
}

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
  const [changes, setChanges] = useState<TaskDiff | null>(null)
  // The task's folder is not a git repository (non-code work): there is nothing to show changes of.
  const [noGit, setNoGit] = useState(false)
  useEffect(() => {
    if (!task) return
    let cancelled = false
    void window.api.git.taskDiff(task.id).then((result) => {
      if (cancelled) return
      setChanges('error' in result ? null : result)
      setNoGit('error' in result && result.error.endsWith('is not a git repository'))
    })
    return () => {
      cancelled = true
    }
  }, [task])
  const startPreset = task ? undefined : settings.taskPresets.find((p) => p.id === presetId)
  const [form, setForm] = useState<FormState>(() => {
    const base = toForm(task, settings)
    return startPreset ? withPreset(base, startPreset, settings) : base
  })
  const [appliedPresetId, setAppliedPresetId] = useState(startPreset?.id ?? '')
  const [presetName, setPresetName] = useState<string | null>(null)
  const [linkedTask, setLinkedTask] = useState<Task | null>(null)
  const [tab, setTab] = useState<TabKey>('brief')
  const [branchInfo, setBranchInfo] = useState<{ branches: string[]; current?: string }>({
    branches: []
  })
  const [branchesLoaded, setBranchesLoaded] = useState(false)
  useEffect(() => {
    setBranchesLoaded(false)
    if (!form.useWorktree || !form.repoPath.trim()) return
    let cancelled = false
    void window.api.git.branches(form.repoPath.trim()).then((info) => {
      if (cancelled) return
      setBranchInfo(info)
      setBranchesLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [form.useWorktree, form.repoPath])
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [titleMissing, setTitleMissing] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  // A new task is created by the first save (the prompt preview needs one); later saves must
  // update that record instead of creating a duplicate.
  const [saved, setSaved] = useState<Task | null>(task)

  const patch = (changes: Partial<FormState>): void =>
    setForm((current) => ({ ...current, ...changes }))

  function applyPreset(id: string): void {
    const previous = settings.taskPresets.find((p) => p.id === appliedPresetId)
    const untouched = previous
      ? matchesPreset(formPresetFields(form), previous, settings)
      : !form.title.trim() && !form.description.trim()
    const next = settings.taskPresets.find((p) => p.id === id)
    if (!next) {
      // Back to None: clear only what the previous preset put there.
      if (previous && untouched)
        setForm(toForm(null, { ...settings, defaultRepoPath: form.repoPath }))
      setAppliedPresetId('')
      return
    }
    const typed = (form.title.trim() || form.description.trim()) && !untouched
    if (typed && !window.confirm("Replace what you've typed with this preset?")) return
    setForm((current) => withPreset(current, next, settings))
    setAppliedPresetId(next.id)
  }

  async function savePreset(): Promise<void> {
    const name = (presetName ?? '').trim()
    if (!name) return
    const existing = settings.taskPresets.find(
      (p) => p.name.trim().toLowerCase() === name.toLowerCase()
    )
    if (existing && !window.confirm(`Replace the existing "${existing.name}" preset?`)) return
    if (!existing && !canAddPreset(settings.taskPresets)) {
      window.alert('This workspace already has the maximum number of presets.')
      return
    }
    const made = presetFromFields(
      existing?.id ?? newPresetId(settings.taskPresets, name),
      name,
      formPresetFields(form)
    )
    await onSavePresets(
      existing
        ? settings.taskPresets.map((p) => (p.id === existing.id ? made : p))
        : [...settings.taskPresets, made]
    )
    setAppliedPresetId(made.id)
    setPresetName(null)
  }

  const routedName = resolveTemplateFor(settings, {
    status: form.status,
    readiness: form.readiness
  }).name
  const templateName = form.promptTemplateId
    ? (settings.promptTemplates.find((template) => template.id === form.promptTemplateId)?.name ??
      routedName)
    : routedName

  const lookup = indexTasks(allTasks)
  const missingBlockers = danglingBlockers({ blockedBy: form.blockedBy }, lookup)
  const existingCycle = task ? findCycle(task.id, form.blockedBy, lookup) : null
  const blockerChoices = allTasks
    .filter(
      (other) =>
        other.id !== task?.id &&
        !other.archivedAt &&
        other.status !== 'done' &&
        !form.blockedBy.includes(other.id)
    )
    .map((other) => ({
      id: other.id,
      title: other.title,
      cycle: task ? findCycle(task.id, [other.id], lookup) !== null : false
    }))

  const repoFolder = form.repoPath.trim().replace(/\/+$/, '').split('/').pop() ?? ''

  const payload = {
    title: form.title.trim(),
    status: form.status,
    priority: form.priority,
    readiness: form.readiness,
    project: form.project.trim() || repoFolder || undefined,
    tags: form.tags,
    repoPath: form.repoPath.trim() || undefined,
    prUrl: form.prUrl.trim() || undefined,
    useWorktree: form.useWorktree,
    baseBranch: form.baseBranch || undefined,
    orchestrate: form.orchestrate,
    blockedBy: form.blockedBy,
    contextFiles: form.contextFiles,
    promptTemplateId: form.promptTemplateId || undefined,
    provider: form.provider,
    description: form.description
  }

  async function save(): Promise<Task | null> {
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

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        if (!confirmingDelete) void saveAndClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const sessions = task ? [...task.sessions].reverse() : []
  const tabs: { key: TabKey; label: string; count?: number }[] = [
    { key: 'brief', label: 'Brief' },
    ...(task
      ? [
          { key: 'chats' as const, label: 'Agent chats', count: task.sessions.length },
          { key: 'activity' as const, label: 'Activity', count: task.activity.length }
        ]
      : []),
    { key: 'prompt', label: 'Prompt preview' }
  ]

  const taskId = task?.id ?? 'TASK-…'
  const inputText = 'rounded-lg border bg-transparent text-ink outline-none placeholder:text-faint'
  return (
    <>
      {/* The backdrop deliberately does not close the dialog: a stray click would discard the draft. */}
      <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/65 px-8 py-[6vh] backdrop-blur-[2px]">
        <div
          role="dialog"
          aria-label={task ? task.title : 'New task'}
          className="flex h-[max(min(720px,88vh),min(78vh,1300px))] w-full max-w-[max(1000px,min(72vw,1700px))] flex-col overflow-hidden rounded-2xl border border-edge-strong bg-panel shadow-[0_24px_60px_-12px_rgba(0,0,0,0.7)]"
        >
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
                {form.useWorktree ? (
                  <span className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-md bg-accent/15 px-1.5 text-[var(--color-accent-text)]">
                    <Icon size={11}>
                      <circle cx="4.5" cy="3.5" r="1.8" />
                      <circle cx="4.5" cy="12.5" r="1.8" />
                      <circle cx="11.5" cy="3.5" r="1.8" />
                      <path d="M4.5 5.3v5.4M11.5 5.3c0 3-2.8 3.4-5.2 4" />
                    </Icon>
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
                value={form.title}
                placeholder="What needs doing?"
                onChange={(event) => {
                  setTitleMissing(false)
                  patch({ title: event.target.value })
                }}
                className={`-ml-2 h-[34px] w-full px-2 text-[17px] font-semibold tracking-[-0.01em] focus:bg-chrome ${inputText} ${titleMissing ? 'border-[var(--color-pri-urgent)] focus:border-[var(--color-pri-urgent)]' : 'border-edge-strong hover:border-faint/60 focus:border-accent'}`}
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

          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_292px]">
            <section className="flex min-h-0 min-w-0 flex-col">
              <nav className="flex h-[38px] shrink-0 items-stretch gap-0.5 border-b border-edge px-3">
                {tabs.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => selectTab(item.key)}
                    className={`flex items-center gap-1.5 border-b-2 px-2.5 text-[12.5px] font-medium transition-colors hover:text-ink ${tab === item.key ? 'border-accent text-ink' : 'border-transparent text-faint'}`}
                  >
                    {item.label}
                    {item.count ? (
                      <span className="inline-flex h-4 items-center rounded-[5px] bg-raised px-[5px] font-mono text-[10px] text-dim">
                        {item.count}
                      </span>
                    ) : null}
                  </button>
                ))}
              </nav>

              {tab === 'brief' ? (
                <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5 pt-4">
                  <textarea
                    aria-label="Description (markdown)"
                    value={form.description}
                    placeholder="Paste a wayfinder spec here, or write the brief yourself."
                    onChange={(event) => patch({ description: event.target.value })}
                    className="min-h-60 w-full flex-1 resize-none rounded-[10px] border border-edge bg-chrome px-3.5 py-3 font-mono text-[12px] leading-[1.65] text-ink outline-none placeholder:text-faint focus:border-accent"
                  />
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-semibold text-dim">Context files</span>
                      <span className="text-[11.5px] text-faint">
                        Files or folders. Paths go into the prompt; nothing is copied.
                      </span>
                      <button
                        type="button"
                        className={`${GHOST_BTN} ml-auto h-6`}
                        onClick={() => {
                          void window.api.settings
                            .pickFiles(form.repoPath || undefined)
                            .then((picked) =>
                              patch({
                                contextFiles: [
                                  ...form.contextFiles,
                                  ...picked.filter((file) => !form.contextFiles.includes(file))
                                ]
                              })
                            )
                        }}
                      >
                        <PlusIcon size={12} />
                        Add
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {form.contextFiles.map((file) => (
                        <span
                          key={file}
                          title={file}
                          className="inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-[7px] border border-edge bg-card pl-2 pr-1 text-[12px] text-ink"
                        >
                          <Icon size={12}>
                            <path d="M4 2.5h5l3 3v8H4z" />
                            <path d="M9 2.5v3h3" />
                          </Icon>
                          <span className="whitespace-nowrap">{file.split('/').pop()}</span>
                          <span className="truncate font-mono text-[10.5px] text-faint">
                            {file.replace(/\/[^/]+$/, '')}
                          </span>
                          <button
                            type="button"
                            aria-label={`Remove ${file}`}
                            className="inline-flex size-[18px] shrink-0 items-center justify-center rounded text-faint hover:bg-red-400/10 hover:text-red-300"
                            onClick={() =>
                              patch({
                                contextFiles: form.contextFiles.filter(
                                  (current) => current !== file
                                )
                              })
                            }
                          >
                            <CloseIcon size={10} />
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              {tab === 'chats' && task ? (
                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-5 pt-4">
                  <p className="m-0 text-[12px] leading-normal text-faint">
                    Every run on this task, newest first. Opening one resumes it with its original
                    provider.
                  </p>
                  {sessions.length > 0 ? (
                    <ul className="m-0 flex list-none flex-col divide-y divide-edge overflow-hidden rounded-[10px] border border-edge bg-chrome p-0">
                      {sessions.map((entry) => (
                        <li key={entry.id} className="flex items-center gap-3 px-3 py-2.5">
                          <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                            <span className="flex items-center gap-1.5 text-[12.5px] text-ink">
                              <span className="truncate">{entry.label}</span>
                              <Chip>{entry.provider === 'codex' ? 'Codex' : 'Claude'}</Chip>
                              {entry.id === task.agentSession?.id ? (
                                <Chip tone="accent">continues next</Chip>
                              ) : null}
                            </span>
                            <span className="font-mono text-[10.5px] text-faint" title={entry.id}>
                              {new Date(entry.startedAt).toLocaleString()} · {entry.id.slice(0, 8)}
                            </span>
                          </span>
                          <button
                            type="button"
                            className="inline-flex h-[26px] shrink-0 items-center rounded-[7px] border border-edge-strong bg-raised/70 px-2.5 text-[12px] font-medium text-dim hover:bg-raised hover:text-ink"
                            onClick={() => {
                              onResumeSession(task.id, entry.id)
                              onClose()
                            }}
                          >
                            Open
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="m-0 text-[12px] text-faint">No agent has run on this task yet.</p>
                  )}
                  {task.agentSession ? (
                    <button
                      type="button"
                      className={`${GHOST_BTN} -ml-2 h-[26px] self-start`}
                      onClick={() => {
                        void window.api.tasks.forgetSession(task.id).then(onClose)
                      }}
                    >
                      Forget current chat — next run starts fresh
                    </button>
                  ) : null}
                </div>
              ) : null}

              {tab === 'activity' && task ? (
                <ol className="m-0 flex min-h-0 flex-1 list-none flex-col overflow-y-auto px-5 pb-5 pt-4">
                  {task.activity.length === 0 ? (
                    <li className="text-[12px] text-faint">No activity yet.</li>
                  ) : null}
                  {task.activity.map((entry, index) => (
                    <li
                      key={`${index}-${entry.at}`}
                      className="grid grid-cols-[14px_minmax(0,1fr)] gap-x-3"
                    >
                      <span className="flex flex-col items-center">
                        <span
                          className={`mt-[5px] size-[7px] shrink-0 rounded-full ${entry.author === 'you' || !entry.author ? 'bg-dim' : 'bg-col-progress'}`}
                        />
                        {index < task.activity.length - 1 ? (
                          <span className="w-px flex-1 bg-edge" />
                        ) : null}
                      </span>
                      <div className="flex flex-col gap-[3px] pb-4">
                        {entry.at ? (
                          <span className="font-mono text-[10.5px] text-faint">
                            {new Date(entry.at).toLocaleString()}
                            {entry.author ? ` · ${entry.author}` : ''}
                          </span>
                        ) : null}
                        <p className="m-0 whitespace-pre-wrap text-[12.5px] leading-normal text-ink">
                          {entry.message}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : null}

              {tab === 'prompt' ? (
                <div className="flex min-h-0 flex-1 flex-col gap-2.5 px-5 pb-5 pt-4">
                  <div className="flex items-center gap-2 text-[12px] text-faint">
                    <span>
                      Exactly what {form.provider === 'codex' ? 'Codex' : 'Claude'} receives, using
                    </span>
                    <Chip>{templateName}</Chip>
                  </div>
                  <pre className="m-0 min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-[10px] border border-edge bg-chrome px-3.5 py-3 font-mono text-[11.5px] leading-[1.65] text-dim">
                    {previewError
                      ? 'Give the task a title first — the preview is built from the saved task.'
                      : (preview ?? 'Building preview…')}
                  </pre>
                </div>
              ) : null}
            </section>

            <aside className="flex min-h-0 flex-col gap-5 overflow-y-auto border-l border-edge bg-chrome/50 p-4">
              {!task && settings.taskPresets.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <span className={SECTION_LABEL}>Preset</span>
                  <Select
                    compact
                    aria-label="Preset"
                    value={appliedPresetId}
                    onChange={(event) => applyPreset(event.target.value)}
                  >
                    <option value="">Blank task</option>
                    {settings.taskPresets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name}
                      </option>
                    ))}
                  </Select>
                  <span className="text-[11px] leading-[1.4] text-faint">
                    Fills in this form from a saved starting point. The task keeps no link to it.
                  </span>
                </div>
              ) : null}
              <div className="flex flex-col gap-2">
                <span className={SECTION_LABEL}>Blocked by</span>
                <div className="flex flex-col items-stretch gap-1.5">
                  {form.blockedBy.map((id) => {
                    const blocker = lookup.get(id)
                    return (
                      <span
                        key={id}
                        title={blocker ? `${id} — ${blocker.title}` : `${id} does not exist`}
                        className={`inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-[7px] border bg-card pl-2 pr-1 text-[12px] ${
                          blocker
                            ? 'border-edge text-ink'
                            : 'border-[var(--color-col-review)]/50 text-[var(--color-col-review-text)]'
                        }`}
                      >
                        <span className="font-mono text-[10.5px]">{id}</span>
                        <span className="truncate">
                          {blocker
                            ? `${blocker.title} · ${TASK_STATUS_LABELS[blocker.status]}`
                            : 'unknown'}
                        </span>
                        <button
                          type="button"
                          aria-label={`Remove blocker ${id}`}
                          className="inline-flex size-[18px] shrink-0 items-center justify-center rounded text-faint hover:bg-red-400/10 hover:text-red-300"
                          onClick={() =>
                            patch({
                              blockedBy: form.blockedBy.filter((current) => current !== id)
                            })
                          }
                        >
                          <CloseIcon size={10} />
                        </button>
                      </span>
                    )
                  })}
                  <Select
                    compact
                    aria-label="Add blocker"
                    value=""
                    onChange={(event) => {
                      if (event.target.value) {
                        patch({ blockedBy: [...form.blockedBy, event.target.value] })
                      }
                    }}
                  >
                    <option value="">Add blocker…</option>
                    {blockerChoices.map((choice) => (
                      <option key={choice.id} value={choice.id} disabled={choice.cycle}>
                        {choice.id} — {choice.title}
                        {choice.cycle ? ' (would create a cycle)' : ''}
                      </option>
                    ))}
                  </Select>
                </div>
                <span className="text-[11px] text-faint">
                  The task waits until each of these is Done.
                </span>
                {existingCycle ? (
                  <span className="text-[11px] text-[var(--color-col-review-text)]">
                    Dependency cycle: {existingCycle.join(' → ')}. None of these can start.
                  </span>
                ) : null}
                {missingBlockers.length > 0 ? (
                  <span className="text-[11px] text-[var(--color-col-review-text)]">
                    {missingBlockers.join(', ')} not found — ignored until it exists. Remove it to
                    clear this.
                  </span>
                ) : null}
              </div>
              <div className="flex flex-col gap-0.5">
                <span className={`${SECTION_LABEL} pb-1.5`}>Details</span>
                <PropertySelect
                  label="Status"
                  value={form.status}
                  dots={STATUS_DOT}
                  options={TASK_STATUSES.map((value) => ({
                    value,
                    label: TASK_STATUS_LABELS[value]
                  }))}
                  onChange={(status) => patch({ status })}
                />
                <PropertySelect
                  label="Priority"
                  value={form.priority}
                  dots={PRIORITY_DOT}
                  options={TASK_PRIORITIES.map((value) => ({
                    value,
                    label: TASK_PRIORITY_LABELS[value]
                  }))}
                  onChange={(priority) => patch({ priority })}
                />
                <PropertySelect
                  label="Readiness"
                  value={form.readiness}
                  dots={READINESS_DOT}
                  options={TASK_READINESS.map((value) => ({
                    value,
                    label: TASK_READINESS_LABELS[value]
                  }))}
                  onChange={(readiness) => patch({ readiness })}
                />
                <div className="grid h-8 grid-cols-[76px_minmax(0,1fr)] items-center gap-2">
                  <span className="text-[12px] text-dim">Project</span>
                  <input
                    aria-label="Project"
                    value={form.project}
                    placeholder={repoFolder || 'None'}
                    onChange={(event) => patch({ project: event.target.value })}
                    className={`h-7 w-full rounded-[7px] border-transparent px-2 text-[12.5px] hover:border-edge hover:bg-card focus:border-accent focus:bg-chrome ${inputText}`}
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
                    className={`h-7 w-full rounded-[7px] px-2 text-[12.5px] hover:border-edge hover:bg-card focus:border-accent focus:bg-chrome ${inputText}`}
                  />
                </div>
                {saved ? (
                  <SourceLink
                    task={linkedTask ?? saved}
                    settings={settings}
                    onTask={setLinkedTask}
                  />
                ) : null}
                <TagsEditor tags={form.tags} onChange={(tags) => patch({ tags })} />
              </div>

              <div className="h-px shrink-0 bg-edge" />

              <div className="flex flex-col gap-3">
                <span className={SECTION_LABEL}>Agent run</span>
                <div className="flex flex-col gap-[5px]">
                  <span className="text-[12px] text-dim">Provider</span>
                  <Select
                    aria-label="Provider"
                    className={`${BOXED_CONTROL} !h-[30px] !py-0 !text-[12.5px]`}
                    value={form.provider}
                    onChange={(event) =>
                      patch({ provider: event.target.value as 'claude' | 'codex' })
                    }
                  >
                    {settings.enabledProviders.map((item) => (
                      <option key={item} value={item}>
                        {providerLabel(item)}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="flex flex-col gap-[5px]">
                  <span className="text-[12px] text-dim">Agent prompt</span>
                  <Select
                    aria-label="Prompt template"
                    className={`${BOXED_CONTROL} !h-[30px] !py-0 !text-[12.5px]`}
                    value={form.promptTemplateId}
                    onChange={(event) => patch({ promptTemplateId: event.target.value })}
                  >
                    <option value="">Auto — {routedName}</option>
                    {settings.promptTemplates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </Select>
                  <span className="text-[11px] leading-[1.4] text-faint">
                    {form.promptTemplateId
                      ? 'Pinned — used whatever column the task is in.'
                      : `Follows the column. Currently runs ${routedName}.`}
                  </span>
                </div>
                <div className="flex flex-col gap-[5px]">
                  <span className="text-[12px] text-dim">Working directory</span>
                  <div className="flex h-[30px] items-center gap-1.5 rounded-[7px] border border-edge-strong bg-chrome pl-2.5 pr-1 focus-within:border-accent">
                    <input
                      aria-label="Working directory"
                      value={form.repoPath}
                      placeholder="/Users/you/Workspace/project"
                      title={form.repoPath}
                      onChange={(event) => patch({ repoPath: event.target.value })}
                      className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] text-ink outline-none placeholder:text-faint"
                    />
                    <button
                      type="button"
                      aria-label="Browse"
                      onClick={() => {
                        void window.api.settings
                          .pickDirectory(form.repoPath || undefined)
                          .then((picked) => {
                            if (picked) patch({ repoPath: picked })
                          })
                      }}
                      className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-[5px] text-dim hover:bg-raised hover:text-ink"
                    >
                      <FolderIcon />
                    </button>
                  </div>
                </div>
                {!form.repoPath.trim() && !settings.defaultRepoPath ? (
                  <span className="text-[11.5px] text-dim">
                    No working directory set: the agent runs in the workspace folder.
                  </span>
                ) : null}
                <Toggle
                  checked={form.useWorktree}
                  onChange={(useWorktree) => patch({ useWorktree })}
                  label="Own git worktree"
                  hint={
                    !form.useWorktree
                      ? 'Runs directly in the working directory.'
                      : form.repoPath
                        ? branchesLoaded && branchInfo.branches.length === 0
                          ? 'This folder does not look like a git repository, so the agent will run in it directly. Turn this off for non-code work.'
                          : `Runs on branch styr/${taskId} so parallel agents never share a checkout.`
                        : 'Set a working directory first — the worktree is created from that repository.'
                  }
                />
                {form.useWorktree && form.repoPath ? (
                  <div className="flex flex-col gap-1">
                    <Select
                      aria-label="Base branch"
                      value={form.baseBranch}
                      disabled={Boolean(task?.worktreePath)}
                      onChange={(event) => patch({ baseBranch: event.target.value })}
                    >
                      <option value="">
                        {branchInfo.current
                          ? `Current branch (${branchInfo.current})`
                          : 'Current branch'}
                      </option>
                      {branchInfo.branches.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </Select>
                    <span className="text-[11px] text-dim">
                      {task?.worktreePath
                        ? 'Fixed once the worktree exists.'
                        : 'The worktree branches from the latest origin tip of this branch.'}
                    </span>
                  </div>
                ) : null}
                <Toggle
                  checked={form.orchestrate}
                  onChange={(orchestrate) => patch({ orchestrate })}
                  label="Dispatch can start it"
                  hint={
                    form.orchestrate
                      ? 'You can still start it yourself.'
                      : 'Only you can start this task.'
                  }
                />
                {task?.worktreePath && form.useWorktree ? (
                  <div className="-mt-1 flex items-center gap-1.5 rounded-[7px] border border-edge bg-chrome py-1.5 pl-2.5 pr-1.5">
                    <span
                      title={task.worktreePath}
                      className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-dim"
                    >
                      {task.worktreePath}
                    </span>
                    <button
                      type="button"
                      title="Deletes the checkout and uncommitted work. The branch is kept."
                      className="h-5 shrink-0 rounded-[5px] px-1.5 text-[11px] font-medium text-red-300 hover:bg-red-400/10"
                      onClick={() => {
                        void window.api.tasks.removeWorktree(task.id).then(onClose)
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ) : null}
              </div>
            </aside>
          </div>

          <footer className="flex shrink-0 items-center gap-2 border-t border-edge bg-chrome/40 py-3 pl-3 pr-4">
            {task ? (
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  className={`${GHOST_BTN} h-7`}
                  onClick={() => void window.api.tasks.openInEditor(task.id)}
                >
                  <Icon>
                    <path d="M9 3h4v4M13 3 7.5 8.5" />
                    <path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
                  </Icon>
                  Open file
                </button>
                <button
                  type="button"
                  className={`${GHOST_BTN} h-7`}
                  onClick={() => void window.api.tasks.reveal(task.id)}
                >
                  <FolderIcon />
                  Reveal
                </button>
                {noGit ? null : (
                  <button
                    type="button"
                    className={`${GHOST_BTN} h-7`}
                    disabled={!changes || changes.files.length === 0}
                    title={
                      !changes
                        ? 'Reading changes…'
                        : changes.files.length === 0
                          ? changes.branch
                            ? `No changes on ${changes.branch} yet`
                            : 'No changes to show'
                          : 'View changes'
                    }
                    onClick={() => onShowChanges(task)}
                  >
                    <svg
                      aria-hidden
                      viewBox="0 0 16 16"
                      width="13"
                      height="13"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M4 2.5h5l3 3v8H4z" />
                      <path d="M6.25 7h3.5M8 5.25v3.5M6.25 11h3.5" />
                    </svg>
                    Changes
                    {changes && changes.files.length > 0 ? (
                      <DiffCount
                        added={changes.totalAdditions}
                        removed={changes.totalDeletions}
                        files={changes.totalFiles}
                      />
                    ) : null}
                  </button>
                )}
                <button
                  type="button"
                  className={`${GHOST_BTN} h-7`}
                  title={
                    task.archivedAt
                      ? 'Put this task back on the board'
                      : 'Take this task off the board; the file is kept'
                  }
                  onClick={() =>
                    void window.api.tasks.archive(task.id, !task.archivedAt).then(onClose)
                  }
                >
                  {task.archivedAt ? 'Unarchive' : 'Archive'}
                </button>
                <span className="mx-1 h-4 w-px bg-edge" />
                <button
                  type="button"
                  aria-label="Delete task"
                  title="Delete task"
                  className="inline-flex h-7 items-center justify-center gap-1.5 rounded-[7px] px-2 text-[12px] text-danger transition-colors hover:bg-red-500/10"
                  onClick={() => setConfirmingDelete(true)}
                >
                  <Icon size={14}>
                    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
                  </Icon>
                  Delete
                </button>
              </div>
            ) : presetName === null ? (
              <button
                type="button"
                className={`${GHOST_BTN} h-7`}
                onClick={() => setPresetName('')}
              >
                Save as preset…
              </button>
            ) : (
              <form
                className="flex items-center gap-1.5"
                onSubmit={(event) => {
                  event.preventDefault()
                  void savePreset()
                }}
              >
                <input
                  autoFocus
                  aria-label="Preset name"
                  placeholder="Preset name"
                  value={presetName}
                  onChange={(event) => setPresetName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.stopPropagation()
                      setPresetName(null)
                    }
                  }}
                  className="h-7 w-40 rounded-[7px] border border-edge-strong bg-chrome px-2 text-[12px] text-ink outline-none focus:border-accent"
                />
                <button type="submit" disabled={!presetName.trim()} className={`${GHOST_BTN} h-7`}>
                  Save preset
                </button>
                <button
                  type="button"
                  className={`${GHOST_BTN} h-7`}
                  onClick={() => setPresetName(null)}
                >
                  Cancel
                </button>
              </form>
            )}
            <div className="flex-1" />
            <button
              type="button"
              disabled={saving}
              onClick={() => void saveAndClose()}
              className="inline-flex h-[30px] items-center gap-2 rounded-lg border border-edge-strong bg-raised/70 px-3 text-[12.5px] font-medium text-dim transition-colors hover:bg-raised hover:text-ink disabled:pointer-events-none disabled:opacity-40"
            >
              Save
              <kbd className="font-mono text-[10px] text-faint">⌘↵</kbd>
            </button>
            {form.status !== 'done' ? (
              <button
                type="button"
                disabled={saving}
                onClick={() => void saveAndLaunch()}
                className="inline-flex h-[30px] items-center gap-[7px] rounded-lg border border-accent bg-accent px-3.5 text-[12.5px] font-semibold text-[var(--color-on-accent)] shadow-[0_1px_0_rgba(255,255,255,0.12)_inset] transition-colors hover:bg-accent/90 disabled:pointer-events-none disabled:opacity-40"
              >
                <svg aria-hidden viewBox="0 0 16 16" width="11" height="11" fill="currentColor">
                  <path d="M5 3.5v9l7.25-4.5z" />
                </svg>
                Save &amp; Start
              </button>
            ) : null}
          </footer>
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
