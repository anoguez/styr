import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { settingsSchema } from './taskSchema.js'
import { DEFAULT_SHORTCUTS, DEFAULT_THEME, type PromptTemplate, type Settings } from './types.js'

const CONFIG_DIR = process.env.STYR_HOME ?? join(homedir(), '.styr')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

const SPEC_TEMPLATE = [
  'Task {{id}} — "{{title}}" — is marked as needing a spec. Your job is to specify it, not to build it.',
  '',
  'Task file: {{filePath}}',
  '',
  '## What exists so far',
  '{{description}}',
  '',
  '{{contextFiles}}',
  '',
  '## How to spec it',
  '- Prefer the wayfinder skill to turn this into a proper spec.',
  '- Otherwise use the grilling skill on me until scope, acceptance criteria and edge cases are pinned down.',
  '- Decide whatever you can decide yourself. Only come back to me for calls that are genuinely mine to make.',
  '',
  'Writing the spec is work like any other, so keep `status: in_progress` while you are on it.',
  '',
  '## When you are done specifying',
  '- Write the finished spec into the body of {{filePath}}, below the frontmatter.',
  '- Set `readiness: ready` so the task can be picked up.',
  '- Leave the status at in_progress if you carry straight on into building it.'
].join('\n')

const IMPLEMENT_TEMPLATE = [
  'You are picking up work task {{id}}: {{title}}.',
  '',
  'The full task spec lives at {{filePath}} — read it first.',
  '',
  '## Task description',
  '{{description}}',
  '',
  '{{contextFiles}}',
  '',
  '## Working agreement',
  '- Read the spec first and work to its acceptance criteria.',
  '- Keep the task status in step with what you are doing, per the board protocol below.'
].join('\n')

const REVIEW_TEMPLATE = [
  'Review the work done for task {{id}}: {{title}}.',
  '',
  'Spec: {{filePath}}',
  'Working directory: {{repoPath}}',
  '',
  '## What was asked for',
  '{{description}}',
  '',
  '{{contextFiles}}',
  '',
  '## How to review',
  '- Review the open PR if there is one, otherwise diff this branch against its base.',
  '- Check every acceptance criterion in the spec against what was actually built.',
  '- Report correctness bugs first, then reuse and simplification issues.',
  '',
  '## When you are done',
  '- Append your verdict as a bullet under `## Activity` at the end of {{filePath}}.',
  '- If it passes, set `status: done`.',
  '- If it does not, set `status: in_progress` and list the required fixes in that note.'
].join('\n')

const FOLLOWUP_TEMPLATE = [
  'Task {{id}} — "{{title}}" — is already done. Check nothing was left behind.',
  '',
  'Spec: {{filePath}}',
  'Working directory: {{repoPath}}',
  '',
  '## What was delivered',
  '{{description}}',
  '',
  '{{contextFiles}}',
  '',
  '## What to do',
  '- Confirm the work actually landed and still holds up.',
  '- Capture anything deferred as new tasks — create_task on the styr MCP server, or a',
  '  new markdown file alongside {{filePath}} with a `title:` and `status: backlog` in frontmatter.',
  '- Do not reopen this task unless something is genuinely broken.'
].join('\n')

function defaults(): Settings {
  return {
    workspaceDir: join(homedir(), 'Styr'),
    defaultRepoPath: '',
    shell: process.env.SHELL ?? '/bin/zsh',
    claudeCommand: 'claude',
    defaultPromptTemplateId: 'implement',
    promptTemplates: [
      { id: 'spec', name: 'Spec the task', template: SPEC_TEMPLATE },
      { id: 'implement', name: 'Implement the task', template: IMPLEMENT_TEMPLATE },
      { id: 'code-review', name: 'Review the work', template: REVIEW_TEMPLATE },
      { id: 'followup', name: 'Follow up', template: FOLLOWUP_TEMPLATE }
    ],
    orchestration: { spec: 1, implement: 2, review: 1 },
    theme: DEFAULT_THEME,
    shortcuts: DEFAULT_SHORTCUTS,
    promptRouting: {
      needsSpec: 'spec',
      byStatus: {
        backlog: 'implement',
        in_progress: 'implement',
        in_review: 'code-review',
        done: 'followup'
      }
    }
  }
}

export function configDir(): string {
  return CONFIG_DIR
}

/**
 * A config written before prompt routing existed keeps its own promptTemplates, which shadow the
 * shipped ones the routing table points at. Without this the routing silently falls back to a
 * single template for every column. Adds only the shipped templates the user does not already
 * have — their own definitions always win on an id collision.
 */
function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.promptRouting) return raw
  const base = defaults()
  const existing = Array.isArray(raw.promptTemplates)
    ? (raw.promptTemplates as PromptTemplate[])
    : base.promptTemplates
  const ids = new Set(existing.map((template) => template.id))
  return {
    ...raw,
    promptTemplates: [
      ...existing,
      ...base.promptTemplates.filter((template) => !ids.has(template.id))
    ],
    promptRouting: base.promptRouting
  }
}

export function loadSettings(): Settings {
  if (!existsSync(CONFIG_FILE)) return defaults()
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Record<string, unknown>
    const parsed = settingsSchema.safeParse({ ...defaults(), ...migrate(raw) })
    return parsed.success ? parsed.data : defaults()
  } catch {
    return defaults()
  }
}

export function saveSettings(settings: Settings): Settings {
  const parsed = settingsSchema.parse(settings)
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  return parsed
}

export function tasksDir(settings: Settings = loadSettings()): string {
  const dir = join(settings.workspaceDir, 'tasks')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function indexDbPath(settings: Settings = loadSettings()): string {
  const dir = join(settings.workspaceDir, '.styr')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'index.db')
}
