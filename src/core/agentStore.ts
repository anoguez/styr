import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import {
  EVENT_STATE,
  type AgentState,
  type AgentStatus,
  type SubagentStatus
} from './agentState.js'
import { workspaceDir } from './config.js'
import type { Settings } from './types.js'

interface HookRecord {
  taskId?: string
  event?: string
  at?: string
  payload?: {
    session_id?: string
    last_assistant_message?: string
    notification_type?: string
    message?: string
    prompt?: string
    agent_id?: string
    agent_type?: string
    transcript_path?: string
    agent_transcript_path?: string
    /** Set by providers that know a subagent's name up front (Codex). */
    label?: string
  } | null
}

/**
 * Claude Code sends a `Notification` a minute after a turn ends just to say it is still at the
 * prompt. That is the `Stop` it followed, not a request for you, so it reads as idle — otherwise the
 * same finished turn showed Idle or Waiting on you depending on when you looked. Hooks now match
 * only the notifications that need you (`buildHookSettings`); this covers sessions launched before.
 */
function stateOf(record: HookRecord): AgentState | undefined {
  if (!record.event) return undefined
  const payload = record.payload
  const idlePrompt =
    payload?.notification_type === 'idle_prompt' ||
    (!payload?.notification_type && payload?.message === 'Claude is waiting for your input')
  if (record.event === 'Notification' && idlePrompt) return 'idle'
  return EVENT_STATE[record.event]
}

/** A folder of the app's own state inside the workspace, created on first use. */
export function supportDir(settings: Settings, name: string): string {
  const dir = join(workspaceDir(settings), '.styr', name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Where agent status records land. Providers write here in one shape — `{taskId, event, at,
 * payload}` — and `event` uses the names in `EVENT_STATE`, so reading state never depends on which
 * CLI produced it.
 */
export function agentsDir(settings: Settings): string {
  return supportDir(settings, 'agents')
}

export function statusFilePath(settings: Settings, taskId: string): string {
  return join(agentsDir(settings), `${taskId}.json`)
}

/**
 * One folder per task beside its status file. Every subagent event is its own uniquely named file,
 * so parallel subagents finishing at once never overwrite each other, and the parent's status file
 * keeps meaning "what the agent itself last did".
 */
export function subagentsDir(settings: Settings, taskId: string): string {
  return join(agentsDir(settings), `${taskId}.subagents`)
}

let sequence = 0

/** Records a subagent event the app observed itself (Codex), in the shape a hook writes. */
export function recordSubagentEvent(
  settings: Settings,
  taskId: string,
  event: string,
  payload: HookRecord['payload']
): void {
  const dir = subagentsDir(settings, taskId)
  mkdirSync(dir, { recursive: true })
  const name = `${Date.now()}-${process.pid}-${(sequence += 1)}-${event}.json`
  const record = { taskId, event, at: new Date().toISOString(), payload }
  const temp = join(dir, `.${name}.tmp`)
  writeFileSync(temp, `${JSON.stringify(record)}\n`, 'utf8')
  renameSync(temp, join(dir, name))
}

export function clearSubagents(settings: Settings, taskId: string): void {
  rmSync(subagentsDir(settings, taskId), { recursive: true, force: true })
}

interface SubagentEvent {
  file: string
  /** Write order. The hook's `at` has second precision, so ties are common; mtime is not. */
  order: number
  record: HookRecord
}

/**
 * A background subagent finishing wakes the parent with a `<task-notification>` prompt. That is not
 * you starting a turn, so it must not clear the row that just turned done.
 */
function startsTurn(record: HookRecord): boolean {
  return (
    record.event === 'UserPromptSubmit' &&
    !record.payload?.prompt?.trimStart().startsWith('<task-notification>')
  )
}

/** What Claude Code records about a subagent beside its transcript: the Agent tool's call. */
interface SubagentMeta {
  description?: string
  /** A foreground subagent cannot outlive the turn that spawned it; a background one can. */
  background?: boolean
}

const metas = new Map<string, SubagentMeta>()

function metaPath(payload: NonNullable<HookRecord['payload']>): string | undefined {
  if (payload.agent_transcript_path)
    return payload.agent_transcript_path.replace(/\.jsonl$/, '.meta.json')
  if (payload.transcript_path && payload.agent_id)
    return join(
      payload.transcript_path.replace(/\.jsonl$/, ''),
      'subagents',
      `agent-${payload.agent_id}.meta.json`
    )
  return undefined
}

/**
 * Best effort: the meta file is undocumented, so any failure reads as "nothing known" and the label
 * falls back to the subagent type. A miss is not cached — the file may not exist yet at the start.
 */
function metaOf(payload: NonNullable<HookRecord['payload']>): SubagentMeta {
  const file = metaPath(payload)
  if (!file) return {}
  const cached = metas.get(file)
  if (cached) return cached
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const meta: SubagentMeta = {
      description:
        typeof raw.description === 'string' && raw.description.trim()
          ? raw.description.trim()
          : undefined,
      background: raw.requestShape === 'background' ? true : raw.requestShape ? false : undefined
    }
    metas.set(file, meta)
    return meta
  } catch {
    return {}
  }
}

function readSubagentEvents(dir: string): SubagentEvent[] {
  const events: SubagentEvent[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue
    const file = join(dir, name)
    try {
      const record = JSON.parse(readFileSync(file, 'utf8')) as HookRecord
      if (!record.event) continue
      events.push({ file, order: statSync(file).mtimeMs, record })
    } catch {
      continue
    }
  }
  return events.sort((a, b) => a.order - b.order || a.file.localeCompare(b.file))
}

/**
 * The task's subagents, folded from its event files. A row runs from its start to its stop; a done
 * row stays until you start the parent's next turn, and its files (with the turn markers before the
 * last one) are deleted then, so the folder only ever holds the current turn's story.
 */
export function readSubagents(settings: Settings, taskId: string): SubagentStatus[] {
  const dir = subagentsDir(settings, taskId)
  if (!existsSync(dir)) return []
  const events = readSubagentEvents(dir)
  const lastTurn = events.findLastIndex((event) => startsTurn(event.record))
  const byId = new Map<
    string,
    {
      status: SubagentStatus
      files: string[]
      startedAt: number
      stoppedAt?: number
      background?: boolean
    }
  >()
  const stale: string[] = events
    .slice(0, Math.max(lastTurn, 0))
    .filter((event) => event.record.event === 'UserPromptSubmit')
    .map((event) => event.file)

  events.forEach((event, index) => {
    const { record } = event
    const payload = record.payload
    const id = payload?.agent_id
    if (!payload || !id || (record.event !== 'SubagentStart' && record.event !== 'SubagentStop'))
      return
    const at = record.at ?? new Date(event.order).toISOString()
    const entry = byId.get(id) ?? {
      status: { id, label: '', state: 'running', startedAt: at },
      files: [],
      startedAt: index
    }
    const meta = metaOf(payload)
    entry.files.push(event.file)
    entry.background = meta.background ?? entry.background
    entry.status.label =
      payload.label || meta.description || entry.status.label || payload.agent_type || ''
    if (record.event === 'SubagentStart') {
      entry.status = { ...entry.status, state: 'running', endedAt: undefined }
      entry.startedAt = index
    } else {
      entry.status = {
        ...entry.status,
        state: 'done',
        endedAt: at,
        lastMessage: payload.last_assistant_message ?? entry.status.lastMessage
      }
      entry.stoppedAt = index
    }
    byId.set(id, entry)
  })

  const subagents: SubagentStatus[] = []
  for (const entry of byId.values()) {
    const running = entry.status.state === 'running'
    // Interrupting a turn (Esc) may never send its foreground subagents' stops; they died with it.
    const ended = running
      ? entry.background === false
        ? entry.startedAt
        : undefined
      : entry.stoppedAt
    if (ended !== undefined && ended < lastTurn) {
      stale.push(...entry.files)
      continue
    }
    subagents.push({ ...entry.status, label: entry.status.label || 'Subagent' })
  }
  for (const file of stale) rmSync(file, { force: true })
  return subagents
}

export function readAgentStatus(
  settings: Settings,
  taskId: string,
  { subagents = true }: { subagents?: boolean } = {}
): AgentStatus | null {
  const file = statusFilePath(settings, taskId)
  if (!existsSync(file)) return null
  try {
    const record = JSON.parse(readFileSync(file, 'utf8')) as HookRecord
    const state = stateOf(record)
    if (!state || !record.taskId) return null
    const status: AgentStatus = {
      taskId: record.taskId,
      state,
      at: record.at ?? new Date().toISOString(),
      sessionId: record.payload?.session_id,
      lastMessage: record.payload?.last_assistant_message
    }
    const helpers = subagents ? readSubagents(settings, taskId) : []
    return helpers.length > 0 ? { ...status, subagents: helpers } : status
  } catch {
    return null
  }
}

/** `subagents: false` skips the fold, for readers that never show them (other workspaces' tray). */
export function readAllAgentStatuses(
  settings: Settings,
  options: { subagents?: boolean } = {}
): AgentStatus[] {
  const dir = agentsDir(settings)
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .map((name) => readAgentStatus(settings, name.replace(/\.json$/, ''), options))
    .filter((status): status is AgentStatus => status !== null)
}

/**
 * Records an event the app observed itself rather than one a hook reported. Written to the same
 * file so agent state survives a restart — an in-memory note would leave a dead session showing
 * whatever it was doing when the app last closed.
 */
export function recordAgentEvent(settings: Settings, taskId: string, event: string): void {
  const record = { taskId, event, at: new Date().toISOString(), payload: null }
  writeFileSync(statusFilePath(settings, taskId), `${JSON.stringify(record)}\n`, 'utf8')
  // A dead terminal took its subagents with it; leaving them would show them running forever.
  if (event === 'TerminalExit') clearSubagents(settings, taskId)
}

/** Also drops the subagents: they belong to the session this status described. */
export function clearAgentStatus(settings: Settings, taskId: string): void {
  rmSync(statusFilePath(settings, taskId), { force: true })
  clearSubagents(settings, taskId)
}
