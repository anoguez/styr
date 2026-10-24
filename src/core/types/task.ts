import type { OrchestrationLane } from './agents.js'

export const TASK_STATUSES = ['backlog', 'in_progress', 'in_review', 'done'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done'
}

export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const
export type TaskPriority = (typeof TASK_PRIORITIES)[number]

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent'
}

export const TASK_READINESS = ['ready', 'needs_spec'] as const
export type TaskReadiness = (typeof TASK_READINESS)[number]

export const TASK_READINESS_LABELS: Record<TaskReadiness, string> = {
  ready: 'Ready to work',
  needs_spec: 'Needs spec'
}

export type TaskSource = 'markdown' | 'json'

/** Most repositories a task may add beside its primary one. */
export const MAX_EXTRA_REPOS = 5

/**
 * A repository a task touches besides its primary one (`Task.repoPath`). Its `baseBranch`,
 * `worktreePath` and `prUrl` mean what the task's own fields mean for the primary repo.
 */
export interface ExtraRepo {
  repoPath: string
  baseBranch?: string
  worktreePath?: string
  prUrl?: string
}

export interface Task {
  id: string
  title: string
  status: TaskStatus
  priority: TaskPriority
  readiness: TaskReadiness
  description: string
  activity: ActivityEntry[]
  project?: string
  tags: string[]
  repoPath?: string
  orchestrate: boolean
  useWorktree: boolean
  /** Branch the worktree starts from; unset means the main checkout's current branch. */
  baseBranch?: string
  worktreePath?: string
  /**
   * More repositories the task spans, each with its own worktree on the task's branch. Settable
   * only before the first launch; ignored unless `useWorktree` is on. Empty for a single-repo task.
   */
  extraRepos: ExtraRepo[]
  /** Ids of same-workspace tasks that must be Done first. Whether the task is blocked is derived. */
  blockedBy: string[]
  contextFiles: string[]
  promptTemplateId?: string
  provider?: 'claude' | 'codex'
  /**
   * The model the task's own provider runs with, as that CLI names it (`opus`, `gpt-5-codex`).
   * Unset leaves the choice to the prompt template, then to the CLI's own default.
   */
  model?: string
  agentSession?: { provider: 'claude' | 'codex'; id: string }
  sessions: TaskSessionRef[]
  externalRef?: ExternalRef
  prUrl?: string
  order: number
  /** When the task last entered Done. Falls back to `updatedAt` for files edited by hand. */
  doneAt?: string
  /** Set while the task is archived: off the board, still on disk. Independent of status. */
  archivedAt?: string
  /** Questions an agent put to the owner. Changed only by `askQuestion` / `answerQuestion`. */
  questions: TaskQuestion[]
  createdAt: string
  updatedAt: string
  filePath: string
  format: TaskSource
}

/** One Claude conversation started for a task, kept so past runs stay reachable. */
export interface TaskSessionRef {
  id: string
  provider: 'claude' | 'codex'
  startedAt: string
  label: string
  /** The prompt template the run started with. Older entries have only the `label`. */
  templateId?: string
  /** Set when Auto-run started this session, in that lane. Absent for a person's launch. */
  dispatch?: OrchestrationLane
  /** On a review: an implementer was launched over it, so the review asked for fixes. */
  sentBack?: true
}

export interface ExternalRef {
  provider: string
  id: string
  url?: string
  /** Which source (`SourceConfig.id`) the item came from. */
  sourceId?: string
  /** Which repository of that source, e.g. `owner/name`; item ids repeat across repositories. */
  target?: string
  /** The remote item's last-update stamp at the last sync, for change detection. */
  remoteUpdatedAt?: string
  /** Hash of the title and body as last imported, to tell a local edit from the remote one. */
  syncedHash?: string
  /** Per-field hashes of the last import, so editing the title does not freeze the body. */
  syncedTitleHash?: string
  syncedBodyHash?: string
}

/** A question for the owner (`ask_owner`). Open while it has no `answer`. */
export interface TaskQuestion {
  id: string
  askedAt: string
  askedBy: string
  text: string
  answer?: string
  answeredAt?: string
  answeredBy?: string
}

/**
 * What became of an answer to a question: the route it took to the agent (`queued` at its next
 * stop, `now`, `resume` the chat), `recorded` when there is no chat to send it to (the agent reads
 * it from the prompt on its next launch), or `failed` — recorded, but the delivery threw.
 */
export type AnswerDelivery = 'queued' | 'now' | 'resume' | 'recorded' | 'failed'

export interface AnswerResult {
  task: Task
  delivery: AnswerDelivery
  /** Why the delivery failed; set only then. */
  error?: string
}

export interface ActivityEntry {
  at: string
  author: string
  message: string
}

export type TaskDraft = Partial<Omit<Task, 'filePath' | 'format' | 'activity' | 'questions'>> &
  Pick<Task, 'title'>

export type TaskPatch = Partial<
  Omit<Task, 'id' | 'filePath' | 'format' | 'activity' | 'createdAt' | 'archivedAt' | 'questions'>
>

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[]
  readiness?: TaskReadiness
  project?: string
  tag?: string
  query?: string
}

/**
 * A reusable starting point for the New task dialog. Applying one copies its values into the form;
 * the task keeps no reference to it. Called a preset, never a template: `PromptTemplate` owns that word.
 */
export interface TaskPreset {
  /** Generated from the name at creation; never changes, so a rename edits `name` only. */
  id: string
  name: string
  title: string
  description: string
  tags: string[]
  priority: TaskPriority
  readiness: TaskReadiness
  useWorktree: boolean
  orchestrate: boolean
  provider?: 'claude' | 'codex'
  promptTemplateId?: string
  baseBranch?: string
}

export const MAX_TASK_PRESETS = 50

/** Shipped for a workspace whose `settings.json` has no `taskPresets` key. */
export const DEFAULT_TASK_PRESETS: TaskPreset[] = [
  {
    id: 'bug',
    name: 'Bug',
    title: '',
    description: '## Steps to reproduce\n\n\n## Expected\n\n\n## Actual\n',
    tags: ['bug'],
    priority: 'high',
    readiness: 'ready',
    useWorktree: true,
    orchestrate: true
  },
  {
    id: 'spec',
    name: 'Spec',
    title: '',
    description: '',
    tags: ['spec'],
    priority: 'medium',
    readiness: 'needs_spec',
    useWorktree: false,
    orchestrate: true
  },
  {
    id: 'refactor',
    name: 'Refactor',
    title: '',
    description: '',
    tags: ['refactor'],
    priority: 'medium',
    readiness: 'ready',
    useWorktree: true,
    orchestrate: true
  },
  {
    id: 'research',
    name: 'Research',
    title: '',
    description: '## Question\n\n\n## Sources to use\n\n\n## Deliverable\n',
    tags: ['research'],
    priority: 'medium',
    readiness: 'ready',
    useWorktree: false,
    orchestrate: true
  },
  {
    id: 'writing',
    name: 'Writing',
    title: '',
    description: '## Audience\n\n\n## Outline\n\n\n## Length and tone\n',
    tags: ['writing'],
    priority: 'medium',
    readiness: 'ready',
    useWorktree: false,
    orchestrate: true
  }
]

/**
 * How much of the Done column stays on the board. Tasks over either limit are hidden, not
 * archived: they stay one click away ("Show all") and nothing is written to their files.
 * 0 disables a limit.
 */
export interface DoneCap {
  /** Show at most this many of the most recently finished tasks. */
  maxCount: number
  /** Hide tasks that finished more than this many days ago. */
  maxAgeDays: number
}

export const DEFAULT_DONE_CAP: DoneCap = { maxCount: 20, maxAgeDays: 14 }

/** Starting values for the new-task form. Existing tasks keep whatever they saved. */
export interface TaskDefaults {
  /** New tasks start with "Let Orchestrate start this task" checked. */
  orchestrate: boolean
  /** New tasks start with "Run in its own git worktree" checked. */
  useWorktree: boolean
}
