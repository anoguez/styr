import {
  TASK_STATUSES,
  WORKTREE_BRANCH_PREFIX,
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
    'Read these before you start:',
    ...files.map((file) => `- ${file}`)
  ].join('\n')
}

/**
 * How to move the task on the board. Rendered into every prompt rather than written into each
 * template, so a custom or older template cannot leave an agent with no way to report progress.
 */
function boardProtocol(task: Task): string {
  return [
    '## Board protocol',
    `This task is the file ${task.filePath}. The board reads it from there, so you move it by`,
    'editing that file frontmatter — there is no other step.',
    '',
    `- \`status:\` is one of: ${TASK_STATUSES.join(', ')}.`,
    '- Set `status: in_progress` as soon as you start working on it, writing its spec included.',
    '- Set `status: in_review` once the work is ready for me to look at.',
    '- Set `readiness: ready` once the task is specified well enough to be worked on.',
    '- Append progress notes as `- ` bullets under `## Activity` at the end of the file.',
    '- Change only those lines; leave the rest of the frontmatter as it is.',
    '',
    'This applies for the whole session. If you finish one phase and carry straight on into the',
    'next, keep the status in step with what you are actually doing.',
    ...(task.useWorktree
      ? [
          '',
          `You are in a dedicated git worktree at ${task.repoPath} on branch`,
          `\`${WORKTREE_BRANCH_PREFIX}${task.id}\`. Commit there. Do not switch branches and do not`,
          'touch the main checkout — another agent may be working in it.'
        ]
      : [])
  ].join('\n')
}

function placeholder(key: string): RegExp {
  return new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`)
}

export function buildPrompt(template: string, task: Task): string {
  const sections: Record<string, string> = {
    contextFiles: contextBlock(task.contextFiles),
    board: boardProtocol(task)
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
