import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_SHORTCUTS,
  DEFAULT_THEME,
  DEFAULT_WORKSPACE_ID,
  workspaceSettingsFor,
  type PromptTemplate,
  type Settings,
  type WorkspaceSettings
} from './types.js'

const CONFIG_DIR = process.env.STYR_HOME ?? join(homedir(), '.styr')

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
  '- If it does not pass, set `status: in_progress` and list the required fixes in that note.',
  '- If it passes, `done` means the work has landed, not that it was approved. Find the base',
  '  branch (the remote default branch, else `main`/`master`, else the branch the main checkout',
  '  is on) and count the commits on this branch that are not on it, e.g.',
  '  `git rev-list --count <base>..HEAD`.',
  '  - Nothing left to land (or the user confirms it has landed): set `status: done`.',
  '  - Otherwise leave `status: in_review`. In your note record the branch, the base and the',
  '    commit count, and say what is left to land.',
  '  - Offer the landing step that fits: open a PR if `git remote -v` shows a GitHub remote and',
  '    `gh` is installed, otherwise tell me to merge or push the branch by hand. Never assume a',
  '    host, and do not merge or push without my say-so.',
  '- Styr moves the task to done by itself once it sees the work on the base branch, then removes',
  '  the task worktree and branches. Do not delete them yourself.'
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

/** Every setting as shipped, before any file is read. */
export function shippedSettings(): Settings {
  return {
    storageDir: join(homedir(), 'Styr'),
    activeWorkspaceId: DEFAULT_WORKSPACE_ID,
    defaultRepoPath: '',
    shell: process.env.SHELL ?? '/bin/zsh',
    claudeCommand: 'claude',
    claudeApprovalMode: 'user',
    codexCommand: 'codex',
    codexApprovalReviewer: 'user',
    enabledProviders: ['claude'],
    defaultProvider: 'claude',
    providerRouting: { spec: 'claude', implement: 'claude', review: 'claude' },
    defaultPromptTemplateId: 'implement',
    promptTemplates: [
      { id: 'spec', name: 'Spec the task', template: SPEC_TEMPLATE },
      { id: 'implement', name: 'Implement the task', template: IMPLEMENT_TEMPLATE },
      { id: 'code-review', name: 'Review the work', template: REVIEW_TEMPLATE },
      { id: 'followup', name: 'Follow up', template: FOLLOWUP_TEMPLATE }
    ],
    orchestration: { spec: 1, implement: 2, review: 1 },
    updates: { checkAutomatically: true },
    taskDefaults: { orchestrate: true, useWorktree: false },
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

/** A workspace's settings as shipped, for seeding one that has nothing else to start from. */
export function shippedWorkspaceSettings(): WorkspaceSettings {
  return workspaceSettingsFor(shippedSettings())
}

/** `workspaceDir` became `storageDir` once "workspace" came to mean an isolated board. */
export function renameStorageDir(raw: Record<string, unknown>): Record<string, unknown> {
  if (typeof raw.workspaceDir !== 'string') return raw
  const { workspaceDir, ...rest } = raw
  return rest.storageDir === undefined ? { ...rest, storageDir: workspaceDir } : rest
}

/**
 * A config written before prompt routing existed keeps its own promptTemplates, which shadow the
 * shipped ones the routing table points at. Without this the routing silently falls back to a
 * single template for every column. Adds only the shipped templates the user does not already
 * have — their own definitions always win on an id collision.
 */
export function migrateConfig(input: Record<string, unknown>): Record<string, unknown> {
  const raw = renameStorageDir(input)
  if (raw.promptRouting) return raw
  const base = shippedSettings()
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

let workspaceOverride: string | undefined

/**
 * Pins the process to one workspace regardless of the saved preference. The MCP server is
 * registered once for every agent, so it learns its workspace from the agent's environment —
 * otherwise switching the board would redirect a running agent's writes. The main process never
 * calls this: it follows the preference.
 */
export function pinWorkspace(id: string | undefined): void {
  workspaceOverride = id || undefined
}

export function pinnedWorkspaceId(): string | undefined {
  return workspaceOverride
}

const WORKSPACE_ID = /^[a-z0-9][a-z0-9-]*$/

export function isWorkspaceId(id: string): boolean {
  return id === DEFAULT_WORKSPACE_ID || WORKSPACE_ID.test(id)
}

/** Where a workspace keeps its `tasks/` and `.styr/`. Default is the storage root itself. */
export function workspaceDir(settings: Settings, id: string = settings.activeWorkspaceId): string {
  return id === DEFAULT_WORKSPACE_ID
    ? settings.storageDir
    : join(settings.storageDir, 'workspaces', id)
}

/**
 * A copy of the settings that resolves every path inside `id`, for work in a background workspace.
 * Paths only: the copy still carries the caller's workspace settings. Anything that acts on that
 * workspace's behaviour (templates, providers, routing) must use `loadSettings(id)` instead.
 */
export function pathsInWorkspace(settings: Settings, id: string): Settings {
  return { ...settings, activeWorkspaceId: id }
}
