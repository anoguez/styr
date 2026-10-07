import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clearAgentStatus, supportDir } from './agentStore.js'
import { checkoutPath, ensureWorktree, type Checkout as WorktreeCheckout } from './worktree.js'
import { isGitRepo } from './gitExec.js'
import { buildPrompt, resolveTemplateFor } from './prompt.js'
import { providerById, providerFor } from './providers/index.js'
import { shellQuote } from './shell.js'
import { worktreeKey, type Settings, type Task } from './types.js'

export { shellQuote }

export interface LaunchPlan {
  provider: 'claude' | 'codex'
  command: string
  cwd: string
  sessionId: string
  resumed: boolean
  worktreePath?: string
  warning?: string
}

export function workingDirFor(settings: Settings, task: Task): string {
  return task.repoPath || settings.defaultRepoPath || settings.storageDir
}

/** Where the session will run, without creating anything — safe to call when previewing a prompt. */
export function plannedCwd(settings: Settings, task: Task): string {
  const repo = workingDirFor(settings, task)
  return task.useWorktree ? checkoutPath(taskCheckout(settings, task, repo)) : repo
}

function taskCheckout(settings: Settings, task: Task, repoPath: string): WorktreeCheckout {
  return {
    repoPath,
    key: worktreeKey(settings.activeWorkspaceId, task.id),
    baseBranch: task.baseBranch
  }
}

interface Checkout {
  cwd: string
  worktreePath?: string
  warning?: string
}

/**
 * Resolves where the session runs. A task set to use a worktree gets its own checkout so parallel
 * agents never share one working directory; if that cannot be done the session still starts in the
 * plain repository rather than failing, and says why.
 */
function checkoutFor(settings: Settings, task: Task): Checkout {
  const repo = workingDirFor(settings, task)
  if (!task.useWorktree) return { cwd: repo }
  try {
    const worktree = ensureWorktree(taskCheckout(settings, task, repo))
    return { cwd: worktree.path, worktreePath: worktree.path }
  } catch (error) {
    return {
      cwd: repo,
      warning: `Could not create a worktree, running in ${repo} instead: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }
}

export function renderPrompt(settings: Settings, task: Task, templateId?: string): string {
  const template = resolveTemplateFor(settings, task, templateId)
  const cwd = plannedCwd(settings, task)
  return buildPrompt(template.template, { ...task, repoPath: cwd }, settings.activeWorkspaceId, {
    plainFolder: !task.useWorktree && !isGitRepo(cwd)
  })
}

/** When a past conversation was last written, for dating a chat we only learned about later. */
export function sessionTranscriptTime(
  settings: Settings,
  task: Task,
  sessionId: string
): string | undefined {
  return providerFor(settings, task).sessionTime(sessionId)
}

export interface LaunchOptions {
  provider?: 'claude' | 'codex'
  /** A provider-created session (Codex app-server) that must be resumed without probing disk. */
  sessionId?: string
  templateId?: string
  homeRoot?: string
  /**
   * Send the rendered prompt even when resuming. A bare resume submits nothing, so any run
   * started on the task's behalf rather than by the user must set this or the agent just sits
   * at a prompt with no instruction.
   */
  withPrompt?: boolean
  /** Start a new conversation even if the task already has one, so a reviewer is not the author. */
  fresh?: boolean
  /** Resume one specific past conversation, for looking back at what a run did. */
  resume?: string
  /** Start as a copy of this conversation (Ask agent from a task session). Always sends the prompt. */
  forkFrom?: string
  /** Names the chat in the task's history; defaults to the prompt template's name. */
  sessionLabel?: string
}

export function planLaunch(
  settings: Settings,
  task: Task,
  options: LaunchOptions = {}
): LaunchPlan {
  const { templateId, homeRoot, withPrompt = false, fresh = false, resume, forkFrom } = options
  const provider = options.provider ? providerById(options.provider) : providerFor(settings, task)
  const checkout = checkoutFor(settings, task)
  const existing = task.agentSession?.provider === provider.id ? task.agentSession.id : undefined

  clearAgentStatus(settings, task.id)

  const writePrompt = (): string => {
    const file = join(supportDir(settings, 'prompts'), `${task.id}.txt`)
    writeFileSync(file, renderPrompt(settings, task, templateId), 'utf8')
    return `"$(cat '${shellQuote(file)}')"`
  }

  const wanted = resume ?? options.sessionId ?? existing
  const resumable =
    !forkFrom &&
    Boolean(options.sessionId || (!fresh && wanted && provider.sessionExists(wanted, homeRoot)))
  const sessionId =
    resumable && wanted
      ? wanted
      : fresh
        ? provider.newSessionId()
        : (existing ?? provider.newSessionId())
  const prompt = !resumable || withPrompt ? writePrompt() : undefined

  return {
    provider: provider.id,
    command: provider.buildCommand({
      settings,
      taskId: task.id,
      sessionId,
      resume: resumable,
      forkFrom,
      cwd: checkout.cwd,
      prompt
    }),
    cwd: checkout.cwd,
    sessionId,
    resumed: resumable,
    worktreePath: checkout.worktreePath,
    warning: checkout.warning
  }
}
