import { z } from 'zod'
import {
  REMOTE_LIMITS,
  remoteAgentCliReportSchema,
  remoteAgentStatusSchema,
  remoteAutoStateSchema,
  remoteBoardSummarySchema,
  remoteBoundsProblem,
  remoteCliStatusSchema,
  remoteContextUsageSchema,
  remoteConversationSchema,
  remoteDiagnosticsSchema,
  remoteDiffResultSchema,
  remoteOrchestrationSummarySchema,
  remotePatchResultSchema,
  remotePathSchema,
  remoteProviderUsageSchema,
  remoteRestTestSchema,
  remoteRuntimeStateSchema,
  remoteServerHelloSchema,
  remoteSessionIdSchema,
  remoteSourceSyncStateSchema,
  remoteSyncPreviewSchema,
  remoteTaskSchema,
  remoteTerminalDataSchema,
  remoteTerminalOutputSchema,
  remoteTerminalSessionSchema,
  remoteTraySchema,
  remoteNotifySchema,
  remoteWorklogSchema,
  remoteWorkspaceOverviewSchema,
  remoteWorkspacesActivitySchema,
  settingsSchema
} from '@core/taskSchema.js'
import { RemoteUnavailable } from './forwarding.js'
import type { Connection } from './registry.js'

/**
 * The client's side of the trust boundary (`docs/architecture/remote.md`, Trust boundary): every
 * answer and notification from a server is checked here, against the bounded schemas in
 * `core/taskSchema.ts`, before any part of the router, the main process or the renderer sees it.
 * A compromised host may send anything; what passes is the shape the app expects, within
 * `REMOTE_LIMITS`, with unknown keys dropped.
 *
 * - An answer that fails is a `RemoteInvalidResponse` for that call, never a throw elsewhere.
 * - A notification that fails is dropped, and logged once per channel per connection.
 * - A method with no schema is refused (an answer) or dropped (a notification): a new channel
 *   needs its line here, and `validation.test.ts` checks every routed channel has one.
 */

/** An answer from a server that did not pass its schema. Its message is shown as is. */
export class RemoteInvalidResponse extends RemoteUnavailable {}

/** Accepts any answer within bounds and hands the caller nothing: the result is unused. */
const ignored = z.unknown().transform(() => undefined)
const tasks = z.array(remoteTaskSchema).max(REMOTE_LIMITS.entries)
const task = remoteTaskSchema
const session = remoteTerminalSessionSchema
const overview = remoteWorkspaceOverviewSchema
const short = z.string().max(REMOTE_LIMITS.short)
const line = z.string().max(REMOTE_LIMITS.line)
const syncStates = z.record(short, remoteSourceSyncStateSchema)
const count = z.number().int().min(0)

/** The answer to each request the client sends a server. */
export const RESPONSE_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  'server:info': remoteServerHelloSchema,
  'server:tray': remoteTraySchema,
  'tasks:list': tasks,
  'tasks:get': task.nullable(),
  'tasks:problems': z
    .array(z.object({ filePath: remotePathSchema, reason: z.string().max(REMOTE_LIMITS.message) }))
    .max(REMOTE_LIMITS.entries),
  'tasks:create': task,
  'tasks:update': task,
  'tasks:note': task,
  'tasks:reorder': tasks,
  'tasks:archive': task,
  'tasks:delete': ignored,
  'tasks:forgetSession': task,
  'tasks:removeWorktree': task.nullable(),
  'tasks:checkMerged': ignored,
  'git:branches': z.object({
    branches: z.array(line).max(REMOTE_LIMITS.entries),
    current: line.optional()
  }),
  'git:diffStats': z.record(short, z.object({ added: count, removed: count, files: count })),
  'git:taskDiff': remoteDiffResultSchema,
  'git:filePatch': remotePatchResultSchema,
  'agents:list': z.array(remoteAgentStatusSchema).max(REMOTE_LIMITS.entries),
  'agents:remove': ignored,
  'agents:cliStatus': remoteAgentCliReportSchema,
  'worklog:load': remoteWorklogSchema,
  'diagnostics:snapshot': remoteDiagnosticsSchema,
  'diagnostics:stop': ignored,
  'app:mcpCommand': z.string().max(REMOTE_LIMITS.message),
  'orchestrate:plan': remoteOrchestrationSummarySchema,
  'orchestrate:run': z
    .array(z.object({ taskId: short, lane: short, session }))
    .max(REMOTE_LIMITS.sessions),
  'orchestrate:autoState': remoteAutoStateSchema,
  'orchestrate:autoSet': remoteAutoStateSchema,
  'terminal:list': z.array(session).max(REMOTE_LIMITS.sessions),
  'terminal:attach': remoteTerminalOutputSchema,
  'terminal:detach': ignored,
  'terminal:create': session,
  'terminal:launchAgent': session,
  'terminal:resumeSession': session,
  'terminal:askReview': session,
  'terminal:askFork': session.nullable(),
  'terminal:previewPrompt': z.string().max(REMOTE_LIMITS.taskBody),
  'terminal:createPr': ignored,
  'terminal:kill': ignored,
  'terminal:handOff': z.object({ taskId: short, path: remotePathSchema, agentAsked: z.boolean() }),
  'terminal:gitContext': z.object({
    root: remotePathSchema.nullable(),
    branch: line.nullable()
  }),
  'terminal:listDirectories': z.object({
    path: remotePathSchema,
    parent: remotePathSchema.nullable(),
    names: z.array(line).max(REMOTE_LIMITS.entries),
    files: z.array(line).max(REMOTE_LIMITS.entries).optional()
  }),
  // `undefined` crosses the wire as `null`; the renderer expects it back.
  'terminal:runtimeState': remoteRuntimeStateSchema
    .nullable()
    .transform((state) => state ?? undefined),
  'usage:claude': remoteProviderUsageSchema.nullable(),
  'usage:codex': z
    .object({
      usage: remoteProviderUsageSchema.nullable(),
      context: remoteContextUsageSchema.nullable()
    })
    .nullable(),
  'usage:context': remoteContextUsageSchema.nullable(),
  'agent:conversation': remoteConversationSchema.nullable(),
  'agent:prompt': z.boolean(),
  'agent:approval': ignored,
  'sources:providers': z.array(z.object({ provider: short, label: line })).max(1000),
  'sources:ghStatus': remoteCliStatusSchema,
  'sources:state': syncStates,
  'sources:restTest': remoteRestTestSchema,
  'sources:targets': z
    .array(z.object({ target: line, repoPath: remotePathSchema }))
    .max(REMOTE_LIMITS.entries),
  'sources:sync': remoteSourceSyncStateSchema,
  'sources:preview': remoteSyncPreviewSchema,
  'sources:apply': remoteSourceSyncStateSchema,
  'sources:link': task,
  'sources:unlink': task,
  'sources:refresh': task,
  'workspaces:list': overview,
  'workspaces:switch': overview,
  'workspaces:create': overview,
  'workspaces:activity': remoteWorkspacesActivitySchema,
  'workspaces:boardSummary': remoteBoardSummarySchema,
  'settings:get': settingsSchema,
  'settings:save': ignored,
  'settings:brokenFiles': z
    .array(z.object({ workspaceId: short, path: remotePathSchema }))
    .max(1000)
}

/** A notification that carries nothing the client uses: any payload is dropped. */
const NO_PAYLOAD = 'none'

/** The payload (the first param) of each notification the router handles. */
export const NOTIFICATION_SCHEMAS: Readonly<Record<string, z.ZodType | typeof NO_PAYLOAD>> = {
  'terminal:data': remoteTerminalDataSchema,
  'terminal:exit': z.object({ id: remoteSessionIdSchema, exitCode: z.number().int() }),
  'terminal:runtimeState': remoteRuntimeStateSchema,
  'server:tray': remoteTraySchema,
  'server:notify': remoteNotifySchema,
  'workspaces:activity': remoteWorkspacesActivitySchema,
  'workspaces:changed': NO_PAYLOAD,
  // The router reads only which workspace the server shows; the board's settings are refetched.
  'settings:changed': z.object({ activeWorkspaceId: short.min(1).optional() }),
  'tasks:changed': NO_PAYLOAD,
  'agents:changed': z.array(remoteAgentStatusSchema).max(REMOTE_LIMITS.entries),
  'orchestrate:autoState': remoteAutoStateSchema,
  'orchestrate:autoStarted': remoteTerminalSessionSchema,
  'sources:state': syncStates,
  'usage:claude': remoteProviderUsageSchema.nullable(),
  'usage:context': z.object({
    terminalId: remoteSessionIdSchema,
    context: remoteContextUsageSchema.nullable()
  }),
  'agent:conversation': z.object({
    terminalId: remoteSessionIdSchema,
    conversation: remoteConversationSchema
  })
}

/** Why `value` fails `schema` (bounds first), or undefined with the parsed value. */
function check(
  schema: z.ZodType,
  value: unknown
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const problem = remoteBoundsProblem(value)
  if (problem) return { ok: false, reason: problem }
  const parsed = schema.safeParse(value)
  if (parsed.success) return { ok: true, value: parsed.data }
  const issue = parsed.error.issues[0]
  const where = issue?.path.length ? ` at ${issue.path.join('.')}` : ''
  return { ok: false, reason: `${issue?.message ?? 'unexpected shape'}${where}` }
}

/** A server's answer to `method`, checked; throws `RemoteInvalidResponse` when it fails. */
export function parseResponse(host: string, method: string, value: unknown): unknown {
  const schema = RESPONSE_SCHEMAS[method]
  const result = schema
    ? check(schema, value)
    : { ok: false as const, reason: 'no schema for this call' }
  if (result.ok) return result.value
  throw new RemoteInvalidResponse(
    `${host} sent an answer to ${method} that Styr cannot use (${result.reason.slice(0, 200)}). Nothing was shown or changed.`
  )
}

/**
 * Checks a server's notifications for one connection: a failing one is dropped and logged once
 * per channel until `reset` (each new connection).
 */
export class NotificationGuard {
  private readonly logged = new Set<string>()

  constructor(
    private readonly host: string,
    private readonly log: (message: string) => void = (message) => console.warn(message)
  ) {}

  /** The params to hand on, or undefined to drop the notification. */
  check(method: string, params: unknown[]): unknown[] | undefined {
    const schema = NOTIFICATION_SCHEMAS[method]
    if (!schema) return undefined
    if (schema === NO_PAYLOAD) return []
    const result = check(schema, params[0])
    if (result.ok) return [result.value]
    if (!this.logged.has(method)) {
      this.logged.add(method)
      this.log(
        `Styr: dropped ${method} from ${this.host}: ${result.reason.slice(0, 200)}. Further ones are dropped silently until it reconnects.`
      )
    }
    return undefined
  }

  reset(): void {
    this.logged.clear()
  }
}

/** `conn` with every answer checked against its schema before the caller sees it. */
export function validatingConnection(host: string, conn: Connection): Connection {
  return {
    state: () => conn.state(),
    get connected() {
      return conn.connected
    },
    get server() {
      return conn.server
    },
    start: () => conn.start(),
    stop: () => conn.stop(),
    retryNow: () => conn.retryNow(),
    wake: (fresh) => conn.wake(fresh),
    suspend: (reason) => conn.suspend(reason),
    notify: (method, params) => conn.notify(method, params),
    request: async (method, params) =>
      parseResponse(host, method, await conn.request(method, params))
  }
}
