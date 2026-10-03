import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EVENT_STATE, type AgentStatus } from './agentState.js'
import { workspaceDir } from './config.js'
import type { Settings } from './types.js'

interface HookRecord {
  taskId?: string
  event?: string
  at?: string
  payload?: { session_id?: string; last_assistant_message?: string } | null
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

export function readAgentStatus(settings: Settings, taskId: string): AgentStatus | null {
  const file = statusFilePath(settings, taskId)
  if (!existsSync(file)) return null
  try {
    const record = JSON.parse(readFileSync(file, 'utf8')) as HookRecord
    const state = record.event ? EVENT_STATE[record.event] : undefined
    if (!state || !record.taskId) return null
    return {
      taskId: record.taskId,
      state,
      at: record.at ?? new Date().toISOString(),
      sessionId: record.payload?.session_id,
      lastMessage: record.payload?.last_assistant_message
    }
  } catch {
    return null
  }
}

export function readAllAgentStatuses(settings: Settings): AgentStatus[] {
  const dir = agentsDir(settings)
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .map((name) => readAgentStatus(settings, name.replace(/\.json$/, '')))
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
}

export function clearAgentStatus(settings: Settings, taskId: string): void {
  rmSync(statusFilePath(settings, taskId), { force: true })
}
