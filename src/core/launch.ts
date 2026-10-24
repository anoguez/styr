import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clearAgentStatus, supportDir } from './agentStore.js'
import { branchNameFor, checkoutPath, ensureWorktree, isGitRepo } from './worktree.js'
import { checkoutOf, checkoutsOf, type Checkout as GitCheckout } from './taskCheckout.js'
import { launchModel } from './agentModel.js'
import { buildPrompt, resolveTemplateFor, type PromptRepo } from './prompt.js'
import { providerById, providerFor } from './providers/index.js'
import { shellQuote } from './shell.js'
import { resolveShell } from './platformShell.js'
import type { OrchestrationLane, Settings, Task } from './types.js'

export { shellQuote }

export interface LaunchPlan {
  provider: 'claude' | 'codex'
  command: string
  cwd: string
  sessionId: string
  resumed: boolean
  worktreePath?: string
  /** The branch a worktree created by this launch was cut from. */
  worktreeBase?: string
  /** Every other repository of a multi-repo task: where the agent finds it, empty otherwise. */
  extraDirs: ExtraDir[]
  /** The extras whose worktree this launch ensured, for `launchPatch` to record. */
  extraWorktrees: ExtraWorktree[]
  warning?: string
}

export interface ExtraDir {
  repoPath: string
  /** The worktree, or the plain repository when none could be made. */
  path: string
  worktree: boolean
}

export interface ExtraWorktree {
  repoPath: string
  worktreePath: string
  /** On creation, the branch it was cut from; unset for a worktree that already existed. */
  baseBranch?: string
}

export function workingDirFor(settings: Settings, task: Task): string {
  return task.repoPath || settings.defaultRepoPath || settings.storageDir
}

/** Where the session will run, without creating anything — safe to call when previewing a prompt. */
export function plannedCwd(settings: Settings, task: Task): string {
  const repo = workingDirFor(settings, task)
  return task.useWorktree ? checkoutPath(checkoutFrom(settings, task, repo)) : repo
}

function checkoutFrom(settings: Settings, task: Task, repo: string): GitCheckout {
  return checkoutOf(settings.activeWorkspaceId, task, repo, settings.worktreeLocation)
}

interface Checkout {
  cwd: string
  worktreePath?: string
  worktreeBase?: string
  extraDirs: ExtraDir[]
  extraWorktrees: ExtraWorktree[]
  warning?: string
}

/** A worktree that could not be made is no reason not to start: the repository itself will do. */
function fallbackWarning(name: string | undefined, repo: string, error: unknown): string {
  return `Could not create a worktree${name ? ` for ${name}` : ''}, running in ${repo} instead: ${
    error instanceof Error ? error.message : String(error)
  }`
}

/**
 * Resolves where the session runs. A task set to use a worktree gets its own checkout so parallel
 * agents never share one working directory; if that cannot be done the session still starts in the
 * plain repository rather than failing, and says why. A multi-repo task does the same for each of
 * its other repositories: one that fails falls back alone, and the warnings are joined.
 */
function checkoutFor(settings: Settings, task: Task): Checkout {
  const repo = workingDirFor(settings, task)
  if (!task.useWorktree) return { cwd: repo, extraDirs: [], extraWorktrees: [] }
  const warnings: string[] = []
  const repos = checkoutsOf(
    settings.activeWorkspaceId,
    { ...task, repoPath: repo },
    settings.worktreeLocation
  )
  const [primary, ...extras] = repos
  let result: Pick<Checkout, 'cwd' | 'worktreePath' | 'worktreeBase'> = { cwd: repo }
  try {
    const worktree = ensureWorktree((primary as (typeof repos)[number]).checkout)
    result = { cwd: worktree.path, worktreePath: worktree.path, worktreeBase: worktree.baseBranch }
  } catch (error) {
    warnings.push(
      fallbackWarning(
        extras.length > 0 ? (primary as (typeof repos)[number]).repoName : undefined,
        repo,
        error
      )
    )
  }
  const extraDirs: ExtraDir[] = []
  const extraWorktrees: ExtraWorktree[] = []
  for (const extra of extras) {
    const { repoPath } = extra.checkout
    try {
      const worktree = ensureWorktree(extra.checkout)
      extraDirs.push({ repoPath, path: worktree.path, worktree: true })
      extraWorktrees.push({
        repoPath,
        worktreePath: worktree.path,
        baseBranch: worktree.baseBranch
      })
    } catch (error) {
      extraDirs.push({ repoPath, path: repoPath, worktree: false })
      warnings.push(fallbackWarning(extra.repoName, repoPath, error))
    }
  }
  return {
    ...result,
    extraDirs,
    extraWorktrees,
    warning: warnings.length > 0 ? warnings.join('; ') : undefined
  }
}

/**
 * The other repositories of a multi-repo task as the prompt names them. `launched` is what a
 * launch actually made (a worktree, or the plain repository after a failure); a preview has only
 * the planned worktree paths and the bases the task file already records.
 */
function promptRepos(
  settings: Settings,
  task: Task,
  launched?: Pick<Checkout, 'extraDirs' | 'extraWorktrees'>
): { primaryName?: string; extraRepos: PromptRepo[] } {
  const repos = checkoutsOf(
    settings.activeWorkspaceId,
    { ...task, repoPath: workingDirFor(settings, task) },
    settings.worktreeLocation
  )
  const [primary, ...extras] = repos
  if (!primary || extras.length === 0) return { extraRepos: [] }
  return {
    primaryName: primary.repoName,
    extraRepos: extras.map((extra) => {
      const { repoPath, key, baseBranch } = extra.checkout
      const dir = launched?.extraDirs.find((candidate) => candidate.repoPath === repoPath)
      const made = launched?.extraWorktrees.find((candidate) => candidate.repoPath === repoPath)
      return {
        name: extra.repoName,
        path: dir?.path ?? checkoutPath(extra.checkout),
        baseBranch: baseBranch ?? made?.baseBranch ?? "the repository's default branch",
        branch: branchNameFor(key)
      }
    })
  }
}

export function renderPrompt(
  settings: Settings,
  task: Task,
  templateId?: string,
  launched?: Pick<Checkout, 'extraDirs' | 'extraWorktrees'>
): string {
  const template = resolveTemplateFor(settings, task, templateId)
  const cwd = plannedCwd(settings, task)
  return buildPrompt(template.template, { ...task, repoPath: cwd }, settings.activeWorkspaceId, {
    plainFolder: !task.useWorktree && !isGitRepo(cwd),
    ...(task.useWorktree ? promptRepos(settings, task, launched) : {})
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
  /** Put before the rendered prompt, e.g. to tell an implementer a review sent the task back. */
  promptPreface?: string
  /**
   * Literal text sent instead of the rendered template (Request changes resuming a chat). Not
   * with `templateId` or `promptPreface`, which shape a template this replaces.
   */
  prompt?: string
  /** Auto-run is starting it in this lane; recorded on the session's history entry. */
  dispatchLane?: OrchestrationLane
}

export function planLaunch(
  settings: Settings,
  task: Task,
  options: LaunchOptions = {}
): LaunchPlan {
  const { templateId, homeRoot, withPrompt = false, fresh = false, resume, forkFrom } = options
  if (options.prompt !== undefined && (templateId || options.promptPreface)) {
    throw new Error('A literal prompt replaces the template: pass no templateId or promptPreface.')
  }
  const provider = options.provider ? providerById(options.provider) : providerFor(settings, task)
  const checkout = checkoutFor(settings, task)
  const existing = task.agentSession?.provider === provider.id ? task.agentSession.id : undefined

  clearAgentStatus(settings, task.id)
  // The command is typed into the terminal's shell, so it is written in that shell's syntax.
  const { syntax } = resolveShell(settings.shell)

  const writePrompt = (): string => {
    const file = join(supportDir(settings, 'prompts'), `${task.id}.txt`)
    const rendered = options.prompt ?? renderPrompt(settings, task, templateId, checkout)
    const text = options.promptPreface ? `${options.promptPreface}\n\n${rendered}` : rendered
    writeFileSync(file, text, 'utf8')
    return syntax.fileContents(file)
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
  // A bare resume sends no template, so only the task's own model applies to it.
  const model = launchModel(
    task,
    settings.defaultProvider,
    provider.id,
    prompt ? resolveTemplateFor(settings, task, templateId) : undefined
  )

  return {
    provider: provider.id,
    command: provider.buildCommand({
      settings,
      taskId: task.id,
      sessionId,
      resume: resumable,
      forkFrom,
      cwd: checkout.cwd,
      model,
      prompt,
      extraDirs: checkout.extraDirs.map((dir) => dir.path),
      syntax
    }),
    cwd: checkout.cwd,
    sessionId,
    resumed: resumable,
    worktreePath: checkout.worktreePath,
    worktreeBase: checkout.worktreeBase,
    extraDirs: checkout.extraDirs,
    extraWorktrees: checkout.extraWorktrees,
    warning: checkout.warning
  }
}
