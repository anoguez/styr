import type { Settings, Task, TaskDraft } from './types.js'

/** The settings a derived task takes its defaults from. */
export type DraftDefaults = Pick<Settings, 'defaultRepoPath' | 'defaultProvider' | 'taskDefaults'>

/**
 * What every task Styr creates on the user's behalf shares. `orchestrate: false` is the invariant:
 * a system-originated task waits for the user (or the launch that created it) rather than being
 * picked up by the next Orchestrate run. It is set here, once, and the builders below cannot
 * override it.
 */
function derivedDraft(
  fields: Omit<TaskDraft, 'orchestrate' | 'status' | 'contextFiles'> &
    Partial<Pick<TaskDraft, 'contextFiles'>>
): TaskDraft {
  return { status: 'backlog', contextFiles: [], ...fields, orchestrate: false }
}

export interface AskDraftInput {
  title: string
  description: string
  /** The task being asked about; the question inherits its priority. */
  source: Pick<Task, 'priority'>
  /** The fork runs where the source does. */
  cwd: string
  provider: 'claude' | 'codex'
}

/** An Ask agent question on a task's chat. It needs no branch of its own. */
export function askDraft(input: AskDraftInput): TaskDraft {
  return derivedDraft({
    title: input.title,
    description: input.description,
    priority: input.source.priority,
    readiness: 'ready',
    tags: ['ask'],
    repoPath: input.cwd,
    useWorktree: false,
    provider: input.provider
  })
}

export interface HandoffDraftInput {
  title: string
  description: string
  source?: Pick<Task, 'priority' | 'tags' | 'repoPath'>
  baseBranch?: string
  /** The handoff document, attached as context. */
  document: string
}

/** The task a handoff creates for the next agent. */
export function handoffDraft(input: HandoffDraftInput, settings: DraftDefaults): TaskDraft {
  const { source } = input
  return derivedDraft({
    title: input.title,
    description: input.description,
    priority: source?.priority ?? 'medium',
    readiness: 'ready',
    tags: [...new Set([...(source?.tags ?? []), 'handoff'])],
    repoPath: source?.repoPath || settings.defaultRepoPath.trim() || undefined,
    baseBranch: input.baseBranch,
    useWorktree: settings.taskDefaults.useWorktree,
    contextFiles: [input.document],
    provider: settings.defaultProvider
  })
}

export interface TerminalDraftInput {
  title: string
  description: string
  tags?: string[]
  /** Specified well enough to run as it is, so it skips the spec lane. */
  ready?: boolean
  /** An agent starts on it straight away (Ask agent). */
  launch?: boolean
  /** The repository the terminal is inside, when it is inside one. */
  repoPath?: string
}

/** A task made from output in a terminal. */
export function terminalDraft(input: TerminalDraftInput, settings: DraftDefaults): TaskDraft {
  return derivedDraft({
    title: input.title,
    description: input.description,
    priority: 'medium',
    readiness: input.ready ? 'ready' : 'needs_spec',
    tags: input.tags ?? [],
    repoPath: input.repoPath || settings.defaultRepoPath.trim() || undefined,
    // A question needs no branch of its own.
    useWorktree: input.launch ? false : settings.taskDefaults.useWorktree,
    provider: settings.defaultProvider
  })
}
