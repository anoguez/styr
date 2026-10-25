import { NOTE_TOOL, noteFallback } from './activityNote.js'
import { ASK_LINE, REVIEW_LINE, REVIEW_LINE_PLAIN, SPLIT_LINE } from './boardTools.js'
import { isOpen } from './questions.js'
import {
  TASK_STATUSES,
  WORKTREE_BRANCH_PREFIX,
  worktreeKey,
  type PromptTemplate,
  type Settings,
  type Task
} from './types.js'

const FALLBACK: PromptTemplate = {
  id: 'fallback',
  name: 'Task brief',
  template: 'Work on task {{id}}: {{title}}\n\nSpec: {{filePath}}\n\n{{description}}'
}

function byId(settings: Settings, id: string | undefined): PromptTemplate | undefined {
  return id ? settings.promptTemplates.find((template) => template.id === id) : undefined
}

export type TemplateRouteInput = Pick<Task, 'status' | 'readiness'> & {
  promptTemplateId?: string
}

export function routedTemplateId(settings: Settings, task: TemplateRouteInput): string {
  return task.readiness === 'needs_spec'
    ? settings.promptRouting.needsSpec
    : settings.promptRouting.byStatus[task.status]
}

export function resolveTemplateFor(
  settings: Settings,
  task: TemplateRouteInput,
  override?: string
): PromptTemplate {
  return (
    byId(settings, override) ??
    byId(settings, task.promptTemplateId) ??
    byId(settings, routedTemplateId(settings, task)) ??
    byId(settings, settings.defaultPromptTemplateId) ??
    settings.promptTemplates[0] ??
    FALLBACK
  )
}

function contextBlock(files: string[]): string {
  if (files.length === 0) return ''
  return [
    '## Context files',
    'Read these before you start (a folder is context: look through what it holds):',
    ...files.map((file) => `- ${file}`)
  ].join('\n')
}

/** What the owner has been asked and has answered, so a fresh or resumed agent sees both. */
function questionsBlock(task: Task): string {
  if (task.questions.length === 0) return ''
  const indent = (text: string): string => text.trim().split('\n').join('\n   ')
  const lines = task.questions.map((question) =>
    isOpen(question)
      ? `- ${question.id} (open): ${indent(question.text)}`
      : `- ${question.id}: ${indent(question.text)}\n  Answer: ${indent(question.answer ?? '')}`
  )
  return [
    '## Questions for the owner',
    'Answered ones are decisions: follow them. Open ones are still waiting for the owner.',
    ...lines
  ].join('\n')
}

/**
 * How to move the task on the board. Rendered into every prompt rather than written into each
 * template, so a custom or older template cannot leave an agent with no way to report progress.
 */
function boardProtocol(
  task: Task,
  workspaceId: string | undefined,
  plainFolder: boolean,
  multiRepo: boolean,
  repos: string
): string {
  const finish = multiRepo
    ? [
        ...REVIEW_LINE,
        "- Set `status: done` only when every repository's branch has landed on its base (or I confirm",
        '  it). Work that is merely approved or committed on a branch stays `in_review`.',
        '- If you open a pull or merge request (any host), record its URL as `prUrl:` on the matching',
        "  `extraRepos` entry in the frontmatter; the primary repository's goes in the top-level `prUrl:`."
      ]
    : plainFolder
      ? [
          ...REVIEW_LINE_PLAIN,
          '- Do not set `status: done` yourself: this is not a code change, so there is nothing to land.',
          '  I mark it done when I am happy with the result.'
        ]
      : [
          ...REVIEW_LINE,
          '- Set `status: done` only when the work has landed on the base branch (or I confirm it). Work',
          '  that is merely approved or committed on a branch stays `in_review`.',
          '- If you open a pull or merge request (any host), record its URL as `prUrl:` in the frontmatter so the card links to it.'
        ]
  return [
    '## Board protocol',
    `This task is the file ${task.filePath}. The board reads it from there, so you move it by`,
    'editing that file frontmatter — there is no other step.',
    '',
    `- \`status:\` is one of: ${TASK_STATUSES.join(', ')}.`,
    '- Set `status: in_progress` as soon as you start working on it, writing its spec included.',
    ...finish,
    '- Set `readiness: ready` once the task is specified well enough to be worked on.',
    ...ASK_LINE,
    ...(task.readiness === 'needs_spec' ? SPLIT_LINE : []),
    '- If you finish writing a spec and stop, set `status: backlog` with `readiness: ready` so the task can be picked up.',
    `- Log progress notes with the ${NOTE_TOOL} (the task id and your note; it stamps the time and`,
    `  author). Only if you do not have that tool, ${noteFallback('the file')}.`,
    '- `## Activity` stays the last section of the file. Put a spec or any other text above it, never',
    '  after it, and never append to the end of the file.',
    '- Change only those lines; leave the rest of the frontmatter as it is.',
    '- If work must land first, record it with `blockedBy: [TASK-xxxx]` (ids from this board). Do not start a task whose blockers are not Done.',
    '',
    'This applies for the whole session. If you finish one phase and carry straight on into the',
    'next, keep the status in step with what you are actually doing.',
    ...(task.useWorktree
      ? [
          '',
          `You are in a dedicated git worktree at ${task.repoPath} on branch`,
          `\`${WORKTREE_BRANCH_PREFIX}${worktreeKey(workspaceId, task.id)}\`. Commit there. Do not switch branches and do not`,
          'touch the main checkout — another agent may be working in it.'
        ]
      : []),
    ...(repos ? ['', repos] : [])
  ].join('\n')
}

function placeholder(key: string): RegExp {
  return new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`)
}

/** One of a multi-repo task's other repositories, as plain data: the prompt reads no git. */
export interface PromptRepo {
  name: string
  /** Where the agent finds it: its worktree, or the plain repository when none could be made. */
  path: string
  baseBranch: string
  branch: string
}

export interface PromptOptions {
  /** The task runs in a folder that is not a git repository, so there is no branch to land. */
  plainFolder?: boolean
  /** The repositories beside the primary one; empty or unset for a single-repo task. */
  extraRepos?: readonly PromptRepo[]
  /** Display name of the primary repository, the one the agent starts in. */
  primaryName?: string
}

/** The multi-repo brief (`{{repos}}`): empty for a single-repo task. */
export function reposBlock(
  primaryName: string,
  extraRepos: readonly PromptRepo[] = [],
  inWorktree = true
): string {
  if (extraRepos.length === 0) return ''
  const [first] = extraRepos
  const branch = first?.branch ?? ''
  return [
    '## Repositories',
    `This task spans several repositories. You started in \`${primaryName}\` (the primary). Each repo below is a separate git ${inWorktree ? 'worktree' : 'checkout'} on branch \`${branch}\`:`,
    ...extraRepos.map((repo) => `- ${repo.name} at ${repo.path} (base ${repo.baseBranch})`),
    "Commit in every repo you change, `cd` into it first, and never edit another repo's main checkout.",
    "The task is Done only when every repository's branch has landed on its base."
  ].join('\n')
}

export function buildPrompt(
  template: string,
  task: Task,
  workspaceId?: string,
  options: PromptOptions = {}
): string {
  const repos = reposBlock(options.primaryName ?? '', options.extraRepos)
  const placedRepos = placeholder('repos').test(template)
  const sections: Record<string, string> = {
    contextFiles: contextBlock(task.contextFiles),
    issue: task.externalRef?.url
      ? `This task is linked to an external issue: ${task.externalRef.url}`
      : '',
    questions: questionsBlock(task),
    board: boardProtocol(
      task,
      workspaceId,
      options.plainFolder ?? false,
      repos.length > 0,
      placedRepos ? '' : repos
    )
  }
  const values: Record<string, string> = {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    readiness: task.readiness,
    project: task.project ?? '',
    tags: task.tags.join(', '),
    filePath: task.filePath,
    repoPath: task.repoPath ?? '',
    repos,
    ...sections
  }

  const rendered = template.replace(
    /\{\{\s*(\w+)\s*\}\}/g,
    (match, key: string) => values[key] ?? match
  )

  const missing = Object.entries(sections)
    .filter(([key, content]) => content.length > 0 && !placeholder(key).test(template))
    .map(([, content]) => content)

  const withSections =
    missing.length > 0 ? `${rendered.trimEnd()}\n\n${missing.join('\n\n')}\n` : rendered

  const hadEmptySection = Object.values(sections).some((content) => content.length === 0)
  return hadEmptySection ? withSections.replace(/\n{3,}/g, '\n\n') : withSections
}
