import { z } from 'zod'
import { AGENT_STATES } from './agentState.js'
import {
  ANSI_COLOURS,
  DEFAULT_DONE_CAP,
  DEFAULT_SHORTCUTS,
  DEFAULT_TERMINAL_PALETTE,
  MAX_TASK_PRESETS,
  ORCHESTRATION_LANES,
  REST_METHODS,
  SHORTCUT_COMMANDS,
  TASK_PRIORITIES,
  TASK_READINESS,
  REVIEW_LIMITS,
  TASK_STATUSES,
  type GlobalSettingKey
} from './types.js'

export { REVIEW_LIMITS }

export const TASK_ID_RE = /^TASK-\d+$/

export const taskStatusSchema = z.enum(TASK_STATUSES)
export const taskPrioritySchema = z.enum(TASK_PRIORITIES)
export const taskReadinessSchema = z.enum(TASK_READINESS)

export const externalRefSchema = z.object({
  provider: z.string(),
  id: z.string(),
  url: z.string().optional(),
  sourceId: z.string().optional(),
  target: z.string().optional(),
  remoteUpdatedAt: z.string().optional(),
  syncedHash: z.string().optional(),
  syncedTitleHash: z.string().optional(),
  syncedBodyHash: z.string().optional()
})

/** A REST source's request and field mapping; also what the pane's test request sends. */
export const restSourceSettingsSchema = z.object({
  request: z.object({
    method: z.enum(REST_METHODS).default('GET'),
    url: z.string().default(''),
    headers: z
      .array(
        z.object({
          name: z.string(),
          value: z.string(),
          enabled: z.boolean().default(true)
        })
      )
      .default([]),
    body: z.string().default('')
  }),
  mapping: z.object({
    items: z.string().default(''),
    id: z.string().default('id'),
    title: z.string().default('title'),
    body: z.string().default(''),
    url: z.string().default(''),
    state: z.string().default(''),
    closedValues: z.array(z.string()).default([]),
    updatedAt: z.string().default(''),
    labels: z.string().default('')
  })
})

export const sourceConfigSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  name: z.string().optional(),
  access: z.enum(['read', 'read_write']).default('read'),
  enabled: z.boolean().default(true),
  pollMinutes: z.number().int().min(0).max(1440).default(5),
  labels: z.array(z.string()).default([]),
  includeClosed: z.boolean().default(false),
  mirrorStatus: z.boolean().default(false),
  commentOnReview: z.boolean().default(false),
  rest: restSourceSettingsSchema.optional()
})

export const taskSessionRefSchema = z.object({
  id: z.string(),
  provider: z.enum(['claude', 'codex']).default('claude'),
  startedAt: z.string(),
  label: z.string(),
  templateId: z.string().optional(),
  dispatch: z.enum(ORCHESTRATION_LANES).optional(),
  sentBack: z.literal(true).optional()
})

export const activityEntrySchema = z.object({
  at: z.string(),
  author: z.string(),
  message: z.string()
})

export const taskFrontmatterSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: taskStatusSchema.default('backlog'),
  priority: taskPrioritySchema.default('medium'),
  readiness: taskReadinessSchema.default('ready'),
  project: z.string().optional(),
  tags: z.array(z.string()).default([]),
  repoPath: z.string().optional(),
  orchestrate: z.boolean().default(true),
  useWorktree: z.boolean().default(false),
  baseBranch: z.string().optional(),
  worktreePath: z.string().optional(),
  blockedBy: z.array(z.string()).default([]),
  contextFiles: z.array(z.string()).default([]),
  promptTemplateId: z.string().optional(),
  provider: z.enum(['claude', 'codex']).optional(),
  model: z.string().optional(),
  agentSession: z.object({ provider: z.enum(['claude', 'codex']), id: z.string() }).optional(),
  sessions: z.array(taskSessionRefSchema).default([]),
  externalRef: externalRefSchema.optional(),
  prUrl: z.string().optional(),
  order: z.number().default(0),
  doneAt: z.string().optional(),
  archivedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
})

export const jsonTaskSchema = taskFrontmatterSchema.extend({
  description: z.string().default(''),
  activity: z.array(activityEntrySchema).default([])
})

export const taskDraftSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  readiness: taskReadinessSchema.optional(),
  project: z.string().optional(),
  tags: z.array(z.string()).optional(),
  repoPath: z.string().optional(),
  orchestrate: z.boolean().optional(),
  useWorktree: z.boolean().optional(),
  baseBranch: z.string().optional(),
  worktreePath: z.string().optional(),
  blockedBy: z.array(z.string().regex(TASK_ID_RE, 'Use a task id like TASK-0012')).optional(),
  contextFiles: z.array(z.string()).optional(),
  promptTemplateId: z.string().optional(),
  provider: z.enum(['claude', 'codex']).optional(),
  model: z.string().optional(),
  sessions: z.array(taskSessionRefSchema).optional(),
  externalRef: externalRefSchema.optional(),
  prUrl: z.string().optional(),
  order: z.number().optional()
})

export const taskPatchSchema = taskDraftSchema.partial()

export const taskFilterSchema = z.object({
  status: z.union([taskStatusSchema, z.array(taskStatusSchema)]).optional(),
  readiness: taskReadinessSchema.optional(),
  project: z.string().optional(),
  tag: z.string().optional(),
  query: z.string().optional()
})

export const promptTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  template: z.string(),
  model: z.object({ provider: z.enum(['claude', 'codex']), name: z.string().min(1) }).optional()
})

export const promptRoutingSchema = z.object({
  needsSpec: z.string(),
  byStatus: z.record(taskStatusSchema, z.string())
})

export const orchestrationSchema = z.object({
  spec: z.number().int().min(0).max(20),
  implement: z.number().int().min(0).max(20),
  review: z.number().int().min(0).max(20)
})

export const providerRoutingSchema = z.object({
  spec: z.enum(['claude', 'codex']).default('claude'),
  implement: z.enum(['claude', 'codex']).default('claude'),
  review: z.enum(['claude', 'codex']).default('claude')
})

const hexColour = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a 6-digit hex colour')

export const themeSchema = z.object({
  base: hexColour,
  gradient: z.boolean(),
  gradientStrength: z.number().min(0).max(1),
  gradientAngle: z.number().int().min(0).max(359),
  accent: hexColour,
  columns: z.record(taskStatusSchema, hexColour),
  uiFont: z.string().min(1),
  terminalFont: z.string().min(1),
  terminalFontSize: z.number().int().min(9).max(24),
  terminalPalette: z
    .partialRecord(z.enum(ANSI_COLOURS), hexColour)
    .default({})
    .transform((value) => ({ ...DEFAULT_TERMINAL_PALETTE, ...value }))
})

export const shortcutsSchema = z
  .partialRecord(z.enum([...SHORTCUT_COMMANDS, 'focusSearch'] as const), z.array(z.string()))
  .default({})
  .transform(({ focusSearch, ...value }) => ({
    ...DEFAULT_SHORTCUTS,
    ...value,
    quickOpen: [
      ...new Set([...(value.quickOpen ?? DEFAULT_SHORTCUTS.quickOpen), ...(focusSearch ?? [])])
    ]
  }))

export const taskPresetSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  title: z.string().default(''),
  description: z.string().default(''),
  tags: z.array(z.string()).default([]),
  priority: taskPrioritySchema.default('medium'),
  readiness: taskReadinessSchema.default('ready'),
  useWorktree: z.boolean().default(false),
  orchestrate: z.boolean().default(true),
  provider: z.enum(['claude', 'codex']).optional(),
  promptTemplateId: z.string().optional(),
  baseBranch: z.string().optional()
})

export const settingsSchema = z.object({
  storageDir: z.string(),
  activeWorkspaceId: z.string().default('default'),
  defaultRepoPath: z.string().default(''),
  shell: z.string().default(''),
  openFilesWith: z.string().default(''),
  worktreeLocation: z.enum(['beside', 'inside']).default('beside'),
  claudeCommand: z.string().default('claude'),
  claudeApprovalMode: z.enum(['user', 'auto']).default('user'),
  codexCommand: z.string().default('codex'),
  codexApprovalReviewer: z.enum(['user', 'auto_review']).default('user'),
  enabledProviders: z
    .array(z.enum(['claude', 'codex']))
    .min(1)
    .default(['claude']),
  defaultProvider: z.enum(['claude', 'codex']).default('claude'),
  agentModels: z
    .object({
      claude: z.array(z.string()).default([]),
      codex: z.array(z.string()).default([])
    })
    .default({ claude: [], codex: [] }),
  providerRouting: providerRoutingSchema.default({
    spec: 'claude',
    implement: 'claude',
    review: 'claude'
  }),
  defaultPromptTemplateId: z.string().default('default'),
  promptTemplates: z.array(promptTemplateSchema).default([]),
  promptRouting: promptRoutingSchema,
  orchestration: orchestrationSchema,
  autoDispatch: z.boolean().default(false),
  autoDispatchSince: z.string().optional(),
  theme: themeSchema,
  shortcuts: shortcutsSchema,
  updates: z
    .object({ checkAutomatically: z.boolean().default(true) })
    .default({ checkAutomatically: true }),
  restoreTabs: z.enum(['ask', 'always', 'never']).default('ask'),
  experimental: z
    .object({
      externalSources: z.boolean().default(false),
      nativeTerminal: z.boolean().default(false),
      worklog: z.boolean().default(false),
      remoteWorkspaces: z.boolean().default(false)
    })
    .default({
      externalSources: false,
      nativeTerminal: false,
      worklog: false,
      remoteWorkspaces: false
    }),
  taskDefaults: z
    .object({ orchestrate: z.boolean().default(true), useWorktree: z.boolean().default(false) })
    .default({ orchestrate: true, useWorktree: false }),
  // One bad entry is dropped rather than costing the whole list (the file may be hand-edited).
  taskPresets: z
    .preprocess(
      (value) =>
        Array.isArray(value)
          ? value
              .filter((entry) => taskPresetSchema.safeParse(entry).success)
              .slice(0, MAX_TASK_PRESETS)
          : value,
      z.array(taskPresetSchema)
    )
    .default([]),
  doneCap: z
    .object({
      maxCount: z.number().int().min(0).max(1000).default(DEFAULT_DONE_CAP.maxCount),
      maxAgeDays: z.number().int().min(0).max(365).default(DEFAULT_DONE_CAP.maxAgeDays)
    })
    .default(DEFAULT_DONE_CAP),
  autoArchiveAsk: z.boolean().default(true),
  sources: z.array(sourceConfigSchema).default([])
})

const GLOBAL_KEY_MASK = {
  storageDir: true,
  activeWorkspaceId: true,
  updates: true,
  restoreTabs: true,
  shortcuts: true,
  experimental: true
} as const satisfies Record<GlobalSettingKey, true>

export const globalSettingsSchema = settingsSchema.pick(GLOBAL_KEY_MASK)
export const workspaceSettingsSchema = settingsSchema.omit(GLOBAL_KEY_MASK)

export const workspaceIdSchema = z.string().min(1)

export const settingsChangeSchema = z.object({
  workspaceId: workspaceIdSchema,
  workspace: workspaceSettingsSchema,
  global: globalSettingsSchema
})

// ── What a remote server sends back ──────────────────────────────────────────────────────────
//
// `styr serve` checks what clients send it with the schemas above. The client checks what a
// server sends back with these (`src/host/remote/validation.ts`), since a compromised host must
// not be able to confuse the main process, crash the renderer or exhaust the laptop's memory
// (`docs/architecture/remote.md`, Trust boundary). They are bounded copies of the shapes in
// `types/`, kept apart from the schemas the local task files are read with, which stay unbounded.

/** The bounds on a server's answers: generous for a real board, finite for a hostile one. */
export const REMOTE_LIMITS = {
  /** Nesting of any value. */
  depth: 24,
  /** Any string anywhere, unless a field says less. */
  string: 1024 * 1024,
  /** Any array or object's entries, unless a field says less. */
  entries: 20_000,
  /** Ids, names, labels, timestamps. */
  short: 1024,
  /** Paths and one-line texts. */
  line: 8192,
  /** A task's body. */
  taskBody: 1024 * 1024,
  /** A task's activity bullets. */
  activity: 10_000,
  /** An agent's last message, a note. */
  message: 64 * 1024,
  /** Terminal sessions a host may list. */
  sessions: 500,
  /** A terminal backlog or chunk, in UTF-16 units: `TerminalTranscript`'s backlog bound. */
  terminalOutput: 200_000,
  /** A notification's title and body. */
  notifyTitle: 200,
  notifyBody: 2000
} as const

/** Keys that would reach an object's prototype when copied. A server never sends one. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Why `value` is out of bounds (`REMOTE_LIMITS`: depth, string length, entries, forbidden keys),
 * or undefined. Checked on every server answer before its schema, so no schema walks a value
 * deeper or wider than these.
 */
export function remoteBoundsProblem(value: unknown, depth = 0): string | undefined {
  if (typeof value === 'string') {
    return value.length > REMOTE_LIMITS.string ? 'a string is too long' : undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  if (depth >= REMOTE_LIMITS.depth) return 'nested too deeply'
  if (Array.isArray(value)) {
    if (value.length > REMOTE_LIMITS.entries) return 'a list is too long'
    for (const item of value) {
      const problem = remoteBoundsProblem(item, depth + 1)
      if (problem) return problem
    }
    return undefined
  }
  const keys = Object.keys(value)
  if (keys.length > REMOTE_LIMITS.entries) return 'an object has too many keys'
  for (const key of keys) {
    if (FORBIDDEN_KEYS.has(key)) return `a forbidden key (${key})`
    if (key.length > REMOTE_LIMITS.short) return 'a key is too long'
    const problem = remoteBoundsProblem((value as Record<string, unknown>)[key], depth + 1)
    if (problem) return problem
  }
  return undefined
}

/** C0 and C1 control characters (tab, newline and carriage return included). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/

const short = z.string().max(REMOTE_LIMITS.short)
const line = z.string().max(REMOTE_LIMITS.line)
const message = z.string().max(REMOTE_LIMITS.message)
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const finite = z.number().finite()
const provider = z.enum(['claude', 'codex'])
/** A session id as `terminalsService` makes them (`nanoid`), used to route calls. */
export const remoteSessionIdSchema = z.string().regex(/^[\w.:-]{1,128}$/, 'Not a session id')
/** A path on the host: one line, no control characters. Only ever shown or put in a link. */
export const remotePathSchema = line.refine((value) => !CONTROL_CHARS.test(value), {
  message: 'A path may not hold control characters'
})
const list = <T extends z.ZodType>(item: T, max: number = REMOTE_LIMITS.entries) =>
  z.array(item).max(max)

export const remoteTaskSchema = taskFrontmatterSchema.extend({
  id: short,
  title: line,
  project: line.optional(),
  tags: list(short).default([]),
  repoPath: remotePathSchema.optional(),
  baseBranch: line.optional(),
  worktreePath: remotePathSchema.optional(),
  blockedBy: list(short).default([]),
  contextFiles: list(remotePathSchema).default([]),
  sessions: list(taskSessionRefSchema).default([]),
  prUrl: line.optional(),
  description: z.string().max(REMOTE_LIMITS.taskBody).default(''),
  activity: list(z.object({ at: short, author: short, message }), REMOTE_LIMITS.activity).default(
    []
  ),
  filePath: remotePathSchema,
  format: z.enum(['markdown', 'json'])
})

const subagentStatusSchema = z.object({
  id: short,
  label: line,
  state: z.enum(['running', 'done']),
  startedAt: short,
  endedAt: short.optional(),
  lastMessage: message.optional()
})

export const remoteAgentStatusSchema = z.object({
  taskId: short,
  state: z.enum(AGENT_STATES),
  at: short,
  sessionId: short.optional(),
  lastMessage: message.optional(),
  branch: line.optional(),
  subagents: list(subagentStatusSchema, 1000).optional(),
  workspaceId: short.optional(),
  workspaceName: line.optional()
})

export const remoteTerminalMarkSchema = z.object({
  offset: count,
  kind: z.enum(['start', 'end', 'prompt']),
  id: short,
  command: line.optional(),
  exitCode: z.number().int().optional(),
  cwd: remotePathSchema.optional(),
  at: finite
})

/** A backlog or one chunk; every mark falls inside its `data`. */
export const remoteTerminalOutputSchema = z
  .object({
    data: z.string().max(REMOTE_LIMITS.terminalOutput),
    sequence: count,
    marks: list(remoteTerminalMarkSchema)
  })
  .refine((output) => output.marks.every((mark) => mark.offset <= output.data.length), {
    message: 'A mark falls outside its output'
  })

export const remoteTerminalDataSchema = z
  .object({
    id: remoteSessionIdSchema,
    data: z.string().max(REMOTE_LIMITS.terminalOutput),
    sequence: count,
    marks: list(remoteTerminalMarkSchema)
  })
  .refine((output) => output.marks.every((mark) => mark.offset <= output.data.length), {
    message: 'A mark falls outside its output'
  })

export const remoteTerminalSessionSchema = z.object({
  id: remoteSessionIdSchema,
  title: line,
  cwd: remotePathSchema,
  dialect: z.enum(['posix', 'powershell', 'cmd']).optional(),
  taskId: short.optional(),
  workspaceId: short.optional(),
  provider: provider.optional(),
  replay: z.boolean().optional()
})

const terminalCommandSchema = z.object({
  id: short,
  command: line,
  cwd: remotePathSchema,
  startedAt: finite,
  endedAt: finite.optional(),
  exitCode: z.number().int().optional(),
  output: z.string().max(REMOTE_LIMITS.message).optional()
})

export const remoteRuntimeStateSchema = z.object({
  sessionId: remoteSessionIdSchema,
  cwd: remotePathSchema,
  promptReady: z.boolean(),
  runningCommand: terminalCommandSchema
    .pick({ id: true, command: true, cwd: true, startedAt: true })
    .optional(),
  lastCommand: terminalCommandSchema.optional(),
  lastExitCode: z.number().int().optional(),
  terminated: z.boolean().optional()
})

export const remoteWorkspaceOverviewSchema = z.object({
  activeId: short,
  workspaces: list(z.object({ id: short, name: line, taskCount: count, liveSessions: count }), 1000)
})

export const remoteWorkspacesActivitySchema = z.object({
  activeId: short,
  byWorkspace: z.record(
    short,
    z.object({
      counts: z.record(z.enum(AGENT_STATES), count),
      review: count,
      top: z.enum(AGENT_STATES).exclude(['exited']).optional()
    })
  )
})

export const remoteBoardSummarySchema = z.record(short, z.record(short, count))

export const remoteTraySchema = z.object({
  statuses: list(remoteAgentStatusSchema).default([]),
  titles: z.record(short, line).default({})
})

/** A notification the server raises: one line each, no control characters (they are stripped). */
export const remoteNotifySchema = z.object({
  title: z.string().max(REMOTE_LIMITS.line).optional(),
  body: z.string().max(REMOTE_LIMITS.message).optional()
})

export const remoteServerHelloSchema = z.object({
  protocol: z.number().int(),
  version: short,
  pid: z.number().int().min(0),
  startedAt: short,
  storageDir: remotePathSchema,
  platform: short
})

export const remoteAutoStateSchema = z.object({
  on: z.boolean(),
  paused: z.enum(['limit', 'failures']).optional()
})

export const remoteSourceSyncStateSchema = z.object({
  syncing: z.boolean(),
  lastAt: short.optional(),
  error: message.optional(),
  created: count,
  updated: count
})

const diffFileSchema = z.object({
  path: remotePathSchema,
  oldPath: remotePathSchema.optional(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed']),
  additions: count,
  deletions: count,
  binary: z.boolean(),
  uncommitted: z.boolean(),
  origin: z.enum(['committed', 'uncommitted', 'untracked', 'both'])
})

export const remoteDiffResultSchema = z.union([
  z.object({
    kind: z.enum(['changes', 'empty', 'landed', 'repo', 'gone']),
    baseName: line,
    mergeBase: short.optional(),
    branch: line.optional(),
    branchKept: z.boolean().optional(),
    note: message.optional(),
    files: list(diffFileSchema),
    omitted: count,
    totalFiles: count,
    totalAdditions: count,
    totalDeletions: count
  }),
  z.object({ error: message })
])

export const remotePatchResultSchema = z.union([
  z.object({ patch: z.string() }),
  z.object({ placeholder: z.enum(['binary', 'too-large']), bytes: count.optional() }),
  z.object({ placeholder: z.literal('submodule'), from: short.optional(), to: short.optional() }),
  z.object({ placeholder: z.literal('unchanged') }),
  z.object({ error: message })
])

const capacitySchema = z.object({ spec: count, implement: count, review: count })

export const remoteOrchestrationSummarySchema = z.object({
  dispatch: list(
    z.object({
      taskId: short,
      title: line,
      lane: z.enum(['spec', 'implement', 'review']),
      provider
    })
  ),
  occupied: capacitySchema,
  capacity: capacitySchema,
  eligible: capacitySchema,
  optedOut: count,
  blocked: count,
  missingWorkingDir: count,
  idleSessions: count,
  reworkHeld: list(short)
})

const usageWindowSchema = z.object({ kind: short, percentUsed: finite, resetsAt: short.optional() })
export const remoteProviderUsageSchema = z.object({
  windows: list(usageWindowSchema, 100),
  at: short
})
export const remoteContextUsageSchema = z.object({
  percent: finite,
  tokens: finite.optional(),
  window: finite.optional()
})

const approvalOptionSchema = z.object({
  id: short,
  label: line,
  kind: z.enum(['allow', 'allow-always', 'deny'])
})

export const remoteConversationSchema = z.object({
  at: short,
  working: z.boolean(),
  messages: list(
    z.object({
      role: z.enum(['user', 'assistant']),
      text: z.string(),
      toolUses: list(
        z.object({
          id: short,
          tool: short,
          input: z.record(z.string(), z.unknown()),
          text: z.string().optional(),
          isError: z.boolean().optional()
        })
      )
    })
  ),
  commands: list(z.object({ name: short, description: line })).optional(),
  promptInbox: z.boolean().optional(),
  streaming: z.string().optional(),
  approval: z
    .object({
      id: short,
      prompt: message,
      tool: short.optional(),
      input: z.record(z.string(), z.unknown()).optional(),
      options: list(approvalOptionSchema, 20).optional()
    })
    .optional()
})

export const remoteWorklogSchema = z.object({
  tasks: list(
    z.object({
      taskId: short,
      title: line,
      project: line.optional(),
      sessions: list(z.object({ day: short, sessionId: short, tokens: finite }))
    })
  )
})

export const remoteCliStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('missing') }),
  z.object({ state: z.literal('outdated'), version: short, minimum: short }),
  z.object({ state: z.literal('unauthenticated'), version: short }),
  z.object({ state: z.literal('ready'), version: short, account: short.optional() })
])

export const remoteAgentCliReportSchema = z.object({
  provider,
  command: line,
  shell: line,
  shellLabel: line,
  platform: short,
  status: z.discriminatedUnion('state', [
    z.object({ state: z.literal('ready'), version: short }),
    z.object({ state: z.literal('missing') }),
    z.object({ state: z.literal('failed'), detail: message }),
    z.object({ state: z.literal('unsupported_shell') })
  ]),
  problem: message,
  installCommand: line.optional()
})

const remoteItemSchema = z.object({
  id: short,
  url: line,
  title: line,
  body: z.string(),
  state: z.enum(['open', 'closed']),
  labels: list(short),
  updatedAt: short,
  blockedBy: list(z.object({ target: line, id: short })).optional()
})

export const remoteRestTestSchema = z.object({
  error: message.optional(),
  status: z.number().int().optional(),
  statusText: line.optional(),
  durationMs: finite,
  headers: list(z.tuple([line, line]), 1000),
  body: z.string(),
  truncated: z.boolean(),
  items: list(remoteItemSchema).optional(),
  total: count.optional(),
  mappingError: message.optional()
})

export const remoteSyncPreviewSchema = z.object({
  entries: list(
    z.object({
      itemId: short,
      kind: z.enum(['create', 'update']),
      title: line,
      taskId: short.optional(),
      changes: list(line, 100),
      url: line.optional()
    })
  ),
  error: message.optional()
})

export const remoteDiagnosticsSchema = z.object({
  takenAt: short,
  appVersion: short,
  packaged: z.boolean(),
  electron: short,
  platform: short,
  processes: list(
    z.object({ type: short, name: line.optional(), cpuPercent: finite, memoryMb: finite }),
    1000
  ),
  eventLoopMs: z.object({ p50: finite, p99: finite, max: finite }).optional(),
  terminals: count,
  taskCount: count,
  notifyMs: list(finite, 10_000),
  slowGit: list(
    z.object({ command: line, folder: line, ms: finite, blocking: z.boolean(), at: short }),
    100
  ).optional()
})

export const reviewCommentSchema = z.object({
  id: z.string().min(1).max(REMOTE_LIMITS.short),
  path: remotePathSchema.pipe(z.string().min(1)),
  side: z.enum(['new', 'old']),
  line: z.number().int().min(1),
  text: line,
  body: z.string().max(REVIEW_LIMITS.body),
  createdAt: short
})

export const reviewCommentsSchema = z.array(reviewCommentSchema).max(REVIEW_LIMITS.comments)

/** A task's review file (`.styr/reviews/<TASK-id>.json`), and `review:get`'s answer. */
export const taskReviewSchema = z.object({
  taskId: short,
  pending: reviewCommentsSchema,
  lastSent: z
    .object({
      at: short,
      comments: reviewCommentsSchema,
      summary: z.string().max(REVIEW_LIMITS.body).optional()
    })
    .optional()
})

export const reviewPreparationSchema = z.object({
  route: z.enum(['queued', 'now', 'resume', 'fresh']),
  provider,
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('branch'), branch: line, base: line }),
    z.object({ kind: z.literal('repo'), repoName: line })
  ]),
  outdated: z.array(short).max(REVIEW_LIMITS.comments)
})

export const reviewSentSchema = z.object({
  route: z.enum(['queued', 'now', 'resume', 'fresh']),
  provider,
  count,
  files: count,
  movedToInProgress: z.boolean(),
  warning: message.optional(),
  session: remoteTerminalSessionSchema.optional()
})
