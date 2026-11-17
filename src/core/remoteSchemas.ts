import { z } from 'zod'
import type { AgentConversation, ApprovalOption } from './agentConversation.js'
import { AGENT_STATES, type AgentStatus, type SubagentStatus } from './agentState.js'
import type { DiagnosticsSnapshot } from './diagnostics.js'
import type { DiffFile, DiffResult, PatchResult } from './diff.js'
import type {
  CliStatus,
  RemoteItem,
  RestTestResult,
  SourceSyncState,
  SyncPreview
} from './sources/types.js'
import { taskFrontmatterSchema, taskSessionRefSchema } from './taskSchema.js'
import {
  MAX_EXTRA_REPOS,
  REVIEW_LIMITS,
  type AgentCliReport,
  type AutoDispatchState,
  type McpSetupReport,
  type OrchestrationSummary,
  type ReviewComment,
  type ReviewPreparation,
  type ReviewSent,
  type Task,
  type TaskReview,
  type TerminalCommand,
  type TerminalMark,
  type TerminalOutput,
  type TerminalRuntimeState,
  type TerminalSessionInfo,
  type WorklogData,
  type WorkspaceOverview,
  type WorkspacesActivity
} from './types.js'
import type { ContextUsage, ProviderUsage, UsageWindow } from './usage.js'

// What a remote server sends back.
//
// `styr serve` checks what clients send it with the schemas in `taskSchema.ts`. The client checks
// what a server sends back with these (`src/host/remote/validation.ts`), since a compromised host must
// not be able to confuse the main process, crash the renderer or exhaust the laptop's memory
// (`docs/architecture/remote.md`, Trust boundary). They are bounded copies of the shapes in
// `types/`, kept apart from the schemas the local task files are read with, which stay unbounded.
//
// Each is tied to its type by `SchemaChecks` at the end of this file: a field added to the type
// but not here would be dropped from every server's answer (unknown keys are), so the build fails
// until the schema follows.

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
  extraRepos: list(
    z.object({
      repoPath: remotePathSchema,
      baseBranch: line.optional(),
      worktreePath: remotePathSchema.optional(),
      prUrl: line.optional()
    }),
    MAX_EXTRA_REPOS
  ).default([]),
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
  platform: short,
  /** Absent from a host that predates it. */
  name: short.optional()
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

export const remoteMcpSetupReportSchema = z.object({
  provider,
  state: z.enum(['registered', 'stale', 'missing', 'unknown']),
  registeredEntry: line.optional(),
  expectedEntry: line,
  installCommand: message,
  removeCommand: message.optional(),
  problem: message
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

// ── Each schema against its type ─────────────────────────────────────────────────────────────

/** True only when `A` and `B` are the same type: every field, optional or not, on both sides. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
/** One level of `Omit` or `&` flattened, so `Equals` compares fields rather than how they were written. */
type Flat<T> = { [K in keyof T]: T[K] }
export type Same<Schema extends z.ZodType, Type> = Equals<Flat<z.output<Schema>>, Flat<Type>>
/** `WorkspaceOverview`'s row, flattened so it compares with the schema's. */
type WorkspaceRow = Flat<Omit<WorkspaceOverview['workspaces'][number], 'remote'>>
export type Assert<Check extends true> = Check

/**
 * Fails the build when a schema and its type part. Where the wire shape differs on purpose, the
 * type is narrowed with an `Omit` that says why. Not checked: `remoteBoardSummarySchema` and
 * `remoteNotifySchema` (open records and a notification, with no type of their own),
 * `remoteTraySchema` (the server's `tray()` is `unknown`; its statuses are checked below),
 * `remoteServerHelloSchema` (checked against `ServerHello` in `host/remote/connection.ts`).
 */
export type SchemaChecks = [
  Assert<Same<typeof remoteTaskSchema, Task>>,
  Assert<Same<typeof subagentStatusSchema, SubagentStatus>>,
  Assert<Same<typeof remoteAgentStatusSchema, AgentStatus>>,
  Assert<Same<typeof remoteTerminalMarkSchema, TerminalMark>>,
  Assert<Same<typeof remoteTerminalOutputSchema, TerminalOutput>>,
  Assert<Same<typeof remoteTerminalDataSchema, TerminalOutput & { id: string }>>,
  // `host` is the client's own: it stamps the server it reached on each session.
  Assert<Same<typeof remoteTerminalSessionSchema, Omit<TerminalSessionInfo, 'host'>>>,
  Assert<Same<typeof terminalCommandSchema, TerminalCommand>>,
  Assert<Same<typeof remoteRuntimeStateSchema, TerminalRuntimeState>>,
  // A server lists its own workspaces; a `remote` link of its own is never followed from here.
  Assert<
    Same<
      typeof remoteWorkspaceOverviewSchema,
      Omit<WorkspaceOverview, 'workspaces'> & {
        workspaces: WorkspaceRow[]
      }
    >
  >,
  Assert<Same<typeof remoteWorkspacesActivitySchema, WorkspacesActivity>>,
  Assert<Same<typeof remoteAutoStateSchema, AutoDispatchState>>,
  Assert<Same<typeof remoteSourceSyncStateSchema, SourceSyncState>>,
  Assert<Same<typeof diffFileSchema, DiffFile>>,
  Assert<Same<typeof remoteDiffResultSchema, DiffResult>>,
  Assert<Same<typeof remotePatchResultSchema, PatchResult>>,
  Assert<Same<typeof remoteOrchestrationSummarySchema, OrchestrationSummary>>,
  Assert<Same<typeof usageWindowSchema, UsageWindow>>,
  Assert<Same<typeof remoteProviderUsageSchema, ProviderUsage>>,
  Assert<Same<typeof remoteContextUsageSchema, ContextUsage>>,
  Assert<Same<typeof approvalOptionSchema, ApprovalOption>>,
  Assert<Same<typeof remoteConversationSchema, AgentConversation>>,
  Assert<Same<typeof remoteWorklogSchema, WorklogData>>,
  Assert<Same<typeof remoteCliStatusSchema, CliStatus>>,
  Assert<Same<typeof remoteAgentCliReportSchema, AgentCliReport>>,
  Assert<Same<typeof remoteMcpSetupReportSchema, McpSetupReport>>,
  Assert<Same<typeof remoteItemSchema, RemoteItem>>,
  Assert<Same<typeof remoteRestTestSchema, RestTestResult>>,
  Assert<Same<typeof remoteSyncPreviewSchema, SyncPreview>>,
  // The terminal engine is the client's own: it renders a remote session's output itself.
  Assert<Same<typeof remoteDiagnosticsSchema, Omit<DiagnosticsSnapshot, 'terminalEngine'>>>,
  Assert<Same<typeof reviewCommentSchema, ReviewComment>>,
  Assert<Same<typeof taskReviewSchema, TaskReview>>,
  Assert<Same<typeof reviewPreparationSchema, ReviewPreparation>>,
  // `session` is a remote session, without the `host` its client stamps on it (see above).
  Assert<
    Same<
      typeof reviewSentSchema,
      Omit<ReviewSent, 'session'> & { session?: Flat<Omit<TerminalSessionInfo, 'host'>> }
    >
  >
]
