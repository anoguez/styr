import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawn, type IPty } from 'node-pty'
import { nanoid } from 'nanoid'
import { withoutSessionMarkers } from '@core/providers/index.js'
import type { TerminalSessionInfo } from '@core/types.js'

export interface SpawnOptions {
  cwd?: string
  shell?: string
  title?: string
  taskId?: string
  workspaceId?: string
  provider?: 'claude' | 'codex'
  replay?: boolean
  command?: string
  env?: Record<string, string>
}

interface Session {
  info: TerminalSessionInfo
  pty: IPty
  backlog: string
  sequence: number
}

type DataListener = (id: string, data: string, sequence: number) => void
type ExitListener = (id: string, exitCode: number) => void

const BACKLOG_LIMIT = 200_000
const sessions = new Map<string, Session>()
const exitedTaskIds = new Map<string, { taskId: string; workspaceId?: string }>()
const dataListeners = new Set<DataListener>()
const exitListeners = new Set<ExitListener>()

function resolveCwd(cwd?: string): string {
  return cwd && existsSync(cwd) ? cwd : homedir()
}

/**
 * The app's environment for a new terminal, minus agent session markers it may have inherited (see
 * `withoutSessionMarkers`), plus `extra`, which is applied last so it is never stripped.
 */
function sanitisedEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  // xterm.js renders 24-bit colour, but programs only use it when COLORTERM says so. Without it,
  // TUIs such as Codex quantise their colours to the 256-colour palette, which turns a background
  // blended from the theme into flat grey.
  return { ...withoutSessionMarkers(env), ...extra, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
}

export function onTerminalData(listener: DataListener): void {
  dataListeners.add(listener)
}

export function onTerminalExit(listener: ExitListener): void {
  exitListeners.add(listener)
}

export function createSession(options: SpawnOptions): TerminalSessionInfo {
  const id = nanoid(10)
  const cwd = resolveCwd(options.cwd)
  const shell = options.shell || process.env.SHELL || '/bin/zsh'
  const child = spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd,
    env: sanitisedEnv(options.env)
  })

  const info: TerminalSessionInfo = {
    id,
    title: options.title ?? 'Terminal',
    cwd,
    ...(options.taskId ? { taskId: options.taskId } : {}),
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.replay ? { replay: true } : {})
  }
  const session: Session = { info, pty: child, backlog: '', sequence: 0 }
  sessions.set(id, session)

  child.onData((data) => {
    session.backlog = (session.backlog + data).slice(-BACKLOG_LIMIT)
    session.sequence += 1
    for (const listener of dataListeners) listener(id, data, session.sequence)
  })
  child.onExit(({ exitCode }) => {
    if (info.taskId) exitedTaskIds.set(id, { taskId: info.taskId, workspaceId: info.workspaceId })
    sessions.delete(id)
    for (const listener of exitListeners) listener(id, exitCode)
  })

  if (options.command) child.write(`${options.command}\r`)
  return info
}

export function writeToSession(id: string, data: string): void {
  sessions.get(id)?.pty.write(data)
}

export function resizeSession(id: string, cols: number, rows: number): void {
  sessions.get(id)?.pty.resize(Math.max(cols, 1), Math.max(rows, 1))
}

export function killSession(id: string): void {
  const session = sessions.get(id)
  if (!session) return
  session.pty.kill()
  sessions.delete(id)
}

export function sessionBacklog(id: string): { data: string; sequence: number } {
  const session = sessions.get(id)
  return { data: session?.backlog ?? '', sequence: session?.sequence ?? 0 }
}

/** The task a session belongs to, with its workspace — ids repeat across workspaces. */
export function sessionTask(id: string): { taskId: string; workspaceId?: string } | undefined {
  const info = sessions.get(id)?.info
  return info?.taskId
    ? { taskId: info.taskId, workspaceId: info.workspaceId }
    : exitedTaskIds.get(id)
}

export function findSessionByTask(
  taskId: string,
  workspaceId?: string
): TerminalSessionInfo | undefined {
  return [...sessions.values()].find(
    (session) => session.info.taskId === taskId && session.info.workspaceId === workspaceId
  )?.info
}

export function listSessions(): TerminalSessionInfo[] {
  return [...sessions.values()].map((session) => session.info)
}

export function killAllSessions(): void {
  for (const id of [...sessions.keys()]) killSession(id)
}
